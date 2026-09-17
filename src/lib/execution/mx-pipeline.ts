// =============================================================================
// JURISDICTION-AWARE PIPELINE PROFILES — México
//
// The canonical stage list (execution/canonical.ts) defines WHAT can run and in
// which dependency-safe order. This module defines, for the Mexican
// jurisdiction:
//
//   1. Which stages are legally relevant for a given case type (materia).
//      e.g. no jury simulation for an ordinary Mexican criminal case; no
//      constitutional/derechos-fundamentales engine on a mercantil contract.
//   2. How each stage is NAMED for a Mexican attorney — as i18n keys, so the
//      UI renders Spanish (default) or English from src/i18n/locales/*.json.
//      Names are materia-aware: `strategy` is "Estrategia de Defensa o
//      Acusación" in penal, "Estrategia de Amparo (suspensión e
//      improcedencia)" in amparo, "Estrategia Laboral" in laboral.
//
// Pure module: no i18n, no React, no Supabase — safe to import from server
// functions, the worker, and the browser bundle alike.
// =============================================================================

import { CANONICAL_STAGES, type StageDef } from "./canonical";
import {
  normalizeMexicanCaseType,
  requireMexicanCaseType,
  type MexicanCaseType,
} from "@/lib/jurisdiction/mexico";

/**
 * Mexican PROCEDURAL profiles. These are execution profiles (which procedural
 * code and which audiencias govern the run), not a second case-type
 * taxonomy — the only case-type vocabulary in the platform is
 * `MexicanCaseType` (src/lib/jurisdiction/mexico-types.ts).
 */
export type MxPipelineProfile =
  | "penal"
  | "amparo"
  | "derechos_humanos"
  | "constitucional"
  | "laboral"
  | "civil"
  | "familiar"
  | "mercantil"
  | "fiscal"
  | "administrativo"
  | "apelacion"
  | "inmobiliario"
  | "agrario"
  | "electoral"
  | "ambiental"
  | "migratorio"
  // Responsabilidad médica / mala praxis — a civil liability claim (or, when
  // brought against a public institution — IMSS, ISSSTE, hospital estatal —
  // an administrativo one) that the base civil/administrativo checklists
  // structurally cannot represent: they have no way to require informed
  // consent, clinical-history completeness, or a medical-standard-of-care
  // (lex artis) expert opinion, and no reason to. See effectiveMxProfile's
  // MEDICAL_MALPRACTICE_TEXT_SIGNAL below for how a civil/administrativo
  // case routes here.
  | "responsabilidad_medica";

export const MX_JURISDICTION = "MX" as const;

/**
 * THE single materia → procedural-profile mapping. Every stage-relevance,
 * label, party-role and skip-reason decision flows through it, so there is
 * exactly one place where a materia's procedural framing is decided.
 */
