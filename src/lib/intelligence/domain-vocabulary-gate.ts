// Domain Vocabulary Gate — pure module (no I/O, no AI).
//
// WHY: an agent's free-text output can be perfectly grounded (verbatim
// quote, verified against the corpus, on-topic per the relevance gate) and
// still assert something false: that a specific institution or procedural
// actor was involved, when the case's materia doesn't have that
// institution at all. Real example (ADR 4640/2017, Fabiola Romo Hernández
// — a CIVIL apelación reviewed via amparo directo en revisión):
// ways_out_analysis wrote "La resolución del Tribunal de Enjuiciamiento
// desestimó un argumento novedoso..." — "Tribunal de Enjuiciamiento" is the
// oral-trial tribunal in Mexico's accusatorial CRIMINAL procedure (CNPP).
// It does not exist in a civil dispute. None of the finding's own cited
// quotes even mention it — the agent supplied the term itself, defaulting
// to generic/criminal-flavored institutional vocabulary while paraphrasing
// a court's holding that was really issued by a Tribunal Colegiado /
// SCJN in an amparo proceeding.
//
// This is deliberately a DENYLIST, not an allowlist. Building a real
// per-materia allowlist of everything that's legitimately mentionable is a
// substantive legal-content judgment (which checklist items, institutions,
// and procedural stages genuinely apply to each materia) that this
// codebase has consistently deferred to the user's own legal research
// rather than have the model encode unilaterally (see classify.server.ts
// and procedural-compliance.ts's module headers for the same principle).
// A denylist of unambiguous, single-materia-exclusive institutional NAMES
// — not general legal concepts — needs no such judgment call: "Tribunal de
// Enjuiciamiento" and "Vinculación a Proceso" are real, specific,
// CNPP-defined institutions that simply do not exist outside penal
// procedure, full stop, regardless of the underlying facts of any given
// case. Terms here are cross-checked against classify.server.ts's own
// MATERIA_CATEGORY_RULES.penal vocabulary and case-type-standards.ts's
// penal-specific institutional references, so this list cannot silently
// diverge from what the rest of the codebase already treats as penal-only.

import type { MexicanCaseType } from "../jurisdiction/mexico-types";
import { isPenalMatter } from "./penal-legal-normalization";

type DomainTerm = { match: RegExp; label: string };

// Institutions and procedural actors that exist ONLY in the accusatorial
// criminal procedure (CNPP) — never in civil, mercantil, laboral,
// familiar, fiscal, administrativo, constitucional, amparo, electoral,
// agrario, ambiental, or inmobiliario matters.
const PENAL_ONLY_TERMS: DomainTerm[] = [
  { match: /\btribunal(?:es)?\s+de\s+enjuiciamiento\b/i, label: "Tribunal de Enjuiciamiento" },
  { match: /\bjuez(?:a)?\s+de\s+control\b/i, label: "Juez de Control" },
  { match: /\bministerio\s+p[uú]blico\b/i, label: "Ministerio Público" },
  { match: /\bfiscal[ií]a\b/i, label: "Fiscalía" },
  { match: /\bcarpeta\s+de\s+investigaci[oó]n\b/i, label: "Carpeta de Investigación" },
  { match: /\baudiencia\s+inicial\b/i, label: "Audiencia Inicial" },
  { match: /\bvinculaci[oó]n\s+a\s+proceso\b/i, label: "Vinculación a Proceso" },
  { match: /\bformulaci[oó]n\s+de\s+imputaci[oó]n\b/i, label: "Formulación de Imputación" },
  { match: /\bprisi[oó]n\s+preventiva\b/i, label: "Prisión Preventiva" },
  { match: /\bprocedimiento\s+abreviado\b/i, label: "Procedimiento Abreviado" },
  { match: /\betapa\s+intermedia\b/i, label: "Etapa Intermedia" },
  { match: /\bauto\s+de\s+apertura\s+a\s+juicio\b/i, label: "Auto de Apertura a Juicio" },
  { match: /\bjuicio\s+oral\b/i, label: "Juicio Oral" },
  { match: /\bcriterio\s+de\s+oportunidad\b/i, label: "Criterio de Oportunidad" },
  { match: /\bacuerdo\s+reparatorio\b/i, label: "Acuerdo Reparatorio" },
  {
    match: /\bsuspensi[oó]n\s+condicional\s+del\s+proceso\b/i,
    label: "Suspensión Condicional del Proceso",
  },
];

