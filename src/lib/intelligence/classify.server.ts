// Deterministic classification + priority ranking for findings.
//
// Runs after the LLM extracts findings to produce three canonical fields
// the renderer and perspective views rely on:
//   - evidence_type:   inculpatory | exculpatory | impeachment | neutral
//   - impact_direction: strengthens | weakens | neutral
//   - priority:         1 (case-dispositive) .. 4 (minor)
//
// These overrides are intentional. The LLM is good at finding facts but
// frequently mis-classifies who a defect helps (e.g. tagging "missing
// chain of custody" as "supports prosecution"). The lookup table below
// is the single source of truth for category → classification.
//
// ARCHITECTURE (round 3, 2026-07-29): MATERIA-AWARE CATEGORY TAXONOMY.
// Rounds 1–2 replaced U.S. common-law doctrine with Mexican terms but kept
// everything in one flat, criminal-leaning array — workable while the
// platform was mostly penal cases, but Nyrava México already supports
// civil, mercantil, laboral, familiar, fiscal, administrativo, and
// constitucional matters, and each of those has its own real institutions
// (concurso mercantil, junta/Tribunal Laboral, pensión alimenticia,
// crédito fiscal, control de convencionalidad — none of which resemble
// each other, let alone CNPP criminal procedure). Continuing to bolt every
// materia's vocabulary onto one shared array would eventually produce a
// single file with thousands of regex rules that's unreviewable and prone
// to silent cross-materia false positives.
//
// This file now separates:
//   - UNIVERSAL_CATEGORY_RULES: findings that are the same shape in every
//     materia — physical evidence, chain of custody, witness testimony,
//     credibility/contradiction, expert-opinion challenges, evidentiary
//     foundation, fraud pattern, financial misconduct, amparo (amparo
//     review is available against final rulings in every materia, not
//     just penal), and appeals. These run LAST (as the fallback layer)
//     so a materia-specific rule always gets first refusal on the same
//     vocabulary if one exists.
//   - MATERIA_CATEGORY_RULES: a registry keyed by MexicanCaseType. Each
//     materia's array is checked FIRST, before falling through to the
//     universal layer. penal and mercantil are populated with real
//     terminology (mercantil mirrors the MX_FINDING_MODULES rebuild in
//     mexico-policy.ts). civil, laboral, familiar, fiscal,
//     administrativo, and constitucional are seeded with a real starter
//     set — genuine institutions from the governing codes, not
//     placeholders — but each is explicitly a representative core, the
//     same caveat as the mercantil rebuild: extend as real case material
//     surfaces gaps. amparo, electoral, agrario, ambiental, and
//     inmobiliario have registry slots (so adding them later is a
//     one-array addition, not a redesign) but are currently empty and
//     fall through entirely to the universal layer.
//
// `classifyFinding()` / `priorityFor()` (evidence_type, impact_direction,
// priority) remain a single shared ruleset for now — deliberately, not an
// oversight. Materia-izing evidentiary WEIGHT (who does a chain-of-custody
// gap help, how case-dispositive is a coartada vs. a nulidad contractual)
// is a substantially bigger design problem than materia-izing category
// LABELS, and the category taxonomy is what was actually at risk of
// unbounded growth. Flagging this explicitly rather than silently
// widening scope.
//
// ENGLISH LABELS: per explicit direction, English mode no longer replaces
// the Mexican legal term with a translated label (e.g. "Vinculación a
// Proceso" → "Case Linkage Order"). It now shows the Spanish legal term
// with an English explanatory gloss in parentheses — "Vinculación a
// Proceso (Order Binding the Defendant to Trial Proceedings)" — the same
// convention international legal translation uses for civil-law
// institutions with no common-law equivalent. The Mexican term is never
// dropped, in either language.
//
// See also: mexico-lock.ts (forbids U.S. terms from ever reaching the
// model in prose) and mexico-policy.ts / MX_FINDING_MODULES (the
// per-materia allow-list; mercantil was rebuilt in the same pass as this
// file's mercantil category rules and the two should stay conceptually
// aligned).

import type { NewFinding, Severity } from "./types";
import type { MexicanCaseType } from "../jurisdiction/mexico-types";
import type { PartyRole } from "./types";

export type EvidenceType = "inculpatory" | "exculpatory" | "impeachment" | "neutral";
export type ImpactDirection = "strengthens" | "weakens" | "neutral";
export type AffectedParty = "defense" | "prosecution" | "both" | "neutral";

export type Classification = {
  evidence_type: EvidenceType;
  impact_direction: ImpactDirection;
  affected_party: AffectedParty;
};

