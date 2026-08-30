import { describe, it, expect } from "vitest";
import {
  detectProceduralPosture,
  sanitizeActionsForPosture,
  categorizeMissingEvidence,
} from "../procedural-posture";

describe("procedural-posture", () => {
  it("detects concluded posture from SCJN executoria", () => {
    const posture = detectProceduralPosture({
      caseRow: { case_analysis_mode: "judgment_audit" },
      corpusText: "Suprema Corte de Justicia de la Nación. Amparo Directo en Revisión 6312/2018. Se revoca la sentencia recurrida y devuélvanse los autos al Tribunal Colegiado.",
      resolutivos: "PRIMERO. En la materia de la revisión, se revoca la sentencia recurrida. SEGUNDO. Devuélvanse los autos al Tribunal Colegiado.",
    });

    expect(posture.court_level).toBe("scjn");
    expect(posture.is_final_resolution).toBe(true);
    expect(posture.remand_ordered).toBe(true);
    expect(posture.case_status).toBe("remanded");
    expect(posture.open_deadlines_supported).toBe(false);
  });

  it("sanitizes future trial actions in a concluded case", () => {
    const posture = detectProceduralPosture({
      caseRow: { case_analysis_mode: "concluded_audit" },
      corpusText: "Sentencia definitiva. Se confirma la sentencia.",
      resolutivos: "PRIMERO. Se confirma la sentencia.",
    });

    const actions = [
      { title: "Recopilar testimonios antes de la audiencia", action: "Recopilar" },
      { title: "Auditar incongruencias en la valoración probatoria", action: "Auditar" },
    ];

    const sanitized = sanitizeActionsForPosture(actions, posture);
    expect(sanitized.length).toBe(1);
    expect(sanitized[0].title).toBe("Auditar incongruencias en la valoración probatoria");
  });

  it("categorizes missing evidence into epistemic buckets", () => {
    const posture = detectProceduralPosture({
      caseRow: { case_analysis_mode: "concluded_audit" },
      corpusText: "Amparo Directo en Revisión",
    });

    const bucketDecision = categorizeMissingEvidence("Falta resolutivo segundo de la ejecutoria", posture);
    const bucketRecord = categorizeMissingEvidence("Falta informe de policía municipal de 2014", posture);

    expect(bucketDecision).toBe("missing_for_understanding_the_decision");
    expect(bucketRecord).toBe("missing_for_reconstructing_underlying_record");
  });
});
