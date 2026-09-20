// Pure queue-state policy shared by the background worker and its tests.
//
// These decisions used to live inline in the worker route, where they could
// only be verified in production. They encode the two defects that trapped
// live cases:
//   1. A non-terminal case whose invocation ended without a voluntary
//      checkpoint had its queued_at/next_stage/lease cleared — leaving it
//      invisible to claim_next_queued_case forever (manual "Clear Stuck
//      Case" was the only escape).
//   2. A thrown invocation was parked as failed on the first error instead of
//      being retried automatically a bounded number of times.

export const TERMINAL_CASE_STATUSES = new Set([
  "complete",
  "released",
  "needs_revision",
  "failed",
  "cancelled",
]);

export type PostRunQueueAction =
  | { kind: "checkpoint_preserved" }
  | { kind: "clear_queue" }
  | { kind: "requeue"; resumeKey: string };

export function decidePostRunQueueAction(input: {
  checkpointed: boolean;
  status: string | null | undefined;
  nextStage?: string | null;
  failedAt?: string | null;
  startFrom?: string | null;
}): PostRunQueueAction {
  if (input.checkpointed) return { kind: "checkpoint_preserved" };
  if (TERMINAL_CASE_STATUSES.has(String(input.status ?? ""))) return { kind: "clear_queue" };
  return {
    kind: "requeue",
    resumeKey: input.nextStage ?? input.failedAt ?? input.startFrom ?? "extraction",
  };
}

export const MAX_WORKER_AUTO_RETRIES = 3;

export function decideWorkerErrorAction(attempts: number): "auto_retry" | "park_failed" {
  return attempts < MAX_WORKER_AUTO_RETRIES ? "auto_retry" : "park_failed";
}

/**
 * A queued case is claimable only when it has a queued_at AND no live lease.
 * Mirrors `claim_next_queued_case`. Used by the stall sweeper's queued pass
 * and by regression tests asserting a re-queued case stays claimable even if
 * a late heartbeat fires.
 */
export function isClaimableQueuedCase(row: {
  status: string | null;
  queued_at: string | null;
  worker_lease_until: string | null;
}, now: number = Date.now()): boolean {
  if (row.status !== "queued") return false;
  if (!row.queued_at) return false;
  if (!row.worker_lease_until) return true;
  return new Date(row.worker_lease_until).getTime() < now;
}
