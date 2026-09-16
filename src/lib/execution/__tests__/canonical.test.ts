import { describe, it, expect } from "vitest";
import {
  CANONICAL_STAGES,
  STAGE_BY_KEY,
  STAGE_BY_ENGINE,
  REPORT_BLOCKING_ENGINES,
  REPORT_ENRICHING_ENGINES,
  OPTIONAL_ENGINES,
  computeProgress,
  computeStageViews,
  canGenerateReport,
  latestRowsByEngine,
  deriveStageState,
  ENGINE_TIMESTAMP_FALLBACK,
  isStageTimestampSet,
  type ExecutionRow,
} from "../canonical";

const now = new Date().toISOString();

function row(engine: string, status: ExecutionRow["status"], overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    id: `${engine}-${status}-${Math.random()}`,
    engine,
    status,
    started_at: now,
    ended_at: status === "completed" || status === "failed" ? now : null,
    created_at: now,
    ...overrides,
  };
}

describe("canonical execution architecture", () => {
  it("exposes exactly one stage list with unique keys and engines", () => {
    const keys = new Set(CANONICAL_STAGES.map((s) => s.key));
    const engines = new Set(CANONICAL_STAGES.map((s) => s.engine));
    expect(keys.size).toBe(CANONICAL_STAGES.length);
    expect(engines.size).toBe(CANONICAL_STAGES.length);
  });

  it("bidirectional indexes stay in sync", () => {
    for (const s of CANONICAL_STAGES) {
      expect(STAGE_BY_KEY.get(s.key)).toBe(s);
      expect(STAGE_BY_ENGINE.get(s.engine)).toBe(s);
    }
  });

  it("dependency graph is acyclic and references known stages", () => {
    const keys = new Set(CANONICAL_STAGES.map((s) => s.key));
    for (const s of CANONICAL_STAGES) {
      for (const dep of s.dependsOn) {
        expect(keys.has(dep)).toBe(true);
        expect(dep).not.toBe(s.key);
      }
    }
    // Topological sort must succeed with the declared order.
    const seen = new Set<string>();
    for (const s of CANONICAL_STAGES) {
      for (const dep of s.dependsOn) expect(seen.has(dep)).toBe(true);
      seen.add(s.key);
    }
  });

  it("uses the canonical requirement tier for report blockers", () => {
    const expected = CANONICAL_STAGES.filter(
      (s) => s.requirement === "blocking" && s.engine !== "report_generator",
    ).map((s) => s.engine);
    expect([...REPORT_BLOCKING_ENGINES].sort()).toEqual([...expected].sort());
    expect(REPORT_BLOCKING_ENGINES).not.toContain("report_generator");
    expect(REPORT_BLOCKING_ENGINES).not.toContain("multi_agent");
    expect(REPORT_BLOCKING_ENGINES).not.toContain("perspectives");
    expect(REPORT_ENRICHING_ENGINES.length).toBeGreaterThan(0);
  });

  it("report gate blocks when any blocking engine has not completed", () => {
    const partial = REPORT_BLOCKING_ENGINES.slice(0, -1).map((e) => row(e, "completed"));
    const gate = canGenerateReport(partial);
    expect(gate.ok).toBe(false);
    expect(gate.missingBlocking.length).toBeGreaterThan(0);
  });

  it("report gate passes when every blocking engine is completed or skipped", () => {
    const rows = REPORT_BLOCKING_ENGINES.map((e, i) => row(e, i === 0 ? "skipped" : "completed"));
    expect(canGenerateReport(rows).ok).toBe(true);
  });

  // Regression for the "perspectives, strategy" report-generation dead end:
  // an optional-tier engine that never received ANY pipeline_engine_runs row
  // (not even a failed/blocked one — e.g. the main pipeline loop finished or
  // got stuck without ever queuing it) permanently blocked report generation,
  // because canGenerateReport()'s optional-tier exemption only recognized
  // status "failed"/"blocked", never "no row at all". Confirmed on a real
  // case (robo calificado con violencia, Jalisco): perspectives and strategy
  // both had zero terminal rows, and every "Generate Legal Report" attempt
  // failed identically with no path to recovery — ensureRequiredEngines()
  // structurally cannot run these two (they throw CheckpointRequired
  // mid-run, which only the main pipeline loop's worker-tick model can
  // catch and resume), so nothing was ever going to write a row for them.
  // The fix (pipeline.server.ts's ensureRequiredEngines): when it hits an
  // optional-tier engine it cannot backfill, it now writes an explicit
  // "skipped" row via recordSkipped() instead of leaving the engine with no
  // row at all. These tests prove *why* that's the right terminal state to
  // pick — "skipped" is the one status canGenerateReport() already exempts
  // unconditionally, for every engine, regardless of requirement tier.
  it("report gate does not block on an optional engine with no row", () => {
    expect(OPTIONAL_ENGINES.has("perspectives")).toBe(true);
    expect(OPTIONAL_ENGINES.has("strategy")).toBe(true);
    const rows = REPORT_BLOCKING_ENGINES.filter((e) => e !== "perspectives" && e !== "strategy").map((e) =>
      row(e, "completed"),
    );
    const gate = canGenerateReport(rows);
    expect(gate.ok).toBe(true);
    expect(gate.missingBlocking).not.toEqual(expect.arrayContaining(["perspectives", "strategy"]));
  });

  it("report gate passes once the missing optional engines are recorded 'skipped' (what ensureRequiredEngines now does)", () => {
    const rows = REPORT_BLOCKING_ENGINES.map((e) =>
      e === "perspectives" || e === "strategy" ? row(e, "skipped") : row(e, "completed"),
    );
    expect(canGenerateReport(rows).ok).toBe(true);
  });

  it("records optional failures as non-blocking coverage degradation", () => {
    const rows = [
      ...REPORT_BLOCKING_ENGINES.map((e) => row(e, "completed")),
      row("perspectives", "failed"),
      row("strategy", "blocked"),
    ];
    const gate = canGenerateReport(rows);
    expect(gate.ok).toBe(true);
    expect(gate.missingBlocking).toEqual([]);
  });

  it("a BLOCKING-tier engine with no row still blocks — this fix is scoped to optional engines only", () => {
    expect(OPTIONAL_ENGINES.has("extraction")).toBe(false);
    const rows = REPORT_BLOCKING_ENGINES.filter((e) => e !== "extraction").map((e) => row(e, "completed"));
    const gate = canGenerateReport(rows);
    expect(gate.ok).toBe(false);
    expect(gate.missingBlocking).toContain("extraction");
  });

  it("deriveStageState respects upstream state before promoting to waiting", () => {
    const latest = latestRowsByEngine([row("extraction", "running")]);
    const upstream = new Map<string, "running" | "complete">([["extraction", "running"]]);
    expect(deriveStageState("analyzers", latest, upstream)).toBe("locked");
    upstream.set("extraction", "complete");
    const latest2 = latestRowsByEngine([row("extraction", "completed")]);
    expect(deriveStageState("analyzers", latest2, upstream)).toBe("waiting");
  });

  it("computeStageViews returns every stage in canonical order", () => {
    const views = computeStageViews([]);
    expect(views.length).toBe(CANONICAL_STAGES.length);
    for (let i = 0; i < CANONICAL_STAGES.length; i++) {
      expect(views[i].key).toBe(CANONICAL_STAGES[i].key);
    }
  });

  it("computeProgress percent tracks completed + skipped across every stage", () => {
    const rows = [row("extraction", "completed"), row("analyzers", "completed"), row("agents", "skipped")];
    const p = computeProgress(rows);
    expect(p.completedStages).toBe(3);
    expect(p.totalStages).toBe(CANONICAL_STAGES.length);
    expect(p.percent).toBe(Math.round((3 / CANONICAL_STAGES.length) * 100));
    expect(p.hasFailures).toBe(false);
    expect(p.isRunning).toBe(false);
  });

  it("latestRowsByEngine keeps the most recent row per engine", () => {
    const older = row("extraction", "failed", { created_at: "2026-01-01T00:00:00Z" });
    const newer = row("extraction", "completed", { created_at: "2026-06-01T00:00:00Z" });
    const map = latestRowsByEngine([older, newer]);
    expect(map.get("extraction")?.status).toBe("completed");
  });
});

