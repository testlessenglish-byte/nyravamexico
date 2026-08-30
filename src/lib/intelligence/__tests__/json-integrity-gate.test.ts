import { describe, it, expect } from "vitest";
import { validateJSONPipelineIntegrity } from "../json-integrity-gate";

describe("validateJSONPipelineIntegrity", () => {
  it("fails when report is released but release gate is not ok", () => {
    const res = validateJSONPipelineIntegrity({
      findings: [],
      reportReleased: true,
      releaseGate: { ok: false, issues: ["Agent QA failed"] } as any,
    });
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.rule_id === "RELEASED_WITH_BLOCKED_GATE")).toBe(true);
  });

  it("fails when verified finding has quote but no source document and is not exempt", () => {
    const res = validateJSONPipelineIntegrity({
      findings: [
        {
          id: "f1",
          title: "Test quote without document",
          verification_status: "verified",
          source_quote: "Direct text from resolution",
          source_document_id: null,
          source_doc_ids: [],
          evidence_refs: [],
        } as any,
      ],
      reportReleased: false,
    });
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.rule_id === "VERIFIED_QUOTE_WITHOUT_SOURCE_DOCUMENT")).toBe(true);
  });

  it("passes when verified finding is authority-exempt", () => {
    const res = validateJSONPipelineIntegrity({
      findings: [
        {
          id: "f1",
          title: "Authoritative court holding",
          audit_classification: "VERIFIED_COURT_HOLDING",
          source_quote: "Direct text from resolution",
          metadata: { is_authority_exempt: true },
        } as any,
      ],
      reportReleased: false,
    });
    expect(res.valid).toBe(true);
  });

  it("fails when concluded case invents uncited future hearing deadline", () => {
    const res = validateJSONPipelineIntegrity({
      findings: [],
      posture: { is_final_resolution: true } as any,
      deadlines: [
        { label: "Audiencia de juicio", deadline_date: "2026-09-01", source: undefined },
      ],
    });
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.rule_id === "CONCLUDED_CASE_UNCITED_FUTURE_DEADLINE")).toBe(true);
  });

  it("fails when duplicate canonical finding ID appears in reportable findings", () => {
    const res = validateJSONPipelineIntegrity({
      findings: [
        { id: "f1", title: "Finding 1", canonical_finding_id: "cf_123" } as any,
        { id: "f2", title: "Finding 2", canonical_finding_id: "cf_123" } as any,
      ],
    });
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.rule_id === "DUPLICATE_CANONICAL_FINDING_IN_REPORT")).toBe(true);
  });

  it("fails when recommendations survive in strict limited mode", () => {
    const res = validateJSONPipelineIntegrity({
      findings: [],
      isLimitedMode: true,
      recommendationsCount: 3,
    });
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.rule_id === "RECOMMENDATION_SURVIVED_IN_LIMITED_MODE")).toBe(true);
  });
});
