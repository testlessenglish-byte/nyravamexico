import type { ReportCapability } from "./report-permissions";
import type { ImmutableReportGovernance } from "../intelligence/concluded-case-governance";

export type ContentClass = "VERIFIED_FACT" | "VERIFIED_HOLDING" | "PARTY_ARGUMENT" |
  "DOCUMENT_GAP" | "VERIFICATION_STEP" | "STRATEGIC_RECOMMENDATION" | "PROBABILITY" |
  "RECOMMENDED_REMEDY" | "HISTORICAL_REMEDY" | "LEGAL_THEORY";
export const fold = (value: unknown) => String(value ?? "").normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
export const probabilityText = /estimacion de probabilidad|probabilidad de exito|success probability|win probability|probability of success|(?:probabilidad|probability)\s*[:=]\s*\d|\d+(?:[.,]\d+)?\s*%\s*(?:de exito|chance of winning)/;
export const strategyText = /proximas acciones recomendadas|recommended next actions|importancia estrategica|futuras acciones legales|future legal actions|se recomienda investigar mas a fondo|podria (?:solicitar|promover|obtener la nulidad|considerar la nulidad)|remedio solicitado|(?:se recomienda|recomendamos|should|recommend)\s+(?:interponer|promover|impugnar|solicitar|file|appeal|settle)|(?:litigation|settlement|trial|defense) strategy|estrategia (?:de litigio|procesal|de defensa)|teoria del caso recomendada/;
export const absenceText = /\bno obra en el expediente\b|\bno existe\b/;
export const PROBABILITY_KEYS = new Set(["probability", "success_probability", "likelihood", "likelihood_percent",
  "likelihood_of_success", "win_probability", "likely_outcome", "probability_estimate", "success_chance"]);
export const REMEDY_KEYS = new Set(["remedy_sought", "recommended_remedy", "speculative_remedy"]);
export const QUOTE_KEYS = new Set(["quote", "source_quote", "verbatim_quote"]);
const forbiddenClasses = new Set(["STRATEGIC_RECOMMENDATION", "RECOMMENDED_REMEDY", "LEGAL_THEORY"]);
const record = (v: any): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v : {};
export function historicallyGrounded(row: Record<string, any>): boolean {
  return ["HISTORICAL_REMEDY", "PARTY_ARGUMENT"].includes(row.content_class) &&
    (row.historical === true || row.content_class === "HISTORICAL_REMEDY") &&
    [row.source_refs, row.evidence_refs, row.citations].some(refs => Array.isArray(refs) &&
      refs.some(ref => ref.quote && (ref.document_id || ref.canonical_source_id)));
}
export function verifiedAbsence(row: Record<string, any>, text: string): boolean {
  if (row.absence_verified === true) return true;
  return row.quote_verified === true && [row.citations, row.source_refs, row.evidence_refs].some(refs =>
    Array.isArray(refs) && refs.some(ref => ref.quote && fold(text).includes(fold(ref.quote)) &&
      (ref.document_id || ref.canonical_source_id)));
}
/** Absolute absence wording → qualified, scope-bounded wording. This does not
 * relax citation integrity: an absence statement that IS verified/cited never
 * reaches this helper, and a substantive factual claim is untouched. */
const ABSENCE_REWRITES: Array<[RegExp, string]> = [
  [/\bno obra(?:n)? en el expediente\b/gi, "no fue identificado en las constancias analizadas"],
  [/\bno consta(?:n)? en el expediente\b/gi, "no fue identificado en las constancias analizadas"],
  [/\bno existen?\s+(prueba|evidencia|constancia|elemento)(s?)\b/gi, "no se identificó en el material analizado $1$2"],
  [/\bno existe(?:n)?\b/gi, "el material analizado no acredita"],
  [/\bno hay (?:prueba|evidencia|constancia)s?\b/gi, "no se identificó evidencia en el material analizado"],
  [/\bno se encontr[oó]\b/gi, "no se identificó en las fuentes analizadas"],
  [/\bthere (?:is|are) no evidence(?: of)?\b/gi, "the materials reviewed do not establish"],
  [/\bno evidence exists\b/gi, "no supporting evidence was identified in the reviewed materials"],
  [/\bno authority was found\b/gi, "no supporting authority was identified in the sources analyzed"],
  [/\bthe record contains no\b/gi, "the available record does not establish the presence of"],
  [/\bno violation exists\b/gi, "the available record does not establish a violation"],
];