const MATERIAS_WITHOUT_PENAL_INSTITUTIONS: ReadonlySet<MexicanCaseType> = new Set([
  "civil",
  "mercantil",
  "laboral",
  "familiar",
  "fiscal",
  "administrativo",
  "constitucional",
  "amparo",
  "electoral",
  "agrario",
  "ambiental",
  "inmobiliario",
]);

export type DomainVocabularyCheck = {
  clean: boolean;
  violations: string[];
  /** Penal-only terms that appeared, but only in a legitimate non-asserting
   * context (quotation, attribution, negation/absence, comparison, authority
   * title/citation, or an explicit cross-domain penal reference). Reported for
   * diagnostics; never a release blocker. */
  contextual?: string[];
};

// ---------------------------------------------------------------------------
// Context awareness.
//
// The denylist answers "does this institution exist in this materia?". That is
// only half of the real question. A report may legitimately NAME a penal
// institution in a non-penal matter when it is not asserting that the
// institution acted in this matter: quoting a document, attributing an
// argument to a party or authority, stating the institution was ABSENT,
// contrasting penal procedure with the applicable one, citing an authority
// whose title contains the term, or expressly discussing the penal domain.
//
// These markers are materia-agnostic Spanish/English discourse markers, not
// content rules — no materia, case, or report text is special-cased.
// ---------------------------------------------------------------------------

// Markers that must GOVERN the term — i.e. appear in the same sentence before
// it. A negation that follows the term does not excuse it ("El Ministerio
// Público no participó" still asserts the institution acted here).

// Negation / absence — the institution did NOT intervene in this matter.
const NEGATION_MARKER =
  /\b(?:no|sin|ausencia|carece|carec[ií]a|falta|nunca|tampoco|inexistente|omiti[oó]|omisi[oó]n|did\s+not|was\s+not|absence|no\s+evidence)\b/i;

// Comparison / contrast / analogy / scope limitation — the term is being
// distinguished from, or bounded away from, what governs this matter.
const COMPARISON_MARKER =
  /\b(?:a\s+diferencia\s+de|en\s+contraste|contrasta|mientras\s+que|por\s+analog[ií]a|an[aá]log[oa]|equivalente|s[oó]lo|solo|[uú]nicamente|propio\s+del|propia\s+del|distinto\s+de|unlike|whereas|by\s+analogy|only\s+applies)\b/i;

// Attribution — someone else's assertion, not the report's own. Deliberately
// NOT sufficient on its own: "La SCJN sostuvo que el Ministerio Público debe
// proteger a la víctima" still imports a penal institution as governing law
// into a non-penal matter. It only neutralises the term when the sentence also
// quotes, negates, limits, or expressly frames it as penal-domain.
const ATTRIBUTION_MARKER =
  /\b(?:sostiene|sostuvo|argumenta|argument[oó]|alega|alegando|aleg[oó]|afirma|afirm[oó]|manifiesta|manifest[oó]|adujo|aduce|expres[oó]|refiere|refiri[oó]|invoca|invoc[oó]|se[nñ]ala|indica|considera|consideraron|declar[oó]|seg[uú]n|conforme\s+a|de\s+acuerdo\s+con|a\s+juicio\s+de|en\s+palabras\s+de|cita|citando|textualmente|argues|asserts|claims|according\s+to)\b/i;

// Authority titles/citations. Like attribution, a companion marker only.
const AUTHORITY_MARKER =
  /\b(?:tesis|jurisprudencia|registro\s+digital|semanario\s+judicial|contradicci[oó]n\s+de\s+tesis|criterio\s+jurisprudencial|precedente|SCJN)\b/i;

// Explicit cross-domain framing — the sentence itself situates the term in the
// penal domain (including penal statutes cited by name), so it is a reference
// to another domain rather than a claim about this matter. Sufficient alone.
const CROSS_DOMAIN_MARKER =
  /\b(?:materia\s+penal|proceso\s+penal|procedimiento\s+penal|[aá]mbito\s+penal|sede\s+penal|causa\s+penal|v[ií]a\s+penal|derecho\s+penal|CNPP|C[oó]digo\s+Nacional\s+de\s+Procedimientos\s+Penales|C[oó]digo\s+Penal|criminal\s+(?:proceedings?|procedure|matter))\b/i;

