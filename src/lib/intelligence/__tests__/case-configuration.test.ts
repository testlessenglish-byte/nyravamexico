import { describe, it, expect } from "vitest";
import {
  createInitialCaseConfiguration,
  getCaseConfiguration,
  updateCaseConfigurationWithClassification,
  createExecutionConfigurationSnapshot,
  validateConfigurationForExecution,
} from "../case-configuration";

describe("CaseConfiguration & Persistence Handoff", () => {
  it("initializes authoritative case configuration from user inputs", () => {
    const config = createInitialCaseConfiguration({
      user_selected_case_type: "penal",
      user_selected_jurisdiction: "federal",
      user_selected_analysis_mode: "strict",
      user_selected_case_analysis_mode: "ongoing",
    });

    expect(config.user_selected_case_type).toBe("penal");
    expect(config.user_selected_jurisdiction).toBe("federal");
    expect(config.user_selected_analysis_mode).toBe("strict");
    expect(config.user_selected_case_analysis_mode).toBe("ongoing");
    expect(config.source).toBe("user");
    expect(config.classification_conflict).toBe(false);
    expect(config.active_case_type).toBe("penal");
  });

  it("coexists user selection and AI detection without erasing user choice", () => {
    const initial = createInitialCaseConfiguration({
      user_selected_case_type: "penal",
      user_selected_jurisdiction: "cdmx",
      user_selected_analysis_mode: "strict",
      user_selected_case_analysis_mode: "ongoing",
    });

    // Classifier runs and detects Laboral from document
    const updated = updateCaseConfigurationWithClassification(initial, {
      detected_case_type: "laboral",
      detected_jurisdiction: "federal",
      source_quote: "VISTOS para resolver los autos del juicio laboral...",
      document_filename: "demanda_laboral.pdf",
      allowAutoCorrection: false,
    });

    // User intent is strictly preserved
    expect(updated.user_selected_case_type).toBe("penal");
    expect(updated.user_selected_jurisdiction).toBe("cdmx");

    // Detected classification is separately recorded
    expect(updated.detected_case_type).toBe("laboral");
    expect(updated.detected_jurisdiction).toBe("federal");
    expect(updated.classification_conflict).toBe(true);
    expect(updated.conflict_details?.user_case_type).toBe("penal");
    expect(updated.conflict_details?.detected_case_type).toBe("laboral");
    expect(updated.conflict_details?.detected_quote).toContain("juicio laboral");
  });

  it("hydrates from matter_metadata.case_configuration first", () => {
    const caseRow = {
      id: "case-123",
      case_type: "laboral", // classifier wrote this
      jurisdiction: "federal",
      analysis_mode: "strict",
      case_analysis_mode: "ongoing",
      matter_metadata: {
        case_configuration: {
          user_selected_case_type: "penal",
          user_selected_jurisdiction: "cdmx",
          user_selected_analysis_mode: "strict",
          user_selected_case_analysis_mode: "ongoing",
          active_case_type: "laboral",
          classification_conflict: true,
          source: "user",
        },
      },
    };

    const hydrated = getCaseConfiguration(caseRow);
    expect(hydrated.user_selected_case_type).toBe("penal");
    expect(hydrated.user_selected_jurisdiction).toBe("cdmx");
    expect(hydrated.classification_conflict).toBe(true);
  });

  it("creates an immutable execution snapshot", () => {
    const caseRow = {
      id: "case-999",
      case_type: "penal",
      jurisdiction: "federal",
      analysis_mode: "strict",
      case_analysis_mode: "concluded_audit",
    };

    const snapshot = createExecutionConfigurationSnapshot(caseRow, "exec-456");
    expect(snapshot.execution_id).toBe("exec-456");
    expect(snapshot.case_id).toBe("case-999");
    expect(snapshot.case_type).toBe("penal");
    expect(snapshot.analysis_mode).toBe("strict");
    expect(snapshot.case_analysis_mode).toBe("concluded_audit");
    expect(snapshot.configuration_version).toBe(1);
    expect(snapshot.created_at).toBeDefined();
  });

  it("validates configuration before orchestration and rejects missing fields", () => {
    const invalidCase = {
      id: "case-bad",
      analysis_mode: "invalid_mode",
      case_analysis_mode: "ongoing",
    };

    expect(() => validateConfigurationForExecution(invalidCase)).toThrow(
      /\[ConfigurationError\] Invalid analysis_mode/,
    );
  });
});
