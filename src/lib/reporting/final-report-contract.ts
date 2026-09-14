import type { CaseExportData } from "../export";
import {
  resolveReportGovernance, formatSpeakerRoleBadge, DECISION_CORE_KIND_ORDER, getFindingConcludedPriority, type ImmutableReportGovernance,
} from "../intelligence/concluded-case-governance";
import type { CanonicalSourceDocument } from "../intelligence/canonical-source-identity";
import { validateReincidenciaEvidence } from "../intelligence/reincidencia-evidence";
import { buildFindingWorkProduct, buildCaseSnapshot, buildExecutiveQuestions } from "./attorney-workproduct";
import { canonicalSourceCount, resolveReportSourceRefs } from "./report-sources";
import { isDocumentaryVerification, resolveReportCapability, type ReportCapability } from "./report-permissions";
import { contentRestriction, transformReportContent, fold, absenceText, verifiedAbsence, remediateAbsenceLanguage } from "./report-content-policy";
import { resolveFinalReleaseDecision } from "./final-release-decision";

type Row = Record<string, any>;
const obj = (x: any): Row => x && typeof x === "object" && !Array.isArray(x) ? x : {};
const arr = (x: any): Row[] => Array.isArray(x) ? x : [];
const norm = (x: any) => String(x ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const CORE_ORDER: readonly string[] = DECISION_CORE_KIND_ORDER;
const CORE_LABELS: Record<string, string> = { DISPOSITION: "RESULTADO DEL RECURSO", RESOLUTIVOS: "RESOLUTIVOS", CONTROLLING_ISSUE: "CUESTIÓN CONTROLANTE", COURT_HOLDING: "DETERMINACIÓN DEL TRIBUNAL", REMEDY: "EFECTO" };

export interface ReportPresentation {
  capability: ReportCapability;
  governance: ImmutableReportGovernance;
  canonical_sources: CanonicalSourceDocument[];
  unique_source_count: number;
  unresolved_source_ids: string[];
  snapshot: ReturnType<typeof buildCaseSnapshot>;
  executive_questions: ReturnType<typeof buildExecutiveQuestions>;
  render_sections?: Array<{id:string; title:string; strategic:boolean}>;
  render_output?: { format: string; text: string };
  decision_sections: Array<{ id: string; kind: string; title: string; text: string; speaker_role: string; speaker_label: string }>;
  finding_cards: Array<{ finding: Row; source_count: number; details: ReturnType<typeof buildFindingWorkProduct> }>;
  withheld_findings: Array<{ id: unknown; category: string; attorney_review_required: boolean }>;
}
export type FinalReportPayload = CaseExportData & { report_presentation: ReportPresentation };

export function resolveReportSpeaker(finding: Row, core: Row[]): string {
  const metadata = obj(finding.metadata);
  const verified = core.find(item =>
    item.id === finding.mandatory_decision_core_id || item.id === metadata.mandatory_decision_core_id ||
    (item.text && [finding.title, finding.description, finding.source_quote].some(t => norm(t) === norm(item.text))) ||
    arr(finding.evidence_refs).some(ref => ref.quote && arr(item.source_refs).some(cr =>
      norm(cr.quote) === norm(ref.quote) && (cr.document_id === ref.document_id || cr.canonical_source_id && cr.canonical_source_id === ref.canonical_source_id))));
  if (verified?.speaker_role) return verified.speaker_role;
  const explicit = arr(finding.evidence_refs).map(r => r.court_explicitly_identified).filter(Boolean);
  if (new Set(explicit).size === 1) return explicit[0];
  if (finding.adoption_status === "adopted" && finding.reviewing_court_role) return finding.reviewing_court_role;
  // Preserve a non-conflicting attributed speaker; never pick among conflicting merged roles.
  const roles = new Set([finding.speaker_role, ...arr(finding.merged_findings).map(f => f.speaker_role)].filter(Boolean));
  return roles.size === 1 ? [...roles][0] : "unresolved";
}

const STRATEGY_FIELDS = new Set(["recommendations", "canonical_recommendations", "next_actions", "strategy_recommendations",
  "ways_out_analysis", "settlement_opportunities", "litigation_strategy", "trial_strategy", "defense_strategy", "prosecution_strategy",
  "future_motions", "case_opportunities", "urgent_actions", "potential_impact", "strategic_importance", "strategic_significance",
  "recommended_motions", "strategy", "strategy_center", "opportunities", "trial_prep", "work_product",
  "cross_examination", "cross_examination_questions", "defense_theory_report", "prosecution_theory_report", "alternative_theory_report",
  "attorney_work_product", "motion_opportunities", "case_strategy", "trial_themes", "jury_themes", "canonical_actions",
  "dispositive_recommendation", "risk_matrix", "motions", "legal_theories", "legal_theory",
  "risk_analysis", "settlement_strategy", "theory_of_case_recommendations"]);
const SCORE_FIELDS = new Set(["case_strength_score", "risk_score", "overall_confidence", "score_breakdown", "deterministic_scorecard", "dimension_breakdowns", "score"]);
const PROBABILITY_FIELDS = new Set(["probability", "success_probability", "likelihood", "likelihood_percent", "likelihood_of_success", "win_probability"]);

/** Build the presentation once, before any PDF/DOCX/HTML renderer receives it.
 * This replaces renderer-side reconstruction. Raw DB records are not mutated. */
export function composeFinalReportPayload(input: CaseExportData): FinalReportPayload {
  const data = structuredClone(input) as FinalReportPayload;
  const report = obj(data.report), full = obj(report.full_report), c = obj(data.case);
  const stored = obj(full.report_governance);
  const governance = resolveReportGovernance({
    ...c,
    case_analysis_mode: c.case_analysis_mode ?? full.case_analysis_mode,
    procedural_posture: c.procedural_posture ?? obj(c.matter_metadata).procedural_posture ??
      obj(full.case_identity).procedural_posture ?? full.procedural_posture ??
      (stored.is_concluded ? "concluded" : undefined),
    matter_metadata: obj(c.matter_metadata),
    execution_id: stored.execution_id,
  });
  const capability = resolveReportCapability(report, governance);
  const sources = arr(obj(full.source_audit).canonical_sources ?? full.canonical_sources) as CanonicalSourceDocument[];
  const uniqueSources = [...new Map(sources.filter(s => s.canonical_source_id).map(s => [s.canonical_source_id, s])).values()];
  const unresolved_source_ids = data.documents.filter(d => !sources.some(s =>
    s.document_id === d.id || s.canonical_source_id === d.canonical_source_id ||
    (s.source_aliases ?? []).includes(String(d.id)),
  )).map(d => String(d.id ?? d.filename ?? "unknown"));
  const core = arr(obj(full.mandatory_decision_core).items);
  const withheld: ReportPresentation["withheld_findings"] = [];
  const findings = arr(data.findings).map((f): Row | null => {
    const checked = validateReincidenciaEvidence(f);
    if (checked.report_suppressed) {
      withheld.push({ id: f.id, category: checked.category, attorney_review_required: true });
      return null;
    }
    const speaker_role = resolveReportSpeaker(checked, core);
    return { ...checked, content_class: checked.audit_classification === "VERIFIED_COURT_HOLDING" ? "VERIFIED_HOLDING" :
      checked.proposition_type === "party_argument" || checked.proposition_type === "argument" ? "PARTY_ARGUMENT" : checked.content_class, speaker_role, speaker_role_label: formatSpeakerRoleBadge({ ...checked, speaker_role }),
      evidence_refs: resolveReportSourceRefs(arr(checked.evidence_refs), sources) };
  }).filter((f): f is NonNullable<typeof f> => f !== null);
  findings.sort((a,b) => governance.decision_core_priority
    ? getFindingConcludedPriority(b) - getFindingConcludedPriority(a)
    : Number(({critical:4,high:3,medium:2,low:1} as Record<string,number>)[String(b.severity)] ?? 0) -
      Number(({critical:4,high:3,medium:2,low:1} as Record<string,number>)[String(a.severity)] ?? 0));
  data.findings = findings;
  if (full.intelligence) full.intelligence.consolidated_findings = findings;
  // Canonical recommendation candidates own all action lanes. Retired raw
  // prose/agent next_actions are never resurrected for an older report.
  const recommendations = arr(full.canonical_recommendations);
  const nextActions = recommendations.map(r => ({action:r.title, why:r.reason, priority:r.priority, owner:r.owner}));
  report.next_actions = nextActions;
  report.strategy_recommendations = [];
  report.recommendations = recommendations.map(r => [r.title,r.reason].filter(Boolean).join(" — ")).join("\n");
  if (full.legal_memorandum) full.legal_memorandum.next_actions = nextActions;
  // Evidence inventory is a source view; retain multiple citations inside
  // each source rather than rendering one row per citation alias.
  const inventory = resolveReportSourceRefs(arr(report.evidence_index), sources);
  report.evidence_index = uniqueSources.map(source => ({
    ...obj(inventory.find(row => row.canonical_source_id === source.canonical_source_id)),
    document_id:source.document_id, canonical_source_id:source.canonical_source_id,
    filename:source.display_name || source.original_filename,
  }));
  const decision_sections = governance.decision_core_priority ? core.filter(i => CORE_ORDER.includes(i.kind))
    .sort((a, b) => CORE_ORDER.indexOf(a.kind) - CORE_ORDER.indexOf(b.kind))
    .map(i => ({ content_class: i.kind === "REMEDY" ? "HISTORICAL_REMEDY" : "VERIFIED_HOLDING", id: i.id, kind: i.kind, title: CORE_LABELS[i.kind], text: i.text,
      speaker_role: i.speaker_role ?? "unresolved", speaker_label: formatSpeakerRoleBadge({ ...i, mandatory_decision_kind: i.kind }) })) : [];
  const context = {
    documentLabels: uniqueSources.map(s => s.display_name || s.original_filename),
    caseType: c.case_type, jurisdiction: c.jurisdiction,
    missingDocuments: arr(report.missing_evidence_struct).map(m => String(m.item ?? "")).filter(Boolean),
    capability, governance,
  };
  const finding_cards = findings.map(f => ({ finding: f, source_count: canonicalSourceCount(f.evidence_refs), details: buildFindingWorkProduct(f, context) }));
  const snapshot = buildCaseSnapshot(findings, context);
  if (governance.decision_core_priority) snapshot.priorityReview = [
    ...decision_sections.map(s => s.title + ": " + s.text), ...findings.map(f => String(f.title)),
  ];
  const executive_questions = buildExecutiveQuestions(findings, context, snapshot);
  // Canonical projection, not fresh identity normalization. Keep upload IDs for citation lookup.
  data.documents = uniqueSources.map(s => ({ ...obj(data.documents.find(d => d.id === s.document_id)),
    ...s, id: s.document_id, filename: s.display_name || s.original_filename }));
  const project = (value: any): any => {
    if (Array.isArray(value)) return value.map(project);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !(!capability.strategic_recommendations_allowed && STRATEGY_FIELDS.has(key)) &&
      !(!capability.scores_allowed && SCORE_FIELDS.has(key)) &&
      !(!capability.probabilities_allowed && PROBABILITY_FIELDS.has(key)) &&
      key !== "final_renderer_payload" && key !== "report_presentation"
    ).map(([key, v]) => [key, project(v)]));
  };
  const projected = project(data) as FinalReportPayload;
  projected.report ??= {};
  projected.report.full_report ??= {};
  Object.assign(projected.report, { report_mode: capability.mode, scores_suppressed: !capability.scores_allowed, motions_suppressed: !capability.motions_allowed });
  Object.assign(projected.report.full_report as Row, { report_governance: governance, report_capability: capability });
  // Cards reference the projected findings, never an unfiltered raw finding.
  projected.report_presentation = {
    capability, governance, canonical_sources: uniqueSources, unique_source_count: uniqueSources.length, unresolved_source_ids,
    snapshot, executive_questions,
    decision_sections, finding_cards: finding_cards.map((card, i) => ({ ...card, finding: projected.findings![i] })),
    withheld_findings: withheld,
  };
  // Last transform includes generated cards, snapshot, memo, legacy prose and
  // every secondary section. No renderer may recover the pre-projection data.
  // The second pass runs against the already-transformed tree, which is exactly
  // the context the contract validator inspects: the first pass can change a
  // parent (dropped strategy siblings, rewritten refs) so a nested absence or
  // strategy string is re-classified afterwards. Re-running to a fixed point
  // sanitizes those nodes instead of blocking release on them.
  const once = transformReportContent(projected, capability, governance);
  return transformReportContent(once, capability, governance);

}

