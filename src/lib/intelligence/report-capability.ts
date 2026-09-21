/**
 * Report Capability Contract & LIMITED Mode Engine
 *
 * Central platform authority defining allowed and prohibited capabilities
 * across all report modes, case types, and export renderers.
 *
 * Invariant: LIMITED is a platform capability state, not a visual label.
 * What LIMITED says is suppressed is technically impossible to publish.
 */

export type OutputContentClass =
  | "VERIFIED_FACT"
  | "VERIFIED_HOLDING"
  | "PROCEDURAL_EVENT"
  | "PARTY_ARGUMENT"
  | "DOCUMENT_GAP"
  | "VERIFICATION_STEP"
  | "STRATEGIC_RECOMMENDATION"
  | "SCORE"
  | "PROBABILITY"
  | "LEGAL_THEORY"
  | "FUTURE_LITIGATION_STRATEGY"
  | "SETTLEMENT_STRATEGY"
  | "RECOMMENDED_MOTION"
  | "DRAFT_WORK_PRODUCT"
  | "SPECULATIVE_REMEDY";

export const LIMITED_ALLOWED_CLASSES: ReadonlySet<OutputContentClass> = new Set([
  "VERIFIED_FACT",
  "VERIFIED_HOLDING",
  "PROCEDURAL_EVENT",
  "PARTY_ARGUMENT",
  "DOCUMENT_GAP",
  "VERIFICATION_STEP",
]);

export const LIMITED_PROHIBITED_CLASSES: ReadonlySet<OutputContentClass> = new Set([
  "STRATEGIC_RECOMMENDATION",
  "SCORE",
  "PROBABILITY",
  "LEGAL_THEORY",
  "FUTURE_LITIGATION_STRATEGY",
  "SETTLEMENT_STRATEGY",
  "RECOMMENDED_MOTION",
  "DRAFT_WORK_PRODUCT",
  "SPECULATIVE_REMEDY",
]);

export interface ReportCapability {
  mode: "LIMITED" | "FULL";
  scoring_allowed: boolean;
  probability_estimates_allowed: boolean;
  strategic_recommendations_allowed: boolean;
  future_litigation_strategy_allowed: boolean;
  motion_drafting_allowed: boolean;
  theory_of_case_allowed: boolean;
  settlement_strategy_allowed: boolean;
  verified_facts_allowed: boolean;
  verified_holdings_allowed: boolean;
  labeled_party_arguments_allowed: boolean;
  document_gaps_allowed: boolean;
  verification_steps_allowed: boolean;
  source_citations_required: boolean;
  final_limited_validation_required: boolean;
  authority_sufficiency: "sufficient" | "limited" | "insufficient";
  record_completeness: "complete" | "partial" | "limited" | "minimal";
  resolved_at: string;
  execution_id?: string;
}

export interface CaseCapabilityContext {
  analysis_mode?: string | null;
  case_analysis_mode?: string | null;
  procedural_posture?: string | null;
  ess_bin?: string | null;
  allowQuantitativeScores?: boolean | null;
  allowMotionGeneration?: boolean | null;
  allowLegalTheories?: boolean | null;
  hasVerifiedCourtHolding?: boolean | null;
  post_judgment_options_analysis?: boolean | null;
  execution_id?: string;
}

/**
 * Single authoritative capability resolver for the entire platform.
 */
