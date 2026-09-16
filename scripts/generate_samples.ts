import { PdfBuilder } from "../src/lib/export";
import * as fs from "fs";

function save(b: PdfBuilder, name: string) {
  // @ts-ignore
  const buf = Buffer.from(b.doc.output("arraybuffer"));
  fs.writeFileSync(name, buf);
  console.log(`Saved ${name}`);
}

const longText = "Este es un párrafo de texto extremadamente largo diseñado específicamente para probar los límites del motor de renderizado del documento PDF. Queremos asegurarnos de que el texto se envuelva correctamente y no se desborde fuera de los márgenes especificados, manteniendo siempre el diseño premium y la legibilidad requerida para un informe de inteligencia jurídica de esta magnitud. ".repeat(40);

function generateSamples() {
  // 1. Amparo
  const b1 = new PdfBuilder("Amparo Sample", "AMP-2026-001");
  b1.premiumCover({
    reportTitle: "INFORME DE INTELIGENCIA JURÍDICA",
    caseName: "Juan Pérez vs. Secretaría de Hacienda",
    client: "Juan Pérez",
    proceeding: "Amparo Indirecto",
    matterType: "Administrativo",
    court: "Juzgado Primero de Distrito",
    jurisdiction: "Federal",
    matterId: "AMP-2026-001",
    classification: "CONFIDENCIAL",
    date: "15/09/2026",
    engineVersion: "Motor v1.0.0",
    certification: "verified"
  });
  b1.h1("Resumen de Amparo");
  b1.text("El acto reclamado consiste en la orden de clausura...");
  save(b1, "Sample_Amparo.pdf");

  // 2. Penal
  const b2 = new PdfBuilder("Penal Sample", "PEN-2026-002");
  b2.premiumCover({
    reportTitle: "INFORME DE INTELIGENCIA JURÍDICA",
    caseName: "Estado vs. Corporación XYZ",
    client: "Corporación XYZ",
    proceeding: "Proceso Penal Acusatorio",
    matterType: "Penal",
    court: "Juez de Control",
    jurisdiction: "Estatal",
    matterId: "PEN-2026-002",
    classification: "CONFIDENCIAL",
    date: "15/09/2026"
  });
  b2.h1("Resumen Penal");
  save(b2, "Sample_Penal.pdf");

  // 3. Civil/Mercantil
  const b3 = new PdfBuilder("Mercantil Sample", "MER-2026-003");
  b3.premiumCover({
    reportTitle: "INFORME DE INTELIGENCIA JURÍDICA",
    caseName: "Empresa A vs. Empresa B",
    client: "Empresa A",
    proceeding: "Juicio Ejecutivo Mercantil",
    matterType: "Mercantil",
    court: "Juzgado 14 Civil",
    jurisdiction: "CDMX",
    matterId: "MER-2026-003",
    classification: "CONFIDENCIAL"
  });
  save(b3, "Sample_Mercantil.pdf");

  // 4. Non-litigation
  const b4 = new PdfBuilder("Compliance Sample", "COMP-2026-004");
  b4.premiumCover({
    reportTitle: "INFORME DE CUMPLIMIENTO",
    caseName: "Auditoría Interna Q3",
    client: "Grupo Financiero",
    proceeding: "Auditoría Corporativa",
    matterType: "Corporativo",
    matterId: "COMP-2026-004",
    classification: "USO INTERNO"
  });
  save(b4, "Sample_Compliance.pdf");

  // 5. Extreme Length
  const b5 = new PdfBuilder("Extreme Overflow Test", "EXT-2026-005");
  b5.premiumCover({
    reportTitle: "PRUEBA DE ESTRÉS DE CONTENIDO EXTREMO",
    caseName: "Prueba de Desbordamiento de Texto",
    classification: "CONFIDENCIAL"
  });
  b5.h1("Prueba de Desbordamiento");
  b5.text(longText);
  b5.text(longText, { bold: true });
  save(b5, "Sample_Extreme_Length.pdf");
}

generateSamples();
