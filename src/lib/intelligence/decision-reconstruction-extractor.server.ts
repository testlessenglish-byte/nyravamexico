// Decision Reconstruction extraction pass — Phase 3 of the "Universal
// Completed Case Legal Audit Architecture Fix."
//
// Populates a CaseDecisionReconstruction (decision-reconstruction.ts)
// DIRECTLY FROM THE CASE CORPUS, independent of anything case_findings/
// case_scores/reports already concluded — the architectural gap the
// diagnosis identified: "Completed Case" mode never independently
// reconstructs what a judicial decision actually said, it only re-grades
// whatever the ordinary engines already produced. This module is that
// independent reconstruction step.
//
// NOT YET WIRED into runCompletedCaseAudit or the main pipeline. Callable
// standalone. Wiring it in (making the audit actually consume this instead
// of case_findings) is a separate, later increment — see the doc comment
// on buildDecisionReconstruction for why this boundary matters.
//
// Reuses, rather than reimplements, every verification primitive
// completed-case-audit.server.ts already proved out: buildGroundingCorpus/
// verifyQuoteDetailed/locateQuoteInText for quote verification,
// extractCitationsFromText + verifyStatutoryCitation for legal-authority
// verification (run deterministically over already-quote-verified text,
// never asking the model to self-report a citation string in a specific
// format), and resolveProviderKeys/callGroq for the AI call itself.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { mexicoLock, groundingContract, getReportLocale } from "@/lib/mexico-lock";
import { callGroq, parseJsonLoose, GROQ_DEFAULT_MODEL } from "@/lib/groq.server";
import { resolveProviderKeys } from "@/lib/ai-key-router.server";
import { extractCitationsFromText } from "@/lib/legal-connectors/citation-extract";
import { verifyStatutoryCitation } from "@/lib/legal/citation-verification.server";
import {
  buildGroundingCorpus,
  verifyQuoteDetailed,
  type GroundingCorpus,
} from "./grounding.server";
import { locateQuoteInText, pageForOffset } from "./evidence-provenance.server";
import { SPEAKER_ROLES, PROPOSITION_TYPES, ADOPTION_STATUSES } from "./finding-taxonomy";
import {
  sourced,
  unsourced,
  emptyReconstruction,
  type CaseDecisionReconstruction,
  type EvidenceRef,
  type Sourced,
  type ReconstructedProposition,
  type PartyRoleEntry,
  type ProceduralEvent,
  type LegalAuthorityCitation,
  type PrecedentCitation,
} from "./decision-reconstruction";
import { extractPublishedThesisHoldings } from "./thesis-decision-fallback";

type Db = SupabaseClient<Database>;
const MODEL = GROQ_DEFAULT_MODEL;

const SPEAKER_ROLE_SET: ReadonlySet<string> = new Set(SPEAKER_ROLES);
const PROPOSITION_TYPE_SET: ReadonlySet<string> = new Set(PROPOSITION_TYPES);
const ADOPTION_STATUS_SET: ReadonlySet<string> = new Set(ADOPTION_STATUSES);
/** Mirrors finding-classification-gate.ts's judicial-hierarchy invariant —
 *  only a court can hold or reject-hold something. */
const JUDICIAL_SPEAKER_ROLES: ReadonlySet<string> = new Set([
  "tribunal_colegiado",
  "tribunal_local",
  "scjn",
]);

type Doc = { id: string; filename: string; extracted_text: string | null };

/** Resolves a claimed quote against the corpus, same primitive
 *  completed-case-audit.server.ts's resolveSource uses — duplicated in
 *  miniature here (rather than imported) because that function's return
 *  shape (SourceReference) is specific to that module's ClassifiedStatement
 *  contract; this one returns the EvidenceRef shape decision-
 *  reconstruction.ts's Sourced<T> expects. Same verification calls
 *  underneath (verifyQuoteDetailed, locateQuoteInText). */
