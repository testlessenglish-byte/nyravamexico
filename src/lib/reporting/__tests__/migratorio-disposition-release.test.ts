import { describe, expect, it } from "vitest";
import { composeFinalReportPayload, releaseFinalReportPayload, releaseRenderedReportOutput, validateFinalReportContract } from "../final-report-contract";
import { resolveFinalReleaseDecision } from "../final-release-decision";
import { normalizeCanonicalSources } from "../../intelligence/canonical-source-identity";
import { applyMigratorioDisposition, resolveMigratorioDisposition } from "../../intelligence/migratorio-disposition";
import type { MandatoryDecisionCoreItem } from "../../intelligence/mandatory-decision-core";
import type { CaseExportData } from "../../export";

function fixture(caseType = "migratorio"): CaseExportData {
  const doc = { id: "judgment", filename: "sentencia.pdf", extracted_text: "Instancia: Primera Sala\nANTECEDENTES\nSe confirmó el sobreseimiento.\nRESUELVE:\nPRIMERO. Se revoca la sentencia recurrida.\nSEGUNDO. Se sobresee únicamente respecto de la autoridad A.\nTERCERO. La Justicia de la Unión ampara y protege a la parte quejosa.\nNOTIFÍQUESE" };
  const sources = normalizeCanonicalSources([doc]).canonical_sources;
  const previous: MandatoryDecisionCoreItem[] = [{ id: "old", kind: "DISPOSITION", text: "Se confirma la sentencia de sobreseimiento.",
    speaker_role: null, adoption_status: "adopted", proposition_type: "procedural_fact", source_refs: [{ document_id: doc.id, quote: "Se confirmó el sobreseimiento." }] },
    { id: "old-holding", kind: "COURT_HOLDING", text: "El juzgado sobreseyó el juicio.", speaker_role: "tribunal_local", adoption_status: "adopted", proposition_type: "holding", source_refs: [] }];
  const resolved = resolveMigratorioDisposition([doc], previous);
  return { case: { case_type: caseType, case_analysis_mode: "concluded_audit" }, documents: [doc], analysis: null, agents: [], score: null, findings: [],
    report: { report_mode: "LIMITED", full_report: { source_audit: { canonical_sources: sources },
      mandatory_decision_core: { items: applyMigratorioDisposition(previous, resolved) }, migratorio_disposition: resolved } } };
}

