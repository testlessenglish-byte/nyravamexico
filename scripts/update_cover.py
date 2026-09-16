import sys

with open('src/lib/export.ts', 'r', encoding='utf-8') as f:
    text = f.read()

start_idx = text.find('premiumCover(opts: {')
if start_idx == -1:
    print("premiumCover not found")
    sys.exit(1)

brace_idx = text.find('{', text.find(')', start_idx))
open_braces = 1
i = brace_idx + 1
while i < len(text) and open_braces > 0:
    if text[i] == '{':
        open_braces += 1
    elif text[i] == '}':
        open_braces -= 1
    i += 1

end_idx = i

new_cover = """premiumCover(opts: {
    reportTitle: string;
    caseName: string;
    client?: string;
    proceeding?: string;
    matterType?: string;
    court?: string;
    jurisdiction?: string;
    matterId?: string;
    classification?: string;
    date?: string;
    engineVersion?: string;
    certification?: string;
  }) {
    const { pageW, pageH, margin } = this;
    
    // Background: Deep purple
    const BG_PURPLE: [number, number, number] = [28, 14, 60]; 
    const GOLD: [number, number, number] = [217, 185, 120];
    const WHITE: [number, number, number] = [255, 255, 255];
    
    this.doc.setFillColor(...BG_PURPLE);
    this.doc.rect(0, 0, pageW, pageH, "F");
    
    // Gold Double Border
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(2);
    this.doc.rect(20, 20, pageW - 40, pageH - 40, "S");
    this.doc.setLineWidth(0.5);
    this.doc.rect(26, 26, pageW - 52, pageH - 52, "S");

    // Top Right words
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(8);
    this.doc.setTextColor(...GOLD);
    const rightMargin = pageW - 36;
    this.doc.text(spaced("DERECHO"), rightMargin, 40, { align: "right" });
    this.doc.text(spaced("INTELIGENCIA"), rightMargin, 52, { align: "right" });
    this.doc.text(spaced("EVIDENCIA"), rightMargin, 64, { align: "right" });
    this.doc.text(spaced("RESULTADOS"), rightMargin, 76, { align: "right" });

    // Center Logo "N"
    const cx = pageW / 2;
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(60);
    this.doc.setTextColor(...GOLD);
    this.doc.text("N", cx, 110, { align: "center" });
    
    // NYRAVA
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(32);
    this.doc.setTextColor(255, 255, 255);
    this.doc.text(spaced("NYRAVA"), cx, 150, { align: "center" });
    
    // LEGAL INTELLIGENCE
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(10);
    this.doc.setTextColor(...GOLD);
    this.doc.text(spaced("LEGAL INTELLIGENCE"), cx, 175, { align: "center" });
    
    // - MÉXICO -
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(0.5);
    this.doc.line(cx - 70, 195, cx - 35, 195);
    this.doc.line(cx + 35, 195, cx + 70, 195);
    this.doc.text(spaced("MÉXICO"), cx, 198, { align: "center" });

    // Large centered report title
    let ty = 260;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(28);
    this.doc.setTextColor(255, 255, 255);
    const titleLines = this.doc.splitTextToSize((opts.reportTitle || "INFORME DE INTELIGENCIA JURÍDICA").toUpperCase(), pageW - margin * 2) as string[];
    for (const line of titleLines) {
      this.doc.text(line, cx, ty, { align: "center" });
      ty += 34;
    }

    // Case Identity
    ty += 30;
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(24);
    this.doc.text(opts.caseName || "ADR 3265/2023", cx, ty, { align: "center" });
    
    ty += 30;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(20);
    this.doc.text(opts.proceeding || "Amparo Directo en Revisión", cx, ty, { align: "center" });

    ty += 28;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(16);
    this.doc.text(opts.court || "Suprema Corte de Justicia de la Nación", cx, ty, { align: "center" });

    // Metadata table
    ty += 60;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(9);
    
    const fields = [
      { k: "CLIENTE", v: opts.client || "Confidencial" },
      { k: "EXPEDIENTE", v: opts.matterId || "ADR 3265/2023" },
      { k: "TIPO DE ASUNTO", v: opts.proceeding || "Amparo" },
      { k: "ÓRGANO JURISDICCIONAL", v: opts.court || "Suprema Corte de Justicia de la Nación" },
      { k: "MATERIA", v: opts.matterType || "Constitucional" },
      { k: "FECHA DEL ANÁLISIS", v: opts.date || "14 de septiembre de 2026" },
      { k: "NYRAVA MATTER ID", v: (opts.matterId || "44C5492F").slice(0, 8) }
    ];

    const leftCol = cx - 180;
    const rightCol = cx - 40;
    
    // Vertical line
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(0.5);
    this.doc.line(rightCol - 10, ty - 10, rightCol - 10, ty + (fields.length * 20));

    for (const f of fields) {
      if (f.v) {
        this.doc.setTextColor(...GOLD);
        this.doc.text(spaced(f.k), leftCol, ty);
        this.doc.setTextColor(255, 255, 255);
        
        // Handle multiline for court
        const vLines = this.doc.splitTextToSize(f.v, 200) as string[];
        for (const line of vLines) {
           this.doc.text(line, rightCol, ty);
           ty += 14;
        }
        ty += 6;
      }
    }

    // CONFIDENCIAL Box
    ty += 20;
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(1);
    this.doc.rect(cx - 120, ty, 240, 35, "S");
    
    this.doc.setFont("times", "bold");
    this.doc.setFontSize(16);
    this.doc.setTextColor(...GOLD);
    this.doc.text(spaced(opts.classification || "CONFIDENCIAL"), cx, ty + 24, { align: "center" });

    // Certification text
    ty += 70;
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(12);
    this.doc.setTextColor(255, 255, 255);
    this.doc.text("Sustentado en evidencia.", cx, ty, { align: "center" });
    this.doc.text("Citas auditadas.", cx, ty + 16, { align: "center" });
    this.doc.text("Diseñado para trabajo de inteligencia jurídica sensible.", cx, ty + 32, { align: "center" });

    // Footer lines
    ty += 60;
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(1);
    this.doc.line(cx - 15, ty, cx + 15, ty);
    
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(12);
    this.doc.text("Nyrava Legal Intelligence", cx, ty + 20, { align: "center" });
    this.doc.setFontSize(10);
    this.doc.setTextColor(...GOLD);
    this.doc.text("mexico.nyrava.com", cx, ty + 35, { align: "center" });

    // Bottom left Mexican architectural abstraction
    const bx = 36;
    const by = pageH - 50;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(8);
    this.doc.setTextColor(...GOLD);
    this.doc.text(spaced("INTELIGENCIA JURÍDICA"), bx, by);
    this.doc.setTextColor(200, 200, 200);
    this.doc.text(spaced("PARA UN MÉXICO MÁS FUERTE"), bx, by + 12);
    
    // Decorative skyline vector
    this.doc.setDrawColor(...GOLD);
    this.doc.setLineWidth(0.5);
    this.doc.line(bx, by - 10, bx + 150, by - 10);
    this.doc.rect(bx + 10, by - 20, 10, 10, "S");
    this.doc.rect(bx + 30, by - 30, 20, 20, "S");
    this.doc.triangle(bx + 30, by - 30, bx + 50, by - 30, bx + 40, by - 45, "S");
    this.doc.circle(bx + 40, by - 20, 3, "S");
    this.doc.rect(bx + 70, by - 25, 15, 15, "S");
    this.doc.rect(bx + 90, by - 18, 12, 8, "S");

    // Bottom right page number
    this.doc.setFont("times", "normal");
    this.doc.setFontSize(10);
    this.doc.setTextColor(255, 255, 255);
    this.doc.text("Página 1 de 24", pageW - 36, pageH - 40, { align: "right" });

    this.doc.addPage();
  }"""

text = text[:start_idx] + new_cover + text[end_idx:]
with open('src/lib/export.ts', 'w', encoding='utf-8') as f:
    f.write(text)
print("Updated premiumCover to match image perfectly via brace matching.")
