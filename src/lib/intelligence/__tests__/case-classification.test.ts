// Regression/acceptance tests for automatic case classification
// (case-classification.server.ts) — "the user should not have to manually
// select the case type when the uploaded source documents establish it,"
// with the same evidence-gating discipline as completed-case-audit.server.ts:
// a field is CONFIRMED only when a document was actually matched and the
// matched span independently re-locates in that document's own text.
//
// Exercises the REAL, pure classifyCaseFromDocuments() (no IO, no LLM call)
// against the five behaviors the spec explicitly required:
//   1. source-confirmed classification succeeds
//   2. unsupported (low/no-signal) classification is rejected, not guessed
//   3. conflicting sources are surfaced, not silently picked
//   4. insufficient data never produces a guessed classification
//   5. a manual override that conflicts with a CONFIRMED source
//      classification can never be silently re-overwritten by a later run
//      (exercises the real runCaseClassification() DB write-path with a
//      fake db, following this codebase's established mocking convention —
//      see finding-not-established-write-path.test.ts).
import { describe, it, expect } from "vitest";
import {
  classifyCaseFromDocuments,
  runCaseClassification,
  resolveVerifiedProceedingType,
  type DocInput,
} from "@/lib/intelligence/case-classification.server";

// Modeled on mx-case-classifier.test.ts's proven amparo corpus (real
// keyword density that resolveMxCaseType classifies as amparo with
// source: "content" and confidence >= 0.3), with a real Mexican caption,
// court, finality language, and a labeled party added so every field this
// module extracts has something genuine to find.
const AMPARO_TEXT = `
  AMPARO DIRECTO EN REVISIÓN 3684/2012
  Expediente número 3684/2012.
  TRIBUNAL COLEGIADO EN MATERIA ADMINISTRATIVA DEL PRIMER CIRCUITO
  QUEJOSO: Juan Pérez López
  Juicio de amparo indirecto. Quejoso promueve contra acto reclamado de
  autoridad responsable. Suspensión definitiva concedida. Se invocan
  derechos humanos y control de convencionalidad como fundamento del
  concepto de violación. Ley de amparo aplicable. Amparo indirecto.
  El presente asunto ha causado ejecutoria.
`.repeat(2);

const CIVIL_TEXT = `
  JUICIO ORDINARIO CIVIL 55/2020
  Expediente 55/2020.
  El actor demanda responsabilidad civil por incumplimiento de contrato de
  compraventa. Se reclama daño moral conforme al Código Civil aplicable.
  La juez de lo civil admite la demanda entablada por el actor.
`.repeat(2);

const NEUTRAL_TEXT = `
  Este documento contiene información general de oficina sin relación con
  ningún procedimiento judicial específico. Reunión programada para revisar
  presupuesto anual y logística de archivo.
`.repeat(2);

function doc(id: string, filename: string, text: string): DocInput {
  return { id, filename, extracted_text: text };
}

describe("classifyCaseFromDocuments: source-confirmed classification succeeds", () => {
  it("confirms case_type, proceeding_type, expediente_number, court, concluded_status, and parties from real source text, each with a re-locatable quote", () => {
    const result = classifyCaseFromDocuments([doc("doc-1", "sentencia.pdf", AMPARO_TEXT)]);
    const byField = new Map(result.fields.map((f) => [f.field, f]));

    const caseType = byField.get("case_type")!;
    expect(caseType.status).toBe("CONFIRMED");
    expect(caseType.value).toBe("amparo");
    expect(caseType.source?.document_id).toBe("doc-1");
    expect(caseType.source?.quote.length).toBeGreaterThan(0);

    const proceeding = byField.get("proceeding_type")!;
    expect(proceeding.status).toBe("CONFIRMED");
    expect(proceeding.value).toMatch(/AMPARO DIRECTO EN REVISI[ÓO]N/);
    expect(proceeding.source?.quote).toMatch(/3684\/2012/);

    const expediente = byField.get("expediente_number")!;
    expect(expediente.status).toBe("CONFIRMED");
    expect(expediente.value).toBe("3684/2012");

    const court = byField.get("court")!;
    expect(court.status).toBe("CONFIRMED");
    expect(court.value).toMatch(/TRIBUNAL COLEGIADO/);

    const concluded = byField.get("concluded_status")!;
    expect(concluded.status).toBe("CONFIRMED");
    expect(concluded.value).toBe("Concluded");

    const parties = byField.get("parties")!;
    expect(parties.status).toBe("CONFIRMED");
    expect(parties.value).toContain("QUEJOSO");
    expect(parties.value).toContain("Juan P");
  });
});

