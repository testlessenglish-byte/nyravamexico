/**
 * Report template localization — single-language report guarantee.
 *
 * The AI-generated narrative of a report is already written in the language
 * stored on the case (`cases.report_language`, resolved server-side by
 * getReportLocale() in src/lib/mexico-lock.ts, and stamped on the generated
 * row as `reports.generated_language`). The *template* around that narrative
 * — section headers, table column headers, labels, footers, page numbering,
 * disclaimers — must never be hardcoded English, or the PDF renders mixed
 * language (English "Executive Summary" above Spanish "Cadena de custodia…").
 *
 * This module is the template's translation layer. Every string the exporter
 * emits passes through `rt()`:
 *   - locale "en" → returned unchanged (English is the source language)
 *   - locale "es" → exact-match dictionary lookup, then pattern rules
 *   - unknown string (AI narrative, case names, quotes, citations) → passes
 *     through untouched, because it is already in the report's language
 *
 * It also owns the Mexican vocabulary layer: engine enum values, US-term
 * remediation (discovery → vacíos probatorios, plaintiff → quejoso/actor…),
 * dynamic procedural roles per materia, and the reasons shown when a section
 * or agent is skipped.
 *
 * Historical reports are never retranslated: the exporter reads
 * `reports.generated_language` first and only falls back to the case's
 * current `report_language` when the row predates that column.
 */

export type ReportLocale = "es" | "en";

/**
 * Exact-match template phrases. Keys are the English source strings emitted
 * by src/lib/export.ts (section headings, table headers, labels, scaffolding
 * sentences); values are the Mexican-Spanish equivalents. Mexican legal
 * proper names (SCJN, DOF, amparo, jurisprudencia) are never translated away.
 */
