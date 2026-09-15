// Presentation-only cleanup for stored assistant/case text.
// Stored records are NEVER modified — this only affects what is rendered.
//
// Handles three artefacts that leak out of saved assistant output:
//   1. Markdown emphasis markers (**bold**, *italic*, `code`)
//   2. snake_case gap keys (revision_de_riesgo -> Revisión de riesgo is not
//      attempted; we simply humanize to "revision de riesgo" style words)
//   3. Structural headings saved in the wrong language / wrong wording
//      (GAPS DETERMINISTAS, DETERMINISTIC GAPS, NEXT STEPS, CASE FACT, ...)

type Lang = "es" | "en";

const HEADINGS: { re: RegExp; es: string; en: string }[] = [
  { re: /\b(?:GAPS?\s+DETERMINISTAS?|BRECHAS\s+IDENTIFICADAS|DETERMINISTIC\s+GAPS)\b/gi, es: "Brechas identificadas", en: "Identified gaps" },
  { re: /\b(?:NEXT\s+STEPS|PR[ÓO]XIMOS\s+PASOS)\b/gi, es: "Próximos pasos", en: "Next steps" },
  { re: /\b(?:CASE\s+FACTS?|HECHOS?\s+DEL\s+CASO)\b/gi, es: "Hecho del caso", en: "Case fact" },
  { re: /\b(?:KNOWLEDGE\s+GUIDANCE|GU[ÍI]A\s+DE\s+CONOCIMIENTO)\b/gi, es: "Guía de conocimiento", en: "Knowledge guidance" },
  { re: /\b(?:RESOURCE\s+SUGGESTIONS?|SUGERENCIAS?\s+DE\s+RECURSO)\b/gi, es: "Sugerencia de recurso", en: "Resource suggestion" },
];

/** Turn a snake_case token into spaced words with an initial capital. */
function humanizeToken(token: string): string {
  const words = token.split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function presentStoredText(text: string, lang: Lang): string {
  if (!text) return text;
  let out = text;

  // Escaped newlines that were persisted literally.
  out = out.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, " ");

  // snake_case keys wrapped in markdown emphasis -> readable label.
  out = out.replace(/\*\*([a-záéíóúñ0-9]+(?:_[a-záéíóúñ0-9]+)+)\*\*/gi, (_m, k: string) => humanizeToken(k));

  // Remaining markdown emphasis / inline code markers.
  out = out.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/g, "$1$2").replace(/`([^`]+)`/g, "$1");

  // Bare snake_case keys at the start of a bullet.
  out = out.replace(/^(\s*[-•]\s*)([a-záéíóúñ0-9]+(?:_[a-záéíóúñ0-9]+)+)\b/gim, (_m, b: string, k: string) => `${b}${humanizeToken(k)}`);

  for (const h of HEADINGS) out = out.replace(h.re, lang === "es" ? h.es : h.en);

  return out;
}
