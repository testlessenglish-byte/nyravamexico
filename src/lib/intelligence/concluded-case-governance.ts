/**
 * Concluded Case Report Governance Engine - Hard Platform Contract
 *
 * Central authority for report governance across all materias, jurisdictions,
 * and case types.
 *
 * Invariants:
 * 1. Concluded case -> strategy_output_allowed = false, recommendation_policy = "verification_only".
 *    It is mathematically impossible to resolve to full_strategic unless explicit
 *    post_judgment_options_analysis mode was selected by the user.
 * 2. Disposition outranks severity.
 * 3. Party allegations can NEVER be presented as adopted judicial determinations.
 * 4. Final governance validation is a blocking gate for report release.
 */

export type CaseGovernanceMode =
  | "active_litigation"
  | "concluded_decision_audit"
  | "post_judgment_options";

export type RecommendationPolicy = "verification_only" | "suppressed" | "full_strategic";

export interface ImmutableReportGovernance {
  governance_mode: CaseGovernanceMode;
  is_concluded: boolean;
  strategy_output_allowed: boolean;
  recommendation_policy: RecommendationPolicy;
  decision_core_priority: boolean;
  speaker_role_labels_required: boolean;
  post_judgment_strategy_allowed: boolean;
  disposition_required: boolean;
  legal_effect_required: boolean;
  remedy_exhaustion_verified: boolean;
  final_governance_validation_required: boolean;
  report_section_order: string[];
  resolved_at: string;
  execution_id?: string;
}

export const CONCLUDED_REPORT_SECTION_ORDER: string[] = [
  "resultado_del_asunto",
  "puntos_resolutivos",
  "cuestion_controlante",
  "determinacion_adoptada",
  "efecto_de_la_resolucion",
  "argumentos_analizados",
  "hallazgos_secundarios",
  "contexto_probatorio_procesal",
];

export const ACTIVE_LITIGATION_SECTION_ORDER: string[] = [
  "executive_summary",
  "attorney_summary",
  "investigator_summary",
  "case_overview",
  "legal_theories",
  "recommended_motions",
  "strategy_recommendations",
  "next_actions",
];

export interface CaseGovernanceContext {
  procedural_posture?: string | { case_status?: string; is_final_resolution?: boolean } | null;
  case_analysis_mode?: string | null;
  analysis_mode?: string | null;
  matter_metadata?: Record<string, unknown> | null;
  is_final_resolution?: boolean | null;
  post_judgment_options_analysis?: boolean | null;
  remedy_exhaustion_verified?: boolean | null;
  resolutivos?: string | null;
  corpusText?: string | null;
  execution_id?: string;
}

/**
 * Single authoritative governance resolver for the entire platform.
 * Enforces the strict 3-way precedence:
 *   1. post_judgment_options (if explicitly requested)
 *   2. concluded_decision_audit (if case is concluded)
 *   3. active_litigation (ongoing matters)
 */
