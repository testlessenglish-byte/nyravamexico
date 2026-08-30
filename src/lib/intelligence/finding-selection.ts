// Unified findings selector — Phase 1 of the Intelligence Aggregation
// Refactor.
//
// PURE MODULE. No I/O, no Supabase, no AI. Every surface that counts,
// filters, or classifies `case_findings` rows MUST go through the helpers
// here so scoring, dashboard badges, agent statistics, and the exporter can
// never drift apart again.

import { consolidateFindings } from "./finding-dedupe";

export type FindingSourceClass = "engine" | "agent" | "analyzer" | "projection" | "other";

export const PROJECTION_LIKE = "projection:%";

export type FindingStatus = "candidate" | "verified" | "disputed" | "suppressed" | "promoted";

export const FINDING_STATUSES: readonly FindingStatus[] = [
  "candidate",
  "verified",
  "disputed",
  "suppressed",
  "promoted",
] as const;

export type SelectableFinding = {
  source_module?: string | null;
  severity?: string | null;
  finding_status?: string | null;
  supporting_engines?: string[] | null;
  metadata?: Record<string, unknown> | null;
  /** Hallucination/citation verifier result. A row explicitly marked
   * no_citation/unverified has been quarantined and is not eligible for an
   * authoritative report surface. Undefined preserves pre-verifier behavior
   * while the pipeline is still running. */
  verification_status?: string | null;
  title?: string | null;
  description?: string | null;
  legal_significance?: string | null;
  potential_impact?: string | null;
  source_quote?: string | null;
  evidence_refs?: unknown;
  source_document_id?: string | null;
  source_doc_ids?: string[] | null;
  audit_classification?: string | null;
};

export function classifyFindingSource(f: SelectableFinding): FindingSourceClass {
  const sm = String(f.source_module ?? "");
  if (sm.startsWith("engine:")) return "engine";
  if (sm.startsWith("agent:")) return "agent";
  if (sm.startsWith("analyzer:")) return "analyzer";
  if (sm.startsWith("projection:")) return "projection";
  return "other";
}

export function isProvisionalFinding(f: SelectableFinding): boolean {
  return (f.metadata as Record<string, unknown> | undefined)?.provisional === true;
}

export function isSuppressedFinding(f: SelectableFinding): boolean {
  return String(f.finding_status ?? "candidate").toLowerCase() === "suppressed";
}

/**
 * True for finalized, non-provisional pipeline output that may appear as an
 * authoritative finding. A completed hallucination/citation pass can mark a
 * row `no_citation` or `unverified`; those rows remain in the database/audit
 * appendix but must not re-enter the dashboard, PDF key-findings body, or
 * ordinary case UI through getCase() after the report explicitly quarantined
 * them.
 *
 * `finding_status=suppressed` is equally final: it is the pipeline's explicit
 * decision that the row must not drive scores, executive findings, Talk to
 * Case's authoritative answer set, or exports. The old selector ignored that
 * status, which meant a row could be correctly suppressed by a later audit and
 * still re-enter every canonical surface merely because its source_module was
 * `engine:*` or `agent:*`.
 */
function isPersonalNoticeSourceInversion(f: SelectableFinding): boolean {
  const evidence = [String(f.source_quote ?? ""), JSON.stringify(f.evidence_refs ?? [])].join(" ");
  const claim = [f.title, f.description, f.legal_significance, f.potential_impact].map((v) => String(v ?? "")).join(" ");
  return /(?:no\s+exist[ií]a|no\s+(?:era|es|resultaba|fue)\s+necesari[oa]|no\s+hab[ií]a)\b[^.!?]{0,160}(?:deber|obligaci[oó]n|necesidad)?[^.!?]{0,120}notific[^.!?]{0,80}personal/i.test(evidence) && /notific[^.!?]{0,100}personal/i.test(claim) && /(defectu|irregular|error|nulidad|invalid|afect|procedencia|desestim|debilidad|riesgo|perjuicio)/i.test(claim);
}

