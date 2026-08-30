import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, Play, RotateCw, Settings as SettingsIcon, ChevronDown, ChevronUp, FilePlus2, ShieldCheck, FastForward, Wrench, AlertTriangle } from "lucide-react";
import {
  queueCaseForPipeline,
  resumeFullPipelineStep,
  clearPipelineStuckState,
  updateCaseSettings,
  addEvidenceAndRerun,
  finalizeReportChangeLog,
  getCaseRunState,
  PIPELINE_STAGES,
} from "@/lib/cases.functions";
import { AGENT_DEFINITIONS } from "@/lib/agents/types";
import { CASE_TYPE_SELECT_OPTIONS } from "@/lib/intelligence/practice-areas";
import { JURISDICTION_GROUPS } from "@/lib/intelligence/jurisdictions";
import { CASE_ANALYSIS_MODE_SELECTABLE_OPTIONS } from "@/lib/intelligence/case-analysis-mode";
import { getCaseConfiguration } from "@/lib/intelligence/case-configuration";
import { useI18n } from "@/i18n";
import { drivePipeline } from "@/lib/pipeline-driver";

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

export function CaseControlPanel({
  caseId,
  caseStatus,
  caseType,
  proceduralVehicle,
  underlyingMateria,
  analysisMode: _analysisMode,
  jurisdiction,
  caseAnalysisMode,
  matterMetadata,
  documentsCount,
  invalidate,
}: {
  caseId: string;
  caseStatus: string | null | undefined;
  caseType: string | null;
  proceduralVehicle?: string | null;
  underlyingMateria?: string | null;
  analysisMode: string | null;
  jurisdiction: string | null;
  caseAnalysisMode: string | null;
  matterMetadata?: Record<string, unknown> | null;
  documentsCount: number;
  invalidate: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const running = !!caseStatus && RUNNING_STATUSES.has(caseStatus);
  const queueFn = useServerFn(queueCaseForPipeline);
  const resumeFn = useServerFn(resumeFullPipelineStep);
  const clearStuckFn = useServerFn(clearPipelineStuckState);
  const addFn = useServerFn(addEvidenceAndRerun);
  const finalizeFn = useServerFn(finalizeReportChangeLog);
  const runStateFn = useServerFn(getCaseRunState);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cancelWaitRef = useRef(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addProgress, setAddProgress] = useState("");
  const [awaitingCancel, setAwaitingCancel] = useState(false);

  useEffect(() => {
    if (!running) return;
    drivePipeline(caseId);
  }, [running, caseId]);

  const runM = useMutation({
    mutationFn: async (reset: boolean) => await queueFn({ data: { caseId, reset } }),
    onMutate: (reset) =>
      toast.info(reset ? "Rerun queued — worker will pick this up shortly…" : "Run queued — worker will pick this up shortly…"),
    onSuccess: (
      res:
        | { ok?: boolean; queued?: boolean; alreadyRunning?: boolean; cancelling?: boolean; billingRequired?: boolean }
        | undefined,
    ) => {
      if (res?.billingRequired) {
        toast.error("Billing required — this account has used its free case. Visit Billing to subscribe.");
      } else if (res?.alreadyRunning) {
        toast.warning("This case is already running — ignoring duplicate Run request.");
      } else if (res?.cancelling) {
        toast.info("Cancelling current run — will restart automatically once it stops…");
        waitForCancelThenRequeue();
      } else {
        toast.success("Case queued. Progress will stream in below.");
      }
      invalidate();
      qc.invalidateQueries({ queryKey: ["case", caseId] });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Failed to queue run");
      invalidate();
      qc.invalidateQueries({ queryKey: ["case", caseId] });
    },
  });

  const resumeM = useMutation({
    mutationFn: async () => await resumeFn({ data: { caseId } }),
    onMutate: () => toast.info("Resuming case from last checkpoint…"),
    onSuccess: (res: any) => {
      if (res?.alreadyComplete) {
        toast.info("Case is already complete.");
      } else if (res?.alreadyRunning) {
        toast.info("Case is already running.");
      } else {
        toast.success("Resumed pipeline successfully.");
      }
      invalidate();
      qc.invalidateQueries({ queryKey: ["case", caseId] });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Failed to resume case");
      invalidate();
      qc.invalidateQueries({ queryKey: ["case", caseId] });
    },
  });

  const clearStuckM = useMutation({
    mutationFn: async () => await clearStuckFn({ data: { caseId } }),
    onMutate: () => toast.info("Clearing stuck state and stale worker locks…"),
    onSuccess: () => {
      toast.success("Stale locks cleared. You can now safely Resume or Rerun.");
      invalidate();
      qc.invalidateQueries({ queryKey: ["case", caseId] });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Failed to clear stuck state");
      invalidate();
      qc.invalidateQueries({ queryKey: ["case", caseId] });
    },
  });

  function waitForCancelThenRequeue() {
    if (cancelWaitRef.current) return;
    cancelWaitRef.current = true;
    setAwaitingCancel(true);
    let attempts = 0;
    const maxAttempts = 60;
    const poll = async () => {
      attempts += 1;
      try {
        const state = await runStateFn({ data: { caseId } });
        if (state?.status === "cancelled" || !RUNNING_STATUSES.has(String(state?.status ?? ""))) {
          cancelWaitRef.current = false;
          setAwaitingCancel(false);
          toast.info("Previous run stopped — restarting with current settings…");
          runM.mutate(true);
          invalidate();
          qc.invalidateQueries({ queryKey: ["case", caseId] });
          return;
        }
      } catch (e) {
        console.error("[pipeline] cancel-wait poll failed", e);
      }
      if (attempts >= maxAttempts) {
        cancelWaitRef.current = false;
        setAwaitingCancel(false);
        toast.warning(t("caseControl.toast.stillStopping"));
        return;
      }
      setTimeout(poll, 1500);
    };
    poll();
  }

  async function handleAddEvidenceFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    setAddBusy(true);
    try {
      setAddProgress(t("caseControl.progress.uploading", { count: arr.length }));
      const fd = new FormData();
      fd.append("caseId", caseId);
      for (const f of arr) fd.append("files", f);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (addFn as any)({ data: fd });
      toast.success(t("caseControl.toast.uploaded", { count: res?.uploaded ?? arr.length }));
      invalidate();
      qc.invalidateQueries({ queryKey: ["case", caseId] });

      setAddProgress(t("caseControl.progress.requeue"));
      await queueFn({ data: { caseId } });

      setAddProgress(t("caseControl.progress.changes"));
      await finalizeFn({ data: { caseId } });

      toast.success(t("caseControl.toast.reportGenerated", { version: res?.nextVersion ?? "?" }));
      invalidate();
      qc.invalidateQueries({ queryKey: ["case", caseId] });
    } catch (e) {
      toast.error(t("caseControl.toast.addFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setAddBusy(false);
      setAddProgress("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const disabled = running || runM.isPending || resumeM.isPending || clearStuckM.isPending || addBusy || awaitingCancel || documentsCount === 0;
  const addDisabled = running || runM.isPending || resumeM.isPending || clearStuckM.isPending || addBusy || awaitingCancel;
  const isFailed = caseStatus === "failed";
  const isStuck = isFailed || caseStatus === "cancelled";

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-primary/20 bg-background/60 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-primary">{t("caseControl.title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("caseControl.subtitle")}</p>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground/70">
          {t("caseControl.stagesNote", { stages: PIPELINE_STAGES.length, agents: AGENT_DEFINITIONS.length })}
        </p>

        {/* Primary Run Case */}
        <button
          onClick={() => runM.mutate(false)}
          disabled={disabled}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/15 px-4 py-3 text-sm font-semibold text-primary hover:bg-primary/25 disabled:opacity-50"
        >
          {runM.isPending && !runM.variables ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {t("caseControl.run")}
        </button>

        {/* Resume Case — Restored for failed, checkpointed or interrupted runs */}
        {isFailed && (
          <button
            onClick={() => resumeM.mutate()}
            disabled={resumeM.isPending || running}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/50 bg-amber-500/15 px-4 py-2.5 text-sm font-semibold text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
          >
            {resumeM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FastForward className="h-4 w-4" />}
            Resume Case
          </button>
        )}

        {/* Clear Stuck Case — Restored to clear stale worker leases and locks safely */}
        {isStuck && (
          <button
            onClick={() => clearStuckM.mutate()}
            disabled={clearStuckM.isPending || running}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-border/70 bg-card/60 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-card disabled:opacity-50"
          >
            {clearStuckM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
            Clear Stuck State
          </button>
        )}

        {/* Rerun Case */}
        <button
          onClick={() => confirm(t("caseControl.rerun.confirm")) && runM.mutate(true)}
          disabled={disabled}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          {(runM.isPending && runM.variables) || awaitingCancel ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
          {awaitingCancel ? t("caseControl.rerun.stopping") : t("caseControl.rerun")}
        </button>

        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          disabled={addDisabled}
          onChange={(e) => e.target.files && handleAddEvidenceFiles(e.target.files)}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={addDisabled}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2.5 text-sm font-medium text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-50"
        >
          {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePlus2 className="h-4 w-4" />}
          {addBusy ? t("caseControl.working") : t("caseControl.addEvidence")}
        </button>
        {addBusy && addProgress && <p className="mt-2 text-xs text-emerald-300">{addProgress}</p>}
        {documentsCount === 0 && <p className="mt-3 text-xs text-amber-300">{t("caseControl.needDocument")}</p>}
        {running && <p className="mt-3 text-xs text-amber-300">{t("caseControl.inProgress")}</p>}
      </div>

      <CollapsedCaseSettings
        caseId={caseId}
        caseType={caseType}
        proceduralVehicle={proceduralVehicle}
        underlyingMateria={underlyingMateria}
        jurisdiction={jurisdiction}
        caseAnalysisMode={caseAnalysisMode}
        matterMetadata={matterMetadata}
        running={running}
        invalidate={invalidate}
      />
    </div>
  );
}

function CollapsedCaseSettings({
  caseId,
  caseType,
  proceduralVehicle,
  underlyingMateria,
  jurisdiction,
  caseAnalysisMode,
  matterMetadata,
  running,
  invalidate,
}: {
  caseId: string;
  caseType: string | null;
  proceduralVehicle?: string | null;
  underlyingMateria?: string | null;
  jurisdiction: string | null;
  caseAnalysisMode: string | null;
  matterMetadata?: Record<string, unknown> | null;
  running: boolean;
  invalidate: () => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const updateFn = useServerFn(updateCaseSettings);

  const config = getCaseConfiguration({
    case_type: caseType,
    procedural_vehicle: proceduralVehicle,
    underlying_materia: underlyingMateria,
    jurisdiction,
    case_analysis_mode: caseAnalysisMode,
    matter_metadata: matterMetadata,
  });

  const effectiveUserCaseType = config.user_selected_case_type ?? caseType ?? "";
  const effectiveUserVehicle = config.user_selected_procedural_vehicle ?? proceduralVehicle ?? "";
  const effectiveUserUnderlying = config.user_selected_underlying_materia ?? underlyingMateria ?? "";
  const effectiveUserJurisdiction = config.user_selected_jurisdiction ?? jurisdiction ?? "";
  const effectiveUserCaseAnalysisMode = config.user_selected_case_analysis_mode ?? caseAnalysisMode ?? "ongoing";

  const [ct, setCt] = useState<string>(effectiveUserCaseType);
  const [pv, setPv] = useState<string>(effectiveUserVehicle);
  const [um, setUm] = useState<string>(effectiveUserUnderlying);
  const [juris, setJuris] = useState<string>(effectiveUserJurisdiction);
  const [caseAnalysis, setCaseAnalysis] = useState<string>(effectiveUserCaseAnalysisMode);

  useEffect(() => {
    setCt(effectiveUserCaseType);
    setPv(effectiveUserVehicle);
    setUm(effectiveUserUnderlying);
    setJuris(effectiveUserJurisdiction);
    setCaseAnalysis(effectiveUserCaseAnalysisMode);
  }, [effectiveUserCaseType, effectiveUserVehicle, effectiveUserUnderlying, effectiveUserJurisdiction, effectiveUserCaseAnalysisMode]);

  const m = useMutation({
    mutationFn: (patch: { case_type?: string; procedural_vehicle?: string | null; underlying_materia?: string | null; jurisdiction?: string | null; case_analysis_mode?: string }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateFn({ data: { caseId, ...(patch as any) } }),
    onSuccess: (
      res:
        | {
            caseAnalysisModeChanged?: boolean;
            sourceConflict?: { field: string; sourceValue: string; requestedValue: string } | null;
          }
        | undefined,
    ) => {
      toast.success(t("caseSettings.toast.saved"));
      if (res?.caseAnalysisModeChanged) toast.info(t("caseSettings.toast.caseAnalysisModeChanged"));
      if (res?.sourceConflict) {
        toast.warning(t("caseSettings.toast.sourceConflict", { source: res.sourceConflict.sourceValue, chosen: res.sourceConflict.requestedValue }));
      }
      setOpen(false);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : t("caseSettings.toast.saveFailed")),
  });

  const dirty =
    ct !== effectiveUserCaseType ||
    pv !== effectiveUserVehicle ||
    um !== effectiveUserUnderlying ||
    juris !== effectiveUserJurisdiction ||
    caseAnalysis !== effectiveUserCaseAnalysisMode;
  const disabled = running || m.isPending;

  return (
    <div className="rounded-2xl border border-border bg-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <SettingsIcon className="h-3.5 w-3.5" /> {t("caseSettings.title")}
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {/* When closed, show structured summary pills */}
      {!open && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5 text-[11px]">
          {ct && <span className="rounded bg-primary/10 px-2 py-0.5 text-primary font-medium">{ct}</span>}
          {pv && <span className="rounded bg-accent/10 px-2 py-0.5 text-accent font-medium">{pv.replace(/_/g, " ")}</span>}
          {um && <span className="rounded bg-secondary px-2 py-0.5 text-secondary-foreground font-medium">Materia: {um}</span>}
          {juris && <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground font-medium">{juris}</span>}
          {config.classification_conflict && (
            <span className="rounded bg-amber-500/20 text-amber-300 px-2 py-0.5 font-medium flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {config.detected_case_type ? `Detectado: ${config.detected_case_type}` : "Conflicto"}
            </span>
          )}
        </div>
      )}

      {open && (
        <div className="border-t border-border p-4 space-y-4">
          {config.classification_conflict && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1.5">
              <div className="font-semibold flex items-center gap-1.5 text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                {locale === "en" ? "Classification Conflict" : "Conflicto de Clasificación"}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {locale === "en"
                  ? "The uploaded document contains markers indicating a different classification than originally selected."
                  : "El documento cargado contiene elementos que indican una clasificación distinta a la seleccionada inicialmente."}
              </p>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded bg-background/60 p-2 border border-border/50">
                  <div className="text-muted-foreground">{locale === "en" ? "Selected by user:" : "Seleccionado por usuario:"}</div>
                  <div className="font-medium text-foreground capitalize">{config.user_selected_case_type || "N/A"}</div>
                </div>
                <div className="rounded bg-amber-500/15 p-2 border border-amber-500/30">
                  <div className="text-amber-400/90">{locale === "en" ? "Detected from doc:" : "Detectado en documento:"}</div>
                  <div className="font-medium text-amber-300 capitalize">{config.detected_case_type || "N/A"}</div>
                </div>
              </div>
              {config.conflict_details?.detected_quote && (
                <div className="mt-1 text-[10px] text-muted-foreground italic border-t border-amber-500/20 pt-1">
                  &ldquo;{config.conflict_details.detected_quote.slice(0, 120)}...&rdquo;
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground/80">{t("caseSettings.caseType")}</label>
            <select
              value={ct}
              onChange={(e) => setCt(e.target.value)}
              disabled={disabled}
              className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm disabled:opacity-50"
            >
              {!ct && <option value="" disabled>{t("caseSettings.caseType.unclassified")}</option>}
              {CASE_TYPE_SELECT_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>

          {ct === "amparo" && (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80">Procedimiento / Tipo de Amparo</label>
                <select
                  value={pv}
                  onChange={(e) => setPv(e.target.value)}
                  disabled={disabled}
                  className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm disabled:opacity-50"
                >
                  <option value="">Selecciona tipo de amparo</option>
                  <option value="amparo_directo">Amparo Directo</option>
                  <option value="amparo_indirecto">Amparo Indirecto</option>
                  <option value="amparo_directo_revision">Amparo Directo en Revisión</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80">Materia Sustantiva Subyacente</label>
                <select
                  value={um}
                  onChange={(e) => setUm(e.target.value)}
                  disabled={disabled}
                  className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm disabled:opacity-50"
                >
                  <option value="">Selecciona materia subyacente</option>
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
            </>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground/80">{t("caseSettings.jurisdiction")}</label>
            <p className="text-[11px] text-muted-foreground">{t("caseSettings.jurisdiction.hint")}</p>
            <select
              value={juris}
              onChange={(e) => setJuris(e.target.value)}
              disabled={disabled}
              className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm disabled:opacity-50"
            >
              <option value="">{t("caseSettings.jurisdiction.auto")}</option>
              {JURISDICTION_GROUPS.map((g) => (
                <optgroup key={g.level} label={g.label}>
                  {g.options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-semibold text-foreground">
                  {locale === "en" ? "Nyrava Verified Legal Intelligence" : "Nyrava — Inteligencia Jurídica Verificada"}
                </div>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  {locale === "en"
                    ? "One evidence-grounded standard. Verified findings drive conclusions and scores; inferences, missing evidence and investigative leads remain separately labeled."
                    : "Un solo estándar sustentado en evidencia. Los hallazgos verificados determinan conclusiones y puntuaciones; inferencias, evidencia faltante y líneas de investigación permanecen separadas y etiquetadas."}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground/80">{t("caseSettings.caseAnalysisMode")}</label>
            <p className="text-[11px] text-muted-foreground">{t("caseSettings.caseAnalysisMode.hint")}</p>
            <div className="grid gap-1.5">
              {CASE_ANALYSIS_MODE_SELECTABLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => setCaseAnalysis(opt.value)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
                    caseAnalysis === opt.value ? "border-accent bg-accent/10" : "border-border bg-background hover:bg-secondary"
                  }`}
                >
                  <div className="font-medium">{locale === "en" ? opt.label_en : opt.label_es}</div>
                  <div className="text-xs text-muted-foreground">{locale === "en" ? opt.description_en : opt.description_es}</div>
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={() => m.mutate({ case_type: ct, procedural_vehicle: pv || null, underlying_materia: um || null, jurisdiction: juris || null, case_analysis_mode: caseAnalysis })}
            disabled={disabled || !dirty || !ct}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {m.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {dirty ? t("caseSettings.save") : t("caseSettings.saved")}
          </button>
        </div>
      )}
    </div>
  );
}
