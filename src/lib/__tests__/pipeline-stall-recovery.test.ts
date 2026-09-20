import { describe, it, expect } from "vitest";
import {
  decidePostRunQueueAction,
  decideWorkerErrorAction,
  isClaimableQueuedCase,
  MAX_WORKER_AUTO_RETRIES,
} from "@/lib/pipeline-queue-policy";
import { requeueForContinuation, sweepStalledCases } from "@/lib/pipeline-stall.server";

type Row = Record<string, unknown> & { id: string };

/** Minimal in-memory stand-in for the supabase query builder used here. */
function fakeDb(rows: Row[]) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const db = {
    from() {
      const state: { updates?: Record<string, unknown>; filters: Array<[string, unknown]>; lt?: [string, string] } = {
        filters: [],
      };
      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        update(v: Record<string, unknown>) {
          state.updates = v;
          return builder;
        },
        eq(col: string, val: unknown) {
          state.filters.push([col, val]);
          if (state.updates) {
            for (const row of store.values()) {
              if (state.filters.every(([c, v]) => row[c] === v)) Object.assign(row, state.updates);
            }
          }
          return builder;
        },
        in() {
          return builder;
        },
        or() {
          return builder;
        },
        lt(col: string, val: string) {
          state.lt = [col, val];
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
        then(res: (v: { data: Row[]; error: null }) => unknown) {
          let out = [...store.values()];
          for (const [c, v] of state.filters) out = out.filter((r) => r[c] === v);
          if (state.lt) out = out.filter((r) => String(r[state.lt![0]]) < state.lt![1]);
          return Promise.resolve(res({ data: out, error: null }));
        },
      };
      return builder;
    },
    rows: store,
  };
  return db;
}

const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const future = new Date(Date.now() + 2 * 60 * 1000).toISOString();

describe("worker post-run queue policy", () => {
  it("clears the queue only for terminal cases", () => {
    expect(decidePostRunQueueAction({ checkpointed: false, status: "complete" }).kind).toBe(
      "clear_queue",
    );
    expect(decidePostRunQueueAction({ checkpointed: false, status: "needs_revision" }).kind).toBe(
      "clear_queue",
    );
  });

  it("re-queues a non-terminal case instead of orphaning it (the live stuck-case bug)", () => {
    const action = decidePostRunQueueAction({
      checkpointed: false,
      status: "reporting",
      nextStage: null,
      failedAt: "report",
    });
    expect(action).toEqual({ kind: "requeue", resumeKey: "report" });
  });

  it("prefers the persisted next_stage as the resume point", () => {
    const action = decidePostRunQueueAction({
      checkpointed: false,
      status: "analyzing",
      nextStage: "legal_analyzers",
      failedAt: "report",
      startFrom: "extraction",
    });
    expect(action).toEqual({ kind: "requeue", resumeKey: "legal_analyzers" });
  });

  it("preserves a voluntary checkpoint untouched", () => {
    expect(decidePostRunQueueAction({ checkpointed: true, status: "queued" }).kind).toBe(
      "checkpoint_preserved",
    );
  });

  it("auto-retries a thrown invocation a bounded number of times", () => {
    for (let i = 0; i < MAX_WORKER_AUTO_RETRIES; i++) {
      expect(decideWorkerErrorAction(i)).toBe("auto_retry");
    }
    expect(decideWorkerErrorAction(MAX_WORKER_AUTO_RETRIES)).toBe("park_failed");
  });
});

describe("queued-case claimability", () => {
  it("is claimable right after a checkpoint re-queue", () => {
    expect(
      isClaimableQueuedCase({ status: "queued", queued_at: old, worker_lease_until: null }),
    ).toBe(true);
  });

  it("is NOT claimable when a late heartbeat re-stamped a lease", () => {
    expect(
      isClaimableQueuedCase({ status: "queued", queued_at: old, worker_lease_until: future }),
    ).toBe(false);
  });

  it("is NOT claimable without queued_at", () => {
    expect(
      isClaimableQueuedCase({ status: "queued", queued_at: null, worker_lease_until: null }),
    ).toBe(false);
  });
});

describe("full stall sequence: checkpoint -> requeue -> late heartbeat -> sweeper recovery", () => {
  it("releases a stale lease stamped on an already re-queued case", async () => {
    const db = fakeDb([
      { id: "case-1", status: "reporting", queued_at: null, worker_lease_until: future, updated_at: old },
    ]);

    // 1. Stage checkpoints and hands the case back to the queue.
    await requeueForContinuation(db as never, "case-1", "report");
    let row = db.rows.get("case-1")!;
    expect(row.status).toBe("queued");
    expect(row.worker_lease_until).toBeNull();
    expect(row.next_stage).toBe("report");
    expect(isClaimableQueuedCase(row as never)).toBe(true);

    // 2. A late heartbeat re-stamps a lease (the race the DB guard now blocks,
    //    simulated here as the worst case).
    row.worker_lease_until = future;
    row.updated_at = old;
    expect(isClaimableQueuedCase(row as never)).toBe(false);

    // 3. The stall sweeper must now recover it — queued cases used to be
    //    ignored entirely, which is what trapped the case indefinitely.
    await sweepStalledCases(db as never, { caseId: "case-1" });
    row = db.rows.get("case-1")!;
    expect(row.worker_lease_until).toBeNull();
    expect(isClaimableQueuedCase(row as never)).toBe(true);
  });

  it("repairs a queued case that lost its queued_at", async () => {
    const db = fakeDb([
      { id: "case-2", status: "queued", queued_at: null, worker_lease_until: null, updated_at: old },
    ]);
    await sweepStalledCases(db as never, { caseId: "case-2" });
    const row = db.rows.get("case-2")!;
    expect(row.queued_at).toBeTruthy();
    expect(isClaimableQueuedCase(row as never)).toBe(true);
  });
});
