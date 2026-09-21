import { IMMIGRATION_SUBTYPES, IMMIGRATION_AUTHORITIES } from "./immigration";

export type ImmigrationSubtypeDetection = {
  key: string | null;
  label_es: string;
  label_en: string;
  status: "CONFIRMED" | "INSUFFICIENT_DATA";
  confidence: number | null;
  source_quote: string | null;
  source_type: "user_provided" | "system_detected" | "not_determined";
};

export type ImmigrationAuthorityDetection = {
  key: string | null;
  label: string;
  status: "CONFIRMED" | "INSUFFICIENT_DATA";
  source_type: "user_provided" | "system_detected" | "not_determined";
};

export type ImmigrationPostureDetection = {
  label: string;
  status: "CONFIRMED" | "INSUFFICIENT_DATA";
  source_type: "user_provided" | "system_detected" | "not_determined";
};

export type ImmigrationAutoClassificationResult = {
  subtype: ImmigrationSubtypeDetection;
  authority: ImmigrationAuthorityDetection;
  procedural_posture: ImmigrationPostureDetection;
  extracted_metadata: {
    client_name: string | null;
    nationality: string | null;
    passport_number: string | null;
    current_condition_of_stay: string | null;
    requested_benefit: string | null;
  };
};

/**
 * Weighted signal rules for the 73 canonical Mexican immigration/refugee/nationality subtypes.
 */
