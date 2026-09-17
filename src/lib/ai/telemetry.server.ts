// Per-engine AI telemetry collector — Phases 6 + 6.5 (reliability freeze).
//
// The pipeline runs multiple router calls inside a single engine (e.g. the
// perspectives engine issues one call per perspective). We want the engine
// ledger row to summarize ALL of them without every engine having to
// hand-thread request-id / retry / token accounting through its business
// logic.
//
// Phase 6.5 extends the scope with:
//   * REPLAY HINTS: engine_version, prompt_version, prompt_sha256,
//     system_prompt_version, temperature, top_p, max_tokens, reasoning_level,
//     provider, model, routing_strategy, evidence_ids, document_ids,
//     case_snapshot_version, config_hash, corpus snapshot.
//   * BUILD FINGERPRINT: engine_version + git_commit + build_id captured once
//     per scope so a replay can verify same-build execution.
//   * JSON VALIDATION: response_valid_json, schema_validation_passed,
//     repair_attempts, repair_reason, repair_strategy — explicitly reported
//     by JSON-producing engines (never inferred).
//
// A replay record should answer WITHOUT consulting another table:
//   which engine? which build? which prompt? which prompt hash? which
//   provider/model/temperature? which evidence? which corpus? which
//   configuration? which validation state? which repair path?
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ProviderType } from "./providers/types";
import { estimateCost } from "./pricing";

// ------- Types -------

export type RoutingStrategy = "task_route" | "force_provider" | "runtime_key_chain" | "priority_chain";

export type ConfigFingerprint = {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning_level?: string;
  provider: ProviderType;
  model: string;
  routing_strategy?: RoutingStrategy;
  json_mode?: boolean;
};

export type TelemetryCall = {
  ts: number;
  provider: ProviderType;
  providerId: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  providerLatencyMs?: number;
  queueMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  retryCount?: number;
  retryReasons?: string[];
  providerRequestId?: string;
  cached?: boolean;
  error?: string;
  errorKind?: "quota" | "auth" | "payload_too_large" | "other" | "model_not_found";
  fellBackFrom?: ProviderType[];
  keyIndex?: number;
  keyLabel?: string;
  keyFingerprint?: string;
  keySelectionReason?: string;
  consideredProviders?: ProviderType[];
  consideredKeyIndexes?: number[];
  rotationStartIndex?: number;
  rotationAdvanced?: boolean;
  cooldownState?: string;
  promptVersion?: string;
  /** SHA256 of (system + user + model + temperature) captured per call. */
  promptSha256?: string;
  /** Exactly-executed generation config. */
  config?: ConfigFingerprint;
  responseValidJson?: boolean;
  schemaValidationPassed?: boolean;
  repairAttempts?: number;
  repairStrategy?: string;
  repairReason?: string;
};

export type JsonValidationRecord = {
  ts: number;
  response_valid_json: boolean;
  schema_validation_passed: boolean | null;
  repair_attempts: number;
  repair_strategy: string | null;
  repair_reason: string | null;
  bytes: number;
};

export type BuildFingerprint = {
  engine_version?: string;
  git_commit?: string;
  build_id?: string;
  node_env?: string;
};

export type CorpusSnapshot = {
  case_id: string;
  case_snapshot_version?: string;
  document_count: number;
  evidence_count: number;
  corpus_hash: string;
  captured_at: string;
};

export type ReplayHints = {
  engine?: string;
  engine_version?: string;
  prompt_version?: string;
  prompt_sha256?: string;
  system_prompt_version?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning_level?: string;
  provider?: ProviderType;
  model?: string;
  routing_strategy?: RoutingStrategy;
  evidence_ids?: string[];
  document_ids?: string[];
  case_snapshot_version?: string;
  corpus_hash?: string;
  config_hash?: string;
  [k: string]: unknown;
};

export type TelemetryScope = {
  runId: string;
  traceId: string;
  calls: TelemetryCall[];
  jsonValidations: JsonValidationRecord[];
  build: BuildFingerprint;
  corpus?: CorpusSnapshot;
  replay: ReplayHints;
};

const _als = new AsyncLocalStorage<TelemetryScope>();

// ------- Fingerprint helpers -------

/** SHA256 of an ordered set of inputs. Deterministic across processes. */
export function sha256Hex(parts: Array<string | number | boolean | null | undefined>): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(p == null ? "\0null\0" : String(p));
    h.update("\0");
  }
  return h.digest("hex");
}

/** Stable hash of the prompt actually sent (system + user + model + temp + json flag). */
export function computePromptSha256(input: {
  systemInstruction?: string;
  userContent: unknown;
  model?: string;
  temperature?: number;
  json?: boolean;
}): string {
  const user = typeof input.userContent === "string" ? input.userContent : JSON.stringify(input.userContent);
  return sha256Hex([input.systemInstruction ?? "", user, input.model ?? "", input.temperature ?? "", input.json ? "json" : "text"]);
}

