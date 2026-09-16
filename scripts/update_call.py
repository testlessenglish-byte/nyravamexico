import sys
import re

with open('src/lib/export.ts', 'r', encoding='utf-8') as f:
    text = f.read()

old_call = """b.premiumCover({
    caseName: asStr(c.name, "Untitled Case"),
    description: asStr(c.description) || undefined,
    engineVersion: asStr(r.intelligence_version) || undefined,
    matterId: asStr(c.id).slice(0, 8).toUpperCase() || undefined,
    certification: deriveCertificationState(data),
  });"""

new_call = """b.premiumCover({
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

text = text.replace(old_call, new_call)
with open('src/lib/export.ts', 'w', encoding='utf-8') as f:
    f.write(text)
print("Updated premiumCover call.")
