// CRM Client Management — CRUD operations for the legal CRM.
//
// New tables (clients, case_deadlines, crm_activity_log) are not yet
// in the auto-generated Supabase types.ts, so queries against them use
// `(client as any).from(...)` — the same pattern billing.functions.ts
// uses for billing_provider_settings and other tables added after the
// types were last generated.
import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

type Db = SupabaseClient<Database>;

function getAdminClient(): Db {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Backend environment unavailable (missing SUPABASE_SERVICE_ROLE_KEY).");
  }
  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}

async function getAuthedUserId(context: { supabase?: Db; userId?: string }): Promise<string> {
  if (context?.userId) return context.userId;
  throw new Error("Not signed in.");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clientsTable(db: Db) { return (db as any).from("clients"); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deadlinesTable(db: Db) { return (db as any).from("case_deadlines"); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function activityTable(db: Db) { return (db as any).from("crm_activity_log"); }

// ---------------------------------------------------------------------------
// List Clients
// ---------------------------------------------------------------------------
export const listClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      search: z.string().optional(),
      status: z.string().optional(),
    }).optional().parse(d),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await getAuthedUserId(ctx);

    let query = clientsTable(ctx.supabase).select("*").order("updated_at", { ascending: false });

    if (data?.status) {
      query = query.eq("status", data.status);
    }
    if (data?.search) {
      const q = data.search.trim();
      query = query.or(
        `display_name.ilike.%${q}%,legal_name.ilike.%${q}%,email.ilike.%${q}%,reference_number.ilike.%${q}%`,
      );
    }

    const { data: clients, error } = await query;
    if (error) throw new Error(error.message);

    // Fetch case counts per client in a second query
    const clientIds = (clients ?? []).map((c: { id: string }) => c.id);
    let caseCounts: Record<string, number> = {};
    if (clientIds.length > 0) {
      const { data: countRows } = await (ctx.supabase as any)
        .from("cases")
        .select("client_id")
        .in("client_id", clientIds);
      for (const row of (countRows ?? []) as Array<{ client_id: string }>) {
        caseCounts[row.client_id] = (caseCounts[row.client_id] ?? 0) + 1;
      }
    }

    return (clients ?? []).map((client: Record<string, unknown>) => ({
      ...client,
      case_count: caseCounts[(client as { id: string }).id] ?? 0,
    }));
  });

// ---------------------------------------------------------------------------
// Get Client Detail
// ---------------------------------------------------------------------------
export const getClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ clientId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await getAuthedUserId(ctx);

    const { data: client, error } = await clientsTable(ctx.supabase)
      .select("*")
      .eq("id", data.clientId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!client) throw new Error("Client not found or access denied.");

    // Cases for this client — client_id is new, not yet in types
    const { data: cases } = await (ctx.supabase as any)
      .from("cases")
      .select("id, name, case_number, status, matter_type, updated_at")
      .eq("client_id", data.clientId)
      .order("updated_at", { ascending: false });

    const allCases = (cases ?? []) as Array<Record<string, unknown>>;
    const activeCases = allCases.filter(
      (c) => !["complete", "cancelled", "failed"].includes(c.status as string),
    );
    const closedCases = allCases.filter(
      (c) => ["complete", "cancelled"].includes(c.status as string),
    );

    // Upcoming deadlines across this client's cases
    const caseIds = allCases.map((c) => c.id as string);
    let upcomingDeadlines: unknown[] = [];
    if (caseIds.length > 0) {
      const { data: deadlines } = await deadlinesTable(ctx.supabase)
        .select("*")
        .in("case_id", caseIds)
        .eq("completed", false)
        .order("due_date", { ascending: true })
        .limit(20);
      upcomingDeadlines = deadlines ?? [];
    }

    return {
      ...(client as Record<string, unknown>),
      cases: allCases,
      case_count: allCases.length,
      active_case_count: activeCases.length,
      closed_case_count: closedCases.length,
      upcoming_deadlines: upcomingDeadlines,
    };
  });

// ---------------------------------------------------------------------------
// Create Client
// ---------------------------------------------------------------------------
export const createClientFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      display_name: z.string().min(1).max(300),
      client_type: z.string().optional().default("individual"),
      legal_name: z.string().max(500).optional(),
      rfc: z.string().max(20).optional(),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().max(30).optional(),
      address: z.string().max(1000).optional(),
      reference_number: z.string().max(100).optional(),
      responsible_attorney: z.string().uuid().optional(),
      notes: z.string().max(5000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    const userId = await getAuthedUserId(ctx);

    // Look up org membership
    const { data: orgMembership } = await ctx.supabase
      .from("org_memberships")
      .select("org_id")
      .eq("user_id", userId)
      .eq("status", "active")
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();

    const insertRow = {
      ...data,
      email: data.email || null,
      user_id: userId,
      org_id: orgMembership?.org_id ?? null,
      created_by: userId,
    };

    const { data: newClient, error } = await clientsTable(ctx.supabase)
      .insert(insertRow)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    // Audit log (best-effort)
    try {
      const admin = getAdminClient();
      await activityTable(admin).insert({
        org_id: orgMembership?.org_id ?? null,
        actor_id: userId,
        action: "client_created",
        resource_type: "client",
        resource_id: (newClient as { id: string }).id,
        metadata: { display_name: data.display_name },
      });
    } catch { /* non-critical */ }

    return newClient;
  });

// ---------------------------------------------------------------------------
// Update Client
// ---------------------------------------------------------------------------
export const updateClientFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      clientId: z.string().uuid(),
      display_name: z.string().min(1).max(300).optional(),
      client_type: z.string().optional(),
      legal_name: z.string().max(500).optional(),
      rfc: z.string().max(20).optional(),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().max(30).optional(),
      address: z.string().max(1000).optional(),
      reference_number: z.string().max(100).optional(),
      responsible_attorney: z.string().uuid().optional(),
      notes: z.string().max(5000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { clientId, ...updates } = data;
    const ctx = context as { supabase: Db; userId: string };
    const userId = await getAuthedUserId(ctx);

    const { data: updated, error } = await clientsTable(ctx.supabase)
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", clientId)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    try {
      const admin = getAdminClient();
      await activityTable(admin).insert({
        actor_id: userId,
        action: "client_updated",
        resource_type: "client",
        resource_id: clientId,
      });
    } catch { /* non-critical */ }

    return updated;
  });

// ---------------------------------------------------------------------------
// Archive Client
// ---------------------------------------------------------------------------
export const archiveClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ clientId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    const userId = await getAuthedUserId(ctx);

    const { data: updated, error } = await clientsTable(ctx.supabase)
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("id", data.clientId)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    try {
      const admin = getAdminClient();
      await activityTable(admin).insert({
        actor_id: userId,
        action: "client_archived",
        resource_type: "client",
        resource_id: data.clientId,
      });
    } catch { /* non-critical */ }

    return updated;
  });