// Category prefix / token → canonical classification.
// Order matters: earlier rules win.
// Shared across materias — see architecture note above for why.
const RULES: Array<{ match: RegExp; cls: Classification }> = [
  {
    match:
      /(cadena[_ ]de[_ ]custodia|ruptura[_ ]de[_ ]custodia|manejo[_ ]indebido[_ ]de[_ ]indicios|indicio[_ ]contaminado|rotura[_ ]de[_ ]sello|chain[_ ]of[_ ]custody)/i,
    cls: { evidence_type: "impeachment", impact_direction: "weakens", affected_party: "prosecution" },
  },
  {
    match:
      /(debido[_ ]proceso|control[_ ]de[_ ]detenci[oó]n|detenci[oó]n[_ ]arbitraria|cateo[_ ]sin[_ ]orden|cateo[_ ]irregular|flagrancia[_ ]cuestionada|caso[_ ]urgente[_ ]injustificado|prueba[_ ]il[ií]cita|exclusi[oó]n[_ ]probatoria|derecho[_ ]de[_ ]defensa[_ ]adecuada)/i,
    cls: { evidence_type: "exculpatory", impact_direction: "weakens", affected_party: "prosecution" },
  },
  {
    match:
      /(omisi[oó]n[_ ]de[_ ]investigaci[oó]n|irregularidad[_ ]en[_ ]la[_ ]carpeta|carpeta[_ ]de[_ ]investigaci[oó]n[_ ]incompleta|dato[_ ]de[_ ]prueba[_ ]no[_ ]revelado|prueba[_ ]no[_ ]desahogada|l[ií]nea[_ ]de[_ ]investigaci[oó]n[_ ]sin[_ ]agotar)/i,
    cls: { evidence_type: "exculpatory", impact_direction: "weakens", affected_party: "prosecution" },
  },
  {
    match:
      /(declaraci[oó]n[_ ]sin[_ ]defensor|coacci[oó]n[_ ]en[_ ]declaraci[oó]n|renuncia[_ ]al[_ ]derecho[_ ]a[_ ]guardar[_ ]silencio|entrevista[_ ]sin[_ ]abogado)/i,
    cls: { evidence_type: "exculpatory", impact_direction: "weakens", affected_party: "prosecution" },
  },
  {
    match:
      /(dictamen[_ ]pericial[_ ]deficiente|metodolog[ií]a[_ ]pericial[_ ]cuestionada|perito[_ ]sin[_ ]acreditaci[oó]n|perito[_ ]no[_ ]oficial|contaminaci[oó]n[_ ]de[_ ]muestra|error[_ ]de[_ ]laboratorio)/i,
    cls: { evidence_type: "impeachment", impact_direction: "weakens", affected_party: "prosecution" },
  },
  {
    match:
      /(sesgo[_ ]del[_ ]testigo|contradicci[oó]n[_ ]del[_ ]testigo|declaraci[oó]n[_ ]previa[_ ]inconsistente|testigo[_ ]no[_ ]confiable|impugnaci[oó]n[_ ]de[_ ]testigo|credibilidad)/i,
    cls: { evidence_type: "impeachment", impact_direction: "weakens", affected_party: "prosecution" },
  },
  {
    match:
      /(coartada|conflicto[_ ]de[_ ]cronolog[ií]a|inconsistencia[_ ]de[_ ]fechas|vac[ií]o[_ ]en[_ ]la[_ ]cronolog[ií]a)/i,
    cls: { evidence_type: "exculpatory", impact_direction: "weakens", affected_party: "prosecution" },
  },
  {
    match:
      /(prueba[_ ]faltante|registro[_ ]faltante|entrevista[_ ]faltante|vac[ií]o[_ ]de[_ ]investigaci[oó]n|indicio[_ ]perdido)/i,
    cls: { evidence_type: "exculpatory", impact_direction: "weakens", affected_party: "prosecution" },
  },
  {
    match:
      /(prueba[_ ]corroborada|indicio[_ ]corroborado|testimonio[_ ]corroborado|dictamen[_ ]pericial[_ ]confirmatorio|indicio[_ ]f[ií]sico[_ ]intacto)/i,
    cls: { evidence_type: "inculpatory", impact_direction: "strengthens", affected_party: "prosecution" },
  },
  {
    match:
      /(responsabilidad[_ ]civil|incumplimiento[_ ]contractual|negligencia|nexo[_ ]causal|da[nñ]o[_ ]moral|da[nñ]o[_ ]material)/i,
    cls: { evidence_type: "inculpatory", impact_direction: "strengthens", affected_party: "both" },
  },
  {
    match:
      /(culpa[_ ]concurrente|caso[_ ]fortuito|fuerza[_ ]mayor|hecho[_ ]de[_ ]un[_ ]tercero|mitigaci[oó]n[_ ]del[_ ]da[nñ]o)/i,
    cls: { evidence_type: "exculpatory", impact_direction: "weakens", affected_party: "both" },
  },
];

export function classifyFinding(f: Partial<NewFinding>, materia?: string): Classification {
  const blob = `${f.category ?? ""} ${f.title ?? ""} ${f.description ?? ""}`.toLowerCase();
  for (const r of RULES) {
    if (r.match.test(blob)) {
      // BUG FIXED 2026-08-11 (real completed-case audit, ADR 4640/2017 rerun):
      // every RULES entry's affected_party is "prosecution" or "defense" —
      // an adversarial framing that only exists in a PENAL matter. This
      // table is matched on universal vocabulary (e.g. "debido proceso"
      // appears in civil, laboral, familiar, and amparo matters too, not
      // just criminal ones), so a civil apelación finding about due process
      // was being stamped affected_party: "prosecution" and rendered in the
      // PDF as "PARTE: Ministerio Público" — a party that does not exist in
      // that case. Outside penal, force "neutral" so rankAndClassify falls
      // back to whatever the engine itself reported (or omits the party
      // line entirely) instead of asserting a criminal-only role onto a
      // civil dispute. evidence_type/impact_direction are left as-is: the
      // observed bug was specifically the fabricated party label, not those
      // fields, and narrowing scope to the demonstrated defect avoids
      // guessing at a second fix that isn't evidenced yet.
      return materia && materia !== "penal" ? { ...r.cls, affected_party: "neutral" } : r.cls;
    }
  }
  return { evidence_type: "neutral", impact_direction: "neutral", affected_party: "neutral" };
}

