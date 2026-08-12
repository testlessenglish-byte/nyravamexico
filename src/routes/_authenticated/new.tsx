import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createCaseAndUpload, listGroqKeys } from "@/lib/cases.functions";
import { toast } from "sonner";
import { Upload, FileText, X, KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import { CASE_TYPE_SELECT_GROUPS } from "@/lib/intelligence/practice-areas";
import { JURISDICTION_GROUPS } from "@/lib/intelligence/jurisdictions";
import {
  CASE_ANALYSIS_MODE_SELECTABLE_OPTIONS,
  type CaseAnalysisMode,
} from "@/lib/intelligence/case-analysis-mode";
import { useI18n } from "@/i18n";

export const Route = createFileRoute("/_authenticated/new")({
  head: () => ({ meta: [{ title: "New case — Nyrava" }] }),
  component: NewCasePage,
});

function NewCasePage() {
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const uploadCase = useServerFn(createCaseAndUpload);
  const fetchKeyStatus = useServerFn(listGroqKeys);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  // Balance Mode removed from the UI — only Strict/Exploratory are
  // user-selectable now, "strict" is the new default. The backend still
  // accepts "balanced" (existing cases may carry it), so no schema change.
  const [mode, setMode] = useState<"strict" | "exploratory">("strict");
  // Default "ongoing" — same default the DB column already has, so a user
  // who never touches this picks up byte-for-byte the prior behavior.
  const [caseAnalysisMode, setCaseAnalysisMode] = useState<CaseAnalysisMode>("ongoing");
  // No default: a silent "general_civil" default caused cases to be
  // misclassified whenever a user didn't explicitly touch this dropdown
  // (e.g. a case named "criminal test" still ran as civil), which in turn
  // silently skipped every criminal-only engine (Attack Surface, Chain of
  // Custody, Constitutional, Procedural Violations). Force an explicit pick.
  const [caseType, setCaseType] = useState<string>("");
  // Not required, unlike case type: leaving it unset just means case-law
  // lookups search nationwide instead of scoping to one state's courts.
  const [jurisdiction, setJurisdiction] = useState<string>("");

  const [submitting, setSubmitting] = useState(false);
  const [drag, setDrag] = useState(false);
  const { data: keyStatus } = useQuery({
    queryKey: ["keyStatus"],
    queryFn: () => fetchKeyStatus(),
  });
  const hasKey = (keyStatus?.keys.length ?? 0) > 0 || (keyStatus?.platformConfigured ?? false);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasKey) {
      toast.error(t("new.toast.noKey"));
      return;
    }
    if (!name.trim()) {
      toast.error(t("new.toast.needName"));
      return;
    }
    if (files.length === 0) {
      toast.error(t("new.toast.needFiles"));
      return;
    }
    if (!caseType) {
      toast.error(t("new.toast.needCaseType"));
      return;
    }
    setSubmitting(true);
    const fd = new FormData();
    fd.append("name", name);
    fd.append("description", desc);
    fd.append("analysis_mode", mode);
    fd.append("case_type", caseType);
    fd.append("case_analysis_mode", caseAnalysisMode);
    if (jurisdiction) fd.append("jurisdiction", jurisdiction);

    for (const f of files) fd.append("files", f);
    toast.info(t("new.toast.uploading"));
    try {
      const res = await uploadCase({ data: fd });
      toast.success(t("new.toast.uploaded"));
      nav({ to: "/cases/$caseId", params: { caseId: res.caseId } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("new.toast.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  const MODE_KEYS = {
    strict: { label: "new.mode.strict", desc: "new.mode.strict.desc", icon: ShieldCheck },
    exploratory: {
      label: "new.mode.exploratory",
      desc: "new.mode.exploratory.desc",
      icon: Sparkles,
    },
  } as const;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
      <h1 className="text-3xl font-semibold">{t("new.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("new.subtitle")}</p>

      {!hasKey && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
          <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="flex-1">
            <p className="font-medium text-warning">{t("new.noKey.title")}</p>
            <p className="mt-1 text-muted-foreground">{t("new.noKey.body")}</p>
            <Link
              to="/settings"
              className="mt-2 inline-block rounded-md bg-warning px-3 py-1.5 text-xs font-semibold text-warning-foreground hover:opacity-90"
            >
              {t("new.noKey.cta")}
            </Link>
          </div>
        </div>
      )}

      <form onSubmit={submit} className="mt-6 rounded-2xl border border-border bg-card p-6 sm:p-8">
        <div className="space-y-4">
          <SectionLabel>{t("new.section.details")}</SectionLabel>
          <div>
            <label className="text-sm font-medium">{t("new.field.name")}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("new.field.name.placeholder")}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">
              {t("new.field.description")}{" "}
              <span className="text-muted-foreground">{t("common.optional")}</span>
            </label>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="mt-8 space-y-4 border-t border-border pt-6">
          <SectionLabel>{t("new.section.classification")}</SectionLabel>
          <div>
            <label className="text-sm font-medium">{t("new.field.caseType")}</label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("new.field.caseType.hint")}</p>
            <select
              value={caseType}
              onChange={(e) => setCaseType(e.target.value)}
              className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="" disabled>
                {t("new.field.caseType.placeholder")}
              </option>
              {CASE_TYPE_SELECT_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium">
              {t("new.field.jurisdiction")}{" "}
              <span className="text-muted-foreground">{t("common.optional")}</span>
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("new.field.jurisdiction.hint")}
            </p>
            <select
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{t("new.field.jurisdiction.auto")}</option>
              {JURISDICTION_GROUPS.map((g) => (
                <optgroup key={g.level} label={g.label}>
                  {g.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-8 space-y-4 border-t border-border pt-6">
          <SectionLabel>{t("new.section.analysis")}</SectionLabel>
          <div>
            <label className="text-sm font-medium">{t("new.field.mode")}</label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("new.field.mode.hint")}</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(["strict", "exploratory"] as const).map((m) => {
                const Icon = MODE_KEYS[m].icon;
                const active = mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`rounded-lg border px-3 py-3 text-left text-xs transition-colors ${
                      active
                        ? "border-primary bg-primary/10"
                        : "border-border bg-background text-muted-foreground hover:bg-secondary/40"
                    }`}
                  >
                    <Icon
                      className={`h-4 w-4 ${active ? "text-primary" : "text-muted-foreground"}`}
                    />
                    <div className="mt-1.5 text-sm font-semibold text-foreground">
                      {t(MODE_KEYS[m].label)}
                    </div>
                    <div className="mt-0.5">{t(MODE_KEYS[m].desc)}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">{t("caseSettings.caseAnalysisMode")}</label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("caseSettings.caseAnalysisMode.hint")}
            </p>
            <div className="mt-2 grid gap-2">
              {CASE_ANALYSIS_MODE_SELECTABLE_OPTIONS.map((opt) => {
                const active = caseAnalysisMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setCaseAnalysisMode(opt.value)}
                    className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                      active
                        ? "border-primary bg-primary/10"
                        : "border-border bg-background text-muted-foreground hover:bg-secondary/40"
                    }`}
                  >
                    <div className="text-sm font-semibold text-foreground">
                      {locale === "en" ? opt.label_en : opt.label_es}
                    </div>
                    <div className="mt-0.5">
                      {locale === "en" ? opt.description_en : opt.description_es}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-8 space-y-4 border-t border-border pt-6">
          <SectionLabel>{t("new.section.evidence")}</SectionLabel>
          <div>
            <label className="text-sm font-medium">{t("new.field.files")}</label>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                addFiles(e.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
              className={`mt-1 cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
                drag
                  ? "border-primary bg-primary/5"
                  : "border-border bg-background hover:bg-secondary/40"
              }`}
            >
              <Upload className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">{t("new.dropzone.title")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("new.dropzone.formats")}</p>
              <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                accept=".zip,.pdf,.doc,.docx,.txt,.md,.csv,.json,.xml,.html,image/*,audio/*"
                onChange={(e) => addFiles(e.target.files)}
              />
            </div>
            {files.length > 0 && (
              <ul className="mt-3 divide-y divide-border overflow-hidden rounded-md border border-border bg-background text-sm">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center justify-between px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{f.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {(f.size / 1024).toFixed(1)} KB
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="mt-8 border-t border-border pt-6">
          <button
            disabled={submitting}
            className="w-full rounded-md bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50 sm:w-auto"
          >
            {submitting ? t("new.submitting") : t("new.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  );
}
