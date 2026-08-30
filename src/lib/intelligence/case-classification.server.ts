// Automatic Case Classification — source-grounded, evidence-gated.
//
// "The user should not have to manually select the case type when the
// uploaded source documents establish it." Extends the existing
// deterministic, no-AI-spend detection already used by
// mx-auto-detect.server.ts (materia via mx-case-classifier.ts, jurisdiction
// via mx-jurisdiction.ts) with the missing piece: WHY. Every detected field
// carries the exact document + page + verbatim quote that established it —
// the same evidence-gating primitives already used by
// completed-case-audit.server.ts (verifyQuoteDetailed / buildGroundingCorpus
// / locateQuoteInText / pageForOffset) and citation-verification.server.ts.
//
// THE anti-hallucination gate — deterministic, not prompt-based: this
// module extracts every field with plain regex over the documents' own raw
// text, never an LLM call. A field is CONFIRMED only when a document was
// actually matched and the matched span is independently re-locatable in
// that document's own text (so the "quote" attached is always real, never
// a paraphrase). Two documents disagreeing produces CONFLICT, showing both.
// No match anywhere produces INSUFFICIENT_DATA. There is no path that
// invents a value — see classifyCaseFromDocuments()'s per-field resolution.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolveMxCaseType, type MxCaseType } from "@/lib/mx-case-classifier";
import { buildJurisdictionProfile } from "./mx-jurisdiction";
import { locateQuoteInText, pageForOffset } from "./evidence-provenance.server";

type Db = SupabaseClient<Database>;

export const CLASSIFICATION_FIELDS = [
  "case_type",
  "proceeding_type",
  "procedural_vehicle",
  "underlying_materia",
  "jurisdiction",
  "matter",
  "procedural_stage",
  "expediente_number",
  "court",
  "parties",
  "concluded_status",
] as const;
export type ClassificationField = (typeof CLASSIFICATION_FIELDS)[number];

export type ClassificationStatus = "CONFIRMED" | "INSUFFICIENT_DATA" | "CONFLICT";

export type SourceReference = {
  document_id: string;
  filename: string;
  page: number;
  quote: string;
};

export type FieldClassification = {
  field: ClassificationField;
  status: ClassificationStatus;
  value: string | null;
  confidence: number | null;
  source: SourceReference | null;
  /** Populated only when status === "CONFLICT" — every distinct value seen, each with its own source. Never silently picked. */
  conflicts: Array<{ value: string; source: SourceReference }>;
};

export type CaseClassificationResult = {
  fields: FieldClassification[];
};

export type DocInput = { id: string; filename: string; extracted_text: string | null };

const PAGE_CHARS = 3000;

/** Locates `quote` inside `doc.extracted_text` and returns a fully-grounded
 *  SourceReference, or null if the quote isn't actually there — the same
 *  "never trust a match you can't re-locate" discipline as
 *  completed-case-audit.server.ts's resolveSource(). */
function ground(doc: DocInput, quote: string): SourceReference | null {
  if (!doc.extracted_text) return null;
  const loc = locateQuoteInText(quote, doc.extracted_text);
  if (!loc) return null;
  return {
    document_id: doc.id,
    filename: doc.filename,
    page: pageForOffset(loc.start, PAGE_CHARS),
    quote: quote.trim(),
  };
}

/**
 * Runs `pattern` (must have exactly one capturing group: the value to
 * extract) against every document, grounding each match. Returns one
 * FieldClassification: INSUFFICIENT_DATA (no matches anywhere), CONFIRMED
 * (every match normalizes to the same value), or CONFLICT (matches
 * disagree — every distinct value shown with its own source).
 */
function classifyByPattern(
  field: ClassificationField,
  docs: DocInput[],
  pattern: RegExp,
  normalize: (raw: string) => string = (s) => s.trim(),
): FieldClassification {
  const hits: Array<{ value: string; source: SourceReference }> = [];
  for (const doc of docs) {
    if (!doc.extracted_text) continue;
    const re = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    for (const m of doc.extracted_text.matchAll(re)) {
      const raw = m[1] ?? m[0];
      const value = normalize(raw);
      if (!value) continue;
      // Ground on the FULL matched span (m[0]), not just the captured group,
      // so the quote reads naturally and re-locates reliably.
      const source = ground(doc, m[0]);
      if (!source) continue; // couldn't independently re-locate — do not trust
      hits.push({ value, source });
    }
  }
  if (hits.length === 0) {
    return {
      field,
      status: "INSUFFICIENT_DATA",
      value: null,
      confidence: null,
      source: null,
      conflicts: [],
    };
  }
  const distinctValues = new Map<string, SourceReference>();
  for (const h of hits) if (!distinctValues.has(h.value)) distinctValues.set(h.value, h.source);
  if (distinctValues.size === 1) {
    const [[value, source]] = distinctValues;
    return { field, status: "CONFIRMED", value, confidence: 1, source, conflicts: [] };
  }
  return {
    field,
    status: "CONFLICT",
    value: null,
    confidence: null,
    source: null,
    conflicts: [...distinctValues].map(([value, source]) => ({ value, source })),
  };
}

