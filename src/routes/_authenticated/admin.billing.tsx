// Admin billing plans — CRUD for subscription tiers. Prices/features/Stripe
// price IDs are all editable here so support can add or reprice plans
// without a code deploy.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  Plus,
  Save,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Layers,
  Gauge,
  Eye,
  Check,
  Tag,
  DollarSign,
  CreditCard,
  ListChecks,
  ShieldCheck,
  Webhook,
  Copy,
  ExternalLink,
} from "lucide-react";
import {
  adminListBillingPlans,
  adminUpsertBillingPlan,
  adminDeleteBillingPlan,
  type BillingPlanRow,
} from "@/lib/billing-plans.functions";
import {
  adminGetBillingProviderStatus,
  adminSetBillingProviderEnabled,
  adminListWebhookEvents,
} from "@/lib/billing.functions";
import { useI18n } from "@/i18n";

export const Route = createFileRoute("/_authenticated/admin/billing")({
  head: () => ({ meta: [{ title: "Billing plans — Admin" }] }),
  component: AdminBillingPage,
});

type Draft = {
  id?: string;
  key: string;
  label: string;
  tagline: string;
  featuresText: string;
  price_cents: number;
  currency: string;
  interval: "month" | "year" | "one_time";
  stripe_price_id: string;
  self_serve: boolean;
  contact_url: string;
  sort_order: number;
  active: boolean;
  included_seats: number;
  per_seat_price_cents: number | null;
  per_seat_stripe_price_id: string;
  internal_notes: string;
  // Usage metering — see usage.server.ts. null = unlimited.
  ai_requests_monthly: number | null;
  talk_to_case_monthly: number | null;
  case_limit: number | null;
  storage_gb_limit: number | null;
  team_member_limit: number | null;
  byok_allowed: boolean;
  overage_price_cents: number | null;
};

