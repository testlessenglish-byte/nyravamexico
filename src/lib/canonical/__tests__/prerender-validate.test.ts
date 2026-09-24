import { describe, it, expect } from "vitest";
import { validateBeforeRender, validateRenderedReport, partitionIssues } from "../prerender-validate.server";
import { emptyCaseAnalysis } from "../case-analysis";

function base() {
  return emptyCaseAnalysis({
    caseId: "c1",
    caseName: "Test",
    generatedAt: new Date().toISOString(),
    pipelineVersion: "test",
    reportMode: "FULL",
  });
}

describe("prerender-validate", () => {
  it("flags unresolved template tokens", () => {
    const a = base();
    a.ExecutiveSummary.narrative = "The stock dropped {{pct}} following the announcement.";
    const issues = validateBeforeRender(a);
    expect(issues.some((i) => i.code === "TOKEN_MUSTACHE")).toBe(true);
  });

  it("flags literal well-supported placeholder", () => {
    const a = base();
    a.ExecutiveSummary.narrative = "Damages are well-supported by the record.";
    const issues = validateBeforeRender(a);
    expect(issues.some((i) => i.code === "TOKEN_WELL_SUPPORTED")).toBe(true);
  });

  it("flags NaN% and out-of-range scores", () => {
    const a = base();
    a.Scores.case_strength = 150;
    a.ExecutiveSummary.narrative = "Confidence is NaN%.";
    const issues = validateBeforeRender(a);
    expect(issues.some((i) => i.code === "SCORE_OUT_OF_RANGE")).toBe(true);
    expect(issues.some((i) => i.code === "TOKEN_NAN_PERCENT")).toBe(true);
  });

  it("flags criminal doctrine leaking into commercial reports", () => {
    const a = base();
    a.ExecutiveSummary.case_type = "commercial";
    a.Findings.push({
      id: "f1",
      title: "Motion",
      description: "A Franks hearing may be warranted.",
      category: "legal",
      severity: "medium",
      confidence: 0.5,
      citations: [],
      suppressed: false,
      quarantined: false,
    });
    const issues = validateBeforeRender(a);
    expect(issues.some((i) => i.code === "CASE_TYPE_LEAK")).toBe(true);
  });

  it("does not flag Franks hearing in a criminal report", () => {
    const a = base();
    a.ExecutiveSummary.case_type = "criminal";
    a.ExecutiveSummary.narrative = "A Franks hearing is warranted.";
    const issues = validateBeforeRender(a);
    expect(issues.some((i) => i.code === "CASE_TYPE_LEAK")).toBe(false);
  });

  // Audit P0-4/P0-5 regression guard: these U.S. procedural terms have no
  // Mexican-law equivalent and are wrong for every case type, unlike
  // CRIMINAL_ONLY_TERMS above which is only wrong for the WRONG case type.
  it("flags U.S. procedural terms regardless of case type", () => {
    const civil = base();
    civil.ExecutiveSummary.case_type = "commercial";
    civil.ExecutiveSummary.narrative = "Counsel should file a Motion to Dismiss.";
    expect(validateBeforeRender(civil).some((i) => i.code === "US_PROCEDURE_LEAK")).toBe(true);

    const criminal = base();
    criminal.ExecutiveSummary.case_type = "criminal";
    criminal.ExecutiveSummary.narrative = "Summary Judgment is available here.";
    expect(validateBeforeRender(criminal).some((i) => i.code === "US_PROCEDURE_LEAK")).toBe(true);
  });

  it("partitionIssues splits by severity", () => {
    const { critical, warnings } = partitionIssues([
      { code: "X", severity: "critical", section: "S", message: "" },
      { code: "Y", severity: "warning", section: "S", message: "" },
    ]);
    expect(critical.length).toBe(1);
    expect(warnings.length).toBe(1);
  });
});

// Canonical Reconciliation Design (2026-08-16), P3 §10 — validateRenderedReport
// is the same prose-walking approach as validateBeforeRender, pointed at the
// actual reports.full_report shape (a plain object, not the 17-section
// CaseAnalysis) instead of the separate, unused-by-the-real-report
// canonical_analysis projection, plus a Spanish criminal-institution
// denylist.
describe("validateRenderedReport", () => {
  it("flags unresolved template tokens in a plain report-shaped object", () => {
    const issues = validateRenderedReport(
      { attorney_summary: "Damages total {{amount}}." },
      "civil",
    );
    expect(issues.some((i) => i.code === "TOKEN_MUSTACHE")).toBe(true);
  });

  it("flags English criminal-doctrine leakage into a civil report", () => {
    const issues = validateRenderedReport(
      { risk_analysis: "A Franks hearing may be warranted here." },
      "civil",
    );
    expect(issues.some((i) => i.code === "CASE_TYPE_LEAK")).toBe(true);
  });

  it("does not flag English criminal-doctrine terms in an actual criminal report", () => {
    const issues = validateRenderedReport(
      { risk_analysis: "A Franks hearing may be warranted here." },
      "criminal",
    );
    expect(issues.some((i) => i.code === "CASE_TYPE_LEAK")).toBe(false);
  });

  it("flags a Spanish penal-only institution leaking into a civil report — the real ADR 4640/2017-shaped failure", () => {
    const issues = validateRenderedReport(
      {
        full_report: {
          prose: {
            witness_analysis:
              "La resolución del Tribunal de Enjuiciamiento desestimó un argumento novedoso.",
          },
        },
      },
      "civil",
    );
    expect(issues.some((i) => i.code === "SPANISH_CASE_TYPE_LEAK")).toBe(true);
  });

  it("does not flag Spanish penal-only institutions in an actual penal report", () => {
    const issues = validateRenderedReport(
      { procedural_issues_report: "El Ministerio Público presentó la carpeta de investigación." },
      "penal",
    );
    expect(issues.some((i) => i.code === "SPANISH_CASE_TYPE_LEAK")).toBe(false);
  });

  it("flags U.S. procedural terms regardless of case type, walking nested full_report content", () => {
    const issues = validateRenderedReport(
      { full_report: { prose: { recommendations: "Counsel should file a Motion to Dismiss." } } },
      "civil",
    );
    expect(issues.some((i) => i.code === "US_PROCEDURE_LEAK")).toBe(true);
  });

  it("returns no issues for clean, on-materia content", () => {
    const issues = validateRenderedReport(
      { attorney_summary: "El demandado incumplió el contrato de compraventa." },
      "civil",
    );
    expect(issues).toHaveLength(0);
  });

  it("does not turn internal generation audit messages into rendered-content failures", () => {
    const issues = validateRenderedReport(
      {
        attorney_summary: "El expediente contiene constancias verificadas.",
        full_report: {
          validation: { quality_gate: { critical_issues: ["legal_memorandum absent", "memo chunk failed"] } },
          pipeline_warnings: ["well-supported internal marker"],
        },
      },
      "civil",
    );
    expect(issues.some((issue) => issue.code === "REPORT_QUALITY_CRITICAL")).toBe(false);
    expect(issues.some((issue) => issue.code === "TOKEN_WELL_SUPPORTED")).toBe(false);
  });
});