const ES: Record<string, string> = {
  // Found via a real generated report tonight — labels/tags that were never
  // wrapped in rt() at their call site, so they rendered raw English right
  // next to correctly-translated Spanish prose.
  "Evidence:": "Evidencia:",
  "Legal significance:": "Trascendencia jurídica:",
  "[FACT]": "[HECHO]",
  "Related findings:": "Hallazgos relacionados:",
  "LEGAL BASIS": "FUNDAMENTO LEGAL",
  STATUS: "ESTADO",
  "Critical Issues": "Cuestiones Críticas",
  "High-Priority Issues": "Cuestiones de Alta Prioridad",
  "Moderate Issues": "Cuestiones Moderadas",
  "Minor & Administrative Issues": "Cuestiones Menores y Administrativas",
  "Every citation below is verbatim from the case corpus. Use these to verify any claim in the report.":
    "Cada cita a continuación es textual del corpus del expediente. Úselas para verificar cualquier afirmación de este reporte.",
  "Grouped by severity so the issues most likely to affect the outcome are read first. Each finding lists a confidence level (how sure the classification is), an evidence strength (how well-sourced it is), and any related findings elsewhere in this report.":
    "Agrupados por gravedad para que las cuestiones con mayor probabilidad de incidir en el resultado se lean primero. Cada hallazgo indica un nivel de confianza (qué tan segura es la clasificación), una fuerza probatoria (qué tan sustentado está) y los hallazgos relacionados en otras partes de este reporte.",
  // statCards dashboard tile labels/values (executive summary metric grid)
  Scores: "Puntajes",
  Limited: "Limitado",
  Suppressed: "Suprimido",
  "Documents Analyzed": "Documentos Analizados",
  "Constitutional Issues": "Cuestiones Constitucionales",
  "Missing Evidence": "Evidencia Faltante",
  "Agents Producing Output": "Agentes con Resultados",
  "Engine Version": "Versión del Motor",
  Strong: "Sólida",
  Moderate: "Moderada",
  CONFIDENCE: "CONFIANZA",
  "EVIDENCE STRENGTH": "FUERZA PROBATORIA",
  EVIDENCE: "EVIDENCIA",
  REASON: "MOTIVO",
  INFO: "INFORMATIVA",
  SOURCES: "FUENTES",

  "ATTORNEY WORK PRODUCT  \u00b7  PRIVILEGED & CONFIDENTIAL":
    "PRODUCTO DE TRABAJO DEL ABOGADO  \u00b7  PRIVILEGIADO Y CONFIDENCIAL",
  "This case was analyzed in LIMITED mode because the available corpus did not meet the platform's Evidence Sufficiency Score (ESS) threshold required to support quantitative scoring or formal motion recommendations.":
    "Este expediente se analiz\u00f3 en modo LIMITADO porque el corpus disponible no alcanz\u00f3 el umbral del Puntaje de Suficiencia Probatoria (ESS) requerido para sustentar puntajes cuantitativos o recomendaciones formales de promociones.",
  "An evidence-grounded narrative is rendered below for every section in which the corpus supplied sufficient verbatim material. Sections that would otherwise rely on inferred legal theories \u2014 quantitative scorecards, motion drafting, theory selection, and prioritized recommendations \u2014 have been withheld so that no claim in this report rests on speculation.":
    "A continuaci\u00f3n se presenta una narrativa sustentada en evidencia para cada secci\u00f3n en la que el corpus aport\u00f3 material textual suficiente. Las secciones que depender\u00edan de teor\u00edas jur\u00eddicas inferidas \u2014 puntajes cuantitativos, redacci\u00f3n de promociones, selecci\u00f3n de teor\u00eda del caso y recomendaciones priorizadas \u2014 se retuvieron para que ninguna afirmaci\u00f3n de este reporte descanse en especulaci\u00f3n.",
  "confidence level (how sure the classification is), an evidence strength (how well-sourced it is), and any related findings elsewhere in this report.":
    "nivel de confianza (qu\u00e9 tan segura es la clasificaci\u00f3n), una fuerza probatoria (qu\u00e9 tan sustentado est\u00e1) y los hallazgos relacionados en otras partes de este reporte.",
  "This report was generated using Nyrava Intelligence\u2122 and is intended to support\u2014not replace\u2014professional legal judgment. Attorneys remain responsible for reviewing and verifying all findings, citations, scores, legal analysis, and drafted work product against the official source record before filing or relying upon this report.":
    "Este reporte fue generado con Nyrava Intelligence\u2122 y busca apoyar \u2014no sustituir\u2014 el criterio jur\u00eddico profesional. El abogado es responsable de revisar y verificar todos los hallazgos, citas, puntajes, an\u00e1lisis jur\u00eddico y producto de trabajo contra el expediente oficial antes de presentarlo o sustentarse en \u00e9l.",
  "Nyrava Legal Intelligence": "Nyrava Legal Intelligence",

  // ---- Section headings ----
  "Table of Contents": "Índice",
  "Executive Summary": "Resumen Ejecutivo",
  "Case Overview": "Panorama General del Expediente",
  "Jurisdiction Intelligence": "Inteligencia de Jurisdicción",
  "Procedural Posture": "Etapa Procesal",
  Facts: "Hechos",
  "Key Findings": "Hallazgos Clave",
  "Top Findings": "Hallazgos Principales",
  "Timeline Summary": "Resumen Cronológico",
  "Timeline Reconstruction": "Reconstrucción Cronológica",
  "Chronological Narrative": "Narrativa Cronológica",
  "Additional Verified Facts (Undated)": "Hechos Verificados Adicionales (sin fecha)",
  "Discovery Analysis": "Análisis de Vacíos Probatorios",
  "Evidence Map": "Mapa de Evidencia",
  "Evidence Coverage": "Cobertura Probatoria",
  "Evidence Intelligence": "Inteligencia de Evidencia",
  "Evidence Sources": "Fuentes de Evidencia",
  "Evidence Inventory": "Inventario Probatorio",
  "Contradiction Analysis": "Análisis de Contradicciones",
  "Constitutional Analysis": "Análisis Constitucional",
  "Legal Issues & Case Law": "Cuestiones Jurídicas y Jurisprudencia",
  "Witness Intelligence": "Inteligencia de Testigos",
  "Theory Analysis": "Análisis de Teorías del Caso",
  "Multi-Perspective Analysis": "Análisis Multiperspectiva",
  "Risk Analysis": "Análisis de Riesgos",
  "Case Scorecard": "Tarjeta de Evaluación del Caso",
  "Dimension Detail": "Detalle por Dimensión",
  "Deadlines & Prescription": "Plazos y Prescripción",
  Recommendations: "Recomendaciones",
  "Recommended Actions": "Acciones Recomendadas",
  "Recommended next actions": "Siguientes acciones recomendadas",
  "Immediate Recommended Actions": "Acciones Inmediatas Recomendadas",
  "Priority Recommendations": "Recomendaciones Prioritarias",
  "Recommended Motions": "Promociones Recomendadas",
  "Recommended Counter Strategy": "Estrategia de Contraataque Recomendada",
  "Strategic Opportunities": "Oportunidades Estratégicas",
  "Strategic Priorities": "Prioridades Estratégicas",
  "Strategic recommendations": "Recomendaciones estratégicas",
  "Strategy recommendations": "Recomendaciones de estrategia",
  "Strategy Synthesis": "Síntesis Estratégica",
  "Litigation Strategy Center": "Centro de Estrategia Litigiosa",
  "Litigation Impact Dashboard": "Panel de Impacto Litigioso",
  "Cross-Examination": "Interrogatorio y Contrainterrogatorio",
  "Attorney Action Center": "Centro de Acciones del Abogado",
  "Attorney Work Product": "Producto de Trabajo del Abogado",
  "Generated Work Product": "Producto de Trabajo Generado",
  "Audit Trail": "Registro de Auditoría",
  "Execution Manifest": "Manifiesto de Ejecución",
  "Agent Statistics": "Estadísticas de Agentes",
  "Appendix: Source Citations": "Anexo: Citas de Fuentes",
  "Missing or Needed Evidence": "Evidencia Faltante o Requerida",
  "Missing evidence": "Evidencia faltante",
  "Missing Documents": "Documentos Faltantes",
  "Motion opportunities": "Oportunidades de promoción",
  "Next actions": "Siguientes acciones",
  "Score reasoning": "Fundamento de la calificación",
  "Source documents": "Documentos fuente",
  "Legal standard": "Estándar jurídico",
  "Legal authority": "Fundamento legal",
  "Draft outline": "Esquema del borrador",
  "Failed documents": "Documentos con error",
  "Cross-domain (activated)": "Materia cruzada (activada)",
  Enabled: "Habilitado",
  Generated: "Generado",
  Engine: "Motor",
  Skipped: "Omitido",
  "Skipped — Not applicable to selected case type": "Omitido — No aplicable a la materia seleccionada",
  "Primary Defense": "Defensa Principal",
  "Primary Trial Theme": "Tema Central del Juicio",
  "Most Dangerous Witness": "Testigo Más Riesgoso",
  "Most Likely Defense Strategy": "Estrategia de Defensa Más Probable",
  "Biggest Trial Risk": "Mayor Riesgo en Juicio",
  "Biggest Weakness": "Mayor Debilidad",
  "Biggest Evidentiary Gap": "Mayor Vacío Probatorio",
  "Best Settlement Leverage": "Mejor Palanca de Negociación",
  "Winning the Case": "Cómo se Gana el Caso",
  "What Wins This Case?": "¿Qué gana este caso?",
  "What Could Lose This Case?": "¿Qué podría perder este caso?",
  "What Should Counsel Do This Week?": "¿Qué debe hacer el abogado esta semana?",
  "If I Were Lead Trial Counsel": "Si yo fuera el abogado principal",

  // ---- Common table headers / labels ----
  Date: "Fecha",
  Event: "Evento",
  Source: "Fuente",
  Document: "Documento",
  Documents: "Documentos",
  Page: "Página",
  Pages: "Páginas",
  Title: "Título",
  Description: "Descripción",
  Category: "Categoría",
  Severity: "Gravedad",
  Confidence: "Confianza",
  Status: "Estatus",
  Priority: "Prioridad",
  Urgency: "Urgencia",
  Impact: "Impacto",
  "Expected Impact": "Impacto esperado",
  Reason: "Motivo",
  Rationale: "Fundamento",
  Recommendation: "Recomendación",
  Role: "Rol",
  Name: "Nombre",
  Party: "Parte",
  Score: "Puntaje",
  Dimension: "Dimensión",
  Weight: "Ponderación",
  Notes: "Notas",
  Type: "Tipo",
  Citation: "Cita",
  Authority: "Fundamento",
  Deadline: "Plazo",
  "Days Remaining": "Días restantes",
  "Risk Level": "Nivel de riesgo",
  Witness: "Declarante",
  Witnesses: "Declarantes",
  Evidence: "Evidencia",
  Finding: "Hallazgo",
  Findings: "Hallazgos",
  "Findings (Total)": "Hallazgos (Total)",
  Contradiction: "Contradicción",
  Contradictions: "Contradicciones",
  Total: "Total",
  Summary: "Resumen",
  Overview: "Panorama general",
  Analysis: "Análisis",
  "Case Type": "Materia",
  Jurisdiction: "Jurisdicción",
  Court: "Órgano jurisdiccional",
  "Applicable Law": "Ley aplicable",
  "Relevant Jurisprudence": "Jurisprudencia relevante",
  "Current Procedural Stage": "Etapa procesal actual",
  "Completed Stages": "Etapas concluidas",
  "Next Stage": "Siguiente etapa",
  "Missing Requirements": "Requisitos faltantes",
  "Procedural Risks": "Riesgos procesales",
  Country: "País",
  State: "Entidad federativa",
  Procedure: "Procedimiento",
  "Legal Area": "Materia",
  "Not determined": "No determinado",
  "Not available": "No disponible",
  "None identified": "No se identificaron",
  Prepared: "Elaborado",
  "Prepared for": "Elaborado para",
  "Generated on": "Generado el",
  Confidential: "Confidencial",
  "Page %s of %s": "Página %s de %s",

  // ---- Data-value vocabulary (engine enums rendered inside cells) ----
  critical: "crítica",
  Critical: "Crítica",
  CRITICAL: "CRÍTICA",
  high: "alta",
  High: "Alta",
  HIGH: "ALTA",
  medium: "media",
  Medium: "Media",
  MEDIUM: "MEDIA",
  low: "baja",
  Low: "Baja",
  LOW: "BAJA",
  corroborating: "corroborante",
  Corroborating: "Corroborante",
  contradictory: "contradictoria",
  Contradictory: "Contradictoria",
  missing: "faltante",
  Missing: "Faltante",
  neutral: "neutral",
  Neutral: "Neutral",
  verified: "verificado",
  Verified: "Verificado",
  unverified: "no verificado",
  Unverified: "No verificado",
  pending: "pendiente",
  Pending: "Pendiente",
  completed: "concluido",
  Completed: "Concluido",
  both: "ambas partes",
  Both: "Ambas partes",
  unknown: "no determinado",
  Unknown: "No determinado",

  // ---- US concepts remediated to Mexican procedure ----
  Discovery: "Vacíos probatorios",
  discovery: "vacíos probatorios",
  "Discovery Violation": "Deficiencia probatoria",
  "Discovery violation": "Deficiencia probatoria",
  "Discovery Request": "Requerimiento probatorio",
  "Discovery Gap": "Omisión probatoria",
  "Chain of Custody": "Cadena de custodia",
  // 2026-07-31: litigation-impact.ts DIMENSION_DISPLAY titles — statCards()
  // runs every label through rt(), but most of these had no entry, so they
  // rendered in raw English inside an otherwise-Spanish "Panel de Impacto
  // Litigioso". "Chain of Custody" and "Evidence Strength" already worked
  // (exact entry / pattern match respectively); the rest did not.
  "Evidence Strength": "Fuerza Probatoria",
  "Witness Reliability": "Confiabilidad de Testigos",
  "Timeline Integrity": "Integridad Cronológica",
  "Constitutional Risk": "Riesgo Constitucional",
  "Investigation Completeness": "Integridad de la Investigación",
  "Discovery Completeness": "Integridad del Descubrimiento Probatorio",
  "Forensic Reliability": "Confiabilidad Forense",
  "Procedural Integrity": "Integridad Procesal",
  "Liability Confidence": "Confianza en la Responsabilidad",
  "Causation Strength": "Fuerza del Nexo Causal",
  "Damages Support": "Sustento de Daños",
  "Expert Witness Support": "Sustento Pericial",
  "Documentation Status": "Estado de la Documentación",
  "Discovery Compliance": "Cumplimiento del Descubrimiento Probatorio",
  "Litigation Risk": "Riesgo Litigioso",
  "Settlement Leverage": "Ventaja para Negociación",
  Deposition: "Declaración",
  deposition: "declaración",
  Pleadings: "Promociones",
  pleadings: "promociones",
  Complaint: "Demanda",
  "Motion for Summary Judgment": "Resolución anticipada del juicio",
  Motion: "Promoción",
  Motions: "Promociones",
  Jury: "Tribunal de enjuiciamiento",
  jury: "tribunal de enjuiciamiento",
  "Voir Dire": "Calificación del tribunal",
  Verdict: "Resolución",
  verdict: "resolución",
  Trial: "Juicio",
  Plaintiff: "Parte actora",
  plaintiff: "parte actora",
  Defendant: "Parte demandada",
  defendant: "parte demandada",
  Prosecution: "Ministerio Público",
  prosecution: "Ministerio Público",
  Prosecutor: "Ministerio Público",
  prosecutor: "Ministerio Público",
  Defense: "Defensa",
  defense: "defensa",

  // ---- Legal memorandum exporter (export-legal-memo.ts) ----
  "MEMORANDUM OF LAW": "MEMORANDO DE DERECHO",
  "EXECUTIVE SUMMARY": "RESUMEN EJECUTIVO",
  "STATEMENT OF FACTS": "RELACIÓN DE HECHOS",
  "I. Chronology": "I. Cronología",
  "II. Undisputed Facts": "II. Hechos No Controvertidos",
  "III. Disputed Facts": "III. Hechos Controvertidos",
  "LEGAL ANALYSIS": "ANÁLISIS JURÍDICO",
  "RECOMMENDED MOTIONS": "PROMOCIONES RECOMENDADAS",
  "EVIDENCE APPENDIX": "ANEXO PROBATORIO",
  "RISK MATRIX": "MATRIZ DE RIESGOS",
  "NEXT ACTIONS": "SIGUIENTES ACCIONES",
  "Untitled Issue": "Cuestión sin título",
  "Untitled Motion": "Promoción sin título",
  RULE: "NORMA",
  APPLICATION: "APLICACIÓN",
  CONCLUSION: "CONCLUSIÓN",
  "Supporting Evidence:": "Evidencia de sustento:",
  "Factual Basis:": "Fundamento fáctico:",
  "Draft Paragraph:": "Párrafo de borrador:",
  "Urgent Actions Required:": "Acciones urgentes requeridas:",
  "Bottom Line": "Conclusión general",
  "Legal Standard": "Estándar jurídico",
  "Likelihood of Success": "Probabilidad de éxito",
  "Key Quote": "Cita clave",
  Proves: "Acredita",
  Mitigation: "Mitigación",
  Probability: "Probabilidad",
  "Re: ": "Ref.: ",
  "Date: ": "Fecha: ",
  "Opposing view:": "Postura contraria:",
  "Attorney-reviewed work product. Nyrava Intelligence-generated draft — verify all citations before filing.":
    "Producto de trabajo revisado por el abogado. Borrador generado por Nyrava Intelligence — verifique todas las citas antes de presentarlo.",

  // ---- Jurisdiction Intelligence block ----
  "Legal Basis": "Fundamento legal",
  "Governing Court": "Órgano jurisdiccional",

  // ---- Priority action center (final section) ----
  "Action Center — Priority Recommendations": "Centro de Acciones — Recomendaciones Prioritarias",
  "Legal Basis / Authority": "Fundamento legal",
  "Expected impact": "Impacto esperado",
  "-Legal-Memo": "-Memorando-Legal",
  "Legal Memo": "Memorando Legal",

  // ---- Cover page, footers, status stamps and section blurbs ----
  // Found in the July 2026 production audit: these reached the PDF/DOCX
  // writer without a dictionary entry, so they rendered raw English inside
  // an otherwise Spanish report.
  "Untitled Case": "Caso sin título",
  "CASE INTELLIGENCE REPORT": "REPORTE DE INTELIGENCIA DEL CASO",
  "Confidential Attorney Work Product": "Producto de Trabajo del Abogado — Confidencial",
  "Evidence-grounded. Citation-audited. Built for sensitive legal intelligence workflows.":
    "Sustentado en evidencia. Citas auditadas. Diseñado para trabajo de inteligencia jurídica sensible.",
  "Draft — citation verification not passed. Attorney review required before reliance.":
    "Borrador — la verificación de citas no fue superada. Requiere revisión del abogado antes de utilizarse.",
  "Case Strength": "Fortaleza del Caso",
  "Risk Score": "Puntuación de Riesgo",
  "Work product": "Producto de trabajo",
  "Primary Evidence:": "Evidencia principal:",
  "PRIMARY EVIDENCE": "EVIDENCIA PRINCIPAL",
  "LIKELIHOOD OF SUCCESS": "PROBABILIDAD DE ÉXITO",
  "Draft Available": "Borrador disponible",
  "Requires Attorney Review": "Requiere revisión del abogado",
  "Not Yet Generated": "Aún no generado",
  "Limited Analysis": "Análisis Limitado",
  Complete: "Completo",
  "Limited Analysis · Scores Suppressed · Recommendations Suppressed":
    "Análisis Limitado · Puntajes Suprimidos · Recomendaciones Suprimidas",
  "Complete · Scores Enabled · Recommendations Enabled":
    "Completo · Puntajes Habilitados · Recomendaciones Habilitadas",
  "conf.": "conf.",
  "Starting point, not a finished answer. Verify anything you plan to rely on with Case AI, pull controlling authority in Case Law, and confirm the actual filing through Motion Drafting before treating this as ready.":
    "Punto de partida, no una respuesta terminada. Verifique con Case AI todo aquello en lo que pretenda sustentarse, obtenga el criterio obligatorio aplicable en Jurisprudencia y confirme la promoción efectiva en Redacción de Promociones antes de considerarlo listo.",
  "A case-type read on the deterministic scorecard below, framed as the questions an attorney asks first rather than as raw dimension names.":
    "Lectura por materia del tablero determinista siguiente, planteada como las preguntas que un abogado formula primero, en lugar de nombres de dimensiones en bruto.",
  "Document-by-document classification with confidence labels and legal impact.":
    "Clasificación documento por documento, con niveles de confianza e impacto jurídico.",
  "Independent analysis from each side of the dispute. All perspectives are produced regardless of which side counsel represents.":
    "Análisis independiente desde cada parte del litigio. Todas las perspectivas se generan con independencia de la parte que el abogado represente.",
  "Grouped by severity so the issues most likely to affect the outcome are read first. Each finding lists a ":
    "Agrupados por gravedad para que las cuestiones con mayor probabilidad de incidir en el resultado se lean primero. Cada hallazgo indica un ",
  "Also implicated in:": "También implicado en:",
  FACT: "HECHO",
  "EVIDENCE-BASED ANALYSIS": "ANÁLISIS SUSTENTADO EN EVIDENCIA",
  "STRATEGIC CONSIDERATION": "CONSIDERACIÓN ESTRATÉGICA",
  "HYPOTHESIS REQUIRES VERIFICATION": "HIPÓTESIS — REQUIERE VERIFICACIÓN",
  more: "más",
};

