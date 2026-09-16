
## Stripe-only billing (Sep 14)
- [x] Remove Mercado Pago from checkout, admin UI, customer-facing text (no destructive DB changes)
- [x] Fix Admin Billing save validation (key/label reported empty)
- [x] Verify Stripe Checkout (monthly/yearly, MXN, per-plan Price ID)
- [x] Confirm webhook handles checkout.session.completed, customer.subscription.updated/deleted, invoice.payment_failed and applies plan limits
- [x] Create solo_test plan: MX$50/mo, 1 seat, 50 AI, 20 talk, 3 cases, 1GB, 1 member, no overage
- [x] Report webhook URL + any manual Stripe action

## Global PDF layout hardening (Sep 15)
- [x] Fix shared pagination, content fitting, wrapping, and final page numbering
- [x] Add automatic renderer QA before PDF save/release
- [x] Apply shared protection to legal, memorandum, and social audit PDFs
- [x] Regression-test and visually inspect ADR 217/2019

## Public social branding and profiles (Sep 16)
- [ ] Replace the legacy social preview with a dedicated 1200×630 Nyrava México card across public pages
- [ ] Publish and verify exact production Open Graph and Twitter metadata
- [ ] Add LinkedIn, Discord, X/Twitter, and Facebook profile fields for admins and subscribers
- [ ] Show administrator social profiles at the bottom of main public pages
