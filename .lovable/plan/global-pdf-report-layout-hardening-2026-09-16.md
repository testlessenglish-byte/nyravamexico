# Global PDF report layout hardening

## Scope
Repair the shared Nyrava PDF renderer used across all materias and report exports. Preserve all evidence, citation, LIMITED-mode, scoring, recommendation, legal-analysis, contract, and release-gate rules unchanged.

## Implementation

1. **Correct pagination at the shared renderer level**
   - Remove the extra page creation in the cover flow so the cover produces exactly one page and the dashboard starts on the next real content page.
   - Replace fixed `ensureSpace(...)` guesses with printable-area helpers that measure available height and reserve the running header, footer, margins, and requested spacing.
   - Add reusable block controls for “keep together if it fits,” “heading plus first content,” and “allow long content to split.”
   - Measure the complete dashboard rows before placement so cards stay together when they fit and move as a unit only when necessary.

2. **Make every shared component bounds-safe**
   - Wrap labels, values, headings, callouts, finding chips, evidence quotations, and other boxed text to their actual inner width.
   - Compute box/card heights from wrapped lines instead of fixed heights or truncation.
   - Keep readable font sizes; reflow vertically rather than globally shrinking content.
   - Track each rendered block’s page and bounds for final QA.

3. **Repair shared tables and citation annexes**
   - Constrain all tables to the printable width and normalize explicit column widths against the available width.
   - Use wrapped cell text and dynamic row heights; permit genuinely long rows to split across pages without clipping.
   - Give citation/source columns sensible proportional widths, repeat headers on continuation pages, and prevent table content from entering header/footer areas.
   - Keep small tables together when they fit on the next page; allow large tables to paginate normally.

4. **Finalize numbering only after layout is complete**
   - Remove the hardcoded cover text `Página 1 de 24`.
   - Add all headers, footers, and `Page X / Y` labels in one final pass using the actual final page count, including the cover.
   - Ensure page-number labels are internally consistent after any safe blank-page removal/reflow.

5. **Add renderer-level PDF QA before release/save**
   - Audit the final layout manifest for blank interior pages, objects outside printable bounds, boxes whose measured content exceeds their height, horizontal table overflow, overlapping tracked blocks, orphan headings, abnormal pagination whitespace, and page-number mismatches.
   - Safely remove only pages proven to contain no report content before final numbering.
   - Fail the render/preflight with explicit rendering QA diagnostics when reflow cannot safely resolve a defect; malformed output will not be saved or returned.
   - Feed this through the existing real-render preflight path without changing legal/content validation or release decisions.

6. **Apply and verify globally**
   - Route the main legal report, legal memorandum, and social audit PDF through the same finalization/QA protections exposed by `PdfBuilder`.
   - Add focused tests for cover/dashboard pagination, blank-page removal, heading cohesion, wrapping and dynamic row height, citation-table continuation, bounds failures, and final page totals.
   - Replay ADR 217/2019 through the real renderer and visually inspect every page after rasterizing the PDF: no blank page 2, compact dashboard, wrapped citation annex, no clipping/overflow, no avoidable mostly-empty pages, and accurate total-page numbering.
   - Run the existing report hardening/regression tests and confirm evidence/release behavior is unchanged.

## Expected files
- `src/lib/export.ts` — shared layout engine, components, tables, dashboard, final numbering, and finalization hook.
- `src/lib/export-legal-memo.ts` — use shared finalization/QA before saving.
- `src/lib/social/reports/audit-report-pdf.server.ts` — use shared finalization/QA before returning bytes.
- A focused renderer QA module and tests under `src/lib/pdf/` and/or existing report test folders.

## Acceptance checks
- Cover is page 1; dashboard begins on page 2 with no blank generated page.
- Every displayed total equals the PDF’s actual final page count.
- No tracked content crosses printable boundaries or its containing box/cell.
- Citation rows wrap and paginate without truncation.
- Long findings flow; short semantic blocks stay together.
- Renderer QA blocks malformed PDFs while all existing legal and evidentiary gates remain unchanged.