const PROFILE_BY_MATERIA: Record<MexicanCaseType, MxPipelineProfile> = {
  penal: "penal",
  amparo: "amparo",
  // FIX: previously routed unconditionally to "derechos_humanos" — the CNDH
  // administrative-complaint profile (queja ante la comisión, Ley de la
  // CNDH) — for EVERY case in this materia, including judicial proceedings
  // that have nothing to do with a CNDH complaint: controversia
  // constitucional, acción de inconstitucionalidad, and amparo directo/
  // indirecto EN REVISIÓN (an SCJN review of an amparo ruling on a genuine
  // constitutional question). Confirmed on a real case (Amparo Directo en
  // Revisión 2239/2018): the report asserted a false, scored-negative
  // procedural defect — "Queja presentada ante la comisión competente" (Ley
  // de la CNDH Art. 25-27) — on a judicial SCJN proceeding that was never a
  // CNDH complaint and never could be one; the two proceedings share no
  // procedure, authority, or filing vehicle. "constitucional" now defaults
  // to its own profile modeling SCJN-level constitutional judicial review
  // instead. "derechos_humanos" is not deleted — it is still reachable for
  // an actual CNDH/human-rights-commission complaint via effectiveMxProfile
  // below, which checks the case name for that proceeding's own vocabulary
  // the same way it already does for "apelacion".
  constitucional: "constitucional",
  laboral: "laboral",
  civil: "civil",
  familiar: "familiar",
  mercantil: "mercantil",
  fiscal: "fiscal",
  administrativo: "administrativo",
  // 2026-08-04: previously routed through "administrativo" — a medio de
  // impugnación electoral shares the written-record shape of a juicio de
  // nulidad, but has its own governing law (LGSMIME, not LFPCA), its own
  // authority (TEPJF, not TFJA), and doctrine (paridad de género, violencia
  // política, fiscalización de campaña) with no administrativo analog.
  electoral: "electoral",
  // 2026-08-04: previously routed through "civil" — a Tribunal Unitario
  // Agrario proceeding shares some litigation shape with a civil suit (actor/
  // demandado, ofrecimiento de pruebas) but has its own governing law (Ley
  // Agraria, not the Código Civil), its own registry of title (Registro
  // Agrario Nacional, not the Registro Público de la Propiedad), and
  // frequently an indigenous-community dimension (Convenio 169 OIT) that
  // civil procedure has no concept of. Confirmed on Expediente Agrario
  // 419/2026: the case got the exact same document checklist, procedural
  // checklist, and finding taxonomy as an ordinary civil contract dispute.
  agrario: "agrario",
  // 2026-08-04: previously routed through "administrativo" — has real
  // doctrine of its own (MIA, PROFEPA/ASEA/CONAGUA compliance, protected
  // species/areas) but no document/procedural checklist to match. Own
  // profile now, same rationale as electoral/agrario above.
  ambiental: "ambiental",
  // Transactional, not adversarial — does not share civil's litigation
  // profile (that would pull in trial_prep/discovery/witness stages meant
  // for a lawsuit, not a closing). See EXCLUDED_STAGES below.
  inmobiliario: "inmobiliario",
  migratorio: "migratorio",
};

/**
 * Strict resolution for execution paths: an unrecognized materia is a routing
 * error, never a silent fallback to `civil`.
 */
export function requireMxProfile(caseType: unknown): MxPipelineProfile {
  return PROFILE_BY_MATERIA[requireMexicanCaseType(caseType, "requireMxProfile")];
}

/**
 * Tolerant resolution for rendering/summarizing paths. Returns null when the
 * case has no materia stamped yet (auto-detection runs before execution), so
 * callers can degrade honestly instead of pretending the case is civil.
 */
export function mxProfileOrNull(caseType: unknown): MxPipelineProfile | null {
  const materia = normalizeMexicanCaseType(caseType);
  return materia ? PROFILE_BY_MATERIA[materia] : null;
}

/**
 * Back-compat resolver used by procedural modules that require a profile to
 * key their tables. Strict by design — call `mxProfileOrNull` when the input
 * may legitimately be unset.
 */
export function resolveMxProfile(caseType: string | null | undefined): MxPipelineProfile {
  return requireMxProfile(caseType);
}

/**
 * Materias where an apelación before a tribunal de alzada is a real,
 * distinct SEGUNDA INSTANCIA proceeding — not just one of many possible
 * interim motions a first-instance case might file (see
 * MX_MOTION_TYPES.recurso_de_apelacion_* in mexico-policy.ts, which lists
 * apelación as an available motion for these same materias without
 * implying the case itself is on appeal). amparo/laboral/fiscal/
 * administrativo/electoral/agrario/ambiental/constitucional each resolve
 * their own segunda instancia through a different vehicle (amparo directo,
 * recurso de reconsideración, revisión fiscal, etc.) already modeled by
 * their own profile — "apelacion" doesn't apply to them.
 */
const APELACION_ELIGIBLE_MATERIAS = new Set<MexicanCaseType>(["civil", "mercantil", "familiar", "penal"]);

