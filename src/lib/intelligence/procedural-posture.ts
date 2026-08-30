// Procedural Posture Model & Constraint Engine
//
// Invariant: Strategy, missing-evidence, deadlines, opportunities, and
// next-action generators must be strictly bound by the procedural posture of
// the analyzed corpus.
//
// A concluded judicial resolution (e.g. an executoria from SCJN or a Tribunal
// Colegiado) must never invent prospective litigation actions (such as
// "collect testimony before hearing" or "prepare for trial") when no pending
// hearing or filing deadline exists.

export type PostureCaseStatus =
  | "pending"
  | "concluded"
  | "remanded"
  | "enforcement"
  | "unknown";

export type MissingEvidenceBucket =
  | "missing_for_understanding_the_decision"
  | "missing_for_reconstructing_underlying_record"
  | "missing_for_future_litigation";

export interface ProceduralPosture {
  case_status: PostureCaseStatus;
  decision_type: string | null;
  court_level: string | null;
  current_stage: string | null;
  next_stage: string | null;
  is_final_resolution: boolean;
  is_historical_record: boolean;
  remand_ordered: boolean;
  remand_target: string | null;
  open_deadlines_supported: boolean;
}

export function detectProceduralPosture(input: {
  caseRow?: Record<string, unknown> | null;
  corpusText?: string;
  resolutivos?: string | null;
  materia?: string | null;
}): ProceduralPosture {
  const text = (input.corpusText ?? "").toLowerCase();
  const resolutivos = (input.resolutivos ?? "").toLowerCase();
  const rawMode = String(input.caseRow?.case_analysis_mode ?? "");

  const hasSCJN = /suprema corte|scjn|primera sala|segunda sala|pleno de la suprema corte/i.test(text);
  const hasColegiado = /tribunal colegiado|primer tribunal colegiado|segundo tribunal colegiado/i.test(text);
  const hasDistrito = /juez de distrito|juzgado de distrito/i.test(text);
  const hasEjecutoria = /ejecutoria|amparo directo en revision|recurso de revision|sentencia definitiva/i.test(text);

  const remandOrdered =
    /devuelvanse los autos|devuelvanse|remitase al tribunal colegiado|remitanse los autos|para los efectos precisados/i.test(
      resolutivos || text,
    );

  const isConcludedMode =
    rawMode === "concluded_audit" ||
    rawMode === "judgment_audit" ||
    /revoca la sentencia|confirma la sentencia|sobresee|ampara y protege|niega el amparo/i.test(resolutivos);

  const isFinalResolution = hasEjecutoria || isConcludedMode || (hasSCJN && !/demanda inicial|auto de admision/i.test(text));

  let caseStatus: PostureCaseStatus = "unknown";
  if (remandOrdered) {
    caseStatus = "remanded";
  } else if (isFinalResolution) {
    caseStatus = "concluded";
  } else if (/en tramite|pendiente de resolucion|citacion para sentencia/i.test(text)) {
    caseStatus = "pending";
  } else if (isConcludedMode) {
    caseStatus = "concluded";
  } else {
    caseStatus = "pending";
  }

  let courtLevel: string | null = null;
  if (hasSCJN) courtLevel = "scjn";
  else if (hasColegiado) courtLevel = "tribunal_colegiado";
  else if (hasDistrito) courtLevel = "juzgado_distrito";
  else if (/tribunal de apelacion|sala penal|sala civil/i.test(text)) courtLevel = "segunda_instancia";
  else courtLevel = "primera_instancia";

  let decisionType: string | null = null;
  if (/amparo directo en revision/i.test(text)) {
    decisionType = "ejecutoria_amparo_directo_en_revision";
  } else if (/amparo directo/i.test(text)) {
    decisionType = "sentencia_amparo_directo";
  } else if (/amparo indirecto/i.test(text)) {
    decisionType = "sentencia_amparo_indirecto";
  } else if (/sentencia definitiva/i.test(text)) {
    decisionType = "sentencia_definitiva";
  } else if (/auto de vinculacion/i.test(text)) {
    decisionType = "auto_vinculacion_a_proceso";
  }

  let remandTarget: string | null = null;
  if (remandOrdered) {
    const targetMatch = text.match(/al (primer|segundo|tercer|cuarto)?\s*tribunal colegiado[^,\n\.]*/i);
    if (targetMatch) {
      remandTarget = targetMatch[0].trim();
    } else if (hasColegiado) {
      remandTarget = "Tribunal Colegiado de Circuito de origen";
    }
  }

  return {
    case_status: caseStatus,
    decision_type: decisionType,
    court_level: courtLevel,
    current_stage: caseStatus === "remanded" ? "cumplimiento_ejecutoria" : isFinalResolution ? "resolucion_emitida" : "instruccion",
    next_stage: remandOrdered ? "emision_nueva_resolucion_por_colegiado" : isFinalResolution ? null : "audiencia",
    is_final_resolution: isFinalResolution,
    is_historical_record: isFinalResolution || rawMode.startsWith("concluded"),
    remand_ordered: remandOrdered,
    remand_target: remandTarget,
    open_deadlines_supported: !isFinalResolution && caseStatus === "pending",
  };
}