// ---------------------------------------------------------------------------
// Proceeding type + expediente number — Mexican captions combine both:
// "AMPARO DIRECTO EN REVISIÓN 3684/2012" IS the proceeding type AND the
// docket number in one string. Ordered most-specific-first so e.g. "AMPARO
// DIRECTO EN REVISIÓN" matches before the more general "AMPARO DIRECTO".
// Deliberately NOT exhaustive of every possible Mexican caption — a
// reasonable, extensible core covering every materia mx-case-classifier.ts
// already recognizes; documents whose caption doesn't match any of these
// correctly fall through to INSUFFICIENT_DATA rather than a guess.
// ---------------------------------------------------------------------------
const PROCEEDING_CAPTION_PATTERN =
  /\b(AMPARO DIRECTO EN REVISI[ÓO]N|AMPARO EN REVISI[ÓO]N|AMPARO DIRECTO|AMPARO INDIRECTO|JUICIO DE AMPARO|CONTROVERSIA CONSTITUCIONAL|ACCI[ÓO]N DE INCONSTITUCIONALIDAD|CARPETA DE INVESTIGACI[ÓO]N|CAUSA PENAL|JUICIO ORAL MERCANTIL|JUICIO EJECUTIVO MERCANTIL|JUICIO ORDINARIO CIVIL|JUICIO ORDINARIO MERCANTIL|JUICIO ORAL FAMILIAR|JUICIO ORDINARIO FAMILIAR|JUICIO LABORAL|JUICIO ORDINARIO LABORAL|JUICIO DE NULIDAD|JUICIO CONTENCIOSO ADMINISTRATIVO|JUICIO AGRARIO|RECURSO DE REVISI[ÓO]N FISCAL|RECURSO DE APELACI[ÓO]N|RECURSO DE QUEJA|RECURSO DE RECLAMACI[ÓO]N)\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})/gi;

const EXPEDIENTE_STANDALONE_PATTERN =
  /\bEXPEDIENTE\s+(?:N[ÚU]MERO\s+)?(\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4})\b/gi;

const PENAL_UNDERLYING_PATTERN =
  /\b(materia\s+penal|proceso\s+penal|causa\s+penal|juicio\s+penal|sentencia\s+penal|averiguaci[óo]n\s+previa|carpeta\s+de\s+investigaci[óo]n|ministerio\s+p[úu]blico|tribunal\s+de\s+enjuiciamiento|juez\s+de\s+control|persona\s+sentenciada)\b/gi;

export function normalizeProceduralVehicle(value: string): string {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const aliases: Record<string, string> = {
    amparo_directo_en_revision: "amparo_directo_revision",
    amparo_en_revision: "amparo_revision",
    recurso_de_apelacion: "apelacion",
    carpeta_de_investigacion: "carpeta_investigacion",
  };
  return aliases[normalized] ?? normalized;
}

// Court/tribunal — federal and state-level naming conventions.
const COURT_PATTERN =
  /\b(SUPREMA CORTE DE JUSTICIA DE LA NACI[ÓO]N|TRIBUNAL COLEGIADO[\wÁÉÍÓÚÑ.\s]{0,60}?CIRCUITO|TRIBUNAL DE ALZADA[\wÁÉÍÓÚÑ.\s]{0,40}|JUZGADO[\wÁÉÍÓÚÑ.\s]{0,10}DE DISTRITO[\wÁÉÍÓÚÑ.\s]{0,40}|JUZGADO DE CONTROL[\wÁÉÍÓÚÑ.\s]{0,40}|TRIBUNAL DE ENJUICIAMIENTO[\wÁÉÍÓÚÑ.\s]{0,40}|TRIBUNAL FEDERAL DE JUSTICIA ADMINISTRATIVA|TRIBUNAL UNITARIO AGRARIO[\wÁÉÍÓÚÑ.\s]{0,20}|SALA[\wÁÉÍÓÚÑ.\s]{0,15}DEL TRIBUNAL SUPERIOR DE JUSTICIA[\wÁÉÍÓÚÑ.\s]{0,40}|JUZGADO[\wÁÉÍÓÚÑ.\s]{0,10}DE LO (?:CIVIL|FAMILIAR|PENAL|MERCANTIL|LABORAL)[\wÁÉÍÓÚÑ.\s]{0,40}|TRIBUNAL LABORAL[\wÁÉÍÓÚÑ.\s]{0,40})\b/gi;

// Concluded vs ongoing — explicit finality language only; absence proves
// nothing either way (see NOT_ESTABLISHED discipline throughout this file).
const CONCLUDED_PATTERN =
  /\b(sentencia ejecutoriada|causa ejecutoria|ha causado ejecutoria|cosa juzgada|qued[oó] firme|se sobresee|arch[ií]vese el presente asunto|por unanimidad de votos se resuelve|se declara concluido)\b/gi;
const ONGOING_PATTERN =
  /\b(se admite a tr[aá]mite|se cita para audiencia|audiencia programada|queda pendiente de resoluci[oó]n|se otorga plazo|se requiere a las partes)\b/gi;

// Parties — labeled-field extraction only (the reliable, unambiguous case).
// Deliberately conservative: captures ROLE + the line's content up to a
// natural boundary, never attempts free-text name recognition anywhere else
// in the document (that would risk exactly the "invented defendant
// information" failure mode the completed-case-audit hardening forbids).
const PARTY_LABEL_PATTERN =
  /\b(QUEJOS[OA]|TERCERO INTERESADO|AUTORIDAD RESPONSABLE|ACTOR|ACTORA|DEMANDAD[OA]|IMPUTAD[OA]|V[ÍI]CTIMA U OFENDIDO|MINISTERIO P[ÚU]BLICO)\s*:\s*([^\n\r.;]{2,120})/gi;

