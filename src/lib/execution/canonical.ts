// =============================================================================
// CANONICAL EXECUTION ARCHITECTURE — Single source of truth.
//
// Every stage list, engine mapping, status derivation, progress calculation,
// and release gate in the platform lives in this file. NO other file may
// hardcode a stage list, engine name string, or derive execution status from
// case-row `*_at` timestamps.
//
// Read-side:   `pipeline_engine_runs` rows → deriveStageState → StageState
// Write-side:  `runEngine()` in engine-audit.server.ts is the only writer.
//
// UI hook:     `src/hooks/useCaseExecution.ts`
// Server API:  `src/lib/execution/service.server.ts`
// =============================================================================

export type ExecutionStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_negative"
  | "failed"
  | "skipped"
  | "blocked";

export type ExecutionRow = {
  id: string;
  engine: string;
  status: ExecutionStatus | (string & {});
  started_at: string | null;
  ended_at: string | null;
  created_at?: string | null;
  runtime_ms?: number | null;
  generated?: number | null;
  accepted?: number | null;
  rejected?: number | null;
  suppressed_ess?: number | null;
  suppressed_validator?: number | null;
  skipped_reason?: string | null;
  error?: string | null;
  execution_id?: string | null;
  meta?: Record<string, unknown> | null;
  // Phase 1 ledger fields — populated best-effort by callers.
  provider?: string | null;
  model?: string | null;
  prompt_version?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  retry_count?: number | null;
  cost_usd?: number | null;
  db_write_confirmed?: boolean | null;
  rows_written?: number | null;
  parent_engine?: string | null;
  blocking_engines?: string[] | null;
  dependency_status?: string | null;
};

export type StageState = "locked" | "waiting" | "running" | "complete" | "failed" | "skipped" | "blocked";

/**
 * Report requirement classification.
 *   blocking  — report cannot be assembled without this engine
 *   enriching — feeds sections; empty/failed is downgraded to partial coverage
 *   optional  — decorative; never blocks
 */
export type RequirementLevel = "blocking" | "enriching" | "optional";

export type StageDef = {
  /** UI/URL identifier. Stable across the platform. */
  readonly key: string;
  /** Human label shown in every panel. */
  readonly label: string;
  /** Engine name written to `pipeline_engine_runs.engine`. */
  readonly engine: string;
  /** Legacy `cases.*_at` timestamp column used ONLY for one-time backfill. */
  readonly timestampColumn?: string;
  /** Upstream stage keys this stage depends on. */
  readonly dependsOn: readonly string[];
  /** Report requirement level. */
  readonly requirement: RequirementLevel;
  /**
   * Hard wall-clock ceiling for this stage, in milliseconds. Enforced by
   * `withStageTimeout()` in `blocking-stage-guard.server.ts`. A stage that
   * exceeds it is aborted and recorded as FAILED — it never hangs the run.
   * Only set on stages that can block the report.
   */
  readonly timeoutMs?: number;
};

