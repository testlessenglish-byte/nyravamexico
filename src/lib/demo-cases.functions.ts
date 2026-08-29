// "Experience Nyrava" homepage demos.
//
// Public functions (listPublishedDemoCases / getPublishedDemoCase) require no
// session — they're read by signed-out visitors on the homepage and the demo
// viewer — so they go straight through supabaseAdmin (service role) with an
// explicit `published = true` filter enforced in code, rather than through
// requireSupabaseAuth (which throws for anonymous requests).
//
// Admin functions follow the same requireAdmin(ctx) shape as
// billing-plans.functions.ts: a user-scoped call checks is_admin_tier /
// is_super_admin, then writes go through supabaseAdmin so storage uploads
// don't depend on getting storage RLS exactly right.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRACTICE_AREA_LABELS, type PracticeArea } from "@/lib/intelligence/practice-areas";

type Db = SupabaseClient<Database>;

export const DEMO_DOC_TYPES = [
  "evidence",
  "timeline",
  "witness_analysis",
  "motion",
  "attorney_report",
  "final_report",
  "other",
] as const;
export type DemoDocType = (typeof DEMO_DOC_TYPES)[number];

export const DEMO_DOC_TYPE_LABELS: Record<DemoDocType, string> = {
  evidence: "Evidence",
  timeline: "Timeline",
  witness_analysis: "Witness Analysis",
  motion: "Motion",
  attorney_report: "Attorney Report",
  final_report: "Final Report (PDF)",
  other: "Additional case file",
};

const CASE_TYPE_VALUES = Object.keys(PRACTICE_AREA_LABELS) as [PracticeArea, ...PracticeArea[]];
const BUCKET = "demo-cases";

async function requireAdmin(ctx: { supabase: Db; userId: string }) {
  const { data: isAdmin, error } = await ctx.supabase.rpc("is_admin_tier", { _user_id: ctx.userId });
  if (error) throw new Error(error.message);
  if (!isAdmin) throw new Error("Forbidden — admin required.");
}

// The demo-cases bucket is PRIVATE. Every URL handed to the browser is a
// short-lived signed URL minted server-side, so unpublished/staging assets can
// never be read by simply guessing an object path.
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

async function signedUrl(admin: Db, path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) return null;
  return data?.signedUrl ?? null;
}

// -------------------- Public (no auth) --------------------

export const listPublishedDemoCases = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("demo_cases")
      .select("id,slug,name,case_type,summary,thumbnail_path,sort_order")
      .eq("published", true)
      .order("sort_order", { ascending: true });
    if (error) {
      console.warn("[demo-cases] Failed to list published demo cases:", error.message);
      return [];
    }
    return await Promise.all(
      (data ?? []).map(async (c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        case_type: c.case_type,
        case_type_label: PRACTICE_AREA_LABELS[c.case_type as PracticeArea] ?? c.case_type,
        summary: c.summary,
        thumbnail_url: await signedUrl(supabaseAdmin, c.thumbnail_path),
        sort_order: c.sort_order ?? 0,
      })),
    );
  } catch (err) {
    console.warn("[demo-cases] listPublishedDemoCases degraded:", err);
    return [];
  }
});

export const getPublishedDemoCase = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ slug: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: demoCase, error } = await supabaseAdmin
      .from("demo_cases")
      .select("id,slug,name,case_type,summary,description,thumbnail_path")
      .eq("slug", data.slug)
      .eq("published", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!demoCase) throw new Error("Demo case not found");
    const { data: docs, error: docsError } = await supabaseAdmin
      .from("demo_case_documents")
      .select("id,doc_type,file_name,storage_path,sort_order")
      .eq("demo_case_id", demoCase.id)
      .order("sort_order", { ascending: true });
    if (docsError) throw new Error(docsError.message);
    return {
      id: demoCase.id,
      slug: demoCase.slug,
      name: demoCase.name,
      case_type: demoCase.case_type,
      case_type_label: PRACTICE_AREA_LABELS[demoCase.case_type as PracticeArea] ?? demoCase.case_type,
      summary: demoCase.summary,
      description: demoCase.description,
      thumbnail_url: await signedUrl(supabaseAdmin, demoCase.thumbnail_path),
      documents: await Promise.all(
        (docs ?? []).map(async (d) => ({
          id: d.id,
          doc_type: d.doc_type as DemoDocType,
          file_name: d.file_name,
          url: (await signedUrl(supabaseAdmin, d.storage_path)) ?? "",
        })),
      ),
    };
  });

// -------------------- Admin --------------------

export const adminListDemoCases = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: cases, error } = await supabaseAdmin
      .from("demo_cases")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    const { data: docs, error: docsError } = await supabaseAdmin
      .from("demo_case_documents")
      .select("id,demo_case_id,doc_type,file_name,storage_path,file_size,sort_order,created_at");
    if (docsError) throw new Error(docsError.message);
    const byCase = new Map<string, typeof docs>();
    for (const d of docs ?? []) {
      const list = byCase.get(d.demo_case_id) ?? [];
      list.push(d);
      byCase.set(d.demo_case_id, list);
    }
    return await Promise.all(
      (cases ?? []).map(async (c) => ({
        ...c,
        thumbnail_url: await signedUrl(supabaseAdmin, c.thumbnail_path),
        documents: await Promise.all(
          (byCase.get(c.id) ?? []).map(async (d) => ({
            ...d,
            url: (await signedUrl(supabaseAdmin, d.storage_path)) ?? "",
          })),
        ),
      })),
    );
  });

