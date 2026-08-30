// Server-only extraction of the full-pipeline runner so it can be invoked
// both from an authenticated server function (user click) and from the
// background worker route (cron / queue drain) with an admin client.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { PIPELINE_STAGES, runTimelineAudit, type PipelineStageKey } from "./cases.functions";
import { ENGINE, engineForStage } from "./execution/canonical";
import {
  withTraceScope,
  currentTraceScope,
  newCorrelationId,
  traceAsync,
} from "./pipeline-trace.server";
import esLocale from "@/i18n/locales/es.json";
import enLocale from "@/i18n/locales/en.json";
import { withStageTimeout } from "@/lib/execution/blocking-stage-guard.server";

type Db = SupabaseClient<Database>;

const RUNNER_LEASE_EXTENSION_MS = 3 * 60 * 1000; // 3 minutes

export type RunPipelineOpts = {
  caseId: string;
  startFrom?: string;
  reset?: boolean;
  executionId?: string;
};

export async function runPipelineForCase(
  supabase: Db,
  userId: string,
  opts: RunPipelineOpts,
): Promise<{
  ok: boolean;
  cancelled?: boolean;
  completedStages: number;
  warnings?: Array<{ key: string; error: string }>;
  failedAt?: string;
}> {
  const { withAIUser } = await import("@/lib/ai/user-scope.server");
  // Open the instrumentation scope for the WHOLE run so nested code (engines,
  // the AI router, DB helpers) can emit trace rows without extra plumbing.
  return withTraceScope(
    {
      db: supabase,
      caseId: opts.caseId,
      userId,
      correlationId: newCorrelationId(opts.caseId),
    },
    () =>
      withAIUser(userId, async () => {
        try {
          return await _runPipelineForCase(supabase, userId, opts);
        } catch (e) {
          // Crash safety: an unexpected throw (stage timeout, provider
          // failover exhaustion, DB error) must never leave the case holding
          // its lease / concurrency slot until expiry.
          const { releasePipelineLease } = await import("@/lib/pipeline-lease.server");
          await releasePipelineLease(
            supabase,
            opts.caseId,
            "runPipelineForCase",
            e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
          );
          throw e;
        }
      }),
  );
}

