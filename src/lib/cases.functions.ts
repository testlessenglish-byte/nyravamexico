// Client-safe server-function module. Handlers run on the server only.
import { CASE_RESET_FIELDS, clearCaseDerivedData } from "./pipeline-reset";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";
import { CANONICAL_STAGES, ENGINE, type CanonicalStageKey } from "@/lib/execution/canonical";
import { PRACTICE_AREA_LABELS, type PracticeArea } from "@/lib/intelligence/practice-areas";
import { JURISDICTION_VALUES } from "@/lib/intelligence/jurisdictions";
import { normalizeCaseAnalysisMode } from "@/lib/intelligence/case-analysis-mode";
import {
  PROJECTION_LIKE,
  selectFindings,
  isCanonicalFinding,
  type SelectableFinding,
} from "@/lib/intelligence/finding-selection";
import { consolidateFindings } from "@/lib/intelligence/finding-dedupe";
import { sha256HexSync as sha256Hex } from "@/lib/intelligence/sha256";

// Single source of truth for valid case_type values — derived from
// PRACTICE_AREA_LABELS (practice-areas.ts) instead of hand-copied literal
// lists. Previously this file had two separate hardcoded arrays that both
// predated `tax_law` being added as a practice area: the dropdown (sourced
// from practice-areas.ts) offered "Tax law", but both createCaseAndUpload's
// `allowedCaseTypes` Set and updateCaseSettings' Zod enum silently rejected
// it — createCaseAndUpload fell back to case_type: null, and
// updateCaseSettings threw a ZodError, which is exactly what produced the
// "invalid_enum_value ... received 'tax_law'" error and the case reverting
// to a different type after upload. Deriving both from the same registry
// that powers the UI means adding a practice area there is enough — no more
// three-places-by-hand.
const CASE_TYPE_VALUES = Object.keys(PRACTICE_AREA_LABELS) as [PracticeArea, ...PracticeArea[]];

type Db = SupabaseClient<Database>;
type AuthContext = { supabase?: Db; userId?: string };

async function getAuthedContext(context: AuthContext, label: string) {
  let supabase: Db;
  let userId: string;

  if (context?.supabase && context.userId) {
    supabase = context.supabase;
    userId = context.userId;
  } else {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      throw new Error(`[${label}] backend environment unavailable`);
    }

    const { getRequest } = await import("@tanstack/react-start/server");
    const authHeader = getRequest()?.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new Error(`[${label}] signed-in session was not attached to the request`);
    }

    const token = authHeader.replace("Bearer ", "");
    supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims?.sub) {
      throw new Error(`[${label}] signed-in session could not be verified`);
    }
    userId = data.claims.sub;
  }

  // Reject blocked accounts on every authenticated call. Uses the caller's own
  // RLS-scoped client, which is permitted to read its own profile row.
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_blocked")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.is_blocked) {
    throw new Error(
      "Your account has been blocked by an administrator. Contact support for assistance.",
    );
  }

  return { supabase, userId };
}

function getApiKey() {
  // Legacy shim — the Groq client reads GROQ_API_KEY directly from env.
  // We still pass a string to keep older call signatures stable.
  return process.env.GROQ_API_KEY ?? "";
}

// -------- Create case + upload files (no auto-processing) --------
export const createCaseAndUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    if (!(data instanceof FormData)) throw new Error("FormData required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Upload");
    const name = String(data.get("name") ?? "Untitled Case").slice(0, 200);
    const description = String(data.get("description") ?? "").slice(0, 2000) || null;
    // "Balanced" was removed as a new-case option — only "strict" and
    // "exploratory" remain selectable, so an invalid/missing value is
    // rejected outright rather than silently coerced into the retired mode.
    const rawMode = String(data.get("analysis_mode") ?? "").toLowerCase();
    if (rawMode !== "strict" && rawMode !== "exploratory") {
      throw new Error("Invalid analysis_mode: expected 'strict' or 'exploratory'");
    }
    const analysis_mode = rawMode;
    const allowedCaseTypes = new Set<string>(CASE_TYPE_VALUES);
    const rawCaseType = String(data.get("case_type") ?? "").toLowerCase();
    const case_type = allowedCaseTypes.has(rawCaseType) ? rawCaseType : null;
    const allowedJurisdictions = new Set<string>(JURISDICTION_VALUES);
    const rawJurisdiction = String(data.get("jurisdiction") ?? "");
    const jurisdiction = allowedJurisdictions.has(rawJurisdiction)
      ? rawJurisdiction
      : case_type === "migratorio"
        ? "federal"
        : null;
    // Settable at upload time (rather than only afterward, on the workspace
    // page) so a user who already knows they're auditing a concluded case
    // doesn't have to visit a second page just to set this before running.
    const case_analysis_mode = normalizeCaseAnalysisMode(data.get("case_analysis_mode"));
    const rawVehicle = data.get("procedural_vehicle");
    const procedural_vehicle = rawVehicle ? String(rawVehicle).trim() || null : null;
    const rawUnderlying = data.get("underlying_materia");
    const underlying_materia = rawUnderlying ? String(rawUnderlying).trim() || null : null;
    let matter_metadata: Record<string, unknown> = {};
    if (case_type === "migratorio") {
      const rawMetadata = String(data.get("matter_metadata") ?? "{}");
      let parsedMetadata: unknown;
      try {
        parsedMetadata = JSON.parse(rawMetadata);
      } catch {
        throw new Error("Invalid immigration matter metadata");
      }
      const { parseImmigrationMatterMetadata } = await import("@/lib/jurisdiction/immigration");
      matter_metadata = parseImmigrationMatterMetadata(parsedMetadata);
    }
    const files = data.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) throw new Error("No files uploaded");

    const MAX_FILES = 50;
    const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file
    const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB total
    if (files.length > MAX_FILES) {
      throw new Error(`Too many files: max ${MAX_FILES} per case`);
    }
    let totalBytes = 0;
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) {
        throw new Error(`File "${f.name}" exceeds 50 MB limit`);
      }
      totalBytes += f.size;
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("Total upload size exceeds 200 MB limit");
    }

    const { trace, traceSpan, newCorrelationId } = await import("@/lib/pipeline-trace.server");
    const { createInitialCaseConfiguration } = await import("@/lib/intelligence/case-configuration");

    const rawName = String(data.get("name") ?? "").trim();
    const rawDescription = String(data.get("description") ?? "").trim();
    const isUserNamed = Boolean(rawName.length > 0 && rawName !== "Untitled Case");
    const isUserDescribed = Boolean(rawDescription.length > 0);

    const name = isUserNamed ? rawName.slice(0, 200) : "Caso en identificación...";
    const description = isUserDescribed ? rawDescription.slice(0, 2000) : null;

    const initialCaseIdentity = {
      original_filename: files[0]?.name ?? null,
      case_number: null,
      case_number_normalized: null,
      case_number_type: null,
      primary_party_name: null,
      primary_party_role: null,
      opposing_party_name: null,
      court_name: null,
      tribunal_level: null,
      procedural_vehicle: procedural_vehicle,
      effective_materia: case_type,
      underlying_materia: underlying_materia,
      jurisdiction: jurisdiction,
      procedural_posture: null,
      related_case_numbers: [],

      case_display_name: isUserNamed ? rawName.slice(0, 200) : null,
      case_display_name_source: (isUserNamed ? "user" : "pending_extraction") as "user" | "pending_extraction",
      case_display_name_confidence: isUserNamed ? 1.0 : null,
      case_display_name_locked: isUserNamed,
      case_identity_verified: false,

      case_description: isUserDescribed ? rawDescription.slice(0, 2000) : null,
      case_description_source: (isUserDescribed ? "user" : "pending_extraction") as "user" | "pending_extraction",
      case_description_confidence: isUserDescribed ? 1.0 : null,
      case_description_locked: isUserDescribed,
      case_description_generated_at: null,
    };
    matter_metadata.case_identity = initialCaseIdentity;

    const caseConfiguration = createInitialCaseConfiguration({
      user_selected_case_type: case_type,
      user_selected_jurisdiction: jurisdiction,
      user_selected_analysis_mode: analysis_mode,
      user_selected_case_analysis_mode: case_analysis_mode,
      user_selected_procedural_vehicle: procedural_vehicle,
      user_selected_underlying_materia: underlying_materia,
      source: "user",
    });
    matter_metadata.case_configuration = caseConfiguration;

    const { data: created, error } = await supabase
      .from("cases")

      .insert({
        user_id: userId,
        name,
        description,
        status: "uploaded",
        progress: 0,
        analysis_mode,
        case_type,
        jurisdiction,
        case_analysis_mode,
        matter_metadata,
        procedural_vehicle,
        underlying_materia,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .select("id")
      .single();
    if (error || !created) {
      await trace({
        phase: "upload",
        step: "case.insert",
        status: "error",
        error: error?.message ?? "insert returned no row",
        detail: {
          pg_code: error?.code ?? null,
          pg_details: error?.details ?? null,
          name,
          case_type,
          jurisdiction,
          case_analysis_mode,
          immigration_subtype:
            case_type === "migratorio" ? String(matter_metadata.immigration_subtype ?? "") : null,
          has_protected_identity_metadata:
            case_type === "migratorio" && Boolean(matter_metadata.passport_number),
        },
      });
      throw new Error(error?.message ?? "Failed to create case");
    }
    const caseId = created.id;
    const correlationId = newCorrelationId(caseId);
    const traceTarget = { db: supabase, caseId, userId, correlationId };

    await trace({
      ...traceTarget,
      phase: "upload",
      step: "case.created",
      status: "ok",
      detail: {
        name,
        case_type,
        jurisdiction,
        analysis_mode,
        case_analysis_mode,
        file_count: files.length,
        total_bytes: totalBytes,
        files: files.map((f) => ({ name: f.name, bytes: f.size, mime: f.type || null })),
      },
    });

    const uploads = await traceSpan(
      {
        ...traceTarget,
        phase: "upload",
        step: "files.read_into_memory",
        detail: { file_count: files.length },
      },
      async () =>
        await Promise.all(
          files.map(async (f) => ({
            name: f.name,
            bytes: new Uint8Array(await f.arrayBuffer()),
          })),
        ),
    );
    const { uploadFiles } = await import("@/lib/pipeline.server");
    await traceSpan(
      {
        ...traceTarget,
        phase: "upload",
        step: "storage.upload_and_document_rows",
        detail: {
          file_count: uploads.length,
          bytes: uploads.reduce((a, u) => a + u.bytes.byteLength, 0),
        },
      },
      () => uploadFiles({ db: supabase, caseId, userId, uploads }),
    );
    const { count: docCount } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("case_id", caseId);
    await trace({
      ...traceTarget,
      phase: "upload",
      step: "documents.verified",
      status: (docCount ?? 0) === uploads.length ? "ok" : "warn",
      detail: { expected: uploads.length, stored: docCount ?? 0 },
    });
    return { caseId };
  });

// -------- Step runners (each independently executable) --------
const stepInput = (d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d);

type StepRunner = (a: {
  db: Db;
  caseId: string;
  userId: string;
  apiKey: string;
  apiKeys?: string[];
}) => Promise<unknown>;

// Map runLabeledStep labels → pipeline stage keys for progress + gating.
const LABEL_TO_STAGE: Record<string, import("@/lib/intelligence/progress.server").StageKey | null> =
  {
    Extraction: "extraction",
    Analyzers: "analyzers",
    Agents: "agents",
    EvidenceIntel: "evidence_intel",
    Contradictions: "contradictions",
    Witness: "witness_intel",
    DiscoveryGap: "discovery_gaps",
    Theories: "theories",
    Opportunities: "theories",
    Strategy: "strategy",
    Perspectives: null,
    Scoring: "scoring",
    Report: "report",
    TrialPrep: null,
    WorkProduct: null,
    FullIntelligence: null,
  };

async function runLabeledStep({
  label,
  context,
  caseId,
  loader,
}: {
  label: string;
  context: AuthContext;
  caseId: string;
  loader: () => Promise<StepRunner>;
}) {
  const { supabase, userId } = await getAuthedContext(context, label);
  // Side-door guard: the full pipeline holds a case-level lease while it
  // runs, but individual stage buttons used to fire AI calls straight past
  // it — a double-click, a stale retry, or a race with the background worker
  // could overlap token usage and write conflicting output for one stage.
  const { assertCaseNotLeased, assertUserPipelineCapacity } =
    await import("@/lib/pipeline-lease.server");
  await assertCaseNotLeased(supabase, caseId, `step:${label}`, userId);
  await assertUserPipelineCapacity(supabase, userId, caseId, `step:${label}`);
  const stage = LABEL_TO_STAGE[label] ?? null;
  const prog = await import("@/lib/intelligence/progress.server");
  if (stage) {
    try {
      await prog.ensurePrereqs(supabase, caseId, stage);
    } catch (e) {
      throw new Error(`[${label}] ${e instanceof Error ? e.message : String(e)}`);
    }
    await prog.emitEvent(supabase, caseId, stage, `${label} started`);
  }
  // Clear any stale cancel flag before starting a new step.

  await supabase
    .from("cases")
    .update({ cancel_requested: false } as any)
    .eq("id", caseId);
  // Resolve user keys; active key takes precedence over platform key.
  const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
  const { keys, userKeyCount } = await resolveProviderKeys(supabase, userId, "groq");
  const activeKey = keys[0] ?? getApiKey();

  // Subscription usage gate. Every individual-engine button (Report, Trial
  // Prep, Work Product, Strategy, Discovery Gap, ...) is its own metered AI
  // request — see usage.server.ts. BYOK (the user has their own provider key
  // configured, detected via userKeyCount above) bypasses the platform
  // allowance entirely.
  const { checkAndConsumeUsage, usageExceededMessage } = await import("@/lib/usage.server");
  const usage = await checkAndConsumeUsage({
    userId,
    kind: "ai_request",
    feature: LABEL_TO_STAGE[label] ?? label.toLowerCase().replace(/\s+/g, "_"),
    caseId,
    byokActive: userKeyCount > 0,
  });
  if (!usage.allowed) {
    throw new Error(usageExceededMessage(label, usage));
  }

  const fn = await loader();
  // withAIUser wrap: without this, every callGroq() inside the engine only
  // ever sees the explicit Groq keys resolved above and has no way to reach
  // any other provider (Gemini, etc.) configured in AI Provider Keys — a
  // Groq-only quota/auth failure kills the whole step even with working
  // fallback keys sitting right there. runPipelineForCase (the full "Run
  // Case" pipeline) already does this; every INDIVIDUAL step button
  // (Run Trial Prep, Run Work Product, etc.) was going through this
  // function instead and never got the same fallback — Groq-only regardless
  // of what else the user had configured. Matching that pattern here closes
  // the gap for every single-engine button in the app, not just one.
  const { withAIUser } = await import("@/lib/ai/user-scope.server");
  try {
    await withAIUser(userId, () =>
      fn({ db: supabase, caseId, userId, apiKey: activeKey, apiKeys: keys }),
    );
    if (stage) {
      await prog.emitEvent(supabase, caseId, stage, `${label} complete`);
    }
    if (label === "Report") {
      const { bumpReportsGenerated } = await import("@/lib/usage.server");
      bumpReportsGenerated(userId);
    }
    // Every individual-engine button (Evidence Intel, Witness, Discovery
    // Gap, Theories, Strategy, Scoring, Report, Trial Prep, Work Product,
    // ...) writes intelligence this same way and is a "rerun" from Talk to
    // Case's point of view just as much as the full pipeline is — it's not
    // routed through runPipelineForCase/pipeline-runner.server.ts at all, so
    // without this it would bypass cache invalidation entirely and Talk to
    // Case could keep answering from pre-run data indefinitely (not just for
    // the TTL window). Same invalidate-and-eagerly-rebuild call as the full
    // pipeline's finalize step, non-fatal on failure.
    try {
      const { invalidateAndRebuildChatContext } = await import("@/lib/intelligence/chat.server");
      await invalidateAndRebuildChatContext(supabase, caseId, {
        runId: `step-${label}-${Date.now().toString(36)}`,
        source: `runLabeledStep:${label}`,
      });
    } catch (cacheErr) {
      console.warn(`[${label}] talk-to-case cache invalidation failed:`, cacheErr);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "Cancelled by user" || (e instanceof Error && e.name === "CancelledError")) {
      return { ok: false, cancelled: true };
    }
    if (stage) {
      await prog.emitEvent(supabase, caseId, stage, msg, { level: "error" });
    }
    const stack = e instanceof Error ? e.stack : undefined;
    console.error(`[${label}] failed`, { caseId, msg, stack });
    // Friendlier error surface for quota and auth issues. Reaching any of
    // these means the router already tried every provider the user has
    // configured (Groq first, then fallbacks like Gemini via AI Keys) —
    // see the withAIUser wrap above — so the wording must not name Groq
    // specifically.
    let friendly = msg;
    if (/429|rate.limit|quota/i.test(msg)) {
      friendly =
        "All configured AI providers are rate-limited or out of quota right now. Open Settings → AI Keys to add another provider as a fallback, or wait a few minutes and retry.";
    } else if (/401|403|invalid.+api.+key|unauthorized|rejected this api key/i.test(msg)) {
      friendly =
        "Every configured AI provider rejected its API key. Open Settings → AI Keys to check them.";
    } else if (/no groq api key|GROQ_API_KEY|no.+key.+configured|no ai providers/i.test(msg)) {
      friendly = "No AI provider is configured. Open Settings → AI Keys to add one.";
    }
    throw new Error(`[${label}] ${friendly}`);
  }
  return { ok: true };
}

export const runExtractionStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) =>
    runLabeledStep({
      label: "Extraction",
      context,
      caseId: data.caseId,
      loader: async () => (await import("@/lib/pipeline.server")).runExtraction,
    }),
  );

export const runAnalyzersStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) =>
    runLabeledStep({
      label: "Analyzers",
      context,
      caseId: data.caseId,
      loader: async () => (await import("@/lib/pipeline.server")).runAnalyzers,
    }),
  );

export const runAgentsStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) =>
    runLabeledStep({
      label: "Agents",
      context,
      caseId: data.caseId,
      loader: async () => (await import("@/lib/pipeline.server")).runAgents,
    }),
  );

export async function runTimelineAudit({
  supabase,
  userId,
  caseId,
}: {
  supabase: Db;
  userId: string;
  caseId: string;
}) {
  const [{ data: analysis }, { data: caseRow }] = await Promise.all([
    supabase.from("analyses").select("timeline").eq("case_id", caseId).maybeSingle(),
    supabase.from("cases").select("agents_at").eq("id", caseId).maybeSingle(),
  ]);

  if (!analysis) throw new Error("Run Analyzers first — timeline is derived from analyzer output.");
  if (!caseRow?.agents_at) {
    throw new Error("Run Agents first — Build Timeline runs after agent investigation.");
  }

  const audit = await import("@/lib/intelligence/engine-audit.server");
  const { buildCanonicalTimeline, persistCanonicalTimeline } =
    await import("@/lib/intelligence/canonical-timeline.server");
  const ct = await buildCanonicalTimeline(supabase, caseId);
  let persistStats: { inserted: number; superseded: number; unchanged: number } | null = null;
  try {
    persistStats = await persistCanonicalTimeline(supabase, caseId, ct);
  } catch (e) {
    // Persistence is additive; never fail the stage on a write hiccup.
    console.warn("[timeline] persistCanonicalTimeline failed:", e instanceof Error ? e.message : e);
  }
  await supabase
    .from("pipeline_engine_runs")
    .delete()
    .eq("case_id", caseId)
    .eq("engine", ENGINE.timeline);
  await audit.runEngine(supabase, { caseId, userId, engine: ENGINE.timeline }, async () => ({
    value: ct,
    stats: {
      generated: ct.totals.total,
      accepted: ct.totals.dated,
      meta: persistStats ? { persisted: persistStats } : undefined,
    },
  }));
  return {
    ok: true,
    events: ct.totals.total,
    dated: ct.totals.dated,
    duplicates_merged: ct.totals.duplicates_merged,
    persisted: persistStats,
  };
}

// Dedicated Timeline step. Timeline data is produced by the Analyzer stage;
// this server fn ONLY records the engine audit row so the UI can have a
// standalone "Build Timeline" button that never re-triggers the analyzer
// and never auto-runs when Analyzers runs.
export const runTimelineStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Timeline");
    return runTimelineAudit({ supabase, userId, caseId: data.caseId });
  });

export const runScoringStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) =>
    runLabeledStep({
      label: "Scoring",
      context,
      caseId: data.caseId,
      loader: async () => (await import("@/lib/pipeline.server")).runScoring,
    }),
  );

export const runReportStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) =>
    runLabeledStep({
      label: "Report",
      context,
      caseId: data.caseId,
      loader: async () => (await import("@/lib/pipeline.server")).runReport,
    }),
  );

export const runHallucinationReviewStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "HallucinationReview");
    const { runHallucinationReview } = await import("@/lib/intelligence/hallucination.server");
    const report = await runHallucinationReview({ db: supabase, caseId: data.caseId });
    return { ok: true, report };
  });

export const runTheoryStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) =>
    runLabeledStep({
      label: "Theories",
      context,
      caseId: data.caseId,
      loader: async () => (await import("@/lib/intelligence/engines.server")).runTheoryEngine,
    }),
  );

export const runOpportunityStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) =>
    runLabeledStep({
      label: "Opportunities",
      context,
      caseId: data.caseId,
      loader: async () => (await import("@/lib/intelligence/engines.server")).runOpportunityEngine,
    }),
  );

// Discovery Gaps and Witness Intelligence are DERIVED from Analyzers + Agents.
// The standalone LLM engines were removed because they duplicated work the
// batched Analyzers/Agents passes already performed and blew the 30K TPM cap.
// The manual buttons now just re-record the derived counts.
export const runDiscoveryGapStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "DiscoveryGap");
    const audit = await import("@/lib/intelligence/engine-audit.server");
    const derived = await import("@/lib/intelligence/derived-engines.server");
    await audit.runEngine(
      supabase,
      { caseId: data.caseId, userId, engine: ENGINE.discovery },
      async () => derived.deriveDiscoveryGaps(supabase, data.caseId),
    );
    return { ok: true, derived_from: "analyzers" };
  });