describe("Migratorio disposition release contract", () => {
  it("renders every final order ahead of historical lower-court decisions", () => {
    const payload = releaseFinalReportPayload(fixture());
    expect(payload.report_presentation.decision_sections).toHaveLength(3);
    expect(payload.report_presentation.decision_sections[2].text).toContain("ampara y protege");
    expect(payload.report_presentation.procedural_history?.map(i => i.id)).toEqual(["old", "old-holding"]);
    expect(validateFinalReportContract(payload).ok).toBe(true);
  });

  it.each(["change", "drop", "add", "reorder"])("blocks %s of a canonical dashboard order", mutation => {
    const payload = composeFinalReportPayload(fixture());
    const sections = payload.report_presentation.decision_sections;
    if (mutation === "change") sections[0].text = "Se confirma la sentencia de sobreseimiento.";
    if (mutation === "drop") sections.pop();
    if (mutation === "add") sections.push({ ...sections[0], id: "extra", text: "Se niega la protección." });
    if (mutation === "reorder") sections.reverse();
    const contract = validateFinalReportContract(payload);
    expect(contract.blocking_errors).toContain("migratorioFinalDispositionConflict");
    expect(resolveFinalReleaseDecision({ report: payload.report!, contract }).released).toBe(false);
    expect(() => releaseFinalReportPayload(payload)).toThrow("REPORT_CONTRACT_BLOCKED");
  });

  it("rejects an equally corrupted core and dashboard against the independent source anchor", () => {
    const input = fixture();
    (input.report!.full_report as any).mandatory_decision_core.items[0].text = "Se confirma la sentencia de sobreseimiento.";
    expect(() => releaseFinalReportPayload(input)).toThrow("migratorioFinalDispositionConflict");
  });

  it("blocks legacy/missing or ambiguous anchors instead of trusting a cached reconstruction", () => {
    for (const anchor of [undefined, { version: 1, status: "unresolved", items: [], history: [] }]) {
      const input = fixture();
      (input.report!.full_report as any).migratorio_disposition = anchor;
      expect(() => releaseFinalReportPayload(input)).toThrow("migratorioFinalDispositionConflict");
    }
  });

  it("blocks historical decisions reintroduced into active sections or omitted from history", () => {
    const payload = composeFinalReportPayload(fixture());
    payload.report_presentation.procedural_history = [];
    expect(validateFinalReportContract(payload).blocking_errors).toContain("migratorioProceduralHistoryConflict");
  });

  it("retains lower-court findings as procedural history, not dashboard risks", () => {
    const input = fixture();
    input.findings = [{ id: "lower-finding", title: "Sobreseimiento en primera instancia", description: "El juzgado sobreseyó.",
      speaker_role: "tribunal_local", proposition_type: "holding", adoption_status: "adopted", severity: "critical", evidence_refs: [] }];
    const payload = releaseFinalReportPayload(input);
    expect(payload.findings).toEqual([]);
    expect(payload.report_presentation.procedural_history?.some(i => i.id === "historical-finding:lower-finding")).toBe(true);
    expect(composeFinalReportPayload(payload).report_presentation.procedural_history).toEqual(payload.report_presentation.procedural_history);
    expect(payload.report_presentation.snapshot.priorityReview.join(" ")).not.toContain("Sobreseimiento en primera instancia");
  });

  it("passes the actual PDF preflight with final orders and historical decisions", async () => {
    const { prepareFinalReportForRelease } = await import("../../export");
    const payload = await prepareFinalReportForRelease(fixture());
    expect(payload.report_presentation.render_output?.text).toContain("ampara y protege");
    expect(payload.report_presentation.render_output?.text).toContain("ANTECEDENTES PROCESALES");
  });

  it("blocks a conflicting derived executive dashboard priority", () => {
    const payload = composeFinalReportPayload(fixture());
    payload.report_presentation.snapshot.priorityReview[0] = "RESULTADO DEL RECURSO: Se confirma el sobreseimiento.";
    expect(validateFinalReportContract(payload).blocking_errors).toContain("migratorioDashboardDispositionConflict");
  });

  it("checks concrete rendered output, not only its unmodified input payload", () => {
    const payload = composeFinalReportPayload(fixture());
    expect(() => releaseRenderedReportOutput(payload, "pdf", "RESULTADO DEL RECURSO: Se confirma el sobreseimiento.")).toThrow("migratorioRenderedDispositionConflict");
    const output = payload.report_presentation.decision_sections.map(s => `${s.title}\n${s.text}`).join("\n");
    expect(() => releaseRenderedReportOutput(payload, "pdf", output)).not.toThrow();
    expect(() => releaseRenderedReportOutput(payload, "pdf", "RESULTADO DEL RECURSO\nSe confirma el sobreseimiento.\n" + output)).toThrow("migratorioRenderedDispositionConflict");
  });

  it.each(["penal", "civil", "familiar", "laboral", "administrativo", "fiscal", "mercantil", "agrario"])("preserves existing behavior for %s", caseType => {
    const input = fixture(caseType);
    delete (input.report!.full_report as any).migratorio_disposition;
    const payload = releaseFinalReportPayload(input);
    expect(payload.report_presentation.procedural_history).toBeUndefined();
    expect(validateFinalReportContract(payload).blocking_errors.some(e => e.startsWith("migratorio"))).toBe(false);
  });

  it("does not require a concluded disposition for an active Migratorio matter", () => {
    const input = fixture();
    input.case!.case_analysis_mode = "active_litigation";
    delete (input.report!.full_report as any).migratorio_disposition;
    const payload = composeFinalReportPayload(input);
    expect(validateFinalReportContract(payload).blocking_errors.some(e => e.startsWith("migratorio"))).toBe(false);
  });
});
