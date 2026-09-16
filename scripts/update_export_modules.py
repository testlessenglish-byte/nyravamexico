import sys

with open('src/lib/export.ts', 'r', encoding='utf-8') as f:
    text = f.read()

imports = """import { translateLegalTerm } from "./pdf/enum-translation";
import { resolveReportIdentity } from "./pdf/identity-resolver";
"""

if "enum-translation" not in text:
    text = imports + text

old_call = """b.premiumCover({
    reportTitle: "INFORME DE INTELIGENCIA JURÍDICA",
    caseName: asStr(c.name, "Untitled Case"),
    client: asStr(c.client_name) || undefined,
    proceeding: asStr(c.proceeding_type) || undefined,
    matterType: asStr(c.materia) || undefined,
    court: asStr(c.court_name) || undefined,
    jurisdiction: asStr(c.jurisdiction) || undefined,
    matterId: asStr(c.case_number) || asStr(c.id).slice(0, 8).toUpperCase() || undefined,
    classification: "CONFIDENCIAL",
    date: new Date().toLocaleDateString("es-MX"),
    engineVersion: asStr(r.intelligence_version) || undefined,
    certification: deriveCertificationState(data),
  });"""

new_call = """const identity = resolveReportIdentity(c);
  b.premiumCover({
    reportTitle: "INFORME DE INTELIGENCIA JURÍDICA",
    caseName: asStr(c.name, "Untitled Case"),
    client: identity.client,
    proceeding: translateLegalTerm(identity.proceedingType),
    matterType: translateLegalTerm(asStr(c.materia)),
    court: translateLegalTerm(asStr(c.court_name)),
    jurisdiction: translateLegalTerm(asStr(c.jurisdiction)),
    matterId: identity.caseNumber,
    classification: "CONFIDENCIAL",
    date: new Date().toLocaleDateString("es-MX"),
    engineVersion: translateLegalTerm(asStr(r.intelligence_version)),
    certification: deriveCertificationState(data),
  });"""

text = text.replace(old_call, new_call)

with open('src/lib/export.ts', 'w', encoding='utf-8') as f:
    f.write(text)
print("Updated export.ts with new modules.")
