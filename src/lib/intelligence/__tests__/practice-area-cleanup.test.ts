import { describe, it, expect } from "vitest";
import {
  CASE_TYPE_SELECT_GROUPS,
  CASE_TYPE_SELECT_OPTIONS,
  PRACTICE_AREA_LABELS,
} from "@/lib/intelligence/practice-areas";
import { MX_CASE_TYPES, MX_CASE_TYPE_LABELS, isMexicanCaseType } from "@/lib/jurisdiction/mexico-types";
import { detectMatterSubtype } from "@/lib/jurisdiction/matter-subtype";

describe("Practice Area and Case Type Cleanup", () => {
  const EXPECTED_GROUPS = [
    "Administrativo",
    "Agrario",
    "Ambiental",
    "Civil",
    "Constitucional",
    "Electoral",
    "Familiar",
    "Fiscal",
    "Inmobiliario",
    "Laboral",
    "Mercantil",
    "Migratorio, Refugio y Nacionalidad",
    "Penal",
  ];

  it("exposes exactly 13 practice area groups in strict alphabetical order", () => {
    const groupNames = CASE_TYPE_SELECT_GROUPS.map((g) => g.group);
    expect(groupNames).toEqual(EXPECTED_GROUPS);
  });

  it("each group has non-empty options and maps exclusively to canonical Mexican case types", () => {
    for (const group of CASE_TYPE_SELECT_GROUPS) {
      expect(group.options.length).toBeGreaterThan(0);
      for (const opt of group.options) {
        expect(isMexicanCaseType(opt.value)).toBe(true);
        expect(opt.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("Constitucional contains both Juicio de Amparo and Derecho Constitucional y Derechos Humanos", () => {
    const constGroup = CASE_TYPE_SELECT_GROUPS.find((g) => g.group === "Constitucional");
    expect(constGroup).toBeDefined();
    expect(constGroup?.options).toHaveLength(2);

    const [amparoOpt, constitOpt] = constGroup!.options;
    expect(amparoOpt.value).toBe("amparo");
    expect(amparoOpt.label).toBe("Juicio de Amparo");

    expect(constitOpt.value).toBe("constitucional");
    expect(constitOpt.label).toContain("Derecho Constitucional y Derechos Humanos");
  });

  it("all 14 canonical Mexican case types are reachable from CASE_TYPE_SELECT_GROUPS", () => {
    const presentTypes = new Set(CASE_TYPE_SELECT_OPTIONS.map((opt) => opt.value));
    for (const t of MX_CASE_TYPES) {
      expect(presentTypes.has(t), `Missing canonical case type: ${t}`).toBe(true);
    }
    expect(presentTypes.size).toBe(14);
  });

  it("Penal is at the bottom alphabetically and includes CNPP label", () => {
    const lastGroup = CASE_TYPE_SELECT_GROUPS[CASE_TYPE_SELECT_GROUPS.length - 1];
    expect(lastGroup.group).toBe("Penal");
    expect(lastGroup.options[0].value).toBe("penal");
    expect(lastGroup.options[0].label).toContain("Derecho Penal (Sistema Acusatorio, CNPP");
    expect(MX_CASE_TYPE_LABELS.penal.es).toBe("Derecho Penal (Sistema Acusatorio, CNPP)");
  });

  it("Civil and Familiar, Administrativo and Fiscal are strictly separate groups", () => {
    const groupNames = CASE_TYPE_SELECT_GROUPS.map((g) => g.group);
    expect(groupNames).toContain("Civil");
    expect(groupNames).toContain("Familiar");
    expect(groupNames).toContain("Administrativo");
    expect(groupNames).toContain("Fiscal");

    expect(groupNames).not.toContain("Civil y Familiar");
    expect(groupNames).not.toContain("Administrativo y Fiscal");
    expect(groupNames).not.toContain("Materias especializadas");
  });

  it("Amparo secondary subtype routing detects ADR and distinguishes it from standard amparo", () => {
    const adrSubtype = detectMatterSubtype("amparo", "Recurso de amparo directo en revisión 123/2026 ante la SCJN");
    expect(adrSubtype?.key).toBe("directo_en_revision");
    expect(adrSubtype?.excludedEngines).toContain("agent:suspension_analysis");
  });
});
