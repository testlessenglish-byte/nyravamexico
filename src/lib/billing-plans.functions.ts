// Admin-managed billing plans. Reads through user-scoped Supabase (RLS)
// so anon/authenticated see only active plans and admins see everything +
// can write.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<Database>;
export type BillingPlanRow = Database["public"]["Tables"]["billing_plans"]["Row"];

const planInput = z.object({
  id: z.string().uuid().optional(),
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/i, "Key must be alphanumeric / dash / underscore"),
  label: z.string().min(1).max(120),
  tagline: z.string().max(500).default(""),
  features: z.array(z.string().min(1).max(300)).default([]),
  price_cents: z.number().int().min(0).default(0),
  currency: z.string().length(3).default("usd"),
  interval: z.enum(["month", "year", "one_time"]).default("month"),
  stripe_price_id: z.string().trim().max(200).nullable().optional(),
  self_serve: z.boolean().default(true),
  contact_url: z.string().trim().max(500).nullable().optional(),
  sort_order: z.number().int().default(0),
  active: z.boolean().default(true),
  // Seat metering — optional per-plan add-on line item at checkout.
  included_seats: z.number().int().min(1).default(1),
  per_seat_price_cents: z.number().int().min(0).nullable().optional(),
  per_seat_stripe_price_id: z.string().trim().max(200).nullable().optional(),
  // Admin-only. Never surfaced on /billing.
  internal_notes: z.string().max(4000).nullable().optional(),
  // Usage metering — see usage.server.ts. null = unlimited for every one of these.
  ai_requests_monthly: z.number().int().min(0).nullable().optional(),
  talk_to_case_monthly: z.number().int().min(0).nullable().optional(),
  case_limit: z.number().int().min(0).nullable().optional(),
  storage_gb_limit: z.number().min(0).nullable().optional(),
  team_member_limit: z.number().int().min(0).nullable().optional(),
  byok_allowed: z.boolean().default(true),
  overage_price_cents: z.number().int().min(0).nullable().optional(),
});

async function requireAdmin(ctx: { supabase: Db; userId: string }) {
  const { data: isAdmin, error } = await ctx.supabase.rpc("is_admin_tier", {
    _user_id: ctx.userId,
  });
  if (error) throw new Error(error.message);
  if (!isAdmin) throw new Error("Forbidden — admin required.");
}

/** Admin list — includes inactive/draft plans plus admin-only internal notes. */
export const adminListBillingPlans = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const { data, error } = await ctx.supabase
      .from("billing_plans")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    // internal_notes lives in an admin-only side table so the public plan read
    // (anon can SELECT active plans) can never expose it.
    const { data: notes, error: notesErr } = await ctx.supabase
      .from("billing_plan_notes")
      .select("plan_id,notes");
    if (notesErr) throw new Error(notesErr.message);
    const byPlan = new Map((notes ?? []).map((n) => [n.plan_id, n.notes ?? null]));
    return (data ?? []).map((p) => ({ ...p, internal_notes: byPlan.get(p.id) ?? null }));
  });

