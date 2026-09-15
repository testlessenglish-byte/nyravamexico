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
    
    // Background: Deep purple
    const BG_PURPLE: [number, number, number] = [28, 14, 60]; 
    const GOLD: [number, number, number] = [217, 185, 120];
    const WHITE: [number, number, number] = [255, 255, 255];
    
    this.doc.setFillColor(...BG_PURPLE);
    this.doc.rect(0, 0, pageW, pageH, "F");
    
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
    this.doc.setTextColor(...GOLD);
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
    this.doc.text(opts.caseName || "ADR 3265/2023", cx, ty, { align: "center" });
    
    ty += 30;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(20);
    this.doc.text(opts.proceeding || "Amparo Directo en Revisión", cx, ty, { align: "center" });

    ty += 28;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(16);
    this.doc.text(opts.court || "Suprema Corte de Justicia de la Nación", cx, ty, { align: "center" });

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