// -----------------------------------------------------------------------------
// THE canonical stage list. Order == execution order == UI display order.
// -----------------------------------------------------------------------------
export const CANONICAL_STAGES = [
  {
    key: "extraction",
    label: "Extracci�n",
    engine: "extraction",
    timestampColumn: "extracted_at",
    dependsOn: [],
    requirement: "blocking",
    // Per-document work has no internal network timeout (Supabase Storage
    // download, vision OCR call) and the in-loop checkpoint can only yield
    // BETWEEN documents — a hang on the very first document (processed
    // still 0) has nothing to interrupt it. Confirmed in production: a
    // 2.4KB plain-text file's extraction hung with zero progress until an
    // unrelated ~5min worker-lease stall sweep eventually killed the case
    // with a vague "worker timed out" message. This ceiling fails loudly
    // and fast instead, same mechanism as jurisdiction_intel/legal_qa.
    timeoutMs: 240_000,
  },
  {
    key: "analyzers",
    label: "Analizadores",
    engine: "analyzers",
    timestampColumn: "analysis_at",
    dependsOn: ["extraction"],
    requirement: "blocking",
    // Same loop-over-N-items-with-per-item-AI-call shape as extraction, same
    // "can only checkpoint between items" gap. See extraction's note above.
    timeoutMs: 240_000,
  },
  {
    key: "agents",
    label: "Agentes",
    engine: "agents",
    timestampColumn: "agents_at",
    dependsOn: ["extraction", "analyzers"],
    requirement: "blocking",
    timeoutMs: 240_000,
  },
  {
    key: "timeline",
    label: "Construir l�nea de tiempo",
    engine: "timeline",
    // runTimelineAudit() (cases.functions.ts) hard-requires the Analyzers
    // stage's `analyses.timeline` column AND Agents' `agents_at` timestamp
    // to already exist — it throws "Run Analyzers/Agents first" otherwise.
    // dependsOn previously only listed "extraction", so on a resume where
    // analyzers/agents had failed or were blocked upstream, the dependency
    // gate never recognized timeline as blocked-by-association: it ran
    // anyway, hit that internal guard, and surfaced as an unexplained stage
    // FAILURE instead of a clean "blocked" state — leaving Timeline Builder
    // permanently empty for that case with no honest reason shown.
    dependsOn: ["extraction", "analyzers", "agents"],
    requirement: "enriching",
    timeoutMs: 120_000,
  },
  {
    key: "evidence_map",
    label: "Mapeo de pruebas",
    engine: "evidence_map",
    dependsOn: ["extraction"],
    requirement: "enriching",
    timeoutMs: 120_000,
  },
  {
    key: "contradictions",
    label: "An�lisis de contradicciones",
    engine: "contradictions",
    timestampColumn: "contradiction_at",
    dependsOn: ["analyzers"],
    requirement: "enriching",
    timeoutMs: 120_000,
  },
  {
    key: "witness",
    label: "Inteligencia de testigos",
    engine: "witness_intelligence",
    timestampColumn: "witnesses_at",
    dependsOn: ["analyzers", "agents"],
    requirement: "enriching",
    timeoutMs: 240_000,
  },
  {
    key: "evidence_intel",
    label: "Inteligencia de pruebas",
    engine: "evidence_intelligence",
    timestampColumn: "evidence_intel_at",
    dependsOn: ["analyzers"],
    requirement: "enriching",
    timeoutMs: 180_000,
  },
  {
    // Resolves país / entidad federativa / fuero / materia and the codes that
    // actually govern the matter. Runs right after the analyzers so every
    // downstream engine reasons against the correct body of Mexican law.
    key: "jurisdiction_intel",
    label: "Inteligencia de jurisdicci�n",
    engine: "jurisdiction_intel",
    dependsOn: ["analyzers"],
    requirement: "blocking",
    // Deterministic + a small corpus read. Anything past 2 min is a hang.
    timeoutMs: 120_000,
  },

  {
    // Materia-specific procedural checklist (plazos, actos, formalidades).
    key: "procedural_compliance",
    label: "An�lisis de cumplimiento procesal",
    engine: "procedural_compliance",
    dependsOn: ["analyzers", "jurisdiction_intel"],
    requirement: "enriching",
    timeoutMs: 180_000,
  },
  {
    key: "constitutional",
    label: "An�lisis constitucional",
    engine: "constitutional_compliance",
    dependsOn: ["analyzers"],
    requirement: "enriching",
    timeoutMs: 120_000,
  },
  {
    key: "discovery",
    label: "Detecci�n de brechas probatorias",
    engine: "discovery_gaps",
    timestampColumn: "discovery_at",
    dependsOn: ["analyzers"],
    requirement: "enriching",
    timeoutMs: 240_000,
  },
  {
    // CONFIRMED IN PRODUCTION (Expediente Agrario 419/2026): this stage hung
    // with zero progress and had to be manually cleared via "Limpiar
    // estado" ~2.5 minutes in — same class of bug as extraction (see its
    // note above): the per-batch checkpoint in litigation.server.ts can
    // only yield BETWEEN batches, so a hang inside the very first batch's
    // concurrent Groq calls has nothing to interrupt it. Because this stage
    // is requirement:"optional" the hang doesn't fail the run, but it does
    // starve theories/strategy/litigation_strategy_center of real input,
    // which then thins out the evidence base enough to trip the
    // Hallucination/Judge release gate and block the report anyway.
    key: "perspectives",
    label: "An�lisis multiperspectiva",
    engine: "perspectives",
    timestampColumn: "perspectives_at",
    dependsOn: ["analyzers", "agents"],
    requirement: "optional",
    timeoutMs: 240_000,
  },
  {
    key: "theories",
    label: "Generaci�n de teor�as",
    engine: "theory",
    timestampColumn: "theories_at",
    dependsOn: ["perspectives"],
    requirement: "optional",
    timeoutMs: 240_000,
  },
  {
    key: "opportunities",
    label: "Oportunidades estrat�gicas del caso",
    engine: "opportunity",
    timestampColumn: "opportunities_at",
    dependsOn: ["analyzers", "agents"],
    requirement: "optional",
    timeoutMs: 240_000,
  },
  {
    // CONFIRMED IN PRODUCTION alongside perspectives above — same manual
    // clear, same single-shot-Groq-call-with-no-internal-checkpoint shape.
    key: "strategy",
    label: "S�ntesis de estrategia",
    engine: "strategy",
    timestampColumn: "strategy_at",
    dependsOn: ["perspectives", "theories"],
    requirement: "optional",
    timeoutMs: 240_000,
  },
  {
    key: "litigation_strategy_center",
    label: "Centro de estrategia de litigio",
    engine: "litigation_strategy_center",
    timestampColumn: "strategy_center_at",
    // Synthesis-only — reads the already-gated output of these stages and
    // doesn't touch the corpus itself. Runs after strategy so it can
    // summarize it too.
    dependsOn: ["theories", "opportunities", "witness", "strategy"],
    requirement: "optional",
    timeoutMs: 240_000,
  },
  {
    key: "work_product",
    label: "Producto de trabajo del abogado",
    engine: "work_product",
    timestampColumn: "work_product_at",
    dependsOn: ["strategy"],
    requirement: "optional",
    timeoutMs: 300_000,
  },
  {
    key: "hallucination",
    label: "Revisi�n de alucinaciones",
    engine: "hallucination",
    timestampColumn: "hallucination_at",
    dependsOn: ["analyzers", "agents"],
    requirement: "optional",
    timeoutMs: 180_000,
  },
  {
    key: "scoring",
    label: "Puntuaci�n del caso",
    engine: "scoring",
    timestampColumn: "scored_at",
    dependsOn: ["analyzers", "agents"],
    requirement: "blocking",
    timeoutMs: 180_000,
  },
  {
    // Control de Calidad Jurídica — terminal gate. Remediates US/common-law
    // terminology and invalid party roles in persisted engine output, then
    // audits it. A surviving blocking violation fails this stage, which blocks
    // `report`: a defective report is never silently published.
    key: "legal_qa",
    label: "Control de calidad legal",
    engine: "legal_qa",
    dependsOn: ["scoring", "analyzers", "agents"],
    requirement: "blocking",
    // Terminology remediation plus AI translation of English residue. Wide,
    // but bounded: past 8 min the gate is stuck, not slow.
    timeoutMs: 480_000,
  },

  {
    // 2026-07-31: multi-agent review moved AHEAD of report generation. It is
    // an information-gathering stage (13 agents producing findings the report
    // should cite), so running it after the report meant the report was
    // written without any of it. Report generation is now the last stage of
    // the pipeline, with nothing running behind it.
    key: "multi_agent",
    label: "Revisi�n multiagente (13 agentes)",
    engine: "multi_agent",
    dependsOn: ["scoring", "legal_qa", "analyzers", "agents"],
    requirement: "optional",
    // Extra headroom over the other optional stages — this one legitimately
    // runs 13 sub-agents in sequence/batches.
    timeoutMs: 360_000,
  },
  {
    key: "report",
    label: "Generar informe",
    engine: "report_generator",
    timestampColumn: "report_at",
    // FIX (2026-07-29): jurisdiction_intel is requirement:"blocking" (so
    // canGenerateReport() already correctly refuses to generate without
    // it) but wasn't reachable from this list, and nothing upstream of
    // scoring/legal_qa/analyzers/agents depends on it either. That meant
    // deriveStageState() could show this stage as "waiting" (ready to
    // run) purely from those four completing, while the real server-side
    // gate still correctly blocked report generation on jurisdiction_intel
    // — a misleading UI state, not a data-correctness bug (the actual
    // gate was always right), but confusing to anyone watching the
    // pipeline. Added so the UI and the real gate agree.
    dependsOn: ["scoring", "legal_qa", "analyzers", "agents", "jurisdiction_intel", "multi_agent"],
    requirement: "blocking",
    // FIX (2026-08-04): this was the one stage with NO timeoutMs — every
    // other stage got one in the 2026-08 timeout sweep, but report was left
    // unbounded on the theory that its own internal chunk checkpointing
    // (narrative/memo/intelligence, each cached to reports.report_chunk_cache
    // as it completes — see _runReportInner in pipeline.server.ts) already
    // handles resumption. That's true across ticks, but does nothing for a
    // SINGLE chunk's AI call hanging past its own provider-level timeout
    // (33s) and 8-provider failover chain without ever throwing — the exact
    // "reports sticking in generation" symptom reported live. 600s gives
    // generous headroom for legitimate multi-chunk work in one tick (this is
    // the stage that makes the most sequential AI calls of any in the
    // pipeline) while still being a real ceiling instead of none.
    timeoutMs: 600_000,
  },
] as const satisfies readonly StageDef[];

