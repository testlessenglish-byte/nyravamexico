// DB-driven AI router. Server-only.
//
// Reads ai_providers ordered by priority, walks the chain trying each enabled
// provider in turn. On 429/timeout/5xx/network failure, falls through to the
// next provider. On success, stamps last_ok_at; on failure, stamps last_error_at.
// Task routing pins specific tasks to specific providers (looked up first).

import { createHash } from "node:crypto";
import type { AIProvider, AITask, ChatOpts, ChatResult, ProviderType } from "./providers/types";
import { buildProvider, ProviderRow } from "./providers/factory";
import {
  aiCallTimeoutForCheckpoint,
  assertCheckpointBudget,
  isCheckpointError,
} from "../pipeline-checkpoint.server";
import { traceAsync } from "@/lib/pipeline-trace.server";
import {
  clearProviderCooldowns,
  getProviderCooldown,
  listProviderCooldowns,
  markProviderCooldown,
  parseRetryHintMs,
  type CooldownReason,
} from "./cooldown.server";

export interface RouteOpts extends ChatOpts {
  task?: AITask;
  forceProvider?: ProviderType;
  skipProviders?: ProviderType[];
  cache?: boolean;
  /** Runtime key override (single). */
  apiKey?: string;
  /** Ordered runtime key overrides. First key is tried first. */
  apiKeys?: string[];
  /** When set with apiKey/apiKeys, treats those keys as belonging to this provider. */
  runtimeProvider?: ProviderType;
  /** When set, loads the user's active provider keys from user_ai_keys and prepends them to the chain. */
  userId?: string;
  /** Internal: how many times this call already waited out a provider cooldown. */
  _cooldownWaits?: number;
  /**
   * Internal: the smallest provider input-token budget already tried via
   * compression this call chain (Infinity = none tried yet). Each cascade
   * pass compresses to the largest size-skipped budget still BELOW this
   * floor, so a provider with a much smaller budget (e.g. Groq, ~5.5k
   * tokens) still gets tried after a mid-size one (e.g. OpenRouter, ~60k)
   * fails, instead of the run dying after only the single largest
   * size-skipped budget was attempted. Strictly decreasing each recursive
   * call, so this always terminates.
   */
  _compressionFloor?: number;
  /**
   * Internal: last-resort pass that ignores in-memory cooldowns entirely.
   * Used when EVERY key was skipped as cooling down and waiting is not an
   * option — a real 429 costs milliseconds, a stalled stage costs the run.
   */
  _ignoreCooldowns?: boolean;
  /** Internal: provider order selected for this logical call. Preserved by
   * recursive cooldown/compression retries so round-robin advances once. */
  _providerOrder?: ProviderType[];
}

export interface RouteResult extends ChatResult {
  provider: ProviderType;
  providerId: string;
  fellBackFrom?: ProviderType[];
  cached?: boolean;
  keyIndex?: number;
  /** Number of provider-side retries that ran before the response was returned. */
  retryCount?: number;
  /** Reasons for retries in try order (e.g. "HTTP 429", "timeout"). */
  retryReasons?: string[];
}

type RuntimeGroqRow = ProviderRow & {
  runtimeApiKey?: string;
  runtimeKeyIndex?: number;
  runtimeKeyFingerprint?: string;
  rotationStartIndex?: number;
  rotationAdvanced?: boolean;
  selectionReason?: string;
  consideredKeyIndexes?: number[];
};

interface CallRecord {
  ts: number;
  provider: ProviderType;
  providerId: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  failover?: boolean;
  cached?: boolean;
}

const _state = {
  last: undefined as CallRecord | undefined,
  lastSuccess: undefined as CallRecord | undefined,
  lastError: undefined as CallRecord | undefined,
  history: [] as CallRecord[],
  failovers: 0,
  cacheHits: 0,
  totalCalls: 0,
  byProvider: {} as Record<
    string,
    { lastOk?: number; lastError?: string; lastErrorTs?: number; totalOk: number; totalErr: number }
  >,
};

// 2026-07-27: was 4. With 4 Gemini + 3 Groq keys saved, the 4th real call
// exhausted the budget and every remaining key of an already-tried provider
// was skipped with [attempt_budget] — so keys 5-7 were never rotated into.
// The budget exists to stop hammering, not to strand healthy keys: size it
// so every distinct key in the chain gets exactly one real attempt.
const MAX_LOGICAL_PROVIDER_ATTEMPTS = 8;
// 2026-07-27: was 1. Gemini's free tier answers a transient 503 ("model
// experiencing high demand") on the first try often enough that a single
// attempt per key wastes the whole chain on infra noise, not quota.
const MAX_PROVIDER_RETRIES_PER_CALL = 2;

/**
 * Per-request INPUT token budget by provider. This is not the model context
 * window — it is the largest single request the provider will actually accept
 * on the plans these keys use. Groq's free tier rejects any request larger
 * than its 8k tokens-per-minute ceiling with HTTP 413, so we keep headroom for
 * the completion and route bigger prompts to a wide-context provider instead.
 */
const PROVIDER_INPUT_TOKEN_BUDGET: Partial<Record<ProviderType, number>> = {
  // 2026-07-30: production traces from Proyecto Faro showed Groq free-tier
  // rejecting 12k-13.5k-token agent prompts with HTTP 413 because the org TPM
  // ceiling is 8k. This budget is intentionally below that ceiling so corpus
  // packing produces request-sized chunks that can actually run on Groq instead
  // of bouncing between oversized Groq attempts and exhausted Gemini keys.
  groq: 5_500,

  openrouter: 60_000,
  gemini: 900_000,
  openai: 100_000,
  anthropic: 150_000,
};
const DEFAULT_PROVIDER_INPUT_BUDGET = 60_000;

export function getProviderInputBudget(p: ProviderType): number {
  return PROVIDER_INPUT_TOKEN_BUDGET[p] ?? DEFAULT_PROVIDER_INPUT_BUDGET;
}

function providerInputBudget(p: ProviderType): number {
  return PROVIDER_INPUT_TOKEN_BUDGET[p] ?? DEFAULT_PROVIDER_INPUT_BUDGET;
}

function reservedOutputTokens(opts: { maxTokens?: number; json?: boolean }, provider: ProviderType): number {
  const requested = opts.maxTokens ?? (opts.json ? 2_048 : 4_096);
  const capped = Math.min(requested, 8_192);
  // Groq free-tier 413s are enforced against the TPM request envelope, not
  // just prompt tokens. Reserve the completion budget before deciding whether
  // the prompt fits; otherwise a 5.5k-token prompt + 4k default output becomes
  // a 9k+ TPM request and fails instantly.
  if (provider === "groq") return Math.max(768, capped);
  return Math.max(256, Math.min(capped, 2_048));
}

function providerAvailableInputBudget(provider: ProviderType, opts: { maxTokens?: number; json?: boolean }): number {
  return Math.max(1_000, providerInputBudget(provider) - reservedOutputTokens(opts, provider));
}

/**
 * Picks the next budget tier for the compressed-retry cascade: the largest
 * size-skipped budget strictly BELOW `floor` (the smallest tier already
 * tried), or `undefined` once every tier has been exhausted. Descending
 * strictly below the floor each call guarantees the cascade terminates and
 * that every size-skipped provider — not just the single largest one —
 * eventually gets a request compressed to fit ITS OWN budget. Extracted so
 * the cascade order is directly unit-testable without mocking routeAI's
 * full provider/key resolution.
 */
export function nextCompressionBudget(
  sizeSkippedBudgets: readonly number[],
  floor: number,
): number | undefined {
  return sizeSkippedBudgets.filter((b) => b < floor).sort((a, b) => b - a)[0];
}

/** ~3.5 chars/token is a safe over-estimate for Spanish legal prose. */
function estimateInputTokens(opts: { systemInstruction?: string; userContent: unknown }): number {
  let chars = (opts.systemInstruction ?? "").length;
  const uc = opts.userContent;
  if (typeof uc === "string") chars += uc.length;
  else if (Array.isArray(uc))
    for (const part of uc) {
      if (part && typeof part === "object" && "text" in part)
        chars += String((part as { text?: string }).text ?? "").length;
      else chars += 1_500; // image part — rough fixed cost
    }
  return Math.ceil(chars / 3.5);
}


/**
 * Shrink a request so it fits a provider's input budget.
 *
 * Used as a last resort: when every provider that COULD take the full payload
 * is on cooldown, a marginally-oversized prompt (e.g. 12.1k vs a 12k Groq
 * budget) previously killed the whole stage. Trimming the middle of the user
 * content keeps the instructions (head) and the most recent context (tail),
 * which is far better than failing the run.
 */
