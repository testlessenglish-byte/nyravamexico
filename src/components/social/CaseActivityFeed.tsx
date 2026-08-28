import { useMemo, useState, useEffect } from "react";
import {
  Activity, AlertCircle, ArrowRightLeft, Bell, Briefcase,
  Calendar, CheckCircle2, CheckSquare, ChevronRight, ClipboardList,
  Eye, FileText, Filter, Heart, History, Lock, Search,
  Send, ShieldAlert, ShieldCheck, UserCheck, Users,
} from "lucide-react";
import { CaseActivityDrawerModal } from "./CaseActivityDrawerModal";
import { localizedEnum } from "@/lib/social/social-i18n";

interface Props {
  caseId: string;
  activities: any[];
  interventions?: any[];
  plans?: any[];
  assessments?: any[];
  documents?: any[];
  alerts?: any[];
  tasks?: any[];
  referrals?: any[];
  consents?: any[];
  caseRecord?: any;
  es: boolean;
  onNavigateTab: (tab: string) => void;
  initialActivityId?: string;
}

type EntityCategoryFilter =
  | "all"
  | "social_interventions"
  | "social_care_plans"
  | "social_assessments"
  | "social_documents"
  | "social_alerts"
  | "social_document_access_events"
  | "social_cases"
  | "social_referrals";