const demoCaseInput = z.object({
  id: z.string().uuid().optional(),
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and dashes only"),
  name: z.string().min(1).max(200),
  case_type: z.enum(CASE_TYPE_VALUES),
  summary: z.string().max(300).default(""),
  description: z.string().max(4000).default(""),
  sort_order: z.number().int().default(0),
  published: z.boolean().default(false),
});
export type DemoCaseInput = z.infer<typeof demoCaseInput>;

export const adminSaveDemoCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => demoCaseInput.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const row = {
      slug: data.slug,
      name: data.name,
      case_type: data.case_type,
      summary: data.summary,
      description: data.description,
      sort_order: data.sort_order,
      published: data.published,
    };
    if (data.id) {
      const { data: updated, error } = await supabaseAdmin
        .from("demo_cases")
        .update(row)
        .eq("id", data.id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return updated;
    }
    const { data: inserted, error } = await supabaseAdmin.from("demo_cases").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return inserted;
  });

export const adminDeleteDemoCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Storage objects aren't removed automatically on row delete — clean the
    // folder up first so the bucket doesn't accumulate orphaned files.
    const { data: docs } = await supabaseAdmin
      .from("demo_case_documents")
      .select("storage_path")
      .eq("demo_case_id", data.id);
    const { data: caseRow } = await supabaseAdmin
      .from("demo_cases")
      .select("thumbnail_path")
      .eq("id", data.id)
      .maybeSingle();
    const paths = [...(docs ?? []).map((d) => d.storage_path), caseRow?.thumbnail_path].filter(
      (p): p is string => Boolean(p),
    );
    if (paths.length > 0) await supabaseAdmin.storage.from(BUCKET).remove(paths);
    const { error } = await supabaseAdmin.from("demo_cases").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const MAX_DEMO_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — demo files, not case evidence

export const adminUploadDemoThumbnail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => {
    if (!(d instanceof FormData)) throw new Error("FormData required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const demoCaseId = String(data.get("demo_case_id") ?? "");
    if (!z.string().uuid().safeParse(demoCaseId).success) throw new Error("Invalid demo case id");
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("No file uploaded");
    if (file.size > MAX_DEMO_FILE_BYTES) throw new Error("File exceeds 25 MB limit");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
    const path = `${demoCaseId}/thumbnail.${ext}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: file.type || undefined, upsert: true });
    if (uploadError) throw new Error(uploadError.message);
    const { error } = await supabaseAdmin.from("demo_cases").update({ thumbnail_path: path }).eq("id", demoCaseId);
    if (error) throw new Error(error.message);
    return { path, url: (await signedUrl(supabaseAdmin, path)) ?? "" };
  });

export const adminUploadDemoDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => {
    if (!(d instanceof FormData)) throw new Error("FormData required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const demoCaseId = String(data.get("demo_case_id") ?? "");
    if (!z.string().uuid().safeParse(demoCaseId).success) throw new Error("Invalid demo case id");
    const docType = String(data.get("doc_type") ?? "");
    if (!(DEMO_DOC_TYPES as readonly string[]).includes(docType)) throw new Error("Invalid document type");
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("No file uploaded");
    if (file.size > MAX_DEMO_FILE_BYTES) throw new Error("File exceeds 25 MB limit");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Fixed slots (everything but "other") replace whatever was uploaded
    // there before — both in storage and in the row (unique index enforces
    // one row per slot).
    if (docType !== "other") {
      const { data: existing } = await supabaseAdmin
        .from("demo_case_documents")
        .select("id,storage_path")
        .eq("demo_case_id", demoCaseId)
        .eq("doc_type", docType)
        .maybeSingle();
      if (existing) {
        await supabaseAdmin.storage.from(BUCKET).remove([existing.storage_path]);
        await supabaseAdmin.from("demo_case_documents").delete().eq("id", existing.id);
      }
    }

    const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 150);
    const path = `${demoCaseId}/${docType}/${Date.now()}_${safeName}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: file.type || "application/pdf" });
    if (uploadError) throw new Error(uploadError.message);

    const { data: inserted, error } = await supabaseAdmin
      .from("demo_case_documents")
      .insert({
        demo_case_id: demoCaseId,
        doc_type: docType,
        file_name: file.name,
        storage_path: path,
        file_size: file.size,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { ...inserted, url: (await signedUrl(supabaseAdmin, path)) ?? "" };
  });

export const adminDeleteDemoDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: doc } = await supabaseAdmin
      .from("demo_case_documents")
      .select("storage_path")
      .eq("id", data.id)
      .maybeSingle();
    if (doc) await supabaseAdmin.storage.from(BUCKET).remove([doc.storage_path]);
    const { error } = await supabaseAdmin.from("demo_case_documents").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