/** Stable hash of a generation config so config drift is trivially detectable. */
export function computeConfigHash(cfg: Partial<ConfigFingerprint>): string {
  return sha256Hex([
    cfg.provider ?? "",
    cfg.model ?? "",
    cfg.temperature ?? "",
    cfg.top_p ?? "",
    cfg.max_tokens ?? "",
    cfg.reasoning_level ?? "",
    cfg.json_mode ? "json" : "text",
    cfg.routing_strategy ?? "",
  ]);
}

/** Capture engine/build fingerprint from env once per scope. */
export function captureBuildFingerprint(overrides?: Partial<BuildFingerprint>): BuildFingerprint {
  return {
    engine_version: overrides?.engine_version ?? process.env.ENGINE_VERSION,
    git_commit: overrides?.git_commit ?? process.env.GIT_COMMIT ?? process.env.VITE_GIT_COMMIT,
    build_id: overrides?.build_id ?? process.env.BUILD_ID ?? process.env.VITE_BUILD_ID,
    node_env: overrides?.node_env ?? process.env.NODE_ENV,
  };
}

// ------- Scope management -------

/** Get the current engine's telemetry scope, if any. Router uses this. */
export function currentTelemetryScope(): TelemetryScope | undefined {
  return _als.getStore();
}

/**
 * Run a function inside a fresh telemetry scope. Every routeAI call that
 * lands inside `fn` (or anything it awaits) has its metadata recorded
 * against the returned scope.
 */
export async function withTelemetryScope<T>(
  init: {
    runId: string;
    traceId?: string;
    replay?: ReplayHints;
    build?: Partial<BuildFingerprint>;
  },
  fn: (scope: TelemetryScope) => Promise<T>,
): Promise<{ value: T; scope: TelemetryScope }> {
  const scope: TelemetryScope = {
    runId: init.runId,
    traceId: init.traceId ?? init.runId,
    calls: [],
    jsonValidations: [],
    build: captureBuildFingerprint(init.build),
    replay: { ...(init.replay ?? {}) },
  };
  const value = await _als.run(scope, () => fn(scope));
  return { value, scope };
}

/** Push a call record into the current scope, if any. Safe no-op outside a scope. */
export function pushTelemetryCall(call: TelemetryCall): void {
  const s = _als.getStore();
  if (!s) return;
  s.calls.push(call);
}

/**
 * Register replay hints on the current engine's scope. Engines SHOULD call
 * this at the top of their handler with every parameter that can influence
 * output — including prompt_version, temperature, evidence_ids and
 * document_ids. Fields not registered are treated as unknown at replay time.
 */
export function addReplayHints(hints: ReplayHints): void {
  const s = _als.getStore();
  if (!s) return;
  Object.assign(s.replay, hints);
  // Auto-fill config_hash whenever we have enough to compute it.
  if (!s.replay.config_hash && (s.replay.provider || s.replay.model || s.replay.temperature != null)) {
    s.replay.config_hash = computeConfigHash({
      provider: s.replay.provider,
      model: s.replay.model,
      temperature: s.replay.temperature,
      top_p: s.replay.top_p,
      max_tokens: s.replay.max_tokens,
      reasoning_level: s.replay.reasoning_level,
      routing_strategy: s.replay.routing_strategy,
    });
  }
}

/** Record the corpus snapshot for this engine's case. */
export function recordCorpusSnapshot(snapshot: CorpusSnapshot): void {
  const s = _als.getStore();
  if (!s) return;
  s.corpus = snapshot;
  s.replay.corpus_hash = snapshot.corpus_hash;
  if (snapshot.case_snapshot_version) s.replay.case_snapshot_version = snapshot.case_snapshot_version;
}

/**
 * Record a JSON validation attempt. Engines that parse model JSON MUST call
 * this so the ledger reflects actual validation state — never inferred.
 */
export function recordJsonValidation(rec: {
  responseValidJson: boolean;
  schemaValidationPassed?: boolean | null;
  repairAttempts?: number;
  repairStrategy?: string | null;
  repairReason?: string | null;
  bytes?: number;
}): void {
  const s = _als.getStore();
  if (!s) return;
  s.jsonValidations.push({
    ts: Date.now(),
    response_valid_json: rec.responseValidJson,
    schema_validation_passed: rec.schemaValidationPassed ?? null,
    repair_attempts: rec.repairAttempts ?? 0,
    repair_strategy: rec.repairStrategy ?? null,
    repair_reason: rec.repairReason ?? null,
    bytes: rec.bytes ?? 0,
  });
}