/**
 * Pattern rules applied after exact-match lookup, for strings the exporter
 * glues together at runtime ("Legal significance: …", "CRITICAL ISSUES (3)").
 * Each rule rewrites only the template fragment and leaves the interpolated
 * data (already in the report's language) untouched.
 */
const ES_PATTERNS: readonly { re: RegExp; to: string }[] = [
  { re: /^Legal significance:/i, to: "Trascendencia jurídica:" },
  { re: /^Legal authority:/i, to: "Fundamento legal:" },
  { re: /^Authority:/i, to: "Fundamento:" },
  { re: /^Basis:/i, to: "Fundamento:" },
  { re: /^Reason:/i, to: "Motivo:" },
  { re: /^Impact:/i, to: "Impacto:" },
  { re: /^Case type:/i, to: "Materia:" },
  { re: /^Jurisdiction:/i, to: "Jurisdicción:" },
  { re: /^Source:/i, to: "Fuente:" },
  { re: /^Sources:/i, to: "Fuentes:" },
  { re: /^Prepared for:/i, to: "Elaborado para:" },
  { re: /^Generated:/i, to: "Generado:" },
  { re: /^Confidence:/i, to: "Confianza:" },
  { re: /^Severity:/i, to: "Gravedad:" },
  { re: /^Priority:/i, to: "Prioridad:" },
  { re: /^Status:/i, to: "Estatus:" },
  { re: /^Skipped —/, to: "Omitido —" },
  { re: /^Skipped:/, to: "Omitido:" },
];

