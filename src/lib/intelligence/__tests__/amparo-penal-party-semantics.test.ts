import { describe, expect, it } from "vitest";
import {
  allowedBeneficiaryParties,
  hasCompletePartyAwareScoreMapping,
  isAmparoProceeding,
  normalizePenalFinding,
  type PartyScoreContext,
} from "../penal-legal-normalization";
import { auditPenalProceduralSemantics } from "../penal-qa-status";
import type { Finding } from "../types";

const ORDINARY_PENAL: PartyScoreContext = { matter: "penal", underlyingMatter: "penal" };
const AMPARO_DIRECTO_PENAL: PartyScoreContext = {
  matter: "amparo",
  underlyingMatter: "penal",
  proceduralVehicle: "amparo_directo",
};
const ADR_PENAL: PartyScoreContext = {
  matter: "amparo",
  underlyingMatter: "penal",
  proceduralVehicle: "amparo_directo_revision",
};
const AMPARO_INDIRECTO_PENAL: PartyScoreContext = {
  matter: "amparo",
  underlyingMatter: "penal",
  proceduralVehicle: "amparo_indirecto",
};
const AMPARO_NON_PENAL: PartyScoreContext = {
  matter: "amparo",
  underlyingMatter: "administrativo",
  proceduralVehicle: "amparo_directo",
};

function holding(overrides: Partial<Finding> = {}): Finding {
  return {
    speaker_role: "scjn",
    proposition_type: "holding",
    adoption_status: "adopted",
    audit_classification: "VERIFIED_COURT_HOLDING",
    impact_direction: "neutral",
    evidence_refs: [{ quote: "La Primera Sala resolvió que…" }],
    ...overrides,
  } as unknown as Finding;
}

describe("Amparo party semantics are first-class", () => {
  it("separates procedural vehicle from underlying substantive materia", () => {
    expect(isAmparoProceeding(ADR_PENAL)).toBe(true);
    // An ADR with penal underlying materia accepts BOTH vocabularies.
    const allowed = allowedBeneficiaryParties(ADR_PENAL);
    expect(allowed.has("quejoso")).toBe(true);
    expect(allowed.has("autoridad_responsable")).toBe(true);
    expect(allowed.has("tercero_interesado")).toBe(true);
    expect(allowed.has("defense")).toBe(true);
  });

  it("does not globally replace defense/prosecution for ordinary penal matters", () => {
    const allowed = allowedBeneficiaryParties(ORDINARY_PENAL);
    expect(allowed.has("defense")).toBe(true);
    expect(allowed.has("prosecution")).toBe(true);
    expect(allowed.has("quejoso")).toBe(false);
  });

  it("accepts amparo roles for every amparo vehicle and rejects them in ordinary penal", () => {
    for (const ctx of [AMPARO_DIRECTO_PENAL, ADR_PENAL, AMPARO_INDIRECTO_PENAL, AMPARO_NON_PENAL]) {
      expect(allowedBeneficiaryParties(ctx).has("quejoso")).toBe(true);
    }
    expect(allowedBeneficiaryParties(ORDINARY_PENAL).has("quejoso")).toBe(false);
  });
});

