import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  listAiProviders, upsertAiProvider, deleteAiProvider, toggleAiProvider,
  reorderAiProviders, testAiProvider, listTaskRoutes, setTaskRoute,
  getAiSecretStatus, getAiProviderHealth,
} from "@/lib/ai-admin.functions";
import { ShieldCheck, ArrowUp, ArrowDown, Plus, Trash2, Power, Activity, KeyRound, Loader2, CheckCircle2, XCircle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/ai-providers")({
  head: () => ({ meta: [{ title: "AI Providers — Nyrava" }] }),
  component: AIProvidersPage,
});

const PROVIDER_TYPES = [
  { value: "groq",       label: "Groq",        defaultUrl: "https://api.groq.com/openai/v1",        defaultModel: "llama-3.3-70b-specdec", secret: "GROQ_API_KEY" },
  { value: "gemini",     label: "Google Gemini", defaultUrl: "",                                    defaultModel: "gemini-flash-latest",        secret: "GEMINI_API_KEY" },
  { value: "openrouter", label: "OpenRouter",  defaultUrl: "https://openrouter.ai/api/v1",          defaultModel: "deepseek/deepseek-chat-v3:free", secret: "OPENROUTER_API_KEY" },
  { value: "openai",     label: "OpenAI",      defaultUrl: "https://api.openai.com/v1",             defaultModel: "gpt-4o-mini",             secret: "OPENAI_API_KEY" },
  { value: "anthropic",  label: "Anthropic",   defaultUrl: "",                                      defaultModel: "claude-3-5-sonnet-latest", secret: "ANTHROPIC_API_KEY" },
  { value: "ollama",     label: "Ollama (local)",   defaultUrl: "http://localhost:11434/v1",        defaultModel: "llama3.1",                secret: "" },
  { value: "lmstudio",   label: "LM Studio (local)", defaultUrl: "http://localhost:1234/v1",        defaultModel: "local-model",             secret: "" },
] as const;

const TASKS = [
  { value: "extraction", label: "Simple extraction" },
  { value: "analysis",   label: "Legal analysis" },
  { value: "reasoning",  label: "Complex reasoning" },
  { value: "report",     label: "Final report generation" },
  { value: "chat",       label: "Chat" },
] as const;

interface ProviderRow {
  id: string; provider_type: string; display_name: string; enabled: boolean;
  priority: number; base_url: string | null; default_model: string | null;
  secret_name: string | null; last_ok_at: string | null; last_error_at: string | null;
  last_error: string | null;
  has_api_key?: boolean;
}

function AIProvidersPage() {
  const qc = useQueryClient();
  const list = useServerFn(listAiProviders);
  const routes = useServerFn(listTaskRoutes);
  const secrets = useServerFn(getAiSecretStatus);
  const health = useServerFn(getAiProviderHealth);

  const providersQ = useQuery({ queryKey: ["aiProviders"], queryFn: () => list() });
  const routesQ = useQuery({ queryKey: ["aiRoutes"], queryFn: () => routes() });
  const secretsQ = useQuery({ queryKey: ["aiSecrets"], queryFn: () => secrets() });
  const healthQ = useQuery({ queryKey: ["aiHealth"], queryFn: () => health(), refetchInterval: 15000 });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["aiProviders"] });
    qc.invalidateQueries({ queryKey: ["aiHealth"] });
    qc.invalidateQueries({ queryKey: ["aiSecrets"] });
  };

  if (providersQ.isLoading) return <div className="p-10 text-muted-foreground">Loading…</div>;
  if (providersQ.error) return <div className="p-10 text-destructive">Access denied or load failed.</div>;
  const providers = (providersQ.data ?? []) as ProviderRow[];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-10">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-accent" />
        <h1 className="text-2xl font-semibold md:text-3xl">AI Provider Management</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Platform-level provider fallback chain, task routing, and credential probes across every
        supported provider (Groq, Gemini, OpenRouter, OpenAI, Anthropic, local). Personal keys live
        on the Intelligence Providers page; this page controls the shared chain used when a run has
        no personal key for a provider.
      </p>

      <SecretsPanel status={secretsQ.data ?? {}} onChanged={refresh} />
      <ProvidersPanel rows={providers} onChanged={refresh} />
      <TaskRoutingPanel providers={providers} routes={(routesQ.data ?? []) as any[]} onChanged={() => qc.invalidateQueries({ queryKey: ["aiRoutes"] })} />
      <HealthPanel data={healthQ.data ?? {}} />
    </div>
  );
}