function normalizeUpper(s: string): string {
  return s.replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Pure, deterministic, no-IO classification over already-extracted document
 * text. Materia (case_type) and jurisdiction reuse the existing tested
 * classifiers (mx-case-classifier.ts / mx-jurisdiction.ts) for the VALUE,
 * but are re-graded here against the same CONFIRMED/CONFLICT/
 * INSUFFICIENT_DATA discipline as every other field — a materia guessed
 * from weak/no signal is INSUFFICIENT_DATA, never silently presented as
 * confirmed.
 */
export function classifyCaseFromDocuments(docs: DocInput[]): CaseClassificationResult {
  const fields: FieldClassification[] = [];

  // ---- case_type (materia) — reuse the existing deterministic classifier
  // per document, so a genuine disagreement between documents (e.g. a
  // demanda mislabeled among otherwise-amparo documents) surfaces as
  // CONFLICT rather than being averaged away by concatenating everything
  // into one blob first.
  {
    const perDoc: Array<{ value: MxCaseType; doc: DocInput; matched: string[] }> = [];
    for (const doc of docs) {
      if (!doc.extracted_text) continue;
      const c = resolveMxCaseType({ text: doc.extracted_text, declaredArea: null });
      // classifier.source === "content" with a real confident match only —
      // "default" (no signal, fell back to civil) must never count as a hit.
      if (
        c.source === "content" &&
        c.classification.confidence >= 0.3 &&
        c.classification.matched.length > 0
      ) {
        perDoc.push({ value: c.caseType, doc, matched: c.classification.matched });
      }
    }
    if (perDoc.length === 0) {
      fields.push({
        field: "case_type",
        status: "INSUFFICIENT_DATA",
        value: null,
        confidence: null,
        source: null,
        conflicts: [],
      });
    } else {
      const byValue = new Map<string, { doc: DocInput; matched: string }>();
      for (const p of perDoc)
        if (!byValue.has(p.value)) byValue.set(p.value, { doc: p.doc, matched: p.matched[0] });
      if (byValue.size === 1) {
        const [[value, { doc, matched }]] = byValue;
        const source = ground(doc, matched);
        fields.push({
          field: "case_type",
          status: source ? "CONFIRMED" : "INSUFFICIENT_DATA",
          value: source ? value : null,
          confidence: source ? 0.85 : null,
          source,
          conflicts: [],
        });
      } else {
        const conflicts = [...byValue]
          .map(([value, { doc, matched }]) => ({ value, source: ground(doc, matched) }))
          .filter((c): c is { value: string; source: SourceReference } => c.source !== null);
        fields.push(
          conflicts.length >= 2
            ? {
                field: "case_type",
                status: "CONFLICT",
                value: null,
                confidence: null,
                source: null,
                conflicts,
              }
            : {
                field: "case_type",
                status: "INSUFFICIENT_DATA",
                value: null,
                confidence: null,
                source: null,
                conflicts: [],
              },
        );
      }
    }
  }

  // ---- proceeding_type + expediente_number (combined caption) ------------
  const proceedingField = classifyByPattern(
    "proceeding_type",
    docs,
    PROCEEDING_CAPTION_PATTERN,
    (raw) => normalizeUpper(raw),
  );
  fields.push(proceedingField);
  {
    // Prefer the combined caption's own docket number; fall back to a bare
    // "EXPEDIENTE 123/2024" mention only when no caption matched at all.
    if (proceedingField.status === "CONFIRMED" && proceedingField.source) {
      const numMatch = /\d+[A-Z]?(?:\s?BIS)?\s*\/\s*\d{4}/i.exec(proceedingField.source.quote);
      fields.push({
        field: "expediente_number",
        status: "CONFIRMED",
        value: numMatch ? numMatch[0].replace(/\s+/g, "") : null,
        confidence: numMatch ? 0.9 : null,
        source: proceedingField.source,
        conflicts: [],
      });
    } else {
      fields.push(
        classifyByPattern("expediente_number", docs, EXPEDIENTE_STANDALONE_PATTERN, (raw) =>
          raw.replace(/\s+/g, ""),
        ),
      );
    }
  }

  // Procedural vehicle and underlying materia are intentionally independent.
  // An ADR/Amparo caption establishes the vehicle; Penal-origin language in
  // the same grounded corpus establishes the underlying materia.
  fields.push(
    proceedingField.status === "CONFIRMED" && proceedingField.value
      ? {
          field: "procedural_vehicle",
          status: "CONFIRMED",
          value: normalizeProceduralVehicle(proceedingField.value),
          confidence: proceedingField.confidence,
          source: proceedingField.source,
          conflicts: [],
        }
      : {
          field: "procedural_vehicle",
          status: proceedingField.status,
          value: null,
          confidence: null,
          source: null,
          conflicts: proceedingField.conflicts.map((conflict) => ({
            value: normalizeProceduralVehicle(conflict.value),
            source: conflict.source,
          })),
        },
  );
  fields.push(
    classifyByPattern("underlying_materia", docs, PENAL_UNDERLYING_PATTERN, () => "penal"),
  );

  // ---- jurisdiction — reuse buildJurisdictionProfile per document for the
  // VALUE (already deterministic, keyword-based, tested); grounding is
  // best-effort since that module doesn't expose which phrase matched.
  // buildJurisdictionProfile requires a resolvable materia (it throws on
  // null/unrecognized — see requireMexicanCaseType) purely to pick a
  // fuero-tiebreak default; it does not change whether jurisdiction_level
  // itself is corpus-detected. Use the case_type already resolved above
  // when CONFIRMED, otherwise an arbitrary neutral materia — never let a
  // still-unresolved case_type block jurisdiction detection.
  {
    const materiaForProfile =
      fields[0]?.status === "CONFIRMED" && fields[0]?.value ? fields[0].value : "civil";
    const perDoc: Array<{ value: "federal" | "state"; doc: DocInput }> = [];
    for (const doc of docs) {
      if (!doc.extracted_text) continue;
      let profile: ReturnType<typeof buildJurisdictionProfile>;
      try {
        profile = buildJurisdictionProfile({
          caseType: materiaForProfile,
          jurisdictionField: null,
          corpusText: doc.extracted_text,
        });
      } catch {
        continue; // never let a jurisdiction-profile failure block classification
      }
      if (profile.jurisdiction_source === "corpus" && profile.jurisdiction_level !== "unresolved") {
        perDoc.push({
          value: profile.jurisdiction_level === "federal" ? "federal" : "state",
          doc,
        });
      }
    }
    if (perDoc.length === 0) {
      fields.push({
        field: "jurisdiction",
        status: "INSUFFICIENT_DATA",
        value: null,
        confidence: null,
        source: null,
        conflicts: [],
      });
    } else {
      const distinct = new Set(perDoc.map((p) => p.value));
      if (distinct.size === 1) {
        fields.push({
          field: "jurisdiction",
          status: "CONFIRMED",
          value: perDoc[0].value === "federal" ? "Federal" : "Estatal",
          confidence: 0.7,
          // No pinpointed quote available from buildJurisdictionProfile —
          // still a real, deterministic, corpus-based detection, just
          // without a page reference (spec: quote/page "when available").
          source: {
            document_id: perDoc[0].doc.id,
            filename: perDoc[0].doc.filename,
            page: 1,
            quote: "",
          },
          conflicts: [],
        });
      } else {
        fields.push({
          field: "jurisdiction",
          status: "CONFLICT",
          value: null,
          confidence: null,
          source: null,
          conflicts: [...distinct].map((value) => ({
            value: value === "federal" ? "Federal" : "Estatal",
            source: {
              document_id: perDoc.find((p) => p.value === value)!.doc.id,
              filename: perDoc.find((p) => p.value === value)!.doc.filename,
              page: 1,
              quote: "",
            },
          })),
        });
      }
    }
  }

  // ---- court / tribunal ----------------------------------------------------
  fields.push(classifyByPattern("court", docs, COURT_PATTERN, (raw) => normalizeUpper(raw)));

  // ---- concluded_status ----------------------------------------------------
  {
    const concluded = classifyByPattern(
      "concluded_status",
      docs,
      CONCLUDED_PATTERN,
      () => "Concluded",
    );
    const ongoing = classifyByPattern("concluded_status", docs, ONGOING_PATTERN, () => "Ongoing");
    if (concluded.status === "CONFIRMED" && ongoing.status !== "CONFIRMED") {
      fields.push(concluded);
    } else if (ongoing.status === "CONFIRMED" && concluded.status !== "CONFIRMED") {
      fields.push(ongoing);
    } else if (concluded.status === "CONFIRMED" && ongoing.status === "CONFIRMED") {
      // Both finality and ongoing-proceeding language appear (e.g. a
      // concluded lower-instance ruling inside a case still on appeal) —
      // a genuine conflict, not a coin-flip.
      fields.push({
        field: "concluded_status",
        status: "CONFLICT",
        value: null,
        confidence: null,
        source: null,
        conflicts: [
          { value: "Concluded", source: concluded.source! },
          { value: "Ongoing", source: ongoing.source! },
        ],
      });
    } else {
      fields.push({
        field: "concluded_status",
        status: "INSUFFICIENT_DATA",
        value: null,
        confidence: null,
        source: null,
        conflicts: [],
      });
    }
  }

  // ---- parties (labeled fields only — see PARTY_LABEL_PATTERN doc comment) -
  {
    const found: Array<{ role: string; name: string; source: SourceReference }> = [];
    for (const doc of docs) {
      if (!doc.extracted_text) continue;
      for (const m of doc.extracted_text.matchAll(PARTY_LABEL_PATTERN)) {
        const role = normalizeUpper(m[1]);
        const name = m[2].trim();
        if (!name) continue;
        const source = ground(doc, m[0]);
        if (!source) continue;
        found.push({ role, name, source });
      }
    }
    if (found.length === 0) {
      fields.push({
        field: "parties",
        status: "INSUFFICIENT_DATA",
        value: null,
        confidence: null,
        source: null,
        conflicts: [],
      });
    } else {
      // Parties are inherently multi-valued (several roles per case) — not a
      // single-value CONFIRMED/CONFLICT field like the others. Represent as
      // CONFIRMED with a JSON-encoded value listing every labeled party
      // found, sourced to its own first occurrence.
      const value = JSON.stringify(found.slice(0, 20).map((f) => ({ role: f.role, name: f.name })));
      fields.push({
        field: "parties",
        status: "CONFIRMED",
        value,
        confidence: 0.6,
        source: found[0].source,
        conflicts: [],
      });
    }
  }

  // ---- matter / procedural_stage — no reliable deterministic pattern exists
  // yet for these two (they're the most free-text-dependent fields). Rather
  // than guess, they are explicitly INSUFFICIENT_DATA until a real pattern
  // set is developed — matching the "do not guess" mandate over false
  // completeness.
  fields.push({
    field: "matter",
    status: "INSUFFICIENT_DATA",
    value: null,
    confidence: null,
    source: null,
    conflicts: [],
  });
  fields.push({
    field: "procedural_stage",
    status: "INSUFFICIENT_DATA",
    value: null,
    confidence: null,
    source: null,
    conflicts: [],
  });

  return { fields };
}

/**
 * Runs classification for one case and persists the evidence trail. Also
 * updates cases.case_type/jurisdiction/case_type_source/
 * case_type_verification_status — but ONLY when the case has not been
 * manually overridden away from a prior source-confirmed value (see
 * resolveVerifiedCaseType below for the read-side guarantee that a
 * verified classification is never silently replaced by this write path
 * either).
 */
export async function runCaseClassification(
  db: Db,
  caseId: string,
  userId: string,
): Promise<CaseClassificationResult> {
  const { data: docsRaw } = await db
    .from("documents")
    .select("id,filename,extracted_text")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });
  const docs = (docsRaw ?? []) as DocInput[];

  const result = classifyCaseFromDocuments(docs);

  // Delete-then-insert per field, scoped to this case only — a fresh run
  // (new documents added) replaces prior evidence rather than accumulating
  // stale rows alongside current ones.
  await (db as any).from("case_classification_evidence").delete().eq("case_id", caseId);
  const rows = result.fields.map((f) => ({
    case_id: caseId,
    user_id: userId,
    field: f.field,
    status: f.status,
    value: f.value,
    confidence: f.confidence,
    source_document_id: f.source?.document_id ?? null,
    source_page: f.source?.page ?? null,
    source_quote: f.source?.quote ?? null,
    conflicting_values: f.conflicts.map((c) => ({ value: c.value, ...c.source })),
  }));
  if (rows.length > 0) {
    const { error } = await (db as any).from("case_classification_evidence").insert(rows);
    if (error) console.error("[case-classification] evidence insert failed", error);
  }

  // ---- Sync cases.case_type / jurisdiction — never overwrites a value the
  // attorney manually set to something OTHER than a prior source-confirmed
  // classification (case_type_source === 'manual_override' /
  // 'manual_override_conflicting'). This is the write-side half of
  // "downstream engines must use the verified classification, not an
  // unverified selection": a manual override that never conflicted with a
  // source classification (case_type_source is still 'source_confirmed',
  // 'heuristic', or unset) is safe to refresh when new, better evidence
  // arrives.
  const caseTypeField = result.fields.find((f) => f.field === "case_type");
  const jurisdictionField = result.fields.find((f) => f.field === "jurisdiction");
  const proceduralVehicleField = result.fields.find((f) => f.field === "procedural_vehicle");
  const underlyingMateriaField = result.fields.find((f) => f.field === "underlying_materia");
  const { data: caseRow } = await db
    .from("cases")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("case_type,jurisdiction,case_type_source,procedural_vehicle,underlying_materia,matter_metadata" as any)
    .eq("id", caseId)
    .maybeSingle();
  const current = (caseRow ?? {}) as {
    case_type?: string | null;
    jurisdiction?: string | null;
    case_type_source?: string | null;
    procedural_vehicle?: string | null;
    underlying_materia?: string | null;
    matter_metadata?: Record<string, unknown> | null;
  };
  const isManuallyLocked =
    current.case_type_source === "manual_override" ||
    current.case_type_source === "manual_override_conflicting";

  const { getCaseConfiguration, updateCaseConfigurationWithClassification } = await import("./case-configuration");
  const existingConfig = getCaseConfiguration(caseRow as any);

  const updatedConfig = updateCaseConfigurationWithClassification(existingConfig, {
    detected_case_type: caseTypeField?.value ?? null,
    detected_jurisdiction: jurisdictionField?.value === "Federal" ? "federal" : (jurisdictionField?.value ?? null),
    detected_procedural_vehicle: proceduralVehicleField?.value ?? null,
    detected_underlying_materia: underlyingMateriaField?.value ?? null,
    source_quote: caseTypeField?.source?.quote ?? null,
    document_filename: caseTypeField?.source?.filename ?? null,
    allowAutoCorrection: !isManuallyLocked,
  });

  const patch: Record<string, unknown> = {};
  const currentMeta = (current.matter_metadata as Record<string, unknown> | null) ?? {};
  patch.matter_metadata = { ...currentMeta, case_configuration: updatedConfig };

  // STALE-ARTIFACT INVALIDATION (Fix instructions Step 5): true only when
  // this run is about to WRITE a case_type value that actually DIFFERS from
  // what was there before — not merely re-confirming the same value. The
  // "Day 1 generated as administrativo, Day 2 corpus-corrected to amparo,
  // stale report still served" scenario this closes.
  const caseTypeActuallyChanged =
    !isManuallyLocked &&
    caseTypeField?.status === "CONFIRMED" &&
    !!caseTypeField.value &&
    caseTypeField.value !== current.case_type;
  if (caseTypeField) {
    patch.case_type_verification_status = caseTypeField.status;
    if (!isManuallyLocked && caseTypeField.status === "CONFIRMED" && caseTypeField.value) {
      patch.case_type = caseTypeField.value;
      patch.case_type_source = "source_confirmed";
    } else if (!current.case_type && !isManuallyLocked) {
      patch.case_type_source = "unresolved";
    }
  }
  if (
    jurisdictionField &&
    jurisdictionField.status === "CONFIRMED" &&
    jurisdictionField.value &&
    !current.jurisdiction
  ) {
    patch.jurisdiction = jurisdictionField.value === "Federal" ? "federal" : current.jurisdiction;
  }
  if (proceduralVehicleField?.status === "CONFIRMED" && proceduralVehicleField.value) {
    patch.procedural_vehicle = proceduralVehicleField.value;
  }
  if (underlyingMateriaField?.status === "CONFIRMED" && underlyingMateriaField.value) {
    patch.underlying_materia = underlyingMateriaField.value;
  }
  if (Object.keys(patch).length > 0) {
    await db
      .from("cases")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(patch as any)
      .eq("id", caseId);
  }

  // Generalizes updateCaseSettings' caseTypeChanged reset (cases.functions.ts)
  // — a manual case_type edit already triggers a full derived-data reset so
  // stale findings/reports generated under the old materia never survive.
  // This is the SAME invalidation, fired from the AUTOMATIC classification
  // write path above, which previously had none at all: every downstream
  // artifact (findings, agent output, procedural-compliance checklist,
  // recommendations) generated under a wrong/stale materia stayed in place
  // and resume/rerun treated it as "already done." Reuses
  // clearCaseDerivedData — the exact same table-deletion list as the
  // manual-edit path — so this can never drift from it for DERIVED rows.
  //
  // DELIBERATELY NARROWER than the manual-edit path for cases.* column
  // resets: uses CASE_TYPE_CORRECTION_RESET_FIELDS, not CASE_RESET_FIELDS —
  // extraction is materia-independent, so this must never invalidate
  // extracted_at/extraction_report. CONFIRMED LIVE (ADR-4640-2017-180212):
  // reusing the full CASE_RESET_FIELDS here sent a case back to the
  // "extraction" stage on every automatic reclassification that disagreed
  // with an unlocked declared value — for a materia-ambiguous document that
  // can fire on every run, producing exactly the "keeps getting stuck then
  // going back to extraction and never completes" symptom.
  if (caseTypeActuallyChanged) {
    try {
      const { clearCaseDerivedData, CASE_TYPE_CORRECTION_RESET_FIELDS } = await import("../pipeline-reset");
      await clearCaseDerivedData(db, caseId);
      await db
        .from("cases")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(CASE_TYPE_CORRECTION_RESET_FIELDS as any)
        .eq("id", caseId);
    } catch (e) {
      console.error("[case-classification] stale-artifact invalidation failed", { caseId, error: e });
    }
  }

  // Unconditional (not just when caseTypeActuallyChanged): case_classification_evidence
  // is delete+re-inserted on every call, so even a same-value reconfirmation
  // changes what resolveCaseIdentity would compute (e.g. declared/unverified
  // -> verified/source_confirmed) — any earlier-cached identity for this
  // case within the current db instance's lifetime must not survive this.
  // See invalidateCaseIdentity's doc comment for the exact bug this closes.
  invalidateCaseIdentity(db, caseId);

  try {
    const { applyAutomaticCaseIdentity } = await import("./case-identity-generator.server");
    const { detectProceduralPosture } = await import("./procedural-posture");
    const posture = detectProceduralPosture(docs);
    await applyAutomaticCaseIdentity(db, caseId, docs, result, posture);
  } catch (e) {
    console.warn("[case-classification] automatic case identity naming failed", e);
  }

  return result;
}