function toDraft(p: BillingPlanRow): Draft {
  const feats = Array.isArray(p.features)
    ? (p.features as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  // Cast — new columns may not be in the generated Database types until regen.
  const px = p as unknown as {
    included_seats?: number | null;
    per_seat_price_cents?: number | null;
    per_seat_stripe_price_id?: string | null;
    internal_notes?: string | null;
  };
  return {
    id: p.id,
    key: p.key ?? "",
    label: p.label ?? "",
    tagline: p.tagline ?? "",
    featuresText: feats.join("\n"),
    price_cents: p.price_cents,
    currency: p.currency,
    interval: (p.interval as Draft["interval"]) ?? "month",
    stripe_price_id: p.stripe_price_id ?? "",
    self_serve: p.self_serve,
    contact_url: p.contact_url ?? "",
    sort_order: p.sort_order,
    active: p.active,
    included_seats: typeof px.included_seats === "number" ? px.included_seats : 1,
    per_seat_price_cents:
      typeof px.per_seat_price_cents === "number" ? px.per_seat_price_cents : null,
    per_seat_stripe_price_id: px.per_seat_stripe_price_id ?? "",
    internal_notes: px.internal_notes ?? "",
    ai_requests_monthly: typeof p.ai_requests_monthly === "number" ? p.ai_requests_monthly : null,
    talk_to_case_monthly:
      typeof p.talk_to_case_monthly === "number" ? p.talk_to_case_monthly : null,
    case_limit: typeof p.case_limit === "number" ? p.case_limit : null,
    storage_gb_limit: typeof p.storage_gb_limit === "number" ? p.storage_gb_limit : null,
    team_member_limit: typeof p.team_member_limit === "number" ? p.team_member_limit : null,
    byok_allowed: p.byok_allowed ?? true,
    overage_price_cents: typeof p.overage_price_cents === "number" ? p.overage_price_cents : null,
  };
}

function emptyDraft(nextSort: number): Draft {
  return {
    key: "",
    label: "",
    tagline: "",
    featuresText: "",
    price_cents: 0,
    currency: "usd",
    interval: "month",
    stripe_price_id: "",
    self_serve: true,
    contact_url: "",
    sort_order: nextSort,
    active: true,
    included_seats: 1,
    per_seat_price_cents: null,
    per_seat_stripe_price_id: "",
    internal_notes: "",
    ai_requests_monthly: null,
    talk_to_case_monthly: null,
    case_limit: null,
    storage_gb_limit: null,
    team_member_limit: null,
    byok_allowed: true,
    overage_price_cents: null,
  };
}

// ---------------------------------------------------------------------
// Formatting helpers — shared by the edit form and the live preview card
// so the number an admin types is always the number a customer would see.
// ---------------------------------------------------------------------

/** Normalizes common mistyped codes to valid ISO-4217 (e.g. MEX -> MXN). */
function normalizeCurrency(currency: string): string {
  const c = (currency || "usd").trim().toUpperCase();
  if (c === "MEX" || c === "MX" || c === "MXP") return "MXN";
  if (c === "US" || c === "USDS") return "USD";
  return c;
}

function formatMoney(cents: number, currency: string): string {
  const code = normalizeCurrency(currency);
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(code === "MXN" ? "en-US" : undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function intervalSuffix(interval: Draft["interval"]): string {
  if (interval === "year") return "/yr";
  if (interval === "one_time") return "";
  return "/mo";
}

function AdminBillingPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const listFn = useServerFn(adminListBillingPlans);
  const upsertFn = useServerFn(adminUpsertBillingPlan);
  const deleteFn = useServerFn(adminDeleteBillingPlan);

  const plansQ = useQuery({ queryKey: ["admin-billing-plans"], queryFn: () => listFn() });

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [creating, setCreating] = useState<Draft | null>(null);

  const rows = useMemo(() => plansQ.data ?? [], [plansQ.data]);

  const getDraft = (p: BillingPlanRow): Draft => drafts[p.id] ?? toDraft(p);
  const patchDraft = (id: string, patch: Partial<Draft>) => {
    setDrafts((prev) => {
      const base = prev[id] ?? toDraft(rows.find((r) => r.id === id)!);
      return { ...prev, [id]: { ...base, ...patch } };
    });
  };

  const upsertM = useMutation({
    mutationFn: async (d: Draft) => {
      const features = d.featuresText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      return await upsertFn({
        data: {
          id: d.id,
          key: d.key,
          label: d.label,
          tagline: d.tagline,
          features,
          price_cents: Math.round(d.price_cents),
          currency: normalizeCurrency(d.currency).toLowerCase(),
          interval: d.interval,
          stripe_price_id: d.stripe_price_id.trim() || null,
          self_serve: d.self_serve,
          contact_url: d.contact_url.trim() || null,
          sort_order: Math.round(d.sort_order),
          active: d.active,
          included_seats: Math.max(1, Math.round(d.included_seats || 1)),
          per_seat_price_cents:
            typeof d.per_seat_price_cents === "number"
              ? Math.max(0, Math.round(d.per_seat_price_cents))
              : null,
          per_seat_stripe_price_id: d.per_seat_stripe_price_id.trim() || null,
          internal_notes: d.internal_notes.trim() || null,
          ai_requests_monthly:
            typeof d.ai_requests_monthly === "number"
              ? Math.max(0, Math.round(d.ai_requests_monthly))
              : null,
          talk_to_case_monthly:
            typeof d.talk_to_case_monthly === "number"
              ? Math.max(0, Math.round(d.talk_to_case_monthly))
              : null,
          case_limit:
            typeof d.case_limit === "number" ? Math.max(0, Math.round(d.case_limit)) : null,
          storage_gb_limit:
            typeof d.storage_gb_limit === "number" ? Math.max(0, d.storage_gb_limit) : null,
          team_member_limit:
            typeof d.team_member_limit === "number"
              ? Math.max(0, Math.round(d.team_member_limit))
              : null,
          byok_allowed: d.byok_allowed,
          overage_price_cents:
            typeof d.overage_price_cents === "number"
              ? Math.max(0, Math.round(d.overage_price_cents))
              : null,
        },
      });
    },
    onSuccess: (saved) => {
      toast.success(`Saved ${saved.label}`);
      setDrafts((prev) => {
        const { [saved.id]: _, ...rest } = prev;
        void _;
        return rest;
      });
      setCreating(null);
      qc.invalidateQueries({ queryKey: ["admin-billing-plans"] });
      qc.invalidateQueries({ queryKey: ["billing-plans-public"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Plan deleted");
      qc.invalidateQueries({ queryKey: ["admin-billing-plans"] });
      qc.invalidateQueries({ queryKey: ["billing-plans-public"] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : t("admin.billing.deleteFailed")),
  });

  const nextSort = (rows[rows.length - 1]?.sort_order ?? 0) + 10;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-10">
      <div className="flex items-center gap-2">
        <Link
          to="/admin"
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <ChevronLeft className="h-4 w-4" /> {t("admin.billing.nav.admin")}
        </Link>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <CreditCard className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold leading-tight">{t("admin.billing.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("admin.billing.subtitle.pre")}{" "}
            <Link to="/billing" className="underline underline-offset-2 hover:text-foreground">
              /billing
            </Link>{" "}
            {t("admin.billing.subtitle.post")}
          </p>
        </div>
      </div>

      <div className="mt-8">
        <PaymentProvidersPanel />
      </div>

      {plansQ.isLoading && (
        <div className="mt-6 text-sm text-muted-foreground">{t("admin.billing.loading")}</div>
      )}
      {plansQ.error && (
        <div className="mt-6 text-sm text-destructive">{t("admin.billing.loadError")}</div>
      )}

      <div className="mt-8 space-y-5">
        {rows.map((p) => {
          const d = getDraft(p);
          const dirty = drafts[p.id] !== undefined;
          return (
            <PlanEditor
              key={p.id}
              draft={d}
              dirty={dirty}
              onChange={(patch) => patchDraft(p.id, patch)}
              onSave={() => upsertM.mutate(d)}
              onDelete={() => {
                if (confirm(t("admin.billing.deleteConfirm", { label: p.label ?? p.key ?? "" })))
                  deleteM.mutate(p.id);
              }}
              saving={upsertM.isPending && upsertM.variables?.id === p.id}
              deleting={deleteM.isPending && deleteM.variables === p.id}
            />
          );
        })}
      </div>

      <div className="mt-6">
        {creating ? (
          <PlanEditor
            draft={creating}
            dirty
            isNew
            onChange={(patch) => setCreating({ ...creating, ...patch })}
            onSave={() => upsertM.mutate(creating)}
            onDelete={() => setCreating(null)}
            saving={upsertM.isPending && !upsertM.variables?.id}
            deleting={false}
            deleteLabel={t("admin.billing.cancel")}
          />
        ) : (
          <button
            onClick={() => setCreating(emptyDraft(nextSort))}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-accent/50 hover:bg-card hover:text-foreground"
          >
            <Plus className="h-4 w-4" /> {t("admin.billing.addPlan")}
          </button>
        )}
      </div>
    </div>
  );
}

function GroupLabel({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      <Icon className="h-3.5 w-3.5" /> {children}
    </div>
  );
}

/** Dollar-denominated price input. Draft still stores price_cents under the
 * hood (unchanged data flow, unchanged save payload) — this just removes
 * the "type 4900 to mean $49.00" mental-math step from the actual editing
 * experience. */
function PriceCentsInput({
  cents,
  onChange,
}: {
  cents: number;
  onChange: (cents: number) => void;
}) {
  // Keep a free-text buffer so partial entries ("", "50.", "0.0") survive
  // typing; the canonical value stays in cents on the draft.
  const toText = (c: number) => (Math.round(Number(c) || 0) / 100).toFixed(2);
  const [text, setText] = useState<string>(() => toText(cents));

  useEffect(() => {
    const parsed = Math.round((parseFloat(text.replace(",", ".")) || 0) * 100);
    if (parsed !== Math.round(Number(cents) || 0)) setText(toText(cents));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents]);

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        $
      </span>
      <input
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        className="w-full rounded-md border border-border bg-background py-2 pl-6 pr-3 text-sm tabular-nums"
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const raw = e.target.value.replace(",", ".");
          if (raw !== "" && !/^\d*\.?\d{0,2}$/.test(raw)) return;
          setText(raw);
          const v = parseFloat(raw);
          onChange(Number.isFinite(v) ? Math.round(v * 100) : 0);
        }}
        onBlur={() => setText(toText(cents))}
      />
    </div>
  );
}

/** Nullable numeric limit input — checking "Unlimited" clears the field to
 * null (no cap), otherwise stores a plain number. Used for every usage
 * metering limit below (AI requests, Talk-to-Case, cases, storage, seats). */
function LimitInput({
  value,
  onChange,
  step,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
}) {
  const { t } = useI18n();
  const isUnlimited = value == null;
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={0}
        step={step ?? 1}
        disabled={isUnlimited}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums disabled:opacity-40"
        value={isUnlimited ? "" : value}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const v = Number(raw);
          onChange(Number.isFinite(v) ? v : null);
        }}
        placeholder={t("admin.billing.unlimited")}
      />
      <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 rounded border-border accent-accent"
          checked={isUnlimited}
          onChange={(e) => onChange(e.target.checked ? null : 0)}
        />
        {t("admin.billing.unlimited")}
      </label>
    </div>
  );
}

