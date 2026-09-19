// =============================================================================
// JURISDICTION INTELLIGENCE â€” pure module.
//
// Resolves, for a Mexican matter: paÃ­s, entidad federativa, fuero
// (federal/comÃºn), materia, competent court family, and the substantive +
// procedural codes that actually govern the case. Consumed by the
// `jurisdiction_intel` pipeline stage ("Inteligencia de JurisdicciÃ³n"), which
// runs right after the legal analyzers so every downstream engine reasons
// against the correct body of law.
// =============================================================================

import { resolveMxProfile, type MxPipelineProfile } from "../execution/mx-pipeline";
import { jurisdictionLevelOf } from "./jurisdictions";


export const MEXICAN_STATES: readonly { code: string; name: string; aliases: readonly string[] }[] = [
  { code: "AGU", name: "Aguascalientes", aliases: [] },
  { code: "BCN", name: "Baja California", aliases: ["Mexicali", "Tijuana", "Ensenada"] },
  { code: "BCS", name: "Baja California Sur", aliases: ["La Paz", "Los Cabos"] },
  { code: "CAM", name: "Campeche", aliases: [] },
  { code: "CHP", name: "Chiapas", aliases: ["Tuxtla GutiÃ©rrez"] },
  { code: "CHH", name: "Chihuahua", aliases: ["Ciudad JuÃ¡rez"] },
  { code: "CMX", name: "Ciudad de MÃ©xico", aliases: ["CDMX", "Distrito Federal", "Ciudad de Mexico"] },
  { code: "COA", name: "Coahuila", aliases: ["Saltillo", "TorreÃ³n"] },
  { code: "COL", name: "Colima", aliases: ["Manzanillo"] },
  { code: "DUR", name: "Durango", aliases: [] },
  { code: "GUA", name: "Guanajuato", aliases: ["LeÃ³n", "Celaya", "Irapuato"] },
  { code: "GRO", name: "Guerrero", aliases: ["Acapulco", "Chilpancingo"] },
  { code: "HID", name: "Hidalgo", aliases: ["Pachuca"] },
  { code: "JAL", name: "Jalisco", aliases: ["Guadalajara", "Zapopan", "Puerto Vallarta"] },
  { code: "MEX", name: "Estado de MÃ©xico", aliases: ["Toluca", "Ecatepec", "Naucalpan", "NezahualcÃ³yotl"] },
  { code: "MIC", name: "MichoacÃ¡n", aliases: ["Morelia", "Uruapan"] },
  { code: "MOR", name: "Morelos", aliases: ["Cuernavaca"] },
  { code: "NAY", name: "Nayarit", aliases: ["Tepic"] },
  { code: "NLE", name: "Nuevo LeÃ³n", aliases: ["Monterrey", "San Pedro Garza GarcÃ­a"] },
  { code: "OAX", name: "Oaxaca", aliases: [] },
  { code: "PUE", name: "Puebla", aliases: [] },
  { code: "QUE", name: "QuerÃ©taro", aliases: [] },
  { code: "ROO", name: "Quintana Roo", aliases: ["CancÃºn", "Chetumal", "Playa del Carmen"] },
  { code: "SLP", name: "San Luis PotosÃ­", aliases: [] },
  { code: "SIN", name: "Sinaloa", aliases: ["CuliacÃ¡n", "MazatlÃ¡n"] },
  { code: "SON", name: "Sonora", aliases: ["Hermosillo", "Ciudad ObregÃ³n"] },
  { code: "TAB", name: "Tabasco", aliases: ["Villahermosa"] },
  { code: "TAM", name: "Tamaulipas", aliases: ["Reynosa", "Tampico", "Ciudad Victoria"] },
  { code: "TLA", name: "Tlaxcala", aliases: [] },
  { code: "VER", name: "Veracruz", aliases: ["Xalapa", "Coatzacoalcos"] },
  { code: "YUC", name: "YucatÃ¡n", aliases: ["MÃ©rida"] },
  { code: "ZAC", name: "Zacatecas", aliases: [] },
];

export type Fuero = "federal" | "comun" | "mixto";

