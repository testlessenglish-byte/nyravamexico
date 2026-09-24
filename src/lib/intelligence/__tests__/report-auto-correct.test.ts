import { describe, it, expect } from "vitest";
import { autoCorrectRenderedReport, appendMissingDecisionCore } from "../report-auto-correct";
import { validateRenderedReport } from "@/lib/canonical/prerender-validate.server";
import { decideRenderedReportRelease } from "@/lib/canonical/rendered-report-release";

describe("report auto-correct", () => {
  for (const materia of ["familiar", "civil", "laboral"]) {
    it(`removes filler so ${materia} reports pass the unchanged rendered gate`, () => {
      const report = {
        facts: "The custody record is well-supported. The court reviewed the parenting plan in detail.",
        timeline_summary: "Hearing held on 3 March. Evidence rated well-supported by the reviewer today.",
      };
      autoCorrectRenderedReport(report, materia, null);
      const d = decideRenderedReportRelease(validateRenderedReport(report, materia, null));
      expect(d.reasons.filter((r) => r.includes("TOKEN_WELL_SUPPORTED"))).toEqual([]);
      expect(report.facts).toContain("parenting plan");
    });
  }

  it("keeps penal vocabulary in penal reports", () => {
    const report = { facts: "El Ministerio Público formuló imputación contra el acusado en audiencia." };
    autoCorrectRenderedReport(report, "penal", null);
    expect(report.facts).toContain("imputación");
  });

  it("appends verified decision-core text verbatim, never invented", () => {
    const out = appendMissingDecisionCore("Resumen.", [{ text: "Se confirma la pensión alimenticia." }]);
    expect(out).toContain("Se confirma la pensión alimenticia.");
    expect(appendMissingDecisionCore("Resumen.", [])).toBe("Resumen.");
  });
});
