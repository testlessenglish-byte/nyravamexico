// Single source of truth for subscription tiers. Shared between the
// client-rendered pricing page and the server-side checkout/webhook logic,
// so adding or renaming a plan only has to happen here.
//
// Actual prices live in Stripe (not here) — each self-serve plan points at a
// Stripe Price id, configured per-plan from Admin -> Billing Plans
// (stripe_price_id column on billing_plans), so changing a price in Stripe
// never requires a code deploy.
export type PlanKey = "solo" | "firm" | "enterprise";

export type PlanConfig = {
  key: PlanKey;
  label: string;
  tagline: string;
  features: string[];
  /** True if this plan is purchasable via Stripe checkout. False = "Contact us" (enterprise). */
  selfServe: boolean;
};

export const BILLING_PLANS: Record<PlanKey, PlanConfig> = {
  solo: {
    key: "solo",
    label: "Solo",
    tagline: "For solo practitioners and small caseloads",
    features: [
      "150 AI requests / month",
      "30 Talk-to-Case conversations / month",
      "Full 20-stage intelligence pipeline",
      "Motion drafting & reports",
      "Connect your own AI keys (BYOK)",
      "Email support",
    ],
    selfServe: true,
  },
  firm: {
    key: "firm",
    label: "Firm",
    tagline: "For firms running multiple cases at once",
    features: [
      "750 AI requests / month",
      "150 Talk-to-Case conversations / month",
      "Everything in Solo",
      "Multiple attorney seats",
      "Priority processing",
      "Priority support",
    ],
    selfServe: true,
  },
  enterprise: {
    key: "enterprise",
    label: "Enterprise",
    tagline: "For large firms with custom needs",
    features: [
      "Custom monthly AI + Talk-to-Case allowance",
      "Everything in Firm",
      "Custom seat count & SSO",
      "Dedicated onboarding",
      "Custom contract & invoicing",
    ],
    selfServe: false,
  },
};

/** Accepts any admin-defined plan key stored in billing_plans (e.g. "solo_test"). */
export function isDynamicPlanKey(v: unknown): v is string {
  return typeof v === "string" && /^[a-z0-9_-]{1,64}$/i.test(v);
}

export function isPlanKey(v: unknown): v is PlanKey {
  return v === "solo" || v === "firm" || v === "enterprise";
}
