import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, Eye, FileText, Globe, Loader2, Mail, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { findTemplateByCode } from "@/lib/social/templates/mexico-template-definitions";
import { finalizeCaseDocument, sendCaseDocumentEmail, updateCaseDocumentDraft } from "@/lib/social.functions";

interface Props {
  document: any;
  caseId: string;
  consents: any[];
  es: boolean;
  onClose: () => void;
  onOpenConsentTab?: () => void;
}

export function CaseDocumentEditorModal({ document: doc, caseId, consents, es, onClose, onOpenConsentTab }: Props) {
  const qc = useQueryClient();
  const updateFn = useServerFn(updateCaseDocumentDraft);
  const finalizeFn = useServerFn(finalizeCaseDocument);
  const sendEmailFn = useServerFn(sendCaseDocumentEmail);

  const template = findTemplateByCode(doc.template_code || "mex_ficha_ingreso");
  const [lang, setLang] = useState<"es" | "en">(doc.language_code === "en" ? "en" : "es");
  const [payload, setPayload] = useState<Record<string, any>>(doc.draft_payload || {});
  const [recipient, setRecipient] = useState<Record<string, any>>(doc.recipient_info || {});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [emailForm, setEmailForm] = useState({
    to: recipient.email || "",
    subject: `Atención Integral — Remisión de caso ${doc.title?.split("—")?.[1]?.trim() || ""}`,
    message: es
      ? "Estimado/a colega,\n\nAdjunto la documentación autorizada para la debida atención y seguimiento. Agradecemos su acuse de recibo y respuesta institucional."
      : "Dear colleague,\n\nAttached is the authorized case documentation for review and follow-up. Please confirm receipt and return institutional updates.",
    consentId: consents.find((c: any) => c.status === "active")?.id || "",
  });

  const activeConsents = consents.filter((c: any) => c.status === "active" && (!c.expires_at || new Date(c.expires_at) > new Date()));
  const hasActiveConsent = activeConsents.length > 0;

  const saveDraft = useMutation({
    mutationFn: () => updateFn({
      data: {
        documentId: doc.id,
        draftPayload: payload,
        recipientInfo: recipient,
        language: lang,
        lifecycleStatus: "draft",
      }
    }),
    onSuccess: () => {
      toast.success(es ? "Borrador guardado exitosamente" : "Draft saved successfully");
      void qc.invalidateQueries({ queryKey: ["social-document-workspace", caseId] });
      void qc.invalidateQueries({ queryKey: ["social-case", caseId] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const finalize = useMutation({
    mutationFn: () => finalizeFn({
      data: {
        documentId: doc.id,
        draftPayload: payload,
        recipientInfo: recipient,
        language: lang,
      }
    }),
    onSuccess: () => {
      toast.success(es ? "Documento finalizado y guardado en Expediente como inmutable" : "Document finalized and saved as immutable record");
      void qc.invalidateQueries({ queryKey: ["social-document-workspace", caseId] });
      void qc.invalidateQueries({ queryKey: ["social-case", caseId] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const sendEmail = useMutation({
    mutationFn: () => sendEmailFn({
      data: {
        documentId: doc.id,
        toEmail: emailForm.to,
        subject: emailForm.subject,
        message: emailForm.message,
        consentId: emailForm.consentId,
      }
    }),
    onSuccess: () => {
      toast.success(es ? "Documento y remisión enviados por correo electrónico" : "Document and referral sent via email");
      void qc.invalidateQueries({ queryKey: ["social-document-workspace", caseId] });
      void qc.invalidateQueries({ queryKey: ["social-case", caseId] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const updateField = (key: string, val: any) => {
    setPayload((prev) => ({ ...prev, [key]: val }));
  };

  const sections = template?.default_sections || [
    { title_es: "Información del documento", title_en: "Document Information", field_keys: template?.fields.map((f) => f.key) || [] }
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border p-5">
          <div>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              <h3 className="text-lg font-bold">
                {lang === "es" ? template?.name_es : template?.name_en}
              </h3>
              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                {doc.lifecycle_status?.toUpperCase() || "DRAFT"}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {template?.template_type === "official_mexican_form"
                ? `${es ? "Formato Oficial" : "Official Form"} · ${template.official_authority}`
                : `${es ? "Plantilla Nyrava" : "Nyrava Template"} · v${template?.version || 1}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border border-border bg-muted/30 p-1 text-xs">
              <Globe className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
              <button
                type="button"
                onClick={() => setLang("es")}
                className={`rounded px-2 py-1 font-medium transition ${lang === "es" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                Español
              </button>
              <button
                type="button"
                onClick={() => setLang("en")}
                className={`rounded px-2 py-1 font-medium transition ${lang === "en" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                English
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Body Content */}
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {/* Disclosure & Consent Status Banner */}
          <div className={`rounded-xl border p-4 text-xs ${hasActiveConsent ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-200" : "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-200"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                {hasActiveConsent ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                )}
                <div>
                  <p className="font-semibold">
                    {hasActiveConsent
                      ? (es ? "Consentimiento de divulgación verificado" : "Disclosure consent verified")
                      : (es ? "Consentimiento activo no detectado para divulgación externa" : "Active consent not detected for external disclosure")}
                  </p>
                  <p className="mt-0.5 opacity-90">
                    {hasActiveConsent
                      ? (es ? `Existen ${activeConsents.length} consentimientos vigentes para este expediente.` : `${activeConsents.length} active consents recorded for this case.`)
                      : (es ? "Para enviar o compartir este documento con un proveedor externo, registre el consentimiento informado." : "To send this document externally, please register an informed consent.")}
                  </p>
                </div>
              </div>
              {!hasActiveConsent && onOpenConsentTab && (
                <button
                  type="button"
                  onClick={onOpenConsentTab}
                  className="rounded-lg border border-amber-600/40 bg-amber-600/20 px-3 py-1 font-semibold text-amber-900 hover:bg-amber-600/30 dark:text-amber-100"
                >
                  {es ? "Abrir Consentimiento" : "Open Consent"}
                </button>
              )}
            </div>
          </div>

          {/* Form Sections */}
          {sections.map((section, sIndex) => (
            <div key={sIndex} className="space-y-4 rounded-xl border border-border bg-background p-4">
              <h4 className="border-b border-border pb-2 text-sm font-bold text-foreground">
                {lang === "es" ? section.title_es : section.title_en}
              </h4>
              <div className="grid gap-4 md:grid-cols-2">
                {section.field_keys.map((fKey) => {
                  const fieldDef = template?.fields.find((f) => f.key === fKey);
                  if (!fieldDef) return null;
                  const labelText = lang === "es" ? fieldDef.label_es : fieldDef.label_en;
                  const currentVal = payload[fieldDef.key] ?? "";
                  const isAuto = fieldDef.category_role === "auto_filled" && currentVal && currentVal !== "No registrado" && currentVal !== "Not recorded";

                  return (
                    <div key={fKey} className={fieldDef.type === "textarea" ? "md:col-span-2" : ""}>
                      <div className="mb-1 flex items-center justify-between">
                        <label className="text-xs font-semibold text-foreground">
                          {labelText} {fieldDef.required && <span className="text-destructive">*</span>}
                        </label>
                        {isAuto ? (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            {es ? "Cargado del caso" : "Auto-filled from case"}
                          </span>
                        ) : fieldDef.required && !currentVal ? (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            {es ? "Requiere completar" : "Needs completion"}
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">
                            {fieldDef.required ? (es ? "Obligatorio" : "Required") : (es ? "Opcional" : "Optional")}
                          </span>
                        )}
                      </div>

                      {fieldDef.type === "textarea" ? (
                        <textarea
                          rows={3}
                          value={currentVal}
                          onChange={(e) => updateField(fieldDef.key, e.target.value)}
                          placeholder={lang === "es" ? fieldDef.placeholder_es : fieldDef.placeholder_en}
                          className="w-full rounded-lg border border-border bg-card p-2.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      ) : fieldDef.type === "select" ? (
                        <select
                          value={currentVal}
                          onChange={(e) => updateField(fieldDef.key, e.target.value)}
                          className="w-full rounded-lg border border-border bg-card p-2.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <option value="">— {es ? "Seleccionar" : "Select"} —</option>
                          {fieldDef.options?.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {lang === "es" ? opt.label_es : opt.label_en}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={fieldDef.type === "number" ? "number" : fieldDef.type === "date" ? "date" : "text"}
                          value={currentVal}
                          onChange={(e) => updateField(fieldDef.key, e.target.value)}
                          placeholder={lang === "es" ? fieldDef.placeholder_es : fieldDef.placeholder_en}
                          className="w-full rounded-lg border border-border bg-card p-2.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Recipient & External Agency Details */}
          <div className="space-y-4 rounded-xl border border-border bg-background p-4">
            <h4 className="border-b border-border pb-2 text-sm font-bold text-foreground">
              {es ? "Destinatario / Organismo Receptor (para canalizaciones externas)" : "Recipient / Receiving Agency (for external referrals)"}
            </h4>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs font-medium text-muted-foreground">
                {es ? "Organización / Institución" : "Organization / Institution"}
                <input
                  type="text"
                  value={recipient.organization || ""}
                  onChange={(e) => setRecipient({ ...recipient, organization: e.target.value })}
                  placeholder="e.g. SNDIF, Albergue La Esperanza, CEAV"
                  className="mt-1 w-full rounded-lg border border-border bg-card p-2 text-xs text-foreground"
                />
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                {es ? "Persona de contacto" : "Contact Person"}
                <input
                  type="text"
                  value={recipient.contact_name || ""}
                  onChange={(e) => setRecipient({ ...recipient, contact_name: e.target.value })}
                  placeholder="e.g. Lic. María Fernández"
                  className="mt-1 w-full rounded-lg border border-border bg-card p-2 text-xs text-foreground"
                />
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                {es ? "Correo electrónico" : "Email"}
                <input
                  type="email"
                  value={recipient.email || ""}
                  onChange={(e) => {
                    setRecipient({ ...recipient, email: e.target.value });
                    setEmailForm((prev) => ({ ...prev, to: e.target.value }));
                  }}
                  placeholder="contacto@institucion.gob.mx"
                  className="mt-1 w-full rounded-lg border border-border bg-card p-2 text-xs text-foreground"
                />
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                {es ? "Teléfono" : "Phone"}
                <input
                  type="text"
                  value={recipient.phone || ""}
                  onChange={(e) => setRecipient({ ...recipient, phone: e.target.value })}
                  placeholder="+52 55 ..."
                  className="mt-1 w-full rounded-lg border border-border bg-card p-2 text-xs text-foreground"
                />
              </label>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 p-4">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
          >
            <Eye className="h-4 w-4" />
            {es ? "Vista previa" : "Preview"}
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saveDraft.isPending}
              onClick={() => saveDraft.mutate()}
              className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
            >
              {saveDraft.isPending && <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />}
              {es ? "Guardar borrador" : "Save Draft"}
            </button>

            <button
              type="button"
              disabled={finalize.isPending}
              onClick={() => finalize.mutate()}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow hover:bg-primary/90"
            >
              {finalize.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <CheckCircle2 className="h-3.5 w-3.5" />
              {es ? "Aprobar y Finalizar Documento" : "Approve & Finalize Document"}
            </button>

            {doc.lifecycle_status === "finalized" && (
              <button
                type="button"
                onClick={() => setSendOpen(true)}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                <Mail className="h-3.5 w-3.5" />
                {es ? "Enviar por Correo" : "Send via Email"}
              </button>
            )}
          </div>
        </div>

        {/* Live Preview Modal */}
        {previewOpen && (
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4">
            <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-border bg-card p-6 shadow-2xl">
              <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
                <h4 className="font-bold text-foreground">
                  {es ? "Vista Previa del Documento" : "Document Preview"} — {lang === "es" ? template?.name_es : template?.name_en}
                </h4>
                <button type="button" onClick={() => setPreviewOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-muted">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-border bg-background p-4 text-xs font-mono">
                <div className="border-b border-border pb-2">
                  <p className="font-bold uppercase text-primary">ATENCIÓN INTEGRAL — EXPEDIENTE SOCIAL</p>
                  <p className="text-muted-foreground">{new Date().toLocaleDateString()}</p>
                </div>
                {sections.map((sec, i) => (
                  <div key={i} className="space-y-1">
                    <p className="font-bold text-foreground">{lang === "es" ? sec.title_es : sec.title_en}:</p>
                    {sec.field_keys.map((k) => {
                      const f = template?.fields.find((field) => field.key === k);
                      return (
                        <p key={k} className="pl-3 text-muted-foreground">
                          <span className="text-foreground">{lang === "es" ? f?.label_es : f?.label_en}:</span> {payload[k] || "—"}
                        </p>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-end">
                <button type="button" onClick={() => setPreviewOpen(false)} className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground">
                  {es ? "Cerrar vista previa" : "Close Preview"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Send Email Modal */}
        {sendOpen && (
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-lg space-y-4 rounded-2xl border border-border bg-card p-6 shadow-2xl">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <h4 className="flex items-center gap-2 font-bold text-foreground">
                  <Mail className="h-4 w-4 text-primary" />
                  {es ? "Enviar Documento por Correo" : "Send Document via Email"}
                </h4>
                <button type="button" onClick={() => setSendOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-muted">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-3 text-xs">
                <label className="block font-medium text-muted-foreground">
                  {es ? "Destinatario (correo institucional)" : "Recipient (institutional email)"}
                  <input
                    type="email"
                    value={emailForm.to}
                    onChange={(e) => setEmailForm({ ...emailForm, to: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background p-2.5 text-xs text-foreground"
                  />
                </label>

                <label className="block font-medium text-muted-foreground">
                  {es ? "Asunto (neutro, sin datos sensibles en el título)" : "Subject (neutral, no sensitive data in title)"}
                  <input
                    type="text"
                    value={emailForm.subject}
                    onChange={(e) => setEmailForm({ ...emailForm, subject: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background p-2.5 text-xs text-foreground"
                  />
                </label>

                <label className="block font-medium text-muted-foreground">
                  {es ? "Consentimiento aplicable" : "Applicable Consent"}
                  <select
                    value={emailForm.consentId}
                    onChange={(e) => setEmailForm({ ...emailForm, consentId: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background p-2.5 text-xs text-foreground"
                  >
                    <option value="">— {es ? "Seleccionar consentimiento vigente" : "Select active consent"} —</option>
                    {activeConsents.map((c: any) => (
                      <option key={c.id} value={c.id}>
                        {c.consent_type} ({new Date(c.valid_from).toLocaleDateString()})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block font-medium text-muted-foreground">
                  {es ? "Mensaje" : "Message"}
                  <textarea
                    rows={4}
                    value={emailForm.message}
                    onChange={(e) => setEmailForm({ ...emailForm, message: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background p-2.5 text-xs text-foreground"
                  />
                </label>

                <div className="rounded-lg border border-border bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
                  <ShieldAlert className="mr-1 inline h-3.5 w-3.5 text-primary" />
                  {es
                    ? "El PDF finalizado se adjuntará automáticamente y se creará una tarea de seguimiento en Tareas y Citas."
                    : "The finalized PDF will be attached automatically and a follow-up task will be created."}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setSendOpen(false)} className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted">
                  {es ? "Cancelar" : "Cancel"}
                </button>
                <button
                  type="button"
                  disabled={!emailForm.to || !emailForm.consentId || sendEmail.isPending}
                  onClick={() => sendEmail.mutate()}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {sendEmail.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {es ? "Confirmar y Enviar" : "Confirm and Send"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
