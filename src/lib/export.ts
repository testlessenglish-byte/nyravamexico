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
    const BG_PURPLE: [number, number, number] = [124, 58, 237]; 
    const GOLD: [number, number, number] = [217, 185, 120];
    const WHITE: [number, number, number] = [255, 255, 255];
    
    this.doc.setFillColor(...BG_PURPLE);
    this.doc.rect(0, 0, pageW, pageH, "F");

    // Lady Justice background (bright purple variant)
    const bgB64 = "data:image/jpeg;base64,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juJIb9KegDWVchkyoJ+Y05nYMT5fHT605W+Qlhk54J7U1d2cuvDcjHalfUExxVFzj5lA7DnNIM5+ZhlR8opdxKMUPHfI5NNfO7DLgjqB3FK+oajg/wA5ITp2NOKqrHyyTn0/lTPNy+HTIAxupynaMbzuHfHWk2IXDEAZ4bqfSpY1VuTye4HamBghzsxnpUirkAn16jvWcmMfCu7O9sZ7EVLEisME4I6Z70wqAuC3zdjUiAjHPB61zzbESwox+Qnp0zUpIDbd+BjtVzw9osWs3RtppXRI03Fl6mtuDS/DtkQUsxLIO8nWvJxGNhSly7sDC07Sb/VX8u2hIiz88z8ACuiUWmiaeun2pyc/M+OWPqaSXUn8sww7UUdCKqSCKSQmSUlj15615VWtUxEtdEANckfu2T33Uw3ChwWj4pfKtlfDyHp60eRa5AMxwevPShJLQAN2obIiBOMEmla6iQcQZ9DTha2JzmU+43UqWlies5BP+0MUXiA0ajCuN1tn146U5NShLfNacDgcUq2Fh91pjnP94U5dL08s2677f3hzSvECSiiiv0wzCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigArlPieAfsIP/TX/ANkrq65T4ndbH/tr/wCyVz4r+A/66gcmAEOAeffvSIC4yG+tKrBuv4ZpFDDgf/rrxxCgEjaD+XelJAyuOT3oG4ZKEdMYoxsHue4pgwOQuM9KXIPTt6UHPb060igYz19aBgrfNg9e3rSsSBt6+9Nyd/XinNjGCKauABMcFs5peABgUikEZ/Sl5A9qaAQncu8jqcUEAJgNn2HejGDwKFjABxzk0bgBKkABuc04NldpPSmkDOeBilw2euTTDYRcgbQevTBpcBHBfr796MAcgZ9hSll6uMigY44C7wM5oZ8/eFAYFMgfnTScqFz+lBVxw4baByaGYAFTnPvQcAYUAc9TSBDgMRz05700CHsRsL7scYwBSKBjd69aRtpBz+lJwowp696a3AcQoG4N16ZpEIORnGKVVGASMn3o+VyQPyFO4wBAOPelwThsHn1pp2j5j2pyuSOVyO1FwAoFOCMg+lLgIMZGD7daapZ2we/alUqASevbAp3AAQx6845HaliG3ndjHU+tChXG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";
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
