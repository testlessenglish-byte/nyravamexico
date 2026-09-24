# Fix the held-back Family report (ADR 6433/2022)

## What is actually happening
Reports are not broken across the site. The last Immigration/Amparo reports (Joe Smith — Amparo, Jorge Espinal 2, Joe — Migratorio) all released. Only the newest case, **ADR 6433/2022 (Family)**, finished at 100% and was then held back by quality checks for three reasons:

1. **Missing ruling point** — 1 of the 3 verified points from the court's decision does not appear in the summary or findings.
2. **Placeholder wording leaked** — a template phrase ("well supported" filler) was left in the facts, timeline summary and full report.
3. **Wrong-area wording** — Spanish terms belonging to a different legal area (e.g. criminal vocabulary) appeared in a Family report.

The checks did their job; the report generator for Family cases produced text that should not pass.

## Fix (Family cases, shared code only — Immigration/Amparo en Revisión stays frozen)
1. Confirm each cause against the saved report: find the missing ruling point, the exact leaked filler sentences, and the exact wrong-area words and where they come from.
2. Ensure every verified ruling point is always carried into the executive summary / findings for Family cases (using only what the court documents say — nothing invented).
3. Replace or remove the "well supported" filler at its source so it is never written as literal text.
4. Fix the wording source so Family reports use Family vocabulary; if the leak is a legitimate quote or reference, make sure the existing context-aware check recognizes it rather than loosening the check.
5. Re-run ADR 6433/2022 and confirm it releases.

## Guarantees
- No quality check is weakened or turned off.
- No changes to the frozen Immigration / Amparo en Revisión pipeline.
- No rollback of the site.

## Verification
- Add regression tests for the three causes (Family), plus run the existing Immigration, Penal, Civil and Labor report tests to confirm nothing else changes.
- Check the preview builds cleanly.
- The background processor runs the published version, so the fix needs publishing before the re-run works live.
