// Background pipeline worker. Called by pg_cron every minute.
// - Leases one queued case at a time (SKIP LOCKED semantics via
//   worker_lease_until timestamp so parallel ticks don't double-process).
// - Runs the full pipeline for that case using the admin client (bypasses RLS).
// - Clears queue markers on completion/failure.
//
// Security: this route lives under /api/public/* so it isn't behind auth,
// but it validates the Supabase anon apikey header AND requires an internal
// worker secret. Never returns row data.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const LEASE_MS = 3 * 60 * 1000; // 3 minutes

function workerTrace(event: string, extra: Record<string, unknown> = {}) {
  console.info(
    `[pipeline-worker] ${JSON.stringify({
      t: new Date().toISOString(),
      event,
      ...extra,
    })}`,
  );
}

/**
 * Persist a worker-phase trace row so the case's Live Debug panel shows queue
 * pickup / lease / requeue events, not just in-stage activity. Best-effort.
 */
async function workerTracePersist(
  admin: ReturnType<typeof createClient<Database>>,
  caseId: string | null | undefined,
  step: string,
  status: "start" | "ok" | "warn" | "error" | "info",
  detail: Record<string, unknown> = {},
  error?: string | null,
) {
  workerTrace(step, { caseId: caseId ?? null, status, ...detail, error: error ?? null });
  if (!caseId) return;
  try {
    const { trace } = await import("@/lib/pipeline-trace.server");
    await trace({
      db: admin as never,
      caseId,
      phase: "worker",
      step,
      status,
      detail,
      error: error ?? null,
    });
  } catch (e) {
    console.warn("[pipeline-worker] trace persist failed", e);
  }
}

async function leaseOneCase(admin: ReturnType<typeof createClient<Database>>) {
  // 1. Try atomic PostgreSQL RPC with FOR UPDATE SKIP LOCKED
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rpcRows, error: rpcErr } = await (admin as any).rpc("claim_next_queued_case", {
      p_lease_ms: LEASE_MS,
      p_worker_id: "pipeline-worker",
    });
    if (!rpcErr && Array.isArray(rpcRows) && rpcRows.length > 0 && rpcRows[0]?.claimed) {
      const row = rpcRows[0];
      await workerTracePersist(admin, row.case_id, "worker.lease_acquired", "ok", {
        next_stage: row.next_stage ?? null,
        execution_id: row.execution_id,
        lease_ms: LEASE_MS,
      });
      return {
        id: row.case_id as string,
        user_id: row.user_id as string,
        next_stage: (row.next_stage as string | null) ?? null,
        execution_id: row.execution_id as string,
      };
    }
  } catch (rpcEx) {
    console.warn("[pipeline-worker] claim_next_queued_case rpc exception", rpcEx);
  }

  // 2. Fallback CAS if RPC is not yet installed
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  const buildBase = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (admin as any)
      .from("cases")
      .select("id,user_id,worker_lease_until,queued_at,next_stage,execution_id")
      .eq("status", "queued")
      .not("queued_at", "is", null)
      .order("queued_at", { ascending: true })
      .limit(1);
  const nullLease = await buildBase().is("worker_lease_until", null);
  let cand:
    | { id: string; user_id: string; worker_lease_until: string | null; next_stage: string | null; execution_id: string | null }
    | undefined = Array.isArray(nullLease.data) ? nullLease.data[0] : undefined;
  if (!cand) {
    const expired = await buildBase().lt("worker_lease_until", now.toISOString());
    cand = Array.isArray(expired.data) ? expired.data[0] : undefined;
  }
  if (!cand) {
    workerTrace("worker.no_queued_cases", { nullLeaseErr: nullLease.error?.message ?? null });
    return null;
  }
  workerTrace("worker.lease_candidate", { caseId: cand.id, next_stage: cand.next_stage ?? null });
  const executionId = cand.execution_id ?? crypto.randomUUID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (admin as any)
    .from("cases")
    .update({
      worker_lease_until: leaseUntil,
      status: "intelligence_running",
      status_message: "Worker leased",
      execution_id: executionId,
      execution_started_at: new Date().toISOString(),
    })
    .eq("id", cand.id);
  const claimed = cand.worker_lease_until
    ? await q
        .eq("worker_lease_until", cand.worker_lease_until)
        .select("id,user_id,next_stage,execution_id")
        .maybeSingle()
    : await q.is("worker_lease_until", null).select("id,user_id,next_stage,execution_id").maybeSingle();
  if (claimed.error || !claimed.data) {
    await workerTracePersist(
      admin,
      cand.id,
      "worker.lease_cas_failed",
      "warn",
      {},
      claimed.error?.message ?? null,
    );
    return null;
  }
  await workerTracePersist(admin, claimed.data.id, "worker.lease_acquired", "ok", {
    next_stage: claimed.data.next_stage ?? null,
    lease_until: leaseUntil,
  });
  return {
    id: claimed.data.id as string,
    user_id: claimed.data.user_id as string,
    next_stage: (claimed.data.next_stage as string | null) ?? null,
    execution_id: (claimed.data.execution_id as string | null) ?? executionId,
  };
}

