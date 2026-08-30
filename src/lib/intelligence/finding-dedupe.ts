// Duplicate-finding consolidation — PURE MODULE (no I/O, no AI).
//
// WHY: engines and agents frequently emit several findings that describe the
// SAME underlying legal issue with different wording (e.g. "Cadena de custodia
// interrumpida", "Ruptura de la cadena de custodia del arma", "Falta de
// registro en la cadena de custodia"). Each one is real, but shown separately
// they make the report long and repetitive.
//
// CONTRACT (must never be violated):
//   1. Nothing is lost. Every evidence ref, citation, source doc id,
//      supporting engine and tag from a merged duplicate is unioned into the
//      surviving finding. The duplicates' full titles/descriptions are kept in
//      `_merged` / metadata so no legal analysis disappears.
//   2. Only true duplicates merge. Within one category two findings must be
//      lexically near-identical (token Jaccard over title, corroborated by the
//      description) — OR rest on the literal identical quoted evidence text,
//      which is strong enough corroboration on its own regardless of title
//      wording. ACROSS categories — the cross-engine case, where two engines
//      emit the same canonical issue under their own category label — the bar
//      is deliberately much higher AND requires independent corroboration
//      (shared evidence/source docs, or strongly agreeing descriptions).
//      Merged rows carry the UNION of the categories.
//   3. Materia-agnostic. No practice-area vocabulary is hard-coded here, so it
//      behaves identically for penal, laboral, amparo, civil, etc.
//   4. Order-stable: the surviving row keeps the input order of its cluster's
//      strongest member, so report layout is unchanged apart from the removal
//      of duplicated rows.

const SEV_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

// Epistemic status outranks severity when choosing the survivor INSIDE an
// already-established duplicate cluster. A verified court holding must never
// lose to a high-severity "possible" restatement of that same proposition.
// This is exactly the ADR failure where "Inconstitucionalidad del artículo
// 470" (the SCJN's holding) coexisted with "Posible inconstitucionalidad..."
// and the speculative version could win simply because severity/confidence
// were numerically higher. Severity describes impact, not truth status.
const EPISTEMIC_RANK: Record<string, number> = {
  VERIFIED_COURT_HOLDING: 0,
  VERIFIED_FACT: 1,
  VERIFIED_LEGAL_RULE: 2,
  SUPPORTED_INFERENCE: 3,
  POTENTIAL_ISSUE: 4,
  EVIDENCE_GAP: 5,
  NOT_FOUND: 6,
};

const STOPWORDS = new Set([
  "de",
  "la",
  "el",
  "los",
  "las",
  "del",
  "al",
  "y",
  "o",
  "en",
  "un",
  "una",
  "unos",
  "unas",
  "por",
  "para",
  "con",
  "sin",
  "que",
  "se",
  "su",
  "sus",
  "es",
  "son",
  "the",
  "of",
  "a",
  "an",
  "to",
  "and",
  "in",
  "on",
  "for",
  "is",
  "are",
]);

