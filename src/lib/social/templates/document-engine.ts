import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { MexicoTemplateDefinition } from "./mexico-template-definitions";

export interface CaseContextInput {
  caseRecord: {
    id: string;
    case_number: string;
    priority?: string;
    status?: string;
    assigned_case_manager?: string;
  };
  person?: {
    id: string;
    legal_name?: string;
    preferred_name?: string;
    phone?: string;
    email?: string;
    language?: string;
    municipality?: string;
    state?: string;
    nationality?: string;
    birth_date?: string;
  } | null;
  family?: {
    id: string;
    family_name?: string;
    member_ids?: string[];
  } | null;
  householdMembers?: Array<{
    name: string;
    relationship?: string;
    is_minor?: boolean;
    age?: number;
  }>;
  riskAssessment?: {
    risk_level?: string;
    reason?: string;
    protective_factors?: string;
    required_followup?: string;
  } | null;
  carePlan?: {
    goals?: Array<{ goal: string; target_date?: string }>;
    presenting_needs?: string;
  } | null;
  worker?: {
    name?: string;
    contact?: string;
    email?: string;
  } | null;
}

export function extractAuthorizedCaseContext(input: CaseContextInput) {
  const c = input.caseRecord;
  const p = input.person;
  const f = input.family;
  const r = input.riskAssessment;
  const cp = input.carePlan;
  const w = input.worker;

  const loc = [p?.municipality, p?.state].filter(Boolean).join(", ");
  const householdCount = input.householdMembers?.length ?? 0;
  const minors = (input.householdMembers ?? []).filter((m) => m.is_minor);
  const adults = (input.householdMembers ?? []).filter((m) => !m.is_minor);

  let householdDesc = "";
  if (householdCount > 0) {
    householdDesc = `${adults.length} adulto(s), ${minors.length} menor(es) de edad`;
    if (f?.family_name) householdDesc = `${f.family_name}: ${householdDesc}`;
  } else if (f?.family_name) {
    householdDesc = f.family_name;
  }

  return {
    "case.number": c.case_number || "No registrado",
    "case.priority": c.priority || "Normal",
    "case.status": c.status || "active",
    "case.worker_name": w?.name || c.assigned_case_manager || "Trabajador Social Responsable",
    "case.worker_contact": [w?.name, w?.contact, w?.email].filter(Boolean).join(" · ") || "Atención Integral",
    "client.full_name": p?.legal_name || "No registrado",
    "client.preferred_name": p?.preferred_name || p?.legal_name || "No registrado",
    "client.phone": p?.phone || "No registrado",
    "client.email": p?.email || "No registrado",
    "client.language": p?.language || "Español",
    "client.location": loc || "No registrado",
    "client.nationality": p?.nationality || "Mexicana",
    "household.composition": householdDesc || "Núcleo familiar de 1 persona",
    "risk.current_level": r?.risk_level || "Desconocido / No evaluado",
    "risk.protective_factors": r?.protective_factors || "No registrados",
    "care_plan.needs": cp?.presenting_needs || (cp?.goals?.map((g) => g.goal).join("; ") || "Atención integral y acompañamiento multidisciplinario"),
    "consent.default_terms": "La persona ha sido informada sobre el alcance y la revocabilidad de este consentimiento conforme a la legislación aplicable."
  };
}

export function prefillTemplate(
  template: MexicoTemplateDefinition,
  caseContext: Record<string, string>,
  targetLanguage: "es" | "en" = "es"
): {
  values: Record<string, any>;
  fieldStatus: Record<string, "auto_filled" | "needs_completion" | "optional">;
} {
  const values: Record<string, any> = {};
  const fieldStatus: Record<string, "auto_filled" | "needs_completion" | "optional"> = {};

  for (const field of template.fields) {
    if (field.mapping_path && caseContext[field.mapping_path]) {
      const val = caseContext[field.mapping_path];
      values[field.key] = val;
      fieldStatus[field.key] = val && val !== "No registrado" && val !== "Not recorded" ? "auto_filled" : "needs_completion";
    } else {
      values[field.key] = "";
      fieldStatus[field.key] = field.required ? "needs_completion" : "optional";
    }
  }

  return { values, fieldStatus };
}

