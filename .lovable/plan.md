# Make held-back reports correct themselves and release, for every case type

## What is happening
Reports finish at 100%, then the quality checks hold them back (latest: ADR 6433/2022, Family). The same three causes repeat across case types:

1. **Missing ruling point** — a verified point from the court's decision is left out of the summary/findings.
2. **Placeholder wording** — a template "well supported" filler phrase is written as literal text.
3. **Wrong-area wording** — terms from another legal area (e.g. criminal) appear, or a legitimate quote gets flagged.

Today, when a check fails, the report just stops at "needs revision". Nothing tries to repair it.

## The fix (shared for all case types)
1. **Stop the causes at the source**
   - Always carry every verified ruling point into the summary and findings (only what the documents say — nothing invented).
   - Remove the "well supported" filler at its source so it is never written as text.
   - Make each report use its own legal area's vocabulary; ensure quotes and references to other areas are recognized as such.
2. **Add an automatic correction step before final release**
   - If a check fails for a fixable reason (missing ruling point, filler text, wrong-area wording), the system repairs that exact part using the verified case data and re-runs all checks.
   - Up to 2 correction rounds. If it passes, the report releases.
   - If it still fails, the report stays held with a clear, single reason shown — never released with a real problem.
3. **Re-run** ADR 6433/2022 and the other held-back cases to confirm they release.

## Guarantees
- No quality check is weakened, skipped or turned off — corrections must pass the same checks.
- No invented legal facts; repairs use only verified document data.
- No rollback of the site.

## Immigration / Amparo en Revisión (frozen)
That pipeline is frozen per your earlier instruction. It will be left untouched unless you confirm it should also get the automatic correction step.

## Verification
- Regression tests for the three causes and the correction step across Family, Civil, Labor, Penal, Amparo and Immigration (Immigration as test only).
- Preview builds cleanly.
- Needs publishing before background re-runs use the fix.