// -----------------------------------------------------------------------------
// resolveCaseIdentity — THE single authoritative case-identity resolver.
//
// Fixes two bugs at once (see case-identity.ts's header comment and the
// "Fix the Verified Case Identity Architecture" instructions doc for the
// full diagnosis):
//
// 1. INTEGRATION BYPASS: the old resolveVerifiedCaseType() below was
//    correct in principle but had ~0 real callers — ~9 legal-reasoning call
//    sites (analyzer stage, scoring, jurisdiction intel, legal QA, case-law
//    attachment, cross-domain activation, the report writer) all read raw
//    cases.case_type directly instead. A stale/wrong value in that column
//    propagated unchecked through the entire pipeline.
// 2. PRECEDENCE BUG: even if wired in, the old function checked CONFIRMED
//    evidence BEFORE checking whether the attorney had manually locked
//    case_type to something else — wiring it in as-is would have silently
//    overridden an attorney's deliberate choice, a new bug replacing the
//    old one. This version checks the manual lock first.
//
// Precedence (first match wins, no fallthrough past a match):
//   1. Manual lock (case_type_source is manual_override/
//      manual_override_conflicting) AND CONFIRMED evidence disagrees with
//      it -> "conflict". caseType is null — a conflicted identity is never
//      usable for legal reasoning (see isUsableForLegalReasoning). Neither
//      value is silently picked.
//   2. Manual lock, no disagreeing CONFIRMED evidence -> "attorney_locked".
//      Treated as authoritative — the attorney's choice always wins over a
//      merely-absent or agreeing classification.
//   3. CONFIRMED evidence (not manually locked) -> "verified".
//   4. A declared cases.case_type with no CONFIRMED evidence yet ->
//      "unverified" (still returned so a caller that only wants "is
//      anything declared" can still see it, but the status tells legal-
//      reasoning consumers not to trust it — see isUsableForLegalReasoning).
//   5. Nothing at all -> "unverified", caseType null.
//   Any thrown error anywhere in resolution -> "failed", caseType null,
//   logged via console.error (never swallowed silently).
//
// proceedingType and jurisdiction are folded into the same returned object.
// proceedingType has no declared/manual fallback (cases.case_type is a
// materia field, not a proceeding-type field — nothing to fall back to,
// same as the original resolveVerifiedProceedingType). jurisdiction has a
// declared/confirmed precedence like case_type, but no attorney-lock
// concept — there is no jurisdiction_source column.
// -----------------------------------------------------------------------------
import type { VerifiedCaseIdentity, CaseIdentityEvidence } from "./case-identity";