/**
 * Case-NAME signal (deliberately not the full description) that this
 * proceeding IS the appeal, not a first-instance case that might later have
 * one filed in it. This app's naming convention stamps the proceeding type
 * in the case name itself (e.g. "Amparo Directo 233/2026", "Concurso
 * Mercantil 24/2026-IV"), so a real appeal is expected to be named "Toca de
 * Apelación ...", "Recurso de Apelación ...", etc. Scanning the full
 * description instead would catch incidental, boilerplate mentions of
 * "apelación" that don't mean the case IS one — e.g. standard
 * notice-of-appeal-rights language quoted from a first-instance judgment.
 */
const APELACION_NAME_SIGNAL = /\b(toca de apelacion|recurso de apelacion|segunda instancia|tribunal de alzada)\b/;

function foldCaseNameSignal(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Case-NAME signal that this "constitucional" matter IS an actual CNDH (or
 * state human-rights commission) administrative complaint — the one real
 * use case "derechos_humanos" still models — rather than the SCJN-level
 * judicial constitutional review ("constitucional" profile, the default for
 * this materia as of the 2239/2018 fix above). Deliberately narrow: only
 * the vocabulary that names the non-jurisdictional complaint vehicle
 * itself, never the substantive derechos-humanos doctrine a judicial case
 * can just as legitimately argue at length (that ambiguity is exactly what
 * misrouted 2239/2018 in the first place).
 */
const CNDH_COMPLAINT_NAME_SIGNAL =
  /\b(queja ante la cndh|queja ante la comision (nacional|estatal) de derechos humanos|comision nacional de los derechos humanos|comision estatal de derechos humanos|recomendacion cndh)\b/;

/**
 * Signal that a case filed under the "amparo" materia is actually an amparo
 * DIRECTO EN REVISIÓN before the SCJN (or a comparable SCJN-level review of
 * a norm/amparo ruling) — not a first-instance amparo trial. Real case: a
 * 1-document corpus consisting of "AMPARO DIRECTO EN REVISIÓN 4640/2017"
 * (an SCJN constitutional-analysis resolution, not a full expediente) was
 * evaluated against the base "amparo" checklist (acto reclamado, suspensión,
 * informe justificado, principio de definitividad — all first-instance-trial
 * concepts an SCJN review opinion has no reason to restate), producing a
 * misleadingly low procedural-compliance coverage number. The "constitucional"
 * profile's checklist (added by the 2239/2018 fix below) already models what
 * an SCJN-level review actually requires — this signal routes an "amparo"
 * case to that checklist instead of inventing a third one. Deliberately
 * narrow (the proceeding's own name for itself), same false-positive
 * discipline as APELACION_NAME_SIGNAL/CNDH_COMPLAINT_NAME_SIGNAL above.
 */
const AMPARO_REVISION_TEXT_SIGNAL =
  /\b(amparo directo en revision|amparo indirecto en revision|adr\s+\d+\s*\/\s*\d+|amparo en revision ante la (scjn|suprema corte))\b/;

/**
 * Signal that a "constitucional"-profile case IS a controversia
 * constitucional (as opposed to an acción de inconstitucionalidad or an
 * amparo en revisión — see resolveConstitucionalReviewSubtype below).
 */
const CONTROVERSIA_CONSTITUCIONAL_TEXT_SIGNAL = /\bcontroversia(s)? constitucional(es)?\b/;

/** Signal that a "constitucional"-profile case IS an acción de inconstitucionalidad. */
const ACCION_INCONSTITUCIONALIDAD_TEXT_SIGNAL = /\baccion(es)? de inconstitucionalidad\b/;

export type ConstitucionalReviewSubtype =
  | "controversia_constitucional"
  | "accion_inconstitucionalidad"
  | "amparo_en_revision";

/**
 * Which of the three proceedings the "constitucional" profile's shared
 * checklist covers (see the FIX (2239/2018) comment on PROFILE_BY_MATERIA
 * above) this specific case actually is. The three proceedings share a
 * checklist/stage profile because they share a procedural SHAPE (SCJN-level,
 * document-resolved, no witness stage) — they do NOT share governing law:
 * controversia constitucional and acción de inconstitucionalidad are
 * governed by the Ley Reglamentaria del Art. 105 CPEUM (Títulos II and III
 * respectively — see mx-work-product.ts's already-correct three-way split),
 * amparo directo/indirecto en revisión by the Ley de Amparo. Any consumer
 * rendering a statutory citation for a "constitucional"-profile checklist
 * item must pick the citation for the ACTUAL subtype in play, never a
 * combined string naming a law that has nothing to do with this specific
 * case.
 *
 * Real case: Amparo Directo en Revisión 5829/2025 (case_type "amparo",
 * routed to the "constitucional" profile by AMPARO_REVISION_TEXT_SIGNAL
 * above) showed "Ley Reglamentaria del Art. 105 CPEUM" — a law with nothing
 * to do with an amparo en revisión — as the authority for a missing
 * checklist element, because procedural-compliance.ts, mx-missing-
 * documents.ts and mx-procedural-stages.ts each hardcoded one combined
 * citation string per item instead of selecting per-subtype.
 *
 * Returns null when the corpus doesn't clearly signal one specific
 * proceeding — callers must keep their existing combined/hedged citation in
 * that case, same never-assert-past-the-evidence discipline as the rest of
 * this module (see procedural-compliance.ts's own module header).
 */
export function resolveConstitucionalReviewSubtype(text: string): ConstitucionalReviewSubtype | null {
  const folded = foldCaseNameSignal(text);
  if (CONTROVERSIA_CONSTITUCIONAL_TEXT_SIGNAL.test(folded)) return "controversia_constitucional";
  if (ACCION_INCONSTITUCIONALIDAD_TEXT_SIGNAL.test(folded)) return "accion_inconstitucionalidad";
  if (AMPARO_REVISION_TEXT_SIGNAL.test(folded)) return "amparo_en_revision";
  return null;
}

/**
 * Signal that a case filed under the "civil" materia is actually a
 * responsabilidad médica / mala praxis claim — report-quality audit §14: the
 * base "civil" checklist has no concept of informed consent, clinical-
 * history completeness, standard-of-care (lex artis) expert evidence, or the
 * causal link between a medical act and an injury, which is what the claim
 * actually turns on. Deliberately scoped to "civil" only, not
 * "administrativo" — a claim against a PUBLIC institution (IMSS, ISSSTE,
 * hospital estatal) is correctly a state-liability matter under
 * administrativo law, a different framework this override does not attempt
 * to model (see responsabilidad_medica's MateriaLaw entry, which assumes the
 * private-practice/comun-fuero case as the default this profile covers).
 */
const MEDICAL_MALPRACTICE_TEXT_SIGNAL =
  /\b(negligencia medica|mala praxis|mala practica medica|impericia medica|responsabilidad civil medica|error medico|error de diagnostico)\b/;

/**
 * The pipeline profile actually in effect for this case: its materia's base
 * profile, unless the case name (or, when supplied, a bounded slice of the
 * case's own text — description / corpus head) signals this specific
 * proceeding is an appeal (→ "apelacion"), a genuine CNDH/human-rights-
 * commission complaint (→ "derechos_humanos"), an amparo directo en revisión
 * before the SCJN (→ "constitucional"), or a medical-malpractice claim
 * (→ "responsabilidad_medica"). Same text-narrows-never-widens pattern as
 * detectMatterSubtype() in matter-subtype.ts (familiar → sucesorio) — not a
 * second case-type taxonomy, just a materia-scoped override for a
 * proceeding shape the base materia's profile doesn't fit. `extraSignalText`
 * is optional and additive — every existing caller that only ever passed
 * `caseName` keeps working unchanged.
 */
export function effectiveMxProfile(
  caseType: unknown,
  caseName?: string | null,
  extraSignalText?: string | null,
  proceduralVehicle?: string | null,
  underlyingMateria?: string | null,
): MxPipelineProfile {
  const profile = requireMxProfile(caseType);
  const materia = normalizeMexicanCaseType(caseType);
  const vehicle = String(proceduralVehicle ?? "").toLowerCase().trim();

  // 1. Structured procedural classification (highest priority)
  if (vehicle === "apelacion") return "apelacion";
  if (vehicle === "cndh_queja" || vehicle === "derechos_humanos") return "derechos_humanos";
  if (vehicle === "amparo_directo_revision" || vehicle === "amparo_en_revision") return "constitucional";
  if (vehicle === "responsabilidad_medica") return "responsabilidad_medica";

  // 2. Legacy fallback: case name / text signals
  const signalText = foldCaseNameSignal(`${caseName ?? ""} ${extraSignalText ?? ""}`);
  if (materia && APELACION_ELIGIBLE_MATERIAS.has(materia) && caseName && APELACION_NAME_SIGNAL.test(foldCaseNameSignal(caseName))) {
    return "apelacion";
  }
  if (
    materia === "constitucional" &&
    caseName &&
    CNDH_COMPLAINT_NAME_SIGNAL.test(foldCaseNameSignal(caseName))
  ) {
    return "derechos_humanos";
  }
  if (materia === "amparo" && AMPARO_REVISION_TEXT_SIGNAL.test(signalText)) {
    return "constitucional";
  }
  if (materia === "civil" && MEDICAL_MALPRACTICE_TEXT_SIGNAL.test(signalText)) {
    return "responsabilidad_medica";
  }
  return profile;
}


/**
 * Stages that are NOT legally relevant per profile. Everything else in
 * CANONICAL_STAGES runs. Execution order always follows the canonical
 * dependency graph — a profile only removes stages, never reorders them, so
 * upstream dependencies can never be violated.
 */
const EXCLUDED_STAGES: Record<MxPipelineProfile, readonly string[]> = {
  migratorio: [],
  // Proceso penal acusatorio (CNPP): everything is relevant, including
  // audiencia/juicio oral preparation and control constitucional.
  penal: [],
  // Juicio de amparo directo: se resuelve sobre el acto reclamado y el expediente.
  // Amparo indirecto is handled conditionally in isStageRelevantForCaseType.
  amparo: ["witness"],
  // Violaciones a derechos humanos por autoridad: mismo alcance que penal.
  derechos_humanos: [],
  // Controversia constitucional / acción de inconstitucionalidad / amparo
  // directo en revisión ante SCJN: no hay desahogo de testigos.
  constitucional: ["witness"],
  // Materia laboral (LFT / tribunales laborales): sí hay audiencia, no hay
  // control constitucional directo en el juicio ordinario.
  laboral: ["constitutional"],
  civil: ["constitutional"],
  familiar: ["constitutional"],
  mercantil: ["constitutional"],
  // Fiscal: Arts. 40 y 44 LFPCA admiten prueba testimonial ante TFJA
  // de forma condicionada / preguntas por escrito / exhortos.
  fiscal: ["constitutional"],
  // Juicio contencioso administrativo (TFJA, LFPCA): No live witness examination in adversarial-trial sense.
  administrativo: ["constitutional", "witness"],
  // Segunda instancia: se resuelve sobre agravios y el expediente.
  apelacion: ["constitutional", "witness"],
  // Responsabilidad médica: pericial y testimonial activas.
  responsabilidad_medica: ["constitutional"],
  // Cierre inmobiliario transaccional: sin litigio, sin audiencias contenciosas.
  inmobiliario: [
    "constitutional",
    "witness",
    "discovery",
    "litigation_strategy_center",
    "theories",
    "strategy",
    "work_product",
  ],
  // Juicio agrario ante Tribunal Unitario Agrario:
  agrario: ["constitutional"],
  // Medios de impugnación electoral (TEPJF/OPLE):
  electoral: ["witness"],
  // Ambiental:
  ambiental: ["witness"],
};

/** Canonical reason recorded when a stage is skipped for legal irrelevance. */
export const SKIP_REASON_NOT_RELEVANT_MX = "not_relevant_to_mx_case_type";

/** Exclusions for a case whose materia is not resolved yet */
function exclusionsFor(
  caseType: unknown,
  caseName?: string | null,
  proceduralVehicle?: string | null,
  underlyingMateria?: string | null,
): readonly string[] {
  const materia = normalizeMexicanCaseType(caseType);
  if (!materia) return [];
  const profile = effectiveMxProfile(caseType, caseName, null, proceduralVehicle, underlyingMateria);
  return EXCLUDED_STAGES[profile] ?? [];
}

export function isStageRelevantForCaseType(
  caseType: string | null | undefined,
  stageKey: string,
  caseName?: string | null,
  proceduralVehicle?: string | null,
  underlyingMateria?: string | null,
): boolean {
  const materia = normalizeMexicanCaseType(caseType);
  const vehicle = String(proceduralVehicle ?? "").toLowerCase().trim();

  // Amparo Indirecto (Art. 119 Ley de Amparo): Witness intelligence is CONDITIONAL
  if (materia === "amparo" && (vehicle === "amparo_indirecto" || vehicle === "indirecto") && stageKey === "witness") {
    return true;
  }
  // Inmobiliario Litigio: runs litigation stages
  if (materia === "inmobiliario" && vehicle === "inmobiliario_litigio") {
    if (["witness", "discovery", "theories", "strategy", "work_product"].includes(stageKey)) {
      return true;
    }
  }
  return !exclusionsFor(caseType, caseName, proceduralVehicle, underlyingMateria).includes(stageKey);
}

/**
 * Real Mexican procedural party-role labels per profile, replacing the
 * hardcoded "defense"/"prosecution"/"both" enum that several engine prompts
 * used regardless of materia — that enum is meaningless (and wrong) for
 * every civil/family/labor/tax/amparo case, which is most of them. Used to
 * build the AI-facing JSON schema's affected_party enum dynamically instead
 * of a fixed English pair.
 */
export const MX_PARTY_ROLES: Record<
  MxPipelineProfile,
  { a: string; b: string; c?: string; neutral: string }
> = {
  migratorio: { a: "persona_solicitante", b: "autoridad_migratoria", c: "tercero_interesado", neutral: "ambas" },
  penal: { a: "ministerio_publico", b: "defensa", neutral: "ambas" },
  // Amparo routinely has a tercero interesado (e.g. the beneficiary of the
  // challenged act) distinct from both quejoso and autoridad responsable —
  // without a third slot the model has nowhere correct to put that party.
  amparo: { a: "quejoso", b: "autoridad_responsable", c: "tercero_interesado", neutral: "ambas" },
  derechos_humanos: { a: "quejoso", b: "autoridad_responsable", neutral: "ambas" },
  // Matches jurisdiction/mexico.ts's PARTY_ROLES.constitucional
  // (a: "promovente", b: "autoridad_responsable") — same two core roles,
  // plus a third slot for the tercero interesado that routinely appears in
  // an amparo directo/indirecto en revisión (the beneficiary of the
  // original amparo ruling), same rationale as amparo's own c slot above.
  constitucional: {
    a: "promovente",
    b: "autoridad_responsable",
    c: "tercero_interesado",
    neutral: "ambas",
  },
  laboral: { a: "trabajador", b: "patron", neutral: "ambas" },
  civil: { a: "parte_actora", b: "parte_demandada", neutral: "ambas" },
  familiar: { a: "parte_actora", b: "parte_demandada", neutral: "ambas" },
  mercantil: { a: "parte_actora", b: "parte_demandada", neutral: "ambas" },
  fiscal: { a: "contribuyente", b: "autoridad_fiscal", neutral: "ambas" },
  // Juicio contencioso administrativo de nulidad (TFJA) commonly has a
  // tercero interesado — e.g. an IMPI nullity action brought by the
  // sanctioned/rejected party (particular) against the authority
  // (autoridad), where the original administrative complainant or the
  // holder of the challenged registration is a third party with its own
  // procedural standing, not the plaintiff and not the authority. Confirmed
  // via a real production case (San Baltazar Spirits vs. IMPI, tercero:
  // Palenque Xquenda) where the absence of this third slot caused the
  // tercero's position to be misclassified as the plaintiff's.
  administrativo: { a: "particular", b: "autoridad", c: "tercero_interesado", neutral: "ambas" },
  apelacion: { a: "apelante", b: "apelado", neutral: "ambas" },
  inmobiliario: { a: "comprador", b: "vendedor", neutral: "ambas" },
  // Ley Agraria art. 170 uses "actor"/"demandado"; a tercero interesado slot
  // is needed because a restitución/deslinde case routinely involves a
  // núcleo agrario (ejido/comunidad) as a party distinct from either the
  // individual actor or demandado — e.g. an ejidatario suing a co-ejidatario
  // over parcel boundaries, with the comisariado ejidal itself impleaded.
  agrario: { a: "parte_actora", b: "parte_demandada", c: "nucleo_agrario", neutral: "ambas" },
  // A medio de impugnación electoral routinely involves a tercero
  // interesado — e.g. the candidate/party that benefited from the
  // challenged act, distinct from the actor and the responsible authority.
  electoral: { a: "actor", b: "autoridad_responsable", c: "tercero_interesado", neutral: "ambas" },
  // LGEEPA's acción popular (art. 189) lets any affected community member
  // denounce — a distinct role from the regulated particular being
  // sanctioned by PROFEPA/ASEA/CONAGUA.
  ambiental: { a: "particular", b: "autoridad", c: "comunidad_afectada", neutral: "ambas" },
  // Paciente (o sus familiares/derechohabientes) vs. médico/institución de
  // salud — distinct from generic parte_actora/parte_demandada so prompts
  // can address the actual roles a malpractice claim turns on.
  responsabilidad_medica: { a: "paciente", b: "medico_institucion", neutral: "ambas" },
};

/** JSON-schema-ready enum string, e.g. `"parte_actora"|"parte_demandada"|"ambas"`, for a given case type. */
export function mxPartyRoleEnum(caseType: string | null | undefined): string {
  const r = MX_PARTY_ROLES[requireMxProfile(caseType)];
  const c = r.c ? `|"${r.c}"` : "";
  return `"${r.a}"|"${r.b}"${c}|"${r.neutral}"`;
}

/** Human-readable label for a snake_case Mexican role slug, e.g.
 *  "tercero_interesado" -> "Tercero Interesado". These slugs are already
 *  valid Spanish terms (see MX_PARTY_ROLES), so a title-case formatter is
 *  sufficient — no separate translation table needed. */
export function mxRoleLabel(slug: string | null | undefined): string {
  return String(slug ?? "")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || "Theory";
}

/**
 * Specific, human-readable explanation for why a stage was skipped for this
 * profile — replaces the old bare "OMITIDO"/SKIP_REASON_NOT_RELEVANT_MX
 * generic code with actual legal reasoning a user can read. Returns the
 * i18n KEY (resolved via src/i18n, same pattern as stageLabelKey), not a
 * hardcoded string, so this respects the user's language setting too.
 */
const SKIP_REASON_KEYS: Record<string, Partial<Record<MxPipelineProfile, string>>> = {
  witness: {
    administrativo: "pipeline.skip.witness.administrativo",
    amparo: "pipeline.skip.witness.amparo",
    apelacion: "pipeline.skip.witness.apelacion",
  },
  constitutional: {
    laboral: "pipeline.skip.constitutional.ordinary",
    civil: "pipeline.skip.constitutional.ordinary",
    familiar: "pipeline.skip.constitutional.ordinary",
    mercantil: "pipeline.skip.constitutional.ordinary",
    fiscal: "pipeline.skip.constitutional.ordinary",
    administrativo: "pipeline.skip.constitutional.ordinary",
    apelacion: "pipeline.skip.constitutional.apelacion",
  },
};

/** i18n key for why a stage was skipped for this case type, or a generic
 *  fallback if this exact (stage, profile) pair isn't specifically documented. */
export function stageSkipReasonKey(
  stageKey: string,
  caseType: string | null | undefined,
  caseName?: string | null,
): string {
  const materia = normalizeMexicanCaseType(caseType);
  if (!materia) return "pipeline.skip.generic";
  const profile = effectiveMxProfile(caseType, caseName);
  return SKIP_REASON_KEYS[stageKey]?.[profile] ?? "pipeline.skip.generic";
}

/** Ordered, profile-filtered stage list for a case type. */
export function mxPipelineStages(caseType: string | null | undefined, caseName?: string | null): StageDef[] {
  const excluded = exclusionsFor(caseType, caseName);
  return CANONICAL_STAGES.filter((s) => !excluded.includes(s.key));
}

/** Stage keys only — convenient for server-side filtering. */
export function mxPipelineStageKeys(caseType: string | null | undefined, caseName?: string | null): string[] {
  return mxPipelineStages(caseType, caseName).map((s) => s.key);
}

// -----------------------------------------------------------------------------
// Naming — i18n keys, not literals.
// -----------------------------------------------------------------------------

/**
 * Profiles that get their own wording for a stage. Any (stage, profile) pair
 * listed here resolves to `pipeline.stage.<key>.<profile>`; everything else
 * resolves to `pipeline.stage.<key>`.
 */
const STAGE_LABEL_VARIANTS: Record<string, readonly MxPipelineProfile[]> = {
  strategy: ["penal", "amparo", "laboral"],
  litigation_strategy_center: ["amparo"],
  constitutional: ["amparo", "derechos_humanos"],
  discovery: ["amparo", "laboral"],
};

/** i18n key for a stage's label, materia-aware. */
export function stageLabelKey(stageKey: string, caseType?: string | null): string {
  const profile = mxProfileOrNull(caseType);
  const variants = STAGE_LABEL_VARIANTS[stageKey];
  if (profile && variants && variants.includes(profile)) return `pipeline.stage.${stageKey}.${profile}`;
  return `pipeline.stage.${stageKey}`;
}

/** i18n key for a stage's one-line description. */
export function stageDescriptionKey(stageKey: string): string {
  return `pipeline.stage.${stageKey}.desc`;
}

/**
 * Engine name (pipeline_engine_runs.engine) or pipeline event stage → canonical
 * stage key. Ledger/event rows are written with engine names, aliases, and a
 * couple of legacy spellings, so normalize all of them here.
 */
const STAGE_KEY_ALIASES: Record<string, string> = {
  ...Object.fromEntries(CANONICAL_STAGES.map((s) => [s.engine, s.key])),
  ...Object.fromEntries(CANONICAL_STAGES.map((s) => [s.key, s.key])),
  ocr: "extraction",
  witness_intel: "witness",
  evidence_intelligence: "evidence_intel",
  evidence_intel: "evidence_intel",
  constitutional_compliance: "constitutional",
  discovery_gaps: "discovery",
  hallucination_review: "hallucination",
  report_generator: "report",
  theory: "theories",
  opportunity: "opportunities",
  jurisdiction: "jurisdiction_intel",
  legal_qa_gate: "legal_qa",
  procedural: "procedural_compliance",
};

/**
 * LOOSE display-layer resolver: accepts a canonical engine id, a canonical
 * stage key, OR a legacy/alias spelling and returns the canonical stage key
 * (or null). Rendering only — execution code must use the strict
 * `engineForStage` / `stageKeyForEngine` pair in `execution/canonical.ts`.
 */
export function resolveStageKeyLoose(engineOrStage: string): string | null {
  return STAGE_KEY_ALIASES[engineOrStage] ?? null;
}

/**
 * i18n key for any ledger/event row, falling back to `null` when the engine is
 * not part of the canonical pipeline (caller shows the raw name).
 */
export function engineLabelKey(engineOrStage: string, caseType?: string | null): string | null {
  // Nested verification agents persist as `agent:<type>` so their run rows can
  // never be mistaken for (or collide with) a top-level canonical stage.
  if (engineOrStage.startsWith("agent:")) {
    return `pipeline.agent.${engineOrStage.slice("agent:".length).replace(/_batch$/, "")}`;
  }
  const key = resolveStageKeyLoose(engineOrStage);
  return key ? stageLabelKey(key, caseType) : null;
}

/** i18n key for an execution status / stage state. */
export function statusLabelKey(status: string): string {
  return `pipeline.status.${status}`;
}