// ---------------- Secrets ----------------

function SecretsPanel({ status, onChanged }: { status: Record<string, boolean>; onChanged: () => void }) {
  const names = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
  return (
    <Section title="API Keys" icon={KeyRound}>
      <div className="rounded-xl border border-border bg-card">
        {names.map((n) => (
          <div key={n} className="flex items-center justify-between border-b border-border px-4 py-3 last:border-b-0">
            <div className="flex items-center gap-2">
              {status[n] ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-muted-foreground" />}
              <span className="font-mono text-sm">{n}</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {status[n] ? "Project secret configured" : "Not set as project secret — add or replace keys from each provider below"}
            </span>
          </div>
        ))}
        <div className="flex justify-end border-t border-border px-4 py-3">
          <button onClick={onChanged} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">Refresh</button>
        </div>
      </div>
    </Section>
  );
}

// ---------------- Providers ----------------

function ProvidersPanel({ rows, onChanged }: { rows: ProviderRow[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<ProviderRow | null>(null);
  const [adding, setAdding] = useState(false);
  const toggle = useServerFn(toggleAiProvider);
  const del = useServerFn(deleteAiProvider);
  const reorder = useServerFn(reorderAiProviders);
  const test = useServerFn(testAiProvider);
  const [testingId, setTestingId] = useState<string | null>(null);
  type ProbeResult = {
    ok: boolean;
    latencyMs: number;
    error?: string;
    diagnostics?: {
      credentialSource: string;
      userKeyCount: number;
      hasPlatformFallback: boolean;
      keysProbed: number;
      keysHealthy: number;
      keysFailed: number;
      organizations: (string | undefined)[];
      perKey: Array<{
        keyIndex: number;
        source: string;
        masked: string;
        keyPrefix: string;
        keySuffix: string;
        ok: boolean;
        latencyMs: number;
        error?: string;
        organization?: string;
        requestId?: string;
        model?: string;
      }>;
    };
  };
  const [testResult, setTestResult] = useState<Record<string, ProbeResult>>({});

  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...rows];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    await reorder({ data: { ids: next.map(r => r.id) } });
    onChanged();
  };

  const onTest = async (id: string) => {
    setTestingId(id);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        test({ data: { id } }),
        new Promise<ProbeResult>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, latencyMs: 30000, error: "Probe timed out" }), 30000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      setTestResult(prev => ({ ...prev, [id]: r }));
      onChanged();
    } catch (e) {
      setTestResult(prev => ({
        ...prev,
        [id]: { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : String(e) },
      }));
    } finally { setTestingId(null); }
  };

  return (
    <Section title="Providers" icon={ShieldCheck} action={
      <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
        <Plus className="h-4 w-4" /> Add provider
      </button>
    }>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Order</th>
              <th className="px-3 py-2">Provider</th>
              <th className="px-3 py-2">Model</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last OK</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const tr = testResult[r.id];
              const okRecent = r.last_ok_at && (!r.last_error_at || new Date(r.last_ok_at) >= new Date(r.last_error_at));
              return (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="flex flex-col">
                      <button onClick={() => move(i, -1)} disabled={i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                      <button onClick={() => move(i, +1)} disabled={i === rows.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.display_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.provider_type} · {r.has_api_key ? "stored key" : r.secret_name ? `secret ${r.secret_name}` : "no key required"}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.default_model ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                      !r.enabled ? "bg-muted text-muted-foreground" :
                      okRecent ? "bg-emerald-500/15 text-emerald-600" :
                      r.last_error_at ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"
                    }`}>
                      {!r.enabled ? "Disabled" : okRecent ? "Healthy" : r.last_error_at ? "Error" : "Unknown"}
                    </span>
                    {tr && (
                      <div className="mt-1 space-y-1">
                        <div className={`text-xs ${tr.ok ? "text-emerald-600" : "text-destructive"}`}>
                          {tr.ok ? `OK · ${tr.latencyMs}ms` : tr.error}
                        </div>
                        {tr.diagnostics && (
                          <div className="rounded-md border border-border bg-muted/30 p-2 text-[11px] leading-tight">
                            <div className="text-muted-foreground">
                              Source: <span className="font-mono">{tr.diagnostics.credentialSource}</span>
                              {" · "}user keys: {tr.diagnostics.userKeyCount}
                              {" · "}healthy {tr.diagnostics.keysHealthy}/{tr.diagnostics.keysProbed}
                              {tr.diagnostics.organizations.filter(Boolean).length > 0 && (
                                <> · org: <span className="font-mono">{tr.diagnostics.organizations.filter(Boolean).join(", ")}</span></>
                              )}
                            </div>
                            <div className="mt-1 space-y-0.5">
                              {tr.diagnostics.perKey.map((p) => (
                                <div key={`${p.source}-${p.keyIndex}`} className="flex flex-wrap items-center gap-1 font-mono">
                                  <span className={p.ok ? "text-emerald-600" : "text-destructive"}>
                                    {p.ok ? "✓" : "✗"}
                                  </span>
                                  <span>#{p.keyIndex}</span>
                                  <span className="text-muted-foreground">[{p.source}]</span>
                                  <span>{p.keyPrefix}…{p.keySuffix}</span>
                                  {p.organization && <span className="text-muted-foreground">org={p.organization}</span>}
                                  {p.model && <span className="text-muted-foreground">model={p.model}</span>}
                                  <span className="text-muted-foreground">{p.latencyMs}ms</span>
                                  {!p.ok && p.error && <span className="text-destructive">{p.error.slice(0, 80)}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.last_ok_at ? new Date(r.last_ok_at).toLocaleString() : "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <button onClick={() => onTest(r.id)} disabled={testingId === r.id} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
                        {testingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                      </button>
                      <button onClick={async () => { await toggle({ data: { id: r.id, enabled: !r.enabled } }); onChanged(); }}
                              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
                        <Power className="inline h-3 w-3" /> {r.enabled ? "Disable" : "Enable"}
                      </button>
                      <button onClick={() => setEditing(r)} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">Edit</button>
                      <button onClick={async () => { if (confirm(`Delete ${r.display_name}?`)) { await del({ data: { id: r.id } }); onChanged(); } }}
                              className="rounded-md border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10">
                        <Trash2 className="inline h-3 w-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No providers yet — click “Add provider”.</td></tr>}
          </tbody>
        </table>
      </div>

      {(editing || adding) && (
        <ProviderDialog
          initial={editing}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSaved={() => { setEditing(null); setAdding(false); onChanged(); }}
        />
      )}
    </Section>
  );
}

function ProviderDialog({ initial, onClose, onSaved }: { initial: ProviderRow | null; onClose: () => void; onSaved: () => void }) {
  const upsert = useServerFn(upsertAiProvider);
  const [providerType, setProviderType] = useState(initial?.provider_type ?? "groq");
  const def = PROVIDER_TYPES.find(p => p.value === providerType)!;
  const [form, setForm] = useState({
    display_name: initial?.display_name ?? def.label,
    enabled: initial?.enabled ?? true,
    priority: initial?.priority ?? 100,
    base_url: initial?.base_url ?? def.defaultUrl,
    default_model: initial?.default_model ?? def.defaultModel,
    secret_name: initial?.secret_name ?? def.secret,
    api_key: "",
    clear_api_key: false,
  });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await upsert({ data: {
        id: initial?.id,
        provider_type: providerType as any,
        display_name: form.display_name,
        enabled: form.enabled,
        priority: Number(form.priority),
        base_url: form.base_url || null,
        default_model: form.default_model || null,
        secret_name: form.secret_name || null,
        api_key: form.api_key || null,
        clear_api_key: form.clear_api_key,
      }});
      onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
        <h3 className="text-lg font-semibold">{initial ? "Edit provider" : "Add provider"}</h3>
        <div className="mt-4 max-h-[72vh] space-y-3 overflow-y-auto pr-1">
          <Field label="Type">
            <select value={providerType}
              onChange={(e) => {
                const v = e.target.value;
                setProviderType(v);
                const d = PROVIDER_TYPES.find(p => p.value === v)!;
                setForm(f => ({ ...f, display_name: d.label, base_url: d.defaultUrl, default_model: d.defaultModel, secret_name: d.secret }));
              }}
              disabled={!!initial}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              {PROVIDER_TYPES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Display name">
            <input value={form.display_name} onChange={(e) => setForm(f => ({ ...f, display_name: e.target.value }))}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
          </Field>
          <Field label="Base URL">
            <input value={form.base_url ?? ""} onChange={(e) => setForm(f => ({ ...f, base_url: e.target.value }))}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs" />
          </Field>
          <Field label="Default model">
            <input value={form.default_model ?? ""} onChange={(e) => setForm(f => ({ ...f, default_model: e.target.value }))}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs" />
          </Field>
          {(providerType !== "ollama" && providerType !== "lmstudio") && (
            <Field label="Secret name (env var holding the API key)">
              <input value={form.secret_name ?? ""} onChange={(e) => setForm(f => ({ ...f, secret_name: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs" />
            </Field>
          )}
          {(providerType !== "ollama" && providerType !== "lmstudio") && (
            <Field label={initial?.has_api_key ? "Replace stored API key" : "API key"}>
              <input
                type="password"
                value={form.api_key}
                placeholder={initial?.has_api_key ? "Stored key is active — enter a new key to rotate" : "Paste provider API key"}
                onChange={(e) => setForm(f => ({ ...f, api_key: e.target.value, clear_api_key: false }))}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
              <div className="mt-1 text-xs text-muted-foreground">
                Keys are encrypted before storage and never shown again.
              </div>
            </Field>
          )}
          {initial?.has_api_key && providerType !== "ollama" && providerType !== "lmstudio" && (
            <label className="flex items-center gap-2 text-sm text-destructive">
              <input
                type="checkbox"
                checked={form.clear_api_key}
                onChange={(e) => setForm(f => ({ ...f, clear_api_key: e.target.checked, api_key: e.target.checked ? "" : f.api_key }))}
              />
              Remove stored API key
            </label>
          )}
          <Field label="Priority (lower = tried first)">
            <input type="number" value={form.priority} onChange={(e) => setForm(f => ({ ...f, priority: Number(e.target.value) }))}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm(f => ({ ...f, enabled: e.target.checked }))} />
            Enabled
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">Cancel</button>
          <button onClick={submit} disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Task routing ----------------

interface RouteRow { task: string; provider_id: string | null; model: string | null }

function TaskRoutingPanel({ providers, routes, onChanged }: { providers: ProviderRow[]; routes: RouteRow[]; onChanged: () => void }) {
  const setRoute = useServerFn(setTaskRoute);
  const byTask = Object.fromEntries(routes.map(r => [r.task, r]));

  return (
    <Section title="Task routing" icon={Activity}>
      <div className="rounded-xl border border-border bg-card">
        {TASKS.map(t => {
          const cur = byTask[t.value];
          return (
            <div key={t.value} className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="font-medium text-sm">{t.label}</div>
                <div className="text-xs text-muted-foreground">{t.value}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={cur?.provider_id ?? ""}
                  onChange={async (e) => {
                    await setRoute({ data: { task: t.value as any, provider_id: e.target.value || null, model: cur?.model ?? null } });
                    onChanged();
                  }}
                  className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="">Auto (priority order)</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.display_name} ({p.provider_type}){p.enabled ? "" : " — disabled"}
                    </option>
                  ))}
                </select>
                <input
                  placeholder="Model override (optional)"
                  defaultValue={cur?.model ?? ""}
                  onBlur={async (e) => {
                    if (!cur?.provider_id) return;
                    await setRoute({ data: { task: t.value as any, provider_id: cur.provider_id, model: e.target.value || null } });
                    onChanged();
                  }}
                  className="w-56 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
                />
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------- Health ----------------

function HealthPanel({ data }: { data: Record<string, { calls: number; ok: number; err: number; latencySum: number; inputTokens: number; outputTokens: number; cost: number; currentModel?: string }> }) {
  const entries = Object.entries(data);
  return (
    <Section title="Health (last 24h)" icon={Activity}>
      {entries.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No usage recorded in the last 24 hours.</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {entries.map(([type, h]) => {
            const successRate = h.calls > 0 ? (h.ok / h.calls) * 100 : 0;
            const avgLatency = h.calls > 0 ? Math.round(h.latencySum / h.calls) : 0;
            const costPer = h.calls > 0 ? h.cost / h.calls : 0;
            return (
              <div key={type} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="font-medium capitalize">{type}</div>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${successRate > 90 ? "bg-emerald-500/15 text-emerald-600" : successRate > 60 ? "bg-amber-500/15 text-amber-600" : "bg-destructive/15 text-destructive"}`}>
                    {successRate.toFixed(0)}% ok
                  </span>
                </div>
                {h.currentModel && <div className="mt-1 font-mono text-xs text-muted-foreground">{h.currentModel}</div>}
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <Metric label="Calls" value={h.calls} />
                  <Metric label="Errors" value={h.err} />
                  <Metric label="Avg latency" value={`${avgLatency}ms`} />
                  <Metric label="Est. cost/req" value={`$${costPer.toFixed(5)}`} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ---------------- Helpers ----------------

function Section({ title, icon: Icon, action, children }: { title: string; icon: any; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-accent" />
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md bg-muted/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}
