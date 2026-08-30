import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { stopDrivingPipeline } from "@/lib/pipeline-driver";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CasePartiesPanel } from "@/components/casework/CasePartiesPanel";
import { CaseTasksPanel } from "@/components/casework/CaseTasksPanel";
import { CaseCalendarPanel } from "@/components/casework/CaseCalendarPanel";
import { CaseCommunicationsPanel } from "@/components/casework/CaseCommunicationsPanel";
import {
  getCase,
  getDocumentText,
  askCaseAi,
  getCaseChat,
  clearCaseChat,
  runExtractionStep,
  runAnalyzersStep,
  runAgentsStep,
  runTimelineStep,
  runScoringStep,
  runReportStep,
  runTheoryStep,
  runOpportunityStep,
  runDiscoveryGapStep,
  runWitnessStep,
  runTrialPrepStep,
  runWorkProductStep,
  runFullIntelligenceStep,
  runPerspectivesStep,
  runEvidenceIntelStep,
  runStrategyStep,
  runContradictionStep,
  runHallucinationReviewStep,
  updateCaseSettings,
  retryDocumentExtraction,
  rollbackDocumentExtraction,
  addEvidenceAndRerun,
  queueCaseForPipeline,
  sweepStalledCasesForMe,
  listReportVersions,
  logReportExport,
} from "@/lib/cases.functions";
import { StatusBadge } from "@/components/StatusBadge";
import { CaseActionsMenu } from "@/components/CaseActionsMenu";
import { AttorneyAssistancePanel } from "@/components/AttorneyAssistancePanel";
import { LivePipelinePanel } from "@/components/LivePipelinePanel";
import { CommandCenterDashboard } from "@/components/CommandCenterDashboard";
import { useI18n } from "@/i18n";
import { scoreBand } from "@/lib/score-bands";
import { MatterMetadataCard } from "@/components/MatterMetadataCard";
import { PipelinePanel } from "@/components/PipelinePanel";
import { CaseControlPanel } from "@/components/CaseControlPanel";
import { MultiAgentPanel } from "@/components/MultiAgentPanel";
import { ParityBadge } from "@/components/ParityBadge";
import { ClaimBadge } from "@/components/ClaimBadge";
import { CASE_TYPE_SELECT_OPTIONS } from "@/lib/intelligence/practice-areas";
import { MX_PARTY_ROLES, mxProfileOrNull, mxRoleLabel } from "@/lib/execution/mx-pipeline";
import {
  getCanonicalCounts,
  getContradictions,
  getDisputedIssues,
  getEssState,
  getFindings,
  getMissingEvidence,
  getMotions,
  getOpportunities,
  getStrategies,
  getTimeline,
  getWitnesses,
  getAgentSummary,
} from "@/lib/intelligence/canonical";

import { requestCancel, forceCancelCase } from "@/lib/cases.functions";
import { PerspectivesPanel, EvidenceIntelPanel, StrategyPanel } from "@/components/LitigationPanels";
import { ImageIntelligencePanel } from "@/components/ImageIntelligencePanel";
import {
  LitigationImpactDashboardSection,
  LitigationCommandCenterSection,
} from "@/components/LitigationImpactDashboard";
// NOTE: intentionally a type-only import. `@/lib/export` statically imports
// jsPDF (which transitively bundles html2canvas, a browser-only module) —
// importing it at the top of this route pulls that into the SSR module
// graph and crashes the server build. downloadPdf/downloadDocx/downloadJson
// are loaded dynamically at each call site below instead.
import type { CaseExportData } from "@/lib/export";

// Pure mapping from a raw getCase() response to CaseExportData. Extracted
// so it can be reused both for the page's live-render exportData (fed by
// the polled React Query cache) AND for a forced fresh fetch immediately
// before a download — see FIX (2026-08-02) at the download handlers below
// for why the second use exists.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildExportData(raw: any): CaseExportData {
  return {
    case: raw.case as unknown as Record<string, unknown>,
    documents: raw.documents as unknown as Record<string, unknown>[],
    analysis: raw.analysis as unknown as Record<string, unknown> | null,
    agents: raw.agents as unknown as Record<string, unknown>[],
    score: raw.score as unknown as Record<string, unknown> | null,
    report: raw.report as unknown as Record<string, unknown> | null,
    findings: raw.findings as unknown as Record<string, unknown>[],
    theories: raw.theories as unknown as Record<string, unknown>[],
    opportunities: raw.opportunities as unknown as Record<string, unknown>[],
    witnesses: raw.witnesses as unknown as Record<string, unknown>[],
    trial_prep: raw.trial_prep as unknown as Record<string, unknown> | null,
    work_product: raw.work_product as unknown as Record<string, unknown>[],
    perspectives: (raw.perspectives ?? []) as unknown as Record<string, unknown>[],
    evidence_intel: (raw.evidence_intel ?? []) as unknown as Record<string, unknown>[],
    strategy: (raw.strategy ?? []) as unknown as Record<string, unknown>[],
    strategy_center: (raw.strategy_center ?? null) as unknown as Record<string, unknown> | null,
    agent_logs: (raw.agent_logs ?? []) as unknown as Record<string, unknown>[],
    outcome_assessment: (raw.outcome_assessment ?? null) as unknown as Record<
      string,
      unknown
    > | null,
  };
}
import { getApplicableTabs } from "@/lib/intelligence/practice-areas";
import {
  ArrowLeft,
  FileText,
  Play,
  FileDown,
  File as FileJson,
  FileType,
  CircleCheck as CheckCircle2,
  Circle,
  Loader as Loader2,
  CircleAlert as AlertCircle,
  Send,
  MessageSquare,
  Gavel,
  Scale,
  Search,
  Users,
  Sparkles,
  ShieldAlert,
  ShieldCheck,
  BookOpen,
  Activity,
  Trash2,
  RotateCcw,
  Undo2,
  Building2,
  ListChecks,
  CalendarDays,
  Mail,
  ChevronDown,
} from "lucide-react";
import { TransactionCenterPanel } from "@/components/TransactionCenterPanel";
import { useTranslatedTexts } from "@/hooks/useTranslatedTexts";

export const Route = createFileRoute("/_authenticated/cases/$caseId")({
  head: () => ({ meta: [{ title: "Case workspace — Nyrava" }] }),
  component: Workspace,
});

type Tab =
  | "dashboard"
  | "intel"
  | "findings"
  | "strategic"
  | "attack"
  | "analyzers"
  | "agents"
  | "perspectives"
  | "evidence"
  | "strategy"
  | "theories"
  | "opportunities"
  | "witnesses"
  | "trial"
  | "work"
  | "scorecard"
  | "chat"
  | "report"
  | "transaction_center"
  // Core platform capabilities — present on every materia.
  | "parties"
  | "tasks"
  | "calendar"
  | "communications";

const RUNNING_STATUSES = new Set([
  "queued",
  "running",
  "extracting",
  "analyzing",
  "agents_running",
  "ocr",
  "scoring",
  "reporting",
  "generating_report",
  "intelligence_running",
]);

type CaseStepFn = (a: { data: { caseId: string } }) => Promise<unknown>;

function useCaseStep(fn: CaseStepFn, label: string, caseId: string, invalidate: () => void) {
  const runStep = useServerFn(fn);
  return useMutation({
    mutationFn: () => runStep({ data: { caseId } }),
    onMutate: () => toast.info(`${label} started…`),
    onSuccess: () => {
      toast.success(`${label} complete`);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : `${label} failed`),
  });
}

const VALID_TABS = new Set<Tab>([
  "dashboard",
  "intel",
  "findings",
  "strategic",
  "attack",
  "analyzers",
  "agents",
  "perspectives",
  "evidence",
  "strategy",
  "theories",
  "opportunities",
  "witnesses",
  "trial",
  "work",
  "scorecard",
  "chat",
  "report",
  "transaction_center",
]);

