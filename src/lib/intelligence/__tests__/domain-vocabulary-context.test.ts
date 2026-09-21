import { describe, expect, it } from "vitest";
import { checkDomainVocabulary, checkFindingDomainVocabulary } from "../domain-vocabulary-gate";
import { validateRenderedReport } from "@/lib/canonical/prerender-validate.server";
import { decideRenderedReportRelease } from "@/lib/canonical/rendered-report-release";

// Materially different materias, exercised through the SAME shared code path.
// `migratorio` is not itself in the penal-institution denylist set, so it is
// exercised as the underlying materia of an amparo — exactly how immigration
// matters reach the gate.
const MATERIAS = ["civil", "familiar", "laboral", "amparo", "fiscal", "mercantil"] as const;

const CONTEXTUAL_SENTENCES: Array<[string, string]> = [
  ["attributed", "El INM sostiene que la defensa de oficio solo es obligatoria tras la vinculación a proceso."],
  ["negated/absence", "No se evidencia intervención del Ministerio Público en el expediente."],
  ["comparative", "A diferencia del procedimiento abreviado, esta vía no admite negociación de la pena."],
  ["authority title", "La tesis de jurisprudencia interpreta el artículo del Código Nacional de Procedimientos Penales sobre la audiencia inicial."],
  ["cross-domain framing", "En materia penal la carpeta de investigación es la base del expediente; aquí no aplica."],
  ["quoted", "El documento indica textualmente: «se decretó prisión preventiva» al resolver otro asunto."],
];

describe("SPANISH_CASE_TYPE_LEAK — context-aware detection", () => {
  it.each(MATERIAS)("asserted penal institutions still leak in %s", (materia) => {
    const check = checkDomainVocabulary(
      "El Tribunal de Enjuiciamiento resolvió la controversia entre las partes.",
      materia,
    );
    expect(check.clean).toBe(false);
    expect(check.violations).toContain("Tribunal de Enjuiciamiento");
  });

  for (const [kind, sentence] of CONTEXTUAL_SENTENCES) {
    it.each(MATERIAS)(`${kind} references are not leakage in %s`, (materia) => {
      const check = checkDomainVocabulary(sentence, materia);
      expect(check.violations).toEqual([]);
      expect(check.clean).toBe(true);
      expect((check.contextual ?? []).length).toBeGreaterThan(0);
    });
  }

  it("penal matters are unaffected", () => {
    expect(checkDomainVocabulary("El Juez de Control dictó la vinculación a proceso.", "penal").clean).toBe(true);
  });

  it("penal-origin amparo (underlying materia penal) is unaffected", () => {
    expect(
      checkDomainVocabulary("El Ministerio Público formuló imputación.", "amparo", "penal").clean,
    ).toBe(true);
  });

  it("migratorio-origin amparo keeps the gate active but passes contextual prose", () => {
    const contextual = checkDomainVocabulary(
      "El INM sostiene que la defensa de oficio solo aplica tras la vinculación a proceso.",
      "amparo",
      "migratorio",
    );
    const asserted = checkDomainVocabulary(
      "La Fiscalía ejerció la acción penal en este procedimiento migratorio.",
      "amparo",
      "migratorio",
    );
    expect(contextual.clean).toBe(true);
    expect(asserted.clean).toBe(false);
  });

  it("an asserting title is not excused by a contextual description", () => {
    const check = checkFindingDomainVocabulary(
      {
        title: "Resolución del Tribunal de Enjuiciamiento",
        description: "No se advierte intervención del Ministerio Público.",
      },
      "civil",
    );
    expect(check.violations).toContain("Tribunal de Enjuiciamiento");
    expect(check.violations).not.toContain("Ministerio Público");
  });
});

describe("rendered report release with context-aware leak detection", () => {
  const contextualReport = {
    attorney_summary: "El INM sostiene que la defensa de oficio solo es obligatoria tras la vinculación a proceso.",
    facts: "No se evidencia intervención del Ministerio Público en el expediente administrativo.",
  };

  it("does not block a non-penal report whose penal terms are contextual", () => {
    const issues = validateRenderedReport(contextualReport, "amparo", "migratorio");
    const decision = decideRenderedReportRelease(issues);
    expect(issues.some((i) => i.code === "SPANISH_CASE_TYPE_LEAK")).toBe(false);
    expect(issues.some((i) => i.code === "SPANISH_CASE_TYPE_CONTEXTUAL")).toBe(true);
    expect(decision.blocked).toBe(false);
  });

  it("still blocks that same report when another required gate fails", () => {
    const issues = validateRenderedReport(
      { ...contextualReport, recommendations: "Counsel should file a Motion to Dismiss." },
      "amparo",
      "migratorio",
    );
    const decision = decideRenderedReportRelease(issues);
    expect(decision.blocked).toBe(true);
    expect(decision.blockingIssues.some((i) => i.code === "US_PROCEDURE_LEAK")).toBe(true);
  });

  it.each(MATERIAS)("still blocks genuine cross-domain leakage in %s", (materia) => {
    const issues = validateRenderedReport(
      { case_overview: "El Juez de Control ordenó la prisión preventiva de la parte demandada." },
      materia,
    );
    const decision = decideRenderedReportRelease(issues);
    expect(decision.blocked).toBe(true);
    expect(decision.blockingIssues.some((i) => i.code === "SPANISH_CASE_TYPE_LEAK")).toBe(true);
  });

  it("reports one reason per underlying problem across mirrored sections", () => {
    const leak = "El Juez de Control ordenó la prisión preventiva.";
    const issues = validateRenderedReport(
      { executive_summary: leak, attorney_summary: leak, full_report: { prose: { overview: leak } } },
      "civil",
    );
    const decision = decideRenderedReportRelease(issues);
    expect(new Set(decision.reasons).size).toBe(decision.reasons.length);
  });
});
