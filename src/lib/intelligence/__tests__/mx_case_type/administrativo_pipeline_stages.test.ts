// Pipeline-stage relevance for administrativo (juicio contencioso
// administrativo / TFJA nullity actions), and the two other materias that
// route through the same profile: electoral and ambiental
// (PROFILE_BY_MATERIA in mx-pipeline.ts).
//
// This exists because a real bug was found by inspection, not by running
// the pipeline: a TFJA nullity action is resolved on the written expediente
// (demanda, contestación, documentary evidence, alegatos, sentencia) with
// no live witness examination in the adversarial-trial sense — the same
// reasoning already correctly applied to amparo and apelacion ("no hay
// desahogo de testigos ni juicio oral"), just not previously extended to
// administrativo.
//
// This proves the fix (isStageRelevantForCaseType / mxPipelineStages in
// mx-pipeline.ts) actually excludes `witness`, rather than asserting it.
//
// 2026-08-02: trial_prep itself was removed from CANONICAL_STAGES entirely
// (not materia-excluded — it no longer exists as a stage for any materia,
// including penal). The trial_prep-specific assertions that used to live
// in this file were removed for that reason, not because the underlying
// administrativo/witness fix was reverted.
import { describe, it, expect } from "vitest";
import { isStageRelevantForCaseType, mxPipelineStageKeys } from "@/lib/execution/mx-pipeline";

describe("administrativo (and electoral/ambiental, same profile) pipeline stage relevance", () => {
  it("excludes witness for administrativo — same rationale already used for amparo/apelacion", () => {
    expect(isStageRelevantForCaseType("administrativo", "witness")).toBe(false);
    // constitutional was already correctly excluded before this fix.
    expect(isStageRelevantForCaseType("administrativo", "constitutional")).toBe(false);
  });

  it("applies identically to electoral and ambiental, which route through the same administrativo profile", () => {
    expect(isStageRelevantForCaseType("electoral", "witness")).toBe(false);
    expect(isStageRelevantForCaseType("ambiental", "witness")).toBe(false);
  });

  it("still runs the stages that produce useful output for a contentious-administrative case", () => {
    const keys = mxPipelineStageKeys("administrativo");
    for (const useful of [
      "extraction", "analyzers", "agents", "timeline", "evidence_map",
      "contradictions", "evidence_intel", "jurisdiction_intel",
      "procedural_compliance", "discovery", "theories", "strategy",
      "work_product", "scoring", "legal_qa", "report",
    ]) {
      expect(keys).toContain(useful);
    }
    // trial_prep no longer exists as a stage at all — confirm it's absent
    // from every materia's stage list, not just administrativo's.
    expect(keys).not.toContain("trial_prep");
  });

  it("does NOT exclude witness for a real adversarial-trial materia (penal) — the fix is scoped, not global", () => {
    expect(isStageRelevantForCaseType("penal", "witness")).toBe(true);
  });

  it("still excludes witness for amparo — regression guard against accidentally narrowing the existing exclusion", () => {
    expect(isStageRelevantForCaseType("amparo", "witness")).toBe(false);
  });

  it("trial_prep is absent from every materia's pipeline, not just administrativo's", () => {
    for (const materia of ["penal", "civil", "familiar", "laboral", "administrativo", "amparo", "inmobiliario"]) {
      expect(mxPipelineStageKeys(materia)).not.toContain("trial_prep");
    }
  });
});