const REPLACERS: readonly { re: RegExp; fn: (m: RegExpMatchArray) => string }[] = [
  {
    re: /^Document corpus:\s*(\d+)\s+documents?\s+reviewed\.?$/i,
    fn: (m) => `Corpus documental: ${m[1]} documento(s) revisado(s).`,
  },
  { re: /^\((\d+)\s+pages?\)$/i, fn: (m) => `(${m[1]} páginas)` },
  { re: /^(\d+)\s+pages?$/i, fn: (m) => `${m[1]} páginas` },
  { re: /^(\d+)\s+documents?$/i, fn: (m) => `${m[1]} documentos` },
  { re: /^(\d+)\s+findings?$/i, fn: (m) => `${m[1]} hallazgos` },
  { re: /^Page\s+(\d+)\s+of\s+(\d+)$/i, fn: (m) => `Página ${m[1]} de ${m[2]}` },
  { re: /^CRITICAL ISSUES\s*\((\d+)\)$/i, fn: (m) => `CUESTIONES CRÍTICAS (${m[1]})` },
  { re: /^HIGH PRIORITY\s*\((\d+)\)$/i, fn: (m) => `PRIORIDAD ALTA (${m[1]})` },
  { re: /^MEDIUM PRIORITY\s*\((\d+)\)$/i, fn: (m) => `PRIORIDAD MEDIA (${m[1]})` },
  { re: /^LOW PRIORITY\s*\((\d+)\)$/i, fn: (m) => `PRIORIDAD BAJA (${m[1]})` },
  { re: /^conf\.?$/i, fn: () => "conf." },
  {
    re: /^Insufficient evidence to draft a facts narrative[.\u2026]*$/i,
    fn: () => "El corpus disponible no acredita hechos suficientes para redactar la narrativa fáctica.",
  },
  // 2026-07-31: litigation-impact.ts badge values ("Weak", "Moderate",
  // "Below Average", "Strong", "Low", "High", "Critical") get concatenated
  // with the numeric score before reaching rt() — e.g. "Weak - 39/100" —
  // so neither the exact-match dictionary nor a plain word lookup could
  // ever match. This catches the badge word and re-attaches the score.
  {
    re: /^(Strong|Moderate|Below Average|Weak|Low|High|Critical)\s*-\s*(.+)$/,
    fn: (m) => {
      const es: Record<string, string> = {
        Strong: "Sólida",
        Moderate: "Moderada",
        "Below Average": "Por Debajo del Promedio",
        Weak: "Débil",
        Low: "Bajo",
        High: "Alto",
        Critical: "Crítico",
      };
      return `${es[m[1]] ?? m[1]} - ${m[2]}`;
    },
  },
];