const SUBTYPE_SIGNALS: Record<string, Array<[RegExp, number]>> = {
  visa_ingreso: [
    [/\bvisa\s+de\s+ingreso\b|\bautorizaci[oó]n\s+de\s+ingreso\b|\bvisa\s+consular\b/gi, 3],
    [/\bsolicitud\s+de\s+visa\b|\bexpedici[oó]n\s+de\s+visa\b/gi, 2],
  ],
  residencia_temporal: [
    [/\bresidencia\s+temporal\b|\btarjeta\s+de\s+residente\s+temporal\b/gi, 3],
    [/\bcondici[oó]n\s+de\s+estancia\s+de\s+residente\s+temporal\b/gi, 3],
  ],
  residencia_permanente: [
    [/\bresidencia\s+permanente\b|\btarjeta\s+de\s+residente\s+permanente\b/gi, 3],
    [/\bcondici[oó]n\s+de\s+estancia\s+de\s+residente\s+permanente\b/gi, 3],
  ],
  canje_visa: [
    [/\bcanje\s+de\s+visa\b|\bcanje\s+por\s+tarjeta\b/gi, 3],
    [/\bplazo\s+de\s+30\s+d[ií]as\s+para\s+canje\b/gi, 2],
  ],
  renovacion_migratoria: [
    [/\brenovaci[oó]n\s+migratoria\b|\brenovaci[oó]n\s+de\s+tarjeta\b|\brenovaci[oó]n\s+de\s+residencia\b/gi, 3],
    [/\bpr[oó]rroga\s+de\s+estancia\b/gi, 2],
  ],
  reposicion_documento: [
    [/\breposici[oó]n\s+de\s+documento\b|\brobo\s+o\s+extrav[ií]o\s+de\s+tarjeta\b/gi, 3],
    [/\breposici[oó]n\s+de\s+tarjeta\s+migratoria\b/gi, 3],
  ],
  permiso_salida_regreso: [
    [/\bpermiso\s+de\s+salida\s+y\s+regreso\b|\bautorizaci[oó]n\s+para\s+salir\s+del\s+pa[ií]s\b/gi, 3],
  ],
  cambio_condicion_estancia: [
    [/\bcambio\s+de\s+condici[oó]n\s+de\s+estancia\b|\bcambio\s+a\s+residente\b/gi, 3],
  ],
  permiso_trabajo: [
    [/\bpermiso\s+para\s+trabajar\b|\bautorizaci[oó]n\s+para\s+trabajar\b|\bactividades\s+remuneradas\b/gi, 3],
  ],
  cambio_empleador: [
    [/\bcambio\s+de\s+empleador\b|\bnotificaci[oó]n\s+de\s+cambio\s+de\s+patr[oó]n\b/gi, 3],
  ],
  unidad_familiar: [
    [/\bunidad\s+familiar\b|\bv[ií]nculo\s+familiar\b|\bvinculaci[oó]n\s+familiar\b/gi, 3],
  ],
  regularizacion: [
    [/\bregularizaci[oó]n\s+migratoria\b|\bsolicitud\s+de\s+regularizaci[oó]n\b/gi, 3],
  ],
  correccion_datos: [
    [/\bcorrecci[oó]n\s+de\s+datos\b|\brectificaci[oó]n\s+de\s+nombre\b|\baclaraci[oó]n\s+de\s+datos\b/gi, 3],
  ],
  negativa_tramite: [
    [/\bnegativa\s+de\s+tr[aá]mite\b|\bse\s+niega\s+el\s+tr[aá]mite\b|\bresoluci[oó]n\s+desfavorable\b/gi, 3],
  ],
  cancelacion_estancia: [
    [/\bcancelaci[oó]n\s+de\s+condici[oó]n\s+de\s+estancia\b|\bextinci[oó]n\s+de\s+residencia\b/gi, 3],
  ],
  constancia_empleador: [
    [/\bconstancia\s+de\s+inscripci[oó]n\s+de\s+empleador\b|\bregistro\s+de\s+empleador\s+ante\s+inm\b/gi, 3],
  ],
  actualizacion_empleador: [
    [/\bactualizaci[oó]n\s+de\s+constancia\s+de\s+empleador\b/gi, 3],
  ],
  oferta_empleo: [
    [/\boferta\s+de\s+empleo\b|\bcarta\s+oferta\s+de\s+trabajo\b/gi, 3],
  ],
  verificacion_empleador: [
    [/\bverificaci[oó]n\s+migratoria\s+de\s+empleador\b|\binspecci[oó]n\s+al\s+patr[oó]n\b/gi, 3],
  ],
  visita_verificacion: [
    [/\bvisita\s+de\s+verificaci[oó]n\s+migratoria\b|\bacta\s+de\s+verificaci[oó]n\b/gi, 3],
  ],
  estacion_migratoria: [
    [/\bestaci[oó]n\s+migratoria\b|\bestancia\s+provisional\b|\bdetenci[oó]n\s+en\s+estaci[oó]n\b/gi, 3],
  ],
  deportacion: [
    [/\bdeportaci[oó]n\b|\borden\s+de\s+deportaci[oó]n\b|\bprocedimiento\s+de\s+deportaci[oó]n\b/gi, 3],
  ],
  refugio: [
    [/\bCOMAR\b|\bcondici[oó]n\s+de\s+refugiado\b|\bsolicitante\s+de\s+refugio\b|\basilo\s+pol[ií]tico\b/gi, 3],
  ],
  proteccion_complementaria: [
    [/\bprotecci[oó]n\s+complementaria\b/gi, 3],
  ],
  razones_humanitarias: [
    [/\brazones\s+humanitarias\b|\bvisitante\s+por\s+razones\s+humanitarias\b/gi, 3],
  ],
  naturalizacion: [
    [/\bnaturalizaci[oó]n\b|\bcarta\s+de\s+naturalizaci[oó]n\b|\bSRE\b/gi, 3],
  ],
  doble_nacionalidad: [
    [/\bdoble\s+nacionalidad\b|\bdeclaratoria\s+de\s+nacionalidad\b/gi, 3],
  ],
  amparo_refugio: [
    [/\bamparo\s+(?:indirecto|directo)\s+en\s+materia\s+de\s+refugio\b|\bamparo\s+contra\s+inm\b|\bamparo\s+contra\s+comar\b/gi, 3],
  ],
};