export const runWitnessStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Witness");
    const audit = await import("@/lib/intelligence/engine-audit.server");
    const derived = await import("@/lib/intelligence/derived-engines.server");
    await audit.runEngine(
      supabase,
      { caseId: data.caseId, userId, engine: ENGINE.witness },
      async () => derived.deriveWitnessIntel(supabase, data.caseId),
    );
    return { ok: true, derived_from: "agents.witness_credibility" };
  });

export const runTrialPrepStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) =>
    runLabeledStep({
      label: "TrialPrep",
      context,
      caseId: data.caseId,
      loader: async () => (await import("@/lib/intelligence/engines.server")).runTrialPrepEngine,
    }),
  );

export const runWorkProductStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) =>
    runLabeledStep({
      label: "WorkProduct",
      context,
      caseId: data.caseId,
      loader: async () => (await import("@/lib/intelligence/engines.server")).runWorkProductEngine,
    }),
  );

// Bug 3: consolidated onto a single orchestrator. `runFullIntelligenceStep`
// now delegates to `runPipelineForCase` so every entry point (UI, background
// worker, this legacy step) writes to the same case row with the same
// dependency-aware failure semantics. The older `runFullIntelligence` in
// engines.server.ts is retained only for isolated engine tests.
export const runFullIntelligenceStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "FullIntelligence");
    const { claimPipelineLease, assertUserPipelineCapacity } =
      await import("@/lib/pipeline-lease.server");
    await assertUserPipelineCapacity(supabase, userId, data.caseId, "runFullIntelligenceStep");
    const claim = await claimPipelineLease(supabase, data.caseId);
    if (!claim.claimed) return { ok: false, queued: false, ...claim };
    const { runPipelineForCase } = await import("@/lib/pipeline-runner.server");
    return runPipelineForCase(supabase, userId, { caseId: data.caseId });
  });

// -------- Phase 2/3/4 — Litigation Intelligence Engines --------
export const runPerspectivesStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) =>
    runLabeledStep({
      label: "Perspectives",
      context,
      caseId: data.caseId,
      loader: async () =>
        (await import("@/lib/intelligence/litigation.server")).runPerspectivesEngine,
    }),
  );

// Evidence Intelligence is DERIVED from the Analyzers "procedural" pass.
// See src/lib/intelligence/derived-engines.server.ts for rationale.
export const runEvidenceIntelStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "EvidenceIntel");
    const audit = await import("@/lib/intelligence/engine-audit.server");
    const derived = await import("@/lib/intelligence/derived-engines.server");
    await audit.runEngine(
      supabase,
      { caseId: data.caseId, userId, engine: ENGINE.evidence_intel },
      async () => derived.deriveEvidenceIntel(supabase, data.caseId),
    );
    return { ok: true, derived_from: "analyzers" };
  });

export const runStrategyStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        perspective: z
          .enum([
            "ministerio_publico",
            "defensa",
            "parte_actora",
            "parte_demandada",
            "quejoso",
            "autoridad_responsable",
            "juzgador",
            "independiente",
          ])
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Strategy");

    await supabase
      .from("cases")
      .update({ cancel_requested: false } as any)
      .eq("id", data.caseId);
    const { runStrategyEngine } = await import("@/lib/intelligence/litigation.server");
    try {
      await runStrategyEngine({
        db: supabase,
        caseId: data.caseId,
        userId,
        apiKey: getApiKey(),
        perspective: data.perspective,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "Cancelled by user") return { ok: false, cancelled: true };
      console.error("[Strategy] failed", { caseId: data.caseId, msg });
      throw new Error(`[Strategy] ${msg}`);
    }
    return { ok: true };
  });

// Contradiction Analysis is DERIVED from the Analyzers "contradictions" pass.
export const runContradictionStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(stepInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Contradictions");
    const audit = await import("@/lib/intelligence/engine-audit.server");
    const derived = await import("@/lib/intelligence/derived-engines.server");
    await audit.runEngine(
      supabase,
      { caseId: data.caseId, userId, engine: ENGINE.contradictions },
      async () => derived.deriveContradictions(supabase, data.caseId),
    );
    return { ok: true, derived_from: "analyzers" };
  });

// =========================================================================
// MASTER PIPELINE ORCHESTRATOR
// Runs every engine sequentially in the canonical 18-stage order. Each stage
// must complete before the next begins. On failure, the pipeline stops and
// the failed stage is recorded so the user can retry from that point.
// =========================================================================
// ENGINE IDENTITY: this list is DERIVED from CANONICAL_STAGES — never
// re-declared. A stage's key and its `pipeline_engine_runs.engine` id are
// different identifiers (witness → witness_intelligence, report →
// report_generator); use `ENGINE[key]` / `engineForStage(key)` to cross over.
export const PIPELINE_STAGES: readonly {
  readonly key: CanonicalStageKey;
  readonly label: string;
}[] = CANONICAL_STAGES.map((s) => ({ key: s.key, label: s.label }));
export type PipelineStageKey = CanonicalStageKey;

export const runFullPipelineStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        startFrom: z.string().optional(),
        reset: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "FullPipeline");
    const { claimPipelineLease, assertUserPipelineCapacity } =
      await import("@/lib/pipeline-lease.server");
    await assertUserPipelineCapacity(supabase, userId, data.caseId, "runFullPipelineStep");
    const claim = await claimPipelineLease(supabase, data.caseId, { reset: data.reset });
    if (!claim.claimed) return { ok: false, queued: false, ...claim };
    const { runPipelineForCase } = await import("@/lib/pipeline-runner.server");
    return await runPipelineForCase(supabase, userId, {
      caseId: data.caseId,
      startFrom: data.startFrom,
      reset: data.reset,
    });
  });

// Enqueue a case for the background worker to pick up. Non-blocking — caller
// gets an immediate response and the pipeline runs on the next cron tick.
export const queueCaseForPipeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        reset: z.boolean().optional(),
        startFrom: z.enum(["extraction", "analyzers"]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "QueueCase");

    // Billing gate. New users get exactly one free case run; after that
    // (or immediately, once free_case_used is true for a DIFFERENT case)
    // they need an active subscription. Re-running the SAME case that
    // already used the free allowance stays free — see billing.functions.ts.
    // This is the real enforcement point (not createCaseAndUpload) because
    // uploading files costs nothing; queuing for the pipeline is what
    // actually spends AI credits.
    const { trace } = await import("@/lib/pipeline-trace.server");
    const traceTarget = { db: supabase, caseId: data.caseId, userId };

    const { getBillingAccess, consumeFreeCase } = await import("./billing.functions");
    const billingAccess = await getBillingAccess(userId, data.caseId);
    await trace({
      ...traceTarget,
      phase: "queue",
      step: "billing.gate",
      status: billingAccess.allowed ? "ok" : "warn",
      detail: {
        allowed: billingAccess.allowed,
        reason: billingAccess.reason ?? null,
        reset: !!data.reset,
      },
    });
    if (!billingAccess.allowed) {
      return { ok: false, billingRequired: true as const, queued: false };
    }

    // Subscription usage gate. Queuing a case runs the full intelligence
    // pipeline (extraction, analyzers, agents, report, etc.) — one metered
    // "Case Intelligence processing" AI request against the monthly
    // allowance, separate from the one-time free-case gate above. BYOK
    // (the user has their own provider key) bypasses the platform
    // allowance entirely — see usage.server.ts.
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const { userKeyCount } = await resolveProviderKeys(supabase, userId, "groq");
    const { checkAndConsumeUsage, usageExceededMessage } = await import("@/lib/usage.server");
    const usage = await checkAndConsumeUsage({
      userId,
      kind: "ai_request",
      feature: "case_intelligence",
      caseId: data.caseId,
      byokActive: userKeyCount > 0,
    });
    await trace({
      ...traceTarget,
      phase: "queue",
      step: "usage.gate",
      status: usage.allowed ? "ok" : "warn",
      detail: {
        allowed: usage.allowed,
        used: usage.used,
        limit: usage.limit,
        source: usage.source,
      },
    });
    if (!usage.allowed) {
      return {
        ok: false,
        queued: false,
        usageExceeded: true as const,
        usageMessage: usageExceededMessage("Case Intelligence processing", usage),
      };
    }

    // Guard against duplicate concurrent runs. `queueCaseForPipeline` used to
    // unconditionally null `worker_lease_until` and flip status to `queued`,
    // which would strand an in-flight `runPipelineForCase` (still executing
    // in the background, unaware its lease was cleared) while the next cron
    // tick legitimately CAS-claimed and started a SECOND independent run of
    // the same case. Two loops then fought over the same rows and doubled
    // load on the same Groq keys. Fix per lovable_fix_instructions_2 #5:
    // check the current state and refuse to overwrite a live lease.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing, error: readErr } = await (supabase as any)
      .from("cases")
      .select("status, worker_lease_until, cancel_requested")
      .eq("id", data.caseId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!existing) throw new Error("Case not found");

    const leaseUntil = existing.worker_lease_until
      ? new Date(existing.worker_lease_until).getTime()
      : 0;
    const leaseActive = leaseUntil > Date.now();
    const runningStatuses = new Set([
      "queued",
      "running",
      "extracting",
      "analyzing",
      "scoring",
      "reporting",
      "intelligence_running",
      "extraction_running",
      "extraction_complete",
      "analyzers_running",
      "analyzers_complete",
      "agents_running",
      "agents_complete",
      "timeline_running",
      "evidence_running",
      "sufficiency_running",
      "report_running",
    ]);
    const isRunning = leaseActive || runningStatuses.has(String(existing.status ?? ""));

    await trace({
      ...traceTarget,
      phase: "queue",
      step: "concurrency.check",
      status: isRunning ? "warn" : "ok",
      detail: {
        current_status: existing.status ?? null,
        lease_until: existing.worker_lease_until ?? null,
        lease_active: leaseActive,
        is_running: isRunning,
        reset: !!data.reset,
      },
    });

    if (isRunning) {
      if (data.reset) {
        // Explicit Rerun: cooperatively cancel the in-flight run via the
        // existing cancel_requested / CancelledError path. Do NOT null the
        // lease or flip status — that would re-open the double-run race.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: cancelErr } = await (supabase as any)
          .from("cases")
          .update({ cancel_requested: true })
          .eq("id", data.caseId);
        if (cancelErr) throw new Error(cancelErr.message);
        return { ok: false, cancelling: true as const, queued: false };
      }
      return { ok: false, alreadyRunning: true as const, queued: false };
    }

    const executionId = crypto.randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("cases")
      .update({
        queued_at: new Date().toISOString(),
        worker_lease_until: null,
        status: "queued",
        status_message: data.reset ? "Queued for full rerun" : "Queued",
        next_stage: data.reset ? "reset" : (data.startFrom ?? "extraction"),
        cancel_requested: false,
        execution_id: executionId,
        execution_started_at: new Date().toISOString(),
      })
      .eq("id", data.caseId);
    await trace({
      ...traceTarget,
      phase: "queue",
      step: "case.enqueued",
      status: error ? "error" : "ok",
      error: error?.message ?? null,
      detail: {
        next_stage: data.reset ? "reset" : (data.startFrom ?? "extraction"),
        execution_id: executionId,
        pg_code: error?.code ?? null,
        pg_details: error?.details ?? null,
      },
    });
    if (error) throw new Error(error.message);

    // On an explicit Rerun, also clear derived tables here — synchronously,
    // at click time — rather than only when runPipelineForCase's own reset
    // branch eventually runs it.
    if (data.reset) {
      await clearCaseDerivedData(supabase, data.caseId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("cases")
        .update({ ...CASE_RESET_FIELDS })
        .eq("id", data.caseId);
    }
    // Consume the free allowance only the first time THIS case is queued.
    if (billingAccess.reason === "free_case_available") {
      await consumeFreeCase(userId, data.caseId);
    }
    console.info(
      `[pipeline] ${JSON.stringify({
        t: new Date().toISOString(),
        event: "case.status.write",
        source: "queueCaseForPipeline",
        caseId: data.caseId,
        execution_id: executionId,
        previous_status: existing.status ?? null,
        new_status: "queued",
        previous_next_stage: null,
        new_next_stage: data.reset ? "reset" : (data.startFrom ?? "extraction"),
      })}`,
    );
    return { ok: true, queued: true };
  });

// Minimal, cheap status read used ONLY for client-side polling — e.g. to
// detect when a cooperative cancellation (see queueCaseForPipeline's
// `cancelling` branch) has actually finished, so the UI can auto-chain into
// the real requeue instead of asking the user to notice and click Rerun a
// second time. Deliberately returns nothing but status/cancel_requested —
// no row is worth fetching more than that on a tight poll interval.
export const getCaseRunState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "GetCaseRunState");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row, error } = await (supabase as any)
      .from("cases")
      .select("status, cancel_requested")
      .eq("id", data.caseId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      status: (row?.status as string) ?? null,
      cancelRequested: !!row?.cancel_requested,
    };
  });

// Client-driven pipeline tick observer — purely observes execution state
// and NEVER directly executes runPipelineForCase().
// Background worker is the sole owner of pipeline execution.
export const driveCasePipelineTick = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "DriveTick");
    const TERMINAL = new Set(["complete", "released", "needs_revision", "failed", "cancelled"]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row, error: readErr } = await (supabase as any)
      .from("cases")
      .select("status, next_stage, worker_lease_until, execution_id")
      .eq("id", data.caseId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) throw new Error("Case not found");

    const statusStr = String(row.status ?? "");
    if (TERMINAL.has(statusStr)) {
      return { done: true as const, status: row.status as string, ran: false };
    }

    const leaseUntil = row.worker_lease_until
      ? new Date(row.worker_lease_until as string).getTime()
      : 0;
    if (leaseUntil <= Date.now() && (statusStr === "queued" || statusStr === "intelligence_running")) {
      try {
        const { sweepStalledCases } = await import("@/lib/pipeline-stall.server");
        await sweepStalledCases(supabase, { caseId: data.caseId });
      } catch {
        /* best-effort observer watchdog */
      }
    }

    return {
      done: TERMINAL.has(statusStr),
      status: row.status as string,
      ran: false,
    };
  });

// Client-triggered stall watchdog. Called from the case page on mount so a
// user looking at a "running" case whose worker died between cron ticks sees
// it flip to "failed — click Resume" immediately rather than a stuck spinner.
export const sweepStalledCasesForMe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "SweepStalled");
    const { sweepStalledCases } = await import("@/lib/pipeline-stall.server");
    return await sweepStalledCases(supabase, { caseId: data.caseId });
  });

// Resume the pipeline from the first stage whose engine has not completed.
// Used for large/long cases that timed out or were interrupted — no work is
// repeated; we pick up at the next stage after the most recent completed one.
export const resumeFullPipelineStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "ResumePipeline");
    const { PIPELINE_STAGE_TO_ENGINE, CANONICAL_STAGES } =
      await import("@/lib/execution/canonical");
    const stageKeys = new Set<string>(PIPELINE_STAGES.map((s) => s.key));
    const blockingStageKeys = new Set<string>(
      CANONICAL_STAGES.filter((s) => s.requirement === "blocking").map((s) => s.key),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: caseRow, error: caseErr } = await (supabase as any)
      .from("cases")
      .select("status,next_stage,worker_lease_until")
      .eq("id", data.caseId)
      .maybeSingle();
    if (caseErr) throw new Error(caseErr.message);
    if (!caseRow) throw new Error("Case not found");

    const leaseUntil = caseRow.worker_lease_until
      ? new Date(caseRow.worker_lease_until as string).getTime()
      : 0;
    if (leaseUntil > Date.now()) {
      return {
        ok: false,
        alreadyRunning: true as const,
        status: (caseRow.status as string | null) ?? null,
        leaseUntil: (caseRow.worker_lease_until as string | null) ?? null,
      };
    }

    const persistedNext = typeof caseRow.next_stage === "string" ? caseRow.next_stage : null;
    const persistedCandidate =
      persistedNext && persistedNext !== "reset" && stageKeys.has(persistedNext)
        ? persistedNext
        : undefined;

    // Always compute the ledger-derived state — this is the single source of
    // truth for what has actually completed (docs/ARCHITECTURE.md §1), and is
    // now used unconditionally as a floor under the persisted checkpoint, not
    // only as a fallback when the checkpoint is absent. A persisted
    // `cases.next_stage` value is a performance optimization (avoids
    // recomputing from the ledger on every resume for large cases) but must
    // never be trusted to skip past a blocking-tier stage that the ledger
    // shows incomplete — that was possible before this change and is the
    // class of bug that can produce next_stage=trial_prep (or any later
    // stage) while a required earlier stage (e.g. analyzers) never
    // completed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows, error: rowsErr } = await (supabase as any)
      .from("pipeline_engine_runs")
      .select("engine,status,ended_at,created_at")
      .eq("case_id", data.caseId);
    if (rowsErr) throw new Error(rowsErr.message);

    const latest = new Map<
      string,
      { status: string; created_at?: string | null; ended_at?: string | null }
    >();
    for (const r of (rows ?? []) as Array<{
      engine: string;
      status: string;
      created_at?: string | null;
      ended_at?: string | null;
    }>) {
      const prev = latest.get(r.engine);
      const pt = new Date(prev?.created_at ?? prev?.ended_at ?? 0).getTime();
      const rt = new Date(r.created_at ?? r.ended_at ?? 0).getTime();
      if (!prev || rt >= pt) latest.set(r.engine, r);
    }
    const completed = new Set<string>();
    for (const [engine, row] of latest) {
      if (
        row.status === "completed" ||
        row.status === "completed_negative" ||
        row.status === "skipped"
      )
        completed.add(engine);
    }

    // Earliest incomplete stage, and separately the earliest incomplete
    // BLOCKING stage — the latter is the hard floor no checkpoint may skip.
    let ledgerResumeKey: string | undefined;
    let earliestIncompleteBlockingKey: string | undefined;
    for (const s of PIPELINE_STAGES) {
      const engine = PIPELINE_STAGE_TO_ENGINE[s.key];
      const isIncomplete = !engine || !completed.has(engine);
      if (isIncomplete && !ledgerResumeKey) ledgerResumeKey = s.key;
      if (isIncomplete && blockingStageKeys.has(s.key) && !earliestIncompleteBlockingKey) {
        earliestIncompleteBlockingKey = s.key;
      }
    }

    let resumeKey: string | undefined;
    if (
      earliestIncompleteBlockingKey &&
      (!persistedCandidate ||
        PIPELINE_STAGES.findIndex((s) => s.key === persistedCandidate) >
          PIPELINE_STAGES.findIndex((s) => s.key === earliestIncompleteBlockingKey))
    ) {
      // The checkpoint (if any) would skip past an incomplete required
      // stage — refuse it and resume at the required stage instead.
      resumeKey = earliestIncompleteBlockingKey;
    } else if (persistedCandidate) {
      resumeKey = persistedCandidate;
    } else {
      resumeKey = ledgerResumeKey;
    }
    if (!resumeKey) {
      return { ok: true, alreadyComplete: true };
    }

    const resumeEngine = PIPELINE_STAGE_TO_ENGINE[resumeKey];
    if (resumeEngine) {
      // Clear only stale in-progress marker rows for the stage we are about to
      // resume. Completed upstream work is preserved, so this is not a rerun.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("pipeline_engine_runs")
        .update({
          status: "failed",
          ended_at: new Date().toISOString(),
          error: "Stale checkpoint cleared before resume",
        })
        .eq("case_id", data.caseId)
        .eq("engine", resumeEngine)
        .in("status", ["queued", "running"]);
    }

    const queuedAt = new Date().toISOString();

    // If we're resuming at or before the scoring stage, any existing
    // scored_at is about to become stale: contradictions/evidence_intel/
    // discovery (or scoring itself) are all upstream of the score-vs-report
    // ordering check in scoring-selection.ts, which requires
    // scored_at >= each of those timestamps. Without this, a re-run that
    // bumps e.g. contradiction_at past the old scored_at silently trips
    // InvalidPipelineOrderError on the next report — permanently forcing
    // the case into LIMITED mode even after a fully successful resume,
    // since nothing else ever clears the stale value afterward.
    const scoringIdx = PIPELINE_STAGES.findIndex((s) => s.key === "scoring");
    const resumeIdx = PIPELINE_STAGES.findIndex((s) => s.key === resumeKey);
    const invalidatesScore = scoringIdx === -1 || resumeIdx === -1 || resumeIdx <= scoringIdx;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateErr } = await (supabase as any)
      .from("cases")
      .update({
        status: "queued",
        status_message: `Queued to resume at ${resumeKey}`,
        queued_at: queuedAt,
        worker_lease_until: null,
        next_stage: resumeKey,
        cancel_requested: false,
        stall_reason: null,
        error: null,
        ...(invalidatesScore ? { scored_at: null } : {}),
      })
      .eq("id", data.caseId);
    if (updateErr) throw new Error(updateErr.message);

    const { trace } = await import("@/lib/pipeline-trace.server");
    await trace({
      db: supabase,
      caseId: data.caseId,
      userId,
      phase: "queue",
      step: "resume.enqueued",
      status: "ok",
      detail: { startFrom: resumeKey, queued_at: queuedAt },
    });
    return { ok: true, queued: true, startFrom: resumeKey };
  });