// isStageTimestampSet is a correct, tested pure function — these tests just
// prove its own logic. It is deliberately NOT wired into
// pipeline-runner.server.ts's resume-clamp (alreadyDone/alreadyAttempted)
// anymore: it briefly was, to close a suspected pipeline_engine_runs
// read-consistency gap, but that made the resume-clamp trust a
// cases.<engine>_at column that can go stale independently of its ledger
// row (see isStageTimestampSet's own doc comment above for the confirmed
// live incident — ADR-4321-2017-180507 — where this silently skipped
// analyzers/agents/etc. instead of re-running them). pipeline_engine_runs
// stays the sole source of truth for "has this stage run".
describe("isStageTimestampSet: pure-function behavior (not wired into the live resume-clamp)", () => {
  it("is true when the engine's dedicated timestamp column is set on the case row", () => {
    expect(isStageTimestampSet({ extracted_at: "2026-08-15T23:27:25.000Z" }, "extraction")).toBe(true);
    expect(isStageTimestampSet({ analysis_at: "2026-08-15T23:27:26.000Z" }, "analyzers")).toBe(true);
    expect(isStageTimestampSet({ scored_at: "2026-08-15T23:28:43.000Z" }, "scoring")).toBe(true);
  });

  it("is false when the column is null, missing, or the engine has no dedicated column at all", () => {
    expect(isStageTimestampSet({ extracted_at: null }, "extraction")).toBe(false);
    expect(isStageTimestampSet({}, "extraction")).toBe(false);
    // "timeline" has no timestampColumn in CANONICAL_STAGES — the ledger
    // read remains the sole signal for it, this must never throw or
    // default true just because an unrelated column happens to be set.
    expect(isStageTimestampSet({ extracted_at: "2026-08-15T23:27:25.000Z" }, "timeline")).toBe(false);
  });

  it("never cross-wires one engine's column with another's — only the exact mapped column counts", () => {
    // A case with extracted_at set but analysis_at null must confirm
    // extraction is done without ever implying analyzers is too.
    const caseRow = { extracted_at: "2026-08-15T23:27:25.000Z", analysis_at: null };
    expect(isStageTimestampSet(caseRow, "extraction")).toBe(true);
    expect(isStageTimestampSet(caseRow, "analyzers")).toBe(false);
  });

  it("ENGINE_TIMESTAMP_FALLBACK covers every blocking-tier engine that has a real completion column", () => {
    const mustHaveColumn = ["extraction", "analyzers", "agents", "scoring", "report_generator"];
    for (const engine of mustHaveColumn) {
      expect(
        ENGINE_TIMESTAMP_FALLBACK[engine],
        `expected ${engine} to have a dedicated timestamp column`,
      ).toBeTruthy();
    }
  });
});
