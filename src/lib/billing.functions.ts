// Subscription billing — status reads for the UI, Stripe checkout/
// cancellation, and the internal free-case gating helpers used by
// createCaseAndUpload (cases.functions.ts).
//
// Writes to `subscriptions` always go through a service-role admin client
// (see getAdminClient below), scoped by a server-verified userId — never by
// a client-supplied one. RLS on the table grants `authenticated` SELECT
// only, so a normal user-scoped client could never write here even if it
// tried; the admin client is what makes free-case consumption and Stripe
// linkage possible at all. See the migration file for the full rationale.
import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { isPlanKey, type PlanKey } from "./billing-plans";


type Db = SupabaseClient<Database>;
type SubRow = Database["public"]["Tables"]["subscriptions"]["Row"];

function getAdminClient(): Db {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Billing backend environment unavailable (missing SUPABASE_SERVICE_ROLE_KEY).");
  }
  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}

async function getAuthedUserId(context: { supabase?: Db; userId?: string }): Promise<string> {
  if (context?.userId) return context.userId;
  throw new Error("Not signed in.");
}

// ---------------------------------------------------------------------
// Internal helpers — called from cases.functions.ts, not exposed as
// createServerFn endpoints themselves (no direct client access).
// ---------------------------------------------------------------------

export type BillingAccess = {
  allowed: boolean;
  plan: PlanKey | null;
  status: SubRow["status"];
  freeCaseUsed: boolean;
  reason:
    | "beta_tester"
    | "subscribed"
    | "free_case_available"
    | "free_case_rerun"
    | "free_case_used_by_other_case";
};

/** Whether this user may queue/run `caseId` right now. Read-only — does not
 * consume the free case. Pass the caseId being queued so a rerun of the
 * SAME case that already used the free allowance is still permitted. */
export async function getBillingAccess(userId: string, caseId?: string): Promise<BillingAccess> {
  const admin = getAdminClient();

  // Platform admins bypass billing entirely — added same day as this whole
  // billing gate, because without it the account that OWNS the platform
  // gets locked out of running cases the moment its one-time free case is
  // used up on any other test case. Checked before everything else, same
  // precedence as the beta-tester bypass below.
  const { data: isAdmin, error: adminCheckErr } = await admin.rpc("is_admin_tier", {
    _user_id: userId,
  });
  if (!adminCheckErr && isAdmin) {
    return {
      allowed: true,
      plan: null,
      status: "none",
      freeCaseUsed: false,
      reason: "beta_tester",
    };
  }

  const { data } = await admin
    .from("subscriptions")
    .select("plan,status,free_case_used,free_case_case_id,is_beta_tester")
    .eq("user_id", userId)
    .maybeSingle();
  const status = (data?.status ?? "none") as SubRow["status"];
  const plan = (data?.plan ?? null) as PlanKey | null;
  const freeCaseUsed = data?.free_case_used ?? false;
  // Beta testers bypass billing entirely — no subscription needed, no
  // free-case limit consumed. Checked first so a beta grant always wins
  // regardless of the user's subscription status.
  if ((data as { is_beta_tester?: boolean } | null)?.is_beta_tester) {
    return { allowed: true, plan, status, freeCaseUsed, reason: "beta_tester" };
  }
  if (status === "active") {
    return { allowed: true, plan, status, freeCaseUsed, reason: "subscribed" };
  }
  if (!freeCaseUsed) {
    return { allowed: true, plan, status, freeCaseUsed, reason: "free_case_available" };
  }
  if (caseId && data?.free_case_case_id === caseId) {
    return { allowed: true, plan, status, freeCaseUsed, reason: "free_case_rerun" };
  }
  return { allowed: false, plan, status, freeCaseUsed, reason: "free_case_used_by_other_case" };
}

/** Marks the one-time free case as used, recording WHICH case used it. Call
 * ONLY right after successfully queuing a case for a user whose access was
 * granted via `free_case_available` — never for `subscribed` (their free
 * case should stay unconsumed in case they later cancel) or
 * `free_case_rerun` (already recorded). */
export async function consumeFreeCase(userId: string, caseId: string): Promise<void> {
  const admin = getAdminClient();
  await admin
    .from("subscriptions")
    .upsert(
      { user_id: userId, free_case_used: true, free_case_case_id: caseId },
      { onConflict: "user_id" },
    );
}

