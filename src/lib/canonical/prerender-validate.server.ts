// Prerender validation for the canonical report.
//
// Freeze-compliant: does not add, remove, reorder, or rename any of the 17
// locked sections. Only inspects section prose/values and flags:
//   • unresolved template tokens ({{...}}, ${...}, %s, %{name})
//   • literal placeholder tokens seen in the wild ("well-supported",
//     "TBD", "N/A" glued to numbers, "conditional power of well-supported")
//   • stray null/undefined/NaN literals leaked into prose
//   • percentage/score sanity (0–100, no NaN, no "NaN%")
//   • criminal-doctrine leakage in non-criminal case types
//
// The gate treats CRITICAL issues as blocking (report is written with
// status="validated" instead of "completed") and WARNINGS as informational.
//
// validateBeforeRender's target is exclusively the 17-section CaseAnalysis
// (canonical_analysis, an additive shadow projection — see gate.server.ts).
// validateRenderedReport (below) is the SAME prose-walking approach, plus a
// Spanish criminal-institution denylist, pointed at reports.full_report —
// the actual content export.ts/the report UI renders for the attorney,
// independent of whether the canonical-projection pipeline ran at all.
//
// Pure module — no I/O.

import type { CaseAnalysis } from "./case-analysis";
import { checkDomainVocabulary } from "@/lib/intelligence/domain-vocabulary-gate";

export type QaSeverity = "critical" | "warning";

export interface QaIssue {
  code: string;
  severity: QaSeverity;
  section: string;
  message: string;
  sample?: string;
}

const PLACEHOLDER_PATTERNS: Array<{ code: string; rx: RegExp; severity: QaSeverity }> = [
  { code: "TOKEN_MUSTACHE", rx: /\{\{\s*[\w.$-]+\s*\}\}/g, severity: "critical" },
  { code: "TOKEN_DOLLAR_BRACE", rx: /\$\{\s*[\w.$-]+\s*\}/g, severity: "critical" },
  { code: "TOKEN_PRINTF", rx: /%\{[\w.$-]+\}|%s\b|%d\b/g, severity: "critical" },
  { code: "TOKEN_WELL_SUPPORTED", rx: /\bwell-supported\b/gi, severity: "critical" },
  { code: "TOKEN_CONDITIONAL_POWER", rx: /conditional power of\s+[a-z-]+/gi, severity: "critical" },
  { code: "TOKEN_NULL_LITERAL", rx: /\b(?:null|undefined|NaN)\b(?!\s*(?:pointer|reference|value|checks?))/g, severity: "warning" },
  { code: "TOKEN_TBD", rx: /\b(?:TBD|TODO|FIXME|XXX)\b/g, severity: "warning" },
  { code: "TOKEN_NAN_PERCENT", rx: /NaN\s*%|Infinity\s*%/gi, severity: "critical" },
  { code: "TOKEN_DOUBLE_SPACE_PERIOD", rx: /\.\s{3,}[A-Z]/g, severity: "warning" },
];

const CRIMINAL_ONLY_TERMS = [
  /\bFranks hearing\b/i,
  /\bFranks v\.?\s+Delaware\b/i,
  /\bsearch warrant\b/i,
  /\bwarrant affidavit\b/i,
  /\bMiranda (?:warning|rights|waiver)\b/i,
  /\bfruit of the poisonous tree\b/i,
  /\bMotion to Suppress\b/i,
  /\bBrady (?:material|violation|obligation)\b/i,
  /\bFourth Amendment (?:seizure|search)\b/i,
];

const US_PROCEDURE_TERMS_ALWAYS_WRONG = [
  /\bMotion to Dismiss\b/i,
  /\bMotion to Compel\b/i,
  /\bMotion in Limine\b/i,
  /\bDiscovery Sanctions?\b/i,
  /\bSummary Judgment\b/i,
  /\bProtective Order\b/i,
];

// `penal` is the canonical Mexican case_type. The older English aliases are
// retained because historical rows and tests still use them.
const CRIMINAL_AREAS = new Set(["penal", "criminal", "criminal_defense", "criminal-defense"]);

