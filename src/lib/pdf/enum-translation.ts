export function translateLegalTerm(term: string | null | undefined): string {
  if (!term) return "";
  const t = term.trim().toLowerCase();
  
  const dict: Record<string, string> = {
    "tribunal_colegiado": "Tribunal Colegiado",
    "juzgado_distrito": "Juzgado de Distrito",
    "scjn": "Suprema Corte de Justicia de la Nación",
    "unresolved": "No Resuelto",
    "amparo_indirecto": "Amparo Indirecto",
    "amparo_directo": "Amparo Directo",
    "penal": "Penal",
    "civil": "Civil",
    "mercantil": "Mercantil",
    "laboral": "Laboral",
    "administrativo": "Administrativo",
    "quejoso": "Quejoso",
    "tercero_interesado": "Tercero Interesado",
    "autoridad_responsable": "Autoridad Responsable",
    "intel-v2": "Motor v2.0",
    "intel-v1": "Motor v1.0"
  };

  return dict[t] || term;
}
