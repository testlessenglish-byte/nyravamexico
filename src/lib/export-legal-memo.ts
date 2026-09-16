import { capturePdfText } from "./reporting/rendered-output";
import { releaseFinalReportPayload, releaseRenderedReportOutput, type FinalReportPayload } from "./reporting/final-report-contract";
import type { LegalMemorandum } from "@/components/LegalMemorandumPanel";
import { rt } from "./report-i18n";
import { PdfBuilder } from "./export";
import { translateLegalTerm } from "./pdf/enum-translation";
import { resolveReportIdentity } from "./pdf/identity-resolver";

type ChronEntry = string | { date?: string; event?: string; source?: string };
type DisputedEntry = string | { claim?: string; opposing_view?: string };

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function parseChron(entry: ChronEntry): { date: string; event: string; source: string } {
  if (typeof entry === "string") {
    const m = entry.match(/^\s*([^:]{1,40}):\s*(.*)$/);
    if (m) {
      const rest = m[2];
      const src = rest.match(/(\[[^\]]+\])\s*$/);
      return {
        date: m[1].trim(),
        event: src ? rest.slice(0, src.index).trim() : rest.trim(),
        source: src ? src[1] : "",
      };
    }
    return { date: "", event: entry, source: "" };
  }
  return { date: entry.date ?? "", event: entry.event ?? "", source: entry.source ?? "" };
}

function parseDisputed(entry: DisputedEntry): { claim: string; opposing: string } {
  if (typeof entry === "string") return { claim: entry, opposing: "" };
  return { claim: entry.claim ?? "", opposing: entry.opposing_view ?? "" };
}

