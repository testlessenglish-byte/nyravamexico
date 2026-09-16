import re

with open('src/lib/social/reports/audit-report-pdf.server.ts', 'r', encoding='utf-8') as f:
    text = f.read()

correct_interface = """export interface AuditReportData {
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
}"""

text = re.sub(r'export interface AuditReportData \{.*?^\}', correct_interface, text, flags=re.DOTALL|re.MULTILINE)

with open('src/lib/social/reports/audit-report-pdf.server.ts', 'w', encoding='utf-8') as f:
    f.write(text)
print('Fixed AuditReportData interface completely.')