export function validateFinalReportContract(payload: FinalReportPayload, capability = payload.report_presentation.capability, governance = payload.report_presentation.governance) {
  const view = payload.report_presentation;
  const restricted = capability.mode === "LIMITED" || !capability.strategic_recommendations_allowed;
  const violations: string[] = [];
  const violation_paths: Array<{rule:string; path:string}> = [];
  let inspected_nodes = 0;
  // Attribution survives formatting: exempt only the exact sourced/verified
  // absence proposition, never the entire output string containing it.
  const verifiedAbsences: string[] = [];
  const collectAbsences = (value: any) => {
    if (Array.isArray(value)) { value.forEach(collectAbsences); return; }
    if (!value || typeof value !== "object") return;
    for (const [key,text] of Object.entries(value)) {
      if (key === "render_output") continue;
      if (typeof text === "string" && absenceText.test(fold(text)) &&
          (verifiedAbsence(value,text) || key === "quote" && (value.document_id || value.canonical_source_id)))
        verifiedAbsences.push(fold(text).replace(/[.!?]+$/, ""));
      else if (text && typeof text === "object") collectAbsences(text);
    }
  };
  collectAbsences(payload);
  const rules = {
    prohibitedStrategicHeadingsPresent: false, strategicRecommendationsPresent: false,
    scoresPresent: false, probabilitiesPresent: false, recommendedMotionsPresent: false,
    verificationStepsOnly: true, decisionCoreFirst: true, canonicalSourceCountsValid: true,
    speakerRoleLabelsValid: true, concludedGovernanceResolved: true, unverifiedAbsencePresent: false,
  };
  // Inspect exactly the object supplied to the renderer, including nested cards,
  // memo, prose, and sections. Audit-only booleans and score suppression flags are
  // not numeric scores or output recommendations.
  const visit = (v: any, key = "", path = "$", parent: Row = {}) => {
    inspected_nodes++;
    let restriction = contentRestriction(v, key, parent, capability, governance);
    if (restriction === "unverifiedAbsencePresent" && path === "$.report_presentation.render_output.text") {
      let remaining = fold(v);
      for (const text of verifiedAbsences) remaining = remaining.split(text).join("");
      if (!absenceText.test(remaining)) restriction = null;
    }
    if (restriction) {
      (rules as Row)[restriction] = true;
      violation_paths.push({rule:restriction, path});
    }
    if (typeof v === "string" && /pr[oó]ximas\s+acciones\s+recomendadas|recommended next actions|importancia estrat[eé]gica/i.test(v)) rules.prohibitedStrategicHeadingsPresent = true;
    const populated = v != null && v !== "" && (!Array.isArray(v) || v.length > 0) &&
      (typeof v !== "object" || Object.keys(v).length > 0);
    if (populated && STRATEGY_FIELDS.has(key)) rules.strategicRecommendationsPresent = true;
    if (populated && SCORE_FIELDS.has(key)) rules.scoresPresent = true;
    if (populated && PROBABILITY_FIELDS.has(key)) rules.probabilitiesPresent = true;
    if (populated && key === "recommended_motions") rules.recommendedMotionsPresent = true;
    if (Array.isArray(v)) v.forEach((x,i) => visit(x,key,path + "[" + i + "]",parent));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => visit(x,k,path + "." + k,v));
  };
  visit(payload);
  if (restricted && view.render_sections?.some(section => section.strategic)) rules.strategicRecommendationsPresent = true;
  rules.verificationStepsOnly = view.finding_cards.every(card =>
    card.details.actions.every(isDocumentaryVerification) && card.details.actions_kind !== "strategic");
  rules.canonicalSourceCountsValid = view.unresolved_source_ids.length === 0 &&
    view.unique_source_count === canonicalSourceCount(view.canonical_sources) &&
    payload.documents.length === view.unique_source_count &&
    view.finding_cards.every(card => card.source_count === canonicalSourceCount(arr(card.finding.evidence_refs)) &&
      (!card.details.synthesis || card.details.synthesis.docs.length === card.source_count) &&
      arr(card.finding.evidence_refs).every(ref => view.canonical_sources.some(s => s.canonical_source_id === ref.canonical_source_id)));
  const expectedCore = arr(obj(obj(payload.report?.full_report).mandatory_decision_core).items).filter(i => CORE_ORDER.includes(i.kind));
  rules.decisionCoreFirst = !governance.decision_core_priority || (view.decision_sections.length > 0 &&
    view.decision_sections.length === expectedCore.length && view.decision_sections[0].kind === "DISPOSITION" &&
    view.decision_sections.every((section, i, sections) => i === 0 || CORE_ORDER.indexOf(sections[i - 1].kind) <= CORE_ORDER.indexOf(section.kind)));
  rules.speakerRoleLabelsValid = !governance.speaker_role_labels_required ||
    (view.finding_cards.every(card => card.finding.speaker_role_label === formatSpeakerRoleBadge(card.finding) &&
      card.finding.speaker_role === resolveReportSpeaker(card.finding, expectedCore)) &&
    view.decision_sections.every(section => {
      const item = expectedCore.find(item => item.id === section.id);
      return !!item && section.speaker_role === (item.speaker_role ?? "unresolved") &&
        section.speaker_label === formatSpeakerRoleBadge({...item, mandatory_decision_kind:item.kind});
    }));
  const c = obj(payload.case), full = obj(payload.report?.full_report);
  const expectedGovernance = resolveReportGovernance({
    ...c, case_analysis_mode: c.case_analysis_mode ?? full.case_analysis_mode,
    procedural_posture: c.procedural_posture ?? obj(full.case_identity).procedural_posture ?? full.procedural_posture,
    matter_metadata: obj(c.matter_metadata),
  });
  rules.concludedGovernanceResolved = !expectedGovernance.is_concluded ||
    (governance.is_concluded && governance.governance_mode === expectedGovernance.governance_mode &&
      governance.strategy_output_allowed === expectedGovernance.strategy_output_allowed &&
      governance.decision_core_priority && governance.speaker_role_labels_required);
  if (restricted && rules.prohibitedStrategicHeadingsPresent) violations.push("prohibitedStrategicHeadingsPresent");
  if (restricted && rules.strategicRecommendationsPresent) violations.push("strategicRecommendationsPresent");
  if (!capability.scores_allowed && rules.scoresPresent) violations.push("scoresPresent");
  if (!capability.probabilities_allowed && rules.probabilitiesPresent) violations.push("probabilitiesPresent");
  if (!capability.motions_allowed && rules.recommendedMotionsPresent) violations.push("recommendedMotionsPresent");
  if (rules.unverifiedAbsencePresent) violations.push("unverifiedAbsencePresent");
  for (const key of ["decisionCoreFirst", "canonicalSourceCountsValid", "speakerRoleLabelsValid", "concludedGovernanceResolved"] as const)
    if (!rules[key]) violations.push(key);
  if (restricted && !rules.verificationStepsOnly) violations.push("verificationStepsOnly");
  return { ok: violations.length === 0, blocking_errors: violations, checked_rules: rules,
    violation_paths, inspected_nodes, validation_stage: view.render_output ? "after_renderer_transforms" : "after_section_transforms" };
}

