export function translateLegalTerm(term: string | null | undefined): string {
  if (!term) return "";
  const t = term.trim().toLowerCase();

  const dict: Record<string, string> = {
    tribunal_colegiado: "Tribunal Colegiado de Circuito",
    tribunal_unitario: "Tribunal Unitario de Circuito",
    tribunal_colegiado_apelacion: "Tribunal Colegiado de Apelación",
    juzgado_distrito: "Juzgado de Distrito",
    scjn: "Suprema Corte de Justicia de la Nación",
    unresolved: "No Resuelto",
    amparo_indirecto: "Amparo Indirecto",
    amparo_directo: "Amparo Directo",
    amparo_revision: "Amparo en Revisión",
    amparo: "Amparo",
    penal: "Penal",
    civil: "Civil",
    mercantil: "Mercantil",
    laboral: "Laboral",
    familiar: "Familiar",
    administrativo: "Administrativo",
    fiscal: "Fiscal",
    electoral: "Electoral",
    agrario: "Agrario",
    constitucional: "Constitucional",
    ambiental: "Ambiental",
    inmobiliario: "Inmobiliario",
    migratorio: "Migratorio",
    federal: "Federal",
    estatal: "Estatal",
    local: "Local",
    comun: "Fuero Común",
    municipal: "Municipal",
    quejoso: "Quejoso",
    tercero_interesado: "Tercero Interesado",
    autoridad_responsable: "Autoridad Responsable",
    "intel-v2": "Motor v2.0",
    "intel-v1": "Motor v1.0",
  };

  return dict[t] || term;
}
