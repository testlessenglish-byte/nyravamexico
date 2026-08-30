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
//   src/lib/pipeline.server.ts (report-writer "intelligence" chunk, after
//     verifyAndLabel/enforceStructuredItems) → normalizeReportWriterFindings
//     then addGatedFindings — contradictions/constitutional_issues normally
//     gated, exemptCitation for missing_evidence/motion_opportunity/
//     strategy_recommendation/next_action/cross_examination (all advisory,
//     not factual claims). Closes the report-writer bypass identified in the
//     Canonical Reconciliation Design (2026-08-16, P0 + P2) — this chunk
//     used to write straight into reports.full_report and never reached
//     this file at all.
//
// If you add a new engine that writes findings, add it here and route through
// `addGatedFindings` (with `exemptCitation` only for absence-of-evidence
// findings that cannot carry a quote by design).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { Finding, NewFinding, Severity, AffectedParty } from "./types";
import {
  deriveConfidenceDimensions,
  deriveRationale,
  evidenceStrengthFromDimensions,
} from "./confidence-dimensions";
import { checkClaimEvidenceRelevance } from "./claim-evidence-relevance";
import { checkFindingDomainVocabulary } from "./domain-vocabulary-gate";
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
import { mergeConfidence, detectProducerConflict, type ReconciliationState } from "./canonical-id";
import { PROJECTION_LIKE } from "@/lib/intelligence/finding-selection";
import {
  PROPOSITION_TYPES,
  SPEAKER_ROLES,
  ADOPTION_STATUSES,
  AUDIT_CLASSIFICATIONS,
} from "./finding-taxonomy";
import { clusterBySameIssue } from "./finding-dedupe";
import { validateFindingClassification, validateFindingCategory } from "./finding-classification-gate";
import { normalizePenalFinding, normalizeSubstantiveLegalDomain } from "./penal-legal-normalization";

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
  const v = String(s ?? "").toLowerCase().trim();
  const validParties = new Set([
    "defense",
    "prosecution",
    "both",
    "neutral",
    "quejoso",
    "autoridad_responsable",
    "tercero_interesado",
    "ministerio_publico",
    "defensa",
    "victima",
    "ofendido",
    "actor",
    "demandado",
    "trabajador",
    "patron",
    "contribuyente",
    "autoridad_fiscal",
    "particular",
    "autoridad",
  ]);
  if (validParties.has(v)) return v as AffectedParty;
  return null;
}
// Judicial-hierarchy attribution (see judicial-hierarchy.ts). Unlike
// normSeverity/normParty, an unrecognized or absent value normalizes to
// `null`, not a guessed default — a finding the extraction pass never
// attributed must read as "not attributed", never as a fabricated
// speaker/adoption tag that would then feed the dashboard/scoring gates.
// The four normalizers below all read from finding-taxonomy.ts's shared
// enums — the SAME source every agent/analyzer prompt schema is built from
// (see judicialHierarchySchemaFragment()) — so a value the model was told is
// valid can never be rejected here, and vice versa.
const SPEAKER_ROLE_SET: ReadonlySet<string> = new Set(SPEAKER_ROLES);
const PROPOSITION_TYPE_SET: ReadonlySet<string> = new Set(PROPOSITION_TYPES);
const ADOPTION_STATUS_SET: ReadonlySet<string> = new Set(ADOPTION_STATUSES);
const AUDIT_CLASSIFICATION_SET: ReadonlySet<string> = new Set(AUDIT_CLASSIFICATIONS);