/** REMEDIATE -> REVALIDATE. Rewrites ONLY the string nodes the contract
 * validator flagged as `unverifiedAbsencePresent` into qualified, scope-bounded
 * language. Verified/cited absences, quotes and every other node are untouched,
 * and no other contract rule is affected. */
export function remediateUnverifiedAbsences<T>(payload: T, capability: ReportCapability, governance: ImmutableReportGovernance): T {
  const walk = (v: any, key = "", parent: Row = {}): any => {
    if (typeof v === "string") {
      return contentRestriction(v, key, parent, capability, governance) === "unverifiedAbsencePresent"
        ? remediateAbsenceLanguage(v).text : v;
    }
    if (Array.isArray(v)) return v.map(x => walk(x, key, parent));
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k, v)]));
  };
  return walk(payload);
}

/** Remediate an already-rendered output string: only the absence sentences that
 * are not backed by a verified/cited absence are qualified. */
function remediateRenderedText(payload: FinalReportPayload, text: string): string {
  const verified: string[] = [];
  const collect = (value: any) => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "render_output") continue;
      if (typeof child === "string" && absenceText.test(fold(child)) &&
          (verifiedAbsence(value, child) || key === "quote" && (value.document_id || value.canonical_source_id)))
        verified.push(fold(child).replace(/[.!?]+$/, ""));
      else if (child && typeof child === "object") collect(child);
    }
  };
  collect(payload);
  // Split keeping the original separators so the rendered layout is preserved.
  return text.split(/([.!?]+\s+|\n+)/).map(chunk => {
    if (!absenceText.test(fold(chunk))) return chunk;
    const folded = fold(chunk).replace(/[.!?]+$/, "");
    if (verified.some(v => folded.includes(v) || v.includes(folded))) return chunk;
    return remediateAbsenceLanguage(chunk).text;
  }).join("");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function releaseFinalReportPayload(input: CaseExportData): FinalReportPayload {
  if (input.report?.quality_blocked === true) throw new Error("REPORT_BLOCKED: report failed its release gate");
  let payload = (input as FinalReportPayload).report_presentation ? input as FinalReportPayload : composeFinalReportPayload(input);
  let validation = validateFinalReportContract(payload);
  // REMEDIATE -> REVALIDATE before BLOCK. An uncited absolute absence sentence
  // (typically report_writer:missing_evidence) is rewritten into qualified
  // language and the same validator runs again. Every other violation, and any
  // absence that survives remediation, still blocks the report.
  if (!validation.ok && validation.blocking_errors.includes("unverifiedAbsencePresent")) {
    const view = payload.report_presentation;
    payload = remediateUnverifiedAbsences(payload, view.capability, view.governance);
    validation = validateFinalReportContract(payload);
  }
  if (!validation.ok) throw new Error("REPORT_CONTRACT_BLOCKED: " + validation.blocking_errors.join(", "));
  const decision = resolveFinalReleaseDecision({report:obj(payload.report),contract:validation});
  if (!decision.released) throw new Error("REPORT_BLOCKED: " + decision.errors.join(", "));
  return freeze(payload);
}

/** All concrete export backends submit their fully transformed output here.
 * This calls the existing contract validator; it is not a second policy. */
export function releaseRenderedReportOutput(payload: FinalReportPayload, format: string, text: string) {
  // Renderer output is assembled after the composition transforms, so an
  // uncited absence sentence is qualified here before the same validator runs.
  const remediated = remediateRenderedText(payload, text);
  const finalPayload = {...payload, report_presentation:{...payload.report_presentation,render_output:{format,text:remediated}}};
  return releaseFinalReportPayload(finalPayload);
}