async function _runPipelineForCase(
  supabase: Db,
  userId: string,
  opts: RunPipelineOpts,
): Promise<{
  ok: boolean;
  cancelled?: boolean;
  completedStages: number;
  warnings?: Array<{ key: string; error: string }>;
  failedAt?: string;
}> {
  const { caseId, startFrom, reset } = opts;

  // Structured instrumentation — every stage transition and case-status write
  // logs a single JSON line so the full automatic execution path can be
  // reconstructed from worker logs. correlationId ties every line together.
  const correlationId = currentTraceScope()?.correlationId ?? newCorrelationId(caseId);
  const runStart = Date.now();
  const trace = (event: string, extra: Record<string, unknown> = {}) => {
    const payload = {
      t: new Date().toISOString(),
      corr: correlationId,
      caseId,
      userId,
      event,
      elapsed_ms: Date.now() - runStart,
      ...extra,
    };
    console.info(`[pipeline] ${JSON.stringify(payload)}`);
    // Mirror every stage transition into pipeline_trace so the Live Debug
    // panel shows the same timeline the worker log does.
    const status = /failed|error/.test(event)
      ? "error"
      : /blocked|checkpoint|cancelled/.test(event)
        ? "warn"
        : /\.complete$/.test(event)
          ? "ok"
          : /\.start$/.test(event)
            ? "start"
            : "info";
    traceAsync({
      phase: event.startsWith("stage.") ? "stage" : "pipeline",
      step: event,
      status: status as "start" | "ok" | "warn" | "error" | "info",
      durationMs: typeof extra.runtime_ms === "number" ? extra.runtime_ms : null,
      error: typeof extra.error === "string" ? extra.error : null,
      detail: { elapsed_ms: Date.now() - runStart, ...extra },
      db: supabase,
      caseId,
      userId,
      correlationId,
    });
  };

  // Execution identity:
  // A fresh execution is created only on an explicit reset or when no execution_id exists and not resuming.
  const isFreshExecution = Boolean(reset || (!opts.executionId && !startFrom));
  let executionId = opts.executionId;
  if (isFreshExecution) {
    executionId = executionId ?? crypto.randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("cases")
      .update({
        execution_id: executionId,
        execution_started_at: new Date().toISOString(),
        worker_lease_until: new Date(Date.now() + RUNNER_LEASE_EXTENSION_MS).toISOString(),
      })
      .eq("id", caseId);
    trace("execution.started", { execution_id: executionId, reset: !!reset });
  } else if (!executionId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: caseRow } = await (supabase as any)
      .from("cases")
      .select("execution_id")
      .eq("id", caseId)
      .maybeSingle();
    executionId = (caseRow as { execution_id?: string | null } | null)?.execution_id ?? crypto.randomUUID();
    if (!caseRow?.execution_id) {
      await (supabase as any)
        .from("cases")
        .update({
          execution_id: executionId,
          execution_started_at: new Date().toISOString(),
          worker_lease_until: new Date(Date.now() + RUNNER_LEASE_EXTENSION_MS).toISOString(),
        })
        .eq("id", caseId);
    }
  }

  // Authoritative Configuration Validation & Execution Snapshot
  const { data: fullCaseRow } = await (supabase as any)
    .from("cases")
    .select("id,case_type,jurisdiction,analysis_mode,case_analysis_mode,procedural_vehicle,underlying_materia,matter_metadata")
    .eq("id", caseId)
    .maybeSingle();

  const {
    validateConfigurationForExecution,
    createExecutionConfigurationSnapshot,
  } = await import("@/lib/intelligence/case-configuration");

  const validated = validateConfigurationForExecution(fullCaseRow ?? { id: caseId });
  const executionSnapshot = createExecutionConfigurationSnapshot(
    fullCaseRow ?? { id: caseId },
    executionId,
  );

  const mm = ((fullCaseRow as any)?.matter_metadata as Record<string, unknown> | null) ?? {};
  await (supabase as any)
    .from("cases")
    .update({
      matter_metadata: {
        ...mm,
        execution_configuration: executionSnapshot,
      },
    })
    .eq("id", caseId);

  trace("execution.configuration_validated", {
    execution_id: executionId,
    configuration: executionSnapshot,
  });

  let isTerminated = false;
  const runnerAbortController = new AbortController();

  // 30-second heartbeat lease renewal
  const heartbeatTimer = setInterval(async () => {
    if (isTerminated) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: renewed, error: rpcErr } = await (supabase as any).rpc("renew_execution_lease", {
        p_case_id: caseId,
        p_execution_id: executionId,
        p_lease_ms: RUNNER_LEASE_EXTENSION_MS,
      });
      if (rpcErr) {
        // Fallback update
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: directUpd, error: directErr } = await (supabase as any)
          .from("cases")
          .update({ worker_lease_until: new Date(Date.now() + RUNNER_LEASE_EXTENSION_MS).toISOString() })
          .eq("id", caseId)
          .eq("execution_id", executionId)
          .select("id");
        if (directErr || !directUpd?.length) {
          console.warn(`[pipeline-runner] Heartbeat lost lease for execution ${executionId}. Aborting.`);
          runnerAbortController.abort();
        }
      } else if (!renewed) {
        console.warn(`[pipeline-runner] Heartbeat renew returned false for execution ${executionId}. Aborting.`);
        runnerAbortController.abort();
      }
    } catch (hbErr) {
      console.warn("[pipeline-runner] Heartbeat lease renewal failed", hbErr);
    }
  }, 30_000);

  try {

  // ---------------------------------------------------------------------------
  // Checkpoint loop-breaker.
  // When a stage throws CheckpointRequired, the runner catches it, records the
  // checkpoint, and re-queues the case. That is correct for ordinary chunking.
  // But if a stage keeps checkpointing repeatedly WITHOUT making forward
  // progress (e.g. all configured AI keys are out of quota, or every provider
  // in the router failover chain is timing out), the case can loop forever:
  // queue -> worker -> stage -> CheckpointRequired -> queue -> worker ...
  //
  // Defend against that by counting how many times THIS stage has checkpointed
  // during this case's execution. If it exceeds MAX_STAGE_CHECKPOINTS, fail
  // the stage truthfully instead of re-queueing again.
  // ---------------------------------------------------------------------------
  const MAX_STAGE_CHECKPOINTS = 8;
  const stageCheckpointCount = async (stageKey: string): Promise<number> => {
    try {
      // Count "stage.checkpoint" trace events for this case + stage.
      const { data, error } = await supabase
        .from("pipeline_trace")
        .select("id", { count: "exact", head: true })
        .eq("case_id", caseId)
        .eq("step", "stage.checkpoint")
        .contains("detail", { stage: stageKey });
      if (error) return 0;
      return (data as unknown as number) ?? 0;
    } catch {
      return 0;
    }
  };

  const updateCase = async (patch: Record<string, unknown>, source: string) => {
    const withHeartbeat: Record<string, unknown> = { ...patch };
    const statusValue = typeof patch.status === "string" ? patch.status : null;
    const terminalStatuses = new Set([
      "complete",
      "released",
      "needs_revision",
      "failed",
      "cancelled",
    ]);
    const shouldExtendLease =
      statusValue === "intelligence_running" && !terminalStatuses.has(statusValue);
    if (shouldExtendLease) {
      withHeartbeat.worker_lease_until = new Date(
        Date.now() + RUNNER_LEASE_EXTENSION_MS,
      ).toISOString();
    } else if (statusValue && terminalStatuses.has(statusValue)) {
      withHeartbeat.worker_lease_until = null;
    }
    const includesStatus = Object.prototype.hasOwnProperty.call(patch, "status");
    let before: Record<string, unknown> | null = null;
    if (includesStatus) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("cases")
        .select("status,status_message,next_stage,queued_at,worker_lease_until,execution_id")
        .eq("id", caseId)
        .maybeSingle();
      before = (data ?? null) as Record<string, unknown> | null;
      if (before && before.execution_id && before.execution_id !== executionId) {
        runnerAbortController.abort();
        throw new Error(`Execution ${executionId} superseded by ${before.execution_id}`);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("cases")
      .update(withHeartbeat as any)
      .eq("id", caseId)
      .eq("execution_id", executionId);
    if (error) {
      traceAsync({
        phase: "db",
        step: `update:cases`,
        status: "error",
        error: error.message,
        detail: {
          source,
          patch: Object.keys(withHeartbeat),
          pg_code: error.code ?? null,
          pg_details: error.details ?? null,
        },
        db: supabase,
        caseId,
        userId,
        correlationId,
      });
      throw new Error(`case update failed at ${source}: ${error.message}`);
    }
    if (includesStatus) {
      trace("case.status.write", {
        source,
        previous_status: before?.status ?? null,
        new_status: patch.status ?? null,
        previous_next_stage: before?.next_stage ?? null,
        new_next_stage: withHeartbeat.next_stage ?? before?.next_stage ?? null,
        previous_lease_until: before?.worker_lease_until ?? null,
        new_lease_until: withHeartbeat.worker_lease_until,
      });
    }
  };

  if (reset) {
    try {
      const { clearProviderCooldowns } = await import("@/lib/ai/cooldown.server");
      const cleared = clearProviderCooldowns();
      trace("ai.cooldowns.cleared_for_reset", { cleared });
    } catch (cooldownErr) {
      trace("ai.cooldowns.clear_failed", {
        error: cooldownErr instanceof Error ? cooldownErr.message : String(cooldownErr),
      });
    }
    // Single source of truth: pipeline-reset.ts. This block used to carry its
    // OWN hardcoded table list, which had drifted and no longer included
    // canonical_analysis, report_versions, case_strategy_center,
    // case_timeline_events, case_motion_drafts, case_domain_activations,
    // case_chat_messages or image_intelligence — so a "full rerun" (including
    // the rerun that follows a benchmark reseed) left the PREVIOUS execution's
    // canonical analysis and report versions in place, and the app could keep
    // serving that older report. Never re-inline the list here.
    const { clearCaseDerivedData, CASE_RESET_FIELDS } = await import("@/lib/pipeline-reset");
    await clearCaseDerivedData(supabase, caseId);
    await updateCase({ ...CASE_RESET_FIELDS }, "pipeline.reset");

  } else {
    await supabase
      .from("cases")
      .update({ cancel_requested: false } as any)
      .eq("id", caseId);
  }

  // 2026-07 audit: the previous bypass here (apiKey/apiKeys hardcoded empty)
  // was left over from a period when the platform's Groq key was dead. Groq
  // is confirmed healthy again (Admin → AI Providers), so resolve the user's
  // active Groq key(s) explicitly, same as every other provider. This is
  // additive, not exclusive — router.server.ts ALSO resolves the user's
  // full key set (any provider) via the ambient userId passed in baseArgs
  // below, so nothing regresses if this resolution comes back empty (e.g.
  // no user-added Groq key, falling back to the platform GROQ_API_KEY).
  let apiKey = "";
  let keys: string[] = [];
  try {
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const resolved = await resolveProviderKeys(supabase, userId, "groq");
    keys = resolved.keys;
    apiKey = keys[0] ?? "";
  } catch (e) {
    console.warn(
      "[pipeline-runner] resolveProviderKeys(groq) failed — falling back to ambient userId resolution only",
      e,
    );
  }
  const baseArgs = { db: supabase, caseId, userId, apiKey, apiKeys: keys, executionId };

  const pipe = await import("@/lib/pipeline.server");
  const eng = await import("@/lib/intelligence/engines.server");
  const lit = await import("@/lib/intelligence/litigation.server");
  const hal = await import("@/lib/intelligence/hallucination.server");
  const prog = await import("@/lib/intelligence/progress.server");
  const persist = await import("@/lib/intelligence/engine-persistence.server");
  const audit = await import("@/lib/intelligence/engine-audit.server");

  let penalRoutingContextPromise:
    | Promise<{
        penal: boolean;
        mode: import("./intelligence/case-analysis-mode").CaseAnalysisMode;
        prerequisites: import("./intelligence/penal-engine-prerequisites").PenalEnginePrerequisites;
      }>
    | null = null;

  const getPenalRoutingContext = () => {
    penalRoutingContextPromise ??= (async () => {
      const [{ resolveCaseIdentity }, { getCaseAnalysisMode }, prerequisiteModule] =
        await Promise.all([
          import("./intelligence/case-classification.server"),
          import("./intelligence/case-analysis-mode"),
          import("./intelligence/penal-engine-prerequisites"),
        ]);
      const [identity, mode, docsResult, classificationResult] = await Promise.all([
        resolveCaseIdentity(supabase, caseId),
        getCaseAnalysisMode(supabase, caseId),
        supabase.from("documents").select("extracted_text").eq("case_id", caseId),
        (supabase as any)
          .from("case_classification_evidence")
          .select("value,source_quote,conflicting_values")
          .eq("case_id", caseId)
          .eq("field", "concluded_status")
          .maybeSingle(),
      ]);
      const corpusText = (docsResult.data ?? [])
        .map((row) => String((row as { extracted_text?: string | null }).extracted_text ?? ""))
        .join("\n");
      const prerequisites = prerequisiteModule.detectPenalEnginePrerequisites(corpusText);
      prerequisites.hasOpenSubsequentProceeding =
        prerequisiteModule.classificationSupportsOpenProceeding(classificationResult.data);
      return {
        penal: identity.caseType === "penal" || identity.underlyingMateria === "penal",
        mode,
        prerequisites,
      };
    })();
    return penalRoutingContextPromise;
  };

  const clearNotApplicableStageArtifacts = async (stage: string) => {
    const tableByStage: Record<string, string> = {
      theories: "case_theories",
      opportunities: "case_opportunities",
      strategy: "case_strategy",
      litigation_strategy_center: "case_strategy_center",
      work_product: "case_work_product",
      witness: "case_witnesses",
    };
    const table = tableByStage[stage];
    if (table) await (supabase as any).from(table).delete().eq("case_id", caseId);
    if (stage === "discovery") {
      await supabase
        .from("case_findings")
        .delete()
        .eq("case_id", caseId)
        .like("source_module", "engine:discovery%");
    }
  };

  const runPenalModeGatedStage = async (
    stage: string,
    engine: string,
    execute: () => Promise<unknown>,
  ) => {
    const context = await getPenalRoutingContext();
    if (context.penal) {
      const { penalEngineApplicability } =
        await import("./intelligence/penal-engine-prerequisites");
      const decision = penalEngineApplicability(stage, context.mode, context.prerequisites);
      if (!decision.run) {
        await clearNotApplicableStageArtifacts(stage);
        const reason = `skipped_not_applicable:${decision.reason ?? "prerequisites_not_met"}`;
        await audit.recordSkipped(supabase, {
          caseId,
          userId,
          engine: engine as never,
          reason,
          executionId,
        });
        return { skipped: true, status: "skipped_not_applicable", reason };
      }
    }
    return persist.runCatalogedEngine(
      supabase,
      { caseId, userId, engine: engine as never, executionId },
      execute,
    );
  };

  const runners: Record<
    PipelineStageKey,
    {
      run: () => Promise<unknown>;
      engine?: string;
    }
  > = {
    extraction: {
      run: () => pipe.runExtraction({ ...baseArgs, clearPriorRuns: isFreshExecution, executionId }),
    },

    agents: { run: () => pipe.runAgents(baseArgs) },
    analyzers: { run: () => pipe.runAnalyzers(baseArgs) },
    scoring: { run: () => pipe.runScoring(baseArgs), engine: ENGINE.scoring },
    jurisdiction_intel: {
      run: () =>
        persist.runCatalogedEngine(
          supabase,
          { caseId, userId, engine: ENGINE.jurisdiction_intel, executionId },
          async () => {
            const { runJurisdictionIntelligence } =
              await import("@/lib/intelligence/jurisdiction-intel.server");
            const value = await runJurisdictionIntelligence({ db: supabase, caseId });
            return {
              value,
              stats: {
                generated: 1,
                accepted: 1,
                rows_written: 1,
                db_write_confirmed: true,
                meta: {
                  source: "deterministic",
                  materia: value.materia,
                  fuero: value.fuero,
                  state: value.state?.name ?? null,
                  state_source: value.state_source,
                },
              },
            };
          },
        ),
    },

    // Análisis de Cumplimiento Procesal — materia checklist over the corpus.
    procedural_compliance: {
      run: () =>
        persist.runCatalogedEngine(
          supabase,
          { caseId, userId, engine: ENGINE.procedural_compliance, executionId },
          async () => {
            const { runProceduralCompliance } =
              await import("@/lib/intelligence/procedural-compliance.server");
            const value = await runProceduralCompliance({ db: supabase, caseId, userId });
            return {
              value,
              stats: {
                generated: value.evaluated,
                accepted: value.satisfied,
                rejected: value.evaluated - value.satisfied,
                rows_written: value.findings_written,
                db_write_confirmed: true,
                meta: {
                  source: "deterministic",
                  materia: value.materia,
                  score: value.score,
                  missing_required: value.missing_required,
                },
              },
            };
          },
        ),
    },
    // Control de Calidad Jurídica — terminal gate before the report. Throws
    // when a blocking violation survives remediation, which fails this stage
    // and blocks `report` (its dependent).
    legal_qa: {
      run: () =>
        persist.runCatalogedEngine(
          supabase,
          { caseId, userId, engine: ENGINE.legal_qa, executionId },
          async () => {
            const { runLegalQaGate } = await import("@/lib/intelligence/legal-qa.server");
            const value = await runLegalQaGate({ db: supabase, caseId, userId });
            return {
              value,
              stats: {
                generated: value.checked_fields,
                accepted: value.checked_fields - value.warnings.length,
                rejected: value.warnings.length,
                rows_written: value.remediated_fields,
                db_write_confirmed: true,
                meta: {
                  source: "deterministic",
                  materia: value.materia,
                  locale: value.locale,
                  remediated_fields: value.remediated_fields,
                  warnings: value.warnings.length,
                },
              },
            };
          },
        ),
    },

    report: { run: () => pipe.runReport(baseArgs), engine: ENGINE.report },
    timeline: { run: () => runTimelineAudit({ supabase, userId, caseId }) },
    evidence_map: {
      run: () =>
        persist.runCatalogedEngine(
          supabase,
          { caseId, userId, engine: ENGINE.evidence_map, executionId },
          async () => {
            const m = await import("@/lib/intelligence/evidence-map.server");
            const em = await m.buildEvidenceMap(supabase, caseId);
            return {
              value: em,
              stats: {
                generated: em.totals.total,
                accepted: em.totals.total - em.totals.missing_evidence,
              },
            };
          },
        ),
    },
    contradictions: {
      run: () =>
        persist.runCatalogedEngine(
          supabase,
          { caseId, userId, engine: ENGINE.contradictions, executionId },
          async () => {
            const d = await import("@/lib/intelligence/derived-engines.server");
            const result = await d.deriveContradictions(supabase, caseId);
            await updateCase(
              { contradiction_at: new Date().toISOString() },
              "pipeline.contradictions",
            );
            return result;
          },
        ),
    },
    // Task-9/10 stat plumbing: engines whose output is a mix of LLM + deterministic
    // templates now return real generated/accepted/rejected counts. Row counts come
    // from the target case_* tables (source of truth), audit numbers come from the
    // engine's own return value where available. Meta.source labels the pipeline
    // ("llm" | "template" | "hybrid") so the UI stops showing 0/0/0 for engines
    // that produced legitimate deterministic output.
    witness: {
      run: () =>
        runPenalModeGatedStage(
          "witness",
          ENGINE.witness,
          async () => {
            const d = await import("@/lib/intelligence/derived-engines.server");
            const result = await d.deriveWitnessIntel(supabase, caseId);
            const { count } = await supabase
              .from("case_witnesses")
              .select("id", { count: "exact", head: true })
              .eq("case_id", caseId);
            const rows = count ?? 0;
            const generated = Math.max(result.stats.generated ?? 0, rows);
            const accepted = Math.max(result.stats.accepted ?? 0, rows);
            return {
              value: result.value,
              stats: {
                generated,
                accepted,
                rejected: Math.max(0, generated - accepted),
                rows_written: rows,
                meta: { source: "derived", no_llm: true },
              },
            };
          },
        ),
    },
    evidence_intel: {
      run: () =>
        persist.runCatalogedEngine(
          supabase,
          { caseId, userId, engine: ENGINE.evidence_intel },
          async () => {
            const d = await import("@/lib/intelligence/derived-engines.server");
            const result = await d.deriveEvidenceIntel(supabase, caseId);
            const gen = result.stats.generated ?? 0;
            const acc = result.stats.accepted ?? gen;
            await updateCase(
              { evidence_intel_at: new Date().toISOString() },
              "pipeline.evidence_intel",
            );
            return {
              value: result.value,
              stats: {
                generated: gen,
                accepted: acc,
                rejected: Math.max(0, gen - acc),
                rows_written: gen,
                meta: { source: "derived", no_llm: true },
              },
            };
          },
        ),
    },
    constitutional: {
      // PRACTICE-AREA GATE: this stage previously ran unconditionally for
      // every case type, independently of the identically-named (and
      // already-gated) stage in pipeline.server.ts. Because this file's
      // worker-tick loop runs the "constitutional" stage AFTER the "agents"
      // stage (which correctly records constitutional_compliance as skipped
      // via runAgents()'s internal gate), this ungated copy would overwrite
      // that skipped row with a stub "completed" row — producing the
      // release-gate "silent_activation:constitutional_compliance" failure.
      // Mirrors the gate already used in runAgents() and
      // pipeline.server.ts's own constitutional stage.
      run: async () => {
        const { isAnalyzerAllowed, SKIP_REASON_NOT_APPLICABLE } =
          await import("./intelligence/practice-areas");
        const { getActiveDomains } = await import("./intelligence/cross-domain.server");
        const { recordSkipped } = await import("./intelligence/engine-audit.server");
        const { resolveCaseIdentity } = await import("./intelligence/case-classification.server");
        const { isUsableForLegalReasoning } = await import("./intelligence/case-identity");

        const identity = await resolveCaseIdentity(supabase, caseId);
        if (!isUsableForLegalReasoning(identity) && !identity.caseType) {
          const reason =
            identity.status === "conflict" ? "case_identity_conflict" : "case_identity_unverified";
          await recordSkipped(supabase, { caseId, userId, engine: ENGINE.constitutional as never, reason });
          return { skipped: true, reason };
        }
        const area = String(identity.caseType);
        const activeDomains = await getActiveDomains(supabase, caseId);

        if (!isAnalyzerAllowed(area, "constitutional_compliance", activeDomains)) {
          await recordSkipped(supabase, {
            caseId,
            userId,
            engine: ENGINE.constitutional as never,
            reason: SKIP_REASON_NOT_APPLICABLE,
          });
          return { skipped: true, reason: SKIP_REASON_NOT_APPLICABLE };
        }

        return persist.runCatalogedEngine(
          supabase,
          { caseId, userId, engine: ENGINE.constitutional },
          async () => ({
            value: { derived_from: "analyzers+agents" },
          }),
        );
      },
    },
    discovery: {
      run: () =>
        runPenalModeGatedStage(
          "discovery",
          ENGINE.discovery,
          async () => {
            const d = await import("@/lib/intelligence/derived-engines.server");
            const result = await d.deriveDiscoveryGaps(supabase, caseId);
            const n = result.stats.generated ?? 0;
            await updateCase({ discovery_at: new Date().toISOString() }, "pipeline.discovery");
            return {
              value: result.value,
              stats: {
                generated: n,
                accepted: n,
                rows_written: n,
                meta: { source: "derived", no_llm: true },
              },
            };
          },
        ),
    },
    perspectives: {
      run: () =>
        persist.runCatalogedEngine(
          supabase,
          { caseId, userId, engine: ENGINE.perspectives },
          async () => {
            const value = await lit.runPerspectivesEngine(baseArgs);
            const { count } = await supabase
              .from("case_perspectives")
              .select("id", { count: "exact", head: true })
              .eq("case_id", caseId);
            const n = count ?? 0;
            return {
              value,
              stats: { generated: n, accepted: n, rows_written: n, meta: { source: "engine" } },
            };
          },
        ),
    },
    theories: {
      run: () =>
        runPenalModeGatedStage("theories", ENGINE.theories, async () => {
          const value = (await eng.runTheoryEngine(baseArgs)) as {
            theories?: unknown[];
            audit?: { rejected?: number };
          };
          const { count } = await supabase
            .from("case_theories")
            .select("id", { count: "exact", head: true })
            .eq("case_id", caseId);
          const acc = count ?? value.theories?.length ?? 0;
          const gen = acc + (value.audit?.rejected ?? 0);
          return {
            value,
            stats: {
              generated: gen,
              accepted: acc,
              rejected: Math.max(0, gen - acc),
              rows_written: acc,
              meta: { source: "engine" },
            },
          };
        }),
    },
    opportunities: {
      run: () =>
        runPenalModeGatedStage(
          "opportunities",
          ENGINE.opportunities,
          async () => {
            const value = (await eng.runOpportunityEngine(baseArgs)) as {
              opportunities?: unknown[];
              potential_opportunities?: unknown[];
              audit?: { input?: number; rejected?: number; rejections?: unknown[] };
            };
            const { count } = await supabase
              .from("case_opportunities")
              .select("id", { count: "exact", head: true })
              .eq("case_id", caseId);
            const verified = value.opportunities?.length ?? 0;
            const potential = value.potential_opportunities?.length ?? 0;
            const rows = count ?? verified + potential;
            const gen = Math.max(value.audit?.input ?? 0, verified + potential, rows);
            const rejected = Math.max(value.audit?.rejected ?? potential, gen - verified);
            return {
              value,
              stats: {
                generated: gen,
                accepted: verified,
                rejected,
                rows_written: rows,
                meta: {
                  source: "engine",
                  verified_opportunities: verified,
                  potential_requires_review: potential,
                  gate_rejections: value.audit?.rejections ?? [],
                },
              },
            };
          },
        ),
    },
    strategy: {
      run: () =>
        runPenalModeGatedStage("strategy", ENGINE.strategy, async () => {
          const value = await lit.runStrategyEngine(baseArgs);
          const { count } = await supabase
            .from("case_strategy")
            .select("id", { count: "exact", head: true })
            .eq("case_id", caseId);
          const n = count ?? 0;
          return {
            value,
            stats: { generated: n, accepted: n, rows_written: n, meta: { source: "engine" } },
          };
        }),
    },
    litigation_strategy_center: {
      run: () =>
        runPenalModeGatedStage(
          "litigation_strategy_center",
          ENGINE.litigation_strategy_center,
          async () => {
            const value = await lit.runLitigationStrategyCenterEngine(baseArgs);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { count } = await (supabase as any)
              .from("case_strategy_center")
              .select("case_id", { count: "exact", head: true })
              .eq("case_id", caseId);
            const n = count ?? (value ? 1 : 0);
            return {
              value,
              stats: { generated: n, accepted: n, rows_written: n, meta: { source: "engine" } },
            };
          },
        ),
    },
    work_product: {
      run: () =>
        runPenalModeGatedStage(
          "work_product",
          ENGINE.work_product,
          async () => {
            const value = (await eng.runWorkProductEngine(baseArgs)) as {
              documents?: unknown[];
              failed?: number;
              verification?: {
                total?: number;
                clean?: number;
                flagged?: number;
                rejected?: number;
                empty?: number;
              };
            };
            const { count } = await supabase
              .from("case_work_product")
              .select("id", { count: "exact", head: true })
              .eq("case_id", caseId);
            const rows = count ?? 0;
            const gen = value.verification?.total ?? rows;
            const acc = value.verification?.clean ?? rows;
            const rej = (value.verification?.rejected ?? 0) + (value.verification?.empty ?? 0);
            return {
              value,
              stats: {
                generated: gen,
                accepted: acc,
                rejected: rej,
                rows_written: rows,
                meta: { source: "template", verification: value.verification ?? null },
              },
            };
          },
        ),
    },
    hallucination: {
      run: () =>
        persist.runCatalogedEngine(
          supabase,
          { caseId, userId, engine: ENGINE.hallucination },
          async () => ({
            value: await hal.runHallucinationReview({ db: supabase, caseId }),
          }),
        ),
    },
    multi_agent: {
      run: async () =>
        audit.runEngine(supabase, { caseId, userId, engine: ENGINE.multi_agent }, async () => {
          const { runMultiAgentPipeline } = await import("@/lib/agents/orchestrator.server");
          const result = await runMultiAgentPipeline({
            db: supabase,
            userId,
            caseId,
            apiKey,
            apiKeys: keys,
            // Preliminary pass only. The release decision is made after the
            // completed report exists, by runFinalReleaseReview().
            deferRelease: true,
          });
          const successful = result.results.filter((r) => r.status === "success").length;
          return {
            value: result,
            stats: {
              generated: result.results.length,
              accepted: successful,
              rejected: result.results.length - successful,
              rows_written: result.results.length,
              db_write_confirmed: true,
              meta: {
                run_id: result.runId,
                released: null,
                preliminary_released: result.released,
                release_deferred: true,
              },
              // BUG FIX: runMultiAgentPipeline() never throws when its own
              // internal QA/Judge/Hallucination release gate fails — it
              // returns a normal value with released:false. runEngine() only
              // distinguishes "threw" from "didn't throw", so without this,
              // the ledger recorded status:"completed" for a run whose own
              // result explicitly said "Release gate failed — QA/Judge/
              // Hallucination did not all pass." `stats.outcome:"negative"`
              // is the existing, already-supported mechanism (see
              // engine-audit.server.ts) for "ran fine, substantive result is
              // negative" — it persists status:"completed_negative" instead,
              // so the ledger stops contradicting the inner result. This does
              // NOT by itself block report generation (multi_agent is
              // requirement:"optional" by design, so a flaky agent review
              // must not permanently block the report) — see the explicit
              // pre-flight check added in pipeline.server.ts::_runReportInner
              // for the actual report-blocking behavior when release
              // explicitly failed.
              outcome: result.released ? undefined : ("negative" as const),
            },
          };
        }),
    },
  };

  // Dependency graph — derived from CANONICAL_STAGES so there is exactly
  // one place that defines stage dependencies platform-wide.
  const { CANONICAL_STAGES } = await import("@/lib/execution/canonical");
  const DEPENDS_ON = Object.fromEntries(
    CANONICAL_STAGES.map((s) => [s.key, [...s.dependsOn]]),
  ) as Record<PipelineStageKey, PipelineStageKey[]>;
  // "optional" stages (e.g. litigation_strategy_center, work_product,
  // trial_prep, theories, multi_agent) are documented in canonical.ts as
  // "decorative; never blocks" — the report gate (canGenerateReport) already
  // only checks blocking/enriching engines. But stageFailures below fed
  // hasFailures/finalStatus off EVERY blocked or failed stage regardless of
  // tier, so a harmless optional-stage block (e.g. one upstream engine that
  // itself failed) flipped the whole case to status "failed" even though
  // every blocking-tier stage — including the finished report — succeeded.
  // The case then sat at a non-running, non-"complete" terminal status with
  // nothing left to drive it, which only a refresh (re-deriving state from
  // the per-engine rows instead of the case row) made look finished. Gate
  // stageFailures on requirement tier so only a real blocking/enriching
  // failure can mark the pipeline as failed.
  const stageRequirement = (k: string): "blocking" | "enriching" | "optional" =>
    CANONICAL_STAGES.find((c) => c.key === k)?.requirement ?? "blocking";

  // Automatic case-context detection. Before anything else, resolve the
  // materia and the jurisdiction from the corpus when the attorney left them
  // blank, so stage selection below and every downstream prompt is already
  // jurisdiction-aware. Deterministic keyword classification — no AI spend.
  {
    const { autoDetectCaseContext } = await import("./mx-auto-detect.server");
    try {
      const detection = await autoDetectCaseContext(supabase, caseId, userId);
      trace("case.context_auto_detected", {
        case_type: detection.caseType,
        jurisdiction: detection.jurisdiction,
        persisted: detection.detected,
        source: detection.source,
      });
    } catch (e) {
      console.warn("[mx-auto-detect] failed", e);
    }
  }

  // DECISION RECONSTRUCTION — strict/completed cases only. This must run
  // AFTER extraction, but before analyzers/scoring. The old placement here
  // ran it before OCR and could persist an empty-corpus failure marker that
  // every later tick treated as final. Keep an initial call for resumes
  // (where extracted_at is already set), and call it again immediately after
  // a fresh extraction succeeds below.
  let decisionCoreEligible = false;
  {
    const { data: caseModeRow } = await (supabase as any)
      .from("cases")
      .select("analysis_mode,case_analysis_mode" as any)
      .eq("id", caseId)
      .maybeSingle();
    const evidenceMode = (caseModeRow as { analysis_mode?: string | null } | null)?.analysis_mode ?? null;
    const rawCaseAnalysisMode = (caseModeRow as { case_analysis_mode?: string | null } | null)
      ?.case_analysis_mode;
    const { normalizeCaseAnalysisMode, isCompletedCaseMode } = await import(
      "./intelligence/case-analysis-mode"
    );
    const caseAnalysisMode = normalizeCaseAnalysisMode(rawCaseAnalysisMode);
    decisionCoreEligible = evidenceMode === "strict" || isCompletedCaseMode(caseAnalysisMode);
  }

  const ensureAndPromoteDecisionCore = async (): Promise<void> => {
    if (!decisionCoreEligible) return;
    try {
      const { ensureDecisionReconstruction } = await import(
        "./intelligence/decision-reconstruction-extractor.server"
      );
      const reconstruction = await ensureDecisionReconstruction(supabase, caseId, userId);
      if (!reconstruction) {
        trace("case.decision_reconstruction_deferred", { reason: "extraction_not_ready_or_failed" });
        return;
      }
      const { buildMandatoryDecisionCore, mandatoryDecisionCoreToFindings } = await import(
        "./intelligence/mandatory-decision-core"
      );
      const { addGatedFindings } = await import("./intelligence/findings.server");
      const core = buildMandatoryDecisionCore(reconstruction);
      const promoted = await addGatedFindings(
        supabase,
        caseId,
        mandatoryDecisionCoreToFindings({ core, caseId, userId }),
      );
      trace("case.mandatory_decision_core_promoted", {
        required: core.length,
        inserted: promoted.inserted,
        suppressed: promoted.audit ? promoted.audit.input - promoted.audit.accepted : 0,
      });
    } catch (e) {
      console.warn("[decision-reconstruction] failed", e);
    }
  };

  await ensureAndPromoteDecisionCore();

  // Jurisdiction-aware sequence. Mexican practice doesn't run every engine for
  // every materia (e.g. no jury simulation in an ordinary penal case, no
  // witness intelligence in an amparo). Resolve the case's materia and drop the
  // stages that aren't legally relevant so they never occupy the ledger.
  let stages: (typeof PIPELINE_STAGES)[number][] = [...PIPELINE_STAGES];
  {
    const { isStageRelevantForCaseType, stageSkipReasonKey } =
      await import("./execution/mx-pipeline");
    const { recordSkipped } = await import("./intelligence/engine-audit.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: mxCaseRow } = await (supabase as any)
      .from("cases")
      .select("case_type,report_language,name")
      .eq("id", caseId)
      .maybeSingle();
    // VERIFIED CASE IDENTITY — an UNVERIFIED materia must not exclude any
    // stage (isStageRelevantForCaseType(null, ...) is the deliberately
    // permissive "exclude nothing" input — see exclusionsFor() in
    // mx-pipeline.ts). Excluding a stage on an unconfirmed guess risks
    // permanently starving a legitimately-relevant stage; including one
    // extra stage that turns out not to apply is comparatively harmless
    // (it already has its own downstream practice-area gates). Only a
    // verified or attorney-locked materia is trusted enough to narrow the
    // stage list.
    const { resolveCaseIdentity } = await import("./intelligence/case-classification.server");
    const { isUsableForLegalReasoning } = await import("./intelligence/case-identity");
    const mxIdentity = await resolveCaseIdentity(supabase, caseId);
    const mxCaseType = isUsableForLegalReasoning(mxIdentity) ? mxIdentity.caseType : null;
    // Case name is the only signal used to detect a segunda instancia
    // (apelación) proceeding — see effectiveMxProfile in mx-pipeline.ts.
    const mxCaseName = (mxCaseRow as { name?: string | null } | null)?.name ?? null;

    const mxLocale =
      (mxCaseRow as { report_language?: string | null } | null)?.report_language === "en"
        ? "en"
        : "es";
    const dict: Record<string, string> =
      mxLocale === "en"
        ? (enLocale as Record<string, string>)
        : (esLocale as Record<string, string>);

    const excluded = stages.filter(
      (s) =>
        !isStageRelevantForCaseType(
          mxCaseType,
          s.key,
          mxCaseName,
          mxIdentity.proceduralVehicle,
          mxIdentity.underlyingMateria,
        ),
    );
    for (const stage of excluded) {
      const reasonKey = stageSkipReasonKey(stage.key, mxCaseType, mxCaseName);
      const reason = dict[reasonKey] ?? reasonKey;
      // Best-effort — a failure here must never block the pipeline itself,
      // it only means the OMITIDO badge falls back to no explanation.
      await recordSkipped(supabase, {
        caseId,
        userId,
        engine: stage.key,
        reason,
        executionId,
      }).catch((e) => console.warn("[mx-pipeline] recordSkipped failed", stage.key, e));
    }

    stages = stages.filter((s) =>
      isStageRelevantForCaseType(
        mxCaseType,
        s.key,
        mxCaseName,
        mxIdentity.proceduralVehicle,
        mxIdentity.underlyingMateria,
      ),
    );
  }
  // Terminal ledger state for every engine, read once. Used to (a) clamp the
  // resume point, (b) seed cross-tick dependency state, and (c) skip
  // re-executing stages that already reached a terminal success/skipped state
  // on an earlier tick (no redundant re-evaluation, no re-billed AI calls).
  const latestStatusByEngine = new Map<string, string>();
  // "completed_negative" is a genuine terminal success (engine ran, reached a
  // legitimate no-result outcome — see EngineStats.outcome in
  // engine-audit.server.ts) and must count as done, exactly like
  // resumeFullPipelineStep's own `completed` set (cases.functions.ts)
  // already treats it. Omitting it here made this loop treat a real,
  // successful "negative" completion as "never attempted".
  const DONE_STATUSES = new Set([
    "success",
    "succeeded",
    "complete",
    "completed",
    "completed_negative",
    "skipped",
  ]);
  if (!reset) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let priorRunsQuery = (supabase as any)
      .from("pipeline_engine_runs")
      .select("engine,status,started_at,created_at,ended_at")
      .eq("case_id", caseId);
    if (executionId) {
      priorRunsQuery = priorRunsQuery.eq("execution_id", executionId);
    }
    const { data: priorRuns, error: priorErr } = await priorRunsQuery
      .order("started_at", { ascending: true });
    if (priorErr) {
      // Fail loudly rather than silently proceeding with an incomplete
      // picture of prior failures — a swallowed error here is exactly the
      // kind of gap that let work_product run past a failed perspectives.
      throw new Error(
        `failed to read pipeline_engine_runs history for resume: ${priorErr.message}`,
      );
    }
    for (const row of (priorRuns ?? []) as Array<{ engine: string; status: string }>) {
      latestStatusByEngine.set(row.engine, row.status); // ascending order → last write wins
    }

    // Staleness override. `report_generator`'s own ledger row can say
    // "completed" from an earlier run, but `reports` is a singleton row
    // that is never re-created per run — nothing invalidates it when a
    // true blocking-tier stage (extraction/analyzers/agents/scoring/
    // legal_qa/jurisdiction_intel) is re-run afterward. When that happens
    // the stored report silently predates the data it's supposed to
    // describe, and cases.functions.ts's getCase() detects exactly that
    // (isReportStale) and nulls out every substantive field before serving
    // it — but nothing was actually acting on that signal to regenerate
    // the report. Confirmed on a real case: the report came back with
    // full_report/executive_summary/facts/etc. all null and
    // stale_reason:"A required pipeline stage completed more recently than
    // this report was generated", while the case still read status
    // "complete" and the export fell back to a thin 10-page assembly of
    // raw findings. Treat "report" as NOT already done if it's stale, so
    // this tick gets a real chance to regenerate it instead of skipping it
    // as already-terminal.
    if (DONE_STATUSES.has(latestStatusByEngine.get(ENGINE.report) ?? "")) {
      try {
        const { data: reportRow } = await (supabase as any)
          .from("reports")
          .select("updated_at,created_at,citations")
          .eq("case_id", caseId)
          .maybeSingle();
        const blockingEngines = new Set(
          CANONICAL_STAGES.filter((s) => s.requirement === "blocking" && s.engine !== ENGINE.report).map(
            (s) => s.engine,
          ),
        );
        const { isReportStale, isReportStaleByDocumentHash } = await import("./cases.functions");
        const timestampStale = isReportStale(
          reportRow as { updated_at?: string | null; created_at?: string | null } | null,
          (priorRuns ?? []) as Array<{ engine: string; created_at?: string | null; ended_at?: string | null }>,
          blockingEngines,
        );
        // Second, independent signal (Phase 1 evidence-provenance): a cited
        // document's content itself changed, whether or not that change
        // happened to re-run the extraction engine (the only thing
        // timestampStale above can see). "If a document changes, invalidate
        // findings" — this is what actually enforces that for the report.
        let hashStale = false;
        if (!timestampStale) {
          const { data: docsForHashCheck } = await (supabase as any)
            .from("documents")
            .select("id,extracted_text")
            .eq("case_id", caseId);
          hashStale = isReportStaleByDocumentHash(
            reportRow as { citations?: unknown } | null,
            (docsForHashCheck ?? []) as Array<{ id: string; extracted_text: string | null }>,
          );
        }
        if (timestampStale || hashStale) {
          latestStatusByEngine.delete(ENGINE.report);
          trace("report.stale_forcing_regeneration", { reason: timestampStale ? "engine_timestamp" : "document_hash" });
        }
      } catch (e) {
        console.warn("[pipeline] report staleness check failed (non-fatal)", e);
      }
    }
  }
  // REVERTED (confirmed live, ADR-4321-2017-180507, ced2b054-108f-4a24-8872-
  // dec4503ab47a): alreadyDone()/alreadyAttempted() used to also OR in
  // isStageTimestampSet() (execution/canonical.ts) — trusting a case's own
  // cases.<engine>_at column whenever the ledger read found nothing. That
  // column is written independently of pipeline_engine_runs (each runXxx
  // sets it via a plain setCase() call, not inside the same transaction as
  // the ledger row), so a stage whose ledger row was deleted mid-flight by a
  // concurrent reset (e.g. updateCaseSettings's caseAnalysisModeChanged/
  // caseTypeChanged branch, which wipes pipeline_engine_runs + every
  // cases.*_at column with no guard against an in-flight run) can still have
  // its timestamp silently rewritten moments later by that stale run's own
  // completion write, with no ledger row behind it. Trusting that timestamp
  // then made this loop treat analyzers/agents/etc. as "already done" and
  // skip them outright — never calling their runner, never writing a fresh
  // ledger row — while report generation's own gate (ledger-only, correctly)
  // saw them as never having run and hard-failed with "core engines failed
  // to complete even after auto-backfill" for every one of them. This is
  // exactly the "next_stage=trial_prep while analyzers never completed"
  // bug class resumeFullPipelineStep (cases.functions.ts) already documents
  // and guards against — "must never be trusted to skip past a blocking-tier
  // stage that the ledger shows incomplete." pipeline_engine_runs remains the
  // sole source of truth here; a stage with no ledger row is never "done".
  const alreadyDone = (k: PipelineStageKey) =>
    DONE_STATUSES.has(latestStatusByEngine.get(engineForStage(k)) ?? "");
  // For resume clamping only: a stage that already ran and FAILED has been
  // attempted in this execution. Treating it as "incomplete" made the clamp
  // rewind the pipeline to that stage on every tick, so the run replayed the
  // same failure forever and never reached scoring/report. Clamping exists to
  // fill in stages that never ran at all, not to retry failures in a loop.
  const TERMINAL_STATUSES = new Set([...DONE_STATUSES, "failed", "error"]);
  const alreadyAttempted = (k: PipelineStageKey) =>
    TERMINAL_STATUSES.has(latestStatusByEngine.get(engineForStage(k)) ?? "");


  // Resume point. `startFrom` names the stage that checkpointed, but stages do
  // NOT always execute in index order: a parallel batch is driven by its
  // earliest member, so a later member (e.g. `perspectives`, index 10) can
  // checkpoint while stages at indices 6-9 (`evidence_intel`,
  // `jurisdiction_intel`, `procedural_compliance`, `discovery`) have not run
  // yet. Slicing blindly at `startFrom` silently dropped those stages for the
  // rest of the run, leaving `discovery_at`/`evidence_intel_at` null, which
  // suppressed scoring (PIPELINE_NOT_FINALIZED) and forced a LIMITED report.
  // Never resume past a stage that has no terminal ledger row.
  let effectiveStartFrom = startFrom ?? null;
  if (startFrom) {
    const idx = stages.findIndex((s) => s.key === startFrom);
    if (idx > 0) {
      const firstIncomplete = stages.findIndex((s) => !alreadyAttempted(s.key as PipelineStageKey));
      const sliceIdx = firstIncomplete >= 0 ? Math.min(idx, firstIncomplete) : idx;
      if (sliceIdx !== idx) {
        trace("pipeline.resume_clamped", {
          requested: startFrom,
          clamped_to: stages[sliceIdx].key,
          skipped_incomplete: stages
            .slice(sliceIdx, idx)
            .filter((s) => !alreadyAttempted(s.key as PipelineStageKey))
            .map((s) => s.key),

        });
      }
      effectiveStartFrom = stages[sliceIdx].key;
      if (sliceIdx > 0) stages = stages.slice(sliceIdx);
    }
  }

  const total = stages.length;
  const FATAL_STAGES = new Set<PipelineStageKey>(["extraction", "analyzers", "agents"]);
  const stageFailures: Array<{ key: string; error: string }> = [];
  const completed = new Set<PipelineStageKey>();
  const failed = new Set<PipelineStageKey>();
  const blocked = new Set<PipelineStageKey>();
  const {
    withHardCheckpointDeadline,
    budgetFor,
    WORKER_INVOCATION_BUDGET_MS,
    CHECKPOINT_SAFETY_BUFFER_MS,
  } = await import("./pipeline-checkpoint.server");
  const invocationDeadlineAt = runStart + WORKER_INVOCATION_BUDGET_MS;

  // Cross-tick dependency correctness. `failed`/`blocked` above only track
  // what THIS invocation observes. A case resumes across separate worker
  // ticks via `startFrom`, which slices `stages` to start partway through —
  // so any stage before that point (e.g. `perspectives` failing on tick 1)
  // is invisible to tick 3's freshly-empty Sets, and a downstream dependent
  // (e.g. `work_product`) could run unblocked even though its real upstream
  // dependency never completed. Reconstruct the missing history from the
  // persisted ledger for exactly the stages this tick will NOT re-attempt.
  const resumeIdx = effectiveStartFrom
    ? PIPELINE_STAGES.findIndex((s) => s.key === effectiveStartFrom)
    : 0;
  if (resumeIdx > 0) {
    const { seedResumeState } = await import("./pipeline-checkpoint.server");
    const seeded = seedResumeState({
      priorStageKeys: PIPELINE_STAGES.slice(0, resumeIdx).map((s) => s.key),
      engineForStage,
      latestStatusByEngine,
    });
    for (const k of seeded.failed) failed.add(k as PipelineStageKey);
    for (const k of seeded.blocked) blocked.add(k as PipelineStageKey);
    trace("pipeline.resume_state_seeded", {
      resume_from: effectiveStartFrom,
      seeded_failed: [...failed],
      seeded_blocked: [...blocked],
    });
  }



  trace("pipeline.start", {
    total_stages: stages.length,
    reset: !!reset,
    startFrom: startFrom ?? null,
  });

  // ---------------------------------------------------------------------
  // Parallel execution batches — addendum: safe concurrency for genuinely
  // independent stages. Traced from CANONICAL_STAGES' own dependsOn graph
  // (not reordered, not modified): every stage in a batch depends only on
  // stages that complete BEFORE the batch starts, and none of them depends
  // on another member of the same batch. Everything else (the
  // perspectives -> theories -> strategy -> {litigation_strategy_center,
  // work_product} chain) is a genuine sequential dependency chain and stays
  // serial — parallelizing it would run a stage before its real upstream
  // input exists.
  //   Batch A: perspectives, opportunities, witness — all three
  //     depend only on [analyzers, agents].
  //   Batch B: litigation_strategy_center, work_product — both depend only
  //     on strategy (+ stages already satisfied by the time strategy is
  //     done); neither depends on the other.
  const PARALLEL_BATCHES: readonly (readonly PipelineStageKey[])[] = [
    ["perspectives", "opportunities", "witness"],
    ["litigation_strategy_center", "work_product"],
  ];
  // The trigger for a batch must be whichever member actually occurs
  // EARLIEST in `stages` (materia-filtered order can differ from the array
  // above, and — critically — `witness` occurs earlier than `perspectives`
  // in CANONICAL_STAGES itself). Registering the wrong trigger would let an
  // earlier member run solo, then get re-executed when the batch fires
  // later at its declared-first member's position: this tick's
  // `latestStatusByEngine` snapshot is taken once at the very start of the
  // invocation and is never updated mid-tick, so `alreadyDone()` has no way
  // to see "this member already completed a few iterations ago" — it would
  // silently run (and re-bill) that engine twice in the same tick.
  const batchLeader = new Map<PipelineStageKey, readonly PipelineStageKey[]>();
  for (const batch of PARALLEL_BATCHES) {
    let earliest: PipelineStageKey | null = null;
    let earliestIdx = Infinity;
    for (const k of batch) {
      const idx = stages.findIndex((st) => st.key === k);
      if (idx >= 0 && idx < earliestIdx) {
        earliestIdx = idx;
        earliest = k;
      }
    }
    if (earliest) batchLeader.set(earliest, batch);
  }
  const handledByBatch = new Set<PipelineStageKey>();

  // runOneStage is the exact per-stage logic that used to live inline in
  // the loop below, unchanged line for line — only the control-flow
  // mechanism changed: every `continue` became `return { kind: "..." }`,
  // every early `return {...}` became `return { kind: "...", ... }`, and
  // the one `throw` (fatal-stage failure) became a returned outcome the
  // caller throws from, so this function is safe to call concurrently via
  // Promise.allSettled without an unhandled rejection. Called exactly once
  // per stage either way — sequentially for stages outside a batch,
  // concurrently for stages inside one.
  async function runOneStage(
    s: (typeof stages)[number],
    i: number,
    // Stage key the case should resume from if THIS stage checkpoints. For a
    // serial stage that is the stage itself; for a member of a parallel batch
    // it is the batch leader, because stages between the leader and this
    // member have not executed yet and must not be skipped on resume.
    resumeKey: string = s.key,
  ): Promise<
    | { kind: "skipped" | "blocked" | "success" | "failed" }
    | {
        kind: "checkpoint_before_start" | "checkpoint" | "cancelled" | "checkpoint_loop_aborted";
        index: number;
      }
    | { kind: "fatal_failed"; message: string }
  > {
    const key = s.key as PipelineStageKey;
    const r = runners[key];
    const pct = Math.floor((i / total) * 95);


    // Execution identity check: abort if superseded by newer execution
    const { data: curCaseRow } = await (supabase as any)
      .from("cases")
      .select("execution_id,cancel_requested")
      .eq("id", caseId)
      .maybeSingle();
    if (curCaseRow && curCaseRow.execution_id && curCaseRow.execution_id !== executionId) {
      trace("execution.superseded", { current: executionId, newer: curCaseRow.execution_id });
      runnerAbortController.abort();
      return { kind: "cancelled", index: i };
    }
    if (curCaseRow?.cancel_requested || runnerAbortController.signal.aborted) {
      await updateCase(
        { status: "cancelled", status_message: `Cancelled at ${s.label}` },
        `stage.cancelled:${s.key}`,
      );
      trace("pipeline.cancelled", { stage: s.key });
      return { kind: "cancelled", index: i };
    }

    // Idempotence gate — a stage that already reached a terminal
    // success/skipped state on an earlier tick is never re-executed.
    if (alreadyDone(key)) {
      completed.add(key);
      trace("stage.skipped_already_terminal", {
        stage: s.key,
        index: i + 1,
        prior_status: latestStatusByEngine.get(engineForStage(key)) ?? null,
      });
      return { kind: "skipped" };
    }

    // Dependency gate — record a `blocked` row so the ledger, UI, and report
    // gate all see the truth: this engine did not run because upstream failed.
    // Optional upstream stages are deliberately excluded: now that report
    // depends on multi_agent (which is optional), a flaky agent review must
    // not permanently block the report.
    const unmet = (DEPENDS_ON[key] ?? []).filter(
      (d) => (failed.has(d) || blocked.has(d)) && stageRequirement(d) !== "optional",
    );

    if (unmet.length > 0) {
      blocked.add(key);
      const reason = `Blocked: upstream stage(s) failed — ${unmet.join(", ")}`;
      if (stageRequirement(key) !== "optional") stageFailures.push({ key: s.key, error: reason });
      trace("stage.blocked", { stage: s.key, index: i + 1, unmet });
      try {
        await prog.emitEvent(supabase, caseId, s.key, reason, { level: "warn" });
      } catch {
        /* noop */
      }
      try {
        const engineFor = engineForStage;
        const audit = await import("@/lib/intelligence/engine-audit.server");
        await audit.recordBlocked(supabase, {
          caseId,
          userId,
          engine: engineFor(key),
          blockingEngines: unmet.map(engineFor),
          reason,
          executionId,
        });
      } catch (recErr) {
        console.warn(`[pipeline] failed to record blocked row for ${s.key}`, recErr);
      }
      await updateCase(
        {
          status: "intelligence_running",
          status_message: `${s.label} blocked (${i + 1}/${total})`,
          progress: pct,
          next_stage: s.key,
        },
        `stage.blocked:${s.key}`,
      );
      console.warn(`[pipeline] ${s.key} BLOCKED — ${reason}`);
      return { kind: "blocked" };
    }

    await updateCase(
      {
        status: "intelligence_running",
        status_message: `${s.label} (${i + 1}/${total})`,
        progress: pct,
        next_stage: s.key,
      },
      `stage.start:${s.key}`,
    );

    const remainingInvocationMs = invocationDeadlineAt - Date.now();
    if (remainingInvocationMs <= CHECKPOINT_SAFETY_BUFFER_MS) {
      try {
        const { requeueForContinuation } = await import("@/lib/pipeline-stall.server");
        await requeueForContinuation(supabase, caseId, resumeKey);
      } catch (rqErr) {
        console.warn(`[pipeline] re-queue before ${s.key} checkpoint failed`, rqErr);
      }
      trace("stage.checkpoint_before_start", {
        stage: s.key,
        index: i + 1,
        remaining_invocation_ms: remainingInvocationMs,
      });
      try {
        await prog.emitEvent(
          supabase,
          caseId,
          s.key,
          `${s.label} checkpointed before start — will resume on next worker tick`,
          { level: "warn" },
        );
      } catch {
        /* noop */
      }
      return { kind: "checkpoint_before_start", index: i };
    }

    trace("stage.start", { stage: s.key, index: i + 1, progress_pct: pct });
    try {
      await prog.emitEvent(supabase, caseId, s.key, `${s.label} started`);
    } catch {
      /* noop */
    }

    const stageStart = Date.now();
    try {
      const stageBudgetMs = Math.min(budgetFor(s.key), WORKER_INVOCATION_BUDGET_MS);
      await withStageTimeout(
        s.key,
        () =>
          withHardCheckpointDeadline(
            {
              stage: s.key,
              deadlineAt: Math.min(stageStart + stageBudgetMs, invocationDeadlineAt),
              correlationId,
            },
            () => r.run(),
          ),
        { caseId, userId, signal: runnerAbortController.signal },
      );
      completed.add(key);
      trace("stage.complete", { stage: s.key, runtime_ms: Date.now() - stageStart });
      try {
        await prog.emitEvent(supabase, caseId, s.key, `${s.label} complete`);
      } catch {
        /* noop */
      }
      if (s.key === "report") {
        // Report finished cleanly — reset the checkpoint backstop counter so a
        // later regenerate starts with a fresh budget.
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase as any).from("cases").update({ report_checkpoint_count: 0 }).eq("id", caseId);
        } catch {
          /* best-effort */
        }
        // Dashboard-only tally — the AI request allowance for the whole
        // pipeline run was already consumed once up front in
        // queueCaseForPipeline (see usage.server.ts).
        try {
          const { bumpReportsGenerated } = await import("@/lib/usage.server");
          bumpReportsGenerated(userId);
        } catch {
          /* best-effort */
        }
      }

      return { kind: "success" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "Cancelled by user" || (e instanceof Error && e.name === "CancelledError")) {
        await updateCase(
          { status: "cancelled", status_message: `Cancelled at ${s.label}` },
          `stage.cancelled:${s.key}`,
        );
        trace("pipeline.cancelled", { stage: s.key });
        return { kind: "cancelled", index: i };
      }
      if (e instanceof Error && e.name === "CheckpointRequired") {
        // Loop-breaker: if this stage has already checkpointed repeatedly it is
        // not making progress (typically: every AI provider key is out of
        // quota). Fail truthfully instead of re-queueing forever.
        const priorCheckpoints = await stageCheckpointCount(s.key);
        if (priorCheckpoints >= MAX_STAGE_CHECKPOINTS) {
          // e.progress carries real diagnostic text on several stages
          // (analyzers/agents/report embed the actual provider error, up to
          // ~300 chars, when they checkpoint on a Groq cooldown/rate-limit —
          // see pipeline.server.ts's CheckpointRequired throw sites) but
          // this handler previously discarded it entirely in favor of a
          // hardcoded "sin capacidad de IA / quota exhausted" guess — always
          // the same text regardless of what actually happened. That guess
          // can be wrong: a stage can also hit this loop-breaker on a
          // structural failure (bad request shape, an auth/decryption bug
          // on a specific key, a provider outage) that has nothing to do
          // with quota, and the user has no way to tell the difference from
          // this message alone. Surface the real cause when the thrown
          // CheckpointRequired actually carries one; keep the quota guess
          // only as a fallback for stages whose checkpoint (e.g.
          // extraction's plain "N/M docs") carries no error text at all.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lastProgress = typeof (e as any)?.progress === "string" ? ((e as any).progress as string) : null;
          const causeText = lastProgress
            ? `Última causa registrada: ${lastProgress}.`
            : `Causa probable: sin capacidad de IA disponible (todas las llaves configuradas agotaron su cuota).`;
          const detail =
            `${s.label}: la etapa no avanzó tras ${priorCheckpoints + 1} reintentos. ${causeText} ` +
            `Revise Admin → Llaves de IA y vuelva a ejecutar.`;
          trace("stage.checkpoint_loop_aborted", {
            stage: s.key,
            checkpoints: priorCheckpoints + 1,
            error: detail,
            last_checkpoint_progress: lastProgress,
          });
          try {
            await prog.emitEvent(supabase, caseId, s.key, detail, { level: "error" });
          } catch {
            /* noop */
          }
          await updateCase(
            {
              status: "failed",
              status_message: lastProgress
                ? `Detenido en ${s.label} — ${lastProgress.slice(0, 120)}`
                : `Sin capacidad de IA — detenido en ${s.label}`,
              error: detail.slice(0, 2000),
              next_stage: resumeKey,
              queued_at: null,
              worker_lease_until: null,
              stall_reason: "ai_capacity_exhausted",
            },
            `stage.checkpoint_loop:${s.key}`,
          );
          return { kind: "checkpoint_loop_aborted", index: i };
        }
        try {
          const { requeueForContinuation } = await import("@/lib/pipeline-stall.server");
          await requeueForContinuation(supabase, caseId, resumeKey);
        } catch (rqErr) {
          console.warn(`[pipeline] re-queue after checkpoint failed`, rqErr);
        }
        if (s.key === "report") {
          // Backstop counter (MAX_REPORT_CHECKPOINTS). runReport() reads this
          // to decide whether to stop retrying raw LLM calls and finalize with
          // whatever chunks are cached. This runner — not pipeline.server.ts's
          // stage loop — is the live execution path, so without this increment
          // the counter stayed at 0 forever and the salvage path never fired.
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: cur } = await (supabase as any)
              .from("cases")
              .select("report_checkpoint_count")
              .eq("id", caseId)
              .maybeSingle();
            const next = ((cur as { report_checkpoint_count?: number } | null)?.report_checkpoint_count ?? 0) + 1;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase as any).from("cases").update({ report_checkpoint_count: next }).eq("id", caseId);
            trace("report.checkpoint_count", { count: next });
          } catch (cntErr) {
            console.warn("[pipeline] failed to increment report_checkpoint_count", cntErr);
          }
        }

        trace("stage.checkpoint", { stage: s.key, runtime_ms: Date.now() - stageStart });
        try {
          await prog.emitEvent(
            supabase,
            caseId,
            s.key,
            `${s.label} checkpointed — will resume on next worker tick`,
            {
              level: "warn",
            },
          );
        } catch {
          /* noop */
        }
        return { kind: "checkpoint", index: i };
      }
      failed.add(key);
      trace("stage.failed", {
        stage: s.key,
        runtime_ms: Date.now() - stageStart,
        error: msg.slice(0, 500),
      });
      try {
        await prog.emitEvent(supabase, caseId, s.key, msg, { level: "error" });
      } catch {
        /* noop */
      }
      if (stageRequirement(key) !== "optional") stageFailures.push({ key: s.key, error: msg });
      if (FATAL_STAGES.has(key)) {
        await updateCase(
          {
            status: "failed",
            status_message: `Failed at ${s.label}`,
            error: msg.slice(0, 2000),
            next_stage: s.key,
          },
          `stage.failed:${s.key}`,
        );
        return { kind: "fatal_failed", message: `[${s.label}] ${msg}` };
      }
      console.warn(`[pipeline] non-fatal failure at ${s.key}: ${msg}`);
      return { kind: "failed" };
    }
  }

  // Interprets one stage's outcome exactly the way the loop used to inline
  // — same early-returns, same throw. Shared by the serial path and the
  // batch path below so neither can drift from the other's semantics.
  function earlyReturnFor(outcome: Awaited<ReturnType<typeof runOneStage>>): {
    ok: boolean;
    cancelled?: true;
    failedAt?: string;
    completedStages: number;
    warnings?: Array<{ key: string; error: string }>;
  } | null {
    switch (outcome.kind) {
      case "checkpoint_before_start":
        return {
          ok: true,
          completedStages: outcome.index,
          warnings: [{ key: stages[outcome.index].key, error: "checkpoint" }],
          failedAt: stages[outcome.index].key,
        };
      case "cancelled":
        return {
          ok: false,
          cancelled: true,
          failedAt: stages[outcome.index].key,
          completedStages: outcome.index,
        };
      case "checkpoint_loop_aborted":
        return { ok: false, failedAt: stages[outcome.index].key, completedStages: outcome.index };
      case "checkpoint":
        return {
          ok: true,
          completedStages: outcome.index,
          warnings: [{ key: stages[outcome.index].key, error: "checkpoint" }],
          failedAt: stages[outcome.index].key,
        };
      default:
        return null;
    }
  }

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const key = s.key as PipelineStageKey;

    // Already executed as part of an earlier parallel batch this tick.
    if (handledByBatch.has(key)) continue;

    const batch = batchLeader.get(key);
    if (batch) {
      // Resolve every batch member to its {stage, index} pair — order in
      // `stages` may differ slightly from PARALLEL_BATCHES' declared order
      // once jurisdiction-aware stage filtering has run, and a member may
      // not be present at all for this case type.
      const members = batch
        .map((k) => ({ k, idx: stages.findIndex((st) => st.key === k) }))
        .filter((m) => m.idx >= 0);
      for (const m of members) handledByBatch.add(m.k);

      trace("stage.batch_start", { batch: batch, members: members.map((m) => m.k) });
      const settled = await Promise.allSettled(
        members.map((m) => runOneStage(stages[m.idx], m.idx, s.key)),
      );
      // runOneStage never throws (every path returns a discriminated
      // outcome), so every settled result is "fulfilled" in practice —
      // treat an unexpected rejection as a non-fatal failure rather than
      // letting it crash the whole batch.
      const outcomes = settled.map((res) =>
        res.status === "fulfilled" ? res.value : { kind: "failed" as const },
      );
      trace("stage.batch_complete", {
        batch,
        outcomes: outcomes.map((o, idx) => ({ stage: members[idx].k, kind: o.kind })),
      });

      // Same priority order the serial path already implies: a cancel or a
      // checkpoint anywhere in the tick stops the whole invocation. Checked
      // across the batch once, using whichever member hit it.
      const cancelled = outcomes.find((o) => o.kind === "cancelled");
      if (cancelled) return earlyReturnFor(cancelled)!;
      const loopAborted = outcomes.find((o) => o.kind === "checkpoint_loop_aborted");
      if (loopAborted) return earlyReturnFor(loopAborted)!;
      const checkpointed = outcomes.find(
        (o) => o.kind === "checkpoint" || o.kind === "checkpoint_before_start",
      );
      if (checkpointed) return earlyReturnFor(checkpointed)!;
      const fatal = outcomes.find((o) => o.kind === "fatal_failed");
      if (fatal && fatal.kind === "fatal_failed") throw new Error(fatal.message);

      continue;
    }

    const outcome = await runOneStage(s, i);
    if (key === "extraction" && outcome.kind === "success") {
      await ensureAndPromoteDecisionCore();
    }
    if (outcome.kind === "fatal_failed") throw new Error(outcome.message);
    const early = earlyReturnFor(outcome);
    if (early) return early;
    // "skipped" | "blocked" | "success" | "failed" all just continue —
    // identical to the old inline continue/fallthrough behavior.
  }

  // Truthful final status. Multi-agent may have already stamped the case as
  // "released" or "needs_revision" — that is the authoritative post-pipeline
  // state and must NOT be overwritten by a blanket "complete". Only fall
  // back to complete/failed when multi-agent didn't stamp.
  const hasFailures = stageFailures.length > 0;

  // Optional-tier stages (perspectives, opportunities, strategy, theories,
  // litigation_strategy_center, work_product, hallucination, multi_agent)
  // deliberately never flip finalStatus to "failed" — a flaky optional
  // engine must not block the report. But that means a real failure in one
  // of them (e.g. an AI provider outage mid-run) previously vanished
  // entirely: the case still finalized as status="complete",
  // status_message="Full pipeline complete", with `error` left null, while
  // e.g. Perspectivas/Oportunidades/Estrategia silently held zero rows.
  // Confirmed on a real case (Juicio Ordinario Federal 96/2026 — ASIPONA
  // Manzanillo): perspectives + opportunities + strategy all failed with no
  // trace anywhere the attorney would see, yet the case read as fully done.
  // Surface it honestly instead — same finalStatus, but the message and
  // error field now say what actually came back empty.
  const optionalFailureKeys = new Set(
    [...new Set([...failed, ...blocked])].filter((k) => stageRequirement(k) === "optional"),
  );

  // Row-count reality check, independent of ledger status. `failed`/`blocked`
  // above only reflect what THIS worker tick observed — but a run can span
  // many ticks (each AI-provider checkpoint starts a fresh one with empty
  // Sets), and an optional engine can end a PRIOR tick with a "completed"
  // no-op ledger row that's never revisited. Confirmed on two real cases
  // (Juicio Ordinario Federal 96/2026 — ASIPONA Manzanillo; Amparo Indirecto
  // 342/2026-II): perspectives/opportunities/strategy/litigation_strategy_
  // center/work_product each ended up with zero rows in their own table
  // while the case still finalized as "Full pipeline complete" — in the
  // second case, litigation_strategy_center's own "nothing to synthesize
  // yet" no-op (litigation.server.ts) had apparently fired once, early,
  // then was never retried even after theories/opportunities gained real
  // data. A direct table count catches this regardless of which tick or
  // code path produced the gap. Zero rows isn't always wrong (a case can
  // legitimately have no opportunities), so this is reported as visibility
  // for the attorney to judge, not asserted as a bug.
  const OPTIONAL_OUTPUT_TABLES: Partial<Record<PipelineStageKey, string>> = {
    perspectives: "case_perspectives",
    theories: "case_theories",
    opportunities: "case_opportunities",
    strategy: "case_strategy",
    litigation_strategy_center: "case_strategy_center",
    work_product: "case_work_product",
    // FIX: confirmed on a real case (ADR-4321-2017-180507, balanced mode) —
    // the ledger showed a "Witness Intelligence" row as SKIPPED (0ms,
    // witnesses_at left null) while a DIFFERENT row sharing the same
    // display label (the nested witness_credibility agent inside Multi-
    // Agent Verification) showed COMPLETE, so the dashboard's "Witnesses
    // Profiled" card silently read 0 with no visibility anywhere that the
    // canonical witness-profiling stage never actually ran — every other
    // optional synthesis engine already gets this same row-count reality
    // check, witness just wasn't wired into it.
    witness: "case_witnesses",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: postRun } = await (supabase as any)
    .from("cases")
    .select("status,status_message,case_type,name")
    .eq("id", caseId)
    .maybeSingle();

  try {
    const { isStageRelevantForCaseType } = await import("./execution/mx-pipeline");
    // VERIFIED CASE IDENTITY — same "unverified materia excludes nothing"
    // reasoning as the stage-selection site above: a false "gap" flag from
    // an unconfirmed materia guess is worse than occasionally checking one
    // extra optional-output table that turns out not to apply.
    const { resolveCaseIdentity: resolveFinalCaseIdentity } = await import(
      "./intelligence/case-classification.server"
    );
    const { isUsableForLegalReasoning: isFinalIdentityUsable } = await import(
      "./intelligence/case-identity"
    );
    const finalIdentity = await resolveFinalCaseIdentity(supabase, caseId);
    const finalCaseType = isFinalIdentityUsable(finalIdentity) ? finalIdentity.caseType : null;
    const finalCaseName = (postRun as { name?: string | null } | null)?.name ?? null;
    for (const [key, table] of Object.entries(OPTIONAL_OUTPUT_TABLES) as [PipelineStageKey, string][]) {
      if (!isStageRelevantForCaseType(finalCaseType, key, finalCaseName)) continue; // excluded for this materia — not a gap
      if (optionalFailureKeys.has(key)) continue; // already flagged this tick
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (supabase as any)
        .from(table)
        .select("case_id", { count: "exact", head: true })
        .eq("case_id", caseId);
      if (!count) optionalFailureKeys.add(key);
    }

    // Contradictions has no dedicated per-case table to row-count the way
    // OPTIONAL_OUTPUT_TABLES's other entries do — deriveContradictions()
    // (derived-engines.server.ts) counts case_findings rows tagged
    // source_module LIKE 'analyzer:contradiction%' instead. Same visibility
    // gap as witness above: a real completed-case audit
    // (ADR-4321-2017-180507) showed contradiction_at set (the stage
    // completed) but contradictions_struct null and zero contradiction
    // findings, with nothing in case.error to tell the attorney whether
    // that's a genuine "no contradictions in this corpus" result or the
    // analyzer/grounding pipeline silently dropping them. Reported for
    // visibility, same as every other entry here — a case can legitimately
    // have zero contradictions.
    if (
      isStageRelevantForCaseType(finalCaseType, "contradictions", finalCaseName) &&
      !optionalFailureKeys.has("contradictions")
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count: contradictionCount } = await (supabase as any)
        .from("case_findings")
        .select("id", { count: "exact", head: true })
        .eq("case_id", caseId)
        .like("source_module", "analyzer:contradiction%");
      if (!contradictionCount) optionalFailureKeys.add("contradictions");
    }
  } catch (e) {
    console.warn("[pipeline] optional-engine output row check failed (non-fatal)", e);
  }

  const optionalFailures = [...optionalFailureKeys].map(
    (k) => PIPELINE_STAGES.find((s) => s.key === k)?.label ?? k,
  );

  // A manual multi-agent rerun historically could stamp a terminal status
  // A manual multi-agent rerun historically could stamp a terminal status
  // before Report Writer ran. Never preserve that status without the report
  // row that the authoritative final review is required to inspect.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: postReport } = await (supabase as any)
    .from("reports")
    .select("case_id")
    .eq("case_id", caseId)
    .maybeSingle();

  const isNeedsRevision =
    !!postReport &&
    (postRun?.status === "needs_revision" ||
      (postRun?.status_message && /needs_revision|review required|revisión|blocked by judge/i.test(postRun.status_message)));
  const isReleased = !!postReport && postRun?.status === "released";

  const finalStatus = isNeedsRevision
    ? "needs_revision"
    : isReleased
      ? "released"
      : hasFailures
        ? "failed"
        : "complete";

  const finalMessage = isNeedsRevision
    ? (postRun?.status_message ?? "Analysis complete — Judge review required (Draft / Needs Revision)")
    : isReleased
      ? (postRun?.status_message ?? "Pipeline complete and released.")
      : hasFailures
        ? `Pipeline finished with ${stageFailures.length} failed/blocked stage(s): ${stageFailures.map((f) => f.key).join(", ")}`
        : optionalFailures.length > 0
          ? `Full pipeline complete — ${optionalFailures.length} engine(s) produced no output: ${optionalFailures.join(", ")}`
          : "Full pipeline complete";

  await updateCase(
    {
      status: finalStatus,
      status_message: finalMessage,
      progress: 100,
      next_stage: null,
      error: hasFailures && !isNeedsRevision
        ? stageFailures
            .map((f) => `${f.key}: ${f.error}`)
            .join(" | ")
            .slice(0, 2000)
        : optionalFailures.length > 0
          ? `Engines that produced no output (optional — did not block the report): ${optionalFailures.join(", ")}. Check Live Debug for the underlying error.`
          : null,
    },
    "pipeline.finalize",
  );

  // Canonical projection — additive, never blocks legacy path. Projects every
  // engine table into the 17-section CaseAnalysis, validates, and upserts to
  // canonical_analysis. Validation failures are recorded on the row, not
  // thrown, so the legacy report path stays intact.
  try {
    const { runCanonicalGate } = await import("@/lib/canonical/gate.server");
    const reportMode = hasFailures ? "LIMITED" : "FULL";
    // canonical_analysis is written by the platform, not the end user: its RLS
    // only allows service-role writes. Using the user-scoped client here made
    // every finalize fail with "new row violates row-level security policy",
    // which left the Report/Findings tabs reading a stale or missing row.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const gate = await runCanonicalGate(supabaseAdmin as unknown as typeof supabase, caseId, reportMode);
    trace("pipeline.canonical", {
      ok: gate.ok,
      status: gate.status,
      issues: gate.validation.issues.length,
    });
  } catch (canonErr) {
    console.warn("[pipeline] canonical projection failed:", canonErr);
    trace("pipeline.canonical.failed", {
      error: canonErr instanceof Error ? canonErr.message : String(canonErr),
    });
  }

  // Talk to Case reads case intelligence through a short-lived, in-memory
  // context cache (chat.server.ts). Every derived table this run may have
  // written to — findings, analyses, agent findings, scores, theories,
  // opportunities, witnesses, trial prep — is exactly what that cache
  // captures a snapshot of. Reaching this point means the run finished (even
  // if some non-fatal stages failed and finalStatus is "failed" — those
  // stages still wrote whatever partial data they produced), so the cache
  // must be dropped and rebuilt now rather than left to expire on its own
  // TTL. This is what makes "report and chat can briefly disagree after a
  // rerun" impossible instead of merely bounded to ~60s.
  try {
    const { invalidateAndRebuildChatContext } = await import("./intelligence/chat.server");
    await invalidateAndRebuildChatContext(supabase, caseId, {
      runId: correlationId,
      source: "pipeline.finalize",
    });
  } catch (cacheErr) {
    console.warn("[pipeline] talk-to-case cache invalidation failed:", cacheErr);
    trace("pipeline.chat_cache.failed", {
      error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
    });
  }

  // Addendum §27 — cross-agent reasoning audit. Deliberately NOT one of the
  // dependency-gated stages above: it's a final, out-of-band consistency
  // pass over everything those stages produced, with zero AI calls and zero
  // effect on completedStages/warnings/finalStatus below. Wrapped so a
  // failure here can never turn a successful pipeline run into a failed one.
  try {
    const { runCrossAgentValidator } =
      await import("@/lib/intelligence/cross-agent-validator.server");
    await runCrossAgentValidator(supabase, { caseId: opts.caseId, userId });
  } catch {
    /* advisory only — never affects the pipeline's own result */
  }

  trace("pipeline.finalized", {
    total_runtime_ms: Date.now() - runStart,
    final_status: finalStatus,
    failures: stageFailures.length,
    completed: completed.size,
    blocked: blocked.size,
  });
  return { ok: true, completedStages: total, warnings: stageFailures };
  } finally {
    clearInterval(heartbeatTimer);
    isTerminated = true;
  }
}

