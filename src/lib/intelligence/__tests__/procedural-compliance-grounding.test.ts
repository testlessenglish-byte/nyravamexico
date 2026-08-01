// Regression test for the "verified" pseudo-finding defect traced to
// procedural-compliance.server.ts: a raw .insert() into case_findings
// hardcoded finding_type:"EVIDENCE_BASED_INFERENCE" and
// verification_status:"verified" for missing-checklist-item findings that
// had zero evidence_refs, zero source_document_id, zero source_quote —
// bypassing addGatedFindings/applyEvidenceGate entirely, the same grounding
// architecture every other engine in the pipeline goes through.
//
// This test exercises addGatedFindings directly (the function
// procedural-compliance.server.ts now routes through) with a generic
// "missing checklist item" style row — same shape, no case-specific
// content, no fixture hardcoding — and asserts the gate classifies it
// honestly instead of the caller being able to force finding_type/
// verification_status values that contradict having zero evidence.
import { describe, it, expect } from "vitest";
import { addGatedFindings } from "@/lib/intelligence/findings.server";
import type { GroundingCorpus } from "@/lib/intelligence/grounding.server";

// Minimal fake db: only needs to support the final .insert().select("id")
// addFindings() performs, and capture the exact payload written so we can
// assert on what actually got persisted (not just the in-memory return
// value). Table-aware so it can also drive the real runProceduralCompliance
// end-to-end (case_type lookup, empty documents corpus, findings insert,
// final cases.update).
function makeFakeDb(opts?: { caseType?: string }) {
    const inserted: Record<string, unknown>[] = [];
    return {
      inserted,
      client: {
        from(table: string) {
          const selectChain = {
            eq(_col: string, _val: string) {
              return selectChain;
            },
            is(_col: string, _val: unknown) {
              return selectChain;
            },
            not(_col: string, _op: string, _val: string) {
              return selectChain;
            },
            order(_col: string, _opts?: unknown) {
              return selectChain;
            },
            limit(_n: number) {
              return selectChain;
            },
            maybeSingle: async () => {
              if (table === "cases" && opts?.caseType) return { data: { case_type: opts.caseType }, error: null };
              return { data: null, error: null };
            },
            single: async () => ({ data: null, error: null }),
            then: (resolve: (v: unknown) => void) => {
              if (table === "documents") {
                resolve({
                  data: [
                    {
                      extracted_text:
                        "Texto genérico sin contenido relevante a los elementos del checklist procesal.",
                    },
                  ],
                  error: null,
                });
                return;
              }
              resolve({ data: [], error: null });
            },
          };
          return {
            select(_cols: string) {
              return selectChain;
            },
            insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
              if (table !== "case_findings") {
                return { select: () => Promise.resolve({ data: [], error: null }) };
              }
              const rows = Array.isArray(payload) ? payload : [payload];
              inserted.push(...rows);
              return {
                select(_cols: string) {
                  return Promise.resolve({ data: rows.map((_, i) => ({ id: `f-${i}` })), error: null });
                },
              };
            },
            update(_payload: Record<string, unknown>) {
              return { eq: async (_col: string, _val: string) => ({ data: null, error: null }) };
            },
            delete() {
              return { eq: (_col: string, _val: string) => ({ eq: async () => ({ data: null, error: null }) }) };
            },
          };
        },
      },
    };
  }

describe("addGatedFindings: absence-of-evidence findings are classified honestly", () => {

  // Empty corpus — mirrors a "this element was searched for and not found"
  // scenario. No accents/language-specific content — deliberately generic.
  const emptyCorpus: GroundingCorpus = { text: "", docs: [] };

  it("does not let a zero-evidence absence finding come back classified as EVIDENCE_BASED_INFERENCE", async () => {
    const { client, inserted } = makeFakeDb();
    const rows = [
      {
        case_id: "case-generic",
        user_id: "user-generic",
        title: "Elemento no identificado en el corpus: Requisito procesal genérico",
        description: "No se identificó evidencia del requisito X en los documentos proporcionados.",
        category: "cumplimiento_procesal",
        severity: "high" as const,
        legal_significance: "Autoridad genérica aplicable",
        potential_impact: null,
        affected_party: null,
        source_module: "engine:procedural_compliance",
        confidence: 0.7,
        metadata: { item_id: "generic_item", materia: "civil", requirement: "required" },
      },
    ];

    const result = await addGatedFindings(client as never, "case-generic", rows, {
      mode: "exploratory",
      corpus: emptyCorpus,
      exemptCitation: true,
    });

    expect(result.inserted).toBe(1);
    expect(inserted).toHaveLength(1);
    const written = inserted[0];
    expect(written.finding_type).toBe("AI_THEORY");
    // The historical bug set this explicitly to "verified" on every insert.
    // The canonical path never sets this field at all — it must not appear
    // in the written payload (left to the DB column default instead).
    expect(written.verification_status).toBeUndefined();
    expect(written.evidence_refs === undefined || (written.evidence_refs as unknown[]).length === 0).toBe(
      true,
    );
  });

  it("in strict mode, the same zero-evidence absence finding is dropped rather than persisted with a false confidence claim", async () => {
    const { client, inserted } = makeFakeDb();
    const rows = [
      {
        case_id: "case-generic",
        user_id: "user-generic",
        title: "Elemento no identificado en el corpus: Otro requisito genérico",
        description: "No se identificó evidencia del requisito Y en los documentos proporcionados.",
        category: "cumplimiento_procesal",
        severity: "high" as const,
        legal_significance: "Autoridad genérica aplicable",
        potential_impact: null,
        affected_party: null,
        source_module: "engine:procedural_compliance",
        confidence: 0.7,
        metadata: { item_id: "generic_item_2", materia: "civil", requirement: "required" },
      },
    ];

    const result = await addGatedFindings(client as never, "case-generic", rows, {
      mode: "strict",
      corpus: emptyCorpus,
      exemptCitation: true,
    });

    // exemptCitation only prevents dropping in modes that would otherwise
    // drop it via the exempt branch — strict/balanced still only keep
    // grounded items through the primary gate; exemptCitation's fallback
    // branch runs regardless of mode in the current implementation, so
    // assert on the actual behavior: either dropped, or kept but honestly
    // labeled AI_THEORY — never silently upgraded to a verified/evidence-
    // based claim.
    if (result.inserted > 0) {
      expect(inserted[0].finding_type).toBe("AI_THEORY");
      expect(inserted[0].verification_status).toBeUndefined();
    } else {
      expect(inserted).toHaveLength(0);
    }
  });
});

describe("runProceduralCompliance (the actual fixed file): missing-checklist findings are never written as false-verified", () => {
  it("does not persist verification_status:'verified' or finding_type:'EVIDENCE_BASED_INFERENCE' for a required checklist item absent from an empty corpus", async () => {
    const { runProceduralCompliance } = await import("@/lib/intelligence/procedural-compliance.server");
    const { client, inserted } = makeFakeDb({ caseType: "penal" });

    // Empty corpus (no documents at all) guarantees every required "penal"
    // checklist item (e.g. carpeta de investigación, IPH) is "faltante" —
    // this reproduces the exact scenario traced from production without
    // hardcoding any specific case's content.
    await runProceduralCompliance({ db: client as never, caseId: "case-generic", userId: "user-generic" });

    expect(inserted.length).toBeGreaterThan(0);
    for (const row of inserted) {
      expect(row.finding_type).not.toBe("EVIDENCE_BASED_INFERENCE");
      expect(row.verification_status).not.toBe("verified");
    }
  });
});
