// Regression tests for the 2026-09-18 production incident: Legal Analyzers
// checkpoint/tick loop.
//
// Two distinct defects are covered here:
//   1. Failure taxonomy — a provider/model-scoped fault (HTTP 404
//      model_not_found) or a key-scoped fault (401/403) must not be retried
//      against every remaining key of the same provider. Groq's configured
//      model returns 404 in production; the router used to walk all three
//      Groq keys against it before failing over.
//   2. A cooling-down provider must never cost the stage its budget while a
//      healthy provider exists — the router must route around it immediately
//      instead of scheduling a wait that cannot fit the stage deadline.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ai/providers/factory", () => ({
  buildProvider: vi.fn(),
  resolveApiKey: vi.fn(() => null),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn() },
}));

vi.mock("@/lib/canonical/encryption.server", () => ({
  decryptKey: (k: string) => k,
}));

import { buildProvider } from "@/lib/ai/providers/factory";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { routeAI, invalidateProviderCaches } from "@/lib/ai/router.server";
import { clearProviderCooldowns, markProviderCooldown } from "@/lib/ai/cooldown.server";
import { withCheckpointScope } from "@/lib/pipeline-checkpoint.server";
import { createHash } from "node:crypto";

function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

let n = 0;
function freshKeys() {
  n += 1;
  return {
    groq: [`tax-groq-${n}-a`, `tax-groq-${n}-b`, `tax-groq-${n}-c`],
    gemini: [`tax-gemini-${n}-a`, `tax-gemini-${n}-b`],
  };
}

function chain(value: unknown) {
  const c: Record<string, unknown> = {
    select: () => c,
    eq: () => c,
    order: () => c,
    then: (resolve: (v: unknown) => void) => resolve({ data: value, error: null }),
  };
  return c;
}

function mockSupabase(keys: { groq: string[]; gemini: string[] }) {
  const rows = [
    ...keys.groq.map((k, i) => ({
      provider: "groq",
      encrypted_key: k,
      is_active: true,
      created_at: `2026-01-0${i + 1}T00:00:00Z`,
    })),
    ...keys.gemini.map((k, i) => ({
      provider: "gemini",
      encrypted_key: k,
      is_active: true,
      created_at: `2026-02-0${i + 1}T00:00:00Z`,
    })),
  ];
  vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    if (table === "ai_providers") return chain([]) as never;
    if (table === "user_ai_keys") return chain(rows) as never;
    throw new Error(`unexpected table: ${table}`);
  });
}

function mockProviders(behavior: Record<string, () => Error>, calls: string[]) {
  vi.mocked(buildProvider).mockImplementation((row, apiKeyOverride) => {
    const key = apiKeyOverride ?? "(env)";
    return {
      type: row.provider_type,
      capabilities: {
        jsonMode: true,
        reasoning: false,
        streaming: false,
        toolCalling: false,
        vision: false,
        maxContextTokens: 100_000,
      },
      chat: async () => {
        calls.push(key);
        const fail = behavior[key];
        if (fail) throw fail();
        return { text: `ok:${key}`, model: `${row.provider_type}-model`, latencyMs: 3 };
      },
      testConnection: async () => ({ ok: true, latencyMs: 1 }),
    } as never;
  });
}

beforeEach(() => {
  invalidateProviderCaches();
  clearProviderCooldowns();
  vi.mocked(buildProvider).mockReset();
});

describe("router failure taxonomy", () => {
  it("MODEL_NOT_FOUND abandons the provider instead of hammering every key with the same dead model", async () => {
    const k = freshKeys();
    mockSupabase(k);
    const calls: string[] = [];
    const notFound = () =>
      new Error('HTTP 404: {"error":{"message":"The model `x` does not exist or you do not have access to it."}}');
    mockProviders(Object.fromEntries(k.groq.map((key) => [key, notFound])), calls);

    const res = await routeAI({
      userContent: `taxonomy 404 ${n}`,
      userId: `user-tax-${n}`,
      cache: false,
    });

    const groqCalls = calls.filter((c) => k.groq.includes(c));
    expect(groqCalls).toHaveLength(1); // not 3
    expect(res.text).toMatch(/^ok:tax-gemini/);
  });

  it("KEY_INVALID retires only that key and keeps the sibling key of the same provider", async () => {
    const k = freshKeys();
    mockSupabase(k);
    const calls: string[] = [];
    mockProviders(
      { [k.gemini[0]]: () => new Error("HTTP 401 invalid_api_key") },
      calls,
    );

    const res = await routeAI({
      userContent: `taxonomy 401 ${n}`,
      userId: `user-tax-${n}`,
      model: "gemini-flash-latest",
      cache: false,
    });

    // The rejected key is attempted at most once, never re-tried in the chain.
    expect(calls.filter((c) => c === k.gemini[0]).length).toBeLessThanOrEqual(1);
    expect(res.text).toMatch(/^ok:/);
  });

  it("routes around a cooling-down provider immediately instead of waiting out a cooldown that cannot fit the stage budget", async () => {
    const k = freshKeys();
    mockSupabase(k);
    const calls: string[] = [];
    mockProviders({}, calls);

    // Groq keys all cooling for 46s; the analyzers stage has ~45s total.
    for (const key of k.groq) {
      markProviderCooldown({
        provider: "groq",
        key: keyFingerprint(key),
        reason: "rate_limit",
        message: "HTTP 429 rate limit exceeded",
        retryAfterMs: 46_000,
      });
    }

    const startedAt = Date.now();
    const res = await withCheckpointScope(
      { stage: "analyzers", deadlineAt: Date.now() + 45_000 },
      () =>
        routeAI({
          userContent: `cooldown routing ${n}`,
          userId: `user-tax-${n}`,
          cache: false,
        }),
    );

    expect(res.text).toMatch(/^ok:tax-gemini/);
    expect(Date.now() - startedAt).toBeLessThan(5_000); // no 46s wait
    expect(calls.some((c) => k.groq.includes(c))).toBe(false);
  });
});
