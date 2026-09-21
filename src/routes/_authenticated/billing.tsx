// Subscription page for the signed-in attorney.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CreditCard, Check, Loader2, ShieldCheck, ExternalLink, Gauge } from "lucide-react";
import {
  getMyBillingStatus,
  createCheckoutSession,
  createCustomerPortalSession,
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
  const portalFn = useServerFn(createCustomerPortalSession);
  const plansFn = useServerFn(listPublicBillingPlans);

  const statusQ = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => statusFn(),
  });
  const plansQ = useQuery({ queryKey: ["public-billing-plans"], queryFn: () => plansFn() });

  // Internal/test plans stay in database, but never show to customers here.
  const isInternalPlan = (p: PublicBillingPlan) =>
    /(^|[_-])(test|demo|internal|staging)([_-]|$)/i.test(p.key) ||
    /\b(test|prueba|interno|internal)\b/i.test(p.tagline ?? "");

  // A plan with no price (or explicit contact_sales) is custom Enterprise.
  const isCustomPlan = (p: PublicBillingPlan) =>
    (Number(p.price_cents) || 0) <= 0 || p.featureLimits?.["contact_sales"] === true;

  const plans: PublicBillingPlan[] = (plansQ.data ?? [])
    .filter((p) => !isInternalPlan(p))
    .sort((a, b) => {
      const ca = isCustomPlan(a) ? 1 : 0;
      const cb = isCustomPlan(b) ? 1 : 0;
      if (ca !== cb) return ca - cb; // custom/enterprise last
      return (Number(a.price_cents) || 0) - (Number(b.price_cents) || 0);
    });

  const nfmt = (n: number) => new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US").format(n);
  const es = locale === "es";

  /** Bullets built only from allowances configured in Admin -> Billing. */
  const planIncludes = (p: PublicBillingPlan): string[] => {
    const out: string[] = [];
    if (p.features.length) out.push(...p.features);
    const lim = p.featureLimits ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

    const seats = p.included_seats ?? null;
    if (seats)
      out.push(es ? `${nfmt(seats)} usuario(s) incluido(s)` : `${nfmt(seats)} included user(s)`);
    if (p.team_member_limit != null)
      out.push(
        es
          ? `Hasta ${nfmt(p.team_member_limit)} miembros del equipo`
          : `Up to ${nfmt(p.team_member_limit)} team members`,
      );

    const matters = p.case_limit ?? num(lim["matters_limit"]);
    if (matters != null)
      out.push(es ? `${nfmt(matters)} casos` : `${nfmt(matters)} cases`);
    else if (isCustomPlan(p)) out.push(es ? "Casos ilimitados" : "Unlimited cases");

    const docs = num(lim["documents_limit"]);
    if (docs != null)
      out.push(es ? `${nfmt(docs)} documentos` : `${nfmt(docs)} documents`);
    else if (isCustomPlan(p)) out.push(es ? "Documentos ilimitados" : "Unlimited documents");

    if (p.ai_requests_monthly != null)
      out.push(
        es
          ? `${nfmt(p.ai_requests_monthly)} solicitudes de IA al mes`
          : `${nfmt(p.ai_requests_monthly)} AI requests / month`,
      );
    if (p.talk_to_case_monthly != null)
      out.push(
        es
          ? `${nfmt(p.talk_to_case_monthly)} conversaciones Talk to Case al mes`
          : `${nfmt(p.talk_to_case_monthly)} Talk to Case conversations / month`,
      );
    if (p.storage_gb_limit != null)
      out.push(es ? `${nfmt(p.storage_gb_limit)} GB de almacenamiento` : `${nfmt(p.storage_gb_limit)} GB storage`);
    if (p.byok_allowed)
      out.push(es ? "Usa tus propias llaves de IA (BYOK)" : "Bring your own AI keys (BYOK)");
    if (isCustomPlan(p))
      out.push(es ? "Implementación y soporte personalizados" : "Custom deployment & support");
    return out;
  };

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

  const checkout = useMutation({
    mutationFn: (planKey: string) =>
      checkoutFn({
        data: {
          planKey,
          provider: "stripe" as const,
          trial: true,
          origin: window.location.origin,
          cancelPath: "/billing?checkout=cancelled",
          successPath: "/billing?checkout=success&provider=stripe",
        },
      }),
    onSuccess: (res: { url?: string | null }) => {
      if (res?.url) window.location.href = res.url;
      else toast.error(t("billing.error.noCheckout"));
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const portal = useMutation({
    mutationFn: () => portalFn({ data: { origin: window.location.origin } }),
    onSuccess: (res: any) => {
      if (res.url) window.location.href = res.url;
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const data = statusQ.data;
  const isLoading = statusQ.isLoading;

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

        {data?.plan && (data.status === "active" || data.status === "trialing") && (
          <button
            onClick={() => portal.mutate()}
            disabled={portal.isPending}
            className="mt-4 inline-flex items-center gap-2 rounded border border-border/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted/40 disabled:opacity-50"
          >
            {portal.isPending ? (
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

      {plansQ.isLoading ? (
        <div className="mt-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
        </div>
      ) : plans.length === 0 ? (
        <div className="mt-10 rounded-lg border border-border/60 bg-card/60 p-6 text-center text-sm text-muted-foreground">
          {t("trial.noPlans")}
        </div>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
            const isCurrent = data?.plan === plan.key;
            const custom = isCustomPlan(plan);
            const popular = plan.key === "pro";
            return (
              <div
                key={plan.key}
                className={`relative flex flex-col rounded-lg border bg-card/60 p-5 ${
                  isCurrent
                    ? "border-primary/70 shadow-sm"
                    : popular
                      ? "border-primary/70 shadow-sm"
                      : "border-border/60"
                }`}
              >
                {popular && !isCurrent && (
                  <span className="absolute -top-2 right-4 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-foreground">
                    {es ? "Más popular" : "Most popular"}
                  </span>
                )}
                {isCurrent && (
                  <span className="absolute -top-2 right-4 rounded-full bg-primary/20 border border-primary/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
                    {t("billing.currentPlan")}
                  </span>
                )}
                <div className="text-base font-semibold text-foreground">{plan.label}</div>
                {plan.tagline && (
                  <p className="mt-1 text-xs text-muted-foreground">{plan.tagline}</p>
                )}
                <div className="mt-4 text-2xl font-semibold text-foreground">
                  {custom ? (es ? "Precio personalizado" : "Custom pricing") : formatPlanPrice(plan)}
                </div>
                <div className="mt-1 text-xs font-medium text-primary">
                  {custom
                    ? es
                      ? "Para despachos y organizaciones con equipos grandes, límites mayores o implementación y soporte a la medida."
                      : "For firms and organizations needing larger teams, higher limits, or customized deployment and support."
                    : t("trial.zeroToday")}
                </div>
                <ul className="mt-4 flex-1 space-y-2">
                  {planIncludes(plan).map((f) => (
                    <li key={f} className="flex gap-2 text-xs text-muted-foreground">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                {isCurrent ? (
                  <div className="mt-5 flex w-full items-center justify-center gap-2 rounded-md border border-primary/40 bg-primary/10 py-3 text-[12px] font-semibold uppercase tracking-[0.18em] text-primary">
                    <ShieldCheck className="h-4 w-4" /> {t("billing.currentPlan")}
                  </div>
                ) : custom ? (
                  <a
                    href={`mailto:contact@mexico.nyrava.com?subject=${encodeURIComponent(
                      es ? "Contacto de ventas — Plan Enterprise" : "Contact sales — Enterprise plan",
                    )}`}
                    className="mt-5 flex w-full items-center justify-center gap-2 rounded-md border border-primary py-3 text-[12px] font-semibold uppercase tracking-[0.18em] text-primary transition hover:bg-primary/10"
                  >
                    {es ? "Contactar ventas" : "Contact sales"}
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => checkout.mutate(plan.key)}
                    disabled={checkout.isPending}
                    className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-primary py-3 text-[12px] font-semibold uppercase tracking-[0.18em] text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
                  >
                    {checkout.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {t("trial.cta")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-8 text-center text-xs text-muted-foreground">{t("trial.fineprint")}</p>
    </div>
  );
}
