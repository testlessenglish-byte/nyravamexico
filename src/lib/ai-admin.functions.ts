// Admin-only server functions for AI provider management.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import type { ProviderType, AITask } from "./ai/providers/types";

async function assertAdmin(context: { userId: string }) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Admin access required");
}

const PROVIDER_TYPES: ProviderType[] = ["groq", "gemini", "openai", "openrouter", "anthropic", "ollama", "lmstudio"];
const TASKS: AITask[] = ["extraction", "analysis", "reasoning", "report", "chat"];
const SUPPORTED_SECRETS = [
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;
type AiProviderInsert = Database["public"]["Tables"]["ai_providers"]["Insert"];

function encryptApiKey(value: string): string {
  const secret = process.env.AI_PROVIDER_ENCRYPTION_KEY;
  if (!secret) throw new Error("AI provider key storage is not configured");
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

// ---- LIST ----
export const listAiProviders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("ai_providers")
      .select(
        "id,provider_type,display_name,enabled,priority,base_url,default_model,secret_name,last_ok_at,last_error_at,last_error,api_key_encrypted",
      )
      .order("priority", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(({ api_key_encrypted, ...row }: any) => ({
      ...row,
      has_api_key: Boolean(api_key_encrypted),
    }));
  });

const UpsertSchema = z.object({
  id: z.string().uuid().optional(),
  provider_type: z.enum(PROVIDER_TYPES as [ProviderType, ...ProviderType[]]),
  display_name: z.string().min(1).max(80),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(10000),
  base_url: z.string().url().nullable().optional(),
  default_model: z.string().min(1).max(200).nullable().optional(),
  secret_name: z.string().min(1).max(80).nullable().optional(),
  api_key: z.string().max(10000).nullable().optional(),
  clear_api_key: z.boolean().optional(),
});

export const upsertAiProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => UpsertSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const row: AiProviderInsert = {
      provider_type: data.provider_type,
      display_name: data.display_name,
      enabled: data.enabled,
      priority: data.priority,
      base_url: data.base_url ?? null,
      default_model: data.default_model ?? null,
      secret_name: data.secret_name ?? null,
    };
    if (data.clear_api_key) row.api_key_encrypted = null;
    else if (data.api_key?.trim()) row.api_key_encrypted = encryptApiKey(data.api_key.trim());
    const { logAudit } = await import("./audit.server");
    if (data.id) {
      const { error } = await supabaseAdmin.from("ai_providers").update(row).eq("id", data.id);
      if (error) throw new Error(error.message);
      await logAudit({
        actorId: context.userId,
        action: "provider_key_edited",
        target: data.id,
        meta: {
          provider_type: data.provider_type,
          display_name: data.display_name,
          key_changed: Boolean(data.api_key?.trim()) || Boolean(data.clear_api_key),
          key_cleared: Boolean(data.clear_api_key),
          enabled: data.enabled,
        },
      });
      return { id: data.id };
    }
    const { data: ins, error } = await supabaseAdmin.from("ai_providers").insert(row).select("id").single();
    if (error) throw new Error(error.message);
    await logAudit({
      actorId: context.userId,
      action: "provider_created",
      target: ins.id,
      meta: {
        provider_type: data.provider_type,
        display_name: data.display_name,
        has_key: Boolean(data.api_key?.trim()),
      },
    });
    return { id: ins.id };
  });

export const deleteAiProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("ai_providers").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    const { logAudit } = await import("./audit.server");
    await logAudit({ actorId: context.userId, action: "provider_deleted", target: data.id, meta: {} });
    return { ok: true };
  });

export const toggleAiProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("ai_providers").update({ enabled: data.enabled }).eq("id", data.id);
    if (error) throw new Error(error.message);
    const { logAudit } = await import("./audit.server");
    await logAudit({
      actorId: context.userId,
      action: "provider_toggled",
      target: data.id,
      meta: { enabled: data.enabled },
    });
    return { ok: true };
  });

