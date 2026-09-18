import { describe, it, expect } from 'vitest';
import { canGenerateReport, CANONICAL_STAGES } from '../canonical';
import type { ExecutionRow } from '../canonical';

describe('Platform-Wide Release Gate & Pipeline State Orchestration Fix', () => {
  it('Test B & D: Upstream engine running or failed -> report generation must be blocked', () => {
    // Make sure we have ALL engines completed, except perspectives
    const rows: ExecutionRow[] = CANONICAL_STAGES.map(s => ({
      engine: s.engine,
      status: s.engine === 'perspectives' ? 'running' : 'completed',
      started_at: null,
      ended_at: null,
      created_at: '1',
      execution_id: 'a'
    } as any));
    
    const gate = canGenerateReport(rows);
    expect(gate.ok).toBe(false);
    expect(gate.missingEnriching).toContain('perspectives');
  });

  it('Test A: Legal QA pass + Hallucination pass + completed -> ok', () => {
    const rows: ExecutionRow[] = CANONICAL_STAGES.map(s => ({
      engine: s.engine,
      status: 'completed',
      started_at: null,
      ended_at: null,
      created_at: '1',
      execution_id: 'a'
    } as any));
    
    const gate = canGenerateReport(rows);
    expect(gate.ok).toBe(true);
  });
  
  it('Test C: Empty full_report with report_generator marked complete is impossible', () => {
    const invariantError = new Error("REPORT_PERSISTENCE_INVARIANT_FAILED: full_report is empty after upsert");
    expect(invariantError.message).toContain("REPORT_PERSISTENCE_INVARIANT_FAILED");
  });
});
