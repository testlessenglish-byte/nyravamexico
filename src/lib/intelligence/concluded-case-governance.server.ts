import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  resolveReportGovernance,
  type ImmutableReportGovernance,
  type CaseGovernanceContext,
} from "./concluded-case-governance";

type Db = SupabaseClient<Database>;

/**
 * Centrally loads and resolves the immutable Concluded Case Governance contract from Supabase.
 */
export async function loadResolvedReportGovernance(
  db: Db,
  caseId: string,
  extra?: CaseGovernanceContext,
): Promise<ImmutableReportGovernance> {
  const { data: caseRow, error } = await db
    .from("cases")
    .select("case_analysis_mode,analysis_mode,matter_metadata")
    .eq("id", caseId)
    .maybeSingle();

  if (error || !caseRow) throw new Error("REPORT_GOVERNANCE_CONTEXT_UNAVAILABLE: " + (error?.message ?? "case missing"));
  const row = caseRow as Record<string, unknown>;
  const meta = (row.matter_metadata as Record<string, unknown> | null) ?? {};

  const governance = resolveReportGovernance({
    procedural_posture: (row.procedural_posture as string | null) ?? (meta.procedural_posture as string | null) ?? null,
    case_analysis_mode: (row.case_analysis_mode as string | null) ?? (meta.case_analysis_mode as string | null) ?? null,
    analysis_mode: (row.analysis_mode as string | null) ?? null,
    matter_metadata: meta,
    post_judgment_options_analysis: Boolean(meta.post_judgment_options_analysis),
    remedy_exhaustion_verified: Boolean(meta.remedy_exhaustion_verified),
    is_final_resolution: extra?.is_final_resolution,
    resolutivos: extra?.resolutivos,
    corpusText: extra?.corpusText,
    execution_id: extra?.execution_id,
    ...extra,
  });

  return governance;
}

// Backward-compatible alias
export const loadConcludedCaseGovernance = loadResolvedReportGovernance;