// ---------------------------------------------------------------------------
// Dynamic procedural roles — never hardcode "plaintiff"/"defendant".
// ---------------------------------------------------------------------------

export type ProceduralRoles = {
  /** Party that initiates the procedure. */
  initiating_es: string;
  initiating_en: string;
  /** Party that answers / whose act is challenged. */
  responding_es: string;
  responding_en: string;
  authority: string;
};

const ROLE_BY_MATERIA: Record<string, ProceduralRoles> = {
  amparo: {
    initiating_es: "Quejoso",
    initiating_en: "Amparo claimant",
    responding_es: "Autoridad responsable",
    responding_en: "Responsible authority",
    authority: "Ley de Amparo Art. 5",
  },
  derechos_humanos: {
    initiating_es: "Quejoso",
    initiating_en: "Claimant",
    responding_es: "Autoridad responsable",
    responding_en: "Responsible authority",
    authority: "CPEUM Art. 102 apartado B",
  },
  penal: {
    initiating_es: "Ministerio Público",
    initiating_en: "Ministerio Público",
    responding_es: "Imputado",
    responding_en: "Accused",
    authority: "CNPP Arts. 105 y 113",
  },
  laboral: {
    initiating_es: "Trabajador actor",
    initiating_en: "Employee claimant",
    responding_es: "Patrón demandado",
    responding_en: "Employer respondent",
    authority: "LFT Art. 689",
  },
  civil: {
    initiating_es: "Parte actora",
    initiating_en: "Claimant",
    responding_es: "Parte demandada",
    responding_en: "Respondent",
    authority: "CNPCF (partes en el juicio)",
  },
  familiar: {
    initiating_es: "Promovente",
    initiating_en: "Petitioner",
    responding_es: "Parte demandada",
    responding_en: "Respondent",
    authority: "CNPCF (materia familiar)",
  },
  mercantil: {
    initiating_es: "Parte actora",
    initiating_en: "Claimant",
    responding_es: "Parte demandada",
    responding_en: "Respondent",
    authority: "Código de Comercio Art. 1055",
  },
  fiscal: {
    initiating_es: "Parte actora (contribuyente)",
    initiating_en: "Taxpayer claimant",
    responding_es: "Autoridad demandada (SAT)",
    responding_en: "Respondent authority (SAT)",
    authority: "LFPCA Arts. 1 y 3",
  },
  administrativo: {
    initiating_es: "Parte actora",
    initiating_en: "Claimant",
    responding_es: "Autoridad demandada",
    responding_en: "Respondent authority",
    authority: "LFPCA Arts. 1 y 3",
  },
  apelacion: {
    initiating_es: "Apelante",
    initiating_en: "Appellant",
    responding_es: "Apelado",
    responding_en: "Appellee",
    authority: "Código procesal de la primera instancia (recurso de apelación)",
  },
};

