import { describe, it, expect } from "vitest";
import {
  extractCaseNumbers,
  extractPrincipalParty,
  generateAutomaticCaseName,
  generateAutomaticCaseDescription,
} from "../case-identity-generator.server";
import type { ProceduralPosture } from "../procedural-posture";

describe("Automatic Case Identity, Name & Description Generation", () => {
  it("Test A: generates verified name and description from blank inputs", () => {
    const text = `
      SUPREMA CORTE DE JUSTICIA DE LA NACIÓN
      AMPARO DIRECTO EN REVISIÓN 311/2015
      QUEJOSA: MARÍA LÓPEZ
      AUTORIDAD RESPONSABLE: TRIBUNAL COLEGIADO DE CIRCUITO
    `;
    const numbers = extractCaseNumbers(text);
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers[0].type).toBe("ADR");
    expect(numbers[0].normalized).toBe("ADR 311/2015");

    const partiesJson = JSON.stringify([
      { role: "QUEJOSA", name: "MARÍA LÓPEZ" },
      { role: "AUTORIDAD RESPONSABLE", name: "TRIBUNAL COLEGIADO" },
    ]);
    const parties = extractPrincipalParty(partiesJson, "amparo_directo_revision", "amparo");
    expect(parties.primary).toBe("MARÍA LÓPEZ");

    const nameResult = generateAutomaticCaseName({
      case_number_normalized: numbers[0].normalized,
      primary_party_name: parties.primary,
      court_name: "SUPREMA CORTE DE JUSTICIA DE LA NACIÓN",
    });

    expect(nameResult.name).toBe("ADR 311/2015 — MARÍA LÓPEZ");
    expect(nameResult.source).toBe("generated");
    expect(nameResult.locked).toBe(false);

    const posture: ProceduralPosture = {
      is_final_resolution: true,
      case_status: "concluded",
      decision_type: "sentencia definitiva",
      remand_ordered: false,
      pretrial_remedies_permitted: false,
    };

    const descResult = generateAutomaticCaseDescription(
      {
        case_number_normalized: numbers[0].normalized,
        procedural_vehicle: "amparo_directo_revision",
        effective_materia: "amparo",
        underlying_materia: "penal",
        court_name: "SCJN",
        primary_party_name: parties.primary,
      },
      posture,
    );

    expect(descResult.description).toContain("amparo directo revision");
    expect(descResult.description).toContain("MARÍA LÓPEZ");
    expect(descResult.source).toBe("generated");
  });

  it("Test B: preserves custom user name and marks it locked", () => {
    const nameResult = generateAutomaticCaseName(
      {
        case_number_normalized: "ADR 311/2015",
        primary_party_name: "MARÍA LÓPEZ",
      },
      "Caso López — Defensa",
    );

    expect(nameResult.name).toBe("Caso López — Defensa");
    expect(nameResult.source).toBe("user");
    expect(nameResult.locked).toBe(true);
    expect(nameResult.confidence).toBe(1.0);
  });

  it("Test C: preserves manual description while auto-generating case name", () => {
    const nameResult = generateAutomaticCaseName({
      case_number_normalized: "Exp. Laboral 1234/2025",
      primary_party_name: "José Hernández",
    });
    expect(nameResult.name).toBe("Exp. Laboral 1234/2025 — José Hernández");

    const descResult = generateAutomaticCaseDescription(
      {
        case_number_normalized: "Exp. Laboral 1234/2025",
      },
      null,
      "Auditoría laboral estratégica de despido.",
    );

    expect(descResult.description).toBe("Auditoría laboral estratégica de despido.");
    expect(descResult.source).toBe("user");
    expect(descResult.locked).toBe(true);
  });

  it("Test D: preserves manual name while auto-generating description", () => {
    const nameResult = generateAutomaticCaseName(
      {
        case_number_normalized: "ADR 311/2015",
      },
      "Mi Caso Penal",
    );
    expect(nameResult.name).toBe("Mi Caso Penal");
    expect(nameResult.locked).toBe(true);

    const descResult = generateAutomaticCaseDescription(
      {
        procedural_vehicle: "causa_penal",
        court_name: "Juzgado de Control",
        primary_party_name: "Carlos Ramírez",
      },
      { is_final_resolution: false, case_status: "ongoing", current_stage: "etapa_intermedia" },
    );

    expect(descResult.description).toContain("etapa intermedia");
    expect(descResult.description).toContain("Carlos Ramírez");
    expect(descResult.locked).toBe(false);
  });

  it("Test E: falls back to docket + court when party is redacted or missing", () => {
    const nameResult = generateAutomaticCaseName({
      case_number_normalized: "ADR 311/2015",
      court_name: "SUPREMA CORTE DE JUSTICIA DE LA NACIÓN",
      primary_party_name: null,
    });

    expect(nameResult.name).toBe("ADR 311/2015 — SCJN");
  });

  it("Test F: identifies primary proceeding docket vs related/lower court dockets", () => {
    const text = `
      TRIBUNAL COLEGIADO EN MATERIA PENAL
      AMPARO DIRECTO 245/2026
      Derivado del TOCA PENAL 87/2026
      En relación con la CAUSA PENAL 45/2025
    `;

    const numbers = extractCaseNumbers(text);
    expect(numbers.length).toBe(3);
    expect(numbers[0].type).toBe("Amparo Directo");
    expect(numbers[0].normalized).toBe("Amparo Directo 245/2026");
    expect(numbers[0].isPrimary).toBe(true);

    const related = numbers.filter((n) => !n.isPrimary).map((n) => n.normalized);
    expect(related).toContain("Toca Penal 87/2026");
    expect(related).toContain("Causa Penal 45/2025");
  });

  it("Test G: filters out non-parties such as judges, prosecutors, witnesses, and experts", () => {
    const partiesJson = JSON.stringify([
      { role: "JUEZ DE CONTROL", name: "Lic. Roberto González" },
      { role: "MINISTERIO PÚBLICO", name: "Fiscalía Especializada" },
      { role: "PERITO", name: "Dr. Juan Forense" },
      { role: "TESTIGO", name: "Pedro Ocular" },
      { role: "IMPUTADO", name: "Alejandro Morales" },
    ]);

    const party = extractPrincipalParty(partiesJson, "proceso_penal", "penal");
    expect(party.primary).toBe("Alejandro Morales");
    expect(party.primary).not.toBe("Lic. Roberto González");
    expect(party.primary).not.toBe("Dr. Juan Forense");
  });
});
