// CRM Deadlines — case deadline management for the legal CRM.
//
// case_deadlines is a new table not yet in the auto-generated types.ts,
// so queries use `(client as any).from(...)`.
import { createServerFn } from "@tanstack/react-start";
import { type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

type Db = SupabaseClient<Database>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deadlinesTable(db: Db) { return (db as any).from("case_deadlines"); }

async function getAuthedUserId(context: { supabase?: Db; userId?: string }): Promise<string> {
  if (context?.userId) return context.userId;
  throw new Error("Not signed in.");
}

export const listUpcomingDeadlines = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await getAuthedUserId(ctx);

    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    // Get user's case IDs first, then fetch their deadlines
    const { data: userCases } = await (ctx.supabase as any)
      .from("cases")
      .select("id, name, case_number");

    const allCases = (userCases ?? []) as Array<{ id: string; name: string; case_number: string | null }>;
    const caseIds = allCases.map((c) => c.id);
    if (caseIds.length === 0) return [];

    const { data, error } = await deadlinesTable(ctx.supabase)
      .select("*")
      .in("case_id", caseIds)
      .eq("completed", false)
      .lte("due_date", thirtyDaysFromNow.toISOString().split("T")[0])
      .order("due_date", { ascending: true })
      .limit(50);

    if (error) throw new Error(error.message);

    // Attach case info
    const caseMap = new Map(
      allCases.map((c) => [c.id, { title: c.name, case_number: c.case_number }]),
    );

    return (data ?? []).map((d: Record<string, unknown>) => ({
      ...d,
      case_title: caseMap.get(d.case_id as string)?.title ?? null,
      case_number: caseMap.get(d.case_id as string)?.case_number ?? null,
    }));
  });

export const createDeadline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      case_id: z.string().uuid(),
      title: z.string().min(1).max(500),
      due_date: z.string(), // ISO date string
      source: z.enum(["manual", "ai_extracted", "court_calendar"]).optional().default("manual"),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional().default("normal"),
      notes: z.string().max(2000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    const userId = await getAuthedUserId(ctx);

    // Verify user has access to the case
    const { data: caseRow } = await ctx.supabase
      .from("cases")
      .select("id")
      .eq("id", data.case_id)
      .maybeSingle();
    if (!caseRow) throw new Error("Case not found or access denied.");

    const { data: newDeadline, error } = await deadlinesTable(ctx.supabase)
      .insert({ ...data, created_by: userId })
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return newDeadline;
  });

export const updateDeadline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      deadlineId: z.string().uuid(),
      title: z.string().min(1).max(500).optional(),
      due_date: z.string().optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      notes: z.string().max(2000).optional(),
      completed: z.boolean().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { deadlineId, ...updates } = data;
    const ctx = context as { supabase: Db; userId: string };
    await getAuthedUserId(ctx);

    const { data: updated, error } = await deadlinesTable(ctx.supabase)
      .update(updates)
      .eq("id", deadlineId)
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return updated;
  });