export function downloadLegalMemoPdf(payload: FinalReportPayload, caseName: string, caseData: any = {}): void {
  const validated = releaseFinalReportPayload(payload);
  const memo = (validated.report?.full_report as {legal_memorandum?:LegalMemorandum})?.legal_memorandum;
  if (!memo) throw new Error("REPORT_MEMO_UNAVAILABLE");

  const b = new PdfBuilder(caseName, caseData.id?.slice(0,8));
  // Not strictly awaiting logo because synchronous context, but the builder has fallback.
  
  const identity = resolveReportIdentity(caseData);
  b.premiumCover({
    reportTitle: "MEMORANDUM OF LAW",
    caseName: caseName,
    client: identity.client,
    proceeding: translateLegalTerm(identity.proceedingType),
    matterType: translateLegalTerm(caseData.materia),
    court: translateLegalTerm(caseData.court_name),
    jurisdiction: translateLegalTerm(caseData.jurisdiction),
    matterId: identity.caseNumber,
    classification: "CONFIDENCIAL",
    date: new Date().toLocaleDateString("es-MX"),
    engineVersion: undefined,
    certification: "verified",
  });
  b.pageBreak();

  b.h1(memo.caption?.title || rt("MEMORANDUM OF LAW"));
  b.text(`Re: ${memo.caption?.re || caseName}`, { size: 11 });
  b.text(`Date: ${memo.caption?.date || new Date().toLocaleDateString()}`, { size: 11, gap: 10 });
  b.divider();

  const exec = memo.executive_summary ?? {};
  if (exec.dispositive_recommendation || exec.case_strength || exec.primary_risk || (exec.urgent_actions?.length ?? 0) > 0) {
    b.h2(rt("EXECUTIVE SUMMARY"));
    if (exec.dispositive_recommendation) {
      b.text("Bottom Line:", { bold: true });
      b.text(exec.dispositive_recommendation);
    }
    if (exec.case_strength) b.text(`Case Strength: ${exec.case_strength}`);
    if (exec.primary_risk) b.text(`Primary Risk: ${exec.primary_risk}`);
    if ((exec.urgent_actions?.length ?? 0) > 0) {
      b.text(rt("Urgent Actions Required:"), { bold: true });
      b.bullets(exec.urgent_actions!);
    }
  }

  const facts = memo.statement_of_facts ?? {};
  if ((facts.chronology?.length ?? 0) + (facts.undisputed?.length ?? 0) + (facts.disputed?.length ?? 0) > 0) {
    b.h2(rt("STATEMENT OF FACTS"));
    if ((facts.chronology?.length ?? 0) > 0) {
      b.text(rt("I. Chronology"), { bold: true, gap: 5 });
      const rows = facts.chronology!.map((raw) => {
        const c = parseChron(raw);
        return [c.date, c.event, c.source];
      });
      b.table([[rt("Date"), rt("Event"), rt("Source")]], rows, { columnStyles: {0: {'cellWidth': 60}, 1: {'cellWidth': 200}, 2: {'cellWidth': 100}} });
    }
    if ((facts.undisputed?.length ?? 0) > 0) {
      b.text(rt("II. Undisputed Facts"), { bold: true, gap: 5 });
      b.bullets(facts.undisputed!);
    }
    if ((facts.disputed?.length ?? 0) > 0) {
      b.text(rt("III. Disputed Facts"), { bold: true, gap: 5 });
      facts.disputed!.forEach((raw) => {
        const d = parseDisputed(raw);
        b.text(`• ${d.claim}`);
        if (d.opposing) b.text(`(Opposing view: ${d.opposing})`, { size: 10, color: [102, 102, 102] });
      });
    }
  }

  const irac = memo.legal_analysis ?? [];
  if (irac.length > 0) {
    b.h2(rt("LEGAL ANALYSIS"));
    irac.forEach((issue, i) => {
      b.text(`${i + 1}. ${issue.issue || ""}`, { bold: true });
      if (issue.rule) b.text(`RULE: ${issue.rule}`);
      if (issue.application) b.text(`APPLICATION: ${issue.application}`);
      if (issue.conclusion) b.text(`CONCLUSION: ${issue.conclusion}`);
      (issue.cited_evidence ?? []).forEach((ce) => b.evidenceQuote(ce, ""));
    });
  }

  const motions = memo.recommended_motions ?? [];
  if (motions.length > 0) {
    b.h2(rt("RECOMMENDED MOTIONS"));
    motions.forEach((m) => {
      b.text(m.motion || "", { bold: true });
      if (m.legal_standard) b.text(`Legal Standard: ${m.legal_standard}`);
      if ((m.factual_basis?.length ?? 0) > 0) {
        b.text(rt("Factual Basis:"), { bold: true });
        b.bullets(m.factual_basis!);
      }
      if (m.likelihood) b.text(`Likelihood: ${m.likelihood}`);
      if (m.draft_paragraph) b.evidenceQuote(m.draft_paragraph, rt("Draft Paragraph"));
    });
  }

  const exhibits = memo.evidence_appendix ?? [];
  if (exhibits.length > 0) {
    b.h2(rt("EVIDENCE APPENDIX"));
    const rows = exhibits.map((e) => [
      e.exhibit ?? "",
      e.description ?? "",
      e.page ?? "",
      e.key_quote ? `"${e.key_quote.slice(0, 160)}${e.key_quote.length > 160 ? "..." : ""}"` : "",
      e.proves ?? "",
      e.admissibility_risk ?? "",
    ]);
    b.table([[rt("Exhibit"), rt("Description"), rt("Page"), rt("Key Quote"), rt("Proves"), rt("Risk")]], rows, { columnStyles: {0: {'cellWidth': 50}, 1: {'cellWidth': 80}, 2: {'cellWidth': 40}, 3: {'cellWidth': 120}, 4: {'cellWidth': 60}, 5: {'cellWidth': 60}} });
  }

  const risks = memo.risk_matrix ?? [];
  if (risks.length > 0) {
    b.h2(rt("RISK MATRIX"));
    const rows = risks.map((r) => [r.risk ?? "", r.probability ?? "", r.impact ?? "", r.mitigation ?? ""]);
    b.table([[rt("Risk"), rt("Probability"), rt("Impact"), rt("Mitigation")]], rows, { columnStyles: {0: {'cellWidth': 100}, 1: {'cellWidth': 80}, 2: {'cellWidth': 80}, 3: {'cellWidth': 100}} });
  }

  const actions = memo.next_actions ? [...memo.next_actions] : [];
  if (actions.length > 0) {
    actions.sort((a, b) => {
      const pa = PRIORITY_ORDER[(a.priority ?? "medium").toLowerCase()] ?? 2;
      const pb = PRIORITY_ORDER[(b.priority ?? "medium").toLowerCase()] ?? 2;
      return pa - pb;
    });
    b.h2(rt("NEXT ACTIONS"));
    const rows = actions.map((a) => [a.priority ?? "", a.action ?? "", a.owner ?? "", a.deadline ?? ""]);
    b.table([[rt("Priority"), rt("Action"), rt("Owner"), rt("Deadline")]], rows, { columnStyles: {0: {'cellWidth': 60}, 1: {'cellWidth': 150}, 2: {'cellWidth': 80}, 3: {'cellWidth': 80}} });
  }

  // Not strictly supporting capturePdfText here since b.renderedText is internal, but we can access it
  b.finalizeLayout(null);
  releaseRenderedReportOutput(validated, "memo-pdf", b.renderedText.join("\n"));
  b.doc.save(`${identity.filename.replace('.pdf', '')}_Legal_Memo.pdf`);
}
