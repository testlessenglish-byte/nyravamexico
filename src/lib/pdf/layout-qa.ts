export type PdfLayoutIssueCode =
  | "BLANK_INTERIOR_PAGE"
  | "CONTENT_OUTSIDE_PRINTABLE_BOUNDS"
  | "BOX_CONTENT_OVERFLOW"
  | "TABLE_WIDTH_OVERFLOW"
  | "ORPHAN_HEADING"
  | "PAGE_NUMBER_MISMATCH";

export interface PdfLayoutIssue {
  code: PdfLayoutIssueCode;
  page: number;
  detail: string;
}

export interface PdfLayoutPage {
  contentMarks: number;
  maxContentY: number;
}

export interface PdfLayoutAuditInput {
  pages: PdfLayoutPage[];
  pageCount: number;
  expectedPageCount: number;
  recordedIssues: PdfLayoutIssue[];
}

/** Pure final-layout audit. Legal/content policy is deliberately out of scope. */
export function auditPdfLayout(input: PdfLayoutAuditInput): PdfLayoutIssue[] {
  const issues = [...input.recordedIssues];
  for (let index = 1; index < input.pages.length - 1; index += 1) {
    if ((input.pages[index]?.contentMarks ?? 0) === 0) {
      issues.push({
        code: "BLANK_INTERIOR_PAGE",
        page: index + 1,
        detail: "Interior page contains no report content.",
      });
    }
  }
  if (input.pageCount !== input.expectedPageCount) {
    issues.push({
      code: "PAGE_NUMBER_MISMATCH",
      page: 1,
      detail: `Final page count ${input.pageCount} differs from numbering total ${input.expectedPageCount}.`,
    });
  }
  return issues;
}

export function assertPdfLayout(issues: readonly PdfLayoutIssue[]): void {
  if (!issues.length) return;
  const summary = issues.map((issue) => `${issue.code}:p${issue.page}`).join(", ");
  throw new Error(`PDF_RENDER_LAYOUT_BLOCKED: ${summary}`);
}