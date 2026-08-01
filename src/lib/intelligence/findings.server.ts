// Server-only helpers for the unified findings store.
//
// -----------------------------------------------------------------------------
// TRUST CONTRACT — all write paths into `case_findings` MUST be gated.
// -----------------------------------------------------------------------------
// Every insert eventually flows through `addFindings`, which runs
// `validateFindingsForCase` (evidence-existence + civil/criminal firewall +
// discovery-violation-requires-quote). Callers that produce LLM-derived items
// MUST additionally route through `addGatedFindings`, which layers the
// mode-aware `applyEvidenceGate` on top so that:
//   strict      → only DIRECT_EVIDENCE
//   balanced    → DIRECT_EVIDENCE + EVIDENCE_BASED_INFERENCE
//   exploratory → all, but AI_THEORY labeled
//
// Known write-path inventory (grep `.from("case_findings").insert` /
// `addFindings(` / `addGatedFindings(` to re-audit):
//   src/lib/pipeline.server.ts:750         analyzers          → addGatedFindings
//   src/lib/pipeline.server.ts:991         work-product feed  → addGatedFindings
//   src/lib/intelligence/litigation.server.ts:387  promoted   → addGatedFindings
//   src/lib/intelligence/engines.server.ts:184     theory     → addFindings (pre-gated at engine)
//   src/lib/intelligence/engines.server.ts:338     opportunity→ addFindings (pre-gated at engine)
//   src/lib/intelligence/engines.server.ts:441     discovery  → addGatedFindings(exemptCitation)
//   src/lib/intelligence/engines.server.ts:579     witness    → addFindings (pre-gated at engine)
//   src/lib/intelligence/engines.server.ts:733     trial      → addGatedFindings(exemptCitation)
//   src/lib/intelligence/procedural-compliance.server.ts  missing-checklist → addGatedFindings(exemptCitation)
//
// If you add a new engine that writes findings, add it here and route through
// `addGatedFindings` (with `exemptCitation` only for absence-of-evidence
// findings that cannot carry a quote by design).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { Finding, NewFinding, Severity, AffectedParty } from "./types";
import { deriveConfidenceDimensions, deriveRationale } from "./confidence-dimensions";
import {
  applyEvidenceGate,
  getAnalysisMode,
  getLockedCaseType,
  isCivilCaseType,
  evidenceDependenciesSatisfied,
  stripOmisionProbatoriaForCivil,
  type AnalysisMode,
  type EvidenceItem,
} from "./evidence-gate.server";
import { buildGroundingCorpus, type GroundingCorpus } from "./grounding.server";
import { mergeConfidence } from "./canonical-id";
import { PROJECTION_LIKE } from "@/lib/intelligence/finding-selection";

type Db = SupabaseClient<Database>;
type J = import("@/integrations/supabase/types").Json;

export type GateCorpusAudit = {
  [key: string]: unknown;
  source: string;
  doc_count: number;
  document_ids: string[];
  filenames: string[];
  page_counts: number[];
  text_chars: number;
  page_chars: number | null;
  prompt_source?: string;
  prompt_text_chars?: number;
  same_document_set_as_generation?: boolean;
  same_text_as_generation?: boolean;
};

function describeCorpus(
  corpus: GroundingCorpus,
  opts?: {
    source?: string;
    pageChars?: number | null;
    promptSource?: string;
    promptTextChars?: number;
    sameDocumentSetAsGeneration?: boolean;
    sameTextAsGeneration?: boolean;
  },
): GateCorpusAudit {
  return {
    source: opts?.source ?? "documents.extracted_text",
    doc_count: corpus.docs.length,
    document_ids: corpus.docs.map((d) => d.document_id),
    filenames: corpus.docs.map((d) => d.filename),
    page_counts: corpus.docs.map((d) => d.pages.length),
    text_chars: corpus.text.length,
    page_chars: opts?.pageChars ?? 3000,
    ...(opts?.promptSource ? { prompt_source: opts.promptSource } : {}),
    ...(opts?.promptTextChars != null ? { prompt_text_chars: opts.promptTextChars } : {}),
    ...(opts?.sameDocumentSetAsGeneration != null
      ? { same_document_set_as_generation: opts.sameDocumentSetAsGeneration }
      : {}),
    ...(opts?.sameTextAsGeneration != null
      ? { same_text_as_generation: opts.sameTextAsGeneration }
      : {}),
  };
}

function normSeverity(s: unknown): Severity {
  const v = String(s ?? "medium").toLowerCase();
  if (v === "critical" || v === "high" || v === "medium" || v === "low" || v === "info") return v;
  return "medium";
}
function normParty(s: unknown): AffectedParty | null {
  const v = String(s ?? "").toLowerCase();
  if (v === "defense" || v === "prosecution" || v === "both" || v === "neutral") return v;
  return null;
}
function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0.5;
  if (v > 1 && v <= 100) return Math.max(0, Math.min(1, v / 100));
  return Math.max(0, Math.min(1, v));
}