export const reorderAiProviders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ ids: z.array(z.string().uuid()) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    for (let i = 0; i < data.ids.length; i++) {
      const { error } = await supabaseAdmin
        .from("ai_providers")
        .update({ priority: (i + 1) * 10 })
        .eq("id", data.ids[i]);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

// ---- TEST (Live Provider Probe) ----
// Probes credentials via the SAME resolution path production uses:
//   resolveProviderKeys(user, provider) → user_ai_keys rows → runtime keys.
// The old path probed ai_providers.api_key_encrypted, which the router
// bypasses whenever runtime keys are supplied — that produced the 401 vs
// 429 mismatch the operator was seeing (probe hit a stale encrypted key,
// production hit the fresh per-user key set).
//
// Every key is probed in priority order; invalid keys are reported and
// skipped, so a single dead backup key can no longer poison the result.
// Per-key output includes masked prefix/suffix, index, org (from Groq
// response headers), model, and provider request id.
export const testAiProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("ai_providers")
      .select("id,provider_type,display_name,enabled,priority,base_url,default_model,secret_name,api_key_encrypted")
      .eq("id", data.id)
      .single();
    if (error || !row) throw new Error(error?.message ?? "Provider not found");

    const { resolveProviderKeys, maskKey } = await import("./ai-key-router.server");
    const { buildProvider } = await import("./ai/providers/factory");

    // Same source-of-truth the pipeline uses. The pipeline runs as the Case Owner;
    // to accurately test if the baseline system is healthy for a user without
    // their own keys, we probe the global/fallback keys, NOT the Admin's personal keys.
    const { keys, userKeyCount, hasPlatform } = await resolveProviderKeys(
      supabaseAdmin as never,
      "00000000-0000-0000-0000-000000000000",
      row.provider_type as never,
    );

    type PerKey = {
      keyIndex: number;
      source: "user_ai_keys" | "platform_env" | "ai_providers_stored";
      masked: string;
      keyPrefix: string;
      keySuffix: string;
      ok: boolean;
      latencyMs: number;
      error?: string;
      organization?: string;
      requestId?: string;
      model?: string;
    };
    const perKey: PerKey[] = [];
    const seen = new Set<string>();

    async function probeKey(k: string, keyIndex: number, source: PerKey["source"]) {
      if (seen.has(k)) return;
      seen.add(k);
      // Build via the factory so each provider family is probed with its own
      // adapter (Gemini/Anthropic are NOT OpenAI-compatible).
      const provider = buildProvider(row as never, k);
      const r = await provider.testConnection();
      const prefix = k.slice(0, 8);
      const suffix = k.slice(-6);
      const entry: PerKey = {
        keyIndex,
        source,
        masked: maskKey(k),
        keyPrefix: prefix,
        keySuffix: suffix,
        ok: r.ok,
        latencyMs: r.latencyMs,
        error: r.ok ? undefined : r.error,
        organization: r.organization,
        requestId: r.requestId,
        model: r.model,
      };
      console.info(
        `[probe.key] source=${source} keyIndex=${keyIndex} prefix=${prefix} suffix=${suffix} ` +
          `ok=${r.ok} org=${r.organization ?? "-"} model=${r.model ?? "-"} ` +
          `latencyMs=${r.latencyMs}${r.ok ? "" : ` err=${(r.error ?? "").slice(0, 160)}`}`,
      );
      perKey.push(entry);
    }

    // Probe every user_ai_keys entry in order (skipping invalid, not stopping).
    for (let i = 0; i < keys.length; i++) {
      const src: PerKey["source"] = userKeyCount > 0 && i < userKeyCount ? "user_ai_keys" : "platform_env";
      await probeKey(keys[i], i, src);
    }

    // Also probe the ai_providers row's stored key when present — this is the
    // credential the legacy probe used, kept here purely for diagnostic parity
    // so operators can see explicitly whether it matches the active user key set.
    if (row.api_key_encrypted) {
      const { resolveApiKey } = await import("./ai/providers/factory");
      const legacyKey = resolveApiKey(row as never);
      if (legacyKey && !seen.has(legacyKey)) {
        await probeKey(legacyKey, perKey.length, "ai_providers_stored");
      }
    }

    const anyOk = perKey.some((p) => p.ok);
    const firstOk = perKey.find((p) => p.ok);
    const firstErr = perKey.find((p) => !p.ok);
    const patch = anyOk
      ? { last_ok_at: new Date().toISOString(), last_error: null }
      : {
          last_error_at: new Date().toISOString(),
          last_error: (firstErr?.error ?? "no keys configured").slice(0, 500),
        };
    await supabaseAdmin.from("ai_providers").update(patch).eq("id", data.id);

    return {
      // Legacy shape (kept for backwards compat with existing UI):
      ok: anyOk,
      latencyMs: firstOk?.latencyMs ?? firstErr?.latencyMs ?? 0,
      error: anyOk ? undefined : (firstErr?.error ?? `No ${row.provider_type} keys configured`),
      // New diagnostic block — identical credential resolution to production.
      diagnostics: {
        credentialSource: userKeyCount > 0 ? "user_ai_keys" : hasPlatform ? "platform_env" : "none",
        userKeyCount,
        hasPlatformFallback: hasPlatform,
        keysProbed: perKey.length,
        keysHealthy: perKey.filter((p) => p.ok).length,
        keysFailed: perKey.filter((p) => !p.ok).length,
        organizations: Array.from(new Set(perKey.map((p) => p.organization).filter(Boolean))),
        perKey,
      },
    };
  });

