import { rt } from "../../report-i18n";
import { PdfBuilder } from "../../export";
import { translateLegalTerm } from "../../pdf/enum-translation";

export interface AuditReportData {
  report_id: string;
  case_id: string;
  requester_name: string;
  requester_role: string;
  requested_at: string;
  reason: string;
  classification: "internal" | "confidential" | "restricted" | "external_distribution";
  findings: Array<{
    category: string;
    description: string;
    severity: "low" | "medium" | "high" | "critical";
  }>;
  checksum: string;
}

export async function generateAuditReportPdf(data: AuditReportData, locale: "en" | "es" = "en"): Promise<Uint8Array> {
  const isEs = locale === "es";

  // Use the centralized PdfBuilder
  const b = new PdfBuilder("Audit Report", data.case_id.slice(0, 8));

  const classLabel = {
    internal: isEs ? "USO INTERNO" : "INTERNAL USE ONLY",
    confidential: isEs ? "CONFIDENCIAL" : "CONFIDENTIAL",
    restricted: isEs ? "RESTRINGIDO" : "RESTRICTED",
    external_distribution: isEs ? "DISTRIBUCIÓN EXTERNA" : "EXTERNAL DISTRIBUTION",
  }[data.classification];

  b.premiumCover({
    reportTitle: isEs ? "INFORME DE AUDITORÍA" : "AUDIT REPORT",
    caseName: `Audit for Case: ${data.case_id}`,
    client: undefined,
    proceeding: undefined,
    matterType: undefined,
    court: undefined,
    jurisdiction: undefined,
    matterId: data.case_id,
    classification: classLabel,
    date: new Date(data.requested_at).toLocaleDateString(isEs ? "es-MX" : "en-US"),
    engineVersion: undefined,
    certification: "verified",
  });

  b.h1(isEs ? "Registro de Auditoría" : "Audit Log");
  b.text(`${isEs ? "Solicitante:" : "Requester:"} ${data.requester_name} (${data.requester_role})`, { bold: true });
  b.text(`${isEs ? "Motivo:" : "Reason:"} ${data.reason}`);
  b.text(`${isEs ? "Suma de control:" : "Checksum:"} ${data.checksum}`);
  b.divider();

  if (data.findings && data.findings.length > 0) {
    b.h2(isEs ? "Hallazgos de Auditoría" : "Audit Findings");
    const rows = data.findings.map((f) => [
      f.severity.toUpperCase(),
      translateLegalTerm(f.category),
      f.description
    ]);
    b.table([[isEs ? "Severidad" : "Severity", isEs ? "Categoría" : "Category", isEs ? "Descripción" : "Description"]], rows, { columnStyles: {0: {'cellWidth': 60}, 1: {'cellWidth': 100}, 2: {'cellWidth': 300}} });
  } else {
    b.text(isEs ? "No se registraron hallazgos durante esta auditoría." : "No findings recorded during this audit.");
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