const DEFAULT_ROLES: ProceduralRoles = {
  initiating_es: "Parte actora",
  initiating_en: "Claimant",
  responding_es: "Parte demandada",
  responding_en: "Respondent",
  authority: "Legislación procesal aplicable",
};

/** Resolve the procedural party roles that apply to a materia / case type. */
export function resolveProceduralRoles(materia: string | null | undefined): ProceduralRoles {
  if (!materia) return DEFAULT_ROLES;
  const key = String(materia)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (ROLE_BY_MATERIA[key]) return ROLE_BY_MATERIA[key];
  if (/amparo/.test(key)) return ROLE_BY_MATERIA.amparo;
  if (/penal|criminal/.test(key)) return ROLE_BY_MATERIA.penal;
  if (/labor|employment/.test(key)) return ROLE_BY_MATERIA.laboral;
  if (/fiscal|tax/.test(key)) return ROLE_BY_MATERIA.fiscal;
  if (/mercantil|commercial|corporate/.test(key)) return ROLE_BY_MATERIA.mercantil;
  if (/famil/.test(key)) return ROLE_BY_MATERIA.familiar;
  if (/administrativ/.test(key)) return ROLE_BY_MATERIA.administrativo;
  if (/appell|apelac/.test(key)) return ROLE_BY_MATERIA.apelacion;
  if (/civil/.test(key)) return ROLE_BY_MATERIA.civil;
  return DEFAULT_ROLES;
}