function fitOptsToBudget<T extends { systemInstruction?: string; userContent: unknown }>(
  opts: T,
  budgetTokens: number,
): T {
  const CHARS_PER_TOKEN = 3.5;
  const sysChars = (opts.systemInstruction ?? "").length;
  // 5% safety margin so the estimate can't land right on the ceiling.
  const allowedChars = Math.max(1_000, Math.floor(budgetTokens * CHARS_PER_TOKEN * 0.9) - sysChars);
  const marker = "\n\n[…contenido intermedio omitido por límite del proveedor…]\n\n";

  const trim = (text: string, limit: number): string => {
    if (text.length <= limit) return text;
    const keep = Math.max(200, limit - marker.length);
    const head = Math.floor(keep * 0.6);
    const tail = keep - head;
    return text.slice(0, head) + marker + text.slice(text.length - tail);
  };

  const uc = opts.userContent;
  if (typeof uc === "string") {
    return { ...opts, userContent: trim(uc, allowedChars) };
  }
  if (Array.isArray(uc)) {
    const textParts = uc.filter(
      (p) => p && typeof p === "object" && "text" in p,
    ) as { text?: string }[];
    if (textParts.length === 0) return opts;
    const perPart = Math.max(500, Math.floor(allowedChars / textParts.length));
    return {
      ...opts,
      userContent: uc.map((p) =>
        p && typeof p === "object" && "text" in p
          ? { ...(p as object), text: trim(String((p as { text?: string }).text ?? ""), perPart) }
          : p,
      ),
    };
  }
  return opts;
}




function bumpProvider(p: ProviderType) {
  return (_state.byProvider[p] ??= { totalOk: 0, totalErr: 0 });
}

function record(r: CallRecord) {
  _state.last = r;
  const bp = bumpProvider(r.provider);
  if (r.ok) {
    _state.lastSuccess = r;
    bp.totalOk++;
    bp.lastOk = r.ts;
  } else {
    _state.lastError = r;
    bp.totalErr++;
    bp.lastError = r.error;
    bp.lastErrorTs = r.ts;
  }
  _state.history.push(r);
  if (_state.history.length > 50) _state.history.shift();
  if (r.failover) _state.failovers++;
}

export function getRouterDiagnostics() {
  return {
    last: _state.last ?? null,
    lastSuccess: _state.lastSuccess ?? null,
    lastError: _state.lastError ?? null,
    history: _state.history.slice(-20),
    byProvider: _state.byProvider,
    failovers: _state.failovers,
    cacheHits: _state.cacheHits,
    totalCalls: _state.totalCalls,
    cacheSize: _cache.size,
    cooldowns: listProviderCooldowns(),
  };
}

// In-memory completion cache (per-worker, ephemeral).
const _cache = new Map<string, { result: RouteResult; ts: number }>();
const CACHE_MAX = 500;

// Runtime Groq key try-order: strict round-robin per keyset/model. This gives
// balanced first-key selection without a read/write database race, and every
// selection is emitted into telemetry below.
const _groqKeyCursor = new Map<string, number>();
const _providerGroupCursor = new Map<string, number>();

/** Rotate provider groups while preserving every provider's internal key
 * order. Exported so the fairness invariant is testable without DB/network
 * mocks. */
export function rotateProviderGroups<T extends { provider: ProviderType }>(
  groups: readonly T[],
  start: number,
): T[] {
  if (groups.length < 2) return [...groups];
  const offset = ((start % groups.length) + groups.length) % groups.length;
  return groups.map((_, index) => groups[(offset + index) % groups.length]);
}

// Groq enforces quotas at the ORGANIZATION level for a given model. Users
// may hold keys across multiple orgs, so cooldown is keyed by (model, org)
// — not by model alone — otherwise a TPM 429 on one org blocks a healthy
// key from a different org. Duration depends on the limit kind parsed from
// the 429 body:
//   - "tokens per min" / "rpm": ~60s (bucket resets each minute)
//   - "tokens per day" / "requests per day": ~1h retry cadence
//     (the worker will keep requeuing; TPD truly resets at 00:00 UTC but
//     we don't want to block for that long in-process — the pipeline
//     retries anyway).
//   - unknown: 45s (previous default).
const GROQ_COOLDOWN_TPM_MS = 60_000;
const GROQ_COOLDOWN_TPD_MS = 60 * 60_000;
const GROQ_COOLDOWN_DEFAULT_MS = 45_000;
const _groqCooldown = new Map<string, number>(); // key = `${model}::${org}`
function cooldownKey(model: string | undefined | null, org: string | undefined | null): string {
  return `${(model ?? "default").toLowerCase()}::${org ?? "*"}`;
}
function getGroqCooldownUntil(
  model: string | undefined | null,
  org?: string | null,
): number | undefined {
  const k = cooldownKey(model, org);
  const until = _groqCooldown.get(k);
  if (!until) return undefined;
  if (Date.now() >= until) {
    _groqCooldown.delete(k);
    return undefined;
  }
  return until;
}
function markGroqCoolingDown(
  model: string | undefined | null,
  org: string | undefined | null,
  kind: "tpm" | "tpd" | "unknown",
): void {
  const ms =
    kind === "tpm"
      ? GROQ_COOLDOWN_TPM_MS
      : kind === "tpd"
        ? GROQ_COOLDOWN_TPD_MS
        : GROQ_COOLDOWN_DEFAULT_MS;
  _groqCooldown.set(cooldownKey(model, org), Date.now() + ms);
}
/** Parse `on tokens per min` / `on tokens per day` / `on requests per …` out of a Groq 429 body. */
function parseGroqLimitKind(msg: string): "tpm" | "tpd" | "unknown" {
  if (/per\s*min/i.test(msg)) return "tpm";
  if (/per\s*day/i.test(msg)) return "tpd";
  return "unknown";
}
// Back-compat shim for call sites that don't have org context.
function markGroqModelCoolingDown(model: string | undefined | null): void {
  markGroqCoolingDown(model, null, "unknown");
}
function getGroqModelCooldownUntil(model: string | undefined | null): number | undefined {
  // Any org-scoped cooldown that matches this model still counts as "cooling".
  const prefix = `${(model ?? "default").toLowerCase()}::`;
  let latest: number | undefined;
  for (const [k, until] of _groqCooldown) {
    if (!k.startsWith(prefix)) continue;
    if (Date.now() >= until) {
      _groqCooldown.delete(k);
      continue;
    }
    if (latest === undefined || until > latest) latest = until;
  }
  return latest;
}

/**
 * Admin: list active Groq cooldowns.
 * Returns one entry per (model, org) pair whose cooldown has not yet expired.
 */
export function listGroqCooldowns(): Array<{
  model: string;
  org: string;
  until: number;
  retryAfterMs: number;
}> {
  const now = Date.now();
  const out: Array<{ model: string; org: string; until: number; retryAfterMs: number }> = [];
  for (const [k, until] of _groqCooldown) {
    if (now >= until) {
      _groqCooldown.delete(k);
      continue;
    }
    const [model, org] = k.split("::");
    out.push({ model, org: org ?? "*", until, retryAfterMs: until - now });
  }
  return out;
}

export function listAiProviderCooldowns() {
  return listProviderCooldowns();
}

/**
 * Admin: clear Groq cooldowns.
 * - No args → clears every cooldown entry.
 * - `model` provided → clears every (model, *) entry for that model.
 * Returns the number of entries cleared.
 */
export function clearGroqCooldowns(model?: string | null): number {
  if (!model) {
    const n = _groqCooldown.size;
    _groqCooldown.clear();
    return n;
  }
  const prefix = `${model.toLowerCase()}::`;
  let n = 0;
  for (const k of Array.from(_groqCooldown.keys())) {
    if (k.startsWith(prefix)) {
      _groqCooldown.delete(k);
      n++;
    }
  }
  return n;
}

export function clearAiProviderCooldowns(provider?: ProviderType | null, model?: string | null): number {
  const generic = clearProviderCooldowns({ provider, model });
  if (provider && provider !== "groq") return generic;
  return generic + clearGroqCooldowns(model);
}

/**
 * Drop the in-memory provider/key caches so the very next call re-reads
 * ai_providers + user_ai_keys from the database. Called whenever keys are
 * added/removed/toggled and whenever the health page is refreshed, so a
 * freshly added key is picked up immediately instead of after the 20s TTL.
 */
export function invalidateProviderCaches(userId?: string | null): void {
  _providerRowsCache = null;
  if (userId) _userProviderGroupsCache.delete(userId);
  else _userProviderGroupsCache.clear();
}

/**
 * Full runtime reset for a provider (or all providers): clears cooldowns AND
 * the credential caches. This is what "refresh and it should clear" means —
 * nothing stale survives.
 */
