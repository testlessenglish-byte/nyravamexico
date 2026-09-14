// Team management: firm-scoped member listing, seat-limited email invites,
// and role assignment. Companion to cases.functions.ts's legacy
// listUsersWithRoles (kept for platform-operator/global use) — this module
// is what customer-facing Firm Admins actually use day to day.
//
// Seat model: a firm's seat pool comes from whichever user holds the paying
// subscription for that firm (firms.owner_user_id / plan_key / seat_limit,
// set by the Stripe webhook). "Seats used" = active members + pending
// invites. See supabase/migrations/20260723060000_firm_seats_and_invites.sql
// for the full data model and plan_seat_limit() defaults.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";

type Db = SupabaseClient<Database>;
type AuthContext = { supabase?: Db; userId?: string };

async function getAuthedContext(context: AuthContext, label: string) {
  let supabase: Db;
  let userId: string;

  if (context?.supabase && context.userId) {
    supabase = context.supabase;
    userId = context.userId;
  } else {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      throw new Error(`[${label}] backend environment unavailable`);
    }

    const { getRequest } = await import("@tanstack/react-start/server");
    const authHeader = getRequest()?.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new Error(`[${label}] signed-in session was not attached to the request`);
    }

    const token = authHeader.replace("Bearer ", "");
    supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims?.sub) {
      throw new Error(`[${label}] signed-in session could not be verified`);
    }
    userId = data.claims.sub;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_blocked")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.is_blocked) {
    throw new Error(
      "Your account has been blocked by an administrator. Contact support for assistance.",
    );
  }

  return { supabase, userId };
}

const INVITABLE_ROLES = ["firm_admin", "case_manager", "user"] as const;
type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** Roles is_admin_tier() recognizes as platform-wide (see is_admin_tier in
 * 20260625072138). super_admin/admin are Nyrava-operator tiers and can act
 * across every firm; firm_admin is the customer-facing tier scoped to a
 * single firm. */
async function callerContext(supabase: Db, userId: string) {
  const { data: roleRows } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const roles = (roleRows ?? []).map((r) => r.role as string);
  const isPlatformAdmin = roles.includes("super_admin") || roles.includes("admin");
  const isFirmAdmin = roles.includes("firm_admin");
  const { data: settings } = await supabase
    .from("user_settings")
    .select("firm_id")
    .eq("user_id", userId)
    .maybeSingle();
  return { roles, isPlatformAdmin, isFirmAdmin, firmId: settings?.firm_id ?? null };
}

// ============== Seat summary for the caller's own firm ==============
export const getFirmSeatSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Firm seat summary");
    const caller = await callerContext(supabase, userId);
    if (!caller.firmId) {
      return { firmId: null, planKey: null, seatLimit: 1, seatsUsed: 1, seatsAvailable: 0 };
    }
    // firm_seat_usage is a privileged aggregate (no longer callable by end users);
    // the caller's own firm id was resolved from their session above.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .rpc("firm_seat_usage", { _firm_id: caller.firmId })
      .maybeSingle();
    if (error) throw new Error(error.message);
    const seatLimit = data?.seat_limit ?? 1;
    const seatsUsed = data?.seats_used ?? 0;
    return {
      firmId: caller.firmId,
      planKey: data?.plan_key ?? null,
      seatLimit,
      seatsUsed,
      seatsAvailable: Math.max(0, seatLimit - seatsUsed),
    };
  });

// ============== List members of the caller's firm ==============
export const listFirmMembers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "List firm members");
    const caller = await callerContext(supabase, userId);
    if (!caller.isPlatformAdmin && !caller.isFirmAdmin) {
      throw new Error("Forbidden: firm admin required");
    }
    if (!caller.isPlatformAdmin && !caller.firmId) {
      throw new Error("Your account isn't attached to a firm yet.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let memberIds: string[] | null = null;
    if (!caller.isPlatformAdmin) {
      const { data: settingsRows } = await supabaseAdmin
        .from("user_settings")
        .select("user_id")
        .eq("firm_id", caller.firmId as string);
      memberIds = (settingsRows ?? []).map((r) => r.user_id);
    }

    let profileQuery = supabaseAdmin
      .from("profiles")
      .select("id,email,full_name,is_blocked")
      .order("email");
    if (memberIds)
      profileQuery = profileQuery.in(
        "id",
        memberIds.length > 0 ? memberIds : ["00000000-0000-0000-0000-000000000000"],
      );
    const [{ data: profiles }, { data: allRoles }] = await Promise.all([
      profileQuery,
      supabaseAdmin.from("user_roles").select("user_id,role"),
    ]);
    const rolesByUser = new Map<string, string[]>();
    for (const r of allRoles ?? []) {
      const list = rolesByUser.get(r.user_id) ?? [];
      list.push(r.role as string);
      rolesByUser.set(r.user_id, list);
    }
    return (profiles ?? []).map((p) => ({
      id: p.id,
      email: p.email,
      full_name: p.full_name,
      roles: rolesByUser.get(p.id) ?? [],
      is_blocked: p.is_blocked ?? false,
    }));
  });