// ---------------------------------------------------------------------------
// Skip reasons — "Omitido" alone is never acceptable in an attorney report.
// ---------------------------------------------------------------------------

const SKIP_REASONS_ES: Record<string, string> = {
  not_applicable_materia: "No aplica a esta materia conforme al procedimiento seleccionado.",
  no_physical_evidence: "No existen indicios físicos en el expediente para ejecutar el análisis de cadena de custodia.",
  no_constitutional_issue: "No se detectaron cuestiones de constitucionalidad o convencionalidad en el corpus.",
  no_witnesses: "El expediente no contiene declaraciones que permitan perfilar declarantes.",
  insufficient_evidence: "El corpus no alcanza el umbral de suficiencia probatoria requerido para esta sección.",
  no_deadlines: "No se identificaron actuaciones con fecha cierta para calcular plazos.",
  disabled: "Módulo no habilitado para este expediente.",
};

const SKIP_REASONS_EN: Record<string, string> = {
  not_applicable_materia: "Not applicable to this practice area under the selected procedure.",
  no_physical_evidence: "The record contains no physical evidence to run a chain-of-custody analysis.",
  no_constitutional_issue: "No constitutional or conventionality issue was detected in the corpus.",
  no_witnesses: "The record contains no declarations from which to profile declarants.",
  insufficient_evidence: "The corpus does not meet the evidentiary sufficiency threshold for this section.",
  no_deadlines: "No dated procedural acts were found from which to compute deadlines.",
  disabled: "Module not enabled for this matter.",
};

