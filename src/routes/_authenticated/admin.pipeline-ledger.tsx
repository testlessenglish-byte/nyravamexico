import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { pipelineLedger } from "@/lib/cases.functions";
import { useState, useMemo } from "react";
import { Activity, ChevronLeft, RefreshCw, Filter, CheckCircle2, XCircle, MinusCircle, SkipForward } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/pipeline-ledger")({
  head: () => ({ meta: [{ title: "Pipeline Ledger — Admin — Nyrava" }] }),
  errorComponent: ({ error, reset }) => {
    const router = useRouter();
    return (
      <div className="mx-auto max-w-2xl p-10">
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-6">
          <h2 className="text-lg font-semibold text-destructive">Couldn't load pipeline ledger</h2>
          <p className="mt-2 text-sm text-destructive/90">{error instanceof Error ? error.message : String(error)}</p>
          <button
            onClick={() => { reset(); void router.invalidate(); }}
            className="mt-4 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted"
          >
            Retry
          </button>
        </div>
      </div>
    );
  },
  notFoundComponent: () => <div className="p-10">Not found.</div>,
  component: PipelineLedgerPage,
});

type StatusKey = "completed" | "failed" | "blocked" | "skipped" | "running" | "queued";

function PipelineLedgerPage() {
  const fetchLedger = useServerFn(pipelineLedger);
  const [status, setStatus] = useState<StatusKey | "">("");
  const [engine, setEngine] = useState("");
  const [provider, setProvider] = useState("");
  const [caseId, setCaseId] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["pipelineLedger", status, engine, provider, caseId],
    queryFn: () =>
      fetchLedger({
        data: {
          ...(status ? { status } : {}),
          ...(engine ? { engine } : {}),
          ...(provider ? { provider } : {}),
          ...(caseId ? { caseId } : {}),
          limit: 200,
        },
      }),
    refetchInterval: 15000,
  });

  const runs = data?.runs ?? [];
  const summary = data?.summary;

  const engineOptions = useMemo(
    () => Array.from(new Set(runs.map((r) => (r as { engine: string }).engine))).sort(),
    [runs],
  );
  const providerOptions = useMemo(
    () =>
      Array.from(new Set(runs.map((r) => (r as { provider?: string | null }).provider).filter(Boolean))).sort() as string[],
    [runs],
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-10">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link
            to="/admin"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs hover:bg-muted"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Admin
          </Link>
          <Activity className="h-6 w-6 text-accent" />
          <h1 className="text-2xl font-semibold md:text-3xl">Pipeline ledger</h1>
        </div>
        <button
          onClick={() => void refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
        Every engine execution across every case — with provider, model, tokens, cost, latency,
        retries, persistence confirmation, and error trace. This is the enterprise observability
        surface for the pipeline.
      </p>

      {summary && (
        <div className="mt-6 grid gap-3 md:grid-cols-4 lg:grid-cols-6">
          <StatCard label="Runs" value={summary.totalRuns.toLocaleString()} />
          <StatCard label="Completed" value={String(summary.byStatus.completed ?? 0)} tone="success" />
          <StatCard label="Failed" value={String(summary.byStatus.failed ?? 0)} tone="destructive" />
          <StatCard label="Blocked / Skipped" value={String((summary.byStatus.blocked ?? 0) + (summary.byStatus.skipped ?? 0))} tone="warning" />
          <StatCard label="Tokens" value={summary.totalTokens.toLocaleString()} />
          <StatCard label="Cost (USD)" value={`$${summary.totalCost.toFixed(4)}`} />
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs uppercase tracking-wider text-muted-foreground">Filters</span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusKey | "")}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="blocked">Blocked</option>
          <option value="skipped">Skipped</option>
          <option value="running">Running</option>
          <option value="queued">Queued</option>
        </select>
        <select
          value={engine}
          onChange={(e) => setEngine(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">All engines</option>
          {engineOptions.map((e) => (<option key={e} value={e}>{e}</option>))}
        </select>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">All providers</option>
          {providerOptions.map((p) => (<option key={p} value={p}>{p}</option>))}
        </select>
        <input
          value={caseId}
          onChange={(e) => setCaseId(e.target.value.trim())}
          placeholder="Filter by case_id (uuid)"
          className="min-w-[280px] flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
        />
        {(status || engine || provider || caseId) && (
          <button
            onClick={() => { setStatus(""); setEngine(""); setProvider(""); setCaseId(""); }}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
          >
            Clear
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="mt-8 p-10 text-center text-muted-foreground">Loading ledger…</div>
      ) : error ? (
        <div className="mt-8 rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-sm text-destructive">
          {(error as Error).message}
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Engine</th>
                <th className="px-3 py-2 text-left font-medium">Case</th>
                <th className="px-3 py-2 text-left font-medium">Provider / Model</th>
                <th className="px-3 py-2 text-right font-medium">Tokens</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">Latency</th>
                <th className="px-3 py-2 text-right font-medium">Retries</th>
                <th className="px-3 py-2 text-center font-medium">Persist</th>
                <th className="px-3 py-2 text-left font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                    No engine runs match these filters.
                  </td>
                </tr>
              )}
              {runs.map((raw) => {
                const r = raw as {
                  id: string; case_id: string; engine: string; status: string;
                  provider: string | null; model: string | null;
                  tokens_in: number; tokens_out: number; cost_usd: number;
                  runtime_ms: number | null; retry_count: number;
                  db_write_confirmed: boolean | null; rows_written: number | null;
                  error: string | null; created_at: string;
                  prompt_version: string | null; skipped_reason: string | null;
                  dependency_status: string | null; meta: unknown;
                };
                const isOpen = expanded === r.id;
                const totalTokens = (r.tokens_in ?? 0) + (r.tokens_out ?? 0);
                return (
                  <>
                    <tr
                      key={r.id}
                      onClick={() => setExpanded(isOpen ? null : r.id)}
                      className="cursor-pointer border-t border-border hover:bg-muted/30"
                    >
                      <td className="px-3 py-2"><StatusPill status={r.status} /></td>
                      <td className="px-3 py-2 font-medium">{r.engine}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        <Link
                          to="/cases/$caseId"
                          params={{ caseId: r.case_id }}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:text-foreground hover:underline"
                        >
                          {r.case_id.slice(0, 8)}…
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div className="text-foreground">{r.provider ?? "—"}</div>
                        <div className="font-mono text-muted-foreground">{r.model ?? "—"}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {totalTokens > 0 ? totalTokens.toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {r.cost_usd > 0 ? `$${Number(r.cost_usd).toFixed(4)}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.runtime_ms != null ? `${r.runtime_ms} ms` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.retry_count > 0 ? r.retry_count : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <PersistPill confirmed={r.db_write_confirmed} rows={r.rows_written} status={r.status} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleString()}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-border bg-muted/20">
                        <td colSpan={10} className="px-4 py-4">
                          <div className="grid gap-4 text-xs md:grid-cols-2">
                            <div className="space-y-1">
                              <Field k="run_id" v={r.id} mono />
                              <Field k="case_id" v={r.case_id} mono />
                              <Field k="prompt_version" v={r.prompt_version ?? "—"} mono />
                              <Field k="dependency_status" v={r.dependency_status ?? "—"} />
                              <Field k="skipped_reason" v={r.skipped_reason ?? "—"} />
                              <Field k="rows_written" v={r.rows_written != null ? String(r.rows_written) : "—"} />
                            </div>
                            <div className="space-y-1">
                              {r.error && (
                                <div>
                                  <div className="mb-1 text-xs uppercase tracking-wider text-destructive">Error</div>
                                  <pre className="max-h-32 overflow-auto rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive whitespace-pre-wrap">{r.error}</pre>
                                </div>
                              )}
                              {Boolean(r.meta) && Object.keys((r.meta as object) ?? {}).length > 0 && (
                                <div>
                                  <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">meta (telemetry + replay hints)</div>
                                  <pre className="max-h-64 overflow-auto rounded border border-border bg-background p-2 text-[10px] leading-relaxed">{JSON.stringify(r.meta, null, 2)}</pre>
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { icon: React.ElementType; cls: string }> = {
    completed: { icon: CheckCircle2, cls: "bg-success/15 text-success border-success/30" },
    failed:    { icon: XCircle,      cls: "bg-destructive/15 text-destructive border-destructive/30" },
    blocked:   { icon: MinusCircle,  cls: "bg-warning/15 text-warning border-warning/30" },
    skipped:   { icon: SkipForward,  cls: "bg-muted text-muted-foreground border-border" },
    running:   { icon: Activity,     cls: "bg-accent/15 text-accent border-accent/30" },
    queued:    { icon: Activity,     cls: "bg-muted text-muted-foreground border-border" },
  };
  const { icon: Icon, cls } = map[status] ?? { icon: MinusCircle, cls: "bg-muted text-muted-foreground border-border" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon className="h-3 w-3" /> {status}
    </span>
  );
}

function PersistPill({ confirmed, rows, status }: { confirmed: boolean | null; rows: number | null; status: string }) {
  if (status !== "completed") return <span className="text-xs text-muted-foreground">—</span>;
  if (confirmed === true) {
    return <span className="inline-flex items-center gap-1 text-xs text-success" title={rows != null ? `${rows} rows` : undefined}>
      <CheckCircle2 className="h-3.5 w-3.5" /> {rows != null ? rows : "ok"}
    </span>;
  }
  if (confirmed === false) return <span className="inline-flex items-center gap-1 text-xs text-destructive"><XCircle className="h-3.5 w-3.5" /> no</span>;
  return <span className="text-xs text-muted-foreground">?</span>;
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" | "destructive" }) {
  const color = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "destructive" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-32 shrink-0 text-muted-foreground">{k}</span>
      <span className={mono ? "font-mono break-all" : "break-words"}>{v}</span>
    </div>
  );
}