export type CanonicalStageKey = (typeof CANONICAL_STAGES)[number]["key"];

// Derived indexes — DO NOT rebuild these elsewhere.
export const STAGE_BY_KEY: ReadonlyMap<string, StageDef> = new Map(CANONICAL_STAGES.map((s) => [s.key, s]));
export const STAGE_BY_ENGINE: ReadonlyMap<string, StageDef> = new Map(CANONICAL_STAGES.map((s) => [s.engine, s]));
export const STAGE_KEYS: readonly string[] = CANONICAL_STAGES.map((s) => s.key);
export const ENGINE_ORDER: readonly string[] = CANONICAL_STAGES.map((s) => s.engine);
export const PIPELINE_STAGE_TO_ENGINE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(CANONICAL_STAGES.map((s) => [s.key, s.engine])),
);

// -----------------------------------------------------------------------------
// ENGINE IDENTITY — the ONLY sanctioned way to translate between a stage key
// and the engine id written to / read from `pipeline_engine_runs`.
//
// Rule: a stage is identified by its `key`; an execution-ledger row is
// identified by its `engine`. They are NOT interchangeable
// (witness → witness_intelligence, report → report_generator, …). No module
// may rebuild this mapping, hardcode an engine literal, or use a stage key
// where an engine id is expected. Regression-tested in
// `__tests__/engine-identity.test.ts`.
// -----------------------------------------------------------------------------