const VALID_FINDING_TYPES = new Set(["DIRECT_EVIDENCE", "EVIDENCE_BASED_INFERENCE", "AI_THEORY"]);

function normalizeFindingType(
  value: unknown,
  hasCompleteCitation: boolean,
): "DIRECT_EVIDENCE" | "EVIDENCE_BASED_INFERENCE" | "AI_THEORY" {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const mapped =
    raw === "DIRECT" || raw === "EVIDENCE" || raw === "FACT" || raw === "FACTUAL"
      ? "DIRECT_EVIDENCE"
      : raw === "INFERENCE" || raw === "EVIDENCE_INFERENCE" || raw === "INFERRED"
        ? "EVIDENCE_BASED_INFERENCE"
        : raw === "THEORY" || raw === "AI" || raw === "SPECULATION"
          ? "AI_THEORY"
          : raw;
  if (VALID_FINDING_TYPES.has(mapped)) {
    return mapped as "DIRECT_EVIDENCE" | "EVIDENCE_BASED_INFERENCE" | "AI_THEORY";
  }
  return hasCompleteCitation ? "EVIDENCE_BASED_INFERENCE" : "AI_THEORY";
}

async function buildCaseCorpus(db: Db, caseId: string): Promise<GroundingCorpus> {
  const { data: docs } = await db
    .from("documents")
    .select("id,filename,extracted_text,status")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });
  const extracted = (docs ?? []).filter((d) => d.status === "extracted");
  return buildGroundingCorpus(
    extracted.map((d) => ({
      id: d.id as string,
      filename: d.filename,
      extracted_text: d.extracted_text,
    })),
  );
}

// ===========================================================================
// GLOBAL EVIDENCE EXISTENCE VALIDATOR
// Runs on EVERY finding at the single point of insertion. Enforces:
//   - Citation / source-quote presence
//   - Underlying evidence categories actually exist in the corpus
//   - Civil cases reject criminal terminology (Brady / Miranda / suppression /
//     prosecution / etc.) — pure-Brady items dropped, mentions scrubbed
//   - "Discovery violation" / "spoliation" / "failure to disclose" wording
//     requires a verified source quote — otherwise downgraded to a neutral
//     "not found in uploaded documents" note
// ===========================================================================

const VIOLATION_CLAIM =
  /\b(discovery (violation|abuse|misconduct|sanction)|spoliation|failure to (disclose|produce)|brady (violation|material))\b/i;

// Tautology / trivial-content patterns. A finding that says nothing more than
// "the document exists" / "a document was uploaded" / "there is a case file"
// contributes no legal analysis and is suppressed here. Substantive findings
// (specific facts, names, dates, dollar amounts, quotes) never match.
const TAUTOLOGY_PATTERNS: RegExp[] = [
  /^\s*(the\s+)?document(s)?\s+(exist|exists|was\s+(uploaded|provided|received|submitted))/i,
  /^\s*(a|the)\s+(case\s+)?file\s+(exists|was\s+(created|opened|uploaded))/i,
  /^\s*(there\s+is|there\s+are)\s+(a\s+)?document(s)?/i,
  /^\s*(no\s+additional|no\s+further)\s+(findings|information)/i,
  /^\s*document\s+(available|present|on\s+file)/i,
];

// Substantive-content detector — proper nouns, dates, dollar amounts, section
// citations, or any inline `[DOC N p.M]` pinpoint. Used as an escape hatch:
// a finding that reads substantive is never treated as tautological even if
// its title happens to look generic.
const SUBSTANTIVE_SIGNAL =
  /(\$\s?\d|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(19|20)\d{2}\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b|\b[A-Z][a-z]+\s+[A-Z][a-z]+\b|§\s?\d+|\bDOC\s+\d+\b)/;

function isTautology(r: NewFinding): boolean {
  const title = String(r.title ?? "").trim();
  const desc = String(r.description ?? "").trim();
  const blob = `${title}\n${desc}`;
  if (SUBSTANTIVE_SIGNAL.test(blob)) return false;
  // Very short combined content with no substantive signal = trivial.
  if (blob.length < 40) return true;
  for (const rx of TAUTOLOGY_PATTERNS) {
    if (rx.test(title) || rx.test(desc)) return true;
  }
  return false;
}

type RejectionReason =
  | "no_supporting_evidence_in_corpus"
  | "criminal_terminology_in_civil_case"
  | "violation_claim_without_proof"
  | "missing_citation_for_strict_claim"
  | "tautology_or_trivial";

export type ValidationAudit = {
  input: number;
  accepted: number;
  rejected: number;
  rejections: Array<{ title: string; reason: RejectionReason; detail?: string }>;
};

