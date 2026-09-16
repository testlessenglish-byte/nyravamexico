// Subscription usage metering — server-only.
//
// This is the single gate every AI-powered feature (Case Intelligence
// processing, Talk-to-Case, AI document analysis, report generation, motion
// generation, strategic analysis, and any future intelligence module) must
// call before doing real AI work. It decides, in order:
//
//   1. Admin / beta tester -> unlimited, no counters touched (same bypass
//      billing.functions.ts already uses for the free-case gate).
//   2. BYOK active for this call -> unlimited from the platform's point of
//      view (the user's own provider/account is what pays), no counters
//      touched, but still logged to usage_events with source: 'byok' for
//      visibility.
//   3. Otherwise -> resolve the user's plan limits from `billing_plans` (or
//      FREE_TIER_LIMITS if they have no active subscription) and atomically
//      check-and-increment via the `consume_usage` Postgres function.
//
// Never throws for "limit exceeded" — callers get back an `allowed: false`
// result with enough detail (used/limit/reason) to explain why and what the
// user's options are. Never blocks account/case access, only AI processing,
// per the product spec this implements.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { FREE_TIER_LIMITS, type PlanLimits, type UsageKind } from "./usage-plans";

type Db = SupabaseClient<Database>;

function getAdminClient(): Db {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Usage backend environment unavailable (missing SUPABASE_SERVICE_ROLE_KEY).");
  }
  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}

export function getCurrentPeriod(): { periodMonth: string; nextResetDate: string } {
  const now = new Date();
  const periodMonth = now.toISOString().slice(0, 7); // 'YYYY-MM' UTC
  const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return { periodMonth, nextResetDate: nextReset.toISOString() };
}

function limitsFromPlanRow(row: {
  ai_requests_monthly: number | null;
  talk_to_case_monthly: number | null;
  case_limit: number | null;
  storage_gb_limit: number | null;
  team_member_limit: number | null;
  byok_allowed: boolean;
  overage_price_cents: number | null;
}): PlanLimits {
  return {
    aiRequestsMonthly: row.ai_requests_monthly,
    talkToCaseMonthly: row.talk_to_case_monthly,
    caseLimit: row.case_limit,
    storageGbLimit: row.storage_gb_limit,
    teamMemberLimit: row.team_member_limit,
    byokAllowed: row.byok_allowed,
    overagePriceCents: row.overage_price_cents,
  };
}

export type ResolvedPlan = {
  /** null when the user has no active subscription (free tier). */
  planKey: string | null;
  planLabel: string;
  /** 'unlimited' = admin/beta bypass, 'plan' = paid subscription, 'free' = no subscription. */
  source: "unlimited" | "plan" | "free";
  limits: PlanLimits;
};

/** Resolves what limits apply to this user right now. Does not consume anything. */
export async function resolveUserPlan(admin: Db, userId: string): Promise<ResolvedPlan> {
  const { data: isAdmin, error: adminErr } = await admin.rpc("is_admin_tier", { _user_id: userId });
  if (!adminErr && isAdmin) {
    return {
      planKey: null,
      planLabel: "Administrator",
      source: "unlimited",
      limits: {
        aiRequestsMonthly: null,
        talkToCaseMonthly: null,
        caseLimit: null,
        storageGbLimit: null,
        teamMemberLimit: null,
        byokAllowed: true,
        overagePriceCents: null,
      },
    };
  }

  const { data: sub } = await admin
    .from("subscriptions")
    .select("plan,status,is_beta_tester")
    .eq("user_id", userId)
    .maybeSingle();

  if ((sub as { is_beta_tester?: boolean } | null)?.is_beta_tester) {
    return {
      planKey: (sub?.plan as string | null) ?? null,
      planLabel: "Beta tester",
      source: "unlimited",
      limits: {
        aiRequestsMonthly: null,
        talkToCaseMonthly: null,
        caseLimit: null,
        storageGbLimit: null,
        teamMemberLimit: null,
        byokAllowed: true,
        overagePriceCents: null,
      },
    };
  }

  if ((sub?.status === "active" || sub?.status === "trialing") && sub.plan) {
    const { data: planRow } = await admin
      .from("billing_plans")
      .select(
        "label,ai_requests_monthly,talk_to_case_monthly,case_limit,storage_gb_limit,team_member_limit,byok_allowed,overage_price_cents",
      )
      .eq("key", sub.plan)
      .maybeSingle();
    if (planRow) {
      return {
        planKey: sub.plan,
        planLabel: planRow.label ?? sub.plan,
        source: "plan",
        limits: limitsFromPlanRow(planRow),
      };
    }
  }

  return { planKey: null, planLabel: "Free", source: "free", limits: FREE_TIER_LIMITS };
}

export type UsageCheckResult = {
  allowed: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  /** Where this allowance came from — lets the UI explain the outcome. */
  source: "unlimited" | "byok" | "plan" | "free";
  planLabel: string;
};

/**
 * The one gate every AI-calling endpoint should call before doing real AI
 * work. Pass `byokActive: true` when the caller already resolved that this
 * specific request will run on the user's own connected provider key
 * (e.g. `resolveProviderKeys(...).userKeyCount > 0`) — in that case the
 * platform allowance is never touched.
 */
