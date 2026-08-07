// Voice transcription proxy — provider-agnostic STT.
// Accepts multipart/form-data with `file` (audio blob) and an optional
// `language` field ("es" | "en", the UI's current locale toggle).
// Tries every active key across every voice-capable provider the user has
// configured (Groq, OpenAI, Gemini) in priority order — not just Groq — so
// an account with only an OpenAI or Gemini key still works, matching how
// text chat already falls back across providers.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

async function requireAuthedClient(
  request: Request,
): Promise<{ supabase: ReturnType<typeof createClient<Database>>; userId: string } | Response> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return new Response("Server misconfigured", { status: 500 });
  }
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return new Response("Unauthorized", { status: 401 });
  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    return new Response("Unauthorized", { status: 401 });
  }
  return { supabase, userId: data.claims.sub };
}

export const Route = createFileRoute("/api/voice/transcribe")({
  server: {
    handlers: {
      GET: async () => new Response("Method Not Allowed", { status: 405 }),
      POST: async ({ request }) => {
        const authed = await requireAuthedClient(request);
        if (authed instanceof Response) return authed;
        const { supabase, userId } = authed;

        const { resolveVoiceProviderChain, flattenVoiceChain, applyVoiceCooldowns, markVoiceKeyCooldown } =
          await import("@/lib/ai-key-router.server");
        const chain = await resolveVoiceProviderChain(supabase, userId);
        const attempts = applyVoiceCooldowns(flattenVoiceChain(chain));

        // Usage gate — same reasoning as /api/voice/speak: the platform
        // gateway fallback below spends the business's own provider
        // credits when the user has no BYOK key, so it needs the same
        // per-plan ceiling every other AI-backed feature already has.
        const { checkAndConsumeUsage, usageExceededMessage } = await import("@/lib/usage.server");
        const usage = await checkAndConsumeUsage({
          userId,
          kind: "ai_request",
          feature: "voice_transcribe",
          byokActive: chain.userKeyCount > 0,
        });
        if (!usage.allowed) {
          return new Response(
            JSON.stringify({ error: usageExceededMessage("Voice", usage) }),
            { status: 429, headers: { "Content-Type": "application/json" } },
          );
        }

        const incoming = await request.formData();
        const file = incoming.get("file");
        const languageField = incoming.get("language");
        const language = languageField === "en" || languageField === "es" ? languageField : undefined;
        if (!(file instanceof Blob) || file.size < 256) {
          return new Response(JSON.stringify({ error: "Empty or missing audio" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
        if (file.size > MAX_AUDIO_BYTES) {
          return new Response(JSON.stringify({ error: "Audio file too large (max 25 MB)" }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          });
        }

        const mime = (file.type || "audio/webm").split(";")[0];
        const ext =
          mime === "audio/mp4"
            ? "mp4"
            : mime === "audio/mpeg"
              ? "mp3"
              : mime === "audio/wav" || mime === "audio/x-wav"
                ? "wav"
                : mime === "audio/ogg"
                  ? "ogg"
                  : "webm";

        const audioBytes = await file.arrayBuffer();

        const { transcribeAudio, transcribeViaGateway, VoiceProviderError } = await import(
          "@/lib/voice/adapters.server"
        );

        // Try every key across every configured provider in priority order.
        // Only advance on an auth/quota/payment failure — anything else
        // (bad audio, transport error) would fail identically on every key,
        // so surface it immediately instead of burning through the chain.
        let lastStatus = 500;
        let lastMessage = "";
        let lastProvider = "";
        let triedCount = 0;
        const deadProviders = new Set<string>();
        for (let i = 0; i < attempts.length; i++) {
          const { provider, key, keyId } = attempts[i];
          if (deadProviders.has(provider)) continue;
          triedCount++;
          try {
            const text = await transcribeAudio({ provider, apiKey: key, audioBytes, mime, ext, language });
            // An empty string is a soft failure, not a transcript: Gemini
            // returns one when it declines the audio, and returning it as a
            // success made the companion answer "no speech detected" while a
            // perfectly good provider sat unused later in the chain.
            if (text.trim()) return Response.json({ text });
            lastStatus = 502;
            lastMessage = `${provider} returned an empty transcript`;
            lastProvider = provider;
            console.warn(`[voice/transcribe] ${provider} key ${i} returned nothing, trying next`);
            continue;

          } catch (err) {
            lastProvider = provider;
            if (err instanceof VoiceProviderError) {
              lastStatus = err.status;
              lastMessage = err.message;
              markVoiceKeyCooldown(provider, keyId, key, err.status);
              if (err.rotatable) {
                console.warn(`[voice/transcribe] ${provider} key ${i} failed (${err.status}), trying next`);
                continue;
              }
              // Non-rotatable = this provider can't serve THIS request at
              // all; its other keys would fail identically, but another
              // provider still can. Skip the provider, not the whole chain.
              deadProviders.add(provider);
              console.warn(`[voice/transcribe] ${provider} failed hard (${err.status}); skipping its remaining keys`);
              continue;
            }
            lastMessage = err instanceof Error ? err.message : String(err);
            break;
          }
        }


        // Last resort: the platform gateway, so dictation keeps working when
        // the attorney's own keys are quota-exhausted or revoked.
        let gatewayError = "";
        try {
          const text = await transcribeViaGateway({ audioBytes, mime, ext, language });
          if (text.trim()) {
            console.warn("[voice/transcribe] served via platform gateway fallback");
            return Response.json({ text });
          }
        } catch (err) {
          gatewayError = err instanceof Error ? err.message : String(err);
          console.warn(`[voice/transcribe] gateway fallback failed: ${gatewayError}`);
        }

        if (attempts.length === 0) {
          return new Response(
            JSON.stringify({
              error: "No voice-capable AI provider configured",
              detail: "Add a Groq, OpenAI, or Gemini key in Admin \u2192 AI Providers to use voice.",
              diag: { userKeyCount: chain.userKeyCount, hasPlatform: chain.hasPlatform, gatewayError },
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            error: `STT ${lastStatus}`,
            detail: lastMessage.slice(0, 500),
            diag: {
              userKeyCount: chain.userKeyCount,
              providersTried: [...new Set(attempts.slice(0, triedCount).map((a) => a.provider))],
              triedCount,
              lastProvider,
              gatewayError,
            },
          }),
          { status: lastStatus, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
