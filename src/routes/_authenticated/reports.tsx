import { releaseFinalReportPayload, type FinalReportPayload } from "@/lib/reporting/final-report-contract";
import { fetchCurrentCaseExport } from "@/lib/reporting/case-json-export";
import { CanonicalReportFindings } from "@/components/reports/CanonicalReportFindings";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { FileText, FileDown, FileJson, ExternalLink } from "lucide-react";
import { getCase } from "@/lib/cases.functions";
import { CasePicker, useActiveCase } from "@/components/modules/CasePicker";
import { ModuleHeader, ModuleEmpty, SuppressedNotice } from "@/components/modules/SuppressedNotice";
import { isDeterministicFallback } from "@/lib/intelligence/canonical";
// NOTE: intentionally a type-only import. `@/lib/export` statically imports
// jsPDF (which transitively bundles html2canvas, a browser-only module) —
// importing it at the top of this file pulls that into the SSR module graph
// and crashes the server build. `downloadPdf`/`downloadJson`
// are loaded dynamically inside each button's onClick below instead, so
// Vite code-splits them into a client-only chunk that SSR never touches.
import type { CaseExportData } from "@/lib/export";
import { toast } from "sonner";
import { useI18n } from "@/i18n";
import { LegalMemorandumPanel, type LegalMemorandum } from "@/components/LegalMemorandumPanel";
import type { DocumentRow } from "@/components/reports/shared";
import { EvidenceMapTable } from "@/components/reports/EvidenceMapTable";
import { AgentStatsTable } from "@/components/reports/AgentStatsTable";
import { WitnessProfiles } from "@/components/reports/WitnessProfiles";
import { LegalIssuesTable } from "@/components/reports/LegalIssuesTable";
import { ContradictionsBreakdown } from "@/components/reports/ContradictionsBreakdown";
import { EvidenceInventoryTable } from "@/components/reports/EvidenceInventoryTable";
import { OpportunityReviewSection } from "@/components/reports/OpportunityReviewSection";
import { AttorneyWorkProduct } from "@/components/reports/AttorneyWorkProduct";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({ meta: [{ title: "Reports — Nyrava" }] }),
  component: ReportsPage,
});

// Suppression-reason keys emitted by the report pipeline, mapped to
// localized labels — never surfaced as raw internal reason codes.
const SUPPRESSION_REASON_KEYS: Record<string, string> = {
  duplicate: "reports.suppressionReason.duplicate",
  tautology_or_trivial: "reports.suppressionReason.trivial",
  no_supporting_evidence_in_corpus: "reports.suppressionReason.noCitation",
  violation_claim_without_proof: "reports.suppressionReason.violationWithoutProof",
  criminal_terminology_in_civil_case: "reports.suppressionReason.criminalTermsInCivilCase",
  missing_citation_for_strict_claim: "reports.suppressionReason.missingCitation",
};