type EvidenceRow = {
  field: string;
  status: string;
  value: string | null;
  confidence: number | null;
  source_document_id: string | null;
  source_page: number | null;
  source_quote: string | null;
};

async function toCaseIdentityEvidence(
  db: Db,
  row: EvidenceRow | undefined,
): Promise<CaseIdentityEvidence | null> {
  if (!row || row.status !== "CONFIRMED" || !row.value) return null;
  if (!row.source_document_id || row.source_page == null || !row.source_quote) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: doc } = await (db as any)
    .from("documents")
    .select("filename")
    .eq("id", row.source_document_id)
    .maybeSingle();
  return {
    document_id: row.source_document_id,
    filename: (doc as { filename?: string | null } | null)?.filename ?? "unknown",
    page: row.source_page,
    quote: row.source_quote,
  };
}

function emptyIdentity(caseId: string): VerifiedCaseIdentity {
  return {
    caseId,
    caseType: null,
    proceedingType: null,
    proceduralVehicle: null,
    underlyingMateria: null,
    jurisdiction: null,
    status: "unverified",
    confidence: null,
    source: "default",
    evidence: null,
    conflict: null,
  };
}

/** The uncached resolution logic — see resolveCaseIdentity() below for the
 *  memoized, public entry point every caller should actually use. */