/** Accent-folded, punctuation-stripped lowercase text. */
export function normalizeText(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Exported for claim-evidence-relevance.ts — same tokenization (accent-fold,
// stopword-strip, light stem) so a token that would make two findings look
// like duplicates here is the identical token used to check whether a
// finding's own cited quote actually relates to its own claim there. One
// tokenizer, not two that could quietly drift apart.
export function tokens(s: unknown): Set<string> {
  return new Set(
    normalizeText(s)
      .split(" ")
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
      // Light stem: Spanish inflections ("contractual"/"contrato",
      // "vulneracion"/"vulnerar") differ only past the first few characters.
      .map((t) => t.slice(0, 6)),
  );
}

/** Token-level Jaccard similarity in [0,1]. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Canonical Reconciliation Design (2026-08-16), P2 §10 — a deliberately soft
 * "is this text at all grounded in something already known" check, distinct
 * from clusterBySameIssue's much stricter near-duplicate thresholds
 * (titleThreshold 0.55 / titleFallbackThreshold 0.4) above. Used where a
 * synthesis-style engine (litigation.server.ts's Litigation Strategy Center)
 * independently characterizes something a DIFFERENT, addFindings-routed
 * producer already computed for the same case — this is informational
 * visibility ("does this share any meaningful text with known content"),
 * never a hard reject: the synthesis engine is legitimately allowed to add
 * real insight beyond what's already known. Returns null (not false) when
 * there is nothing to compare against at all — absence of candidates is not
 * evidence of a mismatch.
 */
export const SOFT_GROUNDING_THRESHOLD = 0.12;

export function isGroundedByTextOverlap(
  text: string,
  candidates: ReadonlyArray<string>,
  threshold: number = SOFT_GROUNDING_THRESHOLD,
): boolean | null {
  if (!text.trim() || candidates.length === 0) return null;
  const textTokens = tokens(text);
  const best = candidates.reduce((max, c) => Math.max(max, jaccard(textTokens, tokens(c))), 0);
  return best >= threshold;
}

export type DedupableFinding = Record<string, unknown>;

export type DedupeOptions = {
  /** Title similarity required to consider two findings the same issue. */
  titleThreshold?: number;
  /** Lower title bar accepted when descriptions also agree strongly. */
  titleFallbackThreshold?: number;
  /** Description similarity required for the fallback path. */
  descriptionThreshold?: number;
  /** Title similarity required to merge ACROSS two different categories. */
  crossCategoryTitleThreshold?: number;
  /** Description agreement accepted as corroboration for a cross-category merge. */
  crossCategoryDescriptionThreshold?: number;
  /** Weaker description bar accepted when the two titles are byte-identical. */
  crossCategoryExactTitleDescriptionThreshold?: number;
};

const DEFAULTS: Required<DedupeOptions> = {
  titleThreshold: 0.55,
  titleFallbackThreshold: 0.4,
  descriptionThreshold: 0.6,
  crossCategoryTitleThreshold: 0.8,
  crossCategoryDescriptionThreshold: 0.5,
  crossCategoryExactTitleDescriptionThreshold: 0.3,
};

type Prepared = {
  row: DedupableFinding;
  index: number;
  category: string;
  titleTokens: Set<string>;
  descTokens: Set<string>;
  titleKey: string;
  fullTitle: string;
  evidence: Set<string>;
  evidenceQuotes: Set<string>;
  legalIssue: string;
  controllingRule: Set<string>;
  speakerRole: string;
  adoptionStatus: string;
  operativeEffect: string;
  affectedParty: string;
  sourceAuthority: string;
  sourcePassage: string;
};

function categoryOf(f: DedupableFinding): string {
  return normalizeText(f.category ?? f.finding_type ?? "misc") || "misc";
}

function textOf(f: DedupableFinding, key: string): string {
  const v = f[key];
  return typeof v === "string" ? v : "";
}

function legalField(f: DedupableFinding, key: string): string {
  const direct = textOf(f, key);
  if (direct) return direct;
  const metadata = f.metadata;
  if (!metadata || typeof metadata !== "object") return "";
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * Stable legal-issue key. Explicit producer metadata wins; the small alias
 * layer below is doctrine-level vocabulary, not a case/citation hard-code.
 */
export function canonicalLegalIssueKey(f: DedupableFinding): string {
  const explicit = normalizeText(legalField(f, "normalized_legal_issue"));
  if (explicit) return explicit;

  const text = normalizeText(
    `${textOf(f, "title")} ${textOf(f, "description")} ${textOf(f, "legal_significance")} ${legalField(f, "controlling_rule")}`,
  );

  // 1. Victim standing / access to justice / amparo legitimación
  if (
    /\b(victima|ofendido|ofendida|victimas|ofendidos)\b/.test(text) &&
    /\b(legitim|personeria|acceso|justicia|tutela|standing|interes juridico|interes legitimo|recurso|impugna)\b/.test(text)
  ) {
    return "victim_standing_access_to_justice";
  }

  // 2. Prompt presentment / due process
  if (
    /\b(puesta|presentacion|demora|retencion|detencion)\b/.test(text) &&
    /\b(disposicion|ministerio publico|sin demora|inmediata|flagrancia|plazo constitucional)\b/.test(text)
  ) {
    return "prompt_presentment_due_process";
  }

  // 3. Chain of custody / evidence integrity
  if (
    /\b(cadena de custodia|trazabilidad|preservacion|embalaje|aseguramiento del indicio|registro de cadena)\b/.test(text)
  ) {
    return "chain_of_custody_integrity";
  }

  // 4. Torture / coercion / illicit evidence rule
  if (
    /\b(tortura|tratos crueles|coaccion|confesion coaccionada|prueba ilicita|regla de exclusion|efecto corruptor)\b/.test(text)
  ) {
    return "torture_coercion_illicit_evidence";
  }

  // 5. Illegal search and seizure / domiciliary inviolability
  if (
    /\b(cateo|inspeccion domiciliaria|orden de cateo|inviolabilidad del domicilio|intromision)\b/.test(text)
  ) {
    return "illegal_search_seizure";
  }

  // 6. Adequate defense / effective technical defense
  if (
    /\b(defensa tecnica|defensa adecuada|asesor juridico|asistencia letrada|defensor publico)\b/.test(text) &&
    /\b(violacion|falta|indebida|vulneracion|inadecuada)\b/.test(text)
  ) {
    return "adequate_defense_effective_counsel";
  }

  // 7. Statute of limitations / prescription
  if (
    /\b(prescripcion|caducidad|extincion de la accion|termino de prescripcion)\b/.test(text)
  ) {
    return "statute_of_limitations_prescription";
  }

  // 8. Constitutional invalidation / article unconstitutionality
  const artMatch = text.match(/\b(?:inconstitucionalidad|inconstitucional|control de constitucionalidad|control difuso)\b.*?\b(?:articulo|art|precepto)\s+(\d+[\w/.-]*)/);
  if (artMatch) {
    return `unconstitutionality_art_${artMatch[1]}`;
  }

  return "";
}

/** Union of the concrete evidence anchors a finding rests on. */
const EVIDENCE_KEYS = ["evidence_refs", "source_doc_ids", "document_ids", "citations"] as const;

/**
 * evidence_refs entries are `{ label?, quote?, doc_id? }` (see types.ts).
 * `label` is each engine's own free-text framing of why the quote matters —
 * two engines routinely cite the identical quote/document under differently
 * worded labels. Signing the whole object (the original behavior) folded
 * that wording difference into the signature, so an identical quote cited
 * under two labels was never recognized as shared evidence.
 *
 * FIX: a prior version of this function keyed on doc_id::quote (matching
 * findings.server.ts's own evidenceKeys()) to fix the label problem above —
 * but that reintroduced the identical failure mode one layer down. Confirmed
 * on a real completed-case export: two agents (chain_of_custody,
 * witness_credibility) independently cited the same sentence — the quotes
 * normalize BYTE-IDENTICAL (the only textual difference was a redacted
 * `******` name token, which normalizeText's alnum-only filter strips
 * entirely) — yet one agent's evidence_ref had already been enriched with
 * `document_id` by a later citation-verification pass and the other hadn't,
 * so doc_id::quote produced two different composite keys ("uuid::quote" vs.
 * "::quote") for what was the exact same fact, and the pair never merged.
 * A verified quote match is already the strongest, most specific signal
 * available — two independent agents landing on the literal identical
 * sentence cannot be coincidental — so it's sufficient on its own; requiring
 * doc_id to ALSO match on top of it only creates false negatives like this
 * one, it can't prevent a false positive a coincidental quote match
 * wouldn't already risk. Key on quote alone when a quote is present, and
 * fall back to doc_id only for quote-less entries.
 */
function evidenceSignature(item: unknown): string {
  if (item && typeof item === "object") {
    const obj = item as Record<string, unknown>;
    const quote = normalizeText(obj.quote);
    if (quote) return `quote:${quote}`;
    const docId = normalizeText(obj.doc_id ?? obj.document_id);
    if (docId) return `doc:${docId}`;
    return normalizeText(JSON.stringify(item));
  }
  return normalizeText(String(item));
}

function evidenceOf(f: DedupableFinding): Set<string> {
  const out = new Set<string>();
  for (const key of EVIDENCE_KEYS) {
    const v = f[key];
    if (!Array.isArray(v)) continue;
    for (const item of v) {
      const sig = evidenceSignature(item);
      if (sig) out.add(sig);
    }
  }
  return out;
}

/** Minimum normalized-quote length considered for the strong same-category
 *  evidence signal below — long enough that a match can't be a coincidental
 *  short common phrase ("el juez ordeno"). */
const MIN_QUOTE_LEN = 20;

/** Verbatim `evidence_refs[].quote` text only (not doc_id-only or citation
 *  overlap, which are too weak a signal on their own — many distinct
 *  findings in the same case legitimately cite the same source document). */
function quoteEvidenceOf(f: DedupableFinding): Set<string> {
  const out = new Set<string>();
  const refs = f.evidence_refs;
  if (!Array.isArray(refs)) return out;
  for (const item of refs) {
    if (!item || typeof item !== "object") continue;
    const quote = normalizeText((item as Record<string, unknown>).quote);
    if (quote.length >= MIN_QUOTE_LEN) out.add(quote);
  }
  return out;
}

function prepare(row: DedupableFinding, index: number): Prepared {
  const title = textOf(row, "title");
  const desc = `${textOf(row, "description")} ${textOf(row, "legal_significance")}`;
  return {
    row,
    index,
    category: categoryOf(row),
    titleTokens: tokens(title),
    descTokens: tokens(desc),
    titleKey: normalizeText(title).split(" ").slice(0, 6).join(" "),
    fullTitle: normalizeText(title),
    evidence: evidenceOf(row),
    evidenceQuotes: quoteEvidenceOf(row),
    legalIssue: canonicalLegalIssueKey(row),
    controllingRule: tokens(legalField(row, "controlling_rule")),
    speakerRole: normalizeText(legalField(row, "speaker_role")),
    adoptionStatus: normalizeText(legalField(row, "adoption_status")),
    operativeEffect: normalizeText(legalField(row, "operative_effect")),
    affectedParty: normalizeText(legalField(row, "affected_party")),
    sourceAuthority: normalizeText(legalField(row, "source_authority")),
    sourcePassage: normalizeText(
      legalField(row, "source_passage") || legalField(row, "source_quote"),
    ),
  };
}

function sharesEvidence(a: Prepared, b: Prepared): boolean {
  if (a.evidence.size === 0 || b.evidence.size === 0) return false;
  for (const e of a.evidence) if (b.evidence.has(e)) return true;
  return false;
}

function sharesExactQuoteEvidence(a: Prepared, b: Prepared): boolean {
  if (a.evidenceQuotes.size === 0 || b.evidenceQuotes.size === 0) return false;
  for (const q of a.evidenceQuotes) if (b.evidenceQuotes.has(q)) return true;
  return false;
}

function sharesQuoteEvidence(a: Prepared, b: Prepared): boolean {
  if (a.evidenceQuotes.size === 0 || b.evidenceQuotes.size === 0) return false;
  for (const q of a.evidenceQuotes) {
    for (const other of b.evidenceQuotes) {
      // Engines often quote the same holding at different lengths. Treat a
      // meaningful verbatim containment as a candidate evidence anchor.
      if (q === other || (Math.min(q.length, other.length) >= MIN_QUOTE_LEN && (q.includes(other) || other.includes(q)))) return true;
    }
  }
  return false;
}

function auditClass(f: DedupableFinding): string {
  return String(f.audit_classification ?? "").toUpperCase();
}

function sameLegalProposition(a: Prepared, b: Prepared): boolean {
  if (!a.legalIssue || a.legalIssue !== b.legalIssue) return false;

  // Similar subject words are not enough when the operative legal result
  // differs (e.g. admissibility vs exclusion, standing granted vs denied).
  if (a.operativeEffect && b.operativeEffect && a.operativeEffect !== b.operativeEffect) {
    return false;
  }
  if (a.adoptionStatus && b.adoptionStatus) {
    const oneRejected = a.adoptionStatus === "rejected";
    const otherRejected = b.adoptionStatus === "rejected";
    if (oneRejected !== otherRejected) return false;
  }

  const sameAuthority =
    Boolean(a.sourceAuthority) &&
    Boolean(b.sourceAuthority) &&
    a.sourceAuthority === b.sourceAuthority;
  const samePassage =
    Boolean(a.sourcePassage) &&
    Boolean(b.sourcePassage) &&
    (a.sourcePassage === b.sourcePassage ||
      a.sourcePassage.includes(b.sourcePassage) ||
      b.sourcePassage.includes(a.sourcePassage));
  const sameRule =
    a.controllingRule.size > 0 &&
    b.controllingRule.size > 0 &&
    jaccard(a.controllingRule, b.controllingRule) >= 0.55;

  const titleSimilarity = jaccard(a.titleTokens, b.titleTokens);
  const descSimilarity = jaccard(a.descTokens, b.descTokens);

  return (
    sameAuthority ||
    samePassage ||
    sameRule ||
    sharesQuoteEvidence(a, b) ||
    sharesEvidence(a, b) ||
    titleSimilarity >= 0.4 ||
    descSimilarity >= 0.45
  );
}

function isCourtHoldingPotentialPair(a: Prepared, b: Prepared): boolean {
  const classes = new Set([auditClass(a.row), auditClass(b.row)]);
  if (!classes.has("VERIFIED_COURT_HOLDING") || !classes.has("POTENTIAL_ISSUE")) return false;
  // Do not merge unrelated holdings/theories merely because they come from
  // the same judgment. Require strong subject overlap plus a shared concrete
  // evidence anchor (or literal quote). This catches "Inconstitucionalidad..."
  // vs "Posible inconstitucionalidad..." without collapsing independent
  // holdings in the same resolution.
  const titleOverlap = jaccard(a.titleTokens, b.titleTokens);
  return titleOverlap >= 0.5 && (sharesEvidence(a, b) || sharesQuoteEvidence(a, b));
}

export function isSameIssue(a: Prepared, b: Prepared, opts: Required<DedupeOptions>): boolean {
  // Once both records carry a canonical legal-issue identity, its adoption
  // status and operative effect are authoritative.
  if (a.legalIssue && b.legalIssue && a.legalIssue === b.legalIssue) {
    return sameLegalProposition(a, b);
  }
  if (isCourtHoldingPotentialPair(a, b)) return true;

  const ts = jaccard(a.titleTokens, b.titleTokens);
  const titleContains =
    a.fullTitle.length > 15 &&
    b.fullTitle.length > 15 &&
    (a.fullTitle.includes(b.fullTitle) || b.fullTitle.includes(a.fullTitle));
  const sameHeadline =
    (a.titleKey !== "" && a.titleKey === b.titleKey) ||
    ts >= opts.titleThreshold ||
    titleContains;

  // Identical wording from different engines/categories is not corroboration
  // by itself. Cross-category merges must always carry a shared evidence or
  // description signal, even when the titles are byte-identical.
  if (a.category !== b.category) {
    if (ts >= opts.crossCategoryTitleThreshold) {
      if (sharesExactQuoteEvidence(a, b) || sharesQuoteEvidence(a, b) || sharesEvidence(a, b)) return true;
      if (jaccard(a.descTokens, b.descTokens) >= opts.crossCategoryDescriptionThreshold) return true;
      if (a.fullTitle === b.fullTitle && jaccard(a.descTokens, b.descTokens) >= 0.35) return true;
    }
    return false;
  }

  if (sameHeadline) {
    if (titleContains || (a.titleKey !== "" && a.titleKey === b.titleKey) || ts >= 0.45) return true;
    if (sharesExactQuoteEvidence(a, b) || sharesQuoteEvidence(a, b) || sharesEvidence(a, b)) return true;
    if (jaccard(a.descTokens, b.descTokens) >= opts.descriptionThreshold) return true;
  }

  if (ts >= opts.titleFallbackThreshold) {
    if (jaccard(a.descTokens, b.descTokens) >= opts.descriptionThreshold) return true;
  }
  if (sharesExactQuoteEvidence(a, b)) return true;
  if (sharesQuoteEvidence(a, b)) {
    return (
      jaccard(a.titleTokens, b.titleTokens) >= opts.titleFallbackThreshold ||
      jaccard(a.descTokens, b.descTokens) >= opts.descriptionThreshold
    );
  }
  return false;
}

function epistemicRank(f: DedupableFinding): number {
  return EPISTEMIC_RANK[auditClass(f)] ?? 3;
}

function strength(f: DedupableFinding): [number, number, number] {
  const epistemic = epistemicRank(f);
  const sev = SEV_RANK[String(f.severity ?? "info").toLowerCase()] ?? 9;
  const rawConf = Number(f.confidence ?? 0);
  const conf = Number.isFinite(rawConf) ? (rawConf > 1 ? rawConf / 100 : rawConf) : 0;
  return [epistemic, sev, -conf];
}

/** Lower tuple wins. */
function isStronger(a: DedupableFinding, b: DedupableFinding): boolean {
  const ar = strength(a);
  const br = strength(b);
  for (let i = 0; i < ar.length; i++) {
    if (ar[i] !== br[i]) return ar[i] < br[i];
  }
  return false;
}

const ARRAY_UNION_KEYS = [
  "evidence_refs",
  "citations",
  "source_doc_ids",
  "supporting_engines",
  "tags",
  "document_ids",
  "evidence",
  "sources",
] as const;

function unionArrays(master: DedupableFinding, orderedRows: DedupableFinding[]): void {
  for (const key of ARRAY_UNION_KEYS) {
    const seen = new Set<string>();
    const merged: unknown[] = [];
    const push = (v: unknown) => {
      if (!Array.isArray(v)) return;
      for (const item of v) {
        const sig = typeof item === "object" && item !== null ? JSON.stringify(item) : String(item);
        if (seen.has(sig)) continue;
        seen.add(sig);
        merged.push(item);
      }
    };
    const masterHadKey=Array.isArray(master[key]);
    for (const row of orderedRows) push(row[key]);
    // Only write the key when the master already had it or a duplicate
    // contributed something — never invent empty arrays on rows that had none.
    if (merged.length > 0 && (masterHadKey || orderedRows.some((row)=>Array.isArray(row[key])))) {
      master[key] = merged;
    }
  }
}

export type DedupedFinding = DedupableFinding & {
  _alias_ids?: string[];
  _alias_titles?: string[];
  _alias_categories?: string[];
  _merged?: Array<{ id?: string; title?: string; description?: string; category?: string }>;
  _merged_count?: number;
};

/** Internal: `prepare` every row (preserving original array position as
 *  `index`) then cluster by `isSameIssue`. Shared by the exported clustering
 *  and consolidation entry points below so both agree on exactly one
 *  definition of "same issue." */
function clusterPrepared(prepared: Prepared[], opts: Required<DedupeOptions>): Prepared[][] {
  const clusters: Prepared[][] = [];
  for (const p of prepared) {
    let placed = false;
    for (const cluster of clusters) {
      // Compare against every member so transitive drift can't chain unrelated
      // findings together: a new row must match ALL members already clustered.
      if (cluster.every((m) => isSameIssue(m, p, opts))) {
        cluster.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([p]);
  }
  return clusters;
}

/**
 * Group rows into same-issue clusters using the same-category-title-Jaccard /
 * cross-category-title-plus-corroboration rule (`isSameIssue`) — the pure
 * clustering step, with no winner-selection or merging. Shared by
 * `consolidateFindings` (report-time, read-only) and any caller that needs
 * its own merge semantics on top of the same canonical-issue grouping (e.g.
 * findings.server.ts's persist-time dedup, which additionally merges
 * judicial-hierarchy taxonomy fields and prefers an existing DB row as the
 * merge anchor). Clusters are returned in first-member original-order.
 */
export type LegalIssueHierarchy<T extends DedupableFinding> = {
  legal_issue: string;
  findings: T[];
};

/**
 * Parent-issue grouping for rendering. Unlike deduplication, this preserves
 * distinct operative effects as children under one doctrine.
 */
export function buildLegalIssueHierarchy<T extends DedupableFinding>(
  rows: ReadonlyArray<T>,
): LegalIssueHierarchy<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = canonicalLegalIssueKey(row) || normalizeText(row.title).split(" ").slice(0, 6).join(" ");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups].map(([legal_issue, findings]) => ({ legal_issue, findings }));
}

export function clusterBySameIssue<T extends DedupableFinding>(
  rows: ReadonlyArray<T>,
  options: DedupeOptions = {},
): Array<T[]> {
  const opts = { ...DEFAULTS, ...options };
  const prepared = (rows ?? []).map(prepare);
  return clusterPrepared(prepared, opts)
    .sort((a, b) => a[0].index - b[0].index)
    .map((cluster) => cluster.map((p) => p.row as T));
}

/**
 * Collapse near-duplicate findings into one consolidated row per legal issue.
 * Non-duplicates pass through untouched and in their original order.
 */
export function consolidateFindings<T extends DedupableFinding>(
  rows: ReadonlyArray<T>,
  options: DedupeOptions = {},
): Array<T & DedupedFinding> {
  const opts = { ...DEFAULTS, ...options };
  const prepared = (rows ?? []).map(prepare);
  const clusters = clusterPrepared(prepared, opts);

  const out: Array<{ index: number; row: T & DedupedFinding }> = [];
  for (const cluster of clusters) {
    let winner = cluster[0];
    for (const c of cluster.slice(1)) if (isStronger(c.row, winner.row)) winner = c;

    // Shallow clone so the input rows are never mutated.
    const master = { ...(winner.row as T) } as T & DedupedFinding;
    const dupes = cluster.filter((c) => c !== winner).map((c) => c.row);

    if (dupes.length > 0) {
      unionArrays(master, cluster.map((c)=>c.row));
      master._alias_ids = dupes.map((d) => String(d.id ?? "")).filter(Boolean);
      master._alias_titles = dupes.map((d) => String(d.title ?? "")).filter(Boolean);
      // Category UNION: when the same canonical issue was emitted by engines
      // under different category labels, the survivor must carry every label
      // so no legal perspective is silently dropped from the report.
      const winnerCategory = String(winner.row.category ?? winner.row.finding_type ?? "");
      const aliasCategories: string[] = [];
      for (const d of dupes) {
        const c = String(d.category ?? d.finding_type ?? "");
        if (!c) continue;
        if (normalizeText(c) === normalizeText(winnerCategory)) continue;
        if (aliasCategories.some((x) => normalizeText(x) === normalizeText(c))) continue;
        aliasCategories.push(c);
      }
      if (aliasCategories.length > 0) master._alias_categories = aliasCategories;
      master._merged = dupes.map((d) => ({
        id: d.id ? String(d.id) : undefined,
        title: d.title ? String(d.title) : undefined,
        description: d.description ? String(d.description) : undefined,
        category: d.category ? String(d.category) : undefined,
      }));
      master._merged_count = dupes.length;
      const mutable = master as DedupableFinding;
      const existingMeta = mutable.metadata;
      const meta =
        existingMeta && typeof existingMeta === "object"
          ? { ...(existingMeta as Record<string, unknown>) }
          : ({} as Record<string, unknown>);
      meta.merged_duplicates = master._merged;
      if (aliasCategories.length > 0) {
      meta.merged_categories = [winnerCategory, ...aliasCategories].filter(Boolean);
      }
      mutable.metadata = meta;
    }
    out.push({ index: cluster[0].index, row: master });
  }

  return out.sort((a, b) => a.index - b.index).map((o) => o.row);
}

export interface CanonicalDedupeAudit {
  canonical_id: string;
  surviving_id: string;
  duplicate_finding_ids: string[];
  originating_agents: string[];
  titles: string[];
  categories: string[];
  citation_ids: string[];
}

export interface CanonicalDedupeResult<T> {
  deduped: T[];
  duplicatesFound: number;
  duplicateAudit: CanonicalDedupeAudit[];
  final_reportable_canonical_ids_unique: boolean;
}

function scoreCanonicalSurvivorCandidate(f: Record<string, unknown>): number {
  let score = 0;
  const isHolding =
    f.audit_classification === "VERIFIED_COURT_HOLDING" ||
    f.proposition_type === "holding" ||
    (f.metadata as Record<string, unknown> | undefined)?.proposition_type === "holding";
  if (isHolding) score += 10000;

  const isFact =
    f.audit_classification === "VERIFIED_FACT" ||
    f.proposition_type === "fact";
  if (isFact) score += 5000;

  const hasQuote = Boolean(f.source_quote || (Array.isArray(f.evidence_refs) && f.evidence_refs.length > 0));
  if (hasQuote) score += 2000;

  const evCount = Array.isArray(f.evidence_refs) ? f.evidence_refs.length : 0;
  score += Math.min(evCount * 100, 1000);

  const conf = typeof f.confidence === "number" ? f.confidence : 0.5;
  score += Math.round(conf * 100);

  const descLen = typeof f.description === "string" ? f.description.length : 0;
  score += Math.min(descLen, 50);

  return score;
}

/**
 * Enforces canonical uniqueness on the exact reportable findings collection.
 * If multiple rows share the same canonical_finding_id, exactly one final reportable
 * finding is produced, and all evidence, citations, source docs, aliases, quotes,
 * and originating agents from duplicate rows are unioned/merged into it.
 */
export function dedupeReportableFindingsByCanonicalId<T extends Record<string, unknown>>(
  findings: ReadonlyArray<T>,
): CanonicalDedupeResult<T & { _alias_ids?: string[]; _alias_titles?: string[] }> {
  type DedupedRow = T & { _alias_ids?: string[]; _alias_titles?: string[] };
  const byCanonical = new Map<string, T[]>();
  const nonCanonical: T[] = [];

  for (const f of findings) {
    const cid = String(f.canonical_finding_id ?? (f.metadata as Record<string, unknown> | undefined)?.canonical_finding_id ?? "").trim();
    if (cid) {
      const arr = byCanonical.get(cid) ?? [];
      arr.push(f);
      byCanonical.set(cid, arr);
    } else {
      nonCanonical.push(f);
    }
  }

  const deduped: DedupedRow[] = [];
  const duplicateAudit: CanonicalDedupeAudit[] = [];
  let duplicatesFound = 0;

  for (const [cid, group] of byCanonical) {
    if (group.length === 1) {
      deduped.push(group[0] as DedupedRow);
      continue;
    }

    duplicatesFound += group.length - 1;

    // Pick strongest candidate
    let winner = group[0];
    let bestScore = scoreCanonicalSurvivorCandidate(winner);
    for (let i = 1; i < group.length; i++) {
      const cand = group[i];
      const candScore = scoreCanonicalSurvivorCandidate(cand);
      if (candScore > bestScore) {
        winner = cand;
        bestScore = candScore;
      }
    }

    const dupes = group.filter((g) => g !== winner);

    // Merge provenance into master survivor
    const master = { ...winner } as Record<string, unknown>;

    // 1. Evidence refs / citations union
    const allEvidenceRefs: unknown[] = [];
    const seenRefs = new Set<string>();
    for (const g of group) {
      const refs = Array.isArray(g.evidence_refs) ? g.evidence_refs : [];
      for (const r of refs) {
        const key = typeof r === "object" && r !== null
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? `${(r as any).document_id ?? (r as any).doc_id ?? ""}:${(r as any).page ?? ""}:${String((r as any).quote ?? "").slice(0, 50)}`
          : String(r);
        if (!seenRefs.has(key)) {
          seenRefs.add(key);
          allEvidenceRefs.push(r);
        }
      }
    }
    master.evidence_refs = allEvidenceRefs;

    // 2. Source doc IDs union
    const allDocIds = new Set<string>();
    for (const g of group) {
      const docIds = Array.isArray(g.source_doc_ids) ? g.source_doc_ids : [];
      for (const d of docIds) if (d && typeof d === "string") allDocIds.add(d);
      if (g.source_document_id && typeof g.source_document_id === "string") allDocIds.add(g.source_document_id);
    }
    master.source_doc_ids = Array.from(allDocIds);

    // 3. Aliases
    const aliasIds = dupes.map((d) => String(d.id ?? "")).filter(Boolean);
    const aliasTitles = dupes.map((d) => String(d.title ?? "")).filter(Boolean);
    master._alias_ids = [
      ...(Array.isArray(master._alias_ids) ? (master._alias_ids as string[]) : []),
      ...aliasIds,
    ];
    master._alias_titles = [
      ...(Array.isArray(master._alias_titles) ? (master._alias_titles as string[]) : []),
      ...aliasTitles,
    ];

    // 4. Originating agents & metadata union
    const existingMeta = (master.metadata as Record<string, unknown> | undefined) ?? {};
    const existingMerged = Array.isArray(existingMeta.merged_from) ? (existingMeta.merged_from as unknown[]) : [];
    const newMerged = dupes.map((d) => ({
      id: d.id,
      title: d.title,
      source_module: d.source_module,
      confidence: d.confidence,
      category: d.category,
      speaker_role: d.speaker_role,
      proposition_type: d.proposition_type,
    }));

    master.metadata = {
      ...existingMeta,
      canonical_finding_id: cid,
      merged_from: [...existingMerged, ...newMerged],
      _canonical_deduped: true,
    };

    deduped.push(master as DedupedRow);

    duplicateAudit.push({
      canonical_id: cid,
      surviving_id: String(master.id ?? ""),
      duplicate_finding_ids: group.map((g) => String(g.id ?? "")).filter(Boolean),
      originating_agents: Array.from(new Set(group.map((g) => String(g.source_module ?? "")).filter(Boolean))),
      titles: Array.from(new Set(group.map((g) => String(g.title ?? "")).filter(Boolean))),
      categories: Array.from(new Set(group.map((g) => String(g.category ?? "")).filter(Boolean))),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      citation_ids: Array.from(new Set(allEvidenceRefs.map((r: any) => String(r?.citation_id ?? r?.id ?? "")).filter(Boolean))),
    });
  }

  // Add non-canonical findings
  for (const nc of nonCanonical) {
    deduped.push(nc as DedupedRow);
  }

  const distinctCanonical = new Set(
    deduped
      .map((f) => String(f.canonical_finding_id ?? (f.metadata as Record<string, unknown> | undefined)?.canonical_finding_id ?? "").trim())
      .filter(Boolean),
  );

  const canonicalCount = deduped.filter(
    (f) => Boolean(String(f.canonical_finding_id ?? (f.metadata as Record<string, unknown> | undefined)?.canonical_finding_id ?? "").trim()),
  ).length;

  const final_reportable_canonical_ids_unique = distinctCanonical.size === canonicalCount;

  return {
    deduped,
    duplicatesFound,
    duplicateAudit,
    final_reportable_canonical_ids_unique,
  };
}