/** Human, localized explanation for a skipped section or agent. */
export function skipReason(code: string | null | undefined, locale: ReportLocale = "es"): string {
  const table = locale === "en" ? SKIP_REASONS_EN : SKIP_REASONS_ES;
  const fallback = locale === "en" ? SKIP_REASONS_EN.not_applicable_materia : SKIP_REASONS_ES.not_applicable_materia;
  if (!code) return fallback;
  return table[code] ?? code;
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

let currentLocale: ReportLocale = "es";

/** Set the active template locale for the current export run. */
export function setReportTemplateLocale(locale: ReportLocale): void {
  currentLocale = locale === "en" ? "en" : "es";
}

export function getReportTemplateLocale(): ReportLocale {
  return currentLocale;
}

/**
 * Resolve the report's language: the language it was generated in wins, so
 * historical reports are never retranslated; only rows that predate the
 * `generated_language` column fall back to the case's current setting.
 */
export function resolveReportLocale(
  report: { generated_language?: string | null } | null | undefined,
  caseRow: { report_language?: string | null } | null | undefined,
): ReportLocale {
  const fromReport = report?.generated_language;
  if (fromReport === "en" || fromReport === "es") return fromReport;
  const fromCase = caseRow?.report_language;
  if (fromCase === "en" || fromCase === "es") return fromCase;
  return "es";
}

/**
 * Translate a template string into the active report locale. Unknown strings
 * pass through untouched — they are AI narrative, case names, quotes or
 * citations that are already written in the report's language.
 */
export function rt(input: string): string;
export function rt<T>(input: T): T;
export function rt(input: unknown): unknown {
  if (typeof input !== "string") return input;
  if (currentLocale === "en") return input;
  const s = input;
  if (!s.trim()) return s;

  const exact = ES[s] ?? ES[s.trim()];
  if (exact) return exact;

  for (const r of REPLACERS) {
    const m = s.trim().match(r.re);
    if (m) return r.fn(m);
  }

  for (const p of ES_PATTERNS) {
    if (p.re.test(s)) {
      const rest = s.replace(p.re, "").trimStart();
      const restTranslated = rest && ES[rest] ? ES[rest] : rest;
      return `${p.to}${restTranslated ? ` ${restTranslated}` : ""}`;
    }
  }

  return s;
}

/** Test/diagnostic helper: does a Spanish dictionary entry exist? */
export function hasTemplatePhrase(s: string): boolean {
  return Boolean(ES[s]);
}