function ReportsPage() {
  const { t, locale } = useI18n();
  const { cases, activeId, isLoading } = useActiveCase();
  const [selected, setSelected] = useState<string | null>(null);
  const caseId = selected ?? activeId;
  const fetchCase = useServerFn(getCase);
  const queryClient = useQueryClient();
  const { data: rawData, isLoading: caseLoading } = useQuery({
    queryKey: ["case", caseId],
    queryFn: () => fetchCase({ data: { caseId: caseId! } }),
    enabled: !!caseId,
    refetchInterval: 5_000,
    refetchOnMount: "always",
  });

  const freshExportData = async () => {
    if (!caseId) throw new Error(t("reports.empty.noReport.title"));
    return fetchCurrentCaseExport({
      caseId,
      fetchCase: (id) => fetchCase({ data: { caseId: id } }),
      onFresh: (fresh) => queryClient.setQueryData(["case", caseId], fresh),
    });
  };

  let finalPayload: FinalReportPayload | undefined;
  let contractError = "";
  if (rawData?.report) {
    try { finalPayload = releaseFinalReportPayload(rawData as unknown as CaseExportData); }
    catch (error) { contractError = error instanceof Error ? error.message : "Report validation failed"; }
  }
  const data = (finalPayload ?? rawData) as typeof rawData;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report = (contractError ? null : data?.report) as any;
  const name = (data?.case as any)?.name ?? t("reports.export.defaultCaseName");
  const scoresSuppressed = report?.scores_suppressed === true;
  const motionsSuppressed = report?.motions_suppressed === true;
  const detFallback = isDeterministicFallback(report);
  // Phase 4: the report is a snapshot of a specific canonical analysis version.
  // If the gate has since produced a newer one, say so rather than silently
  // re-rendering — regeneration stays an explicit attorney action.
  const reportCanonicalVersion =
    typeof report?.canonical_version === "number" ? (report.canonical_version as number) : null;
  const currentCanonicalVersion =
    typeof (data as { canonical_current_version?: number | null } | undefined)?.canonical_current_version === "number"
      ? ((data as { canonical_current_version?: number | null }).canonical_current_version as number)
      : null;
  const canonicalStale =
    reportCanonicalVersion !== null &&
    currentCanonicalVersion !== null &&
    currentCanonicalVersion > reportCanonicalVersion;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engines = (report?.engines_summary ?? {}) as Record<string, any>;
  const reportMode: "FULL" | "LIMITED" | null =
    report?.report_mode === "FULL" || report?.report_mode === "LIMITED" ? report.report_mode : null;
  const modeLabel =
    reportMode === "FULL" ? t("reports.mode.full") : reportMode === "LIMITED" ? t("reports.mode.limited") : null;

  const run = (fn: () => unknown | Promise<unknown>, labelKey: string) => {
    const onFail = (e: unknown) => {
      console.error("[export] failed", labelKey, e);
      toast.error(
        t("reports.toast.exportFailed", {
          label: t(labelKey),
          error: e instanceof Error ? e.message : t("reports.error.unknown"),
        }),
      );
    };
    try {
      const result = fn();
      if (result instanceof Promise) result.catch(onFail);
    } catch (e) {
      onFail(e);
    }
  };

  if (contractError) return <p role="alert">{contractError}</p>;
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <ModuleHeader
        icon={<FileText className="h-5 w-5" />}
        title={t("reports.page.title")}
        subtitle={t("reports.page.subtitle")}
      />
      {isLoading ? (
        <div className="rounded-xl border border-border bg-card/60 p-10 text-center text-sm text-muted-foreground">
          {t("reports.loading.cases")}
        </div>
      ) : (
        <div className="space-y-5">
          <CasePicker cases={cases} activeId={caseId} onChange={setSelected} />
          {caseId ? (
            caseLoading ? (
              <div className="rounded-xl border border-border bg-card/60 p-10 text-center text-sm text-muted-foreground">
                {t("reports.loading.report")}
              </div>
            ) : !report ? (
              <ModuleEmpty title={t("reports.empty.noReport.title")} hint={t("reports.empty.noReport.hint")} />
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-card/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-semibold">{name}</h2>
                        {modeLabel ? (
                          <span
                            className={
                              reportMode === "FULL"
                                ? "rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                                : "rounded-full border border-border bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                            }
                          >
                            {modeLabel}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("reports.generatedAt", {
                          date: new Date(report.updated_at ?? report.created_at).toLocaleString(locale),
                        })}
                        {(report as { execution_id?: string | null }).execution_id ? (
                          <>
                            {" · "}
                            <span className="font-mono">
                              {t("reports.executionId", {
                                id: String((report as { execution_id?: string | null }).execution_id).slice(0, 8),
                              })}
                            </span>
                          </>
                        ) : null}
                      </p>

                    </div>
                    <Link
                      to="/cases/$caseId"
                      params={{ caseId: caseId }}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      {t("reports.openWorkspace")} <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                  {Object.keys(engines).length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {Object.entries(engines).map(([k, v]) => (
                        <span
                          key={k}
                          className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {t("reports.engineStatus", { engine: k, status: v?.status ?? t("common.dash") })}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                {canonicalStale ? (
                  <SuppressedNotice
                    title={t("reports.notice.canonicalStale", {
                      current: String(reportCanonicalVersion),
                      latest: String(currentCanonicalVersion),
                    })}
                  />
                ) : null}
                {detFallback ? <SuppressedNotice title={t("reports.notice.limitedAnalysis")} /> : null}
                {scoresSuppressed ? <SuppressedNotice title={t("reports.notice.scoresSuppressed")} /> : null}
                {motionsSuppressed ? <SuppressedNotice title={t("reports.notice.motionsSuppressed")} /> : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    onClick={() =>
                      run(async () => {
                        const { downloadPdf } = await import("@/lib/export");
                        return downloadPdf(await freshExportData(), name);
                      }, "reports.export.pdf")
                    }
                    className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-4 hover:bg-card/80"
                  >
                    <FileDown className="h-5 w-5 text-primary" />
                    <span className="text-sm font-medium">{t("reports.export.pdf")}</span>
                  </button>

                  <button
                    onClick={() =>
                      run(async () => {
                        const { downloadJson } = await import("@/lib/export");
                        return downloadJson(await freshExportData(), name);
                      }, "reports.export.json")
                    }
                    className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-4 hover:bg-card/80"
                  >
                    <FileJson className="h-5 w-5 text-primary" />
                    <span className="text-sm font-medium">{t("reports.export.json")}</span>
                  </button>
                </div>

                {(() => {
                  const fs = (report?.full_report as any)?.findings_summary as
                    | {
                        total_generated?: number;
                        displayed?: number;
                        suppressed?: number;
                        duplicates_merged?: number;
                        suppression_reasons?: Record<string, number>;
                      }
                    | undefined;
                  if (!fs) return null;
                  const reasons = fs.suppression_reasons ?? {};
                  const rows = Object.entries(reasons).filter(([, v]) => (v ?? 0) > 0);
                  return (
                    <div className="rounded-xl border border-border bg-card/60 p-4">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">
                        {t("reports.findingsSummary.title")}
                      </p>
                      <div className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
                        <div>
                          <div className="text-2xl font-semibold">{fs.total_generated ?? 0}</div>
                          <div className="text-xs text-muted-foreground">
                            {t("reports.findingsSummary.totalGenerated")}
                          </div>
                        </div>
                        <div>
                          <div className="text-2xl font-semibold text-primary">{fs.displayed ?? 0}</div>
                          <div className="text-xs text-muted-foreground">
                            {t("reports.findingsSummary.verifiedAndDisplayed")}
                          </div>
                        </div>
                        <div>
                          <div className="text-2xl font-semibold">{fs.suppressed ?? 0}</div>
                          <div className="text-xs text-muted-foreground">{t("reports.findingsSummary.suppressed")}</div>
                        </div>
                      </div>
                      {rows.length > 0 ? (
                        <div className="mt-3 border-t border-border pt-3">
                          <p className="text-xs font-medium text-muted-foreground">
                            {t("reports.findingsSummary.breakdown")}
                          </p>
                          <ul className="mt-1 space-y-0.5 text-xs">
                            {rows.map(([k, v]) => (
                              <li key={k} className="flex justify-between">
                                <span>{SUPPRESSION_REASON_KEYS[k] ? t(SUPPRESSION_REASON_KEYS[k]) : k}</span>
                                <span className="tabular-nums text-muted-foreground">{v}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  );
                })()}

                {(() => {
                  // FIX (2026-08-17, bug report "quarantined/unverified
                  // findings render as authoritative content" — item 4, the
                  // report's own authors named this "the highest-leverage
                  // fix even before the deeper root cause is resolved"):
                  // citation_audit already computes, on every report, which
                  // findings lack a complete supporting citation and were
                  // excluded from recommendations/legal_memorandum — this
                  // just surfaces that existing data instead of leaving it
                  // invisible.
                  const audit = (report?.full_report as any)?.citation_audit as
                    | {
                        total?: number;
                        supported?: number;
                        quarantined?: number;
                        supported_pct?: number;
                        quarantined_findings?: Array<{
                          finding_id: string;
                          title: string;
                          reason?: string;
                        }>;
                      }
                    | undefined;
                  const items = audit?.quarantined_findings ?? [];
                  if (!audit || items.length === 0) return null;
                  const REASON_KEYS: Record<string, string> = {
                    missing_document: "reports.citationAudit.reason.missingDocument",
                    missing_quote: "reports.citationAudit.reason.missingQuote",
                    missing_page_and_refs: "reports.citationAudit.reason.missingPageAndRefs",
                    missing_all: "reports.citationAudit.reason.missingAll",
                  };
                  return (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">
                        {t("reports.citationAudit.title")}
                      </p>
                      <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                        <div>
                          <div className="text-2xl font-semibold text-primary">
                            {audit.supported ?? 0}
                            {typeof audit.supported_pct === "number" ? ` (${audit.supported_pct}%)` : ""}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t("reports.citationAudit.supported")}
                          </div>
                        </div>
                        <div>
                          <div className="text-2xl font-semibold text-amber-600 dark:text-amber-400">
                            {audit.quarantined ?? items.length}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t("reports.citationAudit.quarantined")}
                          </div>
                        </div>
                      </div>
                      <details className="mt-3 border-t border-border pt-3">
                        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                          {t("reports.citationAudit.quarantined")} ({items.length})
                        </summary>
                        <p className="mt-2 text-xs italic text-muted-foreground">
                          {t("reports.citationAudit.disclaimer")}
                        </p>
                        <ul className="mt-2 space-y-1 text-xs">
                          {items.map((it) => (
                            <li key={it.finding_id} className="flex items-start justify-between gap-2">
                              <span>{it.title}</span>
                              <span className="shrink-0 text-muted-foreground">
                                {it.reason && REASON_KEYS[it.reason] ? t(REASON_KEYS[it.reason]) : it.reason}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  );
                })()}

                {(() => {
                  // FIX (2026-08-18, ADR-5829/2025 audit — item 8): the
                  // pipeline already runs validateRenderedReport on the
                  // FINAL rendered report content every time and stores
                  // real detected defects (e.g. SPANISH_CASE_TYPE_LEAK —
                  // penal-only vocabulary appearing in a non-penal report,
                  // the exact shape of the off-topic criminal-procedure
                  // content this audit flagged) on full_report.rendered_qa
                  // — this just surfaces that existing detection, same
                  // precedent as the citation-audit card above.
                  const qa = (report?.full_report as any)?.rendered_qa as
                    | {
                        critical_count?: number;
                        issues?: Array<{ code: string; severity: string; message: string }>;
                      }
                    | undefined;
                  const critical = (qa?.issues ?? []).filter((i) => i.severity === "critical");
                  if (!qa || critical.length === 0) return null;
                  const CODE_KEYS: Record<string, string> = {
                    SPANISH_CASE_TYPE_LEAK: "reports.reportQa.code.spanishCaseTypeLeak",
                    CASE_TYPE_LEAK: "reports.reportQa.code.caseTypeLeak",
                    US_PROCEDURE_LEAK: "reports.reportQa.code.usProcedureLeak",
                  };
                  return (
                    <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">
                        {t("reports.reportQa.title")}
                      </p>
                      <p className="mt-1 text-sm">
                        {t("reports.reportQa.summary", { count: critical.length })}
                      </p>
                      <details className="mt-3 border-t border-border pt-3">
                        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                          {t("reports.reportQa.viewIssues")} ({critical.length})
                        </summary>
                        <ul className="mt-2 space-y-1 text-xs">
                          {critical.map((it, i) => (
                            <li key={i} className="flex flex-col gap-0.5">
                              <span className="font-medium text-red-600 dark:text-red-400">
                                {CODE_KEYS[it.code] ? t(CODE_KEYS[it.code]) : it.code}
                              </span>
                              <span className="text-muted-foreground">{it.message}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  );
                })()}

                {finalPayload && <CanonicalReportFindings payload={finalPayload} />}

                {report.executive_summary ? (
                  <div className="rounded-xl border border-border bg-card/60 p-4">
                    <p className="text-xs font-semibold uppercase text-muted-foreground">
                      {t("reports.executiveSummary.title")}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm">{report.executive_summary}</p>
                  </div>
                ) : null}

                <LegalMemorandumPanel
                  payload={finalPayload}
                  memo={
                    (report?.full_report as { legal_memorandum?: LegalMemorandum } | null)?.legal_memorandum ?? null
                  }
                  caseName={name}
                />

                <EvidenceMapTable
                  fullReport={report?.full_report}
                  documents={(data?.documents ?? []) as DocumentRow[]}
                  caseId={caseId}
                />
                <AgentStatsTable fullReport={report?.full_report} caseId={caseId} itemFlags={report?.item_flags} />
                <WitnessProfiles fullReport={report?.full_report} caseId={caseId} itemFlags={report?.item_flags} />
                <LegalIssuesTable fullReport={report?.full_report} caseId={caseId} itemFlags={report?.item_flags} />
                <ContradictionsBreakdown
                  fullReport={report?.full_report}
                  caseId={caseId}
                  itemFlags={report?.item_flags}
                />
                <EvidenceInventoryTable
                  fullReport={report?.full_report}
                  caseId={caseId}
                  itemFlags={report?.item_flags}
                />
                <OpportunityReviewSection
                  fullReport={report?.full_report}
                  caseId={caseId}
                  itemFlags={report?.item_flags}
                />
                <AttorneyWorkProduct fullReport={report?.full_report} caseId={caseId} itemFlags={report?.item_flags} />
              </div>
            )
          ) : null}
        </div>
      )}
    </div>
  );
}
