import { describe, expect, it } from "vitest";
import { applyMigratorioDisposition, matchesMigratorioDisposition, resolveMigratorioDisposition } from "../migratorio-disposition";
import type { MandatoryDecisionCoreItem } from "../mandatory-decision-core";

const old: MandatoryDecisionCoreItem = { id: "prior", kind: "DISPOSITION", text: "Se confirma el fallo anterior.", speaker_role: null,
  adoption_status: "adopted", proposition_type: "procedural_fact", source_refs: [{ document_id: "district", quote: "Se confirma el fallo anterior." }] };
const holding = { ...old, id: "holding", kind: "COURT_HOLDING" as const, speaker_role: "tribunal_local" };
const document = (id: string, court: string, orders: string) => ({ id, extracted_text: `${court}\nANTECEDENTES\n${"Historia del asunto. ".repeat(1500)}\nRESUELVE:\n${orders}\nNOTIFÍQUESE` });

describe("Migratorio final disposition", () => {
  it("uses full final orders after quoted history and the model's 20,000 character budget", () => {
    const doc = document("review", "SUPREMA CORTE DE JUSTICIA DE LA NACIÓN", "PRIMERO. Se revoca la resolución recurrida.\nSEGUNDO. Se sobresee respecto de la autoridad A.\nTERCERO. La Justicia de la Unión ampara y protege a la parte solicitante.");
    doc.extracted_text = doc.extracted_text.replace("ANTECEDENTES", "ANTECEDENTES\nRESUELVE:\nÚNICO. Se confirma el fallo anterior.\nNOTIFÍQUESE");
    const resolved = resolveMigratorioDisposition([doc], [old, holding]);
    expect(resolved.status).toBe("verified");
    expect(resolved.items).toHaveLength(3);
    expect(resolved.items[2].text).toContain("ampara y protege");
    expect(resolved.history.map(i => i.adoption_status)).toEqual(["historical", "historical"]);
    expect(applyMigratorioDisposition([old, holding], resolved)).toEqual(resolved.items);
    expect(matchesMigratorioDisposition(resolved, resolved.items)).toBe(true);
    expect(matchesMigratorioDisposition(resolved, [old])).toBe(false);
  });

  it.each([
    "ÚNICO. Se niega el amparo solicitado.",
    "PRIMERO. Se confirma la resolución impugnada.\nSEGUNDO. Archívese el expediente.",
    "PRIMERO. Se modifica el fallo.\nSEGUNDO. Se concede el amparo para los efectos precisados.",
  ])("preserves actual outcomes, including affirmation and denial: %s", orders => {
    const resolved = resolveMigratorioDisposition([document("review", "Instancia: Primera Sala", orders)], [old]);
    expect(resolved.status).toBe("verified");
    expect(resolved.items.map(i => i.text).join("\n")).toBe(orders);
  });

  it("selects the reviewing court regardless of upload order and retains lower orders as history", () => {
    const lower = document("district", "JUZGADO DE DISTRITO\nFecha de resolución: 2022-03-01", "ÚNICO. Se sobresee el juicio.");
    const higher = document("appeal", "TRIBUNAL COLEGIADO\nFecha de resolución: 2023-04-12", "ÚNICO. Se revoca el sobreseimiento.");
    for (const docs of [[lower, higher], [higher, lower]]) {
      const resolved = resolveMigratorioDisposition(docs, []);
      expect(resolved.items[0].speaker_role).toBe("tribunal_colegiado");
      expect(resolved.history[0].source_refs[0].document_id).toBe("district");
    }
  });

  it("does not select a historical superior-court ruling over a later lower-court judgment", () => {
    const lower = document("district", "JUZGADO DE DISTRITO\nFecha de resolución: 2024-01-15", "ÚNICO. Se cumple la ejecutoria.");
    const higher = document("appeal", "TRIBUNAL COLEGIADO\nFecha de resolución: 2023-04-12", "ÚNICO. Se concede el amparo.");
    expect(resolveMigratorioDisposition([higher, lower], []).reason).toBe("current_disposition_chronology_unverified");
    lower.extracted_text = lower.extracted_text.replace("Fecha de resolución", "Fecha de impresión");
    expect(resolveMigratorioDisposition([higher, lower], []).status).toBe("unresolved");
  });

  it("accepts a final heading introduced by the court's closing formula", () => {
    const doc = document("review", "Instancia: Primera Sala", "ÚNICO. Se concede el amparo.");
    doc.extracted_text = doc.extracted_text.replace("RESUELVE:", "Por lo expuesto y fundado, se resuelve:");
    expect(resolveMigratorioDisposition([doc], []).items[0].text).toBe("ÚNICO. Se concede el amparo.");
  });

  it("does not mistake a later dissent or an SCJN citation in the merits for the issuing court", () => {
    const doc = document("district", "JUZGADO DE DISTRITO", "ÚNICO. Se concede el amparo.");
    doc.extracted_text += "\nVOTO PARTICULAR\nSUPREMA CORTE DE JUSTICIA DE LA NACIÓN\nRESUELVE\nÚNICO. Se niega el amparo.";
    const resolved = resolveMigratorioDisposition([doc], []);
    expect(resolved.items[0].speaker_role).toBe("tribunal_local");
    expect(resolved.items[0].text).toContain("Se concede");
  });

  it("fails closed for missing, ambiguous or unknown-current-court orders", () => {
    expect(resolveMigratorioDisposition([], []).status).toBe("unresolved");
    expect(resolveMigratorioDisposition([document("x", "Autoridad desconocida", "ÚNICO. Se concede.")], []).status).toBe("unresolved");
    const first = document("a", "Instancia: Primera Sala", "ÚNICO. Se concede el amparo.");
    const second = document("b", "Instancia: Primera Sala", "ÚNICO. Se niega el amparo.");
    expect(resolveMigratorioDisposition([first, second], []).reason).toBe("competing_current_dispositions");
    const lower = document("lower", "JUZGADO DE DISTRITO", "ÚNICO. Se sobresee.");
    expect(resolveMigratorioDisposition([lower, { id: "higher", extracted_text: "SUPREMA CORTE DE JUSTICIA DE LA NACIÓN\nANTECEDENTES\nfragmento" }], []).reason).toBe("current_court_orders_missing");
  });
});
