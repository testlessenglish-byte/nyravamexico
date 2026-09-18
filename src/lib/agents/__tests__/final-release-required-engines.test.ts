// Regression test for the report-quality audit's §19 fix: the final release
// decision must reflect whether every REQUIRED pipeline engine actually
// succeeded, not just whether the 4 gate agents (report/QA/judge/
// hallucination) passed. Before this fix, none of those 4 agents re-checked
// procedural_compliance/contradictions/etc — they only inspect the report's
// own prose and citations — so a report could legitimately say "Final review
// passed" while a required engine had failed. See
// report-release-gate.test.ts for the pre-existing gate-agent coverage this
// complements (that file never exercised pipeline_engine_runs content).
import { describe, it, expect } from "vitest";

type Update = { table: string; values: Record<string, unknown> };
type EngineRow = { engine: string; status: string };

// Extends report-release-gate.test.ts's makeReviewDb pattern: same
// permissive passthrough for every table, but with a controllable
// pipeline_engine_runs response so the required-engine gate can be
// exercised directly.
function makeDb(opts: { report: Record<string, unknown> | null; engineRows: EngineRow[]; updates: Update[] }) {
  const makeChain = (table: string): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const passthrough = ["eq", "neq", "in", "not", "is", "order", "limit", "gte", "lte", "like", "filter"];
    for (const m of passthrough) chain[m] = () => chain;
    chain["select"] = () => chain;
    chain["maybeSingle"] = async () => ({
      data: table === "reports" ? opts.report : null,
      error: null,
    });
    chain["single"] = async () => ({ data: table === "reports" ? opts.report : null, error: null });
    chain["insert"] = () => chain;
    chain["upsert"] = () => chain;
    chain["delete"] = () => chain;
    chain["update"] = (values: Record<string, unknown>) => {
      opts.updates.push({ table, values });
      return chain;
    };
    chain["then"] = (resolve: (v: unknown) => void) => {
      if (table === "pipeline_engine_runs") {
        resolve({
          data: opts.engineRows.map((r) => ({
            id: `run-${r.engine}`,
            engine: r.engine,
            status: r.status,
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          })),
          error: null,
        });
        return;
      }
      resolve({ data: [], error: null, count: 0 });
    };
    return chain;
  };
  return {
    from: (table: string) => makeChain(table),
    rpc: async (fn: string, params?: Record<string, unknown>) => {
      if (fn === "finalize_report_release" && params) {
        opts.updates.push({ table: "cases", values: { status_message: params.p_status_message } });
      }
      return { data: null, error: null };
    },
  };
}

describe("runFinalReleaseReview — required-engine gate", () => {
  it("lists every required engine as missing when pipeline_engine_runs has no rows for them at all", async () => {
    const updates: Update[] = [];
    const { runFinalReleaseReview } = await import("@/lib/agents/orchestrator.server");
    const review = await runFinalReleaseReview({
      db: makeDb({ report: { case_id: "case-1", full_report: null }, engineRows: [], updates }) as never,
      caseId: "case-1",
      userId: "user-1",
      apiKey: "key",
      apiKeys: ["key"],
    });
    expect(review.missingRequiredEngines.length).toBeGreaterThan(0);
    expect(review.released).toBe(false);
  });

  it("the real reported gap: a required engine reporting 'failed' keeps the case out of 'released' and is named in missingRequiredEngines", async () => {
    const updates: Update[] = [];
    const { REPORT_REQUIRED_ENGINES } = await import("@/lib/execution/canonical");
    const { runFinalReleaseReview } = await import("@/lib/agents/orchestrator.server");
    // Every required engine "completed" except procedural_compliance, which
    // failed — exactly the scenario the audit named: a report that reads
    // fine (report/QA/judge/hallucination all inspect only the report's own
    // text) while a required upstream engine genuinely failed.
    const engineRows: EngineRow[] = REPORT_REQUIRED_ENGINES.map((e) => ({
      engine: e,
      status: e === "procedural_compliance" ? "failed" : "completed",
    }));
    const review = await runFinalReleaseReview({
      db: makeDb({ report: { case_id: "case-1", full_report: null }, engineRows, updates }) as never,
      caseId: "case-1",
      userId: "user-1",
      apiKey: "key",
      apiKeys: ["key"],
    });
    expect(review.released).toBe(false);
    expect(review.missingRequiredEngines).toContain("procedural_compliance");
    const statusWrite = updates.find((u) => u.table === "cases" && "status_message" in u.values);
    expect(String(statusWrite?.values["status_message"])).toContain("procedural_compliance");
  });

  it("missingRequiredEngines is empty when every required engine completed", async () => {
    const updates: Update[] = [];
    const { REPORT_REQUIRED_ENGINES } = await import("@/lib/execution/canonical");
    const { runFinalReleaseReview } = await import("@/lib/agents/orchestrator.server");
    const engineRows: EngineRow[] = REPORT_REQUIRED_ENGINES.map((e) => ({ engine: e, status: "completed" }));
    const review = await runFinalReleaseReview({
      db: makeDb({ report: { case_id: "case-1", full_report: null }, engineRows, updates }) as never,
      caseId: "case-1",
      userId: "user-1",
      apiKey: "key",
      apiKeys: ["key"],
    });
    expect(review.missingRequiredEngines).toEqual([]);
  });

  it("invariant: released is never true while missingRequiredEngines is non-empty", async () => {
    const updates: Update[] = [];
    const { runFinalReleaseReview } = await import("@/lib/agents/orchestrator.server");
    const review = await runFinalReleaseReview({
      db: makeDb({ report: { case_id: "case-1", full_report: null }, engineRows: [], updates }) as never,
      caseId: "case-1",
      userId: "user-1",
      apiKey: "key",
      apiKeys: ["key"],
    });
    if (review.missingRequiredEngines.length > 0) {
      expect(review.released).toBe(false);
    }
  });
});