export function remediateAbsenceLanguage(text: string): { text: string; rewritten: boolean } {
  if (typeof text !== "string" || !text) return { text, rewritten: false };
  let out = text;
  for (const [rx, replacement] of ABSENCE_REWRITES) out = out.replace(rx, replacement);
  return { text: out, rewritten: out !== text };
}

export function contentRestriction(value: any, key: string, parent: Record<string, any>,
  capability: ReportCapability, governance: ImmutableReportGovernance): string | null {
  const row = record(value);
  const populated = value != null && value !== "" && (typeof value !== "object" || Object.keys(value).length > 0);
  const restricted = !capability.strategic_recommendations_allowed || !governance.strategy_output_allowed;
  if (!populated) return null;
  if (!capability.probabilities_allowed && (row.content_class === "PROBABILITY" || PROBABILITY_KEYS.has(key))) return "probabilitiesPresent";
  if (restricted && forbiddenClasses.has(row.content_class)) return "strategicRecommendationsPresent";
  if (restricted && REMEDY_KEYS.has(key) && !historicallyGrounded(parent)) return "recommendedMotionsPresent";
  if (typeof value !== "string" || QUOTE_KEYS.has(key)) return null;
  const text = fold(value);
  if (!capability.probabilities_allowed && probabilityText.test(text)) return "probabilitiesPresent";
  if (restricted && strategyText.test(text) && !historicallyGrounded(parent)) return "strategicRecommendationsPresent";
  if (absenceText.test(text) && !verifiedAbsence(parent, value)) return "unverifiedAbsencePresent";
  return null;
}

/** A display-only projection. Source quotations, extraction and canonical records are never rewritten. */
export function transformReportContent<T>(input: T, capability: ReportCapability, governance: ImmutableReportGovernance): T {
  const walk = (v: any, key = "", parent: Record<string, any> = {}): any => {
    const restriction = contentRestriction(v, key, parent, capability, governance);
    if (restriction) {
      if (restriction === "unverifiedAbsencePresent" && typeof v === "string")
        return v.replace(/no obra en el expediente|no existe/gi, "No identificada en el corpus aportado");
      if (typeof v === "string" && /discovery|missing|gap|evidence|how_to_obtain|why_critical/.test(key))
        return "La documentación no fue localizada en el corpus aportado. Verificar las constancias para reconstruir el historial procesal.";
      return undefined;
    }
    if (Array.isArray(v)) return v.map(x => walk(x, key, parent)).filter(x => x !== undefined);
    if (typeof v === "string" && !QUOTE_KEYS.has(key) && absenceText.test(fold(v)) &&
        parent.absence_verified !== true && verifiedAbsence(parent,v) && !/^según la fuente citada:/i.test(v))
      return "Según la fuente citada: " + v;
    if (!v || typeof v !== "object") return v;
    const row = { ...v };
    if (/missing_evidence_struct|evidence_gaps/.test(key) && row.item && row.absence_verified !== true &&
        !/corpus aportado|documentos analizados/i.test(row.item)) {
      row.item = "No identificada en el corpus aportado: " + String(row.item).replace(/^falta de\s+/i, "");
    }
    if (governance.governance_mode === "concluded_decision_audit" && row.how_to_obtain)
      row.how_to_obtain = "Verificar la constancia en los documentos aportados y cotejarla con el expediente oficial.";
    if (historicallyGrounded(row) && row.remedy_sought) {
      row.historical_remedy = { content_class: "HISTORICAL_REMEDY",
        title: "EFECTO O REMEDIO ANALIZADO EN EL PROCEDIMIENTO", text: row.remedy_sought,
        source_refs: row.source_refs ?? row.evidence_refs ?? row.citations };
      delete row.remedy_sought;
    }
    if (/missing_evidence_struct|evidence_gaps/.test(key) && !row.content_class) row.content_class = "DOCUMENT_GAP";
    return Object.fromEntries(Object.entries(row).flatMap(([k, x]) => {
      const result = walk(x, k, row);
      return result === undefined ? [] : [[k, result]];
    }));
  };
  return walk(input);
}