export function resolveReportGovernance(ctx: CaseGovernanceContext): ImmutableReportGovernance {
  const rawPosture = ctx.procedural_posture ?? ctx.matter_metadata?.procedural_posture;
  const posture = String(typeof rawPosture === "object" && rawPosture ? (rawPosture as { case_status?: string }).case_status : rawPosture ?? "").toLowerCase().trim();
  const caseAnalysisMode = String(ctx.case_analysis_mode ?? ctx.matter_metadata?.case_analysis_mode ?? "").toLowerCase().trim();
  const analysisMode = String(ctx.analysis_mode ?? "").toLowerCase().trim();
  const isFinal = Boolean(ctx.is_final_resolution);
  const allowPostJudgment = ctx.post_judgment_options_analysis === true ||
    ctx.matter_metadata?.post_judgment_options_analysis === true ||
    caseAnalysisMode === "post_judgment_options_analysis";
  const remedyExhaustionVerified = Boolean(ctx.remedy_exhaustion_verified ?? ctx.matter_metadata?.remedy_exhaustion_verified);
  const now = new Date().toISOString();

  const isConcluded =
    posture === "concluded" ||
    caseAnalysisMode === "concluded_audit" ||
    caseAnalysisMode === "judgment_audit" ||
    isFinal;

  // Precedence 1: Explicit Post-Judgment Options Analysis
  if (allowPostJudgment) {
    return {
      governance_mode: "post_judgment_options",
      is_concluded: true,
      strategy_output_allowed: true,
      recommendation_policy: "full_strategic",
      decision_core_priority: true,
      speaker_role_labels_required: true,
      post_judgment_strategy_allowed: true,
      disposition_required: true,
      legal_effect_required: true,
      remedy_exhaustion_verified: remedyExhaustionVerified,
      final_governance_validation_required: true,
      report_section_order: CONCLUDED_REPORT_SECTION_ORDER,
      resolved_at: now,
      execution_id: ctx.execution_id,
    };
  }

  // Precedence 2: Concluded Case - Decision Audit (Zero Active-Litigation Strategy)
  if (isConcluded) {
    return {
      governance_mode: "concluded_decision_audit",
      is_concluded: true,
      strategy_output_allowed: false,
      recommendation_policy: "verification_only",
      decision_core_priority: true,
      speaker_role_labels_required: true,
      post_judgment_strategy_allowed: false,
      disposition_required: true,
      legal_effect_required: true,
      remedy_exhaustion_verified: remedyExhaustionVerified,
      final_governance_validation_required: true,
      report_section_order: CONCLUDED_REPORT_SECTION_ORDER,
      resolved_at: now,
      execution_id: ctx.execution_id,
    };
  }

  // Precedence 3: Ongoing Active Litigation
  return {
    governance_mode: "active_litigation",
    is_concluded: false,
    strategy_output_allowed: true,
    recommendation_policy: analysisMode === "strict" ? "verification_only" : "full_strategic",
    decision_core_priority: false,
    speaker_role_labels_required: false,
    post_judgment_strategy_allowed: false,
    disposition_required: false,
    legal_effect_required: false,
    remedy_exhaustion_verified: false,
    final_governance_validation_required: false,
    report_section_order: ACTIVE_LITIGATION_SECTION_ORDER,
    resolved_at: now,
    execution_id: ctx.execution_id,
  };
}

// Backward-compatible alias
export const detectConcludedCaseGovernance = resolveReportGovernance;
export type ConcludedCaseGovernance = ImmutableReportGovernance;

export type SpeakerRoleBadge =
  | "DETERMINACIÓN ADOPTADA POR EL TRIBUNAL REVISOR"
  | "DETERMINACIÓN ADOPTADA POR SCJN"
  | "DETERMINACIÓN DEL TRIBUNAL INFERIOR"
  | "ARGUMENTO DEL QUEJOSO"
  | "ARGUMENTO DE LA AUTORIDAD RESPONSABLE"
  | "ARGUMENTO DEL TERCERO INTERESADO"
  | "ARGUMENTO / ALEGACIÓN DE PARTE"
  | "AGRAVIO RECHAZADO / INOPERANTE"
  | "CUESTIÓN NO ESTUDIADA"
  | "HECHO PROCESAL"
  | "RESOLUTIVO"
  | "ESTATUS JURÍDICO NO RESUELTO"
  | "CUESTIÓN RESUELTA POR EL TRIBUNAL"
  | "CUESTIÓN NO RESUELTA POR EL TRIBUNAL"
  | "CUESTIÓN DISPUTADA POR LAS PARTES"
  | "NO VERIFICADO INDEPENDIENTEMENTE"
  | "SIN EVIDENCIA SUFICIENTE EN EL CORPUS"
  | "NO DETERMINADO"
  | "PENDIENTE DE RESOLUCIÓN";