/** What a customer actually sees on /billing for this plan, updating live
 * as the admin edits — so pricing, features, and copy can be sanity-checked
 * without leaving this page or guessing how the raw fields will render. */
function PlanPreviewCard({ draft }: { draft: Draft }) {
  const { t } = useI18n();
  const features = draft.featuresText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <div className="md:sticky md:top-6">
      <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Eye className="h-3.5 w-3.5" /> {t("admin.billing.preview.label")}
      </div>
      <div
        className={`rounded-xl border p-5 transition-opacity ${
          draft.active ? "border-border bg-card" : "border-border/50 bg-card/50 opacity-60"
        }`}
      >
        <div className="text-base font-semibold">
          {draft.label || t("admin.billing.preview.untitled")}
        </div>
        {draft.tagline && <div className="mt-1 text-sm text-muted-foreground">{draft.tagline}</div>}

        <div className="mt-4 flex items-baseline gap-1">
          <span className="text-3xl font-semibold tabular-nums text-accent">
            {formatMoney(draft.price_cents, draft.currency)}
          </span>
          {draft.interval !== "one_time" && (
            <span className="text-sm text-muted-foreground">{intervalSuffix(draft.interval)}</span>
          )}
        </div>

        {features.length > 0 ? (
          <ul className="mt-4 space-y-1.5">
            {features.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4 text-sm italic text-muted-foreground">
            {t("admin.billing.preview.noFeatures")}
          </div>
        )}

        <div className="mt-5 rounded-md border border-border bg-background px-3 py-2 text-center text-sm font-medium text-muted-foreground">
          {draft.self_serve
            ? t("admin.billing.preview.subscribe")
            : t("admin.billing.preview.contactUs")}
        </div>

        {!draft.active && (
          <div className="mt-3 text-center text-xs text-muted-foreground">
            {t("admin.billing.preview.hidden")}
          </div>
        )}
      </div>
    </div>
  );
}

