// Canonical Nyrava Intelligence types — shared by every engine and reader.

export type Severity = "critical" | "high" | "medium" | "low" | "info";
/** Party roles a finding can affect or benefit. The ordinary-penal pair
 *  (defense/prosecution) and the Amparo roles (quejoso / autoridad
 *  responsable / tercero interesado) are BOTH first-class: an Amparo whose
 *  underlying substantive materia is Penal legitimately uses either. Which
 *  vocabulary is valid for a given record is decided by procedural context —
 *  see allowedBeneficiaryParties() in penal-legal-normalization.ts, the one
 *  canonical definition shared by the write-time normalizer and the QA
 *  auditor. These unions mirror normParty()'s runtime allow-list. */
export type PartyRole =
  | "defense"
  | "prosecution"
  | "both"
  | "neutral"
  | "quejoso"
  | "autoridad_responsable"
  | "tercero_interesado"
  | "ministerio_publico"
  | "defensa"
  | "victima"
  | "ofendido"
  | "actor"
  | "demandado"
  | "trabajador"
  | "patron"
  | "contribuyente"
  | "autoridad_fiscal"
  | "particular"
  | "autoridad";
export type AffectedParty = PartyRole;
export type BenefitedParty = PartyRole;

/** Judicial-hierarchy attribution — see judicial-hierarchy.ts.
 *
 * Who ASSERTED a proposition in a multi-instance judicial resolution
 * (amparo directo en revisión, recurso de revisión, apelación, ...), as
 * distinct from `affected_party` which says who a finding BENEFITS. Null
 * for findings the extraction pass never attributed (the overwhelming
 * majority of non-precedent-review findings) — this is additive metadata,
 * never a narrowing of the existing Finding contract. */
export type JudicialSpeakerRole =
  | "quejoso"
  | "tercero_interesado"
  | "autoridad"
  | "ministerio_publico"
  | "fiscal"
  | "defensa"
  | "imputado"
  | "acusado"
  | "sentenciado"
  | "victima"
  | "ofendido"
  | "testigo"
  | "perito"
  | "juez_control"
  | "tribunal_enjuiciamiento"
  | "tribunal_alzada"
  | "tribunal_colegiado"
  | "tribunal_local"
  | "scjn";
/** argument = a party's position; holding = the speaker's own ruling on the
 * point; rejected_holding = a lower instance's ruling a higher instance
 * expressly overturned/superseded; procedural_fact = an undisputed
 * procedural event; evidence = an evidentiary point; issue = a question the
 * resolution frames but does not itself resolve. */
export type PropositionType =
  | "argument"
  | "holding"
  | "procedural_fact"
  | "evidence"
  | "issue"
  | "case_fact"
  | "allegation"
  | "party_argument"
  | "prosecution_position"
  | "defense_position"
  | "victim_position"
  | "witness_statement"
  | "expert_opinion"
  | "physical_evidence"
  | "documentary_evidence"
  | "digital_evidence"
  | "legal_rule"
  | "court_holding"
  | "rejected_holding"
  | "procedural_event"
  | "evidence_gap"
  | "risk"
  | "unresolved_question";
/** Whether the highest instance present in the case adopted this
 * proposition as part of its holding. "unresolved" = raised but not ruled
 * on; "historical" = a superseded position kept only for narrative context. */
export type AdoptionStatus =
  | "adopted"
  | "rejected"
  | "not_reached"
  | "party_position"
  | "historical"
  | "unknown"
  | "unresolved";

/** Completed-case audit classification — see case-analysis-mode.ts. Set only
 *  by findings generated under a completed-case analysis mode (concluded_audit
 *  / judgment_audit / appeal_routes); null for every finding generated under
 *  the default "ongoing" mode. Additive, never a narrowing of the existing
 *  Finding contract. */
export type AuditClassification =
  | "VERIFIED_FACT"
  | "VERIFIED_COURT_HOLDING"
  | "VERIFIED_LEGAL_RULE"
  | "SUPPORTED_INFERENCE"
  | "POTENTIAL_ISSUE"
  | "EVIDENCE_GAP"
  | "NOT_FOUND";

export type EvidenceType = "inculpatory" | "exculpatory" | "impeachment" | "neutral";
export type ImpactDirection = "strengthens" | "weakens" | "neutral";

