// Addendum §23 (auditable rationale) + §25 (multidimensional confidence).
//
// Every function here is pure and deterministic — no DB, no AI provider
// calls. It only reshapes/derives from data an engine's existing prompt
// already returns (or, when a model didn't happen to supply a given
// signal, falls back to a conservative heuristic default).
import type {
  ConfidenceDimension,
  ConfidenceDimensions,
  ConfidenceLevel,
  FindingRationale,
} from "./types";

const BANNED_UNSUPPORTED_PHRASES = [
  /\bse considera\b/i,
  /\bes probable\b/i,
  /\bpuede resultar favorable\b/i,
  /\bla evidencia es s[oó]lida\b/i,
  /\bexiste alta probabilidad de [ée]xito\b/i,
  /\bse recomienda promover\b/i,
] as const;

export function containsUnsupportedLanguage(text: string): boolean {
  if (!text) return false;
  return BANNED_UNSUPPORTED_PHRASES.some((re) => re.test(text));
}

function levelFromScore(score: number): ConfidenceLevel {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "moderate";
  if (score > 0) return "low";
  return "indeterminate";
}

function dim(level: ConfidenceLevel, reason: string): ConfidenceDimension {
  return { level, reason };
}

/**
 * A quoted, adopted judicial holding is authoritative evidence of what that
 * court held. It may still need separate authority/current-law analysis for
 * what follows from the holding, but it does NOT need a second independent
 * document merely to corroborate the fact that the court made the ruling.
 */
function isVerifiedJudicialHolding(raw: Record<string, unknown>): boolean {
  const audit = String(raw.audit_classification ?? "").toUpperCase();
  const proposition = String(raw.proposition_type ?? "").toLowerCase();
  const adoption = String(raw.adoption_status ?? "").toLowerCase();
  const verified = String(raw.verification_status ?? "").toLowerCase();
  return (
    audit === "VERIFIED_COURT_HOLDING" ||
    (proposition === "holding" && adoption === "adopted" && verified !== "unverified")
  );
}

export function deriveConfidenceDimensions(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
  overallConfidence: number;
  evidenceRefCount: number;
  sourceDocCount: number;
  hasExtractionSignal?: boolean;
}): ConfidenceDimensions {
  const { raw, overallConfidence, evidenceRefCount, sourceDocCount } = args;
  const r = (raw ?? {}) as Record<string, unknown>;
  const judicialHolding = isVerifiedJudicialHolding(r);

  const readHint = (key: string): ConfidenceDimension | null => {
    const v = r[key];
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).level === "string") {
      const row = v as Record<string, unknown>;
      return dim(row.level as ConfidenceLevel, String(row.reason ?? ""));
    }
    if (typeof v === "number") return dim(levelFromScore(v), "Derived from model-reported score.");
    return null;
  };

  return {
    extraction:
      readHint("extraction_confidence") ??
      dim(
        args.hasExtractionSignal === false
          ? "low"
          : sourceDocCount > 0 || judicialHolding
            ? "high"
            : "indeterminate",
        sourceDocCount > 0
          ? "Source document(s) extracted and attributed successfully."
          : judicialHolding
            ? "Authoritative judicial holding extracted from verified court resolution."
            : "No source document attached to this finding — extraction quality can't be assessed.",
      ),
    factual:
      readHint("factual_confidence") ??
      dim(
        levelFromScore(overallConfidence),
        "Derived from the engine's overall confidence score for this finding.",
      ),
    evidence_quality:
      readHint("evidence_quality") ??
      (judicialHolding && evidenceRefCount >= 1
        ? dim(
            "high",
            "Verified quotation from the judicial resolution is authoritative evidence of what the court held; independent corroboration is not required merely to establish the holding itself.",
          )
        : dim(
            evidenceRefCount >= 2 ? "high" : evidenceRefCount === 1 ? "moderate" : "low",
            evidenceRefCount >= 2
              ? `${evidenceRefCount} independent evidence references cited.`
              : evidenceRefCount === 1
                ? "One evidence reference cited; additional corroboration may be needed for disputed facts or inferences."
                : "No evidence reference cited.",
          )),
    legal:
      readHint("legal_confidence") ??
      dim(
        r.legal_significance || judicialHolding ? "high" : "moderate",
        judicialHolding
          ? "Constitutional/statutory rule established directly by the deciding court."
          : r.legal_significance
            ? "Legal significance was articulated by the engine; verify the cited rule is current and applicable."
            : "No legal significance was articulated for this finding.",
      ),
    procedural:
      readHint("procedural_confidence") ??
      dim(
        judicialHolding ? "high" : "moderate",
        judicialHolding
          ? "Procedural posture grounded in authoritative court resolution."
          : "Procedural-stage certainty derived from pipeline consensus.",
      ),
    corpus_completeness:
      readHint("corpus_completeness") ??
      dim(
        judicialHolding && sourceDocCount >= 1 ? "high" : sourceDocCount >= 2 ? "moderate" : "low",
        judicialHolding && sourceDocCount >= 1
          ? "The judicial resolution is sufficient to establish its own quoted holding; the complete official expediente may still contain additional context."
          : sourceDocCount >= 2
            ? "Multiple documents in the corpus touch this finding."
            : "Only a single document in the corpus touches this finding — the official expediente may contain more.",
      ),
    classification:
      readHint("classification_confidence") ??
      dim(
        judicialHolding ? "high" : "moderate",
        judicialHolding
          ? "Finding is classified as a verified, adopted court holding."
          : "Category/materia classification not independently re-verified for this finding — inherited from the source engine's own classification.",
      ),
  };
}

export function evidenceStrengthFromDimensions(
  dims: ConfidenceDimensions | null | undefined,
): number | null {
  const level = dims?.evidence_quality?.level;
  switch (level) {
    case "high":
      return 0.85;
    case "moderate":
      return 0.55;
    case "low":
      return 0.25;
    default:
      return null;
  }
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v))
    return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

export function deriveRationale(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  args: { title: string; description: string },
): FindingRationale {
  const r = raw ?? {};
  const supporting_evidence = toStringArray(r.supporting_evidence ?? r.support ?? r.evidence_refs);
  const contrary_evidence = toStringArray(
    r.contrary_evidence ?? r.contradicting_evidence ?? r.weakening_evidence,
  );
  const assumptions = toStringArray(r.assumptions ?? r.key_assumptions);
  const unresolved_questions = toStringArray(r.unresolved_questions ?? r.open_questions);
  const applicable_authority = toStringArray(r.applicable_authority ?? r.authority ?? r.citations);

  const flaggedText = `${args.title} ${args.description}`;
  const unsupported_language_flagged = containsUnsupportedLanguage(flaggedText);
  const needsReview =
    unsupported_language_flagged &&
    supporting_evidence.length === 0 &&
    applicable_authority.length === 0;

  return {
    supporting_evidence,
    contrary_evidence,
    assumptions,
    unresolved_questions,
    applicable_authority,
    attorney_review_required: Boolean(r.attorney_review_required) || needsReview,
    unsupported_language_flagged,
  };
}