export async function resolveCaseIdentityUncached(
  db: Db,
  caseId: string,
): Promise<VerifiedCaseIdentity> {
  const base = emptyIdentity(caseId);
  try {
    const { data: caseRowRaw, error: caseErr } = await db
      .from("cases")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("case_type,case_type_source,jurisdiction,procedural_vehicle,underlying_materia" as any)
      .eq("id", caseId)
      .maybeSingle();
    if (caseErr) throw new Error(caseErr.message);
    const caseRow = (caseRowRaw ?? {}) as {
      case_type?: string | null;
      case_type_source?: string | null;
      jurisdiction?: string | null;
      procedural_vehicle?: string | null;
      underlying_materia?: string | null;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: evidenceRowsRaw, error: evErr } = await (db as any)
      .from("case_classification_evidence")
      .select("field,status,value,confidence,source_document_id,source_page,source_quote")
      .eq("case_id", caseId)
      .in("field", [
        "case_type",
        "proceeding_type",
        "procedural_vehicle",
        "underlying_materia",
        "jurisdiction",
      ]);
    if (evErr) throw new Error(evErr.message);
    const evidenceRows = (evidenceRowsRaw ?? []) as EvidenceRow[];
    const caseTypeEvidence = evidenceRows.find((r) => r.field === "case_type");
    const proceedingEvidence = evidenceRows.find((r) => r.field === "proceeding_type");
    const proceduralVehicleEvidence = evidenceRows.find((r) => r.field === "procedural_vehicle");
    const underlyingMateriaEvidence = evidenceRows.find((r) => r.field === "underlying_materia");
    const jurisdictionEvidence = evidenceRows.find((r) => r.field === "jurisdiction");

    const isManualLock =
      caseRow.case_type_source === "manual_override" ||
      caseRow.case_type_source === "manual_override_conflicting";
    const caseTypeConfirmed = caseTypeEvidence?.status === "CONFIRMED" && !!caseTypeEvidence.value;
    const disagreesWithLock =
      caseTypeConfirmed && caseTypeEvidence!.value !== (caseRow.case_type ?? null);

    let result: VerifiedCaseIdentity;
    if (isManualLock && disagreesWithLock) {
      const sourceEvidence = await toCaseIdentityEvidence(db, caseTypeEvidence);
      result = {
        ...base,
        status: "conflict",
        source: "attorney",
        conflict: sourceEvidence
          ? {
              attorneyValue: String(caseRow.case_type ?? ""),
              sourceValue: caseTypeEvidence!.value as string,
              sourceEvidence,
            }
          : null,
      };
    } else if (isManualLock) {
      result = {
        ...base,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        caseType: (caseRow.case_type as any) ?? null,
        status: "attorney_locked",
        source: "attorney",
      };
    } else if (caseTypeConfirmed) {
      const evidence = await toCaseIdentityEvidence(db, caseTypeEvidence);
      result = {
        ...base,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        caseType: caseTypeEvidence!.value as any,
        status: "verified",
        source: "source_confirmed",
        confidence: caseTypeEvidence!.confidence ?? null,
        evidence,
      };
    } else if (caseRow.case_type) {
      result = {
        ...base,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        caseType: caseRow.case_type as any,
        status: "unverified",
        source: "declared",
      };
    } else {
      result = { ...base };
    }

    if (proceedingEvidence?.status === "CONFIRMED" && proceedingEvidence.value) {
      result.proceedingType = proceedingEvidence.value;
    }
    if (proceduralVehicleEvidence?.status === "CONFIRMED" && proceduralVehicleEvidence.value) {
      result.proceduralVehicle = proceduralVehicleEvidence.value;
    } else if (caseRow.procedural_vehicle) {
      result.proceduralVehicle = caseRow.procedural_vehicle;
    }
    if (underlyingMateriaEvidence?.status === "CONFIRMED" && underlyingMateriaEvidence.value) {
      result.underlyingMateria = underlyingMateriaEvidence.value as MxCaseType;
    } else if (caseRow.underlying_materia) {
      result.underlyingMateria = caseRow.underlying_materia as MxCaseType;
    }

    if (jurisdictionEvidence?.status === "CONFIRMED" && jurisdictionEvidence.value) {
      result.jurisdiction = jurisdictionEvidence.value;
    } else if (caseRow.jurisdiction) {
      result.jurisdiction = caseRow.jurisdiction;
    }

    return result;
  } catch (e) {
    console.error("[case-classification] resolveCaseIdentity failed", { caseId, error: e });
    return { ...base, status: "failed", source: "error" };
  }
}

