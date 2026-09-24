// Single source of truth for what a full "Rerun from scratch" clears.
// Used both at click time (queueCaseForPipeline) and when the worker picks
// the case up (runPipelineForCase's reset branch), so a rerun can never
// leave stale derived data behind from the previous run.
//
// Documents (and their extracted text) are intentionally preserved: they are
// the evidence the attorney uploaded, not derived output. Everything the
// pipeline produces from them is deleted.

export const CASE_DERIVED_TABLES = [
  "analyses",
  "canonical_analysis",
  "agent_findings",
  "agent_logs",
  "case_findings",
  "case_scores",
  "case_opportunities",
  "case_perspectives",
  "case_strategy",
  "case_strategy_center",
  "case_theories",
  "case_timeline_events",
  "case_trial_prep",
  "case_witnesses",
  "case_work_product",
  "case_motion_drafts",
  "case_domain_activations",
  "case_chat_messages",
  "case_finding_patches",
  "case_decision_reconstructions",
  "evidence_classifications",
  "image_intelligence",
  "report_versions",
  "reports",
  "report_chunk_caches",
  "pipeline_events",
  // Verification / provenance artifacts of the previous execution. Left
  // behind these made a fresh run look like it had inherited the earlier
  // run's cross-agent audit trail and finding history.
  "cross_agent_audit",
  "finding_version_snapshots",
  "pipeline_trace",
  // Completed Case Audit / Outcome Assessment (completed-case-audit.server.ts).
  // Runs as the LAST step of the pipeline and inserts — never overwrites —
  // a new case_outcome_assessments row per run (by design: a normal
  // re-audit of a still-completed case should not erase prior audit
  // history). But that means a full "Rerun from scratch" left old rows
  // behind, and getCase() (the export path, see cases.functions.ts) picks
  // the most recent row by created_at with no other freshness check. If
  // the NEW run's audit step never runs (e.g. the case is switched to
  // "ongoing" mode) or fails non-fatally, the export would silently keep
  // serving the PREVIOUS run's audit — a stale row masquerading as current.
  // Included here so a full reset guarantees no run's audit output can
  // ever outlive the run that produced it.
  "case_outcome_assessments",
] as const;


// Every stage timestamp / cached artifact column on `cases` that must go back
// to its "never ran" value so no stage is treated as already complete.
export const CASE_RESET_FIELDS = {
  extracted_at: null,
  analysis_at: null,
  agents_at: null,
  scored_at: null,
  report_at: null,
  theories_at: null,
  opportunities_at: null,
  trial_prep_at: null,
  witnesses_at: null,
  perspectives_at: null,
  evidence_intel_at: null,
  strategy_at: null,
  strategy_center_at: null,
  contradiction_at: null,
  discovery_at: null,
  hallucination_at: null,
  work_product_at: null,
  completed_at: null,
  shared_brief: null,
  shared_brief_at: null,
  hallucination_report: null,
  legal_qa_report: null,
  procedural_compliance: null,
  extraction_report: null,
  // CONFIRMED LIVE (ADR-4640-2017-180212): jurisdiction_profile is written
  // unconditionally by jurisdiction-intel.server.ts whenever that stage
  // runs, but was never part of ANY reset — a profile computed once under a
  // bad/unresolved materia (e.g. this session's "civil" schema fallback)
  // could survive every subsequent rerun forever, since nothing ever forced
  // the stage to recompute it against corrected data.
  jurisdiction_profile: null,
  attack_surface: {},
  error: null,
  stall_reason: null,
  status_message: null,
  progress: 0,
  report_checkpoint_count: 0,
  stall_auto_retry_count: 0,
  cancel_requested: false,
} as const;

/** Narrower reset for an automatic materia CORRECTION (see
 *  case-classification.server.ts's stale-artifact invalidation) — every
 *  legal-reasoning-derived stage timestamp/cached artifact goes back to
 *  "never ran," but extraction is deliberately preserved: OCR/text
 *  extraction has no dependency on the case's materia, so invalidating it
 *  serves no purpose. CONFIRMED LIVE (ADR-4640-2017-180212): reusing the
 *  full CASE_RESET_FIELDS (which includes extracted_at/extraction_report)
 *  here made a correction that fires whenever the deterministic classifier
 *  disagrees with an unlocked declared value bounce the whole case back to
 *  the "extraction" stage — for a materia-ambiguous document this can fire
 *  on every run, which looks to the attorney like a case that "keeps
 *  getting stuck then going back to extraction and never completes." */
export const CASE_TYPE_CORRECTION_RESET_FIELDS = {
  analysis_at: null,
  agents_at: null,
  scored_at: null,
  report_at: null,
  theories_at: null,
  opportunities_at: null,
  trial_prep_at: null,
  witnesses_at: null,
  perspectives_at: null,
  evidence_intel_at: null,
  strategy_at: null,
  strategy_center_at: null,
  contradiction_at: null,
  discovery_at: null,
  hallucination_at: null,
  work_product_at: null,
  completed_at: null,
  shared_brief: null,
  shared_brief_at: null,
  hallucination_report: null,
  legal_qa_report: null,
  procedural_compliance: null,
  // Same rationale as CASE_RESET_FIELDS above: a jurisdiction_profile
  // computed under the OLD/wrong materia must not survive a correction —
  // it is never touched by the pipeline again once set, unless a reset
  // forces jurisdiction-intel.server.ts to recompute it.
  jurisdiction_profile: null,
  attack_surface: {},
  error: null,
  stall_reason: null,
  status_message: null,
  progress: 0,
  report_checkpoint_count: 0,
  cancel_requested: false,
} as const;

/** Deletes every derived row produced by previous runs of this case. */
export async function clearCaseDerivedData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  caseId: string,
): Promise<void> {
  for (const table of CASE_DERIVED_TABLES) {
    const { error } = await db.from(table).delete().eq("case_id", caseId);
    if (error) {
      // A missing/locked derived table must never abort the rerun.
      console.warn(`[pipeline.reset] failed clearing ${table}: ${error.message}`);
    }
  }
}
