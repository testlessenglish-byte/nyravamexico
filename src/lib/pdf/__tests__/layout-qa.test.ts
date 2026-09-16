import { describe, expect, it } from "vitest";
import { assertPdfLayout, auditPdfLayout } from "../layout-qa";

describe("PDF layout QA", () => {
  it("detects a blank interior page", () => {
    const issues = auditPdfLayout({
      pages: [
        { contentMarks: 4, maxContentY: 700 },
        { contentMarks: 0, maxContentY: 0 },
        { contentMarks: 2, maxContentY: 200 },
      ],
      pageCount: 3,
      expectedPageCount: 3,
      recordedIssues: [],
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: "BLANK_INTERIOR_PAGE", page: 2 }));
  });

  it("blocks recorded bounds and table-width failures", () => {
    const issues = auditPdfLayout({
      pages: [{ contentMarks: 1, maxContentY: 100 }],
      pageCount: 1,
      expectedPageCount: 1,
      recordedIssues: [
        { code: "TABLE_WIDTH_OVERFLOW", page: 1, detail: "too wide" },
      ],
    });
    expect(() => assertPdfLayout(issues)).toThrow("PDF_RENDER_LAYOUT_BLOCKED");
  });

  it("accepts a clean final layout with matching numbering", () => {
    const issues = auditPdfLayout({
      pages: [
        { contentMarks: 5, maxContentY: 700 },
        { contentMarks: 8, maxContentY: 650 },
      ],
      pageCount: 2,
      expectedPageCount: 2,
      recordedIssues: [],
    });
    expect(issues).toEqual([]);
  });
});