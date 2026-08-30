// Canonical recommendations merge. All report recommendation lanes converge
// here before rendering, so this is the authoritative place to deduplicate
// and apply evidence-grounding requirements to attorney-facing actions.

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  extractRecommendationCandidatesFromProse,
  type RecommendationCandidate,
  type RecommendationOwner,
} from "./report-canonical-context";
import { filterUnsupportedLegalFilingRecommendations } from "./recommendation-grounding";
import { sanitizeActionsForPosture, type ProceduralPosture } from "./procedural-posture";

export type RecommendationPriority = "critical" | "high" | "medium" | "low";

export interface CanonicalRecommendation {
  id: string;
  priority: RecommendationPriority;
  owner: RecommendationOwner;
  title: string;
  reason: string;
  supportingFindingIds: string[];
  supportingEvidence: string[];
  confidence: number | null;
  expectedImpact: string | null;
  mergedFrom: string[];
}

function fnv1a(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "in", "on", "with", "should", "file",
  "consider", "recommend", "recommended", "attorney", "case", "this", "de", "del", "la", "el",
  "los", "las", "y", "o", "en", "con", "sobre", "para", "por", "que", "su", "sus", "un", "una",
  "unos", "unas", "al", "se", "es", "ser", "esta", "este", "estos", "estas", "lo",
]);

function stem(t: string): string {
  return t.length > 5 && t.endsWith("s") ? t.slice(0, -1) : t;
}

function significantTokens(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter((t) => t.length > 2 && !STOPWORDS.has(t)).map(stem));
}