/**
 * Resolves the mandatory visible speaker-role classification badge for a proposition.
 * HARD INVARIANT: Party allegations can NEVER be tagged as judicial determinations.
 */
export function formatSpeakerRoleBadge(
  finding: Record<string, unknown>,
  courtLevel?: string | null,
): SpeakerRoleBadge {
  const kind = String(
    finding.mandatory_decision_kind ?? finding.kind ?? finding.category ?? "",
  ).toUpperCase();
  const auditClass = String(finding.audit_classification ?? "").toUpperCase();
  const propType = String(finding.proposition_type ?? "").toLowerCase();
  const adoptStatus = String(finding.adoption_status ?? "").toLowerCase();
  const speaker = String(finding.speaker_role ?? "").toLowerCase();
  const title = String(finding.title ?? "");

  // 1. Resolutivo
  if (kind === "DISPOSITION" || /puntos?\s+resolutivos?|se\s+resuelve|resolutivo/i.test(title)) {
    return "RESOLUTIVO";
  }

  // 2. Hard Invariant: Party allegations not adopted by the court must NEVER be DETERMINACIÓN JUDICIAL
  const isPartySpeaker =
    speaker === "quejoso" ||
    speaker === "recurrente" ||
    speaker === "apelante" ||
    speaker === "defensa" ||
    speaker === "ministerio_publico" ||
    speaker === "autoridad_responsable" ||
    speaker === "tercero_interesado" ||
    speaker === "party";

  if (isPartySpeaker && adoptStatus !== "adopted") {
    if (speaker === "quejoso" || speaker === "recurrente" || speaker === "apelante") {
      return "ARGUMENTO DEL QUEJOSO";
    }
    if (speaker === "autoridad_responsable") {
      return "ARGUMENTO DE LA AUTORIDAD RESPONSABLE";
    }
    if (speaker === "tercero_interesado") {
      return "ARGUMENTO DEL TERCERO INTERESADO";
    }
    return "ARGUMENTO / ALEGACIÓN DE PARTE";
  }

  // 3. Adopted by reviewing court / SCJN
  if (
    auditClass === "VERIFIED_COURT_HOLDING" ||
    (propType === "holding" && adoptStatus === "adopted") ||
    kind === "COURT_HOLDING" || (kind === "REMEDY" && adoptStatus === "adopted")
  ) {
    if (courtLevel === "scjn" || /(?:^|\b)(scjn|suprema corte)/i.test(speaker)) {
      return "DETERMINACIÓN ADOPTADA POR SCJN";
    }
    return "DETERMINACIÓN ADOPTADA POR EL TRIBUNAL REVISOR";
  }

  // 4. Rejected or inoperante
  if (
    adoptStatus === "rejected" ||
    adoptStatus === "unstudied" ||
    kind === "REJECTED_HOLDING" ||
    /inoperante|infundado|desestimado|sin estudio/i.test(title)
  ) {
    if (adoptStatus === "unstudied" || /sin estudio|no estudiada/i.test(title)) {
      return "CUESTIÓN NO ESTUDIADA";
    }
    return "AGRAVIO RECHAZADO / INOPERANTE";
  }

  // 5. Lower court holding
  if (
    speaker === "lower_court" ||
    speaker === "tribunal_inferior" ||
    speaker === "juez_distrito" ||
    speaker === "tribunal_colegiado_a_quo"
  ) {
    return "DETERMINACIÓN DEL TRIBUNAL INFERIOR";
  }

  // 6. Party arguments fallback
  if (propType === "argument" || auditClass === "PARTY_ALLEGATION" || /alega|plantea|sostiene|aduce/i.test(title)) {
    return "ARGUMENTO / ALEGACIÓN DE PARTE";
  }

  // 7. Procedural fact
  if (propType === "fact" || auditClass === "PROCEDURAL_FACT" || kind === "PROCEDURAL_FACT") {
    return "HECHO PROCESAL";
  }

  if (adoptStatus === "pending" || /pendiente|sub judice/i.test(title)) return "PENDIENTE DE RESOLUCIÓN";
  if (adoptStatus === "disputed" || auditClass === "DISPUTED") return "CUESTIÓN DISPUTADA POR LAS PARTES";
  if (adoptStatus === "unresolved" || /no resuelt/i.test(title)) return "CUESTIÓN NO RESUELTA POR EL TRIBUNAL";
  if (auditClass === "NOT_FOUND" || auditClass === "EVIDENCE_GAP" || /insuficiente/i.test(title)) return "SIN EVIDENCIA SUFICIENTE EN EL CORPUS";
  if (auditClass === "UNVERIFIED" || /no verificado/i.test(title)) return "NO VERIFICADO INDEPENDIENTEMENTE";
  if (adoptStatus === "resolved") return "CUESTIÓN RESUELTA POR EL TRIBUNAL";

  return "NO DETERMINADO";
}