function resolveEvidenceRef(
  quote: string | null | undefined,
  corpus: GroundingCorpus,
  docs: Doc[],
): EvidenceRef | null {
  if (!quote) return null;
  if (!verifyQuoteDetailed(quote, corpus).verified) return null;
  for (const doc of docs) {
    const loc = locateQuoteInText(quote, doc.extracted_text ?? "");
    if (loc) {
      return {
        document_id: doc.id,
        quote,
        label: `p.${pageForOffset(loc.start, corpus.pageChars)}`,
      };
    }
  }
  return { quote };
}

/** Converts one { ...fields, quote } item from the model's raw output into
 *  a Sourced<T> — PRESENT only when the quote actually verifies. */
function toSourced<T>(
  item: unknown,
  buildValue: (item: Record<string, unknown>) => T | null,
  corpus: GroundingCorpus,
  docs: Doc[],
): Sourced<T> | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const quote = typeof rec.quote === "string" ? rec.quote : null;
  const value = buildValue(rec);
  if (value === null) return null;
  const ref = resolveEvidenceRef(quote, corpus, docs);
  if (!ref) return unsourced("NOT_FOUND_IN_CORPUS") as Sourced<T>;
  return sourced(value, [ref]);
}

function normTaxonomyValue(v: unknown, allowed: ReadonlySet<string>): string | null {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return allowed.has(s) ? s : null;
}

/** Same downgrade the classification gate applies to persisted findings —
 *  a holding/rejected_holding attributed to a non-judicial speaker is
 *  structurally impossible, so it is downgraded to "argument" rather than
 *  trusted. Applied here too so a reconstruction can never misrepresent a
 *  party's request as a court's ruling, independent of whether the finding-
 *  generation path later applies the same check to a derived finding. */
function normalizeProposition(
  speakerRole: string | null,
  propositionType: string | null,
): string | null {
  if (
    (propositionType === "holding" || propositionType === "rejected_holding") &&
    speakerRole &&
    !JUDICIAL_SPEAKER_ROLES.has(speakerRole)
  ) {
    return "argument";
  }
  return propositionType;
}

function toProposition(
  item: unknown,
  corpus: GroundingCorpus,
  docs: Doc[],
): ReconstructedProposition | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const text = typeof rec.text === "string" ? rec.text.trim() : "";
  if (!text) return null;
  const speakerRole = normTaxonomyValue(rec.speaker_role, SPEAKER_ROLE_SET);
  const propositionTypeRaw = normTaxonomyValue(rec.proposition_type, PROPOSITION_TYPE_SET);
  const adoptionStatus = normTaxonomyValue(rec.adoption_status, ADOPTION_STATUS_SET);
  const propositionType = normalizeProposition(speakerRole, propositionTypeRaw);
  const quote = typeof rec.quote === "string" ? rec.quote : null;
  const ref = resolveEvidenceRef(quote, corpus, docs);
  if (!ref) return unsourced("NOT_FOUND_IN_CORPUS");
  return sourced(
    {
      text,
      speaker_role: speakerRole,
      proposition_type: propositionType,
      adoption_status: adoptionStatus,
    },
    [ref],
  );
}

function toStringList(arr: unknown, corpus: GroundingCorpus, docs: Doc[]): Sourced<string>[] {
  if (!Array.isArray(arr)) return [];
  const out: Sourced<string>[] = [];
  for (const item of arr) {
    const s = toSourced<string>(
      item,
      (rec) => (typeof rec.text === "string" && rec.text.trim() ? rec.text.trim() : null),
      corpus,
      docs,
    );
    if (s) out.push(s);
  }
  return out;
}

/** Deterministically derives legal-authority/precedent citations from
 *  already quote-verified text — never from a model-self-reported citation
 *  string — exactly mirroring completed-case-audit.server.ts's
 *  citationReviews pattern. */