describe("classifyCaseFromDocuments: unsupported classification is rejected, not guessed", () => {
  it("never surfaces resolveMxCaseType's internal fallback guess (source: 'default') as CONFIRMED", () => {
    // NEUTRAL_TEXT has no materia keyword signal at all, so
    // resolveMxCaseType() internally falls back to caseType: "civil",
    // source: "default" (see mx-case-classifier.ts). classifyCaseFromDocuments
    // must refuse to trust a "default" (no real signal) classification —
    // this is the deterministic backstop, not a prompt instruction.
    const result = classifyCaseFromDocuments([doc("doc-1", "memo.pdf", NEUTRAL_TEXT)]);
    const caseType = result.fields.find((f) => f.field === "case_type")!;
    expect(caseType.status).toBe("INSUFFICIENT_DATA");
    expect(caseType.value).toBeNull();
  });
});

describe("classifyCaseFromDocuments: conflicting sources are surfaced, never silently picked", () => {
  it("reports CONFLICT with both distinct values and their own sources when two documents disagree", () => {
    const result = classifyCaseFromDocuments([
      doc("doc-amparo", "sentencia.pdf", AMPARO_TEXT),
      doc("doc-civil", "demanda.pdf", CIVIL_TEXT),
    ]);
    const byField = new Map(result.fields.map((f) => [f.field, f]));

    const caseType = byField.get("case_type")!;
    expect(caseType.status).toBe("CONFLICT");
    expect(caseType.value).toBeNull();
    const caseTypeValues = caseType.conflicts.map((c) => c.value).sort();
    expect(caseTypeValues).toEqual(["amparo", "civil"]);
    for (const c of caseType.conflicts) {
      expect(c.source.document_id).toBeTruthy();
      expect(c.source.quote.length).toBeGreaterThan(0);
    }

    const proceeding = byField.get("proceeding_type")!;
    expect(proceeding.status).toBe("CONFLICT");
    expect(proceeding.conflicts).toHaveLength(2);

    const expediente = byField.get("expediente_number")!;
    expect(expediente.status).toBe("CONFLICT");
    const expedienteValues = expediente.conflicts.map((c) => c.value).sort();
    expect(expedienteValues).toEqual(["3684/2012", "55/2020"]);
  });
});

describe("classifyCaseFromDocuments: insufficient data never produces a guessed classification", () => {
  it("every field is INSUFFICIENT_DATA when the corpus establishes nothing, with no invented value or source", () => {
    const result = classifyCaseFromDocuments([doc("doc-1", "memo.pdf", NEUTRAL_TEXT)]);
    for (const field of result.fields) {
      expect(field.status).toBe("INSUFFICIENT_DATA");
      expect(field.value).toBeNull();
      expect(field.source).toBeNull();
      expect(field.conflicts).toEqual([]);
    }
  });

  it("a document with no extracted text at all is never a source of a guessed value", () => {
    const result = classifyCaseFromDocuments([doc("doc-1", "unextracted.pdf", null as never)]);
    for (const field of result.fields) {
      expect(field.status).toBe("INSUFFICIENT_DATA");
    }
  });
});

function makeFakeDb(opts: {
  docs: DocInput[];
  caseRow: {
    case_type: string | null;
    jurisdiction: string | null;
    case_type_source: string | null;
  };
}) {
  const state: {
    updatePatch: Record<string, unknown> | null;
    insertedRows: Array<Record<string, unknown>>;
  } = { updatePatch: null, insertedRows: [] };
  const db = {
    from(table: string) {
      if (table === "documents") {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: opts.docs, error: null }),
            }),
          }),
        };
      }
      if (table === "case_classification_evidence") {
        return {
          delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
          insert: (rows: Array<Record<string, unknown>>) => {
            state.insertedRows = rows;
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "cases") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: opts.caseRow, error: null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              state.updatePatch = { ...state.updatePatch, ...patch };
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }), in: () => Promise.resolve({ error: null }) }),
        insert: () => Promise.resolve({ error: null }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
    },
  };
  return { db, state };
}