// Bounded auto-retry after a stall, called ONLY by pipeline-stall.server.ts's
// sweepStalledCases() for cases still under MAX_AUTO_STALL_RETRIES. Mirrors
// resumeFullPipelineStep's ledger-derived resume computation above (blocking-
// tier floor, score invalidation) but skips the auth/lease preamble — the
// caller (the stall sweep) already owns the row and already confirmed the
// lease is expired. No `context`/`userId` dependency so it works from both
// the service-role cron path and the user-scoped client-mount sweep.
export async function autoRequeueStalledCase(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  caseId: string,
): Promise<{ ok: boolean; resumeKey?: string; alreadyComplete?: boolean }> {
  const { PIPELINE_STAGE_TO_ENGINE } = await import("@/lib/execution/canonical");

  const { data: caseRow } = await supabase
    .from("cases")
    .select("next_stage,stall_auto_retry_count")
    .eq("id", caseId)
    .maybeSingle();
  const persistedNext = typeof caseRow?.next_stage === "string" ? caseRow.next_stage : null;
  const nextRetryCount =
    (typeof caseRow?.stall_auto_retry_count === "number" ? caseRow.stall_auto_retry_count : 0) + 1;
  const stageKeys = new Set<string>(PIPELINE_STAGES.map((s) => s.key));
  const persistedCandidate =
    persistedNext && persistedNext !== "reset" && stageKeys.has(persistedNext)
      ? persistedNext
      : undefined;

  const { CANONICAL_STAGES } = await import("@/lib/execution/canonical");
  const blockingStageKeys = new Set<string>(
    CANONICAL_STAGES.filter((s) => s.requirement === "blocking").map((s) => s.key),
  );

  const { data: rows } = await supabase
    .from("pipeline_engine_runs")
    .select("engine,status,ended_at,created_at")
    .eq("case_id", caseId);

  const latest = new Map<
    string,
    { status: string; created_at?: string | null; ended_at?: string | null }
  >();
  for (const r of (rows ?? []) as Array<{
    engine: string;
    status: string;
    created_at?: string | null;
    ended_at?: string | null;
  }>) {
    const prev = latest.get(r.engine);
    const pt = new Date(prev?.created_at ?? prev?.ended_at ?? 0).getTime();
    const rt = new Date(r.created_at ?? r.ended_at ?? 0).getTime();
    if (!prev || rt >= pt) latest.set(r.engine, r);
  }
  const completed = new Set<string>();
  for (const [engine, row] of latest) {
    if (
      row.status === "completed" ||
      row.status === "completed_negative" ||
      row.status === "skipped"
    )
      completed.add(engine);
  }

  let ledgerResumeKey: string | undefined;
  let earliestIncompleteBlockingKey: string | undefined;
  for (const s of PIPELINE_STAGES) {
    const engine = PIPELINE_STAGE_TO_ENGINE[s.key];
    const isIncomplete = !engine || !completed.has(engine);
    if (isIncomplete && !ledgerResumeKey) ledgerResumeKey = s.key;
    if (isIncomplete && blockingStageKeys.has(s.key) && !earliestIncompleteBlockingKey) {
      earliestIncompleteBlockingKey = s.key;
    }
  }

  let resumeKey: string | undefined;
  if (
    earliestIncompleteBlockingKey &&
    (!persistedCandidate ||
      PIPELINE_STAGES.findIndex((s) => s.key === persistedCandidate) >
        PIPELINE_STAGES.findIndex((s) => s.key === earliestIncompleteBlockingKey))
  ) {
    resumeKey = earliestIncompleteBlockingKey;
  } else if (persistedCandidate) {
    resumeKey = persistedCandidate;
  } else {
    resumeKey = ledgerResumeKey;
  }
  if (!resumeKey) return { ok: true, alreadyComplete: true };

  const resumeEngine = PIPELINE_STAGE_TO_ENGINE[resumeKey];
  if (resumeEngine) {
    await supabase
      .from("pipeline_engine_runs")
      .update({
        status: "failed",
        ended_at: new Date().toISOString(),
        error: "Stale checkpoint cleared before auto-retry",
      })
      .eq("case_id", caseId)
      .eq("engine", resumeEngine)
      .in("status", ["queued", "running"]);
  }

  const scoringIdx = PIPELINE_STAGES.findIndex((s) => s.key === "scoring");
  const resumeIdx = PIPELINE_STAGES.findIndex((s) => s.key === resumeKey);
  const invalidatesScore = scoringIdx === -1 || resumeIdx === -1 || resumeIdx <= scoringIdx;

  const queuedAt = new Date().toISOString();
  await supabase
    .from("cases")
    .update({
      status: "queued",
      status_message: `Auto-retry after stall — resuming at ${resumeKey}`,
      queued_at: queuedAt,
      worker_lease_until: null,
      next_stage: resumeKey,
      cancel_requested: false,
      stall_reason: null,
      error: null,
      stall_auto_retry_count: nextRetryCount,
      ...(invalidatesScore ? { scored_at: null } : {}),
    })
    .eq("id", caseId);

  return { ok: true, resumeKey };
}

export const clearPipelineStuckState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "ClearPipelineStuckState");
    const { PIPELINE_STAGE_TO_ENGINE } = await import("@/lib/execution/canonical");
    const stageKeys = new Set<string>(PIPELINE_STAGES.map((s) => s.key));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: caseRow, error: caseErr } = await (supabase as any)
      .from("cases")
      .select("status,next_stage,worker_lease_until")
      .eq("id", data.caseId)
      .maybeSingle();
    if (caseErr) throw new Error(caseErr.message);
    if (!caseRow) throw new Error("Case not found");
    const leaseUntil = caseRow.worker_lease_until
      ? new Date(caseRow.worker_lease_until as string).getTime()
      : 0;
    if (leaseUntil > Date.now()) {
      return {
        ok: false,
        alreadyRunning: true as const,
        status: (caseRow.status as string | null) ?? null,
        leaseUntil: (caseRow.worker_lease_until as string | null) ?? null,
      };
    }

    const persistedNext = typeof caseRow.next_stage === "string" ? caseRow.next_stage : null;
    let resumeKey =
      persistedNext && persistedNext !== "reset" && stageKeys.has(persistedNext)
        ? persistedNext
        : undefined;
    if (!resumeKey) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: rows, error: rowsErr } = await (supabase as any)
        .from("pipeline_engine_runs")
        .select("engine,status,ended_at,created_at")
        .eq("case_id", data.caseId);
      if (rowsErr) throw new Error(rowsErr.message);
      const latest = new Map<
        string,
        { status: string; created_at?: string | null; ended_at?: string | null }
      >();
      for (const r of (rows ?? []) as Array<{
        engine: string;
        status: string;
        created_at?: string | null;
        ended_at?: string | null;
      }>) {
        const prev = latest.get(r.engine);
        const pt = new Date(prev?.created_at ?? prev?.ended_at ?? 0).getTime();
        const rt = new Date(r.created_at ?? r.ended_at ?? 0).getTime();
        if (!prev || rt >= pt) latest.set(r.engine, r);
      }
      const completed = new Set<string>();
      for (const [engine, row] of latest) {
        if (
          row.status === "completed" ||
          row.status === "completed_negative" ||
          row.status === "skipped"
        ) {
          completed.add(engine);
        }
      }
      for (const s of PIPELINE_STAGES) {
        const engine = PIPELINE_STAGE_TO_ENGINE[s.key];
        if (!engine || !completed.has(engine)) {
          resumeKey = s.key;
          break;
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("pipeline_engine_runs")
      .update({
        status: "failed",
        ended_at: new Date().toISOString(),
        error: "Manual stuck-state clear",
      })
      .eq("case_id", data.caseId)
      .in("status", ["queued", "running"]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateErr } = await (supabase as any)
      .from("cases")
      .update({
        status: "failed",
        status_message: resumeKey
          ? `Stuck state cleared — click Resume to continue at ${resumeKey}`
          : "Stuck state cleared — no incomplete stage found",
        queued_at: null,
        worker_lease_until: null,
        next_stage: resumeKey ?? null,
        cancel_requested: false,
        stall_reason: "manual_clear",
        error: null,
      })
      .eq("id", data.caseId);
    if (updateErr) throw new Error(updateErr.message);
    // Clearing a stuck case must also clear the in-memory AI runtime state:
    // provider cooldowns and cached credentials. Otherwise "Limpiar estado"
    // looks like a no-op — the resume fails instantly with "all keys cooling
    // down" even when brand-new keys were just added.
    let clearedCooldowns = 0;
    try {
      const { resetAiRuntimeState } = await import("@/lib/ai/router.server");
      ({ clearedCooldowns } = resetAiRuntimeState({ userId }));
    } catch (e) {
      console.warn("[clearPipelineStuckState] AI runtime reset failed", e);
    }
    const { trace } = await import("@/lib/pipeline-trace.server");
    await trace({
      db: supabase,
      caseId: data.caseId,
      userId,
      phase: "queue",
      step: "stuck_state.cleared",
      status: "ok",
      detail: { resumeKey: resumeKey ?? null, clearedCooldowns },
    });
    return { ok: true, resumeKey: resumeKey ?? null, clearedCooldowns };
  });

// -------- Case AI Chat --------
async function assertCaseOwner(
  supabase: Awaited<ReturnType<typeof getAuthedContext>>["supabase"],
  caseId: string,
  userId: string,
) {
  const { data, error } = await supabase
    .from("cases")
    .select("id")
    .eq("id", caseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) throw new Error("Case not found");
}

export const askCaseAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        question: z.string().min(1).max(4000),
        // Locale the attorney currently has the UI set to (from the ES/EN
        // toggle). Optional for backward compatibility with older clients —
        // falls back to the case's stored report_language when omitted.
        locale: z.enum(["es", "en"]).optional(),
        // Voice Companion turn — reply is spoken aloud, so ask for a short
        // plain-speech answer instead of a markdown brief.
        voiceMode: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Case AI");
    await assertCaseOwner(supabase, data.caseId, userId);
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    // Resolve Groq keys as the preferred primary, but do NOT force a Groq-only
    // chain. Pass userId so the router additionally loads every other active
    // provider the user has configured (Gemini, OpenAI, etc.) and falls back
    // to them when Groq is disabled, unauthorized, or rate-limited.
    const { keys, userKeyCount } = await resolveProviderKeys(supabase, userId, "groq");
    const activeKey = keys[0] ?? "";

    // Talk-to-Case is metered separately from the general AI request pool —
    // it performs continuous AI reasoning and is treated as a premium
    // resource (see usage.server.ts / product spec). BYOK bypasses it.
    const { checkAndConsumeUsage, usageExceededMessage } = await import("@/lib/usage.server");
    const usage = await checkAndConsumeUsage({
      userId,
      kind: "talk_to_case",
      feature: "talk_to_case",
      caseId: data.caseId,
      byokActive: userKeyCount > 0,
    });
    if (!usage.allowed) {
      throw new Error(usageExceededMessage("Talk-to-Case", usage));
    }

    const { answerCaseQuestion } = await import("@/lib/intelligence/chat.server");
    return await answerCaseQuestion({
      db: supabase,
      caseId: data.caseId,
      userId,
      apiKey: activeKey,
      apiKeys: keys,
      question: data.question,
      locale: data.locale,
      voiceMode: data.voiceMode,
    });
  });

export const getCaseChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Chat history");
    await assertCaseOwner(supabase, data.caseId, userId);
    const { data: rows } = await supabase
      .from("case_chat_messages")
      .select("id,role,content,created_at,metadata")
      .eq("case_id", data.caseId)
      .order("created_at");
    return rows ?? [];
  });

export const clearCaseChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Clear chat");
    await assertCaseOwner(supabase, data.caseId, userId);
    await supabase.from("case_chat_messages").delete().eq("case_id", data.caseId);
    return { ok: true };
  });

// -------- Settings (Groq API key management) --------

// List the current user's Groq keys (masked) plus platform availability
export const listGroqKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "ListKeys");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("user_groq_keys")
      .select(
        "id,label,key_value,priority,is_active,last_used_at,last_error,last_error_at,created_at",
      )
      .eq("user_id", userId)
      .order("priority", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    const rows = (data ?? []) as Array<{
      id: string;
      label: string;
      key_value: string;
      priority: number | null;
      is_active: boolean;
      last_used_at: string | null;
      last_error: string | null;
      last_error_at: string | null;
      created_at: string;
    }>;
    const platformConfigured = Boolean(process.env.GROQ_API_KEY);

    // Per-key usage rollup (last 30 days) — now attributed via groq_key_id.
    // Falls back to the created-at slicing heuristic for historical rows
    // that predate the groq_key_id column (backfill covers most but not all).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: usageRows } = await (supabase as any)
      .from("ai_usage")
      .select("total_tokens,input_tokens,output_tokens,success,created_at,groq_key_id")
      .eq("user_id", userId)
      .gte("created_at", new Date(Date.now() - 30 * 86400 * 1000).toISOString())
      .limit(5000);
    const usage = (usageRows ?? []) as Array<{
      total_tokens: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      success: boolean;
      created_at: string;
      groq_key_id: string | null;
    }>;
    const now = new Date();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();

    return {
      provider: "Groq",
      model: "Llama 4 Scout (17B 16E Instruct)",
      platformConfigured,
      keys: rows.map((r, i) => {
        const nextAt = rows[i + 1]?.created_at ?? null;
        // Prefer attributed rows (groq_key_id === r.id). Fall back to
        // created-at slicing only for legacy rows with null groq_key_id.
        const attributed = usage.filter((u) => u.groq_key_id === r.id);
        const legacy = usage.filter(
          (u) =>
            u.groq_key_id == null &&
            u.created_at >= r.created_at &&
            (!nextAt || u.created_at < nextAt),
        );
        const slice = [...attributed, ...legacy];
        const tokensOf = (arr: typeof slice) =>
          arr.reduce(
            (a, b) => a + (b.total_tokens ?? (b.input_tokens ?? 0) + (b.output_tokens ?? 0)),
            0,
          );
        const tokens30d = tokensOf(slice);
        const today = slice.filter((u) => u.created_at >= dayStart);
        return {
          id: r.id,
          label: r.label,
          masked:
            r.key_value.length > 10 ? `${r.key_value.slice(0, 4)}…${r.key_value.slice(-4)}` : "•••",
          priority: r.priority ?? i + 1,
          is_active: r.is_active,
          last_used_at: r.last_used_at,
          last_error: r.last_error,
          last_error_at: r.last_error_at,
          created_at: r.created_at,
          usage30d: {
            tokens: tokens30d,
            calls: slice.length,
            failures: slice.filter((s) => !s.success).length,
          },
          usageToday: { tokens: tokensOf(today), calls: today.length },
          attributed: attributed.length,
          legacy: legacy.length,
        };
      }),
    };
  });

// Add a new key. New keys are appended at the end of the priority chain.
export const addGroqKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        apiKey: z.string().min(10).max(500),
        label: z.string().min(1).max(60).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "AddKey");
    const apiKey = data.apiKey.trim();
    if (!apiKey.startsWith("gsk_")) {
      throw new Error(
        `Groq keys start with "gsk_". Paste the full key from console.groq.com/keys.`,
      );
    }
    const { pingProvider } = await import("@/lib/groq.server");
    const probe = await pingProvider("groq", apiKey);
    if (!probe.ok) {
      const err = probe.error ?? "unknown error";
      const hint = /invalid_api_key|401/i.test(err)
        ? " — Groq says this key is invalid. Likely causes: the key was revoked/deleted at console.groq.com/keys, a character was missed when copying, or it belongs to a different Groq org. Generate a fresh key and paste it whole."
        : "";
      throw new Error(`Groq rejected this key: ${err}${hint}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (supabase as any)
      .from("user_groq_keys")
      .select("priority")
      .eq("user_id", userId);
    const maxPrio = ((existing ?? []) as Array<{ priority: number | null }>).reduce(
      (m, r) => Math.max(m, r.priority ?? 0),
      0,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("user_groq_keys").insert({
      user_id: userId,
      label: data.label ?? "Primary",
      key_value: apiKey,
      is_active: true,
      priority: maxPrio + 1,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Update the priority (try-order) of a single key. Lower number = tried first.
export const setGroqKeyPriority = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), priority: z.number().int().min(1).max(999) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "SetPriority");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("user_groq_keys")
      .update({ priority: data.priority })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Turn a saved Groq key on or off. Inactive keys are skipped entirely by
// resolveGroqKeys, so this lets a user go Groq-off / other-provider-only
// without deleting their Groq keys.
export const toggleGroqKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), isActive: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "ToggleKey");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("user_groq_keys")
      .update({ is_active: data.isActive })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const replaceGroqKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), apiKey: z.string().min(10).max(500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "ReplaceKey");
    const apiKey = data.apiKey.trim();
    if (!apiKey.startsWith("gsk_")) {
      throw new Error(
        `Groq keys start with "gsk_". Paste the full key from console.groq.com/keys.`,
      );
    }
    const { pingProvider } = await import("@/lib/groq.server");
    const probe = await pingProvider("groq", apiKey);
    if (!probe.ok) {
      const err = probe.error ?? "unknown error";
      const hint = /invalid_api_key|401/i.test(err)
        ? " — Groq says this key is invalid. Likely causes: the key was revoked/deleted at console.groq.com/keys, a character was missed when copying, or it belongs to a different Groq org."
        : "";
      throw new Error(`Groq rejected this key: ${err}${hint}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("user_groq_keys")
      .update({ key_value: apiKey, last_error: null, last_error_at: null })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteGroqKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "DeleteKey");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("user_groq_keys")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Test the ACTIVE key only. We deliberately do NOT walk the full key chain
// here — a single revoked/expired backup key would otherwise poison the
// result and show a chain failure even when the active key works.
export const testGroqConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "TestKey");
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const { pingProvider } = await import("@/lib/groq.server");
    const { keys } = await resolveProviderKeys(supabase, userId, "groq");
    if (keys.length === 0) {
      return { ok: false, error: "No Groq API key configured.", source: null };
    }
    const t0 = Date.now();
    const ping = await pingProvider("groq", keys[0]);
    if (!ping.ok) {
      return { ok: false, error: ping.error ?? "Unknown error", source: "ping", keyIndex: 0 };
    }
    return {
      ok: true,
      latencyMs: ping.latencyMs ?? Date.now() - t0,
      model: "groq active key",
      sampleOutput: "online",
      keyIndex: 0,
    };
  });

// Current-user token usage rollup — scoped to the currently active Groq key
// so adding/activating a new key resets the visible counters to zero.
export const getGroqUsageSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Usage");
    const now = new Date();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    // Load all saved user keys (ordered) so per-key breakdown is available
    // regardless of which key is "newest".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: keyRows } = await (supabase as any)
      .from("user_groq_keys")
      .select("id,label,key_value,priority,created_at")
      .eq("user_id", userId)
      .order("priority", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    const allKeys = (keyRows ?? []) as Array<{
      id: string;
      label: string;
      key_value: string;
      priority: number | null;
      created_at: string;
    }>;

    // Aggregate counters are scoped to the MOST RECENTLY added key so that
    // adding a new key visibly resets the top-line usage (today + month) —
    // matches prior behaviour. Per-key rows below always show real totals.
    const newestKeyAt: string | null = allKeys.length
      ? allKeys.reduce((max, k) => (k.created_at > max ? k.created_at : max), allKeys[0].created_at)
      : null;
    const monthFloor = newestKeyAt && newestKeyAt > monthStart ? newestKeyAt : monthStart;
    const dayFloor = newestKeyAt && newestKeyAt > dayStart ? newestKeyAt : dayStart;

    const { data: rows } = await supabase
      .from("ai_usage")

      .select(
        "input_tokens,output_tokens,total_tokens,success,created_at,operation,groq_key_id" as any,
      )
      .eq("user_id", userId)
      .gte("created_at", monthStart)
      .order("created_at", { ascending: false })
      .limit(5000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (rows ?? []) as any[];
    const sumTok = (arr: typeof list) =>
      arr.reduce(
        (a, b) => a + (b.total_tokens ?? (b.input_tokens ?? 0) + (b.output_tokens ?? 0)),
        0,
      );

    // Aggregate top-line (matches prior floors).
    const monthList = list.filter((r) => r.created_at >= monthFloor);
    const todayList = monthList.filter((r) => r.created_at >= dayFloor);

    const DAILY_LIMIT_PER_KEY = 500_000;

    // Per-key breakdown across ALL saved keys — attributed via groq_key_id,
    // with created-at slicing as a fallback for legacy rows.
    const perKey = allKeys.map((k, i) => {
      const nextAt = allKeys[i + 1]?.created_at ?? null;
      const attributed = list.filter((r) => r.groq_key_id === k.id);
      const legacy = list.filter(
        (r) =>
          r.groq_key_id == null &&
          r.created_at >= k.created_at &&
          (!nextAt || r.created_at < nextAt),
      );
      const scoped = [...attributed, ...legacy];
      const monthArr = scoped;
      const todayArr = scoped.filter((r) => r.created_at >= dayStart);
      const tokensToday = sumTok(todayArr);
      return {
        id: k.id,
        label: k.label,
        masked:
          k.key_value.length > 10 ? `${k.key_value.slice(0, 4)}…${k.key_value.slice(-4)}` : "•••",
        priority: k.priority ?? i + 1,
        tokensToday,
        tokensMonth: sumTok(monthArr),
        callsToday: todayArr.length,
        callsMonth: monthArr.length,
        failuresMonth: monthArr.filter((r) => !r.success).length,
        remainingToday: Math.max(0, DAILY_LIMIT_PER_KEY - tokensToday),
        attributed: attributed.length,
        legacy: legacy.length,
      };
    });

    return {
      tokensToday: sumTok(todayList),
      tokensMonth: sumTok(monthList),
      callsToday: todayList.length,
      callsMonth: monthList.length,
      failuresMonth: monthList.filter((r) => !r.success).length,
      dailyTokenLimit: DAILY_LIMIT_PER_KEY,
      remainingToday: Math.max(0, DAILY_LIMIT_PER_KEY - sumTok(todayList)),
      // New: per-key rotation visibility.
      perKey,
      totalKeys: allKeys.length,
      combinedDailyLimit: DAILY_LIMIT_PER_KEY * Math.max(1, allKeys.length),
      combinedRemainingToday: perKey.reduce((a, k) => a + k.remainingToday, 0),

      activeKeyAt: newestKeyAt,
      recent: list.slice(0, 12).map((r) => ({
        operation: r.operation,
        tokens: r.total_tokens ?? (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
        success: r.success,
        created_at: r.created_at,
        groq_key_id: r.groq_key_id ?? null,
      })),
    };
  });

// -------- Health Check / Diagnostics (all configured providers) --------
async function assertHealthAdmin(context: unknown, label: string) {
  const { supabase, userId } = await getAuthedContext(context as never, label);
  const { data: adminRole } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!adminRole) throw new Error("Forbidden");
  return { supabase, userId };
}