// ---------------------------------------------------------------------------
// PRIORITY RANKING — case-dispositive findings surface above noise.
// Shared across materias — see architecture note above.
// ---------------------------------------------------------------------------
const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function priorityFor(f: Partial<NewFinding>): number {
  const blob = `${f.category ?? ""} ${f.title ?? ""}`.toLowerCase();
  if (
    /(coartada|prueba[_ ]il[ií]cita|cateo[_ ]sin[_ ]orden|detenci[oó]n[_ ]arbitraria|declaraci[oó]n[_ ]sin[_ ]defensor)/.test(
      blob,
    )
  )
    return 1;
  if (f.severity === "critical" && /(debido[_ ]proceso|cadena[_ ]de[_ ]custodia|exculpatorio)/.test(blob)) return 1;
  if (
    /(cadena[_ ]de[_ ]custodia|dictamen[_ ]pericial|metodolog[ií]a[_ ]pericial|perito[_ ]sin[_ ]acreditaci[oó]n|debido[_ ]proceso|control[_ ]de[_ ]detenci[oó]n|prueba[_ ]il[ií]cita|exclusi[oó]n[_ ]probatoria)/.test(
      blob,
    )
  )
    return 2;
  if (/(testigo|credibilidad|impugnaci[oó]n|contradicci[oó]n)/.test(blob)) return 3;
  const sr = SEV_RANK[(f.severity ?? "info") as Severity] ?? 4;
  return sr <= 1 ? 3 : 4;
}

// ---------------------------------------------------------------------------
// CATEGORY TAXONOMY — materia-aware.
// `es` is the Mexican legal term (always shown, both locales). `gloss` is
// a short English explanation, shown ONLY in English mode and ONLY
// alongside the Spanish term — never as a replacement.
// ---------------------------------------------------------------------------
type CategoryRule = { match: RegExp; key: string; es: string; gloss: string };

// Checked LAST, after any materia-specific rules — same evidentiary
// concepts recur in every practice area.
const UNIVERSAL_CATEGORY_RULES: CategoryRule[] = [
  {
    match:
      /\b(cadena\s+de\s+custodia|registro\s+de\s+cadena\s+de\s+custodia|traslado\s+de\s+indicios|embalaje|rotura\s+de\s+sello|manejo\s+de\s+indicios|contaminaci[oó]n\s+de\s+indicio)\b/i,
    key: "chain_of_custody",
    es: "Cadena de Custodia",
    gloss: "Chain of Custody",
  },
  {
    match:
      /\b(indicio|objeto\s+del\s+delito|aseguramiento\s+de\s+bienes|adn|huella|arma|narc[oó]ticos|droga\s+asegurada|muestra\s+de\s+sangre)\b/i,
    key: "evidence",
    es: "Evidencia Física",
    gloss: "Physical Evidence",
  },
  {
    match:
      /\b(entrevista|declaraci[oó]n\s+testimonial|declaraci[oó]n\s+del\s+testigo|declaraci[oó]n\s+de\s+la\s+v[ií]ctima|declaraci[oó]n\s+ministerial|testigo|polic[ií]a\s+de\s+investigaci[oó]n|perito|asesor\s+jur[ií]dico|v[ií]ctima|imputado|testimonial)\b/i,
    key: "witness",
    es: "Testimonio de Testigo",
    gloss: "Witness Testimony",
  },
  {
    match:
      /\b(credibilidad|impugnaci[oó]n|sesgo|declaraci[oó]n\s+previa\s+inconsistente|motivo\s+para\s+mentir|contradicci[oó]n)\b/i,
    key: "contradiction",
    es: "Credibilidad",
    gloss: "Credibility",
  },
  {
    match:
      /\b(dictamen\s+pericial|perito\s+oficial|perito\s+particular|metodolog[ií]a\s+pericial|cadena\s+de\s+custodia\s+pericial|valor\s+probatorio|impugnaci[oó]n\s+del\s+perito|perito\s+sin\s+acreditaci[oó]n)\b/i,
    key: "expert_challenge",
    es: "Impugnación Pericial",
    gloss: "Expert Opinion Challenge",
  },
  {
    match:
      /\b(licitud\s+de\s+la\s+prueba|dato\s+de\s+prueba|medio\s+de\s+prueba|incorporaci[oó]n\s+de\s+prueba|valoraci[oó]n\s+probatoria|prueba\s+superveniente)\b/i,
    key: "evidentiary_foundation",
    es: "Fundamentación Probatoria",
    gloss: "Evidentiary Foundation",
  },
  {
    match: /\b(patr[oó]n\s+de\s+fraude|esquema\s+para\s+defraudar|declaraci[oó]n\s+falsa|enga[nñ]o|simulaci[oó]n)\b/i,
    key: "fraud_pattern",
    es: "Patrón de Fraude",
    gloss: "Fraud Pattern",
  },
  {
    match:
      /\b(lavado\s+de\s+dinero|desv[ií]o\s+de\s+recursos|defraudaci[oó]n|cohecho|peculado|enriquecimiento\s+il[ií]cito|operaci[oó]n\s+con\s+recursos\s+de\s+procedencia\s+il[ií]cita)\b/i,
    key: "financial_fraud",
    es: "Fraude Financiero",
    gloss: "Financial Misconduct",
  },
  {
    match: /\b(amparo\s+directo|amparo\s+indirecto|juicio\s+de\s+amparo)\b/i,
    key: "amparo",
    es: "Amparo",
    gloss: "Mexican Constitutional Review Proceeding",
  },
  {
    match:
      /\b(recurso\s+de\s+apelaci[oó]n|recurso\s+de\s+revocaci[oó]n|recurso\s+de\s+queja|recurso\s+de\s+reclamaci[oó]n)\b/i,
    key: "recursos",
    es: "Recursos",
    gloss: "Appeals",
  },
];

