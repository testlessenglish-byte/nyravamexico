// Module applicability layer.
//
// Nyrava's intelligence modules (Timeline, Witness, Motion, Evidence,
// Strategy, Deadlines) are not optional tools an attorney has to remember to
// open — after a case is analyzed the system decides, deterministically and
// from the case's own evidence, which modules produced meaningful output and
// which ones did not, and *why*.
//
// This module is pure/derived: it never fetches, it only reads the payload
// getCase() already returns, so the dashboard strip and each module page can
// never disagree about a module's state.

export type ModuleKey =
  | "timeline"
  | "witness"
  | "motion"
  | "evidence"
  | "strategy"
  | "deadlines";

export type ModuleStatus =
  | "active" // produced results
  | "none" // ran, but the corpus supports nothing meaningful
  | "pending" // case not analyzed yet
  | "suppressed"; // quality gate withheld output

export type ModuleState = {
  key: ModuleKey;
  status: ModuleStatus;
  count: number;
  /** i18n key explaining the current state in attorney-facing language. */
  reasonKey: string;
  to: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const today = () => new Date().toISOString().slice(0, 10);

/** Chronological events, canonical table first, report/finding fallbacks after. */
export function selectTimelineEvents(data: Any): Array<{
  date: string | null;
  title: string;
  description?: string | null;
  source?: string | null;
}> {
  const out: Array<{ date: string | null; title: string; description?: string | null; source?: string | null }> = [];
  const seen = new Set<string>();
  const push = (date: string | null, title: string, description?: string | null, source?: string | null) => {
    const t = String(title ?? "").trim();
    if (!t) return;
    const k = `${date ?? ""}|${t.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ date, title: t, description, source });
  };

  for (const ev of (data?.timeline_events ?? []) as Any[]) {
    push(
      ev.event_date ?? ev.date_raw ?? null,
      ev.event ?? ev.title ?? ev.description ?? "",
      ev.event || ev.title ? (ev.description ?? null) : null,
      ev.source_label ?? null,
    );
  }

  const fr = (data?.report?.full_report ?? {}) as Any;
  for (const arr of [fr.canonical_timeline?.events, fr.timeline, fr.events, fr.case_timeline].filter(Array.isArray) as Any[][]) {
    for (const ev of arr) {
      if (!ev) continue;
      push(
        ev.date ?? ev.when ?? ev.event_date ?? null,
        ev.title ?? ev.event ?? ev.name ?? "",
        ev.description ?? ev.detail ?? ev.summary ?? null,
        ev.source ?? ev.source_document ?? ev.citation ?? null,
      );
    }
  }

  for (const f of (data?.findings ?? []) as Any[]) {
    const d = f?.metadata?.event_date ?? f?.metadata?.date;
    if (d) push(d, f.title, f.description, f.source_quote);
  }

  return out.sort((a, b) => (a.date ?? "\uffff").localeCompare(b.date ?? "\uffff"));
}

/** Findings the witness-credibility agent produced, even without witness rows. */
export function selectWitnessSignals(data: Any): Any[] {
  return ((data?.findings ?? []) as Any[]).filter((f) =>
    String(f?.source_module ?? "").startsWith("agent:witness_credibility") ||
    String(f?.category_key ?? "") === "witness",
  );
}

// The opportunity engine's opportunity_type vocabulary (constitutional,
// timeline_attack, credibility_attack, discovery, evidence_attack, etc. —
// see engines.server.ts's allowedCategories) never actually contains a
// "motion"/"recurso"/"amparo" substring, and the model doesn't reliably
// populate recommended_motions on every opportunity it's grounded on. A
// filter that required one of those two conditions left Motion Center empty
// for cases with real, high-severity, evidence-cited opportunities (e.g. a
// CRITICAL "exceso en la garantía" constitutional defect) that plainly
// warrant attorney review for a filing even though the model never
// literally wrote out a motion title for it. High/critical severity is
// itself the signal that the opportunity is worth surfacing here.
export function selectMotionOpportunities(data: Any): Any[] {
  return ((data?.opportunities ?? []) as Any[]).filter((o) => {
    if (/motion|promoci|recurso|amparo|incidente/i.test(String(o?.opportunity_type ?? ""))) return true;
    if (Array.isArray(o?.recommended_motions) && o.recommended_motions.length > 0) return true;
    const sev = String(o?.severity ?? "").toLowerCase();
    return sev === "critical" || sev === "high";
  });
}

/**
 * Confidence tier for a proposed procedural action. Nyrava never tells an
 * attorney "file this next" — it distinguishes what the evidence supports.
 */
export type MotionTier =
  | "recommended"
  | "available"
  | "deadline"
  | "review";

export function motionTier(o: Any): MotionTier {
  const conf = Number(o?.confidence ?? o?.confidence_score ?? NaN);
  const deadline = o?.deadline ?? o?.due_date ?? o?.metadata?.deadline;
  if (deadline) {
    const d = String(deadline).slice(0, 10);
    if (d >= today()) return "deadline";
  }
  if (Number.isFinite(conf)) {
    if (conf >= 0.75) return "recommended";
    if (conf >= 0.45) return "available";
    return "review";
  }
  const sev = String(o?.severity ?? "").toLowerCase();
  if (sev === "critical" || sev === "high") return "recommended";
  if (sev === "medium") return "available";
  return "review";
}

export function isAnalyzed(data: Any): boolean {
  if (data?.report) return true;
  const status = String(data?.case?.status ?? "");
  if (status === "completed" || status === "validated") return true;
  return ((data?.pipeline_runs ?? []) as Any[]).some((r) => r?.status === "completed");
}

export function computeModuleStates(data: Any): ModuleState[] {
  const analyzed = isAnalyzed(data);
  const report = (data?.report ?? null) as Any;

  const events = selectTimelineEvents(data);
  const upcoming = events.filter((e) => e.date && e.date.slice(0, 10) >= today());
  const witnesses = (data?.witnesses ?? []) as Any[];
  const witnessSignals = selectWitnessSignals(data);
  const motions = selectMotionOpportunities(data);
  const evidence = ((data?.findings ?? []) as Any[]).filter((f) => f?.source_quote || f?.source_document_id);
  const strategy = [...((data?.theories ?? []) as Any[]), ...((data?.strategy ?? []) as Any[])];

  const state = (
    key: ModuleKey,
    to: string,
    count: number,
    noneKey: string,
    opts?: { suppressed?: boolean; suppressedKey?: string },
  ): ModuleState => {
    if (opts?.suppressed) {
      return { key, to, count, status: "suppressed", reasonKey: opts.suppressedKey ?? `mod.state.${key}.suppressed` };
    }
    if (count > 0) return { key, to, count, status: "active", reasonKey: `mod.state.${key}.active` };
    if (!analyzed) return { key, to, count, status: "pending", reasonKey: "mod.state.pending" };
    return { key, to, count, status: "none", reasonKey: noneKey };
  };

  return [
    state("timeline", "/timeline", events.length, "mod.state.timeline.none"),
    state(
      "witness",
      "/witness",
      witnesses.length || witnessSignals.length,
      witnessSignals.length > 0 ? "mod.state.witness.signalsOnly" : "mod.state.witness.none",
    ),
    state("motion", "/motion", motions.length, "mod.state.motion.none", {
      suppressed: report?.motions_suppressed === true,
      suppressedKey: "mod.state.motion.suppressed",
    }),
    state("evidence", "/evidence", evidence.length, "mod.state.evidence.none"),
    state("strategy", "/strategy", strategy.length, "mod.state.strategy.none", {
      suppressed: report?.scores_suppressed === true && strategy.length === 0,
      suppressedKey: "mod.state.strategy.suppressed",
    }),
    state("deadlines", "/alerts", upcoming.length, "mod.state.deadlines.none"),
  ];
}