export type JurisdictionProfile = {
  country: "MX";
  /** Entidad federativa, or null when the matter is purely federal. */
  state: { code: string; name: string } | null
  /** How the state was determined. */
  state_source: "case_field" | "corpus" | "unresolved";
  fuero: Fuero;
  /**
   * Judicial classification actually routed on (federal / state / municipal).
   * Distinct from geographic reach: a federal matter is federal because of the
   * competent court system, not because it happens "nationwide".
   */
  jurisdiction_level: "federal" | "state" | "municipal" | "unresolved";
  /** Where jurisdiction_level came from. `declared` wins over everything. */
  jurisdiction_source: "declared" | "materia" | "corpus" | "unresolved";
  materia: MxPipelineProfile;

  /** Court families with competence over this matter. */
  courts: readonly string[];
  /** Substantive law that governs the merits. */
  substantive_codes: readonly string[];
  /** Procedural law that governs the trÃ¡mite. */
  procedural_codes: readonly string[];
  /** Constitutional hooks always in play (Art. 1Âº, 14, 16, etc.). */
  constitutional_basis: readonly string[];
  /** Human-readable one-liner, Spanish. */
  summary: string;
  /** Non-fatal notes (e.g. state could not be resolved). */
  notes: string[];
};

type MateriaLaw = {
  fuero: Fuero;
  courts: readonly string[];
  substantive: readonly string[];
  /** `%STATE%` is replaced with the resolved state name. */
  procedural: readonly string[];
};