// ---- TASK ROUTING ----
export const listTaskRoutes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("ai_task_routing").select("*");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const setTaskRoute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        task: z.enum(TASKS as [AITask, ...AITask[]]),
        provider_id: z.string().uuid().nullable(),
        model: z.string().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (data.provider_id === null) {
      const { error } = await supabaseAdmin.from("ai_task_routing").delete().eq("task", data.task);
      if (error) throw new Error(error.message);
      return { ok: true };
    }
    const row = { task: data.task, provider_id: data.provider_id, model: data.model ?? null };
    const { error } = await supabaseAdmin.from("ai_task_routing").upsert(row, { onConflict: "task" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---- SECRETS STATUS (booleans only) ----
export const getAiSecretStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const out: Record<string, boolean> = {};
    for (const name of SUPPORTED_SECRETS) out[name] = Boolean(process.env[name]);
    return out;
  });

// ---- HEALTH AGGREGATE ----
export const getAiProviderHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: usage } = await supabaseAdmin
      .from("ai_usage")
      .select("provider_type,model,total_tokens,input_tokens,output_tokens,latency_ms,success,created_at")
      .gte("created_at", since)
      .limit(2000);
    const { PRICING } = await import("./ai/pricing");
    const groups: Record<
      string,
      {
        calls: number;
        ok: number;
        err: number;
        latencySum: number;
        inputTokens: number;
        outputTokens: number;
        cost: number;
        currentModel?: string;
      }
    > = {};
    for (const u of (usage ?? []) as any[]) {
      const k = (u.provider_type ?? "unknown") as ProviderType;
      const g = (groups[k] ??= { calls: 0, ok: 0, err: 0, latencySum: 0, inputTokens: 0, outputTokens: 0, cost: 0 });
      g.calls++;
      if (u.success) g.ok++;
      else g.err++;
      g.latencySum += u.latency_ms ?? 0;
      const inT = u.input_tokens ?? 0;
      const outT = u.output_tokens ?? 0;
      g.inputTokens += inT;
      g.outputTokens += outT;
      const price = PRICING[k as ProviderType];
      if (price) g.cost += (inT / 1_000_000) * price.input + (outT / 1_000_000) * price.output;
      if (u.model && !g.currentModel) g.currentModel = u.model;
    }
    return groups;
  });
