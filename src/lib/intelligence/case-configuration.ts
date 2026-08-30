// Authoritative Case Configuration & Execution Snapshot Model
//
// Cleanly separates user intent (user_selected_*) from AI detection (detected_*),
// prevents silent overwrites by classifiers, and provides immutable execution snapshots.

export interface ConflictDetails {
  user_case_type?: string | null;
  detected_case_type?: string | null;
  user_jurisdiction?: string | null;
  detected_jurisdiction?: string | null;
  detected_quote?: string | null;
  document_filename?: string | null;
}

export interface CaseConfiguration {
  // User Intent (never overwritten by classifier)
  user_selected_case_type: string | null;
  user_selected_jurisdiction: string | null;
  user_selected_analysis_mode: string;
  user_selected_case_analysis_mode: string;
  user_selected_procedural_vehicle?: string | null;
  user_selected_underlying_materia?: string | null;
  selected_at: string;
  source: "user" | "manual_edit" | "api";

  // AI Classification & Verification (coexists with user selection)
  detected_case_type?: string | null;
  verified_case_type?: string | null;
  detected_jurisdiction?: string | null;
  detected_procedural_vehicle?: string | null;
  detected_underlying_materia?: string | null;
  classification_conflict?: boolean;
  classification_resolution?: "user_preserved" | "auto_corrected" | "none";
  conflict_details?: ConflictDetails | null;

  // Active Operational Values (used for pipeline routing)
  active_case_type: string | null;
  active_jurisdiction: string | null;
  active_analysis_mode: string;
  active_case_analysis_mode: string;
  active_procedural_vehicle?: string | null;
  active_underlying_materia?: string | null;
}

export interface ExecutionConfiguration {
  execution_id: string;
  case_id: string;
  case_type: string | null;
  jurisdiction: string | null;
  analysis_mode: string;
  case_analysis_mode: string;
  procedural_vehicle?: string | null;
  underlying_materia?: string | null;
  user_selected_case_type: string | null;
  user_selected_jurisdiction: string | null;
  configuration_version: number;
  created_at: string;
}

/**
 * Creates the initial authoritative CaseConfiguration from user form inputs.
 */
export function createInitialCaseConfiguration(params: {
  user_selected_case_type: string | null;
  user_selected_jurisdiction: string | null;
  user_selected_analysis_mode: string;
  user_selected_case_analysis_mode: string;
  user_selected_procedural_vehicle?: string | null;
  user_selected_underlying_materia?: string | null;
  source?: "user" | "manual_edit" | "api";
}): CaseConfiguration {
  const selectedAt = new Date().toISOString();
  const source = params.source ?? "user";

  return {
    user_selected_case_type: params.user_selected_case_type ?? null,
    user_selected_jurisdiction: params.user_selected_jurisdiction ?? null,
    user_selected_analysis_mode: params.user_selected_analysis_mode || "strict",
    user_selected_case_analysis_mode: params.user_selected_case_analysis_mode || "ongoing",
    user_selected_procedural_vehicle: params.user_selected_procedural_vehicle ?? null,
    user_selected_underlying_materia: params.user_selected_underlying_materia ?? null,
    selected_at: selectedAt,
    source,

    detected_case_type: null,
    verified_case_type: null,
    detected_jurisdiction: null,
    detected_procedural_vehicle: null,
    detected_underlying_materia: null,
    classification_conflict: false,
    classification_resolution: "none",
    conflict_details: null,

    active_case_type: params.user_selected_case_type ?? null,
    active_jurisdiction: params.user_selected_jurisdiction ?? null,
    active_analysis_mode: params.user_selected_analysis_mode || "strict",
    active_case_analysis_mode: params.user_selected_case_analysis_mode || "ongoing",
    active_procedural_vehicle: params.user_selected_procedural_vehicle ?? null,
    active_underlying_materia: params.user_selected_underlying_materia ?? null,
  };
}

/**
 * Extracts CaseConfiguration from a case database row, with fallback to top-level fields.
 */
export function getCaseConfiguration(caseRow: Record<string, unknown> | null | undefined): CaseConfiguration {
  if (!caseRow) {
    return createInitialCaseConfiguration({
      user_selected_case_type: null,
      user_selected_jurisdiction: null,
      user_selected_analysis_mode: "strict",
      user_selected_case_analysis_mode: "ongoing",
    });
  }

  const mm = caseRow.matter_metadata as Record<string, unknown> | null | undefined;
  const existing = mm?.case_configuration as CaseConfiguration | undefined;

  if (existing && typeof existing === "object" && existing.user_selected_analysis_mode) {
    return existing;
  }

  // Fallback: Reconstruct from top-level columns if case_configuration JSON is missing
  const topType = (caseRow.case_type as string) || null;
  const topJur = (caseRow.jurisdiction as string) || null;
  const topMode = (caseRow.analysis_mode as string) || "strict";
  const topCaseAnalysisMode = (caseRow.case_analysis_mode as string) || "ongoing";
  const topVehicle = (caseRow.procedural_vehicle as string) || null;
  const topUnderlying = (caseRow.underlying_materia as string) || null;

  return {
    user_selected_case_type: (caseRow.user_selected_case_type as string) ?? topType,
    user_selected_jurisdiction: (caseRow.user_selected_jurisdiction as string) ?? topJur,
    user_selected_analysis_mode: topMode,
    user_selected_case_analysis_mode: topCaseAnalysisMode,
    user_selected_procedural_vehicle: topVehicle,
    user_selected_underlying_materia: topUnderlying,
    selected_at: (caseRow.created_at as string) || new Date().toISOString(),
    source: "user",

    detected_case_type: (caseRow.detected_case_type as string) || null,
    verified_case_type: (caseRow.verified_case_type as string) || null,
    detected_jurisdiction: (caseRow.detected_jurisdiction as string) || null,
    detected_procedural_vehicle: null,
    detected_underlying_materia: null,
    classification_conflict: Boolean(caseRow.classification_conflict),
    classification_resolution: "none",
    conflict_details: null,

    active_case_type: topType,
    active_jurisdiction: topJur,
    active_analysis_mode: topMode,
    active_case_analysis_mode: topCaseAnalysisMode,
    active_procedural_vehicle: topVehicle,
    active_underlying_materia: topUnderlying,
  };
}