const MATERIA_LAW: Record<MxPipelineProfile, MateriaLaw> = {
  migratorio: {
    fuero: "federal",
    courts: [
      "Instituto Nacional de MigraciÃ³n (INM)",
      "SecretarÃ­a de Relaciones Exteriores (SRE)",
      "ComisiÃ³n Mexicana de Ayuda a Refugiados (COMAR)",
      "Tribunal Federal de Justicia Administrativa (TFJA)",
      "Poder Judicial de la FederaciÃ³n",
    ],
    substantive: [
      "Ley de MigraciÃ³n",
      "Ley sobre Refugiados, ProtecciÃ³n Complementaria y Asilo PolÃ­tico",
      "Ley de Nacionalidad",
      "CPEUM",
    ],
    procedural: [
      "Reglamento de la Ley de MigraciÃ³n",
      "Ley Federal de Procedimiento Administrativo",
      "Ley Federal de Procedimiento Contencioso Administrativo",
      "Ley de Amparo",
    ],
  },
  penal: {
    fuero: "mixto",
    courts: ["Juez de Control", "Tribunal de Enjuiciamiento", "Tribunal de Alzada"],
    substantive: ["CÃ³digo Penal Federal", "CÃ³digo Penal de %STATE%", "Ley General de VÃ­ctimas"],
    procedural: ["CÃ³digo Nacional de Procedimientos Penales (CNPP)", "Ley Nacional de EjecuciÃ³n Penal"],
  },
  amparo: {
    fuero: "federal",
    courts: ["Juzgado de Distrito", "Tribunal Colegiado de Circuito", "SCJN"],
    substantive: ["CPEUM", "Tratados internacionales de derechos humanos"],
    procedural: ["Ley de Amparo", "Ley OrgÃ¡nica del Poder Judicial de la FederaciÃ³n"],
  },
  derechos_humanos: {
    fuero: "mixto",
    courts: ["Juzgado de Distrito", "CNDH", "ComisiÃ³n Estatal de Derechos Humanos"],
    substantive: ["CPEUM Art. 1Âº", "ConvenciÃ³n Americana sobre Derechos Humanos", "Ley General de VÃ­ctimas"],
    procedural: ["Ley de Amparo", "Ley de la ComisiÃ³n Nacional de los Derechos Humanos"],
  },
  constitucional: {
    fuero: "federal",
    courts: [
      "Suprema Corte de Justicia de la NaciÃ³n (SCJN)",
      "Plenos Regionales",
      "Tribunal Colegiado de Circuito",
    ],
    substantive: ["CPEUM", "Tratados internacionales de derechos humanos"],
    procedural: [
      "Ley Reglamentaria de las Fracciones I y II del ArtÃ­culo 105 de la CPEUM",
      "Ley de Amparo",
    ],
  },
  laboral: {
    fuero: "mixto",
    courts: ["Tribunal Laboral", "Centro de ConciliaciÃ³n Laboral", "Tribunal Colegiado en Materia de Trabajo"],
    substantive: ["Ley Federal del Trabajo (LFT)", "Ley del Seguro Social"],
    procedural: ["Ley Federal del Trabajo, TÃ­tulo Catorce (procedimiento ordinario laboral)"],
  },
  civil: {
    fuero: "comun",
    courts: ["Juzgado Civil de Primera Instancia", "Sala Civil del Tribunal Superior de Justicia"],
    substantive: ["CÃ³digo Civil Federal", "CÃ³digo Civil de %STATE%"],
    procedural: ["CÃ³digo Nacional de Procedimientos Civiles y Familiares", "CÃ³digo de Procedimientos Civiles de %STATE%"],
  },
  familiar: {
    fuero: "comun",
    courts: ["Juzgado de lo Familiar", "Sala Familiar del Tribunal Superior de Justicia"],
    substantive: ["CÃ³digo Civil de %STATE%", "Ley General de los Derechos de NiÃ±as, NiÃ±os y Adolescentes"],
    procedural: ["CÃ³digo Nacional de Procedimientos Civiles y Familiares"],
  },
  mercantil: {
    fuero: "federal",
    courts: ["Juzgado de Distrito en Materia Mercantil", "Juzgado Civil (competencia concurrente)"],
    substantive: ["CÃ³digo de Comercio", "Ley General de TÃ­tulos y Operaciones de CrÃ©dito", "LGSM"],
    procedural: ["CÃ³digo de Comercio (juicio ejecutivo/oral mercantil)", "CÃ³digo Federal de Procedimientos Civiles"],
  },
  fiscal: {
    fuero: "federal",
    courts: ["Tribunal Federal de Justicia Administrativa (TFJA)", "Tribunal Colegiado de Circuito"],
    substantive: ["CÃ³digo Fiscal de la FederaciÃ³n (CFF)", "Ley del ISR", "Ley del IVA"],
    procedural: ["Ley Federal de Procedimiento Contencioso Administrativo (LFPCA)"],
  },
  administrativo: {
    fuero: "mixto",
    courts: ["Tribunal Federal de Justicia Administrativa (TFJA)", "Tribunal de Justicia Administrativa de %STATE%"],
    substantive: ["Ley Federal de Procedimiento Administrativo", "Ley General de Responsabilidades Administrativas"],
    procedural: ["Ley Federal de Procedimiento Contencioso Administrativo (LFPCA)"],
  },
  apelacion: {
    fuero: "mixto",
    courts: ["Tribunal de Alzada", "Sala del Tribunal Superior de Justicia", "Tribunal Colegiado de Circuito"],
    substantive: ["LegislaciÃ³n sustantiva de la primera instancia"],
    procedural: ["CÃ³digo procesal aplicable a la primera instancia (recurso de apelaciÃ³n)"],
  },
  inmobiliario: {
    fuero: "comun",
    // Not "courts" in the litigation sense â€” the real instancia for a
    // closing. Kept in this field because MateriaLaw has no separate slot,
    // and every other call site reads `courts` expecting a non-empty list.
    courts: ["Notario PÃºblico (fe pÃºblica)", "Registro PÃºblico de la Propiedad de %STATE%"],
    substantive: ["CÃ³digo Civil de %STATE%", "Ley del Notariado de %STATE%", "CÃ³digo Fiscal de la FederaciÃ³n / leyes fiscales locales (ISAI)"],
    procedural: ["Reglamento del Registro PÃºblico de la Propiedad de %STATE%", "Ley del Notariado de %STATE%"],
  },
  agrario: {
    // Federal jurisdiction, but "%STATE%" still applies â€” a Tribunal
    // Unitario Agrario sits in a specific distrito, and the RAN's local
    // delegaciÃ³n is state-specific.
    fuero: "federal",
    courts: ["Tribunal Unitario Agrario", "Tribunal Superior Agrario", "Registro Agrario Nacional (RAN)"],
    substantive: ["Ley Agraria", "CPEUM Art. 27"],
    procedural: ["Ley Agraria (TÃ­tulo Tercero â€” de la Justicia Agraria)", "Ley OrgÃ¡nica de los Tribunales Agrarios"],
  },
  electoral: {
    fuero: "federal",
    courts: ["Instituto Nacional Electoral (INE)", "OPLE de %STATE%", "Tribunal Electoral del Poder Judicial de la FederaciÃ³n (TEPJF)"],
    substantive: ["LGIPE", "LGPP", "CPEUM Art. 35, 41"],
    procedural: ["Ley General del Sistema de Medios de ImpugnaciÃ³n en Materia Electoral (LGSMIME)"],
  },
  ambiental: {
    fuero: "mixto",
    courts: ["PROFEPA", "ASEA", "CONAGUA", "Tribunal Federal de Justicia Administrativa (TFJA)"],
    substantive: ["LGEEPA", "Ley General de Vida Silvestre", "Ley de Aguas Nacionales", "CPEUM Art. 4"],
    procedural: ["LGEEPA (procedimiento administrativo sancionador)", "Ley Federal de Procedimiento Contencioso Administrativo"],
  },
  responsabilidad_medica: {
    // "comun" is the default (a private-practice claim against a mÃ©dico
    // particular or hospital privado); a claim against a public institution
    // (IMSS, ISSSTE, hospital estatal) properly routes through
    // administrativo instead â€” see effectiveMxProfile's
    // MEDICAL_MALPRACTICE_TEXT_SIGNAL, which only overrides civil, not
    // administrativo, for exactly this reason.
    fuero: "comun",
    courts: [
      "Juzgado Civil de Primera Instancia",
      "Sala Civil del Tribunal Superior de Justicia",
      "ComisiÃ³n de Arbitraje MÃ©dico de %STATE% (CAMEC/arbitraje mÃ©dico, vÃ­a alterna no vinculante)",
    ],
    substantive: ["CÃ³digo Civil Federal", "CÃ³digo Civil de %STATE%", "Ley General de Salud", "NOM-004-SSA3 (expediente clÃ­nico)"],
    procedural: ["CÃ³digo Nacional de Procedimientos Civiles y Familiares", "CÃ³digo de Procedimientos Civiles de %STATE%"],
  },
};

