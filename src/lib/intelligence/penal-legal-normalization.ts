// Penal legal-meaning normalization.
//
// Pure, deterministic boundary used immediately before a finding enters the
// canonical registry. Agent/module provenance is deliberately not consulted:
// a witness agent can discover a holding, but that does not make the holding
// witness evidence.

import type { AdoptionStatus, NewFinding, PropositionType } from "./types";

export type PenalMatterContext = {
  matter?: string | null;
  underlyingMatter?: string | null;
};

type GapBasis = {
  expected_in_record?: boolean;
  relevant_to_outcome?: boolean;
  production_or_admission_required?: boolean;
  materially_absent?: boolean;
  prejudice_explained?: boolean;
  record_support?: boolean;
};

const COURT_ROLES = new Set([
  "juez_control",
  "tribunal_enjuiciamiento",
  "tribunal_alzada",
  "tribunal_local",
  "tribunal_colegiado",
  "scjn",
]);

const PROSECUTION_ROLES = new Set(["ministerio_publico", "fiscal", "autoridad"]);
const DEFENSE_ROLES = new Set(["defensa", "imputado", "acusado", "sentenciado"]);

function norm(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isPenalMatter(context: PenalMatterContext): boolean {
  return [context.matter, context.underlyingMatter].some((value) =>
    /(^|[_\s-])(penal|criminal)([_\s-]|$)/i.test(String(value ?? "")),
  );
}

function roleProposition(role: string, affectedParty: unknown): PropositionType {
  if (PROSECUTION_ROLES.has(role)) return "prosecution_position";
  if (DEFENSE_ROLES.has(role)) return "defense_position";
  if (role === "victima" || role === "ofendido") return "victim_position";
  if (role === "testigo") return "witness_statement";
  if (role === "perito") return "expert_opinion";
  if (role === "quejoso") {
    const party = norm(affectedParty);
    if (party === "prosecution") return "prosecution_position";
    if (party === "defense") return "defense_position";
  }
  return "party_argument";
}

function canonicalProposition(finding: NewFinding): PropositionType | null {
  const raw = norm(finding.proposition_type);
  const role = norm(finding.speaker_role);

  if (raw === "holding" || raw === "court_holding") {
    return COURT_ROLES.has(role) || !role
      ? "court_holding"
      : roleProposition(role, finding.affected_party);
  }
  if (raw === "rejected_holding") return "rejected_holding";
  if (raw === "argument" || raw === "party_argument") {
    return roleProposition(role, finding.affected_party);
  }
  if (raw === "procedural_fact" || raw === "procedural_event") return "procedural_event";
  if (raw === "evidence") {
    const category = norm(finding.category);
    if (/digital|telefon|mensaje|video|audio|metadato/.test(category)) return "digital_evidence";
    if (/document/.test(category)) return "documentary_evidence";
    return "physical_evidence";
  }
  if (raw === "issue") return "unresolved_question";

  const accepted = new Set<PropositionType>([
    "case_fact",
    "allegation",
    "party_argument",
    "prosecution_position",
    "defense_position",
    "victim_position",
    "witness_statement",
    "expert_opinion",
    "physical_evidence",
    "documentary_evidence",
    "digital_evidence",
    "legal_rule",
    "court_holding",
    "rejected_holding",
    "procedural_event",
    "evidence_gap",
    "risk",
    "unresolved_question",
  ]);
  return accepted.has(raw as PropositionType) ? (raw as PropositionType) : null;
}

function canonicalAdoption(
  proposition: PropositionType | null,
  rawValue: unknown,
): AdoptionStatus {
  const raw = norm(rawValue);
  if (proposition === "rejected_holding") return "rejected";
  // The speaker controls party-position semantics. A party submission cannot
  // become an adopted holding merely because an upstream model emitted the
  // word "adopted".
  if (
    proposition === "party_argument" ||
    proposition === "prosecution_position" ||
    proposition === "defense_position" ||
    proposition === "victim_position"
  ) {
    return "party_position";
  }
  if (raw === "adopted" || raw === "rejected" || raw === "historical") return raw;
  if (raw === "unresolved" || raw === "not_reached") return "not_reached";
  return "unknown";
}

// ---------------------------------------------------------------------------
// CANONICAL PARTY-AWARE SCORE MAPPING
//
// One definition, used by BOTH the write-time normalizer (this file) and the
// QA auditor (penal-qa-status.ts). Two layers disagreeing about what a
// complete mapping is caused a real production block: the normalizer accepted
// a record the auditor later rejected (ADR 217/2019).
//
// Procedural vehicle and underlying substantive materia are distinct. An
// Amparo Directo en Revisión whose underlying materia is Penal is a single
// legitimate configuration: its party vocabulary is the Amparo one (quejoso /
// autoridad responsable / tercero interesado) AND the penal one, because the
// substantive analysis inside the amparo is genuinely penal. An ordinary
// penal proceeding keeps the penal vocabulary only.
// ---------------------------------------------------------------------------

export type PartyScoreContext = PenalMatterContext & {
  /** e.g. "amparo_directo_revision", "amparo_indirecto", "apelacion". */
  proceduralVehicle?: string | null;
};

/** Parties that can be the BENEFICIARY of a scoring effect in an ordinary
 *  penal proceeding. "both"/"neutral" are deliberately excluded — a benefit
 *  attributed to everyone justifies no direction. */
const PENAL_BENEFICIARY_PARTIES: ReadonlySet<string> = new Set([
  "defense",
  "defensa",
  "imputado",
  "acusado",
  "sentenciado",
  "prosecution",
  "ministerio_publico",
  "fiscal",
  "victima",
  "ofendido",
]);

/** Amparo party roles — first-class, not a penal synonym set. */
const AMPARO_BENEFICIARY_PARTIES: ReadonlySet<string> = new Set([
  "quejoso",
  "autoridad_responsable",
  "autoridad",
  "tercero_interesado",
  "recurrente",
]);

const NON_DIRECTIONAL_PARTIES: ReadonlySet<string> = new Set(["both", "neutral"]);

export function isAmparoProceeding(context: PartyScoreContext): boolean {
  return [context.proceduralVehicle, context.matter].some((value) =>
    /amparo/i.test(String(value ?? "")),
  );
}

/** Party roles that may be named as the beneficiary of a non-neutral score
 *  effect, selected by procedural context. */
export function allowedBeneficiaryParties(
  context: PartyScoreContext = {},
): ReadonlySet<string> {
  const penal = isPenalMatter(context);
  const amparo = isAmparoProceeding(context);
  if (amparo) {
    // Amparo (with or without a penal underlying materia) legitimately uses
    // amparo roles; when the underlying materia is penal the penal roles are
    // equally legitimate for the substantive analysis inside the amparo.
    return penal
      ? new Set([...AMPARO_BENEFICIARY_PARTIES, ...PENAL_BENEFICIARY_PARTIES])
      : AMPARO_BENEFICIARY_PARTIES;
  }
  if (penal) return PENAL_BENEFICIARY_PARTIES;
  // Unknown procedural context: accept any recognized party role rather than
  // guessing a vocabulary. Still stricter than "any non-empty string".
  return new Set([...AMPARO_BENEFICIARY_PARTIES, ...PENAL_BENEFICIARY_PARTIES]);
}

type PartyScoreFinding = {
  impact_direction?: unknown;
  affected_party?: unknown;
  benefited_party?: unknown;
  score_dimension?: unknown;
  reason_for_score_effect?: unknown;
  source_quote?: unknown;
  evidence_refs?: ReadonlyArray<{ quote?: unknown } | null | undefined> | null;
};

/**
 * THE canonical completeness test for a non-neutral scoring effect.
 * A neutral finding needs no mapping; a directional one must name who it
 * benefits (in a vocabulary valid for the procedural context), which score
 * dimension it moves, why, and carry a verbatim quote.
 */
export function hasCompletePartyAwareScoreMapping(
  finding: PartyScoreFinding,
  context: PartyScoreContext = {},
): boolean {
  const impact = norm(finding.impact_direction);
  if (impact !== "strengthens" && impact !== "weakens") return false;

  const allowed = allowedBeneficiaryParties(context);
  const benefited = norm(finding.benefited_party);
  if (!allowed.has(benefited)) return false;

  const affected = norm(finding.affected_party);
  if (affected && !allowed.has(affected) && !NON_DIRECTIONAL_PARTIES.has(affected)) return false;

  const quote =
    (typeof finding.source_quote === "string" ? finding.source_quote : "") ||
    String(
      (finding.evidence_refs ?? []).find((ref) => String(ref?.quote ?? "").trim())?.quote ?? "",
    );
  return (
    Boolean(String(finding.score_dimension ?? "").trim()) &&
    Boolean(String(finding.reason_for_score_effect ?? "").trim()) &&
    Boolean(String(quote ?? "").trim())
  );
}

function completePartyAwareScoreMapping(
  finding: NewFinding,
  context: PartyScoreContext,
): boolean {
  return hasCompletePartyAwareScoreMapping(finding as PartyScoreFinding, context);
}


function validEvidenceGapBasis(metadata: Record<string, unknown> | undefined): boolean {
  const basis = metadata?.evidence_gap_basis as GapBasis | undefined;
  return Boolean(
    basis?.expected_in_record &&
      basis.relevant_to_outcome &&
      basis.production_or_admission_required &&
      basis.materially_absent &&
      basis.prejudice_explained &&
      basis.record_support,
  );
}

function categoryFor(proposition: PropositionType | null, fallback: string): string {
  switch (proposition) {
    case "court_holding":
      return "court_holding";
    case "rejected_holding":
      return "rejected_holding";
    case "prosecution_position":
      return "prosecution_position";
    case "defense_position":
      return "defense_position";
    case "victim_position":
      return "victim_position";
    case "witness_statement":
      return "witness_statement";
    case "expert_opinion":
      return "expert_opinion";
    case "physical_evidence":
      return "physical_evidence";
    case "documentary_evidence":
      return "documentary_evidence";
    case "digital_evidence":
      return "digital_evidence";
    case "legal_rule":
      return "legal_rule";
    case "procedural_event":
      return "procedural_event";
    case "evidence_gap":
      return "evidence_gap";
    case "risk":
      return "risk";
    default:
      return fallback;
  }
}

import { validateReincidenciaEvidence } from "./reincidencia-evidence";

export type PenalNormalizationRule =
  | "legacy_taxonomy_mapped"
  | "party_holding_downgraded"
  | "legal_category_overrode_module_category"
  | "adopted_holding_neutralized"
  | "unproven_gap_downgraded";

export function normalizePenalFinding<T extends NewFinding>(
  finding: T,
  context: PartyScoreContext,
): T {
  if (!isPenalMatter(context)) return finding;
  const antecedent = validateReincidenciaEvidence(finding);
  if (antecedent.category === "unsupported_reincidencia") {
    return {
      ...finding,
      title: antecedent.title,
      category: "unsupported_reincidencia",
      metadata: {
        ...(finding.metadata ?? {}),
        attorney_review_required: true,
        report_suppressed: true,
        reincidencia_validation: "Qualifying prior conviction and applicable rule not established",
      },
    } as T;
  }

  const original = {
    category: finding.category,
    proposition_type: finding.proposition_type ?? null,
    adoption_status: finding.adoption_status ?? null,
    impact_direction: finding.impact_direction ?? null,
  };
  let proposition = canonicalProposition(finding);
  let adoption = canonicalAdoption(proposition, finding.adoption_status);
  if (proposition === "court_holding" && adoption === "rejected") {
    proposition = "rejected_holding";
    adoption = "rejected";
  }
  let category = categoryFor(proposition, finding.category);
  let description = finding.description;
  let impactDirection = finding.impact_direction ?? null;
  let affectedParty = finding.affected_party;
  let evidenceType = finding.evidence_type ?? null;
  const rules: PenalNormalizationRule[] = [];

  if (
    norm(original.proposition_type) !== norm(proposition) ||
    norm(original.adoption_status) !== norm(adoption)
  ) {
    rules.push("legacy_taxonomy_mapped");
  }
  if (
    (norm(original.proposition_type) === "holding" ||
      norm(original.proposition_type) === "court_holding") &&
    proposition !== "court_holding"
  ) {
    rules.push("party_holding_downgraded");
  }
  if (category !== original.category) rules.push("legal_category_overrode_module_category");

  if (proposition === "evidence_gap" && !validEvidenceGapBasis(finding.metadata)) {
    proposition = "unresolved_question";
    adoption = "unknown";
    category = "corpus_gap";
    impactDirection = "neutral";
    affectedParty = "neutral";
    evidenceType = "neutral";
    if (!/not available in (the )?uploaded corpus/i.test(description)) {
      description = `${description} Not available in the uploaded corpus; absence is not proof that the act did not occur.`;
    }
    rules.push("unproven_gap_downgraded");
  }

  if (
    proposition === "court_holding" &&
    adoption === "adopted" &&
    !completePartyAwareScoreMapping(finding, context)
  ) {
    impactDirection = "neutral";
    affectedParty = "neutral";
    evidenceType = "neutral";
    rules.push("adopted_holding_neutralized");
  }

  return {
    ...finding,
    category,
    description,
    proposition_type: proposition,
    adoption_status: adoption,
    impact_direction: impactDirection,
    affected_party: affectedParty,
    evidence_type: evidenceType,
    metadata: {
      ...(finding.metadata ?? {}),
      legal_normalization: {
        version: 1,
        rules,
        original,
      },
    },
  } as T;
}

export function normalizeSubstantiveLegalDomain(input: {
  title?: string | null;
  description?: string | null;
  legal_significance?: string | null;
  proposition_type?: PropositionType | null;
  category?: string | null;
}): { category?: string; proposition_type?: PropositionType } {
  return {
    category: input.category ?? undefined,
    proposition_type: input.proposition_type ?? undefined,
  };
}