/** Canonical engine id alias table, keyed by stage key. `ENGINE.witness === "witness_intelligence"`. */
export const ENGINE = PIPELINE_STAGE_TO_ENGINE;

/** Every canonical engine id. Membership test for ledger writes/reads. */
export const CANONICAL_ENGINES: ReadonlySet<string> = new Set(ENGINE_ORDER);

/** True when `engine` is a canonical pipeline-stage engine id. */
export function isCanonicalEngine(engine: string): boolean {
  return CANONICAL_ENGINES.has(engine);
}

/** stage key → engine id. Unknown keys pass through unchanged (sub-engines). */
export function engineForStage(stageKey: string): string {
  return STAGE_BY_KEY.get(stageKey)?.engine ?? stageKey;
}

/** engine id → stage key. Unknown engines pass through unchanged. */
export function stageKeyForEngine(engine: string): string {
  return STAGE_BY_ENGINE.get(engine)?.key ?? engine;
}

/** Strict stage key → engine id. Throws on an unknown stage key. */
export function requireEngineForStage(stageKey: string): string {
  const stage = STAGE_BY_KEY.get(stageKey);
  if (!stage) throw new Error(`Unknown canonical stage key: ${stageKey}`);
  return stage.engine;
}


// NOTE: the report stage itself is deliberately excluded here. `report_generator`
// is the consumer of this gate, not a precondition for itself — including it
// would make the pre-flight check permanently unsatisfiable (it can only
// become "completed" after it has already run).
//
// 2026-07-31: per explicit direction, the report must not generate until
// EVERY stage has reached a terminal state — not just the stages marked
// Only stages explicitly classified as blocking can prevent report assembly.
// Enriching and optional stages still run and remain visible in diagnostics,
// but their failure degrades coverage rather than contradicting the runner's
// own non-blocking semantics.
export const REPORT_BLOCKING_ENGINES: readonly string[] = CANONICAL_STAGES.filter(
  (s) => s.requirement === "blocking" && s.engine !== "report_generator",
).map((s) => s.engine);