/** Deterministic release-integrity checks. These deliberately target factual
 * mismatches that citation-presence checks cannot detect: a quote may exist
 * while supporting a different court, proposition, or polarity. */
export function canonicalEvidenceIntegrityIssue(f: SelectableFinding): string | null {
  const refs = Array.isArray(f.evidence_refs)
    ? (f.evidence_refs as Array<Record<string, unknown>>)
    : [];
  const quotedRefs = refs.filter((r) => typeof r?.quote === "string" && r.quote.trim().length > 0);
  const claim = [f.title, f.description, f.legal_significance, f.potential_impact]
    .map((v) => String(v ?? ""))
    .join(" ");
  const sourceQuote = String(f.source_quote ?? "").trim();
  const evidenceQuotes = quotedRefs.map((r) => String(r.quote).trim());
  const evidenceSegments = sourceQuote ? [sourceQuote, ...evidenceQuotes] : evidenceQuotes;
  const auditClass = String(f.audit_classification ?? "").toUpperCase();

  // A theory with no classified evidentiary basis must not enter an
  // authoritative report merely because a loose source_quote was attached.
  if (String(f.source_module ?? "").startsWith("engine:theory:") && !auditClass && quotedRefs.length === 0) return "unclassified_theory_without_evidence_ref";

  // ADR holding-polarity guard: a statement that SCJN held an entity was NOT
  // exempt is not entailed by a quote saying only that lower decisions were
  // incorrect. The quote must itself contain the asserted non-exemption.
  const overturnedLowerCourt =
    /(?:incorrect.{0,140}(?:fallo|sentencia|determinaci[oó]n|Tribunal Colegiado|autoridad responsable)|(?:fallo|sentencia|determinaci[oó]n|Tribunal Colegiado|autoridad responsable).{0,140}incorrect)/i;
  const statesNonExemption = /no\s+(?:est[aá]|se\s+encuentra|resulta)\s+exent/i;
  if (
    /\bSCJN\b|Suprema Corte/i.test(claim) &&
    statesNonExemption.test(claim) &&
    (
      (sourceQuote && overturnedLowerCourt.test(sourceQuote) && !statesNonExemption.test(sourceQuote)) ||
      (!sourceQuote &&
        evidenceSegments.some((quote) => overturnedLowerCourt.test(quote)) &&
        !evidenceSegments.some((quote) => statesNonExemption.test(quote)))
    )
  ) return "court_holding_polarity_not_entailed";

  // Competence and admissibility/procedencia are distinct holdings. Keep each
  // quote as its own provenance unit so an unrelated ref cannot cure the
  // primary quote's semantic mismatch.
  const competenceOnly = (quote: string) =>
    /\bcompetente\b/i.test(quote) && !/proceden(?:cia|te)/i.test(quote);
  if (
    /proceden(?:cia|te).{0,180}(?:debido|porque|por\s+la\s+existencia)/i.test(claim) &&
    (
      (sourceQuote && competenceOnly(sourceQuote)) ||
      (!sourceQuote && evidenceSegments.length > 0 && evidenceSegments.every(competenceOnly))
    )
  ) return "competence_quote_does_not_establish_admissibility";

  // An adhesive/cross-review is a different party and remedy from the
  // principal appeal. ADR5829 showed a quote expressly limited to "la
  // adherente / revisión adhesiva" being retitled as the principal
  // appellant's grievances, reversing who lost that issue.
  const adhesiveEvidence = evidenceSegments.some((quote) =>
    /\b(?:adherente|adhesiv[oa]|revisi[oó]n\s+adhesiva)\b/i.test(quote),
  );
  const acknowledgesAdhesiveParty = /\b(?:adherente|adhesiv[oa]|recurrente\s+adhesiva)\b/i.test(claim);
  const principalOnlyClaim = /\b(?:parte\s+)?recurrente\b/i.test(claim) && !acknowledgesAdhesiveParty;
  if (adhesiveEvidence && principalOnlyClaim) return "adhesive_party_misattributed_to_principal_appellant";

  return null;
}