function normSpeakerRole(s: unknown): Finding["speaker_role"] {
  const v = String(s ?? "").toLowerCase();
  return SPEAKER_ROLE_SET.has(v) ? (v as NonNullable<Finding["speaker_role"]>) : null;
}
function normPropositionType(s: unknown): Finding["proposition_type"] {
  const v = String(s ?? "").toLowerCase();
  return PROPOSITION_TYPE_SET.has(v) ? (v as NonNullable<Finding["proposition_type"]>) : null;
}
function normAdoptionStatus(s: unknown): Finding["adoption_status"] {
  const v = String(s ?? "").toLowerCase();
  return ADOPTION_STATUS_SET.has(v) ? (v as NonNullable<Finding["adoption_status"]>) : null;
}
// Completed-case audit classification (case-analysis-mode.ts). Same
// never-guess convention as the three normalizers above: unrecognized or
// absent normalizes to `null`, never a fabricated classification. Uppercase
// to match the CHECK constraint and the taxonomy's own casing (VERIFIED_FACT,
// not verified_fact) — unlike the lowercase judicial-hierarchy enums above.
function normAuditClassification(s: unknown): Finding["audit_classification"] {
  const v = String(s ?? "").toUpperCase();
  return AUDIT_CLASSIFICATION_SET.has(v)
    ? (v as NonNullable<Finding["audit_classification"]>)
    : null;
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

// Source-meaning inversion guard. If a finding's own quoted evidence says
// no duty of personal notice existed, that same finding cannot convert the
// absence of personal notice into a defect, nullity, prejudice, or risk.
const PERSONAL_NOTICE_NO_DUTY = /(?:no\s+exist[ií]a(?:\s+alg[uú]n)?|no\s+(?:era|es|resultaba|fue)\s+necesari[oa]|no\s+hab[ií]a)\b[^.!?]{0,180}(?:deber|obligaci[oó]n|necesidad)?[^.!?]{0,140}notific[^.!?]{0,100}personal/i;

function isPersonalNoticeDefectClaim(r: NewFinding): boolean {
  const claim = [String(r.title ?? ""), String(r.description ?? ""), String(r.legal_significance ?? ""), String(r.potential_impact ?? ""), JSON.stringify(r.metadata ?? {})].join(" ");
  return /notific[^.!?]{0,120}personal/i.test(claim) && /(defectu|irregular|error|nulidad|invalid|afect|procedencia|desestim|debilidad|riesgo|perjuicio|garanti[cz]|asegurar|necesari[oa])/i.test(claim);
}

function isPersonalNoticeSourceInversion(r: NewFinding): boolean {
  const evidence = [String(r.source_quote ?? ""), JSON.stringify(r.evidence_refs ?? [])].join(" ");
  return PERSONAL_NOTICE_NO_DUTY.test(evidence) && isPersonalNoticeDefectClaim(r);
}

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
  | "tautology_or_trivial"
  // Canonical Reconciliation Design (2026-08-16), P3 §10 F-7 — these two
  // gates (below, near payload construction) always computed a real
  // rejection list and logged it via console.warn, but never counted it
  // into findings_summary.suppression_reasons the way every other rejection
  // reason above already does. An attorney reading the report's "Findings
  // Summary" section had no way to see that content was ever suppressed
  // here — only a server log no one reads.
  | "domain_vocabulary_violation"
  | "claim_evidence_irrelevant";

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
  const corpusDeniesPersonalNoticeDuty = PERSONAL_NOTICE_NO_DUTY.test(corpusFlat);
  const civil = isCivilCaseType(caseType);
  const kept: NewFinding[] = [];
  for (const r of rows) {
    const blob = `${r.title ?? ""} ${r.description ?? ""} ${r.legal_significance ?? ""}`;

    // Layer -1 — source meaning must agree with the generated legal claim.
    if (isPersonalNoticeSourceInversion(r) || (corpusDeniesPersonalNoticeDuty && isPersonalNoticeDefectClaim(r))) {
      audit.rejections.push({ title: String(r.title ?? ""), reason: "claim_evidence_irrelevant", detail: "verified corpus expressly negates the personal-notice duty asserted as a defect" });
      audit.rejected += 1;
      continue;
    }

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
      domain_vocabulary_violation: 0,
      claim_evidence_irrelevant: 0,
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

/** Generic counterpart to recordDuplicatesMerged for any other post-
 *  validateFindingsForCase gate that rejects findings outside the main
 *  ValidationAudit pipeline (domain-vocabulary, claim-evidence-relevance) —
 *  same "always counted, never just logged" contract as every other
 *  rejection reason. */
function recordGateRejection(caseId: string, reason: RejectionReason, count: number): void {
  if (count <= 0) return;
  const s = _findingsAudit.get(caseId) ?? emptySummary();
  s.suppression_reasons[reason] = (s.suppression_reasons[reason] ?? 0) + count;
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
// SEMANTIC DEDUP — before insert, merge findings that describe the same
// canonical legal issue (via clusterBySameIssue's title-Jaccard / cross-
// category corroboration rule), refined by evidence-citation overlap.
// Provenance of merged duplicates is preserved in metadata.merged_from so
// audit trails remain intact.
// ============================================================================
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
  // Canonical-issue clustering — shared with the report-time consolidator
  // (finding-dedupe.ts) so "same issue" means one thing everywhere in Nyrava:
  // cross-category merges require a near-identical title AND corroborating
  // evidence/description agreement (a shared citation alone is never
  // sufficient), same-category merges use title similarity. This replaces
  // the previous exact `category::first-6-words` key, which could not catch
  // two engines describing the same issue under different category labels or
  // with reworded titles — and, unlike the old key, never merges two
  // findings just because they cite the same statute.
  const groupsArr = clusterBySameIssue(rows);
  const out: NewFinding[] = [];
  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  for (const arr of groupsArr) {
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
        // A genuine cross-producer disagreement (see detectProducerConflict)
        // must ALSO force grouping even with zero evidence overlap — the
        // realistic shape of a real disagreement is exactly two producers
        // citing DIFFERENT supporting passages about the same disputed claim
        // (if they cited the identical quote, they likely wouldn't disagree
        // about it). Without this, the "distinct factual bases" heuristic
        // below — correctly protective for ordinary same-title-different-
        // facts findings — would silently prevent a real conflict from ever
        // reaching the merge step where it gets recorded.
        const conflict = detectProducerConflict(base, arr[j]);
        if (overlap || (baseEv.size === 0 && otherEv.size === 0) || conflict) {
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

      // CONFLICT DETECTION — Canonical Reconciliation Design §04. A loser
      // that a genuine different producer (see detectProducerConflict)
      // affirmatively asserts the OPPOSITE conclusion about is not a
      // duplicate to fold into merged_from ("accepted as the same fact") —
      // it's a disagreement that must stay visible. Only the FIRST detected
      // conflict is recorded in metadata.conflict (the common real shape is
      // a two-member cluster — one already-persisted finding, one fresh
      // one); any additional conflicting losers still contribute their
      // evidence but don't get a second conflict record.
      const conflictingLosers: NewFinding[] = [];
      const normalLosers: NewFinding[] = [];
      let firstConflict: ReturnType<typeof detectProducerConflict> = null;
      for (const l of losers) {
        const c = detectProducerConflict(winner, l);
        if (c) {
          conflictingLosers.push(l);
          if (!firstConflict) firstConflict = c;
        } else {
          normalLosers.push(l);
        }
      }

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
      const mergedConfidence = normalLosers.reduce(
        (conf, l) => mergeConfidence(conf, Number(l.confidence), newEvidence.length > 0),
        Number(winner.confidence),
      );
      // Only non-conflicting losers count as "the same fact restated" —
      // a conflicting loser's differing conclusion must never be folded in
      // here as if it had been accepted.
      const mergedFrom = normalLosers.map((c) => ({
        title: c.title,
        source_module: c.source_module,
        confidence: c.confidence,
        merged_at: new Date().toISOString(),
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = winner as any;
      // FIX: when the winner is an existing-row anchor, it's the minimal
      // existingShim object built below (case_id/user_id/source_module/
      // category/title/description/severity/confidence/source_doc_ids/
      // evidence_refs/metadata ONLY) — it never carries speaker_role/
      // proposition_type/adoption_status/audit_classification, so spreading
      // `...winner` alone silently discarded these from every loser too,
      // even when a loser (this run's freshly generated finding) had a real
      // value. Confirmed via a real case export: ways_out_analysis's LLM
      // output correctly included audit_classification, but the persisted
      // row stayed null because it merged into an existing-row anchor that
      // structurally couldn't carry it forward. Prefer the winner's own
      // value; otherwise take the first loser that has one — same
      // enrichment principle already applied to evidence_refs/source_doc_ids
      // above, just for these four additive fields.
      const firstWith = <K extends keyof NewFinding>(key: K): NewFinding[K] | undefined =>
        (w[key] as NewFinding[K] | undefined) ?? losers.map((l) => l[key]).find((v) => v != null);
      merged.push({
        ...winner,
        severity: mostSevere,
        confidence: mergedConfidence,
        evidence_refs: mergedRefs as NewFinding["evidence_refs"],
        source_doc_ids: mergedDocIds,
        speaker_role: firstWith("speaker_role"),
        proposition_type: firstWith("proposition_type"),
        adoption_status: firstWith("adoption_status"),
        audit_classification: firstWith("audit_classification"),
        metadata: {
          ...(w.metadata ?? {}),
          merged_from: [
            ...(Array.isArray(w.metadata?.merged_from) ? w.metadata.merged_from : []),
            ...mergedFrom,
          ],
          // Genuine cross-producer disagreement (see detectProducerConflict
          // above) — surfaced explicitly rather than silently resolved.
          // Deterministic, derived from `winner`/`firstConflict` alone, so
          // re-running this same batch (checkpoint resume, retry) recomputes
          // the identical record rather than accumulating duplicates.
          ...(firstConflict
            ? {
                reconciliation_state: "unresolved" as ReconciliationState,
                conflict: firstConflict,
              }
            : {}),
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
  const { resolveCaseIdentity } = await import("./case-classification.server");
  const validated: NewFinding[] = [];
  for (const [caseId, group] of byCase) {
    // VERIFIED CASE IDENTITY — this is a belt-and-braces BACKSTOP over
    // findings the generating engine already produced under its own
    // resolved materia; it must use the SAME precedence (verified/
    // attorney-locked/declared) as the generator, not a stricter or looser
    // one, or it will inconsistently drop findings the generator correctly
    // allowed. When nothing at all is known, pass null rather than the
    // real materia "general_civil" — isFindingAllowed(null, ...) correctly
    // degrades to the universal-only module set instead of silently
    // applying one specific materia's allow-list to an unknown case.
    const identity = await resolveCaseIdentity(db, caseId);
    const area = identity.caseType ?? null;
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
    // Judicial-hierarchy consistency gate: a "holding"/"rejected_holding"
    // proposition_type paired with a non-judicial speaker_role (a party's
    // own submission) is structurally impossible — downgrade to "argument"
    // rather than persist a party's argument as if a court had ruled on it.
    // No-op for the overwhelming majority of findings, which set neither
    // field. See finding-classification-gate.ts.
    for (const r of kept) {
      const { finding: classificationFinding, downgrades } = validateFindingClassification(r);
      if (downgrades.length > 0) {
        console.warn(`[classification-gate] case=${caseId} downgraded`, downgrades);
      }
      // Materia-vocabulary gate for `category` — same reuse-the-downgrade-
      // pattern as validateFindingClassification above, not a drop. See
      // validateFindingCategory's own doc comment in
      // finding-classification-gate.ts for why "general_finding" is the
      // fallback (matches its existing test convention): an engine-declared
      // category incompatible with this case's resolved materia is
      // relabeled to a safe, always-allowed bucket rather than corrupting
      // materia-specific report groupings under a category that doesn't
      // belong there.
      const { finding, downgrades: categoryDowngrades } = validateFindingCategory(
        classificationFinding,
        area,
        "general_finding",
        activeDomains,
      );
      if (categoryDowngrades.length > 0) {
        console.warn(`[classification-gate] case=${caseId} category downgraded`, categoryDowngrades);
      }

      // Legal-meaning boundary. This intentionally runs after generic
      // module/category validation so producer provenance cannot overwrite
      // the legal classification of a Penal proposition.
      const activePenalDomain = Array.from(activeDomains ?? []).find((domain) =>
        /penal|criminal/i.test(String(domain)),
      );
      validated.push(
        normalizePenalFinding(finding, {
          matter: area,
          underlyingMatter:
            identity.underlyingMateria ??
            (activePenalDomain ? String(activePenalDomain) : null),
        }),
      );
    }
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
      .select("id,category,title,description,evidence_refs,confidence,source_doc_ids,metadata,source_module,speaker_role,proposition_type,adoption_status,audit_classification,affected_party,benefited_party,evidence_type,impact_direction,authority_level,score_dimension,reason_for_score_effect")
      .eq("case_id", caseId)
      .not("source_module", "like", PROJECTION_LIKE);

    const existingShim: NewFinding[] = (existing ?? []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) =>
        ({
          case_id: caseId,
          user_id: groupRows[0].user_id,
          // Real producer identity (not the literal string "existing") is
          // required for detectProducerConflict's cross-producer check below
          // — an already-persisted analyzer finding colliding with a fresh
          // report-writer finding must be recognized as two DIFFERENT
          // producers, not silently exempted because the shim erased who
          // wrote it.
          source_module: e.source_module ?? "existing",
          category: e.category,
          title: e.title,
          // Real description (not "") so detectProducerConflict's polarity
          // scan has something to scan on the existing-row side too — a
          // blank description could never carry an explicit negation/
          // affirmation marker, silently disabling conflict detection for
          // every already-persisted row.
          description: e.description ?? "",
          severity: "info",
          confidence: typeof e.confidence === "number" ? e.confidence : 0,
          affected_party: e.affected_party ?? null,
          benefited_party: e.benefited_party ?? null,
          evidence_type: e.evidence_type ?? null,
          impact_direction: e.impact_direction ?? null,
          authority_level: e.authority_level ?? null,
          score_dimension: e.score_dimension ?? null,
          reason_for_score_effect: e.reason_for_score_effect ?? null,
          speaker_role: e.speaker_role ?? null,
          proposition_type: e.proposition_type ?? null,
          adoption_status: e.adoption_status ?? null,
          audit_classification: e.audit_classification ?? null,
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
            // FIX: a finding that merges into an already-persisted row (a
            // checkpoint-resumed pass, or a later batch re-deriving the same
            // canonical finding) previously had its judicial-hierarchy
            // attribution and audit_classification silently frozen at
            // whatever the FIRST insert produced — confirmed via a real
            // case export: the ways_out_analysis agent's LLM output correctly
            // included audit_classification (visible in metadata.raw), but
            // the persisted column stayed null because this UPDATE never
            // touched it, even though updated_at showed the row WAS
            // re-merged minutes after its original insert. These four
            // columns are additive/nullable (see the judicial-hierarchy and
            // case-analysis-mode migrations) so refreshing them here can
            // only improve a stale null, never regress a populated value
            // with a worse one — normXxx already guarantees `entry`'s
            // values are either a valid enum member or null.
            speaker_role: normSpeakerRole(entry.speaker_role),
            proposition_type: normPropositionType(entry.proposition_type),
            adoption_status: normAdoptionStatus(entry.adoption_status),
            audit_classification: normAuditClassification(entry.audit_classification),
            category: entry.category,
            affected_party: normParty(entry.affected_party),
            benefited_party: normParty(entry.benefited_party),
            evidence_type: entry.evidence_type ?? null,
            impact_direction: entry.impact_direction ?? null,
            authority_level: entry.authority_level ?? null,
            score_dimension: entry.score_dimension ?? null,
            reason_for_score_effect: entry.reason_for_score_effect ?? null,
            // Lifted out of metadata onto the top-level column so the
            // conflicting/unresolved state is queryable without walking
            // JSON — same "metadata → top-level" pattern already used for
            // canonical_finding_id in the INSERT path below. Only ever
            // "unresolved" today (see detectProducerConflict); null for
            // every ordinary merge, matching this column's additive default.
            reconciliation_state:
              typeof restMeta.reconciliation_state === "string"
                ? (restMeta.reconciliation_state as string)
                : null,
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
  let classifyUnderlyingMateria: string | null | undefined;
  if (classifyCaseId) {
    // VERIFIED CASE IDENTITY — same precedence as the practice-area
    // backstop above (verified/attorney-locked/declared); undefined when
    // nothing is known at all, which rankAndClassify already treats as
    // "use the universal fallback layer" rather than guessing a materia.
    const { resolveCaseIdentity: resolveClassifyIdentity } = await import(
      "./case-classification.server"
    );
    const classifyIdentity = await resolveClassifyIdentity(db, classifyCaseId);
    classifyMateria = classifyIdentity.caseType ?? undefined;
    classifyUnderlyingMateria = classifyIdentity.underlyingMateria;
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

  // CLAIM-EVIDENCE RELEVANCE GATE — closes a failure mode none of the other
  // checks in this function catch: a quote can be verbatim, verified against
  // the corpus, and still be about something else entirely, or too vacuous
  // to substantively support anything. Two real production examples (ADR
  // 4640/2017): a "la autoridad actuó dentro de su competencia" finding
  // cited a quote about congruencia y exhaustividad (off-topic); two
  // "no viola seguridad jurídica" findings cited "La respuesta a dicha
  // interrogante es negativa, como se expone a continuación" (a
  // transitional sentence, zero substantive content of its own). See
  // claim-evidence-relevance.ts for the calibration this threshold is based
  // on. A finding whose ONLY cited quote(s) fail this check had its entire
  // claimed evidentiary basis turn out to be bogus — rejected outright,
  // matching this codebase's existing "never silently insert an unsupported
  // evidentiary claim" principle (same one the citation floor below already
  // enforces for missing citations; this is the same principle for
  // irrelevant ones). A finding with SOME relevant and some irrelevant
  // citations only loses the irrelevant ones, not the whole finding.
  type EvRef = { quote?: string; doc_id?: string; document_id?: string; page?: number | string };
  const relevanceRejected: Array<{ title: string; case_id: string }> = [];
  // DOMAIN VOCABULARY GATE — a finding's own text (not its cited quotes,
  // which are checked separately) can assert an institution or procedural
  // actor that structurally does not exist in the case's materia. Real
  // example (ADR 4640/2017, a CIVIL apelación reviewed via amparo directo
  // en revisión): agent:ways_out_analysis wrote "La resolución del
  // Tribunal de Enjuiciamiento desestimó un argumento novedoso..." —
          // Tribunal de Enjuiciamiento is exclusive to accusatorial CRIMINAL
          // procedure (CNPP) and does not exist in a civil dispute; none of the
          // finding's own cited quotes even mentioned it. See
          // domain-vocabulary-gate.ts for why this is a denylist (unambiguous
          // single-materia-exclusive institution names) rather than an allowlist
          // (which would require this code to judge what's substantively
          // applicable per materia — a legal-content call this codebase
          // consistently leaves to the user's own research).
  const { data: caseDocuments } = classifyCaseId
    ? await db
        .from("documents")
        .select("id, filename, created_at")
        .eq("case_id", classifyCaseId)
        .order("created_at", { ascending: true })
    : { data: [] };
  const caseDocList = caseDocuments ?? [];
  const singleDocId = caseDocList.length === 1 ? caseDocList[0].id : null;

  const domainVocabularyRejected: Array<{
    title: string;
    case_id: string;
    violations: string[];
  }> = [];
  const payload: Array<Record<string, unknown>> = [];
  for (const r of classified) {
    const domainCheck = checkFindingDomainVocabulary(
      r,
      classifyMateria,
      classifyUnderlyingMateria,
    );
    if (!domainCheck.clean) {
      domainVocabularyRejected.push({
        title: r.title,
        case_id: r.case_id,
        violations: domainCheck.violations,
      });
      continue;
    }

    const evRaw = (r.evidence_refs ?? []) as EvRef[];
    const claimText = `${r.title ?? ""} ${r.description ?? ""}`;
    const hadAnyQuoteBeforeGate = evRaw.some(
      (e) => typeof e.quote === "string" && e.quote.length > 0,
    );
    const ev = evRaw.filter((e) => {
      if (typeof e.quote !== "string" || e.quote.length === 0) return true; // nothing to relevance-check
      return checkClaimEvidenceRelevance(claimText, e.quote).relevant;
    });
    const evHasQuote = ev.some((e) => typeof e.quote === "string" && e.quote.length > 0);
    if (hadAnyQuoteBeforeGate && !evHasQuote) {
      relevanceRejected.push({ title: r.title, case_id: r.case_id });
      continue;
    }

    const primaryQuote =
      ev.find((e) => typeof e.quote === "string" && e.quote.length > 0)?.quote ?? null;
    let primaryDocId =
      ev.find((e) => typeof (e.document_id ?? e.doc_id) === "string")?.document_id ??
      ev.find((e) => typeof e.doc_id === "string")?.doc_id ??
      r.source_doc_ids?.[0] ??
      null;

    if (!primaryDocId && caseDocList.length > 0 && primaryQuote) {
      const docNRef = ev.find((e) => (e as any).doc_n != null);
      if (docNRef && typeof (docNRef as any).doc_n === "number") {
        const idx = (docNRef as any).doc_n - 1;
        if (idx >= 0 && idx < caseDocList.length) {
          primaryDocId = caseDocList[idx].id;
        }
      }
      if (!primaryDocId) {
        primaryDocId = singleDocId ?? caseDocList[0].id;
      }
    }

    if (primaryDocId) {
      for (const e of ev) {
        if (!e.document_id && !e.doc_id) {
          e.document_id = primaryDocId;
        }
      }
    }

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

    const isHolding =
      r.proposition_type === "holding" ||
      extra.proposition_type === "holding" ||
      r.audit_classification === "VERIFIED_COURT_HOLDING" ||
      extra.audit_classification === "VERIFIED_COURT_HOLDING";

    const speaker_role = isHolding ? "scjn" : normSpeakerRole(r.speaker_role);
    const proposition_type = isHolding ? "holding" : normPropositionType(r.proposition_type);
    const adoption_status = isHolding ? "adopted" : normAdoptionStatus(r.adoption_status);
    const impact_direction = isHolding && !r.impact_direction ? "neutral" : (r.impact_direction ?? "neutral");

    // Lift canonical identity out of metadata onto the top-level column so
    // joins/exports/audit tools can resolve findings by canonical_finding_id
    // without walking JSON. (Priority 2 fix — metadata → top-level.)
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const canonical_finding_id =
      typeof meta.canonical_finding_id === "string" ? (meta.canonical_finding_id as string) : null;
    // Same lift, for the reconciliation_state finalizeFindings/
    // dedupSemantically stamp on a genuine cross-producer conflict (see
    // canonical-id.ts's detectProducerConflict). Null for every ordinary
    // row — additive column, no behavior change for the rows that don't
    // hit this path.
    const reconciliation_state =
      typeof meta.reconciliation_state === "string" ? (meta.reconciliation_state as string) : null;

    const sourceDocIds = r.source_doc_ids?.length
      ? r.source_doc_ids
      : resolvedDocId
        ? [resolvedDocId]
        : [];

    payload.push({
      case_id: r.case_id,
      user_id: r.user_id,
      source_module: r.source_module,
      category: r.category,
      title: r.title.slice(0, 500),
      description: r.description.slice(0, 8000),
      severity: normSeverity(r.severity),
      confidence: clamp01(r.confidence),
      confidence_dimensions: (r.confidence_dimensions ?? null) as J,
      // case_findings.evidence_strength — see confidence-dimensions.ts's
      // evidenceStrengthFromDimensions() for why this was always null
      // before and what it now derives from.
      evidence_strength: evidenceStrengthFromDimensions(r.confidence_dimensions ?? null),
      rationale: (r.rationale ?? null) as J,
      legal_significance: r.legal_significance,
      potential_impact: r.potential_impact,
      affected_party: normParty(r.affected_party),
      benefited_party: normParty(r.benefited_party),
      authority_level: r.authority_level ?? (isHolding ? 1 : null),
      score_dimension: r.score_dimension ?? null,
      reason_for_score_effect: r.reason_for_score_effect ?? null,
      speaker_role,
      proposition_type,
      adoption_status,
      audit_classification: isHolding ? "VERIFIED_COURT_HOLDING" : normAuditClassification(r.audit_classification),
      source_doc_ids: sourceDocIds,
      // The relevance-filtered set (`ev`), not the raw upstream one — an
      // evidence_ref this gate stripped for being irrelevant must not
      // persist in the stored array either, or the report could still
      // render it even though it no longer backs source_quote/finding_type.
      evidence_refs: ev as J,
      related_finding_ids: r.related_finding_ids ?? [],
      tags: [...new Set([...(r.tags ?? []), ...computeDimensionTags(r)])],
      metadata: {
        ...(r.metadata ?? {}),
        is_authority_exempt: isHolding,
      } as J,
      finding_type,
      // Set by addGatedFindings' path (classifyEvidenceRelationship, see
      // evidence-gate.server.ts); null for the few call sites that persist
      // findings directly through addFindings without routing through the
      // gate — never fabricated after the fact.
      evidence_relationship: (extra.evidence_relationship as string | undefined) ?? null,
      canonical_finding_id,
      reconciliation_state,
      source_document_id: resolvedDocId,
      source_page: resolvedPage,
      source_quote: resolvedQuote,
      // Neutral classification fields
      evidence_type: r.evidence_type,
      impact_direction: r.impact_direction,
      priority: r.priority,
    });
  }
  if (relevanceRejected.length > 0) {
    console.warn(
      "[findings] claim-evidence relevance gate rejected findings whose only cited quote(s) were irrelevant",
      relevanceRejected,
    );
    // P3 §10 F-7 — counted, not just logged (see recordGateRejection's doc
    // comment). Grouped by case_id since this function processes rows for
    // potentially more than one case per the TRUST CONTRACT header, even
    // though in practice callers always pass a single case's rows.
    const byCaseRelevance = new Map<string, number>();
    for (const r of relevanceRejected) byCaseRelevance.set(r.case_id, (byCaseRelevance.get(r.case_id) ?? 0) + 1);
    for (const [rejCaseId, count] of byCaseRelevance) {
      recordGateRejection(rejCaseId, "claim_evidence_irrelevant", count);
    }
  }
  if (domainVocabularyRejected.length > 0) {
    console.warn(
      "[findings] domain vocabulary gate rejected findings asserting a materia-inappropriate institution",
      domainVocabularyRejected,
    );
    const byCaseDomain = new Map<string, number>();
    for (const r of domainVocabularyRejected) byCaseDomain.set(r.case_id, (byCaseDomain.get(r.case_id) ?? 0) + 1);
    for (const [rejCaseId, count] of byCaseDomain) {
      recordGateRejection(rejCaseId, "domain_vocabulary_violation", count);
    }
  }
  if (payload.length === 0) return [];

  const { data, error } = await db
    .from("case_findings")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert(payload as any)
    .select("id");
  if (error) {
    console.error("addFindings failed", error);
    // Schema-drift resilience: speaker_role/proposition_type/adoption_status
    // (migration 20260808201119_finding_judicial_attribution.sql),
    // audit_classification (migration 20260809041757_case_analysis_mode.sql),
    // and evidence_relationship (migration
    // 20260814150000_case_findings_evidence_relationship.sql — the newest of
    // the five, added days after the other four) are additive columns that
    // may not have propagated to every environment yet, independently of one
    // another. A batch INSERT referencing a column Postgres doesn't
    // recognize fails ATOMICALLY for the whole batch.
    //
    // BUG FIXED (confirmed via a real, just-generated case export): the
    // original fallback here stripped all five columns together on ANY
    // insert error, so an environment where only evidence_relationship's
    // migration hadn't landed yet — the other four already had — still lost
    // speaker_role/proposition_type/adoption_status/audit_classification on
    // every finding, even though those columns existed and would have
    // inserted fine on their own. 5 of 6 judicial-hierarchy-eligible
    // findings on that case came back with audit_classification: null at
    // the persisted top level despite the LLM having correctly classified
    // them (visible in metadata.raw) — exactly this collateral-strip bug.
    // The unknown-column error names the specific column, in one of two
    // observed shapes: Postgrest's wrapped "Could not find the '<col>'
    // column of '<table>' in the schema cache" (see
    // updateCaseWithSchemaDriftRetry in cases.functions.ts for the same
    // shape on a different table), or a raw Postgres 42703 error, `column
    // "<col>" of relation "<table>" does not exist`. Parse either and strip
    // ONLY that one column when identifiable, so sibling columns from
    // already-applied migrations are never collaterally dropped. Falls back
    // to the full known-optional bundle when the error doesn't name a
    // column in that set (e.g. a different kind of failure entirely).
    const OPTIONAL_COLUMNS = [
      "speaker_role",
      "proposition_type",
      "adoption_status",
      "audit_classification",
      "evidence_relationship",
      "reconciliation_state",
      // Penal legal-semantics migration (20260826090000). These are
      // additive. A backend whose schema cache/deployment is briefly behind
      // must not atomically lose the entire verified-finding batch because
      // one of these columns has not propagated yet.
      "benefited_party",
      "authority_level",
      "score_dimension",
      "reason_for_score_effect",
    ] as const;
    const unknownColumn =
      /Could not find the '([^']+)' column/.exec(error.message ?? "")?.[1] ??
      /column "([^"]+)" of relation "[^"]+" does not exist/.exec(error.message ?? "")?.[1];
    const columnsToStrip: readonly string[] =
      unknownColumn && (OPTIONAL_COLUMNS as readonly string[]).includes(unknownColumn)
        ? [unknownColumn]
        : OPTIONAL_COLUMNS;
    const stripColumns = (columns: readonly string[]) =>
      (payload as Array<Record<string, unknown>>).map((row) => {
        const rest = { ...row };
        for (const c of columns) delete rest[c];
        return rest;
      });

    const retry = await db
      .from("case_findings")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(stripColumns(columnsToStrip) as any)
      .select("id");
    if (!retry.error) {
      console.error(
        `addFindings: recovered by inserting without ${columnsToStrip.join(", ")} — a pending migration needs to be applied to this environment`,
        { originalError: error },
      );
      return retry.data ?? [];
    }
    // The targeted single-column strip wasn't enough (or we couldn't
    // identify a specific column) — fall back to stripping the full
    // known-optional bundle as a last resort, same as the original
    // behavior, before giving up entirely.
    if (columnsToStrip.length < OPTIONAL_COLUMNS.length) {
      const bundleRetry = await db
        .from("case_findings")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert(stripColumns(OPTIONAL_COLUMNS) as any)
        .select("id");
      if (!bundleRetry.error) {
        console.error(
          `addFindings: recovered by inserting without ${OPTIONAL_COLUMNS.join(", ")} — more than one pending migration needs to be applied to this environment`,
          { originalError: error, singleColumnRetryError: retry.error },
        );
        return bundleRetry.data ?? [];
      }
      console.error("addFindings bundle retry (without all optional columns) also failed", bundleRetry.error);
      throw new Error(
        `case_findings persistence failed after schema-drift retry: ${bundleRetry.error.message}`,
      );
    }
    console.error(
      "addFindings retry (without judicial-hierarchy/audit-classification columns) also failed",
      retry.error,
    );
    throw new Error(
      `case_findings persistence failed after schema-drift retry: ${retry.error.message}`,
    );
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
    audit_classification: r.audit_classification,
    speaker_role: r.speaker_role,
    proposition_type: r.proposition_type,
    adoption_status: r.adoption_status,
  }));
  const { items: gated, audit } = applyEvidenceGate(items, { mode, corpus });

  // Build a fast lookup so we can annotate every input row (kept OR dropped)
  // by title+description, then decide inclusion based on mode + exemption.
  const gatedByKey = new Map<string, (typeof gated)[number]>();
  for (const g of gated) gatedByKey.set(`${g.title ?? ""}::${g.description ?? ""}`, g);

  const kept: NewFinding[] = [];
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const exemptionType = meta.citation_exemption_type as string | undefined;
    const g = gatedByKey.get(`${r.title ?? ""}::${r.description ?? ""}`);

    if (g) {
      kept.push({
        ...r,

        ...({
          finding_type: g.finding_type,
          evidence_relationship: g.evidence_relationship,
          source_document_id: g.source_document_id,
          source_page: g.source_page,
          source_quote: g.source_quote,
          // Applied here, AFTER the title::description lookup above has
          // already matched this gate result back to its input row — see
          // GatedItem.not_established_rewrite's doc comment for why this
          // can't happen inside diagnoseEvidenceGate itself.
          ...(g.not_established_rewrite
            ? {
                title: g.not_established_rewrite.title,
                description: g.not_established_rewrite.description,
              }
            : {}),
        } as Partial<NewFinding>),
      } as NewFinding);
    } else if (
      opts?.exemptCitation ||
      exemptionType === "EXEMPT_METADATA" ||
      exemptionType === "EXEMPT_STATUTORY_FORMULA"
    ) {
      // Absence-of-evidence / inference-from-corpus / explicit authority-exempt findings.
      // Tag them honestly so downstream renderers understand their audit status.
      kept.push({
        ...r,

        ...({
          finding_type:
            exemptionType === "EXEMPT_METADATA" || exemptionType === "EXEMPT_STATUTORY_FORMULA"
              ? "DIRECT_EVIDENCE"
              : "AI_THEORY",
          metadata: {
            ...meta,
            citation_audit_exemption: exemptionType ?? "general_citation_exempt",
          },
        } as Partial<NewFinding>),
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
  const inserted = await addFindings(db, kept);
  return { inserted: inserted.length, audit, mode, corpus: corpusAudit };
}

export async function listFindings(db: Db, caseId: string): Promise<Finding[]> {
  // Excludes superseded findings by default — this is THE single choke
  // point the report, dashboard, and scoring all read findings through, so
  // filtering here (rather than at each of the ~40 other call sites in the
  // codebase that query case_findings directly) is what makes a Talk-to-Case
  // supersession actually disappear from what matters most: the generated
  // report. See case-state-reconciliation.server.ts, which sets
  // superseded_at. Retries without the filter on schema drift (migration
  // 20260809150000_finding_supersession.sql not yet applied to this
  // environment) — same resilience pattern as addFindings()'s retry.
  const base = () =>
    db
      .from("case_findings")
      .select("*")
      .eq("case_id", caseId)
      .not("source_module", "like", PROJECTION_LIKE)
      .order("priority", { ascending: true, nullsFirst: false })
      .order("created_at");
  let { data, error } = await base().is("superseded_at", null);
  if (error) {
    console.warn(
      "listFindings: superseded_at filter failed (schema drift?), retrying without it",
      error,
    );
    ({ data, error } = await base());
  }
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

// ---------------------------------------------------------------------------
// Corpus-bounded absence language — deterministic backstop, not prompt-only.
//
// An LLM-generated "absence" finding (no keyword match for something it
// searched for) tends to phrase itself as a definitive negative — "No se
// encontró X" / "No evidence was found of X" — which reads as a factual
// conclusion about the real world ("X did not happen") rather than what it
// actually is: a statement about what the UPLOADED documents establish
// ("X was not identified in the reviewed corpus"). Confirmed on a real
// completed-case audit export (ways_out_analysis): findings literally
// titled "No se encontró referencia a la presentación de alegatos
// adicionales..." — definitive language the corpus alone cannot support,
// since a single-document or partial expediente never proves an event never
// occurred, only that it wasn't found in what was reviewed. Rewrites the
// LEADING clause only, preserving the rest of the sentence, so this stays a
// narrow, targeted fix rather than a blanket rewrite of finding text.
// ---------------------------------------------------------------------------
// NOTE on the trailing `(?=[\s.,;:!?]|$)` lookaheads below (audit P0-2): they
// replace what used to be a trailing `\b`. JS's `\b` is defined relative to
// `\w` ([A-Za-z0-9_]), and accented vowels are NOT `\w` characters, so
// `\b` immediately after an accented match char (e.g. the "ó" in
// "encontró") never fires — both neighboring positions read as "non-word",
// so there is no word/non-word transition for `\b` to anchor on. That made
// every rewrite below silently no-op on the correctly-accented Spanish verb
// form (encontró/localizó/advirtió) and only ever fire on the misspelled,
// unaccented form (encontro/localizo/advirtio) — i.e. on real corpus text,
// never. A lookahead for whitespace/punctuation/end-of-string is
// unicode-safe and still refuses to match mid-word (e.g. "encontrológico").
const ABSENCE_LANGUAGE_REWRITES: Array<[RegExp, string]> = [
  [/^No se encontr[oó](?=[\s.,;:!?]|$)/i, "No se identificó en el corpus/documentos analizados"],
  [/^No se localiz[oó](?=[\s.,;:!?]|$)/i, "No se identificó en el corpus/documentos analizados"],
  [/^No se advirti[oó](?=[\s.,;:!?]|$)/i, "No se identificó en el corpus/documentos analizados"],
  [/^No existe\b/i, "No se identificó en el corpus/documentos analizados evidencia de que exista"],
  [/^No hay evidencia de\b/i, "No se identificó en el corpus/documentos analizados evidencia de"],
  [/^No evidence (?:was )?found of\b/i, "The corpus/documents reviewed do not identify"],
  [/^There is no evidence of\b/i, "The corpus/documents reviewed do not identify evidence of"],
  [
    /^No reference (?:was |is )?found\b/i,
    "The corpus/documents reviewed do not identify a reference",
  ],
];

export function enforceCorpusBoundedAbsenceLanguage(text: string): string {
  if (!text) return text;
  for (const [pattern, replacement] of ABSENCE_LANGUAGE_REWRITES) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Deterministic source gate for PROCEDURAL RECOMMENDATIONS, not just factual
// claims — extends the same "never trust a claim you can't independently
// verify" discipline (evidence-provenance.server.ts, completed-case-audit's
// enforceStatementSource/enforceLawSource) to ways_out_analysis's remedy
// proposals. A remedy recommendation needs BOTH a verified case fact (the
// existing evidence_refs/citation floor already requires this) AND a
// verified applicable Mexican legal authority — confirmed missing on a real
// case export: a "podría justificar la interposición de un incidente de
// suspensión" finding shipped with an empty legal_authority field. Any
// ways_out_analysis row proposing a concrete remedy (remedy_type set) without
// a real legal_authority string is force-downgraded to EVIDENCE_GAP — it can
// never be presented as an available route on citation alone.
// ---------------------------------------------------------------------------
const TRIVIAL_LEGAL_AUTHORITY = new Set([
  "",
  "n/a",
  "na",
  "ninguna",
  "ninguno",
  "none",
  "unknown",
  "desconocido",
  "desconocida",
  "por determinar",
  "tbd",
]);

/**
 * Five-state result of trying to independently verify a proposed remedy's
 * legal_authority string, replacing the previous binary "non-empty string
 * present or not" check:
 *   AUTHORITY_MISSING     — empty/placeholder string (unchanged from before).
 *   AUTHORITY_PRESENT     — a real-looking string, but no parseable article
 *                           citation was found in it (extractCitationsFromText
 *                           found nothing) — cannot attempt verification.
 *   AUTHORITY_VERIFIED    — a citation was extracted AND matched a statute +
 *                           article in the legal-source corpus, with no
 *                           jurisdiction/temporal red flag.
 *   AUTHORITY_NOT_VERIFIED — a citation was extracted but the corpus lookup
 *                           found no match. Per citation-verification.server.ts's
 *                           own contract this very often means "not ingested
 *                           yet," not "wrong" — never downgraded on this
 *                           alone.
 *   AUTHORITY_INAPPLICABLE — the citation WAS matched in the corpus, but is
 *                           flagged wrong-jurisdiction or not-in-force for
 *                           this case — the strongest, only-if-detected
 *                           signal that a real citation is nonetheless the
 *                           wrong authority.
 */
export type RemedyAuthorityStatus =
  | "AUTHORITY_MISSING"
  | "AUTHORITY_PRESENT"
  | "AUTHORITY_VERIFIED"
  | "AUTHORITY_NOT_VERIFIED"
  | "AUTHORITY_INAPPLICABLE";

async function classifyRemedyAuthority(
  db: Db,
  legalAuthority: string,
  // The case's relevant date for temporal validity — same fallback
  // (cases.created_at) completed-case-audit.server.ts already uses for the
  // identical verifyStatutoryCitation call. Without SOME date,
  // authorityValidity() always returns reason "unknown_date" (see
  // legal-validity.ts), so temporal_status can never resolve to "in_force"
  // and AUTHORITY_VERIFIED/AUTHORITY_INAPPLICABLE would be unreachable.
  caseDate: string | null,
): Promise<RemedyAuthorityStatus> {
  if (legalAuthority.length <= 10 || TRIVIAL_LEGAL_AUTHORITY.has(legalAuthority.toLowerCase())) {
    return "AUTHORITY_MISSING";
  }
  const { extractCitationsFromText } = await import("@/lib/legal-connectors/citation-extract");
  const { verifyStatutoryCitation } = await import("@/lib/legal/citation-verification.server");
  const citations = extractCitationsFromText(legalAuthority);
  // citedAuthorityHint is only ever set alongside an "Art. <n> de <hint>"
  // citationText (see extractCitationsFromText), so re-extracting the article
  // number from that same string is always safe when this hint is present.
  const withArticle = citations.find((c) => c.citedAuthorityHint);
  const articleNumber = withArticle
    ? /^Art\.\s+(\S+)\s+de\s+/u.exec(withArticle.citationText)?.[1]
    : undefined;
  if (!withArticle || !articleNumber) return "AUTHORITY_PRESENT";
  const verification = await verifyStatutoryCitation(db, {
    authorityHint: withArticle.citedAuthorityHint!,
    articleNumber,
    caseDate,
  });
  // Checked BEFORE `status`, not after: verifyStatutoryCitation's own status
  // only reaches "VERIFIED" once jurisdiction/temporal checks already pass
  // (see its sourceConfirmed && temporalOk && jurisdictionOk && quoteOk
  // gate), so a wrong-jurisdiction or expired/not-yet-in-force match always
  // reports status "UNVERIFIED" — gating this check behind
  // `status === "VERIFIED"` would make it unreachable and collapse
  // AUTHORITY_INAPPLICABLE into AUTHORITY_NOT_VERIFIED.
  const wrongJurisdiction = verification.jurisdiction_match === false;
  const notInForce =
    verification.temporal_status === "expired" ||
    verification.temporal_status === "not_yet_in_force";
  if (wrongJurisdiction || notInForce) return "AUTHORITY_INAPPLICABLE";
  if (verification.status === "VERIFIED") return "AUTHORITY_VERIFIED";
  return "AUTHORITY_NOT_VERIFIED";
}

export async function enforceRemedyLegalAuthorityGate(
  db: Db,
  rows: NewFinding[],
  locale: "es" | "en" = "es",
): Promise<NewFinding[]> {
  const caveat =
    locale === "en"
      ? " [REQUIRES VERIFICATION: no legal authority applicable to this specific procedural stage was cited or verified for this proposed remedy.]"
      : " [REQUIERE VERIFICACIÓN: no se citó ni verificó la autoridad legal aplicable a esta etapa procesal específica para este remedio propuesto.]";
  // Fetched at most once per distinct case_id, and only when a row actually
  // needs verification — most calls (no ways_out_analysis rows, or rows
  // without a remedy) never touch the DB here at all.
  const caseDateCache = new Map<string, Promise<string | null>>();
  const getCaseDate = (caseId: string): Promise<string | null> => {
    const cached = caseDateCache.get(caseId);
    if (cached) return cached;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: Promise<string | null> = Promise.resolve(
      (db as any).from("cases").select("created_at").eq("id", caseId).maybeSingle(),
    ).then((res: { data: { created_at?: string } | null }) => res.data?.created_at ?? null);
    caseDateCache.set(caseId, p);
    return p;
  };
  return Promise.all(
    rows.map(async (r) => {
      if (!String(r.source_module ?? "").includes("ways_out_analysis")) return r;
      const raw = (r.metadata as Record<string, unknown> | undefined)?.raw as
        | Record<string, unknown>
        | undefined;
      const remedyType = typeof raw?.remedy_type === "string" ? raw.remedy_type.trim() : "";
      // Only rows that actually propose a remedy avenue need this gate —
      // EVIDENCE_GAP/NOT_FOUND rows already honestly express absence.
      if (!remedyType) return r;
      if (r.audit_classification === "EVIDENCE_GAP" || r.audit_classification === "NOT_FOUND") {
        return r;
      }
      const legalAuthority =
        typeof raw?.legal_authority === "string" ? raw.legal_authority.trim() : "";
      const caseDate = await getCaseDate(r.case_id);
      const status = await classifyRemedyAuthority(db, legalAuthority, caseDate);
      const withStatus: NewFinding = {
        ...r,
        metadata: { ...(r.metadata ?? {}), remedy_authority_status: status },
      };
      // Only the two states where the authority is confirmed absent or
      // confirmed WRONG are force-downgraded. AUTHORITY_NOT_VERIFIED /
      // AUTHORITY_PRESENT pass through unchanged — an incomplete corpus must
      // never be treated as proof the citation is invalid (see contract note
      // on classifyRemedyAuthority above), which is exactly the previous
      // (binary) gate's behavior for any non-trivial string.
      if (status !== "AUTHORITY_MISSING" && status !== "AUTHORITY_INAPPLICABLE") return withStatus;
      return {
        ...withStatus,
        audit_classification: "EVIDENCE_GAP" as NewFinding["audit_classification"],
        description: `${r.description}${caveat}`,
      };
    }),
  );
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
    const title = enforceCorpusBoundedAbsenceLanguage(
      String(
        i.title ??
          i.finding ??
          i.issue ??
          i.violation ??
          i.gap ??
          i.item ??
          i.subject ??
          i.description ??
          "Untitled finding",
      ).slice(0, 400),
    );
    const description = enforceCorpusBoundedAbsenceLanguage(
      String(
        i.description ??
          i.detail ??
          i.why_needed ??
          i.support_text ??
          i.explanation ??
          i.rationale ??
          title,
      ),
    );
    const confidence = clamp01(i.confidence ?? 0.7);
    const evidence_refs = Array.isArray(i.support)
      ? i.support.map((s: unknown) => ({ label: typeof s === "string" ? s : JSON.stringify(s) }))
      : Array.isArray(i.evidence_refs)
        ? i.evidence_refs
        : [];
    const source_doc_ids: string[] = Array.isArray(i.source_doc_ids) ? i.source_doc_ids : [];
    const domainNorm = normalizeSubstantiveLegalDomain({
      title,
      description,
      legal_significance: i.legal_significance ?? null,
      proposition_type: normPropositionType(i.proposition_type),
      category: String(i.category ?? defaultCategory),
    } as any);

    const resolvedCategory = domainNorm.category ?? String(i.category ?? defaultCategory);
    const resolvedPropositionType = domainNorm.proposition_type ?? normPropositionType(i.proposition_type);

    return {
      case_id: caseId,
      user_id: userId,
      source_module: sourceModule,
      category: resolvedCategory,
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
      speaker_role: normSpeakerRole(i.speaker_role),
      proposition_type: resolvedPropositionType,
      adoption_status: normAdoptionStatus(i.adoption_status),
      audit_classification: normAuditClassification(i.audit_classification),
      evidence_refs,
      source_doc_ids,
      tags: Array.isArray(i.tags) ? i.tags : [],
      metadata: { raw: i },
    } satisfies NewFinding;
  });
}

// ============================================================================
// REPORT-WRITER INTELLIGENCE-CHUNK BRIDGE — Canonical Reconciliation Design
// (2026-08-16), §02/§10 P0: the report-writer's own "intelligence" chunk
// (contradictions/missing_evidence/constitutional_issues — see intelShape in
// pipeline.server.ts) previously wrote straight into reports.full_report and
// never called addFindings(), the one insert choke point every other
// producer already routes through. Nothing downstream that trusts that
// choke point — the findings tab, the hallucination pass, Talk-to-Case's
// read path, canonical-id.ts's dedup/reconciliation — could see this
// content existed, which is exactly how a real case (ADR 5829/2025) showed
// a contradiction in its report that the findings tab and agent cards had
// no record of.
//
// Call this AFTER the report pipeline's own quote-verification
// (verifyAndLabel) and claim-strength guardrail (enforceStructuredItems)
// have already run on these arrays — every item passed in here already has
// at least one quote confirmed to exist verbatim in the corpus. That
// satisfies the design's "evidence verification" pipeline stage using
// infrastructure that already exists; this function is pure, does no I/O,
// and performs no verification of its own.
//
// source_module uses a NEW "report_writer:" family (not "analyzer:") so
// canonical-id.ts's detectProducerConflict correctly recognizes these as a
// genuinely different producer from the analyzer's own "analyzer:
// contradiction" findings — required for real cross-producer reconciliation
// (vs. silent same-producer restatement) to ever fire. category stays the
// SAME token the analyzer already uses ("contradiction" / "missing_evidence")
// so a true duplicate between the two producers still collapses via the
// existing canonical_finding_id / clusterBySameIssue machinery instead of
// silently double-counting.
// ============================================================================
function citationEvidenceRefs(
  entries: Array<{ doc_n?: unknown; page?: unknown; quote?: unknown } | undefined>,
  docNToId: Map<number, string | null | undefined>,
): Array<Record<string, unknown>> {
  return entries
    .filter(
      (c): c is { doc_n?: unknown; page?: unknown; quote?: unknown } =>
        !!c && typeof c.quote === "string" && c.quote.trim().length > 0,
    )
    .map((c) => ({
      quote: String(c.quote),
      doc_id: typeof c.doc_n === "number" ? (docNToId.get(c.doc_n) ?? undefined) : undefined,
      page: typeof c.page === "number" ? c.page : undefined,
    }));
}

function sourceDocIdsFromRefs(refs: Array<Record<string, unknown>>): string[] {
  return [
    ...new Set(
      refs
        .map((r) => r.doc_id)
        .filter((x): x is string => typeof x === "string" && x.length > 0),
    ),
  ];
}

export function normalizeReportWriterFindings(args: {
  caseId: string;
  userId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contradictions: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  missingEvidence: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constitutionalIssues: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  motionOpportunities?: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  strategyRecommendations?: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nextActions?: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  crossExamination?: Array<Record<string, any>>;
  docNToId: Map<number, string | null | undefined>;
}): {
  contradictionRows: NewFinding[];
  missingEvidenceRows: NewFinding[];
  constitutionalRows: NewFinding[];
  motionOpportunityRows: NewFinding[];
  strategyRecommendationRows: NewFinding[];
  nextActionRows: NewFinding[];
  crossExaminationRows: NewFinding[];
} {
  const { caseId, userId, docNToId } = args;

  const contradictionRows: NewFinding[] = args.contradictions.map((c) => {
    const citations = Array.isArray(c.citations) ? c.citations : [];
    const evidence_refs = citationEvidenceRefs([c.document_a, c.document_b, ...citations], docNToId);
    return {
      case_id: caseId,
      user_id: userId,
      source_module: "report_writer:contradiction",
      category: "contradiction",
      title: String(c.title ?? "Contradicción detectada").slice(0, 400),
      description: String(c.description ?? c.nature ?? c.title ?? "").slice(0, 8000),
      severity: normSeverity(c.severity),
      confidence: 0.7,
      legal_significance: typeof c.legal_impact === "string" ? c.legal_impact : null,
      potential_impact: null,
      affected_party: normParty(c.side_helped),
      evidence_refs,
      source_doc_ids: sourceDocIdsFromRefs(evidence_refs),
      tags: [],
      metadata: { raw: c },
    } as NewFinding;
  });

  // Missing-evidence items are absence-of-evidence claims by nature — they
  // structurally cannot carry a verbatim quote (mirrors the analyzer's own
  // "analyzer:missing" findings, which the caller must route through
  // addGatedFindings' exemptCitation option the same way).
  const missingEvidenceRows: NewFinding[] = args.missingEvidence.map(
    (m) =>
      ({
        case_id: caseId,
        user_id: userId,
        // Full "missing_evidence" (not the abbreviated "missing" the
        // analyzer's own source_module uses) — isFindingAllowed's backstop
        // check (findings.server.ts's addFindings) matches this row's own
        // source_module domain token literally against
        // UNIVERSAL_FINDING_MODULES, which lists "missing_evidence", not
        // "missing". Using the full token here avoids relying on whatever
        // makes the analyzer's shorter form work today.
        source_module: "report_writer:missing_evidence",
        category: "missing_evidence",
        title: String(m.item ?? "Evidencia faltante").slice(0, 400),
        description: String(m.why_critical ?? m.item ?? "").slice(0, 8000),
        severity: normSeverity(m.severity),
        confidence: 0.6,
        legal_significance: null,
        potential_impact: typeof m.side_harmed === "string" ? m.side_harmed : null,
        affected_party: null,
        evidence_refs: [],
        source_doc_ids: [],
        tags: [],
        metadata: { raw: m },
      }) as NewFinding,
  );

  const constitutionalRows: NewFinding[] = args.constitutionalIssues.map((ci) => {
    const citations = Array.isArray(ci.citations) ? ci.citations : [];
    const evidence_refs = citationEvidenceRefs(citations, docNToId);
    const legalSig =
      typeof ci.right === "string" || typeof ci.articulo_cpeum === "string"
        ? `${ci.right ?? ""} ${ci.articulo_cpeum ?? ""}`.trim()
        : null;
    return {
      case_id: caseId,
      user_id: userId,
      // Full "constitutional_issue" (matches the category exactly) — the
      // isFindingAllowed backstop in addFindings checks this row's own
      // source_module domain token literally, not just the category field.
      source_module: "report_writer:constitutional_issue",
      // Generation is already gated upstream by isCriminalOrCivilRights
      // (pipeline.server.ts) — this category is added to
      // UNIVERSAL_FINDING_MODULES in practice-areas.ts for the same reason
      // missing_evidence/procedural/strength were promoted there: it's a
      // structural pipeline-output token, not materia-specific doctrine, and
      // no single materia's finding-module allow-list (MX_FINDING_MODULES)
      // covers every materia constitutional issues can legitimately surface
      // for (confirmed: penal's list has no "constitutional*" token at all).
      category: "constitutional_issue",
      title: String(ci.issue ?? ci.right ?? "Cuestión constitucional").slice(0, 400),
      description: String(ci.facts ?? ci.issue ?? "").slice(0, 8000),
      severity: "high",
      confidence: 0.7,
      legal_significance: legalSig || null,
      potential_impact: typeof ci.likely_outcome === "string" ? ci.likely_outcome : null,
      affected_party: null,
      evidence_refs,
      source_doc_ids: sourceDocIdsFromRefs(evidence_refs),
      tags: [],
      metadata: { raw: ci },
    } as NewFinding;
  });

  // Canonical Reconciliation Design (2026-08-16), P2 §10 — the SAME
  // intelShape LLM call P0 routed contradictions/missing_evidence/
  // constitutional_issues from also produces these 4 fields, and P0 left
  // them untouched: they still had no addFindings route at all before this.
  // All four are advisory/recommendation-shaped rather than factual claims —
  // exemptCitation is the correct treatment for all of them (mirrors
  // missing_evidence above and the analyzer's own discovery-gap/trial-risk
  // findings), not a citation-floor downgrade.
  const motionOpportunityRows: NewFinding[] = (args.motionOpportunities ?? []).map((mo) => {
    const citations = Array.isArray(mo.citations) ? mo.citations : [];
    const evidence_refs = citationEvidenceRefs(citations, docNToId);
    const likelihood = String(mo.likelihood_of_success ?? "").toLowerCase();
    return {
      case_id: caseId,
      user_id: userId,
      source_module: "report_writer:motion_opportunity",
      category: "motion_opportunity",
      title: String(mo.motion ?? "Oportunidad de moción").slice(0, 400),
      description: String(mo.legal_rationale ?? mo.basis ?? "").slice(0, 8000),
      severity: likelihood === "high" ? "high" : likelihood === "low" ? "low" : "medium",
      confidence: 0.6,
      legal_significance: typeof mo.basis === "string" ? mo.basis : null,
      potential_impact: typeof mo.anticipated_opposing_response === "string"
        ? mo.anticipated_opposing_response
        : null,
      affected_party: null,
      evidence_refs,
      source_doc_ids: sourceDocIdsFromRefs(evidence_refs),
      tags: [],
      metadata: { raw: mo },
    } as NewFinding;
  });

  const strategyRecommendationRows: NewFinding[] = (args.strategyRecommendations ?? []).map(
    (sr) =>
      ({
        case_id: caseId,
        user_id: userId,
        source_module: "report_writer:strategy_recommendation",
        category: "strategy_recommendation",
        title: String(sr.title ?? "Recomendación estratégica").slice(0, 400),
        description: String(sr.rationale ?? sr.title ?? "").slice(0, 8000),
        severity: normSeverity(sr.priority),
        confidence: 0.6,
        legal_significance: null,
        potential_impact: typeof sr.expected_impact === "string" ? sr.expected_impact : null,
        affected_party: null,
        evidence_refs: [],
        source_doc_ids: [],
        tags: [],
        metadata: { raw: sr },
      }) as NewFinding,
  );

  const nextActionRows: NewFinding[] = (args.nextActions ?? []).map(
    (na) =>
      ({
        case_id: caseId,
        user_id: userId,
        source_module: "report_writer:next_action",
        category: "next_action",
        title: String(na.action ?? "Siguiente acción").slice(0, 400),
        description: String(na.why ?? na.action ?? "").slice(0, 8000),
        severity: "medium",
        confidence: 0.6,
        legal_significance: null,
        potential_impact: null,
        affected_party: null,
        evidence_refs: [],
        source_doc_ids: [],
        tags: [],
        metadata: { raw: na },
      }) as NewFinding,
  );

  const crossExaminationRows: NewFinding[] = (args.crossExamination ?? []).map((ce) => {
    const lines = Array.isArray(ce.lines) ? ce.lines : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const citations = lines.map((l: any) => l?.citation).filter(Boolean);
    const evidence_refs = citationEvidenceRefs(citations, docNToId);
    const witness = typeof ce.witness === "string" ? ce.witness : "testigo";
    return {
      case_id: caseId,
      user_id: userId,
      source_module: "report_writer:cross_examination",
      category: "cross_examination",
      title: `Contrainterrogatorio: ${witness}`.slice(0, 400),
      description: String(ce.objective ?? "").slice(0, 8000),
      severity: "medium",
      confidence: 0.6,
      legal_significance: null,
      potential_impact: null,
      affected_party: null,
      evidence_refs,
      source_doc_ids: sourceDocIdsFromRefs(evidence_refs),
      tags: [],
      metadata: { raw: ce },
    } as NewFinding;
  });

  return {
    contradictionRows,
    missingEvidenceRows,
    constitutionalRows,
    motionOpportunityRows,
    strategyRecommendationRows,
    nextActionRows,
    crossExaminationRows,
  };
}
