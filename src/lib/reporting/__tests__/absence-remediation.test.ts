import { describe, expect, it } from "vitest";
import { remediateAbsenceLanguage, contentRestriction, absenceText, fold } from "../report-content-policy";
import { remediateUnverifiedAbsences } from "../final-report-contract";
import type { ReportCapability } from "../report-permissions";

const capability = {
  mode: "LIMITED", strategic_recommendations_allowed: false, probabilities_allowed: false,
  scores_allowed: false, motions_allowed: false,
} as unknown as ReportCapability;
const governance = { strategy_output_allowed: false, governance_mode: "active_litigation" } as any;

describe("unverified absence remediation", () => {
  it("qualifies an absolute absence sentence", () => {
    const out = remediateAbsenceLanguage("No existe constancia de la notificación personal.");
    expect(out.rewritten).toBe(true);
    expect(absenceText.test(fold(out.text))).toBe(false);
    expect(out.text).toMatch(/material analizado/i);
  });

  it("qualifies English absolute absence wording", () => {
    expect(remediateAbsenceLanguage("No evidence exists of service.").text)
      .toMatch(/no supporting evidence was identified in the reviewed materials/i);
    expect(remediateAbsenceLanguage("The record contains no receipt.").text)
      .toMatch(/the available record does not establish/i);
  });

  it("clears the contract restriction for an uncited missing-evidence node", () => {
    const node = { item: "No obra en el expediente la cédula de notificación." };
    expect(contentRestriction(node.item, "item", node, capability, governance))
      .toBe("unverifiedAbsencePresent");
    const fixed = remediateUnverifiedAbsences(node, capability, governance);
    expect(contentRestriction(fixed.item, "item", fixed, capability, governance)).toBeNull();
  });

  it("leaves a verified/cited absence statement untouched", () => {
    const node = {
      text: "No existe constancia de notificación personal.",
      absence_verified: true,
    };
    expect(contentRestriction(node.text, "text", node, capability, governance)).toBeNull();
    expect(remediateUnverifiedAbsences(node, capability, governance).text).toBe(node.text);
  });

  it("does not rewrite substantive claims without absence wording", () => {
    const text = "El tribunal concedió el amparo por violación al artículo 16 constitucional.";
    expect(remediateAbsenceLanguage(text)).toEqual({ text, rewritten: false });
  });
});
