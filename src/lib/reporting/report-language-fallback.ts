export type ReportLanguage = "es" | "en";

/** Deterministic report prose used when a materia does not receive a
 * constitutional-analysis section. Keep it localized at the point of
 * persistence so post-report QA never audits an English fallback in an
 * otherwise Spanish report. */
export function constitutionalAnalysisNotApplicable(locale: ReportLanguage): string {
  return locale === "es"
    ? "No hay evidencia suficiente para determinar la existencia de una cuestión constitucional. Esta materia no requiere un análisis constitucional específico."
    : "Insufficient evidence to determine whether a constitutional issue exists. This case type does not implicate constitutional analysis.";
}