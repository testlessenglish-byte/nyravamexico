import sys
import re

with open('src/lib/export.ts', 'r', encoding='utf-8') as f:
    text = f.read()

# Grab constants
match = re.search(r'// ---- Design tokens.*?const CARD_BORDER.*?;\n', text, re.DOTALL)
colors = match.group(0) if match else ''

match2 = re.search(r'const SEVERITY_TIERS.*?;\n', text, re.DOTALL)
sev = match2.group(0) if match2 else ''

match3 = re.search(r'function severityTierKey.*?}\n', text, re.DOTALL)
sev_key = match3.group(0) if match3 else ''

match4 = re.search(r'function confidenceLabel.*?}\n', text, re.DOTALL)
conf = match4.group(0) if match4 else ''

match5 = re.search(r'function evidenceStrengthLabel.*?}\n', text, re.DOTALL)
evid = match5.group(0) if match5 else ''

match6 = re.search(r'const NAVY_TINT.*?CONTINUATION_HEADER_H = 50;\n', text, re.DOTALL)
navy = match6.group(0) if match6 else ''

match7 = re.search(r'function spaced.*?}\n', text, re.DOTALL)
spaced = match7.group(0) if match7 else ''

match8 = re.search(r'function asStr.*?}\n', text, re.DOTALL)
asstr = match8.group(0) if match8 else ''

match9 = re.search(r'function asArr.*?}\n', text, re.DOTALL)
asarr = match9.group(0) if match9 else ''

match10 = re.search(r'function pdfSafe.*?}\n', text, re.DOTALL)
pdfsafe = match10.group(0) if match10 else ''

imports = """import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { rt } from "../report-i18n";
import { FinalReportPayload } from "../reporting/final-report-contract";
import { CertificationState } from "../export";
import { classifyClaim, CLAIM_LABEL } from "@/lib/intelligence/claim-class";
export type Pdf = jsPDF & { lastAutoTable?: { finalY: number } };
"""

with open('src/lib/pdf/report-builder.ts', 'r', encoding='utf-8') as f:
    builder_code = f.read()

full_code = imports + '\n' + pdfsafe + '\n' + colors + '\n' + sev + '\n' + sev_key + '\n' + conf + '\n' + evid + '\n' + navy + '\n' + spaced + '\n' + asstr + '\n' + asarr + '\n' + builder_code

full_code = full_code.replace('await getLogoBase64()', 'Promise.resolve(null)')
full_code = full_code.replace('class PdfBuilder {', 'export class PdfBuilder {')

with open('src/lib/pdf/report-builder.ts', 'w', encoding='utf-8') as f:
    f.write(full_code)