export function isCanonicalFinding(f: SelectableFinding): boolean {
  const cls = classifyFindingSource(f);
  const verification = String(f.verification_status ?? "").toLowerCase();
  const quarantined = verification === "no_citation" || verification === "unverified";
  return (
    (cls === "engine" || cls === "agent") &&
    !isPersonalNoticeSourceInversion(f) &&
    !canonicalEvidenceIntegrityIssue(f) &&
    !isProvisionalFinding(f) &&
    !isSuppressedFinding(f) &&
    !quarantined
  );
}

export type SelectFindingsOptions = {
  include?: ReadonlyArray<FindingSourceClass>;
  includeProvisional?: boolean;
  statuses?: ReadonlyArray<FindingStatus>;
  severities?: ReadonlyArray<string>;
  /** Include rows explicitly quarantined by citation verification. Defaults
   * false for the canonical report/UI selection. */
  includeQuarantined?: boolean;
  /** Include rows that the canonical audit explicitly suppressed. Defaults
   * false. Use only on audit/debug surfaces that intentionally show rejected
   * material. */
  includeSuppressed?: boolean;
};

const DEFAULT_INCLUDE: ReadonlyArray<FindingSourceClass> = ["engine", "agent"];

export function selectFindings<T extends SelectableFinding>(
  findings: ReadonlyArray<T>,
  opts: SelectFindingsOptions = {},
): T[] {
  const include = new Set(opts.include ?? DEFAULT_INCLUDE);
  const statuses = opts.statuses ? new Set<string>(opts.statuses) : null;
  const severities = opts.severities ? new Set<string>(opts.severities) : null;

  const selected = (findings ?? []).filter((f) => {
    if (!include.has(classifyFindingSource(f))) return false;
    if (!opts.includeProvisional && isProvisionalFinding(f)) return false;
    if (!opts.includeSuppressed && isSuppressedFinding(f)) return false;
    if (canonicalEvidenceIntegrityIssue(f)) return false;
    if (!opts.includeQuarantined) {
      const verification = String(f.verification_status ?? "").toLowerCase();
      if (verification === "no_citation" || verification === "unverified") return false;
    }
    if (statuses && !statuses.has(String(f.finding_status ?? "candidate"))) return false;
    if (severities && !severities.has(String(f.severity ?? ""))) return false;
    return true;
  });

  // Canonical selection is also the canonical reconciliation boundary.
  // Every UI/report/Talk-to-Case consumer already funnels through this
  // selector, so consolidating here prevents a report from rendering several
  // aliases of one legal issue even when different engines produced them.
  // consolidateFindings preserves/merges evidence, citations, source docs,
  // categories, supporting engines and alias metadata; nothing is discarded.
  return consolidateFindings(
    selected as unknown as Array<Record<string, unknown>>,
  ) as unknown as T[];
}

export type FindingMetrics = {
  total: number;
  canonical: number;
  provisional: number;
  highPriority: number;
  bySource: Record<FindingSourceClass, number>;
  bySeverity: Record<string, number>;
  byStatus: Record<FindingStatus, number>;
};

function emptyStatusTally(): Record<FindingStatus, number> {
  return { candidate: 0, verified: 0, disputed: 0, suppressed: 0, promoted: 0 };
}

