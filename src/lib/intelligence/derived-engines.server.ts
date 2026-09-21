// Derived no-op engines.
//
// The Analyzers stage already produces contradictions, missing_evidence, and
// procedural (evidence intelligence) findings in one batched, merged, grounded
// LLM pass and writes them to case_findings under source_module = "analyzer:*".
// The Agents stage's witness_credibility sub-agent already produces witness
// findings under category_key = "witness".
//
// Prior to this file, four "standalone" engines (contradictions,
// discovery_gaps, evidence_intelligence, witness_intelligence) re-derived the
// same categories with independent, un-batched LLM calls — duplicate work
// that also blew the 30K TPM cap on any moderately large case (413s).
//
// These functions replace those calls: no LLM, just count what Analyzers /
// Agents already produced, and return the same shape (`{ value, stats }`) the
// prior engines returned so `runEngine(...)` continues to record real
// generated/accepted numbers in `pipeline_engine_runs`.
//
// IMPORTANT: these helpers are used by BOTH the automatic pipeline and the
// manual per-engine rerun buttons. A manual rerun happens after a report may
// already have been released. Any upstream intelligence rerun therefore must
// invalidate report/gate artifacts that were assembled from the previous
// snapshot. The automatic pipeline, however, must NEVER invalidate its own
// in-flight shared brief or report prerequisites.
//
// NOTE (category_key fix): `category` on case_findings holds the localized,
// human-facing label (Spanish for MX cases, e.g. "Testimonio de Testigo") —
// it must never be used for internal filtering. `category_key` holds the
// fixed, locale-independent machine token ("witness", "contradiction", etc.)
// and is what every derive*() below must match against.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Db = SupabaseClient<Database>;

export const DERIVED_ENGINE_SOURCES = {
  contradictions: { modulePrefix: "analyzer:contradiction" },
  discoveryGaps: { modulePrefix: "analyzer:missing" },
  evidenceIntel: { modulePrefix: "analyzer:procedural" },
  witnessIntel: { categoryKey: "witness", modulePrefix: "agent:witness_credibility" },
} as const;

async function countFindings(
  db: Db,
  caseId: string,
  opts: { modulePrefix?: string; categoryKey?: string },
): Promise<number> {
  let q = db.from("case_findings").select("id", { count: "exact", head: true }).eq("case_id", caseId);
  if (opts.modulePrefix && opts.categoryKey) {
    q = q.or(`source_module.like.${opts.modulePrefix}%,category_key.eq.${opts.categoryKey}`);
  } else if (opts.modulePrefix) {
    q = q.like("source_module", `${opts.modulePrefix}%`);
  } else if (opts.categoryKey) {
    q = q.eq("category_key", opts.categoryKey);
  }
  const { count, error } = await q;
  if (error) {
    throw new Error(
      `countFindings failed (case=${caseId}, modulePrefix=${opts.modulePrefix ?? "-"}, categoryKey=${opts.categoryKey ?? "-"}): ${error.message}`,
    );
  }
  return count ?? 0;
}

/**
 * Manual derived-engine reruns can happen after a case has already been
 * released. In that situation, the old report, canonical mirror and QA/
 * hallucination gates are stale the instant upstream intelligence is rerun.
 *
 * During the normal automatic pipeline the case status is non-terminal, so
 * this function is a deliberate no-op. That distinction is critical: the
 * pipeline itself calls these same derive* helpers before report generation.
 */
async function invalidateReleasedSnapshot(db: Db, caseId: string, source: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: caseRow, error: readError } = await (db as any)
    .from("cases")
    .select("status")
    .eq("id", caseId)
    .maybeSingle();
  if (readError) throw new Error(`[${source}] failed reading case state: ${readError.message}`);

  const currentStatus = String(caseRow?.status ?? "");
  // `needs_revision` is a preserved blocked draft, not a released snapshot.
  // Diagnostic/derived reruns must never delete the report that explains why
  // release was blocked.
  const terminal = new Set(["released", "complete"]);
  if (!terminal.has(currentStatus)) return;

  const derivedTables = ["report_versions", "canonical_analysis", "reports"] as const;
  for (const table of derivedTables) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).from(table).delete().eq("case_id", caseId);
    if (error) throw new Error(`[${source}] failed invalidating ${table}: ${error.message}`);
  }

  // shared_brief is a cached snapshot. It must not survive a post-release
  // upstream rerun because a later report could otherwise re-inject the old
  // contradiction/missing-evidence state even when case_findings is current.
  const patch: Record<string, unknown> = {
    report_at: null,
    hallucination_at: null,
    completed_at: null,
    shared_brief: null,
    shared_brief_at: null,
    hallucination_report: null,
    legal_qa_report: null,
    report_checkpoint_count: 0,
    status: "needs_revision",
    status_message: "Upstream intelligence changed; regenerate report and verification gates",
    progress: 90,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (db as any).from("cases").update(patch).eq("id", caseId);
  if (updateError) {
    throw new Error(`[${source}] failed invalidating case report state: ${updateError.message}`);
  }
}

export async function deriveContradictions(
  db: Db,
  caseId: string,
  opts: { invalidateReport?: boolean } = {},
) {
  const n = await countFindings(db, caseId, DERIVED_ENGINE_SOURCES.contradictions);
  if (opts.invalidateReport !== false) {
    await invalidateReleasedSnapshot(db, caseId, "deriveContradictions");
  }
  return {
    value: { derived_from: "analyzers", contradictions: n },
    stats: { generated: n, accepted: n },
  };
}

export async function deriveDiscoveryGaps(db: Db, caseId: string) {
  const n = await countFindings(db, caseId, DERIVED_ENGINE_SOURCES.discoveryGaps);
  await invalidateReleasedSnapshot(db, caseId, "deriveDiscoveryGaps");
  return {
    value: { derived_from: "analyzers", missing_evidence: n },
    stats: { generated: n, accepted: n },
  };
}

export async function deriveEvidenceIntel(db: Db, caseId: string) {
  const n = await countFindings(db, caseId, DERIVED_ENGINE_SOURCES.evidenceIntel);
  await invalidateReleasedSnapshot(db, caseId, "deriveEvidenceIntel");
  return {
    value: { derived_from: "analyzers", procedural_issues: n },
    stats: { generated: n, accepted: n },
  };
}

export async function deriveWitnessIntel(db: Db, caseId: string) {
  const n = await countFindings(db, caseId, DERIVED_ENGINE_SOURCES.witnessIntel);
  await invalidateReleasedSnapshot(db, caseId, "deriveWitnessIntel");
  return {
    value: { derived_from: "agents.witness_credibility", witnesses: n },
    stats: { generated: n, accepted: n },
  };
}
