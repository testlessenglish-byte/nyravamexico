// Multi-agent orchestrator (server-only).
// Implements the 13-agent blueprint as a thin coordination layer over the
// existing pipeline engines. Every agent writes a row into agent_logs with
// the common API shape: { status, confidence, processingTime, tokensUsed,
// outputFile, errors }.
//
// Release rule: the final report is only marked "released" if QA, Judge, and
// Hallucination all PASS, AND every required pipeline engine (per
// canGenerateReport — the same single source of truth report generation's
// own pre-flight gate uses) is still in a good terminal state. Anything else
// leaves the case in "needs_revision". The engine check was added
// 2026-08-14 (report-quality audit §19): the original release decision only
// ever consulted the 4 gate agents, so a report could legitimately say
// "Final review passed" while a required engine (procedural_compliance,
// contradictions, etc.) had failed — those engines are never re-run or
// re-checked by report/QA/Judge/Hallucination, which only inspect the
// report's own prose and citations, not the pipeline's execution history.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { ENGINE, canGenerateReport, REPORT_REQUIRED_ENGINES } from "@/lib/execution/canonical";
import { AGENT_DEFINITIONS, type AgentResult, type AgentDefinition } from "./types";
import { attachAgentStats, buildAgentStatistics } from "./statistics.server";
import { isCheckpointError } from "@/lib/pipeline-checkpoint.server";
import { PROJECTION_LIKE, canonicalEvidenceIntegrityIssue } from "@/lib/intelligence/finding-selection";

type Db = SupabaseClient<Database>;

type CitationCandidate = {
  source_document_id?: string | null;
  source_doc_ids?: string[] | null;
  source_quote?: string | null;
};

/**
 * Source modules that findings.server.ts's addGatedFindings() inserts with
 * `{ exemptCitation: true }` — absence-of-evidence / whole-corpus-inference
 * findings that structurally cannot carry a verbatim quote by design (a
 * "this required element was not found in the corpus" marker has nothing to
 * quote). These are tagged finding_type "AI_THEORY" like any other uncited
 * finding, so that alone can't distinguish them from a genuinely
 * unsupported/speculative claim that only survived because analysis_mode
 * was permissive — but source_module can, since this is the exact fixed set
 * of callers that pass exemptCitation. CONFIRMED LIVE (ADR5829/2025, strict
 * mode): the only two findings this run produced were one substantive,
 * fully-cited key finding and one procedural_compliance absence marker —
 * counting the absence marker against citation density dragged the ratio to
 * 50%, below strict's 70% approval floor, and Judge returned
 * needs_revision on a report that was otherwise fully grounded. These
 * findings are excluded entirely (not counted as cited OR uncited) rather
 * than counted as an automatic pass, so a case that's ALL absence markers
 * still correctly falls through to the "No findings to evaluate" reject
 * path below.
 */
const CITATION_EXEMPT_SOURCE_MODULES = new Set([
  "engine:procedural_compliance",
  "engine:discovery:missing",
  "engine:discovery:violation",
  "engine:trial:risk",
  "engine:trial:strength",
  "analyzer:missing",
]);

function hasTraceableCitation(f: CitationCandidate): boolean {
  const hasDoc =
    typeof f.source_document_id === "string" && f.source_document_id.trim().length > 0
      ? true
      : Array.isArray(f.source_doc_ids) &&
        f.source_doc_ids.some((id) => typeof id === "string" && id.trim().length > 0);
  const hasQuote = typeof f.source_quote === "string" && f.source_quote.trim().length > 0;
  return hasDoc && hasQuote;
}

function collectReportText(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReportText(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectReportText(item, out);
  }
  return out;
}

function detectReportLanguageLeaks(text: string, locale: "es" | "en"): string[] {
  const checks: Array<[RegExp, string]> =
    locale === "es"
      ? [
          [/\bExecutive Summary\b/i, "Executive Summary"],
          [/\bEvidence\b/i, "Evidence"],
          [/\bDiscovery(?:\s+Violation)?\b/i, "Discovery"],
          [/\bWitness(?:es)?\b/i, "Witness"],
          [/\bStrategy\b/i, "Strategy"],
          [/\bTimeline\b/i, "Timeline"],
          [/\bFindings?\b/i, "Findings"],
          [/\bRecommendations?\b/i, "Recommendations"],
          [/\bcorroborating\b/i, "corroborating"],
          [/\bPlaintiff\b/i, "Plaintiff"],
          [/\bDefendant\b/i, "Defendant"],
          [/\bjury\b/i, "jury"],
        ]
      : [
          [/\bResumen ejecutivo\b/i, "Resumen ejecutivo"],
          [/\bHallazgos?\b/i, "Hallazgos"],
          [/\bCronolog[ií]a\b/i, "Cronología"],
          [/\bEstrategia\b/i, "Estrategia"],
          [/\bRecomendaciones\b/i, "Recomendaciones"],
        ];
  return checks.filter(([rx]) => rx.test(text)).map(([, label]) => label);
}

export interface OrchestratorArgs {
  db: Db;
  userId: string;
  caseId: string;
  apiKey: string;
  apiKeys: string[];
  executionId?: string;
  /**
   * When true this run is a PRE-report review pass: it executes every agent
   * and computes a preliminary verdict, but it must NOT write the case's
   * final release status. The release decision is made only by
   * `runFinalReleaseReview()` once the completed report has been generated
   * and saved. See docs: release decision is always the last pipeline step.
   */
  deferRelease?: boolean;
}


type AnalysisMode = "strict" | "balanced" | "exploratory";
type RunCtx = OrchestratorArgs & { runId: string; analysisMode: AnalysisMode };

