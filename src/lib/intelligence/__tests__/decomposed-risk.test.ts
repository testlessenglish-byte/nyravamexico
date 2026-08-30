import { describe, it, expect } from "vitest";
import { computeDecomposedRiskScore } from "../scoring.server";
import type { Finding } from "../types";

describe("computeDecomposedRiskScore", () => {
  it("does NOT increase risk for an adopted constitutional holding with neutral impact", () => {
    const findings: Finding[] = [
      {
        id: "f1",
        title: "Inconstitucionalidad de norma aplicada",
        category: "constitutional",
        severity: "critical",
        confidence: 0.95,
        proposition_type: "holding",
        adoption_status: "adopted",
        impact_direction: "neutral",
        audit_classification: "VERIFIED_COURT_HOLDING",
      } as any,
    ];

    const risk = computeDecomposedRiskScore(findings);
    expect(risk.overall_risk_score).toBe(0);
    expect(risk.dimensions.legal_precedent_risk.score).toBe(0);
    expect(risk.band).toBe("low");
  });

  it("increases legal_precedent_risk when finding is adverse", () => {
    const findings: Finding[] = [
      {
        id: "f2",
        title: "Criterio vinculante adverso de la SCJN",
        category: "precedent",
        severity: "high",
        confidence: 0.9,
        proposition_type: "precedent",
        impact_direction: "undermining",
      } as any,
    ];

    const risk = computeDecomposedRiskScore(findings);
    expect(risk.dimensions.legal_precedent_risk.score).toBeGreaterThan(0);
    expect(risk.overall_risk_score).toBeGreaterThan(0);
  });
});
