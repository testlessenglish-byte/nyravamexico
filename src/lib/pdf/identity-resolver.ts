/**
 * Resolves the safe identity and client metadata for a case.
 * Enforces the rule: NEVER assume a litigant role (quejoso, recurrente) is the firm's client.
 * Only use explicitly stored Nyrava client information.
 */
export function resolveReportIdentity(caseData: Record<string, any>) {
  // Safe extraction of the explicitly stored client
  const clientName = (caseData.client_name || caseData.account_client) as string | undefined;
  
  // Do NOT fallback to finding "quejoso" or "actor" in parties list if client is missing!
  const safeClient = clientName ? clientName.trim() : undefined;

  const caseNumber = String(
    caseData.case_number || caseData.expediente || caseData.id?.substring(0, 8) || "SIN_EXPEDIENTE",
  );
  const proceedingType = (caseData.proceeding_type || caseData.tipo_juicio) as string | undefined;

  // Generate safe filename
  const parts = [];
  if (safeClient) parts.push(safeClient.replace(/[^a-zA-Z0-9]/g, "_"));
  parts.push(caseNumber.replace(/[^a-zA-Z0-9]/g, "_"));
  if (proceedingType) parts.push(proceedingType.replace(/[^a-zA-Z0-9]/g, "_"));

  const filename = `Reporte_${parts.join("_")}.pdf`;

  return {
    client: safeClient,
    caseNumber,
    proceedingType,
    filename
  };
}