export const adminUpsertBillingPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => planInput.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const row = {
      key: data.key,
      label: data.label,
      // Legacy NOT NULL columns kept in sync with key/label so inserts succeed.
      code: data.key,
      name: data.label,
      tagline: data.tagline,
      features:
        data.features as unknown as Database["public"]["Tables"]["billing_plans"]["Insert"]["features"],
      price_cents: data.price_cents,
      currency: data.currency.toLowerCase(),
      interval: data.interval,
      stripe_price_id: data.stripe_price_id?.trim() || null,
      self_serve: data.self_serve,
      contact_url: data.contact_url?.trim() || null,
      sort_order: data.sort_order,
      active: data.active,
      included_seats: data.included_seats,
      per_seat_price_cents:
        typeof data.per_seat_price_cents === "number" ? data.per_seat_price_cents : null,
      per_seat_stripe_price_id: data.per_seat_stripe_price_id?.trim() || null,
      ai_requests_monthly:
        typeof data.ai_requests_monthly === "number" ? data.ai_requests_monthly : null,
      talk_to_case_monthly:
        typeof data.talk_to_case_monthly === "number" ? data.talk_to_case_monthly : null,
      case_limit: typeof data.case_limit === "number" ? data.case_limit : null,
      storage_gb_limit: typeof data.storage_gb_limit === "number" ? data.storage_gb_limit : null,
      team_member_limit: typeof data.team_member_limit === "number" ? data.team_member_limit : null,
      byok_allowed: data.byok_allowed,
      overage_price_cents:
        typeof data.overage_price_cents === "number" ? data.overage_price_cents : null,
    } as unknown as Database["public"]["Tables"]["billing_plans"]["Insert"];

    const notes = data.internal_notes?.trim() || null;
    const saveNotes = async (planId: string) => {
      if (notes === null) {
        const { error } = await ctx.supabase
          .from("billing_plan_notes")
          .delete()
          .eq("plan_id", planId);
        if (error) throw new Error(error.message);
        return;
      }
      const { error } = await ctx.supabase
        .from("billing_plan_notes")
        .upsert({ plan_id: planId, notes }, { onConflict: "plan_id" });
      if (error) throw new Error(error.message);
    };

    if (data.id) {
      const { data: updated, error } = await ctx.supabase
        .from("billing_plans")
        .update(row)
        .eq("id", data.id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      await saveNotes(data.id);
      return { ...updated, internal_notes: notes };
    }
    const { data: inserted, error } = await ctx.supabase
      .from("billing_plans")
      .insert(row)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    await saveNotes(inserted.id);
    return { ...inserted, internal_notes: notes };
  });

export const adminDeleteBillingPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const { error } = await ctx.supabase.from("billing_plans").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Public marketing list of admin-managed plans (no secrets). Includes the
 *  published allowances so plan cards can show what each plan includes. */
export type PublicBillingPlan = {
  key: string;
  label: string;
  tagline: string | null;
  features: string[];
  /** Raw features JSON when admins stored an object (e.g. documents_limit). */
  featureLimits: Record<string, string | number | boolean | null>;
  price_cents: number;
  currency: string;
  interval: string;
  self_serve: boolean;
  contact_url: string | null;
  included_seats: number | null;
  per_seat_price_cents: number | null;
  sort_order: number;
  ai_requests_monthly: number | null;
  talk_to_case_monthly: number | null;
  case_limit: number | null;
  storage_gb_limit: number | null;
  team_member_limit: number | null;
  byok_allowed: boolean;
};

export const listPublicBillingPlans = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as { supabase: Db };
    const { data, error } = await (ctx.supabase as any).rpc("list_public_billing_plans");
    if (error) throw new Error(error.message);
    return ((data ?? []) as any[]).map((p) => ({
      key: p.key as string,
      label: (p.label as string) ?? (p.key as string),
      tagline: (p.tagline as string) ?? null,
      features: Array.isArray(p.features)
        ? (p.features as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      featureLimits:
        p.features && !Array.isArray(p.features) && typeof p.features === "object"
          ? (p.features as Record<string, string | number | boolean | null>)
          : {},
      price_cents: Number(p.price_cents ?? 0),
      currency: (p.currency as string) ?? "mxn",
      interval: (p.interval as string) ?? "month",
      self_serve: Boolean(p.self_serve),
      contact_url: (p.contact_url as string) ?? null,
      included_seats: p.included_seats ?? null,
      per_seat_price_cents: p.per_seat_price_cents ?? null,
      sort_order: Number(p.sort_order ?? 0),
      ai_requests_monthly: p.ai_requests_monthly ?? null,
      talk_to_case_monthly: p.talk_to_case_monthly ?? null,
      case_limit: p.case_limit ?? null,
      storage_gb_limit: p.storage_gb_limit === null ? null : Number(p.storage_gb_limit),
      team_member_limit: p.team_member_limit ?? null,
      byok_allowed: p.byok_allowed !== false,
    })) as PublicBillingPlan[];
  });
