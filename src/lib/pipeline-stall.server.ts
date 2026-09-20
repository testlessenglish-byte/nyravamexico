// Stall watchdog. Any case whose `worker_lease_until` has expired without a
// completed pipeline run is flipped from `running` → `failed` with an explicit
// `stall_reason` so the UI can show "Stalled — click Resume" instead of a
// perpetually-running spinner. Called from:
//  - the pipeline-worker cron tick (defense in depth)
//  - a client-triggered server fn on case-page mount (recovers cases whose
//    worker died between ticks and whose owner is looking at the page now)
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Db = SupabaseClient<Database>;

// A case that hasn't heartbeat in this long is considered stalled (matches 3-min lease).
const DEFAULT_STALL_MS = 3 * 60 * 1000;

// A case may be auto-retried this many times before the watchdog stops
// retrying and falls back to the old "mark failed, wait for a human to click
// Resume" behavior. Bounded so a deterministically-hanging stage (a real bug,
// not a transient timeout) doesn't retry forever and burn AI spend silently —
// it surfaces as a normal stall requiring attention after this many tries,
// same as before this change existed.
const MAX_AUTO_STALL_RETRIES = 3;

export async function sweepStalledCases(
  db: Db,
  opts?: { staleMs?: number; caseId?: string },
): Promise<{ swept: number; autoRetried: number; ids: string[] }> {
  const staleMs = opts?.staleMs ?? DEFAULT_STALL_MS;
  const cutoff = new Date(Date.now() - staleMs).toISOString();

  // Pass 0 — unstick QUEUED cases. This status was invisible to the sweeper,
  // yet it is where cases got trapped: a heartbeat firing just after a
  // checkpoint re-stamped a lease on an already-queued case, and
  // claim_next_queued_case skips leased rows. Also repairs a queued row that
  // lost its queued_at (the claimer requires it to be non-null).
  try {
    const nowIso = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let qq: any = (db as any)
      .from("cases")
      .select("id,queued_at,worker_lease_until,updated_at")
      .eq("status", "queued")
      .lt("updated_at", cutoff);
    if (opts?.caseId) qq = qq.eq("id", opts.caseId);
    const { data: queuedRows } = await qq;
    for (const r of (queuedRows ?? []) as Array<{
      id: string;
      queued_at: string | null;
      worker_lease_until: string | null;
    }>) {
      const leaseInFuture =
        !!r.worker_lease_until && new Date(r.worker_lease_until).getTime() > Date.now();
      if (!leaseInFuture && r.queued_at) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any)
        .from("cases")
        .update({
          worker_lease_until: null,
          queued_at: r.queued_at ?? nowIso,
          stall_reason: null,
        })
        .eq("id", r.id)
        .eq("status", "queued");
      console.info(
        `[stall-watchdog] released stale queued lease for case ${r.id} (lease=${r.worker_lease_until ?? "null"})`,
      );
    }
  } catch (e) {
    console.warn("[stall-watchdog] queued-lease sweep failed", e);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = (db as any)
    .from("cases")
    .select("id,status,updated_at,worker_lease_until,queued_at,stall_auto_retry_count")
    .in("status", ["uploaded", "extracting", "analyzing", "scoring", "reporting", "intelligence_running"])
    .lt("updated_at", cutoff);
  if (opts?.caseId) q = q.eq("id", opts.caseId);
  const { data: rows } = await q;
  const candidates = (rows ?? []) as Array<{
    id: string;
    worker_lease_until: string | null;
    stall_auto_retry_count: number | null;
  }>;
  const stalled = candidates.filter((c) => {
    // Respect an unexpired lease — an active worker is still allowed its
    // full lease window regardless of the coarser updated_at heuristic.
    if (!c.worker_lease_until) return true;
    return new Date(c.worker_lease_until).getTime() < Date.now();
  });

  // Split by remaining auto-retry budget: cases still under the cap get
  // requeued automatically instead of dumped on the user to manually resume.
  const retryable = stalled.filter((c) => (c.stall_auto_retry_count ?? 0) < MAX_AUTO_STALL_RETRIES);
  const exhausted = stalled.filter((c) => (c.stall_auto_retry_count ?? 0) >= MAX_AUTO_STALL_RETRIES);

  let autoRetried = 0;
  const autoRetriedIds = new Set<string>();
  for (const c of retryable) {
    try {
      const { autoRequeueStalledCase } = await import("./cases.functions");
      const result = await autoRequeueStalledCase(db, c.id);
      if (result.ok) {
        autoRetried += 1;
        autoRetriedIds.add(c.id);
      }
      console.info(`[stall-watchdog] auto-retried case ${c.id}${result.resumeKey ? ` at ${result.resumeKey}` : ""}`);
    } catch (e) {
      console.warn(`[stall-watchdog] auto-retry failed for case ${c.id}, falling back to manual-resume`, e);
      exhausted.push(c);
    }
  }

  const ids = exhausted.map((c) => c.id);
  if (ids.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from("cases")
      .update({
        status: "failed",
        status_message: "Stalled — worker timed out. Click Resume to continue.",
        stall_reason: "worker_timeout",
        worker_lease_until: null,
        queued_at: null,
      })
      .in("id", ids);
    if (error) {
      console.warn("[stall-watchdog] case update failed", error);
    }
  }

  // Always sweep orphan `pipeline_engine_runs` rows — a row that has been
  // `running` longer than the stall cutoff cannot recover on its own, and
  // leaves the Engine Status ledger permanently stuck. Force-fail them so
  // every ledger row terminates in `completed` or `failed`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ledgerQ: any = opts?.caseId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (db as any)
        .from("pipeline_engine_runs")
        .update({
          status: "failed",
          ended_at: new Date().toISOString(),
          error: "Stalled — worker timed out before writing terminal state",
        })
        .eq("status", "running")
        .lt("started_at", cutoff)
        .eq("case_id", opts.caseId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : (db as any)
        .from("pipeline_engine_runs")
        .update({
          status: "failed",
          ended_at: new Date().toISOString(),
          error: "Stalled — worker timed out before writing terminal state",
        })
        .eq("status", "running")
        .lt("started_at", cutoff);
  const { data: ledgerRows, error: ledgerErr } = await ledgerQ.select("id,case_id");
  const ledgerCount = (ledgerRows as Array<{ id: string; case_id?: string | null }> | null)?.length ?? 0;
  if (ledgerErr) {
    console.warn("[stall-watchdog] ledger sweep failed", ledgerErr);
  } else if (ledgerCount && ledgerCount > 0) {
    console.info(`[stall-watchdog] force-failed ${ledgerCount} stale engine run(s)`);
    // Exclude cases this same sweep just auto-retried above — otherwise this
    // orphan-ledger cleanup (which runs unconditionally, independent of the
    // case-level retry budget) would immediately re-fail a case in the same
    // call that just successfully requeued it back to "queued".
    const ledgerCaseIds = [...new Set(
      ((ledgerRows as Array<{ case_id?: string | null }> | null) ?? [])
        .map((r) => r.case_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && !autoRetriedIds.has(id)),
    )];
    if (ledgerCaseIds.length > 0) {
      // If a stale engine row timed out, the case itself must not remain
      // `intelligence_running` behind an unexpired worker lease. The live
      // trial_prep failure reproduced exactly this split-brain state: ledger
      // failed, case still running, UI stuck. Terminate the case state too.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: caseFromLedgerErr } = await (db as any)
        .from("cases")
        .update({
          status: "failed",
          status_message: "Stalled — worker timed out. Click Resume to continue.",
          stall_reason: "worker_timeout",
          worker_lease_until: null,
          queued_at: null,
        })
        .in("id", ledgerCaseIds)
        .in("status", ["uploaded", "extracting", "analyzing", "scoring", "reporting", "intelligence_running"]);
      if (caseFromLedgerErr) {
        console.warn("[stall-watchdog] case update from ledger stall failed", caseFromLedgerErr);
      }
    }
  }

  if (ids.length) console.info(`[stall-watchdog] force-failed ${ids.length} stalled case(s) (retry budget exhausted)`);
  return { swept: ids.length, autoRetried, ids };
}


// Re-queue a case that voluntarily checkpointed out mid-stage. Idempotent —
// safe to call multiple times.
export async function requeueForContinuation(
  db: Db,
  caseId: string,
  reason: string,
): Promise<void> {
  const queuedAt = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).from("cases").update({
    status: "queued",
    status_message: `Checkpoint reached — continuing (${reason})`,
    queued_at: queuedAt,
    worker_lease_until: null,
    next_stage: reason,
    stall_reason: null,
  }).eq("id", caseId);
  console.info(`[pipeline] ${JSON.stringify({
    t: queuedAt,
    event: "checkpoint.requeued",
    caseId,
    next_stage: reason,
    status: "queued",
  })}`);
}
