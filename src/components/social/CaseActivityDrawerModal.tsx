import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle, Clock, Edit3, ExternalLink, Eye, History, Info, Loader2,
  Lock, ShieldAlert, Trash2, User, X, ChevronDown, ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { CaseDynamicText } from "@/components/social/CaseDynamicText";
import { localizedEnum } from "@/lib/social/social-i18n";
import {
  deleteSocialIntervention, getSocialActivityRecordDetail,
  getSocialDocumentAccessUrl, updateSocialIntervention,
} from "@/lib/social.functions";

interface Props {
  caseId: string;
  activityId: string;
  es: boolean;
  onClose: () => void;
  onNavigateTab: (tab: string) => void;
}

export function CaseActivityDrawerModal({
  caseId,
  activityId,
  es,
  onClose,
  onNavigateTab,
}: Props) {
  const qc = useQueryClient();
  const getDetailFn = useServerFn(getSocialActivityRecordDetail);
  const updateInterventionFn = useServerFn(updateSocialIntervention);
  const deleteInterventionFn = useServerFn(deleteSocialIntervention);
  const accessDocFn = useServerFn(getSocialDocumentAccessUrl);

  const [showTechnical, setShowTechnical] = useState(false);
  const [editingIntervention, setEditingIntervention] = useState(false);
  const [interventionForm, setInterventionForm] = useState({
    reason: "",
    actionsTaken: "",
    outcome: "",
    followUpRequired: false,
  });
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");

  const detailQuery = useQuery({
    queryKey: ["social-activity-detail", caseId, activityId],
    queryFn: async () => {
      const res = await getDetailFn({ data: { caseId, activityId } });
      if (res.record && res.event.entity_type === "social_interventions") {
        setInterventionForm({
          reason: res.record.reason || "",
          actionsTaken: res.record.actions_taken || "",
          outcome: res.record.outcome || "",
          followUpRequired: Boolean(res.record.follow_up_required),
        });
      }
      return res;
    },
  });

  const updateIntervention = useMutation({
    mutationFn: () => updateInterventionFn({
      data: {
        interventionId: detailQuery.data?.record?.id,
        reason: interventionForm.reason,
        actionsTaken: interventionForm.actionsTaken,
        outcome: interventionForm.outcome,
        followUpRequired: interventionForm.followUpRequired,
      }
    }),
    onSuccess: () => {
      toast.success(es ? "Intervención actualizada y registrada en auditoría" : "Intervention updated and recorded in audit log");
      setEditingIntervention(false);
      void qc.invalidateQueries({ queryKey: ["social-activity-detail", caseId, activityId] });
      void qc.invalidateQueries({ queryKey: ["social-case", caseId] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const deleteIntervention = useMutation({
    mutationFn: () => deleteInterventionFn({
      data: {
        interventionId: detailQuery.data?.record?.id,
        reason: deleteReason || (es ? "Eliminado por el profesional" : "Deleted by professional"),
      }
    }),
    onSuccess: () => {
      toast.success(es ? "Intervención eliminada y evento registrado en auditoría" : "Intervention deleted and event logged in audit trail");
      void qc.invalidateQueries({ queryKey: ["social-case", caseId] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const handleDocumentAccess = async (docId: string, action: "preview" | "download") => {
    try {
      const res = await accessDocFn({ data: { documentId: docId, action } });
      window.open(res.url, action === "preview" ? "_blank" : "_self", "noopener,noreferrer");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const getEntityTitle = (entityType: string, eventType: string) => {
    const titles: Record<string, [string, string]> = {
      social_interventions: ["Intervención", "Intervention"],
      social_care_plans: ["Plan de Atención", "Care Plan"],
      social_assessments: ["Evaluación de Riesgo", "Risk Assessment"],
      social_documents: ["Documento del Caso", "Case Document"],
      social_alerts: ["Alerta del Caso", "Case Alert"],
      social_tasks: ["Tarea y Seguimiento", "Task & Follow-Up"],
      social_document_access_events: ["Registro de Acceso a Documento", "Document Access Event"],
      social_cases: ["Actualización del Caso", "Case Update"],
      social_consents: ["Consentimiento Informado", "Informed Consent"],
      social_referrals: ["Canalización Externa", "External Referral"],
      social_appointments: ["Cita Programada", "Scheduled Appointment"],
      social_case_closures: ["Cierre de Caso", "Case Closure"],
      social_case_transfers: ["Transferencia de Caso", "Case Transfer"],
      social_intakes: ["Ficha de Ingreso", "Intake Record"],
    };
    const base = titles[entityType] ? (es ? titles[entityType][0] : titles[entityType][1]) : entityType;
    const op = eventType === "insert" ? (es ? "creado/a" : "created") : eventType === "update" ? (es ? "actualizado/a" : "updated") : eventType === "delete" ? (es ? "eliminado/a" : "deleted") : eventType;
    return `${base} (${op})`;
  };

  const getTargetTabName = (tabKey: string) => {
    const names: Record<string, [string, string]> = {
      summary: ["Resumen", "Summary"],
      intake: ["Ingreso", "Intake"],
      risk: ["Riesgo", "Risk"],
      plan: ["Plan de atención", "Care Plan"],
      interventions: ["Intervenciones", "Interventions"],
      referral: ["Canalizaciones", "Referrals"],
      documents: ["Documentos", "Documents"],
      consent: ["Consentimiento", "Consent"],
      tasks: ["Tareas y citas", "Tasks & Appointments"],
      transfer: ["Transferencia", "Transfer"],
      closure: ["Cierre", "Closure"],
      activity: ["Actividad", "Activity"],
    };
    return names[tabKey] ? (es ? names[tabKey][0] : names[tabKey][1]) : tabKey;
  };

  const data = detailQuery.data;
  const event = data?.event;
  const record = data?.record;
  const actorName = data?.actorName;
  const actions = data?.permittedActions;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-background/60 p-0 sm:p-4 backdrop-blur-xs">
      <div className="flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-2xl sm:rounded-2xl sm:border">
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-border p-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" />
              <h3 className="text-base font-bold text-foreground">
                {event ? getEntityTitle(event.entity_type, event.event_type) : (es ? "Detalle de Actividad" : "Activity Detail")}
              </h3>
            </div>
            {event && (
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                <Clock className="h-3.5 w-3.5" />
                {new Date(event.occurred_at).toLocaleString()}
                {actorName && (
                  <>
                    <span>·</span>
                    <User className="h-3.5 w-3.5" />
                    <span>{actorName}</span>
                  </>
                )}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 space-y-6 overflow-y-auto p-6 text-xs">
          {detailQuery.isLoading && (
            <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="mt-2">{es ? "Cargando registro relacionado..." : "Loading related record..."}</p>
            </div>
          )}

          {detailQuery.isError && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive">
              <ShieldAlert className="mb-1 h-5 w-5" />
              <p className="font-semibold">{es ? "Error al cargar registro" : "Error loading record"}</p>
              <p className="mt-0.5 text-xs">{detailQuery.error?.message}</p>
            </div>
          )}

          {data && !record && (
            <div className="rounded-xl border border-border bg-muted/30 p-6 text-center text-muted-foreground">
              <Info className="mx-auto h-8 w-8 text-muted-foreground/60" />
              <p className="mt-2 font-medium text-foreground">
                {es ? "Registro no disponible o eliminado" : "Record unavailable or removed"}
              </p>
              <p className="mt-1 text-[11px]">
                {es
                  ? "El evento de auditoría permanece inmutable, pero el elemento asociado fue eliminado o archivado."
                  : "The audit event remains immutable, but the associated record was deleted or archived."}
              </p>
            </div>
          )}

          {data && record && (
            <div className="space-y-5">
              {/* Record Content by Entity Type */}
              {event?.entity_type === "social_interventions" && (
                <div className="space-y-4 rounded-xl border border-border bg-background p-4">
                  <div className="flex items-center justify-between border-b border-border pb-2">
                    <span className="font-bold text-foreground text-sm">
                      {localizedEnum(record.service_type, es)}
                    </span>
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      {localizedEnum(record.record_type, es)}
                    </span>
                  </div>

                  {!editingIntervention ? (
                    <div className="space-y-3">
                      <CaseDynamicText label={es ? "Razón / Motivo" : "Reason"} text={record.reason} />
                      <CaseDynamicText label={es ? "Acciones realizadas" : "Actions taken"} text={record.actions_taken} />
                      {record.outcome && (
                        <CaseDynamicText label={es ? "Resultado observado" : "Outcome"} text={record.outcome} />
                      )}
                      <div className="flex flex-wrap gap-4 pt-1 text-[11px] text-muted-foreground border-t border-border/60">
                        <span>{es ? "Seguimiento requerido" : "Follow-up required"}: <b>{record.follow_up_required ? (es ? "Sí" : "Yes") : (es ? "No" : "No")}</b></span>
                        <span>{es ? "Confidencialidad" : "Confidentiality"}: <b>{localizedEnum(record.confidentiality_level || "standard", es)}</b></span>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3 pt-2">
                      <label className="block font-semibold text-foreground">
                        {es ? "Razón / Motivo" : "Reason"}
                        <textarea
                          rows={2}
                          value={interventionForm.reason}
                          onChange={(e) => setInterventionForm({ ...interventionForm, reason: e.target.value })}
                          className="mt-1 w-full rounded-lg border border-border bg-card p-2 text-xs text-foreground"
                        />
                      </label>
                      <label className="block font-semibold text-foreground">
                        {es ? "Acciones realizadas" : "Actions taken"}
                        <textarea
                          rows={3}
                          value={interventionForm.actionsTaken}
                          onChange={(e) => setInterventionForm({ ...interventionForm, actionsTaken: e.target.value })}
                          className="mt-1 w-full rounded-lg border border-border bg-card p-2 text-xs text-foreground"
                        />
                      </label>
                      <label className="block font-semibold text-foreground">
                        {es ? "Resultado observado" : "Outcome"}
                        <input
                          type="text"
                          value={interventionForm.outcome}
                          onChange={(e) => setInterventionForm({ ...interventionForm, outcome: e.target.value })}
                          className="mt-1 w-full rounded-lg border border-border bg-card p-2 text-xs text-foreground"
                        />
                      </label>
                      <label className="flex items-center gap-2 font-medium text-foreground">
                        <input
                          type="checkbox"
                          checked={interventionForm.followUpRequired}
                          onChange={(e) => setInterventionForm({ ...interventionForm, followUpRequired: e.target.checked })}
                          className="rounded"
                        />
                        {es ? "Requiere seguimiento adicional" : "Requires additional follow-up"}
                      </label>

                      <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <button
                          type="button"
                          onClick={() => setEditingIntervention(false)}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted"
                        >
                          {es ? "Cancelar" : "Cancel"}
                        </button>
                        <button
                          type="button"
                          disabled={updateIntervention.isPending}
                          onClick={() => updateIntervention.mutate()}
                          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                        >
                          {updateIntervention.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                          {es ? "Guardar cambios" : "Save Changes"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {event?.entity_type === "social_care_plans" && (
                <div className="space-y-4 rounded-xl border border-border bg-background p-4">
                  <div className="flex items-center justify-between border-b border-border pb-2">
                    <span className="font-bold text-foreground text-sm">
                      {es ? "Plan de Atención" : "Care Plan"} · v{record.current_version || 1}
                    </span>
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      {localizedEnum(record.status, es)}
                    </span>
                  </div>

                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-[11px] text-muted-foreground flex items-start gap-2">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <span>
                      {es
                        ? "Las versiones del Plan de Atención son inmutables para garantizar el registro histórico. Para modificar objetivos, genere una nueva versión."
                        : "Care Plan versions are immutable records. Create a new version to modify objectives."}
                    </span>
                  </div>

                  {record.social_care_plan_versions?.[0]?.summary && (
                    <CaseDynamicText
                      label={es ? "Resumen del plan" : "Care plan summary"}
                      text={record.social_care_plan_versions[0].summary}
                    />
                  )}

                  {record.social_care_plan_versions?.[0]?.social_care_plan_goals?.length > 0 && (
                    <div className="space-y-2 border-t border-border pt-3">
                      <h5 className="font-bold text-foreground">{es ? "Objetivos registrados" : "Recorded Goals"}</h5>
                      {record.social_care_plan_versions[0].social_care_plan_goals.map((g: any, i: number) => (
                        <div key={g.id || i} className="rounded-lg border border-border/80 bg-card p-3 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-primary">{localizedEnum(g.priority || "normal", es)}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{localizedEnum(g.status || "todo", es)}</span>
                          </div>
                          {g.identified_need && <CaseDynamicText label={es ? "Necesidad" : "Need"} text={g.identified_need} />}
                          {g.goal && <CaseDynamicText label={es ? "Meta" : "Goal"} text={g.goal} />}
                          {g.planned_action && <CaseDynamicText label={es ? "Acción prevista" : "Planned action"} text={g.planned_action} />}
                          {g.target_date && <p className="text-[10px] text-muted-foreground">{es ? "Fecha objetivo" : "Target date"}: {g.target_date}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {event?.entity_type === "social_assessments" && (
                <div className="space-y-4 rounded-xl border border-border bg-background p-4">
                  <div className="flex items-center justify-between border-b border-border pb-2">
                    <span className="font-bold text-foreground text-sm">
                      {es ? "Evaluación de Riesgo" : "Risk Assessment"} · v{record.current_version || 1}
                    </span>
                    <span className="rounded bg-destructive/15 px-2 py-0.5 text-[10px] font-bold text-destructive uppercase">
                      {localizedEnum(record.risk_level, es)}
                    </span>
                  </div>

                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-[11px] text-muted-foreground flex items-start gap-2">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <span>
                      {es
                        ? "Evaluación inmutable. Para actualizar la valoración de riesgo, realice una nueva evaluación en la pestaña Riesgo."
                        : "Immutable assessment. To update risk levels, perform a new assessment in the Risk tab."}
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    <CaseDynamicText label={es ? "Razón / Criterio de riesgo" : "Reason"} text={record.reason} />
                    {record.evidence_observations && (
                      <CaseDynamicText label={es ? "Evidencia u observaciones" : "Evidence or observations"} text={record.evidence_observations} />
                    )}
                    {record.protective_factors && (
                      <CaseDynamicText label={es ? "Factores protectores" : "Protective factors"} text={record.protective_factors} />
                    )}
                    {record.immediate_actions && (
                      <CaseDynamicText label={es ? "Acciones inmediatas" : "Immediate actions"} text={record.immediate_actions} />
                    )}
                    {record.next_review_date && (
                      <p className="text-[11px] text-muted-foreground border-t border-border pt-2">
                        {es ? "Próxima revisión programada" : "Next scheduled review"}: <b>{record.next_review_date}</b>
                      </p>
                    )}
                  </div>
                </div>
              )}

              {event?.entity_type === "social_documents" && (
                <div className="space-y-4 rounded-xl border border-border bg-background p-4">
                  <div className="flex items-center justify-between border-b border-border pb-2">
                    <span className="font-bold text-foreground text-sm">{record.title}</span>
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      {localizedEnum(record.lifecycle_status || "finalized", es)}
                    </span>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2 text-[11px] text-muted-foreground">
                    <div>{es ? "Tipo" : "Type"}: <b className="text-foreground">{localizedEnum(record.document_type, es)}</b></div>
                    <div>{es ? "Registro" : "Record type"}: <b className="text-foreground">{localizedEnum(record.record_type, es)}</b></div>
                    <div>{es ? "Versión" : "Version"}: <b className="text-foreground">v{record.current_version || 1}</b></div>
                    <div>{es ? "Idioma" : "Language"}: <b className="text-foreground uppercase">{record.language_code || "es"}</b></div>
                    {record.sent_to && (
                      <div className="sm:col-span-2">{es ? "Enviado a" : "Sent to"}: <b className="text-foreground">{record.sent_to}</b> ({new Date(record.sent_at).toLocaleDateString()})</div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                    <button
                      type="button"
                      onClick={() => handleDocumentAccess(record.id, "preview")}
                      className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      {es ? "Ver PDF" : "Preview PDF"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDocumentAccess(record.id, "download")}
                      className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      {es ? "Descargar" : "Download"}
                    </button>
                  </div>
                </div>
              )}

              {event?.entity_type === "social_document_access_events" && (
                <div className="space-y-4 rounded-xl border border-border bg-background p-4">
                  <div className="flex items-center justify-between border-b border-border pb-2">
                    <span className="font-bold text-foreground text-sm">
                      {es ? "Evento de Acceso a Documento" : "Document Access Event"}
                    </span>
                    <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-semibold">
                      {localizedEnum(record.action, es)}
                    </span>
                  </div>
                  <div className="space-y-2 text-[11px] text-muted-foreground">
                    <p>{es ? "Fecha y hora" : "Timestamp"}: <b className="text-foreground">{new Date(record.occurred_at).toLocaleString()}</b></p>
                    <p>{es ? "Versión consultada" : "Version accessed"}: <b className="text-foreground">v{record.version || 1}</b></p>
                    {record.reason && (
                      <p>{es ? "Motivo registrado" : "Reason recorded"}: <b className="text-foreground">{record.reason}</b></p>
                    )}
                  </div>
                </div>
              )}

              {event?.entity_type === "social_alerts" && (
                <div className="space-y-3 rounded-xl border border-border bg-background p-4">
                  <div className="flex items-center justify-between border-b border-border pb-2">
                    <span className="font-bold text-foreground text-sm">
                      {es ? record.title_es : record.title_en}
                    </span>
                    <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-600">
                      {localizedEnum(record.severity, es)}
                    </span>
                  </div>
                  <p className="text-muted-foreground">{es ? "Tipo" : "Type"}: {localizedEnum(record.alert_type, es)}</p>
                  {record.due_at && <p className="text-muted-foreground">{es ? "Vencimiento" : "Due date"}: {new Date(record.due_at).toLocaleDateString()}</p>}
                </div>
              )}

              {event?.entity_type === "social_cases" && (
                <div className="space-y-3 rounded-xl border border-border bg-background p-4">
                  <h5 className="font-bold text-foreground border-b border-border pb-2">
                    {es ? "Estado del Caso" : "Case Status"} — {record.case_number}
                  </h5>
                  <div className="grid gap-2 sm:grid-cols-2 text-[11px] text-muted-foreground">
                    <div>{es ? "Estado" : "Status"}: <b className="text-foreground">{localizedEnum(record.status, es)}</b></div>
                    <div>{es ? "Prioridad" : "Priority"}: <b className="text-foreground">{localizedEnum(record.priority, es)}</b></div>
                    <div>{es ? "Riesgo" : "Risk"}: <b className="text-foreground">{localizedEnum(record.risk_level, es)}</b></div>
                    <div>{es ? "Última actividad" : "Last activity"}: <b className="text-foreground">{new Date(record.last_activity_at).toLocaleString()}</b></div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Collapsible Technical Details */}
          <div className="rounded-xl border border-border bg-muted/20">
            <button
              type="button"
              onClick={() => setShowTechnical(!showTechnical)}
              className="flex w-full items-center justify-between p-3 font-semibold text-muted-foreground hover:text-foreground"
            >
              <span className="flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" />
                {es ? "Detalles técnicos para administradores" : "Technical details for administrators"}
              </span>
              {showTechnical ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>

            {showTechnical && event && (
              <div className="border-t border-border p-3 font-mono text-[11px] text-muted-foreground space-y-1">
                <p><span className="text-foreground">table:</span> {event.entity_type}</p>
                <p><span className="text-foreground">operation:</span> {event.event_type}</p>
                <p><span className="text-foreground">record_id:</span> {event.entity_id || "null"}</p>
                <p><span className="text-foreground">event_id:</span> {event.id}</p>
                <p><span className="text-foreground">org_id:</span> {event.org_id}</p>
                <p><span className="text-foreground">actor_id:</span> {event.actor_id || "system"}</p>
              </div>
            )}
          </div>
        </div>

        {/* Drawer Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 p-4">
          <div className="flex items-center gap-2">
            {actions?.targetTab && actions.targetTab !== "activity" && (
              <button
                type="button"
                onClick={() => {
                  onNavigateTab(actions.targetTab);
                  onClose();
                }}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
              >
                <ExternalLink className="h-3.5 w-3.5 text-primary" />
                {es ? `Abrir en ${getTargetTabName(actions.targetTab)}` : `Open in ${getTargetTabName(actions.targetTab)}`}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {event?.entity_type === "social_interventions" && !editingIntervention && (
              <>
                <button
                  type="button"
                  onClick={() => setEditingIntervention(true)}
                  className="flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  {es ? "Editar" : "Edit"}
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteConfirmOpen(true)}
                  className="flex items-center gap-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/20"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {es ? "Eliminar" : "Delete"}
                </button>
              </>
            )}

            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
            >
              {es ? "Cerrar" : "Close"}
            </button>
          </div>
        </div>

        {/* Delete Confirmation Dialog */}
        {deleteConfirmOpen && (
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-6 shadow-2xl">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <h4 className="font-bold text-foreground">
                  {es ? "Confirmar eliminación de intervención" : "Confirm intervention deletion"}
                </h4>
              </div>
              <p className="text-xs text-muted-foreground">
                {es
                  ? "El registro de intervención será eliminado, pero el libro de auditoría registrará de forma inmutable la eliminación y el motivo."
                  : "The intervention will be deleted, but the audit log will immutably record the deletion and reason."}
              </p>
              <label className="block text-xs font-medium text-muted-foreground">
                {es ? "Motivo de la eliminación" : "Reason for deletion"}
                <input
                  type="text"
                  value={deleteReason}
                  onChange={(e) => setDeleteReason(e.target.value)}
                  placeholder={es ? "e.g. Registro duplicado, error de captura" : "e.g. Duplicate entry, capture error"}
                  className="mt-1 w-full rounded-lg border border-border bg-background p-2 text-xs text-foreground"
                />
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setDeleteConfirmOpen(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted"
                >
                  {es ? "Cancelar" : "Cancel"}
                </button>
                <button
                  type="button"
                  disabled={deleteIntervention.isPending}
                  onClick={() => deleteIntervention.mutate()}
                  className="flex items-center gap-1 rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90"
                >
                  {deleteIntervention.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                  {es ? "Confirmar eliminación" : "Confirm Delete"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