export function resetAiRuntimeState(args?: {
  provider?: ProviderType | null;
  model?: string | null;
  userId?: string | null;
}): { clearedCooldowns: number } {
  const clearedCooldowns = clearAiProviderCooldowns(args?.provider ?? null, args?.model ?? null);
  invalidateProviderCaches(args?.userId ?? null);
  return { clearedCooldowns };
}

function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
function cursorKey(model: string | undefined | null, fingerprints: string[]): string {
  return `${(model ?? "default").toLowerCase()}:${fingerprints.join("|")}`;
}

function cacheKey(model: string, opts: RouteOpts) {
  const h = createHash("sha256");
  h.update(model);
  h.update("\0");
  h.update((opts.skipProviders ?? []).slice().sort().join(","));
  h.update("\0");
  h.update(opts.systemInstruction ?? "");
  h.update("\0");
  h.update(
    typeof opts.userContent === "string" ? opts.userContent : JSON.stringify(opts.userContent),
  );
  h.update("\0");
  h.update(opts.json ? "json" : "text");
  h.update("\0");
  h.update(String(opts.temperature ?? 0.2));
  return h.digest("hex");
}

// ---- DB access (uses admin client; this is server-only infra) ----

// A full pipeline run calls routeAI() ~25-30 times, and until now each one
// independently re-queried ai_providers AND user_ai_keys from scratch —
// this data cannot change mid-run in any way that matters for routing a
// single case, so re-fetching it every single call was pure redundant
// latency. Short TTL (not a long one) so the admin AI Providers page still
// reflects a just-added/edited key reasonably quickly.
const PROVIDER_ROWS_CACHE_TTL_MS = 20_000;
let _providerRowsCache: { rows: ProviderRow[]; expiresAt: number } | null = null;

async function loadProviderRows(): Promise<ProviderRow[]> {
  if (_providerRowsCache && _providerRowsCache.expiresAt > Date.now())
    return _providerRowsCache.rows;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("ai_providers")
    .select(
      "id,provider_type,display_name,enabled,priority,base_url,default_model,secret_name,api_key_encrypted",
    )
    .order("priority", { ascending: true });
  if (error) throw new Error(`ai_providers load failed: ${error.message}`);
  // Drop rows whose provider_type has no adapter in the factory. Left in, they
  // build an undefined provider and take the whole chain down with a TypeError
  // instead of failing over.
  const SUPPORTED: ProviderType[] = [
    "groq",
    "openai",
    "anthropic",
    "gemini",
    "openrouter",
    "ollama",
    "lmstudio",
  ];

  const rows = ((data ?? []) as ProviderRow[]).filter((r) => SUPPORTED.includes(r.provider_type));
  _providerRowsCache = { rows, expiresAt: Date.now() + PROVIDER_ROWS_CACHE_TTL_MS };
  return rows;
}

/**
 * Resolve ALL of the user's active providers + decrypted keys from user_ai_keys,
 * grouped by provider, ordered by the provider group's earliest created_at
 * (oldest-added provider tried first). Multiple keys for the same provider
 * become that provider's rotation pool. This is what lets a user add Groq +
 * Gemini + OpenAI etc. and have the router fall through across providers
 * (not just across keys within one provider) when one runs out of quota.
 */
const _userProviderGroupsCache = new Map<
  string,
  { groups: Array<{ provider: ProviderType; keys: string[] }>; expiresAt: number }
>();
const USER_PROVIDER_GROUPS_CACHE_TTL_MS = 20_000;

// Same one-warning-per-process dedup pattern as providers/factory.ts's
// warnOnce, scoped per (user, provider) instead of per provider row id.
const _warnedUndecryptableUserKeys = new Set<string>();
function warnUndecryptableUserKey(userId: string, provider: ProviderType, err: unknown): void {
  const dedupKey = `${userId}:${provider}`;
  if (_warnedUndecryptableUserKeys.has(dedupKey)) return;
  _warnedUndecryptableUserKeys.add(dedupKey);
  console.warn(
    `[ai.user_key] user ${userId}'s stored ${provider} key failed to decrypt and was silently dropped ` +
      `from routing (${err instanceof Error ? err.message : String(err)}). Common cause: ` +
      `AI_PROVIDER_ENCRYPTION_KEY was rotated/changed since the key was saved, or the stored value is ` +
      `corrupted. The key still shows as "configured" in Admin → AI Keys — it will need to be deleted ` +
      `and re-added to be usable again.`,
  );
}

async function loadUserProviderKeyGroups(
  userId: string,
): Promise<Array<{ provider: ProviderType; keys: string[] }>> {
  const cached = _userProviderGroupsCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.groups;
  const groups = await _loadUserProviderKeyGroupsUncached(userId);
  _userProviderGroupsCache.set(userId, {
    groups,
    expiresAt: Date.now() + USER_PROVIDER_GROUPS_CACHE_TTL_MS,
  });
  return groups;
}

/**
 * Total distinct, working (provider, key) pairs this user has configured
 * across every provider (user_ai_keys), NOT including explicit runtime
 * keys a caller might separately hold — those are the caller's own to
 * count. For a caller deciding whether firing two AI calls at once is safe
 * (spreads across genuinely independent keys) or risky (both calls could
 * land on the SAME single key and trip its per-minute rate limit) rather
 * than a raw-key-material lookup, so it returns only a count, never the
 * plaintext keys themselves. Fails closed: any lookup error returns 0,
 * which callers should read as "assume the least capacity available,"
 * i.e. don't parallelize — never treat a failed count as "plenty of keys."
 */
export async function countUserProviderKeys(userId: string | null | undefined): Promise<number> {
  if (!userId) return 0;
  try {
    const groups = await loadUserProviderKeyGroups(userId);
    return groups.reduce((sum, g) => sum + g.keys.length, 0);
  } catch {
    return 0;
  }
}

async function _loadUserProviderKeyGroupsUncached(
  userId: string,
): Promise<Array<{ provider: ProviderType; keys: string[] }>> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { decryptKey } = await import("@/lib/canonical/encryption.server");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("user_ai_keys")
    .select("provider,encrypted_key,is_active,created_at")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (error || !data || data.length === 0) return [];

  const order: ProviderType[] = [];
  const byProvider = new Map<ProviderType, string[]>();
  for (const row of data as Array<{ provider: string; encrypted_key: string; created_at?: string }>) {
    const provider = row.provider as ProviderType;
    if (!byProvider.has(provider)) {
      byProvider.set(provider, []);
      order.push(provider); // first time we see a provider = its group's oldest key
    }
    try {
      const plain = decryptKey(row.encrypted_key);
      if (plain) byProvider.get(provider)!.push(plain);
    } catch (err) {
      // FIX: this previously discarded a decrypt failure with zero trace —
      // identical to the exact bug already found and fixed in
      // providers/factory.ts's decryptApiKey (2026-07-30) for the
      // ai_providers table, but that fix never touched this parallel path
      // for user_ai_keys. A key that fails to decrypt here (AI_PROVIDER_
      // ENCRYPTION_KEY rotated since it was saved, a corrupted stored
      // value) is silently dropped from the routing chain — the admin UI
      // still shows it as "configured," the pipeline just never tries it.
      // That is indistinguishable from the outside from "the router is out
      // of capacity" even when the user has several genuinely working keys
      // configured, which is exactly the failure this warning exists to
      // catch. Logged once per (user, provider) per process, not per call —
      // a full pipeline run calls this dozens of times and every failure
      // would repeat identically.
      warnUndecryptableUserKey(userId, provider, err);
    }
  }
  const groups = order
    .map((provider) => ({ provider, keys: byProvider.get(provider) ?? [] }))
    .filter((g) => g.keys.length > 0);
  if (groups.length <= 1) return groups; // nothing to reorder

  // Apply the user's saved provider-order preference (Intelligence Providers
  // page), if any — previously this preference was saved and displayed but
  // never actually consulted here, so reordering it had zero real effect.
  // Only reorders among providers that actually have a working key; a
  // provider with no key was never in `groups` to begin with, so this can't
  // resurrect an unconfigured provider into the chain.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: orderRows } = await (supabaseAdmin as any)
      .from("user_provider_order")
      .select("provider,order_index")
      .eq("user_id", userId)
      .order("order_index", { ascending: true });
    if (orderRows && orderRows.length > 0) {
      const preferredOrder = (orderRows as Array<{ provider: string }>).map((r) => r.provider);
      const byPreference = (p: ProviderType) => {
        const idx = preferredOrder.indexOf(p);
        return idx === -1 ? preferredOrder.length : idx; // unlisted providers keep their created_at position, after all listed ones
      };
      groups.sort((a, b) => byPreference(a.provider) - byPreference(b.provider));
    }
  } catch {
    /* saved order is a preference layer, not a credential — never fail the call over it */
  }

  return groups;
}

