import { sourced, type EvidenceRef, type ReconstructedProposition } from "./decision-reconstruction";

export type ThesisSourceDocument = {
  id: string;
  filename: string;
  extracted_text: string | null;
};

const THESIS_METADATA_RE =
  /(?:^|\n)\s*(?:Registro digital|Instancia|Época|Materia\(s\)|Tesis|Fuente|Tipo)\s*:/imu;
const CRITERION_HEADING_RE = /(?:^|\n)\s*Criterio jur[ií]dico\s*:\s*/imu;
const NEXT_SECTION_RE =
  /(?:\r?\n)\s*(?:Justificaci[oó]n|Hechos|Antecedentes|Nota|Datos de localizaci[oó]n)\s*:/imu;

function judicialSpeaker(text: string): string | null {
  const instance = text.match(/(?:^|\n)\s*Instancia\s*:\s*([^\r\n]+)/imu)?.[1] ?? "";
  if (/tribunales? colegiados?/iu.test(instance)) return "tribunal_colegiado";
  if (/suprema corte|primera sala|segunda sala|pleno/iu.test(instance)) return "scjn";
  return null;
}

/**
 * Published Mexican tesis use a stable labelled structure. When an AI
 * reconstruction paraphrases the labelled `Criterio jurídico`, quote
 * verification correctly rejects that paraphrase. This fallback recovers
 * only the exact labelled source passage; it does not infer a holding from
 * ordinary briefs, judgments, summaries, or unlabelled prose.
 */
export function extractPublishedThesisHoldings(
  docs: readonly ThesisSourceDocument[],
  pageChars = 4_000,
): ReconstructedProposition[] {
  const holdings: ReconstructedProposition[] = [];

  for (const doc of docs) {
    const text = doc.extracted_text ?? "";
    if (!THESIS_METADATA_RE.test(text)) continue;

    const heading = CRITERION_HEADING_RE.exec(text);
    if (!heading) continue;
    const start = heading.index + heading[0].length;
    const remainder = text.slice(start);
    const nextSection = NEXT_SECTION_RE.exec(remainder);
    const end = nextSection ? start + nextSection.index : text.length;
    const quote = text.slice(start, end).trim();
    if (quote.length < 40) continue;

    const sourceRef: EvidenceRef = {
      document_id: doc.id,
      quote,
      label: `p.${Math.floor(start / pageChars) + 1}`,
    };
    holdings.push(
      sourced(
        {
          text: quote,
          speaker_role: judicialSpeaker(text),
          proposition_type: "holding",
          adoption_status: "adopted",
        },
        [sourceRef],
        `Exact Criterio jurídico extracted from ${doc.filename}`,
      ),
    );
  }

  return holdings;
}