// Automatic, evidence-preserving report correction that runs BEFORE the
// unchanged release checks. It never invents content and never weakens a
// gate: it only (a) removes leaked internal sanitizer filler, (b) drops
// sentences that assert an institution from a foreign legal area, and
// (c) carries verified decision-core propositions verbatim into the summary.
// The existing validators then decide release on the corrected content.
import { checkDomainVocabulary } from "./domain-vocabulary-gate";

const FILLER_RX = /\bwell-supported\b/i;

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/g);
}

function scrubFiller(sentence: string): string {
  if (!FILLER_RX.test(sentence)) return sentence;
  let out = sentence
    .replace(/\s*\(\s*well-supported\s*\)/gi, "")
    .replace(/\b(?:is|was|of|as|at)\s+well-supported\b/gi, "")
    .replace(/\bwell-supported\b/gi, "");
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  return out.split(/\s+/).filter(Boolean).length >= 4 ? out : "";
}

export function correctText(
  text: string,
  caseType: string | null | undefined,
  underlyingMateria?: string | null,
): string {
  if (!text) return text;
  const kept: string[] = [];
  for (const raw of splitSentences(text)) {
    const s = scrubFiller(raw);
    if (!s) continue;
    if (!checkDomainVocabulary(s, caseType ?? undefined, underlyingMateria).clean) continue;
    kept.push(s);
  }
  return kept.join(" ");
}

/** Mutates string fields in place; returns the number of fields changed. */
export function autoCorrectRenderedReport(
  report: Record<string, unknown>,
  caseType: string | null | undefined,
  underlyingMateria?: string | null,
): number {
  let changed = 0;
  const seen = new WeakSet<object>();
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      const needsFiller = FILLER_RX.test(node);
      const needsDomain = !checkDomainVocabulary(node, caseType ?? undefined, underlyingMateria).clean;
      if (!needsFiller && !needsDomain) return node;
      const fixed = correctText(node, caseType, underlyingMateria);
      if (fixed !== node) changed += 1;
      return fixed;
    }
    if (node && typeof node === "object") {
      if (seen.has(node as object)) return node;
      seen.add(node as object);
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) node[i] = visit(node[i]);
      } else {
        const obj = node as Record<string, unknown>;
        for (const k of Object.keys(obj)) {
          // Verbatim evidence quotes are verified elsewhere; never rewrite them.
          if (k === "quote" || k === "verbatim" || k === "source_quote") continue;
          obj[k] = visit(obj[k]);
        }
      }
    }
    return node;
  };
  visit(report);
  return changed;
}

/** Append omitted verified decision propositions verbatim to the summary. */
export function appendMissingDecisionCore(
  summary: string | null | undefined,
  missing: ReadonlyArray<{ text: string }>,
): string {
  const base = String(summary ?? "").trim();
  const lines = missing.map((m) => String(m.text ?? "").trim()).filter(Boolean);
  if (lines.length === 0) return base;
  const block = `Decisión del tribunal (verificada en autos): ${lines.join(" ")}`;
  return base ? `${base}\n\n${block}` : block;
}
