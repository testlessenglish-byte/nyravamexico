import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pipeline = readFileSync(join(root, "src/lib/pipeline.server.ts"), "utf8");
const runner = readFileSync(join(root, "src/lib/pipeline-runner.server.ts"), "utf8");

function chunkCacheBlock(): string {
  const start = pipeline.indexOf("const persistChunkCache");
  const end = pipeline.indexOf("const clearChunkCache");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return pipeline.slice(start, end);
}

describe("report persistence invariants", () => {
  it("the chunk cache can never author a report row (update-only)", () => {
    const block = chunkCacheBlock();
    expect(block).not.toContain(".upsert(");
    expect(block).toContain('.from("reports")');
    expect(block).toContain(".update(");
    expect(block).toContain('.eq("case_id", caseId)');
  });

  it("the chunk cache never writes a null execution_id", () => {
    const block = chunkCacheBlock();
    expect(block).not.toContain("execution_id: executionId ?? null");
    expect(block).toContain("if (executionId) patch.execution_id = executionId;");
  });

  it("the chunk cache never writes full_report", () => {
    expect(chunkCacheBlock()).not.toContain("full_report");
  });

  it("report_generator completion requires a same-execution, non-empty report", () => {
    const block = runner.slice(runner.indexOf('if (s.key === "report")'));
    expect(block).toContain("full_report");
    expect(block).toContain("REPORT_PERSISTENCE_INVARIANT_FAILED");
    expect(block).toContain("persistedReport.execution_id !== executionId");
  });

  it("the report save verifies read-back before completing", () => {
    expect(pipeline).toContain("REPORT_PERSISTENCE_INVARIANT_FAILED: full_report is empty after upsert");
    expect(pipeline).toContain("REPORT_PERSISTENCE_INVARIANT_FAILED: execution_id mismatch");
  });
});