/**
 * Classifies an immigration case from uploaded text documents.
 */
export function classifyImmigrationFromDocuments(
  docs: Array<{ id?: string; filename?: string; extracted_text: string | null }>,
  userProvidedSubtype?: string | null,
): ImmigrationAutoClassificationResult {
  const corpus = docs
    .map((d) => d.extracted_text ?? "")
    .filter((t) => t.trim().length > 0)
    .join("\n\n");

  // 1. Subtype Determination
  let subtypeResult: ImmigrationSubtypeDetection;

  if (userProvidedSubtype && userProvidedSubtype.trim()) {
    const matchedRow = IMMIGRATION_SUBTYPES.find(([k]) => k === userProvidedSubtype.trim());
    subtypeResult = {
      key: userProvidedSubtype.trim(),
      label_es: matchedRow ? matchedRow[1] : userProvidedSubtype.trim(),
      label_en: matchedRow ? matchedRow[2] : userProvidedSubtype.trim(),
      status: "CONFIRMED",
      confidence: 1.0,
      source_quote: null,
      source_type: "user_provided",
    };
  } else if (!corpus.trim()) {
    subtypeResult = {
      key: null,
      label_es: "No determinado a partir de los documentos",
      label_en: "Not determined from documents",
      status: "INSUFFICIENT_DATA",
      confidence: null,
      source_quote: null,
      source_type: "not_determined",
    };
  } else {
    // Score all subtypes
    let bestKey: string | null = null;
    let bestScore = 0;
    let bestQuote: string | null = null;

    for (const [key, rules] of Object.entries(SUBTYPE_SIGNALS)) {
      let score = 0;
      let matchedQuote: string | null = null;
      for (const [re, weight] of rules) {
        const matches = corpus.match(re);
        if (matches && matches.length > 0) {
          score += weight * matches.length;
          if (!matchedQuote) matchedQuote = matches[0];
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
        bestQuote = matchedQuote;
      }
    }

    // Fallback search across all 73 subtypes by string matching if rule table had no hit
    if (!bestKey && corpus.trim()) {
      for (const [key, esLabel, enLabel] of IMMIGRATION_SUBTYPES) {
        const esMatch = new RegExp(`\\b${esLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(corpus);
        const enMatch = new RegExp(`\\b${enLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(corpus);
        if (esMatch || enMatch) {
          bestKey = key;
          bestScore = 2;
          bestQuote = (esMatch || enMatch)![0];
          break;
        }
      }
    }

    if (bestKey && bestScore > 0) {
      const matchedRow = IMMIGRATION_SUBTYPES.find(([k]) => k === bestKey);
      subtypeResult = {
        key: bestKey,
        label_es: matchedRow ? matchedRow[1] : bestKey,
        label_en: matchedRow ? matchedRow[2] : bestKey,
        status: "CONFIRMED",
        confidence: Math.min(0.95, 0.5 + bestScore * 0.1),
        source_quote: bestQuote,
        source_type: "system_detected",
      };
    } else {
      subtypeResult = {
        key: null,
        label_es: "No determinado a partir de los documentos",
        label_en: "Not determined from documents",
        status: "INSUFFICIENT_DATA",
        confidence: null,
        source_quote: null,
        source_type: "not_determined",
      };
    }
  }

  // 2. Authority Determination
  let authorityResult: ImmigrationAuthorityDetection;
  if (/COMAR|Comisi[oó]n\s+Mexicana\s+de\s+Ayuda\s+a\s+Refugiados/i.test(corpus)) {
    authorityResult = {
      key: "comar",
      label: IMMIGRATION_AUTHORITIES.comar.label,
      status: "CONFIRMED",
      source_type: "system_detected",
    };
  } else if (/SRE|Secretar[ií]a\s+de\s+Relaciones\s+Exteriores|consulado/i.test(corpus)) {
    authorityResult = {
      key: "sre",
      label: IMMIGRATION_AUTHORITIES.sre.label,
      status: "CONFIRMED",
      source_type: "system_detected",
    };
  } else if (/TFJA|Tribunal\s+Federal\s+de\s+Justicia\s+Administrativa/i.test(corpus)) {
    authorityResult = {
      key: "tfja",
      label: IMMIGRATION_AUTHORITIES.tfja.label,
      status: "CONFIRMED",
      source_type: "system_detected",
    };
  } else if (/Juzgado\s+de\s+Distrito|Tribunal\s+Colegiado|Suprema\s+Corte|amparo/i.test(corpus)) {
    authorityResult = {
      key: "pjf",
      label: IMMIGRATION_AUTHORITIES.pjf.label,
      status: "CONFIRMED",
      source_type: "system_detected",
    };
  } else if (/INM|Instituto\s+Nacional\s+de\s+Migraci[oó]n|estaci[oó]n\s+migratoria/i.test(corpus)) {
    authorityResult = {
      key: "inm",
      label: IMMIGRATION_AUTHORITIES.inm.label,
      status: "CONFIRMED",
      source_type: "system_detected",
    };
  } else {
    authorityResult = {
      key: null,
      label: "No determinado a partir de los documentos",
      status: "INSUFFICIENT_DATA",
      source_type: "not_determined",
    };
  }

  // 3. Procedural Posture Determination
  let postureResult: ImmigrationPostureDetection;
  if (/sentencia|ejecutoria|sobreseimiento|resoluci[oó]n\s+definitiva/i.test(corpus)) {
    postureResult = {
      label: "Resolución o Sentencia Definitiva Emitida",
      status: "CONFIRMED",
      source_type: "system_detected",
    };
  } else if (/amparo\s+(?:indirecto|directo)|incidente\s+de\s+suspensi[oó]n/i.test(corpus)) {
    postureResult = {
      label: "Juicio de Amparo en Tramitación",
      status: "CONFIRMED",
      source_type: "system_detected",
    };
  } else if (/juicio\s+de\s+nulidad|recurso\s+de\s+revisi[oó]n/i.test(corpus)) {
    postureResult = {
      label: "Impugnación Administrativa / Contenciosa",
      status: "CONFIRMED",
      source_type: "system_detected",
    };
  } else if (/estaci[oó]n\s+migratoria|detenci[oó]n|presentaci[oó]n/i.test(corpus)) {
    postureResult = {
      label: "Procedimiento de Alojamiento / Detención Migratoria",
      status: "CONFIRMED",
      source_type: "system_detected",
    };
  } else if (/solicitud|tr[aá]mite|requerimiento|prevenci[oó]n/i.test(corpus)) {
    postureResult = {
      label: "Procedimiento Administrativo Sustanciación Inicial",
      status: "CONFIRMED",
      source_type: "system_detected",
    };
  } else {
    postureResult = {
      label: "No determinado a partir de los documentos",
      status: "INSUFFICIENT_DATA",
      source_type: "not_determined",
    };
  }

  // 4. Extract Key Metadata
  const passportMatch = corpus.match(/\bpasaporte\s*(?:N[uú]m(?:ero)?\s*)?:?\s*([A-Z0-9]{6,12})\b/i);
  const natMatch = corpus.match(/\bnacionalidad\s*:?\s*([A-Záéíóúñ\s]{3,30})\b/i);
  const clientMatch = corpus.match(/\b(?:nombre|solicitante|promovente)\s*:?\s*([A-Záéíóúñ\s]{3,50})\b/i);

  return {
    subtype: subtypeResult,
    authority: authorityResult,
    procedural_posture: postureResult,
    extracted_metadata: {
      client_name: clientMatch ? clientMatch[1].trim() : null,
      nationality: natMatch ? natMatch[1].trim() : null,
      passport_number: passportMatch ? passportMatch[1].trim() : null,
      current_condition_of_stay: null,
      requested_benefit: null,
    },
  };
}
