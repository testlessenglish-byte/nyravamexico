import { describe, it, expect } from "vitest";
import {
  consolidateFindings,
  jaccard,
  normalizeText,
  isGroundedByTextOverlap,
  SOFT_GROUNDING_THRESHOLD,
} from "../finding-dedupe";

const f = (o: Record<string, unknown>) => ({ severity: "medium", confidence: 0.5, ...o });

describe("finding dedupe — duplicate consolidation", () => {
  it("collapses near-duplicate findings describing the same legal issue", () => {
    const rows = [
      f({
        id: "a",
        category: "cadena_de_custodia",
        title: "Ruptura de la cadena de custodia del arma",
        description: "No hay registro de traslado del arma entre la escena y el almacén.",
        severity: "high",
        citations: ["CNPP art. 227"],
        evidence_refs: ["doc-1"],
      }),
      f({
        id: "b",
        category: "cadena_de_custodia",
        title: "Cadena de custodia del arma interrumpida",
        description: "El registro de traslado del arma está ausente en el expediente.",
        severity: "critical",
        citations: ["CNPP art. 228"],
        evidence_refs: ["doc-2"],
      }),
      f({
        id: "c",
        category: "cadena_de_custodia",
        title: "Interrupción en la cadena de custodia del arma",
        description: "Falta el registro de traslado del arma.",
        citations: ["CNPP art. 227"],
        evidence_refs: ["doc-3"],
      }),
    ];
    const out = consolidateFindings(rows);
    expect(out).toHaveLength(1);
    // strongest (critical) survives
    expect(out[0].id).toBe("b");
    // every citation and evidence ref survives
    expect(out[0].citations).toEqual(expect.arrayContaining(["CNPP art. 227", "CNPP art. 228"]));
    expect(out[0].evidence_refs).toEqual(expect.arrayContaining(["doc-1", "doc-2", "doc-3"]));
    expect(out[0]._merged_count).toBe(2);
    // no analysis lost
    const merged = out[0]._merged ?? [];
    expect(merged.map((m) => m.description).join(" ")).toContain("escena");
  });

  it("never merges unrelated findings", () => {
    const rows = [
      f({ id: "a", category: "procesal", title: "Notificación fuera de plazo" }),
      f({ id: "b", category: "procesal", title: "Falta de firma del perito" }),
      f({ id: "c", category: "evidencia", title: "Notificación fuera de plazo" }),
    ];
    const out = consolidateFindings(rows);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("works across practice areas, not just criminal", () => {
    const laboral = consolidateFindings([
      f({
        id: "l1",
        category: "laboral",
        title: "Omisión del pago de aguinaldo proporcional",
        severity: "high",
      }),
      f({
        id: "l2",
        category: "laboral",
        title: "Falta de pago del aguinaldo proporcional",
        severity: "medium",
      }),
    ]);
    expect(laboral).toHaveLength(1);
    expect(laboral[0].id).toBe("l1");

    const amparo = consolidateFindings([
      f({
        id: "m1",
        category: "amparo",
        title: "Violación al derecho de audiencia previa",
        severity: "critical",
      }),
      f({
        id: "m2",
        category: "amparo",
        title: "Vulneración del derecho de audiencia previa",
        severity: "high",
      }),
      f({ id: "m3", category: "amparo", title: "Falta de fundamentación del acto reclamado" }),
    ]);
    expect(amparo).toHaveLength(2);
    expect(amparo.map((r) => r.id)).toEqual(["m1", "m3"]);
  });

  it("loses no evidence, citations, source docs or supporting engines", () => {
    const out = consolidateFindings([
      f({
        id: "a",
        category: "civil",
        title: "Incumplimiento contractual del arrendatario",
        source_doc_ids: ["d1"],
        supporting_engines: ["engine:contradictions"],
        tags: ["contrato"],
        citations: ["CCF art. 2398"],
      }),
      f({
        id: "b",
        category: "civil",
        title: "Incumplimiento del contrato por el arrendatario",
        source_doc_ids: ["d2"],
        supporting_engines: ["agent:procedural_violations"],
        tags: ["arrendamiento"],
        citations: ["CCF art. 2400"],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].source_doc_ids).toEqual(["d1", "d2"]);
    expect(out[0].supporting_engines).toEqual([
      "engine:contradictions",
      "agent:procedural_violations",
    ]);
    expect(out[0].tags).toEqual(["contrato", "arrendamiento"]);
    expect(out[0].citations).toEqual(["CCF art. 2398", "CCF art. 2400"]);
  });

  it("preserves input order and does not mutate inputs", () => {
    const rows = [
      f({ id: "a", category: "penal", title: "Detención sin orden judicial" }),
      f({ id: "b", category: "penal", title: "Cateo ilegal del domicilio" }),
      f({ id: "c", category: "penal", title: "Detención efectuada sin orden judicial" }),
    ];
    const snapshot = JSON.stringify(rows);
    const out = consolidateFindings(rows);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it("passes single findings through untouched", () => {
    const row = f({
      id: "solo",
      category: "fiscal",
      title: "Determinación presuntiva improcedente",
    });
    const out = consolidateFindings([row]);
    expect(out).toHaveLength(1);
    expect(out[0]._alias_ids).toBeUndefined();
    expect(out[0]._merged_count).toBeUndefined();
  });

  it("handles empty input", () => {
    expect(consolidateFindings([])).toEqual([]);
  });

  it("normalizes accents and computes jaccard", () => {
    expect(normalizeText("Violación Áérea")).toBe("violacion aerea");
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
});

describe("finding dedupe — cross-engine (cross-category) duplication", () => {
  it("merges the same canonical issue emitted by two engines under different categories", () => {
    const out = consolidateFindings([
      f({
        id: "e1",
        category: "custody_best_interest_analysis",
        title: "Deterioro cognitivo del testador",
        description:
          "La valoración neuropsicológica documenta deterioro cognitivo moderado a severo.",
        severity: "high",
        evidence_refs: ["doc-neuropsicologia"],
        citations: ["CCF art. 1306"],
      }),
      f({
        id: "e2",
        category: "domestic_violence_assessment",
        title: "Deterioro cognitivo del testador",
        description:
          "El dictamen psiquiátrico confirma deterioro cognitivo moderado a severo del testador.",
        severity: "critical",
        evidence_refs: ["doc-psiquiatria"],
        citations: ["CCF art. 1313"],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("e2"); // strongest survives
    expect(out[0]._alias_categories).toEqual(["custody_best_interest_analysis"]);
    expect(out[0].evidence_refs).toEqual(
      expect.arrayContaining(["doc-neuropsicologia", "doc-psiquiatria"]),
    );
    expect(out[0].citations).toEqual(expect.arrayContaining(["CCF art. 1306", "CCF art. 1313"]));
    const meta = out[0].metadata as Record<string, unknown>;
    expect(meta.merged_categories).toEqual(
      expect.arrayContaining(["domestic_violence_assessment", "custody_best_interest_analysis"]),
    );
  });

  it("merges across categories when evidence is shared even if wording differs slightly", () => {
    const out = consolidateFindings([
      f({
        id: "a",
        category: "capacidad_testamentaria",
        title: "Deterioro cognitivo moderado a severo del testador",
        evidence_refs: ["doc-7"],
      }),
      f({
        id: "b",
        category: "influencia_indebida",
        title: "Deterioro cognitivo severo a moderado del testador",
        evidence_refs: ["doc-7"],
      }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("still refuses to merge across categories without corroboration", () => {
    const out = consolidateFindings([
      f({ id: "a", category: "procesal", title: "Notificación fuera de plazo" }),
      f({ id: "b", category: "evidencia", title: "Notificación fuera de plazo" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("does not merge different issues that merely share one evidence document", () => {
    const out = consolidateFindings([
      f({
        id: "a",
        category: "capacidad_testamentaria",
        title: "Deterioro cognitivo del testador",
        evidence_refs: ["doc-1"],
      }),
      f({
        id: "b",
        category: "formalidades",
        title: "Ausencia de firma de dos testigos instrumentales",
        evidence_refs: ["doc-1"],
      }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  // Regression: a real completed-case export produced two same-category
  // findings — "Competencia del Juzgado" and "Competencia de la autoridad"
  // — that cite the literal identical quoted sentence from the sentencia,
  // yet the title wording is different enough (Jaccard ~0.33) to miss both
  // the title-similarity threshold (0.55) AND the title-fallback threshold
  // (0.4) that gates the description check. Before this fix, the
  // same-category branch of isSameIssue never looked at evidence at all, so
  // this pair never merged. A verbatim shared quote must be enough on its
  // own regardless of title wording.
  it("merges same-category findings that cite the identical quoted evidence even when titles differ", () => {
    const QUOTE =
      "El Juzgado Segundo de Distrito en Materia Penal resulta competente para conocer del presente asunto conforme al artículo 37 de la Ley de Amparo.";
    const out = consolidateFindings([
      f({
        id: "a",
        category: "Amparo",
        title: "Competencia del Juzgado",
        description: "Se analiza la competencia territorial del órgano jurisdiccional.",
        evidence_refs: [{ label: "Fragmento de la sentencia", quote: QUOTE, doc_id: "doc-1" }],
      }),
      f({
        id: "b",
        category: "Amparo",
        title: "Competencia de la autoridad",
        description:
          "Se revisa si la autoridad responsable tenía competencia para el acto reclamado.",
        evidence_refs: [{ label: "Cita textual de la resolución", quote: QUOTE, doc_id: "doc-1" }],
      }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("still keeps same-category findings separate when their quotes merely share a short common phrase", () => {
    const out = consolidateFindings([
      f({
        id: "a",
        category: "Amparo",
        title: "Competencia del Juzgado",
        evidence_refs: [{ quote: "el juez ordeno", doc_id: "doc-1" }],
      }),
      f({
        id: "b",
        category: "Amparo",
        title: "Notificación fuera de plazo procesal",
        evidence_refs: [{ quote: "el juez ordeno", doc_id: "doc-2" }],
      }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  // Regression: cross-category sharesEvidence() used to sign evidence_refs
  // entries by JSON.stringify-ing the WHOLE {label,quote,doc_id} object, so
  // two engines citing the identical quote under differently worded labels
  // never registered as shared evidence, even with matching titles.
  it("recognizes cross-category shared evidence even when the label wording differs", () => {
    const QUOTE =
      "El quejoso compareció ante la autoridad responsable y ofreció el testimonio correspondiente.";
    const out = consolidateFindings([
      f({
        id: "a",
        category: "Testimonio de Testigo",
        title: "Existencia del Acto Reclamado",
        evidence_refs: [{ label: "Declaración testimonial", quote: QUOTE, doc_id: "doc-1" }],
      }),
      f({
        id: "b",
        category: "Conventionality Pro Persona",
        title: "Existencia del Acto Reclamado",
        evidence_refs: [
          { label: "Acta de audiencia constitucional", quote: QUOTE, doc_id: "doc-1" },
        ],
      }),
    ]);
    expect(out).toHaveLength(1);
  });

  // Regression: a real completed-case export (Amparo Directo Penal 1/2026)
  // had two agents (chain_of_custody, witness_credibility) independently
  // cite the exact same sentence — the quotes differ only by a redacted
  // `******` name token, which normalizeText's alnum-only filter strips
  // entirely, so the two quotes normalize BYTE-IDENTICAL. But one agent's
  // evidence_ref had already been enriched with `document_id` by a later
  // citation-verification pass and the other hadn't, so a doc_id::quote
  // compound signature produced two different keys ("uuid::quote" vs.
  // "::quote") for the same fact and the pair never merged, even with
  // byte-identical titles. A verified quote match is strong enough on its
  // own — doc_id must never be required on top of it.
  it("merges a cross-category pair whose quotes normalize identically even when only one side carries document_id", () => {
    const q1 =
      "la responsable consideró infundados los agravios vertidos contra el testimonio de ****** ****** ******* acerca de las fotografías de los lugares de entrega de los tambos con mosquiticida";
    const q2 =
      "la responsable consideró infundados los agravios vertidos contra el testimonio de ****** ****** ******* ********, acerca de las fotografías de los lugares de entrega de los tambos con mosquiticida";
    const out = consolidateFindings([
      f({
        id: "a",
        category: "Cadena de Custodia",
        title: "Inconsistencias en la valoración de pruebas",
        evidence_refs: [
          { doc_n: 1, quote: q1, document_id: "465d2d38-0974-400a-b926-066db35674e2" },
          { doc_n: 1, quote: "otra cita distinta sin relación" },
        ],
      }),
      f({
        id: "b",
        category: "Testimonio de Testigo",
        title: "Inconsistencias en la valoración de pruebas",
        evidence_refs: [{ doc_n: 1, quote: q2 }],
      }),
    ]);
    expect(out).toHaveLength(1);
  });
});

// Canonical Reconciliation Design (2026-08-16), P2 §10 — isGroundedByTextOverlap
// is the soft-grounding check used by litigation.server.ts's Litigation
// Strategy Center to flag (never silently drop) a synthesis-engine claim
// that shares no textual relationship to what a DIFFERENT, addFindings-
// routed producer already knows about the same case.
describe("isGroundedByTextOverlap", () => {
  it("returns true when the text meaningfully overlaps a candidate", () => {
    const result = isGroundedByTextOverlap(
      "Falta el acta de notificación personal al quejoso",
      ["No obra en el expediente el acta de notificación personal", "Otro hallazgo sin relación"],
    );
    expect(result).toBe(true);
  });

  it("returns false when there is no meaningful overlap with any candidate", () => {
    const result = isGroundedByTextOverlap("Falta el peritaje en criminalística de campo", [
      "El testigo declaró sobre el color del vehículo",
    ]);
    expect(result).toBe(false);
  });

  it("returns null (not false) when there are no candidates to compare against — absence of data is not evidence of a mismatch", () => {
    expect(isGroundedByTextOverlap("Falta el acta de notificación", [])).toBeNull();
  });

  it("returns null for empty/whitespace-only text", () => {
    expect(isGroundedByTextOverlap("   ", ["algo relevante aquí"])).toBeNull();
  });

  it("respects a custom threshold", () => {
    const text = "Falta el acta de notificación personal";
    const candidate = "Acta de notificación no localizada en el expediente";
    // A very strict threshold should reject what the default threshold accepts.
    expect(isGroundedByTextOverlap(text, [candidate], 0.9)).toBe(false);
    expect(isGroundedByTextOverlap(text, [candidate], SOFT_GROUNDING_THRESHOLD)).toBe(true);
  });
});

describe("finding dedupe — contained quote boundaries", () => {
  it("does not merge distinct holdings merely because one quote contains the other", () => {
    const sharedSentence =
      "El Pleno de la Suprema Corte es competente para conocer del presente asunto.";
    const out = consolidateFindings([
      f({
        id: "competence",
        category: "Amparo",
        title: "Competencia de la Suprema Corte",
        description: "Se establece qué órgano jurisdiccional conoce del recurso.",
        evidence_refs: [{ quote: sharedSentence, document_id: "doc-1" }],
      }),
      f({
        id: "tax",
        category: "Amparo",
        title: "Tratamiento fiscal del organismo",
        description: "Se analiza si el organismo público está sujeto al impuesto predial.",
        evidence_refs: [{
          quote: `${sharedSentence} En un apartado distinto se estudian las obligaciones fiscales del organismo.`,
          document_id: "doc-1",
        }],
      }),
    ]);

    expect(out.map((row) => row.id)).toEqual(["competence", "tax"]);
  });

  it("still merges contained quotes when the propositions also agree", () => {
    const shortQuote =
      "La autoridad omitió notificar personalmente la resolución al quejoso.";
    const out = consolidateFindings([
      f({
        id: "a",
        category: "Amparo",
        title: "Omisión de notificación personal",
        description: "La resolución no fue notificada personalmente.",
        evidence_refs: [{ quote: shortQuote }],
      }),
      f({
        id: "b",
        category: "Amparo",
        title: "Falta de notificación personal",
        description: "Se omitió la notificación personal de la resolución.",
        evidence_refs: [{ quote: `${shortQuote} La omisión consta en autos.` }],
      }),
    ]);

    expect(out).toHaveLength(1);
  });
});

describe("Final Reportable Finding Deduplication by canonical_finding_id", () => {
  it("Test 1: collapses multiple findings sharing the same canonical_finding_id into exactly 1 surviving finding", async () => {
    const { dedupeReportableFindingsByCanonicalId } = await import("../finding-dedupe");
    const rawFindings: Array<Record<string, unknown>> = [
      {
        id: "f-001",
        canonical_finding_id: "AM_NOTIF_DEF_01",
        title: "Defecto en la notificación personal",
        category: "procedural_integrity",
        severity: "high",
        confidence: 0.95,
        source_module: "engine:procedural_compliance",
        source_quote: "No se realizó la notificación en términos del artículo 27 de la Ley de Amparo.",
        evidence_refs: [
          { doc_id: "doc-1", page: 4, quote: "No se realizó la notificación en términos del artículo 27 de la Ley de Amparo." },
        ],
        source_doc_ids: ["doc-1"],
      },
      {
        id: "f-002",
        canonical_finding_id: "AM_NOTIF_DEF_01",
        title: "Falta de notificación al quejoso",
        category: "constitutional_issue",
        severity: "critical",
        confidence: 0.8,
        source_module: "report_writer:constitutional_issue",
        evidence_refs: [
          { doc_id: "doc-2", page: 12, quote: "Se omitió correr traslado con copia de la demanda." },
        ],
        source_doc_ids: ["doc-2"],
      },
    ];

    const result = dedupeReportableFindingsByCanonicalId(rawFindings);

    expect(result.deduped.length).toBe(1);
    expect(result.duplicatesFound).toBe(1);
    expect(result.final_reportable_canonical_ids_unique).toBe(true);

    const survivor = result.deduped[0];
    expect(survivor.canonical_finding_id).toBe("AM_NOTIF_DEF_01");
    // Unions evidence refs from both
    expect((survivor.evidence_refs as unknown[]).length).toBe(2);
    // Unions source doc ids from both
    expect((survivor.source_doc_ids as string[])).toContain("doc-1");
    expect((survivor.source_doc_ids as string[])).toContain("doc-2");
    // Contains aliases
    expect(survivor._alias_ids).toContain("f-002");
    expect(survivor._alias_titles).toContain("Falta de notificación al quejoso");
  });

  it("Test 2: judicial holding candidate wins over speculative candidate regardless of numerical severity", async () => {
    const { dedupeReportableFindingsByCanonicalId } = await import("../finding-dedupe");
    const rawFindings: Array<Record<string, unknown>> = [
      {
        id: "f-speculative",
        canonical_finding_id: "PEN_INCONST_ART470",
        title: "Posible inconstitucionalidad del artículo 470",
        category: "constitutional_issue",
        severity: "critical",
        confidence: 0.95,
        audit_classification: "POTENTIAL_ISSUE",
        proposition_type: "argument",
        source_module: "analyzer:constitutional",
      },
      {
        id: "f-holding",
        canonical_finding_id: "PEN_INCONST_ART470",
        title: "Inconstitucionalidad del artículo 470 del Código Nacional",
        category: "constitutional_issue",
        severity: "medium",
        confidence: 0.85,
        audit_classification: "VERIFIED_COURT_HOLDING",
        proposition_type: "holding",
        source_module: "engine:decision_core",
        source_quote: "Esta Primera Sala declara la inconstitucionalidad del precepto impugnado.",
        evidence_refs: [
          { doc_id: "sentencia-scjn", page: 45, quote: "Esta Primera Sala declara la inconstitucionalidad del precepto impugnado." },
        ],
      },
    ];

    const result = dedupeReportableFindingsByCanonicalId(rawFindings);

    expect(result.deduped.length).toBe(1);
    const survivor = result.deduped[0];
    // The verified judicial holding must win
    expect(survivor.id).toBe("f-holding");
    expect(survivor.title).toBe("Inconstitucionalidad del artículo 470 del Código Nacional");
    expect(survivor.audit_classification).toBe("VERIFIED_COURT_HOLDING");
  });

  it("Test 3: distinct canonical IDs are never merged", async () => {
    const { dedupeReportableFindingsByCanonicalId } = await import("../finding-dedupe");
    const rawFindings: Array<Record<string, unknown>> = [
      {
        id: "f-1",
        canonical_finding_id: "CANONICAL_AAA",
        title: "Violación a la cadena de custodia",
        source_module: "engine:chain_of_custody",
      },
      {
        id: "f-2",
        canonical_finding_id: "CANONICAL_BBB",
        title: "Violación al principio de inmediación",
        source_module: "engine:procedural_compliance",
      },
    ];

    const result = dedupeReportableFindingsByCanonicalId(rawFindings);

    expect(result.deduped.length).toBe(2);
    expect(result.duplicatesFound).toBe(0);
    expect(result.final_reportable_canonical_ids_unique).toBe(true);
  });

  it("Test 4: generates complete duplicate audit logging provenance", async () => {
    const { dedupeReportableFindingsByCanonicalId } = await import("../finding-dedupe");
    const rawFindings: Array<Record<string, unknown>> = [
      {
        id: "f-alpha",
        canonical_finding_id: "NOTIF_01",
        title: "Defecto de Notificación",
        category: "procedural",
        source_module: "engine:analyzers",
        evidence_refs: [{ citation_id: "cit-1", doc_id: "d1" }],
      },
      {
        id: "f-beta",
        canonical_finding_id: "NOTIF_01",
        title: "Omisión de Notificación",
        category: "constitutional",
        source_module: "report_writer",
        evidence_refs: [{ citation_id: "cit-2", doc_id: "d2" }],
      },
      {
        id: "f-gamma",
        canonical_finding_id: "NOTIF_01",
        title: "Nulidad de Notificación",
        category: "litigation",
        source_module: "engine:litigation",
        evidence_refs: [{ citation_id: "cit-3", doc_id: "d3" }],
      },
    ];

    const result = dedupeReportableFindingsByCanonicalId(rawFindings);

    expect(result.deduped.length).toBe(1);
    expect(result.duplicatesFound).toBe(2);
    expect(result.duplicateAudit.length).toBe(1);

    const audit = result.duplicateAudit[0];
    expect(audit.canonical_id).toBe("NOTIF_01");
    expect(audit.duplicate_finding_ids).toEqual(["f-alpha", "f-beta", "f-gamma"]);
    expect(audit.originating_agents).toContain("engine:analyzers");
    expect(audit.originating_agents).toContain("report_writer");
    expect(audit.originating_agents).toContain("engine:litigation");
    expect(audit.citation_ids).toContain("cit-1");
    expect(audit.citation_ids).toContain("cit-2");
    expect(audit.citation_ids).toContain("cit-3");
  });
});

describe("Canonical Source Document Identity & Corroboration Engine", () => {
  it("Scenario A: same document with different display names resolves to 1 canonical source", async () => {
    const { normalizeCanonicalSources, resolveCanonicalSourceId } = await import("../canonical-source-identity");
    const rawDocs = [
      {
        id: "doc-uuid-001",
        filename: "sentencia_primera_instancia.pdf",
        display_name: "Sentencia Definitiva 123/2024",
        content_hash: "hash_sentencia_111111",
        metadata: { ocr_title: "JUZGADO PRIMERO CIVIL - SENTENCIA" },
      },
    ];

    const audit = normalizeCanonicalSources(rawDocs);

    expect(audit.metrics.unique_source_count).toBe(1);
    expect(audit.metrics.independent_source_count).toBe(1);

    // All names/aliases resolve to the same canonical_source_id
    expect(resolveCanonicalSourceId("doc-uuid-001", audit)).toBe("doc-uuid-001");
    expect(resolveCanonicalSourceId("sentencia_primera_instancia.pdf", audit)).toBe("doc-uuid-001");
    expect(resolveCanonicalSourceId("Sentencia Definitiva 123/2024", audit)).toBe("doc-uuid-001");
    expect(resolveCanonicalSourceId("JUZGADO PRIMERO CIVIL - SENTENCIA", audit)).toBe("doc-uuid-001");
  });

  it("Scenario B: same file uploaded twice (same hash) preserves 2 records but counts 1 independent source", async () => {
    const { normalizeCanonicalSources } = await import("../canonical-source-identity");
    const rawDocs = [
      {
        id: "doc-first",
        filename: "amparo_demanda.pdf",
        content_hash: "sha256_identical_hash_99999",
      },
      {
        id: "doc-reupload",
        filename: "amparo_demanda_copia.pdf",
        content_hash: "sha256_identical_hash_99999",
      },
    ];

    const audit = normalizeCanonicalSources(rawDocs);

    expect(audit.canonical_sources.length).toBe(2); // Both records preserved
    expect(audit.metrics.raw_source_records).toBe(2);
    expect(audit.metrics.duplicate_hash_count).toBe(1);
    expect(audit.metrics.independent_source_count).toBe(1); // Only 1 independent evidentiary source

    const dup = audit.canonical_sources.find((d) => d.document_id === "doc-reupload");
    expect(dup?.is_duplicate_physical_source).toBe(true);
    expect(dup?.duplicate_of_document_id).toBe("doc-first");
    expect(dup?.canonical_source_id).toBe("doc-first");
  });

  it("Scenario C: same document cited on 10 pages produces 10 citations and 1 independent source", async () => {
    const { evaluateSourceCorroboration } = await import("../canonical-source-identity");
    const citationSourceIds = Array.from({ length: 10 }, () => "doc-scjn-resolution");

    const corrob = evaluateSourceCorroboration(citationSourceIds, "es");

    expect(corrob.citation_count).toBe(10);
    expect(corrob.independent_source_count).toBe(1);
    expect(corrob.independent_corroboration).toBe(false);
    expect(corrob.corroboration_prose).toContain("sustentado por una resolución judicial con múltiples pasajes relevantes");
    expect(corrob.corroboration_prose).not.toContain("documentos independientes");
  });

  it("Scenario D: two genuinely different PDFs count as 2 independent sources with corroboration", async () => {
    const { normalizeCanonicalSources, evaluateSourceCorroboration } = await import("../canonical-source-identity");
    const rawDocs = [
      {
        id: "doc-sentencia",
        filename: "sentencia.pdf",
        content_hash: "hash_sentencia_abc",
      },
      {
        id: "doc-peritaje",
        filename: "peritaje_contable.pdf",
        content_hash: "hash_peritaje_xyz",
      },
    ];

    const audit = normalizeCanonicalSources(rawDocs);

    expect(audit.metrics.unique_source_count).toBe(2);
    expect(audit.metrics.independent_source_count).toBe(2);

    const corrob = evaluateSourceCorroboration(["doc-sentencia", "doc-peritaje"], "es");
    expect(corrob.independent_corroboration).toBe(true);
    expect(corrob.corroboration_prose).toContain("2 documentos independientes corroboran el hallazgo");
  });

  it("Scenario E: draft and signed version with different hashes remain separate documents linked by family", async () => {
    const { normalizeCanonicalSources } = await import("../canonical-source-identity");
    const rawDocs = [
      {
        id: "doc-draft",
        filename: "proyecto_sentencia.pdf",
        content_hash: "hash_draft_111",
        document_family_id: "family-sentencia-2024",
        document_version: 1,
      },
      {
        id: "doc-signed",
        filename: "sentencia_firmada_engrose.pdf",
        content_hash: "hash_signed_222",
        document_family_id: "family-sentencia-2024",
        document_version: 2,
        supersedes_document_id: "doc-draft",
      },
    ];

    const audit = normalizeCanonicalSources(rawDocs);

    expect(audit.metrics.unique_source_count).toBe(2);
    expect(audit.metrics.independent_source_count).toBe(2);
    expect(audit.canonical_sources[1].supersedes_document_id).toBe("doc-draft");
  });

  it("Scenario F: OCR label differing from filename is treated as alias only", async () => {
    const { normalizeCanonicalSources, resolveCanonicalSourceId } = await import("../canonical-source-identity");
    const rawDocs = [
      {
        id: "doc-ocr-diff",
        filename: "scan_00019283.pdf",
        metadata: { ocr_title: "ACTA DE AUDIENCIA INICIAL DE CONTROL DE DETENCIÓN" },
      },
    ];

    const audit = normalizeCanonicalSources(rawDocs);

    expect(audit.metrics.unique_source_count).toBe(1);
    expect(resolveCanonicalSourceId("ACTA DE AUDIENCIA INICIAL DE CONTROL DE DETENCIÓN", audit)).toBe("doc-ocr-diff");
    expect(resolveCanonicalSourceId("scan_00019283.pdf", audit)).toBe("doc-ocr-diff");
  });

  it("Scenario G: multiple engines citing the same source with different alias strings normalize to one canonical source", async () => {
    const { normalizeCanonicalSources, normalizeCitationsWithCanonicalSources } = await import("../canonical-source-identity");
    const rawDocs = [
      {
        id: "doc-adr",
        filename: "ADR_311_2015.pdf",
        display_name: "Amparo Directo en Revisión 311/2015",
        metadata: { ocr_title: "SUPREMA CORTE DE JUSTICIA - ADR 311/2015" },
      },
    ];

    const audit = normalizeCanonicalSources(rawDocs);

    const citations = [
      { document_id: "doc-adr", page: 10, quote: "Cita 1" },
      { filename: "ADR_311_2015.pdf", page: 15, quote: "Cita 2" },
      { source_document_id: "SUPREMA CORTE DE JUSTICIA - ADR 311/2015", page: 20, quote: "Cita 3" },
    ];

    const normalized = normalizeCitationsWithCanonicalSources(citations, audit);

    expect(normalized.length).toBe(3);
    const canonicalIds = normalized.map((n) => n.canonical_source_id);
    expect(new Set(canonicalIds).size).toBe(1);
    expect(canonicalIds[0]).toBe("doc-adr");
  });

  it("Scenario H: validates all platform-wide invariants", async () => {
    const { normalizeCanonicalSources } = await import("../canonical-source-identity");
    const rawDocs = [
      { id: "d1", filename: "doc1.pdf", content_hash: "hash_aaa" },
      { id: "d2", filename: "doc2.pdf", content_hash: "hash_bbb" },
      { id: "d3", filename: "doc1_copy.pdf", content_hash: "hash_aaa" }, // duplicate upload
    ];

    const audit = normalizeCanonicalSources(rawDocs);

    expect(audit.invariants.unique_source_count_valid).toBe(true);
    expect(audit.invariants.independent_source_count_valid).toBe(true);
    expect(audit.invariants.same_document_id_cannot_count_twice).toBe(true);
    expect(audit.invariants.same_document_hash_cannot_create_independent_corroboration).toBe(true);
    expect(audit.invariants.all_invariants_passed).toBe(true);
  });
});
