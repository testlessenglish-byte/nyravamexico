// Regression test for a real production bug: the Judge agent's
// citation-density gate counted absence-of-evidence findings (procedural-
// compliance "not found in corpus" markers, discovery gaps, trial risk/
// strength inferences — everything findings.server.ts's addGatedFindings()
// inserts with { exemptCitation: true }) against the denominator, even
// though those findings structurally cannot carry a verbatim quote by
// design. CONFIRMED LIVE (ADR5829/2025, strict mode): a run with exactly
// two findings — one fully-cited substantive holding, one procedural-
// compliance absence marker — scored a 50% citation ratio, below strict
// mode's 70% approval floor, and Judge returned needs_revision on a report
// that was otherwise completely grounded.
import { describe, it, expect } from "vitest";
import { computeJudgeVerdict, type JudgeFinding } from "@/lib/agents/orchestrator.server";

function finding(overrides: Partial<JudgeFinding> = {}): JudgeFinding {
  return {
    source_document_id: null,
    source_doc_ids: null,
    source_quote: null,
    source_module: "analyzer:key",
    ...overrides,
  };
}

const CITED = () =>
  finding({ source_document_id: "doc-1", source_quote: "a real verbatim quote" });

describe("computeJudgeVerdict: citation-exempt source modules", () => {
  it("approves a fully-cited finding alongside an exempt, uncited absence marker (the exact ADR5829/2025 shape)", () => {
    const result = computeJudgeVerdict(
      [CITED(), finding({ source_module: "engine:procedural_compliance" })],
      "strict",
    );
    // Without the exemption this would be 1/2 = 50%, below strict's 70% floor.
    expect(result.totals.findings).toBe(1);
    expect(result.totals.cited).toBe(1);
    expect(result.totals.cited_ratio).toBe(1);
    expect(result.verdict).toBe("approve");
  });

  it("exempts every known addGatedFindings(exemptCitation:true) source module", () => {
    const exemptModules = [
      "engine:procedural_compliance",
      "engine:discovery:missing",
      "engine:discovery:violation",
      "engine:trial:risk",
      "engine:trial:strength",
      "analyzer:missing",
      "report_writer:strategy_recommendation",
      "report_writer:next_action",
      "report_writer:missing_evidence",
    ];
    for (const source_module of exemptModules) {
      const result = computeJudgeVerdict([CITED(), finding({ source_module })], "strict");
      expect(result.totals.findings, `${source_module} should be excluded`).toBe(1);
      expect(result.verdict, `${source_module} should not drag down the verdict`).toBe("approve");
    }
  });

  it("does NOT exempt an ordinary uncited finding from an unrelated source module", () => {
    const result = computeJudgeVerdict(
      [CITED(), finding({ source_module: "analyzer:key" })],
      "strict",
    );
    expect(result.totals.findings).toBe(2);
    expect(result.totals.cited_ratio).toBe(0.5);
    expect(result.verdict).toBe("needs_revision");
  });

  it("rejects a fully cited finding when the quote does not entail the asserted SCJN holding", () => {
    const result = computeJudgeVerdict(
      [
        finding({
          title: "Aplicabilidad de la exención fiscal",
          description: "La SCJN determinó que el ISSSTE no está exento del pago de impuestos locales.",
          audit_classification: "VERIFIED_COURT_HOLDING",
          source_document_id: "doc-1",
          source_quote: "El Pleno determinó que fue incorrecto el fallo del Tribunal Colegiado respecto del impuesto predial.",
          evidence_refs: [{ quote: "El Pleno determinó que fue incorrecto el fallo del Tribunal Colegiado respecto del impuesto predial." }],
        }),
      ],
      "strict",
    );
    expect(result.totals.cited_ratio).toBe(1);
    expect(result.totals.integrity_issues).toBe(1);
    expect(result.verdict).toBe("reject");
  });

  it("a case with ONLY exempt findings still rejects — exemption never manufactures a pass out of nothing", () => {
    const result = computeJudgeVerdict(
      [finding({ source_module: "engine:procedural_compliance" })],
      "strict",
    );
    expect(result.totals.findings).toBe(0);
    expect(result.verdict).toBe("reject");
    expect(result.notes).toContain("No findings to evaluate.");
  });
});
