import { describe, it, expect } from "vitest";
import { resolveReportIdentity } from "@/lib/pdf/identity-resolver";

describe("cover identity", () => {
  it("fills proceeding, court, materia from stored case data", () => {
    const r = resolveReportIdentity({
      id: "abc12345",
      case_type: "amparo",
      jurisdiction: "federal",
      procedural_vehicle: "amparo_revision",
      matter_metadata: { case_identity: { tribunal_level: "scjn", case_number: "Amparo en revisión 388/2022" } },
    });
    expect(r.proceedingType).toBe("amparo_revision");
    expect(r.matterType).toBe("amparo");
    expect(r.court).toBe("scjn");
    expect(r.jurisdiction).toBe("federal");
    expect(r.caseNumber).toBe("Amparo en revisión 388/2022");
  });
  it("leaves fields undefined when truly absent", () => {
    const r = resolveReportIdentity({ id: "zz" });
    expect(r.proceedingType).toBeUndefined();
    expect(r.court).toBeUndefined();
  });
});
