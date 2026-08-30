import { describe, it, expect } from "vitest";
import { detectMotions } from "../algorithms";
import type { ProceduralPosture } from "../procedural-posture";

describe("detectMotions posture gating", () => {
  it("returns no motions for a concluded resolution without remand", () => {
    const posture: ProceduralPosture = {
      case_status: "concluded",
      decision_type: "sentencia definitiva",
      court_level: "scjn",
      current_stage: "concluded",
      next_stage: null,
      is_final_resolution: true,
      is_historical_record: false,
      remand_ordered: false,
      remand_target: null,
      open_deadlines_supported: false,
    };

    const motions = detectMotions(
      [{ tag: "prueba_ilicita", severity: "high" }],
      posture,
    );

    expect(motions).toEqual([]);
  });

  it("returns motions when case is in active stage with penal anchor", () => {
    const posture: ProceduralPosture = {
      case_status: "pending",
      decision_type: null,
      court_level: "primera_instancia",
      current_stage: "investigacion_complementaria",
      next_stage: "audiencia_intermedia",
      is_final_resolution: false,
      is_historical_record: false,
      remand_ordered: false,
      remand_target: null,
      open_deadlines_supported: true,
    };

    const motions = detectMotions(
      [{ tag: "prueba_ilicita", severity: "high" }],
      posture,
    );

    expect(motions.length).toBeGreaterThan(0);
    expect(motions[0].motion).toContain("exclusión de prueba ilícita");
  });
});
