// =====================================================================
// Layer 2 — Deterministic Legal Intelligence Algorithms
// =====================================================================
// These functions are pure (no LLM, no I/O, no randomness). They take
// structured inputs that the upstream extractors / engines have already
// produced and return scored, explainable outputs.
//
// Architecture rule:
//   - Layer 1 (code) orchestrates and persists.
//   - Layer 2 (this file) computes deterministic legal signals.
//   - Layer 3 (AI) only interprets the outputs of Layer 2 — it never
//     invents scores, contradictions, or timelines.
//
// Every output exposes a `factors` / `reasoning` breakdown so a human
// (or an auditor) can re-derive the score from the inputs.
// =====================================================================

export type Severity = "low" | "medium" | "high" | "critical";
const SEV_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

import type { ProceduralPosture } from "./procedural-posture";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

// ---------------------------------------------------------------------
// 1. Evidence Weighting Engine
// ---------------------------------------------------------------------
export interface EvidenceItem {
  id: string;
  type?: string;
  source_doc_ids?: string[];
  witness_ids?: string[];
  physical?: boolean;
  ocr_confidence?: number;
  chain_of_custody?: boolean;
  conflicting_testimony?: boolean;
}
export function scoreEvidence(e: EvidenceItem): {
  score: number;
  factors: Array<{ label: string; delta: number }>;
} {
  const factors: Array<{ label: string; delta: number }> = [];
  let s = 40;
  const corroboration = new Set(e.source_doc_ids ?? []).size;
  if (corroboration >= 2) { s += 20; factors.push({ label: `corroborated by ${corroboration} documents`, delta: +20 }); }
  if ((e.witness_ids?.length ?? 0) >= 1) { s += 10; factors.push({ label: "independent witness support", delta: +10 }); }
  if (e.physical) { s += 15; factors.push({ label: "physical evidence", delta: +15 }); }
  if (typeof e.ocr_confidence === "number" && e.ocr_confidence < 0.7) {
    const d = -Math.round((0.7 - e.ocr_confidence) * 30);
    s += d; factors.push({ label: "low OCR confidence", delta: d });
  }
  if (e.conflicting_testimony) { s -= 15; factors.push({ label: "conflicting testimony", delta: -15 }); }
  if (e.chain_of_custody === false) { s -= 20; factors.push({ label: "missing chain of custody", delta: -20 }); }
  return { score: clamp(s), factors };
}

// ---------------------------------------------------------------------
// 2. Witness Credibility Engine
// ---------------------------------------------------------------------
export interface WitnessSignals {
  internal_consistency?: number;
  contradictions?: number;
  corroborated_statements?: number;
  prior_inconsistent_statements?: number;
  bias_indicators?: number;
  opportunity_to_observe?: number;
  statement_completeness?: number;
}
export function scoreWitnessCredibility(w: WitnessSignals): {
  score: number;
  factors: Array<{ label: string; delta: number }>;
} {
  const factors: Array<{ label: string; delta: number }> = [];
  let s = 50;
  const add = (label: string, delta: number) => { s += delta; factors.push({ label, delta }); };
  if (typeof w.internal_consistency === "number") add("internal consistency", Math.round(w.internal_consistency * 20));
  if (w.contradictions) add(`${w.contradictions} contradiction(s)`, -Math.min(30, w.contradictions * 8));
  if (w.corroborated_statements) add(`${w.corroborated_statements} corroborated statement(s)`, Math.min(20, w.corroborated_statements * 5));
  if (w.prior_inconsistent_statements) add(`${w.prior_inconsistent_statements} prior inconsistent statement(s)`, -Math.min(25, w.prior_inconsistent_statements * 6));
  if (w.bias_indicators) add(`${w.bias_indicators} bias indicator(s)`, -Math.min(20, w.bias_indicators * 5));
  if (typeof w.opportunity_to_observe === "number") add("opportunity to observe", Math.round(w.opportunity_to_observe * 15));
  if (typeof w.statement_completeness === "number") add("statement completeness", Math.round(w.statement_completeness * 10));
  return { score: clamp(s), factors };
}