export function resolveReportCapability(ctx: CaseCapabilityContext): ReportCapability {
  const analysisMode = String(ctx.analysis_mode ?? "").toLowerCase().trim();
  const caseAnalysisMode = String(ctx.case_analysis_mode ?? "").toLowerCase().trim();
  const posture = String(ctx.procedural_posture ?? "").toLowerCase().trim();
  const essBin = String(ctx.ess_bin ?? "").toLowerCase().trim();
  const allowScores = ctx.allowQuantitativeScores !== false;
  const allowPostJudgment = Boolean(ctx.post_judgment_options_analysis);
  const hasCourtHolding = Boolean(ctx.hasVerifiedCourtHolding);
  const now = new Date().toISOString();

  const isLimited =
    analysisMode === "strict" ||
    essBin === "minimal" ||
    !allowScores ||
    ((caseAnalysisMode === "concluded_audit" || caseAnalysisMode === "judgment_audit" || posture === "concluded") && !allowPostJudgment);

  if (isLimited) {
    return {
      mode: "LIMITED",
      scoring_allowed: false,
      probability_estimates_allowed: false,
      strategic_recommendations_allowed: false,
      future_litigation_strategy_allowed: false,
      motion_drafting_allowed: false,
      theory_of_case_allowed: false,
      settlement_strategy_allowed: false,
      verified_facts_allowed: true,
      verified_holdings_allowed: true,
      labeled_party_arguments_allowed: true,
      document_gaps_allowed: true,
      verification_steps_allowed: true,
      source_citations_required: true,
      final_limited_validation_required: true,
      authority_sufficiency: hasCourtHolding ? "sufficient" : "limited",
      record_completeness: essBin === "minimal" ? "minimal" : "limited",
      resolved_at: now,
      execution_id: ctx.execution_id,
    };
  }

  return {
    mode: "FULL",
    scoring_allowed: true,
    probability_estimates_allowed: true,
    strategic_recommendations_allowed: true,
    future_litigation_strategy_allowed: true,
    motion_drafting_allowed: ctx.allowMotionGeneration !== false,
    theory_of_case_allowed: ctx.allowLegalTheories !== false,
    settlement_strategy_allowed: true,
    verified_facts_allowed: true,
    verified_holdings_allowed: true,
    labeled_party_arguments_allowed: true,
    document_gaps_allowed: true,
    verification_steps_allowed: true,
    source_citations_required: true,
    final_limited_validation_required: false,
    authority_sufficiency: "sufficient",
    record_completeness: "complete",
    resolved_at: now,
    execution_id: ctx.execution_id,
  };
}

export const BANNED_LIMITED_HEADINGS: ReadonlyArray<{ rx: RegExp; label: string }> = [
  { rx: /\bpr[oó]ximas\s+acciones\s+recomendadas\b/i, label: "PRÓXIMAS ACCIONES RECOMENDADAS" },
  { rx: /\brecomendaciones\s+estrat[eé]gicas\b/i, label: "RECOMENDACIONES ESTRATÉGICAS" },
  { rx: /\bestrategia\s+procesal\b/i, label: "ESTRATEGIA PROCESAL" },
  { rx: /\bmovimientos\s+recomendados\b/i, label: "MOVIMIENTOS RECOMENDADOS" },
  { rx: /\bteor[ií]a\s+del\s+caso\b/i, label: "TEORÍA DEL CASO" },
  { rx: /\bprobabilidad\s+de\s+[eé]xito\b/i, label: "PROBABILIDAD DE ÉXITO" },
  { rx: /\brecommended\s+next\s+actions\b/i, label: "RECOMMENDED NEXT ACTIONS" },
  { rx: /\bstrategic\s+recommendations\b/i, label: "STRATEGIC RECOMMENDATIONS" },
  { rx: /\blitigation\s+strategy\b/i, label: "LITIGATION STRATEGY" },
  { rx: /\brecommended\s+motions\b/i, label: "RECOMMENDED MOTIONS" },
  { rx: /\btheory\s+of\s+the\s+case\b/i, label: "THEORY OF THE CASE" },
  { rx: /\bprobability\s+of\s+success\b/i, label: "PROBABILITY OF SUCCESS" },
];

/**
 * Classifies an item into an OutputContentClass.
 */
