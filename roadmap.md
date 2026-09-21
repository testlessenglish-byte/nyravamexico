
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
- [x] Replace the legacy social preview with a dedicated 1200×630 Nyrava México card across public pages
- [ ] Publish and verify exact production Open Graph and Twitter metadata
- [x] Add private LinkedIn, Discord, X/Twitter, and Facebook profile fields for signed-in users
- [x] Show only the opted-in super administrator’s social links at the bottom of main public pages

## Full bilingual UI sweep (Sep 17)
- [x] Batch 1: Trust Center, docs search popup, pipeline diagram
- [ ] Batch 2: Help and Learning Center pages
- [ ] Batch 3: remaining public Trust, policy, company, and resource pages
- [ ] Batch 4: signed-in menus, alerts, toasts, and common dialogs
- [ ] Batch 5: remaining case, report, and admin screens
- [ ] Final automated scan and route-family browser checks

## Public mobile responsiveness (Sep 20)
- [x] Eliminate shared-header overflow across all public pages at 320–430px
- [x] Keep navigation, language, sign-in, and platform access available in the mobile menu
- [x] Verify every public route and mobile/PWA-style menu flow without horizontal scrolling

## Legal workspace privacy and team access (Sep 21)
- [ ] Establish one canonical workspace and explicit per-case assignment model
- [ ] Replace owner/admin/firm/org shortcuts with centralized case authorization across legal-work tables
- [ ] Harden client/CRM visibility, storage objects, downloads, search, APIs, RPCs, and background jobs
- [ ] Reconcile existing ownership/workspace links without deleting or reassigning legal work
- [ ] Add owner assignment controls and assigned-case views for team members
- [ ] Prove individual, team-owner, worker, cross-team, admin, direct-ID, and revocation boundaries through backend and UI tests