function PlanEditor({
  draft,
  dirty,
  isNew,
  onChange,
  onSave,
  onDelete,
  saving,
  deleting,
  deleteLabel,
}: {
  draft: Draft;
  dirty: boolean;
  isNew?: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onSave: () => void;
  onDelete: () => void;
  saving: boolean;
  deleting: boolean;
  deleteLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-border bg-card p-5 md:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
              draft.active ? "bg-accent/15 text-accent" : "bg-muted text-muted-foreground"
            }`}
          >
            <Layers className="h-4 w-4" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">
                {isNew ? t("admin.billing.plan.new") : draft.label || draft.key}
              </h3>
              {!draft.active && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {t("admin.billing.plan.inactive")}
                </span>
              )}
              {dirty && (
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">
                  {t("admin.billing.plan.unsaved")}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {draft.self_serve
                ? t("admin.billing.plan.selfServe")
                : t("admin.billing.plan.contactOnly")}{" "}
              · {t("admin.billing.plan.sortOrder")} {draft.sort_order}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onSave}
            disabled={saving || !dirty}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{" "}
            {t("admin.billing.save")}
          </button>
          <button
            onClick={onDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {deleteLabel ?? t("admin.billing.delete")}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[260px_1fr]">
        <PlanPreviewCard draft={draft} />

        <div className="space-y-6">
          <div>
            <GroupLabel icon={Tag}>{t("admin.billing.group.identity")}</GroupLabel>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label={t("admin.billing.field.key")}>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                  value={draft.key}
                  onChange={(e) => onChange({ key: e.target.value })}
                  disabled={!isNew}
                  placeholder="solo"
                />
              </Field>
              <Field label={t("admin.billing.field.label")}>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={draft.label}
                  onChange={(e) => onChange({ label: e.target.value })}
                  placeholder="Solo"
                />
              </Field>
              <Field label={t("admin.billing.field.tagline")} className="md:col-span-2">
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={draft.tagline}
                  onChange={(e) => onChange({ tagline: e.target.value })}
                  placeholder="For solo practitioners and small caseloads"
                />
              </Field>
            </div>
          </div>

          <div>
            <GroupLabel icon={DollarSign}>{t("admin.billing.group.pricing")}</GroupLabel>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label={t("admin.billing.field.price")}>
                <PriceCentsInput
                  cents={draft.price_cents}
                  onChange={(price_cents) => onChange({ price_cents })}
                />
              </Field>
              <Field label={t("admin.billing.field.currency")}>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm uppercase"
                  value={draft.currency}
                  onChange={(e) => onChange({ currency: e.target.value.toLowerCase() })}
                  onBlur={(e) =>
                    onChange({ currency: normalizeCurrency(e.target.value).toLowerCase() })
                  }
                  placeholder="MXN"
                  maxLength={3}
                />
              </Field>
              <Field label={t("admin.billing.field.interval")}>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={draft.interval}
                  onChange={(e) => onChange({ interval: e.target.value as Draft["interval"] })}
                >
                  <option value="month">{t("admin.billing.interval.monthly")}</option>
                  <option value="year">{t("admin.billing.interval.yearly")}</option>
                  <option value="one_time">{t("admin.billing.interval.oneTime")}</option>
                </select>
              </Field>
              <Field label={t("admin.billing.field.sortOrder")}>
                <input
                  type="number"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums"
                  value={draft.sort_order}
                  onChange={(e) => onChange({ sort_order: Number(e.target.value) || 0 })}
                />
              </Field>
            </div>
          </div>

          {draft.self_serve && (
            <div>
              <GroupLabel icon={Layers}>{t("admin.billing.group.seats")}</GroupLabel>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label={t("admin.billing.field.includedSeats")}>
                  <input
                    type="number"
                    min={1}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums"
                    value={draft.included_seats}
                    onChange={(e) =>
                      onChange({ included_seats: Math.max(1, Number(e.target.value) || 1) })
                    }
                  />
                </Field>
                <Field label={t("admin.billing.field.perSeatPrice")}>
                  <PriceCentsInput
                    cents={draft.per_seat_price_cents ?? 0}
                    onChange={(cents) =>
                      onChange({ per_seat_price_cents: cents > 0 ? cents : null })
                    }
                  />
                </Field>
                <Field label={t("admin.billing.field.perSeatStripeId")} className="md:col-span-2">
                  <input
                    className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs opacity-60"
                    value={draft.per_seat_stripe_price_id}
                    onChange={(e) => onChange({ per_seat_stripe_price_id: e.target.value })}
                    placeholder="price_1N... (optional per-seat Stripe price)"
                  />
                </Field>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t("admin.billing.seats.note")}</p>
            </div>
          )}

          <div>
            <GroupLabel icon={Gauge}>{t("admin.billing.group.usageLimits")}</GroupLabel>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label={t("admin.billing.field.aiRequests")}>
                <LimitInput
                  value={draft.ai_requests_monthly}
                  onChange={(v) => onChange({ ai_requests_monthly: v })}
                />
              </Field>
              <Field label={t("admin.billing.field.talkToCase")}>
                <LimitInput
                  value={draft.talk_to_case_monthly}
                  onChange={(v) => onChange({ talk_to_case_monthly: v })}
                />
              </Field>
              <Field label={t("admin.billing.field.caseLimit")}>
                <LimitInput
                  value={draft.case_limit}
                  onChange={(v) => onChange({ case_limit: v })}
                />
              </Field>
              <Field label={t("admin.billing.field.storageLimit")}>
                <LimitInput
                  value={draft.storage_gb_limit}
                  onChange={(v) => onChange({ storage_gb_limit: v })}
                  step={0.5}
                />
              </Field>
              <Field label={t("admin.billing.field.teamSeats")}>
                <LimitInput
                  value={draft.team_member_limit}
                  onChange={(v) => onChange({ team_member_limit: v })}
                />
              </Field>
              <Field label={t("admin.billing.field.overagePrice")}>
                <PriceCentsInput
                  cents={draft.overage_price_cents ?? 0}
                  onChange={(cents) => onChange({ overage_price_cents: cents > 0 ? cents : null })}
                />
              </Field>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border accent-accent"
                checked={draft.byok_allowed}
                onChange={(e) => onChange({ byok_allowed: e.target.checked })}
              />
              {t("admin.billing.byokAllow")}
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("admin.billing.usageLimits.note")}
            </p>
          </div>

          <div>
            <GroupLabel icon={ListChecks}>{t("admin.billing.group.internalNotes")}</GroupLabel>
            <textarea
              className="min-h-[80px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={draft.internal_notes}
              onChange={(e) => onChange({ internal_notes: e.target.value })}
              placeholder={t("admin.billing.field.internalNotesPlaceholder")}
            />
          </div>

          <div>
            <GroupLabel icon={CreditCard}>{t("admin.billing.group.checkout")}</GroupLabel>
            <div className="grid grid-cols-1 gap-4">
              <Field label={t("admin.billing.field.stripePriceId")}>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                  value={draft.stripe_price_id}
                  onChange={(e) => onChange({ stripe_price_id: e.target.value })}
                  placeholder="price_1N..."
                />
              </Field>

              <Field label={t("admin.billing.field.contactUrl")}>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={draft.contact_url}
                  onChange={(e) => onChange({ contact_url: e.target.value })}
                  placeholder="mailto:contact@mexico.nyrava.com"
                />
              </Field>
            </div>
          </div>

          <div>
            <GroupLabel icon={ListChecks}>{t("admin.billing.group.features")}</GroupLabel>
            <textarea
              className="min-h-[120px] w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              value={draft.featuresText}
              onChange={(e) => onChange({ featuresText: e.target.value })}
            />
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-2 border-t border-border pt-5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border accent-accent"
                checked={draft.self_serve}
                onChange={(e) => onChange({ self_serve: e.target.checked })}
              />
              {t("admin.billing.checkbox.selfServe")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border accent-accent"
                checked={draft.active}
                onChange={(e) => onChange({ active: e.target.checked })}
              />
              {t("admin.billing.checkbox.active")}
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}

function StatusChip({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border p-3 ${
        ok ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5"
      }`}
    >
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
      </div>
    </div>
  );
}

