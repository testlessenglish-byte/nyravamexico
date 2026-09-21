import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Download, Eye, FilePlus2, FileText, Filter, FolderPlus,
  Loader2, Mail, Plus, Search, Shield, ShieldAlert, Sparkles, X,
} from "lucide-react";
import { toast } from "sonner";
import { MEXICO_TEMPLATES, type MexicoTemplateDefinition, type TemplateCategory } from "@/lib/social/templates/mexico-template-definitions";
import { createCaseDocumentDraft, getSocialDocumentAccessUrl } from "@/lib/social.functions";
import { CaseDocumentEditorModal } from "./CaseDocumentEditorModal";

interface Props {
  caseId: string;
  documents: any[];
  consents: any[];
  referrals?: any[];
  carePlans?: any[];
  es: boolean;
  onOpenConsentTab?: () => void;
  initialTemplateCode?: string;
  initialReferralId?: string;
  initialCarePlanGoalId?: string;
  initialRecipient?: any;
}

type StatusFilter = "all" | "draft" | "ready_for_review" | "finalized" | "sent" | "received" | "archived";
type PurposeFilter = "all" | "intake" | "consent_privacy" | "risk_safety" | "care_plan" | "referral" | "housing" | "psychosocial" | "legal" | "medical_health" | "child_family" | "immigration" | "follow_up" | "closure";