async function validateFindingsForCase(
  db: Db,
  caseId: string,
  rows: NewFinding[],
): Promise<{ kept: NewFinding[]; audit: ValidationAudit }> {
  const audit: ValidationAudit = { input: rows.length, accepted: 0, rejected: 0, rejections: [] };
  if (rows.length === 0) return { kept: [], audit };
  const [corpus, caseType] = await Promise.all([
    buildCaseCorpus(db, caseId),
    getLockedCaseType(db, caseId),
  ]);
  const corpusFlat = corpus.docs.map((d) => d.pages.join("\n")).join("\n");
  const civil = isCivilCaseType(caseType);
  const kept: NewFinding[] = [];
  for (const r of rows) {
    const blob = `${r.title ?? ""} ${r.description ?? ""} ${r.legal_significance ?? ""}`;

    // Layer 0 — Tautology filter. Trivial findings ("the document exists",
    // "there are documents", "no additional findings") add no legal value
    // and are always suppressed regardless of confidence or citation.
    if (isTautology(r)) {
      audit.rejections.push({ title: r.title, reason: "tautology_or_trivial" });
      audit.rejected += 1;
      continue;
    }

    // Layer 5 — Civil/Criminal firewall: strip Brady-style criminal language.
    const stripped = stripOmisionProbatoriaForCivil(r, caseType);
    if (!stripped) {
      audit.rejections.push({ title: r.title, reason: "criminal_terminology_in_civil_case" });
      audit.rejected += 1;
      continue;
    }

    // Rescue signals — a finding survives evidence-dependency suppression if
    // it has a valid citation, is highly confident (>= 0.6), or contains
    // substantive detail (proper nouns, dates, dollar amounts, section
    // pinpoints). These match the recalibrated over-suppression policy:
    // suppress ONLY on missing citation, exact duplicate, or tautology.
    const evRefs = (stripped.evidence_refs ?? []) as Array<{
      quote?: string;
      doc_id?: string;
      document_id?: string;
    }>;

    const hasCitation =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      !!(stripped as any).source_quote ||
      evRefs.some(
        (e) =>
          (typeof e.quote === "string" && e.quote.trim().length > 0) ||
          typeof (e.document_id ?? e.doc_id) === "string",
      );
    const highConfidence = typeof stripped.confidence === "number" && stripped.confidence >= 0.6;
    const substantive = SUBSTANTIVE_SIGNAL.test(`${stripped.title}\n${stripped.description}`);
    const rescueEligible = hasCitation || highConfidence || substantive;

    // Layer 1/3 — Evidence-existence: every evidence-category the finding
    // depends on must actually appear in the corpus. Discovery-gap items
    // (which intentionally surface absence of documents) are exempt.
    // Rescue: if the finding is grounded/high-confidence/substantive, keep it
    // even when the dependency heuristic can't confirm a matching category —
    // the heuristic is coarse and was the main source of over-suppression.
    const isDiscoveryGap = String(stripped.source_module ?? "").startsWith(
      "engine:discovery:missing",
    );
    if (!isDiscoveryGap) {
      const dep = evidenceDependenciesSatisfied(blob, corpusFlat);
      if (!dep.ok && !rescueEligible) {
        audit.rejections.push({
          title: stripped.title,
          reason: "no_supporting_evidence_in_corpus",
          detail: `missing: ${dep.missing.join(", ")}`,
        });
        audit.rejected += 1;
        continue;
      }
    }

    // Layer 4 — Discovery-violation protection. Claims of violation,
    // spoliation, or failure-to-produce require a verifiable source quote
    // proving the violation. Otherwise reject. (No rescue: legal-correctness
    // filter — an unsourced violation claim is defamatory and never allowed.)
    if (VIOLATION_CLAIM.test(blob)) {
      const ev = (stripped.evidence_refs ?? []) as Array<{ quote?: string }>;

      const hasQuote =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        !!(stripped as any).source_quote ||
        ev.some((e) => typeof e.quote === "string" && e.quote.trim().length > 0);
      if (!hasQuote) {
        audit.rejections.push({ title: stripped.title, reason: "violation_claim_without_proof" });
        audit.rejected += 1;
        continue;
      }
      // Civil cases never allow Brady-violation claims regardless.
      if (civil && /\bbrady\b/i.test(blob)) {
        audit.rejections.push({
          title: stripped.title,
          reason: "criminal_terminology_in_civil_case",
        });
        audit.rejected += 1;
        continue;
      }
    }

    kept.push(stripped);
    audit.accepted += 1;
  }
  if (audit.rejected > 0) {
    console.warn(
      `[evidence-validator] case=${caseId} accepted=${audit.accepted}/${audit.input} rejected=${audit.rejected}`,
      audit.rejections.slice(0, 10),
    );
  }
  recordFindingsAudit(caseId, audit);
  return { kept, audit };
}

// ---------------------------------------------------------------------------
// Per-run findings audit accumulator.
// The pipeline runs as a single server handler; this map aggregates every
// validator call for a case within that handler so the report stage can emit
// a "Findings Summary" (total generated / verified / suppressed / reasons).
// ---------------------------------------------------------------------------
export type FindingsAuditSummary = {
  total_generated: number;
  displayed: number;
  suppressed: number;
  duplicates_merged: number;
  suppression_reasons: Record<RejectionReason | "duplicate", number>;
};

