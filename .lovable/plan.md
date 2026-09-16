# Platform-wide report pipeline correction

## Root cause report first
- Reconstruct ADR 6312/2018 from its case row, execution ledger, pipeline trace, and report table.
- Identify the exact shared functions and state transitions that produced `report_generator: completed` without a persisted report and the contradictory stuck-state message.
- Present the diagnosis before making implementation changes.

## Generalized implementation after diagnosis
- Define one case-aware requirement decision for every stage: required, conditionally required, optional, or not applicable.
- Use that same decision in scheduling, dependency propagation, report preflight, final release review, progress calculation, and recovery.
- Preserve every citation, evidence-integrity, legal QA, LIMITED-mode, scoring, recommendation, and final report contract gate.
- Let optional failures degrade with structured diagnostics; let required failures block with exact engine, reason, and failed condition.
- Make report persistence and report-generator completion atomic in effect: a completed ledger row must correspond to a persisted report for the same execution.
- Replace ambiguous 90% terminal states with deterministic resumable, blocked, needs-revision, released, or failed states.
- Correct stuck-state recovery so it derives a valid next action and never writes “no incomplete stage” while forcing a failed state.

## Verification
- Add focused state-machine tests for optional failures, conditional requirements, required failures, report persistence mismatch, recovery, and final-state invariants.
- Regression-test ADR 217/2019 and ADR 6312/2018 plus representative Penal, Civil, Family/Labor, Amparo-Penal, and non-Penal Amparo cases.
- Confirm no safety gate is weakened and check the preview build diagnostics.

## Technical boundaries
- Shared pipeline/state-machine code only; no case-ID exceptions.
- No changes to legal-content registries or substantive legal analysis.
- No destructive reset of existing case evidence or reports during implementation.