export function CaseDocumentCenter({
  caseId,
  documents,
  consents,
  referrals = [],
  carePlans = [],
  es,
  onOpenConsentTab,
  initialTemplateCode,
  initialReferralId,
  initialCarePlanGoalId,
  initialRecipient,
}: Props) {
  const qc = useQueryClient();
  const createDraftFn = useServerFn(createCaseDocumentDraft);
  const accessFn = useServerFn(getSocialDocumentAccessUrl);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [purposeFilter, setPurposeFilter] = useState<PurposeFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [templatePickerOpen, setTemplatePickerOpen] = useState(Boolean(initialTemplateCode));
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | "all">("all");
  const [editingDoc, setEditingDoc] = useState<any | null>(null);

  const createDraftMutation = useMutation({
    mutationFn: (templateCode: string) => createDraftFn({
      data: {
        caseId,
        templateCode,
        language: es ? "es" : "en",
        referralId: initialReferralId,
        carePlanGoalId: initialCarePlanGoalId,
        recipientInfo: initialRecipient || {},
      }
    }),
    onSuccess: (newDoc) => {
      toast.success(es ? "Borrador creado a partir de la plantilla" : "Draft created from template");
      void qc.invalidateQueries({ queryKey: ["social-document-workspace", caseId] });
      void qc.invalidateQueries({ queryKey: ["social-case", caseId] });
      setTemplatePickerOpen(false);
      setEditingDoc(newDoc);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const handleAccess = async (docId: string, action: "preview" | "download") => {
    try {
      const res = await accessFn({ data: { documentId: docId, action } });
      window.open(res.url, action === "preview" ? "_blank" : "_self", "noopener,noreferrer");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const filteredDocs = useMemo(() => {
    return documents.filter((doc) => {
      // Status filter
      if (statusFilter === "draft" && doc.lifecycle_status !== "draft") return false;
      if (statusFilter === "ready_for_review" && doc.lifecycle_status !== "ready_for_review") return false;
      if (statusFilter === "finalized" && doc.lifecycle_status !== "finalized") return false;
      if (statusFilter === "sent" && doc.lifecycle_status !== "sent") return false;
      if (statusFilter === "received" && doc.lifecycle_status !== "received") return false;
      if (statusFilter === "archived" && !["superseded", "archived"].includes(doc.lifecycle_status || doc.document_status)) return false;

      // Purpose filter
      if (purposeFilter !== "all" && doc.purpose !== purposeFilter && doc.document_type !== purposeFilter) return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const titleMatch = doc.title?.toLowerCase().includes(q);
        const codeMatch = doc.template_code?.toLowerCase().includes(q);
        if (!titleMatch && !codeMatch) return false;
      }

      return true;
    });
  }, [documents, statusFilter, purposeFilter, searchQuery]);

  const categories: Array<{ id: TemplateCategory | "all"; label_es: string; label_en: string }> = [
    { id: "all", label_es: "Todas las categorías", label_en: "All Categories" },
    { id: "intake", label_es: "Ingreso", label_en: "Intake" },
    { id: "consent", label_es: "Consentimiento", label_en: "Consent" },
    { id: "risk_safety", label_es: "Riesgo y Seguridad", label_en: "Risk & Safety" },
    { id: "housing", label_es: "Vivienda", label_en: "Housing" },
    { id: "psychosocial", label_es: "Psicología y Psicosocial", label_en: "Psychosocial" },
    { id: "legal", label_es: "Asistencia Jurídica", label_en: "Legal Assistance" },
    { id: "family_children", label_es: "Familia y DIF / NNA", label_en: "Family & DIF" },
    { id: "health", label_es: "Salud y Médica", label_en: "Health & Medical" },
    { id: "immigration_refugee", label_es: "COMAR / Migración", label_en: "Immigration & COMAR" },
    { id: "general_assistance", label_es: "Asistencia General", label_en: "General Assistance" },
  ];

  const filteredTemplates = useMemo(() => {
    if (activeCategory === "all") return MEXICO_TEMPLATES;
    return MEXICO_TEMPLATES.filter((t) => t.category === activeCategory);
  }, [activeCategory]);

  return (
    <div className="space-y-6">
      {/* Top Header & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-foreground">
            <FileText className="h-5 w-5 text-primary" />
            {es ? "Expediente de Documentos y Formatos del Caso" : "Case Documents & Form Library"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {es
              ? "Biblioteca de formatos aprobados de México. Precarga automática desde el expediente, revisión profesional, y almacenamiento inmutable."
              : "Approved Mexican case-management forms. Auto-filled from case records, reviewed by case worker, and stored immutably."}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setTemplatePickerOpen(true)}
          className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground shadow-md transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {es ? "Crear Documento desde Plantilla" : "Create Document from Template"}
        </button>
      </div>

      {/* Filters & Status Tabs */}
      <div className="space-y-3">
        {/* Status Pills */}
        <div className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-card p-1.5 text-xs">
          {[
            { id: "all", label_es: "Todos", label_en: "All" },
            { id: "draft", label_es: "Borradores", label_en: "Drafts" },
            { id: "ready_for_review", label_es: "En revisión", label_en: "Ready for Review" },
            { id: "finalized", label_es: "Finalizados", label_en: "Finalized" },
            { id: "sent", label_es: "Enviados", label_en: "Sent" },
            { id: "received", label_es: "Recibidos", label_en: "Received" },
            { id: "archived", label_es: "Archivados / Historial", label_en: "Archived" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusFilter(tab.id as StatusFilter)}
              className={`rounded-lg px-3 py-1.5 font-medium transition ${statusFilter === tab.id ? "bg-primary text-primary-foreground shadow-xs" : "text-muted-foreground hover:bg-muted"}`}
            >
              {es ? tab.label_es : tab.label_en}
            </button>
          ))}
        </div>

        {/* Purpose Filter & Search Bar */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={es ? "Buscar por título, código o folio..." : "Search by title, code, or number..."}
              className="w-full rounded-xl border border-border bg-card py-2 pl-9 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
          </div>

          <div className="relative">
            <Filter className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <select
              value={purposeFilter}
              onChange={(e) => setPurposeFilter(e.target.value as PurposeFilter)}
              className="w-full rounded-xl border border-border bg-card py-2 pl-9 pr-3 text-xs text-foreground focus:border-primary focus:outline-none"
            >
              <option value="all">— {es ? "Todos los propósitos" : "All Purposes"} —</option>
              <option value="intake">{es ? "Ingreso" : "Intake"}</option>
              <option value="consent_privacy">{es ? "Consentimiento y Privacidad" : "Consent & Privacy"}</option>
              <option value="risk_safety">{es ? "Riesgo y Seguridad" : "Risk & Safety"}</option>
              <option value="care_plan">{es ? "Plan de Atención" : "Care Plan"}</option>
              <option value="referral">{es ? "Canalización / Referencia" : "Referral"}</option>
              <option value="housing">{es ? "Vivienda y Albergue" : "Housing & Shelter"}</option>
              <option value="psychosocial">{es ? "Psicosocial y Terapia" : "Psychosocial & Therapy"}</option>
              <option value="legal">{es ? "Asistencia Jurídica" : "Legal Assistance"}</option>
              <option value="medical_health">{es ? "Salud y Médica" : "Medical & Health"}</option>
              <option value="child_family">{es ? "Familia y DIF / NNA" : "Child & Family / DIF"}</option>
              <option value="immigration">{es ? "Migración y COMAR" : "Immigration & COMAR"}</option>
              <option value="follow_up">{es ? "Seguimiento" : "Follow-Up"}</option>
              <option value="closure">{es ? "Cierre de Caso" : "Case Closure"}</option>
            </select>
          </div>
        </div>
      </div>

      {/* Documents List */}
      <div className="space-y-3">
        {filteredDocs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/50 p-12 text-center">
            <FileText className="mx-auto h-10 w-10 text-muted-foreground/50" />
            <h4 className="mt-3 text-sm font-semibold text-foreground">
              {es ? "No se encontraron documentos" : "No documents found"}
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {es
                ? "Genere un nuevo documento con las plantillas mexicanas o cargue archivos existentes."
                : "Create a new document from the Mexican templates library or upload files."}
            </p>
            <button
              type="button"
              onClick={() => setTemplatePickerOpen(true)}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              {es ? "Crear primer documento" : "Create first document"}
            </button>
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredDocs.map((doc) => {
              const isDraft = doc.lifecycle_status === "draft" || doc.lifecycle_status === "ready_for_review";
              const isFinalized = doc.lifecycle_status === "finalized";
              const isSent = doc.lifecycle_status === "sent";

              return (
                <div
                  key={doc.id}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 transition hover:border-primary/40 hover:shadow-xs"
                >
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <FileText className="h-4 w-4 text-primary" />
                      <h4 className="text-sm font-bold text-foreground">{doc.title}</h4>

                      {/* Lifecycle Status Badge */}
                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${
                          isDraft
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : isSent
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : isFinalized
                            ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {doc.lifecycle_status?.toUpperCase() || "ACTIVE"}
                      </span>

                      {/* Language Badge */}
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">
                        {doc.language_code || "es"}
                      </span>

                      {doc.template_code && (
                        <span className="text-[10px] font-mono text-muted-foreground">
                          v{doc.current_version || doc.template_version || 1}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                      <span>{es ? "Tipo" : "Type"}: {doc.document_type || doc.purpose || "general"}</span>
                      {doc.finalized_at && (
                        <span>{es ? "Finalizado" : "Finalized"}: {new Date(doc.finalized_at).toLocaleDateString()}</span>
                      )}
                      {doc.sent_at && (
                        <span>{es ? "Enviado a" : "Sent to"}: {doc.sent_to} ({new Date(doc.sent_at).toLocaleDateString()})</span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2">
                    {isDraft ? (
                      <button
                        type="button"
                        onClick={() => setEditingDoc(doc)}
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                      >
                        {es ? "Continuar Borrador" : "Continue Draft"}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => handleAccess(doc.id, "preview")}
                          className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          {es ? "Ver PDF" : "Preview PDF"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAccess(doc.id, "download")}
                          className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                        >
                          <Download className="h-3.5 w-3.5" />
                          {es ? "Descargar" : "Download"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingDoc(doc)}
                          className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                        >
                          {es ? "Administrar / Enviar" : "Manage / Send"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Template Chooser Modal */}
      {templatePickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border p-5">
              <div>
                <h3 className="flex items-center gap-2 text-lg font-bold text-foreground">
                  <FilePlus2 className="h-5 w-5 text-primary" />
                  {es ? "Biblioteca de Plantillas de México" : "Mexico Template Library"}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {es
                    ? "Seleccione una plantilla aprobada. Se precargará automáticamente con los datos del caso."
                    : "Select an approved template. It will auto-fill from the current case record."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTemplatePickerOpen(false)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Category Tabs */}
            <div className="flex flex-wrap gap-1.5 border-b border-border bg-muted/20 p-3 text-xs">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setActiveCategory(c.id)}
                  className={`rounded-lg px-2.5 py-1 font-medium transition ${activeCategory === c.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                >
                  {es ? c.label_es : c.label_en}
                </button>
              ))}
            </div>

            {/* Template Grid */}
            <div className="grid flex-1 gap-4 overflow-y-auto p-6 md:grid-cols-2">
              {filteredTemplates.map((template) => (
                <div
                  key={template.code}
                  className="flex flex-col justify-between rounded-xl border border-border bg-background p-4 transition hover:border-primary/40 hover:shadow-sm"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="font-bold text-foreground">
                        {es ? template.name_es : template.name_en}
                      </h4>
                      <span className="shrink-0 rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                        {template.template_type === "official_mexican_form"
                          ? (es ? "Oficial" : "Official")
                          : (es ? "Plantilla Nyrava" : "Nyrava")}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
                      {es ? template.description_es : template.description_en}
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {template.fields.length} {es ? "campos mapeados" : "mapped fields"}
                    </span>
                    <button
                      type="button"
                      disabled={createDraftMutation.isPending}
                      onClick={() => createDraftMutation.mutate(template.code)}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
                    >
                      {createDraftMutation.isPending && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
                      {es ? "Usar Plantilla" : "Use Template"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Document Editor Modal */}
      {editingDoc && (
        <CaseDocumentEditorModal
          document={editingDoc}
          caseId={caseId}
          consents={consents}
          es={es}
          onClose={() => setEditingDoc(null)}
          onOpenConsentTab={onOpenConsentTab}
        />
      )}
    </div>
  );
}