// Checked FIRST, before the universal layer. Materia-specific institutions
// that don't recur elsewhere.
const MATERIA_CATEGORY_RULES: Record<MexicanCaseType, CategoryRule[]> = {
  migratorio: [
    {
      match: /\b(INM|Instituto\s+Nacional\s+de\s+Migraci[oó]n|condici[oó]n\s+de\s+estancia|residencia\s+temporal|residencia\s+permanente|regularizaci[oó]n\s+migratoria|visa|documento\s+migratorio)\b/i,
      key: "tramite_migratorio",
      es: "Trámite Migratorio",
      gloss: "Mexican Immigration Proceeding",
    },
    {
      match: /\b(COMAR|refugiad[oa]|condici[oó]n\s+de\s+refugiado|protecci[oó]n\s+complementaria|asilo\s+pol[ií]tico|no\s+devoluci[oó]n)\b/i,
      key: "proteccion_internacional",
      es: "Protección Internacional",
      gloss: "Refugee or Complementary Protection",
    },
    {
      match: /\b(nacionalidad\s+mexicana|naturalizaci[oó]n|carta\s+de\s+naturalizaci[oó]n|doble\s+nacionalidad|SRE)\b/i,
      key: "nacionalidad_naturalizacion",
      es: "Nacionalidad y Naturalización",
      gloss: "Nationality and Naturalization",
    },
    {
      match: /\b(detenci[oó]n\s+migratoria|estaci[oó]n\s+migratoria|deportaci[oó]n|retorno\s+asistido|expulsi[oó]n|presentaci[oó]n\s+ante\s+INM)\b/i,
      key: "control_detencion_migratoria",
      es: "Control y Detención Migratoria",
      gloss: "Immigration Control and Detention",
    },
    {
      match: /\b(niñ[oa]|adolescente|inter[eé]s\s+superior|DIF|unidad\s+familiar|reunificaci[oó]n\s+familiar)\b/i,
      key: "proteccion_familiar_ninez",
      es: "Protección Familiar y de la Niñez",
      gloss: "Family and Child Protection",
    },
    {
      match: /\b(plazo|vencimiento|notificaci[oó]n|acuse|prevenci[oó]n|requerimiento|continuidad\s+de\s+estancia)\b/i,
      key: "plazo_continuidad_migratoria",
      es: "Plazo y Continuidad Migratoria",
      gloss: "Immigration Deadline and Continuity",
    },
  ],
  penal: [
    {
      match:
        /\b(omisi[oó]n\s+de\s+investigaci[oó]n|irregularidad\s+en\s+la\s+carpeta|violaci[oó]n\s+al\s+debido\s+proceso|violaci[oó]n\s+al\s+derecho\s+de\s+defensa|defecto\s+en\s+la\s+incorporaci[oó]n\s+de\s+la\s+prueba|dato\s+de\s+prueba\s+no\s+revelado|prueba\s+no\s+desahogada)\b/i,
      key: "violacion_procesal",
      es: "Violación Procesal",
      gloss: "Procedural Violation",
    },
    {
      match:
        /\b(declaraci[oó]n\s+del\s+imputado|derecho\s+a\s+guardar\s+silencio|asistencia\s+de\s+defensor|declaraci[oó]n\s+sin\s+defensor|coacci[oó]n\s+en\s+declaraci[oó]n|entrevista\s+sin\s+abogado)\b/i,
      key: "confession_issue",
      es: "Declaración del Imputado",
      gloss: "Statement of the Accused",
    },
    {
      match:
        /\b(cateo\s+sin\s+orden|cateo\s+irregular|cateo\s+ilegal|aseguramiento\s+indebido|inspecci[oó]n\s+irregular|flagrancia\s+cuestionada|caso\s+urgente\s+injustificado|detenci[oó]n\s+arbitraria|debido\s+proceso|presunci[oó]n\s+de\s+inocencia|derecho\s+de\s+defensa\s+adecuada|control\s+de\s+detenci[oó]n\s+irregular|prueba\s+il[ií]cita|exclusi[oó]n\s+probatoria)\b/i,
      key: "constitutional",
      es: "Cuestión Constitucional",
      gloss: "Constitutional Issue",
    },
    {
      match:
        /\b(cateo|orden\s+de\s+cateo|control\s+judicial|aseguramiento|inspecci[oó]n|control\s+de\s+detenci[oó]n)\b/i,
      key: "diligencia_investigacion",
      es: "Diligencia de Investigación",
      gloss: "Investigative Act",
    },
    {
      match:
        /\b(delincuencia\s+organizada|asociaci[oó]n\s+delictuosa|encubrimiento|falsedad\s+en\s+declaraciones|obstrucci[oó]n\s+de\s+la\s+justicia|perjurio)\b/i,
      key: "criminal_conduct",
      es: "Conducta Delictiva",
      gloss: "Criminal Conduct",
    },
    {
      match: /\b(carpeta\s+de\s+investigaci[oó]n)\b/i,
      key: "carpeta_investigacion",
      es: "Carpeta de Investigación",
      gloss: "Investigation File",
    },
    {
      match: /\b(control\s+de\s+detenci[oó]n)\b/i,
      key: "control_detencion",
      es: "Control de Detención",
      gloss: "Detention Control Hearing",
    },
    {
      match: /\b(audiencia\s+inicial)\b/i,
      key: "audiencia_inicial",
      es: "Audiencia Inicial",
      gloss: "Initial Hearing",
    },
    {
      match: /\b(formulaci[oó]n\s+de\s+imputaci[oó]n)\b/i,
      key: "formulacion_imputacion",
      es: "Formulación de Imputación",
      gloss: "Formal Charge",
    },
    {
      match: /\b(vinculaci[oó]n\s+a\s+proceso)\b/i,
      key: "vinculacion_proceso",
      es: "Vinculación a Proceso",
      gloss: "Order Binding the Defendant to Trial Proceedings",
    },
    {
      match: /\b(medidas\s+cautelares)\b/i,
      key: "medidas_cautelares",
      es: "Medidas Cautelares",
      gloss: "Precautionary Measures",
    },
    {
      match: /\b(prisi[oó]n\s+preventiva)\b/i,
      key: "prision_preventiva",
      es: "Prisión Preventiva",
      gloss: "Pretrial Detention",
    },
    {
      match: /\b(criterio\s+de\s+oportunidad)\b/i,
      key: "criterio_oportunidad",
      es: "Criterio de Oportunidad",
      gloss: "Prosecutorial Discretion Not to Charge",
    },
    {
      match: /\b(acuerdo\s+reparatorio)\b/i,
      key: "acuerdo_reparatorio",
      es: "Acuerdo Reparatorio",
      gloss: "Restorative Settlement Agreement",
    },
    {
      match: /\b(suspensi[oó]n\s+condicional\s+del\s+proceso)\b/i,
      key: "suspension_condicional",
      es: "Suspensión Condicional del Proceso",
      gloss: "Conditional Suspension of the Proceedings",
    },
    {
      match: /\b(procedimiento\s+abreviado)\b/i,
      key: "procedimiento_abreviado",
      es: "Procedimiento Abreviado",
      gloss: "Abbreviated (Plea-Style) Procedure",
    },
    {
      match: /\b(etapa\s+intermedia)\b/i,
      key: "etapa_intermedia",
      es: "Etapa Intermedia",
      gloss: "Intermediate Stage",
    },
    {
      match: /\b(auto\s+de\s+apertura\s+a\s+juicio)\b/i,
      key: "auto_apertura_juicio",
      es: "Auto de Apertura a Juicio",
      gloss: "Order Opening Trial",
    },
    { match: /\b(juicio\s+oral)\b/i, key: "juicio_oral", es: "Juicio Oral", gloss: "Oral Trial" },
    { match: /\b(sobreseimiento)\b/i, key: "sobreseimiento", es: "Sobreseimiento", gloss: "Dismissal of the Case" },
    {
      match: /\b(ejecuci[oó]n\s+penal|beneficio\s+preliberacional)\b/i,
      key: "ejecucion_penal",
      es: "Ejecución Penal",
      gloss: "Sentence Execution",
    },
  ],
  mercantil: [
    {
      match:
        /\b(pagar[eé]|letra\s+de\s+cambio|cheque|aval|endoso|protesto|acci[oó]n\s+cambiaria|caducidad\s+cambiaria|prescripci[oó]n\s+cambiaria)\b/i,
      key: "titulo_credito",
      es: "Título de Crédito",
      gloss: "Negotiable Instrument",
    },
    {
      match:
        /\b(asamblea\s+de\s+accionistas|consejo\s+de\s+administraci[oó]n|capital\s+social|fusi[oó]n|escisi[oó]n|liquidaci[oó]n\s+societaria|disoluci[oó]n\s+societaria|responsabilidad\s+de\s+administradores)\b/i,
      key: "sociedad_mercantil",
      es: "Sociedad Mercantil",
      gloss: "Corporate/Company Law Matter",
    },
    {
      match:
        /\b(concurso\s+mercantil|quiebra|s[ií]ndico|conciliador\s+concursal|masa\s+concursal|reconocimiento\s+de\s+cr[eé]ditos)\b/i,
      key: "concurso_mercantil",
      es: "Concurso Mercantil",
      gloss: "Commercial Insolvency Proceeding",
    },
    {
      match:
        /\b(juicio\s+ejecutivo\s+mercantil|v[ií]a\s+ejecutiva|embargo\s+mercantil|t[ií]tulo\s+ejecutivo|auto\s+de\s+exequendo|requerimiento\s+de\s+pago)\b/i,
      key: "juicio_mercantil",
      es: "Juicio Mercantil",
      gloss: "Commercial Litigation",
    },
    {
      match:
        /\b(oferta\s+p[uú]blica\s+de\s+valores|emisora|bolsa\s+mexicana\s+de\s+valores|comisi[oó]n\s+nacional\s+bancaria\s+y\s+de\s+valores|cnbv)\b/i,
      key: "mercado_valores",
      es: "Mercado de Valores",
      gloss: "Securities Market Matter",
    },
    {
      match: /\b(competencia\s+econ[oó]mica|cofece|pr[aá]ctica\s+monop[oó]lica|concentraci[oó]n\s+prohibida)\b/i,
      key: "competencia_economica",
      es: "Competencia Económica",
      gloss: "Antitrust/Competition Matter",
    },
    {
      match: /\b(propiedad\s+industrial|marca|patente|nombre\s+comercial|impi)\b/i,
      key: "propiedad_industrial",
      es: "Propiedad Industrial",
      gloss: "Industrial Property (Trademark/Patent)",
    },
    {
      match: /\b(arbitraje\s+comercial|cl[aá]usula\s+compromisoria|laudo\s+arbitral)\b/i,
      key: "arbitraje_comercial",
      es: "Arbitraje Comercial",
      gloss: "Commercial Arbitration",
    },
  ],
  civil: [
    {
      match: /\b(responsabilidad\s+civil|da[nñ]o\s+moral|da[nñ]o\s+material|nexo\s+causal|negligencia)\b/i,
      key: "responsabilidad_civil",
      es: "Responsabilidad Civil",
      gloss: "Civil Liability",
    },
    {
      match: /\b(incumplimiento\s+contractual|cumplimiento\s+forzoso|rescisi[oó]n\s+contractual)\b/i,
      key: "incumplimiento_contractual",
      es: "Incumplimiento Contractual",
      gloss: "Breach of Contract",
    },
    {
      match: /\b(nulidad\s+absoluta|nulidad\s+relativa|vicios\s+del\s+consentimiento)\b/i,
      key: "nulidad_contractual",
      es: "Nulidad Contractual",
      gloss: "Contract Nullity",
    },
    {
      match: /\b(prescripci[oó]n\s+positiva|prescripci[oó]n\s+negativa|caducidad\s+civil)\b/i,
      key: "prescripcion_civil",
      es: "Prescripción",
      gloss: "Statute of Limitations",
    },
    {
      match: /\b(usucapi[oó]n|acci[oó]n\s+reivindicatoria|posesi[oó]n\s+de\s+buena\s+fe)\b/i,
      key: "posesion",
      es: "Posesión y Propiedad",
      gloss: "Possession and Ownership",
    },
  ],
  laboral: [
    {
      match: /\b(despido\s+injustificado|despido\s+injustificado\s+directo|reinstalaci[oó]n)\b/i,
      key: "despido_injustificado",
      es: "Despido Injustificado",
      gloss: "Wrongful Dismissal",
    },
    {
      match: /\b(indemnizaci[oó]n\s+constitucional|prima\s+de\s+antig[uü]edad|finiquito|liquidaci[oó]n\s+laboral)\b/i,
      key: "indemnizacion_laboral",
      es: "Indemnización Laboral",
      gloss: "Labor Indemnity/Severance",
    },
    {
      match: /\b(riesgo\s+de\s+trabajo|incapacidad\s+laboral|accidente\s+de\s+trabajo|enfermedad\s+profesional)\b/i,
      key: "riesgo_trabajo",
      es: "Riesgo de Trabajo",
      gloss: "Occupational Hazard/Injury",
    },
    {
      match: /\b(tribunal\s+laboral|centro\s+de\s+conciliaci[oó]n|junta\s+de\s+conciliaci[oó]n\s+y\s+arbitraje)\b/i,
      key: "tribunal_laboral",
      es: "Tribunal Laboral",
      gloss: "Labor Court/Conciliation Center",
    },
    {
      match: /\b(contrato\s+colectivo\s+de\s+trabajo|sindicato|huelga)\b/i,
      key: "contrato_colectivo",
      es: "Contrato Colectivo de Trabajo",
      gloss: "Collective Bargaining Agreement",
    },
  ],
  familiar: [
    {
      match: /\b(divorcio\s+incausado|divorcio\s+necesario|convenio\s+de\s+divorcio)\b/i,
      key: "divorcio",
      es: "Divorcio",
      gloss: "Divorce",
    },
    {
      match: /\b(pensi[oó]n\s+alimenticia|obligaci[oó]n\s+alimentaria|acreedor\s+alimentario)\b/i,
      key: "pension_alimenticia",
      es: "Pensión Alimenticia",
      gloss: "Child/Spousal Support",
    },
    {
      match: /\b(guarda\s+y\s+custodia|patria\s+potestad|r[eé]gimen\s+de\s+convivencia)\b/i,
      key: "custodia_patria_potestad",
      es: "Custodia y Patria Potestad",
      gloss: "Custody and Parental Authority",
    },
    {
      match: /\b(sociedad\s+conyugal|separaci[oó]n\s+de\s+bienes|capitulaciones\s+matrimoniales)\b/i,
      key: "sociedad_conyugal",
      es: "Sociedad Conyugal",
      gloss: "Marital Property Regime",
    },
  ],
  fiscal: [
    {
      match: /\b(cr[eé]dito\s+fiscal|determinaci[oó]n\s+de\s+cr[eé]dito\s+fiscal)\b/i,
      key: "credito_fiscal",
      es: "Crédito Fiscal",
      gloss: "Tax Assessment",
    },
    {
      match: /\b(visita\s+domiciliaria|auditor[ií]a\s+fiscal|revisi[oó]n\s+de\s+gabinete)\b/i,
      key: "visita_domiciliaria",
      es: "Visita Domiciliaria",
      gloss: "Tax Audit",
    },
    {
      match: /\b(recurso\s+de\s+revocaci[oó]n\s+fiscal)\b/i,
      key: "recurso_revocacion_fiscal",
      es: "Recurso de Revocación",
      gloss: "Tax Administrative Appeal",
    },
    {
      match: /\b(juicio\s+contencioso\s+administrativo|tfja|tribunal\s+federal\s+de\s+justicia\s+administrativa)\b/i,
      key: "juicio_contencioso_administrativo",
      es: "Juicio Contencioso Administrativo",
      gloss: "Tax/Administrative Litigation",
    },
  ],
  administrativo: [
    {
      match: /\b(acto\s+administrativo)\b/i,
      key: "acto_administrativo",
      es: "Acto Administrativo",
      gloss: "Administrative Act",
    },
    {
      match: /\b(nulidad\s+del\s+acto\s+administrativo)\b/i,
      key: "nulidad_acto_administrativo",
      es: "Nulidad del Acto Administrativo",
      gloss: "Nullity of Administrative Act",
    },
    {
      match: /\b(responsabilidad\s+patrimonial\s+del\s+estado)\b/i,
      key: "responsabilidad_patrimonial_estado",
      es: "Responsabilidad Patrimonial del Estado",
      gloss: "State Liability",
    },
    {
      match: /\b(silencio\s+administrativo|negativa\s+ficta|afirmativa\s+ficta)\b/i,
      key: "silencio_administrativo",
      es: "Silencio Administrativo",
      gloss: "Administrative Silence (Deemed Denial/Approval)",
    },
  ],
  constitucional: [
    {
      match: /\b(control\s+de\s+convencionalidad)\b/i,
      key: "control_convencionalidad",
      es: "Control de Convencionalidad",
      gloss: "Conventionality Review",
    },
    {
      match: /\b(control\s+difuso)\b/i,
      key: "control_difuso",
      es: "Control Difuso",
      gloss: "Diffuse Constitutional Review",
    },
    {
      match: /\b(acci[oó]n\s+de\s+inconstitucionalidad)\b/i,
      key: "accion_inconstitucionalidad",
      es: "Acción de Inconstitucionalidad",
      gloss: "Action of Unconstitutionality",
    },
    {
      match: /\b(controversia\s+constitucional)\b/i,
      key: "controversia_constitucional",
      es: "Controversia Constitucional",
      gloss: "Constitutional Controversy",
    },
  ],
  // amparo (2026-08-11): populated after a real completed-case audit
  // (ADR 4640/2017, Fabiola Romo Hernández) showed the empty registry slot
  // silently routing every amparo finding — debido proceso, seguridad
  // jurídica, doble instancia, congruencia y exhaustividad — through
  // UNIVERSAL_CATEGORY_RULES (criminal-evidence vocabulary: chain of
  // custody, witness testimony) or, when nothing there matched either, the
  // LEGACY_CATEGORY_ALIAS fallback below, which mislabeled findings with
  // whatever the PRODUCING AGENT's own default bucket happened to be
  // (e.g. the witness_credibility agent's default category:"witness" →
  // "Testimonio de Testigo" — regardless of the finding's actual content).
  // Content-based rules checked first, before that fallback is ever
  // reached, closes the gap for the vocabulary an amparo directo/directo
  // en revisión matter actually uses.
  amparo: [
    {
      match:
        /\b(procedencia\s+del\s+amparo|causal\s+de\s+improcedencia|sobreseimiento\s+en\s+el\s+amparo|inter[eé]s\s+jur[ií]dico|inter[eé]s\s+leg[ií]timo|principio\s+de\s+definitividad|acto\s+reclamado|autoridad\s+responsable)\b/i,
      key: "procedencia_amparo",
      es: "Procedencia del Amparo",
      gloss: "Admissibility of the Amparo Claim",
    },
    {
      match:
        /\b(agravio\s+inoperante|agravio\s+operante|agravio\s+infundado|agravio\s+fundado|agravio\s+novedoso|suplencia\s+de\s+la\s+queja|concepto\s+de\s+violaci[oó]n)\b/i,
      key: "agravios",
      es: "Agravios",
      gloss: "Grounds of Appeal",
    },
    {
      match:
        /\b(congruencia\s+y\s+exhaustividad|principio\s+de\s+congruencia|exhaustividad\s+de\s+la\s+sentencia|incongruencia\s+de\s+la\s+sentencia|agravios?\s+no\s+(?:estudiados?|atendidos?|analizados?))\b/i,
      key: "congruencia_exhaustividad",
      es: "Congruencia y Exhaustividad",
      gloss: "Consistency and Thoroughness of the Judgment",
    },
    {
      match:
        /\b(debido\s+proceso|derecho\s+de\s+audiencia|derecho\s+de\s+defensa|garant[ií]a\s+de\s+audiencia)\b/i,
      key: "debido_proceso",
      es: "Debido Proceso",
      gloss: "Due Process",
    },
    {
      match:
        /\b(seguridad\s+jur[ií]dica|fundamentaci[oó]n\s+y\s+motivaci[oó]n|principio\s+de\s+legalidad|debida\s+fundamentaci[oó]n)\b/i,
      key: "seguridad_juridica",
      es: "Seguridad Jurídica",
      gloss: "Legal Certainty",
    },
    {
      match:
        /\b(doble\s+instancia|derecho\s+al\s+recurso|recurso\s+efectivo|acceso\s+a\s+la\s+justicia|tutela\s+judicial\s+efectiva)\b/i,
      key: "doble_instancia_acceso_justicia",
      es: "Doble Instancia y Acceso a la Justicia",
      gloss: "Right to Appeal and Access to Justice",
    },
    {
      match:
        /\b(control\s+de\s+convencionalidad|control\s+difuso|inconstitucionalidad\s+de\s+ley|interpretaci[oó]n\s+conforme|principio\s+pro\s+persona)\b/i,
      key: "control_constitucionalidad",
      es: "Control de Constitucionalidad y Convencionalidad",
      gloss: "Constitutional and Conventionality Review",
    },
    {
      match:
        /\b(suspensi[oó]n\s+del\s+acto\s+reclamado|suspensi[oó]n\s+provisional|suspensi[oó]n\s+definitiva|incidente\s+de\s+suspensi[oó]n)\b/i,
      key: "suspension_amparo",
      es: "Suspensión del Acto Reclamado",
      gloss: "Stay of the Challenged Act",
    },
    {
      match: /\b(informe\s+justificado|informe\s+previo)\b/i,
      key: "informe_justificado",
      es: "Informe Justificado",
      gloss: "Justified Report (Authority's Response)",
    },
  ],
  // Registry slots present for architectural completeness — not yet
  // populated. Findings for these materias fall through to
  // UNIVERSAL_CATEGORY_RULES until a real starter set is written for each.
  electoral: [],
  agrario: [],
  ambiental: [],
  inmobiliario: [],
};