async function recordAgent(db: Db, ctx: RunCtx, def: AgentDefinition, startedAt: number, result: AgentResult) {
  const finishedAt = new Date().toISOString();
  const outputObj =
    result.output && typeof result.output === "object" && !Array.isArray(result.output)
      ? (result.output as Record<string, unknown>)
      : {};
  const outputWithMode: Record<string, unknown> = { ...outputObj, analysis_mode: ctx.analysisMode };
  const stats =
    outputObj.agent_stats && typeof outputObj.agent_stats === "object" && !Array.isArray(outputObj.agent_stats)
      ? (outputObj.agent_stats as Record<string, unknown>)
      : {};
  await db.from("agent_logs").insert({
    case_id: ctx.caseId,
    user_id: ctx.userId,
    run_id: ctx.runId,
    agent_key: def.key,
    agent_index: def.index,
    agent_name: def.name,
    status: result.status,
    confidence: result.confidence,
    processing_time_ms: Math.max(0, Date.now() - startedAt),
    tokens_used: result.tokensUsed,
    output_file: result.outputFile,
    documents_analyzed: Number(stats.documents_analyzed ?? 0),
    findings_generated: Number(stats.findings_generated ?? 0),
    findings_suppressed: Number(stats.findings_suppressed ?? 0),
    findings_promoted: Number(stats.findings_promoted ?? 0),
    findings_produced: Number(stats.findings_promoted ?? stats.visible_findings ?? 0),
    output_items: Number(stats.output_items ?? 0),
    no_output_reason: stats.no_output_reason ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output: outputWithMode as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errors: (result.errors.length ? result.errors : null) as any,
    started_at: new Date(startedAt).toISOString(),
    finished_at: finishedAt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function safeRun(fn: () => Promise<AgentResult>, def: AgentDefinition): Promise<AgentResult> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return {
      ...r,
      processingTime: Date.now() - t0,
      outputFile: r.outputFile || def.outputFile,
    };
  } catch (e) {
    if (isCheckpointError(e)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "failed",
      confidence: 0,
      processingTime: Date.now() - t0,
      tokensUsed: 0,
      outputFile: def.outputFile,
      errors: [msg],
    };
  }
}

async function agentIntake(ctx: RunCtx): Promise<AgentResult> {
  const { data, error } = await ctx.db
    .from("documents")
    .select("id,filename,mime_type,size_bytes,content_hash,created_at")
    .eq("case_id", ctx.caseId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const files = data ?? [];
  const seenHash = new Set<string>();
  let duplicates = 0;
  for (const f of files) {
    const h = f.content_hash;
    if (h) {
      if (seenHash.has(h)) duplicates += 1;
      seenHash.add(h);
    }
  }
  return {
    status: files.length === 0 ? "failed" : "success",
    confidence: files.length === 0 ? 0 : 1,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "case_manifest.json",
    errors: files.length === 0 ? ["No files uploaded for this case."] : [],
    output: {
      file_count: files.length,
      duplicates,
      files: files.map((f) => ({
        evidence_id: f.id,
        name: f.filename,
        mime: f.mime_type,
        bytes: f.size_bytes,
      })),
    },
  };
}

async function hasCompletedEngine(db: Db, caseId: string, engine: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from("pipeline_engine_runs")
    .select("id")
    .eq("case_id", caseId)
    .eq("engine", engine)
    .eq("status", "completed")
    .limit(1)
    .maybeSingle();
  return !!data;
}

async function agentOcr(ctx: RunCtx): Promise<AgentResult> {
  const engineCompleted = await hasCompletedEngine(ctx.db, ctx.caseId, ENGINE.extraction);
  const { count } = await ctx.db
    .from("document_pages")
    .select("id", { count: "exact", head: true })
    .eq("case_id", ctx.caseId);
  const ok = engineCompleted && (count ?? 0) > 0;
  return {
    status: ok ? "success" : "failed",
    confidence: ok ? 0.95 : 0,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "ocr_output.json",
    errors: ok ? [] : ["Extraction stage did not complete before the release gate ran; nothing to verify."],
    // `extraction_completed` must answer the same question as `status`/`errors`
    // above (did the check pass?), not just report the raw ledger flag —
    // otherwise this can read `extraction_completed: true` in the same
    // object as an "did not complete" error whenever the engine row is
    // marked completed but produced zero verifiable pages.
    output: { pages_extracted: count ?? 0, extraction_engine_completed: engineCompleted, extraction_completed: ok },
  };
}

async function agentEntities(ctx: RunCtx): Promise<AgentResult> {
  const engineCompleted = await hasCompletedEngine(ctx.db, ctx.caseId, ENGINE.analyzers);
  const { count: findingsCount } = await ctx.db
    .from("case_findings")
    .select("id", { count: "exact", head: true })
    .eq("case_id", ctx.caseId)
    .not("source_module", "like", PROJECTION_LIKE);
  const hasFindings = (findingsCount ?? 0) > 0;
  // FATAL gate: only "the analyzers stage itself never completed" belongs
  // here. `entities` sits in the orchestrator's FATAL set, so a "failed"
  // status here blocks all 10 downstream agents (timeline through
  // hallucination) outright — see the FATAL-blocking loop below. Zero
  // findings surviving the (now much stricter) evidence gate is a
  // legitimately thin case, not a broken pipeline; treating it the same as
  // "the stage never ran" wrongly prevented QA/Judge/Hallucination from
  // ever running and — since a report-release-gate guard now refuses to
  // generate a report at all when multi_agent's released flag is explicitly
  // false — silently blocked report generation for every case where the
  // stricter gate correctly rejected everything down to zero. QA and Judge
  // each independently and correctly re-check "zero findings" on their own
  // terms (agentQA: "No findings to support the report."; agentJudge:
  // verdict "reject" / "No findings to evaluate.") and will still fail a
  // genuinely empty case — that real rejection must come from them, not
  // from a fatal short-circuit here that skips them entirely.
  const ok = engineCompleted;
  return {
    status: ok ? "success" : "failed",
    confidence: ok ? (hasFindings ? 0.85 : 0.5) : 0,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "entities.json",
    errors: ok
      ? hasFindings
        ? []
        : [
            "Analyzers stage completed but zero findings survived the evidence gate — thin/strict case, not a pipeline failure. Downstream QA/Judge will independently assess whether this can release.",
          ]
      : ["Analyzers stage did not complete before the release gate ran; nothing to verify."],
    // `analyzers_completed` must answer the same question as `status`/`errors`
    // above. Previously this reported the raw pipeline_engine_runs ledger
    // flag (`engineCompleted`) even when `status` was "failed" because zero
    // findings survived — producing analyzers_completed: true in the same
    // result as an "Analyzers stage did not complete" error. Split the two
    // concepts explicitly instead of overloading one field.
    output: {
      findings_count: findingsCount ?? 0,
      analyzers_engine_completed: engineCompleted,
      analyzers_completed: ok,
    },
  };
}

async function agentTimeline(ctx: RunCtx): Promise<AgentResult> {
  const m = await import("@/lib/intelligence/canonical-timeline.server");
  const tl = await m.buildCanonicalTimeline(ctx.db, ctx.caseId);
  return {
    status: "success",
    confidence: tl.totals.dated > 0 ? 0.9 : 0.4,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "timeline.json",
    errors: [],
    output: JSON.parse(JSON.stringify(tl.totals)),
  };
}

async function agentEvidence(ctx: RunCtx): Promise<AgentResult> {
  const m = await import("@/lib/intelligence/evidence-map.server");
  const em = await m.buildEvidenceMap(ctx.db, ctx.caseId);
  return {
    status: "success",
    confidence: em.totals.missing_evidence === 0 ? 0.9 : 0.6,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "evidence_analysis.json",
    errors: [],
    output: JSON.parse(JSON.stringify(em.totals)),
  };
}

async function agentContradictions(ctx: RunCtx): Promise<AgentResult> {
  const m = await import("@/lib/intelligence/derived-engines.server");
  const out = await m.deriveContradictions(ctx.db, ctx.caseId);
  return {
    status: "success",
    confidence: 0.8,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "contradictions.json",
    errors: [],
    output: JSON.parse(JSON.stringify(out.value)),
  };
}

async function agentLegal(ctx: RunCtx): Promise<AgentResult> {
  const alreadyDone = await hasCompletedEngine(ctx.db, ctx.caseId, ENGINE.agents);
  const { count } = await ctx.db
    .from("agent_findings")
    .select("id", { count: "exact", head: true })
    .eq("case_id", ctx.caseId);
  const ok = alreadyDone && (count ?? 0) > 0;
  return {
    status: ok ? "success" : "failed",
    confidence: ok ? 0.8 : 0,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "legal_research.json",
    errors: ok ? [] : ["Agents stage did not complete before the release gate ran; nothing to verify."],
    output: { agent_findings: count ?? 0, agents_completed: alreadyDone },
  };
}

async function agentRisk(ctx: RunCtx): Promise<AgentResult> {
  const alreadyDone = await hasCompletedEngine(ctx.db, ctx.caseId, ENGINE.scoring);
  const { data: score } = await ctx.db.from("case_scores").select("*").eq("case_id", ctx.caseId).maybeSingle();
  const ok = alreadyDone && !!score;
  return {
    status: ok ? "success" : "failed",
    confidence: ok ? 0.85 : 0,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "risk_analysis.json",
    errors: ok ? [] : ["Scoring stage did not complete before the release gate ran; nothing to verify."],
    output: ok ? JSON.parse(JSON.stringify(score)) : null,
  };
}

// STRUCTURAL FIX (2026-08-01): this agent used to require
// hasCompletedEngine(..., "report_generator"). That check is unsatisfiable
// here: canonical.ts schedules `multi_agent` BEFORE `report` (report.dependsOn
// includes "multi_agent"; multi_agent.dependsOn does not include report), so
// report_generator has by definition not run when this agent executes. The
// result was a permanent `failed` for agents 11 (report) and 12 (qa),
// released:false on every run, and suppressed scores downstream.
//
// Chosen remedy: option 1 — drop the unsatisfiable completion check inside
// multi_agent and verify report *readiness* instead. Option 2 (move the
// verification to a real post-report pass) is already covered: the canonical
// gate runs runReportQa() on the assembled report after report_generator
// finishes (src/lib/canonical/report-qa.server.ts, called from gate.server.ts),
// so a second post-report agent pass would duplicate it and would require
// inverting the stage order the pipeline deliberately adopted on 2026-07-31.
async function agentReport(ctx: RunCtx): Promise<AgentResult> {
  const { data: report } = await ctx.db
    .from("reports")
    .select("case_id,full_report,executive_summary")
    .eq("case_id", ctx.caseId)
    .maybeSingle();
  // A report row only exists on a re-run (report_generator ran previously).
  // On a first run we verify the inputs the report will be assembled from.
  const scoringDone = await hasCompletedEngine(ctx.db, ctx.caseId, ENGINE.scoring);
  const { count: findingsCount } = await ctx.db
    .from("case_findings")
    .select("id", { count: "exact", head: true })
    .eq("case_id", ctx.caseId)
    .not("source_module", "like", PROJECTION_LIKE);
  const ready = scoringDone && (findingsCount ?? 0) > 0;
  let ok = !!report || ready;
  const errors: string[] = [];
  if (!ok) {
    if (!scoringDone) errors.push("Scoring stage has not completed; the report has no scored basis to assemble from.");
    if ((findingsCount ?? 0) === 0) errors.push("No canonical findings available for the report.");
  }
  // Completed judicial decisions have an authoritative, independently
  // reconstructed decision core. Unlike heuristic report-quality metrics,
  // omitting a verified holding/disposition/remedy is a hard release error.
  const { data: caseModeRow } = await ctx.db
    .from("cases")
    .select("case_analysis_mode")
    .eq("id", ctx.caseId)
    .maybeSingle();
  const { normalizeCaseAnalysisMode, isCompletedCaseMode } = await import(
    "@/lib/intelligence/case-analysis-mode"
  );
  if (report && isCompletedCaseMode(normalizeCaseAnalysisMode(caseModeRow?.case_analysis_mode))) {
    const core = (report.full_report as Record<string, unknown> | null)
      ?.mandatory_decision_core as
      | { required_for_release?: unknown; validation?: { ok?: unknown } }
      | undefined;
    const coreOk = core?.required_for_release === true && core.validation?.ok === true;
    if (!coreOk) {
      ok = false;
      errors.push(
        "Mandatory decision core missing or incomplete — every verified holding, rejected holding, disposition, remedy, and controlling issue must be represented before release.",
      );
    }
  }
  return {
    status: ok ? "success" : "failed",
    confidence: ok ? (report ? 0.9 : 0.8) : 0,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "draft_report.md",
    errors,
    output: {
      case_id: report?.case_id ?? ctx.caseId,
      mode: report ? "post_report_verification" : "pre_report_readiness",
      report_exists: !!report,
      scoring_completed: scoringDone,
      findings_count: findingsCount ?? 0,
    },
  };
}

const QA_NARRATIVE_FIELDS = [
  "executive_summary",
  "attorney_summary",
  "evidence_summary",
  "timeline_summary",
  "contradiction_report",
  "missing_evidence_report",
  "recommendations",
  "investigator_summary",
  "case_overview",
  "facts",
  "witness_analysis",
  "constitutional_issues",
  "discovery_analysis",
  "procedural_issues_report",
  "prosecution_theory_report",
  "defense_theory_report",
  "alternative_theory_report",
  "risk_analysis",
] as const;

// Same structural constraint as agentReport: on a first run there is no
// `reports` row yet, because report_generator runs AFTER multi_agent. The
// report-shaped checks below are therefore only applied when a report row
// actually exists (re-runs); otherwise QA audits what exists at this point in
// the pipeline. The authoritative post-report QA is runReportQa() in
// src/lib/canonical/report-qa.server.ts, invoked by the canonical gate once
// report_generator has produced the analysis.
async function agentQA(ctx: RunCtx): Promise<AgentResult> {
  const { data: report } = await ctx.db
    .from("reports")
    .select(
      "case_id,full_report,executive_summary,attorney_summary,evidence_summary,timeline_summary,contradiction_report,missing_evidence_report,recommendations,investigator_summary,case_overview,facts,witness_analysis,constitutional_issues,discovery_analysis,procedural_issues_report,prosecution_theory_report,defense_theory_report,alternative_theory_report,risk_analysis",
    )
    .eq("case_id", ctx.caseId)
    .maybeSingle();
  const errors: string[] = [];
  const checked: string[] = ["findings_present"];

  const { count: findingsCount } = await ctx.db
    .from("case_findings")
    .select("id", { count: "exact", head: true })
    .eq("case_id", ctx.caseId)
    .not("source_module", "like", PROJECTION_LIKE);
  if ((findingsCount ?? 0) === 0) errors.push("No findings to support the report.");

  const { getReportLocale } = await import("@/lib/mexico-lock");
  const locale = await getReportLocale(ctx.db, ctx.caseId);

  if (report) {
    checked.push("report_exists", "summary_length", "single_language");
    const full = report.full_report as Record<string, unknown> | null;
    if (!full) errors.push("Report has no full_report payload.");
    const summary = report.executive_summary;
    if (!summary || String(summary).trim().length < 80) {
      errors.push("Executive summary missing or too short (<80 chars).");
    }
    const narrativeValues = QA_NARRATIVE_FIELDS.map((field) => (report as Record<string, unknown>)[field]);
    const reportText = collectReportText(narrativeValues).join("\n").slice(0, 200_000);
    const languageLeaks = detectReportLanguageLeaks(reportText, locale);
    if (languageLeaks.length > 0) {
      errors.push(`Report language drift (${locale}): ${Array.from(new Set(languageLeaks)).slice(0, 8).join(", ")}.`);
    }
  }

  const pass = errors.length === 0;
  return {
    status: pass ? "success" : "failed",
    confidence: pass ? 0.95 : 0.3,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "qa_report.json",
    errors,
    output: { pass, mode: report ? "post_report" : "pre_report", checked, locale },
  };
}

const JUDGE_THRESHOLDS: Record<AnalysisMode, { reject: number; needsRevision: number }> = {
  strict: { reject: 0.4, needsRevision: 0.7 },
  balanced: { reject: 0.25, needsRevision: 0.5 },
  exploratory: { reject: 0.15, needsRevision: 0.3 },
};
// Minimum share of cited findings whose quote must verify against the corpus
// (after legal-authority citations are correctly exempted — see
// grounding.server.ts::isLegalAuthorityCitation). The threshold was
// temporarily lowered to 0.3 alongside a pattern-only authority-exemption
// check; that check was confirmed, by direct reproduction, to exempt
// fabricated factual claims merely phrased alongside a real article number,
// which is exactly the class of claim this gate exists to catch. Restored
// to 0.5 now that the exemption is properly scoped to quotes that are
// SUBSTANTIALLY JUST a citation — genuine Amparo/administrative citation
// density no longer needs a lowered bar to pass, since those citations are
// now correctly exempted rather than miscounted as failures.
const HALLUCINATION_THRESHOLDS: Record<AnalysisMode, number> = {
  strict: 0.85,
  balanced: 0.7,
  exploratory: 0.5,
};

export type JudgeFinding = {
  source_document_id: string | null;
  source_doc_ids: string[] | null;
  source_quote: string | null;
  source_module: string | null;
  title?: string | null;
  description?: string | null;
  legal_significance?: string | null;
  potential_impact?: string | null;
  evidence_refs?: unknown;
  audit_classification?: string | null;
};

export type JudgeVerdictResult = {
  verdict: "approve" | "needs_revision" | "reject";
  notes: string[];
  totals: { findings: number; cited: number; cited_ratio: number; integrity_issues: number };
};

export function isCitationExemptFinding(f: JudgeFinding): boolean {
  const mod = String(f.source_module ?? "");
  if (CITATION_EXEMPT_SOURCE_MODULES.has(mod) || mod.startsWith("decision_core")) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = ((f as any).metadata ?? {}) as Record<string, unknown>;
  if (
    meta.mandatory_decision_core ||
    meta.citation_exemption_type === "EXEMPT_METADATA" ||
    meta.citation_exemption_type === "EXEMPT_STATUTORY_FORMULA"
  ) {
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((f as any).verification_status === "authority_exempt") return true;
  return false;
}

/** Pure decision, extracted so the citation-exemption behavior is directly
 *  unit-testable without a fake-db harness for the whole agent. */
export function computeJudgeVerdict(
  allFindings: JudgeFinding[],
  mode: AnalysisMode,
): JudgeVerdictResult {
  const t = JUDGE_THRESHOLDS[mode];
  let verdict: "approve" | "needs_revision" | "reject" = "approve";
  const notes: string[] = [];
  const findings = allFindings.filter((f) => !isCitationExemptFinding(f));
  const totalN = findings.length;
  const cited = findings.filter((f) => hasTraceableCitation(f)).length;
  const citedRatio = totalN > 0 ? cited / totalN : 1;
  const integrityIssues = findings
    .map((f) => ({ title: String(f.title ?? ""), issue: canonicalEvidenceIntegrityIssue(f) }))
    .filter((x) => x.issue);
  if (totalN === 0) {
    verdict = "reject";
    notes.push("No findings to evaluate.");
  } else if (integrityIssues.length > 0) {
    verdict = "reject";
    notes.push(
      `Semantic evidence integrity failed for ${integrityIssues.length} finding(s): ${integrityIssues
        .slice(0, 5)
        .map((x) => `${x.title || "(untitled)"} [${x.issue}]`)
        .join(", ")}.`,
    );
  } else if (citedRatio < t.reject) {
    verdict = "reject";
    notes.push(
      `Citation density ${(citedRatio * 100).toFixed(0)}% below ${mode} reject threshold (${(t.reject * 100).toFixed(0)}%).`,
    );
  } else if (citedRatio < t.needsRevision) {
    verdict = "needs_revision";
    notes.push(
      `Citation density ${(citedRatio * 100).toFixed(0)}% below ${mode} approval threshold (${(t.needsRevision * 100).toFixed(0)}%).`,
    );
  } else {
    notes.push(`Citation density ${(citedRatio * 100).toFixed(0)}% passes ${mode} approval threshold.`);
  }
  const contraCount = findings.filter((f) => f.source_module === "contradictions").length;
  if (contraCount > 50 && verdict === "approve") {
    verdict = "needs_revision";
    notes.push(`High contradiction count (${contraCount}) warrants revision.`);
  }
  return { verdict, notes, totals: { findings: totalN, cited, cited_ratio: citedRatio, integrity_issues: integrityIssues.length } };
}

async function agentJudge(ctx: RunCtx): Promise<AgentResult> {
  const { data: allFindings } = await ctx.db
    .from("case_findings")
    .select("id,title,description,legal_significance,potential_impact,source_document_id,source_doc_ids,source_quote,evidence_refs,audit_classification,source_module")
    .eq("case_id", ctx.caseId)
    .not("source_module", "like", PROJECTION_LIKE);
  const { verdict, notes, totals } = computeJudgeVerdict(
    (allFindings ?? []) as JudgeFinding[],
    ctx.analysisMode,
  );
  const pass = verdict === "approve";
  return {
    status: pass ? "success" : "failed",
    confidence: verdict === "approve" ? 0.85 : verdict === "needs_revision" ? 0.65 : 0.3,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "judge_report.json",
    errors: pass ? [] : [`Judge verdict: ${verdict}`, ...notes],
    output: {
      verdict,
      notes,
      mode: ctx.analysisMode,
      thresholds: JUDGE_THRESHOLDS[ctx.analysisMode],
      totals,
    },
  };
}

async function agentHallucination(ctx: RunCtx): Promise<AgentResult> {
  const m = await import("@/lib/intelligence/hallucination.server");
  const report = await m.runHallucinationReview({ db: ctx.db, caseId: ctx.caseId });
  // Legal-authority citations (CPEUM/statutory articles, tesis, jurisprudencia)
  // cannot be verified verbatim against the case corpus; they are counted as
  // grounded rather than as failures. Verbatim matching governs documentary
  // claims only.
  const authorityExempt = report.authority_exempt ?? 0;
  const grounded = report.verified + authorityExempt;
  const cited = grounded + report.unverified;
  const verifiedRatio = cited > 0 ? grounded / cited : 1;
  const citationCoverage = report.total > 0 ? cited / report.total : 0;
  const threshold = HALLUCINATION_THRESHOLDS[ctx.analysisMode];
  const pass = report.total > 0 && cited > 0 && verifiedRatio >= threshold;
  const errors: string[] = [];
  if (report.total === 0) errors.push("No findings available for hallucination review.");
  if (report.total > 0 && cited === 0) errors.push("No findings carry both a source document and verbatim quote.");
  if (cited > 0 && verifiedRatio < threshold) {
    errors.push(
      `Verified ratio ${(verifiedRatio * 100).toFixed(1)}% of cited findings below ${ctx.analysisMode} threshold (${(threshold * 100).toFixed(0)}%).`,
    );
  }
  return {
    status: pass ? "success" : "failed",
    confidence: verifiedRatio,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "hallucination_report.json",
    errors: pass ? [] : errors,
    output: {
      total: report.total,
      verified: report.verified,
      authority_exempt: authorityExempt,
      unverified: report.unverified,
      no_citation: report.no_citation,
      citation_coverage: citationCoverage,
      verification_ratio: verifiedRatio,
      mode: ctx.analysisMode,
      threshold,
    },
  };
}

export async function runMultiAgentPipeline(args: OrchestratorArgs): Promise<{
  runId: string;
  released: boolean;
  releaseDeferred?: boolean;
  results: Array<AgentResult & { agent: AgentDefinition }>;
}> {
  const { withAIUser } = await import("@/lib/ai/user-scope.server");
  return withAIUser(args.userId, () => _runMultiAgentPipeline(args));
}

async function _runMultiAgentPipeline(args: OrchestratorArgs): Promise<{
  runId: string;
  released: boolean;
  releaseDeferred?: boolean;
  results: Array<AgentResult & { agent: AgentDefinition }>;
}> {
  const runId = crypto.randomUUID();
  const { getAnalysisMode } = await import("@/lib/intelligence/evidence-gate.server");
  const analysisMode = (await getAnalysisMode(args.db, args.caseId)) as AnalysisMode;
  const ctx: RunCtx = { ...args, runId, analysisMode };
  console.info(`[multi-agent] run ${runId} case=${args.caseId} mode=${analysisMode}`);
  const trace = (event: string, extra: Record<string, unknown> = {}) => {
    console.info(
      `[multi-agent] ${JSON.stringify({
        t: new Date().toISOString(),
        event,
        runId,
        caseId: args.caseId,
        ...extra,
      })}`,
    );
  };
  trace("multi_agent.start", { mode: analysisMode, agents_loaded: AGENT_DEFINITIONS.length });

  const runners: Record<string, (c: RunCtx) => Promise<AgentResult>> = {
    intake: agentIntake,
    ocr: agentOcr,
    entities: agentEntities,
    timeline: agentTimeline,
    evidence: agentEvidence,
    contradictions: agentContradictions,
    legal: agentLegal,
    risk: agentRisk,
    report: agentReport,
    qa: agentQA,
    judge: agentJudge,
    hallucination: agentHallucination,
  };

  const results: Array<AgentResult & { agent: AgentDefinition }> = [];
  const FATAL = new Set(["intake", "ocr", "entities"]);

  // Guard against missing represented party
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: caseMeta } = await (args.db as any)
    .from("cases")
    .select("represented_party")
    .eq("id", args.caseId)
    .maybeSingle();
  if (!caseMeta?.represented_party) {
    console.warn(`[multi-agent] Warning: Case ${args.caseId} has no represented_party defined.`);
  }

  for (const def of AGENT_DEFINITIONS) {
    if (def.key === "orchestrator") continue;
    const fn = runners[def.key];
    const t0 = Date.now();
    trace("agent.start", { agent_index: def.index, agent_key: def.key, agent_name: def.name });
    const rawResult = await safeRun(() => fn(ctx), def);
    const result = await attachAgentStats(args.db, args.caseId, def, rawResult, t0);
    results.push({ ...result, agent: def });
    await recordAgent(args.db, ctx, def, t0, result);
    trace("agent.complete", {
      agent_index: def.index,
      agent_key: def.key,
      status: result.status,
      runtime_ms: Date.now() - t0,
    });
    if (result.status === "failed" && FATAL.has(def.key)) {
      for (const rest of AGENT_DEFINITIONS) {
        if (rest.key === "orchestrator") continue;
        if (rest.index <= def.index) continue;
        const blockedRaw: AgentResult = {
          status: "blocked",
          confidence: 0,
          processingTime: 0,
          tokensUsed: 0,
          outputFile: rest.outputFile,
          errors: [`Blocked by upstream failure at ${def.name}`],
        };
        const blocked = await attachAgentStats(args.db, args.caseId, rest, blockedRaw, Date.now());
        results.push({ ...blocked, agent: rest });
        await recordAgent(args.db, ctx, rest, Date.now(), blocked);
        trace("agent.blocked", { agent_index: rest.index, agent_key: rest.key, blocked_by: def.key });
      }
      break;
    }
  }

  const byKey = new Map(results.map((r) => [r.agent.key, r]));
  const qaOk = byKey.get("qa")?.status === "success";
  const judgeOk = byKey.get("judge")?.status === "success";
  const halOk = byKey.get("hallucination")?.status === "success";
  const released = qaOk && judgeOk && halOk;

  const orchDef = AGENT_DEFINITIONS.find((d) => d.key === "orchestrator")!;
  const orchResult: AgentResult = {
    status: released ? "success" : "failed",
    confidence: released ? 1 : 0.5,
    processingTime: 0,
    tokensUsed: 0,
    outputFile: "orchestrator_log.json",
    errors: released ? [] : ["Release gate failed — QA/Judge/Hallucination did not all pass."],
    output: {
      run_id: runId,
      released,
      gates: { qa: qaOk, judge: judgeOk, hallucination: halOk, mode: ctx.analysisMode },
      agents: results.map((r) => ({
        index: r.agent.index,
        key: r.agent.key,
        status: r.status,
        confidence: r.confidence,
      })),
    },
  };
  const orchStarted = Date.now();
  trace("agent.start", { agent_index: orchDef.index, agent_key: orchDef.key, agent_name: orchDef.name });
  const orchWithStats = await attachAgentStats(args.db, args.caseId, orchDef, orchResult, orchStarted);
  await recordAgent(args.db, ctx, orchDef, orchStarted, orchWithStats);
  results.push({ ...orchWithStats, agent: orchDef });
  trace("agent.complete", {
    agent_index: orchDef.index,
    agent_key: orchDef.key,
    status: orchWithStats.status,
    runtime_ms: Date.now() - orchStarted,
  });

  try {
    const agentStatistics = await buildAgentStatistics(args.db, args.caseId, { runId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report } = await (args.db as any)
      .from("reports")
      .select("full_report")
      .eq("case_id", args.caseId)
      .maybeSingle();
    const full =
      report?.full_report && typeof report.full_report === "object" && !Array.isArray(report.full_report)
        ? { ...(report.full_report as Record<string, unknown>) }
        : {};
    full.agent_statistics = agentStatistics as unknown as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (args.db as any)
      .from("reports")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update({ full_report: full as any })
      .eq("case_id", args.caseId);
  } catch (e) {
    console.warn("[multi-agent] failed to restamp report agent statistics", e);
  }

  // Release decision. When `deferRelease` is set this run happened BEFORE
  // the final report was generated, so its verdict is preliminary only: it
  // must never write the case's release status. `runFinalReleaseReview()`
  // re-runs QA/Judge/Hallucination against the completed, saved report and
  // is the single writer of the final status.
  const { data: savedReportForRelease } = await args.db
    .from("reports")
    .select("case_id")
    .eq("case_id", args.caseId)
    .maybeSingle();
  if (args.deferRelease) {
    trace("case.status.write_skipped", {
      source: "multi_agent.preliminary",
      preliminary_released: released,
      gates: { qa: qaOk, judge: judgeOk, hallucination: halOk },
    });
    trace("multi_agent.complete", { released, deferred: true, agents_executed: results.length });
    return { runId, released, results, releaseDeferred: true };
  }
  if (!savedReportForRelease) {
    trace("case.status.write_skipped", {
      source: "multi_agent.no_saved_report",
      preliminary_released: released,
      gates: { qa: qaOk, judge: judgeOk, hallucination: halOk },
    });
    trace("multi_agent.complete", { released, deferred: true, agents_executed: results.length });
    return { runId, released, results, releaseDeferred: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: beforeStatus } = await (args.db as any)
    .from("cases")
    .select("status,status_message")
    .eq("id", args.caseId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (args.db as any)
    .from("cases")
    .update({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: (released ? "released" : "needs_revision") as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status_message: (released
        ? "Multi-agent run released report."
        : "Multi-agent release blocked — see QA/Judge/Hallucination logs.") as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .eq("id", args.caseId);
  trace("case.status.write", {
    source: "multi_agent.release_gate",
    previous_status: beforeStatus?.status ?? null,
    new_status: released ? "released" : "needs_revision",
    gates: { qa: qaOk, judge: judgeOk, hallucination: halOk },
  });
  trace("multi_agent.complete", { released, agents_executed: results.length });

  return { runId, released, results, releaseDeferred: false };
}

// ---------------------------------------------------------------------------
// Final release review — the LAST step of the pipeline.
//
// Runs only after report generation has produced and saved a completed
// report. It re-executes the release-gate agents. Hallucination reconciliation
// runs BEFORE Judge so the Judge audits the same surviving/canonical claim set
// that can actually be released. A Judge result computed over raw claims that
// Hallucination removes milliseconds later is not a valid final verdict.
// Report generation itself never assigns the final status: generating a
// report and approving a report are separate actions.
// ---------------------------------------------------------------------------
export type ReleaseDecision = "PASS" | "PASS_WITH_WARNINGS" | "BLOCKED";

export type FinalReleaseReview = {
  reviewed: boolean;
  released: boolean;
  decision: ReleaseDecision;
  status: "released" | "needs_revision" | "failed";
  gates: { report: boolean; qa: boolean; judge: boolean; hallucination: boolean };
  missingRequiredEngines: string[];
  warnings: string[];
  errors: string[];
};

export async function runFinalReleaseReview(args: OrchestratorArgs): Promise<FinalReleaseReview> {
  const { withAIUser } = await import("@/lib/ai/user-scope.server");
  return withAIUser(args.userId, () => _runFinalReleaseReview(args));
}

async function _runFinalReleaseReview(args: OrchestratorArgs): Promise<FinalReleaseReview> {
  const runId = crypto.randomUUID();
  const { getAnalysisMode } = await import("@/lib/intelligence/evidence-gate.server");
  const { validateJSONPipelineIntegrity } = await import("@/lib/intelligence/json-integrity-gate");
  const analysisMode = (await getAnalysisMode(args.db, args.caseId)) as AnalysisMode;
  const ctx: RunCtx = { ...args, runId, analysisMode };

  const { data: reportRow } = await args.db
    .from("reports")
    .select("case_id, full_report")
    .eq("case_id", args.caseId)
    .maybeSingle();
  if (!reportRow) {
    console.warn(`[final-release] case ${args.caseId} has no saved report — release review skipped`);
    return {
      reviewed: false,
      released: false,
      decision: "BLOCKED",
      status: "failed",
      gates: { report: false, qa: false, judge: false, hallucination: false },
      missingRequiredEngines: [],
      warnings: [],
      errors: ["No completed report to review."],
    };
  }

  // ORDER IS A RELEASE INVARIANT. Hallucination may quarantine/suppress
  // unsupported rows. Judge must therefore run after it.
  const gateRunners: Array<[string, (c: RunCtx) => Promise<AgentResult>]> = [
    ["report", agentReport],
    ["qa", agentQA],
    ["hallucination", agentHallucination],
    ["judge", agentJudge],
  ];

  const outcomes: Record<string, boolean> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [key, fn] of gateRunners) {
    const def = AGENT_DEFINITIONS.find((d) => d.key === key)!;
    const startedAt = Date.now();
    const raw = await safeRun(() => fn(ctx), def);
    const withStats = await attachAgentStats(args.db, args.caseId, def, raw, startedAt);
    await recordAgent(args.db, ctx, def, startedAt, withStats);
    outcomes[key] = withStats.status === "success";
    if (withStats.status !== "success") errors.push(...(withStats.errors ?? []));
  }

  const gatesPassed = Boolean(outcomes.report && outcomes.qa && outcomes.judge && outcomes.hallucination);

  let engineRunsQuery = args.db
    .from("pipeline_engine_runs")
    .select("id,engine,status,started_at,ended_at,created_at")
    .eq("case_id", args.caseId)
    .in("engine", REPORT_REQUIRED_ENGINES as unknown as string[]);
  if (args.executionId) {
    engineRunsQuery = engineRunsQuery.eq("execution_id", args.executionId);
  }
  const { data: engineRuns } = await engineRunsQuery.order("created_at", { ascending: false });
  const engineGate = canGenerateReport((engineRuns ?? []) as never);
  if (!engineGate.ok) {
    errors.push(
      `Required engine(s) not in a completed state: ${engineGate.missingBlocking.join(", ")}.`,
    );
  }
  if (engineGate.missingEnriching.length > 0) {
    warnings.push(...engineGate.missingEnriching.map((e) => `Enriching engine ${e} incomplete`));
  }

  // Pre-release JSON Integrity Validation
  const { data: caseRow } = await args.db.from("cases").select("*").eq("id", args.caseId).maybeSingle();
  const { data: findingsData } = await args.db.from("case_findings").select("*").eq("case_id", args.caseId);
  const integrity = validateJSONPipelineIntegrity({
    caseRow,
    findings: (findingsData ?? []) as never,
    isLimitedMode: analysisMode === "strict",
    reportReleased: gatesPassed && engineGate.ok,
  });

  if (!integrity.valid) {
    errors.push(...integrity.violations.filter((v) => v.severity === "critical").map((v) => v.message));
  }
  if (integrity.warning_count > 0) {
    warnings.push(...integrity.violations.filter((v) => v.severity === "warning").map((v) => v.message));
  }

  // Authoritative Decision
  let decision: ReleaseDecision = "BLOCKED";
  if (gatesPassed && engineGate.ok && integrity.valid) {
    decision = warnings.length > 0 ? "PASS_WITH_WARNINGS" : "PASS";
  }

  const released = decision === "PASS" || decision === "PASS_WITH_WARNINGS";
  const status: FinalReleaseReview["status"] = released ? "released" : "needs_revision";
  const statusMessage = decision === "PASS"
    ? "Final review passed — report released."
    : decision === "PASS_WITH_WARNINGS"
      ? `Final review passed with warnings — report released (${warnings.length} warning(s)).`
      : !engineGate.ok
        ? `Final review blocked — required engine(s) did not complete: ${engineGate.missingBlocking.join(", ")}.`
        : `Final review requires revision: ${errors.join("; ").slice(0, 500)}`;

  // Atomic state update
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: releaseStateError } = await (args.db as any)
    .from("cases")
    .update({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: status as any,
      progress: released ? 100 : 99,
      completed_at: released ? new Date().toISOString() : null,
      report_at: released ? new Date().toISOString() : null,
      next_stage: null,
      worker_lease_until: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status_message: statusMessage as any,
      error: released ? null : errors.join("; ").slice(0, 2000),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .eq("id", args.caseId);

  if (releaseStateError) {
    throw new Error(`Failed to persist final release state for case ${args.caseId}: ${releaseStateError.message}`);
  }

  // Update persisted report release_gate metadata so report snapshot agrees with case state
  try {
    const fullRep = ((reportRow.full_report as Record<string, unknown>) ?? {});
    await args.db
      .from("reports")
      .update({
        full_report: {
          ...fullRep,
          release_decision: decision,
          release_warnings: warnings,
          release_gate: {
            ok: released,
            decision,
            gates: outcomes,
            missing_required_engines: engineGate.missingBlocking,
            warnings,
            errors,
          },
        } as any,
      })
      .eq("case_id", args.caseId);
  } catch (e) {
    console.warn("[final-release] failed to update report release_gate object", e);
  }

  console.info(
    `[final-release] ${JSON.stringify({
      run_id: runId,
      case_id: args.caseId,
      status,
      decision,
      gates: outcomes,
      missing_required_engines: engineGate.missingBlocking,
      warnings_count: warnings.length,
      errors_count: errors.length,
    })}`,
  );

  return {
    reviewed: true,
    released,
    decision,
    status,
    gates: {
      report: Boolean(outcomes.report),
      qa: Boolean(outcomes.qa),
      judge: Boolean(outcomes.judge),
      hallucination: Boolean(outcomes.hallucination),
    },
    missingRequiredEngines: engineGate.missingBlocking,
    warnings,
    errors,
  };
}


// Test-only visibility. agentOcr/agentEntities are otherwise module-private;
// exported under this name so regression tests can exercise the real
// implementation directly (with a fake db) instead of re-deriving the logic
// inline, without expanding the public API surface of this server module.
export { agentOcr as __test__agentOcr, agentEntities as __test__agentEntities };

