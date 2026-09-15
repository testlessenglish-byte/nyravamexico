import { translateLegalTerm } from "./pdf/enum-translation";
import { resolveReportIdentity } from "./pdf/identity-resolver";
import { prepareCaseJsonExport } from "./reporting/case-json-export";

// Client-side download helpers for case exports.
//
// `downloadPdf` produces an attorney-grade litigation work product: cover,
// executive summary, deterministic scorecard, evidence map, contradictions,
// constitutional analysis, witness intelligence, theories, strategy, audit
// trail, and source appendix. Raw JSON is never exposed to the user — every
// internal structure is rendered as readable prose, tables, or callouts.
import jsPDF from "jspdf";
import { composeFinalReportPayload, releaseFinalReportPayload, releaseRenderedReportOutput, type FinalReportPayload } from "./reporting/final-report-contract";
import { canonicalSourceCount } from "./reporting/report-sources";
import autoTable from "jspdf-autotable";

// The report cover/header mark is drawn as a vector (see logoMark() /
// trustBadge() below) rather than an embedded raster asset, so it always
// matches the current brand palette exactly instead of drifting from a
// cached PNG. Kept as a resolved-null async function so call sites that
// await a logo asset don't need to change.
function getLogoBase64(): Promise<string | null> {
  return Promise.resolve(null);
}
import {
  rt,
  setReportTemplateLocale,
  resolveReportLocale,
  getReportTemplateLocale,
} from "./report-i18n";
import { MX_DOMAINS } from "./intelligence/mx-coverage";
import {
  METHODOLOGY_STATEMENT,
} from "./reporting/attorney-workproduct";

import { classifyClaim, CLAIM_LABEL } from "@/lib/intelligence/claim-class";
import {
  paritySignature,
  getEssState,
  getEnginesSummary,
  getReportMode,
  getFindingCounters,
  getScores,
  getTimeline,
  getAgentSummary,
  validateAgentSummary,
  type ReportMode,
} from "@/lib/intelligence/canonical";
import { getApplicableSections, normalizePracticeArea } from "@/lib/intelligence/practice-areas";
// Same derivation module the in-app Report tab uses
// (src/components/LitigationImpactDashboard.tsx) — single source of truth
// so the PDF export and the live report can never disagree about
// what a card says or which cards exist for a given case.
import {
  buildLitigationImpactDashboard,
  type ImpactCard,
} from "@/lib/intelligence/litigation-impact";
import { MX_PARTY_ROLES, mxProfileOrNull, mxRoleLabel } from "@/lib/execution/mx-pipeline";
import { filterExecutiveDashboardEligible } from "@/lib/intelligence/judicial-hierarchy";

// Report Engine v1.0 — frozen release identifier surfaced on every PDF footer.
// The structure, section order, and scoring formulas are locked; only bug
// fixes, factual accuracy, citation, and formatting improvements are allowed.
// See docs/RELEASE-REPORT-ENGINE-v1.0.md and docs/FREEZE.md.
export const NYRAVA_REPORT_VERSION = "1.0.0";

// Brand violet accent, matching the site's mark/wordmark lockup exactly
// (#C4B5FD). Used for the logo mark and its subtitle so the report opens
// on the same brand identity as the site.
const BRAND_CYAN: [number, number, number] = [196, 181, 253];

// Legal-mode flag controls whether the export labels itself "Attorney Work
// Product". When false (default), the report renders as a neutral analytical
// document with no privileged-work-product framing.
const LEGAL_MODE: boolean =
  (
    (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_LEGAL_MODE ?? "false"
  ).toLowerCase() === "true";

// PDF-safe text scrubber. jsPDF's bundled Helvetica is a WinAnsi (Latin-1)
// font; characters like Σ, ×, ≥, → render as garbage glyphs (e.g. "£("). We
// normalise to ASCII equivalents so reports never display corrupted math.
function pdfSafe(s: string): string {
  if (!s) return s;
  return (
    s
      .replace(/Σ/g, "sum")
      .replace(/×/g, "x")
      .replace(/÷/g, "/")
      .replace(/≥/g, ">=")
      .replace(/≤/g, "<=")
      .replace(/≠/g, "!=")
      .replace(/→/g, "->")
      .replace(/←/g, "<-")
      .replace(/–|—/g, "-")
      .replace(/“|”/g, '"')
      .replace(/‘|’/g, "'")
      .replace(/•/g, "*")
      .replace(/·/g, "-")
      // Normalize every other Unicode hyphen/dash/minus variant (hyphen
      // U+2010, non-breaking hyphen U+2011, figure dash U+2012, horizontal
      // bar U+2015, minus sign U+2212, etc.) to a plain ASCII hyphen BEFORE
      // the catch-all strip below deletes them. These aren't covered by the
      // em/en-dash replace above, so LLM prose using them for compound
      // terms — "chain‑of‑custody", "body‑camera", "three‑minute" — had the
      // separator character deleted outright with no replacement, silently
      // gluing the words into "chainofcustody", "bodycamera", "threeminute"
      // throughout the report.
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      // Drop any remaining non-Latin1 codepoints so jsPDF never emits the
      // currency-glyph fallback that produced the "£(" bug.
      .replace(/[^\x00-\xFF]/g, "")
  );
}

// Map a finding's text + evidence presence into the canonical PDF badge.
function classifyFindingForPdf(text: string, hasEvidence: boolean): string {
  const cls = classifyClaim(text, hasEvidence ? "fact" : null);
  return CLAIM_LABEL[cls];
}

// Defensive scrubber for malformed inline citations in upstream free-text
// prose (e.g. r.score_breakdown, r.executive_summary). A valid citation is
// always "[DOC <number> p.<number>]". Some report-writer passes have been
// observed to interpolate a qualitative label (e.g. "well-supported") into
// the document-id slot instead of an actual doc number, producing text like
// "...an appeal risk of well-supported [DOC well-supported p.2]." instead of
// "...an appeal risk of well-supported [DOC 1 p.2]." This is a pipeline bug
// upstream of export.ts (wherever that prose string is generated), not an
// export-layer bug — but export.ts is the last place that can guarantee a
// broken citation never reaches a printed PDF, so it is scrubbed here as a
// safety net. This is generic pattern-matching (any "[DOC <non-numeric>...]"
// citation), not hardcoded to this case or this specific label.
function scrubMalformedCitations(s: string): string {
  if (!s) return s;
  return (
    s
      // Drop only the invalid bracket itself — a citation whose "doc id" slot
      // does not start with a digit (e.g. "[DOC well-supported p.2]"). The
      // word(s) preceding the bracket are left untouched, since they are the
      // actual intended content (e.g. "well-supported" describing the appeal
      // risk) — only the bogus citation attached to them is malformed.
      .replace(/\s*\[DOC\s+(?!\d)[^\]]*\]/gi, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([.,;:])/g, "$1")
      .trim()
  );
}

// ===== Citation presentation =========================================
//
// Report prose (executive summary, facts, risk analysis, etc.) is generated
// with inline pinpoint citations like "[DOC 6 p.2; DOC 52 p.1]" so the
// hallucination-verification pass upstream can check every claim against a
// real source. That format is exactly right for verification and exactly
// wrong for a document an attorney is meant to read — "DOC 6" means nothing
// to them, and a citation bracket every sentence breaks the memorandum voice
// the rest of the report is trying for. This section resolves those
// brackets against the actual document titles and renders them either as
// numbered footnotes (attorney mode, default) collected into an "Evidence
// Sources" appendix, or as inline human-readable citations naming the real
// document and page (audit mode) — never as raw "DOC N".

export type CitationMode = "attorney" | "audit";

type CitationFootnote = { n: number; label: string };

// Ambient per-export state. Export functions are synchronous, single-user,
// and never re-entrant/interleaved (downloadPdf each run start
// to finish before another export can begin), so a module-level context —
// the same ambient pattern already used for AI user scope elsewhere in this
// codebase — is safe here and avoids threading a context object through
// every one of the ~30 render functions that touch report prose.
let _citationMode: CitationMode = "attorney";
let _docTitleMap: Map<number, string> = new Map();
let _docTitleByUuid: Map<string, string> = new Map();
let _footnotes: CitationFootnote[] = [];
let _footnoteByKey: Map<string, number> = new Map();

/** "04_Search_Warrant_Affidavit.txt" -> "Search Warrant Affidavit" */
function humanizeDocTitle(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]{1,6}$/i, "");
  const stripped = base.replace(/^\d+[_\-\s]*/, "");
  const words = (stripped || base).replace(/[_\-]+/g, " ").trim();
  return words || filename;
}

/** DOC N (1-indexed, same ordering used everywhere upstream: documents sorted by created_at) -> human title. */
function buildDocTitleMap(data: CaseExportData): Map<number, string> {
  const map = new Map<number, string>();
  data.documents.forEach((d, i) => {
    const name = asStr(d.filename);
    if (name) map.set(i + 1, humanizeDocTitle(name));
  });
  return map;
}

// Findings/evidence-intelligence rows carry a raw `document_id`/`doc_id` —
// the documents table's UUID primary key — as their pointer back to the
// source file, not the sequential "DOC N" index used in generated prose.
// Several render call sites fell back to printing that UUID directly (e.g.
// "Evidence: ... — a46fe542-88bf-4607-8d8b-d3e043aefded") whenever a
// human-readable filename wasn't already present on the row. Build the
// UUID -> title map once here so every such fallback resolves to the real
// document name instead of an opaque internal id.
function buildDocTitleByUuid(data: CaseExportData): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of data.documents) {
    const id = asStr(d.id);
    const name = asStr(d.filename);
    if (id && name) map.set(id, humanizeDocTitle(name));
  }
  return map;
}

/** Call once per export, before any section availability check or render runs. */
function initCitationContext(data: CaseExportData, mode: CitationMode): void {
  _citationMode = mode;
  _docTitleMap = buildDocTitleMap(data);
  _docTitleByUuid = buildDocTitleByUuid(data);
  _footnotes = [];
  _footnoteByKey = new Map();
}

function resolveDocTitle(docN: unknown): string | null {
  const n = Number(docN);
  if (!Number.isFinite(n)) return null;
  return _docTitleMap.get(n) ?? null;
}

/** Resolves a raw documents-table UUID to its human title. Never returns the UUID itself. */
function resolveDocTitleByUuid(id: unknown): string | null {
  const s = asStr(id);
  if (!s) return null;
  return _docTitleByUuid.get(s) ?? null;
}

/** Human label for a single (doc_n, page) pair used by structured citation objects — replaces raw "DOC N p.M". */
function citeLabel(docN: unknown, page: unknown): string {
  const title = resolveDocTitle(docN);
  const pg = asStr(page);
  const name = title ?? `Document ${asStr(docN)}`;
  return pg ? `${name}, p.${pg}` : name;
}

// Matches a full inline citation bracket: "[DOC 6 p.2; DOC 52 p.1]",
// "[DOC 17 p.1, DOC 19 p.1]", or a page-less "[DOC 5]" — both `,` and `;`
// separators appear in generated prose. Also tolerates a leaked
// "[DOC 6 p.1: \"verbatim quote\"]" variant — the model is instructed not to
// embed quotes inside the bracket (see MANDATORY CITATION RULE in
// pipeline.server.ts), but when it does anyway, this still needs to match
// the whole bracket so the embedded quote gets stripped here rather than
// silently passing through into the printed report (this is exactly what
// was inflating report length: the old regex didn't match this variant at
// all, so the bracket — quote included — fell straight through untouched).
const QUOTED_SUFFIX = /(?:\s*:\s*["“][^"”]{0,400}?["”])?/.source;
const CITATION_BRACKET = new RegExp(
  `\\[\\s*DOC\\s+\\d+(?:\\s*p\\.\\s*\\d+)?${QUOTED_SUFFIX}(?:\\s*[,;]\\s*DOC\\s+\\d+(?:\\s*p\\.\\s*\\d+)?${QUOTED_SUFFIX})*\\s*\\]`,
  "gi",
);
const CITATION_PAIR = /DOC\s+(\d+)(?:\s*p\.\s*(\d+))?/gi;

/** Registers (or reuses) a footnote for this exact set of doc/page refs and returns its number. */
function footnoteFor(refs: Array<{ docN: string; page: string }>): number {
  const key = refs.map((r) => `${r.docN}:${r.page}`).join("|");
  const existing = _footnoteByKey.get(key);
  if (existing) return existing;
  const label = refs.map((r) => citeLabel(r.docN, r.page || undefined)).join("; ");
  const n = _footnotes.length + 1;
  _footnotes.push({ n, label });
  _footnoteByKey.set(key, n);
  return n;
}

/**
 * Scrubs malformed citation artifacts, then transforms every valid inline
 * "[DOC N p.M]" bracket according to the active citation mode:
 *  - attorney (default): brackets are removed from the sentence and replaced
 *    with a numbered footnote marker; the resolved document title + page is
 *    collected into the shared footnote list for the Evidence Sources
 *    appendix.
 *  - audit: brackets are kept inline but rewritten to name the real document
 *    and page instead of an internal "DOC N" id.
 * This is the single funnel every prose-rendering call site should use in
 * place of the old bare scrubMalformedCitations.
 */
function processProseCitations(raw: string): string {
  const scrubbed = scrubMalformedCitations(raw);
  if (!scrubbed) return scrubbed;
  return scrubbed.replace(CITATION_BRACKET, (bracket) => {
    const refs: Array<{ docN: string; page: string }> = [];
    let m: RegExpExecArray | null;
    CITATION_PAIR.lastIndex = 0;
    while ((m = CITATION_PAIR.exec(bracket))) refs.push({ docN: m[1], page: m[2] ?? "" });
    if (!refs.length) return "";
    if (_citationMode === "audit") {
      return `[${refs.map((r) => citeLabel(r.docN, r.page || undefined)).join("; ")}]`;
    }
    const n = footnoteFor(refs);
    return `[${n}]`;
  });
}

/**
 * Runs every prose field that can carry inline citations through
 * processProseCitations once, purely for its footnote-collection side
 * effect, before the section plan/render queue is built. Without this,
 * whether the "Evidence Sources" section belongs in the queue would depend
 * on render order (some sections' `available()` checks call reportText and
 * would populate footnotes as a side effect during queue computation; others,
 * like the executive summary, only touch reportText during the later render
 * pass) — a real ordering hazard. Running every key up front makes footnote
 * population complete and order-independent before anything downstream
 * decides what to render. Safe to call multiple times: footnote assignment
 * is idempotent (deduped by exact doc/page set).
 */
function primeCitationFootnotes(data: CaseExportData): void {
  const r = asObj(data.report);
  const keys = [
    "executive_summary",
    "attorney_summary",
    "case_overview",
    "facts",
    "timeline_summary",
    "discovery_analysis",
    "missing_evidence_report",
    "risk_analysis",
    "score_breakdown",
    "recommendations",
  ];
  for (const k of keys) processProseCitations(asStr(r[k]));
}

export interface CaseExportData {
  case: Record<string, unknown> | null;
  documents: Array<Record<string, unknown>>;
  analysis: Record<string, unknown> | null;
  agents: Array<Record<string, unknown>>;
  score: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  findings?: Array<Record<string, unknown>>;
  theories?: Array<Record<string, unknown>>;
  opportunities?: Array<Record<string, unknown>>;
  witnesses?: Array<Record<string, unknown>>;
  trial_prep?: Record<string, unknown> | null;
  work_product?: Array<Record<string, unknown>>;
  perspectives?: Array<Record<string, unknown>>;
  evidence_intel?: Array<Record<string, unknown>>;
  strategy?: Array<Record<string, unknown>>;
  strategy_center?: Record<string, unknown> | null;
  agent_logs?: Array<Record<string, unknown>>;
  pipeline_runs?: Array<Record<string, unknown>>;
  // Completed Case Audit / Outcome Assessment (completed-case-audit.server.ts,
  // public.case_outcome_assessments) — a source-verified "second pair of
  // eyes" review that runs after the main pipeline for every
  // case_analysis_mode !== "ongoing". null when the case is in ongoing mode,
  // the audit hasn't run yet, or it failed non-fatally.
  outcome_assessment?: Record<string, unknown> | null;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(data: CaseExportData, name: string) {
  const { payload, diagnostic } = prepareCaseJsonExport(data, releaseFinalReportPayload);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const caseName = typeof data.case?.name === "string" ? data.case.name : name;
  saveBlob(blob, `${slug(caseName)}${diagnostic ? "-diagnostics" : ""}.json`);
}

// ===== PDF builder helpers ============================================
type Pdf = jsPDF & { lastAutoTable?: { finalY: number } };

// ---- Design tokens (report redesign) ---------------------------------
// Print-oriented palette: deep violet + amber accent on a soft
// lavender-white sheet. Deliberately not pure white / cool slate — the
// tinted paper tone is what makes the export read as a designed legal
// document rather than a browser printout.
const PAGE_BG: [number, number, number] = [249, 247, 253]; // soft lavender-white sheet
const PRIMARY: [number, number, number] = [91, 33, 182]; // deep violet (#5B21B6)
const PRIMARY_DEEP: [number, number, number] = [46, 20, 90]; // depth bands on the cover
const ACCENT: [number, number, number] = [217, 119, 6]; // amber, the gradient's warm terminus
const ACCENT_SOFT: [number, number, number] = [196, 181, 253]; // pale violet, for dark backgrounds
const INK: [number, number, number] = [28, 24, 48]; // near-black ink body text
const MUTED: [number, number, number] = [111, 107, 133]; // secondary text
const LINE: [number, number, number] = [234, 230, 245]; // hairlines on light bg
const SUCCESS: [number, number, number] = [39, 98, 66];
const DANGER: [number, number, number] = [155, 42, 42];
const HIGH: [number, number, number] = [176, 108, 34];
const MEDIUM: [number, number, number] = [150, 128, 34];
const QUOTE_BG: [number, number, number] = [244, 242, 251]; // evidence blockquote fill
const CARD_BG: [number, number, number] = [255, 255, 255]; // card fill pops on PAGE_BG
const CARD_BORDER: [number, number, number] = [230, 225, 242]; // card border

// Generic (non-case-type-specific) severity-tier grouping used to give
// Key Findings a visual hierarchy — critical items read as clearly more
// urgent than a minor discrepancy, instead of a flat list where every
// finding gets equal visual weight regardless of severity. Buckets are
// deliberately generic ("Critical" / "High-Priority" / etc.) rather than
// domain labels like "Constitutional Issues", because this report type
// runs across criminal, civil, family, employment, and other case types —
// a fixed domain-specific taxonomy would be wrong for most of them.
const SEVERITY_TIERS: Array<{ key: string; label: string; color: [number, number, number] }> = [
  { key: "critical", label: "Critical Issues", color: DANGER },
  { key: "high", label: "High-Priority Issues", color: HIGH },
  { key: "medium", label: "Moderate Issues", color: MEDIUM },
  { key: "low_info", label: "Minor & Administrative Issues", color: SUCCESS },
];

function severityTierKey(sev: string): string {
  const s = (sev || "").trim().toLowerCase();
  if (s === "critical") return "critical";
  if (s === "high") return "high";
  if (s === "medium") return "medium";
  return "low_info"; // low, info, unrecognized
}

// Confidence, expressed as a word instead of forcing the reader to parse
// a raw 0–1 decimal against an unstated scale.
function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "High";
  if (confidence >= 0.5) return "Medium";
  return "Low";
}

// "Evidence strength" is a distinct signal from model confidence: it asks
// how much of the case corpus actually backs the finding (source count),
// not just how sure the classifier was. A finding can carry high model
// confidence off a single document (still fragile — one bad document
// away from falling apart) or be backed by several independent sources
// (much harder to dislodge at a hearing). Combining both avoids either
// number overstating reliability on its own.
function evidenceStrengthLabel(
  confidence: number,
  sourceCount: number,
): { label: string; color: [number, number, number] } {
  if (confidence >= 0.85 && sourceCount >= 2) return { label: rt("Strong"), color: SUCCESS };
  if (confidence >= 0.6 && sourceCount >= 1) return { label: rt("Moderate"), color: ACCENT };
  return { label: rt("Limited"), color: DANGER };
}

// Distinct source documents actually cited in a finding's evidence_refs —
// count canonical IDs only; unresolved citations cannot add sources.
function findingSourceCount(refs: Array<Record<string, unknown>>): number {
  return canonicalSourceCount(refs);
}

function presentation(data: CaseExportData) {
  const view = (data as FinalReportPayload).report_presentation;
  if (!view) throw new Error("REPORT_CONTRACT_REQUIRED");
  return view;
}

function renderDecisionCore(b: PdfBuilder, data: CaseExportData) {
  for (const section of presentation(data).decision_sections) {
    b.h2(section.title);
    b.text(section.text, { size: 12, bold: true, gap: 5 });
    b.text(section.speaker_label + " · " + section.speaker_role, { size: 9, color: MUTED, gap: 5 });
  }
}

const NAVY_TINT: [number, number, number] = [46, 20, 90]; // deep violet band (#2E1059), matches --primary-deep
const SILVER: [number, number, number] = [196, 181, 253]; // pale violet ring (#C4B5FD), matches the mark's edge highlight
const SHIELD_DARK: [number, number, number] = [91, 33, 182]; // brand violet plate (#5B21B6), matches the app's hub badge
// Height reserved at the top of every page after the cover for the
// compact branded header (see PdfBuilder.header()). Every addPage() call
// only ever produces a continuation page (page 1 exists before any
// addPage() call), so content on those pages is laid out starting below
// this reserved band, and header() paints into that same band as a
// post-pass over every page — the same pattern footer() already uses.
const CONTINUATION_HEADER_H = 50;

// jsPDF has no letter-spacing control; inserting thin gaps between
// characters is the only way to get the tracked small-caps look used for
// kickers and eyebrow labels.
function spaced(v: string): string {
  return v.split("").join(" ");
}
function asStr(v: unknown, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}
function asArr(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}
function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
// Every canonical.ts helper (getScores, getAgentSummary, getEssState, etc.)
// takes the raw `reports` row. Centralize that extraction so every call
// site reads the exact same object — no per-function re-derivation.
function getReportRow(data: CaseExportData): Record<string, unknown> {
  return (data.report ?? {}) as Record<string, unknown>;
}

/**
 * Whether this report's cover/footer may claim "evidence-grounded,
 * citation-audited" language. Previously this text printed unconditionally
 * on every report regardless of mode or verification outcome — including a
 * confirmed production case with zero findings, a failed inner release
 * gate, and QA/Judge/Hallucination explicitly rejecting the run.
 *
 * Derived from data.agent_logs — the same 13-agent audit rows the pipeline
 * already writes (see agents/orchestrator.server.ts) — rather than from
 * report_mode alone, per the explicit requirement that FULL/LIMITED mode is
 * not sufficient on its own: a report can be nominally FULL while its
 * citation/QA/Judge/Hallucination gate still failed.
 *
 * Deliberately fail-closed: if agent_logs is absent, empty, or any of the
 * three verification agents didn't run/succeed, no certification claim is
 * made. Only an explicit, confirmed pass earns the language.
 */
export type CertificationState = "verified" | "unverified";

export function deriveCertificationState(data: CaseExportData): CertificationState {
  const logs = Array.isArray(data.agent_logs) ? data.agent_logs : [];
  const latestByKey = new Map<string, Record<string, unknown>>();
  for (const row of logs) {
    const key = asStr(row.agent_key);
    if (!key) continue;
    const existing = latestByKey.get(key);
    const existingTime = existing ? asStr(existing.started_at) : "";
    const rowTime = asStr(row.started_at);
    if (!existing || rowTime >= existingTime) latestByKey.set(key, row);
  }
  const requiredGates = ["qa", "judge", "hallucination"];
  const allPassed = requiredGates.every((key) => {
    const row = latestByKey.get(key);
    return !!row && asStr(row.status) === "success";
  });
  return allPassed ? "verified" : "unverified";
}

const CERTIFICATION_TAGLINE: Record<CertificationState, string> = {
  verified:
    "Evidence-grounded. Citation-audited. Built for sensitive legal intelligence workflows.",
  unverified: "Draft — citation verification not passed. Attorney review required before reliance.",
};

// Per-section eyebrow printed above each section title. Replaces the old
// hardcoded "NYRAVA INTELLIGENCE" kicker, which repeated the brand name on
// every single section and told the reader nothing. Any label not listed
// here falls back to the section title itself.
const SECTION_KICKERS: Record<string, string> = {
  Índice: "Contenido",
  Hechos: "Relato Fáctico",
  "Panorama General del Expediente": "Panorama del Expediente",
  "Inteligencia Jurisdiccional": "Jurisdicción",
  "Promociones Recomendadas": "Promociones",
  "Centro de Acción del Abogado": "Acción",
  "Panel de Impacto Litigioso": "Impacto",
  "Resumen Cronológico": "Cronología",
  "Análisis de Vacíos Probatorios": "Vacíos Probatorios",
  "Análisis de Riesgo": "Riesgo",
  Recomendaciones: "Recomendaciones",
  Contrainterrogatorio: "Interrogatorio",
  "Tablero de Puntuación del Caso": "Puntuación",
  "Mapa de Evidencia": "Evidencia",
  "Análisis de Contradicciones": "Contradicciones",
  "Análisis Multi-Perspectiva": "Multi-Agente",
  "Inteligencia Probatoria": "Evidencia",
  "Síntesis Estratégica": "Estrategia",
  "Producto de Trabajo del Abogado": "Producto de Trabajo",
  "Análisis Constitucional": "Constitucional",
  "Cuestiones Jurídicas y Jurisprudencia": "Cuestiones Jurídicas",
  "Inteligencia de Testigos": "Testigos",
  "Análisis de Teoría del Caso": "Teoría del Caso",
  "Centro de Estrategia Litigiosa": "Estrategia",
  "Oportunidades Estratégicas": "Oportunidades",
  "Cobertura Probatoria": "Cobertura",
  "Estadísticas de Agentes": "Agentes",
  "Registro de Auditoría": "Auditoría",
  "Anexo: Citas de Fuentes": "Anexo",
  "Fuentes de Evidencia": "Fuentes",
  "Centro de Acción — Recomendaciones Prioritarias": "Acción",
};

export class PdfBuilder {
  doc: Pdf;
  renderedText: string[] = [];
  finalPayload?: FinalReportPayload;
  // 0.75 inch margins (54pt) per professional memorandum standard.
  margin = 54;
  pageW: number;
  pageH: number;
  y: number;
  caseName: string;
  // Short matter/docket identifier shown right-aligned in the running
  // header band. Deliberately NOT the full case title — long Amparo
  // names clip at the page edge (Addendum 3, Bug 8).
  matterId: string;
  // The real crest image, loaded once via loadLogo() before any drawing
  // happens. Null until loaded, and stays null if the fetch failed —
  // logoMark()/trustBadge() fall back to the vector shield mark in that
  // case so a logo hiccup never blocks the whole export.
  logoBase64: string | null = null;
  // Track whether we've rendered ANY body content yet. Only the cover
  // page forces a hard break; after that, sections flow naturally.
  private firstSectionRendered = false;
  // page number -> section title that STARTS on that page. Used by
  // header() to decide, per page, whether the page already carries a full
  // section title or needs a lightweight continuation label instead
  // (Addendum 3, Bug 9 — no interior page without section identity).
  private sectionStarts = new Map<number, { title: string; y: number }>();
  // Title of the section currently being rendered, used to label pages a
  // section spills onto.
  private currentSection = "";

  constructor(caseName: string, matterId?: string) {
    this.matterId = matterId || caseName;
    // @ts-ignore
    const JSPDF = typeof jsPDF === "function" ? jsPDF : jsPDF.jsPDF;
    this.doc = new JSPDF({ unit: "pt", format: "letter" }) as Pdf;
    this.pageW = this.doc.internal.pageSize.getWidth();
    this.pageH = this.doc.internal.pageSize.getHeight();
    this.y = this.margin;
    this.caseName = caseName;
    // Wrap doc.text so EVERY string the PDF emits (including autoTable cells,
    // footers, splitTextToSize output) is ASCII-safe. This is the canonical
    // fix for the "£(" rendering bug — Unicode math symbols never reach the
    // Latin-1 Helvetica font. The same wrapper also runs the report template
    // translator (rt), so section headers, table headers, labels and page
    // stamps render in the report's language instead of hardcoded English.
    const prep = (s: string) => pdfSafe(rt(s));
    const origText = this.doc.text.bind(this.doc);
    (this.doc as unknown as { text: (...a: unknown[]) => unknown }).text = (
      text: unknown,
      ...rest: unknown[]
    ) => {
      const safe =
        typeof text === "string"
          ? prep(text)
          : Array.isArray(text)
            ? text.map((t) => (typeof t === "string" ? prep(t) : t))
            : text;
      this.renderedText.push(...(typeof safe === "string" ? [safe] : Array.isArray(safe) ? safe.filter((x): x is string => typeof x === "string") : []));
      return (origText as unknown as (...a: unknown[]) => unknown)(safe, ...rest);
    };
    const origSplit = this.doc.splitTextToSize.bind(this.doc);
    (this.doc as unknown as { splitTextToSize: (...a: unknown[]) => unknown }).splitTextToSize = (
      text: unknown,
      ...rest: unknown[]
    ) => {
      // Translate before measuring — otherwise wrapping/height math is done
      // against the English string and drifts from what is drawn.
      const safe = typeof text === "string" ? prep(text) : text;
      return (origSplit as unknown as (...a: unknown[]) => unknown)(safe, ...rest);
    };
    // Every page (including pages jspdf-autotable creates on its own mid-
    // table) gets the warm PAGE_BG sheet painted before any content lands
    // on it. Wrapping addPage is the only hook that catches all of them —
    // a post-pass would paint over the content instead of behind it.
    const origAddPage = this.doc.addPage.bind(this.doc);
    (this.doc as unknown as { addPage: (...a: unknown[]) => unknown }).addPage = (
      ...args: unknown[]
    ) => {
      const res = (origAddPage as unknown as (...a: unknown[]) => unknown)(...args);
      const fill = this.doc.getFillColor?.();
      this.doc.setFillColor(...PAGE_BG);
      this.doc.rect(0, 0, this.pageW, this.pageH, "F");
      if (fill) this.doc.setFillColor(fill);
      return res;
    };
  }

  /** Loads the real crest image once, before any drawing happens. Must be
   * awaited by the caller (downloadPdf) right after construction — every
   * other builder method stays synchronous because by the time they run,
   * this has already resolved. */
  async loadLogo() {
    this.logoBase64 = await getLogoBase64();
  }

  ensureSpace(needed: number) {
    if (this.y + needed > this.pageH - this.margin - 24) {
      this.doc.addPage();
      this.y = this.margin + CONTINUATION_HEADER_H;
    }
  }

  hr() {
    this.ensureSpace(12);
    this.doc.setDrawColor(...MUTED);
    this.doc.setLineWidth(0.5);
    this.doc.line(this.margin, this.y, this.pageW - this.margin, this.y);
    this.y += 8;
  }

  /**
   * Measures how many points a block of `text()` calls will take without
   * drawing anything — used by call sites that need to decide whether a
   * whole block (a footer note, a card, a list item) fits in the space
   * remaining BEFORE committing to draw any part of it. Mirrors the exact
   * font/size/width math `text()` uses so the estimate never drifts from
   * what actually gets rendered.
   */
  measureTextHeight(value: string, size = 10.5, gap = 0): number {
    if (!value) return 0;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(size);
    const lines = this.doc.splitTextToSize(value, this.pageW - this.margin * 2) as string[];
    return lines.length * (size * 1.55) + gap;
  }

  // Draws a raster crest image at its true aspect ratio if one was loaded.
  // Currently always a no-op — the report mark is drawn as a vector (see
  // logoMark() / trustBadge() below) so it can never drift from the
  // current brand palette — kept so a future raster asset can drop back in
  // without touching call sites.
  private drawCrest(cx: number, cy: number, drawH: number) {
    if (!this.logoBase64) return false;
    let aspect = 1;
    try {
      const img = this.doc.getImageProperties(this.logoBase64);
      if (img?.width && img?.height) aspect = img.width / img.height;
    } catch {
      aspect = 1;
    }
    const drawW = drawH * aspect;
    this.doc.addImage(this.logoBase64, "PNG", cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    return true;
  }

  // Small header/footer logo — the violet rounded-square "N" mark.
  logoMark(cx: number, cy: number, r: number) {
    const size = r * 2;
    const x = cx - r;
    const y = cy - r;
    if (this.drawCrest(cx, cy, size)) return;
    this.doc.setFillColor(...NAVY_TINT);
    this.doc.roundedRect(x, y, size, size, r * 0.3, r * 0.3, "F");
    this.doc.setDrawColor(...BRAND_CYAN);
    this.doc.setLineWidth(1);
    this.doc.roundedRect(x, y, size, size, r * 0.3, r * 0.3, "S");
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(r * 1.5);
    this.doc.setTextColor(255, 255, 255);
    this.doc.text("N", cx, cy + r * 0.5, { align: "center" });
  }

  // Large cover-page badge — the violet rounded-square "N" mark at cover
  // scale. (cx, cy) is the badge's center; `h` is its full height/width.
  trustBadge(cx: number, cy: number, h: number) {
    if (this.drawCrest(cx, cy, h)) return;

    const x0 = cx - h / 2;
    const y0 = cy - h / 2;
    const r = h * 0.22;

    this.doc.setFillColor(...SHIELD_DARK);
    this.doc.roundedRect(x0, y0, h, h, r, r, "F");
    this.doc.setDrawColor(...SILVER);
    this.doc.setLineWidth(Math.max(0.5, h * 0.03));
    this.doc.roundedRect(x0, y0, h, h, r, r, "S");

    // Illuminated "N".
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(h * 0.42);
    this.doc.setTextColor(255, 255, 255);
    this.doc.text("N", cx, cy + h * 0.12, { align: "center" });
  }

  // Full-bleed navy banner across the top of the cover page, with the
  // wordmark + report label reversed out in white/gold. Kept for legacy
  // callers; the primary cover now uses premiumCover().
  coverBanner(height: number) {
    this.doc.setFillColor(...PRIMARY);
    this.doc.rect(0, 0, this.pageW, height, "F");
    this.doc.setFillColor(...NAVY_TINT);
    this.doc.rect(0, height - 10, this.pageW, 10, "F");
    this.logoMark(this.margin + 14, height / 2 - 6, 15);
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(22);
    this.doc.setTextColor(255, 255, 255);
    this.doc.text("NYRAVA", this.margin + 40, height / 2 - 2);
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(9);
    this.doc.setTextColor(...BRAND_CYAN);
    this.doc.text("L E G A L   I N T E L L I G E N C E   O S", this.margin + 40, height / 2 + 14);
    this.y = height + 40;
  }

  // Full-page premium cover: dark bleed, centered trust badge, wordmark,
  // case title in a serif face, work-product tag, and a footer metadata
  // bar. Caller must pageBreak() before rendering anything else.
  premiumCover(opts: {
    reportTitle: string;
    caseName: string;
    client?: string;
    proceeding?: string;
    matterType?: string;
    court?: string;
    jurisdiction?: string;
    matterId?: string;
    classification?: string;
    date?: string;
    engineVersion?: string;
    certification?: string;
  }) {
    const { pageW, pageH, margin } = this;
    
    // Background: Deep purple (lightened slightly per feedback)
    const BG_PURPLE: [number, number, number] = [91, 33, 182]; 
    const GOLD: [number, number, number] = [217, 185, 120];
    const WHITE: [number, number, number] = [255, 255, 255];
    
    this.doc.setFillColor(...BG_PURPLE);
    this.doc.rect(0, 0, pageW, pageH, "F");

    // Lady Justice background
    const bgB64 = "data:image/jpeg;base64,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iXFDI7nGqlyiY3VybHgpc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5oYXNoLmRhdGFkaGFzaFggsqm5f9Jg+KDlyv6Abb9/37EsUXJ4obSxNhQ5T48kHZhpc2lnbmF0dXJleBlzZWxmI2p1bWJmPWMycGEuc2lnbmF0dXJlY2FsZ2ZzaGEyNTYAAAM2anVtYgAAAClqdW1kYzJhcwARABCAAACqADibcQNjMnBhLmFzc2VydGlvbnMAAAAAnGp1bWIAAAAoanVtZGNib3IAEQAQgAAAqgA4m3EDYzJwYS5oYXNoLmRhdGEAAAAAbGNib3KkamV4Y2x1c2lvbnOBomVzdGFydBRmbGVuZ3RoGRjJY2FsZ2ZzaGEyNTZkaGFzaFggKefNhMajbm4TBKlOqjvv8gaSJIs2MsPQmXjvq/PRRnpjcGFkTgAAAAAAAAAAAAAAAAAAAAAB+Gp1bWIAAAApanVtZGNib3IAEQAQgAAAqgA4m3EDYzJwYS5hY3Rpb25zLnYyAAAAAcdjYm9yoWdhY3Rpb25zgqRmYWN0aW9ubGMycGEuY3JlYXRlZGtkZXNjcmlwdGlvbnggQ3JlYXRlZCBieSBHb29nbGUgR2VuZXJhdGl2ZSBBSS5xZGlnaXRhbFNvdXJjZVR5cGV4Rmh0dHA6Ly9jdi5pcHRjLm9yZy9uZXdzY29kZXMvZGlnaXRhbHNvdXJjZXR5cGUvdHJhaW5lZEFsZ29yaXRobWljTWVkaWFqcGFyYW1ldGVyc6FraW5ncmVkaWVudHOBomN1cmx4LXNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuaW5ncmVkaWVudC52M2RoYXNoWCBDz0EFJn7uvMHSBBy3UTXMLwBhbHgn7YgnufvOe1g5lqNmYWN0aW9ua2MycGEuZWRpdGVka2Rlc2NyaXB0aW9ueChBcHBsaWVkIGltcGVyY2VwdGlibGUgU3ludGhJRCB3YXRlcm1hcmsucWRpZ2l0YWxTb3VyY2VUeXBleEZodHRwOi8vY3YuaXB0Yy5vcmcvbmV3c2NvZGVzL2RpZ2l0YWxzb3VyY2V0eXBlL3RyYWluZWRBbGdvcml0aG1pY01lZGlhAAAAcWp1bWIAAAAsanVtZGNib3IAEQAQgAAAqgA4m3EDYzJwYS5pbmdyZWRpZW50LnYzAAAAAD1jYm9yomxyZWxhdGlvbnNoaXBnaW5wdXRUb2tkZXNjcmlwdGlvbnJJbnB1dCBpbmdyZWRpZW50IDD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIBAAEAAMBIgACEQEDEQH/xAAeAAACAgMBAQEBAAAAAAAAAAACAwEEAAUGBwgJCv/EAD8QAQEAAwABBAICAgICAQAAFwECAxESIQQFEyIAMQYyI0EHQhQzUQgVUiRDYWIWU3FyFyU0gWOCCURzg7LC/8QAHAEAAwEBAQEBAQAAAAAAAAAAAAECAwQFBgcI/8QARBEAAgEDAwMCBAUEAQMDAgILAREhAjFBAFFhA3GBEpEEIqGxMsHR4fAFE0LxUiNicgYUgjOSosKyFUMkRFNj0uLyJf/aAAwDAQACEQMRAD8A/jrxOSamcmPzDPNBPAujd1Tpmq71czJsrUlRX5a4ZesUbuo7RMSTS9LFCarZE4ivG658zTpjUjjD4+iSStbkuvtF1lnxuifKlVQaY8NtVqZ+XvVyszj6N81cv+GjxLjKJ7ccJKqclbf6yA9ITB5KYgXhuFEC0nX6OB6QtrQArQfb9NHiWgGe2Y5HiJl8Roka18i0uO5WLoDW9bl/3XnJDQVZ8fWOckjzYSzzEtD1yT3NQsvIE+nqcWnLFTJ8k7oacWg+Ocj/AOwAh4iJmpbCpoYC+mLVSnWXTUzV84W68SoYisU874+1jsmWakKEgeoJ85iPybdxFtPkoWttFu+8PRJBkax45+sUVaTXyc5PtMrQVdSoZYBpHUzyn4ukqVZ5+PJMuLkapmUS5+16rfMZHWpOcpHPf5k/4wFnKUczc+frlk56ymj6otyHQV4mkehuqJm37zUmOhavHPZuczmK1NSOQa81MytdS6/CGY77C10LbibGDp+ntfayAeMf6jWTVVesmOjeWccU6C6nkDJWUO5oHdkz0kSm5WWVS5aklES9TyY6yH2yY/s2ZKqqHQm/EPmCmJ3VgHw1Ep8vySVdQ/bHNPd20pupI7ifiDqSqBxRjFmvrlr5QG6rF0LRWQPMYqiaQnynyD1ZQiGIlyYHjAv9ZidABO5HgZEON+eY1aDG4EyxVXVa7sknDVmhGgn4e6y+XGLe084qTEi9pUjjKHzj31Feex/v01C1OvmqeWYbl/FN8EP+K2omJTyd5PtGXJla+uTZZ0nfWqmXafmJ2Py0zkZPVHiWo0fTGUVFayHFajqmhqqF0A7Dk2hghkvmO8C2lERbObDJfv8A60uxxtOBLxuQ+U1OpXS3jrrokk5aRZ+Slmpafwo+Oj77x/cuJZw6qKA4qQFhpDFEbigol+0n4EDkd1e+n/yOG4ZI8jiejvYb/wAaaPMGlNZku753BjgYwyh8Z1qiKoprWIQk/rqZF+0CCSKYwDyrXkysoaSHd/tfeyuyp1cq+OarH+/8IuNpdlzOTUqzeyu9on7cdfcV8NRWSVGabr5fjlvJAOXChOq8oz50pr9VsC7y9kRcxRDOapkGpx8eZq3WXJf63yG13zWTtZDMTMn1XDMIS443VkzWSimQdn3nypo1OltslyE559Nt8YcB31XjZc2WJhfyNLjIsNfFXZ/gAkgQPFnT8saosq62wuqmqmkk84u11uyid46fkqJ6hmZVxNVEToTbp89fhzkrGlzOngwDPXLl2VjvJU3JYzputbds6reQQrcmKWybfjz/AL/rEmS2SwJ5gT48YkUNvVb7/ECMzBBKYZIHGNvfTCubbm2EMdlLwNN3RiHJC1qsTWMCFJ12VvuXa1lo1sZu4/stcbXKsJ8d2NhM8QAEf1oua+TwyT0NbP0/hZ6Mcd8rGWkuddc5Pjmvmj76idGSnp/XX95J2GOGa+co69VVZpAnUHx18cVyREx0M5Jpd6GTSAzdAzl5MASpLkQdI33Ij7BYeLbasV+pJZEmCZiS5yaaubadzJXxnakzqlHYn4H9GWIf8kmTbxzivI6Ms2VriUiQZX/sGpr8mMdzOVy6V3GJ5Lv4+YuLMhzJjf8AWjwU1OthMTmjIss/HnmfirEf4go1OyynuaqyqH7PK71y0rrDNiO0zDVoytzoACx+0ID6hgfTWVNkDA2JEsoVpytZJflx6J6/rLqmC+uXHWvyZ7+TI0AV0YWfjJoyTFRiK3PU154SSinke1PzMMTjnHOOwrFLk20tXpOp1QFyXE6NSVqp8cv4ujy6Pl3li4fO5x3GycmSOpI8VuYHlZqfoqPAOdrIqYR3cReLnQMEhW2Oz/fDhaLJlMUwVjSrDH2z9apTm6u3hnZb2RvcFRGotoa1zK+NVjiTnHqx3ZdUdRJenumSKN0Tt0RjucrkuacfEXOWLQy1UMVz/k3JMUgNcUEsanRaePklh3lMnnErUUY6lxyZc741Cgxyp01FbX8QByfxUwQptdI2lFWytMB7SItP4dvfL2emmPoprnGMqw/G7yURVXJw+CaOZ6KoCOnw/lSbCqmtTeMqJpJg4OJlZtVnJVu70bp5rVz02mZxTEY6McmMr7Vqckmyu6r+10klEEjJz1tdVVbJrHkCpmb0mOe8ASMpTd3csGppfrwL1upZ/wDxBAj2LsPtDG0Ky8blP0n+R3xpretRMl0yy3PNVMNGs2TIVqZnIVzVwaNZEQGjg1j7DZGObr7YlErbNf8AxNdbiR8upQNaRi/s5ZcjZNVuuqtnxcxUxk5iDU1U14lya3xySWZgmIyc2VrkCqgaOMeOqeZIn7Lj4rJ9ev8A7YsW4pPEBWndSxvfSXbYR2YFuLxebabOSKjFknghkaxtA3wPco9VPZbUfd3Br7gaRkvHUjcpxqJ1EGOcrNSTT9o2qjkhPOO5dXGxbWTHjiMeQ5OYb0k4oyTKV8wMeOaiQhImtTjko6ZiImKncs5KfjGQqG/qd5DkxmPIVj/WhrqRpNy3BSyywUKZjMZyxp3GAY+4Y3WbXHtJlu81lQSR/wBnnmnHEgVdc/J8m7mXmfkZmdzQv4VzcnVR1N6oJPjMM2CvYVXMcP3qGNJk62UUq8eVvK5K1qnXgfpgKlxVWXm8hQyjpLXmkQ/GOVw4MbSO5Jaem4x3Mp3TUHWMmtn7Rl1oX8dIuMcqXZAg/lbJ0wJQcjjYH+W741GWaFrUzHy6YpjGMfbpdFdRp/voN76kmlMlx5dFdSx0QE8Y2pEroyKvYu7T+spfOSZpOrmipJrsxXjZEPmZ1/k67UEdnj71OhXVSrHWeX/0NOjHNy1q/kidbaY+SKVoydTvWMZtKn8QAcn8Um6xslkzAYepQwnA7WOIEbnwMNpn0/wy1I5DhrW9l8acmShnVk5IaZnqZNTuelNauckRzMQ9VD+q4DuSUrqFut3JP1niv1L+PueuW66PiJgqZyc2if4+H6zCIb8k2ZBN9flWqlJMRU64lsmeq63TeR6vkVDJSdUKaCFoqFgAEwAzaKYzA/JuzfpFltHdIKbeMFyNGTeLVFxkxXc0xVyWNVPPNBD8s+JmeE6yFtO0G7ay7YSIAkCZhrGhq25leumTUmzUsyhpXM5skrS8tZP79RP9VwnMan970a8Pkdxt1s42jKNxVTrLwtxVSBFfI/YndbodnJpeQt/LbDBAO+cFSfcG2BCCd/08Yjkezbx4ZmJdyjjupHFqKqgssoknHRrqdNzMKpJ1+VbujlsZuMpjk1MzXBQVfYrGV8uROWhKgudtm6q5+ODk1OBvGbLsOZqjWTcIo3IVag6BBa21GMwkRhjukN1WTFM4+istK+ZWa4Pk0jJy1+UbcRGMIn/xAulbtqowLgZs1+q2XMCC7jDJEGRokcm9zinJoKqwNfHXZEsLO/ko8cksQAXfNzMZdriZpa3UVJrxlqp4l8vkUqjQXsrcLkMo1voKxKy8klk1xkA51yuQSkblcGiYl3a473X95KyJeOryajR2HH9R8CFIK93YXlfhNoJZB9lpAACLWewj9wgWdJpq/wBGwyRNCRBZO5aqa3S3TpNatm5Zm53+CVDkXJjqptqS9uOZz2SLNTy/H9VmmauU3P2ipo8mWfBMm+Yw74SZpZ4yVfX9g83evDp0i6jJjrc7JtYMewEfqOPI327arZO0q0Hl68CBsWYOLhW3Ks2oLGUpCex8mR4tNngHU2cEVOq2GM/7cdW19WAAg3NXUjPmkoakUVLm+PGVV6+almZnHfTPNXTxWInY/HFAjz43yzG0VTWb5t9t985OI1NSPOqL6daJmcbVVLvIqOTJlbjWQiIqY4RmLXnqdVvuHHM/HLY5OXUMqVNQAEwAUoMIbkqy7KNBG2O4sB2iUO6SjRa16XH4qmKcps5y7IKeiw3iHoGY3ta/6I4Vok4KrMxRkr7UVWqmszKTNY6iqvRVvY8bN1mTOXzjx+KljHv4tRVDwCVX1mi6hrkWv8W+dP5Hj/yOupDjRNzRilm1Jxboka5/xMo+MivP1UCBAKikYWG297r7vS9NoHe9tsw7h503l7opm/lm6nJLKyZdIKc43VJrHz1vJNTU7Z/K2bl+PH8n2UmUkoudjrK7sCmwyJE9RF7/AFNDCvkaYpMgk31zjq5CO8cSFFnTJMOqN0Oz7VMSR3aC11ON07h6jkL/AMZGJQB0gvHg0LbCAQsyIUMRE3OO60IG0YJ/gjy2LjUTT/1nf/2PYBLfg+a6VRN21kCKK80DuUQazNTzqfTtEP1kvtf8KyTTFVKbqpDxXfjWZCuy8aZKqaVJl5vbkSK2Tv6EsI6v7PZtYnpiOWrepHFtMvw5DTirIXJqWeSYKIPtUVFJKN1ULFzvHBEGcwMW0ekbbbcY25tASOonFrNFTYnNNxfxu/sZCDjzupWXGMsy2S6t/Dyri/uai/FUTpC6+otH/r4G5qRZXZtm5QLmCQr45iTKSsU/TckQTNBbAFn/AGmXfPgB6y5BrKF138ZkZaIjwRlbtne9Vq5k6UWGtv4gQLFPxikZ3QGAOx0IBDMFWAgRcALKsYsdM6KvwnOLG1zTBWapYLuit9zQTBxclvE6nykZVuI+Mma3iC+iZsop+013UzYhV+IyGo+u4WXGuia7ar5ihgKlO+aywkvbOuCZKO5f7GlE6yNMtjiu9PNfGVrTiyTZ1jx2SSBJVU8gi/jAud4MgbLBsrCyxlIR9Y29KUESB7rvoL4gipmq1UlBzcEUlUXRKhVj/wDdRE7BDQVXFf4+2GKUrgkLkmfjStru3dVEs/IarVfb8K9Y+WbnI3AKSZGauqqc3X+MKjnehajf1+ofg0Uwbhmaw/a5nTd80k5FWzIlUZGN0jjArYTG64dmbRC78c6SDtxhYUfqdo0JWPxvnHzj6jqYooaWSvu01kedgyZAZ+t15VsG2UI/8jSsz3A7KGFH4kSZee/7Gj7DMY3JNMHNRZdY7uWlNfJPNwrAs6nqXcsVzz1+DNQ1UZB/szOREkybmILclapPuzYFmv8A6uXcTcqf2HN2BADwVqEgChbbECcBlY/+WdN6x5AIZisdRF4qCKpmTcM5N/JN1REFJVKY6/c2VnVzIVMcnVnmZuoUuYMg/IVVT1f1b1UUlTsm95dBGt5SGvtilyMsXWTQ9Y68RVbkeTRsdFU/DGOA+Ov/AElIJUV4LyZHZqrHf184wD6lUySMgIwSr2IiJd5z20KZHZf/ABhvZZQe8ay11j5nZvHGWtEnFA+WuzvuWrs/rWuh6r8Kb1rqTZrFrwRKaItt8gpYZCRdM66mq/FmTm8eEvnWHVZXo20TMTVWtNZbKHJzS658VO1ieJrUu8Z9uVPAVOVqaR5vUtD1SH62/iBv6cLlwCxvmTbutJOxdozYd/OAtTvH15rQ183Osbvr9YQWSxWSCSd+QZU5St21vG8mQGuTqyI83c1SuOuUtnQICFRkpH48lOSPtSJmx3r+2E+syUG0pJJkxyLufD5/Mt5w48ieAnGuu7cfBd210PUys32Gof1kfsoTNoffA+/8ekRbgblKEosfC+mh3OSWy5mZrtx3zBTonLPL3VzujQ0dV9PH0qSb87Uk5YFCJqk5nJXW65sU6AUE+qyqqYyc401E/Z5DHFGPmbONFcBsyb/+pZ1KypXlxcjc15JxzczUrU6Jvu9dSpUmSVy6hkN438XsA5OCQvY2AwCxzpYt7icezg4+2nYssVPBck0q7DmiuGvT93voqqnX6N9RTF1tj1F9EdTyQxDfiJq5l/uZVYK2CvlUnn6/izGDL9fvePJ3vfPyH9cuXnxj8a5mdjsD/t+TaErl/wAuO3bZqnF0eZcl6nUaybg2xoZ8mqRgEfXFwM75d5aekuLD6R4Dtyx20GOuoL5S90HVRJHXN9aqT/GZB08lFak/ov4VY65Jx5McXQX081udR9RoSrWWZ0xPFXHS+Qav7xJ9Q5xqSTLc88TVKlRpCuDTxI/rbLkyRPRUUNfWuasxxeqivlj6kTRWo51PLuVTSFgDiGITXmWA0xxfQhiIjBxHdDNlo2Ka7xVOOZw6yDOoywV4ZftqqkmG+pSqdeGX8TREB1QuzIJwrla1y/0Jnb+uHmhorlJGxVb/ALTTxVlPJXL4cYsktgOo48bf0AKcrktxNfVqcZOg1OOrOpyeKqct6jfgbdS/uaEQI2MybEgYYAaefOoI9ircC4HjBJT31kxSJ+k7WqPCV+sa0PU0655mS9MOtdfmCaz7nZjKenYxjOINtHNyUJuYgm5XRwH4U5ACnF/r4RNzdW65pqr3ul0ZGe/qeOpeq9ZLgq9b+a9dIdYjISpVCTMzJRxTVSffSVyyV5RatI4AzwQXdaCogDfvBQhe8KAb6Y2wTrVNBufqkVl5WjIIQUykD5Og5ds/ili6yVcMk1TFJExIM8zRqS42qoffll/r+QRjvYmTgaWqZapxgzjr7a+M6TePRrURtJ/GVXGOHkO8c4Z0BSUeGqqq5fGnoaPraNFfmd72yOYXdu0jWZHFncYK+/dfnDtrHUH0/wAM2nCVQPnytGKpN1UshSAMyn5PQbGOZJqeXnVHU1k1SdO1SPBsGf0bpOO/BWWfjwkmILW6u4JRjsExT4eoN8jJVJ+Tnrox8khvDJWuCk2zTy9TP9daPuHKCCJ5p3sfAKiJPvOjb9OzX00LTWUuT5BxO5SSYvpYs+25nrRjamv3qhgZ/CZmTksHRmGvj8L08tedj9DHCDel6GhB4s7vLlNSJjNRb8YDKojbTJJqaJn7a2GgiWcP22/J9ykaolh4iqompmPr1ufq+R3yMbhZbsrDMsxkj2B1mi3FrrMWMQu4PuNG5JiZ3wNTMbd2avVGW7rROtWb1+gQfKqY+TqTc89u7oBVBjyvfWWkGCCuXH/eB/Dx5DVXSPfcE3usk0koBXPOMoZF/UuRnnhfwWkBqjvLUz8hI/XJM/e8nNB5KmWZUmtyCKw9xEkD2COCTtn66REM4/xiSgPTm2wBbpROhxHe6BpkyLchFTDMlTJfi5OmS+RXceEZSdcgagJ6RqWclGvqC1XV1RLM6/XxiUdfk3kMVRueypJSYJ5V+tFSgVkBdn2nzfC/RrlVduSxo1ePESnAtjjmKZgZqngs35OcbD1tuEJJvsN/cYmE+EYQCw+yFg04GSD4gsi0ERrrQDomUD9fbbTdcymo+TzLyvRPFXEw84yYlqlIKoABK3T3afvj5GWEl0rA+LnSNVjiGv7MZHXFXk8aAlOddn7PDv8AFVlmKxxsclYttnNEpBcXlp20/WtEm9SHhFULj1JFAjDBiFOY50vTmR+F4AMGGAW2UYtgagClmdO920pM2PKzPRbXdH1QOyWfrQKu22vMkxPJs56yXGj5aclbqLm02a6tiSR3+F04IPPSskXpeKrnnrJ48TUU0aGEdSu/yHDbquuqmfk/t9aj+9RVv9tiamTSPPQEozjjlaWN/YX9PcyY5hZ1M3zihuGMk1Jz40dBy0ZN3pSmtghJNEs9Mb40PKuqmgbTpKmm9EfHjopPqgB9XbqcnXW3JL/if8ekBNwcdo1k3pa2o9n9NbzGHK5GLaxIFSt6UDFDqdWa3qfG1Zf9EkljgTa0Pb+Oy0LiYHsRJtyfyA0FfTGqzuuWb0Ju7lcfWieCZetTrnVDp5/G1ylFLIa52xzdAb8W/ZylaanXyadk0j+AOKtdFIwQ0ks/IxskpWeTaifeex1s05kaJx1w0czOp8eCaJ6yP26mg+TwIGwLj8EByLEHjzG5HnSgQLZF7499hdJQya+PHG5OvBFBNStSacl1remXbx50ST0fgYwfk/WmLrbrf35+pTorUviZASiSprf5A5KiKbiqJlrUzdED4nrl3UM6S45qrG686/MJ+PDrryk1K7KVTWNug5YQeQCUvyePyf8AisCXEkAT/JFtBYXafKWRFireVrJ5oag8EaQdPQG3kLsdMkXvpAmg1KwEQ7tmivtM+Kmd1BxsJnGSiUu9b3P9fMhqu+ipiJZlAxyDOpRZMwYyUdbaRP7A5CNX3QCWQ1M6YpnmZa3ru91L42KPNafw55gFD/iSQHCvc+S2AWiFhNfLvLG08yNY38cyunmTUs19TvrZQSESNDZ5nmhEdJY7ZJ3G/ml6UlJyZE1U3KBEs15qXTtg+uvwWn+1Qnh9PSSb/wCm/wD2bUVTupmnW2Oo5uOXw6Mk0Bj/AHrGXW5GzU43FzRUsv73ua/FIzYbSLO4iMowd3qfqcKP+INwVz3W6bfxxWM8fZ8zRGt1cJ3k8AL3Op1qZQ+p1+Iu8cOqPLWz6/1qjwdJM8m6QJ6OWjyfhFOSqKh23Ud1+y60A97WJqq0gHmZPJW4yn+SNsnMNf1Qq8T0s0yl28bbENTkE6J0lsgPUNuHe8Lgc30LMIqCM5X/AOGGph6zIUE/p6nEPDKMKPXRLTX/AFyVMkm+tn2FTTOWZA1jkb65Cn6xYdab3pVPjK1W9c/h1SMHz76gKNOOCAN4np19qlJI1LTe62y/k5D64vAb+OUkInmiw6yPQNJrxubP/jzoqFjTEgpTBEAIPwTgorQadjb8lCXaZ8xrJ+PLiH/UjfNVMo63X0R6x01IPRvlBDz+SB5k/qxWU3z4lQMd0A/o1Mk+K3M0Vt/Mx3W2Pi4I3rUkxfABMmR6Oq2OMme2PjOWK/IzSzBfWxuaBmn6UreNoJmZkCr5nnzSqakjDAtcmLJlmbGD4nLQqEK3pdjYX4ie97aiuakcpR0k4wjmd8gZbb2pX3oQ6oOmWpH8y5uoCdTomqTk6x8gx3Xm2q3/AFkMizNaTf5nyV+2eXxiVSlTXOSqvdaKn98lIAvhfzKKrwrStVKaDnQgsvjGuv6hKblnpa/Ehmccyof2jbygCtrmJeyngYGFqIWZC45YfilJkgVkOu/KU9LUkr4OSh2IyV9kJkaoeb6roK5HiqnTpT9yGOT9Lj1SeXf1kWvrWPUmtq5HtrnRoufogy05qnLzpOJQ/wDuqjWhb6Xf6jR9mZ8dQP4jCnIC3txKSxjlyGfHLgWEdvzuQzN1ijJJ4oZD66itjtHbCD//AAzUBvSfip+mRd7p65UNnXIDVsy6rrYDtK41RRLtcxHWQu0NDIY4k+M1R9e634KB7dk6rf4u8pV1SeDWKVkK+RfNjVOhooFF6l15EX6V6bNCDyA2nBECLsXWmA/zt/E3JZKvOg7+h8M9JuatHWPYX3WSWjqdU+ZAGGx8fkhEaIo846oaMexU63po0+Ymf2a56N7/ACZrWV0u8mOitrMGSrB68Ecv6ACuh1QKK8rMi+O8tMw19j/JrVOT6yQfYDWvKmn9QiwciNggRAwz+0aCOLKwHB5lb9jLGmteSJZH4vtTPh3rxuvNN+ZCQMiJ48tBVGuZPEgV48Xkk2C0K97ZUn7UTMzqd/kF2RSQLNfHkrn71Gp6oaqWk5XvWvPxsdbfwp86okZ5MeiQv5Sdhb5ZqBJ7XarWmRfxVfpB2heSBP8ABo9IftbwHmFI9o0uJyr3U8hO5/W9yAVfZ+sm6jWzbo5mgEyhgJOVZx0OvPkXxW6JK+rRpE4ZUaW9/wC0TKBhqPqPToL6XrQ7Oqdmv06mhddBK/QSIpn6lX1oa6r9Vyy0crbp/XlLlu7F/pJnuuStKAvFg/VFJSi3PhnS4Zm27281/U1JP2naOpSTbEVLsT+vj8OiQKP+zNxOsbxdIzLrQQyAB1uo1LpkBvtN8ccM403ppN6Xrqqn/wCdE9JOxTbNfXHIUAknQc6aRndPkJ0lUC63MyaNoR227qTvZzB2Oko7bCLCGfFouiTGsx0VFok9FNNaKqkmWSWBYqq8KTbRwIqo7myt7OPM+ALuQmmh2/a/1Wt0wlRNBf5NDBL/AH1A6iaOtAzRf/2jc915Xai00Bjq/j8mm6K6mfOl1JbfJzL9R193ymtKGyILQe0cLckjzc3AB/JGOQuXAmXqWQ5JT+vetiVHI8NPnI2y6STsnRXX2/Dp3BoDbElBqUP3vvpZpedmm9ccj9wNfUdspk1Y2/JcEzF8lT0Sryc+K3yk8tfmLU/apfH+MfCc+OLqqVTc+a5KeTQf7YJxmDYMFC68DGgDiPrKScSieA9F06HnXJ50aGp15ejpLXW9S0nPI+RKHU31MhDSIMUNLqX69eHQAHIyLs/GMqoXoZ6L3/pTcNutjM7CR/3Bp/ScdTUZBdcOtqi8TMsHS0yu2N6b55eeR/Fc289kcfpvvIreDziwzmDtzIi/penJomnWp6qSRUmY1UrUyOtKIifkWs6mBtBLTQ0cmjp+29my410ygFSH4fWqHjxyQDO1yf6yNW88i0d0FIVo8LQZVrGdSv8A1vgPkrmEU392inlyGlWZ0eK/JguyDHhjsl+iOkRGwiMR6R9Xt2L16dhq/sMuOE11T11dEzO6zc6C1TJj1Q/U5ydqV0VzwxOgUmJ3kuIvnjqaMhQ67UMgVCaktG8cUTKGyB6mtzYdLLk21bk1rcB0STWrgv8AMMjIfHFEIYqsclvnW2J2MTi8R4+06ieXka+tHNyrbhKIW1+MPXu0v9UrxtbZLTsGTjHBkmpyXJM7QdZJOJi6ZY0/JrrGVR0ZDuZazIdsDkI5nHmfBMUzvqaKGst2KLPM5ImpHzOgyN1U6/xjinVTE2ZaOjHt7r75H7Xyncage65/CxqY7Kiu46wvWqyUkx9fL1xLNMZDjmfFGyWqO2wi0oCDsImz330izcCcWp/RYw86xvY1+g4K+tnk3RmMd1qDanfnj7DjIIkTk0V3G8k5chTVJNY7r+2O6x1cJjJr/Gn1HuNz/U8T2sZMes2K/wB8wFOIkNuWuree0oT5JOK1UtfklxeeYJMdFK6Jx47qL1xq6f8AG9Xp5BesJpgfxQVIZsNkoVkGcZCZuHa1v4d+DJPLGoyFyd6qzqch/VqYUQ+XGUBFAc88SW8fV1+D3l7nLj2/X4smNHVD9iofoUzC4+q2zkZ6Lirmssx1OjJlxFUW5DHbufr1j6ip7iXzJyFBkiQ89DMxcBH0ceTHjoPjxbY2aN01OSzUmuSj5J0DDSyL4MF7XQlvs9IFFYjtC8o9jYRnTWYrHkxXWWbu0hKmchrRhLe+XD1oEk/fE87Rkx48UxKVJEwxRRv5BZneVpajIpxqWfCeTX4NTB8dDMOmyT7FYel+Kjjpr9AL9pl2nO0misdc1x+rNGq3IVPRU1RFdSaFNnnRz+MRCDAGbRgnckXgzDu5ZmwSGwIgFBHZCT41HqC4JyachzjLkXmZ62X1EqsRIt283NTY1FIZ8m9NRU+JxVvG/OIQdSta3JWmq3dHkdfuJtnFo7OqTquryTgufCk+dRIvRT/bfAJ+Q3NWx042Dmv1BmrD1uq6qmqqf3FEt0ZMdaWOkEOGn+3a24ICc6EljOzWGdjhMbnTcsY+p+TDt5MVUyhOah38tLU3Ni/Jo7f9nUTsMRw1jKm2/MOu6MNBUayLIMVP1lCT7Exv6/mYaq4LiYKmSah30s/b5YxZL80OuDpdrFzp7/DI+WshktZKyX8lBCmgMOq2cVtAiQSbmVyPluxp+gTDEWd+PqxovY3vYgtcbr8L9rrwfFmKeqJMhWTvktrR1HGkcW6Tccod45N6r8Krtxxw9Y6zuPHcU21ieoqGp5MR/Yx/vQ754alZeNJ1hywNndzEgVBjJKlC0rJskFCtvnVKKw4xmYGr1JkKoIjISRDFYr1Lzyug1S68L8iIiCFZx2eWYJaWdMT+peE1M7Cx52HDjwLkIx1XPSzk5xHiI1GMJqLrE0sp9Zs/RzM/k+RrVOxuXalsy1YxFyE6qgKB29Ro8v4fyKA5JxT8bVBJi+QcemT+z9/r1VMzcSzo3v8AI9TDWPGxcSpjnmfpjZ26bo+xTUzjqXxQoFH9TAAAgTsY4MrORCGp/nccz9vvo4x43HM/WfHy7rId1IeMVGk68FXCn2p+wM8r0bf3MVTmGmHs2S4wSmFhCxXnx9ZdabGMl4nJdTVVRjExRIBRM3LraEgBu9V1Nd6/K+fDGEq8WVKtaySOLhxPNOENT1qgNaWeuJf3MhCpsQRBsNp9wNpvnQbC1xnMZtdeUI028jkyOGeT4caUwElESahHv5Zoo+SpASSaTTdFWMwxTVTc5adHmjCWfWas4mZxs5HljoP8kSsp+IiP8pl+T/o5NVWjbQfGPJ0ckjhKCdUS1L5sZ80V6dNgM48ZPxkzkU3GSRWJdlDa7Ft5JdrB9VJNSCgWgbJSbomGTvpqMbDnOR7kkKx20i8pObkTRxFcw8/IzzNXW/8AJDpm60lJ1zTOmxdZPj+TBXy0SFx5qJX7tDj1qoQJ6P0x2sO2v8WVpbwQ0VX3VPKzzeS8hzc9bJt0v1lDlr8KRK+zwL8i3ZNVKS3JHJFY9v6PKSzAPn8KSXIYkwxkE7GHMT9NGDmcWQMj/wDRnOipdVhyjOWLl+ToiM0aiEvIktFd63MzFSaSbk6r1OOpKvrUXWLGOiaejmX5V3v+tIEMYw+qfU6ucxMMhOOhyeXTU8Y1qEqviZokPq3Xjma8/ljFfp5LnNNFVksKoLqKScZjWydzuvFSNTqpr7RpIqTzv4vZGbtFwgUWZssn7R3taMDLr4D4/UZZZ/c5K+/XOOWpGZTmc0+KqJkHZqTr9w5DJslnUg5J1z1UXJeWYqa3z1ROud+ZeJJVvqmeZxFEpXwVkmE47n+zlNu3qy6xy1RVeNu/ytWMnGV4+2WaORnHxbLLlyT/ANip+yD1IzUj5/FVwozaQgPZi6KzOlKH1MPE3ghxZDU4rd01T0UxTcV9jxdZGDwM3uq0TU/7kNttmGvl9TNTxmv4iqx1VzP0qep4/wAeNT7cjN9ZKj9fVVymrknKtSp8ZcMWvNZkvfZO5ul6+/SM9jZx5pAjJPiecU04wMWWKDGvWUMmh3FnVIMI1/7FSzeRYM/xng/ZaBN3PIki3bIn8nqM0RcybnZE0LU6qIrzjpqe6bOZrGLNMsBLpQftzMjExEjil1WSpeay85F+rNVyjsAHn/eXXkqqK3lk60czNnUz8sTx8TW9xEqGqDyP5HqBnFNi1ATGtqONJe3L9v6k3NtHJsKE6PwJM2eVBHZWAOBngrRuiFi/Eq4P5PtpPpcpEc2rkm2evjrumg6mrrZczUHT5Pj6f2DVnHigwV/kP7GSKFXRBUw2+YcX1V0een67PxcHA1iOxpy3heamPAtY651iySnCVL91HqfDmGq/zVksGnIzj/VR/UHH0TMnQTeh2zSb1r8dKCBwIwMTeZtN5MaUAgkbcbW74LnTr5jMaqC/gR5qp2SqVOWXd1Wiq1+/upyTKjJMYe80yuTLQuuqbb5omajieceSN/qvG07mQkimp6lY1Df94rIKSOIAuOOdMOgmKf8AWtZj0FW5DT1WLwZMmLHMzcya8Y6ik8M/WW6E3INAwN8hAWw43RQ7rTuQr8+J/azgPUz8Uo48uWOhzCmOjJjXrJhqYeneg46ZgbnoLNzlYkcniMdY6sCS1GlhEqaMx0sT10dL15rleWJxayY/PVz2TfQy85OvlnxGqlDuFDwFS6x5lfT3iJyKtuOgCWp67WHykRBsudNjPQGpPxbtAjOGhxfgAPONBLb/AIYtjHtnTcFGdtvEx8f9jKVHdQT9qae72tHMk7iGa3kxdUWV7yMhtx4/q7J6qUpeqru/sBHgK4Zs6k/Bw3U9AFd1fBe0kkCbMtXulIuZx2DWTwTu1Zi+nJWt0VlfkqOck6YSm1B8i40GV3Kyg/lwgLzcw2vpIH6W06TYixPGVwDZQiO2FOsmT5c3kLPjXVY9rCSS/Zx0q/pqnUeXz+Pp+aGCg0/Urx1y/aebarIZNnAJ4lKJyT3+Lawysl1XyV18jj2zeTmo+TLupZN1WodmljZ4G2zHNN6SZmagfs3y4rcqgWqq+H6b8L9ZFz384gsliV430AMoC4uxxBn8jMgWGlVEY60ynyXWSf6UY9GNnaLP/j90SCTzsN30IGPDNdzJqiqtKdVk41ziKQMgf2EDcjPRTNIfHjcnU9xWzPWWPLAVq8SfXvHJO9HVPFg6WQ+icbaIKzmidTrut/NONY8VAnlB3o8J+AV7bSf+0ufuoSPAPljZbK8fSHiMoB0EmWbA293UNcwh8VOKOYj5Z+xo6Aeo+w8icnMNzasVlZnMDDP6nGVkpa4k7qbjdRRdRSlCTe4JQklnEcDM0rMplBaIqbYeZFU6jp2BnqpiWpJ+sYZKOtMrrLVVfjipvdUFIDwjZ+Imkgp4W+BYHKF595W8bSXlQbXvcgWGCWfFiyXJWMyLgDqdEy3QOS6WjJS0WVOr3JR/V3mMIxE0zHI4J8bap/o/JX11XkMmoZjWzcixh896yTTDbvJD2ckOoPJvHf8A9R/h/uaVGQydcXzl7DnNjpMdMxO5MN9M8DOv8X6a3O9rqbiBPEKwzczF2SJhaJhZhzEBefyMbaPKTMNXcSPxVXPgyLemav8Av8tdBdEgyUePqSF4xJJ4mpjHlHqXqIN8PRunJLIspNn1NMS/mPVQ95GaxvUTUGW/ixb1hsYiucvmpQYoPsxXChXeg6csKWT0GsGyamq0XLHJ9NcnSfZ/SucrFgQMuIFkFkgaSppPmXAcY9gY7SdZmpuZiYeS8WK+NwbJolMfOQmaNdXWt/aZElU91WNwvOK8bAOicWSsejjTuuqb1X9C53FM31TkX8uSpoTq0bmORyfSf8t35qaq2izXWpk1cu8upgmTQhGJJh05G3hu9arxK3UHdAanaktiS2OBgWAuRBn7FhkJo9rbb2jfd6A+GclSiYvhMM0TUYqz5N9bq3rVMs9xzW54TeLmooMcwSlz9OXdU4539RyU8bjlAo51Y60M/k1TU7jGTUkYtZMdyRZt+QoFCKEMmXdKM3K+WJK6YWbaLvoZoyY6TUVZ9R824yI3yrG2lV7QME78ib8Y0R9PsgQEFtZkhc6kIWtwjml4q0+sZKmJLqtn+lxzJt001E8/iMimXvnIn0xF+QkUJynk6m6mx1M+HmJr7bnuuSQceP6Yst+eqqq76WpecJyT0G+ScfDztLJVkzV44rfMDMlSO9Y8rfWzdzfS7FC6Fqj8HCS/UR+uBgszpEsLIsfA24uMFFb56jqsWOcVYymsANHWG8e+8tZb3wa0F3zPIpvaz+RRM/a55rhx81C9XMouPilKv/ITVE6OsTS+fyZjlVHv4qe6rGcuRaJ72zMs6cUyFuzV6rUjloiZ1/7bIxjRbVdUM5smRYZgSnweSd6Z3uL1Mt92OIYyEhZdjohEGzx4ttxaQLlDQ4a+R+JBo+1TP+PpiZlipyb7taP9ayfqtOupZvI0uPzuoeIAcrIfK/I9MaGep515HTPgMknylTkTUF5plmdvTPyT8Y+aeBa0mNIqtVL+Y0uGMtMviYyeEyMu2rvz1Dxo7rYj1UoioynhmEsS5P5pq6OZ8BTizpItaDBvkBxot6xx3EteMe+Ov7BXWR+Q1kmjdeek5OdftWM6n6nkuZyFMuSw0Ms6oTt1jp1P24X/AHRIs/XGenPkmWmiyZZ1TjxOPqo3aTX9iWZ8Ub/IuUiGKOgxusXUzWPWluoHWSiZmv6ltOPW6+sQ3MKbE2DTdoHg6G0nhu733a4BWYQCZvJVP9Uu7cizNMSMuMb23tT49Eb0eO4l/Gcsdcg96dDu4jIBJd7mZnHkNc0P9jRQ8fibyXNOMLmjeGbNmRGJmY8q1j34q+SqmgT6qGVzEnyEUxjx7npEt1VZK+xuTXd1LvfRqvNJgIi4vxZjzfCF3pCO93E/hqLtycbM6bzhmED/AOxdGrPlKnb97if8YG1ml1yVFcpyjCfHTU1NVmdjJPx4iyXGVkZkklnm+ot3/TRTI26ICp1IyBDJWPHP95vvHz9Zqas2PFbrioUEEzbW2ijLSXdcVXOv8EclSxu3kjX6QG9bEAe2GwH6Zt9F3G4YWBe3ZpswYgF+CwsW8OrhySd0Gpmp/wAlUVQc5GyZ5mdTcDL/AKoxouIzuo1rFyy3c5Zlqd6W50oTVOyVmvHmjCX9lR9Lo6ydfIVojET50c6GJ1s1j8AtKvLM8mPHNyziKidyZKLZnme57P7bvYlD5Zii4Cewa5j0pbjOpajHb/xg3P8ACQVp83s05KxvyC0hENDPcaWv9qR9QY3DUUtUi831Jnw/XFRE0By+L5e4dVNT1Yc026Cdpjc7qo+bTx1q5s6rrHRb55lLlog4dBq4X8IyfGqz5c1BWnZXOybROsfh+2qA/wCtOvxyrwV7wORPDE8StsxIUfwj9raiQZqyiN46Qpi7p3NLO5R3dTEK+BZQWPxXXwwE+e65cgVVY5yHMmW6Zl+KZR6FkRBHSWLvUjRVc9RU1PJtCcfyITUqdTEzzbuNK7JqjU/bncziUijq6rxSU0a/e8nmiigNdfmbHnu5i3KFwRPK0nFuSY4/Qy/K0GWmjTGSefjxpI6qzkWpd/WuvN+Cl5Y0Ii48V85IWMmQmrx98JiQ3MsFVqWYIWt9IKFzUxlqKncTy7nFkrhI3tclFrQSprI1O9+JNnaMRUupqZ6DLIIaxE6cUVz8fkncyS6nz0KH4MkzYESDmIBY+tgTzpGNsT5DXFjKPtp9zFvPeOWcQqEs5Jgrme767u3lrVG4blrajX3MWyOjKmTW6iMTkhmR0scdTUzoVZa2PgklMOO5dhql03TjTqsVfV1MzA8owtVtSzUzi1hiry7umcmNfv8A45mucC+CNcnU/GkqVsST8kzU8xsYAEW7uPsNQe9su/4SVeXvHtqElyR/kC5xzfW5DYtSVkVacv8A8eJtOfroWL++OuTRUY2v0F8u1Sl+tlB41sePr+6XjO3yv7+abu9b5md4PM9eRNzOhRnfetFc4r5L3MivSmnbGseqKuYdpsA0ckwwWJw14yv57pWOkbKZxxH0KwknDmOHH5ByYslpP7/xxZ/q0mPqAgwT/TJP2Q/Iqv8AJ8ciVjxj3zEN5cXki2nyBWjWvksklrlr8lyunqa5QwM6yVvJxEmap2c86BqlqZprlJ3S9RdZOytFDdobu4mIqb+WhZrz+uarXH9pBiLCEdtlmwW88PKO9tlCsWtn98ydZkTGYsW+HJEY7fMlb53dZE5CkuH6/Zho1Gn8jePE0kctVTL5qYnJzM7uUJxUv1a6pf8A6r/UTcZDNf8ATJzc0Xpvese/j6p51bzJoqfIwzx+BeMCKinW5yQo5MlFWf4LBqRPDz5I+5vhKYOF37CEByDtJ7sajEbBShhX39jY21ZVsJg2zUnMfrM4+Aaoav7du3QVPmqP3+L/APUPRMtZJRY657N4/wDI6Ax0PkHnfg86JiWbfU1kKicZo7eQpD4NBO6YkAp0PkXtAHLV63zdTvGQn/rlqNVHVSp8lMmjpTQANfji6km1oY9nYJx76WLB4URf9EiQCZ0NmIqFld1j2GmXJ1uLarZyrakTvmf26Ciz8fGFUNdSlzyFVkRIq/8A4827DwaE6JfwRDc0GXrIVjueasdbw01Nch2V9a/+Vx7rZeax5P6v3LKWkbbA6iJ+0svTwGhrqdjVUpQQAbH8rBhIjc7TqSIyld7IWuJAu8WE6gyYa6TH/wBplHcRLRub6pdpZRPceNE6rl/ISpumGrm6Jrw0BVTudnMwzzoorgHcoVZUazTPXMwXwNLQ/YD58mlJqaiv7fYlEx7Vqcp4xS3LSSVUuihZrq0saqns5199VKSsrLj5mEz5YjBJ94WHqf8AHIOO0Q2CVbeqlY1l25GYxup7MfTDIsqFBq5Jlfvfh/udEy0jUY4SFNyCop1xSH3r/tb5+gTQsvnW5mqNVDA8bYccx0HmskzZ/ejUj0PmipYH8yhpt73V5C5rmWpmvO8iNcxJMtTz/vc+KAPUcCTcwpxeQbxdrC0jhbqCENh4A/aHpWRyZArmmxmfqsy+ClardTTWyqTj6hRsH8ZjqkViio/xa2ylH/bqlo0n95N73L5/tGXKY3LDqmmSarprdmPlu9yMbmmdD/VJNK1hGQ5Zd18RRf7pnrpPkp5qtUEhCI+EZT8k3ghxGH3nAkXjE6FTedyAhZKJ+zPusxkY7a6ZKsvTAyZXliVDmjbX3k3POt7dAZ2b2DzvLLDRMjqmaKabvpquZh11ICCmz6AQ1U9rKFFQZNayF2n1km1NVJzsXRX4qsc5MyUMvblbpPsDoxmpWuq1zUE9mj+3NhUPlQtE2STsFB+mgo3sxeAEgd7fa0EDWVscdyOpcUaJoijzumBoYpmB2zM+aRjZ+SF1aVM46hX9TEPGjJMzkLpcivLqZudyzLH4WO4qe9aSXFc8t5B52UfYsnYSVXmZKlDXgqqgjngvJJPyCpOLgJislrp6nValVpn6pGx9ifS4TDRQd7Whgw1pbb2k9n3tFokP8OkpG9t/quw3zyKNS0g8j43inTynhnc5h2FHLX21GtNEbgDd/vGgf6ndad7NfkpVcy0T/j2EnPfFbC70NtgtUeLOQ/yVsDJqnHGpB5leeJX6clU+WXSUzs3AeOfMuWlvy1Yo4LYB2I3F+XmB3flGw301mb3k7oyTbS2yFRKDMb1dCUaHzb1Ff3nYD/bo8G4/RJJ9fuzS71qr0Byb8dCs8rJ48+MmjczRM8X3fi6p5PAfY0P3B/FrzVKSdBijcqviZMzVrsp1Jeq+u9af0WRPE7yDEDZbsgWWkUE4i3scrwYUcaLJePU6nuvpARHEu0YautF9SVsNNk9bPzKsSdiScYypfOqJTu60HO2aCRJrnnQN5j+WTrUCdw2S65nR2oq0/wBa3Oj90E9H5PHDTL13ZW9T1Bb43VBE5JZQJEdnimvIGlZqyB2wHPsPJGiNhIvAee85TGHpdPdk19SCfMhMXx9OD/dFqiyTNk63LLSZJXp96ZlS9/3pSB5HWphfCPmRKrnp/JgTpEqmayTWt1Js3HVMjU1JyaR6TQPiAnFFVJdTTtmlSW9lXDTIhEojOvDt5/SNKI2NLKthbvNkiDgA6Eo8O38zvMO+hGiam5Z59Rrp00ieZar7cgeWQ1Gp/vPf4beg1KNY5gN/J0u+F3/TfLQu3UoOyn8KssCal8Y2P/Voq/Etb39aKrTk2mxN701WKrYIkymPnwlZBnWSnJprysiEtPEminaileIvfc7+QDF3ADlfrIdlD9yVozv7biovbhmqer39DdVXP02VQzI+dBuVY0Yax1J5qANqT8i77qz66pOiaHWta1zs7uUhk4JIFIrWUl8wo9M3vapO5OdDqmKubxPD41E8skpXKmo1TPlDs53O9i+fyCATeQs8jtfnjSGyTaSVlhRN4ONZLjkpcSgsFaOi9CHdAUbn/qFEtIyzypyEtU66/wApIy+A1qZq3drB8aPjw6dPlZS4zSRW6j46l8QaPjqr6BrorfRVf9k8K4Sltw0NdZL2zLoZaNFJ4yARuWR3/pPwKsmv4L3+mWcaBgNWGZsce5Kc8SV/FVR55rcpRRrmQcfeTdP33MbA31skdc5UqAQf9Na1DchzTTX2r+0ozrrZvlT8jHijc7d71lKqj+sHJhaqR8iamN+ejrzOoyM0zMLIY50lc915IjqmVkWYEJmiGENH4oTMEkQ5xjPi0xLKAFyOcOVf6gRiJ0tqtTzjMmwxExNwK/1y7nYwMr3U7WV/1dfmSLvcpQsZZrlsv91kPEujdfZ/UnIEtX+MWZqU+tcc0+Zn9CFW7qmqNVyT2xzs27VkyTJC/Z+kP9pkaQ++6e4rdib+xO0U0xkXg2B/8YYTXkwO+hpcdnjZFCXBkTxk5IugvFSFa6rR1n1ID8lV+q3sEU+tPhfzKt7eftN1KydTGMpNnRs1OqO/1j39Ve5/DZ2JsEj66k+3HiXvbJ1VCOxsOGTe/wAlnVmuZs9OCMzo/wBvLRrJkr6Vr9f3XZzKWurgsJm387kEwzoEEX578x3IYe8I6G6qqKJWDjGE7k3WkpfPU2VQqgGl8w6PJWpHjk/x401sP0GTryAUIWy0H7lTaMQEqVLKG2uaZFBl61vknX1OaqtFBQi5tQejoqYVnmuAgBq37TCI6Om9+Bk0mr3ODwQbC0lm2EdLJ2Mczv3ZSh8DRjM1v5FpydCJTJ45HJSwFLrnQn+j9fgWVXTxRU5OprYQYyjj+yrC0fbmSk55kOvzDHsZ/wDl7FTTH1eF/wBleDU+P3tE2HocseTWOP0u53PMVrr+6k6A55/qeQ/GxmOBt8t/aUu0HT+Zx+jtOLy744Oh1jx0z8aijNrzp1zPT+nE11r6+dJOqPzCINcmv/spvXPI/wBOn+wn/UJny+fPnMbWbdpxw61WtnJ9uii656T6oz19a085PzGWRo+23o/q6F0Y6UDkonckqP1AdT+TBAVoWMAhhAxyJnQmdou9lxhXQmCp1F5Z0I6/obiWYqtGmq34nncr+lA8SeVyyV/YqnyTJuQOUG0JMZ/86P06Tc/hcu3xF0ayY8prRMw8y1/WqNLyzP8Av7Sm/wAjH0dU61VExTIJFccjqvGORNjp348/ilD+bRxvc37gqGJuAI8QsZc/oRaTc5JpgqZeRckqSV9kk+P+30Tk87GuhNcYNNhD1khWCVdf21vjr6/QXmj6o0aOezbUl81E02dUkg/Id0u55dWG+v8AqpXSMklhFfXmiv0O6lD7hPT3KfUmTWuoldglydrbB87ifKjQZa2DnsL/AL5vjRVkZZyzIn0x1uK8rquq0j5DRam3b5loQqYspHKZLO4r9I2aJOqpf7KM6aJ1t0V+M6xEkspvmHZ9RlEG76QrSt8twiA9T+BkkfPUibkpHiI5ddJoGDYn01pP3v8AE5MrYbfxjSvLjmUtnKz5UmNejzk+JnEWLkJ5akSL1HJ84EnNTfP0DxRzjoSiribmyFqnTdZJmG7e4cjIDtGWKmtkdeJ8fgYpzfLPyGMFmcNX1RjL5cdxkOANxQah6fOmukPLJjtMo3OWlM3MHjIcw5Mk0wEpkPEDId4/r3r6sCAmsOwkQXbusTcge7SCEfa+FHBHYODGgKwQvyTSfP5GET98zWX6QY37aYnc8tRKFFSRN7sYr5P8p5lcYTeSvTv03fQnU/8A7OidTGZHmZYmCknGXw5PtJ/+s1ZXisdTusvBe570Sb/GTAY8eNyaZx/IstY5ynx76arzd1T/AKArHKIJr8Jkc32au/Y/s9VN72mSAPrPjZAxqMr/AIKpCo53ME1qkx1v5Wds2HLRW2YNZNvOowsszeS0hxpITXVVfL9tzOScbWyZm29zUQP6/CumEvH/ANskrip3iiaJoFxITJrU7Ogp63jyEiOmUamMk1lj4lGjFG94xyTyTAlFY5jc0FTLzpDBBIiORKTOUMW8aCZQH1cBe4zbvjVqtUtPLUx/44kZHrIhqulOFP8A7KJuYTISh+DBPMXml7eKB4qXUkhvJMUlaovOruInSJKFZkp+3GT/ACdzbpJxDy01IzUlu6msf2XprfT+Qxcc1huqra4/LfOJCo1Utz4TUwRJf6/7KM3tgY5Fha0AA2y9BTgeI7e/Z34el1bMoUJc9SHmsRVfULdGKcLM7nWpaeTz5Gry5o4oIrFcx52Y7iDdXkPNUVzBVfWLhjom0Wb3bEF6McGT+jEXMHR2bo7ovXKgh408JJPF/JCFVjlVliMb9Tew0Q8zJNFbrrrweZRJANrQe3efA8HSn2zA2n+C8RqcOouoYpx30bdJiumZgx9MxW+dgk0bK+uQSwv/ACyk2QzfbueOkGMkxrzeRKI8MzXLPg5uVZ3Lj8GRvG5HpXLrFNhRTcakr6oyY00/LEu0LGIPhjR9mAGY82gKWbaOmjeTWmSVU0/jg/KBATJ3iQLGeSvZVe1vvYO/MSvroYqjFknK9GPLJqqYamZ/d1T8lbICGdFJzY0DTo76FxU8HxSAlUh3GRulUdf2YdGmtV5/IzQsTRYs48OTc6qanFNamqS8lW7gSp0yH6oEibn0+KboLqsssblvLjK18c7eZmYYoYTp+9E1vmhpXDubsm1mZxbIgvR6Tkm3LG3fe7g2I1mOsvxpMPV0yOTqq65irxERzzi3LA2cy2UTUuR/BmpzQLjYohxX6fcwl4w2czuyZ+xFbU5Zs+pbheHfUuzRKfDt3kNzdXNMRf2ZyUP0negKjeVV6jX3miIsxTe9KndZCtmQNzkrn69CylUfg5GQptcJP6jtydKcYDNsL3DE+M6aBHyO4gmrX5Hu/jeZykFAMGxgl+y6rQTKiO7plinKXLiy2TE5JjUY5vvYzbvhkOtManJPVLrLCExDj+OseO9Dzk0VvExjaqd6ClomtH1qSX8sfLi+P5JV1M4+bO7HR4oj7TcrP2ryT9T665PUCU+TzyrWtHB1WM2Gxjfwr4tCepwxltooHS3I1p5kD4+UnrEyM/QCq+gltazKYskhePvipxae2dqJI1NLCdDWpQko1UNVmWq4nmqsJxywU0Virre75GakPsKQT19aBn8UepreVyxJbk+KNlam+ITbVY25XHNuSYLfrD5L/H6glN7lG0HeeME7aXChq4TgQSzO/wDDmRyY+5sch3USy0cd1PH+c+riea1qUEqvFylDizW5s00fanJu00xTcVEuSvrUVWidaW3X1UadbeWKnPpMdLOTQt8k7xrVBk+T731Ez2/2fk/a4jHQMJjqaKt6+NqUnvUfupS5KLSw3j1omiQC3SWI4iHa3dnKjSwPBPMTOM+wh2c5DB1i51ds+UW8bmg8VYAQS5NBu56OZfP5nxRkOJskk3NtMlxLuZbdtU7JdaipKhrf6W5Mc0cz0AwFzfM5e7+P4qyLM8JX3qeitnKgMYbz3d9M0E1fyzHfxnOO+cXgHmn7SxPI9KZKPy/UkJ9lYiDYPB8aZkDbybIWsxvAIODpz9suPLOYMkDl8upob3WPkmXJoJZeqNDJVCP5OTrJkipCvja0XCxcnPTIrTVE/QUVCdOyvwckfDixbyldXOwrbzdbJchMuGMZBudE/e/HDEkfLMWGWZ6JjBKFSTl1KV8tUb/2tm7+u9U0ljyYDB84A7gCCr9tL0rcMzmflhc7FcYeXkY4r62Txheo0Tk8MVNtKE/ZFKZR1CO1M5PvkxhXRZdV+rrFuaK3XWG02Eoviq0bH8xmr8BOKyXd3TzbjSn63POS3IiIAgk802/g/FW6LyRcWOWZEquTgiasx/4wYNnOuJ+iNIRVNgdm2BIj1ELaZ2EaO1rHwoDnYiIsVqwTiyboyDKdi2FbeeYqF4YPp9CiaXiHS8jllcLzKGNx7+ISbJXd3jPNQzyfI0KVsgdfgYoJliV5qrqZcuMIjmarDTyMx5kqfEdcaTf5ONN3gqrqN18fydSkBO8UtqWVo19JmqhDmtT+MYYUSswFhyDhlYnTx+cqwW2JF4sBqQ/vchIfV6pk3NfSsc0UEFuOYvSQGmQCksnx4oK76bqUdf27SiG7CSIsZThTzR4/qrJWTqSMLgr5oj5N/wCLt630XG4xugqp/wBHxEjDTlQnnNQplKiziy5ntnEs7N1rYxHNtTTq9oMTaI7WfkGbWbehwXCibCyf3pHMudFatZSp+Sma0TLE7qOmB8yxWsnx8SbZaUlUIy4JwYhpmiANRzZTO95cipUrd9FJbIibhWdmL08281WyytW2bjRNZBlmcXO6X9S1WnX4qJyUwVURLEPMzOnr93Lbz3r7XUz5HmdvXDBRHZlAWJBuxiwObX0kYLBibrAUcFSYgWuGWZwBGCJxD9XJKh/knj5LybN497Q5J87WgJHyMZO5i6cmCcV40rHJVKwTcBJOpOJoa5PPhS0d6x1lY8oY6WKtZQDPzuTgJqp0m5T663+G3ZELjxnePESr3NZLeoz5LLeLNFW8U6uEetgAlvshcDwAQMhcudMQIstvfBHvg86aUxT/AEqshiyTPMvM/Uk7453iybmDinzuPtWvys1n+VyxX2+Thlmq8d9FETMzMn9epCpZa27T8bxmclOVL7bOtdBPcyUZCSYiUdwDpRUu3WdnZEf9I/yXrXfFQ8DZTdV+sjyU80Js+zYIAIgW8mMsxvZhRpgOHuH2XY28DGpMOljku6qsozUNVA1OSKv6lbD/AKba3qXf4cVRksJpoLmXyEsRBJRdc5JpkD9duo26opfyXaRlo+Ilx8myYlrEVlJybqsVvTzN6f8A7VeXK1TG+JeMb4lJvGbnlOWu8gighUnPmz6hKHywCnCwJjx9FpXvMhmwxkfzZvWRjyG5cv185/8Ao3wc6MdWAWSc/T/HppN1bP429TBTxlnJQzUs9xNqxV2JOOsfNeEeISp3R5V8g4IyQ6Bg+GrpquddQTz2Yr7g8aE33z9X8K53hJnIz9Zy8zdP+ERcP/rJ3HMNlbN1erxjr8kG+YBvYH0r8kfcKwCfZKR/24xKX1eCGM118m6MfbNaCTVS8arfRSq/Hz8lePrYNBGTuuSTnU4p+lA5KnkpkqgxTq5K0GPw6CNyUYuGgZuPtcEPjFjNVLVRIzMMS/HU7no152/jLHGVaw/Jk6LJCsfeqi6s5mDGxSeOp25NJT+UGbwIJMGYmbQQfELTHe5e1kb4u/EX1Xy1W4yBrjLih0WmSjfbkkpqp3ud2jGt3NHL+TiC8tc6x/Wvk2k9WTp+P5GgByCLqomKxSvMn5PK3aT8JxknJkcp1kqeV4+WdNVa6vypMxP+Q3eBJMmyKcU93MuOXu+e8lO3babqQMpuf6g0iyZO3AcfhjOVACTto7bw9yrRbKAEInbRQt4sbi5r7zja0EUfHG4zTEqRp1bdHfRdDjXJ+LyacRkyYmZjJOPj6mOmSmytFZIIVRv6zJugZl/GdEVLhOWirZ3UxG+WA5kijc1MzXne5Xjx+JKd5L/sWZH7SZLJYm11NM4zHWgomeBrwmj8DAQYMPAfy/bnJvoTQR/ckY2jMGdENY7xxH3JxQNtXMzfyH2cm9VjE8gAO5kAp/B+lU3kb/xzk15lksDU80FcQ1WR1un6q7Pwx4rHTUW3jJXjxOTJSl3QSQuvM8tYyXUM+bmzWX5I6yTklLXU1Fr1TOX+n9IStDNWLQv4rh8q4gBYyWnzLCRFnHtte5M7ZljS5JusR8kfWG+mh7wkwzjvKlOS1JGdzsnlosOYyZhq1BhuscHD1NO+cnVX9YKLkXzinzoBajCzyVN8Zfk4pyklQILPJL1jh5+hy9dShHn8i+ozXNSZKt7jKT5meyYqsn9LibKr6yu92c22Ef4jAJ/RXdo8zvqf8VuX7Wam/HZ6xz00mQ+ND4tyUTWSpoLyt6iulycUeaqXk6lfzMOKLh6mtFVvI1L0ziD46pJ6x/t6nRzuZ8+Rjc4o3P8AknJYniLqclBRfYzyDNHFBqTUyz4oJrc/Rbx5LG5brR8ldDZM8Y6NM+KZF3qpp5BzKGAAcHmE2ZlPR+ww/pi9njjQ/Niiwte7yGSNTSG3RjvLfjmKbWCaoIs47xyVOQ2vJGSqoubhdcXLWPeT+vcVPUSwDsUB/IyVvJjyzE3fHxx3i0mZ1kPioZPtrzarWufIP4n7b02jVlPfUfS+ipux4nGu0nxKVWkrf4YNk0P3m7uvuRpJgpyh+yCzsXg41OOY+C9/WWd9PPfbBLKePkhrZ9ZJck6lP0k5pKqS+dc+nYS+igD5aK6Y2hrNTL+ipnwVKTEwuiYgp4neNieWa6mnWRCtbSQjqv0SVxtzZMhM18p3KpdYu6nX2+rH9Jcuy+6qa+y6YgIdgdjCjZ+qLM6R9I9PgF2KAFyFDmEYECxprK5oPr4qn/fSF1jomQuGJ61vnTxOtp+FVOX6zM45n7c6JjJWI1X1qqqitkxP1a8zuak/MJRrX+fqrqd+KxzY6+/15yTqycQc9rxr8QtU1PL9cs4uyeTIoC5bq1YWUa0D5LBi6pErmcxLEFBTAImZvGpIShstxMgdg0cndBLVgP8AIMMTkZ+ZjceK35xmqvqKfjDH9Xc760wq6kLyQ/f5NVuzn46yEVM1ln/H8cJzoGZWa/da/MxR02zZqbpIbZZiSfpvk+jTEEzIBstB1+KR+SohcuPr5ZhCaxzuZfj7toqWCOeKxpRXjzwtioJhntM75NuBqBF/q1YHHjeyQvqMsY5yY765uYcm6uXoKarHXIVVLyE7Coip6k5fyeW/DkMfRNxriY+CranFNXNfeqZWNs/Z1YzJ+DVM4u+NN3vFVzTU3RLO2+ZnHC1uUol0By/hY5qZFoqjD2XvzU0SmIuvPmuTHxOu2tUPCzdgcEpcQc4cwmjoEtIOnts7oDJXgYOld85FIeMpy3v48c3lrwKUy45mF/X1/wBfpmnVbESoQ8zjK87V/WZyFrP2KKyaKQaJUoMxyTPU1Mnwmq2VSeX47bFrKZJPBJvabHz+Iq4ijmgypE3QDu+hLy5MsoDU2VDOtz9Tx9la5N+8IBK/nJ4uv04wJ2wDpv8AhiT44uZ7mbytSecuPhqGZ5MP76607gjzzOgyPcOr1WIghBhbxUBoJe5qKdMkTdCVJS9SX8WPGbnaTE18e0WipyXR4Z8VvUtVMgD52fGxDkSflnIUHyB3ob2rdHP9Se5nWoZOS7QjI2JUwhz7AHREG+3uDH2wNmdIzZJOAJqSsUM4/EbPtN0zTPkmlix57LZpYFnOGJKuU6uLP/VuGq5nDFeIHpTSboG5o51+CxM31jr+28ty0JzNO8cTcEVxU/TYk7sPsIMqxw5op1c6r5OFchDDMoqvhp7jQzT0mpVDINxKKuAJcSO40mAcwAWCkbzH5g+NIx/H5MhenK9JPJLqT423/r93Xxk+TwFGxmbIg49aiDHirJNJ+zU67oNTrINaHXIglT+DNrNMTIzjoZyIao8rJRTS1RzSlP8AS1CX8GeqgZpqmosskbZtG4q65KsY/XIu1dsqy2ABe3qAvaCTkY8W0FY/XZTFpe4toRfCyTIGC74p3T4q6npK5dNZlLm3dTy2/g9dnjqDHL1Xyeclxzk7DISziWtXyvg+P9zz+Nm3GzeI1048dhFzLdZF7n7a068ZXpnI8/5BqPytcD/Qrc5JlLqiCWl+OnbNwMjr6klUf7kZJgeQcbQI+1gQDA1NUTthTzPIcCY2GmBVqx1lmacoVQMYpNONBqU6JpmY5S5qaFPzHN8QVGNaaIld6xdUOILWZJ23WmExmv8Aqs1MLN0c1VfI/Gb1MVTPIOjc5Oa5nfVVvzrb+DMZfls+Mp7qXZ9+ujQdanka3FEkifH/AGVJYCIEnJHZ4w/GeJw05uHaJZ2sCbW0RCNHBuGk6Sfk4qa15d0hqd4+YvWp5N/mQ5KvLSfIvyAO25/WqinnUeAlDbYNA1QiZDNhyhXjHquPsizM/IUVXVzWyZTUtSzZNaVfjJzY/wBYOpuubyya+wp3S7I5t6JmimtlE1EGwO/19w7DIvzpH5VfdcxtgrKA8IspoqbxrSgZNidORbaq4rnsnc5KBcex/SzKNZKqy8b1GR3WgNzMlFN7rIMFJSIgTU7NrcDLHWpk609X0zCR0kIfUaSB1oqvBr8FyyY/sE5MWWeWpkLqeN9C9d9bUTlg0n1H8RIK9wIXLg2z9J1B3aAHHcvjnMwMBlhq5qWaFnMQV8SnWjToXIjHRvTvok1kKHqjNjeev2VuWcZQxJ+6NtE/Wnb0J+ip/GXlvNc9rJNEDPjGLPNZMgtai/rt/wDjQz5K/ByXEs/bGVqcYxITtY4usnmTp3ugmtyIHX5JWBDAUHM+n2nv2UoGJuO6z/5B3ZnYsHUzr4afHTXxrcrQ1HKfXR8c+DqeuVo5Bt/K131jkGtnLkuTmnmWku5GqpTeU8JGvLo/G3lp5AIgIxZLCsRV9brflkFK7v6uw8f9HOZx5Gsc1JkWErU4se0k3zUmqZZg/coc7lfwy9sbmyG7HeLvT9IKciPmkE2BPY2ZFrazGVE14KlsI3umN/Wch8jFGMZuSgTvyJXR+ZdVO2FyRWXy6CsVUS0lSElzJQnmJ2VOhZk8vTWEfp4xJNY4IZP1OW+qKu1lJbmLHe11Qo1fjlCq2yUnVUSIwv8A6nd6Xzs4SU3+IsRgQNgWD57H2FtRUCFib7AEYyNnLiVJNTPnRP0+H7Sr14Jqnaa2oWnWiuP7KhmcdTM5InJ/T7arfdpR/kPHCdiyJjDUnjf5El5CvpUfotF/yfHReRpoa0nkSd1McTzUORhLrWRxk40nFixu2iWOjKdckxV/qgCcaiePxMp3hLZIof60jNrG98eKaYFkAPodMTLl/tLPx9BC8xZBpmi3qtnMzOpmpgnnraqiPtdT/wBpqifk57lmTk+p1B4MfP71W00H5i1Rc0MsOqayVN5CJmbx7s6oDqtnBWman6KyLkxzTN8/THctBRJz0U1JfkqccVR41xkDwkw+fYpjcAI4+mkcfdQBvYQ8T+o3WsvHUkY4kt+La3tIrdPlFGnWxmgD9OfUmSq/6xU11NTT0sjtOWj/AKxrrnk1aaJsWgDdf4ptnkd//NV4Zqi/Ot1Qzr6dNbFOPLqVeoSulDpnnWOllKppOEmfDzsyAqyndzyMLJHKCgk6n81+XK222MDTbrLeWaJ3EJinFqvrP0JyfZ8dc6lPMtE8p+wbMZZXlLIhJUDRobvx8Yz4rQ+L5PrQNIEftovrIO0U0bxGSvvRudBMk6KN7/AaImdPWaicZ9Krx4rpd/23KN/2rkmZJlUINyg01efSQgNrAzbnTIu4Kt4HaNuPGoxOQ8XI1L45k1TBOunJ9rE8lEz26nxR1+YVjvI/LNVM7tQ1M68fGl/9G6QJBdVo68/hf47mWOmNGO4VnI0Au5lSkK56admx2feRKmVo5XqZmpjU7ZlGqtfLW2glf/kU2oBLwrSYSgTdFngN6VsK/vHjvn30VSvOmNhNB8m+sDTuNu62iBjPogbG6UBtke4Y8fFsh00aJeqV51smv3zCa3G2R/61bWO8kareuVmKmHKJHKiJB40MaR6LsdNSA6w0Ibb/ANWtbdb3Py87EfC7/AImWDthgPwSTE5m60Q+PEWukfdPhzFkVyOJyMMRVT/+wJqudVO5pqo55CfGxUHqsmHVTDOz+xU1jjlqa6FusbIc1IGwBoX8Kr4Yrw39enhl+Zt11e4EdbfGjSc63LDub+Ssj8vDTPl3XncSyExLvl72UFR+mdI93IJWEacpBveGWZWpODBxb6v8o7zqZ+OVqmmsuyKdjjLC43WiSNzXmZVZqz6kyzdD9JZUj/SVNEpc/fbvJW/BKVTt2bGcjogkJyVFDsd3M3piqqqj7xZZP11vmXW/KcZUFGiVphycrb19W62SONmEHlf2E+K/EYQGQC3lUkTdmSXA0wdhzgu38m+ir7VNZvEc7B8SNMaxhX2+Nf8AUyNP0POvxk20bIDUzjWvrbvUdzNtbJElSehnmQdv4Fpk6nE/aQ668VvFJuJ+SW9uzdHKkon1lQ7uZx1Jx9cWIyPXyFV9hWzUgAdJvln67ERkGO0S8prKypsraO20Df8AKdz4MydsVlGvtxBqgCHJNVJ1Vb6K2faTdVqf7T4AxfJXVLJv5J6p24x18e37O9b1LIiz4rz+RqiHskXIxNslpCzy3aMuMJ0UT53+mtozFX6hKamXHsNv+tFNOkqipKk6OaJF21BIJSAHi4Xc8kSJ0r4EhnkCxRJRKsLsEbaiGmepOkZxjy9niUpa3qRlStLv+2mdqJSKyKu+kmgZZKqNzVtf1LAamUURDU6dzVwVzIyE0b1kZJGrZybf0E9crRuUB6MmcUz26/yH1ef+11POOnXJEvlHXNCHjWki6fLebFC2LaUwhnuFuIuQTuzk/h0LIlm+Po5XafaRJnGVTt8n7J0m4min8iIi8u+ufoZD7a3sjeLTM/UNvE6+qz/3H8izczMj0QKjoucYPFU+a6amA/pZJALzX5n++iaqauvrLqibcfiap3x9tjOvtp3roUXDt6g5z2fY5yMnQpA/8ZgbcNbYxYRaw/fvZsjGn9ubRiPH3KfjP1OtK6lQN/lb1D4l0ss4pKDXYrzVO/k1JLKnKhOt8rZ1TOeoaoKMdeZSftxNS1OuxTk8I80aHZ+EzNZZ/of9pllZEo5NIt/rcnjys+Nb/ET6g8sUv6P27mSNzpnY7iNkhElMlkmVpcTLbjQpya1zquO5kD5K0MHTBrwWGjr6MXGMPP10pO/3SJx22A7eQonl1z9XX5N1k5LZaDUTqeXinb56amxK/tuedVWml/My7biFiCcGPK0o90GyW1Wlf3Jo+rPQzP4jASljfgADON7IjYNAQ9hD45fnAWLgTGOvjx/7kqr3Ou6Pj01Kf41VPG68h48/hBKTM1J/j7aKIlmUZnrx1TQGp1KSRvo/J8y7hK73sRslsmlLQkOoJCZA1/SnWwajEVeupch/1e5bJQbdTUSR5n9AKS7NybSDDThW4908xOoslEP7ZfYYBm0ajLoIpCv6HUzqeeZ4bT/fU/YD7n9Z3+g4XpHfn5OjwsfV4LdL9mFT7VutvTr8HLfxcBRV3ztTomnll7Q+glczM+AUNaBmPfVAuzrJNdaKhJeTZ4V3LEg1pnzQv4s9r5TUIDDm2kDlbGO4CAxe2TY6bj4K1NcuQq02NE0EkFV+2n+tQaXwu0fxdhrzs5/xlS89a5jSqWlNP38foK1U7/BvRUu99XC7p3Asvm9H0+qcnlN0P+/wr/yrjhmORWzctpMak66a+2t7J689H6fxsKcIfaXNgEYWXp42xJ5A7IWSts9RvHjoOPtvTp8/IseW55CFFZDrU+fpo/Jy6eCWSghllCUA0Nb3V1TE63Pb9QjR+DbzfUx3NSSyQkTlrZrpTmhFKdkvSi/rP7p1+iC5XknyGsJ5qmd7eQluhFHWp4xji32ElSoUaQ/kWs3iM2hBMlD2zlqQtm9u/sKrMszWpjfXiCZD9cnY7GTHBVTjo6tkXkRrRJ+wDaAzrVeBNTspcdt68T/ZbfLXM0wi1Rj/AN+dCHj661NasjZzqYf/AKnqZQ+PTtVPB/qgDynX4A2e8NGCrRZAD6S5fYZYEcHHgZ8CDl0utz5GMe/O254Rq6ekUdprXJvrWvzGb+XutdTjND15qeeqnaLf6ZqUf2m005VHGz6NTOPnS1SJ9915ZWaOpGtTyb0KNa+KN0a8Hjwsrv8AyVve3TNbNvl0+X8LXM3/AF2a5g3dtJXHlWh3asDhLI1AI/UFbUll5KpCckrW5BGf0G/CWpsU++R4rf2O0OhdNSS7l29EczqkfPivxmmjZvcaigrV/Ulp8vSGtb8daZQQpVuk2wrj3PiRb5NEpfm58oJP21MuqlU/nsAF9ufGkR7RvDWVss9ttelzljVaqcdYoY+xxTrR8sFmRcgvLOoqkTl58hG/lyZDHVRluZ0mmcmo4yyrBMIXr6LIvImpuZ6sJyTSeMsbo55mQC6v7UZU8Xqe0JZMnlKdyrz2Xtxxc0vNBpir15i9TEuvP6levz6kXZwlcHbwgude8AUJBtO9vyv9xGpnqc9sW05MeTqbp6KLD4yTnHdACTGpKV2xk5cauUJNeTE5iWKaW+K214xkFQ5OUnSTLq6/F5KrmftVEydxEsFDROQnWqa3wdR9Ul61XlOqW8dMEpgNblrjU7M9ZWuU3M+db5vz19q/CHBn1KPFpM3y7PTyAE8+Uu27vwI1jE+n1kwY0cmSp4LeCRgiquVSZqRO5Xp/TFTjhWSqi1DZkyQzfhoKSoW+oxbjmtY02T4n9vUskZJrEstvVvl01zX2uBx1thJlK5d/9eZ/GENLraP+bSOq+xqVyhE1/ZGf2eDSqVwISwArAoRLI2tB0l/GZxa4vhfQ6bjolfDNSaauPvc9i3Omjv8AZ0kwc71oY/ER8Uxr93VDqrJyzXM6m2U1E0h4KGl1Q0SGVmvFjoiNpLWFr5KCeujKusgUghtg3LYD1+DUxl+wmLJj6h1UjXPTeOpCmkrX7d2TMUT4r8UoIbGRgr7zdJIwZYu3mxFhGO4ti1np0ROLtxCfLWpakSbyTFg5MaT8Yb3AVr+zJ5JXFNNfRcpOSbpjnqid2UVNN35WQj78MJNxtjGTixzhjSbmT5G5mboZ208yQ1LUyzKPL9Xe5qjVUzVy3qlPOPJk5+05Shcc6o/+J5+urkEhAWvGzvIv3AO8XAChNnZxKQ2wZmfB0J8kTR882qkFySxLH+MczBP1ZZ45RrbAuTxmOceP4spjtQ+HJ9d0mQ25DTI8vRNXzqomeMjNKzLXhaeJZMPiW1/RN1S0Mu63kApD+vQyTZPwG2B5xxuI/e1emuaIuNLkedztrR5/EL9gCGricybd87jSC9hf9czm1xrN4tTlMjUs1OKoqbrVbSQk8CZCaxxTTX78Ublr6eJkrGxjrGhC1IHy4ody5O6nSk1sSpI5sVjxT1eOYoh59RE9yRKmrxHNMfbc1OMmapZad81+WDJEyzn3z1US83XWoBrTXZk4rbkoBjf7oUoYsIl2hDZTG/IYGqbRUd4xMsJIS4utJxRM5puqqEy1ZVG2UuXmusYThbCimd/ShkyGiLflv1GPlb80eGdxLDWKJsrr70sO1/tNcXJt0szju64EXG0zV5F1Gt9M2nSpmNB5ljwU1Nl48jfmvk6ulIu7kPlmp/tplSdUdaJetd0ykAFvO3Dfp4YmJ0C3vN7qDtIiOxQmTJiw3vJNWN/q4mfiz7lxsZGSEjXyGymdrz3jYrG6nP8ALiV1dOQTRNFd88Ywl8E0ZJ65oVZmk/CiMuaomY5rqWXVa8PF3li5yBS1tFGkRO0R/wAOJqQ5rJMIsTDjqoQd7qnvJDujUtDUhOwZIiHSiJzjJD+/bOkhuQBve9t+6tbWen3nx3eb45m8bMTQVeOdRpkXfxdT9d7tnuoJ51+DlnHGCLnJjx1DLBPxjWvr8WRrestTWI0/Xbzs8WFPqIeCWZ3E4a/x8Y6yX/WWqalx0eL8eGUfqq1/U43JDU77KM79p45VMmE0U8OhmDVPmXnc0B/D/wAolk3CkmWQTEPlJggA5AkiS7XRdhe8CyUxkMOMxVqck5CC2GuavHzU3lqdMnlHlWdmoQpyc3w6O42JMUeX7A48t5PM+E11rrnwy8p+Lg+btw/S4pyZvkoa+u65nHfaeck4y6ZQeMhMTKlkx1P9sozdGRT48nB1qcclkox/rGEzRV7/ALCZuoAK2MRlTcq4ACa0eqyBUHZwMFC2QACPbTLycVi5vHuomaCeZjLdUzlcpRiVnaWilfVKBCcZiw5XMFg67Gvr81Xsm7hBlJTnVWa6kTn8rYZvkM2NjLjyTFZY5q1ZiYq4uB5Balxz4rmJO5au9lYiGRnHc456EBvJFDyTk6kyt3tyUS0tBDyhYLDODG4gW2GGR2g6BZ7cGLLPcmB9tRmqtDNG/pbO8Ti+HeTI43xpf0g6qtqIGytFY8nUN1GqlUmYx5qeQfvSzVtu70Na5H+r+YYnLs2TLrPun5Hn/wDA1JNzE8JTP6knkX5NmYsVmDHXyBTX2a5+b4+GGK6j+0GOmcXivI9JokZJMEBNZCXa2xtKEaGWiO+8ZvK2sJtnCsgSxiukJk3d7274t10fHDOiqZ1IfJIQq7HRjmrrKS5Iqt/WqLvU/BC8fqtBMlHlZXcSjOTHiCghCXGvFbKmp3W3kTpPks8tS/VNyrpx2pkKoi4xlE1EmUo+r1/XHfX9okUhch9aPyrKfqSOBAwZXMnc5sOKY3tv+p1GOJv1FUWRVzkjL30TWTqSZmHHGO9NS44daZuNPU/hueQRSGckY7lAbeXGoVXcTUgCI7lmiUloL+vGvjql51pJKpKx5XNvzQjDT9njVmzYnIU9P3qzJVFrK6kr5Ma1/wCzHpKH9dWQvSVMmBeH+mRCDV/vpszEX/KwxhM7Y0+ua6IMZUYqi4c2PJTU63R9LO9UM0rP7qv3BQPy8x1meuZqfBMRUtP16gpz1Wuqo1voqpd/gYq/pEyYTfx1k8yZKeeZ19/rfNmW2DemOaIkbdok9anxOOpMalX1JPUhWopKKt0unU0FP4gcWs0c3cCnM85zqRP24xYQCbc76QZMk5c2O+f+/FInGwqcmOcjMuOoK3kiZbryRK0fhVHyknPKQZBpjm5Dpm0a6vIuOvjNFymuaKZm6M59aqeNVUW8zkmJ39eu6rbkI4vTxLDASJHp65q7P8lcU4qZZY8xTMXVSHx9amSXvPVcPnSymAUQcmWAfe2BtMjVDvLgB8dxBRjtdajHDxRiyFk5G0qpuYn4x+OKTmaoslmsZOvt5qtuTFy01js1mZm1JsTXMqdxUY7o2pH9p58wqz6zfWLvd4+b5uIJf7g1CTV5Mcm+jxT3IzUgMY58uPLkga+U+0zLiXdS/U+RE35GU3M2boG/e1xbiIz2cRAci0Mgf7xHAzi2py1jx1Okqq11lp5j5bI5n5IdfFLNrJG3TrZ5/BTJXTU0pnoXzPU0Pyubwt40/wC+uZP+vjcmQ1iqjUtDf/z1Y1z3FJUFFwEz/eaIE3O6/wAjNzGKd84P8lfYV394mmzvLz1O+d0D9Ui9tnfnEwMI4CZgji5bOXI/Qk5nB8acbbwf1PiwtTjybovTEztQrIpE0QVKGzbVT+RWZc0kvU444Z5rosBq8I0VWub0hqKl8S1txxzUkTRj0iy1y1EbLljV0dTRGRnZf2x14Zr8LG45mrsn5b6npXLYZKdzkutEOFmu6dvK0lMjUWiZn7f7GL6M4fBjAE2yVYiwIgamZsxxTPNTcxqThLhN5MgdJL1RbTIspU6lr8sVlyYgHHvTOEtm9tbDpa5lx76GgD6z0UTXQVn+PnZLBWOc8sMlXN+GmrN9HS5HX+RehG9jWbHkBKCamcIVGtUhzmZrJrUNab0rtADkLp9ItBt4Hj25XLVoZiFGPxce18idRjpnLzMpXw5AbaNXFqFIk5S00SSdaY+xr8CXOSfHU5tvh52xPO4+4QTc1NTMcstVvz8lTRzlICgk4DD18eiL6KMrWwDrZVuuqEqWZr8F+K+tvNdrdfWIvXFVj+zWx19ZkIoGHmp6Qshv8NzvAyxZPmEsLf8AElH+P/G42gE5PaNFlJko30N4skjua1dO5vILjIn7dwmpNgOw/FzmqOjJOmbcIv7mZJZGsn1YOU7mX9oG5p/IMpds68GJw8kp94gS2clSf6qYo+2+p2XsqOMuWI44iZJfjqpmspGMMjuinJNSyQLto8yHkRMlbiLvd8yER350RurOAYY5HEq/sS+So4nHG7P8V2TR95ZfnvbxUQ+byUa3KfFwVsZxY8eWrgXJlKb09aNRuqqEkgZZ4orTzQMaCJKcnytjUY0fFzFfG/rFNbnIMybXzP38geMzfXLGQbsynNPj4wqxTmbnWOjc0b3NvOPy1SAsSoMWgR3mTKLCm7cXGPwlCbEvtwxy7nWXCg88hMQyREk5ZREKV6je1x1vahX6ZjLmi8QTP+P/ABwpN4xlLTcGwg+vyOh1vYm+gTokPT6OsfMb3FZKt4TG6Yw0LzUirzP1Pr+C38V3IH+RmSzG/wCJzRF/FVFcsxpNRt5+4PmRODMLAEk98xc7akxOTb2YWLfYC2pXNrZpJuZZiGD6Y3/N9psfOjZJDc/5diwkRVJZTTkjI01G6xXz8nEUUFOMmNRNMpbS66TLBRaZ+iuQqZLgvVfLXXTVT1KBM0bi5x+LFVkJwU74+K8BrVk2Gp24x61QpVpyxNandbZ3Btfuk4RXln6aR5x+x/yJvd951M4oxS1eb56ZKXRkJ+pcR/WCMk8fJdVISVkqSenoZdY4hyTV2zDqfNNQFRk3JLyBPHHT1zJvTedT5dc/5T7bMtTkYEmP7axCz0a87NS+T8Gq+WOTc16eh5jx3kx6mhBrIVQkwmuvDWqJWGBAwoScjl/Q/XQUFwBkkQQhYbIBTumNMybySdQgVGNJ7ibuRN1DNcwdHLvkB+QCPzBxYYg2F/HJvkuu+p1OS3xMbDmU2SanwTyFTTvqyMuujtlx5cUfvDlcj3WUYiWq0NIa/wDwmVg1M8nXNzmmkmH4JP8A127spg0cSa1keL8/lSLS7M7q2/7MvTM5EDPhhgRAvkQY1H1w44mrjupn7K1pyyA5L1U/HKM64dzdc9+X8zJibrBRT3EP2WZmpJm9LMnT1rkX/JL8YumvwXi6fPEmrrr7GT48lH0i41cQNaJZXlxbNd/kYXU3taZcmLHeSLrJjCscQ2akMfjckittkEV0EZQEAAjGxu8mHaAsHSNgBggNTdidyW4IKHfWXc05WtVJmknmXkkDRxdJ8Yd9WPhAfJv8IqZxF1MeYjFNTMs23DU5SxWLK31defrVEtBoRqJzK9XPqVb4Pk8iPXZM1jp3IgG3fKn5MNY8MfIx3lOTcTTix3A4/tqZ+umjmVyC5Zf6hIuGEUWnB23Jdvc2OsyzHvvCCuWREO15K1GRtIfmJoxxXmsbivHy7x14LytePrf/ALPtKgj+J8Z8pYxRiKCN/T5OoonkKZMgzqGi+6VSXX4ysk//AGOkdcVczxLeR6mnKtE1X2KyQJs5jUpyqY1TUFed5Wehj4+Zqsf+M3M1brHLKnk3qiaCniEdxiXch3GBo+zmIIhkJhQGHGMgDXxDjrJ1UzkmqoACyYJx38m9aGvkqa8yADUn41kXpZFDMS5D/HjmvtgFkCp1jeJ1ylEtHBKxx1dE0TtdlQYwchMxHdb1paIolWhnYkdTma4x73qXFjIOpGXf2p/e+pdPOqIHzW9TAbkMg2Vszi3O2dSSu2NsCcQI5cjYkKy5VSvrT1W5mdTG4w2v7chVDrr+8uxl/EcyzNWU7cZ9NSU6PrRfVX13RdhOwV8x0N1lp4yE5HIyzkHxZcmus+0PvBrUy1udhXn8Lin1CpJyVc/JKano1BVPm0hcf7Klfq6ZVVjupiORxF7fXSNskYcdt1jtG2gqcMbtJJRuUoyM2u4ma1JNY60yUeRefHn8WZdbmX7XzvJ/9rKzxh6pgm9b1qdTtkCtP4eOfuZKv5Jkeijv4+qx1VTGpZoHwksVW3b1qQiXJNPRv5rtmkjLQb7mmunXPOp68UVrQu4JISMfkgAYOSp2FtIi8p/Ta/Nl90dMDJkmvl1jJi4N1UikybvrSw6RqAbr9zKb/Aan02OeWTqtSj045yQAtfUcck5NTrx+gqdrINbRZoqrn5K/92KNOvsNpSwca5qdCt/a4yQ/HOzuMmSPr/Zmavcy5NT8VQlfsJPkp3/aUxlxN9iP1XjMLkJ75H0FudlnUUtHgepyRGse5LRdXfl1S+FdDzVOjf4GW2TnJJkjJXXeM6rCL56XiZI1kCaC1/yyNjqSs9ZN2bma0xQktQydLTLVUNGOpP3NS6fr+TXjIVNeMkQre5N/JNfHIjj2a6x1+poXSLNADsV7bgpTDsMdxIvB7chw/PHe5ZGMmKG2ZSomGCOMhwBP9q83VE6/p+jc1PaoKhUZ/wB5BWUiHzyZE56KkjjnndrrZWsnHdaaudoZMVvLxhjesd14BRGccydU6bnqec2GT44qpucb3kfB8ZMUHVzzky00myQrTzplfwJMEj7TacO/gR2l/wAlQpOL3QgiSnqB5xzARXyZHm+eqkyCQ5KGA+OpdzpZkKSZNI5d45/qNO8c/VW9uzL0Oh0XvKb50JLpSbn46E3RkdpR1OKqmWU+3xmpmuNBRJtKKOgjJ0N4pXVTimshLcGp+0w1zMSlDc9S7SSTx+ZkpgyjZLAC598uNTMUi5IMAIGJw8iEDB1lR09RmcRwXXnGTkkP19V+1BiCGubkRybvqS38cTc8s8zE0Qalapx3dbQr69ZfG/HXCOvweKH6KqVlgtmdYzyS5Nsv3IqcIavevIr+YTvINUhzWRm/icU7soxIV/X61eKBhXYUNO4yECM0suI/LAL3jSOz2Yt+awHMWS0bFE3U3N1iqb8PO8ZrqjUHyxOoZk+j0zpHwlqr+yc0WbJmcc5KJJm/stDSzO63ueZpnc3+NnKXirHt8S6FcdUwYy8WqPE86/8Aqd+Sg0LXI3Tz/YrJcOyUkrXJVvWT/JWgkJtWa0u/wJ/D6QnwhML9fHGkRs9/m3vgHcDgG+dNTBGuZGsj8hp8lpNQuSWScRXgLN+H90h+KJv7tHgzMdUO5f2f211ETPgiDS8jL1+EzZk9R1c1ExVCj27nEhHWodfq2DXk401aB8l44hhZlmcdZPuUGSJnb28+CMg3XQ6p0kKoEZgAng4GJGbAC06WDj2wBPCgREXgLLaKqK4ybz84siCtP9d5UJQfLHx9FJQl77w+Jx38nj/PyVQf3pNGRv8AvG6f6yTPLOiv6je6N0MMm3W/8l45RPPSTkKf8nj/AOodPlyznHhx9wXdxynOqmpnXyZESlZDevtM8j+n8RI3BFrqYUG5U7mwjUg/MMBgMjkK5FgW/wBGTTFinRr/AKHXi9VU/WqseZxjKyM9BRUj+hdLz9FzfXGVNareJ89XZM1NHPDKbJQqdbkL4fL8aSi5Q58nHj4+rPtzXOoANtDzvVYzOMFJ6yq6rTcuSTiryTzMRF7JnW53s3s0hPaFj/ZO0Eq+kbRIFtwwFvBGEGle6rUfIMnOIUJ/yS/Sq6d8B42E1TvYc6SxTXNGQqkv45/7UBPOnJWt46VOp87d7+uvw76XzqEjzbo+WsbQyr3TV19uiTrWjVO3MlERiZ4f6w6Hjl5Yclj/AGlml39tjWvs7LEnAg42Is2wCPLtOo/biIRf5kD31hsnmpMdFOJd7avmZburA5Hoakd7kNJVIZYxkHyH6mHxOoUon/JdvaX4G4Hrh1ImydZbxRRVd4vr1tqXgG45mt80TJOpkfPX9pv8wVOwGvMeTrJNECnleeEHy1uNzqvO0zcA2gxMdxP8L0fTjeBYAfe8SZ1H2WnRVNcCTsCvtORyNSOv1NPjyS7+3Ic72mV1/wCyumJKKf8AJBTO2xAYhY8fStqQrpLyi/bHlMfc7BxoERs1VTufsxHLDQ82h+Waxnwm+ZOZs0hNQcy46rfV0gb/ANeOXzqvxJgASv8AEL8XfYKZLi4AIBeEFIWPv+H3HjSMt861KvPwnO420/Rudtp4d19f6eNgqMxexyhS4SOiZYiUdVNCR8QAVZBS1sX9mGyrrQ7usY3NDFV/Rm6ZSJroldJutSa5/GZb4kTFvIn/AI+jtqrQ+9UMmgaV/wDkGo+m1XZJMGXyvsULllHjRD7bYISxfD3IL3hqaqXrFqcIzj39XRx3TuSsjDvcEk+drYFBJileZrTbxrUr0BE+a4qL8kAG/K6dBGUCZW2QnHkJfsUaOsf+Nmgo0ES/Hxs6CtfhEbxxdUd1WNmqBnVTxOO1G6TT2J5NTTNTFfki6F0L3X5SOckAWMuSgdrOyNjlG1mIBzBkMMRFPFp5SK81WiavImtbK1k5WpmpTud2LVV5DRucdWA90vXy1kd1yVKVUzOteQiXZZOtlB8s/WWqmtY8iSTkjJ0POi9u+ZZ0RVCM4/Lbw1X+QKqd1+hrx1Io9fHwc3XU7dP4N5genuotmYt5WWZRHjt+/bJNwNN12k1kmaNfYZ5ycsaV+1FV0rf+ynnVUP4nNfBxOuq1HifrO6OMl5F8+ZpLDoTr7PlnCbz3TTsFN/WZDjmIERPH7jmaDIE/p/DZFp3Fdm+U+VkoGPPLqCt4w/8Aunk+/wCALEQ2yw0ESbw1AtACnSvj7WN97DxGdIqqpxyy/uIfHMr4PNW/0tL6okaT+uxfwt01S4/AzgNlvPjmcu7TbsuetCSsB0L+H2H2+uyDurBV3Pkmq2rs1SnWmPLLSifs81u2b57ZXdfWZLbK3LpZedgs0FC/klkj81sIyVMIzCR0b2twSWAY/TbTQiuvlVmURAiMmSSJrfW7rqVOjZdBAGlVUxWS2pdecJJzru0Sj5FWIrcRYTyST+zX4fV61cca/wABWgdsybu6VY0OrJl5JNGq2eQII8g7mFJ/f2n7ZLo8l10df750H+/xEsWx3ZYXPhFGRnSiGvBuYXNkfZErUTeLE8Bum/rudsZAJkrJQSkrZQTuamvAgIuQx99c2VSy6PpVGpe9RxMJXRpY2pIj+MqpMmO5xxe4jqTH4m+gLlXmq87FfPWhd/gZC62xkL2fJzuPEumtCanJJIEwPlf7TVP4HKRsCsW2jt+R0SNrJRwsBBj+WEZLVnvFrnJjx+NpkZee8nRTU0dBc+PqbKdpl3iIXnroI5ea+Mt6hb8wR11yAKLoHwrqTvHU1tNY911Mb6knqqo665qaAnrnTqZGsm+KpJlayAVxrjJfDJ8j9WZRPAu0kP7fkg3BdwmN/SYC5AdxnSe2+WNthl58QVrKMboV2TNTXjLNSATORPtq9hokGBh5oa/BqJySs8zUcM0mjJQB/wCvzSUczAM7YosGZWVYRitjbpud/HTzxRYsn9a5mdBz4hK8HNM/bnoXZQHW6SppsSdFD4/seQmvOleDOD3Cf62+saf8mbLxwebF3DVFTyRqtgh1zNV/dvawFmnqVk/Y+UZint03OLSjVL1c/R4GpelfBrko1JPX2V08OWiiyTFG+VZaJfPPMzE1P2Ib+zoH/oPLM7kbPpZQ1r49TqKoDREwNHLMEu60FGbDsWCIB2S39tjdaM7zMq1sR4pIl6dkyRgZp0lE40PLSUI0rMu+Vv8A34rQpv8AE5KayV/2+0m52ctaSOkP8YlBr/tvR5Qi539smQp1PJpbl2chsOeeab/3pqt+dfj/ABMxuo7TGGQk/teqM1WnP9vH9RTnx1+02TcUiwzKEoqxN4c2OpBcDEAHYx+nkDcAKnqNgDvyM/ZgrxJd06kipP2bnck7VlmFugaJ/c2onaVK66KKq2tqE07qdLQUWWeuN3/WBNPEXEq0U7C6yal3Mnf22nMv4r4jRy+aSwPrMxSS4xUf3+gfs1z4QVSCYK4vj7e7w7l5g/cpCyYiSJWwOi2qpyc4/t1rdXNC5McolOzzeuR6Odar8HjZ4+wvez/rHk5yWbZmfruQ0Ch58/hZ6ufjnH46TH3rnUpIN1TQtnX+tJ9ja/kYHVL2N8otH1+pH1gVmt2a8A27KfAIE15crEf6EO+gXsoH5Lm97ogNiNDyTsN1LY+DrmWpQ3TzqTQaPG/B9npiGRa6MSVttdFanVPbVVT/AF1Dro3jXc9UuoadFa2lbfr9FD452af0Ek8y60K6RLLX+L98b8m/JGo4q6RrevE6CvE66NgThbQBtF5/jM6HJti3gQnayDvYiA8vQcklBGN3DJ1vZlfrRJo8Uy1dbmZ1rqWiKWah3ZRT96F8zV2SBylLPL4880NJJU460EhdNJwJju+Qrp1s6NFCV9Pr51Ktr/KboyS20CDNVsZ1X0nrZRMGjYOtLLUK/A4kP74ZPEjRsO2cYXze12noHHzbcVIuJqmv1e/P1Akr/RJ19dMz9HYy7oxxSeNxj75S9KM2tLqZ5qdv+peT6lMVVVr62jLBJ1Hm9V3p68fbU60P7Dodw9nx/aO6IkdSwTXLPyXWx/q+HkuvE8v7n5RA4WESEV3yp8XUW8sxBSWI4tcbHGma868TMy8teHlnqnfU9FarSvKnn8HJXJPkO+Z2A72b7a8jrTPQf/GtC/hG60I1pjH0/vo1pmmtc/uWpk3oA6NsGTVOsW9E4tp0lPGiTcz8a71sN+Z/UvTPvYCDCvbjxLeNK7/xSuMZCEX4AJI7ag+9E0TLKfsCaZ5n7dbqvk2/o++mEKNi7tq+gZ0J0eFyROv+y2nnmf0vJOtztdkvjiPr0zBdMiFUzxTk3Srt+x9mCfAbUABb3M3EOrsAr9br77a6VFOZUfJ+lAtC+IW4tn75yZR+sj9R77WBvJ132PJHmaKLlNVrRWPZ23V6tmV+18kWDFzFB+MowEzQ/L3km28dBGOblYDJPj4x28kY8kklbBxhgslHUYwx1PPLJbo6b63k4sEEOshDFkMSqopl2FarIjvoIyLOqodhjmnUJHf/AMTO0fqBEX5WyW97SjAw9e6LWU07xAvnF4HCI1auJyE47l+OJ85II1TiDQ9NNTa8tQSvDPHyR5nJRhneDnVHxpKuPFjycsbyz9jzNurlZ01z5r8zdlHFdOTzjeBcd00hN0Tj42aiQR6oPtsQmJpoCoE7aydfaJZGJn7xdz5J+gEnRPXmqxEOHgWgOYPi57VFyJjubA7+ZQ8aOq/ySHMy4sWLiidF5BZ3lj6zrS9Hn7rLr9FfbO6wyzLOLy5Z8hv5Lal6TTM5UNINx0UyGKni3xVfIjuDuYQpfsxoJ38YTqKGTX2Ue7rNWI+mWWqMv1j5wJ1QvdVTRWiQnJ5xuqjbQKQwSM3GxEyjgBRJtphIc277H9t5WnXFUHmESc0Dc8fF96fT0SSDXiuFTGdB/Zn8XF47tEuQsZmiYHPNRJiOvs6vc9AX0MPJOOlvcwYsUZOGjnNXLM1tmeeq3LeSiplZ5IGNgdK9gCSbZcaTjuYctfZy7348eMmQ+xpE/JOCPNth9MWTY7INhW95KiSAbrYIjRuTPkGPioN1OSoaabZdU/JJVSK7QhpYjRRX5Exr0+KgLcWj6Wwlhd8ZN9LXmd0pKE+aQ2dT1vdlDzm7WKGaQrFVU+RlUxhMm6xLp2zOSKm8dLiWjGfX4cdEzMTNFOt001zz5BlIpKZvVNzDK4Q/k38sFX2FxGwz3V1jSbcmKiqJ3VlSvjmqdzNZf6nFzQzUjIrzL5W+nuvlDx9jJFfIsAKTqHZP/ZMaRsv60q/ZeWprhjWMfjxLEV97a31Q9kw/bdj0UZNSAqnMXGXE4+DWKbKjUG+abmLuaMlZSXewaJyJJKEsMGEQE7GYtD9txfSe3eZduI7W3MnVpjFjiriDzFtDrJb4mfJPNeGQMiUTPh0gCItx5TLcz8eXFUnJ8rNc1xKBCJjx/wCSnqpVqa8s/k4RN1dNrNK81bGFmTXyfXxNTzudr4rdS/XMnyGSaQuKxREJLJjy0oE5lHX9iqobTf1E1QTsALK0d9/4NO4GRsSIII53GMC99M+Yue9fFwx3LJ1Vb18vn5KqpbJ5qinmy2wl/F3RklgsxpUVaSY4yVCTeulata1xqYebhGU/LOJq4zY9cvyU1cnN3STBjq7TfXbq/r0hKyv4OT4sJOS6HJqJMZjqW98pU1vxTqt5B39BiaWdTK9p3tZHIghG601DxdJTBsDDm4t30ucmJl6w77qZKgcc3dTDNa7eYaGuzdGmWeYOgpjJdmSXszUtTPVU1zPx2XM1e+qCo/sTzo58hjdYvtzTktxw1DXxFkuKvlOTiQZ3GzbkY3pRsbyeoNo8y7bn6XeOgvJ1VrVk1TLOq73FGpnqvV6gNowYBWDLQHi7crlRlL+DANzM7ajHb1Usz8guGJqdCTU8UW0jkncn9WqJBlrTVe3Dd5Iyzbc5Mltkr0QbZyVUwGPbSXjk15nXyGqt5axXj1eOkLnXM/HF5Kl3f/1R1/qtzIY3oQNoaMeQpxmac0sTRb3DVnOKspUSfWarT21/aSg5ZMqyEBknGQicjdN2C0iUmG/S1JFkVuBmb4RTfS40v5XKbOs0zWRYdsMhTJWTQJ8bWol3vdVIGb4cmWqfkfv1NzO256ocZOTnLMq1vhNa3vqFDx+o5OZkLMhM5HCS48qTzDXSEQro1fPmPO/wZjMZchYZZ1kS2TqN1u4iv8cOpK8aY5oY3bQgSATAy2qoDd9oWU9FvM3a7bbKTPtmNmrm/UQzljMRFu76Y4iJZy/ayuqaqAciaQqZUvUWZcCvjnJAFbn7z1vuGryVG0getn6oEX8nFPU6GcZOOprck3lXxNHZXW5oJqU6ak65opU+o7n4cXnP5MrxUMwmNbpyOu6rmabAhrVsvOT8pgBXYCF3bsZBIPsStNqAYIt7drNSHgW0KOPWbC/7PkkGsM46ooL4ZfqA8u+S9vWPYWryfTG5I5KJxxL9JMogVkv5H47FpFHUyXtrVCIg7/tYXvLysByr/wDW86l760VEIFQ0CdeJyZf8N7fjcbj8SERkyQ/95vqp7LU2a8ZVBmaQETixTC/Ne6dMvSFifvlI+PK1GQu802zpm0uKx0xoZustGkRZobWGF/ryv4ucvzXn0DUww48ku94+JbxtZOm2mjT95BmzhGnRdTVSvVPyO6FZ1rURlrxXhokr6m6TXgUoHy6V3kabkJf8kS7zXK7XRFOMa5WbXU/gfrdZlK5sMAW4MaaEL+E7KM5+iA1ZmclzltSt5UMjBVxqPqVjPjDGdyO/3eql57yflLM4axzNDOSMkwupIvMctTkoumXq91Ya+PElmmfx7fx1qF+PIxeNm64iX9Y6pSXEsh9ZQP8AfNZT8jLiYmMsSRd8l9ByVkvvvuBIPoAvV0Sm6hRVRjd/id9gBb7jzpEkyOxsTtFpH0IsyNZiK6ygNU1l0k1V4podZJumG51NzI6VdeLKfyyKb3E0x1juqmRpix+auqP9aqcoIpzyVpa154xXUVq/kxxvIwPOTLMdVdRRCcyvJup/tJ9XZXMZo0UYaxGpopLcmOvs3N/5Hp1zuo7I5yB9WZpgKkGE4d4XeDJJnMaAYdpmO1xOxWCEjD1EWY5etW1komowV8ny1Edb/R9NvToZ/tM0LonGU2XXFfJb8ghNngZd6SQVqogx2CAIUHjJx5XIVLeQqa3IzPyJ8eRydWz2HQq5R7mXn6yPq8rOFrzcyRMgo3O+jeT7V9ea31uSXdDU/loel1Shbxu2bqCxGqcBs39xY/l2Wg+HFHVybx5Mx8Ulw6yD9Yo+kTiaIY39p3F/7dMM4vV+LAwIRR551Nt1/X7HPTzfhUal/E3WT4/Um0f8d29jaw4qyTjkdVNbea/YyFO2uZjZhxlEtZJhK4ofkrXF3dskZR6UX+vI/YNoGwERy7pXumpSGZ0gZ3SGQ5QX82OmeofkmXw1j5dgXGT451XW66qq6kGdFiPMoH4E471B0WWrDJJlmOAcbdTLuZI/xuq+wzka2/kuPFNnzLkWyp8njdnMZaQnlotYx6dzaVqhk8nWbBTz5x0UQ1SVUIUVLrJY9SeD7JXXNO/xqTtdQ7gYgXMXBCsjoqHHjyBK72999HPn/wAYKCpw1R4qNsauKqn7XaykyElzI+UVVTk+XuMsrkCMk23Ad5Fog/xlIcz0rUXQ0uG6/HY6nHzAFCMzTNLHX112618ZP3D+r1UHn8UZayVySmusDYENZqrz8ndP7VWji2wKkk+zggPjJeBgkYLxZABDQKoHv2sjFxB++mZscZI+HLj/AMdBFw6jii348mSjp34p3PFvn9Lr8KsURjme4x8Rh5IYIoK1AVTS1Qz5Ndb/AOteBbWMZr4tsk7Un7ZpZ038q1WOaeqoJq+SPNYukG+6yTkas71OTXBMxrWPq2R9P5aGST/55Z0kD5hdROAQpzukObDVBAkmWmT4tHlbbFtmW9S245WScX9K85R6M11VGp2ZFzbLrVNAjsNZUayVLs+XtZ+0dyXhq60fRP6QCV9Gujaqct0x23pDAbLfi19S6+Z5oFr7szQSomqLsZ4x1jnHawDiBxk1pd1ORyTvUXWup19p8QNJofqskAELR9Awxe4vqWJWBYXnx4lPedJox3S5BTq8w8RMVxoJyfJRT8uv7FBckgjqvxkWcqamfhDqmYnJvRJP2pLmagJlhrx/X9MkVOGW2clnJFiqxUbgrN5/9TMt1caUKqeq0V4+Nmrprusw7sxDOVI6w78hhavdUzTuJN6McE7FXF/r9DBvlHQrEWtO6Di2O3O7rzLkDGSfERhtmfjaprmWenW60zkrlelKHVUozkeMlx3xM43umSKpduw4Mc/Zx68yhekhPxlLjHqpuroWyflsMh/arUUxhQCd/u9L4G0xXpqUxkfFyVUHV2E1useyyqugLNtbT+rKySwVBEgFTkCxITueJzpL/ko/ZfoL4RVksuXLWPg3hxSxQqVeKRC2nrLFNnx86LZ4AySP4N6wO45j5LmyWa5w3kRkbAjnHU0gTTJVPPTkliL3WSMwqU18pjDJccQOD7Is3NPxMm7N9ayGwvk7n+k/UnBwwsNB1OWhqiX9ff8A9i9rP7pd5IAtxMQB+64S0MFeAJ4Bhb35+6r38zkxTddSXkKIBOzuWoTqdyE8IRfW/ov4zJvHh6/xxFUTHU7s7x65yHSkY/r9bmqnRRKT9VXLWei+cneTqLmpkvFlKCPkn+tUv0jHEq07e9/jMprHjiGcVN4oqtPxtz3z01H2yFacjvhFGimpJZ+bncZgWMbZ+60ubcEECcCzaAuEYtYd/HrLNG9xSI5Si35KeTRMxr963EUrXPYL/wAeW6y9sVyOrvWskM1Vz5+zyjFXfdBUW3/aSx5DHef5homGAyS9ATj6w7riE11X1dyi/sT8F+mHDIlNXFTrGhXQT8dchox8k2MpM0ze9eZCAOQZ9MFSBxv3xpMJsbrAtJ+b6YOWnHXSz+qcjTVbgsn/ABsf5FtcjWjxKlVN6oFisnNPzSvlxFc3bM+NS9p4TbFmqDbw1LNTeapKr/xyer+OqJvn5Hhb+PakuqTJVCHMsbxp+QXOUXka6VLJcsWQWRuX6GPIhLQ45k0T+oAbNoZCFxCgmyETwbovzy2yfzS9TTCCxLZGHDdcM9TEs9CfWKj5cu37YyXo0/2KS+XS3KuuzTNGKyIpx5LZ5nP3N0xk23t2VM7yjSK2J7/pfx5Fi6xPPXGL68E1uC8s1vmeNtrbZXQqLnFdPI7pmu481l66chUpIRqjufITU61PP4qmgKjgd2hyDyZSy40mYN53IVhBgu8My3aJZ+TZkxlnRiAKYqvjZ7qiulXXOT6njmyaxzvIgxwYsdkEx3I0dCB1japSrKBjcmjqpT6ywCqWMZZturWZnORO75q3tao04z6ZIomWb3dZY1j8BJwWcJM1O2fjqHdmW5Yiomfv4jXen8ALGxV7HF4efbidGXmGJAuGcZUE2bg6DzjkcWqGujFbL8LkZDm9+EZ+INczkYUWnoDFFVkW0kuq3QNa+oxRVTLh880YtizUbjpJnN4mE65r45YGtY8Na+tZZCpncC/JCSLrvfX4sq3zWLV46+COUC7GbjJkrLKoUP2kISsfU1Qv5BIRYtICY8lLFt/rBIfspjzMqQHGRAI0ONnJ3uvHbmnrYXG+DGLvJW08wBsDSVPX4Ll3Szrbbje6o0i80DsCf6zVCkiMBqVmM05FJvq7kriisVZNK/KcHxyNhUTsWq5qqT8Bi978Y6qPIhuo6++TVw93kqetDqzr+vgYbREsD8rv8Lf/AMYIzpO3JvHGeXZ3UHB8Ti3EX/7meJvTkVomTtONDOPybqPkph7ohlM2n/FR/lue2rL1XPL0gmHcurDZX6nZX4rGt4sN2UUO7tZ7SXHuKlN8MM1PlpH7Kolu80QRVTM6MeIHG+NIS1V0/wCOmbEoqgnwKaEERSSYBh5B3B8rwAyNJgdkPTAtHlkbcea942ry5Goo/wAbjeh4rmbuZBkISZxtghRfmhrnMn/raRZWedeDLDPlWO63U2MtOuDq3yJGS6CI+TkvHpqedVEk1MxSa3f2ggnzEPnda/Jx8TJMRB1E0mTzKjMsTktOyqjrYaOsunU6/FkgZT4JTyze3BbOkw+Ic9gS/t5BnWf+vxYlQfDsqUrqQx7p07aUnJPP1mZA0n4p6yF4151cVbVvWSMUfeSag/VJz9RrdSkuO9T1WSqjLR0bmXJuSTFJBJV73jvzybKX6rPlMnKY/wBPNczi+TlX5VHput7P3FXI26I5AoQBKTxdme+xNrW40tvIgJojg2wrbjGf4r4xz5J0lpqVkiYiuhqy6Uqge3wu5EnJdEOwNcYaWPsa5ooXxMzqpMuutSjD8ddAU442VPXDj0R/1bveVo8SnC3SFbGqip6/GzzlCp51xpnLz1eWDrxPbvLPZRZb19g3P9QFghYXcAgBCd9o+7fkx2XF4RufsNJ5xjVW6O6rqtOuuSoul2i72xOq8xO9j+Djyq5ZEHrJJVSdQNRBP+R38YamJDZ/UAZn8PJDmy6/el3bLjKxRUtyvmt9PMoP9eHTyoZMc5a1qIMdn0/p8k4zVqeatoZJ3XVa8zsn8Rq2v9yk/biNSXw3+QQSng84wWO8J00MhiZSyaas/wC0zdytlU62Y7NKqzP4vLTcS1jp5yY8ehSavlAyStPD9YlnnehuTwfjcc43LU8W/Zp8xM9oY5X5d3wUpXVL8kknkjaoS6BEqa7mmkGcQY5x20tJkZSdB2VwhQJFRdxdGweMoki0cQwlJMqzRHaBAk5FrIKANDZ8QlElORifqvGzmZqqSHF9NyT/ALHUPkk8JDD1kCPk+is9AkzRfyELj3XiYNbKgPAfkZMpGKJY+1Mlbx1dG+WaatPsVNsf75lJkoRzLOPLhAoxoRkinnSbPpkB6cj4K1oplmhGUSAJ9NwBwcZ4XaeVqRcb8YQBZz7TLIzqJHM6igyOnLKfE3OtUyMO7ydTPWzpXYSlEfHF3w3piwHbMVMsz8a2VVKnGjRTHKDMIFKG4y8M1SE/4+iJOyN9XO9E80zPM8kzNfmTkrHjGj7XfXXKsGWWQyVXh4dj4a5NyJvcmLjIEZtA5Tvh+A/5D7ZZBQZstwkb2Rv/AKd63zcTx8iUnMzU+Y84h5J/0+Sxk8pyNdboPP8AgmgnmhDnJVu/Fs8t/tJ6D+x+HkyXL6fH3yrPeUOSpripLvTvqiuq42kcmg/AYZ74OysnYJtjpE1VaBmziceuemf6tJ+DChBe0iczi9oY2Rw1Cf0Li/1Vjc6x68TFTGOcZeSSprJnZyTNK3vqUNb8ajUMq7/GalmdZNDJc7rpdVucT4qZRolA5mdzs2VS6Odo1sXLPTP/AK9+Y8izt/6aJ81sDdOeXL8nQwYbJEuJKK/+xmtdEk9P6+tvPjUwPxGL2mxugIthS2wr5swx8sOQEHcwE4IT/wAhzrLTqceuamCq0icEzU93PW6retOup1Nar7pUATUzNyzMgIkr5Csmuoqal/06K/8AqV3FTjwEOOZKUFF/tZHN3kPqhwpCVof1UJqEe7Dsb+7rRTqRqJd/FSJHJzsOtO2hJD9VzjulyZRNvbS9WDEQ3tTCfqM3QBJSE6yaYnFrVda+xPyXOw0tqB8bNOn7En2mpd/k8rsDmuamloKqpZNzF9TQ0+K8a8Rp0KMp242XnJXYVpcbuDqF1BK0zOw2B4p+2SLvHP16pqr2E/IVLSE95HjiE/c/9eK88OhGL2E/ZJ79vNtJ77DPYJB+RSne61EcuXrcJMdM6Saqcg7/AGGS6DyGkodb2SIcrd3r7Bbho4YmbSZMy7ehZs688nXXLvp2QrHO1NZadWTvj5OWX5AJ4mprQDZ5o06SeowkLz8nMkPxCVSyxdWodVS9UhsjXhdI3CAAhRlC0wvLDmwWzEgPAwBlmxWwuIWlnybUZvzafq2J2fe6JmpnFUppHRyTOtgE2N5MeQS4GO1CaxnGmWj9rtkmQybJnlkpZv709NLjaZcjMlV19ITU1JXmJjW6mtU7r8Wrr98+cR4kN9T4y3WrJ+m5HzSIc8soSfw8RABjdCTa5XfQwo3zb/twt5ZF9pKLcganiWWKys89ZbDTbdUnR4anVCE+NK5k+7icdRLEzdJJJXHRUyo/LddjWuZvbLO+VI1Gjn5IpPi8Cz+uJyJWkNIRrp8Mb3+AogffzkGZK39TVoclaxaTcnLItG+/AdiHZ4GFD/V6CRaZP8uosDg+2hovZsQM0kJuQDTEpe34ndIbnr+uje5zup7rhuLv4+qP/X3y+MhUnxQzRuZIaO/tZ9nZGbNUf1NtVSOSpjWnatQ/ua/V6koGRpVHx4O9a5Imf3daqfpuiuXmp6dn9U3L+vyQACSZEWnAO31IODB1NpFijg/eOfmcyURMNL3SdnfDfD9VYqL6x0QmI/syaFEFH8zKbBuTZXx7/W6881W90zV+C3huQq5XyL2HL2PXOWgpZcdaqytBLO5Pro52sr5j8Kymxm/iI+O+TqY+gTkTwubRUk//ACbl15/ESTAEtb7Br6X40z5/n09++GGzXxfU4erll1dMOTlneQ0ahHWx5P0JvQ/aGk+8NkjfX06Z5r5HWgZRnlA08m0/J6IFa/ukaoqn5HQZuafApSVI1sSI14ZL6K5oGZZody3c+W+FZaV76rzvsJdbJdlYeFY/eGQvCQ/YKe6Xu7wMgmNBbpxgJpxhRrXJpm8llOw0izI0aP6iyWOKvLu8nVhRM0a1PMb+Khlq2vE09U6evs/YuZMuVKK6kDYNy1A8tScyRr7Eb4jJXL9g/F5LCZraaJRj/sE9U0nWSfHI1r9fXJNEjJAMmGgLQxcArFldJ30iSDN82e5zs4KNuTosjjjTipKai1oxsHQfVo6n42/EzM7r7nR1OlzE3sv5KStzWts48ehKaEcZqnqYPJrRRoOtxjxGRgrJpaTbK7mHJTvVSY66lClL8O9/kQvyO5lTHYNHig1t7fNW+Trl64pZSdKbIQQ2O0YcqxgHIvqAQ4CF/YbJ/Ri5GAvMYi8dFaF1YJWLlSpx9TUwdLRM1IwCyv5E/wCTqf1IZLmrQ7+siSUO4OkNP2dyc6lC5n/rsj65HzJWtEaSpnzIJ1H2UZipURWO70TUcwPwdfre9HNXavBpOtSnmaDlGDG8oxkwv5mVy7G0BFO0A3zmNrX03reqZ+MInE6xVX2ASyel0BX28OpsR5VCoLxy9yPEVNHNdHg5yJ9rujnqZNMxy8oWFkr/AGyHnHiqOULoUaaHwbnn5Dmh6rwKsIk4+6OiJY1oxwLFTMVrfVUb7RXWh3p/CUkD9Ao9wNoemTYPbnaSiN4MdmtZtiK/Wqy/X+zWN/UrkSQIZs4JeHwCePxcRjG2nc0jKG1b4+Pp/oE1NKcbDbP15Pw1yVlooJOfiHXM9fSPJkTTa3qyXxNDpl/I6aZmDyR8bvnV2UTy9KVTXPSEtqTqejSYCKERfEWGclxBGi4EfxAE+z/ERsQdFkSaFT7fU3oNZObmvl5Y0UeLZ3JPQD1oId5HZrnHkCqo5b2FTMppJdOOQ+2+K8xtIMgV8iXIIZEO9SCc98bm2LMaxpv7UmQoc5xf2yot3Nz5daQSaTU44UqrnX6inxLyZmdkZIMbRnKKZCtOoJECd2OEsnaQ8Gy0fNXO28cM8UDqOsRztZqVWm1+qfIbmuUk/BrH3NaErG7opW+IrzHLLqf68+DQuyVNTS3WkrcIa6echLMsrW6ptsk0aqYJ5Mnn8mskRYC/JfVptPha44atf6ljqdVrl8ogM+k3Jkq7lgQE+2YWHpiqe5YNwozyDEQLX0FvO6+OgkrES1V+Oeh//d8H18gxO94zitjU/XHR56YdddLg0BF0Ssqzva9T0Ka2yNHLF4l21q/9g9FjTG51pf7HjSowrWcJuouteXVUm8XPmOjWkZdAfWuud7Z/JA9nfaRfCnKFgXOn5eMkKHeSBkmDE6ggJquzGKZQpCvj1+ta+oj9A0XUoVG5/Ii5sl/3ojnXx1TsAra1qlZN6roR1Xn8EiniGqJ4OSd7bX6xlyV507Vx68P1VRfw8lMETPO2SbJxuudddvK7utJs2o78lB+DF5x3Jjsi9xe+dIWJ7Fi9g+GnyD76ZWNrFx1UvEMn9eYEU3XTS+AI5Lk00eLFROOQmMSEpHyXQDWtlVT14VSrklQkPobW4bjLP+xmLhmllpnwn23uTzr7TWtQ6om6HFyt+D6zaTakuiTiejzp+poHQnjxpEBjzbGP5B8ToJRsyg+I2w9yFhN6EtcnqBS6FWyDuAYetqFaryAbUp8Jv8JmfL3JuXMeRad/WKpDlTxweR3Aj+ggy9VVcWWOR8+eVh+Org0frkivM6LlFombrp+2gcZyLATv/rPlRqnQ+P1Uzp+yC2b29iDJP3wloFSQqQ83R/L2uNYViqpsmn4/jxLX0G2v7WVu6nUofbc8Hjc1sLmb8dIGQrpQ2pIwb08Kp9JBBkZX8PvmJPE1UzDqVZmgfktU3SjvxuvDO3VfhsdxHjbM42GZ85Brx+/NdaNgPyVo0JsODMO8GQx4srzOdPgMZJQNiMmQrI4RKvpWKZySKfqgCnVKEhFC71vRO+TyRRKS/gkdw0syn+RV83zEj5qdpvY19Wj6amtP5GaasZxX8VUFZNagsE6mNzVO+ZJV2Ki861Mf1id9MT5WmFmJncUV1VKyFbNIvT4l/HlYX+vttPGl9ebbRISP1YySDh8cLUY17uoaoLI7JoZ40TPhdV9qP6zrX5GSyh5O3GOwAchAhIZPtTQkNAbRmg0bJit7jVzScyU6hoOJ3uJ6mjROv3To3WvxWWdTO6J+nVblBNVrqjdt06dzoQVp5NBcKnMrxz+plRGkY9v5a+2WJstei1TuZ+SbYSMsZDmsoZJa2Vq70UbyNys/VKkKSyzjftGQOVyNPxzXClcGytj9PNUzWuJplhFLX+Ofij4v8c1QVMVvSV9aYIZ2fLs0fuGZYQyY5sJlY5KYbo8ycjABqpX+gMxclGgJ/Pp3dAEwEyEQnOxBwJ9te5TxNr3AVPH2v506k4qtT6iHKayzU7jrVTOf/SY06dRIdTU2/b8W3xdH7mvO2NOPLk6nU5BmJmCXbDqIvZO+j8zCWtyyxFdVNmSsbZ8YxhJuq3Oq+joR/wAdc3rR5sk4og5xtUGLzjSZaTnL3VoKFvUneisiMMi25mEbPI3A9UfrvqpI9SiL+FEbwsrtqf8APWMvPh+Jm8aBzkmice3LkikpMknIQkrIOPqb/D721M6PtWKoNrN7WrskbiAukYZZNqfUPyXLoL419Zx88N9WycZZZtoX7Pa9HKo60CU93myOPnIJM/v4qshkUI4ulZulXW6Ot0flMWzk8RNggbgR5Gi5kI58ok/z7alzVkucc43xrA39/rkgl2y98gNNZXV/XbPM3X4Jkfn51uiDAz8WRj5XXORto2097uUqeL/+3+HBv1FXTNV8dlGTHzIlbGLEG7JmZ6d0dtP/AMnX111zV3j4045nWTJSxTll4NnhfLo3qiiSHUrw2rsYse6TsI0Y8/Q9gvr+ulzRltx1jr5PkHrnieJ53ifk28tWmKoDdpj1OflXO/tkYJrr4neNk+TpIz5LqtypJLb9moRn9yIj/K1kytzWMYx/bfF4+DZOT7V0ywWJVbZnVxP4OXIxBVA70RkeqR3qe77UuKimtl7FUXewEgSbW7RLUbjC76MExm32eCJklJ2Omt/H9hi6quimWvFJU5LqeeTHkE+muT6zNb0hdDh++XkonJNx1RloJxgE0ZDuumvj+pETAdughab2FW3WKbZEsuXS3uAJor46IDpkByD+AwvK0/THGT7kBPD0YpraaqXqox/2rp66qY/GGr48Ipkq6vEEDjQtrGYaQQibcAZtdweprHaaQvJWMVczjb1P9uifjPP0VJKmifD+WKqskSTjZmWMVAEHWqkqprp+PdHV+Hyy6Oy6XHp7yZ7x1X0mqXJMzu+51kIyLdkSkpv5HXIp9pdFTYbg6J+I6QbzH+8k5Gq/7AUeXW06ClAm3tN7K0cW2XICdmHbG3vcgjbVmKgM09gTRRTGMN6jWGi61Ul0TIHNcVAlMbVdUm51KSSDpKnamWv/AGMeOC9yWCTs2H4U47y/K3DV481X34KpnSzSzPeMTnGxAdMY3/JJf4FThw+Znd0/JMFarqrnnHOTGxLLuUit2rX9udBhlDnuX4YyL4enVG428q9yAbMSCpg6PDrHJhmpzD98apVYZvkinJSEsJxyyTKzUS7X8DIS9f5JFyldrrfXH+PJljx8j2fST7By+GVyYmUDJkKZcrHyxxx4awDHOzUyE8eAyMpvX5GXLOLjeFv5bLK++8GS36RWVqOsZM0ySMyTo0w9NBI2sFO1/wBzuDwrCAO7HGOB+YKWiXhMjEuqxktTsf1WL1FX3p8gFamtzDybrmfhb7osxf5m1y3jbyYZ2M8MMfHutQ4vFP1DH31UmNyd/Hk5ydO6uicjM8txJ98darRHJxtQWUpr84jNGPopjspmiSyPE48lPVVVVLKcyZP6KswjIQ3Zj3FiQ1+sHYLz7Kf9Sz7s6ZMxIJZjmn5Zep8f5CXFXUfXf+sfKFUnY+SM9SRHzQkORnHkmSet6jWUul3Z1VZJ/vJs6oNRWOcjJkppdXO7jXGm3CXtqik2O/uv7KmEK6lIJmTU48X6qp+TVGJnK1ro35yOmSiTaUyh9QQAXJkN4HMjQC3xa/DjC/JEazFk+Ka3pXKzjH7GLevjfm0TEFTs3PgeuXWvwDDiu7yRFUpV3TyM5XdMvxyzdaYqZsSf35lJGU5MaYqxxvK7cqdBl7mW7oYh1UVc5IirJgEGUucUXiyXj6cm4u5S+iorSd75h15ZgPvvnxtn8fpsIIHuDDA5nA2AEEaExxFx9uA5/I6OfiwxBzqa5d1PmLtIcNZcbxET9kk6catBSAh8fy3d5ZvuN81s43ijwayHT8k9LUv3SYGb/CyZbJbjFKTOLHU6yzItOskxK/oFL34a0xUO/wAH5PjjHWU0OKZGUdXfmesvf2oD7WHc/Xyh+IEQAIpuE9s2P2MEaOHYBcWA3GFyt9RlzYyIiZtx0zhyc4rCIrnVq3JV6m261IEvimlY4wQmsMyZftGncT801MihJOOkkny30fvwET3m2VJi3O8coZDz/YTlqadk05VDtOh+yFA3JFLOacVd39A5mBqLN0nNWcyB9WAJtKpsE7FC4sAocoC5e3OmBP2jsneBfZRzqHA5CVZiIC4xVQzdRJJb3JvG7JiYYqyONjLf4kMZ0NVAVkurqSRjGkmEfvs3t1xLM1XU4701ZwZcfwxP9ok4FKbFJYGt9a62TQFgV1Khqt/5EuW9y3fTBZBGqvjGzTSHGS1P0NM8+Kkn8CA6ZRKv35u/KZwdIwBZkciQ+909Exjhmu9N5Iple5kpKxvyVqZDJ1yzPUDfLZeg272WyfaYxQ74OyTnI5Fexdw5OFefjdffQ/aoJK3KFdHNVL0/41Jn/ETQ6mWTSQ9X+Cq+m9LTUakiSye7mhsku68gOqqaOiP9rv8AJaP/AIoyVB9NvBbjC0IPO6Gy/cSYEQdTiy/DKfWv8n+MoqmGtfHkrLsSSoR/YJRz13so/vSuiseTI28KzToNUEVp+2OZOQ29bCaytY8jNMXV3GTFYC/5J6x1kyaIDHRtGNTKprXSipqKmfklyzE5apQhNCYutBUbJJxwBdfJuv0DaCiowN1FKeTskIOnYWx7CEucLadWfUaMeGlxyOTH54bKlmqi8tA+Xa2V/aOaoav8Kq7kDFR98WPgEisgZAqo6bJEebH6u+wmDdeC2qhylY53lluSfrLK4cbUpt2dzEkVu2WbXVjn6pTOQqcmSaWqZwpz25TdRUMfUuCQd/rrSBJUFWtshcPBiJ9tIL3G/wCmLMDaCDrEMdE3qG8UQQ25Sbd73S/T+1OSyFLAmk1yVRiqZakNYy9tbm2Ud3VbqnJ/8yE0kT9eYqV5C9YH5zvNYKE8Ti3FY4nI41X60EzP9jJTb1CZhofk3tQti02cfViKqxHX6kiZmtXBqTr8FOQe+PlO9rP66d9sQGJiAM2xG7S1M1WdTgJgchVnjJfElS/IrR+yTmPlBLZYp/Bqct1bWPvH1Mb4QxGT49ZMbVhUeK+1Iu55+zVfhDeGANZVuOMumqjqJZ6yPJ/jmK+pFVI9koack1OvFGSyYvpX470SZMnXJAjDLqgp0f6/NAkLkqUOzA4GAohLThWcnyId8CX/APh0HzwZZxDp4cFWYyQrsxjVUs6/Q3PmrEx1uLUs7VTj1Opm8UUyUmSnqW6xg/LLvlpZPq9S8HIZPltm3HxMZOXn6pVQTeUK7vidEnPPnYz0NLbuYju+D6mI1FMvU/XM5Nmtp5R78NAvgkOXYEYIYie2+5R0p7jvFx2vEDcHtVqivOo18sRcx4cmWdvTNxbjNolKTs+9SBu4YZccOG57iYyL1BkeeqYfDsarnj6k/qbYuH8qZJrI476chPDc0zeO8a1bQ42bllTGbFCja95I/H6cZNY27iq3IXzyXW+VnZCkUEFIVUXJy8Cpgk1CN0Nh7DOYdtK0wbXjn2/LVnHMPyPyY/JkSbrorFqdsdkTGToJggVerkJsPyqQFMC6im5m5x480Y8dcEE6d/XT8ejndeNv42urctVkfixBMiMRPx87GAbrHeS9VysWibNyfiqDwfNqWTN9qm4cfOnDkaS7tiI6lWO+h+1L+U4FgQg/IXslkowNU4Cj9f2G7vA1hm9PTXyTkxSiMsbn5QGrJuqpTp5kkzfVJK5ncV8eSepoxsVPIJjcmXHqLnJLt3cpJ1zLpdFTjPwZ+LIX9idT8qVBjx5bJ2UTTVfadV51u5o6CZpzLPx44uXqctd0c6xzdxzOVqJOf8hW41vnQdyzX5CKZREC12QpkG9hzqWZiD9IHgkMz9HqJiMbv5OrrrldVrzjMfGX9xEVr+4dI/8AyH4Llzfp/wApOQl6jXFakMhRzPiiu8tSJWm5rmwmZoqmssXWQyMeZscdHc0ZeeJFlmMc67p0JVfUctsfHzy5ExQWdAXd9F3lakb/AGKgDUOtbPxYcjg5nHJGLvaWoAjionwDb/xu5i8vSsmLxMTZF5XFRV8j+npuoxpMlgmqmg+hUl6/G3TMxEX5+I3GvsmOttFZVKzVz9bAK2lAybTupk4x62zhausjM5Ni5XwSBqtZaNySzwsVSeb5SZUNf4y7nrqjf/trIUkpU1LXOyXbAD+IZQBt2iULZYgf5AidKUR5WcNFhF7BEEHRFZndc8/E+K5mO2JNddtPkUpA+WkhBRRe3LjyOa7ZhoFkxqTC44k2ZRDYGrrVm+bRzHOK75YuAy0lVplyPOsFVlVMd5H+0yb2/XqR/IYhuje/vaLuf8Z4rF2n3lDUEEz9U1FmvwJJAIIUFEqPlhZV5nSvHY4lkYCtBLpzcX0TcRU6nvqSV+NT5mrIqa2efFfba4kSemHWcvyZMuWZKr5ST5RZg0ly8yKoQ3vWXbrT5/MEup0foIBglyXi55Y6psqJp0+Vrb4ApTkmrmZrPqZJyE2szwzzkxj5Mj+kk1irVTzJVH5LUFTC9NkrnKxJwdIoHI9OETtdiVsCwPSlp1+oxZuTV8a1ox1I1egmpFWHt7qOWmdOuJ2krwQUYmWcY0RE5Lx3IzTd7F7ZKJmsmqLrGJVrmLqS/N1C4cobjLMyG8kzV7Z5gmXI1W1KsgEd/if70TJPm+GZvJjXkpSqWx01IdG5bKmamBP4rSyu0CLflpEy7YxxeZOwZBRJyNKdmWUiax8RiJmLxnVXz8k3VEx8kwkXreimp2a/Jyz2GSineSSOnrZV1qK5GpJyhSqcvR4MYmZbycyRhd/48StZNdFCZHfn68gZb1p0OPUVVFiySSGQN/ExQy8/I1rr5HQzkpecni9jUjJr8UE+mFDdr7E3nxGpMK2OPtck3V3Gk5UjIWEvbHQFX8dX513XM1jglkl3yq8gIhRHNXAUmRiushOSKYl+3xlc/HdDHTOJaZk5TR526+2in4+nmRifs31MqFZoyaP6fJTXQynhX+jV1FOMzWp8Tl893N/6op0wMSEblybGYRP3CAWEAOA39ngmdzbfbuDZD303V3tkm0fkn+msoKJe+qy1l2Wa+uQqTdVqvwXJV45/x1xLMbnrkKhXbdVvC7RThD9m4reSnjTWSO8ZNiTxjt3OPJaskFQGo8Y7NhQhZYcJ8c+Wsc5MlSV43iI3w1SRXMUDEo6frQofksm3txAk3HtvpGTsHkI4/NwrWAGolmvpnmoYyxOHLE5FxVHMyPk6x0j9pHfKP25qs7XrYLFcfSShyQeL8NsZLpNf652/rp/B2ZXrFrohmsVfRPE01P1q6fvJL1OSTZkknihc1MUZbs8ShNjtoY3Z4x+NVzjr7V1qj6lP4ohiOGjYEk/yU4TkmEVYbWgPYLzM40VzgDfyb3ZRkKKCL1Jiy34nEP2Qk8HTz+q/Map8aNTJgUm1Z8hdL5qDnnuZ3z5qUlFeJw3vmXqLKtyMdFTqWaOrXFLTyTp39KPB1haq1L0X8I0O48OOW6yCVNPVtO60eTxomb5YVi5F7TxfSHeOT+e5H+Puno+1nrBHiJJas+PuxhHGKN0O5ap2aJuUJZSZLKqp+45Bd4xrDeThMlZCol4et8bJP+oX9noxixY6MfU/GTX2DH0DN1kjW6miutwNbKf6H4q7x4kyZByY6uakZ6qbrlFyOoYailNdElMyvP5RMCV+TR2gDF7caDFI91EWRbKa2Iw9FK0sb5HHlcjX1+dloeB6Ka6B5DwVJrwpgYscY9j9z4+dRzjueZxZMnIRyyzX1LlaySITKBXwzNn3FOOdpDkrsma1ARDL1AbN1qUZn8inLI5IPkxZKGtK8ls11LM8yzI7mt453NDUuRYET2BUsdodg4GJ2lgeIv8A+PbaWMLWTOIrV4mfjy/GIgfXQl1SUz1J1UPk/e7lWb/oPLxkCAjoom9kXksu6GSfv0FXO/O9yhmqvkiIrnnJMKS4+sgHI3upZ6PtV7K8bGYNDlceNF03kMZdPiZy9bG9UDjEWIcfQG0TxMsTjBPLBQ9mcZ31Mkfv2u+ZNkVcazNfp6McsdcJLeKT4/tPUt276lt3bIaInYs7Jswzz9UvZi6m9iblLyZDVE9TXiQrmQJpNjDiAYuHujJO4m2VRd2EcsIzMoTLkmJPNgrJRjemHLjvJGTep+TFkVZN0ssRzWwmon9yl9T+ANycbWAKOwvxA4EaDZrMz9b/ALMooaYs8QY+aoMbP9VqXb826o/yFEb1J9q58mz8SbHJLLZWZmL5maNiCtVw4pV8zqSu2f63uK6MMVtoeNotxUqteINkzJ9nxy7vyV4g3mMXKRMzMuOrd3i53kf69VCMkx3p1c0f10shQULZBh7BebbakR3VrMdpjb7bxN1a3AbmOMgMfIqDVGO/kbui51Wwpp61GqIbI+pzNfFUcsm7ywm6mVuiytK0F7WA+xqQxSdk8/ZyzzRBUrOseM8ZI6p2FNdL9gnx+BWPBO8kn3zHO/OsdZqOTuNTGMChPLsr/ry/kk2AMob5SNhczvF8aRmUX8rgYIa33dzhkanuzm5k1uceRqL0Zmi/lPLzz99Za0TxUVPM1+RmmKtkyhSlllc/RRrEvg3NMnEHPmjpeaWybZ1M1c4gFnYs2g7p6rMJDOv70K73SqcdXmuruWRp8hGwqd443Nbxg73P6rrW2lmD9yCuyZx4ud9TVtf1IxEAjMfhfOxhExEy5VkBqMuXbTCyzwY46k3H12E0beonXjVnvjH3zIkxinWLw7dzkDVa3U0VVGtlfWvs0gjuBhT45+OsXS26krhNWh/SY/Q6mKYn9hNVM3WSH5OpxTS9UGp4qW01pl3lJ/TP1K2qcAeZR2+8amnF0ZfAFAcfdkMeoFQT+jv/ACDOr1uZqtaEPFWTUHnWuZB/63sXcxcs19dUavQzkug/fbvV732B0Rx4Qr8Z1jxVXGOWsksVabMd3pY3PJ8c8PUnSmznkT8HtnFKk1/XG2y0xvVRVZKTdSlD5KOZ6kNH423kuUyZS8nlC87HNiw8CwsY5LtzA0GP/G3sP8jqQ2uLrTA5XUkzyic7j9h+vwbypkh6nfBGydw5LocdN08FX9t2aQ6nyOvxnzGz41fqww43blnV7Jdw5BVrJvTW/H9fwNxOO6pEtLlYKsukCVSZ3jrYzvmTbj0gqKQALAl4jeUHHgCx08WSsrOCOMAi7H/cND/qUxkjePHTXdr/AF6o+vM8UUD9iRZoN3ubY1olTZKsMhkpebpsfMrU1QjvcTsn8gupSzI1VfSr2snzG5puUgmWtAwNP2oek/MyWE/olCcXBMh2eTOqp4Zsa0U6rZrp/Fw82/LYF5f/ABZtqDe4wUl9EBeykFXC0WRk5w7FTlufqKywN5H+05FsanzejyaH8UVjwTPEkfYnwFBTrmrv+vPUW8stQSmnyj5FLb501c9oN86GQqqx9C6nHUyhVM68ojfGKG8lTQ0pTMXkWt8i7n/JNSrvzMdUJ+1tFiLTAAgAgbSGLLQMH3xMDcem494R1PxY01wecfe6sZdS63ejzK7kjkZeSipX8WE48hZLDm6n9OjoiyucfIYv3ve0jcAzoCKKcslpkkvpdw2OtY57OdOxkONz0M9M7X8eMa6/WSHLX9CscsVBhh61UmpWSZpECikAJZCEhTbYn+RAPlH/ABW4gXtSS2H43jRTUW/RJDFcUp8RfOvEdiVb0dcyUcs9bJpGoMaVEkmW4vnbJHXRMNkmOoGdhy72XtXxH0eR+pqQ+nEV9Q86G6LlA0HRBNAhRk2/GdSx9ohumqrn99ZFADoufk0prmf6UMJlwTYCOFkmd3tuAWKf8oKTa4SEm/zbNBDUnyySYmcSzPTdf5L3ZFfFFyRRqkxD/VXWm7fwZobwR5kmnq2dHhJkyL3Vt0O+Tmv6J/2Cq9yeNTqcLx9hda7tpbQTnZIofbaP4VJixxTOOk5hJl1r6138hySjNTVul80ieAStaJS/4lgeNmQRBb0kB2ABOJhwOZntxqc203zoamEkmd5nZ3q2q3unQBXXU6HXQ7q8aUa5vGXW5kunxTbS0zRoaTzX1rnw1nXyvF7q+wK50S7JYbt8z1VE0eVOf2OxkB4yeRUh5K55CJKq6BhfEICf9fsH5L2IWyEWhG14v9SdL1bPMb8CPsxD30dvxBeMXbPzY+hnH8tHLLOj6EPHU0BUqs/X8XEnz5KTXyHyH6bJyT19V0fTlJ0V1LWtzR+TGMySr4JpqhrS889QQydYgr9T5OSf/lR3NUxvRNxJoI3QTDNdPTND/jkmVZBk2H4ludk7CO3Pa+SHBgokqGGXupFsgq2+Xx5mlhgIrU7mrUZvuZzeJDt5oPDJj40NKj6rzqvl+xsKrE5GftVyzMkVOuRT7DAJr8IqqgYeWOC4q1pccrZfUt1HPMAG3TF6PsjklJneXxfGgViYtBx0wckzzJQzRY19ts8hsLnuMFXBAG3ItME0paJYueALhr8376m6h5L6nhIa52fJN8EV5avsvX+MeqOfNn5E1jYVWaJcdReNOrNbqK1W6V0dPaTY+CWoZNf9ZPOWax6JqQ+sOmsn2OjZJ0Tu0uDIQ1MT1TNdSBzNabdTNVa6Mmmu6TYSP7dfkxJIxfZEH7NacCEVknEBTlnZJDQjTViLTVY/6NU0zPMdZA2NCFAU108S+STqQhkLsnEqmTIU/vdUhrXg0+K3M+BPw5bydrHWSKjeh1qCdz0+a/bpnXVHNaomvxFmbNXNOolbJHkZjmV2/wCS6oB26bkJOapfxGw+psuZFs+BjUnkRH+rBIGBHLepcjRKQgOOK1KVfn/Yd1c0qOR5fAA8+TcWJOmWf8vPhj6fY6iuf1Gv3Q0z/wD6RjryXIdRxFJLvYiXuHc7T7WvWzbry03JWTHEZWymmJs5akHn7zqZmeUo3qq6etVPiputrkhECAgO+ET9YTibHKkG9hKzHHbQ01uecb9JOU8+BYlpWnitGP8ArPep8GttfFkceIb/AN3r7S1RkCTbSA44etP7NUBvezcMdQmR8z296luU2x3O1KXkgZ+s1vW9mcd4z9TwlyczJlIgFeuq35g1o3O7ea0/ky3sAfSZv6UZkL3YmZMJkTfYISAryO/PDM8wwDZ1kuKx1rZu/uT2SGprX9JOeqB64/Il+NdJLPUH2f6lBO2zWRXQV+q5rrbJuWZhPvIOJtaaSXWzHtxhP9ZZJkBKN6s/IaUlm+Fxx5Gd3j3vVO76yV9DWvvOzW0/JcMCbGLWkyJUbw760/aMz6YXMseUVqSKh/xc5JuiwvyDzKbvbM5J1U6noXymqT8r07qkmujN9LoJ+019YaePDutMExR9HX7/AB2OKjFrG9TyVRk3UaTfMGj/AHOoolndV/tRVF5DHNXruqN1z1UUoS3bzzyzYbneuVNm0wFBXBAREJFeYugtLYTPYNAJXUH6lnUzWTLk+476Zl/Ux95dva7na6s06A8rW25Ix4ncAN0m+pJ6UZtyQlAVL40P70b0yuMaXua/tLf3Dc7dp3O5iu9cS+Eracvgnvu5qaVy1BbOqarxO6vRcaV/QtMyarf5INskkIqEV98Ng5SWgJTPk8QvqBlSGIGnJIckwvPVTzL8dSTWZrdO2Rk0TNTvrYhKbyE1IOx1ZWOaglpkJa2n20tMLSb0n46yI0jxRiJvx9sm/wB631Wr8ndRMutAUb/IhxTjnt30jGxqy3kiaqgDTFaE1Pl3+qoJsAgR9LRjw7rspxychD/Gk4tIzxc6mBjZ4vp6ne0jfLB2aJI5oZ51P28DvlUndZaE8ZNmTSVP6+l6laFo3ySbHfh2N86X9c/Va8Dayl80zGh/7hvZOpBdrxri1qvk6o7/AF9aSPJRZMjpJFFQWUo0xjbgD7sPiDiBqh9iN8qZAv5hAISCY4DhK3QngyJjdI73Uxp2EszzvzuafxVc0AWNB3P+0P2xdS1xoT6gf1T9XK43OM621W5/bXhrnmWhmCDSVO3T1o19SYy48cTYc1VCzwtU0mwTiahf6ztk5U60fjdIKBUWOLZtvG1gAtFlEiT+QVheY+8sg+0glUY9/wD3NaZ11Tv5LrYVPnraOv1Q33tuHlaIrUga/tWiRWaROxGdobPCNVj53zePK5Ncobrr/ZajEbAB1IFGzqdTG3Q6NSwb2yJMnxrY1fn9UctbSmX7fjE/yw2V+UjLtpSwZ/7RNowOz8cvU18ZIUXwMRvkg7lnUPSjB99sm3zy9jsKdDO97Xqwa5xM9EnXTXLPJyaEQ1tPxsLWq1ITMQfTxSu5t/sk9H2uZGf9fu38X6iedZJ3fePm2ZF3M/uaP0Gufsbl/e0aFPdYHK5Xn20FS8gDf/iU1MG63utd9ixZZ/xs9UVNxkKKOf6+bo5yKlVBzqlBW+vw4bhdR3/lQ6LpHcpRVMaNia0k2Gw1QjiSq8rvoOqeWp+s/G/9kp3HjmKqWGZyG/ycvVAal+8xCSYytk6Kq99rU6Ofpk0du3r8+mACC2z2C9W8RYnXtiRbzYERBD2MXgEzA0bjDH4ZRPmd3LTLvvDfMrP+PTxvxqtvFHKqzxERk6Z+kYiPjHIVsZvbLCTfSX/2Iy668Szqt/S60y3kwfJM84af8mOJOmtUQnQctV+ir/DyfHhxTzMVSY5mOJrmjvjI119Khnp39poag/6rZIJiN0nCASgiz/bVx2G8bi4i/fzMFFTinQ466oyStP0cmuKc0k8TjdCVPItMb6PyD5K/REXjf6KHzfH+74uX5GmpJJ4itXs3JaNRkvBPGWixmxl5qaZX47PEGI5mKJ2dFM0mwn0r8kTqrr68XDf2m0ko1VXvHygBQUUxe5T8AoGIMrHp2fa3a2nEOM5EJFo7wx3uNEGSHPGTI1D0Q+ZzVPMPE1UwRMks0c6an6aWlKcU8BuZx7M3LQN4ZqeYqdczo60TpSpNyPld5W8VaIgmscLE0mRPkKal/wAnxstRVjRofE0L+KbKwSb+Pd4mcZaCupqaOdxjrZqXUuksXlQkC2AUy+xd9tntqXF9sgkiA8XSfjZ2t4bZWammip5Pimma5mt7WFtTVMmpRNzNUNOPrZE9XkE1tmMjI4zuxKx7a6SX/wCNu/rLlkHHUyXkiJ6maBr7DebdBY2dmTzVMiH9tr9NXWOe/OoqLpjeqn+9M0lVxDvvfRrR0hqfWGKQo42Ii08bxvogRi0QrQ8X2mw5C/EUTrJ3njavnHN/ocviZ51ckpqHjJJzpscJjyG8jU8ZPqUhYTrcUUyOGX+sxRrlJBn8kzS9l9av/FleaMnWxczjpJOaaekGXoJOdUyxvDDigZlnFcB8TdSUSVLqyfMQ3KCvFGhfwckj8KS3JSKXjtbbTmAYixpuSmFaHOJZJ0TnrJzVSVLetnydfefGW+Gh3jTdHgAypX2imdTajTj8hXWNxRkuPpTW+qLrpTnXSc0ysfivTYUuwrqXtiL7omNh4XiXIUPxyOl7oTdSQTdZblqb+O8qVQzkZOf8eEyddSzTqTzjpoKKdjLUhZ7JTeeL4ehn/iV3gSHNjEBN8LR9SYcVUELRjFMmSqk8vcoUTbuWx8kIy81+FlJzYV+XiTVYUrmoZVHkCuRtGStdxWl14Ccl3icdR1JU4LrhrIhs75yV+pHn5Z4sWR1I9ZeR5x44kgUw1k/9c3U0DjCtmqlGsiT0yjpQ/AHfIAzJ8cShDLe549j254xIJ1GR+0E+CHFLRNT3ct6teaWKTV0sju9yz5StvMzSQGLXJy/EmI07xO6+11PxUSSUMk9quRk3ddRJTJhLYdY6CRXJalS1N/5PN7h0t76ifUGHK9U+Gp7kS5rqeflyUEsfV34/r2SCp+PbIyeWEP4+S9BROLCIyUvpIvy9LM/yDOL6sYtXXPwjOPmvou6czO5f6P1qUqTsKqqs2OostrCzlmpn/HsljI3DRiWrJ6uelK0M5Jr8bhJjFTLMVMZNMTJOTdJr7v2u/r5Ampkk8TyVuZc4z5eay2zm/wCrUmTE7kdlG4kAOmTwzowHJYtgDC9pNriy0xTAYJt+XBPMz5QNzNhnFhIw5CcjujfLS/HW1oPJc6cUgbBKRr8qejSMAZESpon5BvJKRAN081GNOmWpNSt6Hwu9NXyTts8brV+clzqYrHLZy49Uk65rRUcylP4eXrsCojH8cZJxcuOMlRqFmbHqXfMzNQptdTopi4qFO0YgCVuPccxqqbhgWtyxIgvwVFtLyNuVXGTE/wCNmjLXJPLXqJNrvp66ojU0iJ5CqTNJNWxs+UvIxI7OeNfapx355Z31qtJdl/mE7zXq/wD2YxqibmiOecmHFQ18mqj6zupTqv8AZMqneOOKlrJir4CgYpBGOqvq6FF6nzrmKno3+J/ieZQGWE/TFpWIxpVVC1h7O3vsBxc6dEY6G7oIFy4/PyDEf1x1SVU7qXWOZ/R9mfDCJaz948dmEgayT1qqyTJJMTbUydVo2xQlFstFfj8N/wB/0LV4YqorUNafGbUEYz7EEDp+3IVQIombUXdX8zaweHGLNZINrX25x1I0bDexQEXCUYlwsOODfgamH4xwvsYPJ9xXHhIZq/8AJQZXYAVy13kijGFEX/Q3iKXmgJ/JvFixU1Eu8mqHtmceXLyz94klmAHX2qa0/XRMxkoxwV9IiYxryXeKtV39Tf1vmG1NfGDU0aQbjszhWMYn4aphAdyf+wxNaicbdcuNEI+jqVQXRZNwBgJRc+SpPOgXREBdhb2R4HbQTNQ7snIWPxcs1WOckmlueCaGa6b6s6bmUWPwaw3kwtZXjI6yAr4iZ8COPu5yDVdVW60U6+rJNxkE65lkMkpUFVJ5n4/s2Jk6/wCuSyWFiUfyfmSA8zJDjagrpyGpJZTI+OuH6l6ZONA1UBu6u8xOzHt7TRFyQbR3iOLEIpQLrWZ50Reih4kcbTPBpx1eQq7nZPND9X+5PMuoOIuXLQcwZSELCtqQbJgr7h+2q+8dFVAZi+KpaarFzkKzRk428BvFzpMuM/1NM1oqJNfdDLUXzEDKZST6s/JQ5FFCmRl1xXBWk8MlM2mceUiIE3X1QvpIinbZTkEiPAzUgGrafdcMXj/yGQMdo2wF2p5OZig3LypCywM9khl6yWDuZxRPxShzTKyzrm7uclv02ByLWvCHPeTHuJ1oiLhup3Mh5mPtqaOSciUzuf8Ab3+RNJmDUxxjYx5Dc6ssn75Mnmou9SfUfr8d+ZRR+hII5TIwCVttadAnH644cbCU9ZN5sWLFKw3fP+U1Xx9xMxvNrRMaZmWWmUp263GPI9V/tLYMmtWBM8TX/wCEirQ3MPXTP72h1EYZmj91IXWXqwpjc5KqKdY55omSCjq02IC7iAnJlruj0+OcWqlfm6TGpFQ7390DJTzOSqXk/FI8DeAABfm+CS9KqCpa3wFgATyBOCNM1XxTjvLF0R33PG2eWeOmfHx1sxkxB9min7CEZDHKVvJNPMZBZqDJJOOMuQpHiT/qqH3kds/kFdFarTM/HUuSirqJ5qSGWybLDma7oKj9nf4RjrFiKF1uVmSquZrTMw1qN4UHzIYzut8ui0luBKNxETzLNuDoGRkLwBvdHna50d15wpAy8yvDlnVJU5cmQoJrZk8h1r7EvmfzK8S9cVWVCU/bNixuzmMTFaP1PJbKd/tU3OKsV46nupxq2LBkumpy3cOOXXPg00f1jqE2ebzjnIW+alyHMX8mJt3xcP1idRUNbNX+67ZmgU8EXBTC9MP9BsCxGrsDDMYLWDYQx5XEn3uz6k1EhTXntnIdaKfvdEnKsl2UM7npXj7MEZPrTVxpo6vFK7xVdOjHWNmtH9SHpNNjMxPL9iI+F5oyFVQqRNXtqNzU9GtBJ5xtSrazGKpxYmTITMVWmI6ivG/sfLdJYKSdS75dqgDntEy9ijjZjsdI+ke2bIgGfrmLGNIKx46LMN1Pzg7Pvt089jMcTy61Sn28IfGTXFHPRNXU5fDNeGuH07H6xxPXkJrh71U1U1+PwY1xtVBuZSi5VKk7+fV31XNPJeumjabPNXLivLMsVOPLh3UOiavWqylRum5t4ZGgXookroU0gICe29LKgW/1OpNnvs1iMMCP9acGOXucXmb5fvo/Yw/WO4xFC1V/1kC9BzI81d9fLD46mKoJjG5FrHiakqL0HOt76vW9pKvTzeZtdrCs0nNFYuTHOslf+v7f7Om0helV2Sejxundp5cVXi1FOOet1L1X1YYa35FBQKqlqMWzvDiwvwdCQsQlymk/znzocUw4pqrGGtzSizH+OCbKgfiOvGMHrwijBC/8ddNTeptiWqgb31GL/FUm8Euw/wB3ZxJ3DqaonX26Jx11BN1PU6JydG96Cd5P3CVzC/QOymI3vImHH8YCbpqSdZO3/JiP0O5X7E99H44Qja+bG36K70xSVIUZRm/D+nfGk48o1yFLxUXkZy4yclVJbeypYO0vIzNyMmjn8L1BGGMd/JUUsTVS99jUpWS+tbWal3PVHgGp3+Y9FFYqaqg7xkSEtUvyH3AyJJBVbydurHHc/icuXGP22S5td1Burmq1FtrFQF/3kqYZo1LKfkIAfMaQXFuBBB9pe6IA0iAggWT3goCCdwqZBdLwSD/71WvJhQJZ4o4mn/LZW81K/HUG8j4Ob60WO3d6mSjGRQ0tZK7grLMZOZvq0+Ok1OSSTQr+AXePDPdbvK+cnDVc3Dw/IErMTLIctO2gUX8xn6Tt6IiFeipvHFbqMtZFpvlBBH68c9HX4hGMM8Ow3gX4APGkYpdweEYTCsOVABgxKPUVWAx1j03Wsf2lgKupqcuSyiShK68IcdMsofljH1XM6Kv/AMd+zJ1plq3HbQ5KaQxfutdTWmZ/FuSbb+rLxWPV8c5MwNVX3pst+3F1za9QohdDkefj7CqyETdsh5pm4vJkitSeMk1Mh/j06R2wCiThBbBpeX5IDHObR+qcWBG7O5zcStTRWXkMdO6xRVk1HX1ddlTVSUIXkaN6/XI0MrePGUxyQRh6Nky6kKbX+ss0OSZK8ca+jteyPPevkt0LsjHWqn48wag6nnHOt9KAd/QcufuRiSP/AF4m5mp1VeTJy96/X2qvsUszPSWjCJBmyVux8nZwdN3tx52iJJ+aEQLJaMxdMFoS48a8vh86GsjuqyVFc6n/ANjX7XRCceUyY8VsGMqHAxUdVP1VvRd3OMXUVtSe4JWWvway1iqeHvHdcTmd7xU/qe6qJ5iYugmWZa7kdWpzt/e6ZwpMv38DzCNXqsqeYoabfJp5/IJ2KAkixwdmuP30qVHIGQDensb3ErGpkjJL9uNS47mqIuqKhpZoqqiHyClf6Tkl/FmeY6moZ5ycmWsfM3byTTVbodxVTbP6ipZm5pZy11AladFEzj+uQgrZZFbcqGMqHWNGoyVvaYSuRk3kjNV5NQTPDRQ48d0JUuOKZmxovlQZKohSfpeR5CPfaNRE3vNkRELG+RxvmSYXrMOR+fc1TPPUuNcf2glxd011OjW9ht/F3eSvLNUY8vx8lVLuo0783RE+Kxtc4w23Ic3+O2I0fQMVz1aHdeXnV9tZEyS9hLXKT5ClB9Mk5sc3xREZCkOvlQ6qJ5edw6tDi655oPwgzkkAh5K8xLty76PadpgqO38PE4ymDxxZvDVWh1rfQTcvd9P36AGP1sNDVTD/AOI62S1jtGJcYc/boAqQvdRM9k/Hs+lLnLkwkzUxxRxjrGTWJyf9dJZO9Cta2wxetnIus3x1N7+9SSPJ1NVY6rTJMF/TlrnpJo+3P5nUdrw7MiHiM3EcQDLUXVhkoC0DA/ltA1EzLke8eT/FlmJ1MNhMZVECgipZvzuO2XZKq4pxaL5MOUI1cs7KZmJvS8zLGoQlOnf3lkMtk1jZpilxd8lecjkGZKqvipo7+9HM+IDYAeOIZd9RVv8A5A1Zr/b8BsOvHKcjvrU14KIEktm1zFNnN7mNhiNBBgF4simmQRc72ztGZJhyyNf0krQExkoqDTR9sl3ETpNFzv8ASRojNT1Rj8bibNV1ORp/yO8nZE646vafafJNCEk4scnyHyXUJ+7YMhUk5MjM8zi1/XhQMiSSHM3MxGOao6Pj2kbKmlrqrJX7Mgulcdb01NH4xE7mewSndAWtjSSgtQYwEMtQg0QsbanNkYIjmpaYxXVDxvqH5KrZBTzR0CxyJP8Ar8XT9pCTGkSrc9dZMaoybTtqapupPAy//P4XfXiZkOSONLq5/VktLL9nVo1I13okXIyfLOkSt6rJ4+25nrF1YtKN8syGh1PYtIx/8jAsQEsY9oRiNQw1294sBtB2ssaichQMxqp1jcVTqjLVduTTSz93xS9Qy/WgH8kK+1xLZkyIbaxuIqVJogd4hXdQaHevq5APL3SzeP48OOOeZOe80whkqRbYqejqZLpnfJWN0szGCIpCjiSeRfGxibvoKRm1NtIKSnZ+STCcAJnCgtv+OQJ0iV+uFBRcRc4nU4qWJYk1JOG54G+qRcg9yrI+LXdKRU7nsmwosmvMhVNfVy3hr9nZQtVWuzW0vGM66/Ff1EvH3j75mp8Tiy0TM7XmPiHplJOUad5IsvBrkGanmaxKC3cE77qqfOPZyXJP1/8AqTdKCIHEW29P8Vu4GkJsLX+iwLPmFYaxdeKvjHz2RDLLJj0zS9VWTIbXHYHLq6HfI1eoi6G/MfHkmpgIRcPbNczU3jao5Ch/Qm6ib3KxWqxwSxTanB21GOjwb5+OuthWsksj+AZIxg9b7nHJ9ZrJ3WuS60448zagbxD/AI+oqphi9ibXYsrjxgDvjQXDgQjuPZnHJgaKiseqkuyv8TXdbnsXTMzyzienX10a+tG/yEGYkucfOMoZYMbj1W43Orqr0eKJjLPc6mUSXLd6LZnGrjxTM0w9Sf5pe/K0NHLVJ1RPZUM4/wCyHXisnlCcjPJOSCr1PMjXHMJ39ZJen8knA8XwgLW8wxIb0gL1AHhRHykmJOD5LS1GXEpioSbPjoo1OPhpnq63YNV8e5NTRqPOnRZBxoLjr5KmymRJb+0vWPZJKdR9XqHol+34tuPBEZLrufvW8fDyfHhqlSp22MyTvST+Mjqvkxs0BbR2yyka3AWeT7fUgJ0MDFVW5PpZ8fhlWvA3u441LZIyCokAhYAEDcmdDZT1b1mn5fNaC8cCUs0pjuNldEBJWqhL5XKtGMWMe1rHINtXKwW1dT9eRuC+XqZZdVLsWpyDuaDYyaDeRAP3XUdNakNGzVAk6ahNRds9Xi+Iqhee9M25V8r9iq81XPUxzpnMlyJZBuWNwN4Ehk21NzDxO34DfdZxuYS4LqsuXJLPGPjhsnxM4yssiFa0EzVU+Wh8S/kTjxiWB/kKy46NJjcn0MdVyTJLX/U6KKDzyk5slPL2SLjmgL1pHn5Mj1vRoyY6UoBWt+YbZndzCc/HoncHjblPvRP2iuqArRLrYv5QAtsULLeAciABBlZ0K3Hbjwgh6SeBL1Hyc5MLTyFk1TKy2M83W9lBVZHs1TZXg5Sjy2k0/r/7F9T91vxlZrcgNK3P2KnYa2GFYuhynfGWOMnJVOU5qf1zLja+RWZNOjRUohkPkjYEUW1cVXNWzVdsFth0USSsidTrUzQfMyLG4pUIocIMYEXJQ0IFoi4uuOSRTHABIBzrDmfOE3VyTk51x3e6+VvHRreo8edf/bjQKaq81CcJ3J1NTJzU8zicjyrfTKnk6ENDZhEzPM6NlvSEMfTqTZJ/+Iqf9cR+9/mVmx5JueUYpWiYjpZmUDIrVyUdaPGpKWZncs2KAFUJ2zdYEHiEVqXHn2AJJyLLECbF6GPjidqw1RcrA1/oMW61uBrma4NpeyaOTKpnHtSay1OGrSqvWoWqU/oMIXpKOvD4pndsFzJNYeYyBop4muqrGlqeZ7d7q9jO5m/wMe765klmKlKT73KdVBRS1M0xJ9FdRrkFWw4x/wDGR9ZNjpVSpbkiYLE2C+kxK0S8mLNy9YahDalT/TJdnRRPUytLrz9pXzUZe3io+smSKsqxvluuiS9y44XxW5GlbWPIfdHybLVusRk1qgpE72ASff7a3Lt0av8AIqnj6+NTOPqIEel2t+Xxp+Zmf0Cfutg5sFwcJRAlC9yQSJ0kdvSiQJsflaMKwHG5BOgZ3JE1E1ZwVzqCbGZyNayC1AQg7vabXj8BjZOKCZImappJ+Tjc1PNi33SCjJc7jQztOln+pOUqj47meiGwJGyon/GdJMgzNSwPk/MtqjWrPjjX1NVfNJRTT1X11q5Pt/XUm1ZCIvODSQadkwkYBRFxAS0wPbeULQNk1tOI1myqVma+rgbmRVA/yNU1zP1gqq+2v/mYKVZsl8kmPeRkh0WSG4DNksdOkpbQkZ7XgdMSnN32XBi7qK3M1xU6gkMc5K1OpemjVo6tAKb+tD9rJkqYYJiv195d8RWyhNLZs0eYgjctXkWG9iyGRgB6P+SQDEfpMxDxa+illyTluiqqOQ01zlrinoCSYnc62NaG56d/kJUiCWdHNJVmOK54rrxskGWeNBvwbrZG+2qep+GTxj1Jbw7wrKH/AEaUUP8AbSH5O0OnlK19iQ13Op6X/pNH9uPHSD11phJTf/kzgSX3WCFIOkHHjZ/453v4tMEZ4tsuV5attOO7kn/Hbe2jdaeSZQ4klNhAYh8x9lZne+SueZtCSZxZP2cmtOh8ANdzzwxjqcVHc68wLt7ZuW7OUQkSq6dnjHJzM9VJdTGPU6Z5QflvJYatROtdI715mRCA0IvabEZBkhiCrTbSTOOckiLwLo/vOlfeT/Li2TmJ7lNP/wA1kL31FO1p568Sw1jVKqbrkqXW78f4+tbqbLN9XY7NO2Suk+vJRZ8ak8ZDjBVXbPVDusoeekZ2lQEp9po8/lea+LRjGdf4rzK76okf086EZq6JdBHDEhREY2N5+UhRJQm1w5uwFi3+vDue+rK/1azMnEXoA6TcuP71NVk3yadw60g1pzbPkCyq3P1FxleZ3U0EkX4mdOtn1ZQ/IqBqPoLEnKPMNY/OqvbVGR72FS5GZ6JfKDjxwDKy1rLczQY+PLWJAOvMbidV+kmt7SSDiRZ4wMrh7bKxtFtth2Xcj2GmYtxkunf0pHt1XhkTHWiT9aNDKqEFdbTvzW/O2uthLodcSUvjzROgeni+XVNisgkzP0AjEcyzVVVE11NV1WKoWV3pZ1XXNdKvmrmI83rvJyESAR1MbKWmzncb2jC9A/hUgMprBJqiw2BngHK0j4XP3X3/ACnUDeTU1j+3yBolO3+qZOyqorbuyZEhKNnVZlxcYjKhU1k8aZrmaOuCokdT5bmkmShrxx+TCucdG4hNsq5bx8mx66pueY8a6JuUNtfk5py496psy19pHYTTrTQkTZx41Olrw+efzIGDZ7xED/xF7Slkpagjt22QnCQUrZb6jF8lrVEhZWl3q3UiveyvspFE/a9a1tpi8iP2CkTG0SIf1ZLf14YsuiU3FPIimRdk/wC5JipX7VSxpGeorXh/uE6k+36aYZolXzOV7f8At8fZM9GXfgebnx/87mWkaMKSoBkbJLMu1om+mBC2Jk2a7AjuwGvE+J3omvux0a+r45TIalxyla8PMniVF/ImC7oq/NUZZvogTcHG0Tp3r6alncvlhJyZGWXJULX1xSyVMTXNRkbnUdb68nVJvQ9MipNF38gMZL+yauony73j18b4IZmZ2JvlURKIBlKOIxEjkS7CNABiM/oF+QBJvIumndadTOPRLCU9b+Ofkfs2Fa8eFVBPD0r/ABbqaL18n7vTrTJwmmmOk0R/vc6lA/Cx/UkN5Wsd3PlWAD6NjJNwzqYf+9GqNqRVmSdzJjuMuIuliasXm0FduuZuqyQOzHRBJao7mIuZUBxFgPcqNV3AaAhARaHP/EWuS7aYZoQt0ESY6LDs/UuSetUhNhD0UeZ5k1+KptB5nmjHEsyb2qmW475i9m/67Opo2qJ1xrdR43Enx/Wdz9Zqq27jIldardf66CdCwVzy6eZXVHFwVvirVcm3nw63pF72/kksXsQPyUbYF7bAakwPpuku8PkVCNhpZ3jyXQ1zSSV5GXJoryVIks14j6/tjb3P45xtYxJDUxkd1FTci76p89Vs0eOo8eH+uR95ajWiXr9AXGqJDd7Tf1XTXjzT5QWcYdarsYnonoqyGVejiZS3nlYXqQ2Cn7cwmsy8pRjUwXCsfdZXfvgW0N09x/1AMQzBO66ll3Tr43SNaJrlP6w9FcOj+uNjVM/VjLOM+yG7paU58HUyimvGWfcegtxa+TXXg4XJVoj/ALnch5DfJr8hyTgiY7ot8N0V2Vo01fh+PZZrVakaRNgO8Z37IebJgafK9mhAQEq7h3O+sAyiS65lVqkb5Me4le1N6n/XjUOuShcwCkvjxlV08xqX45rQLO0JmD6/1raFDVLJyoFEBMoWB9VoEd/1rQSzt8edG4uj7WU1zm11PIOlxlul5JEmDSqf/B+IGWBKvZ453BYbs9CZ3O97LxyYBP4Xqapa1yk6nC//AJVapyffeunX3kl13+vuofFjCcSnRM38n6niZ2BTK7pdDJJVf/U0QjJvdZaY6SNDztnnjnJW37bo8U6p0KjtQKo76ufuOTbJqmtf42kNE1vX1NeQ0+Rxf+bAbQz3EN3DjFhNnHgkSMwNAwlwEc0kS3XXMohLVJ5Ov1f9vrzr6qzdZZpqf0mPrsU28/5BVAda6NHnklDSw631Vq1gNqL+kSJ6ddeA/wBNaWnvx+BqvCDVmtUeOp5GemhWtyBqdVW5819vxxMJkIPEQhcDOPzLXJwsDCkbTuOx1GqOeZK755XVMta1XXf1gvYFBrxQfsQo1mHfPWJe6p1NPW1Z3CApIefGjR+Ef2+q9fE5KenYlTU4vrviNeNP6NI7ouc15U4/ybQvqiOzzLbqdBDsPCP18j+Avm8gRtBRn7W41JBve35d499nIJ7yspQTLtljGsldWn6K3PyMVLpquFALeY2tmovCYYusaT5o6nHzAUyrtX5NT1MGz6bh0/kwco3xVXMzrJMs4ar6j8kcyEkH9hv+zyzevwJzkXfX2W7x/J8YW3WgmroIca+RkdJ4CvD9KIMm4tMJcwbE3/PXusO8cnYxmGExkt6bMz8mI7g5jpnTM3MkMlbEyZK1W9Vzkmn+y6FXlhoDmZc2LFRxzivL3fKNlYyOhlaZrZoJkSpxuXOWzZJFi0r0gQXjiWN/GdJJIP8A9iAt6koOBLxee+IycvZLJM1fbTcvLTkAtQH7RXTkgCZSKk7K5vk576dhvYPZoQ2YUtg/XTcd5MvfyzJJ19X6Q2k9aL3boVx1Ojf00UVtOSOd3hWo7Cp2SQ3JTC49/TejdExCifWmDM+Ufjx4td0/GUA9R5qWsrVTvIp57CpF6Dn8Jx1jTdHyUY8gHE45miRxy/rIb4Yxs6rrU0D+FNTiakgSNwo3IYf2g6SvFiAvvGQrMO9tYfL5jOeJ/wAUaLvygHlTf/Zi4Nkmv3vYWLjil2Hx28ppxTsXIk1XX9VUZBOvKP4dZakrFmHI75iuW6BkmPvXJQjdTUBXjuDc+Zucl/GRXXMTckUcMnm+qNdZF43LPNfYCfsIRAHh3RkEnx7fTVC4nBvDkAXX5J4RQwYxObMdNFi1j8SIOCyyUdNBjD9945orR+N733jICOKGOeZq8azNTjux/S6P/smSXDUlgMA5Mq3WPITLfFyYo+jimrxjpsuSXZZLfVPmTteTHirsyS67vIZG93WiSSsdKk5GhfjocgSn25pQAAY+pNonYeBa60wBJTfy9mmQ4JSQylGcrqtPGoLCucP1rIFLmqbXczubMk6dG/8AqH4VcmEqvjJ5xXIfHxlo8TNf2TJezuZPsPNIofipyGfJU4ioyzT1FUF6lhyTC1fXVcx8dTqdcmxKrJxrn81uo7uN9HQUPwT9WWWjtmJDTciVv8ARgSS20MPvKgJiCyNJ2STCRBQdIQxSg+9yiJaW86qTLtZip6ZC+XHXySneOLNa4aj9kteDKWtnG/sTNRoLMgVDWXu15/WWx3zkOpQ8BThwVi6q/wDM9rO/8fQVMVc0yY2pvcBVAKD1J+FE+lx/Jko1GVSMe5oHIdbxUVH/AGipITcyVU6yciruyEHcBAgWPm+dtEWtxCQVogfx6Sczkd63/wCQTo3fwjqma5j7xTs1tmTrxpZLfqamo+kuy8c1Maly2OQqonldJsaKf+w/WX8V1O/UVf2kwvxnJlSkkKioZ8mOYbtBnoo1uAXdXlx4hjUFY5nl7r6y0XkQqshIk1/UjTNNhT+AMcm5/O+DChsIY0gb5d9gGMQjxm6UaJysY/lvFUjP/jyveT7Ghpa44g285PP0mpZKx1SFlWnX0MePHk80MVUH+7oqryfb7aAoKhqeXWVkCOjjFqsY18YmXLjoDRTkce22umdiVvxPThd3tTi9Vjl+2TjEGix6p/voaudvc9QhQnl/Zj90MQtgQCMhraVEbALKp9XjTEQOkyfVqKhOpwvk/wAgkzZQcnE9dknmfK8jjmcea7ymTr6sZAmZu4ow5PEsy7yNfWr8WnUWaz/x7YcnXU9lSrP2wQTVT9pkZ0g48XU11eqCw/CmRkkqcWpmtrzN3jqv/sdFclT15Xdn13MoFPiLjJhT3AMSTtzpf024In1ALsYu7AoyUAcfKO3JGvNguOYcUDPxFkzeQqZny6m5pRKumWWxkxzjp1PxzRUQTOxSIpd2F9ar49zRIBSRRWnI3siqm9ZKqbeb4qZ6xzF/JMz0yDrGn22BzSRkMM1eSRb3ONuC8mOEPjbyzZEzjZQlNh9oldIAhFE8ljKiS/uHGkbOwvtgOwQtIBRROVpuPM/JcsFDTjgS6uW2Tc5Gp1jWKCvJBpDcoqvqlvMcRK45mncsYj9nyDTkrYFkafJt2kZvm8lCZerqSuNhdAtN6xyTFldGlxm0ja7iZc021l5jHt+SrrueJgcP3mrZelrgnSIC0ctkoLNzacldtzjUSVF4sVNoZMCCO3cO9LbGExzzlsW4rw3H0JrrJVSNYqmZYoJ61+p80uqYvKD0ma5+2PVzdXPDWT+jIutvQUszJNM/jdMLkx9UZFbxlQROO9BYY04Z48DKTVRVdS1P5WzzDOFyHM/46CSacmqWBTwY7mrq66uucfW/GNBIAwwB7FeLZfjGgWVkgXt4gjnyr6I+OaZrL8erKclSU/25+JaQyS7eOIRpZ0VQUcb8zkmq4PhlaY3pJjrqmlrr/FZyvIMzXlRdQh14+xMkhxN9fpyWu8L1Qc/X6UkyxqH1BOCHHlmMtVi+/RbcXA/a+KrHEJzp1uFhTe5GJLHygR+yTi0XStpgongWjsph7NMQM6iayZcxRM0Y8uOWNVJonmvUPno8gfJWtUBWOnaDlMO9CmT5ptyLPibK+ubmp+pUuzzTv79PIHOX4uSeBn6tAk40+03VTuauv9mv0FJMr1E6jeReuxutz3XV0bx0/V8MhtOZarz9iRsemzLkqIIMFrGeRvqrD5iHchRBBk7jD8wdTjp5t0EyZOgnjdCS5jaXepr9xQuQ8+eNovebFllJ/wAVzWTYwZblkyrj85K6m4koqdaovmw3G9jOXHtxt4SmbCaplKy3aNAlM5Sfkk/Z1KU9rIE2UXWSuzIdLiMnMzVZhkTHXUk81+2qci2TLcFkIMbldovZlbgaSAiA4NOJ8woBcs4I0vHknHp+N+MyaBuye2pSpSOjFqGd/ofBFOPlfTV1V1U5ay46qSWdkU9TEU+RnQJquruqijWvxPN48WP5Jiq+sTkjhmutMNNV9chU/IvI+ZlGjaPl61kdmV2tVDWOAusZqdKHTJHIPXhregGwLWMelodzKwY7lyMC2yNi9gAVbBvOi3k3uMVFa+CqrJT3SO8nPAP3GTJTxVaijxfWTK45R61WJWqLZyEecUMGsdCyk9cbZaAp0c11YQGPI46w7bqKq5APjGkqnXNVfB1NSH+2Kw48cBh+jRDkiaspkZnJ9qZLrojnU6l2M6lkKfoAJF6TH4RAIVjyA50w7hW77KVZvfiCtJyfPWlmtxkJ1CxXRuXKldXsdBVVyg/IAb/LctXBTFfNgT5Fue6cUq3JW963JUqI1PyTpK/B0h1in5iq8RUx/iaJrU3FElzPRMbftc2bm0kBKXGmpRREicmaViG5q/v8jZDUh8mT/HND9apCl/UNuwgIpNR7CNWAFfhEQCSAjvJHAudSjf8AbIx9+TmTGVB+x627yWfWid0vPi0WOZgisWFdEzVd31Xmgt/pPHWufPPRAzyaT5q9FUY8fBtK3V8s7nu53YyydfTrng6sUCrjbj1qeJwtvg78BL8tb51/j7QrqWWdyqgRmx85wCDcNLaOUfSZ8IxtKAItGLFaWxl6axX9jMTPV8riL845xozUeZCJ6lWjeq0vy5VDo+MnJEXZNeX7DdSvZ1/uyprxyn1FX257mQMRjBp84ZtwnNk15sZE5nU74S9cy/gS3kSmKb7kaKmkD6vRkNFxRTWp0OvCyNP1CwyubKcnLRHeNTxzDg4/iNi9XJMORQ6niaaK0RHLLqd/asUP14OdP1ObJr8TXiaMuZgK1Pgdk8ybbTI/JTJ/uGJua1Tyh1Mss1rUWslMSXW2TfB5uTela6PLvR+RSriVfHxa+u9Tq6ly0tfRfFlH1nmkfGpJ8EEA4Zi87QgTjOlMDHgf8fAy+2pJDM+PPVPhA4Em8U0QTklKn+ux6Y8/tb6jJ9OWNBU4qZl86RG56qogJIefs71rUug25AFYe45+6Rc8amslXTelk+z45kitZJGRuTJl1l2OQ+ea6NVj5ZfT1WV+5XVE+Bo8KVqvx+qPlV0/M+8QUTtd0CEbixXtZ9ygRC76KPU7u+tMsGDsK1GRmeq66JrHKVdbd7KUrX4jIRlgx1f3MxTWMhyFRjHI35f8UjDPHLpSZ2b/ABzh46y4pPNXdx+se2q3kxl19b4jhrVaa8/X9q3zk613eaSa7gCct1118s/Wf8YTQ9Mkc64QpSgKlzCCMgbk7InfjTqMAMyfTg5yMxsKnzOpoiiq+tY5yf8ARWI1PXxsHTE8zjLd8xRNCj0Lt+THhuJMXdzvH9SqsKVoqdmOmpmeqasKhdghVLvuZuOsv2bsDJqesmLU6mwJ8DsXqJ2dSNylXHLH0lncQfHjon6qFNpKIY3wPiGeuGpM0mFhGJ+VHiF27aiqr5ikgFZMfLBN/wBB3WkReLFmn6LVHe7MdTjtqGG7miSIponc9ll2Gq0rqsTVDNWGRlyH3S9H+Lhnngat3jBEXyn5kz5CUhd59WQbxqNYOmUrZwcSHMtSI63JJWfLu5fpWT74iSbYnqIFN3NK43ehaNlOiJtFwlYNX35586zi2Gvs77Wa8U5zM/8A1qU1J/kia1NPd6Zy/KE/JPjmcmW6egyf6CkMWurdzH1X7CAampxQWcWl7I8a/wDZIiX+Pqsn1+Nxz4lVmpJDdf8Ak0TdwVokdzTunczOQWMLcmjVXzdTkkHU1Ouauj7odEkBNa46lBRBspAWIvUFsrP7lnU7Ra18JhBWvhTJ0DOsTUMZ1ooY5csyyZBuupgrCSrjuZaKancq/kRMOqx2Sv8Anbawj1b/AOlqSmd+BkPFl45o6xpM2fJqa5io1dfbFjvIVDO6KRLqtXRB5LmaB25kIxDk5rV6N1pcfy8oxcMzjlspAP0F8tM/iQAHH3pWwV1dbd7ETgIoK4yCiCBuWpFy9Rnm8nxGJmZmO7qeYMvMTJiOupyVfhQmS5yKKn4r4ohSD5KuzLMSzFk1RvG3FIJZHEzDtaZrX6MJp3kyVW5MgTUMppfhm2Ns5AK+OTlS/M0jK6iKjRt0GSURZWpmMNLpxnU+JgNX1JtsRMSgjUuGAnm8DLE31P8ABmwG+UttuNFrWTFknpqYjEkmzpqaJp3MuOog6KGg0UVt/AtqvTz0fGuXaq8/XGfqa7Yx/wBSaOq43M/1chNrjP3PNfUNOX4prYC7EmSXkfBsuNnb+DP3JMeo5IKxpB8rj1vqbL6OXwbFQn9efxceoEmxuRAYwpzFnvqWSCJRDFgrEgbPAibxGh7y7uaF1l4xV9qqoYI+1qNYeV+8ytNBp0v4+bx5qBrm5gxuOvrRknU6nsd68Edc1DG3zMbQLZNf73AHjGZIjzWO5d1bXyMYhBtJEBKGUyQCwNa2R1IU7XLkyHkRnm96amdaZ0iF0UBjuqfZ4LIZbMakhSsAQcR7RyFkRrMna1WK5qlMwtH2mRXEVxU1Yf8A1BINdb3SSsmc3TmxV5y6bKTp8aEzb/xq0qI/qV+SKv8AByTzP+GqcN5QqR+uEsnfNYqJAIsTn6lFu3TQazVxuuViJXbz8TrqqyhVKSx0b5qbNiOiKqg5BwVgn5Vf24jkam6uBtcJjtxZxbTO4u+GgxxPPWiP9JE/dXWIs3WOZdxZoXpTsqC178mEya1PPxkneSqa5UajLC+B2LKpOMomOoneLlqTiaiPMxT9iqyHCka6B6qaJfwvj+PHjgrEeMU4+vtAV4OsiP2KKSmenqfJqvyXVyURexttsM6pq1KwzbChIKb22lAprTJ/TcTHkkltSoqqp/tseqAomQGf9ZkyskRj1t4mqd8z5hnPV7kK32dApz2S+AXsms2SvuEvlx7yzdT1Jv6z8c1GSevEy9aStn42bSfkoKcgLTLkqWtBNOp+uPlb6nclKtb/AA9WLS2HAiOItMoWWpJB9x2URhTMq141WyRlckZCvj+LFut9zCFRsU833zjetmgSVKn8OZMWFnE/JC9ZMbfnD3EdpRSH/aZmvqU43ekfw9zU8RVSnU5GhxtERKwdVtbfHjyhy/06VZdRck1U/Jzvy/Fi+Qx8ikkMrNEnl0ftnx+SUWUnDiLTODEA7JLUECUSCeZsLQsO/jTHKTU+IK+Mx1NDr5qWB+Vr9oL3VNhK1uqMdVpy91f1Sby8d0Tz0IzorROMe2Kk/eos3NP43LOLGSV8fWP4rl0WLt6nIFU0v2omZ/pH+TcY+kqyFy2zokqai+SzJ56qXV3/AGrmK6T9lH9dLJDQAYsoSLP2QGNBDyIAi2ynHB4MWQZLMgR1qj7STM02mxvw2/5ejquZlNviqllcSPjNRAFEQP2a+hM7ys/Wk4kN9b5QpaW44McjPPTjFfFXa8HWW4rxIgUMpqmdVR5XeNYlnWRkMk0c11iDxF7KaqtTqeBSgdUd/hltWYOMDaGYtd40AWBcqwbsWNwGWCCBDB0vNFbisWuryTVwPOPHFPmbIg/xHIXNIQuvEJoYV7WifojNUs0rLVY5rmNfZJr7P1Yn+u/w7nrfWSQcTqa7Z5/64+hmry06qtnSTUzU0qC9VGM6J5xxchrTjx7+lJu205/xpxy8AH7kkCQY2ujEkvsPb/jqSZYY4bxQ2xYZBMOI1EOrujVf5ddaauKoGKda4qAFqdzPnU1Rpc9ZNzzMM0L55+XgHK0ZDqih5kNRfib1r8nDq7qm5U2s3tCggrJJafrySdtb6JNH1Xls3tbTqYK+0zoTHPyN01UXI7XzxJNQhX4EwLzhfY/o3eGtFSuCb2Eydha1RFpb7SQVWsmTiKr5etXP+Jok+t9eK34ZxkEmu4Ufw8v0IJmUmP7BkmpJ6qenwy6lnJkN6NbHmvzMrTkw8pKcT+3lFmpvJketm4ZqK1Na8jTWgzXkqtvOzJMgdTFcnJdENPhp+yBrX1oU/M3BiYASBlWcYW851A5vgi5sRJEYFodtxmaqIc7JZM5fBjY4JJ+OnTTdaGt7pQhZonTJZJ1OSJblyy0xYY1Z+JK19zZziAeq0UfJ+BRzkLLL6ovH0vM413MVkkJmGwlmIIelEtOcZx1sormq7m+pC7ZnWKGlr4q3+o//ABSNUUqBJ2EZKRkgGQE/q8AiyDEEgHIZdwrkDaWAFlN1McRqkxY+vIt1Qmau3g3U6nLRvt1x42xhGctZJ6+1XMeECvpc92MzUmlGD66dE7qPwkK5WU3jjHtrR3dOirqptxgE7gx/rnyy7zM3L6fDESrqK3P11qdVS1M/Jk/yaysnjzIrSnqUz6qYFNxKZCB3UXgyLjNhYJZ2BRF7rLpIvBC0TX16MlQdA9Y8lVD5u2ZvVGXQH1nXOk+zm5Jlp4rThkJ11codFbQKPHyG1koDcL+ZXa4zkNxM1BDRKpyzqtt67Z2dH6UefwJsvFE0A4rmbq5n/Jc0D2Vu0XJU5GTbUzCHPf4mQSAe3sjnLloGpTjSPylAAfmF6SQyLi9rC1gqw6f20Z/NTuSZXyVWtuMdUVEk+WXSy/krjQaO98rUExDlQYqr3vplpuvDJMeEPDOuqdAMwx8mifkvw6mr67q1PLpuTn+x1USGKqihTKxz0DOPJkmZ110QxvvkAQBj7ftfY3Mb0+Exf6Z1AnhsQuJ2WVuIAE6VN0Z3HkmjdWTseTI8g3dvlNvGQ/8AtftHZY8h83G52xkh3HEl9EfJWQ0So6+SAWijU0AlmyTLKBX/ANjNwzqugMnZyG6lx/JO3maASY0JrV0zPdXUN1O2qpOcjcofGVKHhQ8aupEXqJWUQDeQEQ47cyItpokiCCE1AYVm+J3MaG3rmuYrhjcnianm+slZSqqaiv3VGpQbH/rgQ2NS1dYlJWXHNVVZI5ZuHQecI/5Pknc/Ug/CYopZoqkck5HVdRoZmbn/ABtFniWGGdvnzyrFFM+LK1kKBZ+YxkSsvyc+JKAJN9LUoefymAThgEFnhPLYYYNIshfQPK90IZxmwaBQ7zPx3fw/5Dr7t3yFMnPxUbZ5+WmfknwfafogoZf6Y/8AGzP+PG0GjflHSKQk6utiozo4d2Lj/tj0aJyFTGtmyqgkHc8kv2eXx4osr8jayVwQcxBqP6b8/Jy0MzsNU+fCa1voXq/FBjA4CTJEg+cSQAkDvGBYrH8s7lBd2uQZ4SMM6mRkip0jh6rSzQG2eJa28ilYmOKK27vTtZ3OWqGJqp+hEMjrVWVtk4dRGSKp3iyL/wB6ev1io+46jymzUFMark+vX4UzuBrUcxOQ0cTbjfqk11XVn+wGp3EvkfxBlBGJYG6S7MIGbhEIaRT+itgBr2N7PcamCcbBKwv7XmwtI1fy+SJpPsVP6P1W5ZXMy3bJv7VW+2adcLh+x5TU65JPCf7h/Ciox/cNuTwmQdjfPLORJZxyjI8rub5nWj8hrV3U1TN2GSKFmclctXNQkTodb01LtSun8ZRIExBCBQ+UPtyiOToVgYmwJWFwtsKTjUFM46ji5e3GVRVMahl3Sz1j3vkJXXjnoUDHLywV2TamSdNckP8AarobkhnSSctA800fjEFMeLV1oknUzxqo5rJlreuW9b2G9soVP5BMtyfIPGM771OPqU3xPgsCEdpTM3i1Tr8k4VxHF6LtDZwwkRpPt+0NfrG2l48nUbg5oQRkx95NFGUK6bZ0tryb21uOn8MmYduSRs+Te4qhalYl0L+jiePtpeiWZ/ClageUoyEsTJFLMkVdzpplWfoa3Q43yxsIIq35Nkl3lK8a1L9ce7OviuukrHjkPJMlG/xGr5aZZC9osLoISxmSANPa/MRcD9/fZl0fHqusfPNPW6PtVcC13quUpI1JsSNbmX8AzEiV9RPiOoo0+JndUJJ4rl1skZ48fhJVeetXjovirHqZiR5r7fJtT/FWpWdM/uvyKQFyko5P0QPW/HZKidBT8izqzzvRtf8AcCnicCdkS3nnOlfHP23U441OSjIM7kHGbokKtmRGUmm6WppoRoKny+Vb04wZX4kwU/1mvreqSlQ2ENp4s1ZoL/C/cG7mfr3q6nc4/wCl46pBnRoMaGz/ALT1MASpSMgB8JXFBt3MZL8ss6a1SNbOiVKfwMLmD9EoPHa9iNE/bHuIfbjstYzPylzFXU4yKtds1PK8M7TRKOWmk0+NzoPNPiSeXlL0/wCQZWt4qdO+TdI+NTb0iALc4uHxX0YJJFqvrL5NHG6CrSXraA+fyd2zzkYN4Vg/tMmh5ipe+T+3bNgNcvgPzKpDuJqGAf4ZExwlIuIA4U4vybnMZ0sacykf/GLemXbqCha3zRNHTvnWmUKKPnC9zWwnINN3PVRKGkokrGN6KlA1oDw/mQCTky5Dh0Y/HZv/AB6p8mW8nk0HTp6rdIfiVcmtr0ZJk3UgMMSRVVV3qk3/AG5U4Q/t+J8Rciw+1sAEliFbTsPZcWkhYvPvoqvHvzNp9uoJGjwDQZP+s9fVmZoHmtIDllmOKxzzjlxbr7KxpN5p81wkEa3MamRKJl/MrHV5dNTIFVrTE1Qx2LscnbBR/wDVG/8Ab5zLczMvivExox/qvCXpdcLL+0NS8yD5mL+z8IHhBbtPSfkIQe4XdyrHcaGoEn7zu6q5joeMadTLabxjkJeJH7BPXVB+YT9pbpAxxXMhE0RUnNL/AGUAPAVpPq+fycc7yxJYv0qKV0SsBFbl1P65mJkaKjfSZPyLAyUdb1l1NHW5RnnH1pn49H7meQH6nnqSSR58uLgImLg83vpDzb6mdweUOVMnJrHB/spySw1Kka1M4rvJ45naBx/YqEKJ3iS9jVGvkevqGjX1qudsbXnk1rcgV9vwtfL13HxQP65lWwIclfJXVY6/XhHUg6rH+B2w/wCTdM18cXynhJAavYlu63v9edb/ALLAsmwo2I2LvYT9CO3cRPCEwxhXEmLyTx9pKZq5agvWPFj2Mox/XTNSdTXO/An4Jjn5FmpkyHe9QbehmBZ5raDjkEPv9vsH5E0Bd7mE7nVPy9PjgmPrFY5WAZfBsZHSCTUTHeQyd/HzQFaaJ5isiTMyfqziQXc6dCoHs9l2tdEpTjOjEG0nh7JeBY6nUSfYaq/oXkNkuT/X7D4x7SmfLCzIRpC9RWDHVeFF+u5T6zBd0aeq+po8BU6/1R3mOsUiH1JqiPqI84t1vh2lLet+GfP33NVEsoRtCT6/Utd9078bSnatV5dJv8CmUTC4Yh2JJOL7C+lY8Rbn02Me7MHudYNSTX0vq5ryf+qao47yBJJCISwp1sl3+BkNYzoa1XJ51qRdtIf+trrX1k3J4p76LJVzyzPXRM1e6Z3kemnXOM15KTfJyp5onLpnCeJ/UwrPTvc1268v/wCOteeTQ7QaBEwvCX1ZvKYTnSBXeMq4zHGYknSyA12khil811FGxmadDai8zvWq46NeBx9V1TOg3hlTUggAlFAKKkfo/wAZ/WqIjL0H/VEfv4Nmjjdbox+dBqSk1zOhWGWyhvHvVAPN/wBp8lWNTvpl+49Uh/ua2BQQUO2divoAE50yRvKfJ/Q24pQV9TNPgyBk1WNih2xKagvJxyyUOzlXxWu/CNRPVa/XXyVkdSblkcY/pPKTzPLzUdeT8lXx4Xup199B0xqK19eR3MoJvf78/mZSknofoxOw5ODS7rau9T9n63JPh8flMW+/C/OJvzoQL+bG/bynv3nSQkyOXmsf7KGa4u+oSUA8a8SXXRpllnWm1lGPMv8AX43HyFPh8/ZaAfrsB8Pev9zFUqLOl32gVdhAFNDVCuy9DTzJp3+Jz1DErTKCUwBRzFdX0vT5Eak3SJz0CoEBZ/UrnYyvd3m38tkfl4O+vQMeQ/rApOOjJQcNBp6nHaw2taK0IlfXx1+MsisfVPJP3mpxwhZJUTXPVFVNBehdSU68P4v/ACYyPjsqq5ls/wCl147rJLy2wB1Qoadcg/mVEY95GGXvq4sLmsUrTtnllLnc27NcvSBP59OCRBUK0AW5nDDzcvXuUmL2GbXEd/MA7QDGZGsmSqu9ONKeBuo4HJJOqoGbsMl+KNzVJS8ldaq5d41xnMrNSSnlTYvl+STgmduqmj8nsuZZ+r4ws5X7zW+uqndGPnoOolXfKE8P5N5PhJpkyd1jLLkf8lUSLewjaXua07laPKIPSjdQzeYi79rY1QKF7G8xb6q5sPGixzjmOU1kxve3ivkYmZJVZckNP05Dx/jrm+Lcp+SKxY2o5XJS1waxgswUUldWY6PqJJEgEoq1olZpr5DnS+HfTLyJjPtJZLqK+32laIi8neYlXJQZiyeLJI5yYpu9zkrqTYHm+nro8ppADbF8mxzDGykWC9SjmTbZ+7/cTqxM8RuJjprcRqszMVJWPI2Gwxo+fGj/AKfv8Ev5NlSvCenvH0xrJX98jP2ZN71X9Vebk4LIx18U1DXbl2T3NpjnIT8c3amplKnj7a80Hk/JyTVROSLYuccUoajJKPc3zT1VrOuv7TSXX26qnER/yDxH135kmDp23IQVzYxDhCMnKh6r5LyXWMqL1OSfTvO3pI0liLcOokvxsk3Cw1Uw4pMpe+3JUY2lmcfaESW6fira9Y53sDwTOzdQzUM71OK7+GwlbSco70MppyDv5Opk0K5VFHgnHU5IlqcZRkyy19jzS9NE9pLkOor+s0wBLJm4aIUEAEJT9xjSJqcxABZDguOQV541G+LipSm8ROQJSN1K1ncv+9E6vNp/+NOjTcl3rHUHgmMeQ5pWbZ+3yH3dMUOSz/Hv9Xq6oDJx/dn5Mi4y+NuHslnHdVPJEPZUTFUI7k1+HST8dVw042SyG1KFc9o7NHc5PBQg8/25ARa0jPaLm4bBiwOgVQNoWwnueyLCCJtosdP+jgxz4m/3uGX6fZKqapOtD+y9z4EZNxWSv746zB3BxcU6qRrzjkk6dH1HVYa8WDfT0XtxxqseO5qLGcnZrupnbdUF/W255vxkmiZtHJOW6C87EvOXGdf2xgzU2TEuTI66uK1OtwVOTIgy0+yIgW7LaFaGUUsC4JSkAAwFEHfa6ehx8YMnUlDlf3VakylR/iqiSax9G9DaPe/9SW3HctdJd0Vo1u8cU76xVvGcRJuZNNVW42uvyrzfwlz9fjSqDGfZgapuKdz2UapDopHU8/jDJSb67x1L0fsiX/SRzzUDv9stKnexFTDBSMi0NXlRuRJ2aNUpIdwIdhzdyIvpb8jqiWUyQUjqsllO8r8lKwuurlOqompAdqmsUVTjwu3Jy0uguoDj5IqN4h2LyPTvVafx0k5r5RxTGqS3RfxExe+62wzrWIY64ZeXm/yvMzVg89GTJe6GS8c5PrjovzRdHhCZQ1roFDvCvNlDQUXj+Eo+oEB48gMbTBlQfKOrfEmIx+cuLYYqa/8AVdxQ4cl7JImv0zFcVux/JvfjnJtrHiigPknHO6MdOYe/68zS12zVjLCBFORJU71qTluY1R1ORYqtM1tq0A235adTl6wYpthpQnTuvtT12IzE44Zuma8EzsljerBC4BCElWyPbsgnGnJCQgK6MIp5gBTcDRcYzJ8bZzkisn04mVsY+E65ebr9H+9E7muQr4sfNVjg/rkckX5xubHGiDiuvlAQE8VOwN89SOHNke29nmaSZOp1TgZqueGn+mJVBmUpH8ZUwxqU4P8AIQ5WS8Zss4T5I/rjkxn/AF80aZn8kFlhRb6C0x4830ryJRw7Q0nwfcFX1OPI5Gp5j7ZPi2zzBledZRt8NM1/k53KAQj0hVJ6nJSLRPk5cfBfEUGQJkx1qoEnqr3VFDr8ZEIqayFFPlMrjm0kNrGqxM9JZzJVPSPiPUWhEQzOSwly/fGQ0iVb47ylFlNQh+6StP5Z/CDF3+lsynP00eGBa87Sx7rlg2y8E8FnP1DN93fWP/tjDg+nOtc0FU2zWnxOOManOQjVVQ1LjedBUwWUJ9hiPrTTRRJR0mslf+P8RleG5+wOZnEn/epJJiGJbxJrJKhro/Gb8FpNlT4mJyTDVSBnaHmW2WKrmqLKF8blEzERYzJ+wAVwET71SQ4lzz58bhLjQOPDGr61TmMkXLNbL3x82RKI1WxkxnQpM9ar8OsWXE18VNl3NaTqccX9pJrqcZkKl4JGH5BkS8ksS4s01e0yf/ZbyyNSgM8y2rMZNAA2LcqtdK4+SscbayCwUyrRj/XFyRUzOPndTQM9Eq/v8QAgI70mk7Jv2Rsw7E6exEmER/v5mZsRAsUNQPOTRtJzo9Tabbmud7Ymp/62eJXUm1As8zeZo87Jy02mJklpywaPjY1XGpfNbGg8w9IypLjmHePH2Bjx3kL/AG9VSTe7/wAh9vFSaN2o9QpeKJtZx1OGpxlEbFmZ2Cv/ANiL8RFGhHyrIAp4YVroACYe/EW0iSp24c42/JcajDVNYmIepE68zHO5XJk3uq8U41rGeSWpSh/I+848LSV2nVwUJJZxjyoETxxRc8Oix0bu0sMfFXyQ8XW5d7/x1a0Y6vUxxNT4l6RXXhAfmkMeKoNfWYuVpHdNbWHX7BL+vPX/AGN0wDFkR+oAO7xaIFtSBAuLD29Jtgjl3wFpORqk5EqckQRjpqNhqid/J07UO50zorQb/My5MjOOOGdhibHIPXietdCSyWOavt4qtPLVTKxfV0VlqYkNF4sPRHFFmgvxSV+/GxdmiplruqneLD57j++U3Jclbt4a56qvql7lfsUDfuDcWsWcAI2yghp+m7jbINnwUiibbLWMLT3kxbcG6CoMV/46N/Jz1WR6275787vzyZX3Jk5knHjrknHEZJxNbaKqq3QlGuYyzNIn7Kzkq/6ujW3F1kMlAbyTUBbAzWtRRJr70Ru/x+KauRQH4tOJy10a+1bLO51KfHJo8k5JdfhTWJAt5we32KYQs9OIANh2TWES4NogXgayHH8ANGOi5bbEKmfjXHEg7lf1KTkJ7JBJarepwz6jGPp8jicJrHeODzjcY/HkZa0U8fIOvp9cjpH8fOWv3kjrWQgJmzdmpnI7oVXaZddyBdzvfWTjmMix5it5Uq+dz0NYtScOklDG0zt4ftMBUqxxHcAJY4khW0pilQ0fmt6TxdQ1nN9Zg6xenxY8lbyY8kzVfa6dknLK9XJQzHivl1qp65r8O8vc14/rR3ij6VSDFZedU1Q3KWf7UyAcUld4snHN+PE/1mIm03j6sXTJVRXKc6N062ZWjgLmbpjpimDrzc3ecpPu+K8nU6X6+CQUBJIAAuCWEp3FlcJmS9N/VCeyBna3/LUbqMkzQdVPxjMJzl3KvzLra3/7J+2hLAkGMg/LdWNrdTIRy7WWeL3MaUs7dfpk/wDqfyIqZuar0+p/9fyu8n+S2cnc49Scyrzlq/E6BbnS7Nkkgf8AGVzOOAg0dAmWr3fmTo2y5GVb1W2qCPYIK/0YZuo2WkUQdvfLCUTzd+NKlyXgjHUzhpySW9o5D4ye6MmPonI7ks0UDi1Pm6CKxYqbx42ZqySv0Td83IXNR1hlnXmWtikp+rE5uRhktExdVFNSRzxkL6ncR0+dT/00KbVc7qma51ddZLn46sKlI1c1N1tfJzLqtPRJ+MykQTk3OFjN47xkCQnCMpgqAu4ME2drx18WPJWzdszjvlt1l1UVVyk/Hi1ejTraxIh+A4sfgK57Joep5uctFVGS3Tu9nJp5lqSpdJmPc4/FB8mSXox90Q0M9rqd4WOdE7KXfTWqNnf2EpaGUoreLUtDkmaeMYlckyHSDulFdRgbcZ3RsgDN40blyw0gmvIIIgG9saC9WzEAVJBSUx0Y2pZgRabNDUk96uOQmqpNNOacbOpFk4hN5ZiJK80cR5WckEsp5o+NG1VzimeeW3nHLArS3LHWXo1dgzX/AH1JJKfquGass5/kx+IovHYc5KMi1jmmZbvyM38ipsNiv4Vf8QyXKlBh/mV4tqSTB/yUptP/AO77qxC0VXmcF1mxs0r94663OKaD7p9XzVZAK+snP0p/IDHeHHNXMvxzUyJTwLXOanqo8abU1MxU0zfOQmp6qXudzp3UpMnSGHVDL14NTqKShrmTRX1NTqzqsczU1jJmRrr4sc1PmbnfA6a+8pU3GpxghBNYA7ZKi0gxabSPsBMESIRN9rHB0nKYsXM44PFTiahyTMh/QuzfXmVy2BTLJ/pqVFJtF18tw3M10lApkyV+4Klm7BqdmwndBtf/AFww4tyBJsogvqZMnN3LU9VZFOqL0B3j1WFy2vx6V+Enk3eWv1lku9z3piMm/qFBH11+STEYiQlZrEzvidTP/FeYSFiB4l430yXDHaYiEMtI+N4zl5itwfsOJTZXVU1ITNbLwYKX77Megm+uXW4q0dRjMaXsqo3t2eXHJkcJVnxU38eTIPVeAmrejJXxvGSayHivuEHN7eZSYg4g1OOJj4t4pfpU5mqeTqunfmvrTQwgr1MACLT4XuRZjMMPTdRQgyrq+0W2cLzoIMu7axd25Mkx9ap0nX93mfjE3D+++P27/IqOfTZKJqPoP3GstaBmmZ1J8VRcl6CSnYSVP5l/4pbxFXg3rdvd4Go+0oXzeICt8/pPD4K/Jj1OOMfbQSyQwz8tOTxt34klKrs8pO/qPUktBNQvpcRwUiPy0jSmLFDa1/BWzJsDbUenpjFMvmrqsfSUVGS8cFbt1rEOzwf4x8G52Y1NpNw38SYpdfHFXOSZKuspVJk27sD+vkKxzUru5xEZK4TGYyyI6mWqL+Q+xPUfcumhF0lbJ/GRkWtmmNUm2rvGVRXzSKcTzW37VHUob5dwwIK/ZAD3wUiQIBWpduDAQ7eXhxAEZSuRnIcJ5yY+qLyG5nqYnHQJJBczkJWBAKyFfhNjix2j8V4ZgMc6NsoKS/RjH/ca8RffP9fzD46Njzzj0jRN9+GboveUh7DWy62DLHKq5iO+YMc3nAxUVwWyhU1NaxbTwszYfIeKoPxgWLj3kIYvIH2vdOB7xkiMX2G8Bzo8p5ElCLnEzK8vB9rqwbOUfNTEswt78EhNZKuprGmVqoqjX36kg25Q+m15qQFokksaWVlzQr3IP+I2VRGPzrJeSfq7qaOrW2mii98/ipDLuse5yR9cuMpmshLuw21VeWZ26TbF7Eyfg5gmOTNg4bPtjnU+ooDzFrhsyVyVyLjWNYwnWBNBgX7ENfVKd0mut1N0fXKLM5NO4gKX7s/5KK71NfCIXMlvLG0JZ/W71JWu8yrMiePrMARtaU5tRqJSQu6ToK86Nv4vJGWnDqikjqgmXHkx6m+qpf8AJdSXNBc1R9meZQiqpYdnA4CSe9vC1PqkABwBx9jLfbnUxhudc18sVk1Fd1bjm9EvZvmuDVY2ORoqv3f4eZJx4438bTON6nc9b/8AZkraFKUDqbQUlNfmfV3LVYyq73VzO5+jxp2EeBhquU6Pr1Kr/wAWXRi672fI0OOLqUPiHIt1dVT513RuK5ZLqHYOO8lr9eCIxBBUocLF8C943BwFxMo5k/8AqMPH9OTWonzkSvNX2TSLfNy7Ta1ZhLdNZMRDXLPN5aUoyzIEA0//ADz/APa10OPMpN3jktuZlvf1umHV5WpqoOU1zXP1llrG6irCfuRsaxeI+ravGZyPg399WHjhJmz9IyIJZyMeohZvxgd9S3ZINT2/1GzWjL3s11YuMZDTVTEtXV9DvRvJ/bWpoFFqTkYGnHUar4MlP2/y+KVrKDqNVq5dkqUFTbRcvyN7GnG5K6qpen9458TNSkA45QArz5BC7zSAW8VlnmCad47Yru99fZkrp8fXdW81SIExzcXdgOAZjw9A+YXnF7FTcIREve0OXrEj1NfXFkut1VftrMTWN0a3LetTy8hMD+KmbOHUKYh3LMzMSbnLddIZSnzvH/ai6BbPwsak2Hj48NQO/rU6noicm5uurdNbrmma+01scZS7iuvq5S6CKnGjrFu6YfH1gJrH3dMv9fxv2PmPYx3VwMaHOJkKNoC8yLNkoSUY0WpqtpWQ26SA+sN+Zv8ArLEE1N9Ot+ZU6wYz5a6rvJNRqlyS6Jx4mo4JD70a+5JNwIkzOOlH+1JKzW2HnmHVW+dCLDHlqKPqx04l1c2ZBmgrhlv44Wf/AF8wGPJDAUg+b7nR1JBqYi24HZ5EW2wNT6g2R6lPdIPaLBGLALRZDjWweScRePenf2Lc239VOqsBJ1WvFBkRj+SrTq8kfI10anupeC0mZld8VIvVOtO4/JEXceNY1fl6mlK77mForJNUbX69FHidX+DdGKIbuMlU4zGzEtVVE8mTfJJuaKxsFcjUlb6Ze9ge235zt3kakmWoxYCmxKZABGIRbZL1G6yzJdfHxPcz5JuJmpqaXVZKsJUdY7g5Xr8dk+kwjj6THKsryOucmRr/AL7mu3TemVOaNjj3jmR5voIx2O9fLPifmdSzNDqORChnVaPwslU0eeSQxU0+LrrZTtT76prKSLYmp2/iJJm5PMi0C30NyPAzcdhtgbC6UmCgkdTplmo5rvWxC3HeRalrIch/8SaUKOZYUQY/zNY7mVLyU2pVauf8aAxbuQOdaaQpan8mMuC61U3z8nXyP9d+Ax33y1DTo5JWhh1RsQ5C6qQr/wBlRPhkWkniu68Qu+Q8amjmaEZ9QQgACR3iLDfPMW0m/cTd2XyoPtPYxpktc0hNz3WN3FNvbPJy1Ncxpo87h3yWllASg/YWrHEkjWHHsCkjRGiGmJF+zYEsz+Ezk7ujNc40WyT+v2P8fcwtRRBVbTcrS7UlgRiCZqI/xfr7cAb34XVtPnbOn7TRpmKn1WM5qhB2HeLbrVCo1QbAgBZilbGJlsS9tBWTBUy1U1bGPGVGNJdaY7uzVd7peZK6netvX5iYSUoVmseNdlS1KarLdSlTvqRxv6E0efybw84by6mfkoy464+Vdlcy6OWTc1xLsx71Utah0Y2ccDcdVjrJV0DVtY4OW6J6y7HnQGug2gUVdQ1RUgpcO6S4ku17B6nKOwwTtgNFBcgedV+ca0VemVrd1r6y+MVVYFDS64iZoKk+PxSUjX6rHLMFpyQZUUOOimm55aomXICfrQsqScbQzLczBkJDrNlqpLur2kz1W8geWSTRMv4FxHp8XX2muZkBtXoaFyvJJBKpAvxBs2OsmQXA3j/xEAboGd86m/pMHMBiEFFsPiBqYCRRnOt651HWLog1FrG3HQjPHEuqoS/xLoqvj6Ic0zWRhHdVLPR9oIl6m7n6xSkGt1+Pot+srvcSzGpip65Kmjgqtal5BsraKs/gdEI8/JDUPxzCBkciF46XkkJ+x9gdb78laA+pT2fceZ4ngDQT/ivSYMwCflJV0NofaTrM0VdQc49fDIdJ8aEs/J1XdVl65Z/3RXLr7IuYoAYu7m+OutZL5l5EvrqbRorU9eRmbO/xxNuzoUCmnZT4mqwm5qT9jzLJErr+0v5GOGnLjck8B0FnlAx8RDkOgNJUgFUMiVvbFw8o7iNts4hAfh07GlxZ4BRG0A2JG2J1UdxjmtS3TL3qusbWia+1QGLEzbwqqOpooEme5mOsZk5jJqeWMkE0pXTV1lsPtOpaGg1RqW5lkmiiVDC1IwaQ20/1nWkr6qNfSZTr8CQxknNAknlp4uuZcrkakmXh+vT9dsmx3LSYUiCBBgTJplHZw9Jglgm/dYIaF79snUWYp5/x6HIPZNaPM6OUWsehXql+rMlSecyedJP2lmakkn5CKSrSleSmSzRt/sH1UsypFcjxeOL/AMd18lnf+tvQ6dZU/v4f1Wx0Xu5lObG4aGqSRyKT03AEyFNCfXIs0JXqlXJNlezZOCFyTcmXJMgQMDGwdigQiTDPZ6Cpx1n5p6WUhoDEW1I4/u9fHVjpgFpTZWxObCP356cM2zuSKKk6a1TDQu5k39gJJNTx8mTeupgolk+Nr7TuZHVM5XXS/p3507/FZMjFTOKd1zEoHgyf/Y0rsKtNE3X/AMc/rysMMkCCgTe1O2bi/wCelBTdSAHuognHIJcN6ZltSXcyJOJrnc1Z/XJVV2IboXnpo8eOhVHVNvCBFRtP75I5q8nORHfluameqv6zMO9njxq6Xno76oGp2y8TSMNNbJnTL9tO9fkSXVM1KXJe6l5+TweWl76UdJpqpIQyT1+I3pIKjw4YAnEJAvO74Efz+dudLd3k6B3NEXy1Dod3fPlWvoNf0/U1uJ2Pv7Ypr+sjENfY7OdF2Kvgqdgy65WKHX4mxOHsmuJujYDGPp471N3kSJamtlSNDoD8Ija3DPaz6iT6sxi/7Q734mgTH9uh+2ZAfxTKERm28iwk5EQ76epvHFeaxP8A7JmkOByeRanSzNK9VLNJJs1J+D1OPNJOlZIhAZk+QmSrpCprUht3ScH71+HM3OZ6MVQS0XVUzeMqAY6o7s06o8fbUn9tKqceXfcs3F8TTMuzZuLh7qJyL0EA6NUFyX+JQxcR83CY3HsjHYjx7YMJdryC2NMb5ifIXexagCroJ7u63OnVSsy7AQOevwDVc+Sf8Yt0OrZfBfyGqq3X6CWShd73ltuWZlH4oRvwixUkxjMlc9gAs87WjWipTks2g7tLmqmTJLXHFXXXPMoyalnaI7T8gkkgFpQdl6Yk78WAjUE+8Ie0SjOTb7aDJkKmAh5ajo1YUu/siWkUf2vc/aGalxzv8LE270HydTH2h/YHky2yUzU9Ts6pSE6Bs5nzeP8Av3HVbiacZadKlkMxrxH/AMV/oNUj5IYWvpwc1FRQOSNy0S31O7r+xIoUWPMP4WMkewSYzcZ3EjUqltgI/RtIr8wu2sYgrJWqVi3ewRaJJF0UNh5k31UgjMyDj2bmhXXDLNbjXAaya3MlGxNMokyrqsyJNQzXRxjh8taKWppyp45k1e/qPTQHLJRkzSNMHnIjelqLOEXdwszU8iiKp+5pZgG43LcsD/UtXnFcArdcIf8Ax5aUc6B1++pqauNM6OdGp6UJA1/kAkGjJqfFfmZMk8yVTvobuf1da51SJ3K0DcPkONb10RHm7RjFNfFqibqs1Ey5NN64nVM0bo0T+5JpWTE2YyWY0zzQGqkCjIp1okqaRZENPL+ZEkPMtOZ9Pfv7b6Rv8twQOAAnZH8kdM4OZTfN6zamirn6u5rIfqWidnl89Y9zwApdD8mQ2HEQyUU6jjJ9ue6vaSyb6tSiqkS+Mm7jbXUvmmhKyH1WiTGjUupOQrdPjfZuJyY8dizWEnc1dDkn/brXVTpOQDQkM7+xL8OT7097WxO2htb+boT7wfF0NQ2tAPxkRuyuQuoZKd7aeuTx9FBmuOQ/MpyD1jWqqJ66mmIl2zRW4p/STStC+epXc3JLyZJ6HZt6rv68TlyVOjfjrZyu+danZmDUpkyF6iKpOVuWTeIvfSJojjGbmlP7SCJlXh8BIzft/CSiN38pZHtfvMT+q2i8MNymyZ19SqdV0ZDW7jIyhS7Zn9Uaul45pnojc0V48ZLnJ5yz5LZlBCNq/Yp8Ek2/jHGY28ck410k7cRPHxrXCVLtHgQpBE/K+OPT4sTMtAsfVSQ7kCGN43nE0fJ/iFB14Jn8TRDhgA+QIFs9pxpciQg3EIL9pd/KhxxklXI3eQyNa5ZFmTHdfYSumFidOmXeT9Fc42r1XgpaVmg5Y3i2FbFVA5nno/bsPL6eLYP9TJzwsrjJK/sNNCszVPJXinTM1IV6cxT/AI5BvJLch0cuklZTWPqeZlFnRQsupTUsIIm90Ljdzvk7aLyIgM+AZLV9i9BkHfWMnKSTjSZEKkOLlnxKnJ3RS1QBQ/YMc6ip5R+XiaoGkqQaoyOmZ19KCje9B5FkM5aSaYso3FvCyVO4B00Kg+dKsCOq/CuGg6k+tTIRqRk0aW/7D+pWSNhOT7TSMHNyhD7JlHcZhbIaJv8A7MjzkTxiNQ1hRoSQgixxvmrRch8lk2NXs/rk6aJP67rSTV4seubD7XQc0wyf9yuervnSBk5JCU3+Mie+oYe5yuq5km0Yjmm2ut/6dHS83qyX8Z1MX1ZvcOGbJ2l1VeXJadCSrT9mTwdTQr1eq974OzJHYYg9rq5Jm8Tx2WLf/bpUttF8+O8YhHM0pO6ZpXXmpXW6dC/v8bkmci1rWgd7JFxn++1qm36lf2YmprdE0hVzXcgfTCf28OTip8LS0o/SteaoT6ILHU8YqNTOiB6d6Z1u9i8NdG9DyGzwv4qSmAIiDVEqwv8AtxcQgLAA+n02PaVrKMfVUDWz5d40rWQB+Id0s6RTU0EqeKKY/rM81I3tlrdETSMnRoJx8/aWF2//AAVsySabxDq5+S4f6PN7qIf8YtE6mdLP2GkeRBkq7odTUdY+g1ArOzVI41d6qAZRDi2vyhBZbPsoO2220xoJMPG2yEo28aNjqUdfWC3IPM0AR8fVO1p8hP7NY9tBU1xVCB0zpd+OQK68/Z/1PRBt+pPnay7fmnEtUMxIv0+83yf7kMbXW+fFX+9oz+LZky19pKoQ31qCpVek8SISb0+b/wDg5XqBV7gI3ICceLMzjdOKYRMcND2No/fXoOOsc0mWLcTe+ZNyVuHlbJx1jk6Z0TrVk/aFcY7pITzTmHomjHLU1ib0LypPMRJu3XPX5kXf6nFLzzD1K32McZKqq66F01U73O2dzr8iiu6TJuinIhfP1HVYw+vnwanGBRWTZTrf1LimPV4tYtlxYWSLwNe1S/4OyfGYn6aK8W6THkn+46lnDqK1QQULT0yQaZb3APWN/I/6sZJmNZJx/wDkdc/JXiTtyHjoMn3kWU5n7lrlDTva/wCSeXm5xkWTub3XZC+RkYJNcjqgsgRGI6mGmJL/ALzz4Yu8p8nP2EKY2S7JUH8qLyMLJajd8OwjVTNxSPuhmzsvmjtGlsZnJPOKHCYya66xTk4slInvzdGuLk0/ciV72M5T5KOeYP8AFNfETM5cjtkyLr4xLOon61DUkppZuYNFp1kk3uvp2CHyhqcdVP8ASZ3o0adP5EJxuufE/F4xecliM3DvVWzvVtFLKbTyzAsTh2sY+nJg4RYIe9mLXSIkfUlH31YcnBDkJDU4/wBdTsVM3fVE2WXvKkrreqWpV2Y8Osn9C2MpRUurqvGMqalIvo1vG6TbrfP5T+6eVx58eaZvJTM/KKKvXVAXVtzzzzNf95m236rFxiwT3OLJWTH5o8VordF6qfjrwEsG0lEdIeoooCBB/l5sIAjjT9wARwjKGxUlWVmI0eTJ9SmY0TGKb11Co1GRyda3PI/Jybg6iVVFwXd0eHJGXuXLIOWZ13B1KZpKqSJklRSqHWxxGp2aWpt/yHZMaT4yr5nuEGAJ21Rs8/hZK5mA2OpPrKPF/dz5Ki/q0FFqbY286D4wFo1MWW4/4jnZFnbKT7xFN+FBIBEyLuRxl5es0xM+NVjjcfSskX9Mj3W+hqpxrpp3KdI0EZP82XpZ6xWtZKh11aSEb5of+mpALpn6vkbceSh0Tc07+vGNr6Di6/f2p8pM7J4pmpm1WLDE5Ky4zd0VvdWcQhJRURIYoXX7Xonk5mJ/JLYVm7rAgRjCGEZ0nUScTdQX6UbdjNmnrYxOzmJn64fkoi5gpIf3cNVkys6ajZNSUqg/kZr4xTzMxdTGPgx1pPst8Q04/qM1krVeV5Ykr8TBfprx4ceZuMiuO6quYKZnn5CtV1MqfUd+SJTzGayMs1OiiIxt8VLGTI7Kq/qfZ/8AY68+QknZ+WIpt8zsmjwbvsdtU4+lhEAkBLF5EiNtMkx5d3Cm9fW6MdjOlxOy6Y+0SlXrUyfpnUuOLZ1dc9GWaCLx81cHxuPkrlN9ESlcszp5fwKWJnHLEiY5PjOca1Nf+y//AJ+s9oE2bPqyn5kL10UPVczL/XEZNMVGYJImbHlPEu65pooCWmML6iLs2OX99OTt3EtTB8NXwQE9ZcOSKQ2TW9bnGUk/YuQaFmoAp2pJexnc83EYjoKomZuSmnrTLV3/AKLmo2glHg8Cjdh+orDZWOS4marJTD5q2rqZSpmrJJvGpodbW3Qc5Da24/k/9n1K1NttJ/j4d3yKP1kr9yYO268WYb+7zchURtMvEPDEMrAZ1Zw4qar/AB8C5QayHTHxysHy8yxPkmzrzqCWvsRWTA6JhacXmOGindT1j6rmna3NJKeZh1zH4NpTEr0Gpn7v2lZkxNcu/khn+pI8pW1EGMJcDKFwv+NolyYoDVLk67kCZPAsvFyGn8KSUgjYzFlKA9h7vU+oqJkMypSsDO9MLOCWRU5PTz2MDNTRMFZG2FnJU0tpZQFUzVFIz9R/E9UkXcVDNxhmx5kuDpcrts5oOrF6kFmp1X4T1WRpySTG+MTNRj/x8f8AWgKLmfpLXUhSb3x+Hjj46WVlufksvZybaYxeax2jMsFGz7daKr8dyOCMwTAYUeAjngFNhJwCWnFPe/CONyDeXN6at65+RmaSo4ZipnrXN9colUOxmXnXOZsnZqHn7RNahGqezshmvDSl5dwh9XUav8VLUYhuSq3/AHIari5JnJs1rjmnSSkqM35qmzkxB3VdlRxtx0V8uQKm26/rVbrpaqpSmFCdsG4jEeAwJziFZHVhYtBlCAmFyEova8V6fisyCBVl1P3yVjaMgRdH1cXj/fgOk3S6bjypixInVhrLpGKEmStoOGGL5Xr+tSCd9RlclSDM5O5jEc+ZSg1q2vrRRXdkldadNHIGLJly/HLhYYZxak2dzuZdZPszvc0mvucv2/aaqdhgDMgHjB+nmTBsMDx8sWDVvyWls/HWtLj/APJdVEONL1sayjzcj/ZkdAIahktVln02MsXeS2hFfNoydSmsM85HVedFOmapIq6fpjPjjFjic1TXFLOSenFF0nOxKy8un+2jxQX6eZ3cM1PfyWXJW8Uu9UTVKTkON450lNpw0DCRISi7QMb3xOMORosL5HIFt59LRYxw3PfJUkRkduNolQqnc5S6dVoGW5E1rw81H4ORnJZkx3Qv+TIWmP5ZnTkhoWc2qJCT9d3AhQ0VXh9QzN9VM3Wq1IHPmprGtkQNpkZ5HnrQAsVeDBy5D4+76nRN1PWjkSSJh+6HmpmaoVk5CQ5KDClIhRtk7jkEaHdiApdjG2zyCHeLWAwZpVxvM0aYJMeWiigmLVW5p/35Y8JUzkK8vV5MfxtM2zuqqXHjh1xuhmhKSNSDagRkndMx0/FPcfIl4+KEeouAxw5BHUfR7+PW68/oSMRl+XJmyROMBnt/9pwxpgqp7aR/yfXvxi01+q2vKO8AZiCxu7cJ7BcpmzG4If1tORExWPGKfXZIM3lyE0Gsm64ZIqaHen/eldVl5G8ZUHXN4pajc2of3oZpllue+6kukmwkqqn/AMjnH8lY9Mk46uZ873v5Se2xlm271uWTcVvysop/xl1K7Tviz7FXFR9uZOpi/szFvUjjpqYgBO8ozxEfUC+bao1AAADlPNgAsH+W0qsVtFTmpkrtncsVDu+JvEU7ZDUtcwVQ+L0vpwuM6+0jigInUqjz3SoDO5vha1rRUjoWIxMfFLBkp2eIiXJM/GVcvLjmh1MhWt7pKn8jCCZJEA2hca5qePjmaALZdmPQfq5Sd00ADGfxZQQc+2LtwNSvcvKKjb8rGBGmzOODqp7LqaKn/P8AXIvOOE4qeKnw+fG/3qJAKx109VNfJrWqxz9xmvvW540aTmNy2MBzqI1kn1C5ckOO25y8nVVjZSYx07IoaFjT0cc9S3WGS9S3M2/1WQWc20nJe6Km656VNvmamyXY70qDeyPMWwivTOcBiAgLmwgJsMMERZAo7aaYMWMeJgWKyz9fkqih+v1DgjQz41M+el8Cprt+nnmKlmnmjIaUnHY6ZpGK+oT4/Um4K4FLa7xXXOqqiegnBjuWCbmv3JsV2DtA8FReMy/XH2xeWdziq2Z6yWab3zGQNlBI3GWUN/hTJAaCpJ3HP/yiECx20m0EmiXt8qU5/DYIzo8cGONyT8tPz9uqYOV52aBl8fExq6Wmojx+LPlG2PUbKazaqZZJAZdsMzk28VEkwDSVLVfk5MZjuLw3RizPOWJsMMKFY3qD6NyGOpJa02BzZ+RjKn+lK/vGShzL9eWvAkpI4tebp5lp/GAAZYRRnZWsGRJYZVtAJB8kY4PaXMMjAZ0r1JOOIyFU5C42IVWSaqqyF1hoDHqSq8b+MpXX9bE5Z0aQGJwk8DZepCpYr9RtDJukBZo0P4uK+IJyTOTqtRkjjI3NS6LrQFQHXgm5la5U+wpVxTxUY5io8V05OEfkr5GVjX6ZPugePP4wn6t4WQbfnJjG8sEiUA8C2A0g0WCwPqW7eLVVLdZfkfDMyisvxTdPDM5KNkA19v1PApn6Ziwqupsyaqp0dAyGpNc6Me/rF+Ho+iWWo/xxOgOG7mJx47r/AOoevvV23RfiS+eKDUaXOWMlInJx8aMcTdagZlWqPLtdCsOOmWevxEglbKQRH6iNpPyrSJkQGES1YkZyLgwchTL5JqU+TJLusnfG/kYk/wAbP+RedslTjAJYGX8VcDMnFZCrlLmz/JNzrnNk8+aI+yYzff3656GenyTUzc8jEwMfGjuWP8hPitpR46mt7LjwfiYjLk7q7Lxt84ZdU4cZM0FzLjmWgGjhZ6blkvn8RIIyXkW/xDLYh3F5E6kKNijd2ppGy5JAFlDKcXvBmpETo347mn49zu3/ACTL+tAizEortF2usUxrzinJuq7yavzc9PWllHL4U5lGZX8m3DcZPhsn6zdRXJO501OJhaoro6FgqZcbcszQIVSUWT/i8DVTWWJo+9NDVPGvC7yHU3rZ0iS4P4RHvuIzLuBvGpBzvILsIug2Rcwbh40FuKj+lPMklVOkq6iZKrd1k5bRZdvKb+vX5m5Z5rrDITjfrqbsSTu7V+MmmetCkM0LJ3A8zXNkzebRXL2RVCuyTjEMPOp0DWpTWom8deMiS6MbTCbufBRktqmndc2aWyx0zNuZQN052HZ3jM/TRADzn2ACl8ID3EaY2YzHjmom8hOFrT/sD5LyaZF/XmNqUAUk/g3RhJKJCiZK47KrW4yXk3zLL1u5nrieyRKn8D5KWrnGZN0TlnLIsqy/LjZYcPNRR0khX2uWm9hlh2MXU7ylfcLqYWnTR8kDs3j1MitT/S60TgdlYCOV7HZ6CrhmxFg98iL51bZlWmpd4fkSvj1V32lDB00tdYpk+v8ATa6ClFXkyXzNJv4NkMkr9S2KXfe67s1ZaTsrsp4axr0156E/sYqjyVkkokxm34+Rmv0v9vytEz8jGR3Zk+n6xmQCZ31T1VV+5pGa55s7imiotYePASnHkgpBaiqpZDMBeLjiFfiFpl03rmQMdYignxbPS5OUr5JAW/E9UrUyGyM3nFOSUoxzE87QuDRZRdd/emIhn6c//coK/vc1dU45/wDbJ1V3VRwNX0luK1rXG9gidtVU3XiASN4poYJibmNhP16ZvJo3EgfGE1p3RlFVx2Ie48AA5I/DGJio4BH0vCcq291CFyMM/Lj3Wv8AA1yvMfVTUsgZOpidT0Nz1XjwC6yUb55pOcdVUWf5WkMlu1SOSG+aegJ34akyVOCb10ylfZqri9Adu4qcQzk8X5YEdCn5EdeWpi6qPmGCe471QtrBrEgcklHWpaop/GSiBazZmfS7/TFu+gT4OFn0jxuAlslBTaGVbmy7DHkedlZA1vIkzBjZyFRMumxnTTtcxkvvezRltX6F2OtUv9q40bCCpOTmiQnmK5+8uoM9X8p/kCaWKIlmS+57I1KeNykbH5OVsej5HivNVicpNQVfUE86eoT677BH8RMSkOfr3m8vvoIFJLix4Au+cGyQidZCFWxLli7YY/8AqLsx/bDtxqSjPRIj9AbUrOuxLn+t/dU1RItSTas43dGNl/2TWqmlE+PIVGQMdYskhkmA3lgJV71VNbdc6+UKx7nJzf5N1X6rYdcTvrafqMjZVUpp3en6p0N7lz/xv8sd1DBzMJbq2pFQACJwPsmEXHlYWiaxZakjLBccjIGO74DcOOppqimSB/acVJLjpKeZhUDINVoh1Tybu/JpiifkrlR3qU1uPjKyfI02zHyb+pA7lWKnTWTiYJ3trbXk5mFZGYvvxtkndiMZLpo6ybuTXP8Ak/vSDt1v8kYMXQIMpiEM3376QsTePAtZO8xJvtpr245DJ31kcnybejCw5Cfm44nb1LP6k20m/K1nCaqxm6JmtKxNiTOXLf11je9mm5POM/ManAY5mmBgx7d3A5GqLpb40K6KnYBuaPP5GXN3BJXx/XENaAuy588f5DVlD8nkdUbkrf5Vln68xaWBjI4GjxKcE8OYz21NU9Tjx0Tac9/XS0y1RemXLRSTEaq3Y61OkF0ZJqOaSJxITXLTe9vnitkbvI+Zrp5J3P5Ojws1P7roeDLkKQiad2/IoTZpqeIP6xTMXkbJ+A0SkDNoMzLL1ad+R+Gidtv6a6aXnt9IpNpcwuw0iGv/AC542eUwudtEUjkImcjUuWbdT8WTUUuTJH11KHONEKqa3yp+DpmVua3NuMWtVYSBFNMlQs6dTyzRNHhr8ztxLUU9LzT9tT8nN7tx/X/rQH9gN/8ArZJXkm60xkS5+vVW9XIbuToSlrUh9Zo3Kn7/ACSW1/jcQv37o/lqTYASYOeHJmHgH2GnnU45qWMisXNL/wCrG61vJP8A+BA+tSmqafH6ndROPga7JMlBJrpH5u8daHkyBVCTJN6o3+RM61zuFish1YyY/rxMv9K3WqmGQ00nUpP4IM0h09FZJaaLmHHQQ35mqEWYnc2iiP4niytuDD9/pjRAAn8SEwcW3CVpB9w4cWOaqZroEx7kXG1x8cdSzPx7FZWqZdv11Iij+siTRGGqr5Prf3NMfIM1ToOjx4Zl8E/hYeXmQ1slD/SmgimwVvf+jdCRvrb+T6jItyF7DHMn00RaswzaPEgUTk2TP2InxfUmwMoWDB7reDP0lagH1ApMIgQyVTJmkIm0AWqCK1Ff+OlPVTdBlZeVfEnxH2qehrWiZuT6rJUqqb29sfr/AAL58akNZMmSfIG2mdVIyMnK/kuEniZ5rLTPqK1Ua0mmAmZpjpmIxantplTqZkRzTktmqyDl0Xq++bXnJMfWORmpF7H9Suq6moE47gAFWZNiIgEgIi+hPcj5Qt+WUCwAWh+EgEZfi+0kb3VZg65mKumTqLq9PgagqZZ2E+KCiaijutA98SsoC1RORyJ4PDHbPSTpDSgE6cOH5CKdVlqdz1O4+revOXs5Ncz9SRNFL7ysk08dajHSw/43U85byXUu3ny/22bTxpkkAMskLYgmHIjYbIznQKQUxKsGOQzmIyVN2lzdY6sx5NzT2tssy1BW2jcRaiE88u/AFUABdp9gqa673z1ig8YymUpofBJMIv8A2NkRWP48tyqjWPmuS6yZeUhmisXE9O0p15DwB+WMMZSjrIIR2U/Yk5ijFjyUSbDxRyTrdr3X5jXUIvvCtABZ8tXFkNImS2jUwXEAIgE92DshIjJ5iT6cvyTj+8t+BOMhZ/WOymHnxvnmyGnGdbTrJJcy5K6j48e4Su9ankmpuZx8FDRzXlZgP8WU/bjskqoq8k5JICZaRua+xLoN7miK3s8Vzk2WVeSZy9JMSzsloubolGl51z072zc9q9TUyQxOxm8PEiCpemCDbHMmoCwEUu4KExUxVpLEW8u4rv8AtueUxoY8S102VSTDM+frMk3M5KjwBMRUDxFu2681/wCwx3X3n68uWpn9EcdD3YrWLHVfJj3ScVzupb8k5LJ5mMTP2ghqSmpkQ2pxgY/J8nDjNdrYz0W5B2X0B3rej6FVtJ9YzIYZdvw/uSlYTpAEkkxYF39RFNMiwe4DsWiBpdTirrub5nKFXJ/tuNzU5FWPDr49tccyGQl/AsnLE436ZIqIxqTM2nUMs1SjtNT9Szv5OVlp28uTFjyJPiiK4N9cz18+2puaOtj/AFf0iu/wdGQubWLMg0skxkqDX3KWqba8f6udypT1R6mO4xDXfcO4BsJGghXJLm6jYEmfZpCRqu/JGRcNNw398Rzyy0eYOyjYROygirJWopr8O6rrl0HyGOeZIgr/AByS7VYQ2R4makE3L+Tcit/YkzaoKqqkUbSP7EbPJbJqa60fjLiGI65x1udblmM1Q8sso3PVXzp33Ucblkt0pq8ZWFYxa0WWdwAhOMODcFD2kBkqDgaRlxW13Of/ACNbfOOjnctY5/SpShud5NruenSscxWRw0ouRel80FTvEGUN7aRmdHmp+tM1bWy77pOsZczFG4ngnmNVq6v6M6F+s0bq0fyMvxVw83ITjSyZxy5KomSlSuKk4qjRuPPiY3Qq9RhxnBEPJcNIEEscazMLJJQQ7WMvYJ50LE5P3WONJ0UEfJy/c+8oz5nbKN8sUY2S5UY5XJA9HV5YafjWB1wv7ZyMmpmZheoEryn3Us4a8FNRFeedfSPvls8Y9H9oDczqlo1+TkuZSNyvMx4E298zOTJSL3qi0PsQTQB+WDSS5xjPy+SZlh7coJi9/Eem0MlMFixDKEr4xNibA/yAoST4HDPgqpq98+NXJooARROPq4Y3RlHGgBtAibq/NQ6SEmOWE0XB0bdQV8mPzusU1y0hoDurD/Ecuq1vXhHl/FuQiPkd06jG7hpm3bNuT6LpHe9vhZnXJ+DAT3SIYsABu9z6b8PVQFJ5j1AWCMiQgbRVYqdPuqg8GO/k/r9u2Sv997GYijWmP+wgtOq5RVV4dl1dNfXpCfkxtP2vfnYAUGnT+5yxWRx2ZbjwVX2Z7jzVTPH1/R/jgfMuQo/0ZIDUzqQV2zxjriAuDpaenR/8Wbnf6UNVgAkrSyoI4RAXu9OyQsOJt/LWMmNFFiVS1DNdQbOncn1htEiqv6QQKbNn03JsytFCVDkqexCdyfH5mSjmQ+M/rXXLrSZf6iigTmzmXSkuiti1dLryk3Mo15NMNV/ZmdbyzEtY8fxvNpvXRka3PM/VDwH27QIYcLIkkwMe/vu9Dt94MlSh4a3y4VWSqnZAzNGNIKnddf8Az9nHP9gpcZs+5RGvwLWcpT1bkBOXTFLApe/NFTfWxtIpl2Mp28c2U13Q10QzFVUIXU2Shu9TW9baTVFBY4nIrSizT3ryU8JIV39Nu4rwBLMrUtMmp7j5nNN7WE43O7kHWZOCcmJGwN4V8iHIgaP4sMnHNhSZNzWMfvoS6nR8TdEak0ztBrQK5mXTFKVqP9lwE8DVbbKkU4BqS9auelku/IJvqputHITL8da63rc0wEalormVr8XTLOeaG+A4UJuKJxjMrUFEO6qYP9KEM6YIkm7FpGzw9gvGhkqC7N4ER+uPYCOMPj/NtrWWDc5MUm/OJNTXmSdwSjM0a6vr8Urb1OhKj6s+ciilkpkqgGRF2+BOQ0Xn5G1FjHXM0URFl77xzr7Mrrve9NFPgknHNzsl7XnIZP7sT/qPkyB1QyTMjobqtfo/Fj6lSV8o3IA4AS1QEyygOFZnAANkt7axrZ5nxqMTCbW6H/JE1k2Hlkrwi/10T+BHVSVUJzRivbttKOqpqeiHXLXn9SVIxSzMUidCNFGSud8oT8Xb1qvvyRGna+BqZ/LM9TqiNs6ia5dd7ecj2hX/AOWpvQa11uIBDGx7pY8IeDYrRCd1bshibvnlQgmcXmuZT9/qFLJ6IjmaZuKyNSMnjfgk2DEnyZE5s5vyUbDiUxbZ5f2p9NP+nXiWHMnbq8lATjoWceXJRpaeJiZTck9JppBH8gx0PUW1bU4ssVRM31dDrmTnGSEx2xWOTaMVR+Z1lbuGLnZXdMqcQUGNSQxJUAdoFiCpYn9NR8usdY4KSrmLqj7Y5qDQ0rvkmt0Skyoa3zTMJh45RuYXFLH2Szkmrqq6XwJkebgZU+qjYIw9/p7orRIgtRqbWOHHOTQUf9yq0V4BjGuZpsJ5u7iujH/d5iIJkqdH1d1fhxdLa/keuIMy+EtlOPaN1ujHPC9nYeNV6x1ndsJ8NgJuZvIc/IM+W9vHV0THEhROpV3GN1ULjuMm2bRvU+KxkmtwbdTtF6moGivx0t4565Hi5maY5ZuQ4W5ZTGaqv9pujwDpVxdUKV5zhtrUL53ZxI/2PNc8kButiMGrvFybuPoBMbgZDKREu31g2yEjZWAlaV1afaPHyyKtAP1jdltDKdUuwa+tQ81+BfTa7mZIROX4xnkckr2NXW2fO3lmk2/lzlXepHXwtVKnX7MjXX18gedV0JoOn8gx5pqusbT0BSLvfny7gYGaoZP9zsa8fk+oHJPc9gA+O6echrAH55DmLL7yNUsWP4ryVeXcVFMd7Rk5CDqiPkHfnnk0v2b5MZYl4syxaM1Sc4hT4zuWpnnScUICXoKfy78dzruJtlTFmx1NFTpJMmhANNeJnwku6GxeLCYuqcnRTNeaKDFs5mYWJcs8v7NFJM6FkXqmNlGfoFDwhOlI7fsL3yWrAmN9V8lc9SB9lDxzOsk6jJWWa5F/2h5P0IALolIlONGOena3jVqryWfdFPH9SzU765Zf8NJlKo/vSbjeT6MESnj/AB0f68J9ta6t/MRxksvX0JEnutldKtcuzwVPkK1rcp+IVk5N1fEBPta0TchIki3jBVvp+o0vJix3OMWTRNhB8c1M9HLTKuSpk/o+dedMTyu4nxzJNGOa/wBPnH5Jaemsj/ZZPtI6Z2H4cVvHIUCIlotCxtmkPJH6s+zIyediVyWtiomRRVfpoPjqn7dAuokNJU+K0t01ABEbC8JUrbvGHGkILEbrNjOf1eoyzqfkfDkuWdpO4ZvVZWtXroVEn6aa/wCv4uc2QfJ9gMbOvBzriqb3LPQjYbdIuxfyyOiy612GHeRW40Y/J1UhiEovy06f0nlLLaBPn7FOiXJll63Reh6211zLsJA00jBqCxJHkCL7sFWyRpkbD2wIOT2Jt50PWSYiMhq2yPGztomeapeyUGCiZ3IToedwkd00k/vMng/tzrE0nVedA6/Wp/f5M43JDlchM9DfVJdTJPyTPQPM7kOTy7n6h0BkjcwnlnXFKPeMomYWhRpRI1P7JfILRMG8IHj+YgiZ0kTeDDLiwD7eURqaj6SlDzBfWzbp1xtCqqnfQB0njT9gaWpqmdzlXh4XIbgZNW+JQJxKVtr6gFDF9TKZpRLMc0WJUIaju/vUu/tRJ0B4m52Jqm4SNnEIr+71Ib+zvXkKThrjhOdfiYphl/rHYZ/LR/Pyy5zr0G6JxRlEs7xzATtuapdZbmuitEv3U0yX0s/h85cnRc75evNEw4gJvGU/e+uBK2GR/e6ClZ8F24632JY3oikfGL/XUttTLjiStVOpuZpwyzrd/sHCeK2eQkavxyUUFaLCa5kd/n1YntxwBuPADTXbXtDbshc4zPta8MAF2PK1m0xLWnEVUIDDEzkyORSheQonYzJrrZ+V57x1nr4yy8pjlop40wxRkph4nVOpnY07Ctn4zG3XZyOSep6ZXzqaYW6Pkd9Mnjek8Ua/Bx5Mm6l1lnqmXIbsUKkx0sz8mqSodQ6K+tKU2MmMJifOVIg3vtTaBNzGAVHggEm2eFo3JpZv477tJfj63VaC+vpLMsqyT4B51flXLoZr/LM7mE2vPJyOVZJCCi51uR71seonMmbJVT1u/i5uNhe5rHc5KiSYGa6Yk89vCurPFGRcnNShkuqitbuSoaoiiJnk+reOlXqRC6VFGQckHiycl7H/AENItj2hxYODsRzgi2ptraVP2m4ipne7snc5Wtluq0mUgmZN1KEn4BTknmZ4yY2fkm6CqnH4uI2VtW+ZnmakKhEIpOoM3qZp28TRVLRJOPII8vki40atC51LQVKTWSKlkln7EtRHE1mVN2tSyMCVWp2xxX1itrfGwibFWxcL89JeFbeFE3Mkwi9o1GQvIU89ImOamQGCRDIXumOpmrskHwo+K/F+nxkZaSp/y48lRuhcUV44Hn43XARCtJdVFBVSOyeKnIfZqOakqtYi99c3P6mNa5rbKlJwukzWVx9mWZjxvHVyvwakyromu6oHU2DKUbMlbQu5cK1r7Qri99MwaY7XK5HYOZBbzrM2Rj6Y6mbWMNU42ZclBTdVTx2QBVsbHoA5K/GYLYeRKcdGKepqk8HK3TO8fRW/3IDXL9tTGPFbP65jSf0koi9HyYq88yPLK9Ugfog/F3kybrU9nbigqHcXzBN10tyVy6qpSJ0htZujHzGRgL/EW7lQ1txo9M+pFgI3tJvGAQwDZvTXFmieryHC5HG9zk8Gua888a4CvjKknWhq+REZap5qHr5JC2D75Nz4v5HbLTXLUjvwvU+c7rrL8tV1V1iGh+q1Lvt5DE/bbOjrpgKmj8EmchXQTwJ3uqcmTFz8k1JO0CvuqdkTPJz1+T6mUHK5BXaNkMMLbSzBhLvAHKaQe4erPWVN5clDzbMJJMx9a5jsx1tp8Xp1C0vda/IxzUlB9poMsNb6Mfjkm70lzoONXM9NaPqKrSqdM4/sWzddfJJ/bWOodxxU/wCLsqiUo+s8ks0alI0hZv4+5xv+RcNL11KaGt8lxyaH8diNlveyuH2txM6Yv7BRxFvFoiTpjGPGgS/5WbFTG48mQYnG5Zt5iets8tS6qfGpRmmc9r/9kLwXTGvjzZLefu+GCZlfq0UWB112RU5Wviv4766qFqNzMrZE1NS6K3jdxb5m+ZOlbU44hvSID/hduSlrFlu7BKrpayMlbinl3J+FSEND1DZGxQdyvpOgg2FgQWPDF07AIPydWfjqz4T1EsfFebJL8Za9DrHUydzckjBxEzLsn5PqjjmcZXmaJhqZ8XEtj3M1eSKCUy3/AK87h8gv5OWdP2mtdFpJluyp3fPLFefrCFTMhOulMN5fktqquMjU2FDupPjmhJNIkV9cnfRP7T8fZNI1YQ9PaDtP2GmiQPHGzJJUEcMb41YkrLh77esmQ58jdUxrjI1qiLpJPO6nqWv1X4NdenjHMwTaTi8fbz9bM3XU6JRPkWfHxzJRLSGvmJjfMzBkjHvmH4znmvk25C9TE6DcQn1fP4vHiw9vT0Bc/e5KIQBJQmiDZjSueytczM7ouEHYMoE2kMPPZrT2mEJLj8OUSDIJTxl6fFkF35gJmbKum+4kpyY43Ku+SWtc01O2ERM3WDHim51WTVFfE+bU+OqrJzxkl6UJdYzwfXVxFtRdGRwwz/bzWVqYkCpYusWOiho2jBwGkPw9ZK1sx05MYSamprbRNuRdGZ+u3W6arQpW1srgbqI54vBFPGmoBeIx/wATUdgfm4sRI03UVNzc1f2MhYzXVJPOKdpvHVZEm4kTz5lkUJJ0Ng8DglN2OQP71c00aFXIk0SbY3ppdNfPHhqoxkmhh3FaI70b+TjX9FyJ/wBdErVzY2c0uPIXLkuck8zjNTUsXuP8jyzvr7f36qHj8RIMpKGoDQa2tFhudK/0d5BpE37drnh89rW2IYHXllyuJHvdbckvQuqHJZwysqoIct5UqbZqrnocdzij4znEWOp2yQzpjVUIMgFtXjSXmpnpikDJjAquiW1um5mgqe42Vr60ZJkl8tVNNZAivE4kRxVaFvLL1iTaNarf1/KyBdCbTYYsEScwSloKauAJEAdjwvAZF0oyzmfU5MmPLNSlSxsL80dRjxR8ZaTxXQ1/k2G8d3Jid42QnExy0UyfLWB1Tji2uqrZt8VR1CETjWIJy4z7TAUNQ5GHkmfkZKkTHqZZlrbzQn/b8A+PIvC7d5e9mGaORIg0WbrZW9fLIngHa9PloyZNuHZNQgXtpXsza6YtlEiKhbnRZHhmx6KTqe2ucV6fs4/rjmSa5318RUMlT+nYs3WpcSMh6eKZrXewH5GvKr4yTIhHNfYLpDyOb/J4vEtFrRj/AHfESkTcyQPINRNrB1bA0zYTBOR1qYMVY3ErN1jaa+p1G1ajJX2oLlHUoAzdOVewlncvlnkaqltgYndFK02MXaEbMmbyZec2KqusjRlqQI1x9cnZM3gbyIMgqzLqy9qy4z9dTHFTyfUKMb5dSV0ozxzTOTGcuuhmaarUujiBOXoyTINYqpKui2nwHx1wShc9EMV/48L1kIZ2FU0RT/6m3nmocfSMp5XfE7AgEe0mDekNCS5mXbuttwifHpxmODtfUmdrcuKoa/xPcrNWakdZP6AlaQWSKxpJHS2u5a/rVWtFkd1rU2ZDJPMfGa5hB42ePNBiX+h5rkajrTkrH9aum/FleSefFAxSTqlWJXIwvVNVzd7k4UkiutzkinZHMzF21Pjf5QNgeEfIi0xlBTydOGNoA42G4ucOcaclPFTU5O0dvEOLJkruXLlx6Jv6VKM2dVOSaS0F56sn5K/UcTQS11c2LWTGv2kCxrRtNB5d4UEQf7LJmuKxElYyZLqUmpUdan7VvWjz+HNm0yyUPf3ue65Ukpsdcj39/FR/eR/SRg7SgNgbH9rIgjQ2hEiPCdtsInuFoMlzkZm8fc4nHI4/P+Uf2466JnXjf0v6rU9wyLIydJ/5HyAtRG8ZFY8ZohpiayV/rLDoqZXru3RGR3DsdaiSprmb8s5GlX+3RNKUSLy/b8zIGmo6vvJtnrkGgXnLGpDJw42Sdb5v915OWDvIANtmwLIszpgGY5VLvBn3kgfMDZ6mM2N25Og+TbkI1G+jUvybPh3vnSGyvrOirDPPyGQDdlfIPXm5ijx9p0xXU8czzfO7S2a/JmcfK3c4ybrLFV/kokZXqaIpw7rrGYut1LJP6ZAqaM96Y+hLtY6cRqtxb4mxPrOuiOKJmPxEsT4/XxYlCLbahjIdjeEUbl4KJIBFttF9C9VuSmvGrycXW5xz2jJwD5kckfbYX4Y5x1xdPjF6cYprpypWxSpnvHrUfVn5OUDe+cMuL9z5OTGhho5yJqTqjwlKNC1jsvldT2VNuOFo5PjQlqipH9Nwqu+GgDGiKKaqXa0cnPy/N2QH6s6GT43sGgdkjB4LW7MhBNVdETX+WUY85ao51UC881G5h6BXRO38Vlqp1MaKMSVWmC9Xq+H/AL5a510z5J1quDcThxtZCdS2Y85uqnH82MXmN/QnIf2x/wBvrG8ng/JckxqrCHU4SHG0t6Dcedu3qSsmqCLip6iQF8swDsGUzkrYW/coyJF5NuFMBFJF9tKLpu/knxO4P3jnvHEz8lt0v2+xFk7+SJX7RRRnxkytIo5ofrRO6gnFackY+6/TNb8zIdHIzjrITeN5sDHlKuflslPliixaKamJ+7uXiifFi/rNnRWrurKZn5MXePcx3sxo/ZjH+zTRP11+SWMA822ack5EodjpKJBAyvAQJA2JF/pBA4uu88m6+WF+K4ma4TDjo5OqdGtc0EyA0yLu2p+8UM1OFBMct9a7uVHlefsa+pXUzr8iTH8PyWVb/abKLTnGJj1J1OLzvIGiWlkZ0OI8RxclY8cX2/0uJl1vJkKcl+YahWXW62yomecQhx4stmnbSG21pQFt7+DzYaeXTfga+R6JoqzG0Tq5yn25lUl1tT+q1+VMeVu7ij7mSqpZ4C9QPyVXS6quYoOk1G5s/JE3c6+X5dEFcjDlJ53kKZA4uZxJXVJUHk/GQT/lyxTNzeRqrcRkqNT9ySamphICVTxU5Z5Jom5HHvYCPpkjcqCvvIvEFu6MfL3nOoe2lDf3/wDI+RmOmGIqwZ6lFqTGVHFddNv+hhqe2Qv/ADBNOJmo2lS7rlTHqheWRXRQMuYzFh6Tqqz+CrHHxWRCZbnWscpoaG2iqkCZ/Jts0sx0PxiT0K14ztl0FNCtf7fJPmkBg5tBe1zOMFvewCFkRFyjiIJ2PnvqWrx3V4eictaqcnie6ZCu5onUssuSZ1NzQfWuJiDtuKy8SVdrpWp2jE1zW+t8hjIniKDlgZXL1qbgc3M4joOKch0ZS8m/vVP9dG+dzq9UT1eGjUPdWatK7m3RPyXTjjg3bAj0EqO6PyQULwzIs9oHFttjqcC6Fhe1rBgBd8FLRHRixeZ/Uwc7pZtHWTIhzpl2chpBHnpTV+nxVd/F5rI4+vtubdWna4xxyi9RtlF1THP4XV2XFLP+K4oJ2Xkx1sCUyeL2d1PPT/jGd+F5amnFJqYkxl3MEwvROPHk39mfKW8mqPJ0CyTj8g8T/rC0kwPZXKicW7SFB1GXJiXnKpWFOchJw3jqeZau9V0r1UqWDLrZTFXkyXGSaCMeOsnwXuthcCXIBxUsck0/GUVTU0/jb19AZx0zjp+OcZFuN8TLfW7t6TkoqT610n4mL+11/kT5Kx/qpYLEhadT8RRennR5NKUJtYniTsvoI0kAN2BAvJ7eM+I06gxmKZuZqk4ikY5fHNohMrEvxdcUNnVbAF+O7q6NatvqiZiqnXGNmnTjqqrjZ1R9Hab/ABeTpcePFLRFTd7rxfPMMbqfIO//AFGnr49/t/Jay9RV4a0SEfGI3Q6hqrG0o0Re9qa/scsko2MKVBtxbcrUGQyPFMqWHtjYblgs+4vzeI2XEk8HLTJIr02KIzZp5nzuoEKceMqiZh7aqfKwFaZGy4P7FXCAl7Tz4/FT0Lcf5Zq93Nk/99VNY9MVOqliakYb1XmaZSiclfLzpeqqr4C6iQ/xzvvempJYDFvqdxSbMSBzHAfC/RbaAPUtyLQdoz2ewwDqTEVFaQJLveR5blJKwSOxC3SY+fMsSdAqY/bM81Lnn68zFxNM6MVXQZPiZqJZj4+tv1aBbkyGPnGoQxxGTGBoyeJjPkH61spUCwj9OnpGTIFBs64MZrZy1Uzji86iX5TxzVMn+5KZ5vuRwn34QJ2IjScTNrXurY+swLSVuCOq+OdNuPdzTXVKxRHXlFSalX+xMnPlbk+TDNTH1xsdRv7HErcUBTjjVSR9yPLudaEMrnvkI4P8cXW78UVX+Wypr/HzKVlmZXY0STU0bMY6xzDqkxlBzGLcmtXpvZlrHPJe3pedxX4jVKSsAhmOziIvpOY8wcJnkI4kwojTAk2+JQ/8h6uBmNecSoptZGNMnVeZGShnnbjD5Ot5Y6s6xb3BgpKSgo1E6BtmexWmaGskasdYpvwGPFqDdYt7ey/r9OlvVBaM6DJjNbnIRV/fRbzzW6rAkwaBBdjINS6bNIh7lYfaWUIEtE8gkaIISDUAEH/jcJJC8mBCjRhyvkorJtTHFfH3qpydyzB8f2eZeR28hXhlNBEASeJrIJM5bnt+zdV4t/tknXTXEz4URjkjLcQsxkx1YKxIInGLVIzbMVj+qs7oovxTH/Bi6Z6koJ+rTHRLjO60ahKOUU11J9vyTAmMcQRmfKSW2pBN0TZvuAxcilE2AgFqEGJlx5NToKsrTqpKx7cbVQnxD4UDXXIFLyyZZk0Y2chPKAsmT648XyiTCMAHNMbVOkJT8maaDF93oVQmCknI/aLmamtamV1KnXhqfwpuawzd7m748sz3V9RsTaTh+7pJ3z4fPn8n6Hm04sn7j7aUelEBwbQoGTx/ylAFHT4gN5Mh3ksIHmdTSQSQlSJuaGmNmnQ14/Ib+OJqtCxEPUVeqrn48tW/p2L8mvkJxqS61+Hbo+zCTjmXcFch47GUKI0rW/P6D7b/ACqVV48c1jldfHUsgmeaecmSKyDFdX0NbmuX6mhoagVb2ZuRj9SLCMapBEexk7XLYeJ2TnTrxVZrGU1rHm3NNTUAuSd8VWqmjmN60sV5dymi+IchwTGOsUU9a4eSab+zV7+uKpGjwv1n8ZGTXXyNL2w9zUEh/wBao3JiZnJxMjS+ZPFsD8mbPo4THGUjlpK65Iu631TjHwH1HkP3FNFSFLu0rGHw/qbsc6kn1AjdA2NlKptMIlmyto5tfGUZt/xla1GVpl8Ve6LqvO3XQeTeu2lW1OKTnWprItc9xe5vIWEaNj8tSgfrG0P5Dhp+xrItGPb9pdOptelpWaGg21Wk31Ja9NgJq76MmGodVk6y5IbrpxzrW+WeU6Q7HG/bRzkyJuZt+h3+1g9FOMrcioYMHcAgAqfroDZ5x6ZrIHDHM4smQlmuxiP2X50pRtmm7mimL1ZO7mslS9R98ff7uGbSeeaivi3jmtVM0viJnJk2ZeYvXyGTcx1BMyYqSvM0eQmQoXpLS11vEfLyMiaiB5gf0ldT9S5psr6Ascqp+YeocfLuHAV99p8CNMoyBF2CsBD5bBZZRCAkDSrjDKpMlVhtfrNblPOWrjUxWrKuqK+p0fWpPxUzk5Ki+qMq5cL5SPrVCBOSpU4LsNUeTjz+MP8AHx8aRVTMrrYVmpvqrkJAdBNyvnaPPP47HhOihar4qnIFxHTtOioDu6HXFeedK+NVnVXeMcCYCvOcJ4WpcziBCH+LaAJCFlH2OoaOTWJx/byzJU4hmvjh7xmth431WzxPLSJlZqBnKdJDppmfHFTkriep8zz/AEMlCP26rZ4fT36v1HpvS4Ma5cub0/pcOOP8bnz5MpiMPD8lby/ITp5nUpk3oss+7e1+o9p9b6r271Tjn1npMlY8/wAOeaw/44mahyTVTV7kikkL1o5WVg10mo0sCpMC5SDiIsGr9ghI+qoBWLFzB9JwXafB1onDFUwuz/3TVsqjPRhrlyDtrr4ziOWmWZY/M1AV429NFCfVrjnGXqaiikdJrev1UjFnDMYK+rkZyaXHWn47yamajJOscfXH4dNa+XrGqQ1sslHqMtKz1Rj8PyS9xpkqYeHWujp8U405JKFfpgHf+OUZStJ30EEloLKIYnJkT4+oGsqUy31UtMdypCRjyRtkfrNX9BPq/LVOqA5kK24wGcRqKl+smRxy1eS+2qe+jnxq6ScnPjY7yV2PVEWpM6Z/6wYatZdWoHIDVMhPmiMkWOOTIF48c2j1qgdsVSbylBoPrDBQeDbVFdl3hbx49MFdyNwnIUBD6I8u3AcBaTkJmTqxvNkm+/8AZ2HPy5AOE0bnguhXa8slxZpZi9xOIZCtzUywmRXf6d0SuomyWjX5PeKlFCjJVnR4nTMEjkpr49umuOYP+u+Kpdf42of8k1k8LvWIUJqcjoNBQyyAu6kpfzemq9g4AHGCtoxymSdZj0gGkmCnCSMAKzQcEkDkHWT0N74v5KvHN63qmsddGT6T8cvl5/V66Ozf5VqrYmzp+PLz6jnXbY/JdEbyBzpC1lPrNHJV09KK6L8XT10Fcl8vTW/jNhqK47l+5NDr8X2xfePQUHWzUn26/U6mp1FayeYiuvDup/NB3QBRX/xBV1deE2hpehWMM724hSE4CzBWsySVrUkscs/05ycvIO99tfs1sfrD9jatEOtTMySKz0Fi38pj2pv7VN/tqkTSbyyKxRmq3dXPB9e3TPONF+krW/q1sKo/vBOMDjr7AyRmxPWLLJB9Zx7d09DKyCbeRk41VRbIp/M+6Cxtbvqikztjj6PY6AyE4erYeq4GsTNzVR9UpZ1j11zXnxpkUroq6pL45uScPRrTrYZMnfdXFc7bCeqKPOlYYyTh80LdHHX2yzL5gv6nErI11jXl2LXgDC0eDdsvx9VT1NkitdJuZYa0Sz5dh5KA2iP9wCDkHGBzdoemQBGdykCQO4vvbOjX48Uws21kn463tg/WLrIMck5JdSngrZPXj8DWbJWQsrHrJk/yNIoCfEbBY20mogXcVuzpmcPya0dLc3L1o+On+l3Opdb1JJPSMOlH8fWRxzMySMyQpOmd1yXWSmR6BPJtk3prpZuZKEDHG4Q2zfu5YwF+TUzEiB5u9BWE8jqUPlqWnUkjqDchzL5ng2zuhFd5OMaanLGKnWfnZzz5m4HU0tBieJWWdxvb4CrT6YnbMUP7NSEiQ3uaybeRnf8As8hKgY2jVWAvZLXP06CsS0aZ2IEER9XT2blEopQAJESEOyydpE4lfoDiBLjb2O+HExFNyacl3j8/WNuuX61POn/6vrI/1Nz9FWW8lY+Zxv1/xXR1N8vK68I65RuvHlmzzVBf3KZErp7jpMqzBsIrdOqZP2W/0okOxkRU868V8c7rQ7+4o9rvJ/reuf0aX9zFrCxPt3xnCcC9emryt/ZWUHc786hXURLOO2TH3LBFQTrxS1V1kqmZ2dZFTxX5N4SSan+qghWzFFhqbsD6nKVNQ6K2L9iVxjm2VeVqc3buEjfnHVM0obQ+P6HNsutUNyDDGLFT1brdtszj3PLWR3Nh/SRNeElfD+TUQASQRbtiJ5ZMgA/S9v3vAViPb9dMfTYtARxvWf63IiaTGfSfr4DR/bzTc6+kn61kY3afHkNU0NEGNaf7kxXknfX6nrjqcBl1zkv7MkxX+9UTIORCSHmtAdVok1f6LLi6J8ZKsmbllHeleHmJ8ZNa/wAP7db8HX5lVUAGPlMSbWpyId9u6nSPsTtyQOxPaAIesrLVaIl14xamXSn9amdZNaevugzt0G20pm73KTMnmyyAy3GuroyPVj1s5k7oMaRU6tmGWcfWRlvKSHUV9dgwNocuwrI1qvO9u/LX08WbyKIzu3mRseVoyJT8m+Whnvkg+5NVhVXZlG4BA4wilbLhgpaACREcp+nAJEq4GcM6r/F3RkylXzkJHkJ+Ppp3L9marbVGqdfaZva2/ja8TM6mXETsiv7SfacjuD/Ug/vX6DyWMnGVl1u9RjubBv6k01PVLMnDqq8z9mizQxMUxNz13o3MoFFI3jslrJdfeZSl35mk2Jiaw2xvY3ICESMrzh6kRYBAsmeB3CchjId9IknK0zPTGPddTXNVDPkL25bNizuKaK3XJtkxs5aeCpun7VDKUk1ynQfF1NvQeGLQ6l1dSQ+GPrqVaiTGVM6OB6OqpZlTnpGfGhBMUuSdz01gJ847mMdFJ1T27LFGvtdbq5Hx1keoBecFHMHzxc2Uar0klpiF2gbtsu0j6UoxZF4yocfYLftVYuAk7JHG6TQL++aEpTqcJJWlaouEqepXe8VGtAAtAb3vlXnnYuCr54CmZ6lD63JsJtRbqpTQ66DlJTorfDeQCrx4YOb5q1nKkzKUXKkPXgEVmo2ZCa/MqurakExLKP8AxnN1Enso0iIW2bbSlCLloA2jVSMN3jx5YReuk+R3GOXzJoeuSyg8lN6XlpAvHVxN6K+2LjkJi4VSrNXQ7Clo5dSWeRb5DJz2xKXkgGZHGEk4pqWaodS/GAMtSI/gXhZiaHXyZGjXepx5HcnQE/FFDL4du1fsEodYAXdmcsoARA7g3yFMXATbv+Vu3ImM6ofHa6nLJTXWm5djG5huftbk0mqebN7rW0S4i2qyYZ7m1HvJPVxo5iMktSdXuftP6IVqXvYOMxTMTWvuG6Fe719rtgkgqXwzvxQB/tFRUhUXXa/Z/wAj42122/Xz9YNninz11Nfjprac7hRBCXue3bQsYHPbsRsithjVUwEtfHk8UOTimEnZP1JFnuanxBM9H+/tr8SyRkafK1kK6CJLtmZyRRUP7dPnU6T9z+XyeXUvUXZM/qSDJPP2ySsc/sJ/6D8n7TdTNjtoj49XM8OVqp7mfjAnfRblRibA6dk+ZV1/ui1ktjn8vzcaWBEbrkW7fvGEVNrXjzC26+kZfj11VC1VNbGNaaPDqjf5X+zVTp0uTq9AqkzRTatQ7onclU+P/mi8/HEV8gdZCfjaG/iaJCt0y/GVNs68umpNmirXPXe90To2g3lVZyIz3zA7qxp6+1da5/LHUt2FgtsYJZCRv408DiRxbj+R5X3LMcxybg1JOPqpFaZd1Eu9U0irynMtKWIkGhXqUoZoltNYr8JIPTWvKD1qeQbZkSUyvLjHZqS5mhSaTdtSf9tv7NvX5Cn6kFcZIUfT5GuZ13QNVY6rXlaPPJLqKyPA4n8Pl3/j0nbicAuO+2q2RJyzESKxMfbp1RQGVv6nPXRCb0HG2Z/BzF6Nx2fHvIY5Hr619/kVbVNIG+k0AOm1VwFZMQvXxFBuqDjRt5ONjRZp8bQo/FOsu6Xm56n+yf6dYwBrkXxU8eBKmXVgwUWTbxZwJZtG+p/mSP0Btru+ujmJkyxLP21Dkg5XJPfVtjyHkt2RZrm6VF1Lpx6pyOsqebpQn5W+T4w6TIwv7lnuatlmq4Kp6pxgdUY9c+JrIrt3KdS/bnjwz+SnGbHkWaSXEHDk6nc63W/8lWdE2M7R3+nf13uJAxg0s2gkXRJ17Um3H5COdv0enYXJcVOSWmHVVrq6SZLmm+WsZO2WZOlmd9bULiTtxs4p7unHTRhyxPOyCqm4pamZ/X1kkWdtxB3jLqNSZJx1HWxCUu66oy7/AEQnI6+PSzNfhXUs30zDJP2rcuXJjZ01NrTt0AB8vNTXIbFUUPInJkSYYBDyvImwCgUkHTzn2n8oLZYQIbOfj+Nk1PYaVh1K85FofFP1oRf9KyR1qD46qcM5Dmo5rCb3jtequ053oG5la+5Kxi+q1kyOTHXyc4maqcIxNAeMeqjzukZNuTF0VeMZiiacma6mZyQ1iWrXFygY5mCeHWNMib5p3jPFP4h8wiNwew732vhW0u+PYJPPuLVWuQg5kyzmjJkL4WYk/umTfx8SQ5I8IPTIrKMojcbd6clQ1W70Erh2T97aZyVyFE7aY0/dr+zM1WcBlnHXMFMM74dvV5J39wJE0FTuaaKpKmWk4yTkVJgd6yY3Drqby8L0vJN9n6poEU/GR6RdgYaSVmXGfw8jSylGcYpd0rcb8F1ZaskeZtAWnj5d0zkDE9TWVq9Gyaf18ZRLeQGSWC9OKp1jXSTAHiSTqKGeJ8m+tnNQiqnFfXQoWUa5nVShTqZcnFSkv7Xk/qTM/kxg9SO8fiHnId3q5xcEaayS1SQcsQ1NbFTzP4gKtiRE+3a3c92tMTcH8P8AiMqMDG7F0dTdxbzkGgyeGIZj5PqU2XuucgLWQ8zxqhrHu2MYZKdFN01FGXrxUVw2hO8cO/IuTrwFf9F5HnJj6xTl64jUyTxl6THkmmxp8VQruuU80RvMc5KvKPgC6FmCiXROPFW6xl8vZpPDT96rQeqVeQFH5xYeebaoG79SOyUkFMBR8xJBFhARAbfExvrHz8Xhmpe/3yl15cyVsrXnrrYiip76XHbTeJqh/rXT4+EJj/J8dBLKWV9juFGc8jeJmx1Dbj3E+ITvCQlTXQYe46K76PEUH4HmKf2z8tTFO8bj70yNNa+Ob2ajUxXPxv6RkFm5+1gcRacrSsABFQPLNjIwiAYYKwkWeoTifJBicSBjeZjtd5GVRTVJKSkrR4D8Dz6jNXjzjwdaukavmDslKbNUTO9PYdp5oXWXR9cVKawX1NcVlHZVbueq1P8A7OZZsCZrWlhI14tmkcty2RUxWjLj6iTbMkhE2kV8mOXXWlJtYkNWcb4nA7IrSBZUB37iJwZwu0vQZc3NRpGI+MyM46+1rwSvX3KiaMtf/c6retDslVU9c8ysY6mtbl0jknvIzJNPE0fqfonkSJBx3k7krJXM5Kl+T7uNGhDiJ3vrS/2Q0b/J9Tk4x4pnU2cw3jxdJLIlD+nJVTQpLtpr9jtJEkshAobmw3EbZ0hnMDuWRCUXHORpk1FY0rL425i2cfXQSuJXxfT9foI6rlU1+IKOXbOQuqicxBkyGPJvist9HNYuHoqV5dnXKInOPBjlqXLTLjf1Q5DmMbk0kuOiTSeG6Jd60/FOHAHJjK4lvqCq7m/NzTwbm0rEH28Uad0flAu9gFVtiQcECDa0t6oFIlGxEyJHN+IITBFOntQR8mTJMx8Wv6z95IAKbRayPM26Nm4TrSIu4DEGZmjHGiaw3jcOqZxWRyV3zEhSxW6xlGvyL5yemfP1qAtJ8uTqEKiZbmWqD980b0amfzIwhRzUnUOSo7LZMjKxF3KIxrUu4N1k8Oq/K9TKEwJeSZAniwIEnE6apBTwJgKxJgmESxSQ5HOjj/21llKx1jcTv/FLkJXeHdA3kmfFtKqydSoi/F4+t1vIffnni70xiq7bGJrsrjZHknzsA9OuOZjHfTDNF5e1wjyi2jNRjqSeSeOq3/vr8c786Yy07ufEtz26ft9NVFgEhrdbk31phEBRINrEqByOXtZpskAIDszmwuiJMyOF8uVMfSfii6MXUceZ0E5SsuQ7K09NDHVEynPC/i5/xAr1FX9LmvvBc3rDlyPMkyG6ePofaDS6Ob1npK7GWqL61Z0DMRvldzuGECqST9bDrvJrJqoJsSsfM/JMifFN0S5AWt6pa7jJ+pPxEjCGLDgyntFxfaVcjgCyH/E2sN+UsPTvTVixYyQZRa/czWWhidjXLrHf10TO5dO9Coy1iMz8lf2I6alPjclLOOr1OOZYa0x0z/1+zv8AAvepdnJWI5MfRcebXLquhRkV5ed3kNu0t4xlyY4ceS+wI+SotqT4+5Mac83uV3Jxlj7Sv5O1Ij03EGbTgCy8+QIRsD2NhsUzYkATMnRZWspjnfMPNG34zJjxnNu5bbajkmQYudTU108iVl+v+MKOcE2OTyQTzbGXc/GcpVLWwmeXmlnFF1i+v2+4WS2PExq8Xkqpg8SMyF0+fKV+D8XfIvieM0Ff7wxPHN1l008yVMToSmV6/KDvuUexXsLLKMRdr1fMxshcJCCrkkNbx+IjS7Q9Ny5Zfi9VUH0ctTOvHzDtqTWhN707mxNWvT0XJv4/rGmLhxzVz9ZyR5WsjdM49BkUp34GVxNlTUXZ0mSiagJ7rXxx1M9leHGM1BujFXVE/hTWP0uM1IlV9YJHIXac6yS455hKeRNSXUz51+FISLi09gR3/bdakMF2YpDkQhfBi+6hE6c3fTX9zusU2TkHFd+Rh2c4++zv7XLSMqVJXy52aDPJBP8AiMhF1irLIy9T46ammy43qZeZmyvyxfmttb+WNtFIzeWV380yBM8ks1LUrudL2Ksx0aQmanG+J+Scr+inRVTdNX1Whx6a2IAEZF96uwUwls55jTJ2jz/4mRa8SR5epaMuCOZ2cgQbm+cfm9xy3WPJ/Xy6158AIQvx46caHx/FJ8m73UiTkrJJkiumeR1XPPQ0U/iMdXwbhhipxWnytAAXRA/Jzp5cohMHPOoem5Kgxbc3A8TPx48mrldzORdz143kKmgmL15TQNzdDhwHf+f+Q0gScWHgtMSu/wCusi8k5MmOo3L1knI1QQR9ZlyWk1Ij8Op5a8TU1uaVVnpqrJO6rLfmUW57YqXsqIo3NvHnfK8qyBzLkmpKnGJeSb681iqXnGZKnhjwU8EBj+s/YCIw4qcOMDfIW7mm6+o3Ldwi4nTNJNGzxIzVMC04YOAOGuDxgPVACPU7oECy9Dg7s9iIDjURmx8pFSu5x1VYmeMjq3M3Qk1jXVoNFGwIk2VzinRk8rEnQiW5MjUfJegxtyKsbpB0SnIurySwY5mAgx1JDH/s+n/kctTLr/rbqleeQaLPFJT5lOYZqkN5MkA/Uydb/tTFSG5PjZGevyQcGTiBAgeVZwCE9tMVekKxYdPGLWIKBZpJCZBtlzd/GCY5xz09Va5sU7m9dHVn1jiZZjIDNSfbZumSklKqPMcyUHUGTJI1RS6+WeftL9tk1IDnxyzjmuq5Ia1Ro8TFZrs6FVl0b5nmt8sfjcrfBU2zkImW3qorEHXV1FO9cG9zMk342d/jdMy/YTGR9rZnUlBqISQAOILYGahgsNPQICvwQUZEpmNE5P12avZqtnyAjKSykb/IqsiqZbx10WOT4mWepKw/aalel5xmzdVKzV2KrCX/AKsXX0+P6GOcgJ3mKqDhL3vpmK7/AGbM3jLI8Y97yTqZmZrmd4OreaG3gYA/sGnm5QPa+IdlYdx3PGoqMCkcF2aTt9rm9tMxuWhmchpqrgUbcVKVy1iHdUvETqZ6QJ2aVYlXOU8jSZNz5lmOcmX7XUiWZHJOr3y6aN/gS5HneW5qZMnBTIYZDWMtjvJt6XzOOo39oD8LgwlZcS3lzuqdupb8yNSTAYmHcfZ0uio5PxM1F2UmQbCmwn6mdzGi+XUAJi59PMG05tto8k1cQh0TOPKk1/iuMfQ1dbpbXmbUJ5dOtU/i2jE1BkmXLWPJiNL8VZSvDl5I5xWOllnx3H22M6ywnyYpyeCceQrc3Ny/FNIzM/7vZJo4Knp0DePLRjpoH6ZHIgbiehwnWME0/Q8C9aXw/gYBTbztD+sqVo/xjAZ3UCd/mtczNnon4ca2wmSjTVHm7u/Mzk+vBUmh/wBG2FJJAhy0Owfv8OyU+Kdxpjuz/E80tJoXcz9a2uRY8F45bjrJstcczO/nL24ySgqvNaRT6i2JrHETWYJKx/GPJXZQk5PlKo26tqk8kNkqg5N2sB+G0H7x2ULfS7M2i3bzeMb50nJix85arF0OWZ7uqljLcmhrmRjGt/1FKTnXIE2sk87yixfMJPxwzyTWSYNGNmTmp2o01U1ozLk5nFHUDVTLUTPLFM5YrJeqn75BqqJd/s1VJ+DknI2z/bfORmFmTHrbjE1LM61ME0WUgp1uo2/4hjfBvNx++p8j945nsMHWeeRZlZfg6mQrud/e5t3jpQpyp52vOvNC1x9+TqrKaRaHIvLm0kTWKiitzsPLD9ti93lrU/HBFLU/XHluNlbL63D1uInfTPOyp/CrJH6jX9YxJUUR8rr7E086l8909zf6Gd6iCORbm2J+nALE6U5drImFAdjHPE6PeKPrys5KFK+vF2cyZKmmWNtIaaOfpNakUmTFLkm7oHJeq5eevrMY7yU80DYzZKi1Ek1r8jI1Qn6eyZfqTerD7gpQ/IN5Nc0gVwoythcmKfiBx/bbyFs61NfJtyF0hKh8iY8bXyzN/gSvwgCRcCHewuO+bLU8DBAudxxgmUiLaO7jDMVjvj/1464HJNzTtrJUaJUKKeR4a+m9yguKjr4pqpCZ0NOIUY3qZiqjVLNfZjVqmqo8kkfadLVT+4KMLQMNZNMSY6K8a+kv6R0ryT8ZNg5JeTJX6FqujNLuYWebdfGccz0V9p/EbWgEPgGYjM2G021UCWUvlVM7pYWEC1NhqLrDvCJeTrLFFjzztGcdXLUB5pZkm8ZKzyPg67rqckDqvj8TPnFqZ+bteqqUoMszvTvxaM4fFjZMRAnMS1ATjr6pTkHmr10iT+idfWg/F3TjyNeGslmqoscdVMouTfKbi+Ql0yumx6mYn/uj3WXabc51AUE/6EHd/qYg6ccZGacXfxQJVUx2jPkmqtqHoP69VzuqGK1maouOLiyZrGTkhAikrh6aarGbGqipaZnwZJVnCsQxL9/mqMd6+31nlPkakZ0MQwaVoP1oWlYk8OSJuKwX0F4zWsfy5S6kIodiHGupefDJ+YAlFp5VlTO/Jh31MpGxIvvFu7cnsdFZWQd6rSIY6SKx4u5Xv7MOiS3xLsmpN1peMyATf3sfqzc6yYiJ5atppbAk+pteKDIzVT2FnlHJCVXi2MuRqulh5+MmNE1t1tmGVScmrx/vxExW/wC0VBsvqJJtq4WaCZnmdVEp2AJM/TGGfvfaN9HPaIAAiWiOC3+egfttnJErzm/c1VY5Wrx7o0wUf44HSLrRsU3LfciY+abru9fJMf2rihoWGYnS/TzuSdmbfhmqHUpDLb4PpNTeybJ6SYHYeCttbCK5TI6Ky4YmTzTNUPK5NzPkjmhatRnm5kkRqDTQhv32j7jjMm+7WR6kgXkPb5gTSIidQy/Mtc2OEBx5N8zuZSu2+ruftjWZfsbvwtscePTu/wCn36aBYPBjNi7UZOZ55EEdfiUPjck5EMYt95dtya7xXM6F/qAUyPcmmjTfkx3im4qfjQxwlEuwKF8Uzws9HVBzVIkiKH9iaQGD+wRe8baIpqX/AI59JUDAkwx6cGC40uK0UUTkKagp1VTFfWIy9M8RNQfbRyVLAlaZ3VZC5tlmeLMnJOSYym8USRqzlnS0V4uKoKEjLO8ozkqRmciy1GNfFMDJzfRJp10sUNG5Ca/xxvUhXjiYombvQc0eZncLZ+52uq0/k87bRKHb6SA7PUmRsBF1UsAOCBYtdmNZArlax1UjQUBjsNTOpMlcMTCaj/6t+M48o1BZmeZZwFK3DbPXQu+t5qSKDQful3/jU1OVu7chU+cnZUk1H0/wlyRYVP251p62JT+GSI+XH/a5KokqZ5Ph8s5DGO9QTLYVP1pPxCkuyfB4H0f595pGDfdbekCwBUXYzEaKYwnXSHSZBqooJqpPiybTWl8RO/Kzvpl/J4UpnRUc73PNXON2hFT/ANugPP307JQSvXFZYDKEY5bcdT9T7zLjDkckBOtdE+KP/gLXy9T2a8CDDwZOce23W7mnoa65KjpXlT8AQWCgQeJ/CQsGUEYsRzVNLqEMAgycxLt6bEkr3vlGmA5I1MuyrLCGvlud0jJcDT/WQrXConZazZMUXjipZnGZalZqmaqqXb9EDzOQXolTnHjxbcR5yBNN1JjhycsnePUGMkSZTque1meQilmemZ6+Rw96pWzIk5ayFO5NM9guwnnQz+Bhn1SY+XeEfUwgYYQpd2AtUKflBmfxSCeBJRJC/wAbMkmNPKxzM4ceSDNkoMuQkiJm8ZDNZb2Vd64XTuSpOPqp4yWqaYkx49W2Et5Y0S/bzk/tLemKvJqV2n4GIrpkMdF06uZ7ri1TPeRZ3cM1up860cumfx9A56AUx7q3zDd9JVVvuqqt6hTmsk6rX1PzCuq5MsCLAfLTKGA2lgcjWYlAwIF8FYdrCF50UmJbq8dHFy5CuR53AyS0rjbXmI1k31JzyMZN5G65544uvidDHkxnwjGM+bk88tnTVMsm/wAfc/Fjx4ixy2OTIzM9h8eox7o271Ugzu6m92bglUzLUTZzBjh6ZmZvJNPEU2tX2pNUGr0gNa3ydSqSRsriTBHjBylGmWDa/wBAxfNQhwGBi2ix4+PpyTWSioL5H48iQxTRyLNTzBtppJrdfU+Ke44fkiq89u3HEpLzUHyTt/tMh9iqmXG7ln52TfExXeqqpuh18yDO/wD442rqMnU7F/LFHcyRVDBDtqucs7max1jWsnRLEpWigYTq5TH1PeBLtYe0HN3HCZRAU0jjNN2e07SCJ0txM2zi/wAnTGU6xz8mJpk8ZH6LiTXM9TLkB0ddHjghZ/8AIo6usx1Ub5GeoeUTqtjj+s3zekL3+GY/kybZOZlxxO6xTLHEzqqX6r1yfXmtD9igZ6P0Of1/qsHoPQ4a9R6v1Pq49P6TDievUZMmZYnCDOuVrkMczMp9KmZUw6nVFANVRimSTtSmzwuYOmmR8pk0lktEKPBuHb3HUfxLH66ffPQe7+ir08f/AEjy+m95y+oz4X/xYn0lmWTLOQuMmfLcnxxWikdDOOqOT909TfrPd/W+ozZJq8+fP6m829FNZbchGogTJyAfYqdRW6jp9p/k2D038C/inpPZ8eXfufqMeR9yljJkv1Hq8hU6jpOvSYLnjAXAalon+zXkXuPpvT+1ehwY82ab9z9SHqs1+XJinLF1jxbajdf6zQy1ubqtRwPl9L4gdasdcD/pn5OmkyKZNSYck+3Z3XR6afTB9J9VRf8AkRAAixgdnLmhucUyLCUQRRPQSp8V1la/vNNbpOvHRKifgZTmV8G/8NDjXulyBmut1ryM/K815yamdP5mD1OP1FfFi3OWpO+wYNJq9UtRJ1pJjZqoaDlq1c3EwsuTUzqzrIqBrq1gWGadM9E0f/ZCq/PRo6gqRCmyRUBAvjtGSBOIqRBGIUHmUOb2Kc61uTFN2Xlxl1MGvL8d1L9ooppp3vyElg61s0nN4nFilObqB0uN5smZhyJ9V5TUjJM8gCrsKlGts5RK1RPbMXPUU5IAiZopQh+MWjGg/ldlasr/ABsQiKT8mU8dI/ZaLXqWS7fjknlXUVNdxMzIfG3YFDS/yYsUDUrBB238hQta9Mjkm9GNnLLfQ6p3qq421UP+MToJ89SkzX4HqvvVZJe0siua+Mx04+qnctPPdLVVz/8AdKN8W91ZrFLj3hZqu+CgPIdVTVLuBdW80B3PyVUJZpDIDe7elORT/EFHx1RZRITyAodOjooMTYl7BwENsYC0BqEj7YZP/wB2w/ReOCMc+ZsrQ2S0OSyZ0qH1nW5TaG/9a/Byjky1DMvw4RpZJ70c7e6W5TZjZiTsNvjf4zGYuPlyjx5NUF1P1m6Tm5Jmf0K+SnKCoqLrpmr5SjDIbizEf1jHdKUy/bsTQycFTsel2Dc44gcBcAiHppBXCi24UYNrN7pnWYa+QYqubn747qZiRiCXHqjytIPOvkTVVNk0LZx1r7c6sZtfDHX9Gq1TFPk4mZoWaJtPwkbn64uObIup8bqvF1U19yL8SpQP9dHOqXvx1p0JiXm0NcO6bPsfV6qQ8aaN/lDDtG8wCCN/zGdLTPn5ndCa5wi9bXoDumvrvTzZqtS7J5VCWjJ8zP8AVqKUpO6oruJ1/Uncl0unS9bqPyfOTLUk+fjqbo1N3cf3veRpFmq3QFOuPr9qYq+WeQk+uC7D46u633W6XwgzeRG2ldeB/GyZhWQyIO/fIlHU3ntliURAMn8/B0ePHDjaqgnod3SXomFKhlfifrsn/c1yvlkPlN2LreRxy0O+qf8AH5tr6f24oFnW+ZnwmVkuaE451I/6yXHPM1vq76F3oicnBKT/ALVIVWSiVrfyFczPJSSTU15MfTf/AErvmp8chJKHhgDlPtYi1puyAQgz8qxAJTjFl7Xuy5vIAWRoG0GCz9ZZWj7WgShzFaREdkfY1pmTgmqPo2Y2TkL2t1vTf171U8uukhYk/WbriSprzqg4ir8cVLCrz+t//O0Dvt+qI/DNTvosTVd3WqKPDZpXURpFESBvj+e/MPkaaELwP4M238yXN4F5ala+yTPOKqjnVN9JPmv8n9To0o3+ZOLEq1XJubOvBErqsC0G5USYmSa1c1Q0Mrx4MMddfWmGnwtGkCLUJJxsnXhQHypJL8qBimaj5nWPvW5qKJvty0ULZNBVSif6P9QSNkh5Lycu7Fj2uwjx9Nkb/QrmGNTNfI+JnmDriOJ/6QNM01qWNEycnRPQeH8IK34nbNfGNY0o2yxTVIsjLpP0CcGhUzIYIyzNVATGSHzuZ/vfj/J/Qn42pZqbkvc1KXIZ3WRxmj6EtTkZt09lNw8RVAdSstcTukn8xqqysOVIQSAEMMDwMyEYgkXlYuL8pGeNRMiX1knjTmKUfH6MVuv0/wD4OJNvcym/wwxMRenqcmMN6KMgAytLRhF0oGubT9b/AApIn5YyTT1TjigHe4IkarjYnVTUBVcqBSTV2YXHAMgQWuMKjIyKLaVvJTTLqXrmuWZ/OequRIaSO498bWM7pC/p38Mi5WOZCnDaIMeNRCuqZjSWBkZcer1zjgTxP9tKz9nn8Zy1xEUXk4lbNX9JC91U9LdJImhda0PkbjwTR/T6lFj9UV0y9ZNUzHQc8wmyB3/Z+LEzl7mKssclG366o3eN1JrglnQy78jPXXNXWjdAoYMQR55Q+mgUn5QbNwgIEyc1MY/XStScd3OPokI5k+VnQ3k++4iyqmrvmqTj9eVtelxVItRhvHqYumcWmK8iJvbPPNeCoOL5ESxg9NjWcmSfkr62U1OT4+Zf8SJVEnguZR2PnWtbNw96/wAJP1vJuQkq5Ue5tuuaNEyk3VEzUlTK8fU6yIuBGzxgiBguY99KKX8oU2lpKXsh9IvrU/8Aj47K6eBdTQBGT9TrJ5uq7LGrJosXYqVVnDin08GpFaJkmW62u+WtTJOMAZZUFUUl/Nli9JjupzElXqr1lYub+5XwmuaeH9RPlqld/HM/lqvSTOVrZzeN33j54vJdchUuh53u5rrYux8HNX8Tkm6Axb02SInPGmKScEKJICSa+4Xka0demIFki93LN+fHX9SskgJDL9dCLqfFAorC46pqadWMWCrohibvrm4097kqAmklQHpD03WWgrUGGixXD8ldrqJrcahOyxlWOVlNqZ9NJ1B9wu9S47LlkPttZ4kkSudgzVzJUjWP/uGYMEdsAh297qDxJpJKRAuyp/D6QSpsEtc/Pp6xuVqekqjHXNPH2ln7VxvFLDvne/MhsZAuLxxsZurqTq9NYyqnhrIczi4Yr6SPItarf5vKhyEZrNN7mvrLU/7tsrd6vpqrUq4nTJJuq+SBGR4+nxjr4+rjx/R6kN1T3QJrQz1uoHXs3M07KH7G1t1pegqLIHtAQHa/PnWirFqiuPHXxWuOq7XzFbNG9gtSeKD/AButNdxw91tArJPVMNE9SEXNH9dqEwMv2IfsBuMuNCb4EJ5ZI3vodZKoyPNddTWQ863SJSflbL6aL4u4K8wdFfU3VVbmqUvqHXyOk1NQ40mGd6esc4iTuG0RgHCLQ0lcUhlyLxEiMzxzd6hx4octU68W6tK+r9YSOJqnakcvjbslA/K5I46ZoOIcVdG8i/qjmunQ0czKNIQmMOnc5sAdOzj40bklaSamaa6Styt6GqoDe+Z61/BU63zcUf1Jgy65jtk3dVSzLPH21whVlO9HVpIiRkucTcnHeLEay9MCb9htBveOz51QyPxY8WO6mkJjUFV9+6Yu6oWKk6lWC+Q1HlKRVOJxaY+0fFtgYKpGLqthutVt5Vevrrw38uAL3NSlZNPyFXMLy47MlFa0Cp5ZekmhRRljh3j8q684ymWkTJ0Eng68zsCaJldn5dPVaNNQQSRBKYxZwaXxpEACJ4BEBjY47I7apcTeox71udvaHAyJ+h0uzkJL8wjR1+V8vW6gnfDxuACmSJkoyKk6V8gXXP6ZKblhOhs6aj7G5pE8RkyEgAmgATfJsBa94/k05StlfVpf/VEm5elrV7WWXqgO+a0z00dSByQS7G3tscziHAs/vmB9f5bSOL+ITltNs0tfXx5iqoXmhIqYn+3kehELk6itjxLN7KIdQktVVbrz9C/tcMaTyfl/JJGLbXP14/7vU6ON1/8Ac6W0A1GtIeKbEVM19QmOnqjloDWnTdL1q/6+RnrYP5oayCKXZG4TixuQhzDxoyO387he3su2x3c4wmTJ08yo3Q0T8eSreGf6tBRqBm+UaHFp7Zlr/Kwt8mWMiTU02UE4ytiu9dUxPikDNXxfHf1v5Jia87jHVXqHcMhPR0GupqthumEZvvbZzPx8pe7lufr8kmSp7qrvnHlNNW8cjy19mKv8ciJwI222JqMQRr2hkYACM2iHwNwVEM6ycs6qc0+Z/wAU18dbi+ZkaqqNz9rZySmQSudpRTMldprQ/QhminJzDUqy9VkkcazPEr/ZOXWBWWWXHBUSqoRLlgFo6fkc3kZQIuY065Z/BmVyXTa4wyApVIpIVGGSGQ3M9GyraJMjRSpiYY4a8fkIQsYYNsfsRmbO+LWWnjdZPUul30dTBNGpjc6torHTtkB3W5rVbKysmTcxBx4jBWSMfKo+GtrrGcJd8iPW9hSoxrQFRtGIPDzTLyxdn+Sb30K7+sDb1PSyTI5hrDvqbgqaWTVR01WSeara1jyH73JvZe2wUOQ4xnERuW1jQ1TEGzXaGj3dwiBCZtcOpsmnH9ccpRXGkopqoIaG3rzRLpCjaOGOajdd81SOuDIybbsIrHPLMDJI2tBtn8nM/HEmA3lZHzrYJFGWvjWpIuTU0cu2tJUIE91uckpU1k3dUSZIgnmFo/d8/XmZKNyROSav8KiQgfBAtABV8m1g13XE4SOY/THaQtNq7KnJrWqiLkm+brc/5K30s2iW7PAlDOkO2szzwnHXM9PCSatopvwpPxy6E1NAtImvlftrqqonHueqnHocWTvut1qLnzraCSnSZM1C5MWV/wAlHfQagqRLusTUljNGlol2n+G5ABhXBxiV7j6DBiKpKgESgUfeZi7IsREJzVtUzX+Qckas1d4oYmpW6ZN4xp1YI6yTOjdtxYcc/JC6P8ldjyfoHFkaTxahREsL0HXQ/iNEZcdzZxddWZK4jbU38eTQRQ6oK6aKUeRkGfI5M1RPVONr49Txr7AiO2gbojx2UaZPCIkMk/8ALfs19j7nOho7kKYGyI38+RGjynzMSXOMiYrneMi8Qad6b3kueJY1MXOgOrpmv2UHxwEBjxVUXRE61rLMw5QmZA+S6rXkCtB+WYjHOBT+zu37DZ4n/G0g1imuZ+otNIP2nVMj4ncNSHVzFVkkiVX4y3w/WS5liRrfjdVpGexnsIAXYSBJYh6R8C18ApcxG10Anq3kmJgq+Y5xTZU4y8dVC0fpquyvs3r9dPitAPV5LxUZJ5x42yXm5TqV7ggcm585FOYrqtVNW/i7MphwuQx1d1FNp340fFWWypMcrNbknTNFcddgUS/In2aTJU7ZxxIdT8UslPFeaxxrVrwaTyiZnjgyouygoA9o0CFyBfeDsFg2P1h06rEVj4k+lXjo5acX9/ki+lNZHk+RpNm9A/g5bv5pqpj444xTDPMbAPmFvrGJ8nNCXD+hGhcZpiMcZcZE/QGI0VU60ZMXRZJKLyBXnbWmFGUa+O5rX1jTLOS2BftTU7eeoeVElKXwDoT8vMNeABxcXhjibxeflC49NkaSycYB2uUZS7J3Lqcs4o/fG0vmnTS7p6Mm5Zk0oAreCzEZ2uMUYq8TJj7l4nHVUNUVS/5f7ahnfQP4PFYMIVprJcpSfLU46ZcdXYnMzMbZ/tp6AnwGTVkO63EzTkdU5IiZrTuLququQ0EUa6JoUkSQd5OA7MA4tBhK2iklkGqIU1AYIVkQUAwtiIbqnGT9j+sKIYqhpGZi5SBsEhiTX0mY+wU1+1Pj+XNMF/DMYubmE45heS5KRrK6dSMzNDX4yirqWmcg8zFD4iaCsdOcse5qfvTNMFb/AG7D5rFeOjV3cFpqULuz7RlmpGgfqO7omjWqdXgLcA3nuuMBvL0gSkCVlYEATcYClqXoV4RCLnIMT4ExTkNH+SWOJi5QmppjfWqHaOQrJrHUk8URJdMzZj3WXxW6u6Z1NfQo8Ez4r8Rk9URwRWl5jIpZvq5r7JXHds19z/162DpPyzoovJiWBV4+hkDkanglDTzE11XIu0mllNoC4uBuL4n2QdnJAfUQBsNkV4kJIQrQdBvJoZG5lxSkxocenZQm60Hm7ZxVAmbeLqll9eZojCs/Ik8zF7EJaayUVm8PJufjdOTYH4tZwr31mh3jmt7cA6km/wDIlQEXWz9aE+xy5dTqcGPULPdX9NcGqBpKGkK55kOfprrYIEeYKIx7RJRlKcaTAKXIlKwWUcSUnEDQnp6j1HcPDc/MyrMP2lMIkzOR2DJvydTt3yNcWRWmSx6jWrkB8xcRunqmUKZ0/rzO0S1j+O8jkybLiuGLEfq1DVv0xA/9KKoi34yT8HJWYiKxZa2TiJ43dOGvslZBNsEhQoM0zRoPxkgYfnPGLD3/AAm2gIXkYIPE5Vhb1bKGDagx4xvK7VMmtl1GRI5xOMY1Ox76KZ10ga5VnbzTNsuSZYnmHwxU9XNgV/aSH5JSHRtopy0vWSuo6nHzJdTuectYnSR0U6tJvpqe8e4DQV+PnGipkVuXLMF81OJ3vF4nls51MaSZp5doSeoJWG+DabCFxcM6r1qAKZncQiEMD0+n/FlT81oykUffD3xxj1fW5oqdrc75x6Hamvr8nM1Pg4bf+oTAenQkkdCOTFNvJqTzc6oug8O6ZwssZExR1jx3joZGqs1pYqiv2aq2t7lnnf2per+pZvvLjyRf6Tt2ReSg44ZDmYCXcUa1sJtyNrl/mfdDI1IQ7lH6dskv9wtTWeoreP8AUcY+qiiW6un59b510P3rwp/601ta8Dc+XLf2+vd48V8vTcMyGKsdvO9fvqbig/HDbTf/AI4WpJQB/lrSW/JPk6Kayfp+hz+38DtxUUE1VZB0wN47pNVOXcwcjbjx/v8A+Z0qlyCTGDtZ97Cdk9IdjtcOPTts1TLt2M4smIktrn0/ExTUk/LW/DUXXyOMlrp6Xo460h+AZMu/kmP3zA1K3i7u7x5JgZ+PE61J1W9JuuWWdTRyu5meh+oDHXHRlXqU34NTV8k7rb+HN6qWpndYzXUds1smcuSy6OoUcleblJvTT9Xfaw+wiWotJLegHzYwYwQCXsCshQb6bIX6YOialN93xdmics1N7WZbOZWeu9M74WrbE0LiqcOTOvRToeuZ+rUawVPSvmtRUhuefwMs36gIiviZsm2v8ZdbSxn9tLYeEKRjxvqXxC4uKkq8U1jik+SqBnQbqr6b8xbB4SbkR2iWmqSAOxsTZIGcpHVuqBCAFwZZBuA5Kq2R3OgyRF3HcS/FiMhRox5HHtk89Vf0+hoCmX+tY1/GNUaqCkyTix5glmJ2/wDXlQGJJ+ZWo3ylS8gfabK7nJd44+/C/HVZNV/8TzL9ahlVp4l+VkysdSE8maa/pc3sZuNhdAR/jI3waoNM6UPxUz3b4Athj/ybGeNBNKt6YFnLQLRsPSYMkyDOpuhqh/w0RWIlmarX1r/G8U3LlP8A57ZPO+Jr8Z6dn75LSPHL0y0SsFAZSZcMUujnZ1ySVvqHdE8nyTPFcqXLH6WXc85Cr1yPEvOpdUqc2Kc8xC3MGQVlJ6o605SJ6MZJAPVbmFd/Wivwl+n1EyP8XjnwPpqGcEoID7iJ5I/g03Bu2g8jC2UtPXETN8eCmlKjkGWmOd1v8Q7sSddFfcIZrLbqMwbmmmvG05/rz/8AYpZYpiPkTZ9meVoidfVLU4xw40rbVT+5PMn4M2z6cyRjcxKt/G8Vj5ia6rT0s8814EanquXdT6hY4EnMLEMJdl402rnzk2PDjflO2l47umMWMqaZoqqHTjlHkcm6y3kCiXUmpMTBUNLMmVMmGeWZjgvcaxzl/WPpp50f5KrIT0JXM+GaGevFS+EJ74hcZltrcasYMadVLVGP763vzN5DqWiZrXx0uJO730ZaunQ/3ucn1oZyf49ztBEtSIwgQF3JHiw20oD+WQBbP4e43WCT2GiZ0yj9neXeSsW6mdlYUV6F3zj8FhRNk1zK7qq7GGjZjMllNDVPx5GarxM8VM5GepNHG8W2J6ydza/LC1m26MshM2wr1UXVUOMOTzp+tV+RqKyaoq99R5nZeRuZgXJW6BrksBmwHdYzo9VkQjg//EcSrKXkS36iacEXPsKbQNl6UQNFGGG7joicmN+16H7VL8c1MEL2eGdrPUw7AkoMOPHTTxqtDTOQSQn40vWQltpBn7Fa+iSfizLdP2ieu/i7YqWboHRdUbxyjU/V8yPCy/i/OTOzkpp7um6Pjfpp+PpPvFlbOZN11OytBDASnwkCoUvBCwrakkjFzMZ9sRGLxqaqvkjFOv8AHJ2V/rijeSey1qB5xVqf3pnQ1+Dty4Jq52TaVFUfIyYzqaOHjEz5xhqZa+70lB5fsczXC4qqnVS5NNJHVi0/XW1C5lxpWt/iUHhjIDElUI44Yk0xp/8AZKTOjetNztNyIleTfAXpPISynqCEQSO6mUFv2B7DTpnnFCnXGnc7pg48Y2ul6jkpGQ/tdpIV+Kmquaqsfxby+Esfmp4mqvslIub+qfWtg8v7jeLIo1Xl+Sat4LANYiabrmutGlLoZlKPwOSzV7OWaO0qKMXO8bv7VFMpsCa5YQvH8tS4YFxwjy1bFyDnLlMMNqdsNmPM30xjFjnJ/iJrJLUzXhTJwSY3WLQZK2Oldb0KEjGLFcCbmonz1czY49dw+HeNbJmFBOcak6QclOdIirEqeXWwqKP8SV1Rw1M0pE6jmkJiqj4chFBkKgr5OCpmPiqNUFOlo41WOtyzr6/apFmLdrRupFsR3nR4IvlKQyxcczljZv8A62T7A48ePx1JN0jjyW19Uaka3Oyl1Pl2BNc1dTMkkwRUWhHgrJE906+VnVtBOrDTJ1HdJafshx0fbI9xJXdCobXRd9WFUV45pnI5MePBO+ZeJrIaXiuXHOXLSh0lVm1Kas0P2UYnYWHj7YuDY6HI2W7cC43xhwVuNmTG6x1jveVQSWpN+Er/ABzFY2dMDzja3rm7r8EWtaySGparUfcMq6p+28pOp5g6dhCKfk03lA5/pkj/AB43mdaoeRqhqq8T1rH54sH6sT6fB4MsNthlmhm3HupDFTuJifJX731thRCYKcCBz2JPODsczfIt22f0m/mLiNtHWbcz9eMcOKamYJirFmaY6H42ejbw+J3tmmgzVIxcm6ya2bZnHazWOW8e5SLm+ZRqJ0/1TZjjt6AKJT/IG7XUtTT22/cJmqLKOd7Jr8QdXkvzHEF0jH0qij744XlR4eigbHevAJgD5WWQvCCn2a2ek3ETdWhWfndlAsxosWXgshlXJNw0DxVheNvIakIevGmTe5Edfim/jqn7NXV4umKGW7nS5Fg+PkpJ5UF3AUy5M1FVLTeOslOOmKkj5PBbepZPrRZ+oo6kH8ZU3ryzGsdI6xkvKf5imsg5a3VdKtedD0EqYlJC2PleV+e+wBbZeHNJlJN/8hYnsOWK+v1mKjVlUTzmYE6+3yVdP1T9RUor1/UdJ0I3NZIZsiYcNVKzDaskRXnqBmKe8e921GN+R5x2zyt1dBPyUsVWImm1ev3JpT68zqGneHLk1X/2OpmRqJpCPGtksHO8QcrW5lNOyLkj7tX2iIKOwsNM1IL0plKwgBk2H3L4Q0NY4nXSlc915Fp3SxJMszNzsZ1zRLr9fi5eMUpRX6a5lrjDzND9akrJHxbVl/f6Z0LK7InmE3rE1VW6KH/LrUcxvqfkqn6kyy6WsIYdY6/tTbiyuJmiOU55rRdAkhySLx4aFRVErcCXAM58cRERdSTzLwHJd0oQi7iRJk6mZnXwvMlpzy1dT3uWZppdmxNnTr8VOS/kaMbzAYgs3RmNJf2sO1FqwAZ51vrZqVli2zUYtsUSYtFCEzG4p4OoaroSk7j95Nzt6g3sxnUExWqCaWv61W02m9TYg6pG/SH43t+ZhBgiTc6JN53szbzNh2AKI1mPHO6yr4x9J8iDQcIaA6ifAEMjTo1+DE9fLkpFJqBr65KepnxFD9qOccoqa011RrJaYZobTISsa35g8Wo1WMB55kZA3Ox5VzlrwTZeO9QxoK+Ods01q7Tk10c5JJjLO53+SjBwROR3h+QDF2FBgHJDYlWf1wGmSJ0+8ZMxUTuucLUzPmonqlrIOzJMmrrmTnorqfAesvRkj6XOPnJF6nHkk30TqYqqEI+5sXzdBU/iTJlmhM2+657s1OPpP2gY08WG4o6HIi07LLVTJqg/WNmQJ06SquWySxspNLp1IU6CQBUiqoBIKsknfANh7yRMpqLSwCG0QLn1ERI30WOqY6ZH7sUI7MjMhRkqvGOLlC01J45mo0gs9zTj6yfTHV3Skeoq6qKamfjqZOvq71/ag0H5IushXKuRx4/paQZBYusuwSdJFg0dU8td7LEvfQbJmy6Zbflx3v5Nbmaoalb3PmmGSj8yqP4AanblWIkD2JaVwDLcfSHYIQdhuWAiGAZsRU4qtQO6qPvLTLQcs5PBOMYqZQ0LREr4bd46yfHq5mpx42Z6Cbjas1XislUc7l6jINR2bQTiMpJ3I2fHU5EWiKieLuacbUQlPiJPsB/k7/LEmzXUp5yS1S9YjQ4aCP3+pIjU7aHf7/OfqVG6QYc9hcs3Z+0DRcEnfuyQFdypyADeNMyk3XFomMa7ZeLrGsk03urb7IrTq36jLzSEKyMQEczgq9N80jUJ0vEng+RCwAYGVWfSzNUoaLVueNTXx9GHuaUxuonac13MyfSvw8c4qG8pkKvJfds41U1HEilEM0VWT45y+MjWmD85azMYkSyR34wAp20xTSfmJIJAO1vShbOwAkbHTa/sRucdqYip3ppOZzVn+xKrZfjdb8fr63DFMnp4nIY6x5cS3MyHkOZyWa7yVQPNc46nmb1KURjxv1epsu8dlamqia2zjx5bnXU7+uPnnTSY1aC8QRK/bJN5D7MHWJsTlvpiYl7bglqT7QDQvNV1MO+TYEembO72haEbJ2wULIoRdlZEk6D6aaMckiw7nX+Wrrn1HMu451zWV3W+omHgD0X+Ce1e8Yf/ABvf/an2zJ7h673L/wC972WvW5DFlw+vx4J9Z6v1uD66hjDeP05nbVjPkuUqacfFz6dZx0I+J/czZX9acyy+E3qqoUl1Qz2O3j1funpvbvT+j9Hkz1Xt/u0e7+gmGpmfUXGP0/qAZkqqzSYKjHi5hK1Ta1kPL+NNfVoPTpImKmGFD2g8za+rpfqpgEIAgEgd8goCChJ113/J/pPdPef5y+6459FftXtvsns3vVemy+5zWP8A8F9Bhqpx9Tu/UX6qrqcUtk9ctf8AsT5/91zeu9w9yz58xT3lfhXIs1DdmNxOgqOvMZNs3PJWwX89A/mvp/5R7f6/r1PofV+jnL7L6T0GWbd5THhxVOb0uS2O4yt48rXpsnOc4k5SX88oy+p9Q/H0LwkyNZNSQoiuy13XmtSS+RT84vhx/a6NA9YimikAWGKsdiwHa0jWHxFQbJqpqJBWN4B9kuzZ1u8H/megzmXNg+Od/HbPLNQ670zpSks+VoZ8dCDH50PqJjPM5MWpFnJxdMZQPspjpqCb+Scaj+96edfnK+34r9d6rFGbJREcZaao4ImtMIlG7KJ3y/J4Varuetzhi4JoJSZ/x6nHj31wmSdoVEktSrpVmgnfpdKuBYsA4Ewv3AnbR0i7Un5l8xAcK7gNwpAtrVUZI+QjrJiuzsoNS3M6cXC6J3UNgxG1JRoKd5okjo+NCYAxprLNHFUroJ+58gl0RSn1K/NpwHWmULQSTqcUoDtqJr42FiZ8V5s2puiwF6oGUrHa46XqU1nHoVe7Wz7V540hvtoITsb33ACGXIuYMaRpLQ/8QiYikbAbNRiHqrVfEs1r7BBUx0lUSC3PPh1X2BRmvjNiKG6riprsmYxuWPJ1R4uaOp3IffIHTs6h/bdzQ5MmSPFRiNpUGrubDvmrLA7f68feeaNbGo44mruZZ/8AbdFEaV5mpiepf9TcfIaqWjQSn50UG2wQYja7SjIfjQFjtBjaDYRs8mNUbxxgeo7mqqdxsqImoHG/42ZJMk9yVNUE6BXkxriZ/VF/t5MnxtUUZOp5QnV6l1RMkkaXbKow88P9pj7c8s5WtdZayfTW4FNXylTGt/avixdtxJk2Ub+wmSoDuK3OrHd8JB+/j3N/f86KakvtsliNsLGNSSvUBjdbgyCTG9lbuWX4knsQOYbnh6ylmy1vddbN3NTtJBamX8TpyZK/xIz8gTTabFZrqkqsieMfM81zzuqKZO6hEidX0TLManIy1Nf2K1LWp2kzyOw1jys9f+Pjn5Jlbem3q/FyEvyFGpmpee9Ux+x263pk7AQLH2RKWQhiTpRUcwPmJ9JZi4thNTFzdCZtF89aqJqUSbmglaPN2lTy3/onXKb2Rk30xLj+ziCoDy00XVaQIr6r4r/VeNP46ciC5Memd4NzPfVbnVb621+z5T9M701O/wAT9mryTi1KmOvN1965Ky8vLIJr5NOpUD+2mkDgn81bZ3Ex9NLaIPMb8N2AMRytZGQxbmqKe6mHVNOwid26OFrxXjnr/TsW5Gln6O4MeN5mxMnW5usuzYfG7oNHhTRv8r5Clx2X9pxlV9uJ4j71iCpIut6ob2tb140fhT34KJg2XJ/UzEhIUtXa5fNSCL5GigfweJKMfS/Ns286bIti0eMRsYxjTa7tJrGhPMseYw1U6lpKWvt2sITTpjw8qqCjDJcupyEVW6cgcEba2dY3TP8AX/5nWx/IjvLK+cZAPXX2b+n16Xtx+eZ+seExv63+WZDFgFoUJGiWllZ3K+P8hzdLTt09eDf5LFR4AdkMFT249tMl8B8XiI/LIWDo4ujzwyGsH65x91rT1TXIu+q53rUo10/kk9nFtPDppJJuoCZimt9NbeUkXXxhLo/I3DJOLJ1X0jKM81KsNW9/vJqoncHilikmpfx+PYryILhnIzRXfW5yU0ib2DkDp0c+ZViqokXAQ3va3LBuPTI8t4Zx9/2HCXhcGFT6nh75WY0EviBObmelS5Nb8yTI/lr45Klq6xzc9hFS6mrNYWZ5eUFfF1yX8ZvnlcwzREVMWxRktmJ1+mh633eRKnc8zWql1+/y4qTjF1VfHCJ9XxNTlvI1ZNXQzVH3NNeZ41yV1IWEIeV7mcZGNIRgY+0XEgZmyF1oK+tT+hGamQbJ68xkarZGlek+wD/vw3sR/wCPil7im2GKTs7vzO8gBBNbWefqNPKvKmYrLl28RRQPRzNmLQQtlN1kV51rp3/67kp2OPE9brFB1aiz1zj/ANZMWsj8U43J0FDKsNK7Xj6nUAljAGyjlbWWQcHVUi2+CYuAPGCgtjJA1Eemi2qsuhS5s45qXSY152zX95I3SagJqNFzD6YyZNfWceGcl1VWn0lhJnuVqR/+JjuSoDrdL4wUD8feafk/77kxfIY2a6iqia5+rMnx7ZtNU/m0wekqppbIurcm6Z3cMls28AvgDEj19h6WV83rddMN2HBfbbKbB1rTS5OLlIsKw7ZZgFZdDJhsrFcbqasgBkx/5LMkD8KgczTU34xmQo+nR+bKPRSWtZByZT52uoJn6dmMs1SXqXmtOTm3clSflvB6QaK7N3f6Tq5xXW5MfUzE0au5H7D1Sc7h2+L0E1XJXVJWbbYXU1srHVJ1Oj6zAIqpUzz+eZ1viAkDZGxP/FhFE/o0p1ogPTAAiytGP2nxrWx6WDrJeJbt5lvgEzpyRUE6aZqukvxz4qtSlWJxzXyS7lrHpxUs34ISqR5AQo1rVagZad5j9HTC5LSpYqWmiuMUk8dZDTjtUD6qC0zWtRlmMMjlBn4+juXJ0N1xkqoqmbBaV54n7aXqTkPXKO4vLDgnjdQEoEasikF52NigIwPae61q/wDx6t8yM9mCvjnosrVN1fyN3/k2VRoYTqMj+hz4WpWsfPOUmiMepy1pMuXJDdLuZ/6+ZJ+0H1a3XuHpfU+04sef1OFnLmwfPjw0zOchx/LGfIHxnp53NaLlcbX9U2HFer/kxiIT0uKZeH/3VTkqhXLZO9LCkNeaisdceeB9M9XqzT8wzhyI7ZiHDzqKqRR+Kx97D/7RhwZzq/m9NO5/oLMZE1BNY8Yq1I0uR0fU563yrvxr83payFE4k5TuYJmcjBXd1K3QecfK7N0TU6J/Dw/yD2/PV4smL1Xp8jco8/NPNcjKT8eWcJV2FSE8zZL2Xrf+sw+mw+iweszeqW/W3T6T0UYazeuz46CRrGyPp4tZMbkK6lqYcjkSLP8AdoqpE3Hpfja36Oc6ikU1tHEWWx3Vlab765C/Sby6l3TZkCz9BTLjV+tIgkc81Tf6DU1bwNlW4x5+TGmkxmlqcmqoDVGuv9VLPADLsPdfV16TLGPFhvIREmestTiDg3kwjj6DLCEULWRdRUM1to4vc/Tesu8ev/HrshBeLr+nMXbOTdZGpouWtDNV8kjXSD1RSCn5yYkg1d0GXwDrOBGbRsEMkieSFgaoZfTzjPL01c0KfJUjrnFWjUzMzt/+ArX0Z1QzOP5sbeKieaC0siszeilq3nk1zZugjaU49PQ1EvqHH8TcM1QrdzNfUogqZiuNPP73pqeZln81/qYeZCJmZqMVVrQWil+PGiVly0FC6ma4dXT1DmGo5jsmRj3Gs1FlsGGh9AdgO8X1prL1Z14bqkTHriedMNSDkDf+mVpVG7n8og1VSz5+RhtDur/U3RVH6f62cJvWpd73uTBTPT573mHqZlh31GzTTpFNA0119t71rjy3WTUJM/3r/dXDHW1W6k/7TrbXJUi9HT0+oP8AGbZ7HwMAOUoOpqwxdRgmL/lJHh6oeoOQrRRLPynxnm217mqOTQVuzUk7OaAPyrFcXNeOrx8RNA3NLLM3VdEfVJsWv9yUyn5sc9BUrjK848aVBw5f3/VvU7RDIg9daAKKqeol+WLlpqZydYiNkbROOdHVOpx0o/V8omugV5Em9RVopYZyXADBtrMidsc4kx/Oy1Uny81IVrbbzvUEJP8AlrVapefAUdS80ea2Sdf6cpaaAOwqOuGhZOU/9fFf6qT9H5aMRU0lH7pgqmbyYmTx/kmdw/U5E63UnhFp5MQ1lapkC6hV1pQJieZeZZaljVE754V/N6aoDnnwyfYn7aRbEPt/F9RrqrMN+O2WmdVUs941nnHbpmfI6Znk1ZOr1+HWDHcxtOpMXxMskKfXm8lbtaEnqZnojlgomivPytasLxzQY3VdY48Jm6txOt99BJPT4TIo2b2dVe6Wg66kDFbub6gyEyMioTNL1ro3P3Ylxs4tEuCbFewBZ164s+2ZsJPi+POjSoNRlMs1RVF5E4KrSzl626J5+0zy0NT1t/F5eZrDnqqKZINoTjq0YpyQnMSTUk0VfMrMv4uqq5DpgSMXUtk3e5ZDRSlb3VbntKmpmdtstmcePHPLlWMbVRwb2V3TSHbcrP1Sv9kvK0bQ4kg8K27jt3GqkyGYBwSbRNxHIH10740H45mxuauqD/Hd8ouWNLMRJyJyTU7Gd/kZIzaasMg3xPF6qYb8DXR9pr+5UGmyl3vYemtufNIdUzu2LqjmuD6yMKtT4mdnJrzX4v1WS6nHE0ltRj6nrEc3PRdM/wCRW+X9hYed9fiBpFLmMQsXtKwP00sewnBhOUhiX51YfjrLaS3VwFNU8Y8tHgaliKxyx48Vk7+37ZCvi2rhN1Z07QmwmJm53e+p28yk+Hw8s/guS8WSfMfeYnqZedtfvI755yct1XmvNf8A3X5ay894/tjBnqgg4QkftWqWqSpqHhsGaftsPUDuSIL5Uxlu8wt9AILtHbKtn7WOqUpDU8eH1AYrrePmjeoq15uX9zRtamzU3+FGWtqLq8zFdY2iN65OZ5mpDaJMmJ55Cmp/G1kMl/FeM+Pp0kEvzVMy9VW9Y3figK2f6qNMnOLfWmV3H1L4L0zXchMziDYb2A3M7fMWRBsU1sQFiwl8MJaYUBGSfyIBOV4GxGmVfe/HJGOpYGcdTWMPvEZFACkip0v9b1QV+Ipx1iNuq6jJLEC7WBnLzRZe9tE/YguP2Tf5meLvRMpkm4n67j5a65rs67aydSBojJI/JyEUTJGPJAoZKp7ncvx13NQRf9YxlNSNE131yUshJLIYQKEjJttNrG0ToaQxjuglA2g/d6zJrKxOtzFE/ap4qIfsaardeZkkQdH1KVJcnXgmtlYseyLiryzslvewMhqevDVCWEzWxnHiy0hguJ3VVka7nqSVkMpOhVad7tJx773QXyfuqiUacauOhnMp/mVTW90NoLroBnkbSwISERKBxwCIMW1Im0u3lIY/UZ1NVeKDvFVVNxMp8lL/AF1j6eVjZZOU2gKDR5R1lmN5MYfIbHTdY/lEC6akmIWni9VA7DryN9RkrcxOi1MdUTVav66y9+Z3uVrKSsxuvAqTucfLuSnHxSY+9oBWa6raTuUQlySBqZAfxt8iOATGcH2UDfTF3PjFvH2xOi2/4JxZJliS7fNVUhKlrIZNk9EzqGTjau0c9NwVr6zkxCMUxab3Tj82zkk0XKb07xpIUOR+NxfZ/wCg3jNCU9ReTI6kqtUWyb1+zhfzPl6vyRjePi243lsJjpa14pqpmgKL6TR1X4GrFhGICThneR40b/zab9219tMjIXicsaJmPjrHaTRUjRfxt8dTSay0+NhXmjYzE8y4622vqN9yN41WsFMTqv8A8iU81X20hKpIyT8X2w42Bpk+ObcXnSHezaGStEPCUDErZuJxTHx2E8BUFM4seR8DN7rauOBnS/stSjRSyZAQN3l04WBkEjfOgGURAQYQvbCvuTY2uIxYxe64iYauO6d5JOGZ1cG8fPKTv7O5lP8AqWe8V47llqGiTbcE5HZNH1QjpvdpFVrr6uOdplceMx1kaaZC08z3jIIrLk0ax0M3ILLtnVEhOSkxt3M/UcVaj+1HIUPRSvW7y+NcvQq/lAoSZzlSIHaPONP3WYIshj/8wIBlzqN1NGp0OsY7pmZlCbpsYqf3V5pB3/12Vqw5JmCaqtMk7jZNNfWG8lJss62hpJBnz5r48k3eZdN4zJ05J6dV8ZziKUv/ACKc0F15KOvK1ySz1NbTmKKhkbvyUlQvD4O170Mb2z0UwGJmCw8BCZtF7SXOi+y7pHgc+3AGs+R3my3MzD/9b4x39AAj7ZPHPit5CWo/Wmitx3XlrZ4cJUyayVQrlpVrmtPdzM8zy6qTwunLNfGhbsuMwzbWGT6nX9e648Rx5/Z/knX43CP32zVPSfIWVxRFAZHXma2RjNC9OkF/GC4XlrNiMybOFxDBsTJ2ahoIhbhi9IQagKvLdVPBM83M5CI5WyWTKy068jJkrWqa8VtVuGMeTvvck3TdrPCfU+Bq5nUNXRuJR38YGTVNcjJbVOrlKzlExzS0MzlbYa3oa/3SmPrq/rYmsmhvLrcFYZnmpPGMnemftk5mnuKJl26uvCBRDDHtEeyxLG2kSDen2tcF7ABwtraKcGPHCT9X43LKO3XxJw5JnmccDL5GNNf61xXjLkvcBz8esVw5d5eYoMlhkjvy0RCO9DjuPBbYx+oIw1tfk7nHqi/8aMhNZHlMJRekl2lnHIgqccVddS2xd33ybrJiWislX/eWdSZJiPrEw+Qr8ZLXpX/cAgjEWzewvobQG0ja2+SSMAC99OuLmprBkTHdEXVMY5xGRXW5mpZok0LzLX/2iiDJ9gx8zzi+xIBkqLCpxt001Tue9daalCg/BqrWZKuzJc6xFPiKWuCseiKGa4xc0fbUFdJ+KSqd87+W8dTqSZCq/wDTkvU/XYAm480bXVIfubbMDLQHudhocoTynIOCmgltZLVrG/Hj/wAkVFV9J6d2DEhtvkIHrV+KJH6tDP4nLlu5oI50w29AZqhflam/3ua/UH2a+MQ62eScjL3zEvLMU/XKixM5KvdLVO4Z1NTM7s+stfHMXv5tuPHJW6ZfuGPU7vdVh/X1Cd7dfZ/GSYCgx3ETmBYoTnTunw1MRTf6RdDhxnycstSkjix9RBIvZMtCU/HkNyaNJP2n6m7UTjxfaepcqlE6qIMszcJWNN4ituq8vmoHzpLRkyRqXHQzvNabaOWSm2+cX2Sb/tqJkP6ZA64wy08kZK/qHzVp/qQ7liootBAk64Gnn8QiXG7tZonbhW7nQCQTCBY3F8Yi4ZxfU/KGpkFQxfXFcjezV1exGZ/9iBQ763M0pVE1k+ezL07xt+JJyVe4sySwkIGhnyyJ3z+L6qcuSpkIH47XFZc1R9vUE97PIjQ+DqDxHLh2gkpcUY6ryLkkaqs2PVrpBu3X/wAMzzX4m8wDHYqT4EGynOlAxJ7lSEr4zaYzp2XFNUVWWhOcsaqSPjaa+AeS0vY6Oinr7DUcCSZPrVBjGciLOrDQ1JkuggipSTVKcbFikctuKN/J1v7zRJkuYPtKJyY+WWWOeZKaJXz+VorrHhpX75JZSS9Q82TYFawygMG0N0CVBKJpYKZElYsrwRwvbQbxxeNpkFfbYkXt4uLNXjv5HJ0GTgOhn/Ey7ucbS3OvK9Too/GXl1mx+BJx8U1F0dTUyZJvzyEzyZtc9b+qiVhMsfbIc/EZNnExdhTFOQK6yJR3+uutLrSB8rM/Jcy9ST3j0r0b/wAlF9xZU1WWivCzVDpr80BISSub3uHHeIDFr6q0ZQXNoxeYI+pmtiyFW638nGSb+QmPvPhlLbx5NdcY5DrbRqd7o8kvGPFOaC6qSrBko52N5INF3RwRLPUjIBRoctbBcXNmXHIxLMXac1eVOqqK/wB1P/sjTUvivwL+WCa5jLOS9S76+KL04v8AJSEEasMbvmVQXYwVGxhjkjB49tgNST9ELuwUHb6bQBop+KryVknquMjNP0xhRCxjmlfknfRpYmVJnoPxrkYYQ5q8eMNHyTV1VVNVk0+SZ/y0zoJSXzR+KrHmyVkqeZ4yVkFr42qgn/EPBsfAkhLqpj9sipyctdRSVd4ZplckbqQJ+wxEpbJXNzOnk/VSaiIUm0FcHywh/rStx72xjz9rBvPlY1E/5Oak25T/ACebbDbR3/64fLVaxsnK/isrdYRNRkmcdJJWrZdZcVG/lcl7DIbC9aVXsfWpkq9MuGCqmHIVWTgK2PVZZVGti6dJvTW6m/PUSzUzmhSG2Ou7qLEo+2w6npl3M8S/k7g7UhA4gwbXgNCRIsE1m+QbMPZzIjhFWmfUYfvHWQImo7JuIFTRTVO+VoaxzWRZuPryOQ2v6kkqmLDVx9inI9FVl60UDu8hOyUp8mTUc5SX7TVVNc1L5MVTruyKqBSIl6g2Ma2yIWGZiQKllx/rImSjei5RZpyFH1iTnzz5pT8YBN4G4ChW3tmxQGlg4Eh9vLPfKXZXqbypJmxsQVijY66RJarumnFU/JJc81zHKfSvw+rpXWueMAgb19ScrVNcgyyV8Y+JGOitC13Fm+LIqcm55fDNajpSjrXhRCbFDj8kpljoi94pDJovqq3R3Tzu126QyJMuu97alqObzBHsT+t9BW74ybP6YQ7p6TbUNMncrdNsS1ihmKecvcjKRUnniB2hQ6nHo1yxP+Iqkqd6H/tkrw5dkzKfvRw7PBAyCVGVmOhrXU4yZ0LOjqWNTqSJ60unTVubrG1WSnmpMTMlE8ZODC8k5PuhWWCSfDKM0rmSrDsbACObeSxjUkgTkzuoC7Y/iAeOOck5nS3B0XLjmcuWtyzkngZ+ng1dXMUEkhsb7koyDW8pEX+iZfrpvwfGaWbxwpkVDfR+D9mga5lYyLB8k5E5IlveSjsP8jomQn7dS1RwzY+eKwdYuOt+Cd0SUW19uQ3IzzQmycyMkKTeBPgrlEE2CiWJJOJaO9vE+UYRC1HhyfJV5J01rnlxNyu8DP0q8dhG6Wu9VwzSaVNzNdASVc8a1Wiq/wAZdGyZnVfWp6maeA3v8sx/jmJ2ZfM1OU33PceC8jwd42PrNHL4JD/dasOOBRnIZb60k1cdv9GzmDWtVO0BckdOpIkIi2WzMQE9j2R0iTe3yzMABXMrz9dMmcSV8k0MZLvr66qpTUX3MhNjTrGaoOf/AGS1+FTIPg1Q3LVOQwzS1B3GtRDP9IN/YqD+z+Diclq5F/xzcYz7PGiOq6yMrNV46Dzt6C9H4rNrDugu8Nsq7esRSbmWqO8X+N8EI7WTvroAKFUnHOLvEEi3GpDIpcmN7hYIgXuBt2PIE1pyz1WvU3/6048l4/kAK39dYjrrdPyeZ4T3mFouvGRi3JzLRf6pZxNccyyuSY+j9vKVLDLjy9Y3xU1VC6mLJgmsY6SptdQRrHYMhNAsTlJVqS0yGM66vjbIDfhcZzQJ9jmiTexcEsZIlj2OzEfpLRLl/XO28gqfwp5iN3dAwHE60HGF+NhA773dsvO/LPW91PnNbqiZrSdNb+KsZkg2dbZoxDX9dEXUuxpPyO8ka1Zl0n35ctRHJUPYRokjXD5Fa+3VINM1jmm5Qcdw2NV/kf8A03+/7HH140Azt7OJMbRfli3sSQC1YZGgnjbH5gzMkSTYRoz4+er6jI5N3LMz9/BWOpk75yU0tcrf2+SeZmgVcjcNuMhrdNOOqiIIrH1XTXYH1WRmQsK+6VZNE0s8lSEsLFh1JkSa3NOqO65Z81T43OOSesc4qkpNVkJJG7Y1XyVoctm8e9M+HH5eX8glhF47nmF9/wA9T6rCLhWJwHdkTwtsiaDFEqx14mXVZOZrVRWW0SHGydbxu5ZeXlfwdaxEwg8mbooZt5SprJL/AFtZJh1uVjoP1mRtFx231RLNQ84xRlm1iZ4oSKNfFW/HDQBj0rKUaqqmreaZIP8ABVql8tMyRyeajU0GgPaMHb8OJnEaUAxG3P4MyyXHpgy7TPNROPFNT3kZkqjbEMBtyM8Aa1jSSQWT/r+Zk2u9TXjhNMjkWpiyyg3ekb/+Vl2/oeyIaN1TUz9pWpa5dd0EmEYopDfijkZ/IHLQfKY7ViS37Y/vqpaodcyjscfnrbvIL+IfLA4vYCFfs9EIIc+IjxA+YKPc+ssrdVvqGQR3i2mMqXiP6zHVW1TpqTbuQHK8sZsXx6ucfc/1yV4imqqigyd2/LLugJrdRXTBr7U6yefi2G6ktbhvJpjgR0TOxNh4H8Hdz5qN/wD2Fqpf/Zv61WS/7eF6tkK/r/rwyEwSQYWx7ON4AcBRosImAO9hEFWs5SMRolyp1OFAJxm2pDXntKlkJ1W8rzpD6mrCcbY08uSaua1ZNVFclQzcpMeOpmaOTZSBWlkZae/L8k9avtKKOPq0usj8juQCWvq6rXSIiarJi099XQ+J/QDiyN/23VMlTMla4nVE6i85XaYLc/Ro2OwxAu4F8KJYAuZYV7aMvHWGfiKLMs03zOzJUHXy66PiJ1/8qC6ZCvw5xxV95clVVZO5udV++AxZZZjjw2Xyu2aLlVr8CAimoHlrQffmFZqTcgMFb1TP0fqS7vdzHLWSZrf2prVyH2LjlL/rI0pIz0fqPvuvzOsCG4wMQJF2QRbbvKBJDcUxIJbOFBRchknvp5JWVE54Fkp57MTv79pd9Jo/1ZGlLPD3JzcUQsMzjaBMUZbXm5kuWQcdfeTbqogU1apnLleyWXcx5vm7kjz1dvdUlHIa7Ei9Ufj7xtYsd7Sj4uaDUs7TWW0boPFU6JqPLujf5zdQlICxhmMIDCzw45YqqILFkWGRcZA8xg3CBJ44ymPAeMo8f5IrXhgIMmSKSwJ/9bH3ip3anl8OR244PPMZGZ5byNeMuuteWZHJfIKBCS/gxNCTqsmKshylICqst6J2aaZJQp7jlq/y5ixVdfXHMSyTdskSQOM3JZS5CbJ+obp5nzXRx1lM7TybdriY41YD9Jm1zF0CHh3vyxl2DD0sg6nJV1TQfXEdfAtIUV+p4mTp+OGciUbCYTHNcuP64cf0WFlWjIQdppAqqHkruTdU/iIlnn5TwsxjueIjPhyCc5LLpGpXrWlJDTU9u0MOSsUkJ3mceObS6qMVzKPyDuhkqcSFFrcoVURPmdbrkEqd92g5xxk74OtIJwqQCMTaAffsttW8GLDpqMGSrq6xXpp/eiSHWOZxSzVRVV9MnlnUcvQ+xekuvdvboPT/ACVPu3ooMVXfLH/kY0iOGhwM/Wn4+J0P+tTrPQ4Vmt6GcPHTNT3UvBkIrJusiPjJrzTZWsh9vUf+O/b/AEXq/f8A02f3D0nufueL249P6nH6D2f0GT1fqvX+s+WX0/p/USmsWFvuvVZ7yA48aTtlY8jr/FCjp9SqfSKT5hU3h3HYjTpANQA2EomRN04CHYhyBq1/zH6as1e+yYcOWfUe9+ozx6rF6msma8ODBrPiuc99/Di1GKJy/wCTpyQ3y3kr5H9dhBKiIZdR1OOply6aapqtCeev2jX/AGBq/qv/AJSv+SZvUZXJ/EvcPa8GT/64MHuHq8VLEXkDG+mLfj5+S4+GQy8xM/rHevmz3G89u69FxjJnGyZCoMvmd8yKVP8AT7Bxs806/M/6d/8AQp9RpqFyBUKvlM/4m4J39XtrD4oU1Gxvb09isfVkgGENUvYMMS+upqCjHCNbx0FVW5i9JvaaZCdy2cnO+hfiJPt4qB5Zmt5L6ZKsLk1tY0FQzfIPO9R7X6rXqKxVgqMmQqNoCWknNJz1jJl1Jj//AChfF7ysZEu/jyGS1MhI8mWtzTlnkOa6NENTtqZdIekKlUMUx2BJG88uEc4CoANIVRiCEg4L/wCTHnuLao5xroAceLHYFc6bmJly2W/5JQ4NECyfQZT8oW3VQcFbw0AY91WWYmazx1UizzWMvRTcscv93a+oh3uT5Ou1qyP2kMZKvFXOuxOdB192WKlNTnN5Xfluc7LUhWKraD/JNAlQXcR4aqnXJSnd0qgJBIniZDOfAE5OkVSify3AOyWJJ2WqeZxZKjy+d/f4zHjy23Cytfa9wk3U73yQkhFKTLTlpR2jhKoqqm6U7vv/AKf3ha/6T5B3u8xLjpwvxVPPyYq4icmKIxl1BW2bpJEWUVlWEqtbmJjJVVr9VAcn9ro5qrn6l6aaZaoJa0qa7OnVEoCxEQ8C/PjbWZMEpCB9hlB9oud9VvUN1QELOO8ePmepKyJUuR006VQyfQmiu5SfqrJGPcZMsXW8ZF14+mS91K2u+dd07kynHez6NWqUS6vpqnG3U7StSlOVJgnZQTyIJJ5Xa6kmX/UmJ6+nW0vmb0UndfsrUaVXTz+dVABBm4BjFkGLQYGxsNIy/lNO9QBAwd/A+86pn0p4ma+YfIh8V5KGdXHP0Yia3Ur0qyEzJAzGOfjnd3E4/wDvcy1r/MoccdFeQrR061vRVXJ05Cio2Uy5N5KdyggTUviidE62KqfgF0YYqchkUnq/HX2AneWWa1DOvvP7qn7zWvzUFFeqakATgINAWJHbBlgazBwtgRzE9/bD1LTDhmZxzVzH3EJ31KWZCknJdtTvnfjxJack/JTJdP0BkfpMuLkdltXVWlvnxXkrVtLEQMib3Mxlaalr6qUU/ryU6iV6JNO0qY65Ka/tXWMWHp6ZMfV1+v8AbF/vnwmzbpPiCAJAxaCTEiy8DWg8gnCiAABxAtgZJ1mVusfSaOj9Ux3ZH22U9zNPMGv2gJsX8VOSsJLMDrkeS6TQJ1ZoTHU21p1Mg6deWLV0i6rHzzO9bjB501aVkLrXKGsiMuqPMw01VjB1jqnsd7p3U4y0nUsXU0OyiidP7CVcIwibYlcgj5tiQb6IYuV9A6c9pO1raPBtXJ/Vxy9dNT3UVP3B+1GkEfE71QkmiykNzkrI/fig8WFN0zDGpkn7eb1Rua3XKfk42eJrA63HFczBQI3Vs0eWmuZr9VbpOednjxdV1WV58ZBSTmJdRjehalEdQc7NRu7n8g1WD5M5IDSugiNsIDQwFvj79kMHG99On08vxbSeYjJp1MVIJOOmj/JViA9c3Og288tuIpm0qOUkyxBMXkqxG5yeax1AaoOb4EKJkc9Oaj7ZKKPPVwlmMiSpL19Zd6gZkd14mppq0YhfFB4rJLWqqYea1OTdQM0HM+A1+iWiMaiw8GVtELZDDlIZ08EsYjOGhMG2SDCBYAsa5NS9E4gmTXxoJd5P6lrKLrfVeStJ+WcGOqqklJMiT2dWhOprq6DiXfLP6rYc/gcmICss5Pky7HxTEVQxTk6/xolHOtHVVONqvy7jj1FE0TOpvHi0UjUyGsrS1VRKaaWTnRkKaE4urVMPCWSdseBcI2egBnZjcIJ8lGFOzzpvp4rzJrqb+NyVjY3nb8ZXJSeJZJ62uoBkJPzaYox4OnH3WS7d3X7G001WOySWhpn7VaVWmeQjBiyVvqcebu/8eRkqoMlPPVfQEd6hOt0WLbZe59PhzeX48eaWp/yJLU3VSC5JZgqK3ueWJpnTuk/PK6/UAltjbKE3O6Ml/bemkQQLWvwjeJ8ORC1HpPSKEUxcjGSLU5+OvBGSqTxX1CeTVKCb+23x4rP3jrJPXGMiangqZmGLqjqXVIp/Tpnl6aMwjqGgrRlkaPMaGsVxP0P6kkz+vOvL1OwxMzcTWMy47ncwbycyszFRVOhmEvmn/Hps7VPzxer1iSeyEnttH1Ce4OtgqQT6WzcMXNOwEfod9WsPp11JUSGIqaWPvR/XqqUM/wDt1M75IGNdPafxj+J+s/k/q3F6U+L03ovRV633b3Jw1/4foPQxR83qc7Vd/NU9RjgS/UZacc6XueGr1nofRPXq/Vbmq5+DDM588xdy8hGpwfrIUFbmuq1pIfpT+E/zX+P+yf8AGHrvbsXp/U+l92/kfuFX6/3L19Tjifa8GHL6f0OYjY5/bvT+oyWYsGWLfU+snkn45I/PH+Kq6/TFPopNRrqopHqC9IqIZIeAI+mNbdOmmuqagPSAVKKtwjwdxYx89/yn1+P0+evQ/wAZ9DnzRGLJir3T1pkc/qYi2Izx6Sd44MkzNYYiM/Z9atxxVFX+D+j9Q+94s/8AI/cfR+n9tyJjufVV8mT09ZMmCJs9OY8NYpxlkfJUX8VfbGOW8Q1f5B/MvaPas1YPavQ+p9b63fx+o949ynLj9Wl4yPi9L6bHU4/TYS4oirsy0msnWpxPm7/JsnqPUVVelhkyXkyXJV5a2jcuW7i7fs/5JCmkD/INfnrf+3PU+HFApNBro/GR87I/FxNmBHbXL1OvRR1abVFggB+kSG+28nc69l/5b9yw4vfv5b6j0efE+kx+kw+3+1xMXMY8TmrBjy+jjo49LeDGsVNWE5Ms0s0D80X6jQQKdby91ZthnmJqY6Fe/s/breupSWfTPWem97/k+Cr9s9F631rMaz5iu8BMRbiw58mRceO5m6eLyLXHg7hY0PoP4n670uW/W+64IvH6Kt/+LivFmrLnxHyfBlqScc4Ai3J0m53ss/Wnw/Tp+Hp6fSNVPqpVP4gyQBJE3+7tOsviPV1aqahSRSZJwjfj5T8pKB1sPYf496vPi9N7l6+MPpPQRHVPqAM/qZKxZKvLOdK/8ajXeXJI3BEY8eazn82Hun8l9B6f12f1GH1P/wBMvW58MenxeojGOD0UTR8c+k+0MuHFJHyxV9ayU1wapfuPunonFGf3mz3n1/wW4facdZcPs3teNqXFFYsT36n1kASzb8Z4nrJEvHFe4+7Xmp4wemwYnGzOD02LDOPCv6meJx/HUFaB7uJr6KUn5vSD1KxV1AU0EhSIBJYZKN4psI0VV09OgUUmflZk3FOw/TwtI919wfWpebPktmrzSxtwmzxE3kyK35+2SHdb2arS6Op9cyZYvJji8hYKhjnjxYS5Kn6v/tqmJnRs2p0ns/tWf3L1OCeZ+fJj36eM/JjwYW5mvW57nQhdPxwTfz5NMxlXX4/3vL7d7ZmPbPQ6919zxSz6v1NRXx4/USMOHETdY6cOTVdTrDFE7yUTjv8ANKqwCemJqCMYAIuAyKW8B4WsagSPUalIlmTFuzcBLtrTYPcfc/Ts46zfPDXZ8t1adcTUlk9Tl5P0Vzztk3sdx6X3n0ubJeHND6avkWKmFx9NckXWSTZNNWD+xf1aV+c783uNpGSRqdZnGRHNj+5iZ+SpmlJZWcfk7RvIVXz+ohhc/p5iEemI07RXsoZm5ld7v5QJKlJVmqmiqlFWBCY+YqInF8jWfqKB9TMYPFlP2O9td5knr9HWlCrNMVS80ZJ2EmmhnYStzJayar1MY4uavdNClbmZ+XJIF1eL/WupD70EdBTr8b7R6yfWYHFbd+o9LP1qqZcnp9Jjtmkqvjq+KGQrxvSrdv1GDS+Sfo2ynTvQE9WRM7RZkJ+3USBSznSRSRSy4DkbZbf8g60E2d5JKvalvxPK1z+WHmh5KDfVchfx1+leqqrP3coVpDdm2hmjFix9/GFVZkoNP1opZbmpmZhKohOjSn18Rs/UzqCBku+Yu9n/ANk35y5EeV1UUBvTo1z5pZI04ofG54aftO9BN1kfC5Osm6I68NRo6XsorRW+XNgI5ymIgRpVSS7uJg2GVMuViDrXZEtYNfrShxNxJoin7di+OTU1IR1vl/Fs1j8zxTSshzk+Pra7s45mU87h/vsVdflvJIVM45JTmeySIH66lV6W/PXP1snlZ/3SzYty1zl8yowpRGmXHP1KCqdQwcj4Pv8ArppqKvtMHYQRmx7lW1mtxMfkddDJEr/hyeY1jtdwzXER25INFUoVAeZIkKhr8zHbPbM+fkI3qz46eWRUkqIoQ+qtP9euwyMuTiaq4+wQeW7CiUtsr5DkPv8AQ5OKZ6pfxTYAkjTrH18af5GtmSqXSb8VQdLNAIO/vwRCMIQhIQAGD5sI16wgAYj2iNy947as83B+pyF2Tjyf/BQfGuafEkH+uGpmjU/f8B9RNf4srWLmiclMgVlEmjI2i7breQN8TwgzKxLkmWXeWKSepuuNUSFvM8CA9ySSaH6svUVju2YieGki60BUnPVLzdNVTGqdfJyRO/AFRKc7q3ZbpiWvyZIwI38i1hbNs2swcWTRuY1jLQn4pySSyB9VyTkmpp1xOQ6n9EUxcxiBiye8kpLq5wleccXYOMia2k/H0faj+3heZYesd6GZnJERSTOtNNG66qYMeR30NIzWJCjxO5oPIrRNENxjJ3KT0EVjoJiDclNSEl6lCfSEkBxG0MvYv76JiFZ/QRc+SpOdRUZcW/j3mPlmx21x0HCVP1Xw7ghjfFP1UYnJ8cvym3LtkoGoyV9SKyiTHOr3NP1BuDfhY/tZzWVsy7UinGvmN63+tJjxnxu7kd08ry3qsMVonYoY/o5A1DTR9d/bqzwBoLfqhPeef/Gbvwz20jhR9DhxD8iBvqSslVkrJHNM1ix6jeR5J0bt3dZKCpskutB/Y+0VXxcfVe5n5dSrNNqZt0mNqtXY8nhQ/R1BNXHFTY46XgvVUT1VoV5QHkfAIzZ4MqyauMeO7iUTFL9N/f8AsWqvNrNUt68nbspCQXbgu20FW2CIlPguOF/JjnZRqMmTFXKYpqZsichuSqa3PTuioRRdi2DrU6RMd5M2TK5C3i24p7uNVqZx6DWgnyLBVUVoybI3iuuftpyG8nCa61RFL9eT/twPOwl0vL/iZHJhWyb2zFa4x89XrU/fGIadMDufO6/HNeY4UWFuJmfuSMRk3ZzMjcL6ZOookcfTOT5Yn5FpOcl1/ZygGP6QxrnqGV/XNMObLVXvEMdxjp1kam0kfUapJ/c5JbfAdTzNTQnTlrTZBNen/wC00mFHyl0zWz7Nzq8hVb/U9CM1uHiwL6ObUNlNLF1k618lSK0r9tUjFG7ESYHIDSCCHnmBstO0nvv+tvohZabktxOLJJqpJiipKKle/najUw0lLXhkodMvLFZX5XJD/wCyObqt0S0lsVELEalfM+JPPmcnJkZMU4pDbkdNuTHusdah6yeWZxxv+v2R6qtHgHJiBNX4AsooDilaj6yO/NJj3onsQ0v4mnkEsjYhQZOLxa0WbIkQWGt/bbgRtosebHkibHXUmJipkv5FPt8dg7XesjRda51oLQq67qcfNOPHRmyJWOmpuXrHdUd5DfLbLoK2aPwoPlhmdYkoMmOQx1fGPxxjorXX1N0y+XGkSzaJXx86J6+OcXZjTluq3V5F+xU73UxdeFSga/IbAMek5MGoxg/fsYWhk/xccYjnnRG4Rx1qqPkrHvD9Ys1WOUl+yaqdn2adB5/J6q0xxPGp1d08xXx5N1xjvsq7081oSupCddoXNjzNVYJfO0/x63cNoJkNIRIA7J8b0trNyEkxRU4HI0mynwrZVfZE+SZenUk73X5TStjIhpLEgSSWDtpO+x9rxKyRvZb6s+qtrH0/QnmbJxVrrTM2TK86XxTqp5qWeWX8rpFE/JF47x3GFoOYqmX5O6yfbVCbvmmpdUFEZKy7tSmIzYyoi5ZQq11OUrb512OV2TXlmvO2NseSROtYq5n6F11KEXzoqXRuqqdGPqfqUZLNo23B7Bg4vm2qPjDRHZA2+pWc6bzEzzGAa+XLMcKRdXKHyUA11s5sKKAn49zsTgLO6Y2zk4KRKjWjH9lW8cEf/g02+A3R+A1M7jZllyRcZTRrvYTloZnnGlFkw/FvZ4qn8bicgGoCoWNkrkbLaMi0+fIBXGu3GMtS1+IGRgAHEdrRO5IBU50sshbReVZIOr3vZan49bWpzlNWO1rFivG89ZI8xzrxjYJ3qvAtDaXHEVJI6jHNE96K+5mvKfWbNX1T/p6eifC8c6yeooutMqrT0SxL8cBvFbFO/wBsDSUjkOBnqPpU7kpCmG28Zf0pGuorHy7Xkja0dG09QQsBIZNkgng/aBpgt9nOXC38W305wyq5FjWRSnJGQZWepapNlUjxK9H1lnI9MTWMp3aAXilqUXq+ZCsuyY8/R+viblJo204+TNTNrWqqudsxLikbwTvy9U+YjhdPWq1+Wao5qss/IZE1fL3irLMVGO7tRmSa2lVX06h2ULBciAMkPaYIVz9TGUbsJx+XzJAYhg203I8EO5VmCiJaDJTuc10Idxr71IVJvRrc/i8o7xecW/8ACdM1kx3F8reW/wBxtAua+vCOQLAnH1FdyxIgmJuymTOVXORt+tUO+sr4K1uK8aE2VV7a+Sbr7MvMCAcGTkqMp/jNAHWvtVg8JASPYXHmALBQcJ3kH73gHgHdACw75kjGS2wrW800Mqc6rQzPJjFo1vs0pu/P4wu+TqMdjMhRzkZx9Exk38k1TjZR3Gl1Mz200uTNPjJMWpMGTH9lm5ll+Tc4ipZ7AkqhlkjJK/i1wLE1NUDGNyMAOXrQXdmmKCu6mZA0SHNbbieMXsNifVEYDiNB4ygncDgOYavq3kZ+P/xxjebmZR2WVHm6seZPuleGa/rHL5KuJxQHMaY1gNbkK/18l15Wsm4akF41U9Sv4Ukzk3tUwscSNMU0oY6OZx9EvxuyiSk/brCaqlrg7fm2EtMO1x0hf2NBMvklqqopgqCSC8rgxHtfARugLrIlGJhiA7Phr76c6w45qdUc41AnJSdG6LD68Qk7rZEUeErX4PWOrts81OOi0jvFd7DHQ7JN2+Jm6mzU0vhhgOcmM40zksykzOSFg+FxGupkJ0UjzXIDr8JqLonepx1rH0TjKS36V0/IzXSA+Oxnfifx3KIskJ/Z7CC0sssGf9fSzI/mdZnz8MHx7ZZj6lzkqpQKyTN7Ze/OTzWzrJP0ooYu/mrLlmuUY+nT+08R1UdTUxXn7PfWnQSznx5chiucklSTkqbXmoXVTupfmEmU+2tb863YbRybmWZx1jkMfW7mdLOq7jxZrvzJTvZ+SOYARAhTsVOV3V1pJnZFjfxsVzP4cvQNJOSX+xfwtkVjJr4+QyU/Vx66FJ21buR7fxBix4zHw8jGPKnVUVUyUxVzT9rMc8bOtDzR4fyf8mSuamcXxV23vkzXig6mmxu29hs1NzAIZAr8bKbeo8Us7304qzE1G8m+Jg+2pmVkdyC+RuX6bI+1wsymoFhOnc+/gYXYAXI5tocVtdVw49bvGXlPkp+q6nIS1hQ8SaejmjwhITky5jQMYq314+9TjlYm+yoEDZ9jfIm5r8LP/Q6orxj6JmshcSLTkyDXPhgaU1KddBx+JGYC5d1a7kQMZk555yhEnLNvxu2EpCfD+OQnLvB2GL2neFEnSlAfT+bwdTEbirxcStGSVovJGMmaMYa0NbNYqmR6m6uSgVF0dfVqayc1Wq+0tH2ZSCeHqJoNRew2zZRY8xizvNU1+u8l8xjy1Qzipn60TUa4Gxpr+oEhOKrP7SW7yqyT8mK99T9h6qt6CdRxX/d0/ikgISIIs17RbEZNtJ27gTH2F/bNtFGSstcxDjmIs8rFZg11jkpr+nVFJW6I8s7PwqiMWT5axp3IlfHWQM7XRM7mRHkkyHVz/kKWhlr5ry48tEq41hokqEKyc94xsOHl3/aVXZperU5jJG+YqCeeKErRPc3y2OLRSFC6f+u/xMmDNThrjYjIFipO+jNrYW8/fY4ZOpHDnxzkoZuWTIamrmzquPi+3WOij6qUupd1JX5VqrqX60JljG0dHyX9hrLNFZON8nRSfVU8b/D/AMwj1NxVFOvE4ryP17yYwJcfnv8AsHTWnyrbEcXNQZa+OW45nrdLWRy1uSlkgUn5J5ZFnn8D2Dc7tA+y2Mew0EsYO5tgcmFDggYzpVfHhorFjJpvVadcdUcNXD4x9TSY2VDz1UP5lHyWuxL4vsY5x46p7xuSfMg0aJnylPToAJcD1uLIrMfsmYcjUJF2rNRvoLn7HL9Sp/JgVvmqNZLogyaKxnDkCSTxvgCPrWqQx21tgljIbTKFRVvJWUMZ0gWbQLxZIA2ie+OdRkrMLrFujIz0TU11xLOWhX5A5qnJUzCfuWcai5meZ6tNnyipdEzZrDa7+PnTtI1B1RQs7bNf5Fr+7GTTReqxhEyY4u+lECTR0nj9auJyzhorJupyR/sWpu6dSVLM/HaNM9NEd6lp0hNj4Dw0o+2To5sABDhwRsPyOsyuS9VPVPyRE/G8xkmne9z2G0nRoxMApt5FMBb6jJPOxx1ulG3J1NzPUVMqczXVXHKhY0Uz7AjRk65Js1TGOp5hqxCZnVeGOgrryvjGty/WZ4kx/wC28liP28L0+PjvnqkTkqRqU8KWjg75T3Z5OdSQCXYsPBLFPnjPtpc2Y4yNaS0JftTMqVA5DnmcdR95CieronSbE73Tejdzji4EkeQ+ZSyqqv22S/VOdqkt/wAldVrcuNtPFk6XXBqCbKZ2yV9+VTzH5XnHl83f2lxrIlU44UImNMs0E0XUy+fJp7/M2N+xY2l4xax21JFhAtbBjd8TIjvo8t19UitFYseXn5JL5a/683czSP8AmERa8czYgU5pTmsUdkzFaqXKY2NJbthdEpA1WhStq+XLeSa4JomYcn/ZRlaMlUFVe0xtSFoTqN9fizGyXi+NGMl7fP3Jxv1pdVcqPnQWfR5vd/jzuDstxHaT4bOBJv8AT7ZwLQghlPUWY9m4asIu6UmXgjePpa+Rta2wSZNMeOd/g2FE1MFk8HOPcwRuedstJcoTrRH3jrwgxdzE6a5cta8y9YzJIHWSjUxG2ZOaDzRIcH4pOp2urkO+rZ7IWa53vv5Hjew6e+pdD+J4xChRCV2tl9NIoBDwL3UxJQgg7bWbLM4lefNZo3z9hsN9aBnHo2U7Se2Z1T+LW+7fprHPMlFbrjl+cKqftVeCtKu9nhfyW7EqebjuYZ+NJqvBFcT+/qJ1vUU6O46/JyRdOM/RzKHRM8zSXi6ArJXSTUX/AGRnWvyS4E4XJ72sYvbGkLArElPZmPG5kaWSr9fH+RzDlplZnZkxXCMVOnqcYi7d8l6XVfcb15k+NgWZWX/2T0VQSHJSTwqUJraN1Rsw2V1ONk2fJdDPW2nJP2ZnVaBn71/TbGs0hMkzdSRVqhDVc7qrSXuT7ZKlXxJIbfxAytxjOCFe3aTeWZJLagqRKadhwtxxle7irm1a+SeHnyT+sdORCbgZfPLuquif9MaiRclFN0WWcsxORCIyZJAmPNkEyWcq/uiWXScUE9cziNzqZun/ANhlT7f1HqunsTTrzXxSUPnTORXtHIkJPGqOPj8mq1JVFwE9KyY4OLEdu+3aRqUYIIsALSG3mQZkydvmFVzHfyZTFUtM4/hNQcmTZPSZK4qftPFHNNP7685By1zG2J8Bh5mGD5aXVlb5nT3NZNFdFBPUqq8jupejMQZCSe1ZNZuqG8VniarX1iTJKmqG7rz1hIqaI1pZb+33fkD672iW0wcf2hungE8N5ZRA5umb230zazIQA3/CJVnZkoRcaPHkuryyxukywIP1g52FUs1NI8Ojq9ClDsWZko6ce6MsZKkGprXONtKharetSY6joK2h+D0wc3xT/SMgFTmLjUt31B9SeqGTkA5bFGSyzX2nU0I0Pyzy46qMfTIzGnnRx4+vNFP5LK3YEWje94KRQtpAkgAhSyTCSGxXEoWgaLnI27ub2/OwsfHyO6xO5hq630kgNbRF1+HV/VrmQ1ON3Lw1VKZWGtkePF0NfuZlDarWSsbkb+vbWm4H40+4hq410ax+JFRYKifyYraVMzvkx41jXdzUzvIZL6K2zW6CrRK1TulYEdhJjsNthP6lqVf9IiRGwkcJzLjtefknqn5Ol8uPS/E1rVGidRMko1JX7/Dn45l0byVSr9Ime4CZuorTj6KCQ78HnnTCUzHPxt0dSVp8xshCcg8B0c6mdT0aNV+NxxeLGDwNsXLqqYL1z9tecceNcyldag06JJAM4LeCYCAd/f8ALWcEgsEN/MQAUgQATBRaJuA4Ojw5C+f02E4SWa32ilNUeJK/+yPns5op0Vagkb5OpTd7MYTkZirJsdTXgA0Slb/TyVInmfJjq6qbhmYrqsh9PlyE/GTCUeDYU3NrO5sk8vyRNPTJlxjzj5a2xMYwT46nW7hmJpEJ8GVR3x7i18ntabKzplfKKiSRU2xbJ+ZJsFysLVqIc2V3FOsnitUwY8PJ8eTJld1vR9jRkr68mpt2OOZclB9KnFStUUOPQkSZPs35JnckLjCdUSlbEtueqj+kcFVKMTFYx1NWOTtUmnhDUtH22/HkujfyB8tzBYbucAMy3RMxA1JWQ01Rp1/QePqVGBBJAL9pjHFhxjcBAmzxdq6gZ3N5vGrngn5OZcfwywEKXqgx/wBKf8n67da207/02/T+l7jEdTNyfPNlGrpMjWGncrLyDMBr7S2VzX4rB6ZaXoK25Yqno+LbU4WiWK7ZGYxh1PQ+eCN3igiZyI1jsdV9KIjI7NVvUzFTVV0IbCVU35nxHVIJRLp9KYdvTdxY/dTrQCxDxMB+GRIN0PJIQY4D5Op/dmKRGK7uknXyO+MaarIy5JaQCse/zYzhxswXgctkY6qqslP7908SyBE3bGpoZK1rb+PmOp4xuPHTPwVlI5grv9uSpYZrVVkyG6FkkHtnde3ezet909Vg9B7b6f8A8jPeH468tksWF+qynkjFIVXzXrSMzEzFteL1+sB6qqj6QD6iQVgSSd/vqqdgGzaCQlcBHE7WLJ1VmNTi5Z5DHM0G5vHW6nHkrG1Q8cGQ3yQfadya+o/+DPV4Pbf47/K/X1kgu/dPQenXJDOXF6TH6X1aXiqssVc4XNdxGOa3k+JoKIZ859p/g/tfteP5v5Dlx+vrBMfJ6PFm/wDDxczPV1rc3l24uMOTcfLV3kmSOWQ/kf8AMfZcPp59B7Z6H03t/p/Tpin4v/HxQuOcsGHINZi8uQ5m3c2xU4qY25Hwviz/APrCj/2/SpqNNVVJq6ihAg5bsMWng60AdI+o1Q7WBAtKv9OdI/5S97n333DPPt0eq9fhj1Oaaqv8NXZNmgvJV7qdpWHiMmWqLGeX8+Zvdfl9PkX1Hps2CaZZnIf4v29y3jn7b1YaQJDetFPW+7++4qyWRkl+W1qpxzvA3FHPZkYPiOWdVDFVWQ/tLXMZ/d8OSeGlJYLnUTGTjrp+zfVV0DUs7re/Hl9z4L4c/DdKjpikemkAM3KzeJIhEtPXL1q6eoQSUWrscX58s61HoT5fdPTKJM/JM+Koqpw1S2F9VjyePKBo3oSaOry/X6zzTkqXcSf/AGSnJC2nPc1JrZ15HkN71PoM3tce4Hq8dfEzOSAYDG3k1LcypZMlc9RV1CfV0R+brPxc18dfUtyLVO6kkUvGbeKmoKd8rVAzLNfmzArCCBUEbkBLvkAfrHTA9MFuoQDeww532y3qjmx4mHcs9zsVhqqtNY7lQ3FgSal0vOnh/NLknTROOmfkuegTg51Q0zXcRC804w2Vr7dSbrIRXyTH1su75ycxWpEqJhOqFqQm2aqhmuXn81Xqo4vH9tNz8eW5moPuTU/LW/PSZJuQaMZ9TVFPZ0ari8BEMEmFsPIstLqIA7AKI2+qnFo2FHbUWc/GzfxVSo1WieqbfsLFTeTlUoxk7LTXVHizBWtZRrFk40O5a+Aq5Bh1M0QEtnZzk6/NoF6FJpcfw/0NTsGaKqp3evrFH36JOtvnX+qxnM0DNFSVRRIt7d57ir1k6SUk+2PZUMskd/TwMYO1iI5/eyeFQCG0MmCSovdAtqxdtUumznGp5jHkdP2usnmlS45fsVkrTKal5NpXxiv6y/bSuiPiy3xqCo8OMYSfqu9TvzpZbWLFqoxVGatRkiZv45yyItbjHzCUTKFAdzuvP5VSqP8ATc5EX/7JWvtZu/Nn2BRJQ0m5We6h0kszBIsoFshThTpKYINuxCG7aPe17aTeOP8A6qC2i8dDiW53HOLraVR1LwQBrmtfVQ1jnaqZPkeK2PXLE/GFzP7p+qyC1oOiQyjF8jU4mt/Jj31Qw+KOAMMcTy6pa19jVEE/imFCh6qkzFLVbjoPjtRqqmpBAWvPSPKbUhgEgTeEduLbhb8aAzPCzckeYzjAQGjxY2smTFcN/atdOuQJkxlUksWvMAT1Wj63sc84+jWn5XGFn6a50fJqZfA/XW9KfXJafkm/q8XpqYEmirFaayb7txuvjP8A1hEaqXkfzEi0xs1i1kmW/sQ5PBprJpdvX+QjfGpRqS3RhZCyXaO2TN+Bpux7cu1lbMC+2il7eanXOKoGmdZGfD1dHWSXzzsktkxvkqllm8YDE/bDHUwcUMofY3o3R8iHDLz5oSRC/wCxIEhgEndV++abpXnxyVpp0BJxW2YorbPNXiFsKJfjZDZPlxvIeZPrqppfkN/knIvdlKytaxnaZydIvYKzIjHgYah21OQ1/wCPNE6eSiQMbUk8xdK76mqGpNJBrSK2viliVp+sxpqz9dSVjaQo2uudA6J0UbqpvNZBVTLj1qaZ1Mj9jTjN3RQMupr/ANbo3q1MZb5mzE1bOUylSwSzT8VrPnyOiZ+y11pZTIk7XtiwAWYCJvKmdBqzf0zSoODEHYHBXsH4Ks6nQ5JyfBN10JPIR03uagqa6dFaJlJRfw8ZcVkaje8jjx20tBPHNd7mHFjkqhkoK066EkfTTUuUk+Sqp8Bup2FQuRZ74BDnzNX4lKH8ezcBkjIF3xF34DVVVO0PiEAh3N/6+Ja6HnrLA3sZIC5X8+xoCxBgwpQtkAgqcgkBTY3MFVN5IWq/zsxLuqLWWK7CZcYzSfTkKaiNN7u4YxQ9Tj6pupry0zltmtPPEmOXa/8AZCqJ0gVfSc92XO+u9DHdSfRcvbUrO18u6nf0273vcEzB8tEWXQYQmbDolx5bYmZnIXHnw2HVTN7nXm/EVFCqNgIFNxtkNBX+g1oDbEks8tSA0xkeMza9P6Yyuugmq+S66jXO5pxDyaUr6mM35JnVo10PpvTxXMsp4cm1j7QJU4/MTW3nc/X7H1n7A1rsGCsrD8j8ePFGeYKn48lgPGRaimskzMsyE/2BpfPT+h9PWTHNc1twV8fVjlaq0dDU3jZdck0vKutk78L4nq3nLYgCwB/nbW9Iq9QF7K82leGrAC7ta9LhvNkjBgw1kz5Nemx4yayZM+fLYYzDjL7rNkpCLI6dccdyv52X/I/sp/DvTen/AIb7ez6v+Q+o9Lj9X/KfdMWO/k9Jm9Qaj+O+juYSMXpLkPVIbzepm/uemx44nb/8Y+gz+q/n38aMMY82bD7ni9Q+ncN5O79DhyeqMuw6ujJjljI6afOWfDR697r/ABv2b1/q/ffV+vn+S+v95ay5PcsPsXs57nfosGfPOXLm909x9aRgj1eCsvx16aecczimXLNYqxPz9fxg6XxXTprZopp9ZFNLdRKAN4pnHnXV0+mKukTZlOfwoWz2OAODrwH+F/8AHHuHrfQet9x/8TJkwe2e1ZPcfXeovFlvDglWtsRd5v8AzGEcd1MSQFd8xE/nd/yj2z2z1OX1np/T5/8A6z/jX8y/489m9RjyYrMWH2H1Ht/qMLlrK38v/j5fdfk66ySRebCXPdSPnXvHtvu38Sze5e8fw/8AkXu14Z9T8XrsPqPk9u9Zj9JFzkrD7x7RkOfU+g2Tjy58a4d9YzmPoas/l3qXL6r1mRj0OD3b0tez+9e3kzkj0+R9XXu/tnr8dD/k9J6P3Spv01lGaPTxWGK8Yb/Nq+l8R8T1D1aKwaKUaaQgaSaqSQQTLFJAKzsdTTV0qaf7VQRydxSAL3FucK714/8AzS4v+V+/TOlPdPWuzwOvU5Mc4uLprZr6iS3/AF2amndf8d/wf/78/e59Nnzf+N7Z6PCes939VEXWWMHyThn0vplKH3D1uep9L6SK3JVU1uMWV/Nd/Nq/873XN7xEPPueU9TlBWP/AC8gnq8bWItl+aKailDGfJN1UK+s/wDHnueb2P8A4m/lnq/RZT/6be+fyb272D0mOBfU4aPQ38WbHkDuLxR6z1WPA64n1OWMsG8dZI9Xq9Xq9P4akD5eof7fSBqtTVURSSWhAJqznE68/pdMVfEH1B00lykQPwsFMGMnaxOu1/kPvXs3ts4/4j/Dfa493z+h9OVk9N7bkzz6L0OTEVxHqfU7j/z/AFuKrn/zPVOMm88uMsxxUvmXrX3eMebN7h/GMJGPDzlfbfVRlz4sltNZL9PvLV5cJ21zZzUsrjvmq7T1Ve0fw/2v/wCkWT1+D0ObERn/AJD7nj9KZfdfV+pyzE5fa/b8eV3lfTb38mTiYklcpkuseXlMnuHsPuOL1eT+N+t9w/8AKxYrK9L7pEeky+onBjpy+ti/SZseGs5T95ucuaKyfDkqpsr85qaaR6TQKqwPxdSoVOowySwKR6hARIbN9dvUqqqKNQBhUAhUiIIuRA82Q15V/IseHJgxe5ejMnxzcYsmNIw3OaMdJOSJ0zmjLRPZLGZYQGt/nnf1vNxkuzF2d0NdE9AhV+NJ5lgvdfYdn53f8hzOf03qMhjYpy4oy6Kn5rx1bnujWQ7l82lkWfY+tDHB1DUz9Jb6iZQKbnT4yL1QCrXUySCWtT3Xo0yBSfEsD5gLEA25e22vM6qNQgEGTY5WFgb/AH16h7d796D2b0HqM/o7kz+ljJHousfp81ep9fcVEZ8gVRj9P6HA9YMKExkmb2nh5r2/0Y+lrNizY8nunvfqMuHFV6TB6NarLnyV4orLk6ba6hiKt1OtcpPp82Ki6gyzks5sS5mL8DFEmuUqqEZh5t56rfSei9fkxY2cY/8AlZIx+kxNRswYbQKjIJqstlS0NFS1SgtUGghmkslQc2MsfRY0esH0iQKbCcgC+CRdArvrbe4V6T2TDg9L6PB/5Xrcow0Qt5+ej5smUyK4cl/qJI6xQ39YkTnqyeu2fJk9CdpkMLJkO99ThdvIysvLLMqE2NOth756pwe4vx5cebLi9tw4+iOq+S47U2k/LXZ1lfC1OSprHck8Tfqs/wAtZWqKbqEepkVp40VzAbdC9SeSfJopBQmRLO5IL+nvHOprJBGEUATI/I79+VrpMeXL/wCRFYYn02ebx4qqK+Cck6oyQtzUZOtuu6nrziYqoKre36msgXmiMXdY5CcgxmOQ35XKT6gpccozQMnkH84nH60ydT6iGqiyqySHyEHJ5vIPyY/11t61+0uevyzkz5fUOKZzVOOKi4ltUhoB5CtZSSJJ3pCQ11QWaGBURmCQGAVBJFpKniVopqIlD2HF0IvYxbtrqMk4tUM1vqpnHbDU+Fha6SJNNTuXXNAjufyheMnnmonqB8svjuUdoJkGueNTNJoZLeX+nznqMd4+z5fS2N2TXeXFMkzdNDWRGWcs6JR5a6JUPUEkm/I3jJOgl82/dJHHIb2Bo0rpTqQUURIXizc9hH56ZLgFVRBs8+3+p1ps15sfTqn/ACcNUZFnpEsNSQAPk6jsUikoqr6hmondOJxSruXv/HKf/Vq0LuaK+3O75Qs2F/NkyV4TzOP9/faeLpyP2jxUn1lQf3W9U808PH1mp33df1WSv211V9fqmQK5Z1PI/nSKhHP6DyYyIs7vU1X/AJx3+/0RO0n/AGGskVJ4NX8LUg3jyyxP0Bp5IQppN/uNpTKaqUwnWN/vNDNb+2/O6MhK0yl63uo84Z6P8neupr7mO8gDXW5x7nlXmB31Uw71Y5Mv0OPrEuOKCV7mVampLrig8VXiuSvJAh+iMSbKEXaDKQjd9hr0xA5Qyj9CF3JiwAgausjBkkmg4xVq6dK992SfGWJ5l+ktQv03P4GMxYzts1VfJGmKYinUYqf3jZrVamCZ1rZ0H4qFveEHHzTetk9TAHxG1KnbqCgK/rXkFVLkvqQazRbPS82xi53EzRt6vToJa89kXjVfqG2y2+ouORNuNUw9uDHqsgTfNr77ateoynzxk61Twf8AbmVyFT3RRCZJOmzxVvQcKfmZIanbjpkYSf6z8a9dCN5AGdlKzyH9dB+K56rSVEJOZKoV4dGL/ei5J4kJQl8y2IzHnjlCeamTBFaYnam5pa2ovOOeSnjhgr47QTCQMhuylZn+b6Id1ZCwQPL4CUrbRW38vp6o/wARLGqWp7Pjx92tC43VcCCUNSLL+Rkq0hJNHGJKKsldpk8VWonVyZPHI1vYP4LmSGuQT/A18daK6KnI1Tv9+avfXZQSsv4PySdFao+XNiMmt7p09ZFCQiqa6J6Cpvhej8Rqg7Qe0C+4H5N6KkSRyl7dihfD31MLWGfkNc5SbWWqyWz9u53WQNum0/ocoMVTHyFuoYExSvP1Cjjzj7EyWblNB8dNT1+Mx3qp/UoE75Y7qcgjBTU1dfWikduzmnwqiSPkJfI3T9dVOO64e65soAAnSNVQoOxMlbKd7AABK/AkaQJgPE//AIVPPEYvOjgpuypcsUZMwWO5AOcuNWJL8UEPMlCjv7/jPmZ14Qhn0/QXFFxXjIm7IgmZ/wAqtB0sz5/FAC985djOHILqij6zd1RU5Sv1fIyP6a5pHVtb+EK18PT3VGT91kovgOPEmVNnQMFFT+MRwRffAutoBOdtDOLHJmInfyUBZpasOdyRxMcZPr6erjrl2JSjXXitFUxo8Gut3+VeuHk0f0lg89WUVDV6+Pt1u1koQRCgcBMrVNNVpvrxkDwrWTEtTzIYkeq29aCuvwiNvjBWm9vdeItmUki4ZIkf2aXoxia1+BqJyXawi3cAg6HwoACI+m1wW9u2jxXb6hyAFd1JNdf1m5vmRTumima+rVCMbLlkqrcsMVZ8pE3zxc00cmxdYWat3B9N+NUUIYfOEdV4yyUmyrpg67aemBl6udP/AE1sdst5ZaJ38ZjK88fcKnNWUf8A8p60KSXyNOlaah9IJj+ZxqsCNjsrYtafEaLbWVqsbWNlx1OvjHN/6y+slKtzQTl5dV+v1QgLOPT9zYfrqlIKgpo+jhTzuQidalNn5k5qN7xheNcM3+t0M6err/6rrWXS1Ukstm0PtN5cmW5ZyVcxLCxjp4ZT6yQ633UyjH3HpuBuABl+LbnJmM7PRf8AOCL7GF2nnRk5s3yTcbZyX15JqmZnrFP127mqY4iFP7f5Pt+TzkXcRMLinG3t/ZRHdmSa5g/q5Dy1PMjJT+Y+ooCJk0wYxg01lqqIOy1+2/Nmq/r+pU/BuslczkqZr4TcniXTW5kpC8z/AF7ooSa4Sg2wgATPNjjKAjjiUzpg27X9rFcfS06KrDJcjFVGCNI1j+2t0xW9ZL75qq1tabpmSJV8zfE48kS5EuaXptGLer5STH5asnQb15N/iyb038lG95Zrfkh/vhLud148TjIQLdCmvxkmTDRlxndcX3O6Ql2zWKXiJIQLN8iHippn8G4UEgYt2njsgLaJxaAbbzJt3sJdxo66bK6wvOCtwyzH1/pWKV5cmmrl2UbqfIrMt49SOJ5jXpyifjmr2s3Z9r+NJ5a3AVPnQCjGO3GlZSv/ALNP+Q5Y8nx1aFBUEfSTRVVOzf5DbH2rb1bUdTTWFV+N+SuVmGaU/wBfbUr+ULSL2ssYsCrBm0IaLWt/MeY9kNTufTRMxVA2Gg+Rrc+Z7nUmLqdEUbnbUyu+RhHPlZJveOmnZ/jK43jiUiMgVuJ8V+nflY/JOS1Auubo+vj5prwmTcz1jKdMnhCQaJPwMmNvin5KyBFxUAk10pJ/2YyUiM0tarXl2QbADCi1hTnfsGC++lI2UFfWbj6e2rlTi0S1GvjGuOZmwEZpN13cv35BTekr6gQSYZj5fice8kVX7qGSTG9aKSgnjmZ28yzVdtaIvHINbyN48hZ9nSIFZtaImg19DfT48n5Y+KXW/FEmTvudabX4x52z/UmZ68bBH4+bpIqXEHiadtojv20wThh/QLgcT+kansxSUBsTHBxNNUjc5vrTzRoul08tUTcyyJr4iiuULmKMhRLjrJKE3cAfG7qgGtaT/wC5Bw84n99OSiRsu5wbZcYZn/WO5poI/wClVJ99fliopGKPJd5ZynKc41ScibGF8zwGp2Jjqav8AGMMWGQiH7digheCw1zZcYH7JGZOg1ixeniIzUPWP7Fm2qk89lJwIcnx9O2TbfjJ7+zcTvow9TDyiTqqaVVZa+aJaf8AcbimorHXxIINJllnJjrb0TGBa/Rfg40k3XH03P4Jf/jmOGIrZjeqKfjzuia+bcjHM7SRJDXLo22bEIelKJdhZuLiWDvp7bf68A4+8FlzNY9zszyZOypC7xz2SW0sY45djDHA6qZ5KPyA03WBUp6yCyzcJLWK/jHV75Qa0FJNBUicUXd9XTsy1ulx+AlInILFiy8SSDJfOqd/g1hwy1fx/GZURLiZLyTUuNJ5DFuT9xuTxpDkQGwfmQYsXZWHq3BOl2FzYJ4JIANpYF4406HBdWdH13bsxyNTM/4WXpK8nUaJo5Ah1+TdUm5g8VE74Zms37+dqqXkJDqh/f3nRKpnHvLbjeflxU2GkP3qYr42Wk55FqiChXZ+KyZbmQorLPiYum5TqYmYyPQpOrdx3/uhr7H43CqCm3tkX37nvpP69jtm51bnIyXNaqqyMQ11uOnqa+T6yY+y9MyhXmY2J+JrGVmvKXKM/dvTW6obZ1zOoNaqKrl3O3ugly0TbcC1fM5EMlaX/Fk72DjmoeUgyAPJdHVBm7ME25JN8BWvrk7nf+SpfNeByGiefFf/AG0SPaUrHb3v7cEl7wD2EKQiNvsdLMnOCHQ7txl1NfJN8xqrWhmJCmaXoxpYXJdfmQQ5H/Jzt+btTVVNc1hqq+tpXQESmz4/FIkT/aSfuZG64qSsc9ARWPSefkaMRX266J3up/IupaifDIViHjgnPZM9fLvyUQy1yaRyc/LPX4og3kKwH+OBtwy78mMc9o4+mV51Ym5oqpQ/rjyK3AXdd3fx108njdUDPkqAPyMivp6+pMk4sbMw80FELMmiXZROV1yliT46r1WWcZM1MOStXllnTOSRKy5NO6qseuODU1Qa10OjLUEamTIRy2Ddzx5cls0rXySm0prcNwTNKerEiLQpCE7fUZegmPoIEi36ZzcaVVYu8fMAax4pzEuMcv8AfzKVj0q/I1uoZNTXI/jNZfsFthkr6VcsXimTrGZedtGiOB0M+A+RQiZx4949a0ZLlol5biqZ18ZObH/Wa0vLMuzYIvKL9SgFwtQMV25PF5JKpBPq5Cp6F6Kk+02ANV+AOP5vZidImx2+si8Eza35anKxkqH4i/jyEFcpJM+D675Ymp/yWMb8Hlgfw2bf+iQZgFH48j5eODpcbLM7645ZPHLX5nGqigCzEbmcRX1nzVz+yuvr5fF1tTR+YTkx+nxuPMivaLdTWKlWcmvEoSKB4LWlHQqQSbDB5ghA4+vbUgyfFl9+25kGEQtBOTpQJj/DkH/W8k10mLHVheSKdzVMJXhg8V+NMeWzm8wzROXkZjeOTXxxczNd6OiY5xlVSUuWtC4cMumTUQZJ4mJmyaXVd9NOWfrSeLEDzzQorNhxLGOc6c3wW7x46uSQyLPJPFlTzMO+k1NbuQGRARg9lCJJCCvIzlgb2vG4mwHG5035JbyTXxt9Xi0Y05t5JyXP7DbR1z3M/SpUaZs2P66iUtyDLmYr/KE3NVeSzQ39B3UsiD+Joz1l7+Xm9f5JujdzFlVMSSyylLj20gBvmth1kisegjFojE8RSV1O95KnJTKdSZWvsiFTr7ILZYmQuwLMe4sEyNNX7EIWOPw7Ls/poayRn2YskX8cnZJw0RJHKc9ozcTVOh0T4GK/IeBqtsSZDX08lDPENVLJONUMmhEqOCoOo+M6GTSA1PnHNY+67kNfYPHM7oZ/xg4+OWpjmWr4P8NEyze8tNPNQNE/J4Ga6requZWXpXMgAw2SkORu4LeCmtS/EByoYv4N29xjU4imsmMn5DJ3UXOXuSLqSK/XE/ZZOZKL0zMU5BXltWhTQ8jO+mo+3dmqoP31vnzG2Tw/mYs2OhpyUr045rjJyMFcROJ1FFo5H9RvYM1NMQ9Vly1knkqsfx1pSpcZ8hG4rxOuX7VT+9Oj8T+UbuJkRNmuN+NKw2N9thbD3N5sDoUrJEXePJOSSZSa1UsyWWH2yMvhqrZGQnWgr8Tv47aRjKMxFShFh4LOW3Hu4PknRGh3p1tkZM31mdKV8UtFzUozEtFXMOOkeJ8nTMkzugjjVuSSm8uJrIft2Vt5YqQ1fDHSWc+OpXUEAgfWF3q4N9hqC4IxBggCwbW36YGoTVM/WzLuoux5hp1jKyU1NRLHMBPO78M2czDxMFXWiceilhKor6auk3kVPAcsnMvT5Cy8cRWV7/phcpCOL5dM77ZhkZooBW/tI0y0V48JO8nPJU8bO1nepIqKniEX9OpZXRUP4h9PsCN7/VK1oBAFgYZ2atm3JBwZ1mTOEzjYmLhnHRxqFn/7LTZ5P308/po14FwWMcVTFP1oyc9osyzdZIdzzUaXn5eT+ux4X1U5JrwjrCS90dXfWKoyU6lTfk6P2xuGj8bTinQY5cjxvs2GU/8ATVZSwk6aYOWpJWdwhQZZdwuEEMA3UZOmwgaZ5iO9/GHFmBESzGNH5NM1FxvtKRau9guMnxPgJWd0S7GrNvcmPLuZDwRfWmc+PI1VTFULSDMmtJOkyTLZkx5J84qaMjorIQEmNfrsrexjF5Osf/s+zHxoPNcH/u81/wBdecRVSw7kKJmQ5Wx6AmTUUu0/wxF+X31nYe32EmZ8fWdLcd9bit1VGStM/wDZC4VN3O2Tn7dn/caCRN2klRMQeK/65ainc7uVt4KNiTo+M0yIeUmsZJ9pI2E1+koAmGWt/WYuZd0/ToXr8S5Mg3BNcxkmJ9R/2YcbE1U3TqNyl5p3QqEqB+QSgLyVE82xZE/Uaz/zN/w2ICqKBATiY4wraZ8zmgcMMkuOaPM8yS7cWN7IJp57rRKGN/Xka+RDq58mI8b5RdWZWRrxqfkHkqdlnXNSy6+GYdmtxAxNav78wrLzXUj0/t/b+kmaKMju8W6xF8r1FGymSUiVf1IvQj9mXSwWmgQmGP8AtHIsz97LVUkMGySRSMDyEICg/iC0OUHTdj/jihGOb4XiN01dXTyKnWTk0TYcphy1VSeJkUkWmqCN1rMGyH+vMih8eprqk/j623kljcZIoZrJEdOoZ8clbK4gV0Br5JkXi+1VK1jyTSvyZOepxxzeNqmrWj6VLwVHhNxVUQ6bgEHh2RsSHaAOGNFUkduDsmAiCTB9x6hp2KcYs1k66/ybK7qIZZkZNTDKbtB/c3B0soy/O5pmgqPs7+jbAS9TvprrxWL6uzWQGjvOJ31jrW95iO+dYuvti2Y5LOv1H9f7DrYA2tfWWcZeWSqBgyDPi681QV++VmU+p1sSfVlJJi7MLA3wOESXqYgbFxDaNlILRvFxGnM4+pqCWvF5CMkzj+Kq3To1VTPIBXR9Zxm8boHJLkxoAUUU73Jm5nrR+7rqTHsrkZHU7OmN5XStCQ6oTGXjJnUl0rV0vOzXcl+Wt7MyZMe2TxdS/YqvjchOq7KJ1NFH1f8Aa87dfkuODwJLAInjBcQwtJ4wcnjEHIx3DBBIKcWNil1JNfJzVeeZmaYqajfxKyBrYzW+f7fmJTE/Fbdwlk1lihxNB8SWNStSCSfVvgZVuonJHWHEvmi/1qZRJZrJdDubv6qGqJB+wayoamrjqdUUfbSD97iKxya+MO5OiNVZXi+ZgqrBJ43VMFXE/ltpgIcmGpP4TgGNwRwNzYLonXRRdAtDc48ijL2TOOfimftqaid9RJ51Z5lyy0vXx/2ZkHJbI/YeZMvXxzHO/wB/p1yjGZNxJyKTp5WWe5BW2Z+WkWb15d/qmhs285FEql5FmTTkojnqjTGj6p+k8f1oMa/p/r7bo3V9XSgGRCpTuCgO1hGzOrMVliI6x87STNudpRoqrqq5E/VpKlY+YaLS16bHjK64prosrcUM/wD2M3oeG0ogmy9hPmT8od/0x46C7CapWvjrY93dnH2osKMduh1903tvRYl6kssn/Njqq88hR8bT4rmtDEDL5ZZE/OPqXqU3f0+yiHzq59IFQDJRRiwt4mzw7nW19PExVRTNlX1jrdpM3jfj3njWsQ6/0EP2nSdG7wY/ti5o3eOYq9TddXXO7Q5ICNM1CnHgJa51Hp6yuSUHLDlIp8yTN0aJeZIWsdSjLBU/pr5PzpsXODJianv6zYXJUxbc6yeOZmJRSd9kHU6Wj88H4kkk4IKvEkCRE9v01oHbbEkRaxi36CdbP0kbZqgmI3hprHdHyKhm1tNirefwmreaT894/j3tPq/Yv4D6j+Tej9Hl9V7p73m9T6H01VivFfpfbvQ46Plm/HjLnm3JPy1FmBy3juPT5MdeLehQH5JDlcV1WK0vLdjGfRopkVcwhGjU9b5+1fXe4+j/AIv/AMWfxI9Xix5qfaMV4/T58ESY/UZ8fqvVAemMsVlq79QZC/t8NZJouvlqL+Y/qXVrp/sdOin1nqdUOhXppRI2Rj/Qjfo0j5iSaQAAH3Eo5MgMdhr5B9V7Z/P/AHb1G7f/AA28U3Rnq9xV18g9ZSuc2WlTvN1YtHMHBo7/AOKffctZPUe8e9YcGKPVBeS8yWbDvhvGjPkPni+XPZHI3uvQPff+SfU+oM2H0zPo8cNV8cXEReXHN9dyZKqcdXkZjHHPejFrH/avKPef+Q/WXhMGC+oUmokz2RqcdfJ20nzTM1Dm56mOr+9N1+dnSo+NrppFNHT6FKD9IlIBOzzi21s6qegCaupVUScCol2xYoAyh9tcZ777B6D0vr8/p/S+qyGOHIT8/O6O6jWNUmu6Bnmgk7jHU6lebfa8vIYsk5ZMzBclS8zr671UpyGqdY//AJdboP3H3T1PrPUXky3TkprIfafA+fi1E78zRbAcUNT4NpUn3P1EETME4wicjyyXry9YymT635r6115rpU/PYp9QoHqq9RpCNRBuAGRFvO6nXH/0jUQiL94AUJRfjh62XpPb80+swdT95yzDT4x1PZopBOaDzkWevjTQyP50Xu2b4vdfRhK45DFknHVYov5G5J5XXxk7YZOZ5Yo4ipebn3lPivJhg+OCjcH3qNpS9l8m0mz/AK8tdMD+Wo9X6r3f1OHPeJnFg4u7saRmgaMtxXmd9YxpJPrRT0Vn1AWOpUkL5LghND9raqn0r5SQbot4Vwmef01s/VTqTU2jZRMOzJNNTZ1jlX6iNWcckFf7/NVdayc5NYqd4JGLZtOWLnPcUO2kauU2Wdbefzd56rH/AJK+PLV3MjXf06rcfJUOPiTm+5eqa1bucgOpzoQ1kJv5KQyTAs3kkIyFyzwD8njXyblphs/NfhyeaibFShz2NhswjpVCkDJC8x6RswUonWsrNjccfJ4rvTTLMuRs6crRt+TvQzHnnzI45pr5Zx+dnJdTlK6jX9pJxf1/S0MAI7AXY/lnMfWB0A42cuIjht6S6XqtO6nJQPjTz9QmhnnW9On5DVzfyUYr+0beaDGVOq8pw/rnz+ep04AyQRNthvAjjfthCcHKWSB9iFgOHnSpWpyUJ+rK27etQpji1lnHSk1oZK5oF3+Vst6mdvG5h1I7qqvZWRmmopkmr2DpWl+w2FDEhQWs4vPeI2mhul31TIM6LdM7gRatW48gmIyR1HjJJb30VN463OuGbBqZiFCZoL/PQoqQBKxK7Rvi97A4bKQBIUEcArgxhqUtDV3kqep2RczITRPdTJORKvaWhvZ/o8b6XF1/lycz8cMxjp2OU1SyVykb7epVdUVW9fh8FFH9QtqqbmWw03i3tQG3xP78wa2KinuQ8TUv0Gl7MflNVLT2JqdBUnkOT83FRgNnER2UwHvgobm3HNrQhvsyAANFjODnKY3RxOUlybhJ1P3qF2GSoZPI6TfW8KHF40XiywUoRe7ebpK6bKamTxPniL1zCsjHV2tPUldQpoHRrGTltlh2fX6jepquqdnk8xbI0ST3wEORmgrdK9lTQdj965FdFfhg3MP3SvE7TIbyABzgWe5RG7dngkntEHX0qHJXeougaDgmZyU0QzWnmx0p9UdFTIW1PH2nLVO+IP2d7mlql3o8c3rWpZ/IxRkmanHrMdFQXulxvM9Y3comtag5V35qk/JmIu6q2wGrTqr7yFz5CtJh5Ar40655N0b/ABeqPZvJ+Xj2+u2kzUT/AMYz6lYB8+4bFnpimTrayQhJ/UuyiXoVqvkKJA0ZGU2PmthilrG/7ohio7SuZZazBk2ISvN/V5WaJ+tNOcXWPZvWzJO7NaGRx0u6PrUnBvTIdeRLOOVn9P1mo85KOpmpaL3zeqjxKyygY7D9fkmpM8M33FsxEAG3M0KScQiyQUEQv+UFCdi73HFlnrTF1RmOrruuqDdAAd4+pZpWE0zQRMy7UyTkwzaTzJ8bj2jF8deOGuWTRFpvm68vivzX4idOsQW5OWaxyYoKVPLQmIuVrsarmIDiTnYziuWgzg2uSplx6rF+6nRjY68PxSN6Hc35qfzj6lUQNnwlJ8b8HVU2NJIKvwCQ8yInJJCvp3p/imsnJ1QLkvXx7XnvGLPNk01RzP7Lu9aA33o305EtaBkObmSnIaD41dalsmXRztJNIuswsYznHMT4Y+mNCafq3RbynM/atU/XgniUN56XDi5xjjCkx65IIp6H72FB034+Py6J11LrxviqwiAZF9+SHt57SdbUgqkUgRf6G3ZXQGLka6H0WHHkplqpTI7pogmNm8RdaUW3giJm+qFjIl11fpsHyTGOPLlJjFGNtyZsjRGGVDoytVvhgX6mzZLz3pMEXchctoZJhySzOP8A/AiSUigfGJLup2B1Pr/8b9Hk9o9pwfzP1s5D2/H/ACT2P+P+lvLFuPDkvLPr/evX+nzWHd+2+14IwGUSsWb3LDnSXDG/mfi+vSJJQ9SFmaiAIDyZEWsN+iij11IIAI4agWYEwFZHvqz/AAT+R+i/iX8kPcvW3i9J6n0ftvufp/TeqyY8tf8Ag+536TNivI8XGbNmxTmuGUjrZFXiRfzb/wAv/wCWv5f/ABq/avb/AOOek9H7Z7V7v6c92wY/cC/ePX+s9Pl1hr3b3z0/uGXN6D0U+6Z8N+oxTm9PTPpXHOM+KqwX6T7j/wAHfxn+Ne8Zv5n7x7zPqP4HfrPXev4JyZvX+t9L8Hz+m9LNaz+l9N/9MKqJ9L6jFfqb9fgvJHpcdxjvJj+OP+Tv5n7j/I/5H7r7pn9SZL9V8ETh9OTGH27230uOcHoPafSVirHzj9H6bHhwM4tQ2N0No1wfCUfC/wBQ+Jp6vT6f9ymnpj+7X1KavTTW3TQKakDUHUaiAfSFfG/WNXQ6YBJDXpRHqIQRJxZ9iXtrp/c/d8v8iuvURk9D6P3b1OseR9ousftnqcuYZ9Qev9HFRj9JkzJx/wCR6aZwoThyzWLnrgD2j1V5vUeifT58Wf02e7nruvi+NZrD9p3eC9HxIOPe8dcWHfpn/Cn/AB/6j+dev9P6z1mG/T+w4Z49R6nHkcvqvUZIrE1i9DOTsrJHybzXJvGH9llT7E9T/wAVezenuKw+x4/Tvpf/AKzm8tzXr82PBisc3rMWT600ELjmibyzOMmLwTzt8R/V/gv6b1D8N+KpTSEqDEEod4iRAWs+n0K+vQKz+GA7MFeQ7MxsFOvgE/ivuTizRnw69PfqKyYYyw8Yby4ndCmNwVLqiWTdQrJUv50P8Z9Pk9n9N7b7bl//AFP0nvVfyn3BXCz6r1XpPSEe34GHGHZm+T5YupbLqY4Zov6k9/8A4zj9FOfHjjDmMuaaw5JnHVaYlw25cdmMyAfXH+2aKfFMz4P797cekz5mcuoyZU1o6icvmoysVxVzEyzjvc6oqFhZnfo/1EfGIACln1UhCClfcNMML21VXw3oJqE1DdFBBydgF214J/IP/P8AcfdPVes9ViyOXP6vIXMuQmS8t28MyKfJVGTqqk55p1DJ6v8A8M/x72r3H+ZYfbffTHXp/fvbvfvZ/T5Z9MZ8WP1uf2rIehoiNZMfqD1M48WPPR9brGTjrrg5n3TJGGpYnF3FuJbw3EOXvqctNofJjnxVnnp4Z/t+Uf47/Ksv8c979J7pJs9H6qct/LkvWUjLizZPhmXGxlmY3iy4GETeNbMhm7usK+t8P1On0waTVQRTKRQUC0ibYWuGlUdcVV1P5wSwoMBoF7sekP21x3vvtXvPsvrvcfbcddZ/Q+szYMvo7jq8j6enC5Y9PlGpdB1i/QZNUuGx/NL6PB7z67Lk9P6b2KvW5pyf/Y/bcpZWw4GQmWd9lOUjCdJ0RbPpf8099fevdM3vWHLj9Xk9ZVLlx4zHkPmvJkKy/Hez1XKTm138pxRtak4d/kHv8Y83psfrfV4cTk7lnJcNZdMtWxEXUrsXUHPU1SjM7dH+5/Zo+X5/TSC3dAP0iLyLREay6goHUg1egkEHcNgAPc7qIzpXqPYvSe2+l/8AL/kGWvTZcsZMeP2v0dRm9c3Kvyes1eXH6PDVlVMzqw5/oa3zp6v2/wCp6X2+cZK4pyZM19CXMlavmcmvqXRJjNoao3SfXZ3Nkm/W52swTY5jHRYdsyhrJRdp5ppybO3utGjzeovJZOPZJXx1zNTVqs7WSq58TqdTrnyEn50UUVAOoktNICQGgM7GX3jWVdQY9NIACXLAbk3a+2tl6i59V7l6j1HyRUxU8mWAlImJZjGpNx1o5KZN5ClamZu4cHtxjv1HrLD09ZH7nxmfaAGMZExydVuRytzrH+jrnrrNgsx5J5WTnjx0rOwsQvYZVqd7nepak3F53PWLvXxxZjMX3YPANO157Cd5P+szz514foEIkC0P6PE97IA3gG7vyvsf9xxrc+q9H7dlnJm9tz9OHHfXo/UQY/VUCbzYkCMlSO0p39GtI+dCdOjHl5bYddRjrmtLH01OmtwRSeHX7sZ3vpj085IMWOTMDnbGJoyT54isdxsEiTHWqY8KRcLX9y9unHZ6vCJiy5AzFtR/43qalqtPVUYrUqTn/ZtmpH8KAiaXkbsWyBxAsDoJCJSkDtAVr2I/PVv2zLmxeq9POTGhnm/S7i2zu/IZE53RkHUZLanHe9b2fnQ+osmef60/4qahkLpo+S6l15TYz9+FeZNH5y+HB62qwW5cNzh4ya+WZQlNx0z3V3LEl9fplLegOkm5yxTJ8dytU7hHIA6+zkWh2SPLUSzaslVn1AAQRMX9j/L6oEGlC6BeYSCAHiTrW58W9CksxF9aP8iupKoapciyLsLN7ZdP5RzxuV4aCAoiT7GkJ+yqr4LD77J2LVOw9RLLlemqr7SPTzjmeomdM7DjeXkmX9L1Un5S9RuYx01VASGtuzhTS/8Aaanf34xnjqEFdOnWGDVJYDvHyvEcwRhiNTZiZHgNFb+0jsnYrKYzVGrGZ2RSNiM5GqHl1sMmujinRztTPyY8tZtdxei4+yJkd7k+sToCdmph1R9Wpp03JnwSzsgFqoGfl8fFku0FOuycgK1LOrYdny115Ml/JVz9RsxzW9jYY/8A2hIEv3paAevz9IEvICSXuZLvZfbXpifpDsTcOSjmMp30IV51EySWeSISlGskxXXfMfWeaCk53zM0Ln5DaRUgzjU7x20qfNb8m/8ArwOtmjfnG7Ll64jJT+suHu/rUaGvTXq2VDljHIeX7f2ExyTi25TTU3IVjq66HTS6FPtrv+0zLsWWUdLdkEXMeyDFs2aGmVb32wbwh+ZjbWT8eFpDzXjW/MVTMxM1PBOPqHwFW6UE5lyy0rIgw59TULMVfPjtnp6FZcrpNHQk0gVugnoNQZCp+yoyQdu/8nk2ybpeTVB+WonH+27hs+VPkeNwcTgophSaFoB6e5LjpfwDkML/AE99hzBHdT+HHOEpvkJ28l6XJkIFjH9YfBuq2TNdVR0OQ6+1ZJmZmodX/pRw25ay5OqlKnkZx5K0kuliJZ8GRn5dzbDxW12KZnJkrFOniriWpl56NhEhFY5ZeYVrdJk1KH4spmvru5a8fTSVbrGd7mdFTuetyn/rNvP41SgSWpMradif4LHRcDYEWOSRsALZG+snFNef1TvKV8la+J/+xNU7TwBMclSs7miUjLc4Zl3poiVJ3Mg+MtZOuTv7dVvtOqmfPjN5Jr/2gaba6lZNj8MvH0JDdxvX9pOaoSceTEYq63VUspcdZC5gDmqX/HP23vmz7UHcm0M4yH4hYc+e+i3BvsBb9N7jYyUZm87qfrzJx5k63MOSCbdc90QTKvkRfH4rIpd196XLz1PfWOKR76aNwk1KnkSqd81+FU1zi8FdXiVJ8VNvT1anVuj9fsdE0nKc5e8lf0QghKx1siWIvLi3pa03zVOglXnzsJQkhuX4/XJK404mkIruGwv9e2x0ZGIy482PWL5HWTHVbxJQVipYrT9zRt6ASNy7/EJDWT/7VttV+k+pWElqutbrxj4m9VOxPLsc5HBd6mucg9VGrScZVnxhojxzGzma8hwVP4qGvi/yVGS826lJm8h0ITVBPiGTrYo03tZNyXeBL2iApSfZc6mGLwjs++wyBbZFaP5Ma7SZ+xj1UOJc1b1lKR1L0+aDV78DBX4cXvfLJ9fjaTkvJ40Sox1S7L5ErwTNa2LTlWaQgxmTRonJkk1NZaLpyNyjU7nuNS1Dr8ndSnL31EE0yzU9czNHTG9TP6ayV+2VWiWDbbgRC9spj96Fhtj3BWTx4A7zfFwbwTfMnU0M7Y199m/7Cl5a0FbU3jOavyXiFGa+apxwPyXOHGs1D3WpgipqGZmirG6mvrA75ZOfoVXLiUwtOSkpl6p+y6W7NUMrIq7TW3jabvGY+o554qDiREnHvJ43OsuV8/V0IeMqx/jiQ3jTCE9gVbbdRN2gREDWbxOSpqLT/wAj65KgmW608XVGmNU39I8+Tcp+HX0b8jZn1DXWor+07y6Bxy71E9aneol3+DjvIk7hxksNXMn2rR3lyxl26ZsNzvpmR/RsrfBrqZgmd/SfkzY7CdY7Koqv/wATlu9DP9VcW5BfmQvu9VTHgOJYe9wUPLQwNTfYyZJ7mqhxZsbjon+nBldSTrV1uCbd9JQNfjr7ftUNMTUG3zzJrruuZ+zFf5idUApryqxOTKCTxWOpnK7Jbn7FLN9dTuplnUUqygI/jclV9H6xMs4w5slqfBVrTuP7zWw8Csv7/LEufEy9/sSrl7abcGQLBIKLxLRtO/K/Hb8uVdZD4uCa8SyfHfBGXH0peV043S1KVr8O2lr9SbG3aGa8XXbWOmlmzogNDyn12jl+Lm5qa+X65O5riMlEhkm/BJ9Xfir5Fvr60lksgKrk+vxbYV8BM5Pk3vf9t2/bUKdP6TUs/cx7Rw/11J42+uB20v5Jz1zMg1utM1BdoFYya6WUuSg50ExaTE1+QOKcLjaJylRRGqdbDkctGvji5r5BmWTvrmiVOFybidRkgVdOObIDdFC22+Dl5b1R+nbFRWHd4ibvLl2pB1P6+O7qWIkONEVr7aamujQinizwoCGfrwdAnc4gxheSLGThwNTRix/WMbTeSabNfR8ccs3JUf2ucVT19dq+JRYZNqZZyZZrCzWuJa1M9aOeUKccQ62c+XX4GGLvr7JMV0luxJR4/rczcqb4dfolKdJ5sl3URFbmaPpM3MXU7iuMeqUo0GmdfYf0v4gQW44H++8kHN40I+piygH77Ic+y0C3jmSYrzQOSpQMvyVU599TjZ2dOSpA8kQkos6cNSzFpQGSg8mRtW9lE1rlWf2Y9lbmdUv5KuIyzFmuMFzbdVGQZXqZfrM/Xiq5pTyDPm1jo6lUjWOU6jzuEqamivNqGQVaVrez8oEbkWAiQMrH1JUHWiGShggAC0McsnCw1qMmLHk13iMhzjsaqNSNH/xscVF7+MC9f9po5gdV3U88zjx1/fJX+Q6EcJlnl5mwmzxMry/VXMOsu2ncxLbVKXfPL8ZDNvxm0pjRr6+L3X4eXqI3OT/2ZJmLFq8eLJj4mby65mdz945aJ2QSar8okSUVxn3AksKd0RmPp2IlLxvmVjUTucrLPyF5KJaKx0VZPFTledG5Yo54EWQZO4y0/LnCzvpuvElEQysFXsrVcaNBuq2SACcmXJjyYpyE5PrHxXN7PtomKqsgl7+Rm6Ov+2u/IvJGXJfdXWq5y0hoiROhZjwxMn070PXS9BM+s43AkWtl5jLTto9QMDy8XQt7jftq1jyaUJM5TRtRY+SY1XW9Roo+jPA6rpSj8nLkk1BU49CRJMizKzjhJ7gtrf1qZNFLUlyoWT1GSaktxlVM1xjvHI/4/otKk7mLZTVhWkkBccOSvh1Ntzsgb/yE1Ex9oXFfP/eXQoupD8HtbnsACwGL7xaEtI9sifayxfgGDc6ZjDiRax5pqZKvkLo0/wBrNr0mtkTcBNM1LarN8cXMY2xLL7UCv1Mw11ox27ZSJjT+1B/JPvjX9czzQvN9HiqvrpyTLT5560cslQqnj5p+SZpy4v8AFkxuT7ujfU7mq2cgLoDUWMSX+J29MpIjNpD7XVr80CUCMIjGw75CLCxbSUxO+sWV/wA52jXUHlcY1MxWOVp3JNCfXyOrFq5SxiiuCRgkxXaalyFfWoZpoWpPtzsvf5N5OLw8kEjjxV3H1csWc0zV6e9LWRCprRpZqfwqy4apnJLr5F6/+L6jrH/kUrGU+GTYy6kQ2ohEXHmwTPIsQh31Li0n/SFgEQVuiBFsbnCkrO7Sp7D+y6nrKaiWbKqK+88iT9gn8bIfJ8sZtdx8mXtxfHn+0rOp53UzP1ENeWXmmfxPPdBcuSPlkPFVWP76iseS9FxIZNSGunZJQfh5DneTfySP9pNnx5NsvUWmL7H+gl83r7blAkOGrQYH1HBi2gX58RaM7hqNRdmSHpnU0cmmOuSppY00NfWZvYlTqjYP5lzirDiq8gVLFTc8XOpxx9Ll+1V9pH9teAo5n8nFkmFcmPnJ1GAqZ/sBP1+S6l6pOnIb6NGu5IoDFzi/vKOb/GrKMJUhSj8crO8k/Gyo0aqg/Fc7gtsi/kDuj720k8jc74XNxMsDtpmMx3NdzU/HVsVX/wAz4MD01SearcwanqAm53+FkWMczgkmViMmqPhxYbqUlZkek732dTNSz0NQJl9RFVo7fm0XRQxSHK23KyaQdUfr63TYTPS1q6nVtS7Zp45dFVrHb+uQng1fnr6/lU4H/wCKysL5Z43kPQLjOx3gWLjFnJjg6rLUnM0TNTGNldR48m3a4xfA8knPRufxH3ipiddGHbWPR4QpN9hWRNosaZ1oeQZvpoqcn35+RWYl1sfjKgoQkK1+w+Sn/XEGH5PkaqSflPNtVck7XUUbrEjrnG7+qDrwhJOS93iHC3XHmTQMGwvdfdTe4mTAto8dFfJHXxm3ItfSFmJKxfbpW2+dSaoWBMnKqrHimnjBRFZSbTXU9SyzjKnjgVWqCuiRAA/JjpUqN7yk1XPx2cyQljU7xUd7fHf2L+xQnAZKShmqtaqhCkT/ABbreSmn9IFXMMv3x9fidSm35Z+zzZPUmoK02sZ3+hheNZk1U8VuIxzvd0BkrCvOOex/xu5k44KZ14yeQ6byRHO3xjIqBXf2MbkvukmaZmxNk/Huupo/EoWSarHqseM1KSp+3LVKuLXJ1zzU40s3jFsJM2UbpsbcfRMBXOgcabkvxim56chZJ9+QANza/e1tgiFB0gRkXzclLu2NsHadIv084qyVi5n5Pkbx91xEaf8A174OxiT/AGo78ikBGRsnl5xhP6PORjVd3H2q4qasd1uqPJWvyavLUtU1r+jWqHTITsZrUFKNTppo3ut/i4kkk8sa1zvK/HDrz8js1L1J9UBVnpfxfLhgcNmzRzuxxjUfhIv+/wDkvtY/QM7mLqt1DXTkmvoY8hE60Sm7XZ0hzZIf9uvzOIQfi1u4ydwONx071OqWXFsGfMo8sp4KjJ59TxIxPA7p1jM3clY5d3uK5ICdQ8pVblHOF6J39b2DVSsJNXMdG2D9aPO9y+PIXJhpeLR4j7aukirKMGcIkCDJk8vHB0SkRkmo5uIhjU95ZrlWHfzlFeE85KPrj6ndhEUy/WllYaNH1mNb5+4zdVvsEq70863+HdeEl5AjH9RieprmP1NfudjUsnQG970G8YY8XXV1ja/bATqUatZpbs5pkO/MqNOwkDxjOPtmNSapu4A/EUYkgRLuJX+JAGoMDWIxOddcZGlj5IhAZ6vSkcyXHJ1ewoaATEEdTk9Qn+SqHW8nxDyb+b7MNOpmJaEo0VQfk5cj9eqdH+FZjjH8n132qLKbK0coCwkiT6iKZxbqas+LQ42orZXO6Dq7VNeQufO/0fmRR5NNy4lG7C7Z1iTuAFBLm4IJMbYLLAOpdGOa8XzLBxSVNeaO7FTJGjpo1pFejX5EZELxRy5DJ/vXcY2SWDp8kdEcEPKrI9TtRu/U19nlabi9nVTU7hHUkp5ndOR+0/toG3ji6qbjsjupA4I2SlwydJth1X18HKy9fgGQENgbCMmzY+xL5Q7uwRAMfKBb3Th2MHUZvtjRrmfilODQVLqGNfat/tmQ6/SCG0wX9isZ3E8aln7cmvl093qmzZrzt8brr8KpmXGdzeSIcjRey4JlMO+uq/rW5lxlg011pF1E3J03Op+fGnDGNPPxMLv76xmSZvq62eJe/wASFzvTnt8zxBq2yNCC9Skhf44W7zJJF331Ezk7Sjr5MhONsVVs+PJFVJGNeaUJd/2JLq+iy0zRzTTkkLUaqMlLZWOnmYDVSGkmjfKl7y3JYTj+vTjSfk7blrYEpWiSo1I9cJNpP9l1kty45rEpETHXN8GaeSdXlTU/tmk2Uf8AxNShJQ9LEoTVMjCm93f6V6gllir/ACyhHpTISNRLJakvTZMd/UyJI9DVT8kycr6e5iadq7I6R0J9a+qxAWspEKfI1yfLlTHOkujJwTRNtXWnca/qDZyuKiySnJ/fuf6ZbZYytw8yyToZbyAVROqJpTjmn971bknI3GqgRYr6Sg0p8QB1uNjtkqJRAU4AgWJn6m8jYk6k7mSyflNJLAFyGAAZ9kACdH3m4q0qeCI6OinWPeuK6qY/Q5NysamtsrMx1hx48cpdWy9T9rCyUCrQ+rLxLO0pQ1OmMeRpzUoMzUR3NLqeN+b8VdEqbeuDJKGx/JkL1qjQTm1TWriOepIvxoe0Nn6qRK3TnJI7Idrdw1eYKBYAM5mVYscbCpKZEF3caJ5ZNVy9zlhYm1ayaMOSutediFa8b2hU6Z0YojTE1Xn/AFRHZ1BkVI5kgkP078DO38gr09/ZPjKuK6MWorpj67rpYp5JWdrDCiTTGWmmd7OanEFMnVcsl229ctfWb1s07BCvxDG6FKEZDexw4IJw2QOCWLRl/KTh8MIu9wdRPJjdM0uMOXlYfrZd0FHJT9du9cSHnyUUyUx/l1ZVmTVcVRNdFSsxRyjMxzFVNIy9fmTDBOPF5TG1IO/tKdbr+tu+GIY3y6EaQLGT8kWyeC2vl8wv0t5+k9UeeFQx0a0+PxEwBAt/+U/MOylSrOdNBdsxYpd8YlEoGQ6Y7yTBFOq81da7mGBKE0RteGZOjkk3zTbsrJXEnjFzuOj7GL6VVTTd1CVHM8yUeckTpv8AKkbuppf6s453/i/TOyra7Xvn4/t9uQZHX5YVa3WTVVkTczQeU4rJlPsbZZtvqaDb0Lvmr/MflCsjc3M7mbAMgn0kAhQXaNiGST3jOthiBZrI1kBCYiCd6s5tcxVbUsimrvtrzV1p22CS98eoqRHOzuGTH/3xzpj/AFrqJrhColav662MO3ytdVOVoeTl1uaunsSjmfJWug0hX5f9NUZLy4y9vpvNVJKM8zNB0LURRTqZgqpP1y08HWKtjI3iBEr3PnVAogHhLHAiQP4ADrdejrrfREO9soR8nxzAzxYURWnrTNWl4tFRFfnQYPBvAauZKqSiz4+m/jyTzZ8o8hJIaqZbAWtF6e4cUT+kqMXPMYu7ehrJ5q2f3GVfLzU2ESP5ufTyd8g32XTjdwY5GtRGX6yozvHPOi2knZS+B8QaSdyTm8qKlnPd3OthIACZdrymDuLME+7euj9ttWMZEg84Jq5anLVZ8c6qavuMpWQHIjXfiQaav67/AOV/41k92/jHsR6D1FRft/pcfpnVGOI5w5sRijNOOjvDEzODFUY8mOqy9ax5pmfj32+TJ7p7bFV5z+4+gIqacmSTL6iJrFPMJKD1wylE5KKpZmfrD/lT+Q5favYKj0+dW7qIMTlyc48ltfPVRcBmiMVy1r6Tk7/qqfK/1OvqUfHfAf2l6nU3IlCbf65OunpekCslkCnsyJjj623j5vj/AI69B6j1ua/dPdc2TBgy9Z/iceHM4sejKYz1A3cS6Kz9u63My3SxsPcPQ/8AH3sGHBjn2rF6j1OLXyvrKx5+8cuQjRj9QD6qmYuuIxtu4f8ADAPnPvH8n9X6j1GSP/IvLRiqWZlcdZplKDi2r+q01m7Xfy6UhdF/9K/5J778Xw+gzWUxcU465zWppkrHeTJ8k/8ArkCWZ8oxks9qnp9Sv5uv8QaadgTS5G2yNyYy9c46gD9HT9RasyGoqHdguob7DVP3v1Xtmf3H1WX03pMWP0cuSIxGD46IL6b81qDKb1u0mpZJIH80F4vasnGokunoBn4o7l1jrWyCVn6aprbxkrUydD75/GPdfaKxen9yucOTLhjJkMddylpTNfEusvO7uskm5ZWXenlMnsuXrWL1EWuqB/t8br6dV0NCBMSkv7nmNP56IqpFA9FZqGEWBkCPp5dO3LX6xUHQJkgAOZA8NYVlC089tj1Xq4wYMkJPp5vKti/EWfor63bHPKTItGpmfJ12CcXo/TxOOJicesUl4mZ+XTPyUvj9LNqb2VqdStaH+Pely4/U+sbzCYcPJ9+91VqAVI19J5vGP2/rzquDo/VZlgITGpOGr5uZKqq3kRpmSQuXLUtHkD67rHqVk1ilg0gjbjAQkfWJ1dNIM+m9nik/L5tGATZrWuz5chly2O6iculEk1RTzFUFDaGN5/Zxf2iqvVsney8U/wBc8t1JXBQRD3PNMj55+oIL1RvYZw6ktmSMV5N8NFgdxuqK+Rb83OtXMbt2P5qPU0JLOb98ZeGv8ZhdvwMzMUk/HL8fRLvJRW046OgAEMoNu0dkJ++FqaomyN1a3AiJL47VM0RVdEOV25Z+ShcceNRDDyVJTUwlHdzZsGPzWV3Wa/8AGtfcqmakgamY0UyXCWzGia6amTrqW+pRqkJ+SqKtqfr0Sz8dS0Y3xqZp7oqA2M/muvI5MmTnHVz9fTr9p5yPJ3k3fWg2Sv2k146Dr2OigiL4eYDv7WutYnj29thzMd9yNarHz/6irx4sl1BA5JeqtWamOt+ch9qSsfMAKhxbzLPHXxTL9fr0QTqKRLprip8rvqnZr8t7bip4xtnOLdTrVipXTWqtZoi9PVPx39jbU201duTpuhupICvp4yXtU39RjX6oQPJ0go0zeYZmBYGb2n3GghRw7PYg33O77ELSc3x1CfvmoHk5Ko1qXXT9tpfOgTS1rf5PFTEBkbl5P7Kz0SH+bqKkJjmtynS1qutfjaxfDVVZNLqMRovHE5J6ityTBxUnM+akdgpz+CixNa7J4xibIJ1F70bY4pOkE8aralmwzIcQ1BSuGSO2djqRMbynCi/1DItEQNMMJRwHKk2HUamfCYdknmgAjx4f27nQ9Yy7i8VgX/c2wfaThrKf0LEGZnXJHhx7GFZmuZzWE0uj6szMjxi3h6GdyaDl+2p27hkY9YZoeq3ORoDqhYCMm91V1UxJsdqGts3+Aq8Re1vTPDe9tTIBpJF/CCKGRBwO2q7MXWMmw8zUrUsTi/Xw7JEfE8gCl0CaGGSf5PDMhh4qjiRDn6FvbeVGCjUp/wDc1Un4RjvqhYGYypjCSyZod4dzJO6Qm66tQ1M+OcjEdPO4/eXrJ9KyfreKsm6Kk1pk1O2oVdn5JrJZ2mcCFvtODnVUoFj39oPpf+i903LjbiHw1DiqfjipjR1spl771M/Z2BPkQH8bRjo1d7Git/2GNRJNWVuadzVdOnzXnmfwMeSObfkq63OJgjKoaj/HNrI3NF7yeeeFnb4/H/HM4vtqrzsc9AuHetd0MxHHO01T0/WeZC4NYIgoIN3J53/aNaAAgkREt4Ithku622dn0uKXqmyS35oprHfWNBjHd0b87qZjTvwOSVxhdqscxO8hIkh5Vp7PjhyUEYn9bmUAjQbNtf0+Oq+lfZLpmkMbU4z/ANJudXNb3qZiV7VPB+XHFRlDl89ZiqCuD6st2NEYx6JglTaySuzk6lZ5cMsIsAiy3BRfvpgkltmrMSSQOKbIp7jV30/yW41JZxZMcMVORjJx5cic7rar8gwgtISr+dFimfT8lzv/AMgFomuoLHfOSmeTHUrJvXC3j6WvzV+mxM/as2OBi762ZGcdISM0TtPPU6UlZihrk2WEtiIiu2qh3tuscNallqeIcaImuCqqqDi9eJ8UWSL5Qtup8kNY1rSIKuR4QSvYX2xONdb6eonDOrmQxdfI/Zquyzqi9zkf1dblAmBEA+5vaD+Mei/42/h38P8A5b6vF6f2X3f2H2z+Ue1e8HtvrPXezvvHvP8A5t+8e0e7+pw48+T0j6z01ZJ9F7j6bBlz+gy+kmcgnp8uM+D8WG2IZ1kvLYE/2ucFhQf1ZxO0dnyTJU3NMvj1n1v8u9y97/hHsP8AGr9R609T/FcPrva8UemjJeL1X8b9T66vcsfeG8xiuvbPX+q9VjurwtRhzYYKxcZMr8j/AFT4Wv4jqfDimqqmmjqus0n0mk+l010n/tqKI2MiNdvQ6lPTNZqmo0hUmxLEGYfAj2J0H/JXv/sPpZ9Z7F7B/I/5V7p7J6P1T6j2v2X3isb6T0GVn47v5tYp9ZiXHEY6j03pM2TGY75PmJfCfbPa/W/yv372z2fBiyXm929Ziwyv2+KMl7z5mIdxiw45cm56+ON0k0dNv3zJjy+ryZImSIy88UDKy0n0k2A1zu0uN/5Dcefpj/6Er+GYvev5p6v3zNji49sxYsOEMbn+PJ6wusi+nC91OHFeLrHqpctSTRZJ6ddfT/pn9O63Wgjp0Emooeqr/kVSM9rZ1zgV/E/EU9NKgkOT+EH6ZASCAxr7y/4Q/wCNvS/x32X2z0/pMfwnpJxkV6nFGOcrgwuT4qpxx81etUyc9w5OHtJiU7z/AJP9Djx5IqJjLHxG8M1PnHWL1NKXWW6v12PHkmPjurIx3HUkZGq93/j/APF//pf7JgwZsZkv1M4T0+Ycd+olz4axRq3NgA9OffJiACr7nJ14fmb/AJp969F6bXpY9di9NnnPeP1dV61y1f8A45f/AJmWsUu5y5qu54chVziyS45GF/FOl8T1/wCqf1irreqqqn1kNMXBhR47WGvfQp6YpFNKApgRUAF7q52Y7a+Zffq9Hij1GPOZayGa7ArEbuaYj03M5Nb2CViHKQ0jPE9eC/yj6ZExu/myTckJlkx5Z8Rs1i+kg4v2BVXDS1L6h756v03uGVj0se4eu1RnJ9r9u9T6jHRkoHBNEZNVlxXBkZ6FgZ+0Sz5n7t7P/JPXqek/iX8kvFNzYZPbvUYsdcI/EfNNbyaycGnrUEQRB+fpv9OFHSA9VQpSCqICtYbX8iZ1xdQhEANbdhaJ+1+deOe6/JlqonCS9ELM+GjsvNEZL4p29GTy0zy8sOvOPcLaSWH65DGsgOTIdjdlrTNVr7a+zBVeYH89i96/jv8AL2fP8S91wxj+tRWK96xFGSNp0aq2THLpfDHfyL5V7v7f7xhrJPqfZfcPT/f47j/xsg1l1XW06rcdLKsPMcZOSB/Pquj1OlUEK6C/+4RZq2JBWw14/WDZ9JAUerbYuHaQJVtcl6iTqt24mb+QC2UCk+KOYncjvT4KescO52a+/UepeseXN6i8fyVLLd6pYYtJf95DRHVaH62N7KuetzfCzGWawpjnsrDkjUadw1XNTXP9q0AQzT9CvzWXk9JexyyrXcyaWXU6lp1xpr+hu9fbG1XB+ddJ/CVEMtB4sNwBO0a5SZpuvYQt5gpYsBrbV/HKz+217l6ejJHp80+n9WA5MnpqqPli7IXJGPL/AF+SqIamiTTjpqz7LmuRwBkqGZrBlYx5mzndxNUN0rMFO+uto45qvwvafffXezZby+lyf4svOLN6fId+k9R6ebmvj9VirGTnx6jZVDybqdJe+rf5P7f6jHNZfZvSFdGao9PWRjmvu417x1jnZ4hckm55mDbQTUD6UCHJAwFBBQlFnicaYHTIkpGRHFjtF8uz1zJ7L7hbpx/u5qbyn1xy1qv8mTjHMjRsxSjscWrLCM0e1mKfRYfSPuvrWX5c9TkxYPT1/wCunB8KFveus1odz1WSpx7Nl673b0HrZB/8v0wDkMGlhxLTUaXM/a1mtSYtk4347OvzSX7p6D0onpJpOVy38cjXmUx1eLJIyaDgNTP0bmNlI1kqSLBf/bGLbC420qjQIpKbBN3YpdnjGEhrPWe3V6N+fBGWcJePuUkyYMjpZmnpcXj6uwGRoHenYPVFTlx5JmTJ/wCzVGsuIDr4pqk+Qd0JWj/rzI7bHrz3GzBPp8vp5yL3lbupttJR7kJNv6OmqJwzU5IjWry4Mnoc7gtGOZqKhr/Lis6MkVSTQ4/DoSlTlCpkBPpLvBCuRiIs+B3GszAJAYh7xtDhqwvto/Vx6vA1m9LWbLilIlMlOTGbK4uIXUztNEz48v1sfzc+wetcmPP6V7q4TLN2s0TkjnIN1qLmbDW5Gnagi1rfT16DGFfN6zzUsxj4xTH6QckgVplCd2ydsj18ZsPRZMeLP8uGCT1HEZOa3kyxVr2gk9S68qq/fVRtZqpBpIO0TH+ME49zN+ClsIrN3gLfacBSDrbZ8S7qsf8Ak/oarZk8P23f3fkaQTcPidD5dTMcuatfEU0Y2umZZDQH0gmSLNk13qjR+3d+qhnxCyzQLJQVF0tnMjvXQ2mjjeg10avLFeXTc7/c7bkoXXy39Sp1QSjodyCIrppBlhzN7Rjkbns9Osz4Enw7hD8y/CpyrihYIp/w0Wf0dzS7a+SgdjbunnXJw0rq1zRC9JOmtExWScnlyV07hFaZ1GpRImVXPhiRmfpH05Jx9Te56dM21/qj+wWFggxGSYru6KllxbYK+NyarWOjiSfK63sJVOnT+loxL5sYTgb9ljXfKROwnuH7fS2dZcfHA/syIjNbnVzUktGM5nHrb4GBpP3yRU95o5rG1GCbk2W5GWWRUqqr+pU+OgCtak/Dc0z8i/3iEe4HuporrF/aIIpdvM8MWs3+vyrjKpXurausxquYMarw5CRm/EfU+u+3+j1+UfSPlvMyIiIDOzAhX0wX2NmhdLsLWw9tXW3c1JTwxjrRUnQ/WwubAGQMigG5mWZK/JC81VVdU6qutEpPP2wn1ZfNnPHKmqp89fgYiL7ar7G8hd20Uampw/bG9al86d1JzsqfJwzNV8ShS1kw0zOPKcw18ZsovqSeapoqmU1X4AtK3L9/5tm+raAuj3sUcyfPZaF60RmDeiZyeJjJiI/VVT0LtNutUaoaByLJj4qpfEU2K9OpIcc2UCyutEyNymnbLOepoyHFVzMzNcyOMZnvGw7Ptd8p/qPDP9plK7MxcLMiYmHqCsboHGtVU18n1a2ks3JQaCaRM24Fhf0nY4Vj9GdJqMWkbr7AthT2OrWTJNanphipVQxxmifrVc1tq2qO8e4b0wyUzX4qO6V6mDq62wTOS5WZ/ur0jtAN8VG58bKcWGsap8dTl7ou4ix5ncTHNamzQeem2emfombcc72NXc1ORWrxuR3Bkvc8sInNT2O1lSn8TLDF4CfDdl9beNImAI4KaBS5xGVkHUfTL47GZorrJQc6Z7wcnQaK8H0WlDmrLGY8m8xO4CYJesbE2w8TLKasSqnl1V3KaeNuGIi5yYhq/EsUwyyp0MxU/Wq+snn+06KikJsuLaApujXWPn47p+vWU0aCdmm/31/ZfxFtwmCS+IxM2f0GgEX5D3QXm/uLzplepKk1PM/SbkitXk5v7+Kf1t/+aijvliHauYrLhuM2upyF91oIrm/jnmfjpJaDzZNC11P1/Jnov/7HlKyTkv5ZNIbbLs4kJrZo3z0JWu/yflhy49Yj4zLSHNTzla+tD3yYxN+J0c1cwkcoS/pwxG5ixA9hpEk2Jiyh727JbRe4YMczjeMnLszCcihuSJ+il+Bqdcq8Wnl/DzubJgOzHl5YyjPMdAImTZ33XI7Ajr/2l0bRb1Q99LlKNBzE39omsmPU/G3vcsu3yzU+IG6rZXNT9px6xvAWyz8vPVPI2G9HP614dAQ+XFj3V8jhYciYcAHb2EK9xie4d4BLP3WPN3lnyafj3Mshl/UsJSlShsyI73+Z8YXUdzO0zdILUb6+NyO/spyEzvdVzR5fwcmW5cc4TVBzkrJVTjObjWU/c0NdHdSTNHBNPlX3U3mrK9zkrmMh/wBTITUjk3BGkW5nzD9p+u9BV5zMYF//AMPAI0wQLuLH8nwJGCMPVpBrHb9mKxy18d1LXTqck0NVrmTJUqPPLKpwWa4q/wBMRdwFk/HD6gQeqaa41Tqjbs09ccp47aPvimSQ9P3z9h8Bb3RsHp+RCt6Ykra5nNGOgjqSMYRE1KeScxZUy1tpEZbkdQrJFj8JICGWFtAtv2tONVgxH5IA3ShdndoDHFjodQ1RjjM1NjLcptvKw1JkA553LIcsorDVRurJpybJuX5CIyG57u/ARQrue9fYE+34OPNZMsX9/rjGu4r5d9eBonnT+v0IxEumU5jdZeclEl1es0hQzMg46Wp6882TJjeL/wDn6gINrg3UfvPNlGgVfmI8O2+4W2dY2uiZmbKnE0881bTfyNOXTS6+zP2uvj1qvIxGWqecbYZOCnfe1OTnh6j+33MYCyeHr8VOOMnRYmrblUa6SH4aLJycdUzUTyWjik09E9wV+nHrLre+XqXn7G3IS7CCZ+2uajwI0yzHaIiUu6/UopjNo/3iSPDEO2nVbhscdT0s/J9RmctV5yNfSeXhDe/Ayyn4tlyGRmVozNVDY045G7nnT8mE6/t9f3pI13+Rjzuac9M/fbhnU7ZqSJP7Ur2ldXrufIvWxz9p09Hx9Xp1BMze/lvfbkRma2ef/snPmhMWxYP69/uRxGrYSAgJfY3/AEwBd6ZFYjpjeC5yNicHyRGpqYnj5E0n0o5d83qaxKy7yCNZMK5JEZjEuMKb7dvTm5JL+qbVFQGpkti8b/Z+nmRmNqMN5Nq9BXeh3JO9+CSoWn9li2HRcfAb+hfmgpHUUs3qnrYMnqutt4AQLMGDEvsE9L1eIXGCGgu7tyhoonrDF5cu2uLxmNxUXMSTMVsOqpT5PFIap5sPwo6x9wXF7/zRe93iwp9N1IaIsxyR8bEtrDzrqI24YZrhAri73byTShc9M1uAje2TVH0jmJh+TLli1XHue2pedupiH6siQyLU7cjyFzIrkQrLEITcX7Rex0sghLEYj/UARew0XZi1MrkL8dQQXBUzqqyTRj5fvROh8WktfX8apqUmDfETSVQLtMlv9ZuEfkrkRlHRuRENYzc3OUyWXi3rIw+Pjqsh4xM8p4/Ruw+z+ROfd0XPW7vE/wCOtxdIRxa+MYNs0yMO6Z6KFgj0okhoANKBDy7RsiVoB/0TYoBB9ji4xfTcvNrjqwbqhrehBKFtGZ53Ujjk29SM7AZpwzDBM/XHKcuSZ6XWWkSSuha+u0X6srP5VnuesmSE6HD8s0WnRMguQAk5qqyRrtZY6Wp/LF3MRPFU5Ex49zWTzVaqPUXm3MxtKDZToXWvqtgmG9i7EIc7/TGmJN0Uz9GFee4m+hqsqTODJCOOu/OEdS76jQ9Zrl4v+pLUzQ9jKwht7vR/7jUnjc7nCN1Rfnf9Wv0yMvH4RMwnMuOCCl+X61DfFw8iNX1yTrbIY/7A/it+a8P/ALKSmFpCXnF1zVsaaJvmZklmSVJ/Cpe/nZKPLAixAA0jwMi1kCEmBh9kJ2bizNY8VFEjjoqeJ77J85NU7QK+t/J2vWzcFfkRY/VzRL8RmaxJMdcvm7mn/KrE3jjU0bK5a1+WCMWXFFSTIYiax7+JniHygNkz19a8/vmyjT+I/wAXpBuQFWg4+SnaDitn42InTbLsxyXaOqBFhEoCGbKy9733yNMEhHCu8ws+cgrQ3dfLjxSzKhN0Txj7Lj4uslbHvVW3Mdc7GvNLGWSuR4gmZuvqSWxTPII1XW/LsLBxh0FDDj45zY6+NIcd9GP5Pk0X94fsDTorbbvj9bfwL6n03yddNSBaNVZcaTJk1uXGT5TwFJp/tU+oy/pAIAEfy68an1OfMeCQGfcbcvRRkMkTcutSY+EylFzPYcTVSa1Bjq01/wDH+/xkUYpx9M33yFuuovJJOsqVEHLNNQnWqmsf/wBoYx9G75moqdbAw5piN8WNLkbJ3NfXr9VplaGqx19JXHJcTe+Yiss2TylK/ebVuoKfMPLLSw1Nwh3HvKU2W2mIE4i8RHm3BFttG/5OsYzteVqSKckutjQ9ZGqEo4PDLtJBZbG4sescViNjEJ1Mz31u/tZsuQqmWK4yY6fwc1ZZnfw/WfrZNkO12ZCCbomiF+Roiq10fXRE5a5jUEWzI5HVUZGh/wArTuWB/wAm8dVJMQn9lTT8WueCPsXsnbSYahH812JJ3sBOow2ku5+aeoG9VdRHE70883zpGUhxv23KTS3O5OTjHrmpxZKiaxXyzUf66GOdRVpr/VLJv8V1ODJjwxQOSP8AJctkeWJ3r5DfyUOqmWJHjnUyU6XWkmJYjlCaK+tA5Jxj58a0f7fkmgD8YJ9KyQH+ePYrZaAUTSgwm12E3S9juToZljDijuZK4o/t/wB55sm6PpMa1Giebqtu7PyO7JBjxOXHhUNDUtfbK1TN46EKtl6qtMoZOo+1HFQmfHclVqY+SJh8RLSm/JrUl9H6oKI7vFQkqVX2UrqLyX9ebpBNS1Hgk0UzrYsLLtgc7bl/tGmwAPlmcSTaZQPYO74PJGWyisUVyygVOOMjAl35bfkvUsP6pJLnqViSudMsU5NLZCcZbCSWzmUknRTtEHw7PyMglRjxriq9N5KZE8xXRUt/emkglgSQNiP4PU989/rCEo/XJkBnS1v7+ei4ndXsE/2nNsrZgokeIMjEC+pbMDaewHuXuI2RiMjliivjsYqcS/5G+ivraH72wT8mmCv1ClbLDjx66vBVL9tqNldeZrRwRL1srzJkjIUgBOa67geNOLHCs3M4cldc05vrt5Fm9OvBoeq/EVcY3HclFJMdb8DSVOTLU5CXb8mxnzy2RpACQJFggRhIdzGEozqbPFtg0jBAI+2Dvp8LBP8ASmrkxqNceBgcv+nGwjNTs2an9bQ1ZeWVFauAZqKG6Ce0ZlxbLJ0hs5Dzr8bNUFEVU7ozNb+bUiTsIGC9BMngZ7KnTqU1VrUZcXGQvTUks33FBQu2qfOp3tnX6Z7UbCNgjbEARKz7qWEwCtsD6snGSJ51GEy+OsUgy4zJMVWQl5W6bJKg+6I9P9R3jpX5KfjjqonZikYCxm6+t5aSkoJJtSeoqthWwCK+MIpWpPjxW1z1iyH0byRTzRrTPgfB48CFbktxbybybSzokTYzWzioZrr6zjxy3SapfxMqBwUBBgW9/YY02AAc3xeGkEOfsQtReXX1+vPOPBfOOtFO/wDLMiTIci2+diR/8qrLjHjMlTS8HcfYvHQeLVilicYU6+s6EEX8bLWNS8fVuT63pWaUZWqmZcfW6hJf0uv7LlzVcz01TELrbFTv78v9p5LZDHO9qm3f5N7wYxZ+mZn+bLUTzAFmF3BlsyBiEY0IxTVXV4EyM/HXxrRNRt+z1UlhMR5rW5nW+vyN5PExNgU45VspyXTxkqalcR4/cu5HxzM6/GWxXMEiGrkJMRVz/iiXaL8gGtf2qSB8bVyPVeO7qayJRupP0k1dDTNgRp5GkdLpLbn2JccETG5hZ1BpfMZ3cGAoJ/l9CTm9R4rUs5SHescP1JyFNbyNW8z/ANRdS6uh/GTj+MoZ8FUS0/YioAZK4GBlSUOth9fB+J6xg1dtfbuKRqrNnONtR6p34ifIf7U/IMl5+jtm4vxj6r7HAMz0XVO0IiyZdc3AsV+JgN3gGewPvICcdnojYQlFgwLd7SxZY0FTc/26Ic2seQ6mp/UyZMrr/Fz1xcwMn2JiodlWMmzLJfyX0UuQMZTWxbh/1WzGUVq8bpZriDnNsrvl0fEvOSpaN83vY9Gqet9bjJ+9/ZJWS8rio+3yNOY1E0FTJura/tp+OpAa0eMk/igEAgemJuiADcza+06P+LEQWCCR+FpA7sg7tZOcXIT8mmmckdZJ8Ywf9z5GudxBzPmpeenRt0sH0quDHVY42NXeiul01Wmm56StSFNH4eVn42izHs6mZay/ZQ+M+r8ZRNdBKuM2BT+VEkxxFVDVVCVteOiOJvKniJ1ZsnqWaAmdpNVUkI4Puhhlm6Am+2pLmcrbZDGw9NJCC+WdWJaYLmY2E4tOmnNPVuXVZD/f/wBk8U00sgP4q8VUiHydWZBF6nHT5LYKgkeVxAamlVmn8JM1XesiBPbJ9Z+ObNYZeeL6Zn7B5lr7f/LezBPX9qujQ/vFTyzLQzPE1NhE7Dl1KuvwFXCG49wskow5xqQSpn0xvkKI3gIEyLQQ3ZMpj6KZxrLUDd+JzJKrvdNXk5Oj/txVfmZruWIdSEY8TkiuZ6s0LkU7nWyqgkfqVLJX4WL41066me1rWmJSg3tL26PrU7mKHnkWM5T99yqT5ZyJjx0HNdPXJj1W/A6WmVp4lRe22ABgqb5YxzoSUvPGBFRFpILbCZB0v/I1CTJJM4KebJ+TxvPspNRo1btPtqPqbPJT0RrSc4lk5rLQ7Lq1p4CEu9Ckm64nqhaceTHYzkL5hba0VXDtt1KbmupJJmjaDoo3JOKu2N/InLUG5yNRZq/BwVNVybr6rMvg/JKval9oEkP8IKlcByJGsYDRvAiB9LzId7DOM310TWNy/ZnkEJcE2HycNf8ArJNNdSM9H4vFV08gfXG4x0Y/rj56/wDYW3kV1iuZmlHoKPJDkcM2Q0lA3MkeeSuMjQMxFAOoAmpOaHoXiWd1KXu9HXVTiL5qUzDOpmiiiT6U1XNNNfkVGR2DPMflENxM6s4UvMgg+kW7hYM2vqylrVI3c5OZQqCnWv8AJ09I0rko8P7rdSsvwlzlor7FDkmmWuYphJir0VcozMm5P7Tz1W6tXnPiJ8GSYm7lrRPWzJdTdTQk9ZKyHgNTC1VTe+Oas+air4nI8mp5mZ6xPVLGJfPTH2+4rXHPNWTs0fG3czJe8IzoBPqB9lHaYN0THzMHvfx7yYurxplHWVa5+SeauruVbiGXUsCDAMTIZfzYel7yhdy4ov5OBd5KsI6y5F4y/F9NE7fH7P7Dree6iez7OPnV7MmOVkDJq7qwZjmZRlP97Dcen7vcIQGOpMejHNsTxXEtuo4dxMg35jrav5xddkSFZwAZ3Ccdv3umT6QTAR4sG1PmONb30eTFU1M5JKiNZY8YWsgeQGLr6lrVk9b4l8c27rHfxQXeP6EcnOJyVq0cd1RepyCVd1TNEz39qOXQYGJYZqZXEVUxPE2yMrvz1WQRoNCFHWiZNvhzBzyk1UTj6+PITGS1DI2MHet3Vu7x1WsQ+aPB6wE2Bbgkk2Xv+41tTa02KLVrcfpG2up/j2TJ/wDTz2PUzl17x7d0OO6BPU4UkWcYYpq6Nar4bool3Q+x/wA090j3CvV+j9dWScR2ViOYxyReRceP5f3OWrq4v61PDMTjJvvw/wBBm+P13ostdYz0/rPSKm5by4/U46q2DeRllrqioborroxvXpv/ACDm/wDpdXqg4ru7xSH+WorNkyXOSsxrTMCOyvjmquZ50fng/E9EV/F9I3KPpO1mQjhXK8a6KCBRUxkeobhAxZoPu1rlfbfQ/wAd9o9Xn9Z6j4qxuC88uSfT5MuCctS4/Tzj3AZO5K8FMNxWKiQkqe8f8qV6bBfp/YsOHBGJuHNkhxTGXH4K9OfItckSYos81VdYtVR+ePe7+5ZcnqayzkyLOL4+2jZkxiFGTHLV6g6mdhE80bU65m3J6iZbtt8UVOg45BCo0zf9enX33IrWuvSo+FFVQr6pPUISBtSgBwDygREjXHX8R6aqhRSKZcGcQ8Y7Xtrqvd/5J6v3TIZfV+v9R63LeOqGSSJu7qndaXyZFyU7a18lVUf10fp//J9V6uPTZLyRGSrGiuj4zm6k6J1Mzt6D9I6BX8732v8AhmTH7Bl979THWH1WHJHpPkFq8kY8ee5w1ucUk7oKLvm5oQ8R+cr7Vh5965+RLK9Q6/Vs8V1HCUXfUlAKZHp/dR+biun01U9IhUH01CECKQxv9BJtdRVT1HRVUSBUQS3IjLyAJpAuPHS+n9Jh9uwmHBjYls1k25KyNwwZsuSeifqDQlY6jyhO5F+oz1My/G7CMVVpmPk6EtW+K35XJZXLCE2TVNz5zWWHFui6mesdNCcRK1VRVRC09eEv/Ran5rsjeTqSysj2rZ9qYp5yY+zq734hOAZrHZsZrOlky4xDlcFQIMAa0AgADuALWgCAIvBAIFo1TvapP3lFLNVkxRk0d1ZYajVTWOgNKByq6fM26xmLnnIYrZZ3krdDVxayF9UVkhflUjxJB+bOobyW1TW277ep2HH+GtTyhI19OY+1G/PRq8sTl3GQqo7pm5HRMBjoS1Zh1/Y4+prZUj+d/Q9JXpm0uwCBPfGWfc49RgAXGRbGP4xZh6o5KpAIAJnFfONJmx+uSTvf+qlyE9DRo3KtTNjXJB3Bd10eJoqXmqG5BJ1UBTJVNUTp5otMQ8tQibuTrU62VGJaq1K19QYGTQbGqq1JOWbdecaMUiw1TUGPwTLrdRJToKP0/np9L8IkSQMxbdTj/Q1ibcRHkeF/GtBGa/tjvWjeP5Pr0MwGt3X/AK+Gz9FOud7Epd5+MZeSYHWpfiZjt1RlXqZCkp6OVmaGUk/H5cNXE1Hnki3kAuCa2XUtU0zyc1XmNdUuqKeKaTJGqIVr7E1REAs/YGCFroZPvKyypVdPqIsrBcSMYuxnS8XsNhA4SId7hayNzNwY1YeW2KRqTucvdEwTOhrIYzk+MJ01uZjjJU8q5cTexHxfxiV+oZqiuInzqpnrb4LHZtT6UYLlpxRA9A1r5Bbuitpcz9i2tsy1FSNdTkrrXzatrUyAf+P9AnwktEE7lta6qeX6iYOELw43zc8y8aBI9V2ZERn6SbMki5043RLEwk1jiwGe9b/vIVXPNM1Yz9jVDj3suMVxNXNSxRBP0hjdAj4WZKZJrfU8JsUWZmI/3PNvyB3r6a8YS+Q06+pRVOqlqRk/HzXkA+p/jXiiXJ500Fmyd9tVqpRSdT0v+5Ay5k/RfyQnOgAsOkwbu447z2lTrPgmq51rUIrWpyDuQqlLtqP9jMVMk/vdAfGczMs46MaCc7+MmQvbuu664kYmmj/Sz+WsWGqag9R6gYoEWRXmTiCzXH7cnNQJNRMFbyCsE03nLpamskRfdyNBz8fVrWSGBoI5Kr6aE2RVWl4mwxAj+MRrT5UFSXYyHcWdmbTYxsJwUORxlz30Eky49nOpuu/rOXFVSpqaVUoupfx1/KD3NRJ/h1MUlXvxdzWkEbdz5AuUP9hHx4wyTAVcENMo/JVFGSs/Qo0bHXaY0qamTdoyNdN4urLnG2ChRpi6ul2eKurnan2Z3LvE1MCfDSIIBp44WwaGgAFhGJpSwaYGccrWQZbufjqPjjGzmk31mIs3Sy9c8yxeTqUX7jj3JtvT45x9cslVNpNfGswps8IDKBEy3LkpkftGqkyzetXTkMjrqZ56HwVKB9xIxPhE19FPy1M1bPWVx1HPKPhn5GKGSJq3IeU6MeRKikfP5z9UsMHYYMWw0MZI7aZYIQY9MXuwRax+7tOtnjZWAWCSfuExObKV4K7WmKa80AWzWJBC/wA2eBm6/wAlZMc/LdBjTj6icVN1VWZGqV8NTNT8ePNG/wA1VHwRN+KEIAgoqVuYvopS+53dL2ztCqoZ3HprnETkupqriJ7BujItWU5ZmUIZKuHySNfYlPzxuuibkkDAM2s3zs9bUVWFUFAPdnbBgsBcO2t/6eMRgi7tH9xU1NMvHU4SXijl5eJBe/60862nt/qc/p/cfReq9NnMOTH6rDlxUB8ZNWFxm+KYeUD54qiHG0br5FvU+lyRtxwrMHVZLDGXmxgsT3t/vekxzJRHxzUOOS9hjx4y3WishNW24uicli4cbBRO3msZo1/aV3yeN16TNMAkQWDhbTjFxO+tRanYoNpNbDtzrtv+R/43/Fva/V+urH6fHl9Rg919R7fkj0PyYfRvqZKqczkzZT0+THlvKPpfV47hrHBjfT7n7/Sf/wBBV7F6n3H13vd+ix4X0nofW+m/8j1+TJXpfR+3f/Wf0/8AMydby36eTLUYhcjkxlZPixU5Z+bv+QvfveP5J7Z7L6/3P05630H/ANJfT/8A0u9T6Cb9G4fW+3+mxez+7T7iBJ6v1136L0PqY6tzHp3H6uPkfU5zF9H/APDXseSf4n7B7N7t6r1ntf8Ax6+m9B/KffPb8HrY9Ll/ln8k9+yZPVVg9w9TgDNn9o9s9lwej9Oein1HyN9ZJi8mQ+P57+rfEV//AKkPw9Vf/U6lR6dZLqVNNwBk/KqQ/a+u/oL/ANxTVTSBkFKPlAH0Ji8i8a+2P5h/zN/F/ZvSZfY/R+8e6fzb3P8A8efQ5PaP+PvSX6r2/FRzkc3rvfMK+k+W7+SMuXBnu4SujUTjx/KPvP8AJP5/mv1Gf2H/AIl9v9mnP6kzPq/efTf/AEz9cPqFPhyvqcOTPzBLOUqSdiZ6mYzS/Z/8P91/i/ufs9eg/hPsmL0vovSxeDB/4npcftfpLw4oZx4nHfU5ctubjLM18qww1DPdcF/Of5Ji9qy1Fe6/wz2DPJfp95qfV+pjPOSqn1c+m9POW4S/keriqaGLxrkV+A/pnxXR+F6x6PT+BNVYqRq61ZZ9S/8A2VApV/8AIEAQxr0eoKiKR6hSAA6qUCygDKOePqj8K/yH3n/m/AGaveMft+LJRzHt3pY+D0mRX6zWLCGP4oxcEKVM3ucZiyL+eI+7e8/8mZrqPXfyT3PIz6uuXJ6ipkqquE7KisfLqjHRMY4dI91J9R/yr3b0HvT6g9T/ADr3DPEZs2S8Psnsd4Fj5cd3OPJnuNHgozOO48c1MV1x8y/ybD/Afbct36vL797leSqWfcPdsXp2TLM/avT+khywljvrtlQ/aEfpP9Ororppfw3T9ZAIFHRJiIdQpb5skXny+uKn/wDVrG7r9IlWwXdYzrg/csv8k9PLfr/5FdNf59V6r5tZeqI1XUEybnkByZIAj+/jjc/vnuXVNeq+ZchHVXn76FDLXVMzsDdP9p3udNT+bP3X3T+IeryxHt3tOcmHjp9R6nI1jjoqyquy7qa7qkwxOiuTnf5rH0XtGUMk+l+PvGzx8zFzDR1SOVXIbivtyyapK6lr6To0gUg1dMSiAqAoEQTH1515lfqJVNbFj8xkQy1NxgLd60mX1uU7nPhnJF5KxrT285Drf9csTzpoSRChJ1Vfmj9Vj9s9RWsnpJwuJnHWbBLjqlEpOJcdnkyfJXMrO/3iV3mb2j085Mvx+oz+mnnInbGiVCL41CM0a5xvytDcvmcX5oc3pPcMU5KOPVY5rJ5XeXuXcU48jFRSc1KNvyVjrETdMvTQkxA+WF94XbOueoECTyO0TA7IfVMaq5faYZ36L1OLMmJPj9RJjyld6JmpQvNKhXSXGTU1sZPzR5cfqfTZJM+PJhqQKrK1LkJd5JOZ1lNGjxrQxpTZsMvrmdTcVjrHMzxzMV1B/VKadclGtHSJW0Px/wD9MusZHqZj13p6R4yU5MuLo/UX+5okpRXzRlKUqfzQeEMryTHBZYtxqVTGPsTHZD2bbWrWH13t84cc+o9NiyPxzuvSkVvF4mpyY7KqTn72Qy11E7Zkr8Cv/pLnarDjxYfDERUzjsVUqCqGXbEH+TLxvkljS67N6bDb8noMlVU7LwZ8jOSfJyYw2Vw3ESunYnTOtasx3d3NQxni1pTgtk+06Rv7OzW/IJ1NQ6mvBs+ZUMyERsgyZwNQTwMPmyW3C1sPU+3+o7uvT+pfFdyXk+L/ABleCN/XJQh+uZtfJ/2Knql9Zgyts3670PWk/wAhnw6x/IwDT2XRdUcz1q6BS0jD6rN/fPGDH8I81lyFcz4PD9r3y7+5NGsemqa/Gx6bH6Mv1J63FVZTJHMBzxY0dTjqq3oWuizGL5YtBtkNVGMNv0+dx4OwGkn2z5I59p5xrT4fU0nDBQEu+QGzzCmSkNqAgVVanxWl2noq9Vmz4YRxQVGPI9oXM1JVHylVV9szCSR08UlKRqfV4H09RkwnWO9O9+ZpmqqKcYmk5XTqTz9v9Z6PP6j/AMmM15L3FHx6bth6h45nQFdE0LdAv7bT8CCquznAtx7e94TlSu+wD+vd516B6ubkZw01DtIZ+p+wJZQjJqdeHRkUFHX5qq+2DrikmeMhCOQSC+Sfu9NJJeynoPNO/wA3nqx1IjrUyEnMNfbg6KXezT4/yf6Dz+af1EhjK6g8uTm11PU2fHLJNTMv2lOpAa3oJnLolAVFAMsqAlcxHOfZXVi/J5CsLWG/2hEbcPXM8gHiAyc8yzd1ddDNQhTP9T7bQUZiPFVNT1vP080laT4vtr61540V5/qpqJHH8t1ePPXUfGc//Vb+sfHLRMZOUpNST1ufrkPwJyGLHM5PKHwClU/sYptrYO1HQv75+rv9LYQxGd4hPYNNSHrtBJ4W0fhj7ux2bejxXky5PU1SRxHx6W3KTPE6Pk10UuqtmV0TQ1NMrx1eK6cddGTI+d3rVUc8SkzuCFtNx9fEs/J+RFpbqhLPneZCbl11FUarJVDB4fvtlY2o+t07y8YisZUYaKZAJkvTXih3zx0xIJ5JlVJtv9QIJ43E7xsbpkD+K0yLI8yyhOmYesIfackVe5Kuq+Pvjm2hkx88BePl8Hejr8XmvVZF87z/ANg54K/+ryGpcfg84w5nQAImYsjQavjnEzY1RX9RdQ9zWyt9X19n7M0l/iqyMVXK5Jb+XdTu4l+ui1NXFDLIVI78bX80P4V+ceIP2SwtL8I2iFi3tFztGNNvLxjxyVB1rH1P+QqKk5rJl1RO0Z2S0z/tXwvGrv6FaZw9cU1LqaMlVVfY22uU+6IUUlLMHxxw5DJ0TRUndypJu7OSDF+qhNbu/jNoJX1MlxrNomq3XRK09ZYruSXXXck8yv23G9ZEOZYVrBYi3sibW0R9d5tA4u2p2yB7esXl+tyZExVMuaH/AOy013RUNF689a30b23U6tLkKpynVd7iaGZC9Tvp/wARJXinVdJ0ljX/AFNE48nL8QXp2lzr+378Ttd+aNh+TUz6j+136eJsbg0dm/tEOSuuWuZMWj+tdTV8abIEXG8TEElwgdmlAWhmbWgSBK7rd240dxjp2yhWSWU1vbqSa6I+lGmOArWiOKNSZVWs1Bqayaf9l6KOqyabkBMdkldBMvZIry5Yuzg1RqW9L1cmvshkp2OslKf1FOSaM5qsc0Y66jksFi8laukpvdVNHMdb+xrHY8lfgSASBgBje24wkCr2ek0drZBscR2xxOmf5rfN7qrSBOZnFkEjWU453dBQBF26Fu0/Ft01KTP1iugmNVeOY+5001f/ANQ68ojKmmZojHtgS6Ziqxt0Yr3xVU0HONmtfukdA7PzMuPeBytZN84OKHzoX6XcauGpmeg3yRXQfjJBEIqcsQMlEqAPCES23b3PDy3xPE6zFVY2/wCuWcmRqNjbDs5urmgxuNmiiVAasN1W1Zsm6cU/bM7xUzNjTOQXJWYk5XyFyaK2rEhK6dY91TLrEnOi4QeRwk6G/IdpJRVO5iw/K1397yUC1/h6qTuTE4zaxuomdPyfvJ4KRCRHA4G4gQXLmAsdo1TAA7/kF5OFB2uNPxZJyruGchBFYfjre/qfIVR0aUKqjudLe/7IwS+pqsk1LJqqqSocmOvH1yTB5+9Tx5pQdMh+HbRU5sNfIZCayNWhirZ57KqZnU6rre+dpc+VvLroGy9aa1VF2a8XNdah8Jqpkuaxm0KYbGD97JewYBUAaAGQD5XjawFxKIAidHBiy0bDFXewuZCtAIL8n2ao8VoPMvkjJ+Bc9S9IhlkrInydEzoedf0HyWJ9d6nxakTTkzZavH/ji+ouUbsCewrVV+5CuumpfpyAVFSQ6ck/IMlLkPiTpiyfE8sDY9RG1EHX46qowCJKHIm5AjnMLTcYHYYhWi1kXYAvT44zTXb8aV0zwROTJJ97seqTIuvqBSXH+O+bbUXURO2N1ix44Udav6yNyhFAfayY+p+m56qkXWbxGsdTY1ipJqqSfE9dzZdVEzLR9Tm/pGIZS5rm583W5yOgBeTHkpnlmqa8zLtEl7/EDsIibcRJ8AJSzpA2jgQTtkT2phhyZ0zIfJ6j1LuMlwvWq41JMnMukeqoSjlWTdT1ucqAZnuKoxw1UgNTD+mqKXIgbDn9pX7NLxxkcjdZttbyxRWiimf8RRB06DZKgbId2g2ssFSbSeJ8bZmcnX+Oe68kCE8n11uHy7bEiYBLshcdzAw9hGrBC84znDxjGyjScl4I5SOneOarHLM7D6uSyvPn/wBvI0cmhf3C8UZcRpcbNRK8M3ugkxhrTqduznW+jw5llCagBTHuGYqYrrc2ImpldQ0lTsDc0yhjnJ8wl1xq7e3S80LgIqTGuueiVJaWXdaJJLkQhteBZ23vpVEMrcLEwIALUYc2S0fLimMZlnKtfUax1Zrjiy+kmdgAyc9Hidh+NwuKO/kxbPnNNDvtmSSrpk52tFB9aGkamppXwy5cltLGr6pWU2hqCfFTIzQTXIoCSz+HlqZMc7maXHJqd7KdzeS6NFUnFeF0UVNOz8AUyQyys7Dj77XIWk77vKOaWRzx6oK0y4zZUKNM3OM1WpqDeqaaqq3/AI/8m2bGY5NyuMZNF8up/wAby3N1IjtUciohOjVUzNzt3+Im+sUXX1nBl51VNqalWYftQ3H3QGXU/wBgv8a33vmjHkGaqW+KyOODq/PdL5/o72JN9bhAGmYEqFyJHyjPfYPTBAZtDAHcdvtusjS5KxjOXHUu3H9Rve9EiPLvUUlyKSa/vjRPFVXeaqJrkJ8ylmnEbmrobcnie9clklfbx+ZGbJnxGkxjTLHjJcbxm71ddEClTzzQPP8ArpDqufqPeJ4GQjH6nV1NTctC1ayMr/kFpner/GJ9IEiCBd/hB2z5t20Agop8q9lsTgWvZLWZH46quXTnJ7ssoT+lW/1DHXRaFq9amPs/j5zmOajJBkay7x3E/JWtvx0ZJYgMdS1M0Ggak6K6Uzlc1/1rqKuf8f1mT+pG0LuUnlN97qq39xCSpuqOqWKyPUDWN0JEq8FCdSRqWSqod0U2QWP9iOBdb5Z20y2SLc2AgMiJ/gNhp+WcdaJvzXOfrcX0Lu8PJJTCUHxgRqa6+tDIRZ1bqafthVlL+QHWWm6ajrTHyb6l6aHnf5MSRd5LzOSax3x+n4+iEif/AF6y61snwrVQ3dgKvLMONZO0NXwyzkaWbyVs6WevMCpP6pPIav8AIqlwu1/d45b1ML9L45ElYBFja7fTuXLXdvHxyMHdxupJ/wBWnR4dvSZKGEAVflkyOPeXDJGsrFCQgc3T8nmqQh48CV/8uvwDHYcj1rFNFf6uGZ3jrLoVSXWPj9Uwoh+Iq6yZYhvc44qtfaZskThr+2QpDmNn/ruRjS/kmpUohtLnB+8edkUWBGUpUBO+LoEES0ANWnFFNE2QHNzRomqNmyfs1dTQvZxbaSg9flYx3F5Zacod0dbCsYJOugj5frT/AE8pkOvrYTjlxTq8vf6uZW7iMRO+KZk5lqdM1NTM81MKysNN/LdRuep9PLzU3JPB8jTR/rp7+11KaNRfQ7YP+m7yf2jVA2EStmbLsTzx30UyTExOXF8tVNqp3xcQUfLrUcUiTyaq9RWqNRqMlW00/wCVDIxxLRUeMtVu37Hl/wDqZ50UbF/Vcddc0Mb+9AaoLarWqyb53p1QM2Euwrbp3qHdEyEclNRBGeri61tNd6X9VqlUQi9hG1lnmSMFztqc+lntM2fDvcd8qcxh+WJ5aZmEtfqVNagvJW+ml8sSC4w+tH4ESXkupn7MWz0vPnXWLGUfYPFEx9l2b27/ACMvyVb9pv5HoyBF1xWmaamiZkqa8a3zpJKppz0xWzHZdcrja8lVX1GaaVZ/sFieND9vP4MGoShBnwQwXhw783bD9p/+1IeLYxtp8n2MmSiZ+NnGXqkoqd5KGB58W42UCQ8aHQ1krJBsQm8cm9ztJOvl5ayCSm3qTniqKHr8DoyRRFcEn2mqC3HMz9Z3NPx9cM/pJ6GA0/hzjJyZKhnrNjcuSKZON19SJKcVBUwyNJ18hTzUzbeQYMzmyPIUYzOh5JkpljifYpLuYB1PHyMfLT8fJkiC4qCngDJTU1XRD4E8MEoofi66ay7i06o511WgGa561HFaYU/qCfaUZjG3scjyay+NXRM63iPrczkTVMbiTW/C7/GVjMEXlh+TJfMacngx1/Qt/wAdFY/j6toyUPL9ccvU4eMyAxGHaVFsIlFCzAjJs5B3jsFwcaH+synDvG1NTJWQ89StbDHUgFeODcMzpRSkY5Eqly0VAayZW6vzNV5OZZrqR2DTOx3OVSZ8Z1b3Gia8z/eaIr4/BiqaknwO2efLP40+gUz4rIQFA89fbGmWdEY+p3rep3an9gG1j0xgWQxDE/YidH/HEo4sBZmC8xsdFmyMTjJqGbmYuoVmmjfWS+pC5oRtGp3Nc0FfleYx4C+MVTOTIBIdEZOT/tvmsU70dSnRsHd7d/8AZKpZx6Mss2DjaPMfCUf2maalUeug30aGtZJF3PLPlkPkudFdY66d31snkOjVkpO7KKI8QBEYlPiTDWiCicAPiUVCUWEneFoSJ1kcQ1E5Osk3lIySEzWX41vioDkrQzLO9cq/gZGOHUsyZJx1CUXVCz5JKuaZo3W+rC9Tz4/CLpVBAzTCTTD8garIxMtE+U80nItSDqZ/ymaT4z48dLcGPUXl0AyVf1Em3HbPnJ4nyc0qiFGfPBIsr37TbS4akRuSg4E3QztyEz8IHQhM5Od8lM4xBoPjGUGQg8NkoR1+Rd6pzUzZUGHoGSbtGmU5jg1Qq5GaLSUNLcw8klE7xTUnBqZdt4ygrzX/AF8sp3r68gkt+hNGGTGT4NfcE+sXVBPVPS/5dlTrf0/M9grLxZsbPfS3xHvAwPfG4Wjbf8MvOODJEdVW95ZRdtbWdUmycewPGiqrPUzj7Op6oIWlx8jj31D5PFz1ZP1dHJQPgcKZcRxRKa8JIuSK6fFF0l70Uu0KjbychzdG9VX+bZWvv4dM239r1RreiVsj+zv8CCgcFVNCbfqRgbakZWS4zj6AfpoM9dSxOrvRJEnOSSOX/LQbMZCTkfDsOmSC/wAKcWKsePd8k4S5RlKjz1ipop3VfV1M42TQHPdB8nx5BxM4ycN9oMfJxQPxjTN7qfNVP+QKh1Eh+HWRJK2NVX1ykj/jvTjborhJ1rQUcu9OnUjxj/WN+IzpD8lffDbdtgdtLnHZVH95ZusWkyOOAlkm1g3oP8dcu66E2/mVkjqRyeanyzKfJamu8ngLsQUX6Syc6fwEuc7hW6mk4Wwx3ibmCLe6k3ewdBvYBSLMdTWW5kHG2Y29VUKQhiPpsBkOcYS9QzuuVMBektbv5bMfo2E8agEx8qVkFETze5eQYnRwkY2knRjcValyZH69Tk7+rRvQ5FlInzt1+SiEbiSrxyNg5MnNquXJUoTr/Y+dM0Bw7LCXI12XoqsfYLEaEBqZDIV+4kTb4/tUgGynWVrubWb+xGPkT9riMkNBIAf3oZmr25I/n0m/251UFE0+kwLATAj7sHHC0c96rlmUhi5VmqYTvJxfRSzVVVSTV0sUEruulVK6+sVJZMh0y6uuK7t/uBRPb5jUnn8Zl66xp5Pp+jif9VjvJUVW2vM11ronSH7MiyXJOXn7msdJsPl55htX910zRs1N/wBlNxH+RRd2pCKtvG9p25zVUSA6eLCkQDeLWuSLSU8nJUFcQxRM4ZUq/vW5V6rRjTc9qqT8dDz5KrgjHOQZUjf1CKyH9LarabV5s+2h2NE1UM/KVCEvxkFQCXc/Ghba9lLSUeL55dKdii4y5nQzJzyKMG1ny881zz1sSg3zYqBNRG5pCsDcNWX0ZW2qGShCzlilKlK8hkFDYnTMc5Tbj+Nqsg/N1z8fZ5LsgjnH+uaNNVsKB/FX36ciY6qXmM2SxmG6t6pGgZSWYaJTSTKy7lpGis1o/fe+ZQX/ABJqS6V8kzJVNje60Q5J1P1J3M4qZxIdVXmkreoU85EKbmvDzSkcgxCcbj/ibASw40AE3FgECBn0ogCzSgfeC82syET8bA0/XqSSPD0WlN82M1T1E/d7/Iucc84x5tgzWvFdOOqQ8uRLtfqTOuNzIJpnM0ScblJkmoFcko1LuWq22HV6Hl/+d8gY6nVyr2T11Lfx9JyxQ7nHjQBJ/anD1OpqqMAA4JOBAWXsRxcPVku0WyBb0y4OLFBsIabjf/IhyaJNb3X1KyydVX3pqfDWpE+8/Gc8iWCseLmmpbvKMsybKy6+P5shPxzpmnkhEaqV19gx4rorEavwXF7ArFqgx3cnlqZknFwVUrv/AF+B94a+tZZcgyULeLueoYyLEsww8n1gZ6I20sFoDe5iLWCYtDnJvpEECJlSs+mY9PcXiEp1YhxemkYS7eZyKTY9MV1VTWoxjFJMjYDR0DH5sW3rHkhinNi06ifp208t46STXQTvkdfSsdUuvxxzjm3U7HJ0zFV8u1Bd/wCPh5a28R1T19ifyzLczMvM7gy3RejKzVjMlRytxVW3KSyfU0CYVP0o8bRa4h8kgWY0UVSHkMyECDQIRjcsDhjV3HM/Disy8zVitUTk+pLWP6zv6bjWGUa6pmtXP5scNRug5vjHcs9E5MrKDdddLvZpmtqJQHn81mOvTaJcwTHmZrG43G3OojplEWtcjJLuytEasJWTGSPx1zjp0st4pUqpqv8AJlpJjlNTc+Epp54usGCpPMyQB7O85y9U0pTBBRTKCLHMFlSN9b3FnvHJCk1ktxYWy3mbNFVl2HxSTkIdJ5UkSvzeYN4+YQK4nG9TWqrquc9Zd5Gds6bRuRJo3Nb5bD6jcXmlkuGcdFxStxU3kvmqaidD1bR8YOOvpIvQYs8/HKYtOTGY0ySVRVlbyWl/Ux5SjyN6kIKn7V4vWpIlSg0CBMABye2YMy9qakIysqyBMfU2J410WPKYQoo1WOFpPkayfJILfISin2rdTPjdUbe5/wCQfV4/VYPR+s8P/mek9JlD7VC5cBVZJyOWpKnK2dXVX/jFcnFP55xgyZd1HcXXZjm1G/hny63jIuNQ7mZKcvR9Wa113uHqMnuP8QxVOZc3tObP7fnam6Z9NZeb0lMDymqyYZvmGKxOhFp8rq0/9bpVgoU1EVf/ACS3c0x7X100n5Kqbw7iZAkDCkfvrwr3HrF6rJOMXHV7dw6hXwOkxxU8IMjM0nlmqxmrokarqo+zfVMG2Cd4uwXW/qBqXdx0Ok3HucZsmQr42WanHRHUy1plWLp3J0BpB0FBXNGophkOWfjnxWpCrnl/+ypV7/WgPl18dE1u67qvUhIgMEr/ALTfOzdhHPmVH/qIwPV8zFx9xt2QGvs/P7Ti9J/wh/BrxZjEeq9g9R7h6n5GOcz6j1nrSTD9PluQv7uRx5KmMuKMjBPPyz7Y4793o/cweoNw8jUxY5MhS3M+bMqO8nmdFT5+2v5Tjyek/wCEv+PfSOTVP8C9oy/58cRk9PXqPTxnD0UTcXlmzMYy+KUy5KDvKd/Evt2R9P74tM9h6iEvFrTxa00+J3srJb1J99zRsrwf6P1T1ul8TVUy/iuvViB6zhpBIcRvrs+KBp/szYdN/MOAoH8HnXWZ8UszZZOTGTllgeDk18Nsk3ZRMnNeNllbT81OdpHJB0eDMTUEVjAyU11/kiuq5rbuZ4mmh6jZ/JWOOXmqrIxupQi/ozXyaJIKnqNyz58yNV+a3PjPlual005e7RVF3Gol3KnYaSoVNQiet0yPOcQrZ3txJ1LNzdiLjfxYRH01r3cwzMuSC9VjyfUI8T9E5yB9GdMob8TQr+ar1Uz4ycEEXzQ8z8kylZZSVp5dG6dcx5Hgp2tdZZmvjZTeHJFIXGR3/lVur5k+hk80HRXYCa/1FZGZx44Zu3HjqqdGnS2U1PdUlQ3wjQRMvS16PRAAcSAR9IqB/kiw1jX80/X2MGWHEos3jWstIwABNZLfKrWOcgyFKc44h6GEUdprcH5VMcgHyGOjHvuVpqJBgqtVqryHiamdx433t/L9NsnIaAxfWdNUKxkgp0LMiVJSUsktLuhJcV4+60E76OWqGH5KZPDKMCx3+ha099BgARsYwAkbPHl6xrwGR2SYP8MQrTqLPhjGTxc2TNfsI7ZIy3kKdE1OS2agk8pvGj+IcJNIS9MZMlFEiNWg9z+5oP8AFOka8QASS/I8v0q//W7Nu5+TJItDzhQ39Q3tCRNTtHyGOPvjdDlxzZDWWq+sc5N0WArXyMyxNUc9Fb3HUEWKIdgl6d78gxbYDUwBdtDFh6YIHbfR6pxtJq5SFMZKtQjktvrfXJLQNKVLKyNMZzTjHDUX1fRNMsx2z8aX1LLNnHDjRp8TprpZOXIYshhHTEZPtcVNhKmWSrdpQN3ySM0l8U/lkwQBrIL9aNWJ+53inmP8c7HQcm9uxR/D1shUwEYBvB+u0/bTBmEvvYmVtld2noX/AHodO56Yqq3R4YuUJxTzXngMYKSov5amPtFD8mTJExl2DE/LdJkKhCXXjdDRXmisdbQvHMXGS66yVj4ToolsmYK6CZkNmTvrJeqZQrX5YxTh41W/7fHSjJ8jJHLVyTOLys1B1HNHPj7Z1VjlMKEbCSFJdmzO860p2woIyWPebDtYSb2PHJi1yTSRkY1HVj1GSbZN1VnP+M8VO5aV2YxHB9RmWosMaXlyvK3sdTVKQ2nYElJM7/LmLFbO0eZxVOOetExtJ8tba58joi3cukbfqj2r/wCh69w9k/hv8e/lP8r9Ix7j/MPasfvnsvofUlYfRej9g9ZiyZPbfXeubrFWb3D3HF6U9d6fFGTPin0WT01z/wCRmzZZ9J5Hx/8AV/hfgB0h161V16v7fRoF66kDV6QLAKdohla6On06+oD6QD6USVazJ5MkQ5ca+UY9Pjov/JLm6rLNax5F1OzDL+uhdXNSaGq6kZ3mD0+SW5bnL13lrY3PJUMcNMzGWU55gJD7yDVD1Xu/sXoPb/ccl+i9SPjIzhnN82Oqx2kBr43HLMyRG02ONU5PzVpUUy+d5GdwoTeSdTPyf1rClbAH6u9K0HTR8TT1KRUCQagDKkFXslmJxKOsHV6iKlUiPwlbKMvMFrzrWOPFI849jm30yylMi+ftCR1ug15NQCebbbjxYSKjlICpdMnj73kaNV9amVnxwanQjNVsJyYTU1GJ5hHsDWSZaJWfuqstPgHitiwxbHjLOR+SWurlxq8ksDOO5CgnHL9l58+fyKqwQgQtvSE8l9pYutVTUTUXAIaSMEAzAjcYtYJ+FIujfHV8nePq5FNZH/SjNEs/6+0mtptMEi95LCaxVxj85CSqriSSY4yO2nYXMdMhdy49ThfnLqhmYm+RJMsWc9ZFyW5PjOq5ZRl3rVFfmyxZCGPqO8Rhk0lVeRvnPI5CpL19s3hvfFS08vB1TBZAGMHBfdgLwXrQC0mzyTv9MhrxrpvSS8xA/bnHc1JKOOpjH8dZUmfEfr678/vp87X0mV+JGGhy5MMrNtmpnS0s7xEG5d7N7JlxVvnvRPz42HLUI0WXZ1TMny4Q1xzSzWnWtVNDQ072MSTJjRonHWeJ/wDXczrts+Sb+X/HjaVKF8MlbfI6tJ9VRY3A2RDO1toetWPS2UgEphMoxspiY11+D3Aj2j1vtHuPoj3T227z5PTYsuTKZPR+51inH/53obmZiXLE6y4SuMmWceSOs2LG/n1T7b/IsH8L/wCMv+PsvpvYvdP5D7r6v2H2/J7d7H6fD6j1GNqMnq4fV5c0Y0j5A6h+PLeHF8l4p69PLj+RsWUZnpwxhInEtR/v7RjykNISJvs/aJBr9/f/APxZ/NsPoP8Ai/8Ah8ZPT/8Alp6LN7Z/5WbDiymHJ7b7p63004MUlRkxl+luF3LzXzZKXHPL8t/Wz/a6fw9Y6X92gdd19MV+kVH0ESZL3QAOu74Q1Goj1en5GHi2IvIjmNeHYf51/wA/+54sHq82DB/GPYMN4s/pfY49F6jF6dsf8eD1PxzeXEV6cPknJlx1OL+2Mc93X1//ABb2z+Hf8gew+p9c+0+k9J737fjwei98xWehnHh9RHpbu82LJmzZLDNlLv0/q6rpKnDnrvjNfCfyD1Hv/wDJ/Qce3x6b+D/xNz1Xq/ffdw9JgzRkx0p6X0tF5buMGeH4PRY6KrDc3mHdPlnpf53/ABD2LF797F/x/wCo/kv8l9w9u9Dg9Z/J/dfZ/T+z+x+kwekwZYxX6j3j3L19Zv8AxT1OfPXp/S+kn0GP1E5OcOQvP8vp8fgdagfH9Kg/D/DU/C9fp10kn4aiKQSAR1a4DqB+UNscnXZ6vRX/ANSv10+llqFI9I7LG8HXiH/L/wDyT6H23N6j2X+Oe2Riz5T1GPJ6345xZMZjq8eMg9NM9bmKy9eoI+y+py4gMe/mD0/s2X3b1NZ/ePcCZy46yZJvIZM0t1rn7vGMkR+h8k4wuK/yBHRe+fzP/jnJ7p7ll9w/jP8AL82fPn9Tmcs+/ej25XJX2Mle3F0XvI58n1vNRNjhjGY1/pf5x/xVzhuv4n/LhmYwJP8AIMDEzuarIf8A1nSZpra3/SJolxW7fz9C/pwq+G+Goop+G61dfpp9VYFBJPpAbNTwTwtteL1+oOt1UerR6RNILFlB+XPpfG0a3Ho/aP436D0tY8fpcS4wxOXNOL5MwbqsuOjJO7fpOMiJH/H9dcTenz+3+21WRw04wy+Zz1BXxzWqImoVx0VJOOLmZorHHFI0zJ/Kv+NcpkyYf4//AC9LzY8sxfvnp+sENat6j2t6L5ZKGWqikuegjR+u/lH8P8Ti9o92g5D5L909TReLc6nIf+Lj6tCvkuarFxjDST0dVPV6hM9Hrio/iJR2i9hH66kilAirpIFEAm8WjF8y5GqPuUelzSkZCiKob2a4iqOLxVkmvi1U6mWS63JH6p4TN8nyUcVNfNrtyUOtsnRI5Jw+BraLNnyGta3fq/X/AMXzTqf/ADp3l+TU5slRGK/sy9YdyGluGah5r/KMn5rcuP8AjGWuv/O9Z3UIz80RE1VzqnJeKG075KrvLNTTzUnE9NFRiKwk2JECJe+B6hrmrVVjSCOR+Z9pe50rJ6Wc8T8mKM80TB/SoT7E5Pkm2yufFZNeJyFgD+ar1H8exVu/TtYrFxkUOTGXuniCftLKGitkbDXnzYye1+19y4fcfW115Zn1Xp1nGrxDSf7+pM6DI23GiiYr/wD0rOqnB7n68JKsQhncokp8lCniqoWOemPD9dwcAoQC2WBzeTjbWNQI2xkEIDGfH3etTn9D6j0WjLNFsTRlA4bf+5cATqdv2WuR6l1wUs1eqfpXqPkx/wDvg6K6lBZp11VMuuWzfKKq66N9J67QV6vJl5sH5joyVJ5ESu+9TvJdednU6afxfqfRZ8n0uMBUTuiZcPQbKnr9X3vb9QdKHRsoEAtmFwZRavjmIwHHpqqIRJn6RJQl/R+/OfJVz58cUQ8Vqg0uScnlePIfX/7Wz6j+F6f/AMaH/J6X5anJETNc8yE6eIPjUlmgd8xQbPqSV/WYr9Pm+Pv/AB13XIbJ12EHFoiBJ0+dfUmdv4GvWROPLXp8pj4x5CuMnPxQgqUV1Nw7aoFkNux/LSIyF8oYgqmDsL3YPc6mxFrW7Ix2v2FtbL1Hq/R1M1/49czzE461IXsqeZbIGBCE89f1x14r8T7Z6aPW+44cG5MWHK+pslJYxS7ZWm/NaMchqXYfuh/KWX1ePLJJiiPEG8codzKS1OsjqnkWuWf1r6SPb/x30vp8eDJmw2vqsoz6lYiD05xOSMMzR0b3ay+buXWpJv8AI61X9vpkoOWR2ABTODYH5sa0pkgdkANlm9xsuBfVn1Px1Nwp05dSMMg7eZukTnryeD7FE65KdZm7g1G7rknYFswyad3QVUv+zY9AhpHa+qqZnazrqC2ZXdjvv+/iyd9Kl6/qXrf5qfUco312K6OvFwy0R1M/XX+5lnW/H7/MOgSaZObGxMX5vOfOnW3zl2gpLYKMHtqnWSZkCxHmC5n7K+ceS21eaf8Avz1uQZGRa8YZ8hRPlyFPiaiaNY2qHqutn0k8bNxSP4feRrzeKMcRv46ls+SQZuZtKY6p4udVrriJbK/JVJ3kmaq6r7xU6oyyVOOu2ma+rtHe/wB7Vr8/TQiXiwMO4g3mDeSlxrr7AgCB2CM7c2YwxCGZrPQEqbRpWWn49YkrbR06mJIKTgTXX5sRn45OzEziLbZ+9VLSTvJy62hNEhfPxFTZ20ftXdo9dltctLiWdtW+eQmfjoPO0AqeRtLUwzp4nGiOisQ+O6pq1eYErxZoobF/GID9j7XTji6B7Gwgzu/CWQfGPy0TTiBxQVdZVYNUE8zTLeLXOHeuhaNPieQYr8l5ctZYZzY7amh6gYZqZibGpiutzMiUTy6/vTMaaqjG991j1QqdpUE+Y1j7Hf1F2/VOfxcuT5bsKu6vjfNbmmhmpuv/ALGGp1/p8ctLP4iYD7LZJYvH15WoMEYcD8sDtGCoF2ZN5Kip/tGq13K3C9UTj/X7+MrH++q8rNTxZ6HF0SBLiDzj5tnXMxjVqXIUPJts8HMsrVxGK8jj1RXyNf5CJmtcHx96epcjySH/ANUCcysmMayu9TC3DVc65+NcQfGNYjaUR+2SdH6AEmRkDl+Nk2ETl7sF8AgAHItK7YTV1bWZKrYVhZIuJZisgNbd1phqY/ZNCAmk8IOq4+HvIZJqshtCd/KzMT9me0aV+T+zIy6ZEy6+XneXJA8pvJR1LT0U11ktZNgRzcmt9/eQuucbFzo2GO4CmzwYyqp3XStFkiu+juRoIvbK2cOItgbB6LE5Ci2Ac7gyjtOQCxU/N+ipyDdTTKHVmObwVBEtm/o70Ls26EMtBhyTUkRisiHmYciMRM0d+C5aJqDdmpf/AKqlj8rRNVFd1VHbMXMy1cw6Wjw7kMRoooKJtPLHUzPUzkaj41ReUQnJeTeq8qDA0pNIk2D+UgSYXtH08AG8jQze+N8bNbIEwCFJGs9OY7jpmoZfk88VRk5mjFxpaxrToPLqvGwplyRROSCWe4nXx1uFsabg3eOvv9badG6JY8MYd4+pxnS5AxbOCMnBonJPIzNf1CXyfXmjlmWZFnX+W3vcWs0/d7Z5MkxqaKD6q6nXb+FCQB8sZCl5CA7Z20w8IskG+1JQsAMv7W06oxbGa4p5yK3H2l+9Y9Tro2fWdsf2N6U/AMeMPmx4nu9F8rGPJNBzlDv6tZJ+qjPQSeCX8Cy3F8src9MZTri4nU20QSsk+ZAfj1XQE34zEzlqJdC4xaTmUjSY1oqlydY5+sztnleub/D1AmAC+3H3GCx3BOquUfHdfY3jFtQZr7yxIrLfS9YxPEEk+Zqjbxs1QVqVl/GF4uZvIVJ8c/eudtVW9NdGhWicgdD0almX8yusaVEldUVOh1ju9J/kOBmefHI15/qr5jH9u+t7MtUXUxHVGn4q7XcvaCSw+RetP4x6n7X5Qtx7R20hff8Ag3uiuPGmtbmznTikmp3wbPr8tVWrpm6nr67KBqa8P4qXjK5SSvmAqOvA2zqe55kog6D7K10PxqDsgsxLmaayTW9zz5mdY8uQ4rmWQmfK4/tvr9JYL8daxnOpMp5g4Xk1rifAf721reyqaaIvsO87pPntqjJdlwjcXvvecxptMTh4uee/+sTwzV40etVyxEpPCtsmo0h0UhxNY9ZQxEuvJLooqrGq+XUnQ6m0KQmtg8ly9HxVjuUrUTGWoT7XORaO/kCf6mQ1Bqk2usmPGFzVTV5J+mzT3NfS7jUGNrf183GqNIslWuAQb8AGBMPlDzpsXURB7M3vvhoXejY5POepbqc02lfUvwFVxqanWyYJm/60hW5XdY0xH3+tRNZSSba8tFivhdfJWpqthquI/Ij5WnU/0skqpt5876Kd6mEXYcnRPGyqTy+m2GtO/wDIbqPtKjX2NrtPrL+yvGv9P8UgN+kcSvFiP9aJP0kePyLEBX3YfDJJXZjaqKlpg/x1yEeIYf8AWp3rVc1UtGjueiYmTqBVOJjJimXdaWqSzit6kyGp/wCvyK6rHk1zuWrHrf8AjyKxNY5p3f8AkrxonyTz5oLYgeltZjGVEY6b23udK8KGv67onUUWb2kn/tB3jdKWIjH00nYbjHYA2sgxE2jezjpL6x6Or5mKLZxt8s2UhxjWaCdV41sXmWKrmrmjr/PyXUJwhMg5E5cYL9scrjRSZd/i/kzOXeSWNf4y5/Tc/H96bVorn+0kNGpApqmx83TJMSY5x8VuEhzQfSsY3zV7p01yVqxEjr8G7CeXKI/nqMjjFOD9y3cWi4s5L0M+MczXK9ElTNPbeM1laNcpuvsBRvwCP5VbyZHIEP02V5rHd5Cibv7JSE2Fa5ZpkXTL+MnJlRITN1kiWUOp240Y+8kVj/WiaxdJZ9qRZzkqVmplmqM08uO8pFbrJP8AZq0ZitUdS5JueKK/BEkAIC6EtLx9JuZ0rlC3vYokhIvCBmd9RjxJkperxGTyKz/hdFTW5Nw1JjORk5dVpT8a4MD05AnWQuVYDkZP1Uy81SB+ujUeLmX8zNlnE423G1M6+prH4mfix0iO7qUavUpLXLs2muvUkXnox4tbxydfa9xtoZ7YqZ1yUNEcn6d60+mmE9h+eVfnaNOCPSkHvaz33+7Wm65+oRfXNwdNMGTXO8nUhMIHx0KDKTsRCpkaNBGO+e6du8bj1OT+zejfaMlGzaJX5huqnq9MwdzWS9X/AOO/1vo11aBpr+khvvWgyfGVjqbqbY3eOeZx8bq5w2FY7aeQlo/6O6+y/kkm+YuuADz9zocbJflsgkdxwIGpqsOR3WGjecna1JNJqp1k1zjUf6vWjTE1E1+DlnIfbySZpxypVGp64d1P+jUzQAxFxR/afwprKzsmaq+ZxzMGmknWamXJMf661CvjYNeHxlogxVHdRfHVTuvkdOqbT5JKborQzRIGx6giRJ4T4v2BM76kTD2AB8RjgH6FBagqgviPm6tj7a3ju+GWsk5LmeKlGSPj8mTSUqjqya5i43lcbkRLN0D1V+aJo1VSEysynh/JrNePmsbW+vizZCLk6rIUNg/HQzvqnRLvmd/1PPmyzJREfFkSP8XWjpQqSa1uIEKtPow732g4coKGckufsQfo9ImRsExfaxFkTBJid9V813hy/LjmpLpxZCqpx6q3T1rWgH7V1xTOipLlPDE9VN5GCmb+zhZsU5w2bNsq/Xya3jhnqdhVbJk5Nzjx1dQnOSq21W6dJzfVhVFlHha/GRBV3f8AtYztWYwr9Hwn9ixE5md78/YqhZEFYc/7Q2B7TvoBXaNsfnaM3hA6d1rs0GpymnUdT0+Iit6tplKiS9fTjfL+BjxYsQ9ZCU/zQqVlJfE4r0aOA21wyvQqhrMkz6jHTJWOopu53qzJI1XZ9rrEqT/ZfHNaNV+JSnHFTkWjHOpftXIrrV49hskF+tY99vWz80InEWNxKOZey/bVHdJI4t8thk7q1mtFmnH8pknJI2U5JlWE3OSTrEzPnVTzctHNMp0Mqoi6mF0bmiiSY4omQdjSvRvk08kuqmahgJkYnnJNjmbojeN8czNzbN5JYOYf8Z8kuznX5mPHWP5GhayZMkTdBTM2mmrPrOPWv1O9XvX7TMh2CEkjsRYw7NW5xqLncEWXYEDyDBYwEY0Oarfj5Dk4LmD4m5NRkpga6jXJf63vqvBtdz8k/ucKURzVsiHimezoVoPiXp8w/bWl+on5KxT1K48M5PEjFzLt6rfd3XUm/wBVzW9UaZmKytVmvmCpqZ3zRj/x6ZLRnFXjdSuW6l5VPwzZ+e3giID7zp7oDEYTp3+xexV9NxLP3xDHVN3PQDhp1WoklYZn97llWZ+rr8Y5flWXWKetDrnHXP0YOyr1W62p+p+J++KVRCwSpXPxmv3cmOmiMjXyamsYhL4Zh2LYT+D6j5KjDUG/kJn6f0V8zV29V19X5BDxwNIX+VKOeOygWQuEf9jOFhC5uLBnbOEoC1NYJclZsTMy49WfTxTzXM6FXXDFVokAfpYGSZApKK077r+8zMiUF8lV1KM88ttK9dNKxZckZslOVpRsmtzJ4nc1okoL38Z9V+9VUlJ+Tlc/j/vf1f8A6k3XPU1k2ruZKCdfJO90mn8VPp9I/EGQFglhy4ltaKQLuYKxgTj2x7aN2IydF3NUOgx9s1F3kx0zJPNbPMQffXP2BM519o5rkwNM8DlNEvyVU1vzr5J0nOq+w2xLvYhlLvmHl1jGdRVUMjjxaolidTpqDc8orVE6ngWcd5JOayZfN7pulC0kvJoftwbmNCqKDBvixsAA7veUwjtoJgRxmLb8wpR0fWbusmSRkv46l39prkbiFHrZe8q+Ov6echNirGRqPqx8ZHJVikeWmjVjWiWnUP1eaNJrdYpx9TjvMTh6f9zWqbyZEoejZVb1QVR5RJyxOMiceaT6yXE7mcs49ulNjkrmajnnJssSAPwlIW+WeYgK64XfeWZja28SIFvCtM6mst4uDCI7nHeSpsHM15ve2WgHd/6dSRUn1RntlSD60wwlV9KrYHyfb6Ry7Q2K0Jy9MumMWO0D6ximUh78CZAXePVGpq67/dSOtgTWW6nev6J/TqBZj7YzplpaVtqdx58LP4p4wu2CICDy9npFx44hhnwGb7CY0ztwQDwjUc1IdSUST1lKNc8JpN/q9XRk2snHlar7Tq2+shjvp0Vx/rpevOlm5PjF8c4ZmpqPvNPUXVy8ZMkEwc7a1TdearHLKVB8fONpeH6d4x746ZquouZGWe6rymz6BI9xUyFH46voIHFsSwl7m2nAASMP24sRbE240tzTlqkSKTlKx/HuqOXJqpydA1/vSnXQhL+E4smPFNzkMyRJkeutGhmm/wCpw/WYvHJ5l1zfhZN1vfxHHW5+RirnGfa7nLKc5DgOU6lVDXVFGMd1jdTSZOS5X4vG4TxzrRTjkdbfv5CYzaALiFICzt/J1KOxAhFiPwsW4cRh7zrDOTIXNU2TA3I1OXLq5LrqZJipp+p/j8qz4BlGP4pth3DEKFQGTc/3yK0jt6qfO58myfwJuZm6r/H9qkyUVVhuITI2FMzt5ohrXi5KNrLyz8HU8nMGLXx0f5NL2T+nSPWSnc0UP6QIAKhllh2k3zgofuhZuw5JnchHiMZWh4u2Ql2gljLjrDErOOld3VcD4JnJvk+8y/gfbHVMDuqEkaGDIAf5NTPx9ywfXlR0LW6zHVc/1ckwfHklSsmPxPST0dY/GQJQ+3+xN/hXTfnXiax4fpJJZj3v+vVzSalr6jK9g7RXEQYc7Y+h4m2NFRBkkwZIiyxsSA1AGQDqCMcdmORaapls6J+nJuUOpfqFbndaNRk5VVNuZicSze7mmYKmjJPcTc9S3CCY2f8AsceR2VyA81ro+R1R4x+BwvMgyTo4/T5jonaDBhnvJUaGmEOEjI86A3i555Suzcm9bMcjKBIAC5aX6eYhBayqE2K+VAIEC7SgwQGAAAYDA07GTxZ8gPTdVf1t8T1jFAyRLX2J48061WuKsY8XOvjqZ6mXqt62cvRUy/BVRQeN/uWq1qG3kQnHIYh5w3kYqQpIAVKl8bnJbO3WgWqqWAIU8d8/F4mdNbOb6pqemh/b01Dr/wCfxgMwA4R5gwavFrMbrQPwimLtiSYGTGE0hBAxoLqebHUk42HjR1UDJogpqCb/AHj0v6RDyV3xiw01j1U45HTVf6sun9/IHlTz5GjhdjUYY4ajz3OWl532z4cmTxM4u+lhKQ2/0TlNSJzjyalTN8VpWMDbWKA1+58chDrp6FfyKvxFshJvLpRk3V+AHE6qv1bskAzLsh3gGQCIb06TDVIlFmRqe6krJz9SIr/7JG6NzyjtJUPM2mB2ynyJtCpIps4mr+vWPWPcsx4C/ECiq5c1SV1cdRRzTE73JTO1rTLAMyEoAdaSxmpnHKzvZMjxeihJx5u12NoretvmgZ/UAuIGXdWNgkbSCQBrMOShBxh+mAAvmNVsQwJ1mJxGysV6csz1NFNAE8VVcjIKzUbdHJu9dMuuh1OuamKClK1W5oL1qQOIsk5fsE+Rp6zGTUJc1llnIqmPtEvYQQiM1JDEqO9lBcpz2m73omv/AKhyRCl5FyDVb0aDoyHijf7mTCi3OAPVDvkPe86l1ELF5gyRSHE3i6WwWm4jGxd6vTlcY7kd1L/iNnHE0KsU1vZMchqxhypjqPFM5CZftThip3zVtBzM1rTLqkykIpScedh+OyOKrqUnxhXmSavUyTFNavGf2jud0V+SyPqH7ZP8pRe8hBS65Bn61tOB1uchRCKEZ1AfKpcEd072uYVxGtKYpp2cgiFDBeC5JsQwfStWZNb+PdS5m6mYGgZLXcrGSoAURMZ/k0HMuzwmLJMffw43HzV1NbCHSaXHorUyKf62wGtNE1itx4qOKpqo1XES6kE5ZKnybmPBXX++ZvkamPjqhqBOOYKgXTvHs63JWvr0ta8bDk6giRFpnAC9/wBO1AgNiwRCtI/aIAAG2ttjYg25IFgqUx46WiWJNSFdsJ8m/LNA6fF7L0l1zsJ/senrRXRm1uslRNFS/b6ZfFG1mNTX5z0gZYQ83NN4ywibkxuMCK8jUnOOlyVQ7uio/N3goxkXRSXA5ChsxuWqTJNTUgwBxvdE74WUPzyetT6gSIWSiiFm5UQNu+taTAtECAzYzwkHb310uLNVXJy8q4F3x8mUWDsUWea5KGKq9D+rPzo/ZM/der9uzfT03uWL/wASuISK9Vjmb9LS08M/MVFUHdORxk47my+PhV5b+J8X1NTJeOWpqbybqqrIMhvmU3NuNkuNrgy3gics39sNwxl5zVZJUuGu9qGIh7tZ+i+MlND5XWpmq2JAVkQQIn3tgjWgPpLJKy8hCM4JZwFZ65H372/4MnqMLCXjyZrmoaZdUzMMNVcaZovQHUEUDM1+cT6nJ/8AWXqdjJjwk2LU3qCQGSVkN/a1l3BFfaaX3P8AkuA9bjw+vxSVPrMLmoyTI48xjqc0RrQVGSHnE20dGTQU1PjvuWD4vk55yVkmvoxNU3fVS5CEAE4Nvhep8ZEmqajV0a8emg2dwLcLjI76y6nTVYqAipBknJGSbhpzN8jX3V/ykT6T/j/+D+hKG/S/wf8Ai7kMpEnGP2f0lx6dlxTl6xdkXjqXqMfnIXj3+fEeL1V+k9yvOpxilvXJkWLyTseSdNdb019NOlGh+8f+e/m9H7F/H/bchjx36b+L+wekyY/h9RB6EPavRlYsXaROH/DYUwtVSGOceNvJ8E+ow9T7qkt0YhDemKv1WP6zdAePGp+tFMBQefzwP/Tx9fwtZp+Y1dXqFoyDUTtOfuddHxkVUbiikygkBde0gXga79ty4MWTGRU5XXUyFuR+56mv8m8dcVP+RBfGpuZ86/LgjG0xiarNTJd0blyaZlqEiYNU15q+uaQjUTqPZPcb5PR5miOuYtt514lw/ZlyQtU6iJ3qtE5Ny7jPk7niSZAMPnoJzT1rLyuQmfFpdTuvOg1qvdFJpIJtYWyBKS777b401CoAhPvgoz6st2WY1p/VsXePEppyEXUx9BxoDeR6bmy9VoKeeakoNVPVGH4yMotTxjGDiJ8PxtVXlit12QdPx7J6Gm5mMk1V3cZexiNYzeOcmqmnJrHzTRXyLtXdm2tGtz2kzryIRkbx7DOv0ydrprRusg78hx489nSPaCN5XbyF2HbCuxz6trYt/wCRg+oqLbVs04/rjd0uRuK2UAaPN1/9hN+KmZNzzOmZSnlyVzOIipmfjw1kG5195+ruhdVF7tmUquvL1X5tjcNUO747qmds74ydFQ6nGb8T9t/UZfJNa/TFZGvPfP8A5HX/AFfD9K1CEr/WZKlWpi9onf0y9gkCBsSGt/bBE6g0ghtQIYUIRmymHNtUbnLk5eNM3jgJkYujuXcy3TWx8a4uE6n9qFGMv74dzQN5McEc5CiRKVCSrGaDsuTmvkJ3ayvxRNXRWTJMzE+aYp4mN21HxglpKF63VNb+oM1lxYqqdXjqZ+OQxuSsYtulprqteJ3tl7HU5HZh4hNjxcWVsagUhvsUfDe4GTEhBajH3K7i5fk1z01PDbRd0Ov+taSWZmvOxd27rivvM1/9ilmKScijNiZBC3zsW/FVJ1IIenU9RahTMeaqK1RPx9SboayF7KdjS/ZNPTp9PfOb5skXjMv+Dcs5ZmXcTrwmOhdWS1FRVla6SfXj8MmOIF7kD/tJUgb6ukfK04kMvHpOAsIsb30zFUXVQvVVdY93joW2njL1quInVSWHUSPjc7/L2PHlyXdseDHccaOrskazTOSpPvDQ5EOVMZJX3mPT4qq8xeCJajJPQbySHDkyaanqbomW07foa3HTcjDWvpVZGfJxddfCTO4cuw7mfqzM10UiPk/OXq9U/wDK6JvPeYkIbBKdaUDIBwS+1O7Pn2mNWYmKxmtZLcU4nz1QVSO5S95JkPrGv7Ck+de1fzP/AJY/5O/5c9N/Gf456r1Wb1Nfxv8Ai3tn8b9D6D0Of4cPqfTfxr209B6T1vqMObqazx7Z6cj1WYqMfOCYIxzWq8fj05kmMZLjyExWp3EjDUvMLVLQHgNb6ifP59G/8Ve1/wAL/iXt3q/55/M/dPSYvU+6ek9y9o/ins3p4x+6+4S1lxek9y9+9x9DGXD6j0Z6fFWT0/s+X5/lzZcPrLfS5PS4TPXzv9Tr+Hooo+J6nw4+I6/w9VQ+Fp9PrrFfUVKpABQqC9VTAFI310dMH8IPppqAckW3FmIyi8M6+PPWep9zw58mDJXqKrFkrBUtFPywfbHBJ0x14QN68878/nWe2xmweknF6lPmqDJ9t5E+Sd4v8rpgjx3/ANoGsu/7hS/lfrPaj+Xe6+v9F6j1HrPbq919RmwZvV+kqPUZ8dWLeSMbEY6kv5NzKa3U1Uxp20eouscZZH4skTEDEDNZIKMn9kxdb3tGdb+MuJH89Gjqk0UVen0+ukGqklemAUkwfJEKRrnpmuoD5lUgWIEI4MoWtsdIrKr1eJybWGoxNdZtldKtO03XzSCBsl5K/FpYwkzPyTJVn+Vnt2ZehmIifM/U2NVyany2bJz0f5Pjy5Kmm61M5xliq3Xxs6WtRv7fJrnpx03LDEd3LYLGwGpLf8VVZvFUjNMwhs0k8p1XqF2rQIVoNp8KwetTTdkIKM2BnZRsNIu7xxIE9c4xxxBc5Y+9Vku4UmXGUW73RfdvxTQX4xYc0TbHlwzQHBkxpN6jnSE0fp6PrMpkmjc1sfpzFReOQDHrtxzbkGh1NT1O7OWTb/jtnfxrH4/FeTJBjyVBLU/HS/vHGPZjpNeBqXi8fHkKJoRwrWZieICbCEzi521XEoySERTYO5nxxGd36O7xk0zsyuxCP8c1oigm5fkgDoRARd7ett8uK5xzU0kOEqsfE44m+6r5LaqX5PBkqVok/wC1EM856V9Pz1xZlMr1F8R43O8JPPmO6CmuKaP1PMa2GD1XxfL1VVHy1jgC34+tE33uJMQFzHA8hbMtdS+d1emySIYgPARzbAChm+rpDhtNsiRHKdktvbscXqLSJDkiJMrQ1ksxWf8Ar3/7GNH3mZZ+ohW9/YH/ABL/AMy/wL+A/wAJ9tn3r0eT37+VY/V+6+l9t9kw+35azTkv3DH6v0eWMhThcuaLuy8sZvj+EawXrHh9R8TT6iamZu6HHcw2ambqWRmsjX2+SKpKkdr9tOk9a/4g9txe8fzQz1gMteze0+o9XhjU5Oc/qM0ekljGkzknF/5GTnJqcmPJEs0klfng/wBS+G6HX+HP/uRV/b6dX9xUVeg1IIBgQCwCpL21v8NXVR1B6BS6h6QVa0zdhEPsc66P/kz+Uf8AK3/J9+tOfWfxz2b1ea4PbYyeqvNjckxUYvU+qrFvHimdFem9NHpvTQQB6MvVmt9v/i9/8T/8A+9X6u2Pfv8Ak3+SxkyxlxeoxuT+O/xrHfp/RdxVay4/Ve5+s9zzwlzizGDHUox0/cHpv457fGCHL7N8npmsUZskxlbyW5buvWT6Sz4qCTJJ6i8pOHJIVkowr+fD3/0Vn87ze7e+eh9mxs+m9u9l9Jj9J6T2+MXMenj0xeLE5ME0kZbnvLnHRTZeryXlr84P6Z8R0vjut0PgPhfh6Oj8P0qqer1fSj6h0yDSKi5PrUna+unr9P0UV9fqGqqtekOACbYAG37a+KvcMjm9dmpHr5LIXc8jYSq1uS3or680yHJqi2+g9uPUZbGomhtyNOmwY3BNSQ3ymidba1KXWzX5/VfL6i7qHv8AfH1Xc0VXyd1W0Rnap41VbJTeez+ojNm5u+mqchYhJPM1eGqbehnQROpuvqg3L+foAp9FCpAAFkjFx9GPEW14PpFRZC+a9/8AiFlh8zGu39m9F6XDP/1x6ecpj1pMO5nTjktx1RdlaqdjNVWg1cjSvcvS4/VGSZjHDNu8KndoXN7x0XoqqCAsiXZXHJ+X8eeLoOed/SriahrJSstAzczzSShNBBTGoNxncemspRNLPwt136j1H0Zeb+OjDXDupopCiiman8yZiqX7JmmNt4/XXSh6UAV7Fw2crb/WuC9b6bF6aeTG1koIv6Y7qBF+ZyFzEgb00lTCrKP5zfrvTY6xlfXcscUTKEuxm6JrjxqsmokOdJ3M1+dn67J8FRGHISWTuuWSKbbkqhZXQEj1E+QmJNfnNeqQh8RXV8FciE1/W8l9aE0h9VP2xto/CkwhsjMWEGwjdiY1zV0BwJt9kPEjEqMa5X1Ho/rVSBRJQCcuPp2K/ZpU2J996E12Ia9Vh/8AVkyE1M48nF3OOdv1umdjWoCioduyhhNbzLGR6eulvoqeZKh8cFynitnMSTuK1re9UqvLDTIH3507sKpHbvU1jE+qlGiuTxt2TBikY4lc3KidrayNOBFgFswQduJOdUsfuHq8DvHnyRuwBo4kQYBI4aEf7eX7TWpZksPvnrN2NP1KrtVorZuVeJZ8GtS8r4nxW6PqN4lHBGTuhKnyvWk6uaGU5XZG4CLNM+KKXk34CoqgHya1/T9tfu+QZBJmeQ+34iACAPyKy+JM9oWRkQH38J+bNP8APf8ApM/p/SYX3H1JHqM/qavH6X03xlVEtK5tJOrq0mLrZJ9yb2SZHvXqqy0sGPFuoqf8myWy7x92zqefDaalJ1PJY6K82VyY7R5wOPFM8AT8fia4aCQO3rRRX/W+Udvkx1m9J6f1F45hyZD6ziqZyMiTk+lP2bK13veKnrZtGRYkAxMwLb2SOPotIsAABwHFjG5zvmO2h91IxZvT5zFMx6mcOQxJLql3euOdUPXlVC9i88nRfxjPZm90x1Uh8OO1BCbLuZ5YQqkfr/tDJt/U1z3r6vL6vB6bFjKyYsODEYsWLdXklmkxiC5GvMoIA6WSQ7D2j0Gf0GHI56mPV+oiHJG4PjwRGpxJpKzNjVwUwskr0b/M+vXQOkj+NAAMCQu0AZC1VIILphLtJA/iXvo/UTL8jkyVkuurhHG6jSSHiWbX7ugTno4t2abJbEbULZ+IoHnlnxZkEgDX/sQmuaqZ0Vvc5JWMvN6rd0VStcxvUs1H2x2kGt6pq9rsXTizimctRTTppCkKD63Wg5hl+TqRiXYJt/Mul+G0uLHb3f56dUpku5sbgW/kq+9OJwTqmfDPUc82+fGPE8BU6dMsfedCKRCBkocVR24n5Ilv7TORAgNU/SUUa5+/NRPLz+Z1ij7O6upJ1RK47vQPUJEyctaJHe6JBJY3FDvcuP8ARRJXWPQFtpVza0Cp0/T6pO/04WAtiE8dh3XD11MAekxaBwAL34E4FwDpuOHDNGKV7dydUfG0+N0IcbiepJZdgnQ9VHFdbWXfyeVQ6eo5xDUn9d6x/Hrroxj3Xa9u91S/IKT4G+IvyLW9DNFNaJkWrqb+/YZKx1LtuSWYh01ZkA+tUVVSq/cDXMf6RQYaVna34gx/PbGrDIIQCnG48PlSudTvFPm/8l3qKOX634Zvu3VFUdVZusnNWamhYCaai6VMuytumepKLqjzC19WD/bITXW3STFTXMuT45htOparmoyOWnXdAlV8fglDe/qPc5MlTclNdfbxuar6sV14Y76ZZPtQ/XZtRB4mEPszflNWtqfThgyh2g3QsfGDvpnxTC/5IkXudVPg1X1qojxjQjl3pKl3t3E3l3WOZPETVU7ZM1kSTjad1lLNh+vk6RaeelYY4PUz8lOOTJw31SH1RidSGjU2z9d9MxNWP4k1WLrn6xe5+6UMR9pSxoh1yT/+Lo/fKwwBbxBvlDvC0C21neOYbELtm6s/+RcH2w/1TDBrJuR87DpA6l5tZYkFhZqbHLqoMnO3UwmgudfbzwPxVAprbLHV7rWpRVMRv5Iaysx3XVXiMn1PkvJ4hjnVdY2iq60syfjmslFQ7jHjhkOP7ZImZ7qKaqjd7OQpo8hVdIKhUwYyHPKPaxsZgzLEsEgRnbPNt85MaKJyV1usdimd28tY3w4/k+vX08VCI147mmiZyU3OmKxz3GPXllyjczL8i0S75EnGunG/HUdWuMnQr9SZcbH2kKOVuY+y61/bYzt2LO/wYy5crQY7moVq9rvJMgwORGt/rZzWUOXlksB6aUCZ7NmDZWltogEW0A0gAmSURHqlANKE0BaOw0WXLkLkvF9Y4xzyZDWSGZm1rJJz++cupQjutVNTU1eZriyOJgaD+l3j15ovxlbG+ajkqhl0rKOSapixW4+Imhd8qNmShpaJ5Vp4TRkESvxtQrGS56pCShnFH6Gb6OqlaOaKVs/b5UPmLRkKxTUBk72XIgmwz6jsreArsi+0bpJZblJAmHvEfaOIyWym932kpscdE9ao/cS/jyqxtG5tp5En744yfqe3ghiprUP6/Z9l/IH4cUzQX1zrJzVXjpJJbvcFE8vJteQY8yrmnLVIL9rGyh+WaCmtXOtE7OoAXnXP2/ECld7T+6bNraBKJEIEruIiRzi2mXeDmibUupX6Phpmvkq6WejnKUwLBtFJk/Aujjakk8YqJGW2Wfu1ps2dbs1Xillma/JxeohiWeTnH8dTyf8A1UncRrpr7mlZyb6l+u6/MhMmM0J9K+XZJWS01WSopF+ts0mqE+P6mt2zVsSsETYSvvYkDbVAuXK3yhcjg3MEqY1lONCXJz1EZnGjeub6+KLkvHQypHIUE1ZUh4gibNUsG5yz9n/1JP8AjNxsEBYNSysf/Vc18V3FLHOO5indY5MivHXEVqaKWeekAlkCfrJvyyR3blirxqnX0Nxru/0E1Nbxk68mh0v5Vp9gBYm3JYKlOM6tQHAV1wCSxBgyCnYzqzk+HLixGUYyTpiuYDKzARbN18nVNkWKKfXoykX+VLn45jdH3mCnfyfd8zkq2fDMx5up6YNz9VZffllchWQ+Mmg1CIsren+3kWg+TT1pJSJmasitsO2mzbFaxz3DTHiWtEyMzUj+yldRcQIAF0RExYv+I6oSSCQChIaw1zb6dtBd5JyRHxHTqTJVXMeKme8jU/HUq/2vkpBqNhKypYmKNCY/ttg3M7aySz9ig1EeNyblfq6RlZvWsjHx2OyqFVC6rD1O5rZqYrymmX6/jIzSlIWXOPl28VueT9XVGRUeItg1CJqZSQTY5U90hGe85calyiVs7z6SkEX5O7uBFS44w5BjIXExKLzNKpvKASwB30Nvn/qjORmyz1vGeMpDkR+T5Hk6qmsayULvXO6mQvVCEvJ8RV1C/IpXkxsmyUGIyeJOGeekyfWk/J5xZdt/XHin72stXkx0BFRkWzr5Jm9K0z4+87EzC4FQwLd1xZLfUMDvmJxwUmbSLnbR8TT/AOypPlObrjbPQaK/2uwx8nNb5nW5fx/yVHlxFBafbHXXdVLGRqbN/YfvS5NFfWqmilMiQ8v1iMkf5Iot618ZX9joZDHOjYG9zucu8ZMxG7zMT8lVLzNDKW5Kqd5P3MyA7jQanf5eGyxfaAGo/KCCVfVDvOwBXbcF7CJWl+oKmob1c5bGH5I5mslb4dTIHJt1qprWlinmzGbJs4x/1Iw+OpCvIXI5AD66q+TyeZSX8RVVkxY9ZKli4amtGSlEuueaH6BKgU6uKBlobNka60TxWNfj6NEb+XmVrzB/be3fUyldUUlVFbbzYZnBg+2qiJDL4sLxYIEA/qWv1JkQnlCn4htqkv8A/C9UVIa1/kdAbNHmixEXGHHj05PGJA2tLMpxm2VPNTyGg0gR+j8rTdZaoncfHxFmo67lmnKzkWuJ7T+x9frRueqIpylF7+TDlIpf8c1EaGsJRTNFbrQQZBodcfjaO7EHzCX5YvogEZYfv4Bc2VkbJnVXQtSvN80xuBEovJVLVa8D3oPr9p2GoyNUR8bLWsakMdOPbz3b9jK1UzVTIverXa/g1Z1cQjWPHrJXJNVz8f0PlEvJTstCdTNb/UP5Ejlq5mqi8bOTbUjYc9+ngkrzN+Kx+DXUO99CNX7AFYE2V/BsWRqKibgCZAPNztCQEDstFj4wmY8TNssDXL93GS6GYYxss9S+d7jX1aZI5tdR+pWgmT5KkqWqHum6EqEHrQeaBEZrPps1JUYnmOJbxoS0onx0bH97Twf43p3pZZUs68sY7Or+sg9dqbmWKWj78v668CDNQpSpCxz9TO95FlpCSmI2nlIOQ5fKstLW3uqOab4qvstXqd5DHafWLhrpakRjX0ra8V4qq4behclNTo2aTGjttilWccss98s7/HeoyLBMcxtnFdE1E0Uzpr9+FivkyVPj9TtaRJAWVE/bOXvGExBdcnyRUviklmGir1FSlbdMn5vSPwi737i4DvtcHVosbA8XHAY8m1jp3+FNsAEMV9YibPql499PaPjzKeXlKUCDDi+XIwvyOQjzvNC6olIZIkiWtC1t3jr6zjJiLyS6yKd7mS5nLwx99bJXHKgTH6RmdQbFY6qs0YcjoibsHH9MtwmOHV1NLSeEJaqvjeUjqSUkLpfT3V9xh20W7e0YvMXGQkIIVzPWLJMdxNgFtlM41md+aaXJ2Nd0B4mikD8r3NKW1rrHMSHcTjafpGyj/Hqdbpq7R34pPw7bjG5KeQxk8s2zTp0zHnjRtERkm1JDapoqMa7gqYftQ90VLzlK3UdFUEqtEyaAmkqqB+XNJZ+gxbcE+x0VFoGUmrKLL9gTN7TEzg3GHJve8l49y8BON6iijHt1qZ4df7K6X8jJfHWTHF3Dty/fkGmUyTz2VzJqu55K5FZvliMurqp0aplKNuNsN1I/HqI54A/qdTwbdwZHdUT3rIi0VNj4Xa/H/jGa06+q/pJuWbhWwCcEr+cmynWfqsRuPDsGMqRGIV9OJmqi8kOZ3HKVNE1dlzEsoEB/be9aKB0aivUNGqm4cVxInYH1pC7oHkd8uiOZ1WmB/M/xgXlvUuFZnnuikbDUMmOgV8Nc4m8gaqfyKvkijJHdTMSkTU4+g4rJlA+/1syFy1eudMaRkEBOOfvxwOICOmAYU2JfKcRd3tm2mTkiJNP2qi5NxS9CmL5P0RuJ4+R876N0kCLrr+p801TiDqkjrzE9RLzz1W8dQnS5DRX4Hp8Hc8X5+OlKmSq7kiSKa/8AbjaXhkPOgSloNxGOqlLgpcj3UcPNBOImdyjR9JooRI3OzQHaLYLmOFEFgcTOqRWAbK4gomy5tgeoXUYmqcn1o0ZDtIm+kxjj/wAv/sJfIhv68hodQmK8F80wHx3Du7rJknl65527aD6P2CpaJ4EzJkroC5yR0UzT1VfHMv1yzshOiqP1RMUbF/AnxKL8k0ePo1liMvKY2xkghha0vP8Aca0RNAxJd2nY8Lew2Og2DIkBposC1pAHa28NrK90c7iScHPCBTPMZOm9ROyp/wBaNvIzWxuC4O7JZxY78myud6x02N20IfompnncpL+BOSl+2FMonp11o+ak8tZXdNLX2ArWp5PLTKWccjGtkYUd+bU++TJZ/XZcmQ81zrRyqii4Dbtb0gcIo7/tpMK11fGLXzDkMcPCzDBRwN1yFFZCC/MffU8TFS7OX7dBO9CcZUMm9PWapLZ1ZWRJ6q/ofGfYHVcqshRWkNUtTeKqW3H0ySi6nlrJzPIVWsgFCb/tNdTNGTLjw5ASJ+izoHHzEF3e+ordAk+V5ftLTEGqm+wjx2CBWVC1AKQtYC7wtkcLInBTbvew0WRpSod1i1qt1su3eypJFKEPA1+Ofk+Eai7lyRTuK7mdHeLTOR50mmZmjwTY/jKx5Lu8lZVoxfVCdTMrPMUsPy0E6Qooqv7W8lWmcLF/crJR1j8TE1ZBBZDMmOWauQ6uGaZ+up/LQJkQfTwRnj29rINR6hYIH/FW3xdSRdTa0FyV1GgqsYEJPep1Zan71R8km+QEpNzWpy1eScmK61BzW3T8JBlhcjzfS7rXLaR0zM7/ACxNZajnM7eDHGR8zBYEVS5D6tNyeCz6o76VOVXHC6PjyYt6mkpWpcuSTrqKNDTRNJSxwChI8QSBEJbWtnYQDpoAbpDgvyTaSJJIQM6yovLjmiPONmKicqXXxj3VS/afox9d1IfXIEgjcZWWJL4mxhYrmGsUxNNM2Utfb79Ufox5cfntBuKZmpZkqSqMcRjrJ51stX43dt0Eryx+h/My88zGyftMLG4jUlBTkjy7d7Z3NTK1qn7RacWAwyQARZiBvYsOTLJNyQAIpsDAKJuhZwYuiTF5O56mpKhnLoKxNuPy0Tc0VvvUqk09FDJO8rcGK/r95jbOLWIyf7oPtzLPyFKdylG2P2xx84YqMnDJLqAkpCmaL1Y3kAUp4oFvk+5UjLtnuWby42XVHx1SzHNl7rGmQyU71zTpkeWkWDe9+wIxeWwYngalgKmJRBHHpyZme4G4B0/IN3drB8ZJOOlk1gJFFGmk3x9jqWpo3M9Zipc5fU01iWh+3gonmZWeq4CZoqrMnTvVBUfJVyTzxxlx4z9hkeKhcrX2qRg19QZJ7ejaOSPt/wCzTtyTpMckftmMhpfJNQTXnfOtqhFwwpauQuBxcEq2kvTZXBKALfpkhq+JMkAaHNly7+pwTkg+pRO3xVVI1RDxzX2ifrRYzQsylZN5aqLbmi3HjrH4Zn42aGqKp0WD8mpL1fFJZAm4JrGbxzLkZZmcq/V7EKcnJdVplC+TyBVn9U/5Knoh/wDwkTcyG7ppccV0NcqPTsro/JpmrfzARptHzZK3KzoRJbCKUXLCRyiXMUwIL0/5GGq5dF/H9purOr+mWuqQIepKHZAlzuSU5gyNcv8A3chVPC/1lxU0ItVSfVJ/tG96/A2y9k9Bzj7ud859OsyNFPnY5WNn9Zjcv4FtzD/kOqopo13RQlzbM+IHRRyaKuSqP2mGyWjeGUgpN45KQepa+nH/AIixG28K06ZVM4sfDw5OMPTTRIomXzjr6r0TStBs1qTa230/BHNTow2MszCgOSbu+Sq+2lUSXZ5T8nH1GOCUuoZk3N1UlTCLTpIx2VxUnlakha5/Icw9TmOclZAaJOMl+ZmpummKbmuUOdQzrfhiqr5mxICFlYleWgtpMESZB7fWlfkH2LBszyGO5l2DLjuaqp2BS1jeZaLf/wAGUhW48/Xm032JBPiZnnRtvCa7jHbr98c091t4qNbbqwVVUVJl66Wg5r4znfx3uS4ZqtSSA1KhRurNh8c14JxZIjfLv6qlXO7t/rJ1tKD7G+bpUhhobkrZZ+sEmIxoQqQRhWimFaCA8ospwAtV8kRCVkGimXGVoZ6uecWTZMyBvqYGv/tg8ltMl4jHwLBPOMyG7iEa2ZNtTWpiWOZQnxrT+UsuWrQfrEXBQTQNed2H35l2yUAzzQjrf5bRvDNG9cR+73/jKBKfFmTXM6PHWg/uV+FycCT9kS/JzxfQAGQSPYRIyJLj1LvLWp3cdXi8pz+98kFqnMampOWfk8BXjSfI1ljluX40y5Qs+89fUbudhSdOriVqgZKEY/ImiuT9ET0b1zkMdBzqttDonayWHIHhY9TZbi8/SKmeQSZbhLSt1r6zPSOse9/ehkxqkYY9IHlOTeJFs6fCukzbPJUoOFiIvwp6kyeHcU8X2lkVI8GSpmuiJYf7F9k1ykro+LK1suKm7qr+v3iTziSW2tCgxGudkghf5SmcmXEVHQ4uSz5P7k4/syaamVmSq3v/AKu6ar8f6RrFd7/7anGXK3BbLjsXTE7jVbFHe5Xw8vUAAmQoIaWFntPdaKSgGnvIJEfVbcgCQ9lhxYpHs+s7yzU3jpnGbmMVyh9GtEkla3U7LNfm29Lm+KXDNT/lqXFRq/GaUIyZPEyY01zR1p3B34rUTl6Z8HUz8cslS1kk6pUK6n9bsoAOqkZaL/pbw5aZuqx5jINdQkx+p+EtKeaqknRD1NtMVMteZ16UAgJMbYE322gT2fykiZpmMiHCBuGTfwNbvHlYxXfHFVd4vko3ur8A1UzLhOciLO9DBPRX5c9N6n1EbFjOzTgKCqmSZ+jV/wBN43qtOPePoyftrdPFe+Xid/DzMZDppgTsbsRk3xWvkoU8VN3Vk+fGy4p774+deRjJVdfJJFmPyS/HudqzSVjp68zquT6QYxZ/LcQIlRONdAJN+SzZgflNhMMJa7b0bXuXtfr/AG22qyYPk9Z6WdSlyST6uaQdD/jy9TjiVW/G1fK/We3t+6+n9HTR/wCR7hg9M02zETkzRiMZqNZDzPmZ5DojQEnde0+ov2312P1JVRLmDJPC1eDLuM02Y2StSX8cu9h2TQEfm4zezTk/mn8Ww4+Jwep/kfsOPEGPc5pz+7emnrRdzN80SjO0yeTp5/PP6nUPRHWZg9KuoHmmmzO0EuLxGtTSaxQ5NNQHKdK3IvLB45+vf/on8XxXeL09Ycnw+kx+nn02Au4wR6bvHjyzeTJJ1xEzM0Fw5Z1E47aPzg9bqq9z7U24yqrddNeplpIn60IhXKT4ZiJYTH+kX/0VMTHqPV4pyZJlv1PqSc2TDEz9qw16WcWLGuLzwfFufjx0xjZ7xzH5t+s1jj1bjriPlxFL9mT5qvkGCnHCfvU8pUhMqV4n/pUg/wBNpqplmohjn+Z4d9X8c/7mH6ZJs7SDfK/h1Qytzxcs7jmp+N+O6mWtZPI7/rp0DaFVzsPzrPbvcT1GObycmaAx3FG6i37zlbMjcFVwqlvUmypoPzj8tOfkU0Mkk65uZ8DU/au6m4XZoLkXpmzPS5sno/VzkxWzupq566DHNF1iRmYWGf8AasokqhP59T6BUQJBQMNCwgEXdi/qNeZQfSQLDOHKaX159u0yRy3NE1S1WO55WpoqBq5OK+sjEsFUoRq3X5rc+OiaSfrJ8a/Fum+zWX7qCqf5NaaeUQs/NpGbH6jEZpyPFzXVXT4yM7ieHvmZ2zuPFDqdFttL1E4qx15I5xclIM3c+TGlPyb+0GTWqtjh5qemqKvSfSrHm/hktprm99qhST6gsgTCi4F4TO4BcPWpZnGF46yTbkKukgnFNhqMjOy5KkLnjo8m4x0EwE5a4y5UZysF0FFQc6itsLKsTrEcUKIZPLeHDU1xuf8AGY7hiZJv+7ekriZ6d0z2fYZ0StCt/JSzohcPI6dGq6sobdyP+SqKTpNBW+yipKINltyAceG/GsfSBe1wt4EKyLtftOoyY2w3XC7y9VU+THVTwSlMUiyyOiTkR0ibwGaPjiCeSSlfix1EnnRe77rqTZpXY+Vodjv7ZMWXr5I+kWujmQNVksSvtfUXMjT9Weg6dbWb08Ap1kMVUFz1TMdGU34Gg+TJYNAiEw29Hrogjb1djFuIgedVSAwG5uAyoKmA4E+bymMGKacVHOSbyZCtyt8+CKhkSfC9kvUy07ySJsMN3WNrk1Uzg3xfL9PGZ6rqmZZkvTTpEo6VGLHmrNFqZGH4zRSmMuAr5LohuD67aNtSWfbJ1ex+ndVHW+Mt+aGbqRmaxGyynmg8M6kZlaN/mXU6rphIIQ4mkju3KjkzqqVuYPa6734vuNNnDD/473HRcu2izigrVXut21LPDUFxsR/t+bHDi+bIzJMk5Kra89zG2zHFFuN+xM1+9HgngoqYHD3x9ne8jSAY3UER8ktST3euYnWNZOpU1ufTzfe5P81pNLjudOWl772f5H6wW7l3OzSn553VrM3ptEcHz7Pe51pSLImU/o/bOQndvbYMJxAY5GcXxyeEVMQx9qKfUaX7eKPqMrvf3j/H/wD6Hav4X/AvX+5fzT1eL27+Se9+1elyZPZfT+pMtej9n909H/5/ovb8nw+3+puPes9k3m9LjzVj9ITOHJL6qX4flT/i30Hs/r/5z/FsP8g/8nL7L6b3L0vuPu3ovRYPm92979P6PJGb/wC932ovDePJ7n/IvUxg9n9FeSJ9Ni9V699T6nJOHBm1+mX/ANEl6z/kv1/seTD/ACv3/wBs/geHDm9N6v2X/jX/AI59B6XP6X+MvrMURj9H/I/5b62Ize6+/e34PTb9yxemjD6OLan02TJCYz8//wDU39U+J6XxvwH9O+H6lPw/92r+51epW/VVSDT6aemKQTv6rUjNQz6fwnSpqo6tVVPqFAQQ39MuPN8xr8cv5b/H/wCMeze4eo9Hf/lemy48lY2Lr02fLGeLuerxhWX4ak+WZd5NPLpOLpehz+kzRPpMPrcfrsuPITjMhXp80Y4AgrDTHyEf4yQHdaCfMrU/nc+vr+Te4Xmz37kf+Zlcfq8+LV5pjabboVo+S2lyXVVVNN1l3zvtnoPS37j6LM483p6nM5Mj1jiKqYKMMP2f7bgjrnSxWSf8dn2vQFZ+H6frrNVXoBZmYkMBYkuHOvJgdWr00gD1ekB8gbAG94h7oegx6ab2LGMmOpQ+OMlHQ1FPVVeVp0zzVx1ItMVCcvpceH7TqG2coSmg3r4o+hHQoGNh/s/bcoWpzM4+meLqqnyduO2jX+Wa2Ti1Va5ck/2+P/X5NHdPyZvo0ZJvU2zPafHXLKG/t8WMIhKD7a0DqF+A+/ylvgpg4zbXR6WGLSTnaQDbzLd1qhOPEYia2eoMyT5YayaeCLr46cZWtyR301rTyfgaMd5DvVZMjNW1kYw1YEvy08MMF63OjprWzhchc2Z8b1NrFpIFRqJ+RyKrcgbEWJqCesfyfiZpLYq5ybaydoZK5GWXFlqQ6Z3MS6na1oS/ygWRsIO8AbQPP76z9RCErZzex5y+Ccat01xGPxhlnq2SMfyxiftw6/vdTGqXSDG/K/lz02hk3GSckY51OMoldk5MlqMZJPF2tVW2vsLP5rPli9uPNjeX5E2TcYyZdfaaRej6eI5ds6rbb9MtWBPzF1OWMkumIgpcF1omtkoY5gGt6R2nN1o9WIAhRIUeAVsENUC8HEbWsudhGI10piiQncYzmcs9VjWsgtLk+jqkZdCS6gGZ5r8+h/8A6GrBi9f/ADr3T02bNjgv+PnDWM1lyf8A0y9LE5bm35M2Pu5qrnmrhCg63PzZ8bxPGXLe6lvAcH/1v/apPjyT8YVPif1Nbsam+Z92/wCAfXHs38+9Fmj1FYD1ntnr/RxEk1c5MU+n9VjxXzMeN+l3lxlKjkjpnIfnz39U6dVfwPxNIKP9qogmJQsHax799dfwxA69AMhz6gDBH2Cz9Hr9M/5THrPTfxP3H1vt2KPWer9r9Lk+L27Fh9Tjn3T1PojJlv09enxzVVj9Vg+bDDjvEZM7zkZnfyfjN/zB/L/R/wA1/mvvP8h9N6HH7V6f1OXHn/8ApdJiqMFYi4zYuZWmy3p7n/GV8LIM1X63e8fyy59FM+kcODmI9BXqcbXpmcnc3Wa8f+SSHiSsmWFXZjx1ONa+HP8AnD/iL+H+l/it/wDI3oH1Ht3ufrv5h6r0nufoby5K9u9T6OPTY/Veoz+nijDUZMltuT4rr0uKXEUxVJ+fPf8ApDrdH4Pr1j4qldXrVCjo9QWDvSQ7FBECEQVj0PjOker06vRUKRSCCLEIgAh2k7oojt8Fepze2+tMhL8VaZNzMalQle/OzvTiVrZzpeF1XtDR69gi8s98s9Mu+5xxl0Eg7OTl83sD/p+dV/O/4pk/jv8AJfWe3Q69vZwet9tySs/L7d6/0+L1/oc9xDZXeD1EDqnxybrQzr/bvTTjyYJagr/G/TU9yV5m7/7VXXFb1N/brRyn6dRXTXQKqWaTT6qTgwDDOBbEFZ180KD6xTtVnNjY2ujzbOu5xZskqZpBZrRW6yy6dZoq6xPE8Vqza1NsvYjHqfXVOGb6ihnHBUfZdF1GS8u6YvHoqr/YHVhKP5c94Zq8OLFWKZMeKiCSMVpFsQ7LmrsTx2Yq8G2iL/OR9fkicwB0ZMFGTmpjD8msmyAamtpfxzcvNwfagZvO/KjbZyM+22NdFR9DCCC7koAl329lqn6zPka44CnLUypsuv7Ft1QdT1srjm9wB11BpBZrIHn/AC1BR9aN6mG6Thmfv5gebKT9b/LOb4yTeyYS5tTQ6k/8c6NhW3c4x6Wjc0hKMeSavTM/1oj6AT+tU27+m7TGvn+oar6lU028FJE2cdn7So1ylvEp3ElMAx9NtVvWxixzwYkLoMmZ0K3OoWt19K8lXEGiSJdz1+adYm5+yDjDcuhop+PuvMvaTvwFPhJXzuvW0h1NfKv12kNQJKZPklCfsJ5nRtvhHzocuOa/SjV/INXO6lT6tTvfX6mZ/SoI0V+aABcFG5CseVvd2xaCLbA7raULDyzAiEnPExcOmpo5rQu6fsmwkPB9dP1DwpTDG8OPHk9RkN/2jFFO6mmcdHSf1TS3avx+WTWvy2M1zv6zMSE5J0anXOSOrEQdn+/q7PE9Jxekv1cY8+X1EYPSTlI1WMrJRJqsvw4z/U1orpJoP9+fynZp7hyyHnsN876E57IKMX4kW9lqlhwX6n1E4cfF1m6yXbCmKHz3kqhDFELTSOl3P7E3ebN6fDB8TJ6f03GPGXtfUZsZM3kJyX9fk3b1rcjySc6mcl4PTYLxYS8Ho56K+Sj/AMv1tBARmNyxja54wTvGvkN1Kaas+f1lY5YZMbM4YCTHDC4ze9+bP3euvonlGpzZKAhpldtjftYX0gQCv+QzF1/CsbG3oPsOH00emye4fFFesy5M+PLnsKyRMzLGPBNXvHUEhTNFGmNUTBOy9TkZjErH2nG1MTVbimunIiUO1Mnj7TS6U1Wr9iuv/GywWbw+tv8ARUzjLxRRdalKH9afL9nyDTe9QBpc4uS+wb1LgUr43fMa6NGPkH7M5NOjz+pPVqNQNSMPAjIixCeZ10AA0BEQiQMEZbcJ8nxqjnylymM3cy/uOO5lgcafISyKRRPVVog1IW6nKVZf9WmbyTFRJWPGgnIs6rs1JPf1aqr6pmdj6lO8kMEnyMyx/iKaJAqKtSeVmWU2aKNwV+af1NkjGqmAqMlS/Z8Xs7Uqt/7SfKTIdC/nX07KJxENJGUpcdsawrM3JMs+0H9LbZ1rPmyFTBDys47z1TyU3GqCkKRtDJqaa+sz3LP47mslb+ksxOWZa+NqcWzq97q2lKNV9gS7l4RdYpSYrQ4/t1VMNs72avun5CyWujrlnxZN0WVrrHq1ljHHELqT6892u2K1RROv1Q+PP5+lUkgEV/NZZkJW9mJtC1sOfA7r+Mu4hDR4kptNfYvLPVNcz9X/ABzcydmQLxp+jeQRdEgq1NwVeSGXJOPzdSjg2CTre9MWaqmWqccAsqP30+WdobxEzzLk3Xf+uQQo2aT8nGY8dU1jKm/3DA1A8JcXDj+KZfMbrqftyuzQDMpDfCIgxskMaokQAL5sMASbLCJIL+WdZUZcYzN47Owiqotn/W2tnPCLyyzupTVdAuMtlUfN41bupkp28k4qcZ5NeGdSeZkm/wBZTkyJpq6qhk+QovHb5g1vfQ7Svqu/tv8AU3NMxBlw4nmT6ovPQM7rqnIrrRMyx+6+3ggAeltCPa4jIN5j3Mn0yl3EhRwkng20VZGIaf0T8aE2t0bTKhTX7KntRnXaNSX+V8earrzubnIdVoxfJmKk4k20O7d+NW89V0ImZJrKnRM/CxduvtQMkDXTeR2DevPNE8+VZPISHMBhHZHJVH65qtrda2sm9SwP/wAZ+qolghBoItwCyLgFyLLkMZqImCWncFcyL2tmI0es2TwxVfecNTETJ06/yBf7prfNEib4onrf5MAbax3Tupil8zbOuNpjpxm6o509fUAGCJyRYfuajTlmq5q9M7uV3kd1QXDpJniuuuqW5Jy1QAXNOR1qCnGT1EzRSVVLNnJvWvq8rcCxpL/DY52ZUAj1L5RGrFwQRhfYZi0m4BVQIOnuSwgxxNlnFXKxMtM85KyF1FUy5Otmp0N7l0V37XXjnUlt8zM2H3HvdeaaTo8VGO/2T9TF+zAgV2eZoIeVgk+MmpvnUsoLrydT+FAzVZdFuSYnImPSK1JcXrHqeB3rfhXWTa0yfVxPbb5bA4ANxEojRcSQEFGEGojuD6uUtZFRF9Q5D5DVyOL4woPobNVuZ/x7nqXRuo6GMcY5yM/LqGui+SdzGv8AHTvlr/qMwzvek6D8XVzTJhjnHjyRsybqnkCsl49VzOyUJqRrcjxGg99rXHx6betclUSTcotWT+3xI0Gkl1X4vU9oICHBpLHYywr7Xj1SACgwgzghYXYIAHbJ5M9YyJPioypC/VA3Ljy5MvQfJ9XdE1aHySa6PzMlOTUSaqanHO+udO+t2S71Wt19cepRVVYrEuM5yGORjMnytDjFOPtL9yHxE8vGzbW+Ix1v/Rox3BvHZZMyecjSvKzvvRc+Zft+i59NhcdgmCruzNzG2qmQojsGgAjfm3bRnHyV8nVSZFPJxNnIY0ZhY3X62+dycvj8xvHp1iK/zft60imnikCXwj1PSEpufAeoLrWWQy7Yh5XQ8/8AYka2iNNbn7Te9dcwVGTHMz/cDpsDrnlqC6lat1M6Cdk8b0DTp9IhI4dj7klE3APK1QVMYFiJa7iWOZVoh1PXmebmKmK4SF0c1WY3VBxUHT9Hf+QIShE5mJr6gF/EFQ3pN8PVO/proWZyaTU06bxL8Mju0y8LM4+RCsUpr5JXlmTZ9kGXwnGsbeS5nddfH1DQNcuPj/17djZTXTE6Pt9KtlkwLAjnPfNiO0nWgqBFo9If7D7fNDtGmzkrVaYsq9Fs437UHFFlY2WHxqg4HUnyLKN48l+XA0zczSJvKi0uskdJX+yDTXEoHVERGLxVQZSxzjLNm9SsLQax/vcuq+2of7fmZLNSzfBrkTs5qgZTKKGPZxx+tH/1B5HAgDaMx2FvrbGj1BMotbBkLift+YUZE6ZTnJPiBOwaKre7ydT502wHO8mg8Ph+Sf8ALZjWpybfqUVMTr7823boZNNa52VRNATiwfaKpybS/BUncimoZDD1O/J2lLPRXiKlzfGMkxMuWDrWPJz4V35WwlYhJ1omlZ/AQyRL88s4z32I0hfez9htOY43GozRhx7qMaFXs1Xxh14kQkmcXUlGm6kn/tJoHFic9VRJLjy1k7VnZHLRPRZbtOtJNmy/tK/h5W61qfp9Ma31pPMmXeSbDHPPjJyURL4D9k5vgInHMmSfqXEDIsj8l2Um1Kb1LsCqkjaENYK//LnP6SNKHbIX0IU3E3W8YFxmpSvkq80Wc094cTdGugDG9ouNkW6lmgTUVdrOOLj5K1JUzXxzJymaqPknZvdfQvz3XPlo423DFb5jsWyceUr7spJC03qCE/8AX/sqV/Fskeou44lZqiZGH+wuKVdZNciSanlpdlzDaGABbj9EgCb7xq7IgEsFCI7SFDN33M6dS2k4yai8ZjvjGTBloSGaHU0n7rVWFiRy7VyY46EZ28y5fi3i0EfGx4GJa2aPtUzMmtaMsxm4OylrlKpBjw0iTXxUfWRUXnz3zIZt5cPG4x/Wc28ZtvXV6v43ZV7godFwsrtnaKCIAi9iRbzDiwhafyxlDhtD6K9sMoEai7+bi5IkxzPc2M/NBH2upyL8lO4CmhNvZqVS+XHp2rPmGPi0dDyZnp0ap1TX3I62WzjJAiomelytZIqWbpucISf5ckPUzjYFKwgbJf1P4ZSK/wDjx0ZDHVMePm6qvmRvZP6DJ+iupmfGRpAyzG8FXjsV3Goc3dinwMiZIUudtFdQPMzvnGuW5/xY9dS1d1KltlWWhGzo/qJMz8WKJTESZEY1Piayck25SjidlHPlgF8h+C940vFcP3eu5NY+7/fyxuQTwSqnetVDv8W18WMakqa1MzUTdbpGLqxo1KXqqN8+Q5o/Bw422ASKwfqvtoPvD/7Vs4REZAlasVe/sSUzzi3z46PMZN08u0oa14Sjl0hXM9YvkSO/uyq39a+rFw8zMR0cqjGylhqbDMuRHeSHMeYLDqVrdFGrkV++0iOZBDcUVP0SLqSepJ5rjKt6OcmSk5idbCvOoF8GvwBmlHd23GFk4njUkjDhbMntCeCzMCxGmVldXfUec8x9pCsfXOTY9VPxyj5CgXRLqn8QVKs3h395irFneXYCtGyHqpanlFg5Kx9XLkrFjxT1M9VPdTD9imMhdVvStTU7Bs5aDXRWHnfMbCnIRk4WpJm6x7+zYruJnw6vX/wHqlBE7A+WG7dgmBI1dOMm7yonLCIEH3M6ebWu5ULvztJiYk1je/8A2Y6Jk0TO05OqAWZGJj5GpAZo44cf3rxFATRWTY3ve+f+yFflVzojcOPTOJuf7dUnTeqqwP63Uv2JWp5n7WKx/JNETTOTH8nCiRD/ANceQ2CJPEPj7V9Vq+QVML3uwRcmPPP2NwKrHJsYaCCVyVzLiLy9AnGijBtx3ZSxQVUlVkK8s9ktRU96FrpHcsDLMTicZmigx5O40VzCUlbqHs83qpYCR/DqWqVxubRWPdlTfYoVFSWLMqNeUsGthbQpF4KrHueai6mpC6uQqipj7/qg+Te6ZJVCfyT8xjzA2AfA8xfA0iXZQHbEfZxe8W0ZlayFfXqMseAg7rXmrmu1q21maEoK6nv95lm87Tc+ZyD+q4eRKamu7XIGpd+Q4Wb3f4ijLlyptKKipd6lxySV1VjkrJXQtT/ehxu0lbLlrFA/93TVhTk/yS9E0a2YwXbvcUKUbn8As2jaZCH132dtQCysQD3YQsATkjfwwxXHSzWnnzVYyo6dUYsZkrVE0ykaDoo/0DC2eSC5Hi+sdb75CMotbInVavSzNcc/XX5OPLFA4mchy4uSQflfJ0bKijcjkNi0BDudjd2T8lenM3JJWqsR68W9C31M3TdTA8nT/r8r1R48KxOdtir5WqBQAMCAbtRhn/GCQLZnWXc4/U4+yq8Ub5PtbRzdV1Es9CTrbJCwbx6/MrKT2E7Luoi/jQLuhH5F4MYDp5dJVcjuRVZWf64zp+jvGWxkyPRWNx19IkHm63J9eZ8VqxWaWJqid8zj4yQUzfIj9amp019at3p3+9LIlkXKqjj02R2vm4zBIJtvSXMelz/3IZsDSBsusmU8/Jhvli6l0TUHippcct5PIJSF/b9/aQ1rJcZNSUYz63shxmypmF++03LWn+06NV0NNWM2kv1Y544u2TmbvdOS7208rLyO4qtFjF5NdmOjGydbaqhnZVXPk/6l+OmeHlCqKbkQjO7Le74RS9tMVfMhnymRNyS9t9V76/RNTO+NBzVXxQWz9kg6kaGfsV3qZ/Mm6rUsacOSIutddkSKV8iVcA3X152clSUtUeTy44mpaxYnJkXXOWRx/Ra25XoW6+vU6OjSoGGbq6Ed5qywO2uCd3qE8wnmIHW5s2iacuLFRYO12XlrAzfSiRw7rxyMiHcOJDJnMg6PoP1NXI3fAV9tyY9KJx3L9vqmyT5aNETj5Xum+buecbeu46YA/wBJo4gJ13+QDWTI/AYwFHkmayTH9q+TqiXdfFzteZknqd1nbkDfUUSGmmSoxIX5Wra6OZ6CaAEEWkCSCClHawTMdirO8DSRJbAOMORZh3hqy2Gjp3ii6Rnk5Zt6ImOmc1a+T7NSSSGusTTTqvwPkkxS3bC81pmafkmRCyltyNOiqj7TvZO/M5vOUR+tYi2Gj423WsfEvNjOtD9vN6/ubGqEJQNE3vmSayT5mUr7tMukjxWyDetlObLH4g8Wn35iJJAZqptBvewiPmJuUCGgwGXjXU+ojWqm+6ZTrkYDAtklRTVEVEyXvjcrNM7x4ph5NzMYvsVRjzTTxV3Sdc88aT6a5ZQdj18r/wBseQ0M1Vk3AM1VUdtc1RDjv/rqMnWy19TqI0yJMTPMtSb3U5Ojrmij7PPVV5BNjKAEWG6OBZJq3sTnTbgAJIkhQgwEjsjcWWoMYYsmQsJl7L5+SunG0R0SalqmZA0TunSvIRc63OwmOGbAqmNNMGRqdlK9UzYjPKz3+ZFwOXC0p0XjtZacdwtDWkvXlDGa0ZQooH8LJRkgidR5xjuTHN/WpPCU+dhZXJTud9eWBKXywiOebLkY1mtjtHZTs4DhyztqRMeHFEsGSg/yG/HyRMl57j6RwiIxqR8GjTW5lutXJ9GqaCO9W75yMg5K145mZD6TzXhd2Yzcf1fsReNucdVyzWLHMzoOUK8f0rYnlr4ys1Uu4stKm947t0F4o2VuFs1Ms+ejdb2U59JLSiAkBF/rn20iWrN4UWlbvYIhnOp3hx4ZeLcjcAPBdVwExt/eKX+qyUm/JYbCSkGLLfkZ8UpGPJIzjyampknZqeJPP+xmnMtZKRgjxO6CALIeDwldn2DIHAATXjyQDF946Qyf5K++u43LUmPUOueanpNHZI+IQN0x8q3GIJRMwtrHg6QCQP0uJM97Ii44TPJncOOcXLb45tjqpp5P8mSmDcJezW55KiVEpWI6y77lHt6sOcm7PrawAtnBJJ0fVrqTdnq2tkTsloONFM2MVG3TkU1Kk9VuToAVVi/ydcrTHdS8GkRuWgdzydTIDI1WwydfgSaR2KFmAwR3V3qgA/m/CAElJQsGQkJqkECcaOOVWzfJ0vMzOQGElH+wqnWjuQgS56YuSiesxiNTkiVxscdNXNHAuSty3LMY1CeoUfzIirxwjIzX0O5nLQBXB1IXCkEj4oNPUkn5n2WguhHb4w9fF1qpjs++Pz4DUm7XlQ/MiM8thb05JStBGSLI6imTsP8A7j/irmzgA/QTqcnBWNo1zqRD45NUGKb1TuLkRZP0B556YnHix7GUMhWTwR9be4d5BmZilIew0y68hoSKoJ67pqKnJ9LWF4J9QVpr9G/C9Um2kr8OGzqbNWdQ5eZGtA/YrX08LFSTS+HWQ3UmkVIkBFHCxO69u86ldwYJFkYaywIIYgaXP28vmohnI2pVUaaK633X2+7DO/0k0dFiLZ1px80S4t8XkPEEwG8f3mheKggmk6aqsf4mMmO91gdfHD8ngx0sSDoovqqK1euaEo0HNkPGPX/1V6eqm4+Jup4x1eyZgRdSK/2DRP4AwHDT2Bicm9ltGwBMrNjdsHGc4Is5OpprHUS4qyL9HiNTWSbNtihX1+/fBR/dJmX8bWJqJ+/NzM5JyFyaTdOPwS6rrXEp9hBkT8Vkc3yTc2SziayS+CiaGt9H+VvUq9Tyvl+PentXJLNTe3xRMt45vXC1viAZQxaTz1I9a/IvdqA4WFLTPgjgyWJPJQHfvuTOwtF9YJephmT46HJM/H3L1JJVH2yX1JWq/WwGpODYxYnBOGpj6zDI1czRT92ncPVdT5nepZ6AEXFXjZqD5JNTXRNGPq/qdTTygaQnR0ZOam38blbkw3eludLfOuqA6cka5gS5nwhJTM68fkVRHbBShZjkTPNmgjUUoCzjNwMO0YhMwdq4rxZL1kgHlgpy8SNUoVTu2MkmljjRYatuTLNLMadxidzR+qdZZV86ZZ+ap/e5IdZOqUbW6oqPiwVIbmu6gk2lyOvvzDCeQxutG2tFa1OuQwUee/09ZLMlOpqjkyV/kHfR3Lvmrwhb6jF591Oo9VohEf8AGLzZxk5Qa1ssZA2zkyJlm6ceSoWd9NfGl1j7yEwc6JdrQyyFz03GOci3MlFZykJm25IMd78Ws72SavmZK2DOrwi4oqbIjsGWl5hmarHfMtROuTmHll146/LmP4r9PtXTcuMai7klnWB5hyRPWRqq50H9dTqTz+rSDFxGTYkdks2fcadCNVLmltYsFnGxRPCGujnOZEJCjUYLkijumaCqGb1J40+K+r2ajzbwfBGL47Uty1J2SFX5iMe1hMQDUUR+9xXNka1WG7lcrEZtlYpTaUWLOQy9dN1UE1kqXT5S3oNniGzDnZ/yzkjGhBk6mhakCmjJNXM1VV4+u0E15nVpq/CBftBbCBJttvrqFufBp7BvdtxYzrp/Ru4nXxzUz9iid1UUdMzcPyZNUcX9apX5IAPz0r+J+nn3L33+C+s+TWX0f8v/AI96X1eXHPeaXD7v6OoahbaaxVPTVl7C2WMe3zL07fDLjroyzipJ4+W+LavLFK/HW+avxNTurNfv1P8A4Zy5r/5E/jPtdY3n138k/jmXDj7qYPU+m919NU1CweKmrkeMuw0k1t/PB/qYqHwfXrFP4Ol1CRZ/JP0NrLtrXon5wALmkZUEW5mJKKW+vdf/AKKn1M371eL0xjxjHq6Mc58kCS+oMmXJgqn4/ULROPHVlEzzUzTjuPzz9yyE4PVu5KcmDEvx5DvJ8tLk1s3Km8lr/qipqP7/AHT/APRRe4Y/Wfyv1mCc+NMBnq5jrFiyWXm6KmpazZqq/wDNpmcjhrFUHEr8OVBnvNHxlxOr8RjnqsDxOSHJtpkS50C3OlkNvnf+lx6P6X0MA0iqHYpOM/qDd6XxpH90htMLIJSs3vt3jXOfGlzkcvOTGmVPrQzVfbHPILzWkxlc9dRVU1oj/wBv1+NNXv45JkpNmR+/dE2ITrxvUoX+9l6z0xH2rs1k4meGDjdV5qRYrbNprmSXclD+Ubg6xl6rcAUz9SnisdVm/wC61KbPr9Z6Ekr8+pFS/DOwi7APzc9sHOvPqFTqFtl47MLMq3Gr/t3q69Kz0f4zLEcE3zWvDVROyfrzM3vmrlpnzp3udxUTcVOScyXDvllZvmaywVM1j0KUOp3U9GtctU9aNmKXDGVsklyOHrUyV8jO7pW/p2Fyo1NO69t9TTFeltIjNY4q3DOOUgiifrjgvfFQdNUzpim9upkrYYDJa7DWlDSKeDClMLeIYDjTLnPGTI3OS8d5GckoLJVGsmHkmdsmmndbdVNFVsbwtNmNkhpqRrHPyUDvG6HRqpGKZFNSks62GaTDuOJqvkSKqWTFk6GdZZeGOZb+pqBN8o6rQb75Euaq6ytCZUmfkx6iXquqnoJDm+bZdU6U1oAAt35/CQxbjlgb6Yp3+pE+kjdhi0m+tcy6xITM1UnUyxLkbWctZBfM6DrX22M7Jfy/8VzUMasqcZUMDOOrrtsqKDES+Dc9z5o6lT8DKfDjij42a5PvLV67jRWiGPimWmdRWM8mtm7Wa3EYRhXKRNPJsMmn5JqWYkXtmN9eNSMmvzX+5iAAoHgDyvD86SWGWAgRlCVa2ZwM6UYsjb85zU3dHaQOGdrjNhVirr9fJ57vqtlvGtjIAmpp6+Or6rpyaWnUiTXmR/VBj2UJWK6xxiaTU4xRg6udY5u7p2A1FVjeeoHZx4tzgWSdONTWSqyavNETvIR1JVlf45JWZoOeJoq6xqriWbIzuGLxgF2dtVSJ+YBMCESgB9GUoWANFGCIX/xY+OmqcmqK34llWUJAYmIQmXSU47ji9h5q4n1F5eaybquAmUuX4r6NTEm2XFP1nrW00l6f0cmSXEUFNtSVMwJkn/62GWZqa1MTLpGuPFXMm2nCTkwrE6lmufjSWjm41WzeTTlYZpo00lIT+cfU6glm0TgBFQmRvYdtbgOzftAAJMnCx2zHX/wP3T0nsv8AMP4l756/JWP0fs38i9l9wzZMGPu59H6D3T0mfJknisVfPi+JqBqcY7m5u9T+fcH/ANEd/wAn/wAC9Z7d6r0+L+ST757t6rJl9Z6a/SVm9RGP0UZfm9JGb1U58+K8Fl+pzZeckeoy5XjNUtyH575cbwO+uky4sdcbMU1TUpPe0Xowyaro3ulqfYP+Gf4dj/kvufufvfvPtfpPX/xn+O+j9OZ/T+sw+sy+m9X737y17d7F7beb0mLqs2HNl9X7v/411Lk9P7d6vitNRXyP9V/p/wAH1PjOh/VfiK6gfgwaRTSR8/qNIpCLZsFmMRrt+Hrr9FXTpvUAcwB5sIYgxr5o9/8Ad/R+q9TkqcvWK28x1H07ydUbmvJXOpSD4upompZkNH6f3bDjTaFQxOOZwVu8koFY+aOaSnToVTx5T86T+de1+34f5T/IcPtph/8AA9N7l6/F6apOY/8AGx57xwYMTvjGGmCKYifrS+H8Z/D/AGz0VT6j1denwZvUY8vOLJkFyeniIGMkxf1M938Y285PE70Un59fR1KB0On1PSRTVRSaWwQKqQQ+2fudeYKaj16g6XSQ7ozMMfZcwddLGHJOsnyvLU99Y2viuycjXxzMyVjCfka7ry0vxWn4mpobni+q9Qk1QdJVUVD2nyRukgkDquWdo/m2y04z5g+SH6ZB8k1bV7g8TNYzbMV0DtnuO5rVv2648zzck75roB2zukqZUGa1Va1TOueP1gkkd7h/4gWBfHpnBOuozAjlRji8R7k21Sy1Uy0QTpIu+bJbne8tTpAlVusivhlh1spQuHH4Yp8WXM93Pja3f1Ax5I06l52SFnW7GaoeMePXeUnDqoqI/wAnn5sq1UH6tqcxTjN3ZsJ/K3qIv5ZguaXFNs9TEWeS8cSdFGadpGT7c/ajpl/NKK2j7HAMZMvbK4D1hXYmAAZveDkksqy/TQRAXNQUxVOcfpHiF3iu+QyNTHmRoYXitP5scWQ5XfM6iBm6+O6m5+Oj7pM1NzHe6NJMeK7dV6as1Luq1JUOLdTGuoKJm6OcbO51jrfXXyHnzsseDrbGQAaylXSX8PW2ZajTtn6SHKLvwnxz1aQQwyDF7yhe/wC2Hooq9UP8QpbQkAcHsDD2u+lxROTJrL3L1ORqa8Rt+PS2TrF5Waj7M7lZpX87P+Ie8f8A0n9/9j9zLcWP0XufpDJcjxkw5Kr0+SmMdAxWDqeuwp/c0CVw3p6u+5J7TtMlnKxhmecd9tUlczVf1aAP7afy9iy1jh0k5MjNYTVVkxxZz0Wy6Iv9hGlpZTtTzOrSKhVQQ/ULOMcI7zPOdbdPqeiv1C4NLPJhbFDvaTt+jvt/vfqPX6wzxmphxYm8dZo9R6qagxXUZMz8eaflg9PVzPyUNBGtzw//ADC/xT3H2D0v8W/kuX3H2/F6b1ke75M3tPp/Req9w9PF4cnpvd6v0rZFYM8Yp+OjkKyRkz/NXEvH/wAN/k1+v/j/AKb3KMOb1XqsHt1TkrHljFZ7l6Ocr8LM5FPk4uwf8rVQ/Z4s8r/hPo8P/JXuHv8A7x/yL/Kfd/4t7H7fnw+zf+Ljr/8AS/rvePcKyeoyuPN6+JwR7X7fEGP1WsvzzWb0uGPTv+bLPyHT+Dp6fxXU69dR6XT+Grp+Xpg1Vmo/KAKQGSBMNYIvr1T1RXRSDP8AcCuJCB/d3vrwX/kL3b0/8y/k/ufvXovS+n9u9LGP0/pfQ+m3I+m9v9u9NHt/osF40Oclenw4suZUCqmZkbx/nCel9Lxmx3F7mss45yd9/TvzNTM5Z465dbZ8lv0ep+s/5v8A8Af8V/x/+Leu989J/OfUe6+5VeTF6XDjI5siYsfU4zK5vVVkiUM+FxYWqnWPpi4+OfcPasXp8mR9J6n1AU2Y0t2MU8ywa5o4lets14U6k/PuP6Z8V0vifhwOiepTR0lQq6KqT8qNqlLYLzL14nxNNXSrZFLKqKIs87OATzEX9Fzy/Ec7kghmKsy25cQalecjJl76KKH7S7JCni/V5M2Wly9NRmMONCT4yRmmShsPIuXwnO2Guq/Oo/hvpvS//Sn3j1PuXrPUZfXYvT4sft2HJbWPhN5PUM9Y8tXi1ET8cUzF1L1dYtc57lpztbkkysXHOQUbuVy6dF61rfk1Uqs3+ehSafVVRMIMwCTkX2Mq82eoqIIpIKYBNijb3MyGYi2tD6j5fPySVU5EjXOOgiaeppQyT0teY+z4QoOquLZWWDmii8ktTqiPpU8v6rb1MxrRb3Jryt9VUWuOI1MU2bNd5MZxc8buoxv1lgmfIws/9aNZowYqupGqZcR9qqSg4dtEkyxrjwBuvAaNVF/fAKI4JkMG9hYaxNzaAptK92xZsWSLXleczQ31cTe6eV2x9Da47R3zPjTW6EGTVy4676XfzIZNEyNJMw3X9glUqZlPOguU/MzZpybiZ5EZ3xyQ0SzjqurUUrojdfqOjjr8KA+PGsk5BCUx1rcu7cqiuqpV/aBCdwX+NRa2Ck44AJxdjnWeZkuAhFhn07Lj20ea1nROvj1itkVXlN1vqqnT5dRTPipeeizHvXosfppx5cW/U4kjHMx1iax7mWJ6kb6dVXIoMhNkfmk9d6jNjyzMV8s/TjIfYl1Oh0wbOXU2VrqaH+8moccU7serep0mjrWsdUc8bXf1pT7IdMaaaBugbl2GMe9/ojVITMeWpLxyM++tn6j1GX12dquhuiZ10zM90Tvvan2l7+hRofsFN6sE+n9MZMkaA5KapaZO2pKmdgFTeTfMglSzFP5qsEyZJcngxDdBVM1MosHRtFNdaJqTh5qWjY+s9wfU4cOAqoxQ7Y52QscRNU1UmI20xIEdO1d0yA6mLPacWshsHbyNSoJjCsTg+35/Tsv4ndVj9zyVl1eTPFSL8lB8VzFcVUTXTrEr3u3k30y7TNlU1kx3jkv4tpU95ZGRso6xidauU4mTcyytcZ6L1tehz+lub1i+OI9Rjwys1iWpqMiJXZL2mxCbJ689dlUdVVNY3/7JxbNBiaKkhqFMk6aPtX78Vq6fzk61Aor9Un1IyQ4W439ttdHTrfST+bmflK7S32GFrVeqa+Rr5lKxs7TZuVJiWo2VpkVpXl+xXJ+a3KVBP16axc/1WpoL/wC1PT+qStNUmkWduzz1/bJaM/HUzjT7dVI/XRGslLW9ig1qWkXU58jUDcuz6s49mYDH5gq/3/sKnX2dtJOzbpACmmBg3BJkR4kB4+mVYRSW1hEcx7LuNUsuROYmeSGMYyDLkKNS5KdM/wDV1ro1FbDaOM7u6z3wBkxQOgE5IxyVxGuq5KmWh6j61qvxkYYqWuuCcZa1RLkqP3G3vSyz9llomDwpSt/rP7CKxsKj1GgJa2t98zWOdDQgk29n6Ky+I8WLNgUDfyhrQGW4wJgfLsByHiSjqxqMUcBxf0+20CqnXN39Tl11JEsv2Jf6DXxSS5QH6N6oWKNGNk8n+Q3rlAnaf/My45ZrkZrGfMDflClPp93fBuhudb5PqVH4KW5GsTMzwNjxH64jiDT1FamYrpZaQRXkJt6RbCsyGrNeD41dJLAA7UwyYO/YfXD1hMgTvW9ZuqdfWWdYabJ8+J+pI7XdFMH4zpvJms+08puh2MGP7YTe+KSna8y/3rYv4upw28lcrcslbmZ6HeOsi5JmRfGMdif9aZr8dtxcfGTV8GLc+dDWi8l/JM10bdvnYKf7/AMR/iw0Ze2Z7W3GmCRcdysiZTZv92GdZf1Rx3OTvIP9Y7iqJr7UckZFh3jruU0zs2MTe3JIzb/c74MmMSdfboOpa0R+luWWCh/IZMlh4xm4U248VcaioZW+lU/TO/6bPCR8cN8TTyvYLM40fDjnX2ZtAH9XupdHP4zK/wC7ndLGyLko2CiWWICshLgAd0SME7rBY8vx5aNbayqZGWFytTMl11JUHnfJprZrwH4d4qrTBSiZqk/xCid8aBtNTJ5/1y/UAW4cmQkjLix6Ckxw95I+m8W6K3fM9UeB+u1fuNchINUaQgJ6nV7YmtXQkPnrb5d+E31APp+WoRCPdReZYcvAYGmCn6njlkogIwTNp8EaHzmpczXM5PFTP+Mrcmq+TdfddVQFUTzIXv8AJlr7bDJjdzDQWxNTPGrOZ1APWMFP9HRqsuuZ3OMKjnEhjQbqq1l2W3IM0dp4TsdT1+QY8jj+XePTOPclRSSBq/8As/N0a0QE9TKhXi/usIxFyUMH8tN7fT5iZpLEXUyjMMCIumXBMsS6nn6pCbx8fJcVxU0lCAlps0GzByFVWOuqXtmY2xDO348vUIn2idO4aPHN1pfTMkV8dXWZZyJ3xj5uZavqCZGX6M7HdAftJjJdO8dtGej5B+zTUajSScf66g/2RQrVVJPe4KBasJ8iWDxqRtBkG5VMoTckEEkJbECC+sjGL9PDHxRvf0brkyddpMoUvTTOm5OX7YZGWVAyBONtxujJWk7vr7TW1tR2x9xl/AqA3yxBWPdRrfJPTzO5YqjnU9G51XaSn5jdzjlxnn6QurgKdPy5JP6VGvvd7NvmaBXSn8U4Qgvv7vMHMB6tryHuxDBXhMAEi2dFYSDlateMuNmsevPxk4uA6A2b+u9aElZ0PZLqedZK8sS6x1kXVqVMR8Tj0sSV4KJfyLnFjrFmgr5QiPI63SV8mSoNm0qUp8R/9rVSJfWW2gJiMkauEjrrf+Ldea+3h8ITR+h6I/8AlEjb5bpTGLQxOqP1C4NQ+Vd1ZhAQ76ZePFk+GHUu53ZRwvRQ3VSea+xXJ5I1qXSZkyXeTUHWPGRFLFUGRnguGq0EsvNf6VNPP4GSsk8ozmLZ1eijHVaYehgjyX4TQPYK0fjz6H2B7pRrHuir55clz0Ig0P7DVH1U/EE08swNhHgSpW4coVB3EwfFhfdoAFo9tDdmI5yur0SVy1ZXiiZsNcbm0rQT9ljf7iAe6yXMu31EXMxRkg0xjp09Tt6mogxklGywpLJ1ly1dONxxGTGQlbHf9529q1TxdPg1s60AxkJnbpUMeLoGibmXm6KJ5ihajbsdE19du5gQN4djgAxaQIzqxeSke2xjmwiCY4BGJ2y5Z6p+QVhqsUzX0MliOpAmSdcu+hH8ynHoqp6ifjlqZ5hdlS01t450Nkv6P3Mj+L3lcU5Gu5eYoEnmOiPLOvi5qdceZlyTVf30E3imr60LjgmeJ5nJeo5K3MHDpNHU7TZU6/G/qXNrY7qJvcTonF2/szjA3xbBNmTFPRJ1jnFjaqrupuqDLetkmPmNqVUxy68UpRPKMfqsE3knlSv8hVWOMJ6ulZU3Bst4WfwS/ITc4MkhNicTlMdFVH2MhdVXOn6CtTXP7oidp+9V1c03vcopjutvmtpzjDcdFcVpLEgeMWIXEkgcBRKOrBsIgMFfVKc4gZvqMdP+wyZM0EyAPxT1HMtaCNWVWTc0zvZ50IpVNlHJPMctbcjFR/loqfkel1OvNUhzvnRDIHG9ckJ+sZ5jya0pKnkkduq2T+ZUuUh6ruGal7vxUEj1LvrufEv13B5/c6ZtftmArt9yBG0PSJQAGEGN2JKYJj6WAkg3lrJ8tG9MxX1qZZKFrjaBSU/IIxp6n+5R8r/68lRVvUxlIlZUZmfq9R2moak83quMiEU5itsxmicgLU5Jarr/ANlCmjc2fLSaf7H1p/Dr5HGV8f0oAMdCBVfumF8zTq+ZmAZXYfkDAWft2ErzBtqfVvHsLEbYZxAsbaVrGZslEVk7x03SgTkqZn4+YSK5WCcdIz0Jf25/AqZrjw6isQ5T7taGiWftXJPM5HZs/wDtTsbWNiuoSehyKpMQo3y8rNQsTUTWv9ruWpkZsw1d5BcdlxvlqpchK2eZlhDJryJzSD+vwcbUv282t5jY6m3aSfyzgHItkDR+OdRMzcyQz1w0YdbvFioZ/sx8f9gb1c6ZFRM/JDjyc3X+W5ox1pPs4nnfW3niOZ2lihU8xXOQgY1JcgQQS0H6yu6darV1qQmNI87J1xmxlq46aRK+svcjju+AmNy86epiRJom9sklNpiwWRESp5i2dM1HxAykUEs3s/JlRzvtupIoqJ7RyfH1PFzGSccyYmjXMbv+ssWlIRTjmWfv9orHQ+eXc4xy6DIHj6VKpVcg/X8LLM3inq6g3uH63PPf/rqVKor6f4hZ3PAlUUin11tAiWpq76deOqlmtjK7lWl3L4kBQCu3DauxxEZVgGvVnYeJIlQTmbjiBpt1c4/jsJsyTOPNxuX6idWkz8c1PUXM+AYki5pQga+U639stNPGNrRqsfjRc/bo5CNfWUeQycs1MzUs5cOpIQqLZ58cV1a03tlkKZ1uamL/AApqrVJIMZp1qTJWLfS73SV9TkPunFydRVp/bP8ADA7abPjtax+vIC8zBGMpy4uoae6N4+OPoyS707yQTHc6lAWpZmrGPX2g/wApfVw7IZlKnht+rzXIQa1bJNS1+L4rVMpkWWzxN1GOgGeqIH46CZ1Ot070FchmbfiJvmSGWpWSg3JjZqdNUMdGiK1w+Br8AVNrc3/njvpCqxNkMhL5Ygem/uRtZjGMxzNVUG5vGkU0Rrnd1Tj1pHbPPyRFnmjX4PyGOYW8dHMzqY+viaJyUlPFgPTU9aeifLJOFzBBcLkh+MsPNVIJpyLWjRtoJuCfHyf2Dtnn442/WLdVyZdzyh0dKdm6CZPrpl1+VESv1C/27OHpsFYcbyMQi7jCN99RktyZidNOGa4PPFeSqd1VKXQsaZ3SwT0CxMXlypvzzkCaa2YjQfFN+FnqiaGDrZenSzvDGSsa8twapljWSqRm8nWpB68yviaijUmyWUmlXUxDxPXMKlOWr561/Vqa2y7qXexBs53txDUK88pQwSMp5TxsRbY22UaHlrCGQR9PkZUfjMhiiTqHzXyGudvOzRpTay9J1rmn0+pO+ep1/asm2gaMesdLOqJ6pdGZPtCbcf15KF+1kck8Mtx0WS+SqBHkR/A+uOJn5RtJhp3XNZBPjvJc8mLHRohjrbTPmpfwQAEMpEn37zz40wk7QABhWyG9tuTOp38MR8kaeGOiKp3k0d5KoF8lpkn7My6ns0yoxNSmpTHqYZquStZgnpHv6uW/6JknX2pMmrYl5kqKnFbYOqHZmKuznSc9ceKQZTdfjIyThCtR8vM82zuu7rqXLcpOPmvHhS4B073+TciSgIxYBA+Me7SKY/L8ymvPabQqYxxjmZoqnJCUsiNQf48mSVidWP8Aj53tSaSj8ys1/wC5XXOGtFy1XRqrtrqpf13yUVp0oiWOJujHk2ayBWUmVnnmaLvISXjWvFAE+JWa/YXjxP1mtbyVLaExQXtxl1VV14ToTqSJNWTX4E5pthY+hwXbHOkShwDTgRYG3HAjRts8UFzMXjlfAym+oHij4Sp07eZ5qZNStKv1N21jyY/Blk5kdLQTbRVFM0B+uBoPq6T8djrEb3LDxGF1j1rJ43e6XR5vqj/I1Lz46bzPGPJMTuOtzugCb+lVNXkdvyZKXZ+02PP1JbqgirnE2E/XwWt0X/yhcM7zI3fpAWAdJ+UqbywFofHQCtZAH5eRKWJVarmkP94tV+HqnGG5inA3SXJOWeYqjt3V3SnfgGJQdT4nGEPeP6lzU1Hx0RCha6kN4pCetizup1p055ES91M1cXJ9ZgI5xtByEV1TzGmeodOq/KIEHIjChRZlEjYEDVUoTIUIBqw79wkR7kKmZ6qNfG1WS8dON4lklcaP1lquJQNWGRmkpFMSYXHD0GSMmIZqrJDtwZKmjkIiXRuCnyyUfjeed1dORufpU0ansJjFH9U/3LzKmwjjZKDno0RqkkxpJYfIP0RlJ/8Aysh91KUTr8g+l2lIciLhcT4tkqIwEamFyhUlF/TuUl3nBSS3Pxz3l2XVNuNSKVs0RON1ual80PLsAj5Bdz8h8vxnUovkMVNtRPMu9VMJHkZqutqx5MkXlqa/6NTNNRAJARjnn46qL6D/AFoehKo/Cct63XOXpAyM9fDOQjhqziBjmvoGpd1InlAbeORB2EbyrOy1n6gB8x/FsRaALRba6ORDDrHKzKuiM01xuvt/kvGSyzcf1X/ew+woTWQ8shqHkNTN942eXgnZkmXQ1SLsd6KDoUDnkMYaZmZyOOjffT5bFdHLewrmklr3TefGTQfX7HJE5ubNy9f+yknXhndTe3SDUUqUvpZJ4nhDjVNIYjFnw7SkmIxc8m7yNcrER8BSO2iFjIbyPO/tDka39vq7K1FNa/r+8Xbx0d1M198lq06mCLQ1VMy6kpAnc1LJ029TNf8A2O3TAWGkLiyJ15p0SNJ+ZeUl3klaqlmqh3FWjBkTUsLFhyJqb4l/JYy7Io5Bph7YKG22goAEi2yEsfYDyH+HS6xwM8cnKZySpOcc76jwBX6GY+2p6BQ+uObFmWLPJTRX9I8EFTRkVA8/JrUDM7CiG2FcSdPyDXE+N0FgRxkOZxoy/XyxtrTaaXM7pqZ4c607ntjqyYHmQ+N06qRaRZWfJJqkIQwaqS5SSGOxMym9QTaO8TiSAFaz5ksakoVXE9zrBQizzy/5KqmbnSp2zyST1vJG3Oce+SpHzmiq4f8AHrXw3+3b5mcbBLPUOjlG46uY6mes1VOMuiiutY9fa6O8UsbD71dOuUNqw1kygf2hxiz5nJeSnxdTIRXNU+NTPhPryqokcnxhED9A7e+mSRSCUQk2LBIAGCYcRUHw8y5BxgJJXw4bTHkxSciFEy64GZ7652dxpk6rKg+GeiIIyYo/+oi6ja1UnVO6/tW0ftG51v8AJbGOqkmp1gy6iat2lZMu/k3QMld+KL/sGvBVe8eMNHcmKNH2u6BKsXrGvT937d+TXncn5kYsiCwoYQxGEHCeY9SaI9MCCBjFyEOBITqMFGR7udwgQRM06lqak1uqWsdv1g+vPgdaWc8zp/7UTMun6lEzMmSnU6SmL0D5r/45i7pKLswhjrHXH2y0zc9UOYKcRSGodoIMV5/AajDigqjJ/Xhp60VLzNZRk8WLzo+u9QbKZ9V9vHpwgNlF+BbS9VLlXj5QHYhFRG8pNkDT4rJsq2SSnHBE5CTJUyOa1Z87NdyaU2zsZ/Ga7+QOZ4geQmZvNi1uubprX3da0rvGaTyPp6ulip3ddc07p8TMjVo9Fdag401UyUUjUZGQoq3pz1G6OaejeslePo0EjI/qp/X3CotGSDuACwkCkB9vMGwJhIzgFxYnxugpMN2Em8j/AJP1NU9ZHyOj4ZWealp2EcjO5nyy/iagotk2xlU+2/kIB+HTKsxsEUNboFSvwsMZYqqP8mxvGbpIjRydoeIqR4JpE1pd6GnNAu3IZqXqdrMvmmOZmSiZqbXQCadb5kEpke2bI49l7ahsMTM5AAUvGQ47AIannHkpNZBnLOmfjlmhAmdh/ije6ecfxss0zQv46OyUcXFTcTX2PsTqRPkmdHU0/IzytSAM0fk9Vj5mTGVUkOWCgKpFarrT+nu0XYSzrtmMhUY8Zv7amStVXcu2qul6+qTN6/cbK1qlzJSLMNgQCgOxe5uHqY3FgMAi0PGWgNg8NDFruafvcWLE/Vd6jJQgS/1SekaeipqJGdlT0vUH0Vimm6PFVsUPLJeyjXVGyn8GKiuMUMTWQmQYqcZWKiepqjiRrZVzIqVDR9X8sc11s4Wsj4Y1MtoxXy/WKukdV5roFlpSsayC1GflSYQ5xgB+5059Py45GYgsv6QwhB1ZwdtPgjnEzP6gomTG5Mc97q92mPYLZfgST82OHHMLkMdfLUVktyeGPsNA4vERNeZGHqmp2YygoYuzzUZBavFNNaq4p2d1egw7GSjkdzKzztv+kyVU7cMHM8t10r9Y/TdzWWyqTEkya+r9hfzi6vpBnxxZ7sK0MQnqqG4UcNlb3QIX/brYYQxiUGUu5qX6rM/9G8k75DQ658G6n/fWwwmHFlm+UErSWEfJdkGNN4wxmQDUw6Fmb+/P5rcBXVfHVoeoIr5CpnkZSbgnjmeEaNEncyE9b3cemMlveFu/k/YeWZo3A5e6MVNAMotcw80OvI61QJKuw23SArp4SPM63oupg7bkZLGYnKIbOug9HTPLWEv/ABMjUH3oUjILXVVrZir/ALLr981Xq3/DvoPW+t/5O/hGX2/271fu+b23+Qe2e7es9N7fhq/VY/Q+j9Ti9T6v1GWYmpw+mwTFOXOs4ZKS6SO3yKeSJfPx46nH2SC/ZBpq1+MBmrnwkzOznVe6f8He6/z/AA+5fyr0H/H3tOL1vunuXsWH0vqvc69VXpo9k9Fh9Zi9ab9Y5fTzj/8ALrFMPpSzJ6jHgajHlfTUYvA/qvUNHwXxHp/th9M0E9Sv0UKpUk1E2ip825PR0v8A6gZZ9QIABP4ZRfbbvDd3/nr0f81919+9x9f6r2nF6e3Pc36SfXenzZ/TYcubJzgt6+UevtMtU8/WpFy1fyjh9F6qPW5MHuHpsmCiqDJVLi7JknHuuC5pl2wtWTxQ35fo7/ln0H/KH/m5T+Re9eg9V6jHkrLlx+nz/Jh654y4CqwY3JcsMuG9HC9Cd1fz/P8A9PsfqB9Vn9PkxRkLcRkKxlSpbQ+ZJNdzuHrhqUyVdc/9Ipq6fwXToFfRqoFNIfSZCUL6IltRc6j4hVdYk+psYCACvsVuXwcU/cPS1MepuCJJx5SippGh13OJVlmiT5P/ALGjLJz45aDwfVJpIyVUPYpL1P8A1Zx22Tw/pqJN4qfz033b02QHiTJGeA+WpOpMz5qKa5YA4VrIz0k1Zv8AOE9RDKTWMxxj/wAXJHJ8hJzc49yBP6L2IqsTyj7XSmg2CQUvY9otOubqUm3zWEuP8VLIUQbxtqhkyVkpnCdM0R3EyVkk6xCO/E+Yi1kKfoaObUAY639Tdmufs47rZ8V2Y04nTt8JLaNDuLBjPkq8ndTJVasmYMyzTLMG6JNFSa21LPhD8VeU73dN+Kw81jOovfjNtyJjGqoKXoko0cutxVuATa6wGicdjc21mABOybAugSzmxN8zjXU+i9ZWbFOKpLy4K5lqaVt/dt2l7x5ESmeQoigoOm/FM1kW8801WTIVr4rqGuo4GHq5fseIQY2lOuZxeprDlxZQDioxVwVM3Xjbl5+1TRNS5FOtNIzDJ2fp+M8N4Ykjmupanory5N76845rW+qp1oSJlmSQC3BPZ2eHiL97HW1BdxISnbcG8tfuNa+4nL4x0RuIySlhNTNUu4vbj77JMclNi46qNTIN4q1DMVOiBo6p29k5QYpmWuf8n7k2BJJZYuaXnLX1nJxOMGZ31E7z0k5Uy6TWgftuRdlrGVyjMPGKopqXXM/rWSnVU71G3zqv9T5n1EgiMcrEEbNk8ngkuWcQt7Dl0vEI3zqt6fqZx3cE1wQ/WqOvrqkv7TLTsuaumShNz1+bDFMJU3WSIiXHV75qrEnQ3Rf/AHCqkNa8Eslfg+nxVH+IX1EkvDRKzHFfVPk4q8f/AFCdBYzW2t3pw5P7Y5LcdBeMhitydzlPqt2VWMrbzdPN/uaINaZZ3gMY8wML7HVC0AF4HYe8Wzvq5jjF/jLxVXN44am3VZTt2n3n4qF6ubStb+vP5sqxY5wzBkIq7KLg2w1NAVllPjnFRqSJm5xzqaH9rwY9VcZJMnybrHuZax1dMyd7k/xvmcZtGhjSbraYJiqSzoe5eorVZmkx5C/rE/t1kiZ4TSFQ/nn9fqgm8OOTsoPYchoa6OnTV8pvYK4mykcR766n/jb/AI4/kP8Ayd/KPS/xz+Pe3+4+uyz6f/yPdK9q9L6j3L1np/b8VGLJ6jHhxEYo9R6nJlwek9G+rzel9Nk9T6nFjyZsU3kJ9u/mHsf/ACp/x57Fn/h38a/gPo/4p7Hh9VB649z959m9y/lPuXvU4L9Pfr/d81e4M4vX/G4sbg9H6P03o/Q759LgwmT1NZeS/wCFPT/y71n8n9Z/HfY/+RfVf8d+1/yL2uc/8x989HlvFn9V7B7A17nl9t9F/wCOenzZ/W5skx/43psXqvSxnzpfqc2DFFc0P+Yv4F/BPZ/X+uyfxD+efzX3fHmMtR63+U+muM3uJF5sOX1RE4MJjxXmmJm8jmiYarHly7x0/MdSuvr/ANW6fw/V6nT/ALIFNfT6R6XVqBMfNVUDTRSXYfMk411genpGukFliqoGkQsIFJ4476+Zf5TPvePPT7t7OfLbzkyemjneZtrJV36Zy46uneqskZrHkZA3+cr7R7zl9t9cXPbgp1mwWVMJ1JxRMSNTEr+9SNq/Fv8AFe45PcPSZMuI9ZnsxZXFNme3F9aOaNXR0TG6L/XS78rWtwe5e4OWoMjklW7ckmUpEWNuOndT1zt3qqXou2vtaRSKaelUKSPSNwCAKbRjE414tXUA6pINVJeZdrnOATZYGvdJ9TPuHp8fqsRLiyVO+5E+RG7cn2sHH1J2TvoK6SW/zW5K9Rbc1x0NNVUnyZNclslGKP8A51UT5X46K6pI/j0+pn2T02T1U/Hk9Q5WSoreLDamOh5xhCTdToKO3mdvH4/Jiq51QJ0Mozw4Z8f5Plrd735/tNVHNBl0z5pqoorqopH+RETEBoybI98a7wSaQakCaQ2thIBOXkXnWlusmPNkrGPN04aGWDq9LWE3xJzM6ppJ/wCvUjuplxYpKPnqYctamnyzWu9lZClK0bxaMg1PXdyfmyYjNUzxw1zVKREXe/6s5GuWm1t0065fj3C6/wBSVZOMg6x3GOudTO58UIDXxkEK0kX9VJJlOrpkc2jYNQ1ghG/2fP1PwlWQnKEfTOM21WpjrH1jp1kjHISSUTsXJ+7nsBb0USfaJ42bD5kA5+KYqMQVTut9m6rLr/E7JOV3JI/1+1G8uLDV18RTdMtkdXFKSJ1ZvHMCl+L66gejmofU9k1PdmNImWqKyftLs3ay9Sd6JEaVkhdDQKwyJCiQUVGLszaz1mKgKoYIg2ErcBDOzQkM63OD1S3U58S7yydQryakYr5Ceo287NXRvYXLX5t4zfNOT4noiqlSz5JxIUzBvJFA1IUhErMU881+c9hpqbMuUylC4292RjToZqudWVsoTrbudUv5d9NlqWTEuKnWTzRjWN/eY1J9dzuOghCwGKofP61IBJDZy4kAn2UJco63pPy+oAsmWCNr/uijbb3/AP4m/kh7L631XtxZj+TJ/wCR6SKXiY9VHw52oy1jx0RNw2cVJ1fiutV63/MPaPV+++h36X0mb1GH0+fJM4seGXvPZ6ioz3fpxs3eVIzEFO7ijLJvH8meh9Tm9v8AVen9w9P9smLLOd0p3jRrJisxzJXMwvLXiNrT4n8/Rn/gn3X233n/AMCawen9VN4+uLjFWbH6vLUzGfbnKcnpTJMbp3GQxf2hn8+T/rNZ+Afx3T6Z6hABroFjb/GcZMCden8LVT1F0yaaQF6TBMgR7FLCBJtr5N9Z/wAZ/wA89b/H79Tm9un2b2vBM5T1nu/qHBj9ZWLHimY9Ni9VHyZGSiZCCZNc3FjH583fyH+Geq9pz3OX1Pprs3mpi4TXmbxzdY46odnIhkkq5rn6/n65/wDMfrf4v7lN/wAe/wDpnk9RXtxXqMnp8ZE4sN1jv0mDFmm8hN3uZjP/AOIYjrNm+PHGajK/lx/yX6wxevyzFuLDHqfVTGG+r1ctj3Rkpg+uLUvPx+Wo1zvt/wDTf9V+I+PoFXU6VPSbNNFPTI+UpSTseGjEAa5fjuj0unPqNSsW6QYEkdxeWNeV+np9PnrXKSrUNOO2orHoxgb3yBIVrZfg5j8oeq9dkc1ZWZr7OH7Spjrv6ZRol5Ns/K3dHLHJJqtT673HLGSp30JOLo8BloDqsnW3cgXW90J/qdmo9R6vLRLz+yMSh56ula7qvK88mTT9tH2e6r7CmltiYQzjI/MtzwPK9YAUyQrWjO3c3CiSLnrPU7R0IUzUgROTuSeqyleV1ztdZCdO9kzpa9TWz4ofDMvhmZr9lj9pQ1W6omZ/qwjr8HNfRpqvr/kaXySPnHVSdCG/E/USxdH4LUxM1RPTxAEOmUl+Vqnw2zW9vS/fSzp2pAHiTCVoD3kTb31JM8nbxE29TxZabjmcJ9PFdC+MVE2gbbkQx9GiaN+XRVKfg1m+Mq2o3Sr1ErWQYCcfkL00c62BKafJ+YfHTp8jWyqqft5NY7U8HVJ9Wj+xHn+ut9Umb/GdaLCPDr5CqmTpaGdaVjnfH+tNFMboWg9gFPBxE+ZKAusYkGx4kfSS71M3+W91Nf3U7XmY6nVaZJ1L4Q260SvmvwbnHj0Rr/JRTX11LcnO6lfrSJz9q0P6datVGSW4knbBIyFVMcs2d0hl6UCjXXCLPgqs41AHVNTc1XimOpCGqDzvweNIOg2Kgd+/BHy78Xshhag33PBM2lYF39c6lyZMcCMbJme5kpIyHVVeRQ2nXWx0Isv33s/asWHP6ioy5JikWCwqruSGcTOTQaqjfIbpJk3odbjhtdb8vWqu/MTrYQyRoVJWPEjsnX4V4c2HIZMReijJWSdFR/1ZWZ1PIlaf0nOkNgSRAsQAkYgGDf8ATbTdgoB4LCH57vnW29dOX0HrcP0c+DJeNiqx3M1WMFxeWZMkBT41pOno0z2voPUz6r0kZWr5MZiNy9GQiq+PnbvGdfoNbJraQa5fD6mfdvRX6TLFzmx02UVuZrHjJm53Kjb9Lo1tTnTXbtfZ/X+2ek9Men9T6vBh9RPcVjzfIslVMy1brm5I1Sk0c1ua+vWHVHqoMOoeD/iMmUp2nV0lGNoGCYibh4Oz1f8AU1uapnh2RWp/tk3qm+qu5b6RqtbZSjRL+azLN0S7xymEppAh8PPVv9lKN1OjLIm5TTuLvD6iKy4suLNivr/LAZI26+03K2MwzU9UVt0tNH5psg18lMtMVYlHLWMkj4yKKeapOuAlrsQ1NVPSmmmFNj2EHt776KzLte6QtgEj3x4Wsxz9bmWT5Jcn1sGJZ5ce+J3tJEQ3pBiU3Hx4owtba5Ys0t3N8y/CpykT9l2DOm36gTmrE+7v+/KpPB+8XWgs+p9Y4m5731/qHLWNbJ2b54oGZWR6Jh6mZ1YZK+0PT9jfX6KMA8DsYL3jlHB21bhWmkPmCTY3F982Wo5WZtxm61C8zlZtmbcjTXfUj1fUtR4n97ZZiyUXSf2kyHTVY8lG5aImhldqdAf7NdHiJyfNkzG9zGOoJqFcZBIWdX/tanY7N+Q2P4rJTvxZJwARhoMk7oOt7pu50s65qBKfOiiUBUCwc7jdWVzAgd9ULtqyJOxAG4IP2mXppGGY/pMbhrjguxkN0PiXipAfCSIjrzFOKT7V22lw9To7qSYyKBBNK6idiV4nwqoyLHczM1MmKyVDnXTXxzTW+Tx56i/qjsaipu2TljmZWkmepxu8mu29fL5qQPsAJ1Mv4G0AYDNxaTggRPhF6BUZixWxHpWUVwRO4jRZzJxjxxzEDEXlk0kumUzfZrVTRSBsefs1SWMbWPXgEmSdSfdSWLK/+VGt7KyEnhr6tZs+rjhdxOGuMdp9vG5CkdMq3SE1sBndmV8NTMvdf1opJ2LwfHl+zjk66dSbPJo3NM+pFsokXOwEcnKi+kT9EZpKxGLQiFu9Nu0yKNZou5+82mu/NxqJZ6NdMTTz4YaGpmbbtk+XjzOtywXE7gvViNO9SfXsGVjc2DNTkblKl6PDv4rqWAxs011KtEaknUs7E6uXPE/+zGw0hqY0VvkfsrX2/RYbIjlN4z8cIEkB5sY9NzEgDPhk6YRJ9V6rEQQUL2EQQ7IoW02dydXj6SjH3rwnhlqrdo0b+U8v1UKitwzPTOraN5cdSysQpX2cYOPHta+prU+ON6F/M/Kaoxzjwi5EVsnSz1kCao50oSfVJkTzPp71NNV33TO35KyTX0eK2zTih3oAKBqTxyP1B+kT+225LjB5luCQbtQyUBSCIIDJZZhzTcljjivl9Q75KFTJtrHdfGaxlc9Gljc/6efGSkrKyRkk1fLBFJY46bK2+X7U+SQUVpx5DcyyTn1cs/3ElvhgcqvPd3sVejIs76jX6GlTMY4rxJWTJ5UNnySA/ICTjKP9Czo1/wDEqqAEWF8wvJikBNzlQEHYaQYVwP8AkQCYQDhlHmBYpDVmfUfapiiajDUts/HNcj5madOV3ztmdvc6dlObMgW45k/x4nwY461v5OVVh/q1s53QjPlEcWPDtQy5KIK+PbfySDku01yJSM/bW9S1NaZqoZ4zPVYTruorsNpUrL3f6iSyQGp/rvVTAhiSuUUBL3mAVOrY7pRf/iAhLSc8MaDI5flyag5dhyM8bU5xS3JShdHj+3hRlj8jCI8VCVjtMNkMzk2clfJapf8AYaREGaegpjtnFiLHdHLfC5K3Ox8o9wi0b8TzQNbGwMmMufvBBPP2sWp8P9jnL1Rt8/ZT7CBQRliBbMqfFkHddmD6ldi7MQRsY2UgTS4QBxwFGQZmv8pRcX0TXM4QyTJuaNPB4PEpetHGOpwz8Otbj7C1XKFDVoEuNnTRjdFaN+X8VN5EV+t465ot0cwDrV93U1XhfDdax5IPGRY3UHyTXb1LopXDteX9xM81tqHpno1sd/jAG2Nr2EztTCA2PBSg4DAaEqwsJDABigYjZccw840MjTkPIBPI/G1PlCvr8XI0ifbc/ixyLX+b6VmOptmH7MeMYwE1+5cmNAqBg20Tg1Wa/wB2Wuq4N45yEvfY8zjJr9TtkSid1ta7UOTHJJNJo7vF/XvqqrSVQKFZKWU1uvxDhgepIRZMbLPc+5ScUpBMwC3PyqC7r/kxzjGIxfbFeqrmeqTgvcx/WdGHrdD4rYUTKeWkRqe7NkznblxErr7Y2mZWLOZkNhxrxRL+KMtM7vFy8mBHpOvqVV7Sl2/+x1TyHE0U3OWqfhXVNGLmp5nHPn6/5Adw/u9eWgpGf1YIFkxZYsQ8myDnm2r9QG4gE944BhdoO0M+TnHjYMcaJ0ctcnjWWskLI7J5alp+pQjv8DvS6qbKr9p3Uzk1qm54I+P7PPjW2pATQ5gx83jFF4ryk4yidayQkzE6r66fjftpPqliAfMBMS6+StmSsbKsyoXev65NzO/DP0H8oslWRVkAIVvoe3YGQMgjK8jjH0OjyPyZMWid43RTj1GUlieNaaqq1pNT1ymt9W5lvJWSquFjoxEBXjJomMgF9TP99Un0NePpZ+R8uXFP1Zsu5Zt5qsXXKdZZ5+Mkmup1f775er2J6md00d/e5bqHfyKcNX0b0r9zVG11TO/xEh7TLCDwhn6ztOnu7v8AQQL93n30c52q24VZ1g8do2frJVLByUeHQl63PRsL4sjz9OrmY89Y9UNmxCWUN6YxLFeJ2X+q2TeKBrIVky5J+SjtSL19eyTnTKBz/tp3Gga3E4Znp1vGQn9pHn/Fkt542lKRO53f+mX8GXN7zHuFi6jiTqKUARV3wALIQ/woAO4swNHdwEzhhD7Y6o0tfXkd14Z3Ouwn9yB4/ETePHP3lZt3JytRtkxy0888pTDy9TLUhUkuGv2y6CsP6fK0E7aN+d67PKn62K5JeWpN48ZEizYfe4qT5YmhLtMlSs3jqmqjys0IkwkO/wD8cDbfaOzzwhkmQhmYSJasZFsvIzmrTN1U6n6mj5SCdZBiSWuiXRXQUba4DLqt+InWKoezV5Lmp6rGZKJuqa8W6+304/1AfGZ523c1Nz0NsXUzO6nmh+lFfVNIqUSvX4fxyYZGg41kk3/aBBx2UzkpqTxIEosu16/AGoAkgZYN0UpG+ftZnLjb6jFTlCD2EaDLxV4mn7zp+RAl1Rqci0r1dhfG5Q5dVM1+Mt+UOsvIUM7fpUzIf+ynu1UOOjoNbL2/ipTnNRR4myOpqqnVw8zjSWcYsjseXufHgkZmrmWTsmYtteKqOJWHcrWvj01K/wCv7eH8kFk8yd8XF8TCN3jSzeTBGUFKRZHEGksHc2477yV9Ihxfbso0gZzqxdrRNSt/vwciKoxsdIzTmWX6+L3Hi9VSeRuss1t0lf1lJ8Ls+r8aFVT1k1rRzkm2v+pt5clTxo0V+OMs4QqrKy0ylsy30ya+Wx5mZ1Ty9Olrbt0BESsOxk/xAPUqmaT3ARfqABu1awsgmUtTMVluqutM1dyuieYo3iO/Fv8A2UJmhZt7d/k5bq41MvM8KQMCmKneTHqqnExJKnM6nbJIbhrqLOWaxzW78xOSoyHU11p6qEADeQJDdAUEUfLFJRNzcaW2Jqredup/xB0Qu6KmmZ+ofgSGB/4tbnc352uFZ20V/wCJJJOY8Al1XIwgE4iZF9RldzWzVV245ailo3LuenUBXimvtVCE8dV30V3V9Mb6NkzFQrddn7McvyGp10TSvJUznDLTmnmSJQMMXT9S2WZb4B7BrY1zoMYy3FjgtP3jIIMZ1NK8s3CgCbWmrPNB+pGDcXTdmbXtdKZtbUi3a8gZBkAhWQLfD0pyyRD1Md1OKjyfbc3TQ9fE/tL3SwaXw6fENfvUpGlutdkcrovbS7eqNdcyHKAJlqwheke5oBO45lx3V0dRlUf1PVbrxbpbrvzN/qmqmqIWEgSem+4rrUgkMj0cpcoSXEh98r3K/D9LsG36Ri14uLA7oySqZrN823HVRFOQ1zdzzs5q+1r6Jjrc3zxz0ws9U4xY/wDXkiU+s9X5lu5vpBK5mz6vOrPqIl6+T46FsyY5iw1NSzzI1ur1X+70TczqtVJy7LuDEdf5UiKXZW1Xv5K1/bknrmVPOjX422v4fynQGSRgRdkGM9mCrYVyoLBbhSs/BdC849SeGzVTo80S7fMjc6GY2Jxs1YDc3j8zfWN18ULX6819PrB4oebTai8VVZjvfMoyjPMvKzNWUXRT9blIlE/qC5jgyNLTzH+Ut8bAl+I6hHy/1AHbp6d/iFwRJMoH9MjuPZASGCAPmasZY9PAaHmrKAhuSmZm5nq4J+vHTk35stnXSTP7Wp4Ohr8W5XLz8c1jKorfS6y1Gonn/LEBKDkKrX1a2z+ZbWKAUzVVSTflqdycGTJLIcs19ed8eQdfgk5fL1GSWKqShPo60xbOMnIKk4wdLvXSz+I3QiQxDBiTJ7xT99VLsJ4lggciGDkRc31hlqeqY8fKrNC1NdRLllrJ+tqTLpd6RZpLB9q19WafllyHN5PJwTLNSfZ7iYf/AJJdu/xBGO8k1UfI4pbhyETFWMPCBXdcmk6762dgTpmXqsFWdeHE1j2RfxnPfNNNQVuSUeR2JJvbpJDJgC0eomBZoeb9jopltju5Slm+8koFFWMzeRy5a4LsEEhkZPhl4lyDbVLXyTz5dZP19sXIZGkL6qoieaGZom8fFUgY13tChoeT9CuSfPVMm7p3Ygb84Kf7g+eo8g9SaPKvLV2LNc3io4hXeXHPBUUNfIuwGaqZJDvT5/AmN4ZFmb5mGRM/bQwASQBwLlbCDjwbjc7Iv4lxuSj4iq7BmhvcWwJM603pKjxRuEoDKX10QZIql5fE4i0IvHZt1P331KQlVU0i/mfXGjjplq/PTqZqubxtOPePg8cxyoLfiUCY9RzWSrPl+SvjK53WPsix7+khFz4idVIyg0yqBEuJmYcFNJxyrw9T6WX2sTH4T6W7WuJ4JZL71l6Llv4y5TiidvmJ8FXqk/x63T2NG9fhY8Md31Tove6ofkDhmWb5OTejkrpOZSkaF6zaq6/czk/6c/FCjjNE00mqo0ffvaKbjJ92L38m5xJvWNYGYoevuicFY730c072TFgCDfh4yxnhYey022kbG8n8JZA44JW1tCmTI45MSV8kwBtq/t9jJCVQPIH9YZJiuaSvyczirkrEzpnHVyEHQcScXtIsf7SlLIM9yKV5Z+qbAuZWOYq6K6mqeqvmv03KCi+A21+6yZanKBbkrWR6dBWgurlWWq3OQk2+NFm2SQIlkiOLQeHoYDByAYPZo5LkE4EKdEmNKbx2Vu7x6rdcAcyxczrF9tlSfQEGakE2OYi5mLOYBkLTdNTXybkMkANda3+w4Q/F5xHHknIFMxipmbomfrz8lFffoljJNKulDWq/GHTjieg38P13dzk8V9bBQP8A7VFaxtfbTz+S7iIVmAkJY4+ynUpkjhwSIQF7cHhFkFaJxaxOkkqTItVCtHWpyTz+krTiN9IOjrzE44ZgjICTJUXyTceOsVFFXfKk81M73xzzU1U8mTHNY1hipnLjr/TBu+oPNRuZgbWpSpvUtIrKmKKyWVzN74kZAq4Co3RzTpOHV6EZf1JFJ9X+KHNpBm1+dzoQusYMgMfTcCkzy9TVF3XyYvklmcUsTU1FTPE5oGySWfk87l1G9LjBP5GTnIG5kxDUJzfaTdX1SNK0X/dCmgqY/FF71Tjtpx89SGaaeY1VBq+5KGtGgAZ6drFlx18dzVBN1M40sDVF11GTnLWw08yb3dc8z+SCbi5GwDaxeNy4GswX6mxlOEPTDhEBB2IWfmBXtvpzjUk5hqo45NvJ+i9bOZ8zk8tUrx+Iu61/txlcjquYL0xmjWToGTQ+ZJfAldfk5YyWDjyTUnOSY3MbwmioHmGaED49MDaNP3ZnES3WNP8AtfNXvkoIJxJkZLBejXAs87mvLJBZuAwz7SdsEALYgZAmxFJAO0kX+XmQASjYBhSZMfcxU1jdcTTjfjzZHw1V1vQN0U1oNPjuZVbEfaXpqbpXwGodTjDIArt1zIVq/A7n8sdB9jl0IQRXkSWskm2evGps5/30kI/kJkvFiUS24oInTXcnNZH+6tE9G5+tT5CvILYiRugABZIuIACO41VKEFiwtb8OwVjJO5vpGNxY6QO6vyUokfKFTN1NBJK715rs6dGpC+XpmcdfcDpTXXND+731Vf8AVNGxN/pQkxVdTEXjurd3WuO15I7vpZFoipieqGR+u19R8WPHRRHXGPZK0lVv5LyaXcsh1oSdcz0eM5ThMsg5hZHY/kSGM0rPHy7hGCMqFEGDomvjbqorJLXLOk4uwZ1ldT8covmUhB57mxB6anKRVePiyTXnWnzczPETJ9oMjXh70U9dsuqKniw6mYrKSnmtI1lmqGna1QVRYmjazKhJtTczjskuZlqnVZK2iP7vo8V+jzv8mpsbY7kALlsifbGoIq2l1I3tSLcKBS3CcaLBWRy03Mnx/IcZDcjNz/6WmiqKVlE1XRy06BzNGbcE5jJkNLFf4vvuQrfE881VB1j1XyT/APZAZkXJ8eDFcwmiqmeZWfozOQP7N8uo12BHlar8lh+UyZMvT8e2cnKTt8OPGaK50Mtfcrp1XX5lVFIQSIZ3tIJQ4EBD6AFQFoIEnI+UZQlIIQyLEHToYxdVMHzZL+IyZQGclM1KVLMmJuegN9s/11JsouucjUdhlZu2erN0VuapncRrwgTDRAdCKYushKS46n/FYEyl0UN2LVB3QVQD4uaTkpvB8cYymZybxx1zVC2zRlu0R2+OtLRMJOnzjUeyG3/KFFyS8/vpwERFjCJbBZyQxg3Ql6c/5WYk+uN3O9JlYkEequmbeeY+rR1Kdh1scPp8WOjfM1l1ZDf2msizWITnj/rW7NvNV/s/NfhxzSfbmdt9HWNue5+jROr+xSE6h0xO1ip2+KuupRicJ/kzeKLzYlQZvu9Vt7sjqtVF7canF1qrmAcldgFKv/FGrj1UlkBwJGQgph7mM7av+n7VnJiS9OGqmKTqk3V1fNeVa+WDejnRU7raRUD6ctl889dRUo8s/Jb55q/ozKLG4k6kv8oYsZkZ5MJc1Lc/Lkkyk7qqkqdNtWfHS1563KFfm1wemxPPZU9MZim8X1nbHw9eOY2s6kKbpjHR2VPkdYhgCWgCsMccpWuDro6fEQDzbtttexWtp6fNNy5akmYJxZP8OSTe9TkmRfJylZXTNngaXfu3/CEf8pZT+Vv/AB96XBk9va9vze6+4ep9XPpsGH1uH/yM/pPTRmfjxZfW36Z9Xln0lGQucd1wy2vheLHLMrMzjYJH4NDkPpi6dmuZkZyfV5msnjmmvof/AIl9h/5n91/iXvk/wP03ocf8Zze7Vn9X7p7j7j6b0ODL7p6P0RfqPT4oyZMWX1OLH6eBcdYM/pukm6mmj8+Z/rNVH/tq3V0KQa6aSeuf+kFVTBDbAZuHbnWvQB/uAn1ICRTeAIatMQ9teb/8n+l/5Py+4ZZ/kPufovW54zXdnp/UY8kF11OTEyxHWccTRjyEn2GZfsniE+i95m8hcc7qoy05NnNKtednwlTQvKB2Fdjr1r+bfxz/AJGxer9Rj959z9uz5S/nyGH18XpotqPlmIveOpT4d/RABBr88zz+2+/YGayZ8N8BNOLOamn9tfX9x9i+yqCvOv0bf00in4aigVdBemD0ggbfh2EY4hay6v4/UB1QfUD8wBN6XcPvO8a7v3D2/wD/AET7ZZk6J9HgOu6zHRGSmKgkitKEgFzj+53jumPL/X4r2yRUTNk2SuN7kqGsk355HxdGj9lfvT7D6PJWX2jDirLvH6d4ZrWQnJjxDUkcz3j7CZJX/tUn9n84X3v02HNtDnIXNVoxQVeOa7+tl05Z0E/ITNJU0alyPV8N1SPXQSSfUUQuLifBhPR1B8oKOyyogzYrFvfXA/Bjim4nmswpLUmOap1qLlmo5/pJUr1VhpT8TmPOLVY1qCOtHJVhzbllJKd2NhKaUUd/mzzQF31MZG+6m02xDzUOS4qpGUUisZroqtv2dbmYgfkySlKz9TJc/IhEt8wRzUutHienHO/H56L9Ppy5IaSIgDL2Z2sNYGlAKQZdpQ37byo21Sy1qtsDqnDuZnTetuS6ap+2/wC3JWh2I7/N77P7lcX8eWW8A80JelIOrWrOhkrbrXRPUhXOTWZMS01KvRjy35mjJP7uLDko0HJp1JW03QQ4mnsjgLKIDgsd+Q85IybqUgPH/YBpJMzYwrIiBaR7WgkZ1kW2LREzbuFc2Y2N9ei4OfU4/kx8sTPNfJxCZDd9XKVfQXyZFPtR0hwjviqOeJnJWTSXqW5utJ1kOCOaxpOK5fNGu1ZeT9J631Xp3uNwfIS3qytd/wBsk1QVBwhVh9ttT5YOt9Dmxepr4/URQ1bdZSY3WI2PZdX9Sn6sL/8AcnUm8avVSQjBlhoAgP8AVrymNdFJJE3Y4uAHPjj5rpnWen9NdNk5TJJXfN2SmM56mNypb1PJF/HpqpdXUluSYyuCsfXyHWJCNYTkx/FlYt54vmYWdCzXnqZm6+nEmsdbAndxXWJnVV8CYgDuTWmuYl0UjJ+QYCpLnvFZVybqTITvpw1hSO5rImoal814CmZ5Or1SQAyuCUM2yykWuRrakUjExcGBCHZ/6ReinBUxMzXxxUY8mSm//fMN5GaWGKyVooJfMIfWlJ3/AKVZqXFMZZqSBjGJiKH4W7L3OUnU21TXOslFTT+a7FhcTGFuW2oqMh5pjJL4yZtEnia0MGy65VmcjtvTYnHkox0U31fxl9EY/wBMyFQLNTNRCal/aLR+cNdVzByX2pnnCwsa6KAfTg8AWilhi3mHAjXoP8F/kD/Df5R7B/JYwT6m/ZPePQ+4+p9JnrIT6nFOTG+o9P6ivTXDeLPh+XFzWXkDdbhJPsT/AOiM/h3u/vv8S9L/ADj2/wD4+x+h9i9+9tfevbPXes93yZfea9H671M3h9dj9vyXX/g4c8XBGOicFZsmCvTTkx01Hxd7N6X0/rPc/afReoynpfTeo9z9s9D6r1NdxMYc3rMePLnYClMeOrtyUMQzXUIV+foD/wDRg/8AMn8M95yZ/wCF/wAV9+9R7x7Z6H1WL2vF6L0OP0+D2r2j0/t5/wCL6fB6S5p9Jnyf+P6f0tZfU+nnDgiflv0szdD+fI/1Pqdaj+s/0s/DdE1VVev+/wBT5jRT06T0yB8qDdRvADiddvTFNXw3VFRAsRGUQkAbZH8H4kfyCPUYfWethi6r/wAnNjqrqtG0rzvmdyGyvKn+R63r803oYt9SYaxZL7qsfJ0nVVMlIMzWnTRI+RufvNyegfyvFhye5+uY4x9Zs1KY2RrrwOmoo5Ghx76rZLIj+cn6CiPcfQMkz8XqvTQrjLpr5dH1/bO6ft9b2Spy1r9IpqNdAqIL9APnIwYN3A86+brpXXkQwJhgke2c91r2u3/w/T4cWvkwRgx+nlka+NkZ+Sa3iiKAavHMzXL1z9kKvqYi5xVlmqqvi1fWNhmiqDJZOjHTJ4AqZXwHXGyzFXhpL+O8VdVE7hvJhKuqvEzVBdVo8zzNXOXR5mg8YiQ0fJvooMg5Nl4qrKbiJmquY1JkmTU72fnkAk1O5aL8BW2n/evSRpABfpgsYP6AF7JO2tbmwxjuplRyNZXEcyamkZx1E911zMgm7BL2ofmtz4Cmax5TFk/98hcmsS7qAJkpGB5p5RY2G2b+a894YyMqtVOSwJWjGgprfxBqy1xuqfHU1Trcl1NfGs/G4/8APVTVVTuaY7qpK1MZdzjZWdgtyl9nSMBJxFpVIjjJauPOXUBNKd1ZYVuCmrJHVLJgx2vdfpc03W9Omkmm5aC4rzycABLvVfmTMGbDQgyOtczHBM3jk5aa8xwTepsCdjqk7usjJATJJUS6nqApZltpce6OIJSueaJGUqbPluQ7W7mFCGepccDkqZlhS5mogS9cz/o7BZNlAu4XyvsbAHXMSGdgQyOF9xsZnVuqpoxpGWLySzlmoHHC1/hrckw7jskg+zOq6Zfzb+ky5bgrj/qYJoiut+Uutopya+R3SD+jG70Py0smQsmUwIGSWaQnvJuhrYu6OfuW8HNS7rBRzM8OokjUxL8jOp2VV34O+p/r3YjvfVcHxIinw7jjjkyr860oqvGxE3gB/wAMnbXWehzfJjlmdcz8Vwz/AJJyaVq5paNUm7rdwv3iuen2D/jT+cP8T95w+o9XOa/bDPhc3wmXvBZkivmxxNYx9NbNVlxRMuUkCjKY6fFIvdDGd1f+R5cYfGtHxax/3allqFDTYUdbra+lzNyxU5C8VDMqc0Y4HwZGq4yV+oWpyJxuaJb8nr9Gjr9Ovp9Sl0V0pHAiZdsbxa2t+nWaDRWPSx3QgAwIMW17l/yZ/wAier9R/LvcvcvT3GT2n3Rn1no8+H5ccXgzTjt9NkyOgzYyHGTkbyemmYiGurb+Zv5WX71nr1fpMd7zZJ6v5Oq7ourl5cmoJqZa345i6vLJ3Pdep9VX/ivpBjJ6fN8U58OSNYMdc1PWMqK5qo/WWUs8ydAn5rMP8Z9f6r2z1XvHts/J6P0fro9uyQZLqsGX1EOTA2T8cmLmbJyVWjyTNRSGvwfS+H+Do6VNPp6foFPTBAA9QgAEn2zNiJIrqmvqMSqi0xsCuAEfr314l6z2HP6ecufP9IayCN/5N672TQU4ilqeDfkA/Z+c36jHhEkuBfjldbnlX+9146tknaG+tPNBr0n3z2f3PFdYs8ZQmvrS5bamVOaoL/cy01CQpeRmt/Xlr/j+fIP1DqzLMr1Tt2463FM7anQpI+KQRPZ6XWpILrBLhIQURY4f0sU9cNVB9RApIBIEie6w0CLMweOZ+QJ3OgmTEgSS3vmSS1NUIN6FVhnyn5Uqd+eDbzjVPHfgm1f0bPqv60yAf26nL/H6xS36jIFVjcjLUNHOuR3O+mcb32iuzfXP5qs0x6fHM1OvEwdRpaQYyNlfre/v++dfWqfPQKqSAiz9MEtkWMeADtqDSRcIra2wx2ZYG+2lfT5jpK6HITLuQBTxV68bdSzM8cv66t2tj4mpyRzumYJPtN1rmu01xVS6f3OnXWtmzMOUyOnYlXKJXQ+eZrZDSPQSOj/ttQry0VQC8146nbokZYaSnXJOz6jR+1d0su4ueCIlr9YgNxVTObNyGWIgWwz7a0+atUtR1UrA8ujegrakoO/J4po2FFbq2BXia81NL1tiU+2mR/xvhAdP+v2c7XJH+Kau5p35qgqj6eJpoDYn2nnz0o9PjTuMxthTrLetVVM426/6tBIMydGutbP7E7YZ2m+2MPaEcpC51CRpxgtgQQwNn72W+r8eo4+OiRiWMWTUOrOj9rTqGYd5NeUR3M1X52fp/Qely4v/AD/Q03irmPV+l/xBji8bWXGTF+aIkYmt/Sa5cmE4jkvQ5cBnxf8Ak4pvCk4rKjbTSS3Ndz9pmlmlFuWQ7JHoMfpsnsvqofTZP/J9q9dI4c2K+Jrupow0DUGXDD0UfsfHQ1Mo2pAvZ+3ywIOzte71oLNLEYkCI29k3OtZkxf/AEu90cWKKMNV3i8kVxfOQi2aCpjm8boNLMimz85z1edy58uapG82S+Z2/Tqn42WuXybClug3r+rvbe8epcnqsieGcbi8C3LV0fU3v4x6JTXjQT/b80xNPOh+8xMzyU3VM6A1SWjTRrbK9fZVMh7Dzbsb/wDLnaVUxHIsr8WtOUNtXPaPV5/S+64OWvi9Vkn0ufFGubjLXOuYJP8AFuLL/bJsQp/O59WEi0Nfd2RzOwx35Wa+lT+q7EJg352Gu9r/AI4emrD6v1dleoiC8WGAcePJOpKto++eXf8Ajk3v+v2frsc+SXuK1O6vGZbj6SfZ/wC1ao+tJRLW3exmioKJs1yw2LOTYWGL6YimUWWJ7dvoBzrSZPUUaxEUTMxj+pe3e+ZFqa5d1DRJ+kMe4dxOPDjmmtf5TUpUrHf9Y0hBM1C0gsa3I4wgC7G5U2xzjYyFLr66vf8Afx+vOkR+mvxmbKuGb6KcdTXJDWOh66We9yyn2v6M7f0tb+/BLJqlSIUFdvT3vABvrUVMPMCQNgVChDF9KycMTM47ahnIuMcRwabrJSU3uYlp8Tc71/WeYq7rJdknHPwpXazSPnHtWZUYKqTk/cdbCSssyLjPrzHisjzlX9iBLj+ofvUf13p0RNsTASfIsnetJkUSbq9Cwuh01vxUnlpMO57JSRAECZt7FaQHpeEpHAsrsdpkxGm4Yx1Vt12dCeS2OvjaKPrXbsiQUKTX2uZoVKMhMq47NvZNkYyJopXqZqta0mzUUmt/g44nejwbcktbnxL9sPT+6aNczILVCiml5+6MdzbDN4gTdzUIb6qaKvTEbq9yQ6p5fxlgWgNxKhmVba/YaRJE3n+EsD6mrZW0+qDLiqqJQ+EebOjcA3Rrc1xU1VB0zutnSzVJdwsNNWAYat6okKMmunH5oK81IcnP9fyMlRi4t1TPxzwT2qpuot/dTzSVT4CjnnmPws1yYv8AyB7tCdJC0ZDZzUUXETcnIVonZPjk/EwHMgg8gRzuI32xocCGhGyiTkTcsTOBosOaZhrqN61ew7qqZ/yzuiqTchX9tSRr6+V96KrrCuZ6hvjZ3UkrQBBKbY06HrHxWgQVM3qsE5v8p/8AdPbrQ/HMzxvfKP1ASRlkPI1kJjd48bkB/rEuUfM09VrGeP6nFcaJH8GSEbi2Np2hDf0240roelzEXtDM2sHOy0z5sxpcfcz/AIVS6ta8mQ3Wze6OpDSORjqQRv1GWeKhi71HePnqOtr19aFQ+tXkZZ3utwv5kWQowXJYSfanH/qBaD6ulh31PPUzSUXN46qqTNPwnV6JKlsor48kzjNToGlTz/TmciSF1Ckgvc5E034lSwwtaABf5Zzuhe63kuMJMMpKxUiVbJRjPrlokKbpe8exrs3QT9NV/aMlsGKZrHVXwXk19OqoyTd0/X5N7P6akDYCyRCtrSb+Ogbl51H9cmMpT5FXk8Mn11RtM7vdumgtx3sdipRfxUkxyK7Njtnx92meUUFHjm8fltp7swV+TzclSx9hpmNyAtYyonKQVSVwrLFY7qpHjVpJJIoj20fh+Utlqv8AMhZMlkyOx62XJ5AgYL3O0r8C80HpzSQ1E4l+NKvaVWT7NGn9tc9bFJ1IrI5rHFUQ84xHR8bUc6mtbvrWij/Y+QNV+UEVS8Blzy+wDkbI405Q4ZjfdIshtmn/ABpG2hxGLeXHfhckmK0NSzQY4LvW4V2XMlbF3NRtbpk0x2P+OWCU5qfoy/QKkPKjs8cyiKDJ1kvI6aBws/8A2SalgmtbKFoJLql6edTz5GctZtzuseUa62zEpH1rHPVXt6XxrV7qqZTbTFIQAE9mIRKz9x4c+pAAXJHACQBKu0CPTengAabbClJcXGSJlNHVyDVVZ3eypBamZZjmiBmiM15MnCx15xh9ZYqncl0PT99G2dmqAWlRc3jibriRrMFSQ3rI6epybjxjSniftor+zoMo0QUfJNVEzknICRetRdJwVBK6EZ2hv+yerfcAz/rsYXOqkg01BP8AENrXherelUircsaMucUtRiZlpx3S2bUlk6Jk+Kdb8jzQocnNZ8jkyZCuWiGRNkcgbsyK/wCSiqC582vNa2P4fit7CeMb10M9kvLUzTQob0u/t1sJSkcfy4+7Ymatj4qtayhOPHz0/wCNcWho0fv6SNTQNl0p+liNrZBc5a86obKL3nEEcgMjItbRZLwMRXx3K1ix5LA+xz06rK103qa+zOQk/VBNB6LNY7JPrkbDk+OeWcXVdSWPgI/X2JfP4rHl4cs7Nd1t5uqipqedCT1p+xWpIfqM/wCzwZKcfidUtYtuMHuneTrpkQX9/vxONAndPKyGTEsAfK0PLg2BtoBZFlmkPCMXI25XZLpWkJmceOGbgmtvOuskRtaemtKFH28z/cZ8k5dQWwRFLlBluZkOdvd+VZq+Sd7KTkqo+RtzkytXkMfyaZtKOUq18QULVBW7ZOP3+DBWOiNHUlHcySsCf4qyUHbenlmfuPXlYfwFc3g3JPiLCBtvdNkeoQeLIYg8ClEC4JTAh/xsFcx1uaojt+MlNk70TuKNxIP9vCefxY5Zdx8fyZaxneRCsOOk5tmZnmmoZ1u+k26/JPUReufrqJw0Lzu3mTgvvp8+af8AIG401zX4B5HxeifidLPdvkamnqt601J3V6iTxXTM4Pji84PMK+qvcfXMCEkeYT5IB3VTGON8VfOKmjQDr/LVPyQN0OnlqfPjX5nblr4zQfH8bLFa+rM3lnfcwHVVVP28I8nlzcY56f6/F51JkXLGtU0aoyTsL3vQ6k2/ipy3GTsDJeYKnICc1VlGNocZ4I+0BT3sF2z+JpAkSabYAVgNpjKYiNIFImfw28CAREgkRKHbVjI14ySFI48eplfvrc5m1Z6elev0huWUBXC3YF9XNZUv6UFz9o7Bm/NDjgJ62o62fgYrvN9suTQfR3r7V9WJYSZrHv8AdwFUmv3FP5gJkrGZCam2tpU9QPLiF8MqH6mRPkDmg6G0YuwyiTFgHwWcyCNNgLHm2wQJBuCEIgQHoaSa+NGdZMfCY0KipCOzpvqjXW5SpK6OmVstzz06j6EWV5fHI5Ca6p53oeiuTnSeWvhg4+SUijJ2UszlP10BUy1HlnQ7al2g8k5MtWBWjeadpE81ror5Y6cnSvk1J5G5F/JFw7mKQJiBS/CxjwZYEnICzBIxuiCfeXo7yq/SDeM3bI46yWaC01ZZ9/L463zSSfitsY/tzl7uedJThx3yT/k3GOKAveN/VW3LtT8KSbbZXCz25B5x2+JGI0VXDSHLU19ak8MLhUzM8anxONaL5K6X5KK6CSpfvX2UsmCTbRJj7hZSCDb3qMGxnQnKjbCQKI/DMyQMF2Gpqy8cXuYlccfXFzNMz46ZVkNhag/vU1roNiP1vgpMm1hjkTeMlDnQ6IIdbqBG5fxc5ePlxSfXJknmqlknJetW3/jmvjZsHwlf15+5RmqN/qp6cjWpuz69H2Kle6g6OB0FAyWun52RnkXTjcLsG3dadIBmGbEv/GYkyDcQSTMvQNwwNRU6yEFR46p2d5flBIRds2qQjuj8O7fi2E71MS66fjNJmrKVSJpHLRs11rfhU0gUT0/1m8exIT6XkyTV/HXUz1dypuTRWmRiiceW3z3k4lYVilh4aZ18c142f66/r5QgNw+HAT2nmWYJxqfHOZxBQbDRuUZNjPMbfkyUQ5HJWRirZ0n0yVW9zW6o0JJN0Ep9nVk4mKoBuj/JJ8k7bax5quV1R58xO0OokGj8jH3TkivN1dTGTkpHUSt2+LxefCR0bmd/ItK1rGTBRk3RG3qv0vNJ9JnJOq3JI72Sf2EIpDqd8bfhTW+TbvGkzf8AMhGDF0wMBT4A3jGmf+tYzL1VY9UVNTy8utNa4ieXfQ1KDNn06kRCXvHOt9c9yzAbMn3evEvgGZnFXFRNWiXHU3b8nTlIluZ6fAfFpvTH/wDa2UlwDoKI1U1p5YCGHc0k6KO66dOyQeVgZyT9ZfyQJYi0bgqXyrS8FF6PmYO5SIhfLNshcATK0eIrZeRx31qEAv4MYS/sI1U68+Xc8pC1ozorvHy9xj0ro+RgJaJppqtoSnJJqEKmapZLGRmVqaVNVqDGBXxOtFOwmQHZsm5XX4WZUjbztBCaxyNa5yZGf/hlPHW514TmSqZCkEJgFjEAqeY06bATC4Ug/wDi8QWPKAt1OScUMTfxVVvHGoNTMu/q3fADUuzc72fhjc1TIWdAfv8AwuQnj7v1A5WfHBUxWtLKNCPU0dMNta/s7Krq6K73SEiozMr5nr8CaoEN5RfklWuojQjV66OaNkMa/wBf78sBfaUFMUkHPplkKUzYukAIlbAypRN2V+EzY5lCw/sI+NU+WemboBU87JLx19YiRPvR4nopT9cmTuKvFdcFarHxWSQJ6/rROr3BPClM6rufzL+TQzXyF3sSvM47dlUzjWInzLCEEq0eV/GtNBP1x8xutBM3xTJWPdK0hvTI3L4Svs0KWjI/TP8A22OcJANm+LReQFapKFy4Wxemc48U6mOH4/jmjn77dR9unzepSwBNGh3sarXmyZo1iHllujnVdupKo/WTxslaBN0iODGXkqq3zexKuU+ph+1S7V+wnQ14oNH4Xchc81OWMup6qKdDOOYurWU0+L5O3ufqzN1JLag7cfQeIERsEwGgPcArtvEji5WsrJU52yjbTLDjupDciu9Q/LqgvYruf6qMty/cpv8AyLQ+Piuscp1lwtPBo/sdf9ukt/I1XCZcZ8vykF5CUyakndu53EoUPxi7B1kmqEecN9Y6d/KTcDvHMXzUFVjZ+oik9UzP2NlV+TI5c4Yax3P676zmlQT6iHJClJGFePUQzstPnrFjJxdbSczNMeZA6cS1wc2bj/GpV0hUtSAA3ZGVx9ZatdcD9p3IWsVfSBUhBujxXj8nJU48ZVxsrrGMz/Zf6ZCyuTX2nW96l4jcALmn5cfMn/peWV88vaXbvtZ+usYNWEjsX8cOkWsPEYHANijgLTOEoUDb5SgrMXAYVnOncnyFTytHzWbIMk//AGTCy7LhAGW6Eqp6f0Zln5ZZ1MhzU7SMd/H52TXVf5HkK2b0hpmaVxuMMxN06G+X60Y+T5InIz9vP9DGRGu/GlQ2qCbND4ma01Rh11OSshdEoSbU2fXcLz+WoaubWcCORG5shgaoCPwks2y/lKstr/eNRl+/LOYnJMxk+zj0Y4jXxVNdNKA80i+RoEoSykGaajJ8muqmNEN6ofkGiTEApWyVf3CMsxziHKk0cNPFOq+sx1j8TusU7Dak0PPkF/B18USQ/W6l5K8Y4dJFUETDNS+eep6rIeKqQICnjbYEBPOTlKbaRt6jawyJkPuZEYXGp3ZVqA/Nz8mTa7/Y1cf4uY+zxA8lf1GbPwlcezZlLr9n2qYXw9DEzUk0uPWhe5mfOwKqSn/HhNS6yN3dsXDfMVFB9l5yAISv7N/j7lyYpZoQ+Or/AFXXiqqck4qqd+d/IJor91NSmdMsi4AvtGYb5AKV9IF3uFNmEDsIMSAEptp5mkanoGZs61x9p6HS7mrr5NUyfbzJVKUU/kLrHMAVMORrQF3hqompEpy9ddaOWtcaOZKOIisPRAR03oZl1zu4tQvFjeg5NrTp+rL+DMT1p1JOMCv6Tc9eJenqioeZ0SWSQcsw/gWMTDvuLXKV/fQbAmCx+HEjMBSiABSiwI1E3XeSyaGrZ+R6NDy42J3qYGb++/8AWq6BGT4/lIXnuiz/ACa+/evjb3JzSBJJQao2eJRxXOmnnxio5rGrRMz9x3+zYTTwh02HivyLs1OW7WdY5xamVxtXvm3kI6mX5PH1TwoKqmmfwszUJ2Fs5td7idAp9O+LClqDcAWPcLtDsjktFmOQMbFUTLM7GmFt62QleJ+xNRun8jHU3smo1z53JDW55CRlWtXX239uak6Dr8jI6RnJTkD5a1kk7jTbJXmqlkOcfg5611vQqryyOQXI3c/GOtY/l1xXc8EuPzuQqYKKVWj8oj0kgj5YNRTVltnkwNkNMgAhmmJCkhCkzsOZQew0UzVT1OMmpqMHm5Xg/vVmSWia+sGR+3JIyI0jMxShNfH24xtn6r9Inz9WDd6ZD7eIT/eXtsS8mz76u/L56rHzO5oqU4hUNWaStfj4ItoySS/I1Nkkx1qQmt9KNO+p8fXnayV+ZIkAWfjZTa35icq0YhfQgbbq8gsp6zgxwoTucfGvjaNg7ydfXdSSdZHT4pdBB+S94/jsmbqoxtULR0LRktGZA89CoSj9RreZMlTU80P9ZWxqJxlTwrbzTbLPQbD9yy3t0zunVzR+wvXRjd9QKzJcsvE42vtWyqVGDJIAgIL/ABxw5jjeRqPQ6kFYJKw9JJFRavHpAagtglBzjx1qN6xtfIGWzzsu03rVOg+xxc6dWfmfNgtV8Pk1eIIp/rZ9trY14dFaGHVkVQo1ETjyBOPnJxWgqSjuHEeHqSWcVU7/AN7cnP5Pk3Tj516mZTgnHS42DNZXeWYplbEWA580H5mV+EAwnA2BjEJwRaWbAvAn5cEWRBTQMMCP+4aaZq7omJfixuCXlrNNa+SsmqufFMslJNP/ANTLGvyEFxSZJFMfyZKSFXIJGTI9P/kVVs1KRslh23B+HZ3XyQ1kb4nLjOHHknqk3wz93k521W3Z10bcYceQuahxhV0XfEfbwczydMWOi51tnmdVMv5jVGZ3JsHgCfv7aaXCZgXBWeTnMAoDQkxeU6wdd5KBBmTIUT8nFvPKIzqiqQ6/rML/AE2OavNHXEi3t5OiKnnHM2EjzVQsAOmIYquPwjB01VfVnJVdXVa4xvTjqrhvd/6JJng5t7BX16etGlrbNBGw4QOfkBuq3jnXmi0nx0dfnLXUJXnAuN7gBSHDwJaIgj6YYyiIu9vbTu/E8x1rWIIm46pKmMqx0zMkv2Z+o9M/QXYelMnZTB1pwf8Art1Yb6cl1Bc1JcrP3rlPsb6r4JR7Km7yWMrDV4630azV9GoooHQVS1p75NxhiQaY+WKdnRLWByaDdGQ0Y62cBuexjS6PM61ZcEQUebRu2c7AXOtPSCoOyQeBG0AbmN7vx/Jjw42GTdxJnr5NwnJprlmZxMs/qlaDwSv5ufS4YmcU5MDnsxxTfctJG++smqicaoBQWPN1S8hrp7CAFKmcMk4kCabDNRVVi10D0y1uitIbd/6PHBf6ZqisjVXbR1Nc4PrPF/1anHOjfQo7n88rrdTeEvqvrwL+HrT0sAHcG6N6Q7cX531tPT4iMU2ROWaxmKfFXW63UOPLXGok+k0SkUNSXXe/Zv4B/IP+TK9k9z9n/ivovbn2b2G83ufrfcfePcn2v2z27J6uyPiy+tzZMXpsvuGcM9el9PO87c3m9Pipx5V8pjBBOOTJPRw42NHUa2GQiPERrqtTBw0fVCvz270Xr/T+2f8A0Pf87wT6HD7hm9w939N6Ba/8rH/4Xq/U+o9sfR+vrJjpxZaxekwesx+mj1ZU4qy5vWenk4m8fz/9S9PV6VNP9qnqnqdbpUAdSn1U0k1UgVmmASATMe+ujpN1okGmkr02ICQc9mAfbXhH8q9y/n3ufqvWZPdPh9a4vU58l5vbfWYvVw5oqIuZcAVkGk55OeMmMm0q7/PLPU+q9dV7yzbUUYnGXo+pUs103Rc20c1PU8pSps9m/wCKvZfUvr/X/wAj92r1N/x7+Ie0+6e/+u+QcnosOXJhr0voPSf4cuFxX6v3C8eSYxJ1GNy1FXuJ8jy+tM/uF+sypd+oy16icbjaN1ncuitGvrV7o3UvdO52PZ8KunVX0BTQR0RSCaQKKQT/AIyT3T2vcYVg/LVV6nVUU6pA+V/VCT416h7V6H1WL2H0mZyl3VPq/U4n7XjMhTIYpmauZxT/AJMZyS7n9OM/Oc9zKrGs4/iq8xNslSVTNS2dJ8eP68VdW39UonHAHZYfVZPTR6bNiaqZwYJ1ImOOpKccmP61iJhDdvx8tM1LWN1XrcVxkvLeOCPVBWG0qzFj9R5DJQ5JmMWul6u/t8pT/Wc6ev8A9QmpSbi4tHj+ZGtT82CxSE5stjfaRNi415X670+HDmvJEVjnL1NRGpmbyvMxTjYngJ6mU+SZlZWWT81OaeSL2RxlnGn/ALZbl7MjeqoX/wCqqRZbZa5PzufcvSfeKlnrZFdY+MfydWmf5KjIbpN9b+yZISoiaOZ9b6bOHUZMOSW7HFnxT8OMyfYS5NlqXopm99b3G6/PU6fUFdMGCUe7AOQfvHvri6lJGUTIXiHiCvsDrVdYaWax0hfM5MmtfKh/jTJEyY+m7kjz1M9+Q2ROPJ6lzVEhz1t1M/MVvQUY25SeDqgq5CqaHbM2Jjabcdv1smKueuoq7+Okkgmo8/o4+PWkMwiMTz/RnD3EO+5uNU1ZtN/XsStiIE3vUJLzhkwQnnEN+2s0zkhT8uYx4AC93roPTRHqTkwLfR1dDPdbZ3U2a56pKukrcxFfaYvJscXpbxtQY+lMldfFqoko6iKeZalncEaN9OpnZ+VfQ5cuDJFE8hU4quZuZrJubcmhs3Qf+x3rXRNYiyuxl9DmwyZRnNkvFW5iVpyxRfy7uySWfMzprGftCH85ur1KaCkxmGHDnxE5gRrp6fSg1JFOTH1IARGbHvOrwGfH18HqcWQKnJeCskk/CAc3Hx8tO5HEWbKHqTJXPRYPVYPUrj6n0+RyzLGucWShRZrJNLvI/G40VJIer+NSj+NuUriv8eQu4mbOLxm4qCYx80Wk6wRtJVGGp4o+p9n9X6Sd5cN3PU1irHjqPryTiaqpF+pRbLOpnWi528lfU6PUYYFXJAklG0uRxDWthSaZRTBHkJj6ok2Fs66KvS1ETUQZMdbguSsiV1TL31jxxkn71ejXNTczwVu5jwVcSxG5x0Y809peTnd5Go3a3SzNZJa6qgUlmp0no/c8/ppMHrMVvp/knG6cpe2YjYgdtQKZAi5QrHL9prsj0uRcN+nPlj1EBhxYjlrJl24cUmPvv1CeIhBZad5RZPO65PSBrJVPpDqwALkk4QMEGyvrbp1GokAXADSslhWBWI51Y9P/AJJolknHxiviCVqbk6ZZu9QULbzu0migfz7U/nXuPvX8r/4qwe+/xf8A4W/jn8H/AIJeD0Po/QeqjN6L231fvj6L0mP0nrfcM+evTR7p7vlyes9HlcvvL6n48mX08+316vN6jFnJ8l96/wCA/ff4T/HfQe7f8h+vw/xbP7l6B9R6X+PGCvVfyGaojnB7lgpjD7f64nHWQ9Lmc3qMMmMyYcOZyxj8+/nX/LP8x/kvsHtP8Nz/AMh9Tn/jX8W9lxey+z+253Diw+l9B6RyRi+HFjxMZ/UZDJfXqW/kr582IrnLdZfna/T/AFPq/CdX4I9Pq09DrH19So9T0gBeoUimr01l0iWQJ89ZP9uiqmsH5qBARLCIntcYuca+T/fvRes+XNkrBjgqsjzJjcgtUVY/MIMxXVOpeYYkrvWi9g9K5fe/b8dzj+nrY+Sc2KjGsFJdLTLk8UQNbaErfnf2X/w9/wDQufzb/nu/cvXe3+6+1ey/xz2z/wCtvXfyD3esueq9dlw5fUY/Re2e144PWes9VWLDki9XjwzbJWXE3TA+/wD/AAB/Fv8Aj/3X0fpq/mXr/ffcPlj0zXoPbvQ+k9JOT1GP48WTIV6rNbfyVkgwZqnLWKSriC+Pz6U/1/8Ap1PUq+B/vGv4vpdP5+nR066vQUPxVUj0UnCNbC7a83/2XVr9PV9JHTqqpmogNJn0w1LgwB214xn5yfQ5u6ycXEax919t3Ndb6vpdCP7LDUDoLLlo+KBclY57Kv490E5C2Y+PDA18TMpjaZJ6LPz0z+Zfx3B/GPdfV+14PcK9wMc1BmfT/DbZjx05dOULalmJyRkqcuQyyfWY68/v0vqLibVpPT+S5+WuB23jyVlO6/2ybN7/AKPVC6PUFdFPUBiv5qSQQTaQPKjxnWpowZ9JJvZJlNgbSXga5fP8hh+asNXWKuLCqO+Z3mqp1Vz1O/OyOpNszL+V61PCs7vFphnG3i8Tt1NbOdlE+adlQWZN/l/1xMERNzjb1ju5mz6Wz97sePktmuhEEpZ8+dRknD9S41UwXFHMjMyhtoftknddQRvX6OYr89Hokbg2Jjt4PbAQ31zVg/hpLO6Lxx7ZA7aqfGeoKvGk4yaGl5yZfp1U8c1ZLqYuNkOv9FdiKWZlUPrGGbcVNYzf1vLTSlxy9H2uRKoedrcjkL6wz/hXG5sXRjkn4/u49WkTJrqUrS80MoAZUJbcbK/4ox8VkLsZuKP6lTvpnIrRpoL0X+dtNQNIceJhZduWVnXKTSAy+wuo4YEHN7jU3nxTUCSJOOVnHuXIaqMne+aoWqZF35OV8fmyxZC5ByS1r5ooIFLofjrJqfHRJzIG2zqFl/NLiorF8hzNAzfWPrLOaRv5dDVnmtC+Rnl3/b82GOWMOKhmqqppqR1ReljJkJDUUdITqYXe/wBuXWpNdJSUAsRYJjdDI420UVKocpw2RAja522Ltv8ABU42vjKfl66huOcPcnFRzU9bJZmbVoafM0c3j1E1Ecs1riEDnejbv6tIRo+T+gBteZqOWHDA9tSVbAnGyiGZhaiJ+KT6tTdcsrPJ9TbYc0YyJxgdRGHox3jxE3TI5W2J7A+3U7mjeqJqfzzq+mAUJB8KBwML6Qp10jYF3KTNhKIHsowra6f/AMnOxc1jLqb+CB2ukgl/cjM/GkZCTdLOtDv6P/4I9o9N/KP4/wDzb2X1tM4DJ7X6tswxaepMPrsWDWO2qq3PBNVgn5LiqxTUdnPy7VrM78MVjxxopmyChrJe6uo3Omn6sTq+snL+fX3/ANCnWSc/82nFPz5I9H7Tnw4vvPwpl9Xj+WcsymOcJlgzVkiiZ2+C/Pjf1o19P+n9WrplGk9OoEQiK6Z9tr8mT2fB/N1RSQ3TUkJO+Jhp55OvVPRf8D+z/wAi/jke5+jzY4yY8P8A5Xq/Sd+lj1GVwSFkY83yJl9ROT01xNZorJ83qMRONxkvxh/yf/G4/j3uR6ScJ6fDdvL9rpgLr02WyKowxMu7xt0mLEdTELL+o3/HGTeD3v2XNv1WTB631Xw5PUrhv0WXNURhyR66OcLNZLr48WKSf/IrGmmryT8G/wD0Q/tcem/lXqqw3XWfI+ry16l9JXf98mPBuAMzcvzxH0obzVNRGUifmv8A09/U/i+p/U+t8L1+sa6aAKqJQAK+ytHtft+L6VA6Arpp9NQKqNrGl7chBedfFvvedkMHx1GAuYr44Zavh7uoydDFTpZKlvmqmSsdF8RkxU1ud3MZmZyG6rk2EEk63HluEgZop1yp3/8AITaV8UqXGOcbjuTLkN18tX2aJ63jaSmfkdHIOo9s9Bky+pjJkP8AGd3xXk8VjdMv08CGPI09KVu2pj8/TenWKaWiFJshI52/CBZvK14FdNRrNL+oYtDGPrrRXgMeCooqagWirZ8zMzeyRYK6HvkGGB1uWtH6nHEktbl6lh+tBj5+vbG9QEiqu5H9/RO199xen9MU48fV0VO6Kwxha8xt+3yUPSx+5ZRn/HH5wPcxTFJkK3O6lvmaZZO/qGtLRI6+1Y9Kj00l0ggMFZtZTdymn4Y1nWEfSsi98eZjkLI1GW41k+7jHfPW07XkQpaQ39ZjQ6sLmuF0/qMlVPgupL4viWaJDdV8dSyO96rZVK//AHO9x6iDnHe4PrMiEk6/Z3Xk1sYRndBvy8rrPVYnxqgfr5k42eJTo81VpPjf3l2P61op8d5Qsyx9LCdZEOb4nf5c4wjH20eDEepn4q1jRiTLROi51JN19l7UFNL9ZdWFfm29F6jKY8/tfqS/iq6yemhvxi9TBJCFcz8dypqTdKTNdbmi9k9rfciseA6zYpc5E9TeScRLYTxVPWxKNTSBSUTf5V9xxVjuKuK+XH1g57a+uPqcdb/9m9zrI6NTOkK1yMNPY/UenFjxudNEC0WgAu2f3W8WqescOb1OTJQ/VYjkmR1R5msj00+Yix/WxBnxWn0fqKe/Ss5KjJGpnJJlxE6qfDJWxrX1dVVhOilI2zrxSuScgeSo2dS1k8swVs3Jp/RVbPy/6efR50xzeX0PqZyxz6he/T1acjTYXiHIIseJg+LyuPuRcFNowLL02UxbjtGppZKfI3gDjv2+muv9u9dfuHpOfUF/+X6a3D6rt5TiV7Ip61k3vJOp7oqdf9leer818e5I41MK2nPNPVddWVqamO72RzLvqr7ZjuMnq3LlnLDOOKrpzRa1dTm+uupoE6W2eq8s0Et9YYrN7vHWLcmiYW5l2hdVXenUa14lKBkr8kBVERNt5SuyAL8WjV3mO5WFAZf/AN2NnrTVkyzlqDmJx4jlLUeQ+0VVG6FoiieUHwuxw3BG3TmZquumY6YZF1MOOWamPD5l8Br8ysdWS47JdDjELfj0tTQx21s2463KUz0S7FBl/pklq5oicmx+tQkb6aErwzIzTsORCvz70NzwtsR7IOP1sAR5nAtAIQfbY76P67eskm0uaOMu4WecZP0T9+MZGtbhRfMmQueGjGlSUpzOSoZK6l6vqxT7RKgy80ig7rLig8MTkTpTpOP7bPv3WPQySVr4zzOzJKm7XzuqjeqGZuTj71s5KP39udOt+D8YLatHmAZ/LbL0H0vO4aJZUxl7MYajT6v6jzPPBjDkdzzsy/Vogn/d8ng65VH8RiIq26rcybhr9tfR+IKjTj3rmTxTudmth42Zcihvbjm6ndSpLM9Uk1jER1utqcFToIXDhigMn2lMk+HzH06yT9ZnGzW5cZzAK+Slw2RADU/9vtns7tDSjd2M8I7QLe5zrLu3Qk2bnh10xH7x2Wcg462+J0VpWkT8kjmNhQVPlpgbaVR8a53Oo/1X9ZAPxIZNVfxuzLWNqjrUvFqz9P8AHGtjIjsOVhQnuPTj5RqeaOqoNCBetAMvQCzLsDfhMH5pgE4z6exec/c6DF5E7XVMyMbZeTaHJbWbeMJdYo8VMxkrQUVVyk29bo5RNeKK/IMmSYhvFOmfh0QrVIUZWlNlKhc0U+frT5/CPkmUSVnLM/I+HnnSuSui/Mr5ldUU70qRhyScj2b6i9lM4pRgnJWya2fWSf8A7oS96QBIEJsmqdxDTzYTh6qkHE+FZCwBPnwIsWG7yzW/PJe6yfVq44fqUpNR/rmT/rJ5BZAMjmG58PldmRql+0DHm9SnO5WfP23uN1RU0E6yRGpngt2FVZddad+F0U9lTPJSF3UyXc7kHG6PKmnTS9a0OrQEAorS/jaE4l27eShGPuybtQZPft9BovT+or7Rm10FYpU2SOpPOTySKs1Gnw9HRr8Xl6yU2TucVwNfssna0iVWRZ8r4ll863sjHlqrytTzkgrewR552U15tbXXIFa4UqR/D1cRr5Q+SxPLsx3KSVUpzAgOPnWhRN/ifqpEmoDjZIX7obSJ0gAT2zAQCEyO4/h1n2yVrHopqCtDO2VjqBL5grU1STyeNgH4/HHx7I11U35d/qpConfEeETHIfYKHxufxGPcPy2SY8UvWEmZ+XJHx+SN9c6k6toC3zNAH45rLadzY6mPAyyXM+K3TuOumqNLodvPkoIElk8AtRbsxNyH5YYw7Lvdq82uW++m3jw2HyF1zM5KIxGOK5n+uRyOy66/6+HcnmqPxLBBPPPN5irJ06MkeCsxzodMT5Wdf9o1+FZAwP1omR4qQquwZyZelayP7ZAsnTzqH8GMk5Plg1Lq3qn6aZhMc1R4Rp5qZ0aZk6/NYYsCluUw8bbjcKdX8rA/4oY4BGMSoyxpsymOrx8ydfQf8tzX98YBsjV2TDrnVugitC6WYiU4KcQvS8j0t1i5qcYVsd/aDwGiOV7qXD8XZIRj00Qb63OpOe55gmdgNvLs6hKYy95GLqvlyyi+N4lHRtMbQz4nl5uqYPuz+AVhEy+EgIbd0pTQD0NYumTk/K1bwkSE9WZvTAVJzBKc8zkcabgK31djM1wx0bl81Kj8iFiDDmqZ6hlmlGam90TEhZ1KgjUvjyqgvU+J5kpoeDJMlb2UK1Y72aK3r/4/MxmS3XPx4yOcl5MmzxOPRBkJ6sNk0aX+oyyv4w9mUOT6UCCAeAxcUnAjR6kvw2i2QDUEG3sbbDDTd+qK6kZysjRo6Lx6IXqaqgTf6o3GvAs5tVL9AJyzHMyE5MmqOrx7bnrqNJ4111Op/Mj5J2s78/GPxsVNbhnLV9a+zv7aaqU8NS9TNVV22dH2x83toJJn5YXnbre6F7egmNVqhI+bJn7ezhUwIcaADMElwMDBGytkwQI0E47bqbjo+Rr9vcyG6grJ9Uf6GjbbyVNFJDx9o7+M6+SbqXzgdSYxruVresZIQfYLj9ptuaZ8r5+uytGyPFlGz+2nzsnUfoq2tkzbqceJBk83MGmhN42tUTjNU+ZXX+nX1iogB03gdyPSYDFgDl6QMlSXDylY3aBYEYV9PxZQAQOkmJMf63JMZbZ+oIKXI2Hhl5fzMuTFoauFIgLBsqln47Lmuu6+27aX60p1QynBNfFqqmgsySfVv4gjjVUDNaT681O/Ibp0yonqvoO7qlSavcHMBrfxsVRQUOOHzPgH8qkk0gwGMqoXpkw8xlg4tVJgFgEA2mYbwpLJTLBSesOTI0EDWJUp3M75bMdyRI8+JYepvvlrelHy48nRcZYmch03BGPZoYnqq5ZaobkUk+pPIfjm9b3r4+G4sOuP9fHo41z55CXjyz4H8BzdYSoeSuJrGpK0cTczOkGtTrqunlDfl/FUjUhDDFi7WZhgBBwYzoshH4RhtilGXuhYMEBM6My2OpmZDnAc4yabTU5Kar7SlUTXJW96T7bxvKSOIk0TjuiLGaLdXNeZ3zOqyuw3qpud8pTLlRJ45k8drVTj8U1pbufIB4K1M5APuWIuwGYFJ4l5SKoqB+SOj91+7TpfqC+cjCRH4UWPBpQEwMg83YZSVnhon/tSVMNXIuoaJy3nHOPLKXjsDhrjKybLllaaX69c80T9pLN/kY4j71lx7r5arqkeQF2TXDU7/Vu6ak1vnSpyZtT0OQjLMk/drwc7jxuJdbKWw0Venb+ODPk3PL9Vje6BI1uHvdZH986nVfUZ3ragkcIQAVFzcQcK261MkzYNKQErp7GLbW1kZikgHtWWeSX5akndfK6vZRNc+ejzrcqVlDuYA5MNXzWmq2GVKrXLr7Z6ne/Em5QUk5W+GY1GTrn69ZZZKan7USa5XxpOE5noOMn/AOENIfFPQq06k3VV1NdjzSb4OaCwaoZBEiLHCKH7TA1dI7kgSALWEl/KYBhCIAvpY35fiqWYqFqV3Z0tS5LN1ztm9FVSQk1NV+MHQEXJZJlaGJMuttHc1S53cTkk0MdaP0K8lZd9VBkBmTmrvVOibqfPZspbf7an9Ms/mdV5oLeqOprf0yWzup55mKhjzIePG5+34ifSQQSAbDAtAuFnOIEHSJSfCN9ptwWfmGL0sQnxzbjOmurSarRHxlcVxwHx3H0nTqtVboWWGR5m9c46mI0ytY7CeLfvXJps+V0szT9mHYZK5yIqObH1ja61LULw3LzWgriZ+tFLslfzIWIiSZo5mB4aNP6zNGtM1WlD6pPh3r8Qn1CAl8rWQAvmcyUyjuY0AEnZeElAlx5IEp6MojIZBayb6aXG9ZGoXFUS/cp/UbrfXOk1+ZdVmQqHfyxOtpCnhaP8lD9lLd8yHgTbGaG4SnipicoanmrLa2o1TVS9H2Cv3uX7/iSqcjWJmGKwzY1kKy6P8t3G+2NxIlM3jZXKUc9IkgoWKMIbTEJB4OZ1JQcwwRZWBaIKB9INwjHGrWSWAXioqQioJfGv8dblNVJK28/WaOeq8fkTfydDP2lOoNDloTq+bbaPtzcp5dCcii8kkS1SvdyytS846bAuiSYj+2zkof1rSA4WMgxTzRflVkU+Mqap1fauh8df1dOq/GCqgktj+cCcZI86Mikb++FO0sTDUaOxyY5HGyzlkui1+QTWS9XDfKAVciPJLMcr+FjIHTRMyP2/19Pj3jpyP2qEZ1IFU8iUj+Ly5Xc+ZIKx43UXPdyv7/e5qJouhPu6Smfxm8WS3ROPRfUpIviZWfFNTO9TPmgZB2Yw1ABIILq9MA7BSF7Aw5HIukDMBX2RDS+hAuSCD+LQlXjGiKiiiJqqGt6lmrMn9IhKWg5RMdbdv4sv4qMmNqqvnvJWpgvWInGsWS49h+pf9ggSfkkjLuGdXA2/vqeI+Oi6bYTetnVeZud+akxl9agiu1TfPdTy1MlzQDT4f9EprcFfiIJqCFpLgEoBQksE3/8AEhuopK9OLRbAoqtBbKPnRE5B26sbLljVXAP9afrjmY41pmiCxekoM+mIl5N1ZUVtGWwYLsqQmbHca6mtp9dH4BWUylfI5ahvc7WPgipbEGCtIlHKzX2aPkeR+VatNc9/DEsa5DXGSenQddNV/wDl7kZWlVUPTFz2gASkwG4IuYUaTk2sAUoQA7CGlBYCRRfMT4Uqqbi5rqANs+KoNzFXVJIbK0eF+pv+SkpJIppKrjqZCb6qlqj7ak/ShN6qZRDk+CCrTI1Eb1JTN+P3QTyTq2o8MjXJ5BGtk4Z6O3H8j9gL1MsxdftvUUMBpmWPLNKCoFgCcoIskCwCxPvOpKtVSGJxdi2JyLWQgjT6AgZ5f6xsm8jyvUZaUGadP31f2JrVlUKsZTVOJ7n5HxdDUO5fvEWzHxqc6KiqV+sV+T9pGSaoqzkqXqIoiesd1UlTFVPGg+2rARPxL8dZJOKZeu8lP0qvl1JbkjRFfWclQBX9Zk4Qm84aCwkdsCT6QWtkAQTAYIpAsQ2LDhizlkkDTcWUmPsnjLK7j/LNSf8AtxrM/SWXx9Q+3gTywYqOquXveTEhOS3HXhmvJwG7rxP1827eX8ElyT04zHU1PyVVlfJe5/sZPtyzkR5228YjVeWF7f3GOPioI543zrdA+EUAfrbEsUT4Py6YDMq2GEDkSi9igQyxqkiGEIANv+NzFgywiCZjTsdZKx9b0rxOlL18RJNth/j/AOpRrsVNw+RxzzWRnDHmtMzFftIPHVwXM/qP1quR0ePwW+p5NY9ROzjRkcYSpI08T0bnc6IqH6kqc1NbKeTn5PM1saOjA3mdksjRoRkrbsmvxir/AJAIDKu4LZBBJYRwdprYIFKUJMEszBlVCSjmdLTJkgIuZ0TWTUERm113L9qclEVMc7Js5lNfYGamZ5sI1Dj1UvKy8uQxVW3601vfW+p1+OUjzpJqyqxnkxF//bmpJGZTX7Suho/c5JMsa+ssIh9J6cehbitUjCBL11o6NafyTk0txGExMmLRAzfKIYKBsigOHbeoVAAEBP0rKyhw4q6D6cvgnJVIi3LKpkMkm/Hi1OUlWPPp8MMcztgivtYtkvdXITxFQpudafrO9hWyVX0Zvhm8cBzxFp0bpZvUeDxUhQUJ9MbVidimTz13U1z0OMEgmv6zU1X+OiZHf/1ZXKDaWBn/AMW5R3wQBLAZkQsEDJgWBnOCJBIKsYXZKhd//UWMzFzkFCMfUc0ZMnhrX+gHl8hYaqur1/62ydi5BOa+vya3EI8vItcShpCBm+jfx32rVsCPD1j29AVLTikmRrY6dVacmTJiIdahmY+SfkmuhR6f+25G7o81Bv8A+q/GYuUAwALs/XPcAfLwZfYKOIGxkwwk3pvTjSpqa7yTxX/bHFBUxeTGBMxUrUM1LvenpPxbS83x8lzzharVhW5ouJgmSZV++vG/JevOY8i1hxHjZLVfYx0DJJ9z91RU9/H5H/Gj1+RY9+Duq6QOo13LudnjWNhdEnJ5jetJCBpwhiYGEX5F/bVGzFgrAJoer2YR9J97tt7nn5eEW/vUfviRxcz1RvuZrGfTJqUZbAQRjVqpZfl5TcB9lnzDA/C7u+k2M153IMwFX6miovGV8MMwtxEQG/rONJqgl8LT3oNeLBjrxcXGjFvlaaonf2e1DKIH3lP2VvX5mahXsgPMGLtOFKAncampFFJAMGzBDIcAFg/XRBFk4LySdE5D4udVDjJxYryLum/1vQ1IyBUz+Md48cVgoEIlnjsFFKchvdVwTSk6peiYUK8Y7mJurGLzlFidY8ekj5LoDGHG3GdVIlTp/HjVVzy4wxVHm0+Sg55mVqqadO/F0ygSy1edVSk2STA2kQSObcaE2bmFwkGAJ7/QLURkMW4yT+6ccZCSwE8F3vRU8jNTtJWpP1K+i6MMuqf70GmMkcdWZGRLvWQ+nJFzzPIqk4omivLOjz8lqnJjqGOo8g+C+d71jpLN1Hw4/lkpZ/eSbrJwc2B8BSCNLyTjQa6nZk2/kWzsXfAiLx2/Q+ZqJUJggemRPFgBBZONRkumN8uSIccVEzxbMz4vmWm4D6UBHabXsnt0RlDu8ctNuDovp541pclSmSJNF1IZKZ6gSglJbxUMgMR1P0nre57zbqLNQTQ+GWC9vn8s2lGomZmsmPHbM6nJknqVZnr/ABtclvYnmUJ6oyqruTeyvsxwv17aZV6hzH+QCazhepvuICMhi1BDtyZIrt0p0LzbP1xxL50V1BtjmHU7DD1Lyh/UxTRLs6xzqqtfMqJNTqgBZUaqcWPFXMvpxv6Qk+XrG4/tji+wQpZquaDY9Btu1WHHk+EkrVsDzPPzVSy1TaWStDc+VnnwiPJ1Or/AYcYycWA320hTc3ai5JKK7rO3tqMPyNBrHNxFw3Us1VGl5brdZHo5dP6ouWpD8ZWCdzLe7yZAxyTfyAZIOWgZjHG3Vx4x81yToYZgw1kE4qma5XbLS1H0pqpbK2yEzMuph8bo20YqxM5Iw/5HnFdTjaYKYarG7KvX3KtOr18er3QcHW6wRIIC/UWFy9pT2toMkYQOyC/W0oqdU4xZbZxyMTBMVS8GQx0KRNN/JT2NVzKs1JJpp2MxjvWNjIH1mskw4sUXirgBvp1kF3eOCv8AHYHUF/jZDGT/APVGsVXMUEZGjnI3vapK1Z5/Ryux2MBinHW46qYncx5btqsd1asTTcy20dD4dz+eX1OsarPvvaPAOf8AVikj6ZI2jjgRhPQYvSy3GgxVROU3lhPhkX4d8GpWQjHrSWhXj6dD6XoQxyESTh1M3JDtJyTPUsTqdVkrRq6KGZv81vp7ccE5IislW4zIY3Y0TE3eUJj4ZqcnDMvMHZKStbkyzhqd81f/AKsl/HX0qkazXYi0z8m7Aqee+QCXyut1OB48OHb/AIxB99aoXIUSyLR4uIvOtx6fs06Ik9NbZWmsnlKyTBuO2gDJo5OBJx6v89U96we5+m/hP8Z/479o9D671X8i/nfvM/ye/a/S/f1HqsHqsOP23+I+2z6HFDeT1Pq4PVe5zMmsno/Weiywx1WOed/hPsXpfe/cbzeuPU4fY/Y/b33v+Q+ow6q3230lAekaOjF6z3f1uT0ntfpCn4rz+sx2n0r4/avd/wCY1/wt7N63+f8Ar/Teny/81f8AIvoc3/3r+g9T6Nxv/Hf8R9Tg+D0Hu3t2Blr0XvPrPR1i9N7Hlio/8D2TRikz+obPC+K+JI6vS6XSo/udb10miiPxleknApoHqrqNh6aQLrXR06PkNRQpR9XaB7wgsDMLxr/l73P2r+B+w4f+JvYc/pvV+6R/4fqv+SPc/TYzD8vv/p8RMfxz0eQ+THm9v9lpoyr3F+sn1VYqqTHvwT3D+Me5e0eox+m9y9PfofWzj9Dlzenz/HF48HrPTR6nBURM18npvUYMmPJOQ6nJFjLwS/gvofcP5R7ll9TnyXd5afU+u9XbJLd38mcMtY6Pnzj3VUrkkNpO6n6o9v8A4/g/5D/4zy48eLJ6z+a/8Y4ZM+b1GZfVe9fwjPf/AIvo9YogzVn/AI3n49P8uXk9PgzelnLkySz+dFXxH/6upoFaqNdb+I6jIIrrXpqvY/h3AW2swB1qqggPTT8shJQHMpZ9kF4T7Vk79EYWH5PRVWLJ1YBjxzVY/k+SqfjyOvkGfuEqAlu0rTEJJM5CYmblNW+YzPKSeaojL4omUJZhp02LFfoPcrx3VTjzfJjuN7n7Xzj5+KzGFEzQNf48dZOKork6XHjqjU8zurSOf8lEABiumjmX/wBdm3cVMzK6/H1K59dMkgm4QBSMH97IazAJAGBGLACSUDexjiNaL3D0GT/JWOY9TVWWfXdyWDjrJeMOPjf7yzwddeJt/OP9Z6VkouB7qqhvHZU2VrzW4YnDctVHP1mtyb3L6R6uL4xuKnBkjLix/JV1jg3bWbadRcxc7u71H0yY6h+1lT1vtc+rms+OJj1EXjmmdVOWolKcW+0yVl31HP2ipNzDjud/h/ifQnUgPEwUcxfsdTVSCwTYoA5/CJGPZsjXkGX0BJlbyVWTJU5ZybbB1VfCzBCRK/dqORo06SZVxqO6kJxs43F8QvySWT/SkhB/xtKxM1v9NPe+t9tyYaybxTlqpyOiTcyKa+TUGLmjfA0z1bJQ1+cjnxXOeoyyZCCsbDjoMbVanJjuqkqier7uuqJTQdRXrUdUVgEVBVZCZKf1wN0TrnNJEK3N7YE9gNudT6bn5awuWpXJ19utdDsw3dVzQtiUTo3kQx0zvfemy1HqWolcJEVkqN44i3J3rFV7jLcSOrdMyKfWUnnsKDEgCVWNy/HEE1aVqruld6oq/DJOuaZkOgwZblx81r6/FU453M7E+Spx0iUasRbp/wCrHUuPVD5CTgbWhe0eda9Msow49UN5L/1OAXr0L2r1MekiDeTvLWG6yD1eLPlMoFMUT8U9NVjrvKvmJYueu9wvpvV4ccepxTllx4JlkKx1WXHkIyN3dmLJ1uqskqMc1dS8QnlHtvq8eGTd8RON2GOt1mx3QXhKom8pa85Blm1maKJ/O19n9ZDcn2KmMhnyVXxtZpO5XGvLjnumCeMg45xTBU1b4HxXTroNVVLEsMom0ZsOA1nXd0zHpQBwmWIMrgBwPDnqfWfxT0OWMdY8cS1MzOI5qcfy1l01knnmsdcnWYqmZ2CVMP3F/wDQHf8AAftfvn8s92/5W/mM4838T/459w9swew+j9TjyZfS+6/zj1N/J6fN6nGfNj9R6T+P+mjH7jmwaLPcfWey5JHDFY8nxx7X7niz46IoxvwkZLyUzFXXL246r5er73N7WUoo65p/Zz/g3+GZPQ/8Ze1/wXHnx+3+m9F7Hk/kv8p9dmmfT+qj3r+RYsh6/wBN6UzemJ9Tl9Nj9Z6P0IVfzx6b0OWsWScs45n4X/1d/WfifhP6ZV8PT1KqK/i6qel6809N/wDUNKImoOkKJu9d3wXQHU6oqNIIoBqKCZgCMbg5zN/yv/8Ao3v+U8v8g/5D9aYfXeo9d7R7f6n3H0XovWZIqcOT1J6rLl9Xn9PjOMRhoqINXmzZNFi3LU/BWX+XYVK7+MmPj1N5Tuidjcz1cgb+2pRBRI0/f/8A9Gni/iJ/Ifbf4x/H8OCPbfZfS16jNbGCceb1vrfTz2+ruKzOT19f+PWT1jFYIMtIBy5cnwbXo/ZVkx+3ejyTOM7bxjFOkTEuX/2p2Y70Na+Ot6Pz7D/0oOlR/Rvg/R0Kqf8Ap2qA9ZYQqquWR8xGxDzry/jjX/7moMGQkkAaRAAfkA986+gf4d/zf6z+OfxnJ7d7X7zXoHL6THeHBh9R6o4uMWfF6nPGTGzMeryzmYTJBtuY+RN68t9P/wAqZL9wv1fqK79J/wDTFyerxcuf1V4au5yYj5cbN6i3V1Jjx5MmTeNirn8+ov8AjL/gD2f3T+B+m/mXuX8i/hHsXp/V48mC8HvDjy+t9N7bxj+f1s+gxR3gr0y7vJlzZct4s/prY9Ni9Rjk8p/5A9n/AOIv+OPan0vs+T0/8p/mHu9ZsHrfW+q9Dgxe1+1YcTjfTZfZ/S+munH6z1dY7e/VX88481ZCfT1Zf5Pw/wAV/Savjuv0uj8J1Op8RX1DT1aqemQGIqJ6ppFIALi6StrevpfEU9Hp1VdSgUAepEz2E5MILbD14p/yd/yn6v8Am38u9y/kmGI9vw3l9Pi9N6PDhnCel9N6PAenwTOLHjT5KNfJE1kiaWPqP1X7B7pfvXtuTN6iWvUYclYLrZMWfHRhqGrfGSvFwMtM9HOTxfC++eu9F6/1NZj0+IkyGV5xTinmifpcxYVch9hH9o7FL6H+N2el9F6smuI9X62Mcx1thjFfKyHxyDkDI4+qdMDTyH05+H6fT6FNFFHopoFI6YiAEOIZWbMDbzqOrWerU16ZMWxIuBc9jtGtn6yczSfLM1jNpWt/HAwTPy4xyu4OFuR6oUW10map9PPXipamZPFZcdVr4/8AJ0SE812V0B1Uy470b31mWp5msjUzM4bEyPP9mqLa61yPWWV4G7qGZS9R6iDmGqrFGRwGOmoo35Jx3IXqSkv9VTtXc3BOXSqP4dmj7SLDuSuy1dR9QJENikDkBx+42trVLghuuarVVN9TN30+aDgZdT1yr9AWghZ/FtEY4f8A2yvHXXVYZTqN5K+MionoomZo/wDZPnf431WRmJmXHIpjyMT3H21u7WakqkdvLQC0PRwjLkwmMxdRM5HHjZJTEbJ1d76gm0qVqa1u5GH+vb06hgEim6y1+8mcgpjXLVeo+l7yCSUBvPaO1xoM1/HliuniudkzZNZnrfyJaI7vd9WLF2V4/LmGnjbj1SGGtvbtqX5CK5Ygad1LXC8+ahSjku6QvCaniCZ657mdlR9bZmQQoqSJTqdRVVawZMtYd4/HxhGTHd0XRprIpVdvhZivqzvVjrqqqBk4QPcY78ohX30qAqqSKWR7KHMoYH6TqxOTLTL3MWIizMiBu9Vk6q63TpdGVOaVmU2eLJcY8aEIzMbndyq0zmsb1Ls6ardaR+qMOqkxFcRbkmqrUYsL3Ick4hrQTWyfCEUUldcQW8OTKbkipgqcPNfJbWTYGXJ1yfXdTF68SeJOa65OrTShE/TtaLBMiwUPWob2TnCgoXplACVOddNhbBhmM10hjtmWmMg1K5BkmhHgZNNca7QfsT/6D+vk/mX8p9BPpj1Gb1f8dxzk+azHK4vV0ZP3Px5amcl5cGGsS1knHOUiTJU/GWOHLkYtZvXyz8l8KSs1iNL9L0a/X7d/d3+fYX/0F+b4/wDlysS4cuLL7L9cGSMvqZjKes9FUZnHjC7PT0fJd5GvhKvNAuSmfl//AFETT/R/jahenpmq6/CQaRshkrC79vwVZ/8Ac9FwKj6WDcAAyDC8g376+xf4Pjz+w/yr3b2nNgzZKy5fW1ijJgr0Fxi9T6jFics5ckxh9TlEHHFQz/5UXRM4j8+Kv/ohPT+h9V/J/c30/PjPn9Q/Kziqox+o9RGTC6gx5ZlTEuMxyuKvTxT8IR95/wDJWevTe7fL8XpovBnW/RGfL6WnD6evl9VThyJkxZcuazL6XGZWCNR8RfXwfnz/AMze6nr/AHv1NZ8g1M5PTqY82HH6fJVtGS/UBN5brBT3lCybc+WMc7xt/Ff+lB1Or8dT8WXT/c6dNNUlEhZIzeBjXrfGodL0h3JIIiUs2UjIiNfJvuWCPUPEXjIGaouuTJGOXepylCV4xbH/ACMocxEdF7L7Q5PUJihrdOeW9YqnDGy8JZuMlXoJjFNN7sn5PMmy9finL6qsEyUQH/r5xTXxbPiuqybqrmI2Qk3ckiD57H2/0p7d7dk9Ze/tzkxWxebLh+Um4CwkJxcd1j60dVYrU4/z9bNfp6dMyflGRBA7ZyDMGA9eCKHVIEI5xKcYffaNeKfzG2PUeomUumqisYeVmw+WC73VaySd77cppJx1v88qcmSbp5WHKlVUtE3vxeNdS7nzrUx1KTLXR+ei/wA3zGbNkqZmCvU22SrV0VdNeohG5T5ApnceEA5l/PP8Q684t71GMebLoBLNpZW0Jd7aCuf1T39H8FJIvSl7XQlD7dtcnUR6kSNpKkY/g+jLe13rbKb8Nff+m63qLKOQ0m/BpK3U9RjeC/1RWPVVqtibrH4NkbkdGp56TaeL9SM3dzM8zUY8Yr9vCZJUnmVKZvaB1INSn4g3iCbn5eg1rpvhn+tZEIGNVvcgdVRzrn81cgQEl9hN91ggshRrMlLbvssppWVwXlase2e5e4e3+u9N6v0vXy4MuGZmRPkk1Fzc+W4yARuWdgFGprR+/ZcOf3f1tYuSPncnVbkK/tWNmvDTkyVs6Oj6r/W/yD3L0PpfS6x+jnJ6/jJR6266+G342ecGP6OSWNdVyyha+eXVYy8jWXLb95rM9p/e3a1XMr14+oh/UnSgphgkT44Pj2Z32RYpTuQT2VL89r3Y0FZYgyTkxzzVfHKjoaPHVVr6BPUvh3Kcmk/NZksFKTfys1kZ4dUOp5uXvf8AoAEEUuBd9hnH6jLUZAF0tLANeJaurpQhrZUjbU1KbkTr/Qek9hnA5PV561hg6xelxYYjJcVjly1lzM3mmlySuDhr6woc8FZQFVIOPwySSQL5nf6zpiloBBC7H1L4/R31zP8AHvW1i9XjwWV8fqMd4MMzSnyIXiyaCCWhqKFdVezdUy9XnmzqomCiayZO5n46Ymp3kVr6KEbNTRuVkl1qs3rP4zeYT0fqvRZYzSRnx01lxc2eMmMul+v+tQzjjhj6dVt8rFTHqMa5MLLRWF6crUU9Bp1VBEuLs/6bHrZmS6qSQQN44BtAgbtGBpq0jEC5gXEwu94bWuSbtyV0dNw8vkJ2E8ymseSeh5CCatVNxU/i8YM55NTzRZ3x9iOBhlXaClVCNf0eGuvwpamGHV9MsWDdka1vrc/7johnYpYdRQBr0yUlOP8AzfsJmb0myfEVd7WanX20R9hV+9UvcZLvERK4J8DQCR9CjElAycwSuxDnTasokmadcY51jJKr6kbpCgoGW54aShOZ3+YTbWS7leS4D7IT/iiBVH9n1sK3rn+w0HNFVU8OPI0hZIH701fS76quuvCsmN0ztFunlZquJ5SNl1UyLVZKXqansL8bZG/r9mwBu7RsgN2TLzznQVe5sCSP1Eh84IOh+PNMR9se54qKKleOf1V0aXmRJkdz4K3SfgYl5lrY1/jrU1bWXyFzLITK9TNeeWa1o/sypj4MbS80nOqqgmn/ANTXL8RIFWy0mzro5ZjHZt3IBJ6dSFvZJ/kRoZ1rXkLknfPgpn1SAP4Sk7L6BpoJsP6kiAGlM2cORYd9Fivb/RgiWPs7rJWpijWQlBb8ePLxjXqN1F1XJWP/ADaYUo3M1Xl1U0hrX2eeWlsOegZRN4qBkDEVuZmRZTRf/Zqh1QCN/wCujr8Tp5m8bsmJXH8ihjKWhVmjnQaqaJFqils/AhRGCwQjbAYjdKLZ1dgeLyADY4xunyNOKvGa+XulbPk4pI+r1jSmZpfqSSStvTpdLjJj8yxTXyuPteZqUZiap5rnfmbkjzuWZuQYVnFFNVOSgoigyWiecVAX8Umx1pCeq/VT+CuEgaoy1qK7NXVvM6LyKDrl+qfJz5Gridr1pB2UHAQTWSBYjtF0CByp2QhBxJxZauWjLqojWKXxyl0VOppdtZKfFEkljoo3tq8GUZkiGSSuq5+S8fioiK2/Yo2qP/RRgpGiiNP+XdmqhdGPl3M1A/SJe05kCt7d7h2JXWmcf0pb2R8i8ry2VTeqJrrWyWDpR/AybRsQDswja42GdBLSwYgOFhO5/P1azHxXn5Dw1eyAmzkCUOmvDpNBUzwPg/Cp1jv/AHOSiY/7sRSftNTHBNdeOsU5PrINCMc4PNf5JrU46JWvjsPq2cBphdG2Q6nvXH5HyLLWRnXLhJqaomtJOWWnxpftknVbaNb8NginCqRBFzxeRsAFfL0NABYLsgkLsnHBD5OjIxuQMceXWJvzdb+nlmyGWnocmiqdET4D8PJ50c8zjIN631xWvsdNXOt606WHZuRtO8is8tVOXHBoonKaN7rbTTrc3/W0+yP7aZjTVyx9XElSbL19iqaK3vYWh4E/Zv8AAEEJb9lHFkfqG1ILfTbIkwTURlThRoViseTWo5gLEZ+0nPUY6KSTs6qU/wBzsSX8DHJOGDcoSUhz24kxjGSr8qS6T9huaD8PFl83iuSKpqby61qXiaLyXve9pFzG+tHO4dlY0RJv6nQQzOOscT0fcanugBmT7kupdp+V/wAagcAN8iRAREWBPOqbRiLWhekAiZXYkiWVBt4srO53q5nucRzuNGqjbSVPlQNk8vkKSvV4z/Hv4yf9vmsSbnh6+MOv/qtX4dgH4rF/7flWLCermoAEY2hyNUTpUdzW6r614m8gmWd6Sqqcsy45yMkjjs6nfar2bUNb2D+XSQASQyQxaCN0f3sf8pAbxgO3GJyu/AuXWStnGgOCgCmZJ302rU/siglqmZGd7K89Jw9fW/jK1aIJ9FTq4vTpJFnxRLO1gYqmqtMcLVm/kqmZdOM8TUSu3XjUzQ6DRI2XGT4dz8NV9vtRunlbKSMm3YaSZRne0/IbRJkIENofLjndCM6n1CJRBQYz8uAfqlHOnkzUVcMzzW7Komu4emMko1zquDaq8nROj8i6yW4qBMUwY+ea5WvqOQpesVkGt8p0r+0Byx9f7MUhk6OJnJFf3i+L1XWpmQdV9TXkTMdGhTr/ABkfZqGp3zFvVLwGgdKco711+WDiBZ5YHp+n0lG+gVXpIE+naYEsxOGDcA3ese2olg3zAn/rxd7n48it6oGqxm/FOz7HP4nJGWeqocheUfj1yQPL20E6DhlQuASqGi5/GTPcXVZHUo/qi/8AFM7xhReoNp0eNjJ/9oabgLKcvbBNLXURWuSsj5Gea8WPO2nf6/EQCHOCOIBW4KcW+uqCQj7SEMOAp+xTUyd9ZMmjWKjHjvmvp3sZVx1V0rwnQztEeJmauYZzzi5y1Exevk61d6Krz46J027WzoliOUa2SzUMk2YB2iiH2yVXliU2VIfvxtk2V98lunkiSj7S9AzdWNKmhu0o51TvVaKflQRqSqPZAtyhOACHdDVtEIJEld/Tb1CEm/T5jR5B338du6llngPjySvJU6GNNdeP99m/MlTJ0eKjmIyTjlNThvUalqje2TT1zrl3Wr3+WsdZZni9U98S2qTXjnJNGiJ3sTj9vka8KctZMdMjOrs3tq5Ouai/r/jjSfuSvBuR2y3UaKgwDiQSUVMHgLETqSaSAosO5n1FNDGwKcI6A4j4oKAOTJf9x3M8fJXR40VLOtTjD9/pZQXsSfCZCvqRk1M0kz9lLX/TzfIHOhR4cM+DuUU3PVGpHpr6IYrBrwkq8DtlP01E4hd11JjKua6KSa0XNIQVNBQvP+l50ZAn8MgRYRwh+n6OQSxSg0EiDb0opbTAkEkW0mrqbjIujHkJ2tWbXH5vG6eTV/38if5OnY3Kuqp1jgmuTnmg6s/9vitwL1j8/aUPqsj+CcVdRYV3Vl1zJqu8Wu2nTLXg3p6NCV+Bdz4U3s+NeKkrJQ6tf1yPQ1JtSq58bXT8pKIqLFgHf6MJAS0zK0BAlAHEIO0LGebEnZebIzlVGsdI1HJzuv3jUQ50NqPh1QV9oWIRE5cePxkuP19qiaSpkqZZio0tTXUy0bWUPxcxkuNuhmzsUclVjmKu5rIG5lNwg+XgJ/t+ZFnVN1V4zZ/V4rPs5Gaom8YHU8y1T1Jq9jTkP8LYf6HdC3G6NvcDGE0oe1tgpixZRjprooGh6WE31I4nbJc7XROik+PZVSklDXJjCsYfXzDluCmq5Tz0O9TR8mqKmeFTJU085Opm5f2TCTYOYOQniZ3zrmhXo8Iq8/yuM3JO8dL3bqSRq1dcGM5Lj+0+HYbWZE0qwPLVwYEAONiywCiTYy7z2xan/jwAChbUfJ8eKQx895IndzdsN6PkECZjsrRq3ldRQJTaE+2pyi/W5rSTYVE5KPruEaY5kT9bHaBeLzxfxhE468aSxlGYvzTFsvXRlU4kHV/kROZKN8rdW1VsVlgT68JzukdTPhjetVscwMkRAClCAyv+MOBCvICNXpgyCAHMGJJEJQQACs6Zjaw1WDl82mOn6gUEBlyH1ZkLViamSKrQCUORzHNS9qkZEnXi+i8hkll87qayW1X2Xlkdvx0R1aABwnHVeWXeM21rJSapf2gujdVzIZmuz76cd2oF5OtfGyqwHe+idoD4rdfllAAO1jZAl8ztjYPQUkT8w5IOMGIp+wsCtF5VIE0mOooXT4ezJ9pHGblyaEDaTKUQdzltdZKqGkY1y/7Me+enuZYPLa0Uh9QZz39fixca4xVQZD7qNVUbkZ3yVb+6CeAKKZ8fy2uTIdn+evsH0fLia0j0GiYJihyfY+qgIPpKdxsLwfDCiWFOkLg5XlMDbtgp6mMl/rX/ALMyzk5kv7PJ3kt5oScgJLIzoJ27Vjsx5plnVBX7KVqaGbXH4b140a7o08/X8bkZkmt/9AiY6+PJPU6iyLvuqnlB1/8Aboqt/iutZMfx4ZQFtTSDYLihqWtV0fMmz/sHJ+NyyLKJ4uiSQALkuEbAapnLCQyxYJCyV4GNtPx5CjaGnUPOHS5X9ZchQ6glqexKNeBI2Rec14nWtFM46bcycmQ3+z6szaFdHiTjwOyi8bMkQsYI5Y4uiJMnFZNJld81p1XVBvfUmprpJ6+MXeOWaprvwxT/AJaNUUMg7qU+x+WzCkHBWwwhcPk7qdMEIfSAJi5UIA3eChKhxRVYd5Zdpf8Ac1U5GP8AE5CB89Hiq53WX+xQSdZAoDKH9SqDU7Mm43Vbn7crV6Urfg6tI9Plch8mT45xz4jFRKzvnu2eugf1B3ZWqNH+l/Juqp1X7xTNR9l0EVr/AF5Dqw62ZHbQySTQgac2xtIdjHAajGkCIIMlnaAhLgAm0Iwlp95A0/QmGcPExad8oXO15dtPXioClFDpMnzbO/j5sNVVTNUIUY+je6bRdQaHHUlJ+RvJJTV4stM9zvmqiCTWqXGGSaOQo/vTk6NVP5P2scgl9J6m046qV3WK1kVnmdTxQvjr7dfiEp7MjcxcjCIgbTpoktifT2UWeC4uHeXqfUGPIRNPjHPyHEzPTiOHGd0UNANAkoAasH8KMuqkx8XvDWj60x5DU00ogGoarVPW2a8rorJS1Y+Zym2A4HTiu7ZXxRuP21VS0XQpViGdzRCh6id5Nax7+8PM9aqdJE7kFNnY/l0gSUn+ygRi0qQs6oDOb95Am68stqUdF8WG+jmni+xlOzwVU3qaNVVJTBIE6Qf1jOPk3k4fpU13O9dkk3VDdZNGP665phmv90gbjTA5sf1qcb+5Ctamkjn+uhJqZLKGnYIm8mbLY1vFj7InW/je4ttnjtgP9KU60MVvQ6Qo+apQCcXZ24ZiCnpCq+GQwZ477sA2+UhWvTXBdH2rLQ9Btguj61YYzSzuprdNMq8j+IKo9O4tVKZJGtXVUsozXk7Chn5NHh1z+0fqsh4EYnXmqhzGPzfJStKp5UWNqS/apxYuc02sycqTaUA0IRuAqgOsUlvJ5PGxOBZIt2YF4uHyjOdEYb3tJ9PElZEkXDGlY4jJKy/Fc5BvHkYl1Oip5ZYqZp0S1vxxrTLbaG5rcDU3MsH0+Tnkaqd/J1TU8610v2Jp3UTEZcO9zPNlMh8e+SSlGV+5QG6P66o0y/i+atT5EqclJtyTd4551G6G9bAdVNX9i9MaEARYWU2GLhQ8b6BYQngeFix8imwVtZlq6p1rcVgmtGqy1vW3vbRPUjrS2zKeT8gymKKeAf8A1fbzfep+00sVONStPNa3XM9SjJj0UddfJZcm+bmKeeaqmXcVM7jnmVY19dfist7uMXjxMdsmmmL5IKVbaN1bwdh/9VH4wfSPUReEBIaiYa29tDsXf5YuPHkZbm14oy1k1kOhyECfSFmZmuuj/JOSd7vfTRp2h+ZdrmNQuOWZqfNt2yBlmavfBUfTxPLt5URbFmSA55519CuWmdLYdLSFc6NNOxl1N0kSrTj/ACY7cPXO1yOha7rb+7PkDy/sKx00X+UxyiWQEAVYt22V9G1gCnFmRePoxuECBosFV9hx/tcf+3JPXJ9atkYl6/0cC0aZdvzq+OQnHtosFuydOaxyNaXnln7b/U/1KXJR/kZ+/nFk+syRlA+/hquaixWpV8J411n96CbZAhavduWRlY1U02ao3xqb18Z9jog1H0jJzi/pRJsZLNjbEaASBe6zFsjhi2FsRqccLl2XDFHyxDc8E7mnFYSdUBPMeQouYyP3kblyVXiRnVxOoSZcn2hqhaow0hvYSa+xzJ+L+Rie+wvNcxhGR40nWYWYILqF55rX20L0p4ppqryu+S+eybclHKZaaiKvXWpqW6q+ZSa1uKiaUKC47IFMDxeHlytCAGT+GQAyCA2A7OQkYOdTjjPdZeyTzkSreZ08PGMYIfO2bAXVju/yzNcC7m3JfWPJ5rJE3OpclbgkEdu3WpqdvWwvJVTrmpiGcb8c83uo099O2HmT9T1Es0qctise8OIcs9dY9qtDFb1F1pNGts1I01asuqIqq+VwSyPmN2A58W4SzpAD5v0QXy3MHDyhvnMfqcc8VV+DUV/h5KuEqHJVTU06f8ibrkvc2JqceSjL6kZlDKs5ONUTkCtY7y6msZI65D/d9db26Yx7kXHEOMZ6nUmTGOqifJ553NPx2/aZ8zL+Y/J1PxhwRK3MTrIzBvs7rRzqclOqprHNSbaOYlUguBanhBhFRyucTRuGMWLI9KGFaCJEYsNFWo04zbkuaBvvltHVVVzBU1D8c0a6rwcrMux46qsm5+fi3VVM4/UB9UDI7nIn2jWOamXJ0sMtfgyfJFX98e8kfJLV76/XMwlJBvetRTPUUTMj+bWcGLH6fH0QXRhRgm/kWVPlrVTjUOsm4NQco8lPLVXTYPgEsOB2Pt230/xEGkD0pPdAWFkJskW3oYwYnLk9Reu3D/et2wOiKjUQfqZ3W3mm9bmpTZzin1Eh8pLyZujkmqa5IR6TJc1rIb2y8dFeRE47mWmZzcJpJqvjx14Bt8Dhrf7xpNJuHUn5cw6wYKyo6NZbVKqi7hMMKwSiCfdCutLvR5vW6qFUm59yr52wjvqzSjAYgxwp4Hu72Q089NFVzPxPGDsTiIpjrkuVa+wm2eTJqJ8VU1+XKx84cNzidc44vJM6fFdFsNbaOaq7TzvuJVtR4m89ZW0HFM5Mbk8XHRrEBzNfT6LVdRc2T1F+NgSyRVcmPkjrIHZOjV/3R0c/bf8AjWmjXT+eX1Oo/mJN7lCQhaQH91GgRZqzPiSs5/1pmPHOOMVBEtTi/phMr0/b/wAhIquMhXmtBX2KTkZNjh9M58eTN6f0/qMmDHh69Vlj02bPhxXVaLyXDk/8fVUb+Rlntxjtk/KVcRDW6e8bVUtVbDQs/Hiorcm66w+A3Uaqij6g/wCYc/oL/jP8P9r/AILin0H8Q9P7N6THlj29r0x671mb0mH1Gf3X3vL6esnpvWev9wx1NuarbPUenzY8p6ecPp/Sx5PxPxY6XU6PSAFf92oj1NU0oZQuXACCkmBraigH1Vv8IDpDcgJKw3S2185Yp2yY5+SQnHtGy8typnl7pjqkG9GR26lfBayWxSVKc6xZKubRyVdDmT+v1oac2yiutRuaPzPRehcHz4vlcvp4mvU+lFqsuPZwTkLvHuBmWfjNKiI0JsqxaiLccc1MkvJkNUustWW85JPPd+ceOobHIp+c/Wq+btId5NyFER+VtFKqIZnLKVoWFucpILX0j/w17T7X/wDe/wCkz+8/Jk9k9w9x95/mv8vj1FR6f03qv4p/APTxj9r9srPWKuY92/kHuHqvTc4MlYcufDjN+nyY5Pz5V/5K/nXuH/JP8x95/lPu11l9d7t6qv8Ax8VVkyY/SejkMXt3pcIyM4sGDHjw4Y6IiMZUkkv59I3609H/AMI+7/GY49ZX8d9q9mfUXiz4PUYPR+5fyH3r3L1uOXEEPpfUx/47myWdZIjHkyFxi0/G/sRGT3j23F3M4/8AyvTyjLXbGQuhjf26rR1JLWsmOdUSPm/0ukVfEfHfFVfNVTXV0+m/8R8pqI3YNCKLQ1p1q1R0+nioAneQABjJJGz7a9q9k9nn2n2/F6GbkzY0zZ66HvNUjkP6BeNpIxQVrxU8mpK9P/4ez16X/kv2P0VY2vQ/yfL6j+Ie4xWafTYfVen/AJB6a/R+mrO5RDHi90fR+rjLpYv08/HrNEVfB3eWh6xpMW+IGS4OqtZq1JydcD9IZJiuUKjtP4L7b6z3L+afxDH6HLGP1P8A9Ovac2DLWWMWTC4fX4MuTN/5FGVn1OH02LLkJJecUXdL8KnP8Yf7vR+I9bANFQZKRIg8+m/jU9EvqUiUMSnA9xZnbGvLv+RfRY/Yv5t/I/a8dkGL1XqKmKR+D5ojLl9LjWTE5MHqUxTOHHiPkioZMqT+D7Pny+5e2+k9TUW9YibqUnZirNhyBNtLFsaqmpMjUwjvc2P+cfWR67+fe/et/wDI+YvLVtMxi+TDOfLUEGKQqaxssUU3k835Mk/lT+I4y/477bc39g9XkJumhg9Vl/wkrG62yMvQlWSlZNnT0mPgPh66n6jRSiSP+If2PfYRoP8A9WsD8LIBKtHgCxjhWWukjBNQWcc/ETe8WSZqyp2h2bzSPfVBX1315irpZcGOf8pn+85JzFGXGzt5TGM8sZBoKjHzF0kNaqU+j/8A6G72vH63+a+4/wAq9w9H7X6v+O/wf2X3X1nuE+6ei/8AJ9tye5+8+g9R7T7L7bMZJv02f3LLkz5fWYPS2mWJ9BkvDTOHG/ny1/L83t0fzT3XB/H8uT1Ho59yzR6dlvHiQ9TZWDHhjuTHw4nGT1M4iZb0404/hfiP/cfF9b4an1Po9OiuqsFgVH/A7EAA9jMa0r6YHTp6pg1OkU5IHpRuS9kedN9Rgx+vMuLNiovHTv5FxTbCxUpm6WvUUU7CG6m4sLwfJfJ+4+x1ja1jKLy/IAWThHl7q4kf8fNDFTuP7s8ka77dYsMGSpMlo5M0Y1qjJAJbNff4ZGK6ntSOhZT8sHw3J/XiMZgsy939wRuZ80aG1zV9h2UVz57+n8RX0irindAkcSb7PdK2sQBUB6qSCR+iBnJtsd8eOV6LFM3eY623mx1PxS8+ZmDoBy1V7ooXVP6fJWrHWIbiLrHSt44yP1jKieRIxsxLJjds1XcWD+en+4+wObHWf0U/K4a2YnRljU1TjMfxo4zZ0T9BPN8aY5TJ6HJiQY5pmMVFNWTdWtNa1wY6CeaW5OSYqdxXp0/FU9Whgze+2+1hMfYag0GkWUD5pj8KZkM3/ONL9NkrKGoJqMkRNxMT3ctc1W2pcS/V1yOxemKl6X0nq2O8VzebD8mqimt4slpJkxXsKmYkVpZV2jyrqT0vwo3EZZyu4qZh/wDYbi7rHZj7GejZ4mu5Prr833svtPr/AH33P232T2r0teq9y9y9Vi9u9D6aIpr1HrcuQjCMdbhloyZPUP8A6+by2zE3k/OL4iqgUHqVkCgAmppU0gglnjmXa+r6dRNVKBZIgcmncTe0+xC+iP8Agn+H5f5l/MfRR6ivUYvZfZ3H7j7v6jH6U9REYsGTr0vteSoxVHzeszYIiMEt/J6efV5JT4xxfsXl/wCRfTfxX2v0vsfpfU+mz+q9Viy+oPT3/wCL8k5r9N6bIZcPqHHNV6qPU4Y/8f0TjqJyZIMffpsfyX8V/wDHH8Z9B/xn7D6L+Jei9RVeslxe5fyb3OvpHuHuVVWDNh9LlyYu30WPdek9uwrLXp5zWy5M2RPFP+W/+TYz/wAj9DHp/U1gw+gzdERefJOPPWW5rFUzogTFinKY8tZcc459NDlnHMz+Vf1D4er/ANR/1OmmkH/2vQB9BI/F6SD6iADJg2sgoevc6XUHwvS9VQArqAJTBCNMYgLlZ14Z/wDRI5Y9d/Iv5X6j0+Sy8/qM/qJzZgnPS+szrix8mLHniu2KuAmrmzFKfHB8W+k9L776/K4fS+h9Z6r4KVYx5qQlMbD9LpxrTGiZ63yhX6+j/wDkj+RT736hzVNanJkw2Rny7G3I5LyiNRjWusUDrGF6x7gPyn/G/wCT+w/x30eO6xcerIm/rPLnqAu6zGOu6yfIQTOaOTFIXIpv9U/p9PV+D/p/Qop6P9yumimj0CB8oAFRhNljNw9eF1qaer1zUa/SGyQ5tvaSnxfTv45/xf8A8hfyL2e/XX6nD6H2X0XotepPUev9x9TnnN9Kj0XtvtPt/p8+bL6/Dj5twsF4ZP8AJUs4SY9z/wCJv4n/ABX+N+p93/lnvuX3H3jrJn9s9q9HlMF+nxYs+L07f8jc/pPT+qw5M3Wan2v02PLcwEubLlM0x6H7l/8ARQ+5+1fwj2z+Gexx/wDS6vT5fV5c+b270+P03/meo9UZDHl9TnRy5M8Yc1TeYxRbjwYsXyRPp4o+T/5X/Ov5B/Ksknr89uPFdZoxYaZm0kmrub85LzIdX+rrnwdCc/w/w39V6/xBr6oo+D6J6xNI6QpPUqoBB+arDmyIW41t1Kvh+lQKBVX1azQB/wBoJFP4SIX6a4p9S36zPWHG85M2WYxM1kZlyPEz1568/UP1zSbel9dPasnov4z7Z7ritu/T+4//AEu9fjjEBgz+pwYfWekzX5lx1fx+r9OfPzusFRE1JVVpP4F/Hn1vufp/cvVFHp8ef4vTYLB/8n106ydsOvkwYe6p5qlyGIBS2fY/4Ng/++L2/wD5M/h26fVeo/j/AKj+Qe2YsOLz/wDTX+MetPcXJRQ3EZvas/rBjDvIzlqKIhyT+et8Z8R/aRpJ9PSqoNbDiqoUklv8FJNR2Izri6FBTMet+jcIAiAe2021z/pMsf8Ah4//ACfQYfU9c4ucuKaxuU2/+T9ZrJD05EyuQvfmS3FX4r1Xt38d9U5Lyely+gy9dXfo7rHjxzyjimc/U1cZL8RoKlECidp/j3qn1PpseOJirxj19Zcw4ybqyry76xUMdPnqoq5+Nb/Nn6z2/wCf7STC2+oXUHcpW3JN33OT9bxjLUpNPyaI5qwRWVWmj6hEGxXu/vrSk+oHhAsTezHiZ/PXNeo/iWL1M1Xs3uuP1cfGYI9L7gT6T1lULM/Fkr/63qzZDVOOu7REyC8T7h7Z6323K4fW+mzenvijrNip+XLPS3joXFdT5ZzRWmROZAXuPWelz4XJkwTU/wCYchM/Hk8tLczllZnmf2UjxYnKE18f8k9RinJ6X3X0+P3H0PTFen9WVmxBoncVUOSayYyv8kv113zJSXt0up1aQoqpYt+KkXgiXsRB7airp0Ey6SSAJgFBuXDwP24HFxV5DU6rBWV+bzU3kSZvFp1T4IkaI3WTmnxS7FTM6Af8nPyzNQtMs/Lf2nezunJspaRj60/naZf457Z7tNZ/4/l/8bN9vk9q9TlmVbk+np/U+NTDcQYsv9XgWS8e+T9V6T1vt1mL1eCvS1IB8nfN/GvlyAxkn62wjpk8ozzXdR1qKghFQAKKfsQQmMHEbayqorpk23HhT9vbGm81bAzrnRRuZm4F6/VI1Vfbxqa35HRX5am1eTCMzXFW46dt+DIy0qyFFZE/WxPp01sCZYm8bkyZ6yM/ET94jRbTy3kmJpExkSaKcoFSR1/tP8V979zqMmL0vxYaxD/5PqqrAbo7Wot6y3c7mKYWrllOyj8w61VIYJpECCrRLn7RNtVTTVUkNsCWuN5G3/ata+L5gH6TUb+QXdNaZ7yRVOOzaqCEh/oPz7R/+gewP/56PRZ3Jk9Pgy+1+ojDbPWOkzejpxccz8mAn+5iXJGMqdDVk+Hez/8AGnpsPwZfWZK9zsqMeTDjmsfo8WbIcHzGOLpmWCnJkqd/3MVk8z9l/wD0OXt//wBIv+WP4p8BPpYfSe5xgxVPpzFLOPITi5xDe8lc4T08zLc24XJjv1V1Hx//AKj+K6R/pP8AUOjQXX/7fq3u/SoBm6wra9P4PomnrdE1QKa6WCBkgXAVjNsXGvcv/oj/AEvrP/psYPgyY8WP1Xpq9Q48eX1GXL6hjJhzeo9R7fkjJm+C5xRiMXyTP0vExHx5Jr85/wDkBy2TfxGOYzf+JlykVdvqsE21mzenRcOQy5OnPkXJRNPLGOcf5+pX/wBEr/J/Sfxv/kH+F37nEeq9r99w5/afVxWCoiqymAw+44c+XJFuVr1GUweqyZPlxxNuMrL01+eX/L2HB6X3/N6WJwRMZMxOGsU1MXmvPWP1Gb1WJjDkZx+TJgCox/5GKsQ+X/8AR3U6o+H+F9fTVNXT9VHUwVUklBBZOQ+y9D42K+oCXNpIAIBCxk83Oy+VJ9rye5e6+n9IQmXN6mTHGTIxP/src6Ip+LJVTTVaVnJHU0TR6z/JfaJ9j9jwYYxx8j6Qy1EZzm8ZGSTJkRlr1Mt4yMc4pnpnj+lU9P8A8X/xP/6ffyj0fp5aMk3Q5YwurzznhDNfx5+cVDHzeomufjaxczU42a//ANEhfofZ/efXeiweo+cxekydz6qMGOMF1kscPpfgzVh6xuqcGOmMVV6p2Y7xYz7er4+nr/1Ho/BAn5KPUdr0iQ4g2mci+uE9L0dGrq1Ayw3YAAkd4hi20v4Y/lfq59T63JTFMxlTzWunTvJRU3kmq3vtoQNBrzXMY8GIxm9TyfJFP7nQBi3/AHlfHjmvNJo3KbH1eVzepyW18pd1ctS0vyWstUISxP3rw1CuTaKFesWeZx1H3842p/cM76dmM2gmjaBtySVF/X7KikUU0qQABkogUydh5Kxka8En5jVd/Ndzd7gSvqtZWp45BpmccAL07njeSiutjLdIbKqd0LTM4Kkn6zWX6RSS8xvbLF9E8STtqTRTplFn82WD0d5sPzYlOKOu3WTiZlqZx1OT6tHJaginQImwj0WXH4vGZTJ1c76u+NBJWTckVjpNwzs8cyG5B0sSAcCDA4lEdltvpi3puCkGIgPyAsYGTrlMvt+Mepwu2rodys35ZNn1010gnTyp4mOaP/iZuKaiyosnx1txyGyehujewdE7oivvLX53H/jXjwrkgreiVIbW8e4VmiZJ5yTt1ybSd1O69+lrLMyWbniwlpEmUSkFb145tJR1p3XS9QUmIBFtsHgcak0sMTYzA8eWRwrRriru6v8Ay2RENzQPH+M3K80fa9V4b5p/7BUSu59H7l7fgjDOD2GPcMhB1fq7zZrySbK/x4RMdLzJI7oCWWEPyp7r6PPgy1biu8apDjx5Mct/01c8runfX+5llp0P4r03rfW+nmf/ABM9YWiZHH9qLUZG/iqh8SUqP28eGlu97DIgYNxEen9gtSCQUc2KBSUfzxMa3GT3H12XGzi/jmHBjupuoPR1X91Pj6qcdEgJKVlZo/spQB6esuOKusGb0jNd/wDjJZjLubSsXOzFysFTzTJ/f9h+IznvvrceK/Ue6Z8icGPXqQgGWNdFNb3ve8fK/wD263+Ri9DWLI3m9y9Q3qqiVckXa6Z1bJlh13MRFVQUN97n8k/L2iRIPhyRMfTa2WDPBaNhKiLKVCyNV+Sz/wBgjzlmVxs8gHxS6FTwOOSZvdf/ACz+JqY87xePmToCQpCdpW0x0C96K+pKaifxnJjmZ7m6u8aaWjGUc8fKEzMdzIxwNf2jSn4trVdc651iLvrY73OSqbFPAFzJtnnVI9fdQbjYq5sFu3AwleZB/wCJmw2QA8HkrFnp4AI1HTrLNHNKOiMW99ruTbo3p2jxoXGTH1eLiu+b81WIJ+jVoMpy8zrzveupfwCKnw5Smn5JXVHx63y1zrdGhxn1a+wn7/DuzNDyf11ok007PCLVUUc8/oQJoPFNBEIhFL6j8wBxIWgiyDgB9wEb3RGAubgYyY/t9tzu8YaQgEJsqliJlWehEB8fXdE5Ix33O6vIcqA6qidLUM6lZvrx0m1N+PyCMs/YiFIekaOWXfSFP++HI1H9uZdj+B18XNUdSs+A64y/2KLeIknWT6OkJXTufxSB5kzaB5Yhr9dORb8zISgbQQeJpJGjySLjppqMeKfjgGpMil7yMEaA0olM/VN/6WGS9dhGomuaQbgf9zkG+6TyDM6Of7b/ACK9QlTMnTfh2VzPWQJydTqZOukdany6/sL8lIbaIpInerSlDV1k8vOty14XwaD8TBZBMJsThPhf4gpe2qMTGzvim9leQO+gKx3nlxVO+GOTkx01YmPmbKNnIS2MpU9O5/BZ/wAvM7Vauepma/xvBM9dbZSeOZ0HX9dksVgwtGQnl2OsdEhjULFk2BRLtanzMu/H5YvkYRD6sbh+rPIx1XX1bDlrasu9UbZPSSGhBhZsjgOPpvOpfpwFC2mDYLdQNwHoMRGG7qSlrcO/3EaERNTJKIWUrqwEOUKazMxEJzRu+XHNEoI9tU9HJyA0QTy1qvwsWS9W8hsZjkavZEfb7nl0P+TnqfB9noYzRX1TJZf0aI/7zadG8btQf7UnU096mw/FAEWbPlYKuPudTIGMK/FV4sDuSCiMN0rkFJ4n42aV6WpNbmcr/UHXXTX/AEXrS193AhNUz0DMsrEkveWnby09N3JuXqqNW/llk0fbeoKGamSsZ1oyO1q153P/AG8zoUWviy1HqMjOkqJHpTqocZUwbFHTp30nhnZr8dRHy4O90O2JE+0rT25AH6jzvy3uWIuY+2NzG53U1V3FXJJN/V8QFv1kR0m0op/3ay7kX/KInaBy8z8hxU/25sHdJKH4so8jVTLCq9eWhTwKNG3oCdBRPNC/iqub1vTkx1qZdBkIJ66q+qqlASw6CZyTvqmqYCv/AC3vBROONW1ccCbyA5yLM2en4/pW7yEDvL1QdcMk1j6yf9tdBqeDwlFaPxNkCybrHeSWMpPACeMd2dAROtsyk7ono1X5AS99bp6ald65OdYmqVqU8hHigs8bNmZdNVMdS5DopyX/AJHQUDzzy7ma3uEOj6v42P0ILunAsDusbaGQLXIdrRze0/8AbIWm6ma1Kbt6mSpmCL6lx9zM1P61w/Tyg/v8w21W8bLpxlTCCnMm9tLsnzYPn66KK/BqvCdslT1s+Otr+sfjmo06Kmdhq5m2r6/C6+PFNUfJwR5/ugksff6iQlPLrk34fL+MVAKEAGTY22bxxZZIM1VyMEK0f45INwYS8AsGDI26xG0xJc8sH/U3/kXvM+DeiilF1qmTH90JZoxbyd3JXx0T4oprzTsmkDwb5o2x9nVw15DL9eZx5OjdSaX7MkSjsrTMyGxXSxmMs07yYzGxv/HHSuMWKmCeeeQKZSnzLr8VJS9UOCBgKNwfAPcekaQmnZwWkAPT80/5SLSRYCHLMnRX/wCFYn6/o1JxkWWeeWv0a/fjQo6cuspiHSYjF3/910RM1V6b2rLyHVaxmnW43kyIq5l5mtx9pvZdVFamFN3/APVLX2Xe6/Jya+OqkN4626+rTL91DqqnV81UuqZnrQTUtEF2ylbbth399MAgmwPAtiRa5CBvnCbeeSmcczDOMarlmayY9gEfIdNOw2HaMf8AWu0BXxTdSjkoLaCnby9E7JMYzRFUfRHQk0figyZ4+SvoM/UAqpJj9W6cvVdG1lolXYXv8sl8Y43wvxa6ZbXxom39lTq1p1r/AGfXy/WSUyl8rABURckCLEv660FVzCvsgxY7xPZp6GXuv/WxclQbDagdUTa270o/voqOZQqsjRjnJQ3HRJcZAvFqZtmg0fWXJVyI8vf25X8xYyY5rSTIww/2M3DT0HVNCnNVtfPYzqpViqt3XfBkyTNY+qJrmX5dBMpt3zTS7K0y9fgyCAmSrRgFoICYhGUyNTVXjcAjuZsN8G6Iw9N9RMyxkxqZlJt+vK19y7uHUi8nKO5NfrSJx5MkNbOj5tFWN8LRzk7dSD5NgGv9f20dXitmZGgro1MzLfRzGSada+yCB1QQBJP4Bd5btf8AqVE1UpEkfU2Xt0nRNhv9Gz7P4iXUCLsFB+eCWxaCozrP1A1RDNg0LA+JLABItLlmXLHybMbkoKjLWiIFSDdrcXDuvjiT7Eqd2msw9MVBJeOK/wAXQDOsR9L2z9aFnonnvrSv1/CzC4yXINZMkt3J5ZoOTJZOpjo1OPW6mW16/Q4xTp5anE62QFgTPmt7pfsfs61Gz5PP5QJJcIKO62bEAWJGNVTUQXCJAPCR/DaPlAIB4BOjiHMF06yf/ZcVVM1M6KT/AHSK631ulZo54r8Gq45qP0k4xJrTRf0t3sZ1Pm026dT58xc3WqOn7Y/rtjqDiWt3XS/1lryMg0E9fkZJJvH3yqAblZUZ+O6v7b6prahSlOh8iLj08yzJhf6vlC2r/bCNhnwBFkQQGtZNrhn/AB/abmK5thuzfd3LtDepaNCHNSTNV+YQVa5bsptyTZGuZK0xV1O9NNJUyzZtQ5nJ+Q9CMZGK66fvPiEL5mj60/WmJXwbTY/gTVzk3Ku/vUu+obUWWq5F1JOnTTzRqvxNKP8AfypJGTyhmXoNSSmy+5yNof3enxk4nvFHX1Mdg1zt5rtuFpSXdW8kdEnU9H4nJjyUGfh6vRcH14xUtbngqTGn1O/9Y/Jy0SeH/FVY/wDfmcdoxPOQlxjezrpFnRQ8/vSK21xzDNHQyNSVbI/bq6NfaeV3rxOty6fyvxBmwACESEBPd9vvJqJw8AXBPygpBFu0bmUCMQWV3vHc5eungxVrkULHJTk3o2c26kZpa/J7uHJNFb7cZVb6meSD/wBnjjUulCutBHUs/gT1OMREcnc+KarF0lFZNND2vEaPv5pn6sxZlpjXJzMZA2PRJ/68m1urqXzHg8atmwQBAW8byECzBAsduLSiSw8IZVhVmQT/AOPY6bBjf3NHFHNv6oGZCqvez9zsnVoT/aZRbVz1eK62kuSbxn2V23MzB/8AUzHyUyz5qmpWjArJtvxIdeDl0EiUX9qlBNc+dEHkMhjlPCRyT8cS65N8nN3G9cJv7J4NLKbqmNzaBy0DdGD4Ulq7E/iAQVm4nYm3ZGUGXLjmk8zuYnLNOom5CnmvNLdfVrlJrVapqZRk3JliGyfpbJ4mLncphevt/f8AxsHM0BICSq+r0s3v7obOjGUyzU3UMxIjJESSdVLNDv8AM+Eqlo4t7yTkpxlVL9eGnooqwMYE7DW1B/AbgfobQLjMgvxbVAkWlpkX8SRiR5WCOXHOm5yc1/7BLaqdaKxHMysu8etPG1XXXhSZGcbX3EkdVY/E9K5Hm91yS11onY1L938ZUkEgq1lx0HSsShxF3r6SJplPG6o8pJh8tmTxxIONjf8AapmSslxf2Z0IcB+9BP3UqJKa9QAgJYuxbHEbvQTYG6ae6uwldtRMxpsheIo+sf8Aw6it45dVkCWvjNkKNdgGwnRhfxeZJotmp0FOFyMkbudTEy7+nNM9bBqvtEVfMxNETOOWZmeYuYk3JI1W7pWpAbkT6u9SwXXi065yyl63LcawXJjmJPH/AMAKzuaRKZKQSAvGR5W0hrOkKiggHADJlGMOZI+YHAaDhqBO6rQS7kj7WAc2v1otrkZOGfq7Q1NVQY+NPRE5Qiuamr6+1Qur+oVYFn1+vLZI5YcmTHzrpmNcnAk0QEllTbRU0DorSUvI/mJR9GKD6YsiXXJaybvonoZDt3uR/W53+BiFDFIjt5NuPOD5rIEOQIvamMwCoAlw/TDknJa4bl4mhm9Y6ZKH4nEn3818e/6iszrcP5OEDJNuQ+suQcmnG49nOH+g2lHTM0Qn9UWdHlxzRCRLdzxRJ8cE1Fa3RvvrbBJsyTPFd/R/EdEs+FQmeq1TORTnLeTrzcxM71KxPL/ofwfoLLuARv8AhQzdm/3tdkTaAZEyMwEEU8QUVpt85+Sn6wFxvUmR3jWNM1k1UyTrbNMpHNcv5F/I8aD4JgLim1ZVKyM1ujEGOU5sGtzRT1H5k42NcU31QSHFax3J+8jG4o0kR+tv9GqQgyB+5pZ/xtHUDRUyOWrfsOz7oPU8oUPTau8Eq3n/ACwBjm+qcEu8DZkgZlcItQnoqZyY/wDKs1iuamtSTVYzWmaopK6NfoeZNFhSOqM5ZZTcd1LRzzLCTqVnI1EyBb1sX+r+ZEuSUJ3cJQLpyc/6ettNNkmg61zUlSfjcOO27N1yOSmS3+qRLimtc86p0zrTuJ3XQN+qYJftYna3a0LUMExvc+oFD0yIDPqKIuTA1M1kuri8POP/ACPj6xeRiRli29RSPOvNLpGor8kv4f1JU1W4UqnHVGomsn0kmKlU4157mPtR+HJvx/8AUQyeCWueU25FV2nCT96mdO52pzWzM1kyXkl41ilghdz5y2TJs5yKh3JPZ9adMxPF+yJH52P1B0ySA0klYj0/JkDySKapCB/C3Y/lfCXXM1y75bI15trXR4phmfLzO9myb7CVDb8fXDzrwLeRjqtzzM3VczrxXQVIubzXjrcOxMOOXfcskEzt3RL06agoj/QPX5KPz1XzHV42x6oCfJMGmZq5/wAbGp1uqf28DYPpAe72s4yIf5X1QH4UyCL+2LBgtfQAEaHP8mTntAg0y/SKiaC2BqqenmpGtv2/QL+J0Zni7ZBL68SWE44Dz1So8m+S+NHNM22ugi6n/Gxj1Nv3ciarRN+RZ7mlQeWXTvdbHuccfqm+eaR6kyAT3dGpYqHZz0frxr8RhBRD74nnAzzAIgSAV7BhJEMgF7EEL8Nhqd43/wBlVy0Ds0OQ5OaMlNc1vXl8TGv2KnkPOL7xFPLTUz8dqo4roqi+xHVaEipqhuEh6+T+gdZCe4Jk7GftVV0VFPVOQ5N61tlJmuXmZiwlmHV97ySU72dszujqxlmfCcz0qosI77zCIVpMMxkchNm/IN9pBgXgtTmozoO28vYLPg5gZluq60k1usb/AFOdaTW9DP47jdP35+1ZPNBUw6WZWOqo0TRAz5SdVQSHEFdVPc3klmzVOKkGSsiyMA2ePM634o5Su7R6n6/JES46fjpp1VfXuvDBXWyLkC5KnzB9MOM5YML3WXNjrMEZDUVF2ZGaWZLBbJw7jB+Cf1oUyaBq8Y0fUa5oMaHkCdNKKWfh3GLJh7ybVr5BngqK1FVjoHqIClVvZz0NRyCbrLbukJdY3iZqKjxTkHbT0hu55d7dOn8uynMjzEkk/HUa6qQmfiP9dq/bfRujYAsU+poQgCIWB7RxJ4nWlLsVSwFM2AyLjeGcHExOMeskqtnKJc6rTNLZLRCO2qX9Ejqj8sQzkfijIP7ekglxtQtlUMU+dTWMJ3s2PJ+Vti18kNXk9QzOXj/13NSyU3rcayVXZG/r1zNxW7WLctwVjLqsgZQJON8k/KknLTyTJPVFlMeN5dSGi5DNpPp7EkYj3OqASpgpAkMWkQTcZRP2GrOsn2f7hTjISghqjm4yqMzsvW5ZmtVypUqZ9NF5LqtzNZuvl8eMu9OPWoKxoyjPSowI1kPyxNHwDeM6kIbdlO567o81Rs2oijvX0q/x2OuIip42wQxzS/Y+uW6VexaKo2xRdMofnJ1KkhMCAfDkZns9UT+EXEVKCWwBv2VljV301ZMcuSce2q3LW3h5n/KS8+Ppv5Kaul+PTM1FbH02K6vQxkrJfzYuuaTHO2OUZJuHZOIOCuk11o6T2n+Afyz3z2L1P8o9J7Y+m/jXpIrBk989zynovQeo9Vix916X0OT1Fleu9XJsa9PjqcGgy1gakq1/x3/Cf5J/OvesvtftePHixei9NfqvePc/WZJ9N7T7R6CajFfrPW557rCD1ODDjjJlzXpx48lOSY8P4n4/4egdU/3KB/a/HUwRRtHB82F7ABFVFIpq+Z+liD+FJ8cWGdaGsNZNVWJac/M63jx/vwVj1W5emqf+x9eTgfxs4XFTDHU5PGMmd8xl8Rzl1EcjLOMk89rFTlbn877+Z+xe1fxXPkwel/kvovfHAfDky+m9Jn9LgrNHc0+myZshGUXHLN0mTXRkJAY48mc2CXr7dwmakXTBvHkl61ja/tUTy6vQH3/OA9YdegdWiaCfkJBDBtBAfEfXVn5WDkmx3UC6DUkcWjW2/jvtHuP8n969u9g9sw9e4+uzX6XG3jPjh1WTJ6z1NjfxelwYpyZM/qNTGOItyEzH2+gPdv8A81//ABT6L0/t3q5n+UfzLHFY/Wzhx4/VYx3VZLmc1PpfbMNz8RgisV+5TjgzepMfzY8HpeG/g3qP/vS/hf8APv5vjHJ7hhn0f8f9sy8WVgyZfS5vcfU5Lzxj+TH81en9JirJPqMWTL6d9TisrHdXi8A9qc3uvrsnqfXVkzZ/UOX1vqc10VeVzUXULkZN3c1Vzj80LzTRJ+eSenX8b1+pRXWaPh+ihUKKka+ofSSDVhfsyhq/X/bpooNINfUDpqIYpAIFluGbdte7e7/8u+ye74MvpfVfwsxeh5jDBx6TP/4/pcl5HWJxej9PePNNdRGbDniYcbDh7lqdJ7N79Htvq7/+kd+q92/iPq7v1N+0+tzV/wCT6D1f/j1V+m9PhKsz4XEx8vp7in1GKW8VfLB6iNLftmPJ6ecVf+MRGOMniY45mEIt+09ryManqfHlgs7b+Nf8Se/5axe++4ep9N/EfYPXLOP3f3fMYIrDnIqMno/Q4jH6n1OIly3i9TIYpoo9PeS64/MPiej8H8P0yRVVSCR8tR9RJC/CLgzBE+2in+4awCXNM0gUmMQoR/gGup9uz/8AHH8hmrz+8Zf4x6idmH5vT5nHu7xWt+kifUxR6e8ky4sPrSKxQ5MWJu5h3mD/AIs9x9wPl9h99/i3vJlyz6b07XvGD2/1OSfUH+JfR+4xhnHHH3EZW8m8fhq50HvPtP8Axr6cwem9B6v+Q/yb1npsPV+vPS+m9m9HvFkzYajFjzRkyer/APJdOLIzee23HiRxGT80z7b/AA+jcej/AJR7RXqM2DHhyYPW+nzuP09OTW8XqPTY6y+omvKrAf0SN5J/POFddYfSPXpFWa+mOoEUB+I01h8yJOtghU6qQ/8AEUlOQBMil8AvfXuHqPSYf/F97/gmX1Meij3T+MeyYX02KsHq/TvuHsnob9D6mPRVhvDGfJ6r1NXnn0/w1lvD8s8Yct4J9R8U++ex+6fxP3+49Z6bN6fH6L19fHkfT58WLJM+p6+fDOSXJ8PLxly4+mJ7axz+/wA9sn+O1gfTer9h/lef/wAjFlLwY/csHwVjzxWRx449ZA/f1HU1VjGPIuTJkamsdfnS5P5j6SYr0P8AyV/EvT+8ejM03i9XmvNWPHilyRmn0PrcBefBWSnNWMp+bBIvy+n+MK5+j/d+FNZ6P/XHUANdAHor9QABNIMSFm4ujqeoPXJYIMElhfie9zbGLa5b3f1Ps/qvUel909mnPh9q9d6bBk9P6esfqZr0nrbxleo9PV1m9RN4JvNvHZTjZKyRVRM/nqf/AB3kv+M+1+5/8k5f/I9N630voPcPZ/4V6a8uQfcvffX+jv0Hunu+HFnxVlze0exe1ZfVmf1mOen3XL6DDH/k0eqx4dF67/l7/ju49D7L/EP+NfT+s9NgL9Vmwfy31vuPq/ZvbWZzxOXB6fF6i8XpPQ+jmsGSsV9X6jLFVkcn/kOKte+v/wCSP5r6/wBq94n2vDHofbvR4MHtnrvfH2/2b+P/AAe26vHHoPRepjBHpf416FT/AMT0fpoIz+oI9T63Lm9YY8Pp8OpR8RXR6er0v7FFZmrq1UiqugJUAUkr1UwcwltXSrppqCZI9J+WlyPSGCAEhxB50303/CX83/n/AKjHmwezeuw5fWR6d+b1sf8Ah4EoD/6+9R7gemjHlzRXycwWZMQIY9bjuPb/APh72T+Eek9JP8//AJz7X6D23BebH6r2r+NZ49192xRgDLnby3PpvRej3lHG5ririMm69Nkb/wAmm9698/mXqfTT6L3z/mL0OLBdGK/Rfw30fuHuuDHlzM1mnH6rDh9LD6fFeHiZxZqiaIXC4pMz5nX8H/jHqvU5eP55l9T6nNzB/wDfF7V632z0pk9R3a1lLuFi/wBtzbWSry3OTGzpP4isf2+t8WOl0QVTT0fh66jEL+5XT6R39MXC1qa6STVR0yasmqukBKm1Mn9I13P8s/5ex+q9qj/jL/ib2nH6L2X3D01TnvLjJ9Z671d5HAe7eu9xu5jP63J6bWL1Hu3qrw+m9Pi6x+hjHjx4dcV7B/8AmR/gvoMGT+U+t92/nP8AN/W4s0+t9H/HP/Gzfx3+O3PqjFWLH7i+q9Ke5evjDDm+U/8AL9JVrFYuZxt8r/I/4H/Lva/b3J6HrL7RlicfrPWewM5/S+rxE/N8XqPUemqspjceLFn4zk4o6+zh2c+fe2ezemwx/kxfGdVnhuMXRkH649lBqb66nXdWy774Pzt+F/p/wxoqHw/WNNFbq6v9usDqVkok9SteoL/iDwdc9XV6vrpNdIKCHrHy0gon0pyN7yljX0f7p/EPR+8ezev/AJl/x/67J630Ht/qsWHP7B6zrD/Kfb/SXDn9P7h632uM/qMfqfQXhrV+t9JmcWEx5HLixw2PG+3evn1msWaGPVSmasWOYrHbMf8AumrtrJ/ko+Qm7a/qK/auz/4pwes9k9L6z+ael9Rn9M+n979g/j/tvpKyuHF73fz367370l+ocOUPQem9sxmH1Xp6sxZJ9yxdfeWXS/8ALHs/p/4P/wAp/wAh9n9Fn16T233vJhwThM6YPSZZn1J6R7nE5Pjx5mdTOMCcrjxmPUGHRrp/v9b4KqsdT0CqrpdQzUF6SaaiE/SawH3Ch60K9NPUXpZkOA7EAKL5Dg21s5m8s1/j1GKKPUM6xt0VzWQOgTFN13Wg2xjYRR3Hpv8Aj7/6f+1nuWLJPt/q8qx6Sb9OZf8Ay5nr75rg1hM3qY5w53/HkrxOYy8r13/Gf/HnvH/Jf8k9F/HvajNh9BBGX3n3X4vUZfTe0e3GRrJkzZAYj3HLhjJi9BgVc2VpH4Y9Xkw/fX82/wCEPS+3e04cftM16rB6H02H0XpfQ+oyYYxz6X00Z8HpKqvTzK+sLj/05cM1lpvWCTLnjH878f8A13o/AfFdP4anqLrV3D+WgRFWzKE99dPT+HPUoNSBAQy3mZKEj8pGvyc94/j3q/YvV5PRe44fjy4sKZKtcuOmeonJFSzjsrVM3zN49rwwUT9gf8B/8cYf4f7L/wDnI98i8Hv/AL36X1E/xfBfpl/+lvsuTHXy+73Fa59b7wRWP0mYok9uqrn5D3BjF03s3/Hnof5v7vHtvvHoc3/0q9pyen9R7vkmMvqMgYvUVJ7b3mwufF6r1+X5ZjCv+T0WKslayYMuXF1f87/mGNzPpPTGKvbfQv8A4PwzOPH6bHiwHqsXp8PpPSYrnWH0scGOX/05DFgiDDlx4zm/qX9Z63x/Tp+A6AIqqVXxFVP4TRBppBsPWmTGAtV0ugOmfXmkqkYxLvy/TvvrSfyH+UZPZ/R+ry45x1fqMvyen9QcXl9PHqLm8eXJn3hMTi+K7yQ41xt/MQ/aD8+/5t/Is2X3H1+Zsr5fX5jGZrh9T3XT/kzHAGOrmseSOoMt2Yz7Yx9v/wCS/wCb7w5sM+oCLxvpKHHcBkiKo9Rknp8Y0uYpmskLVRBcB+fHf8h9b6j1dTWTrIRkYCPpLig+1cBQddb+SIOxibG0T6D/ANN/03+zSerX05qADIRAhhlm4Ucc6w+N6wQAMgs349x49gdXc/vmT1eVrICEVOr3U1WPoLr5LFulLxZdSl6nTU+en/46/hPqP+Tv51/F/wCG+k9T/wCLHvnrCfdPc59MZ59r9nwGT1vvXurix5H6e3e3en9T6mj6/IxGI2M68fyeoJHqNMSY37G39G635ZPJt5dSblqdP2J/9CZ/4/tHtX/L3/JWf23J7x6/+Me1fx7+J+y+2YM+GXFn/lnrfXep9f7hkPURzWL0/tH8e9R6PI4am303rs+HKGDNkT6P+q9bq/Af07r9X4cf9Y0jp9BEf/V6hpo6ZVoqIMvda4vhiOr1qaK5BLyiECUhIULLQtrq/wD6KL/hL0/8B9i/iz/F/wCO16P+E+i9q+T0/vPumK/Te8+/ep9d6zLjx+r9flzTgzerzZvT4pmMuHDh9Bj9Rgyel9GLi+PJ8DZcWOmeZJgcUz1S/tSi08kKaZD+qCapfz9LP/ogP+fPdP8Al7+I+k/jub2dj2/H6f270vpsWH0hi9L7bfosFaxejJj1bOK8mSpbnNM+mw1mw4JicvqqyfnJ6/0ef0nqPizfSsbM1FeN4ymeTmJ+Snnxpv6PI9aPzm/9M9T42v8Apwo/qK/9z0+pVIq9ZNDYNRn5qiWQ+Bq/6iOmOq+ij0xTTJQPqC3FjH0EJ69I9kyX6f2bFmxW69m9T6X1MzG9GDNjMdodGTc5YmMl4mYma2766/Ov9iy3/Gv+X/YvUemw3hwev91xYL9PfFT6n27+R+ljFHpui/th9Vg9xTFkqnGXb/fEh+eTeze/ZfT3l9PezD6nBXofUcxocNUViq8VVw/Fcxc111NYwmdzXye8fzb+I+t9b/x1/wAc/wDKntvXqcRl9T/Dfes+LWPJ7d79/Gs2P1HseTJ8MOb0+L1/sXrPR/BeTV+pr0HqzA/HhKnf4709Gv09QOj4r+50KSSh6q6PVQHCmmoA2NVQC1l0T66fVSQ+nVRVOAKgwGcMNXzaOJ/mHt+L+G/zv3H27B3j9o9dnPdfaJvHkxTftnuOT58OJH44i/S5HP7f6ng5w+o9Pn9NfXFH5vsN+i9ThLu6luzJBvDbPZucRFu5NzN3jGhnVxazj17J/wAgfxT0X/KvsXpcn8cy5v8A76j2XD/Nv+Pi8d2fyafc8uOv55/x56fOYMePH7n7N/Iz3P3f+PYeqjPHqM3oneT1+C4+S/YvffW4JfT55vHnxZ8eL1Hp82KjNivC8VjvE2XjcNdTeNMd486c/Vtrl+B65+O6IFR9PW6AFHVpqughTUIlqVAINlrbqgUV5FFZJpqFjZzgZ5CO2vTvV+hPURXp8wOfFqYapcWbFjiwzN5ZXJT9l1IWSzGqj5J4z3f2b0+ImyXvqQ5yVRzwGErKBGDlPAxvlE8TLPb+1+u+bLGOZJx6rGXkLnnLdEucpupxzq6Do6AsMSRUln3r0cYMVZWcOScltSsTSVVLFVlxszj+NMjpJ4NsySkHTTUaa/TULqysEnvyLbHU1B/4gqCS7MOQF3/2vIcMX6WzJ6UfkrJJf6oxFSVOvi3JzUqdg49LRzfL08ZfUe6YzHWLJkzY2I+Jmss5KiXrZlMlUL0NJOI/pmJSct1a9Hk+RkprrPeKiTIH2qX5GsfMVjDoDnxLakjQ+m/xf0uL0HxZqx48nqqx/wBog/bEtZZSo1cMNRS/JahJeKdVv1+pRRQawPVUMUgAwMclxODladFHqKEgp2vGB9EU3rkPSuf0uYx+o9Kemqmu8mHBjxoSE5Tqw76pe0CxiYqd45HtvS+rm8eJQxzM4tz2EVMW/W3qnu5RmJd1KWnV409Ly+w+k98dZcGPLnocmOww48b6W5olxo51zWrzPb8yjWvNmuv/AImzX8h6H1WXDtcuPJkrnFPp0uomayY4Kq6xnMY2MdTjWbx9NHkVf1T4WokdWr+1VAJNrAEvOw/2NbU9Kun8NI9JMkGcWY9x7kY3/wDEf5Fj9N6uLy+l/wDJmMmLGdRkN56ytR6mclZA6g7xxm14yEvx3Jlh9l/g7v8A5L9o94w2k4K9Xk9VSP8AgMk+pxZMPyM5sNtTkXDLdXksvIuQr4j5i9b/ABP+Te1XMRNZsOHFXWQi4r1DgpeJai8mSkxtKVGZdzM9SLnpf+YP5L/Cqi8fpOKmvkx3VacHqA53Pxw6iD5NnqOvjhyL9Cl8v47+nD47pdU/BV0dSrq9Orpr1wBVwLoblkpvXV0+rT0//qD0gVOKWreIGXm+vqL/AOjf/lj6f03/AB5mx+rwetqo9VnxWX8/qD0uLJhj0mP1HqiMV4/U+nxPx3h6WbyfJJuc0vzb6X3v1X8vwe1Z4Pne/Tnrsy5PW5X1Exd1ly4WqcDjx1D8kZMtYgivvii388j/AOZv+T/df+RPbfY//Ny3lfZa9TOLFRJOGPUzGfKf4p5q/klTJ9OJJSfC1tv/AKH/AN39N/8AfD7f7X68bwf+X6e6rKuTGGHhfTZSMsjiy9VudPjzG1Cun+nf0nqf0v8AoXSorpB+I+Gp6lSCkP1D0p7j0rN86yr+JHV+LQ/D1PSPUUBambkibGVdCNfot/wf/CcHsOHF6z1fqfT4vc/W4312D5owfNi9A5MNfHkhjDkM10Tc+kqaxZ+suTbF4sOD80P/AKJj+Vx7r/MPeaw5PkL9T63GV5aZj1WbeeJCceL5QClKfkelTmvz7595/wCSI9F7d/LvfcVdYPbfaMvsvteGbz4I9PnzZrn03/j+mmO5wxL3K5msDXUJvn8/K7+V4PXe7+45PWZIQyVeRxiMsXdN8tQDkyKL1WrL7nkWPzj/APS3wPX6v9R+M/qHxRJJFNNIqEBokKQhQaXzq/6j1KaehR0emxmpAyIeZF7CDd68y9F6e26ya6+S2Bvfe8qXWt6Tnf8AaXJ9mnH0LP5u8HocbL8zeKTLwWw2IeCK3GjEDX3jcn2mZK/ewzelz4esUYPhjFAZWJ1v4tajn76K3I5CJNnPgA/Kz6/N6bHNeK0QEs3knDkE5yLaE5J3VXWm5R3t7fz9ENREZYt/8YNixK7PXgA5SJ3ySRYRHl5N9b30Xorj4qifirHWMnHMAUR1E1XI6ro+8XzJLqxPBvj0FFZJz4oyRdVzUkWTvykZ0nFRDjpknxJRadtDxke/+qxfWf8AFTjmqsOKzUV1+vvNFWy/RnrmcY6Xb6/lmfJEzRRGPLEpPyEGXXGXqBr/ABp9WHnSvWN8fnPXRVUqmDUZ/wDJATYoDJ4m2tKKqKbickSEVL9ie05e3y+kxYtUYhy3U1fUzBi9RW+N3FcTET1WqGtrRi5NfiI9JxmfjZyTVGZKmtzkhuox7lZpCT/Fjx/eVvGzpa1X/wB8hVamQ8Tkpo+ua5fsE11KXVbLPtycjJu6fP8AKPiZZichVmSy4m5xZauWUJ1yTjnb/kagRian5D8oU9X0oESRLBMbE3KVpMWTL9VPqFvSJpj/AChZm3Bkd9WfV4zNLV4aQoKg7n7cpWR27f0QVfLHK5B/f5xXuns3WWcuHWKqsrnuIiZraSk60lD9WdPiaZL/ADq83vGPLJwTNu89UCGTzdOPLxfnIiTcSVN+P97qVY4fUY8vuGej03teIqc2e2GbzUGT/wAP0cUFZfVVFVXM+IC7yURR+XSTSJJTEOTaBDdz3vGoqVRJAOSEV8sERhc+cHXmvqsHq8fi/kyMUY5/uzety6Upooeps0J1LpF/Nj6P0vpMuKK9T7pj9Hm5CYvHbkkIfMWhqyk6mCQJPG+N9PPfrpkwTPoPRTYmOuK9XnieQy5Lygd1CbqUg06jSap+4fxv03qZvN6LLPpvURuMbmCsWa5m9Nx1VlGx3KFyfUfqfj9W5NJMx77c7XB21ABDM1Z8/L3Y90Wsa5oMYK1PNz9ZKEldHJeuZ1+/0AUu3vn8WsSTvIa4mpSW+mQCXKyr/UV50T1pNSTnWqYcVU3BM5lOMe9Ei1LNQZN+Yk2zoeofwZKkkRquddmmqlASqd9bIphnXgCgqbX7sFxAMcy6cMNAxjQPb9gBhWJwsg6dNbxzcB95+Flov714KlWHHHbKUHmV5Kon8FlfiWPM/CPM7jS/u6qu9qSVXmKE3OwZW1it3XTGyZeQDTIR91NfYlY1/XWh8fjap+MaG9HGjq6+IBoK8HUk5Ot8xP1/ry1+MyEDZfYBlAiN3Avpk2i15tYg5MEG7ehDnLW4rxVOl5UE/wAM7Do34AU1ud9eAopu8n1gOaGa8EwJ5xNtHTS8bkqXevEiDmsriTGSFTjNHxl1/R2U75T6OvO9S7JJZxVZ4meKnqTJ+2r+hM7yJs8aLcY6ONNC06T6SAZADk3KC4+sb2OgWtnyvl4m04Atto+sccb3XXI5GYOc92ZD7jomedsgporXR+ZmriTfNKzFWBavhK6+sLCVX+tyb5N0MEJ4mw/Vo1rQO2BRldT4ZD/s76dzhZYRixqoF+eQuahpx9LvIvSUzvpr6HJVOCF+F4nPp2k927gudCG0sDgQGyJS/wBHUTzbX+UD5CoRim5nlY3QEm0eJnp1RJ2z+DWRxnY947qaoewnbKQ3HIx9afEskMsOy5/C5wUwVO54iutSLXb/AI1Aqy3/AHJukIBsnUfJdSzGOgmseG0pddVosmtzzJAd1qY1tJre1YpEFIESMEMWkiZzzpAZpJZ5DmzAYDmDwMycZPmusl1PUxZPTj18YTpx1a/5NXyPgda53f5JwZdz3jin5LL45yBUvxhuVGTrHVEa2yJ0lLeSbljU/LSEw6qed1GVk/WtlMbGX7QyGsjVzFTHjyM9FVjN91sZax8iM7U+3nwzwOph33BuflDYjN4/8dIAW/yd4dgWd0va0vT0jNNE+KmmmcnE1UT5qZH9x5An6sPUMzuaVGNuch+yGsm367nUnFlPdeK2b53GjZ9X8ZM4sk1dCV31RTj+wEChUl1Kuk8XXgQrjlBROPOnVaKjHC21KMhxP0SdD0v6+6hpn8qpBEwC/m/ViX5e9xqzzxewEb/RRaBojJOFupk1kqoCo+uNskKlOUgY80DVgnJMzCzGF/I5L/681SferkDwJOsdfXrkV1ztd0Ql1OO+JlyY4H6lA0bK+Rpeke3oUllBd6xIg82dk7UTq3e+f1tpakqJAZhEP+0hubY4sB5EbFbZZ/yKw8sWHDjjyJQ/IGPHwzqskHeu8knONG6P+0k+GgWUU8fljmP3WQ78ZZo5+NlOpjWjrV1vnX2Xne+VVgx4y8t1Upl6uR089Ay4pSRsZ/c71P8AXzekdM/2lp+U0+NOMeU2F2E8zdTxIb3X+gKWpEOHKAgb37Ob6U+mBA9W0izM+SVNnGmTM5MmTvZkx25Iycybmampkinf2aXR/fSAZPwpyQG9zAHxEXJ0V5+0SN6+0nFcnLNTTAMuNTCUfevj+zWv/sZNGbqN3I+J0ruWZrU7r8WeoiGqqZy9svXKM1kJqByzwBNC6DfU/Jqvx1EC5v7H8PKatwpyc1KF8gxgRKKFlw9kynDqS0qqvHXUasZvz8eR8EGxr6y3RVMxtlsWeTeij5YqaGdfHQ8l3pAhnZLEsynmea6GKqupiGDm5clbreQsZmYrjH8goyzrSaklPwbudGLHf+VlMrRcRMxxd1db4a3X6HkpqRfH5UfmDuVSgoYYDin760BY2Hy02bDtsQTZLLenFuRCpNzlxwupnrJtaqu1Va0l+It1F63FVGXJkTTPJNTjWfqVk+w3c1tZrxvZO/8Ac+E/EWAw67m2KZ0RGKl/rNFJxROvE1vewGPNnT5r+/RVTVS1rHrZXc1QkroTYbA3tYr1MZ/MA+OXdcaYYAMxwg/JfM4DIGlr/k+SurUYlAqIqtISHKTP2+yfX+5OvH4x6sRqYk8ozqKZEdmRd0tGpQKn9O9H5XckRlxdHXZpq8epnJXLF0zycrLyEjJH1HU9NxcVdidMOSyqqpUCSsRVNdT0/Vjwpz9Pp+ZioNXwd2AODbvNhjRjF0kk1ICYvP4hexjWOSjJTNb3cY00Q+QmskY9wBXNc9V/ZuU1Vhk3zjY5oDLETWvuoTj+1dCz5v8AyaK34XcWMXQY5qggdYn6U0iTu1eaYUySZA6dCyaNljvEjTMgY/jZZ6syTz+pHufLopGg6l1yrQOx7s77cTy4kjUJghFi2RtJdywPaw0PyD182GoKyTqpmqlvUm9ZJKIr7aIPPPL9p0i+p4Dg1U84q4hBtRFB1489LqqSniomlPLbrHQTT9IkOzj/AOMl1v6p5hUAfH2E2vrlKqdFK0MTbNvL8kohOktKXU6r7V5bCRBezJDJAT2vvljQaZ2Hbdf9ohWYEvnR9xAeboqdzOvktrx5x2NQGJaD6oE1Uy7T8UE/5aWNWTbbzTHV6cTLM7HYak2aJmiaNHhSDJ8kjddQLi+2MU8zX/XEUVp8U11ZJc6/MzneHTXg+KyodY6oXiU33VV3rw/ZArR4WSSPVxEwYEnnVERubPIIAkC7tta+sxs3O+dVGPnil2McvVRRVAbA8/oJo1J+MgnqsnyES41mPGSo+3MSR/0ZqeqZx0u6/V0gkDNVTjfjr72n9JvQy8H9npeWKZ3xyb1tfrdeEEjJQaIgKpLnFsql1P1kNDufJooB3kAHNyEXAsGouXoi6updrSRIgZHe2ixSfFU9TMvVK11U/UOGqnyg9XAGkfI0dVhwXI1j1US4SX/GVRFA6rvcym0rlTG7kyQX+FjuqinlgKIuip81yRVX0TRP2keTVJyATv8ADm+dtSH+MKmcehqnTb1s8lSt66K26CfCPzJbeT+G2B9DYzB1LMG4Bsw49Lt/y4GVOjx5J9Phx7Z+yPmW0a0S5K5H6XKAg8eGXrf4d5kdiXOVx34dyVaJTYTAQika1JTzINlp+Rmevjmv6yn2uT9JmKdQare8nnVT41M1+TrcjjpXiLyFP2cbTeQ41cFTsmNaBTdTPn8ulBJQQjfyRY8obFjVJFoqJZFiLr0lATACPpwGWVUSb+N67nV0kVORZ5iskPNR22vE6mjTf6CI3V3XDp+SdU7o+0c/CbnUlVQa191D7eWMuRmZWZiKmMZqH/dOsiq1L48n9mVQdfaMt/Hiiuepqcc7x77ovX2+TYNgXd/7A3p8/jJAJKQC/TYluO5gwTqQJKsJItfiwXfaXoTJiyZZx1u6D4ywCWpsk+WrfItHdAG5B1QdLk5rKkj1bjxu/vP2nnnvgccca7Dop5NUUEsTNfIHXeN0cykNrR9or68v1vosHbLTQfmZTJePH/l/XxTsrqOKKrV2abTXTOSial/e0SWSLWOLF2ZJPd5mG3W8cPhjlDGW2L6cZOTI/JNUxWQoCr3TOu2fqMv7ORNpjdv5OJPjmPD1jNWWNncSQNV4o8VpDrVAO+j8UD9tNEJVVv6H22TjKXJ9MgCB1+vr5TpmGDVY4y1MfJ5jLzNE/QYmrKOiuTUmP7FKf5IfxhkhBQCo4V82lLeTpzgEtYIJQ8RAWIRi09fbw7Z1iS9nV7UyDkSX9au+em/0bV/FPUYyya31OFyVaVt5OzYPBrJPy1/QeQWHZXk5ZJZnvjFVkMA1f0pqe/q/Yq0NupNo/jsmSpxxoIoYxdRPjj60ZHyj9xFZVrl5XerCfYDAuYQOTEmFCOkgQwGDAtdAdwAiySP8cM6WGGbpg3VTdWbieJ0EsVjrZPTP1d1SDSGkzvJlNHqZeGaqVn/1cxVFb3WSqqtZBeN7Gt5JoIhN6PtRWWUraRR4hvZvb4JiTrugTwfi5x6RJTqjKV1XA0kzDQSGNf1Myy7SXRoUkWQ4yh2vxwdidIAkAWH+XlGF8xYUMzgKJp/+t8a2c1lmIRur+I1OnyMTuRJBqPDpnX4wnFe254Cmitzqyft8ZuGqndX9tfY8f2BE3OTHzjnILUwtdSxys7DevLqTGE7pp3baT+ZTccs0s844qXd8b2fJ1aT5N7vXgpEZXp+pImlwF3QzIJbsu+14GUsi4AnCgWBBcllab4Ssf+8eSaETqcNz9TIvmZjcniAgrRpSkHHOPKZJWFapmdVINTUOwmJnxzGxqadmxAGBrJbuzcZLpuyFHUsHIt+ZKkHYUkk9QjIrSjAjTEbxtdG44imnbOxS/BJsSU/AEFeO4kROcQRhj1HTvexMg3IiJOy8TV8yOpTFE/YTqsdFNCR1yTN3/UinrnjqtzXHLWhWXi5+FB88jMfToUlbeuhGmqnQEzdOwfyVlw/aaMk5SVokapnXCrsneyL1KHigySXTInItuaJgbvgdNTrScuQi2KQiF7/ZyBzP4XsNnwABffyEESkXok1elWRvYRsFPYiJAeicWM3NX/kuXJvvf0ZNTVp2Yz6Hnbb46hI/BI49NBQVtkKnd9FyTzkyeHUMjTMhMpuR0/joaOrqxvKDvnzNUhENpyRuVSRFl08+DCYqnqp3eK6ovdyNeOMZYSIASzvf2BnrRfhITMAc/wAWNUKbE3uLCCgo4mLFyrpH5KsBaLu96ong41j6vbZXghDVByCwP411xXNzj5xzFLREyhPPM5Gv20TtBHcVuudjF66QJqa0sc4slHOODsqvHnnQT9+SLBfyH4OJ+rqnFO/6xV+R6yXscd0E6kD6c+ed/liknxfHsETOPadUKdg+EBKBtaUDAg2udZjwTOb5SjXH+PF50PRqtE4y6rQxpWQ67rXKfNfI6lsvzG9zU7pCVpd41klifpVVoTf5CsY6O+uQaPNWQ8rj6WEInf8AsN9Jo1+TkZrFiu2AOINT55efrkg+5vZuDeiZ6na0gAUQpUPdDhbg3gaAEMYMPgljsk522AuSow4y3VWg0ldDREDeazfDqjbK8zok53S7yWTOglScfg+jWoqb8Uwh5qqfICwK7i27uKE5JIjWoGrjQIZFNfby+G14rnoq1Y8LGbi7mtTTNZJX69BjN2anIUckgH+/7OmTSSioKRli0TLQux+ekrARAz2MSLK4XFloTHzBFhmNLFiN2VH6qr5epZ0LM/uZvVUaDETFuZpGo50SnGVRmdzMRrmTpG9T1Trpn8tVElzT0OuxqrhJ5ExdcyAPmZl5qdj4fK7yuP768b2/V8NUSVK0AGnQp4mtCbFEb4+kfeYNxoIQEfguocipm1hOQ2wSiWTckzldBMM1Pxola6UFHW3ou7X61vsnX4q1mceUqWq5l3XOurblQ1MsefrRUu96ZaAlupjETjxzc46qtAZG3xCqy1QqchBBOMWipcs2ShE+MWPTNziUf7k6ZSU1vW+mg15UINjghFCLDPtwyEI0vQ7gAoYz8rT9ncZgaXjmNsmOmhbFJSTg+lr4t+xxx4qq42Uj+W5pRrmqZJwPkn7Vzp3e0nepKnnVExyuxXjx7pejhls+2tL+oKeRl0URID+tz5/Ays1PEqXuYLiakMfOyslq1rZM5KmaOYor9dGdSFwKbEYJsrHa4x506bMMyBJgWKQYB91gglaszkqMsZQK65nJNTqZyOSb/wDZDIIA00Nm90M07u4vkbrqd18jPRJuGmaCaTTiH/ZIOzwNV+U4xwg9uCfrXhn46idSzPbvfU75Z/r9Jorz+OnLUWaedM4/lJvqntorISp8dztrJT1Wt/oaefqerPj2FvbNgmhdv2hHAhr8wwCPob+jBjjEXE5MlSdqV9ckc7quU43sgI8u5dbCWbyERMY/k1ePHljm8UGNIrJTbcjk1NBkHcLuhlT8Xlornyk94/8A1zJJDs+914J3o3IUTy6SR/LnpJw283FSxXiqdxdyRPx1WRpZvbTRAXPMVu52+d1gEZhAEgnKtCB+rM3ZRAYqDYQgwiUSvqoFWNe8+y/8he7e6e55fZ/VZL/+9v3XBHtPoPYprG+3+yxixOD0Ee3YMhj9P6XJCMZcuPGZPUXny+ouq9RkyLuP4h6u/wCM4/8AkD2+K1Xuno/S+o9VDH/jVfo/Qep9V80N47xxlsPURRjqbxZLbsmGqXxD011jucuHJ8eQqMsXjf6gf45MkSJkx1tDx/bSO389J9X7u+vw+m9z9NcxWTAen9b8RU9LhqvU+mzY8e8nNFDVXfM9bJo6uflfjvgekPVSB8nV9PqMfioqFQYiakZztvtTWizNQ/DY3UJGJxlY15V6j3j3D+U+7weutMc3kyR6bEY4xYfTQ1bjiFr6pVRK1zIxE3tH87TDRudTFTX0ImOcc0dzjqXvToEMk9cz4AJPzWfy3+HZvYn230/t3z4fcPffSf8A0yfTzOJfbvac0479JlcuByVXzXWSnVB8eJJXHZkOv/iP8A/lfvmH013j9N7Z7cSY83vfvfqf/D9ARP3rKzkaz+p5mc9OTBhqQx5BSprcV9bo9Lo01esU9IfLSodIQKzcEWe2s+nRXVWaDTUfm9XqAOwyT7wc210nsmH1HvP8c/lX8YhyN+q9Ke5YzF6VsrJ6SMvpvUZM9f5icVTnxtVMvU4XH1FRJXAfx7+BfyLHn+PLg9P6P0WPLlwZfdPXZD0/pMH2x4nI5M/PqM0OOiucOG1m5YafkPz3C8n8e/iHtnrPaPY/dI9d6nPiMfvP8qrAYL9VjlJz+yexelyY80vosmaO6zU/J6mphpIw/DHk3vn8w9D6bI3iMmXicmKcXqNbNXMx/wCD6PGGD0WLHMyYM1zWXGz8iXcnPm9LqdfqdTrH4ej09Pq1AgmmQgAw13mwlI66axQBT6j6SAtwgZRuC+RIMTr0/wBsyfxr+P4/l9HPp/fPdPSa69892isPs/o8npnrI+g9uyp6f1MtY8LOX1q3d069N6eumeO/ln/Jr736gw+gyes/kvudFT/5PqqZ9P6fGOSMeP0kz1OPFjb1iz4v/Hw4hfhsmZqfJfU+o99/k2Sc3rc+b0ftLRUYJ2zWw848NQOXJWJ18+WfL1wL963XoseD0mFxelxTimZW70f+Tl0cN5LLm67qY5JKjrUka1Dp/wCz6dNY6nXqPV6n4kz6RaJAQGQAANQerVUxSPRTDqSMELaIiHky9Wfl9+9Xkq/U+5HtuL4U/wDA9nI9N8c0V/fJqa6Nc1TeXKdaMn2/JPb/AElXFZ6z+ruZjIZPU+u9RmyVB9fj18gd19RJNOQJhrwE/fp4s3S5JlsDha6iqAaf0col1V6VUFZfUZL5CjHIuLQ8RVf0et02Y6K0E6KCpoi9U6+iB6UKQ2hSAcYvuGWEdIAi5eXURExAQWBc5bjWzw3XyQxfqvTfHePHOT0/qc8XPNUQ4sdZLKj+xLUkrBOhdfnQYf5D6mc76X11Prj1DOLHlq449dOya9F7jJxEZsv359ZD8xTDdVNT+cq+o+GcaTjcnxzj2yM4WlTJWS0G445q9+HzU0eEqubv5addYxus1gtrWQmUmphaKqOaLAfP2KOY9GkkFJOQmTwQLvcpcLRSQwRJhWRicHnjL12vtXsvoJ99n3D1N+m9P7Dj9uz+8esx+r9Ujg9N6T1R37W4o5L9R/5nxenwYcpXM1lGH5InFr/fv+RPd/5B63L6D+O4J9F6KMW79V66o9VnrYo58+fFkx4cUzz/AOL7P6OMfpfTc4usfWKvzkfdn3f1k4cPpc3pX00lTkv1EVhzYqzZe3tqU9YYw5icveqrYS11KvSw+mwYfT4mUwRVZm8KOelp9RltqpMlKfTU1rQaeYPwPwlFRp6nUA6tdNFIppMgBh1EC9TQh2xOn6qgfTSKqaYJsCTDRAs2lutdJ6DN630k3fqvdvX+o9Rlxpdf+VfpcQVuck4cUO6flWo34q6odb4rc4fffdseO5fc8/qMLn+f/wAP3b4/Xemygpu4zzd034ig15HaVkJeOzepjNqYdaTG2MwOiyZtWsiUhNUP+StH6N/lzAVZi6yQ3GOLZMjpiSjlrzeVkZ1QzFBzpuZTKvoUGk+qgXkGkL3IP0kOdN84yQ8IMjDtJARgPXqfsP8AK49FlqvTnr/Yczlnr1HsnyHt+X1Lcd//AEw9q9Qf+Nn9MDlXFh5XHJj1aVN7b3D2P2f3nFm9wz4fTR6mSj/6ffxnA+p9AReJyOT3z2dHN6Kh/wAubJhkga0FJNT5X6f1dQqTPBcYVmW66P3lrHT9Hx4t+0m61Q1LvfSe5Zvbs56j2v1Ob0Pq+i3JhyzMOmr+K/jmouK4lnDcsMdUjGWpPN6nw1XTPr6JPTqN1VBGxJPaCSyba0FTAFQ9SuLwwSiRdmzUIM69O/iv8cyX6WM38i9y9C/wr+MZn3v1frPT+4YjJ649L6uJze3+1+3a6ze7+51m9Liy/LhnBiwdZM043HZk8W/n38j9X/Kv5N7n7z6rLjzZfX+sy5MnPp9sXk9TkueudfbHjgwGTlN7Jcn3qfQc3q/bPfYwHr5/+l3uLgyh7l7VJj9PlyZyYqvc/RwRLbdZMubJi4utcyUTL+a71X8TxVOJ9R8WJxZvT4sPvvpGvWe2eox1FuL/AM0rd4a0/wDkZPkjHlnGhrsX85uiKen16+v14rI9AQQAqPqqqiKnDUgAIaOpT6+nSOn/ANuwZCVPtfjGvrT/AIw/+iO/iH8A9g/8L0/tH/iY/wDwvSZ//D9J6L1Eev8AcPVHpaweqz+qznq4jJmjLXyYc/qMiFGIvkx4ccdJ6j/6J3+UfyHNk9u/h/t8e15PdfiJ9Z6qZ93/AJBm9f6msOP02HAcR6PBly5+o9L6esOX1BOZ5yZLyUPxD7r/ABP3b2r4suTEZfQeqvHlxe8elzNe1ZZpax4a9Tj6MeSMZWfJ6avhzErVTNhR9wf/AEJn/GNe45fT/wA7yYM56f0XuJ6P+LmXFdej9d7tJWL3b+T5qqcvy+3+wxX/AI/oMpjxs+50ZISvbbxPzH9W+D/ovwXT639RrpHX6lVRNArrfq6l6QNyD3QCFtdvw5+IrNPTmkQ1BO4CwN/vbX037Z7T/wDmv/449f6n3f101/Ij09+u999V6nHmy+q9b/KfcKyh6X0/qMcYfm9H7JhKwS6px79X6qfHqXE/n3/Mf5B6X0vzGLLicl5s3uGHJOScdkXPZOTJBjKyRlyRrHOKCsl1AspT9Kf/AEUf/JWT231s/wAY9P6yn0/tvp59N6mXDU5Mnqqj1Lm9TkJA+XLnvLM+qSM0ny1GPHDHf5o/yL3/ANX7t6mMW8jmck48WDEWGa5NBGIXJmrLVTMBpzIw/Ggh/wCmf6bV16Kvjuu6R1j/AHFYU9OlAY9Ij7J41XxXV9JooBZpQCBcIT3V7bzpf8r/AJDl9yz1GzCY7yVW9BeSIuMmajLWS/8AJ9IlOTZ8SRctPlnq5nOlTOgmWRtXLUH2+rLkj+yWIPJZQOq/PtfL/wAMfw3/AIx9Jh9f/wAt+p9b7n/J8HovSe5+8/wj0GfL7d6H+Nej9bjx16f0/wDMfeoMvrT+QZhkP477Viv1WK0x5vU46j1D6f3X/wChk/8AoiP+Cv5D/wAh+y/8SfyL/hD+Kfx32D+W+r9u/jX8a999q9F6X1Xqn3z1Wcxe2T76e5egzep9R6b3f1c4/TVn9J6k9dizeowE1lMDkfpvif6//wCx+F6/X+B/pvW+O6PQoJ6nVorp6dAppmqqg1P1oA2pln5tcX/tx1KwOr1aemepUPSx6iSSE4QGxUHJ1+dntv8Aw/8Az/3r0B7n6T+Neqn0b6X55/8AMv03oMueKOofT+n9ZkjNmq5OsNRFOSftBRup63/i7N79/E/UfzT+K+6e0+s9P7l672XD7/6T2z1+Jxenv1n8ayZfU3lzRkrFjz+n/wDpV6v3TIsufGx6fJudxK/YP/0VX8W99/4q/wCb/wCZeze2e65P/vb9Z7fHq/a//LzZqfbvb7icmb+PU3kw4b9R7b6rD6n0ubD8Tiq5PjtuJr8+I/Vf8ofyX1n8t9q949vrLde25vSemiMh/wCVWfFl9Pl9N6j0+SctZa9Vi9b6PJfpnBlzOOvlx7nm6r8Phf6l1/638B/e9HRq+G6/So61ARFVBpNPUpoPqMmkgYjRV0+n8N1BSPWK6avTuCSg5wbftree8/8ANXvefD6T0HpefRemw43D6f0npfTenvDXqfvtn7ZMhjluvihoJ8MyRs/PIvefUXn9RVetg9NmMu8mK8eTFljJW8lx6iKSpsqkb1sMbPlxzM+1/wDK/wDwR6/+Ifz7138W9onJ7xWD1nsvqM0YcOT0vuXtr/IvbfT+5el9H6uUqceb0blvD6nPcen9NizRtv4ajL+cr/yLi9y9wfYf5L7j7ZeH3H3XFl9l94m/U4fUYb99/ieX0/s3rM1HZrL7h6b/AOl3rrx5QM/qfU94s7jYy16nwPxPwlNPSPw4o9FdIqqX4h8oqBNoqFNrEhPXL1h1K/UOoD8pQj5YIpwwFH1bWqX/ABd/xH/KP+Wf5Fh9m9g/8H0npsWG/U+7e/e5fJh9n9k9LJdV6n3H1OOMt/LUYr/8b02CMvqPVXNGOGYyXi+tPSel/wCCv4V7BP8AA/e/+Vv5n79h9Tmw5PfvS+yej9p9r9gv1npsfqPS4/W+nwe5PrclxgjIHp88Z5z1hnox4ZvDE7v+Pe9/wT/jT+G+2/wLPWbN633X0nq/V/yD1Mcy4PcvXez1j9G5cXostZvcfS+m9ZkzR6T0+bmQ9NWTJUVmiD4J909h9+9X7r7g4/Q+os9R7h6jLPqLwzhKxX6hmLYqPix46V4jHTjllxlDI1w0/wDuP618R8R/d6/U+E+D6FY/9tTSKKaurUCH1KqqqTUAw6BT6QpJnXT/AGqPhOnR6aR1epWPnLMA+lgAfoVr7W9X/wAT+k949pPdf+If556r3TB7Rn9N6z0XsX8iw4fb/cMOb1LOavV+1ZvRTXpcc5fUxjxT67HGP02OyXJn+PJdnx5/Mb9zx/yf1X/3ye2Zvaf5bjzSe54fVYT0+f1vqU7v1Hq8MxhD1vqKqaPVEzHqtmTtppPZf+HfWe9/xv1Xx3k90xXjy4D2zJPrvgxen91wI/F8dZOM3ofcsPXovU4iWar48pPWP79T/wDRcek9H756T+K/8ien9Dn9J6/3PL/4VY7z5cxk9Eekx5/TejvM7yVk9tyzlwy57yZY9HXpzJVXCsfCV9f4H+o0fC9asdfo9YVDp/EGlV0kT6KzTFQNy5dzqutSK/hz1qafTVQBVVQSSETSEGIIiwjadeH+w+9fDeMyc/1+Pi4qqi7ErLsrY9Gvka7hFZ15r0TLH/m4py4JKuye7NVVrjqqTH/mGZi+8NDjjqoMzI9vzV7Hm909V6/1vo8EZfWZPTxk9bEFNZoMdhZj+TZmqQanHJXQVRqpofYv437xlyEBV96cjNZeeMfQ3hZlmttTox0GmmZJMlH57PX6fpq9VJHqBMYQPdWEY2nXP0eoKgAaYqJEnIIHjMRfmO79H/H7y5cROGerMoxeKqr1HqTIYm4kpTJtCBJyGieFI6t5vR+k9DZh9R6zD6b1JmxVj/8AJ9TgxZScvaYKxU1kxNKhj8fZo7i/jMn1f/wX/GvYvcP+Mf8Amn/kP1PqPb//AL4f4f7B7X6b2LHmxZcuf0te6Pq8vqfeMHp4KyfPgv0uD0mP19ZZxRXqPUx6ieM+PPh/Mf8AnX8kz+4e8+pv1MlZvnzYs2YeSqM+Tdrexy+GclUBpZxkk3153wfxB/qPxXxvQppNFPwlVHT6lVS+auuimpBp0gVBndjXR1/T0aKKyvmAUhwgAQLd48Tr609rxZvS6efK4vVFbw2YPSHUVFTEMVh8TrHpi+t/JESyeu+0+7OH0lYMuT03qqzMnpMlpWTBhvgwX/5B8b6cx1imNVjTHd47g6px5PlH/h7+W5PW+3e7e0epvJ6mvZDHl9F6jPWSuPReqj1EHpWopOMWXG1i39JnJ5KIifz2T/y69N8dTk7+SYCzJfLFy1GK7k+PHOP49vUUsVTJydHjf1P4P/q19OoTTVBgEpFnczbuIGtOgfWKa3BBfcJjCnHgRrv/AHv3N9XkzRxS3WTBjj/JFNW5P/rqrmiP7fIVl4gxw28DjQ+av5zirI1N4p3OSsDHw3klo6D1OTJvSlq9ybx0bqT4+cfr57hmyencGXV+qw+qMJ6sn5arczM5+5yFXGOYspJMc9Y5/wDbjv8AOb969mzesqs1OHKZiriHHjqcPp3H8mLM3hKnHUM5HTMk2ubZ3kqdv6UR8LWBWVSwIgOIiYnkZGr6gJ3wAt4hEjHi2Rr5p9R7Zm9T1h+PRrWnZ83BqmZr5FyZN2lDKnTXnrrvf+K/416vB/IMeopx3kmIws5MdZWrjzNRE/Gz4kqjmHt6naHeem/i/pvR4q9Tn5bYpWie5q5KYmZ+K4JuX5Mlyc228kchufYM2X2z11ZsOv8AyME8EsuP6YbjRN6nJkqiGcb3JY1jufj717fxXx39z4bq0dL0kmg0uM7iY2jPGuejpgVU1EgKoGArKMGT/Fr07+Y+y+1+g/iuX0lZCfV57zZc+Kpx5fjyV6bJ/ijHLF5cU1V42rxlRlMsrLixz+fGnrfZZx5sjM47PmrKzGQqzBN1FRc3o6KnjRJzVjStFfn0P/Jfevcvcs+T1Xq/U1V5PVYseJomYjDMtYvlyYkrHNFK4jxkBy87dx497ziyPqKoytGX1LN71ODHiySUYqy4amWco3XLG502FRe54f6LR1OhTWOpW6qj6qjhx8q4ATFIjBA1fxBpqRAaCQuUpOwxYXO2uI9THovSBeP0mJcesDQfu12dWZGjnQZaf2gcZJ63zvqc/pcc5rr0kZXJlIoJpibuRrTqI+HG1XGQGpyfYhotes9Zh9PivribvmrrDUtyPyN44nxEwzJVy1XYTfKHj85n1Pp+scTlqKMmachRjKi2hqflsU+LHfITUSL2gNFfn0vTRDascuwIKtDYa31w9QFK0bbbi+4BTyNjqK/+kzTd+hpEZJi66i60s1qH43ygzfMkupdJNCsPsNr/APWmS26bpMkcEXK1jNY2G/H1TrJp2Xvldnm9NmvLO8Rk1UYJx/EyOQ0fNNNc92F6qnoGmpd0usr23P1kmcV7MuQFbKTVNeA1kNcgwTK7/rpqd6UMncyRcjuDhPeyGsKqSI9IPApIVv8Ay2m/gshdx7HVTM+kzYuK4vyE0G50Gi681qg+lEaJnnop5cHt45NYckzjyWEVkmiV3zQeQkrkhmaqHzqiXreen9v9RkzxgwYnNny43HGDHhyOTNVMy3jIdKxkH5fATT9WJVd6w9p/jiX67/x/dve4lyR7Thsy+j9NlCRfdM+B49V6mLkmvR4VxfYnNmoXFNmukH5XUR/iGTO5EKd8caQpSJHp7gZSsXIdv9aXB6L0XofTT7x7vdem9sceQw41o9V7pkTv4PSR/aPTdDjy+skcWFmpw95KYjSr6v3/AD4PUZMeP03ovTxv0HtxuMOKIoZqos5y/IVzky1q82Uerddfmxn0vuP8i9bPuPvGaroneD01RrD6eYdxijDOPjDgCiMeONSCRLKlfnqHtXsuEnDGZgyRhnJKTEYeMU2Mv7rIv9JKkiyGLqan5DHqdUdNVVqqskAUC1Ijmcuq6yk6po9cBU0oGb1RSinYI/w683j0Ofz9KhmiUuqmWYQrHOOm9krAQp4msVG47qzeN0UxkJGseQxzy5blUJGb1W2uermnIfaeeav131nofR+mx4o+PFV2xtxz8UtqXiz5M83RDctn/ZiY71TM1On9R6P0Vtc+nDLka5ipkCXGjxcIYybmojrqiTndNeMP/cmsg+n2uAgpH2Phg60/tii31EQjNiiiDE86+bS5SiZBnGn9SSgB+T70u+ufBpqp5QJH8TkiGQ+SSq5zC1NJGl4qj9UeNzIC1W60j+KpzzvHlniZCjVqMx4Y+St1U0mQCdDISauX8bFFOwSQqmlFBg+nmfM7fDMAC+P/AKn9GFTjMCy+hny4n/FDXIMgkknFrgMLsLmLtC7DVqlfFZZkl1EzYc64KKyFV0/VNUGnX1VTnydKz0VbjD7eCtTFE0hB0Kv9hnkDljIyRkePsv2BFYjcjM3VTphgODx07oBphQZCsgy1/lqfk5Gvv419kKj/AEUHinxpH8bIULvDmMwyAiBbVPbPsWZDOb8LAw3KlOMa+Pkmq/6bI2UXf2XIz9VKN8m03L+FSVjiJDqmIlnHWk8orpf7T9qNjHnpa7/B0Vj+T649JVQ0NUgdVRc9MJRo6OvEuvqicGcrJVJqSahllOKkneTV0zKvJLLuf9hxYP1D1T/kL/xJi3kJRodg7+Ii3JxCUK+rVZKxuLHoTmQrzzCMEXVNLtra1r/4r+238W6ftrb5td4+LnxWmyd91SSk/wBpeXT9ldTGN6DVfVrYVXLpqmwJjljqV3L0rNIz+C/a9ndlz1tZmpyTtrE8qhX11Mnnz5WzaNRKe6TgWnfbAE7WewvAwBkABc852039Y8bucmPqQe/MSksjkNgyStDLvrsN1v8ACjMu25+6uFrjb5J3ddVqjarQbWgZ2P4OCL4f2boApe4xIP3lh8Ro51P1Frc9UEZ8bjmMk6v6yUFb3J5q+uh+SQWqTmdy6NoMepeqcQTZrz7C+RqQeLZ3MPBMjKfawN/oUTJPFRS7o7memvjFS/O9ifZKBk3C8eOrbamYnHDPLsSoCfkyY2V5YRH/AO60BJ4hyc1ER9Y5gr68Q3NSSK0zcUT9nz5K1qShIZnIb63cXvzqZWpP3P8A9jH9yTvffnciMVNTkC6DiyEyQBAIzA1UE2yIuXDnYwAgEMXOmXMrix1c7Csjr+lwRDq6Nl3Qa06nICIbUlqa6G2OcjtIiYvkkSotbu7aa5kSw0fc+6uzEWur6KJSe6CgZmXmJIGXr7fSeq+w6/IjI5Yi+PO8caPLeTzXWbS0NbBStBps3P1TZI32GPlEI/Q5sdA/nAIFhKkLwS9Ox5sBuKSXv69/rwhI9cnI6TmTSM0y+fw82TG59kNk7hUrGfI1syeaOd6AeR6mdCRz+Jqay3F3B1GSccrKzpTfa7tGvJf/ANTMleQV96nacrvnXJ9fHjI30z++v2tJqq3vf5Qax6XdJgbuL2586R2cXEnYZRgXBkfXUTKT+u4+WKUr/wBUMl6chvmoF+lBMp8j5UV1z8pUYfNvFU1vnJeutckxyA6ydUlIavzH4FXrNQVkC/re3kWud43SSD/k1RsHQDaz+EY3n65PE1uJ7SnGPmfseQdBEg72dEr+DuJuHAOQOc3A7BCdNQHyHyYIiJJn6b6OXBHXGIHsxyvS9utDUkz8ZUqyb076NaJidNW1cxPyVVL+klh5mUmTnrXgTQTI5Nn4PyBY1EM6cbPDM/OeJp+5vW2utDsf2y9D/mqk46qcpyzRriOQ++67k5hf1tuet0T+BtayK2tfcyMvMHTVsNN3WPwiFFtWZzJjx48esndwzkmuckS6iZm+51c6Y5Q83GqFWq9Wxn52O4MTk4kIyKjunmWUl+Sg8u3Rpn8jIDMu/E8jMU+Z6S8cEyJq/wCvVK8vnxr8fJEz44Qwj5kr/q0UP1XL1rwruvGk0fhJTixcWQGHMNnYnEJvNlZSLSRnIYI3EQvLMgPaPE5ep+1UQ+TeuYj9s7NRzqRoOZxXU6qZK6HW6u+Zo5J6nzMiHUs8buQHekKujm2ejcRkeHfVV33i3REzPC/uZSXUO6Wfiw1lnIVUDFd/b/3Jk3OOo3FTY15kr9y68rQz6mSrEAAxkeDIP8Wm8jCYjg4vk7ndkglkTGYzrG/IElc9M11PNZMkkzNS/J4NsybjYsksdOtm53dKMdA13NL+7o+rrkQF/qayJyMkXKpmmDJ40nOoaMnZwO0uQ/8AqdFlv5NfQgK//dNEnlr95avdTqvtO9FMk1zrx+SAfVsEMXIFPMiCNjHGpQsJeDb/ABU9jxCnIs8y6n+r8cvlEfj/AKA35qmgS5DrRMsuvxDkmc2PXlvF9Zmamapfj7m+zVG0F/yP21vclDvHLMFFU0H9g5EmZxVkXaI/11O9VO/6/mMxk6w5N9Tq8FqgY5lJ01uhNp9Tm+Wa1Ull3gCQYvP4YXswAVL1S9IURHpi8XxYALMxqSmv7Ru1MW2eZp1ondpvVHRUz9nY85Jv8TMneahmAjz+ulr42ogomU2qIanbJpo/LK2f1CJI3qqXvVpMhkn+ynjWlmfjaHtKU66qq+y2fHSo8/WYx1kWTTo2wc0ynPAK6oNIS+zhXAYnCiedMgwgkJXuzwAOIshBufNrG5IJPjxkkfHRTkj7TXNUOpr+1v2lPPg3+Vsd4rY6ckX9KrqIpq0H4/LqcbNLBWg++9mqDzZKxBpEya3kOt46s8zVKKfvW+q0mRLCz8XM3tcV1Jur4tkajxTM7Lmk6nTJJJX1aKdIkgpQEwUEY5f1QOpBA7AGLqwAjbu++n43MTk6uYX5v6zLdOpnd2zIy+QsOn7eCVZZzzz1et4frRQytOp3kr7NgnNToUA86EMbrGm2Yoy5Kr7/APbo89Svx731sE8nk8sR8OaZevsf26SbmZ57x6oTitmhqXe/67H8oYABfJLsFG+6C35CZHFmtg4zwm40dmK6xzWS8lGOHY4jHTBuZ6nVZGwFd02zyos/mfasuLKoPPDOTuiZWPs9Xuh8zGwf0L4pormZiCfGphlFMbEuiZHrzc0KRroQ/elTOfnJKm/pUlc9asTmXJfipdTvw1WuQa+n4EgKwmnJT2m+37LSTBIh3mII9PM/nAAA0xlxyfHmL0mR64u4xHOqmq5Bj7TwSQ0jvSJAkEl5glTLOq0JV/TFSVHI72wToe5X7EgOT5MeKv6pRjqTctVSVRkmenVamd1Rr7SyRJ+FUQ1E1HWgyw9DMzKs4mqnSJU/WGm73zQk6ACS6fc2SDIVzndRgadwCjaEBhLznyb5Px06ZlrVm2MgfeGZ6UVhdyH9tpPh8Kx2ZDezeJC+6JouKr9RZRMmSgmtbx5Nbl5Sl0Sct7zZGZiAp4xNcuKWtyQGrFW3emePO24yseKP+lfTf+MEb+3yVUjNT/00j2T56Pyamaptnmy4HAAfZvTAkShAQXG8YHmTzmTFOXKO5KAzY/8AofGNbwyWUVpo1yBTdP7mOMice3eQmTJ3tR7k5oxwVJzI2+J8eGZJs8n1URSu9rxR96xjIyzaMRO5Tnl5XZKr+V/jqwbvY83LueTD+iGlOqZJrkUoJGu9c2UlTTI8OAnZIAFHBKiNHAk5SKzmy2nKY0/HPg3DVDWQqrqKZlJcdNzJTuXROtiTf2lRiZZpsman6zQ/4ZnJXMTmDe7Hk3aV5fBsQHHUf5DdYkbqmqCaqZiajdNVEf26mp2z4XxKnWWJCqoEkxzqTz+maKLfNIz1+656mTIz+MQFax5No7Q5g86X4kh4/wAjZjtweO+smq11w3/kQ3Ap0lTZl1oB8FG5ma61pRyw2PHVNQ7Km+Oi947nkn44d7+rz/8AD/acxGREKL+M6hmi0jWNmerfMh/UJd30Oqd/isl21blsYN45xeQclESZNc4yZqhqbpSWfB1qPykFa9mQNjkwL5K86dxgtKwASUFAQwLrOdWajGkhBVEze+loDqnu5E4v960aeXZPOoyX9DcbDjEPDuepNVddf/YyXxQVJtZ8fiIq8ZFYr39pC1tJWpKlrUSTHOmNM9V+08Dr6l7mR+VmqKmfFumLb3wz1Ncm3U5NAqb0BCsQ4NgfUwCMe6YMbuqX9Z4sjsCUD9wciy2jlPk+hcPX0211WM+ok6fMQdVZRvf4mrvvoU3lJ6aqUincg0czieUildS6De0KXLk8EbiaqqulkkHG1IuqCNv1xTOzUqUlfmVeWqtcc1+sW6xoEpJOVrodUY63ev6eAUX8ECGAmQHbYkiTUBhn7GGu2LLtMMMZIujAI1MmOe1xElZGB/T1k+rPdJqFKRgWahXdHK4x1MT8kb31gmutHIGq3S7gTfU7fOjzDsaiiEEe5MpWjJYkvQoaOvJIzoaNmikzEZ9BFoROtdPTz9uwqXUm+WiTz4ePNfgvmV2CRzaCpeOLZJ0O0fYOmJj8LsTIw9ijFVj95FtqrVms0alIlyFb11zspK8zO0a/CJ63jq+GejHbobjRMSltU7a5StTX9bSiaqYGYJl6jZk57d48dG+XIb15CeSfPjXha/ADeW35Oq7vJ8ldRXEsFY+8g7vYAf7rr9ofjAgDJRMdpj8ie27pFjdm3tIEWKBv7LTuqx4zFbOa9a+RSuep4LyXsOYo/dSUiOixWJXnV8tecBY78MzwtwnMCH2J0GijqSmMhJli4QvJBvd0hV0VO8mubPqkzRT9FHk/BxkNNOJtMlVWRDoqWdytAVj3T/WV63E6sAfpMgABISopWSpN0ca0VVJtFj2BpDcs4+hKkHmmVC8oM44tYSSiZ8HR97uq53t1lnZSaH8iqCS7mgrHEFTNP73E3c0pj2CiLRIjpj8TXy0ZWuRpcUjuqiRnmWqx7MJoNc701+nwPx1ZEG8eR+MOq6yJEnU13/aGaNfrc7Ovv1X5YEkmF6bGLWM7o4wtOWAX6hEK3ylXO4MZgNSTV0xqQDH52HGW4WWshkZqyj5Jmwnb41/v8Bflj6aiQFnn42kh2wXsUMhPXRs3Jqd0Tkp3jvQmMHfPTUAWZf3S2eR60NTp521I4KqcGMcnnJ1Ss00dfXHNuhJ5mtbKf+ssi8lRDTwzazCAkb7F4yyo2pUiCuFYOAGEnn0gHULjCZjq7Pj8QPUgzq8mSWpBnZZuFmfHIHLqCVge+qLlhlrnMM6u2Ymv1/on7zqXzKzhyTAVEsJziZ4mer0V/tXSg0OqOXyyBQ3DkaXIPkzR9Bj44p/w62PmXzMfWqK2H9iQIbl/QccJm++kgmSyL8JGYFo98NHOlP8AHNGv8FXU1vrydvaSyozWRPG2ePHnJxy1XPiZN7eXfxkvI3rZKb6JN+YAT8KLKVI1k1yxcu1pneTdW2MLoU6NVFhrr8UZS6Spepoh8A3SzPG7St5K3P6Jv+rzUp+EAB547FSp7G08Gc7feCI7qIZqCvDZcHhx3H/4atZvLO3qNUURQJSeOXxvVP4OLM3qidJHxpwTLygZOcqr9kEeabDHWlKpd3VjuLw18sSgpjuuWX719pEOa3JPM/bz5/FuCmrGTTXyVsfvA/Yclbqq15n6u9pvxsBaxMEKJXp2Gfz86otOmxGDKCBJexyitgAzYipPPTt5Sl1QXchPXOjGM6Anmnfjzv8AMK/zuQFKwxhamLOLrzJuaimHlaZpr6v22BQlKVennHFRU9y7qCF1OTVRj3yNS7ADym5yKqd6mamlqJ+rUFMxB1FTxxRAxIg1XJvRWdaqSASbJDECO1LbALjA0gIGWlj/AI3GFZtHvq9RPyQlSJhim6oXLUVtx0VKS9eKjxvlP7SMF6eLG4KamlyDU7ZEjXx1aSZdhAgY9UMG8iKcl3uPkGsUahJgNWL/AGbRubnbk2M0vg6Kls4SjbF0z9mNq1E6Hl19Z4J0zqid7/S64urcbOJTsgJ4dk2GE9IyRfBwDJExcm5JcoBFDVvq6mceLnqsX3/ckTKVWS2Ggs++uj+8nXM6fzaemrnkxklmId/HWN1Bqss0tDXe2UOlnTJ/X804RhcdTuW5nHWmWduQouqKjodUEuqIlo3M6dt6bPW62FXVrGWYW5i68VOSdHxbANTRRfU71X5wdQXFypEbAT+n20OZDO3B9Iyt3biLa2l/DGAjf9rjJjpqaeqCYx5PAQTW61MrPDyeN10Hsbmfc/b/AEvpsmj3L1novR5cBvJhqfV+pnG7xmOp6jcKUNH2o/xmSXnu8eQMcUF3QUpxJZTy3Vmilutsf2qKx9f1r86T2DL/AOH737LnaiMXpPc/QZMtVDcJi9VJ2laKp/1f1K1kCaqdHlfFUmqgql+oZ9gR2tftzVC9adpLUbpIg+31Y6X+R+9Zf5F/KP5H7uf4cD6zP7P7biG7xYPafa4/8T0npsJjmfigjEPMtY9XZ8XWidRPuH8j+XF6fD6XP7hxjrH6b03pM7n5fTl3eQ9NbklcWH5PULwTjAt81k3p/Q52cPqYGKynrvXtnMlec2SzL/afugVIaUalOalO0/44Mvqv5l6I+UmfSek9/wDXeozZZzVJ6X0PsXuWbK3j/VzTLGQoYyXTGSdSv55NdFFPRINAqHToHppIB/CA27zeM7xrVmD6vSaqgXuSiV9oA864Q91929+azY856PGzcd3Xy57sd244lIxBvncMmOlhfvS2vQ+1+hw5G8x/5XqDesnrK11kGOjFi5Z+SMjNlfex+2369a72fGnoYybEyZc2bkhik7sdszBMJ+rN42aXX9Zdi3jxmkJfrnmorHTF7f8AF0cMz0ByDUJVRWw1dNIpAopAphIIbHA3jlbrUAGtEmdibb2jbA4tq/mnDj5JlovWnufpdlzWNSpZxAgBJQaQJ3zUzZa7w1xd44cWPuW4D9cU2dNcs5JpoAD9LNP4rBlrNktvI1SW1+rGWknHNXrR+7EArbP96oIyZ/JXMyH+Gq+N/vpmchpAAjRYiVup/W2RSzAZCUGWpBxAtDjGiXfARNn9rAifIGrlZPU3Kaeps0TZH1j7XkituS/t9yTne5jg7Gor1JURNHFxkkqoJ1mZHi2brpbUJU/yUfH/AG5qtVXqIq+ZwVh3c47vwLfNNUzmo4gaZrIU1o+I0w7jJTWMrIbcFyD1fDOMW6X/ACVpnmYyFE19Tn+jV09FOBg/Le6OfytvpZfqFgsAFgxvZKYO2rmb3DLJVfFUS1WPJWspHTtpMYUEH+Q76QVkn6UfjP8AysmX09YoyGK7xpO6Ctwy2k0XulU6Cep3vz5/NVm9RHNWN/WIhx3NVTUzT8h0UTJRsy1JcyKy/Xde894ZxSkF5JiLZ3SmTVGVyfJjkyVRQhJo+0T4ZX/7eLcIpj728YRS0ySFMEEF2cfYEfwIdFHqsUfJjvJzCXdIME0HHFxdhk11NZDH9jVT9dgpz+swZYly/SjgHHEp/pGubXG3225CpGYFnonfOvqDJf1xsOPJ5tqZjoQZaqkPku0bnRkomTl1S2M+7orD1NTkreQmqCfE/FVcJkGqccofsqZbbPx/+3gw8M3NocWjiMlI9cVU0gnJBGGPLtYQBG+ukMsol5KGz5d47xZJZZK+Gq5GZZC1CiJ+TQbn8tf+WYq9PMotVJBF5EkKx1j3WpI4aTrbIN6h5tOcr3Co18bJ3qH6VMt5PJkqzJqd00Vl6KyIzpiTcznB+SrjKuF6n6fXrYfDsxzJDz50+V/+QMOp8OSACBIYDgL035s5/PS9d2Q78IekGmP2du3X+n9Tm+aMgFTkxU22QmL/ACErjssKojRJZ3duuWfJs8Xr/jaYdz8zM5Ki5Jy1Zxk21MMwwo+DpyEwYxPzhsefHeXgpycX1eW9Yh+M2YHe+pdXuZI7ua70wH5uY9R0w/WMVRjxnGNVtlmLCaonnZzdBln7G6uWq4ut8P6WSBCBUEwO7tFlbjV01CFBCYzHpN/OCh+HXdel9RiWZyRVz8laukrnMVVTO6ggx00VXP2Af1+nr/a/cfUeiyVm9LkiJySZP/GvJirB6j0111WDLi5rHlMvgZsf8dczU/YfPfQ/1jG6ZnCr1/kZ3TVVNUxxklUJOdV0FJQ/m29L63PdXhIoIaj5ToKyEDx/lJ+l6vzMzWShEx3vfldfoU1AsYXdgGxw2e/MG6Kj2qbDAeEvrL72GvqD+Ieky/8AJXvns/8ACv4x6nJ7B/I/5H63H7VHpPT+myer/j3q8PqT5fcfX+o9Llx5H0semw4svqvUGLBeDD6f0uU3MrU/rX/J/ZvY/wDhf/iqfa/Zfjn2/wDj38dPbPSY4wz885D1FGarzYZwY8Pr/V+rv/zPVNSPdZrItqpn8hv/AKGr+SYv4v8A8rexe7NTgzY/Q+9em9HThfUMetz+3Zz5PTSRL3WP58GPL5+l3E7NH59S/wD0T3/0QuP37+Ke3+z+m9X6bDjfes3rM3ovSz3HqfS+kwmH1F56wZMmTHFZHI36ZmcvRV3k/wAmPf5h/wCov6Z8X8b/AFf4H4HpU1/+zpNHW6lyDUSGymQBSE3eII17XwnVpo6PU6lRBrtTIG28tqRda+H/APmH+U+p9w999zz+orqs2fLvEZH1BN5subLjzmdyNWkWvyX1kEkO5gDtP/oKv4F7P/OP+W/U/wAu/lGf0WP+Kf8AE3s/q/5/7tl9dgc3p/V+7+iqsP8AGPask5ZvB6n5vfMmD1mb0ds3630XtnuUYus1h+fOfu2T3r+d++4vb/436HL6q6z4vTfHOGv/ABcMt6n1PqM+3HjxVd4287RRjyUeGtn3j/xZ7H/Fv+If+OvX/wAc9x9+j1nrv5S+i96/mOHA4cOD1H/i+n9V6bD6D0d5cc5q9B7fj9Vkr0tTkc/qPU+q9Xn9PzFzMfV/1H4gf07+kD4DoEj4rrU0dL0dMOunpk0iuqBBNEA8sQ9cXSH934j+7V+CkuSEUrXfjwtfOf8AzZ6n3/8Am3pD3D270HuXvfrP5B/JfcvdPfs/pvSesv1frfcfWZ7/APGx54xzlc84sO76oKlyWY5IfHoP/wBC/wD8G4/4r7p6P/lv/kb0NYfWfx7/APS38I/i/qsp6XPPvXos+I9D/Jfe1uz/AMP27PrJ6D2iC/U+q9dGHJkwXj9I+l9R6j7b/wAi/wAU9Nkw+k9p9LiyY/8Awc76b0mL00z/AON6qYvDi9T8nps0Y59VEwXlzZZh9NGySwtrnP8Akr/kvJ/B/YcPrGa9L776v0MYvSYsfqsVxi9DnwTf/wBMM85pyGX3D3PL8kelbi7wYjLfBEsT5p+M+P6/wdP9I+G6B6I6wFFRJ/6lVBTC/wAafS2U1EX1qaOjXX/dqqB9AdIaEWNk5d9tdx/LP4P7Z/LcvrK97/lPpvW+u99919TiyZfc/XzXp80+orO1GX3CvTd+m9Y1myl+njJrC8ZNWFNfJM//AEOvqfY/+Uv4niw6yfxD3D+Yex+h/wDpjj9Rm9Zi9MX736UyY8vqfS4KxvpTGU4819TEJ8mI1kxngfvP/I/81/kvrkye8e4Yrz+p7weh9Hnz4vTzkvnjHjwTX2qtyVVjVvTkpvJTPq/8W/mH82/jH/j+q9V/IfX+4eqjJ6b1OXB6snOYsuHJivG+mvNP+P1WNwxi+eCsg0ZUDuK9Hp/0r+of0noGij4zp1Cvp1Uf2DSRTS6V8ikenBQFRQ1z19fodat1U1D0VMVgi3ywcq23q7h6+vf4z/MPYp/5S/8AohP5bXuno7Pdv+TMHtPpvUeth9T63B7Z7D6n1/p8P/ifbXJgx4fT96uc1xgisL6Wsg/nZ/yx7jPof5h7v7R7f63Hn9owfyD1XuWIjGZME5vXZeslu+YamMbPqOPjkzSVjxRM8Hf/APJXrPdPY/ffXfzD+M+q9R6j+LfzL12T3v091Pp8Pq/affvV48XqvdfZvcMeLThy+m9T6jLXpKrHPp/W+kvB6nBkvJj9Tj9N80+6ep9T6z1Gb1Pq6v1GbLlpur+1F1dU7QS37frz4ZTT5e/+i/00dIn4r+4aqer0el0j05VH9ummmU0Qi4Mk31h8Z1h6KemARUKySbsVFhXvC886+tPS/wDKv/HXs2Sefar96z4kwZ/X5T0I2W7+es2aM5Of7V8LLjYhkrFkdX+ereh9/wD+Nf5r7diw4Yzfxu2PT4fS16vDlr2jN/5E0Xl9R670uZ9PhDMw1c4TEktXM5Gefj7/AIj/AIv7b/JP5V6PB7nxZkCvSekzGTLg9RnnPjnP8mNqLvFjxVeT48XV0YmNjene/wAk919y/iH8p9R6T2jP16XH6qcWX0hVf/Sv1EYs2Qn0t+mzUxOPJMRwn6vqdzTb+dnV+C6P96rpdHqdXp9Win+56hX8qkpGMf8AGPOq6fW6ooFddNIoJFKg1AYkAKIPYRr37+RfxM9p9RBGP084oMWfD6rF7g36H1LheivQ+pxz8fqMWTEFd4cjWMCZO0k81/5q/lnpvf8A0v8AEP4F/HMke5ej9nc3q8/qyKyPq/f/AHe8deswxmrkyen9IxWHB2yR9ZZJHv6k9r/h3uOb0fsXsPpfZf8A6fe3fyk9sv1H8a939Rj9L7b6T3f3HBU+r/8Avf8AdseSs/sPvE1Li1d/+Pklg9XFH+P88s/kf/BfsXt38k9x9D6X+TX/AA/3r0OTDhzfxj/kT0Wb2n3H0ufNLnjj3j0/pvU+0Z/TGZ5w+rz4vbZyY8mPLGL47mjz/hP6j8IfiKB1+o+r0PV/bNIYJXpNVVNIJuwf8ctnW/U6dZ6dQopQrI9eIKhgAGRks3evn/8Ajn8C/mP8E9V/5vunsPufp3Nmhn1+P0FZsNt/FlK9J6qIn09xWlvS9zXgoOPz0/23+Ee+fzL12a/a/wCMe6ZPXuWMfqvX+2ehv0/t8xmaoze65PURi9H6cyFT8vqbzTi8U1Tot909l9t/5q/i3p/T4vY/5f7LkwfHhyRl9J/L/wCO5/Q4mXHOLJGB9UErzA0yZNc3qFyDy38n9/8A5X62PV+h/nP/ACp6X0PttZM2P1OH0nueT3jIXWSKz3j9D7Q4vTZoJNROXKTORKqucsUdNfxvxPX6v/T/ALD/AMa6Kq6j6WAH06adrh/W2Q+H6fTFH/1ALz6QHAEuN4ztjiva/ePc/wCH5vVfxT2sze6e5e++mP477r6D0frYv0frn1WW8eHHH/g0f+S+hoj4/wDGxjci3rx+fKP/ACT7M/x/+Ye7+xYqwZM/pfWZvTh6XLXri87kLcWOpD5LhrjnHs/x/GT9eT6N9u/kufF6n1PtH/CHs3rfWfyX0npPW5fev+QPecmDD6r2z2vN6ep9Tk9L6cyZfRewYKnNfWejN7jk3URngyVN/Mn8Q9J6n3H/AJE9Dg959bk9Ri9J7jnye5eoxY//ACauovJGbNgyZE+b1TmmMmO8lVdX5k3zH56XwVRo6nX6hoppI6dJ6oQHUrqXy110gukIAUguqq5ga5viSK/7XSDPqqFNNRikJA/MU4giwXOvdf8Ai/2PJ/HPZnN6r/H7h7rli/Vj6fJ36aHHkj03plJn7Y5ayZuquS8i6Qr89hPV/JOSJwwxhwppk+3JbfqonJnmu6rxgyAfJv4r5jivznf5Z/APfvZvb83u38a/kOX3j2pzZfi9d6bLEes9LljHOef/AKZe2Zuqwgbly45+KmjHuydPjvt//Ifuvp/Xf/Sz+RarO5Iw4fW428WPINEGP1Ey44MefTk+XCHdBVQ113zU9IfH1Vdbp1isGo+oMisIilEb2FsW11R8PTT0yEALj0omJpLPdrzGvfMOfLmzxT6nBl5y/NEX8VmT02LHXEXUGO7qolHBqIeqo1VXT2XofSTGCWLx48vq8l5YLsnLHpOMpbkMIGLHh6vL8OSKRunI8Vig8Jwe9erxZA+13fyZccmSaDHq9xV43XBvZhmZny6yyuo730H8vyYMBB13cx6WcnV1WCWcfnFkrgnFucktrkqqyNVDOPIZOf4n4HrU0j0AGzV8JgMsnz9tWKwSM4xlSCMmVII16B6n0cGGbxmMyXij04zjb9LNV2vqsmUrJjx3EyObJWK+XJsmg06L1XtVenmPhcPqspE1nuIwdrk7tz/KXM1kuYMcvx9DMdxcg1Wj33097nP7n6jHWao+Jj4NT6T7GD0+RxtcS238uILgJz58GOsuPFjpmf1b/wCJeebrIOSMsR8tZcWTBlySV6a5x49lMxBOP6Y8cd4xHtPN6dPW6dSqa5Em3p3UjbxbTrV1HN8FgTKVwed9avP7cRWSMRNlt5nGzHZAsVOzIS5saS4p5NXq6Q6k4f3L27BGTLGWsmOD1VLkftkyU1LOKsNdBj0vWTEU+Lx4J+SdHdet959JOfP6f1FSRljmeOuMOaxKceT5ImsATmYFMiTeTHJkkPznPW5n1AYvavR+p9xy3IQemwZs0FNTWHPlyBM/LBVTVTcY4Uqmofr6Xw1XWpI+UibkALCwPfGFGsKmQUCmBYOEBELnYGwL1556v07Tc5MdSHqwMnIPVVUrk+SsjPp7hhWgSZqkDw6D1voPSY5u6w7W6mjZvjmnFZlxlGPFKW7qXiDuDXL+d167Celr5fd/W+xexYqxVFPuXuWLP6vs4pf/AAPQvq/WfLM5K+NrHjSfqtVF1PB5/wCRfx3E1/4foPdP5Zm+TZucns3tIUlrrG5vVZYckUTbm9L+kZk3J7XRrrViT/l6WrghGxOLwHrOpFGpBq5DDTtN87Il6oPozJl+HDjv1OXLDc+nx/LkzxdUGMPj6GIio/T9JCxNqVvV4PafZzHl/kXucelmimvavb6w+4e9VXOO1sm/i9D8mmMjmy1klE/8Slufw/U+p/mHuIenw/8Ah/xj2+jNjv0/tcOPKxlplweo9Ud+qyRER2GXMxzFKHdJpsX8T9L6S5yI+ryWPyXlkzVN5erpbmtT9Jfj5/yS18gVIF9AqJQqqQEEAg1YgnfMJazI/wCIsbmBYY/EZtbgTrS+t/k/uHr8L6P+P+k/+knoJai8uO7r3H1WGJIt9V6zJHd7xsF4cJj9HVm6jGQb1nofYYx3Of1lmespNF/WseLNk+0F0gGpHqEvJVTWSfp4/PRZ9rx49hz6TH8MZALhc2OdsY0yEkXU0HxiTQO0WpK+b4/SxWNJKy23TkxSmDPasDc0QY4mPknndR5YDql2FdCXTgwTdkCSRLMzKzTqP7dRLqLEG0BKwi3I3zrTYcnp8HrMOLHhooAvMdTBkx5Od1d0/Njmd1d63uY8awnXU+j9T6iWtVWWayX91tIgdOWak5gmSy4MbE1S63SfnLuScV11MzUmTDOW8T0ZV7KKbGnIB1l2j4mpWZ4b6f3P4LvrV3WW8T9b/vqUtqXHqeju4nx/3ZWqKXUp9YSn0jttfgfTsNSCA2QD/jgdzhQF7duwyeu+H08wVN8ZKxyy1Ztq/iz5MnXMVFTZtxqzr6JX5z/rMu79T1GSictN5I8ZCNZOpn99viiLxkkXWt1Rv8p+o9So/Hdbveaq+WZ6jdXWDJH9RENSSku5l07nSeq9ywkYyL4shgyUZAjFyvy5MjQ7LLO+fsTTrvlMqOmjSSCWwsGwzMsX95OrqrpqEkQAFM7GyLF+zyX4/l5s5yDi418fNfW0nk/yUF31dI/X46qdamuaVTFGZsGu5U8+Z3p46rZYzLo5CqdeB8z2P0f8bOkNnNc68dIt9Na/0LvrVhVsI6k61QwEg+QUJn5Tfj/b1Ic63pdn6SVV3CnJOxwwHjm51xZC8l2GyeOQJWdD800feXRcYyedCanbQvbLtNyfYnybPydYr3NPPFR5dc0QHhf7GxRdE3E87gPkBxXjpXJjl5mjpPE1PJVS3Q1lln9+KQP+wbXc1rvCfJ1XdzXc9FLv6q3y1OqVZmlQSnkYVJJQLYXYdyJj+NXA72YG24v4kuQDqz8mPTHySUTriEnbE+OWa3Lp29TygydT+AxlWq+TTWLqZSOQZOuHg+9al8HOSap75WfzIxzVZczO6sB34ornGjLD9B8PmXU63tR/J+f4t96qXZKbpnvWgvZ+qLrX7CdktfVUEuqMAYFr/cCYXfTuu4F//G43KMcEzfQ2uPHIvRST8kq1E3uUunmdgU6ToEZNn5FOGZD4xXHJNxqjp/rVXKa629TMj43zuUMcrQE1+9RVcuitjKr1HI7/AMmn/wC1560VhiYmXG3RMu4GS6fGRybmRpa5/T41P1dfgCGUWAALWtHvkLyEgFMEWSINrTkSJhPLtooyM5kdtK6vbEhTj1LVb3LPjZ+63JyuvwYIovJldG3U2ozO4/Usz1PLyRrTu1f6yw38lY9QzM/4296ar/tDVLTDN2HkVnX/AMpk3qZGa0JhSTT409015DxqbT9iMqULcg4B+pAXHI5KSWhhx+lvuLr2hA6Y3is/rI8mCY4k3k0MpVfqNyseOzl1Otn4vzNdzpa4jIsCF3SiXJITKBs3yoJUqfgjyT8mt98Tmip5vc1P+SnVGuZpdH7kDoX8eVBQfV5xfaKnc0y6Ga2F5KlNO581XXhN0/UGUJ3W6gTsP2OqcQEu4QEp3ECzdridBLexnG/Ww1WSud+Hv6ympeiq8EmipoHosePmms1mzZE6niZ2czOiApTUJ19fJTVcgStbbWqq6x9O4JqiQ80+Y30AHX7KZ/GR4nlivprmty755n43JTqhpfjZNPnWk6ZE4dt89s/XZX0giQTuiziJg4NpM5sQ7HNgknyPihBanGTJsaJO8evBy66a1pQDJj/9tYtxXW+a5ky43jZquhqb0KSBvUmu6/MvLUA5MYtQY5va43snlUrbRq1rX2J243xX4FZSHF0HdE80b0Xsqct5Nk+VR+q7nv8A1+ak0oAwu7xuDvYQgJ0yeIjEsG3uYv3tobMck9PXmYnXxz562fJcuo7G+nf1kEfBUsJqtTJMPEp/lEv7xMy7+zXJJrFosOehH8FGfM14673UFoal7myH+r4nZyP1fqqHGOqXdVcp8kVvnWPVT8S0lBQiTEyK0KUmppgg4EkA3EXvw0FfZaBZsW77YIJge7xqMc2xLJIlw3o3kr6y/LrI+dIhRJVu+pNO1bxzVTGJ25fNP/Wuj69Cf4yij9bErf8AXX4dZEOqhQkmvNdO/HyHTS7NyZKD/W4T8n/1uLLZLWaXW5HlamsapJqp1TTe7SVB3pZUcJ5QjePZvsdMhgO4+gOwwrsE3Cy2X8jkpNUj8sWBw4x0R0zp6XYSfbyX9ikUz26aMbNFRbzMfH9aZgWk2rrWppGE2j+FkWBi6HuxKny/FlnfLknRMjP9Sdk9Pl6fxaOSkQDHiJTbJk5ZE6d1VFJTpHn/AHTxtGSpxJj9SEL+4jR2fgPYXJ977q+pL5vdG3oB5UcksaplfruletFT0pMyaW+ayW3oNZDz/XSm5lXff2dVJqv1+/xe8MZtJW7jasFc3VHEtlUAaf2NDv8A2E1NfLt39hyxMVs5k8hN2634JR84973K+RhbkogX9SjK/wC5PfuNSDN4nLN799g2rSxplZGIFia1M4x4rW37Tkqll53tMmhePM1pKrgNrFc9UZDbi3Uj/SddfZTxO+TVMv21+HkyZBnqZvJyHX2xkUWSVVdbvyi0wq66PrR+RLjw422xHl+7uy2Yrw04mZK0Ov0PbraA2YsGSxaxFsBL6MYAr9rbIXgMBGTg+NZzGTHlx3j8bFFoLrG19sZSvXVA7dmuE8D+WKycjUz/AK+Lnl4h1MlG01jUr7a/U8g61SC8mUZcejZjpNneRpHusiKVNaaCelkf1pa5COew3y49EPh3zGVUPKj9/q1x1yo6YIDPalwBccC7ObokrTEEm9gTAKE3IjuzjnQVk5XHR15qCx+1FSG7q3VY9b1UGzZ+ko/Mkl3PczWPIBKk2xJMktZPFxKyan9+ZUNIFnyZm/krfHyTRrTj3ugZ3J1NHM/XZVK/oF0wMhPSclVPiRokmctlVC0dFHhYJV0b/A1ljvG5fpIsGc3sGnpyZt9I7LNjtzGrGpy//Z6QTNUrjDkrzjgCv60BLROnYamtq4wxNeK/tXyRfmDivHF26TaEkBz5udrpCOYZ44nb8tT0Em9FYzUz1/01j8+dn71P4NZMjeQY3OLGE/s+ORJ6xzV7T5CgUNBy6StoKCpYHJscpSuMZYkm28DvhDI+1hVtqPUf42KigK+OKmfpjl3BN1RT9MnKaWuSTY6NnhnJY+Tc5KvlZkZkOt8zIldTKT9XUoSrsXGzjxtXNOW4SmatjFdHHWgJmWdM8rvfGpklN3JH33yQPCTBir6x0n3lZ4ihEvb4Gq2C7inimYi4t95sL6MycsZlhgbR/jcQmdRZGQ0Vz/kiovvdwdAEfWVjwXuXbpDlQF3TVa+PTijovskyZcdVG5FqoafKhLVmqZ+Lf4wv4Viv8lUs48hp1Na5jtcc8LD5NUeHw6PyPnj90/5L1KsfYaUVaUYkGd/b9Out1qmCJLORckgDfKheO7lApNQ723UqJD8ab6X5Kn5M3L0arEg1M8x3bOo1QeZo6a80krQReV0nxzWkiNzxrdY+KXZqGnrHoZKWZ1a/g5cgM9b50RzxqNVG4zZKiqBFpb//AMjPOSpFZZw5Lxl1Q/FORuNUV8UqT0+d2nLU7UlkOsf4yVSh5eSVuSIEDKvFxgCbwDzZ/wCjOVpgxkMrlm65uly6A3zsx7snrHVbNxJ/2H/IdFiK+PDimWZquNJu6kedNX+vqyaEoCt6+l9IyDER/wBkrHWLjq2pI0DlHbwSdKc8q2fVPxkYs/H3eBgyE1Q/rVQBzIb5p5hNjzqW6/Cn8QCnMuItctDv99MmWuOJNNv1eDcRonFjHpqYGpy9lRYxvRFFa3rf9A2iz4vW0/H/APa+SasqKL/WOthNVEPIeKATzQ6epkm/89eVx0UZJtQjkAJgvp5qvM7Jm9ffVR1+Lx49XY34T5Vcn1ZCaMDqArz50gf/AGyqNMpiAS7hxZ8PMQgUcaGIs4urFLi+RHOzXKuT46/W+NhUlZdE7tp0lHQUH7NvLDSfESH6VsqWX5K1LI4wdCYt0qk653/8fmJ5G4nejHP+P/d/aci99H21Pd6QUV0/gL16jFutKbtsJjfybJAqpfkNATql3p5rdVt6kSwBFmRng5BDvZspQnjPcc3J/wCN7vd8uF/7lREUD0Hld/Y562dBkgrbWmR8LnhNdTL8cZOtzxZCfGdVsq9v22A8ktb2fmWTjn5MM9BprHBzE7oJud5CWpAlmtz/AF/tFH4E1i1S0rlne6k6xuXjmKs6jHGxip2vXTLQ1rWk1MAg4J9LsFaFEFAIvB1W2Ge9kMxM5UGIk9SP+SnqsR4gxs1Ov6KsvVXttInr9eLZfwcl3GEcM7p+M+tVQSu3I31B1GlanrgqadRNfmMnh7+wTYn2+sQfSq5/r1MyY6J6FKrbuSqH63G8i1NCB1GO68c08TRLDLFTzNX47H8sshUggkCUlYAiahICCkemTOqjYGRfIEWZIBEvBtYajrB6g6IeTVAamk0dFT09CUd2L0mh1pGR1NNBMdUY8exWYrn4rWxOP8f0aH66JlVUDHzOsdHxh18YkDG+ak1J5J5CJ+q7f1X4b08yE4+MT5/rFsKGOmt1Wkl0TPyEE+OemQwiQWhMWJEw0B3gspgaAn9ft3MTY4kQjmTvHBWKazXyRllfHG3rIOOgiY1Uy1Jzvf2gZSmifD9Q/wAOjcT4dRVVFJz4Y2eaDwMn5FPx47yXkayfFtp+61yMmNmh4OOlvQnS+HX4ycmMxxeo+2GSpI6mbP1RezmhFts3LNDuCVoB2jjuEmJ5RYjudVFR59sBgDmcpWylUarorfdjqapJx0buUmSTGpo8OvJzWkmHJW5YO4yRGGPM/Sq3CxPcmjjhbqimWB6nn8zeqy4a03XZNEySFHgq6+rj1tipgDTomh/JSsmOZ+UwRjI2NJWSI66a2AlAczJBk1zWqJ21iZAqgAvd7CUBByDoDfyhi8ZsxsBIpwQo5KbP63I05JgyVHL2TIfJVH3xjuupmno+pNn41vqqNlUOWnJDHTDJ9KseVrpYJkKh140qi6MpWSEx/wDjnmDeMv4pZqrxzsZ8yDWqES0mOwvTsW0OT6hWaaXROokMd96Zh3/WDxrXg3+XkUgFkAs8IbGS1M421YJNQy5iyAVJ9MmKkWd7QNM6r9zFQyTLU463XS0LFOtbJap2ick7KpH5n050Kl0B5q/CeF4ScbjqXrRoGqR/rRNGvk+146vG1LWvjaJ0zbXiJC/LPO3pNHNYuOaljELSKVPVRW9RqjUyQl1P96n/ANnPkx/jqIA2MBypVgpL57wNOpEgWIhmwtFzliC7YY0jJidtEtG8aX/bUPlmyTVSAeNoT50xuYvQ1eN3LEzLFKgmWX/rN9coqxe5N1pp5mlJPGGSb6DVOlqvjs3kHSH0J/3JIq7ZfyKzMROTEk6IljXPcCfYjZTWuTS6mt7mpAZKpPCfMK2ffnGpZpMnHf8A4h/QJBXIQgH1qZrUaqJmOZ1NN/8ArWimZyHJuk2a8O15iborIZJreqgyIM75m2PsQM7aRj/8k+xexxwuKer81M5m1hqZn+2JVPIP9A/tXi2rOYukxx3NZYmYjrzNi1QZemm6kN13emVK62HSFgTsCOAAFuRlwr4GgE4/lj3EE/c6H1GZyTDjN8M7kXHkyleHc+deOI63+9mWGf2NZSxnvk7WlnmG9zPFU+evPlNDJzv+r+Lz7+vPf10pE63EeO9x2/vZunVTO0V8DHFvkZroyfvUJoQld31boqB/qSO6Ns1GRSsj5WccAF2BDPirUOQAJhHP0JJhKSbiXpgvdkz3Ljbq9dVLudxFZKJsOUgdgrU6YoHdxjlXXKNlJ8lUqc4z+tQ9H1j7E/Z3tmRfpraqqZNSVzFU3xAQ6wlIEt0+Wd766k8LlxjKi7JylOPLO4VFaeShIj49tVroihoa2n4oIdMG59UMlYz3nudP/BqQB6bnMjElIXc6KG8jVNwQYf8AFAQzdAMuWdBVscVS3Wt6B6YnOMdQOTFWKi4koJk3WjVFS1xkqmmlXZz9HmpKZIlx/LubDIpc13KJU9IVMrUEzIDW/OqT8jHVVHRj2AYVdtbTxa2qBoGpmbAdjXms6trZksShyBcjH0GpCKZRtwYHppY7DkLyLc1jLgZ6V6L8UG2GZvLalBVddSeNOg56LmLJc5s+yMlfY5B/ouPxG6mbqvKXOne/9dDriCbx10Oyregfk8zSb4kbKEYEWJ/15G1EuZuWyeK3XXEbxwTFV5FpHk+ujX1rVcW8vUtP+JRUYAn/AFGJA0wCFvDgPAJTV9wbGrIGrnx3k8dMYiW8k1XNZGL8BsScNDzuNEh9fAflowwXGsxNElxIk46wy2mF1q8r5nY7KJTstUoR6qZ+yaYmoB+Wm3GEqFH1BTiqT+u6n6dVfxpliMhtmpqr6p+QTH5x0E2zDL/Xep+3Lw7/ADgqCYhECP25GeT5AZu7SRNgO+IsC1cTtvSfHRlqnmRthf8AHbczM61XVsaroChU5l/xy/mynN8HHxG7mIexquHqdX8iGqjet6/rsP1cvP4s0/WMfU0Ez5iJjqGPN7GtG0yNTP8A9Q/VGtpizI6Qsyf1E3Q3556+hJj5akk62TUlpRXF1aHcHgEsYgZF8Be70xB5S5wwVf2nV31OS/T5l59Rm9P6up9WVjj61Wf/ACZAoyEVcy3TEVbqXIZCLy4cXQei95n2b2b3m/SuP/6c+/ejPYPQz/42Vy+m9B60ivcPcTL5ocmCY9NNSi48ucRx1P4ycb7gfxX+KzOT5PU4/Ue/e4rloKxZyp9Nh0Y+YxYfQeiy+rzMAVirI4LvNlmPzk/cvR+lw+twevxNuLH6rD7Kjlbw1m9J6bFPr3B5mp9NPrXJGK0SMHFaq3Nx5Xpp6x9NdBpkkEguqmk+kNwjUDI5MjVQJpJ+aEb0gIEzNyZ/LW09N8Hp/T4cGCXiMJim5Q3TP3tqKZyTVJdDNMlCyyzJTz5shE7IpKme5CpA+56i0yamp5vpZK1NVMXM6cT45r/x5akbqp+rBYKXiZonxMTya0LHU81oVLP+TM/2zFfVmcl75Lj4uOZNeOD9ylnRFk/lU0ByiFG1kR+n5asEADYD28xbfPDI1JvbMVOUMpmLOJsxrzxeid/dJcREvVhDq5pbOWb6+0YwyVY2y9gjcT0acY1vWp8bx/V1TrmzKx8sp99764knZ8gjTZpWrZ+wn6EivxefLPfM1P8AYlYGZ5g+zSDW55kybJNHVSKx+WOnLTsCQGiAP0EMRqCUVxBvkX37Eu24GrubMZIomtSz0vjXykj3ckXwgnW9UDLonlaU5oY1WR9PxUzQ4q4XEEp09qtXsx/V0M5Er41rVUm6hZaDKw3E47genFJGndMnJbvboaAn8rZPUgPcZIV+Nx18rLkSZq21gOWeeqguCXe2Jfzp6fQFQFwwxzAzbACGxaxJMZ9oIOcYYAeN7bGfUZTugL1kuA/tkx9Torb8PMSUhIutonlClfqH/wBd5Kxk1E3ZFM3c5GAqRoSpV7iUOHDHP7/K8tZpvroyY7JorQOLGT2f5LaoVC9AWczXNkoprDHmtaarJJy1T5oYxlOLZTusYdVvq9TRM1tT0gpAdIDBM2Aew+pV0tSTA2SbsAnG6JsYF86v1mxLpxImSSWZJK/e1Hr/AB0mu9TOoguRx9fh/wCPo8Sl6z7ahA+2sF3QExvZ07vuqo2pzqsedrHOVJ+TbjEmvkmpZ15a6ZkimLpatLOKDf4s9RxWSaWpumMeQ2c9EpLk65CRrqJnQ7qdp+L+yDiGFCAMEc5MBwS86hiN4n24UzjO41upy5CI6mWqmXuac1E6+qrQnx8lO535lTsPw3LVs/5pE+OpouCP7dXP0P7V0Li60rp/9gmpMq5a6vzWCK+13MicpM0am9UCaBtMlbB5pxqArEs7flXo5jHUyVBwM1Gz6zeJdulDwRV0qVGSyReEMRiyA3uNSahJ2QeUFEYiHm+t9j9XVaqZL8TGwsOnZNEdcg+Vdruj6rre59BmylXRHRkyUYmpMlmR4oyF4ziJxVuakb476ifun5y+CuZNvyzy/Hkl2mNAm7pfFY+Z2sf9itNJRsMPqD028lxdmVJZ8gVUhjyFxXBFJZ9kaZCTW388/r9GlkMyZN1IX5TxHOtNXnL7IiwccOXK123pvU+anJjv5ZyTja55hsTqMjmQ009FaJ2c0TcT1u8XqcFXM2U18viqa5kpJMV3k/6UlbuSKpx7rzJf5xeD1F5BnJHzHZueZp6p3VRkbqmZPD08TLNaKdG7x+ojDMVdDWZPLhG6yU66eU5nFUO6a6ZKTrX55HW6K9RD3tg+m3bGLeeikhnBz9Mzeb8Zt6b7J/I/W+z+t9B7t6DNXpvW+1ep9P6n0uQ7+vqvTZZvFvGC3iXqMtDim/EXD5Hc/wA09t9N/LbPe/aqPbsXumb1GaPT+py3M+nz7c/unt8xcZJk9Jmyz/4z8i5/R5PTVkr5Lqo889Oxdx8kOQyTF1cmOmr1bJf1nXWuXH11bMz1vdHQ+myVlx1i5ribiqgTHGSscUfJkiahvudTjySGwNTLZT4vW6FNPVp69I9NVPyzS/UG/SfbwBrpprBpNJYFTESXGMC802OI1T/jH8n98/iuvY+PUE16+H0nqPS4qMvzBjiceaXLi/8ALxWzLESMVUyabj4nbRX/ACN/Of5Dg9ix5fX+5e5+6Z7PbfQ4cuPFnvH6cy5Mu0/w+n9Lh9Oeoz5M+X1U4sWDDkyZGZxuvZ/+Gv4z7V66v+T/AOcev9L6T1x/xb/xV7//ACv230PuuF9Xgv8Aknvfr/Y/4N/HfUGFrJjjJ7T7x/LPT+/en+SKcXq/Z/TZIasPz0P/AOh//iv/AN7v/C//ADr/AMn5Pf8A2n58fpfbf+Lf4/7V670ubN67F67+Y+j9R7n776z2/wBYPXpfWYfavbfa/apyuWbvD7l6okPTVf54Xx39S+H6FfxHVp6HTq63Tr6HR9dYE9Xr1CkDdUiqklMovGqo6NRFAqqIpq9VQ+ZfKBNrsgixIstvM/8Agv1vt/psX8tze8+kqa/jvpoy+5e4hWXD6X2v0nqsWPLD6ic+H5b9d6qcuDLhmKc8z3ExlxTGT5u/5a/5D9Z/yF/J/U+su6n02F59Li6tjkHHBixV0TixYmcODAUTixw71V3+Xv5z7z7n7R6fP/D/AEnp/T+y+g7K9d6b2vvJfvHrZnFg/wDL9x9TvfqT6FHpZXH6eQcZ1WSnT/w/+LZKyYPefcsVHEfJ6L0lBCE//wBTnmvrrc18cP2cv2ZPrL6XwXQ6Xw/V6v8AUeqj1OrTTT0aQQTQEATSHcmxstp1n1OoSKOgBAPzFJlgJzYH78vZfxP+Ox7bGP3L1k79beFfSYsiz/4uJkkoKl/+vLXzpDHNa3F5Pr1frY9PbjchX2mckpZWqqk5Ov8AJMPQ9BuSGtzqa/LGUkShroHO1VTO/tVONnXL/orXM5JNq8j+VLvV9/JVuQ5ouT/HF81O8k1rHjxMfYkKOcmQOGdZdXq9Tr9Q9Ql8bWQ2KFpHM6j0+kQGWNjt/tyCT70PUz36TL6XJjM/ps1kZMGVyXN8yc5nkN1GljP/APY9u5KPPFeo/hftXqbqvT+o9R6OPk8Ys+LHnDrmaZyVUUM1QaqWhdVU7/PQ9YKqcd9ZKmTNWSZmjnHJxjtyVuqu2py8yHXMfXKRKjL6cyXdY5QVymgj5Id1Uvmr3csJA9MURX31Y+j1q+ixTWQGyMG2MHtMcaPSTeTEwxba14vs9aT+I+lf4p/Lv4f7l6U+fH6D3/2f5awbw1c16/Hiy48jP9jPgq1pqI55fvPmtt/yD7Ieq/5Z9T7H6Xm8h/LK9A4f8/qKyZ33Vx1hZOu5TI9cwzuckY54ZPzv/wDiv+LP81/5N/4//jFWT6b1/wDK/Z59X9cuep9s9v8AVYvcPcvVViBdYPbfS+s9RVVivH8OPt1G/wA2H8e9Tk91/wCaPe/5/n9pn1/oPb/5B737h6PAJ6f0fqPda9R6zJ6Hurwxzi9LeSPXZJxHynwY8c3M01Kp+MqPxHWaNdPwlWw9Xqq/6YGZVVsBDfWtNHqopCVNXVAKEAgBk/S2D219o+m9zwvrPTyzh9P6P2z1Xp7fT1Veh9H6bJ6b1IPrs+aWjBhnHnyYpyuTE8r8uK5PkPTP+Wv+b/8A6FT+T/xP0vtH8u/jPuP/ACJ/KPQ+2YvSek92/imKPbPefbMPpjD6e/Rn8vuPR4mIt9Y1hcXvHoMl1ORw3WLVfDf82/lHqPc6HPlw5prJll9H6C59N7J6OfUtXJjxzfebL9YyzXrPkydPf1lmMfhnunuzGscyYcUZpw9mSZ+ZjvdXH1xOKunqiZLEnn/HbXz/AEf/AEt0/iuv0Piut1+v0a+lUa6aeh1DQWSCRVUJIJhbPjXb1PizRSen6KKggBVUJpFIQIcXd34jW2/k2f2/L6/11+xen9f6D2qvVW+3+2+4etw+5+54PTd1OHF6j3GPR+gwZeTHiKyYvS4TrdYvjayxbvd/4r7Hm9s9N7zh9F67F7f7z/xZ/Jf5D6bB6zPfqJwfyT2DPn9B7l63BbWOZ9EZ/RXmxzmjJURnkpyVMU+T++fyGrhmbMExixlXhxsl3j3MMMZR4N6qiWaNwM67v6o9u9kc/wDxh/5biw569i/+hg959yxWz6qsJ6r+dfzX1WeaqmDHh9Tj9HmxzoZJMGZ3VFE/R/G9Q/0+n4I0lerq09Kq7rBBABJv8/pZgkmcDXH06v71dYM1ehgXQyRdKEofYa8I/wCK/ccf8P8A+Bf+R/5Xi9XM+8fyr+Qel/iHtfpFyT/59en9BeX1WOI5yVmwYc3u8ZvUnyGPJjxOHLiok+Tzb2f+HekwelxX/wCeY/fL9Sep9Rl9PRl+T1fqJ+VhcRGbEYsjM2VLHXazqsUFL+ae7et9P7H/ABX+De2esb9p/jHt2T1dXhxRNX/Jfefh9f7z6hyxifnrHVYfb/TZNj/43pYbcdVw+c+lw+8ZcuH4/We5OVrHqtZq2OpBma+Vp0v2sLB2h1r2fhPhzQOt8SSup8T1TUWBFNKo6dKJI/CKKrhtQXrjr6tNP9un0GodOlMlH1n8RBcmySBhjGvq/wDjfqP5j6LP/mwZs+H5ZjrHmmcWeuoHDmu7vLlnMHfx7mwYaN/LNeVf8xey+m9s94j1fo//AK3wetxnqRZkrFmyTeeonIfRmPknXGnqU6GQmr7P/C/5N6lwZPcfc/Vei9HmyYac/q/VeMU3d6/+tysmS7iZOi6haFaV6Ot/5R9Biv8AjnsWPBlyeucPtzij1NN/58fpr9T6Vzc5Zqabup5oXe5OfPnTpCnofF9I0+hdUmmsUUlIAGmqov0tuRntG3q/udGsGmselVBoukK0tHfwUdb/ANv9V/EPV/8AD3r/AOWe5+rv038hwV6T2H+PxFZJ9Z7x7zMZfVeubxfBnrL6P02PH6bG1hz4ckZfV69VHqW8WaNT/C49J7/7cXH82/ivoPf4cno6/j/v3qvWezrMVjxYb9F7r6vG+21layeTPn9P/wCO/ITfJE14R6Wvdfc/bMXyPx+1fxX/AMf0fp8EVPxV631/rLrN6m5+MivUZ3FeOs9nyz6fBiwfIEyR7pn/AOPMf8p/ivqf5n7D7bGT3P8AieL0uH+fe1em9KsYvQZvjxe2/wAn9GTxX/i+tS/T+vqdx6b1ePHkpcec40+Ioo6VFVNfVNP93rRXBpoYpFNEtA77mCp1mOrVUaPTQFSAwyDUgCZvCO8Y13eX27+aez+mrP8A/eh7j7t6XFjYy+u9k9Rh989v/wDKguozHrPQHrMc5CfvjylGSCMfMzKryOb+WeuyzOJ9Lh9PmIimPcPVZceWqjqXDl9PjxTjKWq3iEKVyXLQAH8S9u9V6CMfq/43/IPfP4/6hD1OLJ7P7pm9Nl+fHk3MfBhzRpmrxWx5Xckv+RcfoXq/5J/Ms0B/JfbP4t/yZ6WbnLeP330Mej/kNYfiSvTx/IfbK9H7njyRjndRXqcnxtY81YrUt86ro1dAs0dLrFgwfRWjsKiaTEv1ASANbio1UBeqklID5hTlnIgAGF5jXnnpvcffPU5MkYPdfZfRblyQYPRYfUepW3wYcnq25pEKx0b+1ESTdp+WfU/xz3D12GD3f+U+7erl1X/i4/VPp8NJG6ifT+lGZxkxLk3Mcn+aZrHX07L0f8a/46/mPqMfpPaPdvW/8ffybLk/8bB/Gf5t6mvUewZHPsD2/wDlfpMeF9PinMsn/wBM/Q/DME1k9ZlQyOi/kX8G/nX/AB/6jFh94wZ8BlhfSZs7i9V7N7h8SZD/AOlnuvpsmT0HrJrGYkfS5MjHR3OObmPx9Lr9DqV/2wuh1P8A+X1aVVUkjSUqwwEaSQ1bSFBUuulNiokCRCw++51p3+F+w+m0kY+5xOSM1/8A120nfxRU5LL+SaJ6McdZGGYT6lU79JixRWOfhwTiSfjCJ+SMezqo1RTZUkzNwXLU3OOmX8ff8uz4IZ919tMF54mP/Lw9ZcczkfsTM5N4MQxkoiWrmqjmG8YVSz+7eg9wxH/jZ5bwpX2yRPzJHTNJV1VXNxuijHlMZrzM66x/dXzMi3qpMYCgC9t3qSKFClQB4Cc521l5XHj9R6eMdzhq6M1yXGRLK6Ym0kx4pmlP7Y6v4/rzZesyfFJjmiiPiLit4uOhr4YT7BlF63OslIsEVRP5S9V7ien9R/j/AM85NbsHvHlyf2DI2TXOOfruqG9Xp3c/lGvWYcuw6xrkvMZqmN1EeZiouuntvU1BQupkaI1rR0zEGZbDH4bixXOJONL1JLCLJBusByFfsdtbG8lXNXkScWH5MWHFdq93GODNRkYUrIHx0f8AZDVM1vVeryZs+uhfiSONPx7gqsk05fvWXzWsnIr5JKoTXZfca5h+yxlIT5brQd7+QfDsXlrUAhe/vvT+s9wuq3TXqceW5e3KGTHFlLgyMtT1o8KTys30xds7UdIsmmGjxhiVhCI1lVWLZbOwIAgg8YnG8B7n6mrxmKWMQ5GrrRib3j/y6Xv68zJGiXIhNHjbov8AzMuMj4spymOckkxBWw/9eprukkOoem8lI/adVvcvXTaEaomo+00yfHWImMdVPyfLD5K4d8ci7BdI+qtKnm0c2jmnbTuSNVQGM3pkRKWBHf51imA15eRGcIP6TrlqqkrCwUokbXa/3rf5vdvkaw0cxpiEnjGIGOdF1SRkpTU0LROPxcHWp9R68cdVR9fj4ZJ261vr7H+wqPl0VT40eT81PqfVLy8a5TDkYEp/ac6KWWtDkIF/T/Sn8oZ8+TiT7yUUNTMtVJNGtv7RPLo/rI+d7oUAWHjAARvBGDss6g1GblynAanH8Iy9J+Nnj42dVyXqZSaU/wAnyb56SIHxo3/XSIC1BLPW0jHl6V6F8r8bpHzvJQa2SdSUjJpDwbigmdy9BetX+55mal0QMlbAK3LE2VliKkNvNZGZJqpoUqr111Wzs0qsvk2fbgjfaBK/Da24zLzpAwQI/gA8vb2MDTOfTJtxaFKl1EzpT/SLXmjzNatA6HlJ7weZ040x1Is8F7eZOqdz0IfXRcAfV8sZLMzEYmYNypqeaqTmvrS+DqZIjVV5n6pL+L613F777+KKZdsshq7ve5ddzX9qJRldluoUohAEhAbv232IchDQSTZCbewWAfqs7aiMuPB1RAlX5nbrG1rkKnmeZSlh8Uyj1O0jJWI2/bm8mOh8TRdKyN7Z5lokJKcfxnGvr1Hi8djRJNdNUK0yw/E9ed/bySaRZEXaWu9aQ5kfP1+Qx+PEJv7RX9tjRsU0LA2wdvY54ulDW4oZ/Dk2GHZccAYJkjJBTFLNmTr5KkRJT67vXUq7KkR0S+dVRUYsnichrc5S3JtfG3HsmgnnSsujenhRJs0Qw/qYK1LNULT1ro3Jrmr3qtppN/lf4+Zu8fRLnRxNa4XwH1oSMmwje98xSJ5/JmkoU4nJcI3PbkJ6LIbjvt6UrkLbjnT8biftl2ayzRVRT9xCR3u3z/Tg72LX2J0ZkrJTqdJalGpqrgGu+1qunYP/AG8S+TYEUSU1jLlyXoJfrVTIUZfG/HilehOuXndRTV14ZmfC/wD1GVk5yDX9rpE0nI65rVM6oGB4xukSduc3LkaYJheZ3Rm9hyTHBGimayb28lmyGnX2OFnudNrW5dngT9gfhVOKMhgmaGcZPeyUq5CcdPSU2oPEyupjYyUrclUCFusZ4FKvWvpXW3WkP0VR9E/VUfOpak85aMxqDqa6dRSyBO2ZNHFVvW9yfgCGhcTKiFxHaEDw5BMfxfZD2GCwNHVESVXOyYhJmq+1FarbWqo09UgzrdDqtidg5MX+Q73f28xkJlZXHP10dbh1Pmb6BeVZrtCslSfJREFE9YotUWnU4k1WlhvVFz+tJ4dM1JvHz07uiJu4gLhiSdxSlaSOnqVmvtT9UkJBRFpE9h/DjQ5AkYmVEVBpfQjtqzLU0yJ1dSjk0nT8evv/AEqZukAKNVJFDSIUM7qSaR5a46TS1F/IEnjfjg2AePvR+D9cidbB/wAnVtT0HmsctCstb/rzvTo7kfycdbyVBuo18s+Wp5+lfE9PNc0eJ0S+dJS/l+ppzYBeDMbTfnjVkpO0KcBRF1i/1mIKxLtMjl2Rf7YnKmhsAkhl+SOeeiknx+TR1Ks+YYi7qj7k8SlKFPmtfUTgB8x2g5ayZJ0Fc7xOPhJHXm486Edz3rons5NgzGSkztI7Inv463Ncx3Pl2zxKtdK/Ht8+fwFQgCB4gD/8JNWwu7gGWCUOF75L54mQdPtxqDPTPMeADqeSC7te+1doPTKOv3+CVVH/AKWal560/EUanbVysu7UoPIovU0gT3zFsk9QROjbXWmabqv214aTeqkeslOmTl+MKl1dEnbOSlzf1HajUkymnZqU0UL+MVbwLGLhDz+TggafP5WtvPf2uJKKf3yMXkg+4tFJJNY05Jgeg8Ol1xVTaquceJ1OLkrI1OmTi3XO8kUfSnaEmwOt8Ufk4b8FQ1NT4s6ZqrGaZDddDdTB0lSP6Pq/gXON6x6oKsyvknUrz8NeUrfkEAm9SUVQISSImQQzakkMfumIB1JNoYNrlXzEiZgwjuMiDt1UQf8AsopxnhdsbZ+36mmZdeA/bosZKmsfb9iKNcmuq+3TZzV9c/YpT9L48ZPyvW8l8yU+NQaqJrHj3OSXrbRW5SQPqTKbD8ErNGapi/qVx1Scp1E/HpnyoJNef0k+CpJpKcEiorKcbLvEfnI7YBBO0YhYn/EBJh6y5x5Mkyt1OHddL/oZPiTILWk6oiDZ3vyR+TOM7pyZyZKLne6GBkg/yO+DVFE9KH7KfzG8ksfCkD9KSPpPVeCndTW4K2+Ul8aq1Csp5djZ9/MCXHhuVkroEOcezQ6ATX46RSZUioFsDZb27LVDJCEye2Tw7oWLidZUlR9xlPqUgFUXyfJ01bNfRK/3Mg6QpMoMuOZQ/wAJI6U+1HC3eymqDds/ah/VT0xqqKyR8RreKoCTJbO1ojKbKZImFU8k2A7KxmkjrJschOOao1W2Zk2+D4ypoLdIG/L+WagBZfhlSthy7wjqvUhMA7cqD2RNtXJ+GKYMOqchM09AZKmZxy2sjG+tBi1sordvIniMbk3czzkdb87sY5jac6hfrqCTzO5qtfkOQVDHUM467yk+Wp8iF1uurf8A2AU6QGh2FFfFi6oGrh7JVrc63kvlVlByfXyfs71+T6vwoPbAlI47+/bU1H7cbRdOXAPfbVjLkuwaxqFzjQLOqZr/ACVsr99KUa15qpnX4ubS9Vj5uK4LqayK8Af21Vjq+OZWt86a6fzG2clsVVHx7Omk1zCBu5KR8jHjbU7kon8GHH8kVxVJNT26qi1OcqXQsy1qUB6550z9j8WQmW94IsyMtEWDwdIlyHYbfLiOe/FlqXNvFVz4SpiuyihMkVuI3VBFLpmZZ8R+iemzBWRB+uHGovhWUJoKKK3ue9WF5J1rTP4MVju+J41QW6Ccd1H9et/2brJp582hP9uX8bkniNrLXjXX0OWQSq1pkZOejmpWUvxp0iHey5AsJJbJ7wHKbBeWkxcE49v9sXVURZPzLkAm5esczKaHH2zNR15bQNv6TZX4LslO4xsyHxfooxiLut9FbmZmWSpmpqV10M5VWckVjs3ikQ1Q6JqcmR2i7aDzrwLT9oUdBCeYxNs+LyjPjJ2nQm/sktaIoZlLcXn5ghguGzZIKUsC2g+lZkh5jtdkgDxNpKeMUbxN13kkydCGIo3I8bx0Y8nSST/Yp3ImNaYclrRl6Zr5JZZNQDRq05PrrWOCZ1z+l2gPJ4IiiTFJOPn/AC7XaLUOmdlk9uQ8B9q/MwZuf314vimW5Za5KROQxvkeXqf9Am/xwaqboePSWECHfd3PfQYA+2xYO6MAMwSe+sxzsmq+i6ZKtarnncs1Hgrp5j67VlfI/lpvRNVNR4mJkEhpZZVt3LSUdTNMzLv7G/wcnFgP0I5uePE3xB4aZVUfNTLDzrRpsW9a1U/IXU/HStaE1A2/98SCvCu/DNJ1QBp5w97XW0dsrSOxO/sZKvhFYgNgsn5YwrjJuo5vZtYgBoLWd3BHiLeQoeeTwvH3jJcV1Q8fJ1qnrIDT4eZSSZd7BZSamkcvKxbcNE/JO7rchbUXyGuONlarzyiSL1P5NSmuStNgHexxNeZWRPLNTKbH/oi0S/xJlARkKxJCFRw8ja+kGVzBufeCBYeNGwVmyHImWWwWSipkhxnhjJ5pNH9ak508n4yJxArqOeolXH0a1U9DIjQzMov01oD9pLix6m4ky6dQcL9hKbNkeXdzI+EqRntO5dDNpk6liinNuHSYMmOWH/7HLLQ63p814Y9zG1ozC3841oFcKDKJMwST7xwrPViS5qmuQCcuOq2pE65xQoRSc7gJ403Yp9UaP++Kpru8dvPG5E3w1v4/1IE6STJFTvzoXpw1fX7RD71QE7cda+8Tz5vSyavf/wAmY4Kxy71LW/8A2fqOTeO/GpnWkg1t/wC3k/NhVKDEBKNrgRYS+VBGqvH32iLbY2sNWCRlrHkyzXfTVTM+GS3EVzXyf9SZD4/Dvk2qogyWzWjVtlX4jmEj43s6/ayyEFIyE0S/h48pjiccn9dSfVJi2pAunRWmK6pinZwhOwBZ7t01906kSilljrJQDIzx1OtGjzqn8cJ59g4icuJ0A+YAIjiBaeIVljRuTtiZPEc6DUTdlSa80vmdASBSJoXa3m2rsSzdUZKihg2Oy3rompA3LK30u2vynUQbdp+qnSJy3I4l13o89APnZqQmvx8eoic0Yx8c8/INTjdMxLfT95UOqD7f11sdlJRm5IRa2xtie+mKvaAyVtYKOHOYMHMq4QuK77uVhCvi6ZYsvcx4RZx+JpN6ZufxcutE2ZMdonWkxloeEYJySczzH13X++kDqHmt56TfbFLUVjml+Johnf01HMaJbouXek2ORxY/T1wkjTpxh6eCSoOv70cpoNDuEPNlSJsgLZMYZ77QcPTLKQgI+nkra9xtGnY7vNJPKtXkCuVpy8k8g73jR/0bDw6+65nrrFIamq+PDyRUGv30091Ezqp60WG+n/HK5ASFaB4udaXojHz8n16ZrfRVL2fv/ZuW6/viJmnHONZAumgybHrVdJH2ZV2Y6jb5c+mTI8wh7Nmd1rSbF4i4IVMMGxGxHbS6M8qxXcOSdXqg1knrVEzJUL/ZVD+yOspjZE118mTUsYljFQEr4hoFmtO+Y1Vpz9v3G4xmnhLuKvWPIrPM1Opm1XcaGhiWRmUryynrbEfHZMVGIekKySui6rTUIk9akr6zzuFWkiG9mwLBQ4kwczfUi7u27HIIt6rYDhONGzi/XK7mrO5CYp/rFt73JrQB/Y1/rYm2scxMRWtY5yUl39m9lgoK83XyOmHzqaPNqLoiqZ0/HU0ad1JPRXTU1XWiPk1utPQ6BrxluyajGWEcX5r5Io52M/ePrNaht5KJ21qkbgSJvF4AIc7XAXbLeTc5nYQ5cCEJ3B0ePNlLzGSTFPUxiCt0Doboa246rHaa8bKnRqhmiMh94OYyY4EkmZyTyHUv2el1vxvQB42yf0DREY9d7mAyfFR0ffe9wnnX+VGP1p/I2tnUTLUlRsmS6aZhulpavoyLK9T/APFfYVgAS7ndAyb8FpRvuQpmyhE7weHAAKGTfMk4uTvH1y7+OSjmBSuWtzwD4Nzzrr7M7/IsnHjx10XLrl7eyf2Y2if1jJKdmg2mwAFvL+9F0URfc2m45Snb555d5PqSaNf2fwMnybwu9oaqWdyAS9ah0S80S+KNmzSn4HdYX2vgiyK2cGU0/wDGw/IkWB4KgX5mG0SonpaxmSSUqedb/wAled+EtnVNa4Lm1GPTE3d4r+idvYanIhsmp2NbmRK8a8v/AFgyTFvqclb0lb+Wb4eamHwlq3t1og2ePFDCZxS1jkTIynNqYMlpKaAkmWAZ5UQR2ac/TIc7SSQUALe+UeQdIUn5SogtwLBVACxNg2b3nQRijBE/drI/5Oxqr3yCXW55nHX/AGZq/wC/7eD8jSZMXLLVRVNB3N6+N76Sesm/rxIb0aAUo6zs5q8d9Yjr/GLi6v7ML9JDwPnS/ZLhpAvJgolpulqHZKP2JjbqmInQbcfkJU2HiTAAYTAXmGijbbtqjUACAMhBg2UJkJs2fky6Zm8cFrFyzVPRFcEyc/Y84XZzKzJqyuei/wAiDEfvLXUvyYncpeONTjilctdNCVsnrQUzRCxZvknVczCTH1Gce9lX4psnma/0k8o6RmJ5K3QTmd9MN3BaOizWolH5EaNqmlk/Jq/xADKk7oC0T79hqJKKstr/ACr9b4UaczE1u1BlrGFdMX0c4hSJkLlRPIrqTW5PHuqS+8NOUJyR0jUzEhZNt39P60GqkoTztXLeQvda0lUtVLbjk+gKr5/actyJrrdVZ9NGLHbk0+S7qZJvmdxRU1DLBNzrqibk3wP1Dlq9QN4eb3AbzDX20vmZDhif/tgdwbk5Wmz8tXNSa3lR5ftWm9ZKN2cb58/rX9pFD8u+my3dMcbIKmo5dVUodUNS0a/7aH5DyDNDTodyXXjTnEAmh1rE2sVZQdc/bvbt3QflmIeh3PV85eZZmZxV45bnys+NB1KXUNu384+pB37lSU4C3Sv7Fs3ppQABJJt8sZvLs7QdbBxt58fqYyE0z8lQ7gn7Dc6nRkdQUyVa1KK/ot+njJlriP8ANeSicE/GGS1yEYYiaemW9/THPTWuaMki1Vy5MWOrxWBcY9T1LRwaK2NkUVz21MLz3M6yW9D7BjyZfefaZxH+SfX+kpUpiY9Plx5cmekHJM4YinJeQ5iIWpmNWcXWq9NFR/D6aZO1kuZA8wzeqCMYRfqLQAhjghskTFlrq/Vemy5/Xehx+l9Xjg/jf8U9Z6r3r1Hpvlec3pcPr8PqPReq9TEtOes3qMfo6D41x1ODIxXxpwXqvRe2Y/Te5Y28b671XqvSe4+yY8WbNJGK4y+q9cYYx45KnHjxzgb0dpEb+rV9L6TG+1+k9/8AVF5fUX7/AOk9/wAWT08eshT2zF7h6TP6n3LPj2L6gzfDhwzklicl4vUpWPJVfmjfR+1+r9f7J6rHWX0/ocU+hw+p+XPkc3pck16nD6mpom7r0Bkm6qhHJHGOLvJfUeP0+pV6qpKppApIGaXVxcmSA4UDUVVbJlIuAwA9oJBfAwIZgJzeh9LlxnWsWLLeRyj/AJCN30FZJ3evDLqupnb0Ww1c96Jrqlx0QjjjIyRu94+TGynJLzT+t7/KHpJzY/TZ2c5l9LPq8v8A41c1uvTQ3M3Uhiicebkf6sw1UzMl1xau28cWuysbMC02uh1eK/PdDySapOTbsp6wAxVCODcAp0gTK3m+qBil3FgxxszaYYNkyFrvUZf/AB8k3AvyeMkv+qyZNrVQzLuZ2pOznXmNTS3LXyuWHtvFV0UOo2LsI3DuiZHadQm/j0GZ3NetYpOeJ81kQqVr5gYUd7Pk6fsiyG38pzkqRKju/tHdwb6qgqnwDj+31eTx4J62HRRSJmIvZwOzIuJwi9S+CA03a3dgMBEBCxBkkZEi/DRWSsRbNxcN/GnV7ncTXhQSUbIk2FPJlYr/ACSyduKrmKqu+nm66NNVFK3P2SaniUCiyUxPYRleOWSDVN0s5boyaMgDVPih6smpKJQZIfEkugGb1VfJH2rIBZ1U7pMk03SVNS89T00i3Ck7b/SCDi0nSNcJApAZhgXV2Lg/tYu8VQLRDqLllxaaATaUNXQEsL9tcNRRsr5cu8UZGi56j7TSf6Sau90jtjvda8zdLflRFFSCf5Zv7lED9BaGad1iAUlTS1LOq6/K2fIPmJrG9Tjahkjbt1WNpZx9TC0g+NEAbrQUDyRiNr2uzN9oIBg1FH1G7CFhaBgAR+u97JdbJyQV4cRzLz0jUZuu0qf7U3XlSeREPxMbuch4iiryJksbyVHJUhUcMLk01ICHxaE6/K2My95Jq250k97WjUvM1pkoPP8Aj+jLWna8yZOJ0P6Y+0TRoYgkuteZGWX6qilib2/SSAkrYh+mO2CMazxkgcI4z9psAdtbCctUhOf4/v1N1xz8f08S3O6NoGPmYTc71X4cjk2PVXN1kxZJTHVxj0krk01/9UVEz9fP1QShO2vNRQvzTuokcS+cbU6qvJsx8G9tFbl5s4MuytpjxYoThWurDHOzHWq+MQPCHUMvagZ1UDOQIiwsWQ1vf9WC+xK3yA5GBF4eNbL09arNSfG0Xjlpu9N8kcmp3i/tM0ykvZ5ehs+lyY6mWfklLlt/9XOSeIZr/q45XQH3NISaKdfGalm5xKnGIySVpyGqlZlZ8eJWqCR2wyr+X5+THGN4kFiakk5ci0uTgyIcoivlklS8fI8fV6ZFwyLjNx7nO4+Vt60oNoRmTNU4tJj7Tt0fpDHj/ryXz823J+52MY2mDY/skqZd0VZ9edziypk9PeOY3LBbUdwHU5HNTNUTk3NdJKYxhZSrxHK+mLyxb81wOVk6VuiY+0UEXMR4kGXiqaPMLR0Xo4IWpx0uSMmo6kx45rzESY2RLYqscUFxdbGoWTxviaECRcSpUryLd3zOt6KkqQMAMxdNgbibbkHI7T0mSLyRirIP+QuumfD2z8dJeRn5hkDEBXP+r5XqfTYouYaEIzTMxz3LKMzGSqB089Ohxcf7lkr84n0eWMN83F1WTEQ5ajisGbJfXVXLE6mebrnu5OPGjV956FqseHJaW3gnH4nptWjuaL6lxuoyfpOm9U3O/n/iAUcFvvFiz4Jyttb0EmKZqbDIUI72+9xr3b/i7399n9n/AOUf4vHy9/8AIn/Gnrf436bHix1la909o9+/jn849q9LioiKvJ7hm/jF+2YdNt+o9bj+n9d89/F/5X7lg9j9V/Hcd+oPaPX36X3jJ6H0ufXpcvuvoPT5vT+mzepwd8VRhzVBKubqujLXyUVpfboy4IjP6X1M+mzYvj9Xg9VireefUYn5IyRcUVjzY9Rk6kmeYZ2jNfn0J7l/xH6L2j/6Ir+N/wDFl+2+5e4ZP5Nh/hGf3vH7fWD1Pqcfu/8AMv4f7R79nz+y5sN+kivYvT/yD3OMfpzJGFy+nxX6aMWW6jJfyXxHU+F6HxHVp61+tSfiPSQL/D+mmqrZik0RBYNnruppqqFCfyn08BmwG0GwDZWvM/8Ai7+VY/4B/Pcn/KfvPo/TZq/iXtH8m/8AvZ9r9TOC49z/AJZ7n7dn9r/j3pvT+n9V6e31Ue2+4e5x736rL4I9P6CtZpz8Ycvk8enqhyeqzGX1lL6v1V5eT5XMN3Nf4sZ5vLYgQPdyhLi113vPs/rfWYvYv5TmyHqPZPWZPW+hwVHzV6b0X8h9ox+2HuvtdRnu6w58PpvW+2+rvzeXJi9ViyQkzqOf9Xi2DNYiIwGRwmTX7roBC+yt6ccpIPPVSzU9fTo6J6lXxFFRqNdHToJfyijpE+mkBx81VVRjPGs6/wDiwqT6hAb+X1YhqlXgRrV+otrnkmzcj8ZHOSOLrdlLpqAWdkXLE7po1Xh3azyEenouUZ7qKY6x43xbtWcm+i+nk1NK6IovEmSply5sfeslGPGpfpkmvpDrrfH1LWp6uZrKx31unkoMspRUGLrJVw0x3ZfU04q/sHEM8tVr8ogmWHl8RgZ7cayInIAhbdxKZ5J95DLgvLYuXlKnJAanWDV9YyZgV+zV4zeJ3cbQOWHp6ynNY/tAVvUSZccmpp3VWuV8Ok+ROW5yVFImXKAfGYIo5Kay2k2Sy00V8eFZrfmWpKHV4rotlYp5pdsYk/tzGWK113X1lzad1PXFfaqPq/iLtETN7M+d+eLZhkpi8CztcgeUt8HXvn/0Po+yfyP+Q/zGfTXl9T7N/E/dfbPZuYPU5q9+/k/o8vsXp5PTUjdem9u9X7r6hceTFlxGKdV/cut7t7RfoPTGGPQmHF6fLjK9PgzTE48d4W8mTJDk/wAnrcsxRnPjqZyxU5PvOz9Cf/oLv/ocvRe9fw30P82/lXp6xeg9dmn3T0+T1eFqrz1kK9FljDfp/k9b6XD6HHfq/wD63yzc1nbwepwZuMmPxX/6LT+H4f47/NfUet9L6qfc/ZPV4qv28xekw4I9ow+sx69Bi9Vl9Hm36bJGf/yyYzx/5OLFHys54yZKxfHfC/8AqL4Prf17r/A9H5+pSqK6zU6XQqfQCiAiaixOztr2f/a/2vg+nURU/wASd/X/AJcYNuRr4R9+9w9L7bhy1kuv8g5o+03O6JcPp6xRkAnG/wCUiZtMZ1j0mKTwP37+Qep9fRgwl3JkYyK5JvdHGQnffEdG7qtV1py6C+vRv537lh9T04sd4KwZOcuqLnJmxY6n1OUjOFJlkmMVBQpWH65DDX54d6r10Y7awRzbkclnxyRNUbKpcjtiZPkmr1O/tuda/TfhR6unSVJDmBcAJ3JE4zk68X4qo+r0hERIK2Ml3O0zONO9e+nn05ebNO5k5Bl1czKY621d5Gq2zGN6Zi9bJ397f8P+8+m97/4V9V7V6bJL6r3L/jb1f8M9W/JEZZ9V7J/IveK9J6HH6WZo9QV6X3P2n1NRlG/jpdIzjfz1xenr1meb9V16jFduSMOGorkGHnJ/UxQy93GPT8ZOSsj1Ke4f8afz2f4z6rF/Hc3r8ft/p/Werxet9tgeMPpPdpkw4pzZS8JGL1uGcPp826ifnxemq+bj5PzP+sf08/G/DUf2/wAfR6tHWGS6SLhZJcbIan4Pq+jrE1A+iqmqkEkXICY7Xz9dfP3uOP3HH7jk9LPyel9RjvJhyzTXRmjPZmmzrnHknL1NTQG/FjP51PtOH+V44j4fV8d5ceQyubEwOTbJV/FbQm3j6yzq5Xz+em/8lfwbL7t/Icnvvsuf0sx7xrJ6/B6nJGGfSeuR+bPJifOPNlx/If46zF7tmmypH+J/8Z+i9xv0/pvXf8hntXqMtY/TQR7Rmz+3T6jJl+OIzZ59Z6eiJ+1uQ9NX1mgg+tfno0/E9Kn4SjqdSqsAUSBRVV6fSBikbqSVrGro9T+7UAyPV8pFQDSUmB4IPBsLPsnoMpeDH671b7l7r6uIxej9IXdRfrrzfHi+Opy6Ms5Erqpx8p2RIxzW/wCY/Uek9t9Ji9nx+px+oPZfa8Xp8mWPUVlhzkXfrDHkIIyzk9bkows8XURkeZyN/nXfyb3L0P8AxH7v7h/DvUeg5/keHBgfTfybPmv1Z6j0PqPT4TB6z2a8tYr9P6T1pzno+PJk5x1E03E4355/nPuuX3S/Selx20e5XPqKyTi0PpfIU1e+qyZayVetl/bldtfmPw5q69dHxFIP9gUk9KoAH1moXj/FG0WcHXRXX/b6ddAI9cCqVANIXkloBFW1ufZfSf8Ai/8AD3u/uWSnHXuf8u9jM+PTNvpKwesz4qF18eIKplKoba4jjY/UH/FfvuX/AI+/kf8AFv5b6n0mb1P8Y9x9J6T2L+Ze0x8dY/ef4v7jEz6zDmkxXDeKn5/S1k84vV+mw5MdyqPlH8p9ry+l/wCPP5z7Ph4xx/Gf5B/BN4tI3GP2jL6GlhjGEvqBqmPgn73sq0fz2n/jT2fD/Kv4J6X01vz5fSYOs2TRXqfgfS4j4sMX8seojHWWWgJw9BWSyp3PJ8d1Kep8J1x1g+nV1TRUdhX06DSRsaWDSQYUNPWvRo+ekD1CodILk0meMzuLC+tn/wA7f8Wf/mq/l+P37+NfP6n/AI9/kXqZ9d7T6kw1Xp/TT60PWYcU5PT0elyenyYblw5MWUBj1XpzXxJ+c/7Z6DH6rHHqcXq69Lk9b6bLkmbcOX02TRVf+H8ZkP8AFk0Z8Yw0zeUxz16jHJ9sf8Zel9J/yR/x37x/w/8Ayr/zvX+p9hfUZ/bPV5PUYb9Vm9lwxOKPSekwZS4t9NkYvFkw6mLbMuWbwl5vmz13/G/v3/Hnu/q/4t7tizeq9KZ8p7F7tWOsGP1OC4l9P6evU5mZ9P6nHDHqPikr4qCyaM2LJk8H+n/1kdT+5/Tvi+oB8Z8GqKK7D4jo/wCHUDvV6SCftt0V9BV09SkE0VXA/wAKogSIupXEAa+fv5J7Qem/w+qxR6vF6ih9LVs5HihcWWM5MGDLjJtcfjir6DumFHtn/Iv8k/jeCvbs9v8AKv4vGUuv4377kc2B1j4YjHkDb8E84/U4vj9bgtx5PT+pjn476r+Z+m9V6cl9Vh6jLaRlMzcGEnNjw048UVEzj1lcplJqqG6ZyVbHkHuMTklshlxXGK8fTOSWeiq4rqgnzMW+YPGQ+u5+l6fT6PxXSp/u001iBTUrEouk3B2WPGuQk0VFEjEEwGLghfkQD311XvPpv49/JI9T7r/CD1OBMeTN6/8AhPuPrL9V7x6C8kbzZPZMtY4/+nftWCrrH8WaP/pp6IH549VDXrI8e9Xc4H5fS2+myXMfJgWPizvR0cR0mSqJDClBKR1zy3d9xx+p9L6mfcPbqyek9f6bLGWPVYa1WLJLV/KZAWcs1ruzzACtxTJS939xxfyXHl9ycWL0vvvptHunpvTY8mDB6344F9zridYc+TLfXrEkxtpnZ/zNPX8PRV0flNR6nTBVJqPz0NIVE3GznffWFdbBZFNQsbAgLssnGe+q2b3HJnAvzjKnAlb5anYNxdLLBXxj9TGVVJceCvnyLnmmftGCWsYOKS4eicabadTqYqlHfjxGud9Z6n/x4PVk9c7xZp6RxeoJuqyUxtqDYV3pA/aE1+IPeMjEszzjmfhdlvO/NUKqz9tNyb09M3UtfnbTQSTAAGH5CsIxz3nmNdQcxEGdj9IzJuba2uf1uRG81M8Mo3EuNjxF0yV8t9y8/bbXGR00w1z+b1a1ZPWqzOmnSU0sTUskuM03p3rqTe+5/Fep9ZOVMeGvj4KoqhlySQBP3q9tX1p8do1VHMP5qvUVNVKovxw7BmW4HUqbaujfVB5R87Z/NKaFgd9pCyeYAhFRqaqrgkk3v2WFbiCPOp9R674fjrGm3iLEWS2upq6GZqE3MSlf7Ngn5qr9VVtLDx8lFMhvp0lqr0E7+/U7A2Um0s/yW7qkm8k7nVO5r9NqV5EoK8JI/wDba08lx6eOzhiWd4x6NSFFO9BVJpo6Za68H61Qy32sAvy2I2sXqCfsFxA7/Rc7at3ka4ag8RjKnRXW1oyNta2Hjrep62/Yvoz0uQqaJP8ANDWLrwRNy19qNScEvUrv7NT4KmdN/wDTCzhIxrFRpA/t5rS0pUbdB+v9annbssX8g9QnF4seSMfX9pvxf0Oo8qLp8gRulJLXaj+bRbm/+9T6gTN9gg7KfOb/AFA3A3jauF5hr9VLIn12rdOTY1Km9PnVR+GVVFVqfqVuQiKqUga+1Uv7San7U8y65lQmD/206miZxz+mKSSA6J5NlCzvyVRqqD8POhEyslc41fLLJNUlWfu6APG5qX7fsJ+0pzVzvfvxDREONtaAZCEe1t3EAzhEORqMmWbAuLfiyQQz0Kgzv/7qfAL3H9RCuVRqrRrkyNVNRQlUFTUzF2oPLLuaB19opZp/MipZjLOP/qYubEqckyPnme50+DJT1JtO9L+BkyXxLUJPMRXx5HbFPXys688M7ilmVSpgVBPN4D7H0pvgqzSthC2LbYVO07jTZ6et18nyUI6KvH3o6rKcTLOqjnf13VBtd52Ubqpx1FROniduN+y+arqh8DroEohTS6q65NvU8zMAyXLxrsKfO6mp3zJpHxtVXIVP7yZGB5lDHPiA0Y1+z5JKNtf/AGiZ/GzTaTY4du7KsNsLSahPJfj/AGI3BGrGRqoVguS8ccG/sgztnVVzU/71Mz/ZE2/i5nFlHU5IuTzFSSbxuuijyvVMk19l+tO/uFj3DW7K6iqJqumBAmZ+06v9edpJahI7/J+Zgp3O8mo601c0zJzkvR9JkS+t/wCv3BOkxnukODt4y99DPvxgAbz9RaC9TNkV182S6tNbmPjx3YcU9RMynKWxHY7ds1yM6CjnNxuqyrdY+eSPvzQKNKkmiXqv0U0ZhuQ1Rj2bxFMoOTrc23dB3yu7Bdmq2n2CiIzHlSt2zWpKurP/AF1H1kyckzNT5la1udqspCjMiaWPbkbqNPFk3adpdthdE3G0Z5hma3McfHU0SEMLr/IzTu3U6fBUjvwbkj47Jp8BZy7jyblcXNNM9K6h1TtAK+34qLK9Pk3/AGckHV+ckn+M+s+BjHt0h4a0EvX5LLbVjBXydVWpn5Mcapshi2qd763JW3wTJX4gvUCBcC2JEHLgbSQyQNQIMcNkuRsQ1YMXkPTryblUIFMNFxS9UcGWhaCftRLps1ZU7OkPkHU8c/rFks8VkyVoafl1TOnW5526lPq/k0mloLKrU5INpNHEzbWkrqGqtCjXlo3tNFXzLRJxNK7PlMdHjqxcjejnwTUfR62flqLLhTgG1r4bG+tM55giIssC0PyCtPx5d9PMGTkwy1HMW7ma0Lv5BZCuf2JsY+0k46yZKydVjoyMUhK343j3TP119pnFyunjyaUr8n/XR4dQcTksna0eaZoqZQAfGpJ1SWRrHrW8ktFA9f4mknXyV/qXfU6R+ta8r+DgMQOIEfVYKOzzosAUI5j91hNTkPU5Zw/SS8a1kh1BE43wo5K1VTfXSpre61RutMwptRjc46nRIN3Ot6WUp5fNk/b7eNbRM46ooaSPkbFqHoGf0vkHYQYzloZhm6PzIq5t5OA6aqrf83PHXMVz/YFUf0sGvtH4vUiCkLF+DZwBM/KtraBvmeE5AIGB43MybVzgqoRoCoWySg1yONivqzP7+qoLIbJQayk76ZovxF+L1FaYprf1Yd1SG+a714fyJy4aNOGU6LgA11PLMpuyUdT5+xr7UBOT8Oy74CJx8TN6K1jpnod7n7VbXjUzs2z+vyici7kIE/43UQCQSPw3mNSPUCCBFmu3CJxi61hkx1kMdVNf5GtR/wCvsTXy1vlL27rn7IbAQVZHGbeBfmGanwJSGnIkoaFOPM8s1pnZkSTncrkGZlrJuFBaKJmdHNASn3ogaB4SvzKv+85jdfIhknHIHQzPyU7+r9rlDrUuwsrYJEwWQEjadzn9UxpgJbN4vEQ5zzxrFyZOjJB8g09aASYG213VD++5CamZElO6LaDWotpbK03USi9ZMg+Pj5ValTxQI7IvmOLHezXQr/YK7bHYbNPXnmfqceGIv/PLP7ub+QyP0X63wg8K/YiSnlE8b/KKW5Y2GQjbif8AerGBaZK7QAEUzGbvWY7ZqjfT8jz0FV2s6rtCGek0/wChQ81pEaurKxtV3WK7Ieoa0knaHxm6R0M0n6evyJdtIHVRclb+PnUQk+RNvNTLPmnqWtGvwp+NZK63or5Hb20THx01W7m0r7RP2HhaoFGSvGBxHPh/kTbn0jvYngcEHtZajrvCwJjpqMd0/QpRN6nparbGSVgdUUOxAv4sLMkcLRUfaNDdM6unyT5OdP8A8h+9jJccYaQot0M8Cqx9dSvXxlSPTPf11dbIZX4yR4TFlxg5DJZu5l+2iuoa34/UsjU0CTdyVAvUgGMZQ28odwNZk8WxfaMlYQOR5djzfHMqbuGcZTNU6AUppNyca2eNfRBNsF3U1pickajJOR1V8V1ZMOz4/MzJLNdOthXSXO8pqYoI+qgSVDtd2i5E8FaXpqH7aPwSZvIdx9Ymq3qsc3UVtDQ9NwE68dTKbWRKDIASkACIEbc8bZOgXDkFSgwRfuFBsNtCkVlqaOjrfXmJ34DHqx11SSa5HkjxYbjLw3DFxLqZ2aDh3zjp2q19JNgXGjy6UnFurKubLfk19eyNH0atOjoJqHw7KLl/Eh40bSa39n7HIPxMvlBGDmZ3W5DryAGCBuwgLgfypkX1QEvB27pQNuVDZFnY8dx01OxvRod4ylI3VGuZZdpOv/xPhseaxMFcamPu1KXcc6n7ef1eg1pNRLO3dUyZGMWTfVa51XVsTqWSt6ReXVqnPKjqtzBjuZ3VBPN+WZSOYGOb0kbReUa8geZfy6Srdr2tJbU+/iaB45L2i2YQDsZ409hm0nwUZFHodgTPHybE15l8XrxRPn8TUldAkMc26I/y1JLcMHyZGkvVm9VzMVvZYbk772Vsqjb/AGVZjmy6b07QNTVbBevIvFROe3/TN7KWccuw/wASEm+eeUrU/aXyeETSUB/MRHaAZ2kaUdmjkxAui+ESW9OnKzPjU084IWNbsZ812vAedNHXipXkKubu5JDzWonJciFZG/LbvTLqiq4kGef0qRFC3dyFTkxYhMY70T8nQu13I1k1tJro3rp9VDNbmX6vVLM9pQOVaFpnr6Jpf6v25asIw5wBgO/FmP8A49zBCPjglWxZkcP30MZMt3WTJcTUdk7/AFOOalTGXquulj69fUejbQoyt9Jz3jpnjJa4vjatiIyp+pfK6lnb1NeEGFVlbmit4x0z9NzBoKp3Wrp2ed0fVOvv+LyfGcbP8mpdbTm9yQZskg0P33MybNB/Xr8ZLHD7t+7gsD2SkhIjvAORl94QVjL0ycjVOPJJ8ny1XbKeRmdZLvRz5+lE+E19cgV+Kv4yNI0/Jq6PoeWaGqdeH7V1BLMyPJ4fwpvV1Vc05CybSqSdRZRk3pxz58+UP11WtNxbvpOIWUpuXd1TO7xzb9lane668aCvr+UA/SHPMwCPLuXusEnVgSR5hIHKhxtYC99Km6mt64Rx4FPrLXhm91XPLx9q5fsaJoKr8tDjxRNU6SZl6nt6a0JQcyUzWjRckt4wZmfxGLH31a/9y7p18hM89zvI6cceZNeFlk5P0+EK5vG7KZmqgZuyxxt1k1ts3Jl8bOhIqGrdIMQIatuFtuIJwL6r0ruFsAbAXe6wVk6Y6/rUw1GPjmpeb1qVmrZXJ9q5uT7c9H+xW66ZbqbLjWz44YnkWF20O56jp7lkNeH8hvNY60cp2N7/AF9snihvSpJ4JuZ4yIVHQZZgxVdpb/7Cp8uO70cFDjk1RJc/tZaihJ1bshYAzAUWc+6hbBSTAcoekxCAceqWQpSA+YBiG/IqGOPkZ+OMmoycv2ftEgjWpavIkkK0jO/xuRcmIyh5nmebebLka1kmBa5a3NuxvXTT1+VsD01wkDFTeTZV1d1LqtNJM9wXT41Gk6Wm1kfixHmRZxw1jNEltaq7KJ3Qap55dtkjv8qk+qSAsDYwh+p8h6KILvsIDQF2RYR3sb6VTDm+W82mZ0ysENFD8bMp1uNNBRS+NPTrMdY+8k1ZAlcVUkj9o5hLrriqHknUz+hlZFcY8borH/8AGaN0cE9acW2f1v8A6m9pyI6/CmMdXV3jZI+SpWtPnmzoyCmOqPEvnYDtD8YBChE1cjZrOwxL51dAqKi5JUssiQiHI/yKYNkNO7yR8cSBd6lX677Yku8jo65Lkamprz9dan8DJ2SZKxOp6xvLUmTnSXSS72br5Op0m6lf1lZMW+ZotmW3/wC58wxOS768zXgDwv02KKBeVa5y0rl27MjOKK1a/ZPBzU88vNDo5Vb9WBOARO0G93bHCA1YJBFmlBhoBXIZCfhAfi1axZKkyrPa1oSaaxVvG7i9SVEOzX6qujxVp+Ua+OqcbNJ87zemft2TxVWjrzX2jWta0M9fj6x61qijLffYiaoHjLYyEtHGuQB1qpUGcTDiqmRcfOmf+1AxexQ7oTtSiIp+2z8C6gISQd4IFvH1xOm2A5nmzExZbk+707CeK+vNTNQivfG4fqZDTMDqa0KalkoVH5MLV47L33r5WWRrUR8eSqStdU9MB0jIHJspy1c0MaTW3fNXUz/l6+Ttvc/WdzrIyTc78ivVTWWIvFMiXO5xkT1Vw7a2L3J4r9lMm6queWxCwFjGfrF5GXqmAGOAvtdYLUm40zLeFrHj1NU6h0aieUiCldXNL9qnmaQkR2fhzM21NNA05Onmcc7J+mzlqGnW9eeWfD5/KkxUzjvIdzGSZvJP/c2ebUch5x+aQA0hT5bNVO98njRIG4qQj6ZEkpZoro/SSF6DaCZIsljG0cIbmHI0qD6gy4gNSCBNguwjMwdDrHkeUu3pyHMs/wCMJ6hrL55Nu7OSgBCpi1dTJsm5xlc5xajRi27icjIukOSA/wB8rTWsctw5MYMMvx/Lpa5ZDStT1jCaWkNuxnw7RX32UU+XL146Mc4xIrJLRwiSMGp/0aBEYsAx4EK3+snAemSMXZHiLXsU4IT8uM8zumZGOI/9X1pLN1rr63e5Zpnei+tI/ICc1VrtyaoqVWO9VM1c6OJRnxNapU6+0yz4MeurryazxdVFY6/XENUNWIb1SzUvIzo/CzXER06ZqTHGJmaekllOa0S1v/sUA8fe38X+JwhB4znLXgggX0puflA3xZGYa7yCDfVfHb8lVsWq8MzzJkyYzfdCRcp1P+w8nJ0o7LNZeJyUTMyWSfXHk1LOnoqrbHz/ANKjwV0lTVxYs+N8mO9k/GyTWmgmYL3MUSG+Zl+qc00UF5GJmvllqYiqlSqfLd1i3GgNaDRG/wBmt0SHkMXUjAx3541AFS7SWmIpQmPqBYaXM5JMtJ56eQBychLPlJ4xUzo0aJdMh+lzXxC9x1kqb3WugaGZpYdcM7s5r97TQI/CXR0rkWW8e97JCfq1kmTrZRzRt1xUjrdfJb2Ilf436knANeDGqjVFbNHT50MuiakA9iI7m6IuL8HRUAtmyFE4KMiGAI9JYLE6bd1RGOsa45uJq4Pu/XXer6Kmt0OTmGvpEpQdHCTzrTLMR+u/OijUhrEoS1+uZRoqVBJQVLHnk5a5SipuQtej5XpB/bNfQh+ouhF6N6ZLqcvFOPr+3xJpGPLBp6arxLdzCJa37ZdmJWAuJ00CKfVBF5soQz7Mk/5LTMN18bVT/XJw3UvU3xIbu3bjjTq9KG1Oy/yzjyV/l09DVRvknLqqnqZ65hiGvATUdmgXYVcN7+lQfWeCamIKsrk6K20114rRVWedcrTucts8zOGGG6/6ua/Kmlpop5AKiaIqedm/zl6oMHgBXkI4iPzkHSlDfZ3EE2tJj8VVizm5VYojuY6mCPPJNNa7oV7iisdU2zRLJ3t5EcNWYvjyk0cj1cO4yWdY5k1X12BiNHNMiltflOa/x3OplcmKCK6oCtUnmZCJvHopBDfg+63cWAyZP/g33MjBj5K/9MMrWsngmTX/AMGkPzgrqBJhAC7y5vsP9aCzCgC8NwDuYEv0liUhrcYBX6k6MOvPgrlWck4621XimbXW+0nwP5ufYvmzZ/d//GLfU/8A3ve71GSGsfGS/TRjpnyvVGS4wzG8lZVxlbZ/NFOTMzNA8HOCpkeqnwddNS8jLIB/9q43Ovy/mqsfsXuHq/TUz6ifc/aPSZMmAyRcYav1OXGRcT1/kzelxRkgoKmLii/q/nl/Fn5AMFU2zCHNjsfGl6gC5BAkbpAiQAYF8BCNdF7ZeD2b0HrceX0+f3L+QZ/4r6s+EqsmP0foPXZZqysxWPNi9Zh9It5MeSXHEtzkxsYTfN+4+lxuH2TN6HrJh9NE4PUYbLmvnw+4Q1jyOGbMsTDG8mqr/NjyHyY8mSp6lzei/j/uf8wjP61909zx+0ZfSemr4MXqcUZPcsfo/Te7XWWmoX2rDl9TGNwt4zLNXi3UGKtB6vB6H27H7J6b02bJeD1/s8+s9VrM3GD1t+pyT1OSKn5KMWPDXPxYsmJpZx6x9Pn9NGqoIj1KpkEhij8Mq2OY40oJNICCAcO4QwPU8QhvoPU16DB7j7p6X2/JD6L0fuGePT1bNRMc9TjifmyhO6JiuqjIAKWFNbPk7wnIJFEMHMzVxN7rJFFsgID+nn7/AEBW+r9D6X0WX0d4qo9R6z2o9z9bhckGLHd+t9UennWPd383p+ctbiam8hLzjnEOszzePTNXc275i6yM48m5ZV1Gp1/S5aCvqA1M9/RNNVFIBMBEFyWvr6eJyrUIuAYpAtxYwEFfgaVWW5K0Tlm8jI3tMc2Ew/JVxsxuwJGIfslP1rXZCc86izDlwoedjZOvkh1qqiq5C9jQJQba/LOTI7JNFMmPqEnHO9E01CweHzWvp1L9d0/lPJTi55slPrkqce9MnXdPkV0yvK8ytQeN9NAlmbflvvLuLYsGy83zGHiyWCvl0eXFPF/aZ6GnqjacDOpZfrqp+MKXr9VPW/zXZsrxPRNwER9arGftJ+RudqwNPkQ4dWlDbq9Yce7l8y9cOSuOfM5nX1Io2yjJP9jYUV74rWmQMc78kFfp6IS9+FYURsdA8NdlNItm49hBxEPOszLTf6J/exRwY0nJeTJ4JBLxgcdTldUPQK7s/T4io/t/qaTUYpOueKv/ACzZUVLS/wD6vWw2tGifNdP62QjJchHX1yfona1UfSXbkWSeCemWdGx8Kn4qi6y+o3u/tSFfXL1NY9Er9SSlWZ+s3T8eut1aCavj2v2SUDNtZhhbwF2IXNI86ZOX4cMH1neg8lLeQ0Llp0hUu6/YJM7T8zLkyHx8TKHBkoF2U/IWvfOzzV5uSZKK0/Ya30FF2IZeVGiZ2OLyVj3tKY2+a7WUkoZf7A9FfaarXc4mQZm2mfD+gF3utKp+BT9KUFeF/D47aJhi8ZMIFLj+TqzN8Kk7Mj9e9rHyBx/kK4gEeYOtb7glNt42UUdrZt61LOW60f5B/q8609PjQJr812M7mXG8qEO/FW+aWZrqa61zNPj7cPJ9h8L8OOqh31GOqnQ73NfKzld/vfkZpnmeWpWg8xHB28E4B5tpsbWAJQvZ2tnjcA62OLcVFTKtZAZo+oVp3VSkyeLkvzUCuvj6G/iZrLuZ0hci1jpqh1v7f9Sfrj5ksoJP1VGsHklx1L9Zl2FSfpM10eR2dPQHQiJom9jnKzJlz1bzFeGJxo/2K0zWRqJFAOmWQlZPzz+sJIZavn/EzDzEjyILpPgIC0x6bQfHc66T0fyTJ8Uk0YK6+LeJJG5+SYooq7dHfMzqmsngYdx6cxYsVI891FY3Y8tFROKrnWOOVrY7fFUVuWXnfSWVO8hxM46hcnVTkudDNRurQlC4A7gCkJR6P0r8sLaGOJcOPGQXfZK/IY/syXVOn7czeSA87/PD+JCCiqzEcCJ8h/WNbUG2agREMJEicHiDa2um9uzPXmW9ZJxkE0pQhjsyKy6ZrdkdG982yl+gelnCTNXjrLfU5ZZqShUaxLzckY0qsg11MkXVDrXF+347mH5cXVOVicmqfpQmH/KseQnbWkZex+SUntvbAi/8PGTMy1WSjHrFTyGLHM0f5KuSZ0bu6d6m5H5v4s3CISEEKEgiu3mNdPTAgSAUkALeI9txr6Y/4B/hv8c/nX8+9D7Z/L/U+px/w32r2X+TfzL+XYfQ+pjB7j63+N/xD+P+v/kXuPsXtWWpMXp/Xe8HocHtfp7yRcYPUevjMIYzjsv5X/Mvd/5X7Tl/5l93xek/jn8mzf8AMl+1eyes/insHqPbvXT7L/FfYPYvdJ9j9q9Tg9RPor9v/itf/e56H0fo8J/5BOSPS16qq/8ACx4uZ/4svD/Df4L/ADb/AJR9f6Cfdf8AyMfqP+Jv437J6rBM+2+4+5fyj2P1Xrv5X71631V5cd4/S+wfxj0h6QfReqj18e6fyb2j1HxZPR+l9ZP52/8Ay37n7vnjD7Ni/iFfxP8A48/iP/G3/FHv38d9lg9F6b0vsvt3/IH8e9t929+/lefHh9T6n1frfe/5d7t6v09ZPesmb1/r82L2z2T0nqcmfF6X0hj/AD346urq/wBTqBp9dFNJ6dNRkU00gHqikCavXVX0gYXy8PXt9Okjog7mnchr5Xc29XaCtcz/AMk+7+y+u9q/5c9k9X6T0/8AE/5B/H/+ZcX80/i3tGX0nrfacvuHsn8kPWexe9+3e3+z3NTh/wDE9N/96Xu9x8+LIeimP/Iwv/jemH5x9VEpz32+c1JlJi8FTO8JIqfYkqZXGpqKoZT6L/5j9h9s/m3/AD36Epj13rv5P/xL/BP5P7d6v231Ne7R7h/Jn/iD2P3PL6zBmxZKx36LJ672fN6TOMnqcOafUGaJ9XjKyfO+SJYPvW4qYy7v61RDeXHLurCumZF+NxhMy6rv0/6Waafh6R6qx1K6aOtVQZ9DHoIBIzVQW2ZJ1x/EBEkICmohiRXMQUNgO1nOub+Cqz5PUYc53WLnLLQ11LuecccQ1PcNQ212pReP1HRUnjLWSHNMXjylDTQ3jxylDNy1xUrrHNE2FCjzTvsvpYISKmPDl47kkwV18kbZlR14weZ3VxO2jjQ5vTZO5yzk66Jx1FEkTBSw5LibWqmSbnqaVqcg46H89QS3lJiSl2vZPPcnlJqBQQIgcpEbMKD7p6vYbx/EVHOzEDKvmf8AeSJt/txQ41emtxRJw1tP4f7R6r+W/wAx/jP8S9PZGT+SfyL2n2GLcaXjn3L3DD6RyY43VThxmVyVxFM3CTKzXOhsuJ1wVjtln4tzETkmiIuynUzZ1WPTxW73kI1Pqf8AwFdx/wA3/wDFN1nfTXh/nP8AHoMrApc+sw8ZO8jxk+9yU9TeXHVypVY6eX4+s9L4H4rqUD56ehXVTaPlKK48lXN9OgA9SkY9VDIgKNoWA83Wv6Uf4t/K/Y/4F7J6b+Ie1+v9J6DD7L7Z6L03oDL6LFjw+l9L7antuSPSVxhx+o9Xn9MxWfBeLVuSMNRhgx1n/Ef/AJi/5Lv33+UfyH1ODF3Hy+5+nq/VevznrPn9B7jlyYPUZ/RZw9Pj9RPzY/R+nwkx6fHl36eZxRiz48vvP/K3/MR7F/KvRmL4s3/h+45/S5JPV+o9Feb1uX18ZH19FbPT5ZZ5wepycyXizYrxwMk/nh/yH7/k9T7z67Jk9XnyV673T1N+uYw4sBl/8ish/wCFhz3MTmw5sNmTG/aMreWs3xVOPHf5z/6K/wDTx6PxvV+O+IpNVXxKrBMs+p1SbN91LJ17PxnxIFAoECkogKwFK/Qld9fOf84zzl9X6j45M2HJ6m8mGziKozFXOH1Fz1j7/q6/xVF5Ouqqh/PKvT/I5rJGWstYydNUFrpnwY5xdzqWpSPuJxufzvP5QGD1fq8E2kXeQkdx8cJcRF/HTHeOcaGNBmHuqI1Jw9Wek9OBeL571qhbzSOmVzL1Ji4d7kRXJUMGMP3foUCnp0Fn0+kU7bWO/wCb18z1Wa/UWrkE2SBHa3OXGt16j1/ovYcGLHj3l9dQxVJDGMYmt/JhvfxuWatiinJI3c/FzM8LbXqc+b1GZ05OspV0jTutaWNzH23Iedjuq/q2HHGS2sktE5OytlNb5/xvy66KqnrgnqtyffR+azP6vNlfj+NOLcRMFH/a/ADdOLxwScyHjj6u+ukAU2JZFryAEDbLOAJu9RUYAIFMAoSt7WH6zjX1P/xn7bX8x/4+/wCS/wCR+4e6ZsU/8Ze1fxLP6cn07nze6eo/kv8AIMXsfpfb/VZpyYb9NGDBHrPVTkC6pwf+K6+Wrjhcvv2H2a+8nM3kZymJ67J+1Y/iyY2oxfGTZFO9bFElme2/+hir1Pv2T/lT/iObxHu3/Kv8Bw4P4d6fNrHHrP5x/B/fPQfzH2L2mMhMles979B7d757J7bhEc3uvrvRenWKzdvm3vP8d9Nn9Lmwev8Am9u9b6bNfpPUx62aj1vpfX4ucGT0OX0txlzSxlyGOu8WOjLNYU7AnzPh6x1fivjvhuqgKa6KulSbf2a+nQGrl9X+4H/2yxGug1VVdLpV0AGpEGE6hVbuKUHm+u7/APohM/rP5t/N/wDjXD6TFmv1/wDIP4t7B6PDJm+dp9fncXpVqWqMeObq8fWTJeLHM5Z3+zyJ9R6T3D/kqfSelms3tvtvuPo/Y/bo3dzk9J6DNh9DHqVpiZfVMZPU5Kn/ALZrpEbj89B/juH3P0P/ACH6fF79vF63/jT+L/yKfi09emv+Pex+5ZfTuS6jsf8A6YZsEF3ihmomtysfnn3/ABR6D/yf5x7FO5xt+8+hyZKv46yVNeu9O5YkuEpdPMoNpkmtr9un4fpD4T4erpCaOl0KiLIesmoIw0APHK1hXUT1BVUP/qdQGoGUKfTiBcl2mDnX2dk9DH8j/lv/ANER/CyivVe7e1+5eq9nwzix+ocvr/4j630XuuL0uCysmXJWX0mD1hERLkQmbvFNdus/+h0/kWHD8fofUzr03pfcNe4YarWK/aMmGMPrrqXJGT4yCczjmoxfWXKbkn85/B/JM/8AFv8An3+R/wAqv0+eMfs//JHqv/phGHeDLm9s9b6vN6P1uHJikqoM3pqqbaZjlxyS+ZNv7t7Dj/4i/wCbvdvY82Nr2D3nHHvXsTc5MePL7T/IfT4/U+hftOCWcM5Zw5axx/h9T6W8sFOOj88TqD+70er8Mf8A+I+F6fW6TEmvpU001rsP7ZE23nXoUv1UViPT1PRH/El0knGxxg6+/wD/AIf/AI37x/Gf+SM2KP8AyMn8ezL6/wBt9ZN4ceL1/ovcvW+nwYoy3WLHD7fmww4fVx6H1OVjmcmCH005Zx9h/wA3+nPSenyGf272vBj9T6i59twYvWeq9V6Iy5XL6X0PuOP3AfT4vQ/EYsvpfTmQn1F4n0lGNv5Lh3/EnvsX7RPpKxY/cfcPZvSeon2z1nqc1YfU4Paf/FZv1Pt3uDc3V+k9ZhMmHBjw1uLv0dRdZss/nj//ADL/AD/2nJm9y9u9qxx6bFgyYa9yrH7hnzf+bft05o9V6+fQ+uwXuPU+ozVWGUfU5MO/bZv0XpfT9ZvyIdP4zr/+oQf7dToFPSJBQrAgEm4jKlXjXtD0D4dVEAFkTIsJPcNO/fXyh/yF6PD6f1frb9PWSfSpkm/WeowZ7fV+uy+q9XHpgkc3p64Zzk+r9NV4YYgwSZJz8/M/uvuMTf8AjceI7MNzMZMc1lZqMmSsYpGJa1TFfZnyEHP56/7t/L83uHovcI9391r1/rPV5Zxx6rJ6THF+348GEv03pPTZeprHblNerx4o6x1OfOlGabzeD+/+puckA4/PxtfFj5m6vqp9RVbSM2Qm0HnLNX1c+WZ/Z/6T0+rT0aOn1GSArMEKmxi2PudeD8TUAQaLEMgIgmAMgRAN1trH1PcVCEpjuftLM3zzpmKrTkV3NBy15lK2fnH+r9Rl9r9xx+6+hm8l47Z9bGpmfV+iyC58FGOEdxTFZCgijHxSPLsJ9T6d3E5NVTVL5geok4u9tbfJRGxZTZRNmr9wIuJxqGTX2DNU3WJnVSmhb1jZBAfDrrHVns9OkUmqk2hygAV9MSiN9cXUqYcEg0kZASzz+Wg92PT+nzxl9Nkmvbfcsc5PTs4yd489I4tlfE5fS1Pw0C0MujX1OA9RZ6TNfp1bS3EWOpvHemapUEuKdsiOp1rln86j0WQy4vU+w5Jpfkzev9ou1onKS1n9KFS/X1MR1Bjl6zY1WV3+cx7rh1GD1Dpefgy1RsGZlxNWa5f2Inc6VKKn866AmLkRmAgR/tm02GsamQwAA/AfpYwjz4K1OO6qVqfGOakZQqpJNaa+zOnXWtv1l8ztXV3OKKiyseRkqdduOgxPmupY1MqmtRKaEfxXpj5MbwssaaW+asmY3AUNV9vDJz43CKRayfq3HX9baR14iOfIWEDP6nmXQKb686gcWROWIgBfxyZ1Ia4s3OPz2GkZ8jhN2RKnxn2Mm2SdQtUvW9avS19J6rL9p571OS7RrYzrHv68dBqXVG2dLNO/P/2t7/Lfqsplyj1kQWvtRBK7Jl265yCagAV8D1+a7I/1f2OoTXTOv09VoURNeU068m1gHPHyxhe3aMWFpqM97zJSs/MBLC0qngJu90gbNa1W+d2+OT9BOlNqdfmQzrbVDEr/AKKr6+GaWml3+w86/wBOn8N5rRr9120p5/QS9G9eXXIC6k3Xn8EHpuDT9r3X+xnVT5/cP63MR0j4/b+AGEvptPqta9hunrMMkR/8p4uZxiBcQddFjnKAVO9Rub2V9aDUt15oUeGSSq+o9UqF5vjvCSO6oG1vQKS/ZqBV7nGzy6deOXcQ0Rpiu5sLrem5+koVeqd06EkNhPM19qi5akr40fpj+unsXZkaaaJ8AVrxP9jR0/XAxmwTTxeOB7eNbvZ2GLH/AH5teGDmuD/1OMOcYz3MnnS6l1pO5b8u5omNdR+OJxs/VPEmaaGRToSVF2eQ5DTzwc9CFdvG7xzNnGLzDouTZm6p7nyIUxvY/wB3f4mK56k+zlx3e5DY2Bz2BPiug/7DrXmk/G/Tn1ZwFMAL35EzpmQpRHbbs77Bu7A1HyY/nKI8P12eMN02VI0u0Z/3L0OjyePyK+F2E/8A2TYz+i/Gj5HX+PrbuJnmp/0GzJwxUd74N9JSW/KT/wBo4dRX00mth4JNIWKVMlZMkJKxug+SSeZ70k/Xx4/bpdvXlTOwLRslbiIu/tpCbDbYlD+bTk6PHJWZyXQVI8jSQ6qT4z6hUaJ8LU20mvJJmXJJ6jXi5uNeYr44tSPlFrwePCeUamSudM824pyGqk1uY0VRMdX825b3X1SdOjkpr5REiY5KWRpmRd3eKWpY3azUs1L1Kb6VqUNfk1Eje1wWxEYvYJ/TR4dt+IOxjczC1YIuvsQZqbEqa/8Aqp+m6PHjTuPj/SbVoPwm5wztj/26Rqa6x1TOq6CCZKLSZ6SZ2Hf1QMceNNSUmVtuRY62ypoPJ4mV8lcsiay8ssm/FHxmvjrTW2zIb2F63XVG6ejzJtuEZk25tOFbxeWy9+bQnYg42k4vLOlsRXBVyGjLuQkyMOwpd9Xe53oRStc1P4+ciWVFLrEGl+mgnqQp6rejRND+x1NOw6icU1NStMhuZb+VJrdu/pJUs6r/AO3z1PhH46q6Hdv2yivBUVsZ+Txsvx8ZIFbCer+34hB2aZ2I/LJHtcHQIN43CwguVcidxF5a+R3cZMmq/wBEzDM6/U0rMUbGzW3mTSNJTCT8hrgoJ+29TWmZLkWK6A+OZQaPsr5XXZrVcs4zmuqlsl8R0vSiEugLkmZdu0amA2tFXWPy3M1BXkl5TmN/V8K8iGjn8ponBQ+31Vx7PdPtbg7HIwkBcbnTMXxElc5ayOQHo5YrcoRlFAan9V9tzW2Zkfxl82Bl6x8VMi+Me9hqumKe9+eTVoQk1p/FTfx4olWbMw5LmKBUP/brW+vIpKcb2T1pNucgv2CaiNChvlCr03Xho561rzNb5K/EKgQof0Ni+TjuruKkDuBaZgNieMDuGdZWPDQbx2/aZihZeth5KmtY/Idbx6mDeyPLMarU1FRQo38nngAN9SO0WSwS2iPDqvxdUGlYpJiF5WPtpnLV+Veh2jvcrpl3+Cbmh20uPq2+KnmeZvGFVVQalCNCHRt/0wQathmyNnIBjk4OMr28FbXUyD/lvIV2S4DNTOGtV+thoqvHM1LB8alHQPgf1wbKM2OMWjRkmyJ8bubJjiT9pEp43KQH2md7mJzy5NTAeDFLUArVGh6dInjYb34Z8G0JjrLu5mjo3sNTkKNnIfaFo3qXz+6/1+Mf9pcqEgPlxsIsocjTASGGYiJDZMmw/VadN5I9RkodQlZK60FCzvkqSfOu4rxoarX9prKHG1UM+chW2PMdSULctT9amjkKX96FQzHTU1yJzNBf6bOZCBpVn7aEN1v49TaP5N1xjN0R1xo1T/bSXaiNSy+dNa1o/b+ULZOQe/pYFiIm8LLGnsRG7MkFedswd9RGJK5nLjdiyVQ/40HkX6mTrkmSHyia68DWQ8HiZEx7JYLvonxVV5pl82HlUQQr8GmfEj/b/IBYz8evM7J3qmepmdSn/wAb2C/eZjHj53y1X/rKgZ3topba2Fa3SJre38looU2G3aFiF220T7WQ7Br5eILA7EaZTdmSrx6N48RzsX6kG2q3xX2OgnepNLjaCxvHxjJ5kjkN1LWk7yeTRXe/2zp8bE/FxRmaJeWTHN7VuuGWpnfVWLYV0ia5o2CFVTFknGogK3CQXDpYKTeXXkp8jVfvTttBgw58OQBIyiPO4L2SPBv4URf3BvpjkHJgFP8AppHc1YxxTkE+1HyBR+3U606EZskuS9qfeOQmyW9QM1XlqitP+zwiDMv4OOTJv7I+FaCKpOX4/sVrypqf0bCd+XN3hufix466Y6eNVF7J6heQUnxkX91y7nf4i05n7xZd7fh8I6nNyAEEpZQvfEARGy1Y5mqbzeUqlVJn4ygqdr56fIn9q8b71+SZzlJl8bxDzU13et5KSvMG2S03PIs6PKMneWdcVuaTYkuX/VFdVuilJ6kO6JmgdIDuXe91Vddab+Nr+rdmnU60bF/dE1Phpnex8tKGNpHOQBpgefzK/QsN7RLNvJd9X2cZJhfPPPj9gTSeT5PBNFLWldZkum2uiu7mppKOLvnRWSXZxrW3bt2I7QiBH4s2PfLfl5dUy6O5oqqX66ed0yL1NEOECJ+WO+JyLvRRjVYWjzk/+2SbN6BD8dLWQLsGN4F/xGITfgy+RzgNAzB4hAbolciFChRhUEl1Cdsu+oVGtyanbQ7dNyYjITGSufhB3JPxrj0sL+7qzS1OhiT+ls3UelL+91PWp19payE6jVRvnf8A9zoeTbX12rMtOLL2dX3v5DzJ0rRUIkRXMho6qX/q/v8AKAgEggEg+LiOcz4a1QCAs4HpF3eNhuojaNDWGMnnqSK/7NeWn9V46eTcnPXSAFfp/Mw4uo11IlwMt85bhiZv/wBm1nfMwHFeQaDT+LxkmOJa3kyUK7rni5SZq5k1BWgNM9FTsOQZVScH2QOHg5K41qrrrriimcuQOdD1SSg6fRcBlU5yUl7zsSslxAAdje8Ke9ku7B3nEYpprFNeWu6EoiK54ZIT+lTvyNJqArGPUpjyajfPEldP1nKTy8+eqpSp2fUsnnxQX+RxoGL8J2O5yGM1O+apgONTqda2ut7QV1rpql1kJnxzcP1/TVCYdH/WdCKSCz+APpSWNoQGEAyN4NwgdVgRUAITd3goB8g25065wpW6A/XLLPcoBaIuQGpOQ6SQ0s40HHjcmImLZ3q6u1OgJecZfSs71NGta48Oqqau60Ti194xNSG6+vO0s3pPFXJOxk4ET8GaTx4mSXHrSY1jROPlfsJrok1TLKb/AFpCSttdBQzOxQBMMGJAEwZCMRMCy3VuA76boxW3jyZH5a1RmWoNssO4fj6oNBy+S6RmiQo6F01khomeTlkyaAbnR9NP1ZOd7h/r+Bjtk4pnLSzxSb4+owGT6ys19SE565Tmq5WnmnR01XYWciLBqkeHbpgkPI8c1S/lgghgrAEMGHS7vkDJYAJ1cDYYLxY3+6k55iqxBAhWmMbUG4XxY3TvZUtGTgPBLXgSWxk6yUh9Yxs6R+weLrE1Xn+zMCTWijXh/EY61XFncuXIHWNJnK1uMg7DQHnkQ4VirEX3PI/Yr71Qz/bJray1JuZnny8n1p68uyqXfAXvEZhkRAB2tpBqe+CASuSAt7CNtM9RjmJx5dOXkir8XMxEy1T0F9b1929/16Kqd7R82PJNMGkCEsYSvBv46dDBWm/1O/8AQmnTkZxldmmqianu6Js1PbsZiR1qjc+QhB3XpnHjOa+PaY64gmdKJkqrEnfNTTro5rR9ZfwqIgiAYLMvZE4mDuE3qTNpP1FoLUQW8mLvTceOHN215cV1VVZK063HMzxTT8azLW2XVBkn8DMs4pJE/UNUXfTSG2P2IxRvzxvmJUv8LD9uTQc/uaWC2OWiR211QbZTZuWf0/mNXWStE3UZeemVMe6CdNPkl63Wth4oVrbUMXJS4IEsq9rhMjVCyyec/KBKfAlu3JPWSfHOTXOq6ITG43/HVCHyP6YY2r4rXmq138dYqx+eGYbndRVbjmb2jb9Vs/0A8rjZ/LGSTHTxXyd1Fzc2DArvHVTqZ1UPMyeU1DuvxeLJLknuZqZ2D8dam5o+Oqrbskf2Al/1+wlURT6hIhGTSD/jjkbn3hUGfSrvbJRyMqxO+jq76+QPJRNSM1PlKoqZU4FY+19S+E/cJ9PYuMTLuuQJ+Nycw7qa8o6IMitEzyg6T0ZAdbprr5DRNSuJJvpU7qgpNtq7+41+V6w43JzM6Oi97Jn+5Ji65FxvJpJ0m58LspEd3l5TcE2NvpoNxY+DItaHeBwrJWYwlv74n/2uS6IWIXWPTOhd/VjkN/ShfDmYJnHjNSYijdSTlJpeZN2tIy3UgUeJHStYKvs+1BTWx53gnj/H1TuopQNEzXma1uac++M5GrmqLxqs6lTkL/1ID3MxrT1H2fxjIMQrw1S8Tz9QJI0ERbnNhZu59hsVqLyZnKE712Ss7GshGjLT1WRF5l8TtAd6Rmcbf3zvBGLcj9ZU+v8A2eoMm68yPifHxty/h1guqpyZCx1m63Omd74LJGnVHMxs/vJX/wBSqMhZQRReKgZWerqCYqdKtRVpzi0IAX4MbJLALeHyiMYgrtnU3ImMelBv0qFubZTxNhucDjgNVzAPkxFdHxXmrczX1lvyczW3xO9Bks+breOmsfeTf98e7kvn+vEz5BC9PmjS/kGXHBO4K3EY6GS3HdO5qsvUvmXvWm+PEmwGch3kwjkjkkyU1yxkH4/pXGOd2gvxrMzPUSbFKUe0bTINxE3HI2FiREJBXQdNxsO2GFOsjLgoUk6mPi1lJjwsrXnp6lsnrdUUBymvwTJjxrcR4nN5khK8+J++w+PcvO50+frrR+Qzho1rU0GXRrFN2Accn33fXkPqskmtzf5MpotkGojHJc2t1yplq68iUOnyxweO/NPwIXlqx+gLbWiVaHdidhyxF+b6f/hMeNaWlxVNTcNBUaYrZ9ccpUv1fIs9HL+V2YOJ6ew+aKnnKcHRGMeCmQ1W9E6aeig1hjyj9a6L6orzr4l8qssSwnXOOBWqBKUALqNzjN8SYst+e265lJ3bzjhHc6NeJJXY51VQt1bJKOwM9wNI1C29gkcGEcy6mAFJzo6iKxwzJeripe1NU81NoaPrwsvPNPW3o5sVRMkTufBIm8l/HyNUMKaJ2pRrmkBjSUYmjoOiXIY02gCzzDWyfj3KbmfrsNiv4/F6fHNamNba8eDU+BnZMvM+eSeuvtNeEn8zkyMoETCPjB3HZjWYqIKH4SgQGDBBJJAkgG0EWTB0NfHkGY1jrnwJx1caOYNKliG9z/sOdFfi5xF5ObCeavJM3bWuGVK+STUoJMnKu5pE3NnAI7Y6ZgZ3OqyE867aS2QAjyNM8O61NKy5OclLS7pB1cb844HLS/aXX7/sHn/WvyyAgSYCYcERMu59noNNqg8EgmPTABy5NiYas9LtiueoqajJDudvOQra6pVxf6aEfr9+bg3cmay6KyQupyzNVGnETO4aZ7uzcbKCaf3p8tfNv/HZyJ8OyIbmqZ2ZGt/bRsV8ffpE/q/HNv7o+x8glkz8dDvFDWvFPRPAFfcVufzJSRLIvva6xczcHTQzkBPEgcxs4SF51YOqGgN0HdY54VMa/JUhVA63Vb8gicSKzBfGLHsP0zzrqoaJY6p1Qd9X4Oudn7Nqqqj46d2c44uadxD0MmRH7TxPlrq5WaDVO308RHW+K1GyZ1NUbm58ycy1kOkU1oW9jh1PlbCQWFYdgHPtOiNhAsP/AI2LQ7uwkRp+Oqv5OQp566l+tlcUV0lfJk2vKE7TRpmp/G4GZy2srvIx5lLGmalMmpANJsjw3qSa73Xx1M/LV1NdpM2/blojQOoJmQeufI/1nepLeHjLZrWohO9TusmN/tXTVf2o1Ug1kCR6l583qFwI8fodoi2NQSt6YDhJ5iQ+xAlTUNbTjXC7t7MlYzIdzVbKBA18f1rdKTdFn1SZ6X09eun0f8a9t9uwZPm9493zZc3MYKy+s9X6T1GH03oPTFI7wYi8mXmhuM1txqaqZ5bJesUu3EETuju26mtleOckLuXyHyG1Z6T86XN6313s3uOD2/2ufT36z2L2nJVeocR6jPg9R7p6J9R7nmxFYy4y+iPVTPpM96PS3hMk5MaTkfL+KdRpFI9VQ+cgn0iEHgRV+V40UgklliGWAQTJXsUSgRgsanBft/pfbP5PmzZIfcH299D6P0uT48tt+t90x4/Ue4vrLmjj0mGbqbqVr5oU1NBVw+nzfx/3b02O8fpM14Z9NTeVn1XpvUR6/wBEVhzxDOp4PUGWb5ki+WTqTHN72b2v0mT2n+U+qy0Rk9t/j+H/AMS8kY6cnrvU+6eiwYLMHLTjSstXkn91USzRZRz+f0vrsGL0Gf1WWvUnrfbcXqPSZck5Ky4/T4sub0jE3k1qcbgow7f1M1FNWz+c9NNJ6nUpJmKagrk9Okj0nAUp5lTo9KSugX2KmBM242Y0k9N6j0k+g9X6zFU3mzep9BPqpycY89+jvF2XCtkSXz8nLvoMU1xUSvOfaToKq4yiKnx0u4q9Mybf66CuqItVn83fuHpfcPePffWTkzfX0/os/r/S5Pj49Pi9L6P0c+rMxAW4TOzRkJMcZMuWV5zZLb5ucnWObb6biWhNZYq541Nb1AXO51sK6Tp5PzfokEAEfMExsCWnHYxtA1YBHvFgIVpd5sQSAMLVXLEzmCGof8majcH1GKIeJpIr6p0By8qS4+RvHZVV8sKjczTHOPGq6x7BMgya5E1bpdpJVjmL+WVFirSe3qWgMXyTISV/9TWwpsHhJmrlumZKaDuJ3BOSCPLU3M83San5DR4RZnno7aAw/bYiD82+Oe61NZRFjbeWAl+Z5fGhpoz57m9QzVM0aqpGQvHjsYnzpGXxRfX1p/KjgUpithvJj21NuJdclW9VJydTKnPYtmtNrI1bGtaTF1IS1U1Mk5d1V83vlJid8hqg8h8gSMtY9zGLQVjgt2FLVeJRYdJRrlnnUnVQI5Bv7NA7+61BUgQ5iUY33xzzGl3cQtTjcnd3jsu6ce61zUvE8xKKU91NNampNiHJiv6d1jouMRLHE3L4SsjS0UhCkpcjFzNkUz6n5D7Yr+2pimZQndeav7SWnI9Tpl1Veej8CMLkk+8d6x5L8zHyH1qhpf8AKaNTQ7qfA6RdKWVuhnt/EP21DmCRbB8YAMd/OhzV9ZMFcV5xl86g1rmvKlU1qRIZqrNn+vxWP00xFzmyTtqck1S2E8HOIpdarU7CKPByhAJ5oDTPjWSE4GSpNcHU9efH2XUsc+VXmCslpKs831E0pPitMbyfahqkkZZrzDqgpoj8LbuiHsj9DF7BZ0kQgs57RHs/9as9OLDjKR2ySDqqmjki3wGteZ1Lr66NCtwNST+u0iQ5aetjH2udef15PtygUz9quS8uSYJvHin48eSuhNJs3M1F6h/tdSm5GUnmUt4sg+mxWk9PEW1j+Syv7VbU3vwSvml5o/tPkzqqX2DjbA9u/fTyrwLLK4IT9y9bHBfx+bNPfD/jQMnMv9tSOIqUn6Nf6mW503KneOKoMtT8dbgk1DPTPcAyTouQNcrtfOqeMq5eqMTAAyQds7DroumbqtNbj5KErzt/LZOScRpbx6B3e1mkXVbg3P288hJUund/nnda9QqtuIBMB32j6c6oXgtIW8fSZIERrc+idY9tRN5bPjhZrIdSST1W9H2Ox6/saSuJOo9tL6JcbkAJ0w7i4F3F3U1kSOmR0bfMbnJ3y2DCZLwg3+pJxlVUxif3LMyA+I1M/aq3Mq0a6j0tU0ROIyE1GJupvxXTqmWuUTc3lqzVOyTl/PE+JUotoTDtsMiAtoOtOmGRdAiQbMAz8rIPpAspRQ12PoCYw+mmeq4uTS5KnjLquqkNRq5ZlmNHO51ANdr6L4skVXyIl/JRdTjoyzM94mQNlu4a65vlkkQJ430O+8FcSOOox5II+hX18WTsrHJOSlpTEIUXzk122Bw4628TBL8kTFK3upL6lSfjKyVOROiY3xTLv5f4wpnIc7iCb7J+25139JA0ekEoqASHFwRZ5jcb6+pvb8f8V9r/AOG/+MfQ/wDIM/yX1vpv5D/yv79/Ovaf4t/FMvt+H13q/wCCYfS+y/wb3/1t+6e4GS/Rev8AdvfPZPUe0eyemwel9TjufZPcc2b01Xm9Niy5/wAzZ/fv5X7r/wA/fzD372/03s1ewf8AIP8ACP4B7f7Lh9SfB7D/ABb23L/JfZv457H6H2/07cY/Qez+xfxz2v0se4RMYPS+sLTAep9xxt9B/K83sXt3pv8AhfJ7/i929z/k3/FH/CXp/dveP+PZ9rmvSnuWf+T/AMk/mn8Sj3T3L1eT/wACvZs/tv8AJ/Yff/5f6KfR4fcMvt/qvWe2Y/V4fcH5/SfOfofR+v8AdfYv5/8AyP3P1fu3q81+s/iub15/5DeD3n3r3r+RZfVX/wDTcyZE9RjjFHufqIyWGCs1RuYx58hl+G+F6X97q1/FVMVDrVAGsED01/FUkegGEaKKT6ssEEjXq1/LR/bTgH0sQunmG5/5YAInX1B/xV/Fv49/K/d//oR8Xo/fvTfwzN/KPR/8nf8AG3vfv3tOfD6D3n0vvPtPvv8AIMf8S9d7h6/1VY8fpsXq83829k9mzZ53XqPbYz+kwleoPSYn5i9/9p90/jXu3u38c/kWCvR+/wDsXufq/Zfd/TZvT5MNeh9w9vv/AMT1gbMeonNiqu2ZrIV8sQmQ36dWPL6P/gz+HfynN6TD7lj/AI7/AM0fyn270Xr/AGn1N+h9d7XB/Fv4B/Iz2/3L1UcxN+p9f7V6r1/tODJluc2T0/u/q6w5MOO8xrP+cvdPfvfv+U/5Z/Lf5BXtV+u/nmfD/O/Q+u9n9N6b0/tfrP4//KfRej929nzejw4XBhwZX2/Nj9H7j6fFi4we74PW+no+TDkTT4AdSj46sGsf2qx1+l6Sfmp6nS69VVIAGDR1ZBUUhQdZ9U0npCmmk+oemrg+oUhXuw4zkxryD1VfISXrJJ9WsfLiqaOi7Fu5aS5yZJNhVEpXyEa25nHDUBvdZZpuXiD6ziL1MbiqOcDP1a10Dsv83P8Atyy5J+K9c5YlU530SsH2MfmJp+SeuWGjnxY1rrvHq8lmSuTRNX/hk0OTDRavCb3U631P57tKUMq+5I5A3wJzjXmlsxAZM9rFO/LOStLz/AY+KsLuzKW8JNUsmHP2EExy1MmI8HM6N22v4p7xi/jv8s/jP8gmeP8A6R/yH2v3NapWv/B9w9N6i7RIoSZqe5qd9E1/Sd0M0Xd5amR0nqSu4fpMi4qq6yU9vDixnLxZ5G5TS+uxt461HHOSZt810jXV0UVc47mv7rvjZZ/jel1OmOr0qqKpFdJpqVyKhkKYI3tm2nSVVTUCQiC0/wAKiZLC9hGvp3/6IX+W+o9b7/mzXd1hyetu/b8+L1duO8efvPg9VkvGZKrqM36fUZsfx42oqXFkl8B/mX8l9b6z2f2/F8MYqLc2fLgvi7zZfTmOs2GMzc/PTPyZ/VTRkymTEXyVTWz/AJL7nfvH8a9j9VnzV6nPh9DHt3qM+bH82WfU+gx5omRN0R8BGSjIFHi+U7v88z9feP1ft+GckVOT01EBQ23kgv5DJgSrmb6mGlpuioyc8Tdbf0r4KnpdHpUpHp1GkEKJGJDsxaHfW3Wr9XqIZFYFS3NxaeMc21z38kjF6a/Uc+ojL6j1P/jFZpxs4cBl9PN5MU/6u5vTk3NUV9yufr+ec5bvLkOYqUuSnrRk5dXzD1XddGzzStQPMb/O+9/xepyY8OOlhrHM3fLRNPV9/J/kqYmZTbqvirWIMYWcL6kcNThi8dVyGXKRvmr/AFWS4rxX1luh2jMCBdV9J0qkKQTMIBTIiB2kf686u8gqL1CWiQS94Ud41V9ZWXNGLHhxk81MOi5E4YUjquJ0kuT9OuKEGkvbPbcynqMkSTIYyrxXMx4N+ods7JRmMi9bHcJNUbj232u/cc2LF8bUOKRsfozTjmsufXVxAVNVXUtS86lKyD/5L6yPbvTntfopepxfFlvq1rhqfl5NAVM/Hhr6kxVk4piW66SRAqCKYAe4cu7dy7NakgVAn0ikAsGbsBAlEg2i0HW8/wCL/bPV/wAl/wCVv4V7N7FWb0+f0nu8+9ZvU+jy5PTeoxeh/jGHN/I/d/Xen9Vh+S/T5PTe3+0+qzznMfMZDVUBVT6Jf8i/j/u38Z/5O99939Xl94/5E/k38s/jXp/RYvWvzHtHtnunqfe/dfVes9v9dhjE5vcvX+r9P6D2si+1jqI4yW5vzzX/AIWj+X+k/wCRf4x7p/D6+L3P0Pq79R6r1Gc36D0X8eqHB/JvWe+5Yx5MeP2PH7N6j3GPdvV+p/8ArePR5cnyRWPicv1N/wAdfxj+L+i/lH/G+T3CvQ+4+z/8i/8ALvvvuseh9V6fH7jj9Z/Gv4Xkz+0eyxhwnpvS9Z/Ve/e5+uJ9IUYM/wD42IxQTlmMni/HdSnodXq9StVGnp9Kqn+3+NdP+51upTUpFJo6bFgUQkRro+HoJppApqHq6kuQAfTTSRyKintcC+vNP+Tfcfb/AGX+Qf8AI/u/t03mj+a/xP2PN6T1DkfU+p9P6n+R/wD0oyfyH01+qij0/wA2D1vovX+l9X6aLy1gqgsrJOeZ8a/4t9QYf5P7VZU4+PXekpyPnZiz4a3LWSUu6GR2brUVzWx77+efx7/72/4Z/wAle3++5Zy++x/yb7D7f7JiyZ2/We3+kw+h959193nJi+Hr03o89e6+gOcOSMT6nDRlhcM5b8Y/hea8Xu/oa1VGP1OI1jlGuUTVyVW/+zX/AGmYX7fno/C/9X4XqUir1UnpekVkfiH9mj0l/wDy5sdxrDq+r/3NAsBWvSE6fnkbA34Q19q+7ewei9Z/zl/zD7LlusJ673HPl9P8mEv1GbN6j4fU+nmZzuTNdfLnilx93Z3GOaqZK7f/AJG9Bn/n3/EHtH849PGQ/nX/ABL62/a/eMTLkz5vZPQGHDrJEOT1WOMRE+vwnqWcPx17oYBxzGN57+a+pwewf/REe4Z6xX6jH/IfZPYPUegm8rjb9T6z2H23jJHqMkem3eP1EXjNTqajM46+bH9tp7f/ACf0v8I/5Tw+m9wrP/8Ae9/OsD7J75FUVgPVZM+TBHrvrjn0+fBjzuOMvylZPiv1GCzDnyVv53qDren4Tr9ImrqdH4fp9WgB/MKaRT1umQkfVQagtw9jr0aAB/cpLANVVJ4JLpqmIi27trdf8cf8m4/e/aMHqrky/D6WcN4p9U4qw5MSep9ZJ6a81Y8+PJilmPT9YjJGWuceSsXyRw//ACf/AC30fv1nPueeDFny5MeasGf/AMT5csRXqvS2ZKfU2Hq5x4cc3lyYfjjKYjdw3wn/ACl/HPXf8J/zrL6j2TL1/Bf5Fky+4+2uF/8AI9FjPk36r2y2sWLFnv0Gcy4LiAy36a1y43eaHhvVe9ei96LzYSMfqc+SssXhnCYct5eSMVzky2Sjqp1KViqRG4xv50fD/wBL+F6/Vo/qPRpdPVDCABprP4qSIA9Js+wtp19Y00no1AeqmDb5tsZGYW+3D+6+5+v9F6z1Pw+ouI/8lbpvqMa23NkzOTH9ZjoRv4+qw06mz80X/wBMcHqPlj1k3kaypDVbqrOfjx83oYKoo4gSg53Yzks+6ZbMvqIyz97rJgPUZCrqKrK313RI4p2BRFWpVaKil4/1spcfHR1EnVTOqLOqhU6TIot/13T/AH/WvoulR6QEEoxZgCCfo9eVXXNUkg2kK8iWYfCUwZ3TkPS5KjIUt/LEhidRV0UM0TjGakF1/wDg7CO55df7hlkwQlFsVFZa05JrfX1u3QfXxQAziGXZshfp/c/UZ6/8X3HFNayTEZam2sdLjhSsmSWgafvI03q6PkmqbXuET6XBVcxUO4kqB6vxcZJ4tmfilUTyTvJHXk/OkU+mXkM24DlyBnYA6hXRKEXyhdwh4mNtc/7hlrHOH1mCzFn9Pkx5MHB5hiWuclSOQRHudskeAp2LfUGD1eO7w/HOL3DB/wCbhqmicWeFrLg4oyY7qcsXj8X9v6tH6anqXmcs1eP/ACYnJ3UxWprQYgOCbhNxjJ+lVQW9eVez+qyPpvUeluf/ANQ9R82FYNz6fOzGcJ6E1k5ycAEljabW9AGiI9rKmYgWEjnM6zBIXqsgY7BKON8B8a+c0RK6U5Z3Eky5LnRdMfaUHdPTRpeefH5V9Z6gcPCausm9q9ZGYRbbektrmCSR1w65KrLecmbCrvHlymqOReuYdXr7oiBJ1TIarnVHMXkqCZ8zkmACjol0NPloXWl0aPJ1Jf5ae2M4ELLi6VnYjRmV/oW2sIUnVQkyWCc7SyU/6/VJWtbNuwD7eZ2aX8DJ1WQjc3ATciQToYaxRR9it71ryjo0rqzy41aqWtb0/bnWvHVhO2jXnYnnXnTXo3toa6yHO6ZRdPKutRsR8eGf9hv8bFIG/Css77vPAOoUHOU+1olRpWS40dT5mmGg50Eycr5aP2OtfoN65/BUyckztgdl+Cg0f9jbt8fo2BKdapPVd88b88xOimnc/ql/vX2YSRrf/V2/mZI+HJkjPNzkhMd4QIr5TQwn9+lHW/qsEM6A/FcwrKIvkWzHpLm5GpJlhC0zNoJ2+sHfW2y1uceOJE+pTG9Eoefk3Wl1Iutkkir5/Jx2LPUlUnGma2sa89fuQ8S1rabmjxuoqJjmjwmslyarQJtlgAdTOh/r519U/Jx5mKq6k/y0c1PXySWSlUdOiqlap33XmpvlH60XRIDtDwMC/wCetR/BM8RY6ZgyFxQ761w1zpdwR8e7dOlPCb0G9UbVfHuGuUOhpqga5nb+zwT/APVAMCdBqq/LUziZeHUs6fBHnW+tPnon6tDTT9RTVflf5snARCM1OJum9wpI70PiPI3zL58nhPykEBVOYzYKGFBU91qrgE7drIdniCIUjRGLnfGWo81TJUSOKdJAsgpU/wBUQepKCl/BoTb031k2I1JEvkmgjjgJNyTPM6/tP4N5qghAn+sWE6Oug6qh2lPySpreqHZ+MTJ8jXyTusfyAZBATbETck1xQa2P7fLslngYFlDQ7oIP2Gl9fKDCe5SnHgCIrlWepB+8fojnSTPQtbdkpKFyc7E8S46rrJhyfRqaqGiXnUt/HN9QyJqaP0+FJqn8WwYze4rrSeO7gfqd1rmePHgmn7NSP1/G5Zn4MMtlCg8mQ7mp39qne68a14ANao+ywi3PpFnIcDfB7aASyDwwyAv9FrGNit5St0TqqqaeQsNSw9dO61rXibAFHSsn/GdTEW5L7nXNuHb9N2ccGNHUsr5GOtJ+QMGJzZsdfNOQDSeakHh2TkWtVVVL0gljR+C6Jm4aQmfBW/puWsdTj/TIyu15nY26aWL2ly/F4+t592iCzYzs2RMW5O49yZiaHlRfm2c7bOglugmpfJJOwBJd8n5k5cUxc00UUkvNta55I6o38enZVB4MghWtl8lVv/Gk9cb8IU8ABcv+MdG6BkAA+2zQAvmas1P2Cn5NTJlE8v2fGS/06DoSUVtuQhIE3f5CJRgiE+e8Q+ShdDSskY0kL/13FFFlRzv4Xw5HkqaZJ5+zvkZ1OMMkVjnrUhV7qWi45/QmTVu5CqB5Jmv/AJMjHJlq5voca6unx14qJkCaqZQ+lfXbvfycioOctspx+onbjCDgJ2E9FTokd7Cv0gfjsQUnf8jvfF40DGL8sxjvtPs9WDqvJOOw5xNQVJNIWZVKUfKNJvp6OtNK+4Ml9R1SfFu55HNRC6/ohspL+9bE+mlCn9aiujTk5aZeN6YJCd/rZvcjvxy0AzrLk1zEchtQkphJ1ql86r7b8rLGw0/hkRLvwYe3IJJtmGIx2vPYWYYx+q1MWvZOqub2DLuNMa+1GmJXweQNGj76WkN0k1X+cCv1z5/rVf0MfW36omnaTs/GSJlSpb+TeM+nxyUsR1kHxU2+SnWzy7oSjckYOu53Re5/x9JS86qvE1LqmX/7l1/9swiUB7P7M8PFkiKzjYXuokYeHmN5aKbL3ir5AXh+PJ0KuTJeN14dNMzNRLsL1P5FExWNEKqTG1P6SgS7yjzFUNzWv3z0dnKH/cqsf2uemseVnxoivk9PRboL0E//AFQDvzQOLqpy7peapKuQuWTRDvUmM6/+xSPeySRT8oSOCKXJsFHklQds30C7pZUH0hA/WPbQ8Yk8Ya+ubQbWZ2T9XqV48A8iJqK3zsmq3zUYbX5MePL47qql6LiLeqnxM9nOQkmfPPVZmtGOcxTRHkhWf+wmWP21MTtQdq34R/BjLhmSEr+uhYe5yUn7vbIU2IldxrwBr8LR+F5gTG1mjGcHaTHGb2tEfYIlGcCCLTxi3rJEVNZLL5+xVR4Ene56CY4OLng6LFeJmkjfMxPCSxf1J6rxyy1JVAKk0H+/wryyMpyczIMlaaJKinJPinfSoHg71qdTXyzkzkzORnk6ZmqOjZ3U/sqk1qdxO9jrbQ16WrwSEtsAe3edFrzYQJCgqEboOVaCdTLO3rIYz5d9ckh/TZsNq/oon76Y1NpUrz5Psyc1E2x887kouv15dV/XzkK27UmvKL9REwY4Knf/AMys9SdP2sdtXy7qXVJ5+3L+LlNAfUanJW+fu7kZOnxC+ZKNf6Hztg1f42zHAAWFfCz5km82Vu04GUMdnqx3jC/kPtsieeccOV3E7V39ldZMaIb89HSLTQNYrSH4je+vD+1RsKnSXqTQ1RrGv4BGfJimmGTvbS7s1JTv6b+Od77qY3Cb8m21icuNMeuvrOWhXJ9lleVQK/bB5AT9jk6uklAERG6wGltLH6pg2Hu3a31dgwPrqc04vhx9VOPJBGnWO5o0Ol6lrJVszQ6NdTXkNoCam8mOp6x21xVDRBoyYSa2Qxv/ANf2TrTWnxJrKm1qprsU0ceX4/sIjXQTOprmkdm1q4y6px8/Sipn6jloNVP3U/sSVIo1oH66pOUJQvZT2k2EL21Vj2QslIccvwp0rqMMa5ea3rwzXVSnF0c8yc0roD/rPUn4yt5PjaT645RbHGR53Cv3avwujVfU8L5Du82eouWLxoT58a2S9Na6q2r5smW3c/WzbJFP15umbINV55+sseQqZapJ1MipLy/tANP8KICGwAZ4mYSl6AssgMBOYCNreJ40fp88RtyY8hqvjivsseAZX661/aUpsJ1z4mWc2Ts39KgTFKkBVSfXJSVRDtXafYK/7b1MeDriHmUT43+08pn6fB5fNs78bIfHOVcYz7asyO2pn7Td+OW3k+qZKD/Qd49UV1YJVIJiRa1oKICzbvyrXsGJVrrIta20ZAambKOyWpaJKvjQ772ckaKnR/VQlYtXREx8GZSruJmad5Nb5cLo/XETxbXSsp5nx+CH+Wb7ndxNVddMKM7nwTLt1PxgPRWv2/kdVKnmtZPjmrln446hmpWtTqtik6WxBrasBJ8LMsF84/D76YuffiFIkgu6Ae+NTlYLmaDVT8ZkY4icu68W144Fp3IogvmV/MnJCfSo2zGI8Ezbrfy6oSp1z/lNKv8A9Tv8ystLp3MoY6ZjQrOpuv7fU+33PKPQh5Ws6AGTUCskzGT46NiqrV730abNm5UW6UzY85gAQy1u98nTtaffiE/0QI50jM6udy03EHYHi6SqatpHoOvFNE8pvSUxyFjjhdvDucbzqN89ZOKWnrloHaVvl1RMhTQOyqqhrY8h9eas8UZN/GTB07mdPQZkrLCDLzFGLs7l0h/kZKrwz13dE1M+Kl89MhO/pKJIZmIEiQ0eSBawXCt5/ncazFOKsMlLLiqqZqvM6nGVPKUuJQ3L/wDD2iF/jWcUwAdfImWEZddVzOK1J4kKFk3cI86+uoq9AkHc1JxM6myZVpZ6qYoK6/Xg87n9FN3ZAQxqZyJSV+lWXrljct8kabjmR/VTVKUmRFnEAHYKEwYu7EBgC8DY5uD3PnUY49T1pYgISBpayVFAWVklk3qUZJbkJDexmflM9ot8i0fcf/sTwSIJtfsV/bQ+bRZGXE60/HPxMUUMlVo0w/ar8O9/V5K/cztjsqnzXyTS5MSp9NBkI8LY+CRZJdniXo0EoAsoR2QQx3QME86agTO20C5FxHJlJScmcpN6mBVlLp1TzPN4ykJnxRNqgHPj9fi5ctFGXGmqS8h9avkkrzbvWl5qf+zMam/P4zJkvnxiYkqJ+jeskE6Jdz/XXX2E/Z1/SlT36e/GrDve0jmLrj/F/tJar7f9jWuQR/GaQoLNgTBJwmGVlAE2bTEApzvLE/p7bCXKXfxzDJjxZC3kxVetE1jHbr+gv1a1RWw3+TvH1Tflxjp+pLQQyPf2tK6pHewrpKCUyXJ1NVkx6qkra1j8B0t1DWLSfUPPFO91pRaxjMswhBOPL4J5rxbmmFaZSh0876mfM65oAUgEsgAn/ttYT2f4gbsBk2v8iVBIy5pYEy/qBo8/xzG6nxVRfU5EhmpTRROpmdNWym/3ooH8HFbAWgUPxzXKeFlnJV065qvLSbTzy63UXdVrDjOZY3WSrNVyz4xz94q6sZmpOaNkf1dtmZ1Isn0l+KZkm8kcpRN7aHrdBRdVTGqE/AF1IA2ITAc/MksASFaxepBkMDHFk9vZw76bPxHWxdVWTtk1qdBGRTVQP1KieXyT9ia/E5EmJn5Tvg8yKVjfj0Vk8BP72fWeZ1orTMFWyZZxhQcUO+g11kyMVShWiSmuQ8VLOPX4Zx8Is/a4nG9z3lLqhN1C8xDRordAFA/XVA7AkJlQLD692DtpsmflWbBxsLNXgGedOwEVdGSfDV8/t19SSNZE7hqt8yCvgBJfxWS4onWRxJljU3NsNSIr/ckNa/RsnJNA60zDVF/pcknA6Z+wy7rvVLX+nRTyyJR5UVkm8vOOaPl31Wy2lnitGQ7kTc1Wya5SV7Pxi21p/wDtXdyQR7p6dJQpEzYHxtJeDMxa9kaJf0tjUvlrHio/fZzMzNAUarjsdL4a9a+UMhXi3QnMfJNzMtt72ZCoOpTfLLwki9VEaKpwLxk262tVzymMR24yfGildf2qZoxtYMreviguJd6Y6C4yJENZLAaneyZuVf8AVwhlL8rgW88PTNgbYJi3ypgcOC3ts0ZwWxiXa/JvoAp6SPtJFfreKZne7vz+wystSbjaVe+U7nG3zyl+JmhgkJ+v9Xl6RHeLJv70apuBSar6xEwxe2ZqqknGL1YxPIz+FJifNmSJf8ulE5aeMWq4+lO2SJN+Zl65FdoHkD9sI7vzXqQAwERKJGAbgQZ8oXOhmdOSZnpufo0hpvH8nFZBqP1OnHM6eglkqT8C7zfX4nlTHipoZpUGV66m1ZJbsJ6Wf9Vcj8rjyXHii2/8b1RBTM9zZqSTxFHJrTopPu6VoRlApGtbt4J2XWZ3X1F6158RrfkzqkIE0qxdjB7/AO3Gpbcc5YX52f8AiVak6zD04+7i5qP8bXkRAqtu25mHpKk2aBlvVfg5cOSgymST5MkZJCp4+K/JjQC7rciy7K2jTVbHOXGY7uAlMXxsuFJa87uAfANK3TDPFgc+aT9KBuqSZnNNdyScbTD5JYnVG5kAopK1RyiR6aWqoTHBEnEAbu50gLPIuQG77TEnCmCDqN/HLbJc9MzBjpqSqArzyk/S5drzql2gLIkyxDnqh+nB3PEys6m7panvbv8A+U5n7HIDTWxSe4q93LkfjpNTV/eX7aV8aHRTY7f0Xhh5Qn4yI0QdSy/HUebZWjR551pJ3v8AIpAZMwAYHZhAsdrQRjSpRNQEjkkyhAgkAExG7gaL1OqIkxtgzFpNBzykraV1KRDWQNRJPQgfiMkzd46qWfjns7o/yJxAaZWoGZuZane9Okk/DtkoZZPpONmyqemySpbqGyaP2dUOscDrkV3iRn7RU1P0ySnT9ZvdrYyLrl0MdHnUJdQpQGCbWI9KKtyjhTiNKgAU/wDEH5Q9rPkBBgTcaPH2ZKmo3rc/JcckckybqgPj+7qjH158k1L+WMn0x03DMzM4+53zlLJgKqWq+z0jJpkdE2/iZLc11N9WwVLzbrHzP+My1srIBB/Wm+qryifjfkw9Y5aaKrHQ1OwRCMV3chwvdFY51qWTlOvzM1CkEI0tJHtzMOAfaxQTFUzwWAh3BIRtVYHTIiMV48UsTuYua7UBY+lD9bdnRvUf2l0Q7fXHyw/9uh+urC9jjKfJM6b6jWw8weA/FTTXqbDJDMETMAfGyONqJX62XS6Zqd6s/t/Z8B8svhiXvTAATc6jG0nVG3jzpX67fq8XVJL2JKJ2acCbb/nqDczJS8INfpN4nRuMdJf2am5SoZqGp7iaZHS6PjZ3TuX7Pl2OS/UIslRjx1VcuOfrIcbeneSeXx/7OGfrWOa/EZYxVucvywOUJyBjb1o8GNJ/xVSVrGlK1zPfOn4K+LH8xPybPjzNA2ZIk5z1TTklmU7+Sndb1vxLxdTPv4WO9re6QmpOUSPSFAGHEyQCCrHJ1v8A2/0npfXev9u9F6nOYMXrPU4MNeoP83/jxmyxLiIcb4SXk/e0oK1ov5/dsEP8nye1+n9S+u91f/pXl9XWTFeL0Hs2f1cVmqXGhk9XmMGP0N5hrGenq8KZMlXcq9hyVi9y9P6mjnD6KM3uOXOwZPgjB6fJU7mYsJ+ciYjoGrx1NDWvx+KvZ/Tewz6P0r/5XvHunr5y+4ZLxTkw+1+1e1byTi9Nm5msl+5e4ZvkvgqMeL0Xw5+Kr88jrmn+8lVUPkpCsAamTWRhUg2Ef+QVWpsi/m5sLLBzeXune3+jwZ/aP5F6wzZY9V7d6T2ivQ4pqWLxZfcMOP1N5sOK5v48E8eZ7mHN/wCseQ1OfN7jkn0se5b+fH7fh/8ACyXDqvbqc2TARNE9TaveSZ4yayWV/wCQKbX27AV7X/KvXXkor03t/ofR+nDOYKx+u9x9yw/DrHU0ZMeOcHqfH2ZyuNgruda7N6313uGTB6n3GOPU4vbPSemx1U8PwYDJjwZMdWmT7xqbWEvI0zrKt1nTVV/eq+URW3/kF06KUItH2BWC4pWaSWbX4EXOQotOrGfNm9F7R6D4MkNe9ZPWen9T6mao9XHt2GsXoj0fV9SRmz5MmSsFB8jOK0Ak/NLm9Pl9vzZvQZ8X/jeq9F6n/wAXPjoOsVQEvUjVoNbYZnexQqufzf4PX5HFx6v0U+u9F7POX3PDgufjiEzemPU1k5jisGfgjJjyzjjH8nyNFH5p/dr9ZXvHumT1/T6vP6t9fednX+L1uGfU+nZ7JyOL4smOYLxvUcM1rhdOkSOrVSQvV6iCFMghSSFSVxxpmwINiLgIHI3+qySTqnbxHe4vfgr7P7D4rrLCDpEk11rX1/R+UU/+uS5NVU0U3vnpsP8A2SwBQsxo6nzy6aG2dTijVzVagLWa/eiLqmgmCxJKkfsp00T+UWsnyZP65pVJtk3P9aDoYncDS4wZGVl62fndQTAP6bH7iP31BBv7A25pQ2efci9PNJWUTTJ4HkmfkMg821u7p5DZ4SQKGTmtmyZHfc1UdsNHU3M1RXfXT/qb1Vksz+0W6/Lea2aQTdZP/bUa1lWeGrTWo5ZaJ8VPM6Jd1q+lvk7uEq762re26pYi++PrJP7EkD87KTbO53SH0ckKz1G6XLKLdO2zlWTel3WOuZqKZliNgTKjP1aWiut7uplXU71fn8WXHI31jZsgi0BDnUra7mqrU/WGp1juZo6o8TNizXxtYaHo5usn1d7vbqmz7msn6n9z0zUxSLrUxNeAmKvGanq3qrb8hUvNia8zNGu/2mbe53GHGkhfdCI/4xhsdhqtVE49c+Mlc7d7n5JZiKy645l/1pHyQ7CYSK6KKJx1Mhs1ksqNt1T1RRqBCWtaTyH5ZyVXMjrJ1qISXJrGz9UW50wzSb5b1Qi9KmDHkqZ6+2plvTMsTpO7spLrWvp+3Gi9aZVWL4+wFv59NIsEDI9jYck2Ue19Wb7WNRaCS6CqqZF2N9bP1qkH6yXLIP5awDjx45KicmWyvOu5xIzMPjmV5qSeXqn+xrma+RyGqiJyEkFlNz+q23+66QhKtHy+Tnt/LsGW5x7x3jj6c9cdS5OzrXAmM281PkfP6lPzOtVFJK05+XtfvvfQBLTV7QECCP5331Zm8mTlId47maJlKyUb1V7apkrZXRP66t8FGw9Njn5TJmLuenlTYJcsYb7idQeVJlSUf19Sjgsm9MHfxsVkZGayVUyoVk1kbamWx/c88iEt/Bnr5JrHHgOKpl5+WnTe+vDPNd2u5TTFAz+eZ15YFtwwIIIQS59m76qkQNjAuEYJLteNrTre+mly3UutROTk38caGVDpXVW1UsoWHFJy/nUeix4aIXHV7ISYvTkZob6WKtArpyWRM4oFBgyXz3pI31J5fjvIh/jq3ZDG/q0SH7mUpOZpk/On9BmJ+V6Jq8hhx5KmlxTk5V73AQE6d9dUu4Y2PifFVhGLja5Qt5Ea6umEnsFc3FMQfCxMa7T23ER8MLjmTBSFmKgd1zyCZKyKhE3xW/v3NVEHo3sfpX1vr/avRR7Z6z3N9Z6/23F/9LvQY6v13vGTL6rDjfRek9PLWbP6r1pkcGH4xu8r8UYqdb859BIp9b+UZ6YJxzkua1y3VnXzqPMv+QamieZyH1V/9DXPqX/kz0PqvbPZ/We/+/e0fwn/AJP/AJD/ABb272/5fU+on+V+wf8AGv8AKPdf477nj+KcuSL9l91wel939P6qcc5MHqvbfTOE7iKfkP6x1T0fhet1AGR06gZIDIh4/O2vR+HHqqAapNVPqIeco/a4zr0//mM/hvs38y/+iE/mHqvVeh9y95/lf8m/lP8AAf8Aj3+I5M+f1Pq/Zsfu/vM5/d/ffW+n9N6T0nt/t3p/4V/FvS5v4V6f22Lr1HpPffcPR+t9J6e/afQV63L81+w/x89d/Hf5h7r6j19+j9n9o9H/ABb0VBlw48XrvePeP5B6bH7d6DJ6Wr9Pd4z0Xpvd/X16nA1UT6D4qrFj9SfnoHvPsN+h/wCHP497j7/6X3GPff5V/wAh+5eu/jHp/dvXeux+tj+N+w+y+m9s9096Pas804/b/fPffWYPQYfdtse5+4fxv3T00I+2Vj/NJ/CMb6r2b/kr2T1fs3rve/b8v8N/+n94z3K/R+3ez+u/iPvHtHuHo/fPXRM25vQOL1HrvZ2Lx3Rj94cuNab+X5T4YH4b4Oo+s9Q09bo0Goo0+npnp0qj/wASDeSfA11dUvqEmkAGkodw1A7YGux/hvtX8lwf8Q//AER38fwYsL/Gf4rf/Gn8q9d6X1XoMnrcWL3TN/Kvcf4xg9f/AB71sYbwej9bn9n/AJD6+fUuP5H1vt/o5Q9Z6f0jhy+cfzXN/KcXrP437J/KfVe3+or+J/wf+Ne0ex5/bT0l4sv8c9V6DF797SObFg9IeurN6L3ovJ6zLM3lqqg7YHF6V/xx/Jf52eq/5K/i3t+H2/3v2n+ef8O+9eg/lHtPuvqsb6T2z0P8L9F6f+We2fyD2a8mDJg9V7n/ABn1f8a9NXtuXOZPURi9Z67DL/8AXues3nXvvvOX+Tfx7+L+r9x9H7j6j3L2f0vrP4Pf8p9T6y8/pv5H7P7F/wCLk9ijNXw+n+L138a9u9xn2POxWT/9G+n/AI/hfT4n0l5vXP4amqn47rEjp1UV9SnqUr8dH9zo0U0kgmD6un1GL2PIyqRpFwKQBVkD5nPZhdjrh82bFm0GbiV+lSU4W5NY5TVxQzUtOPJqiXH4o3+UcuRyJMsTUY/guXvHTv8AeWTzpH6GVO+kKhvVVsa9Li9PhMOOZvfNY0Ku4m5Zl+UuNszIkmjfmI19fzVZfVzjsZZ6Ex1l+O5kyld47y2Xzk6+rdapU/o8NHuCQPvta3vAEucrXGRLqW1QBxAgnfa7nWrXDizXNmTV9fHaE/5LpDFTqOql0wT1Za8i8xUZcsZZ2R18a4dLdbryGTdqDvxOR0xr7wVvTvWzjokoD6TmljUhlkqi2xtcn7JN7yTS5GSWpq1my8w0mTo3W8dczeRrnJZVmssS830duykqeurp4E32DAD3xxg76zSUAg7cwWAVbIhgha6v+H+y+6/yj1nuH8b9H6S/WZZ9r9299w4yTj08+ye3ZPX+t9RixVWKM1V6TBmyBBN3kxBJLoviPX4Dmp4nHD6icdzGOyc+QnRlOFyY6r5NzLMvI2zQan7P/wDoI/T4T/nGfVZocmL2v+A/8he6etw3gfUVm9Lg/juafW4qx8XhMdYc+THveoWzI8FJV/8Aojf+Es//ABn/ADf1OT0MV7l/DP5Djy+//wAP9z/8eX0/qfZfWY5z+lMPqt4MebN7dWSsHq/jj48GSazYouM8fnD0f6z0ul/Vav6d1D6T/Zo6vTJJHqqLFdOAwgRZ9nruo6Hr+Ho6gbpqNJP/AGxcQ7oiMKy18Xe/ey+j9q9nw5so5c/q4mcU0Fyy4rRm8dyziwVu2sw33NZJn4okvk/4x/AP5B/MvefSe1fx/wBv9R671XuGXI4cePHWX4sexvN6jLz8PpPSenxtZvUeoyXOH0mOWzLMzl+P6x9j/wCG/wCXf8nfyH2D+K/xX2q/fPc/X4/SZPUYsUPqMfpMG/HqPXzG8Ht3t+DDkyZvWescxGDFjl+TLWf5Pzbf8sfzn+F/8Lfxz3X/AIZ/4r969L7x7zm9LXt3/Kv/ACl7eRM+7+pw5Zc/8H/guckyYv4t6XJ/9b+7etx2V/IfU4yMXx+3Qf8Al+uP6v6urT8H8LT/AHfjKz6qhHp6NDA9fUIfpVqaSWTAOdYdT4eliutUdOCzBqIA3POIFtfK/wDLp9m/iuL1HtHtnqo9a+gm/T+p9zxs8e7+6THx+q/8Ghm83s+CxxelqCX1VBlYj5MWPF4fGL1Xunr8eKdfP6nZLW8lLlvparl4xh1brckSyJR4ve9e4X7j6n43aY4kxxIY45CuZT9tXCt08h5L5YW+s9B7Wfx72aPdMrM+s91x16f0mKo3kw4UWvUDNGQm7eceap4o+wcofn0PSHy0011eqsmn1VGCTHqWw3mwS151arqIBVALizYXaLIwmROva/8AhTD6g9u/5n9g9H6a30Xrv+IfXej909+w04z2jL6H+S/xv3D0PNz6n02CY95909N6f2eTLc4ryZ+SaYS+Q/kfp/Wf8Yew/wDEXvnp/W5j33F6j3H+cem9Rh9wzZX0vtr/ACbB/wDSv0mLFQx6T1GX1PsfqvXZvT7RjNf2si8ce4/8Te2T6n/6H/8Amftfs/oMeb+Xfz3/AJg/gP8ADfUe4J6uM/pPb32T3f3b2j0PzYYK9R6b3H3/ACxl9w9HGbHHqp9D6bLeH5PT4Ljyv/6IH1Pp7/nnvv8AG/Te6HvnsX/H/pPSfwz2P1eH0eL005j+L4vT+g9XWOeCIPWeu9P631WWfvef5fkvJM5chfjjqH4n4/r9Gil0f3a/WFNQ6fQo6QPqJVLq6pQDigkX11VfJ8PRUy6qaUijSGC8WUZH01f/AOUfbsv85/5S/m/p8voMntnsv8h/j3qP5j/FP/M9VeS49J7P7Lg939n9TjrP6iio9Z7feb23NnIy1mPTyT6jCPZ8t/xTOYPcvT0PxVOfHje95OaKlbZiq0Tz5dUSTZ9oEPqH3T1nrf5N7p/wNfpL9V7Bh/kP8S9P/Eb959Rr1OLJh/8AP95/iPvOEqIvJHoceOMWsF5CcVZa+XonHEfNX/0tz/x7+Ve4eye4Dj9b7X6nL6H1GLicVR6r0+QwlY+2QnJkmbhqJp20ao1+d/8AT6TT0h0KgGOkOmA2v7b6dRK4oCH01h1x/wBSjq0iqan6iwTFNVjhudjaVr63/wDoh/ec9es/4l/nfpDXpc/8U9p9HiyQepsyX7Pkv0fq95MlfepoxlY5yZsMxllnIuXKRzP8m96yfzD22fX4HHfuHtr/APTn2zHg9POXFj9CuTN6j0OOcfy3M4xfU5MRfxY8O6nJRMVOw/lXov8A76f/AKHmfUzOXL67/j3+UYZrPeXPbj9t/kWBKnFDj1MY/cfRNjrHJ1M1HUt/niv/AB77/l9Hk9NzF5vUeizf+RBWV5zemiUy+idfTJiSubxmIm5ylWTv7x8B0aT0DSKQer8J1+r0kf8Aj6nTgQaCCoC510dWs09UIqnrUUVHZoAn/iqanAi+vf8A1f8AOz/kz+Mem/jH8szFzeKH2b1+OfSub0fqp9Kekx4rgxFtXkwxHrWLrJy4qTfeR+WvcsPvf8M9y9R7b6osx+nqo9T6Zlk5KnbPn6xlgm4y46oSv0S1+ei/yv0+D2z3ScPt/eP2j35/+m38d9TS4p9F67Kdep9rcx8eGTB6oyenyGL7FY8F7HIDS9X6rH/N/QT6X1xz/KPacdY8WPJbNe4emwxy+n+RHNl9VNV3iqnjMHNSvR+dnw3To+GH/Sp/6FZJqoj5DUQzTsGgfOserX/cqmr/AKq/FLIJB88N/lrj/wD6Y+l9yxzXp6x4sjc1WFgmpVUyIt03OzFuYfk3ycllGve/TZfnX5MVUxkm5p+1UNWBM/HBBXNTtw0X48Zd857n6H1XtuZz4pyBj+mT4ojHWDJvq+4FfryuTHWnHT4+lH4fpve2yzPJ8tX+63WO2tM3FuTZRVd15/fNa+Q893pBJIaiLSOVjJAZtGuT1IkVXBA224FrvJ1v/XezHrMSxE4r5+aC3FMTjO3jueymhNw//Mk3OOhjQxWf0vp79N6qe9ZJmMmTrJViaj6XyuNkvIUzSNTpXtNh6f3fNgqsHqbq8TcQWNarHuQmLaiSbltZOJqpaiFOS76/0kZcGH1Xpz5itSWZVMUJVxvgfjuI6pJv9ItEaYoUmlNKqJG6v+sH6IKNmcbCwB3Ob7ZtrivXZsWSVrHY9687km0NxR+uClbTnTB1JrZp/Sepj0/uHetRf9hsDeauWZpknJx9WCl5uVKprj82HuQYvUZvCtjqWNJkr9y/blYort6qh8zv7QaGm8uModfEMfEaKZny6KKyV9gNbgWUqZ+t/l5EZy+L9rfcayJliTz+cP8Am1r/ALrGP/6Y5ajdGcjOfVh1cz3E6+tDU8hCjrx1qSaIaMm4Z3kIG62xS42dbYr41AOSa8aNPQ2cuZ9Rg9Mrq8X/ANa5Uq6aAKhfF3rWzf7doCjarJB1jxt8lTB46nrz9S8mzbfR5PGp3Wl2iSYTswDHbj9dloqIJ9TZJhozFsp/T6VvUZdseK1DM1UmltQaR25B3S0/ZXy0wFV8+TknxM7SLCXRJLrInk81v7BsNpvQfljLjtsAx1VQeSdgDBXVU7rI0dCSUlb11o/G+m9Jk9TlxYsWLzkZxeYXVrO8unbIHVd8+NaOQ6JNQR3pNicMReIsXxfUSSApssEQDt4OVvrcfxb2qPU+sfXZgPT+lflxNX4fVEjONQ0/EHdz5+xJNf7in/LfSGP3PNnN/F6vXqHIFTzlg16iC7f7FhkA8ozaqD+ej+h9NHoPTR6SOUxQ1Vs8ve3rM289LtBJV/XK7/Nb7p6afWei9ZiyEVdduC8mNujPBuHFySEWFSk76mUrnwPLT8R/13/igIiILiGTNrHGtfR8kSW2AJI5YMkTB1wBbJsCpfqT/wCxgqTR3OuNBVCDqa7JRqXMmLLlxRRcE9TPLU0AjL0o0ZDYf7k/rNed/mYftaP1/Vvy3srRCQT+me/6hy7GZf1VQrkrQNVOR5DeOSBnchVeCnUif2Qx0TUi/cXpBIYK4RBHGCojvjUjHMZ4/PCY0yJyRJireaSGjW4ZEIOq8FdE7k50leNPhX3YbcaJcxDzRKUCdLcrt5v5A87Dw7VmOe5p0h9vtVKv1mqwm434UB5Nho0fYn4ox46fJvi4ev1uo5xUfufAtBL9vH61+NREwPaCbov6eNUAUHICe9gTdH9hdaCYz6HLIVFyFeOmjnkSud4zWp1B0aNU93+M0ZOZctRXXZT9PHgoip2O15kknHR0Pn7M5eXHy8+IxkP7iteJiq81f7K/QVI9aQr8TGSjUYfGsb1W9t60pjapVmtAsmpgkNRum0hcJf8AcUcgLyztaDogES7HjFrWN2pGMzVM0SaXgFD5Dh3rNe0J8T11P2Hz/wDVH4c5Hf8AW5DWJaOf8jrX7WJ/31QSy+OQk/F4cj8uSq8mQ+JUbYuiHU0zIxqV+kib0TK0Nluaiakg5JxO8b/7K8TkQfr9Wt3+9ynDr8Kd2sIXhRkAyUhcCdAxDxs7IG/YQN3sDVZK1kmKYSumHXMJ05K889b7+WSd68vh3PXp5aTFz1vHR/UOwQbHZA70a653LPOp/CmAy5biopcfe3ze6IHlJjrmunQsDWjxeheOB61OwKSjR1WPXJZSKnladNPiqlevxg7lluVIYXPG310NI4tswFsY37uTbTIxGzQKQvV1PNadHVUaq6OQ5Qr6686fxeSMeOZcuRrdE8nFGhnnd/8AXH4skQ2Ts6H6KqvoBVmmZE3B9uNTVOwxnNARool2IlMQ9XkigTdstH9GRmQyV4qEpkAOadSxRuhiykxCI9QAUBN+Y0MSO3HGL/VWAU6tT1fJyFTeOCpomUENNv2vZ42STeuaB80GYzW6yBJNzA+Zl8MLkF+TVHM7PCnCdb/Cx5Xzt2tGOVleFI8NV54H9uitG0/2nlrWLro6nmStU9Oh22lHhEXW9b/+HdAhST238rLPvpmRHGeL38Fv3ekVkqWDIxePmIWOfoqHOZpqqlJ+y8VS9edAnmP8cy6DuP6zqal8U2z5oQHwf0BfL+ASm+Lvmqm06mqqPrS0m4JHTHWNJb/+GpljhNLj/wAk97qHmrxiDoVo1sr6p4HrWrK/EAfm2QlSzPJVoG+1hNgzkHdXsyULcO2CPiVX7UfUo4CmgribunrdDJUvmYApoKoa6DwFFV40VabPH2a1vEHk0E+UFUZwk25GBlmmzogvs0VSa+0S6edbpCeQ5r8zwZVGb7p03KQKnOSXXJPX6QGt1s3R+WwhaCAFDRE70ntH01WAWNkL45AFxbaYAc0JG9PN5GGmq6oqCqdRuSdMzVSsh9plnfJam8YrOOoQYyMjXxmr/ttrwSc0lMmr61NUOPWOLjfispJX2AlOjvTMv6AZNC3UgV4Nr5J555BiR1xNZNk7rzsKdafH2lH9H4MD8LsIIH5SRsZ2k6MRLTd8A7wLHPnTpkTJrRNNNCtczzIURRs1ueCd1J/8K/lacUVjA1ivE8w8yTkqdbea3utp41Hfxs3pnHSbFuTLWStTRRjHaTojVUuqprzxctUtO9KT+QZPqVUjsjHpih3R9Mjbp/ajaFaNsqaGFDCACwyyEYJGItovJELeDZQ177DUZMjiuvjOgoJ6K0Upqx8BjhlC4g1tJj+3QmeKCKWeKop0QL9Dm+qN7WhR065NfVrLrdT/AKPEZEKpr9Pl39unrpfOn+vVP5nxxT9f8NN1WniN75muKfKdpPP/APA63KpklDG4Lx2t3ZFxpSUBcK+Ruf0vJix0VYvlxQxrQwMVYXz/AFSJqdz4uTGB+k2Esou/T1ZPjgnX7amspFao87qh+vO+OidVqoNWIfqAeOOnn6zfPh6nbZVT+/E7HkNO1V+qpCIx0WOKWvsa2zU9CDX6qVrkmZ8lftoDpx6iZ7l2/wDJ35z5cZmxV9uPmtJZQib6U7w9TVUU3x1uqccsmv3wIcpv/XNCbij8yfi3W8laGp+Rh1RdGp3SrqlkY+odSB+Kz5qyZdVPXgxsEXUyvnc12tDRf36U0v8A87YOSiENFYyPBS8V46ZLfoTP9zzpF1P7l0tBpoMTcbIfnNgIKBwL7e2AAPcjlCAzFfU1NRM6yEtEg1XMR8e8lbofJNc9UkwSZU2ONxcnWJ+j8W2lp65lN0a5a2Fyb0coMKyGJL1LLqZqWWS83/z8u6tmnpf/AKrXC6JUbyY41SFVyQTEtVWyeb2Pl8Vv/v8AXwO9fjJATRSssi6EfmAdUYAEn+YsGmIm2mQ5J/cxtyVh6Jd9UTzV5KqNya0Ud9AfUZvcJGWJ20HItIEtGbeslK0JP9qitOmFn6Mx1FbN6+o0uo+Vn7T3va9O2lDaVH10NPhIk/3P+hCnHN/aPuOiJsWZkNHklqh/KEmkQsrn7cTOznSbKh4RTayowiYxoDKma9B9tY5pGdNEzz1a7jcptOlNAEeSar5I2v0Jl+u5nJ3PN7fGuu/to/VAa1+ZezzXL3Yzeinds6asSQKKOddeXQ0v4ck7oPuxie6qSd5R8PVbcmRaKll5UfBUz+VSEVuWYRAuBviTOMaJiRBatgBbBPdWLT0dTcn1cd/rVFP1V3sr6pEP+mNHRW3dfgzh2rd6ErIU72zuaMTVbnauzidadS/1/IYqrxBkvqga3Vxqe/vjDXJu05J63u9ro0Ss5shW6HxKSw44rjxFVScxTWw/SbNa26IEhhAKkWOR9jad3pgSuRtNp9wdsvU4cOKBYiSv9FMa+OidfG7k8aOedvSA0Kfg7m7qfHRdUUnx7n986TekVlkNqzzKbYqcd1jxhvXn5XkKmZK47o01W664Jl8w81I/hX8eNKyQ+YnGwy/SmZJyFr0DyhT1bM7P6z+O1khndIZAj3Ki41SUwgfEEEQQl9QMDU4cxf8A9TsDC/WiopBG7ulD/Tb51P2B/JySV6j+tXkPTyp1bv6zu5yfppJOdFbd/wCpUiZ5qbmlqmX7V9KMldP3NTodc9y7pQ31yPp5yCpReLHEjj4cdpo8+CZklORfO+TajSJpAO4FgkgQDeSdozBL0wYIU43sSOz84yhpMVWJpy4zV1xDbV3E3yjpcT8cvSW/bYs883LITln7TUhTq8hzKTQGPV7ZlXQSM63jARr8zJRqYMnBVRGRmEHdTzd0701Wy1GqdmuXQ8v6lfWf/XiN4+fuAdi+JnwhTt6PE7KfwpSkwEd7gKFMcZmY1AkJT8q5JIHu2MbnQlKNTJoj4365IVZFyLO9EhA3Wrb5nQHmYv4EZSXJyrUcE5cj/ZqWSI+vgSl1Szp0FWpoNrGcOqU3NW/aKuaQiua5lE+361+1/GEksuTH2c5PBRTKRizVb5J1uaA0oyv11qIXHFpEKRZ34mQ2BIF/cC4je+XuQdMe48a7OyY01WlJrGuU1uChNSaDbz5o/K8yFVbluWslzy/BUGbY65/0SJ9k7CsmpoqdsaiJ3TOqoSk6C7STHTuT/Hpuf1rTU+U2QzW7708f5C667++7qYORyAHx3N/I/Udn9gokEFASjcSNpIYzY+RqkkZBnPb/AEsCbRqZ8yfIHW5x94tXFSydFz5sGK1d+egB/W/xeTDjn+y6qii5qKnmkIxP1OpY8hzX+wjaBmO6it8VVFGPddwqOxvVG5a3oHpdzzvoWY/koyvLUdVMrP3xnmt/auDFP3OpddPUpyoGUMi4KjsbnFlyZehtU/lMAWOIzAZZ1WFdLLsy6nRQzp/VVQ6jxt1ogESuT8d/kuqotyBxmUp3EunxRj19U5iR53RYnVanJNTms4KrHKta56QkckT0zksyHPXWtC/Wf3H2xzEtMuSore7OSg1N1PPxyIbkHZ15daqbRt4sQohyyJmZB1IOJTN42+55LjbTMsjONOVJx5KmedOOV3aV1u+eSjWrL/8AytiZdZGSJ1yY98sx8r9fkC7+pyUdvmIEHx9pyDaz0WtKa3EVj1/6iteXmaCYmZZVDrbWYjeXJ9Tj76cgvE7hWemarHvfPP6aZ1P6b9RYQQ42QWJvfvjTJsAlCMDsTzN3ouquaioC5vm7DVVTMmrqwRTtbOfJAE1O0MGPFdUWMzNUSGuSlk+OmuWua3IHK19B70/hVHyc9f233bd3DWKY4yQSvKPPJNVqp/ueF/JySBah9qEcX1lx5MX1clxVfGL00eej763OzbIJJi+ALRZG/tqlZq+0OBEK07EaY3bGM8xLU4qumv3s265tnCFVi3NeTmX7SiHqLsrFqJ4PjEkqZLmU+SOapxzJFy7nU0rzYG8jfx4q+i8cDMeIqq1uqp/vFGr+yjycoSK8kDkxrpqoLvtgm/7VeM4Hqbme4nZzy6+tP5PqHpiWRew/D9B/xGJ1TdJAz/8Abcf4uJx6ZC5Znx5bq7uTmXFjmkGCdErNC/YdTfW60tf/AGPRcnhg8yQj05GsW+maWa3T4CK5KmuXVb0qeslNT/hJO9szHdQH9JrtT7AwsjzXnYqyqkaGnJ19kZlYlNr8kV/i1q5NiQrUyy/iNQLYN0EINrm6A7e+pFUYJBycxlvufTPpTtpef7pRQXirfUjqrn9464pqqv6OrXbua827yOctMZJrv5fGTwEozPNfJ1WvsaT+5Or+2qZxmFxzkEN6moySF7+qs4509u9Y6MjVNX/9yzJP3p1WOks61ONyTAS9bppq6Bmv9hxvqR/JABIqtLWBaV9keBpCUaVJmWppyOLG6I509qIdk7qroZmIvnIycZBj6k6VGhZla1zRRSeaqq1Wi+SjxqmgMT0H0KadzJqf7bQ/H7mMs3HguXeNN4imjiWtkeKPrXlhHb/8Le0+0K9k7I5W1nz01/safkPOtD+nZXIsN4wH7CDs/eSqRxBRJtB7GLKdxrPTJiKl8JdQAbR2cy1QT8avPkRrrYrR+WcjiHHkMWK8moi6YeZ7o/ydNaXwnZrk8/0k3VC2T5IJ5yzB5k8yhVZe/NSrrpDf65lhr8aUZKqtExEBRRW645+2OErwP1ikOYGeT/U0mmmn03xThCJLPAI3Kwjp0qyPpKUYf5i1gD4RZ3cQFMHUYytU1/Xw3UuQ4ejpWdhtedqnVb5OWonaE8ysc6ybo8ujnxPVUJP7+rWZx4yUL+TJjmK1N3MUzxkcmwjjhdM/Wqp58SEGW57up5yOaoMnD0HhKVqNx9fq/vJW+hJpETJBzt4gJXsiAEfewQSGTARILJEBb8EY86WXcW/JN1OW54uaD61RUxVSTEQM0knNSnYJ4bELeTLVVJxE4w1qjn456gsJOnYZAN0cEnXQMf8Aj+WSpaDElztMib+QyVdToejwdElHnQLcRuq66amqU/r8pJPRXku6dKPGqfCSiuRJShGxwxAeSaSrhD75lsAGBwHf6sKQjGrHGOseXdLNdVO0hqdTsrrTytQkSMt+dzuH8ZihSQhyEUk0V/lMf+OHFkfkp/8Ah/rV7Z8/1XATEbre6+TGV118INE0sr41uZeYr/vW56hdxCiZWKbm4uKxExDR/jxuuynWz6nd7kZhkOPqE0jJqhmVxEyFOX50y/l7TZkAg8iRJ8xOrmSat64VjJESSvkIOWb20/6+yEJJOQCS2wRiiRXqrotorsjuU+7uTmVfrW7KepE5/KkXc0JoOjHqy12cPVH6VSvvso09C91diCfmv7gJ0iaCWa3I0OOkakDHrWrqUX68fUqFrh2GVw877mY1mZleb/NywGiE3e1wddT7RNHt38iuspj9Fl9Fh9HfqHJkwzk9ZfrcXqfT+mwpJF1kPS5MlY45usWHLcAw9B6v0/t/p8ftPo/SfF6n1k+i9R7j7t6vBncmKa9wzR/4nocVcTqvS4MZlzdIOb1CaswysXjy+o/jfpwx1WP038iyVm4bw/8AkZPUe3RXpRP1kvBWLNxXhwXlrmKb7/M9b7Zi9n9xyeh7h9T6b0PoY9xici48XuOXBPqc/ompDHkv0pkj0vqaLoPUY8sF3jmd+NXU+vV83p+Y1CkCPkAAZnJnc9hqyiBKaE7sHIOWdjg41sfQ+3Y8ns38s9XlzmPDj9D7T6HHhhxTk/8AO9X7t6evT5iWVnDix+m9WVmnJGTF8uL/ANkZKJ1vrvXeq9x9Thy+q9NWC/S+0+0+hwjkbnJi9L6fnHmrv/IT6unsxdMN6gOgr8u+g9RXpvbP5P6ir3gfb/R+31g6YxvqfXe44X0tG8Dhcnp59P6jNi+Sep+OskNayBrfUe5PueTBn9R6eMOTB6H0foNwieocE1jw+pcmWvkp+PnHTsnmeZ1Uh+TTQf7tdRAqArqUgT6KWLOHddttFgA5SnYHcA8rMRrY+z58eP3T02P1npcnrPQ+rnP6H13pMN5Yy+o9Fn9Pc56jJPy8ZcRrNhy5Yv4cmGMmTFVYw/NJ6z1D6/Nn9yqpMXr7yV6TF1FZfTx6eD0+L003jmOHFi5JkhPjJZtNzGx9D6zJ6D3D0vrseKbr0XqsOVx0ZOc8zkxzkxXM83knNHeHfjY/EnHfR+7/AP0rxTk9v9L6TP6P1/t/vXr8mXJ6iYpr2/1OPBD6T1NYeDCe3ZMMc43F/lr1GWdEYZbbFHXpIpJNSF2KAWKoCkH0yngK2n/ibXJAZTjdFCR7AStc1hwnCuzVTXTY8w+HHf8AtP01OtU+B1R+JyIliBXy1x/pu9hElW71vfFmqpl/VDTao3ckZBDwypONkv7w15FAPC66Kkpmh/Ndny5MtJveObI+MqoVk4aqfvZNeDe9wyLOpR9Hp1JWUDE1Fc7eb21IsbYy7yD7wNuCtTW82TJf+PoGWPr1M/REqulrbsoJK/pci9/ld5SzxWmoKo+//WOur0GOaXe4KipPEspTKFuKG/NfbH3VVEbC45BLX6Sxt13rfLor5mflyl6dxaVM8z2/VHbS7qbZJ31+t9Y5TtpqAkRHAJgDZ787PE3AA+igR74IN7arzNP00uq5Sfrd/wDVqpW2ip+vWpas8hTz+RGsU6uubmkl5pKjwi5a+vxrNvk54GdNQqyAuN5a/wAfCxJTUnUyDa85HpKmTe/HJreldZHGSkfVJw9M/wBK/wDwlfYI51cl3u2R0Mx50oNo4+vBbxJeNSbR4/bPDsUlOkZqZphNpWOZo/8AkDmqFiWJZdXI+dEwaqqLD4bnm7hysivPx5MmjYzclY68gmtXolL8MZmcmVSp+mIN5A8M/wB9HmNjuY5qf61H2dAG5qd1rUHPncbufFVeNN2XKn+uteQ0IjfYBSWBjAuJvi5A1ObWAuuLgQTjuXFhbzdFzbjagTGp/jB+QC1ei/EstXzKp+2dfl/Eup6xyxQQFDXNOucjZVNQUrvQc6ojxz+a0qbqTlxzNRFXJS7jb0FdJjvndWm/CEtRv82OI5j/AKVTNZJvZ1OPSk/JT/aK19akNvLrdfmZukZKBe5ViJwb4hIaAGRHMnsn34YLhauYolrRQ+as3zpNnWOq1O+nX0nwrUjK7djgkcjPJe7qsazEcfqZn7L1FVTzUylVP2qFdauDanyba/yhTp4XusSsgq/uImTdWrvlNp6bJbUs5PjMc6yV9r+Xj4zmZvqqxyElWcVoeu9Snm9eukAgpMiNoDG298KNaUm7375xmIG3nXR4J6U4aAMFeDH8mRrfV99U7OgXQUm5rlPzrPb8a/QHKTbjx2TIzFTUkVVnDUzCyzLunRQVt5j0BhqqqUYjFSVRzNrUXDA01VHQVe5oo5m4Tddh6I7MaQhzhxnNV95pWbJnpmprW7/cea100/nzvxlZ9RABSBbTIiRvyGH510dMAelKSADMQ4TasCXYjE9j7ZDGOamIScKZKuZach8dOQpqNo2DlDyk4edz9Ppf/hr3v27+N/w3/wCiE91z+sj/AOm2f/jD+N+w+x84/UnuVx/If+Tv4Zi98PbMvpi79N6zL7B6L12HMxiq69ty+4Y2cuO8svzf7fjnWMx/Wpi8bOSmJhnYVEBKlLzilAfvD+in6h/k/wDCvfvbf+Kf+BvYf4f7X7j7t7v/AMtel98/nXqcnsXpa9R7x7j/ACWP5775/wAdfxX+O4s2L0x6vNi9l9t9mz+u9H7L6XJ6zPg9b/J/d/WZCY9T6dxfD/1zq9M9Pp/D11in+91aJJ+X09P/AK1Qqi1VNBBvjbXr/DQDlWEEkkUikSslyDEb65j/AJD/AItf8S9x9g9r9b66fUe+5v4f7Z75776P1GT1PqH2j1v8h9T6n3rD7Sz6vFjze35p9B6r27J6v2jMX6r0efLk9Hm9RmqYyfj/APj31XrfT+z/APMPtvtftHuHunr/AOV/8Teu9mr1voPVnpq9o9q9D/LP4d/I/wCQe4NZSsdehn2P2L1mD1N3zhx+nvLkyX8eLKNH/lfL67N/yn/yFl92/kmT+Yerx/y33b0Wb+ROTUe65PS5D0c+oi8cRD6WX07Pp+FmccGfBdwLfZf8We4+i9o9P/yW5IvN7p71/wARfyz2P+PxFZEwe5ev9T7Fm9XjcuGL9RjzZP4/6L3ucePEJWZmaicX2nyOoaj/AE7pmoDqE/2+oh8tP46a2LKkJq6hW1p+LqETSJAUkD0kBQZNmC9db/wZ/NvQ+w/8tfwb3P3/ANAYf4z/ACX+NP8AxN/McdRfuvqvd/Yf5f7N7p/x56/3zHGF9O+p9b6Z90w+64sBVeqw+o9DhucbmawXzv8AMf5J/FvcP+JP4j/Df/C9l9o/m/8ABf51/K/W48/tWD1hX8p/i/8AM/bvbcv/AJ38g9Z6vGfF73/H/c/45/4x6dHO+3+5+lxdZK9Hl+Sr/HP5V7P7D6//AIn9+x+g9X6n3D/jz3z03vnqPczNly5/dn2f+XV/IPRei9vx4IxPw+ij0j6WoqsWW/U1jx3/AOSYog90/wCSP+MP4f8Axf1n/wBFt6X0HrPRe9+k9uzf8cfzb/i71F5q9Z7t/wDed/N/5z6D3X2737/6YTFel9MZv4h/KfQeh949tj48k+u9XMXUfFcYeCqro9H4/pdTq9Pq011f2T0h06j6DVT1v7IeDSKeuSWUpla0poB6VUg39UIWFXE/IWeYevhDJMvp8xn9QhV/JiaeqmJBi4kYhVqPrGOvqVeFx5Hc6NjIs8sZk7JVbZ4dY7qyeZrDzJZy0NSM1WS5Og9bhTJknaTiPm+ValyA3rHh6K/x0OkiuXzYzkhPzT+on49k5AvJDdBl/wAWrOvggnW+ieiakqwyG0qfz6p2RmPr6XMK2NebWLhECDOJENsEDbbIWtZmljcV6or5N78ROT4qCzEXYTLsvHjiSMbNZKKHJqKhWEZkiUJML9amZpkZVdTTP3q8n7i96h8z+DnzGpSjU3jKdeKea5vm5yLjPI7oWZ41zMuRJbqkx4cn9Zpwm5bZanJRXJjV3TlOtTcUz0WTYiJMCNmhhpSWw+cSmTJhShAAA5HLai+vuP8A+gp9Vi9L/wAgfz/1NYMGaPTf8A/8smLNR6fHHpsuT2T0eGfUZrzfLJDPqMkXXw5KzzeOMWNq4qU+n/569QfxT2z+H/8AKf8ADq/5A/449D6vP6r+Ie74vcfU+i/kf8ay4PU4Y9x9N7P7tHps2D1HpZCsp7b6jDlw+lj1GDPFY+U/OP8A/oVPR5/U+4f85+4Rh9R6ivbv+CP5NiPMzBl95/kv8P8AZyEnFmgxFepy0NzBGSCu2MlS91/xn/BPQ/zv/i3+beg9Veb3D3L+BfyT2z+X4Qx+qvJh9l959Meg94j0s4anHv0vqPSek9Tmy/FjwRY3lyTOaYv5L4uj4X/33xnW+JpNQ6dXwtHrpJor6TYFdNVKNJdYBRMBHXofD+urp0U0Kkn1mQEUmCJFhjOkfyb/AOiZf4z/AAb3D+B/8OfxPP8AwX0X8m9vr0Hu/wDIsmfN6r+Z+54PV45+f0XqfeLwYX0Xt1OGcl+l9PjmckW/DifTfJmn81f5f7V6rB6rE+rZfk5qrx5ExzlS+oqYhqq8FeoRL5l3zvT+iPvH/HEfxTL6D1Hu/o49f6D3DEeo9q91rE5vR58F4cV+njF6rNkxlep9tXJlrBNPOSK1rJU68P8A/vH9R/PP5Rv0/Ee1+ivLjZyehylI5Mk4smXktjJ6nJlJx5qybq/lIXirn6b+jVf0/wCDo6nW6NAFBdfV+IqrNfU6lQSFVdRNRIDApZAgALXL8X0+t1fTRUXakU2FLIdlf7Y14D/x5/x/k979xxZPVQYfa8Hp69Z671VS5pw+hgq8uXNk048NVyRi6olbiGXaul/lPuH/ANPf5PcekmMPofRRj9J7fgnJrBhw+nfiwfWmiKo/zcY6eclB1NRXP2N/zP7Jh/4m/hv/AN63o885PcvcME4feM+sRdemr0sZsXpsWT0F6/8ADL6uvl5id844v5JT5C/if8b9X7xkx4vTzWTL63MYMUTOJusmfJhxvyp1GPGZMshPNm6ljcvM/Q/0/wCKPxlPU+JpHp6RdHR9SBIpHpPUUqYHAttw9fono+joUAmol1kIzAQBUAuXbX1RX8nvF7B/wJ/x76b+O+8fxr+GYvYMf/KP8z949Ng9Kep/kPu/tvvHv3q/dP5hHuWdGvRezeze1em9k9rbx5M/tuDFZ6T1F4/U5sJ8a++el9Xf/me5+qzyej9y9y9X7n6W8lXd+sxZsnqMlXlrmJzQ5prHeY+Sqvoq7aqsn1Lk/n/uX8j9r/5X90/k/oPbf4/7F/Gf4B7J/wAS/wAV/j+D0MHp/as3unvXtPsvp/Q+35ctVXo/cvVe0e0++e/e5er9Rgn1ub1XqPcOMsHq80Hzp/yyZvZ/5L6P+B4cl+o/+9H2/wBH7B61c8Z5fXVhwe4+6ZcWSKxxeKvV+tyR6XIw5ZwY9VMrWl/S/wDodeuirpiiusk1EVeqmo11Hq1VmoyyOt06CoHphCNV8TUKunQTUTFIAEf9qIbI+WoiDzJ11jXuPvv/AA3/ABK/Y8uf1Xuv8W/l38l/jPqMfovkxZ/R+j/k8e2fyH+PWeo+ScOLJm9x9N7/AIvTVkCs3qfTOHGXWTJZwP8AyfOX0/8AyP75k9Zmg9d/9M59L65HqK9dgwemx+uzOaYxfbL6svJknLGLJPVTkgyHR6B/x3m/kn8I9+zfxX1s+r9DX8swe1//AEqyYckYMOP+Qe2+o/8Apn/EvcnNmxOOsX/0wx5fbaz4ysb6f1/qdXuGLu/85+53/LPRfxH+Z+t9m/8ApX7/APyDF73l/kPrPgnF6X1fvPtHv/rPR+sz4dN5vWRlx+r9Jly5fU5vUZ8VkROT/wAT4seHr6VVXS+K/tf9Oro1Hq1UdQH5n1TT1PS3b1U9YQSgAFfU1UivoH1MV0eh0kEIUgAgckEO2+Rr0r/jHLl97/47/wCR/wCJTgzeon3H2Cc+PJh7P8vs+bD6ovIVVGeamslVnvBc48W2qx5Jlr4s9PWX2D3vJ6axi8PqmOdszkZyEonMJGUPD53NaN46mX6p/wDofP5Dg9H/ACr22vUKek9Tgze2er+rkLr12J9LlvNicjisnHkMu8y/HGL5GMuOb78i/wCdP4hk/jX8q9SlPOTLlYqZmp5jLbgubx4uL7xR3ZB4OqhnHWNF8IP7H9Q+M6KdPXHT69J3IHorE/8AaAcvnT+J+fodHqC/S+V/9rBEAeAWEp10ZXp/f/YJ9jyND6ms3rf48wVd+m96yYZMvo6qZ59PPr8RPxmPeSfU4MNTbo/PL/T+vzz6kxuQ9L/Ifb7YHj4n1WLA6PLXZ62Mk81KF0jGTr/tZ/jvvjm9MYMmSsfHx459QVxfp/VY0rH6iGqqhhf/AGxJWpnwhv8AL38l9sy+9emyfyL0Ljx+9e2+PeMeLH8bWQd4PdcXJ2x6/W89s/FHqDak5YD0aaRRUaTFNRYdgY+lWRMznWBr9dIqpCNIUAs28wDblPa98npf5KtDhwfyRj469PX+D0vuvjy3bJOH3FzeHtMWdPtP2rrzP3r2DN6f1Dk9NL6b1Vl1m9NTIVUWxlxT/wB4SiCYZKT93KoWvS+4Pr9mTJHp/d8Izphj56hAySuk9V8njRvfl8zR11fpPd/T+8r7Z/IGsXuUkY/R+60J4JcRg9YhhPh7Woyj8qnNeSvyxQen8wmgp0kgkSJBLKE/LgPGoJFYwCUik4XzHfAA/bXkl57xzk9JnGc0JHN/ax5IWVa7xzejUyLqa2MjW89o95cDPpMyuLbN01ucmNDHsH45VfOOwFd6n5ZB2/8AI/49U5r3iuLlbx5ham4iqDgaKzY631NFPZtEQfzgsvprh5qTHeOgmq15j9VzP23NOnRzNn+N19cjYVSdjIPtL/l++slV06pm0m4a2F75/NdX7z6bHZGXDzeHLCRU4oZ3dNTXUNB8QveqqpGmSprf5x3qDjxYHiZsmMkHf65t2cPxrv8AsofpPzoPb/cceGf/AKXevPk9Hd6wUN/4MtSTOSa3jlx2tUS8givmfsXuXtvw6bnGRf2x0BkmpybTKkupSTqgpealkCQCO8X7ILxN74AvpEkljafpcZ5xxfXPYtvWOpDB6mfp8RuXJJ1itqkx9XSixrZZz9mpQjJinpmK3rmmgTHdUaOhmQhmvAKeTQeKblZ6AedJKu8S5o1Pn+9BJQeGeZlmp15/AzYiMmOonWPPrKaon7E/5MUlDuig/pfno3SgjDQtsJQFmtlBC+2oAYwc/wCh9+ZWyczGRluGuamLzAb0CLTQ7l8bs5/U8G5E23s/q59H7l6FywEZesPWmq5yzxjs5ZmKKEURJf01sdZOEtANdpf2ZZ2hqE1qjyIS8oE7N/Sv6iqnJGQZ7xk41IsZrY9ieZQnzYaWWfGq/FUqgRi9u1kJgWATTek0W+Pf0t2x45sNey56efvMFacOOuDwuv8AJ1N8hTNPW2qd6nprWnyN46et3UtTjzSKoxyJVQxUE9PU6Nga3Fjntvq69Z6H0+WwzXwxmWSUzTOQacsteZ1ORFqhS0qqdxkqrz2eL1GSJxpQNiacYvm668US0vWwPH559iaRMkGM5Zmy3iLCddAMAiphWv8AMQP9BS+Drz4jDhgJkasnSaNVRIHQczEsvjXetI6PxeS8hRxPMQk19Xd06n5Mqo1Dw7XnZqUSU/BM3NM0FTet1QpjqyQrs0a3LrXO/wDqd7F0VNqXLs3HfIdW8n2br/aqVs6rkOKN/n3wLEWiywis99j3BWIULYLGPrGLnU48kyw018SBmnjqFSdHUp0HNH1vs+0hU7j8yDGNa2nynGRkgT+kY/O3j9u8cz+r8HiZnsT9E8wE+AluUYAVXpRmpBrX7lRqL9RkYAx6epxuitlvgyBvnYbHImxf67Py2IcAWB7AAew7NvTcXIVl4szxsvopo+PQM18mqlUqiQ2PaEhKPIz4F587PxBOMpyUd7OjSLPVB8f2JCetNu+sfX12Ifg91K6tejK/Z/3vfxjYx31uRk0VvyNMp5L8RqmP/X9daxtFama33vsVdnOupFalIg23Cc4B4x2zGmfFh9h9rb7udRNZMW2PJ3zINPx0JwtuuSABalJ81yC7dOXLdBcgTOqP6z8kpJZuhblt0+Or+odEUDp6qslSQ9EwFJ2E/bWSp21pSmln7funlnnETMuniC++ZCmarWN78rX9a0JTPIFH5QAQlUi7v3m36WEQLMjIfiV7B5iIWp7/AMtFLb8v01vG9bn49tUfVZrTJoetjtPxvGEd00G6ydbxsa3z8RVctDR/v90vnaaTVuS+hnGfp3UytDsyPdWhPWievIcpzPQZdAuWN0V8RkPrNFGvLXkKd02HneuPr+OLZjG6X58Z7l3dD2DN7l+8spJnInJZc2E8vjbttxkhi3YNjPRsmd+StIfglE/3CU6wEsNG/wBDjXf9mfJWiQrfScr6zziif6taknZTRlaAbuuWZ2U73smNBr6/iquYx/IxF1k56frWrpLiy/qIFVrbsZLoVPyX7hvsrodyVazWlC232x983LELQy3X2x/HSMxZezWToPkYN0X9t91X711/pMPlN1ZM3KaX/ZOt0zaB0rwg9uj/AB70ljGsXUDPNfeVkbqfNzqDdSbOdVr+s7j9/gW1cyGFl6g1vyu6BvUd/E8kj/8AcBRXJ+NIZssgKJ/SY0xH0Me2ytYvN7aPHEyZCoXrqYVBH68y1TP0V2eCl8vNCfhkfW8bH+6yDXOgnXWCZpkqKnkgkn+tFM11+TRUndPUrxNTXiRJPvVb1xydUJWkdUC/gbfDRUgE735saCuy/NxQ8mvGT9J0S/lhQEYErI3JQgb8sHOqBAH8aCGyveexLGk1OSSnj6F0VUlTL+vNDOx5H775a14qeq/Gzb27NbwS/bmr0SP2711NU9aOq+vK/oSUo8Y9IzKzYFUOqm4UQenmR+4E6KDSbnJdDixsaqcVaU3ve6DzXx75lfAB94/7fiLBKmxA+1s8vyXqWiUNpwPKBlwYjNtWGwjFuyy0+0klzXit5Mog2MLQy0mqnbr8cuntMfXJAarWw+uX5DT/AG2OQDrXiXyfivjkX46MaPTN1JGThDUipp2ctc0LZVG/I5MpA0z9qQ6dUrWuKpaTnfVm6aPP1aVRoewg4CnkrfscgBKhVYAUbXsjDBI+0RlJgiKrFkcldY0uip6Z4Lya8E3Fajk2VHNPD+PxvDPn7/FqlJ19VCqt8XVEhskadjpNislVcEKHVRzkjlNc+LvYv78KRjCa4NbdFNTgkMp5Z5K11VNEktU/UXVc2Isjs8LTFXzTASDVypY3y42O7ftaF+JeytkMK86gyzG+t6Bmn4q25tnN63rqmn7DLspDUSC7YrHibkWmDuXg2P6u3alnS3idV8fOuYCXVY+fihCeWgGW+WjPVleeU/vz/oohQBN3kkPE5XUS1PlFThdOPXNFbn/ZJfmqQohS47SJHDMC9oEm+mEywd5tfjbOLTAWVXG6sbmnxUq8dy61l2FAl7nWzzXmjyIXQjH2xXu7ig+SCJlRpWkZjr/TNfYh2mTObzo+Tp56fIVl0+E5kYr60Ecjpg6aaDLVYyQ3O/rkSamt1Wu7s432D3UhsNTPl0KHcQMSQr+eYd0Ybbjb8sGCNmSdjnVgMMd2B/VGWAa+whHT5emf/nVbDxJvJcZTylLjKnQaBTiMlUczr66NefPO11+I2vP15qYKjck46mArztd9WCmgsHYafw567ysk5C2Edc/GajnV9bqJTgJKOqKjygJtQESo+/2UWYONTtwkH2tzLEXiyb8ShW9txRM0+Kmgk+7etx4DsnXklJB/KpVzlrx3DlZp40wrPFS1UxLM9Do56GZOqdlnX5xnJwE9bnc9TKiFn96oBF0UiJygYTOp+QmWuchpgmwJ3C02pWluvMoVVMkn4ySakBYja1gELlou4vjSNbgX2CYtw4LJtvo0KnRqagftpx/ICHKu+mtzsE6PHW5Fb6XGTFEpu91RJN842Zok3MzsZNgJ0/oU/Jr6Es7rqv8AfKY2yalnJ45B6mfCmqSFo5DDRzQ9cmYj7KJ1JuLaXqPGvAniug3X5VI+YdiJWQFMiO7bjAoXAXHsllizX02wpSnmo+yZKWZ8TqMmiuvrDR5A47mFKkpby6mrhBiYKJCf8miapVrVQdNgeB8KFOZYW4ibCceObYNSZU8aVnd7NefoIJ/bwQdhof3zM0w1WPGssKtaljTzpfCUiL+ajuSkG04pcw7b90dUzE7XILfs+EfJUvqscfv/AOZgqU13s4byPl+w7Yetf2nR05bkNVjBrUjOqYZ+usrfeuihOqHSilbfwNyxko/x1DLRQbyMo5HV9H/b+7z9J+NmqDoyXkySfJNbRK5Zp+xjtDkDWtb8dHLy/XR3AwnHPv2wY202oOJaxCZi/gbSNV4nM/qFDLxNefkYtd8+KKLV+zBELM6Z2DqxY/jNURRyjXNZZyQnip50zTRI+U3/AKno/DxUTjnYU7AvV9RVSE9WsoY7mp+v2NGjb0BeRdDJGrmB+sfJkFGsjXSxW+a0SU6OdT4RpQGXk4sH9N4jgagmylh7CUJU3GTBUpajEMSGUgv5vjmpqRdVjImnQRoN7CXrnYX0l21dT4K+PmZfEdchNVVKFtU6uZG39O/yqRVs9ZPvM47N65CB3JvqrKH9o9m5aKR/Cu3Hiclw0EzP2G734I+1VH9KKaeWQ/8AqtPVUwJYQAmY3S35VuQUCTvCDJ58cmfJwRM+Sga0GzdcxPdbnbU3a7F8P6fGNB522crkN1or6xqZA/ZPaun7U7LApqaFK3TWqfTqV8XbVdnmNbdNfJzNf4yeWp6GGdNVFAPby3W/jqEuIWZTqpnXVdvSO9D/ANg4TrhaoJBZttSDNgYAjnNvNCN0QDaMbKcWHY6ZdYsfkJUImjXer2aqrkNuymaVZ1tE1tJDl10hoMk7rcal1OMrI+aRO2dFhoYrn8xqt0uJ30Y03VT8inOXVa0F7DJvRQHKy9MiVudvQYpd19Tcj3hNFRUs7Pji/NCbSmfy2XFitsKeVaIIjvY4H5nF8QG0DnaFpCjeOmZyzXlFPMgBa/4nt1sNv65oNnf0iYv6jkkx0pzwgRDdPkZr+0/T6EAVP5l5B51+yo8zHC1r60vNfV/W/DsfGp2mTWWTHf25G5/eoJJNTT39Laf0eV0cpCJg9+1xG1yAUONxJTEocLez2cX48HS6sra+dUT/AETd61NVdH72r14Umi+K0/jYKWsbKJsHVbxxJj2VVj1Nnjok3/8Ack7/ACKoxlNTjsrUn/e4l/p3kujQON6KnaeUr/scoZMeQT7RUZJWiXfmsVRKTLqqgnaSyE9CAWn7+BmIZs3AZZ0MhEtC7FqXPu4u4QLOh3KH+O8TFzgtJTp8+WvNGN3pyEm46modTkomamY3MaZxyTG8klU9TXyOnqU1+/MpsaUV48tTZkmbNJhZVja006x/JoJ1rG+WL+vP72GR1XxtVWO8kM3QaiK6ceO72ySm2WBnas68v4yYlMnGDxkHIQ8HSJIFrwAxDbV82Vg4Ghhz28O1rJrpB5p4HVVoMe6Q+o7/AN9d7t48ReY70/HNdNbCpkgCqofkeQHyFEIjkn8r5GYif6xomaSK/wClGxre9si5KE0mn9v5F56qTJBkvGBirH3uoGTJvePqip6pCtzM1D0y1UlJA/5VKTc3X0/x7YK06SIiUwfbzbuTtpufMRO2pl0Y0cTu2pWK+01PL+lTqpivohoDAGgMm2obm+iyuokZ6o4qopWYJP2hQVpByXVS6w2zWOLlxNcppctWm18V9/8Aqn6TepDGKVGt+oIKiSaoQGHcyOOjcxOI6qRklrr8r1F8C14gDvL4QPK0xVKUbEFILGUmFiDo7MYVVdzJMTLXMzWtkdFbOclUJUxO+Tom+fwqqfT4sNxokZnT9laIr5Ks4ncyJudzUMp8kyjOS8dDVx+p+JKhpddA157PM6m3SE6uOw2iJjn4/kqsc6r/ACsFzPgrAqpzM1JyUG+ta2H4MgmF8oRB4EHPLe06DURM2ghYWCWIGMWKtbiq1qgUqSKkd7NEXV06yS1NHWk8zv8ATpV4ZrJbGuWTLXVBXUhNY/E80edcTWz/AE6skkmWUrJ+5rLNU9bn+xiU27EKoxmkaPkLT8S2Q5PP1q/El0fHueqHgJgn67ngZIl86loYN8Zfb0xwQuV7BIikbkmcwgaf8S7jeLkHTHJPmRiWOcbIGJqp3jLnvfJHU+d41VjUzHS8+xqaJ5x/HahGSwdVR3tQP1f9qNSz/r8qG7q2/wBGTub5hx24wknINdZG9iu9U6hCvP4+zHcVyknTXhZezzUVNBfFDJwV5d7TZqRwoFmm1PG4fnTeyt6hi5Ey04xfYNh3o+8nU6xHOPVVHi5rVUftnsrW9b7O9byYlwiXOqyF4631W/qTipqvA9c/USea8m9QDjuhiaPOssNUXUwDJjKrdDWiXGylVXBXZ+KisjMxe+saSf2A40XAM+euXzuVmdX5jYwTSgRCA/8AyuCORDfYhqxBQi2RgZCOwQIJYQB0ebGd44nL8e4kqpuQrGC6qtrWWtSmiZs8b80zcxKAeJ/xeaJJaJ2fu3dNSVu9f5Dwao21bcdD8eXzNl1vc1EodT5mvPNAEajfh0afwsa0SFbJhoe06xAPG62qeTkCU2fsVizQBeViMD6gAAjiNULweRL2fkWIsZF1ooyenu6kxMVS49Vo3TqQ7p0M00TsnX2l1zKlfmPtj+ssYXch1ZP1qmvL50dJHmBsedfkXlxSdBJ4irIhnpKZ7FdeDpq68CWHcR4ky4qJv45BiMfOSN3Fa2VkppUWt9vVKdBb+1UQpFk1MqA5LgSG4sNZmpkghALb1QaRfA/2BpuP7/K9xTS5KoI7xy4vGK22Z8tBIANNNcjJRVZMRlGXmcO3hvuSnoyape+K3ka19XVfbrQu28mmtsmdK5JaoacRULsdQGMUoGh3oc6mdaxnOTxSDuC0fjLdS8gul3Nb0dFz+Ym2xMogeCfvyKSxp+o1C1ibXsJCQEbY7vV2Kpxly48J9X4nk2QL0TTQm7ODsMhuLHcP4vFHeVFJ3bmlrWOtRsMdKpU065J0dLPhfwctYpxf+/HoSccjYh45miZ0a3K4+dQTXHgdWMcBELWqMXfffU3j5l+PrXVKgpO55+v7kfzk6pACbIAJIV2CMYkJHN9NkwTYiOyPzXO4/wAr5nToMdUlz8lUqVdtRKzMxjvdS0u/GnzsCv0fjdNlVJrRlyFtA3KSM8ZCkhqiNy8pqZko6/K2LFORqPs815Odb/rLj+/253o8B5+oTRL+M5XJMSVc49Y+RoDdEFmRonnf18ASVs1Qn5wdUobdrgAsm1kPJS5mQdkcIvMeG1kMSxrufV+gy+6H8V9j9Jjy449V7f6HITE3g+X3D3P3D1Bl9Vmp76+DC4/Tnq05jDEm0gDTfFPpaz4IszRh9V6rBOfEbnPeLNknFncl67+eSrx3DuhA1Ugbn3L1Xr33v3nF7HeT0GD2j231XpcNY+Yz4PbvQejxe3eoqrxFmOvWc5ArnFvL6jick5MhFaCIj/xoObmCIUqoEy6UaBEVJ6dDtENoPldA1Ev5fSB+G5JqLJqdhxNzFtM1GSh6rGyj0rMC4VyD310Xt99exfyPF63JXp/bMk+1Vd48WTvJ71g9VkfbsGGpLmqvDfuFZJ6x5H05muKhxfZXuXrvQ+4+o9Ae2Y7x+j9F/H/bfbN5ceOc2X1vpjM+ty5Zxg25vV5Mm8lNVc1jxw1ubLPpMHo/Vfwz3iFqvVe2fyP2X3bN6WTJq/bfVek9d7dWa7amW/SeufS8wAD6uqtqifyp670PofRf/Sn/AMeqr1PqvY8PrPcJmsPGLLm9V6n/AMTDjvHRNU+knDlucgW3lA/X5l0yK+tXVU6T/cPppBVLHTpZYGU3ENDVVI0Un0soEEFSw+QPCHF9VXJOJx39ZMOTFZTFVNZsVDPJOqN+AyCNhMpOujd+4+o9BlyfyL+T5PUEH8i9t9yy+j9FRV5n3j1XrPTYcvpcmL48luH0VXk9XjzTkpxz8O815PkxRzuRmugJkpZCuqdoSsz52ulxE1ve55Nfm7v0eH+Qe2fxnD7cejx+u9hr1mD3WMxHpZ+D1vu2L1fo/c5z23Wa7x+qr0VSwVjPTYuMWXHl+QXWA9VNZa9ZpqNJKQAORkoZLzpdMgk07oinNxJfugC5764/1BTl3KaNd4sYMyS6deUodTsWfH7Gbea1/drUEUaqzUBkqE1RGroRqfHlMnMmpYfzb+6voK9x9zPbMy+3Y/cPWT6GnJk3foYz1OGa7JyK4pjQ4sW/PM6+xpjFBlu1mJIyZaWk2iMsJJTRjeYFNH7a4A9Lo1A00nhgHAgjyL3TGkUyDusCYgDa1rnGNVPUbbOoU7nEIpLYj8ldKvfn7LKcqG5N1aanbTMrdfep756dy1kDmsZU+TT/AFoBNn5YzNclIX0EFBRoqTVNHT1PP23Ahp8PVfixbmZjGlMd00f7mhWen/21W5iiPM6kHy/nXRABcEidgD+meBjUgXP+MBzJC9l95MRpJj3IHKA5ZrZviNFTSh3JrxjJ0m5Tf4NndXvGV4+OvrzNX41ke+qRV551XW9Gz8mshAFgyxGBNMzOWtHyH33oS9s73RXhokRvN9Swl3jMe5F+PxEN/KM02E2O95J1ujXWtwRbtkOdu5G/LCOpcJWGCDsPyFvpOqdtPVf3rHZ1o5ufruyonHvgZ2N9x43kUqj8IrJc4qxxONaicrwyOial0t7jiBu/o81J9iafw8kNJPEwTu/BxNs7mi2lvvJuN8Ezex82mixUQVyGqrif8e+Io8eaQZESE0+HU6HY5JJOLG5hXEebzN3Gxs85wc8LIxu9WMBU5VxzO/hIUxs83P8AWcbSddVJzK+UdoDu7TfMxiyGN5OqCDZ9qZ3V6cqTynUzxTNPL4pYojL0cu8e26lJMjFGxa3e7aS9H2ZmTmmX8u8TEz5Z1RYCv1/VQ1oiIkT6SCBWtVrWNaR9RVkRixv+hxwdMFcbgfla+UcY1dxdpFOKx5mGVP8AG8/2+1VUbHZe/wCtbqWsbX5uPSzZfWNuvklcghXI0Nn7CK0Ea266+xWO7l1E0Y9ZEbmGIuJ39ZHxkKq1pnVD0Omd8hve59Ly5IJetzVh2nhVnEfXjnJMjMDUn34rQEed1qk1J3DRETbvA7bvUEAC2B3gcbWX01vvQxzjna1Tk7lkG5mxnm1nX0NlRwoOzWg/O09tmh5eOsuOrk6XkqtEfJFSQOmokH5FuJpHUcd6bFVMazhjCsvxqxPPUvw/WJLPqbStQNaJrJeu49uNcsSV3Oo39qIt5biC/wDHGOeTwtav6mnT838bWzNu3b7DlMTrp6RYH1GxY9iBJxuNdl6JqjjA95jHEJikOsuV3GXur10rz3KU28mp+x9wf8xV6n/jf/l72H/iL+Ben9Th9F/wx7F6n+LZ/eP49nz+k9/z+5+6/wASze8/8tfyv1XuGaL9w9sr1HvPuXvGP2z/AMP/AOl+L0nsHoPTel9VPq59F6f1MfMP/D/8Fyf8mf8AIf8ADv4R/wCRl9Jg999yJ929xxbvL7V7D7X6XN7x/JPeTFGKoyeo9n/j/tXuPuOHDf1t9PMNSZR/Pcf55/y1m/l3rP8Akf8Ak/sX8O9q9B6f+bfy/wB29mwfy/3CYzfzH2X+Me6x6T1uf+Neq9Vhz37dn9w949t9Bh9J797ue3Yvd79Oet9sn1mH2/13rPSH57/U/V1/6j0ukKB1qOl0erV1KDVSKaOp1a+n0+jWXf5P78Uywsz7HQjomoH5jXQAULUTXTMoH0f614L6HFBUfEzN/HGRMziq3nbxraXVqX9qFsqenHov61/+hzn0Xs0f82/z3/ycXp/5D/x7/wAHfyL3r+GZTrD6n0n8i/kXv38T/wCPfUe6enxROW/UZvaP49/MPevWzVRx6X1U+m9W3x6YiflX0vpeZ584pFyxVXi5ZdxEaB5LlT6TM5DXJFVs9R/4+n3P1PvPrfQe2eq/8L0Pqv4b/L8n8hySGb09/wAV9t/jXuHvHvmP1OGsN489/H7Zjy+3R6mf/Gj3afb28uLLrNiz/qnQHV+D6lHr/tUvp+rmimqk10U5+cD0ghSoMafRr9NRIBJMUv8A5FSLWMNJgLWg9796ze9Yvacn/wBLf/pd6X0Xt9nxenzP/wBcesr3n1ubJ663LTUZPUZLkvHFEenxxGOYcMTr3LL/AMd/x2P5n/xf/HvV+4fynF6b/nH/AIv/AIV672j3H1/rT03s3tf83/mPpo9p9n/8j1EY8mL138L9n/m/sWH2r1/pcEZsnpcHqfWZ8Tk9z9NhxR4t7jk/jvqvQfxc9iyZbv0fsHq/Re9ZvX+jj0XrfV/yTF717jky1jx4sub0+eD2/wBZ7R6ebiIykY5x58R6nFlt9c97/mV+m/40/wDocveP5B7Xjz+5fw7+b/zf2f8Ah3vnrMr6zEfx/wDjn8m/i/8AKfbf417z7f6ow+35cHtP8k/lPvvr/kx+o+afbPc8UXgxw4euD409Uf8Ash0aTR6jX0R6kKgR0z1Ka0f+NXTEeVrfpA/OSDUPlqL2+UImwCqOLTjXzT/IcHq/bPXet9o9f6d9N7j7Z6v1HtXrvTZcTOX0Pr/QZsvpfWY7eq4r02WM2Fh1UVC/G05H84zPiQyTfqomXK5BHFkpxNGui+XVVLHxRCaL45qpxvon85x+/H8u/lU/yrWH+Sn8h97z/wAjxVODc/yG/cvVX7pB8dgs+svLeLnb9mJqhmvzgc+L5H5J1FSkfG3XVmurKihZ6pGYE7o07oH8+j6BNXT6dVVQqJooJNKRJAalrD59+HqgGqozSHG8JcwyOT760aY8RXyfa8u+TuTJePThnFeTHyw4xGupWfsqJH5rEx+nkjqbwsM46aqp+6oZq6JmpPtVaWdc1Pg3t886WcVM9zkqr3C0WdmCcmSuW6d3qTXFUleH8rfDVQlgLi2fIdHPkKndbcqqrtKrIffdadGmfS0tmLb2Q+xZKY5GH9FED5WfB9pFnr7u/wDoBvYfS/yL3b/6IT2i8zM+v/4WvF6lPjyWzj/lnsXqqnEZYOomvTxVuJqzHGMIqnHRq/4V/MsP/BH/AC/6X13umHFf8W98xep9l/lvtOMx16X1H8a9z9Rlx5isFMx/5XpFweqx4c1ZCM2BMcWbk0X/ANBB/wAp+yf8Q/8ANfpvW/ynNi9B/GP5d7J7h/Cve/c801gn26fdcvpfU+h9y9RkmpmPR4/dPSYD1OTK5HFjyZc9YslYWH1P/wCjr/4h9V7B/Kq/kPt/ps3qvafd8nqfW4fccX/6lkxVGT1mI9Bk+HHiy+hz+n9RjzTOMXDWRoaxVip+Lrqpp/8AUvxX9P8AjAR8N/U/h+nV0q6vw1VU0+kikmDWEwAf+OvR6VVQ+Gp6lHzVdKoFMMCC+R97kxr6twexfxn+Q/w/3n/jH1Xuz7n/ABr3bL6r3b/jb+RekwT689k9d71l+L0XpvU04DDh9PeDWSMfpaxuTDrKU9Jj+CfVez+7/wDG38ny/wAa979J7h7dl9DlzX/5fp/Q5PRYfc8/osnqPizGT1NTi9V6fOQUsdOSZnE/HkxTEu/4W/k3/MVewYPQew+z+q94/jvo4xZvT+qvNZgw+t9JdVi9Dh9RmnLj9ZmwOerxe2+mw5fUzky943FTkX1D/lX/AJuze8/x/H7L/M/+G8frjH7XMei92y+u9X631ntefFlMnrsvpvVYPmvBk9U/JFeiy3eTDd2wxE4px6fB/CfH/A/F9b4Xpmn4z4Xq1LqUU9Wimuiq3q9L9TqpA9VO7Y11VdTo9bpCv0np9QSB6T8wiILR9PcPbXzl/wA8ezYf5Z7Lh/lHtd17g4cU/wD0z9NM479R6D1Xqx4rNl9EVhnAYsQxeUnHjx1DiqcSk+Z//Q//AMe9qz/y3P7t7/eV/jv/ABp7D7v/AMnfyz0GKLj1fuPtP8OjFnn+PemQjqvf/eMntPsPxnx0HuWaouKxuSNj7R/yV6PHk9X6OIv0mL1cuP3D0WWo9PgyenPUd/BWHM1hzZZhMOOmMDNzVTE0w2PpfV+6+zfx7/lD+Rexe4em/jX8G94/imb+J/y33H1HpVz+6f8A3wZ8HuntP8K9g3kzOT3X1Pr/AGM91yVgz4v/ABvZvbvc/U481Xi9Ng9V9z0KOv0P6fX8JUf7fqFNHSrBLXUqFJpBD+f0lAj/ACUX15tZprqHVpLqFw4BEkztDDH114v/ADDHg/k/oMvrPR4cftub/lj+e+5+8YMBlcWD0/qfZO/bPQen9D6HBmv4Mb7r797r6fD8suVr081HWUWtV/yj6n+Mes/mf8lw+h9Rjz+qwfyD03t85IMtHrv/AKV+2+m9q919a+vzz3mn1XqPQ5c2Gwi2ctRkis+4/PTf4p75/Hsn/Jn/AA77Lh9d6X3D2n/jf2z2nPm9cegr0+PL/I8Me6/zf3X2v/w/UTmy5vU//Tv1np/4/hy+uy2ZMnoT1Gsnff54B7x6b0p75631WOfgzes97r3Vn1S/+az7h6efccmHNEoRkx5MuSDFbV6bhj5Iua9b4Emvq00VCuk9L4epO9Q63WFNHqBzT0uiL2NQ7a4esfTT66fTWK6xSXek0gQDsSThCNfUfrvSei/lnqf+H/ds1+my5fTes/i/oMuP1GcnDjw+k9bjW69UzWTHVxiishnpnHxkWb9P215D79/IPcfePYf+Rv4n/KPRYfT+4fxT+Xer/k/t/rPR+jg/8Wvd/ep9l9+9n9VmJicXoMnHovX+lxxix4v/ACDMkfNep6f2r33Pi9nw4pzROKMdZfTwYKZxdEAYuHqMsVEXuUCHJEvmwj/lL+Yfx3+Ufyv332z0P8f9wr333v03o/X/AMx/kGPGej9PkcHsXpPV+sv03tePFBf8cxeuv/6fX6z1EHq3N6X10GXJi9VjjFh0unX0viKKaqP7tL9XTqBpH9o09Wir1F1AEVUVdShAs7I606lX93p+oVAEoIL5nQJID/CQLxGLa8s/4s96v2/3jJj9Pkmcjlr4N6GMhlxXiqergx95JmMdG6xW7P8A6mvV/wDmj0ce9+hxe7npLI9fh/8AI+S+CnLb8PqjF1WSvUY8XqJJw5LzVkLvmUKtj5+9Pgr+P+7zOYJjJ3/49dM482O8l/Fmx0MTWHJucmPJGTIQPU9EcP0b6/PXvf8AxY+sxuXH6b2X3n03p8vy5ZymSvcvSXUYawuRrHM5/TZnPGMrE/JRR1PR6XxdNPT6/wAN8SDBrHTKkqpAZxUvELWXR9VXR6nTTApNQGHCIuVt9BgfGHpPWZ/aPcMvptk4/kcTSOuGgGYoxgHGiydxWyfHUPpvsvvVR6i8npmbx58Ti9f6OgcfrfQ5NuecczRTFf4rxwZesecm5nJPQ+ffyb2669TXqMc7upeiQ5mdqF0xvqHmHo6aTalS/mp9t90vGxgztROPNj+LKVcuO55iSmqhcbXmg8vKfWhH0lTUCGytg/SbDeB9JGuQVGhwRbe9s+Qpc66r+Z/xr/xPW/8A0x9rMp6ej5opPjs33QTxEny4+Sb4ut8slX8SGj9L7p6X3PDXpfcBx+onmMGeTHsvRMzl7aGhttCpaNF7rWvQPRe9R7lhfb/VLM1EwrUk+IZkky1dHyXdHU6a1pJyyNef+/8A8Zy4ay+s9Af45rq5J2z9ayTETMsHJzLA1P8AqamqaxlFSApJZP1Hyzs3EyjI0VEBVUGC3SSYkcoX5cba3Hp/ffWegifbvfIPV+3ymPF6mysmfBDqBw5KgMmMxlJjdz56g7LkV7j7T6bPh/8AK9BmPV+nu1hxq5MfIpjyREW4gio2CBo8RLs5L0/u2Vxz6X3HF8uKb1uvkvLh8E6hXf01+n+qFUtSn5uMHqvWe279T7dm+f0+ROsBXWKh/wAlTkx4x0kSPhOWu98uSYY9Ki3AIsgBcIRjUioETIF/+Qtuj4wFOtD670teholmaxvMzb9wrrcVeRT7zz5SfJQn6qTae1+6fSvRerWvTXlknOrTipnRwKRxctBxJoEnmiit9Of0nvWHXM4vVVv/AAOpCXbTAuV6nLTMajsUmtUF1yXrfbc3o8t8Y6qZpybRm2dpyNb+TezqpNUr5rdadMrLMjiPF7GJ1JCLpLGyj0xcSXKxIGrPu3pJxWZ8NTkwZzrvHjGQZa0GLczYEthSSG5qjoiq4f8AzPa8wusnpKM2KdUdcTJ6gYBuv+qa4K1uycn9tl7f6qfUejv0VySj9Pk+3LyT1E1RRpTnW9tBOnXVL0tGD1bgyNQU1FTMfG07+PV9n2mpaWQGuGdFwz+JEHvcFxb6fntGkLhZiSeMft9lrT7MOPCOuvqiO1GT6tf9J3MroNLrfRKIzlLVIApIk9HNS11Tvymuug/X2NpRLfXYsmL1WbHdgxNBo2MzX0qNzqrs1tkkq5sJm0C37B7Vfu/rPivIz6TCt+qyW26xSykRoT5b/wCs60ndRp3sqq9IJJHpH2Cu7NCIcX1KLppCsB2mnkyL/rrp/YPT/wDj+1Y5yVq/UZs3qgorTitMeP6BjN1rrZ/abeHdTq7mN48j1MViVxLMm7meXZ/ZpE5o0vKVzcD+bHLjjHU4sb/jw4viwyPBEysyYtTzXjwaCV3oipN6201zzVLL8vB/YmCuGkVytaP0744BqWfzzq63UTvYASWkbEfdb62pEekWA3hhSS17fmV538bijU825AfrPVT45abPjmeWdUeAUrWl/LDB8U7T/reqUuhP8k5EPKB9tPjXlYoEbN3CZOdg6K5mZUOCtkvXjlJ09JSbD8nLU44iZsNkxWu0n7Vt2733IhrZpdDHk/QKUAYQwI2F8iD9u2sxgYWe47Lm33Uz8XAsXBOWTr6fUeSY1SVw/s3preidkn4t+TS1PRNuHbeSeZ1L1vTNMn6yvjYC/Wn8DfQ1Gy45mse5mnmdNxopf7BxW/2FiJkGre9ARTirvWSu8pNDXJXPO/6/pKBJf/kYIG3u8IsduXpnCE4D7XQRj8sjQ5SrCUmWAoAieojwibpdjIIpcn+tfjMYkJVlAzklp3bjNyPWTw/rknny6Opp8r1joKmnfcW7A+Oa8s3c9ck6+ofXnv8A+NSWSmmJQjiApXn5eB68+VaeSQSaPP7J2QwSP5jH+p50KREfaVZbjaLZ1ajtm/mCarWKa/7yPxh8jelhOqq+S6DdT9X8WktNXSMTOPbIN3jo5fuvU6A+uiq0a3qvxV1WhkqiXGZI3fOnyO/Km9LSjP7ZZdAOQZje4Fx4q3rtZR1RrzGq5V1vl35nf4GoWJOLAsfwk50MW8j7cP8AMgY026yW6qOtL2ws21qJq3pWxl/fJLxO9O9EIGKUmXJMRskondSzlqt2bfO/CzxV/qtishivmkZyd45dhwnLsu3rYvmqd/X639o6CiSHyN97Aeb4KSYZvczB10SAhpQp2UmyrUscQwFCLsWvpp32Ti1mOBxdBBcasZawTMSxLSTOwGO9jOX5K65f2/UH9qbDUXU44mJqet45GXctIf5MlaQf9/YPHlTyCqZKKNXyF3uGraittlPRVh3vJrWt/XZoH5MVS3NLLNFFyttvnZB9po6I2NCujU602GxcLICAXbCnjxpGDF/HFkNmsF2spyWYoOitI41B3071l+1T4535A3qtfolZS1x/j5+uGR5TvplGqpvgvXnYL+60fpGKvmqIrRca561qWE1jpyKUNLrRJbNeJea/HXnIgr4unc4yfieGnT8m+p8a2NKPitmjYxnYEDmL+e8LvoV89p29nhZhToslZgkiCT6xkftMhKHepXkNU9snK+I8p+TUCSdT3MTZ9gm5ld7XX2rwcjI/1f1FCH1NGOE13k1ie5+0VRLtNnOM8kjug/WidfjtFZMktdbxtHSRpojclLpgXmSHXyeB86/KdN7/AGFlG/Fllar5ccGGx2yd/wAwtZNRkzDkKudqLuZGeZnrumkaQ71ukBRk/HZJ1Jccb1M6iaOIp/8AY3K80f12y632ym/yqyubASjWrTU6EmISapPvTWtx/wB9B+zZYOnJY30ab5XiaP8AG/ETp6588ozoK4639U6SwkX6QZhp2Zi9jOy0Gxm6F3MP+B+FpZk52/FWKwdy8nyUG2i61zFeSnmt8sRfgoXHMzM7jqkotOj7fru+eT42du4N/b96fx2RnLM8mSieOfNydpBrX3GHesgJLWjRJ+RE89ORidHxzi8151usmqmHbXXNNUfWtCa6PTLxmIUEpG7YYgWtqSHUdgRO0CYVvC/DYaGvjw9MimWX+pTUpO2qdkMyQ1yK+TRubEMZJEaPrqYUGrb/ALDvbxUbCjySL5Z/MjMCtLdzPGqgm/qwFTvczzTIVorGlKVX9gx1+92ayCzBPcwVyY50BEV/pZOuRRFfxgh+2wsuUMmC51QEgB2j6WRKifYWg2qvFjJ+3VtTfcspJUtkt7kqCt7kxi6VEdKq+Hrzb5qLa7hWdnON640/7Ik2H61Wn8CsmsmI+v8ATFvkOaehhKdHf7ewP1X/AG8Doxxka36fqSvk20tfXlQ7j+jv/rOuiZ6l8zT9RQSalkuACwjw/fA0YQ/ObSpS8PuFpFK+GXZRUbo/ydVo67naUOp51KB5KfyKz5JxzGOd1ept1aeNav8AZ3rT/kQkHSUFbs16f5+ZMvxGpQpJq8TX20V2oOpmY5U0UT1L+Rj9HrY2dTF+aaP8Q8yvZu6f2dc/9j6s7o9NbKz/AJBPA27B4+ugv83HGVJz7HAYFhj70SkmP4+eqb0fbY1ol09VRXI67JD8HFGOlct9K9TXQhPjnGykafHmYRfOMdofk/DcZeC5SPvLxEtTLJ9KZkcsoy/SjpR/+2c4Z6/9rW931bD8ejRjo066X+r+k3slNQBICQBRQCDyRZC+AgKS8o2AeNoGSbneRFrxqN1RRpniLndbm3UkkSV0Ol2ACAyG53+D6eY+1/F1XVYtZNPxjxsNcaxuq1bG6TxLqmphK8HU1shycs7rmY+1L1FDvdeG2WTTO2w4TFo+UVJmtLyfY+9s7LmiRVJXy8z4PzWij1EVMkWd0YiwgXBvpALGQzPBj9tgGY0E1rmcksuuNp9nIVMltU74PJ0Rs55Q5bXTv6v06YjpI6lqlfkqncoaG6JAEOQK0GUSsVTQPLLrmZvGE0bqtlZLudbT7Ds0u/wsN6AyeGjysCzFsbmqXmQSuanU6l0NCfmwEgFfLYuC/TF2L8LFtaAelXlWi6B24uuSM5kvVY8abm5IbmaH7TMs1au4dWnI0Tvk3IfhGHHOyLkl1lmXJ0OP/UOtTToniSfK1ujfH4tvIUdMQbjFA124zxc5d2yDXKrJv98xLo/HB9fFysk5a+xRkA+0/pmuiROWSpX/AORGBLXFLFku52hjfcBpPvydvKUHtgRrHJ9vDM6/f0I6s/WTVhvxT4lFZf8A4l/Mw5TKWRNTOMK3c/H8nJH9ZWlnd7o4VN9cmtxmrp+2EY7C65qWivr8gNXIsljd6md+fEmy/rEZIbYPjxc+R/f+tbmfjTSFcAUeZnRQ9XqeAJpW4/3Y6kmbNCBMAgbGFhKZuBply7Nx8sZGaJNKTep1NbIjgKNJyFFxu9inJXVVjmKPjTboHL8fEGIqm+kTxQboNCfF+MyZDFj3es3bMHMlVtZ0CMHGPm1iiaTl0dLRUY+Yx9TN04/6ybvpK03O91Wg+s/Y3JpJ3SBCaSN5uwDuL7n0wM6CBecE2Y49OAB3iwEjSzx083NNsTW9cKH0q7f6zZyhplftryDaqNx8ktMETs1MGaa2N20VRUjVVj5FJmp5D8Uzj/Zg5n6xVtLppH5Zi6DRU3rLkTXiUU8n3jiTwc/GQTwfW+kEtpmR+9rSoNWk7D8avsD+avD+omyaYBABcCwWYBAPbIBBK5USR8mVnBHktVl0HjYlUBuv6OzephPHJilY+uKGGJqV5y78lIPSzutQ+CXcv9VCxXkZy7hckvDQVseQ53VRTKF8pM9VqXz+RV0EauZVg+m66LTzmyC+fqF//cVtqtbLBCI9OzsWSYEgYBU1Pe7q2I7MlJDE7X34MXUf4zW//XCgzPSnPdurXYlJyrOmVl/LGWyccdyXjdQfG6YqR3394H6/JTvm+eKXqdfgxBj0gbcAhJPx97HxV/vds8davo/sLonJvJGMa5X46/3jx0lIl7Etv97Ai9ULJpGCVhQB2VKB3PfYCy0/H8/n27aU1V1d0BEwxxXi74JkzAtS11sLPADJKdI3GYsUSTGqZnT53LkmddVGpiZqdzP2QVj6/gZrfrM+I+mOuYo2+T9SqQxIVsVdhLpUJZj9C4qRZR1H/rBx08jU1ufE87f/ALdaQKM5UyRPKIUcf8ban1EIlkbk+ry8IeGbEac/MW/HfTTGXtqeOWjqTYRWtnAY7XdSPTr8n7UeQxwQ1PPMRVSMHm92tC1PJAzqad+fwLiM3Bkqv18h0xEcdNVi09A0smx+7Na58V+AfS0H5NUGOr71j7mXEF9p9amp8bm9RY0mh+SAUj7GIajDc8aREsH/AMTfAHMlQaXxjUrjpOibDmaAIisk6T7Kqoqso7N/s/GQTGLo5S63jGSvrkHl7mNQFD4PAF1MadCvj+zN5JiWO+l7yMfXU+IZUga2eQ8ldISyLsxzhYah546GqjvmfmpalPM0VJ9h5CSh/EF9I/8Awlc9vUBKcrTQuHbm3ypNqdz4WgKbaoVqRmr3pqpZ8hXR9qrWwBRhP91XYiO8mTb5mSRn5IhMSsxLHBM0faqAmmpdVGjOqa68VvI9tE9zrwNbSl/Yz9bB1p1+N1iwzeTRLlOK53TyyUE888x1ChfknfipAECf44YeL5i4s9O68Lv2zuB9c6Gbul7guZhmTTVdzImVq/j8f21aa3XRLpfyfvbQsnA6lYmyiMYZKqmr4p8Y6dU7AY8anZ1pQYwUHlCnbL9kXJklpP1treOvIbj4p6+U7KyY9bK1MLXEzwc7Jg0n2514WFBgkrvuAxCKTv25eiyWTh/9vc9pIxGi7gqfp1l5ZCpZlzFa09UXeXohHc6J/wDnlcorJ6enmtY8kfU6mb418lpfVs/YOhZ6PsTQoVYx4mnz8Q7+snUv7KN7rJP6Y38juPIn4ku1drMlRjqcc8zTI/a/PnEyMr9XZt3Qv42hJvC/c/W+I3k8kBOkgSmBOXBIJsCbCNWRYB1qR4gyLTjxupKLpDXUvGhN+fB5V1057yxti8a2XJ9b3yuLnnHVTJJt8fsTlZ/Mp/xGTEmN5mEa4dAK/HRW+vqRv9FB/U6Es3BM0qpAsqDGTxRWRTqUE3pHpeU/U2AvYImBjgNL/jaxxo4IIhhgf9sT+IADOO0nhmflp3IY/kr/ACp1WiXlGWaJ8Ox1+58Ub/Db6/SS/JEykMTeQOeqb3pa8s+CtX15A/K9GVqWJMZ3OJt3EpO9WUFBvXK0zFByTRSfllmsMFMmSrZmqYm3oJIyFTYEvLP2F/bXT/WhEkEIpn/4vyVkK2+rpjwkrgRFs3LCZMTMXx8nd/d1QPYEVV7iSgOIl3KG7USSY/sJVeK19nf3Bf8AHZ5yNbGtbZbTlKnxUliJvK5CK5YpyX1RNUBPUkpRL9jpn6n62iV+FMvdmqoZyXKNRTDvURX/AGnf2nRPQbkPAySffNshper1PPnOk/dW/YahhgKxT8kFf0/XIRFctY9igCQ78V14xrosJ9ZLeqsCaGfkjpkmKdyyFb+olTuPtp5/Ag42RvmshNz5P/iamIgBJ2k0s/FS1O8ZSsrz9GXHxcRrXOLJw113pqtaZBkZsdPnmvyblshKPaci/sPCm5+Z/KJif8cEFET7babU9OLZOOcSVXy3v5rjk3ywiaUnnndeNq1QGS128Uwbx1MzRQ7D5fjrZsK3KpRp3JvSLZXEy30XjhpNyfQ5m2uv1X1ybmJefjpP+0pkvdrPyzXLDPEZpNfIhfbkaqplFlp58b5v8g3JIcgHsFkY5xyBpXYcky7iQL3L2D+hOmeovFg4xp96/wAbYss3czuroSb53fiZ8CeCplGxu4kOfBAsSv0NU5e/tzRSbU2unwjqhkMtAxjkCjGtFh10nynmqJEoLoUWtz0ebmBrCk0GUzGTj7fs/wClFTok7Na1pUYl3pyqq+Ygfh3IUwhaTjiNVIIA2HchAAC2Jh/lp13kq+GImMUL5IIuo1JkSlf8jXMhM/Kyzsoi6sw1jjWxpIMdI9yWhM7WJgihHWiuqApKWrijGZOwdn+X+0iz1O8ZMlGvJP2+htUZ4ktTFIfbU3cXKDkr4lZJaeta0obUV3xOk46zUfUUPGRFhb+LEt3IwuxAADsBve4jGrHMCuSclX83lDHBVfTcblHmtL2O2ZR3qQ3XtfpvSer909oweqsx+my+t9JOdhBPTfJFXNZN7m+IrWhE06aOvzV5HBECZJ8SSzOOujk+i0lJZ/3p1Ql7Kefzc+y1iwT6/wBdmyBPt/oM2XBTH/kzk9d6qT0PpsWSCecfL6hz0iaMFkfbaef8R1PT061+IggRkqFvZ7D6FyBBdgLEfiIDadjOGHqcnuvrb9F6/wBFi9MYvQ+5+5YI9Z6mOf8AyP8AxZ9Tn9Vi9vyepIIfS5Ms48tYN9ZM/pSr24+gHH9nUM3KXvqA5T6jqn+wCaHs1slPNqvccWf0WL2v0uGfTzj9zy+6+u9U3j37hljBPofQYZj4pr4fSF+o+1I95t9lRfVCytBNM8lNbXiqNjJLtqL0adfaRx0FT1+cXSpHpNS9FRq+Vo+oD0q4sZWRO+pKZzTEmnEeZt9RY66/2L270PrvY/5l6r1eb4K9D7L6LJ6D5fUXB6r3f1HvHt+PB6CcGLHmc9/+Lj9d6iMFfHr/AMerWmJxui9w9B6P2/1PpsPoc3zYs/tHtnr8lXknKz6nPitzYO5qsWWZuWbkofEjMCH5s/TY3P8AxH3gfWT8Pp/f/YvVer9Nix6y5PSX6X3TBgzOfZUY/TepzgIi5PVBJkqn81frPa8Ptj7RgHJHqfUez4/cPUYbtceHJ6j1PqMnoZ+oTvJ6ScGYndG/UAJPIc9DHX6jrIBrI9CKI9FJ+/aD31pUB6KUSEAQNw539j+R1VyX8hzret75COk5Frb0lHMzp0m4rzM07r0Eely+wfyb0v8A5Jh9xy37Jl9u9Nw1PqMXpvWeov18F/G2V6eMuDLUyTHEX2yRL+ajLjGtNnVc5P8AWvsV1jrJ4X+uib/+qd1t+vQ/wv2/2v3b+Uez+3+9Zz0ntvqMnq8Ge4rDhis0e3eoy+g9O5vUXEzh9d67D6T0OS6ZmcWZAbiT8vqmn+1VVimoVFfN+Eg2mCSGHJ2OpoPzcn5Wxxba7v8AmtJ/IfQT6D3f13ocGXFc+mPR1m+MXFh9Zk9H6fJ7h6XA3ESnpvVOTBylF1M18jK1XMnRVBXyXDbNaZWJJCGq25PsGv32lGyjbvsntXqfR+1PufrGvTnrfdZ9uwejzVlrLlyx6WM/r8uR+PGw+lzHpcFVVPyGbyPNx+aZnNSzTsoy7vGE7ejnH3/2HQTydVoBm0Tp+GIPSp+b1en5aikGE4sLzeGIyqgju+XdDZZ8ixAWtcklxd0TOxHJKnXc84iFiPrWk53/AFZ8VU/ia4bpd/8AtnmtOom+5Ju/2Am9wcGqdIb/AB/qCTG9nJwQG5As0zbVnStIbAoBNtc5FYU0Dc5L+AfvxsfO6iylrfQx1uqqmrrY9d9OBgLLJsJQuuIFxOpYYlH22u9yhDi5I1W9RFkRyhsx45yGyU2c05K31/X7Oh8ic81tYJrHNck4htTmcly7SetlVdb86j6tTPP7/LOZGGno+OD6U/a6le5mCeToqiFiXxW9cj+IPkOXKEdRjmZSqcJcyxTkaUb1TuYXn9SLX5sOLlDAwL3jxiUY1mzf+fTQ1Owr4RdsVJRpGZVXV00I6qiPLBkD+/4yGIg+8/aTTyXTl39OsrKQzo2VP0JZnwyNexcwdrVWJX2NpUy425Z6XQhJ9ncyimrl4nGCzvqywfswI/HU5P8AUl70VISm+arb+W34ssiLgLfxZQiwGZwmjhjnYSftOpx4pbLr+8SsmzintDbMl21BrZXFGmkDX5d9PkyfI7lnX0Kf/n6JNOQ3Mla06A+sb711XwWE1e0paBoLV46YhCZCq8iundb8ptpVMRkyTouoKSF3FH/d38k08bquXWwSkZcOoRSCIRT7hFu248WWmAjiTGLb3NxaONbT0zly0mbzEy6eYnmokkfsz3j80b56q+vJW383Hpy9/HTWSJsibxh24mTeq0RcEqtBu8lDodv5p8JNlk7j42esdoNfHMth/Z4p5kjY+OX66qtz6bEZdg8f5MmUqrfvimAYmbjQbrynmw8aTdeR8QfSGDSmWVfubPL/AH1cIMqQQTlLAGZudmhrq8BVzH2mdTNGp8XhxxSdVBleqmpWEiXHQUdV+df7f6a8uXHkuxIxuSI6jicfRc4lJlbOncT45pTIs/nIegI+R0OQrFd/FVMTK/UnH1MxfFHU6k87bV+t9t7dA2rkoSr3dVUhpn/FzPli61skOuanfdj+fN/GkCrcNoZa2iOcOw119NEiD6SptBUk7v8AONfYX/0KHs2D1H/JHrv5R7n7lHsv8K/gX8C/m38g/wCQveOsk5vTfxf3v+Me4fwa/bfZcVp6fP8Ayb+Qe7fyf27+Ofxn0frLxehze6+5YK9Xnw+mxZckar+TY/4r/H/45/G/4j/H/bPcqyT6r1P8t9y/lHumX0PzfyGfcfTei9u9n9H7f7f6IyHt3pPaJ9J7nmyYMuf1HrZ9d7vnj1PqMfqvS5MWPbf8M1k9z/4e/wDogf416TJ6f0nr/dq/4Z9Xh9X6z1D6D0+X0noP5v7h6V9hn1+X02SYz+4+q9z9v9yyelfW+ixV7d7D671uV9RHtsQ6H/kj+N+y/wAK/kHt/wDDfb/Weh919Z/Dv457Z7P/ACT3H2v3P/6Z+0eo/mVZfUe8/wAk9L7X7lhj/wAb3D2z2T3H3W/YfSe5ejqsHqY9sr1cX6gyHqM/56x1v6z8VVXXV6uken06OkABQaOl0xWOpURL/udaqj0wIEMa9cgU9DpinPqqfepLMKm5mca47085prJuDJPN/EM3SQpzZlusRMzqoNGu6MkT98nPr/8Aw573Xtf80yeiv0fqvX4f5b/D/wCd/wAA9xn02Nr1Hp/Rfyz+Ie7+0eo90cfOX08+j9hvJi969w9QwGD0Htvq83WOsD6jF47CwtfPNOQquvkaDEquKONBah1Fd7asBVJ9c/4W9+9H/Hv5l7l6r1Jli/X/APHH/Kv8Z9ryYS5qPff5H/xz/I/ZPa6wRGHPVZfVer9ZHt2JqG5PVUY3HkicuLp/qAfwfxHpp9R/t1H0tFgCcEK4JshFzp9Jeqkg5GccqCObBIpa5P3D0vsPt/s/8Qwey+5+l989Ri9L71633z3f03tvq/bfSV6/1HueCY9i9D/9M4xX63F7d7fg9H6w9VXpPS1kye63hyYYPTzddPj/AJVl/lf/AAt73/xL6j2/1GbH/FP556L/AJF/jPvZg9T7h7d7Th/mPp/bf4V/MPa/X8RefEe75Pav4b7h7PlwOPHHqPbPX/JPqsnqfT/HwfvPtntPtn8N9k9W+r9IfyD138w98cntmL3g9X6n0v8AHPS+0+xTh9w9Z6TEX6f03p/We5Zs2H2/WesnqcXoPUnqsPpn0/p3N3X/ABD6D0/8w/i3/OH/ABzhyejj+UfyL+Gez/y/+DOXF6t9X7v7x/xl79i/knuf8T9vcNzVes96/iXrffPW+l9JxeD1XrfZPRenCKrBc+b8SaB8JT1eoaiOj1qD/cqCqoB6gp6lQK/DTQambel7xqCaajQ/SKqSCi2qRVSBaSgB5uNcZ/zB/KvZf5z/AMofzf8AmH8an1WH2H+Q/wAg9T7p6HD7n6XF6L128mL03/kub0OIxenx5PU5/n9ReKJ+OqyjPFFE+W+qy4suKuk5+uKsczcveqC75n5JnaQW/wDxUZI6Ir89t/5c9u919q9v/wCJn+V+35vav5zl/wCOb9P/AC/0PqvTZfS+44/Vfxz+Zfyr+PewZ/ePb/8Ax/T36f3K/wCNe1ez+nz3lrPny4PSek9Rm9Tky1dviOYmqf8AJGXHkPkmPDULsq4WpS8ejqReVdebefV/p9dFfwnR/tM00A9Okgtig+iDF0SIMKL65eoFVW2WKSfNIY4vtfWqvD2sm5nm/UzrJDXG2X0+6NhYh8eMSWiey2T8TWDGSfYhnnJj6ud4w5mcSB5LCNY5fjbdWvc82PUYO0bybCTJzVzA4opfgvmdy1LN1D9aWsu+gr8REzEmA+W8JRz9lcdZIZIa6CsOMZamRcd9NDSj2PYsgiBDMTyVI821w1j5rZEC8J2zYqFPc3KeYonySf5iTV5LmaCyMpdbWo3k8VT1jSTdfn2d/wAa/wDPmX3v+C+l/wCNv+ZMPrv5J/xj6L3T0XpcXub8nrP5J/AMhirDh949o/f/AJvt94ox4vV+z+uyTj9RPpCPRZcWZmz41yzNzG+B+PHUW6yuXh3O67KrJezetzknT1O0/PYP4ph9k/i/oZ9N/JMU5vS/yTHjn3jE4rvL6f0+Zq/SVgxHNYvXejgvPqybxFbwbyY9Vw/1D4PofGdIDqUPq0VCvo10IdWiq5q6RQIqANnxrq+HJpqHzKmoB0k/KYBAMDEkk9ra7H/6Jz+S/wAm/gn8A/42/hv8B/mGG/4V6z0HvnrZ99/ifuHqvSYv5H6p989TXp/U+5ZMZifTesw+3eo9K+p9nqcOTCX6dy+mm6w0/D/sn/Lf/In8fywYf5F7p7lgjJNZPQe4+ryet9BkKRWsfqa24csRMuSLK0hS4qor6X/kXp/SYPa/df47k9Vl9w/gXr/Xx6r0n/iOK/V+3etyS3Pu/oceHAHpvcJ9IYsXrvQFGD1mCUa3i4wfMvvn8Hv23Nhz+ly4fW+1XWGo91wZLv0uZHv48+JKy+j9TOJZyYMx1iaYhywm/U/oXQ6HS+G/9v1aKa+qa6qj1K6QKup6iSTUUfmEA2gRkaw+NHV9froqqpCAppFUBEC0xlkgeW/QM385/jf8xxS+6e0ej9i9dlhyZ79Jgn0+HIX0vw+oh5BvJTOLPGSJH431BJj+L173n/h3+Q+5f8Kf8Y+hxe8+3+1en/mP8+/mH8v9Pg9y95r0jX8a9k9n9r9l9F/Ia9Dk9MRx6v1Hs/8AJPb/AGHPWevQe4eo9Jfp/R3h/wDKr1EeG+s/i3s3uHtPp/ePYceA9TjwTg9w9nJyk+lyGDG3lPVfa8UZLy45uqkxBMs1aFnt/wDzB6f3v1X80/mefJ/KPSR/D/8Ahr2H2T+LxHtPrc+L2z0novaf4h6D2L+M+xemY9PXt3ufqvfPXZvX5M7E+l/+mHqK939fmXPl/wAvf8VUP73w3S6Ff9mnp11dWsVUmuaRT06KKQx+KvqUkdoDtMeio9UCswGKqqYKqvBgA9pm418//wDHXv8A6H+O+v8Abv5X/wCNjz5/av5Se/8Ap8OD4y/Weq9v9ceqwdFY+5xZcfp8mHJqqTJaZPrjuapf8r+k9M/8he/x6X/DPuX8r9R7x6C2smH0/wD9L/fYx+6+3RjyERjqcPpPV4sU16fDi9Nxjv45MOPHc8p7J7/h9uy+kn3WZy+gxHocnrfT4vTVMeq9DHqJvNhnJWjFebBVY3LZJXTVI9Fel/8APf8ALM/rv+RP5R7v6r2703tXpvV+4enw/wAc9JgjDkj2z+M+g9r9ur+Jel9FOCMc4/RYf45foPTxe6MuKdn+PDPfqClfG9Iij8fw3V9VZKBNFXR9PysTNZBw5E6530z8OQSXSaSvTIJpIKJtUSAvMlvXF5q919jyuD105KJhgr5cmMvsD5PT6iYyyq3LjmrL65+1cvqPsfv/AP5nsUfy3L7f6r1PqPSe25/+L/e/cz4cePD6T+Q+1erxfxb1XzV8eLr/AOlse4+i9bHrJzGb0ntHoJZJwxRwP/3/AHs3vfo49H/IcEeswnGYc3yYPUY39Zf/ABmChgRIHSaByLPna4/bsf8AIv8Aij3/APj/APCcnqPU+r9N/wAifxv3j3HDl5x5a9t909n9f7N7H8WDDE+4+rwe2e91lyXXpp59MetnNFbyP5n8XSBTR6qPSf7tANdqR0+pUBVUcjgSGAjp9L0/4H1AU1H0n8QMIrvubCMa0XpMR6n2n/7y/wCTYX0P8q/h2T1Ht3oc2XDmxuf0cY/8WCctxMZKjJlmPTNYCcvpMmKLjsnNG3xfzSvaf4I/wnHhyz6j1Pv8e5e7+szRjmMs+g9PXo/bPT+nyV6dyfFi79XkyttdYrvf2ipyeb/8gZ/fPRfzD3L1PvHqf/ptfqq9N6rD7ngonB6z0s+j9Pgw+q9N6wDJmxV8eXDd3v8AzRkbflmvzV+k90r15y5XFkyTzjz5Mk3J2848eUv9SZK2P78SCKfnWOjT16Omz6qQaeqg/SKofj1SGRIs9T/dNBNIYhBCSIEjZKfVvzrYe6em9J67KXWauqkyIGKiZ5trAJU6K88G/tvL9guU8/8AePYctUZPRxChNVMw1BMiTdP+V3qZ+SVl3X9g4vHuvdfSfy320m82H5PTVvJj9ThxVlxZ5DlIyTMRkmo05Cb45T6zPk5mP5R7jgyT8nLTyfbZOP7TrZCSRPNfVqjZTrkoOmiLEVCGATPzCG982xrCosg10kDtcG+T4O0CRFbF7hl9NWPD6jHlpmaxl80XiJSKKbdXM6p5uZpaKTcC7n0fv+THucm8kfIY5vpT4/rsqcejniftkfM9dhRWSfyhfvHtnuEXHuHpIm2j/wCuMVV80T/VYSYrIjW5aZGQ+zcG9Xm9vxaK9s9VOWV4+LJXxZ1p2PGzHVIyFeOroaKhfzViyjYl7YHP21nFM0mNv1C/g2vrqPV+ze3e7/Ln9DE4vVVC/wDizWMxUIV/is6/y7qYI+3gkSepo4m//M9sykXiyY6mzHUvXIxTNHMkqvLNVQI/uGGj8fh9X6v23Ms1eK5rwU0aoR7GQCQmhX/XUks/m5/+mXofesbi9wI9N60eY9TjxHGR5mf8rQ+Wraa80/aZ4/f4l3jxEXwbE+bagz+Eo/8Aig4ylviB21pvlj1LPqPSdYvU4nu4mpiaQ3RFHbtqueWrQ5xUhzZvPR+9YfWw+m9xjjL/AOuV74vqiR6uipyVS9eUOWOfkF/Of9V7Xk9LnsxUwFFCVouTudYtRIzWtFY9TUiPheauWfkx9UarGCXxornX9+nfncm9V0Aar6UW9wGCPbFwPqCwRsNA+Vtj/tG0WiHEYfOtj7j6S/QZvlxFOsn1cdnJJrxLEJsJ6DxJIVzy0Y7WX1b67BLqY9V6ZlyVMD3BI20z1fc7HroHZLs4v80k+qy0Xiz5Fk2xF30zUnMylMrL58SJVAHN1Qu9Pm+FMkx9KeMhvz9w6gJ1OpjdSVrnys1G4SkhqbiAUN5/2LaTH+OTORi6g244InVz3DFk9aelvDFVfc+l3jm5+ZTUU6Oq/wCpTVS6Akpj5Pz030ntuD2f2/H6LHkHJONzZskkrnz1HOWOiS6ksJiTocfc76ZmfPvQ+vfSeow24pJwZMbPePoaiymmRZNDR341+zcjv1X1q5UyH0+s5oPERjx1VW439s/vdYqUHUFCDPN8VVV8lIXpIkBiR6cvkJexWtaEyQZweGGYF4fOuc9Y1IU0U7ivrTpjhWfmlV8gtVpuaDbevzWVM+J+SmslfJOnZJcU8NiWJQ8RPh8km+Q2nqCMmuKd9dpfU1onziksrqXqQkZKpt56Yv8ANZkkpQKSukTzs40zKHSLsOdyqTNKGuW2GgQB3QnYhiRqq0yBEAFXGLflaeNcC/GeFdcVRbo7lkNbrSzsQZ01rkns2pKMpxjUieet66aSJIkt2G6eX6pvjxvf5DujnJLKMhe9TQ6NVV6rVvXkDrmRGjbhiBaj6m29O5+v6ZnUTFHj9eZ1sD/R9+CSbQw8F2MYA/SEXrLwEg34sV3Nn41k1Pnonx0VGvjWjmKs2K6LYdA9H2NaQZ+S4MhQ7YxmPdtcMh9vr1Lt1++d7NaqtEs3jmpkwfYKdaV0NciUzOnWRtUFNJBqTNMgaJnRP2kmWzxAz2eKf/xDkf1vygsJhX3cm+FD58aMhfy38tpuOfi/ZLNpya2T8gago5k0yCaTW9f/AFKNuTdVWPUO8MINZSAGWW2RHl+59vMkT0eRmvlUN43spp0TWmd44K6Tfb41v/Vc35T+GLEua2WE3acfrmY6sXl26uZBPGpoKS4CEYsPMd8X7fif5c3nHhDsNDD9MfgJs5uktyUUEuSgQ19U3vyeQJ1+ZdxqZizeseNccVMaNEVVIyKmmuf/AJTe+fw+9ApoScXPLrvhkrTXEh/XsRHrQeesclTpfv4kdTuuw239TGUzzWx8jO9M+EQwv8XyI2OcwixpH9O32+uYnUxE46+tkmYOIPsT3sf8iTjCanc3Mi9UC2a/MYx+W5uP8vLaj35h1bcz9KekqNul8Fm0ayaxYaWTv91wNJ4dvOwIqGQ/sG9DpfxT6j/Yp4nF/Skb3oqpKdh/WrdVqXc+KWhEJBD+W+sPTHb+P+frqxkclG2a4k+JmG5pqZr7GxeSf15grR2D+4OPj9OTUmmZ+upg+sp8ulWlSbH+0EgeJVZk4BveUEiL2rP10TVOoWKHeitOk7PFTjxxkqya51fyTNUTTolrGDPOvPhPAfX6P6BK9vtbj3eI0/P8iViF3Nng7qT6iT4oq+SflyH+OYaWlcnQOST+rOPwh+HFb8RqNYmP0butaZOiu6diXoqkon7eVdg8omisRPEOOXX9aq62uN8l1r7M86ed0Vs4vNnfS+f3zvTLOQQIEpmdHGlBePwsfPg2Ayf3W1whR7pYTk78iDAzqKi8nxPHxxFRVSsk5NUdUFSqDkkaHf8A0daKWZX6+PIagOeDkKk6rWiU2eNCS7PrPUXV18QS6LiJ4V7k3zVUba8gbZmWQ2NOhpWTKtfEfsh/W6vXmgta5ZpC9C0TB+lpoT4i7YvwINxxpR/O44zN/KAelkl3M5epsyzGKvDKAam2jXKAtz5GdIVyrySRG5jmuzd7EUxmPs+1D4QAGF5TcguTIxdpuoyab0fLqIJyD0SMPkhJ114SU3+BzFctVUlUXF0zsgsmcLP2qTbvkN7vnw1KPuAXbG1x+cZNlqgVcvscMfVDO03QflxxOTUorzaATMyeXGWklCTIBGl8F+Z1BXcXFNTJU8U+Z3qYCrv7cvTyyH9dOrNfgUfJOkoqWvLXm5mZHFt31SaPEnfPJPU9/iqveJqdnBIf4+8m5rHo86Kk2DVST4BF/KcsWWb2FovtgdtEAxhXM4ys2BaTwdHlJisYZZaqTqVmRQ6Gq+xTkdx+gyasrRQ/gaQpxny+fkZXH/jhn60VLRJNKTOmZrne9+QyA4znLxrWUWhrkHeN3Gpdan4zmVLkPsVKqqMczX1qqqSaCq2UnFZcmwaNbehaCip6nX4o2VjfdHYv/fGlAJhtHbAPN8jiMDVifvkmJuZ1bRkqT+s1pnupss+7zrwqmzR+P6xXckWTkgxteeYox6K5lttpGSot/e5qd80qwRlOqmofFMBzTM6K3jvRE6lVN2SVJ4u6AZgMv/1M9qNaxz2MmhN9Cn/4nzDTzO6HygRe/AgBScmy8ap2YvGwAiQCC72tHA1ech4dCa+F5xVG62sVp8TK63RqtlIHxjR1mrGRG57Scc5I+4uSdGRvuZWpuoNj1PJz501vmqumscs9TioIeqyqJlFo1QrrI/p6WN7fxGsLaZJUc1HQtP7PrQgM6ra4wdH+MPP5RqIgQrlrNOUTD7fXQSQfEWz6bHJ8nTcmRfjq4QOTrfJdL+76a+tayDWtOvBXKVgTj9R20Ssq41lCrqQxyQzvxJWPb4f0faQW5N62E81OG9TujXkeb3zMs6l8aJUJ1qpqel+NR218d/3fr1RzcvjTHIVt350UpN3vB9lYZVtjBcaF2u7EWQcKBjiXoayM6qsdD3rZjPtYnmhpfsO96DmXqTgqbGK27eQeoqt0v1igdFWEdzpmDlkreh0n4HRN46J+XzBZURer65jI5D+t3M1pp+hpqdePxkkY+uOJvKidAI5A+nc8mtk86/u7Jf1LpQFOAUiJNkAbPmnlzpi90Iw1IJHc7CTkY1N/HjOvFVVRzst47k43Xg0avwDvnYgB+Fj6Oip6f/UtDWTS+KadfXxpsPqH6eXYau2st/6LGa8KTQy45ZoND4qCen6Ompfw8V9M/TqknGVQ/R1JL3VxsaKS+jzJpOPOgLOBNliJ7kcY2eqpkmN4zj73gGJgvU25cqamuIv4+dr5Qiqey+p2aa5nTPlKOhtNY4jBvmg1d1sRchMxLVG2nZ2T5JI8Mm8l26Qa5uOrOTsrx1101deP0mx3s8bGyrnZzLidomrycK2V3NOT7ID4aTVf0E1W12CbZUD7WhzpEZvP/wCkh9sHGcam5uXpP75DmhfrWTzzWR1ripPq/wD1Vc6/X5FZMkkkzpn48a6TVdoWu63P1d5L/q7UeaXKrLKLxl6Sl3dcA/oQBYBKljz0Wob/ACaujFjpgKzTGP5KCkap/wAl9UTGiUR3/qpEm1fI+VM2whAi8x+ROpImPpwkcriQxs9RM3jqKxNaomckWvM01FfKVFHPVdyOtya+vK/gZKutTMtAzVs+HmpVooKUjoexn6s4+U10UMqUPOoJun9ZKEutS9y1R9hfA9CAbQ38Mfous9tVQLWPtOe0IAgMnUvnQ1Jp/EwgHlng2grzm4WqAQRyvCSRVzGPN24uy67njQenl0qUMy3VZdlFbZ7Dvej+3VfhXVMTMT5eYt88apFydDR14SshPO/s7mjQ8fJu6rdzfX9tdxEgydIpt5jk3W+a0s053jx+frRXnXLWgsAlvjcb0T/vyshrmrDRJCDTAlQUHAJBi7QAtq0B+X5bKJCvERBTN3srCjGvPkLuAo25AVr7V48VqZqZooT+08MfbtnuKDmLax1CMpGOzimS/wBciNSu0bq4TqK5DIVOsncA/wCKqKKZfHiZCY3WzQMFTkak3jyTTlSnzRMzTi5jpqFdeSWNsvOy/wAloqm/KpPKHKgzwN523Zvtsjsp3GAdNzEaMVP9skvmSsm6FmKvaENJuQkJmtc+K/Db/wDHxkXPQkz3L3umfqXWw/RVTU7eBNPnoIS5rKzJpJJRyUNIlcoZNdakpXQVNE6H8ItudJ/qcbFJsv8A06aoxaa+rroP3t/s3Ls+xj78sp7jMtEl+Mlp2e02djF2RdfJVuqWmJrjxOS/65TJyHGLXM0G5fsfbYI9Qy/EVZNTUf5I5Z0lPVZFSW1+3124wdbJPxtZK7VBfkMRbNBFDLNrt6N9dUSrX2Z66lCsemtXFnTmF5b0faYK0nfUGoYZDrkGgLkgBiTT3HeW8wZH0qSO6e6CSyFlEhdiNZ1zC1Ovvx3paIZOVu9FSTPXU/YOdz1rcRw7MlkQZXz1vx9Pp9mfp/UPj0Vr6EWm4iou2mxMYuQta0yzLWOaWfBzp3sR6A/abZyUi+YsIUiJJjXUJtuWpd8qbUnl+lfgkwiTmZg0olS2SLSCDN9C49otwPtk+dXH6Ss62jVF1NQ4ut5MbjpkCfD8ejz9endT+V8loQ3jqGKnF43zljzyr1V/Hf11bsQ5yTTE2y5iftkiyZPjp0ulJ1d/frybS1mtTtnr+xd7mMnOyomAQtN75rqXbUoL1vidB1v8liAkQu9R+UGMR2B+gZMoYi17SDcCBgACJJ0JBiiAqOmpsqZ6QR1LsQnGhpY00o/vkiOu61pG/rFvTw+eoK4nc6ZlNDTyGutRWQxfa73jyTJTpRbvzzrXLP28y7fNx35n8bRWWAmtTzj/AHzusQbU3u3FzUhI971PjeiQafUPTcFAISEESJEWJWWtS5wxaxndOFLGd9BkeuF6eLmRmWW3p7LrVO+kDeppn7muK/GE3+s8Lc3xFz5mp40RV5DlKH/2R4f/AMqRU8zWWzDDjvGt5B5mcpLBePHPNZE2880b3NQPmWTvIcz4J5cccBZ51Wr5J61O2JuncUIlJP5QMm7UMRVIdgmCU375QJxnzIR5Av8AKR9xoVwSSUDu5oqLKeUecWRfGpRfAXJ94mh8lJMh1Z/aKinXNxPxkQV/e6BBHZWyENmwqNls2QfL0F09VcDuUqHX7Ji5BpPHJ+BLFRs+rNTVbUqufFQdS1+vDvlQSpEK/AMmwxwpF/YYHAI1Xp9QUjeJUHYQALrVjKZKHmviU8hLGyHz4TW8mj6ToqCpQf6qZkk5zs2TKOSsa2TRvHkVWld6idCPHinwZlknpKA3hWut72PTda5kN/c0hj8zqd/lbuLbjNNXRlmR1M8VEh9bPuYv7Lqeygp3WtoxUlOZSkFMra43vYkMEgqbsKRYM/Xl+Lfy/YST/wDB6453etGVX+mk126ZB/r4GWsYTN/2qJG1l1kaNGR8RMmio1Lc7dm/xYSFc/5PlUnx8jHRsGynRKISfY8ZJP7Ac85ZoL5A1XyM9uTHQpc0XJ5pOyjZuHWx/ESCCvlIS7LlygACClh3GksYfaRyEJY/WayYqHDFMW85DJISN86CuLJv5lg2HKUx1yCxqMmIboiypZPNa/p1j4a+Tas0yD41ISi/i0J+0zr7XceJ1seKHZ2rX6E2Opkmkfwcb9quq/pjrHzVXab0lyKBtUEP96HX6lszcoX7BreEMM3D1EEmYO2LDsT5voja0Rc46LX48lBjyE3PUcr01VrzFIy/44Zig/DcdDWTBpoyfacm4R34rFoacZykzUbFZonXnMtY+YnxVXePbG4lXrm7yzvSrqtf9ZXf0nWN1Ka+qfFiKCv7AHytFa8gy1wVTv6u0/FBukMwgU00RYWd4g6YH+Nxi1vOYTIudFxWSmX9t/J8nMyMS6uLaZKlE+NElGXoVfwXJ8e+4qJMjP1pD5CgmrchNTL+ip2szUpTP4RPBRU9j0Y6habK2zNW88XLIv0a34qN6/F2tTPaSURikrzQsnOVu3okDmbmBDepNCZ1H0ohjvO3HC8DeSH+G52AGO2Tlh+NOvJimEiKvLFY1du90nVVk3qpGb6eeSdVW+Bp+CMVxvi9MI+cZU3oydVoEY2M/wCyWTTqdVYZjlHV0Y4a+xrL3ubyWpLtB158ybl/X5dDUy46b8zVS0n1VbGeTuRk3rcigO6SYqqgC5ADPO+bZ2k6sBJ8TYxyHt/sadjMWFmoiuctTrJ5gx0lBj6gcdYsdPVlbZadpyAyslzczj6eucTbVv27fJrRzUzRVamY8yTo2Lx1R2TjXdcVKUTt8zRugDYk34p/ro5pqzhjLVX8mnpoCiftPmq+1/U8nMEyr1Un25Xg6tRJuQs22Bk8e6fdGIBi79lFybb2WdXQTkMYEyY+ef8AGXpC53S/UBKnmoKB2En5vseH0+H+P5PVeryRGT1HunpsHp5LTInt/p8mb1i4Y5qscmfBKxbNZNVB0dGhZaRMhNTEVFrs5nxUlZCitvRvX3r9UeOt96z2XLXoP40eo9Rjxen9wj3H1WHH6n1Ecekx16+fSV6zL6eiLMdvprqWCu8eJyYGgqY834isFUxSPUTa/pHfKhNPOJoHzG5N/l3Ydhb9s2seu9T6DPl9Nh9uyTk9F7Z7cegxequcOPL631dZcnqvV+pcUx8ifJ6j4Ii6rLxixhVUlury5tS0UeN4lRSqTW3bpn96yU90HgTfT/c69uye6e45Paox4vbK9ZX/AIUY5rDjzelwROCfUbyf5JfVsPqORyDeVxMykn5WmI/+6E++Pp8+P6yN+dK9QTB4XT1IGNCppoQqHqDVW5LZPDYRdrToRBHAGNwJGLbljm2tx6afQf8A3rfyhy5Jv1/qPU/x30nt2O8l9YC/Ues9X6r1VY8UM3hmPSTg6X5MPznxhLkqK/qj08+owazfPOb2z23nI5nJWNfTYcbj+fbLE1FOHGEuOOYhed/lv0HpMfrPZP5RjrNE5/Tek9t94jrJPp436P18emyYcWRkctZMfuNs4Zo71dZNVjndb3T0OD2n3DL6D02acuPD6D2/J6i5v/yYx+tz+g9J6j1OL0+XGGLLjx5a+PvFvczK6pT8yHoHWq+aok1E2KI9FAQN1ObC/G1S9NMeqB2coLgcib6peoqxMePrR/ja6oVT62KeNhXWZg0D9BFmlRWI+fGbuKKSSvkOWauprGbjmpXGGn7eeukLNUlDrvrHIvPf1r7TS1r79EHdaFZoNuvxeXL+gkJvGdWzr5HsaJi75rJZUkUdfbqZPr50JYKF9wr2ibeyTjWeRCkNYIt9Y/ONdj/I/Y2suH1GL1sPrsf8b9s/kfuvpvV+sx3kMnrYwZvWR6Zx1WHLkrDk9P6mcXy/+TOJyt7axzHAXzQEhM8mSW6ErS7Wdf8AbRU6XoOXybe/9L7T/wDfD6D3X+Ve6e7x6XB7T7bj9t9Vlz5teu9Z7lftfrMPsHtvoPSxhyZc8+qxegj0/qLGY9Pi+Mq6vJhi/PNZJxTugGeUlqmLrHyy5OdxMGjLNeZGkdIfkfB1xV0vUKqqSCflSqzS0tv4ZfUBLMB2PAS/kLbVTMN9TfTNBjh535QYveq6P27NGuWdMlfipgxk44x1Bpir3qqtgj701O48aDkU1BtGfx7iMMv2MjSwUrfBXNSuV5AlmujnZpuZBAXUn/aSHHLA0Szdwy9U1uqXxwkhT/1KCn1umkDDAsJtbHuCGffWWGoV+wQMxdcp3zTzZCCTkdnxWGJ8Lr7ba1VcCrP28Pjp1+L+TUmuOWJw9ONlm3y3W9a5/VAVzUszrXhjk+TNNJP9j6WUgj1N9qs+OkyJKftFN0nuKzM2NUNhqWWXfPK5Flmulm/3uvAXOnemQxM7e/HlgwJEaX7Wv/jbsV5PsUxPUW3qoir3yhlprfLWlrYA0BNExGyplCyZPhx6pqlrU19u3ZUT8ipplFRBTzG0PwcFV+krfmSk1emYmZWtPxv9SiYZ2Trcflpx5G8O5jUM99zXG8d67dDVb2pkOAJf0fujABBVoOQxYHtZtmDu1EIW3/7Tfvi+2m4cUmGJE2GPIUc1RLJubU3dJ4J553TG5XpuYWqdEmyiGr+22VtyUU1UMxMpeqWvKH7UXy1jN+Kxk+QA61zuxUxvnZ4tY28pr8t+nYjL2k1VtYxZVG+SPuMb+00Vy1dUVrrTDy9WqDCwN5XfCsSlyXQTEApMQ4QJN12E831enDeOglnIVcs6qYkMm0KuJDVVveJlXzQ6p53PpKy9O/K5XHNuOmsbQfbG/QZGXxAy7VOpvrVYvtqIyXioqWrqndGI3ZAtT1tnmuY8HO5JKnc+jx3dbtxyGPsJYHJJolquslmS1Wvr3w19orL58jrnj/xzcB9r/KD+S1pSD3D3IchBpwx7RrpPST8lY8ZclQb+vAXjmSuV3XV5OgqfHXltlSjrPSI5yCSyDHzzF4uwyax85F1oCAVVyQBaYqfzk/SYfjSse5mqmwiu/rsbxanHqQI268Btb0FfnVRVfHms0fDgY7vdTLLBGRLyS+PqRl5L1sYl2vznxh9JqJEUUk5QADKVnv8ATXTRSSQBcoDYYdtzsAF319qen9L7z7V/C/8A6Hj2P+Les9T6D2z+Y4Pcv57/ACT3OfWZvR+2T/K/T/z333+Mer9y999c+kvFi9t/h/8AFfa/a8Wbb6303smH3P3L3HJGGvdPcMFeSe/ZPZ3+SfyR/jd5J/jte/e95fZaztVly+0ZPcMt+hjJVzjlcuCsV1Ekm+tEVRP56T/yV/HsHpv5f/yX/DvZs/uPpv4j/wAQfxL1HofaMXo8eXH6WD2b1/8AH/ZfUe8eqx5815vTP8w/lfuPrfcPV5scY83q/cPebw46/wDGrDGLwXBlxWzKOPXGSI+SZxTBE6wc6mtPDPLA1qIyaoin4r4CgdQ9TrioGus1VoUyKerV/dHrOaqaTSNgtjr1OoPSKaRT+EAcBANenGfpzrqnORE3SkTLhRKgF7DLroMZyHeWiOZ+R+NmDr1//hj3L0Xs3879L7x6vLgfVei/h3/IuT2LJ1lL9P8AynN/x1/KsH8UszY4dern3v1HoMvo1iry+4T6fVTjZrH4c04+chRmaXuN1kcePIyUDWiXGytWrUZK7Vx7n89s/wCDvbvQe6/8mfxuPdMXzx7d7d/KPf8A0fp80Y7x+r9+/i/8P/kf8i/i/oZxGbF8uP1nvvtnt3p//FFyesx3fp5QyxMa/wBQFP8A7PrlVEf2qn6YJHpkDvaWUzliulBvaoHgzT+dvcoI687wfxuvTf8AHnsP8tv0LNe7/wAz/kP8Zweoy1WHJ630Ptfs/wDH/Xeox4vTVHyXg9v9Z6/4M/raf/H/APK9XWAx43Ej6v8A/Q3YYz/8o5fb/l/8f3f+Sf8AGn/Lf8a/iuV9OZ80fzX3n/jX+Reh/i3oPR9VgrH7n7n7pWL2X2vJFf8Ak4vcPc/R1hyTm+Kp8g9VP8o949p9H/M/ePc33X0Xq/fPUfxXBkz5smX1GH3D0XtXt/ulX6X0zR6DBjr0fqMM+ov0ZWusceo6q4+Tff8AGftvtf8AIf8AlD/jP2f3v1fqPa/afc/+Qf4V7R7r670HqL9t9X6H0HrP5L7V6b1nrfSeplMnps+DFku8Xqe8dY6iRRhXz/iOn/d+B+Ip6nUABorZpDFAg+lf5EBP99DHrpQTIg2cBtfYZLsTrT/yz2H/AJCwex/x7+S/zv1nrPWem98/kn809j9iz+6+pnP771/H8vs/rPesfu1ZM9etuH1n8iwZfSR6nKTq/VnpsU4ZHLwVY/lgcZETh+rj63OQxDWRMf8A9TXUhjh8JxfJGO5+iPffWe/+55P+WP8AjT3z0+dz/wAM/k/8m/nHt/p83pvTY/cPaPe/Y/fMXs38uxe4Z/T4X1mbJ7p7L6jFXroyZSJ9T/GfaHPk3ixXn8C9TvEBk2FXzRJys0IdVDVRdT5qqEcY14nQdX9OJq6AFQopVQ9P9sKg9OoCqggboogJkK0az61JpLlFN/8AKHneFJ9tU8tRix5LuucbhMcgSpbXMFTWTc5Xs1Mikrp34/NVkydAamcmOdV1sb+J1TE5JtarafJ9Wj5dzKmr+fDiu5vMzmZwU48jbUzbrR8dcGS5JiZmmbWPl6044nV58s3oxISYzomQvLNUK45qi6rwDk8fIHFTQzb6QAIzFyPGPoFsO2uSsElgIFEk9ro3M3tAvr6Y/wDoSf4v/Ev59/zf7H/H/wCZ163/AOk2L+P/AMx96uPS4pzZ79w9i/jXuPuXoo9Ngu30+V9N63Hj9cenzSY6PSXORxStzuf+R/d//oavZ/dfU+l9F/KP+Xf5rfpj1Xp88Y/a/wCP+x+nWKx0Xg9Z6j1Pr8t85by4byf+ETjqLyYmsdY4n5m/g38293/49/mHs38y9l/x+t9k9Xkox0ZsfpvXel9Xgy+j9f6DIYXHkMHr/bs/qvR3kjLKzkCXcE1pPf8AN7V717v7n7p6Kcvp/Reu9R6j1fp8Xq+Yy4C6rJPpq+HFGNxYoy61jMeN2fHElTM+d/7Dq9T+p1dev4nr9P4f+x06aKOnUABXSajVg1TSaZBAiba3p6tNHQ9FNFJr9RJKJQQAARDwOfd9z67+df8AGvpvTVi9o/hX8mzV6iMg5Pdv5VV58cVzijJjw+g9s9LF3BG6yJUGS7V0afN/Qe2er/lHuT6b+O/xn+SZ8/r87WP232zN6r3AZvqJvLijE3dLlHWQppEcc/N9frf/AIm/4d/h/o/aPaP5l/yh6H3L3j1HvWH5P4d/xr7NF+l9z/kPpuqj0vvP8h9xirze1fx/1fqMVx6X0+A/+mXumEc+G/S+mI9Xm+in+N/8h+4eixeh9ij2X/hb+LZCTH7H/CfSvoPW5PSepipifX+qxN+6e4ZseJZzX6r1ruJJy1j/AHjXxH9b+F+Bqq6fwo9dVMVdbr9Wr0eqkpUhVV1kF/hHpBMVX1r0/hep16aaqoBRppppDH/lgO0nkC2vkf8Aiv8AwD/L8FR7z/LvZPUfxj2D2XFm9w/kt+8+9eg9p939T7T7V6a/c/cMfoPZs2R9w9Rnz4PTmHHjn0NBkYnJUDdT874Pbv4vm/449+r1vv8Az/Kv5H/yb/Ho9v8A4gen92y5c3t/o4949b7metozRh9T6eX3z0/rD1VRz/5HpvUekicdzGTN+gH89/j/APDv+Pf+P/55/JPV+t9Z/Jvf69hr+PRmy+uxet9THrP5XZ7bm9VmM+LN6HHhj2S/XZrzfNmz4iLsq7Ij8+F/+Kn2r+Q/8heh9y959sx+y+l9n/g3rMvtPp49BHqPQXXpPVz6f03vQ5pCvU+o9JkPV5PU1ibz+4R8JcQR8Pb/AEj4/r/GdL4j43rVE09Kvpmimjp+g1HokdWqkU1Guog1Gn5gmrax+K6NHRq6XTpRNQVXqJPp9Z9JsgCFFMjuNP8AW/x/+GY4x+j9B7Bm9zqKPb/T5MXo/V4rn1eWzFjy1y5f/IqxT6zG6r/FOQ4/PPf+So/i3qv5Z/Kqxeqj3X0n8d9s9u9gwepPUZvU16+/ZfZ/R+gy+6nynpchiv1vps3p5zUpix4nqKY8e6/y7+Tei9HPqp9ov3H3H08+rz36b1fwnt+OPU46hwKzXpseSxWvtGSYPJcYMTv5K/mkYf4V/If5l/G8WbrJ6vFhxl0ueow+prB7tmw+qyWYsc+vwvqvi1iiZnJizS6wYcOTL9H8HWevXR1qhXTVT06qaaDV6gRXX0iSxFhTTJ3GuXr+np0ikU0mlgEgAgGfSAWiEN9wJjXU+2Yf43/4fo81fx/uMuKcNVrJY1WM3kNWY8itdFmR3P0fTuOe3tv4P/F/Y/cv5F670XtfqvWew+qy/wAW/lfrMV+35Mvy+r9w9m9p9R7z7R7ZGO4jJzl9x9t9I5sWHLHqcgp6S8mXJMXpfbL9rv270GSs/qPTsel9NrGyxDxjhvJJgKhoaGf8KIVt55W5i9J6bJ6uPUeh969Z6X1eHO5sGbv4MuK5WTJ6apxmUqq5HzzWs05ZFmvzq6/TPV6fUodQq9BNNV6QQAX80GwQFgxGo6dIpAimpqyp2WZcboH30Gb+O+j94/4y/jf8h909fnwevxfyb+R/xX0sXg9XOWfRX6P2v36vilv4a9H6X3L3D1Xpse5cvp/mMPqMeLJjleCv+I+osi/bvV+ny1JAfLBgy5q1PjFVy47a+p0VUpW+UuMk/Q//ACZ6H2D+Ufyv+c+j9r9DPtfpf4r7jXuvofa/SY59F6D/AOlefF7f6D3zPGPJfon5/wDy8nofU+n+H0/p5n0OYyZcP+DD15Dk9hx+kw4//F9V6rBO5YPTernNFNHWI1LjqqYYa1PXmYiZbZm/hK6v7QqJIJqPU9Hp9QpprVVIjZ3iQQtLrdMBKnN5ZSH4YzIIwJgjU/xr+Ueo9lw+p9g/m3tXqfV/xv1VxivLrJWX22vri/8AM9syTE4thN/S64oCf3Nfmu/lH8Y9t9JnxZvSOH3L2b3DDV+0+54uSM8ebiPUjbfpvV4cNS58Ooy49lDU73V9+9d796GI+H3CvWyw48+P1Xpz42uco11eOu7Q1ky5NZIatyVrV/nKV/LvdPS469J6j0cx6dqLzRggjDKDN2QxUTloNtjIzKqkfXamir+4erQQAV66KTBRbGQY5dtc9dVKAqBJAuQ7pljvmYAWrOf+Ke31ROPEm4l/xZJmeevE5BqpbsqROibdJNTt/NPm/iDj04PU48beX/EZ6xfSeJQtloh8jrglK8V9zm76r+T+myelyHpazzluK+tbmce2KlLxPBWNa+KSdFdUO2Ned+orJkauM+S3td1dVQqvCaEpSZdB5XSdEz0AVS4sRYv2XYj8tYVelBDGFG1h72zha7DJ7N6vDOaMhh9TFjGPLObtm60n3lCtkDMkuRWagKWvzmvV+3W3Ljx/HMxoq4ByfGuzT21XR9ma1X2/rpfzVGf1OKXjLlmew5m3ZXT4rxybCdaOqVTb4Np6X33NE8XTcQC1TSsnxzZvwM0KiTuUpTrv8f37FKNu6aA1KFQkVDkhwMxZW1B67P8AHXpfVzVY5WZyUZOpk5x/92frK7StVudcj5R5x5dZMeq5uTop1oetpPTM8O37m9OpROdlkx+h9yKvBrFktmjFkZxj+v0IpTVcov74FPq/mr/8XP6G3IO8bZ9ZpqNKKIAa0bNbZEoKLqSySbi0MwX9GV7B8nQQb8/yR7e+0q9Z6VtLg6ZIa5EGJlqpbNrcvNKul1s+uyl6bOzkRnZVVLKtTO9Y5TdGqHxvbRRvxqR3s+onJ1XkYj6y613Gtxz1s4UDWkdQR426fL6f1GSsmeMGRwt1u4h4mteY6maCp1S/ajYlf/ViRCIRMP8Ax7N7D8+NKqmy4KszBvg8/vqxmyiRzyTj0UchqpnfTqnxHgqxnY68+Q9kwZZ9Z6P0nqudZM3oPT5bKs7p+Ii0mh+rpcb0tUEvUgz5L6T2P1vq8mOTFUmQkLyzRjxNUG8jUB+tOpVGa87616jj9O+n9J6f0mPJTPpPT445rI9VGPr5Nana3a1MjyS0XII/nL8VVSRSGPUJUGEmj4FrzA0+mSbsbcelZLQtz41Wz2hdLKarELjZ1bvnM1X6FnxT9nT47X81GfFJPmk1p+Qqd6qFDpdCcmSfj8Gup3wLtvUUdTOTFVTROMudTjcgsHcZPNeSratKtOiaJarX5sU48RDR0syXWqQ58V0mpxjGQ0C0LqTR+cg/xaYwMukY7rvOx1ZLiUhJwCtu3EnXmtY90VUzPBATXXNMsb/uLW29RpN8p45FdOSg/X65xlMv7F5vb5J8eK/sBP1WT8XT1jcY7+OytUs/JwRKNVuq+3jwT4nizuZaANU6+/VVre6IOglm1nomtID5afA+Pz9CiFm64QxBtgW2E6gIFnKgx+vZhlBDR8/F0wlQ5A5fMxWpZtqXjRrw/r/vW1rqvXNW/I1Mzl0WkPkuGsezf03SiHOhPF81RNXLTORRvSvbM7R7UdHgfEzypvXnYOPd96eaL2VXPNJrWNbl6/u65NO+VLmb/Bgx/qMps4IWDo1ZxW85Nn971KzqhqAOquT6vyc/6ppkduvzLyZIntmXmTH/AFoC/DNuRsUEd0z+z9WzT+DzN5KdzzOP9a5mmfqouqqnRRW5aCv/ALVJZGbjmUnqZhtGTe/GlL27B+RAdUGqfLBKRg/UwLb5Rxp/wDa18WiMjSil+51vuKnIa/35TcymoX7D40I0AfjaLuuixyBuxfpczpWCnRXVTAHLNPW90ioPjvOtl8DM68lNTPNBOuXk+1SalUNL+MlLv7b2Yuaf6HXmWdV/pFkQerCE2fi75OO4DI5UwuzLYtJF/wBGUIU79jGltzPmseTIFYhX66RP2DzYJW9MSM8H12fmf4qYqfFVPVrMzGTmt1DjE6T/AGeSkZPGn8K3dTjlmOoZaJZGPGjzsttdKSS0IV+1hCQdzKzMb5YnpEMnfnnfk68IiyTM+GzKRGN2gLw/cnSRnjzfn9Tfk6hqcpfCSgVU1vpsnS48aX+lEXVQ9QEB1+HLMzBWcjxD4x/HNTqTRv7Vk8cppKFkRd/kHnLxbOMxz4QmSsmLkLyPfVRXXLrzScv+ltXiax7D+pFTG+TnfnnzR961ox/XfJeklkAOJMAwHjydzxtfROB/I98QWu+lmaXdcyPjCVUItbkLsXnW9BU+dzokZ1+FGtZNf2x03S/W6553OudVpvzQa8TAbpfwSWbK3OSnG/2g5HyyzbW6zM71WxT6+N+YrIVHgSvklsNjdp9mjbU09aqaea1RU8vmw5agfpkAdnl3GjmFttaI73JfmAY45h5Xv/2DqpqVdEVeg+MqkPG2ps0PLUY7bAf2Jt8VuhjZkrzahvpT9H2NHX5nyOIN4p3koqbjfgo3PdTYTyz+mT/6oxun8CXDGWrOu2FrfLpX/Jsmph8aCBpP3W8dh+PItKYMRvzf73F3kCB3vi7C+m93LM2THvFcwyaxjR9cVOvBc2luOh/ybt2ymkjTEk5U3zjP8jVP1i8nVaJ38izuj6qdaDZUyuYocmOGSZpnmppkatoZrVVqdtSxQbf6ABL+HlHATyF1Xmk01N8/amzUjqEZ0UO/r/8AKA/yhD9ih/A7MaYcOAOzgBDKMedQ7Imcmabp8tjMtSRpgrzSHGo+st+VNq/kY5w6mqqZQjrZo5n/ALk0W30eNIeTXl5/BmJMbW/DDc0p2SCRjRFOuReCuZX9jyKtT4ZoK3ER1GpnpZI+TJW2h0ze0+0vaVGvwaIcwLne3NvqzodpIi7BuBvOeUZFtOyZbklzxuBrBiZ1M6OdFzY6K+1OXxWv2NTW6mOrtpqf1cxSx5KOSPvf1ZlK3RjQHzJkX8a2nNSadzj+yoWeflUo8DLPTLzyiVy7NUrfPyFS5ipn7Rbrf3WOuLKZgPM65rfR+Fy2wJP6YwRge2k32HYKR7dwJ7WZ3jwxM3Sxk1p33peejJyhON5qgZH/AGQ6r8sfJP8AaeNaMRqPPh+uRfPIInWn/scOgKgsmT7TkU7xuvk1o7ivr4x60vj9b3J11ps1mrHiypFrJL9H6O3X6Nl+N32UNarrXerBNrgWQk2Cifv3I1QN/BH0NsDY2G5yzK6DIJdTM1X16mjfTd0a1WjzT9j5CpddSIrItYsqbOGOX7VjyaOAuU/yLT+v+vmXQP4Q0lDZ1W7lsVcQGse0Z/f/AFJAJWUqtAHxNzWUqw1ElSEmRZpl0hPAaFqqE6f9T+GFOLmMT7SpEGCtDYiRxtBJ2AKgWwjg8TefKTUy2eDspnRoKkve8huyKT7WkgVLpkYmove9xkO/sS2Ek08f6OuZupQ5rXM6dLw2mSiSO9OKHlKl3JoaZ3IiGSUd7net7ByZKdUWhU4uZKOmWJ7ydVuihR/Qob/2NUkel3LLk8fS1gwxzoBQfnEJD6iLQw9XpxenkrmYAhknxf2/qanU7P6V2Okdfr8S1kY/X1mybJocm9apkXIp5CE/7fSjdKDEXBcqtFTIfV4Ej+rXIya1+ifJ4negYvRMV+5y8qNT1kmYmesimyua/wDt0A2J9Wv7gQCqpEQNxA7oi11vp2sLhWc28wJCY+znNUgc8ozhake2h3VaqnxQb700gGtifhzSSAzkGgnYJi6J4HJsDnSc6489G9u04Ws+R+WQoe+qOZ+p/Wqteyr8eCWkZUudluZilmK5BcjvRNgCTG+5uekJGd+Xn97/ACqJAnKHZh45+jm4Ah82JXPiFmTJMPU1/j/9XRHa31PRrcrkaxvPjTOyTR51pYk5ZQ/yHP1sormU6kCq/s2eRD++uK3TtR8vEzWVG2AreMvcqTzM6lGQ351tFGqKKmvJHyfXZi55Qfs7JyWrUlDVZJ5CeTxtedhUoA5m4fpMzxDuLDZglb3yL3zwlYEWELRW5cnCUYwnqylPkguRUXV9E9cyGvs0jSBhj+Qa5AhdhqOu/pIPTpQOteQcbQTtlrj/AGNB8R4fG9TN/Jf/AMyM7B3z4jx+Lqlx5r0VUuOC2BqT6Oqp1HBw9VrygaZ6/HAPNxwvPaLng6YStgZAsLXwkX205WNOOi6pb5phiN8a+N3Gt2MR4CrTcpk5a05HudVyJWJWVjul1Z55133PzbKlKJkJ5/Cx1dylWDWVCx8s+QaygROFTxydHkn7b06cHM8vPjCbeJWj/b1b973zzWt3KzRWt/jAFeRSkS5QC2ueGB41Uofx2EZOIZU4ehyVdn9XUVE8z0Fa15d/dr/rDoKPqnn8DLU5amKFrG9Na5mrgZJqr205FV1y0mp5oK/Meb81T/YvrxbAcDjperEFXmf/AJg8pf4USVjsmCeEqWiSrqIgZstqnSn/AMdsmN1yK+BkTAf+JsLBwDEWGSjMHd4Bw/GO1r6wxz+/08Ny97cf+jEfUfNE7A+zspDaLxzGC8r0VebefqZ2wrOzqJkmcfL3srZPjxM4/wAai5JyORWY+u98MFecP1kbfBNeUsKN72fgGbgy2m7+RiEx11O66A+x/i3NL53sfk1pPySLFMiXchC4UXgHe51JFrnYg2ET54Z+mm/ITkxIz+sYElE97Ge66kehp89JQ1p/MogpCmGmrrVY9Dt6xfUbf67JTWip7loTJGseO/EKSVP0msgBTciX1/oCUd0To+uobZ39CJExLMVyO/78rqR+w5PFbK0LL+WIUOxVr+n3xLAeLOoSAtb/APCTfdbiQzrC+YxtBGRCSKAKvoZvq66l2n9tVuWdV/sLq3+uX5Osn+QPHMUf23EfQdIzOwCl6m3gsr8mtQBufvOicjNcrS9Ic0DRp2hQJv8ACw8qY3B4PpJ+pnxM9JdHfl+tVwtAK0BRBPpBNIid7JhAGDlZwQylmoDEUtsJgDeAB7IIrWY9+cuRAiagn9fJUGPhk5KZ0Hkqt3rxrkZWshtqOjF8ko46h6De97XNzz52b0mnnpiZHjelgnlXiGYrRiarZW9c1rxk0p/9pchvKHQ/JVTW+H6g/EUrs8akkkWaORdoYAyIeZPpZAuQYgC7VgdPx3m3MDlIyJF9RU/HU0Qau4rVfbiVNTSaJkqFNzbGymaxlyMusEc7hdzW5o3k+1/1nIJDReiZxNIjwIAKtxzM8yvZONEriaf03VIWDNP9fryH/Ufx1c5cbjZ18bJDO4MdT43P33cvW9FH2PGqdqgfhAYD3soOAiFZwyBcz42vOzS2ULI9xm0axoFZaSaTfEvIdXQBi+9aZl+36JfP4VYyjne+Z8onNxKqds7bsTyErCrr67Xjjqx5egU2+WZrZP2N6Q2ArTorRoCyZLx5Pkx06uja9fGVT48gSDIO9OkdCbkUgMixtGwNhd/URsdSHB7WzYDaebq5a0rNuaLndzQRkI1PF3wzZx+kid0OkA+z46kVqukD4tQeKLoCXJ3a9WvXx5NS1+1nRs5icfmDXR0Nap71J0sOgipDaaOh8DoTuj7P2f0WT5ntGaaHUEU65Z35DX62pBJ7ZCcKZPMxGUtVYv2DBN+T2FriAJ1N1kCHHMlfSH9xDS9TldN741vqiZ6eUo8yzG0cxTu2TrJyFVVTMItHLKlRGpWk0c72hxJXmu6ZqZrJRkOAlEyS6iT/AOed/wCgkdBVXOlIr6JuR66+r8mS9v8Ar/t+zXg+i/lUlEkxZAXLUU2A9SUuLs6dNS2wjt+EsDGy5500urJIxuNYnHf9pFdrTGsgzyG8lP13Iz0I08xGLLOSWdW0AeTbfiqqTTNkGwnwTU61IDZtMmKjI/8ArJ8VXxvNFROS15osH6k7WUNS6/G89KKIlW7jepdeYV2fHWyQoE2yeaSalUlBCOEoc3mSZjMEnSMrccCzDO+4+kwk4vqbdV1JkVXVaJ+k88yXLKAf16XexBmNz5PkZkrWWmjcxTJoTHuZXeyW1TaTZXWhIyxkrLDFTUwVkZldEjVDqpxr1Skk78VpkpnfUBNfGTElE1xuIdV5HvvXkHnqfLtfECqwELYI4mZA/Mw4SFuxAZCvi0e366zJjxX6iR/emlE4LKZ+Mdc0WfXjGpsRrafhzUV/2o50NzPPW+SYe6KpU4dSnJzreq/B2G63X+Umd81iot0D3kTmPFABsotN+T8zquMZUkT9cOySe666W+qaqdhup+1V/YQ1+Jhxj7H05gYzewvEIMu7ZJLmN/N16sGYbLkmaritGXnz1uDxxR1JPxwzovnf9pNGxCM3Fo811f1yaFHcs039QZfLj1uNrIO5bGK7PtJ9poxb/wDsmgnVDdDUyjqmXbRNeZeq141pcVDPyvSuqJXwg9By/wDeeZN+fDTLkIj+WA2ZsbxvbVpIsNLPb/XsTMOvJsHW8XcTbwh8g+cgNVEzXNDk1uR+s6xhRDrc4/UVMzt4zY4Qg08TTNS0Vo0T8Sb5N084YjxwMUhRoj6Q0bmedjSnU7naL+wT8jhFR62tzt6yQVqvNG/jSwqZqeRRn/7UmxYCKJwpHm7w9VDER+ce2fpnR3A/AOYnxjp4cfObG3r7v7cv9VXk8vVh9fyznp/xaAxjMZAmpx8hAFUOmEi+rF0+eWuhqg0C0j/7NtQ/SX/0P/Y/f/rDfSy6U1ahnU7OD4qDWnbKk6LfI7UyMlNBo6kXmORayvYGm7x9BIzpFjzvsFi5H6Y1Y9OYma62QVvdOtOgYrp24xdfXzv6gakGRVpMmO6mb+NSq64edv6/oE2lVy6lUkin8VFNH0jlTiq552tSfabdnmv2CrrGBQF2cdfYY5p0Yqrlqe/33ofOuftb5VUnje+TrTbzu19Y8WNnoTh7S1JxjbaxFnq9ms43XjnGTqVqKRnw2efvqp2HFg1o53+djfseH1nveP0nvVZfSe2+3e1YK9wn/wArGX6f2703tOP1NfCZE7z3n+vpfTVGj1eQWazZOXmfa/TV6v3X2v0sk0+p9Z6PDcVG23LnxtRRJkhxJvrU3yH+3dFz1Pt3qfdT3/8AkPr8lRjw+sMsiWYM/uPrfcZnH7fjhnJlsPTY8mZx7xmPHggPrck+R8QSal6vSaRcSXUQKRBKLBNiI0UUoEgOYMWF3+gv4WtdhwHw4aqSKnHiaxtMPxoNHPEL1uZrX9nUIsxf5YayE/WeaJcY8jSHJs7tNoMTQLVJBMp0sq8VcHmNUy6riDmg4Zq/6U06QBDiZ3B+K9ZM1xRvQaNLQ4/2VeSeq19TrxO4CU87kBqIsWCAyJZWxQ7ytUEptNk3ENY/VHffekxYPWfx3+TYYzxHuM37F6v0sOH5c/qMOL1mePWYnId8xNZ/SZ8syE2YuRxnCUvd/a8XtHrPR+mBqfVeye1e6GWc2S/T5M3rPSyZsmGqmE9PdxYfSsm8bfJAc2vbsPpsf8c/knumZiX0mX2H0XpZKbDP7h66/Ueoyzg5icmKfTe3ZRe9zV41x5RT8oeu9s9T7b6j0916vH6vD7p7b6X3b0V0uW8PoPWXfx+kprgxXPw5OMOGWEpqaqE/OWkn+7UBX6T6imCiqaSQx9oedVUX06USCIGM0p4QLHnVXNEhHNyX4vd1GSXGoOB+vmXxrHuZZqwoXxXzRGb6Vok6yxQfRQ1EzLtmaSdcAUmmpZmvw8lWXGORqMlMl6RJ3EptWZ/q+GZmdjEyrrLeJ0bJeoluaMml1H+TRqRlNm9B4KT86WwQZZRx/wAVfmcwSNZkH/INRjCsCxxxi+um9u9u9N717Di9r9H6iMf8h/8Avm9Hk9H7fbPp8Pq/bPW+kn0c5z1+asYZPb/WfFjjBbjn4vXXZYY7o5/+RT6TH/IvfcPocX/j+k9H7p6v03pMOK8zEvo7+GnFHqYx5PjzVjc0OXHN8VIzOm3ov4V7LH8i/lftPteT1WL09+qr1uTB6jLkiB9d6P2/1HrfQ+hxNYMkf+T6v1vp8HpvTYqx85vU5cUl4uu45P1uD3CL9P6r3O8lZfd/T5vWF+ox0+pzM+pv02X1ORuTqcmfFc5EclIbMhK0cvSVPxVVB6lx6vTck1EEbA/gjazsNWUek3LG0ilEIHg7ap5KtwfaJgSZqvscj/8AZ7ia2HRf23XP3Pj+j1qsv1mARamI/wC3BkUS6sVNrkDy650nJJ+bjLUxB4gomY04xZuit1Uq/wCPnZdXLZzRWufyhAVWSXTzWQ6qQ1avMrSDT0sckP8Ap5rmn1+l/wBpzZx6QQkxnjC76yOFJC77AdzmJERpWGKG6LOZaH5UqzZLVx0Y9M8gM0nydaEfFVlpoqRyVdUujHWSJ00PSr2gBo76Jo6jt2OapmZjotu5VNTsySiZMk8wb8nHja63QK0zHWRZH48o76XXURJNG9mS6/6eQ7PDpnf50UVIIMH/ACEvGzsF9rTo7hCBe9u+wAHfvqCIaK1Nc436pzO4ZqGlPvTEzsHdH+m5BsRaZpyHKzDjnc27KQ71v9I8zVf1qT970hjivjv+1Tjy/HO9nMv1Ybftx/WdkhvYz0zok5CkJ1/jkJodUhjbvY6Xek6dfrpFdKiUL3GwcgL91d7aSkZL3yF7i7EoKBp3p0qaSAoiy244ao8tQ1vqx2R+7qSp0eL/AC/FARHyyVkJso521TjOsthJCPc7mfsakTxRTx9xy8Nafh5IphT+t1TWp/b9nzWtM1yyXYGsU5Ck1kGi5KsJku4YB5x6PrxRO52eKKOLqVHdli4gCIkyr/pYlLeRkJAYffhd9bTFjBxwP25ZvIJM7KkLyZTe21ZEmN6BR0O99FOOEnFh1VLRxXhbkiJUZZnpr6V1/XX71LpvSTFQZZscltduSRzaAs0fp5ZCa3XVKIY2db70+PqjdTRVTmjJ9SiJKr4arWmgHREami+cgb35XVqks2FsYnuNh451oqLCM4CW10fJQkcX6T2+WsuTrGXWspq8c7jrhuMemBCtsBJ1f1t20fnvf/A3t/8AH/cP+ZP+LsX8n9N6X3D2L/79vY/Ue9+3erwV6j0nuvofSepx+vye3et9OJPqfR+4f+H/AOF64rU58GfNjLEmjwz0cw87+v6+5Lj++3mGqdrXR0yHT9Fmit/Tn/Bfst+3Zfef+YvccmD0/wDG/wDiV9rzXuvSeq9V7n/NP5J6H3f0X8K9j9J6L1dRGf0z7h6P1XvPvdWxfpvY/aPX1iyHr83t+LJ8j/WqxR8J8SaqvT66P7dIBk19QCmkBZJIA5516PwgNXW6cfhNNRYBiDYBYDJsLa1/uH81/nP8m/iv8t9y91weiwen93/nnoMf8o9f6L0fofRe5+5eo919N7r/ACL0Ps3uPqfR+kiM/sXt3r8Pq/cfb/arzSem9RXpc9+mcmL02X0fA46m6lxVEGFCo+r83xzpvTjZopSSdgysM8s09F/JfU/yr03s38R/j3uXovTe1ew+u9rw/wA29l9H6LD6THPun/3xa9uw+++4Z8d1k9bnMXtN+l9vw+qyZcvoPTY8uL0WWMXrM+N5rFV1UfRMcZJw5KIAu5d1WSTI1XUqVybeuUfKeN8H0qen0SaaaaaT+H0BqlU0/Mbk/KXEMX11kuqC4kdyN8FbHXQGTJVY6SjHNxjZDJBcUrkyZJ7Um+NNtnOslMKG/V/+Ifb/AEvr/wDk7+D4PXXR6fD7pHu/qceD1J6fN8H8d9D63+Q5vQ+lzxr4cvq8Ptb6WMfVt16mfvJfWPyPHlKqqCZucTi1k7q6fBWSJqzuimvjqucjU3GpoKrvf+M8XvXuv/In8B9l/j3q8Htvu/un8p9m9uweu9RgyZPTelfU+sw4fXev9VgnHeTN6DB7c+sy+4cM1l9JjzYpjmaKn4sEfD9eRSP7NYBKNI+X9CcebAOgKukK5HM7R39s7aHJ7n/LPf8A26vdfd/Umb2P2r+SXh9N6aK9Jh9u9t96/lPpJ9xr1HofQ+jx+n9Nhzesw+x3j9XcdTR6b0sY2wLoGr+C8s3WG8Wq3i3iz3mnqnLBrqa+1uPIIlyTkCTTtsn8j9v9f7X7j/G/47/Hsvt38fx/yzJ73k9+9R699y9f7vfpvQZ/R/xT0fq8nqPTYo9tw+3+3+p93y+m9Hhcea79T6y8xl+HHWKjTjyTzNmTH8FOW8eGanQb/wC1+Mo0GSmV5pP6MjyUU1f2iP7QpBB9FGS6QqqgCmSybmZUDSLpqBf4iEd5H5A4c6+nv5v7NPvH84/muH+Q3Htn/LHvP/EP8c96fRez5PcfU+l/kX8lzfxn+Pfy/wDk3qfcMuP0uXL7p7t/J/4ZPrvdc8z6zF6E/kk+px5fky5b/wDI+Q/W4cceZzY8h8HaVPWUap+J+t9dngZxtGKuiJkqt/XX8r/nPuvvP8o/+hq/5S/j3pcnuPvno/ZP4X/x16vBhy4PQ+ry/wAs/wCN/Wei/iZ7Pjmam59P77/DfVfxX1D6v1vOPO+7ZfTTWXDOXDHyh77i+L3X3P05jv0//iev9f6TFhyZPt6XH6f1WXFim82O5m+SEMuIocldk3sHk/o/rFHprqkUU+qj1P0dTpn+1UKQACKflCGWQIEX8UAUQ7uAgaSk/BnewmRzHq7s9NWXpj5GccbqVvJo3zFI44r5LbmCq5isUPUA6bJjnJGO0nNvHNPx64vHMtpeSSrbl4pa1NfXo01X5vfU+m/xrlylXMRkjJNTeiYrnDL8bM7g1chq77Supcf5oqpwef2VWi5puMRkBB38cc4z5K+K3cj0ylZZr3qUCV5MZwBcX2+0ckn0hlMfigND8omyO50FYv8A63xT1ipgnIDqqYmXrFdWyvARJCGmqXexKF3fpsx6iMc/+P8AWb3OXVxj1lpvGGjHkgCKq6IKPjWDidteNZiHWMjH14YjDRPU1irVK1a/bTpeT6tRrUevwVk9NkmT9swY6yZCr0al8kO3fOFJXzRRLxSz8tJDtSZ3ifp586g0j1A3LYAuSwbTFuWsa/Wv+FZvS4PSek59Hfqv5T7v7fjzehwYpxfPg9tzx6TF7eRlr5PTe0+2+mxEzOFtnDijH8PqMBhC5/mfvPo/W/D7T7z7/wCv9w9X6TFirN/F/wCAv/03yXkjGV6vH6z3fFl9R6E9Rkx56+asd5zoz1bvmvzzz3H3P+O/8Zexey4P5v7n6r2r0OX2327Jj/iXosk3/Kv5TGP0XoW8/vfq/S+oweu9D7f/AOT6d9L6H2LEYcfpoy4s3qqn1WRY8u9v/wCc/wDkn+TfLi/4R/449p/iXsfqJ9Z6LJ7x6rWfHOTFLmylepvJi9Feb0+PHOFxZX3G5cT2/EZIfhOl/TOt8R1Op8QAKekK6ger1aqen0gzCrrZNrdMFr8eB7J6tIpopcofKPmqUCAELrIB2me+/wCQ/U+l9s9L/wAb+3en/wCPfb/bs/qf+S/a/Xx/G/5X7ph9f7n/AC32P23Hk9Dv1/p69KZq9v8AQ5fdLv1HpsGXB6dy7wZ8bmyR6ePkr+a+5+3fy7/lD+Qfyh9zj2H+M/xn1P8A95P8Q9kxeo9P6HL6b2T2bJL8nuWOsXtXR63N83qLxw9P/lfFGO/T4oTov+Xf4r/KP5Z/zB6H2j+Xfy33P3j1f/GH/Gnsf8q/mmT0HyelH/6Xe2em/k38g9n9q9L6Ovg9t9Rh91939L7PjzfF6WPcMzi9fmovJBPhvqf+NvSYf+Ms3/Ifuftleq9w/lnvvr8vteX1YOPF6D0znDKE84azeo9fjzXiy4qy/NGAbyf5cofc/wBF+D+G6HS6FVXXpPW6nSFAApqqpJ69RrpINVRZPToEkNEuDSB5XxFdVdZ9PTJFFT+ZL5QAICQOZRetr6n+RYvVZPU+0ej/AJP7f/5PumTN7d7X6aPUnqb9X6z1vqsHpfT8hk9V/wCPlayziiYm8uSJ+PFlyZK+3h//ACn6r2fN/L/e/QHqrweq9j9bg9k9TkyTlzznyezen9J7V717gZc+NzZj3L1mF9Tw4/T7x4px/EGKd9F/APYvTet/kn8Tr08ek9L7gfzD2L5M9ennJWPFfuPo/UdZY3kmceMxcCwyTd5aCeWav/I38T9q9q99w+7+hzfN6X3/APnX8xylXvPNej9v9+fbsOHPuYqM2X1k5nN6WcmYyT/4HqsWPHeS8X59J0x0+l8ZR0vVJ6R9PpFINRqNJLQx/b7Kbzri6lXUr6T9IXqBqcqyAcwThDuTFf2v3T+PuLWP+WYseMwkQVittaWJuIyBByczZinGmiPT49BTu/Seu9PGST0n8l9BnH1GOe82GPlcTY3WUKchh55a4xVqe7Xak8/7D7dHq/5F7dk9y9rwR7flyzhx+lfS4rxOCricNsS7yY8c3fNRW8binFpZua5f+Teg9D6b3vN6PH6TFHpj1l94sQRx/nzJjKLQomZ5keahjhlnn87z0xWfSKj6iBUWKTBu4gkbTGVqfVWKaakB825Eu579mIL19b/zLJ/H/fPbPYPXYvdcPo/U+zf8e3fu3rvbfT1OP+ce7ZzN7d6dy58/q8N+4eqwOb2/0HuUYPTmRPaBxHqMnofTFfLv/wBI/fcmOfUem9bFVevURr1F/Lj43FenrI1zNxkNXi6CaopzQWv53vrv4l6bD/xP7T/JvSEcew/zPL6X1jGT1eb13/je6e2YPdvQehqpyOLF6b/yfb/Vk4o5yZPUZc5/lceNjlP5z/HvR+l929fm9rPU4PbfcPbvb/5D7Rj9PluTF7N756KPVxOeflX/AAeo36eyKvHcFBky6izl+DFHTFfSHUNS6nUoVVIPpNHUBA8iug0ksinYICusfWATQZFJioyUJF5C3AL1x/q8/wDKY5+Zy55M3xbHFcmQTeQvdP8AquW60fItwlZF5/N6r1H+T5/SlwF6rJBTVbBhtZmwrbHBz0LL/joOm9x9sz+3/wAK9u/kGD3P3GvWer90zejcblx+o9Lzh6mpgf7ZiIw5Gl+STMksutcbPr/e8045q8fqZHH9bxPT0Gpq5BR0d9Hx1/e/uUvfSWYlE0wwpAIU942765Kyiqm1SXwURl4DAkKFfWvz5PT5VvJgcaWKmnjezmouYeZV+sPA9TIaGtfknDd5CF0XVz3qAmakAje/umzh0j8fUuvzb+rw+uj7+o9tl2zk/wAGSuNHfcshe6Bp886PCaJ/NRWTDNS1iy4nmRnmT6qDj+oWfvxSaZmZfEymiSY4l43fe79tZESD4EHi4wEuY3Ol3guoqp4yc+DlF3/bt30rpex4ARqjy/lfJjf8HeM6ve2dTN7Sxuun+1NFDM7+qFEv4dX6VWjLWLyzxkio5KJZaNEhLrYt8/evtAfmfDqRn1EZLagP8vTzRJG1rk4pJ/ryVTzouZkCOciRCt/D7jOjLB+qXHEWwvpWvHMXMx4a1anGi1Tk0nhNST4pIdaSdR/5WePLV2TUyS1aEhz5dNMoWbNeHaHK/lq8fxlRnOiqmpuN1Uuz914llCnUI0JQdQH5VfokgVM18TQfVRNKloIP2qtV43+u38ksDh2Zf8LQ2PFl/Pt9Xtrcenyemyk46yvp8j8V7rHT6enXNd0yZBfDp3JKyoyfnoX8Y9PWT0nqc1k1hrOzj5ocLWPEHyEUE0ZOpJkpS6/tumY8liHLXxxPNOQqXiaqwdc61WzfiQCGipUZKfV/4xjy+n9mxxnLKv1XqLjHWSBmMq4jZSXtceqx2Ts1siqiaz61VQ6SAIJqps+DKZV4dyFjVdMsyBZmL2Pa9lbW9y5bja4xkpwhXicZWRZyGrpxk0X1WTrVDMzve6ebPfXimpyMzWTTHxZLAomupnmTbuVBosP7KbnaNk4ijWNvndzX9/k5bauTQOTTtdMpNP5XcYPi8T1vL9iK1K71vmAqaHiOAKqldUn5wFn5j9Q8jtg/SOLIGP8AJOTwyOWRf20vJHTqEhJBaqdZGFA1TW2/9aZLncfVN/lTJfPWqh1j/wAgg6Q3dEburvyFVKearo1tLcl2VNymU6lp+jcTBLjtyatl6qRJGj6JNjTSyhhxqzU/NW54H5Y6lr+2pmSZN45CtFTcnOiUKTuEsDswe7gHGpqi42pI9iIxyH5EHXmDjvXKychSCDkxhJ4qjq+taK1LUnkUKIYx3qXfjSV55CeJmN2tb+vPWMNgzoZ6GZMvMkAFf+vYa3bo+1W+TTpqfNf1UCb/ADHIxc4tHXPHya89Vycvab+2xoDonk/qr+ghMh29L+iG7Y2tsdZ/fY4t9e/vpMbJXISDOuHdMiRqtVzT0ynT0gPJvwmFoMWZNX/3mX49kpM2bCznl6+vn5PJW3HJ58T41IJJJWQ1wrSrXj9mlqeR2IrumTrE1V9S2eNS1p/rKGzShXJAvioeZZ5cAOWYS2BT2I+2mbHxtn9MwVtpz8WPU/2qmck2EIdz4m3zrH145471vel5FfeX6/5JKCXXXJUzU85NzP1R8a5EH9t/ieYtp6S5pybu5lQQuCjfTt8Amvtv7aptRJW3Wp38gNjNcmOuJmj7Sf8AU52mg1r7J+o//o47nad8Kz0N/wA/ltJmYKpVuqGilrc9cqVogJl678rvfO4CV9wMBP21MV1OibgTZdPVXVDOtP3deNhtd5ObupuadcBxvVahaid6nH0LT+lEdgCBzeM2spzX353v69Yq35J1rUmv7J4bH8ewGA4ON4YNuQZtGn/O33F9xPGmpNKNEDLJkMYDOnHMqztKV88rU6Ndcoq5pJnHF6CMd107rwInReydfbJWuf3oRfw6tH6/2nUG5tr/AHrL0uzWtFv+j+v6Pw8cOlLmuurKpFB0pSjpfsEcDtda2/jeOJfhyLQf3jRcgdue6zGUhtjQxjxz9ON3W92yTMVfM+Xf/qK8T43VD50bXMDHUi8jjsXbaTX2/q+D68sEyBzYp1+Kq+LhlDmZiniwWr/ev91qXeTyw+dOq05mvihMm+ebZp8/F43NToVJJed8jTW3/QCPmQ9t4fO4BXjS3zZDY5z/AAaWbiYxuecisoCNEs70W655DwMjttNtH5BzjsvHi8qFM01J2ic6s0nmuvJP152CMiVlmDdTOPK6lY7+wckVp0aJaXzoFIgTMcjNSDTFslXrpknxXxpRkDQSBJtZNElICMXGSZw1f6R9Dp02V/Z4yjLZNhosjBRimVqdVdLrZAUw2bHppCY871JuvP4nIf1f/H0Tknx92Todzz5WB2FcxWgmp3IBQ3gOagduuua6L1Jq7WN/qnXh0CjU0Nij6lXUP+L+2tw7JBjdD3ug27Kr980mrpDfHCQQ2vuYOz04Ps8QUBcnP0hZAU1OTHUijGmZrkfkih0mlR3zpd063rw/jJ6snqJnXN83l8WyyBxkPPdbZRPHGNdi/inXD1uTomScfjJZ4pqZ3dSn/wACUTzUjzyBW9uqJnUMla+xrzVbq5g3M9eLDxUrPVJ+kj7DM27Hftg6LfnsbWjMk4S03LbmqLJkMVRDOrQ1sp429YtrpeOZTc/t/MHFR92tyfFzc41+qfbEKX4pIFZU3NCLVEYwhTJIIX8baPHnrGrKiTqSBIk3586/FVWO4mx/TCy+Ho0PWt07KHbp5AfGtBLbKn6eCxg9tBKdlstwPKiFZCBpeNC1Zos+g8q7ZxzMDl/t+kmgKH/4Q3YmrIK8TdhxXOuYAPKzqcfZ5rl6/wBk62RUmWFi8cJ/7C9FVw7yJ3NUvkia6265rmajknLj4hxpduMliBt/qc38la2ANOkZJ1t1OwMQfwkBFsSvcjG4vMFNQtiRBGL+JT7W0E1k9NE4/FNVCZK6AqudTeRY+ol8jL4GkJqtOrLmxxK4tnGOEOokVOVJoeQ8qks63RpZ/Bc3eLCqY2mIp4ButiWq0g0+WpKd0Scm7LKmODIgVyY0ZXd+PvtT/Yu6R8NEv+tAkZikDYKAckyt8lidMWMQF5fp9hHiL30IZsmzLl5IxP8Av496QA0F8unabL/Q9UqPxY5SZqd5T5jzNaOXqJoTxXJMGtv2ko8Mqx1eQokqaKa8uldm4hd7mq/rEbOfqAkrOOtZN9C1hoet1wjr/G6idTpP2PJZ+zX4vUMg3Ek9v5eGd9HHZE9hv9pTIzFgMmWpKhmCjD/o+7GOPkydNtBrW6DwT0LH5N+nx/LjjvVTA0kkxcy6hqp7WsimtGr1rw81+MxzeTdY2ZyEO2p1dLytc32tfp2otfSvP+T8muvT4buhu7Ymdy1e/Gmq+u4gm91ryy1rQBogAWCrknuIAKLYAIPvpi1sq09vfeOQVobxNgLDzy81kcY4wfsfJtTxPIuv3Naa05jeXSSK2c1iqYaCdZFvZt5a70upqKmaJ2WTIvM72nEPJ9afrpuxdj5nvwIO55nw0fj1lo6yVMio1VJQlmUrfBTratJPNNbCaHpbgYP6BTa229tN2tfCb+WAXY82ERGl4o5+r9y04o3NLcgFWaZ0ic+EP6SVrdjHNS5eo8HWqacf7mP8fVC14JSYmR0GxA/BqMFb6pnxGX5N46dJtjS/p3siBrRWvseDxU/EDkOod9U6z6iPMu+tbN8b1VeSUTf5dIA2IAPtAkLn/Ir6NghNq2NvT+RN/VaNRkLUvY3rEtfSpIVNTaHT9p6jW158TR9W43cuinmGHzt/Zqsc3tfL/bw73FB/b8QYsbhm23fTZ9qL0Tv4tcNROuFP0VvyySjHqMePnwVwbPK4q5OryFf2SWf39R6Sjx+aA+kggIFEsxkgkeQhP2GqET6YNwH9sBKC53K1GRuv8M/Sqnbe9GRPIg7pq8ihfjemJ/e6yPmxxMVjnJonXVZNQUE6uqob3RbFI+dOhPLJqSayWk9bme9OQrc1qRZOarx42O9To0fiXJ34ofqeVNFa/tNNDVb8z0G02JBM1+M3BsUv/jAEM3n1BLIjRl9x+c+311OEup7Yrucn2fp3TjJ6HvyzNAQgCpFE1q/yQh+TttJbopBPpzrFvIiyohyBR9SZrlAq3JvjBYdz3uqSvG65kkcZJ+2tBJq/BsOJ7y2u5qC6FEmqJ58tK5K2UnP1vlnwwP4A/wCIIlX49M2Eys3PLYSDiwvIMDac4PaNYmLqcpbF/bIx1DFY9lfE8sNfafBT+pr7aNM5JKtayh1/l8rIT14xi7trXOjqpWqOtpzN7xss6roJywRopdrdKyIzNGoZpp5mfGvyKx1U4bt6rUM6Z+NxMqYug3+wX+wrMI2CUCAUnb6gd32ke2p9XYRMiEnmTwrHg6sT/psgK3A88q1yqlu/s9BxulOeSvClT+ziLp4lcjegNc0yGuTVPy1zX1GhRLmcdZJ7yOuncNVRZ4lDqv2OmdzpuhNH7Ihm7h+rMw0uhMnJKTu3VCn+g650PcbouoIeDbfslcoyAeSg6jS8rssIIjgxdE5JW6xnP/WmHapzVEh9/EkiIaE5RhHqSZyq1qRqIClSbaGXqe9lPSHSAM6fOn8zJjy1rSUGnxNMxFc9JWr5YfLo8rr9r+RcMRD8h089/b/246hL6o1dVQEv6lNH+vK4EqBDdhz4PYBaoh4E3hHB8e1kgxoPhjJnx/711bVXEjP1pw3rf22tMiOjWtmMCr47p3XOmiPBq5o3M11ukbdGjXjl5ySIsnCzkNXFdoJxI7GSZ/eTVK7hOqJ5aHHI5PVzNx0/HJPKnympaVQuvHhlfGhnIa8/kiPuIuYv2DGRsnp8W+8Ef6I50/HLGKBetk6s+6zYTU1kdMya5EkJ/wBCpNBkvW9yklEbmaTeiPs0bZ1s652v/wCIfwNarHvJTrd1PmYJ0U4SeQWma2b/AF15J5Rq5LppxSFb1PNVs4mvlhGvBO5ip6qSg8ktflephMwPaB4aMTKSZOp9QQFzZXdsW+pe+xz/APdTMhjZ34mbJTVTNeHyLsqVdzraUrpxWAzV3OsjXPB9XaZG/PVLpQH680bJ0Rqp7xaoYRKyVNqBVXx9qmua5mnY1X/1HkIupJr4tVYeTVPy+DnInAeJ3zRVz+9MuvwC2TO0MkWhM4uYInUmoZ42WO6YaksbvSrHK7DpGX9+bj6r1pq+p3A7/qEFAu/xsBkP7E3LIdOm4jwcljNU1oa8KdOgPuq8UO92T5nNtoHS01jdGnYHEOTxM6DWTZHi5XfNzk/fVY2iOZpN7rumQTY0DFSaKpMPu8uysVG3va+izggOWrFXgOIUyzBvlcY8pk6uryDOvkCDIozLUZCKk1yTzFVUr/W5hXzjitzj83LfVVrm6Z0UhzUyhqKnY6RAnTbib1Brzx945J5lnmSrE7vrSzrp1O+k/BMZjVxeZqausfiyZfIzwkiPLHcmqVVmjTiyHY4MMhgFgkZIYJIRWqVj9DO2+bZuLHQ465+TVdc9b1PNkIb83IY5h+r4PLRpPITEtmRv7uL/AH5j614xycElhoTVqdhrf5FfJjxy46kq0npCY5yf/ZsvNaK8aSv146lnmWZuY00T1rj/AOZaQZymT5Enqu92ozz3y6OZ9UIkQLWA3k3O3cWjSx2vZXySbhLhi99SnxyLzctSzUnVyUBO8pxMs80OwCaLkdO8r4T7X3JVfI3UfJpXRiyUEuqrrRDZXkPGmJnI5OiZ+0z8eQpEK2O+NhUyi72UOo3vqgMLkyYzdb+OgUJ+YIg8fbpMe9EU7V/cnVLLdYF3T6hsLXdl9LYel6n+kGEC5yJ751mXKuMy6Emo2MtN6/beqXqOpFdVJ9nZ+2Tmx2UORJLogZ4qbrkGrpSY8POr5l+2M87/ADMmKPPx61knq8Yz9Zp1UceQ0nWtVrbJTt5TiljE84ycjfxU8/3rcHVQ1PJPGpK89AeFxrM8ClDdMAG83NuXdoySTZgY5P1XAxjcvyXay6AjJjxr9SbdOqq68Vuv1+iw26XxBdoaicSf3oP7ss08iW/Ya+/126nU/wCxmSul3jJpuqq/tZLP13yPJtBOdycmmevxkZ5x5NGt+KnJO8hDbJGOroNDQ70bHwf7PxuQyn+xAF7+wTZRJ0HH4V2kSVe8mJFgiFrK5uFmoOCclDLBUmup1W2+utWzQDNHdSFfghN+Zya54rU38bQcfQh09Msi0eftMn6Q/vEfWjd6syfHW9I77o0ERzInGz9ad6E3LOE+s5XcpUnmpomluzXXx6elnSeGevAvURPDK2iLFwfujjTIRHZ/QEfwvJBjVq5xOLxDTr5Bgh2dTc4slqqgOtPmSR0byfiiMd5TJOX434O7xlkz9aCSYikeRJYp3J4nJq5qZiWf6ZChTIi9nn9whzIhQk8hG7ZWKp/J0HqNqHjuaRxyU1zx52MV5JjW3bI+Z1nUYHJuxHfcmDyYvGpfgDOZUKeCTlWk6sY8eIurdW/HWSL/AKzTVfTHRXb9UUmT+ynVVzTYxLfTMVuMbj6UMizMtLV7pE2Sn/bUun9oxzRubyTQxTP2a56mEmcgMR+q5jld6RmqdMyZK5lIFSI3M0NY025Krvo3ylNT9Z7qp87MK6lTMhbibSRg4P0h6HFphTexEO6W/vq1ZOQw+SaxcLWmGtUFaUW7AgSVHyX06RlTkq5y46K/U1LLzUyamg/7GoJGmqx1VP2lZ/E4nrxkOGbmHUszVHMg73Vtbt2SKfWjY7vRBkmmRi4xs/HS7rQbJa86/Yy8KHDrSvH1TTMSiXP6Q5OTtoi+8C/jmbx977z+P5fV+l9R6jN6Oqw+ow+1e5ZMWWsZTFX6ZxXU8G8WaXLUYs9PWLLQxU1wmrj2/wBbE+k9Z6p9ZfovV58uL0k5MmGvT16/0+LC5lx461dY/lky1vZVPkpJnZel9wy+2+y+6ZPTzjPU+s9b7b6C/UyWZ/R+jic3q/VRhy1DiX1VYfT4qnIPWPHfUSY6lpZf/pn6n1OG/dLZn03pX1Ht/pZyY3Hhw+4bz16gxcwTee5otlKyy4vHUmvLM9WpCkhgFskimmwYAYJhWW2tAPlDJvYeIaAACysODp+u3VaxvVZGjUNEeHy9VVUpI/Xc/V+3lF9PqqrFtl1ldanmH7fHtbxPKSAbkdU1rZ+TjS/BNG8hHnT/APAzk6Wk2sut7nUoszVWTuaSfs0UyVtZmqJ5KoDnX9Jk5TzJyVqyUJMsKSBEIWuyY3OgBXQ5YbC/Vxd9lsPR+34PXe0fyH1OX1EYP/pX6P273HBeTJevUepPccPpD0OH02KanLmrD6zNljDdFGPBVBcR5b/IPSnpPX+hqfU167B6n+P+yeo9Fluz5MHp59LON9Ll+NyTg+D1WL1H+LpyAY8l1uqJj0vpfn9o/kGRrNWP0U+zevzxNOPEMe4z6WJy5MYwZLr1k1EUyeMl9T8VT+D/ACH2v0/s3vfqvbvTZjIeh9F7Tjy5flnMOfL7f6b1fqcEXjPguJ9RnyTFYrTJE1vh2T5xIPxFQNa+ar5ElSKKGfUNjvd8HTrKpEMQWN794GTeHrUf4vksRSsZutixVVve9E8i7mZ8rP60fgNPL1O+K+Jrc6uQ0VkWrTyVdXs1sNDPki+rvYmjIlujc6HbVy7F0Y0534j6nn8Kvkg/01mmfkvGdEuV1IssCBP1jnrtPH3mvzpBT+VCJEibyCJHGd9ZBQlvgA44lO4vA0305i/8z0VZs1Y8X/l+kvLmx5Pjv0eNz4/mvFlJnm4xzST3CvTvT46v+c+x+8el9d/JPdPcc+XNPtn819V7D6bJly16nHk9P6n/AMv3HE+mvDj+D1Ppqxf+P6oy4qn0+Q9bCYKnJizPGW/VnXIcltKGRxbXU0KtbUoB/sHCeO49f/H/AHn1f/3m+iv12b1uH+UfxZ999tyesn1OXDhzenz+64fUar4ZWvTPtGTBVf5iMKaywFYsXP16hT1ul1DXSEwWCTCMHs/49aJ03IUzzDId+0DmNeZ52rqbZ6qamLl2zU/WqXHdq1VeOjQL5mnbQuESmVrFVU/9ZoajfNcy86GC5apnRpJnwxxTWKM/dBzGbnKtUut2sJ2NUTH2tf114opr21yvesebPvHP3ZmOd+YknlooNU1PKhXgD0elUUicArP+J7DiOw1Avvm/YsJWvYjydIrH/g/d4qm/mL+TanMhBNyFRfj498zWuMjFcUxDiiZ/70n3rQ83kmYLqxIkPt1O25ejdbGTl+uo3FFTh1VRG3Y02U9aaJxu9S8mPJPURX4CZIjsZuqqbViqZKTY3JIRNTyIeKSuWHIfnVRWYJW26gDKkwkOHqCc7WZyQFdC8wPoQdTziql3VV5F2cZKxvQ1dE09hu9BvnVcOknziGdyXdSSo0xNcspYgzCJOn/4ZBZPwsNQjkxzs047iiJumju+p5vdfo3sP9oRLo+MmU23OppRp+8+nk/qFCoz4ng+7yLOyp1NXygmrEAQVBlFj7AGNtOAgQEg/pte7Y3ugdOxQV18lZJClbcQmW9zJFea3Lt8wTKfQIvzN/GdSkskxPGtRP8AlkIlrGDU0bJAOtvDM9TX5VFjDhYsPEE1q2pmjrq7/tFTytOj9w6rhr8d6aMdZMk5o5purnIosOOY6DWiIaoWnyEmlrVfnJ1CESC3TvkkZv8A/Ex3OqDkkBFC24EDYPHeJ1t/RF20ZY1RqqUOKmJBmi3dlFOnR8hPFE2fnSemyV4piwNY6SXo3vWTTRoDcltFTzpjwrocOqa6i/ruIY3u8nUhNL996Qm4CvqfVoSug9B91u4CYnl7qqbySIWzTAk9LN68PG91sryeuflJIvIwrbj75l62pHpTpXF4KiAPxQYO3Y9V6Q0z1ExJj+O8rH9r3L1pre6tEyIadjDzp+pP4l6f0Xs3/BfqMn8i909T6fD/AMi/8m+x+p/jPtntXosHq/ccuP8A439v9f6D+We5+s9T6qsc+i9L63/7+vRe2e0+ow5s7fr/AEHu3/l48GP2+X1Py/6VxydXeOZcTkmakPj+x0TzWypdsy71kLr5OdV+fanuXt/8R9B7P/8AQ6fw3/k/3b3X03t/8E/jvuv/ACD/ADj+Pfx7230eb1//ANIP5f7/AOq/5D9i9ux+q9fn9N6c98959hz+x5fcMdYfU5fbMPvXocR6b1OX0vqfTYfh/wCu1gj4fofMRX1v7ldNAfU9PRp9bpABQPUFAb/yAhjXp/CD5epWIPpHpLQJqqpC7XUgi/GvB/5t7/6P+VfyI9w9q9Fm9s9h9s9k9p/jn8f9uzhHqfRex/xz0eH0Ho/Se4fDhx433PMxm9T7mYYwTXrfUeq9RHpvTOWsE8+bJmqqM08zomW3F1vi3KX8k3EyTVO0lMgbrar1vu1e7eq9Z7oYp9Bj9z969x9x/wDGjFcYvTR6/Pk9WennFjiDHhx48pjY+8xpmKQSZHmjILWO6K1NaZxXuqmzn4zgxuoTk23PUNAuj0/7XRoppBAFICKbK/FFww4X00jX81RUmOGQFBcBmELRbW5x5bsjHfONx2PKSRkDZVV0Lkcu0kricknNcqV+dp/Avc/ePQf8jfwX1X8f9Ie5e+R/LvYMPtft5kv0h7j67P7l6X0eL0V3LLz6+Mz6PNfUzJfPPMsXw5RJ/wCuegMcodG9/TLeVybLGa3XimWVJje+4/49/kdfwr+f/wAG/mWT0WX3H/71P5P/AB33+/bcM1GX18e2e54PVZPR4ss1Q+o9bix3j9NSjWW5qrbjn85fjBV/7fq/J6vkrApIgseInIWMaukj1Al02RFgYatMWIc62/qPdf4h7P7T/K/4R/Ga9b7hGT/kH0fuse9ZsGP0ftOH2j2H03vvtntWKfQ3eW8fqvXvuWf1D6y/UfH6jDhxTj9PiyRkDjq4u5ZpjFv5GLyaLoaMmOZ5oldpE9bZAjITpOz9yn2D+L4f+S/4R6Az+t9bn/lXs/pT3LJj+D0ns/p/417r7xkzRUesx5PUY/c/dM+fD6LJfp8hhD0vuPpSJiop4m8nx9SZZWsXyS2f6sP/AFuwL0BJi+ttXRMTVSc/wtI/tkqoE+kiqov1erp0ElGRMAcO2p6hNKhDCB3aP7E+EX9J+0/zTN/Cv+B/4z/J/Yvapze5e1f8w/yb0PuOTFjj1HpPV/8An/xr+G+u9jwe8ZPV+n9Rixepn0XoPfcHtE+mMfqceQ9R6nP/AORjwYiPAP5x7Pj/AIv776v2fF6o9X7dXp/R+/ez+vx+qPWnuPsHv3ovR+8ez5s+XGY5yeov0XqceH3H4MJ8Pr8Hq8STkwZCez/hNe9e/f8AHH/M3tHftvqv47/H/b/4h/OM3pvX4fV36+Pf/SfyCP4n7J632XD6SDO5fh/lfr8nvGPGBk9s9O5M9/H6ZXzf+Zen929n9x9n/ivuP8g9q/k3o/4x/FfZ8Psnvns0j6H1ftHveO/5Vir0Xqc/pfSZPURi9X7/AOt9JTmxOX0XqY9T6TKc4aMnH8FTT0/i+vRTUPUOt1fXCqqorpo6okR8p6iUFfMLa6eofV06SS/lpEIqw3sVcNca5uvXz6jTi2Y4Iw1yVDFslt8FphCXhy7QNzM3Ey1UrDiMwTlrF3fzXNVh5SMjvA6aLp5bxqdbGJySZIRuKOduFXb/AFmsYQ5N0zERWmjUzjhUi08kXAzUy5PhzFwZMzUZJP8AsBKZuvozY0VkhHmEiRnz7OQBKAn2t3F5sY2PDVWbE3W2CInYMdvbUJguYlwZcb0O0upcm+qEyzLEL5+Q1TWMm5lxzWRU58vo/UYfWY5i8novU+mzY8eWW8WSvR25sfy48kvyRTJjV4Km+KJ3X5ey7EbJTmprlvITVdBkrKpqoJ1VaLjHqkR8e3f8GfwU/lPvXvP8l9R6GfXe3fwb0PtWfB6LNjyX6f3z+efyP3X0/wDHP+Pv476kxuSc8er/AJB6s959y9LZ/wDXXsHsHveJJjuvzD4r4np/CfDdXr9SaKB+Fj5qqkAEf+RKDMttaXTp9dQAEkINH/yIQQjuuGNU/wDkX0Wf2n/jP3z/AJX/AJtn9R63+dfz33Sv43/H8fuuHKvoc/q8U+s/lHufpqc9/Hfsvt+X0vtUGqv0XrPcPVxk+G/S4pj6k/4G/jHpsf8AxJ/x37Fhyx6fL7j6T0Xudeo9aYZ9Pv3n1XrPcPV1ONmTIThxY+rujXp8WXB3eOnE/LH/APMC9+w4P+Tv43/xJ7Xnz+p9m/4p/jHpPacl1lc563+Re6Vi9y/kPuquPEV6j3L1ufHl9XW8eT5Zy1czW2fqj13/ACP7N/xZ/wAT/wAY/kXvGKvUZfav4/8Axz+Ofxv2P0eFw5fc/fPcP4/nx4303q82O/j9P6Wc3/keoyYviyYzD16Wo9TWK3wP6kfifif6V/Sh06COp8f8V/do6dAQHSCp6NAUAegiupsCpknJ9HpV9MdbrElf2elTQf8AyY9Rsm48ba+HP59/PP5F6v3/AP5R9d7R6bH7X/Ev+aP5zk/i1/yP1Rgxe7Vh9H776LLk9P7X6nPh9N/4fsnqvS16fF649NM+nzHoK9DG82C4n6e/53/i/or/AOKsXsfsmDLPof4f/wCBi9t9PODDkjN7b6P00ekPU3XpzWS8hgyZs+YZjuM1n+bLlH4h9+/nfvP8hze2/wDHXpfY8XtH8R/ivpJ969t9bkjJ6v3P3KcGf3L3TD7lXrvUxlMXp/Xe4+9ervNh9Hjx+2+ozem9N6ix9ZjcuT6Q/wCKf+VMP8r/AI/n/jv8m9Qer/kXo/b79BV3/ifVe2+nkYzTkt+PPleTDlx5JYypGXrtrJfvfFfCfF/DdP8Ap/xHSoQ+Erpq6lFJFXr6YFFHTrPpYJFFEB/K8PXH0axUesDUT62ASEHmkebRr5p/4cymP+W+l9FeC8nqvU+r9CekuaMGOfUen9x9Pfp9ZMqTjLZvFdRy7JjZRxWo/wCYfbc/vPv3uHqvQ+25/aP49/Hfbsp6eM3r/lL90PeM3pfe/cZxZG6vJ7t74es9UAYH/wAXmIx1j9P49T/mH8Fye0/zD2z3P+OfL/8AS33P3T2yPSVOScNe3+u9V6/0tT6d9RiPixzVWePkeehDuGfzyb/kD3H33+SfyP8Anvo8OH/6X/xT2n+V3mv08/BjjCR7r6n2qMt+ocW/W+ozVTeeKsMU7Xe7n8+p6J6fxXxXQ+LoIFNXRAqJK9BBASC+b5iBfGdY9WldP+2Tb1GkJNMyRFwbmb4Wt5/Fn2f3T2j0PqMe/S+6egx+nx/eZyuZqinNq5rPTX+OAmNVqpypxGV8T/nPpp9H/J/cYkWK9YspdIVdzRRegZ83zXIS/IBLj5yeieg9u9Z7H7jBkucpjyTURjy1E5Jy3+8SRji8VxHlLoaF0SmtL/LfSz7v7lfqWpc9Zsf2YJNz3NQtFfJkn6VQ/bLvyzSP530U1UdYmmp0lyS0GSvqkC4vrmqdXTASIIE/ZmJBicPbXd/xD1/uB/Ev5T7P6zBl919g9T/F/Ue/e5+gx5LnFj9V/G5PVez+7nx46OfQ5vU5cefsbv0uTMFT03+cyVj/AJj7x/H/AHP0fpp9Lh/kf8S9T/HT2vHimcHt/r/4p6evT1Pp8J6kcUZMOL0Xrfku4q8vrMs48fxOGfzp/wDjj1HqPRe4YfQz6bH6vH7p6X3L+LerwZQnBnw+/eh9T7bPzY8hxk+L1PqMPqDNxVY82LBTiyXEzfJe1ew+r/jXs38Y/wCQis+bN6L+ae6fx/3r2XLRhv2nN6T0/tuXA18THHqfcsZ67D6qPUEepqTHGT0mbFmuo4up6aPiuonTX1PSabn/AKlVFQkCxPoEjZc6ouqmhEgASDhVA90iiOTrnf5B6Go/4n9tu70+i/nnu3pObjJN46y+2Yc/x2TqZJoCwk1fyMHIV+ece1bpmrmksMW2G6lPJb91mjp2GmB6naVr17+Ze9+3+u/hL/GvR+mzYPWv839f/J8k1ggx4vRep9DHo8GCP8UZPkjJjuHChDqMfc2xL5H7Xfw+oMeXlr7SSmtmyIqFcczcu9J5CdydvL6Hwv8Ac9NR6lCqq6hqUAo+mb2nFiba5uqP+oKSAgKU4sB7r3awFrZ+45B9NdVLjmJJpTi/UeoHdANttbpbYWn6xRPmvzkfTYz13um8h8eLB16jLNdVMenwOTWN8u5Xkn/qLzuqNu6989XOfmCZkm9mPCVE3UdS3xI23QbhokMfRezqvyPVejv2H2Yx+oXH7n7vJm+OijNh9FxVYIp4PtnvdWVNbgKn7Ty9ZqDGH5xBC7zizU6kn1G3yibKw8wja++uT9Tin1nqvX54h+My5DhGxgJBNNcvA11VnHid07YGPbozenctwl4v0yHkk3YoX4Hf2UlkoftMs7z2L09vpfXVrq8l1FWm+KoGVyLAykqT520dT9ndv2bE0+q9OSVTj9QS6cZomf3tSrTZEkbZKkAmllM4DO0PN8r8sagU+qfUA3e/hfbadc3m9DinDGXG3JJPU9tkhLXyUxWhlSqa1okrbOmdZfgrUJE+HZ18l40Kedvk3qh8smlDX51Hoj5PSeo1Ks47WmhmamZPvvfNIrPM65ROQVq+ynt3q/UZfS+t2fJjr480gVGaGVrzrremRCr2VvVxPRV6UOQO+BJ90lxqCAfSBkQ7BFYWbQIyjrRXkySxkkQ0BRPL+5Rp2VLJ+nXUzRTNa2WvQek9w939dh9D6PvJ6jPlgiCnqP8AdOSv6Tjk5vJfgkd9n7O5x/xT235pv1PuIekbci4cc3mMM1PVEjGLHnnwzNFaLKxaViNj6z3T2b2HGel/i/pc2BYoz+552c3uGbJcOOsVUFRgwnJTgjnUvVTeiTE1GKaaTV6rmaaQApJvbZnGj0nMCLGcSThjczhLU4M8e3+uwexxkyZLxYD0+bN0ZQzrxlfN83FchBkk2smidd7XLG9akgAzE3csZyLZ3MV2M3SajoipCaDQvnXpRj1UerzbarVM3eq5rLLQJJtboqXS77p3uCeg9F/J8fqfU+o9J6jHfos8NxF5HJWOpWQOlHE5NtV080UHXRP5l1enY0iwZVylPgQrTvq6aw5QR+UEdoup/wBpLW+yT8vO/jNc5A+kF4wk3W27MmQo8Jvkkr7SJQyTFVZ046reRrcczNRR8RU/pHzGpGTf9XyWbyc7rHblhZrrzfEOqnnJNsjJIkmzVTlJqaYmnmd9a7vHnF2c1kgud3ibdz1LPiAoWiprjeuZbfRBEJD2vcfTTFUgWJsQHdISD3COV28wjRZBUg49y1EndKhrtd00E+Ce/OJetH5OXwTfH/1E5KJkqhaWktTY7O3fW9ul0s+KMuW6UbmDSrjEnRybFQDSidc0UdSJV9QsY123JqRKrqY8PO39M8O/AG/L4efvvwgg4z7HwNz22Ws3Bj8l5nyvfWZrxUR3vkSdzjSjQ67XR+tlACcf/VSKZik84qkx0zWjdESg15J4mZA+rHjcprrf4pK+PGuOFeTbBz9tMZavpCv7NGt6JrW96IljJSDzxVq3IM2GoOfHh8xIb1ryNJ+N7iInYR+u7HOgF/STn8/z0dY8WMCST7iM1qfvolq5QJ3H64dzoDc/kzjkKOgdfJ5daHf0+R0p4nUx/Y7/APtErMh43TP1LKp3N0IzNNzorZU/UNT9JZd1+YPcFarrqHa/3kiSYpPtprUGpB3M0NHX4fL+IBR+m2BmBfT9v4LLxt30wMVXkyZHvro6eVxixqiXlrbsF8/rX2T8CjFRvqY4ZAdY+uK19hOjezXjzrigrmiAyCtCT8nOPeim1kmeqIWHl5f/ALmhN7n8gmcpXeMnVnnYNUcj13u2UeQnla5NCCywXn3cpfeG7QZGl/P5H830cVceMeNqvk1Kl70ycC9TuNgqyD4Na2/mGOoqqybero31/T+t9SPJ+h1EfV3uNXVBMeKa8dfHkryl6ig0fuach4n/AHrZzrVbPI1ejJ06yhi2KSSedtf5I3PLd6+jv9T9vxiwkwRHHOL+d1gGLRjK9gL/AGsrLq/A6CYccZBh++r/AHflePFHexa6f11+Wbyy0TM1P+IIxu5rHWh2zN6mZ+SvKdR5+p/X8CCqo/xGxmRqNGSyjffW9r+y1VdxpvSrsr5qvsrwT/V8JRyxvay705Gtv262daAwAske0P62w7t6LW7d9xz2nQVfyM0x4KjGEiTWvtfR02V+vOtBK3JKo45ubir4Y1U7XmmSTSKXTTUvJzNcsul2wHNSnNlzqtycl3T0vNAVR1UC9edIzbsZtqE53XzfZJ05NgU1ruuP2KeK3y/c6aph5afgDa5Hmw0wV28ce6lTkuCtN3S7OT62nXlrmhK3koRNyYp00vjZXX4OXX+Iihs1utSFDHiMlC/e6mgxjJU8kgzN/gV3VTfM5MbUA4687CeYzTqraoUtUPE0757/AA+OknWn/wBvm0+p4cIsj4DkkHS2aXX5YP5dvt9VvzpseIxyMAbA+CeWUVREGTmrGHs/vjXmJVq5pISon/6t1P8Afz+BMxeQ/wApS13NSzpluUhZjtuqN6ieaNwMPiSyziZ/RZpqUrYTJ9ZV6d+f6iKT19UFDGU31rWPhmY01roEuQVmeuAVHe0nppZMEAqCJi0XIAEcm8nBCn9fpfzvnR3V1FfYlkPHmKpjqbdLW6pYNeCjZRJ9aDWEvz96yz4uRkisjGoPPDj6fLJT4/U+AdmtmJf67McjE/tpGbuwokqVFndsnX6KBRFVkqn+vxt1xrmZ6FiV+o9Jz9aJ6dp4/AiUJyTKFjvg+UhadSme2Af9PBQm19TmbjEcTO+ZnJUTX1inVXT2HXJpdJ9jf1an8WQYpi56qaiJ5PqxXm3pxqbPNU7fCVKY9n4XxXQd5ytSUdVDJjOd4uqkenl3+/8AtvT4M+RcnAhBAa1qKqYZImWrK+xslN+Kiag80gQmWCUBmIZAIl8nQFvfvAiQP5zM6eEZSMk/4ckxB5cfmIN1OkVKKjnauzShp/IyXZ5du1hWKXweK5afOp3SsoUqIbYxU3jjQyzWIACXJS/2RpTnclbPLov6a2/T8tb5q6xlUcn06/sQFTK70w72FU9I6d6QKgxDu4BMXnmFbcLVgRsIHGPymPpGqpjox46uf75NVqiVWZN5t6qVnxWmdSz4B3+RF3dsyyGPFxVOjqZ0Ez1Ku3ZPjbqv9SV+N/8AbqMpWKiokmVjHldEzsKUbmxK4ZqZ86Xf4dtYYk4n5GwH4625DnVUvK8gnZJ1/VkBPyTTIn5ReJYQ/naxctIAmEZjt9Z+m70/0+XE1WKj601rieJFmeouml+Pe3c7CpTlY1R3eNhp6dhirrb/ANQx1updG2wf/Z5TQE7qRbiydb+1cnQFM1SW1LBojY+VTX21clDadUVzoBbpeF7mTZ42aVAl+upOUlN60H1UEZtgoFbkkWK2JszqXA+gCd75WFjJ1Xq+NnxFvRjPq+K8M5qyUzCbKZtXek4SKr8n4ix3QZYS6WwbC0vHIxJYVrn4wXzpVKDMPKk5v7y5NOn6anUxVHihln6ST5a0NP5G/pNeST4w01B8izUuQumv96ut7WfsKO0j8zB7Ps0hKRDYGHfQBUWN0dmPquLfXT8YEU8JIs/9rYx1M/bjmWJDRs0SbXW/DcaVDUHiYZqNTjyVkJPslin1pGh6bQefxcERN131dwo6cjxRHEnR5IDdrK68j0zH4F7iMfOQ8TKzLMzWLX/avq1YTM2Oy9oiNa6KRSBdjIJnCB4QIPhnTAGy8p2Q3/gJjT2/qhURVxr+upIIFdss/JWtcBuko2dJ+AYpkOZNczknmoZcZpqKWRqmitFSLNJr67ERlfktjVEnww8f+lXuskRs1ut6KqnyQASdu3UYiqubbZcbr5GHZUzN/SQxENVMn1aaDb+AKkJeEBG7SVkBUPbWgIRaQiwY4bLHGXGitlddzD4vpCCyX/U3vp1U/wBSSn6aDiqLCVXSAqMS/HQZHp3TW9jQOrFpYZ5EnYZUrJEtnjmVDUbOdd3paaOuuf7Eb0aH8tQ6np4p5J5o3QzAmQW1rzzBVafB1+q3pSvUirofRpYITb0QCPEO9p4unVcxC0iciVkvEc98xVHyNlJLdH6ZL/T4qv39UATw9y0wO+w1RVVNKP7rkYKEnf7VknZUouporZYs7pk5Kpl/yVCH76KhFN9mp3+N13sY0faXmRKZ07aoaf3qKNFP1N6aVAMmyM4/C8YncwHjUkkgAWH4scuGAXETEuBocnxVE5bxuvkgftj6uz9z9v3id0mydAzsZ3+LXFYSrW6jn96xlixFtHPPSjJylFfqtIdNGCLmQ8zNUGtbZuLeqD9tqs/Z2E6mn8SU4tbgPkqbKsKYyVpN2XM8nNPIXqWaj9UU6ja1hySt87SWF30m1EgQLyDmysTE2Berrc48c4XVVsNg1knwBffgQSudCkoh+1XMxTX7NVRsqY0PBxW5lYF8aPL9TwD+KIyVTePJ0C1c14lidUzueo+2nXxs61VS6p/CzSVJzc471JPP+43px2HVL4kTxCDNJ9aAOSmBYPgQJOO2fVl2G2UWux4iEt5ZyWBmTrtvH5jIfZWkhrbROl+u4QXwUleQT8S5HkWK5K+Fjta6+t0/1rlneuqCtJ0anckUdDrf0YA+h4QmtLvVUaDXi4evrpBnbkabRyYmsjSTNXo3MEvFbea1MlDNyUOTSVE4/wAvxBiJfDwlIHaXJf3/AChQrTGmRjy8d1I1dmTo31DQoVf0ZJs+08dyO086/A7cVX8gjV1j6JcXLVGpKORh521Iv7XfLP46slzAk9RrHNmrgoaHfivr0TY5E+r/AFHdCNrlMUsmM+lSag8dSENUv2auvro6KmU+TVKCwT6h5cixFzY84zqCKreTIAAQ/P8AMjRY66o/rPEsPX1bQNv3l6uqo26OjooGZFPpYmTKTqobpO6O5xmn5J3z40aed+ds6p/HZOnEkHL8YrEmOaZH66Xr77md/wDbbK9IiMW6x4575sC5iqnlx8yk2tLdrJuE89f6E3Jiqmxutp7XhvKEW1FiEZHYgGPBttxInTMmSb51NFTcAfWZtnmaXG303zycv7je5/X4HUVXkrFDe6+u5rKIEBdVXx+PCSVpuf7TKTRBfXi8bzTGidVVBHO3etjpe9LzOwBXvJbzhxOz/FV5Kdm9PQ6fE6d3kP19anXmWSAGiePbb9dMbyezd/ybg2iCdMNvp+H9maE0V3Hg/t/T/GUSEkn6ok8coZLqMc3LGSkmUkdFcusjUvijy2u3c/IzUHgpqL0fYuiZp3WKKYQo201VNp4oLK3Jr/G/gd/Gvxgz2FbG4jwUHOpjeIFmg3Imh2gwbIkBXF/aPvECdXA3A4PeAYex4Hs3HjHGOidYun5GSvtraDKea511+pnzr8qYcVQs/PWSOmpKb3OF5/d7DQGq11EG707o/LPycHPkNcjOP9vjkofPNb01vVE1s1L+Lh3kr5J6panvWox9smumqkgb+rJ15lAAZipBF4cPgFpN7I+15MAXfHYWXAWecNjGCeqmALhoRlQo2Do5Pj10B5A6F26Cq+PnEeT/AAlVtRu+mVX6sg6650ckmvtuKvipxihUE3RSzqqnlLHlutVugdT4P+2mydTvUjEccsBtll/pXVPlFepp/rb9uvyboAWg8hBqyLOQGsTqSccG2ftO5QuuNKyYrlbxt3BaoqKJXUrOOarfkAeQf+0tai2THiyBXQwMbOJx6PrbOq8fH/s6ANzxoopvLulopjJwO66k2aV1IQeXWv2ojXZ+ZeNxk5cf7THN7epFfNLFbRIfqjUiJuDn8abXcsMAk0k3BBxDIxazyCXEg5+t0f5GmzqkLvk21JVFYnH0DHTqqX98jUumBitkpy/E6rh18hDZuBeq21K0g/8AyJYT+iRfzHqQ/WSavHRU19oXzI2SkkBRUcfR2y+PyTtT48fxkzrJVUf5LnhWS5Dz9vM7Vnk8yCiS0p+7QWaQNlAI2jTWXgLH0IjggoXtGjq66JOSscfR8E6lnmuk+y61JyfJzM7EOomPjFni/kop/VMOTnnrIEk8p9R2aepEa2rFvJPyFcPyb58zYcz1L0XXxL9Ty/8AY8SKWDmzXyJFLQuTXyQsjHLABL45T9eJZKlZGDa0RhG5gN8396jGA8ABSRYbA/K5NsaGlrK2TVfrDlF15qt0zy8hrxNb/wAd+As/DDnXUqtTGO949VPNBNKoU/umdTRRyDQi5iv25eR7qWCS2V1Mb5lPIIcamGTr7agvpihRKcrKbCpnrZJaczOOfOzlVVk8fiJQZPPEri+2LiXpElZSAMpufoxh7udWYkFz3RzCk46mkkEuifrM9JvhrSvatP1/FzRpyPNVntvoPvj7dzN3zzjmakbnhfKlICFM0Ei/KTYxRtqI/eOm+eTjnXNQ8di6f20iSqC6xI1sq53cjNVMwjCLIwp06Z2Om8qiYmkL5gBL/D/B+WkASEfzFyBusQSVyhEw/DBEk1dVDK9bmqnc6y0+ZKKSOX90B0/mTFN5Vxv97ilNMSogtJFhzQczJuiTVlfmY8Z8Z81FdaJK08f1iMaUdT27tmYaa8SjQflku9wRjJY5xTfKPY+ao6P2+PkoHrWxC9417/hBEDOEVvHCu500xc75mKbXn7HYafineKTGglDTVT8tfU3FTpTykTy67ojeuqG46zZLqQJiOmk3NZMkElIK1k6lCgI+updbPyuT5JGwd0PaARR1jq0N9bn6z9elne2QuFOEHf7nVBNTxTvTd72FBpvU97XWtjx9QhCk/VOVuMDkyNMGAcYaQRsrLKuJlnXSep9U+0+1+0+jxemxetv10ep929ZERPy/+LlzPt/o/S1l83gvFj9J6r1JbFsxmnLOSTJbOsfU+r9x9RfrfVTOHJl9N6bHjwll48PpPT4YxYvTy2/IjEs0dpTt8XV62mf3X03tfuGDH6f2l9w/+lnpPT+mrBnuMmB9Y+myVmzXWneA9X6kYx2ODL8VdkRPVa/HFfDjnJNFmQWtETuzpXjzQXvWvGjx9pX88oRUahSZqKrJsKzZSXtD51ZJYCO2wsJ3DAfAvxjiZJrGHcQLiMdzDJ9qi9HVLrwU7Q0mtIzJ9YlcVMVJNsXtPq0/bjqagHtWeY52/VZZdWE19K087mWIHr6U5StX/wBq6F2y0yjr8G11uCqaNJf25a+3SiQE26xuipWWS8Vv4VVsJoG7CurX4h97AmS0KSCMsZal2Rk+Epjb1fq7/inu/oYu8foD3j2j13uU4prupfS+4+m9Hhy+qhO/Rz6nKt4P05s2HIS5Yx3Kvc/b8ntHuvq/bMhPy+nPRVWZyHqMkY/V+3+nzayZlTJxOQn4w1FdHQ9NDGT12H2H3j/xMmSMHz+35Pc/jwpWX0pfqKxTbE5CceD1uTAxV4iHL8cQpSfjfdMfrsPvfuc+8Xde5V6jDm9V6nLxVZJ9Z6LDl9P3pLzc48kTU1MKk7kyFH5y0hdUk+ker1FbodLa0bEqIha0qLpEuaQUpEHm3sFAGNWDilw7m3KnbOm2Mhqcfyajb4/XK2vY7XS3Fjo3c1iYsO2uRTg1anVS01rJopnc77Oht3VZOeWZKnHNa+Nqzx8rNK8Ttl0xyGmZ4qRzWuYhDMY6m7rTvghdVVdXkt75pMZqa6egr839WOyBmxC/c5OkaWKSAkcoGVfki+GWoZW2VG6eJxMTeo7ouZfFzb/VNDX0qvLU/QfzqvQ++fyLD/E/dZ9Oten9o9w9r9u9J7hZfqL9m9J7/h949J7n7f6bIzWLF6P3SHLly4e8I0Xk5t/8inl0aTnnuyrk+M1G37G98q1MmM3XTVfsqyet/jnv3qfQen9/9lr03pvcvafevb8nrvX+k9VGQxR6n+Oxn9y9v9w9NOIXH6r0vqDPhvXc5PRep9ZgSYzXUcvxA9XTYppJpNJRNvmDNxYHe3fRSCKhESHj/FXMJjbBudcX7j6H1ntHrPV+1evxTh9Z7d6mvQ+pwxx8eLLhEaPNVkx5D/KMTM3jceQjlldNmusYfKRlFmJs0agncrklmMdSTVNGPrVTk5aF/Oi90+fJ7i+4eqzZ/UX736XD776fLnm5MuH1Qzllf8cf/WvqMPqcMOCNc4d4t0mJ03qMNhVRdXtLecg/4grZ55xw78xHFn3eUWn87Oh1TV06KlS6gASxSPUAB+sXKvOoqgk7k/8AbkXtgGfyWte4qzUzk1MxVUz0yXU1qzddNnNAVuf1zBt6o8hMzs1/SJo5yMiD9426Zlj+37GCQQT8iZJyQRlT5LMkePJLuam8ipAV4qTY7ZN/X8PM2VAcyOGR+spTWn45q625MkS85IkUPr4XfdTVm0SSJlOD5UQeNZkLIBBiFBX8QsRquRimeavUxqaxgY+2NHyHVLTk3yEv2Wi2DXTseq0jzUYeo1Qls1OouleqHmGABNTSeD8VlCvg5UcWTGY9PETl+0suk7miT+tdbJHbvVvBi63UlOSbW5qgvkkbB87x6NANTpDQO3VExkBTkQzv4fdYNpZu5YEM/wAsyOdMDLEiDc1fE19t45vTPd/WAmpXliiWutfahu+knHiu9R9qqppaWpyPxr2xU6xi/pnRrUjoPyt/kF8TkFMXmKJ5UIy01QP6rd/1/wC6V07t4J1mmzddY1so+gzkXkZsnbMpiA3BKH1+v5zdY+Rc2KSH04mN3rUMGRJDDO3pFwfsiCEtbPWtfIzkLouchp12Ty1YkySi65an+8TQMvQ+ixkkMJjqgzVVVj0SpVYyZFqKeaiKAtXTrQc76dcl0xdyzR2ZMnN0AVczGnHuWwhdItSzB9npPb9MMX0cXW67Sbcc8kI11RbTpknqWsbOO9U+R1yDSeAf0+/aEXgagywyDfwk/vdi5Jx3ftPtvr/efV+i9p9q9D6v3L3D3P1GD2/2/wBt9B6dz+v939w9XljF6L0fo/TwXn9R6r1eTL8WDHhhvNlTFONefz66/wDogvYPafXfz3/nz+YfyLNkM/p/efT+0fw70noPd/Q+s9Pf8o9f7z7d6H1PsmT0/oVfTeg/jPsPs/vPoc3GHBjPUel9HimZi8Zfmf8A9C3k9Xj/AOYv4/6z0PocfrPdvaP4p/yT73/HfT3k9T8vpv5J7L/xj/L/AHb2H3P01YsWTLHqvZ/dvSei919Fnx4i8Hr/AEXpsmKpy4mnhPcv4y+n/hfov5P7rXq8Xu/vX819T7f7Vi9V6jI+r9Z7V7P7B6fL737t6z0KZM6ZPcPdfbPT4PXZ8zj9wvF66MDz6S3H8J8dUet/V6OmOrT0qfhuh06aSKfX1Oqfier666QPUDSKafhQyQWKykKZ9Kg00fDEzUKjI/4gAU3LkksBwok653Dlwaa5JJhj4yJ0VHgjFPU3PKhj6Cgm5mVl/L+D1PEv+LJD8hi+Wu/jp4k+R6+MRmXWU1O6MbgkMnen7nDzOpf8c4yeACQsMvXepeU6un647FKES/hC9dU+MUsxkZcbprzfV/5MiG5881j+gmynvrjcpTdzJ4HtiDjGiqCJANwZUJH3/ZHXT4MeCcam+X5M8ZFi18szjzT53u9axm62hjrzjJ2vsnuGD2b3n2T3X1Hpb9T6X2r332b3LPgCsuT1mD2/13pPV5fTYsP9rvPGG5MdTxfcDGSyt81jyFMmq3WaAqniQre4rpacFtVoA6+wjUwz0fsXvPofZ/5H/G/dfW4D1fofaf5F7B7h670zNXHqfS+3+5+m9X6jFWOuf/IjP6bFkx1d1EKuPzA64viA+nUADW6Kwgg6vTakr8VQgbTIjWlFTqphKoNkRAlIwY2W416v/wAj4f4P/Dv5P/zJ7H6P3Gfc/f8A+R/zz0F+23k9J6nL6b2D2rH717x/IPVx6v3TO+myR/JazZPSex+6+1+nwGH0nqPR+5+mlKjr88V9XkctTwuPUzkW8hxl3uqnmml+RdEdarGcqVPX56J/OP49GH+U/wDNmT1FmfB7T736y/Q+7Zc2XNXrvdfX/wAz9Pm9rw+n9W4rnP6r1nsvqvWeuzZPTecnt3ps1xT6TAXl80Z8Hd1fVTl3OSWd5P64mqrqt2Jyaiq73zl0/nD8EBT8PQRVX1KiOmaqqpZ/s0IABIelQBJE6vq1H1h0/KLLZ5KeMTnX0F/wF6z333T0X/On/G38aze0f/Tn/kv/AIg9X6X0U+t9Nv1Pqr/g/wDIfYv57m9m9luceXO+8e5+2+x+4+k9JHpnFm9RmMGD5TFnsrxzN7P630v/ABd7R7h7v6b1+D3D2/8Annuv8a9pw+vjP6W8ntV+xe3++e7ej9K1P/13i9r9z9Z6XPmozW+n9R7/AJTJEY/U4MvqOp/4R/8ApzP/ADJ/x1f8f92xeye9Yv5L6PJ6H3DNWbn0z6WMvqPV3NHGQr1focfq/QCdfIZ3Ay+ZKH8p/l3qv+SPQTl9TOf2r0f8Q909z9d6H+P4/dfc/dfTYfQ/y/3SfVes92x5fX116fNHuM+j9tytZIjH7a+z+3/Dr0uOTjFHU6fx/Vpo9P8Aa6tXQ6/Vq/zoqqFXSRyRWKaKR2PGtSRX0Gj6ppATBDpN5il3gsd9ebYshmn/ACXRrLXdk1GMpePuVQhX2KR8kXiom5FO7jHnyhGozf8ArzzP1pyIaW9f4jV1jud04ytStVP5ZrFjgdxESTZMzGOp6nXOVgruui5meftX1kepx1NOsssJ8bqKx4kflUyCPyE0sRy9TNu2dfeAgl9ksG23/wCWfp2s+eAlVSyUCsn1elZU+BfA1u4rFeMmZxs/CNv9oyLytaaD/wAn7dK66uoo0XAfd/8A9D37fg9p/jn/AAZ7ZXzz/wDf/wD81fyP/kf3pn04/P7P/wAV+0x7J/EpcdYsk36XB7163+a5nJSenx0Z7XHkwKfnn6nNOD7ORqcuryRWX42NuqwUQaJ0lJLo1dmzcT9//wDDXvP/AIv87/4e9gzZIjN/Ff8AgCvc8T6iXL8frP5l6z+Rfyys2Ap9PXyPpf5X6apI+XJcNRXyfJixV4H/AKgpqq+EFNI9X4+rWMGnp9KoUkg4p6lVFUk/MAY11/BodQGSflAeCSN8xbYnB1+fH/0THu+X+S//AEQP/JHuHqM2Dz/LfcPTjHn0wemyf+JjkBEaIfl+s/Jv1KBWWi/s/wD5Yw/x/wBz/wDofv8AjD3H+Q5vkx5PWfxC/ZPS4Ky/+MYcPt9Yf5J6j1mP0+RzmDB7e+inWJjF8148GXK1kmH4S/5N9u919+/5v/n3t/tvovVe6esf5j7/AOpyY/S4Kck4MHuWVzeq9QBM+l9PjMhlz+qy/Hi9NPOS8uIqX8+5v4z/ADT+Des/4/8A4lX8i9V7L7n6P/hn/h3+Xe517c58Pr8GX+d+7+8ZPaPY/Q5fT48Rj9y9R7Z6r1ntHqfT5p9Tlj0ub0/pfUz/AORjw2PtfH9EU/Bf0CvoA1H4ejpeqjpo1j/oKkBW9VQppgZgiNPpF1/FQAKzUAaiLip2dkXbzrhfc/4Hi/mXun/IH8m/jmDK/wAO9j/jvsv8D/499ZfoPUYX3j2L+J4qw+4+7+l9NeKM04fWe5xePD8meosnNgyY6y4ScfyFgzeq/if8hn13pivTZfS+trGzF5SdRdVljKTJRFlHc1oA5soGfz9O/wDgf0+d/wCLP4pfp6y+5en9d7b/AOPXqPgZz+ky+r9z9Z6jLXps2bPJJFFxk1Vnz3lx5mochfyB/wA4/wDH1ewfyP1WWMF/+J6z1NZcbmxE1jyZ4bcebMdYKyenvd1E+ImlFXX5l/SP6r/++/E/034g0/26D/a6Xqkqgeg01M3K9RAy0tP4joD+z0q6D8346gAhJBIaaDqSL+j7b+N+5+k/mPoMB6f12L0d+rzeiqz1Etnp/cn1WO8dGKrymLjRfZH3meMdw0U/IP8AIf5H6fD7/wDzX2j0Bkr+Pe4/yT3H1V+rxFMYar3jDXqMmTLeTnNjvP6ejDdz9SXNjJ9R3zsvQe9+9/w71ce5+hyZ/Sx6DJHz7D/JWLPOUqsck76cdBlqpCnmit5K/OX/AJr6T0P8U90/m38ewzmy5vW5/bfUYPUZZ9Sp7Z671B736f3SqTDjcnpvTeu9L6agwmHHkyZcuCtHyP0vwHSo+G+I6gfrp6wB6dDikCukmRZRwrLXB8RX8lEej0mbokgIZgzygU516Bn969i929L6D2/0/qc2DL6Jx+n9Ll9Vkx/+PXo7kifTZ80O4aqbyY/U0peP1AB4LNR6j2a2qKwXHNVkjjKJnvE7qopZmsTKUXjrSBPYRufPa9l9Q+i9Plw9XNRgVgx25C8ZXW2jmcnOhNnW2fpkv83nsvv3vPsxk9PnivXe2mcjJ6PPVNY8ck/JWKiDJhTHNFM0Y9lZdVrj89Y0Gir/AKc5APpKaZpKL7edc/8AcZArCaRFsJEDaBOMTrrv477lf8f9+9t9zzekx5vT+0e4+k9XWDO9YvUvofVYvUVicW7rJkuMXOOiit+NdBsvf/Y/5T/IP5n/ADL1/p4X+Px6jN/OPTe3VOT0vt/r/aPV+qw5/a83pvTZ8WsvrfUYc+THlrHk+bNlj1GSsnGH1G9i+4/x/wBd6f5Ij/x0KyuFjFVBMzcfMTWStDZjyXjQ+Ml8KMbj3T1f8g91x/8AH2X+Leuyen9P6r231f8AAfcPRma8s3cet9Xl9T6b1sYsa4PRet9t9x9PWG/UVf8A4xg9T8PGO/iOTqUrrdPqmkUVEGio1EoICsEi3ygEAxJciNbsq5qpcUgu6HCxwwwxrx/+Te3QGL1Xp5f/ABvccU+rwZ6qMdPpfUR3PURVtZIFXarP7amPHmXuXofUwxl9I1m6nHGQlp2q7euGuxOahqgVHcbo9E9T7tfpsXqPYvVf4/8A6Uep9X6dCNEThax1OKsqTxlqWql15acKTrfD+4e+4cMpg1VTXKRFE/JMvx2f5J6rrX2n7JNVyiSenQxSGTUCPxYLREufb9dcvURqfDcbBw98J9tWPZfbsHocp7x/JbjD6L095cmL0Vk5PU+q9Tjx9Y8FQpk+DrnfR0u3Re5/OQ99969V/IPccnqswkHnBM1qJmUIj7dMyY+YxwPCa191r8qe4+4Z/csvVdWSdvVeUVEtrpFK55XklkeuZpCfTzhwRf1lX6Ku4rSMpLOphJaPPHh/X6QZqc/hMFoD5XccE3njWFRYFIgCTySKfslH011nsOMj2nOYz7XmyeKp3zMV1Uw8lc7+n/21HUi/heyVUe62Tj/x5MnqMKcq1WXG6yf2Jpk8Vf6Bn6uq2/28J9rnH1Jr75HzPyS4hY3Qt1XkrTz4oVqdhfx30+PL756clnxlz1qq1HxzDXOrhihoZDWt94f7JTqkH2SJ44ht+2rkGkWslBlfe4gR5Gub9nJl9y9MHFnp/Wb2gDEjrmbJaKNfolPpQS6/OY9v9T/4nqY9VM/X0+QyaDYm+aZ48iy721IaL1X6/Okwpj9z95j5Akj3F15xzTU3M8uv7LKajS/faa26H2/0sZYzNakIvetruZB5mj9/sF6AK0Ka/MyyqRacpdhnxkDWdTgC4eUAfF8R+Q10+f1+D17jvE31d7nHXO4iv64uOsrCqfr61Vz5FlbuP0uP02XrP6P1GXJ87WPFUQ4DKaqcdUzDkmtVLByNw40OWfzh+Klpnc835ybJ1pFk0Nap5B0Bskdn5byev9zy4Kq/V+oy4/S0ETWRamLIhvJVC1NXIDTM7Gn7eaRpq9J9KFvYekJ4I8onSFUA9i8KlOCAeItvrofe8uTLkjJmwuB+s/HEVMcx0/W0t1Btl7eZl6lRTmPddPrMeQCKzenxZGrRSoEJyf7O+Z6h8vg6Hn8t/wD099XOOJycerxDFM+p1lmnasm5aHmQRUT7nmWPy/j9sy+9Vg9d6gx+kwBOKYIdkLNVzHBcS90fJl6mf1I0zrMH00j1wju0YuECUTYTfd6Kh6lU5iPzgDnYi+SdbP2XNlfb4n70zkrFN5Oq5lBZ/rAzFKTZo65Uomt3fpc5H5GHH5v7E5ImZCcYrUlxTs+LRMqNj+XMXpsfppnDhmY+LHqCTrVRXiqEZctVwqSQk7614/K9zxqcbEl25eKiUaoubMrDzqX6ao+puZ19d4VkVVEixIJQuIVgDcXIsBfVilASRYt3IAkKSi52315yPgBnxp+Q0nf156ta/wDk86VGSjX3/E3jbzFNwrLQOh1sEBCK2ck8nmutp5n8gj48cc01omkOrqoE63rmDknfNAJX3V0/mZavrF/qWYPqE7kSpq76p+2ko8NIKfn3IMC5RCF0yNtrW3UCIuLOBt/GO2mV/jiIg2bk2a2U6N0ysaP2DP6oQ+qfioJmrrm61VP+pd+Fi2nyePLzq/E+Xf4Ihth1BctRko4dztgADrQzsQ/Z0dUOVrW9carwc9TXmSfJVUjv9oT8chX1C1lTgWAIJ2QxgcF9gdOABjdfYfkU7xbU0ZHbLOUMs6a1rGOqmWh3487Kjgr7K7+2Y3GZWrKZmrZUZe9zBHV63JSf0DVaJej8MdM0KF1PWrZxzNJRJQaZdP8AZddKbP1lp8k6SXiV1PxnZWvquzdv6deQRWtfhF8gm5e25FouQRtsfz+fqdSasPCfaSbNUBqQLqv7Dt2njRyn1FLLPp5xrzbRkdLNfXrrj/JXioWd1zBkdbkOJ0EfDWxanyVzZOq3z/iNbp0v6EX+qiy/h9FjKiCSdhWSCSZKCrHUPmHxryfVTRYEEAFPH28dmno0uHz3kWz9zzW5jzFTJ5lE8v7rk3WtGyw+bLj7fIcZNa8N13D8kry+P7I7Z8mufyqRNLVKpvLO/E8iczqj9IboiQrT1p1ty0H0TSzT9VcZVGwo4NRw6A5l1ryWCpseM8Re+MSIOgRfP3QuoH127McUk7fqrF73Kx286t88Y9eBHazWnVOo6f8A1xqZnGd1v7ZqGQDr+3RMgsm5OT9LQ3Px45oW5Jkf7KdO6pQ+lwS78a/+0/7R/ksiSWcbEb0nS9hyqFfFROpNbrmdeVCqijEFjEStg52h9loMHZzgbDiP9badcYn6pZ9+xSQTYcfQ6Z21MUTrU1Kyy0Dh23UyeIlN7Rvgg4lX7BrT+mjUujX4xrNkPNnXNfvY14B1djd7260+TcOm9/ioQtJ+uraE+sEtQMC1tKa1CamyaN6J20PUCA324slD2weZYUeP5HjnstPucY9Y8SbyT1po5rWwEq/6o+NdDzO/wsdzZXVuNHUtKRrXJKu3dVsQDrXFavSrtw/FuH7OSFEeSbV5bjU8zyczO6NU761P4bKbrQ/c5o5Iqb1w1+9gyL9fOt+KD8pzEMTbt5gZE6Ln24e8/qBEmdZjys1kqNBVaPNailkMkiaiZ45ldnhnSSw58cT5hSnq77uXUVIndRX2jrk1x1ptHmgmGKkWdV9jbz34dJazvqTyAnnf1H+34UNm+aP6OSKZlUSdTLQCz9UmZY1sB/qyG5wyH3FheRYvOy0xa1ntxbIggsk9tp+HiZIqGklAJyO3kLqkCSb/AKlzv7km+3URhHLW8xM6chRVTkobIcS+B0qanmXbEO6K/F1ESylPnnJunr/Hp6wryeQ1rGNSnR0b/ByZH6rDMjOM5OJ6nr97a+jrl2HmXof3+VGwE+4i6A876T4/3iFs76ba8z0d+HFN6aeh3JRTzCGvtO3W/Cy/kS1jsquVtKqiTqGkrxRwBBP2h2z/AKPLrOsi/fnIVRxSvJM0IzkVIoXZTP2XRvL1qL+RyZI+PmcfyUy7/wAiEbqG9uvITrHOxBTe6YX4gTB2IKjb7/WdMcDtgv3hbyN9DcQZAna4g2v1nIxTsE66aEFg1WuZ55EsSl+CuKHsKyTU3i5nuTcKm/rOMo2Ov27K48z0JfernUrUda5WhNE0T+hPLUi7Pw8Yt1TSyGT9lQjPIQan6c66SSGdcp/oqkj1ABS+LXwT4B0wOUN4ERm4yNnwzqwX1aEmOBosgmaagrm2aarmNxP+r3qUEKDrFGaZ7VTGZCyiiiTnj/Jte/1dT9aN888ygXGVytd/VhqzZMG6Hjc9dNnlV6PNft/H48lTdGl+xJQPWNoNBXX2DVHMqP7DdcOgR+Wq0I+yY7i9jNtEmw2JkcK0oP22OlGKwTkd/Yn+5rQQ9iTBLWnnxBWwB2M9LFLmyU8UDP2JmpsJK5xpph/7O+vPFPlfzOvifiMhkKoJp+wFaYavdT40lSDO9puqfxeWd45dkVDGR5GOuHTt/faEo7Z8M14NiopSIUBEFJwASuFtOJ0kRLAsPts+789n+o7Ga3FATjYCh3e0yUlLNOkpo8aao+zpcyVdNyyzf9g8dDPMLe99Up0HnQIMj+KyNVkqnJ2E1HnHsmzxDFeNmpDvy6b8Ch+PhIjVMryQVMV+rkG7qk/SJTX21rY63WgJrq4wIZnj9Yk6dyNj+QHJ8z9RoonLs7uOZfkItk3jn94R5mtHWTxKT58VWSn8x4yTuE5Jm4nog2EdREi9wnI6rlT9hr8nJlE1Y6r/ABjPgtqWZ7zO9mSdUhqqDTM+X8CMnxxjiaK5iZxs7axb5DvJ5RLfOzo2Ey6SqBAKZS4vG8AIWuJF9XaPtY2gSlEg8rOmY56VtAKFdTO65nWWpyooKdu/u/Xx+DNTkDiuKLK26qcnk3JC1s5rGzISW9fumNlOPqbnY/upukNzM/072lg8Op+utk0UyCsEyHINRtyzt1qJ1/jVITweJB8hpbo/KkEAiO43CttEN3DKmdkIz2YL4gvfeQ9WiaQrlD/1ael6/sWmTZMCecg6FZOOa2DOSaxzJWOmdZM1VrYOIRpTxeqlrg8QSEs7vGstfaYR7mV3kGuv2tVtZ6HbRjE0VsN/hlsXU5ce2u8cILz5kBb/AHO360G9CBueWwN2OWsgxCtvg3zokqcBYe8ozx2ONRGOxWKF8VppHHOhl2hK47nmAlOqf07/AA5xr0/21dX1Wxeea+NMkvX23oCfP158aRMvWcGz9OOf7RHijQta6K2i6Npzo1tW2t3XZW7k/Vz8fWt6yp4x7mivL07He1KYFkSDgDABe19mZUB6AGpAwOUAj98E4TWrNfG/vmT4t7SeKqd60UtIL4nUmzUsklVWeaK+OiGXqh8U3OxCKF01XBR9t7iif7fhGRNzlgqzrFNhsDUa3bW/9NGQNmv13KM8gOmeh+f5PEzXU+Zq9fd1o8aL890vL+IfNYAgXYRhI3Yx+UzqvSAEwcfQeduICs9Di3ixCz/2moumupaNA08n1qXc8vPmTYOspsWorsvIS63WitEovMTcohPOpU8fez8nJRhxdeSr1J2d0RUz93/RMEtbVdIvj8rmSMssBXUExX+vkuKk5qKfG+tbr+9bgZU2VEUqmQgErEFRFRFxKgsGWNOwy/FmLl3C7E8GLAu8hOjIYqgOdN31rW0ru9fatf7Xq9aaXhw8kROq4icpR9fOse4v5PL/AFTXOqkYfAP4Jfx/aQH/ANO/jZOvFCqzz5kbr+3Up40iUOa6qKjuo7kyOiqiJncFXMzaSNDMjs58UNMZDTEDIDTybw0JyoGpMrs4kfazAjJNo0+MnXKSTRzPnGT5GONF0sx4DrXigkkqd0KWZWKmH68lFUfH3UjRVgMVazDM/Xok/wB7FUmdVzqJ2SHOQmiWb/71VGup8Rb5p8TZLdFy/S28ZPidfGr402zvQV319quX9IDQDdhOFsEO+HJV1fU3nBTDD+gvcuYvrGZsqaqjq+O78CJE8ZGzbvrn6wbdzqXSjGHTROT6zXyTvJooOGZitTOzwdRo19St0AsJt4newqvkRhogh56rdZHoB5fsSizz0S66vXSOSOZnqZmqn6z9qD41CB0mySvO5/A29RRIKtMyNyirWFr6fpL4ZAMGfYNfRWAjRLkyo08mK4n/AOpUmSfkOuqV1o54/X2PJcq23eQ+uRxW/pJaxBM78Vv5IpOupTdHezzTbXGTrIfJkRne+irF5rJkmTUMqCdP+lUlXAQmq1fLav0Gt/sUnv8ARMj+9XO9aCHIhO4hSaRGYt+c6OL/AOxu7OxkcPU3GOfNx9snNTVMGsluvift4no3/wBq6N7J0EQN3Ttad5UpU+tv0nqecia3LM7/AH52/k3U3xE18ZSd2gGRJqp2rdHSsrzqZKg2kqVIEnX9piEkZ2hPLkyUuqv7Tb/d2y7F/BhuE7Cxmkjv/BOh87Zgr0zgmBxxvqM15KvzLwZWOQqVq2DfLTU9JTNbSdf1XfRmKMdbPqVrLWNqA/f3h6fH/XSu/q8oIFaMhVT3ALRjbqR+zrbVX5yI9bdG/wD4aHZ2a656tx1MtT8ctYb8yi76TkkDUVLrwO/yAQXkPO4RQKaB4wJEuTI2XaUvNjtAyzo4mXbN4w4qd7kevFHhFl1Wp2k+eBJuUi8jCE63NTHRFwOcfC30aH/aG2zVATtC5k4qOjeTVaQwh40VQA46TYTvklleU1g1bXWPreWpH41otJk+zQ1L9jHb/XQGr62xcWxhjHti4wGdxNG6gxN1lL2LN1gL+b5paR3mOHZx+zW9zyjp+xtrx+/slyaxGvrvmTynj5DI6PLO+qGoNfTxp+vlGSVO8mU/Tl31N6naVimtf287Qk6rbTt8Ef8ArkPNc9KSeZlKyG8ju1dz8nmUP0gUsD0ncYkF/hX6XVrRpohHBiBDQlee3+MAoRTVu7i1Mkx0bx458asevOrX+waXQgg/k9remOHTiVT+3idX2myx5NA3okPrqsyOSduOpyzdkrbJWIQT7bPE81G5Lxxsob3U/i5rGvOq383+OrSr7mgIusnmvNGtfv8AqafP5NRQN5X1TEDtaFnBZ+h7qQByAsJDY40wy7dTFP00RJUzTEn3p63yS0b5PO2tfk9XZzMOFZGqvIU6lhZx47je3zO2TZqFCRJnKTdujqYOaYf3GllXVVVuzv8A7MI/62qEU6K09HTL/b6/R8tM7yVByaZeQdb/ABNQ1EzaRHtMm/nSSpBAkwD3X1v2FyFL5orLN96ZhF1qcjNHMU0zVKeLFO2aP9y/gvy93xkmpb0WlMm+aE0sjjTyhx5/VdU/knF9DJNF9V4mIU5OfO6Cq+n01/VxuuJanFPOWgBEuomncGPU/wC/PbOtwgdG+defyTItB23QHmEdhwdAxvDXhJ3Uo7SdtOmfvkkPsdq9wvklC5HRAU/Hr9jMgabGz1o0M8s49x9bal4K5WqZR1SM9LqhCvyt9azVl62TjYYTUu+dBj8FwFhQ2tWc81Pj8fpuZYsx3JI+CGg01uXbWznU0yUdS7nVGUhkoHYJo594jmROnSApI39ImWAj+SykXGnZKZ+L5DZUTB8UVMY8g8FN7ma1Pe3noO0B1NWCJ2TdDrHGTcpXetKVk0tNBJsCQ2LKy/laug2OJBmV1ZM1NKZBdz4PPZtbplNC/lid0TO6nf7sQ7eoljt263v+k8i8GzT+c3U9ReAPT2/m/Htqg/UBKQgG6I/kidjq6RD9ZqB+MfrUksB4hVp6oSaCQsOXmuaNr7R6J9f630PoYceCfV5sWDJ6j1NV8Hp46Kzery0zdGHBiLyZM0wuOIdRTL1rcBjzWmskUNL1Ug/T7Yo6lt2v9eT/AHH08P5v/ZPSR6jPebNkPT+l9B6LP6j1XqXPeFw4Y9PWOIx5KN5cnqMt4/TYA0ZqyRi3NMV+cHxVYHTqlfKETcEq2Gch/fVgNOxMDItcqfHkhgabk969Pkw+++j9D6WvVz7x6nHh9N7iphx+m9E+tfV1OSJxGO7zYvTYPh8XixRSSM/IfgYZ5CNTjPjUKnqtASVC+dvJZ48Kuhr8o4n0fwYPQYia9S+sx+oup7vD6b0eH05MRU2Vkms+TLzUXs5wwFzkk6tzT19qKZ7rS6jfQk6yUdaN6BJ6EQoNefSpQRKBJJwAiKe0x7nUl1XyRYlhcRKLmYF9NiMdReLIzf321X+PeyA6mv8AutFRqPF/US5ZpJixwVNTzMdktMQ9DMxjd6d6TlCV+oSaPySryWHHL80YulMc3UT9nJtb1RolPq86o6+34U4u7uEpqv8AKO9MXvkwlU18sNqfXT4fJf1/ESoUiZs9zBfH7PVImoRM/i2scS/lEYKyVvPRZPV4v43/ACWPSemicnq69g9Ln9X0fNg9C+qyZ/hxNdbMvuGD0PS4jucZJq/LS94w+6Y/fPeI95oye8YfcePcvUvx6yZTDGPG/VXL9GJ0JN/TUzSbtZPXZ/avZPTnoWD1PuXv2EvPlmsl+n9P7Ljx+oxGJvDRlnN6j1mEy40vucM/SKnxV9fi9bk9497ye5t5vdMvvfuF+4ZdTjMnq8t5G8iaiyFrbNSBPJExHEHN0/8A61RIgmogtm3TCpXaVmxzrQj5QIhFOZzl3sPB1VXtQ5jVS0fWHK4z7V5FtfAS6aRm5eZVWSshXiryYrQy6glxfNsoxrUmuYqdPUis6a8/jctXiqD4wx1Px1kg1JXSUtGQjpia3krbpPrRveZDDZyyeIjdaiImg+kWbaWlCuT7IG5rjWxJZIPh3sx+QE3vOgU/LV4QEIReMYYJkLQzjn4sbOrKqdprqYo8Rd7eLnmCZOd/UH9flz2r3PP7J7jh9z9N6bB6g9NebHn9F6rb6T3H0nqvT5vTet9B6uMPGW/Q+t9Pky+ktm5Zx5bmeb5oqQGSssJXPV34RExz/wCujUzUtKnxjSjFPa2h6nDF4ztgggfOSmTG1W5PHXySED4kZhx0XyP5lUBVSaSIqoUqQhsH7w9ZkyC7IuJSJsHAj8sa6L+W4cnuHvPuvrvQ+05Pb/Zv4z6f2j2J9uM7ln2b0dxOP00lZuPUTWf1p6z5rrUx6rJj6/zeoxx+cN6pjn7tCWTixtz5iv0f/MORo0dcV0Do5n89V97959B7r/HfffefT+kn273b333H+M+2e+4PT4SvbuPa/SV6i/cvR5qx5MmPL7n67B6fN6/0m/jjLNZpynWAx+VXiPKJj3PzY+7Lal2M65o+N08ogrqSGig+Cqr9IoI9NPSqFIEP8NIJIPJKIPJ0dWmoVCphGY5iMWSwHjVbAZLck6nsrJycrUTLLOsuT9x5NLDrJR9SvInJj8+a2/JOXo6cnxeaenGagxk7InVA6NTW/wAsYIrqsnZVSakpu9xLDM/0EydH2KaI1Sm9zWX9HJXfV5qFGnUTdHxGS+TGQVNbnilppnZfL6oLC34hAD2uZ5AMgjWfp9Qf4R5m0bRibEADS6anHO7iVuIb1dVxMzU1Rrch0c09Xv8AY7rVh04JeB/9UbkmMbudNWh1tDVV/Vkpd6qitl6q/NY4YieDRMPx0zadU7qnaM67hqVnjbZxNDkmpcnM9YczMl4sUEMJLXDLQyeJOtzTvxWgrIllELLcDZFZaw7RXpymuSVIkLi5sbm+mnPfISpYwn3ie5ambyPUkTrZKb5DX7KNhg8rOTE1RXxiS9KkkzutDs7Sp8SOteKL1+GLduPI5Dfzf/J8J+zSaKHXEzjf7VpkutbfHyRAzFdRjkGEnHlvxN/Jko2gbvpaivKWyLzdatEATAjwE1HbtOqBcI91EYdrCNpfF307irHV5XI5HI46nqZ+2plxPgyUXW+rfNMn1ecYbz0uOfqRh2+JyUt3kXuWqjZj5meuZvxrkmpQ1Omw4q6nm11UErJMTtvvHkvliv8A5rpJpL265DfYa+KpnwZKHF5+WjfWjLk+2lr707XX9UZ2PkfEEeksq7yMIEEX+0dta0EBcBb3IAGe8tEba+rv+B/5Vh9j/iH/ADx6f2z2vNX8w9Z/xv8A+Z7P/JvSHqM/u3sfsfpvc/Te2fyX2z0F4vR+t/8AEn+QYf5B7di9z9fj+O//AKV+3er9Jju//O/8b1PkP8r9q98/j/8AJvX+0/yP5PT+6+h9F7Keqw5s2XKelyZfafQeq+D07mqsnpH48mO6w5Ry4pOMv+TB8eLvvZD3n+I/x7/i30n8O9X6jB/KP+Vs3/n+t9T6LDV+5ZvSx/M/Vfxz2j+K4X0xeXJ7Lr2D1PvvuXoMd+ofU+vzehyZPSXl9r9DPp/JfdfXe5+q/kX8i9R7r7g+9e6V7z7xPrfeMk47r1+Y9bl366Mz8V5q9QV38gGP7hjxY4yVD8b8NRTX/UPjPien6RR1qi2z1X0fT0FtTQPRUgDJJqCJOuzqVn+10+mkaQ4kKr5mckyH2Aa0eKax1l1ll+eLrkbceKUaFQImtQNTqut3lOpax/lrU4oxRXOvrLry3Fk7MmSfEpzR4nxKgfVo1bl9REnw3N0zNs11acpu+IkiHERzrzE3XLJHzP5s/TpeHHt5OZb+QPvcUTU8rkTYURXQ1AT/AK6/O/qAS4nYFNefY7rWVNyLpmwgRsSp7ZnGt1OTI1v4nYGDqf21rkyLkX6v15yTodyFHP2sYcuDLk9KeuLn0M+s9BPrqiCmvTOaD1OQvoaqcFZKM3cmwmoaZp01ZYyVM1LIXMqEQ3k8y1c5G0xug6NLzzr/ABzSHqfVmD03qq0W4cWdwwU5aqOQ5iZHGwJxGp1NnizdE8lYVFRaCJj5VAtjO0xhauiKqRkekQQ8RD3Esq2vZ/5t6L0nr/8Alv8A5T/j3o8Z6P2H2X1n8n95/i2Bj1L6T2323+NGK/Zcnp8GP1Ga/i9x9mn03ovT5qP/AB8uX1Xps95DJfpqy+cGOcnPm8TERkgvLRjTVSyQrf8Am3+nXZU46ZqfHoH/ACZ6X1ns3/KH8l/459sh9X6D2H+O/wAY9F7l6zI4Y9y9zP49/GPZPX+6e75Pd8uLH67J7d7h6/L6j1GH01GMyekj2zF6gzHo/SVPDRjx/WPkr/GmQLySFQQQ48fJXWmXH/r5Ao0UtPnfCL+x0qgqQen0wADcCmkCoxBIEhdzOturV85ixI7JBF3VwjsTjXe/wD+Ver/gH8z/AIn/ADj2mPS+o90/iHvftX8h9vw5cDm9Pm9Z7f6nFnnD6vdn1zwXjy1s+TFfIpJ+ep/yCP4l/BPYP+U8vo8PueD1/wDypH8Sxfwv0fu/suT0MY/4J7v75i/nHqf5Dkz5cWWfRZsHqPZPZv496CfR1gx+px5fcvUY5y4yKyfPOIluonUVbQ1mu3qdzO5hnbJXJNE7nm4do1Xuv/Intnqf5V/Nf+I/fPQY/Ves9l/5F/jf/HX8e9R6T0mH1FY59d/GsPsv8D/kvtfp8fqavH6b1PoPXezf/TPFOG80enwes9L6+X/JOP8AObr9OkfEdOo1eiiul11WNR6FY6tHTyvw1bR6oOrp/wDpVAfMQlTJQqQJuwwtu6187+px44zRWTNzfyGSKKK+KFQxr1GR5Zacc1uv8mmvqmu9Rmy5MimqmnuNM6yYr6KyXPVmS9Eb3CWcVyVSm2/kJ6HD7r7n6b2z1d+q9t9L7p67D7f671EmPJ672/0nqsuH0XqalrKmX1XpYx5cmPF/i6upmy57/OTz/Z1jyRJMS8i44zQND4Vyd14nS4y5lkNonq0s001YqRAjKxvvA865CpnjhMO732hrBWxI9X67P6b270ONyep9Zmw+3emxTibv1HrPU5o9P6aceHsyZK9RnyGMqDu1+IhOvz7B9n959F/H/wD6Mr3T+P8Ay4//AAv4/hxf8bemxY/m9ME/xH+I+j/jWDHCO5r5/Yi8Bkmocl/I0GNfzgv/AKET+H+l/lv/ADt/E/cvc6jH7F/APT+5f8me95uZ+I9J/BvQ5PePb49Q5JyjHq/fj2f0NmTHOK8edlvzCaL/AId9t/mf8z/+iA9f/wAoel9o9w9f7P6X+eeu/kPv/vVYzF7bgw5PWeozX/5HrvU4zHl9U16rE/8Ai4YrLlxUsY8oW/nl/E19Pr9b+odDqGkUdL+mV0nA/ufGVEdOSvmpHQJFN1XScjXX0QaR06xSajX1kA2hQBOMmLcp60X/ADf7n7fH/Kn8z/gH8eYj2P0Pv3rPev577p6TPU5v5Z/M/UeofV+54PcfWDOb1nsP8Zz5svsXsHtDX/i4cvpvX+6h/wCf7n6nPPZ/8Pf/AEPX8H/5M/jP8qy+/nuHpPfH3f2j0vsHuvtOfJGD2f8A8/03q/Vb9X6BK9D67FfHpDJOSccz8HqIwHpru8j5Z/HcX/HuX+WfzX3P+c+5fzzL/IMv8z92y+4/x/8AjntPs+HL6r0uX3CvU3n9X/IPefW0+kX1D8fxn8d9TU4b36mIyZBr3H+Of89e0/8AHuD3D0f/ABr/AMWYfQ4vUetx5s/rf5r/ACH3T+Ue45//ABcPxxWb0/oPR+we0TcHVxOP0LHd1NfKla6fiKvjPh/6b0fg/wCn09an4qmjpf8A7wSKaaqh6TVUaqiCRUiEKaqSPljV0/2v7lR6oApLK/yDgADjaDzr2L/6HbH63+HYf5d/wv8AyrLWb3j+EZ8vuns3qCsvpsGf+P8AvNXiy+p9O5Lhv0GL1lYvWRc4XHGH1xNs5cXU97/LfY/YPePRZ/S+/wCb02OPmyBk+TDePDgnGen/APNmPWayVaXN4suNXNkjdE5Rmfg3+U/83/8AIPu3rPUevye4en9v9V6z056S8vs3osHoc+PHWW8mP0d5fT4TPPp8PmDDV1ixyaxzdtp4B/IP5Z/JPc+n1vvPrs7jtx6yeqylq7+RY/3VtPLrqqeqG/s8fT/9N/EfGfGH46rr09DrdUdPq1ij5n1fSBXVTNCFdTqXN9R1fjOnRQaKaTXTSVSSJTVMXQFwvy19e5v4h7R7T6z3L0vuWX2rN7Rx67PGfP6/0o5I9DkfWZMjEmfJg9V/42KcPpownGX1HqcPGPHlHXyB/Kvaf5h/KZ9z/wCQKn0s4/5D6bNB/H6zf+T632v2z2/1VYfR+nmc0YKg9H6TB6bBhJvJ6ms2TFnzzXp7usHlnu/rPcMrTXqfUdxZilr1F1ukZq7F006EV0pw/eT85fJ6v1+Klj1XqIHfSZ7Obyf2R3pEXyOwVHzQ/a/Bf0zqfDVjqVdc9WtU0kVUwgmKQ3T6kCUSIs9eX1evR1CAaCEAAGLwmvNhtcvX0v8AxH09ep9o9B/9M+cXqIMWDHjy6w2Tx/ijLBlKjuxsuROeHnvf5vfdvYMdRHwXh9R8nxbnGRWK65yUXWSbBzRvelFPsYyVJ+ST3D3PXj13qIoj+z6haplZA6OtC6GeVk5AqSvzZ4P5N79gmWPcvXBCNT/5GTTzI9bd0Cm23ldU1+xfRHw9X901isUglkWYjYgS7kTjnOnrUACiqmFTJk44GSxecHPv3sf8K9d/K/5V7D/FPaNf/TH+Qe9em9n9Pn9RufS+lfV+oMeT1OZnip9B6LG5PV+qzTif/GwYM1pLhQ6n+V/y+/Zfdr9o/wCLPW37N/F/45fqvSe2e7YPTzj93/lmaMD7d6r+U+95MuG6n1vun+TL6f0sXHp/afQZMfocJQV6jL8+ex/8m/y7+P8Aunp/efa/dsnpvc/TYfXY/Tes5xXeDB7l6H1HtnrccVWOiMmb0frPUYWxmorK3juLCzXY/wCX+p1POOZA+OzH3KFkzTGmZrybcllDtxWV5Px1/DHq9YVdY01dKigCiiTSeofxVVYQCFPc60p63TppIpfqNYLAI+UJdpP6oFD1X+F/xb2z+Ue63/E/WVXpPev5E/8Ajfxn3EeYn+VXXfo/bfdbZmL9v98uD20y43G+l9f6j0nq8uS/TY/VYsvjvuf8ezYsuTHk9NkxZsPqcmH1E5K1WDLCzmxXN91jvBQzdZNZIqCciT9zfei/mb6X1fofW+jb9F6r2/1Xo/cMGXFPCeo9HmM+HJIfJkKnLEvRZ+mV+uOn03/lH3j+M/yD/k3+Ze6/xj1Hp79j95/kXq/efQ1g7xenfT+7Vj9bkwY/T3WKox4fUesy4JnWQj43H0pDkkDqU/FnpkE9Cuj104poqoNIIm3rpqCEGDdnSIor6YIXqFXpgh1U1AFkIVcErIGdeD+l9irJ6iMVZSZ6LaqoOScmnEbxB2eeZaeXcy6ZJV73xh9VPpsFc4IZiWMf06kvGSCsnO+clAGt8sya/PXMmD0vpvTZ/WuOZn02OsoWbOt9zc46sqICuGygxvIQ8wfni2fJ/wCR64u3ovJ1zfV/b5tpTRQaHWROkGt3p/OoEF+mxKm+B+nZxxhXT6AQAGT/ADmbZATQWuwyWen9PHppuZsx48Op2Yy7nU5KyS6HhTsB1TUy61+bX+P+nXJ6jK5MYem9FScPLkbn9FjTWR6a3Grv7FIyb1uabfsTip119cdXJBVLmHpTJL42632dcnieo9qxX6X+P+t9Xkx3GX1eZ9OZcuNUZiHNzUpBhx1VKT1U1y8sefy6iRSUr+le2d99+DGqoRR/4gkEFoJLva4jFtePZ81x633XIaHJk9UCTVIVk55arSxrrxpTTDNM1+P9px1ykY72zknvknq+etZOxU+tbrk1JMVO5rdX1D16z1Lruqz5PNR+msmjo8HLvyov9j9b/Or9l9M9NMz9fSZb+NmbB4Zm37k/KnC9M73H2TJIADJIFg8Q+YE9oQE21lT+LsSXAQhgwL7drCNcLFTV5ior+2aTjcv9kZrdTSy7/wBzSGtDAnpnsfsP/wBMPQ/y/AYg9RH8Wwe4YtZWYqY+HKOLx1myZL8YyZC3qWo8b80yZZx+rzlJ05skeYDzdbchQhvkqlNEgvIGvz2L2P3DMV6T1fp8wd+0ek9J7gYiSon0mTisOTkyVZ6jAY3WVIyodeJEx6tRNHysKCXA9JDeACgFzpdMUmpHmGjIHKErhM314d6PLsfGv8jH9e9VXP3Do4fHjfk2v+k/PXfbvUx6v0Hp8yTr4vguOdVGfCUNTvJTEhuj6pjKp5om1809w9DXtfvPuft2U2fLkv0tVOl9PmvrBkKsgRmiKsN9zXB/p6z+LZ6rF6j0dZQyzHzR8rR4048uPyzN7rjo5e6SqZqiayrAq6YuEbizgHMK7xM6imCQpxbCTffbvreZN9lmTJkyDNbbnHiGuOcSzrrHVPX1f8jNDzFTqlwW55cE1d1l6rzsmmSpe1ahSiK+rVEyM1LX5bqnFPlnJd1uGiaQvfxF3/j54R3HM0SoB+itmuZkKr7ZJS7ooImgruq300UPNEOpFJPPXOX6RIBFj7SPUyS/VAgas+pb1RfuGACe0QVwdebfFf13ZRkZWWhAU2D4jHsPqzOqWql+1yqyfHjHiJHpjTOyWqOPvsNFDrR455TRv8GcmTKXDTjY19PsdGPWyJrdO6U/U78wyIVRZFxwtfYWZK5VRJ+OurRWOV3R4DyP2390PSmFZ4hKNgDyu2pcR/r7flpc1W7KnrzT8hrfPiaCn+8u64kDdAKXtQPE9Sn+JJooqmweqammnXRzWT/5GaDWwnfG+grKkztaccWHLV/9QRAJ2NV+nWiw0SOjreLjr+s9uudyuryuzT9furpPC24YjLl72OErHZW07Bfv/Obawy7rLMHBjjz4Y6Tn64proll2KSblDcgbdj3R9cxPj5O/E2yk8wXcvVxvR+tGxWuX8Vj6LvXhZrpk56eYEoUWqPFVt3rmdVy/kQPW58a3k62iGv8A1i76hoNVMn7olLZqiXcblbQkthGO6On/ADxH8t76nWOTUp5yxTLycNz43ZsJ/wDuU3rVCrPOU1R5lObmDU+LI/2ot31/11sp+rqvwCTDNUJRY3IjaaOtFGg45JtnexXw1r8ZBlZiqCv/AFy0Fbxmo51k3oAFaTo6NLX4hKGYYDIFmCoONmZaAacfltb+eNBF13OSoriGZiareqSUpUigESVQNaCma3alyZDrLcRxUkyhy8M70Vtapdn67Gv00CVn9X6FxG+efq/H+qbR6LCv/irRJR0/lJDr6n97mhOT7KaHTX+Kq8GjWz6rtS0aQTJP8vx7RyjphuRdW9xiQMD7as5aPtW5knWPxH1X9VdTNbJY6/8Aty6nWnQgcf0bvcgOIn7bqaiZm6pOTveoU/8AuAp1+GGTvV1GU03LQPiU0FPD1P21LtXl2X1KGMi65fOqaiqCU0nxndKc0ryT47/WqSlG4g8jyp3GBj7Ev+SIPAWTjsN3q011IqZB4x0wkyw80l0u+pddU8mk/wCvL+TQ7U1LEMrRw1xwaCu2t/X7n7TTqvP4mQN2tbqp7kWa5rkp5IJ56HXlk1QhWun30ThI07xmmPKmxkvIq7sEoAqtTOgdtgsEpBfxHHFrHTjAX3sLLbm4y7K4cWPHvQ6lKdu2kZMijupJ81RqjemUrbOqiiZ1VfDNSkvZwbSbrU6DRjkPs72b8OT1R8a1X2iYyULeN1PKdMlR00akN14Pt+0vdKJTZd7p+hUz548muV8HMk/udFefwaIUhQnED3mGLb6X847ZtdhnN7PPjHfFDWWK3Vk8zo5KudjLy7lnaDqkRBYcjTGOli6X7D1HhYJr7IU8fSWXoPFaoTijIxkpNT51L/edxCPk8YzaS8j/ANTVFSzRfMBmNTMNHyFDGt/2Dprnnxvhl0rNOmJFrgYGwEnsv2GjaEHHsLvjgDjVufBTVTGJ7mSkU3yJPYHL/WQnbepAnahlI+PcheS5iKqp1PalllqlIT5uttutBj5Gt5y0D006Zdo86jmPK1pTX182z/8AMiWIp+ExmI+so5Kv7bdSE9mlqnRTo+pJrnosTHsSjYAbbTClaLoS/CS84F7LOdJw63la5/7TJbu1eOQJ31j6aNhPl/U10rWSfjDPHzZqmupY5ib5Jx1Y70UEk8vZs3qp/BI3kmhgeV6PoXzQkqebXYWeN80PkNEYz5adycpbSpqZmVxT2ImkNS+dvjepEAkCDJtxn8rcg6dPvw4FmLfacKVqa68VG8n+Ub0fWYd7m6kSoEezmTHIu6mtDir3WpIUIsmKn6zH+TKO9HWtNUDp+2xfyKyYo+2uN4pn/wBbzY6D4460tbPN6nrZt/aOOtTqZZpxlNVy5NPMhqtE41PDrlKCTQasAUkmGpYk2cvPJXOjMzvaLMGyusLdhaYzE1zMUGQ6FSCNyTAsvDJrUmh2b/bP4OJx+ZueXFUTNUAFyiTau6G13RI3rl0yUhjq6HDkEyY9x3sJo+oz1XTW/sxRrrRLM1BX4ziHliKbqiquuYjH5if7JTljv914aZJpeNfjpmQGHZXZAMSyvYGQp1QLxnwvl3HsMC9tWbkqfFfG9fN11Cc+Ssaa0vBsxycL1Pe/sJyZMjEwaCniszsaK1PyWf5An6I5f35451LVHlU3Y9yyzzVAQX2yzkFMcia8Sor4+xTXjJ9reZAxcUqlNQT0nVeK1SmXWznkF/tpUfSUWLbOfTta0WEjEaIdsDvgeFiY3dn6oB+jWiWiejma/wD1hW6BU5qtDVeQ2p+Z0Y361N931/0qoamaDcpJc8UGMWa2s/RT8KcOHJOPPisJf2VUd0S9cZDS/qpnfX208c7KmMePHWb42VhpuX9CyuoJv/QvWtlaEx6Q/KRuAn+GWFB+twXx/wAdWHsCAIEbhM+0iV2DfM4/ggckE7m2tD1+hx3480ePrP8ApdKa2kxRtZy/GmVUq9dSI1PNT5l8PxiVsqUB/Ix4s/WlLn+0E39TlljVTMnVTA8Svfl+o0EVGTI7aI+8ZPB8c3MzK1M7LqlD9IXIyeV/ErMPCMbewFt//u0pAEbfVK21jDd1q3joyCEgzDNT/XokgWSt6NeEnmj+tHEtflfxebH8gHKhW+IrnU8/buvvojYAmoQZmvx4r/8ADJUzZJMtO+W76vpiyearcrtXwc/g51xQeo00RUoa6qZtK0Voqchy6H+u/Bo1+aEj0zhEm3/GM7XZku7aMgHZEG0ZDcFxcwdxJ461OtY6pOPE9MY6kJu7L3OQZ+ynf62eT8VVU5oLxfSOhaOhy7iCvujxWupJ+1VCS9S/mYyJZ5Wd+VrJqarNX1i+deHRo3SUJLzRIeX6Y5v60gYyfiAOkZyNP/1FN7r/AGTR9wPx/iAOxDAVhInl3AUb6AGOyB+nsAWIAneBoXIfHa2FUrNamaytfCctLuUpJVJ2f4y/P4W2Wt8vds6ZScWRJ0lhAxOnXHRI/opraDHVP11/rP25I+8FTVY3cHXnW4Nn9o2ofjNtvkYnfgXReaV8sXVI7vxOhvTCkk9AsSlkNbL/AGrESM6oWEx4GO0fsL6NjeSctZIamBJuTJ1u5pDX1ncm5keqN/6+tBnzwRPVfV1ErNy7U11R/wBK/qCIJ+jXmOoIbZqNZJUfuuiJyYyU6Jkrzsg10EiH5masdYypRXiQMctdc7iuJ6ZZ6mXf+tmqERGr/icbBqHAT4uDvL0fLMiwJDGQBxBw45a0Q45nTpaIuZSb5q/Ek34CYdq0G+qZ3Wp/ENFr085sdgUFay+AqWVaqr3r/wCornSCFSWvikiri6yUM1y1OPrlj/JqfpGrlmZ8K0c+UdyfX/6r4ylJ11c71dVS0063PP8AfxJpmfxzVfFwMCOWxv8A70Ekj/TlXFnvb89BTiA65dnOjH+6AC5aTWnzVr1P315D8xmid4563JdR0Tj1SdMMsUJ4j+mvPkqXYKVTKriyFTq5NxzfLZkFyaOiKrRpdS/cFavxm6TIL9LmvJvfGqlCZll/11z9ideQKqJYVIh4xu7oIECAJl6mD4P2Qvvxe2JKau28FH/Xif0/HjH42S/jUufpTpdT9T9U/jWtydDyf4eXn61Tts7aomVoKNa2mmpPwaxfHIxr7SVo266P7Vc/qRB8zuStc6fAVeWYggmNsY3JTp2s/dapOepYrJUaQ5kNd1LIbmWUGXEMdjlWOVpggEkgWiWbAefe/cazu9bJNTr078aw+T7ZNBSoTop43zTQEdfkZf8AJjxNHn6pyeGPO/kpW/8A573M68VQ3IymruLxkO+kxXX3JWbOWkpm/kk8teXXSvQfjZX5LrqTcv2ZrRPjc7qQDroiQ0JRTvz+T6i1g3cKQxZFXnyzpCXuVcbGWlI+rGnMdR3LyVY3Pe6AjVMzU2zH64f0AlJB2A5uJE58hjl5OqqaA772/wD3Is7rWn9izlyMzHNBGsZQFfHPnwtCiMz58/Q8f1a0useLK01LNC5Btk3yLWKVnbPlNobGp2Vzq6uDZCYuBYgfkJ2lsn9Lrh5z5G+oi0U+lPyGrJb4NTpch4ZkN6JQH6z+38fVMn1IyjXitdPnXO6GOWEo5D69bJ8o18cs1qbOMh8zOUpJ0yhjq6ZaArl1plrwrXTMkzaFZK1SVsIo4WUm68mMHdaCtSXRukCRAtMC/a1xfa5G8akbq2BylaOSgt9LhkaWnmfkRqHr5B3vrVFGnfhetMnGtuS48i6cta3dUMpGif8AHXU9zO/FTyKvOOd6r8ZQx95maAiKnmpkvQzlKP8A45/tX1K288gCZMnyuSNx1VNCGv0NbI8Mjonv9O/+t1tWQjAII8brCYtkExpfiYOQHnbsF++J1amuIma5NyMIdlt8TjGlFTzMuhBI/YdTcmTWwNRFWpptHdHVbqqo35Cfk1IJrf5W4m8ldWVIGbG1RqZne8PhoB8dTEyKf3KZVl6MRteRmQd0uP8AtI1rrW43+vjmbnW9V+MVRxjkISYwVAd7MaYSEQJc/kw9w+dwJujgLmo7CN/arq9GvrUuSZovf7KQPFM/ZadxjyVrc1jjo2eTVavX2mjwVWw8UoSFM3e8nbRrFDPFbr746nqpL3uqN81P3PKHOj8ZFiaZJmt6hjrTcz5kPHL9+ekdbdeFZJBJDQi64APnHib6eSfzERTIf37Man7fIGoOJWZrphMfxb4b3Vpr6Bwzo1s8/iCZyU3cOSjJqMn9RFEHppYrbW5R8A+SapuPdfJQO53/APcsIRuDp18dK/11vety/i2OT6avqorG1vcizyU75GUAOdK6HeiQm2bmeVaCB2S9Nm9JAr9xCEWPdCBjfVhng3BNzXW5kEhsK6ck+YBnRsUk655X8GYoyGW455i48gbZ41c01N1bs4/S87N/XQY61kr7PLunp0JNRqNvJX22TyB5qZ1T+EXOVyTUkmE1Lo5b2S9Nbqg70JOvoDzczX4qkQPoMWHvH1UZ04Pu+/1WBH0Cen1i3NGx3/m/6x4HdYlNK6mRg39t7rZuR9PmSQqTezkJuqk+lQ97P8YzsfE+a+vVO5+enLWIhKx4j7EmqJd0nyP3OlmK1Pdaizqd2uGiHfNVfiepKTGh8bkvrRH18P8AZ2ePGpkoWatwURG044IWkbiIyS75RPb6e9iW6KDk5bbtCVrx1K3TTNKkvB1QQm5aDjIVNDycE96CSiZNg1uqtdim+uEEZdKkckFgXzLFBucmSglaraW71yVsKdTTo6C9PVZJzfUgciVc+WdTM0NU7YG1tJmk0VG6T8iuECwwz3iFjt5B1VKC+rEiKXx4MTxq49GMHwXzCmSl+NAMrofDQlWjSf1mf70+IiJnqySYnSa+wM8m6V6VTYOzxuf90YyQvMRpmHFVciSnBVc3UuxrTkoCAoP3MtyHFXcZNs1j2aZ6K6GcfWyRXqmQKSvpygXxdRU+oskm0sbiBxuC7WWhhz42xxtllza2tvjPIouoM1fFO5uQ5TJkKaK+3LTXPkmqdH5tvUenmPZ8F5JvHi9f6/0+OC7omsfpMFZaJmSvk9N8mXFOTf1Kma5EgE+2emxzh9b7r6vH8vovaseK79P1S+s9T6i9el9unIccTlyay5ON84flyY6rxP5TzVm9ff8A5PuF/JlIYjAPOH0uLJu49N6PATE+nw4fETIPFtqXe9eV8QfXX/bpAHpmqra0AYgshIX400k5eJs0cnzBbbGtv6iPb4zRHoM05U9v9DPrLxgYK9wyS5Kx4KZ/zzhisOG3JkmsmTHcv0+NpN1mtm6gD5Jx1JjnTre7uarqqpVK3+q+0076sX7dPo8XpM/p4qvTevwZfURNJDi9T6ZcPrcFuNYSH4sjGMqicuLul8FYx1jrk3kdfLjd1pllJLs/vt88E80ry6aDnpNPph1BqcmCbMCYA2kaAEaVsJV4/wArQjsXsL6cZzaupakxtcTusgqLknc6l3uxaamuNkeG24zHJbNXUzjmcRqhReqyO2UFcmua8d+E3NaNY8dLUMfLuGolqS/OKmtQSYkto+pjGtSDIW/TmTJkryRRFRZkLmsmSXe5xlSNUkr5J2fExo3+QUOGbSRFk3yvprUpBAyhuMCzg2N9tdJgwx6r2H01k/I+1/yH0GXLrJb6bD6X3XEYKrLmC3Hxm9Ni08kSpTF5KnIVf5BPzfyb+UZ/njO5P5D7xl+TafJjj1WaDWW9uSGYmYf3b1Qy0fm29hTH/HP55fyQGL2X271GPLeO6MPq4989tPTOPDW8dMuTJErvjVTP+OknT+4YWPWeuj5MeS59V6qq8TM5HJkq8m0J+Uu9If4y7+VqZmpK4OlHxHUD9QBIpm34CgP5FjrX00+igksEDGQAA8dhYgLGtJeQOSY5HWEeKmSqSimK2EjuS1bLLJx6lFbOGcpNHVGFusssoXvqPkqGqrv+2oJOQrW43+WsnMy2861M3MQ6MiNGVK3wg6bo6nScpM0gzMfbG8LJsuepyT05K+UxzM7FFa6SFTSJXUKgi95IV9nuDIn9DPqiqyJFvSvH7rEaG8F9YsmXKXxE3igVidMNPSzkq3ieT+qbd19QrmS1yqCScM10L/VvNMVR9pK8+TVcxM9W2bGk2PTcONJ+q8UrPRzr4onavQ0TXad0DWjFk9VWP0uCX/yc2bH6WCdR8mfKuIL6ooMmWyF+tU7hY5LqaqgPUwQAGbNANM8j2VhrGpMAbrmwQ7GELRdFa9E9L7H7f7z/AAv+Oe4+lnFgv2b+X5/a/wCbPqfW4/RmbH73foPVex+44JDN8k4/Q+m9y9NnWMmbHk9LLiw5Z9Q686989N6H0vu/u3ovavUX6n230Xufq8Pt/qslZsbn9uwZ3D6fJbkjFkoyYyKanFjx0tHP2lruP+TfQ4PZvdcv8C9E1l9q/hdPtvr9ZW59z/l/x4j+S+6mWcE1lwR7hjye3e1mXRi9u9v9Nk4LzZV6X/iH2P2X+c+4Zv8AjD3j0npI94/lfo8nov4B/I2c0et9l/mJOPL7V7f631eMX1X8f97PSHtPqvRZ8bPpvV+txetw5MNw1n87pfEVfDdOr4ur11dA1VV1UwTT06qh892UHhr6M0f3Op/bBFhS8OI4fme6Ph+rKrjWaOmeUGceTIPP2jiTmZ866k6+SZZU/KvVrXU7R+Ick9LU+Zta53rT9sYI/UnRS7TL6bN6T1XqfR+pwZcXqvR3n9N6rDduO8PrMGSseXFmmqpm8GWHFpov5Dh4uZfzW5vlqlZk4io2TO+p0zle1r7PicjLa+Nq6foujXTXSKqD8hoBpLuCaTwDEZ3cIJf4h/LcOARF+El4mNVMR0ZERPMl6irm643joK5Ino6AA6OdlP4U7L1Gj4xLyNfE5LiSqwxV7aqvMrvHsJx1Mk90GHDEOolnscrNVMb15+I503KE0Caob88pzYnJWNMmORl5x3qWSKyUncbtlpGtXyg8S7k1+bVRTST7CS9giWZXYSANIyXtlhi21z9d9M9P3lzVeWTG45uInWo6n46ZmK6Qrdb5/t0Rodv5toy065x8aTDbL5EfvVYOuAl1zuzlSta+ta+MuOKgZ0dE1JNPWsgTujZt09sbvkrU3P1dnjPTWykP2d6/x/WbZCLQOcdU8o6srwPPg5OuiuE5loP8N5ttEaoDtzaxSzH/ANsRca3/AKfLaR8eM5gx40mXWt6+WReZj6smV3yNakN1W09TmfS+jz+pYq8Zjc9SbyZokZoxLN/omd8dFcZBx8y1qn6HubKvEM8uDEUXf9iiMuXpJY8VM5A62fQEor0r/j7+Deo/5B/knt38Vx+qn2/0/q/T+v8AV+9+65MZkw+0+xeze3ep96/kXu1el+SD1OT2z2b2/wBX6jB6aOf/ADM8Y/RxUZc5Z4fx/Uo6PS61dfyiig1CqbBGwE1BWV4xrWij1VUpElC+67PgbS7L13+d/wAq9z/gv8q/jf8ABf4tin/6S/8AG38K9Z6X231j6f0M+7en939+/iPpv5N/Lv5X6b3PP6U9dg9Tf8m9z9Zn/juaf/G9T7d6LD6HF6W8fqo/8rL8v+2y4sONS4yQfN3kySNLMq+JN5MmRfkSQydE6AkPf/8AlT+c/wAV/kHtvu3pf4t/HKxeo9Zi9n/jD/Jvc89+p97zey/x4x5qv3GOJxei/kfu3t/ofYvT+75vby/T+ow+j9d6S8GPF6rj0ngeDGxxBZSE5IgtJMfMbx8H1apnTIE1ujkeX8+d/pXR/t9H119KrpV1ACv1o1dSp+s1qV6qq2rrGunqv1lkVCUiflpdKBbsAGsdtdNjtz1j79RE/FMWY7Hn4vv0UWF0rXVY3Lp6ce+g/NtizR1JwcT/APW+zHWPWQCPkMY+CJ3PyPFTyhIQJzeLLcs3QpP+K6dukVMjJTcuMkDJ0f73F7ldxF3kNNHp8V4pzUwZKrPkJ5HLynMVO1jq0jUB+2OzqgeAGyCZgH7wLPw4Cupd7NEXgL9ypetrkCnjsmoxM2zF6u52bMgULobcsctHR1JPdRmXF6bJd3jpn0lsyS5Ys4pJa2Bk5A6dyHVa1N0MwxY9swmTFXxbx7qcSLo5YIrZpLdR2FWuwt3M4sGTN6hxZonFXMmP5X41lcdJxMkk5KylTNL991RcHn9SxlsRkQMB+UraukgESC5p9xf/ACWQ9tekfzT3H+Q+x/8AIXvP8Z9IZ/dH/wC8n2T2L3T36cOLJ717r7Z6f+M+we+eo9bn9diWfU+2M4o9LOSMfeT2T0/pPS+oz5HFkyXw+T1fUxtIKJg4hicWSsQOOnt+s76SF00VLU7k9O/5H969T/Av5F7L/GPR+3+k95/lGb/jD2D+P/zD+Sepx4/cfdc9fyX+Oe2e7Z/S+1XkvN6P0HovYfY/W+2/xt9fgxx671GL271NVlnHmy/D5BizTZEQ8zGPHm1dTVXUkzRvWSKrZpuWekqQixo4fgx6ujRUaPRR6aQDHqrIdJr9II9NNQEBvgARp1GaiGD83IQhXuRIdsZA10GPJdTp4iKwk1VBLmkripGi6bpEL1Jfg2oH56p7h7563+K/8N/w3+Q+148fuJ6n+e/zz2n3Q9xvFkfYfU+k9l/iPqPT4P45ljOV7T633r2n3b1fqs3qHEVk9Rgw+s9Imf27t8Qy+qXGjTJE/alrHVuP9FQrS3PhXTaM8ST2egfxb3bB6z/jH/lL2f33Fg9R/GMPu/8AA/cPQ/FTk9z9s/l3q/cfdPavR+p9vx5PQ+sZ9B6z+OV/IMHvE8YzN6j0nsny/NPpseK5+MoAo6VdVPrFHV6ZNH/KmtdMWNwahVhrtp9Img1UyqqYO3pRYvTaOSeHrgv5F7T6n2T1/wD4XrPTZ/Tz6v0Xtfu3tf8A5Py4M2T2X+R+2+j949m9WzkmKuvVe3erxOcnHMucuYqqmK/OWz5k/tKBLgTTrchDar9f07yVuiZsrHNTv87j/lH+TfyT+T/ys9x9/wDaY9oz4v4//GPbvbfQejyuX0WL+J+1fx/2r0f8Wr0GbJVZc3o83s2H09xV5f8AHVuN5ZyY8fAYcWWlm577hyFpTXCH7poruPLBMj1s3t1+ej8P6q/h+lXX6aazQPWKS6QUIJBkrjAS1hWAK6qRIbZYuQsgPLzG4f1j/wAG5p/h/wDwZ/8ARJ/8nX6jLg9V6v8Aj3sv/GftGVDMZL98z17t7viwsRZGfHHofZ5yaor4slVkiisevG/+P/5L757d/GvQZ/Qe7e4Yfbsfrcnofd/R+lz5TDgjPlj1WD1NzjyRifUskyVmmmA+kc/r2P8AnuPL/DP/AKC/+D+0R8ePP/yT/Pfff5N7jV4XDmPR+35sftft6V8Z/gy4vZoyzbkqMk91LzDJ4V/wv6301eg9/wDQuMcPpsntPuOWc9U4G/Teo+LJGTFzUV6a6qjL1iCSPhdfWnh/p/Qp6/Q/qfxvUoFf9z400UhBGjoU09ESW5FRFwHbfrqCq6PTtV6ATAXqJFTmWVY8311Hv/8AB8n/AN93tv8AMfa/VY8d+swxi/k3p/UXuPVemyenrXrcPAw+ptxYvmnKW3WGM9ffdflf3msfpecU/Frox1BGoEy5KjLeSa+NUnzk0Ort4Dr8+tv+Vf8Ain1/tf8AHD/kD+I+h9X7h/DPWelyZPdPQ+mnNl9X/DvW5cUZ83p/UYuvky+xRL16f3Ei69vB9P69liPU+r+JPeveOscs6+OpjHNUTfOXezO3L5uS9LUtnZubYUr4L4qn+oU0np1CodI/2zSR81JpL9Faa9LyhjU9an+0UR+IXnIpkdym+Qra5r3/ANXvNeU5rlrFWMx1RM1u/k3FbHluZtflxxU1YlK+b+45atMvJULDqP6UELN1UVTOUdNqcjUdq0fm+929ZfVXk9RFtVWSa+t7xJ3r6TBOSg+00OMFzIlEPBet9TE7rtO8sUOpeRncY6yecfx72SEtGl0zUk/VfBdCqkD/ALYJ4Pp+0ADM21wdQkEsgeNgOY+pXMaoe4rlbaK3Dr67N3M1tpd1RRudhOg8gwfnNepxGOY+2N+ShkUrWK5ZndaA4euTVb5WfOj83Gb1FZFvIdSXONOb6L5mfkql2+Svtyb8tSso63NVUVDW9V5q9T1xO6kmp507TqJkunT9tr7VFNo2RNkOGSLXdp1yEOokC5CG7yDSOLKL609/XxymtYuvJu1NVVXpQ0nfJTonwzX4pceHkZpqqGv96uyNNUMywjSSf/Am5Nl6qnNWrnX3EanmbdTJOS73SdlcqG+dH2kWtlxaFPsd6nY3zs2Pe0kh62gBPkg6VoixC4sLEH8/Ii5ep9NhLtMSwF9Z5yUdVsvxPM1enkrYhGlFkGukN9fX67OTmzr8q3kmDHc3NY3Q31QSaGZ3HarHm/6aJH7FPOyn0hnWKNUbW76Ck5/wGxRWuQ+pWvszlOkp9DhkrHUrFWP7WZnUkfGup3KqaloNpq5dyvVK2azbB9x9RpelmzaR4izwMW5tGtapJea+rMnMmqAA6fO5R86mdgUnRX51X8S9pz++e74MP2x+i9Lkn1Pqs0vEzinTWDHkmHefLrWOHyfbJR/jdo9F7HfrMkdM4fTj98+QfOOUonDFmvlmOuPMwJQIGq9e/jmKfQfD6X0uIxemw4/kmp4jJlyLzWfNlnIR8rjZflvUMuISSYDLqGqmmojObd2Nw8x4vr0um6h6jD5lAIY+tls9I/mPrK9L6Kohxh6nzjnH5q4+NnGZKu0Mk8TdYqhklxXUTY9eNe3Rmyevbl3ZeTJezUkzfbrrY9IzJqe6U353+dh/M/XV6n1ePD81WTokpZgmhklN8c1Ovo13dGRvXcH5z/tmfnL8gyJJh6+NaHRTmA+wA01Xe9H9eSn8OnSfTRYtEvJ2Im2VwTfT6p9XUApZFPIQturn+LXWRPOLPk+KuL4wFNeBystAxRLgx/dE8QULKlx+eifyb0/p/Zf4t/HvQSrm/wDpS+4+pwNSc1668vqMbLjrXyGDmCWbs6sd4mWeW9t9uy+tv2z0U1N5PcPW42JJ+TLVZbqMc5eJkkm63cstTNVcMjMm+/5g9zi/Veqwx8WPB6XHi9t9JiiKxkT6PF/40mOWj65v8pGpRSyom0LnqEnq9KgWAqqIpOwUjvv+utQRTRVWpAAAAQBMnJPlzzfXgeGa9T6im/NVbkeNQWdfrb1Vd08xT5rklPqfne+yehw5p92qU/w+25andswbuZcImpywckzPMOzKdzW04r23BWTDWSY8412NM3cEyVB11VyupUYnTxQUzR6D7Pkr0vtnumX6wXMennJc1dxJJ2NSY5qGJ5yfJ1zSUlQtfm/+EXYzyM4i22ufph+qbsmLyEPrzi2vH801PqPVWJvvKssvWMcpvkZnqheZaQl6UNP51Hsvu1elzYMtNX6f1Xpj0/q8XivOO5xl6lmdxqbkydbla1U0z+aX1GHus06Sn5KaQHJkFeaKSt62OjbwQJX2/KHoLC6wzFi5ypfk0a6JZBTctMM/ULWdJWq/MyAiFBj2mUn+5idYz6gRgi68TtiEnY69A99n03vk482OjH6309c+hy+KxOK91j9NnZN48KyUd1TiKjVZMbWuW9vy5PQe4EeoxZMGec6eomtixaTZAV/kxUuosqvqpLWM1+HePNgpYVchs6Kpx9o+WWZjlmgI2z1TO/M/h5vVVml/8vHPqDHcwXkU9XjJhH4rI6gTzpmp6nvXQrnA+UWNwTgp5gWKW9hoID9UtswxjZgyI9xx2mauj7SzjfopDX2p25Gd1Mi0hzvU39Z1ItSskUJIy/G4lySkUnlvrI1/fVClFXXQmtoPoLy+owReN7+InHlnJo9TjqAqEKvnUtESzqavmfFPdB6q6xwlQ8IxfEPbRL0nlkoNDVhk2j4+y8poHqXqkfiZtYRtfB86pc+MBrt9+Nl5lOST+ta4BdyTOSj9+a/tsoEAqpGFJJql8vmtzq6lxdVHZNM8HjwaqCk5SStzpsmTx441tx8fH/X9M5GSfFfIFUbSTWu+YjRRtDIFVOmjz3PW5OdG4JppJod60d/qvJKfa02Es22++DzBmJLkWEIDG209v5GmRVdUD1FXx5GWczMsfHW5J1qjxP7Z5nroUrjlU7rFVdJOnjJRvnppnh2KxOwkTpNfjErnnuWlMn11dTjfFz3ejWM0a0ft/abJxkY/NaJquyalQn6/9gDcUPBs1puXew02BXEi0R7ZdggVo7hR+n8viNKlx87tp6ouWPu/E8s43uvHJpQd8y0ho/Hcym4qVmRmps2yeSOvO6nUmjn6vOudP5GMm6t0PxRfBYb30V2T4AVnTvxQaE/J4iG/jvieayI0hR+nHJyTzRBzodzsl1+SJvYwssZQjxdHfT1lsllTLQjNjlSSsh9YllTiU3Va+tbl8rP4M3jw4yZWY2c0/wBemf8A13k/roqdiDJO9AsiXTGPHW4arkmpGmStcuSqZ2yy+DdIlcu62pkZ10MlNTZP27+vPfk2vWp5lTQSmjbdkpI7BEcP/VzhHHZX7Q745sdWseZqd8z4niv/AKvepek2I6d90ngNn/zWMWOgtnfeTqQo6gECfHIAV1Ui0AVj19dDjmnLmNrOqWKpk68bea5DHt+nOya+qG2fxjHBAZTnqeShJYadTfPM06k0hp2pR+vxgkgEozHd3TtspALGmMd/4M/y2nGO8wfJrqSf1R/6+R0eK21VC0J3vTzQKPHjx/13Ev8AUoiieKqlen6pP/YCXVA/i8mTRNDU8skigrLpJJ0kvX1FN6rrfP4W6YcmTJVVVSiEfVqR18ghuXXydbOfPk10eoA7nK2xJI5X4o2B0QIVsafNY5+MK53MdOthXU893Z5l3yhKvDvabSqcfYPT2xexhCVX49/T6k/aSNV/Y661+V5Uia0GSbmbaCi9vTWlap6k3rqQ0f6FdigylfoT7bp06AWZ6Pub5J0SG9fvlaBBjmO0YHHEjzodl43/AJ/Ai9OyO6kkhmYMS4zx0ya/yQ1zsmW3w1udzoVHk31fMjGpqjr6/XzTkSq8VXGtr4KR5r8FmYtY38bumVSFlEjRMy+YeaP1pJdrus1WR5ne5eulfOICmdV08tb1HM9rzsea/KJ4n9grBkNA750E2K9Pbm268FW1at+pTJr/ABShKmXo/d8XvzO9L/YZpl55/MxarVTkZINJfJkx0IskJczrp4Tc1SyBNzoZmyNXm+1BcNHXEyHMQ3/vrxWp1qVKGj8iJkaUsj5aTVRPD9OtwBRjdoS+f9aWdFAiNkyF4H538EE6pwBuxZ7Hb25zIGiX4oQOnJQw86o6CYnJWpQn7f8A4nZ/87XV58RGvrdMxeTdi00inkCeDkvyVI8l80US5kibmySpxanb47NZPvLoQrnIpX1XWt7PNN2Qb5RjGxGOZ1MjJRXVTPVdE60umeft+MAkEtJLymmwCxjhaJLgKAN8bB+xlxJA0vGMNGtFvEtT046olFrZ4/bSryv1Nui2JTXWZj71TV/UyAyVOvtNPTyGMnHY6a2zX4vDhF278V3TdfW2WesfNTLW+nWt+AB2NLcrjrrkcbNz9CfF0b2AtMCc+HXUif6H8dAIEzgP94nfxOQJG15/JOOwC5Ba0OUcnIAM5Ik+mu9bBeorUutH/XQzQMxX5HN3ocaBRjdNdPhHtrdMD9VQ1EhknorZlslbxxTv4xZaSQOVtQcXWNpvxSbNIKlheyck6240vrXbrVVUtVZqZquK1SOwGdX+WgcGe30v/wAsME8GWJO0TyMps5J2eDcnRHp+OKJ+Shodcl3MHy9QnJua52eIP6o6/M658PJX/rmiVOHxNVk/rr6pvXWvJ5H8HU2VJmrGfKu/sVUz/pxUOzVOyE6GgY2fkXrFiFua6BBDJTaaOnUPRzS9arW3W9jT9NMQBbgQbOCV7u6ioCyIG2xTswosMoljUTW8mPHjerjH2pRqgIZNv9ra8f01OwTZtDHN1kyyi9rQ7Jt643jnrZQ3uDgPOnZTz+LxYWsx1ezIdyPiAyanj5ODRr+pOzfUzWxSznxlzPFk3My6N49TO9hX9mlY1zQLuUea0D5psRYZgAYHFrical+4sFKCkRuFwTtp2HHqSTzMaq/LB9dadaO3TMqDLSlHnynJ1VPeKkcp/kiHq1OftNT9or7V+5bdibnaqIsyE91QscVujkrww33fQ88vNctfTyO5d8nObqj97CWKZLUcfVXRvT2ymqnnztl3YMBsIpbLmbd2LZisZ2zvfKzJLCiy03HMkpSSeMv7lkK1vELrSifWdDf16hqdZWX6hzzoMCgn2a/dNV9ZATs4frqgZSoaqssh/wDPM/8AWJWtq0L1FKhpF1yaHxNjFonZdlb0bDIGvvtFNbjyroZdrqgYjCHlDfcFjG5EjQ0u3YY3sht+oGW5KgvJeOXGwzCTRePG+clfeqqq2+HU5Jlp/fjM9l4x1ud45Y5eXUv2ZCvr5dXb1AOw1+EsTqMUaSSqt1JWtVMtBRSqqSSVMsG9Kp+a6yP13KkX9XXdfVyzu9CJR0a4OvA1pChSR/yQIEsos4WbC6GQQhssFY5wruzUAPRRWVljNPP3nGUePsQSFVf2cXXjrUrrT5l2TV4ZjojJOpNv2ZqdJ1eyXnmqnezh6JQreUSnhIJipXma3kkAUmlQ39aPK6XVE/g4zJkl1kZ0y5Jpen4+JsZsJmPOyZ8jNTpKVQAGZKXsJxkkBz+dWYc74yZHPi6bnQ9Lk1Q19/8ARXMz56Onf+PyrcaJ1tj9P42MtrVHInOJrit/JsqbWtpv+tX/AGKDQMopydmT5cPmT61HPMbb2ZDVmvA6o2i/qo2/gHfbWvlKZWTlqG7kdaZBitmmWR/q+X8YqqDcBzmIM3yrC7sNGz3zfFlxsFg5bainJ9CY4xb61U1myTfiyaoKStMlfUZPAn4PMYqMopVA3v8ARd2IVrUzL/o80Hifq6CytVM/d5niK5/bjR3NZSWutSLKc8dSyn2/BicQCnP1klSeWZZFqbposU8bFf150/gLoCG5iysBwiH9dIocZ9gLDBzNphHTMmTNuedaOJ0Azj73RRXO/oj99VBCu6Ko/Bxs2M1VSjrqknp+suJa+xK0pqQo3KTXmlylZIV5emRvokOsczNQtKcf9t+ZAINAlZJlX6767+sEcmv/AFtfr9Tok8ulHyaXqVt1MbfZqAdu47/t9Z5CIFlcxoq1hu6x/wBVCp2ETTtni+pmtEDPWv39qTel4ZBqrzfW73PSXvXLEaeTHaoamdhsE7mfyclJj7/p3cy+HJ9Ul6D6syaZivNA6BJ0h8mPk8hTEf1xSzVlGpseuaX/ANhrR5HQFfijwEU1tYRNzjHbSCGcZI3ZAEX3K+ztjJWnX+SdSr1UN+OL/rPE68psGnnfnYU7P6uwMNL4vo1tDJ/rw/d1pkOQKWMd3liK+TnJj5mh5mjHANRqpas8htd1XXbpH8LI/JMpWMJ5qiY0WRobZZp+80OqoH7TWrqF0wCDgFsA2iRuLkTqgXtZXsoH0SgEd9VcusaM1LNgpUH1yWR9qs+ozzXQNJtPMugpqzre51djbyUtBIU2xuNrqgPPM7UVmuqTf+MY1U70vl3lmLPpyN8grsY3opEVM0RxVSci0vLWOf2P96W1BpJm9MzISU5gIsZMOIiA790NKx9r3juwe4AA31aFf6YnXxSbuuY2a1qa2U7VxuymnwCfi28gE8mIEx0qN1lqp/tWR2wnUNTIqM/9Vo8QzBC9beZqm5IKg5hyeFBH6hprd+B1+Bk0EbDR8c9H6aaGXJkpB3qth5DVp4/GTje/JgIJiboOMQtJxA7kKwVrpfoRnTCtVcUCuTmQ3jBdIN/Ucbcv9SXZo5fr+MxsnyKydXWPVaa3evLdHjGVPO9GjomfD+J5zXU/9rlnG/VNQc7W3pQv9WapNlKfYLNkrFE4iBq5I2jP+Smp7q2zbU71T+vH7DSM/iJQnF7Wybk5Wy0mpP04m3YsC1ouND82RySEa5TD0fX/ACjP2pp8g7S/jVqdclefzImoyNSKVROq7/V1Lq73JUFFMs+ZTfk8KpthitEVzjx1uFquraclULzrSFbF2IOqKZkrla8XjyWUU8rNptjKNP8AVKXQ88jLW38VO5MgsyEAxYJ3i0uYegQJf0s/13CMM20zLjoIJv8AsNZKUK3QmSSnGiVo4kWTmzxOtD8TMn6yzX9HfVTirXx7v9RUMvnXj+2tfpLWRHvKyEzUM60TvmcfiegrwyE0b+v905LDbWNO6n/Id9G1DXcalnWMXv7QBPXid7X6gavw+IADQkSfPhJDTBDEfYBMfZXCaA402GUyTkws31XSfX5Fg8FNTf7NzRo0eTor8W842aOP8ksV9XU1kpR+U41IC+BZ0+DWhxFOzSO3SGuk1Io/uaVP9FqQmw/F13d44KmJ1N2vMF80TqepovbT950u+dbdM1buYAO5JGxUO8LlaCfy2BleGXfE76J4bNyLz+/6zVQum2lbLd71opADwaG3Gn3mvqxHQIH9aCqrymjW4N8yHO/xkQ8b6ke2/t/fnmdzq+lnfiQeedpr6ipaNc0VuugqJeCpnmjJP9WfP1/R+9fetIlcO1uIn/7jfaLaVwEl7TB5Ex7IaNayQwajljC5TfiZPuIyutE/ZJpnRQnV/kVbBERAKTjtJAJonVNKFVf3l8nkHVePw9cf5ce/8hRR/wDbea+T6Ph5vX2lN78VjpBOPcrFTtm+TJWjfmOWmt9RoUqTZs3+q/EQ04KE3iLJcn63GmPpghixD4Usr6IKW1yMVjqXxil/1kqkGW60sVtnpJKBm/vBVOxwROQWZJprVT1JpnmTsN01t+kE1rXinX5GXJWor9snxUs1VjXlufPQdGuujWl50tMSVW+pYdnX61kyzzsS1fsUTBIbeR/+fwIHPEBmxnjNwDvoyrTBIZsEl7qLjkas46nJ88U1uJDXmG9TE1Vbeldjo80COny5hxTNbg3D1kvVhEHUNFVr7T4uUqFnqq8zsmOkddeWSqAmd1Mgl2hurWJdeMnKbna/jcbqiutiUE8f0L1xukiXGpfjXmSkl35yqlOL27hgSY88RqsgekhX2BYYtxj9xawzN+p+Z0USmnVC7l1MyGzSGJK/tNan6yfj5xyVa4tjdci01ut6Tr9SvXJutX53vY18SxsfulcLICWzAdWklE1sa5LgJnZypaytVEUnXPI8ump0itNddzo63oJ2oh0cXWtABt+U3jbhjymQUbXftu1OMXjXT+n9L6j13tHoPS4MuLHjz+9Xk9Xl9Xmn0+CP/HwTOGbaji5n5Mjjg7roTFJvU9Dj9h9ukxHqv5L7bhocZkn0/pPcPWsMdHfU4sU5QDW7pU20HlngZ9Rlyelv0hM8xljNhD7E+siZkqikOb0FEBdM+f7VN7P03qHLii04bqZyU1upreskaTJTjFp0VID+0OjxOt0+p6yuoaXgAMlAkzzBsCrZ1YNJA+UixMpxKSP2DM2j0HP6b+KT6D0nov8A6be55n03qvW+pfU+n9qx46uvUY5i8OOc/qfrjx/+PGRZ4bavRVQDrcmD+InNT6j+Q5vM3VOH2/Hskr5eF+RDR5R1LKad9fnNOWchX1jERPnfxzNXj3LHF90D2+AG0cVcvLaM2bUQ946Exlkzufjenu00xaiLoXdJLtJ5x0qqX89RHqZLF2HYfyL21RqIAPppsAbjFIutpMcpSepv1f8AFsIGL03vGaDE42r9R6LHj1Nc7vj09z1Aomi5SmSigaT7r7Jjcji9q9dkkq9fP7nAXjQLmaj02N3Q7H7FLKQIa5fN6j9hiuRTFXLkoPquiB2xvwVuWZSedy1WvyZHIksozzJVV9bSuONU1qQSSZr7eJ8an8Z6ZVL9UENk2YuF9xutI9QwQFaACmEAZpwMK+5t2XqP5Zg9P7V736D2/wBBmw5PevR+g9FOe/UuUw4/R+4+m9wYOvT6TN/4c4Yxz4qtZKbmfFD1P8rv1ORzZ/QJmyzjzZv/AK5TrJ4M1VNRuD1Nu6nnlWYfrI/nI58vcR4eSoFkJO5UlXpedTqqmR8bnZPP5TqqalW7XJrZTmjlOjG/10a3PMqso6aQ/F/bopdSkpyZCA5dht41B6vUQ72IgLaE7jfnXY5P5Li+t5PbcvxuMnV+oKOq63V7xy7meuL85IOK+3LuvP8AKsI5WfRZNcZIEy4orsvvjG/G6xqiRM7ll1VdM1zdZooyCsDjZuaamsr/ALmf7lB1zOjpko/WmqykxHOq0QQ6eoKBnqzU7hFfBTvogKfw9AJAkyCJ7J2Nr9xfWf8Adq5lbKfPjPGurj+T+n3O/RepMmTxveGoibo/x/ZOea7+M2Mlb8Cg/wBL/KvS4s05P/F9S16fPjvGBgTrDU3OS3yNSzUlm5HmdNS74hxipIraZR6j9apcd0fvoNEh52n9aH8PuJmNycrjnoknz9pGu9dx44qh1Tvyoq6umKgaaqYNwgy0JJ8wAtB6ldzuwUH/AIm3g+1tem+8fy/0XvPvfu3u1YPUenr3P3T1vuNzr5LxT7h6nNnyY8lQw3U3lZrI99s/YdSUz+Nfyv232P8Ak3snveH3LP6J9n979u9zr1mH0+d9RhPQeu9L6pcJDrJk5jsibmao/szZP55pWSK5Kl3MosgY24JNL5b21tY18lBKdFV+U6w1bR5SjcHmmXRzj+s+PsjyaQ89H5nV0aKukeivT06qfSaf+0wpEnKO8af96qmoVZBFUbgjGb3L417Z/wAie9+x/wAm/n/85/kH8ftr2H3r+V+/+8e0fJ6evR1XoPXeuzerwj6QN+lKnN18DVmOecff0mzgfV01JJJW3Ebl+vDKDeXy9IpXWtxqqBPxPpMdem9GtWReb/2QQVkxlyE6JJ5ueeqX6munY/irxuWaxl81NtPVC1OjeJJKx0fbUBQIVoFae/4bo09DodPpD/CimgGptAUhkCauSp21sajUT1EAaizgi0c3hBGwjTMHWZqLhUVP/tERM1jbWlmytCTC1qXVbW7OPHz/AJMdbMhMO508szjxpkd8O/qzOmdBMkFNHECvYGOhxdBz1d0BTLW2E8bWftG0WD82FNXesc0VOTHjX9mTJAzbW2rJd+Z0TRPNs/2jpLxTtJyIcqC/uPIJgD+QLwLhX4c6seSidTc5L6OZGcdM7x119Zj46K3AEhu8c9T5uYI7rNqwsprt+tVKa+PbLLQrRzOv7+RFKuL5WcnfJK1IVLTvXRZNEyNTPPcB1SvJWwvelysYpxwM1VvdsJU1c8pdV5QRMtJSASBMVTxdWY7PtEcXIA0UlvDVIamygojZ2MSxrp/TxOscSxOSSblKBcM/rHkq932nhnQMm+u58e2/8Ue3Z/Uev9/9xwer9J6D2r2X+FfyH1P8i9V6nPkw+nx+ze5ekj2D/wAbAQOTN7h6713unpPb/bfTvOHL6jPE5MhjjLlx+Qfx/wBr9x999w9H7R7P6T1HuXuPrYuMHpfSNX6i+JvJlz3WT6YvT+l9Piy5/UesyZJw+n9Njy5smbHgxXl/O29N/LMf8e/i381/hvpvV4vXeq/kvrP4x6f13uXoZjN7XPt/8b9R7l7j632/F6msRfqYz+55Pa/U/wDkekT0nqP/AKWRcOeax5fz53+pmqvp19HpGk9SogVUw6OmagKisEUsponeBro6RHyk2ZUASEQykouMnGrf8n9f/Ecvov4z7V/GsXqc9e34PcPdvdvXe5ejfReqy+v9x9TPHpMmHFkzYs2D0fpPTYsWH1GP4JuslTlLcQXxV4lrn5J0J6iSWQmOd/CvhoVNQJPmgoHn83HvvqPY8vu+D0vsTGf0XtHsftHtR7hjxZfRf/Tj1mH085PcvdK9Pm1kjDk9d6r1GPC7qzBiwfLHy47mtS46NlZm6qqyFTtDFfTRd45NE6+TgklFaCqZ/MulQaejSvUQQT6q/wARNU/Nf2sLcaKriokj3pH8gI5fbT8F+nvtnEiRkck5CRHr+/LZk3LfE9vUZPrRWop2GEyzkxvWsBjZxxPyXc5D5JnJfNJjyFY+qf1jK6J0uqThSxmtlrTGIYxjcILkx3WprkpKl0NWFRI/lzHdYIxF7cueZ9OdXbBF81Oe6bmJ29couuaoEmisOqSBEPH5M/rnxrSmpD5eHJaiACMWv90eg9M3kdXJizY646ePhz44mXITeVW9tBWOv8eQqYTG/b86CJq8Fvxd4zGfRxzcZdfJLmue6ZsnbPQTVWbPkqE5v0ocVNw4qm9K2TjysRTaza1Tnbdgc5N8HNN0dO1i9PgMrcPyTufvebguaQlgGfg05H60SW1jKBHzOpUmw9sCVxCvjbV0o1jNJvcIkgGwFiWjsgZn2P8Al38n9l/jv8o/hfr/AHb2avf/AOW4v4R/HMXvXqqisfpPSZ/c/wCJ36T2o9v9HWKf/N9x9N7L6j2z/wCmeT1ozHrvTyGLLhwy5PnzBkxZcONwV/gJx5JLyRkcuNN3sSJsGuLnHU47ytcyYqOfXv8AlOMGf+WfxX1uVxZs/rf4h/x17i5s3yfcyew+2+l+OLu6cnXBMXIhxfx6/wAeN8dPRf8Agl+iv5C/Rep9Z6fJ3kMcf/W3qc8fFyE3EszIHxRVEs3imgfzn+B6XTp+HpqBqNVdFJIqqYQNRVNMoAmwFjq+pUfUaSjS0DY2CZcjcKVzqfVZVxO5eZsmknkrRk/yZSvuSRTN5S5ULE1G67r/AI4/+l/q/av+UPavcfXz6L0vq/4X6D3fHianLTn/AI//AC/+O+4U4MWOxrJg9mze8fIViy48Ppcmas3Pp/kr88/9Xk+M+TmL6xklB0arqYzZLqjnIPnf9jpoKV/Ot/hn8Zw5/Y/5R/yD/IPW+r9u/h/8TnF7N6ifQPp59f8Ayv8Ak/8AIPSeuj23+E+2zSRGL3DB6T1fuXv3rMk5Y9r9j9FnyuLN671Htfpsr+JFH9tVk0vqdIUen8R6n9yn0U00lkklADlmLOgkVMSRScND0t9gJ34Z1H8y/l/8f/nPpfYPXex+zH8a9P8Axz2rN/FsXtM+r9V7kT6DD6zJ63231Vevzkuaskeqz+nrBkrJ8XwSyDm8cH6T09+4er9L6T00Feq9Xlw+j9L6cho9R6j1GXHjxBjmm28l3JFSVdVVQBTFuv8AR1hIj08Ys3tXop9x9R6j1CepyeuyHps2SXHePFljHXqT08V8NPQeoZ7m8dORr6M/4f8A4F632z/n7/j72D33JGXFg959t/keL1XpJn1PpPdvZPT+1P8AKvavc/RGQK9T7b7r6P0vps+PrBjccZbxZcOH1M5sODp+I/tf074Hq+mqr/p9Dq9eiiouoimkGoMu5JBG1Q21NAPW6lEMmqikkAQYkcFT2GvYf/o6sEfxb/j/AP4e/wCPvQ0X6f8AjPsmL0Wcg3M+o9Bix+35s2OOMHWT1XqcXq8+XrFU1fqsdaMmT1M5fiP/AIgrN7jk/knteLJHp69R7Pljq6gj1FYLx5ZmG5q6yZEmBllyNkdy2U/XX/8AMHz5cnuv8NM/qDIT7FPwyOPjHfqPUZ8pV1jx/HjoiWsuKqyVF5M+fuvlqn4Q/wCLvdq9t/kPWLKxkoqW+t1J3PyElTz8NY5syhOpmN/Qx9/m3/pbp1dX/wBOdOqr8fVHV6jNM+qrqVVMeSO6i+q+KrNPxlNOB6QKRGKRJ5ACt99ft5/w5/JsvqP4n6H29xZ8ke8ei9BMnzVU5smX0OX0PrseXD6jD8Vej16f1AE4Lky3h+SMvF4a/KH+ee0Tg/m/uvsvy4fbPUz/ACj1fs1f+QWek9PL7hfp8fqMs1/kwROU5denjiYsxYoopfvj/hf3L1P/AN7n8evD/wDXdYH3L2aKzRm7ws+548kZ/S3my7LMPrRxemjVXRXeOMeSrPkz/wCin9s9R7F/yd736zHTX/03xe2/yH0v/wBa8ZMWTJhirqGmcesWbHmi3FN43NkmlyPeT8+X/oIHw39d/qnwoBp/uiuqjHz9PqbJMtnYAa6Piia+h0qiCqED+EQhZBmYuU2Xrwj+Z/wL+Z/xLLR757J6vB6eYcce54evXe1+pJa1eL1npS8A2TWXjK4cnGnJ6eYrJJ5Ln9Pkdkz21UZCnE1zNvPJQhTAz/jjxvzPjafqF/Dv5Hl91i4y1fq8Xuftnp/fcNepy4/S+jr0/q/Qbz+jxYa+X0+TMZqY9O/BeJzzmt7mHH+R/J/+O/8Ajj33D6fJ7l/GfZJ9bn+CcfqfZvk9oH58WXm/U+p9F8Pp4yzmi6yTnwVWZ1fb8Vd/T9D/ANQVfC9T+x8V8MWKvx9Jn1AKfSSA4lEyxrkq+DHUVVBq9JTpqzaxGV5iM6/LivRXVUOEpactNx5yzNSaqapbSt+J11zyc+X81vq/T3QvxUBYXycd5Ao6yPWwnx0nkkpZuZe/u/8Alf8Aw9/A/SXc+1ZvfcU48V948nqvS5YcU5bmvjvLhjJk45MSxeXFnyXmld4rMfj+X/jv+L/JnrJ7h7vePDmcamP0Pp3nGjef47gbJqdDuqjLbFPVQT9H8P8A1b4b4jpiqgdQDmlVNWi7ifIU6wr+Ero+UEE8EvkWzLM9xJ18y36TLwLE6uy+oiaQo6pqmkr4zzW1WdKlTX4M+ks1Di1VYV7Zck5bt2VyPPyu5NpolX6Soe/er/i38W9J7dl9TNe4ZPV46r05g9TlxyTOtmWmMchBw3kmkpozMYfjMdfnNei9N6T0tZfVYfSYmoLj0zcFuPJBNmSWq+MwxzN9X5SlRl5nrp61NYdIMEAggQfl5L+lpxrnPSWw4bQAAYub9i/GvM/T+2eoIWMF1AWuWsdYecpMtd1fA8yfZOkqdk8gLX0mPFw5rn1GQMWSSSWRlRmkJa88ji53d7Rfqnae5+qzZMH2wMpncdcZKx/JclFZPi2jNUhSPxp8eJkn5Lnz31WfJ6mt/G1/lI1G5i0a7dK11TaFu9nMp0C7gkhlNgRbCmXgE3WNKr005J+3+NyJOBFnOt3l9akwE8Y8e8KcVOvCTc6qpjifBkPtPlrr41er9q9R6f03tHrvWmasfqM0/DMsU5cXyzHRc4344xM93W/kp11r4zivO8N/IyMBI44t4bKma1uoHXKCVk1/d/SNFdd6j104Pa2K9POPTMEThomqnEjkxhX+K6KXpCgx608jUmn1ATBIJDuAWPHCF50UVEk1eoQHGIKknAi2w1wPvmScvr7/APuVrso1aVSlIK21T2AFMAvYc2PanLjiqmdY82QkqTqsc6hLjScTEFP3mnVVQMDNafNl/wDI9T6jLk+3TUEafqfIaqfrHMn2+zL4KdD4/Ot/jvpfl9RjbrGTi05CxIr42b0SkxltFNzRXjJKFVOnSgSVE+0H6j9hrOma7G4mIm4na32wPaP4F6Wq999P63LiMfpPZPSeo9x9SZah/wAnp8LOKnHkLkzf+XnxpHcuXwxU1JMeH/8AI3uT633bJNWZG81ZFipg1dZax3XBW6R6ybqetSm3Ft9t9t9a+z/xn+Q+7vqTHfum/bfRWYDZ6X0sXlzGIcfUY8l5MeOkvLJ8eWajcifNtleu91y5aunG3cnQ5aKclGPGuv3K6GQlDUIpvmodfV63UgALp0yHC9T4xHD1v8RV6aBTLq9JjkK1wPca3XosE4vbVqWdQRknd/2Zd3UDNPIw3WwSOGUPHW+ikw+w+quUwlYZmpv+9rJLWLFv/Iq4p+60UVGqK1OtyzJjj0wzDXxYLZxvEedl5K2TTRJNWQaG1nbXWx9/z/8Ahe1YPRkkVnmS8cTz/jjChW5aZptrbUgDNVKOnpqP4aQ98OMf8Y/TUUqkN/4xzCl7bH7a849SYqz5506C570TNIhuxrpm1BDU2zpO+WuazVWHNuJRnKo/bcvWxmtGpqgmNmnzuT9HYVGG+tia7SuZp+TmD46DdOlAddIa3uROY9yxzUlnG8ZwjTLRLqittPfZOig61qjrT+ZVCETnF7hTuzM44GuSuMWPaHnPgAJb66H0+fB6705dUR6rEaVnr5Uk3C9VZkao8+CWR3tL/Mqr/wDs2NsnJM/0vroGVpycmnSlJsqftPc2/nPe2+rPS+oYqbZzF4uV1PVSc3rqdFIbK86KNlFRW+PUz8ddEtd1jpYFMlk7WlCg8hU7Z+kEnNv4iFiL+YibvO/kaBUECAYv9IDz3ZMrU36z/wCljh9aUuNqMPqscUTv09Q9TYEhlDb99rz4KHj86TJffOSJ3PqJ6w3/AO365Z/x5Bi9QE6+x3XORqXmSDi/ccmTP6W8ERxyBkoOTJcLpSml6qo3cTuts6xhVfnSelxvp/R+mw5csmXD6TFjbyVfU/V39jg3FeJNTyRkKfAvL1AAaagCDOBI+VYne0PbTFyOIsP98LJ31wNEMwfZe46v+skpOum/Otn7mReU56BYOU5655Z1UyBbDIap6q2jYMylJws0n4c1zOnW9zIsnXkxk19tNAy60b+vIHka9VUqh0F1BbKMU0M/5NxuN7fBr/4+xX59mKrMYFuwG8+ynQGB4S2gbXsfftqfvdbYqZ5qtNvV7J6N3rcjs3M66TH11u/ySIqddATM11bvcwCYxZoaR0koJqa8h+BTS7u3Qa8JriNCVclbfKU1qfG6PIfhCQLi3/dOb/pNVoEfEgMciieJ6m11+Bu+3cEKQAPztjOh+0SPGBK9+Y0TWO3J0cpJQ+JnJWhWuloXZ48+YTQyP4wo+KPIITrp6ya1E80uqmaGudzv+2w63+BAvX9aFoK+M6IrQrXN/Q8iA/bYeetFl64xu5D6+QGajSzVVKteQl341pr7efywfIgG42v2tK8zo4jgTj7DG3drRwTXhokbivtyzl1wxPVbl10CyB5CWV/K2a1yb3OjjHRzUx34mckvXgx8zqj9CzyLr8kJrHYVx9l2smSamNc8kNcrqXyL4lB1+TjxvEa+3MlGzagG4XJ5qigCUPsv+p0yT+EBd4wFwRfKRpcyNHbx9Ft/Mi2mzzVBkl80AzOpuwiAurfJZX95d+HZ1IItclKzK1yLt+p/T/JpGTnew+o0Bt8ZdM5PG8s5K+l7kuGk5lybo39V5/14Zd/VOZj/AC1dBsSRlck01IJpPrvZVfU67R61+BKvBtCl5iJxeIvdk8foHt5xN/OoWXxkrdTcyVJ9dymm6oRK3b3PldnJ4fw/j4Lcb9Vn/tuYLBAqdASz9Z4eXy6KdjOOmtdHlnMUj/XXTj7o3S+JgJ3+yWKE/CiorJzj3GSmmu9knk6kpUvVASVOklnX1H8qlQ/Bm7tmL2PebA3/ACj/AFnPto63I82ZJbUpnGVjqpli25pJ1Us63zsXHuKD8XjrzkgK+1uldKtQM1WpeH/5mQHZ4ZUw65pl6N1/tmpxs/8A1TyUjzJEzp6H6nWompLx+R1FwvDUjUQFUrtValo0vL/Z/A3CMmPBQ375M7YAz33/AD/nvqxWW6R5f1OEGU1QBN7aD/7fnXXK661+VkToDz8zM3Uk7F2ldH2iU8sySu4da3L9t4/l4NhzewlNSPyJso8SBTWt9a3Oq/Bm8uXBFFRuE+taKOZk/wArQ2taCRdG56Sksq6a3AWId9veY20d9rfzvD9jbUfJUVOKgur1MV0bo6xzz26mH/c+NpWnhfJYyrru4cibgHwDBL5CZp5Jpl3u0mU6j8Dnoxp2crfTey9fVg3/AKyAMiDYJYeUfvcPU0k5QVHpGSeshddp48V2KgUVU+apbyUUJ7GYXvph5kC3lf6mN29CZN1jSZjnQmXzVJU6qSqd8lLj/T4p53j0zijEx3fmbzZLmvqWE9XM1Oz6V1515Xrhk1IWQio+NXzMxuDiSyeZbdTTrfmjnekf11+T8mOXDjl/pET2QMFITLbQl9bptmRX7ApW6cysKMumI2px3sjoglHgHtEBC62L/M4zF/UmoA/9iAOpCcX2quVVmqAegOZqZVWbLN1j5zXCgUJNyyM67YWmqr6/Z2z2V53+WGHGS463WhTgCb2BkH6nlmRf20yPiUa3xyV2V9qkftP2+WkCpp4hGiZmnw1uZ0L0y0hckeoyDamOxDyjd3SYMTyURMRj85Dzo/kj43LxxLM4vP2adH+TTVajXQZH/wCpZPGlHH1atyyRHET/AK3IR0lJS+WZrX2oUmdfjcWE55m/kOWzo2k65ccXQT27HiJJrbQTT+G5MUkv/bU45SGQr68UtuvP3nc+Xi+d76bFJiolekhqPmQUY2V3SNUB7bX2vwfcqzjQSuQm41oZa+x1fJ9r5rtqfMutm3c2INfjrKt2c42dVvWsd3j86noqq72M756lJ1oFmK+OJJ+PxFbYmtMXJ0tQT9j6x519aJ1ofxM1knrmXLjMhOOqaLksnUUdC497Fnx1rSiy3ZNsh/a24PaO0aYi9yBbkjafcdtN3UicamrMfVw7mkhcnTWjEc7lTx5JxnDtWQvVtdNOVlybZ2VrRVaOo8HmJCpUPI0ZN5TzqrmaMd9N7IamhnfMzr+pevq6DVF7dlZOfDj/AK49E7onRc3ytyeTS6Wf96d/hUkwFYTF0gBYE4kuxM6ZQ7MD2RQxaxgw2RqrD8J5JSq+iPTIzuOqEJJ5/ry8ydTOqd2ZpSfrP7+JeeqcgiZNt00//vCV7fMIL+KmDl1kYR+eVXTBpiBvqaoo0BKsL5mnTjE66nJZSmR7rGl4/C42o1Vs7Axvg7Z+oulSxlhWSOEyJAiLIwzqGFBgRAuDBKU/LP230/H8bGk199nWumkOpfqNy0nOg3/X96/JkxBW8Xj5H9oaBkmWn+8bfFcydfWdO2kNAEE0ffHitiNV9RdkO2f39tseRnfIV+Zl1zjV1Szi8b5fI7yWr+qmipTTI7F01YrpSAt+K8wvc72AnQ2WJyJv5geYgXzpw4pKx87JyVNZWWA6+sR09DAdb1JoitfqRAhkEkufEzo3xK6xtXtep1Ryy/8AV5p/cOSpshJ22M5AJmeua80/RXVatmhZ8v8AtfM4unqWvtNB3L+v646E5ZfLzKqAeED8perbvYAIBAT3s83Y1YmL+eReGAk82AUjQXNUlTTWSqixmjVRk1qNkaoGfG1xV5doJMpNbMgzrJtZkMewkeouuq634oRo/YVpTMheO6tmMZLE49VWSbOdVA/cl2TNb0LYRvb+VjL010JlH4lBkroDnu3bVKvYfYP9M7WTTSINyL27rmyQYS20yQTvd2yR99gA/wDHhmNpP/WvN8z10MeBno8ARztuWuXS70n5OTHeTRDLlx7r6sw1E6qrNC0tc60+RMWpk3+Dhp7VnzPOKZeq+h8U/LP23dG9JMGtzKaL/F7n5LydWlVU1YpxTWi5/qGpAdVrZYb2cz6wg5s/sMT2l3bGoNSxEfzBN+XcIrTToY1KG8crVDFZJqdGsh+6X7KG6WPG9ic9Ob6kVrvH0BQWK7ZXquda0JECMo+H8lcbWLF8rJVfbJyyVMMvLSVTbfIET5Rj+zT+Z3VUck6njFP+PSVVO8nHf6eHV0Vk3uk+vLFVbil8yVjiHsvAWkagSgHgEC+AIGCJ+i1nlRbYoqY7J+tvg/ydlJvnfSVuNj9j8xWaSnum+Std76PsVd8zc6KZo66D+nXWiieB/wAhkmuwbYu8ZVT4q3UmtBwedM1irycrLldRzKBku6POSiY0Dalf6aRmn/TP0GoADYNgGHglDHfHOqBJAYAENcEWtY3MD21O6/U85QoICuqmG/CX4+JmxNcEyugXShWvk+S8qQFs4+Ogy9hrbEk1ILNBVJ1UG6nG5VFZMdFeeZX94401v44BZod9TK/1U3RXP5Y6K+uWOI3z5jUxeg7Jm6uad7lDwmmWphZAYiUsmSw7GREMmYgxoBf/AMSFBt4uRC7nSJ8TjDJqd42WWSalWQup1q7+gyeNC+Te7FFXwmaosnGGqnhOvOPzqq06Dei9M+JrxWmsVdLeq0r3DN+NXM49lTqbf+syIWePq/lh3ziujr5JxSWMhM+OekOlGacngTksep80F4j/AC2su1N0gA7aDVF8C0LeXtsFY6jMXP2mPmifjl56n7y7MiDX71tqwnrympdrnmqpm/j0LFXBPc+VHXSrRyCBzudycozNepkGtbmH7u5kmWcl5IeqEHfWzz1WvH4jG5cmXJDqZxOSuvP7nn/dLdy07CdFNatmh/FVUAVSyWLgoSDJExaZ0jXMRaZe198Djzq1NERGNf8A48/3X5dBV5U0c0MeTYT/AFCdVMxNfrQBt3W+/M0A1KNPgEenWnTo/EZZ4vqcw/J96f7GOgV86+OEnHM8SUUq7BdHNsb4tvsvJI80SanTLLJF7HUhWjydbdMVJggoEZZxCwvrxgFmlAUGEmYN8uxEpkHU1lI41j/qTAk1JuvI39h8uy/Crrx/alGSMfw7rql+Oi9l+VjcL51jk7B5X9a0ePwoMVNEVy7a2/TekTGrvrdUup8aKN74/MtmZWSTpmYqhvmcj1jtrZwRc+A1/quH+v4iSnDSAwLQEhxfvyWEjxsUCtmLXP0AK4lhmQlmqmupWuZ3PPV+OCU1/U58VIUfjS8hktUJk1RzoOCVyTIp9qa1kXX63LO5UR9ayPTfyISpNHNEMMGyZvZM6jcjXhWk/H4et/V5uZVtNbAmeWq1t3IFp5Nh99CgUQLfWITVvFjaw09yLoDkyBb34DCkawx8zjlyR1loqfMqY2TkyKJov6ss/uqNmw/GlXi0xO6/x47SHbVPmzyG3l3Vb3RyDjHS5n/NeT5N4eOkaoQ3O8cbNfSp/ePRpQ2ZNBURRNbTnGGmKrbDOl2v0501SDwP6Btb/wAkflQPYgWNg5Zd+U0wLvcRutmnviDGSyuOuZMXbFEijj3JQUWvXX9tUyz/AF1/sQKx1QAV1IJMO+sRtZWWn77jR0FRz4EVKHqdzVw8/GyEzU/Xp+vSsrUyNC/uP2yuYoNM1kp8b6eyudFOIyeNrvxoQZvWlQRILYJEYSswGPyOTTOkC+HJ+UY7oTneE5RRbylHgtxyijX154qqeqmk48T00kzIzpgmMIfFJH2nt3oi6PJflmoWRmedT+jX6F1OSo1Awtzhq129CW5qGaYNzzVP2JEJ8tfg3LjMePeNp+KGkdd+Xu72r2df6VDaf7/Cxtb8wIvxx5vqqbbIIgnMMA79yvqAZOLHtb8vnpGn41N4wHwnP6kJ/wBj5dR6a2myo+2/jlfEwpBMPfnXh1RpX6mtPU/5HxR3vI45oDf2YoKqpJodOuDp2aSlmlmQxz952SmPrhT5PGqqqQoddbftzIaEZ/BohoRYgcZLxsxpwPT5243CBt2HC0+8lFTqYPjx86ZOauH+3lau9PhA3Vpvbv8AAxvyX1ctc1qF2CjPMPyVr7J/YSq1pStJBOG6+xTuy+2hnyyGOrfqzuv+po1c/wDUAmzF1uZX5UnZT/oJKrRuOf14XmUDYlI+wE/WJ8COfcIBnG/tHuckZtfTQrOc3L9X/TWpjHMTeKrs39tzyn9mZg+xNfljG/HFdGgak8GwrmYnq+QVqdVyeGjU1sUFK10VnKpmLkpGcpLKU8ykO9yGw3XTQ6dcx1jclNHE0M1jv7f/AGGW2ZHqfLO906PEkUZVkp3MtgWk+4TW3kkFQEuSnubG6sFEy9tWylmGj4+Lx7px7MldHlfOpS3TWipmtz4ndzQXkO56qZdMvHPJuNozro5nyDRW9a0a6GU/uywcV1pXiortm+utTQT5KrQUT43ZxVkpq6bal+P5fIs6mRStWQcFDIfuZQubfzn6lJIjJcBhxFjBP8jQMIwb5mGMlz9u+rtGM4+RKt55RiJm61G7ALknlVd2sn9JlW/izfEROM19ICtfU+6RdO4mlBXxt2p43+a6vl1jIesdETVB4SkrouqfKzReVD7PJ1/kFkX9zf6mWRqjiqmwget9SbPsSTT9FEX887qUpuzIBIbgA4ZTjGLzqqYvJxJi08yd1FnqxWfRU8pWPJtTU1fHS1W+llxum3c0z5CZH8y/Us82HjKxcV2tROQNTlKbCMXkBXn/AO7lo/F5ly7xZpu4nJij5J1NY5Z52LqcuNoryzMmt67FamX0ubCVkwT8+Ld41m/NBPe8kzNMseCqHk1LLrmXjNApkBvA8S7jG0C5GkYZ7AhgyDT37M5tpt+ojGlDt+Tfnq6ndbFyS+Z/9gT51W9TrwUMzj6UuDHlqcp2JqmhvH1NMv7KolYSLSxqfxFOampyRJ0dffRRoAgqmHc14DWxQijJ0/lbJfX61IVHUg1Kb5p5O6MXgno1s1P6D8CvSGyN9/w3En2lH3ioxIN+ZtcB/Qjdau1miGacPyNW87qyvIc6rWscO1n96SUEjlp5cg9xut/InyaootUDe6eTexlESv67bYpijYsMydlNF0x+48lOikTfN6nnYaWMfHVtS1oUWNz1JO0Fmux3y7HrmQ2G5QPsrEBIWDFhaLXxqSQezEA4CXs76LJVYpmgLlvoZl3jvJOlrJudk6emt6+tJzXiFtqZ8RTjK5+TzfLLqhlgvKm9GtRrzLQC7srFqm3RwzxRvdSa1Lp2qt/vc0/2H8jmkJrJG2IZ5mZx8784hTsaFdKClDQ6PyfSIH/G548qykQ1mdGy9zMO58Lvqxc4XbU0S/5F2bk0FRJk53jaNf45A1Wq78CMvSRIMzUxE0HyfV3U92lEs6GtSJH+ylAqpGIHfPJaRqLYvnhr+19b19Q6Th+w/lnF6P1GelqZx43oG1kmXm9TjuftsaTXO/J/ZU0INQQZRFJRRUSTuD+mdNOE+38/mdVbWuIg6ZQPjlHIT9Wdg9XfZuv6p13vk/N76T2yvTTPq8pNZMiGPAUdY3JIx1tnnJHISO9b60wziLXpMEeiyxUEXXJMeoyc1evGkY2SSRNNKtD0F42p/LHq7DlaXoJ1VeJ7emmpeePFa2Kb60h+Pp9NVOoO44/xQDspPfuNVRQAyTaw8BSMbIJnbSm3rJ1LequRqnqCrnrJXTIxLVcZArY3jRTf5WnPq0f2UF3PZRf1XLTVf6RGnVb5EeUWZHI/obJuICWw+KTz8h9i5WN1XgAncu3UTWKWtY7m6yUZNdmMyUcld9fJQM1KJWpkmCqNPXSJdpABGbMiLEk78w9UaoBnlTaNrDvHadPxTyyyE18Zflmvk1ezpJRrJ4daNxOvq6B2XJDWLKm5JrAbhJcr5L+Sq86KuTIt75ugsn7IwzxMz8pYncpWkjW6n5dbmhnmSQPO/K7/AA8bksYDXEuIZglpiRmtVT0a6ZyAV0gJW1pR3uomIuQHztYaYLAAnMQrO0SH7MBa2Po+GRyYb+SbmZddixwEJYNSq7qP7kk0bmN7ON/JW4PjKZoMbzumkz/ap0/bkvRSCpL1vTYs16HyH1DfyJa6fk2VXCOt1XLrdM8m/wA3mMuzHvHqoxRk5PE3rz92mmlaAnQ3Kb0onF8QBcyWAYUfKw4G0YWBoEJ8H/8ARBHDmMXAtr6A9i9Ufwv/AIP959+9EuP+T/8AJv8AIPW/wP03rg+P1Htf8G/jXovbfc/5VPpM4fHiv+Qe4e5e1+3+ry+nZf8A6X+g9Z6LKxi9Zki/Eyccg/HMSYP/AE1wSp/Vu589NcUSnTuErSH56X7j6jH67/ir+A4K9STh9j/mn8w9u9dr09sehPe8X8f9x9JmyTHm3Ng9L6yIKtrIekyxM2R1+bX0np/4Z7EY8vt/8V9R/K/cPTVb/wDTP+beszej9jyahcd+k/h/8e9XgyXvJFVjx+7fyL3TF6ijn/wN1cHydPU/sn4jrHpVdXq9Tr9RpMU01emgfMQF6UU+QNdiJ9IpIFIppltEpgIM3Ik7WGkey/x31P8AI/8Ai8969n9F6n3L3X+K/wAyr2X1/p/QYc2f1+T2v+Teg9P7h7ST6f0uPL6v1B6T13t3ucGW5rFir1BhmanJJfb/AMX/APofv+ZP5LhxZ/Q/8cfyfD6f1BTh9d7x6XF/H/QP9KcU+t/kWX2r04YzJ8gFtUSVC45p/NPl/wCXf+ScXpcft/tH8mzfxX23GRMe2fwb0Htn8I9vxZSqSsvpv456H2yst48d/Heb1ObPnyRzF1WMPzk69d7r7heSvc/dPdvV5W8mes/ufuvqvWGf9/Qr1OTK1WSuqKOWiWoqbk54P/8Aof8AUAq6HSpq6hr6Yrpq6hpFSJpIdEto4aGtT/ZAppVdZQCfpBMSjbaBmePbY/8Aodv5X6Izvv38m/4u/ikT/wCThyR/I/8Ak3+KGXFWMijr03tXr/cst46frhrHhfjyvJqrMX5xfqv4V/HPb6ynqf8Alf8A4zisPqM/pV9L7n737l4maicknpP4/kxfCJXGTBa14Yw83RPnvq2bmuMbuhnIPx2Y5d1NFlTTkZZBtU7iqmi4HhfXenJvNUyolWdzj3JzuqPvITjdTjRqOmiZ+vl9H4T4nq11f3viyXjp9IUCSB/l66sz298up1KAPTT0t36iTZHamy77zr1LL6v+Ge32Ffzr2b1dSf8Aj2Yfb/f8j1Na+fDWT0ELirtqaajN4dYJJOdfk/mP8NKvE/yiaXI4Gj2n3DJ/i7Erhw8Bv9UE321WjrR4R7hEy8z0lvVvMDNUa5ujyxMtqElPFIElSaX1BCRyw/0NxJMs6CO70q0/3ABnagprs/8A1TSR83W6hRTJoHqkDFOOxws65/8A3Ff+FFImRMpZedpPd6+x/e/+R/8AjL3v1v8AC/U3/JfU+hw+xfx3+Oeye91k9k9VWX1dex+py4cmT274fT3Bir0lYnHGbDNS4RybGoaXuX8n/hPvvu3unuHpv5l7Rh9P7j7j7j7jhw+q9J7n6bLhn1Xq7yYoQ9tcc3ji4amVxEt1j7vQ/HOXX04588Y6OdRDRovzrq02OvJVLrQP430uesaSfXmbgpRrsXnj/XSbdzr9kmqHT6f9C6XSPTFHX6vpAID9KVVXqLVIsbNR7asfFVH8VNBkP8QMJEX+w3iF9as+xZyq9L/J/wCNZafUfHLXuxgKgosvn1WP0xEH6xWQc5L3OODrXT/zX1/t2T/i/wD4y/hvtHuPofcH038i/nf8v/kGH0frfT+qcXu/u/qfZPY/aj1piZiqfZfYMGb02Nu/8Xq8xjvG58mOfiuvW5ajlDGhAamMdKSA5OqrpvsXQFamaP8A5oZfUZPpXNTJwUx9Ck609En1o3Xa/t/SCOh/odB6nQ6h69R/s9Q9QU1UwavQaQwE/wAXqCUgHMV/7kAGk0/iABMq4I9KuSgMjGdfSPq8WTBjmsnp8k48dY4dYHq6jZqH7D4DXnzGpToKfq//AIv94fVe7/8A0NX8gzUPq/R+t/m//Hvqc1t/Jfpvas+T1fs5kyzOKicPo/5eemxZsmTx6fBGIlx+mkyfmOe5+6YGX03uXrvT/abn4/WZsXLvRCTYNLqSUVHa70V3P8e/5f8A55/GfW+weq9J71frsP8AF/dq969o9v8AdfTx630Hpvcs8YMfq/UGFxxdT6ufSemj1YZZfUGGd/eJt5f6r/Rut8X0Kun0qqKqhR1QH6h6v7nQr6fpgf8AOqko7afw/wAXR06wahUEaSDSBCNJwnAIt3ZevvH/AOj59cP8k9nxkZcWOfb6x4n1G3fPqPcZZxPy1HwRQ4/TVj1CY6xyyDX58Bfwb3K/S/yP0OWYl3fwV/8AOT5Zo6++SSt0huhm2sZcXFVH56X/AM4f87+7f86PtnunvPsntns3untHoP8Aws9ez5M76X3Fzc5q9Vkw+svLl9NlvI5iIjPmNVEYzGR48I/j2dxe6ek+1TWP1eIHpHbcSzrn+v8Abr4zfE34n9HX/wCnvgOt/T/6P8L8H8QBR1ekKhXSCDS/UTcXbdwhBN9L4r4gdT4n+5QXSaqSCiGYB/ny7w9frb/wd7r/AOd7PXpXuT2j3v0/rsrhmCpjP6ZPVVWC7qq3kwM5cuEO53i67mGI/wDos/4nHunsXsP8qljJ6n0vXtPrUJJj0PqYnL6MyuLHinDlwS5sP+aslSwVBW2r87/+h+zd/wAj9b7Xjw53/wA30c5T0+LJ/j9Q+hy4vV1jyzk1cZaw3kKykNY8dFFRjcj+fUX/AChGP1l+3fwj1eC8Hpf5l7N7n6L2zJmquMX8g9sp9T6TBic2DHEYkMnpsVEf+U42Ilksk+G+Lp6nwn/qmjrdO1R9fpAE9OqkDqLdBk5gjXq0EV9FFyABwYBd33T/AD+Ov+OPfY9H/Efaar1Lhv271l+y+r+SsuSscYPUvuHpsnxxlxkYsfpshjmUGsUIYnF8lfntef8Akv8A5nocXqcfp8OUcMz6n0t59ZL/AMVZMvuV+jzZepyN+pw5fT5XInFwZMMDhMfyj7P631PtXun8l/ifqGvT5/XY7yem/wAeSXD7h6DJkiqxyOP/AC5ybj6R3cjv4z5NbQ/lV+s9J6crvBn9uyz6XJ6a8bmw+oMJVZflwXlc2NzZJMd46DAmM+SWmcr9b8X/AEinrVjqD/IjqP8A7alVBQKvkhgcayo6oopFJqSApNN7EIBZuotrvf53/I8XqbiMM4cnpPb5nDGBbxdx6WK/8rJ/4eRyZD53LjvHBX/j90uSGWvUV8/e7evyvxl5MfqRz47jh38fpmWMWH1LhwGYNQ1eOv8AJjmpyrcyxi3vv3qqz4rZjmnJWa4nIMZAupy/+RF/dy7rFjr08VU1qZ1VyMeYeq9ZTVcx8Ub/APFyndx/VprJWNr6FNV97q7hqiZall9T4D4Ojo9IATSwEcIhxmxW0Z1j1eoKj/xF4JyIHLlYGMPfet91PUemzxjycDi+01Px7qZ1XxzXbky05CflKOgqL8VCcfiz4ovO5C72ZMZP25a8bmqpxyzANYt+ehEGUSu4xYkSpjVMaqdg6icFcyVqNjMbf3JSDOtcMZdzdAzbYsxGO888wTdZDa3VOnQ2TM0RRt9Wjp00lAA5VgQUMie12IeOWqqxTSgMsE/KfoIuJExrW++eq9LEGP5KyTWSd8xrJE8aJaPoTp0xCuMGTwxM8nTFTkp/xkunYTV5lOHikvgH763W5OvM0fm29xvrPQ8/Fd6kiNx1lFnILVSc+Z6ArkUNTqs9L6E9Rmw4Ch5TJktOIqYqmntNNWnIiTdHATWP8os1DACldsDkeQHrkqdVVVpMKxZE2SEcZGtj7N6DJ6jJhgiYljDU2kE5amjhqqbftK8rpuNRWmmhf8o9RWKJ9MxtVMtSHG+WflmWmW7Roq2fo9zr7fno/sXosHpPavWe7JBfppcXpqoydXlqYUjEnXx4krtx2mNWWWQ/PIPfvUVfrbaqcs3VXQ18qU21PRJzKCFH6n5DlqshJnT1BVVWKShR8vlBfxb99an/AKfTAQfvsRjyROtV6brupmfFXPpquQ19eKvIMvKfqaqpVlkZ+l69E9n9NkMXxYse8tkelK+OqGrdKPXfeRXHOSZbcqAfVr85j2r23JkyTbqvkky6lmiKTuSdswXJ+sbvfyKUFar1v2SfT+1TPuPrPTGXF7bjv1BHwmTFkzYcb/4t5pplcdZ6W8vWPoGZK1T+a1VCjpmHURACzseCSLbEW0+jSTJgd2QGyeIKu+N6H/JfuNez+2el/jmPJ0+2ekx4861Jz6z1M1m9TeKp4L+TLuZu8c3J/ce7HxH+Penx+o9VkvN3UxXdbZ7pqobN0QOM3r6K1Ro+06Np/N/ec3ufuDN5NuRvL6pxwlXku8ivZQ3I1e8i/wBY8u4fzbfxb0DM4t5IxrBmiyPPJJETdO6pblah5lB7yAb/ADDp/JT6aiyJqO9VSJdhD8W40urWKuqLemlAQMIYUryBzrqvS+0xkuL9QuHBi16rpuL5j/pjaufjk5PkJMgmM3BVDM8Z7j6vD673HLmRnFvWJhCeZyM40hONXKvEblpN0pMnT/yP3HJ6D2s9AWZMnrf3faZY9JMURNJsxm/s4nHqVcszMlycPgwDjGXXDLzSTmKOXlrXmapnmP2tHKj4qj1EuogyPwsQF7uLQFqK6gVSGMkk2MREBABW3CD0TrHeF11GSJHXKTu9dLPJNAfZQ0qyVvTznuU9w3jx1qMvNlhPV1320RLsB11SMknZ4GOlyvxO5ftfINxP+PLVFkzc8yEaHmVrx0ldJ+aL1eWp/TuqSbdUE5HJsWkmcqgUPMhztPKDWSIgchIMj6gfcaxqFQxwO8J453znXMZq+Ops8UajqZb3U6qUodsmtUmr5N87PzfRmvJ6XH6jHzeCpYyvLbGciqZygvNBR/kf7C/uRfzSerhMmpTJF0ZNOqZitI76ZK/X1Ni/0P2Eei9wzegy/JOrw1cmbBkdYM2Pb4uJk/8AnxkNJQafFDBnc2GQcc2CHYDlaxBAJGLbrey4ni23Q1l9OVhvLFuOSbpth6rvzNyvXkrdztUNCeOeiy58uWIQusSNTOOZW8esjBP/ALJ/p1sUxgyBf2Tms9ek9wxVl9EEXFfJeG/rcaDcY9dOSZquZkJ52jUD0XfaM9Z4yekruLxdM38vNmA3CTvn/t4Nh58NTz9sOrSwKlbY8DEAj5YZz41oCWAAC8oFmMLsPzvrlqyXWp5eDnH9evGtadvV6Bo265P3/U/A1WS5x0zjqBrpOeiT+q15Wq6nep61z/aHptY73s5pZ3ZX3mHWui4/b4DdfZL6r6u5RporY76K2Ju4ZlyCtNUarQeN7R1Rv8+wDB9J7qGkO4/KGdMc+e6FuNMn61dNhOSOK3vb/XdYxmBA0zrbQJ+6FTMUzPhOXgdaXTKb8V4rzvWjh8603+TRGTfE5JNtC6I3GqYnrdc6H9BS7k41+Z8nFCEO+Z1z1y/TVNb0JMtB/wBTzr7aQFZUi2bG2+F7aB28bG9+8sas4pZnJ3cNXLfTzYRRKRI0fZdiaCvOjup0rsx9iJ0sS0arSzwVSeB081IUefrLLuZeoT9MK/euKomZaxnjVDWuQSXyJsKoMlTMtZft3YyMt0zeiQqmdm+j971G42602gAIQbJexyv3+7wD/D29xv8AUaKButb2lLs+svAdbV3VV+jT914TryOycEj8XSgVS2TStEhNNtQUPToBmJE4H8rS/tZ66udJtH5Rlx3fh5H6ujXimnxv8s3N8451w/HK11poATGUjVqCiBLJzKs7QEAHLVwAZNIt9ZaXufT+D840lmogmxE1jE2TX+xadeWtuydJ0eK/Dm6mI5SeiI6Bve/tN3Qoo626Wp0s/tYb3J1ikJPj/X1619WerNUU62+Rl8UhuMQ9Vo/qXP3DdaR1Eu5KPLLP/YU+xX5Jk8EZuBDHfZEc40s+OLMRv9h305LNMsUNTy/ICFMs6qUo8k/45n91rwv5m3fBo1j3VBrvIkb3SlVsJBnnepxutbY5m02L5/bXlk4+SK1P+OZE2ymv0fvYOTEtSo3qJ+s65Jne8bk89dSGjb+v1+tWbMY8/l4/yYeBo/n76ZcVdClq1NQ08TUUyaNq/axn/wC7N7/+q/B7Gz5JCMfk8Hi5IAe3dR9eT+u/MhKL+YZdR3Rx9SN+GpNGqrdFAB4o8mtOuH8iMuJqvCJCV1PPyUI/2vdDvcn6p5AlNU0rF8l8cX/gk6Yx/Ppntpzc5EZxuzmXGx/Z1ooTsCN/1s1Mj0ExOlW8HNvNGWZD7QGjmat6neOk11yrzpNRT+OimervJPGSKmBfPeoDJSEcVTzLdeZlU/b+BkqX4zraTG6ZWfl66m7fPSfaquTfj96/VYBkEMYF8Im6527aDO4PfCj2f0B0eMxyUsN3VVOtKnR+5oJ5jY7pFPLyzrmPkLYon+rjxs3Na+TZ9rWa3Jzqt6RFoPqsxWQtZNjlmTJ51KsUbd8fGUKclztdTz8gFU5cXLjY1VSUn1mcjbXW5+l+Jk1zTJ9T/UoJASF2FDhJ77CE93oMDvxc7SsTdafCNOTNR9YdQglVPOqjrX66Uqmq3/q9bFGDI/IzlnXVsz4q99ToD9RRP7Z1jmdBpun8bixMB5PCZYetjM6QV25FBoknaDGv9SWLd56diYooY6YlCZaU3vivE8i7dy8utWFUhURL3BxNz2ixGbBCC8LsMW/K9zgarZMM/JBeT6a+Sqqf2LP+K8g1PnTon+r0eFnba/yTMdzj+pU+Am5OUO631VUo9alJPH6/DyXLr4sM/wCp2ztKrmyyWjUy+eq0sa2anf4iTbR9l6uu/wClOpl+Pqh68+HUgu+dOqKHBub3iGOeYmm2qA5lhZVuJ8XcGDp3y4voKAMH0CY39DhrbzVf/a/+dZPsD+RktL1o0MY5+tV5AMeRvel8c96NAukXqvGOYuLAnmayJeif7joGJbR8x/ryCa0fj46tyVQ5PNPTOmYGSaltXk0k/wCx/TsaKFRIRCJWDAj6z3Bup1V8qQrcftbYMC+orM4pDrrep7Df9w11WiSN/Jr6/XSeTb+K6u/9Um/iE61X61VPL1zra6OddmnyWdzyLPTZMksS18rr48nYsG1Q/Scp+vKyJYyD1DV45qm4xvVVQ/49Vz3X6xlH201Q49TYiSA4Czb/AH5gAnSWD+n69rYBs9BU6cfnHSTNOk5yY9Rer3um7dichZ4/sbcbyZcokjL/AI53OolTU5Jd0wdFPWvqHmVp/CIcsC346FmqJpAnqeXeo8hMwkv2nU9b/FhXyLUzStYxqE5poCsny1pVeR8145ZEemSY5SYbEQx2jkYAmTZmaYPgz3G/1GDo0J0pTv8Aw2Bf/wAFGSaSeCvI8n0fOmhAjmS6qWu6fvN0svhcazASDTVH7h1YJ9fxZWaD618p1JPybpj6mtZYWTlPIaJDrkK/MxtfNcUnNd1/lKInbzKWpO1GYqdF7Z8VpXSgQ72apC7X5QAPfT+UEdgOBaftb8QzD1Ofc5flPPOTlBok/Vd9T4oERtPG0o11vJu8hk74bhfuyfHWP6iBV/t+R/rv9+a6lEs3zpsBfj6rcqAPiuR+1Ph7o/e+hP1UoYx9dtXeT5MYHTX16ca6lld7YITwi6qQPUaSSjMm0EojdgKwNvYEja+Ld1MSx9NtWnIq0DrzhPq1VZF2UNVVHV78n2BosNU/kue6w3igZya6XdLTDHbII1kkp3RyJ4uCfxU/+vvJkMmS5b2TFkjJRyxpAZ3bRvzo6UApWaL3NNyV1yeLV1Xca1Aml1vodSr4oEmAwCJgOQluDIWO2qI2zb289yTmWIbTJWbHJoxm4UjQ1zHi2UuyfIIUuujzQUCRWhkit4hpjk/aH97r63yj0mnwNGyvwRuEB+SKyTXfT/sfpWSnnzplkjTuWdFc/hJNHi2edUW1yTC6rGMSHI6dFfH4Y2bSUw8tXMbWwJwN5kPQfsOSMWwtswjfSwxuYq5p+9eVfNdASlk9T41ua0mzZrf4deauWtFKeJSZ71JNVZ943vmjwE8AeH8Rl+TvYzED8bZAdL5N6HqSJlrfJfnX1NDvmjmPlnH5gl5x7dv1arT0WLT1WnWlPrqs2CwwCCGckQwsL2IvuczhWbib/TuV7TocrLnaq5WcZJUTBJYzRO9Coa0yzbsf0TP4VY28YtTric0rUspB4mmjppmpmpXT5OmnoQVVtdUS/bKL4an9mManf2/aY8czX2qaMmly6mZd19rY4IZtJzUf4qyTyTJy0SD4tY0nP4xUm0yiwE+zO2NxfVAooWWwji7xaziRGj3jpXfOrX7fWaHncS10s9a3j1NU7nx9dxjjquZ8y2831JrCBLO5ktPMxISa66XmjleILaKjYUpqQKuZk+7Zu9htoJ60TrvdDBj5sfBWtDrfBkGp1Hm3uDfISv13OgAWKmQbBpNGSO9gW7/mw5ge3bg7goAYXMxOOp/o8zRclVO/7R9H5Jn/ABigaOd6Nb5lVTVZS8N/9OkpZKV/6sIXXJOq/sO6TiqJipxZJNzXJm6K0f7Y1jRppne/EptEg3xy7GRQ7llMtXJVcCA7xELVmN86FBGodMioyQALBi0yCyue7xwiThwj9nYbjzGZ0GBqcWNuVejVf1s/xgdtPjFAhLR5nTp14sYXJWJqgmgca+ZXklZiKE2K10bV/wDuhfysuS8mQtPqX4SiEnxOih6o0rRqk6PFUV+OKyTrkIl1jnUGqWRKf7AO+HwIf6J/tIJ9VLCAU3k+nldrSXfS2+wQJS3sJnUdE3Sbezd76JjNTuFua5ompX/sm60Ls/EV4ua7Yonv+0c5CuqZpjVPYDH/AMx0UglDsk5ZPETKY5TUtzXO76nV1zW525NScp/pZVY344kqpV1Rk56oqwCayc6mSh7klJatnfjTJLRNKioEKCDTEoWzkdpFIVhc7wJceEiymxppWXjHRjWlJ/dAa5Spnm5Id/WsjJu/sVE+SIxyT1t6TnJ1NR1TPMNc7JLmk58+F1o2L+b4MeP7FW3MyvW+WZBu2oCBEYdJK7ND+NnSDSTVY5ydctTVSiPnbqRKE8MhpLfzQEFNkj8UQAgOz984jVU87cCMcZMGEeVrMk5Ip+J21k6Q5YxqFTQxo+2mYE8+FlECMWGZx9ZUGnqutVTjrnmYaIOpfsMm9yMvkhYxiXy97qb30co8nx9VpCnfJOh3zqaBVZMgnL41YQ/qBE5K78s7p1Q+CdIXG/xGCKvA2xaxhbvbRkk2UCZsAb+97N6q1Eh8nU+a+SHpKop/9TqPr9NUyBM85DfmT8v49oUzOTbOOKkaCaJ+Oqunlk/dVxTNcrCyjUy2FTim53jxNFAacrPLHXP+WuZ/QAs0mvEtvEtTH7oYMbBaKPG7mFKoF35Tya0clfkUVA1EAoZfi6ckhf70gMHjFrMRc3+1zBR1t+tfT/GeZN65h67d/pQoAXwyWS/i8d6Ehnu7IK0vwRUjq7KnXg8nKfr+x5MyPyfSdSEbHzG51JzL/wBqU0a0Vzztft+BOPmiQ4LoqjZMT4AjbXma65jZ5dz4dbZI9QXEhAmFNnDZDVlD1NRfhtBYtybHvuA9HJPZ8iAeftJMVcUHkrzTrRX+q0frc/jvl6cjudvU862x/TVCozOzTpdefBe+o1NTtmSp2lfHMFpM/wDyUtVvSm96IKKgfxWOXJZO0/WzXjiXGVLVNNJX1/8Atu5n9i2AiDhqMBd8PaMDTFKRJB/J2B3zv3Gc+e59RWOxo2hro4KY39qeb8rq3VNefD0U35ISpGpCjdUT5Z0Em9nhWZ4JF3EEqFIyuK+tpNRUrXAd82TW4d5EovVf63DFHgpncXjm6eU5rTzPVTrc1Pmpa6+v9mp4K+2q/Ey79psIx39sau2YiH594vIykYj1GbsnFWPUxUTWSQmugDuvt5l1PdfW6eWq7xn4ErTrJjfrcxPE/wBnVHb29J19pyH9lk83G/wLwl5LbvUyLq1d8c6xtI00n+yvIoeZll2DrJf6qSZeTarU8+ZaaBNagPJzyu/3Mv7pSGMdmpeHpZFhkYYe/wCd9MK/TzLvG4zUf/ElFjDuTz9rfIPTPnf4FF0bMRLiqdlVvqsctVWmW/8AW+w+u/tqZ3JmOMW7k8803I11e9Gp8SclBR/8FLXQEK1yz8bVdtGJmd1Uk+esbRc1VJrcU063MeAmgkAXnIYCMGe+fSLYL0zGJ3YbjwYWO2+rvp6nHj+RoGkeWZutkCbldRB/ZvXTLXOjgJ4qcaOSK7ssvTTMp/uw8TCbvxqerTzvSMdy+YwaOXEtETHbrZO3+s//AFQFz4nWuX8bjobfox0sjXP+2QxQZGfM3tlJg66E6TpGe4D7WzgwfzWkHcojm+BP+vvNgJpqayHiSjX1ig8TOSqoaqgCtOq8nWzr8LFWa8rBf+PbRVDDwsmishe+hr45iQZ2f2Ln8pxVU9Z78yGT/ZsPFYRdurZqlmCbSuq+wj/kDHKq31BLzeyaqeXJdap4qKLNFaf6oD+ZVA+nkyAhxjbhnIGqE8Cxsy19bP8Ag1tnJhH46NUy45SScdXvQPSIbre/0UEaKkEfk8BMv15w5KS6Va6dqCQpr5ICh2Ebx0/lPzRGQ1dcg0z1uV6pK2apo8700syqL+WJgyUydXbl67XmmDRUfaXs/qfXauyj+lPB16CSYEJmZav3V1GCloaFpIb3YBJeOV9NbHFniv8A1cMmMn/rLoT+s0oZDc6rwbFlSvL46OZxjvKY+q8NF1RVVkSiClk0WOnnISlMlHFjmR+MmOVyKbxzRMup3t3KG9TUSniN1LssOSMtVG3HbRsv9srJ8U1StSX9JCY3qp1NhTx19Mpw4gbeWyItZTp2DH/aZ8AeBgu+rrGH1ZXz4mrloNdxX1Hczet3NLdy8hdS/ITy20c/suNnGRn5oMaY6jZ8Yum7xeREkOgmvH7EZumaw6mI0T8O+WTzVRN72Vpk05N+fMs2yqufUbv4w2hWL5WqJbLeaqm/8k01JuSe0+OZU/yYVMAOEjALFgeM9khmIMorwDKhY9sCAhnVZPaPUtJOXBlnm/BTiHKG55ed1VxM0hVDtHf6mtk9q9ZIZLxmSaudTDE1JU7ZeWgdipWtR9m65q/zocb8eKSw1aVNK1clSc18goc62IIFdSadfjos40pBMM3tJ6Y2dWWy5Eapf/qsggSg0MkEGJpkgHY2D/hUaBT6gvTaTa0bm+2Ntc5HtXq+ibnHAyTqqgHItDLbbrKr0WwpryD/AGsz7Nk1r1Hq8eMfjpMZVXwsyk9GPllKeZBpXR8tcztL9RFcicl8z+/jfnRndS0JOrrT4VKEnjarJlWsYzQFY8dUPMuSBGqUpyQeC6+utH0dU/lBm4vj8ghMt2XtrT0qDhXNrRsZFsbY0ifQYYytOObqC5jrkylldRWqkmof0Nu2uvtFA/j4PkamdyTLZka0U6CsMlK3FFRJzyMnKzSIv1FXzP33PRjJKpCPHNuQKUU1tTemSa8AoyGKdY3gbHk+zPcmq6J+mI0lTrfJW/7PNU0kgAj5TnLBG792kwNKGMWIXce4umXJQzqxOSp+P4qmGucbJUSVjWdg5IO8my4KeQqg+4tC8lbcRFyURN3FGM6nEX13rqbyNT1PDDrcvBtRoaNb39JZJCZtnWpX+zTtl5HpUCXX4u6sYNEyk40Ipqex3e3R9URvkUKSUOnop6alXRFipZKeVLnjRYlCAlMYicHnxOmmXrFlomeuWIuypoUkMZHe+B8RtWlmAryqsReSCaKeFBNzazxztp6rql5oCytBq9v4OXG5ImT45+ozrWPFkIxD/wBV+yuqnxNoS6ToGjJDj8lVzMy78FL9Ry71Usnh/aPlAPzUUkYgLZYOwBK4fZM55ZVxdVWzscY951au81E/CmOJCqKpHL41kiTUvA8yc8umuglfwsZFdGR5Zbe3U7JmX46GqpJ/fgdwcr4EqY/UOPDHcrqteBK2/wBWrphZ67Jf7GuiUi+3zkHJ8mxm8Wk5GoafpqjkEHSba/adGlCHeTEO0DD2te+2rpZgpDsM4srztnVv07MGdeZ7qiIsFhbhEK+M4pZ+puqdO9zJ+bXBkmsePmV4mPGyKy6/6co0UlyOvCMh/wBKdH3N3FO0jmR1M46yanU33UtTWOuVpFA/YU/l2M2Ggeqx4+p3t+OHKJFTqr2SmgoAQ1/XX5y9SgqzQubA2YGRlnjsbgDdAAWIeL5ts3da9C9l97yYPSev9q9VirP7P7o+mxet9LNhkw5fTUvpfc/QdQGP1vo2sphzZCpzYcuX0ucvHmsrqPYM+X1NR7blp9XMY19L6/Dkd5vS4prGenyxky6xepmNsY3IiMwNyDXluOpsIZ53E6pTVGN/+y2lPG6nXIKE76o6N3h9Tm9Nkx5fSZajNNdhgtjHjh4uVqD7DUAxY0Ch0J+eL8R8NQTWaKfTVWZwGh83JSBs7HWtNZCdhAZBEomNhfi2x16j63B6aPjm/TVU48kwpWhqdoztvHQxU/JalXP9QYAVOaMWJHLBV5C8aT8idzZEbncRIy1UVCElJPXJ+U/T+6+m9znHfxRh9Z8YV6eryRjyZdFOfFkqnp7ya+Liskr1u6JTVeq9ZjwZq651B8qstyepjfJPyEQSca2PmI8vZa+R/bq9XpIIJKz4sk/rutaf3EZRgMglgOMdrH99sYcHp4qHJF1k/wDWxkLdZp2Y+fodY0mqvVZCvkJmqiZ/Od96zYX4ceTJLERGTqfviSvqTVqOXuCXcMlfG+JyI0jJ7veQIykRhMnV4ZcUmVmSLyT8lZKe3Rj4CXRJJTD+aT3P12Bw7iyryZRFg1HcUT3k0zJK0/HA8Ebjxwzv0eh1AaWHMEQ4ucGO1ytZ1EmmphJ+mCDhPzcWXY60XrM1W3GKd4/nqbJqu+rU6Zstx45NEsuyqXSj1z60fJRLz8nJspJqkQavXUY9IIGkSQ+y7rLUJRkr93y1MG3Kk6q7rksAq+pZrf8AVFk/Kd5MXHevFSYX/FyN618m2nWtvSizW9zs/PWpoHpA9Jw7yIgSvPadYgErmfMFQgEb59zrT3vW5CQJxtXLzVtzq2Wv2r9rDwjID5UMXipmmckVX9jdCUmqK8TonubYGDoo0lDtMmKkmJKrlmTmaG7lk5vZS9O5a5+9DPjW/wAV8GczQM7SeSK38eug1XQbrfmbNU/9TXQ1TAsISPEfyx2zqe8BBBLbA/dMdtV8uK74qiklnFs61zIPVOmqNB5an6mkU2FOP6zomQDG0w29Gmaqf9EqBTPX11x0O9r6b0tXqoASU3cc7RKomaoLvaafA8om5R3HpPaM2TKjhM01U8PPVR0+HYzjn49Nc7oN9xtKj8PlmUrswiimIbwj23RAqMBi4pDBTewz34G3L5/SeosJDhJiw0T8mul/7UtJXkNSjQvXSP8AbP497t776703tntXt1es9d6pMeH0+LD9quZMmTL6i8tz8fp8MGSs+fLzhjFN5ctkw0ei+p9ow+iwzWZGti4YV9Rco31GMWcM1LZvvhDXmWmfRv4t7d6T2n0X8E999NOX0nq/ev5N7h7f63Ji7q79BD6X0Hp8GWa6xXiyf+RbWOFVorIVzgjHx/E/F9Po0/LUPXV8oCgVek1ZtY7ca0o6BNcikByWB8sPJ/I/TXO/8mf8f+2/wf8Ag/8AFPReky4/U+5+rzep9R/IPXxWjN67P6fFMYPTZCDft3pMbUejjJrLksz+pyTjvNePF8/+15smH3DDkNx8eXHIsLuy5ot0lS66qbZKAdy/b8+1/wDl70Gb1f8Axv7R6ue+/avcXDnx1zkidY69Mlsp8VFYcaYjUYovg+2aJn4pgcHuWK1H/NJup/tVXTFd1ovdGpWnZ1rdeGf6VXV1/hvVXX6up/d6gqZsfVjC9JAHf2v4mimnq0igKn00EWVqZ3wvbX33/wAYe+en9k/mX8Y9/wD/ACP/AB8Prsnppy9G4nD6s/8AF9Rjz1jR1Pyy5IrLXcGTus6zH59af/RLz63J/DfZ/wCaegrn1X8T909F7n6X1HpI1jfTQnpu8l4TJWPNkvFOTL5mKjbXeSqmfzv9h93zPs3opNmf0FGLFnYyVeHFq6vgB+WZyNVd9Y5mZjuflncfoTh/kPp/5n/w56z0eb0l/wD6S9gn0vqsqOT5vWTj9T83qfiY9RWO8eSHHlzt9+mx/BVDOHNM/M/+ofg6uj/Uv6Z/UKaRVTT1P7HXH/8ATqNK/wDwkh8DGvV6BFXSqpZmlg3Pq9N5O8K6sHr4t/5drEe4exf8mfx2Pi9v99xem9Y8yRPpvciOvcPTfLj7mbjLNTknJmyUlXky+KuJ4j1nuUVnx+/+2veH1+GZ9XigccRnzSOXG5MFSRMH/e6cwE0LjpTrP4Xlff8A2b+Qf8Ue6FGePV+s9X7Dd5ocfpfVYMeQ9bExnCCc5MVjDxqmT7z2+Me25PUex+4es/jvuc1gj/yMmKsdtFCWwVJmJxzSeXcDrVY/sMv1fwg9NP8AYqPzdEA0Gr/Po1I0J3QK2jXNVUGKo+dYl0+li8L2wddVl94x+5YiPX5fiZCopnG4Z0mP7DRaZrTeTHXecjmWMjuuL9bk5yVHR5y8f+tG7q6S70UBULPZPXPakzIVvPU+1OMXH8ePVfNK3BdYpTWIJh+tDPET9KnV9BczGm9VhySw0TV5VqaW8vx1SaHJU/4/iGmtzdT3VBc8z+dVFFAIFKRqV+RZz2hERGsqySVspg5CssThCRqnn+Odd1/eTIVNxW6/7YSj7cNXOomfob14Rqj6nI4cdZPrkmkYcYU9ZAMVOWGCqnwXV6Kijxf6C9RhT1ma6uMmPB6WEC1JvNdW1E4yZqhJ3kitOpulKnjT+onL/wCP6yaynHywYm/GSpx5CjHc0a4e3nauTIV8dDd0bK4vIIF1ZPFxYOdp1jVWH/xgCkixahYMX7yLa1949+oMm2m8s/J3PbFLSKwkhMyvUrz9ujmmZ7T2j0+NwTVd/wDm5ssTjgjEH/iMmS6zVHV1k9Rrj45f/rgElnUM856WMeTLGGIaq5+CJDIzdNBN6noQ218lbCu/qsL+e9/wn2D03tvt2X+Ve7OKfafZXePDmlX3T3uMcuLBixV8c36T0jJk9TlwfXsxYuam8gZdeuno9OqqokkkCmkEfPUUAByWL48p9Gk1VVEjuVYU59SkkeCzAWuS/nXr8XtXoMHtpH/6v6bEVJFYNZaw1Ld47oPm/rMIf404pblb+fJ36r1DlTJWRyd8y0WT351uTUAq8+CihqZPHS/zX3/P777x6jK+orNE5ckBLXMN5bV1w0xMKbXSdLyB+bX+JewX7jl/8nJE4fQ+hxY8vrMt4qTMtHw+lh2Neq9XkJmcXWPJUNb847r8z6NIooHrgh1VH/uKJDswYA+2oqXUr9IsEmxEc2ptjzbXVfxr+PufH8+QuPSelwx6j1ORYbe2DDh+OgJy5anrIQzkMJSbMafl7+Z+tw+3+2PoMWbHGT1iZMmOLZZ9FgmaxY8kvUN1VRM8uuoqZYrdHrh7dPsPo69vzExk9vxnu3vuCsJOPB63LGP/AMb22cv1JPQ+mYxRGTI1PqqzzG9n58pfzL3uvcvcvU5ttbPiwYul+LDDcwCcE1xqb12zVL51+c46p+J6tVYC6fSSAscDa9wBiHrXqH+zQhcjcvHZk/bOuam8vufuJqet5SccmPc/3mRoVeaKZPMyTqJC58eveyYf/D9L6n1efDXweljIZr1WseJqPthT4SQfkMbtssQhKyJxH8I9jzeu9SZzHWSctGOIPk77yVCHRNCO9prUBkyFb0HS/wA892/8T0+D+KeijEZ8a5PdMmCrrvJc/E4s1Qs5Yhj56rJONyTw1jJnutqyyOnTNVSqJJlMCzjzla5qIoPUI/EUGpOPzY7DfXGet9dl92919R6vzzeS8eOUq5xYutTfnqSApTQ8UUlVO1tMz8Vl2YnFwSMuOW4Te5HtKU5Dma+Oosimac9t9vy+mwUZsYtk6siaqZrn46XUvArVDuymb1L9fy5mExPj+tTJRrH8mYpmvkmnodqtOhvZ4Z6NhIE+0bIOGRzuxbUAMspm2ECQBft4FnrWeorF0FftfHxjY30Jkybp5301VoVr7gSn5pPVK4rRCpqPkEZyZXeqoL27GzmvFbGNCC7vNcRU5IGadbAKBt7mnJKMyu/u02R06qKR0Hr8n+NOXTZ3EynSlFP+6KHXRPIJI/t/ETvO6/8AjJkRJVp76Scm5hHwvo9nrR+rxGSubx5HUfI2ofaWiiF58K/9Dbo0dafyhkwkxi55f6zJPk0+YG36iI6NToRdux2uX4XIh1UY052Mz4JOFt8iuvqBScPLPlPwGQsjw7KFoJqQOZ1+3dUBzMFfbXlKY5lSCMYaxKHbax1jUAChc3y4zjF3+WtZ8mb09qDFFT0uhLE+0Ega+r5fryJqia/Nl6X1mTHbkPjloppvH0ZCgHtlR0AZWqJrGpztNbrH/G79Zin1P/l4ceOsZqHFkzZCJQq+ugamps56aC43qmudj6P+P+24J/zGX1GaBxk5MkYIt6B1jlK678Y5a/fRkB5fzGrq0U1ekKI9A2h3BG/IvOpFFXqE8jAhK4RM+A2ca5Dr4q+uvvpOaa4a5AeSTk5frrTtZmtv4lw76YOocss30dA81qlnVGkPrOhdlUbIhaFoevMydD4XnX/1JM9F6ZDz0JrZ+YjX/apS9bXlZ3Jc7PL5TRPMeKl2+T6wSURAI2ixZwYwLHG+24WwsGDF8OBbgJaOeVbq4HhkllfJqfkBrz+uRBYOujn9xPwK2EHhL8RRF6BXHtShsICuvOg2z+ZX1JZZ/wCoMfpP3ju8u/3v/Zpr6+DZ+Djxf3eU2mRpsma+pfC6n6aVAXR9R8CUGaiDZosWsQB25XfSvGM8GCw7LAjfTAuoGse6nIRRCS1Sc1VxPd801op8Pjo/aA7X9628nX766nnTQqCaGZ8s86E/Mbxqa39tSPidjXU7vrdDtKTxo0OtUOtpJJkncYutTrdTo1T5qt/bTo71p1/b8fqBfHAMxwIjH1nTj+eGMeeeNBRcgsEhqKaLfO//AGoKa639k3+/p9fxxl+PEPgTmRqKck0bGhWdzjSnlDRrQi/gzkl1xLjdThasSd0baaqq3o8NXKm9Bv7A1z1Is9Vz087KrfirVqdX5eQ8n10QuklafVexCiLCR7gKStPGfe4/a93bzjUOxXG99fcebfD4aVK3TsJNgSOzf4ErbRNaS2ilmWiHXKr00upZ1NUbEGt/mU/aKJKTc2MzqqLg6gdVVG+Z89b34ok0E4u6y3zS/fYVzPXjdbTvlPr+1fM9aZPxTgBuQDwy4N/3jR41cxZebacuVaeLNQzuk8GwLNFbrkyV/U3CiNcn7ZobGaCaNVo+2SjnYfVT9D4nU0CYDHta0MNT9XYIkSVpfASNya/ekQA3Jl+LUyHVTNV1Yf8AVcgB9ZANW8mqOQd/mlFULIEI/Ni1Mryvz0gcdv17+6caPI7gdThJuIrWPcrOws8tSTQM+DbNS+IH8jGtKICt7ZCW71M0fppK3t0bU4o35/DxvMFTU9TLL1O6qzSfa37W26n9U/1rWjtVPKIkiDRxW+1BZo+wVra6HXR5nWm6RJx2WJHe8b6rz+2f5zo3vJFSahZFX69saXkelXxuuv31ICCHjFqnUeZqJipo2TwbxzkL8V/01vVPMG9bPDM5MZx9Qxs1j8dtaHXOmmfsj56Sid65Vd3YTJAaqcbclzf/AF2Omtf0Grrm0To1NKBRVclH3tERzE50nG0Wvz2M/bto4+z1TATj0leXJcMaXvqrHwS/RWeTT5/CrPlnSS9CY0eg+Rrrvgp5N700AAnLOxy/8c4+jY/F9p8Bf+pvJSdbnys6XQ/rZ+FN4GnxS1sKuZDt50dU6olUl2pRqXyv5Y+uf07CCLfq2B2zFt9v1iNzE1wVaP2/xjkPMXUw7ckvMzP2HzfAta+2vwarJdXvI4rmuPMnGaJAqXSXd2sjs+5qa19fyayfU4nmtTjqqm91dJXyTBa7fG6dcvmRPIEs5DRLLH7lrm6yYtKnir8vQzsrf1ryTQFlU5AFnxDvuJ8NaFx/oqRa/wCncSpjW6QlKGeV4Wkk51Ia53tdn3evpRRNRePHWSe7qsejx9ZN6Mr4v/SWL0mvGjTGXHmqsW5m5riU/wBK/wDaq2sWGyr5Oeupd9H4/JNzMaZ3qY1UBOLX9bNnMg7Jan7eRlD8ukFI4tnYEkOSOBmdIYH38CW37d9DfnXUppDnVpk3+yaT+uteQkYPIktfhYr0P1C5vganxKABVUi6darW6rxU/wDyPY0R5MVXzki6nzSRtwokj+yv19XRtUTHW0TgmpGZme3e5Qpo6VmWw1v6adjVAywQRttZp/cxFhqpEqPuH4f7iBGsTyc8xVp8dXRR8da5LedTrgJif7zWpZ26H5seICSnXM9p9irk0l0m4Hqjxsdk+PP5OOexKfBqxoqqCSd4mtV4ClqDQnXmWvwnHSLK9cjCTM9tWBe62m7rzWvsgbO/s1sObWMQmh+Y5EqSO3sLSA094h86LFTeh/rMn68F1Oudqrbzvv8Ap1vmnz4jJk6OStVeQprRM/6Cqp87K8dc/wCqkft1+DxOFDEP2oXyCKeWqjazdAsEnh+/h8p7ATT/AOxxy8E8JrmKa/1Lv7TJp/8AnSjZVI5DjkKfbi6tKGPfPDGMcjVmY6XiTXxMXVtOP5dzpIVlbaErZzTUpqdfgW/G7cLCbwoOi6DdXXTv46sXrYVJPQXHVYZfjsCh6Saqh+mVY6OqJCRnaAh/1/S/mZpZ1U/W9Rjfs3sa6u7JoOfr5XSRqtc/b8AWMBQItP4bAGSVi19NKHj74977LhazFnI/x1P3FxjxW3qCXd14Y2UiCBNDOgpj1MTfxRwVZkjVlHxg/wBd3rW7pT6kmpnk2HK5fjvHchY62anyeErqPE7RnqtPg31Owc1f2WCi2Hp+1YrtZk6mggjeSWSfHUsr5KbYNJVwB2Qxuh9ENNsAEM4sIXttjS8XZTzLO+oOk6Wpk4maA4GklZ1O9aH9m1iioTGVTMTRzVHezTd9E6fP1nTPLo+oGZq+uM71px9J0Lrf98n/AN1fhTxR14XYDjtuq61jZr5ZtJWtEkR1Tu/KcOjaanVD+SCir2w4ADQttzduHVlExmDa1htMl8Tpt8BJXkqcb31H9qV5ro2Yz7JrVRrf1NH5FXvnCAmPF0m2atGY+M723M68yTO6Xf3B/B+QuSpya/xsUXLTNoVr466ZkUeh/wBPhPIFZhnmzTjZx1XPMUill7op77qqrX2f7De7WahNhkJAkfTYNjgDeWG7bkfiNuR2ASurakqpyPPVDmlBVTychSE6K38fhC9aPOkM0xF25dr31p1orZMY6qoD47OmSZqiel5oT8Tloum55i8dBIqd4511OmVK0xPK/aQONvicjeSZY39dZHVDV8l7ycZPLLxpPO1kd6j8zFQIIN2xtxe6iST9NJXH88Ef6U3WpayRrU9dXJirRWu5+kuV1LG/+utsP6d1IMRkGpqu6mtaWV2P1RWQQK+sAO5480/g3E/qrWXWV+01o3v4zYLUo74FfuxZvQqfmyY5ayFav42F7ZCTwkhXWz6qcz+tz08z6mcu4kFWvjt/BoQI2PibTf77HEC1GX5sZV4/p04rrjfWSiftkmqaZ+zpNV4Jemds5Sckm5r6/wCMqYJG98hrzVH281Gl4kBTYo5hyzsoMheOg0TGSX7dRsA3v6v6Unel/HRV7+0wvE/dnz03X+QpspfqasFfGMn5PLf4oPn/AOKahboJiZkjTvGLnPFhEe5vnQo5Ls13U119adwRJuGqDuWTQHh1yP1miDNlNy9J8iVpyfIFBO+qTcaOetdOtVyFLGTJdX1ZWyidQZDplBujfXVlPlrTzzZ51+MzxJOJnn7zG2dAL5WskL4qZN+d01VIzwksoqZtnFxdnziN1JJi0bbR94Hiy1Yx3jJ3snmXHQkC6rTknod07n7db2VsfDSwx6qpUi7SdUTc3Xx0bZqTHPR5PLI9Don8RjkaSJ/25NbnnmZKqfOl+/7x6Zd66U1+HwjkrD0T0ZKlfCG/OLnj9Mxy8VUqm2bGaDKYucDtg4SDC/LTp3/eYWzPZcxomzF1107tkeaqpVHRdIVOhp8GpN87KlzLkkSPlf8ArfiRNrLGN2OiVvQzJIXv7V0wuQs7uMhpyVFcpjSw5n+pNz+9Gynzvwz+Ilhz5KbniJo3Yf7r7VjBNa614s2/JM+eUZgIkXzBAXGDYAPbtJADIJ35hR+npftGrE7fFtRRfPcy1HiTpe52787sjVdaZmiirGOEaZflHZNOngrlmS4aB34I8FNF8v5V3OTHuaqXGE1C2Uss9Lpp1uyQf66ejUh+PD4cTc7/AMnNMdOpx2lcpj+MljnetUmnW/6/lUIGwMAk7SI291hzqhcGIuVucv8AZ6OaHDlbuTaM+ZmpqSf8Y1wuPpAJ20jM/ZD8q5OrYxyz3qYn92cklDeREXplaDzpFKR/GUmpqv8ARNHKTNICm5Wrpm97PNeN6sEyCMdRbryVFS7o3b1jmLeSBrchs8D+x0lR9RQ4BmbzNrZXBk6CcL9WwvJzbkbDhL4v5MdJd2DU7sqiTbV6GI88vO5XQdfZKnKyxWIxuP61XREXOOfM6rqlvz0xrrXn7bUYy5N0Xi6RMe9U6TUhdqFQz19g0mnSwq61kKXyh3+u6BeqKeqA0yGjwg7nf4gKYRtwgbKbG32OdIKPLgfckBbR++Q4/imoGZJMYOod0CiP2GmgH9oTtPCS4f2zzplsrvrkACNk6dfV4NJ5R5DSamTJHDpMX/VJjuXuZeKSmpOnH1vzR1pk/Ic2WTeOqZcoIoczTNbkqwQSiKRmcjrVTVH42BcGLdgj/tOE9AYm8j6AFfy2Vpw1iiIGbXlj7fbaAdZPqjKfqp39j6v+19RTbWOhMwVf7PICUZCT4w6PDO/6Jv5PwIGikyWSZFRqCnGUeanW2POp4a/dEa7D8LuJ1VSG/of42BoZktpUF/ZRzf1TXX4wTGALW2GxN8SC0JzQAAEncfvOcFjNss7ir8YJo+c3s80vgrVVyguunXkNz9Nfh5iIwquOPE3O+POk1Nb81SUDKc0HOxmb/Fa/y47WV1CdHQ11KsoBWppK2fo/R9ecyayUy6kxHys7YKuUlAZpqN0Fbd+P+rqoGVVuYHuJKDwZnGh3/LvT+6JJ++gnJcSxfN3dSRf92JyRqG8gg6+3hHeyplZfwqcbkydChdvbrQjL8asmyt/qJJa+pquH8xrDj5lrfc8zK1TOT68NXWplF1+tvKD50skN/Xj642pt/TWx5ro+1edAHlOdnj8m6BTG0kSL7m7KjtpxCxbixkA3EuA+61O20ABnmt3ZXUTMtAVtqf1o1PQhUjM1cW47BuWCb2aNQ0OjRS1ql0a5UnjRRtyZ3f7qtf5tuR1M61wVXipr/wC41Owjy+JG+npTo+UB1RrcgNVRWzoKlQ1ybNg/jlDfn2G11yGwzpODuOMEAX3PkxgXZGjqsfyYPudBQQ6TZxbNHX6k30ycHlRlq1uqkmW+dTMml/7/AGehQsa39STwVHTj/Vuol++KYoqQSgflvItVNfV28A9VvWlBh+T5aY3khS11pAgUqvPYtFPPl5PBuktCAzeCiM3CuIHkaWLLxCCf1V45vppmIht8PjBVMKu+UuqyAMGiWiWvBJJrSfz8krUd8RJUnUtWTU5Lr/dFddnJWxZEamUYb7AZHIHx7qeArGxyDe6p3kd9T1s1RvzZzBNJLrprNrJq4Pqc/H0eK34nRP6T/dbzIgJJe0h/f+KaBzAYXv6W1YDEhRq/hkV1Ur9c005Ci8YbnESjOkB4OYBofNGrORnMXt1U11N8sypO0ZbmhybjXKFcsuqZXUObmZlvcbPkeXqao+s1bZMxMl9xDwByCr+WIsyWnmcs2o1QxUhO8cU9NPc8MiNTJL9sc/mHUpbubDzGIzB7lbhxBQBJds47AsRyO+trjrmCia14JWldPHJzYfqj967Pr4ed/kwNVaWH+QyWSyVv67xv0EqhlVWdDy6ZZptc5MgMoRsiuyRYmUmROk4pHZrb/wDbn8PHl54DrHcpGwmPlfp1GUa3Uv8A1vyoMvk28tVA/wC0gYiLYjbAkmcDUkoJFiwC9++Pq3q5b3rE6Gz6q+TGEoUrRVaJlPrT4nZSV+DU/ojk5wkpIhU6Z/dfumuU5CsjOvFRFficfMNOG+VOqFi5TUoBJprWgVF3pripAxUu6yTS/ecn07cW5kxPnX7mdEy70ivivzE9ImppFX4COzkhkkbq0sUhi84ttEESGDbtqxD8WOJm5miZt11kNaS2nxKGtkMOjYqL+HOcyu9aSpmpaJdxLN1RbaxQgfI/ZDHfgH8q5NhuKOWt1jLKmMbzulxLXPgP+vKu+ov8TfWpqbCpcck4hk40daqSvATMMqRO9Uco/kjpKPSBZxMKdrFWV8mSBiOx4EtAzZDkaufL8y19Yo3eWZnisoGPfJW1dkbUl8cu+SvxLU473jz3HarPhiVJoje3HLWg1qa3Ki9fVNmTZM5ZhnHLUzvHN8eK4dNZC/qiLuetOqH8bzHVX+5rG0amAjpJ3jmgU0anym6JNFDVU9HiAACItGewviWloJBTwVtZZuP0jY6YZYxY5ntnKs3Jy1aUTwXdGhATyNVMU+bCUWrxFUffvJFh5yar989jPDPNCGyCmg32Kpys8DNOogmKOql3qLiryu735ok8KCLvZZPVY5Fp2cmPXNHVU67+zr/das+69MDqn8umi0FBWtAzkyCkCXGVoJPDdI7AzPD+nOjLmmi4uMsZAqb4/wDuAiWttRV0gAadadeRLlYum8TcfIz+mrxvhkmruSojhd6SWN6KNVOTJ0n7Qgo1X18Cr/2riytbpP2eBQlOTNMnVO9MzLMORpftKUqtlTtra/rY1sOinp2JEwrRZZgwxZ240i04A/C4kwbp2IJehyZzENNdZK+iANc0GteSZjGS1o8nFMz51Ty+olh+tGOb6KuvOn5LBqZ0tTVG960n7ko2s10QZIqi+pZeLoLl2ABFF07h5J6jaU/h4bqFDSVTjFB57De2SZccV1Okea2Btr8r0SiHa1wAjfP67xolCki31lLgStjgxqxVVqfiZEYm7CiBNpdVQy1qVrqUl8pSH4+LyjzOdehyaSQeXbMPFP8A8VKEhNp4UfyvWQx8rwfUivoUT1W+l3p700/u3e48uzMeXJdamXHjxyzV3tvIyTsYup1hTo4hWvMRPfXKNAF4Ngrv5b+nF9uFqmsKxAwZGd+wsdbHF8ZjmOgepyRqSDe5icNLuuh39fJtqWhRDtgMV8nUfGnEuug3JVK9Cj3rzRM06QYqVYzDIwx8ReJnSjyuhHqTuNoyzJI75h/LeFLXJ4JnpfLZsqKkxmiNA9Sv1KefAeOesRjAKIePAJCOx20FVSohSINj7xBcnWz9Ll/yQTJ1lxmPpe5leecpkUiJOmY3OgE5oeXaRmxGMLmndzMZLrlx5QnQ14+nW6kgb8KEmt87jzfHLpLqg1TK2PgkqjkgipW9faPLtDRtMedyYYoqJG5chzI1Wt22tXypQdhqzwPKfnD1OlSS0jALQYCAxjNh406UrCTSfw27SLNzjXQmVyax/WPiZrqdY9GNTc3W66pZ1knkrpVUlLub12XP8bmk9RyTjn1G0zasDT11OTn7vVA261bQ75vDn6bnHlIGaW7nWvGtQXNdVpBTkTo8am5tTm5xRNVN7JC/7VpkZushuRhERkTdc7028NfRBNpFjuIyylLV8a0BpJKDJgbJCdgixA3mNR6v02VO8ZR8d1jq2gyBA1/WZ3j4+u9JFMhTM+TV5c1Yvi+SXHZUdZGFq8m1XJLN1jQRej+vM0HlegxZLzDFRO56ydIA8cmkqmshTa0gF7cdBe1XSZKPlw48klyTDAGwJ+QG5vHZvQqaSemfCpUB92dlnv2G+b6lWpYxAiCBkz22++hrKsjU/quWairXIimSTbp2pToqdtU+BRjfyZMnPfyvMUcri+T+rVSyRpOkelL7nw8vSx6L0T036bEtw0Mt4yOtDBRWy+tMBK1bsX6z+W8fpvaMs+fSIMzLq7npApJN113sSkN1LX05aqD1KaQ1VtAAaNLkzG2+zWnT06j/AJCzRqwhxgub+BrQY/T1lqYjCfonLXxz9rL13O605GaQok35jRrf5tvS+x1deY1TaFWV8gVtJfqzrdJbBqFpKrVa6HFi9Lg+PJ6b0+KWZiSoG+J63NW0hFpMyJ+xKvqV3bfUZnZ/5df+wyRtx43lCalQKqhY/wAfTC3qcndVU83U+KA/CCLEEjs0P+1Y7ONXT0qR81UmBxCmU+152nVfH7Jj9Nw+qcPpSITaAtR/sxHeTI5JqjWsTk0lf01+Iv1efEfH7bNemJAyeqo69UrLviJKnBjGJyP0bJRhO9Dco5/D9ECrqrpbwm9n3Fep0C0d7nokB/KOLHkx1dTa9ZKidqW4kduvoMzxuZ06REejfDX8X1KgQCB/43Yj9N08Rq/lpDWCefr4jSPUYp0asc1R21V01kJaL+Za6+S/EsyTNH0VZa/Om939W+m/j/8ACPb/AE/Xp8vtz6z3i8jBjv5/WesrLiYvneTrH6fCYjnHRy7rIcSaTJ6espOHVrZEy6r/ACXbzA+FfkmnxMs3ok5N76/+ee3z6f0HseWC6xHocGCZ7upo9PjuKrHl+PVmSTqf1MRJkJ3KVh8PQOt1en6y/mPpYyKSNryQvGNFFMGuCfSAQrD1AibBIW/J692919l9P/Iv4X/MfTYkZvHPvPoceT46qfn9Nj9VicWLFFOac7l11FC1jObIMd/nwB7tj4zmRmZcVOLoRLZqt1XPdaAlb/8AhLTwp96f8Xe5/wD0w9t9v9JXydeu9o9HhvI5aq4r0ebN7bXQddeniCBxfbI5IxuqiCo+Ov597Ll9l/k3vntuTQ+k9f6mIaN7wtjjuX6zVOK4orifq3X0lB9L+lCnpdX4n4eIqHUoGwKFQFv+LWHMa0+JpFXT6fUphAAnsjO2LcTr0L+F+v8Al9EE2HGOW8eRhqmAqvjmyi7qbZltup+8X1B9Pqf/AIf/AJbGD2z13tNW0YvV5fSGL4stMR7grPqSWzH1jZzTVAXrJc/FkhyfL8Q/w711T6b/AMe8kzMXtnVz9YmWtIjMXWpNSgFjyVuvaf4N7ri9H/Jj02dyTh9xxZMPp0q8c4/Wela9T6esrPwv11Rzq8k+SWbWa6P6r8NT8R8LUKqXVR8wCS9JDORAi+PGr+H6i/tIIRQUskXk8fsAdaT/AJCt/g//ACT6n1vo/kMV+tx+pGesWSsebLWbJkxXEwRczF4cnEsbm3XBeOdz/PPY8P8AKPb8H8v9pl/8+MER6zHMxkj1PpT02K8eY+GUc/k+c39EKmuLx3Vv/nz02P1ub03rqvFkyTgmKrHE4onnFV4KjJy9Vkq7LaCuoLYmqGuC/wCOP5UYcb7b6q8lY3J3F0s/BnxY9OGdoGPO0FBj6fJKPDWXQ9XU+F+G+IpH/U6dHpk/ippCNM4SX6ajqx1K+nUINR9I9iFfB4jVD2v3usmPH6L111Fw4/hyjrJio/xxgyfJU6kyK0VL9/7dVL3a9XjzUZnL6WfVSW4cefHFBZIuKseWcnDMDWSn6q05axzy/m5/l38Tv1l37z7J6eq03j9R6XCd5PT5eHLU0YcaxBuWaqu5Ze6ZarFxXo/5F7n7PfHqPTGY6myfUyZTFkk0MO5cVjNF2LfbNoLU/nb066erSKumbAeqmG7mKQhAkzfWRqI/H6g6QBVSCQQFgC4CwN3ofUwYVrJ/kMkHP+F1ivIaYaxV8cuMl5BqzTkxzRWgfZ/4v/I/5h6vH6T2P0dXh0PqPc88no/aPS2vLm9b6z1H+KbmbvZNOSnZOO2Bnr/af5n7Zloxe6eyz7hmmoy8HpsV1njHW/gaySTjN/LePLOHQjuttVXofpPUfyz+X+hw+2dZvYf4x6iH4/a/b8RF+rfUZyefXZ8WGJ9PicWJblYmsWKqMCNdc/xHxHV6VIIoHTEE11FiFakFkzAhH6VT06er6ZYJBSDxDZ9Ldp2trg/Yf4d6GvcsXtvoPcPT+tzenx3Pvn8glvB6L02Eax+qxe21fMZZxxE1PqqreTrVzjmjvn/+T/53ivBi/j3sOTJXsftuF9J6JpvvIt5Jy+smZ2Vn9Q+c2Wb19qqMY5Kt6D+e/wAj9F/F/Rep/iP8e9RhOMXw+7eq9OTrJRBN+3+nzkH/AJEOXrJ6n1Mr/wCRlqxJ+zXzfjcnuXr++G+RiIGp3QETQDTprf30IlP1Jr8noCrrVUdbqNAgdKkpsoHqECA8AALC0utWOn/0qCH+GqbHYF4AyDYa6L+M+zZvcfWYAjbmhTuPkmOnV+qy1NExjxjT3SsSf9prn8+nv4r6L272z26veLw/P/GvYPU8+2Y8hdR/K/5owzGQxuUc3tft5r1OTUtYsf8A4xcw+soPMv4d7Ln9zzYv457NivDmy+nv1P8AI/eNODH7T7Linfrsuajbi9L6ScRkzXz1lt/8eBy3y+0e1Z/bfefc31vp8eX0n8C/gPo3/wClno/Vd5Z9dlx0fJ63M38eE9w969WPqLoZqsMYsEu8UofGdQAVUUk00gOsoNFIRAqqPyjKJJ1XR6YppyzOCS0Xf/Eb5RWvN/8Akn3U9i9l/wDpZ/5OR9193MvuHvPqLpMjlzx0emok3fN7ajLM0SZEqY0V8uuHP7v6/B6HELWSsXWTHPZOPy1VcmT9Y2nJevjJ3Vs0VU9v/wAhfyK/ePfvcfU2llXmmCr7IHLdE46NTxM18YFfQh5qzxXW/wDEP8Yx/wD11/LPdGY9L6eapfUrOM9J6ZLqx3PTkqZmcePLReMzJNxqPw6dI6HRZkwTTcmopUoDsIiPOubqn+91RTamk3goC7iMiL+2unwTi/47/ic+9+p4j3f13ofg9i9N/iu9lQR6hnWLLjzNHfOQqcXp1rNKZox35J7b6L1frc+X3P1/XqfV+uyVlz5L25Pm9RW5GqIYqVJa3TPRZ4mond+8+4+o/nv8kr1mX5H2b0GTNg9rh+Ri5nI5KsEqcWPLpqoj/Hgxk+Vire89L7DixYcP+SZcWGL8ZYMThnqzHqZnrIB/Wgp+0TUVkmhgjpOrqn/qdRGJVlSLpTnmRavT/cIFIH9umKQSmR6fm5JxfXKep9H8eGRJw6mKcVM8ZIxTkFZclTV3pZfrNy1CO385v1YIaccbxmR8zM5uT9O+2bsVvGIVE8t1kdx2nvPqj03pIdc5O2Jp7q/lAkckVvmI3kndlPJJzUwrwPr3Jiiaam2yaMmkQqBx18hrcFQ/FNTsErWq+vT0z6qSbT4IhiyPCzFrzWRSAADAHGaSnh+350HmeCFl5BNlEMs85KZNPVKSWeP9/wBnem9xjG5YqkaSaqjyMtUc5CTU49pK73rY7SX8cCE11uh+QWykxmgLTacMhUEbSqofJ+K9XXnLlqpQx4scSx9peB3BoDXJNUdAbdvQBV+Erg3xAX2M+YRPPVbF0zZQOAv286zMOTgP3TjDRElTMhpfLW61L4Cnkfsj+ZjDHvxyqVA6pOk5h65OKo8IadM+HQFOH57g6nQzkN+AgfOMskf3omYd+a8irM+oyfLkyfHUpHBvTLbj+tc07WbWUnwo873M1Mgx3+zHD8YmNZlFBiCgR4jJ8g8MOOr9rzOT0J6e3qsGXIf6P8TvJqEqZspbrnmfCUHia/H5Z7gvmskFamcTqrWK5oSa3kRlO0DopF/Wq9maiM0y1yatl8iyk/vICRqpk5l3Qws73+XsmS3JdF8bLJFST6oOtQOiQiq8AXtOtfnm9ekDqP8AxJBj/wCMXzhRfZapwCU0JBViMyeLRLOvPclxpLTmZ1Cnhqf1u781tNFzy+KFLkpGLyuMmZmYmsc19vtyk881R/XYbskEZl2pTPO9Gta5ZvTq9Jzvoq6760Gj6wSozNMwEFf/AG7moqnfmzxNNaCejaE663J9wfz7iSZKYwBjBN0BkQIydA73WzhZz357agmY8nMt6Z3qmR8TNqMzIyIp58AlJoYa+2NhzY2nyqApABXidaWJknW0rzc0Jw39jZTPW+zej6gx0zv/AGYwk1tNDt/MKvb/AGSq2aNX2615HRIu9eGVHQVoG0ZEDKiFbtEY0/5h3i8T/FoMeUxz5PLTPmD6oyk1deDHudB4PC8/rlu9fodxU46qnvTsCxb8SaZKJP8AQdV0oTOVuS0+IGlkddyzJdVrnx4aZnbGvHSidWyG5nqSMY8Op/RNNL9muXz5vXOyl6pgbk3Dd5WTdzYaApvv7oCcbKDqEoy7k6KkSnXO71/2Fg0nUmvI7PPj8gyVOkjx9cXd7ecqj1K8hztB8vjmQ1ojSJxam+0ao3B+4HWqdjqYA3sEaPyLrcwATKwVUyAulR628m+F5XafX8H6XzgwDbOMST50Zhxzx7/n4ueXWpaf/wAGVR4hDz1WTqTwn+TXh/f/AFZ/IDHQr/0SfqERYczIVSVXfjdyarSvL9vwJvejljesbQTrepDmb6SRHyHQ/T662nT/APdTKBGpkmeDWquzf9mXpdNHl1qtT6qmUULEX4g8CzgooHQDw1nDzdfazAyNQ1MVqhi984/pV/4yiXG07EP9USHh8Nw9MjEx0H26fqmqqS05kdiMpIzqt9alP6oVX2x6eWfrth12IymRejetNiOwNoCFZ3MlbllnjeuIX9m6brTvXRp+jRpO/wAoMEltACm9ioZaMOwHEnTLbuYPYW+iOmczTLdt1XF7HGSrqeOpZSa/s1/ev/np1+R/26NiU4zcqAprdVvcbPDr9AEgfWOamZYppWJZGq6StuSq/wCrsQZ1R9XxPX43qizqJqvilEPp1s8PVfb7a6/77Cd+PNxZkWcsERL3KjgNAHStv9T/AC/8A1k1WKSGjewhnYPU9FVkDnXRr9GxmdeA/IBq++5i73ctE8VLXmBRGmphGtdK/fZ+BLVa3fPjvmtm5AGIHYSp1P6UHaUlfhTURhqq8c1z/wDdjqPp51RHU1WyTlKeZsX8BemUALcC2SJQ2+xIIjLFoWx4AX5au9P/AI84tt83oRrqcdTs7b/Q7aNQI6eZRVQZP2wnAYfBM1XlS1tfDonskWtef2/gRVnYc10nO92Bl1wzaik7RDZuvGq3+ZbVy+HUMyb8bIf1dV9q6+oT4ml4QqR/NQkBdLaUZ/MZPbVFeM847Qk/4M5xnNY8VdXZS7dzdV+vkP6zHko1uez9b/A+W5yz3CRGTiq8j8izO6qr6nZ+q8U3JqK4qXDwdDuasLJm2Z3Z9wV8SiRbPQlczWh/G/SjVPDHEBwhmyTo639r07fsu1K27mWwbCEXgWI8p+MpaNptk3xtgWVxdYDonExvLFYsgxrpKPjkXVfIFTGyvvQH114rHKgXJimv9L8fdf5LNya6ofry/YTzxZXgOvzKMlTGsgo45+O6rnSMo263UupZXT+5npqfxbMenja8y5NaTbqikeU0xLvl8VOnU72flmogjgF8sAM+3kLTaC7AlQkLDxBuRqxjGsI7I3kkp4eqo2t0f21XSdz5To5+ppZzmfFfHUvRX2jUyG8c3fT0M860ITx5Yh/CjL4nwASSESfW+Ri1FOgfFG+Ddf66Ausp/jx4wckuW836Zi6+8RKTFBqjUi26JNCiNQVPsVMj7R2gjSOPy3tjxzudWOrl/wAT1jqxyQyxP2dbxk64lmWFpNUp9xrUZZMn1NSbaNBM1GNX4zy970a14oOfH1VWWyJxgTOyIv61jNdSnbvw2F9OqTSmt7RyZMtUTMswVOGtd71qdpSXqJ28+Yp8TXjl/L9QAR4j2gGyUFmXa2ni/O9wODYFEPYLGmY75qa06RA3TEXkudX54CJR+L91SVyaARyi7akOakp+Pfy8j3Xkvo8r4CKko/6HOTMZKgvQFT1buZZx1zzp3bdf/a0rLvV/pVZ7ukwQzDXx15pue2dsy1RMRW5/+58yyTYfgKgB3IQvgdija7KkaIFjlj6eR4Ls7as1NUm3GcEqRcTfGNpyXUXKmSt9f7TZSdLpEpNTqeVmq8uu6aD6QPN71DC8u9HNGhCstdk/YieIvUVMGQ8K7r7zU9d+N5GQXwxTLwmXHXJqo2TO6mm5+vWqOgdRM6QdBZ5llEgmIU+YsVkwyEr6Gh4C+kiJnHfL0iQnJXO2fkJeul5CU3J9daPFS8+GiQlPy7Xw1Mr/AI5LNVf18i9SwDv61/vw8utaKEy1guSa+1TLWRCSbdMy32Gvr1X9rrbVGtBGasmOZok6plo5CCqSvk2Up46IKaZD/sACBFILScuwMAfbsxKk6TiV25HYYO+xzqz8tMC4hCnH0g2oSY7pbADnmaZE2bxVU2Ukrj5JLEctHbJNF0BzV+YqdVSMygqR+0/Bmce1y1SPOSa3FLuhnC0kmnxucfk1fKbmfwcnNYpgxMaksSq+7/8AUTjsuiXHR1ybrg3pNiJKCgszkhjbdZZy9DXf64+x/g06rySkYYkx6MeW3cbadN8/JO2pl/yIedBJP7FiCZ8MUQPTMaycV5indd3k/bzAOman+tKIcuVumeA277/bXNcbo3z5XUk7+sr1yjbycz1WpSZj+leVTnK3+wqh3fRSi8/7/FSkSPGEYnG/6jTECzQ/ISd3a6m0zOajPFzO3Qojxbkx+Skrd63/AKr/ALSGTjU6qXO8eKrmyX44FWdsbVyLS8PQfJP3oPtLqj8bn3IUrU5Ga7xoHVu6L5xbImY5vr/e37S1ML+SaJ4nnmcWGtx4Mm9jKvJoF6v9L8fnT+BLJiUP9xKvfkvQCdp52X0iW7K2T/1u3Z5whRSG/tLFeEA8N7jgNWKU/g5YjG47+RclaaJRCm+gpkiJldb2Vf8Aj60S7kp5h++JyxkuLjxu5b5kjc1rf936CzROSa71NDd5T+uOUKZg+1sc60mkBiQXomQDxy3+DpA58xYCyubXt30n/MbW7axv44vlMl3UuRndE4cnOo3PIQc7JIdeL0S8yc1gymO/1omfLEWc8tCSfuTQAnf+jZNCZivt1chcXb35pH/7G07mNA+DxOuR+xsr7qYg5nziNaILnyDP7dqG61Jc/UHq0kEu0Jo/QeJ9xjSEv+YH8MDTWzJzOXqT5YJpiqStIVfZ1y/2eeXQidgr5mJnU1On6iJY9vWN7TiaH6n1HXmeej8r7yL1IUvONKjeiaOcnVV0NMh3vfWnSP5HxouzW1ydVXmpny49sfpOuWDT5I3Xn8ASCwFjG42B23SyoDpY824s4D7vPaC7LQI51yUhi5nho60FQRR1vVDkryA1jloQKgyTJ8drjmEmfqv3/eRp3/omqipkZ43fPmpGRtZ+8G3f+TtL0al8dTjJt8fs8/7lfy5Kzj6ef6xjlIKmhBm7qqadMk00fqRd15dKa8+fIU/zcAY1QMbiJE7ZxFvvnQZ2EiPmd3RTWNOeK0Y+7/8AY00s1qfsSh+9qpxZKnx0s5HGk0RaEHW1BQ19adbddsn42p3eOZyHnD14TVasqYikPshySq8yyUyzpVGFgjuyn/K5UEGjU4ttvdCa+i+HnfZB+FRbZEbGMY9599STtFjFsYkfn2wX+TnC48m9ViKncyI9B/8ANW0E9zSf/U7rxQd1UE/JFRK4pJNkVX1qWptRxpuoa6ZNrOt7zDBeOUrmSvk0WH0dfRGTxP11GinpJOWUsM24kqVlTDCzuh3JDXVA9KpQTfVAJRpAGMjA2wO8+0cLQOxxvLXmfG+q9GPc1Jqi5q3oGOh8Uhrj6miaak6f6pp+S6qF+suXIJLJ1jpJp/smpFZne+aQ0ccsU39CIYKDDd/fzdO6vVFTre95UAf1P1pZyYe4iWiax6qgCYuMbU290/amXbrwh/p+0vJwf+OMTCtkj7aT3Ht44jNh9I1XnHStTmISvle3T8Yjxuiima/UGp52Lp8PHrLSfqYsqywKkJ2/YVaaenzG6A8T9azk3zES6kjE1AwD4In+zqdzRayIgIk7/GBTnnJJe7nfNamZWp+r50y+ZI1tpQPs/iBpAhkW7mAb/W/cAA6YkLeLXHtv+1tMyTigx/Gct5pZ8ssUmqxuSdhJUMmjqA6/SbrVm8JRRJTjeZrbOwmaTxzoqevr4nQbL2d5WqhYSd8c6qJi2XnIvRybqjaTWvr5o0xBk0bOqMitEittTta3Jcb6IdbVJ12r+Uam0wu1h6doOf1Wm8K1t8BBdr5+hLI48tazY6woydfZi7jU+emMj1vU866Aj+8lfhyfJDe+X60RT9txB9qbFR7Nf739dn7/ABUjWLxkJSv70ha8acYVNfXyEa0OqnX/AG/J5qCR3onTMTQMictujy71X660hJKv4AnIfs4RH52Ft8trxg7WseHAgPYkaZIN97kpl66yLuehPjn6yHL9OdUJRo8dDbPgoZvHUxFQcf1dFZZqiuVDdL5I4v7G/wAPBV6YyT9h+Ka8H7558uti7C55dgedV+Bnq5cfITV8zuthNqcZLyeZqj97fGha8aZPULySVEyflsMxO+WmdSTH5TdDf7Y7akIaasNTXEa5rkGaxo0Opql+zSk/7a0mc5FepMgZSGpyCzPUzze9/UA7rUdbhHe/wcE3E1FPVVfE7O0l043tCfi7n9gs71OrH8a+XlppJ05ECMldE6V+yWISSk1qZl6ma/AI8G5lu0EM3FkOCFJYxuJN8KZJxMDCtorhrmm5mpC/Kh8ceKnvRdbZ8fblGp1zXX5n/kaS3W3UzoStfXltXlnIy7drVSrve0urCb4r6xAg/Z/7NvcujR/7HnwSc7/VYPo2gFpMOgqHcExutaDf6PM9amuXX5fqshibWQdpdjy1ZnRuoCQ8JjGMWwBp+GoJuWh7/wAe/KyUBpeQ5gFQDgak/f4v645nol19WeE7qieMlU/venVg9EoQ8gD3WKPGKp2zium6+10DWQKg1Pl3ko4P0mxPxp1WMl3BDOJuSXtjaVLT/el8P1fq+BdMSUrhIrLEvw+xBR1W2eZkoWI7YkczoKa2XjvdKRVRMzO/rfQz1/k0eenk6n5CjrTMWVHJjqF+S7xlO/F7PDkWBjY6Z+0oeC+ihcITfG4jfyMtVrjW/jWAkFg0+Hl2P3/MjjJjlHiSGWdfbtDSzqna2TNGqduydn5JBBlbrBs7x/q1tG3hLM7YRPyxgsKNWDm83ytScwYyamtNRcu8ctLWTS1NqPTZrvR+ROW/MZNsuXnvzOR8TOql1/jrVP1N9eNXl62jG1t6j9ZJkd7J8EG6rzePW1eTwnjyDZyikz9d7gGdaWZWbcg1uqZ2BrrWj6uvyfT6g+VaMTs9guwxqb2H8iSEe8YKBUaZ/wCUFSUMdnE/406o1M11Sh014t0u0RySVVqqKCWjZjnJv+pf18S5P+9OwUOa1Un21+axZvXU9MaZu0qXJIP+Prq2f/tDG/I0VjGrEZNcp9619HWlaZkh7fHKTo+zNPCdUby9F2iFAj2fLUDJJEaB7MLHBIDMFTq3PJP+K68ZPkMfRqCoLYOXSa/rFC0SVzp2Fs6+Zo5xFE4mqnz8hVVoYaxs08NP1rXmwBoz5LGKmYpVp2/Xl5ayMjj8uniftqJ0/gmXHkpcbk8sn2ipgqwSe1qeN/uUJ8ePrrSPTEOB/r5ed/sBqwbOAIAG8F22AWdp1fmsc8uqfkZrpp3NUPM2whECFoKnkgIQmMNRRbmanWRnainMzLvrX+LbSIOtM/XS/la0wxNeSWDG7OtNuy+p5+pQg+WfIeB/B1kSEQHFjb1rm8Q/Zbdd3qQdBsHSpr8PQOdryyABa15mfK0s2KQctWMLx/oavfJEMYgaMa02Opt+oR3SuTp0bkia1zzJG1Jnw21uts5qqbPBoqRgLWqlunzH1/6smpv8WXJ1/omDHzISSLJNFv6FFa8tVpOufIXgjJjjmiXGTkioSAqfH255rI0cjp3VSAk1v8PRVgeo3VvqJj84h6RMQMKPG1g+8JX1YyROXWvFmrn7bqYL6SdnVldQnPMLuNm9k27xy7Jk5nbM9NzrmzZTNKz0p1LZ53cqlyY8jzeNC7dfrRXQEI1sin/sV/8AEy/1pXcRJ3jMkpUfWLEmaf6VIY/ruR5ZXldOvH4/RSIzUv0uhvx7TpS4iw7CO3bHc6Ybx3fO0qW5+yElB468RekGZID7UyIp+Li9XdCUXQaD5OQmLJ3OjHqjRo8dVc7muQLu9N9TXaD/AGfj+Q8c3X9SdM/p1v5JFTaR+O6yxOSvsxR5qcx00+Dg7NcGRU+tA+aClAGP5/Me0aJgFoTm9sHBCj9tWIupiup+zUmPbSTvXAVeuVe6WUafMkUu5d0tItuTWQaYn460fVU8R+zIHj91tKVesjdTkJj46KxVLFTkx8Iv7aa8VM/WB/YjIjZqtTfhGZx9Mrpr9V1k8s87Gqe1Af30tAgcEB3JkQRz4BvOrxC24ZIMR3/TY4YpYKceNqaqqSZs+n1Gl14SRxmn+s6Ur8eY8dFFKM00U6makI5Kbpqt9HLIFyEj1ytLJjjUyaGQr6fQqD9z1pKqgnzP9w3+ia/Gw/ueXhrcpWgJkpGn7OPrROp0m/8A4PyagcH2U2Adl5m8CBpCRN2A5gwHZh8mT51fwZCB4Klux+2n4qUY849ax6keXfl3qidflrHOrdZakZyVQobnrniUeaKQomSNDQI3o1zHJ1PmavugeSJv7a+Qkk3U86Z+qrQO9NxZKPEoGvk3uRJ87wtP9d/1IkZPOOaBfznrpLMQbw0HTEYVrudLYXsMyiOEhbO61s6yXEY6khQmUmaJPsVGZorX7m9LN75K0y8tnHkPHyXkxs/TVAOSZZ7gmGmimg1Ma5lmuVH81uLK/DjPGNoYaob5MoE/apfrKMy8lJvUy+Vk5FudE3/gqaZnw0bWim1clx5EfO+WTQuFdG4BCAAAGwyPxITPvqgUIPpaKG0GoZj8sq219PmzHZRyTSTVVe+ogTH1kdVOg0mPdf1N2v4+fVuGZI+y1PQl0TlrjVFbmTfK6nfP/wBT5T81NX8oGNY1Jauxsxm0npo27mWuiaNy6AfzMV2sTZ13j2PP2NSEY2t1Jco+aetpT9qleOqjCizCOzI8zxixOrBLUpwrKEuZdjnW+xer+zI1V9vPPydKsE/fZPxSn1Zdb3o8eHf45eqKq7ZzNzcpFWKTVfv43no2VVKM7kOdNGTHzadd0UVuCso/RR8ckTWtib+w70ytrE/WJMoamcpXRXnWqx9Vt3SG5mdCVy9cP5zVUITAEpLY2Rm8d731TEMAyCfCXcuT31u+sUxyoLqxKh+2UCY2eJxG6Q5WOaZ1t/Lnpc3x5sRKTqOEYZNzk5l61pdeMdslVkKU0VP5oceS11Jdbpif9+a1pDIdBNdTNTO/AaKaXYTkRiTSzj/yZJmeupsNF0i1VH9pIKNxIch+c3UoJP4lSj3cHznacZ1VFVIIN2M//EQIfMba3+PNjopWrlGfsMHbJuKuqVjXWvj/AOxb4QV6uUw/9JxYzKY6yUFzPO9bgdZNSQCJG1861qJvIf2CDmMT4k+akRfvVeHYrX2vzLv67vY8jcuNGMkc4h3zFzHM0T3uleuGHkoCUHVV5/Uo4wnvFP6EHYJc7CRGVf8A+IvnEYFtXaruOouZmKiLn5FeDze4qWkjczcmpfM5JJ8wVY8uaJeYpCa1CROXEFDT5q+qNK//AAz+3ehxeoxQrHp6reWpGWyaq/rxAJzLqpLGaa8c/QS7GPPlonHidusZFlX0vM/Sdftp6hZJ4+gb1Tw1wfSBiDcbRexTtBzmKiWKSG3kXAyMxukVyt17V7bizxl9RkeawSY/SSs5ar1VnyUXPNZPj9LjXJfI87h5n7Uelfyz2GJ/459DmtjJ6j03raDIxkyZsPpvUemOYzZRHG4DXUoc/bIgVI6f+NehTPjfkisPoY+O+oKjJlpivVVhScblt+VxYqFyTMycq6e+959di9f7T6v2Ey/+NgrEz8bjcbn9Rgi4mvjqcuqvudi47y8ZYs2S5ZPq6XV6FIAJorprrHFvwvmfvv1dOn09MggSCA0IJB4HkW8T5v8A8We9ZMeX0Xpqx0RGX3P0AMkxGXIYfWYsuKqyEzmZLnGEyNkJG+6eI/599pxej/lh6304Vh9y9Lh9Y6QqckjGSaYCG2WTJjB+xOqYqAz2DLl9p9291j5Er2z1/t3uszEVyTj9Tk9H6lgYjRrPPZ0FzDjyH1g/PSf+cva//pt/G/a/eqlrJhtx1eglweqxc4qyfEcxl5xYsmaunxRZBFknqsdH+odHqB009ag0GpQyqvzpk57AazK6nQrpEVUVP8QsCBCF0v8AtPbXyt/H/U3g9bjeRj5IhDwVQw7vaNlcUNKASNFM3v1S/c8ntnuHtvu2IDN7d6z0nqmCNlcWfNXQ18k3jmo+2U7J6tqRTxf0d5cXqJ3BsowtMdc2Mne/k6eVRK2kaKPt9vUfR3fqfSTGSRJw6qqjtu7pmKvYtzuqPkDqp5hlfL69dHr6ZFRBFQMbMCAotzs9cvSqqtaxYRASsHdG+4BxP0L/ADjDHuv8Yz3EBOshi+UyVlpqcmc9T8Fd3ihm+YuctYw7mC4xCfHvtXqa9s95y4XZ/ktGX4kyfJqBdzLutMIG7qTqVKr659k9x9T79/DZoKpxYzF63/LLV5PS4/iyRGDNeTjGGHFOXnJDrLCwfJ8r8j/zX0V+1+95LnxPzdbI+PU3drio5E5QLnZ8ao+Ek87+m/8ATHV6FSPorNKYtFJzHsoY210fFkf9Pq0NEXglwivsCYxr3v2L+V+sy0Ri9TWD1jcSXtx+n9RilkyY8hk+SM15LnGQcnyuT4qqd5L/ADPcvR/x73/Nnx+v9HPs3uuOLxnqvSTX/hZGWRyeoxZSaxuTIZH5YEGbk4uAfHva/Vf4YzY1nIB6k/yjUcpvEEzTxck9+Umfu0wHG9z+51m9NWa4aWXBVUt1d3M5FyV1uXG6Lu91MGP/AB18YnTX8IBWa+nUaGP8Lg3mACIRBfuYzprNdEgE1DsIRuWn7MXeu49s/i3sXt2V9V7v797d6b0OOyLzTlnPlYnTWbDh0ZWmaJLnJWu/qHc81/5V/wAr48ft+T+M/wARx+o9F7XU0eq9xrJcer91oisBPL2YMeQG2IZyWUnZDUniPuXqar5ZqqyXHRjfoDyPGI535xybEXp1UggTzrmK4E15Mgn7nJVn1XUyTPl0I+NigBhX8L6q6auvVV1TSQRSVTSDuaRBP241l/d9I9FAFMhm5cWWLobObave7+qzZgpmn5ZntxrN00O1e37ItZVCkIrRyh1X8K/jnrPcPXemw+gxRk9V6nc4y9EYIEvJ6r1ObUT6f0+CDr1PqclMY4irujEM/nP+i9HfrPVyqZNmnZWTmhoJxFPmqan41Dml7ZoZ/PQ82XN7T6HH6T0mXLi9R67F8Ga8VOJn0uSNXgXHN1GO6mrylpHxHyDxTJ1W+ZfMR6aQl6QUidlKWp6dHrrFZMU7rjue143Guzr3A9D6b1H8O/iq5MPrKl/k/wDIMF6ze8eojJWK/TYcsFZT2LBkfl9L6fJzXqcsPqPUVM6j09v/AJA90w/w7+G+h/inotnqfccU+t92oyxNBOPn0np/8Fz8kH/smUmi15Cbmvy//APZfTe2YH3TOYuMWEy5PlZuk7q6yTAwMTMVxkar49XzNzuZ+dP+Rv5Dl959+9TkyNVTWTHENVU4ZnLZGOY/WMxxrctV8fnS8n554pHU6xoZqp6RFdZ/5VhAE5gGBIC10dWo0dNy6h6aZB9Ij2J7e2tR7F7fl/knvHpfb48TmyYvkyJuTG0mS96s/S6y1PN7YJ/Z+es/zT3dzem9L/x7/H/jn2/0rjPdPUektcOTIY4xvpxhuHFFFVmuSXItEzHGV/PPPZvXZPYPQVfpdPvHuUTixZSa79F6egpzIc3NLNEdDt1brnj89I/ifs7g9P6ermb9Z7jkknLlxixizT/lz1lKSGrC1po+MHTH1rrqFIA6lQ+WgeqEB6v5ZvXL0pBA/wAgGjYYkefG2t1/H/Yf/pd6L0vp8fMSOFupxGRmMuJm7zZOaOUlqy8c6hHdM0vTeuH0uDZjWDH9Mc2M3jmlMpZmQyUSN3/2Li5nd/GbjNjw+ifjxZYpr00xc5MYY4yi4fnMksyZcs+YuvvQZJuZjcnnP8m9fjMNzGTVl1WT5N3OSGLr48lzKVkG7lxwxFRs6mkk8o9Q9fqgkw4EiCvZrH++ylU0wRFw0ghl7AWAXuNcT737keo9RlC559P2sUcl1Cl5Zm21u6oS+tlGn9T+cX631Oobx7vpJsa643ojJaaxxkh6edAzpdCz+WPUeoc2XKvTorU1vH5x0sOTaNUrSmndzxsudVrL3W08PjLUVvRFVLzr6zwI6mR1LzJFefz1qQKaRSIgGe48cz2zrirrJfpgkTkGynFMxL7DQTM48gmTm9d5GmX6uQbnXOmifE4umZdydFE/lHNkPIbtq6IqREmhxx8hX15OaJ+vK/sWd/jPWZaLmP7y/QJGAu73vwlEOtiPMr0b1v8AKlDfjIBRM62cjwo7uyqpVQrUjpmUrnIIkJMYF5uD3g33dktYVMuDYWjssDnOVD06bcWDJkJruPLk/dNRE0C+FxzUm6GQ8FCj+a30uTJeM2ddZRvUvT3I3NrSsA6efOqPNAJss/qcWP0a0krM40Iv7rJqzVyJJVU0/bYklA710emfTksPUMyV9muRNo8MzPIeTTztqFncAUxa44/4xOD9fbSM+lIxMvaNmfr9NdJ7ZqszVTD8eKp81WPbFCsjX3AIE51VL15PGy9Vl5xlaNO5ycxxdJN6rVuh8/ZddOxlDboPQXv1OHF8aSTw8ySVUIii7I5UaQXT41J+brM0qyRASo5AZ7hfK2N8zsASRqTHTPMv55/xJP8AcEPYCQP1Um75Wn/xRF5O24N73uZzrhJbgVZWudKmSppT92Mk8srrzT4ZNLrOWl3e6f8AJ08yuvr8bf6raGpj6u6Ct8v4NNHj+rPInaNjRs5p+3Smq8bZZ1KbQHyiO/kD97l2TPLVJ1LvXXgsCeVCn7NiLiUBjGUDl4iDCbt24fCH0sPbTHkkB5fjV5p87Q1SglPXPM7qgMZrSo44gcivGz5ZDWtVzzinxzr6iBKOuR8B+KpvIw28zP24WjeOPjKNsrTQfvYsj4Keh0uzup4hiscTVdX1qXc9M8y71Gjc7Jn7b2wWWoAWzCBJ4jfytMdl9ULdv4M6bIQ1Mn1yeUP6xdJJWOvrjXR9dmvGvP8Atf8Aj/W+CEPMAUln1d77pVnw6qip8IFBWjjX/YiLTcvnVHdeADVdTIo7Z0J+Ql3Gmdc3HiDRVSm6r9qUOitA0J/91+P1wm/zSGPz7AW0jDgY8499ueNOq1lSdJqf6WtpL/aTyTQp0IIIwOvxW5un4q4S+qiogdzrog07BQDZ5Of6sv4eOq5quiXl5Ld2Go3zVn6f3OiVfHjykQHew0p51LLVvMzTX7d/UN6qta1tNMyA1JzBEb7z399AxELjhXn8+NGdVtAmpX7skzfPKeK3W2jp/Tvxvf7HE5Orn6oipQUmudc1R5f2T9J871y/ktZORjHtkmH9lVe5+2h8rP16rUlIMmq1MKBVf2s6pl+01YbmqrkJHrXg/T+3z+DALAtMhgSFTa7R+0rTaKhfze3i+8aLJXiGWDgxwpjdqUc0VtCv7HfnSaSvP4AmPZ1H2qcg0beq5Jlv/qzX/wA+Nd6/t+ZjcjzWSTZyH18kySylP+97JyINL/8AV+awmGpvNfZx4nRuBs/1JO019nVSU+NL4mSARaPA5kyW7ImDGkfLO3H8zclGNNLv5PkndbyaV2z5qbBkCeK06f8A8b/t2WaPk8mPWrDk1IqWp9lp3sk0G6SX7Mv4OGPpdaP+0+TqpAK5+wc7nRLpN1/9sCKU/d35uXG0o8V/1q68mnlYnxRab+35Ysi0ceWp4JjfT+rx9LazC3kqZmNePj68rpJ621KcFb2gPgF+pt9knAarKJ1XIQsVqTqum+639v8AtryhJtUU47lnx1IfpmCqoZ3XSVOpKN0m68VrX4XOSqoY8/KaroF8j9mttQaCNa6amDyjViFvGDFmENmC8m8gaQCFsIHa21+bXlaye01lhsMhLQa+P6L42EsAWbZNfVXsZobEaNLrMTNaJklT91t+vRuskG6qf9M7/CyZFAJD6EURLCvmZ35dxZ10sm3f/wBQv4JfUysBDMxM+WryS/Wls/8AVNV9UE0VQePL9VxDGeyYsABKZO2bh4fZR7x9/fRxnQ24z6Bin6eC/wBzmVZdj+8hp+ukUaorck+eofkqbpNdYpyG/tkmdY2CX6gyNbje6fwcZciMzk3YTWqrjxPB8ixO4k18aDNJzXST+XMI0p+uSxb4WgSqYj6Srt+0gH9dLrqhIAziO0HbbPOdUAg1iPCDu2+/6IyZMtE7l1NzBwcxdHjeTVU1106rYIf5BfKvFXe5y18VFzq8mvsSRrGfJ5/3v+h3rhDLRS348k/2IqKY5qgyVM6kFep8wFtzzyFjKXXP4LOF8E3df+xyaMfepBHfk6oZCOS9ET9ib/EZIZA3BEHZe/YRzpZ5P1+gt7fTRSsHUCy5pUrdDs3KiSEdGj91rrR5ZU1lrNUzkCXFkTSpDr7ZJG6aXokiODo1LO6Wm9Yqeeq8zuqP/tM8RVFVseiWpK6JJkUVUuCv2aTJOSaxHgUGS7Uvz4ep1Uyc0LMy0TAAMMbSQWbbIhTbSex/J/ey3xjRmTJkNkJtiUDxVO1upvrmNU7qf6v71zqpXH3JO5q45vzuOlBbopWK3ZrTQfr6ghAwb8NMpOy7GdTPx9+d3CeX/wCpN7dE/iIrmqztyjuGUpZyc9vxyaZ1Wv8Aa6afPmfxeoJcN4UEkC4b++n7W8WuEfv50/5aNVuJNTjOIJdgMV0LIbPNJ0+K1rYgwS/6uqZrudTO6Z5mqJnUld6oX7yj53+Lx8ZFqMTjyRXS2z92dTyLNlwu2cZMbkrdaksKia/cTulz7lmuoHU4r6N9LsDiUDRBWq/HMlQLEjEHLU3Hvo9sebd/PnRZeJ+Pk+/WPupqSXZ0NZV11ulP0MyJtma/BnJVNRX1vGa40z3UIdw29X062apycI7d0kT+/OgPm3tsNLrEqMh5/wBCT5+wr+ZTIuXIf1lwxNGU5u/3e6dwfZDf65p52fheRAusJXGWgvCA03x9osMcWhXMYKMcz/Stb/ygffxpPjEOQPBEk6Vb6noRMs0088s0XTsopnneMKnepa1zrxP/AGK63YmyO6pWZKmhG2T9jj1oJ33Rp8DVI/v8q4mclZfH7prrjkb+u4tXaz5fDtdKz9a/ESAg94SwPr2XvqdsY+o2+mcRqz3i487L+TsH/wCya5CJmloVoWdSf9X7cfg92dVENFXU6SqZb0FY63BMydc0s9Xt0E+YuHKy8u+sbJIRNUmqbqvs7NBWgo1vW5qV7raXOueodFqv+7vqpaHy9eD6jX9fISLEFCxuFBmP5d6f0zH2n8vfWfLEnBFj9sGvj/v0P7qqSnWzLyrWlNczf5lt48JYzX9eKn/ImwTG1+qqWRdk/Wv1+Fiy9/bFTj8fHcckXVuhuJdj/wBTei5dTPPhVxuremaJ3Z8lPF81zISxyvjwwQPldVLFBMQpAQtsHxi3voeytA35zxP1sNGVmjGCxl3WNmwFncfU78TIO6+Nh53ufL5UVZNpRuMunJRp3bOz7bGtj0zPPgNo9NnHGKotu/BQM2yNGsYUik8xvmqmjZv+up/K9fFM6j7bzuq5YkV1E21vfPNMkm9b3s0kkNFgRaGbAI8AQlgNaP2/n5aPcdn9hrWTuOdS0THNZKU5tf7EmtOlrl/IDL8t12GOhti6quo3O4go5p0CWPX28NfYJmMsqpFlWcWaoItHG9+IIE8Tp/ZzNPj8mlxYg7N1yFmqZLNHdzr6TrSBvVcmwa/Bi57odgZtN4ztGjmJv7BEL9POpvXOp1wBMxqYKuK18ZL9vJRLIAutPiFWqTMY5o/9ePMtU01tNw+aA1x2xqTUsnKs2RVQO4Exy2aie53/AG355r7Lca6J0LoXHJGN+09Vzx9YX9aCqtUvvl6ordEVs/Z+Hqm6HfPBKg8ZtuTwtnfDD8iw20wmMmyvT0cr1yoVRy2V0CxS/wBvDdcw1N4+vzI6JyHPZORxQ6ezoliS3X0Jk8k+Sl568ounDNUx1zP3S35CkaKr/XEiWfrWxXnzhOq2PdU/NytzMaK3i6RKOo0SB19pGU0UHFjHGcCHssxKvoyElH8K98xGx03F2ZsmVuP+08r1rnRt0RzdaNXSu268yskt1Fd8/LN3DNEKwOkmnsm5jVf18eWoOippRkyR1VZIY4bY0UOidf1Joo2soUY42ld6Bv8A5MONyUkpHBDjd9nOtQUhUqVF1zQRWg5H8qk0inO6Pgnh3/a2qsO4a8j9N/bRXhv4nVEprJNdeGCWak5EJsJ5mef2la6PyvimamXJ9anSNJpDgnHRQXP2/wBMCzR0Fzv8dL1/WuI+MqnfXyffZFsLRuamagnkg1voD8RJkrJlX63WWoh40z/XXQ+Oao0Jq7o06R1NVxHqeIJni7xYDSucm3doe9v3mbtRKgVp18s82/HIFagCTxUzLzvnnYVs0i1GQcnFVeMDJLkR+olandb3uQqnrHX18HCVscZys0teDoKuv9jHJCn9d+FiU6CcbOStfjKxRjx62/JVxVVTZW6A3dABE66J0tC9vn6sVGI4nFg7F27eSNIeUgMLdpW4jtprX/1OPYc4Lpci15l7ZZfPJy5FTfhkkepvJzj+R3EETEj1TL9ZnlivD5dBp0dT5NfiQC8dFHVRHTtmPkF03c19vk42zXnb+9XKDmxVweChyzaWfIEbXXcowY73rxzO399VP5bIBs7f7CnmdnjVHPYe3GULb2BstF9FOtJS0ccMU5OEnJb+0a6Xk356DQhdc58xqFkpdTr4pXGHF6+0mmJ+sTvXKedJKgvEdJvgtsmhXm4htdE0lprTMfrZp/HVmAUJLpqdzHJjMh9d3vTPmyVKOZ0SgbKRmPl4nEDfE7mznSH87fbFvppZcw62XWRm5dlIUURF2mv7bl+m3dAlcjnGjfcgayr+v9/fHsRXwczID5dmxV1gxZdFrPNNddDayP15oneOu5DWjW9arnRkExOMpTmMs9c1uZGawtV+/wDR8cyT/Yp1r8mYiN/ZQnLexJtuZSSTO1kVcGx9vLC6zNjk4dy4nxM04gx6oyKrX114Bk5rmib/ACcVJ0UNnVRqzaT9f0vIya/r42+KJdicMV1vnZXRskmjUh1KKtCk/ooNbFPwbV3151ZM/wCNHrYGSq8fVrpVHevP3FKgLdjZSivqUrRDOgw3w5xcHkH8p0HMmOJ6lWpSknzNGmaDSchp5/W9H7lYnJPiT63GsaVLXk1vN07ZJqvLQUDy/VlToq7haUJLE1xo1VQc+aPJrQv+tbdDBx4d5FFyTx5gHpJ5+wnhZTe/tz56nU0igQcAe6Fx7WBjIsCsXgjbcC5xnPBAej+NybOe7N5CwgKx452yv/b7J/WRVBZyDVLnHvCdBNRZJPXlQDilCjH1MzPJI0yIJJ+FjyNUjR0U2NHAhy0DTs2mgj9qzQKjnq2mCp8zLPcz9PJLqlN6tDT1JLRuuZWvzSlelhMADYlJsX3gPDxqhuBwgliwzHeQzobSbitz45xG+kq51pqmp6hJ0LX7nwGn8G4bykeR5aUrR/bnmP8AeraJnRtudddcn5ETcwOcFsJL4K52aiKpoTTNNOSegf01+8hKyjuqri4bdzHyF+MT114R0TvVGpoEET+49gsTOULC/LB3/wC0+I89x5xpt2wyAS8Rh65sDI06qm3Vm5XvXRrzj3t/IavHOqn58fX9tG5XT+05qRLaPHjYadn4Ga61jqYYjUY8lk86W9jprhkJWsla8mjwOzrLEHmOWgx8Sbev18u+mEXqhUyb+0jyinf6IMIqFbC0j9YtawSRw/5gNmEJXzbIIq6yAEXc6JJV5ESNZPAalIr/ACa3vnFFSS8n15d9f/ZL8AaPtzW9ICOSl4ieWqdlXjTHjoZoyPjXW+nZP7U0gP4jlAqrrI0z8lIVvYLTWNpmKJ0z9vG2h6rUEpANMBh3KypPjCg3T8rbhB24AsewN70/AH+PEdZKbdsrja0Bua1UlvOtNK9CbncQR1zeLsL3T+9TNEhS7n4xXzIB+p1RtT/0xA7KqSSUOYdcQ5ECUcc7nXPhN7fEQs151NmzX9dyxN9ObegaXl+tVKa35ZBVaNlfiN8WOZ0MNbfXAZiEPFwLJpkqOgSyr4JlaZl0bitzJRylRrQyKa/CvNLMjk1snhmRCNmzJy2kq6Wdj8aIsY7mvWeIySJv6tkEbex/3sJ+7jWXnqQuj+unO2Md5a5szMaEAn5KliezgmYZpqN1oRF8T+BI9r3+VAc3vfbAWhfzsrf7RxOrk5JTzYEQnVl/bnxy0O9X9SnW65ZpKJqmY8b1R83BT8gfZGKTeKaetq61HO0Pqj+ken66pYO5ip+S61uvq0/5P/Zau5/qW6ikrlZMmXHSBKOQguujk3BCX43H1fqDImtdbfxr/IiAr79rlrHE6aBA273Wz2M7TJC1lZcxTk1pcpA0rvdbKqbGSSorZt0/ST6r+NMkuvkmlnWNvkJf6ax03z9VHRBIz40XKsfKJkmlEuf8vPl60MtbnqTeSmoNHGtFA/hGOb/eo0dVTadsE9Grft3re9g+JrVErMf4mINjL2Aknv4dtGZsh4BHk7d83Ohi1px5J00kDo0ITEzVUfaQQijzsOWU+2ZXc7yGiWcO+omamWTik+28m9f1kyeSonRRmXKAUOtWkrDI1c7luv0Esv38068fXHLS65v4+2cgzHUXNXqps54+31alol1Si9VZo/AkpDm9rCCPEe2l9CHB8D9xlcgMpcONefF5NMBU2w5NJO/pyTcz19etuz9Gpy5avW4o4vHKh+8slPVPPWutDQAfvlZPxEpkGsWV2UNzdc3ombrGTZY8fXnl5FZnUvX4xSoluZKKxT+0nIjU7va5A2BStdI9AA1QDAAAG1gJIz7WQPiTgEjN1xeMIgxqZyZcm+oMb0cQJu3R55ybol1qAUqmZqSwr8lyLE5bmRZMeqmndMVqwa/2frJs8FlCTtljJcvT8c1jmz7+VmiSWtq9/wDWNK/SZqaT8Q5tSTIdVM4qrl4FpnaVZKps7QTJsNskqtce8ZHnBl/fT/QcxGCjYE+xtJtY7bxwnJ9iriuC6pndf9a+nlZla6Bmv2v4HVVdLpYpRAiLifHmaa2u6Hx99IvUU/gG6xblJJmRmRxVXI7ZEqvsMyMoPTLoZ3M3c4sJ/urPvqmwSeSslHjnnz43Ah52v4+4Dv8AYDuDPeT3e32Jd0otvdEs7PVjkJnGZCavhb/uksiQ0lfH+tTHKJadHW5wfiqcuNNzj+OjVa15d9Gpu3glaZOtdBLr8SfQeaU+SZSi2Ym9aZrbtx0aHnUv631aHVrzzNGkx35dkQx3SayCj1N089C6jdbVBlTv7D9Zy9D/AMU7fkg8PsAYOr0ZYmZPnegiuqI/ep+gVqvpsDHrSla8cn4G6y75TIxlAgeFDfUsP32iWfqV11OtV+U6+Nn9wc44uTHM1ujwHxs1oqdtPif3snlsnpDHq5krHNZA+nWOaPK9D8upGh5J1R91oM6kptHPvIuEN/yTgCysWYse5fIVlbV35aT7S0tfBKzWxCed3dSVrT90anR43N/kzeM+QyZE5voyV+mjiCG9niuk6if2a2VrVWc05CmUARuKrlrlOo5F3A146rrxM2ku0xLp719EZ+vE2wkp53kpspA0dE6TuSvzGulznC/QbPwswC3YXkEi8c75w0JEBbP/AMjLiqmHx8hOntYmgB6t+rxNSVMm9dcp4Slla4fjWrp3UzLIbZlAaB0O0NPGmUTX9U7slOucZu3J/cLnKxRO4l3zkraTo53O/wAYdTMhkkoJZ5+u8ZI23YHVySlmpl3ypo/OasDI8RPaXZDLYOgHzZe4GUpEQ5BMga2c5SBvHAHYrj2avk1NadEhU6x2NTtXWgm5gurqzir0ZHTIOPzJ9a0SzpQADa8/Z6dbOPdbiuathBuZipqjqP14KSGdvPnW506sRRGisZCPJz1/bt1VLz9aR3RW6DTP128XVFIjAv8AYi20TIuslvnYb7YN8i0SxOtl3hlgaLbvRRZTsADI/oik3Zret7WfJs8F4sRO4LrgJ5Wvk7dnWUZ0UGqPDUYxJqpR0/p4pzCXPiGmGCgrc1qNyT0EyyC68z5EPzbTU4pnt80nDeORx3VDj3kXU8JT/vRKxKunk6mQb4AR2ExftedXSSPmwOzR9NiV7wSuI2MBERX7m8sIxR1M1sMWiZmaiY6qK/rtQ11JdLx0kA76nGpBjG+SeVXbtpLZ88zqt+WaPdZCBeZmolllnG5B11RuuyuqChKaFQncm29PO6sJ41Fb1OpcvgaByftnfNf/ADrGGjb5fXgyog9/lBQOWb82zropMIokJIB1fKAyMe3nOth6XursuC+e+Sxph2aqaqiqFaI1Oyq4nVdfmx9P6vDg9f6D0+XLv1HqLqsbBpx4YkyZfV1N5Jp0wxBz5pvlbxtTrK/riNfGzIi7GqU0Uy1e+qCvIVOodCrXwekfR+7Y/dM+qx7cW3rI48WXGQmGwghxQVlPLov5MbtZnP4bpU9TqFwKaWif8kIOZ9O/00wEfV6X+HIwQ8R53GvpL+N+k9u9N7VBVS5Mjj1nw5IpnLmwnN1m6isb0/JmDczOrnRjDLo/5X7h6r0WOMWfD8J81469Tji+6ricdZpZsGiK6+Wqmrxkk42sNS8d6f8AknqvYPURnwV8/tufPiyrTVxkgap6xzqYyYx3SXLhWctFR8kT3Pqq9v8A5J6HN6v2/iyZTJOWry1izuO7xxERkyfFmxdEFVcxlnioyaZnHH9k9Hrjq9T5+lXV+JXLgcL8t511MVgAFFWvEXEO2Fc3I14f6jJGf3WJ+XHN+5+m9R6CowxO8znx/J6cyU9fY9Q4+zXdMzeP7J+e4+gyY/5H/wAc5MLFGWPT/Fkm6/8AJvH6/wBNBFkYaHNjoPTDOQ/ySXWHkJip+b/5Fk9T6L3IvVYsnp/USyvyDWbHk2ZDFJuBYmfDuQZqfCPu3/HXrfTvp/cPTOScvpvUj6rBgyguKPX4msyXjq4xzgzTZTM8xjctE5OkO34zpj+zR1af/wBnVQQdkRD5BxtOsunUq66ahcekgi7QFze9rIEuTr5R969Pk9F7x6knG6x5rqpkyB0XQzUdqRzNT1WqnQMs9H52XtHqMd4cWa4ZxOORFa+37ZSVYrHP3hF4jm2a+r+W/wDk72o9L7/WT5J4yZBrJUc4neW+fkqZmbaSelRnL3o1cz+aH2HHj+WvSX0maDNilupx48hKY6ixmAZSPE/bI6mjR16fRP8Adp6dQaNIef8AjxxYfSdcRHp6pAwbCbkcWSFhFhr3z/i/1OPJi9/9hqbqcZPueDHkzOOcePLFYrjF0TDRmZOax8uZ3WSUmK8e/wCVPQ48fqryzqqm25Z1c82ZLHKk0def8kajqBo1Qydd/GfV5fQ/zP2tx3lx4vdPTZvbbjFKHqLvFWXFjut4W/kyxjxzlMm7bZYnJJ+a3/kCa9Rn9XDhnHvNQRkqsk4+rvgnM7iAxQ3il2hTyJ8gcX9o9P46uqfR1KAdg4FrMrDlW1vV83w/pAtUcYCIQjAf7Rryb+O+vy4Bxzc2zZhuXrIBVDNlbOZ1/p+m6aYYrJNdlgvJj9Vk9Ihmx+rgz4BmmZyZKOWb3OOqNhqJvmzqHzkg8mw5/wDwPc7jJvfzcL06RsZUdSwIy8+EGZD9Pofy5fWemx5ZuMeT2yJyTUPI4nXVxX2W5va8fF1ix5FiVqvzu9SApSFjHaZnmR93rn6dX4QASQou0QZJLAz7jXPe8Z7x+oyYci/J8mT9T8bOWrZ2KEaZE3ExzQUSLR+arBWV9RjyMtcM4eUNLuab8qbeVMr+t7caFa6H+Q4rz5I90xfbD6vFjr5dH/sIoyaoMu5x0H7yVXV0OhWdd7R6fDn9Rjipb8Tuq1w5Skx3TYv7t8ga5qEGO6gkkz+FMbuArw9pjUlnqEYYIw7b+Dd66b23Dg9LBmz0bArYxWRvct4eENwVUzeMW+/Gqmpl6H2LDk9x9Y5bn5OJyy4cktkQU6ubk1GOOtGSB5SqgtEnS+5E+mv0vt+DLjnIkfLkGUejIfa5/sVo4JiJR1TKdHoP8Ow1FY3mb3ijHRWG583bMXNnPikOs+tyC6qP1HUqFNBqA/C0jkKDjtHJmdb0AeoU7fMw/wDtAN1wEN412X8n93f4z/FMYVHXqMSYskh8hx6VJjIrGI58awsWY3JLrLIl/GuXPm9b7nk9TkKq8vqK5fvU6cnyHQ7U1tbpBGaY5XftX/Mfv+TN62Papqbw+gx44uI3GCPUZMVmWsRuiqrUk3rkYFGtn55L7L6WaymdhZIRnIDS87b1140jE01qbknWty83w3Tq9If4urV66vw3KXfH65GfxNZrqppxSNwEflLWGVrrfZ/b49T6nG5KLyExe1ixmPOP00fXeq3O8ZIa3qgQ/PfPZ8Pp/afTFZXEeuyYuuHhrD6dkYwxv4kzlFHLLwF07CR4z+H+1Y8EV7v6vmMPp5y5P8uFOc3M5IlFnWOL/dfIzOW9ybeDeer9dn9RMZcm6KqLKipSsFuXpvJLkqbeqmFQ+PgruRPy/iq/UD06T8tP40LlU5EqOfaNa9OkUU+o/iqAVO1hvjmy1f8AdPdPU1dzkkzf+XjPiJ1PxZsvesbUZScfJVszy0ZaMv2KGvI/5X7pnmD007Hpx1aCGPnmGrpqWq5VzEo4x0+ar87H3DL6Jx5MuSqxsUZXTiMgcTvG49h8fNaJK7CUgGZ58i9y9Q5c1W1DL3MnJVQlag3wGMxAfWdmPqmeqp/OL4fpUeoVpekRARsyj4P0jE9Wo+ko3SaKAScC/N8SdU8t3eAnJKsZTGOORGeEurF3caV+T67meaKqdlRrZOSgWKnF1L4qoSlrw306J8pTVQ8J2mZcxi48y5LInxNTrMu92tTqX7JPmdyjJP4WM2ralVrK1WmGqV5ADY/9Anzr+51+d9+zk8ROztad9chLxe8Dh8SsbnAeqfqsvWau4r/WLnTTNePv3SbH7nRpB5aah6quTcRGMKviSqk6aWpCSl85Uf3yDIBp3os/qG8qh2TXx6qNaC/F9L00vcqrWvDOij82vs/th6qPX+55q/8ArX2qMVyzpK9d6yzH6XBeODbP1y5r8ujCAao/ETSvP1/xF8fZPUJ1EefZWsRGQdjxrnvdypcV1GQualoOdCNdfUg5yCKSgOyTkk3ssq3klYZLmCCqOBoCaeqoPNrNjqdc6+q3rP5DY54hqHl3ZJUzVeSXo6GndUqbKmt9P62EVO4t3XWDHG7RSqBlLpOp6K1yU7i5h7DYbm5AOVJQkPtB99KfVGEcJIR9Itb2t+kqn1mNSDjHc21O23lp5Ka6ap1s0VQzQP5t8qOMqsbUyuN4JKyJCadrQ7+tb1XmejYv5qfQ136wrqZcOK9Oq81NBrtGrdx9tcFc1K7k3sPUVxR1TrJvdndM7KqjaybxcoeKSa3Piafzz/iT86tURHAhAfnc4toHmFHEJIGIm5ju+NZGPHEsaWaeO5g8v3Vodk7Gd6JrQTX4niUp3PhbFtFOjeM6Nsr4OfC7jU6H8OP8kQyLITLI6rqediTtdiSKyWHFGvIWTHUki7qtZDx4CzwXdHkXkDj7NO90ifZ/iRUkNwjAOR73i2xaaiVt23YPkH3Gg3tPtzOOd7dPVTP1FranL4Enong0xtZ3FE8pCTFLRrthDue2tv2Nz43oHZwoA/eKXxf1rU+OSTilRsQRf00c+HQwYvkBh0yb4PC/08nhrx41v9/1TzL+MbX4mLADKETjfDr3n6eJX8eoMsqm0mq5f8aLdBHZvxIUUPCUbpAdC25miCkHnG/2NWC/t325BZ2eDf1fLpDhPOWcc7SgOWmiSjIzkdyb86/7bNbfP5Dxczysrqhtf6juoiUqWdi60FfbqtGwkCeChGw8q2yk8H7fb6ndRjGmNNVQmiYFZ+vbAauhWkro8nl0mtH4QEO5kqcj4kBI7meNZd+AorRuV0oNUKHO8hY9PHlNn1NE7yO37ups2Kh/pneEvmPPl+Sf+ryT5xrSCbJDR/8APKLop+STcwxj2ePVmZA0du2Zlzkz/J1jPbpePufalFFOjpaLraHMJNbYa1p/CPJ8cpvlTXjrQh5p27K31Bup1568sfT9TUnn5GanR553Mr01LvXJrc7P/ivwKnuXjxq8et0tcMy1NeCok+g9aAHZq4SRUJtZsRBT8wrOom2dJ5Ca9rSbbSxaE9PxxDHXcRO+jWQbk5BkCSiGkkDTc+HQiNzHJHNS9TMVUQJzT/tXSoE3rX7K51r8UTu4Zb+muAocfXUgVXRV1U6GV1s1O9h+Tl3YBsOytNhPSu5H9EKCG6K/qIptiKQMg+NsPbjm+iDhYAHH2nsuLDNzRIwWHONJKxw1M9A6aXa7f0zRtXn7R/49yZR/S7xWmzRvrC1XhJrGtajSzfOq1rJPJwIqUB4nXU/VNT1Pg5jnVGwd7/G3n+sv1QDHrnQ06mcgjPk+3mQ1pQX+t0ikySGjaAjIm52EfTRm3m233OLxoByYomDWTfOr/dboEavckzNT58FICOt/gz0OSanyVf2adyaN15/6Tuqmp0/qTyec3Ts2W8ZNRwpoo1UKgBt6rQ/vRt/Cq+Lq+iqvFixdc1rFVfud1X1gJ2+aU1Ts2fgwFdC2YFnuVeWdV4a/b6rnyNFuCJmp2ZZMVWCatBGslfZU2KT3qf2PhNJxxJi0amYSeWTRuLq0Tpr9mjrw6JRFG0TxLAO/qGRxu9Aq7rY9B9nqTzy0yMTdIJP273SC4zhSSpS0pJCdSqgD5/HMRKjGONwBtzYI8bG/8/IF6DJ8k3UlNY7qKa2hOx/szvHCAUP6mNO6arm0FuOFnQTE6FAnztpRp2iOv3J5nreq5NQOPqN3QS0l6mj6vTuJSTUn7dvCLR+Ncl/ROdH+LdG1p2ddfs2f9tBufE7lPyggyzdqIhHljlMrSYZ3uuQiyR7Twuczc94PkrqzHRs+01IbiaarzVIjIg6AfG1AtnSMJM4KPE68f2Xrsxg8u9a5Y+xJ+NMmP7bFVqJpET6yE1V/XX+pqBJ1U606/AMmRevLM1OJArbr9XReijxy1rx5/wC00fgfxYLkAAcdriF2iw0rHx90I2dk/GdTy4hqJEa6cfJrF2TqizUeOa8n1CeqEaWJmInLkbCbr6S8uT5EKOf1zS8zqdzvdT143ONzJSRPY31Tvq6kKfFcj/2eyHySMmn8iiZje1q2GDw3in/W08Y5kErQr/Z5mZ/KCXEeIGy8Ji3pUDVWAHbCv/Le1hovmrU9QZFqdcDTHTsezUxcp+qJltK8u9gzVaIo6anI7cf1noOKQ39VNY/K1T9mqPzMoY4jJLSJBY2EM1TTMks6of0a1M01t1y5Xw5olFxhRorRQbG4Cd6ndHkryzQvJuEyT6V75/UQdzZ6Nx44Ijj+LTCvhCZ0Klb4qdZVkPs6Cfosnl0f13o/FCdZGymqqol2bGtBqtE6/acedf7f6UUNvnVE9F1upqqmWKT/ACaAJ6Jo2viVK81FOB0RVCohwSdPGitt789bs8LvHv8AT+JmAChjsVg/xCHotbBApjY5M+I4djptZahm/kNyQWcNcyM76HnchPl/t9Fepq/wsq3kpkid4ukSSq2H3OulUpmUV19XSn4q9RZjGXiSsjWmHlOYad/JVarzGj9G/wC1Kt7O9s1NoaZjcSFXjfs0b39T6yyO9eVYqKIJYYIXjZFzdCYutI/qB2775G+Rtbl/xJGSVzWkqHfxk+N9STwu+QhlV07QaszzVfHsmsp8sofHzQNH08WfuNrOhJp5qgb8bzjleqrWSX5PDjrXGJtfPHgAZL3QK8AjMuBmw0vO50xJVc0Phn6PFIU9ePHgBDYEiyP23857ix0e0bnbe73niHpmTI7n6jBzjoiNtaBGGV+v1slU1ujlIJ/F3UZEnrf6d6653z/jSaqjwqzM+Hf7KGTx18eMO5u6rHW9DRVgxu6NTM1Otcj5ed1rcTUTlMnjZvvc71VXoqU5kXXj/wCpCjTrxLwSwc229lP7jT/P+ePpoK6sxwRzDcY6oXHM1Es9Ib+pom9PTpNMHm4z8cyjDQRjEP8ASbjK5NulTTQN7JSV/A83GSsUzFELXyMjVnLVx12KtSNNePIzxpEmWsYS1N1THKyrO+WJq/1qalKnlQVA2q2HL4ukQGBadrYejPD/AJs/GjyY7kSL+WHJj5Dr6SgyVUH62aZZQ/8AhnwL8Pncy+IqKxjRYuq0f/Fb+6+f1X+95V5ZXFctNVzFFA30zEKleY/eqmJ50Tv97yslyjjiOknHbM0HdUyVXT9q3O3IyE6QK1fMk72iO6tsDs1HbSJSxFuYiGTgxnTsUxWHtsk7norXXXMmkrX0HSB5POtaX8XVXUpjud7x0U1GnzH9WtnyJrj+v9iEOhI+N+OpBiS8UsHjXUnk5KaOydGma5odb3+Bx9zcv2q8k/eQ1P1IHwmO/IS+VOfOzh1GEhynJJ7vafdEaMZ/3HFuFbTW/IMwZOfjMbJLXKTNY3JRX9tBsaNcsiyfguyqlJrJ8vS6KuTQzk62Sgpz9Tym+dv5lziPjQiq09NK6frZ1lF8tGgnzUhLsB/MY6mchaVqWrbWGKp3GvFalZklP19Te/FAHNxDTdj+W3EHVLifGJIL2/ZTqcd09nNBqiuvKU1JVfEvFT5d6AnXKa2DoynxlVjkGXHrig6NPyeK8LX3cmmk2coDVTMcb4Rx2V0aQmmXqWpV5mTzvaf20x+TFBjlw24qMZspgVlG5YPH/wAA7/pKOj8ASIyBHfH8Y7PUxHaD7KyEwPyOrczdxDWstwzM5ZojqSCnHav7lFJZCl++9lKtDmbpmAm6I+OvjchevkmStVRyJupZ5ZkaCvwpMgUkuWVmzzqlamZGvATvwh1z0aSaT8jnJTdv7Rydb45kt1LT5rvxpDymit/jJCGDdC4JUnybHTY9kyUNtv4Xh6fG43j6h6RE0k47nmesmmSJtJWQBvc6b8jWOr1TGgvHOzT8l+RadNrpPu8ldX0a3QOOaoq2o3c1e628hzzEqa34oYJ1P28HjUy21lkj5JrUyM7rG1MEzDuOmGfjCQG1Z10iCU0iY/dPAsruN0Kshemxn344sUcZ0NT8cxud2sY4iaadvji0l1pl+Q35OQOZa/Hc5AYbmD4t1538mvrydRto1Js1HP1x7TpRVXTNdFlSQ/U1jq6dUVrnxqt3M9bXwr4IpbkrQH+LuXXdGwbuv+v/AG6n9aPrLHSCMAcRwDY7wfGdMY399rH/AFbfRaMMy6lm052NMb/oVevHxUeNn9Xcynj8B3umZV13so246d8KblvwEa8S0O39/g1fqKqdkk9ON+tEwnO8m0Tpeua0efHPTZ+RMlZc0IqCw34FZj/E/vuStpMamnvSIfjewTKneCZRsMi+h8AOCd1jxcrzyuKIhm9wzWgYqrTUyUtapnaM2yIb6JrW7NZJx/HKhTjgOZfKss5LpE/S/cGtw60efxORqrxf0Oal/wAh/wC1lJZWneT9pquN8uzYbZk81/5EnbyYfMSjt+rNQnMaD778O/7cp+MEogMpJbIS92rEfbRuv5GfH00zJ01Nyg9QDOpjWvrkaOv3WyivqvI60hiTfjJHTGYnvpk07riS9/2aRqSPLqiaNgNVWsnNUmseTmhofDVEwVOvKDrw6FWevzBdifR1z0U014Hpsp0nQWs7N682v4vUod7QIt9xuUe0aCfzX0Qt+mexmruv/upMkwBo2+A73VKB539TkldseGXdYd1cwuXKmO9rv9VK11IzJOxXr/sTuLAYxfHd8/HQwXI6ZJd0nZoKlDXKVpUKWomuK5L/AMhsaqZSmaYrqYno5Ntfuf7Jcn2o2FwTn/8AuhZg/wAD0c3G0Wd9/Y2a1aIx21dWMQuTsZ6qjijElSE+XdTNfU2brRX4Ftht0zT9FCtC/SW6NHLM7ZKNVs3p2jFmoy3HZzWqO+Q2/G8R/aepdzs+tD+9p+M+1f0vb1PL/V4mp0PWuVXdEh+01Nm/yqVVaFBEXgPJyogAndFhGBePaJEvuhvjTN3KpJkq9PU+K6yeTF2JIfvx/wBl68nj8HrJa1e52/FiJ0HgkP3JKOqCgpt8+PP5FHX6p/8AwteaCjfnGd+a3rwTy6PDs8ljyZMtVF7CR+wHW5nRqr8v9k3INPM6KV/KCCG8jk4cFL2Yfd2zyLvcFSLc22OijLJO+NCGOt/7yf7XqmpkrS3rZsk3X4ymp1Wyy+N6IWMmRkamhknTOwdLsoHakVM/CBRC8TVaJMj0Vpp2000dUfV4TZXGhme2okYS9i1SVjx6/wAc9D0lJzqeU3rVT00XAjFitngtQZURZ6d443AxdZV4UQdNvabdY7CcFJHOutDbW6nQG6rXT5Q2fle6r5eC5+sV1QbaZp8n+nKNHIaS0eZdSvzVlxcTiqVSO5Y+sp4LGmVqpkNqU0s1Oq6rXRjLqh2ZIyeS6J7041lXfSb5snUUfXXmUzqKKAWSoCKY+shAGMiIZJStniwyuyggbtbKW7i1Jmia8pMtkzMuy/NS7+vMz01MsyhSEmSL1P3KmqJStSa6kp2T19TjQDR9fFUINtUffjk6JXZk+OQrrt61X0Cf6VP0aXlmM6jv+826dfvFVozuu0QCqmap+p0DrloIBmTyBLR2dlcO7RIOlA2ByQFH3IsSYeYepocmpL53zunQPj/1yHUlPWgkmtanf2nQYSYWMcpMRQ3aQ5E4LAo+32351PU6gmU8lOKReDwnyTq4kNgGPYb2+NTO3vYL+vyMgmORQX440RWnbSlO9r4O639o8O9H49jtt4AAgcwLZ20wFO8jyAojZZI+mmbx5Mnfx/JonHfJBqkP8gtUy+U6ofGjyA/k1E19xIs1Ru5/9ZpqKPMib/qf2VFNx+KZcc7cnXdFmq+sY24OOllbNSON2SPJLLv8Zpyn1CeHFSdMzkiSS0nlo6+nMbZTYbfxQIQGTjzOBa73GDRsF4MuOSJVsdrIp1q527Joql5bCQ5e1a2vlCZvXOxOlszxGN54+hHOiimv1kprzItKPA8gbdNK5MuqdzCClO+yRIIvsetJ900oMrt/DXJimUflBgJVpIWeUyfXk/v9Z/rQLL4FEEcBWMQUjvJFh/kpMgySRDWTYkW4iRL27aZVcSUsJMEpMfIVV6StyiZN7ql4qSd/vcgzDzPj+uMPKbKp0FKDJXianW5Z5Nch+BPW1pMp8f0nXQvJoxJyRU6WX7eeqh28/kuapkqzegxeTx5PGmhrSFJknWyZ+ux2QUzEIKTedhhAOAAHB0hO88AbQAHH5WJwC5cbU5Imp+ScUV/uZqSZH5EGXzRZJXXjXRReFWvEdzjnHUtoLVHxyCrRxO/LjAD9T+z8HJlKyGP6nMEtyeGh1M3VD01SzVSPTPBr7rBxF74UyFWwyVw1J9o0hIJQb8/unrwfgADY5kiMgRspm5MrOmI2H3RWbd2ro6M3h4mUFA3JweZZMja8+dkbJ0m/9X4gy78Guog7ImTXBCJVNDSILJWtvX7PzNSzKu7yaJ3WqmnmZLXxjnfnR58bHlk/JcU4cZ45p+M2CNXX6qsjp8VJCs+ZlEefNAWSiUMQPPBumELaoQv0sI+htbkCRqP8Ay7vWSyy45eD6f4snGkApdS1XO2VKVLK4+RqUkZMbIY9gkxtVeEfFHn6/wDydGAuUpqamI7kuZ+MyfT649890QAV5di6p1IOS+Y6dSVUT946s6oVZPDEs5OelZ1RpGgRsTa0XEKX+GwIsMh7LF7hjkR9kM7DjTeb27PtK0PWhJ8THVbqtgafrNyMoMlfg461mNcwc1PaLhK1IUNL5KJJslT+nnQ0UjU7lZ1jYr9tNTyfc2vK7Nn7k4TUFfiMM5NXUVKmSzi3SHjJTivY68ckVE6fLNdD+ZXANw+ASiOALKfznS9QaC5CkIhykji476t3aVCOq+seDluuhnnpdbF60G0J3p+wTU46qscB9zd+QlvhAro3jKHag/XwP7EeKuZN1zalPhWGBxrX/wBvmdwTOxJ0c0yBFukkd7Ki0x7Cn/sz9Cej67nbT/avxwQCBD9h5sxb89DMGfphcXHcvmNWNZPozeuie+6WJmqd0UMzM6GQGwKQKlT8mjc650nNEn+OajH9aJ29o7Nf9UNI1+qUZhHkprXxMv8Adugda3XJP6lI2O8dEcl/jvkyJHlfpjK5edR0CfJWv8koD0Sb8JsdrKE2sHcC5/lwnpwZQxsfTbwu+99FbkLhL5+0r0E96Q0bH5KRl0szeq2Pj8sl1/0fkbOv6ix2a11/VmaknR3O6DQuvytXx18c7a4f7Gw1O5nHu/L1WzxrfPO9zKmgof10lSqpxLB8bt6dmidh06NDp/IqCFkcS7p/8hs+02kzeDefqUxfFxvvaxZoxm6p2Vo3PSm4JG70aaCpp5nRQE1AfjC8jbfWpyJonYTjtKk65JOUevC6U8tVLTHuarXJjIqSqFyUEiE1C/Htk/29yTYO38uROSnYM6xjrfyTuVjo6l3k09zybSg3SaeSskm3/iGm7lgmU9vOJNRBGADf2xYbbfncJceKTBe6Od60+Kk/yVUviDl46AmaV6nyOw+asyXxzldXc7K0g43a+NtB9OfBjPvp/KUZOS6qV6fiCw2VRBobCSOuqHRU/YD9i/FS/avqzU44ZHr5CjnJdXO02UFfs53zqaDj6qAFxNvIxeeAkcknTmC4thABOAL+wnfW6x1SzB++qgZ/tvVNd67/AMUH7Aj6aqjjR+bPF1mhxwcUc1XSSNYTVElqjTXO9S1usdLrr81fp0xXuV+S/AA6ilElTk43OhFpRNHZBt/TbqZLCfkyFWkushWnql28f66nxwyyP6/OHqQDIRkdkOYR/fW1D9UKcAokRubbtnu9bz0+MoglmPBfaGNvHCzyty/I0+ZrZ19t2qP51PsHtGL3b3D0/p8/qp9D6KJy5PX+45MLc+i9BhgyZvU0NTkrITFThPBlzXGMqVK/Oawpk1EtSwSXLQSuM1UDTVT0PnHqFBkTUU7L1GZ9P7J66YP8vrr9P7dqqyBGB69X6g75k/tgxAm9G4qWvN+P1R/c6lPTBINRpEYJUjlB/Ya6BFYCYGJ4QPcD6jvr18n/AIu9XgPbvaPc/WYPUbjBj9f6mcN4s9Taf+R6mZ+W/TxX+F6nHjioeYGGX84b3z+Pet9qzbvGZ/T2uT0/rfSeo+X0XqXHVVE4MnmKCJ6rCpk1NVUatmfD/a/V58Pq/m+PJmyHycRu67mAuWyZlxzIJFQpNhUFcD+ezfx7+ZYr9Pn9JnK9Z7Zdy+4ey+o+MyY53zm9V6MxzLhzwbmbOZ30XK1o7KfhK/hwKun1K+oGPVTWiTh01EQUyNhtGrHVFfy1U+k2ApMYLJPtw0oWuWr3e/TOb0PrN17fnyeVZowZKNY/UemPoa8UUhQ6+i3p/N3/ABD+V5v497qdZV9q9Tz6b1mDVXirFdD3EwRjL+HlNN8hehGsTqP5t7HHoM2D13oX/wAr2f1uNz+i9cVyzMG79F6jxRi9Z6cv4s2JoPHyD+6vz6PUV6SzsmsWSoYrfXPf6maUJqDrmft51ljy6esU0fEUGn00+moItsVFcfiB2+uuavqdXp1l4SRt+EiVKETyNfQX/IXt/p/VZcXuPpsmK/Tepxl4SIm5mcplyQ9RtxVE82zRfxRqjJk8JU/499Xl9u9zx4aoufU4a9O3dBjxxkuWdFOOYqMtXIDw3czfxjkL0fsHuub3T0M+2ZslZPWekx1fpvlfH/jRP3wyrzkmaq6x45jmqfLNQP4j0l5fSe4Y1ujL8+5rHPmsfy1NY2q5qfsSccytVw/5KUn+yuj1OgZVJAJ7CZ7DsiO2wrFdQ6ggGoEoAhkBi5N1AC5363/k/wBrx+6+izZha9V6WcmXHU44++G6pyYtYynHk51lZ+sxxj0RuD88P/j3qpvJ/wCPXeT1vpemL7sc3pMboqXbTeOzdSD3LBWuar8979y9TOTP0y4quKy5dZvOeRqckY8dt9xc38dTVJYEfaMUD4L796PN7B71Pr/Q1vFWQ9VgonmWcsVly+nuoCa0D1q+PE1LUvhfA+vp0egkxbb2N1IgfnqeuxV6u0gfNKLM7COOXr0H3DJeO/Z/c4Ix37d7h6HNjAcc04skfLQ41s+hq2al5ihOsc1+br+XYsWD1vuXpuoyzm9RTiyXiyY6jJ6iS5un6zUTH/seruMy8AJM83g9Zi9b7QZsc/TJBOS6jtnJS5qaCrd4iQc3W8cfE6rSnafym49Vh9Bkw4jBVeg9JlyenoFzfHhro+Fb19nTTkPkx3OJr69VXXPp6/SLcKpXAJpIkSBiNr760sio2PykA/5GpfsylbXzF/JcV4/U/ICpkqF1tpqndlEyJMvhnZSprRp3P8Y94t69Nn38WSf/ABs9kdV/kjGTklqp8xJ5rwzjSmaZo/LH8t9Iepx1csjD1PONJpmOmn7d72ouyE6VXXPn3tuZxesRiq7v683o7foeXnkHJR+mpWWE0H5YqqFRBP4xLxYi6talFN+fPJNFZFmSDbOzvtEMmdeoe448de0etwuWKPResqpOkmseeKkqTXx0FSf15x73LPkY1P8AHK36jLG8bSvmo0TM1CFXXj4dm/IFOwZoKDz5fVHtvudZaN0YIVneTZkyV9frPUfGV1k5ajaq6yT+az+O+pyY8l/EB0u8lYwqdk7k6Zx0aaIkEu2RBndSDV6zSwigdlhAm/7vS9Z9dJTS5EW5+wvB11dOX3H3gmshdGXZjJebma0FUzU8fagV18cVjQd0+tey5b9Lhyepy4prF6T0+8owRGsPCZYnJknVpqcVyEzQ49N/Z8v9iZyZ/X+prjq7ccZKw0vbQliaWJmesj0vf2N0J+dP/MPVHtf8XsMzWf3CokydU5CXG1liknwaJrLhHrapbCz+R1aQaRTmo2AUGT9o4Izrr6dXppNfFRO/zH0/ozKfE+J/yj3PN7v716jNlausme5g7tRclhNVQVrlR0gRqTkl32/8Y9jx+6Z/Q+hqzHFfC5bxTDJjVNbdmTLY/WAmcg0Tyy0eZ+34z1Xr82cqJx4NkzUdHY6K0fdRrbkWWd7ofD+e8+g9fH8O/jPqfeaMWX3L15XpfbITeefVUReN51jqMXp9d5j7y2SEmID82o+Wgmkz+GgKFASBGO3OsOkPVWayXTera6Re9v11s/5T7pOOsH8V9AmHB6Ccd+vy4bObyYSpxYMnxt47yZI/9r9ZepiSJnu62HLfpvT4pMVdWT4LZJogce8jX+QdZMkymzVc7xtTXJe2mUw5PVetyVXq/W1fqfUeos+TLkz5iro/rNMVf96roo5Ro/OjjLr004pktx9Vk6BydYZgRqsnZW35ImoOSnGyPUmPVo9HSPqEm5OWAXvctDhTremo11EmAIDn02RED2QjZa0Hvvrr9NiceE85aqoV6cbkxqVlsYP8SU1jZonkrWomXgMtZIPtZV5g7QP3kS06rmJ5J6I47bbZVdHT+7Zbz2U1P0pqpqOcazaOhl6XepdlpLLpk3xvrc7ksx7+k5uJ8EbtUKTvczYE7KATfnVU49IAC0mPsJV7GzD865urUSzcXaD/AC2kS5HZYeozWdSEzfxzJs6lOf8AyPvFUvjXyBMlePDvWzcX/j+k7pCXGxQp8s1y000pUSaULPrNb0bZ/KvpcWXLkn5V1j0RK1xdRUf9WqclV58c6s7mgdbH3319yR6XGEtMuUCsZ+vjikF815qhPGiaA6a1SZ+oH8X0KhayBCNRNvAx943xrS+oqsjRWSTm6rxP9n/4Xy00uimdaN+ElfRfV+lj2n+D/wAfmU+X3r1nqfdvUs1txThp9J6OLJkqZIx5rnHShOS3Gn3J83xuvKE1MsHiluqCf0bt3ugyBOmSSK1s73+Qe5R6v2H+ORSTj9L7K4THwxzkxZ880ytMi3dXI7TdVyABlV6jVQQl6mRwAUdri3tGjplespRjYkfyN+y80929Y+ozL9WJqYqiGirnY2Lb5N9NedFf9nbW8vIT6f0csz0+nh8cbdxMzH2dxVO+if8AfgS3Zy3G8tbAdpU7VaaA0eTe1CjbNRs2b/Ol9ePx+mhqeYnFIO8fO4/9aB2H/wBx5Zd6+tn5pRU2cQ0YCNPbc2H0WkzJF3MSwRGCkRf89X/avnazXqShqeqBuvMDint3U62zsFE8Nlfl3KXdZKVPNREftUBmYmzbP9v6lPmoPtRur7SB6VydTy3XNK/IHLvH9gSXxEguqNDO5R1PXXVVuV1RsZxyMjuqFf8AUkg1WhJqVfP6xFXUJIZKkbECXlbESbaAHSrEy5WJU8XgeNcdOWZ3ioTllPH9U+MJrbLUv2Nk+URSo8zSZJKnWOijqapF3R1HO1UWdT0bJRnafkkTNRU+PiZOkBU50+SqXS6a10nCNA/k5O76WU1Q6OpK5mWqR6sr9HjQ/p87Pz7QAov/ALQBwPSb33G2bzphriFGFTM7TP0haG4nmU8o4+T7JRLytIbK8DfnlkfGh/GTSa6SqyVNzc8kT1CTNVRNHNH/AMDVbKRB/Im2QcnGVZ0kyVcwAo26JqKjbuVVEmloV3aQPWjJmmpanesabRd6iTz8fNH/AGZ30i7SIyaSJwwS+e//AB1QM5tvaQsp8XXjTPpqt2624hdtVf04nugPG0alN7ZCNTsiq/0c1OPk1oDk58t/2f8AWzTaMPOkQlx2/Q53rUsAlTrkadz4HVK9OtKPL+ZRTsXdHLsTyf45IaXtoX9aGt8/v8ASrygIyYkzALFpSMEnRz7fwf69idEm0ZKt6lv9mi/FQ1Nc6dcnOwXwL9fwr54qyTUvw1HXNQOtFklJx4lV5ZSk/QSYza711PyMrWv3L8fT/wBXRXMnnTIn6/Fzkk18f1FN1O5nq/ITouWSt09Gx8G9SfhaMn6fRlA5+j0fnxL7fSVA9iggpyLRM71L0nyahSXUzoDqNLzXnXgn8yQLbMdDeq/toBRIedHP1Weev063Mk/ky5CSDLKFE7Tbya/eRNT5Nc6P26Nu0OrldV2KSVprQpr7bAT9Gv6qVo+x+TZQ0pe3pZhrZWAaJY0kBIuQTzjuvveLaJiZwz5J7Zs/3s2ldUSM44Q/rs/ubP8AWZE5InXRUY0IZTX+uuXdFf2oP/ltBGY+W1IkqZ18a1o3R/WI6pDdV/YN15Nb2pVbzOiY3MTXP06Ogt1TQ/sarXVrzoDf5QVsRSPTfDXfOGr20bjbj33fMZ0BJlK6GLnJPQ1rf9SohT9DpHcMprzXKHVvgxv+oh+rrxWtp5K/Q1XnW3/W/wAxyTUhEUdMSs4+ZcnnVKrro2NeKa8CSdfk93JPOMHRja+8hXjdVtN/qhyf7qdaRVdPpJDICklB3/ORm4WNMHbImJK7QUj9FpoYXr6J9Xc1qaETq5aKq+Xxtemv7DqFCqOTVgBK6/7bZ0LpO62qpvzSvl/AO3+2wifKa5yVFeC6Xdb8Cni9GPy/j8eOGbanlFyS0y71MpAVPTJVbnx9tIBRK6NwBi6K7k8bWXYaa7Yf89t1bQ4yN7AZob20cq6eKd/pXfOp1W4/bNE3U0QI6J83/Xq0TmmqKSpZGp11M6BR/FphqvE3jXNzuk+PX6J3U9BW/wBaQ5T/AEP4dL3JX7mpgo8Q3NcyU0+ejW08Ogrmjf4Y+05gY4gs5Y5X82xx+2+2m44Wd/of8qdmuQr6G50JoeZJJXWwp0Dnh0BzQTLzBPjc/faJPP6VkRH9ANH945YWurKqOqkmXnTskkCzRoRPP6pJWdz1UB/kse9DUlk1rcVonxoP20GyzrVT5eZmCEghNgbaXcfuUJ42nidRktu/9+Ax8g6q5jktaVBXko1Wk/8Ajf4d1xU7ZaqZh6KCbrw5HIsrSSjemlCQ0bFuLZ98hy6ybKmnl5573qk1+jzT+h8mgxc1NZLvcgxA/axCX+lRuR3oDXI3o3p/AE5AmcWi22F2AWdMf6/ht241abrJU1XJzcYh0c8k/wBnpbpp8V+yg/672BTzfeNapZLlFhWzQGolkZ0P7mmZ2mxDfBBXNrPHTV1zNTqLrJTrcvQoFG2tLL+HW2oED6YwfBBtE+SrVruTdUamvAh4WycbHdXRzwDb/T/n87ajLWPZ1NVJRI6fFCnPkrGwTf8A1TyVoOfJTnIxka8/KG5nWocfIdCBUx0T1P6/1X7V3WVZJjEoxLHP9r14ycNPhg1NAJVeZDZ+TNnmqkotH7SaMz1qitE8ymj6uk0fpn8zLJgp89tsn3HbSLu8j+bt3NuNT/h4ipp13JvXWTg8sURtnmaP7Uzy0O5dSWizcVGvrWhgagHXc86KImdxtEkGt6ZhZx1jueRZjGzQOPbUsXdQzP2V343PLXgr8XlmuZ52u4GZ+kkVT0KaoJyaPtKT/UnzyNrACVo2mODsxY3Oi36Cbz+tp43dFL1udy1UNO2vtzPbWR74P9NQOkAE04tVQLMGPd1VfVy1jdO2jq2ivOiBkZ2WH4lFyrN/W/8AKy1yadNYtm+01o3SmnT50l+wdNHZUO9FTTj6xjdbY26AJ62n+oaG7AXvvb7i4PYymQiFbyrSuRG68aL1Bh4Eap/xMuhcUrTU0P0Y8DzDtBf1oAMZYMUFQzsuhunGbsorrrShOne/r9Z0sOS+gnEzj0zVXTTaVI8TZAKlc0irqTmoo/Jag5RJjmRiUxsqyfvprQUFc/s1/p+rg8g/Qwpg7pb6ep1NBsalydFeZN/o/s+MdeVdCaf0zthqdZ4+spD5f3JMycSWeQ+3LPPPNDpKfw965pBGfhaJ0OR5B3VJK65adUIyben8ReSTQaLyMTd/12vIV3X9l/yHiaOf9IP4GESZSUZxdmTv9ZJGXEeP48399OxV9MYa5CdzyY6pnX2ClXxQUVt2Iym1HLdK2BcNTt41rJXCP1eYqTxTTzrmzqKfyJKo5qdfaQ1qZqp0BXa9dKm/G96TYqEsRfLNEVs0lcFbOZo0TcddaSQnVEvW95B1IGwQODgefr7aXv3D4HZZzw9Fk43NmN+SQralVVSlVFToKadf78B53PPOXkchGZxPR/iYTemo8X/duVqg+3k551rVMY5U6uxOaiT9kfpUlSgU0alry0K/g5LZiaH6fSdY9yMUr/kqa1vwCgEqL1t/Kd2Lo+YT/K44KWhRxl7Z2sLY/Iu6x6rLFBLOOWerPHGo8su/2lzr668P2n8ySCfk5f8ALW5Nx0NBrFQzqZS/sLv/AGrJJ+DV5nWso1zGnU6J/VzW5Vo2TzUqvj9q/guZxcbJTRJKUY5p/pY1Wn+q9f8A/NGwLwLNcHm/G550cJjsPH8xtOmy6PHOTd6g0UDXnGd1oKjSEiEu0PPkDq6yAPU1R3WjdbNQj0s01QEgu+P7hQtaaqLP91TTqdaQ+MfsEu+Y5JXTrSr+Ow/HmpnXxsnZf1xlVJPL9t31+yo8N/WEPrtifTJxuBaE4t2Kw7n822/n01LFmrvK2/HSGnmPEizoCtad5KNyyqNvgbdsx1E/45qWaOUPJNP7q6Jk06Kn9+dP47HlDbmwaqq43y0pqRl7Tl8VY6Teyp6nTBkw/LohV2zpVmzSzetTjjCMvJvl/r4E/HBSqD7ljBvPAtF8aZtH5nbf+XZzqOoyfHsv+2KGv6xokN7qmia0b/8AgNHkivxl5YkDl+qTNduv+rjasdu/+3Ohkk0+RKcc01DLVl/Ia15nGH0ao1RY/XRp8migTPiit80S/IUda+0HLPK9TYNAAyfsH+v4TgBnJVoZkR+kLOjeNuXA3s9S5MuOTn7dXNarmsUtzCUVLrHzUujT/wDOqaoQrVv+buXuqFMWmWjcv9X/ACf13OxDmUUr8OSfhyU//Fnl+4pjqeCiDnqSJrlXpDnQFfFSnIUVNbqq0VuYCsZddNPh0SH6o8MD+VMCJ+4X8+mj+T43Znax7CHuW3+omsemkNn9XGC0y1Ow2o6DZvaxNZYH47HpnJU11UyWT92j6zWppTQE7f67/IrCY6eDRVVekHgQdLKjLX72eed06rf4I813NE1WKiv7JFV1qeZkliJh2MqL4EdDkXu4WJEYOPocRpywb/rCH8EozptL1CEtXETXcmi70mRqNaN9g6X66J1Rsac32XafLUKy9nevJZxqRl8njw0TuV/A3Iwa5NTHcnJQs1LW6Xzqu2QP/jyLVguDzRMzJxX0/sz4cmulKBdVWtJk2Ot/gC3Np4UOdvrYRGl2C+37bfx6qZYfk5Rlcxr7GtDH1adnlXnj+36/fn8sw45n/wBIm6glKZHZxtq3cSuiuPAck1yqurvLPV1r455mt755nVQv/s66p2EmwDfgv8mcpAVTzsmTRt6deaaP0qbXVfSnSz5QM1IOEz/8bHGeNt9Ax/rhGPe23Zhkkom2qKorc+fHjUXRQMa3Op/U/UP9KtY4qmJ13kmjm5+k0CDcf9D/AHPLc6E/YTHc/PjxH2T77ryR0xzut6XpSQPjXxpTX5MY67tMpyl5Oq/3tNBKMdRop5148H7fwk2pBINw4SP8IyPAEJ547cZEbRbTa8HKfbLkEudrjxZTx9wJJkXfAsj9B35DJEmI6sXUzKck5JpJC3f2u/8A7etycvNO/wAHvOUJXcyxj8ivHhm5lJIf39/J10HjZT/hiv7w/wCshuoHs2/Eb3PLfgI8dbkejRabGwm+yhRi/nsWCVgPJEfwwziBqq4+OmXXkysdwhDX2kakRProk0/7Xxo53l1V1NTOMuBThNlR346q0P2fV1/Y1P4NkPx48lvG/MB2FjIRlujfP+OhNDzPg6HZlRITVHDCHmbBUIj7ImxJ1o+3ROrd/gBSMoFW3KHif4Y04k7AYezsv376Z2VFTkhDuATZTNRzXSu3GhyVqXQFT1PmYwyzOqDkckhQbwnKDUmujkA3rT/9v8iHPpfjnoYibZ6Q+juur+0dT4qpehkJ8KhvJjCQdfK4++02rPM7/wDXU8j9p1tNcq0/lX9JPAsZm3PEWuY0Ey+3O0W/Lu9W+56lfs8TRcnJ9XRFVe99gbdbda8UD+D1W7qJpmrh61X+O9dJFFMzEa0vkJSiXxP5W3myUzBoVrpK3ERQJ0zX0jTwST5NGgPyzjyM1kROYjlllVZ5O5ldt/rm/wD6qn+s/tepx6UTEnEHe0DKfeUSyCAXEtdn/LzGoqmn482JK+SZnWzFWp111e06/wBIpQIJYKjJeIT/ABtJkCuJ0CVAXV+K+322xM2cmp+sn5lZqyFllGSIv9SuNJ1LzT1xRS9UEn6Ot8CJGWvtWWBf880+UBecfdGvHg50eV8l0n4iSUEC0yPogVzt20k5z9jE5DySWyb6nLdVZNHUkxE8cs00SSX2aqamqO5SdSf/AAjZwzNyFfWpuQaR3yiS9G6OqNCavmZ2VG0Zx98DXOTc1trVVGh1pUf7fTfI9cfVG/wMtOMOoJqamVBO2W/Kf30k7uw1o1R4eqHyl1CI2hjsUZGx76r5WXbELYCw2/LtprzXn4vk5ylHliXfOjX3DGrvo42eUKg2FRc7rcWKgU9uOTmh2Kz8Y7Rkgamt/ZPyMSZonIOtRyTWmqoCgSTVB+wXzy63pQcivqasyVXE6+MamNNBQSMuiNC9eL1sZ3ujUAAVf9jjINou9DCBX0GFEhfnKPM1OPLxDK6+/bR+9v8Ai8AatR1G9JvxSIFXm1uZZmGRFpfpG9qlWRuWfBL+pf6+WYTndFB+v7lOQEjmgSXnZzyH+7ANhTZ61XiqqKaLQ28zMkvXXfTO9SfoZfufiko5gtXsMSM2giYlAZLux+WDKBKFkffWRdSDWis08zv7OPHRMzFLuZ8eanypv/aH4WQiImnrqWQsbWqOK0+PB+12aqdH9p6/Aein79U4qsAlMcqJjNmtyjqZ827WiTn8HfFOS6aKnnGVt4K5InpAlnmtut63UpVIJ2sjD2AAsQpBdi2AsISA4Ui7W6QOFHax0wptTjut35l5CDU81fh5+yLOt/7BOvwVMZ92aFglRybm41E3X/VldmwZkpB+uyx1kM1bqafslMmiXl+lrzSLsnQ09dP2T8XTPyL9qigp71+ziIvF9yOpKTwIO9KfhdFLaULDA52KCnOiwBCw57IxNtpgs7FPE+ayFPO5omFuqTRNvPVdcTOhCfpKfX8hJjhHnJ1Da+ept2zXmMfPQcmuLGplZqfyNRZQVo6pHs7/ANJ4SkmnkZj98/6rmvwpw7AF/wBWUr1UnP0q7Oqo5Z+sztWR6Z/AA2xK+n24jki5Y9pHFh6iJ/hFwhrMjfL9GZmogJidLqwyMvX+P9a1o34/Uz+R1SCTrXOJpKpajTNDqt/Y1ug2/VEGlnxtH2Q2FBXn6SycNWjU0QoSDXg30B+ZNc5DnmfrONox+GygKHetbn++99H1/wBiyJcrAhhr2usTLxosXHiFuHutpG+pjESVtJ2fMLRslf8A1t6EdycxM66KJZdExfSRUSXXOOa8NE7eTIZJN1UgFXyu3acbfzKuT6d1J420h1o3WMXrqb6DwyVyS/fT+KM6Doo/yMRu66Bs5XfMkSzXDv8AXhg/TB9KRLgeCrlQXERIMi+gnBnYjkZh4BJt5nT6eufremSfJ119D71U1O583tpapHYyfgPTNTGPIWk4eJ3HWTeqskG0mf7UGzWl8b/Dx9CzJ+lgoOtfo1W6CttcFTL9tTOutK8j1HFdEdBN4ysaUOpyeaGw6d8hs1pejtVUsSBIEg/hKFhMPfccDSi14WcXMxPu77BeRqtfXX9IQ+nyBQJDQtNdRp2dDU5IfGw39nnHrH0xRTPM1bOrhNEx9X7IzKLpRZPL5A34agkOyBP63dzSfZ1ufCirqQA3eNGud6kmwKCkllqt/bzKtaaddHbt/FsTuLW4DyJEfroz9hvsbf721UZzfJWSchDPV8viLZrZCSBSzMBVVoBP1fizhZpot39rrujj6H9on5Ovq1XAbN1vHRNgqbUD7g9gVtrRSUffl40iM8/vetqP4ucencVz9mtta/6i4yuDe/F72/tOutBBpSIkMS7li3ubq+i26ffaw/L8tbLIMgmMDkh5iZQ3qMuy2ZdTqt9eNUzxr8jCyPg13N3+pWWtpBS82NT4k0KqV/YQwGP4/ruZkLrrIlMhujWo+j4Jh0/9a5f2DXP9yuZuImyXyb1E00tcUDU0k6JdyVK/k14YTRG9xd8wPbQbuw72tvso1eKrmJ/9lnKseKRmZmsrSLRQw9Gts7ZXqn4pTo+NyzVfFFO6cfRokqmZpKHcT53fcptPyuyESmROMeN3vIzU9CxTJ/3PL+52ImtJYjPFxs3zN45Zqzr5JNUVFNfU8b2tMzp8SrzVxviSiwhY5NwyJjbUwS8we47cR+sLTescjv8AfnEaxkDkXU11Wgqt1uzys1Ka5PzYYN3HNM91jLunQUCp90e7tBipJEdTpkl19+dfJHDOSeKkkLrQO+/u9iJ+tzJHKyV+X/SDyi1vJfxFV9JluZ/xt1xqJNb4DaB4Cj84+o0AQiYEmbebYCEJxrSgNJ8i0MW5z3tjWxws5KkyVzPyb7STa8z8dNrTKvIz/qeQ6A/N96XHMV1vif3F1cURjqXZr/6jfL9EQo5Ar80Z+pnxuXHj3Iz9iv05PIyk9W+OkOv6tG3x4yeUXqrjZqbx1FaeH42UxzUC9z4V8n6/OHrIuwgPdQzP2KxrcAUyn+EOOE4954210vpajLh6nIEMN5Tc47vLMH2kQUS58lzWTzOyaKdh6v8Azez5/TT8bk6wZpzcZeMWHi49Tky11IcYshWTIyia2+Z/NbimeQDgYhkjUTXPgasUayCTodWJqtaQPcfUY8fqvR+xTWTDnzzj9d7tvL9cHt5q/Q+3W8+Mvq7Jz5MdE7xR6c2TlT88zp0mrrg0/wCJDdkBvHu/ca19SRFJlC4TMMTJy8IQtWf497JHrPUeo9fxiibxsY8GWP8AJj9PijEYq219slSnlyVUo8+WSeq92/iXo/cMVer9vp9J7p6ScM4QxuOfV2faseXDD8k5CwOrNUFFypUzsPZy79MPocmKM2PJ8z6enFhq8X1QwxkmqsrcRMVrG1qU58mwy+8+8RWSb9v9PEkvyU+nuCs+MRyTcK/N8XiM1M1A7qSil6OrV1ausPQQPSbGoojMeSYjjVimgQZNWdmAx5IsBccIcX7L7v36b1/8Z9+mcXovWXOHLvH1l9q9x1zj9y9PhSKkb3j9QDXeNo8uh8v9/wDQ5vafW+o9t9Xio9V6d0ULxlRXDcTk1NYsuO4cVTqbn+pLJrv/AHya9V6qvWXHWajCZZlkxXBO6auRzFY7lcmWprX278r+aT331Fe8+2Dn2+7+y4nDNUN/+V7eH0HJB1eb0leJyU7MTM/6mq7enQABWgPWR65sXT8w2sRD331z1g1BJpmkl2i5Q/fGuW9l939R6OjLiizN6epIutrjyFKVQWPHii6NbNQy6ae+fcPS+84T3T06Y/UY9Y/cMTuckeq5rJ1MPyZfgp5oqWXGyGqJbPF6z3i9RFz0uycgZNS30vmj7EE7Deql0/YGDofb/cvUejv/AMz0wA04/WYEnjPhoarHUxIeBaO6lle52P5shWlFQIBO4HpiwJnuYzrKitQoF4gwOLw3O2vX/cMtZ/bPSepx47nvGFyZZpyGLG/Jssb3Q9eUrJGiZahyfnO+nz+m9yw+q9o9ZU4zLdPpVe2MshjxQGU/9NupkwzutOMoyLeTa+h9Qe4ez6x3HqMNUhMh1ihgqsMVV8TmxAx8Rvmn5JCLaPNvX1fovVdR9Jw506n6ZeYqqpdzRqdv2dwo9CS/mXTpFNRpfpIqJGCLEECYvxuBroqK9NSdNSYjbsX/AJGcARrffxn3D/73Pd8/s/rE/wDGyZMlennKNYqtaxxOrccdbd48hJWPITvmpYfTPffVemzYcZlhzXPpauQLxYIdXuSprLJgyFtzPEZGp+Tr68x5J7xFe6em9P7n6PJ8nrMPxtWH3x3jiq5bDJ3s51N038j1txZOp2Ptf8iPVe3z8zL6mcf/AI2crHPeK1qnNFGSamI0s/7g3wQStx1On66qayJpKRwkGO67KNKioU/KUAWafpEk/eJGq/uk/wCP4ty/L6e/j04+iBmgCTWomyJx1Hfy7I5nJv8APHPUB6b1pQP1qp+lVvfyb3cbf3BXT0PUup/PY/WfGZOpkrITUxdsl46u2pW4Zj7A87roD68kzH55h75iMebpOimfDMlTV3SU5D6vI107dbU/Qfk1U1AUkEwYLgIDEbHckQdcvWc8ET4jYhJv31u79z+T2v1EEcNRgw2+dVIvVErtXW22vC1F46dv5Q9tsmayJoMeT7NA1e5VkBXTQLNd0hOzQ/munNb6K51+2ZpZKySmNPFdfef9ta2O/wC1bfy76dqcfp8apVseZKFNamWpA+qFVqfBuqHnbdM1gmkpBmzqIwe/DQkxqaSSQ7G8q5fsSz4bnXsXsMOP03pImsdTZBRjx+ZLDV5EqYMkm99HmLAKx1XXKf8AJ/u1Zc/o/aw5xelxTdRJzLlzY0CZbyLNmM0S7rY/v+3WegmcWLHHZP1lZMpzx1I4kAF3MyYzxNNImyvzxf8AkPq33L3z1OWgqTJWKKm6OZK5m1vayhrWkgnX7l2uoAawUkAE2GVGMHta5jW9ZNPTA39KwfSqWCO/N+db7+HegyZM0VcjKzT4N77n/I68SH/XJS8JSyjz+br3T15757ziwzs9u9nh9P6WWv8ADWaOceXL56nWbJJEVufocmqNlXHl/wDpT7A5sTx6j1WOvS4sndlQclVk5BeJN7tUpZf1BvPYsHwejrKzO82RFqK7htijLdaliTVT0nlKYHaG1IDpAj0hyp/CTFgXwQPGiKaaaBwS0BgjsB7N210+D6f+Nh7ltyQ7edckA46aN/T+pjCZpQQvz+H6j1c25zUV8WK4Socc1cmnJD1u8q1UhqJ3iq18F/lXHdvqfFd/GW7mdck2UmPepp8j0b899zpmSp6jPc4mCfjrLkucuclim8mM6jKXuZnoCqeXpZmGVusPiQ4F5uCgIFj2+wGhikIRdhlqJAESBkuHjWp9bmaKrk15wtMa+2vORiq3DLoteUrwnU+eVzOTJVDO90S3MVLdPXNBLW9+f8hQaZdfGUvQeriKyeZ7v4vsdRJNVt+p5S6eblyNV0PRUkhW9n9DXqPWs9n+KtBk2zyVEzttC6n/AKm5OprX+j8x6dJFKFKSyMDhXP5GNYkeogXSpm2P3UfV6PHjw+j9PfrfUY0+OOcUXU1fqM/1smz7WVH/AMTa8k7/AEa4fPncmW7qWryJVL5Jq71BuydBvRLWzT55mT86P+Uevn559twXLg9GVuw5hyu5qt/Ydng1yCVy78/nNwFSbGU4iVDffXgsoaRWT/W+eU3JRRZcDkf/AGhL7A2nUdQv5aQgMq8ACHZ/xvTXI6k50jM6iPv0a1W3/Q7noNeGtAbdnXrct+zmLLPX/j1kwT4pmHKzkK6qh5L7/QElH1/tVUssmMlIx1czM8zBevAltqdbfF2M9+fCVpVFl+m9TjrW5zYcgIRI0s2afGv6mpPOtKKbaCgMp3Efrk+RvqQF/wDaXIGw55lbKNL9rx/+R635crDj9HjfU5iptmuVMW6f3V5UdjsRdrp/G+vyFVLSO/Bzt1tp1W+iUXzOvAHOuFWmT0npm8Xo0+NxY6y5aZlzZJioCWTTiH/1yIVR5B3qmeoM9rU+J1Pma46/RdDX7W0ro6OnoLnX5nFMI/MnubMhdhwBbUmCBlsze04iBliPHVekGfTxCz1GUmeZ5lTHILR/bW/2EzaafuD+RlybNUSKfE6j9gH3VKGfCtJt0fXra2MJc4sZVS2zL3ofLMhXynJWmI43prf/ANUu6+Sfjp45yd/c3I/286r/AEvjzEj1/wBXT48zqAnqVVCJKiLgWH0351oB8uy5KIKk8b9yVrk5vG7m8dVywFDpaKnkqr+2qaTqWf8AQm4dgmSruDfUhkNVRXx4wORdtHgY0AnQmpaY5ZuzkIxTsTUloE7Gt1QNM7Odko8I0y/Xl685McY/qP0Wn/u+QA1eml2S/Xc/n24rqyxKJjjibETfsNMEnt+YGPJMyItnQ2dal+ugp28zRATQFbRpUTQf2JTlfwQB5fvvVxO5biUfCu3WNTep589TqkfyKmpJd6qWY61WlXY3bOtymq8aZ+zr7H5lRMcZK25Oo+3fjd8psEDH9aZ3qvKSIsiJzEAAbYNlceFaMvPP5R+1/tqxF1TfU7VqeieXdBzPQyMf70H7NOqGSNS3F2qxOvNalorxHmSj/wDHO2mTqt8/hY5agdfq0rX7rwDut70615DamOno6Z+/y64iTmvu1T9R0mOL5Kpd87J2annYpSPccTO5UGxLJIQncpdj9jZFXNsnC0eN+lHK89A7CnRP03Rvn9GNCVXjQlKNbka1NdVvyH+OrBlMs6AEQANa+0+RI1aeZ1UpuSplsgHpVqn9zNTrVCf/ACP4T9IbbQp8DuiR0zCeJOaSl5pg8ieJ/KBhJAAO+FkhMHdo404+v1t/Lz9I3xsQer+t89bH9U2MyxNQ+UA/Wnz+LZ67N+ZyKrQwyM9CeCpdvPEkpuFK5fzGq8UUUkk14qo+ztv9cTw/7mdyh9U2K6JnH2tdQyzkF66CRnfUbxqKc7WIT9CfgCCS1AaI25mJNh5DB0fzvafC+2nX9vPPikmbJ5Gv106l+tNfetjWtcoAzeKbjHLQM80M2EkmkO97qv1P+poOdaB/Achr6vG0i6P3020SDSca51Rt1ITvT+ZZ+6hXdBuvNQJ4mrko0UUgPjymh0AyAGCaQsIJck5sllaEPtv/ADv2kkaPHM5Hq7JOd7Z0XkkjW+hUPqn2Ka3MKfkXXdf9NExdU6lvjW9nmrOaDfh2aryNAzzhaksvrWXGvVMyD4b/ANJQPHIPh2eaSmUPtkHdGXbfgh/ePTMuzxuN89CM/YmVJQA5PP4bcCO4Dc6B7Pvm1845gw9FvDWP5NgzjT460LonbAiqPMyvPnZfgKDhZjzqnITqlclY4yGo6foAcbQGimaCQD8Erv8AUQaen6zJWQ0hU0qeH9Pm0mZD9/mebpqvL9xjikPLpk/U72xjQl/6s/tLGCLWibL6z/rTQsF3N3Budo+mNS55PIHQGK6cadZDT2//AAeN3TquhnT4/G4gYgck9IV1+t9M/W2tV4RP0frmaK1Sueb3yTFE/Hcsz0Jrep5orzrdKV1srxW7LHOST+rTLzNOjfOtz9tbh1s1BvXKdbfwAPqm0WwWLhnZJKTc6BNvt+dsF/sdNqtWa5P8Z5NzG58kqu7qkHxprmgqWt/iZIKX4vs5Ircu3pJ1FU8HP70h9U8Iz+FfU6pSi52TOqZP2o+NEkASiKuQ3JX4mKfjby5DVFBLJTjQnW366f33vbwVUbf1qZQU44iLEjGWyIiwP5+/tG6KtqMtX1P1o4qYSnqf2q1Oh5dCFSczNFfU6/Gyavc6arHVM/qYqiWiVGL/AGAJ1VdAyKfihIzHVlSTP/2Pxmydzue6Qv7H76+1HXlKgPIZKS71PZPx7DgMmyYTqtG901I8mwOevxNmFu5wROQmwGClAU6Ac9kdrH9tG08x9axwOIejxd7Xqhpr49LE1oU/xvifJlnlSf0xW915f1YKp9lJo/W2dbnX4m7uCQ1k/pM2O2Xxy07P60OjX9dJs2OTNVs+Tma+8qwutyopvjX26kP1+meh/Al2e69l27U5sS9BP0Fu23Hi5Oiy9ZSUmeCsZoAedf8AdC2aCp0qGtbPMv4D1WgnWmJoDbXP611t5U0143vzyfk4wKKnonJYaKJklJ/1Ggxz/qqeg2zCM/mWmH61JrYSzPSY03I1vShKzyrRvQ0B+TdVKSgRvaHyCePuVPb+COQydtOk4ueUjpnPy1OsZO9SHPLQa4NrprpNsoWVbazVXNOSqAgvHsPM0r+qZCfHK/10WgVHK9URKkaWmzU0Y53yzOtbo3L+v77/AAYy1OP+04y6ZmtLcFEhLTzyB9WE3tdHI7GLQhOVgWV2tnbQB9ky+E/cnwdM019Zrj/IoNc7E0zJ5Tygxv8AYx/sfzLnLUnWM+tGmdjZynV7N8aNruVnfW+PxE83TM9TvKbK+kNNSKZL8g0uzx0DJ+ivy111m+K/JIyvnlvRMDSm5kd7JoXf6Y/LQMExyZJGLQUn+WWouv4be3j7KIuYmLlXxInK7rlxyVenkSnZorwvnzUPXzTkcklT+xn9HyTP1hAvx9T/AEeXWqo/Iq8n07rs1GGUFDzJKZK3o2XL4X6r4Zo/Ivu6mJeGJh8OiteeN15qrdfaQLH6lOqpeoCLpSADZfzjfYaH1KF7b3tm2+rFVi3e6lInxQYyayJICNbqp65/07efFMKt6USXxj09B9qjjbTS73oJXnpCHl0ofCCom/8A2aTkNPnGKHQJLr9Pjf60QVhVKVrok34an6BC7qyfINACbCth+QangDH8YmI/hGkefyxA/L7caZtnAOnzUjVDksKk26ePqfepd+GNTP1UidVJGyJcdTVupX42V8WOn7P33rrUB0x+HNbUTWoYVDbQEm3IDt3qKOVoJ8UL+V7yTjy4v2blmQmon+sE5K86d7r9mwFP/n8EILGB2MDjeSBsznRb3FouR/P49N38mtW4766WhlQ5GTZfeqXUU72EO/3+Lsx42iyt/LqXnUk7JnHvIeJr7IydL0MRxNS6spOq1L9U2STLdchTTQbqR+2+iZk0fX8R1WXEv/quch3evtd/4ypsav8AYp1sHRDpO2siRg+wp3WTMhveNMAf7myN95yhzs4iKH5hqjKs0E65UOJGpa3SpcSFfXrzPQuDG91e4ZuvD58zX0815J+4FGl5JJnmasDk500My4x2nS88/alsNgdeKdGw01+Tc5f8dCcsxTOnQ7NVkU6qamd1TWt7NoeKwIwBbcizV98SS7Fn9PPOL/TUvGGqPE9ZJqPG9t86lpOWfGnZRqUAp1UnxnV/GNUbKK305NHBUsyOyUdO+uTwmszY1Jq8h0Y8d7BEDzWKKqXssUXrujpr9H4uDZfX9d3lmmh1zXJiV1o2OyZ3KIUS9OdbpNICMFM2RCICRjAIsdIiVbPZ92cx2XGreKm7orGHD1TX6ONAZKsadv2lJF8P05qksu4zxmnqlGbnwAN/qmKJrsNQ+Xo8GnVJx/48t/scsb62ajzqZFpKhAINgq6fOksp1Mv1uSpBk25JXZSyWtbn7V9T7HT07mqWQ4bvYY/g5m+h5W38xyLaZS18k1DM7onmCd18cmq/dXFVuTgSkDTR+ZZxgxClE8ed3pHXTWQ8fWZ/YARo0/v8XOV2bxRPKYp6kXfhmtti6R1XhGTqHndB13XL3On+1ak/X9PJWiqU+s6dJX3Kr8Yv3TNoiGFNrMFiwMgfvbGm5Mk5cQry47g/qE5eQP1T00/1JdT9UfIJOL5Ms1O4OXaOsbaERR5n7O3a7Fk4/sflaJut9VtPJVTqKCZCWq1VzqvAf+x0L09fh3lqZnm2PBO5ORp1paDaU7G9dVyBPK0UDbLtAZX03iFnVbBqZ2nYe428HTm+aqydTmllhPoZHj67lkJXTifqiUyIApjJk+Y+SFmZ5Y0gS3wVNNEtVqid8b0nIbKyenY1bCkk7eiShNNAVItB4fNumVqaNBCYGFaat1Dy87nV7+wuuj9hxJs/E2jnkMuMbLPI1JOJx2x3dhaAsanEu01p1Ru02VqfpLTST+yNS+TmeU8E5LbXFH1giaEQvJQgvd/6dlZETZqvH1RLENfSuJnrlB2b2q9c6ftU/ZTXPP3SJMcH6s+PTIaa7TTN0/ayq561VOhQ/YCMsBEkeAs4BPEaNhtfJsIc2HfUxN/Nd+eUp+yjtZ6xyf0dz/Q863o6WwluNEKY7KxjqDlOhmshTRO/sadv1Te+dLL8oH9buhmkqdBuatNklEE1M9T1yB9n8GeTtDRdB5lfjbJo3k/0HKDPkOtA+fxJWaG2Wsw2ha1rWJhC5x2vPjftqyMB4wi7YK6qVqmaNr4vW/71rTPk3CVLWTdFb8XT5hN+dMdGuoo6nRIdC/2quhqmZnnIfI/GM6ScpVL1WRNb+ut7Ha/s1+Bky8zGSp8Gied7+p/aqaqjVTXVVKk89BTv81sLkGCgIUIRfmMgLOmsxCORtdfs0ELMy5z1DF5ceyZor5IGZZ6iV33prkNRvTNBua/MzWY8Tkr6chAzFbXxXZQ/XTD2iV9VDR+BiquZPHUrh2TJLV6JyFqHZQBTNLqZd0zKdTeSmWa63zbyX3f1lea41tpRANhPhHofylX+0D2eV9rkonw9v2xjvjQYcnzN3lvzCkkgrkOdcTaHhv8Au6fKO6+zLimiusXT23QvNslJR5nXFwrqJk6OegHaiKJHn+uYKTUfIn1a/sPlYmU+tVTNTtlbKeNp/wDu/K11/syPI2+J1vYaBZdaASFVL87SceVm2NMTcZ/YbgA/ywGin461NNIbuqP3o5WWsjS//DpfDr9zL+MuonGSVEtTIHR5Nzydb21t2mhR0pvr8TJNbcRxU5XEjz1O+epI0tCpI7P2NAafxN4KyZjp+kS3MU0T4r/1CyDvQqG06NiaGSh8uUDULRbO2xtjAWN3n2f6sY9g5rrITMhiwxUM6oq6eN5EGm9CKvO/BQIJhkrSXHNdTitkZmqCT7+dgv8AdB6dfvV1Qi4ssmK9TkkKtGJjpiOeuWa/2DXXOtS/21GSq1LqStxARIedf+zvr69aZnX3fHJ5Pw+l7SyhHawn9QF2+/j7bnGm24zm8Ms01qplnUlBo6lJZ/QTT9p+vmWdDvNoeXRU4uYOXy6Msz9iRR1SEruWdm/xHxyPjqS6nz0ky0eZpIIJjmd/7PL19a1YyUT8eMRWTdMoVMzKS1Q7bZyS6lKfqsg0gWflkQ8kyWbD2V1B0ACYX5nL98paDFqBgfvX17ZoIak+jT9eZR60bWV6J5fwrN5ZrLQuOOJalpalvmcjaSr/ALZJK1yc6Jom6t6nEC/Sip8F2bKN2A+EarXO9aon8R/nle5tfl/vvdO2UHcqD5e5J8baNjS+MPDIxB3/AHwY05EX2uU179rEW31Yx7xlYxck0ySH15m9TIWE8ppnmSvPmZ6fKmca18k1DN8qB8dIx11VhfKFdciOk0WO5yLzSrBeT4wWt1VclXTfmI2IVH2PtIakA5sAdEupxqzS07/tVLomtP2ea8eTcuk5AuB/Ff8A/MksaXi36i5v/NzM3XiGaIqNJP1lvFj3tVpaT6cjqaAMhrQS5mfNk2VZfczpx5HXJbNc/TTs23oarek/BvVMxJxQRLXya7ZeaDct/fc7rYZJljnYV+MxseBxmkI8xzLlD6a6rx9trfhmytfhTTJL2iMWT3cEHffQrrz9BFjgaisr8hD1lx5Xy7n/ALMDUP1NiskpQG/+29lfRs3KNQSmmpmq3H2FMZjo1rjkK0apD8XOL5ckeXfbXncHjIUyL4Xp08v20/UUPw81ncVtp0EzJeORaNS+dPZCa1tr/f5eCSMieO4nKCasXphiwzJGbd8iPa2mf48LolXIqKy1NZJA3c0cY1F/XQAz1vQj1Vdzp1uWY3JYKrIdhTkncnaMyh52Nok56nIqlTqj+3N1e8flJgidP1g610S/uSyjOMhyzHy6mXktrsD7qdNchvoeZeJ8pP4vxUxi0whcnAO3Hg6DZRb7q3P3HGh11XPynzHNaWGLhBZlDq/PjhFyV+01FfjTz/p58i/rb0bVRaEeD9b5JdUD+VKxzXO8ldSmSgWnY6sKJ3ukl0c7Y58eUsTzk8jpNU9rG5COp/e3fgd1tRx1skr8A5kSlLdg83s0fC0hObgf7FyXsPs9WH7491DPx6ijaUzJutrukdeK/X1kqSgUSjmKr9WTE+J7nYIraM2aOi/sH215+0C1Mgg67mvETXIbF32tL5NhQAu6FFx9Vknvl5Mo9VM6CdYz9leSZE1vadHW/wAZNjHZ+b22/kVP+eQrL30GeqA8OoceP5J6O0HW3VNSHJ0c1QarYfgRjnGT9/vkqUpAAvVAZPIRsYPrt+zKHichXJePzzup2dTUv10R3ooK51vzNnMM3P2CcVUOpe5TrbO6DRxt2UNHSn7qvMlaazFM7yL2CIi2HtzOkAT+JG1oUj6WyPC1bq4+qY1eiGiAkTSD1vqHy1e53Oh3zTYn1edS7eo0edIcS5OQOaJCaHb9SdvlcvFkyzaYx+0/XoTlK3u8lc7K35+80Ow/MvnIXVKbua6CYHrX+Kr87HbU63Oh3tqK/KMyg4HGCssji4Y20xTANvTA+nH1ew0zEa+hcjaWdyUpFc/FVVGq1dHJOpFrVQj+VymSvK6ycFpTpaeK2+Kxzq5EOhOSZ1SkfNNOznb8c5JVqhAC7tBxhIQz5f6ybin8YQXhkH+uppuAe4TbW/LvepogmtcsjzubhA2Azg+nssz9xpY5sT+mxxwhywWwbOXdTTZAun+rt5neLkGmeYl0dJQw1xNZJ+Szocsf7F5G4Sg0b53OpFNnTtyOW+lWkoNp9Ktk5JrWolaNk9baAkHZ246SJn7TOvrMzNMXIzPSiJ4rkBQnRc7/ACDbaLFRInuO5xo7bWtt3t7aPzQGjmWCWaJh6Ajqt7sr6iaia2COknKJKKjGVTqabJtKCaLaGZn7NM7G6CeitbMx03LVIUv0in+pqVxyXHQVaE+BQT60m8mJKcai0OSGkNHLJFVW+yXnSeB6CoV3FVsslJtAruQSLB/po/n8/kasYvtGmplx0K5aOq4AsOpZqBQA5N9FCC0yXJd/JjdbRoQJzbXVcA7X6yqlTvzqaa/FYqKZiZAnFRQbgtkPFf7rf1l1rafHuUl/LeDHttJZ2/ILzrZz9dMy1Ojx4JXe/tyHHVJmMWtYKMOV+kgFgAAYuGA0cLzjhjTv65OaKidzO6Re3lGtNc8pRqDcrWv2/m1x/ZCkxxITbMzTdxQT1VUqUu3WuxYNZNNajFNXlyU2v9l+nScaJBp3R4SfOnVlfrzuPT+ndmut/wDsnrZuCT/G0i0CwcTOq6Q/0/nJ1IXqxZWRAmP5k2m6aZmTaBE7EPCO5Or3p+oqi8bU/KSTQ9Rtnm5pJmQCv3v4xpNJW9xjjFzRl6D5KDKa2vKGIUk0tV5jXncyFIzr8FJkMmTKZMMy1xVVZIVKRbzJ2zLc0u5XYI1P5tsEHqbxj4xfF9K5ExSKd5ErmSVaZDZsYXzvzevWaqvSPxEx2i4z7cA62pMoxZ59JBEkXKDnvvrYPrcXtXos3u/qMRkjDM4vSennLv8A8v11116f0rJr/BFayep0f4scqq2FUfbcX/iFe6e6zn919291z16jP6bEBlyVkmMnxXbM5cGKJCD4/MQl74xmOdE5r9999xenEx+2e3X8HojJKmbJOSXJ63NNS46q6P7H/r9OEAU2neeqx3h9V6bFhzY1xzGPqesZrdV33CS5b41R9PkiqKmpWfx9OgdOCFXUGSCoVkDzjVUllgiCfTZYkj5cW4Z031H8s9G4cWL3H+Ff+Jj/AMdR6n0XqfVen9ZixR5omnDfp6v++QnJj0a0h8W6s+l9zy3GX1PsPuPqfX+kxF5MntvrEPdPScz8nyZMGPKY/V+niCCvU4K/oNZMMwvWzn1uO/RZMPrPTenrEE+m6YNW9Vv1HOTIUUyePUh10kXG8dJxPufsmX2/NXuvsWSsOXDmqp1RjyzpMgkEPG9zD8c3goseTHlfjqgdOqr0n5Tb/lSXcSyLM2g6Z9Tbc/MKQkd7vEWHeNWPWe6ZfUZp9VniJyIXZMw4zE11ckldiNb0t0TTND2rr7zay4s3ppmoy6XLhn4/ljJ32c7qLYEjJ9nesbI4vwvWeoxe9+nyZfjxYPeMGFPVegw4rxx6n45R9X6eQ+mfvr5sJPl3Ux1M1+cV7d62jNXoc3bTbeJrIkzkkqeNWYzjKi/6Mjufq7/OqgUAegggwIMSlACAVpspGoqMrByS8DuAzuj9taz+Sek/8H3CqxM3gyaywakPK5OHT8dUUP8AtSl/sKCvb8y6x7anNWO+UTR0nx/b6BXQRsRyUM63+dV736M9w9uupyT1iG9Af/gidzJ39d671Ux11IH93zXDdYclY2tVjqukd7JmTWrkrlo8vjeqK411LpPpqHaCZX4cG8CfM6yrCMQJKahCPZbvbXpvsHvD7J6zL6HNVntnuN/FkNNHp81VURmnlxxUp9Kdso7J+tRWx9+9Hkzf9YkmruMU8ckT9HQN7L5nidzKDMsopx94Z9b7dOSMgViJmnw2UYyvsapV/VVsNJGQNfKb72H3F9w9H/8AS31FZL9b6QyfdyHeb0c/9T5Hd1H6r6nTctBX2TqUhmtCwBAC2Z4YMuWfOroqYFBII/xER+FGCUb/ALDWo9t9w/8AEy36XPjyHpctfDlqbRJKmeiGsf280G5U+vGr6LP1eS/aPWHqfS3Neny3PysTNQy13uSY+NeAf+xPSxubyR+UvecE489QTPiqS+eRYaZBsptQBfBWk8I6P0fqI9Z6WvS5Ct4xmhTz9SWSb2llPPTyn+KaZoismOABDLCLJEONwrsBvWRK+XIIIlwrAEWkeynXWV6ifV4O8Ulw4l+pJutddHdWFk34qH/Jd8bZno4n3rEOMIADgtrTOzvofN6sGpujmd6J51ybr0Nvo7y+grtMhThrtGcbqfjZeZr7UnEoNQ7QRrXe7FRjNKzyYpqhpOdpkpaoZTb4dt7TxvTNIRcA4JKuAkQA4YZ87Iz7T7DPv/Drl/SNXTjY2yoFfUl5DlKXqWnx487JHs6/Nx6ZT3D0krMn+L7ZQsm+zSEykwk19qk5FnVOw0PfPrdlBOzyGi66nTX2Ny7PD5vX62g7r09V/wCdjsv9xvzFW43zJU3W2SHxNa/Yukp0UruBUnIYYshjF1nRTF4mb7gp/by516T6j1Vz6HN6jHvH8HprWo4kyUTrddVTrIUBRpsTG8vF/nkfoMeT1vrMjshyVdFOq6lsJnqh7bRYZBr9eKrb2Xv2d9P7LnpaP/KuMeKqv7RjsKqdz4D4xqyfJ0X9ZQ/OZ/juE6rJ18eqyZJrJfmpD7TtjVbrQSJNJcutT+TUvXZXJVkg7zdHmw1VR+ah4AYcJ2LnLP8AH03uWSs/qfS+lxkuL0848T8cjiMtxpqJ7sepRqkCRNy/Z/Oj9Njv4OSDuYmKmYZPEVJbLYsujHN0K3qdPKfnK+hH1PrsuTbkrJeQepq2dZAnIdc+B0GumAr+5++szbnHB18n0k1NWz8ZveTqapafrjWwKLN8/aXpoAINQKsCU1NN/tw2DqgQGZ5P5RdW/Y6XjIqjl8tmZ38e9P7hJNVWgYxvjXUpxUn5Q9dlmunj9ZuEkJ+WzvRWOlYXoDw1vTyNCWcs4cQXPRbcVU9HiKNzjq8dzHPYES+SjejoidV6gc1lXDFmaZivExabnuq+Ssm7KPPVFxoJhR/OPrOom8RJTEZn9t7HUmFEoAsAE5ks4SkRMZUY3LRj4uhyDPmjVLIYn6v1Gh0SkyVX6x7Nl7gz7F7ZdzzWbNPAxtzY7cZ4WSUJNGrKpWb0Dpf6PDGGv/Jsg+OJkLlXc2dZuGZX/ZF78o9Dp1wX8j90v3L1bgLoxYVSfMxkyT0ZK4VW8j58E/pFan8zDwRH6Ut8WsewEoKpDMH7NTxIuPtA0OXJky5ayZRXJVS7kWVTVVT1NjtXx0Tz0Ffj6JCZYclA19PruY0u7rxRa/7Q2ceNH5HxY8Xx1oqckwVOt8VT43QaNa/3uiCnVCC8vLEzRK1NcVkChXfXdarmgd6r6mvqGy96CnKHaD9rTFg2HrIUtsp3ywwg8GUOFAOhnC0suTiXVlX+vjl/oFBO9jzPBJ5F65Sl62omXDikI1LXEpWTcsq5Ckdn+/M73DOsf5t/TY//ACMs+ni2McYnJ6z1HhMGA83k/t5tPoEqNsxOwa/Nf7heHL5g+HFhZj088QVkJrn/ACbVu8gzkqta2poolE5cjIOFE84CUZ31FR+UnbO4BBOJsuPvbzYfaj0np59L6izPzM5TLyT8lxvd1OuEfoTkf6zrVBFOur02aKnJwuKbN5MdFTbI1/eB1uf2Unh08jsTGCax5OdVU6yI0Umz/wBSTKD5/S862RSoh+nzXFWenyuDPSpKnw5wJ3JNjqmgPJp0y0G9yrMEo7JtcoLCJsrXRsHAwlwOM2Z/U9lhk+LEwf8AWbT5Rq8broVNeda4hB6AHexeYx90c1rdLUvkGU1NVrwvXx8zKpyG53+D6DIZfS4qqnrmqumtG4N1jZGhhCWgDUqs+fBZTwlABVPbqdYtf/L1VH2eH670waZ3+eb1en8x2JiRw2hwL+29z6ReYctsCJXN1bfXJGSTmpZKnmNMffYn7lGtpRu68UbKPJSFtTzS4/vGOaSe/jlaCh+skbPBpW3r/c0y5cY7n4m0I7INbt2W1v6+Ta199TJpkJMmup83v6VNVR9mjXTLalfXSAj4qQ6d/n2clAzaxX/FOc3hzY6Y/S+ypf8AN9Td/RpZAiYrczopJ07frvdS1e+jf26Xyr4yZnb5px6/WRVn7HieSJdKJrmlgT9HPFRNAdE8s6iVf2qKu2qnz4ofPM6l/AxSlLsZ1UwPV8Qk1OqnUxzoHl3Pmj7WBJkiwaVoV4wsTAjC0KbczP8ACC82s0gyO6P8hjvT18kMzN6Mf0sZDdb8ckioM9JTjY72MvYaWh6dSy1T0zSvHjb+ndaWHl8IipZVID5PpI7ear9f6fAH9bQrIppAos53+688vVMtV/VOmQomuuamK/H/AAk5a4i+XcvkeF+txe28p8kZbUD/AGuB8ZJOjk0y8b0bv6z+lXaGv3+RVdyzLxP1p26lkQTGUUIV/V0frjwA/mbujapOtw//ABP9TGr/AJNUqOp1vw+dpjk4mWjX1mfrOnS/Tq3RsR2670b143+NnIgkM8EC0sCE/tbRE4GXtxxjClagu2euHXPxOijepJK11o1zRVvkRXyORz5LKoyBN/0lkHwTIbXp0lNNE68a11vZ+YRGau5JVJSmvt1VzxAL9TZLWkddaI7O3I6Aj4dJui9TU8gjMvjWnZ5TdUCAilWctbfqA0bo9m824+x8fT7PNjzuuHmd1OPZkvZwNSbOq29AmugR/Z9XjkAFpJ2Kz3sob1zAlFbQRpDRq+onoEWFxuubNVJBKMOx1Pkxjrz9anpEDJXU/Yf7TP65LdqXZXX7dO3X1EdL02EnA+UJn7XRKsGUjp+EVlfeVaZ9hGopoejp/wAhNyy19a06eUmjWzwDj3Oh6fx+1l8JManQzIsM9c/uv2zMG1frF7SPxFUYvOi6b6+q1+w5G9yfGadTvfO+RRPzOcOpaW1oZCo0Oo/xnl1HVfZKETc+NakHdE3uAsbYmAk0NJgPfbkfrAH05fePtmhMjqclyaADYu/Ntiyf7KXXg8hlsx8YHm/vk+xys88VTQ3GyinldCeF8hjLrrdfWd3G6+nJqpxDzp6n9hs52f78ByVS/wChcs7UUNaxje2jfQISVpDSCU2PlABK8yPoAR+aNiI/M4zE2f2shpgvYbEq4QPrB3zuas2I61r9PjybrTrtuZgmTWtTPPmo3oOmqT9ABO/BQamvxMlarx4/9uquXwk6x9O+d/v6z+g8S14jV1VLaTE7xl1W8kHCTpjZLRSka8Dvy7LpPyjmZIQBVmO/2IUaf8+o/kTou8+Sqn5Mc8x1Uz9F2QHjIVvdb6vmISyTrudjXyyOvjTWq5AiHrmarpdKu9s9TR+q0/kyPyHMD/iXTWpWbNafq0J9Zk2OtRyh+Q6yct71IUORkjxaMfaVZvR9tdeGNCux59IchMWiRdBbMbjTZI83zjPnDSe+g5dukZSbjYOutfRqtHP6/RxbsOVNPGZmI756Yark1y8czV0gq+J5f0EiLtQu+dgdbqaqpBlZmYNtOl5D9dya1vRcSc3QS/8Asl+oTpdPxtPhOmZ3JO6Q0NGp9QpsLqzmzC8XFp41P8dzzA/jGNMoTqsmJNVx00OqXrqprGGjydyzvrwbln8FJMks39ktvdT9iWb/AFO+pqUCHR4ojwiR1kp+1JrJ8Y1vmJ+vkq1anca6I3/rYlH5EY2ctfbqdXcrVHU6DjYPf/yEaHa78gBLQWwukkeQf30Z9sDCiH38uLBs3iWtRXVb1dJMMVxqd0UyTenz56AHwfgyxup/2XTzz9dT/SN0hT5CWZB+29WP4zH1M0tFVl154LcZcn9qnXMyw9AP28+dmq/yc8tfsv4nITrdlh9qrT5VLQXZAn1UoOIO6te34ZBTgTkiNP8AbPnH8xo2eIFuR3jyFqMc7JJqq8OpR1MpSvkp+q2uxMdeQGvGped7JUSqZ/7T/bSDpK/Cr46E5qdWz1f1nVGpiLrdM/bZzIvLO++KZjJQDGOYAjB0FSdOvKarwnS2ouhB/X5OaQZ4BlwZQhw7WFhcELZfW84IJ+2WNZHyN3Rqt18X9GZLSN30uw2JVooM+B2/mGbJOQsN1r4qWb6pyUd3urDSmpt87NA6voqsnZclTX1mh3zV60t1qa070J2f9Z2uxoqq8yYomX7+PuwmhbWqmjW0Ap+pI6WjUDACRGwMLfZ4+zBZMZ7APNp+quOdHTD4MaiZHz9Tc6emvtN6ej+v2Q1zxsFImJRf7xtONyXpZyVtJPrpAn4/saZB/Bm6+UnZO4J6Co3YzomV5etHmt7Yo8hU00Pjh0dF6o3KstyAteBmTa639aaJKUUKgbIXBTAtxd+0c6l/ljdcr2PvkpWq5JTmGF34rmZ/xrX2Xf6Q2mgB1TNY4i/lmD5GHt/aSvX1dRPX9Oa21Rpp/X4nJRqKOTV85KZd3TXTSbaDxMNGt6506dmT8u+RSXbLf28c9gV9uQf9efGv0b/AEEpMj81MSLofQO7v+X25tqLSdL9PoAs0d/bx0i2L4d6loPOuRUVDAVJImmjVX480UqH2kkLTzOjX17Pxk1VKEyMePJ/7Kx61Mt77TybCJWtKMbYKzO2sWqHjnXRv6mhutrW6kpB/62dFbZpJAxZMrayOZG+SM6I2eji+ceLTL0jvndRVPlt5AqNc+Z/TrTIjDj7X4spCZN0V8Z1LU75QTItPgA+qyeKUTZlmvjyRMz/YdzrLjhJnEVW+m2VPjkivL0JtneSf0dy3KBVagpNHcaJa5oDlJ30U+T8kFIGmLPsqQ4ZsZWYs9Pb6r9/rZ4V9Pa/xSFY5L1hquXZRTJdF+JKZVpOqRkCRbY04yetbCZl5bqxJYu3ZKrL5rmuJ3psqvxe24MjsmDmZ3jr/ACRpKuV0x55k/tW+d6fwZd7Ko+81cf8A2RJ8EBWjij9JpNu4O60WalIzexupQtdF3QvoJx53H7cz9RpmVfhZ/fFg35ln6/p6POOaK5CPHjxWqfxeAlG71Xy9TG0KnvlNf1JOhOp2KLE7lHKezSfV+vToGqNbtvazuqNvLsBCvxk0wzIhyTPgJgseYpda2m3cm1/X78yVVUGIV+YmZJH05Glnj+bW5T76OeIhoQ0cJrrJ1rwHRKAhpD6/Z0ofi8ZjOqSkfsaSkKfGP/RLPn+u0f06GfyOur/p9f8Ab/1Mv9ektTn7LsnU1v8ATPLkXb+8bSawyhol1Oh73ua8hf1VJj+3S27QMeDAmMQkhEvRqeuRHc5G3F/WtdHBLd2fY6mtXIbTjQz1QtoxrRXAbTz40uS6TXJt3Sapmjfjw2ruuVJJIkR286eezqp7s7KKJFncptEDG3RSkjONjaBly8s9NdqeTwcs98cEnlWSfUEP4SPzgvuLEF7bwYX8e93trBxkYwK/vI9ciVWtxVK6gB39CidvN/VInp2PlK+PbK1J9QRup6I1oqQ8ujnVfjdsaYQ75LOJMc2+Gt81JMkngLsHnevxOaq+j/vcy8Fm5XoaqNlWVJ3vU8KtO6RPJAiIRW3tY2vB0zULoYB+kC64MHAsdFdKzXC8VE9TBLWSa0XVP25fsdeE4Ge+NJXj+pSm9liJXUOniakarUs1r9P2n+u/zK39H6jzM6mHlrUsk+ZXdDsdP0fG0/BxmPIby/JuaY3XKwoSzjmtrNOtVPN7DXNbU3Bub3wAFCJc5I1P87fz+Ro2scVLie+7HJiJlnyz5NVo0szM0tDvfc3J+FkYuSqXrcsVompVOZ/Z9eq2s+OituvP4lnGiZJYqbkK1P20BW6pX7m3s1sNalmVdz+11D5oaey4knUeRU1rVaJZ/aVLX45MILhwQuy7Qbnu3j34SCPvA50thcjc1/8AY9uqr/SSkb31uQ3+2np8bD8ZirjGdTG5rg8bRSdOUo3rqP8A2f25AZ6G6JpXfJzEkrtmGTlMnhaAPAhO+Z+vlr8SuTky2wTdE44Wa5dEzdaZZtZd1RVEtP7qfyhDKbvsNzNvE4elH6/TPK+2mXfILxfWqm4BRoak73HPCOp53wpO3w5jrWSiVrrE0I807JE5uSa0ugAD9Ki9LrJSS88xvHF9TXLff+o1zMOkpnVivj6rVjLuvjZjiYPtEvE1ONktDbWl51P1GStyrv8AHeQGv1AP88aoSOIBCdoRX5dkS9J51/YyRuuigKvSkputT8dJbKRO534K8sri4nTNIYjU91LFV0VlsVGXUV4mtO6lfA9tUpN1oBma62ckVtKJinQ1/XRtTcqlnicROOIrLmlbrpCHWimiZILn6/vwNbNfiPykpEGYm64vup+o0jEX7c/wfkDplTivCfrcksviZqp2sUO66rolQJTWtTzX4MXM452i1PA7bYdSEVVbZ5VWnT/ZT6/kINfvm+2inUyBQcyjtF0SHi//AFvkH8bjJpKycETO0qDlyEyGQGinQjo/tf1DRL+ALLARssKJPYTPOlH8KsR+X76iRckLR9Bpn+hdY652b220anYnQUO2ZGO81txWVpHZXk5idS+UaqWf0eZHsp1VWCVzzP8A9rg+vP2UAuvPJ+w8zRxz48oWTJWJkHVMc1qF0c76Ud05AqRNtaa1rz+BKVxa3hfy+yWgMSP4Qrbnu/bU5cjj4KJ++OYHhmZppO3JLqd897enrdGkOqvXGzc0RbAsr99z8ZkuvrQ6RdH63z4o/H/KVjiox9f/AGPhKVyIpepqudNPGRStKpXPRFFc/wCRiqqOzTNaqpAxy9G62qiNNrq+tK5KRBAX8/gNttI32tGCM7yv5C1FeozT/aS/PxOxgczrnKUaCq3a1zv9lTv9QZc2RyDOgeayaqqnclUP6Pjme/6G5OZnbv8ABTqU5J5mbr7Jdc6XYyr30f7V0Fc8/h/aGGJKcmGcWjZz/Sf/AKqXI6/cu7b/APtI/gyzO3nbyDb2VjqpBMYjxkfkYXazJaKx/QqeeHeybylVxkap8uhe0Qrb5oBXjyLeR565jjV75GSQZWlaQrRqVPFgQq7vnlrnrRj8QhGkcV73qVNr46nnwO0/AyXMwSc93bHiUGqTWRrQCpQOh0BpZH8YKGBncWFon7PYjRO354mTPPHGjxZT43/6v6Yk419hGKGvA76Ka+zcsiun8MnI/wBp3Uq3Vc7yMs76LJmpUSUk34hkoaQIWmbOirjLOSWNW0/17dD19uGZ8eA1W/w135+/jUwGytbljI0s0m2TfjwHQ0flUlpwuJx3VpmEBa5yrL8u8YsreRx5Luy8iMymOeZp+PyJk6rz/Yr7eV/bPUqtyWgW8OznfO53Y6u6ECuhHx2nlnz+V7ax3JFdd0rdM0YumEruXxO6SWjW/tp2AyoBlH+1y3KtpNDrqkcfBt1r/f2nT5/AE2zecn7bBQl7AaP8g/QWXPOnY6ysj3jvdE/IApsl/wDYAHLv9lb6p0N0i6nHezLvZW3JS80Ca62d1NL/AGkFPp4rVfkpETExjMR0RyW8U8n7Wz6tSLXJ+qlE0/kf+RU5N8FaiMc0xwRkkKEWh5dP768RrUu5aaAFU7hsuF39kYBidMbHsh3Ft/q+BOg+TfE9EhA9PgsjipkNu/14Q26ZUZFGfky0/wDWYTqyr05JetAyvx9XJqaNeS9VO/woaQ3O1x3e9eQV/trZqUTYCfs2VsIuzJKHXUDW5J5yNG6itA9E6jY7Zeh5dy7PcWMx6d8Al5zgk6RIx3i+ON8AR20U49O8mTumF39Gcc8zrhOa7pHX7a01rqtfgxT8ZWgsZxQakoTX3yDtRfFVz2s1FCy6nBAyFOux4q37L/jOXoNm1DXmq3M1O38JXualn451F6gByhJt0s6ATvWyhQfsLBQe4gbmIksJK33A0T5+p4/bxsNMIpNeb8/XJuX6MnMl/p3o1JI7fDL+k47kEodzRjTY20k/Vb0smjVbmpF6BF/CiZ0z82SRSzr6FR1PUHW//qfPMRLzQV09/iHFkbzf5hkxlc1AJZopJUlNy9UdaWufCaZNimoIcFcxexJgSxo9osYFkHNo551Y05OZyxrWThqUB3IV3VjfNOhqQ34ldn5lRjNhj8jV6ERknxO7/b0MdEz1Mgb+Pf5GEqWd3NS/f7V0xAhXTWkqOQ50zvb5TwLkRvxPPbxbuWaUZdVuvjLH/a7H9u9oWauc8rjIho3JYsUOUJgC0rfL3gjaBqMZThl6FfOmpHmZlIyUm0Ek1ITuiZb/AOq5ONcT3LUsFNSRVFAdP/QROdSVpqdV+ioiYkppXhnhlKlPIcoxj3Pg1+qoAUj8xqTHuiDczByNn/Xg8qlBU0qChuNOz8k4xEgm64Nrse40z5jFtrci0xnOsx9pWNHd5Um65fEhNS9MlUdDEzJqtEpR9iHs0Tr47iUhnG6h02n2qZREtrVoiB5tdxNyFEjxNw46XSdK7DfWk2up8Vtjx+MqWuUsKiYvn5K049ksqjdUBJ8ah5Z/X2ZkYFx+UkEWA9/si3x/qVa2zei5yXc9oJJUmgKJQeutXTZKn62vLprlzKAQugKxyvxr+mv7GvEqPkPsFmn9sXNX8clcySJrZWSJsNT2fXfiQ6BA6PuDncTkxRWnwbvQzuXWOabfttOujzX+vM+ZqkEJMiZ3pH8kThaC8x7vAUfqgNFl6yQT0Ye/iJo+hQMuxlp61p0cDLz5pWZesfIP7kNcOooQmqtTS8NL/tf6+Nfg9FzzH+OmjTWwadv/AMWciz1W53Iy/wClajrEf4yusc1v7TWzz810O2nej/tJ51voxqj5hBYHCgXtnYji2jeDh7fp+cdtNw4+5qslBfXc/qaqa5WK+hKVrUc6FK+yot2Wd7fqy/GOiikQJ+/2f9aUjZHHJUm6rlyfX/Ds6ieTqFdzp11X18XO6g8TImp2v3c/a5mpy6+zMtR3r799c8iUC6p2MDtn846yH44vGVi9/uzVMI/l4vFu42jNnEVUChTjyTNP6SUkeqrdJsmStcUURRoqvzb4nHKtbW2Kjn9wZB4hTnmW+g/d9AzsmedZj1bTz8aaG61Jd9hXS02FVWtOpvnlkSX82/pvjrJqpdtuQp/UsoTHV/uMjXjnW9cmk88fxDAM+lZQKASEZMG8NRc6iqyIBBpkYDHseJds63WOKOVAmYgo1WRsF3kHrzR5S9TNCoo/boY969h/j04fbvdcWfN6v3GIx+p9RimIr23B6mNY8bPhyZZmvly45UoCjrlHV+21jzeq9NjqFKyYceQSmsg5O9AKkHLLaH+oYdP5x8e33/Jv5LmwL8b6jNnz+ovss9L6fHkyVkyuxiScUGI+2pCcTk/q/nFTQK6iazFOxN4VrD9pTGrYpXpAJMUy9mWQoYIK5etx6kz/AMe94z+lqMY4sxjyRigSobLm5vHfFlyzlKlVaaqWHIfm+fWZ7nHkf/stFxbriehIuKiq4mIJ3JuJOOadCN989Jh9+9gxe7+j69R6v2PI+ye4ZasM+aMMX/8ASf1uuTLT6j0mKvTu9N36aSaJYp5v+O+pnPhr01NXmi5iN2zUjGpltoXHNLvwNfsko0bgiumwBoBpqaYkcBkpibX1JYqWKpCN5BExLztu3re37z6r02QxZarLM5P6tGWblfrkMczM9fW0oqGamb1UtdbB9x+fHNk48kOsY4Wor5OarHkyfG3zliaeuiOeynqb2aP1ft2S8nx347y9ma234loJ4q4ZcdtPLJM7mkSpyT+aFr1ntfqKx5Ng3sYzBirC2qTzo1qVCf8A1ddA46okFAqPyomJswV+ft9iqqof4+AWoGwK7g9s63Pr8fqD1L6r064vUY8pzmI5qaLWpkmK6PMza1sNd/8AY/OR931lufcsAY8+K+PWYgZrHmfvWSWN3OPIkpdO/J/c1X51mH3DDlL4iA+KtGivPjrW7oLmU3b5j+2qhkjU+p9NjvLkeZJzRZm2yOU3T+plloplXaLKH7OdQVBEwZIK7xJhqwI2jSqR4pPMG2Y77xl6ue1+qr1GL4SSnJFZCe56xylTcA5JK/6/FiThrlU6H84H+QelfS+vzE1IOSvsY6jpq3xsQ1zPNaP/AKnXLNDuvTZK9J7h8KVMmTRUrO4qyZnlZAuZqKI2bKA6E/Lnvfpf/K9P3jnldsGzI+fkeZ8P+Ot/49vl31+x/JqgsFZKkQggxBIKc3zqLiQWCEb5Ag5OPGtN7L60xOTEnGPNDikXc4yjHMoDME7QmkeFSZsahn5L9t9ZHrsBUfDmVHocv2WiyJOseSdxSLDqnmR4NL6O7nLU/wBkcnNEuyZZNUumpE1wBT4ZAoo6DN1mwFJv4+ZyVzVPVTucnW63/Ym8r5jclQ1tLFXqp+Yh3AD4N1uwcb21AJE3RBexf8+lytdb7mYfdPRx6/08jhz4kjUbvFVG2frkqpcVrCP9YqSf/smvPov/AMPP8lY7Z6+PJM0DWR8ZCyQ/sb2ND1tguS4eo/j/AKoxZq9rzreL1G8npTvkx+puU+IdQxVux5Guo2E+CtT7z6WvS58mOwHJV2FwrF/Ik13oNBDUun9XoKEnM0gxYCQ7wQSpkWEDe2bqR+YZA7sEB7+zHlatZcuO8U2O9GK+tyJvo6UK/wAaP2g/1tnxzqPUBPp8bLCVMTxxWXZ9Sct0a5ZJuHx9TkBmUObw+syY1nh6h42147yalKaTY0Un1DVcA0vW/wDTepfURWLJimafpGaokJ40E3VmqlfMaxj8nJxF76oEEAERjiwzmQcG3mRYOTYAs7ZY9865f19TXqCtXQXJVExjUK8wHGgJ8dKa5N70a3Ht14snrMFUT9ccP1Rne9SXvyTqZKkpNHJ4N/ms9zCbpJhf6WmN0adiG9N6ndVO+VrkVX8s+z2fJuuSYgk2aub0a0sgQc7pD6bdJTWs0ihSJIbShEkdu7WZ0h+JEZxwd8Lkzvtsf5H6j/D6f0+MZMmSrT7fTvuPGNJPjmZeb1JXNT5ZX8D0DWD0LfG9YvtWuH+rW6lZ3JXXVuqaJmth4R7vmfV+6QfH4j48ZoCar9fIlVXhprVIVqenXHmz6nM4vR0BMtcxQS8ysv2IFNamhyNKDUpwPSJIqqsAAgMm0jlpXvoY9RIhBDylcRYTe4vrceymOnJnyO/iKuXmQr+j1XT/AJeaWLSp7f8A51L+b3JJkzRU2Yqquh7nmsfRvG6gGpeecf8AV3kgfsppvZJ49JNQjYFTWgZOZfirrX2mudY9Ersa5/exz5PjxVkTp6YNQ7qapqEdkkzzSUcRRvg1r80B9PTPqfqACZxEkXiLtaqkKgHZGfF54a3C7vy316b1BuYH7Vqpimo3JxFlEGrgKlnycnHl/B9L6RqomAkT5erybfh6ExvhJvmZ5nx/2d71ymM2SuYDzFQfUvm5hkG7+zU1Wm3+uSYRO9P5tcO/S1mzZajLjqEw1P3nH8g0VNBE4yZxlZAlrm6yJWWmPzkqJA3Mi/8A4kKRicPOmiSIHElYs2APywFqh777jPovT6SY5TFbP7bxHU2RtoeTy0iLNOPJP2vyhrLlzVlsd1mQqTmuf7z0cS867af0iqoc/nRe/wDrs3qvW3jyXN44Fjolx3kN45WqmW7p01elp2HLk1+aiUjW8Y9QTojZKoddtaTTprewmmVRPyqQQAICXEqkryYZcRqKqmYZACgwbT9YZw9MMlJwxTonFVSADoksx3uSVb3YDNeWZ0tJy5eqMWOf8iOKvqhdqHMm3/Jao0yHXmT+z+MzZJKmxneiaZ6iXYUtou7WalUPB9hEHYe34Y9N6XP73m18eBY9Fholc3r7kZknSVjwebr7bmgZ10BdSpAKRMEQ1E7WtgfeQrWAusc4g7v81Hqfi9D6SPb5Yr1OaZyessllhTU+npnaziOWsaDouhkn7c56vHBMY5rbPOTosH/17kuvG68DMhIzud06p2mKnNky+rz5Buu7ymV7rqueqjf1aSpJ87/2vNB+aj1GRarrpotJ51Mh4Jjx/wBDbyidV40vkl3AdhcGPubSl+es6yEwwDYR+FgIXNtm9T6OJu82MNzWKrY610QzVHnylTLx+tFSTr9flbJXxZmSa05CsVG48Vvl6adigOj9mjWtfmenv4vVRdXUHyS1LT/StRUS/XxQsmkKJZk3sbnuPp+NhQGFWPCd+nyaZ1XnenbLP05a5pGa/JpcPeGORbvE7yMkR+KkMyNg4gsRcwu4Wus9FgfT4ocauLJijJkxNc6qpKaKJ5egn+u9jT4KoC9Tc8JIUc/FRx4J0/aqXmfAz0U65o8/Gn4PorT0npZm979PEKlVUrNDRsPPPRQOmupNHf4tK5dPQypXPZc0kzKurt0B4VrdBrdfnJW6q+Pw2LkjEWycHBxuGgJAQLiw9IXM+NckTtzQ111tGtlFEyaik5Z6K/QGx5qa/s3HtGWfEqFf/dTMnK11VGnW/HU6HzXX4Osik6mJNYyyuut62d27YekKJN+JAd9E4pnIVuHxfU75n9/1EUoQ+p1STv8A+QPqg4KgkDxEAGYB7ooxqQY9nkyl32ObIY1FyXb9p0R1p+sdwMFGxm1KN+X6781/sZObZXeLJ9zev8a8C49/Wp21ByeF5muk3kTbuenXigdR9EHjdbpF1ySBW+TVI/jbxYqZq4LrmXzWiX6mpqpK1WtElIv1nVSaYpJ+YAMEG6MpkXJ9z2GmBlBwfsLstfzfWQ7DkJZjiVkNgiDvfX/1M8h2hLyBX5G/ijdal2bpl7adErsTnc8tUGwRl/TgtBJXGo8p0KDqZCj+uvrsZm52BLqjKBkCl8SzTK1uedF1XXif3RzqTRoZmmmoEYMkYpalyrZPGmxGcPuvEx+WsR+lIOvjn6Gx6eqaTyJo7Qk53sJPwL1L1jOjJW3xP03pmqyLwcJVadu/tyy6/GHE2U3F9bd1tiVYcZ1OuZ7DUa66A3r+o1dS0ytS2G0CZb5Z/qocorR1B9WRXJP4kPTKEo8QMq5sYhSLnTsjjb9rrFtAYnIXoUmxqt6rxy/Fv91vrxqT9aWWwZ5iT7pCs5J2lbn9TB1zX6EAkedCzetSvx7qLoVVB+3nSnQTJOxkUU2862czjFxla6oZd72ynP1qndJCuzjY1Qg8rMD0i58XxgNlcJq+pYazyojaDP8AIWipLOCidBX9pkZkDnettUUTX6NeHVefxUKKo3IpLpVxhNhVWmiQN0Ag9eWQW/Et6i5qqSx3PJt3x1oQ3zrFrVbTZsmS41kcgi1N15HlN/8ArPJNiAwHNHnT4Z/KkokSwIJtEb2M3N5QkuvdyAuOfyYKzkYyp7yWHfLpR+PmZ0f/ABNeOipOpOWfLr8GMIXkvvQzVTb+6hqamSaj41Hy6EqVZ+9L+HfQSfIc8lMKBJ+q8aOmSdcynjYVtfwIyzkmuRkxuy61JVhJWMm1vnp/rp63MJt1+BNI9Ih75QAmDj62GNKGC2v0EoEgTm2j7nFF4d1UXupRuqCwgGt+CdPR+p4aNfb8By/GcUnQ8lk1v66A6fDK+S3xzsqRDZY6Fbtk6h53H9J8O5+pvqtu971/rrf5lzi2XR8lkzqiRZsr6nUkA9cqP2ujod6fxziUVBuISXYz3tbVBoc2iPoZX21EST1sNUymrPEZHXFVv9aB+jX+zyz4JvLC6h4JjD15cnnY39qgIWeWpA5NGqF/E1l4vJFhq1jtnxj3/rVV9o8VpkF1o27KkN6toeJZCtjkJfsNX5ocZqeU7+25efLaCcAU4N4d5DmV2utNgLgRbtEReAN41b+mpHrdRoTY/wBQ5u9863NBzrfPAJy/icmSAmZjrIsRP9o5FnjtfNfpDYAhsWZ2M39d6JkkxXXmj7Kbnrckj46dVr6gk9rKnIk9RpMJkRmWWoX7XVb00UOw5ZGR15/GSaoCi53ITRkTOMw76RIs9h7ER+S57oImkaJaC2Hp8QpL3VR4nHKUhU6H7MKVo6xltN0y1kdU8hUiFCumppdRxJLpnotKQirdt2W3qJ07ArHOnYaKrWqrTkRQ1TSHkEk6DxMT4OdCmmqf2+EUR+u/2b/EHnGIYIQ3PN5toiP3/wB5F/OgafGOQAceNr9ORmkP7KsfUNeH/wDE+VVZPsSzUzKQ82y9V9aY6SjGMOg8/wDWnsdEqO3xonFSDJ2+T71pTWt2g/qXy+BL6NDzITiuwNVTezqlaR09OvFAV5N/iJSuxtkwY/keUUJ8kGIZQ3uPbbVtqOIJdXM/ZdfHmmUqp/YVXY/cmdjJ4TSjZbSda+06ZBMg6Nwdc3PROzX+/Jo0dyH2NyB1c/oJK3uWRQEAdhp+3U+QS8cU5CPkqnoaJBmqnWk4euhVgo34VPynIZAY8Y2vFoBd9MnjYZ8oDjvm2l38kh1Ol0DJovL+9rkN/YTmzndPGvHiZrhWUvdb86tlo8DU8kVt8Sf/AFU6EuhhceRJ5qyWq6rQvPjh6/8Ase10ST1tDT9vzMeGOnk5j/2DVEzvU0YyTxU/rX66AkfKg3ULEB22gpfhxhiZ20NnH8X0n7ac0daq6maqMqvJPW5CKVMf++SoENcnnX4syYfPnb2zKfWUoAgq3+rv61oE1PhmemVM5WZQ8TLLtg+mzQX5ZqV6kAqgp0k/gOI+LZIEMUE7kZn+1VrzJf66f/YSdUfVmTBagWfKNygFu4smhpFjby1tGBnPe+sVYJfH+SBeUakNDeR1TNOxs8puUNb/ABicxKgDjmTRsrryV2uut7ao88/YBKPxA5NzVGpojGSdXy8HORejln9S6HnWtiz+WIoRn/112dOVnW/qMI1o6a+rzO/JqKSrdPY2ysHAvnbm+mP55z5OEM6BHIs5JOsdkygSPEj0uTys+UvklQHmjdQUV/jyTqjIE+Kmcn6k6276dr0gP/bydUd7okTZNzH6Zl8a7sfNTRvqqJT90Fa1AzFFfSl3NfquWkYevqkbNj1VOnY7ILVlsttnLRKyS99iMJzG5URvk7m3d6Cq+ImMmt1Xi4OupoJ1V7BOStIPiNMyxX4wnFT1c1Nbl/Y/R15urB5fA75WTl1Uyor8kdU7fmmNoqOg51T1yqchPlfO13+B31p/eqMbrU1UlSO2lpX9b3rYFjR+MFAAgEIREbX3tZ5D0M98ZsEA88E9j2LUTJd/46l/xyPSuiStXUJC2Oo3XLXkSJRtxxEB56T7FdHmY5nJQ6f14MZpPHlESqcfX06+r8o3zJSE7xH7WB8h+l6n6uhmZ6rXgPGX7VrsNfSSg8LsGTbrUpTv8VVVhd2Im65IHgWG1zPcDlW5PDS50MfHp145HcOp4jUuoY35N+HwCfZD8jHVYtlR9VlP7bBZ5O3hGXe5N6d0fZRjbPyEJjb+PF1P6npOzcmiNzz5lRNa0a/G3NrMjHRPmSJD/G68NiOSty+P2VZX60zTurBEYccyl7aM/Ttbn/YOovo1VapyVNGQZ8NCi0fUkd+OfM7VNP5DP0JL00TQlNvPU7aol4kJUrW9OjW+vzKGW5L/AK5p+1j0SgoKMsHiaZNFLxp2/mFzj1X7VJiQ6dPHINGvjPJo3vTr9flAgE/rmJHKEWfOn/PtGionc1m+0mLcAeKoZI7tSrL1VuhXlHxPk6Jt5U2Jl2JUo8pjqttVtda8DOpnVa2o6o8eGQydqVCTyEeR8zfgmQDXP7kanFKVb5T7J9Vvnx5F0c1p4+umvBIv5Tkod4gmBLIJM573MGxv/Bvtsu2isMtRrb9o1d1oSZnyLu97R/0Joo87c3VfSof7zGwZ6rZJ3vdUVt07OqAdUbYJyXc8uwJWueSYCaTrmt34f1va627KC6aluxa+aTe01rRqmnrne/s/2T7Dz+NjYZy7pnIF+czuaOqoppkT7DILx+q5HwaPsbDZR+vAfmN1jYy3yrMxAfb49so1pnT/AG2vXjz+qsDxFVrLfHEFAIsyHG62opseHbt35dea93krY80dOOI58gCzm0roUoajyDXjy7Ti87b2D8OI2hADRZHb687R4Cxotx3qsf8A335di7A6pGfj6XlDweP2L+QU7qa+3+XXjf1f1C276n/R+nXg8juW5mOwfky5CZ6mfq8j4nY8t61sW6PGpPyYvFjhMqeL15las5Cd0n+9P20KCylkH4A2fyofp9SN3xpNh43j+R221gEPiiVxbOgpa3OnrTOq0MG3qZP6y9ycfU5hgyOPrLe5pTmUxzX9VOaWfjDh/TqY/Fs1ixnKKkpp2arSUn1OY1M7J53Xn7JP5MTwVMtZYX5CVdkoSyXsKeZ0zP8AjWlnddflC8wFBEq38JpAC3UOkfabFWm2OFvqd8dUFeRenbyXUhFLueCxK145OTxNETQjjn674ilA0niiNo9Vk200AXrRo5KVlt+Sv6/TFzzyyf49ace97o/rPjxpK2K/jRyeKdW5GXGgNx/vDHXiTnlmpAXoTyv42D/o7Djl5YB50W/1b3jtuORo5qqQmQOR8c+eWBqmmrqnXhdN0I6qt1hjmslfIVosevCQLA9NH9KafvEn+yZ6kpGMnxHmpapIaqF0pKDbo5mit6FpP0aH8LFkd5aSSphxtV0tUEb+tp26aKy/2NEoJ4BUGATMchZl4Su7aPv+w5PMflpld/bHzrqzGdG7IrTNDbByggJtdUHU6UmKx1FTkCmJp6uJnYzXXjVSIEk78jrqn8ZQ5X60YuCKZvxbIffzum55sJCp3qh1JFTmIGa3sKKy7XgooJjFxVjpDoTbTqdT4r8CWU2FeIAS4A2/hJeAhhxHftE57aWWnXlqm2H6f5GvDDtA0UIP2/T9aZdzz0VXfkpv5O5X+stYdG9G7Nk/rvbSIzisnTjn6kwwH/Y/7hVeK/02m5ZV8T+BBEtZjJZebnkL3OMeXHI4+ZmmpChlNdUbH8QJBURcssGM54X00rHtH27vzd+7r1GKPJTdTvUbpNT9quf60caH/qp4rT0GuQUeWVOgqh34F2cXCaTzrQybE/IpnHjmKqbclBvXcxN6qUsAjVTSal3TeSQXknK5NQvTv/HHP1mYunmhjk2brpmQ0tEjS/lt4wI5G7N+ykTp9tvEY49n3zOI4/eWKv63KEM1EycxZobf19WdKoJTpjJ8eTItCs5Ci119ZdMHSpFK/wBTS+NCCBERjn+7UbmmftX0AbCifEzrwScpScrbps58RWpFrZjm0Znr6sxbW1NqLppDlHn8VKQBJFr7gCB+hWdGB+i/nbGlXdPNyPI48bq+v9j2/VWHYfY5A+wh0zk1khKom4QhgeSth4DV6rcPU89AS61NfhsZOj7T35yT/Q/xm6ZKqeb0kkzJX1qkdniIGCqSXqGoUWjpOIhoh6LBZjvxRyrcgS7bbxI3CeVxdlaXPvIGZUfSdEVU7+0pVO61WTnapl7145R8G6B8AWqW41LeST6D8kcBdVXA31r7DVCb30Mh1xsHutWRqg+PJPTGqp3vRsmafM3eko27BPwc2CeYc7t3CTFR10rTP6OIPLQasZKf+tif+QlQIzGf0WnIkfmF+XtjkS2cwTH/AEP8UNfHta283W5dFadXNb8eINQfjMmr+MOGiBHRxXMlT1X7q6f7T/3Z/wBL0qxYwOGZpKOLtKAjkkKaV1XLO5Jq9FTsfxlQzoOqpoZd6lm0fjXwCs61M+aNE9a3pT6vBTYyxCex9oLegLHb2/n0mw0Bhn5XIc+BrlSd+ZedcyuM0a06dh+1/Hzf9khT6wiiX5l8dUaDepdfv6SDrarp3KjxqYWSgKCRKpftPGhpkOR/bjfwWqeh1seVh2uqxzurdL1/9Uc78bNC/jFQBliZY3+vhmcwi7ecTFjwMCdEZxquzzT8fXD4p5Aaodz/AG1RqjypsT8PM/1nqBojH4PFzorq8teP/qt1/v8AsafIMh5qok0G+pQ3PNGWQpapadKbRAPM/hdk9tjVVXM1WPVTuicbVGyYFpAP3vnyP4eoL5jsfBW30M7G60jk8QLk8ewx2i2s3hxv9eZvx4F4qg1NupGNdeEp8L5/SVf1jdRyzJuZdbdcNZCdCcu9AgHiX+uXebcGP4uaZi6toO+l+SftprxX38apnQO38ivGPbJ5CKmo/eR3zlWWtA75d/6eZ0H4nwfShYDKBstuP/y6HTZz3HbxPmw31FRWOZ1XiueSKWopmTbelkNHWpH7PP8AV/Mi7x71lK6eql5/osif1Dve9SGpdprpEK+arWr6Sk/QY3H1O41PO+v34k6+xqa3sySnXFSDWQdszSEvIK6ijWta6+so6Ep/kt8XAFjA2UoFNXTm2PYrBgW8jOntbxqaI45eYkDU+Gp81rn9g+T6/bwqIyDJWuXRjnUc/f6u6p8ELvzaUkrQg/kgeZCt/wDtBdS49H+OV+9RVXwSAVL426QIut5I1M4pnw8f7JiXmWgWZdzSfYDTsRGXtFmXg8D3CYmNUJT7+3cfU+dFXdZe+5mSBmH+hu9sE6C9yidP7V+2wAb60zDWuIvQy0rton7E0+d5K89PPk2/izI83SvW3man7TU8s7GfGOeb1o+p1IeNBXjYjDc05KUqySgyRwP2qWTRrlf1P2qlP6waoInnJx39sQXpE4H1U+0gfTvpn+PddTX/ALAKonc0P1mrdycvg0dR4Tyj+Y4wvtoZ5pnGhQI7+kpJ4OaEaU/WvH4ufGFzY4N3VBNBk3TM0ajS7/SVX7h68TyDTHbErcVf0yCanrxsmVHbKGtAJvf21zPqi43ZI4UQy5sIPGkC83v9DOeWp+5TcxKNctPMWmqmLmeS1OZnRVbnY3Lo3uvyOtmlJAZaoNXUM+K35ooXdHivEk/7/M3nyZRqZMcayMKausfMlk1t5dVpCdG+vH7JlNfaXr/IU/8Ax+2FrZwJ4iQjbYOvAEsCQmpGYB2nJi31G/5/Cze2lZGMsbg04Ubw1TDXP955+1M+I1yAAqSk0DKV51oJcZNEtdSyngFN7Evz0Ir9h/MsbkP/AJC0gMcXzj1Xe66pvyJ+k2bNlfhYpiTI6JGbS6d6KDeKf6D/APKG1K+u0mTMs3RIHujJifqLExI05/h5zEfzvpkK0zoEDHt/VpyBfflHwn1GkB1W+m4++qhh/RRTR0AS87o0/t45k8+PrpFEM34KqcpqqbOKQJ6k2Uou519UISn6iOlMZSeSnF8daq3Eul1ZrwMigLO9hrw511Rn3gGDtfKMkZZ0Ajb7T9/r21bnSlaFJkb1JT5l2dPl+wdKHR52O6zBGOpom/vddQqCLoMTpqfr2+E5rSzy8n4tiTT0/apRHr61vXdjuDYeE/Smw5It44hmtk8w3kkGOZAhrEjG2Kp+wHWzexkXir8DmGiosJjMzbVAp+HmAh+jlI21aJx2nW6uuKpLHq9yVFqy/tPEyGgK3RNfm3xVwo6LWYdTsirS5ptEZn7SeFCfr4/NXgx1VGRYcUFWFVLHNZIax19RK8dM/X9C0+H82kWqsyO0xGo++2lMod7mSNE0hQdAEyNcHWqFRNLyCZiEHYEO2B50wbAdyLWXbMd1mddL6PLXps3o8wlXHxtyeDestGVSuXJkkZKp0b+58Q/mu9d6iP4x/Hs2b0un3f8AkLmxuWpnHk9N7c/5LYZ5sc+ZZnIjOUmbdSSVa9Hiv1lY/TEJeSjC2147LKrNRpZkxlVWZBk3OoZ/OV/kGY95/kOD0mLx6bBeHB6XG/aMeDB3ibJnGAWrlQ3KXXkpN5dEOobD3JGPP2AmNaggU+qcABJQH6e5WbQHjuv4bEeg9Ph9L63KYPbvf8E+3e51R3PpvU1f/ke2+tyY/pMnpfVuPZd1T6e8042PEzz2f0uT2H+QZMOVcc5ct48uH4znH6nHYOF1qJZyRvGl0E0vnoPz0OfQRn9C4jjn4JJYnGYwIsnmtXrOnBPiS/8AszLs0P8AIsNe9e3z6+Lcvu3t94/T+tq+PlswBi9B680VZ88TPo/UyzVGaMV5KWl/NBUP7hPpKq+Ug32BIH5gpLuyIpRJIDbRABFyzwgvq9bT/wAqvUekTJBGTfxfME6YqLxt3bVNR11TkmCtcyc1iqq0PufoMVenxRjSbCenruKLKorJbsKuqYDmGseje9v5V9q9xv1GDDbP+XVYPUxSlRlBrLvq3nwCLAXTO5U6ds55prWqkbkbltXqebmimWcW9qIQRUhyH5JP9ssFWKWHTnjgI++gn1imlMnkDZ24O87WOvN/V+rye1+ppxi+kutUTN4yG3TIigcRVF7DlPNRsNni9Xhz4SjbBZOOOZUpKqZ0VuZG5nIV1MaK8bjmz6v02H1N5sWWZP8ANVVkyzPe5vwcVIMd3SMzs0xI5T7cVWXL7X6rJOTfw9VMy7560zFMvAFQ7HwzzfM0FYqtiq5uiC0X8rQZOz876wqq9JThzMi0Zicj3nW19yMrVZMhxzkJ3514KaUou6KfrNUyanzO4K/Nn7Z6h9V6fH6TJkmVkvFvbIzAVhyVVeZt5JCa7a01C9fmuzeqj1XpoqJnbxivtS5tmqyTaNAMO4aOlDwAVWu9Jm/8b1Bt0zl8eeWjr+n9db3NEaoFK8bNflBHugJYDjHtAAxM6QqHqGAw+7H0ckJSONV/dvSHo/WuWeTFlvzMqs0W9f1mfDJ5P3PkZrnn8t+ksmKxdFRkZvHzVPJXNVD+p5nkfG/G6k56DY+8D6vBHq4xlzcfoDc1Mt0eekIbGFe/DtT7HPelyXNTHcfo8+ZjTzPM7HVu3/1vnb46/c0sVekgltGEiAwWv4udJdk7beL7zq36pyxnjPjWMuPNMyzjZIqKpmgmWt70KMrKlFTv86P1WePdvRx6yYlzc/FnTVLmmKrJdDa6R6x/qgon7x5eYzZTK84oJ6B6uREdamZU2tKSjutaedb/ACx7R6iMfq7wZKfj9UXEyrxGUCcWRlIglW5Prv8A6lSm2xmTJG3BT2tYDZnVAyABBTb+g/i3uBp/WenrGs1v/HRzUjNU6RpJl6i3pp0daX9n5Z9u9VLzhkrHkx7GvCXrWzVoNFo75Fkna0Y6vY+7THyEPmQcf2h1NBotqtfX9k72yTST1DLztzWOooneTqK3GoE2ijO2lQl1roPAeAzqYPqFrJdp8H66klFqXYKEdth51svc5vHVm5StMs7dxW/tVByoHlqao31sf1X9qvLGWgmepK6qpPuPO/NWTVLsnZpfrv68/ln1GT5sM75dSSTSpAx4pp/0JWpAU2/vdfmt9BkYyZI8ddVp51UO5N7X9DslNo715HY/mHqIRpAAgf8AEbXgjiEtI1OrCKOBdJsCbANWc42mRnJ62uWZ/wAZkd8dLvoldrvevIrU6xmuh/J9Xk//AFfHIG2VrkmVB4dW2VXTE9Mk1vlTddIifk9TSVVb1erXpQ2hueaXUmoda6JN0JnqpX1ODtN1xGu6+g7Qumd//Bs52Gv7E1+SgKkKSQ0jVEkUqcd7YNtSSrAMlJ9hbDHj6DXV+m+OcdYmmqomGgSIahOSmZHCpIwS2svbAB+Pi9TzprmnHC6HpkkKqgGBa0zjAfrIJpr+m2gGKjcRhH72fJ+i0ch4/t/lVftrlGtFmd/WDhMddZJSflqXV/t89DNN6O9E/VJv8qpBAGEgPI7bYAEiJ1qLJ2zhlCQcX9/Gtr6O8lXS4qunN8c5Qucg0lRM0f8Asx9T1TyNqdH0qqP3v1L6L0c+mnJDl5ay/YZrvHropTG3udY5mZ0FB5F/K3t1Y4ist7lN3PybrU0SjjxvNa62dVq5hvnknf5oP5N6ys/wFV8v1iSZkCDm5JuZ3updfKJoraab886dbKWLFmMWFyOTvGm0DZn9osBb3JjXP3z6i27rzW8s1ToDe+AJ8FfXROp81r9zRNpijDc6/wAeSHnkv/EyjuzlkOdi+JFrS7WMGLJEA/5F0zRtK6JSe/0zNG2edooc0MpTFjc1O+25GuqPGvrOkdy6dyMm1nn7T+aMQIw5aNO+7QcBTjWI3d58q227ti0ad6P2/N7l63HgDiL66rIPGLFOQrIjMsnMv18q2v686L3v1keq9Ri9B6Ot+3+3f/W/ppOtZMqhk9SvLNOa/wBUE7g65Hb+bv1jfsftWPDDM+4e4421S3Ng9K4tVOTbsqv6Muj934knfJ4sLD/kZhcXRKSv68Mq8FWCz5fO/Pk5zpZJq9UAxaYvKx2gW0+AW0+0cKGISzzrMuWPT+nrHhxpeSiM12M8qIkM15maE8xqUT+sO9Nl41CDuXjql1VSyBS62r+3QOpnxpXYeozZKk5oiD48d1jlNn1oqlrl8lDXjdbBN0tDJE9IanVFVCzPk1tNFJtTme90SynUmtSCSQgCCyLtohkeBsZU6ipkpBBKHgEu8CP4NVr01uh0MzQLutfodl0jrnSBrSh4fzoMVx6j0U3QuT05MV56uxitUpuo4K06kkB6/wCtuiT6VbtWudVryMyGi3zIh58b+qgn5a9u9T8PqJmwIp+KocYRuucY78Sp5Z/7HkPDwgCMhlLYU2g+0C06zpKIDiqBgOBvZAd4UPXU+jbZ+Op3qpkr+pMkk/2pJpyd/SkCra2Y/wC35OYMj/3Kx9TLGtOp4NL57FSedf1DU1KCsduHKk1paqSgqQaRnQJLKCFfroSJeeBtYzeqn61u9hqvI6bug15HVO1/ev2fnD8QCKvVS5iEyYiVu+CLDWxJACbTzAhg7weY+nNREMxknWqOYe50f1oujy7P06d2Jp8mh66ijG+ZTyi11ISmkp+PfjYAA+ZnR+GnJxvxUlM7CeV2R/1lFA1ASvUiKH4uchGSQ1PUc1XGse61IVugttjy+d6nX9dP1AcB8MMnC9vcZ0DH8t6Njw/21nJLikuF+qedtSk/Vp2/a9zjJB8IMpMjKWgNUa0n21/WZ1MtL9a/R4lrQaEH8C7PGlDuReASne3qkOTfNI7P6zJUmwxu37SiJiaHy0Ubab5eDydG9SBoZp/HSRYO/wDim2I2O9hlXRfbKnsij38Ce+mT8yHbM8nRNUjcSmxbN3sPH9RBEa/Zt7ylTJY42aJkAoQGNUm1/o1vycnQIzdHjX0oTG1qT9a/d3tVR2kjzKJtndZXvYNDXL9eZxtIgUk6kRD9gSPO/CyghfcmQymBvEmCr86S9K8dvmwC+GQie2m4w1R1z1rJ5/dBonCUj5f/AKmRn9o9VB+ZokUncfLuKBUhBIuq8M6/rcycyOgSQytQRJrby8zO7+Smdfag/wC0uzx/24/0IzkyQq8urDVl6PIzxWgmfH7mSfG2d7VOQDiLfRMeInKnTxv74kdvadsaYlvSGn5eW/to3Us9Kcsy/wBkJ/eg2tEzB8vmj9Vvrlmlo+n1ufrXhJSfO+Xz4yardLfNc5POnVTTR9VKk3+zmZGfsV3t/AJX9V0tFijRON14qwVJSZZf15Nm/wAICUy8QYw/tvxpHjBB3usf/wCvGdWTgVa/R1P+1l5OEsnR0fbkTw/p8/iwybfG470JtrSjLGT9AQBo8DX1B2/g38m/rXVc9TWtnAASPnrZMOpN09bp1+Di61cmySnINvitEpPOp3/2Tmfv+jna/leolBHv2SJm0bEC5a0O10hPESZ/YS7gE7NhxqU5nzQd8umKlqu6aQR/bqdP7a5FfLTXkelfvMtJRUjS9bfOv100KsM/lh4r/pQNH6Dnbyf1ftEvnyaX+qTrf5LmcfM1ErGsRWnxXiSWijsevOg8aNXRX4iKSiTc4DlwLCe4OqKjgx7q32++dRU5CMer+XVRQeG4KJ53WpVGOda0FTUnL4mmt/aeZ5cXNDWmnwzSjpvxKg6KP7eHMlf44p2z9SmaBRr7IgHRvSq68f2XoKqxfHHZ1dEEEktuueevLW9Vu1CvAz5na6ckVEJEN/lMIGkFjc40gsnA3R2k37uc8IAb53i/wjdFSeZnkALN1tDuRiWp0O90kPyG4B3q3HPUXdToqtU19WLB507iutefyKZOTkJSZag0NaNGSvLfhrrne9aRDX5lf1KqqqfrP+tGM1zTZujRKbo60i9fkH1L29VhdQWyvBsQI0kp9+d/ZG2DAiW4zNXd1JWshRtJpp5+zVP2nbROTjzVA/baT8tz5Me+bMcqX1OtcfZ5+nXXLv8AWzWx2Py9bivqyG62hk+PWh3ttsZnXgrmYBrmnDJ2q7D6yvjV0IU05Ft/tqdJdJwnUfawQABnIMMZKUwNvexI2v8AyyliSb4MoawWCln6zl53X7mvrwyvJyA7ZPGwNPWhrM+SpdmsdVyG8nRppyKaf9IiogBPSeXN1vHP1DGzV6ZVg11Wt7hF2/vY+PFfiKTRvlvg55meO+/runfnxt411p/T4/ECAg92YLMNMhpx4uNEx/8AiSvBUEfSVpuW741ZJvQ1JryzTulAqVa+5Iv6J+r+RjlMOOTRT53y75Cd1do88she/wDoB40v4uLbkl8s1IVXPihCY3R9vK/6PBynRtdLWMlKKp1poNSunRWtOMoTweft9Vr8sEGpklFRb/jHfLHBcrVQx5He0724/IaDJMywzkVq5+s76B8hVTS8r40yblquSdajJE0/5N/1ijSfFoD6Tv7BrxqfCz4J3sz/ANa19bWtT4K11pmtz/XWtG/sSPIi/hl3kPMuznFtHZ4k/wC37kKdfqnQU0ifkwyLNQhsFaBN3vKOkc+PcpR7J/adARFlNDPLxRbO0U2/92pGpNb+pzGtcoUTyaHv7bxorbjfqT+hetH1meXflNamMuTHVTEpSVPVTPE6nRuqf2vRL41S6UsH8jqU5KSi4IyfaYOdLJ5UN31+iSRHT5/AGQArIkIDGbRF77bILAtHYRk7bXwhOmORp+PJiYnxE2VuE0G1rzON2m50pPKGSTYiTJpNn+MrToKXXda143zpDQBz40zQxqo5rvUOpt5pfFdb3PRLTrfPk5SvEtfHQk67k2swvyeRpdzuNypv/wCUJpH8ZBud4iFEZuOOMy0e/eyjb7Ldg6jFz3Spo2hYUUjLMfYnRO/BOg8SV+9llrZNdDNsGp8NfatVd1rVk+Vts8lPXJoImjHOQR5vpX626OuXQ9BSSG0o2Am/zBpGXRIiT+oyOLw9FLT1ugOTeuVlX8sH5aXk/VASZQPgbzo/NHlxO22FnTbcWM7t0TJOqKtnxIvU+O/0eUQnXmZPxWP7ixQLPyzO5KIhCsdeOYKnSxG+l3sE4PY+ajR4xpWPU9XLrJ1W2R2nWhHfmk2yyTwNyvM1/aeHHI/49c6t1oJ89+RP0fgG2DEACCrK2wtE6YcP2/keLXvoa+PqDmqaINn1FEiTqnpFa3ZrdY0V0jLjmhq5dmUnb4nRU6N1tYXf2AXlNbnZlPdZD+tGOOWY57caLP7a5odeDVcBXiSyKbOHJO9zMGjZ1U73bkettGrHdpyf3lEyfUHI2Av5JOPbvob/AH4X2i8jWWMvx8/qvjbkI0MwE9b1Y6ToHbz/APCyWObA3jsN1jlFj/UgVs6ZUryBpP69RT+Yd66vMTrmhv8AsxMh/Zj7A+CR1XKCan8YZNpW5HWpXGzt+qVPW+qqkRdOih8fgBPqvs0I4ciPu9EX7WH8M91pWXqWefiepmfJuJPFTmu/MjsRaNnl5B/JO68XXjnY+EqZZ1Kvl7eq3Ex0DPXXNfkZfrfU2vWL9L4343IXqfrRJBM1pX7SV5wqcUb39nmY2LXQTytPIRua1/22P6/HZsgYvP6MloE7d9JW2jxIw/YP3ehq6rc458M48Lrc7HZ53Wg0ct662al2Nfh44I7eg6adJs5GPrutS+dhqTr+u50/isaVUxc6ormdck0jB/kad6pWd/8Abwa3t/H2U1uhpcnP6fJ/9T0q6Xl2fV39vJOwKplSItPbvIvKqcxpjfIz7e3mcTfWXOK2tZCf8mzYw1NElT56UX/rLGz61+izJkrC1sNf/VqXomdiV54PqB4qjR4Q1lOTtx5JDdf+wkBHmCmtboehm4kFE8Jv8O04iSgepDmdQy75clA7VNu/FH73voHneBEzz3KIMoibglzt7+88cEiz0OONZL5mnHctML9T7f2jzJQyAbnbsFDT+GBf6mZo/cvE/JUqMhSg6rl0rudeP7Ndo2LsmCIpJ5GvqeRdo6StAPkZQ3+HV7NJwdTNMSx1WtUv2aYp5E1zeqhP9/iCS9vHe4XgYh6LCFx2hnH3P10ybwYo3bfe5dk2nGuOBkk6HctVo2b0zMzS4jcdXRqmKxtcvU/XnDv60unTAV5+rUrzMtT1JGPf15vqAkySybD7csqDV6If9Lz+ZRFOOaabmRWqDyHRilV8Wb0BO+V89T+OYQESFmw+hVs3csn+PjyZ2hNzo8nNMhj2d4oSdxNVCzKSCcAUdIa0EszG6BxxNgMbfil+uyMm+hL0yTLP651OjQa/C+QpdxqmaxSs7HLTNCuSt6P18h5WXwPlyaujqjSmQpdbrIu0Wl341zRMVomdFCjIYEABAiJQI3VomwAG50cRFuwWPttocxjMmM1VUWvSnLPRyNPhi6H+hJ40dAUnXN1RzqYdyPiDGM/Sd7p35nQA8smqnf4hsEoiX/pTU6tyU76Gk6+7pyVt19GaTX46FJpaG7qpaZ197IOLugNG6NhtShETVAgMJA3WwS7iGcKRp5j6+N/tbtprfdE4kEh3QcTzMhppTr/ZWg65Y3+2lZpk4nrVdwNHLIV+mrD6y0POgqTxJSzoobibCASjC2QtAkh3W5HGc6WRa6mSFL2RxrJ1QhU3KDkt0Q4sXXnc6p6A1Mz9UdH4EsWkoACzEd+ZjQV/P43BP+tYicOLIb5luBEnQUZJ311da0ojVU9JNRrGmZgGZqmZyZAfHQLVV5Cn7QnNanRorx+SmvrKvdmUZrZpSeHYeP0MB+qoN8aM7xdTjKqda2hXATRxDV+HSo1Oh0EBWvxbHK9P2ske8FEWgaWPbj+fx6LL4mOgnzigJmplnmjvoaOVamjR0eNgqK7q6Z5ZOTHvUzV8sv8A9kXZ41NaNshXne87QaZanI/HWyqrH1zzyrKkVKB41UoarezxY3g5dkTO/qHZL099itSa39lpQo15WHUdpd54Q87JdtG2P2X8sY2OsFy3pOadyKSfZCXvvz5adpO61M6H9jk3EyQ/4945t1ocjStTXmYh0nXO9BCMwn4GVru65Z7eGcc8SvI9ou/8j5KPGzmne/yGvjxFDtDHj1zXRuhKn/W8YdDuT/5GHZRSIsIBWyG0YyzaC9Hie/a1u3bzps05D42ampvpdhN619Qr9rVAM6HYanJy1NmCJbomSg31u0l/pJ/Tl2fQU+vk8iflfWKsmo6PiFas4MlSj4KHqvJN/wBepKhPrNMX/VLFGpZX/Jzj5+pVD/Tejw9fpP8A7lGpCwO30P8AxHGx0z/Mzv7zpuPJ98hp8lnZ+8ZTPM01qWN09EzP2U2j5PiV+tTjYqTU8z2QgoPc2u51ynyUa1/R/FvNYceXnT0dl+Gq5KZudNJf1Ddf6DfIIeOpdn2nVrLV+NjI49LVSVr/AO01/X9k9MHcNgfk4FoMzmNgDvG/tMfzbU8VbXQRP3sKut3ByGNEAjIbPAStMp3p/MTHQbm61xqo8zW9clO+uWV3cJOpDxz+CZpprbQkXG2tVaP/AK6VK48czUhVc8aGevyPNx8k0+OeopdcftkNwvkDt1pvbJP7LiOO4Sz7mZeCJK3G9vMWHvpk/Juu5hJaocng+vO93dFW6Vhk3Vho3IszkqvEzQmsdDuvv0byQXZo6nRXP1dSjDpWHzfJI0EU2DQXWuZuLFqpn7CT/vbJ/bYTL9BGmqnJx9h4upGXLRsqXkP9PQ6rRon5R7mOL4X8HIGV3tt5NxstttPBnbI0VdgseZmq+qrxJMp45CVl1r7ChyxT8LbObrVb/s3PMl/JuuZEZH/czUaGCqbWRfBibpDFoKZXWp3qykNc1eiipSd/d/CI/wB3WMuoklCNbqxMU1oJN6LGa2GuhJ/KZx9OF2Ue3Z6PH8jP630BOqxssax4hS5rVIzp/wCvyWzPUpzyKgn7NxmRiqo4jH1MKk27DROuqlI8Bf2fE6V1F5OWcZXP/Wr1QyPJ9q/a0lS3IbBn+32JrLM4ul2nEzqN78ibWlRZrp87J3Tsr8cC8ov2VpkMWRgnVCyIvOIgFPPbDck6exAP2/T3Otcsah+PW2wNPRADpncvn8yucgFbl3LNakKROfka3dFNJ0p1oP7ayCZzVVV1RKYWA5f7TycY7tSm93uta8JtaX8AP2HXJY/9upx8lf25sZWXT+tryUUP4epgekQcEXhAmzsIEG7xpVIpQPzAxb6M5jDvGTxOgidXT9WpggcU1UpT40IedEvnWwar+0SB/jxK7De//d5qd65f8lHl39Tws1X7h3jqfM8PMZoJmElN19v66/7cpWnzR3TMzby1xMQkeDbvpqlFEqcj+71L5F/GN3gA3aCYBYM7wWmoaTw8jcWIAR8X2edC48b9al+2bZl0aakkRaOdXp4qZjxPPJU/kf42OrdV2s7qVfOM+BXT4pn9gfufq8v5GP8AbzYf/ZvuPUp+iKod0L4AY/vuUOVdYZy0fqbqpzlbmmdujE6h2Uv/AFPJvbNmwZRKwZGWB9VeRk7jTtz7ccd/9RpjjmpYK58GSRs/9f7Y6rymudEnL+vCT+Vp1Jzcupy8zT46PrEwNI8/tlCTwyhUiDLfmapJ319mt3Msnxuw5hNpoCmKP2j+N6xN0fVDGJfiesi8TDWR+2ug6Ps+JWdbJ9UtKNhxhQeBed1oL2/ntnHm2m9W73KJZAhyXdgLbYbE6OgO1PqJQZ1ci6dyzi/qsmtavboArfnX7+sTWr2U/JlfsVKSVO3UyEzHK3u/vsoo106iUK3RU46iYmjvjtqvBXI7Cq8td/8Ac4UjRzcwq3k8QjZMYf2ffSBv+0Wj9+9tKjGQ1xmupV0Xq+dhUEk18a1PE8kpI1Zz8v4beSZ1/wBduI8ecYs8/a/B9h8B4frqUVXBMfEYv9qpTvvQf2dcsNhMTqeuuQWj8Y/LV3VALkonnwA8a25FpE8TXP3rmK8lP4AWS2KgYDy/M3i2kNv04EJWBuUkDfRGZjRoKnnC0whORd93VOn69FUyrraLt/FXT5QRMnxzl/8AqS0U873jiitMTMy+EefzOyedax1U8Nc+G7p3keqf0bXJrrvZzud/kt6kdB9HEVyLdtS7S2t9tdb8taJDr9lhML8zIn2nwraoBR7bZZZO/caGCI+WXeScrx5nfHUyhN1qU8IyAa8hvncT8c1zjvcbqgvjcfWf8ajW96NRo78PhT8yMtGg145impV+TUvybXR/pcn9uv3Ow/Cx45yXWxo23unW71LWPTM/VfPJ4U1vx+QQQgPM9nIb9thtpT/P5ge/GmzdB1MrZcxOsfBSk1OalStlGl145Ny68WMUuO1HoyWba2zJZND08wMosEzo34/tU/iDsqyEJqjd6ROmf8U2llTodOqn6+PCT+OiaNnyOl7358x+yC62dGkDWzynneuXqGFsnUu0XLTMqPpp7x/PvH8nVtnHB0GtEtFzOS/B5rYyHGq2rOp6/Q/k43JVmSVuWLqp01MbdS8BMS88vYpNb01NJ+Kj1GM8VPDbN/aW+h4Gp6e06XexDdFc0jVrHc93i87d3ivG8zwxqMba/wDrX6T+jsY+tIPJWQT6aQh3F4TVuPlDjvpPjzeIi7xz9NXvTnPWhF/y7ag3Lz/i/Xnbr6So7Vo6ifzYS5afk2pPJWPmgqHqW9dG98szltbmq6d9J+av0/ONxT0rUlUfZZp0BWQD619/HKSbdT5Z2DcESfsSZ0dB5NzV31v9CV+6Q6qaN74K6D6rXAuWWEUeT27badIDHAA4hN91zZd+ix5n0XofWe4DUV6f08+jw1Oz/wCuPVzWPI6jrv48BlmtUJTAFS6OM/j8Hq/eHPQQYhIOqnb0p0Kqv+xRWaHXMrsffvVVi9J6L0W+bcWT1mf5OpovPr4Z3qe+PTY+sZ5fvs1Oj8D+IFVmcoDV5uLvjVffk+vSQzzvXYvf1d9VP5r06fTSTksDgWULeJXL1qWUEII8GCwNvyGCHr3P0WIPQZNXzFwf46ti2KI/oUBBNMHj9ONDmdL50+pj0nuN8f8A6v6xzHqMRev8a1jz4o0Y5urgMuB3bF4znb0fnouSpj23LsqOcbG+uDLzjore/tVVtKI0Xwhc0Tryz3TF1HeJnZblJKfkgBtwzkZPIhuJCSd8tf8AXOgyRUfSSfxIy/SgCjN/4NaFgUEiQPKYjI8v7E6qe54T2z18+q9NXzenojNl4a5z+lUrH6s+OSKzRucfq57qZobdTV7v4fX/ACQ9EPzdfE8tcTlSYZSvrAzVMDVT+91YP5rH1FmDHix5smbD8m8G6in02So3l9LbSBio8XjhMdiZMfiqPzUXP/gUXinJXo6zB98vj02TX39NQmrwX9vhskaPrW7l3RFJ+X1ImzALaOePPbWVRAqJplm+w2QKxaF9tj6/1FF4b5NRXwuRlDLkcnb8rVjeOpf7P0pmR6BPzV+uxYvWYKMk5CuslY6Jj/2eZJx/qrnJB1PmqKNmkL/H+tcXrPT/ACS+cWr5YJtvTdTU6Wp8klOtJrv6zUp9vqMvoZllTHkYKrdXF/CTxMrOQnpPMnU3W9L+Kn0wwjQfSdpNMN2Jd4RS3zJZPvHg3fvz8uua9Lnr09+o9Ll/x4vUtYfE0/HmP/VkA55dzxTE/pqQniii+ZDl1OWK+K3hjdvU11VD42oUn2B6Cscv5Y9xxc3deKoanxidzkDzkpa71e76qgrk344Q1pmqwvReTxGR07nIi9tzbW5mufLVEm/sPX5ViThCFIFiL8QQ2gytS0bBe0bt4iJtgEa6n0ef/wArBXocmtpoWiYGI4++1L719cgT1TrcvRXK54nDlzRJ4+SiV663Rco1uWwD7MyPhE2VBcw+qyYMpcM13xSkiz278sMzLPK6GuZVnqaobPuWBsw+pKlrIbaDrnzkv945NMb2zpdnU1U7WvSQDM3FxsP8U7Eq9xjVMqACXcsAW9p+99VMVF45o8Twwz0TahP99jRy6POt/wDYkOit3kx5C8T4jKLXPVC/5Nj+nkP7FUKssI2ORd91irWKaL/ySMSJPx//AFenHTT/AFFfMb6fsrwqV1XNO0qj9BvHt/e/J0RtNT4r7KPphkkoWaBi2T9n20VERH3MsZuZsONdn6uj1npT1GpK5MdHBR8hBTkamrdKi013zW6KhLnjfVQ/H3WNWVLOuVySVT0Xujag0P8A9oXlfzoPYvVHOb0e+V+Soi0Z+shuOudX9nUo+a4tGkqh7jgceXP6bdT3vIHPxtR9r46/VqAkk+Sn+vQLI9bZOG82gGex7e4R6gzkz4R+utbgylRkxTLMX9parr49z/ujZJJUnOrTXZ+Ix5HBloN1TdBUwb3dHKv1LP8Ae/8AelA+w5Q4UrFKd6KOzmCk3LrgQYoNLpQ88oKMwZJproNalgVpt2lCTs2cq68PJ4RwqpKpLMEC+CiEdZpAQYOOQJFsrsd9bTAvVbXe2uo5DmWfp1RPQpsJJHWvD4kMuUPUNT0xrH8mqN426aSbK8Mb/deJnSGv1Xqr+SmbX/t4VSX9yeDUqG9Tre6Xb+DiQzXvx1UgO9DZIP8ARAmp+qC1vqfO+XVSqmImBHHH+SAE3cvTIhAdvfZWgEve9td56Y9PHpcVM0uWpyb6Gpqha7VQneqZ663tjwh+IuseXJM1+pyRNZTnm6HJuqu6Vl2dV43pmvMyix+PBikyyzwVQaaRj7MutSjG5nmSVa19nR+khf3sisnW+S7Jvlo39iHHOnSET158UoqgJPzMneZ9LAPCSPAGtL0hA/NvytrWt5zrb16mMU/FyRcwTqcc48bySTQ3/padwyqD9NhN8J6zJ/5frstm0i0h7NfS/wCkmh5poNG+zw6Q10XvPqMcemYGbqr4xfHAo1HReStKPDPyRoo8XXkF0p6f/wAf0uOm56vlamCqVigLoBKnndfU0b2eJ3I9PpfYLeXYRvHgMXVRYAEL6yJMrx99ENE/XHJxjBVCFhiWzG0O/wCoVvfVcEbnxuvYPQYs3qq9d6o+P0Xocceu9WZAeqEfi1qY6u5m+IW3mphqusc87GN9V6qfT9Osc9Wyu8gXqp7Ptkqv6m+JryKIXPS/yL1de0+2+n9jxus2eZ9T7lvZ8azr0npXQ0zixpkqMs7KGp1tpzqBBFAubLAb5jguXGdTQBepEDG5xI4kO7PnmvcvXZfdvcs/rMk/a6yfCbeI9PKzixT2Mkyf1NBW5PqpulmyfHik1qbrjzS0NSfrbPON3R0j1T9QYvrMBL1v6zNKfeoq3UlQ+NJ/rxos+gb/ACr6rLXeqPk4XECUzMoEJV1Zvzprzs14HVGwpApFSsICvkIndkr0m2I0mROTEZYSBSgDkc30vzQ1ynEC9JRRHOuqRn9qCA2HO5qPtUzZO4du+UfK/wCtFbpGqHQSnnU8vKUl1qzEYzXdg5L4+z3rGT1SdHi9hO75YGa8tDM6qjQCECHJtCRrY72D1yC8+PAhoD8q3f0RO2H9BqaiE8+CoFpALiditJKLeZrlTW11LonmWnT58m+Qa+n1SdgrHJM9csF2ft8Gnqi3o4RyVoAJ073+HkCWdIVoHQEbETbvX20G510zrSB+LVLH9N4yLGVkUnXlQYHYCP8AsDXli8ZiRuhHnh8LXPZMEmytilAHaWbZEM66b0vrX1eLHioTJhrHj+UA6mTSo7rbVHWt9bko65yfm9efjGuPMcBcNG9ebafIfVKf70zpOt1+cHN/ExWNb0wptmRaGmkkEphg2q/1/r/XqvS+ujPjuUYs23dVCH0+80tW7pp5oDQhWuCvzOun1DsUjJW/debHjXT06mJygD/LS07+I0k5h6myj9xtPK+NebO08umNdc8H3nSvxGOTw+SW5lutP/zT+nHqf7IeN86fxmNHuKjVSiVWtNHPLVWjW1CaOStEeLkpGrPkf07KjlFBdGzpTWnWzzPNJ4GX3RYEn/tcOFBnf6+NMC3q7Cc/LnuDbnUyj0uvEs+J1VcaR1W9HgHWtoyv2VFLa3FzrmWx+jfk65a3u0oOhKPJ539ZvrtY5nF8Zfj6deI+pppRDfBrqfJQ/UE1x/VJq5ZD6/XIG/kdusfX10Hitnnzys5O+5PF3wQJ9tNhiJ3xuT9eZdhozJXnEzuWuRne560bjpCoDrz/AKrxIpu4JXQCk/QrmgdVOvrQ72vlDbf113v8HsjboqqfP1aYXln7+PqJtf7eF19RGXlhiTIhfUaudHi9abvfRvyIG2NnIwaorcMWzgK/eAQ4Ttpi0d/zTXtxbTbp8fX9VM1UhG8prVoq+Vfts8mh8KjV5v2hvcxU8UNX41ldvD+qkplnY/V/qw9WU8a4JqnempjXX2rdW2uujXWuaO9LE3WRZJ4Pjqf9K6DYuTpZ34lCaWSX/e3Tzn62sD5tcgKU0f4+8xzY+NNm+QfqNV14ZcktbNVXWjyaJ0mnYaNAHc3fx08VT9bOWWX9YnplrRM+JTT/AF3v8CnoDqo3AVUjEUNGt/tenT0TpNmxew+nGbk3okdTujwTOSqmjdKO/wCtOts68KDJpExwYkAAQRJ3SG6GgU24yTtsD7YsxjRiV3o0g15vdnidxOyt80HmQZ8m5ryJGZOrTz5g39udzM4ulh2u52H78KbBPrHiIePP0Nz/AFbaGWks0m6KA0AF/Uo/F2GRPll2cyUBMiUfRUPq7kGQ6TVfYlWRbJWVMAuQyRgX3G78fyB5POiJpPuEhqulk+kkeKqzdT/8VJp+v68P5I4NeIJOuGNDzl1svTfiRUn67Dby6NxX2yTJScw8jSQ6fBNv9vrEz4NVIbN/sqn6dD4pmmCP69sqnWgkqXinwNOtzuVggOOCT4mEb5UJpnQhDnc2NxxG/sBonjeqryNJQFbkZZjxs0+J2QD5399H5BJ8heKuvrRX+2VS5JI1+jn6+OTU/aKNRzuxmvvrrXj/AHR9CtaoXnUym/O02H5HicnlZ3uk3QbaNY98hRekN+f3pNsiiO4sn3Q/JEc6NgWZH+450atDMzpie6dklsa/qrVt7v7aodHPj8GL83yb3uzvz4DRAOpryJISFeSaNeFmjHl5ZhtZdLVFPG5Hk1C+KdPnxoHTmPFm8FHOjnzQNaBTd7utBQIbR5XYv4mScqHkCRFu2PfMyQAtufvnx220ZNIcswyNF6Zu/rrR1LPXXjYHU/X/AE1+R5ZnHdTfV43+oTOwDuvFVSz4f9hoTxtsZeZ+S5JQIHlpZdeA66f1QUgMhL9h2mchl63vuU861wTzLFeWift9qNb/AF+9P44A7/QQ13WQWIDy1vB2Hg7Q+cQ7azL1uaxz8sUTGWHmAV5bl2DvjS6qe/7bD7BJ8UfeEKr/AB7FqStGM7SSABEJ+svQCc/mZZM1RJczvmvp9Tne0Enc5HUlRLp87B3sc98kx1o+uO60gKzp2jvfK1ev1sk00/kx6qqi9qVY/hs5A/4klQ1cBKSdiFF5Ck3mL+w1jk68OOmhBZ3ukFqq2VX/AMmzk2ar/f4/7uLHkqd9c45BCpfqzvque/2pyU/23LOlVVv4/tpPjn9aE2auqF/db6PG3yiPhzlEx4/Mys9AcYxnczvf+qWifGp1yciI6CUSapiN7QN5fu29NK5xNgyVMI/7jUeMe2TorJNV1uiR09eOYLx+dkn/AMh43P5l3HIsOyybyaJG97FK2/b/ALscv0n6mvzKyWBzj2MEOuona6KNb0Gqrt1wryVpQ7nZj65l+m3UsX5l2v2FrdGwOgU1X2/GjieSHkcm4l85w9/qPvxPjc6rUlZMS3UJSLM7NblJeZOl2j/eeTy7nr8s71kA+NKj68k8m2NLWkFNf/LvetbD8XveTUcnxwbgknrRGwK39dz58yqM1sD8KQ6/T9o2bSXqtBy7evubOSRpE5Dy6QAbKRiyQqAkq/a+pC91+h3Ob5BE506slrfUlU72sRuZqIZRmudK6kdPTtRpRPbX629BN1wrT4Cv9v7fOvIif62zMRH6VrXydOurrXmDSL9v+qO/sbDQDTxqiO5vmhGQx98MbZUQop8nkjo+uj80YXZOQUwFaTwBEI31V77C1nH8YbzqXp/+x7J4xEw1jPlB5yJvYCB08gr9aDbLGpKT7ZntyKBDkGaKpJ/xw7+0iq661+LZp2TabqajT02u3nemGX66k1PNM0m53Ycl4plyRN7JOmfIqah+R2hyq67QUKo/HSBUZCAQAFsLGLFGDmRphHxytj795/NNtbhmW0eEOgpHU3VHmnc1uvBL5re0/GTKzLkyH9ITmo530f4po1XloU5/exoWT8Xqqeux/wDspTrSHmse3wi6OQDy+d/sanXk6sq5qk1uJfNR0fVko2zoNPX1V/I3ErawlG2bkq2FbSLY/kR+Vv0s8qsVPOXRUVloKlJrsP8AG3IOyQ/Y6UX9ABPf/wBkIrX7qdbxEnnT1tGt/qOnS6dV+Dc7mdjo4TSvUbJ0IPhOHRudH2V3o+THW5Z6vDvxsJOOaJpJK/UjNKrN71MkhckXEeICCv8Ab6aXCj2srR7cu2pyJjxYsd6ZljmpevCGout65NdGp/r5BZFIWQPrYs8VNb4KmWAyNa+mt+Dz5o0nhbFkpFVlmrlOpqnnYFTVodDOtSM9IhuqCJUa0UlZXZ07qdz0giKKEsy7StfpR5EG12JRABeRyedzpi4fv7X+nebaPIzefdJKY6VXk1KnxG5f7zzH113yjqudRBScs08v1o/v9Y0zu/3FG+Xxv6jqtv4p21W55cbLpeTIY+ZYP7VXXW9/XYc0lHX4Rr+zOvvMS9f9T6itgkuuWdcqM6f7fjvJ3x3l3As2bNAWZ4/mN/Jxc6ZOKYx+Y1kUp60MrLr/AEf4zy60qD/VDRdY4k873E6QaCqTQ3rUymgl0jLy/v8AAvJmQ5jU7iKJK1krwOpHonZZKMa/34K/HTE61RrWi22Oupd7TW2FfE/X9aGaJ25tSJBQ7fKziAgi3cFy3tkXjxlex541m9OLJyeOceq2zzRKJa7/AGV/9p52HIfk6qGpsKTIc3o2fqYtvXNR9fATo2ACIhGkRWWEfO+q4JTHM0V4fOvEhGxCpK/MVAqvvuhKevrjT/E97XR/vqfDsRofxyFBwVv+HYAbYWh8Gwz2+y7W21mb/FzW5XUz1J3oSVzKJuhHe9dJvWvJON72ygn0ppntyRxrZRs20TvZ19R1pfzK/sas+0E20/UquTraM6XqY5k5RBJ8IUkzFTrlMUsx9S9Um1Bqr0yLrhFlZmnSAGItHtY2H5cydKfp9fr/ADfR5OCy4hkyJVa5iTJW/p4TrHWp2+Xcv9meZGKmtmRqD5HfR0b+oy9PTLvXQAks6a8o1lGebnm4sxzWtdnPjuq81PnZcwKfudjX43DirJ1WuSVqrp1VUcbn7g34Sg8NAH9p2UgeHCy/qcNGxydOSeP5MTHjzoclU86hSbjrRx2/YKTyeA1tJ2yqaNItVPXZ0X5KmnctSPitn1kH+3NBv6/jnJYlRqkmI6ma62ofJW0lFnnbvqp15/bXgfmySU1NbvVdT399cypz3LO/q/8A3Mo280bgoloC0Wywjdd4zpdxA5G9/wA86cRt519jJ1PifOkHdolNb39TVvn+wV+EleZRU++NAJuZk30U7b09eDpN/qtXQxkIVvHU13WOKWk73OhamKJEUsC+QE2PQ9SORoWaWU8vOXRXcryAuxTyH78zW0SHuR9bMeUoH0uyQNz/AAexcP8AJ6Kpwyz9tLR/8UKv16yaZk19alGgDX+vyxORxzIaoqhJ3uZqmGEySSk7mnlHmTrlX8DFqjmpkvuRKCpyVJMbmtt/L0yiO/Imj8Gsf94opC1a/o1J5oYQ/wCtU7jR4+oWb/JDk4dyJBF3d3utuNHg9/Z6OaLWc5TjnJjkdHQgfo2DjaaaNdbHQ3sRu2fCxQ0EbBo7T4/8ghjDn+vnmd89J+ZHLu5CeJqamuSpZBbDVU6UDws/1qfI/g27wVRkkclzMdSXcW8VPRrWM810A/bwo2P5QsSsOU1Bky9hC32A8+cL+bY31L8dZD5EVoyVYzy7Z+l7A13s1P7+xvf3BcgxW58RkglDmWB0CLuR5erDnmGUKk2NVHS96kPjmeQro09xsP7arVO2q34mtoUZJIGv+0zABpa2c9L+ytH2dtVKm5BXTv3cGRaRlz/CdH8se33940FrlqZ/XOSJlXZfE/8AanqqbA1HO7GN/bVfkJjx1GhOwq2olkYQl0qfF3VfWZdovnUgNNb3SjVRRU8pJrZuzcuOdn+p2fY80aNqiUBM2Hc0/UMuNJqjdK1TTNdmjoL/APnpfKHM3YA3GxGR3BPc6PE7obh/tb21P2qCtivMPxn95Ufkqil86Zb/AGeWujZ+C/HjHjc/JW2V2YqomZ6T6cgVqeNzz2fbf4IzhNK23Jw6dx3BB3c0BIlvCDM6Yl2P5akKNVIf4xZeanJZIzU1XldrvUnTLE0lP4h3LFycDIwbjfkZSmD/ADH6YKzOoyV9pZqSMWOOZJZikI8z9tVereV8Ls1p1+L+SjFsS7q4ruZ1Ub55W/E6OUPr56b1XgcfjSmdVr7DLz/1lrFt86P34k/1P131+PMR8fD9dxTq3bXgSA5PM8ug0a+gj0tAA1bN2sDFla4yUiJC0BrnnCz+z/XQY6qh+Wpx/efAa3QGrrujc0P7mnuvGh3VQv8AdZ7DLo8EpiONuq2sfpkkJ8n6QQiYtOeQgh5XjtOQoUXnVaNp+idHJtZkqI5idVb8fb01GJCZaXRwk7/TtfApzNABSJRm+13vP8uxb/QUgl4ldpeip3sNLy19NRFz/wDdO1aub0mtUeAH8hlrnUNSzilydzdK+SfP01MHPlFgjk68ozJ9lp1qrHz1/rmFkHnp8ySPGtfWh/BxzqAx1U663qkriUaxaoICGZJGf2+A3T+A7Y27XA+mcDR/LZ48fyNPx/rW+qxMi462uE5eqpelH9/U3vVfr7OKnJH13uaaBX/rvqeUXjyCCTs8IJRXZVKnLrrWTW0HCaHHrwV40kzTJ1R4+wSk8tToF+TwM7kpKIlN6+oLvX7g3On8YO5+xZH6G8b2yOU+fp9VwyONWW5P6hoDGHMT9j+lFU1SCecmqRNV0baCOsl0E0j1NbA+5I1A3zPJ1WtSa3wadqHy5JVKoCzHYEGj693z/bf/AF26VWUfw4os5rjotpGSe551eT7LdU0eZ8df1o0ijBW+R2MTNknTbnSfn7wrfQR20VvyyE4vG5KQ4aUfs7aplfrW9b/SaPwov44RIer0Pkcd0RzGStxsjVmg6Nda5dEw46B+spDO6xgP1DrHvb150zzCO9o8/gr1omdEaEiYC8kUHmaa0K1Pj71f1eeT8oU0sGQQrXxgYwW9r6aBF/BHaJf5WxqZq26QFrJwVUnRVMhTVMzz1KGj/wC0CH5GWR+RTkittUj2TyJ+vI1SBIToZNIV+BNUs00TuAGf/l4AclDVNJyIeQZpHT+T8kmOtq1TPhlUWQie68UOqdG01udCIgMCNhC+8/pnR/Ptt+fPGlz6maqp1zZPEDJMHJB1FVvUlIa/YiaE/Mx5alv+t95J4pGuW+WW8hqQhk3J0T/o2+BqMq5MTz/k6XMfXqGgZcgBT4SOZ/cgM0IzOHXEleYiXwpNBXWnyxkdkpy6Qf8AfhTIvvebxx/I30oaI++F9LOffUZK/oNrv4vOM+zz0rf2kaKfts1pS/Av4c/HcFtGPIZMjvWMLmiQeXdPQgE739Y10zdAjvJlf6mL4olloL5n7Y4GnWqGadvnx0u/wY9PLON68yRXZRMkb1UKz4vX1p/WRGF1wzPqmzG0bgwcQCRZi2+jH3twfoOeZjT5JnDq64rRT01VGNnTj19aRkWYmU+1ks6Aj5frOTIMTr4hIoK1ynVbbOj79ePA7NnaBlAnQNUTjBlPtvc3VWVuBlD+tcmvIT+HN8zMNzVJxTQun6hPSSTOijFoL6KQGt/gn6RSlYyFhyfJidAwFwMkWduYP2QenSxPyZXS0KSbyXHWrJE5J1w96NHnX9XpLU2TLWq2JXklneM57VpX9Uhv+39bOgn1Dd3IbjTGqx0kqwXlJu/P7SvO9bh5qUY9O1QSm3bjMvH360Tyt07k1RFE78TJ9x0IMIwDekCYA/gADtGi2F2B2t2A9/GpyK+R5eAfAduNjUjX33To6GR/2lfZVcFcsmrIxXyUn/r/ALY+q30r5GfLy75SH8Zktax6NSBjqySr7ll6+zv9K1k0KyhIjrHrk395ZiDgU4pCBt8szrW9Bp+23o/AgJ7ER7d47CcWOhiNwZzgDfllHzpUTz8mRoapQ2LU6I+PU1qjeufPe+trJXl003NdS7kJup8bp4Hvrb/ag6JJoklNz3Schup0mOpqIWjjEsxssp6qti/sTmQVGbTqKPMUVOxycpDEOny426YeUJ7/AEiUxUv5DRB5EuMC/Y2hNcaZTLuZ2l/p5txq3O4240l+T7Y3nkNwdQJPbNfURny8jr92JyV9j68uR6vlhFd+K2k49C6JSHyCzTSDq9bjxPEhJMzemZeilXregeNskv7FObTLPEn0OB5GOup/a0dXRIFKLR9QSvzl6pGLx7idv15s9A/jgY3gqOw025i8kZvjKy4zuKBo/ueKJ4jmvEz+91orVEgePvJudTj534utt+JnJJNz0RujxPlZSnZFgTtErJpTuVGdD+8UrOk6KBkkArT0+GSRjCt0GypRu+VSTG2o4w1+4B2X1+j84ylhgDt5vgWBkDTA+toB5kYXa2tvFW5Gwgmcfxk/bwHM/JjL0h/9TUtJRf6hVtenXNkxenxmqy3jw6oZ3lq5+zNVdFfZe9OgqdTU9NBb6HazNTjB61zI+a6qW5p+q8hyPUqur2FvDnM09UY4y52JNRFxjqusdc0eKY1TvY1L+3nnqAqyLg5aHpWTZsAbrvYDj0sZ7Qd8YkxrT/yL1V+p9xzblInK4cUwZOccxrFioq6BhJfjnnmENOxPzqP4njqMeM419pi6qZ/s2PTG0RpqXJ5prw/Z1+cBblzVfyIWzVuSge97Saqhu/t2yyHc9HUqv56R/GMO/TekJ5SZixJPvqq0I7VdyV9UvZPimaa/DTGwAV8YyQBbjVUI1Akr5nYmIsE5QANg8a9N9zzVj9qwk3PNYyKsN2DjWK4XZp6DJ/daXTzVnA+rrJePHBIf1mg0LLDzkqK6529F1Ktg0JyT+dd79nuPTRhzHyYiTmpVQ4Z1lNG2SS0IjLyjNtz54vK5bZUmw9PoNTUs6Z01f9r3yEyhXGuZ+2sLJEX9SR4aQvjHB1fUL+UskplP/jAT227RrlPWXfps9ZPvl9NktMkByKKrMgYzLEv7lqKpakNIxlzVOOLki8Gacc4+WftOnqMvhiLnHpqZv+2qPHJ+WfdDFlxyJMEmMb55x5MkkyHG6d5PH2Oe9c9Gi/znsXqIw248sL6asgZMR9HUpDmgbUs3PjkB/Y/p2AY9SDKOcLa3e2JMa5okI3zttFtsbau+s9TeCW/TzTCGG5iKm8a7p/WQMjE+OnoTb94q/wAD0freCn63FXUQQfWVkqclXjQxsFV4emdtccqfheoj/wAdm8L8vp8zGSbmnRPl5eD4xmdND1wdUbxtTGqor0eS82DHV4nIVlw2tTFo33jJWepn9+XX9vMtdCBwwOHKBl2gfTeyMeOfuZf8etx6zI5M8tENVuaLg1Q1puWl6qi9YlRdMunW+Vzs+k9XRqnFkahDqRbt4dbiTTvlmtbmqk2VP5scuYpEHfLlb+oB+3EsVbMO9Gv1p3RKV+Vfc8fXp8Wf66SZQHIxUksPyeVWaS2tMh+mUfwAiYIvixGwmAQO3uFk2SA3wjstpmISGklcs1o31rSOl7SLPBHIimnwNf8A4jeYs8ZfTZMFXPmJspoo+pM8yUAN7qaiSSl2M0lXzs5gibyk7kqK3K/oNIio7l2621Nea1ttelywvRvlr7FrLjiuC9kFDLuQBNotePAwkmioBYMLb7BZaR02QFItB3X89tp1Fac1csTxiuDYTdar9z1/vetNfYCpCWuhdOPJreR3VCJM+eSe5upS/H7yeda+r+5fyx6mJmpetzWvIElDW5arSPQ6U635NI+KMvNjNc9PnachVy8hU8/s2b3/APjPySWbtLuGlC39NyIjGlWTaAH7TTZIIXcv31b9N6isPqseXSTOQLD91vRul1aVByrf7B1yM/nR+6Ypy4MXqoAjJqghFiFaqa4K0+dptZkrSwlTx+X43jlJ1x1oIVHiXbN/7Rqp/TvrVBX51voMp6j2/J6fRBJ1TVS9JjnZGOu+oRKqIZomWNB5Un6TSYBR3lP/AGSbm+gGDSJ+4EOI8kvzrl/U3NNzk3/jxpLoDchGwv7PSgByvLoMky1SaZMboNuMAB3tOa6Q/fndIH+xdu7nrzjcrzy/F/Wt0hWytS+B1N75p506ZLddNbmfkl1VGPuaHY6TbXnZt8mqP0hRWpqA9QgOPmMBk3CaX151J/FADQ3DRH6P7Rq+XG5u8NVU06WnTWh1tmZMfXXKJrx/asaWWO1zP2Eq1Njqf0zbT5Ihdr5J0+DflOWjRpJomZk8bsNEV8jT4f8AV+N8J48/kenypmiiOt6xs6680iVz4rew80weNsBP4iJABN3J7K2Srn3IL08qXBN7YwAGvqddlDLhgx5dF42ny10cs7mmGZyaIkkDc966OtWfRfH6fCZYiTNmojd6JxzRHDLKSY9yzPcvaa5JhHXegrJOPGeLrnc35rh5Kmuzk08U/HpVaBW38uzlvHjmRnJVWk3/AGeanmWsgwSwRX10UbqgWdKqYQIHpQIGY9LbI93+mqDCdoJ7xOxjSqxHq/Wd1UkYkuvkdhxk/pO5Z1VWcyPXmoAo/Nb6nJ/5vrEif8UQzJOoxpjdLpu/FHUxzW93xL1DX5tapx+kyZCNVTQXo6rcmyqRo087yS+QnnYD+Vp9OYfTOW7x95+8p3LdyUUTjoolmlWtIcnVfXmSs/UJYxFjJW0CxLL1F3IAcStj2ebMH3Gx/j2DHhyZ/cfVSnp/bcb6vL15MqhWDAeBabNkeNzUp56l5f1frM/r/V+p9b6g3l9TeTNa/wCQgujiY6N8Emo/t40b/tJvPec1+j9Dg9qiyM2WJ9d68Diyrnn0/prE5r4Y1XGx7sP3z+czgmn7aQkdL1LWtP8AbI+DY61z1qjmU2vpUOo1mxt4ghYuc9p1RwLZLgkxixgoHHfWVZjnh8Xz3v6jUvA91t1R/oI6rwPCzX5rUmslak57p8qCnO8aVra0q+Df6XZJ+Ws1RLVYpJunT5aWUCV8hwMrpX6//VHOk47xrGziuo6OA6yPKLSr9vH782DD4Bd/TC7BXQCQQeNkzuANQaSVS7e6iE5ESfpYHPUoxjHzJ8Y0TxvwD0Pllmg2HnjXnnbrvUZXeNgHxJXMmn9c9KJrwtU//OtbK/Nj6m+9NQeKmFJBrQ7u+lU/+6SPBugZ3+a675/XO1eeufr1/VPt5k/RoP1/pdk1OmCCjD7bBDMbF+dLquxQlCTuMjm6A/MJu6rg2aXHqp3Ir/qqvbb+5HX2p5rT5/JGzbUf9uN/t1vwrW9gn7/3vnaiosP7L19t91sDqgZ87/TJJoJr9b87k738c/oVJ6N/eVEW68c0mjzuvA0vP4gzBhJQA7BxPPtrmKqPqX5DAAeO7nKem411/wDif39RrnX12/vz42BsGQFBOM94rbw1QA9hrTNCs0a4Z2H7/WytI/iRBkNj9B53yV40lL1yvQoH6ZF1v8ysXFbGqijckK73OydkhVGtgnjex/Z+La8l+SN+yv8AedNmCI8ji2waKi6SGr/W554f6AIB34NDVU35XRSD9HoOZpkmii4udzC1Lwh9jnXh6p2aX7CUow6/M+5dS87qd/IVp8EFYyq0UNCFAS0OtUfkkEuj61X+Q6X6yBqGv0g/1g+tfYNf69gbelO8ouBN3jMAWyOsIR9iECPSF/DoarnIzNA3ySmiisoS93/6yep5152px5UBOKKax345wtOiVdI01O0/uNTIbkNSwv5FH0Wr/tU3CHa43RzX+iJBa4lmOXflH8ZFH1+szo+Pn490sz/Ynb4f+tP2N9ZN/tcgrF0VYkJqBtKOh4wOynyV+eI1LdG3ErD/AO2amSTI6Z+O5OZrgeaAZdaNq/gA/blXnI2qLfE+dbet6da1LDW4eeh/GY4nKU2cg0k26pySS0cvjj/ZIbHc78bYyM4GKkaWhJOtS2yD/wBCYUfrrehdeNflBCarQAZeEv2zAhDQVTcnAHnA9hztOs8ctVDptNtefsB52CYhfCBU8so1P5HMlY8dV4MXWzQVvgJq6fsrrejyfXxUypzWP7CTOprfUeN7KOd1rspZGXzzopon8BuMlLNMXN8O9AjrZNPXBNJqaJCet/8AV/JIiFODbgOJMWwZyNNW9sF8438yJ0/G/HiV07Ql33xNa5fkHxMsvlEdqSb3+CMzT9aerlmhmyStUbT61ryxHhHTIzqPzOYwtxja5y/YluuY2cAXtHo+waN2bPI7XjjHUpyiVtb8LX0CL6EXzqXmWuePqh+Acc//AIbKZGzIW2hcD9LccY2075oSpMssTAfY46dnLPX7o6P1zVO5P7eU3XzTwXG9TSjryG0/RVNLI28teCl+r+MYnIBwCRNiEyUQT4ra0mtTp0VM60Iv4mcT2ofXzYOTQbZ3zsnccgk61TUh43qj6mXJIcKWBZD0xBKmDIvoImbL79vvMbZZAMm6rFRR9V4NHI8ruj9cuN14E8KX+F1E7+lVxWv+xudmj7UVx4oKAepDg4/F/wB/GtUVLQ2jfgmnSdf7JZrSvmvCfjCZrZWjVN9pJFaNTtoWlQ87StE/tPyQDCR3dsdpZx7K7kd+d/17CPGjvxhm3lh0TRcxEy8s+Zl1qftU+Dmv/l+sVuZnmZr6zJoKZ3rWSr2fbZQ7FBlR0JEM/I81qFsrapNal5IANb5PtPhXw/mMgs13UqSV1pJrxwzQbJSvMhqhTf2GmCHO0yiDuWom0jSPbieb/wA22wKVVK99FLq2JmscO6n6m6Ng7/7eD+xv8PuURvidTRT9SpOAlpeq6Nnk5v8AqvmVX3LYHgxlaX6zRj4SHaUnU8qa68y6Tf5lzjIqrPHUsVs6B0sHUf0eXaApIh48FMgkEDdqYDxJyBMWi6vZ39mjA/LE9iysg6oSTnmghF5ALlStbHQpuSWmQPshuoIylDWTLB/YZSpEmqnkP0dbare6PryBijcYzQRQ5F8884zjG26sE8W6U26GefxWXHrHqaNHOTaDdb+tTrX2rnUkkk/VSp2fkszlC5gD8PvsYQGM6ccdztFi5YufCjT5MrkqqPC3MUn6/T9UJJx+UOdrVKG9/g5DNlnnjh8TW3k3D/pv/da13ALTyn7qh+SoxzT9p3M07Ww58oqc8f1pfAPjwP4wy9JRuTRj1/Wp0BPXm9a/rTN/o/2fipX4Z9RRYTEYMThiWvJbmPJt/rnfS8bzFdaFtkKN1Nbnb3QfSUZGZXT4JSz8ncVrspSiGp1JkvYbqtnXQo1JyJ50Bpea0ogZBiSqg1tUZ3a89X5WtKE68Ua/CwpJS/qi06GskrEP18ARt5NeE26NJ+Jik+lWzgIbx/FzqXKtAhHxf8wNpw0uSnwb5nElDR+uZvp8a6NDoQn9bF/CyM4sZ4mi+fJPVDSE10c8glhPnRvUrtVyXTlpPLfx9f2qf6i6XdT+/toppD+3eoqqAPFLzjpZV7FIybeZ14pmpBN/1a3vQWhgkiw7Qo8KzEydVmwuOWgOf5jTFcmStBoNeDUrMjXX9lKKduhPDW6dfmXU3H9g5Y5NfHZUu2WA6lOiCqdeEyB9eQx7L7Hz9xqlPsVOofAMvk1t/fJ9X8J7tySxNbqrL5JZNAfbWnS6NyjtfFD+VSzgSW2YKBhAq8sECxMywO0OB4/3uttZe2jeTd8QvPPOjxxNG37vIb25P39UEyZtLoN8nFDfnyyltfvW3faf7PHZ1UeDIeRqje1HhvlmWtc6WVmZ87PCbfxhkCb3JvkxFs656Jgmm9dH+11vZrfQpVM1EoD8WWCCldhxAChFr8Rf6+3nwDvGdLxmSoanJLJYkqFTAlOmp1yCyTv7XvTLS/jN/IaJ+K+lumtFOM3TLZd9Kv7BDcz+h/AxirIVWt1OtTLoDlqUKNCySM1oD9v5M3XWS/1+sUvGtLr7rt+vjTQtPOv+rX4AqkK5PD3bJ+UdsmVA0WV+/wCd54zqW8Ugg7NYzT9W/wDqlU9apUU0eOFZBUlhk3VaASEHnfc84jepZ86/enbPitfjKN0SUeIkaOZlZZSap1vvr9h9kJ2U+YmSndT5Iedkyqp/2v8AtvdEviqoD+0lEyT8q23BMJqc49hqSWhsu1wWBdHugdtFFa+3LrqZMnitY/qpWnXIzqgJ5715Wn8Zmyd1BM8kRPJITjtmVYkrroqUfFPWg0Gq/F4/jasoTcqqDPLJ0Q1zuinYo/o/VePxRzxB+gvxtrafrmj9T/V3r9bFNa0wUwCmi7KoK4AjIzPI0w/9rbf33ftp9U5JDgOKxn1DTRyaZGmRKgOWdqbEPEs3k5KyRDOlFcYpz0dPm7/psNRZvwLVficYeeUjSWS3MrO53Icu5egAZ3X1SJTZfM06I/rRH7NGmeSqybp2yp4N8SUdCthQCPV6gwh2AlRJbqtFiNUtw+OB/NjnbUtLXPUT4oUnQ8vH9n/dG+nW11B58gOTJV8xIVxMryklRydtLqfP17TfRRofLFtY7fHy9UMUI0L58XuDQi8h0ht8NCzquPBJeSinJzo1lP3VdJMzrx4rehZdbJuZhXdNj+FCOAdmYIyoa78DG+bGfCtpkNbySz1X3FRahJBpXRx+3Zp8Ka2/mNzRNJrkmVfp3k6NlPSlC8n66Z8+Q0srLOW7rdPXBWq3X6ZRlPrve1D/AK7Ni/hn3i7yTru9lkkk08OqLfMS0/6PLt2jzQIC37KFyElwbozdP+bL+XX3DcWRPSCvMrym6OfvV1X/AG4Tv+1AaRHYTVU5JY+/mGq07f8AHKLbJQLJFTPlTGvflG76sANEmPpCO8k/UaqvCfuejS0P61W4slmIp1rm/BoaGjVZHa1kdSM/2nwAzNfgz2FpSw8cuJjbTt7d/wCH66xs3QM7VxlVJPdbOVryAHjo1+tBIboc0wZMf7qjFJ00M9nkm10BRLIQGw145D8GSnHXczu8s83c3SbJqftWusc+QpF3rQUVRh8ta/Tfc9Xw9Ts3qaTWgOY3rx5Tw7pzIBcizMRTuCsFiFzpTG/09nhzJGix2Y1JdTlGG2Ypi8midVugiGdpJ2CgbdNjvmHbLuXE6l/vVf8Asq131wHSBQvmfH4slim4NDRJsEnraNaQDormtfpU/soy6uN1GIyk6amutdFSVkxq89GuXWtKSjJ5APSAT6V2nERmmzvhDTAPeFibYktNFb+Y9RValdNBj0g0X5A61/fqXyLya+xSH4oy1Y8zrknCwEzW0PKa6CdJK1+1m2gFZ8y30hxjkGU89iNXES8nnuZrzp6/R5AZ7Gmpm+m3VcjCFXFGv2f/AAtNBW/AKNtWszOyMSJt9BGi2BwsC454kHhidS8bXeanJqe6qHjoCJ7Bf0qg9S60mufxnNVrmoGQp3+7T9/bz3VCO50J/wDKh+IyRJ5lZbo8Tq2ZrlEa1J4nRP2/2ztPL8fX/TLuNtC0Sp4fo1Jp8MpK7rwMj0oB1WRCJAjCZt9pwo0je83Ie/F4++siY+W8n1ZieaEf9MdMS61r/p531vf60FfWSNVEzMO9XT1dQT10V1TNn1mZZ++pXYv5kRktXIkBP1BYmtSaba87sOp0rYTvml/IyvxSXjpm9RDos8Na7tp8ibnyeB8dfpoWZgfcsHZrzjTIKBlf697bnIzpUdXmP14ps39IoOQHeqafqP8A9VpnZX4eSev1lmWKGPtoJNuQgQljlE/RQMrpH8r5KEJmpl52ManrEBZ9nzu3RXiRJRD9/hpzM7fLkxM9b1OKgCay+I58f1/pX9OnZyP/ABIbJB2gDPsziQLQAbj+Ab3V+b76bjqqrSzIpDbJK3P1lsfsfua3r5F0/wCukstPKVQIQUY482jJINCKuzaEVM1pHZ+LTtlnjFlb5dcTOYJnuZ25Kau+RmtfshNfb8GZ6yJWnmm5a2Go0mNbPI7Nc66N606/HI2LgdoJ78pwZMTXsZhEbBELlELaXjLmcb1FAXZ34KIK58ukPqnnolkdCiCeP/JVT8hjrq6a5MZYAEm97bUnWpKl5K8b/E5MY5NyDL9v7oO+d4zWPXLo8SaRoHz+HjjPbY6Qa4DwvBGuqr7MIak/ShO9/kwPl9MNRgckewiGnqX9bxDt2EcbmNWowzjKpoN7y6RqZOp5DUkzWNHXjyV4RUFy/JVjtQccV4ENzJjdq9U+BjS7D9627HXS1d78Oqvyqk6kK/YU1Qhun6/XxSvIxSrJKoGgnrJsHoaHVKB/t50Hg/LtZI4tsMeV3F9KA/FsNIfz7aHLE46xkZWacR8hqf6/XaVyGS6DRsmdz4E8/kZMtxA4jegmgK5mP/q+ptOySiqHWvKB4Jy2z/2571FhLqGnZNZLPMkBP+2f1JJ+LNO/rrlQafG0QxmzVR5OTnTrn+4T+ECKQgc3VgVc4kwAeI0Hjj/Qj3aGxVp3dY8dd6GJ+s0Tk+NKdfXdbokDbRcOl2+GYyoiaOMtJ1CBSDyE1Sk/43nTo2qbXwDk7iJMdbkmfrG3/GdVW6k8V1JOjmdV4K2z+KrfESv9qgxi90Y2k+KtTuUmZakmuXrdGofwFSxZbLBt/Ie2qMABAz9EPOOCvI06Z5rJmc08V3MUfZKdUnIzQr4OFn+1f9tETvL1+mTRzvjqpZL2U7orxBrRepPC+YMsVjr6hXiBP0y42NtUqAj/AGmVeS3uSkpxjMiz4gp/UmST9lUf3qiZ/Xip8/rT+NhoWU9wA/v/ACwViMP9gSY/dcGQn5KsxRs+lDbXOsXUczInlaOcd6nqgkmPGrIZ3kjX/qOtFF+ElYNrSzsLZBfFBO9I6fCUdJOJ8O5jRrq6Oq8jNa8ukdB+PrJxM26rRMFHRfWznfk+ySijvUlBvZ+AzvBCti19rxlaEf8ASx7+PppbGOgvJRvUUa5YpKBjVPdXQ68b3rnYMMzVmebkl3J3RbR0ATWvO1WiT7f11s0Fo0Vk5GtRPCX9SCJZdNO+l62Ua61p58WNLTZO9y87JBvNOnrVf7fLsN7n4w/e2LmLx3+7+iMgBwg7ePsr7heXpuNJ7/3Tf0rTqCpK5qr6aPqGgK2E+DfSGljHu53WQ3uK/wAkmvN15UKjTvXg80un8kMhX1ViqEpndQ5K/wDqnk3LrQfWutx9thGq9OR3up1JN0/ppHV2fTQzVaA8O5k8/lNrYXiBOI23v7aYubfvC3xe3gafV/LPNf1qSG9k7pjRu6dpqmaRFEDX7/FqYpjnma1EIasa631dM89FTp/XWuUAoSxCzoNVis0jO8kSQ0HWx5vQGoPJNf66RTkp4cSDlJut1Uhv+4XCzEnQ3o5lTzy9B3TJWzsLZEzhxcacYEwQJvxy5GN+G1S7dBMjD9Nh4N39kryn9t61/jRTf4rCvFoOp2O+S/1P/wBV1Ughymga1rZ+Hz3Z0PUnhQ5pxoc9XvqrU/8Ay6jlCkUbZWNn1IaWZkx1kTxNjQ5OmKfDqw0Kz0wS5E/z6BSgPOkSjE22z2hfZe04SPlaqa8rklyPjXQ8svG6n/qCpbqXQT+RRjpo+08ZNS08DBzoGloqtmw0ZP19X9rrig2UDkGa8c01O+VWmY2b3OlNzooH8OYqqr9X9zIK/qed1jrInVMOjnnzaGymX8T2F/cpSTx5eNIWQyfewPsUglGHoclJWzHXLTCs0LVbfkToPO/7rsGtyedu6ecUvlp/yWHLWQZ0dUKr2y0aV1Az4n8XjD4etkrUQuRaokJUCnfx7kJpP0/rwP42ZMkRLo51s8RTwbsRF/8AqfGxed0LEv4ADsCIO34du3LnQ14Umrt2n6TzpFfJdkVjEctBcyzzvmeslZAKxIr3XBWp2dlTUzbU0JM1irl1onJkkgWdU101TVQ62T4ncqlZLUJVKs42q+Un40nR2+apqQU1LM8/V55gpHaQ0oSEPOwOMlVtndVvdBuv/myXQgMBf6G3G86oP+GVeLSxoiacmTLlyQ7qiROmXU13BzFf25mFpXS07Z/A3N9l19pp0kHkhH46a8sm1WTWiugo3+MjvpmtZNy34mUqTlZpdG5+xMcorUBtPzJy8/JVBWR/xCxz/bX362a3pGt7pA0gin+sKbTfICEXzpdot3hM+bcaP45xnJQt2MM1I8UIR3oA6NEMleTSV9RePHGOrPtO8mpGnaFhM+WQnejZrrzJoQ/AzZ8fxUy0/SV31/c39dc1PGu9kaUig1I6ZO7MVE0PGPv7bfOtlU7Sv0v9vqweOh/MzUqkBZc7XXZn6O+lmxthq48Tn21Zr7k9Q9TURoUaB/2/3etBNc6WdUCb/HYuKpnJ9bK8NVotJPDf93eiUNdByffilNtswz40zE621f7lb3ut60f5OS5Bp43QPy0GKbwLOR03CJNO53ff3jclqlFEAn63PJ1D8zlA7Q2PI5JG6eQN/lcY4vNrLV0yc4sRj+FbYkauipaYJ7yni9M64R8VP78o2Mj3exZ3YqSIjLzK6OUUj6DTqZ5VVM8mkqpn45lqdD1pYyOliTc/VkL00zt0M06I6Cxcc1yr4WWfkt1Q/VMmtKU1Z/r85qpIFpRMEY/mGDALmwLE3CMbfLxgb/rrZ48tX5ZZqZYaqZ+1dG+lqmja6on7cka2bbGTI4fRevuhF9HURdvTTlyYcbLB45g+QZoNR+yvJ+VPTD8huTo7Z+pQ1LOq+y900PPkb0y/b9t9TlmMGaadGYwxtx9Vv5SwgNnPUlS/spNbF3hUJAItDziGJ3N7gbTbDZT7CLEXPczyO+kX48U6+Ov0hM7SajVfJUsn1n7653I9gpX56b/GccVi9C/IzZOOz+uo8jU6jbP2keIOWe2PLCeYzldks8mmKaOZbXxXLs1/ZE8zpJn6tHqv8cJk9JFs2TixyETsiWe5ooNEnN/Iv6k6J11KVki4JAmPAAvLAjB50UI1AIKJFzIujH051u/5FkK9TgnqaeYkyTWoiuckjSNFVkHpNV3vYzs647N1DU2Tl+2oy9nxMUbxlX/WgQWImKR62UUO+93zY31uQq+4nFeol5lVpJxzzI/Gr4rZ8hWxAxzzvqc2sczDUtc48l3sTIpQ+WplCQq90lLMGp6/MtkHUVBFhB/Iy8abJV3dHsLfbGQYC1rvVcxD1xU5HUXPLUlTqSq8BxW/qz9NywPh/OX9X8TWqLanL5tmTV9eO2ud6re7nnySeEON76lydMxktqspGqK+ooyaZMafvl1PhqVO6/NT6lYoAia4OlK4LLSbRrzdn9a/7O98nPXQKQgJTUeMbl4GLHWdYZHGSp/T7i5Y1novWWY8vosoVhyZJnGurMWXUzOTEPM86FpmXVcvhdIZclemtgcaXWnxo1kXdXUPNdQNDJRPTWue5nW+ohPjyBtklrYHO927rGJOwGVXRp0x+WJt9Thi8UpkngyzT1d3yqsKtpsnazXKTXhH8Rd/puImV42XjSw0z7DZCB97B6z1OP4QyYuLn+3gFxVfV83fiZBDXZrpKnZf1Th3m9H6mFJrFc5eqd+AJySSyieNV9ZsAK0HTc6qOxpceQejVeYakp19QQ2zLujaSaaPyhN16HNlxnnHkFmmWO4vkm9LE7kn7D1oCjw3NAJVkP8AuEtAx9tlaC9KAkEFLUWxx7Eh/LGq8U0Zcf8Ar9uiQvk5BmjX/dDUmzQ8UGyw5HDNwUf5FN60z1oC3Un1uQZQFfp5fKNZH1WTHZ0trTJyaUE78ddbAANux5Xyy4dk/wBKkdUvi5nbyNbVo15ZCzT/AK/JCbyyM7jCCx+b1OeyRnfzxm42WrN9MfvdwuKnYujVF9PVPh1LqTQfSfL+UMi+Z5SdzjpNHVSzpaXen9bNb15/+fy5J5f8u5vH1klaTYSTMuiUo34A1LQUdGqmbEvGz/rD4+h8Qmxt29eJP/t6kRZ8EgK6uUCkpv8AYG48qqqxPCuxa62HBUb6Ocl0b+M+mPlWlU+pqZp+y+Sb4k2E62u9l7R6kwZ8kbNZYol30xVOPfyOJOJejTpsFcYzTFazDTdtQITPM+Ua1MzPmkVp8fud+A8A/g4rjF6vFZ4n5fs1VMvdgFFMxkmmTT4lgR1UoKflHAeCPwsHmcLzGqpAFQUvnEAi+x/Q21svdGj1dJ8dTknZRiJ+zTLc11M1cKm5ka3o/bP5orpKynUAdi/Vp8/XWnlRNHLyvSadH50vusl8ZJjkrejtgs3TSSNbHU6ZaElj66fzmMnfREwmr1VwMteA5+zsPCGjboNbX8CAhsEgnsnfOb4B3KoPseVf3DH1Q035r5n5I1WpkfB01pFqkpad11o8Smtht/ppytNfXlKTfmhOWZPk19jZtZ87A3bsrOR3I+J1OzWpb6JhGhEXf2rQnRsASz6ee7p/2rfW+BANx/8AVIr+wBVk/RqQybWQbg2m/lQTpGSMRF2A6YjiLY10fpaf/GXagrz96pr4weA0kfsKOeWTRrpXY8nyIA44Ii2LsW6n/wCplKnkMnkGaI3G0UK/pc0zO12f00Q3/af/AJfB9dw34ZA2P2E8UwDeGkC7yMdY4pPDcH1ZcaMwSKebk11IKsAlelDdGEgiXa1n76okn+QLQM9v47/qoKvH8TNVMY6cUm8c6PKyNFFCTLvqVQOKVtelMfzf+X6g16T23FHqs2NkqPU5/wD7B6VGlKzZHvJH9jDjsFJH81kZKm7qlovowSz99rBjnHpjmpfEQHBP3jSBJ+7ZK9Njn22r7+JrN6uzHSvr8su8ZR/19LG8Mo/TIZqny7MkCqQJd+IwH4DJ0BoG3pu8/W4z2wL6T13qcvuHrPUeqzt1ky5baClQbfvY/fgnc6/UzOgKxvQ+uP8AxvTen6cfWSdhjrzwwAVX/wCzqhBDWjc7b/pPT5WXLeITsxIvhnwuTydgef8AK063IlJSUPeMt16kxDJOCJA5DFLKmSYlfv1S8+Q2aGdutKTYUzGGREYnISAiDnSx6j7x/JY/J61N5Pjh1qjIaNPTBXhl2g8hX+MFZNy+Pu6GsYYzVS4zIIQVNEn2aJNDpPHgoQZXn8TjS7PkGQDmknReznZW611Vfp2+Ngu/x+X7TW/rqNT41t8VW/8AekUDx9zyS+b0AMlEhAPGNmXzx7IJrAFhuPSu4VocaquXLeS75N7qfMj1qYfBVV001srXl1GjTvX110uvt8gD/odzora9Sa1oJ/8AqfHn8fnrmOt/pJA35DWze5aX9AaKmdJ/2/K6xk31DjVf9hK+JJ6enbW9mhD6bULYbchAiwAKPpKAP5YzrHqVeqEASr7f78myvrJVqhTLtPKeZmq/+61O5roOQGts6fP5jxyu3RfPTvf7n6bf9FfvnxvZrf6g08g6JgGkJKZdc9Aqpz08gn10O6TlgmmtbpOXQbqmf3vf0U8J58H+w/EMhtR7eJ++NhrMtJAx/wDKBTAW2GJ5y2SlDW65NeJdmp5207fPLLI1XgHf2ceL5j5LmzbVGjc86/xtarc0aliQ6+v1o6ciPrdO9AkC7B1HjdBqXz/V+3J/r9lMwxP2keVfKBIAw7lpfsbNn05HWuvxvCeVvzhNGT+urppYpw4zP4ZABsvbN1q9s5rToIrxQRT42fsafOpKNNP1WXSh1xj72c65/wDXVV9jxP6kWUVHXA/rn8C/OuZfFRPULtrwDQlZOdeK2FaAuUmn8eRBJ0QdzL4r5BfAE+SihXVJ/vxQSQetJJuIEkR+WMucb62FmrD9IlYRftGgx7qCv6dk49XWh3qugqXmaXX10/6N6VHVzU1jDUw/LdfQoeSkOpFrX7JAfCcSn5MfJc1p1EmkXn7ST9ft55k+upmTfMIO38IyIeZf/wAGUAbXk0t78bUVN14nRTtoARdr8R3gxtuZ/I6cRnnmPZxYffR9nBr6CzH6MdN//bN06ekaF6fqmtv5NUJtdeCEBXp3q9+Q073Rp/sg/mH2lOeOckTVBJ1flrpvyj0DYG+iQNb/ACDIH1Zx0aJ/r1ImpjI1s2v9ul7WV0u9hsNoCaEL3bG3c5fZYxsr/wCo1F/bno8AH16REpNX5egrw/1J06deEz8k7uOaaeaxvIyc466Bcb088dboa588b/GwW9RNdA/2rnVH15JK5CtP6g5XfPmk/F5bmAxuOp/rGpQxn25mqrbWqOh06mBfvzv8RmXAImEytoIKMI8aWyjtafv7N43b1XNUz0fJqaQ35/rWx5cR9no/qa1I70srd2sNvVPQB0TQ8dV458+NB26l0m/w+w3ktnevjP27fHHG/wDf7G9r/wDUh+vwSYy9TVcVOXdbSZQJbkFa4pf1KPmpvmuVbzDjP1PIR3gjTvsdp/NbjytZOS831yFOM1EyOiXUSf23dRVBz53T4glHbsUeKOaoij/uzScypCklR4/ZM9UzO/CIRKv6X7B1+vAzOq6enaOn6icjO9P4WTJTqQJkPiWQg8oAuzqNTz+jrxs2IAQDqkv/AMto5Ui3OzUgfw3X7xK3OiZinJOQTl6lHcUyBp7TpunRRpeWDmzdKfrPVSGsczPltK346Ulit+d62BtKZ8zS0lfZ5nfjwLKdbVV6NbfBTMyuwfyCiinNuydERRTu7mNW00Dzrw/V8b5dfZkjIAxA7foAFyIenl7Qu6nvw9t9TdMU1tvmzxJqDpjQ6meikrb+hnZvVANZO7oywuijRsmLeZdN/wDVqnToWtGjjw55tBdHG5UkH/6jdK7E0zpnfIKIV+JyTyTp40SJw64rVbqvsu0Zo2rPjfbqZMDcNnmyfk4LfjRMu1sfzgyZGxgKNckM9fDR0zMj9ncvhKqpNFa52PloPycRYoao3RJatEGmWepD66qZQ1bsJK2stgyeDc/HITyb1PC2+A2Jv98z58k7lqiD7kk4fLwokoaq37vgf155Hy6VQAYvzMLYAdu8rgrJ5L2t6QYgfyHo8GQQeaLDXVfX9zJx99tf28v/AGdi9aUaodpNVzchQgbAdeR1zT9qmdefM/pDk6xlxvXPNBoRDYPJsAP3s2vO9Aqcam+t3iyWcn93HNE1sFmY0Dua8ola6dLNSApWZO8AAwMTO52L0bdru9hhjP8ABOoKyOzVY55cfS+bomOl2eN/o8G71E6r7fjYqokmApqR2frewlb3JVnIHhH/AO1p3F5JrgAAZCgINfoLWl1vqV8A6nWpa/J4x5DTuTfRVeJ56DjdG2OvP1k3+jVcqh+IIh/kZQFohFM2Dg6QuFuctWd+UW8lODpd7WpNVv46mkmrjpNN0aNw+eefHe5152cyTkKKBrGnk439peY0BQyTJ+n+xPh/FOL5Miu/EdDWRJol+uM3J4qNbZ/ck7/ZX47I0Y421pZk0a+tEhTT9idzw+A4NIun8AmT7QJAEO3b340wcZg/QOVKi5J76w0/2B1/jDl026kRFfHmep87nfj+yCrS3IkjimUa/R4ycU602fs8q0E+NA/KY/NSVvmd6Um2JJfkaN8+du1B3pd9TN1bQ0T8bve2e+JNS0vVrX/4iwJ2IbsGwgwClzTDkxAiQgRIWnn7g8WPn+WOmrfPKlTXMlGtghzN2AGkNzx9tOnb5jE/HMjDvXE//tNHRXijfXD4aNTp0v4cksvnja5RaP8A1mtwVQa600Ey+HYlV+DPOSqxoz9tyvjrRMzjW9KVT9a1KDUaijr8oCAbk7kEJj5ZBOb4PK0494O8ey4XK0UVNmSSorkadkdT4mpk/buf+pH0PPmRPzLZuLJ5ggAlnzbGvPKNft8/1qiaK0c1+CaxzLjxb/UOuj/f1epo2Vo7rmZAJ8z/AFlupnbr5MlddknOr+wv/VnqVeZretuw8thJIqaQT6WgIJ3i8iEb6TBg5Hiwh+f0haInHExjKGnm58laSQR6uHzQExzpXS+fqMZJrbsnRJc1EGmeRvW9/Xfhfvt+wqNEE7ftueKZoO6QTkKDUxPLetFTrxvx+Dczc4xQoIyahNX58lM0Xd1IKGprX2Dy/kv/AIgYvsUpX0Z/Qn6Z3jP5IawcWSrNcsvb8ho8TPQFKkqbI0bodk+K/CPseCfrj8viKufHmR2p9w8aeZ8njdQx0m6kELQ3JWnVFbS6uoDoN7fG/G2Mf/rsL4qtA1VNaZk46dcxV6JU+2q3zWvyhEBNGo4txIFpndDQHmYE/wAyf4s59DIf62/Jz9Y40C4+jW3fKTCnTrwofg3dwzfxqUzTqU5tyamonrTVRNWVI+DkKn6sslQs/wD2Kns7r+kzPceTZIkyedeNU6OvyZ03O9fTFdR8h3tlZg5rn46n/W0Wt+B1I/lApIYMG+PlcsrGI8FkR4N/feHbx4FrDClTXNWXDM/2651FVLyS+dslhU2RvUSZ2lqnT8mpuXzutM/5PI//AFNUz5nwfqvxlXVa+vSczIzsml2XL0VIq63rfP8AXr8Xj67rztFd1P8AoRQ81O5doAFarz0P44CAspuNtw+NiDg6JC+l9x9t99tMOCteDJW8pv7SbJ58v7JV0clOjT5l/IiUbex6O2qdUys/07eZYS91P18P9t0GdSdrQmQeWp2hSczTRqYlnVB9Sv6mqPwsl38UhQVXMNSNfRmd1dD/APUieB1LtEFD1Mg/8QD5JF5beNjoKgq0eSuY7fqtFF4tqa6qSKnUtd0ldUlVrzRrJ50jolPJzMK/9dJlNk3PKD8XmfJSqcylMsrPj8VHOnkmKMXKXJMuia6gS/ttGdohNTfUpqS7kOicl1ATc6qgqTmcickgiV4H9Oq8v4U1EloYmw/j+hUHQJ2HvwPp2G1wtMabO+dauZqiAavT98hW3R1rY/8Ayo6JRyLMb1OR6J6lejplmclrsqKCGandgEiP5M6uZv8A7AfIWkUVPLVsiNmk109P+12Uru8aI/QK0Mzyb8Sf/LyrTsDxuZ8yLdhI54UfUROQw3oaD3XEFayGpjJBHUlyTVH/AK+g1Xf1NGqOYNCbnz4cGNs5C9mRV8HbPA46f+xT+mDT/SZKQSLx45kf7VEw+GgaRLunk6dO3npZnXnx+RcrM1sUcWmB+8rvyjVN752oFfuj/YAgIdoZ/M4IIRkwraY/nFjZ/wCgdHh+KPHGlH+1Sn2Jgliia/2a5kV+vRRpLLkm4oJkZMb9ooUhl3M/Y/qijrU72Hi1dYrcfRqxyAfYrU//AG657EZOijkjlaOvxseMe5DVvihHnqeeWrdEzQyiPKob/X4js4IF7GAPb9FzpDFrL7be/wBgo0qc/mQxUfT49TJIEklOqVIDy+BjWq65Pwt9Y4O4x00f/cmWQN0qqq1MTPgrWn/UjRouiZOjHU9caLSjz/YVr611pHzD5dKPhKxzUpqUrVVqmdy1HkWpNAM629adUP4BpbD6GXANwZhQHgac+P5+/wC1tDX/AGl2S5AnJW1JU4VrRzuaYokTbqJ8ixNEKOhMWp1JSa01/wBubPr0a7NvKA/kTe6l0Ic4h0U9nPFrVNTr/wCUmtDSbNrMzk2T+oZmNCcfIHJfWT9mipKk/aHg3oCu+AhxY4axzcjSy+F/Obc98Rj24naFY687oKTHM9QdyFQqB4/3zWtb/BaWlD5PvzF1NNA/0apQ5kijTLMhvSp+R8pJJUsgk1ycje+S6V3y6ofB1zeyiUqXc11WrK8zU1SE5ZdDYyalN7kbfDrSk0DabDngYEcQTJkQdUPPG5L7d/EA6Q3M5bxKborimOPN6jin9IpUzo8pqOV/HRWIiZD6vHL/AG80Ad5a2HNHQ63pT9rtbTkKPi5yYyp34fsBTlnpm1pka01L4l8c6wNQDkm6WLlftyadTdmg5Tac+a7ZZdIMApdvKhSv03L0mri+RufJvc+zcaOpwmS6Crq5ydbyY99bOblEoHYQaNr9ttSEzBdH3JKOx344rmfjFHsoDROodaHr7AVgNlTev3krpDcb+2MoDZU60S0Aoa3Oomgf9SN1iiqHZL4OmtczOmRDf7+pRr8klQohPICWPzGQnJkXstr7C/tvwZ03zWN00HyY0dPXhkuSl+s+TVfX7ePqstE41nelrG8H7mbweZ/3fSzrl3sr6jq0pVJN7N6o5KqtwUnOzb9lv9+PKym5rmvx6wxj34k+OB1o6l2tKryeJqgCg+08nS5nJ+/OxuDufu08nib/AHb50yamJ5vQgTvQsgfWVdeWx06K+uk3Kfgf2me6J+uNGedU70FU63Vft0aQA1RP4Vt5bATcHifNCY9FP2WqaXk/SozX2GlWuvknfmL2bOarHPG8Z0PXllNci9f/AHP5R7QUHExfngWMjs7/AKD+Z/kabdT3GE+uRdb+nkllHJW6Vvfi+RZ/0NSo1OMdC9lOWafEkgHDT1uXbrkRRn6vKF8cRkMsRtoZZPKFKy/KH1KeP3t0SeZQ/IckDkMkptuD6nOqYTdV+58Uyzt534HW7nz5CX7vbZbndgjf7fwzbuBUjscjbc3s8SD4cfezHxXdckwlO9u6NDa5J/dYqihx/VBudSiV1T3vXkman65ATf41eACpr9T5HwpOrrJyHIjpZ8f/AB5fzJyk01U9IkOpeitzzk7UfL4a8PgTwb/JjP1Nkhd/bzNz+LHPa1snbSnHjlHgXpu3Us0cEN08vU7dsI/U5n9TY3EuKSBml41XIm6meVyIBKispvS+POnCsrSBsZvGH7s27CSznVD5pNW9GORQJiKmYjzU6LKQ8jzuCr+rQTW5NlaeTrSAvcAT4CEK43/3oyxH8x7e0TgDHmTXidbjtkG6KjUu9ePHjmZHYA39vxlTr43JQzjnU4vNDkgn7buhr/eg++pr/f1sC+9kUl/JKlaE/oJLTR0NTPX1B+tbnVfi8ny/Jqiq6s0jr6ZJ3ppGWkWjhC3nSzRotFwxtcGBEsRHHYaFOOfpfsh9MjTJOctGw3i2r51Uuklomd1yfU2a7nYE/jaqckCRsnnaHNvOl6HdUE0D/ZXxX1PCZsEo2Jj1FOv7DOmm3SqgVOlrU+E3+N+RI5lPETVSEn1NlfoGqAGmOJQo0/b8dJt2v7JO8GSoM404nn27nJXb9NJzUPJ8dnLEZLiXWhfJOr+pyfJSh9XQ+X8Obg1rHpuZmY/6y3OptuXmd3vWzr7EHnxLYuOSiZiiTFUsNVvXXUm+tbJN09Trbs0/iJ1RTr48kZBq0k+RGZY801pb+oDsfj8UdLc29/555zoS43z7plIqOyjTNVbU/Hl25Hzrza8iVSy6RQZkK2QBY0kLNq49xc3/AL24hTcwuitMUwc6/VbK+QTtlkV8SxrXUbma5pql7P3+w0kvXklF5cqmNZ8ISnPVsblMi9KPll/T4Fna7ZID4XN0Q4/2UnpHzgnOx+v551FDkx7kU0PbudvOtP8AateZhTQ+Cnxv8XNczJIOuZ7DYNaTqqdvP+0FJCQr/dicy5ODUk4mSwMfyUczr+20a1JoOtVNOwGrMTNM/wBUWlqvHhhMb0fZH665N65CcngklpWmz3AKMxufAUHStz9brz/O2iL+Jd6f8hp56uLUemzmdxq9zs0To/e3KMLvf32t978Iwbx1VcnkV1POncP+qInLNVoiUdGmdT8qPLMOT/Vb+yf20eQT8krbsK/XFv6lq9rQrUyaeWjSeODn9zgZFha8IbEi7/LR9f2keH3vtpkZcVPOOp0QNamZg5NSqrK81pB8U8Unh/Ju1n7TUTDIpHjJXKVVTtqhNS+D7fvenY48Uz38ckmUHp55msgGroZnjQcR52UaOfw+iJ5vV9VzF/2vyTxfew51L9v7SG/2O6pCG/07RNoY8xpgNX+33fl2GXpZmF6k40GKp4Qb2AzPkkKPKgmv1PhYw75r61Y5AFN3sZZd3r6mv9mxU8Ua/MrVXl3j51CdE6Plmear71572BrlWKAGT8KCzjf21xWxakxVz4vKboTRseaR1QVv8hgzdbwl6d5wd9tGT/MYf38aFlyNOSVoaNn0CZkqsZLTsfs7nndGq8iybX+G72BxEGplK3yzVJ2b3oq3/r9j97Yy0031qqnZJXOrmJmQpo3Y9KOtVMu3o6oIl5vX/Y+u0rmNR9ZECXbP1IGtqg1wSS7TBF58+X/klDvpW/lrREeHH2m2ruXiSMfOHgiiJdH+TmWgnlsipsqRHhNqyfi+SVKeJX7AQo7MYumo1OzkPOzwnlKJW53cN789QYxRnaLPMao0BEvj9eB4VANczs5quJOvkUbqtpygS0SHk2eK/IQMkqdowUBYSN1i+la1hCJ3SH6X27NJ/wAksseYaZ66knrpgnRKUeZ3uo+zvTyNx7inn7dNaqJ0639fs8gTRya+h4A00fiLvI/GYtIMzb5gevG+mjd0z5oOHol29aLHmLvVywg4zYEdGjnu3z+/GjTrmmanby9T8R8EMuIuW8MekZKGmD4a2+/57IatTeLFzL03bKL0M2c6iqZJ4UdRzquUPtp/HkyecdBUnzdKfaXS4hoDUUHMTMgLulfKOpcOOkNmSJ+2N2Vvfy7HwpdS1sXyIk7/ACxVIeRrolmtpy5E5Ox3MFdHPLU72C1+cxqLIQgiSYlJjCeyaWrBDQdgYzlYO9oMHGrcfEoEKNOUoqaaCwqMgm5FK2SGtUAeL/B9X8JhbKVckMrU0BcvMd7Dld/QFPPLoKMx7+VyVkipY6CnsHIyVMchJyarqXnTVnTXI64j/wADNffx/wD1xiOckFXM1Oqmh8ESpLrqVmvIJrE1UisEOoBd70goLcqClOdNxMxm1hxzgzfWndyFUFVWldNIXrVdqFVHLqkVdH7636z/ABaqKnYM48X2KS++DH9sciFW1snWvtqQ5HfkWWuwlZP0bZ807/2o0mTeh0d81PitNes/x/cTQ3yxgr+pyOomOSud0umTgHJIy6YaaqIAAPew4AJH3TFjedFMVSUl9LQ5+wuSo1X9xvJXqstVKZHNUFzMdaprpvqqGTtYrqJ+NJs8NOkzVVTxMpWNkcYTLmZ2XlCiml+QIqTdVqUPpVXPV5HJncstdxk1W8roxFvUgm6g3Itm99xUsOzXeryTkIoOKx2TqX4ZyMjNJ9mymWJma1s0UJMBApBI+UAiRl9jPjtEtVLGN1MMIHfM91rU+pvroYK+MuvH1WoOau+qey9gDwtTzR1pNRkso3I0ck+ATyut1RvRrXfh3qUORNp6voOAZbLrJWuKt1MMUqbno8and6Y0L1+ayMc+A5NQfa9/eh+vih6dg7eS9fXVO3aghBiEL3NmBHH2a1nVOXbfYfz76o5DGxEf1ZSzdG2eQsekHSoSalXne9flWPUfFmMsxQRU9aGGp+oluymKjQ0vinetdDbt7ySaq17GimZK2LLt2RVbgDW9km9TZT9RH12mua10/voDS+GrnfhofsmtGvxVCxCHpScH/G/2sh2OpJh7EZIBs/e3563WeMebFi9X6ePple/sk1FyNVhDdVRqpSV3rYdSiUMmQzz8WSiSL3hrnZ3qSZeqp+PJ0IAadaNu1no84Y79NkorBnBJ3qZyEhjTlkjzualPInO6rX5XrCzkZ1zRfX9vIy6ZnqZ/f7mQet63vQSRYXJUbAKyDvaZxGkS7BPPsMfdjiFqjnJ7itGoSKOSW6bfFb0kaNbbrWnxRKfjHIFbk1No9Jsx5KZ8f38on2DpNzqRnlb6ii8M5EC55i9YttOlM3l/+fLab2KgHTWck5CVhnnidcnJU7++tqHnz9TbVT+p3+JAMxJdpx9scpO+osUr2kTYpghWG/l6e5PjZRGHnYP9WmTpyCfvlU1vy6lHwGWcZws5Ptqv3PgNqbKNT4CdJSFEbF5CotPD5Uvr6vUm3nfJPl8BJp3X9ad/mL8eLDuQtZ1Wm6+39GvBpErk5VlNSo7rw0jt/wAYPfuB3zTZnhWuqR+YvOzNlpLlh0UXjNVPJB1qWd62f9ep3uUk8mtDV7Qk3ya315amo7NUP+k2/VrWtH9giNDM21JXySbqjjnpnrYHgkdynjZpX8CqjJjhlZZ5GWQp5ne0k7Tafev9CLrmnMj3P7WPa0XvdaUCRi1wA+DZg37nE9H6rPPqPbPTZKJfiyRHFHnmsZrfVNV9p5Fqd/WaPs28vmcapXjd6lYIGjYtF+ft4Fn/AOETo3+b7E1XoMmPrqTiyZkQDaTTMvgSVjQnTUq61o/UbjTRLviDkPPnxk31orZqvAuutf8AUZsbOOzYhec6Kqvwu2RnC3SwItyWrbOOAJo0f/b0Ot006+25Oa1s1L+j82XppAxoOlln7bs3U/tB8BJ0PjS0bHX5qg2ea5D7bp14Nbn7Gv268HKiH2/e09KV5gynLzk1VHJE71jlZAqvPiU89VvfW5DJZ/CBAyAEWXdoNGAQdSKpD8+178DfjW+x/GU1eWc1XMyaI5x9TJElanVCcbrdjTcg0bdkl+KN7X/FIBos3U1FUfZdGl8SztfJ5oYyK2TVx95ZGNbnWvjTmwk3vUa0Fn1XZe4tv0uI5uqGTbWTfXJj686J8Nia+pv+wn5Na9QkDibfKo3wojIIOtAne0EbkLbjFsi2rvpbx+mMnuN83PpJnF6WKr5Pl9yZohqU38fpZ6zWzri5wGwpfzn+sufJd5Yy5Kb5sWlLyU7yVd1HlWtun9b/ALDu167MfJ/4+F+T0/pYvHjqgZvK1v1HqNIVfzXXON1viMc/XWvwfSkXWNsCORDWisjzzeSardQdIaOqIrzqbWAUPUBsAGYBgEANXHlaZLCG/wBXJstvaNbfGGH0zkqK1jhi56emAGqXqduu+b8K1MsFIvE57rPkyZLmjq7s3ST8fRxI0b0qs68If/a1+dZ7lVY/R5YLOuWOpPGmOeVJf0yTQHVG53tK/OMclTzHQgAIdo+Ae0Nn1a60uteCpoH0wZLkpHB/CvZECJnbSqNMD9NhBcXMMbTp2NhqaJC+Sd7KmtIeN6p3pBfK+NHj8ZluKkbx0auQf006NFNNPnSH6aAKnYP5GM5mJPttnTIK7YrzT4eXY+RCvAP4WRaL2E8eHbH2Z5/fXl8vl8d/00UC7iy4nOzRxMNg97akFCIMbqe/teweNazNEBtyUrXc6k1I6JxtW68P6AN0L4dP5Wtra/2HIO+dM9aNlLvwDJXCfrRufNjLr6churVdaldB58dIvjbreuUK8qLr7ef9pjPqaHwSu9L5Nb1/1Dz5/MagLmbAkSDkxY+374VmQRcIWwADvbhYblan9uyStledeI1qeh2j2/UXYK9aDf4fZWPqRjzJYzLRo34AP07N+XlZ1Kb/AAMbS1ra7aitJpSWZa5kZV+syHQaNtOyoox7LNdSsvW9Pigf3QG9JRJ3rXivxRcBMTOyUeT27ak23gOO2T9Mh7QLGF1gNUeGXdC3qdKfrX9vBoD/AFo/06KSJ+nyxW6vUnUukWJUPJHIU63WnlD8r49VAeT9ABx1Pg15D970fsrwfsNvxyB8dd1Hnmp39TWyCn/dE/RjS0mk/KpTB4sZFwrDO7MHedbdP/HaP/y3QPfhWkHTeLPtanQOIHaO4501o+3LxzLsdlHWvwqrJM7Y8vMLu9jXhTYS/Yfu6FjWjSEymTHCFaMklUn2+sz1O9UgK6fBa7fP2/BtdDNbpZnZ0axJPL0odeOdu9tT58/nrU4IkQWWcAz24xOdaUjxYDmAd+LbWU6B5qxmgSeUpgNxUmvp4pudbmkfP+1lDcc2U+BiuteZanwUorsdn621rT/UVZjnejwbaPPmZ/8AqKJnf2Nf78n28CJJV5OsZKEvil0LIT8b09Vt8cknX9f2flt3E/mxwVayOwVtV38eM2y0VGNHLD0rRps7dVLNIGmne2nRoHwYzVyKJT9scuqu6mS9vEGtrVH1mNfVZ1vrx15T+NoX9vKhW50cyMNPm/MvNAqAeHk/Ap41Roq5cas0aaRGslapHSV+2iTYgbmocgCI3fptgQxFjuhoRwhAYttzdRH5abETcZHYk11rb1+p3PldivnS68T9eh/IuseOejXXiNMFnRrl+R0V529AUEmv2P5AV589i9eK0y6FF5OZPqof12eQ60EdVPQkrX2Kfu6Oq46PB1rlDbq58G9hsgIN8RsGxkImOA5V5vNiMMSMbSz40ZLkyMocu7KNhvrRjhvo0rbHB5bfM+fybCvqDs006+Oa1KcVTumk2KGmZZfIV+Fioh//AGFCi0VqV01OzkDZrW/H+1F/Kch530S/TnXch/krQqfaaZOudKAfi9Xph3mUI+XFpQcFytIm2HPOChsTkabBjt8O9O7FZpXh4ardWihPPP8AuK08v5NQ62w6mo27+7KTt1Uv+PU07efrIa+tbn+sgOtTDkCKOolV2uzqjXk0OmnxB+Dmuujm1n4ZnR271vezY5PpsLnxD51p00CkTcTbZKTxmLQJkbFpj8r/AHGFplwUJetyJ51EoHOtulH9bn+xOnTqmvjxm8mvEk0jTpJ+upkZooK8fo1rg89P5nbcY7JalCOd6rrU77+rUmlYV8SfY0FxO05Cw+s1s/rUzP6u9bqunVH6ZKmk5pZJ9Rd4Ttdcjv8ApbRkHtKOSNwvq5fGsQjCEsnya1WlRqCemteJk3s1/vQgb/FzVyzijTR4cjvj+0c1VVRNHRXOz6n7E3+MrJ8fMqWWBOzrhrWt19A4ReQ8fs+w/gxQZSx/62VVm9M1tMcp8e/9wD1rc686/AgBIpIZNyPrYPi1tM/43xB2Ppn7SvyOheheZDksroA739a29/Z39PG9eHyHQRkydeNVTu5yMgnOuhqvruKaQJfsbGafw3J/Q+K2lIKBjrJsZaA615/Ym9aY5l2PibMmvvfLKgzGSlo+0ckyf/U6qn/ZyeJJmChk2D+Vjk3Mgrxo4tbsJHCe19PxwM7u+Roqdy/H8cnMw8EdfZ1QnLJ406PzOJkuQn77o2iOJ1olAZQDnnadTJQqECxHjWU2MuncTQVts5NRcrUMvPl5duszWmKVtZJx7P8AWvO9VrwT/wBvHMm0NLyGADkUo2m2f98baTsCHABtwvtlMpcBuVty9klNiQbTUyeF6ZtXSSaDX9hVi45xlZJT6xy/VU+uoSqaKfGzRqAkNhsAauf28aOl6m+T+tFjWq2BPjoJE35/G5/vxp3rmhZJmtV/1NbooT9gW7it6PwBvaRFXEFzOe1wTOkLlWMX3InzP1DB1Vqvj14rmmbnm2kHzreg5JPJ4frWmgZHVcGOJ0VaTqhamB54KadJOlrUefC6TX4BTaVfLM66xsaDxGqCq7QOtcr52P8AvqTqutS/XsFn7V9uupHI8u9AB9fLRIbapbhFkItMRmETKt9dAA9iFI4dodhtmLnKI+nk8kN6+N1S9dN61Iuz9dA/tT8yXEvRiI53CaBLrlroToV+ov2PJz1KuTJKc0u6m9tUGjTxVOoXcmpA3/8Aa8fjnG1Q7DYZUNRP/wAOMRV6OP1srTpNz+VSWyALL5hYBTMNbDxq7r9osco+08NayMbOjK6/x/Xer1Pj91eq3PnUy7VNfeg/FtZNbP01MKeFlA+Sq0vHUmn69Ank3s3SCnIlSvXnqmeB2FEu9Gga5jwM+Rh/7a5QjDKzvdHkyLTvxU6a1tqdaPym4lwdpQ4h22tgnSZQ/e8bD7cYK04ZxRt+7J8f1krsDY0tU73rbRtBrxr8GOqTmV5h3rTupSvpWTRo2UJNbk+OTut1kB2zsrZsX7wykByHJ0U1IbBVB3SIR3Tpi243NWLHTPM8CrVb/wCrPLW0ZE2qSjxAAJRjiL44VhpHCmIN8gz37RC0XxMT15B3o09SXzJi6P8AtNE/UEPOyv1I8fGwo1bGORndTHTLAV9SHsq3ZR+iTvfJVkaMgfS/i470MdTygFCVS87o0Vqw5yfiPkzECLklJ+zNCNchutz9Z5dpGvJR9uj8VgBfLhNp94hC2Bk8xjuIbZsBst1pm2tdY2U1ifv9V8TtaC0fIII8mN+5tm6vh5234nxNf/ITewd0A/egDyoz0gPybgeqNmLp6kmuvF+KZ5dV5Sd/ta0/jsm5ACS9TFpPT143l3tE2JVIedBLJWmJ/Ui+UiCGgTG43msTtso/mB+mkizm2NE1GwyUQ3evMan6VLM+Ir+v9X++vx6NSdWTuSvEGOa0/aXe6q7CVBJrVS+a8VWoTQ6447+lSZKh+3OprfRQ7E8FG1nosRmgB8y8/Dph3LoCqqtpG15p1WivDpfyqTYEuQTP0Bw8t2GYCf1/Ze+MeY1njIakHxO9Y2PP11K8b3t8m5R1tAFyHL8isf1kmbk6rwTW+qTsfDNf7dTPnrpvXNT9tOgpkZhHhLqt6WqfsoVRPjkfqGMnXnem6/3utMz/AI18q/rxzOlB2JRaR4uXytp+r/J29t+2bxkxez0pinJM8MU34rryzNx4J5HVKksmqr6eL5qW4zVXRqXb+zYAz9ZqhmjZ9TQf3Prs3N3d8+OOa4HrXXkK6aWmvM8+Drk3Ku/yI+RfEp8arW/KSTs8lN7oPPIUOvqhSjTfdgjdD027q5UcXXP6xYfyAp8sJmID5J+RqWEl8dSz96ZCYlNfo2LvexArcRPJ0VMzk1NrMqPyPWo6Qo/WzUugdfhxuJPM38iEvhrGXriayV4nmjXKH/zOtn4N5GKxToadRXXiH7SzVrUzTkTfSCeKN78NAAbWClEomAyeVnTQFsQPo/t3+2pyaqyeAPEGpJFNQP8A8cpvln98Bven8i98m6IaJj9JvVT5aoTWxOmdqa0f2MrJV0eeZ0v6mEVnyrXTjN0clfs0efDE1uepVuWYuXTk+qO2bFfszM9P68XG/t+OMXNhaEIHd5K5S0fz+c3zsdDkK6FDcsRrlrryUZDSu1l2un973Pj8ZEqY8k1rNMz39uVneniD61pYKHzv6rzQhEo62ZShZr+1TBOzV+NWBXMHh8Xjd71l75nYhNY5kmeJqN/W6ReX/wC2/wDXez+z+MZTGPpcEs9wPfTcWz/N7fxxrHJUuplqi5J0UdUABzv+jq107XrZsfxfLwZOXbc9cpWorVMPgNGuvO0HZsl06ersaYK5rxUOkjmRL/7X0U9n2p2SlB+NnMTX+qBiDeM+tHPNT50Ts/219ugHwfjvn7PB3dkAmSkVqd88WUfV/TS5iLSU5V7FoTh5/wAfe9/tQ1Jv+sk1p/IsaOJ2cTulrkpkBjy+KFB5ASSQ/tuXJ8Yv9lo08mylmoldARL0J/oN61pU/wCWqot+1ZWmudFcnVTSfsKNaJ5TZQr2ooK05UG0XV7wMqy07Hn3yN8bxbaNHxRkMhcPUd0ZAI/sFcyh1YaSil/Yf28z3+2hUrnYUPJ5F62k/VW/Cb3R1ppeSzJogqVZ+qkyiTKTvbIvM8vJ+53vho4spoZO+qe+WknmSW6Q3BK80G1JTyt/jeP44xKKi8YWjt9c242iZjOpKYxzrX2Rcgd1JqfNW6Nxy78KFDrnfWSQtdtAX3/ZeueXnz5TSiyaZOZB/CnHOKPtfjQ+achpBKJE0mv+kjXlXqkF43JkQmU5OSvE1VHIzTTvx5Na8eId66/FZCWZW4ifyUEg3xo2/ceQuf5GsQvQ0S9TcrZ5hUXr+xoSWJ1CfVd7/CrTJ+iecdo/Sb+NP6lb8V+25dL9db1+KQ5Oro0xGpkCv6/S7/7bNnX/AMCaK502sbxE9GuZWd6/xS+RtRpNGiHSOpNeU8CYYPYc74HuGCW7f69vb94NG2hqGmZ/e5KDW6dJjU+tEmg3J40zO7MmWZL3l05NnUTcAlePKdT0kktWNOqUFzO9k7pn4StL3kESkyU7Nnff7akJ1rzmD69ayMN7yVtRrztxy8g/eQ1onXU7nfIxcbHINiEM5/LK0c7n620RLMR+v1oeU66J1eSrNRvkmnws6f2H407x6YoXUzfjZ5RLqvr9v7BTtn6iaa5EsxY8e2d9TPmWqnfOla5Fmip3rWtSFaejmseR10b7fNax/wD1HWKjz4265jU/Ww06fygBAfabW2mbxOzkl/zt2/mdtC8/WWzT5HfPT3LM1RXijolTW/B+9fmf950icHQSTCyb5bd76xiP9e00a1zQax+ozCrDL0KpL/XjGKLy0zPjmUOVKmb/AB5imtyD/fe6oqGEk4dg/HpQn9ZDU635/Hcxve+znDtfZCdAzH8gftONLMmHVhD9q4dlSS2HErtmojXhqf2P00fmRiF5LBKquqDbMa+m6nnJSG/q61vfkmfwstM8sTO0mPMcT8lbPkPJ5E/v527nyb2uKyZLvxZ9rS36uQNDCv8AYraEzBtWf7GxE2cbYVocOb7iWEBpOePzjYY4520TLM04t5iqa1TvnUdfWi/NQSnO9nW3fmvxY7mWHwc5K64G/wDdykiv7J0n38TpnSBZM86LJqgTyQTTOg0zueoo65Ef6Cnh0R9dT9Q1Rz4moHySJvzLrodOvMi+ZANuAF94ljvEsaJ2udvpBP8Avi7J7R6mYlKmPqS08kl5O3dTk6QDpVkQ0IzL1ePUx/1ia5axmhS74elE2danw6Z/7CqAlF1PMsu9dzNf0rvmv0gAcu5n98fjKpjGWvkmf+jVa+oeXS3L4VDU653/AL0EUpBr6LON/wBQ9Oz7SP5P830t5AepBxzrUhNU6JndFA0QFbn7Ep+tT+JDGrNbHve9mlNaxrkJWd7C5nz5NdopXWM1PJWyE1tIrYS1fQAqjD5NHOwn8ly70n2mqR7hqu789zRVV+pZa6raLpZ2qL4jwYt9oj66Py/n8OlyXlcZcpMspNP7TkeuwXs5AmSaIk8PNFtx1RqqkJlkP/yJJLoyVNM/6CWVf9Fb2kuWXxy4+X7czV1FSP7Wt6db3uqNa3Irsn24qX6ZDGQt+NHQzlZPH/zvdcmvKfaaCHJhm0x+W28aQz/CIHseEuNRGWclUa5ZnhhiR68S3/utbrTWupnYmvP4HUlc01ktPl3Mh4Jn/wBt1+43v/7m9a1tH8O9nWSjsVkZ+uiw4tqU/wC0o9FVTPgrWjKqcceNTV1ytHTHfPjqUmYEeYaoVHlKPwJQtwxbBATmIvdQ9E+Bg3x7xl3QOsq18EkrJ9vA5bEQZexmhh/69vJWg6/EW4r+HcaYSHISTHmepKK3spHuwV5VGua/GxEVNVOYxc8lTUgvHLfKzTqtB5uVDhk3KTPi0mTmjLYsgf7GfPPkDqJ88taml3uJKwDNnZGJG1kM3vpZ4up7XeNrb76zda2nm/8A1vg0NYmYu/qTKuzQ0FBTpkE5O6u63v8Azc1SccCylFgaxjs8TtRrxW38b33a1/0x8hbU7dTugXe63RLNS6KH9H4PZ9fqCagWU26EuhpNeNPQ14dx1r8BK7t9l4mUbedGLSI90TFmfI1GpVPloitZPtGpKXWPH2HmKdIG/wBbOa5/BxQGSoE8jryaNcMwroqSta5AfEuukJ0yI5ZyK/T9MycnFdoEppCOTdef21oa85eh1QVTW2exQqNhqtk68aA3OlJoLI2/8s/WPHtpofUc85tOOy01ccY8Uy/ZqVqWWTY8mWk0T0VqWdoSP2J/BryoT11Xiq1Rq53A3WxA2mp0jZPL+siMeuk5nsv97VJkDTG3G0/sDxv/AH+YwS2FtdM3z1TPw7F+wnNTvXJIBvSm9BYFmkAPAIvtd2XNgFLJgDfHEKHx31MOsdiE1JX3olur4mOVqp6l3XO52+Yk7+yDU46i5no9RgI5BkmzwlUVp2U1S7pBd/XX4d8VvmPPRI65letzKU7TbU7k+2g/0P4eJVJI6IEJTo7nlGRJJ/qcIeWTW0RhE58tyYw7/sbjSzbvPg2zzeFF9RHRxxfRTPacfTbjOjJIk9HWON/72a1c6nJOPEROOdHco6JZUCC8njw1P/UDZXP6Elwwu4Veijq0qpU3CIHIMn1rSujQ+MrLSJUO14Ek+23wrb52id62gGtytJX5/DlWys3kbRbVfzzYfzxpUtVVVU9ffgOU0eKn+zpNmmpnrzv++1ccHOzZzrad/v6ouvHNbdh9dro0fiIrlFSu9Kf2Ypvwv9f6862+P+x5a/HSoGVnrqccfZCZusmuzVTqdSl3p3qa07dy0ERJ84Be4myv2AGk77DPa/8AOO2ip3LvxqyJ3vZAf/HL9E11WplPCT9ka5ryRIHP2nuuNsrL1YCuteOl0aSyplVWK/rvT3oxA8dVegH7OqH7G5BaNO/r+StbnRwGLngnInWtf68qipevqFTPjeufqXwQQ1AyN0njuCzfQ5vH5wp86sxaxsDGbnE3yE9S/vTWtbRbTe9n6V/HUG/3p2ZDaGzZ/jaRE34OYBF1ysrWx48c4po1MhOQ+xSVIVc/YUUZEBJnwU+KHSOSMdCTsKS3yEIM0s/r69Ept8n9ak/OSoDYAwC92O2SEVuDodvAM+Nj2tq7gtxunHcbtmVfqNs6jd63Nbbh1L/WdK7q1mqs3p8mAWFI6fALitZV0tLWvOpKG5Hz4ozRQz0xRWOR1S0g6rdNVp0S7DoKx29cVViDLMTsFrW7aq+nRQNc7Hf9v9kUrLt6yIAmEDfgq/Ym5A+bstMmd4HcCw2sla1ra02eqHHIbk4NzLK6Hl7VoedN1/8AOt+D89V9mu8Hp82RxtTWGbmtvWMQqZq55MYMPRtqd9yIUz5j6rFzmjigpqa7rlftZ0KTp6rhiRd/rfBo9F9vaj2v1OQBnzpYrrfPjmB1WPSr48OQOf77VX4WQDZIsKE7P+PTpT9kOY/km+tblqqyUX/YyfIkpjm9Vp3XS1VWLCAXySM6Up5Osk21O7x2VzIhfGirrs6o+wFaCtEJNfb8O83xzrc1V7n5eFZi01NX4NkldklV48a11+Kysk4u6PLI/wBz6631ksF67hLV1UlF+NrnKTHq7gFxebDZQTEapuCmmJkmDa20LszrV+t4pPk64iX45aNNHO9tz0xkrQTJKg8/YE1zmnFjlpHYAm6o2iKutM1NdbD6eA2LV71Vyv2nmzIadc9UczJ1T+6VHo5pEda6rTpmq9alIWqCfG5ZOgqaqmt1+pP3pDb+dVEUgwSdidwfZQHZyEYmouJ3AyAFY7FrstR6isYbGatQ+qBU5Eocl7+m0140a/8AxPKZ3e4PpUy+aTaST9Aoe3p0Mhr9UFc0y5Jxzlaeoq5k2NVM1yFa8bJ1R/8Atvmtb3HcLNS7BZ0Bqm0TaaO0+tnmvsSmkfxGqI2Q+na/AIsmHqSbw/5Zc9jg21UcZjreuWqnIbrlIE2TXAeNfU1rW1P9G0yb9ThPUkXViTkdrUXI0JL3RNQGze/Be0+35rfU3dByX9aINL9jyO3978aHUy6+5s6/LHt/qcuPLWG9MZRxzKVyLqJs8HGt0U63PLU8rUqIZG3FpQJtF+wb51mIKV8YlXCj8nAwZ6sqKcZMgYLaK0uk7sciBI+Loal3SLCVrt/+P6i4lJaqp/qaC7mtvmZQPIDSaaiQU/NhnMmKqnZWqZdf9DquSUZgmAeKg1LrR4qSh6nHPyzf1OzHle020eKP1yeD7c0u/Bp/SwFcEfUCIhx3Hd6fGywUiow88qDJguCp+rG4rt3RusYyIb0o+Ced9fo80bI551OsfLJkmrOkxu25Mkv18geO9fSg/FdTdR0LJBJ55npJCndCnkk0Ds0BU6/C19J1tYTRtNzIbel3XgCWf2Tyn1H8Yv2X5bDJsn7HQd4tPb5eDvyFrEx1trcfev7oFAHU/bd+XfMcz+kT9P4qGolJ1bk/qSFXMXokvWpmZ5mkrodn+tEvDsr9zr/IUv8AdkPG63VNb1oPtO9a/f4o8ZDW91N09OxPq88/VqStcmjfnXnb+IhohPc2n0ud5PaxxqRP72Fs/wCjYPfYe3qznx8stY601kPshBOoqdOnxGgOTkro86r1M3NJ8dh3zVfb/wDEf2nxAbeteOudnL+X/SpOeolWWn7H0okRcez+w1JMkhOxk19X8reotiqf1q9Cl2gu9+QdFDzTvVbanfX5BHyuywDEkJoFb9we+kWQIgQ/GS4nO+q50+EmGQBDSgTIdUKjv+0ybJ52WG73pAcUQWT5Hrp5opg4+TSO6/8AgP8A6nXQNUPkmhnenrRv6bf9Srv9rrRQeKHSSuw9N1hiSQ8eP6v68dU19XUp/c1qfCIaCmCEscf8d2PaLO+kD8wzL8n0+zzjJ1usVVOqY1HJAc6Kysklh0OtT/el1t2OtGx+fL6X056nVfLnw1GEsesePn7Z4GyiqoZx3p6Sm1nWqno8B6rIFWmLHjL9Tka6cXp489/aaDJWjHjkSatmRek/K/qvUHrs5MkxONjHinljHixRVRE0UP7lCtammamtWqwaafWvTGSw3AW91rfAKReLr5b2tv8ApqqydzlrzLAYpWSu7RlvzP8Aar3O2lfE9Lr83HosferysRGOTpuZ6u8dyRXN7+SUrz9pfPx89flDkyep4WeZmZOa4ibnci3t30UyIDQczzXn832PFBjiOhqZl32JROlmr8U1RtNPNwa3o6rOupOkLBfYiBE4fAaOgCQigFM2gw15zrn/AHvLe4x3NclsjLpp8u6nVJvod+DhlBSvzmZ6bmuUiK1ErtblnaN/qfOj6ivjarX5uPX5ZvKpo+lJvbIAc85P0JugfHOkG1F0+PWbL8VV9ugF2TU6J02/ZF0Ia68m5Tr8ul+mmZqLANi0f/wqN9p1l1KvmF5I5b5sO/FjbWwgjh6ijW9K+Tencjz9V3ygbFkCvJUzWb0HNa/YMSkmuFdI/VE0dJp1Rv8ALu/6+Wr0H61pOeCu2muj9nhrwOn812fJU5K5NFOqYGdXYCy9H1SUad/U5D68tvOxGHttEhFlyOxBX+Gk9ovtbwPBOquX5FGQa0SqUeK5TVCu0/7eNeFHa/iaYLmpK60Shw+XSNa8dNaTfW53o8H4ypnHQY6r7ipf7kOQodsvXkDXl8ppk/FztyPjwzS9bdvjyf8AVVNTqfBsnxW/zI1E4naVgBMXvKjXPBOJm7YjMkAZkRgW0SY8cclO7ZrqFXyHmqNVwp+ifHkfHj8Y1xixm/8AROyeqodfZdnX9Xfjbs1tF/B8VvVJ/s2aF1NTH2neh2qHJqpj7oh46IZngrzI9G5LNJrpDR526JNaHZX4G6SKz+fvjxM6sENAlKkVbOP+Lu8LedRb1v6u55Hnk3IDqnofI6TflNO38u4oKwNNE62zKlf6Dhf9b3vX/Y8i/T8T9cglf2h8P1CiT9b8qbTX+0/1NH4RvHhDvXeTYfvnU+KZ0G9o1s1z/rf5VLdoIvHgGDB3yedX0x6aiwwRxDX3MKwczqwcYyGED6HH7g3/AKanUsupEpXxs3uj8i0ydBr+zR/12SbvGdbWH9BOjxX6dP5EpOKZqh63BS/YKJ0Uv/1CeRj6jsCvyK6dahkmox1T151o6Uegf00P+2eH7H56tKW1igLQAsoQmlPGtOwuB3s+yuLADxqcU83/AKD9zFrpKZ8a1O3/AHH6/wDl8pKVU7o4We+CieXtmZ3VV5Y1vW2a/wCu/CIXRZzFInhF5eQlZjYtAkp/0U0n6QS+xLlEqZbWeb1zsos29FdVrbk/3R/ZpgKkO8IXEcFWHbVWi6WD+QvaPro2x4mYd1/i62hL1J02j0/9ep58+NKfmPVIIanGC6GclxpAa83XkdgCy7RHeFzs/cbgx7Aja6Z/svh/2gKjJr9/kwJJMaeZa6rdMug/9h5plDX/ANql/wBP4gWQLbslCAMf6gQtPPH6JDjJ5Gsm2n7BztjZrHJaBVWUqDuv3p15Yf7fjaGgEmImT66kluON6ilaGHUhzLrSfipwz8nYrLPdPhr7a701z1X/AMaHwoP2CckpnSbYsPNMtcE/Xa9UKbhAH7TRsFLYuXcYUG7U8FBmNLv5+gHJFxN/vlXu+5DuUmzyD5krrGvXL+h62f7P7H4wNVXAm/tRzIu+Wol87QQnXnRoN6/Ia6uby1ES/qeddWfHrc0lfbVKNboDWmvK3JO2QSd08d0b8u0BvRrya/T0UftlFd2imIDEw4F+fOlhvnj/ABEp2I3vfTPnryBqgMTdbJLWTqutzU6LG6Q8aDW9zkfMyh9AlJNSq6Kul8juhdn6k1Q/iseQqPk5kpCGWRofCvH9lp0FND5Rk0Uj8wVRkPs5eOw3/uA+1a3Jvc2AiO5l62wYuZtZFqDt5EhC8liwggBdgzaDLwffOnTe9NY+aEh8eGg8I2lTXnR9QOdCrr8y7rHM5cZA3RO6pSS739jYRyi63/8AKSz0fmEtTv7dY1mjrzUSjVfby6fq/UP0I+X8XkydUEoM7d88w1jnkk2NIu/2HnYJ/tOJAcBjFgzjcBby76SsxZDwUEbfT/cXb9TEd0Mym1JXTORubQP3p8a8VXjR+REVklrIBUJve52ySso7fsq9blrQL0NK/wCs7Pt5DVHYdE6ps5OSj668hvw7/Dm8gSy9/wBC+TXNLrqfBIgeaWnxr7G/yH8022iDAteOBJmxOixLS+sJRcKfrA0ytVtNNzKUrx8uLGjSLcrTWtr5+ruedqM/HdURXPlvfJLWq8S7aHILQJ/8s9bR/IdL4HXdVuqJNzy/FPn9U+PrIWFQeNfjdcPQS1Zs+ouMtlOmiDgqUd76KEXrf5Sl2/IwVw3/ANzmW2g/9cI383JL3D0zFe6b+N0nJ566quZb5onmGkmWRZfGzyINlfvx4MIEvn97yk1Wgp/7adrQAiOH1jlfHGzIJt1sZ7/aAa+g68z5Q/Eam4m5bmz9Iqszp1adZOivKLPhDTvdO4FyTYEgbLsrTYqbaLp27xgztfLMC8uZySs7v7CaQnmts/TqdtVtejrdnXWuh/GeozVcolam53yVDxzx48P18P2db19nQ/ipx44PpE9XfUpQ678T1U65gr/rUr5AV8rWqOVmetapJ8T43ORvoFrydPl1+kPEAIekxMqXa5Bzn3tcAK2+7iVzIOw4JapJuwJaSTyPjueAGt1W2vrR4aqYjR/s5OsjSO+ap3IErEFT9mm+teHxVfeOjVfgYzDW2KZZrqnclkqUzyCULz5QdCfUJ0Yu3qdJeu/G8h9YJSvs9Tt2J1+uRB/NcopnaAJHykmPeIe4LUJNlPtn3lZLaa0yiHwVxNHavMOjxWOe+hl3JyMzSczt5XBxkzJbdfVh2Pg3zF3Ch/8AHIeVp/qn5layTrj9Mx4CfsH+xWiUCadnk0/1UFj42XFj1OojJMyky/UWXp+yaOv9dA7lT8JBVxAe8jCnGbcacMRPAxA88q0CQ9M3NzN/J9e4POpT6yJR/wCyiPrIH7oeUNP4WPpa2fZaPtJ049TKnT5sQ1Wv/idDPVM4xzEwancxXPKH1P03r7Nb14NOgHwaVNzZR+pxzw2vLV6kf2rUmgfqprTrzq0iHeGBMxIfYvKWgY8b+82ze+oqHXiadZU80zfK71vjkjXmb+sjsEB/My1M496DdTMcxTtJrb4d9Sm6XToTz4/CyZL7iprWuJUq5jqnzTS12JIO6P8A58juR1U5emSti+ZV81Oph1M7CWpTzryqqfiF6oKsSTAZDkfmeJytxJeJA2n2guZA5GyfifMnVTRzLVPellY1SDJuJJAKmdJCKryC7onIY55/QT5icu3f6milko30zqVWXk1c4p88vXTPBtoJnpT61XboAp1P1QfwJob1Mk+UpqPo5ElHGdPVm6Z3/XzC65QABtYIbCPpf5YIAJkonTXiyz3KEDuEpOsyyYjsgvYTWt0MUlvKSc8M1rf6K/2lSHPdapre8Ehp6J1Phmk1OjwqdarYCn4FqW1V9OSaAqfM1X9Ya2TD/eup0Ftgm0o8X1fqoctBbTAKvxm0itklAHj7efL+GYgEqOwBKaN7jAa0AYvsBaFO/C+8knPU7ck6VMInmUZ5N1abNm+5OnXkaDZSrNGvtJ9l+rVzQNzNr3l+x9uRPJoEJmSyWkF8k5aKp5YHZ3x9ZC9IDqjmTmlXLNy15lNfMV9byP1+RdlPmaOj614qGZn7flkCwbXHBJ78gQsxpmUufobXt4P6nGTqswof2d3JsdT9Zped9bMegkG/1Qk58nGQyb+3LTtjStHjU0D40QSf/NAyhUdESoG15KJDTcEhaoGv26DbvfnW0z6fFW+vHNeenSA/1lT7eODretyzprT+KQhl5NuOVnIBhAxJk4K4tjD4b79rM1jyTX/ybZ6PjmpgnUO/K/pQ0s8y8szTEBT4fG3LutyEgf4+qSqGhAkkpKnZ4/B3jt+tcXsvmnkvmBdq1R40VjpNz9TzysVRNz3sU8JNeOqGYuqd8utr5anwjqPy7J7/AKK42nP2dCy/n87/AFvo/otb2eGvKm5SdEqVvS7jmcdB/rw05OPFJtnYvUXuaQdEFVrUzLruQfNbnx9agqirB6p6nHQ7ZmuOBqvFS1LIJ9qNeHZKY7Spm2ai0eq18uGeVnnZN8gf1Ty6PL0gK9Lva5jgntY7nNifz7fz76flmZI+8tBDTPlqI20VQi0mjXiaPqnj8LuMk9V/vIcuiTfj/JZttKrW3yfX/wC1trecs9O8cd7Wq8o8niKl5nlP0hvUiKX+OixmdSaIP9RPVQGhKN+PHh1VIb1TtXrZERtaCghki/8A27EaM+yCURtePFrS7k1zzyRfy9VJvolvnlL1IA7ABh2ALT+KCToPD8nxztN5SmQl3rWg1uTT5k1X4rnuo6t8Ba7SjHs6nxKTz48CG99Pk06p878PXx/131GPRIuS/wBCi1/pufH73+XcArKEC0fWBnyhp6lyX45n4wIxUgbpSN01Y7h/oUSbdQS6r8XF158HmyY3J3uQMe+kUEUo5prQ6SlmrxB/VqiWenx1QHBTXmq/R9DdUEnKFIX81zJPJfMniddHQVLVG25dAeNzsp/2OyTO4dvC8FB4MaSwzxvYc/dl7as46pq1BRqtM7ewiVxTuNo+CoBn/wCHy/lb7fItGz/J215/dE7xS0r4U8b8jta/UrU0lDrrkd61vk05Kd1GijYbp/8AjSfgzR0fb49Rx2aCv1INq1p2jQHSc62NfgQ+Fcwzwiz4b2RjT+vtE/VX30SzS+QCXcksdmp8py9PjWg/66Hc9s4vijshnqjennupdaJaJBKk8BW+k2j5zH5YNTEmL/ckF1CURW6aoZd/6750vhVmQiTHkyQuyZ8HLG2KHHRW5nZZXX9XrmXk/AUstUk77pM9i+djpeyFt8JfWe2h3TVbuf6XcCwmOFAidE6v/chs0s60/gVX1Hh88Y3mbmqV0Vz1+q5sp/aw0TyVuINt1S0paeZkkDTjVBDQKH1qz+2vH5PyT2bk38BDuGg6+nyNUnRrT2hXncf/AHU/yf1i4775kYiL5zb6NOBfRTquvtMhFZNVQh4LkikPqa61I7NzKWiThDJPn/6ig+yVTzATvnpldIAK/WdbUCqnoiOR4TvRMtP/AF35GqprqpAU0aTwS8R48j4Nf6lT9v1Unya0CeHe0ljgFC8XMHe0bcHfRLV17wpHbJ8LSsnNzEmUxnyYjrWmpmY/VUW2nUyBya+oz/1Kcu96igmXGJHxzTLIK/uFfKmnfionku8KOoOdclBWiSrjQddr/wDbE8LST+wfwpypVO9rbPnoJqgGtq6HjlrlaA/+F/GB8zckgCHCFpP53l0l6a9/5a/fY6yfmsr5N4//AOPW/jmedtfsVXs18iSAV5/HMkwE1M38O/B+zX2venu9Scsh0Fb1wfiWf0D4BqaUnqNTuGuWkeQ+uznZtTZHy0OzJXmeDZ3cv1DhKeYJpPsTJrrla3+WwBCxKDxvYG+BOTo+9/qIne+dnbVnFjJo5qN2Ncan641nZNUQKVIRJuf0/wC60E4mijlrm3Vb1WSJZA3W6SkAqT7NEh1q6RN5KE+8hV00VT0TErj/AE1y+D6wTo51v7/lnF18YTO9Bkj9i4wl46pK31qWSdh9V2z+FJBtEO72UJWU91pYY/KfH5+x1mbutMTsOIqpLmnRDPk6+pz96TXkfJI/kmPcvWOhhcaDrczH2Hr7O+ddaDwFE6mlk8nTvXyjl3/bmPJxPWt6A0E0mudnQficlzfjQM1B+tTVmpos6bGipP8Ao0bm9OrQ2YJBKhKy4J3Ge0rTx/Hi7txotzaa4HZKvIJLH0eqap8//A0eDxp/M8XUhqkxJ/8AUzSaPsrut7A/63onxUzX4yCZFyJdWKb+7H60DqNcUatV8eZPxEdLo+6fbodDj4k+KrftTpBAN7raKaFB8OUhGMDjk7nS2JH6+L++dtivdE8vxshSdNdzI72UKmuSZddyHSpNCmqWpNtRX911uJY0Pe6a+rKod0JTNT+Mao0zQxOOV6686d+EDIpoA8S0G/oba01kKpzBNU/FLP7/AOvG+3ZNa00gsnkLlEmPrH04n/8ASjRH8+x94Htq0zDOTuEd6N681s/t0bqSl4oJ/XP15aYs4y614nHGOmTU46r6780CJKOv9jrn9fgTVsDQmrMdUv2qtz/ZrbyVK96EECfrT+Mq+qnokfjZ2im54JuqvbpTooOuid+UoaFhAQWc+OZxHh7WIv8Az/fa70tyYipk3Sk7qMbP+TZzV3Zreq+2tIDX6lB8ZNSV9aYYxf1/reyh2gcjt6P/AKr7HhWJKNfaRI3sOZvaP234vI6nfJq9B1rx+EgMIdupcs6eK0U9VXWpt2Ts2b0S/bSgDfCgYFs5xP0xoxwo28H2sNG6JWpZ1XDVBVJ4NzGtcis9a1rXg00gBQcp/WFdyFOzVbr/ALA8mv30SP6UascMOgKqJ3TNUYyTZ+knGc7leknep/8AhTLV10omQjHOuYnHNEkbpNS9fqUmmUrXW/wqKWxA+o7ciFxOpav9P4f4QNMjJeU1WQnT4GeWuQm7+wuTqtHLrrzF6dV+B8nWSseUchLRORORk3Onre5rp86GrCKCxVmYicePbqnkZ1UzQupqr1/87mvIZArRrek3ZVzMR9+eaoP0Vpfs0bqkZK15dGlBpCFgxG7Tt/BwNMY7TnYfRj76djpps15P/meRnmAKXdPmfrz5pnk1Up+B09XZpqsju+Na2lT5dzzNG1mdbTw+VGKvJtV0/Q58C8TPNUvVb0SVtXUxrYv5GPRZImtvPZ1wMxqe6SXS6Ncg/Y1+mml3W1+xM+/tOgbeNgLb2Ow8aO8SnMzT9vlEyFDJv6dGh2aCZ8eUNPmV/JJHRUgEYx1Oylhl2b/W9dU+Q8bl6clHpq2Q8JbNKHx7GVOca7/oDVPL5GqyfjiK7GdutUSppgYg2eZdJ435PPnX5J8gJ5C9guUTfIym5lcfxz3UDfRuX4yVZpJmNTKHSDNdnjf9ur/2y7HfiIuctVeSSkaxhvzB1Kkjyak2DvYpspOVEXb2XC0UTpl3LMz46rXgC/tM7ENCjP47/JS0uPhZvlYSce2WStFNH7fLD3Sruj8PqMBLjMwT9lFna1trfz+QYTavo/tE1MxdaQpJdM0rVdvjoCV8bV1vJovYvFRf0rkCgMZxXVTdzkEB8bHmtW9IZJDX+hHNU0ybDZUjO9lHmRNeF3r8WWV55XeY0jtY1P1dz0a/ek/0FaQr8mLeCOYkYBxtjjSL57i+Mb3kW1Yyo4lI+s81qCts46ma+m9zHOhpo5RUDnYZMkxtrXkJxzrfPSOOmjcyB9elqpJrnqQfyXJjnVUzBwSriU2oGh3usm9ar9i7/W/yJtqZ/wAYbnkjieouQub00o+Siq8fs50GwB2vEXCuRFux+r0wylx5gc3/ANI6C91UpYBj3RT/AI6eimZJJmujenorY/8AzOpnvW+Hf1j6fXev63r98nkOqNVvek8h/l5kandXjQH+sUv+O7Z4x8oISPkf2v4Y5DSyKTx+kRmki2lO+ifrWlUP2lDBuPdYxyeIuFfSP3XkxwU45CjfVmeb+vUyKV0MhR9dFVvfda1s0vn9LOi7JybDRMfE3rf2qtFfZNxZOukN6Gf99Jw4yutUBvrtob2TLxXI+HZs0Mnk+tDLGV2bDJDpm1m6xzOvDW2lSdbZXbNH/aca6WEr4IE25PgBLCvoQz4g8YEwdogbk6cA2EZPirva0mtIf4v1w81QzjFDpKT9flvHWRTxjyzLx9ayQNP9VF87DW5dVXJ5/bTkjclaQD7ScS5DcyNVUtCn20+WWXp1+NObGmWK76rdeNalqapOpF/6z/rmfGyjkrAJMcXhxaP4WESdAiTDNrp/mowNW8LS6dFTcnWgdhM8dUhUihE61ValSh/LcYpltrLdmlxxWmXG6Hka1VFv1QIlGp20hWgMtf4Tu5Vr9j8ck9mrmqrUan/rtgmiEK/LWG8d8ybE0dVv/qz1iXIdO6+viSan6+GZp5iERJOMG3pYtJUwbWequfwggGIlgUkx+6++q/q8FVIk7Zro3fNal8nLyhUsvP8Ap2jJrXXekyf/AKMvT9ZxxCvVv0lSnGvhC5B3p11rmxNN6ji/TVn4+2MjuSXjLMw7UFvaB1SjI12pJdWvTVP/ANK6vGX8d/FCWr8ZBNXNYxSpn7Bv9iDsPxEk0wmoHcC+4DLxbbTSVkb3jL2z5d40EW5SutTzFFKTJVyLVayK7KyL4Dqxx/2nf4rJVJqRBwV9uTrJ50aGim10lfUqTQbd/gzZlphEdzIBwVrUJkaV3VeP1JWmddO1Oapx5N0GkqTwkzlvwPYDyTOzUteaQ8a/F6PmUEkfWHZMxgz2WqBldgL/APb2/kOAtVnun7Rhs5GHqtLl8X15+6BSNqM2TFPit62jm4yfe2jT0sc20ql651oZnTVPJ/8AGvy36q7Kxs08sk09JJPWpGt1KVEgruh2+eiTX5s0DOOA6s0NyEx/TndUE734Enw7Dyy/nSAKQAiLIW2NpfdE851mbwQbRkW3dvH21NMRj1Nm7o3Up9Fo46b/ALTKeOZ2D9Q/FzOLWo0dvRY/9kJJb0CKmyZNO5EX8C6qqmNhs5a5Sb+x9nag1/pJlV55Ompd9YvQHiR/6gIhp68s14mf/qnx43OlSiWjBAu1+EkUs/WI/wASdSXARkzNgFzvsjxnS88RGSFSr427H9+NUtPn5H6yc7plBnw1Sx5Lw5TJAldydJvwo+I8HH1fL+k8iD+Xc/xA76rI/Hqq3uWjQN1X/r/bslqteNy+KOSa2XsfEz9XbR/pmndNAadfr/QqIzSAYvYrsMylxJeZJkrtYHhAWz5WI53Hq8v/AJExlNGiROZZlAXVT21p5qnrZ0L2Uv5rPVbvDhWWTHevoEH2BXyiFUf6dX5Em2Vt+kiL79NR/YvJjOvp1OM5OdyJY8868v6YPsoyY28WWOaHGlaK0PGipd+fFIPIFaiX7C/kmSXDA+wN0FycJq2mZZWAvoZE238Tql/uSkCedronwk81X7vo0eNiAP25obddh46NzO+ddUCDVPll8HW9oeTU0/lcMb4S02s71+vAT9vvytaOYDezZv8AGNzNYyY6NTK1O5nzPNLVbeURSdaCZRd/k0tGCys/+L4EEiyLhPS5MtT7cww7rwyNH38bkPFFMAhT8c5QkG619J0jr/e6B1oXVncae15k5EfCM9X9X7Iyn126dbHTLdzX9FaOVgd7RlrVB4R5DyiEy6RTqKr7MX47NycVDWvidyCp5ZJDag9eWKzU6QLXI9ryUhHZaDZTy7YwXaxyQdtXcGV+fHVylNTM6dVvqT701P0KEl1Ia345D8R6xus+beLT18ewamBVK+9fcftrIaV071vZRU1nnfK+fPg6aqVlF2CAbZ8ksq/VQ9XUbl3/AGdOu5k6ROkQqXybOnyPPgWiAQYiBKtt9TY7lPUH8PbeyYhyMsw9Vz7Y6eoOWWdh1dHM0f7HrcmzQojys07LBZjnXPTyz5ir/wDtjtraNbmfB3onTM1VUJnfGOD7GtEySLG+Tb/br/QeL0TIeE6H2bDLeT1eWesHoscZLipMnyZJ2enxUn3rdsteP6yj0/iEA7gJXx/i52/j0Uh1AOYJRCsLHsRnHfWwyk+j9JPpqvj1PqcR6j1HQjGMH4PS1LqaQ1kuBCqWTVT41HyLd2ztUwkk1GwZJspZ3OylUrbV6nc0/jPU5s2TJV5K7rOv311x8j1sp1MxMmiXYRS+d+MxjkuZnYSzFLBu2bA8Pa9NM0oPhGT9uaUkS8Q7AJSAt7IdtbnEHZvgebb5HbWyxQ4QaoO4nc6+TINdLSs9eK1T06kboSEXY5L/APG9uWqgcgaVq7nqP145Z0G6H/dNTIFBUxOOszhcbvGj34Y6ECRsaMfTWmYOgJ5HHN/ifePUmLCY9mqZJlkTHviiqeDVHnn91pqyftSYEE1JgmJtJWIZ/m2j3kebYeV9i9c3nt6vl77d+Z+0fITWlOBZevpP+0Q8h+UcGT7gc+NxVEnQ7n719k56T7eK0g/jc9reSaktGjrlPNOt/bU6Q8aNmnR0VtEY/wDJjy0zUSbZ14uhP2zJ9dfqj6/tBOj86DTIz6SgjADH1UbxB1lUHVG67TSDiNhBtq5mK5/TKcPQq2p463O5F526OgOj9P5QztzM281sk3PJ5UCuv34p07POpNf/ABa9SpyuSF3OgG5iP+vNary6Tnep2ocq/msyaqh6dd/tF5h2ErSmq2m4nf7/AE86dRIHNptidiQeB4A1NcUreFAk3/iwnGoK62m/07/rL14fL+6GtozI1+tSm2DmRXfllnzu5KDQqJyIP66153vX5DLqp6kQ6i96akmDilVrb4/10FC9fb8GNTSv6da/fQ7nW6o0An1TzekOaNuYj2lPb87k27iNY58IeQAvtDQG4TLV3QldU5IofC6d6nrQ/s0Ccoup34l85MjExVBJ4rmSC0ZHb5qnWzveqfq61RSGSd9WM9d6GvATug0OtB5CNP7UXY2SK/VCdb0jOt8sxWx62GteP60G9TX4E2eYy0QMp/w406SQS4eOAaTcYQieMjVyvSwfHQ6KZs86+Ol2lUSc/qVrayu9prk/+9E61OPX20zvkNzLS/bz5DbqpNoKr/yMiCzslJ8y6HnXYdeP97fD+9mxfyzOE+KbuzvLJz9p+scn3q9Nzsld6/0rrX5VP/b7LYDgiXLCPB10CfwBCJIvA8bJA421XXJ+x6Hksa6IXnac6mU0+aAdlf1q9NMoHhTczj7pOujkVpXqdqdo1tAf3oMc9bdkzX3mfkQUJ+gpqp3rweNPAjv8G4x0uxn92MoBPjUbre5X9ck/XwT+q/PUVVKIF0ZNvw7hv2QxvWWnZjb6Srh2BsNNy1CzFGupCuBnVJwNU6GbF2mlRdURIhjx4g+8vjJqERGf+stXrUqf2mdKBrclCqR586NnkXX2PrHbv6pvxOtc+Tr7fjseQYk5NwEeTbOz9rXhkrU715XnxWkYRMhkWHsO/HBgRogmwtY9wCVvCxO4sbHcs1ZP0m12nTO9R0/tXXkJ8TyUVr8zswg/9jmQJXW/E1VISlMu9T9tG5/f5E9z4sKrzjmvG9UAbuk3GxDUG/Gksr8HLdSFOulmXqfPTrnJVOj9iFaF0fVHX4zv4ftG09773NWlfmrO5X1iCoemPHjo8LNzXcoiH08oEulJPPhP26ALbGjTPyQdH1hUCe62q9HmjW0B6/E2zXicOXRZ9rvz5NsaCzja7oZn/wCp/W/woqCKJ+l9knegxv1NJs6xy6mfp5d7kXf5LLQWW7z+o5/Qpso9935IAkO3006ovdMvcfIK/snrWtqImtrJLKedzvf5WvJfU451F+SrVk0JLTTtqqZQ0aV5873+MkzHQPRNKK1og8iohU7+mwmP19hLmRSje2SsgVNaKrG9bn7TOpxiP/1W96+3jSL7SJaQi3cSP10LZsp49nlfZX1OLI3oZ2PM6AiO+TS97du6Jo00zRqtdJNeEnUBNVlquRthmeZ7KqjYh4FDX+vycLziP6qodsFUNTLulS6o0G9eRAfCo5LKJOUfrj2ahaK19/K8v2Gv+yar6jtj5QGAeI8blWBQLjOgCzHsTxBmfqENTV3RCBMSx0iyu/Pys1VXQgSnR0r0O/I30pU60hjrmeRU32K6mTSVk/0utOvyIHo0dUrU9JqN8sBen69ITj8b/wBvSEm5Ps3Uj5QKiWjplFXUmPs0nM+NaH9/ivkyeYSjCFxncrQkbfxWFkpA82c5EdNE7Pt09Vp5jlqDqfsD4Cdefr+/H5M/emORItGtcxsT6M0qFVToJFdYj7Sqvp1/br95dnho3Lw5N9Pje+TWty68P5lmyesiqRQEyYw0Sz26fsID5b50O2dAIFqRjsShJuH7iBgjSHH5X+XuB9SFGBptNW9MPi2epXa0eapQfjN+KCfAV4YH8zh5h3r6wtC6Z39qq+da8/6+tg6TxTGxzHkTjHU1W0nTjPNU/ffKn11VbmaOXbYtI2fvzO6nwbRkWvHJpkDakeJ8bQIg2veN6WPPGLzGiCrIfcrHL3ImdtBkmTjV63xDztnjmGSrFf8Aqyj+j/X+xJMR98cP+S2WewNVO50y75GReijW3bJ4O1jRTN9UEUarazNSVk0T4d/XWv2z9/2MhNNtC1Lkk1rQ+eSqKgma3zQBvoD9T+FWIGNgrAgIIngQonLNwis8Qh/oCCdAaPFKz8wTXhA1uS73W4B+2h5//a6sGscCgdVLF+Kn7n0B0DEv70KbSQdz+V5ijrVAM1fkNA6ZmTJ9SygZSQ0bNbZ/GSN/99+Si6/RLr6ao/dOzUky+X61zopaawhaxA3zGFY76YaZk7i38zCep+0bcZORrV0BsGkp1U8kzJO2XxqpteCtGSzM1Rroxu6J38irKWaCdiAm+UTe9gY7i6vmqgmaKmqZadFVooXiXxMvHk4STT+SrMzy/Jvk27oma1w9ryO+tn9WnZOnX5dJjeysS2O8oJ/qtLa/aONzdA+H5fvLkNZA8ef0kt8niut1VV/p155NSUr+EY4/3sGu52gM7N490HgXxJt88nlQQuhs3Q2I1oZd/Uq965P60SM7NTorX4ysk1NfL56o5qfNw+IJpdbP7oz9uZ2PRpsBzcg54XHtleU0z/McwBPd+AsMlZH6473+muufCcg9+eeq10B4OUHz+R18e2tJ4ncyPipTynnTwl0mwNs1/sVtyRzTBONoR10y6Cr+xkfAaNR4Retv5mRIbuvJkjFFDA1NVTqv9zMfV/8Amw3p/e1iDNkIC45hyWecgjxtixd2zz+5ZC80FarmjVK9WE8klCf2NaATXEIgqirMeKTGg0TVTktp2T9zzqY3NlLvZPP9odl8hJOudEknEANHIfb9eD63XjXmnz1teOqp+0eQcZ/t60eN3r5HXQoNKya3+2xALBFPIBkWgkMB4NhsdAun/ItuLvM6m1llonyRE0Tqe9FTTkVf30U68oPhH8xWdLq+uOqcfOsts/frYcutTWl/r9fA/mLV46vr41SfJvVSKEy9ax1YGxV8j9ukCKZmR+68V07pl6mKKqtdsV4ZA8OjmjpSsGQ5hi0WEg342jQgeXN1a1pWe/jTqpq+X6s7mXWsdMagKa2dU19KPNbTU1t/MxZK+Ik/fZNW7GRgKevLU6+vTOifEn7Rnk8GsnevjoCq+wczVGjU6oZ14EZ3b5Tjn4lko/tMiyvBXLPSz5mNOv1vyx9dfjkSYd7PDWd7QAWJjRMFX7iYteIZA1Z13LjoXG31DW/8ZUfXy0bxtjKSBSEAUV+Ds1qrDT8g/wBZamuXc9CtPFH6KPqhXn8GmpGbN0WTFIadk87ql+ss/VAE+qCKrqqmqXzvKHScjv8A3SnmN8/1nRrT5/KVoyAbySrWalbJ0wJfbj3jt7fVaZ9bclZca6aida+tEyDxVV8nUFPX186/+yT5gya4MemtEEE1PH6JyUla6ga3Rvl/ZUm3KWK6/ua5615LpDrvc+KkU270P7diGHJZPyUxPX0nfyADM6a151SO3S2SSnjX4AIgSSb2JgBgA2ItmAHGlL9/yiw/gei1iw/eJ5MxpdmjJf6tqdETVCa0oSHmQPyb1RJ8gaIpo1k+0vjd6dNGzaecZM0hJpdWyOwyy0DWt1j6dy9b5NIs6lJ1NT5+lTj6VqZLJ7FoK0unl0pPB4fHJT9fDWnVgC0LZPw7wiJBE2AN5+nuPPjaFpsk1HOYqarIJ5DUs9SohXxKrdxJ1e5/tDVZczMElAzwBO/M6QqqF8ulqtTLE/1Q2ljubgvcSoY2MmvkfMi+Rdi/R639XWufKXLI0oMtobml8qY0v6jMp9deBjR56lXqFIEbSciOX9Ae407h7o/yZlvHdQ24x66k5r639UqWUPpo+yutorNH+tSILjm8v1sm2S0FFkHaeKV8QVP634TRv8CLuY6yss/+orRTzre50zzw728zWvPm1/CK+TmxrHWMZmVVE86Q3W1R8qJNzQy+GnYKbALh8PCXjCFvpt+iY9tPm/hfqlFX5kWiWidapqeZ0UGjxr7G/DkZOywKKlShQqgJ7gEf/t/10c+P7HlOjfWS+lmqnnjU+Dmd1pH9h++bVP8A4/MboDUgfWbmIJVrR3vtrRJy/wC0014VbaWBCzHyzbjGwgW0dl/P4v8AS06q2+NQzWNgAnthIE89eFA8EvmK1uWoFaqc0821VlG+EnRxu9qWjRynU7Eigr8i0rNjx6Dgaqg4Lk4OQ50lcutc9eY+1QfmbqFMZVQ1uxWdNc6B60+Rns+p4nS1X5WLFdxwcg34b20R9l+v5vfR/LO5MfJuZkKkBoZB3XRo3O1kd6lH63Sx52fv/L/bhGV8Tumf6b7P0+BNGnUc1WWqmeYiankeB+xuyJH9HIV0gzy/U/HQUY5PH+qGoetvEm2v+0Jt3t5deaNfiRq7C30eb7SQb9hP6WiI/nY9zrI2QBkne+5p07hnzBVTrkXmccgVp8ieF915d9nTA1Kp+uX5K0fVXzrcr/Uv8Gi+qh1W8nRkldE67OrP0DtqZJ1/+Pe8qUyfawrXyv8AUOQ3x0mldH11/wDVLa6CZ7WCPHbmUJnvof54iP5bjTch8n/X7TtU5JyAnW3bVdr+zXyamdb00vHSYswHLWWMPS3ZEkzvb4+pU9Ph/wDigYexJm/PX/zkFWfrPPWIpGjVTyckz5qXVIjA5pfCWLJp2NakO/D9KX7P9elH7UflClkhcHFwAUYwWF409LXm62KmXQ6Cu3+u7Qmp8V9tak/Wkr8OiSsbY1bA0KUd9dA/6IpEJPupo8fg5HMv3xSa/wARXnbdSPd1etg/9gNSmjsVFUjFCjVfGNJ9pyC893X/AMnhIg5TwBW/wAncPO628S32jRpxTl71FRfNt9Oqp5kQ20vl5mTzbJD9p6/JGpDUnjWNslOqPt8j9hT/AFd8u9af9tZjpyXp1sL2eTqtQhuvvT+g1rsOa5QfxdZGMsd71Z5a3zFUSmxpKlToNdb6Z8yflwgeQ/8A8BfAXv40FLz+ixvz407fEleKGZnYNXuvOpZAOdeN+ZHrmuaPxOMx21UYpdlFupLivFMrOpjnf/3Whd9AEDF1EirkGpDX2qTw49ZNQSjLXOpDdMmnw3Hk85LedZa1FfWpnuZ/SAc6OaWfNaTe9Kj2hIGYUyMhP3vpXmcPvftgc5zrMD1n6vk+OXqa265qeSe0VJCI0lbF0/VXt+nAWufLY1DM1KzsF6cn2P6miudC8/ir4mE2FVMws+Ou+Qq6f1pEU8psQ/aevkiZ0STM/bQTfJthVW2ty+A+TfnTqkpgIAQiIBmNsC/AI8g/SIKI/mdPOckzc/1Y/q1YiJVbjSzqf6bf1ofqeFVIWZayUSzs3pCygn5GiHpJK8FUU+aOtAq7Cb0EyVMDjlkeUg19v3OjX16ZfrWqY7uQr6szNlakGTWpt3X2eutfpXT5kr8uCh2feJj7Hu9xPwnPY87Nbe+ix5d6Zr7c60yRzomuwrc7VP1yteK0O/xMz13o0dfL1uZanU/4/wCyCLP1JHzR+6AjHU6yOOanMKok/wD1JzMmt0FJ4Qp89akH8VPBIsU1VTZW4p6+pxk/STL+zinRt/YSitgM/UcGZOeyOn9P5bP8zp+Sd/Gx5dRFTCkyfVCqF2fW/rWyNht8UCXQjzyeMSI0NSbKaXwKP2rXg1J+1hrnxWqnn6oNBFaZidaBk2j/APEu/Jz+Kx52hq8eq2QP72hMEtXtf9/5JP8AWjzG0Y8m3AgqRBe50X9uYBwMj3xnT4uopbH5CiNktfol29H6GHV6dafrs8zjpMbQz905ry1J4qe6U+gzQfsrVM+D8iFyXllY6TXTuuJrn+tP7kOidaeoQRD8GcjQjo+NJjUzI3Op8lea7aQ+unlKCjao54Fs5yX7TvdWxc/w8fyzOiK+Pc2GQcnxxkK/6+BinQafJoOje9dCfjZupPOv7kfI/bU7CVT6fH9HjRrf9Z1PhNmatf7N8p92Y61p2idf6aJ2+NeVARIZ5dVojpl021/emnS2jrwu4/1oaAD4BWUUo/QgjeZ05B7Yibfxhe06t1kjHtErHbz1xLWJo1BVSoShTPjfJs3+BnvePflJ+MNANaR22C6Z/wB78HPVJ/VUk8o3vqthb1rHOvIpPk1rUCh4OaT8riVkMVKaXXVa+vXJG6DTda58BW2U70gcBX8rHa2IsdL2nZ/cXxsvGrUvUUk19Lma6SmTX6nve5ldiBz+k/f5WyTQDUprJJVbDrn9r0CmvDW58Trncr+MjLfxMBxLfHSJSMmtrAfH4CVN+NDv8KrrgNzFfHrrlV/poq/001vT4KD99J+EEB3h2vHix5/LRfwjNv0PYO19sftFmiGWkVkmzHE7jy9X+9hOpqfDWwUI66r4jqKpbhlqSUl6xNHg8ErQBdeRGq/MErHR9Z4kVHmaf27KWgsrSbGk5dal/MxP+XGprtvUdUeXlk2zomq/seOXZvxOyINrAFYP8LAGxwNERD5J4xEzN0I20eQayFEVzEHg1ByXJLqR6GQkU8H/ANo3+Zzjk8xpq5uRqWZa55iro3Iu6/8AkZ860fi5y87dfYokpl/x08s/Z0MiVJz/APCc7+n5Ko0zRct7Gyt4+tfHTWglnmipNSJuRXa2EEHIYvATSX0aOdj+Y48/p9NGEVl+7/SNz46m3pgKaesl/wDXwyKI8uhk8hSXsr4v78i0aSRVBeteEFqeWpH8Eupp1PTVa6Qecu5SuxDiUdgMieJdP5O8mv11dM3NaHTdE6q/6HmXnQ72m12/kp9srtT34QG0HQCDz27fqoD0yf8A11qUOmXaDJWt6qt/SKEEDzudb/KsB82SllZa31NBsYNSeCxORf8A57X/AEB3VT9AHb9cjW1MjIF0zrrXXOp6q50aX8GbokYngNQ2/VaeVrdOgft1bA/WQk8/iqUQ0h5ggfwxoNn9lxj8zAviGXLjj/GCdQuwo5Wd01JrxyUa+xsdapgabjhkmp+OAdbBtNVV9bjSeGhvyeAdNaWce5gomr5Or1zsmp3RuKNxsg1/9V/vaS9b8VFbq21FSfjaiuZeZ60BzM63vWihC/gCbKF73/x2m2if54fH2tbTMtMaKnQzysxI9ePL0n18Pk0vPJ5j8ClQSeQxlFP/AH5DzW9Oq8IB95OfGtpK5NPO13Ur9v6n1ndjVS6/QG6E/tqvyI67dCcmv67QNPnf9p/etmvHPj/YaWcW4GyCUOoI8QVoIGbHC7T4s7Ltp3pj43+8lZJboU4mfC45EgrSLOt/qp0T4/DrKZZLGeS8cIf4+l8K+GiU5Cv19aE0TpGog3S+DsftvnkGFJdz5fM/UP8AXj8fGTHqCNT9YnU42cZTv46WjxO+qDXUu9PjX5z1QgDG3snjwuc6Hg9u8A/rGrUS/wD1UtU/J5/YE75m662leOdMumtD4MDHGSameA81Qzy1ScR0k727vRtn+s14mZAqtpNt/Zvew+h5qS3nVDIcySL0a81pkV5rUb1Vc7BfEhBPVeYPPOp21zAC1rmqEyU7FdrXYCaFSWBbRfGBnILjjN/A1f8AQ5yc2NqdSXxY7nvqGMpSPR/Z31ooiu9IS2M2/SZLw9T1NshMmp3WjJ0Js5ge5+6z4PCGs6ZCgnJdkq8130Wb6/QScoWft8je382NZn1ODD6jKE5KDHTQO6majuXVUalm9v2PNLTqjmqAE/wwNo+pNu+nSLYSjyBfjfRHqce5j5GqZ++iSb2gVVtMhkMhsqQejG6SNbL0+YPb48zvRAE8hss+TqtBjds9UNamgjqK1z+XJOEgnkWYOgW2lqi8lTrUzR+mTSEE+Jv83WDJz6DDHyRTUfauSlLOiqyXryVuJf7Cj5WvyDSrMsi5VjlxIPa2qDhMNqf5P821FBdQLP1DK6AnIgyDWn5KoI3zoZ+vOwSn6nJvFkoo5JDe+9D8bMmxZIFXbonaHG95OUOuPkUNhqutrNTBk0jGv0CGos8B1+VlqcF9WVWT9VOrEvljH+p8CUJzqXXKKT+MU1AoKULSAAO83gDd7aHFhZ2DNgUT5xCutUsjNXTuY3U5N076fG5Zofv+xA0owI61Quu5Wf3tutHHYAUSa6vb/wBjVWHk+s1+PyW9ZG6KJKiBA48xqcfmarb+kKev0FrqpWRiW39eJ6J+8vM87r69EkeXe0P9g76E7gfKIye4Vs2A8GNQf0scFHfjvB1M8BVNzJvw2bo8Y9HnSztBY+prQPk/MeEjua28MUP9tsaKVLoX/uBqZ1X6mlHaDPHiCXzr73Pjbs8FdVIkwWjPIm/xmOqdnG9fSdy1R4nX/wBthJ+yhyOtbn8QUACPHCjn8u2khyLfYJX4B3S0y65qpT7t/wDx4VqCZavwjQch+yOQE8623d3XLkrda3WySnQxrVHncyhof9b/AC/nujE10XV0fdG6DxSl1Q8hFEj5oV/s+atFPKA6iXYb7etc3vztPDv+yMunYshxsgx4m6fjII0ikWv9EKNgWLcgTovT1WL1AyP34S+3UTTIrrcnPAbk/VPjXQ26mqrNCFp3XU3/APJNaq0nvx+tAOw8OtUKqmp3raRKhMhI6Z6/VDtN/aXTv7O2001Q1YhAeR0k7nkfPybdf/G9UKqH5OJhGTkW/OxAMRpR2sYsDELxt4jVGMjSAa5Dp1oZnkXytcnmB0LrzqgV7J0XG5pKLf8AGDvTqUBRRkNbdMCuq/E48gfoJYSe/j8C6DbW187lSVrxL+lcSq0L1y766ArHo8db+zvRIEy//sdJMTgvBFxGdnY4J0rQSdwstG/8mcabPJPRjF2Ov3t8SULZflPrX+n6w7NopqIn6R9pd0f9Tn/58si6jRM+KNj+QH+P9b8zJr/t4jU7dulE3oF8bP7OXdxZHx/qZJpfH6/7VX10o8obrmf6+dkKV6SB5CGwmxF89tTh7j8xYziPd8lT5ldhuN2SQviNNP8Ab9zQvQOgD67R9TdK/XQMTrW/6h5CqdSE0T42H0Dx+RgcmSa3O6hfNf2/UfXqtfp3rQb1z4p/I9Vk+Gusk9G+t63W1OWlfMhL58Vo2BzW5ICJGV+WXGSOFMy1hN554UPyd4nS91udx0cymrVdIs34aF/1w7+v/wBpTp/Uc+i9Lh9FjqXJ8Z6n1AONe6lmcZ9RpjGhM7EtdJ4fzV+04/k9XWfIR8Hop+aisaRvf1xz1XA9+eT/AOory+QPPl+bLV0l1S3O2QTtrhJ1rrY/F/8Aa4HSfkQSQjGSh2KBPtx21dIFIBNIZCdNpuT3z41laK8DLTxDb34vxFPZP+ProL8r40dGm76XJUZponugrE6msfmkQcjW90G299Cb11yfmvMmW2Xth8Y9HWxrwXVpQnRoWRmRWdpq6b3jjnHSs4qYP7dfu2u9GTxWjxSAhsdIDbDKGRF8GPuO+jMWFl48EJfpnW69E3ZWWqnoqqJs3fnlpl6GgUINu3Uk/r80XuPq8mfNc1KElU6CToakvV73kp2nLSKS/YdbX12XF6bABTzRIMxQpMVvsnwu5TJ9jXK7deeUyVWWy8h9eaZR8L41Vrqtr5a3O/qeNU/mVFAJ9SMKMD8I2UYztIBFVlBWO+yW0ifYnSsizLRPlJa/7X4VKkp8eC9+HeiU3oMwhJNVRBU6HZTbT4mlRHbJRp8KbLX8XmsMkf1XQeTx451t0eXSeFp0v6VMiHItGty9ArP1lGsZ1vZV14J51t8da/NASLFyNuHaY3ffnEfil4TvIH0BRuLo2hue/imcXUtOkR6fsTrtEl8ys7NJLzryuv8AM7A+zT9kn+zpFa5KkfAeOtkn/wA/lnJVOljnlryq6X9M9PiKEkE/f63U/lQovbp2bdrp2ar9KfVfrO/CGpDndKooiyhWSPpT8w1fnSrqZRB2CcP0+5B44BJQGPjnzKoIhP6vcs1SHOqA1Ov9SIogiOjejkk0HmjSeXbR5o6DpRPD9vzK0om99Cu3yPM8u0pPCedDrR5+34Pfx0eF/wCgAeHc81V1rxsTZp+njwfkxceHwkMC2/Zb5G4BhYntIyxYBwnk6lKu+5qSSKbit6kOdklaEXW3wyleNftkZOQIOoaOfqHmg2CVpD/4FHYwanSud1dyH+tbFBSZOFXb/sH90ujdP5lSSbK5KR50nM+E3b+pl/To/QTpd/kvnkDiAKTnDHZaUuAmvT/3WH5OSRZat9PMXOleF/VOz9VdeQ1qRNeV3vyfl70fqLunHUrPLLQ6vwBMbf8A5p5nmB6+vitJqtk60hLIaGgnetbf0ii/r7aeUPxxRIfYnw7oHwM+KaNIqfs/aa/1WmDOFD/Oe2BO7etqKyKhup5EQM5i3u9O+xjjHvvo0s0qFAO8n+j9mmf0iary5PxyMSm48m+WodSzu52AeP1M9eda2LmUd46l+yhrdMz5dhwGw1Jy6aV/XRxE6xt1tPloDr+32/XmuZ+Pcp+tHj/Ya9VI3sgAcBD9hJF4cPWxWyAtsPrHsewLDiOhr/2SeddVPXMG7dHJrQSNeHkXe8Q5mgHzMKBJTOhXbs0klOtU+f2UgrVITPJrV0u91LOgKHSr4ZnSpIHh/I+S5CZePExep0b2f/O2pNfek2/1ND+WVyMdwVJsDxAP0bi48HwPE4gBx3ZPfL1O6nIQfZrkNHlrzWPfS2B+yXyd/i4vuvja+O+3dvkQY+m026VCSCdeQl+1HViwbLfE6g8VTzz8lKS709db+4eE3+KXmumZKqeU4Jgqk8tCa2idC7mf2wGkb2hjYO23t9EdDgcpY2sIjfI2WpwzvMzRW+6vdrrXj6vWiopfroNoz4oX8KskVSb0a2khJWT+vkXfLvnxyVRUmvCRVscdSNVBiaJvc2pqm18+RadrID/rzDKMTNh4iuze3VfqqZVXbtDdBqfIUIIA7Mt//ENmbzBP1I0Lxl7W7Znn6aOqmCDcRWSSBtmttb2qgP18Nasqp1LNT+T1yVpGWuDQ3xuRl72aB6dynOt686/KzWCv/ZLQsk76/wAajBPVaQHoQgo8f1T8tyyJ5Nskads/bQfagjneiEnZrcfZfwc4QssWhJYnwxoFo4YETiPN8jWTXWQy/HTpMe68HXRXZISAcslTtlP06RC6at8EpkiSdEtUeF8n2+zMjoP/AKsNSjVmAfr/AE4SZ/SpMv8Arz/unZXPkFfK3Jsnk8mNqrJoN76BbWm6T7pP1N7TmuW47/i3Tpc2s7xEZ02oJ5+oHgW59tFxikTTDT2Cm9qSTbWvqU7KNm5R3s/K9T/krX++aK2kwhBx15axloak30MqIgyWzHTYxp+PqvKeJ66b2sSjt8VpDWyn8LrbIJ9MSdM/2p8OqrRb4rbomqKDXPSgASPFQxdb99svnRBW0fVJ/wA/LWcvRRX3T5HdeGf9498hRX1ZiQFb+23f4RsdMqdcSk72V5kelGdm5TRrQaXzlcfUbQ2Wo01zo+rRLraeZ3OjyIIiPmxSrO6hqeaQfjrkJx9tp9dU0TtNGkf0iQLnfPIKXn24Okbh7+8iO9j42asFcyOtP9HZtOnQtVJqSpSVNgeJ+p+ZWWonrR/1nokvqn7Tk3vn+w9X4Pqmt71E260gAONsCuuhC+lX9/uyX9Hgd/k7mEqqm6rk1z0/Kavp6ZJnprwaR2Dsfyx387WM/suOXf8AmCny+35aw+uKJ3L94OmfD0iXT4luaE/Rs3IaPxfyMbNeTIwNQ7StaKf1WMdvg3vrU/v8mmtCT8s0yFzoZm2f/lkAoTnnz1KftfwBaJmdRWt3kpN1xZTxuXunZq55H+ut6WSRCLKGCoFPP1fLvpcDbm67qcF4OSdNetfosPE3Ot68aKryBPOmeQDWne9zNXNtR9utVpGuKpJUfrMsa8hsVOf2n4JcrAPigi03MDNTztXyNiLr99SPnZl0VkxnjRKEhqN7mSUql5plSZ3+uf3p/KFsz9TF1PKHjfTg/R45x3idBkKnzIzp4bPqb06WedcPj7KKeNIeWRNY8empvxBtlUb19i3RxNfoBZFUN+IXvRP+K5rnyf3rrWpXrf25OGenlK14/CS4go819ZpqVOmv7lVU6DyLrR9jl27YABJDUDi427Qb2Fo0/sd8W4f030V1yH6/rEtGtM2i01pPOlUnekTT/ULq6ZeSceoiTV0C/wDfTT9fq/c+/XjX7/Md/JX6SgRqR11wHnfOit8h9VSZ0v4GFp1P2ajqBSVU5nQU6sHekXz9aCpNj+ZNM3HEAQ1eBaBpeP0j+MLbA0xyfG0/uKyapqXZ1JuRnx8abKY2G9kbKPyJvBW+ZJkrnzI0V44PG5NP9PHjSGv3+Zu5k+WZb65n9HSAj1TMj+2KJ8+DRe9Dhe7vcTalF/V3NhjGlWStm0rQ9eHn9fliarAkiyNoGeLSQCL6fb6wV/r6xo6amlnzuVrZSC72juZmZ5/vIn7146/BV1PWTTwVudTCnhB/t2mp8u0OGyq2M7lqtu0mo3xpZA8/bWxr7L5UKnTU7RoK01RoxlTRqTuapMWqN8pXmJk3U6aF/EUDvLHb5dr7kMsSwZIp+8LZZv7xrIvjHHZq+SNkc6HlKtd73t3QNLLLInkLJamRWoR7P0TIUbV56VGmD7G5dOkO1nixlKmCq1/XypZdu2wOW9P2Tre9klzhNzAS1UGgNUzAFs0SgbFdcnmROvxoqYRAwlEBuxvvAPC2CCVsYH8xorZ3rNCWWTKJ5lCdPZtxpW+g8gNf5JKojo2H23bW0650mjHd6GthI/aXc6Ctx+BR8jFFc2zO1oOsaNJK7dzo5mv7OhR8zGw5NhqfiU3B2oT1VaUQ+3Hldj5Px5Z4H29LwV5VsaHx/IjPOw51PRkGoNzvnJtB+2lSXvfKsuR0TvlkPJDYa3PIwIM9d/oKmjZVNaoX762u3Vfgt1Mn+XlecXnwY2g3/kB72SS7Kd7An9AzGPvjfPD8kVW5uTfOuzfctIyA9edarWwBsbSbL1DsQyOI0Y5/hED9dNqYvZSo81VbHrWmoPrsKV0TOjaCUb/ImqxyTXD0hixnC8oGNa1NDNCbqfAyB3QfkTact1JVeMfJ4gQYfkF10i6FU/0P6ypgmR3dnxdMvS+fPyr/AK148adHmGjZSaIpLIz4Tkv0r/IRsY0/4f54/LWdUtSxTvKC0Bp0KbfCVr/GEiVr6y7/ADO4c32HVFFUk8zdUTrfgrGqaDy11J9pr8m3HQTDujmevPHOgO1fuKjb42Swo6fwDgQ+tJJFfU0O556p0pVBtDazo0xv8RFml8pu5gFyDvcvCOlngR328Y/0NNy1v/FOz6eLAmXkqZNqj0eP6hX9VlHae8kktztGZ8TtCtJfbQG3rTR0mup3v8dRk1zuAutGbf2BK35450M1pk+xXWxERgjHzyz5lKU6/X/2Rf8A4a0AHcP6SV/AgsG24OGkB/uNH7flbZ99rzqJojJcP9qOprR9oplFU57K1uYNeEmlNr8Ob/J0aJ446ZSbfqvLKrdS/wB08BQGgELl53OqeTfMl8tOyprwRdMsgOykOeaT8jH9XU/5NoQ8yVPR9Za/qoj9NUq9S90P5QBCUqHfukZ+vN9PI4+/Z/Q340UrlS9yY5p+lBLV6j7Jpoj68+L0M6PIhk3973HjziLvaSfWWkpdz5ZNGw8Bso/AnJz9N+G6wuRl3IoAvnc6Hbry6AN1Qzy6o00HxbIPImy6qkPvrW/3SCGz8q2LXaP/ABf6LH2Xfj8j4/mdHkyP11qvETrHANCzPbkPH72ZF8P+zzW1Tq8lxUolO6rzAb5ZWv7S1/VJkXcXzR5GyRx1CmSWfP2GtumKyLJzSDrSaGanXn8sY7p+1BfgiklWHwlfJT1XLvdUqMjtrbTBafEEDhTeYlJRedMXXtbi+/8AHzP1cmM3NV8ZQeOaJI0u99PX7Nfb9bXX4eTPknzPPO5EJ5JqtHySd8gedVXgdgO0UZ5r5Mb8hRlmdIUGNnIaPqbnx4ZNqq+Zr8HJcf44lhycnNOqGJ4vvpGaqp/0BvnwGzRZicWM+L2chkZC0WHDX228X3jUvWO1hrVbftSadf7dstFSf6f/AKnx5/GGTJQavSnc+IOR19If/qteJjzoda8ztS1cb50PMvJrXgu6ZfMmt7p8g7RTyM48YLU0DU2JM7IdSY05BHR9Z2G/D5k/AEervKMZB+l9rpC67JQlH2/ha5022mpfGyIdQfHFBXlV11SaHyDK7/W/wLecn2nrsJehmcbZLM/Jv9bmkNK6pAdJkjWOX5OftsnquySZWemZ5NT9ZnkZdKn2Jx5JpvGm/wDJou5qgfPI1QtT/ZnU9F6nxRtdyHANtsRz3zKFtPRYi6OrqepZuRdrMyNnVnNTs1Mjut/ekXUZcv6qAo6+OriKSlWzIkV4qCjqtFaXQwCtqtM4yv8AGzFGtEzsCYq368P20TKa2E7/ABHxhVP/AFZqoNtTMo/35NfT/qaR3tJ+3L4T5zjg3g3atI0NgJ7/APE48hfpbTd/1SXkfipgD98033tSq1W6oVfNC+PyK/eRgNdzvx18fRO90Fc8a3rXje/BSfkYnJvd5DfDQ6HUkzzE1o3fRt8ef7D1ehkiVXPlyTWRHadOijSyOqNxxJ5WTSugBjK7RPbB7wRwtAmJwzM8g3zuftodRyvAzV73oamtTrqhZOXbOjYauUnwzjIMlFS9F76+jD5CSmjVS72Mzp8/UoH8bh2008BDQFypX3lDGO5aN/udcuw2mjB+12olaxn11o8T0r0kukry/wDxo1+MARFzaGEtjwAOw50fz89Sdsv11qNV2+KQ0IWW155JrkPHFa03+RGEmZgsvmTMKqsk7qKqv3zrngmZ11vw7/JyZjETZ9mCJOYa7b1oa2CutXtOpNDqn8zHdSDTPVHhDZDkk1JaEcj2BMtTqklrdfj+UVIl1D//ABgPsSi4HbR+n6c6VVTbjAmdVG2liMoSfXW3Ysu9oeNIBuji4/yT/wDa8bKnmnkMfa+RqfGhHmt6fr+Dl2faK+3MOyJ5JASn9/fxyb53+qZHcjNaxS5GW1jI1wHVUar5ClYJrc0I/wCtmyH8EWR7IPAsZ3yHOkyAByBuzHckcHbTJ+895Yu2r5EdQUTPn+sVv+28iJrVI1sFdBllkBstN6uZ+39FqNcibiQXrqBHejaZJqa3qQrbXi3yG5qZ4Nf7KA6DUqyuxP8ALddNkB41M1euDFX0OWp3sV1Y8m9pUIgOz+kTG/7HTP7+I7+1/wAjnJ4VF8GJOVfOtM9VonY7OjyIFI7wJYHsKGMkNcaYCZ48zLS/7NHSedeH8L5ONdYtUEy+PFaQ3trY2rq9C60HZ+TWL+vSbeaJ6fr5H4k/v+7OpNvRyOueUKX7s7CyLLtwLY2X83KxL9uMaictdeBkUxCbmmjcm26X42a0eJ2aR1JscmSkP9QMTqTndEv3r/bOzTRpeduzwx+6ujUyBjdm6qzganpOuvEtGl1y8rsLE4dnS5UiVfqy1JH1ydrvWmrUfD5XRoFwCUGLnCsOYjfksaI7fxcP2x21i2PNFXFZAdL0L501sHWqP1re2dV1uKurD6/pmB5DczslopqmOjlTRxP+tdMVdsFZOd+CJ2fX6ibaOnS/ZqegoPFbfzItlEBdc75pSjW6vYmteFRXX9dIo2T7XLm3+3Gj8/2A+iziBpl3deaxTmDJJqS5Q6gL6/7AT/ajQ89KzQq0bdhH7rbwLUs9QaHcrrXNaZnnb5/CchDqq66ogqD7R8gJ0zyfvaQefAT9tibJ8U0fo5k/69xPPXVV5qq2cJ9aBEKORqH+5x9GVmOI0+J3ueP5zzqB+QZqNVjDo2xVchO3bVBqjz9Xxw6Sa/CkrkedtAS66v7/ANJ6a3NzUv7nRP8AU2eVYVqsnVMM/Y8stUEGqqq3aNf2P/ZoxPk/Gvx7iMnaUl/J31w75Yq6ZlKV1yP9dyzkgKAY4vO0cbfY20Qn/LXelzM/JQ+UDL1vitH9p8AUbJDUg/afDzqK0eYJXhqpJ3yq11F7l+xEzvaA80J+SfJbV1RICQVs6mCTlU6rr7WskzXJHLRVfkm4/sHmp5rl3PWue3/4lH6smj/q9AygPJ9/vdfdX0fn/P2m1tYNM7rneXlidy1O9ErXh6HfSjQVCaaNlJW7Gftqp6rTNMht5ZdrWydEG/qaZVjh+T6ZNlY2mW/CltTM6nRLoNTpftzr/Q5auQJk+0AVz5K0ppUNbkKa3qTmprevyjssDuwsc5suNLG+1pD+vBjFsH52KdlT5+ukq9aWnUszw8/VdGj7DsK5ZI+z1JQwjVcppu9amOl+x/r/AOpo0jLXOPrV1Ug1r6vWmVrfIxR9ng/+X/an1cTNcC9cfJNeRuih/bvHOk8xycmxRWXYXB8bA7sjvYTpA7G9/p2K7jD21Gn7zubH/LKO6jERYQ3QTNTrxJKgqa07GbJ8nKTP7Uacewle9qsyk8+B5607WaQP300k3NFUeXTUoBIO42G5HWmdEqftUrSTOOScfnlehJp2XklGWqdmnTyWP5JITTlAxxskdinGmbp/yHaP2mNNGZwnP6vn/rzZVcA3TJoE5Knz4qZ58/mFTj3RNaupGvOjLdSg2SfTX+grzNL9f3JzIF1Fb5kqY64iyXH07CURAJ2G9S1ukqyRoepr9SrJpyLuLqn67Va2hY7eZXkHbjEbC07QLvvOgT4ychb5/Pax1n2hdaTqg6CiFZ1fSzLOpQkNbl8b2CseXG5QVdSz+glepAurRo2k0/8AapQNyK4p4jeqqfCySrc87lda3orTzp/XO+vxFCf5APvU1zMnWrk8KmvpyPnZPnTt/JLgFJSIcAApx99t9KR9vrTv+52OrELeiZdkvXQaZCfB8m+jYhonZ1DrkpLnk0c1NPZo2y89A3PJqUfGp5PuGhXI6JKTmo5iU0b3IdNKrvbunVVXM7duwj/G0lLGWzQlMzsDajyXOnyHk2m62OVcAsYCXcIIDz+mny+3lWUcuw7auYUqO801/bfln97mmdUNfHVL9tu3Zp/3M5MeWueECnWTYS8chL0upNfatGpCUnRX4MmpA1UyPx8yKzJ9Ka26RHdM8+Q0LX5mmacuLd3bPU8zzUZP/nSUMIFLPje2qBK56h9JIKmBPtxbvI4HP7ec3XfVgyTXSdKRfQniT9hVUb0PgJkUnX111Vn09uMvHL3tLjl8xNTyfcA6KZPj1JS7mdmlG+OKLJanzLMmqrX3+qSmtSKuzmNMfVV4Mh4UtN1+idsHLQs8uvHD4daOkPzAggE3yLMH5QInnn2OmChAHEoLxOysO603Pb0nH/7taDzfXii68TSyDUzuXRo1QbuK+L02Imjv48e9JW/3RSkMTj+uyWHQ+Y0snO5GlkFxos/IgNUV4jdL42hvjabjRX2dsZKwelHf9IDV9XS66mikhnHNTTL4nxtHfLkQpsWPs+7syUB9NUyA/oCYs9o9pttqe+JnzKZMnZZ9frQc1WTZI46lA5o8CDylU81RplGiabglCkhkIqq535ENH/yeEH8z5+ccLI1RP1qN1OR040VNT/ZmV2adAafyt6jMy7+t1cNKxtx5Xdp1rGaln+ov9XWv3+WpBRhODg095vZxbSZ2VvEAwQIzt21ScuP5fO6rX0yQrM7IJxrX726Wp80gIoCirihfPXnG7NDQSAtA7rfinneudT4pZE6glvpobmtt1vivqXyePE7JNKtftEXa/HK/6qU5jprwm6XqlB3X7eZGnqR/LD2KX0Pp+3OdThqSbey8/mPOh2vGp1yT+9+dSJV1+6k8lOg1P22DRbwm8nyOqWVSpZNyC806FP8Aqn9vO3VK1oSaq6TzrGVy6mnQHVbE8O9eXboH9WZ/7TW1x1/cCS5mZOaoqet6A0A614oH8ACZx2Kn0yVz7A30rfszDD7n+b6Tn/wkfH9fkJL6/wCtPJNUpyiTuZJ+pSeDY0bpqZKlSKISdA6070/7/W6NOwNLv8t+oqtTVRsrk6NLzr+323Xc8uxJ2bfKL+U8sYmRt0fXl/tTfnW+08WqO9+R1upNSYJ2cGx/xFyC5H+SH5TVxETuPw2w0owudHf2knohZiCtb8LOt1ryc6dyfafA/wCyxM1JElckzB0ikm53dVW/3fX2Af0edb/KemX99zRJvSyTXmTf6ATlAR2eNuvy1jyDrx5J+Ld6RrmdK1v9+ZXX78A8qF8qpAsO3CNsXm61I5iO0QWPL4F7A6rZKceXk1XbuGcc7nrnVNBM672H++zx/YPwCwLN/bs1Whop1qd6BJ5prnpnQHlUj1EF5eqvrkVmlK2r9R0jLo6JNdBp2iDJwTJVBbI/XbPWtd0/1JZQAEPAHG/xSFa30+UCID88baUEmbWfaBsL9vtp2PwVOi90A/tnp3L2jrXKaISTyG02vfe9yi5DT1re0OduvqU+KCXejRX2/HzeL773+qNu+V5nxPS9BWiXlDXnmyVpZXxPf1jqZK/fZ9R6aRRdnjzTMqfr8KrA4gdmk4j7WxGi+HAFxx4tE/eNWYqq21Eh9wnZBVEkbulWyjfL4XkKCj8nLHclQeGdbui+XehUPqH6FPMIzPhBcc0U0csbdqA70M9OqIF0ArX9PC7/ACx6XEeozzHQQ0unrmYmhrqtJyLorWvFBJTtk/hcCO+RZAW+lkANAE2goSWZAWykPBIzbW3lr0nt0Tyub1Hm6kYTqWY+R0Ov7U+PtrtQEdXqIqtg3vr9/wC8rs+yaY3vlna+SV1ovev9RVWAzkx44YiOfpDO+UR1Ahsd7npnSHP5q2ySV07Jm3mVV5+zW+dAvj98S+PDTFIKJUXkXPyoS5H5dzqyUhOLXuJn9FgO2tjF6JZkUJixl+tv6u7a1vQhX7k10Pgb/psU5c84iuKvKU0/6C53jqkZ7GnQCb75ZXo1+Oe7xRPjZM3fRU1JUbeq/wC7TUlc6qnk8rrbY8pgnN6iCZUrHhip0df2ak8J9ZZnddf9ErX1K7KRUSBBOwO37OCrCqLw4UsgQRE7HsONUPd/V1k9RWGZPjxEYJDZ+tz8pLXgrS9aa2vB0K6+gwwAzzzJWpapfq9bSfr1qXxo14nXj8Zgx16v1GTPSEz3XNGu6mt0vRXeuhdVve4FU/A9XczNd7oExk8jsXWOpB2OyjoHaiG9rNAFIqBkCX9uyCtwNQZbRCIA3aIjeR4COta5FfG07JqtO5poT6roJRPOkEEHp/LMuOJsYTd0bnbTl5J18nianb40bNCmz8rYyMy+am+lvo56k0PkprzWpk19vGNe0tu5GMeKR108wMzaroS1rwO5SqoN62zY+WH3JI5/T8za+ppdw/TYAkHIIIhqRcFM6o1d2Pc8c6B0U7Anp62oqnQHXg52b/Kk11NLt1rf7nonkoXysvg3M+Q0s7lLObRX0a1UrR0ApR0dS6ep0cE6dJ+01UZnejxKz5PH2dJDT5PJJqRPsj5T8ivb1bNG9kIi7ja86zqbydybFLA4jLxbQmwRir8wST5o6NzKPkBPJzI/68i/k9aJNg+JRkplHXSvnXivu+UNarS/hBTeyQ4NIb2s6/b4qp2+Nkhryu9qj5Rq6emr6Xwyb8hu9IQmvB5dSGtn5KAAJyuZteCL3FxfSJkcxHi/4Y2myQ3aSU6rWvFDo1Xidzdb2igT/tRl5NKRqqOJ/WNfKaoEJ5mn7+Tew3+p+tHVChNFBVTkE0p4aJP7ShxSa1o35JCtJD1UvG4cf9VUU+vUj+qFTWmZo3NC/b8lSEJBO0g0hPJ4GfOpNQOx8bel4GxG500q/jGTz4F1O2tn2d9VodmwnYho5Vh6jC6ZafqtA1InlOtCGk2Gl3414ZmStf8AbxsR0Jskna7R1o86/Rv/ALfk9/udI8stbNPIa31+5V/YG/BqaN/mnMuBFzb6332JgaobtBFOw/Db7XiHrYMYTzwLYJzYzFPP0U4CehZNdH7l5/AqeWU3upibOTZO+dlV+z68zpN/73+/wvjychPe6Xbrqj/1+Gjo5H+0kQOqZ4d6wm2YfuUaeuXf/TW7fs6/T/XoSaJQX1WIhNFO9gmANr2tl66r4v6TztwYV/PeH46AKx9SSyyopP6lp23VFBQaEGV2ClLjmjSSKIa2+akApE81rnf1DwP/AMryTX1J755OtYr52c/9hUqoDfh2bOdafw8U1wlRc/6gZroPohuteDetEu+upd6/EKgasFMueM3m4tJLGluLXz2y3MlxmMannGj1i3u/960064lcg71VPLo/WpCp6/EmOi7mFqSl6Z0pCf4t3+9iTPAaZrWt6/HfHkaNze+hk1XiPBrz5fCb1otk61ofxumSa5eU4GZftWzXVJ9tNadV3/oEBWxxfhlR27hHadH/AOVZ2IT/ANFd4NTpNbjUhxrQ+djNytfoor76F0zz1O3Orax0O0JHUPOOq1Xcu9IapaP/ALf1Bfyzkx5RhmHnUzVTifB9H7U+Ed80p0mjk+1A8VHL8dpRrzFVpal3r6k73uT9yng5E/EWUGhF+CLZ2fgDTO2M+4edm+FpFzAbK1XXy9wTTVTIoho+P+vlfJ/q3WmzQ44Ni5bPIF2QnmaqvGp2DuUko1/r8OPT0aWLaZQbm6dfXUy6kKDl+u9LudDyR8dTUZOa5JT7S8yuiQNEn1o1+3+2hl1+AV4LUMceou0LgixYBGkCBMTgG1h2gcD21Nvg53H1N12PXDLqW99Vbs70dHg0n4ircKOPyczNST9CaR++qDvxTT/rZ44E/LUGSDTjqn+pTF3ypAfbQnPnxrm/LMlGgbw5F5ZyfYXdY6SWnzLueQ1W50P7SN7pA4cNC84Qzf8ATC0yYefA2tOO5Bs90GUqjFCSWBV8BM9cJLX2GqWgYHdbk1+MtmZnfI0TOmdBLoLXet7HyeXW+U/Rz6euBJZnhkox+e54UaTV7qzr/tYcmmT8yMdZCYuchez7VC0HMcl9HVaaKEI3/rSfgCY5srCAEA/ry9AdjDsiIEQMv6aFkbaguitTcvWlUdjuZlADwLO9gg7D4pNs6iT/AC6SAP8As4/Ag75JlDUvhIqRdmaGYia0gVkcdsn9Xre9bry9fU1s19V/ABJzPNzNTIOqNVVY+kDQaGRJ2gLO1PxOng3N5CDh+wT7aPcrLIlPwI7CwylyJl2O97vo1/UqfpPTp2gDOy1da8fjGVoYsbQ62b5Hyn7Tc0SgcvW53quvwM05LoJEiedvFA65PtR4r/Q+Zmib8bT8gjLJLDeOVKjWyWHXR0T+vsB5R8mzZpubA8NOwJUGFvfg6XH0tAVpG1yXFloudzcWV9Wj5P6TfEByy+Qp27kFpo0ZPLjjmsUspIQcBQPO0cbW+qSWTlAUJra9fkxjvJ4cVwxXU1qx5CTyp1SOt/17gCksnUVNBLzZFqwaSWqCUVPIqGv0Gw1QKwaRMLeLD0vFKOH/AL02L+L3tJzsPvE6xanHFXDtkjZA6HXNqpSfWuqQ2/8A2z8CLavxyMRXTRLd5B11LVeU/RZqR1NJ9WnjRE9Q9k6dzVMTqdU7euxfDqRQDyI1j09U9k1LWTYcpuK1TNaCt/b+o8p1AilyEzSkTUttguD/ADtpE/hAkkC8H/FZmy3206eQ8lPWWKmzRvrmSK6do/eRlNsr9nn8O8nG+/q9OM8bE3udKJrZvpDwJooFXRepoiiZJ0/G/cAGaX+2mvJuSpkHlJuWEVoLitUS9VN1ypM+adIG6da/1sOt0UMAXOLYtCJ+z3vp7oHlRdXU+YG9tBzDRvfmilESTqZYraDO9ykDs3P6R/J+tPyYwdZCchPE0P6UNbkqefNvijyEkoVRdI8UTEjFOOtVU0brv7Nb6Twz2H2535xK52mQ78zqKnoSdNL5dXz1/up1CtH42AMEn9mUSc4XtGgOYsV3MShbh/QaG5HcDy6mv+qkH9J6V+1c/VJ2n/YTr8CTp666+mqNAchH/wA/elR1S/f7Y8h5mpMmyIxzFNvIvxqg8H2dbdDQ7k6nchP7TrHUMpNjUg/Swdspt0qom6U7Nmv6qwbJKHNvwjF+SQtE+1/KKuiBkrtM6HHfV7lnU49NaiHJUuPXJe+ufqM8ipxT9t/mZYlre99cZJ/W4Sq/tW6COqNifXrY6pZOcNMRZNAJ9SGTgmAKQare5Deln6vmR/IiEqrqbmWPjkSvr+qD9SGh+mhY1VfZvQ2B6dyQpXyi4BMpRJsTiNNnjviw+gxk9tDlxwaeq+Q1mlK3WhRxzLHifOpdM+Hf7mgMRQ1TkO8h0L5JTjida0X/AKdT5PHW1G18d1rWPIEhurKrtONyieD7f5J3AmgCtojiyiib80M0zRxP02a55ZaZOTZWk2bPxuliyUSL7ye4CEPS5hK7gY8/T6nWT9AnYtaVPGnJLOnIhPEuwA6NmvK/k1LUcFA8S9f6Zl2S1W+qpDlk1Q0LtH8z7VdyFm+mbqXVDwzIoDIopIa8kV2b/CMeSJl+O6+gDUWo/XXL4Q8gS/o3UmnUgIOQluC8EQTaZY8305/n8/mx1GSRN/JM/qp1/VmQJkKaraa8yBU6OunoHGWG/L9vFPm4mg5ppA42LyGtbnn/AOIrBlIge6yZGd1UrwfX67ZBNu6OZK1XLG5n8ZHch1FKE41rFSlhOuk8N7fD4ejwb/SCJwheRhEiSnZoHvoF+3LTXt/oPWD8Z8bUL1KXyVPNSa7vwaKHmedPnxvf4NpjGuipbPOuqjeqF14ABoNeTdSJ2fjQydM8UtqwVjpZXjn7wSSybNQa73UeV0q3JFO4qy6N1WOnSssimpK2rPPgo7ikamaYAEg7GSLAK+BDHJOmf5t/PMZ0u6p1UL4qYADVj93sjew8fvXBve4Flk42nquS3WUoAjxr/HtN1un9h9369Ns1+TimsbW8dre5nqKSSuWRNToNv6NzWyVl5G81s3NyiPiaCcazqHz+jZ4nxRuNHivxghAtyGAj82N8287aV/5aQxn89nqLqoOpobtNAFMVf6DpmdTRrk/dUTt2n5Ug8jG9Ms06dl0qLWmagf39U1NH6H8t5seSsZIX9pNamvIc6HqUre0pNdSaUoH8jHjrHMrLrkl6innbPnqkdu+h1PSb50+QgkiwAA34aHiTwxokxiD9sDsC/odDhjnHA/fnmut/vxP+N87TrRrgPs7JNV+TUTPXP+T7FvLq8coNRSCofUJJHaJ4TU/HfydvfiewSuftcvHg/Sa2G9JSdQmorDk6H7fdLDVSVFP2NE+D+viV5VkQSpYJFIAuIuJ2wThrxtoFoGwZjfMrsdtHE9XIAsGv1x3pnTPf9qp0FGtPjzX2/F/EbqEtDNrrxvQ64tG/Aa2yyz3NefNfmc3srVwf6Qon4wnW7N/vcjy6Z2aNTX4cxePyRXN10FSsyvKUDz/9udeVPI+dD2gd4KAQHFxLwedD3jz2/h/MaOuk2ynLOPxp6ZZZsrdOvDt1Ow/RvbIqQ3E6jJMF45HdCbu/3VilfZJXRLLQ/hRFkyONpamQsr6yk6Svr5kK0aCvNSh9ZZJbaZIpfsFM1KdcMzYIGu/NwLTtlWVbBmV2uCYy9zjOTpj+QI7z9tJulfEvhY+OJ07pPvAtc+TUOnX6o3y/lacUyuRiqvJpa6ViqZJjs5ANPjSutw6OW5eO7nfGSXU7r47lq/H7fPl7F/q3P1dOlWzfxlMVIEDuKFuWXTs/015TVUbCZt3QUTNrC1+XtO4RibpBu6HCFj7/AM20qsOSvkV0MVUv7Pj+s8TT4VCaLJejeq6BG/BNY5k+iayw9uwNsxr/AOXU+APt1K7X8Oby6qeL6TRTNvM1xrew6ry75k78uvqqt+fGFSVp/wB1NvPROq2ATpSDX/yp4pBOlgicGVxLkr6KeH4f8v4v41MqTekC54Kd73qZmnulClTabUJnwLQhySDK/H/afAqivaJVbf2HV6l2advx4cqRWTqln6z5nR9NULP2Qr9u3W3ekCHuKND9j6tTTz1x46OQDqpNbHW/01+Ngpm6yoYcCB7tXkHSnbbmOdvy0vq554jqUmSylmXxRk2PNV/ZqhDxOxFAcesej7OxqXf77o5mn+jq/oTra7Dz1pgfFMkzVQUBsqmO+NPkJdP6HQOqH8jm+Sgqab3Wik5qoahkNILtIJmzclTT1NREh2WwQtE2Hg+AA5K8bRuOL5vnUTbBpPMVyUzt61P6p0OPc68HgGf9V+M3DpyPbqSWSfE7gIX9zqg6qTZ5/Zr8G1WTHj+uiXIRVSVuK/t5+6VX3Sf7c8t/ghkMk1zXJ48w6lqpQDRMuteD9fZFKQk1ABMQReQLYJ4/K+h85QDHD8j9tPimCdRt0T4N+P2V0qUGttBsk8fpXLquDSFUzjaAd9HTdX/TZplrXj9f9U/FZavETfx3YMzYTayVRqufrGyXW2o3TtGNrNOSEuoaEJ8zaT1UszOySPFaQ2iWx0eHRwisWi62f+9zo4sg1sD7YGLcganF9c1aHWqoVP8AT4Ja8eaPpqf/AJxgUPTejHMbZ+2TY1O3GV5hpQAmij/4fugr+BE5csSsXFxUmR4sdVM+KWV27dqy2Nf1rz+T8eS51xkHvotm1mZ5SUodiVt1Mjr9zc+UCAID/wCJzCPkx3Ghx6pl7TAMI3Wgyw/rH56sqtK7xv2VyTudfX67Dje3cqi7+PEyuH7Uc1oND0cm0kMbpRNupXzybL/JBvV/5NzNJkWWidTs5OAdaDz5TUoBRjyXIM1NTuWqh35k521L0i//ABPR4lE/G6FsSjj3v+wSCvoj/dt+2HHOs3U4scRsHRly72E0T/8AbBmdVDqdyagne38gccvPk+svhHUmmdu68L19wHQh53+OMV1M0CHHHyfHW2ip/Try7R6Aa/8AqB1utMWXb8dk0JLcVSNspImua1RP1WRGpHfIEiPHlARjY/TYaRKymFhYQGATMvu40zo8Mv3LLKKmuo+iQLumvton9JRPijf4V5DNBHXx1jo1YMwo8pX26orx/vX1Ip61VCenyfTcZN2lR+/E1MjjTQI7BmQKR5qdjJMUXNVFcpUbYoe1nX28UH9Qa6sPKL4F6kDZGJOftjnRMW/l8wvOhjbRMGyqBonX9WQX/TIbKsnbo272fjjGltxQKLeP6M89Cc640r8YHhnrW2NQhUVFY7Jp5kmnmufNR4t2b6lPsp5Ns/pAv50/Vyb8BNzJKn1rYoT0akeX/JPXVSyhUBEfTYT/ALJbYidDQ3wDi3k7u9idBnKnLVy7Op3SOhUHcjwgRrY663/80By4peyPNHNHg10jO7lnmt+TfWwnQwB+TU3Y6nUrDNVFJUnHUtpXW1KaZejau38H4rCWYuS6KlSkJefOueeRdkk0IaGdithsJE4W+N7i6vplzZL8jz2yM21ll1oKJX79cwBP+5K0lDoIPBT5db/JclmKZp+XVY+ORqonWyW11qddJrfKcm5lrGMk2SRRVI98tJKxqFdfU/7DyJ0b0+CIYZeK+0BKy1L5naSEE7a8ItBv/ro/EwTGbzNp7820g/ffBELHNkO41M44N9Xto7LOQySh9Wx2leCfH2P3ro5zcYwa1Jok/aG9cT0+DaeEk+s+AZRXU3jmddK1G1GuZSfG0OTYdSTqtPkKfzJiriippWiSmaUHRHl/0bTRM9aGEqHYCCgAGBeDtH2sAMdj1K/3FrYy+w5jU1kZ3xYOurnIElKg1NBLujUtfXXnYm+hh+9saH70rM62fomWtWleITRsZUX8Km+epElnmsnLXW+f3RW/+32djQM6n+wZFHFcVvk1MTU+TnW68rXnx/8AV6Zrf1UBBN7mBB+xe/0gaGjKTye2/wBlt31kNRvo2V9ZrnzBkfrFVREhHNFEz9R2ft/AqflsVFxwItammWdT5d0pp2aL0GxJ3GSMksXk7Z5kQjmBpnS/r7I/WqX7bftOtG4qJjY9DKIUpCY9Sv8AbZsAdDPUefCIllQLQ5NvAeYJOANSxZZS7ILgRN2AdCxy7jVdAeRplo8efAxFS61t1XgftseK6vctlA9D+sVAlbTncmxQnW5kdfoy8jfXDzyBPN8mifqbdbN/X9A78ap/Cep++q6uCKdWA+NITr+vSeBrZWhlqfxMJsf6UqSZV0QFnVAcxfewCbyf0kZC4L4/QzylbiijwHdLbvKtL9TZL+llAxxBlb1pSrGl01Wvpt8s9L4kBCoGXX47FNwoz1vRLUXfJRBJVfVNCnM/7Oo8pIuyyqWa32PXxpoag1Va/wB7l0GkFl8GgkFHHK4i/wCawQ9Jk9nhHIgo48xdHS/tj5nqrLv+y06KTXb5nQy9BD4Xnwu7HETM+NqY0qQtyUVLL9un/tvZpBlDz0gxlt7cVB8fiWLf9Tqvshta2O+tbdedA1juEqptm4AEpBeQZ2QSg760/wDd0ifkGpbYU4Bpx4W5i0Kncxe7/ndRBGdOufkmenWMC4EK8mwpb11vkok+qBOx/SyuAahnX+LbMk2/ucjvf7qfNAPj/wCX8ZDlJkuLKOS1ih0EHC0Nbrp8aCwTxQpGXHln/JOLJpkmlx5L5p5Yd+D6v/1YKDsuU5n5TNJBsw8Rj3txjScNPub/AJdyUudRjxSGtm2puPtLuNTvGojt5CYDy7ew8B1emOcfMyzDopNbNMzVaASgujw/UFEV4ZyyeZoVfNY63I889NAB/upDl88u6NNky3PN4rnJP1q+EdIHW0aWmuk0dH/wiiYNIG8pjF53wBnBDejYeyQBVwpnwPE6OMkQr9t+SXxLoZKnvZuWnRzKP3nwhNPn4/NNPV3uWanxtgMPjXJt26lPHJRvn8XWHITLON+obSK2+Z3tRXe/9gUDNafP5HGRiamaLGUeFEWeh2J52LrnpnTz4o56lYyhIBhBeXHbmdBMGBglcTeDzt+drl8s/ox1k3PVhDrUr5Uk6PqS1tmUZmiHDjnHoQ/x9lSlO9EnR4QefKa0BNO56IKyT/p2jPXKsdc63vROt7oTVO0OepC1ZzSUVda0xVsz9F1vmQHf1Joo7NPmTE2V7WNhAvk7paGRYCcAiRFisfwpaqFOSp3NbbPtsP8Ac7iu3o80CoLWp8UTZtG8dY4Huak18qDOySQasWpXxuZ51HFBUi6z1eNm+5EHXXxxQG9eEne3yaPAhU+Fi27jy1OGWsdH0k2y9a8eWr0F+dz52s6TYn5NQHtL4hE/mzwmNUCnYYb3QntjvxoythBXJOoqnn/2zQ//AGtNU/vQrVRoWb/Kfqa7SZf0c1o2CdBe0T/SupEaQ/Sh3iyXXjqcmSy5XY8pG51MnUfY/oadMNfbZUurLpYqXqpKqWjf18q6HZuhP9J4K7PyKDLioQAtkLh4exxpTifsLez86DJqJZxMgAkd7nTPTzXllvQ+Tw7/AGfpBRP2mNn9a/VHnleUZ1Q8w0/v9H0ZPxtY7md/HX2rbsybJdbmnnRD1J/R3+4TxIBK19oqQENxZo+upqnev3xNea8Cbo86gg+Q4DC7owg4CmwF5JUFJbgO3tnYeA9TLdUNxzE0zSeHo580uqo8M1WhTmQK6/LcxMjwnKtzpNlUT/j78766nUhP70fvn8r44tPMUc0JVzSE61IrLvWze9Fc/wCkn8cwE+Sjt3L5GfAebdHB0bmSR0Ms0bEagAC0NxMBXuEIGlMGONnGzUtq5vCGqWa8ghO5dwUptHpfkG11Imork/bM78jUQN9j4yPP71Ls5N1+5FTZPnSI8bLfqKyGkig54q+a6FJ/7PX2/wDnzAhrW2kq3FLACckvRjrz+vG3yvnzp8/18L1+I1AC7ZXiCBfG9rScowe2ZJxF/ubQ2NDcxrVK/uxN6JQojZ+xqdz8Zp5dEun8fgajFJ/ro5rkvgo+u6Xep07OfCfUkH8QdT9px1PTMt3FUTpl8IgJtE0LKRJ4Ut4tC7ipGUnuHUt8eJFn9eOQ+wy2OqZEESTHjbkt7TCaBekCzg8m38CVs51WzqZp1R9tjk5nyNDurZeqUo8bK8yIb/F/WeeTl1p8bGnz3TTW/wDsDJskJ1XI/h5HJa/SpWlnrHW9bnQrs0deeT7adafP4WPDRAspWz9ytT4jW61/1U/15BJ8+ZYIKI2cqJy+0tStSSSPLXtN5Pa2BqK3uGSa+h0xIvKyj1+vk2eXQv0/6qlWqxdaN9VodSeG9Vuqa0A9P00nP/1Mur14LnWujp62lIR9dz9QEOhZk55fCDopkVLS407rUDG0dSDK8k/s+oaPLK7RmqL8ZsvTyGLSeFaDTDToRZSZWZftH/w1+/2G9hKfv/s/m69FOXFizZSQt3jKT7SsDSW63Bybol2s7mtVvUYptuWo22cfaaQVNToda+2lH/5dBfjf+rx16b0mDFp+2Oe+RN97N2mtumdKE6KOI8rFdQVxzIRDb4ytw5bAqkx6tgI7nys61uXJElV8n/1Xl1Vd1zTKH7/Z06Z8vP1oCpJcUPUpWmIqWha1rT4mKknzzzPP2Ch1+HMRNRrHSMkyhvlrlHwagnc6qT+x9A3J+ZTcJxLGuCr4q5QrzLtTbuVrUqFT/sRCoD0kFlCHIKD7xePBtpEsmR6fEGL5EXjFzq7gxrkHzTVTUVP6Zak1sHZsU5NU9fqDc2vccmTJMehxuqDuqVoMZCHbp8pIqSbHlRrf5HoZyGLJnqEHqYippoZ4P+2pBROd/wD1T15D8yMTjzPqKnnJ6jzSi19rhmTkkl5of3sqR+2MJ/IdJqJYA5LILAw27ewuTrQNQm2f41MbCcaKMZixTgKlSDJ9dboZ0w1+6a/c8uq3o0m3QeryY6p+v/d/VH/cTW1Oj96qfG/HKnjdZquJNdDljW2aZilP6ohLM61r9rRJWvroMs00jNaURqXf20G1/wBeU/Wl3Mv/AMS0JILKEi0R9GixvznXURSswHFoEH84RHGi9M8FXzVfZLDRvZOvtRtiUQQ/U8/ljVB061cDClMxGxkV8ah1+jVFCKFfh4sVGKAh2A7+KqaPCFbEem13o6HWz9lbK5Rx896uCX63Uy0+QRoP7O/H72MobG6fTSWCGLnkbZFkDoANNIewuvTYHcTZ4XY6RmmFl276K3sH7f8ARrXgXWpDR5fPimvZk2vRrrgKNkz45du/G18yS0a8b+y/H3V1DNIycVWOn9kut6PAOg/T/wBf2gm+pldVoUlZp8eANvjX6Hw7Xwn3fyXT6Q7Qd7enYXVrczaSqpSGZsiBjsZsHudA6m58/YkR342vh8qJWmT9VXPBp8qxn/SPSfs/3WkGvJ8ezXR+zejxr8cFOMebKZ89Ruh1KdKK/vdeDr/QammMeF5kR8nimPO3XO1PNfr9CJrWq8/lXShzfGyZ24AtvrMiIHIGDFPt3e+hmY5f1v8A+6fCCbPPl2755kPHCjqnJj98rqnvnaa/+Z2po2A+Ad6dOtM+PIhRNNOkr43+gSJWx6/6g+CvM0jykM2BUlHgnfNGzkHpRU8yV+up8J/v8nAt4Ix6fqsHM7DQjcY7cHBPdW2utR3LEk2eakH7AGj6NLtP1/XfjQa2P4FcOj9PNRtfr/X/AG67dprZrfP+tdJuOgjU1qkb+leH663v/ev96FPpoTf4uiigJ5GGds9db1rYuqfJt2NHjnzv8GAb/wAMlHK5gzF2ybXaD4LC3Vm1O2v/2Q==";
    this.doc.addImage(bgB64, "JPEG", 0, 0, pageW, pageH);

    
    // Gold Double Border
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(2);
    this.doc.rect(20, 20, pageW - 40, pageH - 40, "S");
    this.doc.setLineWidth(0.5);
    this.doc.rect(26, 26, pageW - 52, pageH - 52, "S");

    // Top Right words
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(8);
    this.doc.setTextColor(...GOLD);
    const rightMargin = pageW - 36;
    this.doc.text(spaced("DERECHO"), rightMargin, 40, { align: "right" });
    this.doc.text(spaced("INTELIGENCIA"), rightMargin, 52, { align: "right" });
    this.doc.text(spaced("EVIDENCIA"), rightMargin, 64, { align: "right" });
    this.doc.text(spaced("RESULTADOS"), rightMargin, 76, { align: "right" });

    // Center Logo "N"
    const cx = pageW / 2;
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(60);
    this.doc.setTextColor(255, 255, 255);
    this.doc.text("N", cx, 110, { align: "center" });
    
    // NYRAVA
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(32);
    this.doc.setTextColor(255, 255, 255);
    this.doc.text(spaced("NYRAVA"), cx, 150, { align: "center" });
    
    // LEGAL INTELLIGENCE
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(10);
    this.doc.setTextColor(...GOLD);
    this.doc.text(spaced("LEGAL INTELLIGENCE"), cx, 175, { align: "center" });
    
    // - MÉXICO -
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(0.5);
    this.doc.line(cx - 70, 195, cx - 35, 195);
    this.doc.line(cx + 35, 195, cx + 70, 195);
    this.doc.text(spaced("MÉXICO"), cx, 198, { align: "center" });

    // Large centered report title
    let ty = 260;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(28);
    this.doc.setTextColor(255, 255, 255);
    const titleLines = this.doc.splitTextToSize((opts.reportTitle || "INFORME DE INTELIGENCIA JURÍDICA").toUpperCase(), pageW - margin * 2) as string[];
    for (const line of titleLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += 34;
    }

    // Case Identity
    ty += 30;
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(24);
    const caseNameLines = this.doc.splitTextToSize(opts.caseName || "ADR 3265/2023", pageW - margin * 2) as string[];
    for (const line of caseNameLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += 28;
    }
    
    ty += 2;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(20);
    const proceedingLines = this.doc.splitTextToSize(opts.proceeding || "Amparo Directo en Revisión", pageW - margin * 2) as string[];
    for (const line of proceedingLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += 24;
    }

    ty += 4;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(16);
    const courtLines = this.doc.splitTextToSize(opts.court || "Suprema Corte de Justicia de la Nación", pageW - margin * 2) as string[];
    for (const line of courtLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += 20;
    }

    // Metadata table
    ty += 60;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(9);
    
    const fields = [
      { k: "CLIENTE", v: opts.client || "Confidencial" },
      { k: "EXPEDIENTE", v: opts.matterId || "ADR 3265/2023" },
      { k: "TIPO DE ASUNTO", v: opts.proceeding || "Amparo" },
      { k: "ÓRGANO JURISDICCIONAL", v: opts.court || "Suprema Corte de Justicia de la Nación" },
      { k: "MATERIA", v: opts.matterType || "Constitucional" },
      { k: "FECHA DEL ANÁLISIS", v: opts.date || "14 de septiembre de 2026" },
      { k: "NYRAVA MATTER ID", v: (opts.matterId || "44C5492F").slice(0, 8) }
    ];

    const leftCol = cx - 180;
    const rightCol = cx - 40;
    
    // Vertical line
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(0.5);
    this.doc.line(rightCol - 10, ty - 10, rightCol - 10, ty + (fields.length * 20));

    for (const f of fields) {
      if (f.v) {
        this.doc.setTextColor(...GOLD);
        this.doc.text(spaced(f.k), leftCol, ty);
        this.doc.setTextColor(255, 255, 255);
        
        // Handle multiline for court
        const vLines = this.doc.splitTextToSize(f.v, 200) as string[];
        for (const line of vLines) {
           this.doc.text(line, rightCol, ty);
           ty += 14;
        }
        ty += 6;
      }
    }

    // CONFIDENCIAL Box
    ty += 20;
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(1);
    this.doc.rect(cx - 120, ty, 240, 35, "S");
    
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(16);
    this.doc.setTextColor(...GOLD);
    this.doc.text(spaced(opts.classification || "CONFIDENCIAL"), cx, ty + 24, { align: "center" });

    // Certification text
    ty += 70;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(12);
    this.doc.setTextColor(255, 255, 255);
    this.doc.text("Sustentado en evidencia.", cx, ty, { align: "center" });
    this.doc.text("Citas auditadas.", cx, ty + 16, { align: "center" });
    this.doc.text("Diseñado para trabajo de inteligencia jurídica sensible.", cx, ty + 32, { align: "center" });

    // Footer lines
    ty += 60;
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(1);
    this.doc.line(cx - 15, ty, cx + 15, ty);
    
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(12);
    this.doc.text("Nyrava Legal Intelligence", cx, ty + 20, { align: "center" });
    this.doc.setFontSize(10);
    this.doc.setTextColor(...GOLD);
    this.doc.text("mexico.nyrava.com", cx, ty + 35, { align: "center" });

    // Bottom left Mexican architectural abstraction
    const bx = 36;
    const by = pageH - 50;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(8);
    this.doc.setTextColor(...GOLD);
    this.doc.text(spaced("INTELIGENCIA JURÍDICA"), bx, by);
    this.doc.setTextColor(200, 200, 200);
    this.doc.text(spaced("PARA UN MÉXICO MÁS FUERTE"), bx, by + 12);
    
    // Decorative skyline vector
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(0.5);
    this.doc.line(bx, by - 10, bx + 150, by - 10);
    this.doc.rect(bx + 10, by - 20, 10, 10, "S");
    this.doc.rect(bx + 30, by - 30, 20, 20, "S");
    this.doc.triangle(bx + 30, by - 30, bx + 50, by - 30, bx + 40, by - 45, "S");
    this.doc.circle(bx + 40, by - 20, 3, "S");
    this.doc.rect(bx + 70, by - 25, 15, 15, "S");
    this.doc.rect(bx + 90, by - 18, 12, 8, "S");

    // Bottom right page number
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(10);
    this.doc.setTextColor(255, 255, 255);
    this.doc.text("Página 1 de 24", pageW - 36, pageH - 40, { align: "right" });

    this.doc.addPage();
  }

  // Grid of compact stat cards (replaces the old plain label/value rows on
  // the cover). `cols` per row; each card gets a bold value + small caption.
  statCards(
    items: Array<{ label: string; value: string; color?: [number, number, number] }>,
    cols = 3,
  ) {
    // Hard cap at four columns: past that, a Letter-width card is narrower
    // than the Spanish labels it has to carry ("Documentos Analizados",
    // "Recomendaciones") and both label and value start truncating.
    const nCols = Math.max(1, Math.min(4, cols));
    const gap = 14;
    const w = (this.pageW - this.margin * 2 - gap * (nCols - 1)) / nCols;
    const h = 66;
    const padX = 18; // clears the accent bar on the left edge
    const rows = Math.ceil(items.length / nCols);
    for (let row = 0; row < rows; row++) {
      this.ensureSpace(h);
      for (let col = 0; col < nCols; col++) {
        const i = row * nCols + col;
        if (i >= items.length) break;
        const x = this.margin + col * (w + gap);
        const yy = this.y;
        const item = items[i];
        const cardLabel = rt(item.label);
        const cardValue = rt(item.value);
        // White card on the warm sheet, with a full-height accent rule
        // down the left edge instead of a corner dot. The rule is always
        // ACCENT gold — severity coloring belongs to findings, not to
        // neutral corpus counters, and a red bar here read as an alarm.
        this.doc.setFillColor(...CARD_BG);
        this.doc.setDrawColor(...CARD_BORDER);
        this.doc.setLineWidth(0.8);
        this.doc.roundedRect(x, yy, w, h, 6, 6, "FD");
        this.doc.setFillColor(...ACCENT);
        this.doc.rect(x + 1, yy + 4, 3, h - 8, "F");
        // Label — wraps to at most two lines instead of being clipped.
        this.doc.setFont("helvetica", "bold");
        this.doc.setFontSize(7);
        this.doc.setTextColor(...MUTED);
        const labelMaxW = w - padX - 12;
        const labelLines = (
          this.doc.splitTextToSize(cardLabel.toUpperCase(), labelMaxW) as string[]
        ).slice(0, 2);
        let ly = yy + 16;
        for (const line of labelLines) {
          this.doc.text(line, x + padX, ly);
          ly += 9;
        }
        // Value — serif, the single biggest lever on this component. Its
        // color still tracks the caller's semantic hint.
        const valueMaxW = w - padX - 12;
        this.doc.setFont("times", "bold");
        this.doc.setTextColor(...(item.color ?? PRIMARY));
        let vSize = 19;
        this.doc.setFontSize(vSize);
        while (vSize > 9 && this.doc.getTextWidth(cardValue) > valueMaxW) {
          vSize -= 0.5;
          this.doc.setFontSize(vSize);
        }
        let valueText = cardValue;
        if (this.doc.getTextWidth(valueText) > valueMaxW) {
          while (valueText.length > 3 && this.doc.getTextWidth(valueText + "…") > valueMaxW) {
            valueText = valueText.slice(0, -1);
          }
          valueText += "…";
        }
        this.doc.text(valueText, x + padX, yy + h - 16);
      }
      this.y += h + gap;
    }
  }

  // Chronological fact card used by the Hechos section: date chip, serif
  // headline, body copy — same card language as findings, so the factual
  // record no longer reads as an unstyled wall of paragraphs.
  factCard(dateLabel: string, title: string, body: string) {
    const innerW = this.pageW - this.margin * 2 - 28;
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(11.5);
    const titleLines = this.doc.splitTextToSize(title, innerW) as string[];
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(9.6);
    const bodyLines = body ? (this.doc.splitTextToSize(body, innerW) as string[]) : [];
    const h = (dateLabel ? 16 : 0) + titleLines.length * 14 + bodyLines.length * 12 + 20;
    this.ensureSpace(h + 10);
    const yy = this.y - 10;
    this.doc.setFillColor(...CARD_BG);
    this.doc.setDrawColor(...CARD_BORDER);
    this.doc.setLineWidth(0.8);
    this.doc.roundedRect(this.margin, yy, this.pageW - this.margin * 2, h, 5, 5, "FD");
    this.doc.setFillColor(...ACCENT);
    this.doc.rect(this.margin + 1, yy + 4, 3, h - 8, "F");
    let ty = yy + 16;
    if (dateLabel) {
      this.doc.setFont("helvetica", "bold");
      this.doc.setFontSize(7.4);
      this.doc.setTextColor(...ACCENT);
      this.doc.text(spaced(dateLabel.toUpperCase()), this.margin + 16, ty);
      ty += 15;
    }
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(11.5);
    this.doc.setTextColor(...PRIMARY);
    for (const line of titleLines) {
      this.doc.text(line, this.margin + 16, ty);
      ty += 14;
    }
    if (bodyLines.length) {
      ty += 2;
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(9.6);
      this.doc.setTextColor(...INK);
      for (const line of bodyLines) {
        this.doc.text(line, this.margin + 16, ty);
        ty += 12;
      }
    }
    this.y = yy + h + 12;
  }

  // Renders the constrained markdown the work-product models emit
  // (#/##/### headings, **bold**, - bullets) as real typography. Without
  // this the report printed literal "##" and "**" characters.
  markdownBody(md: string) {
    const stripInline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1");
    for (const raw of (md ?? "").replace(/\r\n/g, "\n").split("\n")) {
      const line = raw.trim();
      if (!line) {
        this.y += 4;
        continue;
      }
      if (/^(\*{3,}|-{3,}|_{3,})$/.test(line)) {
        this.ensureSpace(14);
        this.doc.setDrawColor(...CARD_BORDER);
        this.doc.setLineWidth(0.6);
        this.doc.line(this.margin, this.y, this.pageW - this.margin, this.y);
        this.y += 12;
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        const txt = stripInline(h[2]);
        this.y += level === 1 ? 10 : 8;
        this.text(level >= 3 ? txt : txt.toUpperCase(), {
          size: level === 1 ? 12 : level === 2 ? 10.5 : 10,
          bold: true,
          color: PRIMARY,
          gap: 6,
        });
        continue;
      }
      const bullet = line.match(/^[-*•]\s+(.*)$/);
      if (bullet) {
        this.bullets([stripInline(bullet[1])]);
        continue;
      }
      const numbered = line.match(/^(\d+)[.)]\s+(.*)$/);
      if (numbered) {
        this.text(`${numbered[1]}.  ${stripInline(numbered[2])}`, { size: 10, gap: 4 });
        continue;
      }
      const bold = line.match(/^\*\*(.+)\*\*:?$/);
      if (bold) {
        this.text(stripInline(bold[1]), { size: 10, bold: true, color: PRIMARY, gap: 4 });
        continue;
      }
      this.text(stripInline(line), { size: 10, gap: 6 });
    }
  }

  // Maps a severity word to the shared color language used across the
  // report: red=critical, amber=high, gold=medium, green=low/info,
  // slate=unknown. Reused by badges, table cells, and score bars so
  // severity always reads the same color no matter which widget shows it.
  // Accepts both the engine's English enum and its rendered Spanish
  // label, since tables now print translated severities.
  severityColor(sev: string): [number, number, number] {
    const s = (sev || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    if (s === "critical" || s === "critica") return DANGER;
    if (s === "high" || s === "alta") return HIGH;
    if (s === "medium" || s === "media") return MEDIUM;
    if (s === "low" || s === "info" || s === "baja") return SUCCESS;
    return MUTED;
  }
  // Width a pill() call would occupy, without drawing it — lets callers
  // reserve the right-hand gutter before laying out a heading beside it.
  measurePill(text: string): number {
    if (!text) return 0;
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(7.5);
    return this.doc.getTextWidth(text.toUpperCase()) + 12;
  }

  // Small filled pill. `align: "right"` anchors the box's right edge to x
  // (used to hang a severity/confidence pill off the right margin next to
  // a heading). Returns the pill width in case the caller wants to lay
  // out something else beside it.

  pill(
    text: string,
    x: number,
    y: number,
    color: [number, number, number],
    align: "left" | "right" = "left",
  ): number {
    if (!text) return 0;
    const label = text.toUpperCase();
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(7.5);
    const tw = this.doc.getTextWidth(label);
    const padX = 6;
    const w = tw + padX * 2;
    const h = 13;
    const boxX = align === "right" ? x - w : x;
    this.doc.setFillColor(...color);
    this.doc.roundedRect(boxX, y - h + 3, w, h, 3, 3, "F");
    this.doc.setTextColor(255, 255, 255);
    this.doc.text(label, boxX + padX, y - 3);
    return w;
  }

  // Mini horizontal score bar, color-coded green/gold/red by value. Used
  // in the scorecard so dimension scores read visually instead of forcing
  // the reader to parse "0 / 100" as plain text nine times in a row.
  scoreBar(x: number, y: number, w: number, value: number, max = 100) {
    // Thin, minimalist progress bar — the numeric score is the focal
    // point; the bar is a subtle visual aid. Light track + rounded fill
    // reads as premium editorial rather than dashboard widget.
    const h = 3;
    const pct = Math.max(0, Math.min(1, value / max));
    this.doc.setFillColor(236, 239, 243);
    this.doc.roundedRect(x, y + 3, w, h, h / 2, h / 2, "F");
    const color = value >= 60 ? SUCCESS : value >= 35 ? ACCENT : DANGER;
    const filled = Math.max(w * pct, pct > 0 ? 4 : 0);
    if (filled > 0) {
      this.doc.setFillColor(...color);
      this.doc.roundedRect(x, y + 3, filled, h, h / 2, h / 2, "F");
    }
  }

  // A single scannable dimension row: label + bar + numeric score, colored
  // to match. Replaces a bare "Dimension  Score  Baseline  Δ" text line.
  // `invert` affects ONLY the bar fill and color, never the printed number.
  // Some dimensions (bias, credibility risk) are "good" when LOW, so a
  // caller can pass invert=true to make a full/green bar mean "favorable"
  // for that witness. The number shown must always be the true score —
  // the same value shown in the summary table above — or the detail card
  // silently contradicts the table it's directly below.
  dimensionRow(label: string, value: number, opts: { invert?: boolean } = {}) {
    this.ensureSpace(24);
    const barX = this.margin + 165;
    const barW = this.pageW - this.margin - barX - 40;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(10);
    this.doc.setTextColor(...PRIMARY);
    this.doc.text(label, this.margin, this.y);
    const displayValue = opts.invert ? 100 - value : value;
    this.scoreBar(barX, this.y - 6, barW, displayValue);
    const color = displayValue >= 60 ? SUCCESS : displayValue >= 35 ? ACCENT : DANGER;
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(10);
    this.doc.setTextColor(...color);
    this.doc.text(`${Math.round(value)}`, barX + barW + 8, this.y);
    this.y += 20;
  }

  // Thin divider used between repeated entries (findings, witnesses) to
  // give visual separation without the cost of a fully boxed card.
  divider() {
    this.ensureSpace(14);
    this.y += 8;
    this.doc.setDrawColor(232, 235, 240);
    this.doc.setLineWidth(0.4);
    this.doc.line(this.margin, this.y, this.pageW - this.margin, this.y);
    this.y += 16;
  }

  text(
    value: string,
    opts: { size?: number; bold?: boolean; color?: [number, number, number]; gap?: number } = {},
  ) {
    const size = opts.size ?? 10.5;
    // Generous leading (~1.55) so body copy reads like an editorial
    // briefing rather than a data table. Paragraph gaps are proportional
    // and slightly larger, adding real breathing room between paragraphs.
    const lineH = size * 1.55;
    this.doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    this.doc.setFontSize(size);
    this.doc.setTextColor(...(opts.color ?? INK));
    const paragraphs = value.split(/\n\s*\n/);
    for (let p = 0; p < paragraphs.length; p++) {
      const para = paragraphs[p];
      const lines = this.doc.splitTextToSize(para, this.pageW - this.margin * 2) as string[];
      for (const line of lines) {
        this.ensureSpace(lineH);
        this.doc.text(line, this.margin, this.y);
        this.y += lineH;
      }
      if (p < paragraphs.length - 1) this.y += lineH * 0.75;
    }
    if (opts.gap) this.y += opts.gap;
  }

  // Force a hard page break. Used ONLY between the cover and the TOC so
  // section headings flow naturally across pages instead of always
  // starting a new sheet (which left half-empty pages everywhere).
  pageBreak() {
    this.doc.addPage();
    this.y = this.margin + CONTINUATION_HEADER_H;
  }

  /**
   * Shared section opener used by every major section: letter-spaced gold
   * kicker → serif title → short gold rule. Consistency here is what makes
   * the report read as one document instead of many stitched sections.
   * Returns the y position to continue drawing from.
   */
  sectionTitle(kicker: string, title: string): number {
    // Record which page this section opens on so header() can emit a
    // continuation label on the pages it spills onto.
    const _pg = this.doc.getCurrentPageInfo().pageNumber;
    // A section can open midway down a page: everything above it is the
    // previous section spilling over, and that top-of-page content still
    // needs identification. Stamp the continuation label now, while we're
    // on the right page (header() only sees pages with no section start).
    if (_pg > 1 && this.currentSection && this.y > this.margin + CONTINUATION_HEADER_H + 14) {
      this.continuationLabel(this.currentSection, 50);
    }
    this.currentSection = rt(title);
    this.sectionStarts.set(_pg, { title: rt(title), y: this.y });
    if (kicker) {
      this.doc.setFont("helvetica", "bold");
      this.doc.setFontSize(8.4);
      this.doc.setTextColor(...ACCENT);
      this.doc.text(spaced(rt(kicker).toUpperCase()), this.margin, this.y);
      // Clear the serif title's ascender: the 20pt title baseline needs
      // ~24pt below the kicker baseline or the two strings collide.
      this.y += 26;
    }
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(20);
    this.doc.setTextColor(...PRIMARY);
    const lines = this.doc.splitTextToSize(title, this.pageW - this.margin * 2) as string[];
    for (const line of lines) {
      this.doc.text(line, this.margin, this.y);
      this.y += 25;
    }
    this.doc.setDrawColor(...ACCENT);
    this.doc.setLineWidth(2.2);
    this.doc.line(this.margin, this.y - 4, this.margin + 40, this.y - 4);
    this.y += 22;

    return this.y;
  }

  h1(label: string, kicker?: string) {
    // Generous top spacing gives each section true separation and
    // signals executive-briefing hierarchy. Every h1 routes through the
    // shared sectionTitle() treatment. The kicker describes THIS section
    // (per-section eyebrow) rather than repeating the brand name on every
    // page, which read as a template artifact.
    if (this.firstSectionRendered) {
      this.y += 34;
    }
    this.firstSectionRendered = true;
    this.ensureSpace(120);
    this.sectionTitle(kicker ?? SECTION_KICKERS[label] ?? label, label);
  }

  h2(label: string) {
    // Quiet subsection header: uppercase small-caps label with a hairline
    // rule beneath it, no filled tinted bar. Reads as editorial, not as
    // a boxed dashboard card.
    this.ensureSpace(90);
    this.y += 16;
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(10);
    this.doc.setTextColor(...PRIMARY);
    this.doc.text(label.toUpperCase(), this.margin, this.y);
    this.y += 6;
    this.doc.setDrawColor(230, 233, 238);
    this.doc.setLineWidth(0.5);
    this.doc.line(this.margin, this.y, this.pageW - this.margin, this.y);
    this.y += 16;
  }

  // Same quiet subsection header as h2(), but with a small colored dot
  // beside the label to signal severity tier at a glance.
  h2Tier(label: string, color: [number, number, number]) {
    this.ensureSpace(90);
    this.y += 16;
    this.doc.setFillColor(...color);
    this.doc.circle(this.margin + 3, this.y - 3, 2.8, "F");
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(10);
    this.doc.setTextColor(...PRIMARY);
    this.doc.text(rt(label).toUpperCase(), this.margin + 12, this.y);
    this.y += 6;
    this.doc.setDrawColor(230, 233, 238);
    this.doc.setLineWidth(0.5);
    this.doc.line(this.margin, this.y, this.pageW - this.margin, this.y);
    this.y += 16;
  }

  h3(label: string) {
    // Reserve the heading's own height PLUS room for at least a few lines
    // of body content after it — otherwise a subheading can be the very
    // last thing on a page with nothing beneath it (an orphaned heading).
    this.ensureSpace(84);
    this.y += 4;
    this.text(label, { size: 11.5, bold: true, color: ACCENT, gap: 4 });
  }

  // Compact horizontal score presentation used in Executive Summary and
  // Risk Analysis — the SAME numbers already displayed as large radial
  // gauges on the cover page, but rendered here as a slim card strip
  // (label + numeric value + mini bar) so the reader isn't hit with a
  // second big-graphic repeat of the same figures one page later.
  compactScoreStrip(
    items: Array<{ label: string; value: number; max?: number; color: [number, number, number] }>,
  ) {
    if (!items.length) return;
    const h = 38;
    this.ensureSpace(h + 18);
    const gap = 16;
    const cols = items.length;
    const w = (this.pageW - this.margin * 2 - gap * (cols - 1)) / cols;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const x = this.margin + i * (w + gap);
      const y = this.y;
      const max = item.max ?? 100;
      // Airy card: hairline border only, small color dot, no fill.
      this.doc.setDrawColor(230, 233, 238);
      this.doc.setLineWidth(0.5);
      this.doc.roundedRect(x, y, w, h, 4, 4, "S");
      this.doc.setFillColor(...item.color);
      this.doc.circle(x + w - 10, y + 10, 2.2, "F");
      this.doc.setFont("helvetica", "bold");
      this.doc.setFontSize(7);
      this.doc.setTextColor(...MUTED);
      this.doc.text(item.label.toUpperCase(), x + 12, y + 14);
      const valueLabel = `${Math.round(item.value)}`;
      this.doc.setFont("helvetica", "bold");
      this.doc.setFontSize(14);
      this.doc.setTextColor(...PRIMARY);
      this.doc.text(valueLabel, x + 12, y + 30);
      const valueW = this.doc.getTextWidth(valueLabel);
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(7.5);
      this.doc.setTextColor(...MUTED);
      this.doc.text(`/ ${max}`, x + 12 + valueW + 4, y + 30);
      const barX = x + 12 + valueW + 22;
      const barW = x + w - 20 - barX;
      if (barW > 24) {
        this.scoreBar(barX, y + 24, barW, item.value, max);
      }
    }
    this.y += h + 18;
  }

  label(label: string, value: string) {
    this.ensureSpace(16);
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(9);
    this.doc.setTextColor(...MUTED);
    this.doc.text(label.toUpperCase(), this.margin, this.y);
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(10.5);
    this.doc.setTextColor(...PRIMARY);
    this.doc.text(value, this.margin + 110, this.y);
    this.y += 14;
  }

  callout(label: string, value: string, color: [number, number, number] = ACCENT) {
    this.ensureSpace(52);
    const x = this.margin;
    const w = this.pageW - this.margin * 2;
    // Quiet callout: no border, subtle fill, thin colored left rule.
    this.doc.setFillColor(249, 250, 252);
    this.doc.roundedRect(x, this.y, w, 40, 3, 3, "F");
    this.doc.setFillColor(...color);
    this.doc.rect(x, this.y, 2.5, 40, "F");
    this.doc.setTextColor(...color);
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(8);
    this.doc.text(label.toUpperCase(), x + 14, this.y + 15);
    this.doc.setTextColor(...PRIMARY);
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(11);
    this.doc.text(value, x + 14, this.y + 31);
    this.y += 52;
  }

  // Headline meter — large number, small caption, thin progress bar.
  // Refined for premium feel: hairline border only, generous internal
  // whitespace, minimal bar height. The score is the focal point.
  meter(
    x: number,
    y: number,
    w: number,
    label: string,
    value: number,
    max: number,
    color: [number, number, number],
  ) {
    const h = 60;
    this.doc.setDrawColor(230, 233, 238);
    this.doc.setLineWidth(0.5);
    this.doc.roundedRect(x, y, w, h, 4, 4, "S");
    this.doc.setFillColor(...color);
    this.doc.circle(x + w - 12, y + 12, 2.5, "F");
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(8);
    this.doc.setTextColor(...MUTED);
    this.doc.text(label.toUpperCase(), x + 14, y + 16);
    const valueLabel = `${Math.round(value)}`;
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(22);
    this.doc.setTextColor(...PRIMARY);
    this.doc.text(valueLabel, x + 14, y + 40);
    const valueW = this.doc.getTextWidth(valueLabel);
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(9);
    this.doc.setTextColor(...MUTED);
    this.doc.text(`/ ${max}`, x + 14 + valueW + 5, y + 40);
    // Thin bar along the bottom of the card.
    const barX = x + 14;
    const barW = w - 28;
    const barY = y + h - 12;
    const barH = 3;
    this.doc.setFillColor(236, 239, 243);
    this.doc.roundedRect(barX, barY, barW, barH, barH / 2, barH / 2, "F");
    const pct = Math.max(0, Math.min(1, value / max));
    const filled = Math.max(barW * pct, pct > 0 ? 4 : 0);
    if (filled > 0) {
      this.doc.setFillColor(...color);
      this.doc.roundedRect(barX, barY, filled, barH, barH / 2, barH / 2, "F");
    }
  }

  // Side-by-side pair (or trio, etc.) of large meters for headline scores.
  // Used on the Executive Summary in place of the old plain-text callout
  // boxes for Case Strength / Risk Score — these are the two most
  // important numbers in the report and merit real graphical treatment
  // rather than a bare label/value line.
  meterPair(
    items: Array<{ label: string; value: number; max?: number; color: [number, number, number] }>,
  ) {
    if (!items.length) return;
    const h = 60;
    this.ensureSpace(h + 20);
    const gap = 16;
    const cols = items.length;
    const w = (this.pageW - this.margin * 2 - gap * (cols - 1)) / cols;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const x = this.margin + i * (w + gap);
      this.meter(x, this.y, w, item.label, item.value, item.max ?? 100, item.color);
    }
    this.y += h + 20;
  }

  // Traffic-light coloring shared by every score-bearing widget (scoreBar,
  // meter, gauge). `invert=true` is for metrics where LOW is good (e.g.
  // risk score), so a red ring always means "bad" regardless of which
  // direction the underlying number runs.
  scoreColor(value: number, invert = false): [number, number, number] {
    const v = invert ? 100 - value : value;
    return v >= 60 ? SUCCESS : v >= 35 ? ACCENT : DANGER;
  }

  // Donut-style radial gauge: a filled pie sector (drawn as a triangle fan
  // from the center, since jsPDF has no native arc-fill primitive) with a
  // white circle punched out of the middle, and the value printed in the
  // hole. This is the "risk wheel" / circular gauge treatment — a real
  // graphical gauge, not a stat card — for the one or two numbers on the
  // report that deserve to be unmissable in the first few seconds.
  radialGauge(
    cx: number,
    cy: number,
    r: number,
    value: number,
    max: number,
    color: [number, number, number],
    label: string,
  ) {
    const pct = Math.max(0, Math.min(1, value / max));
    // Background track.
    this.doc.setFillColor(...CARD_BORDER);
    this.doc.circle(cx, cy, r, "F");
    // Filled sector, drawn as a fan of thin triangles from the center,
    // starting at 12 o'clock and sweeping clockwise.
    if (pct > 0) {
      const start = -Math.PI / 2;
      const total = pct * Math.PI * 2;
      const steps = Math.max(1, Math.ceil((total / (Math.PI * 2)) * 90));
      this.doc.setFillColor(...color);
      let prevX = cx + r * Math.cos(start);
      let prevY = cy + r * Math.sin(start);
      for (let i = 1; i <= steps; i++) {
        const a = start + (total * i) / steps;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        this.doc.triangle(cx, cy, prevX, prevY, x, y, "F");
        prevX = x;
        prevY = y;
      }
    }
    // Donut hole + center readout. Larger hole = thinner ring (premium
    // editorial gauge, not a heavy dashboard donut).
    this.doc.setFillColor(255, 255, 255);
    this.doc.circle(cx, cy, r * 0.82, "F");
    const valueLabel = `${Math.round(value)}`;
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(Math.round(r * 0.78));
    this.doc.setTextColor(...PRIMARY);
    this.doc.text(valueLabel, cx, cy + r * 0.22, { align: "center" });
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(Math.max(6.5, Math.round(r * 0.2)));
    this.doc.setTextColor(...MUTED);
    this.doc.text(`/ ${max}`, cx, cy + r * 0.5, { align: "center" });
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(8);
    this.doc.setTextColor(...MUTED);
    this.doc.text(label.toUpperCase(), cx, cy + r + 16, { align: "center" });
  }

  // Row of side-by-side radial gauges — the circular counterpart to
  // meterPair(), used on the new Executive Intelligence Dashboard page.
  gaugeRow(
    items: Array<{ label: string; value: number; max?: number; color: [number, number, number] }>,
    radius = 28,
  ) {
    if (!items.length) return;
    const rowH = radius * 2 + 36;
    this.ensureSpace(rowH + 12);
    const gap = 28;
    const cols = items.length;
    const cellW = (this.pageW - this.margin * 2 - gap * (cols - 1)) / cols;
    const cy = this.y + radius + 4;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const cx = this.margin + i * (cellW + gap) + cellW / 2;
      this.radialGauge(cx, cy, radius, item.value, item.max ?? 100, item.color, item.label);
    }
    this.y += rowH + 8;
  }

  // Full-width colored status banner (e.g. "HIGH RISK — Defense
  // Advantage"). This is the thing meant to land in the first few seconds
  // of opening the report, before the reader parses a single sentence.
  statusBanner(headline: string, subline: string, color: [number, number, number]) {
    // Refined tinted banner — subdued surface with a colored left rule and
    // dark text, rather than a full saturated red slab. Reads as an
    // executive alert, not a warning label.
    const h = 40;
    this.ensureSpace(h + 18);
    const x = this.margin;
    const w = this.pageW - this.margin * 2;
    // Very soft tint of the accent color (mix ~10% into white).
    const tint: [number, number, number] = [
      Math.round(color[0] * 0.08 + 255 * 0.92),
      Math.round(color[1] * 0.08 + 255 * 0.92),
      Math.round(color[2] * 0.08 + 255 * 0.92),
    ];
    this.doc.setFillColor(...tint);
    this.doc.roundedRect(x, this.y, w, h, 5, 5, "F");
    // Colored left rule
    this.doc.setFillColor(...color);
    this.doc.roundedRect(x, this.y, 3, h, 1.5, 1.5, "F");
    // Small solid dot as the "icon"
    this.doc.setFillColor(...color);
    this.doc.circle(x + 18, this.y + h / 2, 3.2, "F");
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(11);
    this.doc.setTextColor(...PRIMARY);
    this.doc.text(headline.toUpperCase(), x + 30, this.y + h / 2 - 2);
    if (subline) {
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(9);
      this.doc.setTextColor(...MUTED);
      this.doc.text(subline, x + 30, this.y + h / 2 + 11);
    }
    this.y += h + 22;
  }

  // One compact scannable row for a "Top Findings" preview — a colored
  // severity dot, the title, and a right-aligned severity/confidence pill.
  // Deliberately terse (title only, no description) since its job is a
  // 3-second scan, not the full write-up — that lives in Key Findings.
  findingChip(severity: string, title: string, confidence: number) {
    const h = 26;
    this.ensureSpace(h + 8);
    const color = this.severityColor(severity);
    const sevLabel = rt(severity.toUpperCase());
    const yy = this.y - 12;
    // Compact white card with a severity rule on the left edge — same
    // visual language as the full finding cards further down the report.
    this.doc.setFillColor(...CARD_BG);
    this.doc.setDrawColor(...CARD_BORDER);
    this.doc.setLineWidth(0.8);
    this.doc.roundedRect(this.margin, yy, this.pageW - this.margin * 2, h, 5, 5, "FD");
    this.doc.setFillColor(...color);
    this.doc.rect(this.margin + 1, yy + 3, 3, h - 6, "F");
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(11);
    this.doc.setTextColor(...PRIMARY);
    const maxW = this.pageW - this.margin * 2 - 150;
    const titleLine = (this.doc.splitTextToSize(title, maxW) as string[])[0] ?? "";
    this.doc.text(titleLine, this.margin + 14, yy + 17);
    this.pill(
      `${sevLabel} · ${Math.round(confidence * 100)}%`,
      this.pageW - this.margin - 8,
      yy + 20,
      color,
      "right",
    );
    this.y += h + 8;
  }

  /**
   * Evidence blockquote: a lightly tinted block with a gold rule on its
   * left edge, so a cited quote reads as evidence rather than as another
   * sentence of body copy.
   */
  evidenceQuote(text: string, attribution = "") {
    if (!text) return;
    const innerW = this.pageW - this.margin * 2 - 24;
    this.doc.setFont("helvetica", "italic");
    this.doc.setFontSize(8.6);
    const lines = this.doc.splitTextToSize(`"${text}"`, innerW) as string[];
    const attrLines = attribution ? ([attribution] as string[]) : [];
    const h = lines.length * 12 + attrLines.length * 11 + 14;
    this.ensureSpace(h + 6);
    const yy = this.y - 10;
    this.doc.setFillColor(...QUOTE_BG);
    this.doc.rect(this.margin, yy, this.pageW - this.margin * 2, h, "F");
    this.doc.setFillColor(...ACCENT);
    this.doc.rect(this.margin, yy, 2.4, h, "F");
    this.doc.setFont("helvetica", "italic");
    this.doc.setFontSize(8.6);
    this.doc.setTextColor(...MUTED);
    let ty = yy + 16;
    for (const line of lines) {
      this.doc.text(line, this.margin + 14, ty);
      ty += 12;
    }
    for (const line of attrLines) {
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(7.5);
      this.doc.text(line, this.margin + 14, ty);
      ty += 11;
    }
    this.y = yy + h + 12;
  }

  table(
    head: string[][],
    body: (string | number)[][],
    opts: {
      // Column index -> jspdf-autotable column style (e.g. { cellWidth: 90 }).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      columnStyles?: Record<number, any>;
      emphasizeColIdx?: number; // rendered bold (e.g. a "Document" column)
      mutedColIdx?: number; // rendered muted/italic (e.g. a "Quote" column)
      // Editorial variant: no dark header band, just a hairline rule under
      // small-caps labels. Used by the index/contents table, where a heavy
      // green header row fought with the redesigned section titles.
      plainHead?: boolean;
    } = {},
  ) {
    if (body.length === 0) return;
    this.ensureSpace(40);
    const headerRow = head[0] ?? [];
    const sevColIdx = headerRow.findIndex((hh) => /severity/i.test(hh));
    const scoreColIdx = headerRow.findIndex((hh) => /^score$/i.test(hh.trim()));
    autoTable(this.doc, {
      head,
      body,
      startY: this.y,
      // Reserve the same top/bottom bands on every page a table might
      // spill onto — including pages autoTable creates on its own mid-
      // table, which don't otherwise know about the branded continuation
      // header or the footer page-stamp painted in a later post-pass.
      // Without this, a long table (e.g. the citation appendix) could
      // print its header row or a data row directly underneath where
      // header()/footer() draw afterward, producing an overlap.
      margin: {
        top: this.margin + CONTINUATION_HEADER_H + 4,
        left: this.margin,
        right: this.margin,
        bottom: this.margin + 26,
      },
      styles: {
        fontSize: 8.7,
        cellPadding: { top: 7.5, right: 8, bottom: 7.5, left: 8 },
        textColor: [...INK] as [number, number, number],
        overflow: "linebreak",
        lineColor: [...LINE] as [number, number, number],
        lineWidth: 0.5,
        fillColor: [...CARD_BG] as [number, number, number],
      },
      headStyles: opts.plainHead
        ? {
            fillColor: [...PAGE_BG] as [number, number, number],
            textColor: [...MUTED] as [number, number, number],
            fontStyle: "bold",
            fontSize: 7.8,
            cellPadding: { top: 4, right: 8, bottom: 6, left: 8 },
            lineColor: [...ACCENT] as [number, number, number],
            lineWidth: { top: 0, right: 0, bottom: 1, left: 0 },
          }
        : {
            fillColor: [...PRIMARY] as [number, number, number],
            textColor: [255, 255, 255],
            fontStyle: "bold",
            fontSize: 8.5,
            cellPadding: { top: 8, right: 8, bottom: 8, left: 8 },
            lineWidth: 0,
          },
      // Very subtle warm zebra tint — enough to track a row across a wide
      // table, quiet enough not to read as a dashboard grid.
      alternateRowStyles: { fillColor: [252, 250, 246] as [number, number, number] },
      columnStyles: opts.columnStyles,
      theme: "grid",
      // Color-code Severity and Score columns wherever a table has them,
      // so risk reads visually (red/amber/gold/green) instead of forcing
      // the reader to parse every cell as plain black text. Uppercase
      // header labels for the same enterprise typographic voice used by
      // every pill/label elsewhere in the report.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      didParseCell: (d: any) => {
        if (d.section === "head") {
          d.cell.text = d.cell.text.map((t: string) => t.toUpperCase());
          if (!opts.plainHead) d.cell.styles.lineWidth = 0;
          return;
        }
        if (d.section !== "body") return;
        // No vertical grid lines anywhere; a single hairline rule under
        // each row is the only structure the body needs.
        d.cell.styles.lineWidth = { top: 0, right: 0, bottom: 0.5, left: 0 };

        if (sevColIdx >= 0 && d.column.index === sevColIdx) {
          d.cell.styles.textColor = this.severityColor(String(d.cell.raw ?? ""));
          d.cell.styles.fontStyle = "bold";
        }
        if (scoreColIdx >= 0 && d.column.index === scoreColIdx) {
          const m = String(d.cell.raw ?? "").match(/-?\d+(\.\d+)?/);
          if (m) {
            const n = parseFloat(m[0]);
            d.cell.styles.textColor = n >= 60 ? SUCCESS : n >= 35 ? ACCENT : DANGER;
            d.cell.styles.fontStyle = "bold";
          }
        }
        if (opts.emphasizeColIdx != null && d.column.index === opts.emphasizeColIdx) {
          d.cell.styles.fontStyle = "bold";
          d.cell.styles.textColor = [...PRIMARY] as [number, number, number];
        }
        if (opts.mutedColIdx != null && d.column.index === opts.mutedColIdx) {
          d.cell.styles.fontStyle = "italic";
          d.cell.styles.textColor = [...MUTED] as [number, number, number];
        }
      },
    } as unknown as Parameters<typeof autoTable>[1]);
    this.y = (this.doc.lastAutoTable?.finalY ?? this.y) + 14;
  }

  bullets(items: string[]) {
    for (const it of items.filter(Boolean)) {
      this.ensureSpace(14);
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(10.5);
      this.doc.setTextColor(...PRIMARY);
      const lines = this.doc.splitTextToSize(
        `•  ${it}`,
        this.pageW - this.margin * 2 - 12,
      ) as string[];
      for (const line of lines) {
        this.ensureSpace(14);
        this.doc.text(line, this.margin + 6, this.y);
        this.y += 13;
      }
    }
  }

  // Compact branded header painted on every page after the cover. This is
  // deliberately a post-pass over already-rendered pages (same pattern as
  // footer()) rather than something drawn inline during content layout —
  // it needs the final page count for "i / N", and painting it last means
  // it can never be pushed down or split by content that ran long. Every
  // continuation page already reserves CONTINUATION_HEADER_H of top space
  // (see ensureSpace/pageBreak), so this never overlaps body content.
  header() {
    const pageCount = this.doc.getNumberOfPages();
    const h = CONTINUATION_HEADER_H;
    const bandH = 36; // running header band — deliberately short so it never competes with the cover
    let lastSection = "";
    for (let i = 2; i <= pageCount; i++) {
      this.doc.setPage(i);

      // Warm sheet across the reserved top area (defensive — guards
      // against any stray content drawn too high), then a solid PRIMARY
      // brand band. All text inside the band is white or ACCENT_SOFT:
      // MUTED/INK were tuned for the warm page and vanish on green.
      this.doc.setFillColor(...PAGE_BG);
      this.doc.rect(0, 0, this.pageW, h, "F");
      this.doc.setFillColor(...PRIMARY);
      this.doc.rect(0, 0, this.pageW, bandH, "F");

      const markSize = 17;
      const markX = this.margin;
      const markCy = bandH / 2;
      if (!this.drawCrest(markX + markSize / 2, markCy, markSize)) {
        this.doc.setFont("helvetica", "bold");
        this.doc.setFontSize(11);
        this.doc.setTextColor(...ACCENT_SOFT);
        this.doc.text("N", markX + markSize / 2, markCy + 4, { align: "center" });
      }

      const textX = markX + markSize + 9;
      this.doc.setFont("helvetica", "bold");
      this.doc.setFontSize(9);
      this.doc.setTextColor(255, 255, 255);
      this.doc.text("NYRAVA", textX, markCy - 1);
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(6.5);
      this.doc.setTextColor(...ACCENT_SOFT);
      this.doc.text("LEGAL INTELLIGENCE OS", textX, markCy + 8);

      // Right side: short matter/docket ID only + page stamp. Never the
      // full case title — it clips at the page edge on long matter names.
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(7.5);
      this.doc.setTextColor(...ACCENT_SOFT);
      const rightLabel = `${this.matterId}   ·   ${i} / ${pageCount}`;
      const rightMaxW = this.pageW - this.margin * 2 - (textX - this.margin) - 150;
      const fitted =
        (this.doc.splitTextToSize(rightLabel, Math.max(80, rightMaxW)) as string[])[0] ??
        rightLabel;
      this.doc.text(fitted, this.pageW - this.margin, markCy + 3, { align: "right" });

      this.doc.setDrawColor(...LINE);
      this.doc.setLineWidth(0.6);
      this.doc.line(this.margin, h - 6, this.pageW - this.margin, h - 6);

      // Section identity: full title pages own their heading; every other
      // page gets a lightweight continuation label so no interior page
      // ever starts with bare body text.
      const startsHere = this.sectionStarts.get(i);
      if (startsHere) {
        // Mid-page section starts already stamped their own continuation
        // label inline (see sectionTitle) — nothing more to draw here.
        lastSection = startsHere.title;
      } else if (lastSection) {
        this.continuationLabel(lastSection, bandH + 14);
      }
    }
  }

  /** Lightweight "Section (continuación)" marker for pages a section
   * spills onto. Intentionally separate from sectionTitle() — small,
   * italic, muted; it identifies, it does not re-announce. */
  continuationLabel(sectionName: string, y: number) {
    this.doc.setFont("helvetica", "italic");
    this.doc.setFontSize(7.5);
    this.doc.setTextColor(...MUTED);
    const suffix = getReportTemplateLocale() === "en" ? "(continued)" : "(continuación)";
    const label = `${sectionName} ${suffix}`;
    const fitted =
      (this.doc.splitTextToSize(label, this.pageW - this.margin * 2) as string[])[0] ?? label;
    this.doc.text(fitted, this.margin, y);
  }

  footer(meta: { parity: string; ess: string; generatedAt: string } | null) {
    const pageCount = this.doc.getNumberOfPages();
    const pageLabelW = 70; // reserved width for the right-aligned "Page i / N"
    for (let i = 1; i <= pageCount; i++) {
      this.doc.setPage(i);
      // The compact header (drawn separately, see header() above) already
      // carries a brand rule at the top of every interior page, so the old
      // duplicate top strip that used to live here has been removed —
      // this loop now only draws the bottom footer text.
      // Hairline above the footer row, matching the header treatment.
      if (i > 1) {
        this.doc.setDrawColor(...LINE);
        this.doc.setLineWidth(0.6);
        this.doc.line(this.margin, this.pageH - 42, this.pageW - this.margin, this.pageH - 42);
      }
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(7.7);
      this.doc.setTextColor(...MUTED);
      // Bound-checked the same way header()'s right-hand label already is:
      // a long case name must never be allowed to grow into the reserved
      // "Page i / N" zone on the right.
      const brandLine = `Nyrava Legal Intelligence  ·  mexico.nyrava.com  ·  ${this.caseName}`;
      const brandMaxW = this.pageW - this.margin * 2 - pageLabelW;
      const brandFitted =
        (this.doc.splitTextToSize(brandLine, brandMaxW) as string[])[0] ?? brandLine;
      this.doc.text(brandFitted, this.margin, this.pageH - 30);
      this.doc.text(`Page ${i} / ${pageCount}`, this.pageW - this.margin, this.pageH - 30, {
        align: "right",
      });
      if (LEGAL_MODE)
        this.doc.text("Confidential Attorney Work Product", this.pageW / 2, this.pageH - 30, {
          align: "center",
        });
      if (meta && _citationMode === "audit") {
        this.doc.setFontSize(7);
        const stamp = `parity ${meta.parity}  ·  ESS ${meta.ess}  ·  ${meta.generatedAt}  ·  NYRAVA v${NYRAVA_REPORT_VERSION}`;
        this.doc.text(stamp, this.pageW / 2, this.pageH - 18, { align: "center" });
      }
    }
  }

  // Full closing page appended after all report content: mark, domain,
  // engine version/timestamp, and a standing disclaimer that this is
  // AI-assisted analysis requiring attorney verification before filing —
  // the same caution already flagged per-draft in Attorney Work Product
  // ("EVIDENCE VERIFICATION FAILED — DO NOT FILE AS-IS"), stated once,
  // plainly, in a place a reader will find even if they skip straight to
  // the end. Not part of the section plan/TOC — this is closing branding,
  // not a numbered analytical section, so it deliberately sits outside
  // the TOC/parity machinery entirely.
  closingPage(meta: { generatedAt: string }) {
    this.pageBreak();
    const cx = this.pageW / 2;
    let yy = this.pageH / 2 - 90;
    this.trustBadge(cx, yy, 40);
    yy += 40;
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(16);
    this.doc.setTextColor(...PRIMARY);
    this.doc.text("NYRAVA", cx, yy, { align: "center" });
    yy += 16;
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(8.5);
    this.doc.setTextColor(...ACCENT);
    this.doc.text("L E G A L   I N T E L L I G E N C E   O S", cx, yy, { align: "center" });
    yy += 14;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(10);
    this.doc.setTextColor(...MUTED);
    this.doc.text("mexico.nyrava.com", cx, yy, { align: "center" });
    yy += 22;
    this.doc.setDrawColor(...CARD_BORDER);
    this.doc.setLineWidth(0.75);
    this.doc.line(cx - 60, yy, cx + 60, yy);
    yy += 20;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(8.5);
    this.doc.setTextColor(...MUTED);
    const generatedLabel = new Date(meta.generatedAt).toLocaleString();
    this.doc.text(`Generado ${generatedLabel}  ·  Motor v${NYRAVA_REPORT_VERSION}`, cx, yy, {
      align: "center",
    });
    yy += 34;
    // Standing disclaimer, boxed for visual weight commensurate with what
    // it's saying — this should not read as fine print.
    const boxW = this.pageW - this.margin * 2 - 60;
    const boxX = cx - boxW / 2;
    const disclaimer =
      "Este reporte fue generado con Nyrava Intelligence\u2122 y busca apoyar \u2014no sustituir\u2014 el criterio jurídico profesional. El abogado es responsable de revisar y verificar todos los hallazgos, citas, puntajes, análisis jurídico y producto de trabajo contra el expediente oficial antes de presentarlo o sustentarse en él.";
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(9);
    const lines = this.doc.splitTextToSize(disclaimer, boxW - 24) as string[];
    const boxH = lines.length * 13 + 20;
    this.doc.setFillColor(248, 250, 252);
    this.doc.setDrawColor(...CARD_BORDER);
    this.doc.setLineWidth(0.75);
    this.doc.roundedRect(boxX, yy, boxW, boxH, 5, 5, "FD");
    this.doc.setTextColor(...PRIMARY);
    let ly = yy + 16;
    for (const line of lines) {
      this.doc.text(line, cx, ly, { align: "center" });
      ly += 13;
    }
  }

  save(filename: string, meta: { parity: string; ess: string; generatedAt: string } | null = null, validateOnly = false) {
    this.header();
    this.footer(meta);
    if (!this.finalPayload) throw new Error("REPORT_CONTRACT_UNAVAILABLE");
    const released = releaseRenderedReportOutput(this.finalPayload, "pdf", this.renderedText.join("\n"));
    if (!validateOnly) this.doc.save(filename);
    return released;
  }
}

// ===== Section renderers ==============================================

/**
 * Tallies findings by finding_type (DIRECT_EVIDENCE / EVIDENCE_BASED_INFERENCE
 * / AI_THEORY) for the Executive Dashboard's findings breakdown — see the
 * report-quality audit §4 comment where this is called. Pure and exported
 * for direct testing; never re-derives finding_type, only counts the value
 * already assigned at generation/gate time.
 */
export function computeFindingTypeCounts(
  findings: ReadonlyArray<Record<string, unknown>>,
): { direct: number; inference: number; theory: number } {
  return findings.reduce(
    (acc: { direct: number; inference: number; theory: number }, f) => {
      const t = asStr(f.finding_type);
      if (t === "DIRECT_EVIDENCE") acc.direct += 1;
      else if (t === "EVIDENCE_BASED_INFERENCE") acc.inference += 1;
      else if (t === "AI_THEORY") acc.theory += 1;
      return acc;
    },
    { direct: 0, inference: 0, theory: 0 },
  );
}

function renderCover(
  b: PdfBuilder,
  data: CaseExportData,
  mode: ReportMode,
  counters: { generated: number; verified: number; rendered: number },
): boolean {
  const c = asObj(data.case);
  const r = asObj(data.report);

  // --- Page 1: premium full-bleed cover with TrustBadge ---
  const identity = resolveReportIdentity(c);
  b.premiumCover({
    reportTitle: "INFORME DE INTELIGENCIA JURÍDICA",
    caseName: asStr(c.name, "Untitled Case"),
    client: identity.client,
    proceeding: translateLegalTerm(identity.proceedingType),
    matterType: translateLegalTerm(asStr(c.materia)),
    court: translateLegalTerm(asStr(c.court_name)),
    jurisdiction: translateLegalTerm(asStr(c.jurisdiction)),
    matterId: identity.caseNumber,
    classification: "CONFIDENCIAL",
    date: new Date().toLocaleDateString("es-MX"),
    engineVersion: translateLegalTerm(asStr(r.intelligence_version)),
    certification: deriveCertificationState(data),
  });

  // --- Page 2: executive dashboard (banner, gauges, findings, cards) ---
  b.pageBreak();

  // Section eyebrow so the dashboard reads as its own page, not orphaned
  // content following the cover.
  b.doc.setFont("helvetica", "bold");
  b.doc.setFontSize(9);
  b.doc.setTextColor(...ACCENT);
  b.doc.text("E X E C U T I V E   D A S H B O A R D", b.margin, b.y);
  b.y += 18;
  b.text(asStr(c.name, "Untitled Case"), { size: 20, bold: true, color: PRIMARY, gap: 4 });
  b.doc.setDrawColor(...ACCENT);
  b.doc.setLineWidth(1.5);
  b.doc.line(b.margin, b.y, b.margin + 60, b.y);
  b.y += 14;

  renderDecisionCore(b, data);

  // === Executive Intelligence Dashboard ===
  const scores = getScores(getReportRow(data));
  const hasScores =
    mode !== "LIMITED" && typeof scores.strength === "number" && typeof scores.risk === "number";

  if (hasScores) {
    const strength = scores.strength as number;
    const risk = scores.risk as number;

    const scoreObj = asObj(data.score);
    const breakdowns = asObj(scoreObj.dimension_breakdowns);
    const fullReport = asObj(r.full_report);
    const caseType = asStr(fullReport.case_type) || asStr(breakdowns.case_type) || "general_civil";
    // FIX (2026-07-29): this only checked the retired English case-type
    // keys ("criminal", "civil_rights") — never the actual Mexican
    // taxonomy key "penal" — so isCriminal was always false for every
    // real case in this platform, and the prosecution/defense framing
    // below never fired. Same class of bug found and fixed elsewhere
    // this session (practice-areas.ts's UNIVERSAL_FINDING_MODULES,
    // export.ts's own isCriminal check a few hundred lines down).
    const isCriminal =
      caseType === "penal" || caseType === "criminal" || caseType === "civil_rights";

    const riskLevel = risk >= 60 ? "Riesgo Alto" : risk >= 35 ? "Riesgo Moderado" : "Riesgo Bajo";
    const advantage = isCriminal
      ? strength < 50
        ? "Ventaja de la Defensa"
        : "Ventaja del Ministerio Público"
      : "";
    const headline = advantage ? `${riskLevel} — ${advantage}` : riskLevel;
    const strengthCaption = isCriminal
      ? `Fortaleza del caso ${strength} / 100 (caso del Ministerio Público; un valor menor favorece a la defensa)  ·  Puntuación de riesgo ${risk} / 100`
      : `Fortaleza del caso ${strength} / 100  ·  Puntuación de riesgo ${risk} / 100`;
    b.statusBanner(headline, strengthCaption, b.scoreColor(risk, true));

    b.gaugeRow([
      { label: "Fortaleza del Caso", value: strength, color: b.scoreColor(strength) },
      { label: "Puntuación de Riesgo", value: risk, color: b.scoreColor(risk, true) },
    ]);
  }

  // filterExecutiveDashboardEligible keeps a rejected/superseded lower-
  // instance holding (e.g. a Tribunal Colegiado position the SCJN's
  // ejecutoria revoked) out of the Executive Dashboard's Top Findings — a
  // no-op unless the extraction pass ran judicial-hierarchy attribution on
  // this case. See judicial-hierarchy.ts and ADR 5829/2025 for the bug.
  const findings = filterExecutiveDashboardEligible(data.findings ?? []);
  if (findings.length) {
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as Record<string, number>;
    const top = findings.slice(0, 5);
    b.h2(rt("Top Findings"));
    for (const f of top) {
      if (presentation(data).capability.mode === "LIMITED" || presentation(data).governance.decision_core_priority) {
        b.text(asStr(f.title), {size:11,bold:true,gap:4});
        b.text(asStr(f.speaker_role_label), {size:9,color:MUTED,gap:4});
      } else {
        b.findingChip(asStr(f.severity), asStr(f.title), Number(f.confidence ?? 0));
      }
    }
    b.y += 14;
  }

  const agentSummary = getAgentSummary(getReportRow(data));
  const cards: Array<{ label: string; value: string; color?: [number, number, number] }> = [];
  if (mode === "LIMITED") {
    cards.push({ label: "Status", value: "Limited", color: DANGER });
    cards.push({ label: "Scores", value: "Suppressed", color: MUTED });
    cards.push({ label: "Recommendations", value: "Suppressed", color: MUTED });
  }
  cards.push({ label: "Documents Analyzed", value: String(data.documents.length) });
  cards.push({ label: "Findings (Total)", value: String(counters.rendered) });
  // Report-quality audit §4: a single "Findings: N" number previously read
  // as if every finding carried the same evidentiary weight — the same
  // failure class as calling all of them "verified" regardless of whether
  // they're a directly-cited fact/holding, an inference drawn from cited
  // evidence, or an unsupported AI theory. Break the total down by
  // finding_type (already computed at generation/gate time — see
  // evidence-gate.server.ts's classifyFindingType — never re-derived here)
  // so the dashboard cannot imply a stronger evidentiary basis than what
  // was actually established.
  const findingTypeCounts = computeFindingTypeCounts(data.findings ?? []);
  if (findingTypeCounts.direct + findingTypeCounts.inference + findingTypeCounts.theory > 0) {
    cards.push({ label: "Direct Evidence", value: String(findingTypeCounts.direct), color: SUCCESS });
    cards.push({ label: "Evidence-Based Inference", value: String(findingTypeCounts.inference) });
    cards.push({ label: "AI Theory (Unverified)", value: String(findingTypeCounts.theory), color: MUTED });
  }
  const constitutionalCount = asArr(r.constitutional_issues_struct).length;
  if (constitutionalCount > 0)
    cards.push({
      label: "Constitutional Issues",
      value: String(constitutionalCount),
      color: DANGER,
    });
  const missingCount = asArr(r.missing_evidence_struct).length;
  if (missingCount > 0)
    cards.push({ label: "Missing Evidence", value: String(missingCount), color: ACCENT });
  if (agentSummary.loaded > 0) {
    cards.push({
      label: "Agents Producing Output",
      value: `${agentSummary.producingOutput} / ${agentSummary.loaded}`,
    });
  }
  if (r.intelligence_version)
    cards.push({ label: "Engine Version", value: asStr(r.intelligence_version) });

  b.statCards(cards, 4);

  // Cover metadata now lives on page 1; caller pageBreaks into the TOC.
  return false;
}

/**
 * Tailored missing-document checklist for LIMITED-mode reports, per branch
 * of Mexican law — replaces the old one-size-fits-all paragraph (which
 * listed pure US litigation documents: "pleadings, discovery responses,
 * deposition transcripts") with the actual document types a Mexican
 * attorney in that specific materia would recognize and need to gather.
 * Pulls from the SAME required_document_types data already used by the
 * admin Legal Coverage dashboard (mx-coverage.ts) — not a new taxonomy.
 */
function buildMissingDocumentChecklist(data: CaseExportData): { checklistText: string } {
  const locale = resolveReportLocale(data.report, data.case);
  const caseObj = (data.case ?? {}) as Record<string, unknown>;
  const caseType = String(caseObj.case_type ?? "");
  const analysisMode = String(caseObj.case_analysis_mode ?? "");
  const isConcludedAudit =
    analysisMode === "concluded_audit" ||
    analysisMode === "judgment_audit" ||
    analysisMode === "appeal_routes" ||
    caseObj.concluded_status === "concluded" ||
    data.documents.some((d) => /(sentencia|resolucion|ejecutoria|firmado|scjn|adr)/i.test(String(d.filename ?? "")));

  if (isConcludedAudit) {
    return {
      checklistText:
        locale === "en"
          ? "This report constitutes a legal audit of the supplied judicial resolution. The uploaded decision is self-sufficient for analyzing the court's holdings, reasoning, and operative rulings. Additional historical trial records are required only if reconstructing previous procedural phases."
          : "Este reporte constituye una auditoría jurídica de la resolución judicial aportada. La resolución es autosuficiente para el análisis de los criterios, razonamientos y puntos resolutivos del tribunal. Constancias adicionales del expediente histórico de origen sólo se requieren si se desea reconstruir las etapas procesales previas.",
    };
  }

  // apelación isn't in MX_DOMAINS (it's a procedural posture over whatever
  // the underlying matter is, not its own substantive practice area) — its
  // own document set is genuinely different from the domains list below.
  if (caseType === "appellate") {
    return {
      checklistText:
        locale === "en"
          ? "To upgrade this matter to a full analysis, supply: (1) the certified first-instance judgment (sentencia de primera instancia), (2) the brief of grounds of appeal (escrito de agravios), (3) certified copies of the trial-court record referenced in the judgment. Each additional verified source increases the ESS score and unlocks deterministic scoring."
          : "Para elevar este asunto a un análisis completo, aporte: (1) la sentencia de primera instancia certificada, (2) el escrito de agravios, (3) copias certificadas de las constancias del expediente de origen referidas en la sentencia. Cada fuente verificada adicional incrementa el puntaje ESS y habilita la evaluación determinista.",
    };
  }

  const domain = MX_DOMAINS.find((d) => d.base_area === caseType || d.code === caseType);
  if (!domain || domain.required_document_types.length === 0) {
    // Generic Mexican-appropriate fallback (still not US litigation terms)
    // for any case type not yet mapped into MX_DOMAINS.
    return {
      checklistText:
        locale === "en"
          ? "To upgrade this matter to a full analysis, supply additional primary sources: pleadings and their responses, notifications, contracts and amendments, expert opinions, and any documentary evidence referenced in the existing record. Each additional verified source increases the ESS score and unlocks deterministic scoring."
          : "Para elevar este asunto a un análisis completo, aporte fuentes primarias adicionales: promociones y sus contestaciones, notificaciones, contratos y convenios modificatorios, dictámenes periciales, y cualquier prueba documental referida en el expediente. Cada fuente verificada adicional incrementa el puntaje ESS y habilita la evaluación determinista.",
    };
  }

  const items = domain.required_document_types;
  const listEs = items.map((it, i) => `(${i + 1}) ${it}`).join(", ");
  const listEn = listEs; // document type names themselves stay in Spanish (they're proper Mexican legal document names) even in an English-language report
  return {
    checklistText:
      locale === "en"
        ? `To upgrade this matter to a full analysis, supply: ${listEn}, and any other documentary evidence referenced in the existing record. Each additional verified source increases the ESS score, unlocks deterministic scoring, and enables the engine to draft motion outlines with supporting citations.`
        : `Para elevar este asunto a un análisis completo, aporte: ${listEs}, y cualquier otra prueba documental referida en el expediente. Cada fuente verificada adicional incrementa el puntaje ESS, habilita la evaluación determinista, y permite al motor esbozar promociones con citas de apoyo.`,
  };
}

function jurisdictionIntelRows(data: CaseExportData): Array<[string, string]> {
  const c = asObj(data.case);
  const jp = asObj(c.jurisdiction_profile);
  const pc = asObj(c.procedural_compliance);
  const stageMap = asObj(pc.stage_map);
  const current = asObj(stageMap.current);
  const notDetermined = () => rt("Not determined");

  const country = asStr(jp.country) || "MX";
  const state = asStr(asObj(jp.state).name) || notDetermined();
  const materia = asStr(jp.materia) || asStr(c.case_type) || notDetermined();
  const procedure = asStr(jp.fuero) || notDetermined();
  const courts = asArr(jp.courts as unknown as Array<Record<string, unknown>>);
  const court =
    (Array.isArray(jp.courts) && (jp.courts as unknown[]).length > 0
      ? String((jp.courts as unknown[])[0])
      : "") || notDetermined();
  const substantive = Array.isArray(jp.substantive_codes)
    ? (jp.substantive_codes as unknown[])
    : [];
  const procedural = Array.isArray(jp.procedural_codes) ? (jp.procedural_codes as unknown[]) : [];
  const applicableLaw =
    [...substantive, ...procedural].map(String).filter(Boolean).join("; ") || notDetermined();
  const constitutional = Array.isArray(jp.constitutional_basis)
    ? (jp.constitutional_basis as unknown[])
    : [];
  const jurisprudence = constitutional.map(String).filter(Boolean).join("; ") || notDetermined();
  const currentStage =
    asStr(current.label_es) ||
    asStr(stageMap.next && asObj(stageMap.next).label_es) ||
    notDetermined();
  void courts;

  return [
    [rt("Country"), country],
    [rt("State"), state],
    [rt("Procedure"), procedure],
    [rt("Legal Area"), materia],
    [rt("Governing Court"), court],
    [rt("Applicable Law"), applicableLaw],
    [rt("Relevant Jurisprudence"), jurisprudence],
    [rt("Current Procedural Stage"), currentStage],
  ];
}

function renderJurisdictionIntelligence(b: PdfBuilder, data: CaseExportData) {
  b.h1("Inteligencia Jurisdiccional");
  b.table([[rt("Category"), rt("Description")]], jurisdictionIntelRows(data));
}

// Attorney Case Snapshot — the panel an attorney reads before the detailed
// analysis. Strengths, weaknesses, critical and missing evidence,
// procedural concerns and the suggested review order, all derived from
// verified findings and the real document inventory.
function snapshotBlocks(
  data: CaseExportData,
): Array<{ title: string; items: string[]; empty: string }> {
  const s = presentation(data).snapshot;
  return [
    {
      title: "Fortalezas del Expediente",
      items: s.strengths,
      empty:
        "No se identificaron hallazgos sustentados por dos o más documentos de alto valor probatorio.",
    },
    {
      title: "Debilidades del Expediente",
      items: s.weaknesses,
      empty: "No se identificaron hallazgos con soporte documental limitado.",
    },
    {
      title: "Evidencia Crítica",
      items: s.criticalEvidence,
      empty:
        "El corpus no contiene documentos públicos, resoluciones, documentos certificados ni dictámenes periciales.",
    },
    {
      title: "Evidencia Faltante",
      items: s.missingEvidence,
      empty: "No se detectó documentación faltante con base en el inventario actual.",
    },
    {
      title: "Aspectos Procesales a Vigilar",
      items: s.proceduralConcerns,
      empty: "No se identificaron hallazgos de naturaleza procesal.",
    },
    {
      title: "Orden de Revisión Prioritaria",
      items: s.priorityReview,
      empty: "No hay hallazgos priorizados.",
    },
  ];
}

function renderCaseSnapshot(b: PdfBuilder, data: CaseExportData) {
  b.h1("Instantánea del Expediente");
  b.text(
    "Panel de arranque para el abogado: resume, antes del análisis detallado, en qué se sostiene el expediente, " +
      "dónde es vulnerable, qué documentación falta y qué debe revisarse primero.",
    { size: 9.5, color: MUTED, gap: 8 },
  );
  for (const block of snapshotBlocks(data)) {
    b.h2(block.title);
    if (block.items.length) b.bullets(block.items);
    else b.text(block.empty, { size: 9.5, color: MUTED, gap: 4 });
  }
}

function renderExecutive(b: PdfBuilder, data: CaseExportData, mode: ReportMode) {
  const r = asObj(data.report);
  const execLocale = resolveReportLocale(data.report, data.case);
  b.h1(execLocale === "en" ? "Executive Summary" : "Resumen Ejecutivo");
  if (mode === "LIMITED") {
    const docCount = data.documents.length;
    const findingCount = (data.findings ?? []).length;
    b.text(
      execLocale === "en"
        ? "This case was analyzed in LIMITED mode because the available corpus did not meet the platform's Evidence Sufficiency Score (ESS) threshold required to support quantitative scoring or formal motion recommendations. " +
            `The intake included ${docCount} source document${docCount === 1 ? "" : "s"} and produced ${findingCount} finding${findingCount === 1 ? "" : "s"} of varying evidentiary strength — see each finding's own classification below rather than treating this count as a uniform "verified" total. ` +
            "An evidence-grounded narrative is rendered below for every section in which the corpus supplied sufficient verbatim material. Sections that would otherwise rely on inferred legal theories — quantitative scorecards, motion drafting, theory selection, and prioritized recommendations — have been withheld so that no claim in this report rests on speculation."
        : "Este expediente se analizó en modo LIMITADO porque el corpus disponible no alcanzó el umbral de Suficiencia Probatoria (ESS) requerido para sustentar puntajes cuantitativos o recomendaciones formales de promociones. " +
            `La ingesta incluyó ${docCount} documento(s) fuente y produjo ${findingCount} hallazgo(s) de fortaleza probatoria variable — consulte la clasificación de cada hallazgo en particular en lugar de interpretar esta cifra como un total "verificado" uniforme. ` +
            "A continuación se presenta una narrativa sustentada en evidencia para cada sección en la que el corpus aportó material textual suficiente. Las secciones que dependerían de teorías jurídicas inferidas — puntajes cuantitativos, redacción de promociones, selección de teoría del caso y recomendaciones priorizadas — se retuvieron para que ninguna afirmación de este reporte descanse en especulación.",
      { size: 11, gap: 8 },
    );
    const { checklistText } = buildMissingDocumentChecklist(data);
    b.text(checklistText, { size: 11, gap: 8 });
    b.text(
      execLocale === "en"
        ? "Every finding rendered below carries a quote independently verified against the source corpus, but a corpus this limited constrains what any individual finding can establish — confidence and severity have been capped accordingly, and no finding here should be treated as a confirmed determination without independent verification against the complete official record. The suppressions below are conservative by design — they protect the work product from hallucinated legal conclusions while preserving the verified factual record."
        : "Todo hallazgo presentado a continuación cita un pasaje verificado de forma independiente contra el corpus fuente, pero un corpus tan limitado condiciona lo que cualquier hallazgo individual puede establecer — la confianza y la severidad se han limitado en consecuencia, y ningún hallazgo de este reporte debe tratarse como una determinación confirmada sin verificación independiente contra el expediente oficial completo. Las supresiones siguientes son conservadoras por diseño: protegen el producto de trabajo frente a conclusiones jurídicas alucinadas y preservan el registro fáctico verificado.",
      { size: 11, gap: 8 },
    );
    return;
  }
  // Goal-first block — the report answers the attorney's primary question
  // before it summarises anything. Deterministic, evidence-only.
  const objective = asObj(asObj(r.full_report).objective) as Record<string, unknown>;
  if (asStr(objective.answer)) {
    b.h2(execLocale === "en" ? "Direct Answer" : "Respuesta Directa");
    b.text(asStr(objective.question), { size: 10, color: MUTED, gap: 4 });
    b.text(asStr(objective.answer), { size: 12, gap: 6 });
    const conf = asStr(objective.confidence);
    if (conf) {
      b.text(
        execLocale === "en"
          ? `Confidence in this answer: ${conf}.`
          : `Confianza en esta respuesta: ${conf}.`,
        { size: 10, color: MUTED, gap: 6 },
      );
    }
    const dps = Array.isArray(objective.decision_points) ? objective.decision_points : [];
    if (dps.length) {
      b.h2(execLocale === "en" ? "Decision Support" : "Soporte para la Decisión");
      for (const raw of dps.slice(0, 8)) {
        const dp = asObj(raw) as Record<string, unknown>;
        b.text(`• ${asStr(dp.issue)}`, { size: 11, gap: 2 });
        b.text(`${execLocale === "en" ? "Why it matters" : "Por qué importa"}: ${asStr(dp.why)}`, {
          size: 10,
          color: MUTED,
          gap: 2,
        });
        b.text(`${execLocale === "en" ? "Impact" : "Impacto"}: ${asStr(dp.impact)}`, {
          size: 10,
          color: MUTED,
          gap: 2,
        });
        b.text(
          `${execLocale === "en" ? "Next action" : "Siguiente acción"}: ${asStr(dp.next_action)}`,
          {
            size: 10,
            gap: 6,
          },
        );
      }
    }
  }

  const exec = reportText(data, "executive_summary") || reportText(data, "attorney_summary");
  if (exec) b.text(exec, { size: 11, gap: 8 });

  // Five questions an attorney must be able to answer within sixty seconds
  // of opening the file. Derived deterministically from the verified
  // findings and the actual document inventory.
  {
    const questions = presentation(data).executive_questions;
    b.h2("Lectura Rápida del Expediente");
    for (const q of questions) {
      b.text(q.question, { size: 10, bold: true, gap: 2 });
      b.text(q.answer, { size: 9.6, color: MUTED, gap: q.bullets?.length ? 2 : 6 });
      if (q.bullets?.length) {
        b.bullets(q.bullets);
        b.y += 4;
      }
    }
  }

  // Read scores through canonical.ts, not the raw row. getScores() also
  // honors ESS suppression, which r.case_strength_score alone does not.
  // Uses gaugeRow — the SAME circular gauge widget the cover page uses for
  // these identical two numbers — rather than the flatter meterPair bars.
  // Showing Case Strength / Risk Score as a bar chart here and a radial
  // gauge one page earlier was the exact "different sections feel like
  // separate documents" problem: same numbers, two different chart types,
  // one page apart.
  const scores = getScores(getReportRow(data));
  const gauges: Array<{ label: string; value: number; color: [number, number, number] }> = [];
  if (typeof scores.strength === "number")
    gauges.push({
      label: rt("Case Strength"),
      value: scores.strength,
      color: b.scoreColor(scores.strength),
    });
  if (typeof scores.risk === "number")
    gauges.push({
      label: rt("Risk Score"),
      value: scores.risk,
      color: b.scoreColor(scores.risk, true),
    });
  // Compact horizontal strip — the cover page already renders these same
  // numbers as prominent radial gauges. Repeating a second large radial
  // widget one page later was pure visual repetition; the compact strip
  // keeps the numbers visible without the duplication.
  b.compactScoreStrip(gauges);

  const ce = processProseCitations(asStr(r.score_breakdown));
  if (ce && typeof scores.strength === "number") {
    // score_breakdown is free-text prose written by an earlier scoring pass
    // and is not guaranteed to stay in sync with case_strength_score if the
    // deterministic scorecard is ever recalculated without a full narrative
    // regeneration. Guard against rendering a stale number (e.g. the report
    // showing "Case Strength: 60/100" and this prose separately saying
    // "the case score is 35") by refusing to print the prose verbatim if it
    // contains a different score than the live value.
    const mentionedScores = ce.match(/\bscore (?:is|of)\s+(\d{1,3})\b/i);
    const staleMismatch = mentionedScores && Number(mentionedScores[1]) !== scores.strength;
    if (staleMismatch) {
      b.h2("Razonamiento de la Puntuación");
      b.text(
        `Case strength is ${scores.strength} / 100. (Narrative reasoning for this score was not regenerated after ` +
          "the most recent scorecard update and has been withheld to avoid displaying a stale figure.)",
        { color: MUTED },
      );
    } else {
      b.h2("Razonamiento de la Puntuación");
      b.text(ce);
    }
  } else if (ce) {
    b.h2("Razonamiento de la Puntuación");
    b.text(ce);
  }
}

// The "money page." Ranked motions, immediate next actions, top strategic
// priorities, and generated-work-product readiness — the handful of things
// an attorney would actually act on today — pulled to the front of the
// report, ahead of the detailed analysis that supports them. Everything
// shown here is drawn verbatim from data that already exists elsewhere in
// the report (Strategic Opportunities, Strategy Synthesis, Attorney Work
// Product); this page never invents a number those sections don't have.
// Shared by renderRecommendedMotions and renderActionCenter's "Generated
// Work Product" list: the set of work-product rows eligible to be shown as
// "ready," honoring the same ESS motions-suppression gate as everywhere else.
function eligibleWorkProduct(data: CaseExportData): Array<Record<string, unknown>> {
  const r = asObj(data.report);
  const motionsSuppressed = Boolean(r.motions_suppressed);
  const workProductAll = data.work_product ?? [];
  const workProduct = motionsSuppressed
    ? workProductAll.filter((w) => asStr(w.document_type) === "case_summary")
    : workProductAll;
  const bodyOf = (w: Record<string, unknown>) => asStr(w.body_markdown) || asStr(w.content);
  return workProduct.filter((w) => bodyOf(w).trim().length > 40);
}

// Bucket a motion's raw `priority` number into the four labels attorneys
// scan for. 1 = Critical, 2 = High, everything else (3+, or missing) folds
// into "Additional" so the summary dashboard always adds up to the total
// count of recommended motions, regardless of how finely the model graded
// priority.
function motionPriorityBucket(m: Record<string, unknown>): {
  label: string;
  color: [number, number, number];
} {
  const p = Number(m.priority);
  if (p === 1) return { label: "CRITICAL", color: DANGER };
  if (p === 2) return { label: "HIGH", color: ACCENT };
  if (p === 3) return { label: "MEDIUM", color: ACCENT };
  return { label: "CONSIDER", color: MUTED };
}

// Likelihood in the source data is a qualitative low/medium/high estimate,
// not a numeric probability. Map it to a representative percentage so it
// can drive a real progress bar — the number is illustrative of the bucket,
// never presented as a precise model-computed probability.
function likelihoodPercent(m: Record<string, unknown>): {
  pct: number;
  bucket: "high" | "medium" | "low";
} {
  const raw = (asStr(m.likelihood_of_success) || asStr(m.likely_outcome)).toLowerCase();
  if (raw.includes("high")) return { pct: 85, bucket: "high" };
  if (raw.includes("low")) return { pct: 35, bucket: "low" };
  return { pct: 60, bucket: "medium" };
}

// Where a motion currently stands in the Motion Intelligence module. Never a
// hyperlink — just an honest status readout, derived from whether a matching
// work-product draft already exists for this motion.
function motionIntelligenceStatus(
  m: Record<string, unknown>,
  generatedWP: Array<Record<string, unknown>>,
): { label: string; color: [number, number, number] } {
  const title = asStr(m.motion).toLowerCase();
  const matched = generatedWP.some((w) => {
    const wTitle = (asStr(w.title) || asStr(w.document_type)).toLowerCase();
    return title && wTitle && (wTitle.includes(title) || title.includes(wTitle));
  });
  if (matched) return { label: "Ready in Motion Intelligence", color: SUCCESS };
  if (asStr(m.draft_outline).trim().length > 40) return { label: "Draft Available", color: ACCENT };
  if (asArr(m.elements).length || asStr(m.legal_rationale))
    return { label: "Requires Attorney Review", color: MUTED };
  return { label: "Not Yet Generated", color: MUTED };
}

// Evidence bullets for a motion card: prefer real pinpoint citations, fall
// back to the supporting-facts prose, then the legal elements — always the
// most concrete thing available, never invented.
function motionEvidenceBullets(m: Record<string, unknown>): string[] {
  const cites = asArr(m.citations);
  if (cites.length) {
    return cites
      .slice(0, 4)
      .map((c) => {
        const quote = asStr(c.quote).trim();
        const label = citeLabel(c.doc_n, c.page);
        return quote
          ? `"${quote.slice(0, 140)}${quote.length > 140 ? "…" : ""}" — ${label}`
          : label;
      })
      .filter(Boolean);
  }
  const facts = asStr(m.supporting_facts).trim();
  if (facts) return [facts.slice(0, 200)];
  return asArr(m.elements)
    .map((e) => asStr(e))
    .filter(Boolean)
    .slice(0, 4);
}

// The signature feature of the report: a dedicated, highly visible
// "Recommended Motions" section immediately after the Executive Summary.
// Every motion the engine surfaced is rendered as its own card — priority
// badge, likelihood bar, reason, evidence, legal basis, and Motion
// Intelligence status — so an attorney can identify the strongest motions
// in seconds, without reading paragraphs of prose. Drafting/editing still
// happens in the Motion Intelligence module; this section only tells the
// attorney what exists and why it matters.
function renderRecommendedMotions(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  if (asStr(asObj(data.case).case_analysis_mode) === "concluded_audit") return;
  const motionsSuppressed = Boolean(r.motions_suppressed);
  const motions = motionsSuppressed ? [] : asArr(r.motion_opportunities);
  if (!motions.length) return;

  const generatedWP = eligibleWorkProduct(data);
  const rank = (m: Record<string, unknown>) => {
    const p = Number(m.priority);
    return Number.isFinite(p) ? p : 99;
  };
  const ranked = [...motions].sort((ma, mb) => rank(ma) - rank(mb));

  b.h1("Promociones Recomendadas");
  b.text(
    "Las promociones con mayor probabilidad de fortalecer este caso, ordenadas por prioridad. La redacción y edición continúan en el módulo de Inteligencia de Promociones.",
    { size: 10, color: MUTED, gap: 10 },
  );

  // ---- Motion Summary Dashboard ----
  const critical = ranked.filter((m) => motionPriorityBucket(m).label === "CRITICAL").length;
  const high = ranked.filter((m) => motionPriorityBucket(m).label === "HIGH").length;
  const additional = ranked.length - critical - high;
  const stats: Array<{ label: string; value: number; color: [number, number, number] }> = [
    { label: "Critical", value: critical, color: DANGER },
    { label: "High Priority", value: high, color: ACCENT },
    { label: "Additional", value: additional, color: MUTED },
  ];
  const dashH = 58;
  b.ensureSpace(dashH + 14);
  b.doc.setFillColor(248, 250, 252);
  b.doc.setDrawColor(...CARD_BORDER);
  b.doc.setLineWidth(1);
  b.doc.roundedRect(b.margin, b.y - 14, b.pageW - b.margin * 2, dashH, 6, 6, "FD");
  const colW = (b.pageW - b.margin * 2) / (stats.length + 1);
  stats.forEach((s, i) => {
    const cx = b.margin + colW * i + colW / 2;
    b.doc.setFont("helvetica", "bold");
    b.doc.setFontSize(22);
    b.doc.setTextColor(...s.color);
    b.doc.text(String(s.value), cx, b.y + 10, { align: "center" });
    b.doc.setFont("helvetica", "normal");
    b.doc.setFontSize(9);
    b.doc.setTextColor(...MUTED);
    b.doc.text(s.label.toUpperCase(), cx, b.y + 26, { align: "center" });
  });
  const totalCx = b.margin + colW * stats.length + colW / 2;
  b.doc.setFont("helvetica", "bold");
  b.doc.setFontSize(22);
  b.doc.setTextColor(...PRIMARY);
  b.doc.text(String(ranked.length), totalCx, b.y + 10, { align: "center" });
  b.doc.setFont("helvetica", "normal");
  b.doc.setFontSize(9);
  b.doc.setTextColor(...MUTED);
  b.doc.text("TOTAL RECOMMENDED", totalCx, b.y + 26, { align: "center" });
  b.y += dashH + 16;

  // ---- Motion cards ----
  for (const [idx, m] of ranked.entries()) {
    if (idx > 0) b.y += 10;
    const evidence = motionEvidenceBullets(m);
    const reason = asStr(m.basis) || asStr(m.legal_rationale);
    const legalBasis = asArr(m.elements)
      .map((e) => asStr(e))
      .filter(Boolean);
    const status = motionIntelligenceStatus(m, generatedWP);
    const { pct, bucket } = likelihoodPercent(m);
    const barColor = bucket === "high" ? SUCCESS : bucket === "low" ? DANGER : ACCENT;

    // Measure the card's full height up front so it never splits across a
    // page boundary partway through a motion.
    b.doc.setFont("helvetica", "bold");
    b.doc.setFontSize(13);
    const titleLines = b.doc.splitTextToSize(
      asStr(m.motion),
      b.pageW - b.margin * 2 - 100,
    ) as string[];
    let cardH = 20 + titleLines.length * 15 + 30; // title + likelihood bar
    if (reason) cardH += b.measureTextHeight(reason, 9.5, 8) + 14;
    if (evidence.length) cardH += 14 + evidence.length * 12 + 10;
    if (legalBasis.length) cardH += 14 + 12 + 10;
    cardH += 24; // status row + padding

    b.ensureSpace(cardH);
    const cardTop = b.y - 14;
    const cardX = b.margin;
    const cardW = b.pageW - b.margin * 2;
    b.doc.setFillColor(255, 255, 255);
    b.doc.setDrawColor(...CARD_BORDER);
    b.doc.setLineWidth(1);
    b.doc.roundedRect(cardX, cardTop, cardW, cardH, 6, 6, "FD");
    const accent = motionPriorityBucket(m).color;
    b.doc.setFillColor(...accent);
    b.doc.roundedRect(cardX, cardTop, 4, cardH, 2, 2, "F");

    const padX = cardX + 16;
    b.y = cardTop + 22;
    b.doc.setFont("helvetica", "bold");
    b.doc.setFontSize(13);
    b.doc.setTextColor(...PRIMARY);
    b.doc.text(`${idx + 1}. ${titleLines[0] ?? ""}`, padX, b.y);
    const bucketInfo = motionPriorityBucket(m);
    b.pill(`Priority: ${bucketInfo.label}`, cardX + cardW - 16, b.y - 4, bucketInfo.color, "right");
    b.y += 15;
    for (const extra of titleLines.slice(1)) {
      b.doc.text(extra, padX, b.y);
      b.y += 15;
    }

    // Likelihood of Success bar.
    b.doc.setFont("helvetica", "normal");
    b.doc.setFontSize(8.5);
    b.doc.setTextColor(...MUTED);
    b.doc.text("LIKELIHOOD OF SUCCESS", padX, b.y);
    b.doc.setFont("helvetica", "bold");
    b.doc.setFontSize(9);
    b.doc.setTextColor(...barColor);
    b.doc.text(`${pct}%`, cardX + cardW - 16, b.y, { align: "right" });
    b.y += 6;
    const barX = padX;
    const barW = cardW - 32;
    b.doc.setFillColor(...CARD_BORDER);
    b.doc.roundedRect(barX, b.y, barW, 7, 3, 3, "F");
    b.doc.setFillColor(...barColor);
    b.doc.roundedRect(barX, b.y, Math.max(barW * (pct / 100), 8), 7, 3, 3, "F");
    b.y += 20;

    if (reason) {
      b.doc.setFont("helvetica", "bold");
      b.doc.setFontSize(9);
      b.doc.setTextColor(...PRIMARY);
      b.doc.text(rt("REASON"), padX, b.y);
      b.y += 12;
      const reasonLines = b.doc.splitTextToSize(reason, cardW - 32) as string[];
      b.doc.setFont("helvetica", "normal");
      b.doc.setFontSize(9.5);
      b.doc.setTextColor(...MUTED);
      for (const line of reasonLines) {
        b.doc.text(line, padX, b.y);
        b.y += 12;
      }
      b.y += 4;
    }

    if (evidence.length) {
      b.doc.setFont("helvetica", "bold");
      b.doc.setFontSize(9);
      b.doc.setTextColor(...PRIMARY);
      b.doc.text(rt("PRIMARY EVIDENCE"), padX, b.y);
      b.y += 12;
      b.doc.setFont("helvetica", "normal");
      b.doc.setFontSize(9);
      b.doc.setTextColor(...MUTED);
      for (const ev of evidence) {
        const lines = b.doc.splitTextToSize(`•  ${ev}`, cardW - 32) as string[];
        for (const line of lines) {
          b.doc.text(line, padX, b.y);
          b.y += 12;
        }
      }
      b.y += 4;
    }

    if (legalBasis.length) {
      b.doc.setFont("helvetica", "bold");
      b.doc.setFontSize(9);
      b.doc.setTextColor(...PRIMARY);
      b.doc.text(rt("LEGAL BASIS"), padX, b.y);
      b.y += 12;
      b.doc.setFont("helvetica", "normal");
      b.doc.setFontSize(9);
      b.doc.setTextColor(...MUTED);
      const basisLine = legalBasis.join("  •  ");
      const lines = b.doc.splitTextToSize(basisLine, cardW - 32) as string[];
      for (const line of lines) {
        b.doc.text(line, padX, b.y);
        b.y += 12;
      }
      b.y += 4;
    }

    // Status row, pinned to the card's bottom edge.
    const statusY = cardTop + cardH - 12;
    b.doc.setFont("helvetica", "normal");
    b.doc.setFontSize(8.5);
    b.doc.setTextColor(...MUTED);
    b.doc.text(rt("STATUS"), padX, statusY);
    b.pill(status.label, cardX + cardW - 16, statusY - 5, status.color, "right");

    b.y = cardTop + cardH + 4;
  }
}

function priorityBadgeColor(priority: string): [number, number, number] {
  const p = priority.toLowerCase();
  if (p === "critical") return DANGER;
  if (p === "high") return ACCENT;
  return MUTED;
}

function renderActionCenter(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  const full = asObj(r.full_report);
  // Canonical, deduplicated recommendation list (see
  // src/lib/intelligence/report-recommendations.ts) — present on reports
  // generated after canonical recommendation merging. Older reports must
  // regenerate; raw finding actions are not an alternative authority.
  const canonicalRecs = asArr(full.canonical_recommendations);
  const useCanonical = canonicalRecs.length > 0;
  const generatedWP = eligibleWorkProduct(data);

  const hasAnyContent = canonicalRecs.length > 0 || generatedWP.length > 0;
  if (!hasAnyContent) return;

  b.h1("Centro de Acción del Abogado");
  b.text(
    "Próximas acciones inmediatas y prioridades estratégicas, antes del análisis detallado que las sustenta.",
    {
      size: 10,
      color: MUTED,
      gap: 10,
    },
  );

  if (useCanonical) {
    // Single merged list, already deduplicated and priority-sorted — this
    // replaces what used to be two separately-generated lists
    // ("Immediate Recommended Actions" from next_actions, "Strategic
    // Priorities" from strategy_recommendations) that frequently repeated
    // each other. Rendering them from the same canonical source here would
    // just reproduce that duplication under two headers, so when the
    // canonical list is available it is shown once.
    b.h2("Acciones Recomendadas");
    for (const c of canonicalRecs) {
      const title = asStr(c.title);
      const reason = asStr(c.reason);
      b.doc.setFont("helvetica", "bold");
      b.doc.setFontSize(10.5);
      const titleLines = b.doc.splitTextToSize(title, b.pageW - b.margin * 2 - 90) as string[];
      const showReason = reason && reason !== title;
      const itemHeight =
        15 * titleLines.length + (showReason ? b.measureTextHeight(reason, 9, 6) : 0) + 6;
      b.ensureSpace(itemHeight);
      b.doc.setDrawColor(...ACCENT);
      b.doc.setLineWidth(1.2);
      b.doc.rect(b.margin, b.y - 9, 8, 8, "S");
      b.doc.setFont("helvetica", "bold");
      b.doc.setFontSize(10.5);
      b.doc.setTextColor(...PRIMARY);
      b.doc.text(titleLines[0] ?? "", b.margin + 16, b.y);
      b.pill(
        asStr(c.priority, "medium").toUpperCase(),
        b.pageW - b.margin,
        b.y + 1,
        priorityBadgeColor(asStr(c.priority)),
        "right",
      );
      b.y += 15;
      for (const extra of titleLines.slice(1)) {
        b.doc.text(extra, b.margin + 16, b.y);
        b.y += 14;
      }
      if (showReason) b.text(reason, { size: 9.5, color: MUTED, gap: 6 });
      b.y += 10;
    }
  }

  if (generatedWP.length) {
    b.h2("Producto de Trabajo Generado");
    b.text(
      "Listo para revisión del abogado — los borradores completos aparecen más adelante en este reporte.",
      {
        size: 9,
        color: MUTED,
        gap: 6,
      },
    );
    for (const w of generatedWP) {
      b.ensureSpace(18);
      b.doc.setFont("helvetica", "normal");
      b.doc.setFontSize(10);
      b.doc.setTextColor(...PRIMARY);
      b.doc.text(
        asStr(w.title, asStr(w.document_type, "Work product")).slice(0, 70),
        b.margin,
        b.y,
      );
      b.pill("Ready", b.pageW - b.margin, b.y + 1, SUCCESS, "right");
      b.y += 18;
    }
  }
}

// ---- Litigation Impact Dashboard ---------------------------------------
// Renders the SAME cards `buildLitigationImpactDashboard()` produces for
// the in-app Report tab. Deliberately terse — one line per card via
// statCards() — rather than repeating each dimension's full contributor
// breakdown, which is already covered in more depth by the "Dimension
// Detail" subsection of Case Scorecard later in this document. Showing it
// twice would reintroduce the exact redundancy renderScorecard's own
// comments describe removing once already (bare numbers vs. bars).
function impactTierColor(b: PdfBuilder, tier: ImpactCard["tier"]): [number, number, number] {
  const word =
    tier === "critical"
      ? "critical"
      : tier === "high"
        ? "high"
        : tier === "moderate"
          ? "medium"
          : "low";
  return b.severityColor(word);
}

const IMPACT_DASHBOARD_NOTE =
  "Starting point, not a finished answer. Verify anything you plan to rely on with Case AI, pull controlling authority in Case Law, and confirm the actual filing through Motion Drafting before treating this as ready.";

function renderLitigationImpactDashboard(b: PdfBuilder, data: CaseExportData) {
  const reportRow = (data.report ?? {}) as Record<string, unknown>;
  const dashboard = buildLitigationImpactDashboard(reportRow);
  if (asStr(asObj(data.case).case_analysis_mode) === "concluded_audit") dashboard.cards = dashboard.cards.filter((card) => card.id !== "top_motion");
  if (dashboard.suppressed || dashboard.cards.length === 0) return;

  b.h1("Panel de Impacto Litigioso");
  b.text(
    "A case-type read on the deterministic scorecard below, framed as the questions an attorney asks first rather than as raw dimension names.",
    { size: 9.5, color: MUTED, gap: 10 },
  );
  b.statCards(
    dashboard.cards.map((c) => ({
      label: c.title,
      value: `${c.badge} - ${c.value}`,
      color: impactTierColor(b, c.tier),
    })),
    3,
  );
  b.y += 10;
  b.text(IMPACT_DASHBOARD_NOTE, { size: 8, color: MUTED, gap: 4 });
}

function exportHasNoPersonalNoticeDuty(data: CaseExportData): boolean {
  return (data.findings ?? []).some((f) => {
    const evidence = [asStr(f.source_quote), JSON.stringify(f.evidence_refs ?? []), JSON.stringify(f.metadata ?? {})].join(" ");
    return /(?:no\s+exist[ií]a|no\s+(?:era|es|resultaba|fue)\s+necesari[oa]|no\s+hab[ií]a)\b[^.!?]{0,160}(?:deber|obligaci[oó]n|necesidad)?[^.!?]{0,120}notific[^.!?]{0,80}personal/i.test(evidence);
  });
}

function scrubExportPostureInversion(data: CaseExportData, text: string): string {
  if (!text || !exportHasNoPersonalNoticeDuty(data)) return text;
  return text.split(/(?<=[.!?])\s+|\n+/g).filter((part) => {
    const value = part.trim();
    if (!/notific[^.!?]{0,100}personal/i.test(value)) return true;
    return !/(defectu|irregular|error|nulidad|invalid|afect|procedencia|desestim|debilidad|riesgo|perjuicio|necesaria|necesario)/i.test(value);
  }).join(" ").replace(/\s{2,}/g, " ").trim();
}

function canonicalTimelineText(data: CaseExportData): string {
  return getTimeline(getReportRow(data)).slice(0, 24).map((ev) => {
    const date = asStr(ev.date) || asStr(ev.date_raw);
    const event = asStr(ev.event) || asStr(ev.description);
    return date && event ? `${date}: ${event}` : event || date;
  }).filter(Boolean).join("\n");
}

function reportText(data: CaseExportData, key: string): string {
  if (key === "timeline_summary") {
    const canonical = canonicalTimelineText(data);
    if (canonical) return processProseCitations(canonical);
  }
  const r = asObj(data.report);
  const full = asObj(r.full_report);
  const prose = asObj(full.prose);
  const raw = asStr(r[key]) || asStr(prose[key]) || asStr(full[key]);
  return processProseCitations(scrubExportPostureInversion(data, raw));
}

function fallbackOverview(data: CaseExportData): string {
  const c = asObj(data.case);
  const docs = data.documents.map((d) => asStr(d.filename)).filter(Boolean);
  const topFindings = (data.findings ?? [])
    .slice(0, 5)
    .map((f) => asStr(f.title))
    .filter(Boolean);
  return [
    `Caso: ${asStr(c.name, "Caso sin título")}.`,
    docs.length
      ? `Documentos fuente revisados: ${docs.join(", ")}.`
      : "No se adjuntaron documentos fuente a esta exportación.",
    topFindings.length
      ? `Principales cuestiones verificadas identificadas: ${topFindings.join("; ")}.`
      : "No había hallazgos verificados disponibles al momento de la exportación.",
  ].join(" ");
}

function renderCaseOverview(b: PdfBuilder, data: CaseExportData) {
  const overview =
    reportText(data, "case_overview") ||
    reportText(data, "attorney_summary") ||
    fallbackOverview(data);
  b.h1("Panorama General del Expediente");
  b.text(overview, { size: 11, gap: 8 });
}

// Extract a sortable date from a finding's text, falling back to null when
// no date is present. Used to chronologically order the facts narrative.
function extractDate(s: string): { iso: string; display: string } | null {
  if (!s) return null;
  // ISO: 2024-03-15 or 2024/03/15
  const iso = s.match(/\b(20\d{2}|19\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) {
    const m = String(iso[2]).padStart(2, "0"),
      d = String(iso[3]).padStart(2, "0");
    return { iso: `${iso[1]}-${m}-${d}`, display: `${iso[1]}-${m}-${d}` };
  }
  // US: 03/15/2024 or 3-15-24
  const us = s.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (us) {
    let y = us[3];
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? "19" : "20") + y;
    const m = String(us[1]).padStart(2, "0"),
      d = String(us[2]).padStart(2, "0");
    return { iso: `${y}-${m}-${d}`, display: `${us[1]}/${us[2]}/${y}` };
  }
  // Month-name: January 15, 2024
  const mn = s.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  );
  if (mn) {
    const months: Record<string, string> = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    const key = mn[1].toLowerCase().slice(0, 3);
    const m = months[key] || "01";
    const d = String(mn[2]).padStart(2, "0");
    return { iso: `${mn[3]}-${m}-${d}`, display: `${mn[1]} ${mn[2]}, ${mn[3]}` };
  }
  return null;
}

function renderFacts(b: PdfBuilder, data: CaseExportData) {
  const facts = reportText(data, "facts");
  b.h1("Hechos", "Relato Fáctico");

  // Always lead with the LLM-authored facts narrative when present.
  if (facts && facts.trim().length > 0) {
    b.text(facts, { size: 10.5, gap: 8 });
  }

  // Build a chronological narrative from verified findings. Even when the
  // LLM narrative exists, the dated synthesis is useful as a structured
  // companion timeline of the underlying events.
  const findings = data.findings ?? [];
  const dated: Array<{ iso: string; display: string; title: string; desc: string }> = [];
  const undated: Array<{ title: string; desc: string }> = [];
  for (const f of findings) {
    const title = asStr(f.title);
    const desc = asStr(f.description);
    if (!title && !desc) continue;
    const found = extractDate(`${title} ${desc}`);
    if (found) {
      dated.push({ iso: found.iso, display: found.display, title, desc });
    } else {
      undated.push({ title, desc });
    }
  }
  dated.sort((a, c) => a.iso.localeCompare(c.iso));

  if (dated.length) {
    b.h2("Narrativa Cronológica");
    b.text(
      "Los siguientes eventos se reconstruyen a partir del registro verificado, ordenados por la fecha más temprana asociada a cada hallazgo. Cada párrafo integra la evidencia subyacente en una narrativa fáctica continua apta para uso en memorandos.",
      { size: 10, color: MUTED, gap: 8 },
    );
    for (const ev of dated) {
      b.factCard(ev.display, ev.title, ev.desc);
    }
  }

  if (undated.length && !facts) {
    b.h2("Hechos Adicionales Verificados (Sin Fecha)");
    b.text(
      "Los siguientes hechos verificados no pudieron ubicarse en la línea de tiempo porque la cita de origen no tiene una fecha asociada. Forman parte del registro acreditado y deben considerarse junto con la narrativa cronológica anterior.",
      { size: 10, color: MUTED, gap: 6 },
    );
    for (const u of undated.slice(0, 20)) {
      b.factCard("", u.title, u.desc);
    }
  }

  if (!facts && !dated.length && !undated.length) {
    b.text(
      "No se extrajeron hechos verificados del corpus disponible. Esto normalmente indica que los documentos fuente carecían de declaraciones citables y ancladas a un documento, necesarias para construir un registro fáctico fundado en evidencia. Para habilitar una narrativa de hechos, adjunte fuentes primarias con afirmaciones fácticas concretas — escritos, correspondencia contemporánea, contratos, transcripciones, declaraciones o informes firmados — para que la capa de extracción pueda anclar cada hecho a una cita textual y a la página correspondiente.",
      { size: 10.5, gap: 8 },
    );
  }
}

function renderTimelineSummary(b: PdfBuilder, data: CaseExportData) {
  const timeline = reportText(data, "timeline_summary");
  const timelineFindings = (data.findings ?? [])
    .filter((f) =>
      /timeline|date|deadline|filing|service|procedural/i.test(
        `${asStr(f.category)} ${asStr(f.title)}`,
      ),
    )
    .slice(0, 10)
    .map((f) => `${asStr(f.title)} — ${asStr(f.description).slice(0, 220)}`);
  b.h1("Resumen Cronológico");
  if (timeline) b.text(timeline, { size: 10.5, gap: 8 });
  else if (timelineFindings.length) b.bullets(timelineFindings);
  else
    b.text("No se extrajeron eventos cronológicos fechados del acervo disponible.", {
      size: 10,
      color: MUTED,
    });
}

function renderDiscoveryAnalysis(b: PdfBuilder, data: CaseExportData) {
  const discovery =
    reportText(data, "discovery_analysis") || reportText(data, "missing_evidence_report");
  const r = asObj(data.report);
  const missing = asArr(r.missing_evidence_struct);
  // FIX (2026-07-29): this heading rendered literally as "Discovery
  // Analysis" in the exported PDF — the one U.S. artifact confirmed
  // to reach the actual downloadable document, not just an internal UI
  // label. Matches the Spanish heading already used for this exact
  // concept in the main branded report template.
  b.h1("Análisis de Vacíos Probatorios");
  if (discovery) b.text(discovery, { size: 10.5, gap: 8 });
  if (missing.length) {
    b.h2("Evidencia Faltante o Necesaria");
    b.table(
      [["Elemento", "Gravedad", "Cómo obtenerla / por qué es crítica"]],
      missing.map((m) => [
        asStr(m.item).slice(0, 70),
        asStr(m.severity, "—"),
        (asStr(m.how_to_obtain) || asStr(m.why_critical)).slice(0, 120),
      ]),
    );
  }
  if (!discovery && !missing.length) {
    b.text("No se identificaron vacíos probatorios verificados en los documentos proporcionados.", {
      size: 10,
      color: MUTED,
    });
  }
}

function renderRiskAnalysis(b: PdfBuilder, data: CaseExportData) {
  const risk = reportText(data, "risk_analysis") || reportText(data, "score_breakdown");
  const r = asObj(data.report);
  const canonicalRisk = getScores(getReportRow(data)).risk;
  b.h1("Análisis de Riesgo");
  if (typeof canonicalRisk === "number" && !r.scores_suppressed) {
    // Compact score strip — the risk score is already displayed as a
    // prominent radial gauge on the cover page. A second large radial
    // repeat here creates visual repetition; the strip preserves the
    // number and its color coding without another full-height widget.
    b.compactScoreStrip([
      {
        label: rt("Risk Score"),
        value: canonicalRisk,
        color: b.scoreColor(canonicalRisk, true),
      },
    ]);
  }
  if (risk) b.text(risk, { size: 10.5, gap: 8 });
  else
    b.text(
      "El análisis de riesgo se limita a los hallazgos verificados y a la cobertura documental mostrada en este reporte.",
      {
        size: 10,
        color: MUTED,
      },
    );
}

function renderRecommendationsNarrative(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  const full = asObj(r.full_report);
  const canonicalRecs = asArr(full.canonical_recommendations);

  b.h1("Recomendaciones");

  if (canonicalRecs.length) {
    // The canonical list already merges what used to be rendered here as
    // three separate, overlapping structures: the free-form narrative
    // paragraph, the "Strategic recommendations" bullets, and the "Next
    // actions" table. All three were independently-generated restatements
    // of the same underlying recommendations, so once the merged list is
    // available it replaces all three rather than sitting alongside them.
    const order = ["critical", "high", "medium", "low"];
    const grouped = order
      .map((p) => ({
        p,
        items: canonicalRecs.filter((c) => asStr(c.priority, "medium").toLowerCase() === p),
      }))
      .filter((g) => g.items.length > 0);
    for (const g of grouped) {
      b.h2(`${g.p.charAt(0).toUpperCase()}${g.p.slice(1)} priority`);
      b.bullets(
        g.items.map((c) => {
          const title = asStr(c.title);
          const reason = asStr(c.reason);
          return reason && reason !== title ? `${title} — ${reason.slice(0, 180)}` : title;
        }),
      );
    }
    return;
  }

  // Pre-canonical reports require regeneration; no raw-action fallback.
}

function renderCrossExamination(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  // Only render from a genuine cross-examination plan (topic-organized
  // questions, impeachment ties, citations). There used to be a fallback
  // here that rebuilt an equivalent structure straight from
  // data.witnesses.cross_exam_questions whenever no real plan existed — but
  // that is the exact same array "Witness Intelligence" already prints in
  // full for every witness, so the fallback never added information; it
  // just reproduced that section's content verbatim under a second heading.
  // Better to omit this section than duplicate one already on the page.
  const rows = asArr(r.cross_examination);
  if (!rows.length) return;
  b.h1("Contrainterrogatorio");
  for (const p of rows) {
    b.h3(asStr(p.witness, "Witness"));
    if (p.objective) b.text(`Objective: ${asStr(p.objective)}`, { size: 10, gap: 4 });
    const lines = asArr(p.lines);
    for (const line of lines) {
      b.text(asStr(line.topic, "Question line"), { size: 9, bold: true, color: ACCENT });
      const qs = Array.isArray(line.questions) ? (line.questions as string[]) : [];
      if (qs.length) b.bullets(qs.slice(0, 10));
      if (line.impeachment_with)
        b.text(`Impeachment with: ${asStr(line.impeachment_with)}`, { size: 9, color: DANGER });
      const citation = asObj(line.citation);
      if (Object.keys(citation).length) {
        b.text(
          `Citation: "${asStr(citation.quote).slice(0, 180)}" — ${citeLabel(citation.doc_n, citation.page)}`,
          {
            size: 9,
            color: MUTED,
            gap: 4,
          },
        );
      }
    }
  }
}

function renderScorecard(b: PdfBuilder, data: CaseExportData) {
  const score = asObj(data.score);
  const breakdowns = asObj(score.dimension_breakdowns);
  const det = asObj(breakdowns.deterministic);
  const dimensions = asObj(det.dimensions);
  const report = asObj(data.report);
  const fullReport = asObj(report.full_report);
  const caseType =
    asStr(fullReport.case_type) || asStr(asObj(breakdowns).case_type) || "general_civil";
  const isCriminal = caseType === "penal" || caseType === "criminal" || caseType === "civil_rights";

  if (Object.keys(dimensions).length === 0 && !Object.keys(score).length) return;
  b.h1("Tablero de Puntuación del Caso");
  b.text(asStr(score.methodology, "Puntuación determinista basada en reglas."), {
    size: 10,
    color: MUTED,
    gap: 4,
  });
  b.text(`Tipo de caso: ${caseType.replace(/_/g, " ")}`, { size: 9, color: MUTED, gap: 10 });
  const rows: (string | number)[][] = [];
  for (const [, val] of Object.entries(dimensions)) {
    const v = asObj(val);
    rows.push([
      asStr(v.dimension),
      `${asStr(v.score, "—")} / 100`,
      asStr(v.baseline, "—"),
      `${asStr(v.raw_delta, "0")}`,
      asStr(v.contributor_count, "0"),
    ]);
  }
  if (rows.length) {
    // Deliberately no plain-number table here: the Dimension Detail section
    // below renders these exact same dimensions as color-coded bars, and
    // showing both was pure redundancy (the reader had to parse the same
    // nine numbers twice — once as a bare table, once as bars). The bar
    // version is strictly more scannable, so it's now the single canonical
    // view of dimension scores.
  } else {
    // Fallback to legacy fields — gated by case type so civil reports never
    // show "Cadena de Custodia", "Cumplimiento Constitucional", "Riesgo de
    // Condena" or "Riesgo de Apelación".
    const legacy: [string, unknown][] = isCriminal
      ? [
          ["Fortaleza de la evidencia", score.evidence_strength],
          ["Confiabilidad de testigos", score.witness_reliability],
          ["Integridad cronológica", score.timeline_integrity],
          ["Cadena de custodia", score.chain_of_custody],
          ["Cumplimiento constitucional", score.constitutional_compliance],
          ["Integridad de la investigación", score.investigation_completeness],
          ["Riesgo de condena", score.conviction_risk],
          ["Riesgo de apelación", score.appeal_risk],
        ]
      : [
          ["Fortaleza de la evidencia", score.evidence_strength],
          ["Confiabilidad de testigos", score.witness_reliability],
          ["Integridad cronológica", score.timeline_integrity],
          [
            "Confiabilidad documental",
            (score as Record<string, unknown>).documentation_reliability,
          ],
          ["Cumplimiento probatorio", (score as Record<string, unknown>).discovery_compliance],
          ["Integridad de la investigación", score.investigation_completeness],
          ["Riesgo litigioso", (score as Record<string, unknown>).litigation_risk],
        ];
    b.table(
      [["Dimensión", "Puntuación"]],
      legacy.filter(([, v]) => typeof v === "number").map(([k, v]) => [k, `${v} / 100`]),
    );
  }
  // Per-dimension breakdown. The scoring formula is identical for every
  // dimension, so state it once here instead of repeating it under each
  // one — that repetition was the main thing making this section read as
  // a wall of text. Each dimension then gets a single scannable bar row
  // plus (at most) a one-line summary of what moved the score, rather
  // than a full 3-column table per dimension.
  const dimEntries = Object.entries(dimensions);
  if (dimEntries.length) {
    b.h2("Detalle por Dimensión");
    const firstFormula = asStr(asObj(dimEntries[0][1]).formula);
    b.text(
      firstFormula ||
        "score = clamp(baseline + sum(severity_weight x confidence x polarity), 0, 100); severity_weights = critical:25, high:15, medium:8, low:3, info:1",
      { size: 8, color: MUTED, gap: 12 },
    );
    for (const [, val] of dimEntries) {
      const v = asObj(val);
      const scoreNum = Number(v.score ?? 0);
      // Keep the dimension label + bar together with its contributors so
      // a dimension doesn't split across pages with its label orphaned.
      b.ensureSpace(58);
      b.dimensionRow(asStr(v.dimension), scoreNum);
      const neg = asArr(v.negatives)
        .slice(0, 4)
        .map((c) => `${asStr(c.title)} (${asStr(c.severity)})`);
      const pos = asArr(v.positives)
        .slice(0, 3)
        .map((c) => `${asStr(c.title)} (${asStr(c.severity)})`);
      if (neg.length) {
        b.text("Primary contributors — weakens", { size: 8, bold: true, color: MUTED, gap: 2 });
        b.bullets(neg);
      }
      if (pos.length) {
        b.text("Primary contributors — strengthens", {
          size: 8,
          bold: true,
          color: SUCCESS,
          gap: 2,
        });
        b.bullets(pos);
      }
      // Consistent breathing room between dimensions so the section
      // doesn't collapse into a continuous wall of compressed rows.
      b.y += neg.length || pos.length ? 10 : 12;
    }
  }
}

function renderKeyFindings(b: PdfBuilder, data: CaseExportData) {
  const cards = presentation(data).finding_cards;
  if (!cards.length) return;
  b.h1(rt("Key Findings"));
  b.table([["#", "Hallazgo", "Atribución", "Fuentes"]], cards.map((card, i) => [
    i + 1, asStr(card.finding.title), asStr(card.finding.speaker_role_label), card.source_count,
  ]));
  for (const [i, card] of cards.entries()) {
    const f = card.finding, wp = card.details;
    b.h2("#" + (i + 1) + " " + asStr(f.title));
    b.text(asStr(f.speaker_role_label) + " · " + asStr(f.speaker_role), {size:9, color:MUTED, gap:4});
    b.text(asStr(f.description), {size:9.6, gap:4});
    b.label(rt("Sources"), String(card.source_count));
    for (const ref of asArr(f.evidence_refs)) {
      if (ref.quote) b.evidenceQuote(asStr(ref.quote), asStr(ref.filename));
    }
    if (wp.importance.length) {
      b.h2("IMPORTANCIA ESTRATÉGICA");
      wp.importance.forEach(text => b.text(text, {size:9.4, gap:4}));
    }
    if (wp.synthesis) {
      b.h2("SÍNTESIS PROBATORIA");
      b.text(wp.synthesis.narrative, {size:9.4, gap:4});
      b.bullets(wp.synthesis.lines);
    }
    if (wp.pending.length) {
      b.h2("EVIDENCIA PENDIENTE O NO LOCALIZADA");
      b.bullets(wp.pending);
    }
    if (wp.actions.length) {
      b.h2(wp.actions_title);
      b.bullets(wp.actions);
    }
  }
}

function renderEvidenceMap(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  const idx = asArr(r.evidence_index);
  if (!idx.length) return;
  b.h1("Mapa de Evidencia");
  b.table(
    [["Doc", "Archivo", "Rol", "Páginas Clave"]],
    idx.map((e) => [
      asStr(e.doc_n),
      asStr(e.filename).slice(0, 60),
      asStr(e.role),
      Array.isArray(e.key_pages) ? (e.key_pages as number[]).join(", ") : "—",
    ]),
  );
  // Render a full detail block for every document that actually HAS
  // something to say — no silent truncation of the ones with real content
  // (previously sliced to 10, which meant multi-document cases only ever
  // saw the first 10 documents' detail). But a document with no summary
  // and no supports/undermines has nothing beyond what the table above
  // already shows (Doc/Filename/Role/Key pages) — repeating "no AI
  // classification available this run" as its own full block, once per
  // unclassified document, is what was padding large-corpus reports (e.g.
  // ~90 pages of boilerplate on a 110-document case) without adding any
  // information. Those documents are still listed in the table; they just
  // don't get a redundant detail block.
  for (const e of idx) {
    const summary = asStr(e.summary);
    const sup = Array.isArray(e.supports) ? (e.supports as string[]) : [];
    const und = Array.isArray(e.undermines) ? (e.undermines as string[]) : [];
    if (!summary && !sup.length && !und.length) continue;

    b.h3(asStr(e.filename) || citeLabel(e.doc_n, undefined));
    b.label("Rol", asStr(e.role));
    b.text(summary, { size: 10, gap: 4 });
    if (sup.length) {
      b.text("Supports:", { size: 9, bold: true, color: SUCCESS });
      b.bullets(sup);
    }
    if (und.length) {
      b.text("Undermines:", { size: 9, bold: true, color: DANGER });
      b.bullets(und);
    }
  }
}

function renderContradictions(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  const items = asArr(r.contradictions_struct);
  if (!items.length) return;
  b.h1("Análisis de Contradicciones");
  b.text(
    "Cada contradicción a continuación empareja dos declaraciones específicas del expediente con las consecuencias legales y estratégicas para el juicio.",
    { size: 10, color: MUTED, gap: 6 },
  );
  for (const c of items) {
    b.h3(asStr(c.title, "Contradiction"));
    b.text(rt("[FACT]"), { size: 8, bold: true, color: SUCCESS, gap: 2 });
    // Colored severity pill instead of a plain text label — this was the
    // only section in the report still rendering severity as uncolored
    // black text while every other section (Key Findings, tables) uses the
    // shared severityColor()/pill() language. A reader skimming the report
    // for critical items had to actually read the word here instead of
    // spotting the color, unlike everywhere else.
    const sevColor = b.severityColor(asStr(c.severity));
    b.ensureSpace(16);
    b.pill(asStr(c.severity, "—"), b.margin, b.y + 1, sevColor, "left");
    b.y += 14;
    b.label("Beneficia a", asStr(c.side_helped));
    const docA = asObj(c.document_a);
    const docB = asObj(c.document_b);
    if (Object.keys(docA).length || Object.keys(docB).length) {
      b.text("Document A:", { size: 9, bold: true, color: ACCENT });
      b.text(`"${asStr(docA.quote).slice(0, 220)}"  — ${citeLabel(docA.doc_n, docA.page)}`, {
        size: 10,
      });
      b.text("Document B:", { size: 9, bold: true, color: ACCENT });
      b.text(`"${asStr(docB.quote).slice(0, 220)}"  — ${citeLabel(docB.doc_n, docB.page)}`, {
        size: 10,
        gap: 4,
      });
    }
    if (c.nature) b.text(`Nature: ${asStr(c.nature)}`, { size: 10 });
    if (c.credibility_impact)
      b.text(`Credibility impact: ${asStr(c.credibility_impact)}`, { size: 10 });
    if (c.trial_significance)
      b.text(`Trial significance: ${asStr(c.trial_significance)}`, { size: 10 });
    if (c.impeachment_value)
      b.text(`Impeachment value: ${asStr(c.impeachment_value)}`, { size: 10 });
    if (c.strategic_implications)
      b.text(`Strategic implications: ${asStr(c.strategic_implications)}`, { size: 10 });
    if (c.legal_impact) b.text(`Legal impact: ${asStr(c.legal_impact)}`, { size: 10 });
    if (c.description) b.text(asStr(c.description), { size: 10, gap: 4 });
    const cites = asArr(c.citations);
    if (cites.length) {
      b.text("Evidencia adicional:", { size: 9, bold: true, color: MUTED });
      b.bullets(
        cites.map((cc) => `"${asStr(cc.quote).slice(0, 180)}"  — ${citeLabel(cc.doc_n, cc.page)}`),
      );
    }
    if (c.recommended_use)
      b.text(`Use: ${asStr(c.recommended_use)}`, { size: 10, color: MUTED, gap: 6 });
  }
}

function renderPerspectives(b: PdfBuilder, data: CaseExportData) {
  const ps = data.perspectives ?? [];
  if (!ps.length) return;
  b.h1("Análisis Multi-Perspectiva");
  b.text(
    "Independent analysis from each side of the dispute. All perspectives are produced regardless of which side counsel represents.",
    { size: 10, color: MUTED, gap: 8 },
  );
  // Each perspective's strength_score is produced by a separate LLM call
  // with no visibility into the deterministic case scorecard, so it can
  // diverge sharply from the case-level Case Strength shown on the cover
  // page and in the Executive Summary — e.g. a "Prosecution Strength: 78"
  // sitting a few pages after "Case Strength: 25 — Defense Advantage" with
  // nothing explaining the gap. Surface that explicitly instead of letting
  // two unreconciled numbers imply the report contradicts itself.
  const canonicalStrength = getScores(getReportRow(data)).strength;
  for (const p of ps) {
    b.h2(asStr(p.perspective, "Perspective").toUpperCase());
    if (typeof p.strength_score === "number") b.label("Fortaleza", `${p.strength_score} / 100`);
    if (typeof p.risk_score === "number") b.label("Riesgo", `${p.risk_score} / 100`);
    if (
      typeof p.strength_score === "number" &&
      typeof canonicalStrength === "number" &&
      Math.abs(p.strength_score - canonicalStrength) >= 25
    ) {
      b.text(
        `Note: this perspective's strength score (${p.strength_score}/100) diverges substantially from the ` +
          `case-level Case Strength (${canonicalStrength}/100). Perspective scores reflect the best case that ` +
          `side can argue from its own vantage point and are not directly comparable to the deterministic ` +
          `case-level score — treat them as separate measures rather than a contradiction.`,
        { size: 9, color: MUTED, gap: 4 },
      );
    }
    if (p.summary) b.text(asStr(p.summary), { size: 10.5, gap: 4 });
    const sec = (label: string, key: string, color: [number, number, number]) => {
      const arr = Array.isArray((p as Record<string, unknown>)[key])
        ? ((p as Record<string, unknown>)[key] as unknown[])
        : [];
      if (!arr.length) return;
      b.text(label, { size: 9, bold: true, color });
      b.bullets(
        arr
          .map((x) => {
            if (typeof x === "string") return x;
            const o = x as Record<string, unknown>;
            return (
              asStr(o.text) ||
              asStr(o.title) ||
              asStr(o.summary) ||
              asStr(o.description) ||
              asStr(o.argument) ||
              asStr(o.action) ||
              ""
            );
          })
          .filter((s) => s && s.trim().length > 0),
      );
    };
    sec("Fortalezas:", "strengths", SUCCESS);
    sec("Debilidades:", "weaknesses", DANGER);
    sec("Argumentos en contra:", "opposing_arguments", ACCENT);
    sec("Hechos clave:", "key_facts", MUTED);
    sec("Acciones recomendadas:", "recommended_actions", PRIMARY);
  }
}

function renderEvidenceIntel(b: PdfBuilder, data: CaseExportData) {
  const ev = data.evidence_intel ?? [];
  if (!ev.length) return;
  b.h1("Inteligencia Probatoria");
  b.text("Document-by-document classification with confidence labels and legal impact.", {
    size: 10,
    color: MUTED,
    gap: 6,
  });
  b.table(
    [["Clasificación", "Confianza", "Gravedad", "Documento", "Motivo"]],
    ev
      .slice(0, 60)
      .map((e) => [
        asStr(e.classification),
        asStr(e.confidence_label, asStr(e.confidence)),
        asStr(e.severity, "—"),
        asStr(e.title, resolveDocTitleByUuid(e.document_id) ?? "—").slice(0, 40),
        asStr(e.description, "—").slice(0, 90),
      ]),
  );
}

function renderStrategySynthesis(b: PdfBuilder, data: CaseExportData) {
  const rows = data.strategy ?? [];
  if (!rows.length) return;
  b.h1("Síntesis Estratégica");
  for (const s of rows) {
    b.h3(asStr(s.title, asStr(s.perspective, "Strategy")));
    if (s.perspective) b.label("Perspectiva", asStr(s.perspective));
    if (s.summary) b.text(asStr(s.summary), { size: 10, gap: 4 });
    const motions = Array.isArray(s.motion_rankings)
      ? (s.motion_rankings as Array<Record<string, unknown>>)
      : [];
    if (motions.length) {
      b.text("Motion rankings:", { size: 9, bold: true, color: ACCENT });
      b.bullets(
        motions.map(
          (m) =>
            `${asStr(m.priority).toUpperCase()} · ${asStr(m.motion)} — ${asStr(m.rationale).slice(0, 160)}`,
        ),
      );
    }
    const opp = Array.isArray(s.anticipated_opposing_arguments)
      ? (s.anticipated_opposing_arguments as Array<Record<string, unknown>>)
      : [];
    if (opp.length) {
      b.text("Anticipated opposing arguments:", { size: 9, bold: true, color: DANGER });
      b.bullets(
        opp.map(
          (o) =>
            `${asStr(o.argument)} (likelihood ${asStr(o.likelihood)}, impact ${asStr(o.impact)}) — counter: ${asStr(o.counter).slice(0, 160)}`,
        ),
      );
    }
    const na = Array.isArray(s.next_actions)
      ? (s.next_actions as Array<Record<string, unknown>>)
      : [];
    if (na.length) {
      b.text("Next actions:", { size: 9, bold: true, color: PRIMARY });
      b.bullets(na.map((n) => `${asStr(n.action)} — ${asStr(n.owner)}`));
    }
  }
}

function renderWorkProduct(b: PdfBuilder, data: CaseExportData) {
  const allRows = data.work_product ?? [];
  const motionsSuppressed = Boolean(asObj(data.report).motions_suppressed);
  // Mirror the gate applied in writer.server.ts: when motions are suppressed,
  // Attorney Work Product must not include drafted motions, trial outlines,
  // cross-exam plans, or settlement demands — only the factual case_summary.
  const rows = motionsSuppressed
    ? allRows.filter((w) => asStr(w.document_type) === "case_summary")
    : allRows;
  const bodyOf = (w: Record<string, unknown>) => asStr(w.body_markdown) || asStr(w.content);
  const generated = rows.filter((w) => bodyOf(w).trim().length > 40);
  const skipped = rows.filter((w) => bodyOf(w).trim().length <= 40);
  if (!generated.length && !skipped.length) {
    if (motionsSuppressed && allRows.length > 0) {
      b.h1("Producto de Trabajo del Abogado");
      b.text(
        "La redacción de promociones y las recomendaciones priorizadas se retuvieron porque este expediente no alcanzó el umbral de Suficiencia Probatoria (ESS).",
        { size: 10, color: MUTED, gap: 4 },
      );
    }
    return;
  }
  b.h1("Producto de Trabajo del Abogado");
  if (generated.length) {
    b.h2("Generado");
    generated.forEach((w, idx) => {
      const body = bodyOf(w);
      const title = asStr(w.title, asStr(w.document_type, "Work product"));
      const docType = asStr(w.document_type);
      const status = asStr(w.status);
      // Each generated document renders as its own clearly-bounded section.
      // Long documents (over ~1500 chars) start on a fresh page so a
      // trial outline never begins two lines from the bottom of a page
      // that just ended a Motion to Suppress.
      if (idx > 0) {
        if (body.length > 1500) {
          b.pageBreak();
        } else {
          b.y += 10;
          b.divider();
        }
      }
      // Document card header — title + type/status pills, drawn atomically
      // together with the first block of body content via ensureSpace.
      b.ensureSpace(90);
      const cardY = b.y;
      b.doc.setFillColor(...CARD_BG);
      b.doc.setDrawColor(...CARD_BORDER);
      b.doc.setLineWidth(0.75);
      b.doc.roundedRect(b.margin, cardY, b.pageW - b.margin * 2, 42, 4, 4, "FD");
      b.doc.setFillColor(...ACCENT);
      b.doc.roundedRect(b.margin, cardY, 4, 42, 2, 2, "F");
      b.doc.setFont("helvetica", "bold");
      b.doc.setFontSize(13);
      b.doc.setTextColor(...PRIMARY);
      b.doc.text(pdfSafe(title), b.margin + 14, cardY + 18);
      const meta = [docType.replace(/_/g, " "), status].filter(Boolean).join("  ·  ");
      if (meta) {
        b.doc.setFont("helvetica", "normal");
        b.doc.setFontSize(9);
        b.doc.setTextColor(...MUTED);
        b.doc.text(meta.toUpperCase(), b.margin + 14, cardY + 34);
      }
      b.y = cardY + 42 + 12;
      b.markdownBody(body);
    });
  }
  if (skipped.length) {
    b.h2("Omitido");
    for (const w of skipped) {
      const title = asStr(w.title, asStr(w.document_type, "Work product"));
      const reason =
        asStr(w.error_message) ||
        asStr(w.skipped_reason) ||
        "No generado por evidencia insuficiente.";
      b.text(`• ${title} — ${reason}`, { size: 10, color: MUTED });
    }
  }
}

function renderConstitutional(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  const full = asObj(r.full_report);
  const caseType = asStr(full.case_type) || "general_civil";
  // FIX (2026-07-29): this only checked the retired English case-type keys
  // ("criminal", "civil_rights") — never "penal"/"amparo"/"constitucional",
  // the actual Mexican taxonomy keys pipeline.server.ts's own
  // isCriminalOrCivilRights check already uses correctly. That meant this
  // entire section could never render for any real Mexican case, even
  // though constitutional_issues_struct was being correctly populated
  // upstream the whole time — the data existed, this gate just hid it.
  if (caseType !== "penal" && caseType !== "amparo" && caseType !== "constitucional") return;
  const items = asArr(r.constitutional_issues_struct);
  if (!items.length) return;
  b.h1("Análisis Constitucional");
  for (const c of items) {
    // FIX: c.amendment matched a schema field that literally asked the LLM
    // for a U.S. constitutional amendment number — renamed to
    // articulo_cpeum (CPEUM article) in pipeline.server.ts's prompt schema.
    b.h3(`${asStr(c.right)} — ${asStr(c.articulo_cpeum)}`);
    b.text(asStr(c.issue), { size: 11, bold: true, gap: 2 });
    if (c.facts) {
      b.h3("Hechos");
      b.text(asStr(c.facts));
    }
    if (c.legal_standard) {
      b.h3("Estándar Legal");
      b.text(asStr(c.legal_standard));
    }
    if ((data as FinalReportPayload).report_presentation.capability.probabilities_allowed && c.likely_outcome)
      b.callout(
        "Estimación de Probabilidad",
        `${asStr(c.likely_outcome)} (confianza: ${asStr(c.confidence_label, "media")})`,
      );
    if (c.jurisdiction) b.label("Jurisdicción", asStr(c.jurisdiction));
    if (c.warrant_standard) b.label("Estándar de Cateo/Orden Judicial", asStr(c.warrant_standard));
    if (c.uncertainty_flag) b.callout("Incertidumbre", asStr(c.uncertainty_flag), DANGER);
    if ((data as FinalReportPayload).report_presentation.capability.strategic_recommendations_allowed &&
        (data as FinalReportPayload).report_presentation.governance.strategy_output_allowed && c.remedy_sought)
      b.label("Remedio Solicitado", asStr(c.remedy_sought));
    if (asObj(c.historical_remedy).content_class === "HISTORICAL_REMEDY")
      b.label(asStr(asObj(c.historical_remedy).title), asStr(asObj(c.historical_remedy).text));
    const cites = asArr(c.citations);
    if (cites.length) {
      b.text(rt("Evidence:"), { size: 9, bold: true, color: MUTED });
      b.bullets(
        cites.map((cc) => `"${asStr(cc.quote).slice(0, 180)}"  — ${citeLabel(cc.doc_n, cc.page)}`),
      );
    }
  }
}

// Renders the deterministic legal-issue hits (Fourth Amendment, Miranda,
// Brady, Chain of Custody, etc.) together with any real case law that
// buildLegalIssuesWithCaseLaw() attached via CourtListener. Sourced from
// full_report.legal_issues — never gated by case type, since the
// underlying detection runs over raw document text regardless of
// case_type. Silently renders nothing if no issues were detected or if
// case law lookup failed/was skipped (case_law will just be []).
function renderLegalIssues(b: PdfBuilder, data: CaseExportData) {
  const full = asObj(asObj(data.report).full_report);
  const items = asArr(full.legal_issues);
  if (!items.length) return;
  b.h1("Cuestiones Jurídicas y Jurisprudencia");

  // The same handful of legal theories (Fourth Amendment, Miranda, Brady,
  // Chain of Custody, Jencks, Authentication, Expert Admissibility) get
  // flagged independently on every document that touches them upstream,
  // producing near-duplicate blocks — e.g. 33 separate "Brady" entries with
  // identical significance/next-step text, each with its own copy of the
  // same case law. On a 94-document corpus that's what pushed a report to
  // 54 pages of largely repeated boilerplate. Consolidate to one block per
  // issue type: shared legal framing rendered once, a few representative
  // supporting quotes, the full set of implicated documents (nothing lost,
  // just not repeated), and case law merged + deduped across the whole
  // group instead of copy-pasted per document.
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const it of items) {
    const key = asStr(it.issue) || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(it);
  }

  for (const [issue, group] of groups) {
    const first = group[0];
    b.h3(group.length > 1 ? `${issue}  (${group.length} documents)` : issue);
    if (first.indicator) b.text(asStr(first.indicator), { size: 9, color: MUTED, gap: 2 });
    if (first.significance) b.label("Trascendencia", asStr(first.significance));
    if (first.next_step) b.label("Siguiente Paso", asStr(first.next_step));

    const withQuotes = group.filter((g) => asStr(g.quote).trim());
    if (withQuotes.length) {
      b.text("Evidencia representativa:", { size: 9, bold: true, color: MUTED, gap: 2 });
      b.bullets(
        withQuotes.slice(0, 3).map((g) => {
          const doc = asStr(g.document);
          const title = doc ? humanizeDocTitle(doc) : "";
          return title
            ? `"${asStr(g.quote).slice(0, 160)}"  — ${title}`
            : `"${asStr(g.quote).slice(0, 160)}"`;
        }),
      );
    }

    const docs = [...new Set(group.map((g) => asStr(g.document)).filter(Boolean))].map((f) =>
      humanizeDocTitle(f),
    );
    if (docs.length > 1) {
      const shown = docs.slice(0, 12).join(", ");
      const more = docs.length > 12 ? `, +${docs.length - 12} ${rt("more")}` : "";
      b.text(`${rt("Also implicated in:")} ${shown}${more}`, { size: 8.5, color: MUTED, gap: 4 });
    }

    const allCases = group.flatMap((g) => asArr(g.case_law));
    const seen = new Set<string>();
    const caseLines: string[] = [];
    for (const c of allCases) {
      const meta = [asStr(c.citation), asStr(c.court), asStr(c.date_filed)]
        .filter(Boolean)
        .join(" · ");
      const line = meta ? `${asStr(c.case_name)} — ${meta}` : asStr(c.case_name);
      if (!line.trim() || seen.has(line)) continue;
      seen.add(line);
      caseLines.push(line);
    }
    if (caseLines.length) {
      b.text("Case law:", { size: 9, bold: true, color: MUTED, gap: 4 });
      b.bullets(caseLines);
    }
  }
}

function renderWitnesses(b: PdfBuilder, data: CaseExportData) {
  const ws = data.witnesses ?? [];
  if (!ws.length) return;
  b.h1("Inteligencia de Testigos");
  b.table(
    [["Testigo", "Rol", "Confiabilidad", "Sesgo", "Riesgo de Credibilidad"]],
    ws.map((w) => [
      asStr(w.name),
      asStr(w.role),
      asStr(w.reliability, "—"),
      asStr(w.bias, "—"),
      asStr(w.credibility_risk, "—"),
    ]),
  );
  for (const [idx, w] of ws.slice(0, 8).entries()) {
    if (idx > 0) b.divider();
    b.h3(`${asStr(w.name)}${w.role ? ` — ${asStr(w.role)}` : ""}`);
    // Reliability reads "good" high, while bias/credibility-risk read
    // "good" low — invert only the bar/color for those two (via the
    // `invert` option) so a full green bar always means "favorable for
    // this witness's credibility" at a glance. The printed number is the
    // real score in all three rows, matching the summary table above.
    const reliability = Number(w.reliability);
    const bias = Number(w.bias);
    const credRisk = Number(w.credibility_risk);
    if (!isNaN(reliability)) b.dimensionRow("Reliability", reliability);
    if (!isNaN(bias)) b.dimensionRow("Bias", bias, { invert: true });
    if (!isNaN(credRisk)) b.dimensionRow("Credibility risk", credRisk, { invert: true });
    b.y += 2;
    const rat = asObj(w.rationale);
    for (const [k, v] of Object.entries(rat)) {
      b.text(`${k}: ${asStr(v)}`, { size: 10, color: MUTED });
    }
    const cx = Array.isArray(w.cross_exam_questions) ? (w.cross_exam_questions as string[]) : [];
    if (cx.length) {
      b.text("Cross-examination:", { size: 9, bold: true, color: ACCENT });
      b.bullets(cx.slice(0, 8));
    }
    const imp = Array.isArray(w.impeachment_questions) ? (w.impeachment_questions as string[]) : [];
    if (imp.length) {
      b.text("Impeachment:", { size: 9, bold: true, color: DANGER });
      b.bullets(imp.slice(0, 6));
    }
  }
}

function renderTheories(b: PdfBuilder, data: CaseExportData) {
  const ts = data.theories ?? [];
  if (!ts.length) return;
  b.h1("Análisis de Teoría del Caso");
  for (const t of ts) {
    const isAiTheory = asStr(t.finding_type) === "AI_THEORY";
    b.h3(`${mxRoleLabel(asStr(t.theory_type))} Theory`);
    if (isAiTheory) {
      // Only ever persisted when the case was run in exploratory mode (see
      // evidence-gate.server.ts) — an uncited, model-generated theory. Must
      // never render indistinguishably from a citation-backed theory.
      b.text("IA — TEORÍA NO VERIFICADA, REQUIERE REVISIÓN DEL ABOGADO", {
        size: 9,
        bold: true,
        color: DANGER,
        gap: 4,
      });
    }
    b.label("Confianza", Number(t.confidence ?? 0).toFixed(2));
    if (t.risk) b.label("Riesgo", asStr(t.risk));
    b.text(asStr(t.narrative), { size: 10.5, gap: 4 });
    const sup = Array.isArray(t.supporting_evidence) ? (t.supporting_evidence as string[]) : [];
    const con = Array.isArray(t.contradicting_evidence)
      ? (t.contradicting_evidence as string[])
      : [];
    const mis = Array.isArray(t.missing_evidence) ? (t.missing_evidence as string[]) : [];
    if (sup.length) {
      b.text("Evidencia de apoyo:", { size: 9, bold: true, color: SUCCESS });
      b.bullets(sup);
    }
    if (con.length) {
      b.text("Evidencia contradictoria:", { size: 9, bold: true, color: DANGER });
      b.bullets(con);
    }
    if (mis.length) {
      b.text("Evidencia faltante:", { size: 9, bold: true, color: ACCENT });
      b.bullets(mis);
    }
  }
}

function renderLitigationStrategyCenter(b: PdfBuilder, data: CaseExportData) {
  const sc = (data.strategy_center ?? {}) as Record<string, unknown>;
  const theme = asObj(sc.primary_trial_theme);
  const weakness = asObj(sc.biggest_weakness);
  const risk = asObj(sc.biggest_trial_risk);
  const leverage = asArr(sc.settlement_leverage);
  const witness = asObj(sc.most_dangerous_witness);
  const gap = asObj(sc.biggest_evidentiary_gap);
  const defense = asObj(sc.expected_defense);
  const counter = asStr(sc.recommended_counter_strategy);
  const priorities = asArr(sc.weekly_priorities);
  const dashboard = asArr(sc.winning_the_case_dashboard);
  const leadCounsel = asStr(sc.lead_counsel_assessment);

  if (!asStr(theme.theme) && !dashboard.length) return;

  b.h1("Centro de Estrategia Litigiosa");

  // ---- What Wins This Case? ----
  if (asStr(theme.theme)) {
    b.h2("¿Qué Gana Este Caso?");
    b.h3("Tema Central del Litigio");
    b.text(asStr(theme.theme), { size: 11, bold: true, color: PRIMARY, gap: 4 });
    if (theme.why) b.text(asStr(theme.why), { size: 10, gap: 4 });
    if (theme.persuasion_likelihood)
      b.label("Probabilidad de Persuasión", asStr(theme.persuasion_likelihood));
    const supEv = Array.isArray(theme.supporting_evidence)
      ? (theme.supporting_evidence as string[])
      : [];
    if (supEv.length) {
      b.text("Evidencia de apoyo:", { size: 9, bold: true, color: MUTED });
      b.bullets(supEv);
    }
    if (theme.presentation_guidance) {
      b.text("Cómo presentarlo:", { size: 9, bold: true, color: MUTED });
      b.text(asStr(theme.presentation_guidance), { size: 10, gap: 4 });
    }
  }

  // ---- What Could Lose This Case? ----
  if (asStr(weakness.weakness) || asStr(risk.risk)) {
    b.h2("¿Qué Podría Perder Este Caso?");
    if (weakness.weakness) {
      b.h3("Mayor Debilidad");
      b.text(asStr(weakness.weakness), { size: 10.5, bold: true, gap: 2 });
      if (weakness.why_it_matters) b.text(asStr(weakness.why_it_matters), { size: 10, gap: 4 });
    }
    if (risk.risk) {
      b.h3("Mayor Riesgo en Juicio");
      b.text(asStr(risk.risk), { size: 10.5, bold: true, gap: 2, color: DANGER });
      if (risk.explanation) b.text(asStr(risk.explanation), { size: 10, gap: 4 });
    }
  }

  // ---- Settlement leverage ----
  if (leverage.length) {
    b.h2("Mejor Palanca de Negociación");
    b.bullets(
      leverage.map((l) => {
        const item = asStr(l.item);
        const why = asStr(l.why_it_increases_pressure);
        return why ? `${item} — ${why}` : item;
      }),
    );
  }

  // ---- Most dangerous witness (grounded — omitted entirely if ungrounded) ----
  if (asStr(witness.name)) {
    b.h2("Testigo Más Riesgoso");
    b.text(asStr(witness.name), { size: 11, bold: true, color: PRIMARY, gap: 4 });
    const reasons = Array.isArray(witness.reasons) ? (witness.reasons as string[]) : [];
    if (reasons.length) {
      b.text("Por qué:", { size: 9, bold: true, color: MUTED });
      b.bullets(reasons);
    }
    const approach = Array.isArray(witness.recommended_approach)
      ? (witness.recommended_approach as string[])
      : [];
    if (approach.length) {
      b.text("Enfoque recomendado:", { size: 9, bold: true, color: MUTED });
      b.bullets(approach);
    }
  }

  // ---- Biggest evidentiary gap ----
  if (asStr(gap.item)) {
    b.h2("Mayor Vacío Probatorio");
    b.text(asStr(gap.item), { size: 11, bold: true, color: PRIMARY, gap: 4 });
    if (gap.importance) b.label("Importancia", asStr(gap.importance));
    if (gap.impact) b.text(asStr(gap.impact), { size: 10, gap: 4 });
    const howTo = Array.isArray(gap.how_to_obtain) ? (gap.how_to_obtain as string[]) : [];
    if (howTo.length) {
      b.text("Cómo obtenerla:", { size: 9, bold: true, color: MUTED });
      b.bullets(howTo);
    }
    if (gap.potential_benefit) {
      b.text("Beneficio potencial:", { size: 9, bold: true, color: MUTED });
      b.text(asStr(gap.potential_benefit), { size: 10, gap: 4 });
    }
  }

  // ---- Expected defense + counter ----
  if (asStr(defense.primary_defense) || counter) {
    b.h2("Estrategia de Defensa Más Probable");
    if (defense.primary_defense) {
      b.h3("Defensa Principal");
      b.text(asStr(defense.primary_defense), { size: 10.5, bold: true, gap: 4 });
      const supArgs = Array.isArray(defense.supporting_arguments)
        ? (defense.supporting_arguments as string[])
        : [];
      if (supArgs.length) {
        b.text("Argumentos de apoyo:", { size: 9, bold: true, color: MUTED });
        b.bullets(supArgs);
      }
      const weaknesses = Array.isArray(defense.weaknesses) ? (defense.weaknesses as string[]) : [];
      if (weaknesses.length) {
        b.text("Debilidades:", { size: 9, bold: true, color: SUCCESS });
        b.bullets(weaknesses);
      }
    }
    if (counter) {
      b.h3("Estrategia de Contraataque Recomendada");
      b.text(counter, { size: 10, gap: 4 });
    }
  }

  // ---- What should counsel do this week? ----
  if (priorities.length) {
    b.h2("¿Qué Debe Hacer el Abogado Esta Semana?");
    b.table(
      [["Prioridad", "Acción", "Impacto", "Razón"]],
      priorities.map((p) => {
        const stars = Math.max(0, Math.min(5, Math.round(Number(p.impact_stars ?? 0))));
        return [
          asStr(p.priority),
          asStr(p.action).slice(0, 90),
          "★".repeat(stars) + "☆".repeat(5 - stars),
          asStr(p.reason).slice(0, 90),
        ];
      }),
    );
  }

  // ---- Winning the Case dashboard (computed in code, mirrors the fields above) ----
  if (dashboard.length) {
    b.h2("Cómo Ganar el Caso");
    b.table(
      [["Pregunta Litigiosa", "Evaluación de la IA"]],
      dashboard.map((d) => [asStr(d.question), asStr(d.assessment).slice(0, 140)]),
    );
  }

  // ---- If I Were Lead Trial Counsel ----
  if (leadCounsel) {
    b.h2("Si Yo Fuera el Abogado Principal del Caso");
    b.text("[ANÁLISIS ESTRATÉGICO — NO CONSTITUYE ASESORÍA LEGAL]", {
      size: 8,
      bold: true,
      color: ACCENT,
      gap: 4,
    });
    b.text(leadCounsel, { size: 10.5, gap: 4 });
  }
}

function renderStrategy(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  const motions = asArr(r.motion_opportunities);
  const recs = asArr(r.strategy_recommendations);
  const next = asArr(r.next_actions);
  const missing = asArr(r.missing_evidence_struct);
  if (!motions.length && !recs.length && !next.length && !missing.length) return;
  b.h1("Oportunidades Estratégicas");

  if (missing.length) {
    b.h2("Evidencia Faltante");
    b.text("[HIPÓTESIS QUE REQUIERE VERIFICACIÓN]", { size: 8, bold: true, color: ACCENT, gap: 4 });
    b.table(
      [["Elemento", "Gravedad", "Riesgo Probatorio", "Promoción Recomendada"]],
      missing.map((m) => [
        asStr(m.item).slice(0, 80),
        asStr(m.severity),
        m.omision_probatoria_risk ? "Sí" : "No",
        asStr(m.recommended_motion, "—"),
      ]),
    );
  }

  if (motions.length) {
    b.h2("Oportunidades de Promociones");
    b.text("[STRATEGIC CONSIDERATION]", { size: 8, bold: true, color: ACCENT, gap: 4 });
    for (const m of motions) {
      b.h3(asStr(m.motion));
      b.label("Probabilidad de Éxito", asStr(m.likelihood_of_success));
      b.label("Prioridad", asStr(m.priority));
      b.text(`Basis: ${asStr(m.basis)}`, { size: 10, gap: 2 });
      if (m.supporting_facts)
        b.text(`Supporting facts: ${asStr(m.supporting_facts)}`, { size: 10, gap: 2 });
      if (m.legal_rationale)
        b.text(`Legal rationale: ${asStr(m.legal_rationale)}`, { size: 10, gap: 2 });
      if (m.anticipated_opposing_response)
        b.text(`Anticipated opposing response: ${asStr(m.anticipated_opposing_response)}`, {
          size: 10,
          gap: 2,
        });
      if (m.likely_outcome)
        b.text(`Probability estimate: ${asStr(m.likely_outcome)} (low/medium/high confidence)`, {
          size: 10,
          gap: 2,
        });
      const elements = Array.isArray(m.elements) ? (m.elements as string[]) : [];
      if (elements.length) {
        b.text("Elements:", { size: 9, bold: true, color: MUTED });
        b.bullets(elements);
      }
      const mcites = asArr(m.citations);
      if (mcites.length) {
        b.text(rt("Evidence:"), { size: 9, bold: true, color: MUTED });
        b.bullets(
          mcites
            .slice(0, 4)
            .map((cc) => `"${asStr(cc.quote).slice(0, 180)}"  — ${citeLabel(cc.doc_n, cc.page)}`),
        );
      }
      if (m.draft_outline) {
        b.h3("Draft outline");
        b.text(asStr(m.draft_outline));
      }
    }
  }

  if (recs.length) {
    b.h2("Recomendaciones Estratégicas");
    b.table(
      [["Prioridad", "Título", "Categoría", "Impacto Esperado"]],
      recs.map((r) => [
        asStr(r.priority),
        asStr(r.title).slice(0, 80),
        asStr(r.category),
        asStr(r.expected_impact).slice(0, 80),
      ]),
    );
  }

  if (next.length) {
    b.h2("Próximas Acciones Recomendadas");
    b.table(
      [["#", "Acción", "Responsable", "Motivo"]],
      next.map((n) => [
        asStr(n.order, "•"),
        asStr(n.action).slice(0, 90),
        asStr(n.owner),
        asStr(n.why).slice(0, 90),
      ]),
    );
  }
}

function renderCoverage(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  const full = asObj(r.full_report);
  const coverage = asObj(full.coverage_report);
  if (!coverage || Object.keys(coverage).length === 0) return;
  b.h1("Cobertura Probatoria");
  b.text("Transparencia de ingesta: ¿qué tan completo es este análisis?", {
    size: 10,
    color: MUTED,
    gap: 8,
  });
  b.table(
    [["Métrica", "Valor"]],
    [
      ["Documents found", asStr(coverage.documents_found, "0")],
      ["Successfully parsed", asStr(coverage.documents_parsed, "0")],
      ["Failed", asStr(coverage.documents_failed, "0")],
      ["Pending", asStr(coverage.documents_pending, "0")],
      ["Parse coverage", `${asStr(coverage.parse_coverage_pct, "0")}%`],
      ["OCR coverage", `${asStr(coverage.ocr_coverage_pct, "0")}%`],
      ["Metadata coverage", `${asStr(coverage.metadata_coverage_pct, "0")}%`],
      ["Total text extracted", `${asStr(coverage.text_chars_total, "0")} chars`],
    ],
  );
  const failures = asArr(coverage.failed_documents);
  if (failures.length) {
    b.h2("Documentos con Error");
    b.table(
      [["Archivo", "Error"]],
      failures.map((f) => [asStr(f.filename), asStr(f.error, "Unknown error").slice(0, 100)]),
    );
  }
}

// Per-agent row detail (agent_name, status, per-row findings breakdown) is
// display-only and has no canonical.ts equivalent, so it still reads
// full_report.agent_statistics.rows directly. What it must NEVER do is
// fall back to recomputing totals from data.agent_logs on the client —
// canonical.ts's getAgentSummary() is the only source of truth for the
// summary counts (loaded/executed/producingOutput/producingFindings/etc),
// because agent_logs can reflect a different run or a partial write and
// silently disagree with the finalized full_report.agent_statistics that
// every other surface (Dashboard, cover page) reads.
function getAgentRows(data: CaseExportData): Array<Record<string, unknown>> {
  const r = asObj(data.report);
  const full = asObj(r.full_report);
  const embedded = asObj(full.agent_statistics);
  return asArr(embedded.rows);
}

function renderAgentStatistics(b: PdfBuilder, data: CaseExportData) {
  const summary = getAgentSummary(getReportRow(data));
  const rows = getAgentRows(data);
  if (summary.loaded === 0 && !rows.length) return;

  const invariantErrors = validateAgentSummary(summary);
  if (invariantErrors.length) {
    const isDev = ((import.meta as unknown as { env?: Record<string, string> }).env?.DEV ??
      "") as unknown;
    if (isDev) {
      console.warn("Agent summary invariant violation:", invariantErrors.join("; "));
    }
  }

  b.h1("Estadísticas de Agentes");
  b.text(
    "Esta sección distingue entre agentes cargados, agentes que efectivamente analizaron evidencia y agentes que produjeron trabajo medible. Los totales se basan en el resultado producido, no en la inicialización.",
    { size: 10, color: MUTED, gap: 8 },
  );
  b.table(
    [["Métrica", "Valor"]],
    [
      ["Agents loaded", String(summary.loaded)],
      ["Agents executed", String(summary.executed)],
      ["Agents producing output", String(summary.producingOutput)],
      ["Agents producing findings", String(summary.producingFindings)],
      ["Suppressed findings", String(summary.suppressedFindings)],
      ["Visible findings", String(summary.visibleFindings)],
    ],
  );

  if (rows.length) {
    b.table(
      [
        [
          "Agente",
          "Estado",
          "Hallazgos Producidos",
          "Generado",
          "Suprimido",
          "Promovido",
          "Docs",
          "Resultado / Explicación",
        ],
      ],
      rows.map((r) => [
        asStr(r.agent_name || r.agent_key).slice(0, 36),
        asStr(r.status, "pending"),
        asStr(r.visible_findings ?? r.findings_produced, "0"),
        asStr(r.findings_generated, "0"),
        asStr(r.findings_suppressed, "0"),
        asStr(r.findings_promoted, "0"),
        asStr(r.documents_analyzed, "0"),
        (asStr(r.no_output_reason) || `${asStr(r.output_items, "0")} output item(s)`).slice(0, 90),
      ]),
    );
  }
}

function humanizeEngine(e: string): string {
  return e
    .split(/[_:]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function renderAudit(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  const full = asObj(r.full_report);
  const manifest = asObj(full.case_type_manifest);
  b.h1("Registro de Auditoría");
  b.text(
    "Registro de enrutamiento de este caso. El manifiesto de ejecución a continuación muestra qué motores se ejecutaron, cuáles se omitieron por no aplicar a la materia seleccionada, y cuáles se activaron mediante disparadores interdominio.",
    { size: 10, gap: 8 },
  );

  if (Object.keys(manifest).length) {
    b.h2("Manifiesto de Ejecución");
    b.label("Tipo de Caso", asStr(manifest.case_type_label, asStr(manifest.case_type, "—")));
    const active = Array.isArray(manifest.active_domains)
      ? (manifest.active_domains as string[])
      : [];
    if (active.length) b.label("Dominios Activos", active.map(humanizeEngine).join(", "));

    const enabled = Array.isArray(manifest.enabled_engines)
      ? (manifest.enabled_engines as string[])
      : [];
    const skipped = Array.isArray(manifest.skipped_engines)
      ? (manifest.skipped_engines as string[])
      : [];
    const cross = Array.isArray(manifest.cross_domain_engines)
      ? (manifest.cross_domain_engines as string[])
      : [];

    if (enabled.length) {
      b.h3("Enabled");
      b.bullets(enabled.map((e) => `✔ ${humanizeEngine(e)}`));
    }
    if (cross.length) {
      b.h3("Cross-domain (activated)");
      b.bullets(cross.map((e) => `+ ${humanizeEngine(e)}`));
    }
    if (skipped.length) {
      b.h3("Skipped — Not applicable to selected case type");
      b.bullets(skipped.map((e) => `• ${humanizeEngine(e)}`));
    }
  }

  b.h2("Documentos Fuente");
  b.table(
    [["#", "Archivo", "Estado", "Tamaño", "Errores"]],
    data.documents.map((d, i) => [
      i + 1,
      asStr(d.filename).slice(0, 60),
      asStr(d.status),
      asStr(d.size_bytes, "—"),
      asStr(d.error, "—").slice(0, 60),
    ]),
  );
}

function renderAppendix(b: PdfBuilder, data: CaseExportData) {
  const r = asObj(data.report);
  const cites = asArr(r.citations);
  if (!cites.length) return;
  b.h1("Anexo: Citas de Fuentes");
  b.text(
    rt(
      "Every citation below is verbatim from the case corpus. Use these to verify any claim in the report.",
    ),
    {
      size: 10,
      color: MUTED,
      gap: 8,
    },
  );
  b.table(
    [["#", "Tema", "Documento", "Página", "Cita"]],
    cites.map((c, i) => [
      i + 1,
      asStr(c.topic).slice(0, 30),
      resolveDocTitle(c.doc_n) ?? asStr(c.doc_n),
      asStr(c.page),
      asStr(c.quote).slice(0, 100),
    ]),
    {
      columnStyles: {
        0: { cellWidth: 22 }, // #
        1: { cellWidth: 110 }, // Topic — widened so labels stop wrapping awkwardly
        2: { cellWidth: 90 }, // Document
        3: { cellWidth: 32 }, // Page
        // Quote gets whatever remains — it's the longest field.
      },
      emphasizeColIdx: 2, // Document name — bold, reads as the citation's anchor
      mutedColIdx: 4, // Quote — italic/muted, reads as quoted material, not a label
    },
  );
}

// FIX (2026-08-17, bug report "quarantined/unverified findings render as
// authoritative content" — item 4, named by the report's own authors as
// "the highest-leverage fix even before the deeper root cause is
// resolved"): citation_audit (citation-audit.server.ts) already computes,
// on every report, exactly which findings lack a complete supporting
// citation and were therefore excluded from recommendations/legal_memorandum
// (see filterQuarantinedRecommendations/gateLegalAnalysis in
// pipeline.server.ts) — but until this section existed, that determination
// was invisible: a reader had no way to see that content had been withheld,
// or why. This renders the existing citation_audit.quarantined_findings list
// directly — no new computation, just surfacing data the pipeline already
// produces.
const CITATION_AUDIT_REASON_LABELS: Record<string, string> = {
  missing_document: "Sin documento fuente",
  missing_quote: "Sin cita textual",
  missing_page_and_refs: "Sin número de página ni referencia",
  missing_all: "Sin ningún respaldo documental",
};

function renderCitationAudit(b: PdfBuilder, data: CaseExportData) {
  const full = asObj(asObj(data.report).full_report);
  const audit = asObj(full.citation_audit);
  const quarantined = asArr(audit.quarantined_findings);
  if (!quarantined.length) return;
  b.h1("Auditoría de Citas — Contenido No Verificado");
  b.text(
    rt(
      `${quarantined.length} de ${asStr(audit.total, "0")} hallazgo(s) generado(s) para este caso carecen de una cita de respaldo completa (documento, página y cita textual verificable) y fueron EXCLUIDOS de las recomendaciones, el memorando legal y el resto del contenido del reporte. Se listan aquí únicamente para fines de auditoría y seguimiento — no deben tratarse como conclusiones respaldadas ni citarse como tales.`,
    ),
    { size: 10, color: MUTED, gap: 8 },
  );
  b.table(
    [["#", "Hallazgo", "Motivo", "Documento", "Página"]],
    quarantined.map((q, i) => [
      i + 1,
      asStr(q.title).slice(0, 60),
      CITATION_AUDIT_REASON_LABELS[asStr(q.reason)] ?? asStr(q.reason, "—"),
      resolveDocTitleByUuid(q.source_document_id) ?? "—",
      asStr(q.source_page, "—"),
    ]),
    {
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 170 },
        2: { cellWidth: 110 },
      },
      mutedColIdx: 2,
    },
  );
}

// FIX (2026-08-18, ADR-5829/2025 audit — item 8, "silently-failed
// engines/detected defects never surfaced"): pipeline.server.ts already
// runs validateRenderedReport (prerender-validate.server.ts) against the
// FINAL rendered report content on every run, and it already caught real
// defects live — including SPANISH_CASE_TYPE_LEAK, which fires when
// penal-only institutional vocabulary (Ministerio Público, Juez de
// Control, carpeta de investigación) appears in a non-penal report, the
// exact shape of the off-topic criminal-procedure content this audit's
// item 4 flagged on a tax/administrative amparo case. That detection was
// stored on full_report.rendered_qa.issues and summarized into
// full_report.pipeline_warnings — but nothing ever rendered either one, so
// an attorney had no way to know 7 critical issues had been found short of
// reading the raw JSON export. This surfaces the existing detection
// directly — no new computation, matching renderCitationAudit's precedent
// immediately above. Deliberately still non-blocking (see
// prerender-validate.server.ts's own module comment on that decision) —
// this section's job is visibility, not enforcement.
const RENDERED_QA_CODE_LABELS: Record<string, string> = {
  SPANISH_CASE_TYPE_LEAK: "Terminología penal fuera de lugar",
  CASE_TYPE_LEAK: "Terminología fuera de materia",
  US_PROCEDURE_LEAK: "Término procesal estadounidense sin equivalente mexicano",
  TOKEN_MUSTACHE: "Marcador de plantilla sin resolver",
  TOKEN_DOLLAR_BRACE: "Marcador de plantilla sin resolver",
  TOKEN_PRINTF: "Marcador de plantilla sin resolver",
  TOKEN_NULL_LITERAL: "Valor nulo sin resolver",
  TOKEN_NAN_PERCENT: "Valor numérico inválido",
};

function renderedQaCriticalIssues(data: CaseExportData): Array<Record<string, unknown>> {
  const full = asObj(asObj(data.report).full_report);
  const qa = asObj(full.rendered_qa);
  return asArr(qa.issues).filter((i) => asStr(i.severity) === "critical");
}

function renderRenderedReportQa(b: PdfBuilder, data: CaseExportData) {
  const issues = renderedQaCriticalIssues(data);
  if (!issues.length) return;
  b.h1("Auditoría de Calidad del Reporte");
  b.text(
    rt(
      `El sistema detectó ${issues.length} problema(s) crítico(s) de calidad en el contenido generado de este reporte — terminología fuera de la materia del caso, términos procesales sin equivalente mexicano, o marcadores de plantilla sin resolver. Estas secciones deben revisarse con especial cuidado antes de confiar en su contenido.`,
    ),
    { size: 10, color: MUTED, gap: 8 },
  );
  b.table(
    [["#", "Tipo", "Detalle"]],
    issues.map((q, i) => [
      i + 1,
      RENDERED_QA_CODE_LABELS[asStr(q.code)] ?? asStr(q.code, "—"),
      asStr(q.message).slice(0, 160),
    ]),
    {
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 130 },
      },
    },
  );
}

function renderEvidenceSources(b: PdfBuilder) {
  if (!_footnotes.length) return;
  b.h1("Fuentes de Evidencia");
  b.text(
    "Referencias numeradas del cuerpo del reporte, resueltas a su documento y página de origen.",
    {
      size: 10,
      color: MUTED,
      gap: 8,
    },
  );
  b.table(
    [["#", "Fuente"]],
    _footnotes.map((f) => [`[${f.n}]`, f.label]),
  );
}

// ===== Section plan: single source of truth for what renders =========
//
// Each section declares whether it's gated in LIMITED mode and a predicate
// that returns true when it has content to render. The plan is computed
// once; the TOC, the PDF body, and the report preview all walk the SAME filtered
// list. This guarantees TOC ↔ rendered ↔ exports parity.

type SectionPlan = {
  id: string;
  title: string;
  gatedInLimited: boolean;
  available: (data: CaseExportData) => boolean;
  renderPdf: (b: PdfBuilder, data: CaseExportData) => void;
};

function hasProseSection(data: CaseExportData, key: string): boolean {
  return !!reportText(data, key).trim();
}

function buildSectionPlan(mode: ReportMode): SectionPlan[] {
  // Prose-only sections that render the report-row field as paragraphs.
  const proseSec = (id: string, title: string, key: string, gated = false): SectionPlan => ({
    id,
    title,
    gatedInLimited: gated,
    available: (d) => hasProseSection(d, key),
    renderPdf: (b, d) => {
      b.h1(title);
      b.text(reportText(d, key), { size: 10.5, gap: 8 });
    },
  });

  const sections: SectionPlan[] = [
    {
      id: "jurisdiction_intel",
      title: "Inteligencia Jurisdiccional",
      gatedInLimited: false,
      available: () => true,
      renderPdf: (b, d) => renderJurisdictionIntelligence(b, d),
    },
    {
      id: "exec",
      title: "Resumen Ejecutivo",
      gatedInLimited: false,
      available: () => true,
      renderPdf: (b, d) => renderExecutive(b, d, mode),
    },
    {
      id: "case_snapshot",
      title: "Instantánea del Expediente",
      gatedInLimited: false,
      available: (d) => (d.findings ?? []).length > 0 || d.documents.length > 0,
      renderPdf: (b, d) => renderCaseSnapshot(b, d),
    },

    {
      id: "recommended_motions",
      title: "Promociones Recomendadas",
      // Motion opportunities are ESS-gated, exactly like the old Action
      // Center: they disappear entirely in LIMITED mode rather than show a
      // half-populated page of inferred legal theories.
      gatedInLimited: true,
      available: (d) => {
        const rr = asObj(d.report);
        if (rr.motions_suppressed) return false;
        return asArr(rr.motion_opportunities).length > 0;
      },
      renderPdf: (b, d) => renderRecommendedMotions(b, d),
    },
    {
      id: "action_center",
      title: "Centro de Acción del Abogado",
      // Mirrors "opportunities"/"strategy_synthesis": all of its content is
      // ESS-gated strategy/work-product data, so it must disappear entirely
      // in LIMITED mode rather than show a half-populated page.
      gatedInLimited: true,
      available: (d) => {
        const rr = asObj(d.report);
        const suppressed = Boolean(rr.motions_suppressed);
        const wp = (d.work_product ?? []).filter(
          (w) => !suppressed || asStr(w.document_type) === "case_summary",
        );
        const generated = wp.filter(
          (w) => (asStr(w.body_markdown) || asStr(w.content)).trim().length > 40,
        );
        return (
          asArr(rr.next_actions).length > 0 ||
          asArr(rr.strategy_recommendations).length > 0 ||
          generated.length > 0
        );
      },
      renderPdf: (b, d) => renderActionCenter(b, d),
    },
    {
      id: "impact_dashboard",
      title: "Panel de Impacto Litigioso",
      // Same data as "scorecard" (the deterministic dimension scores), just
      // reframed as case-type-specific cards — gated the same way scorecard
      // and action_center already are, since it disappears exactly when
      // the underlying scores would.
      gatedInLimited: true,
      available: (d) => {
        const reportRow = (d.report ?? {}) as Record<string, unknown>;
        const dashboard = buildLitigationImpactDashboard(reportRow);
        return !dashboard.suppressed && dashboard.cards.length > 0;
      },
      renderPdf: (b, d) => renderLitigationImpactDashboard(b, d),
    },
    {
      id: "overview",
      title: "Panorama General del Expediente",
      gatedInLimited: false,
      available: () => true, // always renders (fallbackOverview)
      renderPdf: (b, d) => renderCaseOverview(b, d),
    },
    {
      id: "facts",
      title: "Hechos",
      gatedInLimited: false,
      available: (d) => !!reportText(d, "facts").trim() || (d.findings ?? []).length > 0,
      renderPdf: (b, d) => renderFacts(b, d),
    },
    {
      id: "timeline",
      title: "Resumen Cronológico",
      gatedInLimited: false,
      available: () => false, // Suppressed from final report display per directive
      renderPdf: (b, d) => renderTimelineSummary(b, d),
    },
    {
      id: "scorecard",
      title: "Tablero de Puntuación del Caso",
      gatedInLimited: true,
      available: (d) => {
        const score = asObj(d.score);
        const dims = asObj(asObj(asObj(score.dimension_breakdowns).deterministic).dimensions);
        return Object.keys(dims).length > 0 || Object.keys(score).length > 0;
      },
      renderPdf: (b, d) => renderScorecard(b, d),
    },
    {
      id: "risk",
      title: "Análisis de Riesgo",
      gatedInLimited: true,
      available: (d) =>
        !!reportText(d, "risk_analysis").trim() || typeof asObj(d.report).risk_score === "number",
      renderPdf: (b, d) => renderRiskAnalysis(b, d),
    },
    {
      id: "coverage",
      title: "Cobertura Probatoria",
      gatedInLimited: false,
      // Parse rate, OCR coverage, ingestion stats — pipeline QA information,
      // not attorney narrative. Same reasoning as Audit Trail above.
      available: (d) =>
        _citationMode === "audit" &&
        Object.keys(asObj(asObj(asObj(d.report).full_report).coverage_report)).length > 0,
      renderPdf: (b, d) => renderCoverage(b, d),
    },
    {
      id: "agent_stats",
      title: "Estadísticas de Agentes",
      gatedInLimited: false,
      // Which of the 13 internal agents ran, how many findings each
      // suppressed/promoted — pipeline internals, not attorney narrative.
      // Same reasoning as Audit Trail above.
      available: (d) =>
        _citationMode === "audit" &&
        (getAgentRows(d).length > 0 || getAgentSummary(getReportRow(d)).loaded > 0),
      renderPdf: (b, d) => renderAgentStatistics(b, d),
    },
    {
      id: "findings",
      title: "Hallazgos Clave",
      gatedInLimited: false,
      available: (d) => (d.findings ?? []).length > 0,
      renderPdf: (b, d) => renderKeyFindings(b, d),
    },
    {
      id: "evidence_map",
      title: "Mapa de Evidencia",
      gatedInLimited: false,
      // Per-document role/support/undermine classification reads as an
      // internal QA artifact rather than attorney narrative — audit-mode
      // only, same reasoning as the parity/ESS footer stamp above.
      available: (d) =>
        _citationMode === "audit" && asArr(asObj(d.report).evidence_index).length > 0,
      renderPdf: (b, d) => renderEvidenceMap(b, d),
    },
    {
      id: "discovery",
      title: "Análisis de Vacíos Probatorios",
      gatedInLimited: false,
      available: (d) =>
        !!reportText(d, "discovery_analysis").trim() ||
        asArr(asObj(d.report).missing_evidence_struct).length > 0,
      renderPdf: (b, d) => renderDiscoveryAnalysis(b, d),
    },
    {
      id: "evidence_intel",
      title: "Inteligencia Probatoria",
      gatedInLimited: false,
      available: (d) => (d.evidence_intel ?? []).length > 0,
      renderPdf: (b, d) => renderEvidenceIntel(b, d),
    },
    {
      id: "contradictions",
      title: "Análisis de Contradicciones",
      gatedInLimited: false,
      available: (d) => asArr(asObj(d.report).contradictions_struct).length > 0,
      renderPdf: (b, d) => renderContradictions(b, d),
    },
    {
      id: "constitutional",
      title: "Análisis Constitucional",
      gatedInLimited: false,
      available: (d) => {
        const ct = asStr(asObj(asObj(d.report).full_report).case_type) || "general_civil";
        // FIX (2026-07-29): same stale-key bug as renderConstitutional's own
        // internal gate (already fixed above) — this OUTER section-plan
        // gate is what actually decides whether the section appears in the
        // Table of Contents at all, so fixing only the inner gate would
        // have left this section permanently invisible regardless.
        return (
          (ct === "penal" || ct === "amparo" || ct === "constitucional") &&
          asArr(asObj(d.report).constitutional_issues_struct).length > 0
        );
      },
      renderPdf: (b, d) => renderConstitutional(b, d),
    },
    {
      id: "legal_issues",
      title: "Cuestiones Jurídicas y Jurisprudencia",
      gatedInLimited: false,
      available: (d) => asArr(asObj(asObj(d.report).full_report).legal_issues).length > 0,
      renderPdf: (b, d) => renderLegalIssues(b, d),
    },
    {
      id: "witnesses",
      title: "Inteligencia de Testigos",
      gatedInLimited: false,
      available: (d) => (d.witnesses ?? []).length > 0,
      renderPdf: (b, d) => renderWitnesses(b, d),
    },
    {
      id: "cross_exam",
      title: "Contrainterrogatorio",
      gatedInLimited: true,
      available: (d) => asArr(asObj(d.report).cross_examination).length > 0,
      renderPdf: (b, d) => renderCrossExamination(b, d),
    },
    {
      id: "perspectives",
      title: "Análisis Multi-Perspectiva",
      gatedInLimited: true,
      available: (d) => (d.perspectives ?? []).length > 0,
      renderPdf: (b, d) => renderPerspectives(b, d),
    },
    {
      id: "theories",
      title: "Análisis de Teoría del Caso",
      gatedInLimited: true,
      available: (d) => (d.theories ?? []).length > 0,
      renderPdf: (b, d) => renderTheories(b, d),
    },
    {
      id: "litigation_strategy_center",
      title: "Centro de Estrategia Litigiosa",
      gatedInLimited: true,
      available: (d) => {
        const sc = (d.strategy_center ?? {}) as Record<string, unknown>;
        const theme = asObj(sc.primary_trial_theme);
        return !!asStr(theme.theme) || asArr(sc.winning_the_case_dashboard).length > 0;
      },
      renderPdf: (b, d) => renderLitigationStrategyCenter(b, d),
    },
    {
      id: "opportunities",
      title: "Oportunidades Estratégicas",
      gatedInLimited: true,
      available: (d) => {
        const r = asObj(d.report);
        return (
          asArr(r.motion_opportunities).length > 0 ||
          asArr(r.strategy_recommendations).length > 0 ||
          asArr(r.next_actions).length > 0 ||
          asArr(r.missing_evidence_struct).length > 0
        );
      },
      renderPdf: (b, d) => renderStrategy(b, d),
    },
    {
      id: "strategy_synthesis",
      title: "Síntesis Estratégica",
      gatedInLimited: true,
      available: (d) => (d.strategy ?? []).length > 0,
      renderPdf: (b, d) => renderStrategySynthesis(b, d),
    },
    proseSec("recommendations", "Recommendations", "recommendations", true),
    {
      id: "work_product",
      title: "Producto de Trabajo del Abogado",
      gatedInLimited: false,
      available: (d) => (d.work_product ?? []).length > 0,
      renderPdf: (b, d) => renderWorkProduct(b, d),
    },
    {
      id: "audit",
      title: "Registro de Auditoría",
      gatedInLimited: false,
      // Execution manifest + per-file ingestion status/size/error table is
      // internal QA information, not attorney work product — an attorney
      // already knows what they uploaded. Audit-mode only, same reasoning
      // as Evidence Map and the footer parity/ESS stamp.
      available: (d) =>
        _citationMode === "audit" && (d.documents.length > 0 || d.agents.length > 0),
      renderPdf: (b, d) => renderAudit(b, d),
    },
    {
      id: "methodology",
      title: "Metodología NYRAVA",
      gatedInLimited: false,
      available: () => true,
      renderPdf: (b) => {
        b.h1("Metodología NYRAVA");
        b.text(METHODOLOGY_STATEMENT, { size: 10, gap: 8 });
      },
    },
    {
      id: "appendix",
      title: "Anexo: Citas de Fuentes",
      gatedInLimited: false,
      available: (d) => asArr(asObj(d.report).citations).length > 0,
      renderPdf: (b, d) => renderAppendix(b, d),
    },
    {
      id: "citation_audit",
      title: "Auditoría de Citas — Contenido No Verificado",
      // Not gated in LIMITED mode: this section's whole purpose is
      // transparency about what was withheld, so it must render even when
      // (especially when) the case has a thin corpus.
      gatedInLimited: false,
      available: (d) =>
        asArr(asObj(asObj(asObj(d.report).full_report).citation_audit).quarantined_findings).length > 0,
      renderPdf: (b, d) => renderCitationAudit(b, d),
    },
    {
      id: "rendered_report_qa",
      title: "Auditoría de Calidad del Reporte",
      // Not gated in LIMITED mode, same rationale as citation_audit above —
      // this section's whole purpose is transparency about detected
      // defects, so it must render even on a thin-corpus/LIMITED case.
      gatedInLimited: false,
      available: (d) => renderedQaCriticalIssues(d).length > 0,
      renderPdf: (b, d) => renderRenderedReportQa(b, d),
    },
    {
      id: "priority_action_center",
      title: "Centro de Acción — Recomendaciones Prioritarias",
      gatedInLimited: true,
      available: (d) => priorityActionRows(d).length > 0,
      renderPdf: (b, d) => renderPriorityActionCenter(b, d),
    },
    {
      id: "evidence_sources",
      title: "Fuentes de Evidencia",
      gatedInLimited: false,
      // Footnotes are populated by primeCitationFootnotes() before the
      // section plan/queue is built (and further deduped-idempotently as
      // other sections render), so by the time this predicate runs the
      // count already reflects every inline citation in the report body —
      // regardless of which section happened to render first. Only
      // meaningful in attorney mode; audit mode keeps citations inline and
      // never populates the footnote list.
      available: () => _footnotes.length > 0,
      renderPdf: (b) => renderEvidenceSources(b),
    },
  ];
  return sections;
}

function priorityActionRows(
  data: CaseExportData,
): Array<[string, string, string, string, string, string]> {
  const r = asObj(data.report);
  const full = asObj(r.full_report);
  const c = asObj(data.case);
  const pc = asObj(c.procedural_compliance);
  const deadlines = asArr(pc.deadlines as unknown as Array<Record<string, unknown>>);
  const notDetermined = () => rt("Not determined");

  const findAuthority = (title: string): string => {
    const hit = deadlines.find(
      (d) =>
        asStr(d.label_es).length > 0 &&
        title.toLowerCase().includes(asStr(d.label_es).toLowerCase()),
    );
    return hit ? asStr(hit.authority) : notDetermined();
  };

  const canonicalRecs = asArr(full.canonical_recommendations);
  const rows: Array<[string, string, string, string, string, string]> = canonicalRecs.map(
    (rec, i) => {
      const priority = asStr(rec.priority, "medium");
      const title = asStr(rec.title) || notDetermined();
      const reason = asStr(rec.reason) || notDetermined();
      const authority = findAuthority(title);
      const urgency = priority === "critical" || priority === "high" ? rt("High") : rt("Medium");
      const impact = asStr(rec.expectedImpact) || notDetermined();
      return [String(i + 1), rt(priority), title, reason, authority, `${urgency} — ${impact}`];
    },
  );
  return rows;
}

function renderPriorityActionCenter(b: PdfBuilder, data: CaseExportData) {
  const rows = priorityActionRows(data);
  if (!rows.length) return;
  b.h1("Centro de Acción — Recomendaciones Prioritarias");
  b.table(
    [
      [
        rt("Priority"),
        rt("Recommendation"),
        rt("Reason"),
        rt("Legal Basis / Authority"),
        rt("Urgency"),
        rt("Expected impact"),
      ],
    ],
    rows.map((row) => [
      row[1],
      row[2],
      row[3],
      row[4],
      row[5].split(" — ")[0],
      row[5].split(" — ")[1] ?? row[5],
    ]),
  );
}

function renderSuppressedSection(b: PdfBuilder, title: string) {
  b.h1(title);
  b.text("Suprimido por evidencia verificada insuficiente.", { size: 10.5, color: MUTED, gap: 8 });
}

// Determines which sections will actually appear and what each one will do.
// Suppressed sections are dropped entirely — no placeholder pages, no TOC
// entries — per directive: "If a section contains no evidence-supported
// content: do not create the page, do not include it in the Table of
// Contents, do not number it, do not print 'Suppressed...'".
function computeRenderQueue(plan: SectionPlan[], data: CaseExportData, mode: ReportMode) {
  const full = asObj(asObj(data.report).full_report);
  // The materia can live on the report payload, the report row, or (most
  // often for older cases) only on the case row itself. Export must read all
  // three before deciding the case is unclassified — a missing materia here
  // used to throw and silently kill the whole PDF download.
  const area = normalizePracticeArea(
    asStr(full.case_type) ||
      asStr(asObj(data.report).case_type) ||
      asStr(asObj(data.case).case_type) ||
      asStr(asObj(data.case).practice_area),
  );
  const ad = full.active_domains;
  const activeDomains: string[] = Array.isArray(ad) ? (ad as unknown[]).map((x) => String(x)) : [];
  const applicable = getApplicableSections(area, activeDomains);
  return plan
    .filter((s) => applicable.has(s.id))
    .filter((s) => {
      // Drop gated sections in LIMITED mode entirely.
      if ((mode === "LIMITED" || !presentation(data).capability.strategic_recommendations_allowed) && s.gatedInLimited) return false;
      // Drop sections with no evidence-supported content.
      return s.available(data);
    })
    .map((s) => ({ ...s, kind: "full" as const }));
}

function validateParity(opts: {
  mode: ReportMode;
  counters: { generated: number; verified: number; rendered: number };
  documentCount: number;
  tocIds: string[];
  renderedIds: string[];
  renderedFindingsLength?: number;
}): void {
  const errors: string[] = [];
  // Mode must be one of two values.
  if (opts.mode !== "FULL" && opts.mode !== "LIMITED") errors.push("invalid report mode");
  // Counter monotonicity.
  if (opts.counters.rendered > opts.counters.verified) errors.push("rendered > verified findings");
  if (opts.counters.verified > opts.counters.generated)
    errors.push("verified > generated findings");
  // The cover-page "rendered" count must equal the length of the findings
  // array actually rendered in the Key Findings section. This is the
  // invariant that would have caught the cover-page-vs-table mismatch
  // (e.g. "6 rendered findings" on the cover, 3 rows in the table).
  if (
    typeof opts.renderedFindingsLength === "number" &&
    opts.counters.rendered !== opts.renderedFindingsLength
  ) {
    errors.push(
      `rendered findings counter (${opts.counters.rendered}) does not match findings actually rendered (${opts.renderedFindingsLength})`,
    );
  }
  // TOC ↔ rendered must match exactly.
  if (
    opts.tocIds.length !== opts.renderedIds.length ||
    opts.tocIds.some((id, i) => id !== opts.renderedIds[i])
  ) {
    errors.push("TOC and rendered section list disagree");
  }
  if (opts.documentCount < 0) errors.push("invalid document count");
  if (errors.length) {
    throw new Error(`Report parity validation failed: ${errors.join("; ")}`);
  }
}

// Short matter/docket identifier for the running header band. Prefers a
// real docket number when the matter carries one; otherwise falls back to
// the short case id. Never the full case title — it clips at the page edge.
function deriveMatterId(data: CaseExportData): string {
  const c = asObj(data.case);
  const docket = asStr(c.docket_number) || asStr(c.case_number) || asStr(c.matter_id);
  if (docket.trim()) return docket.trim();
  const id = asStr(c.id).slice(0, 8).toUpperCase();
  return id || "NYRAVA";
}

export async function downloadPdf(
  data: CaseExportData,
  name: string,
  opts?: { citationMode?: CitationMode; validateOnly?: boolean },
) {
  data = (data as FinalReportPayload).report_presentation ? structuredClone(releaseFinalReportPayload(data)) : composeFinalReportPayload(data);
  // Explicit, redundant release-gate check at the actual point of export —
  // do not rely solely on the upstream content-stripping in
  // cases.functions.ts::getCase() (sanitizeBlockedReport). That fix removes
  // the substantive fields a blocked report would need to render anything
  // meaningful, but this file must not assume every caller went through
  // that exact path. "Do not rely on frontend controls for release
  // security" applies here too: this is backend/client-shared code, but
  // the check belongs at the point of action, not just upstream.
  if (asObj(data.report).quality_blocked === true) {
    throw new Error(
      "REPORT_BLOCKED: This report failed its release/quality gate and cannot be exported.",
    );
  }
  // Attorney mode (default): inline "[DOC N p.M]" citations become numbered
  // footnotes resolved to real document titles, collected in an Evidence
  // Sources appendix. Audit mode: citations stay inline but are rewritten to
  // name the real document + page instead of an internal "DOC N" id. Must
  // run before buildSectionPlan/computeRenderQueue — several sections'
  // `available()` checks call reportText(), which now runs through the
  // citation processor as a side effect.
  // Single-language guarantee: the whole template renders in the language the
  // report's AI content was generated in (reports.generated_language, falling
  // back to cases.report_language for rows written before that column).
  setReportTemplateLocale(resolveReportLocale(data.report, data.case));
  initCitationContext(data, opts?.citationMode ?? "attorney");
  primeCitationFootnotes(data);

  const b = new PdfBuilder(name, deriveMatterId(data));
  await b.loadLogo();
  const reportRow = (data.report ?? {}) as Record<string, unknown>;

  const mode = getReportMode(reportRow);
  // `getFindingCounters` derives "rendered" from the report's embedded
  // full_report.intelligence.consolidated_findings JSON, which is written
  // once at report-generation time and can go stale. The PDF body (cover
  // stat card, Key Findings table, timeline, risk section) all render from
  // `data.findings` instead — the live findings actually passed into this
  // export. Those two counts can drift apart (e.g. 7 vs 5), which is
  // exactly the mismatch validateParity() below is designed to catch.
  // Fix: always report "rendered" as data.findings.length, since that is
  // the ONLY number that is actually true of what this PDF prints.
  // The stale JSON counters can also under-report verified/generated relative
  // to the live findings (e.g. stale verified=0 but one live finding), which
  // used to trip the "rendered > verified" parity check and abort the whole
  // download. Live rendered count is authoritative; raise the stale
  // upper-bound counters to stay monotonic instead of failing the export.
  const rawCounters = getFindingCounters(reportRow);
  const renderedCount = (data.findings ?? []).length;
  const verifiedCount = Math.max(rawCounters.verified, renderedCount);
  const counters = {
    ...rawCounters,
    rendered: renderedCount,
    verified: verifiedCount,
    generated: Math.max(rawCounters.generated, verifiedCount),
  };
  const parity = paritySignature(reportRow);
  const ess = getEssState(reportRow);
  const engines = getEnginesSummary(reportRow);
  const generatedAt = new Date().toISOString();
  let parityShort = 0;
  for (let i = 0; i < parity.length; i++)
    parityShort = ((parityShort << 5) - parityShort + parity.charCodeAt(i)) | 0;
  const parityTag = (parityShort >>> 0).toString(16).padStart(8, "0").slice(0, 8);

  // Build one section plan and one render queue used by both the TOC and
  // the body. The TOC therefore mirrors the rendered output exactly.
  const plan = buildSectionPlan(mode);
  const queue = computeRenderQueue(plan, data, mode);
  (data as FinalReportPayload).report_presentation.render_sections = queue.map(section => ({
    id: section.id, title: section.title, strategic: section.gatedInLimited,
  }));
  data = releaseFinalReportPayload(data);

  const coverFooterSpilled = renderCover(b, data, mode, counters);
  // Cover stands alone; TOC starts on its own page. After this, sections
  // flow naturally without forced page breaks. Exception: if the cover's
  // trailing footer note already had to spill onto a new page (long
  // dashboard content pushed it past the bottom margin), that page is
  // already fresh and nearly empty — start the TOC there instead of
  // forcing yet another page break, which would otherwise leave a page
  // holding nothing but one sentence.
  if (!coverFooterSpilled) {
    b.pageBreak();
  } else {
    b.y += 18;
  }

  // ===== Table of Contents — derived from the same queue =====
  b.h1("Índice", "Contenido");
  b.table(
    [["#", "Sección"]],
    queue.map((s, i) => [String(i + 1), s.title]),
    { plainHead: true },
  );

  // Render body in exact same order as TOC.
  for (const s of queue) {
    s.renderPdf(b, data);
  }

  validateParity({
    mode,
    counters,
    documentCount: data.documents.length,
    tocIds: queue.map((s) => s.id),
    renderedIds: queue.map((s) => s.id),
    renderedFindingsLength: (data.findings ?? []).length,
  });

  // Closing branding page: mark, domain, engine version/timestamp, and the
  // standing "verify before filing" disclaimer. Appended after content and
  // parity validation (it carries no analytical content of its own, so it
  // has no bearing on parity), but before save() so it still gets the
  // normal continuation header and page-numbered footer.
  b.closingPage({ generatedAt });

  // Footer reflects the SINGLE report state.
  const footerEss =
    mode === "LIMITED" ? `${ess.level} · ${mode} · scores suppressed` : `${ess.level} · ${mode}`;
  b.finalPayload = data as FinalReportPayload;
  return b.save(`${slug(name)}.pdf`, {
    parity: parityTag,
    ess: footerEss,
    generatedAt,
  }, opts?.validateOnly);
}

/** Same real section renderers used by downloads; in-memory only, no publication.
 * Final backend release waits for all PDF transforms, labels and appendices. */
let preflightTail: Promise<void> = Promise.resolve();
export async function prepareFinalReportForRelease(data: CaseExportData): Promise<FinalReportPayload> {
  // Existing renderer locale/citation collectors are module-local. Serialize
  // server preflights so concurrent cases cannot share those mutable collectors.
  const previous = preflightTail;
  let done!: () => void;
  preflightTail = new Promise<void>(resolve => {done=resolve;});
  await previous;
  try {
    const name = asStr(data.case?.name, "Report");
    const pdf = await downloadPdf(data, name, {validateOnly:true});
    return pdf;
  } finally { done(); }
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "case"
  );
}
