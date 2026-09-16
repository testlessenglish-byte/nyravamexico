import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { listCases } from "@/lib/cases.functions";
import { ensureStarterCases } from "@/lib/account.functions";
import {
  getAttorneyHome,
  setEventReminder,
  setTaskReminder,
  upsertCaseEvent,
  upsertCaseTask,
} from "@/lib/casework.functions";
import { ReminderControl, type ReminderValue } from "@/components/casework/ReminderControl";

import { PipelineTracePanel } from "@/components/PipelineTracePanel";
import { useCaseExecution } from "@/hooks/useCaseExecution";
import { useRoles } from "@/hooks/use-roles";
import { listClients } from "@/lib/clients.functions";
import { listUpcomingDeadlines } from "@/lib/deadlines.functions";
import { useI18n } from "@/i18n";
import {
  FileText,
  Users,
  AlertTriangle,
  HelpCircle,
  ChevronRight,
  Mic,
  MessageSquare,
  Target,
  Bell,
  Plus,
  Activity,
  Sparkles,
  Clock,
  CalendarDays,
  ListChecks,
  ArrowRight,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Nyrava" }] }),
  component: DashboardPage,
});

const RUNNING = new Set([
  "extracting",
  "analyzing",
  "agents_running",
  "scoring",
  "reporting",
  "intelligence_running",
]);