export const getAiHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await assertHealthAdmin(context, "Health");
    const { getLlmDiagnostics, pingProvider, assertEnv } = await import("@/lib/groq.server");
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const {
      listProviderRows,
      getProviderInputBudget,
      invalidateProviderCaches,
      clearAiProviderCooldowns,
    } = await import("@/lib/ai/router.server");

    // Refreshing this page is the user's "clear the stuck state" gesture:
    // drop the cached provider/key rows so newly added keys are seen right
    // away instead of after the cache TTL.
    invalidateProviderCaches(userId);

    const rows = await listProviderRows();
    const diag = getLlmDiagnostics();

    // Probe EVERY enabled provider with the SAME credential set production
    // uses (user_ai_keys first, stored/env row only as a fallback signal).
    const probes = await Promise.all(
      rows
        .filter((r) => r.enabled !== false)
        .map(async (r) => {
          const type = r.provider_type as
            | "groq"
            | "openai"
            | "anthropic"
            | "gemini"
            | "openrouter"
            | "ollama"
            | "lmstudio";
          let keys: string[] = [];
          try {
            ({ keys } = await resolveProviderKeys(supabase, userId, type as never));
          } catch {
            keys = [];
          }
          // Probe EVERY key, not just the first. A single exhausted key must
          // not keep the card red after the user adds a fresh one.
          let ping: { ok: boolean; latencyMs: number; error?: string } = {
            ok: false,
            latencyMs: 0,
            error: "No key configured.",
          };
          let okKeys = 0;
          const keyErrors: string[] = [];
          const candidates = keys.length > 0 ? keys : [undefined];
          for (let i = 0; i < candidates.length; i++) {
            let r: { ok: boolean; latencyMs: number; error?: string };
            try {
              r = candidates[i]
                ? await pingProvider(type, candidates[i]!)
                : await pingProvider(type);
            } catch (e) {
              r = { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : String(e) };
            }
            if (r.ok) {
              okKeys++;
              if (!ping.ok) ping = r;
            } else {
              keyErrors.push(`key ${i + 1}: ${r.error ?? "failed"}`);
              if (!ping.ok && i === 0) ping = r;
            }
          }
          // Any healthy key means the provider is usable — drop the stale error.
          if (okKeys > 0) {
            ping = { ...ping, ok: true, error: undefined };
            // A live probe proves the provider is usable again — release any
            // cooldown left over from an earlier 429/quota bounce so the next
            // pipeline run stops skipping it.
            try {
              clearAiProviderCooldowns(type as never, null);
            } catch {
              /* non-fatal */
            }
          } else if (keyErrors.length) ping = { ...ping, ok: false, error: keyErrors.join(" · ") };
          const stats = diag.byProvider?.[type] ?? { totalOk: 0, totalErr: 0 };
          return [
            type,
            {
              ...ping,
              provider: type,
              displayName: r.display_name ?? type,
              model: r.default_model ?? null,
              priority: r.priority ?? null,
              configured: keys.length > 0 || Boolean(r.api_key_encrypted) || Boolean(r.secret_name),
              keyCount: keys.length,
              okKeyCount: okKeys,
              inputTokenBudget: getProviderInputBudget(type),
              totalOk: stats.totalOk ?? 0,
              totalErr: stats.totalErr ?? 0,
              lastError: (stats as { lastError?: string }).lastError ?? null,
              lastErrorTs: (stats as { lastErrorTs?: number }).lastErrorTs ?? null,
            },
          ] as const;
        }),
    );

    const providers = Object.fromEntries(probes) as Record<
      string,
      {
        ok: boolean;
        latencyMs: number;
        error?: string;
        provider: string;
        displayName: string;
        model: string | null;
        priority: number | null;
        configured: boolean;
        keyCount: number;
        okKeyCount: number;
        inputTokenBudget: number;
        totalOk: number;
        totalErr: number;
        lastError: string | null;
        lastErrorTs: number | null;
      }
    >;

    let backendOk = false;
    let backendErr: string | undefined;
    const t0 = Date.now();
    try {
      const { error } = await supabase
        .from("cases")
        .select("id", { count: "exact", head: true })
        .limit(1);
      backendOk = !error;
      if (error) backendErr = error.message;
    } catch (e) {
      backendErr = e instanceof Error ? e.message : String(e);
    }
    const backendLatency = Date.now() - t0;
    const env = assertEnv();
    const configuredList = Object.values(providers).filter((p) => p.configured);
    const active =
      configuredList.length > 0
        ? `${configuredList.length} provider${configuredList.length === 1 ? "" : "s"} configured`
        : null;

    return {
      providers,
      backend: { ok: backendOk, latencyMs: backendLatency, error: backendErr },
      supabase: { ok: backendOk, latencyMs: backendLatency, error: backendErr },
      env,
      active,
      failovers: diag.failovers,
      cacheHits: diag.cacheHits,
      totalCalls: diag.totalCalls,
      cacheSize: diag.cacheSize,
      lastSuccess: diag.lastSuccess,
      lastError: diag.lastError,
      last: diag.last,
      recent: diag.history,
    };
  });

// -------- Live provider probe (single provider or all) --------
// Forces a real prompt through each provider using the SAME per-user key set
// production uses (user_ai_keys), with no cross-provider fallback so a failure
// is attributed to the provider that actually failed.
type ProbeResult =
  | {
      provider: string;
      ok: true;
      model: string;
      latencyMs: number;
      inputTokens?: number;
      outputTokens?: number;
      output: string;
      keyIndex?: number;
    }
  | { provider: string; ok: false; error: string };

export const runFailoverTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const v = (input ?? {}) as { provider?: string | null };
    return { provider: typeof v.provider === "string" && v.provider ? v.provider : null };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await assertHealthAdmin(context, "Provider probe");
    const { callGroq } = await import("@/lib/groq.server");
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const { listProviderRows } = await import("@/lib/ai/router.server");

    const rows = (await listProviderRows()).filter((r) => r.enabled !== false);
    const targets = data.provider ? rows.filter((r) => r.provider_type === data.provider) : rows;

    const prompt =
      "Return a single sentence confirming you are responding. Include the word 'online'.";
    const sys = "You are a diagnostic responder. Keep replies under 30 words.";
    const results: ProbeResult[] = [];

    for (const row of targets) {
      const type = row.provider_type;
      let keys: string[] = [];
      try {
        ({ keys } = await resolveProviderKeys(supabase, userId, type as never));
      } catch {
        keys = [];
      }
      if (keys.length === 0) {
        results.push({
          provider: type,
          ok: false,
          error: `No ${type} API key configured for this user. Add one in Intelligence Providers.`,
        });
        continue;
      }
      try {
        const r = await callGroq({
          forceProvider: type,
          runtimeProvider: type,
          apiKeys: keys,
          systemInstruction: sys,
          userContent: prompt,
          // Reasoning models spend tokens internally before the visible
          // answer; 500 leaves headroom for a one-off diagnostic call.
          maxTokens: 500,
          cache: false,
        });
        results.push({
          provider: type,
          ok: true,
          model: r.model,
          latencyMs: r.latencyMs,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          output: r.text.slice(0, 240),
          keyIndex: r.keyIndex,
        });
      } catch (e) {
        results.push({
          provider: type,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (results.length === 0) {
      results.push({
        provider: data.provider ?? "none",
        ok: false,
        error: "No enabled providers found.",
      });
    }
    return { ts: Date.now(), results };
  });

// -------- Downloadable AI failure log (CSV source rows) --------
export const getAiErrorLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const v = (input ?? {}) as { days?: number; onlyFailures?: boolean; limit?: number };
    return {
      days: Number.isFinite(v.days) ? Math.min(90, Math.max(1, Number(v.days))) : 7,
      onlyFailures: v.onlyFailures !== false,
      limit: Number.isFinite(v.limit) ? Math.min(5000, Math.max(1, Number(v.limit))) : 2000,
    };
  })
  .handler(async ({ data, context }) => {
    const { supabase } = await assertHealthAdmin(context, "AI error log");
    const since = new Date(Date.now() - data.days * 86_400_000).toISOString();
    let q = supabase
      .from("ai_usage")
      .select(
        "created_at,provider_type,model,operation,success,error,latency_ms,input_tokens,output_tokens,total_tokens,case_id",
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.onlyFailures) q = q.eq("success", false);
    const { data: rowsRaw, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (rowsRaw ?? []) as Array<Record<string, unknown>>;

    // Group failures by (provider, reason) so the export doubles as a summary.
    const classify = (msg: string): string => {
      const m = msg.toLowerCase();
      if (/429|rate.?limit|quota|tokens per/.test(m)) return "rate_limit_or_quota";
      if (/413|too large|payload|context length|exceeds/.test(m)) return "payload_too_large";
      if (/401|403|unauthor|invalid api key|permission/.test(m)) return "auth_or_key";
      if (/404|not found|model/.test(m)) return "model_unavailable";
      if (/timeout|timed out|abort/.test(m)) return "timeout";
      if (/5\d\d|overload|unavailable|high demand/.test(m)) return "provider_unavailable";
      if (/json|parse/.test(m)) return "bad_response_format";
      return "other";
    };

    const summaryMap = new Map<
      string,
      { provider: string; reason: string; count: number; lastAt: string; sample: string }
    >();
    const enriched = rows.map((r) => {
      const provider = String(r.provider_type ?? "unknown");
      const err = String(r.error ?? "");
      const reason = r.success ? "ok" : classify(err);
      if (!r.success) {
        const key = `${provider}::${reason}`;
        const prev = summaryMap.get(key);
        if (prev) prev.count += 1;
        else
          summaryMap.set(key, {
            provider,
            reason,
            count: 1,
            lastAt: String(r.created_at ?? ""),
            sample: err.slice(0, 300),
          });
      }
      return {
        created_at: String(r.created_at ?? ""),
        provider,
        model: String(r.model ?? ""),
        operation: String(r.operation ?? ""),
        success: Boolean(r.success),
        reason,
        error: err.slice(0, 500),
        latency_ms: (r.latency_ms as number) ?? null,
        input_tokens: (r.input_tokens as number) ?? null,
        output_tokens: (r.output_tokens as number) ?? null,
        total_tokens: (r.total_tokens as number) ?? null,
        case_id: (r.case_id as string) ?? null,
      };
    });

    return {
      ts: Date.now(),
      days: data.days,
      onlyFailures: data.onlyFailures,
      rows: enriched,
      summary: [...summaryMap.values()].sort((a, b) => b.count - a.count),
    };
  });

// -------- AI cooldown admin (in-memory router circuit-breaker) --------
export const listAiCooldowns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Cooldowns");
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!adminRole) throw new Error("Forbidden");
    const { listGroqCooldowns } = await import("@/lib/ai/router.server");
    return { ts: Date.now(), cooldowns: listGroqCooldowns() };
  });

export const clearAiCooldowns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const v = (input ?? {}) as { model?: string | null };
    return { model: typeof v.model === "string" && v.model.length > 0 ? v.model : null };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Cooldowns");
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!adminRole) throw new Error("Forbidden");
    const { clearGroqCooldowns, listGroqCooldowns } = await import("@/lib/ai/router.server");
    const cleared = clearGroqCooldowns(data.model);
    // Voice keeps its own short cooldown map (TTS/STT rotation); clearing
    // text cooldowns without it left voice still avoiding a recovered key.
    const { clearVoiceCooldowns } = await import("@/lib/ai-key-router.server");
    clearVoiceCooldowns();
    return { ts: Date.now(), cleared, model: data.model, remaining: listGroqCooldowns() };
  });
/**
 * Tiny probe used by the app-shell pipeline driver: ids of this user's cases
 * that are queued/running. Deliberately separate from `listCases` (which is
 * a heavy dashboard aggregate) because the shell polls this every 10s.
 */
export const listActivePipelineCases = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = await getAuthedContext(context, "ActivePipelines");
    const ACTIVE = [
      "queued",
      "uploaded",
      "extracting",
      "analyzing",
      "scoring",
      "reporting",
      "intelligence_running",
    ] as const;
    const { data, error } = await supabase
      .from("cases")
      .select("id")
      .is("deleted_at", null)
      .in("status", ACTIVE as unknown as Database["public"]["Enums"]["case_status"][])
      .limit(50);
    if (error) {
      console.warn("[cases] listActivePipelineCases query warning:", error.message);
      return [];
    }
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  });

export const listCases = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = await getAuthedContext(context, "Cases");
    const { data, error } = await supabase
      .from("cases")
      .select(
        "id,name,status,progress,status_message,created_at,completed_at,archived_at,cancel_requested",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const cases = data ?? [];
    if (cases.length === 0) return [];
    const ids = cases.map((c) => c.id);

    // Mission Control's dashboard cards (score, witnesses, contradictions,
    // discovery gaps, high-priority findings) previously always read as
    // placeholders ("—" / 0) because listCases never fetched anything
    // beyond the bare case row — the data existed in `reports`,
    // `case_findings`, and `case_witnesses`, the dashboard just never
    // asked for it. Batch-fetch those the same way listAlerts() already
    // does, then fold the counts onto each case row so every dashboard
    // widget reads from this one source of truth instead of drifting.
    const [reportsRes, findingsRes, witnessesRes] = await Promise.all([
      supabase
        .from("reports")
        .select(
          "case_id,case_strength_score,risk_score,findings_count,contradictions_struct,missing_evidence_struct",
        )
        .in("case_id", ids),
      supabase
        .from("case_findings")
        .select("case_id,severity")
        .in("case_id", ids)
        .not("source_module", "like", PROJECTION_LIKE),
      supabase.from("case_witnesses").select("case_id").in("case_id", ids),
    ]);

    const reportByCase = new Map((reportsRes.data ?? []).map((r) => [r.case_id, r]));
    // Phase 1: the high-priority rule goes through the unified selector so
    // this badge and the report/scorecard can never disagree on what counts.
    // Options reproduce the previous inline filter exactly (every source
    // class, provisional included, critical|high only).
    const highPriorityByCase = new Map<string, number>();
    for (const f of selectFindings(findingsRes.data ?? [], {
      include: ["engine", "agent", "analyzer", "other"],
      includeProvisional: true,
      severities: ["critical", "high"],
    })) {
      highPriorityByCase.set(f.case_id, (highPriorityByCase.get(f.case_id) ?? 0) + 1);
    }
    const witnessCountByCase = new Map<string, number>();
    for (const w of witnessesRes.data ?? []) {
      witnessCountByCase.set(w.case_id, (witnessCountByCase.get(w.case_id) ?? 0) + 1);
    }

    return cases.map((c) => {
      const r = reportByCase.get(c.id);
      const contradictionCount = Array.isArray(r?.contradictions_struct)
        ? r!.contradictions_struct.length
        : null;
      const discoveryGapCount = Array.isArray(r?.missing_evidence_struct)
        ? r!.missing_evidence_struct.length
        : null;
      return {
        ...c,
        score: r?.case_strength_score ?? null,
        risk_score: r?.risk_score ?? null,
        findings_count: r?.findings_count ?? null,
        high_priority_findings: highPriorityByCase.get(c.id) ?? 0,
        witness_count: witnessCountByCase.get(c.id) ?? 0,
        contradiction_count: contradictionCount,
        discovery_gap_count: discoveryGapCount,
      };
    });
  });

// -------- Alerts feed (cross-case) --------
/** Reminders (hearings/events + task deadlines) due within 3 days, or
 * overdue, as alert items — surfaced on the Alerts & Briefings page
 * ("the notifications") independent of the recently-updated-cases list
 * below, since a reminder's case may not have changed recently. */
async function reminderAlerts(
  supabase: Db,
  userId: string,
): Promise<
  Array<{
    key: string;
    caseId: string;
    caseName: string;
    level: "info" | "warning" | "critical";
    title: string;
    detail?: string | null;
    at: string;
  }>
> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 3 * 86400000);
  const grace = new Date(now.getTime() - 2 * 3600000);

  type EvRow = { id: string; case_id: string; title: string; scheduled_at: string };
  type TaskRow = { id: string; case_id: string; title: string; due_date: string };

  const [eventsRes, tasksRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.from("case_events") as any)
      .select("id, case_id, title, scheduled_at")
      .eq("user_id", userId)
      .eq("reminder_enabled", true)
      .gte("scheduled_at", grace.toISOString())
      .lte("scheduled_at", horizon.toISOString()) as Promise<{ data: EvRow[] | null }>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.from("case_tasks") as any)
      .select("id, case_id, title, due_date")
      .eq("user_id", userId)
      .eq("reminder_enabled", true)
      .in("status", ["todo", "in_progress", "blocked"])
      .not("due_date", "is", null)
      .lte("due_date", horizon.toISOString().slice(0, 10)) as Promise<{ data: TaskRow[] | null }>,
  ]);

  const caseIds = Array.from(
    new Set([
      ...(eventsRes.data ?? []).map((e) => e.case_id),
      ...(tasksRes.data ?? []).map((t) => t.case_id),
    ]),
  );
  if (caseIds.length === 0) return [];
  const { data: caseRows } = await supabase.from("cases").select("id,name").in("id", caseIds);
  const nameOf = new Map((caseRows ?? []).map((c) => [c.id, c.name]));
  const today = now.toISOString().slice(0, 10);

  const out: Array<{
    key: string;
    caseId: string;
    caseName: string;
    level: "info" | "warning" | "critical";
    title: string;
    detail?: string | null;
    at: string;
  }> = [];
  for (const e of eventsRes.data ?? []) {
    const overdue = new Date(e.scheduled_at).getTime() < now.getTime();
    out.push({
      key: `reminder:event:${e.id}`,
      caseId: e.case_id,
      caseName: nameOf.get(e.case_id) ?? "—",
      level: overdue ? "critical" : "warning",
      title: overdue
        ? `Audiencia/evento vencido: ${e.title}`
        : `Próxima audiencia/evento: ${e.title}`,
      detail: new Date(e.scheduled_at).toLocaleString("es-MX", { timeZone: "America/Mexico_City" }),
      at: e.scheduled_at,
    });
  }
  for (const t of tasksRes.data ?? []) {
    const overdue = t.due_date < today;
    out.push({
      key: `reminder:task:${t.id}`,
      caseId: t.case_id,
      caseName: nameOf.get(t.case_id) ?? "—",
      level: overdue ? "critical" : "warning",
      title: overdue ? `Vencimiento vencido: ${t.title}` : `Próximo vencimiento: ${t.title}`,
      detail: new Date(`${t.due_date}T12:00:00`).toLocaleDateString("es-MX"),
      at: `${t.due_date}T12:00:00.000Z`,
    });
  }
  return out;
}

export const listAlerts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Alerts");
    const reminders = await reminderAlerts(supabase, userId);
    const { data: cases } = await supabase
      .from("cases")
      .select("id,name,status,status_message,updated_at")
      .is("deleted_at", null)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(25);
    const list = cases ?? [];
    if (list.length === 0) return reminders as any[];
    const ids = list.map((c) => c.id);

    const [agents, findings, reports] = await Promise.all([
      supabase
        .from("agent_findings")
        .select("case_id,agent_type,summary,findings,updated_at")
        .in("case_id", ids),
      supabase
        .from("case_findings")
        .select("id,case_id,title,severity,created_at")
        .in("case_id", ids)
        .eq("severity", "critical")
        .not("source_module", "like", PROJECTION_LIKE)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("reports")
        .select("case_id,missing_evidence_report,updated_at")
        .in("case_id", ids),
    ]);

    const byCase = new Map(list.map((c) => [c.id, c]));
    const alerts: Array<{
      key: string;
      caseId: string;
      caseName: string;
      level: "info" | "warning" | "critical";
      title: string;
      detail?: string | null;
      at: string;
    }> = [];

    for (const a of agents.data ?? []) {
      const c = byCase.get(a.case_id);
      if (!c) continue;
      const isContradiction = /contradict/i.test(a.agent_type);
      const count = Array.isArray(a.findings) ? a.findings.length : 0;
      if (isContradiction && count > 0) {
        alerts.push({
          key: `${a.case_id}:contra:${count}:${a.updated_at}`,
          caseId: a.case_id,
          caseName: c.name,
          level: "warning",
          title: `${count} contradiction${count > 1 ? "s" : ""} detected`,
          detail: a.summary ?? null,
          at: a.updated_at as string,
        });
      }
    }

    // Group critical findings by case
    const critByCase = new Map<string, any[]>();
    for (const f of findings.data ?? []) {
      const arr = critByCase.get(f.case_id) ?? [];
      arr.push(f);
      critByCase.set(f.case_id, arr);
    }
    for (const [cid, arr] of critByCase) {
      const c = byCase.get(cid);
      if (!c) continue;
      alerts.push({
        key: `${cid}:crit:${arr.length}`,
        caseId: cid,
        caseName: c.name,
        level: "critical",
        title: `${arr.length} critical finding${arr.length > 1 ? "s" : ""}`,
        detail: arr[0]?.title ?? null,
        at: arr[0]?.created_at as string,
      });
    }

    for (const r of reports.data ?? []) {
      if (!r.missing_evidence_report) continue;
      const c = byCase.get(r.case_id);
      if (!c) continue;
      alerts.push({
        key: `${r.case_id}:missing:${r.updated_at}`,
        caseId: r.case_id,
        caseName: c.name,
        level: "info",
        title: "Discovery gaps identified",
        detail: (r.missing_evidence_report as string).slice(0, 240),
        at: r.updated_at as string,
      });
    }

    for (const c of list) {
      if (c.status === "failed") {
        alerts.push({
          key: `${c.id}:failed:${c.updated_at}`,
          caseId: c.id,
          caseName: c.name,
          level: "critical",
          title: "Pipeline failed",
          detail: c.status_message ?? null,
          at: c.updated_at as string,
        });
      }
    }

    alerts.push(...reminders);
    alerts.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
    return alerts.slice(0, 200);
  });

