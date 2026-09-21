import { describe, expect, it } from "vitest";
import { extractPublishedThesisHoldings } from "../thesis-decision-fallback";
import { buildMandatoryDecisionCore } from "../mandatory-decision-core";
import { emptyReconstruction } from "../decision-reconstruction";

const criterion =
  "Las personas migrantes sujetas a un procedimiento que puede afectar su libertad deben contar con defensa adecuada desde su inicio.";

function thesis(materia: string, instance = "Primera Sala") {
  return {
    id: `doc-${materia}`,
    filename: `tesis-${materia}.txt`,
    extracted_text: `Registro digital: 2027200\nInstancia: ${instance}\nMateria(s): ${materia}\nTesis: 1a./J. 15/2026 (11a.)\nTipo: Jurisprudencia\n\nCriterio jurídico: ${criterion}\n\nJustificación: La interpretación deriva del parámetro constitucional aplicable.`,
  };
}

describe("published tesis decision fallback", () => {
  it.each(["Civil", "Familiar", "Laboral", "Penal", "Migratorio", "Amparo"])(
    "extracts an exact, source-grounded holding for %s without materia-specific logic",
    (materia) => {
      const [holding] = extractPublishedThesisHoldings([thesis(materia)]);
      expect(holding?.status).toBe("PRESENT");
      expect(holding?.value?.text).toBe(criterion);
      expect(holding?.source_refs).toEqual([
        expect.objectContaining({ document_id: `doc-${materia}`, quote: criterion }),
      ]);
    },
  );

  it("maps a Tribunal Colegiado source without changing its exact criterion", () => {
    const [holding] = extractPublishedThesisHoldings([
      thesis("Administrativa", "Tribunales Colegiados de Circuito"),
    ]);
    expect(holding?.value).toMatchObject({
      text: criterion,
      speaker_role: "tribunal_colegiado",
      proposition_type: "holding",
      adoption_status: "adopted",
    });
  });

  it("does not infer holdings from ordinary judgments or unlabelled prose", () => {
    const ordinaryJudgment = {
      id: "judgment-1",
      filename: "sentencia.txt",
      extracted_text: `SENTENCIA\nEl tribunal resuelve el juicio.\n${criterion}`,
    };
    expect(extractPublishedThesisHoldings([ordinaryJudgment])).toEqual([]);
  });

  it("rejects an empty or malformed criterion section", () => {
    const malformed = {
      id: "bad-1",
      filename: "tesis-incompleta.txt",
      extracted_text: "Registro digital: 1\nTesis: X\nCriterio jurídico: breve\nJustificación: falta",
    };
    expect(extractPublishedThesisHoldings([malformed])).toEqual([]);
  });

  it("creates a mandatory decision core only from the recovered exact holding", () => {
    const reconstruction = emptyReconstruction("case-1", "2026-09-21T20:00:00Z");
    reconstruction.court_holding = extractPublishedThesisHoldings([thesis("Migratorio")]);
    const core = buildMandatoryDecisionCore(reconstruction);
    expect(core).toHaveLength(1);
    expect(core[0]).toMatchObject({ kind: "COURT_HOLDING", text: criterion });
  });
});