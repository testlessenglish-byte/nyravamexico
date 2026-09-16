type Row = Record<string, any>;
import { auditPenalProceduralSemantics } from "../intelligence/penal-qa-status";
import type { Finding } from "../intelligence/types";
export interface ReleaseLayer { layer: string; status: string; blocking?: boolean; reason?: string; issues?: number }
export interface FinalReleaseInput {
  report: Row;
  contract: { ok: boolean; blocking_errors: string[] };
  gates?: Record<string, boolean>;
  errors?: string[];
  warnings?: string[];
}
/** Only these documented heuristic audits are informational. Unknown FAILs remain blocking. */
export function normalizeQaLayers(layers: ReleaseLayer[] = []): ReleaseLayer[] {
  return layers.map(layer => {
    const informational = layer.blocking === false || layer.blocking == null && (
      (layer.layer === "release_readiness" && layer.reason === "release_gate_mismatch") ||
      (layer.layer === "rendering_consistency" && layer.reason === "critical_rendering_inconsistencies"));
    return { ...layer, blocking: !informational,
      status: informational && layer.status === "FAIL" ? "WARN_NON_BLOCKING" : layer.status };
  });
}
/** Refresh semantics against the actual final records, not a stale pre-projection count. */
export function refreshProceduralQa(
  report: Row,
  findings: readonly Row[],
  context: PartyScoreContext = {},
): void {
  const full = report.full_report ?? {};
  if (!Array.isArray(full.qa_statuses)) return;
  const issues = auditPenalProceduralSemantics(findings as readonly Finding[], context);
  const aliases = findings.filter(f => f.proposition_type === "holding" &&
    f.audit_classification === "VERIFIED_COURT_HOLDING").length;
  full.qa_statuses = full.qa_statuses.map((layer: ReleaseLayer) => layer.layer !== "procedural_semantics" ||
    layer.status === "NOT_APPLICABLE" ? layer : {
      ...layer, blocking: true, issues, schema_aliases: aliases,
      status: issues ? "FAIL" : aliases ? "WARN_NON_BLOCKING" : "PASS",
      reason: issues ? "invalid_penal_semantic_records" : aliases
        ? "shared_holding_schema_alias_validated" : "canonical_semantics_valid",
    });
}
/** The only final release calculation. A persisted quality block is never silently cleared. */
export function resolveFinalReleaseDecision(input: FinalReleaseInput) {
  const full = input.report.full_report ?? {};
  const qa_statuses = normalizeQaLayers(full.qa_statuses);
  const errors = [...(input.errors ?? [])];
  const warnings = [...(input.warnings ?? [])];
  if (input.report.quality_blocked === true) errors.push(...(input.report.quality_block_reasons?.length
    ? input.report.quality_block_reasons : ["quality_blocked"]));
  // Consumers cannot override an authoritative BLOCKED snapshot by recomposing
  // content. A fresh final review supplies its current gate outcomes explicitly.
  if (!input.gates && (full.release_decision === "BLOCKED" ||
      full.release_gate?.decision === "BLOCKED" || full.final_review?.released === false))
    errors.push("persisted_final_release_blocked");
  if (!input.contract.ok) errors.push(...input.contract.blocking_errors.map(e => "final_report_contract:" + e));
  for (const [gate, passed] of Object.entries(input.gates ?? {})) if (!passed) errors.push("gate:" + gate);
  for (const layer of qa_statuses) {
    if (layer.blocking && ["FAIL", "BLOCKED"].includes(layer.status)) errors.push(layer.layer + ":" + layer.reason);
    if (layer.status.startsWith("WARN")) warnings.push(layer.layer + ":" + layer.reason);
  }
  const released = errors.length === 0;
  const decision = released ? warnings.length ? "PASS_WITH_WARNINGS" : "PASS" : "BLOCKED";
  return { decision, released, quality_blocked: !released, status: released ? "released" : "needs_revision",
    qa_statuses, errors: [...new Set(errors)], warnings: [...new Set(warnings)] } as const;
}