/**
 * Merges AI-detected classification results without erasing user selections.
 */
export function updateCaseConfigurationWithClassification(
  current: CaseConfiguration,
  detected: {
    detected_case_type?: string | null;
    detected_jurisdiction?: string | null;
    detected_procedural_vehicle?: string | null;
    detected_underlying_materia?: string | null;
    source_quote?: string | null;
    document_filename?: string | null;
    allowAutoCorrection?: boolean;
  },
): CaseConfiguration {
  const hasTypeConflict = Boolean(
    detected.detected_case_type &&
      current.user_selected_case_type &&
      detected.detected_case_type !== current.user_selected_case_type,
  );

  const hasJurConflict = Boolean(
    detected.detected_jurisdiction &&
      current.user_selected_jurisdiction &&
      current.user_selected_jurisdiction !== "auto" &&
      detected.detected_jurisdiction !== current.user_selected_jurisdiction,
  );

  const isConflict = hasTypeConflict || hasJurConflict;

  const conflictDetails: ConflictDetails | null = isConflict
    ? {
        user_case_type: current.user_selected_case_type,
        detected_case_type: detected.detected_case_type ?? null,
        user_jurisdiction: current.user_selected_jurisdiction,
        detected_jurisdiction: detected.detected_jurisdiction ?? null,
        detected_quote: detected.source_quote ?? null,
        document_filename: detected.document_filename ?? null,
      }
    : null;

  // If auto-correction is allowed and user did not manually override, active case type uses detected
  const activeCaseType =
    detected.allowAutoCorrection && detected.detected_case_type
      ? detected.detected_case_type
      : current.user_selected_case_type ?? detected.detected_case_type ?? current.active_case_type;

  const activeJurisdiction =
    current.user_selected_jurisdiction && current.user_selected_jurisdiction !== "auto"
      ? current.user_selected_jurisdiction
      : detected.detected_jurisdiction ?? current.active_jurisdiction;

  return {
    ...current,
    detected_case_type: detected.detected_case_type ?? current.detected_case_type ?? null,
    verified_case_type: detected.detected_case_type ?? current.verified_case_type ?? null,
    detected_jurisdiction: detected.detected_jurisdiction ?? current.detected_jurisdiction ?? null,
    detected_procedural_vehicle:
      detected.detected_procedural_vehicle ?? current.detected_procedural_vehicle ?? null,
    detected_underlying_materia:
      detected.detected_underlying_materia ?? current.detected_underlying_materia ?? null,
    classification_conflict: isConflict,
    classification_resolution: isConflict ? (detected.allowAutoCorrection ? "auto_corrected" : "user_preserved") : "none",
    conflict_details: conflictDetails,

    active_case_type: activeCaseType,
    active_jurisdiction: activeJurisdiction,
    active_procedural_vehicle: detected.detected_procedural_vehicle ?? current.active_procedural_vehicle,
    active_underlying_materia: detected.detected_underlying_materia ?? current.active_underlying_materia,
  };
}

/**
 * Creates an immutable snapshot of configuration for a specific pipeline execution.
 */
export function createExecutionConfigurationSnapshot(
  caseRow: Record<string, unknown>,
  executionId: string,
): ExecutionConfiguration {
  const config = getCaseConfiguration(caseRow);

  return {
    execution_id: executionId,
    case_id: String(caseRow.id ?? ""),
    case_type: config.active_case_type,
    jurisdiction: config.active_jurisdiction,
    analysis_mode: config.active_analysis_mode,
    case_analysis_mode: config.active_case_analysis_mode,
    procedural_vehicle: config.active_procedural_vehicle ?? null,
    underlying_materia: config.active_underlying_materia ?? null,
    user_selected_case_type: config.user_selected_case_type,
    user_selected_jurisdiction: config.user_selected_jurisdiction,
    configuration_version: 1,
    created_at: new Date().toISOString(),
  };
}

/**
 * Asserts required configuration fields before pipeline orchestration begins.
 * Throws a clear ConfigurationError if invalid.
 */
export function validateConfigurationForExecution(caseRow: Record<string, unknown>): {
  valid: boolean;
  config: CaseConfiguration;
} {
  const config = getCaseConfiguration(caseRow);

  if (!config.active_analysis_mode) {
    throw new Error(`[ConfigurationError] Missing analysis_mode for case ${caseRow.id}`);
  }

  if (!["strict", "balanced", "exploratory"].includes(config.active_analysis_mode)) {
    throw new Error(
      `[ConfigurationError] Invalid analysis_mode "${config.active_analysis_mode}" for case ${caseRow.id}`,
    );
  }

  if (!config.active_case_analysis_mode) {
    throw new Error(`[ConfigurationError] Missing case_analysis_mode for case ${caseRow.id}`);
  }

  if (
    !["ongoing", "concluded_audit", "judgment_audit", "appeal_routes"].includes(
      config.active_case_analysis_mode,
    )
  ) {
    throw new Error(
      `[ConfigurationError] Invalid case_analysis_mode "${config.active_case_analysis_mode}" for case ${caseRow.id}`,
    );
  }

  return { valid: true, config };
}