const _findingsAudit = new Map<string, FindingsAuditSummary>();

function emptySummary(): FindingsAuditSummary {
  return {
    total_generated: 0,
    displayed: 0,
    suppressed: 0,
    duplicates_merged: 0,
    suppression_reasons: {
      no_supporting_evidence_in_corpus: 0,
      criminal_terminology_in_civil_case: 0,
      violation_claim_without_proof: 0,
      missing_citation_for_strict_claim: 0,
      tautology_or_trivial: 0,
      duplicate: 0,
    },
  };
}

function recordFindingsAudit(caseId: string, audit: ValidationAudit): void {
  const s = _findingsAudit.get(caseId) ?? emptySummary();
  s.total_generated += audit.input;
  s.displayed += audit.accepted;
  s.suppressed += audit.rejected;
  for (const r of audit.rejections) {
    s.suppression_reasons[r.reason] = (s.suppression_reasons[r.reason] ?? 0) + 1;
  }
  _findingsAudit.set(caseId, s);
}

function recordDuplicatesMerged(caseId: string, count: number): void {
  if (count <= 0) return;
  const s = _findingsAudit.get(caseId) ?? emptySummary();
  s.duplicates_merged += count;
  s.suppression_reasons.duplicate = (s.suppression_reasons.duplicate ?? 0) + count;
  s.suppressed += count;
  _findingsAudit.set(caseId, s);
}

/** Read (and preserve) the accumulated findings audit for a case. */
export function readFindingsAudit(caseId: string): FindingsAuditSummary {
  return _findingsAudit.get(caseId) ?? emptySummary();
}

/** Clear the accumulated findings audit — call at pipeline start. */
export function resetFindingsAudit(caseId: string): void {
  _findingsAudit.delete(caseId);
}