function Workspace() {
  const { t } = useI18n();
  const { caseId } = Route.useParams();
  const qc = useQueryClient();

  const [showPipelineDetail, setShowPipelineDetail] = useState(false);

  const [tab, setTab] = useState<Tab>(() => {
    // One-shot handoff from Talk To Cases: after pushing a chat answer into
    // the report, it stashes the tab to land on (e.g. "report") here rather
    // than passing it through React state, since that push happens on a
    // different route/mounted component entirely.
    if (typeof window === "undefined") return "dashboard";
    try {
      const key = `nyrava:open-tab:${caseId}`;
      const pending = window.sessionStorage.getItem(key);
      if (pending) {
        window.sessionStorage.removeItem(key);
        if (VALID_TABS.has(pending as Tab)) return pending as Tab;
      }
    } catch {
      /* ignore — sessionStorage unavailable (private browsing, etc.) */
    }
    return "dashboard";
  });
  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent).detail;
      if (typeof target === "string") setTab(target as Tab);
    };
    window.addEventListener("nyrava:set-tab", handler as EventListener);
    return () => window.removeEventListener("nyrava:set-tab", handler as EventListener);
  }, []);
  const fetchCase = useServerFn(getCase);
  const sweepStalled = useServerFn(sweepStalledCasesForMe);
  // On mount, flip any case whose worker died between cron ticks from
  // "running" (stuck spinner) to "failed — click Resume" so the user sees
  // the real state immediately instead of waiting on the next cron tick.
  useEffect(() => {
    sweepStalled({ data: { caseId } })
      .then((r) => {
        if (r?.swept) qc.invalidateQueries({ queryKey: ["case", caseId] });
      })
      .catch((e) => console.warn("[stall-sweep] mount call failed", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const { data, isLoading } = useQuery({
    queryKey: ["case", caseId],
    queryFn: () => fetchCase({ data: { caseId } }),
    refetchInterval: (q) => {
      const s = q.state.data?.case?.status;
      return s && RUNNING_STATUSES.has(s) ? 2000 : false;
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["case", caseId] });

  // Strategy panel still allows the user to pick a perspective (defense / prosecution / etc.)
  // — that's not per-engine execution, it's choosing the lens for the already-run strategy engine.
  const runStrategy = useServerFn(runStrategyStep);
  const strategyM = useMutation({
    mutationFn: (perspective: string) =>
      runStrategy({
        data: {
          caseId,
          perspective: perspective as
            | "defense"
            | "prosecution"
            | "plaintiff"
            | "respondent"
            | "appellate"
            | "jury"
            | "independent",
        },
      }),
    onMutate: () => toast.info("Strategy synthesis started…"),
    onSuccess: () => {
      toast.success("Strategy complete");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Strategy failed"),
  });

  if (isLoading) return <div className="p-10 text-muted-foreground">Loading…</div>;
  if (!data?.case) return <div className="p-10">Case not found.</div>;

  const c = data.case;
  const docs = data.documents;
  const analysis = data.analysis;
  const agents = data.agents;
  const score = data.score;
  const report = data.report;
  const pipelineRuns = data.pipeline_runs ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentLogs = (data as any).agent_logs ?? [];
  const findings = data.findings;
  const theories = data.theories;
  const opportunities = data.opportunities;
  const witnesses = data.witnesses;
  const trialPrep = data.trial_prep;
  const workProduct = data.work_product;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perspectives = (data as any).perspectives ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evidenceIntel = (data as any).evidence_intel ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strategy = (data as any).strategy ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strategyCenter = (data as any).strategy_center ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attackSurface = (c as any)?.attack_surface ?? null;

  const hasReport = !!c.report_at || !!report;
  const running = !!c.status && RUNNING_STATUSES.has(c.status);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reportBlocked = Boolean((report as any)?.quality_blocked);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reportBlockReasons = (((report as any)?.quality_block_reasons as unknown[]) ?? []) as string[];
  // Non-blocking readiness score from report-quality-gate.ts — computed and
  // persisted for every report since it was built, but never actually shown
  // to an attorney until now (see the pipeline.server.ts comment at its
  // pipelineWarnings push site for why it's informational, not blocking).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qualityGate = (report as any)?.full_report?.quality_gate as
    | { score?: number; passed?: boolean; critical_issues?: string[] }
    | undefined;

  const exportData: CaseExportData = buildExportData(data);

  // FIX (2026-08-02): downloads previously used this same `exportData`
  // object, which is only as fresh as the page's last React Query poll.
  // Polling stops entirely once case.status leaves the "running" set
  // (see refetchInterval above), so a download triggered right as a run
  // finishes — or from a tab that's been sitting open — could bake a
  // stale pre-completion snapshot into the PDF/DOCX/JSON: e.g. a report
  // the backend had already finalized as report_mode "FULL" with real
  // scores could still export showing "LIMITADO" with scores suppressed,
  // because the browser simply hadn't re-fetched since an earlier,
  // genuinely-Limited intermediate state. Confirmed against a real case
  // where the reports row (report_mode, scores_suppressed, ESS override)
  // was unambiguously FULL/unsuppressed at the DB level, yet the
  // downloaded PDF still rendered Limited. Forcing one fresh fetch
  // immediately before building the export payload closes that gap
  // regardless of polling timing, without needing to change polling
  // behavior itself. Falls back to the already-rendered exportData if the
  // refetch fails, so a transient network hiccup can't block a download
  // that would otherwise have worked.
  const buildFreshExportData = async (): Promise<CaseExportData> => {
    try {
      const fresh = await fetchCase({ data: { caseId } });
      qc.setQueryData(["case", caseId], fresh);
      return buildExportData(fresh);
    } catch (e) {
      console.warn("[export] fresh refetch before download failed — using last-rendered data", e);
      return exportData;
    }
  };

  // Badge counts for tabs whose underlying data isn't a flat array — mirrors
  // the pattern Attack Surface already used (count populated categories, not
  // raw items) rather than leaving these tabs with no `count` key at all,
  // which silently suppressed their badges regardless of how much content
  // was actually inside. Every count below reads real case data; none is
  // hardcoded or special-cased to a particular case.
  const analyzersData = analysis as unknown as Record<string, unknown> | null;
  const analyzersCount = analyzersData
    ? (
        [
          "timeline",
          "contradictions",
          "missing_evidence",
          "procedural_issues",
          "evidence_relationships",
          "key_findings",
        ] as const
      ).filter((k) => {
        const v = analyzersData[k];
        return Array.isArray(v) ? v.length > 0 : !!v;
      }).length
    : 0;

  const trialPrepData = trialPrep as unknown as Record<string, unknown> | null;
  const trialPrepCount = trialPrepData
    ? (
        [
          "opening_themes",
          "closing_themes",
          "trial_strengths",
          "trial_risks",
          "jury_concerns",
          "most_persuasive_evidence",
          "most_damaging_evidence",
          "witness_order",
          "exhibit_order",
          "likely_objections",
        ] as const
      ).filter((k) => Array.isArray(trialPrepData[k]) && (trialPrepData[k] as unknown[]).length > 0).length
    : 0;

  const scorecardData = score as unknown as Record<string, unknown> | null;
  const scorecardCount = scorecardData
    ? Object.keys((scorecardData.dimension_breakdowns as Record<string, unknown> | null) ?? {}).length
    : 0;

  // Report tab: how many distinct content categories the finished report
  // actually populated (findings, contradictions, motions, citations, etc.)
  // — reuses the same canonical counter the Report tab itself renders from,
  // so this badge can never drift out of parity with what's on the page.
  const reportCount = report ? Object.values(getCanonicalCounts(report)).filter((v) => v > 0).length : 0;

  const tabs: {
    k: Tab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count?: number;
  }[] = [
    { k: "dashboard", label: t("caseTab.dashboard"), icon: Activity },
    {
      k: "perspectives",
      label: t("caseTab.perspectives"),
      icon: Scale,
      count: perspectives.length,
    },
    {
      k: "strategic",
      label: t("caseTab.strategic"),
      icon: Sparkles,
      // Must match StrategicFindingsTab's own filter (priority <= 3 — P1
      // Case-Dispositive through P3 Credibility) or a case with only P3
      // findings shows real content in the tab with no badge to signal it.
      count: findings.filter((f: any) => (f.priority ?? 4) <= 3).length,
    },
    {
      k: "attack",
      label: t("caseTab.attack"),
      icon: ShieldAlert,
      count: attackSurface
        ? Object.values(attackSurface).filter((v) => Array.isArray(v) && (v as unknown[]).length > 0).length
        : 0,
    },
    { k: "evidence", label: t("caseTab.evidence"), icon: ShieldAlert, count: evidenceIntel.length },
    { k: "strategy", label: t("caseTab.strategy"), icon: Gavel, count: strategy.length },
    { k: "findings", label: t("caseTab.findings"), icon: Sparkles, count: findings.length },
    { k: "intel", label: t("caseTab.documents"), icon: FileText, count: docs.length },
    { k: "analyzers", label: t("caseTab.analyzers"), icon: Search, count: analyzersCount },
    {
      k: "agents",
      label: t("caseTab.agents"),
      icon: ShieldAlert,
      count: getAgentSummary(report).executed || agents.length,
    },
    { k: "theories", label: t("caseTab.theories"), icon: Scale, count: theories.length },
    {
      k: "opportunities",
      label: t("caseTab.opportunities"),
      icon: Gavel,
      count: opportunities.length,
    },
    { k: "witnesses", label: t("caseTab.witnesses"), icon: Users, count: witnesses.length },
    { k: "trial", label: t("caseTab.trial"), icon: ShieldCheck, count: trialPrepCount },
    { k: "work", label: t("caseTab.work"), icon: BookOpen, count: workProduct.length },
    { k: "scorecard", label: t("caseTab.scorecard"), icon: Activity, count: scorecardCount },
    { k: "transaction_center", label: "Centro de Transacción", icon: Building2 },
    // Core capabilities — the registry keeps these visible for every materia.
    { k: "parties", label: t("caseTab.parties"), icon: Users },
    { k: "tasks", label: t("caseTab.tasks"), icon: ListChecks },
    { k: "calendar", label: t("caseTab.calendar"), icon: CalendarDays },
    { k: "communications", label: t("caseTab.communications"), icon: Mail },
    { k: "chat", label: t("caseTab.chat"), icon: MessageSquare },
    { k: "report", label: t("caseTab.report"), icon: FileText, count: reportCount },
  ];

  // Practice Area Isolation: hide workspace tabs that don't belong to
  // this case's legal framework. Cross-domain activations widen the set.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _area = ((c as any)?.case_type as string) || "general_civil";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _additional = Array.isArray((c as any)?.additional_domains) ? ((c as any).additional_domains as string[]) : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _vehicle = ((c as any)?.procedural_vehicle as string) || null;
  const _allowed = getApplicableTabs(_area, _additional, _vehicle);
  const _filteredTabs = tabs.filter((tab) => _allowed.has(tab.k));

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <Link
        to="/cases"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("caseWorkspace.allCases")}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{c.name}</h1>
          {c.description && <p className="mt-1 text-sm text-muted-foreground">{c.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={c.status} progress={c.progress} />
          <CaseActionsMenu
            caseId={c.id}
            name={c.name}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            archived={!!(c as any).archived_at}
            running={running}
            navigateAfterDelete
          />
        </div>
      </div>

      {(running || c.status === "failed" || c.status === "cancelled" || (c.status === "complete" && c.error)) && (
        <div
          className={`mt-4 rounded-xl border p-4 ${c.status === "failed" ? "border-destructive/40 bg-destructive/5" : c.status === "cancelled" ? "border-border bg-muted/40" : c.status === "complete" ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-card"}`}
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            {c.status === "failed" ? (
              <AlertCircle className="h-4 w-4 text-destructive" />
            ) : c.status === "cancelled" ? (
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
            ) : c.status === "complete" ? (
              <AlertCircle className="h-4 w-4 text-amber-500" />
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
            )}
            <span className="flex-1">{c.status_message ?? t(`cases.status.${c.status}`)}</span>
            {running && <InlineCancelButton caseId={c.id} invalidate={invalidate} />}
          </div>
          {running && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full bg-accent transition-all" style={{ width: `${c.progress}%` }} />
            </div>
          )}
          {c.error && <div className="mt-2 text-xs text-destructive">{c.error}</div>}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-6">
          <CaseControlPanel
            caseId={c.id}
            caseStatus={c.status}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            caseType={(c as any).case_type ?? null}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            proceduralVehicle={(c as any).procedural_vehicle ?? null}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            underlyingMateria={(c as any).underlying_materia ?? null}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            analysisMode={(c as any).analysis_mode ?? "balanced"}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            jurisdiction={(c as any).jurisdiction ?? null}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            caseAnalysisMode={(c as any).case_analysis_mode ?? "ongoing"}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            matterMetadata={(c as any).matter_metadata ?? null}
            documentsCount={docs.length}
            invalidate={invalidate}
          />

          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <MatterMetadataCard metadata={(c as any).matter_metadata ?? null} />

          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("caseWorkspace.downloads")}
            </h2>
            <div className="mt-3 space-y-2">
              <DownloadBtn
                icon={FileDown}
                label={t("caseWorkspace.downloadPdf")}
                disabled={reportBlocked || !hasReport}
                onClick={async () => {
                  const { downloadPdf } = await import("@/lib/export");
                  downloadPdf(await buildFreshExportData(), c.name);
                  void logReportExport({
                    data: { caseId: c.id, format: "pdf", caseName: c.name },
                  }).catch(() => {});
                }}
              />
              <DownloadBtn
                icon={FileType}
                label={t("caseWorkspace.downloadDocx")}
                disabled={reportBlocked || !hasReport}
                onClick={async () => {
                  const { downloadDocx } = await import("@/lib/export");
                  downloadDocx(await buildFreshExportData(), c.name).catch((e) => toast.error(e?.message ?? "DOCX failed"));
                  void logReportExport({
                    data: { caseId: c.id, format: "docx", caseName: c.name },
                  }).catch(() => {});
                }}
              />
              <DownloadBtn
                icon={FileJson}
                label={t("caseWorkspace.downloadJson")}
                disabled={false}
                onClick={async () => {
                  const { downloadJson } = await import("@/lib/export");
                  downloadJson(await buildFreshExportData(), c.name);
                  void logReportExport({
                    data: { caseId: c.id, format: "json", caseName: c.name },
                  }).catch(() => {});
                }}
              />
            </div>
            {reportBlocked && (
              <div className="mt-3 rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                <div className="font-semibold">{t("caseWorkspace.reportBlocked")}</div>
                {reportBlockReasons.length > 0 && (
                  <ul className="mt-1 list-disc pl-4">
                    {reportBlockReasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 opacity-80">{t("caseWorkspace.reportBlocked.json")}</p>
              </div>
            )}
            {hasReport && qualityGate && typeof qualityGate.score === "number" && (
              <div
                className={`mt-3 rounded border px-3 py-2 text-xs ${
                  qualityGate.passed
                    ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-300"
                    : "border-amber-500/40 bg-amber-500/5 text-amber-300"
                }`}
              >
                <div className="font-semibold">
                  {t("caseWorkspace.qualityGate.label")}: {qualityGate.score}/100
                </div>
                {!qualityGate.passed && (
                  <>
                    <p className="mt-1 opacity-80">{t("caseWorkspace.qualityGate.notPassed")}</p>
                    {(qualityGate.critical_issues?.length ?? 0) > 0 && (
                      <ul className="mt-1 list-disc pl-4">
                        {qualityGate.critical_issues!.map((issue, i) => (
                          <li key={i}>{issue}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
            {!reportBlocked && !hasReport && (
              <p className="mt-2 text-xs text-muted-foreground">{t("caseWorkspace.noReportHint")}</p>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("caseWorkspace.timestamps")}
            </h2>
            <dl className="mt-3 space-y-1.5 text-xs">
              <Stamp label={t("caseWorkspace.ts.created")} v={c.created_at} />
              <Stamp label={t("caseWorkspace.ts.extracted")} v={c.extracted_at} />
              <Stamp label={t("caseWorkspace.ts.analyzed")} v={c.analysis_at} />
              <Stamp label={t("caseWorkspace.ts.agents")} v={c.agents_at} />
              <Stamp label={t("caseWorkspace.ts.scored")} v={c.scored_at} />
              <Stamp label={t("caseWorkspace.ts.theories")} v={c.theories_at} />
              <Stamp label={t("caseWorkspace.ts.opportunities")} v={c.opportunities_at} />
              <Stamp label={t("caseWorkspace.ts.trialPrep")} v={c.trial_prep_at} />
              <Stamp label={t("caseWorkspace.ts.reported")} v={c.report_at} />
            </dl>
          </div>

          <AttorneyAssistancePanel
            caseId={c.id}
            running={running}
            timestamps={{
              extracted_at: c.extracted_at,
              analysis_at: c.analysis_at,
              agents_at: c.agents_at,
              scored_at: c.scored_at,
              theories_at: c.theories_at,
              opportunities_at: c.opportunities_at,
              trial_prep_at: c.trial_prep_at,
              report_at: c.report_at,
            }}
            hasReport={hasReport}
            reportBlocked={reportBlocked}
            onDownloadPdf={async () => {
              const { downloadPdf } = await import("@/lib/export");
              downloadPdf(await buildFreshExportData(), c.name);
              void logReportExport({
                data: { caseId: c.id, format: "pdf", caseName: c.name },
              }).catch(() => {});
            }}
            onDownloadDocx={async () => {
              const { downloadDocx } = await import("@/lib/export");
              downloadDocx(await buildFreshExportData(), c.name).catch((e) => toast.error(e?.message ?? "DOCX failed"));
              void logReportExport({
                data: { caseId: c.id, format: "docx", caseName: c.name },
              }).catch(() => {});
            }}
            onOpenTab={(t) => setTab(t as Tab)}
          />
        </aside>

        <section className="min-w-0">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {_filteredTabs.map((t) => {
              const Icon = t.icon;
              const active = tab === t.k;
              return (
                <button
                  key={t.k}
                  onClick={() => setTab(t.k)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  {t.count != null && t.count > 0 && (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                        active ? "bg-primary/20" : "bg-secondary"
                      }`}
                    >
                      {t.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-6">
            {tab === "dashboard" && (
              <>
                <CommandCenterDashboard
                  caseId={c.id}
                  caseName={c.name}
                  status={c.status}
                  progress={c.progress}
                  documentsCount={docs.length}
                  report={report as unknown as Parameters<typeof getCanonicalCounts>[0]}
                  caseRow={c as unknown as Record<string, unknown>}
                  score={score}
                  findingsCount={findings.length}
                  witnessesCount={witnesses.length}
                  evidenceCount={evidenceIntel.length}
                  opportunitiesCount={opportunities.length}
                  onOpenTab={(k) => setTab(k as Tab)}
                  onOpenChat={() => setTab("chat")}
                  invalidate={invalidate}
                />
                {/* Collapsed by default: CommandCenterDashboard above already
                    surfaces per-engine status, so the full stage-by-stage
                    breakdown (with Resume/Clear-stuck recovery actions) is
                    opt-in here instead of a second always-visible block. */}
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setShowPipelineDetail((v) => !v)}
                    className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-card/40 px-4 py-2.5 text-xs font-medium text-foreground/80 hover:bg-card/60"
                  >
                    {showPipelineDetail ? t("pipeline.panel.hideDetail") : t("pipeline.panel.showDetail")}
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showPipelineDetail ? "rotate-180" : ""}`} />
                  </button>
                  {showPipelineDetail && (
                    <div className="mt-3">
                      <PipelinePanel
                        caseId={c.id}
                        caseStatus={c.status}
                        caseRow={c as unknown as Record<string, unknown>}
                      />
                    </div>
                  )}
                </div>
                {/* PipelineStatusGrid + CaseEngineStatus removed — CommandCenterDashboard + PipelinePanel already surface stage state via useCaseExecution. */}
                <div className="mt-4">
                  <MultiAgentPanel caseId={c.id} report={report} />
                </div>
                <div className="mt-4">
                  <DashboardTab
                    findings={findings}
                    score={score}
                    trialPrep={trialPrep}
                    opportunities={opportunities}
                    theories={theories}
                    witnesses={witnesses}
                  />
                </div>
              </>
            )}

            {tab === "findings" && (
              <FindingsTab
                findings={findings}
                sourceLocale={(c as { report_language?: string | null }).report_language === "en" ? "en" : "es"}
              />
            )}
            {tab === "strategic" && <StrategicFindingsTab findings={findings} />}
            {tab === "attack" && <AttackSurfaceTab surface={attackSurface} />}
            {tab === "intel" && <IntelTab docs={docs} caseId={c.id} invalidate={invalidate} />}
            {tab === "analyzers" && <AnalyzersTab a={analysis} />}
            {tab === "agents" && <AgentsTab agents={agents} />}
            {tab === "perspectives" && (
              <PerspectivesPanel
                perspectives={perspectives}
                ranAt={(c as { perspectives_at?: string | null }).perspectives_at}
              />
            )}
            {tab === "evidence" && (
              <>
                <ImageIntelligencePanel
                  caseId={c.id}
                  documents={docs.map((d) => ({ id: d.id, filename: d.filename }))}
                />
                <EvidenceIntelPanel
                  evidence={evidenceIntel}
                  documents={docs.map((d) => ({ id: d.id, filename: d.filename }))}
                  ranAt={(c as { evidence_intel_at?: string | null }).evidence_intel_at}
                />
              </>
            )}
            {tab === "strategy" && (
              <StrategyPanel strategy={strategy} running={strategyM.isPending} onRun={(p) => strategyM.mutate(p)} />
            )}
            {tab === "theories" && <TheoriesTab theories={theories} />}
            {tab === "opportunities" && <OpportunitiesTab opps={opportunities} ranAt={c.opportunities_at} />}
            {tab === "witnesses" && <WitnessesTab witnesses={witnesses} ranAt={c.witnesses_at} />}
            {tab === "trial" && <TrialPrepTab t={trialPrep} ranAt={c.trial_prep_at} />}
            {tab === "work" && <WorkProductTab docs={workProduct} />}
            {tab === "scorecard" && <ScorecardTab s={score as unknown as Score | null} />}
            {tab === "transaction_center" && <TransactionCenterPanel caseId={c.id} />}
            {tab === "parties" && <CasePartiesPanel caseId={c.id} />}
            {tab === "tasks" && <CaseTasksPanel caseId={c.id} />}
            {tab === "calendar" && <CaseCalendarPanel caseId={c.id} />}
            {tab === "communications" && <CaseCommunicationsPanel caseId={c.id} />}
            {tab === "chat" && <ChatTab caseId={caseId} />}
            {tab === "report" && (
              <ReportTab
                r={report as unknown as Report | null}
                documents={docs.map((d) => ({ id: d.id, filename: d.filename }))}
              />
            )}
          </div>
        </section>
      </div>
      <LivePipelinePanel caseId={c.id} isProcessing={running} caseType={(c as any).case_type ?? null} />
    </div>
  );
}

// ============== SIDEBAR ==============

function PipelineCard({
  title,
  steps,
  running,
  footer,
}: {
  title: string;
  steps: {
    key: string;
    label: string;
    done: boolean;
    pending: boolean;
    failed?: boolean;
    error?: string | null;
    m: { mutate: () => void; isPending: boolean };
    disabled?: boolean;
  }[];
  running: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <ol className="mt-3 space-y-2">
        {steps.map((s, i) => {
          const state = s.pending
            ? "running"
            : s.failed
              ? "failed"
              : s.done
                ? "completed"
                : s.disabled
                  ? "pending"
                  : "ready";
          const stateLabel =
            state === "running"
              ? "Running"
              : state === "failed"
                ? "Failed — click to retry"
                : state === "completed"
                  ? "Completed"
                  : state === "pending"
                    ? "Awaiting previous step"
                    : "Ready";
          return (
            <li key={s.key}>
              <button
                onClick={() => s.m.mutate()}
                disabled={s.disabled || s.pending || s.done || (running && !s.failed)}
                className={`group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  state === "failed"
                    ? "border-destructive/40 bg-destructive/5 hover:bg-destructive/10"
                    : state === "completed"
                      ? "border-success/40 bg-success/5 hover:bg-success/10"
                      : state === "running"
                        ? "border-accent/40 bg-accent/5"
                        : "border-border bg-background hover:bg-secondary"
                }`}
              >
                <span className="shrink-0">
                  {state === "running" ? (
                    <Loader2 className="h-4 w-4 animate-spin text-accent" />
                  ) : state === "failed" ? (
                    <AlertCircle className="h-4 w-4 text-destructive" />
                  ) : state === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 text-success" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground" />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-medium">
                    {i + 1}. {s.label}
                  </span>
                  <span className="block text-xs text-muted-foreground truncate">{s.error ?? stateLabel}</span>
                </span>
                {state !== "completed" && (
                  <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                )}
              </button>
            </li>
          );
        })}
      </ol>
      {footer}
    </div>
  );
}

function CaseSettingsCard({
  caseId,
  caseType,
  analysisMode,
  running,
  invalidate,
}: {
  caseId: string;
  caseType: string | null;
  analysisMode: string;
  running: boolean;
  invalidate: () => void;
}) {
  const updateFn = useServerFn(updateCaseSettings);
  // "" (not a stale English default like "general_civil") means the case
  // carries no recognized Mexican materia yet — CASE_TYPE_SELECT_OPTIONS
  // only lists the 13 real materias, so any other fallback value would not
  // match an <option>, leaving the browser to silently highlight whichever
  // option happens to be first (Penal) while state stays out of sync.
  const [ct, setCt] = useState<string>(caseType ?? "");
  const [mode, setMode] = useState<string>(analysisMode || "balanced");
  useEffect(() => {
    setCt(caseType ?? "");
    setMode(analysisMode || "balanced");
  }, [caseType, analysisMode]);

  const m = useMutation({
    mutationFn: (patch: { case_type?: string; analysis_mode?: string }) =>
      updateFn({
        data: {
          caseId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(patch as any),
        },
      }),
    onSuccess: (result) => {
      // A case_type (materia) change now clears every derived analysis —
      // findings/report/agents from the OLD materia are no longer valid, not
      // just stale — so this needs a distinctly stronger message than the
      // generic "re-run to apply" mode-change wording.
      if (result?.caseTypeChanged) {
        toast.success("Case type updated — prior analysis was cleared. Re-run engines to generate a fresh report.");
      } else {
        toast.success("Case settings updated. Re-run engines to apply.");
      }
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to update settings"),
  });

  const dirty = ct !== (caseType ?? "") || mode !== (analysisMode || "balanced");
  const disabled = running || m.isPending;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Case Settings</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Editable after upload. Re-run engines to apply changes to existing findings.
      </p>

      <div className="mt-3 space-y-1.5">
        <label className="text-xs font-medium text-foreground/80">Case type</label>
        <select
          value={ct}
          onChange={(e) => setCt(e.target.value)}
          disabled={disabled}
          className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm disabled:opacity-50"
        >
          {!ct && (
            <option value="" disabled>
              Unclassified — select the practice area
            </option>
          )}
          {CASE_TYPE_SELECT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 space-y-1.5">
        <label className="text-xs font-medium text-foreground/80">Analysis mode</label>
        <div className="grid gap-1.5">
          {[
            { v: "strict", label: "Strict Evidence", desc: "Only direct evidence." },
            { v: "balanced", label: "Balanced", desc: "Direct + evidence-based inferences." },
            { v: "exploratory", label: "Exploratory", desc: "Includes AI theories, labeled." },
          ].map((opt) => (
            <button
              key={opt.v}
              type="button"
              disabled={disabled}
              onClick={() => setMode(opt.v)}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
                mode === opt.v ? "border-accent bg-accent/10" : "border-border bg-background hover:bg-secondary"
              }`}
            >
              <div className="font-medium">{opt.label}</div>
              <div className="text-xs text-muted-foreground">{opt.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => m.mutate({ case_type: ct, analysis_mode: mode })}
        disabled={disabled || !dirty || !ct}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
      >
        {m.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {dirty ? "Save settings" : "Saved"}
      </button>
    </div>
  );
}

function DownloadBtn({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}

function Stamp({ label, v }: { label: string; v: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{v ? new Date(v).toLocaleString() : "—"}</dd>
    </div>
  );
}

// ============== TABS ==============

type Finding = {
  id: string;
  category: string;
  severity: string;
  confidence: number;
  title: string;
  description: string;
  source_module: string;
  legal_significance: string | null;
  potential_impact: string | null;
  affected_party: string | null;
  tags: string[] | null;
};

type TrialPrepSummary = {
  jury_conviction_pct: number | null;
  jury_acquittal_pct: number | null;
  jury_appeal_pct: number | null;
  jury_settlement_pct: number | null;
};
type ScoreSummary = {
  overall_confidence: number | null;
  case_quality: number | null;
  conviction_risk: number | null;
  evidence_strength: number | null;
};
type OpportunitySummary = { side: string | null };
type TheorySummary = {
  id: string;
  theory_type: string | null;
  narrative: string | null;
  confidence: number | null;
  risk: string | null;
};

function sevRank(s: string): number {
  return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[s] ?? 1;
}
function sevColor(s: string): string {
  return (
    {
      critical: "bg-destructive/15 text-destructive border-destructive/40",
      high: "bg-destructive/10 text-destructive border-destructive/30",
      medium: "bg-warning/15 text-warning border-warning/30",
      low: "bg-secondary text-muted-foreground border-border",
      info: "bg-accent/10 text-accent border-accent/20",
    }[s] ?? "bg-secondary text-muted-foreground border-border"
  );
}

function DashboardTab({
  findings,
  score,
  trialPrep,
  opportunities,
  theories,
  witnesses,
}: {
  findings: Finding[];
  score: ScoreSummary | null | undefined;
  trialPrep: TrialPrepSummary | null | undefined;
  opportunities: OpportunitySummary[];
  theories: TheorySummary[];
  witnesses: unknown[];
}) {
  const { t } = useI18n();
  const sorted = [...findings].sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.confidence - a.confidence);
  const top = sorted.slice(0, 5);
  const risks = sorted.filter((f) => f.severity === "critical" || f.severity === "high").slice(0, 8);
  const strengths = findings
    .filter((f) => f.affected_party === "defense" && (f.category === "strength" || f.category === "opportunity"))
    .slice(0, 5);
  const weak = findings.filter((f) => f.category === "missing_evidence" || f.category === "discovery_gap").slice(0, 8);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t("dash.tile.totalFindings")} value={findings.length} />
        <StatTile
          label={t("dash.tile.criticalHigh")}
          value={findings.filter((f) => sevRank(f.severity) >= 3).length}
          accent="destructive"
        />
        <StatTile label={t("dash.tile.witnesses")} value={witnesses.length} />
        <StatTile
          label={t("dash.tile.defenseOpportunities")}
          value={opportunities.filter((o) => o.side === "defense").length}
          accent="success"
        />
      </div>

      {score &&
        (() => {
          const dbRaw = (score as { dimension_breakdowns?: Record<string, unknown> }).dimension_breakdowns ?? {};
          const ct =
            typeof (dbRaw as { case_type?: unknown }).case_type === "string"
              ? (dbRaw as { case_type: string }).case_type
              : "general_civil";
          const isCrim = ct === "penal" || ct === "criminal" || ct === "civil_rights";
          return (
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold">{t("dash.caseHealth")}</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <BigMetric label={t("dash.metric.overallConfidence")} v={score.overall_confidence} />
                <BigMetric label={t("dash.metric.caseQuality")} v={score.case_quality} />
                {isCrim ? (
                  <BigMetric label={t("dash.metric.convictionRisk")} v={score.conviction_risk} inverse />
                ) : (
                  <BigMetric
                    label={t("dash.metric.litigationRisk")}
                    v={(score as Record<string, unknown>).litigation_risk as number | null}
                    inverse
                  />
                )}
              </div>
            </div>
          );
        })()}

      {score &&
        (() => {
          // Item 3 — granular evidentiary metrics, explicitly separated
          // rather than blended under one generic term. Evidence Strength
          // and Confidence already exist as their own case_scores columns;
          // Corroboration Level didn't exist as a case-level number before
          // this — computed here as the average of each witness's own
          // corroboration score (case_witnesses.corroboration, already
          // produced by the witness profiling engine), which is the real
          // signal for "how much do independent sources back each other up"
          // rather than inventing a new number with nothing behind it.
          const witnessCorrobs = (witnesses as Array<{ corroboration?: number | null }>)
            .map((w) => w.corroboration)
            .filter((v): v is number => typeof v === "number");
          const corroborationLevel =
            witnessCorrobs.length > 0
              ? Math.round(witnessCorrobs.reduce((a, b) => a + b, 0) / witnessCorrobs.length)
              : null;
          if (score.evidence_strength == null && corroborationLevel == null && score.overall_confidence == null) {
            return null;
          }
          return (
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold">{t("dash.evidentiaryMetrics")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t("dash.evidentiaryMetrics.subtitle")}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <BigMetric label={t("dash.metric.evidenceStrength")} v={score.evidence_strength} />
                <BigMetric label={t("dash.metric.corroborationLevel")} v={corroborationLevel} />
                <BigMetric label={t("dash.metric.confidence")} v={score.overall_confidence} />
              </div>
              {witnessCorrobs.length === 0 && (
                <p className="mt-2 text-[11px] text-muted-foreground">{t("dash.metric.corroborationLevel.noData")}</p>
              )}
            </div>
          );
        })()}

      {trialPrep &&
        (() => {
          const dbRaw2 =
            (score as { dimension_breakdowns?: Record<string, unknown> } | null)?.dimension_breakdowns ?? {};
          const ct2 =
            typeof (dbRaw2 as { case_type?: unknown }).case_type === "string"
              ? (dbRaw2 as { case_type: string }).case_type
              : (((trialPrep as Record<string, unknown>).case_type as string | undefined) ?? "general_civil");
          const isCrim2 = ct2 === "penal" || ct2 === "criminal" || ct2 === "civil_rights";
          const cm = ((trialPrep as Record<string, unknown>).civil_metrics ?? {}) as Record<string, number | null>;
          const pm = ((trialPrep as Record<string, unknown>).penal_metrics ?? {}) as Record<string, number | null>;
          return (
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold">{isCrim2 ? t("dash.outcome.penal") : t("dash.outcome")}</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-4">
                {isCrim2 ? (
                  <>
                    <BigMetric label={t("dash.metric.vinculacion")} v={pm.vinculacion_proceso_pct ?? null} />
                    <BigMetric
                      label={t("dash.metric.condenatoria")}
                      v={pm.sentencia_condenatoria_pct ?? trialPrep.jury_conviction_pct}
                    />
                    <BigMetric
                      label={t("dash.metric.absolutoria")}
                      v={pm.sentencia_absolutoria_pct ?? trialPrep.jury_acquittal_pct}
                    />
                    <BigMetric
                      label={t("dash.metric.abreviado")}
                      v={pm.procedimiento_abreviado_pct ?? trialPrep.jury_settlement_pct}
                    />
                  </>
                ) : (
                  <>
                    <BigMetric label={t("dash.metric.actorSuccess")} v={cm.plaintiff_success_pct ?? null} />
                    <BigMetric label={t("dash.metric.defenseSuccess")} v={cm.defense_success_pct ?? null} />
                    <BigMetric
                      label={t("dash.metric.settlement")}
                      v={cm.settlement_probability_pct ?? trialPrep.jury_settlement_pct}
                    />
                    <BigMetric
                      label={t("dash.metric.comparativeFault")}
                      v={cm.comparative_fault_estimate_pct ?? null}
                    />
                  </>
                )}
              </div>
            </div>
          );
        })()}

      <DashboardList title={t("dash.list.top")} items={top} empty={t("dash.list.top.empty")} />
      <DashboardList title={t("dash.list.risks")} items={risks} empty={t("dash.list.risks.empty")} />
      <DashboardList title={t("dash.list.strengths")} items={strengths} empty={t("dash.list.strengths.empty")} />
      <DashboardList title={t("dash.list.gaps")} items={weak} empty={t("dash.list.gaps.empty")} />

      {theories.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold">{t("dash.theories")}</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {theories.map((th) => (
              <div key={th.id} className="rounded-lg border border-border p-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-accent">{th.theory_type}</div>
                <p className="mt-1 text-sm text-foreground/90">{th.narrative}</p>
                <div className="mt-2 text-xs text-muted-foreground">
                  {t("dash.theories.meta", {
                    pct: Math.round((th.confidence ?? 0) * 100),
                    risk: th.risk ?? "—",
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number; accent?: "destructive" | "success" }) {
  const color =
    accent === "destructive" ? "text-destructive" : accent === "success" ? "text-success" : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-3xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function BigMetric({ label, v, inverse }: { label: string; v: number | null; inverse?: boolean }) {
  const { t } = useI18n();
  const val = typeof v === "number" ? v : null;
  const band = val == null ? null : scoreBand(val, inverse ? "risk" : "strength");
  const color = band ? band.textClass : "text-foreground";
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <div className={`text-3xl font-semibold tabular-nums ${color}`}>{val ?? "—"}</div>
        {val != null && <div className="text-sm text-muted-foreground">/100</div>}
        {band && (
          <span className={`ml-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${band.badgeClass}`}>
            {t(band.labelKey)}
          </span>
        )}
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={band ? "h-full" : "h-full bg-accent"}
          style={{ width: `${val ?? 0}%`, backgroundColor: band ? band.hex : undefined }}
        />
      </div>
    </div>
  );
}

function DashboardList({ title, items, empty }: { title: string; items: Finding[]; empty: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((f) => (
            <li key={f.id} className="flex items-start gap-3 rounded-lg border border-border bg-background p-3 text-sm">
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${sevColor(f.severity)}`}
              >
                {f.severity}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{f.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{f.description}</div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {Math.round(f.confidence * 100)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Fields translated per finding, in the fixed order the flat batch below
// relies on to reconstruct each finding after translation.
const FINDING_TRANSLATED_FIELDS = ["title", "description", "legal_significance", "potential_impact"] as const;

function FindingsTab({ findings, sourceLocale = "es" }: { findings: Finding[]; sourceLocale?: "es" | "en" }) {
  const [sev, setSev] = useState<string>("all");
  const [cat, setCat] = useState<string>("all");
  const categories = Array.from(new Set(findings.map((f) => f.category))).sort();
  const filtered = findings
    .filter((f) => sev === "all" || f.severity === sev)
    .filter((f) => cat === "all" || f.category === cat)
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity));

  // One batched translation call for every visible finding's title,
  // description, legal significance and potential impact — never for the
  // formal Report, which always stays in its generated language.
  const flatSource = filtered.flatMap((f) => [f.title, f.description, f.legal_significance, f.potential_impact]);
  const { texts: flatTranslated } = useTranslatedTexts(flatSource, sourceLocale);
  const translatedFindings: Finding[] = filtered.map((f, i) => {
    const base = i * FINDING_TRANSLATED_FIELDS.length;
    return {
      ...f,
      title: flatTranslated[base] || f.title,
      description: flatTranslated[base + 1] || f.description,
      legal_significance: f.legal_significance ? flatTranslated[base + 2] || f.legal_significance : null,
      potential_impact: f.potential_impact ? flatTranslated[base + 3] || f.potential_impact : null,
    };
  });

  if (findings.length === 0)
    return <Empty msg="No findings yet. Run analyzers + agents to populate the findings store." />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <FilterPill label="All severities" active={sev === "all"} onClick={() => setSev("all")} />
        {["critical", "high", "medium", "low", "info"].map((s) => (
          <FilterPill key={s} label={s} active={sev === s} onClick={() => setSev(s)} />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <FilterPill label="All categories" active={cat === "all"} onClick={() => setCat("all")} />
        {categories.map((c) => (
          <FilterPill key={c} label={c} active={cat === c} onClick={() => setCat(c)} />
        ))}
      </div>
      <div className="text-xs text-muted-foreground">
        Showing {filtered.length} of {findings.length}
      </div>
      <div className="space-y-2">
        {translatedFindings.map((f) => (
          <details key={f.id} className="rounded-lg border border-border bg-card">
            <summary className="flex cursor-pointer items-start gap-3 px-4 py-3 text-sm">
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${sevColor(f.severity)}`}
              >
                {f.severity}
              </span>
              <FindingTypeBadge type={(f as unknown as { finding_type?: string }).finding_type} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{f.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {f.category} · {f.source_module} · {f.affected_party ?? "—"} · {Math.round(f.confidence * 100)}%
                  confidence
                </div>
              </div>
            </summary>
            <div className="border-t border-border px-4 py-3 text-sm">
              <p className="whitespace-pre-wrap text-foreground/90">{f.description}</p>
              {(() => {
                const x = f as unknown as {
                  source_quote?: string | null;
                  source_page?: number | null;
                  source_document_id?: string | null;
                };
                if (!x.source_quote) return null;
                return (
                  <div className="mt-3 rounded border border-border/60 bg-secondary/30 p-2 text-xs">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Source quote{x.source_page ? ` · p.${x.source_page}` : ""}
                    </div>
                    <div className="mt-1 italic text-foreground/90">“{x.source_quote}”</div>
                  </div>
                );
              })()}
              {f.legal_significance && <FieldRow label="Legal significance" v={f.legal_significance} />}
              {f.potential_impact && <FieldRow label="Potential impact" v={f.potential_impact} />}
              {f.tags && f.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {f.tags.map((t) => (
                    <span key={t} className="rounded bg-secondary px-1.5 py-0.5 text-[10px]">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
function FindingTypeBadge({ type }: { type?: string }) {
  if (!type) return null;
  const map: Record<string, string> = {
    DIRECT_EVIDENCE: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    EVIDENCE_BASED_INFERENCE: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    AI_THEORY: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  };
  const label =
    type === "DIRECT_EVIDENCE" ? "Evidence" : type === "EVIDENCE_BASED_INFERENCE" ? "Inference" : "AI theory";
  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${map[type] ?? ""}`}>
      {label}
    </span>
  );
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
        active ? "bg-accent text-accent-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function FieldRow({ label, v }: { label: string; v: string }) {
  return (
    <div className="mt-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground/90">{v}</div>
    </div>
  );
}

type Doc = {
  id: string;
  filename: string;
  status: string;
  mime_type: string | null;
  size_bytes: number | null;
  error: string | null;
  // extracted_text is fetched lazily (see DocumentTextSection) — it is no
  // longer part of the getCase payload.
  metadata: unknown;
  entities: unknown;
};

// Lazily loads a single document's OCR text only when its card is expanded.
function DocumentTextSection({ documentId }: { documentId: string }) {
  const fetchText = useServerFn(getDocumentText);
  const { data, isLoading } = useQuery({
    queryKey: ["document-text", documentId],
    queryFn: () => fetchText({ data: { documentId } }),
    staleTime: 5 * 60_000,
  });
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-secondary/40 p-3 text-foreground/90">
      {isLoading ? "…" : (data?.text ?? "—")}
    </pre>
  );
}

function IntelTab({ docs, caseId, invalidate }: { docs: Doc[]; caseId: string; invalidate: () => Promise<void> }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [retryAllBusy, setRetryAllBusy] = useState(false);
  const failedCount = docs.filter((d) => d.status === "failed").length;
  return (
    <div className="space-y-3">
      <AddEvidenceBlock caseId={caseId} invalidate={invalidate} />
      {docs.length === 0 ? <Empty msg="No documents uploaded yet." /> : null}

      {failedCount > 0 && (
        <div className="flex items-center justify-between rounded border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs">
          <span className="text-destructive">{failedCount} document(s) failed extraction</span>
          <button
            type="button"
            disabled={retryAllBusy}
            onClick={async () => {
              if (!confirm(`Retry extraction for all ${failedCount} failed document(s)?`)) return;
              setRetryAllBusy(true);
              try {
                await retryDocumentExtraction({ data: { caseId } });
                await invalidate();
                toast.success("Extraction retry started for all failed documents");
              } catch (err) {
                toast.error(String(err));
              } finally {
                setRetryAllBusy(false);
              }
            }}
            className="inline-flex items-center gap-1 rounded bg-primary/90 px-2 py-1 text-[10px] font-medium text-primary-foreground hover:bg-primary disabled:opacity-50"
          >
            <RotateCcw size={10} /> Retry all failed
          </button>
        </div>
      )}
      {docs.map((d) => {
        const open = openId === d.id;
        return (
          <div key={d.id} className="rounded-lg border border-border bg-card">
            <button
              onClick={() => setOpenId(open ? null : d.id)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-secondary/40"
            >
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{d.filename}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {d.mime_type} · {((d.size_bytes ?? 0) / 1024).toFixed(1)} KB
                </span>
              </div>
              <span
                className={`shrink-0 text-xs uppercase tracking-wider ${
                  d.status === "extracted"
                    ? "text-success"
                    : d.status === "failed"
                      ? "text-destructive"
                      : d.status === "extracting"
                        ? "text-warning"
                        : "text-muted-foreground"
                }`}
              >
                {d.status}
              </span>
            </button>
            {open && (
              <div className="border-t border-border bg-background/40 p-4 text-xs">
                {d.error && (
                  <div className="mb-3 rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">
                    {d.error}
                  </div>
                )}
                {/* Document action controls */}
                <div className="mb-3 flex flex-wrap gap-2">
                  {d.status === "failed" && (
                    <button
                      type="button"
                      disabled={busyDocId === d.id || retryAllBusy}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Retry extraction for "${d.filename}"?`)) return;
                        setBusyDocId(d.id);
                        try {
                          await retryDocumentExtraction({ data: { caseId } });
                          await invalidate();
                          toast.success("Extraction retry started");
                        } catch (err) {
                          toast.error(String(err));
                        } finally {
                          setBusyDocId(null);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded bg-primary/90 px-2 py-1 text-[10px] font-medium text-primary-foreground hover:bg-primary disabled:opacity-50"
                    >
                      <RotateCcw size={10} /> Retry extraction
                    </button>
                  )}
                  {d.status === "extracted" && (
                    <button
                      type="button"
                      disabled={busyDocId === d.id || retryAllBusy}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (
                          !confirm(
                            `Rollback extraction for "${d.filename}"? This will clear all extracted data and reset to pending.`,
                          )
                        )
                          return;
                        setBusyDocId(d.id);
                        try {
                          await rollbackDocumentExtraction({
                            data: { caseId, documentIds: [d.id] },
                          });
                          await invalidate();
                          toast.success("Extraction rolled back");
                        } catch (err) {
                          toast.error(String(err));
                        } finally {
                          setBusyDocId(null);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-[10px] font-medium text-foreground hover:bg-muted/80 disabled:opacity-50"
                    >
                      <Undo2 size={10} /> Rollback extraction
                    </button>
                  )}
                </div>
                <Section title="Metadata">
                  <Pre v={d.metadata} />
                </Section>
                <Section title="Entities">
                  <Pre v={d.entities} />
                </Section>
                <Section title="Extracted text">
                  <DocumentTextSection documentId={d.id} />
                </Section>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AddEvidenceBlock({ caseId, invalidate }: { caseId: string; invalidate: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [rerunScope, setRerunScope] = useState<"new_documents_only" | "affected_analysis" | "full_case">(
    "affected_analysis",
  );
  const fileRef = useRef<HTMLInputElement | null>(null);
  const addFn = useServerFn(addEvidenceAndRerun);
  const queueFn = useServerFn(queueCaseForPipeline);

  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    setBusy(true);
    try {
      setProgress(`Uploading ${arr.length} file(s) and extracting…`);
      const fd = new FormData();
      fd.append("caseId", caseId);
      fd.append("rerunScope", rerunScope);
      for (const f of arr) fd.append("files", f);
      // useServerFn for createServerFn with FormData input passes the FormData directly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (addFn as any)({ data: fd });
      await invalidate();

      if (!res?.uploaded) {
        toast.info(
          res?.skipped
            ? "No new evidence was added; exact duplicate files were skipped."
            : "No evidentiary files were added.",
        );
        return;
      }

      const revisionCount = Array.isArray(res.revisedDocuments) ? res.revisedDocuments.length : 0;
      toast.success(
        `Uploaded ${res.uploaded} file(s)${revisionCount ? ` (${revisionCount} preserved as revisions)` : ""}.`,
      );

      if (rerunScope === "new_documents_only") {
        toast.success("New documents extracted. Existing analysis and report were left unchanged.");
        return;
      }

      setProgress(
        rerunScope === "full_case"
          ? "Queueing full-case analysis…"
          : "Queueing affected analysis from analyzers…",
      );
      const queued = await queueFn({
        data: { caseId, startFrom: (res?.startFrom ?? "analyzers") as "analyzers" },
      });
      if (!queued?.queued) {
        throw new Error(
          queued?.alreadyRunning
            ? "This case is already running."
            : queued?.usageMessage ?? "The analysis could not be queued.",
        );
      }

      toast.success(
        `Report v${res?.nextVersion ?? "?"} queued. What's Changed will be calculated after the report is saved.`,
      );
      await invalidate();
    } catch (e) {
      toast.error(`Add evidence failed: ${String(e)}`);
    } finally {
      setBusy(false);
      setProgress("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (busy) return;
        if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files);
      }}
      className={`rounded-lg border-2 border-dashed p-4 transition-colors ${
        dragOver ? "border-primary bg-primary/5" : "border-border bg-card/40"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Add Evidence</h3>
          <p className="text-xs text-muted-foreground">
            Upload one or more documents. Only new files are extracted; whole-case engines (timeline, contradictions,
            witnesses, evidence map, scoring) rerun automatically and a new report version is generated with a "What's
            Changed" diff.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="evidence-rerun-scope">
            Analysis scope
          </label>
          <select
            id="evidence-rerun-scope"
            value={rerunScope}
            disabled={busy}
            onChange={(e) =>
              setRerunScope(
                e.target.value as "new_documents_only" | "affected_analysis" | "full_case",
              )
            }
            className="rounded border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="new_documents_only">Extract new documents only</option>
            <option value="affected_analysis">Re-run affected analysis</option>
            <option value="full_case">Full case re-analysis</option>
          </select>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            disabled={busy}
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <FileText size={12} /> {busy ? "Working…" : "Add Evidence"}
          </button>
        </div>
      </div>
      {busy && progress && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> {progress}
        </div>
      )}
    </div>
  );
}

function AnalyzersTab({ a }: { a: Record<string, unknown> | null | undefined }) {
  if (!a) return <Empty msg="No analyzer output yet. Run Analyzers to populate this view." />;
  const blocks: [string, unknown][] = [
    ["Timeline", a.timeline],
    ["Contradictions", a.contradictions],
    ["Missing evidence", a.missing_evidence],
    ["Procedural issues", a.procedural_issues],
    ["Evidence relationships", a.evidence_relationships],
    ["Key findings", a.key_findings],
  ];
  return (
    <div className="space-y-4">
      {blocks.map(([t, v]) => (
        <div key={t} className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">{t}</h3>
          <Pre v={v} className="mt-2" />
        </div>
      ))}
    </div>
  );
}

type Agent = {
  id: string;
  agent_type: string;
  status: string;
  summary: string | null;
  confidence: number | null;
  findings: unknown;
  error: string | null;
  latency_ms: number | null;
};

function AgentsTab({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) return <Empty msg="No agents have run yet. Run Agents to dispatch the investigators." />;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {agents.map((a) => (
        <div key={a.id} className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold capitalize">{a.agent_type.replace(/_/g, " ")}</h3>
            <span className={`text-xs ${a.status === "complete" ? "text-success" : "text-destructive"}`}>
              {a.status}
            </span>
          </div>
          {typeof a.confidence === "number" && (
            <div className="mt-1 text-xs text-muted-foreground">Confidence: {Math.round(a.confidence * 100)}%</div>
          )}
          {a.summary && <p className="mt-3 text-sm leading-relaxed text-foreground/90">{a.summary}</p>}
          {a.error && (
            <div className="mt-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {a.error}
            </div>
          )}
          {a.findings != null && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                View findings
              </summary>
              <Pre v={a.findings} className="mt-2" />
            </details>
          )}
          {a.latency_ms != null && (
            <div className="mt-2 text-xs text-muted-foreground">{(a.latency_ms / 1000).toFixed(1)}s</div>
          )}
        </div>
      ))}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TheoriesTab({ theories }: { theories: any[] }) {
  if (theories.length === 0) return <Empty msg="No theories yet. Run Theories of the Case." />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {theories.map((t) => (
        <div key={t.id} className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold capitalize">{t.theory_type} theory</h3>
            <span className="text-xs text-muted-foreground">Confidence {Math.round((t.confidence ?? 0) * 100)}%</span>
          </div>
          <p className="mt-3 text-sm text-foreground/90">{t.narrative}</p>
          <ListSection title="Supporting evidence" items={t.supporting_evidence} />
          <ListSection title="Contradicting evidence" items={t.contradicting_evidence} />
          <ListSection title="Missing evidence" items={t.missing_evidence} />
          <ListSection title="Key assumptions" items={t.key_assumptions} />
          {t.risk && <FieldRow label="Risk" v={t.risk} />}
        </div>
      ))}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function OpportunitiesTab({ opps, ranAt }: { opps: any[]; ranAt?: string | null }) {
  if (opps.length === 0)
    return (
      <Empty
        msg={
          ranAt
            ? "No defense opportunities identified in the source documents. The Opportunity Engine ran successfully but found no actionable openings supported by the current evidence corpus."
            : "No opportunities yet. Run Defense Opportunities."
        }
      />
    );
  return (
    <div className="space-y-3">
      {opps.map((o) => (
        <div key={o.id} className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${sevColor(o.severity)}`}
                >
                  {o.severity}
                </span>
                <span className="text-xs uppercase tracking-wider text-accent">{o.side}</span>
                <span className="text-xs text-muted-foreground">{o.opportunity_type}</span>
              </div>
              <h3 className="mt-1 text-sm font-semibold">{o.title}</h3>
            </div>
            <span className="text-xs text-muted-foreground">{Math.round((o.confidence ?? 0) * 100)}%</span>
          </div>
          <p className="mt-2 text-sm text-foreground/90">{o.description}</p>
          <ListSection title="Recommended motions" items={o.recommended_motions} />
          <ListSection title="Recommended questions" items={o.recommended_questions} />
          <ListSection title="Recommended investigations" items={o.recommended_investigations} />
          {o.counter_response && (
            <div className="mt-3 rounded border border-warning/30 bg-warning/5 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-warning">
                Prosecution recovery
              </div>
              <p className="mt-1 text-sm text-foreground/90">{o.counter_response}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ListSection({ title, items }: { title: string; items: unknown }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-foreground/90">
        {items.map((it, i) => (
          <li key={i}>{typeof it === "string" ? it : JSON.stringify(it)}</li>
        ))}
      </ul>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function WitnessesTab({ witnesses, ranAt }: { witnesses: any[]; ranAt?: string | null }) {
  if (witnesses.length === 0)
    return (
      <Empty
        msg={
          ranAt
            ? "No witnesses identified in the source documents. The Witness Intelligence engine ran successfully but found no named individuals with testimony that could be verified against the evidence corpus."
            : "No witness profiles. Run Witness Intelligence."
        }
      />
    );
  return (
    <div className="space-y-3">
      {witnesses.map((w) => (
        <details key={w.id} className="rounded-lg border border-border bg-card">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
            <div>
              <div className="text-sm font-semibold">{w.name}</div>
              <div className="text-xs text-muted-foreground">{w.role ?? "—"}</div>
            </div>
            <div className="grid grid-cols-3 gap-3 text-xs text-muted-foreground sm:grid-cols-6">
              <Metric label="Reliab" v={w.reliability} />
              <Metric label="Bias" v={w.bias} inverse />
              <Metric label="Consist" v={w.consistency} />
              <Metric label="Corrob" v={w.corroboration} />
              <Metric label="Observ" v={w.observation_opportunity} />
              <Metric label="Risk" v={w.credibility_risk} inverse />
            </div>
          </summary>
          <div className="border-t border-border px-4 py-3">
            <ListSection title="Cross-examination" items={w.cross_exam_questions} />
            <ListSection title="Impeachment" items={w.impeachment_questions} />
            <ListSection title="Follow-up" items={w.follow_up_questions} />
            {w.rationale && Object.keys(w.rationale).length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Rationale
                </div>
                <Pre v={w.rationale} className="mt-1" />
              </div>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

function Metric({ label, v, inverse }: { label: string; v: number | null; inverse?: boolean }) {
  const good = v == null ? false : inverse ? v < 40 : v >= 60;
  const bad = v == null ? false : inverse ? v > 70 : v < 35;
  const color = good ? "text-success" : bad ? "text-destructive" : "text-foreground";
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{v ?? "—"}</div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TrialPrepTab({ t, ranAt }: { t: any; ranAt?: string | null }) {
  if (!t)
    return (
      <Empty
        msg={
          ranAt
            ? "No se generó preparación para audiencia. El motor corrió pero no produjo ejes de alegato, orden de testigos ni estimaciones sostenibles con el corpus probatorio actual."
            : "Aún no hay preparación para audiencia. Ejecuta Preparación para Juicio Oral / Audiencia."
        }
      />
    );
  const ct = typeof t.case_type === "string" ? t.case_type : "general_civil";
  const isCrim = ct === "penal" || ct === "criminal" || ct === "civil_rights";
  const cm = (t.civil_metrics ?? {}) as Record<string, number | null>;
  const pm = (t.penal_metrics ?? {}) as Record<string, number | null>;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">
          {isCrim ? "Estimación de resultado (Tribunal de Enjuiciamiento)" : "Estimación de resultado"}
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          {isCrim ? (
            <>
              <BigMetric label="Vinculación a proceso" v={pm.vinculacion_proceso_pct ?? null} />
              <BigMetric label="Sentencia condenatoria" v={pm.sentencia_condenatoria_pct ?? t.jury_conviction_pct} />
              <BigMetric label="Sentencia absolutoria" v={pm.sentencia_absolutoria_pct ?? t.jury_acquittal_pct} />
              <BigMetric label="Procedimiento abreviado" v={pm.procedimiento_abreviado_pct ?? t.jury_settlement_pct} />
            </>
          ) : (
            <>
              <BigMetric label="Plaintiff success" v={cm.plaintiff_success_pct ?? null} />
              <BigMetric label="Defense success" v={cm.defense_success_pct ?? null} />
              <BigMetric label="Settlement" v={cm.settlement_probability_pct ?? t.jury_settlement_pct} />
              <BigMetric label="Comparative fault" v={cm.comparative_fault_estimate_pct ?? null} />
            </>
          )}
        </div>
        {isCrim && (
          <p className="mt-3 text-xs text-muted-foreground">
            Éxito estimado en recurso (apelación / amparo directo):{" "}
            <span className="tabular-nums">{pm.recurso_exito_pct ?? t.jury_appeal_pct ?? "—"}</span>. En el sistema
            penal acusatorio mexicano no existe jurado: la culpabilidad la determina el Tribunal de Enjuiciamiento.
          </p>
        )}
        <p className="mt-2 text-xs italic text-muted-foreground">
          Estimación del modelo de IA a partir del expediente actual — no calibrada contra resultados reales de
          casos. Trátese como un punto de referencia, no como una probabilidad estadística validada.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Block title="Ejes de apertura" items={t.opening_themes} />
        <Block title="Ejes de clausura" items={t.closing_themes} />
        <Block title="Fortalezas del caso" items={t.trial_strengths} />
        <Block title="Riesgos del caso" items={t.trial_risks} />
        <Block
          title={isCrim ? "Riesgos de percepción ante el Tribunal" : "Riesgos de percepción"}
          items={t.jury_concerns}
        />

        <Block title="Evidencia más persuasiva" items={t.most_persuasive_evidence} />
        <Block title="Evidencia más perjudicial" items={t.most_damaging_evidence} />
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Orden de testigos</h3>
        <ListSection
          title=""
          items={(t.witness_order ?? []).map((w: { name: string; reason: string }) => `${w.name} — ${w.reason}`)}
        />
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Orden de pruebas</h3>
        <ListSection
          title=""
          items={(t.exhibit_order ?? []).map((e: { exhibit: string; reason: string }) => `${e.exhibit} — ${e.reason}`)}
        />
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Objeciones probables</h3>
        <ListSection
          title=""
          items={(t.likely_objections ?? []).map(
            (o: { objection: string; counter: string }) => `${o.objection} → contraargumento: ${o.counter}`,
          )}
        />
      </div>
    </div>
  );
}

function Block({ title, items }: { title: string; items: unknown }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ListSection title="" items={items} />
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function WorkProductTab({ docs }: { docs: any[] }) {
  if (docs.length === 0) return <Empty msg="No work product yet. Run Attorney Work Product." />;
  return (
    <div className="space-y-3">
      {docs.map((d) => {
        const failed = d.status === "failed" || d.generation_failed === true;
        const empty = !failed && (!d.body_markdown || String(d.body_markdown).trim().length === 0);
        return (
          <details key={d.id} className="rounded-lg border border-border bg-card">
            <summary className="cursor-pointer px-4 py-3 text-sm">
              <span className="font-semibold">{d.title}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {String(d.document_type ?? "").replace(/_/g, " ")}
              </span>
              {failed && (
                <span className="ml-2 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive">
                  Generation failed
                </span>
              )}
              {empty && !failed && (
                <span className="ml-2 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Empty
                </span>
              )}
            </summary>
            <div className="border-t border-border p-4">
              {failed ? (
                <p className="text-sm text-muted-foreground">
                  {d.error_message ?? "This draft was not produced. Re-run Attorney Work Product to retry."}
                </p>
              ) : empty ? (
                <p className="text-sm text-muted-foreground">
                  No content was generated for this draft. Re-run Attorney Work Product to retry.
                </p>
              ) : (
                <pre className="whitespace-pre-wrap font-sans text-sm text-foreground/90">{d.body_markdown}</pre>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

type Score = Record<string, unknown> & {
  evidence_strength: number | null;
  witness_reliability: number | null;
  timeline_integrity: number | null;
  chain_of_custody: number | null;
  constitutional_compliance: number | null;
  investigation_completeness: number | null;
  case_quality: number | null;
  conviction_risk: number | null;
  appeal_risk: number | null;
  overall_confidence: number | null;
  methodology: string | null;
  dimension_breakdowns: Record<
    string,
    {
      score: number;
      reasoning: string;
      positive: { label: string; finding_id?: string | null }[];
      negative: { label: string; finding_id?: string | null }[];
    }
  > | null;
  positive_contributors: { label: string; weight: number; finding_id?: string | null }[] | null;
  negative_contributors: { label: string; weight: number; finding_id?: string | null }[] | null;
};

function ScorecardTab({ s }: { s: Score | null | undefined }) {
  if (!s) return <Empty msg="No scorecard yet. Run Score Case." />;
  // Render dimensions from the deterministic scorecard when available so the
  // displayed metrics always reflect the case type (civil vs criminal). Any
  // legacy column the runScoring step set to null is hidden entirely.
  const breakdownsRaw = (s.dimension_breakdowns ?? {}) as Record<string, unknown>;
  const detRoot = (
    breakdownsRaw as {
      deterministic?: { dimensions?: Record<string, { dimension?: string; score?: number }> };
    }
  ).deterministic;
  const detDims = detRoot?.dimensions ?? {};
  const detKeys = Object.keys(detDims);
  const INVERSE = new Set(["conviction_risk", "appeal_risk", "litigation_risk", "settlement_pressure"]);
  const LEGACY_LABELS: Record<string, string> = {
    overall_confidence: "Overall confidence",
    case_quality: "Case quality",
    evidence_strength: "Evidence strength",
    witness_reliability: "Witness reliability",
    timeline_integrity: "Timeline integrity",
    chain_of_custody: "Chain of custody",
    constitutional_compliance: "Constitutional compliance",
    investigation_completeness: "Investigation completeness",
    conviction_risk: "Conviction risk",
    appeal_risk: "Appeal risk",
  };
  const dims: { k: string; label: string; inverse?: boolean }[] = [
    { k: "overall_confidence", label: "Overall confidence" },
    { k: "case_quality", label: "Case quality" },
    ...(detKeys.length
      ? detKeys.map((k) => ({
          k,
          label: detDims[k]?.dimension ?? LEGACY_LABELS[k] ?? k,
          inverse: INVERSE.has(k),
        }))
      : Object.keys(LEGACY_LABELS)
          .filter((k) => k !== "overall_confidence" && k !== "case_quality")
          .map((k) => ({ k, label: LEGACY_LABELS[k], inverse: INVERSE.has(k) }))),
  ].filter(({ k }) => {
    // Always show the two top-of-card metrics; for the rest hide when the
    // value is null (criminal-only dimension on a civil case, etc.).
    if (k === "overall_confidence" || k === "case_quality") return true;
    const v = (s as Record<string, unknown>)[k];
    const detV = detDims[k]?.score;
    return typeof v === "number" || typeof detV === "number";
  });
  const breakdowns = breakdownsRaw as Record<
    string,
    {
      score: number;
      reasoning: string;
      positive: { label: string; finding_id?: string | null }[];
      negative: { label: string; finding_id?: string | null }[];
    }
  >;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {dims.map(({ k, label, inverse }) => {
          const v = (s as Record<string, unknown>)[k] as number | null | undefined;
          const detScore = detDims[k]?.score;
          const shownV: number | null = typeof v === "number" ? v : typeof detScore === "number" ? detScore : null;
          const b = breakdowns[k];
          return (
            <details key={k} className="rounded-lg border border-border bg-card p-4">
              <summary className="cursor-pointer">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
                <div className="mt-1 flex items-baseline gap-1">
                  <div
                    className={`text-3xl font-semibold tabular-nums ${shownV != null && (inverse ? shownV > 70 : shownV < 35) ? "text-destructive" : shownV != null && (inverse ? shownV < 40 : shownV >= 60) ? "text-success" : "text-foreground"}`}
                  >
                    {shownV ?? "—"}
                  </div>
                  {shownV != null && <div className="text-sm text-muted-foreground">/100</div>}
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div className="h-full bg-accent" style={{ width: `${shownV ?? 0}%` }} />
                </div>
              </summary>
              {b && (
                <div className="mt-3 space-y-2 text-xs">
                  {b.reasoning && <p className="text-foreground/90">{b.reasoning}</p>}
                  {b.positive?.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-success">Positive</div>
                      <ul className="mt-0.5 list-disc pl-5">
                        {b.positive.map((p, i) => (
                          <li key={i}>{p.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {b.negative?.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
                        Negative
                      </div>
                      <ul className="mt-0.5 list-disc pl-5">
                        {b.negative.map((p, i) => (
                          <li key={i}>{p.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </details>
          );
        })}
      </div>
      {s.methodology && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Methodology</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{s.methodology}</p>
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold text-success">Top positive contributors</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {(s.positive_contributors ?? []).slice(0, 10).map((p, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>{p.label}</span>
                <span className="tabular-nums text-muted-foreground">+{p.weight}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold text-destructive">Top negative contributors</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {(s.negative_contributors ?? []).slice(0, 10).map((p, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>{p.label}</span>
                <span className="tabular-nums text-muted-foreground">−{p.weight}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// =================== CHAT TAB ===================

type ChatMsg = { id: string; role: string; content: string; created_at: string };

function ChatTab({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const fetchChat = useServerFn(getCaseChat);
  const askAi = useServerFn(askCaseAi);
  const clearChat = useServerFn(clearCaseChat);
  const { data: history = [] } = useQuery<ChatMsg[]>({
    queryKey: ["chat", caseId],
    queryFn: () => fetchChat({ data: { caseId } }) as Promise<ChatMsg[]>,
  });
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ask = useMutation({
    mutationFn: (question: string) => askAi({ data: { caseId, question } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chat", caseId] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Chat failed"),
  });
  const clear = useMutation({
    mutationFn: () => clearChat({ data: { caseId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chat", caseId] }),
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history.length, ask.isPending]);

  const submit = () => {
    const q = input.trim();
    if (!q || ask.isPending) return;
    setInput("");
    ask.mutate(q, { onSettled: () => inputRef.current?.focus() });
  };

  const suggestions = [
    "What is my strongest defense argument?",
    "What evidence is weakest and most vulnerable?",
    "What motions should be filed first?",
    "What constitutional violations exist?",
    "What evidence appears to be missing?",
    "What would opposing counsel argue?",
  ];

  return (
    <div className="flex h-[70vh] flex-col rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Case AI · grounded in this case's intelligence</h3>
        </div>
        <button
          onClick={() => clear.mutate()}
          disabled={history.length === 0}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" /> Clear
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {history.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Ask anything about this case. Every answer is grounded in the unified findings, theories, opportunities,
              witnesses, and trial prep produced for this case.
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setInput(s);
                    inputRef.current?.focus();
                  }}
                  className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground/80 hover:bg-secondary"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {history.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-lg px-4 py-2.5 text-sm ${
                m.role === "user" ? "bg-accent text-accent-foreground" : "text-foreground"
              }`}
            >
              <pre className={`whitespace-pre-wrap font-sans ${m.role === "user" ? "" : "leading-relaxed"}`}>
                {m.content}
              </pre>
            </div>
          </div>
        ))}
        {ask.isPending && (
          <div className="flex justify-start">
            <div className="text-sm text-muted-foreground">
              <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask the Case AI…"
            rows={2}
            className="min-h-[44px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <button
            onClick={submit}
            disabled={ask.isPending || !input.trim()}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-accent text-accent-foreground disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// =================== REPORT TAB ===================

type Report = Record<string, unknown>;

const REPORT_SECTION_ORDER: { key: string; title: string }[] = [
  { key: "executive_summary", title: "Executive Summary" },
  { key: "attorney_summary", title: "Attorney Summary" },
  { key: "investigator_summary", title: "Investigator Summary" },
  { key: "case_overview", title: "Case Overview" },
  { key: "facts", title: "Facts" },
  { key: "timeline_summary", title: "Timeline Reconstruction" },
  { key: "evidence_summary", title: "Evidence Inventory" },
  { key: "witness_analysis", title: "Witness Analysis" },
  { key: "contradiction_report", title: "Contradictions" },
  { key: "discovery_analysis", title: "Discovery Analysis" },
  { key: "missing_evidence_report", title: "Missing Evidence" },
  { key: "constitutional_issues", title: "Constitutional Issues" },
  { key: "procedural_issues_report", title: "Procedural Issues" },
  { key: "prosecution_theory_report", title: "Prosecution Theory" },
  { key: "defense_theory_report", title: "Defense Theory" },
  { key: "alternative_theory_report", title: "Alternative Theories" },
  { key: "risk_analysis", title: "Risk Analysis" },
  { key: "score_breakdown", title: "Case Score Breakdown" },
  { key: "recommendations", title: "Recommended Actions" },
  { key: "appendix_sources", title: "Appendix: Source References" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rArr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}
function rStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function rNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function SevBadge({ s }: { s?: string }) {
  const v = (s ?? "").toLowerCase();
  const cls =
    v === "critical"
      ? "bg-red-600/15 text-red-700 border-red-600/30"
      : v === "high"
        ? "bg-orange-500/15 text-orange-700 border-orange-500/30"
        : v === "medium"
          ? "bg-amber-500/15 text-amber-700 border-amber-500/30"
          : v === "low"
            ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/30"
            : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}
    >
      {v || "info"}
    </span>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Cite({ c }: { c: any }) {
  if (!c || typeof c !== "object") return null;
  const doc = c.doc_n ?? c.docN;
  const page = c.page;
  const quote = typeof c.quote === "string" ? c.quote : "";
  if (typeof doc !== "number" || typeof page !== "number") return null;
  return (
    <span className="mr-2 inline-flex flex-col rounded border border-border bg-secondary/40 px-2 py-1 text-[11px] text-foreground/80">
      <span className="font-mono font-semibold">
        [DOC {doc} p.{page}]
      </span>
      {quote && <span className="mt-0.5 max-w-md italic text-muted-foreground">"{quote.slice(0, 220)}"</span>}
    </span>
  );
}

function ScoreCard({ label, value, tone }: { label: string; value: number | null; tone: "good" | "risk" }) {
  const { t } = useI18n();
  if (value == null) return null;
  const band = scoreBand(value, tone === "risk" ? "risk" : "strength");
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 flex items-baseline gap-2 text-3xl font-bold ${band.textClass}`}>
        {value}
        <span className="text-base font-normal text-muted-foreground">/100</span>
      </div>
      <span
        className={`mt-1.5 inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${band.badgeClass}`}
      >
        {t(band.labelKey)}
      </span>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-lg font-semibold">{title}</h3>
        {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

// Goal-first panel — answers the attorney's primary question for the materia
// before any document summary, and attaches why / impact / next action.
function ObjectivePanel({ r }: { r: Report }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = ((r.full_report as any) ?? {}).objective as
    | {
        question?: string;
        answer?: string;
        confidence?: string;
        insufficient?: boolean;
        materia_label?: string | null;
        basis?: string[];
        blockers?: string[];
        locale?: string;
        decision_points?: Array<{
          id: string;
          issue: string;
          why: string;
          impact: string;
          next_action: string;
          severity?: string;
        }>;
      }
    | undefined;
  if (!o?.answer) return null;
  const en = o.locale === "en";

  return (
    <Panel title={en ? "Direct Answer" : "Respuesta Directa"} subtitle={o.materia_label ?? undefined}>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{o.question}</p>
      <p className={`mt-2 text-base ${o.insufficient ? "text-amber-300" : ""}`}>{o.answer}</p>
      {o.confidence && (
        <p className="mt-1 text-xs text-muted-foreground">
          {en ? "Confidence" : "Confianza"}: {o.confidence}
        </p>
      )}
      {(o.basis?.length ?? 0) > 0 && (
        <div className="mt-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {en ? "Verified basis" : "Sustento verificado"}
          </div>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {o.basis!.map((bItem, i) => (
              <li key={i}>{bItem}</li>
            ))}
          </ul>
        </div>
      )}
      {(o.blockers?.length ?? 0) > 0 && (
        <div className="mt-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {en ? "Still unproven" : "Pendiente de acreditar"}
          </div>
          <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
            {o.blockers!.map((bItem, i) => (
              <li key={i}>{bItem}</li>
            ))}
          </ul>
        </div>
      )}
      {(o.decision_points?.length ?? 0) > 0 && (
        <div className="mt-5 space-y-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {en ? "Decision support" : "Soporte para la decisión"}
          </div>
          {o.decision_points!.map((dp) => (
            <div key={dp.id} className="rounded border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="text-sm font-medium">{dp.issue}</div>
                <SevBadge s={dp.severity} />
              </div>
              <dl className="mt-2 space-y-1 text-xs">
                <div>
                  <dt className="inline text-muted-foreground">{en ? "Why it matters" : "Por qué importa"}: </dt>
                  <dd className="inline">{dp.why}</dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">{en ? "Impact" : "Impacto"}: </dt>
                  <dd className="inline">{dp.impact}</dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">{en ? "Next action" : "Siguiente acción"}: </dt>
                  <dd className="inline font-medium">{dp.next_action}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

type ReportVersionRow = {
  id: string;
  version: number;
  created_at: string;
  document_count: number | null;
  findings_count: number | null;
  contradiction_count: number | null;
  ess: number | null;
  score: number | null;
  report_hash: string | null;
  change_log: Record<string, unknown> | null;
};

function ReportHistoryPanel({ caseId, currentVersion }: { caseId: string; currentVersion: number }) {
  const listFn = useServerFn(listReportVersions);
  const { data: versions } = useQuery({
    queryKey: ["report-versions", caseId, currentVersion],
    queryFn: async () => (await listFn({ data: { caseId } })) as ReportVersionRow[],
  });
  const rows = versions ?? [];
  if (rows.length === 0) return null;
  return (
    <Panel title="Version History" subtitle={`${rows.length} immutable snapshot${rows.length === 1 ? "" : "s"}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-muted-foreground">
            <tr className="border-b border-border">
              <th className="py-2 pr-3 text-left">Version</th>
              <th className="py-2 pr-3 text-left">Created</th>
              <th className="py-2 pr-3 text-right">Docs</th>
              <th className="py-2 pr-3 text-right">Findings</th>
              <th className="py-2 pr-3 text-right">Contradictions</th>
              <th className="py-2 pr-3 text-right">ESS</th>
              <th className="py-2 pr-3 text-right">Score</th>
              <th className="py-2 pr-3 text-left">Hash</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id} className="border-b border-border/40">
                <td className="py-2 pr-3 font-mono">v{v.version}</td>
                <td className="py-2 pr-3 text-muted-foreground">{new Date(v.created_at).toLocaleString()}</td>
                <td className="py-2 pr-3 text-right">{v.document_count ?? "—"}</td>
                <td className="py-2 pr-3 text-right">{v.findings_count ?? "—"}</td>
                <td className="py-2 pr-3 text-right">{v.contradiction_count ?? "—"}</td>
                <td className="py-2 pr-3 text-right">{v.ess ?? "—"}</td>
                <td className="py-2 pr-3 text-right">{v.score ?? "—"}</td>
                <td className="py-2 pr-3 font-mono text-xs text-muted-foreground" title={v.report_hash ?? ""}>
                  {v.report_hash ? v.report_hash.slice(0, 8) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Snapshots are immutable: the database revokes UPDATE/DELETE on report_versions. The hash column is a SHA-256
        over the canonical report content — identical hashes mean identical reports.
      </p>
    </Panel>
  );
}

function ReportTab({
  r,
  documents,
}: {
  r: Report | null | undefined;
  documents?: Array<{ id: string; filename: string }>;
}) {
  if (!r) return <Empty msg="No report generated yet. Complete the pipeline then Generate Report." />;

  // Honor ESS suppression: if the report flagged scores_suppressed or
  // motions_suppressed, never surface numeric scores or candidate motions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoresSuppressed = Boolean((r as any).scores_suppressed);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const motionsSuppressed = Boolean((r as any).motions_suppressed);
  const strength = scoresSuppressed ? null : rNum(r.case_strength_score);
  const risk = scoresSuppressed ? null : rNum(r.risk_score);
  const citations = rArr(r.citations);
  // The AI-generated snapshot (r.evidence_index) is written once, at report
  // generation time — it goes stale/thin exactly like the dashboard's
  // Evidence/Opportunities tiles did before they were fixed to fall back to
  // live data. Any uploaded document the snapshot doesn't cover (new upload
  // after the last report run, or the AI simply omitted it) is appended here
  // as a metadata-only row, same rendering already used below for a row the
  // AI classified without a summary — so the index always reflects every
  // document actually in the case, not just what the last report run wrote.
  const reportEvidenceIndex = rArr(r.evidence_index);
  const indexedDocIds = new Set(
    reportEvidenceIndex.map((e) => rStr((e as Record<string, unknown> | null)?.document_id)).filter(Boolean),
  );
  const missingDocs = (documents ?? []).filter((d) => !indexedDocIds.has(d.id));
  const evidenceIndex = [
    ...reportEvidenceIndex,
    ...missingDocs.map((d, i) => ({
      doc_n: reportEvidenceIndex.length + i + 1,
      document_id: d.id,
      filename: d.filename,
      role: "neutral",
      key_pages: [],
      summary: "",
      summary_source: "metadata_only",
    })),
  ];
  const contradictionsAll = rArr(r.contradictions_struct);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const disputedIssues = rArr(((r.full_report as any) ?? {}).disputed_issues);
  const contradictions = contradictionsAll;
  const missing = rArr(r.missing_evidence_struct);
  const constIssues = rArr(r.constitutional_issues_struct);
  const motions = motionsSuppressed ? [] : rArr(r.motion_opportunities);
  const crossExam = rArr(r.cross_examination);
  const strategy = rArr(r.strategy_recommendations);
  const nextActions = rArr(r.next_actions);

  const hasIntel =
    strength != null ||
    risk != null ||
    citations.length > 0 ||
    contradictions.length > 0 ||
    disputedIssues.length > 0 ||
    missing.length > 0 ||
    constIssues.length > 0 ||
    motions.length > 0 ||
    crossExam.length > 0 ||
    strategy.length > 0 ||
    nextActions.length > 0;

  // Build module projections through canonical helpers — proves every
  // section of this view is reading the single source of truth.
  const projections = [
    {
      module: "Dashboard / Report Tab",
      counts: {
        findings: getFindings(r).length,
        contradictions: getContradictions(r).length,
        disputed_issues: getDisputedIssues(r).length,
        missing_evidence: getMissingEvidence(r).length,
        timeline_events: getTimeline(r).length,
        witnesses: getWitnesses(r).length,
        strategies: getStrategies(r).length,
        opportunities: getOpportunities(r).length,
        motions: getMotions(r).length,
      },
    },
  ];
  const ess = getEssState(r);
  const canonicalCounts = getCanonicalCounts(r);
  void canonicalCounts; // referenced via ParityBadge

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const changeLog = (r as any).change_log as null | {
    previous_version?: number;
    current_version?: number;
    documents_total?: number;
    score_delta?: {
      strength?: { prev: number | null; now: number | null };
      risk?: { prev: number | null; now: number | null };
    };
    contradictions?: { prev: number; now: number };
    findings_total?: number;
    witnesses_total?: number;
    sections_changed?: Array<{ section: string; status: string; prev_chars?: number; now_chars?: number }>;
    drivers?: string[];
    note?: string;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const version = (r as any).version as number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qualityBlocked = Boolean((r as any).quality_blocked);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qualityBlockReasons = (((r as any).quality_block_reasons as unknown[]) ?? []) as string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const caseId = (r as any).case_id as string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const narrativeStatus = (((r.full_report as any) ?? {}).narrative_status ?? null) as {
    fully_failed?: boolean;
    partially_failed?: boolean;
    salvaged_sections?: string[];
    banner?: string | null;
  } | null;

  return (
    <div className="space-y-6">
      <ParityBadge report={r} projections={projections} />
      <ObjectivePanel r={r} />

      {narrativeStatus?.banner && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${narrativeStatus.fully_failed ? "border-red-500/50 bg-red-500/10 text-red-300" : "border-amber-500/50 bg-amber-500/10 text-amber-200"}`}
        >
          <div className="font-semibold">
            {narrativeStatus.fully_failed
              ? "Narrative Generation Unavailable"
              : "Narrative Generation Partially Recovered"}
          </div>
          <p className="mt-1">{narrativeStatus.banner}</p>
          {narrativeStatus.partially_failed && (narrativeStatus.salvaged_sections?.length ?? 0) > 0 && (
            <p className="mt-1 text-xs opacity-80">
              Recovered sections: {narrativeStatus.salvaged_sections!.join(", ")}
            </p>
          )}
        </div>
      )}
      {qualityBlocked && (
        <div className="rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <div className="font-semibold">Quality Gate Failed — Report Flagged as Draft</div>
          <ul className="mt-1 list-disc pl-5">
            {qualityBlockReasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs opacity-80">
            Resolve the issues above (re-run extraction on failed documents, or re-run analyzers/agents so every finding
            carries a doc + page + quote citation) before treating this report as final.
          </p>
        </div>
      )}
      {caseId && <ReportHistoryPanel caseId={caseId} currentVersion={version ?? 1} />}
      {changeLog && (
        <Panel
          title={`What's Changed — v${changeLog.previous_version ?? "?"} → v${changeLog.current_version ?? version ?? "?"}`}
          subtitle="Quantitative diff against the snapshot captured before the last Add Evidence run"
        >
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            <li className="rounded border border-border bg-card p-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Case Strength</div>
              <div>
                {changeLog.score_delta?.strength?.prev ?? "—"} → {changeLog.score_delta?.strength?.now ?? "—"}
              </div>
            </li>
            <li className="rounded border border-border bg-card p-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Risk Score</div>
              <div>
                {changeLog.score_delta?.risk?.prev ?? "—"} → {changeLog.score_delta?.risk?.now ?? "—"}
              </div>
            </li>
            <li className="rounded border border-border bg-card p-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Contradictions</div>
              <div>
                {changeLog.contradictions?.prev ?? 0} → {changeLog.contradictions?.now ?? 0}
              </div>
            </li>
            <li className="rounded border border-border bg-card p-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Totals (current)</div>
              <div>
                {changeLog.documents_total ?? 0} docs · {changeLog.findings_total ?? 0} findings ·{" "}
                {changeLog.witnesses_total ?? 0} witnesses
              </div>
            </li>
          </ul>
          {(changeLog.sections_changed?.length ?? 0) > 0 && (
            <div className="mt-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Secciones actualizadas / Sections revised
              </div>
              <ul className="mt-1 flex flex-wrap gap-2">
                {changeLog.sections_changed!.map((s) => {
                  const title = REPORT_SECTION_ORDER.find((x) => x.key === s.section)?.title ?? s.section;
                  return (
                    <li
                      key={s.section}
                      className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                      title={`${s.prev_chars ?? 0} → ${s.now_chars ?? 0} chars`}
                    >
                      {title} · {s.status}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {(changeLog.drivers?.length ?? 0) > 0 && (
            <div className="mt-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Por qué cambió / Why it changed
              </div>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {changeLog.drivers!.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {changeLog.note && <p className="mt-2 text-xs text-muted-foreground">{changeLog.note}</p>}
        </Panel>
      )}

      {ess.scoresSuppressed && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          Quantitative case-strength and risk scores are suppressed for this case — the evidence-sufficiency validator
          did not reach the threshold required for reliable scoring. Upload more source documents to enable scoring.
        </div>
      )}
      {ess.motionsSuppressed && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          Motion recommendations are suppressed for this case — evidence sufficiency did not reach the threshold
          required to recommend motions.
        </div>
      )}
      {disputedIssues.length > 0 && (
        <Panel title="Disputed Issues Between Parties" subtitle="Party positions, not factual contradictions">
          <ul className="space-y-2">
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {(disputedIssues as any[]).map((d, i) => (
              <li key={i} className="rounded-md border border-border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <ClaimBadge hint="analysis" />
                  <span className="font-medium">{rStr(d?.title, "Disputed issue")}</span>
                </div>
                {d?.description && <div className="mt-1 text-foreground/80">{rStr(d.description)}</div>}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {(strength != null || risk != null) && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ScoreCard label="Case Strength" value={strength} tone="good" />
          <ScoreCard label="Risk Score" value={risk} tone="risk" />
        </div>
      )}

      {nextActions.length > 0 && (
        <Panel title="Recommended Next Actions" subtitle="Prioritized">
          <ol className="space-y-2">
            {nextActions.map((a, i) => (
              <li key={i} className="rounded-md border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-xs font-semibold text-accent">
                    {a?.order ?? i + 1}
                  </span>
                  <span className="font-medium">{rStr(a?.action, "Action")}</span>
                  {a?.owner && (
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {rStr(a.owner)}
                    </span>
                  )}
                  {a?.deadline_hint && <span className="text-xs text-muted-foreground">· {rStr(a.deadline_hint)}</span>}
                </div>
                {a?.why && <div className="mt-1 text-sm text-foreground/80">{rStr(a.why)}</div>}
              </li>
            ))}
          </ol>
        </Panel>
      )}

      {motions.length > 0 && (
        <Panel title="Motion Opportunities">
          <div className="space-y-3">
            {motions.map((m, i) => (
              <div key={i} className="rounded-md border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ClaimBadge hint="strategy" />
                  <span className="font-semibold">{rStr(m?.motion, "Motion")}</span>
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    likelihood: {rStr(m?.likelihood_of_success, "?")}
                  </span>
                </div>
                {m?.basis && (
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">Basis: </span>
                    {rStr(m.basis)}
                  </div>
                )}
                {m?.supporting_facts && (
                  <div className="mt-1 text-sm text-foreground/80">{rStr(m.supporting_facts)}</div>
                )}
                {Array.isArray(m?.elements) && m.elements.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-sm">
                    {m.elements.map((e: unknown, j: number) => (
                      <li key={j}>{rStr(e)}</li>
                    ))}
                  </ul>
                )}
                {m?.draft_outline && (
                  <div className="mt-2 whitespace-pre-wrap rounded bg-secondary/40 p-2 text-xs">
                    {rStr(m.draft_outline)}
                  </div>
                )}
                {Array.isArray(m?.citations) && m.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {m.citations.map((c: unknown, j: number) => (
                      <Cite key={j} c={c} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {contradictions.length > 0 && (
        <Panel title="Contradictions" subtitle="With legal impact">
          <div className="space-y-3">
            {contradictions.map((c, i) => (
              <div key={i} className="rounded-md border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ClaimBadge hint="fact" />
                  <SevBadge s={rStr(c?.severity)} />
                  <span className="font-semibold">{rStr(c?.title, "Contradiction")}</span>
                  {c?.side_helped && (
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      helps {rStr(c.side_helped)}
                    </span>
                  )}
                </div>
                {c?.description && <div className="mt-1 text-sm">{rStr(c.description)}</div>}
                {c?.legal_impact && (
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">Legal impact: </span>
                    {rStr(c.legal_impact)}
                  </div>
                )}
                {c?.recommended_use && (
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">Use: </span>
                    {rStr(c.recommended_use)}
                  </div>
                )}
                {Array.isArray(c?.citations) && c.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {c.citations.map((cc: unknown, j: number) => (
                      <Cite key={j} c={cc} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {missing.length > 0 && (
        <Panel title="Evidencia Faltante">
          <div className="space-y-2">
            {missing.map((m, i) => (
              <div key={i} className="rounded-md border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ClaimBadge hint="hypothesis" />
                  <SevBadge s={rStr(m?.severity)} />
                  <span className="font-semibold">{rStr(m?.item, "Elemento faltante")}</span>
                  {m?.omision_probatoria_risk && (
                    <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-700">
                      Riesgo Probatorio
                    </span>
                  )}
                </div>
                {m?.why_critical && <div className="mt-1 text-sm">{rStr(m.why_critical)}</div>}
                {m?.how_to_obtain && (
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">How to obtain: </span>
                    {rStr(m.how_to_obtain)}
                  </div>
                )}
                {m?.recommended_motion && (
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">Motion: </span>
                    {rStr(m.recommended_motion)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {constIssues.length > 0 && (
        <Panel title="Cuestiones Constitucionales">
          <div className="space-y-3">
            {constIssues.map((c, i) => (
              <div key={i} className="rounded-md border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{rStr(c?.right, "Cuestión")}</span>
                  {c?.articulo_cpeum && (
                    <span className="rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {rStr(c.articulo_cpeum)}
                    </span>
                  )}
                </div>
                {c?.issue && <div className="mt-1 text-sm">{rStr(c.issue)}</div>}
                {c?.legal_standard && (
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">Standard: </span>
                    {rStr(c.legal_standard)}
                  </div>
                )}
                {c?.likely_outcome && (
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">Probability estimate: </span>
                    {rStr(c.likely_outcome)}
                  </div>
                )}
                {c?.remedy_sought && (
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">Remedy: </span>
                    {rStr(c.remedy_sought)}
                  </div>
                )}
                {Array.isArray(c?.citations) && c.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {c.citations.map((cc: unknown, j: number) => (
                      <Cite key={j} c={cc} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {crossExam.length > 0 && (
        <Panel title="Cross-Examination Plan">
          <div className="space-y-3">
            {crossExam.map((w, i) => (
              <div key={i} className="rounded-md border border-border bg-card p-3">
                <div className="font-semibold">{rStr(w?.witness, "Witness")}</div>
                {w?.objective && <div className="text-xs text-muted-foreground">{rStr(w.objective)}</div>}
                {rArr(w?.lines).map((ln, j) => (
                  <div key={j} className="mt-2 rounded border border-border bg-secondary/30 p-2">
                    {ln?.topic && (
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {rStr(ln.topic)}
                      </div>
                    )}
                    <ol className="mt-1 list-decimal pl-5 text-sm">
                      {rArr(ln?.questions).map((q: unknown, k: number) => (
                        <li key={k}>{rStr(q)}</li>
                      ))}
                    </ol>
                    {ln?.impeachment_with && (
                      <div className="mt-1 text-xs">
                        <span className="text-muted-foreground">Impeach with: </span>
                        {rStr(ln.impeachment_with)}
                      </div>
                    )}
                    {ln?.citation && (
                      <div className="mt-1">
                        <Cite c={ln.citation} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {strategy.length > 0 && (
        <Panel title="Strategy Recommendations">
          <div className="space-y-2">
            {strategy.map((s, i) => (
              <div key={i} className="rounded-md border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SevBadge s={rStr(s?.priority)} />
                  <span className="font-semibold">{rStr(s?.title)}</span>
                  {s?.category && (
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {rStr(s.category)}
                    </span>
                  )}
                </div>
                {s?.rationale && <div className="mt-1 text-sm">{rStr(s.rationale)}</div>}
                {s?.expected_impact && (
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">Impact: </span>
                    {rStr(s.expected_impact)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {evidenceIndex.length > 0 && (
        <Panel title="Evidence Source Index">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="p-2">Doc</th>
                  <th className="p-2">File</th>
                  <th className="p-2">Role</th>
                  <th className="p-2">Key pages</th>
                  <th className="p-2">Summary</th>
                </tr>
              </thead>
              <tbody>
                {evidenceIndex.map((e, i) => {
                  const summarySource = rStr(e?.summary_source);
                  const summary = rStr(e?.summary);
                  const pageCount = rNum(e?.page_count);
                  const filename = rStr(e?.filename);
                  const isMetaOnly = summarySource === "metadata_only" || (!summary && pageCount != null);
                  const rendered = isMetaOnly
                    ? `${filename || "Unnamed document"} — ${pageCount ?? "?"} page${pageCount === 1 ? "" : "s"} — no AI classification available this run`
                    : summary;
                  return (
                    <tr key={i} className="border-t border-border">
                      <td className="p-2 font-mono">DOC {String(e?.doc_n ?? "?")}</td>
                      <td className="p-2">{filename}</td>
                      <td className="p-2">
                        <SevBadge s={rStr(e?.role)} />
                      </td>
                      <td className="p-2 font-mono">{rArr(e?.key_pages).join(", ")}</td>
                      <td className={`p-2 ${isMetaOnly ? "italic text-muted-foreground" : ""}`}>{rendered}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {citations.length > 0 && (
        <Panel title="All Citations" subtitle={`${citations.length} source references`}>
          <div className="flex flex-wrap gap-2">
            {citations.map((c, i) => (
              <Cite key={i} c={c} />
            ))}
          </div>
        </Panel>
      )}

      {!hasIntel && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800">
          This report was generated before the litigation-intelligence upgrade. Re-run "Generate Report" to populate
          citations, motions, cross-exam, and risk scores.
        </div>
      )}

      {(() => {
        // Executive Summary and Attorney Summary render first; the
        // Litigation Impact Dashboard and Litigation Command Center render
        // immediately after them; every other report section follows in
        // its original order.
        const LEAD_KEYS = ["executive_summary", "attorney_summary"];
        const fullR = (r.full_report ?? {}) as Record<string, unknown>;
        const ct = typeof fullR.case_type === "string" ? fullR.case_type : "general_civil";
        // FIX: this previously checked `ct === "penal" || ct === "criminal" ||
        // ct === "civil_rights"` — "criminal" and "civil_rights" are stale
        // pre-Mexico-rewrite slugs that don't exist in MX_CASE_TYPES, so the
        // check matched ONLY "penal" in practice. That silently hid the
        // Constitutional Issues section for amparo and constitucional cases
        // even though pipeline.server.ts's isCriminalOrCivilRights (the
        // server-side gate that actually decides whether to generate this
        // content) already correctly includes penal, amparo, AND
        // constitucional — so the AI was generating real constitutional
        // analysis for those two materias and the UI was throwing it away.
        // Mirrors isCriminalOrCivilRights exactly.
        const constitutionalRelevant = ct === "penal" || ct === "amparo" || ct === "constitucional";
        // Tolerant lookup: `ct` falls back to the literal "general_civil"
        // above when full_report.case_type is missing (e.g. legacy reports
        // generated before that field was stamped), which is not a real
        // materia — resolveMxProfile/requireMxProfile would throw on it and
        // take down the whole Report tab (blank page). mxProfileOrNull
        // degrades to the generic title instead.
        const profile = mxProfileOrNull(ct);
        const roles = profile ? MX_PARTY_ROLES[profile] : null;
        const renderSection = (key: string, title: string) => {
          const body = rStr(r[key]);
          if (!body) return null;
          if (key === "constitutional_issues" && !constitutionalRelevant) return null;
          // Relabel the theory sections with this materia's real Mexican
          // party roles instead of the old binary "Prosecution/Defense" vs.
          // flat "Plaintiff/Defense" fallback, which mislabeled every
          // non-penal materia (laboral, familiar, administrativo, fiscal,
          // amparo, etc.) as a generic civil "Plaintiff" even though each
          // has its own real procedural role vocabulary (trabajador/patrón,
          // quejoso/autoridad_responsable, contribuyente/autoridad_fiscal...).
          // Penal keeps its existing "Prosecution Theory"/"Defense Theory"
          // titles unchanged — those are already correct.
          const renderedTitle =
            ct === "penal" || !roles
              ? title
              : key === "prosecution_theory_report"
                ? `${mxRoleLabel(roles.a)} Theory`
                : key === "defense_theory_report"
                  ? `${mxRoleLabel(roles.b)} Theory`
                  : title;
          return (
            <div key={key} className="rounded-lg border border-border bg-card p-5">
              <h3 className="text-lg font-semibold">{renderedTitle}</h3>
              <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{body}</div>
            </div>
          );
        };
        const lead = REPORT_SECTION_ORDER.filter((s) => LEAD_KEYS.includes(s.key));
        const rest = REPORT_SECTION_ORDER.filter((s) => !LEAD_KEYS.includes(s.key));
        return (
          <>
            {lead.map(({ key, title }) => renderSection(key, title))}
            <LitigationImpactDashboardSection report={r} />
            <LitigationCommandCenterSection report={r} />
            {rest.map(({ key, title }) => renderSection(key, title))}
          </>
        );
      })()}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function Pre({ v, className }: { v: unknown; className?: string }) {
  return (
    <pre
      className={`max-h-96 overflow-auto whitespace-pre-wrap rounded bg-secondary/40 p-3 text-xs text-foreground/90 ${className ?? ""}`}
    >
      {v == null ? "—" : typeof v === "string" ? v : JSON.stringify(v, null, 2)}
    </pre>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/40 p-10 text-center text-sm text-muted-foreground">
      {msg}
    </div>
  );
}

function InlineCancelButton({ caseId, invalidate }: { caseId: string; invalidate: () => void }) {
  const cancel = useServerFn(requestCancel);
  const force = useServerFn(forceCancelCase);
  const [requested, setRequested] = useState(false);
  const m = useMutation({
    mutationFn: () => cancel({ data: { caseId } }),
    onSuccess: () => {
      setRequested(true);
      toast.info("Cancel requested — aborting in-flight request");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Cancel failed"),
  });
  const fm = useMutation({
    mutationFn: () => force({ data: { caseId } }),
    onSuccess: () => {
      // Explicit stop is the only thing that kills the background loop.
      stopDrivingPipeline(caseId);
      toast.success("Job force-stopped. You can restart any step now.");
      setRequested(false);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Force-stop failed"),
  });
  return (
    <div className="ml-2 inline-flex items-center gap-1">
      <button
        onClick={() => m.mutate()}
        disabled={m.isPending || requested}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-secondary disabled:opacity-50"
      >
        <Trash2 className="h-3 w-3" /> {requested ? "Cancelling…" : "Cancel"}
      </button>
      {requested && (
        <button
          onClick={() => fm.mutate()}
          disabled={fm.isPending}
          className="inline-flex items-center gap-1 rounded-md border border-destructive bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
          title="Hard-stop the job if it doesn't respond to a graceful cancel"
        >
          Force stop
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Strategic Findings — ranked view of priority 1–2 findings with neutral
// classification chips. Pure presentation; reads CASE_STATE.
// ---------------------------------------------------------------------------
function ChipBadge({ label, tone }: { label: string; tone: "neutral" | "warn" | "danger" | "success" | "accent" }) {
  const cls =
    tone === "danger"
      ? "bg-destructive/15 text-destructive border-destructive/30"
      : tone === "warn"
        ? "bg-warning/15 text-warning border-warning/30"
        : tone === "success"
          ? "bg-success/15 text-success border-success/30"
          : tone === "accent"
            ? "bg-accent/15 text-accent border-accent/30"
            : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function StrategicFindingsTab({ findings }: { findings: any[] }) {
  const ranked = (findings ?? [])
    .filter((f) => (f.priority ?? 4) <= 3)
    .slice()
    .sort((a, b) => (a.priority ?? 4) - (b.priority ?? 4));
  if (ranked.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/40 p-10 text-center text-sm text-muted-foreground">
        No ranked strategic findings yet. Run analyzers and intelligence engines to surface them.
      </div>
    );
  }
  const pLabel = (p: number) =>
    p === 1 ? "P1 · Case-Dispositive" : p === 2 ? "P2 · Admissibility" : p === 3 ? "P3 · Credibility" : "P4";
  const pTone = (p: number): "danger" | "warn" | "accent" | "neutral" =>
    p === 1 ? "danger" : p === 2 ? "warn" : p === 3 ? "accent" : "neutral";
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
        Ranked by legal impact. Strongest findings first — not order of discovery.
      </div>
      {ranked.map((f) => (
        <div key={f.id} className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ChipBadge label={pLabel(f.priority ?? 4)} tone={pTone(f.priority ?? 4)} />
            {f.evidence_type && (
              <ChipBadge
                label={f.evidence_type}
                tone={
                  f.evidence_type === "inculpatory"
                    ? "danger"
                    : f.evidence_type === "exculpatory"
                      ? "success"
                      : "accent"
                }
              />
            )}
            {f.impact_direction && (
              <ChipBadge
                label={f.impact_direction}
                tone={
                  f.impact_direction === "weakens"
                    ? "danger"
                    : f.impact_direction === "strengthens"
                      ? "success"
                      : "neutral"
                }
              />
            )}
            {f.affected_party && <ChipBadge label={`affects ${f.affected_party}`} tone="neutral" />}
            {f.severity && (
              <ChipBadge
                label={f.severity}
                tone={f.severity === "critical" || f.severity === "high" ? "danger" : "neutral"}
              />
            )}
          </div>
          <div className="mt-2 text-base font-semibold">{f.title}</div>
          {f.strategic_significance && <p className="mt-1 text-sm italic text-accent">{f.strategic_significance}</p>}
          {f.description && <p className="mt-2 text-sm text-muted-foreground">{f.description}</p>}
          {f.source_quote && (
            <blockquote className="mt-3 border-l-2 border-accent/40 pl-3 text-xs text-muted-foreground">
              “{String(f.source_quote).slice(0, 360)}”
            </blockquote>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legal Attack Surface — seven attack lanes derived from CASE_STATE.
// ---------------------------------------------------------------------------
const ATTACK_LANES: Array<{ k: string; label: string; tone: "danger" | "warn" | "accent" }> = [
  { k: "exclusion_opportunities", label: "Oportunidades de Exclusión Probatoria", tone: "danger" },
  { k: "impeachment_opportunities", label: "Oportunidades de Impugnación", tone: "warn" },
  { k: "omision_probatoria_risks", label: "Riesgos de Omisión Probatoria", tone: "danger" },
  { k: "cateo_irregular_risks", label: "Riesgos de Cateo Irregular", tone: "danger" },
  { k: "chain_of_custody_challenges", label: "Impugnaciones a la Cadena de Custodia", tone: "warn" },
  { k: "fundamentacion_probatoria_challenges", label: "Impugnaciones a la Fundamentación Probatoria", tone: "accent" },
  { k: "impugnacion_pericial_challenges", label: "Impugnaciones Periciales", tone: "accent" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function AttackSurfaceTab({ surface }: { surface: any }) {
  if (!surface || typeof surface !== "object") {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/40 p-10 text-center text-sm text-muted-foreground">
        Attack surface will be generated during the report stage. Run Litigation Report to populate.
      </div>
    );
  }
  if (surface.skipped) {
    return (
      <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 p-6 text-sm">
        <div className="font-semibold text-amber-400">Skipped — Not Applicable</div>
        <div className="mt-1 text-muted-foreground">
          {surface.reason ??
            "Attack Surface categories are criminal-procedure specific and not applicable to this case type."}
        </div>
      </div>
    );
  }
  const populated = ATTACK_LANES.filter((l) => Array.isArray(surface[l.k]) && surface[l.k].length > 0);
  if (populated.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/40 p-10 text-center text-sm text-muted-foreground">
        No attack-surface items derived from current findings.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
        Derived deterministically from CASE_STATE — every item links back to a finding. No new analysis is performed
        here.
      </div>
      {populated.map((lane) => (
        <div key={lane.k} className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-base font-semibold">{lane.label}</h3>
            <ChipBadge
              label={`${surface[lane.k].length} item${surface[lane.k].length === 1 ? "" : "s"}`}
              tone={lane.tone}
            />
          </div>
          <ul className="space-y-2">
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {(surface[lane.k] as any[]).slice(0, 20).map((it) => (
              <li key={it.finding_id} className="rounded-md border border-border bg-background/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {it.priority && (
                    <ChipBadge
                      label={`P${it.priority}`}
                      tone={it.priority === 1 ? "danger" : it.priority === 2 ? "warn" : "neutral"}
                    />
                  )}
                  {it.severity && (
                    <ChipBadge
                      label={it.severity}
                      tone={it.severity === "critical" || it.severity === "high" ? "danger" : "neutral"}
                    />
                  )}
                  {it.evidence_type && <ChipBadge label={it.evidence_type} tone="accent" />}
                </div>
                <div className="mt-1 text-sm font-medium">{it.title}</div>
                {it.source_quote && (
                  <blockquote className="mt-1 border-l-2 border-accent/40 pl-3 text-xs text-muted-foreground">
                    “{String(it.source_quote).slice(0, 240)}”
                  </blockquote>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
