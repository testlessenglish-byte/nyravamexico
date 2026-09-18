# Analyzers checkpoint loop — findings and proposed correction

## 1. Did I reproduce the cooldown/budget loop? No — the previous diagnosis is wrong

I pulled the live execution traces (`pipeline_trace`, `pipeline_engine_runs`). The last three runs tell a consistent story, and it is not a Groq cooldown wait:

| Tick start | Extraction | Analyzers started at | Analyzers outcome |
|---|---|---|---|
| 19:27:01 | ran again, 30.3 s | 54.3 s into the tick | checkpointed before it could start (budget already −12.1 s) |
| 20:05:02 | ran again, 16.8 s | 34.5 s into the tick | 1 attempt, **1,133 ms, 0 tokens**, checkpoint |
| 23:36:01 | ran again, 17.6 s | 18.4 s into the tick | 1 OpenRouter batch OK (12.1 s), then checkpoint at −4.2 s |

The worker invocation budget is 42 s (`WORKER_INVOCATION_BUDGET_MS`). Document Extraction re-executes on **every** tick and consumes 17–30 s of it, so Legal Analyzers only ever receives leftovers. When under ~12 s remain, `aiCallTimeoutForCheckpoint` refuses to start an AI call and throws `CheckpointRequired` immediately — that is the ~1 s attempt with 0 input/0 output tokens the user saw. Next tick: extraction again, same starvation. Nothing ever waits on a Groq cooldown; the router is not the loop driver.

Groq is nonetheless genuinely broken, which hid the real cause:
- `ai_providers.default_model = llama-3.3-70b-versatile` returns **HTTP 404 model does not exist** (stored in `ai_providers.last_error`, `last_ok_at` is NULL — Groq has never served a call).
- Its per-request input budget (5,500 minus reserved output = 3,452 tokens) is smaller than every analyzer prompt (~8,062 tokens), so Groq is skipped as `payload_exceeds_provider_limit` on every call anyway.

Real capacity today = OpenRouter (serving) + Gemini (configured, untested since Aug 29). The router already fails over correctly: in the 23:36 trace it skipped Groq and served on OpenRouter in 12.1 s.

## 2. Exact files/functions

- `src/lib/pipeline-runner.server.ts` ~1552–1600 — stage deadline is `min(stageStart + stageBudget, runStart + 42 s)`; no reservation of a minimum workable slice per stage, and no skip of stages already completed this execution before spending the tick on them.
- `src/lib/pipeline-checkpoint.server.ts` — `aiCallTimeoutForCheckpoint` (throws when <12 s remain), `WORKER_INVOCATION_BUDGET_MS = 42_000`, `STAGE_BUDGET_MS.analyzers = 45_000` (larger than the whole invocation, so it never binds).
- `src/lib/pipeline.server.ts` extraction stage (~1743) — re-runs per tick instead of short-circuiting when all documents are already extracted for this execution.
- `src/lib/ai/router.server.ts` 1545–1595 — the cooldown-wait branch the earlier audit blamed; it is guarded and only reachable when *zero* providers were attempted, and it already falls through to a cooldown-ignoring pass.
- Groq: `ai_providers` row (dead model) + `PROVIDER_INPUT_TOKEN_BUDGET.groq` in the router.

## 3. Stage → provider map

Every AI-powered stage funnels through `callGroq()` (`src/lib/groq.server.ts`) → `routeAI()` (`src/lib/ai/router.server.ts`). No pipeline agent calls Gemini/Groq/OpenRouter directly; the only direct provider HTTP lives in `src/lib/ai-keys.server.ts` (key validation probes) and `src/lib/voice/adapters.server.ts` (not part of case execution). Extraction, Analyzers, Perspectives, Witness, Evidence Intel, Discovery, Opportunities, Trial Prep, Strategy, Multi-Agent, Report Writer, Citation/Hallucination, Legal QA, Judge, Master Orchestrator and materia agents all share one chain, one key pool and one fallback order:

`OpenRouter openai/gpt-4o-mini (1 key) → Gemini gemini-flash-latest (3 keys) → Groq llama-3.3-70b-versatile (3 keys, currently dead)`

rotated per call, 33 s per-call cap, 2 transport retries, cooldown per provider+model+key.

## 4. Why the two health screens disagree

Intelligence Providers derives "Healthy" from configuration state (`ai_providers.enabled` + a key row exists). System Health performs a runtime probe against the configured model, so it reports Groq `model_not_found`. Two definitions, one word.

## 5. Maximum retry amplification (today)

Per logical AI call: 8 real provider attempts × up to 3 HTTP tries = 24 requests, multiplied by 1 cooldown-ignoring pass, up to 3 cooldown waits and the compression cascade (up to 3 tiers) — worst case well over 100 outbound requests for one analyzer batch, then × 2 concurrent batches × 8 stage checkpoints.

## 6. Proposed correction (architecture level)

1. **Stop stage starvation (the actual fix).** In the runner, before starting a stage, require a minimum workable slice (`MIN_STAGE_SLICE_MS`, ≈ AI minimum + safety). If the remaining invocation budget is below it, checkpoint *immediately* and re-queue instead of burning the tick, and record which stage was starved. Reserve budget so a stage that has produced no forward progress in the previous tick is scheduled **first** in the next one.
2. **Don't re-run completed work each tick.** Extraction short-circuits when every document already has extracted text for this execution, so a resume tick spends its budget on the stage that actually needs it.
3. **Cap stage budget to what the invocation can really give** (`min(stageBudget, remaining invocation)`) and make `aiCallTimeoutForCheckpoint` report the starvation reason into the checkpoint, so the UI stops saying "will resume on next worker tick" with no explanation.
4. **Failure taxonomy in the router**: classify every attempt as `KEY_INVALID | KEY_RATE_LIMITED | PROVIDER_RATE_LIMITED | MODEL_NOT_FOUND | MODEL_UNAVAILABLE | PROVIDER_UNAVAILABLE | TIMEOUT | NETWORK_FAILURE | COOLDOWN`. `MODEL_NOT_FOUND` / `KEY_INVALID` stop the whole provider (or key) for the run instead of rotating every key against the same dead model; only key-scoped faults rotate keys.
5. **Never wait longer than the budget allows**: before any cooldown wait, compare `cooldown + margin` with the remaining stage budget; if it cannot fit, jump straight to the next eligible provider, and only checkpoint with a *valid future resume time* when no provider is usable.
6. **Bound amplification**: a single hard cap on outbound attempts per logical call (target ≤ 8), counted across key rotation, provider fallback, cooldown passes and compression tiers.
7. **One health source of truth**: replace the boolean "Healthy" with `configured / enabled / validated / healthy / degraded / cooling_down / unavailable`, computed from the same runtime probe + cooldown/error ledger both screens and the router read. Safe key identifiers only (`gemini-key-1`).
8. **Telemetry**: extend the per-attempt record with case/execution/stage/agent/attempt, queue and provider timestamps, failure classification, fallback reason and checkpoint reason.
9. **Fix Groq for real**: point it at a current Groq model and re-derive its input budget, so its keys become usable capacity instead of permanent 404s.

## 7. Regression tests

- cooldown 45 s / required wait 46 s / analyzers budget ≤ 45 s / healthy alternative → alternative selected, no `CheckpointRequired`.
- one key rate-limited, sibling key healthy → rotate key, same provider.
- model 404 → provider abandoned for the run, no per-key hammering.
- provider rate-limited / provider unavailable / all providers unavailable → bounded, diagnostic failure with a valid resume time.
- provider recovers after cooldown → next call uses it.
- starvation test: stage entered with < minimum slice → immediate checkpoint with reason, and that stage runs first on the next tick.
- multiple concurrent cases share the attempt cap without amplification.

Then: fresh Penal, Laboral and Civil end-to-end runs.

No safety gate, citation rule, QA/Judge check or RLS policy is touched; no case-specific or materia-specific patches.