// ---------------------------------------------------------------------
// 3. Timeline Integrity Engine
// ---------------------------------------------------------------------
export interface TimelineEvent {
  id?: string;
  date?: string;
  event?: string;
  source_doc_id?: string;
}
export interface TimelineReport {
  ordered: Array<TimelineEvent & { ts: number }>;
  undated: TimelineEvent[];
  impossible_sequences: Array<{ a: TimelineEvent; b: TimelineEvent; reason: string }>;
  missing_intervals: Array<{ after: TimelineEvent; before: TimelineEvent; gap_days: number }>;
  conflicts: Array<{ a: TimelineEvent; b: TimelineEvent; reason: string }>;
}
export function buildTimeline(events: TimelineEvent[], opts: { gapDays?: number } = {}): TimelineReport {
  const gapDays = opts.gapDays ?? 90;
  const dated: Array<TimelineEvent & { ts: number }> = [];
  const undated: TimelineEvent[] = [];
  for (const e of events) {
    if (!e.date) { undated.push(e); continue; }
    const ts = Date.parse(e.date);
    if (Number.isNaN(ts)) { undated.push(e); continue; }
    dated.push({ ...e, ts });
  }
  dated.sort((a, b) => a.ts - b.ts);

  const impossible_sequences: TimelineReport["impossible_sequences"] = [];
  const conflicts: TimelineReport["conflicts"] = [];
  for (let i = 1; i < dated.length; i++) {
    const a = dated[i - 1]; const b = dated[i];
    if (a.event && b.event && a.event === b.event && a.ts !== b.ts) {
      conflicts.push({ a, b, reason: "same event reported on two different dates" });
    }
    if (a.ts > b.ts) impossible_sequences.push({ a, b, reason: "out-of-order after sort (data corruption)" });
  }

  const missing_intervals: TimelineReport["missing_intervals"] = [];
  for (let i = 1; i < dated.length; i++) {
    const gap = (dated[i].ts - dated[i - 1].ts) / 86_400_000;
    if (gap > gapDays) missing_intervals.push({ after: dated[i - 1], before: dated[i], gap_days: Math.round(gap) });
  }
  return { ordered: dated, undated, impossible_sequences, missing_intervals, conflicts };
}