async function deriveCitations(
  db: Db,
  verifiedTexts: string[],
  caseDate: string | null,
): Promise<{ authorities: LegalAuthorityCitation[]; precedent: PrecedentCitation[] }> {
  const authorities: LegalAuthorityCitation[] = [];
  const precedent: PrecedentCitation[] = [];
  const seenAuthority = new Set<string>();
  const seenPrecedent = new Set<string>();
  for (const text of verifiedTexts) {
    for (const c of extractCitationsFromText(text)) {
      const ref: EvidenceRef = { quote: text.slice(0, 200) };
      if (c.citationText.startsWith("Tesis:")) {
        if (seenPrecedent.has(c.citationText)) continue;
        seenPrecedent.add(c.citationText);
        precedent.push(sourced({ registry_reference: c.citationText }, [ref]));
        continue;
      }
      const m = /^Art\.\s+(\S+)(?:\s+de\s+(.+))?$/u.exec(c.citationText);
      if (!m || !m[2]) continue; // no article+authority hint — nothing to verify
      if (seenAuthority.has(c.citationText)) continue;
      seenAuthority.add(c.citationText);
      const verification = await verifyStatutoryCitation(db, {
        authorityHint: m[2],
        articleNumber: m[1],
        caseDate,
      });
      authorities.push(
        sourced(
          {
            authority_hint: m[2],
            article_number: m[1],
            verification_status: verification.status,
          },
          [ref],
        ),
      );
    }
  }
  return { authorities, precedent };
}

/**
 * Runs the decision-reconstruction extraction for one case, independent of
 * any prior analysis. Returns null on total failure (non-fatal — same
 * "never block the pipeline on this" principle as runCompletedCaseAudit).
 *
 * This function only BUILDS the reconstruction and persists it to
 * case_decision_reconstructions — it does not change case_findings, case
 * status, or anything runCompletedCaseAudit reads. Making the completed-
 * case audit actually CONSUME this reconstruction (instead of re-grading
 * case_findings) is a separate, later increment: that switch changes
 * real user-facing audit output across every materia and needs its own
 * regression pass this sandbox cannot run (no live AI/DB access here to
 * validate real reconstruction quality across the materia matrix).
 */
// CONFIRMED LIVE: pipeline-runner.server.ts's caller gates this on "does a
// case_decision_reconstructions row already exist" — a real, unbounded AI
// call over the full corpus (up to 20k chars/doc) with no client-side
// timeout. If it ever fails to persist a row (a slow/hanging provider
// response, or the whole tick getting killed by a platform-level wall-clock
// limit before this function can return), that check stays false forever
// and this expensive call re-fires on EVERY subsequent resume tick — for a
// strict/completed-case-audit case, on every single tick, competing with
// every other pipeline stage for that tick's time budget. Bounding the call
// with our own timeout (well under any platform kill timeout) means a slow
// call fails fast and predictably instead of hanging the whole tick, and
// recordFailedAttempt (below) stops the retry-every-tick loop by leaving a
// row behind either way.
const DECISION_RECONSTRUCTION_TIMEOUT_MS = 25_000;

/**
 * Load a usable reconstruction, or build it only after extraction completed.
 * Previously the pipeline called the builder before the extraction stage,
 * allowing an empty-corpus result/marker to suppress every later attempt.
 * A failed/empty row created before extracted_at is stale and can be rebuilt;
 * a failure after extraction is left for a full rerun so worker ticks do not
 * loop on the same expensive provider call.
 */
export async function ensureDecisionReconstruction(
  db: Db,
  caseId: string,
  userId: string,
  apiKey?: string,
): Promise<CaseDecisionReconstruction | null> {
  const { data: caseRow } = await db
    .from("cases")
    .select("extracted_at")
    .eq("id", caseId)
    .maybeSingle();
  const extractedAt = caseRow?.extracted_at ? Date.parse(caseRow.extracted_at) : Number.NaN;
  if (!Number.isFinite(extractedAt)) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: latest } = await (db as any)
    .from("case_decision_reconstructions")
    .select("reconstruction,matter_identity_status,created_at")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { buildMandatoryDecisionCore } = await import("./mandatory-decision-core");
  const existing = (latest?.reconstruction ?? null) as CaseDecisionReconstruction | null;
  const existingCore = buildMandatoryDecisionCore(existing);
  if (existingCore.some((item) => item.kind !== "CONTROLLING_ISSUE")) return existing;

  const latestCreatedAt = latest?.created_at ? Date.parse(String(latest.created_at)) : Number.NaN;
  const failedAfterExtraction =
    latest?.matter_identity_status === "extraction_failed" &&
    Number.isFinite(latestCreatedAt) &&
    latestCreatedAt >= extractedAt;
  if (failedAfterExtraction) return null;

  return buildDecisionReconstruction(db, caseId, userId, apiKey);
}