const CONSTITUTIONAL_BASIS: Record<MxPipelineProfile, readonly string[]> = {
  migratorio: ["CPEUM Art. 1Âº", "Art. 11", "Art. 14", "Art. 16", "Art. 30", "Art. 33"],
  penal: ["CPEUM Art. 1Âº", "Art. 14", "Art. 16", "Art. 19", "Art. 20", "Art. 21"],
  amparo: ["CPEUM Art. 1Âº", "Art. 103", "Art. 107"],
  derechos_humanos: ["CPEUM Art. 1Âº", "Art. 102 apartado B"],
  constitucional: ["CPEUM Art. 105", "Art. 103", "Art. 107"],
  laboral: ["CPEUM Art. 5Âº", "Art. 123 apartado A"],
  civil: ["CPEUM Art. 14", "Art. 16", "Art. 17"],
  familiar: ["CPEUM Art. 4Âº", "Art. 14", "Art. 16"],
  mercantil: ["CPEUM Art. 14", "Art. 16", "Art. 73 fracciÃ³n X"],
  fiscal: ["CPEUM Art. 16", "Art. 31 fracciÃ³n IV"],
  administrativo: ["CPEUM Art. 14", "Art. 16", "Art. 17"],
  apelacion: ["CPEUM Art. 14", "Art. 16", "Art. 17"],
  inmobiliario: ["CPEUM Art. 14", "Art. 16", "Art. 27"],
  agrario: ["CPEUM Art. 27", "Art. 2Âº (pueblos y comunidades indÃ­genas)"],
  electoral: ["CPEUM Art. 35", "Art. 41", "Art. 116 fracciÃ³n IV"],
  ambiental: ["CPEUM Art. 4 (derecho a un medio ambiente sano)"],
  responsabilidad_medica: ["CPEUM Art. 4Âº (derecho a la protecciÃ³n de la salud)", "Art. 14", "Art. 16", "Art. 17"],
};

