import type { CaseExportData } from "../export";

type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const pick = (value: unknown, keys: string[]): Row => {
  const row = object(value);
  return Object.fromEntries(keys.filter(key => key in row).map(key => [key, row[key]]));
};

/** Downloads must not accept a response for a different case. */
export function assertExportCaseIdentity(data: CaseExportData, expectedCaseId: string) {
  if (!expectedCaseId || data.case?.id !== expectedCaseId ||
      (data.report?.case_id && data.report.case_id !== expectedCaseId)) {
    throw new Error("Export cancelled: the returned case does not match the selected case. Refresh and retry.");
  }
}

/** Fetch and identity-check the current server snapshot before an export.
 * Report pages may remain open while the pipeline replaces a blocked draft
 * with a released report, so their render cache is not an export authority. */
export async function fetchCurrentCaseExport<T>(options: {
  caseId: string;
  fetchCase: (caseId: string) => Promise<T>;
  onFresh?: (value: T) => void;
}): Promise<CaseExportData> {
  const fresh = await options.fetchCase(options.caseId);
  const exportData = fresh as CaseExportData;
  assertExportCaseIdentity(exportData, options.caseId);
  options.onFresh?.(fresh);
  return exportData;
}

function diagnosticExport(data: CaseExportData, reason: string) {
  const report = object(data.report);
  return {
    export_kind: "case_diagnostics",
    not_for_release: true,
    generated_at: new Date().toISOString(),
    diagnostic_reason: reason,
    case: pick(data.case, [
      "id", "name", "status", "status_message", "error", "progress",
      "execution_id", "created_at", "updated_at", "completed_at", "report_at",
      "next_stage", "stall_reason", "worker_lease_until",
    ]),
    report: data.report ? {
      ...pick(report, [
        "id", "case_id", "execution_id", "report_mode", "quality_blocked",
        "quality_block_reasons", "created_at", "updated_at", "stale", "stale_reason",
      ]),
      full_report: pick(report.full_report, [
        "release_gate", "release_decision", "final_governance_validation",
        "final_report_contract_validation", "qa_v2",
      ]),
    } : null,
    // Only diagnostic records already returned by the authenticated case API.
    legal_qa_report: data.case?.legal_qa_report ?? null,
    hallucination_report: data.case?.hallucination_report ?? null,
    pipeline_runs: data.pipeline_runs ?? [],
    agent_logs: (data.agent_logs ?? []).map(log => pick(log, [
      "id", "case_id", "run_id", "agent_key", "agent_name", "status",
      "errors", "started_at", "finished_at",
    ])),
    documents: data.documents.map(doc => pick(doc, ["id", "filename", "status", "error"])),
  };
}

/** Diagnostic JSON is not a published report. PDF keeps its release gate. */
export function prepareCaseJsonExport(
  data: CaseExportData,
  release: (data: CaseExportData) => CaseExportData,
) {
  const olderReport = data.case?.execution_id && data.report?.execution_id &&
    data.case.execution_id !== data.report.execution_id;
  if (data.case?.status !== "released" || !data.report || olderReport ||
      data.report.quality_blocked === true || data.report.stale === true) {
    return { payload: diagnosticExport(data, "Case report is not available for release."), diagnostic: true };
  }
  try {
    return { payload: release(data), diagnostic: false };
  } catch (error) {
    if (!(error instanceof Error) || !/^REPORT_(?:CONTRACT_)?BLOCKED:/.test(error.message)) throw error;
    return { payload: diagnosticExport(data, error.message), diagnostic: true };
  }
}