/** Leaves a minimal marker row behind on failure so the "does a
 *  reconstruction already exist" gate in pipeline-runner.server.ts stops
 *  retrying this case on every single resume tick. Best-effort — a failure
 *  here must never throw, it would just mean the retry protection didn't
 *  take for this one attempt. */
async function recordFailedAttempt(db: Db, caseId: string, userId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).from("case_decision_reconstructions").insert({
      case_id: caseId,
      user_id: userId,
      reconstruction: {},
      matter_identity_status: "extraction_failed",
      court_status: "extraction_failed",
      disposition_remedy_status: "extraction_failed",
      raw_model_output: null,
    });
  } catch (e) {
    console.error("[decision-reconstruction] failed to record failed-attempt marker", e);
  }
}

export async function buildDecisionReconstruction(
  db: Db,
  caseId: string,
  userId: string,
  apiKey?: string,
): Promise<CaseDecisionReconstruction | null> {
  const { data: caseRow } = await db
    .from("cases")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("created_at" as any)
    .eq("id", caseId)
    .maybeSingle();
  const caseDate = (caseRow as { created_at?: string } | null)?.created_at ?? null;

  const { data: docsRaw } = await db
    .from("documents")
    .select("id,filename,extracted_text")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });
  const docs = (docsRaw ?? []) as Doc[];
  if (docs.length === 0) return null;
  const corpus = buildGroundingCorpus(docs);

  const resolved = await resolveProviderKeys(db, userId, "groq");
  const apiKeys = apiKey ? [apiKey, ...resolved.keys.filter((k) => k !== apiKey)] : resolved.keys;
  const locale = await getReportLocale(db, caseId);

  const corpusText = docs
    .map(
      (d, i) =>
        `=== DOC ${i + 1} | ${d.filename} ===\n${(d.extracted_text ?? "").slice(0, 20_000)}`,
    )
    .join("\n\n");

  const t0 = Date.now();
  let r: Awaited<ReturnType<typeof callGroq>>;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(
    () => timeoutController.abort(),
    DECISION_RECONSTRUCTION_TIMEOUT_MS,
  );
  try {
    r = await callGroq({
      apiKeys,
      model: MODEL,
      temperature: 0.1,
      json: true,
      signal: timeoutController.signal,
      systemInstruction: `${mexicoLock(locale)}

${groundingContract(locale)}

You are reconstructing the verifiable baseline of a Mexican legal matter from its case documents — NOT analyzing, arguing, or auditing it. Extract only what the documents actually establish.

ZERO-HALLUCINATION RULES (mandatory):
- EVERY item you produce MUST include a "quote" field with the EXACT verbatim text from the case documents that supports it — copied character-for-character. An item with no genuine supporting quote will be discarded, regardless of how confident you are — do not include it.
- If a field cannot be established from the documents, OMIT it (or return an empty array) — never guess, never fill it with a plausible-sounding default.
- Distinguish who ASSERTED each proposition: a party's own argument (proposition_type "argument", speaker_role the party) is NOT the same as what a court actually ruled (proposition_type "holding", speaker_role a court instance). Only "tribunal_colegiado", "tribunal_local", or "scjn" may be the speaker_role of a "holding" or "rejected_holding" — a court's holding can never be attributed to "quejoso" or "autoridad".
- Do NOT invent a specific statute article number, tesis registry number, party name, date, or procedural event not present in the text.

Output STRICT JSON only, in ${locale === "en" ? "English" : "Spanish (México)"}.`,
      userContent: `Return STRICT JSON with this exact shape. Every array item needs a "quote" (verbatim, <=200 chars). Omit any field/array item you cannot ground.
{
  "matter_identity": { "case_type": string, "subject_matter_summary": string, "quote": string } | null,
  "court": { "name": string, "level": string|null, "quote": string } | null,
  "jurisdiction": { "level": string, "territory": string|null, "quote": string } | null,
  "procedural_posture": { "stage": string, "instance_type": string|null, "quote": string } | null,
  "parties": [ { "role": string, "identifier": string|null, "quote": string } ],
  "procedural_history": [ { "date": string|null, "event": string, "quote": string } ],
  "material_facts": [ { "text": string, "quote": string } ],
  "issues_presented": [ { "text": string, "quote": string } ],
  "party_arguments": [ { "text": string, "speaker_role": "quejoso"|"autoridad"|"tribunal_colegiado"|"tribunal_local"|"scjn", "proposition_type": "argument", "adoption_status": "adopted"|"rejected"|"unresolved"|"historical"|null, "quote": string } ],
  "evidence_and_factual_findings": [ { "text": string, "quote": string } ],
  "court_reasoning": [ { "text": string, "speaker_role": "tribunal_colegiado"|"tribunal_local"|"scjn", "proposition_type": "holding"|"rejected_holding"|"procedural_fact"|"evidence"|"issue", "adoption_status": "adopted"|"rejected"|"unresolved"|"historical"|null, "quote": string } ],
  "court_holding": [ { "text": string, "speaker_role": "tribunal_colegiado"|"tribunal_local"|"scjn", "proposition_type": "holding"|"rejected_holding", "adoption_status": "adopted"|"rejected"|"unresolved"|"historical"|null, "quote": string } ],
  "disposition_remedy": { "text": string, "quote": string } | null,
  "unresolved_issues": [ { "text": string, "quote": string } ]
}

CASE CORPUS:
${corpusText}`,
    });
  } catch (e) {
    clearTimeout(timeoutHandle);
    console.error("[decision-reconstruction] extraction failed", e);
    await db.from("ai_usage").insert({
      user_id: userId,
      case_id: caseId,
      model: MODEL,
      operation: "decision_reconstruction",
      success: false,
      latency_ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    });
    await recordFailedAttempt(db, caseId, userId);
    return null;
  }
  clearTimeout(timeoutHandle);
  await db.from("ai_usage").insert({
    user_id: userId,
    case_id: caseId,
    model: r.model ?? MODEL,
    operation: "decision_reconstruction",
    success: true,
    latency_ms: Date.now() - t0,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = parseJsonLoose<Record<string, any>>(r.text);
  if (!parsed) {
    await recordFailedAttempt(db, caseId, userId);
    return null;
  }

  const reconstruction = emptyReconstruction(caseId, new Date().toISOString());

  const matterIdentity = toSourced(
    parsed.matter_identity,
    (rec) =>
      typeof rec.case_type === "string" && typeof rec.subject_matter_summary === "string"
        ? { case_type: rec.case_type, subject_matter_summary: rec.subject_matter_summary }
        : null,
    corpus,
    docs,
  );
  if (matterIdentity) reconstruction.matter_identity = matterIdentity;

  const court = toSourced(
    parsed.court,
    (rec) =>
      typeof rec.name === "string"
        ? { name: rec.name, level: (rec.level as string) ?? null }
        : null,
    corpus,
    docs,
  );
  if (court) reconstruction.court = court;

  const jurisdiction = toSourced(
    parsed.jurisdiction,
    (rec) =>
      typeof rec.level === "string"
        ? { level: rec.level, territory: (rec.territory as string) ?? null }
        : null,
    corpus,
    docs,
  );
  if (jurisdiction) reconstruction.jurisdiction = jurisdiction;

  const proceduralPosture = toSourced(
    parsed.procedural_posture,
    (rec) =>
      typeof rec.stage === "string"
        ? { stage: rec.stage, instance_type: (rec.instance_type as string) ?? null }
        : null,
    corpus,
    docs,
  );
  if (proceduralPosture) reconstruction.procedural_posture = proceduralPosture;

  reconstruction.parties = (Array.isArray(parsed.parties) ? parsed.parties : [])
    .map((item: unknown): PartyRoleEntry | null =>
      toSourced(
        item,
        (rec) =>
          typeof rec.role === "string"
            ? { role: rec.role, identifier: (rec.identifier as string) ?? null }
            : null,
        corpus,
        docs,
      ),
    )
    .filter((x: PartyRoleEntry | null): x is PartyRoleEntry => x !== null);

  reconstruction.procedural_history = (
    Array.isArray(parsed.procedural_history) ? parsed.procedural_history : []
  )
    .map((item: unknown): ProceduralEvent | null =>
      toSourced(
        item,
        (rec) =>
          typeof rec.event === "string"
            ? { date: (rec.date as string) ?? null, event: rec.event }
            : null,
        corpus,
        docs,
      ),
    )
    .filter((x: ProceduralEvent | null): x is ProceduralEvent => x !== null);

  reconstruction.material_facts = toStringList(parsed.material_facts, corpus, docs);
  reconstruction.issues_presented = toStringList(parsed.issues_presented, corpus, docs);
  reconstruction.evidence_and_factual_findings = toStringList(
    parsed.evidence_and_factual_findings,
    corpus,
    docs,
  );
  reconstruction.unresolved_issues = toStringList(parsed.unresolved_issues, corpus, docs);

  reconstruction.party_arguments = (
    Array.isArray(parsed.party_arguments) ? parsed.party_arguments : []
  )
    .map((item: unknown) => toProposition(item, corpus, docs))
    .filter((x: ReconstructedProposition | null): x is ReconstructedProposition => x !== null);

  reconstruction.court_reasoning = (
    Array.isArray(parsed.court_reasoning) ? parsed.court_reasoning : []
  )
    .map((item: unknown) => toProposition(item, corpus, docs))
    .filter((x: ReconstructedProposition | null): x is ReconstructedProposition => x !== null);

  reconstruction.court_holding = (Array.isArray(parsed.court_holding) ? parsed.court_holding : [])
    .map((item: unknown) => toProposition(item, corpus, docs))
    .filter((x: ReconstructedProposition | null): x is ReconstructedProposition => x !== null);

  // A published tesis states its authoritative holding under the labelled
  // `Criterio jurídico` section. If the model paraphrased that passage, the
  // verifier above correctly discarded it; recover the exact source text
  // rather than leaving an otherwise verifiable decision core empty.
  if (!reconstruction.court_holding.some((item) => item.status === "PRESENT")) {
    reconstruction.court_holding = extractPublishedThesisHoldings(docs, corpus.pageChars);
  }

  const disposition = toSourced(
    parsed.disposition_remedy,
    (rec) => (typeof rec.text === "string" && rec.text.trim() ? rec.text.trim() : null),
    corpus,
    docs,
  );
  if (disposition) reconstruction.disposition_remedy = disposition;

  // Legal-authority / precedent citations: derived deterministically from
  // every field that actually verified against the corpus (never from a
  // model-self-reported citation string) — see deriveCitations' doc comment.
  const verifiedTexts: string[] = [];
  const collectVerified = (items: Array<Sourced<unknown>>) => {
    for (const item of items)
      if (item.status === "PRESENT")
        for (const ref of item.source_refs) if (ref.quote) verifiedTexts.push(ref.quote);
  };
  collectVerified(reconstruction.court_reasoning);
  collectVerified(reconstruction.court_holding);
  collectVerified(reconstruction.party_arguments);
  collectVerified(reconstruction.material_facts);
  collectVerified(reconstruction.issues_presented);
  if (reconstruction.disposition_remedy.status === "PRESENT")
    collectVerified([reconstruction.disposition_remedy]);

  const { authorities, precedent } = await deriveCitations(db, verifiedTexts, caseDate);
  reconstruction.applicable_legal_authorities = authorities;
  reconstruction.cited_precedent = precedent;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any).from("case_decision_reconstructions").insert({
    case_id: caseId,
    user_id: userId,
    reconstruction: reconstruction as unknown as Record<string, unknown>,
    matter_identity_status: reconstruction.matter_identity.status,
    court_status: reconstruction.court.status,
    disposition_remedy_status: reconstruction.disposition_remedy.status,
    raw_model_output: parsed,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  if (error) {
    console.error("[decision-reconstruction] insert failed", error);
    return null;
  }

  return reconstruction;
}