export async function checkAndConsumeUsage(args: {
  userId: string;
  kind: UsageKind;
  feature: keyof typeof import("./usage-plans").USAGE_FEATURE_LABELS | string;
  caseId?: string;
  byokActive?: boolean;
  amount?: number;
}): Promise<UsageCheckResult> {
  const { userId, kind, feature, caseId, byokActive, amount = 1 } = args;
  const admin = getAdminClient();

  const plan = await resolveUserPlan(admin, userId);

  if (plan.source === "unlimited") {
    void logUsageEvent(admin, { userId, kind, feature, caseId, source: "platform" });
    return {
      allowed: true,
      used: 0,
      limit: null,
      remaining: null,
      source: "unlimited",
      planLabel: plan.planLabel,
    };
  }

  if (byokActive) {
    void logUsageEvent(admin, { userId, kind, feature, caseId, source: "byok" });
    return {
      allowed: true,
      used: 0,
      limit: null,
      remaining: null,
      source: "byok",
      planLabel: plan.planLabel,
    };
  }

  const limit =
    kind === "ai_request" ? plan.limits.aiRequestsMonthly : plan.limits.talkToCaseMonthly;

  const { data, error } = await admin.rpc("consume_usage", {
    p_user_id: userId,
    p_kind: kind,
    // The Postgres function treats NULL as unlimited, but generated types require a number.
    p_limit: limit ?? 2_147_483_647,
    p_amount: amount,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  const allowed = Boolean(row?.allowed);
  const used = Number(row?.used ?? 0);

  if (allowed) {
    void logUsageEvent(admin, { userId, kind, feature, caseId, source: "platform" });
  }

  return {
    allowed,
    used,
    limit: limit ?? null,
    remaining: limit == null ? null : Math.max(0, limit - used),
    source: plan.source,
    planLabel: plan.planLabel,
  };
}

/** Best-effort audit row — never blocks or fails the caller's real request. */
async function logUsageEvent(
  admin: Db,
  args: {
    userId: string;
    kind: UsageKind;
    feature: string;
    caseId?: string;
    source: "platform" | "byok";
  },
): Promise<void> {
  try {
    await admin.from("usage_events").insert({
      user_id: args.userId,
      kind: args.kind,
      feature: args.feature,
      case_id: args.caseId ?? null,
      source: args.source,
    });
  } catch {
    // usage_events is diagnostic-only; never let a logging failure surface.
  }
}

/** Fire-and-forget informational tally — call after a report actually finishes generating. */
export function bumpReportsGenerated(userId: string): void {
  void (async () => {
    try {
      const admin = getAdminClient();
      await admin.rpc("increment_reports_generated", { p_user_id: userId });
    } catch {
      // best-effort dashboard stat only
    }
  })();
}

export type UsageDashboardSnapshot = {
  planKey: string | null;
  planLabel: string;
  source: "unlimited" | "plan" | "free";
  aiRequests: { used: number; limit: number | null; remaining: number | null };
  talkToCase: { used: number; limit: number | null; remaining: number | null };
  reportsGenerated: number;
  caseLimit: number | null;
  storageGbLimit: number | null;
  teamMemberLimit: number | null;
  byokAllowed: boolean;
  nextResetDate: string;
};

/** Read-only snapshot for the Usage Dashboard — does not consume anything. */
export async function getUsageSnapshot(userId: string): Promise<UsageDashboardSnapshot> {
  const admin = getAdminClient();
  const plan = await resolveUserPlan(admin, userId);
  const { periodMonth, nextResetDate } = getCurrentPeriod();

  const { data: counters } = await admin
    .from("usage_counters")
    .select("ai_requests_used,talk_to_case_used,reports_generated")
    .eq("user_id", userId)
    .eq("period_month", periodMonth)
    .maybeSingle();

  const aiUsed = counters?.ai_requests_used ?? 0;
  const talkUsed = counters?.talk_to_case_used ?? 0;

  const aiLimit = plan.source === "unlimited" ? null : plan.limits.aiRequestsMonthly;
  const talkLimit = plan.source === "unlimited" ? null : plan.limits.talkToCaseMonthly;

  return {
    planKey: plan.planKey,
    planLabel: plan.planLabel,
    source: plan.source,
    aiRequests: {
      used: aiUsed,
      limit: aiLimit,
      remaining: aiLimit == null ? null : Math.max(0, aiLimit - aiUsed),
    },
    talkToCase: {
      used: talkUsed,
      limit: talkLimit,
      remaining: talkLimit == null ? null : Math.max(0, talkLimit - talkUsed),
    },
    reportsGenerated: counters?.reports_generated ?? 0,
    caseLimit: plan.source === "unlimited" ? null : plan.limits.caseLimit,
    storageGbLimit: plan.source === "unlimited" ? null : plan.limits.storageGbLimit,
    teamMemberLimit: plan.source === "unlimited" ? null : plan.limits.teamMemberLimit,
    byokAllowed: plan.limits.byokAllowed,
    nextResetDate,
  };
}

/** Human-facing explanation for a blocked request, with the available next steps. */
export function usageExceededMessage(feature: string, result: UsageCheckResult): string {
  const scope = result.source === "free" ? "free trial" : `${result.planLabel} plan`;
  return (
    `You've used your ${scope}'s monthly allowance for ${feature} ` +
    `(${result.used}${result.limit != null ? `/${result.limit}` : ""} this month). ` +
    `Upgrade your plan, buy additional usage, connect your own AI provider key (BYOK), ` +
    `or wait until your usage resets to continue.`
  );
}