/**
 * Calculates priority score for finding representation in concluded matters.
 * Invariant: Disposition > Remedy/Effect > Controlling Issue > Holding > Rejected > Allegations > Severity.
 */
export const DECISION_CORE_KIND_ORDER = ["DISPOSITION", "RESOLUTIVOS", "CONTROLLING_ISSUE", "COURT_HOLDING", "REMEDY"] as const;

export function getFindingConcludedPriority(f: Record<string, unknown>): number {
  const metadata = (f.metadata ?? {}) as Record<string, unknown>;
  const kind = String(f.mandatory_decision_kind ?? metadata.mandatory_decision_kind ?? f.kind ?? "").toUpperCase();
  const index = (DECISION_CORE_KIND_ORDER as readonly string[]).indexOf(kind);
  if (index >= 0) return 10000 - index * 100;
  const severity = {critical:40, high:30, medium:20, low:10} as Record<string,number>;
  return severity[String(f.severity)] ?? 0;
}

/**
 * Sorts findings for concluded report.
 * Ensures disposition outranks severity.
 */
export function sortFindingsForConcludedReport<T extends Record<string, unknown>>(
  findings: ReadonlyArray<T>,
  governance: ImmutableReportGovernance,
): T[] {
  if (!governance.is_concluded || !governance.decision_core_priority) {
    const sevRank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 } as Record<string, number>;
    return [...findings].sort((a, b) => (sevRank[String(b.severity)] ?? 0) - (sevRank[String(a.severity)] ?? 0));
  }

  return [...findings].sort((a, b) => {
    const prioA = getFindingConcludedPriority(a);
    const prioB = getFindingConcludedPriority(b);
    return prioB - prioA;
  });
}


const INTERNAL_ENGINE_PHRASES = [
  /Mandatory,?\s*source-verified\s*proposition/gi,
  /Must\s*be\s*represented\s*in\s*the\s*completed-case\s*report/gi,
  /Source-verified\s*proposition/gi,
  /internal\s*QA/gi,
  /finding\s*is\s*mandatory/gi,
];

export function sanitizeEngineLanguage(text: string): string {
  let cleaned = sanitizeEngineLanguage(text);
  for (const rx of INTERNAL_ENGINE_PHRASES) {
    cleaned = cleaned.replace(rx, "");
  }
  return cleaned.replace(/\s{2,}/g, " ").trim();
}


const SPECULATIVE_LITIGATION_PHRASES = [
  /\bpodr[ií]a\s+llevar\s+a\s+la\s+revocaci[oó]n\b/gi,
  /\bpodr[ií]a\s+obtener\s+la\s+nulidad\b/gi,
  /\bpreparar\s+amparo\s+indirecto\b/gi,
  /\bfortalecer\s+la\s+posici[oó]n\s+del\s+quejoso\b/gi,
  /\bel\s+quejoso\s+se\s+queda\s+sin\s+v[ií]as\s+de\s+defensa\b/gi,
  /\bpromover\s+incidente\s+de\s+nulidad\b/gi,
  /\bno\s+quedan\s+recursos\s+disponibles\b/gi,
  /\bla\s+condena\s+ya\s+no\s+puede\s+impugnarse\b/gi,
];

