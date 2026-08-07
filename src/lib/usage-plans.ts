// Shared types for the subscription usage/metering system. The actual limit
// VALUES for solo/firm/enterprise live in the `billing_plans` table (admin-
// editable from Admin -> Billing Plans, see billing-plans.functions.ts) —
// this file only defines the shape of a resolved limit set and the fallback
// used for users who aren't on a paid plan yet.
export type UsageKind = "ai_request" | "talk_to_case";

export type PlanLimits = {
  /** Monthly allowance shared by case processing, document analysis, report
   * generation, motion generation, strategic analysis, and future modules.
   * null = unlimited. */
  aiRequestsMonthly: number | null;
  /** Monthly Talk-to-Case allowance, tracked separately (continuous AI
   * reasoning is treated as a premium resource). null = unlimited. */
  talkToCaseMonthly: number | null;
  /** Max non-archived cases open at once. null = unlimited. */
  caseLimit: number | null;
  /** Max evidence storage in GB. null = unlimited. */
  storageGbLimit: number | null;
  /** Max team/firm seats. null = unlimited. */
  teamMemberLimit: number | null;
  /** Whether BYOK is available on this plan. */
  byokAllowed: boolean;
  /** Reserved for future pay-as-you-go overage pricing. Not charged yet. */
  overagePriceCents: number | null;
};

/**
 * Applied to any user who has no active subscription and isn't a beta
 * tester/admin — i.e. someone relying on the one-time free case (see
 * billing.functions.ts). Deliberately small: this is a trial allocation,
 * not a plan. Case processing itself is already fully gated by the
 * separate free-case mechanism, so this mostly governs what they can do
 * (Talk-to-Case, motion drafts, etc.) around that one free case.
 */
export const FREE_TIER_LIMITS: PlanLimits = {
  aiRequestsMonthly: 20,
  talkToCaseMonthly: 5,
  caseLimit: 1,
  storageGbLimit: 1,
  teamMemberLimit: 1,
  byokAllowed: true,
  overagePriceCents: null,
};

/** Human-readable label for each metered feature, used in dashboard/error copy. */
export const USAGE_FEATURE_LABELS: Record<string, string> = {
  case_intelligence: "Case Intelligence processing",
  talk_to_case: "Talk-to-Case",
  document_analysis: "AI document analysis",
  report_generation: "Report generation",
  motion_generation: "Motion generation",
  strategic_analysis: "Strategic analysis",
  voice_speak: "Voice (text-to-speech)",
  voice_transcribe: "Voice (speech-to-text)",
};
