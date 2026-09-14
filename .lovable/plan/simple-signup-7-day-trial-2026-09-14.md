# Simple signup + 7-day trial

Smallest possible change on top of what already exists (Stripe checkout, admin-managed plans, subscription webhook). No redesign of the Create Account page, dashboard, database tables, or access rules.

## Flow for new accounts

Create account (unchanged page) → Choose plan → Stripe payment details → 7-day trial starts → dashboard.

## What changes

1. **New "Choose plan" page** (`/choose-plan`, inside the signed-in area)
   - Lists the plans already configured in Admin → Billing, with their existing prices, using the same plan-listing function the Subscription page uses. No duplicate plans created.
   - Each plan shows: "$0 today — 7-day free trial. Your selected plan will be charged automatically after 7 days unless you cancel." (Spanish and English, via existing translation setup.)
   - Choosing a plan opens the existing Stripe checkout, which collects a payment method.
   - If a previous attempt failed payment, the page shows an "update your payment method" notice instead.

2. **Checkout gets a trial option**
   - The existing checkout function accepts a trial flag; when set it adds a 7-day trial and always requires a card up front. Success returns the user to the dashboard.
   - Nothing about existing paid checkout changes.

3. **Gate for new accounts only**
   - The signed-in layout sends a user to Choose plan only when: their account was created after this change goes live, they have no subscription, and they are not an admin or beta tester.
   - Existing users, admins and beta testers are never affected.
   - Because the gate is based on subscription state, a user who quits halfway lands back on Choose plan when they return.

4. **Trial access and conversion**
   - Stripe reports a trial as an active subscription, which the app already treats as full access — so trial users get everything in their chosen plan with no further change.
   - After 7 days Stripe charges the plan through the existing webhook. A failed payment marks the account past due (data kept) and routes the user to update payment.

## Files touched

- `src/lib/billing.functions.ts` — optional `trial` input on `createCheckoutSession` (trial_period_days: 7, always collect payment method, dashboard success URL); expose `needsPlanSelection` on `getMyBillingStatus`.
- `src/routes/_authenticated/choose-plan.tsx` — new page.
- `src/routes/_authenticated/route.tsx` — redirect for new accounts only.
- `src/i18n/locales/en.json`, `es.json` — new strings.

Not touched: auth, RLS, other tables, existing users, report/legal engines, plan admin screens.

## Test

Create a fresh account → confirm redirect to Choose plan → pick the MX$50 test plan → Stripe checkout shows $0 due today with the trial → return to dashboard with access.
