// Voice text-to-speech proxy — provider-agnostic TTS.
// Body: { text: string, voice?: string, locale?: "es" | "en" }
// Returns audio/wav bytes.
//
// Tries every active key across every voice-capable provider the user has
// configured (Groq, OpenAI, Gemini) in priority order, same rotation
// contract as text chat's routeAI(). Groq's Orpheus model is English-only,
// so when locale is "es" it's tried last rather than first (see
// reorderForTtsLocale in adapters.server.ts) — otherwise a Spanish reply
// would go to a model that can't speak Spanish before ever reaching a
// provider that can.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// Per-request input caps differ wildly by provider. Groq/Orpheus caps at
// ~200 chars, so it needs many small requests; OpenAI and Gemini happily
// take a paragraph at a time. Chunking everyone at Groq's limit turned a
// single 1,200-char answer into ~7 sequential provider calls, which is
// where the "works at first, dies later" behaviour came from: seven times
// the latency and seven independent chances to hit a quota wall mid-answer.
const PROVIDER_CHUNK_LIMIT: Record<string, number> = {
  groq: 180,
  openai: 1800,
  gemini: 1200,
};
const GATEWAY_CHUNK_LIMIT = 1800;
const FALLBACK_CHUNK_LIMIT = 180;

// How many chunks of one answer are synthesized at the same time. Bounded so
// a long answer doesn't fire a dozen simultaneous requests at one key and
// trip its rate limit — which would cost more latency than it saves.
const TTS_CONCURRENCY = 3;

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}



function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cut = -1;
    for (const boundary of [". ", "! ", "? ", "; ", ", ", " "]) {
      const idx = remaining.lastIndexOf(boundary, maxLen);
      if (idx > 0) {
        cut = idx + boundary.length;
        break;
      }
    }
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks;
}

// WAV headers are not a fixed 44 bytes — OpenAI and some encoders insert
// LIST/INFO chunks before `data`, so a hardcoded 44 slices real audio off
// the front of every chunk (audible clicks) or, worse, treats metadata as
// samples. Locate the actual `data` chunk instead.
function wavDataOffset(buf: ArrayBuffer): number {
  const view = new DataView(buf);
  // RIFF header is 12 bytes, then a sequence of {id:4, size:4, payload}.
  let pos = 12;
  while (pos + 8 <= buf.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(pos),
      view.getUint8(pos + 1),
      view.getUint8(pos + 2),
      view.getUint8(pos + 3),
    );
    const size = view.getUint32(pos + 4, true);
    if (id === "data") return pos + 8;
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  return 44; // not a WAV we understand — fall back to the common case
}

// Concatenate same-format WAV buffers into one playable WAV by keeping the
// first file's header and appending everyone's PCM data, then rewriting the
// RIFF/data sizes. Only ever called with buffers from a SINGLE provider —
// mixing providers here would splice together different sample rates and
// produce chipmunk/slow-motion audio partway through an answer.
function concatWav(buffers: ArrayBuffer[]): ArrayBuffer {
  if (buffers.length === 1) return buffers[0];
  const firstDataAt = wavDataOffset(buffers[0]);
  const dataParts = buffers.map((b) => b.slice(wavDataOffset(b)));
  const totalDataLen = dataParts.reduce((sum, b) => sum + b.byteLength, 0);

  const header = new Uint8Array(buffers[0].slice(0, firstDataAt));
  const out = new Uint8Array(firstDataAt + totalDataLen);
  out.set(header, 0);
  let offset = firstDataAt;
  for (const part of dataParts) {
    out.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }

  const view = new DataView(out.buffer);
  view.setUint32(4, firstDataAt - 8 + totalDataLen, true); // RIFF size
  view.setUint32(firstDataAt - 4, totalDataLen, true); // data chunk size
  return out.buffer;
}


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

