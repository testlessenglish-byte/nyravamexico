// Automatic Mexican case-context detection at run time.
//
// An attorney should never have to declare the materia or the jurisdiction
// before running a case: both are inferable from the corpus itself. This
// helper runs at the very start of the pipeline and stamps `cases.case_type`
// and `cases.jurisdiction` when the attorney left them blank, so stage
// selection, prompts and reports are jurisdiction-aware from stage 1.
//
// Nothing here calls an AI provider — detection is deterministic keyword
// classification over the extracted corpus (see mx-case-classifier and
// intelligence/mx-jurisdiction), so it costs no quota.
//
// Delegates the actual detection + evidence trail to
// intelligence/case-classification.server.ts (source-grounded: every
// detected field carries the document/page/quote that established it, and
// disagreeing documents produce a recorded CONFLICT rather than a silent
// pick) — this module is now a thin adapter that keeps the
// AutoDetectResult contract every existing caller already relies on.
import type { SupabaseClient } from "@supabase/supabase-js";

const TEXT_MIME = /^(text\/|application\/json)/i;
const TEXT_EXT = /\.(txt|md|csv|json)$/i;
const CORPUS_LIMIT = 120_000;

/** Concatenated corpus for a case: extracted text first, raw text files as fallback. */
async function readCorpusText(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  caseId: string,
): Promise<string> {
  const { data } = await supabase
    .from("documents")
    .select("extracted_text,filename,mime_type,storage_path")
    .eq("case_id", caseId)
    .limit(200);
  const rows = (data ?? []) as Array<{
    extracted_text: string | null;
    filename: string | null;
    mime_type: string | null;
    storage_path: string | null;
  }>;

  let out = "";
  for (const r of rows) {
    if (r.extracted_text) out += `${r.extracted_text}\n\n`;
    if (out.length > CORPUS_LIMIT) return out.slice(0, CORPUS_LIMIT);
  }
  if (out.trim().length > 0) return out.slice(0, CORPUS_LIMIT);

  // Extraction hasn't run yet (fresh upload / freshly seeded case). Plain-text
  // documents can be read straight from storage so detection still happens on
  // the very first tick instead of waiting a full pipeline pass.
  for (const r of rows) {
    const isText = TEXT_MIME.test(r.mime_type ?? "") || TEXT_EXT.test(r.filename ?? "");
    if (!isText || !r.storage_path) continue;
    try {
      const { data: blob } = await supabase.storage.from("case-files").download(r.storage_path);
      if (blob) out += `${await blob.text()}\n\n`;
    } catch {
      /* best effort — detection degrades to declared values */
    }
    if (out.length > CORPUS_LIMIT) break;
  }
  return out.slice(0, CORPUS_LIMIT);
}

export type AutoDetectResult = {
  caseType: string | null;
  jurisdiction: string | null;
  detected: boolean;
  source: string | null;
};

/**
 * Resolve materia + jurisdiction for a case, persisting anything the attorney
 * left blank. Values already set by the attorney are never overwritten.
 */
export async function autoDetectCaseContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any> | any,
  caseId: string,
  userId?: string,
): Promise<AutoDetectResult> {
  const { data: row } = await supabase
    .from("cases")
    .select("case_type,jurisdiction")
    .eq("id", caseId)
    .maybeSingle();
  const current = (row ?? {}) as { case_type?: string | null; jurisdiction?: string | null };
  const declaredType = (current.case_type ?? "").trim();
  const declaredJur = (current.jurisdiction ?? "").trim();
  const needsType = !declaredType || declaredType.toLowerCase() === "unknown";
  const needsJur = !declaredJur;

  let result: AutoDetectResult;
  if (!needsType && !needsJur) {
    result = {
      caseType: declaredType || null,
      jurisdiction: declaredJur || null,
      detected: false,
      source: "case_field",
    };
  } else {
    const corpusText = await readCorpusText(supabase, caseId);
    if (!corpusText.trim()) {
      result = {
        caseType: declaredType || null,
        jurisdiction: declaredJur || null,
        detected: false,
        source: null,
      };
    } else {
      const { resolveMxCaseType } = await import("@/lib/mx-case-classifier");
      const { buildJurisdictionProfile } = await import("@/lib/intelligence/mx-jurisdiction");

      const decided = resolveMxCaseType({ text: corpusText, declaredArea: declaredType || null });
      const caseType = needsType ? decided.caseType : declaredType;

      const profile = buildJurisdictionProfile({
        caseType,
        jurisdictionField: declaredJur || null,
        corpusText,
      });
      // Store the CANONICAL jurisdiction value (a fuero, not a place name) so
      // the federal channel can be routed on reliably downstream.
      const jurisdiction = needsJur
        ? profile.jurisdiction_level === "federal"
          ? "federal"
          : (profile.state?.code ?? null)
        : declaredJur;

      const patch: Record<string, unknown> = {};
      if (needsType) patch.case_type = caseType;
      if (needsJur && jurisdiction) patch.jurisdiction = jurisdiction;
      if (Object.keys(patch).length) {
        const { getCaseConfiguration, updateCaseConfigurationWithClassification } = await import("@/lib/intelligence/case-configuration");
        const existingConfig = getCaseConfiguration(current as any);
        const updatedConfig = updateCaseConfigurationWithClassification(existingConfig, {
          detected_case_type: caseType,
          detected_jurisdiction: jurisdiction,
          allowAutoCorrection: true,
        });
        const currentMeta = (current.matter_metadata as Record<string, unknown> | null) ?? {};
        patch.matter_metadata = { ...currentMeta, case_configuration: updatedConfig };

        await supabase.from("cases").update(patch).eq("id", caseId);
      }

      result = {
        caseType,
        jurisdiction: jurisdiction ?? null,
        detected: Object.keys(patch).length > 0,
        source: needsType ? decided.source : "case_field",
      };
    }
  }

  // Build the source-grounded evidence trail (case type, jurisdiction, court,
  // parties, expediente number, concluded status — each with its own
  // document/page/quote) regardless of which branch above ran: the evidence
  // record must exist whether or not case_type/jurisdiction needed filling
  // in, so the UI can show "Source Verification: CONFIRMED BY SOURCE" (or
  // CONFLICT/INSUFFICIENT_DATA) and a manual override can be checked against
  // it later. Only refines cases.case_type/jurisdiction when it has better
  // (quote-verified) evidence than what's already there and the attorney
  // hasn't manually locked case_type away from a source classification — see
  // runCaseClassification()'s own guards. Never fatal: classification
  // evidence is a strict improvement over today's silent-guess behavior,
  // never a requirement for the pipeline to proceed.
  if (userId) {
    try {
      const { runCaseClassification } = await import("./intelligence/case-classification.server");
      await runCaseClassification(supabase, caseId, userId);
    } catch (e) {
      console.warn("[case-classification] evidence build failed", e);
    }
  }

  return result;
}
