import { rt } from "../../report-i18n";
import { PdfBuilder } from "../../export";
import { translateLegalTerm } from "../../pdf/enum-translation";

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

  const b = new PdfBuilder("Audit Report", data.reportId);

  const classLabel = {
    internal: isEs ? "INTERNO / NO PÚBLICO" : "INTERNAL / NON-PUBLIC",
    confidential: isEs ? "CONFIDENCIAL" : "CONFIDENTIAL",
    restricted: isEs ? "RESTRINGIDO" : "RESTRICTED",
    external_distribution: isEs ? "DISTRIBUCIÓN EXTERNA" : "EXTERNAL DISTRIBUTION",
  }[data.classification];

  const mainTitle = data.scope === "individual_case"
    ? (isEs ? "INFORME DE EXPEDIENTE Y RENDICIÓN DE CUENTAS" : "CASE ACCOUNTABILITY & AUDIT REPORT")
    : (isEs ? "INFORME INSTITUCIONAL Y AUDITORÍA GENERAL" : "ORGANIZATIONAL ACCOUNTABILITY & AUDIT REPORT");

  b.premiumCover({
    reportTitle: mainTitle,
    caseName: data.organizationName,
    client: data.person ? data.person.given_name : undefined,
    proceeding: data.scope,
    matterType: "Auditoría Social",
    court: undefined,
    jurisdiction: undefined,
    matterId: data.reportId,
    classification: classLabel,
    date: new Date(data.generatedAt).toLocaleDateString(isEs ? "es-MX" : "en-US"),
    engineVersion: undefined,
    certification: "verified",
  });

  b.h1(isEs ? "Parámetros del Informe" : "Report Parameters");
  b.text(`${isEs ? "ID de Informe:" : "Report ID:"} ${data.reportId}`, { bold: true });
  b.text(`${isEs ? "Organización:" : "Organization:"} ${data.organizationName}`);
  b.text(`${isEs ? "Fecha de Emisión:" : "Generated At:"} ${new Date(data.generatedAt).toLocaleString()}`);
  b.text(`${isEs ? "Período:" : "Period:"} ${data.periodLabel}`);
  b.text(`${isEs ? "Suma de control:" : "Checksum:"} ${data.checksum}`);
  b.divider();

  if (data.scope === "individual_case" && data.caseRecord) {
    b.h2(isEs ? "Detalles del Expediente" : "Case Record Details");
    b.text(`${isEs ? "Estatus:" : "Status:"} ${data.caseRecord.status}`);
    b.text(`${isEs ? "Prioridad:" : "Priority:"} ${data.caseRecord.priority}`);
  }

  // Inject the checksum into the footer
  b.doc.setFontSize(7);
  b.doc.setTextColor(111, 107, 133);
  b.doc.text(
    `${isEs ? "Verificación SHA-256:" : "SHA-256 Verification:"} ${data.checksum.slice(0, 16)}...`,
    b.margin,
    b.pageH - 7
  );

  return b.doc.output("arraybuffer") as unknown as Uint8Array;
}