/**
 * Sanitizes prose text in a concluded audit report, eliminating speculative litigation phrasing
 * and unverified global-exhaustion claims.
 */
export function sanitizeConcludedReportProse(
  text: string,
  governance: ImmutableReportGovernance,
): string {
  if (!governance.is_concluded || governance.strategy_output_allowed) {
    return text;
  }

  let cleaned = sanitizeEngineLanguage(text);

  // Substitute overbroad conclusion unless explicitly verified
  if (!governance.remedy_exhaustion_verified) {
    cleaned = cleaned.replace(
      /el\s+quejoso\s+se\s+queda\s+sin\s+v[ií]as\s+de\s+defensa|no\s+quedan\s+recursos\s+disponibles|la\s+condena\s+ya\s+no\s+puede\s+impugnarse/gi,
      "el recurso de revisión analizado fue desechado y la sentencia recurrida quedó firme en este procedimiento",
    );
  }

  for (const rx of SPECULATIVE_LITIGATION_PHRASES) {
    cleaned = cleaned.replace(rx, "");
  }

  return cleaned.replace(/\s{2,}/g, " ").trim();
}

/**
 * Filters out active-litigation sections and enforces verification-only naming on concluded reports.
 */
export function filterConcludedReportSections(
  fullReport: Record<string, unknown>,
  governance: ImmutableReportGovernance,
): Record<string, unknown> {
  if (!governance.is_concluded || governance.strategy_output_allowed) {
    return fullReport;
  }

  const report = { ...fullReport };

  // Suppress substantive litigation arrays
  delete report.ways_out_analysis;
  delete report.settlement_opportunities;
  delete report.litigation_strategy;
  delete report.trial_strategy;
  delete report.defense_strategy;
  delete report.prosecution_strategy;
  delete report.future_motions;
  delete report.case_opportunities;
  delete report.urgent_actions;

  // Filter recommendations to verification-only
  const rawRecs = Array.isArray(report.canonical_recommendations)
    ? report.canonical_recommendations
    : [];

  const verificationOnlyRecs = rawRecs.filter((r: any) => {
    const text = `${r.title ?? ""} ${r.action ?? ""} ${r.reason ?? ""}`.toLowerCase();
    return (
      /verificar|cotejar|confirmar|constatar|revisar\s+engrose|expediente/i.test(text) &&
      !/presentar|interponer|promover|demandar|denunciar/i.test(text)
    );
  });

  report.canonical_recommendations = verificationOnlyRecs;
  report.recommended_actions_title = "PASOS DE VERIFICACIÓN DOCUMENTAL";

  return report;
}

export interface FinalGovernanceValidation {
  ok: boolean;
  blocking_errors: string[];
  warnings: string[];
  checked_rules: Record<string, boolean>;
  generated_at: string;
}

/**
 * @deprecated Intermediate compatibility validator. Production release uses
 * reporting/final-report-contract.ts against the exact renderer payload.
 * Final Governance Validation Gate.
 * Deterministically verifies that a report adheres to all concluded-case governance rules
 * before release.
 */
