// ============================================================================
// CANONICAL REPORT CONTEXT
//
// Narrative owns the high-level prose. This module runs immediately after the
// narrative pass and, in addition to building the reference context for later
// passes, applies deterministic integrity guards to that SAME prose object so
// unsafe narrative cannot reappear in the final merged report.
// ============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */

import { scrubUnsupportedLegalFilingSentences } from "./recommendation-grounding";
import { evidenceGapTopics, scrubEvidenceAbsenceInversion } from "./absence-evidence-guard";
import { scrubUnsupportedContradictionSentences } from "./contradiction-prose-guard";

export type RecommendationOwner = "narrative" | "memo" | "intelligence";

export interface RecommendationCandidate {
  id: string;
  owner: RecommendationOwner;
  title: string;
  reason: string;
  supportingFindingIds: string[];
  supportingEvidence: string[];
  confidence: number | null;
  expectedImpact: string | null;
  priorityHint: "critical" | "high" | "medium" | "low" | null;
}

export interface CanonicalRiskAssessment {
  score: number | null;
  narrative: string;
  majorContributors: string[];
  weaknesses: string[];
  unknowns: string[];
}

export interface CanonicalReportContext {
  executiveSummary: string;
  primaryIssues: string[];
  recommendations: RecommendationCandidate[];
  riskAssessment: CanonicalRiskAssessment;
  constitutionalIssues: string;
  contradictionSummary: string;
  missingEvidenceSummary: string;
  witnessSummary: string;
  timelineSummary: string;
}

function fnv1a(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

export function extractRecommendationCandidatesFromProse(
  prose: string,
  owner: RecommendationOwner = "narrative",
): RecommendationCandidate[] {
  if (!prose || typeof prose !== "string") return [];
  let lines = prose
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-•\u2022\*]+/, "").replace(/^\d+[.)]\s*/, "").trim())
    .filter((l) => l.length > 0);

  if (lines.length <= 1) {
    lines = prose
      .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/)
      .map((l) => l.trim())
      .filter((l) => l.length > 20);
  }

  const out: RecommendationCandidate[] = [];
  for (const line of lines) {
    const title = line.length > 140 ? `${line.slice(0, 137)}...` : line;
    const norm = normalizeTitle(title);
    if (!norm) continue;
    out.push({
      id: `rec_${fnv1a(norm)}`,
      owner,
      title,
      reason: line,
      supportingFindingIds: [],
      supportingEvidence: [],
      confidence: null,
      expectedImpact: null,
      priorityHint: null,
    });
  }
  return out;
}

const NARRATIVE_FIELDS = [
  "executive_summary",
  "attorney_summary",
  "risk_analysis",
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
  "timeline_summary",
] as const;

export function sanitizeNarrativeProse(
  narrativeParsed: Record<string, any> | null | undefined,
): {
  filingSentencesRemoved: number;
  absenceInversionsRemoved: number;
  unsupportedContradictionsRemoved: number;
} {
  const prose = narrativeParsed?.prose;
  if (!prose || typeof prose !== "object" || Array.isArray(prose)) {
    return {
      filingSentencesRemoved: 0,
      absenceInversionsRemoved: 0,
      unsupportedContradictionsRemoved: 0,
    };
  }

  const missingEvidence = typeof prose.missing_evidence_report === "string" ? prose.missing_evidence_report : "";
  const gapTopics = evidenceGapTopics(missingEvidence);
  let filingSentencesRemoved = 0;
  let absenceInversionsRemoved = 0;
  let unsupportedContradictionsRemoved = 0;

  for (const field of NARRATIVE_FIELDS) {
    const value = prose[field];
    if (typeof value !== "string" || !value.trim()) continue;
    const filing = scrubUnsupportedLegalFilingSentences(value);
    filingSentencesRemoved += filing.removed;
    const absence = scrubEvidenceAbsenceInversion(filing.text, gapTopics);
    absenceInversionsRemoved += absence.removed;
    prose[field] = absence.text;
  }

  if (typeof prose.contradiction_report === "string" && prose.contradiction_report.trim()) {
    const filing = scrubUnsupportedLegalFilingSentences(prose.contradiction_report);
    filingSentencesRemoved += filing.removed;
    const absence = scrubEvidenceAbsenceInversion(filing.text, gapTopics);
    absenceInversionsRemoved += absence.removed;
    const contradiction = scrubUnsupportedContradictionSentences(absence.text);
    unsupportedContradictionsRemoved += contradiction.removed;
    prose.contradiction_report = contradiction.text;
  }

  if (typeof prose.missing_evidence_report === "string") {
    const filing = scrubUnsupportedLegalFilingSentences(prose.missing_evidence_report);
    filingSentencesRemoved += filing.removed;
    // The missing-evidence section never asserts an absolute absence: its own
    // search scope cannot prove it. Qualify the wording at the source.
    prose.missing_evidence_report = remediateAbsenceLanguage(filing.text).text;
  }

  return {
    filingSentencesRemoved,
    absenceInversionsRemoved,
    unsupportedContradictionsRemoved,
  };
}

export function buildCanonicalReportContext(
  narrativeParsed: Record<string, any> | null | undefined,
): CanonicalReportContext {
  sanitizeNarrativeProse(narrativeParsed);
  const prose = (narrativeParsed?.prose ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  return {
    executiveSummary: str(prose.executive_summary),
    primaryIssues: [],
    recommendations: extractRecommendationCandidatesFromProse(str(prose.recommendations), "narrative"),
    riskAssessment: {
      score: null,
      narrative: str(prose.risk_analysis),
      majorContributors: [],
      weaknesses: [],
      unknowns: [],
    },
    constitutionalIssues: str(prose.constitutional_issues),
    contradictionSummary: str(prose.contradiction_report),
    missingEvidenceSummary: str(prose.missing_evidence_report),
    witnessSummary: str(prose.witness_analysis),
    timelineSummary: str(prose.timeline_summary),
  };
}

export function serializeCanonicalContextForPrompt(ctx: CanonicalReportContext): string {
  const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);
  const recList = ctx.recommendations.slice(0, 12).map((r) => `- [${r.id}] ${r.title}`).join("\n");

  return `CANONICAL REPORT CONTEXT (already established by the narrative pass — DO NOT regenerate or restate these; reference them by id/summary only and add ONLY content in your own lane):

Executive Summary (already written, do not rewrite):
${truncate(ctx.executiveSummary, 1200)}

High-Level Risk (already written, do not rewrite):
${truncate(ctx.riskAssessment.narrative, 800)}

Constitutional Discussion (already written at a high level, do not restate — you may go deeper with citations/authority, but do not re-summarize):
${truncate(ctx.constitutionalIssues, 800)}

Contradiction Summary (already written, do not restate — you may add structured detail, but do not re-narrate):
${truncate(ctx.contradictionSummary, 800)}

Missing Evidence Summary (already written, do not restate):
${truncate(ctx.missingEvidenceSummary, 600)}

Primary Recommendation Candidates already identified (reference by id if you build on one; do not restate its text; ADD new items only if they are genuinely not covered above):
${recList || "(none extracted)"}
`;
}