export function classifyOutputContent(item: Record<string, unknown>): OutputContentClass {
  const kind = String(item.mandatory_decision_kind ?? item.kind ?? "").toUpperCase();
  const auditClass = String(item.audit_classification ?? "").toUpperCase();
  const propType = String(item.proposition_type ?? "").toLowerCase();
  const title = String(item.title ?? "").toLowerCase();
  const action = String(item.action ?? "").toLowerCase();
  const text = `${title} ${action} ${String(item.reason ?? "")}`.toLowerCase();

  if (kind === "COURT_HOLDING" || auditClass === "VERIFIED_COURT_HOLDING" || propType === "holding") {
    return "VERIFIED_HOLDING";
  }
  if (kind === "DISPOSITION" || /puntos?\s+resolutivos?|desechado|confirmada/i.test(title)) {
    return "VERIFIED_HOLDING";
  }
  if (propType === "argument" || auditClass === "PARTY_ALLEGATION" || /alega|plantea|sostiene/i.test(title)) {
    return "PARTY_ARGUMENT";
  }
  if (propType === "fact" || auditClass === "PROCEDURAL_FACT") {
    return "PROCEDURAL_EVENT";
  }
  if (/falta|omisi[oó]n|documento\s+faltante|brecha/i.test(title) || item.what_is_missing != null) {
    return "DOCUMENT_GAP";
  }
  if (/verificar|cotejar|confirmar|constatar|revisar\s+engrose/i.test(text) && !/presentar|interponer|promover|demandar/i.test(text)) {
    return "VERIFICATION_STEP";
  }
  if (/presentar|interponer|promover|demandar|apelar|denunciar|estrategia/i.test(text)) {
    return "STRATEGIC_RECOMMENDATION";
  }
  if (item.score != null || item.case_strength != null || item.risk_score != null) {
    return "SCORE";
  }
  if (item.win_probability != null || item.probability != null) {
    return "PROBABILITY";
  }

  return "VERIFIED_FACT";
}

/**
 * Hard-sanitizes a report payload according to the ReportCapability contract.
 * Strips prohibited arrays, suppresses outcome scores, and cleans headings.
 */
export function sanitizeLimitedReportPayload(
  fullReport: Record<string, unknown>,
  capability: ReportCapability,
  locale: "es" | "en" = "es",
): Record<string, unknown> {
  if (capability.mode !== "LIMITED") {
    return fullReport;
  }

  const report = { ...fullReport };

  // 1. Suppress all prohibited strategic arrays
  delete report.ways_out_analysis;
  delete report.settlement_opportunities;
  delete report.litigation_strategy;
  delete report.trial_strategy;
  delete report.defense_strategy;
  delete report.prosecution_strategy;
  delete report.future_motions;
  delete report.recommended_motions;
  delete report.case_opportunities;
  delete report.urgent_actions;
  delete report.legal_theories;
  delete report.theory_of_case;

  // 2. Suppress quantitative outcome scoring
  if (!capability.scoring_allowed) {
    delete report.case_strength;
    delete report.risk_score;
    delete report.win_probability;
    delete report.success_probability;
    delete report.motion_probability;
    delete report.settlement_probability;
    delete report.recommended_score;
  }

  // 3. Rename actions header to non-strategic verification
  report.recommended_actions_title =
    locale === "en" ? "DOCUMENTARY VERIFICATION STEPS" : "PASOS DE VERIFICACIÓN DOCUMENTAL";

  // 4. Filter recommendations to verification-only
  const rawRecs = Array.isArray(report.canonical_recommendations)
    ? report.canonical_recommendations
    : [];

  const verificationOnlyRecs = rawRecs
    .filter((r: any) => classifyOutputContent(r as Record<string, unknown>) === "VERIFICATION_STEP")
    .map((r: any) => ({
      ...r,
      content_class: "VERIFICATION_STEP",
    }));

  report.canonical_recommendations = verificationOnlyRecs;

  // 5. Clean missing evidence wording
  const rawMissing = Array.isArray(report.missing_evidence_struct)
    ? report.missing_evidence_struct
    : [];

  report.missing_evidence_struct = rawMissing.map((m: any) => {
    const rawDesc = String(m.description ?? m.what_is_missing ?? "");
    const safeDesc = rawDesc.replace(/\bno\s+existe\b/gi, locale === "en" ? "Not identified in the provided corpus" : "No identificado en el corpus aportado");
    return {
      ...m,
      description: safeDesc,
      what_is_missing: m.what_is_missing ? String(m.what_is_missing).replace(/\bno\s+existe\b/gi, locale === "en" ? "Not identified in the provided corpus" : "No identificado en el corpus aportado") : undefined,
    };
  });

  return report;
}