export function generateCaseDocumentPdf(
  template: MexicoTemplateDefinition,
  draftPayload: Record<string, any>,
  recipientInfo: {
    organization?: string;
    contact_name?: string;
    email?: string;
    phone?: string;
    address?: string;
  },
  language: "es" | "en" = "es"
): Uint8Array {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const es = language === "es";

  // Header
  doc.setFillColor(30, 41, 59);
  doc.rect(0, 0, 612, 60, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text(es ? "ATENCIÓN INTEGRAL — EXPEDIENTE SOCIAL" : "COMPREHENSIVE CARE — SOCIAL CASE FILE", 40, 35);

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(new Date().toLocaleDateString(es ? "es-MX" : "en-US"), 520, 35);

  // Title
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(es ? template.name_es : template.name_en, 40, 90);

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 116, 139);
  const typeLabel = template.template_type === "official_mexican_form"
    ? `${es ? "FORMATO OFICIAL" : "OFFICIAL FORM"} · ${template.official_authority || "Autoridad Mexicana"}`
    : `${es ? "PLANTILLA DE GESTIÓN Y CANALIZACIÓN NYRAVA" : "NYRAVA CASE MANAGEMENT TEMPLATE"} · v${template.version}`;
  doc.text(typeLabel, 40, 105);

  // Recipient Box if present
  let currentY = 120;
  if (recipientInfo.organization || recipientInfo.contact_name) {
    doc.setDrawColor(203, 213, 225);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(40, currentY, 532, 50, 4, 4, "FD");

    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 41, 59);
    doc.text(es ? "DESTINATARIO / ORGANISMO RECEPTOR:" : "RECIPIENT / RECEIVING AGENCY:", 50, currentY + 16);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const recDetails = [
      recipientInfo.organization,
      recipientInfo.contact_name,
      recipientInfo.phone,
      recipientInfo.email,
      recipientInfo.address
    ].filter(Boolean).join(" · ");
    doc.text(recDetails || "—", 50, currentY + 34);

    currentY += 65;
  }

  // Sections and Fields Table
  const tableData: any[][] = [];

  for (const section of template.default_sections) {
    const secTitle = es ? section.title_es : section.title_en;
    tableData.push([{ content: secTitle, colSpan: 2, styles: { fontStyle: "bold", fillColor: [241, 245, 249], textColor: [15, 23, 42] } }]);

    for (const fieldKey of section.field_keys) {
      const fieldDef = template.fields.find((f) => f.key === fieldKey);
      if (!fieldDef) continue;
      const label = es ? fieldDef.label_es : fieldDef.label_en;
      const rawVal = draftPayload[fieldKey];
      const val = rawVal ? String(rawVal) : (es ? "No registrado" : "Not recorded");
      tableData.push([label, val]);
    }
  }

  autoTable(doc, {
    startY: currentY,
    margin: { left: 40, right: 40 },
    head: [[es ? "Campo" : "Field", es ? "Información Registrada" : "Recorded Information"]],
    body: tableData,
    theme: "grid",
    headStyles: { fillColor: [51, 65, 85], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9 },
    bodyStyles: { fontSize: 8.5, textColor: [30, 41, 59] },
    columnStyles: {
      0: { cellWidth: 160, fontStyle: "bold", textColor: [71, 85, 105] },
      1: { cellWidth: "auto" }
    }
  });

  // Footer & Minimum Necessary Disclosure Notice
  const finalY = (doc as any).lastAutoTable?.finalY || currentY + 200;
  const noticeY = Math.min(finalY + 30, 700);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(100, 116, 139);
  const noticeText = es
    ? "Aviso de confidencialidad y divulgación mínima: La información contenida en este documento se comparte exclusivamente para los fines autorizados por la persona titular mediante consentimiento informado. Queda prohibida su divulgación o uso para propósitos distintos a los manifestados."
    : "Confidentiality & Minimum Necessary Disclosure Notice: Information in this document is shared solely for authorized purposes under express informed consent. Any unauthorized disclosure or use for unrelated purposes is strictly prohibited.";
  doc.text(doc.splitTextToSize(noticeText, 532), 40, noticeY);

  // Signatures
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.line(60, noticeY + 45, 240, noticeY + 45);
  doc.text(es ? "Firma del Profesional Responsable" : "Responsible Worker Signature", 80, noticeY + 58);

  doc.line(360, noticeY + 45, 540, noticeY + 45);
  doc.text(es ? "Firma de la Persona / Titular (si aplica)" : "Client / Guardian Signature (if applicable)", 375, noticeY + 58);

  return doc.output("arraybuffer") as unknown as Uint8Array;
}
