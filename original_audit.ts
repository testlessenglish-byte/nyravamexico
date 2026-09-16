import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { localizedEnum } from "@/lib/social/social-i18n";

export interface AuditReportData {
  reportId: string;
  scope: "individual_case" | "organization_wide" | "community_support" | "financial_activity" | "services_outcomes" | "full_audit";
  periodLabel: string;
  startDate?: string | null;
  endDate?: string | null;
  language: "es" | "en";
  classification: "internal" | "confidential" | "restricted" | "external_distribution";
  generatedAt: string;
  organizationName: string;
  caseRecord?: any;
  person?: any;
  summary: any;
  activities: any[];
  assessments: any[];
  plans: any[];
  interventions: any[];
  referrals: any[];
  documents: any[];
  consents: any[];
  tasks: any[];
  campaigns: any[];
  offers: any[];
  checksum: string;
}

export function generateAuditReportPdf(data: AuditReportData): Uint8Array {
  const isEs = data.language === "es";
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const primaryColor: [number, number, number] = [67, 24, 255]; // Nyrava purple #4318FF
  const darkColor: [number, number, number] = [30, 14, 98]; // #1E0E62
  const textMuted: [number, number, number] = [112, 126, 174]; // #707EAE
  const lightBg: [number, number, number] = [244, 247, 254]; // #F4F7FE

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;

  // 1. INSTITUTIONAL COVER PAGE
  doc.setFillColor(...lightBg);
  doc.rect(0, 0, pageWidth, 48, "F");

  doc.setTextColor(...primaryColor);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("NYRAVA MÉXICO", margin, 20);

  doc.setTextColor(...darkColor);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(isEs ? "SISTEMA INTEGRAL DE EXPEDIENTES Y ATENCIÓN SOCIAL" : "COMPREHENSIVE CARE CASE & SOCIAL RECORD SYSTEM", margin, 26);

  // Classification Banner
  const classLabel = {
    internal: isEs ? "INTERNO / NO PÚBLICO" : "INTERNAL / NON-PUBLIC",
    confidential: isEs ? "CONFIDENCIAL — PROPIEDAD DEL TITULAR" : "CONFIDENTIAL — SUBSCRIBER PROPERTY",
    restricted: isEs ? "RESTRINGIDO — ACCESO CONTROLADO" : "RESTRICTED — CONTROLLED ACCESS",
    external_distribution: isEs ? "APROBADO PARA DISTRIBUCIÓN EXTERNA" : "APPROVED FOR EXTERNAL DISTRIBUTION",
  }[data.classification];

  doc.setFillColor(...primaryColor);
  doc.roundedRect(pageWidth - margin - 75, 14, 75, 8, 2, 2, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.text(classLabel, pageWidth - margin - 72, 19.5);

  // Main Report Title
  doc.setTextColor(...darkColor);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  const mainTitle = data.scope === "individual_case"
    ? (isEs ? "INFORME DE EXPEDIENTE Y RENDICIÓN DE CUENTAS" : "CASE ACCOUNTABILITY & AUDIT REPORT")
    : (isEs ? "INFORME INSTITUCIONAL Y AUDITORÍA GENERAL" : "ORGANIZATIONAL ACCOUNTABILITY & AUDIT REPORT");
  doc.text(mainTitle, margin, 65);

  // Metadata Card
  doc.setFillColor(...lightBg);
  doc.roundedRect(margin, 74, pageWidth - margin * 2, 48, 3, 3, "F");

  doc.setFontSize(8.5);
  doc.setTextColor(...textMuted);
  doc.text(isEs ? "Organización / Titular:" : "Organization / Subscriber:", margin + 6, 83);
  doc.text(isEs ? "Periodo del informe:" : "Reporting period:", margin + 6, 91);
  doc.text(isEs ? "Folio de informe:" : "Report identifier:", margin + 6, 99);
  doc.text(isEs ? "Fecha de emisión:" : "Issued timestamp:", margin + 6, 107);
  doc.text(isEs ? "Alcance del reporte:" : "Report scope:", margin + 6, 115);

  doc.setTextColor(...darkColor);
  doc.setFont("helvetica", "bold");
  doc.text(data.organizationName || "Nyrava México", margin + 55, 83);
  doc.text(data.periodLabel || (isEs ? "Historial completo" : "All history"), margin + 55, 91);
  doc.text(data.reportId, margin + 55, 99);
  doc.text(data.generatedAt, margin + 55, 107);
  doc.text(localizedEnum(data.scope, isEs), margin + 55, 115);

  if (data.caseRecord) {
    doc.text(isEs ? "Expediente del caso:" : "Case file:", margin + 115, 83);
    doc.setFont("helvetica", "bold");
    doc.text(`${data.caseRecord.case_number} · ${data.person?.legal_name || (isEs ? "Caso familiar" : "Family case")}`, margin + 145, 83);
  }

  // Mandatory Zero-Invention Disclaimer
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(...textMuted);
  const disclaimer = isEs
    ? "Este informe refleja exclusivamente los registros autorizados almacenados en el sistema canónico de Nyrava México para el periodo señalado. Todos los valores, fechas y actividades han sido calculados de forma determinista a partir de los expedientes y eventos del sistema, sin inferencias ni estimaciones automáticas."
    : "This report strictly reflects authorized canonical records stored in Nyrava Mexico for the specified period. All values, timestamps, and activities are deterministically calculated from system events and case records without fabrication or automated estimation.";
  const splitDisc = doc.splitTextToSize(disclaimer, pageWidth - margin * 2);
  doc.text(splitDisc, margin, 130);

  // 2. EXECUTIVE SUMMARY TABLE
  const s = data.summary;
  autoTable(doc, {
    startY: 145,
    head: [[
      isEs ? "MÉTRICA DETERMINISTA" : "DETERMINISTIC METRIC",
      isEs ? "TOTAL REGISTRADO" : "RECORDED VALUE",
      isEs ? "ESTADO / DETALLE" : "STATUS / DETAIL"
    ]],
    body: [
      [isEs ? "Expedientes de casos atendidos" : "Cases served", String(s.casesCount || (data.caseRecord ? 1 : 0)), `${s.activeCasesCount || 0} ${isEs ? "activos" : "active"} · ${s.closedCasesCount || 0} ${isEs ? "cerrados" : "closed"}`],
      [isEs ? "Casos en riesgo alto / crítico" : "High/Critical risk cases", String(s.highRiskCasesCount || 0), isEs ? "Evaluados formalmente" : "Formally assessed"],
      [isEs ? "Intervenciones profesionales" : "Professional interventions", String(s.interventionsCount || data.interventions.length), isEs ? "Trabajo social, legal, salud" : "Social, legal, health"],
      [isEs ? "Canalizaciones a recursos" : "Referrals created", String(s.referralsCount || data.referrals.length), `${s.completedReferralsCount || 0} ${isEs ? "concluidas con éxito" : "completed"}`],
      [isEs ? "Tareas operativas registradas" : "Tasks recorded", String(s.tasksCount || data.tasks.length), `${s.completedTasksCount || 0} ${isEs ? "completadas" : "completed"} · ${s.overdueTasksCount || 0} ${isEs ? "vencidas" : "overdue"}`],
      [isEs ? "Campañas de apoyo comunitario" : "Community support campaigns", String(s.campaignsCount || data.campaigns.length), `${s.goodsReceivedCount || 0} ${isEs ? "donaciones entregadas" : "donations received"}`],
    ],
    theme: "striped",
    headStyles: { fillColor: primaryColor, textColor: 255, fontStyle: "bold", fontSize: 8.5 },
    styles: { fontSize: 8, cellPadding: 3, textColor: darkColor },
    alternateRowStyles: { fillColor: lightBg },
    margin: { left: margin, right: margin },
  });

  // 3. CASE IDENTIFICATION (If single case)
  if (data.caseRecord) {
    const c = data.caseRecord;
    const p = data.person;
    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 8,
      head: [[isEs ? "DATOS CANÓNICOS DEL CASO" : "CANONICAL CASE DATA", ""]],
      body: [
        [isEs ? "Número de expediente" : "Case number", c.case_number || "—"],
        [isEs ? "Persona / Titular" : "Client / Principal", p?.legal_name || (isEs ? "Caso familiar" : "Family case")],
        [isEs ? "Estado y Prioridad" : "Status & Priority", `${localizedEnum(c.status, isEs)} · ${localizedEnum(c.priority, isEs)}`],
        [isEs ? "Nivel de riesgo vigente" : "Current risk level", localizedEnum(c.risk_level, isEs)],
        [isEs ? "Tipo de expediente" : "Record type", localizedEnum(c.case_type, isEs)],
        [isEs ? "Fecha de apertura" : "Date opened", c.created_at ? new Date(c.created_at).toLocaleDateString() : "—"],
        [isEs ? "Fecha de cierre" : "Date closed", c.closed_at ? new Date(c.closed_at).toLocaleDateString() : (isEs ? "No cerrado" : "Not closed")],
      ],
      theme: "plain",
      headStyles: { fillColor: darkColor, textColor: 255, fontStyle: "bold", fontSize: 8.5 },
      styles: { fontSize: 8, cellPadding: 2.5, textColor: darkColor },
      columnStyles: { 0: { fontStyle: "bold", cellWidth: 50 } },
      margin: { left: margin, right: margin },
    });
  }

  // 4. INTERVENTIONS TABLE
  if (data.interventions && data.interventions.length > 0) {
    doc.addPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...darkColor);
    doc.text(isEs ? "REGISTRO DE INTERVENCIONES PROFESIONALES" : "PROFESSIONAL INTERVENTIONS LOG", margin, 20);

    autoTable(doc, {
      startY: 25,
      head: [[
        isEs ? "FECHA" : "DATE",
        isEs ? "SERVICIO" : "SERVICE",
        isEs ? "MOTIVO" : "REASON",
        isEs ? "ACCIONES DOCUMENTADAS" : "ACTIONS TAKEN",
        isEs ? "RESULTADO" : "OUTCOME"
      ]],
      body: data.interventions.map((inv: any) => [
        inv.occurred_at ? new Date(inv.occurred_at).toLocaleDateString() : "—",
        localizedEnum(inv.service_type, isEs),
        inv.reason || "—",
        inv.actions_taken || "—",
        inv.outcome || "—",
      ]),
      theme: "striped",
      headStyles: { fillColor: primaryColor, textColor: 255, fontStyle: "bold", fontSize: 8 },
      styles: { fontSize: 7.5, cellPadding: 2.5, textColor: darkColor },
      margin: { left: margin, right: margin },
    });
  }

  // 5. REFERRALS TABLE
  if (data.referrals && data.referrals.length > 0) {
    autoTable(doc, {
      startY: (doc as any).lastAutoTable ? (doc as any).lastAutoTable.finalY + 8 : 25,
      head: [[
        isEs ? "CANALIZACIÓN" : "REFERRAL",
        isEs ? "SERVICIO" : "SERVICE",
        isEs ? "PROVEEDOR / INSTITUCIÓN" : "PROVIDER / INSTITUTION",
        isEs ? "ESTADO" : "STATUS",
        isEs ? "FECHA ENVÍO" : "SENT DATE"
      ]],
      body: data.referrals.map((r: any) => [
        r.id ? r.id.slice(0, 8) : "—",
        localizedEnum(r.service_type, isEs),
        r.external_service_name || r.provider_notes || "—",
        localizedEnum(r.status, isEs),
        r.sent_at ? new Date(r.sent_at).toLocaleDateString() : (isEs ? "No enviado" : "Not sent"),
      ]),
      theme: "striped",
      headStyles: { fillColor: darkColor, textColor: 255, fontStyle: "bold", fontSize: 8 },
      styles: { fontSize: 7.5, cellPadding: 2.5, textColor: darkColor },
      margin: { left: margin, right: margin },
    });
  }

  // 6. COMMUNITY CAMPAIGNS TABLE
  if (data.campaigns && data.campaigns.length > 0) {
    doc.addPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...darkColor);
    doc.text(isEs ? "APOYO COMUNITARIO Y DONACIONES" : "COMMUNITY SUPPORT & DONATIONS", margin, 20);

    autoTable(doc, {
      startY: 25,
      head: [[
        isEs ? "CAMPAÑA" : "CAMPAIGN",
        isEs ? "CATEGORÍAS" : "CATEGORIES",
        isEs ? "ESTADO" : "STATUS",
        isEs ? "META ECONÓMICA" : "FINANCIAL TARGET",
        isEs ? "DONACIONES RECIBIDAS" : "OFFERS RECEIVED"
      ]],
      body: data.campaigns.map((camp: any) => [
        camp.title || "—",
        (camp.support_categories || []).map((c: string) => localizedEnum(c, isEs)).join(", "),
        localizedEnum(camp.lifecycle_status, isEs),
        camp.financial_target_amount ? `$${Number(camp.financial_target_amount).toLocaleString()} ${camp.financial_currency || "MXN"}` : (isEs ? "No aplica" : "N/A"),
        String(data.offers ? data.offers.filter((o: any) => o.campaign_id === camp.id).length : 0),
      ]),
      theme: "striped",
      headStyles: { fillColor: primaryColor, textColor: 255, fontStyle: "bold", fontSize: 8 },
      styles: { fontSize: 7.5, cellPadding: 2.5, textColor: darkColor },
      margin: { left: margin, right: margin },
    });
  }

  // 7. AUDIT TRAIL TABLE
  if (data.activities && data.activities.length > 0) {
    autoTable(doc, {
      startY: (doc as any).lastAutoTable ? (doc as any).lastAutoTable.finalY + 8 : 25,
      head: [[
        isEs ? "HORA / FECHA" : "TIMESTAMP",
        isEs ? "OPERACIÓN" : "EVENT TYPE",
        isEs ? "ENTIDAD" : "ENTITY",
        isEs ? "FOLIO / DETALLES CANÓNICOS" : "CANONICAL DETAILS"
      ]],
      body: data.activities.slice(0, 25).map((act: any) => [
        act.created_at ? new Date(act.created_at).toLocaleString() : "—",
        localizedEnum(act.event_type, isEs),
        act.entity_type || "—",
        act.metadata?.operation || act.metadata?.service_type || act.metadata?.title || act.entity_id?.slice(0, 8) || "—",
      ]),
      theme: "striped",
      headStyles: { fillColor: darkColor, textColor: 255, fontStyle: "bold", fontSize: 8 },
      styles: { fontSize: 7, cellPadding: 2, textColor: darkColor },
      margin: { left: margin, right: margin },
    });
  }

  // 8. RUNNING HEADERS, FOOTERS & VERIFICATION
  const totalPages = (doc as any).getNumberOfPages ? (doc as any).getNumberOfPages() : 1;
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);

    if (i > 1) {
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...textMuted);
      doc.text(`NYRAVA MÉXICO · ${data.reportId}`, margin, 10);
      doc.text(classLabel, pageWidth - margin - 50, 10);
      doc.setDrawColor(...lightBg);
      doc.line(margin, 12, pageWidth - margin, 12);
    }

    doc.setDrawColor(...lightBg);
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);

    doc.setFontSize(7);
    doc.setTextColor(...textMuted);
    doc.text(
      `${isEs ? "Verificación SHA-256:" : "SHA-256 Verification:"} ${data.checksum.slice(0, 16)}...`,
      margin,
      pageHeight - 7
    );
    doc.text(
      `${isEs ? "Página" : "Page"} ${i} ${isEs ? "de" : "of"} ${totalPages}`,
      pageWidth - margin - 20,
      pageHeight - 7
    );
  }

  return doc.output("arraybuffer") as unknown as Uint8Array;
}