// ---------------------------------------------------------------------
// Client-facing endpoints
// ---------------------------------------------------------------------

// Signup gate: accounts created on or after this timestamp go through
// "choose plan -> payment -> 7-day trial" before reaching the workspace.
// Everyone who existed before it is untouched by the trial flow.
const TRIAL_SIGNUP_CUTOFF_ISO = "2026-09-14T21:00:00Z";

/** True when this user must still pick a plan / fix payment before using the
 * workspace. Never true for pre-existing accounts, admins or beta testers. */
async function computeNeedsPlanSelection(
  userId: string,
  access: BillingAccess,
): Promise<boolean> {
  if (access.reason === "beta_tester") return false; // covers admins too
  const admin = getAdminClient();
  const { data: userResp } = await admin.auth.admin.getUserById(userId);
  const createdAt = userResp?.user?.created_at;
  if (!createdAt) return false;
  if (new Date(createdAt).getTime() < new Date(TRIAL_SIGNUP_CUTOFF_ISO).getTime()) return false;
  return access.status !== "active";
}

export const getMyBillingStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = await getAuthedUserId(context as { supabase?: Db; userId?: string });
    const access = await getBillingAccess(userId);
    const admin = getAdminClient();
    const [{ data }, { data: providerRows }] = await Promise.all([
      admin
        .from("subscriptions")
        .select("current_period_end,cancel_at_period_end")
        .eq("user_id", userId)
        .maybeSingle(),
      (admin as any).from("billing_provider_settings").select("provider,enabled"),
    ]);
    const providerFlags = Object.fromEntries(
      (providerRows ?? []).map((r: { provider: string; enabled: boolean }) => [r.provider, r.enabled]),
    );
    return {
      providers: {
        stripe:
          providerFlags.stripe !== false &&
          Boolean(process.env.STRIPE_SECRET_KEY) &&
          Boolean(process.env.STRIPE_WEBHOOK_SECRET),
      },

      plan: access.plan,
      status: access.status,
      freeCaseUsed: access.freeCaseUsed,
      hasAccess: access.allowed,
      isBetaTester: access.reason === "beta_tester",
      needsPlanSelection: await computeNeedsPlanSelection(userId, access),
      currentPeriodEnd: data?.current_period_end ?? null,
      cancelAtPeriodEnd: data?.cancel_at_period_end ?? false,
    };
  });

export const createCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      planKey: z.string().min(1),
      origin: z.string().url(),
      provider: z.literal("stripe").optional(),
      // Signup flow only: start the plan with a 7-day free trial. A payment
      // method is still required up front; Stripe charges after the trial.
      trial: z.boolean().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const userId = await getAuthedUserId(context as { supabase?: Db; userId?: string });
    const admin = getAdminClient();
    const { data: organizationMembership } = await admin
      .from("org_memberships")
      .select("org_id")
      .eq("user_id", userId)
      .eq("status", "active")
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    const organizationId = organizationMembership?.org_id ?? null;

    // Look up the admin-managed plan row for this key.
    const { data: planRow, error: planErr } = await admin
      .from("billing_plans")
      .select("key,label,stripe_price_id,self_serve,active")
      .eq("key", data.planKey)
      .maybeSingle();
    if (planErr) throw new Error(planErr.message);
    if (!planRow || !planRow.active) throw new Error("That plan is no longer available.");
    if (!planRow.self_serve)
      throw new Error(`${planRow.label} is not available for self-serve checkout.`);

    const { data: providerRows, error: providerError } = await (admin as any)
      .from("billing_provider_settings")
      .select("provider,enabled");
    if (providerError) throw new Error(providerError.message);
    const stripeRow = (providerRows ?? []).find(
      (r: { provider: string }) => r.provider === "stripe",
    ) as { enabled: boolean } | undefined;
    if (stripeRow && stripeRow.enabled === false) {
      throw new Error("Stripe payments are currently disabled.");
    }
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
      throw new Error("Stripe requires both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET before checkout can be enabled.");
    }

    const { data: userResp } = await admin.auth.admin.getUserById(userId);
    const payerEmail = userResp?.user?.email;
    if (!payerEmail) throw new Error("Your account has no email on file — cannot start checkout.");

    if (!planRow.stripe_price_id) {
      throw new Error(
        `Stripe checkout is not configured for ${planRow.label} — set its Stripe Price ID in Admin → Billing Plans.`,
      );
    }
    const { getStripe } = await import("./stripe.server");
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      customer_email: payerEmail,
      line_items: [{ price: planRow.stripe_price_id, quantity: 1 }],
      ...(data.trial ? { payment_method_collection: "always" as const } : {}),
      success_url: data.trial
        ? `${data.origin}/dashboard?trial=started`
        : `${data.origin}/billing?checkout=success&provider=stripe`,
      cancel_url: data.trial
        ? `${data.origin}/choose-plan?checkout=cancelled`
        : `${data.origin}/billing?checkout=cancelled`,
      metadata: {
        user_id: userId,
        plan: planRow.key,
        ...(organizationId ? { org_id: organizationId } : {}),
      },
      subscription_data: {
        ...(data.trial ? { trial_period_days: 7 } : {}),
        metadata: {
          user_id: userId,
          plan: planRow.key,
          ...(organizationId ? { org_id: organizationId } : {}),
        },
      },
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL.");
    return { url: session.url, provider: "stripe" as const };
  });