// -------- Workflow controls --------
export const renameCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ caseId: z.string().uuid(), name: z.string().min(1).max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "Rename");
    const { data: caseRow } = await supabase
      .from("cases")
      .select("matter_metadata")
      .eq("id", data.caseId)
      .maybeSingle();

    const mm = ((caseRow as any)?.matter_metadata as Record<string, unknown> | null) ?? {};
    const existingIdentity = (mm.case_identity as Record<string, unknown> | undefined) ?? {};
    const updatedIdentity = {
      ...existingIdentity,
      case_display_name: data.name,
      case_display_name_source: "user",
      case_display_name_confidence: 1.0,
      case_display_name_locked: true,
    };

    const { error } = await supabase
      .from("cases")
      .update({
        name: data.name,
        matter_metadata: {
          ...mm,
          case_identity: updatedIdentity,
        },
      } as any)
      .eq("id", data.caseId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// -------- Update case settings (case_type / analysis_mode) after upload --------
// Pure decision logic for updateCaseSettings' manual-override-vs-source-
// classification check — extracted so it's directly unit-testable without
// the createServerFn/auth-middleware plumbing. A requested case_type that
// matches a CONFIRMED source classification is recorded as source_confirmed
// (not flagged); one that disagrees is flagged via sourceConflict AND
// recorded as manual_override_conflicting so runCaseClassification's own
// write path (case-classification.server.ts) knows never to silently
// overwrite it later; no evidence yet (or evidence that isn't CONFIRMED)
// is a plain manual_override.
export function resolveCaseTypeSourceConflict(
  evidence: { status?: string; value?: string | null } | null,
  requestedCaseType: string | null,
): {
  sourceConflict: { field: "case_type"; sourceValue: string; requestedValue: string } | null;
  case_type_source: "source_confirmed" | "manual_override" | "manual_override_conflicting";
} {
  if (evidence?.status === "CONFIRMED" && evidence.value && evidence.value !== requestedCaseType) {
    return {
      sourceConflict: {
        field: "case_type",
        sourceValue: evidence.value,
        requestedValue: String(requestedCaseType),
      },
      case_type_source: "manual_override_conflicting",
    };
  }
  if (evidence?.status === "CONFIRMED" && evidence.value === requestedCaseType) {
    return { sourceConflict: null, case_type_source: "source_confirmed" };
  }
  return { sourceConflict: null, case_type_source: "manual_override" };
}

/**
 * Applies a `cases` patch, retrying once without case_type_source/
 * case_type_verification_status if the update fails — those two additive
 * columns (migration 20260809143021_case_classification_evidence.sql) may
 * not have propagated to every environment yet, and a single UPDATE
 * referencing a column Postgres doesn't recognize fails ATOMICALLY for the
 * WHOLE statement. Without this retry, a pending migration silently blocked
 * every OTHER field in the same save too (case_analysis_mode, analysis_mode,
 * jurisdiction...) — CaseControlPanel.tsx's settings form always bundles
 * case_type into every save, so case_type_source got computed and written
 * on every save from that panel regardless of what the attorney actually
 * changed. Extracted so it's directly unit-testable without the
 * createServerFn/auth-middleware plumbing.
 */
export async function updateCaseWithSchemaDriftRetry(
  supabase: Db,
  caseId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("cases")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update(patch as any)
    .eq("id", caseId);
  if (!error) return;
  const { case_type_source: _cts, case_type_verification_status: _ctvs, ...strippedPatch } = patch;
  const retry = await supabase
    .from("cases")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update(strippedPatch as any)
    .eq("id", caseId);
  if (retry.error) throw new Error(error.message);
  console.error(
    "updateCaseWithSchemaDriftRetry: recovered by saving without case_type_source/case_type_verification_status — a pending migration needs to be applied to this environment",
    { originalError: error },
  );
}

export const updateCaseSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        case_type: z.enum(CASE_TYPE_VALUES).nullable().optional(),
        analysis_mode: z.enum(["strict", "balanced", "exploratory"]).optional(),
        jurisdiction: z.enum(JURISDICTION_VALUES).nullable().optional(),
        case_analysis_mode: z
          .enum(["ongoing", "concluded_audit", "judgment_audit", "appeal_routes"])
          .optional(),
        procedural_vehicle: z.string().nullable().optional(),
        underlying_materia: z.string().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "UpdateCaseSettings");
    const patch: Record<string, unknown> = {};
    if (data.case_type !== undefined) patch.case_type = data.case_type;
    if (data.analysis_mode !== undefined) patch.analysis_mode = data.analysis_mode;
    if (data.jurisdiction !== undefined) patch.jurisdiction = data.jurisdiction;
    if (data.case_analysis_mode !== undefined) patch.case_analysis_mode = data.case_analysis_mode;
    if (data.procedural_vehicle !== undefined) patch.procedural_vehicle = data.procedural_vehicle;
    if (data.underlying_materia !== undefined) patch.underlying_materia = data.underlying_materia;

    // Manual case_type override vs. a source-confirmed classification
    // (case-classification.server.ts): the attorney may always override,
    // but a conflicting override must be flagged, not silent — and the
    // underlying evidence row is NEVER touched here, so the source
    // classification is always still visible/recoverable afterward. See
    // resolveVerifiedCaseType(), which downstream engines can call to
    // prefer the CONFIRMED source value over a conflicting override.
    let sourceConflict: { field: "case_type"; sourceValue: string; requestedValue: string } | null =
      null;
    if (data.case_type !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: evidenceRow } = await (supabase as any)
        .from("case_classification_evidence")
        .select("status,value")
        .eq("case_id", data.caseId)
        .eq("field", "case_type")
        .maybeSingle();
      const resolved = resolveCaseTypeSourceConflict(
        evidenceRow as { status?: string; value?: string | null } | null,
        data.case_type ?? null,
      );
      sourceConflict = resolved.sourceConflict;
      patch.case_type_source = resolved.case_type_source;
    }

    if (Object.keys(patch).length === 0) return { ok: true };

    // Read the current mode/case_type first so we can tell whether this save
    // actually changes either one. Mode decides which engines are ALLOWED to
    // write (see intelligence/case-state.server.ts): engines outside the
    // active mode raise StageSkippedError and get recorded as `skipped`.
    // Resume/rerun treats `skipped` as "already done", so without the
    // invalidation below, switching strict -> balanced -> exploratory (in
    // any direction) leaves every previously-skipped engine permanently
    // skipped and the rerun looks like it did nothing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: before } = await (supabase as any)
      .from("cases")
      .select("analysis_mode,case_type,case_analysis_mode,matter_metadata,jurisdiction,procedural_vehicle,underlying_materia")
      .eq("id", data.caseId)
      .maybeSingle();
    const previousMode = (before?.analysis_mode as string | null) ?? null;
    const previousCaseType = (before?.case_type as string | null) ?? null;
    const previousCaseAnalysisMode = (before?.case_analysis_mode as string | null) ?? "ongoing";
    const modeChanged = data.analysis_mode !== undefined && data.analysis_mode !== previousMode;
    // Case Analysis Mode (case-analysis-mode.ts) changes the OBJECTIVE every
    // analyzer/agent prompt is given (see analyzerPreamble/areaPreamble in
    // pipeline.server.ts) and gates whether ways_out_analysis even runs — not
    // just which engines may write, closer in blast radius to a materia
    // change than a strictness-mode change. Findings generated under the old
    // objective (e.g. "ongoing" case-prep framing) would otherwise sit
    // alongside a report now claiming a "completed case audit" posture.
    // Treated the same as caseTypeChanged: full derived-data reset.
    const caseAnalysisModeChanged =
      data.case_analysis_mode !== undefined && data.case_analysis_mode !== previousCaseAnalysisMode;
    // FIX: case_type had no invalidation at all — confirmed live: correcting
    // a misclassified materia (e.g. "constitucional" -> "amparo", the exact
    // Amparo Indirecto 412/2026 scenario mx-case-classifier.ts's own
    // regression test is modeled on) updated the field but left every
    // downstream artifact generated under the WRONG materia in place:
    // findings, the report's recommendations (e.g. "file a controversia
    // constitucional"), which specialized agents ran (materia-gated per
    // practice-areas.ts), and the procedural-compliance checklist
    // (case-type-standards.ts is keyed by case_type) all stayed stale and
    // resume/rerun treated them as "already done." A materia change
    // invalidates a strictly larger surface than a mode change — it's not
    // just which engines may WRITE, it's which engines are even ALLOWED to
    // RUN, plus every materia-specific prompt/checklist/agent-set — so this
    // reuses clearCaseDerivedData/CASE_RESET_FIELDS, the same "full rerun"
    // reset already used by queueCaseForPipeline's reset branch, rather than
    // inventing a second, narrower invalidation list that could miss
    // something. Documents/extracted text are preserved either way — only
    // derived analysis is cleared.
    const caseTypeChanged = data.case_type !== undefined && data.case_type !== previousCaseType;

    if (caseTypeChanged || caseAnalysisModeChanged) {
      await clearCaseDerivedData(supabase, data.caseId);
      Object.assign(patch, CASE_RESET_FIELDS);
      // clearCaseDerivedData/CASE_RESET_FIELDS don't touch case_type/
      // analysis_mode/case_analysis_mode/jurisdiction — patch's own values
      // for those (set above) are untouched by this merge.
    }

    if (modeChanged) {
      // Interpretive stages must be re-evaluated under the new mode's rules.
      patch.theories_at = null;
      patch.opportunities_at = null;
      patch.trial_prep_at = null;
      patch.witnesses_at = null;
      patch.perspectives_at = null;
      patch.evidence_intel_at = null;
      patch.strategy_at = null;
      patch.work_product_at = null;
      patch.report_at = null;
      patch.next_stage = null;
    }

    // Authoritative case_configuration update
    const { getCaseConfiguration } = await import("@/lib/intelligence/case-configuration");
    const currentConfig = getCaseConfiguration(before);
    const updatedConfig = {
      ...currentConfig,
      user_selected_case_type: data.case_type !== undefined ? data.case_type : currentConfig.user_selected_case_type,
      user_selected_jurisdiction: data.jurisdiction !== undefined ? data.jurisdiction : currentConfig.user_selected_jurisdiction,
      user_selected_analysis_mode: data.analysis_mode !== undefined ? data.analysis_mode : currentConfig.user_selected_analysis_mode,
      user_selected_case_analysis_mode: data.case_analysis_mode !== undefined ? data.case_analysis_mode : currentConfig.user_selected_case_analysis_mode,
      user_selected_procedural_vehicle: data.procedural_vehicle !== undefined ? data.procedural_vehicle : currentConfig.user_selected_procedural_vehicle,
      user_selected_underlying_materia: data.underlying_materia !== undefined ? data.underlying_materia : currentConfig.user_selected_underlying_materia,
      active_case_type: data.case_type !== undefined ? data.case_type : currentConfig.active_case_type,
      active_jurisdiction: data.jurisdiction !== undefined ? data.jurisdiction : currentConfig.active_jurisdiction,
      active_analysis_mode: data.analysis_mode !== undefined ? data.analysis_mode : currentConfig.active_analysis_mode,
      active_case_analysis_mode: data.case_analysis_mode !== undefined ? data.case_analysis_mode : currentConfig.active_case_analysis_mode,
      active_procedural_vehicle: data.procedural_vehicle !== undefined ? data.procedural_vehicle : currentConfig.active_procedural_vehicle,
      active_underlying_materia: data.underlying_materia !== undefined ? data.underlying_materia : currentConfig.active_underlying_materia,
      source: "manual_edit" as const,
      selected_at: new Date().toISOString(),
    };
    const currentMeta = (before?.matter_metadata as Record<string, unknown> | null) ?? {};
    patch.matter_metadata = { ...currentMeta, case_configuration: updatedConfig };

    await updateCaseWithSchemaDriftRetry(supabase, data.caseId, patch);

    if (modeChanged || caseAnalysisModeChanged) {
      // Drop non-authoritative ledger rows so the next run re-executes those
      // engines instead of resuming past them. Completed rows are preserved —
      // real work is never thrown away by a mode switch. Also needed here so
      // ways_out_analysis's prior "skipped: not_applicable_ongoing_case_mode"
      // ledger row doesn't get treated as "already done" after switching into
      // a completed-case mode.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("pipeline_engine_runs")
        .delete()
        .eq("case_id", data.caseId)
        .in("status", ["skipped", "failed", "blocked", "queued", "running"]);
    }

    return { ok: true, modeChanged, caseTypeChanged, caseAnalysisModeChanged, sourceConflict };
  });

export const archiveCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ caseId: z.string().uuid(), archived: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "Archive");
    const { error } = await supabase
      .from("cases")
      .update({ archived_at: data.archived ? new Date().toISOString() : null })
      .eq("id", data.caseId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Delete");
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    const isAdmin = Boolean(adminRole);

    // 1. Collect storage paths for all documents under this case
    const { data: docs } = await supabase
      .from("documents")
      .select("storage_path")
      .eq("case_id", data.caseId);
    const paths = (docs ?? [])
      .map((d) => d.storage_path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);

    // 2. Remove storage objects (best-effort, batched at 100)
    if (paths.length > 0) {
      for (let i = 0; i < paths.length; i += 100) {
        const slice = paths.slice(i, i + 100);
        try {
          await supabase.storage.from("case-files").remove(slice);
        } catch {
          // best-effort — continue with DB delete even if storage fails
        }
      }
    }

    // 3. Hard delete the case row — FK CASCADE removes documents,
    //    document_pages, analyses, reports, findings, scores, theories,
    //    opportunities, witnesses, perspectives, strategy, trial_prep,
    //    work_product, chat_messages, agent_findings, evidence_classifications,
    //    and pipeline_events automatically.
    let deleteQuery = supabase.from("cases").delete().eq("id", data.caseId);
    if (!isAdmin) deleteQuery = deleteQuery.eq("user_id", userId);
    const { data: deleted, error } = await deleteQuery.select("id,name").maybeSingle();
    if (error) throw new Error(error.message);
    if (!deleted) throw new Error("Case not found or already deleted");
    const { logAudit } = await import("./audit.server");
    await logAudit({
      actorId: userId,
      action: "case_deleted",
      target: data.caseId,
      meta: {
        name: (deleted as { name?: string }).name ?? null,
        removed_files: paths.length,
        admin_override: isAdmin,
      },
    });
    return { ok: true, removed_files: paths.length };
  });

export const requestCancel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "Cancel");

    const { error } = await supabase
      .from("cases")
      .update({ cancel_requested: true } as any)
      .eq("id", data.caseId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Hard-stop a stuck job. Flips status to "cancelled" regardless of where the
// worker is and clears any pending cancel flag so the user can restart.
export const forceCancelCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "ForceCancel");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("cases")
      .update({
        status: "cancelled",
        status_message: "Force-stopped by user",
        progress: 0,
        cancel_requested: false,
        queued_at: null,
        worker_lease_until: null,
        next_stage: null,
        error: null,
      })
      .eq("id", data.caseId);
    if (error) throw new Error(error.message);
    // Clear stale ledger spinners from any in-flight engine rows. The ledger
    // status enum has no `cancelled`, so use a failed terminal row with an
    // explicit user-cancel message.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("pipeline_engine_runs")
      .update({
        status: "failed",
        ended_at: new Date().toISOString(),
        error: "Force-stopped by user",
      })
      .eq("case_id", data.caseId)
      .eq("status", "running");
    return { ok: true };
  });

export const duplicateCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Duplicate");
    const { data: orig, error } = await supabase
      .from("cases")
      .select("name,description,analysis_mode")
      .eq("id", data.caseId)
      .maybeSingle();
    if (error || !orig) throw new Error(error?.message ?? "Source case not found");
    const { data: created, error: insErr } = await supabase
      .from("cases")
      .insert({
        user_id: userId,
        name: `${orig.name} (copy)`,
        description: orig.description,
        analysis_mode: orig.analysis_mode,
        status: "uploaded",
        progress: 0,
      })
      .select("id")
      .single();
    if (insErr || !created) throw new Error(insErr?.message ?? "Failed to duplicate");
    // Note: documents/findings are not copied — duplicate gives a fresh shell to re-upload into.
    return { caseId: created.id };
  });

// -------- Motion Center: single-motion drafting --------
// See src/lib/intelligence/motion-draft.server.ts for why this is separate
// from the batch runWorkProductEngine / case_work_product table.
export const draftMotion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        motionTitle: z.string().min(1).max(300),
        opportunityDescription: z.string().max(4000).nullish(),
        caseLawCitations: z
          .array(
            z.object({
              case_name: z.string().max(300).nullish(),
              citation: z.string().max(200).nullish(),
              court: z.string().max(200).nullish(),
              url: z.string().max(500).nullish(),
            }),
          )
          .max(10)
          .nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "DraftMotion");
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const { keys, userKeyCount } = await resolveProviderKeys(supabase, userId, "groq");
    const activeKey = keys[0] ?? getApiKey();

    const { checkAndConsumeUsage, usageExceededMessage } = await import("@/lib/usage.server");
    const usage = await checkAndConsumeUsage({
      userId,
      kind: "ai_request",
      feature: "motion_generation",
      caseId: data.caseId,
      byokActive: userKeyCount > 0,
    });
    if (!usage.allowed) {
      return {
        ok: false as const,
        usageExceeded: true as const,
        message: usageExceededMessage("Motion generation", usage),
      };
    }

    const { draftSingleMotion } = await import("@/lib/intelligence/motion-draft.server");
    try {
      const draft = await draftSingleMotion({
        db: supabase,
        caseId: data.caseId,
        userId,
        apiKey: activeKey,
        apiKeys: keys,
        motionTitle: data.motionTitle,
        opportunityContext: data.opportunityDescription
          ? { description: data.opportunityDescription }
          : null,
        caseLawCitations: data.caseLawCitations ?? null,
      });
      return { ok: true, draft };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let friendly = msg;
      // Reaching any of these means the router already tried every provider
      // the user has configured (Groq first, then any fallback providers
      // like Gemini via user_ai_keys) — see draftSingleMotion's userId pass-
      // through — so the message must not name Groq specifically here.
      if (/429|rate.limit|quota/i.test(msg)) {
        friendly =
          "All configured AI providers are rate-limited or out of quota right now. Open Settings → AI Keys to add another provider as a fallback, or wait a few minutes and retry.";
      } else if (/401|403|invalid.+api.+key|unauthorized|rejected this api key/i.test(msg)) {
        friendly =
          "Every configured AI provider rejected its API key. Open Settings → AI Keys to check them.";
      } else if (/no groq api key|GROQ_API_KEY|no.+key.+configured|no ai providers/i.test(msg)) {
        friendly = "No AI provider is configured. Open Settings → AI Keys to add one.";
      }
      throw new Error(`[DraftMotion] ${friendly}`);
    }
  });

export const updateMotionDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        draftId: z.string().uuid(),
        bodyMarkdown: z.string().max(200_000),
        title: z.string().max(300).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "UpdateMotionDraft");
    const { updateMotionDraftBody } = await import("@/lib/intelligence/motion-draft.server");
    const draft = await updateMotionDraftBody({
      db: supabase,
      id: data.draftId,
      userId,
      bodyMarkdown: data.bodyMarkdown,
      title: data.title,
    });
    return { ok: true, draft };
  });

export const updateMotionDraftNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        draftId: z.string().uuid(),
        attorneyNotes: z.string().max(20_000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "UpdateMotionDraftNotes");
    const { updateMotionDraftNotes: updateNotes } =
      await import("@/lib/intelligence/motion-draft.server");
    const draft = await updateNotes({
      db: supabase,
      id: data.draftId,
      userId,
      attorneyNotes: data.attorneyNotes,
    });
    return { ok: true, draft };
  });

export const getMotionDrafts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "MotionDrafts");
    const { getMotionDrafts: fetchDrafts } = await import("@/lib/intelligence/motion-draft.server");
    return { drafts: await fetchDrafts(supabase, data.caseId) };
  });

// On-demand UI translation for AI-generated case content (finding titles/
// descriptions, opportunity text, timeline events, witness profiles, etc.)
// shown outside the formal Report. The Report itself (Reports page, the
// case workspace's Report tab, and PDF/DOCX/JSON export) intentionally
// never calls this — it always renders in the language it was generated in,
// since that's the language it's meant to be filed/read in. This is purely
// a screen-reading convenience for attorneys viewing the app UI in the
// other locale than the case was analyzed in.
export const translateTexts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        texts: z.array(z.string().max(4000)).min(1).max(150),
        targetLocale: z.enum(["en", "es"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Translate");
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const { keys, userKeyCount } = await resolveProviderKeys(supabase, userId, "groq");
    const activeKey = keys[0] ?? getApiKey();

    // Best-effort quota accounting, same metered resource as every other AI
    // call — but never blocks the screen: a translation failure/limit just
    // falls back to showing the original text, so usage exhaustion degrades
    // gracefully instead of breaking the page.
    const { checkAndConsumeUsage } = await import("@/lib/usage.server");
    const usage = await checkAndConsumeUsage({
      userId,
      kind: "ai_request",
      feature: "ui_translation",
      byokActive: userKeyCount > 0,
    });
    if (!usage.allowed) {
      return { translations: data.texts, skipped: true as const };
    }

    const { callGroq, parseJsonLoose } = await import("./groq.server");
    const targetLabel = data.targetLocale === "en" ? "English" : "Spanish";
    const r = await callGroq({
      apiKey: activeKey,
      apiKeys: keys,
      model: "openai/gpt-oss-120b",
      systemInstruction:
        "You are a precise bilingual translator for a Mexican legal and social-care (Atención Integral / Comprehensive Care) intelligence platform. " +
        "Translate each string faithfully — preserve legal terminology, social-work concepts, citations, article numbers, " +
        "party and client names, case numbers, document IDs, phone numbers, email addresses, dates, and quotes verbatim without destructive alteration. " +
        "If a string is already in the target language, keep it unchanged. Never summarize, shorten, or add commentary. Output STRICT JSON only.",
      userContent:
        `Translate every string in this JSON array into ${targetLabel}. If an item is already in ${targetLabel}, keep it identical. ` +
        `Preserve array order and length exactly — return exactly ${data.texts.length} items. Return STRICT JSON: {"translations": string[]}.\n\n` +
        JSON.stringify(data.texts),
      json: true,
      cache: true,
      temperature: 0,
    });
    const parsed = parseJsonLoose<{ translations?: unknown }>(r.text) ?? {};
    const raw = Array.isArray(parsed.translations) ? parsed.translations : [];
    // Defensive: fall back to the original string per-item rather than the
    // whole batch if the model drops/reorders an entry or returns a non-string.
    const translations = data.texts.map((orig, i) =>
      typeof raw[i] === "string" && (raw[i] as string).trim() ? (raw[i] as string) : orig,
    );
    return { translations, skipped: false as const };
  });