// Memoized per (db instance, caseId) for the lifetime of a single pipeline
// run/request — "resolved once, consumed everywhere" without threading a
// context object through every function signature in the codebase.
// Concurrent calls for the same case within one run share the same
// in-flight promise instead of hitting the DB N times.
const identityCache = new WeakMap<Db, Map<string, Promise<VerifiedCaseIdentity>>>();

/** THE canonical entry point every legal-reasoning consumer must use —
 *  see case-identity.ts and isUsableForLegalReasoning(). */
export async function resolveCaseIdentity(db: Db, caseId: string): Promise<VerifiedCaseIdentity> {
  let perDb = identityCache.get(db);
  if (!perDb) {
    perDb = new Map();
    identityCache.set(db, perDb);
  }
  let pending = perDb.get(caseId);
  if (!pending) {
    pending = resolveCaseIdentityUncached(db, caseId);
    perDb.set(caseId, pending);
  }
  return pending;
}

/** Invalidates the cached identity for a single case — must be called
 *  whenever code writes fresh case_type/case_classification_evidence data
 *  for a case, since resolveCaseIdentity's memoization has no way to detect
 *  that the underlying data it already resolved has since changed. See
 *  runCaseClassification's call below — the bug this closes: a caller
 *  earlier in the SAME pipeline run/request (e.g. a practice-area gate that
 *  runs before autoDetectCaseContext) resolves and caches an unverified/
 *  unknown identity before classification has written its evidence;
 *  without this, every LATER caller sharing the same db instance within
 *  that same run keeps reusing that stale cached result even after
 *  classification confirms a real materia moments later. */
