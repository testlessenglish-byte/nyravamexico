import re

with open('src/lib/export.ts', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Strip out the lady justice background
text = re.sub(r'    // Lady Justice background.*?this\.doc\.addImage\(bgB64, "JPEG", 0, 0, pageW, pageH\);', '', text, flags=re.DOTALL)

# 2. Update PRIMARY and BG_PURPLE to [124, 58, 237]
text = re.sub(r'const PRIMARY: \[number, number, number\] = \[\d+, \d+, \d+\];', 'const PRIMARY: [number, number, number] = [124, 58, 237];', text)
text = re.sub(r'const BG_PURPLE: \[number, number, number\] = \[\d+, \d+, \d+\];', 'const BG_PURPLE: [number, number, number] = [124, 58, 237];', text)

# 3. Add text wrapping for Case Identity
start = text.find('// Case Identity')
end = text.find('// Metadata table', start)
if start != -1 and end != -1:
    new_identity = """// Case Identity
    ty += 30;
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(24);
    const caseNameLines = this.doc.splitTextToSize(opts.caseName || "ADR 3265/2023", pageW - margin * 2) as string[];
    for (const line of caseNameLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += 28;
    }
    
    ty += 2;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(20);
    const proceedingLines = this.doc.splitTextToSize(opts.proceeding || "Amparo Directo en Revisión", pageW - margin * 2) as string[];
    for (const line of proceedingLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += 24;
    }

    ty += 4;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(16);
    const courtLines = this.doc.splitTextToSize(opts.court || "Suprema Corte de Justicia de la Nación", pageW - margin * 2) as string[];
    for (const line of courtLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += 20;
    }

    """
    text = text[:start] + new_identity + text[end:]

with open('src/lib/export.ts', 'w', encoding='utf-8') as f:
    f.write(text)
print("Updated export.ts perfectly.")