// Metadata fields safe to return for a quality_blocked report — enough for
// the UI to render an accurate "blocked" state (report exists, here's why),
// nothing that constitutes report content export.ts could render into a
// PDF/DOCX. Every other column on `reports` is substantive content and is
// stripped to null. New columns added to `reports` are content by default
// (not returned when blocked) unless explicitly added to this allowlist —
// deliberately fail-closed rather than fail-open.
const BLOCKED_REPORT_METADATA_ALLOWLIST = new Set([
  "id",
  "case_id",
  "user_id",
  "created_at",
  "updated_at",
  "version",
  "quality_blocked",
  "quality_block_reasons",
  "report_mode",
  "generated_language",
  "intelligence_version",
  "canonical_version",
  "change_log",
]);

export function sanitizeBlockedReport<T extends Record<string, unknown> | null | undefined>(
  report: T,
  opts?: { stale?: boolean },
): T {
  if (!report) return report;
  const blocked = !!report.quality_blocked;
  const stale = !!opts?.stale;
  if (!blocked && !stale) return report;
  const sanitized: Record<string, unknown> = {};
  for (const key of Object.keys(report)) {
    sanitized[key] = BLOCKED_REPORT_METADATA_ALLOWLIST.has(key) ? report[key] : null;
  }
  if (stale && !blocked) {
    // Distinguish "blocked by the quality gate" from "stale relative to a
    // later pipeline run" — same content-stripping treatment, different
    // reason, so the UI can show accurate messaging instead of conflating
    // the two. quality_blocked itself is left as whatever the row actually
    // says (usually false here) since that reflects the report's own
    // release-gate outcome, not this endpoint's freshness judgment.
    sanitized.stale = true;
    sanitized.stale_reason =
      "A required pipeline stage completed more recently than this report was generated.";
    // BUG FIXED (real completed-case export, ADR 4640/2017 rerun):
    // report_mode is in BLOCKED_REPORT_METADATA_ALLOWLIST — kept intentionally
    // for the `blocked` case, where the attorney benefits from knowing
    // whether the blocked report was headed toward FULL or LIMITED. But for
    // a STALE report that reasoning doesn't hold: every field this report_mode
    // value would corroborate (scores_suppressed, case_strength_score,
    // risk_score, findings_count, full_report's own "LIMITADO"/"Suprimido"
    // narrative) is nulled by the loop above, since none of them are on the
    // allowlist. Letting report_mode alone survive from a stale, superseded
    // computation — sitting next to a wall of nulls for everything that
    // would explain or corroborate it — is exactly the "JSON says FULL,
    // everything else says nothing" self-contradiction this export showed:
    // report.report_mode: "FULL" while scores_suppressed/case_strength_score/
    // risk_score/findings_count were all null. Null it too: an honest
    // "we don't know, this is stale" beats a leftover value from a run this
    // export explicitly says is no longer current.
    sanitized.report_mode = null;
  }
  return sanitized as T;
}

// BUG FIXED (confirmed on two real, independently-audited released cases —
// ADR-4321-2017-180507 and ADR-4640-2017-180212, both "concluded_audit"
// cases that completed and released normally): every released case's
// EXPORTED report came back with full_report/executive_summary/facts/
// case_strength_score/risk_score/findings_count all null, stale:true, even
// though the case had genuinely finished (status: "released", "Final
// review passed"). Two blocking-tier stages — jurisdiction_intel and
// legal_qa — have no dedicated `cases.<x>_at` timestamp column, so their
// completion is knowable only via their `pipeline_engine_runs` row. Report
// generation begins as soon as its own in-memory dependency check sees
// legal_qa/jurisdiction_intel as done; nothing forces that stage's OWN
// ledger-row UPDATE to have already committed and be read-consistent
// before the report's row is written a moment later. That ordinary
// async write-ordering jitter (observed on both real cases as ~1-2 seconds
// on a comparable ledger column) was enough to flip isReportStale() to
// true on effectively every completed case — a systemic false positive on
// the "normal completion" path, not the genuine resume/retry-minutes-or-
// hours-later scenario this check exists to catch (see the doc comment
// below). A small grace period absorbs that jitter while a real resume —
// which requires re-queueing, a worker cold start, and re-executing a
// whole stage — still lands far outside it.
const STALE_GRACE_MS = 60_000;

/**
 * Whether the case's single `reports` row (see the UNIQUE constraint on
 * reports.case_id — there is never more than one, so "which version is
 * active" is not the ambiguity; staleness is) predates the most recent
 * completion of any blocking-tier pipeline stage for this case.
 *
 * reports is a singleton updated in place, not re-created per run, and
 * nothing currently invalidates it when an earlier stage is retried after
 * the report already exists. If a case is resumed (e.g. re-running
 * analyzers after fixing an upstream issue) and, for any reason, the
 * report stage itself doesn't re-run afterward, the old reports row keeps
 * describing a superseded analysis with no signal to the reader that it's
 * out of date.
 *
 * A blocking engine's timestamp must exceed the report's by more than
 * STALE_GRACE_MS to count — see the BUG FIXED note above for why a bare
 * `t > reportTime` false-flagged nearly every normally-completed case.
 *
 * Deliberately fail-closed on missing timestamps: if the report has no
 * updated_at/created_at, or a blocking engine's latest row has no
 * timestamp, that comparison is skipped rather than assumed fresh.
 */
export function isReportStale(
  report: { updated_at?: string | null; created_at?: string | null } | null | undefined,
  pipelineRuns: Array<{ engine: string; created_at?: string | null; ended_at?: string | null }>,
  blockingEngines: ReadonlySet<string>,
): boolean {
  if (!report) return false;
  const reportTime = Date.parse((report.updated_at || report.created_at) ?? "");
  if (!Number.isFinite(reportTime)) return false;

  const latestByEngine = new Map<string, number>();
  for (const row of pipelineRuns) {
    if (!blockingEngines.has(row.engine)) continue;
    const t = Date.parse((row.ended_at || row.created_at) ?? "");
    if (!Number.isFinite(t)) continue;
    const prev = latestByEngine.get(row.engine) ?? -Infinity;
    if (t > prev) latestByEngine.set(row.engine, t);
  }
  for (const t of latestByEngine.values()) {
    if (t > reportTime + STALE_GRACE_MS) return true;
  }
  return false;
}

/**
 * Second, independent staleness signal alongside isReportStale() above:
 * document content itself changed since the report cited it, whether or not
 * that change happened to re-run the extraction engine (isReportStale only
 * catches the latter, via extraction's blocking-tier timestamp).
 *
 * Phase 1 evidence-provenance (grounding.server.ts) stamps a document_hash
 * (SHA-256 of extracted_text at citation time) onto every verified citation,
 * which flows through into reports.citations. This recomputes each
 * currently-referenced document's hash and compares it against what the
 * report's own citations recorded — a mismatch means "if a document
 * changes, invalidate findings" (the roadmap's own wording) has actually
 * happened and this report's citations no longer describe the current
 * evidence.
 *
 * Fails closed, same convention as isReportStale: a citation with no stored
 * document_hash (e.g. a report generated before this check existed) is
 * skipped, never treated as evidence of staleness by its mere absence.
 */
export function isReportStaleByDocumentHash(
  report: { citations?: unknown } | null | undefined,
  documents: Array<{ id: string; extracted_text: string | null }>,
): boolean {
  if (!report) return false;
  const citations = Array.isArray(report.citations)
    ? (report.citations as Array<Record<string, unknown>>)
    : [];
  if (citations.length === 0) return false;

  const storedHashByDoc = new Map<string, string>();
  for (const c of citations) {
    const docId = typeof c.document_id === "string" ? c.document_id : null;
    const hash = typeof c.document_hash === "string" ? c.document_hash : null;
    if (docId && hash && !storedHashByDoc.has(docId)) storedHashByDoc.set(docId, hash);
  }
  if (storedHashByDoc.size === 0) return false;

  const currentDocs = new Map(documents.map((d) => [d.id, d.extracted_text ?? ""]));
  for (const [docId, storedHash] of storedHashByDoc) {
    const currentText = currentDocs.get(docId);
    // Document the citation depends on was deleted/archived out from under it.
    if (currentText === undefined) return true;
    if (sha256Hex(currentText) !== storedHash) return true;
  }
  return false;
}

export const getCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "Case");
    const [
      c,
      docs,
      analysis,
      agents,
      score,
      report,
      findings,
      theories,
      opps,
      witnesses,
      trial,
      work,
      perspectives,
      evidenceIntel,
      strategy,
      strategyCenter,
      pipelineRuns,
      agentLogs,
      timelineEvents,
      outcomeAssessment,
    ] = await Promise.all([
      supabase.from("cases").select("*").eq("id", data.caseId).maybeSingle(),
      supabase
        .from("documents")
        .select(
          // PERF: `extracted_text` is intentionally excluded — full OCR text for
          // 20+ documents made this response tens of MB, which is what made the
          // case workspace slow and occasionally fail to load. The Documents tab
          // fetches text on demand via getDocumentText().
          "id,filename,status,mime_type,size_bytes,error,metadata,entities,created_at,archived_at",
        )
        .eq("case_id", data.caseId)
        .order("created_at"),
      supabase.from("analyses").select("*").eq("case_id", data.caseId).maybeSingle(),
      supabase.from("agent_findings").select("*").eq("case_id", data.caseId).order("agent_type"),
      supabase.from("case_scores").select("*").eq("case_id", data.caseId).maybeSingle(),
      supabase.from("reports").select("*").eq("case_id", data.caseId).maybeSingle(),
      supabase
        .from("case_findings")
        .select("*")
        .eq("case_id", data.caseId)
        .not("source_module", "like", PROJECTION_LIKE)
        .order("priority", { ascending: true, nullsFirst: false })
        .order("created_at"),
      supabase.from("case_theories").select("*").eq("case_id", data.caseId).order("theory_type"),
      supabase.from("case_opportunities").select("*").eq("case_id", data.caseId).order("severity"),
      supabase.from("case_witnesses").select("*").eq("case_id", data.caseId).order("name"),
      supabase.from("case_trial_prep").select("*").eq("case_id", data.caseId).maybeSingle(),
      supabase
        .from("case_work_product")
        .select("*")
        .eq("case_id", data.caseId)
        .order("document_type"),
      supabase
        .from("case_perspectives")
        .select("*")
        .eq("case_id", data.caseId)
        .order("perspective"),
      supabase
        .from("evidence_classifications")
        .select("*")
        .eq("case_id", data.caseId)
        .order("created_at"),
      supabase.from("case_strategy").select("*").eq("case_id", data.caseId).order("created_at"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("case_strategy_center")
        .select("*")
        .eq("case_id", data.caseId)
        .maybeSingle(),
      supabase
        .from("pipeline_engine_runs")
        .select("id,engine,status,started_at,ended_at,created_at")
        .eq("case_id", data.caseId)
        .order("created_at", { ascending: false }),
      supabase
        .from("agent_logs")
        .select("*")
        .eq("case_id", data.caseId)
        .order("created_at", { ascending: false })
        // PERF: only the most recent slice is ever rendered; unbounded log
        // history was a large part of this payload.
        .limit(200),
      supabase
        .from("case_timeline_events")
        .select("id,event_date,description,source_document_id,source_page,canonical_id")
        .eq("case_id", data.caseId)
        .is("superseded_by", null)
        .order("event_date", { ascending: true, nullsFirst: false }),
      // Completed Case Audit / Outcome Assessment (completed-case-audit.server.ts).
      // Runs as the last step of the pipeline for every case_analysis_mode
      // !== "ongoing" and persists to case_outcome_assessments — but until
      // now nothing in the export path ever read it back, so its
      // source-verified evidence classification (FACT_DOCUMENTED/
      // COURT_FINDING/INFERENCE/POSSIBILITY/UNKNOWN), its explicit
      // "no_material_error_identified" result, and its court-holding-vs-
      // confirmed-error separation never reached the report or any export
      // a user actually saw, despite running successfully. Most recent row
      // only — a rerun writes a new row rather than overwriting, so this is
      // never stale within a single analysis but does need ordering.
      // raw_model_output is intentionally excluded: everything it contains
      // that survived verification is already in the typed fields above; the
      // raw field exists for internal debugging, not attorney-facing export.
      // Not in the generated Database type (added via a later, additive
      // migration) — same `as any` pattern case_strategy_center already
      // uses a few lines up.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("case_outcome_assessments")
        .select(
          "id,case_analysis_mode,overall_position,outcome_status,favorable_pct,unfavorable_pct,confidence,no_material_error_identified,principal_strength,principal_weakness,biggest_risk,most_important_missing_evidence,both_sides,factors,what_could_change,finding_reviews,citation_reviews,created_at",
        )
        .eq("case_id", data.caseId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    // Phase 4: current canonical version, so the report header can say a
    // newer analysis exists instead of silently re-rendering.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: canonRow } = await (supabase as any)
      .from("canonical_analysis")
      .select("version")
      .eq("case_id", data.caseId)
      .maybeSingle();
    const canonicalCurrentVersion =
      Number((canonRow as { version?: number } | null)?.version ?? NaN) || null;
    // Backend enforcement of the frozen release contract (docs/FREEZE.md:
    // "A report with quality_blocked=true must never produce a downloadable
    // PDF or DOCX"). PDF/DOCX generation happens client-side in export.ts
    // from data this endpoint supplies — there is no separate server-side
    // export endpoint to gate. Previously that contract was enforced only in
    // the frontend route component (cases.$caseId.tsx checking
    // report.quality_blocked), which a direct call to this server function
    // could bypass entirely. Strip every substantive content field down to
    // an explicit metadata allowlist when blocked, so the UI can still show
    // "blocked" state accurately but cannot construct a real PDF/DOCX from
    // the response. This is a change to the endpoint response shape for
    // blocked reports only — unblocked reports are returned unchanged.
    // PR A item 2: a report is stale if any blocking-tier stage completed
    // more recently than the report itself — see isReportStale's doc
    // comment for why this matters (reports is a singleton row, never
    // re-created per run, and nothing else currently invalidates it after
    // an upstream retry).
    const { CANONICAL_STAGES } = await import("@/lib/execution/canonical");
    const blockingEngines = new Set(
      CANONICAL_STAGES.filter((s) => s.requirement === "blocking").map((s) => s.engine),
    );
    const reportIsStale = isReportStale(
      report.data as { updated_at?: string | null; created_at?: string | null } | null,
      (pipelineRuns.data ?? []) as Array<{
        engine: string;
        created_at?: string | null;
        ended_at?: string | null;
      }>,
      blockingEngines,
    );
    const sanitizedReport = sanitizeBlockedReport(report.data, { stale: reportIsStale });
    // BUG FIXED (real completed-case export, ADR 4640/2017 rerun): case_scores
    // is a SEPARATE table, written by the scoring stage, which runs and
    // persists its numbers BEFORE the later report stage decides — via the
    // Evidence Sufficiency Score gate — whether the corpus actually supports
    // showing quantitative scores at all. That later LIMITED decision wipes
    // the report's OWN score fields (case_strength_score/risk_score,
    // gatedScore() in pipeline.server.ts) but never retroactively touches
    // this already-persisted case_scores row, so it kept flowing through
    // ungated. Confirmed on a real export: report said "LIMITADO... Puntajes:
    // Suprimido" in the PDF narrative while this same response's `score`
    // carried real numbers (overall_confidence: 82, evidence_strength: 60,
    // etc.) — an attorney reading both would have two irreconcilable
    // statements about the same case. Only show the raw scorecard when the
    // report has affirmatively said scores are NOT suppressed; a stale or
    // ambiguous state (scores_suppressed null, e.g. from the sanitizer above)
    // suppresses rather than guesses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reportForGate = sanitizedReport as any;
    // Allowlist, not a denylist: only an AFFIRMATIVE "report_mode is FULL
    // and scores_suppressed is explicitly false" clears the scorecard for
    // display. Anything else — LIMITED, a stale/ambiguous null (the
    // sanitizer above now nulls report_mode when stale, specifically so
    // this can't be mistaken for an all-clear), or no report row at all —
    // withholds the scorecard rather than guessing.
    const scoresConfirmedNotSuppressed =
      reportForGate?.report_mode === "FULL" && reportForGate?.scores_suppressed === false;
    return {
      case: c.data,
      documents: docs.data ?? [],
      analysis: analysis.data,
      agents: agents.data ?? [],
      score: scoresConfirmedNotSuppressed ? score.data : null,
      report: sanitizedReport,
      canonical_current_version: canonicalCurrentVersion,
      // Apply the same canonical inclusion rule used everywhere else
      // (getCanonicalScoringFindings / isCanonicalFinding via the unified
      // selectFindings() selector): BOTH `engine:*` AND `agent:*` findings
      // are canonical, finalized pipeline output — only `analyzer:*`
      // (provisional, pre-dedup) is excluded. Falls back to the unfiltered
      // set if that would leave nothing to show (defensive — never render
      // an empty findings section).
      //
      // FIX (2026-08-02): this filter previously had its own inline copy of
      // the canonical rule that accepted ONLY `engine:*` findings, silently
      // dropping every `agent:*` finding (witness_credibility,
      // procedural_violations, chain_of_custody, constitutional_compliance)
      // from the PDF/DOCX/JSON export and the report the user actually
      // downloads — even though the internal report stage
      // (pipeline.server.ts's consolidated_findings) had already been
      // correctly fixed on 2026-07-13 to include both prefixes. Because
      // getCase() (this function) is what feeds CaseExportData, the
      // downloadable report kept reproducing the old bug via this
      // un-updated duplicate: cases with real, verified agent:* findings
      // showed only their engine:* subset (e.g. 8 real findings → 1 shown;
      // 11 real findings → 2 shown), with the report's own "N hallazgos
      // verificados" narrative accurately describing the undercounted
      // array it was handed — the narrative wasn't wrong, its input was.
      // Delegating to selectFindings() (default include: engine+agent)
      // makes this the same single source of truth as every other
      // consumer, so the export can't drift from the fix again.
      //
      // FIX (2026-08-10): getCase() queried case_findings directly and never
      // ran the result through consolidateFindings() — the SAME near-
      // duplicate clustering pipeline.server.ts's report-generation stage
      // already applies (as `allFindings = dedupeFindings(rawFindings)`,
      // used for score_breakdown/structured summaries). Since getCase() is
      // what feeds CaseExportData, and export.ts's PDF/DOCX/JSON "Hallazgos
      // Clave" section renders `data.findings` directly, the downloadable
      // report showed every raw duplicate case_findings row — confirmed on
      // a real export where 3 agents (chain_of_custody, standing_procedencia,
      // conventionality_pro_persona) each independently persisted a finding
      // titled "Distinción entre amparo directo e indirecto" and all 3 (plus
      // a 4th near-duplicate) rendered as separate rows, even though running
      // the exact same consolidateFindings() call against that exact export
      // data correctly collapses them to 1. Dedupe BEFORE the canonical
      // filter, mirroring pipeline.server.ts's order, so a merged row that
      // absorbed an analyzer:*-sourced duplicate still keeps whichever
      // canonical evidence/citations that duplicate contributed.
      //
      // NOTE: consolidateFindings()'s generic return type intersects with
      // finding-dedupe.ts's DedupableFinding (Record<string, unknown>), and
      // extracting this into its own generic helper function was tried and
      // reverted — TS inference collapsed the concrete Supabase row type to
      // the bare Record<string, unknown> constraint at the call site, which
      // fails createServerFn's ValidateSerializableMapped check. Keeping the
      // cast inline (`as typeof rawRows`, closing over the concrete type
      // right where it's inferred) avoids that collapse.
      findings: (() => {
        const rawRows = findings.data ?? [];
        const all = consolidateFindings(rawRows) as typeof rawRows;
        // Cast only at the per-item predicate boundary (not the array
        // itself) so `canonical` keeps the full Supabase row type instead
        // of widening to the structural SelectableFinding shape — a
        // whole-array cast/generic-inference-loss here previously caused
        // getCase()'s serialized return type to collapse for every
        // downstream consumer.
        const canonical = all.filter((f) => isCanonicalFinding(f as unknown as SelectableFinding));
        return canonical.length > 0 ? canonical : all;
      })(),
      theories: theories.data ?? [],
      opportunities: opps.data ?? [],
      witnesses: witnesses.data ?? [],
      trial_prep: trial.data,
      work_product: work.data ?? [],
      perspectives: perspectives.data ?? [],
      evidence_intel: evidenceIntel.data ?? [],
      strategy: strategy.data ?? [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      strategy_center: (strategyCenter as any)?.data ?? null,
      pipeline_runs: pipelineRuns.data ?? [],
      agent_logs: agentLogs.data ?? [],
      // Canonical chronology. The Timeline module reads this table directly —
      // the report JSON fallback is often empty for cases whose timeline was
      // built by the canonical timeline stage.
      timeline_events: timelineEvents.data ?? [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      outcome_assessment: (outcomeAssessment as any)?.data ?? null,
    };
  });

// -------- Admin --------
export const adminStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Admin");
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!adminRole) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [cases, users, reports, usage] = await Promise.all([
      supabaseAdmin
        .from("cases")
        .select("id,name,status,user_id,created_at,completed_at")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(500),
      supabaseAdmin
        .from("profiles")
        .select("id,email,full_name,created_at,is_blocked")
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("reports")
        .select("case_id,created_at")
        .order("created_at", { ascending: false })
        .limit(500),
      supabaseAdmin
        .from("ai_usage")
        .select("model,operation,total_tokens,latency_ms,success,created_at,user_id,case_id")
        .order("created_at", { ascending: false })
        .limit(500),
    ]);
    const { data: audit } = await supabaseAdmin
      .from("admin_audit_log")
      .select("id,action,actor_id,target,meta,created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    return {
      cases: cases.data ?? [],
      users: users.data ?? [],
      reports: reports.data ?? [],
      usage: usage.data ?? [],
      audit: audit ?? [],
    };
  });

// Delete one, several, or all (optionally filtered by action) admin_audit_log
// rows. Requires admin. The purge itself is recorded as a new audit entry.
export const deleteAuditLogEntries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids?: string[]; deleteAll?: boolean; action?: string }) => d ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Delete audit log");
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!adminRole) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let deletedIds: string[] | undefined;
    if (data.deleteAll) {
      let q = supabaseAdmin.from("admin_audit_log").delete().not("id", "is", null);
      if (data.action) q = q.eq("action", data.action);
      const { error } = await q;
      if (error) throw new Error(error.message);
    } else {
      const ids = (data.ids ?? []).filter(Boolean);
      if (ids.length === 0) throw new Error("No entries selected");
      const { error } = await supabaseAdmin.from("admin_audit_log").delete().in("id", ids);
      if (error) throw new Error(error.message);
      deletedIds = ids;
    }

    const { logAudit } = await import("@/lib/audit.server");
    await logAudit({
      actorId: userId,
      action: "audit_log_purged",
      target: null,
      meta: { all: Boolean(data.deleteAll), filterAction: data.action ?? null, ids: deletedIds },
    });
    return { ok: true };
  });

