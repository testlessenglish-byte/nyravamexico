# Fix stale report-blocked warning

## Goal
Stop the Reports page from showing `REPORT_CONTRACT_BLOCKED: decisionCoreFirst` after the current report has already passed validation and been released.

## Changes
- Refresh the selected case/report while processing is active so the on-screen state cannot remain stuck on a pre-release snapshot.
- Before PDF or JSON download, fetch the latest case data, verify the case identity, update the page cache, and validate/export that fresh snapshot.
- Keep every existing report contract, citation, hallucination, QA, and release gate unchanged.
- Add a regression test covering a stale cached snapshot followed by a valid released report at download time.

## Verification
- Run the report contract and export tests.
- Test the affected Jorge Espinal case in the signed-in preview and confirm JSON downloads as a released report with no red blocked alert.
- Confirm the preview build remains clean.
