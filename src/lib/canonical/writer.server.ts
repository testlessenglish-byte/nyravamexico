// Canonical writer — projects engine outputs into the 17-section CaseAnalysis
// shape and upserts into canonical_analysis. Never fabricates data: only
// projects rows that actually exist in the engine tables.
//
// SERVER ONLY. Uses the caller-provided supabase client (which is either the
// user-scoped RLS client or the admin client, depending on caller).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  emptyCaseAnalysis,
  type CaseAnalysis,
  type Citation,
  type Finding,
  type TimelineEvent,
  type Witness,
} from "./case-analysis";
import { filterExecutiveDashboardEligible } from "@/lib/intelligence/judicial-hierarchy";

type Db = SupabaseClient<Database>;

const PIPELINE_VERSION = "canonical-1.0.0";

function safeArr<T>(x: T[] | null | undefined): T[] {
  return Array.isArray(x) ? x : [];
}

/**
 * Coerce a DB value that *should* be text but may be jsonb (object, array,
 * number) into a plain string, so downstream string ops never crash.
 */
function coerceText(x: unknown): string | null {
  if (x == null) return null;
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  if (Array.isArray(x)) {
    const parts = x.map((v) => coerceText(v)).filter((v): v is string => !!v && v.length > 0);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  if (typeof x === "object") {
    const o = x as Record<string, unknown>;
    for (const k of ["text", "summary", "rationale", "value", "description"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    try {
      return JSON.stringify(x);
    } catch {
      return null;
    }
  }
  return null;
}

function citationsFromRow(row: {
  source_document_id?: string | null;
  source_page?: number | null;
  source_quote?: string | null;
  source_doc_ids?: string[] | null;
  evidence_refs?: unknown;
  citations?: unknown;
}): Citation[] {
  const out: Citation[] = [];
  if (row.source_document_id) {
    out.push({ documentId: row.source_document_id, page: row.source_page ?? null, quote: row.source_quote ?? null });
  }
  for (const id of safeArr(row.source_doc_ids)) {
    if (id && !out.some((c) => c.documentId === id)) out.push({ documentId: id });
  }
  if (Array.isArray(row.evidence_refs)) {
    for (const r of row.evidence_refs as unknown[]) {
      if (r && typeof r === "object") {
        const rr = r as Record<string, unknown>;
        out.push({
          documentId: ((rr.documentId ?? rr.document_id) as string | undefined) ?? null,
          page: (rr.page as number | undefined) ?? null,
          quote: (rr.quote as string | undefined) ?? null,
          label: (rr.label as string | undefined) ?? null,
        });
      }
    }
  }
  if (Array.isArray(row.citations)) {
    for (const r of row.citations as unknown[]) {
      if (r && typeof r === "object") {
        const rr = r as Record<string, unknown>;
        out.push({
          documentId: ((rr.documentId ?? rr.document_id) as string | undefined) ?? null,
          page: (rr.page as number | undefined) ?? null,
          quote: (rr.quote as string | undefined) ?? null,
          label: (rr.label as string | undefined) ?? null,
        });
      }
    }
  }
  return out;
}

function normalizeSeverity(v: unknown): Finding["severity"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "critical" || s === "high" || s === "medium" || s === "low") return s;
  return "info";
}

export async function projectCanonical(
  db: Db,
  caseId: string,
  reportMode: "FULL" | "LIMITED" = "FULL",
): Promise<CaseAnalysis> {
  // Case metadata
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: caseRow } = await (db as any)
    .from("cases")
    .select("id,name,case_type,practice_area")
    .eq("id", caseId)
    .maybeSingle();

  const analysis = emptyCaseAnalysis({
    caseId,
    caseName: caseRow?.name ?? null,
    generatedAt: new Date().toISOString(),
    pipelineVersion: PIPELINE_VERSION,
    reportMode,
  });
  // VERIFIED CASE IDENTITY — this is the write path that bakes case_type
  // into the stored report artifact (ExecutiveSummary.case_type), read back
  // by export.ts/prerender-validate.server.ts/etc. downstream. If identity
  // is unusable, write null + case_type_unverified: true rather than a
  // guessed value — the whole point of this fix is that a stale/wrong
  // materia must never propagate silently into the final report.
  const { resolveCaseIdentity } = await import("../intelligence/case-classification.server");
  const { isUsableForLegalReasoning } = await import("../intelligence/case-identity");
  const writerIdentity = await resolveCaseIdentity(db, caseId);
  if (isUsableForLegalReasoning(writerIdentity)) {
    analysis.ExecutiveSummary.case_type = writerIdentity.caseType;
  } else {
    analysis.ExecutiveSummary.case_type = null;
    analysis.ExecutiveSummary.case_type_unverified = true;
  }

  // Findings
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: findings } = await (db as any)
    .from("case_findings")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });
  for (const f of safeArr(findings) as Record<string, unknown>[]) {
    const findingType = (f.finding_type as string | null) ?? null;
    const findingStatus = (f.finding_status as Finding["finding_status"]) ?? undefined;
    // PR A item 4 (report-truthfulness audit): an AI_THEORY finding has, by
    // construction, no verified evidence_refs/quote grounding it (see
    // evidence-gate.server.ts's exemptCitation path and the
    // procedural-compliance.server.ts fix that routes missing-checklist
    // items through it). It must not render like a verified finding or
    // silently feed scoring/recommendations. It only ever exists in
    // case_findings at all when the case was run in "exploratory" mode
    // (strict/balanced drop it at the evidence gate before persisting), so
    // its presence here already reflects the mode the case was actually run
    // in. Per the documented safe default's second option ("place it in a
    // clearly separate section"), it is included — visibly labeled — rather
    // than dropped; the `critical`/Risks/Recommendations filter below
    // explicitly excludes finding_type === "AI_THEORY" so it can never be
    // surfaced as a verified risk or recommendation.
    const isAiTheory = findingType === "AI_THEORY";
    const finding: Finding = {
      id: String(f.id),
      title: isAiTheory ? `[IA — teoría no verificada] ${String(f.title ?? "")}` : String(f.title ?? ""),
      description: String(f.description ?? ""),
      category: String(f.category ?? "general"),
      severity: normalizeSeverity(f.severity),
      confidence: typeof f.confidence === "number" ? f.confidence : Number(f.confidence ?? 0.5),
      legal_significance: (f.legal_significance as string | null) ?? null,
      potential_impact: (f.potential_impact as string | null) ?? null,
      affected_party: (f.affected_party as string | null) ?? null,
      citations: citationsFromRow(f as never),
      verification_status: (f.verification_status as string | null) ?? null,
      source_module: (f.source_module as string | null) ?? null,
      supporting_engines: Array.isArray(f.supporting_engines) ? (f.supporting_engines as string[]).map(String) : [],
      suppressed: false,
      quarantined: /reject|quarantin/i.test(String(f.verification_status ?? "")),
      finding_status: findingStatus,
      finding_type: findingType ?? undefined,
      speaker_role: (f.speaker_role as Finding["speaker_role"]) ?? null,
      proposition_type: (f.proposition_type as Finding["proposition_type"]) ?? null,
      adoption_status: (f.adoption_status as Finding["adoption_status"]) ?? null,
    };
    analysis.Findings.push(finding);
    const src = String(f.source_module ?? "");
    // Evidence section is evidence-grounded by definition — an unverified AI
    // theory never belongs there regardless of category/source_module.
    if (!isAiTheory && (/evidence|classification/i.test(src) || finding.category === "evidence")) {
      analysis.Evidence.push(finding);
    }
  }

  // Timeline
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: timeline } = await (db as any)
    .from("case_timeline_events")
    .select("*")
    .eq("case_id", caseId)
    .is("superseded_by", null)
    .order("event_date", { ascending: true });
  for (const t of safeArr(timeline) as Record<string, unknown>[]) {
    const ev: TimelineEvent = {
      id: String(t.id),
      date: (t.event_date as string | null) ?? null,
      description: String(t.description ?? ""),
      citations: citationsFromRow(t as never),
    };
    analysis.Timeline.push(ev);
  }

  // Witnesses
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: witnesses } = await (db as any).from("case_witnesses").select("*").eq("case_id", caseId);
  for (const w of safeArr(witnesses) as Record<string, unknown>[]) {
    const witness: Witness = {
      id: String(w.id),
      name: String(w.name ?? ""),
      role: (w.role as string | null) ?? null,
      reliability: typeof w.reliability === "number" ? w.reliability : null,
      bias: (w.bias as string | null) ?? null,
      credibility_risk: (w.credibility_risk as string | null) ?? null,
      citations: citationsFromRow(w as never),
    };
    analysis.Witnesses.push(witness);
    const cross = safeArr(w.cross_exam_questions as string[] | null);
    if (cross.length) {
      analysis.CrossExam.push({ witnessName: witness.name, questions: cross, citations: witness.citations });
    }
    const impeach = safeArr(w.impeachment_questions as string[] | null);
    if (impeach.length) {
      analysis.Impeachment.push({
        witnessName: witness.name,
        basis: impeach.join(" | "),
        citations: witness.citations,
      });
    }
  }

  // Scores
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: scoresRow } = await (db as any)
    .from("case_scores")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (scoresRow) {
    analysis.Scores = {
      case_strength: (scoresRow.case_quality as number | null) ?? null,
      evidence_strength: (scoresRow.evidence_strength as number | null) ?? null,
      witness_reliability: (scoresRow.witness_reliability as number | null) ?? null,
      timeline_integrity: (scoresRow.timeline_integrity as number | null) ?? null,
      overall_confidence: (scoresRow.overall_confidence as number | null) ?? null,
      rationale: coerceText(scoresRow.rationale),
      suppressed: false,
    };
  }

  // Strategy
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: strategyRow } = await (db as any)
    .from("case_strategy")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: theories } = await (db as any)
    .from("case_theories")
    .select("id,label,theory_name,rationale")
    .eq("case_id", caseId);
  analysis.Strategy = {
    theme: (strategyRow?.theme as string | null) ?? null,
    theories: safeArr(theories as Record<string, unknown>[]).map((t) => ({
      id: String(t.id),
      label: String(t.label ?? t.theory_name ?? "Untitled theory"),
      rationale: (t.rationale as string | null) ?? null,
    })),
    key_moves: safeArr(strategyRow?.key_moves as string[] | undefined),
  };

  // Discovery gaps with corpus gap protection. Excludes AI_THEORY — an
  // unverified theory must never be presented as a confirmed procedural gap.
  for (const f of analysis.Findings) {
    if (f.finding_type === "AI_THEORY") continue;
    if (/discovery/i.test(f.category) || /discovery/i.test(f.description)) {
      const isCorpusGap = /not identified in the corpus|no se identific[oó]|elemento no identificado/i.test(
        f.description,
      );
      analysis.Discovery.push({
        id: f.id,
        topic: f.title,
        what_is_missing: f.description,
        why_it_matters: isCorpusGap
          ? "Not located in the analyzed upload corpus. Verify against the official physical file before assuming an official procedural defect."
          : (f.legal_significance ?? f.potential_impact ?? "Impacts case completeness."),
        citations: f.citations,
      });
    }
  }

  // Contradictions & Executive Summary
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: reportRow } = await (db as any)
    .from("reports")
    .select(
      "contradictions_struct,executive_summary,full_report,missing_evidence_report,scores_suppressed,motions_suppressed,quality_blocked,report_mode",
    )
    .eq("case_id", caseId)
    .maybeSingle();
  if (reportRow?.contradictions_struct && Array.isArray(reportRow.contradictions_struct)) {
    for (const c of reportRow.contradictions_struct as Record<string, unknown>[]) {
      analysis.Contradictions.push({
        id: String(c.id ?? crypto.randomUUID()),
        claim: String(c.claim ?? c.a ?? ""),
        counter: String(c.counter ?? c.b ?? ""),
        severity: normalizeSeverity(c.severity) as "critical" | "high" | "medium" | "low",
        citations: citationsFromRow(c as never),
      });
    }
  }
  if (reportRow?.executive_summary) {
    analysis.ExecutiveSummary.headline = String(reportRow.executive_summary).split("\n")[0].slice(0, 200);
    analysis.ExecutiveSummary.narrative = String(reportRow.executive_summary);
  }
  if (reportRow?.scores_suppressed) analysis.Scores.suppressed = true;

  // AI_THEORY is excluded here too — Risks/Recommendations/top_findings must
  // only ever be built from grounded findings, never an unverified theory.
  // Eligibility is computed over the FULL findings set (not the severity-
  // filtered slice below) so the "highest instance present" determination
  // isn't skewed by a lower-severity adopted holding sitting outside the
  // critical/high cut. filterExecutiveDashboardEligible additionally keeps
  // out any rejected/superseded lower-instance holding or unresolved party
  // argument once the extraction pass has attributed judicial-hierarchy
  // roles on this case (a no-op for findings that were never attributed) —
  // see judicial-hierarchy.ts and ADR 5829/2025 for the bug this closes.
  const dashboardEligibleIds = new Set(filterExecutiveDashboardEligible(analysis.Findings).map((f) => f.id));
  const critical = analysis.Findings.filter(
    (f) =>
      (f.severity === "critical" || f.severity === "high") &&
      f.finding_type !== "AI_THEORY" &&
      dashboardEligibleIds.has(f.id),
  );
  analysis.Risks = critical.slice(0, 20).map((f) => ({
    id: f.id,
    label: f.title,
    severity: f.severity as "critical" | "high" | "medium" | "low",
    mitigation: f.potential_impact ?? null,
  }));
  analysis.Recommendations = critical.slice(0, 20).map((f) => ({
    id: `rec-${f.id}`,
    action: f.legal_significance ?? `Address: ${f.title}`,
    priority: f.severity === "critical" ? "immediate" : "high",
    rationale: f.description,
  }));
  analysis.ExecutiveSummary.top_findings = critical.slice(0, 10).map((f) => f.id);

  const actors = new Set<string>();
  for (const w of analysis.Witnesses) if (w.name) actors.add(w.name);
  analysis.Facts.key_actors = [...actors];
  analysis.Facts.narrative = reportRow?.executive_summary ? String(reportRow.executive_summary) : "";

  // Work Product
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: workProduct } = await (db as any).from("case_work_product").select("*").eq("case_id", caseId);
  for (const w of safeArr(workProduct) as Record<string, unknown>[]) {
    analysis.WorkProduct.push({
      id: String(w.id),
      kind: String(w.kind ?? w.document_type ?? "memo"),
      title: String(w.title ?? "Untitled"),
      body: String(w.body ?? w.content ?? ""),
      citations: citationsFromRow(w as never),
      verification: {
        status: (w.verification_status as "clean" | "flagged" | "rejected" | "empty" | undefined) ?? "clean",
        notes: (w.verification_notes as string | null) ?? null,
      },
    });
  }

  // Appendices
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: docs } = await (db as any).from("documents").select("id,name,page_count").eq("case_id", caseId);
  analysis.Appendices.source_documents = safeArr(docs as Record<string, unknown>[]).map((d) => ({
    id: String(d.id),
    name: String(d.name ?? "Untitled document"),
    page_count: (d.page_count as number | null) ?? null,
  }));
  const citationIndex: Citation[] = [];
  for (const f of analysis.Findings) citationIndex.push(...f.citations);
  analysis.Appendices.citation_index = citationIndex;
  if (reportRow?.scores_suppressed) analysis.Appendices.suppressed_notices.push("Scores suppressed by quality gate.");
  if (reportRow?.motions_suppressed) analysis.Appendices.suppressed_notices.push("Motions suppressed by quality gate.");
  if (reportRow?.quality_blocked) analysis.Appendices.suppressed_notices.push("Report blocked by quality gate.");

  return analysis;
}

export async function writeCanonical(
  db: Db,
  caseId: string,
  analysis: CaseAnalysis,
  validationErrors: unknown[] = [],
  status: "orchestrating" | "validated" | "completed" | "failed" = "completed",
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any).from("canonical_analysis").upsert(
    {
      case_id: caseId,
      status,
      analysis_payload: analysis,
      validation_errors: validationErrors,
      pipeline_stages: { finalized_at: new Date().toISOString() },
    },
    { onConflict: "case_id" },
  );
  if (error) throw new Error(`canonical_analysis upsert failed: ${error.message}`);
}