async function loadTaskRoute(
  task: AITask,
): Promise<{ provider_id: string | null; model: string | null } | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("ai_task_routing")
    .select("provider_id,model")
    .eq("task", task)
    .maybeSingle();
  return data ?? null;
}

async function stampProvider(id: string, ok: boolean, error?: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const patch = ok
    ? { last_ok_at: new Date().toISOString(), last_error: null }
    : { last_error_at: new Date().toISOString(), last_error: (error ?? "").slice(0, 500) };
  await supabaseAdmin.from("ai_providers").update(patch).eq("id", id);
}

// ---- Public API ----

export async function listProviderRows() {
  return loadProviderRows();
}

/**
 * Largest per-request payload (in CHARS) that EVERY configured provider can
 * accept, capped at `ceilingChars`.
 *
 * Why this exists: the pre-flight size gate in `routeAI` skips any provider
 * whose input budget is smaller than the prompt. With a 60k-char batch, Groq
 * (6k-token budget) is skipped on every single call — so all load lands on the
 * wide-context providers, and when those are rate-limited or out of credits the
 * whole run dies even though a perfectly healthy Groq key is sitting idle.
 * Packing to the narrowest configured provider keeps every provider in the
 * fallback chain eligible. The corpus size is unchanged; it is simply split
 * into more, smaller requests.
 */
export async function packingCharBudget(
  ceilingChars: number,
  overheadChars: number = PROMPT_OVERHEAD_CHARS.default,
  skipProviders: ProviderType[] = [],
): Promise<number> {
  const rows = await loadProviderRows();
  const skipped = new Set(skipProviders);
  // Per-provider corpus capacity, after reserving completion tokens and the
  // non-corpus prompt overhead (Mexico-lock preamble, JSON schema, role text).
  // Providers the CALL SITE will also exclude at routing time (`skipProviders`
  // passed to routeAI/callGroq) must be excluded here too — otherwise the
  // budget is packed for a provider that can never serve the request.
  const capacities: number[] = [];
  for (const r of rows) {
    if (skipped.has(r.provider_type)) continue;
    capacities.push(
      Math.floor(providerAvailableInputBudget(r.provider_type, { json: true }) * 3.5 - overheadChars),
    );
  }
  if (capacities.length === 0) return ceilingChars;


  // Pack to the NARROWEST provider so every provider stays eligible — but only
  // among providers that can actually hold at least MIN_PACKING_CHARS of
  // corpus. A provider whose real capacity is below the floor (e.g. Groq's
  // free-tier 8k TPM ceiling once a ~7k-char analyzer overhead is reserved)
  // must NOT drag the packing budget below its own limit: clamping up to the
  // floor produced batches that were mathematically guaranteed to exceed that
  // provider's ceiling, so it was skipped with `payload_exceeds_provider_limit`
  // on every call. Those batches are instead routed to the wide-context
  // providers, which the pre-flight size gate already handles gracefully.
  const usable = capacities.filter((c) => c >= MIN_PACKING_CHARS);
  const target = usable.length > 0 ? Math.min(...usable) : Math.max(...capacities);
  return Math.max(1_000, Math.min(ceilingChars, target));
}


/**
 * Non-corpus prompt overhead, in CHARS, per call site.
 *
 * These are MEASURED, not guessed: the worst case across every practice area
 * and both locales (es/en) of the Mexico-lock preamble + practice-area
 * guardrails + system instruction + JSON schema wrapper, corpus excluded.
 *
 *   analyzers : 4,874 chars (worst case: constitucional / es)
 *   agents    : 2,712 chars (worst case: constitucional / es)
 *
 * Each value rounds the measurement up with ~40% headroom so ordinary prompt
 * edits cannot silently push a batch over a provider's budget again.
 */
export const PROMPT_OVERHEAD_CHARS = {
  analyzers: 7_000,
  agents: 4_000,
  /** Conservative fallback for call sites that have not been measured. */
  default: 8_000,
} as const;

/** Never pack below this — tiny batches multiply request count for no gain. */
const MIN_PACKING_CHARS = 6_000;


