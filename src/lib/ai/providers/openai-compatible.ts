// Shared OpenAI-compatible provider used by Groq, OpenRouter, OpenAI, Ollama,
// and LM Studio. Provider-specific tweaks (headers, default URL) are passed in.

import { createHash } from "node:crypto";
import {
  AIProvider, ChatOpts, ChatResult, ProviderConfig, ProviderConfigError,
  PROVIDER_DEFAULTS, PROVIDER_TIMEOUT_MS, withTimeout, buildOAIMessages,
} from "./types";
import { withCapabilities } from "./capabilities";
import { aiCallTimeoutForCheckpoint, assertCheckpointBudget } from "../../pipeline-checkpoint.server";
import { currentTelemetryScope } from "../telemetry.server";
import { traceAsync } from "../../pipeline-trace.server";

export interface OAICompatOpts {
  requiresKey: boolean;
  extraHeaders?: Record<string, string>;
  /** Skip the `Authorization: Bearer <key>` header (gateways with custom auth headers). */
  suppressAuthorization?: boolean;
}

export function makeOpenAICompatible(cfg: ProviderConfig, opts: OAICompatOpts): AIProvider {
  const baseUrl = (cfg.baseUrl ?? PROVIDER_DEFAULTS[cfg.type].baseUrl).replace(/\/+$/, "");
  const defaultModel = cfg.defaultModel ?? PROVIDER_DEFAULTS[cfg.type].model;
  const key = cfg.apiKey ?? "";

  if (opts.requiresKey && !key) {
    return withCapabilities({
      type: cfg.type,
      async chat() { throw new ProviderConfigError(`${cfg.type}: API key not configured`); },
      async testConnection() { return { ok: false, latencyMs: 0, error: "API key not configured" }; },
    });
  }

  const retryAfterHeaderMs = (value: string | null): number | undefined => {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) return Math.max(1000, dateMs - Date.now());
    return undefined;
  };

  async function rawCall(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatResult> {
    const model = String(body.model);
    const t0 = Date.now();
    assertCheckpointBudget(`before ${cfg.type} fetch ${model}`);
    const scopedTimeoutMs = aiCallTimeoutForCheckpoint(`${cfg.type} fetch ${model}`);
    const requestedTimeoutMs = Number(body.__timeoutMs ?? scopedTimeoutMs ?? PROVIDER_TIMEOUT_MS);
    const timeoutMs = Math.max(1_000, Math.min(requestedTimeoutMs, PROVIDER_TIMEOUT_MS));
    delete body.__timeoutMs;
    const to = withTimeout(signal, timeoutMs);
    const aiCallId = `${cfg.type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const promptSha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const engine = currentTelemetryScope()?.replay?.engine;
    let res: Response;
    try {
      traceAsync({
        phase: "ai",
        step: "provider.request",
        status: "start",
        provider: cfg.type,
        model,
        detail: { ai_call_id: aiCallId, engine: typeof engine === "string" ? engine : null, prompt_sha256: promptSha256 },
      });
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key && !opts.suppressAuthorization ? { Authorization: `Bearer ${key}` } : {}),
          ...(opts.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal: to.signal,
      });
    } catch (e) {
      to.cancel();
      const message = to.timedOut()
        ? `${cfg.type} timed out after ${timeoutMs}ms`
        : (e instanceof Error ? e.message : String(e));
      traceAsync({
        phase: "ai",
        step: "provider.request",
        status: "error",
        provider: cfg.type,
        model,
        durationMs: Date.now() - t0,
        error: message,
        detail: { ai_call_id: aiCallId, engine: typeof engine === "string" ? engine : null, prompt_sha256: promptSha256 },
      });
      throw new Error(message);
    }
    to.cancel();
    // No post-fetch checkpoint assertion: a completed response must never be
    // discarded because the tick budget expired mid-call — see router.server.ts.
    const latencyMs = Date.now() - t0;
    // Capture provider-reported request id when present. OpenAI returns
    // `x-request-id`; OpenRouter returns `x-request-id`; Groq returns
    // `x-request-id` too. Anthropic uses `request-id`. If a provider omits
    // it entirely we record undefined — never fabricated.
    const providerRequestId =
      res.headers.get("x-request-id") ??
      res.headers.get("request-id") ??
      res.headers.get("openai-request-id") ??
      undefined;
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 500);

      if (res.status === 404 || /model_not_found|does not exist/i.test(text)) {
        try {
          const mRes = await fetch(`${baseUrl}/models`, {
            headers: {
              ...(key && !opts.suppressAuthorization ? { Authorization: `Bearer ${key}` } : {}),
              ...(opts.extraHeaders ?? {}),
            },
            signal: withTimeout(undefined, 5000).signal,
          });
          if (mRes.ok) {
            const mJson = (await mRes.json()) as { data?: Array<{ id: string }> };
            if (mJson.data && Array.isArray(mJson.data) && mJson.data.length > 0) {
              const available = mJson.data.map((m) => m.id);
              const isLlama = model.toLowerCase().includes("llama");
              const suggested =
                available.find((id) => isLlama && id.toLowerCase().includes("llama") && id.includes("70b")) ||
                available.find((id) => isLlama && id.toLowerCase().includes("llama")) ||
                available[0];
              console.warn(`[openai-compatible] auto-healing from ${model} to ${suggested}`);
              return await rawCall({ ...body, model: suggested }, signal);
            }
          }
        } catch {
          /* ignore heal error */
        }
      }

      const err = new Error(`${cfg.type} HTTP ${res.status}: ${text}`);
      (err as unknown as { providerRequestId?: string; retryAfterMs?: number }).providerRequestId = providerRequestId ?? undefined;
      (err as unknown as { providerRequestId?: string; retryAfterMs?: number }).retryAfterMs = retryAfterHeaderMs(
        res.headers.get("retry-after"),
      );
      traceAsync({
        phase: "ai",
        step: "provider.request",
        status: "error",
        provider: cfg.type,
        model,
        durationMs: latencyMs,
        error: err.message,
        detail: {
          ai_call_id: aiCallId,
          engine: typeof engine === "string" ? engine : null,
          prompt_sha256: promptSha256,
          http_status: res.status,
          retry_after_ms: (err as unknown as { retryAfterMs?: number }).retryAfterMs ?? null,
          provider_request_id: providerRequestId ?? null,
        },
      });
      throw err;
    }
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      id?: string;
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    if (!text) {
      const fr = json.choices?.[0]?.finish_reason ?? "no choices";
      throw new Error(`${cfg.type}: empty response (finish_reason=${fr}, model=${model})`);
    }
    traceAsync({
      phase: "ai",
      step: "provider.request",
      status: "ok",
      provider: cfg.type,
      model,
      durationMs: latencyMs,
      detail: {
        ai_call_id: aiCallId,
        engine: typeof engine === "string" ? engine : null,
        prompt_sha256: promptSha256,
        input_tokens: json.usage?.prompt_tokens ?? null,
        output_tokens: json.usage?.completion_tokens ?? null,
        total_tokens: json.usage?.total_tokens ?? null,
        provider_request_id: providerRequestId ?? json.id ?? null,
      },
    });
    return {
      text,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens,
      latencyMs, model,
      providerRequestId: providerRequestId ?? json.id ?? undefined,
    };
  }


  return withCapabilities({
    type: cfg.type,
    async chat(o: ChatOpts) {
      const body: Record<string, unknown> = {
        model: o.model ?? defaultModel,
        messages: buildOAIMessages(o),
        temperature: o.temperature ?? 0.2,
      };
      if (o.timeoutMs) body.__timeoutMs = o.timeoutMs;
      if (o.maxTokens) body.max_tokens = Math.min(o.maxTokens, 8192);
      if (o.json) body.response_format = { type: "json_object" };
      try {
        return await rawCall(body, o.signal);
      } catch (e) {
        // OpenRouter retires `:free` slugs and answers 404 with the live slug
        // to use instead ("use this slug instead: vendor/model"). A stale slug
        // in the DB row would otherwise burn an attempt on every single AI
        // call for the whole run — self-heal by retrying once with the slug
        // the provider itself named.
        const msg = e instanceof Error ? e.message : String(e);
        let suggested = /HTTP 404/.test(msg)
          ? msg.match(/use this slug instead:\s*([A-Za-z0-9._\-/:]+)/i)?.[1]
          : undefined;

        if (!suggested && /HTTP 404|model_not_found|does not exist/i.test(msg)) {
          try {
            const mRes = await fetch(`${baseUrl}/models`, {
              headers: {
                ...(key && !opts.suppressAuthorization ? { Authorization: `Bearer ${key}` } : {}),
                ...(opts.extraHeaders ?? {}),
              },
              signal: withTimeout(undefined, 5000).signal,
            });
            if (mRes.ok) {
              const mJson = (await mRes.json()) as { data?: Array<{ id: string }> };
              if (mJson.data && Array.isArray(mJson.data) && mJson.data.length > 0) {
                const available = mJson.data.map((m) => m.id);
                const current = String(body.model);
                const isLlama = current.toLowerCase().includes("llama");
                suggested =
                  available.find((id) => isLlama && id.toLowerCase().includes("llama") && id.includes("70b")) ||
                  available.find((id) => isLlama && id.toLowerCase().includes("llama")) ||
                  available[0];
                console.warn(
                  `[provider] ${cfg.type} model ${current} retired/missing, auto-healed to ${suggested}`,
                );
              }
            }
          } catch (healErr) {
            console.warn(`[provider] failed to auto-heal ${cfg.type} model:`, healErr);
          }
        }

        if (!suggested || suggested === body.model) throw e;
        return rawCall({ ...body, model: suggested }, o.signal);
      }
    },
    async testConnection() {
      const t0 = Date.now();
      // Validate using a minimal chat completion against the SAME endpoint
      // the runtime uses. /models is unreliable across providers (Groq keys
      // with scoped permissions return 401/403 on /models but work fine for
      // chat completions). Capture provider org + request-id headers so the
      // probe result can be cross-checked against production telemetry.
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key && !opts.suppressAuthorization ? { Authorization: `Bearer ${key}` } : {}),
            ...(opts.extraHeaders ?? {}),
          },
          body: JSON.stringify({
            model: defaultModel,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            temperature: 0,
          }),
          signal: withTimeout(undefined, 10000).signal,
        });
        const organization =
          res.headers.get("x-groq-organization") ??
          res.headers.get("openai-organization") ??
          res.headers.get("x-organization") ??
          res.headers.get("x-organization-id") ??
          undefined;
        const requestId =
          res.headers.get("x-request-id") ??
          res.headers.get("request-id") ??
          undefined;
        if (res.ok) return { ok: true, latencyMs: Date.now() - t0, organization, requestId, model: defaultModel };
        const body = (await res.text().catch(() => "")).slice(0, 400);

        if (res.status === 404 || /model_not_found|does not exist/i.test(body)) {
          try {
            const mRes = await fetch(`${baseUrl}/models`, {
              headers: {
                ...(key && !opts.suppressAuthorization ? { Authorization: `Bearer ${key}` } : {}),
                ...(opts.extraHeaders ?? {}),
              },
              signal: withTimeout(undefined, 5000).signal,
            });
            if (mRes.ok) {
              const mJson = (await mRes.json()) as { data?: Array<{ id: string }> };
              if (mJson.data && Array.isArray(mJson.data) && mJson.data.length > 0) {
                const available = mJson.data.map((m) => m.id);
                const isLlama = defaultModel.toLowerCase().includes("llama");
                const suggested =
                  available.find((id) => isLlama && id.toLowerCase().includes("llama") && id.includes("70b")) ||
                  available.find((id) => isLlama && id.toLowerCase().includes("llama")) ||
                  available[0];
                return {
                  ok: true,
                  latencyMs: Date.now() - t0,
                  organization,
                  requestId,
                  model: suggested,
                  error: `Configured model missing (${defaultModel}); auto-healed to ${suggested}`,
                };
              }
            }
          } catch {
            /* ignore heal error */
          }
        }

        return {
          ok: false,
          latencyMs: Date.now() - t0,
          error: `HTTP ${res.status}${body ? `: ${body}` : ""}`,
          organization,
          requestId,
          model: defaultModel,
        };
      } catch (e) {
        return { ok: false, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
