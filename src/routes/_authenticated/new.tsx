import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createCaseAndUpload, listGroqKeys } from "@/lib/cases.functions";
import { toast } from "sonner";
import { Upload, FileText, X, KeyRound, ShieldCheck } from "lucide-react";
import { CASE_TYPE_SELECT_GROUPS } from "@/lib/intelligence/practice-areas";
import { JURISDICTION_GROUPS } from "@/lib/intelligence/jurisdictions";
import { IMMIGRATION_SUBTYPES } from "@/lib/jurisdiction/immigration";
import {
  CASE_ANALYSIS_MODE_SELECTABLE_OPTIONS,
  type CaseAnalysisMode,
} from "@/lib/intelligence/case-analysis-mode";
import { useI18n } from "@/i18n";

export const Route = createFileRoute("/_authenticated/new")({
  head: () => ({ meta: [{ title: "New case — Nyrava" }] }),
  component: NewCasePage,
});

/**
 * Nyrava now exposes one attorney-facing analysis standard. The legacy
 * database value `strict` remains the internal compatibility value so old
 * rows, migrations and downstream engine contracts do not need a risky
 * schema migration. What changed is the product contract: users no longer
 * choose between two pipelines that could disagree about the same record.
 */
const VERIFIED_ANALYSIS_MODE = "strict" as const;