function fmtWhen(s: string) {
  return new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Independent, server-enforced provider controls. Secret values never reach this page. */
function PaymentProvidersPanel() {
  const { locale } = useI18n();
  const qc = useQueryClient();
  const statusFn = useServerFn(adminGetBillingProviderStatus);
  const toggleFn = useServerFn(adminSetBillingProviderEnabled);
  const eventsFn = useServerFn(adminListWebhookEvents);
  const statusQ = useQuery({
    queryKey: ["admin-billing-provider-status"],
    queryFn: () => statusFn(),
  });
  const eventsQ = useQuery({
    queryKey: ["admin-webhook-events"],
    queryFn: () => eventsFn(),
    refetchInterval: 15000,
  });
  const toggle = useMutation({
    mutationFn: (input: { provider: "stripe"; enabled: boolean }) =>
      toggleFn({ data: input }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["admin-billing-provider-status"] });
      toast.success(locale === "es" ? "Proveedor de pago actualizado" : "Payment provider updated");
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
  });
  const copyUrl = (path: string) => {
    const value = `${window.location.origin}${path}`;
    void navigator.clipboard.writeText(value);
    toast.success(locale === "es" ? "URL copiada" : "URL copied");
  };
  const providers = statusQ.data
    ? [
        {
          id: "stripe" as const,
          name: "Stripe",
          status: statusQ.data.stripe,
          secretLabel: "STRIPE_SECRET_KEY",
          webhookLabel: "STRIPE_WEBHOOK_SECRET",
          dashboard: "https://dashboard.stripe.com/webhooks",
          events:
            "checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed",
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">
            {locale === "es" ? "Proveedores de pago" : "Payment providers"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {locale === "es"
              ? "Los pagos se procesan con Stripe."
              : "Payments are processed with Stripe."}
          </p>
        </div>
        <button
          onClick={() => {
            statusQ.refetch();
            eventsQ.refetch();
          }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
          {locale === "es" ? "Actualizar" : "Refresh"}
        </button>
      </div>

      {statusQ.isLoading && (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          {locale === "es" ? "Comprobando configuración…" : "Checking configuration…"}
        </div>
      )}

      <div className="grid gap-4">
        {providers.map((provider) => {
          const configured = provider.status.hasSecretKey && provider.status.hasWebhookSecret;
          return (
            <section key={provider.id} className="rounded-xl border border-border bg-card p-5 md:p-6">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck
                    className={`h-4 w-4 ${configured ? "text-success" : "text-muted-foreground"}`}
                  />
                  <div>
                    <h3 className="font-semibold">{provider.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {provider.status.enabled
                        ? locale === "es" ? "Aceptando nuevos pagos" : "Accepting new payments"
                        : locale === "es" ? "Nuevos pagos desactivados" : "New payments disabled"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={toggle.isPending}
                  aria-pressed={provider.status.enabled}
                  onClick={() =>
                    toggle.mutate({ provider: provider.id, enabled: !provider.status.enabled })
                  }
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${provider.status.enabled
                    ? "bg-success/15 text-success"
                    : "bg-muted text-muted-foreground"}`}
                >
                  {provider.status.enabled
                    ? locale === "es" ? "Activo" : "Enabled"
                    : locale === "es" ? "Inactivo" : "Disabled"}
                </button>
              </div>

              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <StatusChip
                  ok={provider.status.hasSecretKey}
                  label={provider.secretLabel}
                  detail={provider.status.keyMode ?? undefined}
                />
                <StatusChip
                  ok={provider.status.hasWebhookSecret}
                  label={provider.webhookLabel}
                  detail={provider.status.webhookSecretLast4
                    ? `••••${provider.status.webhookSecretLast4}`
                    : undefined}
                />
              </div>

              <div className="rounded-lg border border-border bg-secondary/25 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium">
                  <Webhook className="h-3.5 w-3.5" />
                  {locale === "es" ? "Webhook firmado" : "Signed webhook"}
                </div>
                <div className="flex gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded bg-background px-2 py-2 text-xs">
                    {typeof window === "undefined"
                      ? provider.status.webhookUrl
                      : `${window.location.origin}${provider.status.webhookUrl}`}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyUrl(provider.status.webhookUrl)}
                    className="rounded-md border border-border px-2"
                    aria-label={locale === "es" ? "Copiar URL" : "Copy URL"}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {locale === "es" ? "Eventos: " : "Events: "}{provider.events}
                </p>
                <a
                  href={provider.dashboard}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-xs underline underline-offset-2"
                >
                  {locale === "es" ? "Abrir configuración" : "Open setup"}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </section>
          );
        })}
      </div>

      <section className="rounded-xl border border-border bg-card p-5 md:p-6">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {locale === "es" ? "Entregas recientes" : "Recent deliveries"}
        </h3>
        {(eventsQ.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {locale === "es" ? "Aún no hay eventos de webhook." : "No webhook events yet."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-secondary/50 text-muted-foreground">
                  <th className="px-3 py-2 text-left">Event</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Detail</th>
                  <th className="px-3 py-2 text-left">Received</th>
                </tr>
              </thead>
              <tbody>
                {(eventsQ.data ?? []).slice(0, 20).map((event) => (
                  <tr key={event.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono">{event.event_type}</td>
                    <td className="px-3 py-2">{event.status}</td>
                    <td className="px-3 py-2 text-muted-foreground">{event.detail ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmtWhen(event.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
