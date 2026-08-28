import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { CheckCircle2, FileUp, Loader2, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/i18n";
import { CaseResourceRecommendations } from "@/components/social/ResourceKnowledgeNetwork";
import { TalkToCareCase } from "@/components/social/TalkToCareCase";
import { SocialCaseMediaGallery } from "@/components/social/SocialCaseMediaGallery";
import {
  acceptSocialTransfer,
  advanceSocialTransfer,
  approveSocialCarePlan,
  assignSocialCaseManager,
  closeSocialCase,
  createSocialAppointment,
  createSocialCarePlan,
  createSocialConsent,
  createSocialReferral,
  createSocialTransfer,
  deleteSocialCase,
  finalizeSocialDocumentUpload,
  getSocialCase,
  linkSocialImmigrationMatter,
  prepareSocialDocumentUpload,
  grantSocialRecordAccess,
  recordSocialAssessment,
  recordSocialIntervention,
  refreshSocialAlerts,
  reopenSocialCase,
  revokeSocialConsent,
  sendSocialReferral,
  shareSocialDocument,
  upsertSocialTask,
  updateCareCaseState,
  verifySocialReferralResult,
} from "@/lib/social.functions";

type Props = {
  caseId: string;
  people: any[];
  institutions: any[];
  templates: any[];
  roleAssignments: any[];
  organizationMembers: any[];
  currentUserId: string;
  initialTab?: Tab;
  onTabChange?: (tab: Tab) => void;
  onClose: () => void;
};
type Tab =
  | "overview"
  | "intake"
  | "assessment"
  | "plan"
  | "intervention"
  | "legal"
  | "psychosocial"
  | "consent"
  | "referral"
  | "resources"
  | "tasks"
  | "documents"
  | "transfer"
  | "closure"
  | "immigration"
  | "assistant"
  | "activity";
const PRIMARY_TABS: Array<{ id: Tab; es: string; en: string }> = [
  { id: "overview", es: "Resumen", en: "Summary" },
  { id: "intake", es: "Ingreso", en: "Intake" },
  { id: "assessment", es: "Riesgo", en: "Risk" },
  { id: "plan", es: "Plan de atención", en: "Care Plan" },
  { id: "intervention", es: "Intervenciones", en: "Interventions" },
  { id: "legal", es: "Jurídico", en: "Legal" },
  { id: "psychosocial", es: "Psicosocial", en: "Psychosocial" },
  { id: "referral", es: "Canalizaciones", en: "Referrals" },
  { id: "documents", es: "Documentos", en: "Documents" },
  { id: "activity", es: "Actividad", en: "Activity" },
  { id: "closure", es: "Cierre", en: "Closure" },
];
const CASE_FILE_ACCEPT =
  ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.csv,.tsv,.json,.xml,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.heic,.heif,.svg,.zip,.rar,.7z,.tar,.gz,.tgz,.mp3,.wav,.m4a,.aac,.ogg,.oga,.flac,.mp4,.mov,.m4v,.webm,.avi,.mpeg,.mpg,.mkv,.eml,.msg,.dcm,image/*,audio/*,video/*";
const MAX_CASE_FILE_BYTES = 100 * 1024 * 1024;

const CONTEXT_TABS: Array<{ id: Tab; es: string; en: string }> = [
  { id: "consent", es: "Consentimiento", en: "Consent" },
  { id: "resources", es: "Buscar recursos", en: "Find Resources" },
  { id: "tasks", es: "Tareas y citas", en: "Tasks & Appointments" },
  { id: "transfer", es: "Transferencia", en: "Transfer" },
  { id: "immigration", es: "Vínculo migratorio", en: "Immigration Link" },
  { id: "assistant", es: "Consultar Caso de Atención", en: "Talk to Care Case" },
];

function nextStatuses(status: string) {
  const transitions: Record<string, string[]> = {
    intake: ["intake", "assessment", "active"],
    assessment: ["assessment", "active", "monitoring"],
    active: ["active", "monitoring", "pending_referral"],
    monitoring: ["monitoring", "active", "pending_referral"],
    pending_referral: ["pending_referral", "active", "monitoring"],
    reopened: ["reopened", "assessment", "active"],
  };
  return transitions[status] ?? [status];
}

export function SocialCaseWorkspace({
  caseId,
  people,
  institutions,
  templates,
  roleAssignments,
  organizationMembers,
  currentUserId,
  initialTab,
  onTabChange,
  onClose,
}: Props) {
  const { locale } = useI18n();
  const es = locale === "es";
  const qc = useQueryClient();
  const getCaseFn = useServerFn(getSocialCase);
  const [tab, setTab] = useState<Tab>(initialTab || "overview");
  useEffect(() => {
    if (initialTab && initialTab !== tab) setTab(initialTab);
  }, [initialTab]);
  const detail = useQuery({
    queryKey: ["social-case", caseId],
    queryFn: () => getCaseFn({ data: { caseId } }),
    retry: 1,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["social-case", caseId] });
  const success = (message: string) => {
    toast.success(message);
    void refresh();
  };
  const caseData = detail.data;
  const c = caseData?.case;
  const person = caseData?.person;
  const caseMembers = caseData?.organizationMembers ?? [];
  const caseLabel = c?.case_number ?? "";
  const caseOrgId = c?.org_id ?? "";
  const casePersonId = c?.person_id ?? undefined;
  const caseFamilyId = c?.family_id ?? undefined;
  const canDeleteCase =
    !!currentUserId &&
    (c?.created_by === currentUserId || c?.supervising_manager === currentUserId);
  const deleteFn = useServerFn(deleteSocialCase);
  const deleteM = useMutation({
    mutationFn: (reason: string) => deleteFn({ data: { caseId, reason } }),
    onSuccess: async () => {
      toast.success(es ? "Caso eliminado" : "Case deleted");
      await qc.invalidateQueries({ queryKey: ["social-workspace"] });
      onClose();
    },
    onError: showError,
  });
  const requestDelete = () => {
    const reason = window
      .prompt(
        es
          ? "Explique por qué debe eliminarse este caso. Esta acción se auditará."
          : "Explain why this case must be deleted. This action will be audited.",
      )
      ?.trim();
    if (!reason) return;
    if (reason.length < 5) {
      toast.error(
        es
          ? "Escriba una razón de al menos 5 caracteres."
          : "Enter a reason of at least 5 characters.",
      );
      return;
    }
    const confirmed = window.confirm(
      es
        ? `¿Eliminar ${caseLabel}? El empleado asignado perderá acceso al caso.`
        : `Delete ${caseLabel}? The assigned employee will lose access to the case.`,
    );
    if (confirmed) deleteM.mutate(reason);
  };

  const assessmentFn = useServerFn(recordSocialAssessment);
  const [assessment, setAssessment] = useState({
    riskLevel: "unknown" as "unknown" | "low" | "moderate" | "high" | "critical",
    reason: "",
    evidence: "",
    protective: "",
    actions: "",
    followUp: "",
    review: "",
    override: false,
    overrideExplanation: "",
    templateId: "",
  });
  const assessmentM = useMutation({
    mutationFn: () =>
      assessmentFn({
        data: {
          socialCaseId: caseId,
          templateId: assessment.templateId || undefined,
          riskLevel: assessment.riskLevel,
          reason: assessment.reason,
          evidenceObservations: assessment.evidence || undefined,
          protectiveFactors: assessment.protective || undefined,
          immediateActions: assessment.actions || undefined,
          requiredFollowUp: assessment.followUp || undefined,
          nextReviewDate: assessment.review || undefined,
          answers: {},
          professionalOverride: assessment.override,
          overrideExplanation: assessment.overrideExplanation || undefined,
        },
      }),
    onSuccess: () => success(es ? "Evaluación guardada" : "Assessment saved"),
    onError: showError,
  });

  const planFn = useServerFn(createSocialCarePlan);
  const approveFn = useServerFn(approveSocialCarePlan);
  const [plan, setPlan] = useState({
    summary: "",
    need: "",
    goal: "",
    action: "",
    target: "",
    outcome: "",
  });
  const planM = useMutation({
    mutationFn: () =>
      planFn({
        data: {
          socialCaseId: caseId,
          summary: plan.summary,
          status: "under_review",
          goals: [
            {
              identifiedNeed: plan.need,
              goal: plan.goal,
              plannedAction: plan.action,
              targetDate: plan.target || undefined,
              priority: "normal",
              expectedOutcome: plan.outcome || undefined,
            },
          ],
        },
      }),
    onSuccess: () => success(es ? "Plan creado para revisión" : "Plan created for review"),
    onError: showError,
  });
  const approveM = useMutation({
    mutationFn: (x: { id: string; version: number }) =>
      approveFn({ data: { planId: x.id, version: x.version } }),
    onSuccess: () => success(es ? "Plan aprobado" : "Plan approved"),
    onError: showError,
  });

  const interventionFn = useServerFn(recordSocialIntervention);
  const [intervention, setIntervention] = useState({
    serviceType: "social_work",
    reason: "",
    actions: "",
    outcome: "",
    recordType: "general_case_record" as any,
    followUp: false,
    carePlanGoalId: "",
  });
  const openTab = (next: Tab) => {
    setTab(next);
    onTabChange?.(next);
    if (next === "legal")
      setIntervention((current) => ({
        ...current,
        serviceType: "legal_assistance",
        recordType: "legal_privileged_record",
      }));
    if (next === "psychosocial")
      setIntervention((current) => ({
        ...current,
        serviceType: "psychological_support",
        recordType: "psychosocial_restricted_record",
      }));
    if (next === "intervention")
      setIntervention((current) => ({
        ...current,
        serviceType: "social_work",
        recordType: "general_case_record",
      }));
  };
  const interventionM = useMutation({
    mutationFn: () =>
      interventionFn({
        data: {
          socialCaseId: caseId,
          occurredAt: new Date().toISOString(),
          serviceType: intervention.serviceType,
          reason: intervention.reason,
          actionsTaken: intervention.actions,
          outcome: intervention.outcome || undefined,
          followUpRequired: intervention.followUp,
          recordType: intervention.recordType,
          confidentialityLevel:
            intervention.recordType === "general_case_record" ? "standard" : "restricted",
          carePlanGoalId: intervention.carePlanGoalId || undefined,
        },
      }),
    onSuccess: () => success(es ? "Intervención registrada" : "Intervention recorded"),
    onError: showError,
  });

  const consentFn = useServerFn(createSocialConsent);
  const revokeFn = useServerFn(revokeSocialConsent);
  const [consent, setConsent] = useState({
    type: "interinstitutional_data_sharing",
    consentedBy: "",
    purposes: "referral",
    recipients: "",
    information: "name,contact",
    restrictions: "",
    expires: "",
  });
  const consentM = useMutation({
    mutationFn: () =>
      consentFn({
        data: {
          orgId: caseOrgId,
          personId: casePersonId ?? undefined,
          familyId: caseFamilyId ?? undefined,
          consentType: consent.type,
          language: locale,
          consentedByName: consent.consentedBy,
          permittedPurposes: split(consent.purposes),
          permittedRecipients: split(consent.recipients),
          permittedInformation: split(consent.information),
          restrictions: consent.restrictions || undefined,
          expiresAt: consent.expires ? new Date(consent.expires).toISOString() : undefined,
        },
      }),
    onSuccess: () => success(es ? "Consentimiento versionado" : "Consent version recorded"),
    onError: showError,
  });
  const revokeM = useMutation({
    mutationFn: (id: string) =>
      revokeFn({
        data: {
          consentId: id,
          reason: "Revocado por usuario autorizado / Revoked by authorized user",
        },
      }),
    onSuccess: () => success(es ? "Consentimiento revocado" : "Consent revoked"),
    onError: showError,
  });

  const referralFn = useServerFn(createSocialReferral);
  const sendReferralFn = useServerFn(sendSocialReferral);
  const verifyReferralFn = useServerFn(verifySocialReferralResult);
  const [referral, setReferral] = useState({
    institutionId: "",
    service: "",
    reason: "",
    urgency: "normal" as "low" | "normal" | "high" | "urgent",
    consentId: "",
    information: "name,contact",
    result: "",
  });
  const referralM = useMutation({
    mutationFn: () =>
      referralFn({
        data: {
          socialCaseId: caseId,
          institutionId: referral.institutionId,
          serviceRequested: referral.service,
          reason: referral.reason,
          urgency: referral.urgency,
          consentId: referral.consentId || undefined,
          authorizedInformation: split(referral.information),
        },
      }),
    onSuccess: () => success(es ? "Canalización creada" : "Referral created"),
    onError: showError,
  });
  const sendReferralM = useMutation({
    mutationFn: (id: string) =>
      sendReferralFn({
        data: {
          referralId: id,
          purpose: "referral",
          sharedFields: Object.fromEntries(split(referral.information).map((k) => [k, true])),
        },
      }),
    onSuccess: () =>
      success(es ? "Canalización enviada con consentimiento" : "Referral sent with consent"),
    onError: showError,
  });
  const verifyReferralM = useMutation({
    mutationFn: (id: string) =>
      verifyReferralFn({
        data: {
          referralId: id,
          result: referral.result,
          response: "Resultado verificado por personal autorizado",
        },
      }),
    onSuccess: () => success(es ? "Resultado verificado" : "Result verified"),
    onError: showError,
  });

  const taskFn = useServerFn(upsertSocialTask);
  const appointmentFn = useServerFn(createSocialAppointment);
  const alertsFn = useServerFn(refreshSocialAlerts);
  const [task, setTask] = useState({
    title: "",
    due: "",
    priority: "normal" as "low" | "normal" | "high" | "urgent",
  });
  const [appointment, setAppointment] = useState({ title: "", when: "", method: "" });
  const taskM = useMutation({
    mutationFn: () =>
      taskFn({
        data: {
          socialCaseId: caseId,
          title: task.title,
          dueAt: task.due ? new Date(task.due).toISOString() : undefined,
          priority: task.priority,
          status: "todo",
        },
      }),
    onSuccess: () => success(es ? "Tarea creada" : "Task created"),
    onError: showError,
  });
  const appointmentM = useMutation({
    mutationFn: () =>
      appointmentFn({
        data: {
          socialCaseId: caseId,
          title: appointment.title,
          scheduledAt: new Date(appointment.when).toISOString(),
          locationMethod: appointment.method || undefined,
        },
      }),
    onSuccess: () => success(es ? "Cita programada" : "Appointment scheduled"),
    onError: showError,
  });
  const alertsM = useMutation({
    mutationFn: () => alertsFn({ data: { caseId } }),
    onSuccess: () => success(es ? "Alertas actualizadas" : "Alerts refreshed"),
    onError: showError,
  });

  const prepareFn = useServerFn(prepareSocialDocumentUpload);
  const finalizeFn = useServerFn(finalizeSocialDocumentUpload);
  const [document, setDocument] = useState({
    files: [] as File[],
    title: "",
    type: "supporting_document",
    recordType: "general_case_record" as any,
    sensitivity: "confidential" as any,
    consentId: "",
  });
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0, name: "" });
  const selectCaseFiles = (incoming: File[]) => {
    const tooLarge = incoming.find((file) => file.size > MAX_CASE_FILE_BYTES);
    if (tooLarge) {
      toast.error(
        es
          ? `${tooLarge.name} supera el límite de 100 MB`
          : `${tooLarge.name} exceeds the 100 MB limit`,
      );
      return;
    }
    setDocument((current) => ({
      ...current,
      files: incoming,
      title: incoming.length === 1 ? incoming[0].name : "",
    }));
  };
  const documentM = useMutation({
    mutationFn: async () => {
      if (!document.files.length)
        throw new Error(es ? "Seleccione uno o más archivos" : "Select one or more files");
      const results = [];
      for (let index = 0; index < document.files.length; index += 1) {
        const file = document.files[index];
        setUploadProgress({ current: index + 1, total: document.files.length, name: file.name });
        const mimeType = file.type || "application/octet-stream";
        const prepared = await prepareFn({
          data: {
            orgId: caseOrgId,
            socialCaseId: caseId,
            recordType: document.recordType,
            fileName: file.name,
            mimeType,
            sizeBytes: file.size,
          },
        });
        const { error } = await supabase.storage
          .from("social-case-files")
          .uploadToSignedUrl(prepared.path, prepared.token, file, { contentType: mimeType });
        if (error) throw error;
        try {
          results.push(
            await finalizeFn({
              data: {
                socialCaseId: caseId,
                path: prepared.path,
                title:
                  document.files.length === 1 && document.title.trim()
                    ? document.title.trim()
                    : file.name,
                documentType: document.type,
                recordType: document.recordType,
                sensitivity: document.sensitivity,
                consentId: document.consentId || undefined,
                extractionAuthorized: false,
                mimeType,
              },
            }),
          );
        } catch (error) {
          await supabase.storage.from("social-case-files").remove([prepared.path]);
          throw error;
        }
      }
      return results;
    },
    onSuccess: (results) => {
      const duplicates = results.filter((result: any) => result.duplicate).length;
      toast.success(
        es
          ? `${results.length} archivo(s) procesados${duplicates ? ` · ${duplicates} duplicado(s) omitidos` : ""}`
          : `${results.length} file(s) processed${duplicates ? ` · ${duplicates} duplicate(s) skipped` : ""}`,
      );
      setDocument((current) => ({ ...current, files: [], title: "" }));
      setUploadProgress({ current: 0, total: 0, name: "" });
      void refresh();
      void qc.invalidateQueries({ queryKey: ["social-case-media", caseId] });
    },
    onError: (error) => {
      setUploadProgress({ current: 0, total: 0, name: "" });
      showError(error);
    },
  });

  const transferFn = useServerFn(createSocialTransfer);
  const advanceFn = useServerFn(advanceSocialTransfer);
  const acceptFn = useServerFn(acceptSocialTransfer);
  const [transfer, setTransfer] = useState({
    type: "case_manager" as any,
    toUser: "",
    receivingOrg: "",
    consentId: "",
    summary: "",
    information: "case_summary,tasks,deadlines",
  });
  const transferM = useMutation({
    mutationFn: () =>
      transferFn({
        data: {
          socialCaseId: caseId,
          transferType: transfer.type,
          toUserId: transfer.toUser || undefined,
          receivingOrgId: transfer.receivingOrg || undefined,
          consentId: transfer.consentId || undefined,
          selectedInformation: Object.fromEntries(
            split(transfer.information).map((k) => [k, true]),
          ),
          restrictedInformation: { excluded: true },
          summary: transfer.summary,
          deadlines: [],
        },
      }),
    onSuccess: () =>
      success(es ? "Transferencia enviada a aprobación" : "Transfer submitted for approval"),
    onError: showError,
  });
  const advanceM = useMutation({
    mutationFn: (x: { id: string; action: "approve" | "send" | "reject" }) =>
      advanceFn({ data: { transferId: x.id, action: x.action } }),
    onSuccess: () => success(es ? "Transferencia actualizada" : "Transfer updated"),
    onError: showError,
  });
  const acceptM = useMutation({
    mutationFn: (id: string) => acceptFn({ data: { transferId: id } }),
    onSuccess: () => success(es ? "Recepción confirmada" : "Receipt confirmed"),
    onError: showError,
  });

  const closeFn = useServerFn(closeSocialCase);
  const reopenFn = useServerFn(reopenSocialCase);
  const [closure, setClosure] = useState({
    reason: "services_completed" as any,
    finalRisk: "unknown" as any,
    summary: "",
    clientNotification: "",
    documentDisposition: "",
    retentionStatus: "",
    reopenReason: "",
  });
  const closeM = useMutation({
    mutationFn: () =>
      closeFn({
        data: {
          caseId,
          reason: closure.reason,
          finalRisk: closure.finalRisk,
          summary: {
            goals_completed: closure.summary,
            client_notification: closure.clientNotification,
            document_disposition: closure.documentDisposition,
            retention_status: closure.retentionStatus,
          },
        },
      }),
    onSuccess: () => success(es ? "Caso cerrado con revisión" : "Case closed with review"),
    onError: showError,
  });
  const reopenM = useMutation({
    mutationFn: () => reopenFn({ data: { caseId, reason: closure.reopenReason } }),
    onSuccess: () => success(es ? "Caso reabierto" : "Case reopened"),
    onError: showError,
  });

  const immigrationFn = useServerFn(linkSocialImmigrationMatter);
  const [immigration, setImmigration] = useState({
    matterId: "",
    consentId: "",
    statusFields: "status,deadlines",
    socialFields: "contact,non_refoulement_concern",
    documents: "",
  });
  const immigrationM = useMutation({
    mutationFn: () =>
      immigrationFn({
        data: {
          socialCaseId: caseId,
          immigrationCaseId: immigration.matterId,
          consentId: immigration.consentId,
          permittedStatusFields: split(immigration.statusFields),
          sharedSocialFields: split(immigration.socialFields),
          sharedDocumentIds: split(immigration.documents),
          nonRefoulementConcern: false,
          detentionDeportationRisk: false,
        },
      }),
    onSuccess: () => success(es ? "Vínculo migratorio autorizado" : "Immigration link authorized"),
    onError: showError,
  });

  const assignFn = useServerFn(assignSocialCaseManager);
  const [assignment, setAssignment] = useState({ userId: "", role: "case_manager" as any });
  const assignM = useMutation({
    mutationFn: () =>
      assignFn({ data: { caseId, userId: assignment.userId, role: assignment.role } }),
    onSuccess: () => success(es ? "Asignación actualizada" : "Assignment updated"),
    onError: showError,
  });
  const stateFn = useServerFn(updateCareCaseState);
  const [showStateEditor, setShowStateEditor] = useState(false);
  const [stateEditor, setStateEditor] = useState({ status: "", priority: "", reason: "" });
  const stateM = useMutation({
    mutationFn: () =>
      stateFn({
        data: {
          caseId,
          status: (stateEditor.status || c?.status || "intake") as any,
          priority: (stateEditor.priority || c?.priority || "standard") as any,
          reason: stateEditor.reason,
        },
      }),
    onSuccess: () => {
      setShowStateEditor(false);
      setStateEditor({ status: "", priority: "", reason: "" });
      success(es ? "Estado del caso actualizado" : "Case state updated");
    },
    onError: showError,
  });
  const grantFn = useServerFn(grantSocialRecordAccess);
  const [grant, setGrant] = useState({
    userId: "",
    recordType: "legal_privileged_record" as any,
    reason: "",
    canWrite: false,
  });
  const grantM = useMutation({
    mutationFn: () =>
      grantFn({
        data: {
          caseId,
          userId: grant.userId,
          recordType: grant.recordType,
          reason: grant.reason,
          canWrite: grant.canWrite,
        },
      }),
    onSuccess: () =>
      success(
        es ? "Acceso restringido concedido y auditado" : "Restricted access granted and audited",
      ),
    onError: showError,
  });
  const shareFn = useServerFn(shareSocialDocument);
  const [share, setShare] = useState({
    documentId: "",
    receivingOrgId: "",
    consentId: "",
    purpose: "case_coordination",
  });
  const shareM = useMutation({
    mutationFn: () =>
      shareFn({
        data: {
          documentId: share.documentId,
          receivingOrgId: share.receivingOrgId,
          consentId: share.consentId,
          purpose: share.purpose,
        },
      }),
    onSuccess: () =>
      success(es ? "Documento compartido con consentimiento" : "Document shared with consent"),
    onError: showError,
  });

  const latestGoals = (caseData?.plans ?? []).flatMap((carePlan: any) => {
    const versions = carePlan.social_care_plan_versions ?? [];
    const latest =
      versions.find((version: any) => version.version === carePlan.current_version) ??
      versions.at(-1);
    return latest?.social_care_plan_goals ?? [];
  });
  const currentIntake = caseData?.intakes?.[0];
  const currentAssessment = caseData?.assessments?.[0];
  const currentAssessmentVersion =
    currentAssessment?.social_assessment_versions?.find(
      (version: any) => version.version === currentAssessment.current_version,
    ) ?? currentAssessment?.social_assessment_versions?.at(-1);
  const currentPlan = caseData?.plans?.[0];
  const currentPlanVersion =
    currentPlan?.social_care_plan_versions?.find(
      (version: any) => version.version === currentPlan.current_version,
    ) ?? currentPlan?.social_care_plan_versions?.at(-1);
  const incompleteGoals = latestGoals.filter(
    (goal: any) => !["completed", "done", "achieved", "cancelled"].includes(goal.status),
  );
  const openTasks = (caseData?.tasks ?? []).filter(
    (task: any) => !["done", "cancelled"].includes(task.status),
  );
  const pendingReferrals = (caseData?.referrals ?? []).filter(
    (referral: any) =>
      !["completed", "rejected", "unable_to_contact", "cancelled"].includes(referral.status),
  );
  const closureBlockerCount = incompleteGoals.length + openTasks.length + pendingReferrals.length;
  const closureReady = closure.reason !== "services_completed" || closureBlockerCount === 0;

  const isServiceTab = tab === "intervention" || tab === "legal" || tab === "psychosocial";

  if (detail.isLoading)
    return (
      <Panel>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          {es ? "Abriendo el expediente…" : "Opening case workspace…"}
        </div>
      </Panel>
    );
  if (detail.isError || !caseData || !c) {
    const message =
      detail.error instanceof Error
        ? detail.error.message
        : es
          ? "No fue posible abrir el expediente."
          : "The case workspace could not be opened.";
    return (
      <Panel>
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <h2 className="font-semibold text-destructive">
            {es ? "No se pudo abrir el caso" : "Case could not be opened"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void detail.refetch()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              {es ? "Reintentar" : "Retry"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border px-4 py-2 text-sm"
            >
              {es ? "Volver a casos" : "Back to cases"}
            </button>
          </div>
        </div>
      </Panel>
    );
  }
  return (
    <div className="rounded-2xl border border-primary/25 bg-card shadow-xl">
      {!!caseData.warnings?.length && (
        <div
          role="status"
          className="m-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm"
        >
          <p className="font-semibold">
            {es
              ? "El caso abrió, pero algunas secciones necesitan atención"
              : "The case opened, but some sections need attention"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{caseData.warnings.join(" · ")}</p>
        </div>
      )}
      <div className="border-b border-border p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-sm text-primary">{caseLabel}</p>
            <h2 className="text-xl font-semibold">
              {person?.legal_name ?? (es ? "Cliente no vinculado" : "No linked client")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {localizedEnum(c?.case_type, es)} ·{" "}
              {c?.status === "intake" ? (es ? "Nuevo" : "New") : localizedEnum(c?.status, es)} ·{" "}
              {localizedEnum(c?.priority, es)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canDeleteCase && (
              <button
                type="button"
                onClick={requestDelete}
                disabled={deleteM.isPending}
                className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive disabled:opacity-50"
              >
                {deleteM.isPending ? (
                  <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 inline h-4 w-4" />
                )}
                {es ? "Eliminar caso" : "Delete case"}
              </button>
            )}
            {!["transferred", "archived"].includes(c?.status) && (
              <button
                onClick={() =>
                  c?.status === "closed" ? openTab("closure") : setShowStateEditor((v) => !v)
                }
                className="rounded-lg border border-border px-3 py-2 text-sm"
              >
                {c?.status === "closed"
                  ? es
                    ? "Reabrir en Cierre"
                    : "Reopen in Closure"
                  : es
                    ? "Cambiar estado"
                    : "Change state"}
              </button>
            )}
            <button
              onClick={() => openTab("overview")}
              className="rounded-lg border border-border px-3 py-2 text-sm"
            >
              {es ? "Reasignar" : "Reassign"}
            </button>
            <button
              onClick={() => openTab("activity")}
              className="rounded-lg border border-border px-3 py-2 text-sm"
            >
              {es ? "Ver actividad" : "View activity"}
            </button>
            <button
              onClick={() => openTab("assistant")}
              className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
            >
              {es ? "Consultar Caso de Atención" : "Talk to Care Case"}
            </button>
            <button onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-sm">
              {es ? "Cerrar espacio" : "Close workspace"}
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
          <span>
            {es ? "Responsable" : "Assigned"}:{" "}
            <strong className="text-foreground">
              {caseMembers.find((m: any) => m.user_id === c?.assigned_case_manager)?.name ??
                (es ? "Sin asignar" : "Unassigned")}
            </strong>
          </span>
          <span>
            {es ? "Supervisor" : "Supervisor"}:{" "}
            <strong className="text-foreground">
              {caseMembers.find((m: any) => m.user_id === c?.supervising_manager)?.name ??
                "—"}
            </strong>
          </span>
          <span>
            {es ? "Riesgo" : "Risk"}:{" "}
            <strong className="text-foreground">{localizedEnum(c?.risk_level, es)}</strong>
          </span>
          <span>
            {es ? "Última actividad" : "Last activity"}:{" "}
            <strong className="text-foreground">
              {c?.last_activity_at ? new Date(c.last_activity_at).toLocaleString() : "—"}
            </strong>
          </span>
        </div>
        {showStateEditor && c?.status !== "closed" && (
          <div className="mt-4 rounded-xl border border-primary/25 bg-primary/5 p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <Select
                label={es ? "Estado operativo" : "Operational status"}
                value={stateEditor.status || c.status}
                onChange={(v) => setStateEditor({ ...stateEditor, status: v })}
                options={nextStatuses(c.status).map((v) => ({
                  value: v,
                  label: localizedEnum(v, es),
                }))}
              />
              <Select
                label={es ? "Prioridad" : "Priority"}
                value={stateEditor.priority || c.priority}
                onChange={(v) => setStateEditor({ ...stateEditor, priority: v })}
                options={["standard", "urgent", "emergency"].map((v) => ({
                  value: v,
                  label: localizedEnum(v, es),
                }))}
              />
              <Input
                label={es ? "Razón documentada" : "Documented reason"}
                value={stateEditor.reason}
                onChange={(v) => setStateEditor({ ...stateEditor, reason: v })}
              />
            </div>
            {(stateEditor.priority || c.priority) === "emergency" && c.priority !== "emergency" && (
              <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                {es
                  ? "La prioridad de emergencia crea una alerta crítica y una tarea inmediata. No sustituye servicios de emergencia."
                  : "Emergency priority creates a critical alert and immediate task. It does not replace emergency services."}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <Action
                busy={stateM.isPending}
                disabled={
                  stateEditor.reason.trim().length < 5 ||
                  ((stateEditor.status || c.status) === c.status &&
                    (stateEditor.priority || c.priority) === c.priority)
                }
                onClick={() => stateM.mutate()}
              >
                {es ? "Guardar cambio" : "Save change"}
              </Action>
              <button
                type="button"
                onClick={() => setShowStateEditor(false)}
                className="rounded-lg border border-border px-3 py-2 text-sm"
              >
                {es ? "Cancelar" : "Cancel"}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="border-b border-border p-2">
        <div className="flex gap-1 overflow-x-auto">
          {PRIMARY_TABS.map((x) => (
            <button
              key={x.id}
              onClick={() => openTab(x.id)}
              className={`shrink-0 rounded-md px-3 py-2 text-xs ${tab === x.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {es ? x.es : x.en}
            </button>
          ))}
        </div>
        <details className="mt-1">
          <summary className="w-fit cursor-pointer rounded-md px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted">
            {es ? "Más acciones del caso" : "More case actions"}
          </summary>
          <div className="flex gap-1 overflow-x-auto pt-1">
            {CONTEXT_TABS.map((x) => (
              <button
                key={x.id}
                onClick={() => openTab(x.id)}
                className={`shrink-0 rounded-md px-3 py-2 text-xs ${tab === x.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                {es ? x.es : x.en}
              </button>
            ))}
          </div>
        </details>
      </div>
      <div className="p-5">
        {tab === "overview" && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryStat label={es ? "Estado" : "Status"} value={localizedEnum(c.status, es)} />
              <SummaryStat
                label={es ? "Riesgo actual" : "Current risk"}
                value={localizedEnum(currentAssessment?.risk_level ?? c.risk_level, es)}
                urgent={["high", "critical"].includes(
                  currentAssessment?.risk_level ?? c.risk_level,
                )}
              />
              <SummaryStat
                label={es ? "Ingreso" : "Intake"}
                value={
                  currentIntake
                    ? localizedEnum(currentIntake.status, es)
                    : es
                      ? "No vinculado"
                      : "Not linked"
                }
              />
              <SummaryStat
                label={es ? "Plan actual" : "Current plan"}
                value={
                  currentPlan
                    ? `${localizedEnum(currentPlan.status, es)} · v${currentPlan.current_version}`
                    : es
                      ? "Sin plan"
                      : "No plan"
                }
              />
              <SummaryStat
                label={es ? "Metas abiertas" : "Open goals"}
                value={String(incompleteGoals.length)}
              />
              <SummaryStat
                label={es ? "Intervenciones" : "Interventions"}
                value={String(caseData.interventions.length)}
              />
              <SummaryStat
                label={es ? "Tareas abiertas" : "Open tasks"}
                value={String(openTasks.length)}
              />
              <SummaryStat
                label={es ? "Alertas activas" : "Active alerts"}
                value={String(caseData.alerts.length)}
                urgent={caseData.alerts.some((x:any) => ["high", "critical"].includes(x.severity))}
              />
              <SummaryStat
                label={es ? "Documentos faltantes" : "Missing documents"}
                value={String(caseData.requirements.filter((x:any) => x.status === "missing").length)}
              />
              <SummaryStat
                label={es ? "Consentimiento" : "Consent"}
                value={
                  caseData.consents.some(
                    (x: any) =>
                      x.status === "active" &&
                      (!x.expires_at || new Date(x.expires_at) > new Date()),
                  )
                    ? es
                      ? "Activo"
                      : "Active"
                    : es
                      ? "Requiere atención"
                      : "Needs attention"
                }
              />
            </div>
            <Two>
              <Panel>
                <h3 className="font-semibold text-success">
                  {es ? "Trabajo completado" : "Work completed"}
                </h3>
                <div className="space-y-2 text-sm">
                  {currentIntake && (
                    <p>
                      ✓ {es ? "Ingreso registrado" : "Intake recorded"} ·{" "}
                      {currentIntake.intake_number}
                    </p>
                  )}
                  {currentAssessment && (
                    <p>
                      ✓ {es ? "Evaluación de riesgo" : "Risk assessment"} ·{" "}
                      {localizedEnum(currentAssessment.risk_level, es)} · v
                      {currentAssessment.current_version}
                    </p>
                  )}
                  {currentPlan && (
                    <p>
                      ✓ {es ? "Plan de atención creado" : "Care plan created"} · v
                      {currentPlan.current_version}
                    </p>
                  )}
                  {caseData.interventions.length > 0 && (
                    <p>
                      ✓ {es ? "Intervenciones registradas" : "Interventions recorded"} ·{" "}
                      {caseData.interventions.length}
                    </p>
                  )}
                  {caseData.documents.length > 0 && (
                    <p>
                      ✓ {es ? "Documentos archivados" : "Documents on file"} ·{" "}
                      {caseData.documents.length}
                    </p>
                  )}
                  {!currentIntake &&
                    !currentAssessment &&
                    !currentPlan &&
                    !caseData.interventions.length && (
                      <p className="text-muted-foreground">
                        {es
                          ? "Aún no hay trabajo registrado."
                          : "No completed work is recorded yet."}
                      </p>
                    )}
                </div>
              </Panel>
              <Panel>
                <h3 className="font-semibold text-warning">
                  {es ? "Requiere atención" : "Needs attention"}
                </h3>
                <div className="space-y-2 text-sm">
                  {!currentIntake && (
                    <button
                      onClick={() => openTab("intake")}
                      className="block text-left text-primary underline"
                    >
                      {es ? "Vincular o completar ingreso →" : "Link or complete intake →"}
                    </button>
                  )}
                  {["high", "critical"].includes(currentAssessment?.risk_level ?? c.risk_level) && (
                    <button
                      onClick={() => openTab("assessment")}
                      className="block text-left text-primary underline"
                    >
                      {es ? "Riesgo alto requiere revisión →" : "High risk requires review →"}
                    </button>
                  )}
                  {incompleteGoals.map((goal: any) => (
                    <button
                      key={goal.id}
                      onClick={() => openTab("plan")}
                      className="block text-left text-primary underline"
                    >
                      {goal.goal} →
                    </button>
                  ))}
                  {openTasks.length > 0 && (
                    <button
                      onClick={() => openTab("tasks")}
                      className="block text-left text-primary underline"
                    >
                      {es
                        ? `${openTasks.length} tarea(s) abierta(s) →`
                        : `${openTasks.length} open task(s) →`}
                    </button>
                  )}
                  {pendingReferrals.length > 0 && (
                    <button
                      onClick={() => openTab("referral")}
                      className="block text-left text-primary underline"
                    >
                      {es
                        ? `${pendingReferrals.length} canalización(es) pendiente(s) →`
                        : `${pendingReferrals.length} pending referral(s) →`}
                    </button>
                  )}
                </div>
              </Panel>
            </Two>
            <details>
              <summary className="cursor-pointer text-sm font-medium text-primary">
                {es ? "Administrar asignación y acceso" : "Manage assignment and access"}
              </summary>
              <Two>
                <Panel>
                  <h3 className="font-semibold">{es ? "Asignación profesional" : "Professional assignment"}</h3>
                  <Select label={es ? "Usuario autorizado" : "Authorized user"} value={assignment.userId} onChange={(v) => setAssignment({ ...assignment, userId: v })} options={(organizationMembers.length ? organizationMembers.filter((m:any) => m.status === "active").map((m:any) => ({ value:m.user_id, label:`${m.name} · ${m.role}` })) : roleAssignments.map((r:any) => ({ value:r.user_id, label:`${r.user_id.slice(0,8)} · ${r.role}` })))}/>
                  <Select label={es ? "Función" : "Role"} value={assignment.role} onChange={(v) => setAssignment({ ...assignment, role:v })} options={["case_manager","supervisor","attorney","psychologist","social_worker"].map((v) => ({ value:v, label:v }))}/>
                  <Action busy={assignM.isPending} disabled={!assignment.userId} onClick={() => assignM.mutate()}>{es ? "Asignar" : "Assign"}</Action>
                </Panel>
                <Panel>
                  <h3 className="font-semibold">{es ? "Acceso ético a registro restringido" : "Ethical-screen record access"}</h3>
                  <Input label={es ? "UUID del usuario" : "User UUID"} value={grant.userId} onChange={(v) => setGrant({ ...grant, userId:v })}/>
                  <Select label={es ? "Tipo de registro" : "Record type"} value={grant.recordType} onChange={(v) => setGrant({ ...grant, recordType:v })} options={recordOptions.filter((x) => x.value !== "general_case_record")}/>
                  <Text label={es ? "Razón documentada" : "Documented reason"} value={grant.reason} onChange={(v) => setGrant({ ...grant, reason:v })}/>
                  <label className="flex gap-2 text-sm"><input type="checkbox" checked={grant.canWrite} onChange={(e) => setGrant({ ...grant, canWrite:e.target.checked })}/>{es ? "Permitir escritura" : "Allow write"}</label>
                  <Action busy={grantM.isPending} disabled={!grant.userId || grant.reason.length < 5} onClick={() => grantM.mutate()}>{es ? "Conceder acceso limitado" : "Grant limited access"}</Action>
                </Panel>
              </Two>
            </details>
            <button onClick={() => openTab("activity")} className="text-sm text-primary underline">
              {es ? "Ver toda la actividad" : "View all activity"}
            </button>
          </div>
        )}
        {tab === "intake" && (
          <Two>
            <Panel>
              <h3 className="font-semibold">{es ? "Ingreso vinculado al caso" : "Case intake"}</h3>
              <p className="text-sm text-muted-foreground">
                {es
                  ? "Este expediente conserva la identidad del caso desde el ingreso hasta el cierre. Los detalles de ingreso, prioridad y asignación pertenecen a este mismo caso y no crean un espacio separado."
                  : "This record keeps the same case identity from intake through closure. Intake, priority, and assignment details belong to this case and do not create a separate workspace."}
              </p>
              <div className="grid gap-2 text-sm">
                <p>
                  <strong>{es ? "Registro de ingreso" : "Intake record"}:</strong>{" "}
                  {currentIntake?.intake_number ?? (es ? "No vinculado" : "Not linked")}
                </p>
                {currentIntake && (
                  <>
                    <p><strong>{es ? "Estado del ingreso" : "Intake status"}:</strong> {localizedEnum(currentIntake.status, es)}</p>
                    <p><strong>{es ? "Fuente" : "Source"}:</strong> {currentIntake.source || "—"}</p>
                    <p><strong>{es ? "Preocupación principal" : "Primary concern"}:</strong> {currentIntake.summary || "—"}</p>
                    <p><strong>{es ? "Necesidades presentadas" : "Presenting needs"}:</strong> {(currentIntake.presenting_needs ?? []).join(", ") || "—"}</p>
                  </>
                )}
                <p>
                  <strong>{es ? "Número de caso" : "Case number"}:</strong> {caseLabel}
                </p>
                <p>
                  <strong>{es ? "Cliente" : "Client"}:</strong>{" "}
                  {person?.legal_name ?? (es ? "Cliente no vinculado" : "No linked client")}
                </p>
                <p>
                  <strong>{es ? "Tipo" : "Type"}:</strong> {localizedEnum(c?.case_type, es)}
                </p>
                <p>
                  <strong>{es ? "Prioridad inicial" : "Initial priority"}:</strong>{" "}
                  {localizedEnum(c?.priority, es)}
                </p>
                <p>
                  <strong>{es ? "Estado actual" : "Current status"}:</strong>{" "}
                  {localizedEnum(c?.status, es)}
                </p>
              </div>
            </Panel>
            <History
              title={es ? "Trazabilidad de ingreso" : "Intake trace"}
              rows={caseData.activity.filter((x: any) =>
                ["intake", "case_created", "case_opened"].some((k) =>
                  String(x.event_type).includes(k),
                ),
              )}
              render={(x) => (
                <p>
                  {new Date(x.occurred_at).toLocaleString()} · {localizedEnum(x.event_type, es)} ·{" "}
                  {caseMembers.find((m: any) => m.user_id === x.actor_id)?.name ??
                    (es ? "Usuario autorizado" : "Authorized user")}
                </p>
              )}
            />
          </Two>
        )}
        {tab === "assessment" && (
          <div className="space-y-4">
            {currentAssessment && (
              <Panel>
                <h3 className="font-semibold">
                  {es ? "Evaluación de riesgo actual" : "Current risk assessment"}
                </h3>
                <div
                  className={`rounded-lg border p-4 ${["high", "critical"].includes(currentAssessment.risk_level) ? "border-destructive/40 bg-destructive/10" : "border-primary/25 bg-primary/5"}`}
                >
                  <p className="text-lg font-bold">
                    {localizedEnum(currentAssessment.risk_level, es)} · v
                    {currentAssessment.current_version}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {es ? "Fecha de evaluación" : "Assessment date"}: {new Date(currentAssessment.assessment_date).toLocaleDateString()}
                  </p>
                </div>
                <div className="grid gap-3 text-sm md:grid-cols-2">
                  <Detail label={es ? "Razón" : "Reason"} value={currentAssessmentVersion?.reason} />
                  <Detail label={es ? "Evidencia u observaciones" : "Evidence or observations"} value={currentAssessmentVersion?.evidence_observations} />
                  <Detail label={es ? "Factores protectores" : "Protective factors"} value={currentAssessmentVersion?.protective_factors} />
                  <Detail label={es ? "Acciones inmediatas" : "Immediate actions"} value={currentAssessmentVersion?.immediate_actions} />
                  <Detail label={es ? "Seguimiento requerido" : "Required follow-up"} value={currentAssessmentVersion?.required_follow_up} />
                  <Detail label={es ? "Próxima revisión" : "Next review"} value={currentAssessment.next_review_date} />
                </div>
              </Panel>
            )}
            <Two>
            <Panel>
              <h3 className="font-semibold">
                {es ? "Crear nueva versión de evaluación" : "Create new assessment version"}
              </h3>
              <Select
                label={es ? "Plantilla" : "Template"}
                value={assessment.templateId}
                onChange={(v) => setAssessment({ ...assessment, templateId: v })}
                options={templates.map((t: any) => ({
                  value: t.id,
                  label: es ? t.name_es : t.name_en,
                }))}
              />
              <Select
                label={es ? "Nivel de riesgo" : "Risk level"}
                value={assessment.riskLevel}
                onChange={(v) => setAssessment({ ...assessment, riskLevel: v as any })}
                options={["unknown", "low", "moderate", "high", "critical"].map((v) => ({
                  value: v,
                  label: v,
                }))}
              />
              <Text
                label={es ? "Razón" : "Reason"}
                value={assessment.reason}
                onChange={(v) => setAssessment({ ...assessment, reason: v })}
              />
              <Text
                label={es ? "Evidencia u observaciones" : "Evidence or observations"}
                value={assessment.evidence}
                onChange={(v) => setAssessment({ ...assessment, evidence: v })}
              />
              <Text
                label={es ? "Factores protectores" : "Protective factors"}
                value={assessment.protective}
                onChange={(v) => setAssessment({ ...assessment, protective: v })}
              />
              <Text
                label={es ? "Acciones inmediatas" : "Immediate actions"}
                value={assessment.actions}
                onChange={(v) => setAssessment({ ...assessment, actions: v })}
              />
              <Text
                label={es ? "Seguimiento requerido" : "Required follow-up"}
                value={assessment.followUp}
                onChange={(v) => setAssessment({ ...assessment, followUp: v })}
              />
              <Input
                label={es ? "Fecha de revisión" : "Review date"}
                type="date"
                value={assessment.review}
                onChange={(v) => setAssessment({ ...assessment, review: v })}
              />
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={assessment.override}
                  onChange={(e) => setAssessment({ ...assessment, override: e.target.checked })}
                />
                {es ? "Anulación profesional explicada" : "Explained professional override"}
              </label>
              {assessment.override && (
                <Text
                  label={es ? "Explicación" : "Explanation"}
                  value={assessment.overrideExplanation}
                  onChange={(v) => setAssessment({ ...assessment, overrideExplanation: v })}
                />
              )}
              <Action
                busy={assessmentM.isPending}
                disabled={!assessment.reason}
                onClick={() => assessmentM.mutate()}
              >
                {es ? "Guardar versión" : "Save version"}
              </Action>
            </Panel>
            <History
              title={es ? "Historial inmutable" : "Immutable history"}
              rows={caseData.assessments}
              render={(x) => (
                <p>
                  {x.assessment_date?.slice(0, 10)} · {x.risk_level} · v{x.current_version}
                </p>
              )}
            />
            </Two>
          </div>
        )}
        {tab === "plan" && (
          <div className="space-y-4">
            {currentPlan && (
              <Panel>
                <h3 className="font-semibold">{es ? "Plan de atención actual" : "Current care plan"}</h3>
                <p className="text-sm font-semibold">{localizedEnum(currentPlan.status, es)} · v{currentPlan.current_version}</p>
                <Detail label={es ? "Resumen" : "Summary"} value={currentPlanVersion?.summary} />
                <div className="space-y-2">
                  {(currentPlanVersion?.social_care_plan_goals ?? []).map((goal:any) => (
                    <div key={goal.id} className="rounded-lg border border-border p-3 text-sm">
                      <p className="font-semibold">{goal.goal}</p>
                      <p>{es ? "Necesidad" : "Need"}: {goal.identified_need}</p>
                      <p>{es ? "Acción" : "Action"}: {goal.planned_action}</p>
                      <p>{es ? "Estado" : "Status"}: {localizedEnum(goal.status, es)}{goal.target_date ? ` · ${goal.target_date}` : ""}</p>
                      {goal.expected_outcome && <p>{es ? "Resultado esperado" : "Expected outcome"}: {goal.expected_outcome}</p>}
                    </div>
                  ))}
                </div>
              </Panel>
            )}
            <Two>
            <Panel>
              <h3 className="font-semibold">{es ? "Crear nueva versión del plan" : "Create new plan version"}</h3>
              <Text
                label={es ? "Resumen" : "Summary"}
                value={plan.summary}
                onChange={(v) => setPlan({ ...plan, summary: v })}
              />
              <Text
                label={es ? "Necesidad" : "Identified need"}
                value={plan.need}
                onChange={(v) => setPlan({ ...plan, need: v })}
              />
              <Text
                label={es ? "Meta" : "Goal"}
                value={plan.goal}
                onChange={(v) => setPlan({ ...plan, goal: v })}
              />
              <Text
                label={es ? "Acción prevista" : "Planned action"}
                value={plan.action}
                onChange={(v) => setPlan({ ...plan, action: v })}
              />
              <Input
                label={es ? "Fecha objetivo" : "Target date"}
                type="date"
                value={plan.target}
                onChange={(v) => setPlan({ ...plan, target: v })}
              />
              <Text
                label={es ? "Resultado esperado" : "Expected outcome"}
                value={plan.outcome}
                onChange={(v) => setPlan({ ...plan, outcome: v })}
              />
              <Action
                busy={planM.isPending}
                disabled={!plan.summary || !plan.need || !plan.goal || !plan.action}
                onClick={() => planM.mutate()}
              >
                {es ? "Enviar a revisión" : "Submit for review"}
              </Action>
            </Panel>
            <History
              title={es ? "Planes versionados" : "Versioned plans"}
              rows={caseData.plans}
              render={(x) => (
                <div>
                  <p>
                    {x.status} · v{x.current_version}
                  </p>
                  {x.status === "under_review" && (
                    <button
                      onClick={() => approveM.mutate({ id: x.id, version: x.current_version })}
                      className="text-xs text-primary underline"
                    >
                      {es ? "Aprobar" : "Approve"}
                    </button>
                  )}
                </div>
              )}
            />
            </Two>
          </div>
        )}
        {isServiceTab && (
          <Two>
            <Panel>
              <h3 className="font-semibold">
                {tab === "legal"
                  ? es
                    ? "Registrar servicio jurídico"
                    : "Record legal service"
                  : tab === "psychosocial"
                    ? es
                      ? "Registrar servicio psicosocial"
                      : "Record psychosocial service"
                    : es
                      ? "Registrar intervención"
                      : "Record intervention"}
              </h3>
              <p className="text-xs text-muted-foreground">
                {tab === "legal"
                  ? es
                    ? "Los registros jurídicos permanecen privilegiados y requieren acceso autorizado."
                    : "Legal records remain privileged and require authorized access."
                  : tab === "psychosocial"
                    ? es
                      ? "Los registros psicosociales permanecen restringidos al equipo autorizado."
                      : "Psychosocial records remain restricted to the authorized team."
                    : es
                      ? "Registre servicios y seguimiento del caso."
                      : "Record case services and follow-up."}
              </p>
              <Select
                label={es ? "Servicio" : "Service"}
                value={intervention.serviceType}
                onChange={(v) => setIntervention({ ...intervention, serviceType: v })}
                options={(tab === "legal"
                  ? ["legal_assistance", "immigration_assistance", "institutional_advocacy"]
                  : tab === "psychosocial"
                    ? ["psychological_support", "medical_referral", "child_protection"]
                    : [
                        "social_work",
                        "shelter_housing",
                        "food_assistance",
                        "employment",
                        "education",
                        "transportation",
                        "emergency",
                        "documentation",
                        "family_reunification",
                      ]
                ).map((v) => ({ value: v, label: v }))}
              />
              <Select
                label={es ? "Tipo de registro" : "Record type"}
                value={intervention.recordType}
                onChange={(v) => setIntervention({ ...intervention, recordType: v })}
                options={recordOptions}
              />
              <Select
                label={es ? "Meta relacionada del plan de atención" : "Related care-plan goal"}
                value={intervention.carePlanGoalId}
                onChange={(v) => setIntervention({ ...intervention, carePlanGoalId: v })}
                options={latestGoals.map((goal: any) => ({ value: goal.id, label: goal.goal }))}
              />
              <Text
                label={es ? "Razón" : "Reason"}
                value={intervention.reason}
                onChange={(v) => setIntervention({ ...intervention, reason: v })}
              />
              <Text
                label={es ? "Acciones realizadas" : "Actions taken"}
                value={intervention.actions}
                onChange={(v) => setIntervention({ ...intervention, actions: v })}
              />
              <Text
                label={es ? "Resultado" : "Outcome"}
                value={intervention.outcome}
                onChange={(v) => setIntervention({ ...intervention, outcome: v })}
              />
              <Action
                busy={interventionM.isPending}
                disabled={!intervention.reason || !intervention.actions}
                onClick={() => interventionM.mutate()}
              >
                {es ? "Registrar" : "Record"}
              </Action>
            </Panel>
            <History
              title={
                tab === "legal"
                  ? es
                    ? "Servicios jurídicos autorizados"
                    : "Authorized legal services"
                  : tab === "psychosocial"
                    ? es
                      ? "Servicios psicosociales autorizados"
                      : "Authorized psychosocial services"
                    : es
                      ? "Intervenciones autorizadas"
                      : "Authorized interventions"
              }
              rows={caseData.interventions.filter((x: any) =>
                tab === "legal"
                  ? [
                      "legal_assistance",
                      "immigration_assistance",
                      "institutional_advocacy",
                    ].includes(x.service_type)
                  : tab === "psychosocial"
                    ? ["psychological_support", "medical_referral", "child_protection"].includes(
                        x.service_type,
                      )
                    : ![
                        "legal_assistance",
                        "immigration_assistance",
                        "institutional_advocacy",
                        "psychological_support",
                        "medical_referral",
                        "child_protection",
                      ].includes(x.service_type),
              )}
              render={(x) => (
                <div className="space-y-1 text-sm">
                  <p className="font-semibold">
                    {localizedEnum(x.service_type, es)} · {new Date(x.occurred_at).toLocaleString()}
                  </p>
                  <p>{es ? "Tipo de registro" : "Record type"}: {localizedEnum(x.record_type, es)}</p>
                  <p>{es ? "Razón" : "Reason"}: {x.reason}</p>
                  <p>{es ? "Acciones" : "Actions"}: {x.actions_taken}</p>
                  <p>{es ? "Resultado" : "Outcome"}: {x.outcome || "—"}</p>
                  <p>{es ? "Profesional" : "Worker"}: {x.professional_id}</p>
                  <p>{es ? "Meta relacionada" : "Related goal"}: {latestGoals.find((goal:any) => goal.id === x.care_plan_goal_id)?.goal || (es ? "No vinculada" : "Not linked")}</p>
                  <p>{es ? "Seguimiento" : "Follow-up"}: {x.follow_up_required ? (es ? "Requerido" : "Required") : (es ? "No requerido" : "Not required")}</p>
                </div>
              )}
            />
          </Two>
        )}
        {tab === "consent" && (
          <Two>
            <Panel>
              <h3 className="font-semibold">
                {es ? "Consentimiento informado" : "Informed consent"}
              </h3>
              <Input
                label={es ? "Tipo" : "Type"}
                value={consent.type}
                onChange={(v) => setConsent({ ...consent, type: v })}
              />
              <Input
                label={es ? "Persona que consiente" : "Person consenting"}
                value={consent.consentedBy}
                onChange={(v) => setConsent({ ...consent, consentedBy: v })}
              />
              <Input
                label={es ? "Propósitos (comas)" : "Purposes (commas)"}
                value={consent.purposes}
                onChange={(v) => setConsent({ ...consent, purposes: v })}
              />
              <Input
                label={es ? "Destinatarios (IDs o nombres)" : "Recipients (IDs or names)"}
                value={consent.recipients}
                onChange={(v) => setConsent({ ...consent, recipients: v })}
              />
              <Input
                label={es ? "Información permitida" : "Permitted information"}
                value={consent.information}
                onChange={(v) => setConsent({ ...consent, information: v })}
              />
              <Text
                label={es ? "Restricciones" : "Restrictions"}
                value={consent.restrictions}
                onChange={(v) => setConsent({ ...consent, restrictions: v })}
              />
              <Input
                label={es ? "Expira" : "Expires"}
                type="datetime-local"
                value={consent.expires}
                onChange={(v) => setConsent({ ...consent, expires: v })}
              />
              <Action
                busy={consentM.isPending}
                disabled={!consent.consentedBy || !consent.recipients}
                onClick={() => consentM.mutate()}
              >
                {es ? "Guardar consentimiento" : "Record consent"}
              </Action>
            </Panel>
            <History
              title={es ? "Versiones y estado" : "Versions and status"}
              rows={caseData.consents}
              render={(x) => (
                <div>
                  <p>
                    {x.consent_type} · {x.status} · v{x.current_version}
                  </p>
                  {x.status === "active" && (
                    <button
                      onClick={() => revokeM.mutate(x.id)}
                      className="text-xs text-destructive underline"
                    >
                      {es ? "Revocar" : "Revoke"}
                    </button>
                  )}
                </div>
              )}
            />
          </Two>
        )}
        {tab === "resources" && <CaseResourceRecommendations caseId={caseId} />}{" "}
        {tab === "referral" && (
          <Two>
            <Panel>
              <h3 className="font-semibold">{es ? "Nueva canalización" : "New referral"}</h3>
              <Select
                label={es ? "Institución" : "Institution"}
                value={referral.institutionId}
                onChange={(v) => setReferral({ ...referral, institutionId: v })}
                options={institutions.map((i: any) => ({ value: i.id, label: i.name }))}
              />
              <Input
                label={es ? "Servicio solicitado" : "Service requested"}
                value={referral.service}
                onChange={(v) => setReferral({ ...referral, service: v })}
              />
              <Text
                label={es ? "Razón" : "Reason"}
                value={referral.reason}
                onChange={(v) => setReferral({ ...referral, reason: v })}
              />
              <Select
                label={es ? "Consentimiento" : "Consent"}
                value={referral.consentId}
                onChange={(v) => setReferral({ ...referral, consentId: v })}
                options={caseData.consents
                  .filter((x: any) => x.status === "active")
                  .map((x: any) => ({
                    value: x.id,
                    label: `${x.consent_type} · v${x.current_version}`,
                  }))}
              />
              <Input
                label={es ? "Información autorizada" : "Authorized information"}
                value={referral.information}
                onChange={(v) => setReferral({ ...referral, information: v })}
              />
              <Action
                busy={referralM.isPending}
                disabled={!referral.institutionId || !referral.service || !referral.reason}
                onClick={() => referralM.mutate()}
              >
                {es ? "Crear canalización" : "Create referral"}
              </Action>
            </Panel>
            <History
              title={es ? "Seguimiento" : "Tracking"}
              rows={caseData.referrals}
              render={(x) => (
                <div>
                  <p>
                    {x.referral_number} · {x.status}
                  </p>
                  {["draft", "awaiting_consent"].includes(x.status) && x.consent_id && (
                    <button
                      onClick={() => sendReferralM.mutate(x.id)}
                      className="mr-3 text-xs text-primary underline"
                    >
                      {es ? "Enviar" : "Send"}
                    </button>
                  )}
                  {["sent", "received", "appointment_scheduled", "in_progress"].includes(
                    x.status,
                  ) && (
                    <>
                      <input
                        value={referral.result}
                        onChange={(e) => setReferral({ ...referral, result: e.target.value })}
                        placeholder={es ? "Resultado verificado" : "Verified result"}
                        className="mt-2 rounded border border-border px-2 py-1 text-xs"
                      />
                      <button
                        onClick={() => verifyReferralM.mutate(x.id)}
                        className="ml-2 text-xs text-primary underline"
                      >
                        {es ? "Verificar conclusión" : "Verify completion"}
                      </button>
                    </>
                  )}
                </div>
              )}
            />
          </Two>
        )}
        {tab === "tasks" && (
          <div className="grid gap-4 xl:grid-cols-3">
            <Panel>
              <h3 className="font-semibold">{es ? "Nueva tarea" : "New task"}</h3>
              <Input
                label={es ? "Título" : "Title"}
                value={task.title}
                onChange={(v) => setTask({ ...task, title: v })}
              />
              <Input
                label={es ? "Vence" : "Due"}
                type="datetime-local"
                value={task.due}
                onChange={(v) => setTask({ ...task, due: v })}
              />
              <Action busy={taskM.isPending} disabled={!task.title} onClick={() => taskM.mutate()}>
                {es ? "Crear tarea" : "Create task"}
              </Action>
              <button
                onClick={() => alertsM.mutate()}
                className="mt-3 text-xs text-primary underline"
              >
                <RefreshCw className="mr-1 inline h-3 w-3" />
                {es ? "Actualizar alertas" : "Refresh alerts"}
              </button>
            </Panel>
            <Panel>
              <h3 className="font-semibold">{es ? "Nueva cita" : "New appointment"}</h3>
              <Input
                label={es ? "Título" : "Title"}
                value={appointment.title}
                onChange={(v) => setAppointment({ ...appointment, title: v })}
              />
              <Input
                label={es ? "Fecha y hora" : "Date and time"}
                type="datetime-local"
                value={appointment.when}
                onChange={(v) => setAppointment({ ...appointment, when: v })}
              />
              <Input
                label={es ? "Lugar o método" : "Location or method"}
                value={appointment.method}
                onChange={(v) => setAppointment({ ...appointment, method: v })}
              />
              <Action
                busy={appointmentM.isPending}
                disabled={!appointment.title || !appointment.when}
                onClick={() => appointmentM.mutate()}
              >
                {es ? "Programar" : "Schedule"}
              </Action>
            </Panel>
            <History
              title={es ? "Pendientes" : "Pending"}
              rows={[...caseData.tasks, ...caseData.appointments]}
              render={(x) => (
                <p>
                  {x.title} · {(x.due_at ?? x.scheduled_at)?.slice(0, 16)}
                </p>
              )}
            />
          </div>
        )}
        {tab === "documents" && (
          <Two>
            <Panel>
              <h3 className="font-semibold">
                {es ? "Cargar archivos del caso" : "Upload case files"}
              </h3>
              <p className="text-xs text-muted-foreground">
                {es
                  ? "PDF, Office, imágenes, archivos ZIP/RAR/7Z, correos, audio y video. Máximo 100 MB por archivo. Permanecen únicamente en este caso de Atención Integral."
                  : "PDF, Office, images, ZIP/RAR/7Z archives, email, audio, video, and case records. Maximum 100 MB per file. Files remain only in this Comprehensive Care case."}
              </p>
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  selectCaseFiles(Array.from(e.dataTransfer.files));
                }}
                className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 px-4 py-8 text-center hover:bg-primary/10"
              >
                <FileUp className="mb-2 h-7 w-7 text-primary" />
                <span className="text-sm font-semibold">
                  {es ? "Arrastre archivos aquí o selecciónelos" : "Drag files here or select them"}
                </span>
                <span className="mt-1 text-xs text-muted-foreground">
                  {es
                    ? "Puede cargar varios archivos a la vez"
                    : "You can upload multiple files at once"}
                </span>
                <input
                  key={document.files.length ? "selected" : "empty"}
                  type="file"
                  multiple
                  accept={CASE_FILE_ACCEPT}
                  onChange={(e) => selectCaseFiles(Array.from(e.target.files ?? []))}
                  className="sr-only"
                />
              </label>
              {document.files.length > 0 && (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                  {document.files.map((file, index) => (
                    <div
                      key={`${file.name}-${file.size}-${file.lastModified}`}
                      className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs"
                    >
                      <span className="min-w-0 truncate">
                        {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
                      </span>
                      <button
                        type="button"
                        disabled={documentM.isPending}
                        onClick={() =>
                          setDocument((current) => ({
                            ...current,
                            files: current.files.filter((_, fileIndex) => fileIndex !== index),
                          }))
                        }
                        className="shrink-0 text-destructive hover:underline"
                      >
                        {es ? "Quitar" : "Remove"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {document.files.length === 1 && (
                <Input
                  label={es ? "Título visible" : "Display title"}
                  value={document.title}
                  onChange={(v) => setDocument({ ...document, title: v })}
                />
              )}
              <Select
                label={es ? "Tipo de registro" : "Record type"}
                value={document.recordType}
                onChange={(v) => setDocument({ ...document, recordType: v })}
                options={recordOptions}
              />
              <Select
                label={es ? "Consentimiento aplicable" : "Applicable consent"}
                value={document.consentId}
                onChange={(v) => setDocument({ ...document, consentId: v })}
                options={caseData.consents
                  .filter((x: any) => x.status === "active")
                  .map((x: any) => ({ value: x.id, label: x.consent_type }))}
              />
              {documentM.isPending && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs">
                  <p className="font-medium">
                    {es
                      ? `Cargando ${uploadProgress.current} de ${uploadProgress.total}`
                      : `Uploading ${uploadProgress.current} of ${uploadProgress.total}`}
                  </p>
                  <p className="mt-1 truncate text-muted-foreground">{uploadProgress.name}</p>
                </div>
              )}
              <Action
                busy={documentM.isPending}
                disabled={!document.files.length}
                onClick={() => documentM.mutate()}
              >
                <FileUp className="mr-2 inline h-4 w-4" />
                {es
                  ? `Proteger y registrar ${document.files.length || ""} archivo(s)`
                  : `Protect and register ${document.files.length || ""} file(s)`}
              </Action>
              <div className="border-t border-border pt-3">
                <h4 className="text-sm font-semibold">
                  {es ? "Compartir selectivamente" : "Selective sharing"}
                </h4>
                <Select
                  label={es ? "Documento" : "Document"}
                  value={share.documentId}
                  onChange={(v) => setShare({ ...share, documentId: v })}
                  options={caseData.documents.map((x: any) => ({ value: x.id, label: x.title }))}
                />
                <Input
                  label={es ? "Organización receptora (UUID)" : "Receiving organization (UUID)"}
                  value={share.receivingOrgId}
                  onChange={(v) => setShare({ ...share, receivingOrgId: v })}
                />
                <Select
                  label={es ? "Consentimiento vigente" : "Active consent"}
                  value={share.consentId}
                  onChange={(v) => setShare({ ...share, consentId: v })}
                  options={caseData.consents
                    .filter((x: any) => x.status === "active")
                    .map((x: any) => ({ value: x.id, label: x.consent_type }))}
                />
                <Input
                  label={es ? "Propósito" : "Purpose"}
                  value={share.purpose}
                  onChange={(v) => setShare({ ...share, purpose: v })}
                />
                <Action
                  busy={shareM.isPending}
                  disabled={!share.documentId || !share.receivingOrgId || !share.consentId}
                  onClick={() => shareM.mutate()}
                >
                  {es ? "Compartir con control de consentimiento" : "Share with consent control"}
                </Action>
              </div>
            </Panel>
            <SocialCaseMediaGallery caseId={caseId} documents={caseData.documents} />
          </Two>
        )}
        {tab === "transfer" && (
          <Two>
            <Panel>
              <h3 className="font-semibold">
                {es ? "Preparar transferencia" : "Prepare transfer"}
              </h3>
              <Select
                label={es ? "Tipo" : "Type"}
                value={transfer.type}
                onChange={(v) => setTransfer({ ...transfer, type: v })}
                options={[
                  "case_manager",
                  "office",
                  "service_team",
                  "external_organization",
                  "social_to_legal",
                  "legal_to_social",
                ].map((v) => ({ value: v, label: v }))}
              />
              <Input
                label={es ? "Usuario receptor (UUID)" : "Receiving user (UUID)"}
                value={transfer.toUser}
                onChange={(v) => setTransfer({ ...transfer, toUser: v })}
              />
              <Input
                label={es ? "Organización receptora (UUID)" : "Receiving organization (UUID)"}
                value={transfer.receivingOrg}
                onChange={(v) => setTransfer({ ...transfer, receivingOrg: v })}
              />
              <Select
                label={es ? "Consentimiento" : "Consent"}
                value={transfer.consentId}
                onChange={(v) => setTransfer({ ...transfer, consentId: v })}
                options={caseData.consents
                  .filter((x: any) => x.status === "active")
                  .map((x: any) => ({ value: x.id, label: x.consent_type }))}
              />
              <Input
                label={es ? "Información seleccionada" : "Selected information"}
                value={transfer.information}
                onChange={(v) => setTransfer({ ...transfer, information: v })}
              />
              <Text
                label={es ? "Resumen de transferencia" : "Transfer summary"}
                value={transfer.summary}
                onChange={(v) => setTransfer({ ...transfer, summary: v })}
              />
              <Action
                busy={transferM.isPending}
                disabled={!transfer.summary || (!transfer.toUser && !transfer.receivingOrg)}
                onClick={() => transferM.mutate()}
              >
                {es ? "Solicitar aprobación" : "Request approval"}
              </Action>
            </Panel>
            <History
              title={es ? "Historial completo" : "Complete history"}
              rows={caseData.transfers}
              render={(x) => (
                <div>
                  <p>
                    {x.transfer_type} · {x.status}
                  </p>
                  {x.status === "pending_approval" && (
                    <button
                      onClick={() => advanceM.mutate({ id: x.id, action: "approve" })}
                      className="mr-2 text-xs text-primary underline"
                    >
                      {es ? "Aprobar" : "Approve"}
                    </button>
                  )}
                  {x.status === "approved" && (
                    <button
                      onClick={() => advanceM.mutate({ id: x.id, action: "send" })}
                      className="mr-2 text-xs text-primary underline"
                    >
                      {es ? "Enviar" : "Send"}
                    </button>
                  )}
                  {x.status === "sent" && (
                    <button
                      onClick={() => acceptM.mutate(x.id)}
                      className="text-xs text-primary underline"
                    >
                      {es ? "Confirmar recepción" : "Confirm receipt"}
                    </button>
                  )}
                </div>
              )}
            />
          </Two>
        )}
        {tab === "closure" && (
          <Two>
            <Panel>
              <h3 className="font-semibold">{es ? "Revisión de cierre" : "Closure review"}</h3>
              <div
                className={`rounded-lg border p-3 text-sm ${closureReady ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10"}`}
              >
                <p className="font-semibold">
                  {closureReady
                    ? es
                      ? "Listo para revisión de cierre"
                      : "Ready for closure review"
                    : es
                      ? "Trabajo pendiente antes de concluir servicios"
                      : "Outstanding work before services can be completed"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {es
                    ? `Metas pendientes: ${incompleteGoals.length} · Tareas abiertas: ${openTasks.length} · Canalizaciones pendientes: ${pendingReferrals.length}`
                    : `Incomplete goals: ${incompleteGoals.length} · Open tasks: ${openTasks.length} · Pending referrals: ${pendingReferrals.length}`}
                </p>
              </div>
              <Select
                label={es ? "Motivo" : "Reason"}
                value={closure.reason}
                onChange={(v) => setClosure({ ...closure, reason: v })}
                options={[
                  "services_completed",
                  "client_withdrew",
                  "unable_to_contact",
                  "transferred",
                  "ineligible",
                  "relocated",
                  "duplicate_case",
                  "other",
                ].map((v) => ({ value: v, label: v }))}
              />
              <Select
                label={es ? "Riesgo final" : "Final risk"}
                value={closure.finalRisk}
                onChange={(v) => setClosure({ ...closure, finalRisk: v })}
                options={["unknown", "low", "moderate", "high", "critical"].map((v) => ({
                  value: v,
                  label: v,
                }))}
              />
              <Text
                label={es ? "Resultados y resumen final" : "Outcomes and final summary"}
                value={closure.summary}
                onChange={(v) => setClosure({ ...closure, summary: v })}
              />
              <Text
                label={es ? "Notificación a la persona" : "Client notification"}
                value={closure.clientNotification}
                onChange={(v) => setClosure({ ...closure, clientNotification: v })}
              />
              <Text
                label={es ? "Disposición de documentos" : "Document disposition"}
                value={closure.documentDisposition}
                onChange={(v) => setClosure({ ...closure, documentDisposition: v })}
              />
              <Input
                label={es ? "Estado de conservación" : "Retention status"}
                value={closure.retentionStatus}
                onChange={(v) => setClosure({ ...closure, retentionStatus: v })}
              />
              {["high", "critical"].includes(closure.finalRisk) && (
                <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs">
                  {es
                    ? "El riesgo final alto o crítico quedará registrado en el cierre y requiere juicio profesional documentado."
                    : "High or critical final risk is recorded in the closure and requires documented professional judgment."}
                </p>
              )}
              <Action
                busy={closeM.isPending}
                disabled={
                  c?.status === "closed" ||
                  !closureReady ||
                  !closure.summary ||
                  !closure.clientNotification ||
                  !closure.documentDisposition ||
                  !closure.retentionStatus
                }
                onClick={() => closeM.mutate()}
              >
                {es ? "Aprobar cierre" : "Approve closure"}
              </Action>
              {c?.status === "closed" && (
                <>
                  <Text
                    label={es ? "Razón para reabrir" : "Reason to reopen"}
                    value={closure.reopenReason}
                    onChange={(v) => setClosure({ ...closure, reopenReason: v })}
                  />
                  <Action
                    busy={reopenM.isPending}
                    disabled={!closure.reopenReason}
                    onClick={() => reopenM.mutate()}
                  >
                    {es ? "Reabrir preservando cierre" : "Reopen preserving closure"}
                  </Action>
                </>
              )}
            </Panel>
            <History
              title={es ? "Historial de cierre" : "Closure history"}
              rows={caseData.closures}
              render={(x) => (
                <p>
                  v{x.closure_version} · {localizedEnum(x.closure_reason, es)} ·{" "}
                  {localizedEnum(x.final_risk_level, es)}
                </p>
              )}
            />
          </Two>
        )}
        {tab === "immigration" && (
          <Panel>
            <div className="mb-3 flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
              <ShieldAlert className="h-4 w-4" />
              {es
                ? "Solo asuntos mexicanos de Derecho Migratorio, Refugio y Nacionalidad. Se comparte exactamente lo seleccionado."
                : "Mexican Immigration, Refugee and Nationality matters only. Exactly the selected information is shared."}
            </div>
            <Input
              label={es ? "ID del asunto migratorio" : "Immigration matter ID"}
              value={immigration.matterId}
              onChange={(v) => setImmigration({ ...immigration, matterId: v })}
            />
            <Select
              label={es ? "Consentimiento específico" : "Specific consent"}
              value={immigration.consentId}
              onChange={(v) => setImmigration({ ...immigration, consentId: v })}
              options={caseData.consents
                .filter((x: any) => x.status === "active")
                .map((x: any) => ({ value: x.id, label: x.consent_type }))}
            />
            <Input
              label={es ? "Campos de estado recibidos" : "Status fields received"}
              value={immigration.statusFields}
              onChange={(v) => setImmigration({ ...immigration, statusFields: v })}
            />
            <Input
              label={es ? "Campos sociales compartidos" : "Social fields shared"}
              value={immigration.socialFields}
              onChange={(v) => setImmigration({ ...immigration, socialFields: v })}
            />
            <Action
              busy={immigrationM.isPending}
              disabled={!immigration.matterId || !immigration.consentId}
              onClick={() => immigrationM.mutate()}
            >
              {es ? "Crear vínculo autorizado" : "Create authorized link"}
            </Action>
          </Panel>
        )}
        {tab === "assistant" && <TalkToCareCase caseId={caseId} />}{" "}
        {tab === "activity" && (
          <History
            title={es ? "Libro de auditoría inmutable" : "Immutable audit ledger"}
            rows={caseData.activity}
            render={(x) => (
              <p>
                {new Date(x.occurred_at).toLocaleString()} · {x.event_type} · {x.entity_type}
              </p>
            )}
          />
        )}
      </div>
    </div>
  );
}

function showError(e: unknown) {
  if (e instanceof Error && e.message) {
    toast.error(e.message);
    return;
  }
  if (e && typeof e === "object") {
    const x = e as { message?: unknown; data?: { message?: unknown } };
    const message =
      typeof x.message === "string"
        ? x.message
        : typeof x.data?.message === "string"
          ? x.data.message
          : null;
    if (message) {
      toast.error(message);
      return;
    }
  }
  toast.error(typeof e === "string" ? e : "The Social operation could not be completed");
}
function split(v: string) {
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}
const recordOptions = [
  "general_case_record",
  "social_work_record",
  "legal_privileged_record",
  "psychosocial_restricted_record",
  "medical_restricted_record",
  "child_protection_restricted_record",
].map((v) => ({ value: v, label: v }));
function Panel({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">{children}</section>
  );
}
function Two({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 xl:grid-cols-2">{children}</div>;
}
function Input({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
      />
    </label>
  );
}
function Text({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
      />
    </label>
  );
}
function localizedEnum(value: string, es: boolean) {
  const labels: Record<string, [string, string]> = {
    unknown: ["Desconocido", "Unknown"],
    low: ["Bajo", "Low"],
    moderate: ["Moderado", "Moderate"],
    high: ["Alto", "High"],
    critical: ["Crítico", "Critical"],
    case_manager: ["Gestor del caso", "Case manager"],
    supervisor: ["Supervisor", "Supervisor"],
    attorney: ["Abogado", "Attorney"],
    psychologist: ["Psicólogo", "Psychologist"],
    social_worker: ["Trabajador social", "Social worker"],
    general_case_record: ["Expediente general", "General case record"],
    social_work_record: ["Expediente de trabajo social", "Social work record"],
    legal_privileged_record: ["Expediente jurídico privilegiado", "Privileged legal record"],
    psychosocial_restricted_record: [
      "Expediente psicosocial restringido",
      "Restricted psychosocial record",
    ],
    medical_restricted_record: ["Expediente médico restringido", "Restricted medical record"],
    child_protection_restricted_record: [
      "Expediente de protección infantil",
      "Restricted child-protection record",
    ],
    social_work: ["Trabajo social", "Social work"],
    legal_assistance: ["Asistencia jurídica", "Legal assistance"],
    immigration_assistance: ["Asistencia migratoria", "Immigration assistance"],
    psychological_support: ["Apoyo psicológico", "Psychological support"],
    medical_referral: ["Canalización médica", "Medical referral"],
    child_protection: ["Protección infantil", "Child protection"],
    shelter_housing: ["Albergue y vivienda", "Shelter and housing"],
    food_assistance: ["Asistencia alimentaria", "Food assistance"],
    employment: ["Empleo", "Employment"],
    education: ["Educación", "Education"],
    case_manager_transfer: ["Gestor del caso", "Case manager"],
    office: ["Oficina", "Office"],
    service_team: ["Equipo de servicio", "Service team"],
    external_organization: ["Organización externa", "External organization"],
    social_to_legal: ["Social a jurídico", "Social to legal"],
    legal_to_social: ["Jurídico a social", "Legal to social"],
    services_completed: ["Servicios concluidos", "Services completed"],
    client_withdrew: ["La persona desistió", "Client withdrew"],
    unable_to_contact: ["No fue posible contactar", "Unable to contact"],
    transferred: ["Transferido", "Transferred"],
    ineligible: ["No elegible", "Ineligible"],
    relocated: ["Cambio de residencia", "Relocated"],
    duplicate_case: ["Caso duplicado", "Duplicate case"],
    other: ["Otro", "Other"],
    draft: ["Borrador", "Draft"],
    awaiting_consent: ["Esperando consentimiento", "Awaiting consent"],
    sent: ["Enviada", "Sent"],
    received: ["Recibida", "Received"],
    appointment_scheduled: ["Cita programada", "Appointment scheduled"],
    in_progress: ["Servicio en curso", "Service in progress"],
    service_in_progress: ["Servicio en curso", "Service in progress"],
    completed: ["Completada", "Completed"],
    rejected: ["Rechazada", "Rejected"],
    cancelled: ["Cancelada", "Cancelled"],
    active: ["Activo", "Active"],
    revoked: ["Revocado", "Revoked"],
    pending: ["Pendiente", "Pending"],
    approved: ["Aprobado", "Approved"],
  };
  const x = labels[value];
  return x ? (es ? x[0] : x[1]) : value.replaceAll("_", " ");
}
function SummaryStat({ label, value, urgent = false }: { label: string; value: string; urgent?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${urgent ? "border-destructive/40 bg-destructive/10" : "border-border bg-card"}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 font-semibold ${urgent ? "text-destructive" : "text-foreground"}`}>{value}</p>
    </div>
  );
}
function Detail({ label, value }: { label: string; value: unknown }) {
  return <p><strong>{label}:</strong> {String(value ?? "—") || "—"}</p>;
}
function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const { locale } = useI18n();
  const es = locale === "es";
  return (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label === o.value ? localizedEnum(o.value, es) : o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
function Action({
  children,
  onClick,
  busy,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  busy: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
    >
      {busy && <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}
function History({
  title,
  rows,
  render,
}: {
  title: string;
  rows: any[];
  render: (x: any) => ReactNode;
}) {
  return (
    <Panel>
      <h3 className="font-semibold">{title}</h3>
      {rows.length ? (
        rows.map((x, i) => (
          <div key={x.id ?? i} className="rounded-lg border border-border p-3 text-sm">
            {render(x)}
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">—</p>
      )}
    </Panel>
  );
}
