# Remediate unsupported absence sentences instead of blocking the report

A single uncited "no existe / no obra en el expediente" sentence coming from the
missing-evidence section currently fails the final contract check, so an
otherwise valid report is blocked and forced into LIMITED mode. The fix is a
remediate-then-revalidate step at the report writer → final contract boundary.
No gate is removed, no threshold is lowered.

## Files and functions changed (only these)

1. `src/lib/reporting/report-content-policy.ts`
   - New exported `remediateAbsenceLanguage(text)`: rewrites absolute absence
     wording (es/en) into qualified wording — "El material analizado no
     acredita…", "No se identificó en las fuentes analizadas…". Returns the new
     text plus a rewritten flag.
   - `transformReportContent`: the existing inline absence rewrite now calls
     this helper so a wider set of absolute phrasings is qualified rather than
     left to trip the validator. Verified absences (with citation /
     `absence_verified`) keep the stronger statement untouched.

2. `src/lib/reporting/final-report-contract.ts`
   - New internal `remediateUnverifiedAbsences(payload, capability, governance)`:
     walks the composed payload, applies the helper only to nodes the validator
     flagged as `unverifiedAbsencePresent`, and leaves everything else byte
     identical.
   - `releaseFinalReportPayload`: if validation fails and
     `unverifiedAbsencePresent` is among the errors, run the remediation pass and
     revalidate once. Release only if the revalidation is clean; any remaining
     violation (including a remaining unverified absence) still blocks.
   - `releaseRenderedReportOutput`: remediate the rendered text the same way
     before it is submitted for validation, since renderer output is assembled
     after the composition transforms and is otherwise never sanitized.

3. `src/lib/intelligence/report-canonical-context.ts`
   - `sanitizeNarrativeProse`: apply the same qualifier to
     `prose.missing_evidence_report` so the missing-evidence section itself never
     emits an absolute absence claim unless it is verified. Existing
     filing/absence-inversion scrubs are unchanged.

4. `src/lib/reporting/__tests__/` — one new test file asserting: an uncited
   absence sentence is remediated and the report releases; a substantive uncited
   factual claim still blocks; a verified/cited absence keeps its strong wording.

## Explicitly not touched

Materia detection, amparo/legal engines, prompts, citation and hallucination
thresholds, Legal QA, report structure, database, RLS, auth, Mexico-lock.

## Verification

- Run the existing report/contract test suites plus the new test.
- Re-run the ADR-based regression fixtures and confirm materia, Legal QA
  results, citation/hallucination checks and JSON diagnostics are unchanged and
  the final report is produced.