export interface FinalLimitedValidation {
  ok: boolean;
  blocking_errors: string[];
  warnings: string[];
  checked_rules: Record<string, boolean>;
  generated_at: string;
}

/**
 * Validates that a final released report satisfies all LIMITED contract rules.
 */
export function validateFinalLimitedContract(input: {
  capability: ReportCapability;
  fullReport: Record<string, unknown>;
}): FinalLimitedValidation {
  const { capability, fullReport } = input;
  const blocking: string[] = [];
  const warnings: string[] = [];
  const checkedRules: Record<string, boolean> = {};
  const now = new Date().toISOString();

  if (capability.mode !== "LIMITED") {
    return {
      ok: true,
      blocking_errors: [],
      warnings: [],
      checked_rules: { full_mode_valid: true },
      generated_at: now,
    };
  }

  // Rule 1: No strategic recommendations
  const rawRecs = Array.isArray(fullReport.canonical_recommendations) ? fullReport.canonical_recommendations : [];
  const hasStrategicRec = rawRecs.some((r: any) => classifyOutputContent(r as Record<string, unknown>) === "STRATEGIC_RECOMMENDATION");
  checkedRules.strategic_recommendations_present = !hasStrategicRec;
  if (hasStrategicRec) {
    blocking.push("Report contains strategic recommendations in LIMITED mode.");
  }

  // Rule 2: No banned strategic headings
  const reportString = JSON.stringify(fullReport);
  let foundBannedHeading: string | null = null;
  for (const { rx, label } of BANNED_LIMITED_HEADINGS) {
    if (rx.test(reportString)) {
      foundBannedHeading = label;
      break;
    }
  }
  checkedRules.prohibited_strategy_headings_present = foundBannedHeading === null;
  if (foundBannedHeading) {
    blocking.push(`Report contains prohibited strategic heading '${foundBannedHeading}' in LIMITED mode.`);
  }

  // Rule 3: No quantitative scores
  const hasScores =
    fullReport.case_strength != null ||
    fullReport.risk_score != null ||
    fullReport.win_probability != null ||
    fullReport.success_probability != null;
  checkedRules.scores_present = !hasScores;
  if (hasScores) {
    blocking.push("Report leaks quantitative scores or outcome probabilities in LIMITED mode.");
  }

  // Rule 4: No recommended motions
  const hasMotions = fullReport.recommended_motions != null && Array.isArray(fullReport.recommended_motions) && fullReport.recommended_motions.length > 0;
  checkedRules.recommended_motions_present = !hasMotions;
  if (hasMotions) {
    blocking.push("Report contains recommended motions in LIMITED mode.");
  }

  // Rule 5: Verification steps are non-strategic
  const allVerificationOnly = rawRecs.every((r: any) => classifyOutputContent(r as Record<string, unknown>) === "VERIFICATION_STEP");
  checkedRules.verification_steps_are_non_strategic = allVerificationOnly;
  if (!allVerificationOnly) {
    blocking.push("One or more recommendation items are not classified as non-strategic VERIFICATION_STEP.");
  }

  const ok = blocking.length === 0;

  return {
    ok,
    blocking_errors: blocking,
    warnings,
    checked_rules: checkedRules,
    generated_at: now,
  };
}
