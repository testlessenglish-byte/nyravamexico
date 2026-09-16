# Platform-wide report pipeline correction

## Confirmed root cause
- ADR 6312/2018 did persist its report. `runReport()` upserted it, `runFinalReleaseReview()` read it, all four verification agents passed, and `finalize_report_release` atomically saved a blocked draft with case status `needs_revision` at 99%. The release decision had three substantive contract errors, not a citation/hallucination failure.
- A separate admin multi-agent rerun began about 19 seconds later. Its `contradictions` agent called `deriveContradictions()`, whose shared `invalidateReleasedSnapshot()` treats `needs_revision` as a released terminal snapshot and deletes `reports`, `report_versions`, and `canonical_analysis`. That post-pipeline analytical rerun is the exact reason the final database state had `report_generator: completed` but `reports: null`.
- About five seconds later, the manual stuck-state clear ran after every ledger stage was already terminal. `clearPipelineStuckState()` found no incomplete stage but unconditionally overwrote `needs_revision` with `failed`, progress 90, and `stall_reason: manual_clear`. This produced the contradictory “no incomplete stage found” terminal state.
- Independently, shared stage semantics are inconsistent: `REPORT_BLOCKING_ENGINES` includes optional stages, while the runner excludes optional failures; and all specialized agents inside the blocking `agents` stage currently hard-fail the parent even when case-specific applicability should make them conditional or optional.
- Additional report-completion invariants are missing: a completed report ledger can be trusted without verifying a same-execution report row, and duplicate engine suppression resolves like successful execution. These are shared race/recovery defects even though the observed ADR deletion path is now confirmed.

## Generalized implementation after diagnosis
- Define one case-aware requirement decision for every stage: required, conditionally required, optional, or not applicable.
- Use that same decision in scheduling, dependency propagation, report preflight, final release review, progress calculation, and recovery.
- Preserve every citation, evidence-integrity, legal QA, LIMITED-mode, scoring, recommendation, and final report contract gate.
- Let optional failures degrade with structured diagnostics; let required failures block with exact engine, reason, and failed condition.
- Prevent read-only/manual multi-agent diagnostics from invoking derived-engine invalidation or deleting a saved blocked/released report.
- Make report persistence and report-generator completion atomic in effect: a completed ledger row must correspond to a persisted report for the same execution; duplicate suppression must not count as stage success.
- Replace ambiguous 90% terminal states with deterministic resumable, blocked, needs-revision, released, or failed states.
- Correct stuck-state recovery so it preserves a valid terminal state when no stage is incomplete and otherwise derives a resume point using the same canonical requirement rules.

## Verification
- Add focused state-machine tests for optional failures, conditional requirements, required failures, report persistence mismatch, recovery, and final-state invariants.
- Regression-test ADR 217/2019 and ADR 6312/2018 plus representative Penal, Civil, Family/Labor, Amparo-Penal, and non-Penal Amparo cases.
- Confirm no safety gate is weakened and check the preview build diagnostics.

## Technical boundaries
- Shared pipeline/state-machine code only; no case-ID exceptions.
- No changes to legal-content registries or substantive legal analysis.
- No destructive reset of existing case evidence or reports during implementation.
