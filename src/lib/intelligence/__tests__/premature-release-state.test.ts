import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

describe("terminal release state requires a saved report", () => {
  it("manual/admin multi-agent reruns always defer release", () => {
    const text = source("src/lib/agents/multi-agent.functions.ts");
    const call = text.slice(
      text.indexOf("return runMultiAgentPipeline({"),
      text.indexOf("});", text.indexOf("return runMultiAgentPipeline({")) + 3,
    );
    expect(call).toContain("deferRelease: true");
  });

  it("the orchestrator refuses a terminal status write when no report exists", () => {
    const text = source("src/lib/agents/orchestrator.server.ts");
    expect(text).toContain("savedReportForRelease");
    expect(text).toContain("if (args.deferRelease)");
    expect(text).toContain("if (!savedReportForRelease)");
    expect(text).toContain('"multi_agent.no_saved_report"');
  });

  it.each(["src/lib/pipeline-runner.server.ts", "src/lib/pipeline.server.ts"])(
    "%s does not preserve released/needs_revision without a report row",
    (file) => {
      const text = source(file);
      expect(text).toContain("!!postReport &&");
      expect(text).toContain('postRun?.status === "released"');
      expect(text).toContain('postRun?.status === "needs_revision"');
    },
  );

  it("diagnostic multi-agent contradiction checks cannot invalidate a saved report", () => {
    const text = source("src/lib/agents/orchestrator.server.ts");
    expect(text).toContain("deriveContradictions(ctx.db, ctx.caseId, { invalidateReport: false })");
  });

  it("report completion requires a same-execution persisted artifact", () => {
    const text = source("src/lib/pipeline-runner.server.ts");
    expect(text).toContain("REPORT_PERSISTENCE_INVARIANT_FAILED");
    expect(text).toContain("missing_same_execution_report");
  });
});