function isCriminal(caseType: string | null | undefined): boolean {
  const s = String(caseType ?? "").toLowerCase();
  return [...CRIMINAL_AREAS].some((k) => s.includes(k));
}

function* walkStrings(node: unknown, path: string): Generator<{ path: string; value: string }> {
  if (node == null) return;
  if (typeof node === "string") {
    if (node.trim()) yield { path, value: node };
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* walkStrings(node[i], `${path}[${i}]`);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      yield* walkStrings(v, path ? `${path}.${k}` : k);
    }
  }
}

function firstMatch(value: string, rx: RegExp): string | undefined {
  const m = value.match(rx);
  return m?.[0];
}

function validateScores(analysis: CaseAnalysis, issues: QaIssue[]): void {
  const s = analysis.Scores ?? {};
  const numericKeys: (keyof typeof s)[] = [
    "case_strength",
    "evidence_strength",
    "witness_reliability",
    "timeline_integrity",
    "overall_confidence",
  ];
  for (const k of numericKeys) {
    const v = s[k];
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push({
        code: "SCORE_NOT_FINITE",
        severity: "critical",
        section: "Scores",
        message: `Scores.${String(k)} is not a finite number (${String(v)}).`,
      });
      continue;
    }
    if (v < 0 || v > 100) {
      issues.push({
        code: "SCORE_OUT_OF_RANGE",
        severity: "critical",
        section: "Scores",
        message: `Scores.${String(k)} = ${v} is outside 0–100.`,
      });
    }
  }
}

export function validateBeforeRender(analysis: CaseAnalysis): QaIssue[] {
  const issues: QaIssue[] = [];
  const caseType = analysis.ExecutiveSummary?.case_type ?? null;
  const criminal = isCriminal(caseType);

  for (const { path, value } of walkStrings(analysis, "")) {
    for (const p of PLACEHOLDER_PATTERNS) {
      const sample = firstMatch(value, p.rx);
      if (sample) {
        issues.push({
          code: p.code,
          severity: p.severity,
          section: path.split(".")[0] || "Report",
          message: `Unresolved token in ${path}: "${sample}"`,
          sample,
        });
      }
    }
    if (!criminal) {
      for (const rx of CRIMINAL_ONLY_TERMS) {
        const sample = firstMatch(value, rx);
        if (sample) {
          issues.push({
            code: "CASE_TYPE_LEAK",
            severity: "critical",
            section: path.split(".")[0] || "Report",
            message: `Criminal-doctrine term "${sample}" appeared in a ${caseType ?? "non-criminal"} report at ${path}.`,
            sample,
          });
        }
      }
    }
    for (const rx of US_PROCEDURE_TERMS_ALWAYS_WRONG) {
      const sample = firstMatch(value, rx);
      if (sample) {
        issues.push({
          code: "US_PROCEDURE_LEAK",
          severity: "critical",
          section: path.split(".")[0] || "Report",
          message: `U.S. procedural term "${sample}" has no Mexican-law equivalent and must not appear in a Mexican report (${path}).`,
          sample,
        });
      }
    }
  }

  validateScores(analysis, issues);

  if (analysis.Scores?.suppressed && !String(analysis.Scores.rationale ?? "").trim()) {
    issues.push({
      code: "SUPPRESSION_NO_REASON",
      severity: "warning",
      section: "Scores",
      message: "Scores are suppressed but no rationale is set. The report will display a suppression without explaining why.",
    });
  }

  return issues;
}

export function partitionIssues(issues: QaIssue[]): { critical: QaIssue[]; warnings: QaIssue[] } {
  return {
    critical: issues.filter((i) => i.severity === "critical"),
    warnings: issues.filter((i) => i.severity === "warning"),
  };
}

