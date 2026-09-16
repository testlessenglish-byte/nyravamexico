import type { Finding } from "./types";
import {
  hasCompletePartyAwareScoreMapping,
  type PartyScoreContext,
} from "./penal-legal-normalization";


export type PenalQaStatus = "PASS" | "WARN" | "WARN_NON_BLOCKING" | "FAIL" | "NOT_APPLICABLE";

export type PenalQaLayer =
  | "citation_integrity"
  | "legal_grounding_hallucination"
  | "classification_fidelity"
  | "procedural_semantics"
  | "rendering_consistency"
  | "release_readiness";

export type PenalQaLayerResult = {
  layer: PenalQaLayer;
  status: PenalQaStatus;
  issues: number;
  reason: string;
  blocking?: boolean;
};

export type PenalQaInputs = {
  applicable: boolean;
  citationQuarantined: number | null;
  hallucinationEngineStatus: string | null;
  classificationConflicts: number;
  proceduralSemanticIssues: number;
  proceduralSchemaAliases?: number;
  renderedCriticalIssues: number | null;
  releaseGateIssues: number | null;
  qualityBlocked: boolean;
};

function count(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

export function auditPenalProceduralSemantics(
  findings: readonly Finding[],
  context: PartyScoreContext = {},
): number {

  const courtRoles = new Set([
    "juez_control",
    "tribunal_enjuiciamiento",
    "tribunal_alzada",
    "tribunal_local",
    "tribunal_colegiado",
    "scjn",
  ]);
  const partyRoles = new Set([
    "quejoso",
    "tercero_interesado",
    "autoridad",
    "ministerio_publico",
    "fiscal",
    "defensa",
    "imputado",
    "acusado",
    "sentenciado",
    "victima",
    "ofendido",
  ]);

  let issues = 0;
  for (const finding of findings) {
    const role = String(finding.speaker_role ?? "");
    const proposition = String(finding.proposition_type ?? "");
    const adoption = String(finding.adoption_status ?? "");
    const impact = String(finding.impact_direction ?? "");
    const classification = String(finding.audit_classification ?? "");

    if (courtRoles.has(role) && classification === "VERIFIED_COURT_HOLDING") {
      // "holding" is a valid shared PropositionType (including Amparo/SCJN).
      // Accept the alias without changing the extracted legal proposition.
      if (!["holding", "court_holding", "rejected_holding"].includes(proposition)) issues += 1;
      if (!["adopted", "rejected", "not_reached", "historical", "unknown"].includes(adoption)) {
        issues += 1;
      }
      // Same canonical definition the write-time normalizer uses, so one
      // layer can never accept a record the other rejects. The procedural
      // context selects the party vocabulary (amparo vs ordinary penal).
      const hasPartyAwareMapping = hasCompletePartyAwareScoreMapping(finding, context);

      if (
        ["holding", "court_holding"].includes(proposition) &&
        adoption === "adopted" &&
        impact !== "neutral" &&
        !hasPartyAwareMapping
      ) {
        issues += 1;
      }
    }
    if (
      partyRoles.has(role) &&
      adoption === "adopted" &&
      classification === "VERIFIED_COURT_HOLDING"
    ) {
      issues += 1;
    }
  }
  return issues;
}

export function buildPenalQaStatuses(input: PenalQaInputs): PenalQaLayerResult[] {
  if (!input.applicable) {
    return (
      [
        "citation_integrity",
        "legal_grounding_hallucination",
        "classification_fidelity",
        "procedural_semantics",
        "rendering_consistency",
        "release_readiness",
      ] as PenalQaLayer[]
    ).map((layer) => ({
      layer,
      status: "NOT_APPLICABLE",
      issues: 0,
      reason: "not_a_penal_matter",
    }));
  }

  const citationIssues = count(input.citationQuarantined);
  const proceduralIssues = count(input.proceduralSemanticIssues);
  const renderedIssues = count(input.renderedCriticalIssues);
  const releaseIssues = count(input.releaseGateIssues);
  const hallucinationStatus = String(input.hallucinationEngineStatus ?? "").toLowerCase();

  return [
    {
      layer: "citation_integrity",
      status: input.citationQuarantined == null ? "WARN" : citationIssues ? "WARN" : "PASS",
      issues: citationIssues,
      reason:
        input.citationQuarantined == null
          ? "citation_audit_unavailable"
          : citationIssues
            ? "unsupported_citations_quarantined"
            : "all_rendered_citations_supported",
    },
    {
      layer: "legal_grounding_hallucination",
      status:
        hallucinationStatus === "completed" || hallucinationStatus === "completed_negative"
          ? "PASS"
          : hallucinationStatus === "failed"
            ? "FAIL"
            : "WARN",
      issues: hallucinationStatus === "failed" ? 1 : 0,
      reason: hallucinationStatus
        ? `hallucination_engine_${hallucinationStatus}`
        : "hallucination_engine_status_unavailable",
    },
    {
      layer: "classification_fidelity",
      status: input.classificationConflicts > 0 ? "FAIL" : "PASS",
      issues: count(input.classificationConflicts),
      reason:
        input.classificationConflicts > 0
          ? "verified_case_identity_conflict"
          : "case_identity_consistent",
    },
    {
      layer: "procedural_semantics",
      status: proceduralIssues > 0 ? "FAIL" : input.proceduralSchemaAliases ? "WARN_NON_BLOCKING" : "PASS",
      issues: proceduralIssues,
      blocking: true,
      reason: proceduralIssues ? "invalid_penal_semantic_records" : input.proceduralSchemaAliases
        ? "shared_holding_schema_alias_validated" : "canonical_semantics_valid",
    },
    {
      layer: "rendering_consistency",
      status:
        input.renderedCriticalIssues == null ? "WARN" : renderedIssues > 0 ? "WARN_NON_BLOCKING" : "PASS",
      blocking: false,
      issues: renderedIssues,
      reason:
        input.renderedCriticalIssues == null
          ? "rendered_report_qa_unavailable"
          : renderedIssues
            ? "critical_rendering_inconsistencies"
            : "rendered_report_consistent",
    },
    {
      layer: "release_readiness",
      status:
        input.qualityBlocked
          ? "FAIL"
          : releaseIssues > 0 ? "WARN_NON_BLOCKING"
          : input.releaseGateIssues == null
            ? "WARN"
            : "PASS",
      issues: releaseIssues + (input.qualityBlocked ? 1 : 0),
      blocking: input.qualityBlocked,
      reason: input.qualityBlocked
        ? "quality_blocked"
        : releaseIssues
          ? "release_gate_mismatch"
          : input.releaseGateIssues == null
            ? "release_gate_unavailable"
            : "release_gate_passed",
    },
  ];
}