// ============================================================================
// SEMANTIC DEDUP — before insert, merge findings that share the same
// factual basis (same category + near-identical normalized title or fully
// overlapping evidence citations). Provenance of merged duplicates is
// preserved in metadata.merged_from so audit trails remain intact.
// ============================================================================
function normTitleKey(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // fold accents so Spanish-language finding titles dedupe correctly
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
}
function evidenceKeys(ev: unknown): string[] {
  if (!Array.isArray(ev)) return [];
  const out: string[] = [];
  for (const e of ev as Array<Record<string, unknown>>) {
    const q = typeof e?.quote === "string" ? e.quote.trim().toLowerCase().slice(0, 120) : "";
    const d =
      typeof e?.document_id === "string"
        ? e.document_id
        : typeof e?.doc_id === "string"
          ? e.doc_id
          : "";
    if (q || d) out.push(`${d}::${q}`);
  }
  return out;
}
function dedupSemantically(rows: NewFinding[]): NewFinding[] {
  if (rows.length <= 1) return rows;
  const groups = new Map<string, NewFinding[]>();
  for (const r of rows) {
    const cat = String(r.category ?? "misc").toLowerCase();
    const tk = normTitleKey(r.title);
    const key = `${cat}::${tk}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const out: NewFinding[] = [];
  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      out.push(arr[0]);
      continue;
    }
    // Secondary check: evidence-citation overlap. If two findings in the same
    // group share at least one evidence ref OR have empty refs (no contradiction
    // possible), merge. Otherwise treat them as distinct factual bases.
    const merged: NewFinding[] = [];
    const used = new Set<number>();
    for (let i = 0; i < arr.length; i++) {
      if (used.has(i)) continue;
      const base = arr[i];
      const baseEv = new Set(evidenceKeys(base.evidence_refs));
      const cluster: NewFinding[] = [base];
      used.add(i);
      for (let j = i + 1; j < arr.length; j++) {
        if (used.has(j)) continue;
        const otherEv = new Set(evidenceKeys(arr[j].evidence_refs));
        let overlap = false;
        for (const k of otherEv)
          if (baseEv.has(k)) {
            overlap = true;
            break;
          }
        if (overlap || (baseEv.size === 0 && otherEv.size === 0)) {
          cluster.push(arr[j]);
          used.add(j);
          for (const k of otherEv) baseEv.add(k);
        }
      }
      if (cluster.length === 1) {
        merged.push(base);
        continue;
      }
      // An existing, already-persisted row (tagged __existing_id by the
      // caller) is always the identity anchor when present — its DB row is
      // what downstream sections (Recommendations, Risks, related_finding_ids
      // elsewhere) already point to, so the merge must update that row
      // rather than spawn a fresh id. Its content (severity/confidence/
      // evidence) is still upgraded by the merge below.
      const existingAnchor = cluster.find(
        (c) => !!(c.metadata as Record<string, unknown> | undefined)?.__existing_id,
      );
      const rest = existingAnchor ? cluster.filter((c) => c !== existingAnchor) : null;
      const sortedBySeverity = [...cluster].sort(
        (a, b) =>
          (sevRank[String(a.severity ?? "info")] ?? 9) -
          (sevRank[String(b.severity ?? "info")] ?? 9),
      );
      const winner = existingAnchor ?? sortedBySeverity[0];
      const losers = existingAnchor ? (rest as NewFinding[]) : sortedBySeverity.slice(1);
      const mostSevereRank = Math.min(
        ...cluster.map((c) => sevRank[String(c.severity ?? "info")] ?? 9),
      );
      const mostSevere = (Object.keys(sevRank) as Array<keyof typeof sevRank>).find(
        (k) => sevRank[k] === mostSevereRank,
      ) as NewFinding["severity"];

      const winnerEvKeys = new Set(evidenceKeys(winner.evidence_refs));
      const newEvidence = losers
        .flatMap((l) => (l.evidence_refs ?? []) as unknown[])
        .filter((e) => {
          const k = evidenceKeys([e])[0];
          return !k || !winnerEvKeys.has(k);
        });
      const mergedRefs = [...((winner.evidence_refs ?? []) as unknown[]), ...newEvidence];
      const mergedDocIds = [
        ...new Set([
          ...(winner.source_doc_ids ?? []),
          ...losers.flatMap((l) => l.source_doc_ids ?? []),
        ]),
      ];
      const mergedConfidence = losers.reduce(
        (conf, l) => mergeConfidence(conf, Number(l.confidence), newEvidence.length > 0),
        Number(winner.confidence),
      );
      const mergedFrom = losers.map((c) => ({
        title: c.title,
        source_module: c.source_module,
        confidence: c.confidence,
        merged_at: new Date().toISOString(),
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = winner as any;
      merged.push({
        ...winner,
        severity: mostSevere,
        confidence: mergedConfidence,
        evidence_refs: mergedRefs as NewFinding["evidence_refs"],
        source_doc_ids: mergedDocIds,
        metadata: {
          ...(w.metadata ?? {}),
          merged_from: [
            ...(Array.isArray(w.metadata?.merged_from) ? w.metadata.merged_from : []),
            ...mergedFrom,
          ],
          // Only set when a real merge happened (losers.length > 0) — lets
          // the caller distinguish "existing row, unchanged" (skip) from
          // "existing row, needs a DB update" without re-deriving it.
          ...(existingAnchor && losers.length > 0 ? { __needs_existing_update: true } : {}),
        },
      });
    }
    out.push(...merged);
  }
  return out;
}

export async function addFindings(db: Db, rows: NewFinding[]) {
  if (rows.length === 0) return [];
  // Group by case_id (always one in practice) and run validation per case.
  const byCase = new Map<string, NewFinding[]>();
  for (const r of rows) {
    const arr = byCase.get(r.case_id) ?? [];
    arr.push(r);
    byCase.set(r.case_id, arr);
  }
  // Practice-area policy filter — drop any finding whose source_module is
  // forbidden for the case's active legal scope. Belt-and-braces backstop
  // even when the upstream engine was already skipped.
  const { isFindingAllowed } = await import("./practice-areas");
  const { getActiveDomains } = await import("./cross-domain.server");
  const validated: NewFinding[] = [];
  for (const [caseId, group] of byCase) {
    const { data: caseRow } = await db
      .from("cases")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("case_type" as any)
      .eq("id", caseId)
      .maybeSingle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const area = String((caseRow as any)?.case_type ?? "general_civil");
    const activeDomains = await getActiveDomains(db, caseId);
    const policyKept: NewFinding[] = [];
    let policyDropped = 0;
    for (const r of group) {
      if (isFindingAllowed(area, r.source_module, activeDomains)) policyKept.push(r);
      else policyDropped += 1;
    }
    if (policyDropped) {
      console.warn(
        `[practice-area] case=${caseId} dropped ${policyDropped}/${group.length} findings — module not allowed for area=${area}`,
      );
    }
    const { kept } = await validateFindingsForCase(db, caseId, policyKept);
    validated.push(...kept);
  }

  if (validated.length === 0) return [];

  // Semantic dedup BEFORE we persist. Also dedup against rows already in DB
  // for the same case so re-runs do not stack near-duplicate findings.
  //
  // A collision with an EXISTING, already-persisted finding is NOT just
  // suppressed — it is merged INTO that row (evidence union, citation union,
  // confidence bumped when the merge brought genuinely new corroborating
  // evidence) via an UPDATE, then the incoming duplicate is skipped. This is
  // the actual "prevent duplicate generation" contract: other tables
  // (related_finding_ids, WorkProduct.cited_finding_ids, canonical Findings)
  // already point at the existing row's id, so dedup must feed that survivor
  // rather than leave it stale while a near-identical row is inserted next
  // to it.
  const deduped: NewFinding[] = [];
  for (const [caseId, _] of byCase) {
    const groupRows = validated.filter((r) => r.case_id === caseId);
    if (groupRows.length === 0) continue;
    const { data: existing } = await db
      .from("case_findings")
      .select("id,category,title,evidence_refs,confidence,source_doc_ids,metadata")
      .eq("case_id", caseId)
      .not("source_module", "like", PROJECTION_LIKE);

    const existingShim: NewFinding[] = (existing ?? []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) =>
        ({
          case_id: caseId,
          user_id: groupRows[0].user_id,
          source_module: "existing",
          category: e.category,
          title: e.title,
          description: "",
          severity: "info",
          confidence: typeof e.confidence === "number" ? e.confidence : 0,
          source_doc_ids: e.source_doc_ids ?? [],
          evidence_refs: e.evidence_refs ?? [],
          metadata: { ...(e.metadata ?? {}), __existing_id: e.id },
        }) as unknown as NewFinding,
    );

    const all = dedupSemantically([...existingShim, ...groupRows]);

    let mergedIntoExisting = 0;
    let insertedForCase = 0;
    for (const entry of all) {
      const meta = (entry.metadata ?? {}) as Record<string, unknown>;
      const existingId = meta.__existing_id as string | undefined;
      if (existingId && meta.__needs_existing_update) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { __existing_id, __needs_existing_update, merged_from, ...restMeta } = meta as any;
        const { error } = await db
          .from("case_findings")
          .update({
            evidence_refs: entry.evidence_refs as J,
            source_doc_ids: entry.source_doc_ids ?? [],
            confidence: clamp01(entry.confidence),
            severity: normSeverity(entry.severity),
            metadata: { ...restMeta, merged_from } as J,
            updated_at: new Date().toISOString(),
          } as never)
          .eq("id", existingId);
        if (error) {
          console.error("[findings] merge-into-existing update failed", {
            caseId,
            existingId,
            error,
          });
        } else {
          mergedIntoExisting += 1;
        }
        continue;
      }
      if (existingId) {
        // Existing row, no collision with this batch — nothing to do.
        continue;
      }
      // Brand-new finding (possibly itself the merged result of 2+
      // duplicate rows within this batch) — insert exactly once.
      deduped.push(entry);
      insertedForCase += 1;
    }

    recordDuplicatesMerged(caseId, Math.max(0, groupRows.length - insertedForCase));
  }
  if (deduped.length === 0) return [];

  // Canonical ID + taxonomy governance: strict order
  //   normalize → claim_type → exact_match_id → exact dedup →
  //   canonical_finding_id → metadata merge.
  // Invalid claim types are rejected here so they never reach the registry.
  const { finalizeFindings } = await import("./canonical-id");
  const { finalized, errors: canonicalErrors, stats: canonicalStats } = finalizeFindings(deduped);
  if (canonicalErrors.length) {
    console.warn("[canonical-id] rejected findings", canonicalErrors.slice(0, 10));
  }
  if (canonicalStats.exact_collapsed || canonicalStats.canonical_merged) {
    console.log("[canonical-id] stats", canonicalStats);
  }
  if (finalized.length === 0) return [];

  const { rankAndClassify } = await import("./classify.server");
  const { getReportLocale } = await import("@/lib/mexico-lock");
  // caseId from the earlier per-case loops is out of scope here — rows are
  // always one case in practice (see comment above), so derive it from the
  // findings themselves rather than assuming a variable that no longer exists.
  const classifyCaseId = finalized[0]?.case_id;
  const classifyLocale = classifyCaseId ? await getReportLocale(db, classifyCaseId) : "es";
  // Materia-aware classification (2026-07-29): rankAndClassify now takes
  // the case's materia so it can prefer materia-specific category rules
  // (concurso mercantil, pensión alimenticia, control de convencionalidad,
  // etc.) over the universal fallback layer. Same fetch pattern as the
  // practice-area filter above — kept as a second query rather than
  // threading caseRow through, since this function's callers don't all
  // pass it and duplicating one cheap lookup is simpler than widening
  // every call site's signature.
  let classifyMateria: string | undefined;
  if (classifyCaseId) {
    const { data: classifyCaseRow } = await db
      .from("cases")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("case_type" as any)
      .eq("id", classifyCaseId)
      .maybeSingle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    classifyMateria = (classifyCaseRow as any)?.case_type ?? undefined;
  }
  const classified = rankAndClassify(finalized, classifyLocale, classifyMateria);

  // Dimension tagging — computed ONCE, here, at the single insert choke
  // point every write path funnels through (see TRUST CONTRACT header).
  // This is deliberately co-located with rankAndClassify rather than left
  // to individual engines/agents so the tag taxonomy can never drift from
  // what scoring.server.ts reads. A finding can belong to multiple
  // dimensions (e.g. a Brady finding tags both discovery_completeness and
  // procedural_integrity) — computeDimensionTags returns an array, not a
  // single category, on purpose.
  const { computeDimensionTags } = await import("./dimension-map.server");

  const payload = classified.map((r) => {
    const ev = (r.evidence_refs ?? []) as Array<{
      quote?: string;
      doc_id?: string;
      document_id?: string;
      page?: number | string;
    }>;
    const primaryQuote =
      ev.find((e) => typeof e.quote === "string" && e.quote.length > 0)?.quote ?? null;
    const primaryDocId =
      ev.find((e) => typeof (e.document_id ?? e.doc_id) === "string")?.document_id ??
      ev.find((e) => typeof e.doc_id === "string")?.doc_id ??
      r.source_doc_ids?.[0] ??
      null;
    const primaryPage = ev.find((e) => e.page !== undefined && e.page !== null)?.page ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extra = r as any;
    // -----------------------------------------------------------------
    // CITATION FLOOR — hard invariant enforced at the single persistence
    // point. Any finding claiming DIRECT_EVIDENCE must carry BOTH a
    // verbatim source_quote AND a source_document_id. If either is
    // missing, downgrade the finding_type so downstream engines and the
    // renderer cannot present it as evidentiary. This prevents an
    // upstream engine from tagging fact when the citation is incomplete.
    // -----------------------------------------------------------------
    const declaredType = extra.finding_type ?? (primaryQuote ? "DIRECT_EVIDENCE" : "AI_THEORY");
    const resolvedQuote = extra.source_quote ?? primaryQuote;
    const resolvedDocId = extra.source_document_id ?? primaryDocId;
    const resolvedPage = extra.source_page ?? primaryPage;
    const hasCompleteCitation = !!resolvedQuote && !!resolvedDocId;
    const normalizedType = normalizeFindingType(declaredType, hasCompleteCitation);
    const finding_type =
      normalizedType === "DIRECT_EVIDENCE" && !hasCompleteCitation
        ? "EVIDENCE_BASED_INFERENCE"
        : normalizedType;
    // Lift canonical identity out of metadata onto the top-level column so
    // joins/exports/audit tools can resolve findings by canonical_finding_id
    // without walking JSON. (Priority 2 fix — metadata → top-level.)
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const canonical_finding_id =
      typeof meta.canonical_finding_id === "string" ? (meta.canonical_finding_id as string) : null;
    return {
      case_id: r.case_id,
      user_id: r.user_id,
      source_module: r.source_module,
      category: r.category,
      title: r.title.slice(0, 500),
      description: r.description.slice(0, 8000),
      severity: normSeverity(r.severity),
      confidence: clamp01(r.confidence),
      confidence_dimensions: (r.confidence_dimensions ?? null) as J,
      rationale: (r.rationale ?? null) as J,
      legal_significance: r.legal_significance,
      potential_impact: r.potential_impact,
      affected_party: normParty(r.affected_party),
      source_doc_ids: r.source_doc_ids ?? [],
      evidence_refs: (r.evidence_refs ?? []) as J,
      related_finding_ids: r.related_finding_ids ?? [],
      tags: [...new Set([...(r.tags ?? []), ...computeDimensionTags(r)])],
      metadata: (r.metadata ?? {}) as J,
      finding_type,
      canonical_finding_id,
      source_document_id: resolvedDocId,
      source_page: resolvedPage,
      source_quote: resolvedQuote,
      // Neutral classification fields
      evidence_type: r.evidence_type,
      impact_direction: r.impact_direction,
      priority: r.priority,
    };
  });

  const { data, error } = await db
    .from("case_findings")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert(payload as any)
    .select("id");
  if (error) {
    console.error("addFindings failed", error);
    return [];
  }
  return data ?? [];
}

/**
 * Persist findings AFTER routing them through the evidence gate.
 * Strict: only DIRECT_EVIDENCE survives. Balanced: also EVIDENCE_BASED_INFERENCE.
 * Exploratory: all, but AI_THEORY labeled.
 */
export async function addGatedFindings(
  db: Db,
  caseId: string,
  rows: NewFinding[],
  opts?: {
    mode?: AnalysisMode;
    corpus?: GroundingCorpus;
    exemptCitation?: boolean;
    corpusAudit?: Partial<GateCorpusAudit>;
  },
): Promise<{
  inserted: number;
  audit: ReturnType<typeof applyEvidenceGate>["audit"] | null;
  mode: AnalysisMode;
  corpus: GateCorpusAudit;
}> {
  const mode = opts?.mode ?? (await getAnalysisMode(db, caseId));
  const corpus = opts?.corpus ?? (await buildCaseCorpus(db, caseId));
  const corpusAudit = {
    ...describeCorpus(corpus, {
      source: opts?.corpusAudit?.source,
      pageChars: opts?.corpusAudit?.page_chars,
      promptSource: opts?.corpusAudit?.prompt_source,
      promptTextChars: opts?.corpusAudit?.prompt_text_chars,
      sameDocumentSetAsGeneration: opts?.corpusAudit?.same_document_set_as_generation,
      sameTextAsGeneration: opts?.corpusAudit?.same_text_as_generation,
    }),
    ...(opts?.corpusAudit ?? {}),
  } as GateCorpusAudit;

  if (rows.length === 0) return { inserted: 0, audit: null, mode, corpus: corpusAudit };

  const items: EvidenceItem[] = rows.map((r) => ({
    title: r.title,
    description: r.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evidence_refs: (r.evidence_refs as any) ?? [],
    confidence: r.confidence,
  }));
  const { items: gated, audit } = applyEvidenceGate(items, { mode, corpus });

  // Build a fast lookup so we can annotate every input row (kept OR dropped)
  // by title+description, then decide inclusion based on mode + exemption.
  const gatedByKey = new Map<string, (typeof gated)[number]>();
  for (const g of gated) gatedByKey.set(`${g.title ?? ""}::${g.description ?? ""}`, g);

  const kept: NewFinding[] = [];
  for (const r of rows) {
    const g = gatedByKey.get(`${r.title}::${r.description}`);
    if (g) {
      kept.push({
        ...r,

        ...({
          finding_type: g.finding_type,
          source_document_id: g.source_document_id,
          source_page: g.source_page,
          source_quote: g.source_quote,
        } as Partial<NewFinding>),
      } as NewFinding);
    } else if (opts?.exemptCitation) {
      // Absence-of-evidence / inference-from-corpus findings that cannot
      // carry a verbatim quote by design (discovery-gap, trial risk/strength).
      // Tag them honestly as AI_THEORY so downstream renderers do not present
      // them as evidentiary — but keep them in the record.
      kept.push({
        ...r,

        ...({ finding_type: "AI_THEORY" } as Partial<NewFinding>),
      } as NewFinding);
    }
    // else: dropped by strict/balanced gate — audit already counted it.
  }
  console.info(
    `[evidence-gate] case=${caseId} mode=${mode} input=${rows.length} kept=${kept.length} audit=`,
    {
      ...audit,
      corpus: corpusAudit,
    },
  );
  await addFindings(db, kept);
  return { inserted: kept.length, audit, mode, corpus: corpusAudit };
}

export async function listFindings(db: Db, caseId: string): Promise<Finding[]> {
  const { data, error } = await db
    .from("case_findings")
    .select("*")
    .eq("case_id", caseId)
    .not("source_module", "like", PROJECTION_LIKE)
    .order("priority", { ascending: true, nullsFirst: false })
    .order("created_at");
  if (error) {
    console.error("listFindings failed", error);
    return [];
  }
  return (data ?? []) as unknown as Finding[];
}

export async function clearFindingsByModule(db: Db, caseId: string, modulePrefix: string) {
  await db
    .from("case_findings")
    .delete()
    .eq("case_id", caseId)
    .like("source_module", `${modulePrefix}%`);
}

// Normalize an LLM-returned findings array into NewFinding[]
export function normalizeLlmFindings(args: {
  caseId: string;
  userId: string;
  sourceModule: string;
  defaultCategory: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: any[];
}): NewFinding[] {
  const { caseId, userId, sourceModule, defaultCategory, items } = args;
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const i = it ?? {};
    const title = String(
      i.title ??
        i.finding ??
        i.issue ??
        i.violation ??
        i.gap ??
        i.item ??
        i.subject ??
        i.description ??
        "Untitled finding",
    ).slice(0, 400);
    const description = String(
      i.description ??
        i.detail ??
        i.why_needed ??
        i.support_text ??
        i.explanation ??
        i.rationale ??
        title,
    );
    const confidence = clamp01(i.confidence ?? 0.7);
    const evidence_refs = Array.isArray(i.support)
      ? i.support.map((s: unknown) => ({ label: typeof s === "string" ? s : JSON.stringify(s) }))
      : Array.isArray(i.evidence_refs)
        ? i.evidence_refs
        : [];
    const source_doc_ids: string[] = Array.isArray(i.source_doc_ids) ? i.source_doc_ids : [];
    return {
      case_id: caseId,
      user_id: userId,
      source_module: sourceModule,
      category: String(i.category ?? defaultCategory),
      title,
      description,
      severity: normSeverity(i.severity ?? i.priority),
      confidence,
      // Addendum §25/§23 — deterministic, zero-AI-call enrichment. See
      // confidence-dimensions.ts for why these never require a bigger or
      // additional prompt.
      confidence_dimensions: deriveConfidenceDimensions({
        raw: i,
        overallConfidence: confidence,
        evidenceRefCount: evidence_refs.length,
        sourceDocCount: source_doc_ids.length,
      }),
      rationale: deriveRationale(i, { title, description }),
      legal_significance: i.legal_significance ?? null,
      potential_impact: i.potential_impact ?? i.impact ?? null,
      affected_party: normParty(i.affected_party ?? i.benefits),
      evidence_refs,
      source_doc_ids,
      tags: Array.isArray(i.tags) ? i.tags : [],
      metadata: { raw: i },
    } satisfies NewFinding;
  });
}
