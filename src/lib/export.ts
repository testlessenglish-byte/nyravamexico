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
import { assertPdfLayout, auditPdfLayout, type PdfLayoutIssue, type PdfLayoutPage } from "./pdf/layout-qa";

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
const PRIMARY: [number, number, number] = [124, 58, 237]; // deep violet (#5B21B6)
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
  const history = presentation(data).procedural_history;
  if (history?.length) {
    b.h2("ANTECEDENTES PROCESALES — NO SON EL RESULTADO ACTUAL");
    for (const item of history) b.text(item.text, { size: 10, gap: 5 });
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
  private layoutPages: PdfLayoutPage[] = [{ contentMarks: 0, maxContentY: 0 }];
  private layoutIssues: PdfLayoutIssue[] = [];
  private finalPageCount: number | null = null;

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
      const page = this.doc.getCurrentPageInfo().pageNumber;
      const x = typeof rest[0] === "number" ? rest[0] : 0;
      const y = typeof rest[1] === "number" ? rest[1] : 0;
      const state = this.layoutPages[page - 1] ?? { contentMarks: 0, maxContentY: 0 };
      state.contentMarks += 1;
      state.maxContentY = Math.max(state.maxContentY, y);
      this.layoutPages[page - 1] = state;
      if (page > 1 && (x < this.margin - 1 || x > this.pageW - this.margin + 1 || y > this.printableBottom + 1)) {
        this.layoutIssues.push({
          code: "CONTENT_OUTSIDE_PRINTABLE_BOUNDS",
          page,
          detail: `Text baseline at (${x.toFixed(1)}, ${y.toFixed(1)}) is outside the printable area.`,
        });
      }
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
      this.layoutPages.push({ contentMarks: 0, maxContentY: 0 });
      const fill = this.doc.getFillColor?.();
      this.doc.setFillColor(...PAGE_BG);
      this.doc.rect(0, 0, this.pageW, this.pageH, "F");
      if (fill) this.doc.setFillColor(fill);
      return res;
    };
  }

  get printableTop() {
    return this.margin + CONTINUATION_HEADER_H;
  }

  get printableBottom() {
    return this.pageH - this.margin - 26;
  }

  get printableWidth() {
    return this.pageW - this.margin * 2;
  }

  remainingHeight() {
    return Math.max(0, this.printableBottom - this.y);
  }

  /** Loads the real crest image once, before any drawing happens. Must be
   * awaited by the caller (downloadPdf) right after construction — every
   * other builder method stays synchronous because by the time they run,
   * this has already resolved. */
  async loadLogo() {
    this.logoBase64 = await getLogoBase64();
  }

  ensureSpace(needed: number) {
    if (needed > this.printableBottom - this.printableTop) return;
    if (needed > this.remainingHeight()) {
      this.doc.addPage();
      this.y = this.printableTop;
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
    const BG_PURPLE: [number, number, number] = [124, 58, 237]; 
    const GOLD: [number, number, number] = [217, 185, 120];
    const WHITE: [number, number, number] = [255, 255, 255];
    
    this.doc.setFillColor(...BG_PURPLE);
    this.doc.rect(0, 0, pageW, pageH, "F");

    // Lady Justice background (bright purple variant)
    const bgB64 = "data:image/jpeg;base64,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";
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

    // Large centered report title. The title and identity occupy bounded
    // regions; unusually long names therefore cannot push metadata into the
    // classification and certification area at the foot of the cover.
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
    ty = 350;
    this.doc.setFont("times", "bold");
    let caseNameSize = 24;
    this.doc.setFontSize(caseNameSize);
    let caseNameLines = this.doc.splitTextToSize(opts.caseName || "ADR 3265/2023", pageW - margin * 2) as string[];
    while (caseNameLines.length > 2 && caseNameSize > 18) {
      caseNameSize -= 1;
      this.doc.setFontSize(caseNameSize);
      caseNameLines = this.doc.splitTextToSize(opts.caseName || "ADR 3265/2023", pageW - margin * 2) as string[];
    }
    const caseNameLeading = caseNameSize + 4;
    for (const line of caseNameLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += caseNameLeading;
    }
    
    ty += 4;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(18);
    const proceedingLines = this.doc.splitTextToSize(opts.proceeding || "No determinado con la documentación disponible", pageW - margin * 2) as string[];
    for (const line of proceedingLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += 21;
    }

    ty += 4;
    this.doc.setFont("times", "normal");
    let courtSize = 15;
    this.doc.setFontSize(courtSize);
    let courtLines = this.doc.splitTextToSize(opts.court || "No determinado con la documentación disponible", pageW - margin * 2) as string[];
    while ((ty + courtLines.length * (courtSize + 3)) > 486 && courtSize > 11) {
      courtSize -= 1;
      this.doc.setFontSize(courtSize);
      courtLines = this.doc.splitTextToSize(opts.court || "No determinado con la documentación disponible", pageW - margin * 2) as string[];
    }
    for (const line of courtLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += courtSize + 3;
    }

    // Metadata table. Labels and values have separate measured columns so a
    // long label (notably "ÓRGANO JURISDICCIONAL") can never run into its
    // value. Each row grows to the taller wrapped side instead of assuming a
    // fixed 20pt height.
    ty = 505;
    const metadataLeft = margin + 54;
    const metadataDivider = cx - 34;
    const metadataRight = metadataDivider + 14;
    const metadataLabelWidth = metadataDivider - metadataLeft - 18;
    const metadataValueWidth = pageW - margin - 54 - metadataRight;
    const metadataLabelSize = 7.5;
    const metadataValueSize = 8.5;
    const metadataLabelLeading = 9;
    const metadataValueLeading = 10;
    
    const fields = [
      { k: "CLIENTE", v: opts.client || "Confidencial" },
      { k: "EXPEDIENTE", v: opts.matterId || "No determinado" },
      { k: "TIPO DE ASUNTO", v: opts.proceeding || "No determinado" },
      { k: "ÓRGANO JURISDICCIONAL", v: opts.court || "No determinado con la documentación disponible" },
      { k: "MATERIA", v: opts.matterType || "No determinado" },
      { k: "FECHA DEL ANÁLISIS", v: opts.date || "14 de septiembre de 2026" },
      { k: "NYRAVA MATTER ID", v: (opts.matterId || "44C5492F").slice(0, 8) }
    ];

    const metadataRows = fields
      .filter((field) => Boolean(field.v))
      .map((field) => {
        this.doc.setFont("helvetica", "normal");
        this.doc.setFontSize(metadataLabelSize);
        const labelLines = this.doc.splitTextToSize(spaced(field.k), metadataLabelWidth) as string[];
        this.doc.setFontSize(metadataValueSize);
        const valueLines = this.doc.splitTextToSize(field.v, metadataValueWidth) as string[];
        const height = Math.max(
          labelLines.length * metadataLabelLeading,
          valueLines.length * metadataValueLeading,
        ) + 7;
        return { labelLines, valueLines, height };
      });
    const metadataHeight = metadataRows.reduce((sum, row) => sum + row.height, 0);

    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(0.5);
    this.doc.line(metadataDivider, ty - 8, metadataDivider, ty + metadataHeight - 3);

    let metadataRow = 0;
    for (const f of fields) {
      if (f.v) {
        const row = metadataRows[metadataRow];
        metadataRow += 1;
        if (!row) continue;
        this.doc.setFont("helvetica", "normal");
        this.doc.setFontSize(metadataLabelSize);
        this.doc.setTextColor(...GOLD);
        row.labelLines.forEach((line, index) => {
          this.doc.text(line, metadataLeft, ty + index * metadataLabelLeading);
        });
        this.doc.setFontSize(metadataValueSize);
        this.doc.setTextColor(255, 255, 255);
        row.valueLines.forEach((line, index) => {
          this.doc.text(line, metadataRight, ty + index * metadataValueLeading);
        });
        ty += row.height;
      }
    }

    // Classification box has its own bounded region below metadata.
    ty = Math.max(640, ty + 12);
    const classificationWidth = 240;
    const classificationTextWidth = classificationWidth - 24;
    const rawClassification = (opts.classification || "CONFIDENCIAL").toUpperCase();
    const classification = rawClassification.length <= 20 ? spaced(rawClassification) : rawClassification;
    this.doc.setFont("times", "bold");
    let classificationSize = 14;
    this.doc.setFontSize(classificationSize);
    let classificationLines = this.doc.splitTextToSize(classification, classificationTextWidth) as string[];
    while (classificationLines.length > 2 && classificationSize > 10) {
      classificationSize -= 1;
      this.doc.setFontSize(classificationSize);
      classificationLines = this.doc.splitTextToSize(classification, classificationTextWidth) as string[];
    }
    const classificationHeight = Math.max(35, classificationLines.length * 17 + 14);
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(1);
    this.doc.rect(cx - classificationWidth / 2, ty, classificationWidth, classificationHeight, "S");
    
    this.doc.setTextColor(...GOLD);
    classificationLines.forEach((line, index) => {
      this.doc.text(line, cx, ty + 22 + index * 17, { align: "center" });
    });

    // Certification text
    ty = Math.max(710, ty + classificationHeight + 20);
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(10.5);
    this.doc.setTextColor(255, 255, 255);
    const certificationLines = this.doc.splitTextToSize(
      "Sustentado en evidencia. Citas auditadas. Diseñado para trabajo de inteligencia jurídica sensible.",
      pageW - margin * 2 - 140,
    ) as string[];
    certificationLines.forEach((line, index) => {
      this.doc.text(line, cx, ty + index * 14, { align: "center" });
    });

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

    // Page numbering is painted only after final pagination is complete.
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
    const fullGridHeight = rows * (h + gap);
    if (fullGridHeight <= this.printableBottom - this.printableTop) this.ensureSpace(fullGridHeight);
    for (let row = 0; row < rows; row++) {
      this.ensureSpace(h + gap);
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
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(20);
    const titleLines = this.doc.splitTextToSize(rt(label), this.printableWidth) as string[];
    const headingHeight = 26 + titleLines.length * 25 + 22;
    this.ensureSpace(headingHeight + 36);
    this.sectionTitle(kicker ?? SECTION_KICKERS[label] ?? label, label);
  }

  h2(label: string) {
    // Quiet subsection header: uppercase small-caps label with a hairline
    // rule beneath it, no filled tinted bar. Reads as editorial, not as
    // a boxed dashboard card.
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(10);
    const lines = this.doc.splitTextToSize(rt(label).toUpperCase(), this.printableWidth) as string[];
    this.ensureSpace(32 + lines.length * 13 + 22);
    this.y += 16;
    this.doc.setTextColor(...PRIMARY);
    this.doc.text(lines, this.margin, this.y);
    this.y += Math.max(0, (lines.length - 1) * 13);
    this.y += 6;
    this.doc.setDrawColor(230, 233, 238);
    this.doc.setLineWidth(0.5);
    this.doc.line(this.margin, this.y, this.pageW - this.margin, this.y);
    this.y += 16;
  }

  // Same quiet subsection header as h2(), but with a small colored dot
  // beside the label to signal severity tier at a glance.
  h2Tier(label: string, color: [number, number, number]) {
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(10);
    const lines = this.doc.splitTextToSize(rt(label).toUpperCase(), this.printableWidth - 12) as string[];
    this.ensureSpace(32 + lines.length * 13 + 22);
    this.y += 16;
    this.doc.setFillColor(...color);
    this.doc.circle(this.margin + 3, this.y - 3, 2.8, "F");
    this.doc.setTextColor(...PRIMARY);
    this.doc.text(lines, this.margin + 12, this.y);
    this.y += Math.max(0, (lines.length - 1) * 13);
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
    const valueWidth = this.printableWidth - 110;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(10.5);
    const lines = this.doc.splitTextToSize(value, valueWidth) as string[];
    const height = Math.max(16, lines.length * 14);
    this.ensureSpace(height);
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(9);
    this.doc.setTextColor(...MUTED);
    this.doc.text(label.toUpperCase(), this.margin, this.y);
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(10.5);
    this.doc.setTextColor(...PRIMARY);
    this.doc.text(lines, this.margin + 110, this.y);
    this.y += height;
  }

  callout(label: string, value: string, color: [number, number, number] = ACCENT) {
    const x = this.margin;
    const w = this.pageW - this.margin * 2;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(11);
    const lines = this.doc.splitTextToSize(value, w - 28) as string[];
    const h = Math.max(40, 27 + lines.length * 14);
    this.ensureSpace(h + 12);
    // Quiet callout: no border, subtle fill, thin colored left rule.
    this.doc.setFillColor(249, 250, 252);
    this.doc.roundedRect(x, this.y, w, h, 3, 3, "F");
    this.doc.setFillColor(...color);
    this.doc.rect(x, this.y, 2.5, h, "F");
    this.doc.setTextColor(...color);
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(8);
    this.doc.text(label.toUpperCase(), x + 14, this.y + 15);
    this.doc.setTextColor(...PRIMARY);
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(11);
    this.doc.text(lines, x + 14, this.y + 31);
    this.y += h + 12;
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
    const textW = this.printableWidth - 48;
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(11);
    const headlineLines = this.doc.splitTextToSize(headline.toUpperCase(), textW) as string[];
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(9);
    const sublineLines = subline ? (this.doc.splitTextToSize(subline, textW) as string[]) : [];
    const h = Math.max(40, 18 + headlineLines.length * 13 + sublineLines.length * 11);
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
    let textY = this.y + 17;
    this.doc.text(headlineLines, x + 30, textY);
    textY += headlineLines.length * 13;
    if (sublineLines.length) {
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(9);
      this.doc.setTextColor(...MUTED);
      this.doc.text(sublineLines, x + 30, textY);
    }
    this.y += h + 22;
  }

  // One compact scannable row for a "Top Findings" preview — a colored
  // severity dot, the title, and a right-aligned severity/confidence pill.
  // Deliberately terse (title only, no description) since its job is a
  // 3-second scan, not the full write-up — that lives in Key Findings.
  findingChip(severity: string, title: string, confidence: number) {
    const maxW = this.pageW - this.margin * 2 - 150;
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(11);
    const titleLines = this.doc.splitTextToSize(title, maxW) as string[];
    const h = Math.max(26, titleLines.length * 14 + 12);
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
    this.doc.text(titleLines, this.margin + 14, yy + 17);
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
    const attrLines = attribution
      ? (this.doc.splitTextToSize(attribution, innerW) as string[])
      : [];
    const h = lines.length * 12 + attrLines.length * 11 + 14;
    if (h > this.printableBottom - this.printableTop) {
      this.table([], [[`“${text}”${attribution ? `\n${attribution}` : ""}`]], {
        columnStyles: { 0: { cellWidth: this.printableWidth, fontStyle: "italic", textColor: MUTED } },
      });
      return;
    }
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
      keepTogether?: boolean;
    } = {},
  ) {
    if (body.length === 0) return;
    const availableWidth = this.printableWidth;
    const supplied = Object.values(opts.columnStyles ?? {}).reduce((sum: number, style: any) => {
      return sum + (typeof style?.cellWidth === "number" ? style.cellWidth : 0);
    }, 0);
    if (supplied > availableWidth + 0.5) {
      this.layoutIssues.push({
        code: "TABLE_WIDTH_OVERFLOW",
        page: this.doc.getCurrentPageInfo().pageNumber,
        detail: `Configured table columns total ${supplied.toFixed(1)}pt; printable width is ${availableWidth.toFixed(1)}pt.`,
      });
    }
    const estimatedRows = Math.min(body.length, 8) * 28 + (head.length ? 30 : 0);
    if (opts.keepTogether && estimatedRows <= this.printableBottom - this.printableTop) {
      this.ensureSpace(estimatedRows);
    } else {
      this.ensureSpace(40);
    }
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
      tableWidth: availableWidth,
      horizontalPageBreak: false,
      showHead: head.length ? "everyPage" : "never",
      rowPageBreak: "avoid",
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
      if (i === 1) {
        this.doc.setFont("times", "normal");
        this.doc.setFontSize(10);
        this.doc.setTextColor(255, 255, 255);
        const pageWord = getReportTemplateLocale() === "en" ? "Page" : "Página";
        this.doc.text(`${pageWord} 1 / ${pageCount}`, this.pageW - 36, this.pageH - 40, { align: "right" });
        continue;
      }
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

  private removeBlankInteriorPages() {
    for (let page = this.doc.getNumberOfPages() - 1; page >= 2; page -= 1) {
      if ((this.layoutPages[page - 1]?.contentMarks ?? 0) !== 0) continue;
      this.doc.deletePage(page);
      this.layoutPages.splice(page - 1, 1);
    }
  }

  finalizeLayout(meta: { parity: string; ess: string; generatedAt: string } | null = null) {
    if (this.finalPageCount !== null) return;
    this.removeBlankInteriorPages();
    this.finalPageCount = this.doc.getNumberOfPages();
    const issues = auditPdfLayout({
      pages: this.layoutPages,
      pageCount: this.doc.getNumberOfPages(),
      expectedPageCount: this.finalPageCount,
      recordedIssues: this.layoutIssues,
    });
    assertPdfLayout(issues);
    this.header();
    this.footer(meta);
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
    this.finalizeLayout(meta);
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
    matterType: translateLegalTerm(identity.matterType),
    court: translateLegalTerm(identity.court),
    jurisdiction: translateLegalTerm(identity.jurisdiction),
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
    const caseType = asStr(fullReport.case_type) || asStr(breakdowns.case_type);
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
    const clientName = resolveReportIdentity(asObj(data.case)).client;
    const perspectiveBase = clientName ? "Fortaleza de la posición de " + clientName : "Fortaleza de la posición";
    const strengthCaption = isCriminal
      ? `${perspectiveBase} ${strength} / 100 (caso del Ministerio Público; un valor menor favorece a la defensa)  •  Puntuación de riesgo ${risk} / 100`
      : `${perspectiveBase} ${strength} / 100  •  Puntuación de riesgo ${risk} / 100`;
    b.statusBanner(headline, strengthCaption, b.scoreColor(risk, true));

    b.gaugeRow([
      { label: clientName ? "Fortaleza de la posición" : "Fortaleza de la Posición", value: strength, color: b.scoreColor(strength) },
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
  cards.push({ label: rt("Documents Analyzed"), value: String(data.documents.length) });
  cards.push({ label: rt("Findings (Total)"), value: String(counters.rendered) });
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
    asStr(fullReport.case_type) || asStr(asObj(breakdowns).case_type);
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
  const caseType = asStr(full.case_type);
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
      asStr(c.topic),
      resolveDocTitle(c.doc_n) ?? asStr(c.doc_n),
      asStr(c.page),
      asStr(c.quote),
    ]),
    {
      columnStyles: {
        0: { cellWidth: 22 }, // #
        1: { cellWidth: 82 },
        2: { cellWidth: 105 },
        3: { cellWidth: 34 },
        4: { cellWidth: 261 },
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
        const ct = asStr(asObj(asObj(d.report).full_report).case_type);
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
