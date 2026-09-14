// Subscription page for the signed-in attorney.
//
// This route previously did not exist as a page at all: the file at this
// path was a stale duplicate of src/lib/billing.functions.ts (server
// functions only, no `Route` export), so every "Billing" link in the app
// resolved to a route with no component. The server logic now lives solely
// in src/lib/billing.functions.ts and this file is the actual page.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CreditCard, Check, Loader2, ShieldCheck, ExternalLink, Gauge } from "lucide-react";
import {
  getMyBillingStatus,
  createCheckoutSession,
  cancelMySubscription,
} from "@/lib/billing.functions";
import { listPublicBillingPlans, type PublicBillingPlan } from "@/lib/billing-plans.functions";
import { useI18n } from "@/i18n";

export const Route = createFileRoute("/_authenticated/billing")({
  head: () => ({
    meta: [
      { title: "Suscripción — Nyrava Intelligence México" },
      {
        name: "description",
        content:
          "Administre su plan de Nyrava Intelligence México: estado de la suscripción, cambio de plan y facturación.",
      },
      { property: "og:title", content: "Suscripción — Nyrava Intelligence México" },
      {
        property: "og:description",
        content: "Administre su plan y facturación de Nyrava Intelligence México.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BillingPage,
});

function BillingPage() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const statusFn = useServerFn(getMyBillingStatus);
  const checkoutFn = useServerFn(createCheckoutSession);
  const cancelFn = useServerFn(cancelMySubscription);
  const plansFn = useServerFn(listPublicBillingPlans);

  const plansQ = useQuery({ queryKey: ["public-billing-plans"], queryFn: () => plansFn() });
  const plans: PublicBillingPlan[] = plansQ.data ?? [];

  const formatPlanPrice = (plan: PublicBillingPlan) => {
    const code = (plan.currency || "mxn").toUpperCase();
    const amount = (Number(plan.price_cents) || 0) / 100;
    let money: string;
    try {
      money = new Intl.NumberFormat(code === "MXN" ? "en-US" : undefined, {
        style: "currency",
        currency: code,
        minimumFractionDigits: 2,
      }).format(amount);
    } catch {
      money = `$${amount.toFixed(2)}`;
    }
    const suffix =
      plan.interval === "year"
        ? locale === "es"
          ? "/año"
          : "/yr"
        : plan.interval === "one_time"
          ? ""
          : locale === "es"
            ? "/mes"
            : "/mo";
    return `${money}${suffix}`;
  };

  const { data, isLoading } = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => statusFn(),
  });

  const checkout = useMutation({
    mutationFn: (input: { planKey: string; provider: "stripe" }) =>
      checkoutFn({
        data: { planKey: input.planKey, provider: input.provider, origin: window.location.origin },
      }),
    onSuccess: (res: { url?: string | null }) => {
      if (res?.url) window.location.href = res.url;
      else toast.error(t("billing.error.noCheckout"));
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const cancel = useMutation({
    mutationFn: () => cancelFn(),
    onSuccess: () => {
      toast.success(t("billing.cancel.success"));
      qc.invalidateQueries({ queryKey: ["billing-status"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const statusLabel = (() => {
    if (!data) return "";
    if (data.isBetaTester) return t("billing.status.beta");
    if (data.status === "active" || data.status === "trialing") return t("billing.status.active");
    if (data.status === "past_due") return t("billing.status.pastDue");
    if (data.status === "canceled") return t("billing.status.canceled");
    return t("billing.status.none");
  })();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/15 text-primary">
          <CreditCard className="h-5 w-5" />
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">
            {t("billing.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("billing.subtitle")}</p>
        </div>
      </div>

      <section className="mt-6 rounded-lg border border-border/60 bg-card/60 p-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {t("billing.current.heading")}
        </div>
        {isLoading ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="text-lg font-semibold text-foreground">
              {data?.plan
                ? (plans.find((p) => p.key === data.plan)?.label ?? data.plan)
                : t("billing.plan.none")}
            </div>
            <span className="rounded-full border border-border/60 px-2.5 py-0.5 text-xs text-muted-foreground">
              {statusLabel}
            </span>
            {data?.currentPeriodEnd && (
              <span className="text-xs text-muted-foreground">
                {data.cancelAtPeriodEnd ? t("billing.endsOn") : t("billing.renewsOn")}{" "}
                {new Date(data.currentPeriodEnd).toLocaleDateString()}
              </span>
            )}
            {!data?.plan && (
              <span className="text-xs text-muted-foreground">
                {data?.freeCaseUsed ? t("billing.freeCase.used") : t("billing.freeCase.available")}
              </span>
            )}
          </div>
        )}

        {data?.plan && data.status === "active" && (
          <button
            onClick={() => {
              if (window.confirm(t("billing.cancel.confirm"))) cancel.mutate();
            }}
            disabled={cancel.isPending}
            className="mt-4 inline-flex items-center gap-2 rounded border border-border/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted/40 disabled:opacity-50"
          >
            {cancel.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="h-4 w-4" />
            )}
            {t("billing.manage")}
          </button>
        )}
        <Link
          to="/usage"
          className="mt-4 ml-3 inline-flex items-center gap-2 rounded border border-border/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted/40"
        >
          <Gauge className="h-4 w-4" /> {t("usage.title")}
        </Link>
      </section>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = data?.plan === plan.key;
          return (
            <div
              key={plan.key}
              className={`flex flex-col rounded-lg border p-5 ${
                isCurrent ? "border-primary/50 bg-primary/5" : "border-border/60 bg-card/40"
              }`}
            >
              <div className="font-display text-lg font-semibold text-foreground">{plan.label}</div>
              <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
              <div className="mt-2 font-display text-2xl font-semibold text-foreground">
                {formatPlanPrice(plan)}
              </div>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="text-muted-foreground">{f}</span>
                  </li>
                ))}
              </ul>
              {isCurrent ? (
                <div className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-primary">
                  <ShieldCheck className="h-4 w-4" /> {t("billing.currentPlan")}
                </div>
              ) : plan.self_serve ? (
                <div className="mt-5 grid gap-2">
                  {data?.providers?.stripe ? (
                    <button
                      onClick={() => checkout.mutate({ planKey: plan.key, provider: "stripe" })}
                      disabled={checkout.isPending}
                      className="inline-flex items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                    >
                      {checkout.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                      {locale === "es" ? "Pagar con Stripe" : "Pay with Stripe"}
                    </button>
                  ) : (
                    <p className="text-center text-xs text-muted-foreground">
                      {locale === "es"
                        ? "Pago en línea temporalmente no disponible."
                        : "Online checkout is temporarily unavailable."}
                    </p>
                  )}
                </div>

              ) : (
                <a
                  href="mailto:soporte@mexico.nyrava.com"
                  className="mt-5 inline-flex items-center justify-center gap-2 rounded border border-border/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted/40"
                >
                  {t("billing.contact")}
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
