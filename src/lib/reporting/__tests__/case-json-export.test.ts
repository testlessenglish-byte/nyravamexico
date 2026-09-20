import { describe, it, expect, vi } from "vitest";
import { assertExportCaseIdentity, fetchCurrentCaseExport, prepareCaseJsonExport } from "../case-json-export";
import type { CaseExportData } from "../../export";

function input(): CaseExportData {
  return {
    case: { id: "case-a", name: "Case A", status: "released", execution_id: "run-a" },
    report: { case_id: "case-a", execution_id: "run-a", quality_blocked: false,
      executive_summary: "Unreleased report prose", full_report: { legal_memorandum: "Draft",
        release_gate: { released: false, errors: ["qa_failed"] } } },
    documents: [], analysis: null, agents: [], score: null,
  };
}

describe("case JSON diagnostics", () => {
  it("downloads blocked-case diagnostics without publishing blocked report content", () => {
    const data = input();
    data.case!.status = "needs_revision";
    data.report!.quality_blocked = true;
    data.report!.quality_block_reasons = ["qa_failed"];
    const release = vi.fn(() => { throw new Error("must not publish"); });
    const result = prepareCaseJsonExport(data, release);
    expect(release).not.toHaveBeenCalled();
    expect(result.diagnostic).toBe(true);
    expect(result.payload).toMatchObject({ export_kind: "case_diagnostics", not_for_release: true,
      case: { id: "case-a", status: "needs_revision" },
      report: { quality_blocked: true, quality_block_reasons: ["qa_failed"] } });
    expect(JSON.stringify(result.payload)).not.toContain("Unreleased report prose");
    expect(JSON.stringify(result.payload)).not.toContain("legal_memorandum");
    expect(data.report!.quality_blocked).toBe(true);
  });
  it("exports case status when report creation never succeeded", () => {
    const data = input(); data.report = null; data.case!.status = "needs_revision";
    expect(prepareCaseJsonExport(data, vi.fn()).payload).toMatchObject({report:null,not_for_release:true});
  });
  it("keeps released reports on the existing final validation path", () => {
    const data = input(), validated = {...data, report: {validated:true}};
    const release = vi.fn(() => validated);
    const result = prepareCaseJsonExport(data, release);
    expect(release).toHaveBeenCalledWith(data);
    expect(result.payload).toBe(validated);
    expect(result.diagnostic).toBe(false);
  });
  it.each(["REPORT_BLOCKED: qa_failed", "REPORT_CONTRACT_BLOCKED: probabilitiesPresent"])(
    "retains a release failure as diagnostic data: %s", message => {
      const result = prepareCaseJsonExport(input(), () => {throw new Error(message);});
      expect(result.diagnostic).toBe(true);
      expect(result.payload).toMatchObject({diagnostic_reason:message,not_for_release:true});
    },
  );
  it("does not disguise unrelated failures as successful downloads", () => {
    expect(() => prepareCaseJsonExport(input(), () => {throw new Error("network failed");})).toThrow("network failed");
  });
  it("rejects case or report identity mismatches", () => {
    expect(() => assertExportCaseIdentity(input(), "case-b")).toThrow("selected case");
    const data=input(); data.report!.case_id="case-b";
    expect(() => assertExportCaseIdentity(data,"case-a")).toThrow("selected case");
    expect(() => assertExportCaseIdentity(input(),"case-a")).not.toThrow();
  });
  it("keeps a previous execution diagnostic rather than publishing it as current", () => {
    const data=input();data.report!.execution_id="old-run";
    const release=vi.fn();
    expect(prepareCaseJsonExport(data,release).diagnostic).toBe(true);
    expect(release).not.toHaveBeenCalled();
  });
  it("replaces a stale cached snapshot with the current released report before download", async () => {
    const stale = input();
    stale.case!.status = "needs_revision";
    stale.report!.quality_blocked = true;
    const fresh = input();
    fresh.report!.full_report = { release_gate: { released: true }, release_decision: "PASS" };
    const onFresh = vi.fn();
    const fetched = await fetchCurrentCaseExport({
      caseId: "case-a",
      fetchCase: vi.fn(async () => fresh),
      onFresh,
    });
    expect(fetched).toBe(fresh);
    expect(fetched).not.toBe(stale);
    expect(fetched.case?.status).toBe("released");
    expect(onFresh).toHaveBeenCalledWith(fresh);
  });
  it("rejects a fresh response for another case before download", async () => {
    const wrong = input();
    wrong.case!.id = "case-b";
    await expect(fetchCurrentCaseExport({
      caseId: "case-a",
      fetchCase: async () => wrong,
    })).rejects.toThrow("selected case");
  });
});