export function getFindingMetrics(findings: ReadonlyArray<SelectableFinding>): FindingMetrics {
  const bySource: Record<FindingSourceClass, number> = {
    engine: 0,
    agent: 0,
    analyzer: 0,
    projection: 0,
    other: 0,
  };
  const bySeverity: Record<string, number> = {};
  const byStatus = emptyStatusTally();

  let canonical = 0;
  let provisional = 0;
  let highPriority = 0;

  for (const f of findings ?? []) {
    const cls = classifyFindingSource(f);
    bySource[cls] += 1;

    const sev = String(f.severity ?? "unknown");
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;

    const st = String(f.finding_status ?? "candidate");
    if ((FINDING_STATUSES as readonly string[]).includes(st)) {
      byStatus[st as FindingStatus] += 1;
    }

    if (isProvisionalFinding(f)) provisional += 1;
    if (isCanonicalFinding(f)) {
      canonical += 1;
      if (sev === "critical" || sev === "high") highPriority += 1;
    }
  }

  return {
    total: (findings ?? []).length,
    canonical,
    provisional,
    highPriority,
    bySource,
    bySeverity,
    byStatus,
  };
}

export type FindingConsensus = {
  agreementCount: number;
  engines: string[];
  label: (lang: "es" | "en") => string;
};

export function getFindingConsensus(f: SelectableFinding): FindingConsensus {
  const raw = Array.isArray(f.supporting_engines) ? f.supporting_engines : [];
  const engines = Array.from(new Set(raw.map((e) => String(e).trim()).filter(Boolean))).sort();
  const agreementCount = engines.length;
  return {
    agreementCount,
    engines,
    label: (lang) =>
      lang === "en"
        ? `identified by ${agreementCount} pipeline stages`
        : `identificado por ${agreementCount} etapas del pipeline`,
  };
}

/**
 * Deterministic ranking layer for appellate and constitutional resolutions.
 * Priority hierarchy:
 *  1. Dispositive result / Resolutivos (is_dispositive)
 *  2. Controlling constitutional / statutory holding (is_controlling_issue)
 *  3. Court's material reasoning & procedural violations
 *  4. Remand / procedural consequences
 *  5. Secondary doctrine / international human rights
 *  6. Background facts & evidence
 *  7. Strategic observations
 */
export function rankFindingsForReport<T extends SelectableFinding>(
  findings: ReadonlyArray<T>,
): T[] {
  const scoreFinding = (f: T): number => {
    const title = String(f.title ?? "").toLowerCase();
    const desc = String(f.description ?? "").toLowerCase();
    const cat = String(f.category ?? "").toLowerCase();
    const auditClass = String(f.audit_classification ?? "").toUpperCase();
    const propType = String((f as any).proposition_type ?? "").toLowerCase();

    // 1. Dispositive / resolutivo
    if ((f as any).is_dispositive || cat.includes("resolutivo") || /primero\.|segundo\.|se revoca|se confirma|devu[eé]lvanse/i.test(title)) {
      return 1000;
    }

    // 2. Controlling holding (e.g. Inconstitucionalidad, taxatividad, exact application)
    if (
      (f as any).is_controlling_issue ||
      auditClass === "VERIFIED_COURT_HOLDING" ||
      propType === "holding" ||
      /inconstitucional|taxatividad|exacta aplicaci[oó]n|art[ií]culo\s*8|garant[ií]a\s*constitucional/i.test(title)
    ) {
      return 900;
    }

    // 3. Court's material reasoning / procedural violations
    if (/violaci[oó]n procesal|debido proceso|acceso a la justicia|legitimaci[oó]n/i.test(title + " " + cat)) {
      return 700;
    }

    // 4. Secondary doctrine / human rights
    if (/convenci[oó]n|tratado|derechos humanos|pro persona/i.test(title + " " + cat)) {
      return 500;
    }

    // 5. Background facts / condena
    if (/condena|fraude|hechos|antecedentes/i.test(title + " " + desc)) {
      return 300;
    }

    return 100;
  };

  return [...findings].sort((a, b) => {
    const sa = scoreFinding(a);
    const sb = scoreFinding(b);
    if (sa !== sb) return sb - sa;
    const ca = Number(a.confidence ?? 0);
    const cb = Number(b.confidence ?? 0);
    return cb - ca;
  });
}