function readQualityCriticalIssues(reportContent: Record<string, unknown>): string[] {
  const full = reportContent.full_report;
  if (!full || typeof full !== "object" || Array.isArray(full)) return [];
  const validation = (full as Record<string, unknown>).validation;
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) return [];
  const qualityGate = (validation as Record<string, unknown>).quality_gate;
  if (!qualityGate || typeof qualityGate !== "object" || Array.isArray(qualityGate)) return [];
  const critical = (qualityGate as Record<string, unknown>).critical_issues;
  return Array.isArray(critical)
    ? critical.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
}

// ----------------------------------------------------------------------------
// Canonical Reconciliation Design (2026-08-16), P3 §10 — validateBeforeRender
// above only ever validates canonical_analysis. validateRenderedReport scans
// the actual reports row/full_report that UI/export consumers receive.
// ----------------------------------------------------------------------------
export function validateRenderedReport(
  reportContent: Record<string, unknown>,
  caseType: string | null | undefined,
  underlyingMateria?: string | null,
): QaIssue[] {
  const issues: QaIssue[] = [];
  const criminal = isCriminal(caseType) || isCriminal(underlyingMateria);

  for (const { path, value } of walkStrings(reportContent, "")) {
    for (const p of PLACEHOLDER_PATTERNS) {
      const sample = firstMatch(value, p.rx);
      if (sample) {
        issues.push({
          code: p.code,
          severity: p.severity,
          section: path.split(".")[0] || "Report",
          message: `Unresolved token in ${path}: "${sample}"`,
          sample,
        });
      }
    }
    if (!criminal) {
      for (const rx of CRIMINAL_ONLY_TERMS) {
        const sample = firstMatch(value, rx);
        if (sample) {
          issues.push({
            code: "CASE_TYPE_LEAK",
            severity: "critical",
            section: path.split(".")[0] || "Report",
            message: `Criminal-doctrine term "${sample}" appeared in a ${caseType ?? "non-criminal"} report at ${path}.`,
            sample,
          });
        }
      }
      const domainCheck = checkDomainVocabulary(
        value,
        caseType ?? undefined,
        underlyingMateria,
      );
      if (!domainCheck.clean) {
        for (const label of domainCheck.violations) {
          issues.push({
            code: "SPANISH_CASE_TYPE_LEAK",
            severity: "critical",
            section: path.split(".")[0] || "Report",
            message: `Penal-only institution "${label}" appeared in a ${caseType ?? "non-penal"} report at ${path}.`,
            sample: label,
          });
        }
      }
    }
    for (const rx of US_PROCEDURE_TERMS_ALWAYS_WRONG) {
      const sample = firstMatch(value, rx);
      if (sample) {
        issues.push({
          code: "US_PROCEDURE_LEAK",
          severity: "critical",
          section: path.split(".")[0] || "Report",
          message: `U.S. procedural term "${sample}" has no Mexican-law equivalent and must not appear in a Mexican report (${path}).`,
          sample,
        });
      }
    }
  }

  // The aggregate quality score itself is not calibrated and therefore is
  // not a release criterion. Its `critical_issues` array is different: these
  // are deterministic integrity failures emitted by report-quality-gate.ts
  // (e.g. orphaned citations, a missing legal memorandum, or a failed memo
  // chunk). A report may score below 70 for harmless reasons such as having
  // no cross-examination, but it may not be released with a known critical.
  for (const critical of readQualityCriticalIssues(reportContent)) {
    const orphanMatch = critical.match(/^(\d+)\s+orphaned citation/);
    const orphanCount = orphanMatch ? Number(orphanMatch[1]) : 0;
    // Systemic citation failure (>=15) or structural failure (absent memo/chunk) is critical;
    // isolated incidental citation offsets (<15, common with character-chunking vs PDF pages) are warnings.
    const isCritical = orphanMatch ? orphanCount >= 15 : true;
    issues.push({
      code: isCritical ? "REPORT_QUALITY_CRITICAL" : "REPORT_QUALITY_WARNING",
      severity: isCritical ? "critical" : "warning",
      section: "full_report.validation.quality_gate",
      message: critical,
      sample: critical,
    });
  }

  return issues;
}