function similarity(a: string, b: string): number {
  const ta = significantTokens(a);
  const tb = significantTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const DUPLICATE_THRESHOLD = 0.55;

export function isDuplicateTitle(a: string, b: string): boolean {
  if (similarity(a, b) >= DUPLICATE_THRESHOLD) return true;
  const ta = significantTokens(a);
  const tb = significantTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size < 2) return false;
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

const PRIORITY_RANK: Record<RecommendationPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function coercePriority(v: unknown): RecommendationPriority {
  const s = String(v ?? "").toLowerCase();
  if (s === "critical" || s === "high" || s === "medium" || s === "low") return s;
  return "medium";
}

function fromMemoNextActions(memo: Record<string, any> | null | undefined): RecommendationCandidate[] {
  const actions = memo?.legal_memorandum?.next_actions;
  if (!Array.isArray(actions)) return [];
  return actions.map((a: any) => {
    const title = String(a?.action ?? "").trim();
    return {
      id: `rec_${fnv1a(normalize(title))}`,
      owner: "memo" as const,
      title,
      reason: title,
      supportingFindingIds: [],
      supportingEvidence: [],
      confidence: null,
      expectedImpact: a?.deadline ? `Deadline: ${a.deadline}` : null,
      priorityHint: coercePriority(a?.priority),
    };
  });
}

function fromMemoRecommendedMotions(memo: Record<string, any> | null | undefined): RecommendationCandidate[] {
  const motions = memo?.legal_memorandum?.recommended_motions;
  if (!Array.isArray(motions)) return [];
  return motions.map((m: any) => {
    const title = String(m?.motion ?? "").trim();
    return {
      id: `rec_${fnv1a(normalize(title))}`,
      owner: "memo" as const,
      title,
      reason: String(m?.legal_standard ?? title),
      supportingFindingIds: [],
      // Factual-basis strings are preserved for the audit trail, but the
      // grounding gate only treats them as evidence when they themselves
      // contain a concrete DOC/page pinpoint. Generated prose alone is not
      // enough to authorize a filing recommendation.
      supportingEvidence: Array.isArray(m?.factual_basis) ? m.factual_basis.map(String) : [],
      confidence: null,
      expectedImpact: null,
      priorityHint: m?.likelihood === "High" ? "high" : m?.likelihood === "Low" ? "low" : "medium",
    };
  });
}

function fromIntelNextActions(intel: Record<string, any> | null | undefined): RecommendationCandidate[] {
  const actions = intel?.next_actions;
  if (!Array.isArray(actions)) return [];
  return actions.map((a: any) => {
    const title = String(a?.action ?? "").trim();
    return {
      id: `rec_${fnv1a(normalize(title))}`,
      owner: "intelligence" as const,
      title,
      reason: String(a?.why ?? title),
      // depends_on is a workflow dependency list, not a list of canonical
      // finding ids. Treating it as evidentiary support allowed an LLM to
      // make unsupported filing advice look grounded merely by naming a
      // prerequisite task.
      supportingFindingIds: [],
      supportingEvidence: [],
      confidence: null,
      expectedImpact: a?.deadline_hint ? `Deadline: ${a.deadline_hint}` : null,
      priorityHint: null,
    };
  });
}

function fromIntelStrategyRecommendations(intel: Record<string, any> | null | undefined): RecommendationCandidate[] {
  const items = intel?.strategy_recommendations;
  if (!Array.isArray(items)) return [];
  return items.map((s: any) => {
    const title = String(s?.title ?? "").trim();
    return {
      id: `rec_${fnv1a(normalize(title))}`,
      owner: "intelligence" as const,
      title,
      reason: String(s?.rationale ?? title),
      supportingFindingIds: [],
      supportingEvidence: [],
      confidence: null,
      expectedImpact: String(s?.expected_impact ?? "") || null,
      priorityHint: coercePriority(s?.priority),
    };
  });
}

function fromIntelMotionOpportunities(intel: Record<string, any> | null | undefined): RecommendationCandidate[] {
  const items = intel?.motion_opportunities;
  if (!Array.isArray(items)) return [];
  return items.map((m: any) => {
    const title = String(m?.motion ?? "").trim();
    const citations = Array.isArray(m?.citations)
      ? m.citations
          .filter((c: any) => Number(c?.doc_n) > 0 && Number(c?.page) > 0 && String(c?.quote ?? "").trim().length > 0)
          .map((c: any) => `[DOC ${Number(c.doc_n)} p.${Number(c.page)}] ${String(c.quote).trim()}`)
      : [];
    return {
      id: `rec_${fnv1a(normalize(title))}`,
      owner: "intelligence" as const,
      title,
      reason: String(m?.legal_rationale ?? m?.basis ?? title),
      supportingFindingIds: [],
      supportingEvidence: citations,
      confidence: typeof m?.priority === "number" ? m.priority : null,
      expectedImpact: String(m?.likely_outcome ?? "") || null,
      priorityHint:
        m?.likelihood_of_success === "high" ? "high" : m?.likelihood_of_success === "low" ? "low" : "medium",
    };
  });
}

export function mergeCanonicalRecommendations(args: {
  narrativeParsed?: Record<string, any> | null;
  memoParsed?: Record<string, any> | null;
  intelParsed?: Record<string, any> | null;
  posture?: ProceduralPosture | null;
}): CanonicalRecommendation[] {
  const narrativeProseText = String(args.narrativeParsed?.prose?.recommendations ?? "");
  const rawCandidates: RecommendationCandidate[] = [
    ...extractRecommendationCandidatesFromProse(narrativeProseText, "narrative"),
    ...fromMemoNextActions(args.memoParsed),
    ...fromMemoRecommendedMotions(args.memoParsed),
    ...fromIntelNextActions(args.intelParsed),
    ...fromIntelStrategyRecommendations(args.intelParsed),
    ...fromIntelMotionOpportunities(args.intelParsed),
  ].filter((c) => c.title.length > 0);

  const candidates = args.posture
    ? sanitizeActionsForPosture(rawCandidates, args.posture)
    : rawCandidates;

  const clusters: CanonicalRecommendation[] = [];
  for (const cand of candidates) {
    let match: CanonicalRecommendation | undefined;
    for (const cluster of clusters) {
      if (isDuplicateTitle(cluster.title, cand.title)) {
        match = cluster;
        break;
      }
    }
    if (!match) {
      clusters.push({
        id: cand.id,
        priority: cand.priorityHint ?? "medium",
        owner: cand.owner,
        title: cand.title,
        reason: cand.reason,
        supportingFindingIds: [...cand.supportingFindingIds],
        supportingEvidence: [...cand.supportingEvidence],
        confidence: cand.confidence,
        expectedImpact: cand.expectedImpact,
        mergedFrom: [],
      });
      continue;
    }
    match.supportingFindingIds = Array.from(new Set([...match.supportingFindingIds, ...cand.supportingFindingIds]));
    match.supportingEvidence = Array.from(new Set([...match.supportingEvidence, ...cand.supportingEvidence]));
    if (cand.priorityHint && PRIORITY_RANK[cand.priorityHint] < PRIORITY_RANK[match.priority]) {
      match.priority = cand.priorityHint;
    }
    if (match.confidence == null && cand.confidence != null) match.confidence = cand.confidence;
    if (!match.expectedImpact && cand.expectedImpact) match.expectedImpact = cand.expectedImpact;
    match.mergedFrom.push(cand.id);
  }

  // Legal filing/remedy advice cannot be admitted merely because an LLM put
  // it in narrative prose. The canonical list is the last common choke point
  // before every renderer; require auditable finding/evidence support here.
  const grounded = filterUnsupportedLegalFilingRecommendations(
    clusters as unknown as Array<Record<string, unknown>>,
  ).items as unknown as CanonicalRecommendation[];
  return grounded.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

/** Remove actions that duplicate a finding the later citation audit has quarantined. */
export function filterQuarantinedRecommendations<T>(
  items: T[],
  quarantinedTitles: string[],
  getTitle: (item: T) => string,
): { items: T[]; removed: T[] } {
  const kept: T[] = [];
  const removed: T[] = [];
  for (const item of items) {
    const title = getTitle(item).trim();
    const isQuarantined = title.length > 0 && quarantinedTitles.some((qt) => isDuplicateTitle(title, qt));
    if (isQuarantined) removed.push(item);
    else kept.push(item);
  }
  return { items: kept, removed };
}