describe("Normalizer and QA auditor share one canonical definition", () => {
  const complete = holding({
    impact_direction: "weakens",
    benefited_party: "quejoso",
    affected_party: "autoridad_responsable",
    score_dimension: "procedural_integrity",
    reason_for_score_effect: "La Sala concedió el amparo por violación al debido proceso.",
  });
  const incomplete = holding({
    impact_direction: "weakens",
    benefited_party: null,
    score_dimension: null,
    reason_for_score_effect: null,
  });

  it("agrees that a legitimate non-neutral amparo holding is complete", () => {
    expect(hasCompletePartyAwareScoreMapping(complete, ADR_PENAL)).toBe(true);
    expect(auditPenalProceduralSemantics([complete], ADR_PENAL)).toBe(0);
    // And the normalizer leaves its direction intact — no needless neutralization.
    const normalized = normalizePenalFinding({ ...(complete as object) } as never, ADR_PENAL);
    expect((normalized as unknown as Finding).impact_direction).toBe("weakens");
    expect((normalized as unknown as Finding).benefited_party).toBe("quejoso");
  });

  it("agrees that an incomplete non-neutral holding is invalid", () => {
    expect(hasCompletePartyAwareScoreMapping(incomplete, ADR_PENAL)).toBe(false);
    expect(auditPenalProceduralSemantics([incomplete], ADR_PENAL)).toBe(1);
  });

  it("treats a neutral adopted holding as valid in every context", () => {
    for (const ctx of [ORDINARY_PENAL, AMPARO_DIRECTO_PENAL, ADR_PENAL, AMPARO_INDIRECTO_PENAL]) {
      expect(auditPenalProceduralSemantics([holding()], ctx)).toBe(0);
    }
  });

  it("reproduces ADR 217/2019's invalid record and clears it once neutralized", () => {
    // agent:international_human_rights_analysis, finding
    // d7d5da81-2d7a-4473-8838-8b210a4a449c: weakens, no party mapping.
    const adr = holding({
      impact_direction: "weakens",
      benefited_party: null,
      score_dimension: null,
      reason_for_score_effect: null,
      evidence_refs: [{ quote: "la alegación de tortura carece de impacto procesal" }],
    });
    expect(auditPenalProceduralSemantics([adr], ADR_PENAL)).toBe(1);
    const neutralized = holding({
      evidence_refs: [{ quote: "la alegación de tortura carece de impacto procesal" }],
    });
    expect(auditPenalProceduralSemantics([neutralized], ADR_PENAL)).toBe(0);
  });

  it("still rejects a party-role holding attributed as a court holding", () => {
    const partyHolding = holding({ speaker_role: "quejoso" });
    expect(auditPenalProceduralSemantics([partyHolding], ADR_PENAL)).toBe(1);
  });

  it("keeps ordinary penal defense/prosecution mappings working", () => {
    const penal = holding({
      speaker_role: "tribunal_enjuiciamiento",
      impact_direction: "strengthens",
      benefited_party: "defense",
      affected_party: "prosecution",
      score_dimension: "evidentiary_strength",
      reason_for_score_effect: "Prueba ilícita excluida.",
    });
    expect(auditPenalProceduralSemantics([penal], ORDINARY_PENAL)).toBe(0);
    // The same mapping in an amparo is equally acceptable (penal substance).
    expect(auditPenalProceduralSemantics([penal], ADR_PENAL)).toBe(0);
  });
});

describe("Post-promotion invariant is enforced at the persistence choke point", () => {
  it("re-checks scoring semantics after the holding promotion, before the insert", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/intelligence/findings.server.ts", "utf8");
    const promotion = src.indexOf('const adoption_status = isHolding ? "adopted"');
    const invariant = src.indexOf("hasCompletePartyAwareScoreMapping(");
    const insert = src.indexOf("adopted_holding_neutralized_post_promotion");
    expect(promotion).toBeGreaterThan(-1);
    expect(invariant).toBeGreaterThan(promotion);
    expect(insert).toBeGreaterThan(invariant);
    // The neutralized values, not the raw upstream ones, are what persists.
    expect(src).toContain("      evidence_type,\n      impact_direction,");
  });
});

describe("Hallucination gate reports the real blocker", () => {
  it("does not convert an upstream integrity block into a hallucination failure", async () => {
    const { readFileSync } = await import("node:fs");
    const hal = readFileSync("src/lib/intelligence/hallucination.server.ts", "utf8");
    // Its own rendered-report check still throws.
    expect(hal).toContain("if (renderedDecision.blocked) {");
    // An earlier stage's block is reported, not re-thrown.
    expect(hal).toContain("upstreamReleaseBlock");
    const orch = readFileSync("src/lib/agents/orchestrator.server.ts", "utf8");
    expect(orch).toContain("upstream_release_block: upstreamBlock");
    // Verification metrics alone decide the gate.
    expect(orch).toContain("const pass = report.total > 0 && cited > 0 && verifiedRatio >= threshold;");
  });
});