export function validateFinalReportGovernance(input: {
  governance: ImmutableReportGovernance;
  fullReport: Record<string, unknown>;
  findings: ReadonlyArray<Record<string, unknown>>;
}): FinalGovernanceValidation {
  const { governance, fullReport, findings } = input;
  const blocking: string[] = [];
  const warnings: string[] = [];
  const checkedRules: Record<string, boolean> = {};
  const now = new Date().toISOString();

  // If not a concluded audit, validation automatically passes
  if (!governance.is_concluded || governance.governance_mode !== "concluded_decision_audit") {
    return {
      ok: true,
      blocking_errors: [],
      warnings: [],
      checked_rules: { ongoing_governance_valid: true },
      generated_at: now,
    };
  }

  // Check 1: Concluded governance resolved
  checkedRules.concluded_governance_resolved = governance.governance_mode === "concluded_decision_audit";
  if (!checkedRules.concluded_governance_resolved) {
    blocking.push("Concluded case did not resolve to concluded_decision_audit governance mode.");
  }

  // Check 2: Active strategy suppressed
  const hasForbiddenStrategy =
    fullReport.ways_out_analysis != null ||
    fullReport.settlement_opportunities != null ||
    fullReport.trial_strategy != null ||
    fullReport.litigation_strategy != null ||
    fullReport.defense_strategy != null ||
    fullReport.prosecution_strategy != null;

  checkedRules.strategy_output_present = !hasForbiddenStrategy;
  if (hasForbiddenStrategy) {
    blocking.push("Report contains forbidden active-litigation strategy sections in a concluded decision audit.");
  }

  // Check 3: Party allegations misclassified as judicial holding
  let partyMisclassified = false;
  for (const f of findings) {
    const speaker = String(f.speaker_role ?? "").toLowerCase();
    const adopt = String(f.adoption_status ?? "").toLowerCase();
    const auditClass = String(f.audit_classification ?? "").toUpperCase();
    if ((speaker === "quejoso" || speaker === "recurrente" || speaker === "party") && adopt !== "adopted") {
      if (auditClass === "VERIFIED_COURT_HOLDING") {
        partyMisclassified = true;
        break;
      }
    }
  }
  checkedRules.party_allegation_misclassified_as_holding = !partyMisclassified;
  if (partyMisclassified) {
    blocking.push("A party allegation is misclassified as a VERIFIED_COURT_HOLDING without court adoption.");
  }

  // Check 4: Decision core priority
  checkedRules.decision_core_first = governance.decision_core_priority === true;

  // Check 5: Disposition present
  const hasDisposition = findings.some(
    (f) =>
      String(f.mandatory_decision_kind ?? "").toUpperCase() === "DISPOSITION" ||
      /resolutiv|desech|confirmad|revocad|ampara|niega/i.test(String(f.title ?? "")),
  );
  checkedRules.disposition_present = hasDisposition;
  if (!hasDisposition) {
    warnings.push("No explicit DISPOSITION finding identified in concluded report findings.");
  }

  // Check 6: Legal effect present
  const hasEffect = findings.some(
    (f) =>
      String(f.mandatory_decision_kind ?? "").toUpperCase() === "REMEDY" ||
      /efecto|firme|reenv[ií]o/i.test(String(f.title ?? "")),
  );
  checkedRules.legal_effect_present = hasEffect;

  // Check 7: Limited mode contract obeyed
  const recTitle = String(fullReport.recommended_actions_title ?? "");
  const hasStrategicRecTitle = /pr[oó]ximas\s+acciones\s+recomendadas/i.test(recTitle);
  checkedRules.limited_mode_contract_obeyed = !hasStrategicRecTitle;
  if (hasStrategicRecTitle) {
    blocking.push("Report contains 'PRÓXIMAS ACCIONES RECOMENDADAS' title in a concluded decision audit.");
  }

  // Check 8: Overbroad exhaustion claims
  const rawText = JSON.stringify(fullReport).toLowerCase();
  const hasOverbroadClaim =
    !governance.remedy_exhaustion_verified &&
    (/el quejoso se queda sin vias de defensa/i.test(rawText) || /no quedan recursos disponibles/i.test(rawText));
  checkedRules.overbroad_remedy_exhaustion_claims = !hasOverbroadClaim;
  if (hasOverbroadClaim) {
    blocking.push("Report contains overbroad remedy-exhaustion claims without verified legal basis.");
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