// ---------------------------------------------------------------------
// 4. Contradiction Detection Engine
// ---------------------------------------------------------------------
export interface Statement {
  id: string;
  subject?: string;
  event?: string;
  attributes?: Record<string, unknown>;
  source_doc_id?: string;
}
const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export function detectContradictions(stmts: Statement[]): Array<{
  a: Statement; b: Statement; field: string; valueA: unknown; valueB: unknown;
}> {
  const out: Array<{ a: Statement; b: Statement; field: string; valueA: unknown; valueB: unknown }> = [];
  for (let i = 0; i < stmts.length; i++) {
    for (let j = i + 1; j < stmts.length; j++) {
      const a = stmts[i]; const b = stmts[j];
      if (norm(a.subject) !== norm(b.subject)) continue;
      if (norm(a.event) !== norm(b.event)) continue;
      const fields = new Set([...Object.keys(a.attributes ?? {}), ...Object.keys(b.attributes ?? {})]);
      for (const f of fields) {
        const va = a.attributes?.[f]; const vb = b.attributes?.[f];
        if (va == null || vb == null) continue;
        if (norm(va) !== norm(vb)) out.push({ a, b, field: f, valueA: va, valueB: vb });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// 5. Discovery Completeness Engine
// ---------------------------------------------------------------------
export interface DiscoveryRequest { id: string; label: string; received?: boolean; }
export function discoveryCompleteness(requests: DiscoveryRequest[]): {
  total: number; received: number; outstanding: DiscoveryRequest[]; percent: number;
} {
  const received = requests.filter((r) => r.received).length;
  const outstanding = requests.filter((r) => !r.received);
  const percent = requests.length ? Math.round((received / requests.length) * 100) : 0;
  return { total: requests.length, received, outstanding, percent };
}

// ---------------------------------------------------------------------
// 6. Chain of Custody Engine
// ---------------------------------------------------------------------
export interface CustodyEntry { ts: string; from: string; to: string; itemId: string; }
export function auditChainOfCustody(entries: CustodyEntry[]): {
  items: Record<string, { complete: boolean; breaks: Array<{ atIndex: number; reason: string }> }>;
} {
  const byItem = new Map<string, CustodyEntry[]>();
  for (const e of entries) {
    const arr = byItem.get(e.itemId) ?? [];
    arr.push(e); byItem.set(e.itemId, arr);
  }
  const items: Record<string, { complete: boolean; breaks: Array<{ atIndex: number; reason: string }> }> = {};
  for (const [id, list] of byItem) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const breaks: Array<{ atIndex: number; reason: string }> = [];
    for (let i = 1; i < list.length; i++) {
      if (norm(list[i - 1].to) !== norm(list[i].from)) {
        breaks.push({ atIndex: i, reason: `handoff break: ${list[i - 1].to} -> ${list[i].from}` });
      }
    }
    items[id] = { complete: breaks.length === 0, breaks };
  }
  return { items };
}

// ---------------------------------------------------------------------
// 7. Standard of Proof Engine (Estándar Probatorio)
// ---------------------------------------------------------------------
export type BurdenStandard = "mas_alla_duda_razonable" | "preponderancia_indiciaria" | "interes_juridico_acreditado";
const STANDARD_THRESHOLD: Record<BurdenStandard, number> = {
  mas_alla_duda_razonable: 90,
  preponderancia_indiciaria: 60,
  interes_juridico_acreditado: 70,
};
export interface ElementSupport { element: string; evidence_score: number; }
export function evaluateBurden(standard: BurdenStandard, elements: ElementSupport[]): {
  standard: BurdenStandard; threshold: number; satisfied: boolean;
  perElement: Array<ElementSupport & { satisfied: boolean }>;
  weakest: ElementSupport | null;
} {
  const threshold = STANDARD_THRESHOLD[standard];
  const perElement = elements.map((e) => ({ ...e, satisfied: e.evidence_score >= threshold }));
  const weakest = perElement.reduce<ElementSupport | null>((min, e) =>
    min == null || e.evidence_score < min.evidence_score ? e : min, null);
  return { standard, threshold, satisfied: perElement.every((e) => e.satisfied), perElement, weakest };
}

// ---------------------------------------------------------------------
// 8. Risk Assessment Engine
// ---------------------------------------------------------------------
export interface RiskInputs {
  unresolved_contradictions: number;
  missing_evidence: number;
  constitutional_issues: number;
  unfavorable_witnesses: number;
  procedural_defects: number;
}
export function assessRisk(r: RiskInputs): { score: number; band: Severity; factors: Array<{ label: string; delta: number }> } {
  const factors: Array<{ label: string; delta: number }> = [];
  let s = 0;
  const add = (label: string, n: number, w: number) => {
    const count = Math.max(0, Number.isFinite(n) ? n : 0);
    const d = count * w;
    s += d;
    if (count && d !== 0) factors.push({ label: `${count} x ${label}`, delta: d });
  };
  add("unresolved contradictions", r.unresolved_contradictions, 8);
  add("missing evidence items", r.missing_evidence, 6);
  // A constitutional issue is NOT inherently adverse. It can be a favorable
  // SCJN holding, an applicable legal rule, or a question the court already
  // resolved. The old formula blindly added +10 for every constitutional
  // item and therefore inflated Amparo risk precisely when a judgment had
  // more constitutional analysis. Until the caller supplies an explicit
  // adverse-impact signal, constitutional issue count is context-only and
  // must not move risk.
  add("constitutional issues (context only)", r.constitutional_issues, 0);
  add("unfavorable witnesses", r.unfavorable_witnesses, 7);
  add("procedural defects", r.procedural_defects, 5);
  const score = clamp(s);
  const band: Severity = score >= 75 ? "critical" : score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  return { score, band, factors };
}

// ---------------------------------------------------------------------
// 9. Procedural Remedy Detector (Promociones y Recursos Procedentes)
// ---------------------------------------------------------------------
export interface MotionSignal { tag: string; severity: Severity; }

/**
 * The legacy remedy table is predominantly CNPP-specific. A generic report
 * signal such as `missing_evidence` must never be enough, by itself, to
 * manufacture a criminal-procedure filing in an Amparo, civil, family,
 * labor, tax, administrative, or real-estate case. We therefore require an
 * unmistakably penal signal before any CNPP remedy rule is allowed to fire.
 */
function hasPenalAnchor(signals: MotionSignal[]): boolean {
  return signals.some((x) =>
    [
      "prueba_ilicita",
      "control_detencion_defectuoso",
      "cadena_custodia_rota",
      "medidas_cautelares_desproporcionadas",
      "vinculacion_proceso_defectuosa",
    ].includes(x.tag),
  );
}

const MOTION_RULES: Array<{ when: (s: MotionSignal[]) => boolean; motion: string; basis: string }> = [
  {
    when: (s) => s.some((x) => x.tag === "prueba_ilicita" && SEV_RANK[x.severity] >= 3),
    motion: "Solicitud de exclusión de prueba ilícita",
    basis: "Prueba obtenida con violación de derechos fundamentales (Art. 20, apartado A, fracc. IX CPEUM; Art. 264 CNPP)",
  },
  {
    when: (s) => s.some((x) => x.tag === "control_detencion_defectuoso"),
    motion: "Incidente de nulidad por control de detención defectuoso",
    basis: "Defectos en la audiencia de control de detención (Art. 16 CPEUM; Art. 308 CNPP)",
  },
  {
    // Generic missing-evidence is not a penal signal. Keep this legacy
    // remedy only when the same case also contains a penal anchor.
    when: (s) => hasPenalAnchor(s) && s.some((x) => x.tag === "descubrimiento_probatorio_incompleto"),
    motion: "Solicitud de descubrimiento probatorio complementario",
    basis: "Descubrimiento probatorio incompleto de la contraparte (Art. 337 y ss. CNPP)",
  },
  {
    when: (s) => s.some((x) => x.tag === "cadena_custodia_rota"),
    motion: "Objeción a la cadena de custodia / solicitud de exclusión",
    basis: "Ruptura de cadena de custodia (Art. 227 y ss. CNPP)",
  },
  {
    when: (s) => s.some((x) => x.tag === "medidas_cautelares_desproporcionadas"),
    motion: "Solicitud de revisión o modificación de medidas cautelares",
    basis: "Medida cautelar desproporcionada o no ajustada a los criterios del Art. 156 CNPP",
  },
  {
    when: (s) => s.some((x) => x.tag === "vinculacion_proceso_defectuosa"),
    motion: "Recurso de apelación contra el auto de vinculación a proceso",
    basis: "Defectos en la vinculación a proceso (Art. 316 y ss. CNPP)",
  },
  {
    when: (s) => s.some((x) => x.tag === "violacion_constitucional" && SEV_RANK[x.severity] >= 3),
    motion: "Juicio de amparo indirecto",
    basis: "Violación de derechos fundamentales susceptible de amparo (Arts. 103 y 107 CPEUM; Ley de Amparo)",
  },
  {
    // "defecto_procesal" is materia-neutral upstream. Do not translate two
    // generic defects into a criminal-style incident unless penal context is
    // independently present.
    when: (s) => hasPenalAnchor(s) && s.filter((x) => x.tag === "defecto_procesal").length >= 2,
    motion: "Incidente de nulidad procesal",
    basis: "Defectos procesales acumulados que afectan el debido proceso",
  },
];
export function detectMotions(
  signals: MotionSignal[],
  posture?: ProceduralPosture | null,
): Array<{ motion: string; basis: string }> {
  if (posture?.is_final_resolution && !posture.remand_ordered) {
    return [];
  }
  return MOTION_RULES.filter((r) => r.when(signals)).map(({ motion, basis }) => ({ motion, basis }));
}

// ---------------------------------------------------------------------
// 10. Grounds for Appeal / Amparo Detector (Agravios y Conceptos de Violación)
// ---------------------------------------------------------------------
export interface TrialEvent { kind: string; preserved?: boolean; severity?: Severity; description?: string; }
export function detectAppealIssues(events: TrialEvent[]): Array<{ issue: string; preserved: boolean; severity: Severity; description?: string }> {
  const APPEAL_KINDS = new Set([
    "valoracion_prueba_erronea",
    "motivacion_insuficiente_sentencia",
    "conducta_indebida_ministerio_publico",
    "defensa_inadecuada",
    "violacion_constitucional",
    "error_individualizacion_pena",
  ]);
  return events
    .filter((e) => APPEAL_KINDS.has(e.kind))
    .map((e) => ({
      issue: e.kind.replace(/_/g, " "),
      preserved: e.preserved ?? false,
      severity: e.severity ?? "medium",
      description: e.description,
    }));
}

// ---------------------------------------------------------------------
// Top-level convenience: run every algorithm in one shot for the report.
// Inputs are tolerant — missing fields => zeroed contribution, never throw.
// ---------------------------------------------------------------------
export interface AlgorithmBundleInputs {
  evidence?: EvidenceItem[];
  witnesses?: Array<WitnessSignals & { id?: string; name?: string }>;
  timeline?: TimelineEvent[];
  statements?: Statement[];
  discovery?: DiscoveryRequest[];
  custody?: CustodyEntry[];
  burden?: { standard: BurdenStandard; elements: ElementSupport[] };
  risk?: RiskInputs;
  motionSignals?: MotionSignal[];
  trialEvents?: TrialEvent[];
  posture?: ProceduralPosture | null;
}
export function runAlgorithmBundle(input: AlgorithmBundleInputs) {
  return {
    layer: "deterministic_legal_intelligence_v1",
    evidence:        (input.evidence ?? []).map((e) => ({ id: e.id, ...scoreEvidence(e) })),
    witnesses:       (input.witnesses ?? []).map((w) => ({ id: w.id ?? null, name: w.name ?? null, ...scoreWitnessCredibility(w) })),
    timeline:        buildTimeline(input.timeline ?? []),
    contradictions:  detectContradictions(input.statements ?? []),
    discovery:       discoveryCompleteness(input.discovery ?? []),
    chain_of_custody: auditChainOfCustody(input.custody ?? []),
    burden:          input.burden ? evaluateBurden(input.burden.standard, input.burden.elements) : null,
    risk:            input.risk ? assessRisk(input.risk) : null,
    motions:         detectMotions(input.motionSignals ?? [], input.posture),
    appeal_issues:   detectAppealIssues(input.trialEvents ?? []),
  };
}
