import type { MandatoryDecisionCoreItem } from "./mandatory-decision-core";

type Court = "scjn" | "tribunal_colegiado" | "tribunal_local";
type Document = { id: string; extracted_text: string | null };
export type MigratorioDisposition = {
  version: 1;
  status: "verified" | "unresolved";
  reason?: string;
  items: MandatoryDecisionCoreItem[];
  history: MandatoryDecisionCoreItem[];
};

const rank = { scjn: 3, tribunal_colegiado: 2, tribunal_local: 1 };
export const dispositionText = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim();

/** Only caption/issuing-court metadata, never citations in the merits. */
function issuingCourt(text: string): Court | null {
  const caption = text.slice(0, 2500).split(/\b(?:ANTECEDENTES|RESULTANDO|CONSIDERANDO)\b/i)[0];
  if (/^(?:Instancia\s*:\s*(?:Primera Sala|Segunda Sala|Pleno)|\s*SUPREMA CORTE DE JUSTICIA DE LA NACI[ÓO]N)\b/im.test(caption)) return "scjn";
  if (/^(?:Instancia\s*:\s*)?\s*TRIBUNA(?:L|LES)\s+COLEGIADOS?\b/im.test(caption)) return "tribunal_colegiado";
  if (/^\s*(?:JUZGADO\b[^\n]*|TRIBUNAL SUPERIOR DE JUSTICIA\b[^\n]*)/im.test(caption)) return "tribunal_local";
  return null;
}

/** Migratorio-only extraction. Preserve every numbered order, including mixed
 * outcomes and nonstandard verbs. Never reduce a partial dismissal to a global
 * outcome, and never use the reconstruction model's truncated corpus. */
function finalOrders(doc: Document): { court: Court | null; date: string | null; items: MandatoryDecisionCoreItem[] } | null {
  const text = doc.extracted_text ?? "";
  // Separate votes are not the judgment's operative disposition.
  const opinion = text.split(/\n\s*VOTO\s+(?:PARTICULAR|CONCURRENTE|ACLARATORIO)\b/i)[0];
  const headings = [...opinion.matchAll(/(?<![\p{L}\p{N}])(?:(?:S\s*E\s+)?R\s*E\s*S\s*U\s*E\s*L\s*V\s*E|PUNTOS?\s+RESOLUTIVOS?|RESOLUTIVOS)\s*[:.]*[\t ]*(?:\r?\n|$)/giu)];
  const heading = headings.at(-1);
  if (!heading) return null;
  const start = heading.index! + heading[0].length;
  const block = opinion.slice(start).split(/\n\s*(?:NOTIF[IÍ]QUESE|AS[IÍ]\s+LO\s+RESOLVIERON)\b/i)[0];
  const markers = [...block.matchAll(/(?:^|\n)[\t ]*((?:PRIMER[OA]|SEGUND[OA]|TERCER[OA]|CUART[OA]|QUINT[OA]|SEXT[OA]|S[ÉE]PTIM[OA]|OCTAV[OA]|NOVEN[OA]|D[ÉE]CIM[OA]|[ÚU]NIC[OA]))\s*[.°º:\-]+\s*/gi)];
  if (!markers.length || block.slice(0, markers[0].index).trim()) return null;
  const court = issuingCourt(text);
  const items = markers.map((marker, i): MandatoryDecisionCoreItem => {
    const offset = start + marker.index! + marker[0].length;
    const quote = block.slice(marker.index! + marker[0].length, markers[i + 1]?.index ?? block.length).trim();
    return {
      id: `migratorio-final:${doc.id}:${offset}`,
      kind: "DISPOSITION", text: `${marker[1].toUpperCase()}. ${quote}`,
      speaker_role: court, proposition_type: "procedural_fact", adoption_status: "adopted",
      source_refs: [{ document_id: doc.id, quote, label: `character:${offset}` }],
    };
  });
  if (items.some(item => !item.source_refs[0].quote)) return null;
  // Only an explicit decision date; upload/publication/printing dates are not
  // evidence of procedural chronology. Missing dates fail closed in multi-
  // judgment corpora rather than promoting an old superior-court decision.
  const date = text.slice(0, 2500).match(/Fecha\s+(?:de\s+(?:resoluci[oó]n|sentencia|ejecutoria)|del\s+fallo)\s*:\s*(\d{4}-\d{2}-\d{2})\b/i)?.[1] ?? null;
  return { court, date, items };
}

