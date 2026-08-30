import { describe, it, expect } from "vitest";
import { computeESS } from "../sufficiency.server";

describe("computeESS 4-dimension model", () => {
  it("determines court holding sufficiency on a single complete SCJN judgment", () => {
    const res = computeESS({
      documentCount: 1,
      pageCount: 35,
      extractedChars: 45000,
      factCount: 12,
      contradictionCount: 0,
      corroboratedCount: 0,
      highWeightDocTypeCount: 1,
      distinctDocTypeCount: 1,
      caseAnalysisMode: "judgment_audit",
    });

    expect(res.sufficient_to_determine_court_holding).toBe(true);
    expect(res.dimensions.sufficient_to_determine_court_holding).toBe(true);
    // Single document is NOT sufficient to reconstruct the entire underlying case history
    expect(res.sufficient_to_reconstruct_entire_case).toBe(false);
    expect(res.dimensions.sufficient_to_reconstruct_entire_case).toBe(false);
    // Concluded judgment audit is NOT for forward-looking trial strategy
    expect(res.sufficient_for_strategic_recommendations).toBe(false);
    expect(res.allowQuantitativeScores).toBe(true);
  });

  it("determines case reconstruction sufficiency on a multi-document record", () => {
    const res = computeESS({
      documentCount: 6,
      pageCount: 120,
      extractedChars: 85000,
      factCount: 30,
      contradictionCount: 2,
      corroboratedCount: 8,
      highWeightDocTypeCount: 2,
      distinctDocTypeCount: 3,
      caseAnalysisMode: "ongoing",
    });

    expect(res.sufficient_to_determine_court_holding).toBe(true);
    expect(res.sufficient_to_reconstruct_entire_case).toBe(true);
    expect(res.sufficient_for_strategic_recommendations).toBe(true);
    expect(res.sufficient_for_quantitative_scoring).toBe(true);
  });
});
