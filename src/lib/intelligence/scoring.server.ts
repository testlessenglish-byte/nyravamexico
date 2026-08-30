// Deterministic, rule-based scoring derived from canonical findings.
// One scoring authority is used regardless of the legacy analysis_mode token.

import type { Finding } from "./types";
import type { ProceduralPosture } from "./procedural-posture";
import { dimensionTag, type DimensionKey } from "./dimension-map.server";
import { excludeRejectedFromScoring } from "./judicial-hierarchy";

export type ScoreContributor = {
  finding_id: string;
  title: string;
  category: string;
  severity: Finding["severity"];
  confidence: number;
  affected_party: Finding["affected_party"];
  signed_weight: number;
};

export type DimensionScore = {
  dimension: string;
  score: number;
  baseline: number;
  raw_delta: number;
  decayed_delta: number;
  positive_weight_total: number;
  negative_weight_total: number;
  contributor_count: number;
  positives: ScoreContributor[];
  negatives: ScoreContributor[];
  reasoning: string;
  formula: string;
};

export type DeterministicScorecard = {
  methodology: string;
  generated_at: string;
  finding_count: number;
  dimensions: Record<string, DimensionScore>;
  overall_confidence: number;
  formula_notes: string[];
};

const SEVERITY_WEIGHT: Record<Finding["severity"], number> = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
  info: 1,
};

const DECAY_RATE = 0.6;

function decayedSum(weights: number[]): number {
  const sorted = [...weights].sort((a, b) => Math.abs(b) - Math.abs(a));
  return sorted.reduce((sum, weight, i) => sum + weight * Math.pow(DECAY_RATE, i), 0);
}

type DimensionDefinition = {
  baseline: number;
  positive: { categories: string[]; modules?: string[] };
  negative: { categories: string[]; modules?: string[] };
  label: string;
};

const DIMENSIONS: Record<string, DimensionDefinition> = {
  evidence_strength: {
    baseline: 60,
    label: "Confiabilidad de la evidencia",
    positive: { categories: ["corroborating_evidence", "evidence_corroborated", "physical_evidence_intact"] },
    negative: { categories: ["weak_evidence", "evidence_contradiction", "inadmissible", "evidence_unreliable", "evidence_missing"] },
  },
  witness_reliability: {
    baseline: 60,
    label: "Confiabilidad de testigos",
    positive: { categories: ["witness_corroborated"] },
    negative: { categories: ["witness_bias", "witness_contradiction", "credibility", "witness_inconsistency", "informant_unreliable"] },
  },
  timeline_integrity: {
    baseline: 70,
    label: "Integridad cronológica",
    positive: { categories: ["timeline_consistent"] },
    negative: { categories: ["timeline_inconsistency", "timeline_gap", "timeline_conflict", "alibi_conflict"] },
  },
  chain_of_custody: {
    baseline: 80,
    label: "Integridad de la cadena de custodia",
    positive: { categories: ["custody_intact"] },
    negative: { categories: ["chain_of_custody", "custody_break", "custody_gap", "evidence_tampering"] },
  },
  constitutional_compliance: {
    baseline: 80,
    label: "Cumplimiento constitucional",
    positive: { categories: ["constitutional_compliant"] },
    negative: { categories: ["constitutional", "confession_issue", "diligencia_investigacion", "carpeta_investigacion", "control_detencion"] },
  },
  investigation_completeness: {
    baseline: 60,
    label: "Integridad de la investigación",
    positive: { categories: ["investigation_thorough"] },
    negative: { categories: ["missing_evidence", "investigation_gap", "unresolved_lead", "missing_interview", "missing_record"] },
  },
  discovery_completeness: {
    baseline: 60,
    label: "Integridad de la investigación (aportación probatoria)",
    positive: { categories: ["discovery_compliant", "production_complete"] },
    negative: { categories: ["violacion_procesal", "missing_evidence", "discovery_gap", "discovery_violation"] },
  },
  forensic_reliability: {
    baseline: 70,
    label: "Confiabilidad pericial/forense",
    positive: { categories: ["forensic_corroborated"] },
    negative: { categories: ["expert_challenge", "forensic_unreliable", "dna_degradation", "mixed_dna", "lab_error"] },
  },
  procedural_integrity: {
    baseline: 70,
    label: "Integridad procesal",
    positive: { categories: ["procedural_compliant"] },
    negative: { categories: ["violacion_procesal", "procedural", "discovery_violation"] },
  },
  liability_strength: {
    baseline: 50,
    label: "Fortaleza de la responsabilidad",
    positive: { categories: ["liability", "duty", "breach", "standard_of_care", "negligence_established"] },
    negative: { categories: ["no_duty", "liability_defense", "comparative_fault", "assumption_of_risk"] },
  },
  causation_strength: {
    baseline: 50,
    label: "Fortaleza del nexo causal",
    positive: { categories: ["causation", "proximate_cause", "but_for"] },
    negative: { categories: ["causation_gap", "intervening_cause", "superseding_cause"] },
  },
  damages_exposure: {
    baseline: 50,
    label: "Exposición por daños",
    positive: { categories: ["damages", "injury", "loss", "economic_damages", "noneconomic_damages"] },
    negative: { categories: ["mitigation", "speculative_damages", "damages_cap"] },
  },
  expert_support: {
    baseline: 50,
    label: "Apoyo pericial",
    positive: { categories: ["expert", "expert_opinion", "expert_corroboration"] },
    negative: { categories: ["expert_gap", "expert_contradiction", "expert_challenge"] },
  },
  documentation_reliability: {
    baseline: 60,
    label: "Confiabilidad documental",
    positive: { categories: ["documentation", "records_complete", "document_integrity"] },
    negative: { categories: ["documentation_gap", "record_alteration", "record_inconsistency", "records_missing", "documentation_discrepancy"] },
  },
  discovery_compliance: {
    baseline: 60,
    label: "Cumplimiento probatorio",
    positive: { categories: ["discovery_compliant", "production_complete"] },
    negative: { categories: ["violacion_procesal", "discovery_gap", "discovery_violation", "missing_evidence"] },
  },
  litigation_risk: {
    baseline: 50,
    label: "Riesgo litigioso",
    positive: { categories: ["defense_strong", "case_strong"] },
    negative: { categories: ["adverse_ruling", "litigation_risk", "exposure", "trial_risk"] },
  },
  settlement_pressure: {
    baseline: 50,
    label: "Presión para conciliar",
    positive: { categories: ["settlement_leverage", "settlement_pressure"] },
    negative: { categories: ["weak_settlement_position"] },
  },
};

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

