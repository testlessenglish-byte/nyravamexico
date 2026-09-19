// =============================================================================
// PLATFORM-WIDE MATTER PROFILE
// Single source of truth for the classification and routing of a matter.
// Replaces loose case_type / jurisdiction fields with explicit provenance.
// =============================================================================

import type { MxPipelineProfile } from "../execution/mx-pipeline";
import type { Fuero } from "./mx-jurisdiction";

/**
 * Indicates how a specific value was determined.
 * 
 * Hierarchy: explicit_metadata > caption > ai_extraction > heuristic > unknown
 */
export type ClassificationSource = 
  | "explicit_metadata" 
  | "caption"
  | "ai_extraction"
  | "heuristic"
  | "unknown";

export interface ProvenanceRecord<T> {
  value: T;
  confidence: number;
  source: ClassificationSource;
  source_document_id?: string | null;
  evidence_excerpt?: string | null;
  classification_method: string;
}

export type ProceduralSystem = "traditional_written" | "mixed" | "accusatory_oral_CNPP" | "unknown";

export interface MatterProfile {
  primary_materia: ProvenanceRecord<MxPipelineProfile>;
  secondary_legal_domains: string[];
  
  procedural_system: ProvenanceRecord<ProceduralSystem>;
  
  document_type: ProvenanceRecord<string | null>;
  procedural_posture: ProvenanceRecord<string | null>;
  
  jurisdiction: ProvenanceRecord<"federal" | "state" | "municipal" | "unresolved">;
  fuero: ProvenanceRecord<Fuero>;
  state: ProvenanceRecord<{ code: string; name: string } | null>;
  
  issuing_court: ProvenanceRecord<string | null>;
  court_level: ProvenanceRecord<string | null>;
  reviewing_court?: ProvenanceRecord<string | null>;
  
  cited_authorities: string[];
  applicable_law_regime: string[];
}

export interface LegacyCaseFallback {
  case_type?: string | null;
  jurisdiction?: string | null;
}

export function buildFallbackMatterProfile(legacy: LegacyCaseFallback): Partial<MatterProfile> {
  // Graceful fallback for historical cases lacking full provenance.
  // Never hallucinates procedural_system or issuing_court.
  return {
    jurisdiction: legacy.jurisdiction ? {
      value: legacy.jurisdiction === "federal" ? "federal" : "state",
      confidence: 1.0,
      source: "unknown",
      classification_method: "legacy_migration"
    } : undefined
  };
}