function DashboardPage() {
  const { t } = useI18n();
  const fetchCases = useServerFn(listCases);
  const { data, isLoading } = useQuery({
    queryKey: ["cases"],
    queryFn: () => fetchCases(),
    refetchInterval: 5000,
  });

  const fetchHome = useServerFn(getAttorneyHome);
  const { data: home } = useQuery({
    queryKey: ["attorney-home"],
    queryFn: () => fetchHome(),
    refetchInterval: 60000,
  });

  const fetchClients = useServerFn(listClients);
  const { data: recentClients } = useQuery({
    queryKey: ["clients", "recent"],
    queryFn: () => fetchClients({ data: { status: "active" } }),
    refetchInterval: 60000,
    select: (clients) => clients.slice(0, 3), // Only want recent 3
  });

  const fetchDeadlines = useServerFn(listUpcomingDeadlines);
  const { data: crmDeadlines } = useQuery({
    queryKey: ["crm-deadlines"],
    queryFn: () => fetchDeadlines(),
    refetchInterval: 60000,
  });

  const cases = useMemo(() => (data ?? []).filter((c) => !c.archived_at), [data]);

  // Accounts created before starter seeding existed (or whose seeding failed
  // during profile setup) get their two amparo test matters here. The server
  // call is idempotent — it skips any corpus already present.
  const qc = useQueryClient();
  const seedStarters = useServerFn(ensureStarterCases);
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || isLoading || (data ?? []).length > 0) return;
    seededRef.current = true;
    void seedStarters({ data: undefined } as never)
      .then((r) => {
        if (r && Array.isArray(r.created) && r.created.length > 0) {
          void qc.invalidateQueries({ queryKey: ["cases"] });
        }
      })
      .catch(() => {
        /* seeding is best-effort; never surface it on the dashboard */
      });
  }, [isLoading, data, seedStarters, qc]);

  const featured = cases.find((c) => c.status === "complete") ?? cases[0];
  const activeCount = cases.filter((c) => RUNNING.has(c.status)).length;
  const { isAdmin } = useRoles();

  const completeCount = cases.filter((c) => c.status === "complete").length;
  const highPriorityCount = useMemo(
    () =>
      cases.reduce(
        (sum, c) => sum + ((c as { high_priority_findings?: number }).high_priority_findings ?? 0),
        0,
      ),
    [cases],
  );
  const witnessTotal = useMemo(
    () => cases.reduce((sum, c) => sum + ((c as { witness_count?: number }).witness_count ?? 0), 0),
    [cases],
  );
  const contradictionTotal = useMemo(
    () =>
      cases.reduce(
        (sum, c) => sum + ((c as { contradiction_count?: number | null }).contradiction_count ?? 0),
        0,
      ),
    [cases],
  );
  const discoveryGapTotal = useMemo(
    () =>
      cases.reduce(
        (sum, c) => sum + ((c as { discovery_gap_count?: number | null }).discovery_gap_count ?? 0),
        0,
      ),
    [cases],
  );

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-5 md:px-8 md:py-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiChip
          icon={<FileText className="h-4 w-4" />}
          value={cases.length}
          label={t("dashboard.kpi.activeCases")}
          tone="primary"
        />
        <KpiChip
          icon={<Activity className="h-4 w-4" />}
          value={completeCount}
          label={t("dashboard.kpi.analysesComplete")}
          tone="success"
        />
        <KpiChip
          icon={<AlertTriangle className="h-4 w-4" />}
          value={highPriorityCount}
          label={t("dashboard.kpi.highPriorityFindings")}
          tone="danger"
        />
        <KpiChip
          icon={<Users className="h-4 w-4" />}
          value={witnessTotal}
          label={t("dashboard.stat.witnesses")}
          tone="primary"
        />
        <KpiChip
          icon={<AlertTriangle className="h-4 w-4" />}
          value={contradictionTotal}
          label={t("dashboard.stat.contradictions")}
          tone="danger"
        />
        <KpiChip
          icon={<HelpCircle className="h-4 w-4" />}
          value={discoveryGapTotal}
          label={t("dashboard.stat.discoveryGaps")}
          tone="warning"
        />
      </div>

      <AttorneyHome home={home} cases={cases} />

      {isLoading ? (
        <div className="rounded-xl border border-border bg-card/60 p-10 text-center text-sm text-muted-foreground">
          {t("dashboard.loadingCases")}
        </div>
      ) : featured ? (
        <FeaturedCaseCard caseRow={featured} />
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-card/60 p-10 text-center">
          <Sparkles className="mx-auto h-10 w-10 text-primary" />
          <h2 className="mt-4 text-lg font-semibold">{t("dashboard.welcome.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("dashboard.welcome.subtitle")}</p>
          <Link
            to="/new"
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> {t("dashboard.welcome.cta")}
          </Link>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-5">
          {featured ? (
            <div className="rounded-xl border border-border bg-card/60 p-5">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold">{t("dashboard.commandCenter.title")}</h2>
                  <p className="text-xs text-primary">{t("dashboard.commandCenter.subtitle")}</p>
                </div>
                <Link
                  to="/cases/$caseId"
                  params={{ caseId: featured.id }}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {t("dashboard.commandCenter.openCase")} <ChevronRight className="h-3 w-3" />
                </Link>
              </div>
              <PipelineProgressSummary caseId={featured.id} />
            </div>
          ) : null}

          {isAdmin && featured && (
            <PipelineTracePanel caseId={featured.id} isProcessing={RUNNING.has(featured.status)} />
          )}

          <Link
            to="/talk"
            className="block rounded-xl border border-primary/30 bg-primary/5 p-5 transition hover:bg-primary/10"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-primary/15 text-primary">
                  <MessageSquare className="h-5 w-5" />
                </span>
                <div>
                  <div className="text-sm font-semibold text-primary">
                    {t("dashboard.talk.title")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("dashboard.talk.subtitle")}
                  </div>
                </div>
              </div>
              <ChevronRight className="h-5 w-5 text-primary" />
            </div>
          </Link>
        </div>

        <div className="space-y-5">
          {/* CRM Widgets */}
          {crmDeadlines && crmDeadlines.length > 0 && (
            <div className="rounded-xl border border-warning/30 bg-warning/5 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-warning">
                  Próximos Vencimientos
                </h2>
              </div>
              <ul className="space-y-3">
                {crmDeadlines.slice(0, 3).map((d: any) => (
                  <li key={d.id} className="text-xs">
                    <div className="font-medium text-foreground truncate">{d.title}</div>
                    <div className="mt-1 flex justify-between text-muted-foreground">
                      <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {new Date(`${d.due_date}T12:00:00`).toLocaleDateString()}</span>
                      <span className="truncate max-w-[120px]">{d.case_number || d.case_title || ""}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border border-border bg-card/60 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Clientes Recientes
              </h2>
              <Link to="/clients" className="text-xs text-primary hover:underline">
                Ver todos
              </Link>
            </div>
            {!recentClients || recentClients.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No hay clientes activos.
              </p>
            ) : (
              <ul className="space-y-3">
                {recentClients.map((client: any) => (
                  <li key={client.id} className="flex items-center justify-between gap-3 text-xs">
                    <Link
                      to="/clients/$clientId"
                      params={{ clientId: client.id }}
                      className="min-w-0 flex-1 truncate hover:text-primary"
                    >
                      <span className="font-medium text-foreground">{client.display_name}</span>
                    </Link>
                    <span className="shrink-0 text-muted-foreground">
                      {client.case_count} exp.
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card/60 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("dashboard.recentActivity.title")}
              </h2>
              <Link to="/cases" className="text-xs text-primary hover:underline">
                {t("common.viewAll")}
              </Link>
            </div>
            {cases.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {t("dashboard.recentActivity.empty")}
              </p>
            ) : (
              <ul className="space-y-3">
                {cases.slice(0, 5).map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 text-xs">
                    <Link
                      to="/cases/$caseId"
                      params={{ caseId: c.id }}
                      className="min-w-0 flex-1 truncate hover:text-primary"
                    >
                      <span className="font-medium text-foreground">{c.name}</span>
                      <span className="ml-2 text-muted-foreground">
                        {c.status_message ?? c.status}
                      </span>
                    </Link>
                    <span className="shrink-0 text-muted-foreground">
                      <Clock className="inline h-3 w-3" />{" "}
                      {timeAgo(c.completed_at ?? c.created_at, t)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {activeCount > 0 ? (
            <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-warning" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold uppercase tracking-wider text-warning">
                    {t(
                      activeCount === 1
                        ? "dashboard.processing.singular"
                        : "dashboard.processing.plural",
                      {
                        count: activeCount,
                      },
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("dashboard.processing.subtitle")}
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <QuickAction
          to="/new"
          icon={<Plus className="h-5 w-5" />}
          label={t("dashboard.quickActions.newCase")}
        />
        <QuickAction
          to="/reports"
          icon={<FileText className="h-5 w-5" />}
          label={t("dashboard.quickActions.reports")}
        />
        <QuickAction
          to="/strategy"
          icon={<Target className="h-5 w-5" />}
          label={t("dashboard.quickActions.strategy")}
        />
        <QuickAction
          to="/alerts"
          icon={<Bell className="h-5 w-5" />}
          label={t("dashboard.quickActions.alerts")}
        />
      </div>
    </div>
  );
}

/**
 * Attorney Home — six real-data cards fed by a single batched aggregation.
 * Universal by construction: nothing here is specific to one materia.
 */
type HomeData = Awaited<ReturnType<typeof getAttorneyHome>>;

function AttorneyHome({ home, cases }: { home: HomeData | undefined; cases: Array<{ id: string; name: string }> }) {
  const { t, locale } = useI18n();
  const dt = new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const d = new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-MX", { dateStyle: "medium" });

  const qc = useQueryClient();
  const saveEventReminder = useServerFn(setEventReminder);
  const saveTaskReminder = useServerFn(setTaskReminder);
  const createEvent = useServerFn(upsertCaseEvent);
  const createTask = useServerFn(upsertCaseTask);
  const refreshHome = () => void qc.invalidateQueries({ queryKey: ["attorney-home"] });

  const [addingEvent, setAddingEvent] = useState(false);
  const [addingTask, setAddingTask] = useState(false);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{t("home.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("home.subtitle")}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <HomeCard
          icon={<CalendarDays className="h-4 w-4" />}
          title={t("home.events")}
          headerRight={<AddButton onClick={() => setAddingEvent((v) => !v)} active={addingEvent} />}
          extra={
            addingEvent ? (
              <QuickAddForm
                kind="event"
                cases={cases}
                onCancel={() => setAddingEvent(false)}
                onSubmit={async (v) => {
                  await createEvent({
                    data: {
                      caseId: v.caseId,
                      title: v.title,
                      event_type: "other",
                      scheduled_at: v.when,
                      notes: v.notes || null,
                      reminder_enabled: v.reminder.enabled,
                      reminder_lead_minutes: v.reminder.leadMinutes,
                      reminder_channels: v.reminder.channels,
                    },
                  });
                  setAddingEvent(false);
                  refreshHome();
                }}
              />
            ) : null
          }
        >
          {(home?.upcomingEvents ?? []).map((e) => (
            <ReminderableRow
              key={e.id}
              caseId={e.case_id}
              primary={e.title}
              secondary={`${e.case_name} · ${dt.format(new Date(e.scheduled_at))}`}
              itemType="event"
              enabled={e.reminder_enabled}
              leadMinutes={e.reminder_lead_minutes}
              channels={e.reminder_channels}
              onSave={(v) => saveEventReminder({ data: { id: e.id, ...v } }).then(refreshHome)}
            />
          ))}
        </HomeCard>

        <HomeCard
          icon={<ListChecks className="h-4 w-4" />}
          title={t("home.deadlines")}
          headerRight={<AddButton onClick={() => setAddingTask((v) => !v)} active={addingTask} />}
          extra={
            addingTask ? (
              <QuickAddForm
                kind="task"
                cases={cases}
                onCancel={() => setAddingTask(false)}
                onSubmit={async (v) => {
                  await createTask({
                    data: {
                      caseId: v.caseId,
                      title: v.title,
                      due_date: v.when,
                      status: "todo",
                      priority: "normal",
                      description: v.notes || null,
                      reminder_enabled: v.reminder.enabled,
                      reminder_lead_minutes: v.reminder.leadMinutes,
                      reminder_channels: v.reminder.channels,
                    },
                  });
                  setAddingTask(false);
                  refreshHome();
                }}
              />
            ) : null
          }
        >
          {(home?.deadlines ?? []).map((task) => (
            <ReminderableRow
              key={task.id}
              caseId={task.case_id}
              primary={task.title}
              secondary={`${task.case_name} · ${task.due_date ? d.format(new Date(`${task.due_date}T12:00:00`)) : ""}`}
              danger={!!task.due_date && task.due_date < new Date().toISOString().slice(0, 10)}
              itemType="task"
              enabled={task.reminder_enabled}
              leadMinutes={task.reminder_lead_minutes}
              channels={task.reminder_channels}
              onSave={(v) => saveTaskReminder({ data: { id: task.id, ...v } }).then(refreshHome)}
            />
          ))}
        </HomeCard>

        <HomeCard icon={<AlertTriangle className="h-4 w-4" />} title={t("home.alerts")}>
          {(home?.aiAlerts ?? []).map((f) => (
            <HomeRow
              key={f.id}
              caseId={f.case_id}
              primary={f.title ?? ""}
              secondary={f.case_name}
              danger
            />
          ))}
        </HomeCard>

        <HomeCard icon={<FileText className="h-4 w-4" />} title={t("home.reports")}>
          {(home?.recentReports ?? []).map((r) => (
            <HomeRow
              key={r.id}
              caseId={r.case_id}
              primary={r.case_name}
              secondary={d.format(new Date(r.created_at))}
            />
          ))}
        </HomeCard>

        <HomeCard icon={<MessageSquare className="h-4 w-4" />} title={t("home.conversations")}>
          {(home?.recentConversations ?? []).map((m) => (
            <HomeRow
              key={m.id}
              caseId={m.case_id}
              primary={String(m.content ?? "").slice(0, 90)}
              secondary={m.case_name}
            />
          ))}
        </HomeCard>

        <HomeCard icon={<Activity className="h-4 w-4" />} title={t("home.resume")}>
          {(home?.quickResume ?? []).map((c) => (
            <HomeRow
              key={c.id}
              caseId={c.id}
              primary={c.name}
              secondary={c.lifecycle_status ?? c.status}
            />
          ))}
        </HomeCard>
      </div>
    </section>
  );
}

function HomeCard({
  icon,
  title,
  headerRight,
  extra,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  headerRight?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const empty = !Array.isArray(children) || children.length === 0;
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="text-primary">{icon}</span>
          {title}
        </span>
        {headerRight}
      </div>
      {extra}
      {empty ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t("home.empty")}</p>
      ) : (
        <ul className="space-y-1.5">{children}</ul>
      )}
    </div>
  );
}

function HomeRow({
  caseId,
  primary,
  secondary,
  danger,
}: {
  caseId: string;
  primary: string;
  secondary?: string;
  danger?: boolean;
}) {
  return (
    <li>
      <Link
        to="/cases/$caseId"
        params={{ caseId }}
        className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-primary/5"
      >
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate font-medium ${danger ? "text-destructive" : "text-foreground"}`}
          >
            {primary}
          </span>
          {secondary && <span className="block truncate text-muted-foreground">{secondary}</span>}
        </span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
      </Link>
    </li>
  );
}

function ReminderableRow({
  caseId,
  primary,
  secondary,
  danger,
  itemType,
  enabled,
  leadMinutes,
  channels,
  onSave,
}: {
  caseId: string;
  primary: string;
  secondary?: string;
  danger?: boolean;
  itemType: "event" | "task";
  enabled: boolean;
  leadMinutes: number;
  channels: string[];
  onSave: (v: { enabled: boolean; leadMinutes: number; channels: ("browser" | "email")[] }) => void;
}) {
  return (
    <li className="flex items-center gap-1">
      <Link
        to="/cases/$caseId"
        params={{ caseId }}
        className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-primary/5"
      >
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate font-medium ${danger ? "text-destructive" : "text-foreground"}`}
          >
            {primary}
          </span>
          {secondary && <span className="block truncate text-muted-foreground">{secondary}</span>}
        </span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
      </Link>
      <ReminderControl
        itemType={itemType}
        enabled={enabled}
        leadMinutes={leadMinutes}
        channels={channels}
        onSave={onSave}
      />
    </li>
  );
}

function AddButton({ onClick, active }: { onClick: () => void; active: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-md normal-case tracking-normal ${
        active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-primary/10 hover:text-primary"
      }`}
      title="Agregar"
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

type QuickAddValue = { caseId: string; title: string; when: string; notes: string; reminder: ReminderValue };

function QuickAddForm({
  kind,
  cases,
  onSubmit,
  onCancel,
}: {
  kind: "event" | "task";
  cases: Array<{ id: string; name: string }>;
  onSubmit: (v: QuickAddValue) => Promise<void>;
  onCancel: () => void;
}) {
  const [caseId, setCaseId] = useState(cases[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");
  const [reminder, setReminder] = useState<ReminderValue>({
    enabled: false,
    leadMinutes: kind === "event" ? 60 : 1440,
    channels: ["browser"],
  });
  const [saving, setSaving] = useState(false);

  if (cases.length === 0) {
    return (
      <p className="mb-3 rounded-lg border border-dashed border-border bg-card/40 p-3 text-center text-xs text-muted-foreground">
        Crea primero un expediente para poder agregar {kind === "event" ? "una audiencia/evento" : "un vencimiento"}.
      </p>
    );
  }

  const canSave = !!caseId && title.trim().length > 0 && when.length > 0 && !saving;

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-border bg-card/40 p-3">
      <select
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        value={caseId}
        onChange={(e) => setCaseId(e.target.value)}
      >
        {cases.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <input
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        placeholder={kind === "event" ? "Título de la audiencia/evento" : "Título del vencimiento"}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <input
        type={kind === "event" ? "datetime-local" : "date"}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
      />
      <textarea
        placeholder="Notas"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="min-h-[56px] w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      />
      <div className="flex items-center gap-2">
        <ReminderControl
          itemType={kind}
          enabled={reminder.enabled}
          leadMinutes={reminder.leadMinutes}
          channels={reminder.channels}
          align="left"
          onSave={setReminder}
        />
        <span className="text-xs text-muted-foreground">
          {reminder.enabled ? "Recordatorio activado" : "Sin recordatorio"}
        </span>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canSave}
          onClick={async () => {
            setSaving(true);
            try {
              await onSubmit({ caseId, title: title.trim(), when, notes, reminder });
            } finally {
              setSaving(false);
            }
          }}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Guardando…" : "Guardar"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

/**
 * Compact pipeline status for the Mission Control summary — a progress bar
 * and stage count, not a full stage-by-stage breakdown. The full 20+ stage
 * grid already lives on the case detail page (behind its own collapsed
 * toggle); repeating it here just duplicated that page's job.
 */
function PipelineProgressSummary({ caseId }: { caseId: string }) {
  const { t } = useI18n();
  const { progress } = useCaseExecution(caseId);
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("pipeline.overallProgress")}</span>
        <span className="font-medium tabular-nums text-foreground">
          {progress.completedStages}/{progress.totalStages}
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${progress.percent}%`, background: "var(--gradient-primary)" }}
        />
      </div>
      {progress.hasFailures && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" /> {t("dashboard.commandCenter.hasIssues")}
        </p>
      )}
    </div>
  );
}

function KpiChip({
  icon,
  value,
  label,
  tone,
}: {
  icon: React.ReactNode;
  value: number | string;
  label: string;
  tone: "primary" | "success" | "danger" | "warning";
}) {
  const toneCls =
    tone === "success"
      ? "text-success bg-success/10 ring-success/30"
      : tone === "danger"
        ? "text-destructive bg-destructive/10 ring-destructive/30"
        : tone === "warning"
          ? "text-warning bg-warning/10 ring-warning/30"
          : "text-primary bg-primary/10 ring-primary/30";
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
      <span className={`grid h-10 w-10 place-items-center rounded-lg ring-1 ${toneCls}`}>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-2xl font-bold leading-none">{value}</div>
        <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
      </div>
    </div>
  );
}

function QuickAction({
  to,
  icon,
  label,
}: {
  to: "/new" | "/reports" | "/strategy" | "/alerts";
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3 transition hover:border-primary/40 hover:bg-primary/5"
    >
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="text-sm font-medium">{label}</span>
    </Link>
  );
}

function FeaturedCaseCard({
  caseRow,
}: {
  caseRow: NonNullable<ReturnType<typeof useMemoFeatured>>;
}) {
  const { t } = useI18n();
  const score = (caseRow as { score?: number | null }).score ?? null;
  const isComplete = caseRow.status === "complete";
  const tone =
    score == null
      ? "text-muted-foreground"
      : score >= 70
        ? "text-success"
        : score >= 40
          ? "text-warning"
          : "text-destructive";
  return (
    <div className="rounded-xl border border-border bg-card/60 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("dashboard.featured.title")}
          </div>
          <h2 className="mt-1 truncate text-xl font-semibold md:text-2xl">{caseRow.name}</h2>
          <div className="mt-1 text-xs text-muted-foreground">
            {caseRow.status_message ?? caseRow.status}
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-center">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t("dashboard.featured.score")}
            </div>
            {!isComplete ? (
              <div className="text-sm font-medium text-muted-foreground">
                {t("dashboard.featured.calculating")}
              </div>
            ) : (
              <>
                <div className={`text-4xl font-bold ${tone}`}>{score ?? t("common.dash")}</div>
                <div className="text-[10px] text-muted-foreground">/ 100</div>
              </>
            )}
          </div>
          <Link
            to="/cases/$caseId"
            params={{ caseId: caseRow.id }}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t("dashboard.featured.viewCase")} <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function useMemoFeatured() {
  return null as unknown as {
    id: string;
    name: string;
    status: string;
    status_message: string | null;
    score?: number | null;
  };
}

function timeAgo(
  iso: string | null,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  if (!iso) return t("common.dash");
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return t("dashboard.timeAgo.justNow");
  if (m < 60) return t("dashboard.timeAgo.minutes", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("dashboard.timeAgo.hours", { h });
  return t("dashboard.timeAgo.days", { d: Math.floor(h / 24) });
}