function signedWeight(f: Finding, polarity: 1 | -1): number {
  const sev = SEVERITY_WEIGHT[f.severity] ?? 5;
  const conf = Math.max(0, Math.min(1, f.confidence ?? 0.5));
  return polarity * sev * conf;
}

function normTok(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

function matchesLegacyCategory(f: Finding, cats: string[], mods?: string[]): boolean {
  const cat = normTok(f.category ?? "");
  if (cats.some((c) => cat.includes(normTok(c)))) return true;
  return Boolean(mods?.some((m) => (f.source_module ?? "").includes(m)));
}

function matches(f: Finding, dimensionKey: string, cats: string[], mods?: string[]): boolean {
  const tags = f.tags ?? [];
  if (tags.includes(dimensionTag(dimensionKey as DimensionKey))) return true;
  return matchesLegacyCategory(f, cats, mods);
}

function hasPartyAwareScoreMapping(f: Finding): boolean {
  const affected = String(f.affected_party ?? "").toLowerCase();
  const benefited = String(f.benefited_party ?? "").toLowerCase();
  return (
    (affected === "defense" || affected === "prosecution" || affected === "both") &&
    (benefited === "defense" || benefited === "prosecution") &&
    Boolean(String(f.score_dimension ?? "").trim()) &&
    Boolean(String(f.reason_for_score_effect ?? "").trim()) &&
    Boolean(f.evidence_refs?.some((ref) => String(ref.quote ?? "").trim()))
  );
}

export function findingScoringDirection(f: Finding): "strengthens" | "weakens" | "neutral" | "auto" {
  const explicit = String(f.impact_direction ?? "").toLowerCase();
  const audit = String(f.audit_classification ?? "").toUpperCase();
  const proposition = String(f.proposition_type ?? "").toLowerCase();
  const adoption = String(f.adoption_status ?? "").toLowerCase();

  // Classification takes precedence over producer-supplied polarity. A legal
  // rule, alleged gap, or adopted holding cannot become negative evidence
  // merely because the engine that surfaced it used "weakens".
  if (audit === "POTENTIAL_ISSUE" || audit === "EVIDENCE_GAP" || audit === "NOT_FOUND") return "neutral";
  if (audit === "VERIFIED_LEGAL_RULE" || proposition === "legal_rule") return "neutral";

  const adoptedHolding =
    audit === "VERIFIED_COURT_HOLDING" ||
    ((proposition === "holding" || proposition === "court_holding") && adoption === "adopted");
  if (adoptedHolding) {
    if (
      (explicit === "strengthens" || explicit === "weakens") &&
      hasPartyAwareScoreMapping(f)
    ) {
      return explicit;
    }
    return "neutral";
  }

  if (explicit === "strengthens" || explicit === "weakens" || explicit === "neutral") return explicit;
  return "auto";
}

export const PENAL_PERSPECTIVE_DIMENSIONS = [
  "prosecution_strength",
  "defense_strength",
  "evidentiary_integrity",
  "procedural_integrity",
  "constitutional_compliance",
  "conviction_stability",
  "reversal_risk",
  "documentation_reliability",
] as const;
export type PenalPerspectiveDimension = (typeof PENAL_PERSPECTIVE_DIMENSIONS)[number];

export type PenalPerspectiveScore = {
  score: number;
  contributors: Array<{
    source_finding_id: string;
    affected_party: Finding["affected_party"];
    benefited_party: Finding["benefited_party"];
    impact_direction: Finding["impact_direction"];
    reason_for_score_effect: string;
  }>;
};

export function computePenalPerspectiveScores(
  findings: readonly Finding[],
): Record<PenalPerspectiveDimension, PenalPerspectiveScore> {
  const baseline: Record<PenalPerspectiveDimension, number> = {
    prosecution_strength: 50,
    defense_strength: 50,
    evidentiary_integrity: 80,
    procedural_integrity: 80,
    constitutional_compliance: 80,
    conviction_stability: 50,
    reversal_risk: 20,
    documentation_reliability: 80,
  };
  const out = PENAL_PERSPECTIVE_DIMENSIONS.reduce(
    (scores, dimension) => {
      scores[dimension] = { score: baseline[dimension], contributors: [] };
      return scores;
    },
    {} as Record<PenalPerspectiveDimension, PenalPerspectiveScore>,
  );

  for (const finding of findings) {
    const dimension = String(finding.score_dimension ?? "") as PenalPerspectiveDimension;
    if (!PENAL_PERSPECTIVE_DIMENSIONS.includes(dimension)) continue;
    const direction = findingScoringDirection(finding);
    if (direction !== "strengthens" && direction !== "weakens") continue;
    if (!hasPartyAwareScoreMapping(finding)) continue;

    const confidence = Math.max(0, Math.min(1, Number(finding.confidence ?? 0)));
    const severity = SEVERITY_WEIGHT[finding.severity] ?? 5;
    const magnitude = Math.max(1, Math.min(18, Math.round(severity * confidence)));
    out[dimension].score = clamp(
      out[dimension].score + (direction === "strengthens" ? magnitude : -magnitude),
    );
    out[dimension].contributors.push({
      source_finding_id: finding.id,
      affected_party: finding.affected_party,
      benefited_party: finding.benefited_party,
      impact_direction: finding.impact_direction,
      reason_for_score_effect: String(finding.reason_for_score_effect),
    });
  }
  return out;
}

const CIVIL_DIMENSIONS = [
  "liability_strength", "causation_strength", "damages_exposure", "witness_reliability", "expert_support",
  "timeline_integrity", "documentation_reliability", "discovery_compliance", "litigation_risk",
  "settlement_pressure", "procedural_integrity", "evidence_strength",
];

const CASE_TYPE_DIMENSIONS: Record<string, string[]> = {
  penal: ["evidence_strength", "witness_reliability", "timeline_integrity", "chain_of_custody", "constitutional_compliance", "investigation_completeness", "discovery_completeness", "forensic_reliability", "procedural_integrity"],
  constitucional: ["evidence_strength", "witness_reliability", "constitutional_compliance", "investigation_completeness", "discovery_completeness", "procedural_integrity", "documentation_reliability"],
  amparo: ["evidence_strength", "timeline_integrity", "constitutional_compliance", "procedural_integrity", "documentation_reliability"],
  civil: CIVIL_DIMENSIONS,
  mercantil: CIVIL_DIMENSIONS,
  familiar: ["evidence_strength", "witness_reliability", "timeline_integrity", "documentation_reliability", "procedural_integrity"],
  laboral: ["evidence_strength", "witness_reliability", "liability_strength", "damages_exposure", "documentation_reliability", "procedural_integrity", "litigation_risk"],
  fiscal: ["evidence_strength", "documentation_reliability", "procedural_integrity", "litigation_risk"],
  administrativo: ["evidence_strength", "documentation_reliability", "procedural_integrity", "litigation_risk"],
  electoral: ["evidence_strength", "documentation_reliability", "procedural_integrity"],
  agrario: ["evidence_strength", "witness_reliability", "liability_strength", "documentation_reliability", "procedural_integrity"],
  ambiental: ["evidence_strength", "documentation_reliability", "procedural_integrity", "litigation_risk", "expert_support"],
  inmobiliario: ["evidence_strength", "documentation_reliability"],
  apelacion: ["evidence_strength", "timeline_integrity", "procedural_integrity", "documentation_reliability"],
  criminal: ["evidence_strength", "witness_reliability", "timeline_integrity", "chain_of_custody", "constitutional_compliance", "investigation_completeness", "discovery_completeness", "forensic_reliability", "procedural_integrity"],
  civil_rights: ["evidence_strength", "witness_reliability", "timeline_integrity", "constitutional_compliance", "investigation_completeness", "discovery_completeness", "procedural_integrity", "liability_strength", "damages_exposure", "litigation_risk"],
  medical_malpractice: CIVIL_DIMENSIONS,
  personal_injury: CIVIL_DIMENSIONS,
  employment: CIVIL_DIMENSIONS,
  family: ["evidence_strength", "witness_reliability", "timeline_integrity", "documentation_reliability", "procedural_integrity"],
  appellate: ["evidence_strength", "timeline_integrity", "procedural_integrity", "documentation_reliability"],
  general_civil: CIVIL_DIMENSIONS,
  tax_law: CIVIL_DIMENSIONS,
};

const DEFAULT_DIMENSIONS = ["evidence_strength", "witness_reliability", "timeline_integrity", "documentation_reliability", "procedural_integrity"];

export function applicableDimensionsFor(
  caseType: string | undefined,
  proceduralVehicle?: string | null,
  underlyingMateria?: string | null,
): string[] {
  const vehicle = String(proceduralVehicle ?? "").toLowerCase().trim();
  if (caseType === "amparo") {
    if (vehicle === "amparo_indirecto" || vehicle === "indirecto") {
      return [
        "evidence_strength",
        "witness_reliability",
        "timeline_integrity",
        "constitutional_compliance",
        "procedural_integrity",
        "documentation_reliability",
      ];
    }
    if (vehicle === "amparo_directo_revision" || vehicle === "amparo_en_revision") {
      return [
        "evidence_strength",
        "constitutional_compliance",
        "procedural_integrity",
        "documentation_reliability",
      ];
    }
  }
  if (caseType === "inmobiliario") {
    if (vehicle === "inmobiliario_litigio") {
      return [
        "evidence_strength",
        "witness_reliability",
        "liability_strength",
        "damages_exposure",
        "documentation_reliability",
        "procedural_integrity",
        "litigation_risk",
      ];
    }
  }
  return CASE_TYPE_DIMENSIONS[caseType ?? "general_civil"] ?? DEFAULT_DIMENSIONS;
}

export function gateDimensionForCaseType(
  key: string,
  applicable: ReadonlySet<string>,
  value: number | null,
): number | null {
  return applicable.has(key) ? value : null;
}

export function scrubScoringContributors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arr: any[],
  opts: { criminalLike: boolean; validFindingIds: ReadonlySet<string> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  const offDomainLabel =
    /(conviction|appeal|chain of custody|cadena de custodia|miranda|4th amendment|5th amendment|6th amendment|search and seizure|grand jury|indictment|brady|giglio|informe policial homologado|medidas cautelares|control de detenci[oó]n|carpeta de investigaci[oó]n)/i;
  return arr.filter(
    (c) =>
      (opts.criminalLike || !offDomainLabel.test(String(c?.label ?? ""))) &&
      typeof c?.finding_id === "string" &&
      opts.validFindingIds.has(c.finding_id),
  );
}

export function computeDeterministicScorecard(
  rawFindings: Finding[],
  caseType?: string,
  proceduralVehicle?: string | null,
  underlyingMateria?: string | null,
): DeterministicScorecard {
  const findings = excludeRejectedFromScoring(rawFindings);
  const applicable = new Set(applicableDimensionsFor(caseType, proceduralVehicle, underlyingMateria));
  const dims: Record<string, DimensionScore> = {};

  for (const [key, def] of Object.entries(DIMENSIONS)) {
    if (!applicable.has(key)) continue;
    const positives: ScoreContributor[] = [];
    const negatives: ScoreContributor[] = [];

    for (const f of findings) {
      const pos = matches(f, key, def.positive.categories, def.positive.modules);
      const neg = matches(f, key, def.negative.categories, def.negative.modules);
      const direction = findingScoringDirection(f);

      if (direction === "neutral") continue;
      const canStrengthen = direction !== "weakens";
      const canWeaken = direction !== "strengthens";

      if ((direction === "strengthens" || (direction === "auto" && pos && !neg)) && canStrengthen) {
        positives.push({
          finding_id: f.id,
          title: f.title,
          category: f.category,
          severity: f.severity,
          confidence: f.confidence,
          affected_party: f.affected_party,
          signed_weight: signedWeight(f, 1),
        });
      } else if ((direction === "weakens" || (direction === "auto" && neg)) && canWeaken) {
        negatives.push({
          finding_id: f.id,
          title: f.title,
          category: f.category,
          severity: f.severity,
          confidence: f.confidence,
          affected_party: f.affected_party,
          signed_weight: signedWeight(f, -1),
        });
      }
    }

    const posTotal = positives.reduce((a, c) => a + c.signed_weight, 0);
    const negTotal = negatives.reduce((a, c) => a + c.signed_weight, 0);
    const rawDelta = posTotal + negTotal;
    const posDecayed = decayedSum(positives.map((c) => c.signed_weight));
    const negDecayed = decayedSum(negatives.map((c) => c.signed_weight));
    const decayedDelta = posDecayed + negDecayed;
    const score = clamp(Math.round(def.baseline + decayedDelta));

    dims[key] = {
      dimension: def.label,
      score,
      baseline: def.baseline,
      raw_delta: Math.round(rawDelta * 100) / 100,
      decayed_delta: Math.round(decayedDelta * 100) / 100,
      positive_weight_total: Math.round(posTotal * 100) / 100,
      negative_weight_total: Math.round(negTotal * 100) / 100,
      contributor_count: positives.length + negatives.length,
      positives: positives.sort((a, b) => b.signed_weight - a.signed_weight).slice(0, 10),
      negatives: negatives.sort((a, b) => a.signed_weight - b.signed_weight).slice(0, 10),
      reasoning:
        positives.length + negatives.length === 0
          ? `No score-eligible findings mapped to ${def.label}. Score held at baseline ${def.baseline}.`
          : `baseline(${def.baseline}) + decayed_positive_total(${posDecayed.toFixed(1)}) + decayed_negative_total(${negDecayed.toFixed(1)}) = clamp(${(def.baseline + decayedDelta).toFixed(1)}, 0, 100) = ${score}. Raw (undecayed) contributor sum was ${rawDelta.toFixed(1)}.`,
      formula: `score = clamp(baseline + Σ(rank_i: severity_weight * confidence * polarity * ${DECAY_RATE}^i), 0, 100)`,
    };
  }

  const confidenceRows = findings.filter((f) => {
    const audit = String(f.audit_classification ?? "").toUpperCase();
    return audit !== "POTENTIAL_ISSUE" && audit !== "EVIDENCE_GAP" && audit !== "NOT_FOUND";
  });
  const denominator = confidenceRows.length || 1;
  const avgConf = confidenceRows.reduce((a, f) => a + (f.confidence ?? 0.5), 0) / denominator;

  return {
    methodology: `Deterministic verified-finding scoring (case_type=${caseType ?? "general_civil"}). Court holdings and legal rules are not treated as defects merely because their category names a constitutional/procedural doctrine. Potential issues, evidence gaps and NOT_FOUND items are excluded from score movement unless later promoted to a verified finding with an explicit impact direction.`,
    generated_at: new Date().toISOString(),
    finding_count: findings.length,
    dimensions: dims,
    overall_confidence: Number(avgConf.toFixed(2)),
    formula_notes: [
      `score = clamp(baseline + Σ(rank_i: severity_weight * confidence * polarity * ${DECAY_RATE}^i), 0, 100)`,
      "verified court holdings/legal rules are neutral unless an explicit impact_direction is supplied",
      "POTENTIAL_ISSUE, EVIDENCE_GAP and NOT_FOUND do not move scores",
      "severity weights: critical=25, high=15, medium=8, low=3, info=1",
      `applicable dimensions for ${caseType ?? "general_civil"}: ${[...applicable].join(", ")}`,
    ],
  };
}

export function confidenceLabel(value: number | null | undefined): "High" | "Medium" | "Low" | "Unknown" {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unknown";
  const v = value > 1 ? value / 100 : value;
  if (v >= 0.75) return "High";
  if (v >= 0.45) return "Medium";
  return "Low";
}

export function likelihoodFromScores(strength: number, risk: number): "Low" | "Moderate" | "High" {
  const net = strength - risk;
  if (net >= 20) return "High";
  if (net <= -20) return "Low";
  return "Moderate";
}

export type DecomposedRiskDimensions = {
  legal_precedent_risk: { score: number; factors: string[] };
  procedural_risk: { score: number; factors: string[] };
  evidentiary_risk: { score: number; factors: string[] };
  strategic_enforcement_risk: { score: number; factors: string[] };
};

export type DecomposedRiskScore = {
  overall_risk_score: number;
  band: "low" | "medium" | "high" | "critical";
  dimensions: DecomposedRiskDimensions;
  factors: Array<{ label: string; delta: number }>;
};

export function computeDecomposedRiskScore(
  findings: readonly Finding[],
  posture?: ProceduralPosture | null,
): DecomposedRiskScore {
  let legalRisk = 0;
  const legalFactors: string[] = [];
  let procRisk = 0;
  const procFactors: string[] = [];
  let evidRisk = 0;
  const evidFactors: string[] = [];
  let stratRisk = 0;
  const stratFactors: string[] = [];

  for (const f of findings) {
    const direction = findingScoringDirection(f);
    const cat = String(f.category ?? "").toLowerCase();
    const isHolding = f.proposition_type === "holding" || (f as any).audit_classification === "VERIFIED_COURT_HOLDING";
    const isAdopted = f.adoption_status === "adopted";
    const sevWeight = SEVERITY_WEIGHT[f.severity] ?? 3;
    const conf = Math.max(0, Math.min(1, Number(f.confidence ?? 0.8)));
    const delta = Math.round((sevWeight * conf) / 2);

    // Hard Rule: Adopted court holding with neutral impact NEVER increases risk
    if (isHolding && isAdopted && direction === "neutral") {
      continue;
    }

    if (direction === "weakens" || f.impact_direction === "undermining") {
      if (cat.includes("constitutional") || cat.includes("precedent") || cat.includes("jurisprudencia") || isHolding) {
        legalRisk += delta;
        legalFactors.push(`${f.title} (+${delta})`);
      } else if (cat.includes("procedural") || cat.includes("violacion_procesal") || cat.includes("cadena_custodia") || cat.includes("deadline")) {
        procRisk += delta;
        procFactors.push(`${f.title} (+${delta})`);
      } else if (cat.includes("evidence") || cat.includes("contradiction") || cat.includes("witness") || cat.includes("missing")) {
        evidRisk += delta;
        evidFactors.push(`${f.title} (+${delta})`);
      } else {
        stratRisk += delta;
        stratFactors.push(`${f.title} (+${delta})`);
      }
    }
  }

  // Cap dimensions to [0, 100]
  legalRisk = Math.min(100, legalRisk);
  procRisk = Math.min(100, procRisk);
  evidRisk = Math.min(100, evidRisk);
  stratRisk = Math.min(100, stratRisk);

  const overall = Math.round(
    legalRisk * 0.35 + procRisk * 0.25 + evidRisk * 0.25 + stratRisk * 0.15,
  );
  const band = overall >= 75 ? "critical" : overall >= 50 ? "high" : overall >= 25 ? "medium" : "low";

  const allFactors: Array<{ label: string; delta: number }> = [
    ...legalFactors.map((l) => ({ label: `[Legal] ${l}`, delta: 0 })),
    ...procFactors.map((p) => ({ label: `[Procedural] ${p}`, delta: 0 })),
    ...evidFactors.map((e) => ({ label: `[Evidentiary] ${e}`, delta: 0 })),
    ...stratFactors.map((s) => ({ label: `[Strategic] ${s}`, delta: 0 })),
  ];

  return {
    overall_risk_score: overall,
    band,
    dimensions: {
      legal_precedent_risk: { score: legalRisk, factors: legalFactors },
      procedural_risk: { score: procRisk, factors: procFactors },
      evidentiary_risk: { score: evidRisk, factors: evidFactors },
      strategic_enforcement_risk: { score: stratRisk, factors: stratFactors },
    },
    factors: allFactors,
  };
}