export function CaseActivityFeed({
  caseId,
  activities,
  interventions = [],
  plans = [],
  assessments = [],
  documents = [],
  alerts = [],
  tasks = [],
  referrals = [],
  consents = [],
  caseRecord,
  es,
  onNavigateTab,
  initialActivityId,
}: Props) {
  const [categoryFilter, setCategoryFilter] = useState<EntityCategoryFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(initialActivityId || null);

  // Sync URL search params if present
  useEffect(() => {
    if (initialActivityId) {
      setSelectedActivityId(initialActivityId);
    }
  }, [initialActivityId]);

  const getFriendlyActivityHeadline = (entityType: string, eventType: string) => {
    const headlines: Record<string, { insert: [string, string]; update: [string, string]; delete: [string, string] }> = {
      social_interventions: {
        insert: ["Intervención registrada", "Intervention recorded"],
        update: ["Intervención actualizada", "Intervention updated"],
        delete: ["Intervención eliminada", "Intervention deleted"],
      },
      social_care_plans: {
        insert: ["Plan de atención creado", "Care Plan created"],
        update: ["Plan de atención actualizado", "Care Plan updated"],
        delete: ["Plan de atención archivado", "Care Plan archived"],
      },
      social_assessments: {
        insert: ["Evaluación de riesgo creada", "Risk Assessment created"],
        update: ["Evaluación de riesgo actualizada", "Risk Assessment updated"],
        delete: ["Evaluación de riesgo archivada", "Risk Assessment archived"],
      },
      social_documents: {
        insert: ["Documento agregado", "Document added"],
        update: ["Documento actualizado", "Document updated"],
        delete: ["Documento eliminado", "Document deleted"],
      },
      social_alerts: {
        insert: ["Alerta creada", "Alert created"],
        update: ["Alerta actualizada", "Alert updated"],
        delete: ["Alerta resuelta", "Alert resolved"],
      },
      social_tasks: {
        insert: ["Tarea creada", "Task created"],
        update: ["Tarea actualizada", "Task updated"],
        delete: ["Tarea eliminada", "Task deleted"],
      },
      social_document_access_events: {
        insert: ["Acceso a documento registrado", "Document access recorded"],
        update: ["Acceso a documento registrado", "Document access recorded"],
        delete: ["Acceso a documento registrado", "Document access recorded"],
      },
      social_cases: {
        insert: ["Caso abierto", "Case opened"],
        update: ["Caso actualizado", "Case updated"],
        delete: ["Caso archivado", "Case archived"],
      },
      social_consents: {
        insert: ["Consentimiento registrado", "Consent recorded"],
        update: ["Consentimiento actualizado", "Consent updated"],
        delete: ["Consentimiento revocado", "Consent revoked"],
      },
      social_referrals: {
        insert: ["Canalización registrada", "Referral recorded"],
        update: ["Canalización actualizada", "Referral updated"],
        delete: ["Canalización cerrada", "Referral closed"],
      },
      social_appointments: {
        insert: ["Cita programada", "Appointment scheduled"],
        update: ["Cita actualizada", "Appointment updated"],
        delete: ["Cita cancelada", "Appointment cancelled"],
      },
      social_case_closures: {
        insert: ["Cierre de caso registrado", "Case closure recorded"],
        update: ["Cierre de caso actualizado", "Case closure updated"],
        delete: ["Cierre de caso cancelado", "Case closure cancelled"],
      },
      social_case_transfers: {
        insert: ["Transferencia iniciada", "Transfer initiated"],
        update: ["Transferencia actualizada", "Transfer updated"],
        delete: ["Transferencia rechazada", "Transfer rejected"],
      },
    };

    const entityGroup = headlines[entityType];
    if (entityGroup) {
      const op = (eventType in entityGroup ? eventType : "insert") as "insert" | "update" | "delete";
      return es ? entityGroup[op][0] : entityGroup[op][1];
    }
    return es ? `${localizedEnum(entityType, es)} (${localizedEnum(eventType, es)})` : `${localizedEnum(entityType, es)} (${localizedEnum(eventType, es)})`;
  };

  const getRecordSubtitle = (item: any) => {
    const occurred = new Date(item.occurred_at);
    const dateStr = occurred.toLocaleDateString();
    const timeStr = occurred.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const timeContext = `${dateStr} ${timeStr}`;

    switch (item.entity_type) {
      case "social_interventions": {
        const found = interventions.find((i) => i.id === item.entity_id);
        const service = localizedEnum(found?.service_type || item.metadata?.service_type || "social_work", es);
        const worker = caseRecord?.assigned_case_manager_name || caseRecord?.assigned_case_manager?.slice(0, 8) || (es ? "Profesional" : "Staff");
        return `${service} · ${timeContext} · ${worker}`;
      }
      case "social_care_plans": {
        const found = plans.find((p) => p.id === item.entity_id);
        const ver = found?.current_version || item.metadata?.version || 1;
        return `${es ? "Versión" : "Version"} ${ver} · ${timeContext}`;
      }
      case "social_assessments": {
        const found = assessments.find((a) => a.id === item.entity_id);
        const rawLevel = found?.risk_level || item.metadata?.risk_level || "unknown";
        const level = localizedEnum(rawLevel, es);
        const ver = found?.current_version || item.metadata?.version || 1;
        return `${level.toUpperCase()} · ${es ? "Versión" : "Version"} ${ver} · ${timeContext}`;
      }
      case "social_documents": {
        const found = documents.find((d) => d.id === item.entity_id);
        const title = found?.title || item.metadata?.title || (es ? "Documento del caso" : "Case document");
        return `${title} · ${timeContext}`;
      }
      case "social_alerts": {
        const found = alerts.find((a) => a.id === item.entity_id);
        const title = (es ? found?.title_es : found?.title_en) || (es ? "Alerta de atención" : "Care alert");
        return `${title} · ${timeContext}`;
      }
      case "social_tasks": {
        const found = tasks.find((t) => t.id === item.entity_id);
        const title = found?.title || (es ? "Tarea de seguimiento" : "Follow-up task");
        return `${title} · ${timeContext}`;
      }
      case "social_document_access_events": {
        const action = localizedEnum(item.metadata?.action || "preview", es);
        return `${action} · ${timeContext}`;
      }
      case "social_cases": {
        return `${caseRecord?.case_number || "Caso"} · ${timeContext}`;
      }
      case "social_referrals": {
        const found = referrals.find((r) => r.id === item.entity_id);
        const refNum = found?.referral_number || (es ? "Canalización" : "Referral");
        return `${refNum} · ${timeContext}`;
      }
      default: {
        return `${timeContext}`;
      }
    }
  };

  const getEntityIcon = (entityType: string) => {
    switch (entityType) {
      case "social_interventions":
        return <Heart className="h-4 w-4 text-rose-500" />;
      case "social_care_plans":
        return <ClipboardList className="h-4 w-4 text-blue-500" />;
      case "social_assessments":
        return <ShieldAlert className="h-4 w-4 text-amber-500" />;
      case "social_documents":
        return <FileText className="h-4 w-4 text-emerald-500" />;
      case "social_alerts":
        return <Bell className="h-4 w-4 text-red-500" />;
      case "social_tasks":
        return <CheckSquare className="h-4 w-4 text-indigo-500" />;
      case "social_document_access_events":
        return <Eye className="h-4 w-4 text-cyan-500" />;
      case "social_cases":
        return <Briefcase className="h-4 w-4 text-primary" />;
      case "social_consents":
        return <ShieldCheck className="h-4 w-4 text-teal-500" />;
      case "social_referrals":
        return <Send className="h-4 w-4 text-violet-500" />;
      case "social_appointments":
        return <Calendar className="h-4 w-4 text-orange-500" />;
      case "social_case_transfers":
        return <ArrowRightLeft className="h-4 w-4 text-yellow-500" />;
      case "social_case_closures":
        return <CheckCircle2 className="h-4 w-4 text-slate-500" />;
      default:
        return <Activity className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const categories: Array<{ id: EntityCategoryFilter; label_es: string; label_en: string }> = [
    { id: "all", label_es: "Todos", label_en: "All" },
    { id: "social_interventions", label_es: "Intervenciones", label_en: "Interventions" },
    { id: "social_care_plans", label_es: "Planes de atención", label_en: "Care Plans" },
    { id: "social_assessments", label_es: "Evaluaciones de riesgo", label_en: "Risk Assessments" },
    { id: "social_documents", label_es: "Documentos", label_en: "Documents" },
    { id: "social_alerts", label_es: "Alertas y tareas", label_en: "Alerts & Tasks" },
    { id: "social_document_access_events", label_es: "Accesos a documentos", label_en: "Access Events" },
    { id: "social_cases", label_es: "Actualizaciones de caso", label_en: "Case Updates" },
    { id: "social_referrals", label_es: "Canalizaciones", label_en: "Referrals" },
  ];

  const filteredActivities = useMemo(() => {
    return activities.filter((act) => {
      // Category filter
      if (categoryFilter !== "all") {
        if (categoryFilter === "social_alerts") {
          if (!["social_alerts", "social_tasks", "social_appointments"].includes(act.entity_type)) return false;
        } else if (act.entity_type !== categoryFilter) {
          return false;
        }
      }

      // Search filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const headline = getFriendlyActivityHeadline(act.entity_type, act.event_type).toLowerCase();
        const subtitle = getRecordSubtitle(act).toLowerCase();
        const typeMatch = act.entity_type.toLowerCase().includes(q);
        if (!headline.includes(q) && !subtitle.includes(q) && !typeMatch) return false;
      }

      return true;
    });
  }, [activities, categoryFilter, searchQuery, es]);

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5 shadow-xs">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-foreground">
            <History className="h-5 w-5 text-primary" />
            {es ? "Libro de Auditoría y Registro de Actividad" : "Immutable Audit Ledger & Activity History"}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {es
              ? "Registro cronológico inmutable de todos los eventos del caso. Haga clic en cualquier fila para abrir el registro exacto."
              : "Immutable chronological log of all case events. Click any row to view the exact related record."}
          </p>
        </div>

        <span className="rounded-xl border border-border bg-background px-3 py-1.5 font-mono text-xs font-semibold text-muted-foreground">
          {activities.length} {es ? "eventos registrados" : "recorded events"}
        </span>
      </div>

      {/* Filter Tabs & Search Bar */}
      <div className="space-y-3">
        {/* Category Filter Pills */}
        <div className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-card p-1.5 text-xs">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategoryFilter(c.id)}
              className={`rounded-lg px-3 py-1.5 font-medium transition ${
                categoryFilter === c.id
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {es ? c.label_es : c.label_en}
            </button>
          ))}
        </div>

        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={es ? "Buscar por acción, fecha, tipo o profesional..." : "Search by action, date, type, or worker..."}
            className="w-full rounded-xl border border-border bg-card py-2 pl-9 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </div>
      </div>

      {/* Activity Timeline List */}
      <div className="space-y-2">
        {filteredActivities.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/50 p-12 text-center text-muted-foreground">
            <History className="mx-auto h-10 w-10 text-muted-foreground/50" />
            <p className="mt-3 text-sm font-semibold text-foreground">
              {es ? "No se encontraron eventos de actividad" : "No activity events found"}
            </p>
            <p className="mt-1 text-xs">
              {es ? "No hay registros que coincidan con los filtros actuales." : "No records match the current filters."}
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            {filteredActivities.map((act) => {
              const headline = getFriendlyActivityHeadline(act.entity_type, act.event_type);
              const subtitle = getRecordSubtitle(act);
              const isSelected = selectedActivityId === act.id;

              return (
                <button
                  key={act.id}
                  type="button"
                  onClick={() => setSelectedActivityId(act.id)}
                  className={`flex w-full items-center justify-between gap-4 rounded-xl border p-4 text-left transition ${
                    isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary shadow-xs"
                      : "border-border bg-card hover:border-primary/50 hover:bg-muted/30"
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-background shadow-2xs">
                      {getEntityIcon(act.entity_type)}
                    </div>
                    <div className="min-w-0">
                      <p className="font-bold text-foreground text-xs sm:text-sm truncate">
                        {headline}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                        {subtitle}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="hidden sm:inline rounded bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {localizedEnum(act.event_type, es)}
                    </span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Focused Record Drawer / Modal */}
      {selectedActivityId && (
        <CaseActivityDrawerModal
          caseId={caseId}
          activityId={selectedActivityId}
          es={es}
          onClose={() => setSelectedActivityId(null)}
          onNavigateTab={onNavigateTab}
        />
      )}
    </div>
  );
}
