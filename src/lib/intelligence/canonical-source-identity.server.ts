import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  normalizeCanonicalSources,
  type CanonicalSourceAuditResult,
} from "./canonical-source-identity";

type Db = SupabaseClient<Database>;

/**
 * Loads and normalizes all canonical source documents for a case from Postgres.
 */
export async function loadCanonicalSourcesForCase(
  db: Db,
  caseId: string,
): Promise<CanonicalSourceAuditResult> {
  const { data: docs } = await db
    .from("documents")
    .select("id,filename,content_hash,metadata,entities,size_bytes,mime_type,created_at,status")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });

  const rawDocs = (docs ?? []).map((d: any) => ({
    id: d.id,
    document_id: d.id,
    content_hash: d.content_hash ?? d.metadata?.content_hash ?? null,
    filename: d.filename,
    original_filename: d.filename,
    display_name: d.metadata?.display_name ?? d.filename,
    mime_type: d.mime_type,
    size_bytes: d.size_bytes,
    created_at: d.created_at,
    metadata: d.metadata,
    entities: d.entities,
  }));

  const audit = normalizeCanonicalSources(rawDocs);

  // Store canonical source snapshot in case matter_metadata
  try {
    const { data: caseRow } = await db
      .from("cases")
      .select("matter_metadata")
      .eq("id", caseId)
      .maybeSingle();

    const existingMeta = ((caseRow as any)?.matter_metadata ?? {}) as Record<string, unknown>;
    await (db as any)
      .from("cases")
      .update({
        matter_metadata: {
          ...existingMeta,
          canonical_sources: audit.canonical_sources,
          source_metrics: audit.metrics,
          source_invariants: audit.invariants,
        },
      })
      .eq("id", caseId);
  } catch (e) {
    console.warn("[canonical-sources] Failed to persist source metrics to case metadata", e);
  }

  return audit;
}