function getCategoryRules(materia?: string): CategoryRule[] {
  const specific =
    materia && Object.prototype.hasOwnProperty.call(MATERIA_CATEGORY_RULES, materia)
      ? MATERIA_CATEGORY_RULES[materia as MexicanCaseType]
      : [];
  return [...specific, ...UNIVERSAL_CATEGORY_RULES];
}

function formatCategoryLabel(rule: CategoryRule, locale: "es" | "en"): string {
  return locale === "en" ? `${rule.es} (${rule.gloss})` : rule.es;
}

export function classifyCategory(f: Partial<NewFinding>, locale: "es" | "en" = "es", materia?: string): string {
  const blob = `${f.title ?? ""} ${f.description ?? ""} ${f.category ?? ""}`;
  for (const r of getCategoryRules(materia)) if (r.match.test(blob)) return formatCategoryLabel(r, locale);
  return locale === "en" ? "Hallazgo General (General Finding)" : "Hallazgo General";
}

// Machine-key counterpart to classifyCategory(). Same matching order/rules,
// but returns the stable token instead of a locale-specific label. This is
// what must be persisted to case_findings.category_key.
export function classifyCategoryKey(f: Partial<NewFinding>, materia?: string): string {
  const blob = `${f.title ?? ""} ${f.description ?? ""} ${f.category ?? ""}`;
  for (const r of getCategoryRules(materia)) if (r.match.test(blob)) return r.key;
  return "fact";
}