export function invalidateCaseIdentity(db: Db, caseId: string): void {
  identityCache.get(db)?.delete(caseId);
}

/** Test-only: clears every cached identity for a db instance (broader than
 *  invalidateCaseIdentity) so tests aren't polluted by stale cached
 *  identities across test cases sharing a mock db. Guarded by name — only
 *  ever call this from a __tests__ file. */
export function __clearCaseIdentityCacheForTests(db: Db): void {
  identityCache.delete(db);
}

/**
 * Read-side guarantee for downstream engines: prefer the source-confirmed
 * materia over cases.case_type when the two actually disagree (an attorney
 * override that conflicts with a CONFIRMED classification). Falls back to
 * cases.case_type in every other case — including when there is no
 * evidence yet, so this is always safe to call unconditionally.
 *
 * Thin backward-compatible wrapper over resolveCaseIdentity() — kept for
 * any caller not yet migrated to the richer identity object. New callers
 * must use resolveCaseIdentity() directly, never this.
 */
export async function resolveVerifiedCaseType(db: Db, caseId: string): Promise<string | null> {
  const identity = await resolveCaseIdentity(db, caseId);
  return identity.caseType;
}

/**
 * Read-side guarantee for the PROCEDURAL TYPE LOCK: the verbatim,
 * source-confirmed proceeding type/caption (e.g. "AMPARO DIRECTO EN
 * REVISIÓN") — a strictly narrower, procedural-stage-specific fact than
 * case_type/materia ("amparo"). Unlike resolveVerifiedCaseType, there is no
 * declared/manual fallback: cases.case_type is a materia field, not a
 * proceeding-type field, so there is nothing to fall back to. Returns null
 * whenever the corpus does not CONFIRM a specific proceeding caption —
 * callers must never fabricate a procedural stage from case_type alone.
 * See getProceduralTypeLock() in case-analysis-mode.ts, which turns this
 * into the hard-constraint preamble injected into every analyzer/agent/chat
 * prompt.
 *
 * Thin backward-compatible wrapper over resolveCaseIdentity() — kept for
 * any caller not yet migrated. New callers must use resolveCaseIdentity()
 * directly, never this.
 */
export async function resolveVerifiedProceedingType(
  db: Db,
  caseId: string,
): Promise<string | null> {
  const identity = await resolveCaseIdentity(db, caseId);
  return identity.proceedingType;
}
