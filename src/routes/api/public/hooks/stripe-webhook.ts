// Stripe webhook receiver. Lives under /api/public/* like pipeline-worker.ts
// (unauthenticated by Supabase session — Stripe can't send a Bearer token),
// but every request is verified via Stripe's signature scheme instead, which
// is the standard/required way to trust a Stripe webhook body. Configure
// this URL (https://<your-domain>/api/public/hooks/stripe-webhook) in the
// Stripe Dashboard → Developers → Webhooks, subscribed to at minimum:
//   checkout.session.completed, customer.subscription.updated,
//   customer.subscription.deleted, invoice.payment_failed
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type Stripe from "stripe";
import { isDynamicPlanKey } from "@/lib/billing-plans";
import { sendTemplateEmail } from "@/lib/email-templates/send-email";

function log(event: string, extra: Record<string, unknown> = {}) {
  console.info(`[stripe-webhook] ${JSON.stringify({ t: new Date().toISOString(), event, ...extra })}`);
}

function getAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("backend env unavailable");
  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}

/** Resolve which user a Stripe object belongs to. Prefers metadata.user_id
 * (set at Checkout time); falls back to matching stripe_customer_id, which
 * covers events that don't carry our metadata (e.g. some invoice events). */
async function resolveUserId(
  admin: ReturnType<typeof getAdmin>,
  metadata: Stripe.Metadata | null | undefined,
  customerId: string | null | undefined,
): Promise<string | null> {
  if (metadata?.user_id) return metadata.user_id;
  if (!customerId) return null;
  const { data } = await admin
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.user_id ?? null;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function provisionOrganizationSubscription(
  admin: ReturnType<typeof getAdmin>,
  input: {
    eventId: string;
    eventType: string;
    userId: string;
    orgId?: string | null;
    plan?: string | null;
    customerId?: string | null;
    subscriptionId?: string | null;
    status: string;
    interval?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    payloadHash: string;
  },
) {
  const { error } = await (admin as any).rpc("provision_organization_subscription_from_webhook", {
    p_provider: "stripe",
    p_provider_event_id: input.eventId,
    p_event_type: input.eventType,
    p_user_id: input.userId,
    p_org_id: input.orgId ?? null,
    p_plan_key: input.plan ?? null,
    p_provider_customer_id: input.customerId ?? null,
    p_provider_subscription_id: input.subscriptionId ?? null,
    p_status: input.status,
    p_billing_interval: input.interval ?? "month",
    p_period_start: input.periodStart ?? null,
    p_period_end: input.periodEnd ?? null,
    p_payload_hash: input.payloadHash,
  });
  if (error) throw new Error(`Organization subscription provisioning failed: ${error.message}`);
}

export const Route = createFileRoute("/api/public/hooks/stripe-webhook")({
  server: {
    handlers: {
      GET: async () => new Response("Method Not Allowed", { status: 405 }),
      POST: async ({ request }) => {
        const sig = request.headers.get("stripe-signature");
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!sig || !webhookSecret) {
          return new Response(JSON.stringify({ error: "webhook not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Signature verification requires the exact raw request body —
        // parsing to JSON first (even to re-stringify) can change byte
        // layout and break the signature check, so read as text first.
        const rawBody = await request.text();
        let event: Stripe.Event;
        try {
          const { getStripe } = await import("@/lib/stripe.server");
          event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret);
        } catch (e) {
          log("signature_verification_failed", { error: e instanceof Error ? e.message : String(e) });
          return new Response(JSON.stringify({ error: "invalid signature" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const payloadHash = await sha256Hex(rawBody);
        const admin = getAdmin();
        let resolvedUserId: string | null = null;
        let logStatus: "processed" | "ignored" | "error" = "processed";
        let logDetail: string | null = null;
        try {
          switch (event.type) {
            case "checkout.session.completed": {
              const session = event.data.object as Stripe.Checkout.Session;
              if (session.mode !== "subscription") {
                logStatus = "ignored";
                logDetail = "non-subscription checkout mode";
                break;
              }
              const userId = await resolveUserId(
                admin,
                session.metadata,
                typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null),
              );
              resolvedUserId = userId;
              if (!userId) {
                log("checkout_completed_no_user", { sessionId: session.id });
                logStatus = "ignored";
                logDetail = "no matching user_id";
                break;
              }
              const organizationPlan = session.metadata?.plan?.trim() || null;
              const plan = isDynamicPlanKey(organizationPlan) ? organizationPlan : null;
              const customerId =
                typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
              const subscriptionId =
                typeof session.subscription === "string" ? session.subscription : (session.subscription?.id ?? null);
              await admin.from("subscriptions").upsert(
                {
                  user_id: userId,
                  stripe_customer_id: customerId,
                  stripe_subscription_id: subscriptionId,
                  plan,
                  status: "active",
                },
                { onConflict: "user_id" },
              );
              await provisionOrganizationSubscription(admin, {
                eventId: event.id,
                eventType: event.type,
                userId,
                orgId: session.metadata?.org_id ?? null,
                plan: organizationPlan,
                customerId,
                subscriptionId,
                status: "active",
                payloadHash,
              });
              log("checkout_completed", { userId, plan, subscriptionId });
              break;
            }

            case "customer.subscription.updated":
            case "customer.subscription.created": {
              const sub = event.data.object as Stripe.Subscription;
              const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
              const userId = await resolveUserId(admin, sub.metadata, customerId);
              resolvedUserId = userId;
              if (!userId) {
                log("subscription_updated_no_user", { subscriptionId: sub.id });
                logStatus = "ignored";
                logDetail = "no matching user_id";
                break;
              }
              const organizationPlan = sub.metadata?.plan?.trim() || null;
              const plan = isDynamicPlanKey(organizationPlan) ? organizationPlan : undefined;
              const status: Database["public"]["Tables"]["subscriptions"]["Row"]["status"] =
                sub.status === "trialing"
                  ? "trialing"
                  : sub.status === "active"
                    ? "active"
                    : sub.status === "past_due" || sub.status === "unpaid"
                      ? "past_due"
                      : sub.status === "canceled" || sub.status === "incomplete_expired"
                        ? "canceled"
                        : "incomplete";
              const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
              await admin.from("subscriptions").upsert(
                {
                  user_id: userId,
                  stripe_customer_id: customerId,
                  stripe_subscription_id: sub.id,
                  ...(plan ? { plan } : {}),
                  status,
                  current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
                  cancel_at_period_end: sub.cancel_at_period_end ?? false,
                },
                { onConflict: "user_id" },
              );
              if (sub.status === "trialing" || sub.status === "active") {
                  try {
                    await admin.from("admin_audit_log").insert({
                      action: sub.status === "trialing" ? "subscription.trial_started" : "subscription.active",
                      target: userId,
                      meta: { plan: plan || "N/A", status, stripe_id: sub.id, event: "🎉 Nuevo cliente — Nyrava México" },
                    });
                  } catch (e) {
                    console.error("Failed to insert admin audit log", e);
                  }
              }
              await provisionOrganizationSubscription(admin, {
                eventId: event.id,
                eventType: event.type,
                userId,
                orgId: sub.metadata?.org_id ?? null,
                plan: organizationPlan,
                customerId,
                subscriptionId: sub.id,
                status,
                interval: sub.items.data[0]?.price.recurring?.interval ?? "month",
                periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
                payloadHash,
              });
              log("subscription_updated", { userId, status, plan });
              break;
            }

            case "customer.subscription.deleted": {
              const sub = event.data.object as Stripe.Subscription;
              const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
              const userId = await resolveUserId(admin, sub.metadata, customerId);
              resolvedUserId = userId;
              if (!userId) {
                log("subscription_deleted_no_user", { subscriptionId: sub.id });
                logStatus = "ignored";
                logDetail = "no matching user_id";
                break;
              }
              await admin.from("subscriptions").update({ status: "canceled" }).eq("user_id", userId);
              await provisionOrganizationSubscription(admin, {
                eventId: event.id,
                eventType: event.type,
                userId,
                orgId: sub.metadata?.org_id ?? null,
                plan: sub.metadata?.plan?.trim() || null,
                customerId,
                subscriptionId: sub.id,
                status: "canceled",
                payloadHash,
              });
              log("subscription_deleted", { userId });
              break;
            }

            case "invoice.payment_failed": {
              const invoice = event.data.object as Stripe.Invoice;
              const customerId =
                typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? null);
              const userId = await resolveUserId(admin, null, customerId);
              resolvedUserId = userId;
              if (!userId) {
                log("payment_failed_no_user", { invoiceId: invoice.id });
                logStatus = "ignored";
                logDetail = "no matching user_id";
                break;
              }
              await admin.from("subscriptions").update({ status: "past_due" }).eq("user_id", userId);
              await provisionOrganizationSubscription(admin, {
                eventId: event.id,
                eventType: event.type,
                userId,
                customerId,
                status: "past_due",
                payloadHash,
              });
              log("payment_failed", { userId });
              break;
            }

            default:
              // Unhandled event types are expected and fine — Stripe sends
              // far more event types than we act on. Ack with 200 either way.
              logStatus = "ignored";
              logDetail = "unhandled event type";
              break;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log("handler_error", { eventType: event.type, error: msg.slice(0, 500) });
          logStatus = "error";
          logDetail = msg.slice(0, 500);
          // Still return 200: Stripe retries on non-2xx, and a transient DB
          // hiccup here shouldn't cause Stripe to hammer retries indefinitely
          // for an event we've already logged. Errors are visible in logs.
        }

        // Best-effort log row — failure to write it should never affect the
        // 200 we send Stripe. Upsert on stripe_event_id so Stripe's normal
        // at-least-once retries don't pile up duplicate rows.
        try {
          await admin.from("webhook_events").upsert(
            {
              stripe_event_id: event.id,
              event_type: event.type,
              status: logStatus,
              user_id: resolvedUserId,
              detail: logDetail,
            },
            { onConflict: "stripe_event_id" },
          );
        } catch (e) {
          log("event_log_write_failed", { error: e instanceof Error ? e.message : String(e) });
        }

        return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
      },
    },
  },
});