const historical = (item: MandatoryDecisionCoreItem): MandatoryDecisionCoreItem => ({
  ...item, kind: "REJECTED_HOLDING", adoption_status: "historical", proposition_type: "procedural_fact",
});

/** Unknown authority or competing judgments at the same level require review;
 * upload order and a quotation's existence cannot establish which one controls. */
export function resolveMigratorioDisposition(documents: Document[], core: MandatoryDecisionCoreItem[]): MigratorioDisposition {
  const candidates = documents.map(finalOrders).filter((x): x is NonNullable<typeof x> => x !== null);
  const unresolved = (reason: string): MigratorioDisposition => ({ version: 1, status: "unresolved", reason, items: [], history: [] });
  if (!candidates.length) return unresolved("final_orders_not_found");
  if (candidates.some(c => !c.court)) return unresolved("issuing_court_not_verified");
  const highest = Math.max(...candidates.map(c => rank[c.court!]));
  const identifiedCourts = documents.map(d => issuingCourt(d.extracted_text ?? ""));
  if (identifiedCourts.some(c => c && rank[c] > highest)) return unresolved("current_court_orders_missing");
  const current = candidates.filter(c => rank[c.court!] === highest);
  const signature = (items: MandatoryDecisionCoreItem[]) => items.map(i => dispositionText(i.text)).join("\n");
  if (new Set(current.map(c => signature(c.items))).size !== 1) return unresolved("competing_current_dispositions");
  const selected = current[0];
  const lower = candidates.filter(c => rank[c.court!] < highest);
  if (lower.length && (!selected.date || lower.some(c => !c.date || c.date >= selected.date!))) {
    return unresolved("current_disposition_chronology_unverified");
  }
  const displaced = core.filter(i => i.kind === "DISPOSITION" || i.kind === "REMEDY" ||
    i.kind === "REJECTED_HOLDING" || i.kind === "COURT_HOLDING" && i.speaker_role !== selected.court);
  return {
    version: 1, status: "verified", items: selected.items,
    history: [...displaced, ...lower.flatMap(c => c.items)].map(historical),
  };
}

export function applyMigratorioDisposition(core: MandatoryDecisionCoreItem[], resolved: MigratorioDisposition): MandatoryDecisionCoreItem[] {
  if (resolved.status !== "verified") return core;
  const displaced = new Set(resolved.history.map(i => i.id));
  return [...core.filter(i => !displaced.has(i.id)), ...resolved.items];
}

/** Lower-instance decisions remain visible as history, not severity-ranked
 * dashboard findings. Arguments and ordinary evidence are unaffected. */
export function isMigratorioHistoricalDecision(item: { speaker_role?: unknown; proposition_type?: unknown; adoption_status?: unknown; audit_classification?: unknown }, resolved: MigratorioDisposition | undefined): boolean {
  if (resolved?.status !== "verified") return false;
  const role = item.speaker_role as Court;
  const current = resolved.items[0]?.speaker_role as Court;
  const decision = ["holding", "court_holding", "rejected_holding", "procedural_fact"].includes(String(item.proposition_type)) ||
    item.audit_classification === "VERIFIED_COURT_HOLDING";
  return decision && (!!rank[role] && !!rank[current] && rank[role] < rank[current] ||
    item.adoption_status === "historical" || item.adoption_status === "rejected");
}

/** Compare source-anchored orders, not word overlap. The canonical disposition
 * lane is verbatim by contract, so paraphrases cannot invert its legal effect. */
export function matchesMigratorioDisposition(expected: MigratorioDisposition | undefined, items: Array<{id?: unknown; kind?: unknown; text?: unknown}>): boolean {
  if (expected?.version !== 1 || expected.status !== "verified" || !expected.items.length) return false;
  const actual = items.filter(i => i.kind === "DISPOSITION" || i.kind === "RESOLUTIVOS");
  return actual.length === expected.items.length && actual.every((item, i) =>
    item.id === expected.items[i].id && typeof item.text === "string" && dispositionText(item.text) === dispositionText(expected.items[i].text)) &&
    expected.items.every(item => item.source_refs.some(ref => ref.document_id && ref.quote &&
      dispositionText(item.text).endsWith(dispositionText(ref.quote))));
}
