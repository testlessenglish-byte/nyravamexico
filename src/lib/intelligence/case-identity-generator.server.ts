// Automatic Case Identity, Name & Description Generator
//
// Extracts official docket numbers, principal parties, courts, and generates
// professional, verified Case Names and Descriptions following the 7-level
// priority hierarchy while respecting user lock rules.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { ProceduralPosture } from "./procedural-posture";
import type { CaseClassificationResult } from "./case-classification.server";

type Db = SupabaseClient<Database>;

export interface CaseNumberInfo {
  raw: string;
  normalized: string;
  type: string; // e.g. "ADR", "Amparo Directo", "Amparo Indirecto", "Toca Penal", "Causa Penal", "Expediente Laboral", "Expediente"
  isPrimary: boolean;
}

export interface CaseIdentityMetadata {
  original_filename: string | null;
  case_number: string | null;
  case_number_normalized: string | null;
  case_number_type: string | null;
  primary_party_name: string | null;
  primary_party_role: string | null;
  opposing_party_name: string | null;
  court_name: string | null;
  tribunal_level: string | null;
  procedural_vehicle: string | null;
  effective_materia: string | null;
  underlying_materia: string | null;
  jurisdiction: string | null;
  procedural_posture: string | null;
  related_case_numbers: string[];

  // Name metadata
  case_display_name: string | null;
  case_display_name_source: "user" | "generated" | "pending_extraction";
  case_display_name_confidence: number | null;
  case_display_name_locked: boolean;
  case_identity_verified: boolean;

  // Description metadata
  case_description: string | null;
  case_description_source: "user" | "generated" | "pending_extraction";
  case_description_confidence: number | null;
  case_description_locked: boolean;
  case_description_generated_at: string | null;
}

// Regex patterns for Mexican case docket numbers ordered by specificity
const DOCKET_PATTERNS: Array<{ type: string; rx: RegExp; priority: number }> = [
  {
    type: "ADR",
    rx: /\b(?:AMPARO DIRECTO EN REVISI[ÓO]N|A\.?D\.?R\.?)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi,
    priority: 100,
  },
  {
    type: "Amparo en Revisión",
    rx: /\b(?:AMPARO EN REVISI[ÓO]N|A\.?R\.?)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi,
    priority: 90,
  },
  {
    type: "Amparo Directo",
    rx: /\b(?:AMPARO DIRECTO|A\.?D\.?)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi,
    priority: 85,
  },
  {
    type: "Amparo Indirecto",
    rx: /\b(?:AMPARO INDIRECTO|A\.?I\.?)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi,
    priority: 80,
  },
  {
    type: "Controversia Constitucional",
    rx: /\b(?:CONTROVERSIA CONSTITUCIONAL)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi,
    priority: 80,
  },
  {
    type: "Acción de Inconstitucionalidad",
    rx: /\b(?:ACCI[ÓO]N DE INCONSTITUCIONALIDAD)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi,
    priority: 80,
  },
  {
    type: "Toca Penal",
    rx: /\b(?:TOCA\s+PENAL|TOCA)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi,
    priority: 75,
  },
  {
    type: "Causa Penal",
    rx: /\b(?:CAUSA\s+PENAL)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi,
    priority: 70,
  },
  {
    type: "Carpeta de Investigación",
    rx: /\b(?:CARPETA DE INVESTIGACI[ÓO]N|C\.?I\.?)\s+(?:N[ÚU]MERO\s+)?([A-Z0-9/-]+)\b/gi,
    priority: 65,
  },
  {
    type: "Expediente Laboral",
    rx: /\b(?:JUICIO\s+LABORAL|EXPEDIENTE\s+LABORAL)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi,
    priority: 60,
  },
  {
    type: "Expediente",
    rx: /\b(?:EXPEDIENTE|EXP\.?)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi,
    priority: 50,
  },
];

// Titles / roles that should NEVER be used as principal party names
const NON_PARTY_TITLES_RE =
  /\b(juez|jueza|magistrado|magistrada|ministro|ministra|secretario|secretaria|actuario|actuaria|abogado|abogada|defensor|defensora|ministerio\s+p[úu]blico|fiscal|perito|perita|testigo|notario|notaria|polic[ií]a|agente)\b/i;