const MATERIA_LABEL_ES: Record<MxPipelineProfile, string> = {
  migratorio: "migratoria, de refugio y nacionalidad",
  penal: "penal",
  amparo: "amparo",
  derechos_humanos: "derechos humanos",
  constitucional: "constitucional",
  laboral: "laboral",
  civil: "civil",
  familiar: "familiar",
  mercantil: "mercantil",
  fiscal: "fiscal",
  administrativo: "administrativa",
  apelacion: "apelaciÃ³n",
  inmobiliario: "inmobiliaria",
  agrario: "agraria",
  electoral: "electoral",
  ambiental: "ambiental",
  responsabilidad_medica: "responsabilidad mÃ©dica",
};

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Accent-stripped but case-PRESERVING \u2014 used only for matching state codes. */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Word-boundary search on normalized text â€” "GUA" must not match "Guadalajara". */
function indexOfWord(haystack: string, needle: string): number {
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
    "u",
  );
  const m = re.exec(haystack);
  return m ? m.index : -1;
}

/** Resolve entidad federativa from a free-text field or the document corpus. */
export function detectState(text: string | null | undefined): { code: string; name: string } | null {
  if (!text) return null;
  const hay = normalize(text);
  // Case-PRESERVING (accents stripped only) â€” codes must match their official
  // uppercase abbreviation exactly. Several 3-letter state codes collide with
  // ordinary lowercase Spanish words ("SIN" â†’ "sin" = without, "SON" â†’ "son" =
  // [they] are, "VER" â†’ "ver" = to see, "QUE" â†’ "que" = that/what); matching
  // codes case-insensitively against normal prose produced false positives
  // (e.g. any document containing "...sin relaciÃ³n con..." was misdetected as
  // Sinaloa). Full state names and city aliases stay case-insensitive since
  // they are not also common words.
  const hayCased = stripAccents(text);
  let best: { code: string; name: string; at: number } | null = null;
  for (const st of MEXICAN_STATES) {
    for (const needle of [st.name, ...st.aliases]) {
      const at = indexOfWord(hay, normalize(needle));
      if (at >= 0 && (!best || at < best.at)) best = { code: st.code, name: st.name, at };
    }
    const codeAt = indexOfWord(hayCased, st.code);
    if (codeAt >= 0 && (!best || codeAt < best.at)) best = { code: st.code, name: st.name, at: codeAt };
  }
  return best ? { code: best.code, name: best.name } : null;
}

/** Detect whether the corpus points to the federal or the local (comÃºn) fuero. */
export function detectFuero(text: string | null | undefined, fallback: Fuero): Fuero {
  if (!text) return fallback;
  if (!text) return fallback;
  const hay = normalize(text);
  const federal = /juzgado de distrito|tribunal colegiado|fiscalia general de la republica|fgr|tfja|scjn|fuero federal/.test(hay);
  const comun = /tribunal superior de justicia|juzgado de primera instancia|fiscalia general del estado|fuero comun|juez de control del estado/.test(hay);
  if (federal && !comun) return "federal";
  if (comun && !federal) return "comun";
  if (federal && comun) return "mixto";
  return fallback;
}

// Federal channel overlay. Applied whenever the matter is routed as
// "Federal (MÃ©xico)" â€” the competent courts are the federal judiciary and the
// governing law is federal, regardless of where in the country the facts sit.
const FEDERAL_COURTS: readonly string[] = [
  "Juzgado de Distrito",
  "Tribunal Colegiado de Circuito",
  "Tribunal Colegiado de ApelaciÃ³n",
  "Suprema Corte de Justicia de la NaciÃ³n (SCJN)",
];
const FEDERAL_PROCEDURAL: readonly string[] = [
  "Ley de Amparo",
  "Ley OrgÃ¡nica del Poder Judicial de la FederaciÃ³n (LOPJF)",
];
const FEDERAL_SUBSTANTIVE: readonly string[] = [
  "ConstituciÃ³n PolÃ­tica de los Estados Unidos Mexicanos (CPEUM)",
  "Tratados internacionales de derechos humanos (CPEUM Art. 1Âº)",
];