export async function routeAI(opts: RouteOpts): Promise<RouteResult> {
  _state.totalCalls++;
  const skippedProviders = new Set(opts.skipProviders ?? []);
  const rows = (await loadProviderRows()).filter((r) => !skippedProviders.has(r.provider_type));

  // Resolve runtime keys: explicit apiKey(s) first (single provider, unchanged);
  // then per-user keys, which may now span MULTIPLE providers.
  let runtimeProvider: ProviderType | undefined = opts.runtimeProvider;
  const explicitKeys = [...(opts.apiKeys ?? []), ...(opts.apiKey ? [opts.apiKey] : [])].filter(
    (k, i, a): k is string => typeof k === "string" && k.trim().length > 0 && a.indexOf(k) === i,
  );

  // Groups of {provider, keys}, tried in order, each group's keys rotated
  // internally. Populated from an explicit override (if provided) AND from
  // every active provider/key the user has configured, merged together —
  // NOT either/or. This ensures fallback keys added in Admin -> AI
  // Providers are always tried even when the caller (e.g. the pipeline)
  // also passes its own explicit Groq apiKey/apiKeys.
  let runtimeGroups: Array<{ provider: ProviderType; keys: string[] }> = [];
  if (explicitKeys.length > 0) {
    runtimeProvider = runtimeProvider ?? "groq"; // back-compat default
    runtimeGroups = [{ provider: runtimeProvider, keys: explicitKeys }];
  }
  if (opts.userId) {
    const userGroups = await loadUserProviderKeyGroups(opts.userId);
    const explicitProviders = new Set(runtimeGroups.map((g) => g.provider));
    for (const g of userGroups) {
      if (explicitProviders.has(g.provider)) {
        // Same provider as the explicit override — append any keys not
        // already included, so user-added keys still act as fallbacks.
        const existing = runtimeGroups.find((r) => r.provider === g.provider)!;
        const newKeys = g.keys.filter((k) => !existing.keys.includes(k));
        existing.keys.push(...newKeys);
      } else {
        // A different provider entirely — add it as its own fallback group.
        runtimeGroups.push(g);
      }
    }
  }

  // Balance successful calls ACROSS configured providers, not just across
  // keys within the first provider. Previously the saved provider order was
  // a permanent primary/fallback chain, so a healthy first provider served
  // every request and Gemini/Groq/OpenRouter never rotated. A forced provider
  // remains absolute (Admin connection tests rely on that behavior).
  if (!opts.forceProvider && opts.userId && runtimeGroups.length > 1) {
    const providers = runtimeGroups.map((g) => g.provider);
    const cursorId = `${opts.userId}:${providers.slice().sort().join(",")}`;
    const selectedOrder = opts._providerOrder?.filter((p) => providers.includes(p));
    if (selectedOrder?.length === providers.length) {
      runtimeGroups = selectedOrder.map((provider) => runtimeGroups.find((g) => g.provider === provider)!);
    } else {
      const start = (_providerGroupCursor.get(cursorId) ?? 0) % runtimeGroups.length;
      runtimeGroups = rotateProviderGroups(runtimeGroups, start);
      _providerGroupCursor.set(cursorId, (start + 1) % runtimeGroups.length);
      Object.assign(opts, { _providerOrder: runtimeGroups.map((g) => g.provider) });
    }
  }

  if (!rows.length && runtimeGroups.length === 0) throw new Error("No AI providers configured.");

  // Build the ordered chain across every runtime group.
  let chain: RuntimeGroqRow[] = [];
  if (runtimeGroups.length > 0) {
    for (const { provider, keys } of runtimeGroups) {
      if (keys.length === 0) continue;
      const baseRow: ProviderRow = rows.find((r) => r.provider_type === provider) ?? {
        id: `runtime-${provider}`,
        provider_type: provider,
        display_name: `${provider} runtime key`,
        enabled: true,
        priority: 1,
        base_url: null,
        default_model: null,
        secret_name: null,
        api_key_encrypted: null,
      };
      const fingerprints = keys.map(keyFingerprint);
      const ck = cursorKey(opts.model, fingerprints);
      const start = keys.length > 1 ? (_groqKeyCursor.get(ck) ?? 0) % keys.length : 0;
      if (keys.length > 1) _groqKeyCursor.set(ck, (start + 1) % keys.length);
      const rotatedIndices = keys.map((_, idx) => (start + idx) % keys.length);
      chain.push(
        ...rotatedIndices.map((idx) => ({
          ...baseRow,
          id: `${baseRow.id}:runtime:${idx}`,
          enabled: true,
          runtimeApiKey: keys[idx],
          runtimeKeyIndex: idx,
          runtimeKeyFingerprint: fingerprints[idx],
          rotationStartIndex: start,
          rotationAdvanced: keys.length > 1,
          selectionReason: `${provider}_round_robin_runtime_key`,
          consideredKeyIndexes: rotatedIndices,
        })),
      );
    }
    // Server-secret fallback: after every user/runtime key has been tried,
    // fall through to enabled ai_providers rows whose key comes from a
    // server-side secret. This never includes a platform/credit-billed
    // gateway — the Lovable provider was removed from ProviderType, from the
    // factory and from the database, so only self-hosted or self-funded
    // provider secrets (GROQ_API_KEY, GEMINI_API_KEY, ...) can appear here.
    // A provider already tried above as a user key is skipped so the same
    // provider is not walked twice per call.
    const alreadyTried = new Set(runtimeGroups.map((g) => g.provider));
    const { resolveApiKey } = await import("./providers/factory");
    for (const r of rows) {
      if (!r.enabled) continue;
      if (alreadyTried.has(r.provider_type)) continue;
      if (!resolveApiKey(r)) continue; // no server key configured — nothing to try
      chain.push({ ...r, selectionReason: "server_secret_fallback" });
    }
  } else if (opts.forceProvider) {
    chain = rows.filter((r) => r.provider_type === opts.forceProvider && r.enabled);
    if (!chain.length)
      throw new Error(`Provider '${opts.forceProvider}' is not enabled or not configured.`);

  } else {
    let pinned: ProviderRow | undefined;
    if (opts.task) {
      const tr = await loadTaskRoute(opts.task);
      if (tr?.provider_id) pinned = rows.find((r) => r.id === tr.provider_id && r.enabled);
    }
    const enabled = rows.filter((r) => r.enabled && r.id !== pinned?.id);
    chain = pinned ? [pinned, ...enabled] : enabled;
  }

  // A pinned provider is absolute. The runtime-group branch above merges the
  // user's other providers and server-secret rows into the chain, which made a
  // "Test Gemini" probe silently walk into Groq. Enforce the pin here so it
  // holds no matter which branch built the chain.
  if (opts.forceProvider) {
    chain = chain.filter((r) => r.provider_type === opts.forceProvider);
    if (!chain.length)
      throw new Error(`Provider '${opts.forceProvider}' is not enabled or not configured.`);
  }

  if (!chain.length) throw new Error("No enabled AI providers available.");

  // Cache lookup (keyed by intended model of the FIRST provider in chain).
  const firstModel = opts.model ?? chain[0].default_model ?? chain[0].provider_type;
  const useCache = opts.cache !== false;
  const ck = useCache ? cacheKey(firstModel, opts) : "";
  if (useCache && ck) {
    const hit = _cache.get(ck);
    if (hit) {
      _state.cacheHits++;
      return { ...hit.result, cached: true };
    }
  }

  const fellBackFrom: ProviderType[] = [];
  const errors: string[] = [];
  const preAttemptSkips: string[] = [];
  // Input budgets of providers held back ONLY because the payload was too big
  // for them while a full-size provider still looked available. If that
  // full-size provider then fails, these are the last usable options and the
  // request must be compressed to fit the largest of them rather than the
  // whole call dying with `never_attempted: [groq]`.
  const sizeSkippedBudgets: number[] = [];
  const cooldownSkips: Array<{
    provider: ProviderType;
    model: string | null;
    retryAfterMs: number;
    reason: string;
  }> = [];
  // Track Groq orgs proven exhausted this call and the (fingerprint→org)
  // attribution learned from their 429 responses. Lets us skip only
  // known-same-org keys while still trying keys from other Groq accounts.
  const exhaustedOrgs = new Set<string>();
  const keyOrgMap = new Map<string, string>();
  // Providers actually attempted (a chat() call was made) — as opposed to
  // every provider present in the built chain, some of which may have been
  // skipped entirely (e.g. remaining same-provider keys after a 413, or
  // Groq keys skipped during an active cooldown). Used for the final error
  // message so "tried: x, y" reflects reality instead of the full chain.
  const attemptedProviders = new Set<ProviderType>();
  // Failure taxonomy (see .lovable/plan archive 2026-09-18): some faults are
  // provider/model-scoped, not key-scoped. Rotating every configured key
  // against a model the provider does not serve (HTTP 404 model_not_found)
  // or against a key the provider rejected (401/403) is pure amplification:
  // the next attempt is guaranteed to fail identically. Record both scopes
  // for the duration of THIS logical call and skip matching chain rows.
  const deadProviderModels = new Set<string>();
  const deadKeys = new Set<string>();
  const deadScopeKey = (provider: ProviderType, model: string | null) =>
    `${provider}/${model ?? "(default)"}`;

  const effectiveModelFor = (row: RuntimeGroqRow): string | null =>
    row.provider_type === "groq"
      ? opts.model ?? row.default_model ?? null
      : row.default_model ?? opts.model ?? null;
  const cooldownIdentityFor = (row: RuntimeGroqRow): string =>
    row.runtimeKeyFingerprint ?? row.id ?? row.provider_type;
  // KEY_INVALID must retire exactly ONE key. cooldownIdentityFor() falls back
  // to the provider row id when no fingerprint exists, which is shared by
  // every key of that provider — using it here would retire the whole
  // provider on a single 401. Always disambiguate by key index.
  const keyScopeKey = (row: RuntimeGroqRow): string =>
    row.runtimeKeyFingerprint ?? `${row.id ?? row.provider_type}#${row.runtimeKeyIndex ?? "env"}`;

  traceAsync({
    phase: "ai",
    step: "router.chain_built",
    status: "info",
    model: opts.model ?? null,
    detail: {
      chain: chain.map((r, idx) => ({
        order: idx + 1,
        provider: r.provider_type,
        model: r.default_model ?? null,
        runtime_key: r.runtimeKeyIndex != null ? `key#${r.runtimeKeyIndex + 1}` : "(env)",
      })),
      skipped_providers: [...skippedProviders],
      requested_model: opts.model ?? null,
    },
  });

  // ---------------------------------------------------------------------
  // Pre-flight request-size gate.
  //
  // Groq's free tier caps a SINGLE request at the tokens-per-minute ceiling
  // (8k). A 17k-token engine prompt therefore returns HTTP 413 every single
  // time — it burns an attempt, marks the key, and (worse) the run then dies
  // even though Gemini, with a 1M-token window, could have served it fine.
  // Estimate the payload once and route around providers that physically
  // cannot accept it, instead of learning that from a guaranteed rejection.
  // ---------------------------------------------------------------------
  const estimatedInputTokens = estimateInputTokens(opts);
  const sizeEligible = chain.map((r) => estimatedInputTokens <= providerAvailableInputBudget(r.provider_type, opts));
  const anySizeEligible = sizeEligible.some(Boolean);

  let realAttempts = 0;
  for (let i = 0; i < chain.length; i++) {
    const row = chain[i];
    // Per-row payload. Normally the untouched request; compressed only when
    // this provider is the last usable option and the payload overflows.
    let rowOpts = opts;
    if (anySizeEligible && !sizeEligible[i]) {
      // Is there another provider that can take the FULL payload and isn't
      // currently on cooldown? If yes, skip this one as before. If not,
      // shrinking beats failing the whole stage.
      const fullSizeAlternative = chain.some(
        (r2, j) =>
          sizeEligible[j] &&
          j !== i &&
          !getProviderCooldown({
            provider: r2.provider_type,
            model: effectiveModelFor(r2),
            key: cooldownIdentityFor(r2),
          }),
      );
      if (fullSizeAlternative) {
        sizeSkippedBudgets.push(providerAvailableInputBudget(row.provider_type, opts));
        preAttemptSkips.push(
          `${row.display_name} [payload_too_large]: estimated ${estimatedInputTokens} input tokens exceeds ${providerAvailableInputBudget(row.provider_type, opts)} token provider input budget after output reservation`,
        );
        traceAsync({
          phase: "ai",
          step: "router.provider_skipped",
          status: "warn",
          provider: row.provider_type,
          model: effectiveModelFor(row),
          detail: {
            reason: "payload_exceeds_provider_limit",
            estimated_input_tokens: estimatedInputTokens,
            provider_input_budget: providerAvailableInputBudget(row.provider_type, opts),
            reserved_output_tokens: reservedOutputTokens(opts, row.provider_type),
          },
        });
        continue;
      }
      const budget = providerAvailableInputBudget(row.provider_type, opts);
      rowOpts = fitOptsToBudget(opts, budget);
      traceAsync({
        phase: "ai",
        step: "router.payload_compressed",
        status: "warn",
        provider: row.provider_type,
        model: effectiveModelFor(row),
        detail: {
          reason: "no_full_size_provider_available",
          estimated_input_tokens: estimatedInputTokens,
          provider_input_budget: budget,
          reserved_output_tokens: reservedOutputTokens(opts, row.provider_type),
          compressed_input_tokens: estimateInputTokens(rowOpts),
        },
      });
    }


    if (realAttempts >= MAX_LOGICAL_PROVIDER_ATTEMPTS && attemptedProviders.has(row.provider_type)) {
      traceAsync({
        phase: "ai",
        step: "router.attempt_budget_exhausted",
        status: "warn",
        model: opts.model ?? null,
        detail: {
          max_attempts: MAX_LOGICAL_PROVIDER_ATTEMPTS,
          attempted_providers: [...attemptedProviders],
          remaining_chain: chain.length - i,
        },
      });
      preAttemptSkips.push(
        `${row.display_name} [attempt_budget]: skipped duplicate ${row.provider_type} key after ${MAX_LOGICAL_PROVIDER_ATTEMPTS} real provider calls`,
      );
      continue;
    }
    const effectiveModel = effectiveModelFor(row);
    // MODEL_NOT_FOUND is provider+model scoped, KEY_INVALID is key scoped.
    // Neither can be cured by trying another key of the same provider.
    if (deadProviderModels.has(deadScopeKey(row.provider_type, effectiveModel))) {
      preAttemptSkips.push(
        `${row.display_name} [model_not_found]: ${row.provider_type}/${effectiveModel ?? "default"} already answered 404 this call`,
      );
      traceAsync({
        phase: "ai",
        step: "router.provider_skipped",
        status: "warn",
        provider: row.provider_type,
        model: effectiveModel,
        detail: { reason: "model_not_found_this_call" },
      });
      continue;
    }
    if (deadKeys.has(cooldownIdentityFor(row))) {
      preAttemptSkips.push(
        `${row.display_name} [key_invalid]: key ${row.runtimeKeyIndex != null ? `#${row.runtimeKeyIndex + 1}` : "env"} rejected this call`,
      );
      traceAsync({
        phase: "ai",
        step: "router.provider_skipped",
        status: "warn",
        provider: row.provider_type,
        model: effectiveModel,
        detail: { reason: "key_invalid_this_call" },
      });
      continue;
    }
    const rawCandidateCooldown = getProviderCooldown({
      provider: row.provider_type,
      model: effectiveModel,
      key: cooldownIdentityFor(row),
    });
    const candidateCooldown = opts._ignoreCooldowns ? null : rawCandidateCooldown;
    if (candidateCooldown) {
      cooldownSkips.push({
        provider: row.provider_type,
        model: effectiveModel,
        retryAfterMs: candidateCooldown.retryAfterMs,
        reason: candidateCooldown.reason,
      });
      preAttemptSkips.push(
        `${row.display_name} [cooldown]: ${row.provider_type}/${effectiveModel ?? "default"} key ${row.runtimeKeyIndex != null ? `#${row.runtimeKeyIndex + 1}` : "env"} retry in ${Math.ceil(candidateCooldown.retryAfterMs / 1000)}s (${candidateCooldown.reason})`,
      );
      traceAsync({
        phase: "ai",
        step: "router.provider_skipped",
        status: "warn",
        provider: row.provider_type,
        model: effectiveModel,
        detail: {
          reason: "cooldown_active",
          cooldown_ms: candidateCooldown.retryAfterMs,
          cooldown_reason: candidateCooldown.reason,
          key: row.runtimeKeyIndex != null ? `key#${row.runtimeKeyIndex + 1}` : "(env)",
        },
      });
      continue;
    }
    const provider: AIProvider = buildProvider(row, row.runtimeApiKey);
    const maskedKey = row.runtimeApiKey
      ? `${row.runtimeApiKey.slice(0, 4)}…${row.runtimeApiKey.slice(-4)}`
      : "(env)";
    const keyLabel =
      row.runtimeKeyIndex != null ? `key#${row.runtimeKeyIndex + 1} ${maskedKey}` : maskedKey;
    const t0 = Date.now();
    realAttempts++;
    attemptedProviders.add(row.provider_type);
    traceAsync({
      phase: "ai",
      step: "router.attempt",
      status: "start",
      provider: row.provider_type,
      model: opts.model ?? row.default_model ?? null,
      attempt: i + 1,
      detail: { key: keyLabel, chain_position: `${i + 1}/${chain.length}` },
    });
    try {
      // The requested opts.model may be provider-specific (e.g. a Groq model
      // like "meta-llama/llama-4-scout..."). When we fail over to a different
      // provider family, strip opts.model so that provider's default_model is
      // used instead of forwarding an unknown model name.
      const baseProviderOpts =
        row.provider_type === "groq"
          ? rowOpts
          : { ...rowOpts, model: row.default_model ?? undefined };
      // Retry-with-backoff only for transient transport/5xx failures. HTTP 429
      // never retries in-place: the outer cooldown/failover path must mark the
      // exact key/model unavailable immediately so a single logical AI call
      // cannot hammer a fresh Gemini/Groq key repeatedly.
      let r: ChatResult | undefined;
      let lastErr: unknown;
      const RETRY_DELAYS_MS = [400, 1_200].slice(0, MAX_PROVIDER_RETRIES_PER_CALL);
      let retryCount = 0;
      const retryReasons: string[] = [];
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          assertCheckpointBudget(`before AI call attempt ${attempt + 1}`);
          const providerOpts = {
            ...baseProviderOpts,
            ...(row.provider_type === "groq" && baseProviderOpts.maxTokens == null
              ? { maxTokens: opts.json ? 2_048 : 3_072 }
              : {}),
            timeoutMs:
              baseProviderOpts.timeoutMs ??
              aiCallTimeoutForCheckpoint(`AI call attempt ${attempt + 1}`),
          };
          r = await provider.chat(providerOpts);
          // NOTE: deliberately NO checkpoint assertion here. A response that
          // already came back is completed work — throwing it away because
          // the tick budget expired during the call means the caller never
          // gets to persist it (e.g. reports.report_chunk_cache), so the next
          // tick redoes the identical call and the stage checkpoints forever
          // with zero forward progress. The stage-level hard deadline still
          // yields; it just does so AFTER the result had a chance to be saved.

          lastErr = undefined;
          break;
        } catch (err) {
          if (isCheckpointError(err)) throw err;
          lastErr = err;
          const em = err instanceof Error ? err.message : String(err);
          const isPayment =
            /HTTP 402|payment_required|not enough credits|insufficient credits/i.test(em);
          const isRateLimit = !isPayment && /HTTP 429|rate.?limit|too many requests/i.test(em);
          const isTransport =
            /HTTP 5\d\d|timeout|ETIMEDOUT|ECONNRESET/i.test(em) &&
            !/HTTP 413|request too large|payload too large|context.*length|maximum context/i.test(
              em,
            ) &&
            !/HTTP 401|HTTP 403|invalid_api_key|unauthor/i.test(em);

          if (isRateLimit) throw err;

          if (!isTransport || attempt >= RETRY_DELAYS_MS.length) throw err;
          retryCount++;
          retryReasons.push(em.slice(0, 120));
          assertCheckpointBudget(
            `before retry backoff ${attempt + 1}`,
            RETRY_DELAYS_MS[attempt] + 2_000,
          );
          console.warn(
            `[router.key] retry attempt=${attempt + 1} after ${RETRY_DELAYS_MS[attempt]}ms provider=${row.provider_type} ${keyLabel} err=${em.slice(0, 120)}`,
          );
          await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[attempt]));
        }
      }
      if (!r) throw lastErr ?? new Error("provider returned no result");
      record({
        ts: Date.now(),
        provider: row.provider_type,
        providerId: row.id,
        model: r.model,
        ok: true,
        latencyMs: r.latencyMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        failover: i > 0,
      });
      // Push into current engine's telemetry scope (no-op outside a scope).
      try {
        const { pushTelemetryCall, computePromptSha256 } = await import("./telemetry.server");
        const routingStrategy =
          runtimeGroups.length > 0
            ? "runtime_key_chain"
            : opts.forceProvider
              ? "force_provider"
              : opts.task
                ? "task_route"
                : "priority_chain";
        pushTelemetryCall({
          ts: Date.now(),
          provider: row.provider_type,
          providerId: row.id,
          model: r.model,
          ok: true,
          latencyMs: Date.now() - t0,
          providerLatencyMs: r.latencyMs,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          totalTokens: r.totalTokens,
          retryCount,
          retryReasons: retryReasons.length ? retryReasons : undefined,
          providerRequestId: r.providerRequestId,
          fellBackFrom: fellBackFrom.length ? [...fellBackFrom] : undefined,
          keyIndex: row.runtimeKeyIndex,
          keyLabel,
          keyFingerprint: row.runtimeKeyFingerprint,
          keySelectionReason:
            row.selectionReason ??
            (row.runtimeApiKey
              ? `${row.provider_type}_runtime_key`
              : `${row.provider_type}_configured_provider`),
          consideredProviders:
            runtimeGroups.length > 0 ? runtimeGroups.map((g) => g.provider) : [row.provider_type],
          consideredKeyIndexes: row.consideredKeyIndexes,
          rotationStartIndex: row.rotationStartIndex,
          rotationAdvanced: row.rotationAdvanced,
          cooldownState: "inactive",
          promptSha256: computePromptSha256({
            systemInstruction: opts.systemInstruction,
            userContent: opts.userContent,
            model: r.model,
            temperature: opts.temperature,
            json: opts.json,
          }),
          config: {
            provider: row.provider_type,
            model: r.model,
            temperature: opts.temperature,
            max_tokens: opts.maxTokens,
            json_mode: opts.json,
            routing_strategy: routingStrategy,
          },
        });
      } catch {
        /* noop */
      }
      console.info(
        `[router.key] served ok provider=${row.provider_type} ${keyLabel} tokens=${r.totalTokens ?? 0} ms=${r.latencyMs}`,
      );
      traceAsync({
        phase: "ai",
        step: "router.served",
        status: "ok",
        provider: row.provider_type,
        model: r.model ?? opts.model ?? row.default_model ?? null,
        attempt: i + 1,
        durationMs: r.latencyMs ?? Date.now() - t0,
        detail: {
          key: keyLabel,
          total_tokens: r.totalTokens ?? null,
          retries: retryCount,
          fell_back_from: fellBackFrom.length ? fellBackFrom : null,
        },
      });
      if (!row.runtimeApiKey)
        void stampProvider(row.id, true).catch((e) =>
          console.warn("[router] stampProvider failed", e),
        );
      const result: RouteResult = {
        ...r,
        provider: row.provider_type,
        providerId: row.id,
        retryCount,
        ...(retryReasons.length ? { retryReasons } : {}),
        ...(row.runtimeKeyIndex != null ? { keyIndex: row.runtimeKeyIndex } : {}),
        ...(fellBackFrom.length ? { fellBackFrom } : {}),
      } as RouteResult;
      if (useCache && ck) {
        if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value as string);
        _cache.set(ck, { result, ts: Date.now() });
      }
      return result;
    } catch (e) {
      if (isCheckpointError(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      // Classify failure so operators can distinguish transient / retryable
      // faults from quota-exhaustion (whole KEY is out) and payload-too-large
      // (which should be split-and-retried by the caller, not by rotating keys).
      const isPayload =
        /HTTP 413|request too large|payload too large|context.*length|maximum context/i.test(msg);
      // Groq returns code:"rate_limit_exceeded" in the JSON body for TPM-exceeded
      // 413s. Require an actual HTTP 429 (or an explicit quota keyword that is
      // NOT co-occurring with 413) so genuine payload-too-large errors aren't
      // mislabeled as quota and don't defeat payload splitting.
      const isPayment = /HTTP 402|payment_required|not enough credits|insufficient credits/i.test(
        msg,
      );
      const isQuota =
        !isPayload &&
        (/HTTP 429/i.test(msg) || /insufficient_quota|too many requests|quota exceeded/i.test(msg));
      const isAuth = /HTTP 401|HTTP 403|invalid_api_key|unauthor/i.test(msg);
      const isModelNotFound = /HTTP 404|model_not_found|does not exist/i.test(msg);
      const kind = isPayload
        ? "payload_too_large"
        : isPayment || isQuota
          ? "quota"
          : isModelNotFound
            ? "model_not_found"
            : isAuth
              ? "auth"
              : "other";
      console.warn(
        `[router.key] failed provider=${row.provider_type} ${keyLabel} kind=${kind} err=${msg.slice(0, 200)}`,
      );
      traceAsync({
        phase: "ai",
        step: "router.attempt_failed",
        status: "error",
        provider: row.provider_type,
        model: opts.model ?? row.default_model ?? null,
        attempt: i + 1,
        durationMs: Date.now() - t0,
        error: msg,
        detail: {
          key: keyLabel,
          kind,
          real_attempts: realAttempts,
          max_real_attempts: MAX_LOGICAL_PROVIDER_ATTEMPTS,
        },
      });
      record({
        ts: Date.now(),
        provider: row.provider_type,
        providerId: row.id,
        model: opts.model ?? row.default_model ?? "?",
        ok: false,
        latencyMs: Date.now() - t0,
        error: `[${kind}] ${msg}`,
      });
      try {
        const { pushTelemetryCall } = await import("./telemetry.server");
        pushTelemetryCall({
          ts: Date.now(),
          provider: row.provider_type,
          providerId: row.id,
          model: opts.model ?? row.default_model ?? "?",
          ok: false,
          latencyMs: Date.now() - t0,
          error: msg.slice(0, 300),
          errorKind: kind,
          keyIndex: row.runtimeKeyIndex,
          keyLabel,
          keyFingerprint: row.runtimeKeyFingerprint,
          keySelectionReason:
            row.selectionReason ??
            (row.runtimeApiKey
              ? `${row.provider_type}_runtime_key`
              : `${row.provider_type}_configured_provider`),
          consideredProviders:
            runtimeGroups.length > 0 ? runtimeGroups.map((g) => g.provider) : [row.provider_type],
          consideredKeyIndexes: row.consideredKeyIndexes,
          rotationStartIndex: row.rotationStartIndex,
          rotationAdvanced: row.rotationAdvanced,
          cooldownState: isQuota ? "marked" : "inactive",
          providerRequestId: (e as { providerRequestId?: string })?.providerRequestId,
        });
      } catch {
        /* noop */
      }

      if (!row.runtimeApiKey)
        void stampProvider(row.id, false, msg).catch((e) =>
          console.warn("[router] stampProvider failed", e),
        );
      errors.push(`${row.display_name} [${kind}]: ${msg}`);
      fellBackFrom.push(row.provider_type);
      // Scope the fault so the remaining chain skips guaranteed-identical
      // attempts instead of hammering every key against the same dead model.
      if (isModelNotFound) deadProviderModels.add(deadScopeKey(row.provider_type, effectiveModel));
      if (isAuth) deadKeys.add(cooldownIdentityFor(row));
      if (isPayment || isQuota || isModelNotFound) {
        const cooldownReason: CooldownReason = isPayment ? "payment" : isQuota ? "quota" : "rate_limit";
        const retryAfterMs = (e as { retryAfterMs?: number })?.retryAfterMs ?? parseRetryHintMs(msg);
        const cd = markProviderCooldown({
          provider: row.provider_type,
          model: effectiveModel,
          key: cooldownIdentityFor(row),
          reason: cooldownReason,
          message: msg,
          retryAfterMs,
        });
        traceAsync({
          phase: "ai",
          step: "router.cooldown_marked",
          status: "warn",
          provider: row.provider_type,
          model: effectiveModel,
          detail: {
            key: keyLabel,
            retry_after_ms: cd.retryAfterMs,
            reason: cd.reason,
          },
        });
        if (row.provider_type === "groq") {
          const orgMatch = msg.match(/organization[\s`'"]+([a-z0-9_]+)/i);
          const exhaustedOrg = orgMatch?.[1] ?? null;
          const limitKind = isQuota ? parseGroqLimitKind(msg) : "unknown";
          markGroqCoolingDown(opts.model, exhaustedOrg, limitKind);
          if (isQuota && exhaustedOrg) {
            exhaustedOrgs.add(exhaustedOrg);
            if (row.runtimeKeyFingerprint) keyOrgMap.set(row.runtimeKeyFingerprint, exhaustedOrg);
            console.warn(
              `[router.key] cooldown set org=${exhaustedOrg} model=${opts.model ?? "default"} kind=${limitKind}`,
            );
          }
        }
      }
      // Payload-too-large is not a key problem — rotating to the next Groq
      // key with the same oversized payload will fail identically, so
      // short-circuit remaining runtime keys.
      //
      // Quota (HTTP 429) is per-ORGANIZATION at Groq. Extract the org id
      // from the 429 body and only skip subsequent keys already proven to
      // belong to an exhausted org this run. Unknown-org keys are still
      // tried — an extra fast 429 is cheap compared to stalling the
      // pipeline when the next key is a healthy different-org key.
      if (row.runtimeApiKey && isPayload) {
        // Only skip ahead over remaining keys of the SAME provider — a 413
        // from Groq says nothing about Gemini/OpenAI/etc.'s limits, and
        // those later groups deserve a real attempt, not a skip.
        let j = i + 1;
        while (
          j < chain.length &&
          chain[j].runtimeApiKey &&
          chain[j].provider_type === row.provider_type
        )
          j++;
        if (j > i + 1) {
          console.warn(
            `[router.key] skipping ${j - i - 1} remaining ${row.provider_type} key(s) — payload too large is not per-key`,
          );
          i = j - 1;
        }
      } else if (row.runtimeApiKey && isQuota && row.provider_type === "groq") {
        let skipped = 0;
        while (i + 1 < chain.length && chain[i + 1].runtimeApiKey) {
          const nextFp = chain[i + 1].runtimeKeyFingerprint;
          const nextOrg = nextFp ? keyOrgMap.get(nextFp) : undefined;
          if (nextOrg && exhaustedOrgs.has(nextOrg)) {
            i++;
            skipped++;
            continue;
          }
          break;
        }
        if (skipped > 0)
          console.warn(
            `[router.key] skipping ${skipped} runtime key(s) known-attributed to exhausted org(s) [${[...exhaustedOrgs].join(",")}]`,
          );
      }
      // Continue to next Groq key only for per-key auth/network failures.
    }
  }

  // ---------------------------------------------------------------------
  // Compressed retry cascade.
  //
  // The pre-flight size gate skips an undersized provider whenever a
  // full-size one *looks* available. Chain order puts Groq before Gemini, so
  // that decision is made BEFORE Gemini has a chance to fail. When Gemini's
  // daily quota is exhausted, the result is a stage that dies every tick with
  // `never_attempted: [groq]` while a perfectly usable Groq key sits idle.
  //
  // FIX: this used to compress ONCE, to the LARGEST size-skipped budget, and
  // stop — so when the agents stage has Groq (~5.5k tokens) AND OpenRouter
  // (~60k tokens) both size-skipped behind Gemini, a real production failure
  // (Amparo Directo en Revisión / Carlos Alan Espíndola García,
  // authority_notification_validation agent) compressed only far enough to
  // fit OpenRouter, and when OpenRouter's own attempt also failed, the run
  // died — reporting "configured but never attempted: groq, openrouter" even
  // though the user had just added fresh Groq keys specifically to unblock
  // this. Now each pass compresses to the largest skipped budget strictly
  // BELOW the floor already tried (_compressionFloor), cascading down
  // through every tier — Gemini fails full-size -> OpenRouter-sized attempt
  // -> Groq-sized attempt -> only then give up — so a genuinely working key
  // is never left untried just because a wider-budget provider happened to
  // be listed first.
  // ---------------------------------------------------------------------
  {
    const floor = opts._compressionFloor ?? Infinity;
    const nextBudget = nextCompressionBudget(sizeSkippedBudgets, floor);
    if (nextBudget !== undefined) {
      const compressed = fitOptsToBudget(opts, nextBudget);
      traceAsync({
        phase: "ai",
        step: "router.compressed_retry",
        status: "warn",
        model: opts.model ?? null,
        detail: {
          reason: "full_size_providers_failed",
          estimated_input_tokens: estimatedInputTokens,
          target_budget: nextBudget,
          compressed_input_tokens: estimateInputTokens(compressed),
          tried: [...attemptedProviders],
        },
      });
      return routeAI({ ...compressed, _compressionFloor: nextBudget });
    }
  }

  const triedProviders = [...attemptedProviders].join(", ") || "none";
  const chainProviders = [...new Set(chain.map((r) => r.provider_type))];
  const untried = chainProviders.filter((p) => !attemptedProviders.has(p));
  const untriedNote = untried.length
    ? ` (configured but never attempted: ${untried.join(", ")})`
    : "";
  const skipNote = preAttemptSkips.length
    ? ` Skipped before attempt: ${preAttemptSkips.slice(0, 8).join(" | ")}`
    : "";
  // No provider was actually called and at least one was held back by a
  // cooldown: waiting is the only path that can still succeed.
  const allAttemptsSkippedByCooldown =
    attemptedProviders.size === 0 && cooldownSkips.length > 0;
  const soonestCooldownMs = cooldownSkips.reduce<number | null>(
    (min, s) => (min == null ? s.retryAfterMs : Math.min(min, s.retryAfterMs)),
    null,
  );
  traceAsync({
    phase: "ai",
    step: "router.exhausted",
    status: "error",
    model: opts.model ?? null,
    error: `All configured provider keys failed (tried: ${triedProviders})`,
    detail: {
      tried: [...attemptedProviders],
      never_attempted: untried,
      errors: errors.slice(0, 5),
      skipped_before_attempt: preAttemptSkips.slice(0, 8),
      cooldowns: cooldownSkips.slice(0, 8),
    },
  });
  if (allAttemptsSkippedByCooldown) {
    // Rate-limit cooldowns are short-lived. Failing the whole stage the instant
    // every key is cooling down is what makes a run collapse seconds after a
    // single 429. Wait the shortest cooldown out (when the checkpoint budget
    // allows) and try the chain again before giving up.
    const waits = opts._cooldownWaits ?? 0;
    const MAX_COOLDOWN_WAITS = 3;
    const MAX_WAIT_MS = 95_000;
    if (waits < MAX_COOLDOWN_WAITS && soonestCooldownMs != null && soonestCooldownMs <= MAX_WAIT_MS) {
      const waitMs = Math.min(MAX_WAIT_MS, soonestCooldownMs + 1_000);
      let budgetOk = true;
      try {
        assertCheckpointBudget("before provider cooldown wait", waitMs + 5_000);
      } catch (err) {
        if (isCheckpointError(err)) budgetOk = false;
        else throw err;
      }
      if (budgetOk) {
        traceAsync({
          phase: "ai",
          step: "router.cooldown_wait",
          status: "warn",
          model: opts.model ?? null,
          detail: { wait_ms: waitMs, attempt: waits + 1, cooldowns: cooldownSkips.slice(0, 8) },
        });
        await new Promise((res) => setTimeout(res, waitMs));
        return routeAI({ ...opts, _cooldownWaits: waits + 1 });
      }
    }
    // Last resort: never fail a stage with ZERO real provider calls. Cooldowns
    // are an optimisation, not a hard gate — the key may already be healthy
    // (fresh key, different org, expired window). Run the chain once more
    // ignoring cooldowns entirely and let the providers themselves answer.
    if (!opts._ignoreCooldowns) {
      traceAsync({
        phase: "ai",
        step: "router.cooldown_override",
        status: "warn",
        model: opts.model ?? null,
        detail: {
          reason: "zero_attempts_all_cooling",
          cooldowns: cooldownSkips.slice(0, 8),
        },
      });
      return routeAI({ ...opts, _ignoreCooldowns: true });
    }
    const retryText = soonestCooldownMs != null ? ` Retry after ${Math.ceil(soonestCooldownMs / 1000)}s.` : "";
    throw new Error(
      `All configured provider keys are cooling down after HTTP 429/rate-limit responses (tried: none${untriedNote}).${retryText}${skipNote}`,
    );
  }
  // FIX: one real attempt (e.g. Gemini) can fail for its OWN fresh reason
  // (quota) while OTHER configured providers (Groq, OpenRouter) sit on an
  // unrelated, possibly-stale in-memory cooldown from an earlier failure —
  // previously left permanently unreached ("configured but never
  // attempted") because the ignore-cooldowns retry above only fired when
  // attemptedProviders.size === 0. Confirmed live: after the compressed-
  // retry cascade fix (which only covers SIZE-skipped providers), the exact
  // same "tried: gemini ... never attempted: groq, openrouter" stall
  // recurred on a different agent (constitutional_controversy_analysis) —
  // Groq/OpenRouter were cooldown-skipped, not size-skipped, so that fix
  // never reached them either. Give any cooldown-skipped provider one real,
  // cooldown-ignoring shot before giving up, same one-shot guard
  // (_ignoreCooldowns) as the zero-attempts case above.
  if (!opts._ignoreCooldowns && cooldownSkips.length > 0) {
    traceAsync({
      phase: "ai",
      step: "router.cooldown_override",
      status: "warn",
      model: opts.model ?? null,
      detail: {
        reason: "attempted_and_failed_others_cooling",
        tried: [...attemptedProviders],
        cooldowns: cooldownSkips.slice(0, 8),
      },
    });
    return routeAI({ ...opts, _ignoreCooldowns: true });
  }
  throw new Error(
    `All configured provider keys failed (tried: ${triedProviders}${untriedNote}). ${errors.join(" | ")}${skipNote}`,
  );
}
