
## Stripe-only billing (Sep 14)
- [x] Remove Mercado Pago from checkout, admin UI, customer-facing text (no destructive DB changes)
- [ ] Fix Admin Billing save validation (key/label reported empty)
- [ ] Verify Stripe Checkout (monthly/yearly, MXN, per-plan Price ID)
- [ ] Confirm webhook handles checkout.session.completed, customer.subscription.updated/deleted, invoice.payment_failed and applies plan limits
- [ ] Create solo_test plan: MX$50/mo, 1 seat, 50 AI, 20 talk, 3 cases, 1GB, 1 member, no overage
- [ ] Report webhook URL + any manual Stripe action