/** Cancels the Stripe subscription at period end. Kept as its own endpoint
 * (rather than folded into createCheckoutSession) so the client can show a
 * clear confirm-before-cancel dialog. */
export const cancelMySubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = await getAuthedUserId(context as { supabase?: Db; userId?: string });
    const admin = getAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("stripe_subscription_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (sub?.stripe_subscription_id) {
      const { getStripe } = await import("./stripe.server");
      await getStripe().subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
      await admin.from("subscriptions")
        .update({ cancel_at_period_end: true })
        .eq("user_id", userId);
      return { ok: true, provider: "stripe", atPeriodEnd: true };
    }
    throw new Error("No active subscription on file to cancel.");
  });


// ---------------------------------------------------------------------
// Admin: beta testers + subscriptions visibility
// ---------------------------------------------------------------------

async function requireAdmin(ctx: { supabase: Db; userId: string }) {
  // Primary check: SECURITY DEFINER helper through the caller's own client.
  const { data: isAdmin, error } = await ctx.supabase.rpc("is_admin_tier", {
    _user_id: ctx.userId,
  });
  if (!error && isAdmin) return;

  // Fallback: read user_roles directly with the service-role client.
  // The RPC path can come back false/null in production when EXECUTE grants
  // or the caller's PostgREST role drift (the "I AM the admin but it says
  // admin required" report). Roles live in public.user_roles and are the
  // source of truth — verify them directly rather than denying a real admin.
  const admin = getAdminClient();
  const { data: roleRows, error: roleErr } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", ctx.userId);
  if (roleErr) throw new Error(roleErr.message);
  const roles = (roleRows ?? []).map((r) => String((r as { role: string }).role));
  const adminRoles = ["admin", "super_admin", "platform_admin", "firm_admin"];
  if (roles.some((r) => adminRoles.includes(r))) return;

  console.warn(
    `[billing.requireAdmin] denied user ${ctx.userId} — roles=[${roles.join(",")}] rpc_error=${
      error?.message ?? "none"
    }`,
  );
  throw new Error("Forbidden — admin required.");
}


export type AdminUserRow = {
  user_id: string;
  email: string | null;
  user_created_at: string | null;
  plan: PlanKey | null;
  status: SubRow["status"];
  is_beta_tester: boolean;
  beta_note: string | null;
  beta_granted_at: string | null;
  free_case_used: boolean;
  stripe_customer_id: string | null;
  current_period_end: string | null;
};


/** Every user joined with their subscription/beta status. Backs both the
 * admin Subscriptions view and the Beta Testers view — same underlying
 * data, the UI just filters/sorts differently. */
export const adminListUsersWithSubscriptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (ctx.supabase as any).rpc("admin_list_users_with_subscriptions");
    if (error) throw new Error(error.message);
    return (data ?? []) as AdminUserRow[];
  });

/** Grant beta-tester access by email.
 *
 * If the account already exists: grants immediately (creates the
 * subscriptions row if the user has never touched billing before).
 *
 * If the account does NOT exist yet: creates a pending invite instead of
 * erroring. The moment someone signs up with that email, a database
 * trigger (handle_beta_invite_redemption, see
 * 20260716200000_beta_invites_presignup.sql) grants them beta access
 * automatically — no follow-up admin action needed. This lets you send
 * the invite email first and have testers sign up whenever.
 *
 * Does NOT touch user_ai_keys — the tester automatically rides on the
 * platform AI key (see ai-key-router.server.ts) unless/until they add
 * their own. */