function NewCasePage() {
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const uploadCase = useServerFn(createCaseAndUpload);
  const fetchKeyStatus = useServerFn(listGroqKeys);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [caseAnalysisMode, setCaseAnalysisMode] = useState<CaseAnalysisMode>("ongoing");
  const [caseType, setCaseType] = useState<string>("");
  const [amparoSubtype, setAmparoSubtype] = useState<"" | "indirecto" | "directo" | "directo_en_revision">("");
  const [underlyingMateria, setUnderlyingMateria] = useState<string>("");
  const [immigrationSubtype, setImmigrationSubtype] = useState("");
  const [immigrationClientName, setImmigrationClientName] = useState("");
  const [immigrationNationality, setImmigrationNationality] = useState("");
  const [immigrationPassport, setImmigrationPassport] = useState("");
  const [immigrationCondition, setImmigrationCondition] = useState("");
  const [immigrationBenefit, setImmigrationBenefit] = useState("");
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
    if (files.length === 0) {
      toast.error(t("new.toast.needFiles"));
      return;
    }
    if (!caseType) {
      toast.error(t("new.toast.needCaseType"));
      return;
    }
    if (caseType === "migratorio" && !immigrationSubtype) {
      toast.error(locale === "es" ? "Selecciona el subtipo migratorio." : "Select an immigration subtype.");
      return;
    }

    setSubmitting(true);
    const fd = new FormData();
    fd.append("name", name);
    const selectedImmigrationSubtype = IMMIGRATION_SUBTYPES.find(([key]) => key === immigrationSubtype);
    const descToSubmit =
      caseType === "amparo" && amparoSubtype === "directo_en_revision"
        ? `${desc}\n\n(Amparo Directo en Revisión ante la SCJN)`
        : caseType === "migratorio" && selectedImmigrationSubtype
          ? `${desc}\n\n(Subtipo migratorio: ${selectedImmigrationSubtype[1]})`
          : desc;
    fd.append("description", descToSubmit);
    // Single trusted analysis standard. `strict` is an internal compatibility
    // token only; there is no longer a user-selectable strict/exploratory fork.
    fd.append("analysis_mode", VERIFIED_ANALYSIS_MODE);
    fd.append("case_type", caseType);
    fd.append("case_analysis_mode", caseAnalysisMode);
    if (caseType === "amparo") {
      const vehicleMapping: Record<string, string> = {
        directo: "amparo_directo",
        indirecto: "amparo_indirecto",
        directo_en_revision: "amparo_directo_revision",
      };
      fd.append("procedural_vehicle", vehicleMapping[amparoSubtype] ?? amparoSubtype);
      if (underlyingMateria) {
        fd.append("underlying_materia", underlyingMateria);
      }
    }
    if (jurisdiction) fd.append("jurisdiction", jurisdiction);
    if (caseType === "migratorio") {
      fd.append(
        "matter_metadata",
        JSON.stringify({
          immigration_subtype: immigrationSubtype,
          client_name: immigrationClientName,
          nationality: immigrationNationality,
          passport_number: immigrationPassport,
          current_condition_of_stay: immigrationCondition,
          requested_benefit: immigrationBenefit,
          confidentiality_level: "confidential",
          priority: "normal",
          client_aliases: [],
          tags: [],
          important_dates: [],
        }),
      );
    }

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
            <label className="text-sm font-medium">
              {locale === "es" ? "Nombre del Caso (Opcional)" : "Case Name (Optional)"}
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {locale === "es"
                ? "Deja en blanco y Nyrava identificará y nombrará el caso a partir de los documentos cargados."
                : "Leave blank and Nyrava will identify and name the case from the uploaded documents."}
            </p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={locale === "es" ? "ej. ADR 311/2015 — María López (o deja en blanco para auto-detectar)" : "e.g. ADR 311/2015 — María López (or leave blank to auto-detect)"}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">
              {locale === "es" ? "Descripción del Caso (Opcional)" : "Case Description (Optional)"}
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {locale === "es"
                ? "Deja en blanco y Nyrava generará una descripción a partir de la información verificada del caso."
                : "Leave blank and Nyrava will generate a description from verified case information."}
            </p>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              placeholder={locale === "es" ? "Descripción breve opcional, o deja en blanco para auto-generar" : "Optional brief overview, or leave blank to auto-generate"}
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
              <option value="" disabled>{t("new.field.caseType.placeholder")}</option>
              {CASE_TYPE_SELECT_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {caseType === "amparo" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">{t("new.field.amparoSubtype")}</label>
                <p className="mt-0.5 text-xs text-muted-foreground">{t("new.field.amparoSubtype.hint")}</p>
                <select
                  value={amparoSubtype}
                  onChange={(e) => setAmparoSubtype(e.target.value as typeof amparoSubtype)}
                  className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t("new.field.amparoSubtype.placeholder")}</option>
                  <option value="directo">{t("new.field.amparoSubtype.directo")}</option>
                  <option value="directo_en_revision">{t("new.field.amparoSubtype.directoEnRevision")}</option>
                  <option value="indirecto">{t("new.field.amparoSubtype.indirecto")}</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-medium">Materia Sustantiva Subyacente</label>
                <p className="mt-0.5 text-xs text-muted-foreground">Materia del acto o resolución reclamada (ej. Laboral, Civil, Penal, etc.)</p>
                <select
                  value={underlyingMateria}
                  onChange={(e) => setUnderlyingMateria(e.target.value)}
                  className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Selecciona materia subyacente (opcional)</option>
                  <option value="laboral">Laboral</option>
                  <option value="civil">Civil</option>
                  <option value="penal">Penal</option>
                  <option value="mercantil">Mercantil</option>
                  <option value="administrativo">Administrativo</option>
                  <option value="familiar">Familiar</option>
                  <option value="fiscal">Fiscal</option>
                  <option value="agrario">Agrario</option>
                </select>
              </div>
            </div>
          )}

          {caseType === "migratorio" && (
            <div className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
              <div>
                <label className="text-sm font-medium">
                  {locale === "es" ? "Subtipo migratorio" : "Immigration subtype"}
                </label>
                <select
                  value={immigrationSubtype}
                  onChange={(e) => setImmigrationSubtype(e.target.value)}
                  className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">
                    {locale === "es" ? "Selecciona un subtipo" : "Select a subtype"}
                  </option>
                  {IMMIGRATION_SUBTYPES.map(([key, es, en]) => (
                    <option key={key} value={key}>{locale === "es" ? es : en}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  {
                    label: locale === "es" ? "Nombre del cliente" : "Client name",
                    value: immigrationClientName,
                    set: setImmigrationClientName,
                  },
                  {
                    label: locale === "es" ? "Nacionalidad" : "Nationality",
                    value: immigrationNationality,
                    set: setImmigrationNationality,
                  },
                  {
                    label: locale === "es" ? "Pasaporte" : "Passport",
                    value: immigrationPassport,
                    set: setImmigrationPassport,
                  },
                  {
                    label: locale === "es" ? "Condición de estancia actual" : "Current immigration status",
                    value: immigrationCondition,
                    set: setImmigrationCondition,
                  },
                  {
                    label: locale === "es" ? "Beneficio solicitado" : "Requested benefit",
                    value: immigrationBenefit,
                    set: setImmigrationBenefit,
                  },
                ].map((field) => (
                  <label key={field.label} className="text-xs font-medium">
                    {field.label}
                    <input
                      value={field.value}
                      onChange={(e) => field.set(e.target.value)}
                      className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    />
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {locale === "es"
                  ? "Los pasaportes y números sensibles se enmascaran en listados y registros."
                  : "Passports and sensitive identifiers are masked in list views and logs."}
              </p>
            </div>
          )}

          <div>
            <label className="text-sm font-medium">
              {t("new.field.jurisdiction")}{" "}
              <span className="text-muted-foreground">{t("common.optional")}</span>
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("new.field.jurisdiction.hint")}</p>
            <select
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{t("new.field.jurisdiction.auto")}</option>
              {JURISDICTION_GROUPS.map((g) => (
                <optgroup key={g.level} label={g.label}>
                  {g.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-8 space-y-4 border-t border-border pt-6">
          <SectionLabel>{t("new.section.analysis")}</SectionLabel>

          <div className="rounded-xl border border-primary/25 bg-primary/5 p-4">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <div className="text-sm font-semibold text-foreground">
                  {locale === "es" ? "Nyrava — Inteligencia Jurídica Verificada" : "Nyrava Verified Legal Intelligence"}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {locale === "es"
                    ? "Los hechos y determinaciones verificadas sustentan las conclusiones y puntuaciones. Las inferencias, vacíos probatorios, contradicciones, errores potenciales y líneas de investigación se identifican por separado y nunca se presentan como hechos establecidos."
                    : "Verified facts and holdings drive conclusions and scores. Supported inferences, missing evidence, contradictions, potential errors and investigative leads are identified separately and are never presented as established fact."}
                </p>
              </div>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">{t("caseSettings.caseAnalysisMode")}</label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("caseSettings.caseAnalysisMode.hint")}</p>
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
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
              onClick={() => inputRef.current?.click()}
              className={`mt-1 cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
                drag ? "border-primary bg-primary/5" : "border-border bg-background hover:bg-secondary/40"
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
                      <span className="shrink-0 text-xs text-muted-foreground">{(f.size / 1024).toFixed(1)} KB</span>
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
