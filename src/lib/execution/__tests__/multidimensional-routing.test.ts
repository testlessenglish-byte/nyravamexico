import { describe, it, expect } from "vitest";
import {
  effectiveMxProfile,
  isStageRelevantForCaseType,
} from "../mx-pipeline";
import { getApplicableTabs, isTabApplicable } from "@/lib/intelligence/practice-areas";

describe("Nyrava México Multidimensional Pipeline & Procedural Routing", () => {
  describe("effectiveMxProfile & Stage Relevance", () => {
    it("routes Amparo Directo with underlying Laboral without falling back to plain single-field assumptions", () => {
      const profile = effectiveMxProfile("amparo", "Juicio de Amparo Directo 123/2026", null, "amparo_directo", "laboral");
      expect(profile).toBe("amparo");
      expect(isStageRelevantForCaseType("amparo", "witness", null, "amparo_directo", "laboral")).toBe(false);
      expect(isStageRelevantForCaseType("amparo", "constitutional_compliance", null, "amparo_directo", "laboral")).toBe(true);
    });

    it("enables conditional witness intelligence for Amparo Indirecto under Art. 119 Ley de Amparo", () => {
      const isWitnessRelevant = isStageRelevantForCaseType("amparo", "witness", null, "amparo_indirecto", "penal");
      expect(isWitnessRelevant).toBe(true);
    });

    it("enables conditional witness intelligence for Fiscal under LFPCA Arts. 40 and 44", () => {
      const isWitnessRelevant = isStageRelevantForCaseType("fiscal", "witness", null, null, null);
      expect(isWitnessRelevant).toBe(true);
    });

    it("enables conditional witness intelligence for Administrativo under LFPCA/LFPA", () => {
      const isWitnessRelevant = isStageRelevantForCaseType("administrativo", "witness", null, null, null);
      expect(isWitnessRelevant).toBe(true);
    });

    it("differentiates Inmobiliario Transaccional from Inmobiliario Litigio", () => {
      // Transaccional excludes litigation stages
      expect(isStageRelevantForCaseType("inmobiliario", "witness", null, "inmobiliario_transaccional")).toBe(false);
      expect(isStageRelevantForCaseType("inmobiliario", "theories", null, "inmobiliario_transaccional")).toBe(false);
      expect(isStageRelevantForCaseType("inmobiliario", "strategy", null, "inmobiliario_transaccional")).toBe(false);

      // Litigio enables litigation stages
      expect(isStageRelevantForCaseType("inmobiliario", "witness", null, "inmobiliario_litigio")).toBe(true);
      expect(isStageRelevantForCaseType("inmobiliario", "theories", null, "inmobiliario_litigio")).toBe(true);
      expect(isStageRelevantForCaseType("inmobiliario", "strategy", null, "inmobiliario_litigio")).toBe(true);
    });

    it("routes Apelación / Segunda Instancia without trial prep or oral trial assumptions", () => {
      const profile = effectiveMxProfile("civil", null, null, "apelacion");
      expect(profile).toBe("apelacion");
      expect(isStageRelevantForCaseType("civil", "witness", null, "apelacion")).toBe(false);
    });

    it("routes SCJN Amparo Directo en Revisión to constitucional profile", () => {
      const profile = effectiveMxProfile("amparo", null, null, "amparo_directo_revision");
      expect(profile).toBe("constitucional");
      expect(isStageRelevantForCaseType("amparo", "witness", null, "amparo_directo_revision")).toBe(false);
    });
  });

  describe("UI Tab Alignment (getApplicableTabs)", () => {
    it("excludes witnesses tab for Amparo Directo and SCJN ADR", () => {
      const tabsDirecto = getApplicableTabs("amparo", [], "amparo_directo");
      expect(tabsDirecto.has("witnesses")).toBe(false);
      expect(tabsDirecto.has("trial")).toBe(false);

      const tabsAdr = getApplicableTabs("constitucional", [], "amparo_directo_revision");
      expect(tabsAdr.has("witnesses")).toBe(false);
      expect(tabsAdr.has("trial")).toBe(false);
    });

    it("includes witnesses and trial/audiencia tab for Amparo Indirecto", () => {
      const tabsIndirecto = getApplicableTabs("amparo", [], "amparo_indirecto");
      expect(tabsIndirecto.has("witnesses")).toBe(true);
      expect(tabsIndirecto.has("trial")).toBe(true);
    });

    it("includes witnesses tab for Fiscal and Administrativo", () => {
      const tabsFiscal = getApplicableTabs("fiscal", []);
      expect(tabsFiscal.has("witnesses")).toBe(true);
      expect(tabsFiscal.has("trial")).toBe(true);

      const tabsAdmin = getApplicableTabs("administrativo", []);
      expect(tabsAdmin.has("witnesses")).toBe(true);
      expect(tabsAdmin.has("trial")).toBe(true);
    });

    it("gates tabs appropriately between Inmobiliario Transaccional and Inmobiliario Litigio", () => {
      const tabsTrans = getApplicableTabs("inmobiliario", [], "inmobiliario_transaccional");
      expect(tabsTrans.has("witnesses")).toBe(false);
      expect(tabsTrans.has("theories")).toBe(false);
      expect(tabsTrans.has("strategy")).toBe(false);
      expect(tabsTrans.has("transaction_center")).toBe(true);

      const tabsLitigio = getApplicableTabs("inmobiliario", [], "inmobiliario_litigio");
      expect(tabsLitigio.has("witnesses")).toBe(true);
      expect(tabsLitigio.has("theories")).toBe(true);
      expect(tabsLitigio.has("strategy")).toBe(true);
    });
  });
});