export const Route = createFileRoute("/api/voice/speak")({
  server: {
    handlers: {
      GET: async () => new Response("Method Not Allowed", { status: 405 }),
      POST: async ({ request }) => {
        const authed = await requireAuthedClient(request);
        if (authed instanceof Response) return authed;
        const { supabase, userId } = authed;

        const { resolveVoiceProviderChain, flattenVoiceChain, applyVoiceCooldowns, markVoiceKeyCooldown } =
          await import("@/lib/ai-key-router.server");
        const { speakText, speakViaGateway, reorderForTtsLocale, VoiceProviderError } = await import(
          "@/lib/voice/adapters.server"
        );


        const { text, voice, locale } = (await request.json().catch(() => ({}))) as {
          text?: string;
          voice?: string;
          locale?: string;
        };
        const language = locale === "en" || locale === "es" ? locale : undefined;

        const chain = await resolveVoiceProviderChain(supabase, userId);
        let attempts = flattenVoiceChain(chain);
        attempts = applyVoiceCooldowns(reorderForTtsLocale(attempts, language));

        // Usage gate — the platform-gateway fallback below spends the
        // business's own provider credits, not the user's. Without this,
        // an authenticated account with no BYOK key configured could call
        // this endpoint in an unbounded loop and run up real TTS cost with
        // no ceiling, unlike every other AI-backed feature in the app.
        const { checkAndConsumeUsage, usageExceededMessage } = await import("@/lib/usage.server");
        const usage = await checkAndConsumeUsage({
          userId,
          kind: "ai_request",
          feature: "voice_speak",
          byokActive: chain.userKeyCount > 0,
        });
        if (!usage.allowed) {
          return new Response(
            JSON.stringify({ error: usageExceededMessage("Voice", usage) }),
            { status: 429, headers: { "Content-Type": "application/json" } },
          );
        }

        const cleaned = (text ?? "").trim();
        if (!cleaned) return new Response("Empty text", { status: 400 });

        const input = cleaned.slice(0, 3000);
        const resolvedVoice = voice || "alloy";

        let lastStatus = 500;
        let lastMessage = "";
        let lastProvider = "";
        let triedCount = 0;
        let chunkCount = 0;
        let chunksCompleted = 0;

        // One provider synthesizes the WHOLE answer, chunked to ITS own
        // input limit. Previously each 180-char chunk could land on a
        // different provider, so a mid-answer rotation spliced two sample
        // rates into one WAV and the tail came out garbled — and any single
        // failed chunk threw away every chunk already paid for. Now a
        // provider either delivers the complete answer or we move on.
        const deadProviders = new Set<string>();
        for (let i = 0; i < attempts.length; i++) {
          const { provider, key, keyId } = attempts[i];
          // A provider that already failed non-rotatably (its model refuses
          // this request outright) fails identically on every one of its
          // other keys — skip the rest of ITS keys, but keep going through
          // the other providers instead of aborting the whole chain.
          if (deadProviders.has(provider)) continue;
          const limit = PROVIDER_CHUNK_LIMIT[provider] ?? FALLBACK_CHUNK_LIMIT;
          const chunks = chunkText(input, limit);
          chunkCount = chunks.length;
          triedCount++;
          let parts: ArrayBuffer[] = [];
          try {
            // Chunks are synthesized CONCURRENTLY (bounded) rather than one
            // after another. Chunking exists only because of per-request
            // input caps — the pieces don't depend on each other — so a
            // Groq answer split into 7 x 180-char chunks used to cost 7
            // sequential round trips of latency before a single word was
            // heard. Order is preserved by index, so the concatenated WAV
            // is identical; only the wall-clock wait shrinks.
            parts = await mapConcurrent(chunks, TTS_CONCURRENCY, (chunk) =>
              speakText({ provider, apiKey: key, text: chunk, voice: resolvedVoice, language }),
            );
            if (parts.length > 0) {
              chunksCompleted = parts.length;
              return new Response(concatWav(parts), { headers: { "Content-Type": "audio/wav" } });
            }
          } catch (err) {
            lastProvider = provider;
            chunksCompleted = parts.length;
            if (err instanceof VoiceProviderError) {
              lastStatus = err.status;
              lastMessage = err.message;
              markVoiceKeyCooldown(provider, keyId, key, err.status);
              if (!err.rotatable) {
                console.warn(`[voice/speak] ${provider} failed hard (${err.status}); skipping its remaining keys`);
                deadProviders.add(provider);
                continue;
              }
              console.warn(`[voice/speak] ${provider} failed (${err.status}) after ${parts.length}/${chunks.length} chunks, trying next`);
            } else {
              lastMessage = err instanceof Error ? err.message : String(err);
              console.warn(`[voice/speak] ${provider} threw; trying next`);
            }
          }
        }



        // Last resort: the platform gateway. Reached when the attorney has no
        // voice-capable key at all, or every one of theirs failed (quota,
        // revoked key, model refusal). Voice should never hard-fail on a
        // personal-key problem alone.
        let gatewayError = "";
        try {
          const gatewayChunks = await mapConcurrent(
            chunkText(input, GATEWAY_CHUNK_LIMIT),
            TTS_CONCURRENCY,
            (chunk) => speakViaGateway(chunk, resolvedVoice),
          );
          if (gatewayChunks.length > 0) {
            console.warn("[voice/speak] served via platform gateway fallback");
            return new Response(concatWav(gatewayChunks), { headers: { "Content-Type": "audio/wav" } });
          }
        } catch (err) {
          gatewayError = err instanceof Error ? err.message : String(err);
          console.warn(`[voice/speak] gateway fallback failed: ${gatewayError}`);
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
            error: `TTS ${lastStatus}`,
            detail: lastMessage.slice(0, 500),
            diag: {
              userKeyCount: chain.userKeyCount,
              providersAvailable: [...new Set(attempts.map((a) => a.provider))],
              triedCount,
              lastProvider,
              chunkCount,
              chunksCompleted,

              gatewayError,

            },
          }),
          { status: lastStatus, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