function cleanName(raw: string): string {
  return raw
    .replace(/^["'«»“”\s]+|["'«»“”\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts and classifies all docket / case numbers in the text.
 */
export function extractCaseNumbers(text: string): CaseNumberInfo[] {
  const hits: Array<CaseNumberInfo & { priority: number }> = [];
  const seenNorm = new Set<string>();

  for (const pat of DOCKET_PATTERNS) {
    const re = new RegExp(pat.rx.source, pat.rx.flags);
    for (const m of text.matchAll(re)) {
      const numRaw = m[1] ?? m[0];
      const normalizedNum = numRaw.replace(/\s+/g, "");
      const fullLabel = `${pat.type} ${normalizedNum}`;
      if (!seenNorm.has(fullLabel)) {
        seenNorm.add(fullLabel);
        hits.push({
          raw: m[0].trim(),
          normalized: fullLabel,
          type: pat.type,
          isPrimary: false,
          priority: pat.priority,
        });
      }
    }
  }

  // Sort highest priority first
  hits.sort((a, b) => b.priority - a.priority);

  if (hits.length > 0) {
    hits[0].isPrimary = true;
  }

  return hits.map(({ priority: _, ...rest }) => rest);
}

/**
 * Extracts the primary party from structured party extractions based on proceeding and materia.
 */
export function extractPrincipalParty(
  partiesJson: string | null | undefined,
  proceedingType: string | null | undefined,
  materia: string | null | undefined,
): { primary: string | null; primaryRole: string | null; opposing: string | null } {
  if (!partiesJson) {
    return { primary: null, primaryRole: null, opposing: null };
  }

  try {
    const list = JSON.parse(partiesJson) as Array<{ role: string; name: string }>;
    if (!Array.isArray(list) || list.length === 0) {
      return { primary: null, primaryRole: null, opposing: null };
    }

    const filtered = list.filter((p) => {
      const name = cleanName(p.name);
      return name.length >= 3 && !NON_PARTY_TITLES_RE.test(name);
    });

    if (filtered.length === 0) {
      return { primary: null, primaryRole: null, opposing: null };
    }

    const proc = (proceedingType ?? "").toLowerCase();
    const mat = (materia ?? "").toLowerCase();

    // Priority party roles by proceeding/materia
    let preferredRoles: string[] = ["QUEJOSO", "QUEJOSA", "ACTOR", "ACTORA", "IMPUTADO", "IMPUTADA", "TRABAJADOR"];
    let opposingRoles: string[] = ["TERCERO INTERESADO", "AUTORIDAD RESPONSABLE", "DEMANDADO", "DEMANDADA", "PATRÓN"];

    if (proc.includes("amparo") || mat === "amparo") {
      preferredRoles = ["QUEJOSO", "QUEJOSA"];
      opposingRoles = ["TERCERO INTERESADO", "AUTORIDAD RESPONSABLE"];
    } else if (mat === "penal") {
      preferredRoles = ["IMPUTADO", "IMPUTADA", "ACUSADO", "ACUSADA", "SENTENCIADO", "SENTENCIADA", "QUEJOSO"];
      opposingRoles = ["VÍCTIMA", "OFENDIDO", "MINISTERIO PÚBLICO"];
    } else if (mat === "laboral") {
      preferredRoles = ["TRABAJADOR", "ACTOR", "ACTORA", "QUEJOSO"];
      opposingRoles = ["DEMANDADO", "DEMANDADA", "PATRÓN", "EMPRESA"];
    } else if (mat === "fiscal") {
      preferredRoles = ["CONTRIBUYENTE", "ACTOR", "ACTORA", "QUEJOSO"];
      opposingRoles = ["AUTORIDAD DEMANDADA", "SAT"];
    } else if (mat === "administrativo") {
      preferredRoles = ["PARTICULAR", "ACTOR", "ACTORA", "QUEJOSO"];
      opposingRoles = ["AUTORIDAD DEMANDADA"];
    }

    let primaryMatch: { role: string; name: string } | null = null;
    for (const r of preferredRoles) {
      const hit = filtered.find((p) => p.role.toUpperCase().includes(r));
      if (hit) {
        primaryMatch = hit;
        break;
      }
    }

    if (!primaryMatch && filtered.length > 0) {
      primaryMatch = filtered[0];
    }

    let opposingMatch: { role: string; name: string } | null = null;
    for (const r of opposingRoles) {
      const hit = filtered.find((p) => p.role.toUpperCase().includes(r) && p.name !== primaryMatch?.name);
      if (hit) {
        opposingMatch = hit;
        break;
      }
    }

    return {
      primary: primaryMatch ? cleanName(primaryMatch.name) : null,
      primaryRole: primaryMatch ? primaryMatch.role : null,
      opposing: opposingMatch ? cleanName(opposingMatch.name) : null,
    };
  } catch {
    return { primary: null, primaryRole: null, opposing: null };
  }
}

/**
 * Generates an automatic case name following the 7-level priority hierarchy.
 */
export function generateAutomaticCaseName(
  identity: {
    case_number?: string | null;
    case_number_normalized?: string | null;
    primary_party_name?: string | null;
    court_name?: string | null;
    procedural_vehicle?: string | null;
    effective_materia?: string | null;
    original_filename?: string | null;
  },
  userCustomName?: string | null,
): { name: string; source: "user" | "generated"; confidence: number; locked: boolean } {
  // Priority 1: Manual user name
  if (userCustomName && userCustomName.trim().length > 0) {
    return {
      name: userCustomName.trim(),
      source: "user",
      confidence: 1.0,
      locked: true,
    };
  }

  const dkt = identity.case_number_normalized || identity.case_number;
  const party = identity.primary_party_name;
  const court = identity.court_name;
  const vehicle = identity.procedural_vehicle;

  // Priority 2: Verified official number + verified primary party
  if (dkt && party) {
    return {
      name: `${dkt} — ${party}`,
      source: "generated",
      confidence: 0.95,
      locked: false,
    };
  }

  // Priority 3: Verified official number + court
  if (dkt && court) {
    const shortCourt = court.includes("SUPREMA CORTE") ? "SCJN" : court.slice(0, 30);
    return {
      name: `${dkt} — ${shortCourt}`,
      source: "generated",
      confidence: 0.9,
      locked: false,
    };
  }

  // Priority 4: Verified official number alone
  if (dkt) {
    return {
      name: dkt,
      source: "generated",
      confidence: 0.85,
      locked: false,
    };
  }

  // Priority 5: Reliable party + proceeding type
  if (party && vehicle) {
    const vehicleLabel = vehicle.replace(/_/g, " ").toUpperCase();
    return {
      name: `${vehicleLabel} — ${party}`,
      source: "generated",
      confidence: 0.75,
      locked: false,
    };
  }

  // Priority 6: Reliable party alone
  if (party) {
    return {
      name: `Caso ${party}`,
      source: "generated",
      confidence: 0.65,
      locked: false,
    };
  }

  // Priority 7: Original filename (fallback)
  if (identity.original_filename) {
    const cleanFile = identity.original_filename
      .replace(/\.[^/.]+$/, "")
      .replace(/^[0-9_]+/, "")
      .replace(/[_-]+/g, " ")
      .trim();
    return {
      name: cleanFile.length > 0 ? cleanFile : identity.original_filename,
      source: "generated",
      confidence: 0.4,
      locked: false,
    };
  }

  return {
    name: "Caso sin identificar",
    source: "generated",
    confidence: 0.1,
    locked: false,
  };
}

/**
 * Generates an automatic 1-3 sentence factual description grounded in verified extracted metadata.
 */
export function generateAutomaticCaseDescription(
  identity: {
    case_number_normalized?: string | null;
    procedural_vehicle?: string | null;
    effective_materia?: string | null;
    underlying_materia?: string | null;
    court_name?: string | null;
    jurisdiction?: string | null;
    primary_party_name?: string | null;
    opposing_party_name?: string | null;
    disposition?: string | null;
    controlling_issues?: string[];
  },
  posture?: ProceduralPosture | null,
  userCustomDesc?: string | null,
): { description: string | null; source: "user" | "generated"; confidence: number; locked: boolean } {
  if (userCustomDesc && userCustomDesc.trim().length > 0) {
    return {
      description: userCustomDesc.trim(),
      source: "user",
      confidence: 1.0,
      locked: true,
    };
  }

  const parts: string[] = [];
  const vehicle = identity.procedural_vehicle
    ? identity.procedural_vehicle.replace(/_/g, " ")
    : identity.effective_materia
      ? `asunto en materia ${identity.effective_materia}`
      : "asunto legal";

  const court = identity.court_name ? ` radicado ante ${identity.court_name}` : "";
  const isConcluded = Boolean(posture?.is_final_resolution || posture?.case_status === "concluded" || posture?.case_status === "remanded");

  // Sentence 1: Proceeding & Jurisdiction
  if (isConcluded) {
    const decision = posture?.decision_type || "resolución judicial";
    parts.push(`Procedimiento de ${vehicle}${court}, tramitado como ${decision}.`);
  } else {
    const stage = posture?.current_stage ? ` en etapa de ${posture.current_stage.replace(/_/g, " ")}` : "";
    parts.push(`Procedimiento en curso de ${vehicle}${court}${stage}.`);
  }

  // Sentence 2: Parties & Underlying Materia
  const partyInfo = identity.primary_party_name
    ? ` Involucra a la parte ${identity.primary_party_name}${identity.opposing_party_name ? ` frente a ${identity.opposing_party_name}` : ""}.`
    : "";
  const materiaInfo = identity.underlying_materia
    ? ` La materia sustantiva de origen corresponde a derecho ${identity.underlying_materia}.`
    : "";
  if (partyInfo || materiaInfo) {
    parts.push(`${partyInfo}${materiaInfo}`.trim());
  }

  // Sentence 3: Disposition (concluded only)
  if (isConcluded && posture?.remand_ordered) {
    parts.push("La resolución ordena la revocación o reposición con devolución de autos para nuevo pronunciamiento.");
  } else if (isConcluded && identity.disposition) {
    parts.push(`Resolutivo emitido: ${identity.disposition.slice(0, 150)}.`);
  }

  const fullDescription = parts.join(" ").replace(/\s+/g, " ").trim();

  return {
    description: fullDescription.length > 0 ? fullDescription : null,
    source: "generated",
    confidence: fullDescription.length > 0 ? 0.85 : 0,
    locked: false,
  };
}

/**
 * Extracts and updates case identity, name, and description after document extraction.
 */
export async function applyAutomaticCaseIdentity(
  db: Db,
  caseId: string,
  docs: Array<{ id: string; filename: string; extracted_text: string | null }>,
  classificationResult?: CaseClassificationResult | null,
  posture?: ProceduralPosture | null,
): Promise<CaseIdentityMetadata> {
  const { data: caseRow } = await db
    .from("cases")
    .select("name,description,case_type,jurisdiction,procedural_vehicle,underlying_materia,matter_metadata")
    .eq("id", caseId)
    .maybeSingle();

  const mm = ((caseRow as any)?.matter_metadata as Record<string, unknown> | null) ?? {};
  const existingIdentity = (mm.case_identity as CaseIdentityMetadata | undefined) ?? null;

  const corpus = docs.map((d) => d.extracted_text ?? "").join("\n");
  const extractedNumbers = extractCaseNumbers(corpus);
  const primaryNumber = extractedNumbers.find((n) => n.isPrimary) ?? extractedNumbers[0] ?? null;
  const relatedNumbers = extractedNumbers.filter((n) => n !== primaryNumber).map((n) => n.normalized);

  const partiesField = classificationResult?.fields.find((f) => f.field === "parties")?.value;
  const courtField = classificationResult?.fields.find((f) => f.field === "court")?.value;
  const vehicleField = classificationResult?.fields.find((f) => f.field === "procedural_vehicle")?.value;
  const materiaField = (caseRow as any)?.case_type ?? classificationResult?.fields.find((f) => f.field === "case_type")?.value;
  const underlyingField = (caseRow as any)?.underlying_materia ?? classificationResult?.fields.find((f) => f.field === "underlying_materia")?.value;
  const jurisdictionField = (caseRow as any)?.jurisdiction ?? classificationResult?.fields.find((f) => f.field === "jurisdiction")?.value;

  const partyExtraction = extractPrincipalParty(partiesField, vehicleField, materiaField);

  // Check if name or description are user-locked
  const isNameLocked = Boolean(existingIdentity?.case_display_name_locked);
  const isDescLocked = Boolean(existingIdentity?.case_description_locked);

  const userCustomName = isNameLocked ? (caseRow as any)?.name ?? existingIdentity?.case_display_name : null;
  const userCustomDesc = isDescLocked ? (caseRow as any)?.description ?? existingIdentity?.case_description : null;

  const nameGen = generateAutomaticCaseName(
    {
      case_number: primaryNumber?.raw ?? null,
      case_number_normalized: primaryNumber?.normalized ?? null,
      primary_party_name: partyExtraction.primary,
      court_name: courtField ?? null,
      procedural_vehicle: vehicleField ?? null,
      effective_materia: materiaField ?? null,
      original_filename: docs[0]?.filename ?? null,
    },
    userCustomName,
  );

  const descGen = generateAutomaticCaseDescription(
    {
      case_number_normalized: primaryNumber?.normalized ?? null,
      procedural_vehicle: vehicleField ?? null,
      effective_materia: materiaField ?? null,
      underlying_materia: underlyingField ?? null,
      court_name: courtField ?? null,
      jurisdiction: jurisdictionField ?? null,
      primary_party_name: partyExtraction.primary,
      opposing_party_name: partyExtraction.opposing,
    },
    posture,
    userCustomDesc,
  );

  const updatedIdentity: CaseIdentityMetadata = {
    original_filename: docs[0]?.filename ?? existingIdentity?.original_filename ?? null,
    case_number: primaryNumber?.raw ?? existingIdentity?.case_number ?? null,
    case_number_normalized: primaryNumber?.normalized ?? existingIdentity?.case_number_normalized ?? null,
    case_number_type: primaryNumber?.type ?? existingIdentity?.case_number_type ?? null,
    primary_party_name: partyExtraction.primary ?? existingIdentity?.primary_party_name ?? null,
    primary_party_role: partyExtraction.primaryRole ?? existingIdentity?.primary_party_role ?? null,
    opposing_party_name: partyExtraction.opposing ?? existingIdentity?.opposing_party_name ?? null,
    court_name: courtField ?? existingIdentity?.court_name ?? null,
    tribunal_level: posture?.court_level ?? existingIdentity?.tribunal_level ?? null,
    procedural_vehicle: vehicleField ?? (caseRow as any)?.procedural_vehicle ?? null,
    effective_materia: materiaField ?? null,
    underlying_materia: underlyingField ?? null,
    jurisdiction: jurisdictionField ?? null,
    procedural_posture: posture?.case_status ?? null,
    related_case_numbers: relatedNumbers.length > 0 ? relatedNumbers : (existingIdentity?.related_case_numbers ?? []),

    case_display_name: nameGen.name,
    case_display_name_source: nameGen.source,
    case_display_name_confidence: nameGen.confidence,
    case_display_name_locked: nameGen.locked,
    case_identity_verified: Boolean(primaryNumber || partyExtraction.primary),

    case_description: descGen.description,
    case_description_source: descGen.source,
    case_description_confidence: descGen.confidence,
    case_description_locked: descGen.locked,
    case_description_generated_at: new Date().toISOString(),
  };

  const patch: Record<string, unknown> = {
    matter_metadata: {
      ...mm,
      case_identity: updatedIdentity,
    },
  };

  if (!isNameLocked && nameGen.name) {
    patch.name = nameGen.name;
  }

  if (!isDescLocked && descGen.description) {
    patch.description = descGen.description;
  }

  await db.from("cases").update(patch as any).eq("id", caseId);

  return updatedIdentity;
}