// ============== Pending invites for the caller's firm ==============
export const listFirmInvites = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "List firm invites");
    const caller = await callerContext(supabase, userId);
    if (!caller.isPlatformAdmin && !caller.isFirmAdmin) {
      throw new Error("Forbidden: firm admin required");
    }
    if (!caller.isPlatformAdmin && !caller.firmId) return [];
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let q = supabaseAdmin
      .from("firm_invites")
      .select("id,email,role,status,invited_at,invited_by")
      .eq("status", "pending")
      .order("invited_at", { ascending: false });
    if (!caller.isPlatformAdmin) q = q.eq("firm_id", caller.firmId as string);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  });

// ============== Invite a teammate by email ==============
export const inviteFirmMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email: string; role: InvitableRole }) => {
    const schema = z.object({
      email: z.string().trim().email(),
      role: z.enum(INVITABLE_ROLES),
    });
    return schema.parse(d);
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Invite firm member");
    const caller = await callerContext(supabase, userId);
    if (!caller.isPlatformAdmin && !caller.isFirmAdmin) {
      throw new Error("Forbidden: firm admin required");
    }
    if (!caller.firmId) {
      throw new Error(
        "Your account isn't attached to a firm yet — invites need a firm to attach to.",
      );
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Enforce the seat limit server-side — never trust a client-computed count.
    // Platform/firm admins are exempt: admin accounts may invite unlimited members.
    if (!caller.isPlatformAdmin && !caller.isFirmAdmin) {
      const { data: usage, error: usageErr } = await supabaseAdmin
        .rpc("firm_seat_usage", { _firm_id: caller.firmId })
        .maybeSingle();
      if (usageErr) throw new Error(usageErr.message);
      const seatLimit = usage?.seat_limit ?? 1;
      const seatsUsed = usage?.seats_used ?? 0;
      if (seatsUsed >= seatLimit) {
        throw new Error(
          `Seat limit reached (${seatsUsed}/${seatLimit}). Upgrade your plan to invite more teammates.`,
        );
      }
    }


    const { error } = await supabaseAdmin.from("firm_invites").insert({
      firm_id: caller.firmId,
      email: data.email.toLowerCase(),
      role: data.role,
      invited_by: userId,
      status: "pending",
    });
    if (error) {
      if (error.code === "23505")
        throw new Error("There's already a pending invite for that email.");
      throw new Error(error.message);
    }

    const { logAudit } = await import("@/lib/audit.server");
    await logAudit({
      actorId: userId,
      action: "firm_member_invited",
      target: data.email,
      meta: { role: data.role },
    });

    // Send the invitation email so the invitee can click through and create
    // an account. Delivery failures never roll back the recorded invite.
    let emailSent = false;
    try {
      const [{ data: firmRow }, { data: inviterRow }] = await Promise.all([
        supabaseAdmin.from("firms").select("name").eq("id", caller.firmId).maybeSingle(),
        supabaseAdmin.from("profiles").select("full_name,email").eq("id", userId).maybeSingle(),
      ]);
      const { sendTemplateEmail } = await import("@/lib/email-templates/send-email");
      const res = await sendTemplateEmail("team-invite", data.email.toLowerCase(), {
        templateData: {
          firmName: firmRow?.name ?? "tu equipo",
          inviterName: inviterRow?.full_name ?? inviterRow?.email ?? undefined,
          roleLabel: data.role,
          inviteEmail: data.email.toLowerCase(),
          signupUrl: "https://mexico.nyrava.com/auth",
        },
        idempotencyKey: `team-invite-${caller.firmId}-${data.email.toLowerCase()}`,
      });
      emailSent = res.sent;
    } catch (e) {
      console.error("[inviteFirmMember] invite email failed", e);
    }

    return { ok: true, emailSent };
  });

// ============== Revoke a pending invite ==============
export const revokeFirmInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { inviteId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Revoke firm invite");
    const caller = await callerContext(supabase, userId);
    if (!caller.isPlatformAdmin && !caller.isFirmAdmin) {
      throw new Error("Forbidden: firm admin required");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let q = supabaseAdmin
      .from("firm_invites")
      .update({ status: "revoked" })
      .eq("id", data.inviteId)
      .eq("status", "pending");
    if (!caller.isPlatformAdmin) q = q.eq("firm_id", caller.firmId as string);
    const { error } = await q;
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============== Super Admin: override a firm's seat limit ==============
// For custom-contracted Enterprise deals that need a specific seat count
// rather than the plan_seat_limit('enterprise') default of 50.
export const adminSetFirmSeatLimit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { firmId: string; seatLimit: number }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = await getAuthedContext(context, "Set firm seat limit");
    const { data: caller } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const roles = (caller ?? []).map((r) => r.role as string);
    if (!roles.includes("super_admin")) throw new Error("Forbidden: super admin required");
    if (!Number.isInteger(data.seatLimit) || data.seatLimit < 1)
      throw new Error("Seat limit must be a positive integer");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("firms")
      .update({ seat_limit: data.seatLimit })
      .eq("id", data.firmId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============== Super Admin: list all firms with seat usage ==============
// Powers the manual seat-override panel for contract-negotiated seat pools.
export const listFirmsWithSeats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = await getAuthedContext(context, "List firms with seats");
    const { data: caller } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const roles = (caller ?? []).map((r) => r.role as string);
    if (!roles.includes("super_admin")) throw new Error("Forbidden: super admin required");
    const { data, error } = await supabase.rpc("admin_list_firms_with_seats");
    if (error) throw new Error(error.message);
    return data ?? [];
  });