export const adminAddBetaTester = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ email: z.string().email(), note: z.string().max(500).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const email = data.email.trim();
    // Perform authorization and the grant atomically in the database using
    // auth.uid(). This prevents client-supplied actor IDs and avoids relying
    // on service-role environment availability for an authenticated admin
    // action.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: result, error } = await (ctx.supabase as any).rpc("admin_grant_beta_access", {
      _email: email,
      _note: data.note?.trim() || null,
    });
    if (error) throw new Error(error.message);
    const grant = result as { ok: boolean; userId: string | null; pending: boolean } | null;
    if (!grant?.ok) throw new Error("Beta access could not be granted.");
    return grant;
  });

/** Pending (unredeemed) pre-signup beta invites, for the admin Beta
 * Testers page. */
export const adminListPendingBetaInvites = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    // Must run as the signed-in admin: the SQL function authorizes via auth.uid().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (ctx.supabase as any).rpc("admin_list_pending_beta_invites");

    if (error) throw new Error(error.message);
    return (data ?? []) as { email: string; note: string | null; invited_at: string }[];
  });

/** Cancel a pending (not-yet-redeemed) invite before the person signs up. */
export const adminCancelBetaInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ email: z.string().email() }).parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const admin = getAdminClient();
    const { error } = await admin
      .from("beta_invites")
      .delete()
      .eq("email", data.email.toLowerCase())
      .is("redeemed_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminRemoveBetaTester = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const admin = getAdminClient();
    const { error } = await admin
      .from("subscriptions")
      .update({ is_beta_tester: false })
      .eq("user_id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Recent Stripe webhook deliveries, for the admin Billing page's config
 * panel — proves the webhook is actually reaching the app, not just that an
 * env var is set. */

export const adminListWebhookEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const { data, error } = await ctx.supabase
      .from("webhook_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/** Payment-provider status. Only booleans/modes are returned; secrets never leave the server. */
export const adminGetBillingProviderStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const admin = getAdminClient();
    const { data: rows, error } = await (admin as any)
      .from("billing_provider_settings")
      .select("provider,enabled,updated_at");
    if (error) throw new Error(error.message);
    const flags = Object.fromEntries((rows ?? []).map((r: { provider: string; enabled: boolean }) => [r.provider, r.enabled]));
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const stripeSecret = process.env.STRIPE_WEBHOOK_SECRET;
    return {
      stripe: {
        enabled: flags.stripe !== false,
        hasSecretKey: Boolean(stripeKey),
        keyMode: stripeKey?.startsWith("sk_live_") ? "production" : stripeKey ? "test" : null,
        hasWebhookSecret: Boolean(stripeSecret),
        webhookSecretLast4: stripeSecret ? stripeSecret.slice(-4) : null,
        webhookUrl: "/api/public/hooks/stripe-webhook",
      },
    };
  });

export const adminSetBillingProviderEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ provider: z.literal("stripe"), enabled: z.boolean() }).parse(d),
  )

  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: Db; userId: string };
    await requireAdmin(ctx);
    const admin = getAdminClient();
    const { error } = await (admin as any).from("billing_provider_settings").upsert({
      provider: data.provider,
      enabled: data.enabled,
      updated_by: ctx.userId,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    return { ok: true, ...data };
  });




export { isPlanKey };

export const createCustomerPortalSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = await getAuthedUserId(context as { supabase?: Db; userId?: string });
    
    // We need req from somewhere. Let's see if context.req exists or if we can use getHeader()
    // Wait, in React Start server functions we can use getWebRequest()
    const { getWebRequest } = await import("@tanstack/react-start/server");
    const req = getWebRequest();
    const admin = getAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      throw new Error("No Stripe customer found for this account.");
    }

    const { getStripe } = await import("./stripe.server");
    const stripe = getStripe();

    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "mexico.nyrava.com";
    const protocol = req.headers.get("x-forwarded-proto") ?? "https";
    const returnUrl = `${protocol}://${host}/billing`;

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: returnUrl,
    });

    return { url: session.url };
  });