const QUOTE_SPAN = /«[^»]*»|“[^”]*”|"[^"]*"/g;

function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.;:!?])\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

function isInsideQuote(sentence: string, index: number, length: number): boolean {
  QUOTE_SPAN.lastIndex = 0;
  for (let m = QUOTE_SPAN.exec(sentence); m; m = QUOTE_SPAN.exec(sentence)) {
    if (m.index <= index && index + length <= m.index + m[0].length) return true;
  }
  return false;
}

/** True when this specific occurrence merely references the term rather than
 * asserting the institution acted in, or governs, the present matter. */
function isContextualOccurrence(sentence: string, index: number, length: number): boolean {
  if (isInsideQuote(sentence, index, length)) return true;
  if (CROSS_DOMAIN_MARKER.test(sentence)) return true;
  const governing = sentence.slice(0, index);
  if (NEGATION_MARKER.test(governing) || COMPARISON_MARKER.test(governing)) return true;
  // Attribution/authority need a companion neutralising marker anywhere in the
  // sentence; otherwise the attributed statement still imports the institution.
  const attributed = ATTRIBUTION_MARKER.test(governing) || AUTHORITY_MARKER.test(governing);
  return (
    attributed && (NEGATION_MARKER.test(sentence) || COMPARISON_MARKER.test(sentence))
  );
}


/**
 * Checks a finding's own text (title + description — NOT its cited quotes,
 * which are independently verified elsewhere) for institutional vocabulary
 * that cannot exist in the case's actual materia. Always `clean: true` for
 * materia "penal" or an unrecognized/unset materia — this gate only fires
 * when we positively know the case is NOT penal, and only when the text
 * ASSERTS the penal institution in the present matter.
 */
export function checkDomainVocabulary(
  text: string,
  materia: string | undefined,
  underlyingMateria?: string | null,
): DomainVocabularyCheck {
  // Amparo is a procedural vehicle, not the underlying materia.  Penal-
  // origin Amparo legitimately contains CNPP actors and institutions; only
  // a positively non-Penal underlying matter may activate this denylist.
  if (isPenalMatter({ matter: materia, underlyingMatter: underlyingMateria })) {
    return { clean: true, violations: [] };
  }
  if (!materia || !MATERIAS_WITHOUT_PENAL_INSTITUTIONS.has(materia as MexicanCaseType)) {
    return { clean: true, violations: [] };
  }
  const violations: string[] = [];
  const contextual: string[] = [];
  const sentences = splitSentences(text);
  for (const term of PENAL_ONLY_TERMS) {
    if (!term.match.test(text)) continue;
    const rx = new RegExp(term.match.source, "gi");
    let seen = false;
    let asserted = false;
    for (const sentence of sentences) {
      rx.lastIndex = 0;
      for (let m = rx.exec(sentence); m; m = rx.exec(sentence)) {
        seen = true;
        if (!isContextualOccurrence(sentence, m.index, m[0].length)) asserted = true;
      }
    }
    if (!seen) asserted = true; // term spans a sentence split — fail closed.
    if (asserted) violations.push(term.label);
    else contextual.push(term.label);
  }
  return { clean: violations.length === 0, violations, contextual };
}


export function checkFindingDomainVocabulary(
  finding: { title?: unknown; description?: unknown },
  materia: string | undefined,
  underlyingMateria?: string | null,
): DomainVocabularyCheck {
  const title = String(finding.title ?? "");
  const description = String(finding.description ?? "");
  // A bare title carries no discourse context; evaluate each unit on its own
  // so a contextual description cannot excuse an asserting title.
  const titleCheck = checkDomainVocabulary(title, materia, underlyingMateria);
  const descCheck = checkDomainVocabulary(description, materia, underlyingMateria);
  const violations = [...new Set([...titleCheck.violations, ...descCheck.violations])];
  const contextual = [...new Set([...(titleCheck.contextual ?? []), ...(descCheck.contextual ?? [])])]
    .filter((label) => !violations.includes(label));
  return { clean: violations.length === 0, violations, contextual };
}


