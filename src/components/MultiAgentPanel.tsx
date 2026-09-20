// Visual panel for the multi-agent pipeline.
// Lets the user trigger runMultiAgentAnalysis and watch agent_logs roll in.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader as Loader2, CircleCheck as CheckCircle2, CircleAlert as AlertCircle, Circle, ShieldCheck, ShieldAlert, Play } from "lucide-react";
import { runMultiAgentAnalysis, getAgentLogs } from "@/lib/agents/multi-agent.functions";
import { checkIsAdmin } from "@/lib/cases.functions";
import { AGENT_DEFINITIONS } from "@/lib/agents/types";
import { supabase } from "@/integrations/supabase/client";
import { getAgentSummary, type AgentSummary } from "@/lib/intelligence/canonical";
import { useI18n } from "@/i18n";


type LogRow = {
  agent_key: string;
  agent_index: number;
  agent_name: string;
  status: string;
  confidence: number | null;
  processing_time_ms: number | null;
  output_file: string | null;
  documents_analyzed?: number | null;
  findings_generated?: number | null;
  findings_suppressed?: number | null;
  findings_promoted?: number | null;
  findings_produced?: number | null;
  output_items?: number | null;
  no_output_reason?: string | null;
  errors: unknown;
  finished_at: string | null;
};

function localizedAgentMessage(
  message: string,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  const normalized = message.trim();
  if (/^Nothing found in supplied evidence\.?$/i.test(normalized)) {
    return t("agents.reason.nothingFound");
  }
  if (/^No output produced\.?$/i.test(normalized)) {
    return t("agents.reason.noOutput");
  }
  const suppressed = normalized.match(/^(\d+) candidate finding\(s\) generated but suppressed by validation\.?$/i);
  if (suppressed) {
    return t("agents.reason.suppressed", { count: suppressed[1] });
  }
  if (/^No canonical findings available for the report\.?$/i.test(normalized)) {
    return t("agents.reason.noCanonicalFindings");
  }
  if (/^No findings to support the report\.?$/i.test(normalized)) {
    return t("agents.reason.noSupportingFindings");
  }
  if (/^No completed report to review\.?$/i.test(normalized)) {
    return t("agents.reason.noCompletedReport");
  }
  if (/^Scoring stage has not completed;/i.test(normalized)) {
    return t("agents.reason.scoringIncomplete");
  }
  return normalized;
}

