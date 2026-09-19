// Server side of the `jurisdiction_intel` stage ("Inteligencia de
// JurisdicciÃ³n"). Reads the case row + extracted corpus, resolves the Mexican
// jurisdiction profile deterministically, and persists it on
// cases.jurisdiction_profile so every downstream engine and the report can
// cite the correct codes and courts.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildJurisdictionProfile, type JurisdictionProfile } from "./mx-jurisdiction";
import { resolveCaseIdentity } from "./case-classification.server";

type Db = SupabaseClient<Database>;

const CORPUS_CHAR_LIMIT = 120_000;

export async function loadCaseCorpusText(db: Db, caseId: string, limit = CORPUS_CHAR_LIMIT): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from("documents")
    .select("extracted_text")
    .eq("case_id", caseId)
    .is("archived_at", null);
  const rows = (data ?? []) as { extracted_text: string | null }[];
  let out = "";
  for (const r of rows) {
    if (!r.extracted_text) continue;
    out += `${r.extracted_text}\n\n`;
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

export async function runJurisdictionIntelligence(args: {
  db: Db;
  caseId: string;
}): Promise<JurisdictionProfile> {
  const { db, caseId } = args;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: caseRow } = await (db as any)
    .from("cases")
    .select("case_type, jurisdiction")
    .eq("id", caseId)
    .maybeSingle();
  const row = (caseRow ?? {}) as { case_type?: string | null; jurisdiction?: string | null };

  // VERIFIED CASE IDENTITY â€” jurisdiction/materia law selection is legal
  // reasoning; never a raw cases.case_type read. Verified/attorney-locked/
  // declared value is used (buildJurisdictionProfile also cross-checks
  // against corpusText itself). CORRECTION: buildJurisdictionProfile calls
  // resolveMxProfile() internally, which is the STRICT variant (an alias
  // for requireMxProfile) â€” it throws for null/unrecognized input, it does
  // NOT accept null gracefully as this comment previously and incorrectly
  // claimed. Confirmed live in production: a genuinely unusable identity
  // (unverified-with-nothing, or a real attorney-lock-vs-evidence conflict)
  // crashed this stage outright with "Materia desconocida en
  // requireMxProfile". "civil" is used here only as that last-resort
  // structural fallback â€” see mxProfileOrNull for the tolerant variant, not
  // used here because buildJurisdictionProfile requires a real profile.
  const jurisdictionIdentity = await resolveCaseIdentity(db, caseId);
  const resolvedCaseType = jurisdictionIdentity.caseType ?? "civil";

  const corpusText = await loadCaseCorpusText(db, caseId);
  const { data: courtEvidence } = await (db as any)
    .from("case_classification_evidence")
    .select("value")
    .eq("case_id", caseId)
    .eq("field", "court")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const issuingCourt = (courtEvidence as { value?: string })?.value ?? null;
  const profile = buildJurisdictionProfile({
    caseType: resolvedCaseType,
    jurisdictionField: row.jurisdiction ?? null,
    corpusText,
    issuingCourt,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from("cases")
    .update({ jurisdiction_profile: profile as unknown as Record<string, unknown> })
    .eq("id", caseId);
  if (error) throw new Error(`No se pudo guardar el perfil de jurisdicciÃ³n: ${error.message}`);

  return profile;
}