// ------- Aggregation -------

export type TelemetrySummary = {
  provider?: ProviderType;
  model?: string;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  retryCount: number;
  retryReasons: string[];
  providerLatencyMs: number;
  totalLatencyMs: number;
  costUsd: number;
  cached: number;
  providerRequestIds: string[];
  fellBackFrom: ProviderType[];
  errors: Array<{ provider: ProviderType; kind?: string; message: string }>;
  responseValidJson: boolean | null;
  schemaValidationPassed: boolean | null;
  repairAttempts: number;
  repairStrategies: string[];
  repairReasons: string[];
  promptVersion?: string;
  promptSha256?: string;
  configHash?: string;
  /** Raw call log, capped for storage. */
  calls: TelemetryCall[];
  jsonValidations: JsonValidationRecord[];
};

/** Aggregate an AsyncLocalStorage scope into a durable stats summary. */
export function summarizeScope(scope: TelemetryScope): TelemetrySummary {
  const s: TelemetrySummary = {
    totalCalls: scope.calls.length,
    successCalls: 0,
    failedCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    retryCount: 0,
    retryReasons: [],
    providerLatencyMs: 0,
    totalLatencyMs: 0,
    costUsd: 0,
    cached: 0,
    providerRequestIds: [],
    fellBackFrom: [],
    errors: [],
    responseValidJson: null,
    schemaValidationPassed: null,
    repairAttempts: 0,
    repairStrategies: [],
    repairReasons: [],
    calls: scope.calls.slice(-50),
    jsonValidations: scope.jsonValidations.slice(-50),
  };
  let lastOk: TelemetryCall | undefined;
  const fellBack = new Set<ProviderType>();
  const reqIds = new Set<string>();
  const reasons = new Set<string>();

  for (const c of scope.calls) {
    if (c.ok) {
      s.successCalls++;
      lastOk = c;
      s.tokensIn += c.inputTokens ?? 0;
      s.tokensOut += c.outputTokens ?? 0;
      s.tokensTotal += c.totalTokens ?? (c.inputTokens ?? 0) + (c.outputTokens ?? 0);
      s.providerLatencyMs += c.providerLatencyMs ?? c.latencyMs;
      s.totalLatencyMs += c.latencyMs;
      s.costUsd += estimateCost(c.provider, c.inputTokens ?? 0, c.outputTokens ?? 0);
      if (c.cached) s.cached++;
      if (c.providerRequestId) reqIds.add(c.providerRequestId);
    } else {
      s.failedCalls++;
      s.errors.push({
        provider: c.provider,
        kind: c.errorKind,
        message: (c.error ?? "").slice(0, 300),
      });
    }
    s.retryCount += c.retryCount ?? 0;
    for (const r of c.retryReasons ?? []) reasons.add(r);
    for (const p of c.fellBackFrom ?? []) fellBack.add(p);
  }

  // JSON validation: aggregated from explicit records (never inferred).
  // response_valid_json = true iff every recorded attempt was valid.
  const jvs = scope.jsonValidations;
  if (jvs.length > 0) {
    s.responseValidJson = jvs.every((v) => v.response_valid_json);
    const schemaChecked = jvs.filter((v) => v.schema_validation_passed !== null);
    s.schemaValidationPassed = schemaChecked.length === 0
      ? null
      : schemaChecked.every((v) => v.schema_validation_passed === true);
    for (const v of jvs) {
      s.repairAttempts += v.repair_attempts;
      if (v.repair_strategy) s.repairStrategies.push(v.repair_strategy);
      if (v.repair_reason) s.repairReasons.push(v.repair_reason);
    }
    s.repairStrategies = Array.from(new Set(s.repairStrategies)).slice(0, 10);
    s.repairReasons = Array.from(new Set(s.repairReasons)).slice(0, 10);
  }

  if (lastOk) {
    s.provider = lastOk.provider;
    s.model = lastOk.model;
    s.promptVersion = lastOk.promptVersion ?? (scope.replay.prompt_version as string | undefined);
    s.promptSha256 = lastOk.promptSha256;
    if (lastOk.config) s.configHash = computeConfigHash(lastOk.config);
  }
  if (!s.promptSha256 && scope.replay.prompt_sha256) s.promptSha256 = scope.replay.prompt_sha256 as string;
  if (!s.configHash && scope.replay.config_hash) s.configHash = scope.replay.config_hash as string;

  s.providerRequestIds = Array.from(reqIds).slice(0, 25);
  s.fellBackFrom = Array.from(fellBack);
  s.retryReasons = Array.from(reasons).slice(0, 10);
  return s;
}
