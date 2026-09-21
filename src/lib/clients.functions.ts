// CRM Client Management — CRUD operations for the legal CRM.
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clientAssignmentsTable(db: Db) { return (db as any).from("client_assignments"); }

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
      const q = data.search
        .trim()
        .slice(0, 100)
        .replace(/[\\%_,.()"']/g, (ch) => (ch === "%" || ch === "_" ? `\\${ch}` : " "))
        .trim();
      if (q.length > 0) {
        query = query.or(
          `display_name.ilike.*${q}*,legal_name.ilike.*${q}*,email.ilike.*${q}*,reference_number.ilike.*${q}*`,
        );
      }
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

    // Cases for this client
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
    } as any;
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
      status: z.string().optional(),
      responsible_attorney: z.string().uuid().optional(),
      notes: z.string().max(5000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { clientId, ...updates } = data;
    const ctx = context as { supabase: Db; userId: string };
    const userId = await getAuthedUserId(ctx);

    const cleanUpdates: Record<string, unknown> = {
      ...updates,
      updated_at: new Date().toISOString(),
    };
    if (updates.email === "") cleanUpdates.email = null;

    const { data: updated, error } = await clientsTable(ctx.supabase)
      .update(cleanUpdates)
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

// ---------------------------------------------------------------------------
// Delete Client
// ---------------------------------------------------------------------------
export const deleteClientFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async (ctx) => {
    const { data, context } = ctx;
    const supabase = context.supabase;

    // Check if user has access to client
    const { data: client, error: clientErr } = await clientsTable(supabase)
      .select("id, user_id, created_by")
      .eq("id", data.clientId)
      .maybeSingle();

    if (clientErr || !client) {
      throw new Error("Cliente no encontrado o no tiene permisos para eliminarlo.");
    }

    // Check active cases
    const CLOSED_STATUSES = ["complete", "released", "cancelled", "failed"];
    const admin = getAdminClient();

    const { data: allCases } = await (admin as any)
      .from("cases")
      .select("id, status")
      .eq("client_id", data.clientId);

    const activeCases = (allCases ?? []).filter(
      (c: { status?: string }) => !CLOSED_STATUSES.includes(c.status ?? ""),
    );

    if (activeCases.length > 0) {
      throw new Error("No se puede eliminar el cliente porque tiene casos activos. Por favor, reasigne o elimine los casos activos primero.");
    }

    // Unlink non-active cases using admin client to bypass cases RLS during foreign key cleanup
    await (admin as any)
      .from("cases")
      .update({ client_id: null })
      .eq("client_id", data.clientId);

    // Remove client assignments
    await (admin as any)
      .from("client_assignments")
      .delete()
      .eq("client_id", data.clientId);

    // Delete client record using authed supabase client, fallback to admin client if verified owner
    const { error } = await clientsTable(supabase)
      .delete()
      .eq("id", data.clientId);

    if (error) {
      console.warn("Authed client delete failed, trying admin client for verified owner:", error.message);
      const { error: adminErr } = await clientsTable(admin)
        .delete()
        .eq("id", data.clientId);

      if (adminErr) {
        console.error("Delete client error:", adminErr);
        throw new Error("No se pudo eliminar el cliente: " + adminErr.message);
      }
    }

    return { success: true };
  });

// ---------------------------------------------------------------------------
// Client Assignments (Explicit Sharing)
// ---------------------------------------------------------------------------
export const assignClientFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      clientId: z.string().uuid(),
      targetUserId: z.string().uuid(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    const userId = await getAuthedUserId(ctx);

    const { data: assignment, error } = await clientAssignmentsTable(ctx.supabase)
      .upsert(
        {
          client_id: data.clientId,
          user_id: data.targetUserId,
          assigned_by: userId,
        },
        { onConflict: "client_id,user_id" },
      )
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    try {
      const admin = getAdminClient();
      await activityTable(admin).insert({
        actor_id: userId,
        action: "client_assigned",
        resource_type: "client",
        resource_id: data.clientId,
        metadata: { assigned_to: data.targetUserId },
      });
    } catch { /* non-critical */ }

    return assignment;
  });

export const unassignClientFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      clientId: z.string().uuid(),
      targetUserId: z.string().uuid(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    const userId = await getAuthedUserId(ctx);

    const { error } = await clientAssignmentsTable(ctx.supabase)
      .delete()
      .eq("client_id", data.clientId)
      .eq("user_id", data.targetUserId);

    if (error) throw new Error(error.message);

    try {
      const admin = getAdminClient();
      await activityTable(admin).insert({
        actor_id: userId,
        action: "client_unassigned",
        resource_type: "client",
        resource_id: data.clientId,
        metadata: { unassigned_user: data.targetUserId },
      });
    } catch { /* non-critical */ }

    return { success: true };
  });

export const listClientAssignmentsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ clientId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await getAuthedUserId(ctx);

    const { data: assignments, error } = await clientAssignmentsTable(ctx.supabase)
      .select("*")
      .eq("client_id", data.clientId);

    if (error) throw new Error(error.message);
    return assignments ?? [];
  });