/** Addendum §25 — a single confidence float can't distinguish "the OCR is
 * shaky but the legal rule is crystal clear" from "the OCR is perfect but
 * the procedural stage is unknown." Each dimension is independent; none of
 * them collapse into the others. See confidence-dimensions.ts. Optional and
 * additive — the existing scalar `confidence` on Finding is untouched and
 * still drives all existing scoring math. */
export type ConfidenceLevel = "high" | "moderate" | "low" | "indeterminate";
export type ConfidenceDimension = { level: ConfidenceLevel; reason: string };
export type ConfidenceDimensions = {
  extraction: ConfidenceDimension;
  factual: ConfidenceDimension;
  evidence_quality: ConfidenceDimension;
  legal: ConfidenceDimension;
  procedural: ConfidenceDimension;
  corpus_completeness: ConfidenceDimension;
  classification: ConfidenceDimension;
};

/** Addendum §23 — an auditable legal rationale, not private chain-of-thought:
 * what supports this conclusion, what weakens it, what's assumed, what's
 * unresolved. Optional and additive. */
export type FindingRationale = {
  supporting_evidence: string[];
  contrary_evidence: string[];
  assumptions: string[];
  unresolved_questions: string[];
  applicable_authority: string[];
  attorney_review_required: boolean;
  /** True if the raw model text leaned on an unsupported-conclusion phrase
   * ("es probable", "se recomienda promover", ...) without an accompanying
   * evidence/authority reference. See BANNED_UNSUPPORTED_PHRASES. */
  unsupported_language_flagged: boolean;
};

/** Proposition-level dispute status (spec: case-revision architecture). A
 * document can be genuinely valid while being wrong for ONE finding's
 * proposition — this lives on the individual evidence_ref, not on the
 * `documents` row, so disputing E-019 here for Finding F-003 never touches
 * whether E-019 is still perfectly good evidence inside some other finding.
 * Undefined/absent = 'active' (every pre-existing evidence_ref, which never
 * had these fields, keeps working unchanged). */
export type EvidenceRefStatus = "active" | "disputed" | "superseded" | "withdrawn";

/** See evidence-gate.server.ts's classifyEvidenceRelationship (Rule 6,
 *  report-quality audit, 2026-08-14) — what KIND of relationship a finding
 *  has to its evidence, distinct from finding_type's evidentiary-strength
 *  axis. Only SOURCE_HOLDING/SOURCE_FACT are ever eligible to back a
 *  DIRECT_EVIDENCE finding_type. Null for findings generated before this
 *  taxonomy existed. */
export type EvidenceRelationship =
  | "SOURCE_HOLDING"
  | "SOURCE_FACT"
  | "SOURCE_ARGUMENT"
  | "DERIVED_INFERENCE"
  | "UNPROVEN_ABSENCE"
  | "MISSING_EVIDENCE";

export type EvidenceRef = {
  label?: string;
  quote?: string;
  doc_id?: string;
  status?: EvidenceRefStatus;
  /** Set only when status is 'superseded' — the doc_id of the replacement
   *  evidence, if the correction supplied one. */
  superseded_by_doc_id?: string;
  /** Human-readable reason, required whenever status is anything but
   *  'active'. Mirrors case_findings.superseded_reason's "always explain
   *  why" convention at the per-citation granularity. */
  status_reason?: string;
};