export const checkIsAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Admin check");
    const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const roles = (data ?? []).map((r) => r.role as string);
    const isSuperAdmin = roles.includes("super_admin");
    const isFirmAdmin = roles.includes("firm_admin");
    const isCaseManager = roles.includes("case_manager");
    const isAdmin = isSuperAdmin || isFirmAdmin || roles.includes("admin");
    return { isAdmin, isSuperAdmin, isFirmAdmin, isCaseManager, roles };
  });

// -------- Phase 9: Pipeline ledger (admin) --------
// Enterprise observability surface: every engine run, every case, every provider,
// with truthfulness signals (db_write_confirmed, rows_written, error, retry_count).
export const pipelineLedger = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        caseId: z.string().uuid().optional(),
        engine: z.string().optional(),
        status: z
          .enum(["completed", "failed", "blocked", "skipped", "running", "queued"])
          .optional(),
        provider: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = await getAuthedContext(context, "Pipeline ledger");
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!adminRole) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const limit = data.limit ?? 200;
    let q = supabaseAdmin
      .from("pipeline_engine_runs")
      .select(
        "id,case_id,engine,status,provider,model,tokens_in,tokens_out,cost_usd,runtime_ms,retry_count,db_write_confirmed,rows_written,error,started_at,ended_at,created_at,prompt_version,skipped_reason,dependency_status,meta",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (data.caseId) q = q.eq("case_id", data.caseId);
    if (data.engine) q = q.eq("engine", data.engine);
    if (data.status) q = q.eq("status", data.status);
    if (data.provider) q = q.eq("provider", data.provider);
    const { data: runs, error } = await q;
    if (error) throw new Error(error.message);
    const rows = runs ?? [];
    const totalRuns = rows.length;
    const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
      const k = (r as { status: string }).status;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    const totalTokens = rows.reduce(
      (s, r) =>
        s +
        ((r as { tokens_in?: number }).tokens_in ?? 0) +
        ((r as { tokens_out?: number }).tokens_out ?? 0),
      0,
    );
    const totalCost = rows.reduce(
      (s, r) => s + Number((r as { cost_usd?: number }).cost_usd ?? 0),
      0,
    );
    const avgLatency =
      totalRuns === 0
        ? 0
        : Math.round(
            rows.reduce((s, r) => s + ((r as { runtime_ms?: number }).runtime_ms ?? 0), 0) /
              totalRuns,
          );
    const confirmedWrites = rows.filter(
      (r) => (r as { db_write_confirmed?: boolean }).db_write_confirmed === true,
    ).length;
    return {
      runs: rows,
      summary: { totalRuns, byStatus, totalTokens, totalCost, avgLatency, confirmedWrites },
    };
  });

// ============== RBAC: role administration (super admin only) ==============
export const listUsersWithRoles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "List users");
    const { data: caller } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const callerRoles = (caller ?? []).map((r) => r.role as string);
    if (!callerRoles.includes("super_admin") && !callerRoles.includes("admin")) {
      throw new Error("Forbidden: super admin required");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: profiles }, { data: allRoles }] = await Promise.all([
      supabaseAdmin.from("profiles").select("id,email,full_name,is_blocked").order("email"),
      supabaseAdmin.from("user_roles").select("user_id,role"),
    ]);
    const rolesByUser = new Map<string, string[]>();
    for (const r of allRoles ?? []) {
      const list = rolesByUser.get(r.user_id) ?? [];
      list.push(r.role as string);
      rolesByUser.set(r.user_id, list);
    }
    return (profiles ?? []).map((p) => ({
      id: p.id,
      email: p.email,
      full_name: p.full_name,
      roles: rolesByUser.get(p.id) ?? [],
      is_blocked: p.is_blocked ?? false,
    }));
  });

// Block or unblock ("accept" back in) a user account. Admins and super admins
// may call this. Blocked users are rejected on every authenticated call — see
// getAuthedContext above.
export const setUserBlocked = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { targetUserId: string; blocked: boolean }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Set user blocked");
    const { data: caller } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const callerRoles = (caller ?? []).map((r) => r.role as string);
    if (!callerRoles.includes("super_admin") && !callerRoles.includes("admin")) {
      throw new Error("Forbidden: admin required");
    }
    if (data.targetUserId === userId && data.blocked) {
      throw new Error("You cannot block your own account");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ is_blocked: data.blocked })
      .eq("id", data.targetUserId);
    if (error) throw new Error(error.message);
    const { logAudit } = await import("@/lib/audit.server");
    await logAudit({
      actorId: userId,
      action: data.blocked ? "user_blocked" : "user_unblocked",
      target: data.targetUserId,
      meta: {},
    });
    return { ok: true };
  });

// Permanently remove a user's account (auth identity, roles, profile). Their
// cases and documents are left in place — only sign-in access and profile
// membership are revoked. Super admin only; cannot remove yourself.
export const deleteUserAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { targetUserId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Remove user");
    const { data: caller } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const callerRoles = (caller ?? []).map((r) => r.role as string);
    if (!callerRoles.includes("super_admin")) {
      throw new Error("Forbidden: super admin required");
    }
    if (data.targetUserId === userId) {
      throw new Error("You cannot remove your own account");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.targetUserId);
    await supabaseAdmin.from("profiles").delete().eq("id", data.targetUserId);
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.targetUserId);
    if (error) throw new Error(error.message);
    const { logAudit } = await import("@/lib/audit.server");
    await logAudit({
      actorId: userId,
      action: "user_removed",
      target: data.targetUserId,
      meta: {},
    });
    return { ok: true };
  });

export const setUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      targetUserId: string;
      role: "super_admin" | "admin" | "firm_admin" | "case_manager" | "user";
      grant: boolean;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Set user role");
    const { data: caller } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const callerRoles = (caller ?? []).map((r) => r.role as string);
    if (!callerRoles.includes("super_admin") && !callerRoles.includes("admin")) {
      throw new Error("Forbidden: super admin required");
    }
    // Only a super admin may grant or revoke the super_admin role — plain
    // admins manage lower tiers only (privilege-escalation guard).
    if (data.role === "super_admin" && !callerRoles.includes("super_admin")) {
      throw new Error("Forbidden: super admin required");
    }
    // Protect against removing the last super admin
    if (data.role === "super_admin" && !data.grant && data.targetUserId === userId) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { count } = await supabaseAdmin
        .from("user_roles")
        .select("user_id", { count: "exact", head: true })
        .eq("role", "super_admin");
      if ((count ?? 0) <= 1) throw new Error("Cannot remove the last super admin");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (data.grant) {
      const { error } = await supabaseAdmin
        .from("user_roles")
        .upsert({ user_id: data.targetUserId, role: data.role }, { onConflict: "user_id,role" });
      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin
        .from("user_roles")
        .delete()
        .eq("user_id", data.targetUserId)
        .eq("role", data.role);
      if (error) throw error;
    }
    return { ok: true };
  });

/**
 * Self-bootstrap to admin: grants the caller `admin` if either
 *  (a) zero admins currently exist (fresh install / first owner), or
 *  (b) the caller is already an admin (idempotent — useful for the "make sure I have admin" button).
 * Anything else is rejected.
 */
export const bootstrapAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = await getAuthedContext(context, "Bootstrap admin");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: mine } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (mine) return { ok: true, alreadyAdmin: true };

    const { count } = await supabaseAdmin
      .from("user_roles")
      .select("user_id", { count: "exact", head: true })
      .eq("role", "admin");

    if ((count ?? 0) > 0) {
      throw new Error("An administrator already exists. Ask them to grant you the admin role.");
    }

    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: userId, role: "admin" });
    if (error) throw new Error(`Could not grant admin: ${error.message}`);
    return { ok: true, alreadyAdmin: false };
  });

// -------- Evidence management (in-chat uploads, list, delete, download) --------

export const uploadCaseEvidence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    if (!(data instanceof FormData)) throw new Error("FormData required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "EvidenceUpload");
    const caseId = String(data.get("caseId") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new Error("Invalid caseId");
    const files = data.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) throw new Error("No files provided");

    const MAX_FILES = 25;
    const MAX_FILE_BYTES = 50 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
    if (files.length > MAX_FILES) throw new Error(`Max ${MAX_FILES} files per upload`);
    let total = 0;
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) throw new Error(`"${f.name}" exceeds 50 MB limit`);
      total += f.size;
    }
    if (total > MAX_TOTAL_BYTES) throw new Error("Total upload exceeds 200 MB");

    // The authenticated Supabase client already enforces case access through
    // RLS. Do not add an owner-only predicate here: authorized organization
    // members must be able to add evidence according to their role.
    const { data: accessibleCase, error: accessError } = await supabase
      .from("cases")
      .select("id")
      .eq("id", caseId)
      .maybeSingle();
    if (accessError || !accessibleCase) throw new Error("Case not found");

    const uploads = await Promise.all(
      files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const { uploadFiles } = await import("@/lib/pipeline.server");
    // Talk-to-Case attachments are revision evidence, not permanent case
    // corpus — excluded from every full-pipeline analysis engine's document
    // read (buildCorpus, the shared brief, evidence_intelligence, the
    // evidence map) until a user explicitly promotes one via
    // promoteRevisionDocument below. See migration
    // 20260813224813_document_evidence_scope for why this matters: before
    // this column existed, a document dropped into a chat exchange was
    // indistinguishable from ordinary evidence the moment a full rerun
    // happened next.
    await uploadFiles({ db: supabase, caseId, userId, uploads, evidenceScope: "revision_context" });

    // Auto-run extraction so the AI can immediately read the new evidence.
    try {
      const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
      const { keys } = await resolveProviderKeys(supabase, userId, "groq");
      if (keys.length > 0) {
        const { runExtraction } = await import("@/lib/pipeline.server");
        void runExtraction({ db: supabase, caseId, userId, apiKey: keys[0], apiKeys: keys }).catch(
          (e) => console.error("[evidence] background extraction failed", e),
        );
      }
    } catch (e) {
      console.error("[evidence] could not start extraction", e);
    }

    return { ok: true, uploaded: files.length };
  });

export const listCaseDocuments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "ListDocs");
    const { data: rows } = await supabase
      .from("documents")
      .select(
        "id,filename,mime_type,size_bytes,status,storage_path,created_at,extracted_text,archived_at",
      )
      .eq("case_id", data.caseId)
      .order("created_at", { ascending: false });
    return (rows ?? []).map((r) => ({
      id: r.id,
      filename: r.filename,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      status: r.status,
      created_at: r.created_at,
      archived_at: r.archived_at,
      has_text: !!(r.extracted_text && r.extracted_text.length > 0),
    }));
  });

// Explicit escape hatch for a Talk-to-Case attachment (uploaded as
// evidence_scope: 'revision_context' — see uploadCaseEvidence above): a user
// who genuinely wants a chat-attached document treated as permanent case
// evidence, read by every full-pipeline analysis engine, must say so
// explicitly here rather than have it happen implicitly on the next rerun.
// Matches the architecture's "Add this to the case and run a complete new
// analysis" opt-in — promoting the document does NOT itself trigger a
// rerun; the user still separately runs a full analysis if they want the
// engines to actually re-derive findings from it.
export const promoteRevisionDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ caseId: z.string().uuid(), documentId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "PromoteRevisionDoc");
    const { data: doc } = await supabase
      .from("documents")
      .select("id")
      .eq("id", data.documentId)
      .eq("case_id", data.caseId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!doc) throw new Error("Document not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("documents")
      .update({ evidence_scope: "case_corpus" })
      .eq("id", data.documentId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Soft-archive / unarchive a single document. Mirrors archiveCase's
// archived_at-timestamp pattern. Archived documents stay in the DB (and in
// the evidence corpus already baked into any existing report) — this only
// controls what shows in the "Active" vs "Archived" view. Ownership is
// enforced by matching case_id + user_id, same as deleteCaseDocument below.
export const archiveCaseDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ caseId: z.string().uuid(), documentId: z.string().uuid(), archived: z.boolean() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "ArchiveDoc");
    const { data: doc } = await supabase
      .from("documents")
      .select("id")
      .eq("id", data.documentId)
      .eq("case_id", data.caseId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!doc) throw new Error("Document not found");
    const { error } = await supabase
      .from("documents")
      .update({ archived_at: data.archived ? new Date().toISOString() : null })
      .eq("id", data.documentId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteCaseDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ caseId: z.string().uuid(), documentId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "DeleteDoc");
    const { data: doc } = await supabase
      .from("documents")
      .select("id,storage_path,case_id")
      .eq("id", data.documentId)
      .eq("case_id", data.caseId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!doc) throw new Error("Document not found");
    if (doc.storage_path) {
      await supabase.storage.from("case-files").remove([doc.storage_path]);
    }
    await supabase.from("documents").delete().eq("id", data.documentId);
    return { ok: true };
  });

// -------- Document extracted text (lazy — kept out of getCase for payload size) --------
export const getDocumentText = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ documentId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "DocumentText");
    const { data: doc } = await supabase
      .from("documents")
      .select("id,extracted_text")
      .eq("id", data.documentId)
      .maybeSingle();
    return { text: (doc?.extracted_text ?? null) as string | null };
  });

// -------- Document extraction controls (retry / rollback) --------
export const retryDocumentExtraction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "RetryExtraction");
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const { keys } = await resolveProviderKeys(supabase, userId, "groq");
    const apiKey = keys[0] ?? getApiKey();
    const { retryFailedExtractions } = await import("@/lib/pipeline.server");
    return await retryFailedExtractions({
      db: supabase,
      caseId: data.caseId,
      userId,
      apiKey,
      apiKeys: keys,
    });
  });

export const rollbackDocumentExtraction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ caseId: z.string().uuid(), documentIds: z.array(z.string().uuid()) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "RollbackExtraction");
    const { rollbackExtractions } = await import("@/lib/pipeline.server");
    return await rollbackExtractions({
      db: supabase,
      caseId: data.caseId,
      documentIds: data.documentIds,
    });
  });

export const getDocumentDownloadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ caseId: z.string().uuid(), documentId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "DocDownload");
    const { data: doc } = await supabase
      .from("documents")
      .select("storage_path,filename")
      .eq("id", data.documentId)
      .eq("case_id", data.caseId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!doc?.storage_path) throw new Error("Document not found");
    const { data: signed, error } = await supabase.storage
      .from("case-files")
      .createSignedUrl(doc.storage_path, 300, { download: doc.filename ?? undefined });
    if (error || !signed) throw new Error(error?.message ?? "Could not sign URL");
    return { url: signed.signedUrl, filename: doc.filename };
  });

// -------- Add evidence to an existing case + selective rerun --------
// Snapshots the current report into report_versions, uploads the new docs,
// runs extraction (idempotent — existing extracted docs are skipped), and
// returns a list of stages the caller should rerun. The client should then
// invoke runFullPipelineStep({ startFrom: "analyzers" }) followed by
// finalizeReportChangeLog so the new report version carries a diff against
// the prior snapshot.
export const addEvidenceAndRerun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    if (!(data instanceof FormData)) throw new Error("FormData required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "AddEvidence");
    const caseId = String(data.get("caseId") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new Error("Invalid caseId");
    const files = data.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) throw new Error("No files provided");

    const MAX_FILES = 25;
    const MAX_FILE_BYTES = 50 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
    if (files.length > MAX_FILES) throw new Error(`Max ${MAX_FILES} files per upload`);
    let total = 0;
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) throw new Error(`"${f.name}" exceeds 50 MB limit`);
      total += f.size;
    }
    if (total > MAX_TOTAL_BYTES) throw new Error("Total upload exceeds 200 MB");

    // Authorization is the existing case RLS policy. This admits authorized
    // organization members while still hiding matters they cannot access.
    const { data: accessibleCase, error: accessError } = await supabase
      .from("cases")
      .select("id")
      .eq("id", caseId)
      .maybeSingle();
    if (accessError || !accessibleCase) throw new Error("Case not found");

    const rerunScopeRaw = String(data.get("rerunScope") ?? "affected_analysis");
    const rerunScope = z
      .enum(["new_documents_only", "affected_analysis", "full_case"])
      .parse(rerunScopeRaw);

    // 1. Snapshot the current report so we can diff against it later.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: currentReport } = await (supabase as any)
      .from("reports")
      .select("*")
      .eq("case_id", caseId)
      .maybeSingle();
    const baselineVersion: number = Number(currentReport?.version ?? 0) || 0;
    if (currentReport) {
      const { snapshotReportVersion } = await import("@/lib/intelligence/report-version.server");
      const cur = currentReport as Record<string, unknown>;
      const contradictions = Array.isArray(cur.contradictions_struct)
        ? (cur.contradictions_struct as unknown[]).length
        : 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const valBlock = ((cur.full_report as any) ?? {}).validation ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ess = typeof (valBlock as any).ess === "number" ? (valBlock as any).ess : null;
      const [{ count: docCount }, { count: findCount }] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("case_id", caseId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("case_findings")
          .select("id", { count: "exact", head: true })
          .eq("case_id", caseId)
          .not("source_module", "like", PROJECTION_LIKE),
      ]);
      await snapshotReportVersion(supabase, {
        caseId,
        userId,
        version: baselineVersion || 1,
        report: cur,
        changeLog: (cur.change_log as Record<string, unknown> | null) ?? null,
        meta: {
          documentCount: docCount ?? 0,
          findingsCount: findCount ?? 0,
          contradictionCount: contradictions,
          ess,
          score:
            typeof cur.case_strength_score === "number"
              ? (cur.case_strength_score as number)
              : null,
        },
      });
    }

    // 2. Upload the new evidence.
    const uploads = await Promise.all(
      files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const { uploadFiles } = await import("@/lib/pipeline.server");
    const uploadResult = await uploadFiles({ db: supabase, caseId, userId, uploads });
    const newDocIds = uploadResult.uploadedDocumentIds;
    if (uploadResult.uploaded === 0) {
      return {
        ok: true,
        uploaded: 0,
        skipped: uploadResult.skipped,
        excludedNonEvidentiary: uploadResult.excludedNonEvidentiary,
        revisedDocuments: uploadResult.revisedDocuments,
        newDocumentIds: [],
        snapshottedVersion: null,
        nextVersion: baselineVersion || null,
        rerunScope,
        startFrom: null,
        affectedStages: [],
      };
    }

    // 3. Run extraction synchronously for the new docs. runExtraction is
    // idempotent: already-extracted documents are skipped, so only the
    // freshly-uploaded files do work.
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const { keys } = await resolveProviderKeys(supabase, userId, "groq");
    const apiKey = keys[0] ?? getApiKey();
    const { runExtraction } = await import("@/lib/pipeline.server");
    try {
      await runExtraction({ db: supabase, caseId, userId, apiKey, apiKeys: keys });
    } catch (e) {
      console.error("[add-evidence] extraction error", e);
    }

    // 4. Bump report version so the next runReport produces vN+1.
    if (currentReport) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("reports")
        .update({ version: baselineVersion + 1 })
        .eq("case_id", caseId);
    }

    return {
      ok: true,
      uploaded: uploadResult.uploaded,
      skipped: uploadResult.skipped,
      excludedNonEvidentiary: uploadResult.excludedNonEvidentiary,
      revisedDocuments: uploadResult.revisedDocuments,
      newDocumentIds: newDocIds,
      snapshottedVersion: baselineVersion || null,
      nextVersion: baselineVersion + 1,
      rerunScope,
      startFrom: rerunScope === "new_documents_only" ? null : "analyzers",
      // Whole-corpus engines that must rerun because a new doc can shift
      // cross-document outputs (contradictions, timeline, witness, etc.).
      affectedStages:
        rerunScope === "new_documents_only"
          ? []
          : [
        "analyzers",
        "agents",
        "timeline",
        "evidence_map",
        "contradictions",
        "witness",
        "evidence_intel",
        "discovery",
        "perspectives",
        "theories",
        "opportunities",
        "strategy",
        "work_product",
        "hallucination",
        "scoring",
        "report",
      ],
    };
  });