/** Engines whose stage is requirement:"optional".
 * Optional controls pipeline scheduling/failure propagation only. It does not
 * authorize an attorney-facing report to release after that engine failed.
 * completed_negative or an audited skipped state represent legitimate no-result
 * outcomes; failed/blocked require revision. */
export const OPTIONAL_ENGINES: ReadonlySet<string> = new Set(
  CANONICAL_STAGES.filter((s) => s.requirement === "optional").map((s) => s.engine),
);

export const REPORT_ENRICHING_ENGINES: readonly string[] = CANONICAL_STAGES.filter(
  (s) => s.requirement === "enriching",
).map((s) => s.engine);

/** All engines inspected by report readiness. Only REPORT_BLOCKING_ENGINES
 * can block; enriching engines are reported as coverage warnings. */
export const REPORT_REQUIRED_ENGINES: readonly string[] = Array.from(
  new Set([...REPORT_BLOCKING_ENGINES, ...REPORT_ENRICHING_ENGINES]),
);

/** Subset the Command Center dashboard summarizes. Same list — kept for API compat. */
export const COMMAND_CENTER_ENGINES: readonly string[] = REPORT_REQUIRED_ENGINES;

/** Engine id → the case's own dedicated completion-timestamp column
 *  (extracted_at, analysis_at, agents_at, scored_at, ...). Originally built
 *  for the one-time backfill migration. Engines with no dedicated column
 *  (sub-engines, stages whose completion isn't tracked this way) are
 *  simply absent from this map.
 *
 *  NOT used by pipeline-runner.server.ts's resume-clamp — see
 *  isStageTimestampSet's doc comment for why that was tried and reverted. */
export const ENGINE_TIMESTAMP_FALLBACK: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    (CANONICAL_STAGES as readonly StageDef[])
      .filter((s) => s.timestampColumn)
      .map((s) => [s.engine, s.timestampColumn as string]),

  ),
);

/** True when the case's own dedicated timestamp column for this engine is
 *  set. Pure function, correctly implemented and tested below — but do NOT
 *  wire this into any "has this stage already run" decision that can cause a
 *  stage to be SKIPPED (not re-executed). It was briefly used that way, OR'd
 *  into pipeline-runner.server.ts's alreadyDone()/alreadyAttempted(), to
 *  close a suspected read-consistency gap in the ledger check. REVERTED
 *  (confirmed live, ADR-4321-2017-180507): these columns are written by a
 *  plain setCase() call independent of the pipeline_engine_runs row for the
 *  same stage — NOT in the same transaction, NOT atomically together. A
 *  reset that fires while a stage is still mid-flight (e.g.
 *  updateCaseSettings's caseAnalysisModeChanged/caseTypeChanged branch,
 *  which deletes every pipeline_engine_runs row and nulls every cases.*_at
 *  column with no guard against an in-flight run — unlike
 *  queueCaseForPipeline's cooperative-cancellation reset path) can delete
 *  the stage's ledger row while that stale in-flight run is still executing;
 *  when it finishes moments later its own completion write silently
 *  restores the timestamp with no ledger row behind it. Trusting that
 *  timestamp then made the resume-clamp treat analyzers/agents/etc. as
 *  "already done" and skip them outright, while report generation's
 *  ledger-only gate correctly saw them as never run and hard-failed
 *  ("core engines failed to complete even after auto-backfill") for all of
 *  them. pipeline_engine_runs is the sole source of truth for whether a
 *  stage has run — see resumeFullPipelineStep's own doc comment
 *  (cases.functions.ts) for the same rule stated independently. */
export function isStageTimestampSet(caseRow: Record<string, unknown>, engine: string): boolean {
  const col = ENGINE_TIMESTAMP_FALLBACK[engine];
  return !!col && !!caseRow[col];
}

// -----------------------------------------------------------------------------
// Row selection — most-recent row per engine wins.
// -----------------------------------------------------------------------------
const STATUS_RANK: Record<ExecutionStatus, number> = {
  queued: 1,
  running: 2,
  blocked: 3,
  failed: 4,
  skipped: 5,
  completed_negative: 6,
  completed: 7,
};