const LEGACY_CATEGORY_ALIAS: Record<string, { key: string; es: string; gloss: string }> = {
  contradiction: { key: "contradiction", es: "Credibilidad", gloss: "Credibility" },
  witness: { key: "witness", es: "Testimonio de Testigo", gloss: "Witness Testimony" },
  fact: { key: "fact", es: "Hallazgo General", gloss: "General Finding" },
  evidence: { key: "evidence", es: "Evidencia Física", gloss: "Physical Evidence" },
  chain_of_custody: { key: "chain_of_custody", es: "Cadena de Custodia", gloss: "Chain of Custody" },
  missing_evidence: { key: "missing_evidence", es: "Violación Procesal", gloss: "Procedural Violation" },
  discovery_gap: { key: "discovery_gap", es: "Violación Procesal", gloss: "Procedural Violation" },
  procedural: { key: "procedural", es: "Violación Procesal", gloss: "Procedural Violation" },
  strength: { key: "strength", es: "Hallazgo General", gloss: "General Finding" },
  weak_evidence: { key: "weak_evidence", es: "Hallazgo General", gloss: "General Finding" },
  risk: { key: "risk", es: "Hallazgo General", gloss: "General Finding" },
  entity: { key: "entity", es: "Hallazgo General", gloss: "General Finding" },
  timeline: { key: "timeline", es: "Hallazgo General", gloss: "General Finding" },
};