/**
 * Filter and sanitize recommendations / next actions based on procedural posture.
 * Concluded decisions cannot recommend future evidentiary collection or hearing preparations.
 */
export function sanitizeActionsForPosture<T extends { action?: string; title?: string; description?: string }>(
  actions: T[],
  posture: ProceduralPosture,
): T[] {
  if (!posture.is_final_resolution && posture.case_status === "pending") {
    return actions;
  }

  const FORBIDDEN_FUTURE_ACTION_PATTERNS = [
    /recopilar testimonios/i,
    /antes de la audiencia/i,
    /preparar testigos/i,
    /desahogar pruebas/i,
    /interponer recurso de amparo/i,
    /presentar demanda/i,
    /ofrecer pruebas/i,
    /solicitar al juez de control la extension/i,
    /actualice la cadena de custodia/i,
  ];

  return actions.filter((act) => {
    const text = [act.action, act.title, act.description].filter(Boolean).join(" ");
    return !FORBIDDEN_FUTURE_ACTION_PATTERNS.some((pattern) => pattern.test(text));
  });
}

/**
 * Classify missing evidence into distinct epistemic buckets.
 */
export function categorizeMissingEvidence(
  item: string,
  posture: ProceduralPosture,
): MissingEvidenceBucket {
  if (posture.is_final_resolution) {
    if (/sentencia|resolucion|ejecutoria|resolutivo|voto particular/i.test(item)) {
      return "missing_for_understanding_the_decision";
    }
    return "missing_for_reconstructing_underlying_record";
  }
  return "missing_for_future_litigation";
}

/**
 * Format a hard constraint prompt block for upstream analyzers and agents
 * to prevent generation of active-trial / future-hearing actions on concluded matters.
 */
export function formatPosturePromptConstraint(
  posture: ProceduralPosture,
  locale: "en" | "es" = "es",
): string {
  if (posture.is_final_resolution) {
    const decType = posture.decision_type ?? (posture.court_level === "scjn" ? "ejecutoria de la SCJN" : "sentencia definitiva");
    if (locale === "es") {
      return [
        `[POSTURA PROCESAL OBLIGATORIA: RESOLUCIÓN CONCLUIDA / ${decType.toUpperCase()}]`,
        `Este caso corresponde a una resolución judicial emitida/concluida (${decType}), NO a un juicio en trámite.`,
        `- PROHIBIDO proponer acciones preparatorias de juicio, recolección prospectiva de testimonios, preparación de testigos o solicitudes de pruebas para audiencias futuras (ej. "recopilar testimonios antes de la audiencia", "preparar testigos", "solicitar descubrimiento").`,
        `- Limitar el análisis a la legalidad, motivación, violaciones y resolutivos de la resolución analizada.${posture.remand_ordered ? " Dado que se ordenó reposición/devolución, las acciones deben limitarse estrictamente al cumplimiento de la ejecutoria ordenada." : ""}`,
      ].join("\n");
    }
    return [
      `[MANDATORY PROCEDURAL POSTURE: CONCLUDED RESOLUTION / ${decType.toUpperCase()}]`,
      `This matter represents a concluded judicial resolution (${decType}), NOT an active pending trial.`,
      `- STRICTLY FORBIDDEN: Generating forward-looking trial preparation, witness gathering, or evidence requests for future hearings.`,
      `- Analysis must strictly focus on the legality, errors, holdings, and dispositive result of the decided resolution.${posture.remand_ordered ? " Actions must strictly relate to compliance with the remand order." : ""}`,
    ].join("\n");
  }
  return "";
}