export function latestRowsByEngine<T extends ExecutionRow>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const prev = map.get(row.engine);
    if (!prev) {
      map.set(row.engine, row);
      continue;
    }
    const prevTime = new Date(prev.created_at ?? prev.started_at ?? 0).getTime();
    const rowTime = new Date(row.created_at ?? row.started_at ?? 0).getTime();
    const prevRank = STATUS_RANK[prev.status as ExecutionStatus] ?? 0;
    const rowRank = STATUS_RANK[row.status as ExecutionStatus] ?? 0;
    if (rowTime > prevTime || (rowTime === prevTime && rowRank >= prevRank)) {
      map.set(row.engine, row);
    }
  }
  return map;
}

// -----------------------------------------------------------------------------
// Status derivation — the ONLY function that maps engine rows → StageState.
// -----------------------------------------------------------------------------
export function deriveStageState(
  stageKey: string,
  latest: ReadonlyMap<string, ExecutionRow>,
  upstreamStates?: ReadonlyMap<string, StageState>,
): StageState {
  const stage = STAGE_BY_KEY.get(stageKey);
  if (!stage) return "locked";
  const row = latest.get(stage.engine);
  if (row) {
    switch (row.status) {
      case "completed":
        return "complete";
      // Legitimate negative outcomes (Judge reject, QA no-findings, thin-evidence
      // hallucination gate) are complete for pipeline purposes — not failures.
      case "completed_negative":
        return "complete";
      case "running":
        return "running";
      case "failed":
        return "failed";
      case "skipped":
        return "skipped";
      case "blocked":
        return "blocked";
      case "queued":
        return "waiting";
    }
  }

  // No row yet. Propagate upstream failure/blocked as "blocked"; show
  // `waiting` if all upstreams are complete/skipped, otherwise `locked`.
  if (upstreamStates && stage.dependsOn.length > 0) {
    const upstreamStatuses = stage.dependsOn.map((dep) => upstreamStates.get(dep));
    if (upstreamStatuses.some((s) => s === "failed" || s === "blocked")) {
      return "blocked";
    }
    const allReady = upstreamStatuses.every((s) => s === "complete" || s === "skipped");
    return allReady ? "waiting" : "locked";
  }
  return stage.dependsOn.length === 0 ? "waiting" : "locked";
}

export type StageView = {
  key: string;
  label: string;
  engine: string;
  state: StageState;
  row: ExecutionRow | null;
  requirement: RequirementLevel;
  dependsOn: readonly string[];
};