export function rankAndClassify<T extends Partial<NewFinding>>(
  rows: T[],
  locale: "es" | "en" = "es",
  materia?: string,
): Array<
  T & {
    evidence_type: EvidenceType;
    impact_direction: ImpactDirection;
    // A row's own party attribution may use any procedural vocabulary
    // (amparo roles included); only this module's RULES are limited to the
    // ordinary defense/prosecution pair.
    affected_party: PartyRole | null;
    priority: number;
    category: string;
    category_key: string;
  }
> {
  const generalFinding = locale === "en" ? "Hallazgo General (General Finding)" : "Hallazgo General";
  const chainOfCustody = locale === "en" ? "Cadena de Custodia (Chain of Custody)" : "Cadena de Custodia";
  const financialFraud = locale === "en" ? "Fraude Financiero (Financial Misconduct)" : "Fraude Financiero";
  return rows.map((r) => {
    const cls = classifyFinding(r, materia);
    const contentCat = classifyCategory(r, locale, materia);
    let category = contentCat;
    let categoryKey = classifyCategoryKey(r, materia);
    if (category === generalFinding) {
      const raw = String(r.category ?? "").toLowerCase();
      // BUG FIXED 2026-08-11 (real completed-case audit, ADR 4640/2017):
      // this branch used to also overwrite the human-facing `category`
      // label with LEGACY_CATEGORY_ALIAS's translation of `raw` — but
      // `raw` here is not always genuinely legacy stored data; for a
      // freshly-produced finding it's the PRODUCING AGENT's own hardcoded
      // default bucket (e.g. the witness_credibility agent's static
      // category:"witness" in the AGENTS array), which describes what kind
      // of agent looked at the document, not what the finding is actually
      // about. Applying it to the display label meant a due-process
      // holding the witness_credibility agent happened to emit was shown
      // to the attorney as "Testimonio de Testigo" — a specific, wrong,
      // false-confident legal category — instead of the honest "no
      // specific category matched" result. category_key still resolves
      // through the alias below: it's a machine token several existing
      // consumers (report section bucketing, derived-engine counts,
      // scoring's legacy substring fallback) already filter on, and this
      // fix does not change what content those buckets that already relied
      // on the alias received. Only the WRITTEN-OUT label attorneys read
      // stops guessing when content-based classification found no match.
      if (raw && LEGACY_CATEGORY_ALIAS[raw]) {
        categoryKey = LEGACY_CATEGORY_ALIAS[raw].key;
      } else if (raw) {
        // Do NOT slugify arbitrary raw upstream text into an invented
        // category_key. Anything that actually matches a real category
        // already resolved via classifyCategoryKey() above; this branch
        // only runs when nothing matched at all, so the key stays the
        // genuinely-generic "fact" token.
        categoryKey = "fact";
      }
    }
    // Guardrail: never label a financial/fraud finding as "Chain of Custody".
    if (
      category === chainOfCustody &&
      /\b(fraude|dinero|lavado|desfalco|financial|fraud|money|funds|ponzi|embezzl)\b/i.test(
        `${r.title ?? ""} ${r.description ?? ""}`,
      )
    ) {
      category = financialFraud;
      categoryKey = "financial_fraud";
    }

    // Guardrail: never label a victim rights / standing / constitutional / due process finding as witness testimony.
    const textAll = `${r.title ?? ""} ${r.description ?? ""} ${r.legal_significance ?? ""}`.toLowerCase();
    if (
      (category === "Testimonio de Testigo" || categoryKey === "witness") &&
      /\b(v[ií]ctima|ofendid|legitim|acceso\s+a\s+la\s+justicia|tutela\s+judicial|amparo|debido\s+proceso|reparaci[oó]n\s+del\s+da[ñn]o|derechos?\s+humanos?)\b/i.test(textAll)
    ) {
      if (/\b(v[ií]ctima|ofendid|reparaci[oó]n|legitim)\b/i.test(textAll)) {
        category = locale === "en" ? "Derechos de la Víctima (Victim Rights)" : "Derechos de la Víctima";
        categoryKey = "victim_rights";
      } else {
        category = locale === "en" ? "Control Constitucional (Constitutional Review)" : "Control Constitucional";
        categoryKey = "constitutional_compliance";
      }
    }
    return {
      ...r,
      category,
      category_key: categoryKey,
      evidence_type: cls.evidence_type,
      impact_direction: cls.impact_direction,
      affected_party: cls.affected_party === "neutral" ? (r.affected_party ?? null) : cls.affected_party,
      priority: priorityFor(r),
    };
  });
}