export type Finding = {
  id: string;
  case_id: string;
  user_id: string;
  source_module: string;
  category: string;
  title: string;
  description: string;
  severity: Severity;
  confidence: number;
  confidence_dimensions?: ConfidenceDimensions | null;
  rationale?: FindingRationale | null;
  legal_significance: string | null;
  potential_impact: string | null;
  affected_party: AffectedParty | null;
  benefited_party?: BenefitedParty | null;
  evidence_type?: EvidenceType | null;
  impact_direction?: ImpactDirection | null;
  authority_level?: string | null;
  score_dimension?: string | null;
  reason_for_score_effect?: string | null;
  strategic_significance?: string | null;
  priority?: number | null;
  speaker_role?: JudicialSpeakerRole | null;
  proposition_type?: PropositionType | null;
  adoption_status?: AdoptionStatus | null;
  audit_classification?: AuditClassification | null;
  evidence_relationship?: EvidenceRelationship | null;
  /** Set when a verified case-state update (currently: a Talk-to-Case
   *  clarification) established this finding no longer reflects the case
   *  record. NULL = still active. See case-state-reconciliation.server.ts. */
  superseded_at?: string | null;
  superseded_reason?: string | null;
  source_doc_ids: string[];
  evidence_refs: EvidenceRef[];
  related_finding_ids: string[];
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type NewFinding = Omit<
  Finding,
  | "id"
  | "created_at"
  | "updated_at"
  | "source_doc_ids"
  | "evidence_refs"
  | "related_finding_ids"
  | "tags"
  | "metadata"
> & {
  /** Verbatim source quote when an engine carries a single primary quote in
   * addition to evidence_refs. This is an input-only convenience field used
   * by validation/source-meaning guards and is not required on persisted
   * Finding rows. */
  source_quote?: string | null;
  source_doc_ids?: string[];
  evidence_refs?: Finding["evidence_refs"];
  related_finding_ids?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type ScoreContributor = {
  label: string;
  weight: number; // -100..100
  finding_id?: string;
};

export type ExplainableScore = {
  positive_contributors: ScoreContributor[];
  negative_contributors: ScoreContributor[];
  confidence: number;
  reasoning: string;
};

export type Theory = {
  // Real Mexican procedural role (mxPartyRoleEnum in execution/mx-pipeline.ts)
  // as of engines.server.ts's runTheoryEngine fix — e.g. "quejoso",
  // "tercero_interesado", "actor", "demandado" — not the old hardcoded
  // prosecution/defense/alternative binary this type still named. Left as
  // `string` rather than a union since the valid set is materia-dependent
  // (13 different role vocabularies); runtime validation happens against
  // MX_PARTY_ROLES[profile], not the type system.
  theory_type: string;
  narrative: string;
  supporting_evidence: string[];
  contradicting_evidence: string[];
  missing_evidence: string[];
  confidence: number;
  risk: string;
  key_assumptions: string[];
};

export type Opportunity = {
  // Real Mexican procedural role (mxPartyRoleEnum), same fix and same
  // rationale as Theory.theory_type above — this field was English
  // plaintiff/defense-only regardless of materia until runOpportunityEngine
  // was fixed to use MX_PARTY_ROLES like the theory engine already did.
  side: string;
  opportunity_type: string;
  title: string;
  description: string;
  recommended_motions: string[];
  recommended_questions: string[];
  recommended_investigations: string[];
  counter_response?: string;
  severity: Severity;
  confidence: number;
  source_finding_ids?: string[];
};

export type WitnessProfile = {
  name: string;
  role: string;
  reliability: number;
  bias: number;
  consistency: number;
  corroboration: number;
  observation_opportunity: number;
  credibility_risk: number;
  cross_exam_questions: string[];
  impeachment_questions: string[];
  follow_up_questions: string[];
  rationale: Record<string, string>;
};

export type TrialPrep = {
  opening_themes: string[];
  closing_themes: string[];
  witness_order: Array<{ name: string; reason: string }>;
  exhibit_order: Array<{ exhibit: string; reason: string }>;
  likely_objections: Array<{ objection: string; counter: string }>;
  trial_risks: string[];
  trial_strengths: string[];
  jury_concerns: string[];
  jury_conviction_pct: number;
  jury_acquittal_pct: number;
  jury_appeal_pct: number;
  jury_settlement_pct: number;
  most_persuasive_evidence: string[];
  most_damaging_evidence: string[];
};

export type WorkProductDoc = {
  /**
   * Mexican procedural drafting vehicle id — see
   * src/lib/jurisdiction/mx-work-product.ts, which is materia-aware
   * (`demanda_de_amparo`, `solicitud_exclusion_prueba_ilicita`,
   * `recurso_de_revocacion`, …). Previously a fixed U.S. union
   * (motion_to_suppress | motion_for_summary_judgment | discovery_request),
   * none of which are Mexican instruments. `case_summary` is preserved as the
   * factual-summary id because the report/PDF gate keys on it.
   */
  document_type: string;
  title: string;
  body_markdown: string;
  cited_finding_ids?: string[];
};
