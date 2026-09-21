# Correct legal-thesis report release

## Root cause
- The report itself is present, non-empty, and tied to the active execution.
- The uploaded source is a published legal thesis containing a verified `Criterio jurídico`, but the decision-reconstruction step discarded the model’s paraphrased quote because it was not verbatim.
- That left the mandatory decision core empty. Since the case was explicitly run in concluded-audit mode, the unchanged release gate correctly blocked release.
- The timed-out constitutional-rights agent and the eight rejected procedural checks are non-blocking diagnostics; they are not the current release blocker.

## Implementation
- Add a shared, deterministic fallback that recognizes published judicial criteria by document structure and extracts the exact `Criterio jurídico` text as a source-verified court holding.
- Apply it only when normal reconstruction yields no verified holding/disposition, preserving the normal model result whenever available.
- Keep the mandatory decision-core gate unchanged: no bypass, threshold reduction, case ID, materia, or report-text whitelist.
- Ensure the recovered holding uses the exact uploaded source text and retains its document reference.

## Verification
- Add tests for a published thesis with `Criterio jurídico`, ordinary judgments, malformed/unsupported text, and multiple materias.
- Confirm the reconstructed holding is promoted into the report and satisfies decision-core coverage only when actually represented.
- Run focused tests, typecheck, and inspect build diagnostics.
- Do not delete, overwrite, or manually release any existing report; the corrected shared pipeline will be used on the next report rerun after publishing.