/** Compute every stage's current view. Used by every UI panel. */
export function computeStageViews(rows: ExecutionRow[]): StageView[] {
  const latest = latestRowsByEngine(rows);
  const stateByKey = new Map<string, StageState>();
  const out: StageView[] = [];
  for (const stage of CANONICAL_STAGES) {
    const state = deriveStageState(stage.key, latest, stateByKey);
    stateByKey.set(stage.key, state);
    out.push({
      key: stage.key,
      label: stage.label,
      engine: stage.engine,
      state,
      row: latest.get(stage.engine) ?? null,
      requirement: stage.requirement,
      dependsOn: stage.dependsOn,
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Progress — the ONLY progress calculation.
// -----------------------------------------------------------------------------
export type ProgressSnapshot = {
  completedStages: number;
  totalStages: number;
  percent: number;
  isRunning: boolean;
  hasFailures: boolean;
  missingBlocking: string[];
};

export function computeProgress(rows: ExecutionRow[]): ProgressSnapshot {
  // Multi-agent now runs inside the pipeline (before the report), so it
  // counts toward progress like every other stage.
  const pipeline = computeStageViews(rows);
  const done = pipeline.filter((v) => v.state === "complete" || v.state === "skipped").length;
  const total = pipeline.length;
  const running = pipeline.some((v) => v.state === "running");
  const failed = pipeline.some((v) => v.state === "failed" || v.state === "blocked");
  const missingBlocking = pipeline
    .filter((v) => v.requirement === "blocking" && v.state !== "complete" && v.state !== "skipped")
    .map((v) => v.engine);
  return {
    completedStages: done,
    totalStages: total,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
    isRunning: running,
    hasFailures: failed,
    missingBlocking,
  };
}

export function completedPipelineStageCount(rows: ExecutionRow[]): number {
  return computeProgress(rows).completedStages;
}

export function pipelineProgressPercent(rows: ExecutionRow[]): number {
  return computeProgress(rows).percent;
}

// -----------------------------------------------------------------------------
// Report gate — the ONLY report-generation gate.
// -----------------------------------------------------------------------------
export type ReportBlocker = {
  engine: string;
  category: "blocking" | "enriching" | "optional";
  status: string;
  reason: string;
  execution_id?: string;
};

export type ReportGate = {
  ok: boolean;
  missingBlocking: string[];
  missingEnriching: string[];
  blockers: ReportBlocker[];
};

export type ReportReadiness = { state: "READY" } | { state: "WAITING"; reason: string } | { state: "BLOCKED"; blockers: ReportBlocker[] };
export function getReportReadiness(rows: ExecutionRow[]): ReportReadiness {
  const latest = latestRowsByEngine(rows);
  const isTerminal = (s?: string) => s === "completed" || s === "completed_negative" || s === "skipped";
  const isFailed = (s?: string) => s === "failed" || s === "blocked";

  const blocking = REPORT_BLOCKING_ENGINES.filter(e => !isTerminal(latest.get(e)?.status));
  const missingEnriching = [
    ...REPORT_ENRICHING_ENGINES.filter(e => !isTerminal(latest.get(e)?.status)),
    ...Array.from(OPTIONAL_ENGINES).filter(e => e !== "multi_agent").filter(e => {
      const row = latest.get(e);
      return row && !isTerminal(row.status);
    })
  ];

  const allMissing = [...blocking, ...missingEnriching];
  if (allMissing.length === 0) return { state: "READY" };

  const isAnyRunning = allMissing.some(e => {
    const s = latest.get(e)?.status;
    return s === "running" || s === "queued";
  });

  if (isAnyRunning) {
    const runningEngines = allMissing.filter(e => {
      const s = latest.get(e)?.status;
      return s === "running" || s === "queued";
    });
    return { state: "WAITING", reason: `Waiting for engines to finish: ${runningEngines.join(", ")}` };
  }

  const blockers: ReportBlocker[] = [];
  for (const e of allMissing) {
    const row = latest.get(e);
    let category: ReportBlocker["category"] = "optional";
    if (REPORT_BLOCKING_ENGINES.includes(e as any)) category = "blocking";
    else if (REPORT_ENRICHING_ENGINES.includes(e as any)) category = "enriching";

    blockers.push({
      engine: e,
      category,
      status: row?.status ?? "missing",
      reason: row ? "Engine execution is not in a successful terminal state" : "Engine execution row is completely absent",
      execution_id: row?.execution_id ?? undefined,
    });
  }

  return { state: "BLOCKED", blockers };
}

export function canGenerateReport(rows: ExecutionRow[]): ReportGate {
  const readiness = getReportReadiness(rows);
  if (readiness.state === "READY") {
    return { ok: true, missingBlocking: [], missingEnriching: [], blockers: [] };
  } else if (readiness.state === "WAITING") {
    return { ok: false, missingBlocking: [], missingEnriching: [], blockers: [{ engine: "pipeline", category: "optional", status: "running", reason: readiness.reason }] };
  } else {
    return { ok: false, missingBlocking: readiness.blockers.filter(b => b.category === "blocking").map(b => b.engine), missingEnriching: readiness.blockers.filter(b => b.category === "enriching").map(b => b.engine), blockers: readiness.blockers };
  }
}

/** Back-compat with legacy call sites. `required` defaults to full report set. */
export function missingRequiredEngines(
  rows: ExecutionRow[],
  required: readonly string[] = REPORT_REQUIRED_ENGINES,
): string[] {
  const latest = latestRowsByEngine(rows);
  return required.filter((e) => {
    const s = latest.get(e)?.status;
    return s !== "completed" && s !== "completed_negative" && s !== "skipped";
  });
}

/**
 * Hard wall-clock ceiling declared for a stage, in ms (undefined = unbounded).
 * Enforced by `withStageTimeout()` in `blocking-stage-guard.server.ts`.
 */
export function stageTimeoutMs(stageKey: string): number | undefined {
  return STAGE_BY_KEY.get(stageKey)?.timeoutMs;
}

/** Every stage that declares a timeout ceiling, keyed by stage key. */
export const STAGE_TIMEOUT_MS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(CANONICAL_STAGES.filter((s) => typeof s.timeoutMs === "number").map((s) => [s.key, s.timeoutMs!])),
);