// Compute "What's Changed" between the latest snapshot in report_versions and
// the current report, then persist it on reports.change_log.
export async function finalizeReportChangeLogForCase(
  supabase: Db,
  caseId: string,
) {
    const [reportRes, snapRes, findingsRes, witnessRes, docsRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("reports").select("*").eq("case_id", caseId).maybeSingle(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("report_versions")
      .select("snapshot,version")
      .eq("case_id", caseId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("case_findings")
      .select("id,title")
      .eq("case_id", caseId)
      .not("source_module", "like", PROJECTION_LIKE),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("case_witnesses").select("id,name,credibility").eq("case_id", caseId),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("documents").select("id").eq("case_id", caseId),
  ]);
  const report = reportRes.data as Record<string, unknown> | null;
  const snap = snapRes.data as { snapshot: Record<string, unknown>; version: number } | null;
  if (!report) return { ok: false, reason: "no report" };
  if (!snap?.snapshot) return { ok: false, reason: "no prior snapshot" };

  const prev = snap.snapshot;
  const cur = report;
  const countContradictions = (r: Record<string, unknown> | null) =>
    r && Array.isArray(r.contradictions_struct)
      ? (r.contradictions_struct as unknown[]).length
      : 0;

  // Which narrative sections actually changed, and why. Deterministic
  // string diff over the prose columns — no AI, no guessing.
  const NARRATIVE_KEYS = [
    "executive_summary",
    "attorney_summary",
    "investigator_summary",
    "case_overview",
    "facts",
    "timeline_summary",
    "evidence_summary",
    "witness_analysis",
    "contradiction_report",
    "discovery_analysis",
    "missing_evidence_report",
    "constitutional_issues",
    "procedural_issues_report",
    "prosecution_theory_report",
    "defense_theory_report",
    "alternative_theory_report",
    "risk_analysis",
    "score_breakdown",
    "recommendations",
    "appendix_sources",
  ] as const;
  const asText = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const sectionsChanged = NARRATIVE_KEYS.filter((k) => asText(prev[k]) !== asText(cur[k])).map(
    (k) => ({
      section: k,
      status: !asText(prev[k]) ? "added" : !asText(cur[k]) ? "removed" : "revised",
      prev_chars: asText(prev[k]).length,
      now_chars: asText(cur[k]).length,
    }),
  );

  const prevDocs = Number(
    (prev.full_report as Record<string, unknown> | null)?.documents_total ?? NaN,
  );
  const nowDocs = (docsRes.data ?? []).length;
  const drivers: string[] = [];
  if (Number.isFinite(prevDocs) && nowDocs > prevDocs) {
    drivers.push(`${nowDocs - prevDocs} nuevo(s) documento(s) ingresado(s) al expediente.`);
  }
  const cDelta = countContradictions(cur) - countContradictions(prev);
  if (cDelta !== 0) {
    drivers.push(
      cDelta > 0
        ? `${cDelta} contradicción(es) adicional(es) verificada(s).`
        : `${Math.abs(cDelta)} contradicción(es) dejaron de verificarse.`,
    );
  }
  const sPrev = typeof prev.case_strength_score === "number" ? prev.case_strength_score : null;
  const sNow = typeof cur.case_strength_score === "number" ? cur.case_strength_score : null;
  if (sPrev != null && sNow != null && sPrev !== sNow) {
    drivers.push(
      `La fuerza del caso pasó de ${sPrev} a ${sNow} tras la nueva evidencia verificada.`,
    );
  }
  if (!!prev.scores_suppressed !== !!cur.scores_suppressed) {
    drivers.push(
      cur.scores_suppressed
        ? "La suficiencia probatoria cayó por debajo del umbral: se suprimieron los puntajes."
        : "La suficiencia probatoria alcanzó el umbral: se reactivaron los puntajes.",
    );
  }

  const currentVersion = Number(cur.version ?? Number(snap.version ?? 1) + 1);

  // Addendum §24/§26 — per-finding delta classification underneath the
  // existing quantitative diff above. Snapshot current findings first so
  // classifyFindingDeltas has this version's rows to compare the NEXT
  // regeneration against; both are pure DB ops, no AI calls, and neither
  // touches the report/report_versions tables this function already
  // writes to above.
  const { snapshotFindingVersions, classifyFindingDeltas } =
    await import("@/lib/intelligence/finding-version-snapshot.server");
  await snapshotFindingVersions(supabase, { caseId, reportVersion: currentVersion });
  const findingDeltas = await classifyFindingDeltas(supabase, { caseId, currentVersion });

  // §24's "no unexplained changes" rule: if the score moved but nothing
  // in `drivers` (the existing quantitative diff above) or the finding
  // deltas explains it, flag it rather than silently presenting the new
  // number as settled.
  const scoreChanged = sPrev != null && sNow != null && sPrev !== sNow;
  const hasFindingLevelExplanation =
    findingDeltas.new.length +
      findingDeltas.strengthened.length +
      findingDeltas.weakened.length +
      findingDeltas.resolved.length >
    0;
  const unexplainedScoreChange =
    scoreChanged && drivers.length === 0 && !hasFindingLevelExplanation;

  const changeLog = {
    generated_at: new Date().toISOString(),
    previous_version: Number(snap.version ?? 1),
    current_version: currentVersion,
    documents_total: nowDocs,
    score_delta: {
      strength: { prev: prev.case_strength_score ?? null, now: cur.case_strength_score ?? null },
      risk: { prev: prev.risk_score ?? null, now: cur.risk_score ?? null },
    },
    ess: {
      prev_suppressed: !!prev.scores_suppressed,
      now_suppressed: !!cur.scores_suppressed,
    },
    contradictions: { prev: countContradictions(prev), now: countContradictions(cur) },
    findings_total: (findingsRes.data ?? []).length,
    witnesses_total: (witnessRes.data ?? []).length,
    sections_changed: sectionsChanged,
    drivers,
    // Addendum §24/§26 additions — per-finding classification and an
    // explicit fail-safe flag rather than a silent unexplained move.
    finding_deltas: findingDeltas,
    unexplained_score_change: unexplainedScoreChange,
    note: "Quantitative diff vs. the snapshot captured before the most recent Add Evidence run. Review narrative sections for qualitative changes.",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from("reports").update({ change_log: changeLog }).eq("case_id", caseId);
  return { ok: true, change_log: changeLog };

}

export const finalizeReportChangeLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "FinalizeChangeLog");
    return finalizeReportChangeLogForCase(supabase, data.caseId);
  });

// -------- Talk-to-Case "Push to Report" — patch, don't rerun --------
// Replaces the old flow (Talk-to-Case -> addEvidenceAndRerun -> full
// pipeline rerun) which regenerated findings from the SAME unchanged
// corpus every time, so a finding the attorney had just gotten corrected
// could simply reappear. This reviews the chat exchange against the
// EXISTING findings, produces a grounded patch set (keep/amend/remove/
// merge/create — see chat-patch.server.ts), applies it directly to
// case_findings (never deleting a row — "remove" supersedes it with full
// provenance), and regenerates ONLY the report from that updated state.
// It never calls queueCaseForPipeline/addEvidenceAndRerun/drivePipeline and
// never re-runs an analyzer/agent/engine stage — runReport() below
// no-ops its own upstream-backfill check because every required engine
// already has a completed run (see ensureRequiredEngines in
// pipeline.server.ts).
// Shared by previewCaseChatCorrections and pushCaseChatCorrectionsToReport:
// resolves the chat exchange (question + answer) a chatMessageId points at,
// plus every real, permanently-attached case document (never the old flow's
// synthetic "case-chat-clarification-*.txt" files) so a patch can ground
// itself in an attachment.
async function fetchChatExchangeForPatching(supabase: Db, caseId: string, chatMessageId: string) {
  const { data: msgRows } = await supabase
    .from("case_chat_messages")
    .select("id,role,content,created_at")
    .eq("case_id", caseId)
    .order("created_at");
  const rows = (msgRows ?? []) as Array<{
    id: string;
    role: string;
    content: string;
    created_at: string;
  }>;
  const idx = rows.findIndex((m) => m.id === chatMessageId);
  if (idx === -1) throw new Error("Chat message not found");
  const answerMsg = rows[idx];
  const questionMsg = [...rows.slice(0, idx)].reverse().find((m) => m.role === "user");

  const { data: docsRows } = await supabase
    .from("documents")
    .select("id,filename,extracted_text")
    .eq("case_id", caseId)
    .not("filename", "like", "case-chat-clarification-%");

  return {
    question: questionMsg?.content ?? "",
    answer: answerMsg.content,
    attachedDocs: (docsRows ?? []) as Array<{
      id: string;
      filename: string;
      extracted_text: string | null;
    }>,
  };
}

const FINDING_PATCH_SCHEMA = z.object({
  action: z.enum(["keep", "amend", "remove", "merge", "create", "dispute_evidence"]),
  finding_ids: z.array(z.string().uuid()),
  reason: z.string().min(1),
  quote: z.string().min(1),
  source_document_id: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1),
  new_title: z.string().optional(),
  new_description: z.string().optional(),
  new_category: z.string().optional(),
  new_severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  disputed_doc_id: z.string().uuid().optional(),
  dispute_status: z.enum(["disputed", "superseded", "withdrawn"]).optional(),
  error_type: z
    .enum([
      "unsupported_claim",
      "bad_evidence_link",
      "wrong_evidence_interpretation",
      "duplicate_finding",
      "contradiction_misclassification",
      "wrong_legal_authority",
      "wrong_procedural_rule",
      "wrong_severity",
      "wrong_confidence",
      "missing_finding",
      "false_positive",
      "false_negative",
      "temporal_error",
      "source_classification_error",
      "report_rendering_error",
      "other",
    ])
    .optional(),
  source_document_purpose: z
    .enum([
      "case_evidence",
      "correction_support",
      "finding_correction",
      "report_correction",
      "context_only",
      "user_instruction",
      "counter_evidence",
      "duplicate",
      "irrelevant",
    ])
    .optional(),
});

// Pure read — reviews the exchange and returns the proposed patch set plus
// its dependency impact (which OTHER findings/scores/opportunities/report
// citations the correction would touch) for the attorney to review. Writes
// NOTHING. The client round-trips the returned `patches` array back to
// pushCaseChatCorrectionsToReport's `patches` argument once the attorney
// clicks Apply — this is the "Proposal -> Validation -> Dependency Analysis
// -> Revision Plan -> User Approval" chain the case-revision architecture
// requires; pushCaseChatCorrectionsToReport never (re)generates a patch set
// on its own.
export const previewCaseChatCorrections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        chatMessageId: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "PreviewChatCorrections");
    await assertCaseOwner(supabase, data.caseId, userId);
    const caseId = data.caseId;

    const exchange = await fetchChatExchangeForPatching(supabase, caseId, data.chatMessageId);

    const { generateFindingPatchSet, computeCorrectionImpact } =
      await import("@/lib/intelligence/chat-patch.server");
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const { keys } = await resolveProviderKeys(supabase, userId, "groq");
    const apiKey = keys[0] ?? getApiKey();

    const patchSet = await generateFindingPatchSet(supabase, caseId, userId, exchange, apiKey);
    if (patchSet.patches.length === 0) {
      return {
        ok: true as const,
        patches: [],
        ungrounded: patchSet.ungrounded,
        impact: null,
        currentFindings: [],
        // Self-audit (Phase B) covers every active finding, not just ones
        // this exchange proposes correcting — surfaced even when there's
        // nothing to approve.
        selfAuditNotices: patchSet.selfAuditNotices,
      };
    }

    const impact = await computeCorrectionImpact(supabase, caseId, patchSet.patches);

    // Current title/category/severity for every finding a patch targets, so
    // the UI can render "current vs. proposed" without a second round trip.
    const touchedIds = [...new Set(patchSet.patches.flatMap((p) => p.finding_ids))];
    const { data: currentRows } =
      touchedIds.length > 0
        ? await supabase
            .from("case_findings")
            .select("id,title,category,severity")
            .eq("case_id", caseId)
            .in("id", touchedIds)
        : { data: [] };

    return {
      ok: true as const,
      patches: patchSet.patches,
      ungrounded: patchSet.ungrounded,
      impact,
      currentFindings: currentRows ?? [],
      selfAuditNotices: patchSet.selfAuditNotices,
    };
  });

export const pushCaseChatCorrectionsToReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        chatMessageId: z.string().uuid(),
        // The exact patch set previewCaseChatCorrections returned, echoed
        // back once the attorney approves it — see that function's doc
        // comment. Re-validated against this case's OWN active findings
        // below before anything is written; never trusted as-is.
        patches: z.array(FINDING_PATCH_SCHEMA).min(1),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "PushChatCorrections");
    await assertCaseOwner(supabase, data.caseId, userId);
    const caseId = data.caseId;

    // Deterministic validation (spec: never trust a round-tripped patch set
    // as-is) — every finding_id a patch targets must be an active finding
    // that actually belongs to THIS case, or the whole request is rejected
    // rather than silently no-op-updating zero rows.
    const { data: activeFindingRows } = await supabase
      .from("case_findings")
      .select("id")
      .eq("case_id", caseId)
      .is("superseded_at", null);
    const activeIds = new Set((activeFindingRows ?? []).map((r) => r.id));
    const staleFindingIds = new Set<string>();
    for (const patch of data.patches) {
      for (const fid of patch.finding_ids) {
        if (!activeIds.has(fid)) staleFindingIds.add(fid);
      }
    }
    if (staleFindingIds.size > 0) {
      // A target finding was superseded by something else since this patch
      // set was generated (an earlier merge/remove correction on the same
      // case, a rerun — anything that can set superseded_at). Previously
      // this threw a bare error and stranded the attorney with a dead modal
      // and no next step. The correct recovery is exactly what clicking
      // "Review correction" again would do: regenerate the proposal from
      // the CURRENT findings and hand it back so the client can show what
      // changed instead of failing closed with nothing to act on. This is
      // still "never trust a round-tripped patch set as-is" — the stale
      // one is discarded outright, never partially applied.
      const exchange = await fetchChatExchangeForPatching(supabase, caseId, data.chatMessageId);
      const { generateFindingPatchSet, computeCorrectionImpact } =
        await import("@/lib/intelligence/chat-patch.server");
      const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
      const { keys: refreshKeys } = await resolveProviderKeys(supabase, userId, "groq");
      const refreshApiKey = refreshKeys[0] ?? getApiKey();
      const refreshedSet = await generateFindingPatchSet(
        supabase,
        caseId,
        userId,
        exchange,
        refreshApiKey,
      );
      const refreshedImpact =
        refreshedSet.patches.length > 0
          ? await computeCorrectionImpact(supabase, caseId, refreshedSet.patches)
          : null;
      const refreshedTouchedIds = [
        ...new Set(refreshedSet.patches.flatMap((p) => p.finding_ids)),
      ];
      const { data: refreshedCurrentRows } =
        refreshedTouchedIds.length > 0
          ? await supabase
              .from("case_findings")
              .select("id,title,category,severity")
              .eq("case_id", caseId)
              .in("id", refreshedTouchedIds)
          : { data: [] };
      return {
        ok: false as const,
        reason: "stale_target" as const,
        staleFindingIds: [...staleFindingIds],
        refreshedPreview: {
          patches: refreshedSet.patches,
          ungrounded: refreshedSet.ungrounded,
          impact: refreshedImpact,
          currentFindings: refreshedCurrentRows ?? [],
          selfAuditNotices: refreshedSet.selfAuditNotices,
        },
      };
    }

    const { applyFindingPatchSet, computeCorrectionImpact } =
      await import("@/lib/intelligence/chat-patch.server");
    const { resolveProviderKeys } = await import("@/lib/ai-key-router.server");
    const { keys } = await resolveProviderKeys(supabase, userId, "groq");
    const apiKey = keys[0] ?? getApiKey();

    // Decide, BEFORE applying, whether the current score is actually built
    // from any finding this correction touches — targeted re-evaluation
    // (spec: don't rerun engines nothing depends on) rather than either
    // always skipping scoring (the prior gap) or always recomputing it.
    const impact = await computeCorrectionImpact(supabase, caseId, data.patches);

    const outcomes = await applyFindingPatchSet(
      supabase,
      caseId,
      userId,
      data.patches,
      data.chatMessageId,
    );

    // Continuous Legal Intelligence (§5/§6) — one lesson per applied patch,
    // scoped by this case's own matter type/jurisdiction (never assumed
    // Mexican-only — jurisdiction_country defaults to 'MX' only when the
    // case row itself doesn't say otherwise, keeping this ready for
    // non-Mexican matters without a schema change). Best-effort: never
    // blocks the correction that just succeeded.
    {
      const { recordLesson } = await import("@/lib/intelligence/chat-patch.server");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: caseRow } = await (supabase as any)
        .from("cases")
        .select("case_type,jurisdiction")
        .eq("id", caseId)
        .maybeSingle();
      const matterType = (caseRow as { case_type?: string | null } | null)?.case_type ?? null;
      for (let i = 0; i < data.patches.length; i++) {
        try {
          await recordLesson(
            supabase,
            caseId,
            userId,
            data.patches[i],
            outcomes[i],
            matterType,
            "MX",
          );
        } catch (e) {
          console.error("[push-chat-corrections] failed to record lesson", e);
        }
      }
    }

    if (impact.scoreAffected) {
      const { runScoring } = await import("@/lib/pipeline.server");
      try {
        await runScoring({ db: supabase, caseId, userId, apiKey, apiKeys: keys });
      } catch (e) {
        console.error("[push-chat-corrections] targeted rescoring failed", e);
      }
    }

    // Snapshot the pre-patch report + bump the version, same convention
    // addEvidenceAndRerun uses, so finalizeReportChangeLog (called by the
    // client right after this, exactly like the old flow did) has a
    // baseline to diff the regenerated report against.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: currentReport } = await (supabase as any)
      .from("reports")
      .select("*")
      .eq("case_id", caseId)
      .maybeSingle();
    const baselineVersion: number = Number(currentReport?.version ?? 0) || 0;
    if (currentReport) {
      const { snapshotReportVersion } = await import("@/lib/intelligence/report-version.server");
      const cur = currentReport as Record<string, unknown>;
      const contradictions = Array.isArray(cur.contradictions_struct)
        ? (cur.contradictions_struct as unknown[]).length
        : 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const valBlock = ((cur.full_report as any) ?? {}).validation ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ess = typeof (valBlock as any).ess === "number" ? (valBlock as any).ess : null;
      const [{ count: docCount }, { count: findCount }] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("case_id", caseId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("case_findings")
          .select("id", { count: "exact", head: true })
          .eq("case_id", caseId)
          .not("source_module", "like", PROJECTION_LIKE),
      ]);
      await snapshotReportVersion(supabase, {
        caseId,
        userId,
        version: baselineVersion || 1,
        report: cur,
        changeLog: (cur.change_log as Record<string, unknown> | null) ?? null,
        meta: {
          documentCount: docCount ?? 0,
          findingsCount: findCount ?? 0,
          contradictionCount: contradictions,
          ess,
          score:
            typeof cur.case_strength_score === "number"
              ? (cur.case_strength_score as number)
              : null,
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("reports")
        .update({ version: baselineVersion + 1 })
        .eq("case_id", caseId);

      // Backfill the revision number onto this batch's audit rows now that
      // it's known — groups them as "what changed in revision N" without a
      // parallel case_revision table (see migration
      // 20260813231500_case_finding_patch_revision_version).
      const auditRowIds = outcomes.map((o) => o.auditRowId).filter((id): id is string => !!id);
      if (auditRowIds.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any)
          .from("case_finding_patches")
          .update({ report_version: baselineVersion + 1 })
          .in("id", auditRowIds);
      }
    }

    // Regenerate the report from the now-patched findings state only. This
    // is the SAME runReport() every full pipeline run's report stage calls
    // — it is independently callable and its own pre-flight backfill
    // (ensureRequiredEngines) no-ops here because every required upstream
    // engine already has a completed pipeline_engine_runs row. No analyzer,
    // agent, discovery, contradiction, or evidence-intel engine re-runs;
    // scoring only re-runs when computeCorrectionImpact found this
    // correction actually touches a finding the current score is built
    // from (see above).
    const { runReport } = await import("@/lib/pipeline.server");
    await runReport({ db: supabase, caseId, userId, apiKey, apiKeys: keys });

    // Bounded revision-consistency check on the freshly-regenerated report:
    // does it still cite a finding this correction just superseded? Flags
    // for review — does not auto-rewrite prose (see findStaleCitations).
    const { findStaleCitations } = await import("@/lib/intelligence/chat-patch.server");
    const staleCitations = await findStaleCitations(
      supabase,
      caseId,
      data.patches.flatMap((p) => p.finding_ids),
    );

    return {
      ok: true as const,
      applied: outcomes,
      rescored: impact.scoreAffected,
      nextVersion: currentReport ? baselineVersion + 1 : null,
      staleCitations,
    };
  });

// List snapshotted report versions for a case (newest first).
export const listReportVersions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ caseId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "ListReportVersions");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows } = await (supabase as any)
      .from("report_versions")
      .select(
        "id,version,created_at,change_log,document_count,findings_count,contradiction_count,ess,score,report_hash,triggering_upload_id",
      )
      .eq("case_id", data.caseId)
      .order("version", { ascending: false });
    return rows ?? [];
  });

// Sections of `reports.full_report` rendered as tables/lists on the Reports
// page that are generated analysis text, not their own DB rows. There is
// nothing with a real id to delete, so "archive"/"delete" here means:
// persist an editorial flag on the report row (visible to every user who
// opens this case), and every renderer of full_report is expected to filter
// against it. This does NOT retroactively rewrite full_report JSON, and it
// is NOT currently applied inside PDF/DOCX/JSON export generation — only the
// on-screen Reports page respects it right now.
const REPORT_ITEM_SECTIONS = [
  "evidence_inventory",
  "legal_issues",
  "contradictions",
  "agent_statistics",
  "witness_profiles",
  "case_opportunities",
  "attorney_work_product",
] as const;

export const setReportItemFlag = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        section: z.enum(REPORT_ITEM_SECTIONS),
        itemKey: z.string().min(1).max(200),
        flag: z.enum(["active", "archived", "deleted"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = await getAuthedContext(context, "SetReportItemFlag");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (supabase as any)
      .from("reports")
      .select("item_flags")
      .eq("case_id", data.caseId)
      .maybeSingle();
    if (!row) throw new Error("Report not found");
    const current = (row.item_flags ?? {}) as Record<string, Record<string, string>>;
    const section = { ...(current[data.section] ?? {}) };
    if (data.flag === "active") {
      delete section[data.itemKey];
    } else {
      section[data.itemKey] = data.flag;
    }
    const next = { ...current, [data.section]: section };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("reports")
      .update({ item_flags: next })
      .eq("case_id", data.caseId);
    if (error) throw new Error(error.message);
    return { ok: true, item_flags: next };
  });

export const logReportExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        format: z.enum(["pdf", "docx", "json"]),
        caseName: z.string().max(300).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = await getAuthedContext(context, "LogReportExport");
    const { logAudit } = await import("./audit.server");
    await logAudit({
      actorId: userId,
      action: "report_exported",
      target: data.caseId,
      meta: { format: data.format, case_name: data.caseName ?? null },
    });
    return { ok: true };
  });