function statusIcon(status: string) {
  if (status === "success") return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  if (status === "failed") return <AlertCircle className="h-4 w-4 text-destructive" />;
  if (status === "blocked") return <ShieldAlert className="h-4 w-4 text-warning" />;
  if (status === "skipped") return <Circle className="h-4 w-4 text-muted-foreground" />;
  return <Circle className="h-4 w-4 text-muted-foreground/70" />;
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone: "slate" | "cyan" | "emerald" | "amber" }) {
  const toneClass =
    tone === "cyan" ? "text-primary" :
    tone === "emerald" ? "text-success" :
    tone === "amber" ? "text-warning" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</p>
      <p className={`text-xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}


export function MultiAgentPanel({ caseId, report }: { caseId: string; report?: unknown }) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const runFn = useServerFn(runMultiAgentAnalysis);
  const logsFn = useServerFn(getAgentLogs);
  const adminFn = useServerFn(checkIsAdmin);
  const [running, setRunning] = useState(false);

  // Production users never trigger the multi-agent phase manually — it runs
  // automatically as the final pipeline stage. Only admins see the button
  // (for debugging / re-running after an interrupted release gate).
  const { data: adminInfo } = useQuery({
    queryKey: ["isAdmin"],
    queryFn: () => adminFn(),
    staleTime: 5 * 60 * 1000,
  });
  const isAdmin = Boolean(adminInfo?.isAdmin);

  const { data } = useQuery({
    queryKey: ["agent-logs", caseId],
    queryFn: () => logsFn({ data: { caseId } }),
    refetchInterval: running ? 2000 : false,
  });

  // Realtime: refetch when new rows land.
  useEffect(() => {
    const ch = supabase
      .channel(`agent_logs:${caseId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_logs", filter: `case_id=eq.${caseId}` },
        () => qc.invalidateQueries({ queryKey: ["agent-logs", caseId] }),
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [caseId, qc]);

  const mut = useMutation({
    mutationFn: () => runFn({ data: { caseId } }),
    onMutate: () => setRunning(true),
    onSuccess: (res) => {
      setRunning(false);
      qc.invalidateQueries({ queryKey: ["agent-logs", caseId] });
      if (res.released) {
        toast.success(t("agents.toast.released"));
      } else {
        toast.warning(t("agents.toast.gate"));
      }
    },
    onError: (e) => {
      setRunning(false);
      toast.error(e instanceof Error ? e.message : t("agents.toast.failed"));
    },
  });

  const logs = (data?.logs ?? []) as LogRow[];
  const byKey = new Map(logs.map((r) => [r.agent_key, r]));

  // Prefer the canonical AgentSummary from the persisted report — that's
  // the single source of truth the top-nav badge, Dashboard, and PDF
  // export all read from. Fall back to live log-derived counts only while
  // a run is in progress and no report snapshot exists yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canonical = getAgentSummary((report ?? null) as any);
  const derived: AgentSummary = {
    loaded: AGENT_DEFINITIONS.length,
    executed: logs.filter((r) => ["success", "completed", "skipped"].includes(r.status) && ((r.output_items ?? 0) > 0 || (r.findings_produced ?? 0) > 0 || !!r.no_output_reason)).length,
    producingOutput: logs.filter((r) => (r.findings_produced ?? 0) > 0 || (r.output_items ?? 0) > 0).length,
    producingFindings: logs.filter((r) => (r.findings_produced ?? 0) > 0).length,
    suppressedFindings: logs.reduce((sum, r) => sum + Number(r.findings_suppressed ?? 0), 0),
    visibleFindings: logs.reduce((sum, r) => sum + Number(r.findings_produced ?? 0), 0),
  };
  // Field-wise max, not an all-or-nothing switch: `canonical` (the report's
  // persisted agent_statistics snapshot) and `derived` (live agent_logs) can
  // each independently lag the other by a render or two around the report-
  // completion transition — e.g. `report` hasn't refetched yet right when
  // the pipeline flips to "complete". Taking the max per field means a
  // momentarily-stale source can never make the panel regress below what
  // the OTHER source already confirms happened, which is the exact symptom
  // reported (13/13 agents executed mid-run → 4/13 once the report finished
  // rendering, as if agents' own completed work had been erased).
  const summary: AgentSummary = {
    loaded: Math.max(canonical.loaded, derived.loaded),
    executed: Math.max(canonical.executed, derived.executed),
    producingOutput: Math.max(canonical.producingOutput, derived.producingOutput),
    producingFindings: Math.max(canonical.producingFindings, derived.producingFindings),
    suppressedFindings: Math.max(canonical.suppressedFindings, derived.suppressedFindings),
    visibleFindings: Math.max(canonical.visibleFindings, derived.visibleFindings),
  };

  return (
    <Card className="border-primary/15 bg-background/60">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-foreground">
          <ShieldCheck className="h-5 w-5 text-primary" />
          {t("agents.title", { count: AGENT_DEFINITIONS.length })}
        </CardTitle>
        {isAdmin ? (
          <Button onClick={() => mut.mutate()} disabled={running || mut.isPending} size="sm" title={t("agents.rerun.hint")}>
            {running || mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            <span className="ml-2">{running ? t("agents.running") : t("agents.rerun")}</span>
          </Button>
        ) : (
          <span className="text-[11px] text-muted-foreground/70">{t("agents.autoNote")}</span>
        )}
      </CardHeader>
      <CardContent>
        <div className="mb-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryTile label={t("agents.tile.loaded")} value={summary.loaded} tone="slate" />
          <SummaryTile label={t("agents.tile.executed")} value={summary.executed} tone="cyan" />
          <SummaryTile label={t("agents.tile.producedOutput")} value={summary.producingOutput} tone="emerald" />
          <SummaryTile label={t("agents.tile.producedFindings")} value={summary.producingFindings} tone="emerald" />
          <SummaryTile label={t("agents.tile.visible")} value={summary.visibleFindings} tone="slate" />
          <SummaryTile label={t("agents.tile.suppressed")} value={summary.suppressedFindings} tone="amber" />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {AGENT_DEFINITIONS.map((def) => {
            const row = byKey.get(def.key);
            const status = row?.status ?? "pending";
            const errs = Array.isArray(row?.errors) ? (row?.errors as string[]) : [];
            return (
              <div
                key={def.key}
                className="flex min-w-0 items-start gap-2.5 overflow-hidden rounded-lg border border-border/60 bg-card/40 p-3"
              >
                <div className="mt-0.5 shrink-0">{statusIcon(status)}</div>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">#{def.index}</span>
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">{t(`agent.${def.key}.name`)}</span>
                  </div>
                  <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{t(`agent.${def.key}.desc`)}</p>
                  {row && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                      <span className="rounded bg-background/60 px-1.5 py-0.5">
                        {t("agents.chip.generated", { count: Number(row.findings_generated ?? 0) })}
                      </span>
                      {row.confidence != null && (
                        <span className="rounded bg-background/60 px-1.5 py-0.5">
                          {t("agents.conf", { pct: (Number(row.confidence) * 100).toFixed(0) })}
                        </span>
                      )}
                      {row.processing_time_ms != null && (
                        <span className="rounded bg-background/60 px-1.5 py-0.5">{Math.round(row.processing_time_ms)}ms</span>
                      )}
                    </div>
                  )}
                  {row?.no_output_reason && (
                    <p className="mt-1 max-h-24 max-w-full overflow-y-auto whitespace-pre-wrap break-all text-[11px] leading-4 text-warning">
                      {t("agents.noOutput", { reason: localizedAgentMessage(row.no_output_reason, t) })}
                    </p>
                  )}
                  {errs.length > 0 && (
                    <p className="mt-1 max-h-24 max-w-full overflow-y-auto whitespace-pre-wrap break-all text-[11px] leading-4 text-destructive">
                      {localizedAgentMessage(errs[0], t)}
                    </p>
                  )}
                  {isAdmin && (row?.no_output_reason || errs.length > 0) && (
                    <button
                      type="button"
                      onClick={() => mut.mutate()}
                      disabled={running || mut.isPending}
                      className="mt-1.5 inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
                      title={t("agents.rerunAll.hint")}
                    >
                      {running || mut.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3" />
                      )}
                      {t("agents.rerunAll")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