export function buildJurisdictionProfile(args: {
  caseType: string | null | undefined;
  jurisdictionField?: string | null;
  corpusText?: string | null;
  issuingCourt?: string | null;
}): JurisdictionProfile {
  const materia = resolveMxProfile(args.caseType);
  const law = MATERIA_LAW[materia];
  const notes: string[] = [];

  const declaredLevel = jurisdictionLevelOf(args.jurisdictionField);
  const declaredFederal = declaredLevel === "federal";

  let state = declaredFederal ? null : detectState(args.jurisdictionField);
  let state_source: JurisdictionProfile["state_source"] = state ? "case_field" : "unresolved";
  if (!state && !declaredFederal) {
    state = detectState(args.corpusText);
    state_source = state ? "corpus" : "unresolved";
  }
  if (!state && !declaredFederal && law.fuero !== "federal") {
    notes.push(
      "No fue posible determinar la entidad federativa; el anÃ¡lisis aplica la legislaciÃ³n federal supletoria y debe confirmarse la competencia local.",
    );
  }

  // Declared jurisdiction always wins over corpus heuristics: an attorney who
  // selected "Federal (MÃ©xico)" must never be silently routed to a local fuero.
  const fuero: Fuero = declaredFederal ? "federal" : (detectFuero(args.issuingCourt, null as any) || detectFuero(args.corpusText, law.fuero));
  const stateName = state?.name ?? "la entidad federativa aplicable";
  const expand = (codes: readonly string[]) =>
    codes
      .map((c) => c.replace(/%STATE%/g, stateName))
      // Under the federal channel, state-specific instruments are not the
      // governing law â€” drop them rather than emitting a placeholder code.
      .filter((c) => !(declaredFederal && /%STATE%|la entidad federativa aplicable/.test(c)))
      .filter((c, i, arr) => arr.indexOf(c) === i);

  const dedupe = (arr: readonly string[]) => arr.filter((c, i) => arr.indexOf(c) === i);

  const substantive_codes = declaredFederal
    ? dedupe([...FEDERAL_SUBSTANTIVE, ...expand(law.substantive)])
    : expand(law.substantive);
  const procedural_codes = declaredFederal
    ? dedupe([...expand(law.procedural), ...FEDERAL_PROCEDURAL])
    : expand(law.procedural);
  const courts = declaredFederal
    ? dedupe([...expand(law.courts).filter((c) => !/Tribunal Superior de Justicia|del Estado|Primera Instancia/i.test(c)), ...FEDERAL_COURTS])
    : expand(law.courts);

  if (declaredFederal) {
    notes.push(
      "JurisdicciÃ³n federal declarada: el anÃ¡lisis, la recuperaciÃ³n de autoridades y la jurisprudencia se resuelven por el canal federal (CPEUM, Ley de Amparo, LOPJF, SCJN, Tribunales Colegiados y Juzgados de Distrito), no por legislaciÃ³n local.",
    );
  }
  if (declaredLevel === "municipal") {
    notes.push(
      "JurisdicciÃ³n municipal declarada: rigen los bandos, reglamentos y autoridades del ayuntamiento, con revisiÃ³n eventual por el fuero comÃºn o el amparo.",
    );
  }

  const jurisdiction_level: JurisdictionProfile["jurisdiction_level"] = declaredLevel
    ? declaredLevel
    : law.fuero === "federal"
      ? "federal"
      : state
        ? "state"
        : "unresolved";
  const jurisdiction_source: JurisdictionProfile["jurisdiction_source"] = declaredLevel
    ? "declared"
    : law.fuero === "federal"
      ? "materia"
      : state
        ? "corpus"
        : "unresolved";

  const summary =
    `Materia ${MATERIA_LABEL_ES[materia]} â€” fuero ${fuero === "comun" ? "comÃºn" : fuero}` +
    (declaredFederal ? " (Federal Â· MÃ©xico)" : state ? `, ${state.name}` : "") +
    `. Competencia: ${courts[0]}. Ley aplicable: ${[...substantive_codes, ...procedural_codes].slice(0, 3).join("; ")}.`;

  return {
    country: "MX",
    state,
    state_source,
    fuero,
    jurisdiction_level,
    jurisdiction_source,
    materia,
    courts,
    substantive_codes,
    procedural_codes,
    constitutional_basis: CONSTITUTIONAL_BASIS[materia],
    summary,
    notes,
  };

}