type LeasedCase = { id: string; user_id: string; next_stage: string | null; execution_id?: string };

/**
 * Run ONE leased case end-to-end. Fully scoped to `leased.id`: every read,
 * write, trace and lease release targets that case only, so several of these
 * can run concurrently in the same tick without touching each other.
 */
async function processLeasedCase(
  admin: ReturnType<typeof createClient<Database>>,
  leased: LeasedCase,
): Promise<{ caseId: string; ok: boolean; error?: string; deferred?: boolean }> {
  // Optional per-user ceiling (disabled by default — see pipeline-lease.server).
  const { checkUserPipelineCapacity, releasePipelineLease } = await import(
    "@/lib/pipeline-lease.server"
  );
  const capacity = await checkUserPipelineCapacity(
    admin,
    leased.user_id,
    leased.id,
    "pipeline-worker",
  );
  if (!capacity.ok) {
    await releasePipelineLease(
      admin,
      leased.id,
      "pipeline-worker",
      `user_concurrency_limit ${capacity.active}/${capacity.limit}`,
    );
    await workerTracePersist(admin, leased.id, "worker.capacity_deferred", "warn", {
      user_id: leased.user_id,
      active_pipelines: capacity.active,
      limit: capacity.limit,
      reason: "user_concurrency_limit",
    });
    return { caseId: leased.id, ok: true, deferred: true };
  }

  const reset = leased.next_stage === "reset";
  const startFrom = reset ? undefined : (leased.next_stage ?? undefined);
  try {
    const { runPipelineForCase } = await import("@/lib/pipeline-runner.server");
    await workerTracePersist(admin, leased.id, "worker.pipeline_start", "start", {
      reset,
      startFrom: startFrom ?? null,
      executionId: leased.execution_id,
    });
    const result = await runPipelineForCase(admin, leased.user_id, {
      caseId: leased.id,
      reset,
      startFrom,
      executionId: leased.execution_id,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checkpointed = (result as any)?.warnings?.some((w: any) => w?.error === "checkpoint");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failedAt = typeof (result as any)?.failedAt === "string" ? (result as any).failedAt : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = (result as any)?.ok !== false;
    // Read the case's real post-run state. Clearing the queue markers is only
    // safe for a case that actually reached a terminal status — doing it for a
    // case that is still mid-pipeline (the live "report stage failed fast, then
    // queue_cleared" incident) leaves it with no queued_at, no next_stage and
    // no lease: invisible to the claimer forever, recoverable only by a human
    // clicking Clear Stuck Case.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: postRow } = await (admin as any)
      .from("cases")
      .select("status,next_stage")
      .eq("id", leased.id)
      .maybeSingle();
    const postStatus = String(postRow?.status ?? "");
    const action = decidePostRunQueueAction({
      checkpointed,
      status: postStatus,
      nextStage: (postRow?.next_stage as string | null) ?? null,
      failedAt,
      startFrom,
    });

    if (action.kind === "checkpoint_preserved") {
      await workerTracePersist(admin, leased.id, "worker.checkpoint_preserved", "warn", {
        startFrom: startFrom ?? null,
      });
    } else if (action.kind === "clear_queue") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("cases")
        .update({ queued_at: null, worker_lease_until: null, next_stage: null })
        .eq("id", leased.id);
      await workerTracePersist(admin, leased.id, "worker.queue_cleared", "ok", {
        status: postStatus,
      });
    } else {
      // Non-terminal and not a voluntary checkpoint: the invocation ended with
      // work still outstanding. Hand the case straight back to the queue so the
      // next cron tick resumes it automatically.
      const { requeueForContinuation } = await import("@/lib/pipeline-stall.server");
      await requeueForContinuation(admin as never, leased.id, action.resumeKey);
      await workerTracePersist(admin, leased.id, "worker.requeued_incomplete", "warn", {
        ok,
        failedAt,
        status: postStatus,
        resume_key: action.resumeKey,
      });
    }
    return { caseId: leased.id, ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await workerTracePersist(
      admin,
      leased.id,
      "worker.pipeline_failed",
      "error",
      { stack: e instanceof Error ? (e.stack ?? "").split("\n").slice(0, 6).join("\n") : null },
      msg.slice(0, 2000),
    );
    // A thrown invocation is retried automatically a bounded number of times
    // before it is parked as "failed" for a human. Previously every throw
    // nulled queued_at/next_stage immediately, so even a transient error
    // required Clear Stuck Case -> Resume.
    const MAX_WORKER_AUTO_RETRIES = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (admin as any)
      .from("cases")
      .select("next_stage,stall_auto_retry_count")
      .eq("id", leased.id)
      .maybeSingle();
    const attempts = Number(row?.stall_auto_retry_count ?? 0);
    if (attempts < MAX_WORKER_AUTO_RETRIES) {
      const resumeKey = (row?.next_stage as string | null) ?? leased.next_stage ?? "extraction";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("cases")
        .update({ stall_auto_retry_count: attempts + 1, error: msg.slice(0, 2000) })
        .eq("id", leased.id);
      const { requeueForContinuation } = await import("@/lib/pipeline-stall.server");
      await requeueForContinuation(admin as never, leased.id, resumeKey);
      await workerTracePersist(admin, leased.id, "worker.auto_retry_requeued", "warn", {
        attempt: attempts + 1,
        max: MAX_WORKER_AUTO_RETRIES,
        resume_key: resumeKey,
      });
      return { caseId: leased.id, ok: false, error: msg };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from("cases")
      .update({
        queued_at: null,
        worker_lease_until: null,
        status: "failed",
        status_message: "Worker error",
        error: msg.slice(0, 2000),
      })
      .eq("id", leased.id);
    return { caseId: leased.id, ok: false, error: msg };
  }
}

export const Route = createFileRoute("/api/public/hooks/pipeline-worker")({
  server: {
    handlers: {
      GET: async () => new Response("Method Not Allowed", { status: 405 }),
      POST: async ({ request }) => {
        const provided = request.headers.get("x-worker-secret");
        if (!provided) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const url = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !serviceKey) {
          return new Response(JSON.stringify({ error: "backend env unavailable" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const admin = createClient<Database>(url, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
        });

        // Validate the worker secret against the private table (service_role only).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: sec, error: secErr } = await (admin as any)
          .from("worker_secrets")
          .select("secret")
          .eq("name", "pipeline_worker")
          .maybeSingle();
        if (secErr || !sec?.secret) {
          return new Response(JSON.stringify({ error: "worker not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Constant-time compare
        const a = new TextEncoder().encode(provided);
        const b = new TextEncoder().encode(sec.secret);
        let ok = a.length === b.length;
        for (let i = 0; i < Math.min(a.length, b.length); i++) ok = ok && a[i] === b[i];
        if (!ok) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Sweep stalled cases FIRST — recover any case whose lease died between
        // ticks so the next lease pass can pick it up (or the owner sees the
        // "failed — click Resume" state instead of a stuck spinner).
        try {
          const { sweepStalledCases } = await import("@/lib/pipeline-stall.server");
          await sweepStalledCases(admin);
        } catch (e) {
          console.warn("[pipeline-worker] stall sweep failed", e);
        }

        // Drain SEVERAL cases per tick, in parallel. Each has its own CAS
        // lease keyed by case_id, so Case A and Case B run truly
        // concurrently instead of B waiting a full cron minute for A.
        const maxPerTick = Math.max(1, Number(process.env.PIPELINE_WORKER_MAX_PER_TICK ?? 3));
        const leasedCases: LeasedCase[] = [];
        for (let i = 0; i < maxPerTick; i++) {
          const next = await leaseOneCase(admin);
          if (!next) break;
          if (leasedCases.some((c) => c.id === next.id)) break;
          leasedCases.push(next as LeasedCase);
        }
        if (leasedCases.length === 0) {
          return new Response(JSON.stringify({ ok: true, processed: 0 }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        const settled = await Promise.allSettled(
          leasedCases.map((c) => processLeasedCase(admin, c)),
        );
        const results = settled.map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : { caseId: leasedCases[i].id, ok: false, error: String(r.reason) },
        );
        const anyFailed = results.some((r) => !r.ok);
        return new Response(
          JSON.stringify({ ok: !anyFailed, processed: results.length, results }),
          { status: anyFailed ? 500 : 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