describe("runCaseClassification: manual override cannot be silently replaced by a later run", () => {
  it("re-classifying a case that was manually overridden away from a CONFIRMED source value writes the fresh evidence but never overwrites cases.case_type", async () => {
    const docs = [doc("doc-1", "sentencia.pdf", AMPARO_TEXT)];
    const { db, state } = makeFakeDb({
      docs,
      // The attorney previously overrode case_type to "civil" even though a
      // source classification had confirmed something else — updateCaseSettings
      // recorded this as case_type_source: "manual_override_conflicting"
      // (see resolveCaseTypeSourceConflict in cases.functions.ts).
      caseRow: {
        case_type: "civil",
        jurisdiction: null,
        case_type_source: "manual_override_conflicting",
      },
    });

    const result = await runCaseClassification(db as never, "case-1", "user-1");

    // The evidence trail is still written faithfully — a locked override
    // never suppresses or falsifies the evidence itself, only the write to
    // cases.case_type.
    const caseTypeField = result.fields.find((f) => f.field === "case_type")!;
    expect(caseTypeField.status).toBe("CONFIRMED");
    expect(caseTypeField.value).toBe("amparo");
    const evidenceRow = state.insertedRows.find((r) => r.field === "case_type")!;
    expect(evidenceRow.status).toBe("CONFIRMED");
    expect(evidenceRow.value).toBe("amparo");

    // But cases.case_type itself must never be silently overwritten once
    // manually locked — only the verification-status marker updates, so a
    // caller can surface "source says amparo, you chose civil" without the
    // override having been clobbered underneath the attorney.
    expect(state.updatePatch?.case_type).toBeUndefined();
    expect(state.updatePatch?.case_type_verification_status).toBe("CONFIRMED");
  });

  it("a case with no prior override is safely refreshed when a CONFIRMED classification arrives", async () => {
    const docs = [doc("doc-1", "sentencia.pdf", AMPARO_TEXT)];
    const { db, state } = makeFakeDb({
      docs,
      caseRow: { case_type: null, jurisdiction: null, case_type_source: null },
    });

    await runCaseClassification(db as never, "case-1", "user-1");

    expect(state.updatePatch?.case_type).toBe("amparo");
    expect(state.updatePatch?.case_type_source).toBe("source_confirmed");
  });
});

// resolveVerifiedProceedingType now goes through the combined
// resolveCaseIdentity() (see the "Fix the Verified Case Identity
// Architecture" instructions), which legitimately reads `cases` first (for
// the manual-lock precedence) before `case_classification_evidence` — the
// old single-table mock is widened accordingly. These tests exercise
// proceeding-type resolution only, so `cases` returns a benign, unlocked
// row (no case_type set, no manual override) that never affects the
// proceeding_type assertions below.
function makeEvidenceOnlyFakeDb(row: { status?: string; value?: string | null } | null) {
  return {
    from(table: string) {
      if (table === "cases") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { case_type: null, case_type_source: null, jurisdiction: null },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table !== "case_classification_evidence") throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            in: () =>
              Promise.resolve({
                data: row ? [{ field: "proceeding_type", ...row }] : [],
                error: null,
              }),
          }),
        }),
      };
    },
  };
}

describe("resolveVerifiedProceedingType: the PROCEDURAL TYPE LOCK's read-side guarantee", () => {
  it("returns the verbatim source-confirmed proceeding caption when CONFIRMED", async () => {
    const db = makeEvidenceOnlyFakeDb({ status: "CONFIRMED", value: "AMPARO DIRECTO EN REVISIÓN" });
    const result = await resolveVerifiedProceedingType(db as never, "case-1");
    expect(result).toBe("AMPARO DIRECTO EN REVISIÓN");
  });

  it("never fabricates a proceeding type — returns null for INSUFFICIENT_DATA, CONFLICT, or no evidence at all", async () => {
    expect(
      await resolveVerifiedProceedingType(
        makeEvidenceOnlyFakeDb({ status: "INSUFFICIENT_DATA", value: null }) as never,
        "case-1",
      ),
    ).toBeNull();
    expect(
      await resolveVerifiedProceedingType(
        makeEvidenceOnlyFakeDb({ status: "CONFLICT", value: null }) as never,
        "case-1",
      ),
    ).toBeNull();
    expect(
      await resolveVerifiedProceedingType(makeEvidenceOnlyFakeDb(null) as never, "case-1"),
    ).toBeNull();
  });
});
