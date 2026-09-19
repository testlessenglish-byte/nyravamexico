import { describe, it, expect } from 'vitest';
import { canGenerateReport, REPORT_REQUIRED_ENGINES, OPTIONAL_ENGINES } from '../canonical';
import type { ExecutionRow } from '../canonical';

describe('_runReportInner preflight query and canonical state', () => {
  const row = (e: string, status: string): ExecutionRow => ({
    engine: e,
    status,
    started_at: null,
    ended_at: null,
    created_at: '1',
    execution_id: 'a',
    id: e,
  } as any);

  // Mocking the _runReportInner database behavior
  const mockDbQuery = (allDbRows: ExecutionRow[]) => {
    // 1. The exact requiredForPreflight list from pipeline.server.ts
    const requiredForPreflight = Array.from(new Set([...REPORT_REQUIRED_ENGINES, ...OPTIONAL_ENGINES]));
    
    // 2. The exact query logic
    const fetchedRows = allDbRows.filter(r => requiredForPreflight.includes(r.engine));
    
    // 3. The canonical check
    return canGenerateReport(fetchedRows);
  };

  it('Required engines = completed, Optional engines = absent => PASS', () => {
    const allDbRows = REPORT_REQUIRED_ENGINES.map(e => row(e, 'completed'));
    const gate = mockDbQuery(allDbRows);
    expect(gate.ok).toBe(true);
  });

  it('Required = completed, Optional perspectives = completed => PASS', () => {
    const allDbRows = [
      ...REPORT_REQUIRED_ENGINES.map(e => row(e, 'completed')),
      row('perspectives', 'completed')
    ];
    const gate = mockDbQuery(allDbRows);
    expect(gate.ok).toBe(true);
  });

  it('Optional = skipped => PASS', () => {
    const allDbRows = [
      ...REPORT_REQUIRED_ENGINES.map(e => row(e, 'completed')),
      row('perspectives', 'skipped')
    ];
    expect(mockDbQuery(allDbRows).ok).toBe(true);
  });

  it('Optional = running => BLOCK with engine name', () => {
    const allDbRows = [
      ...REPORT_REQUIRED_ENGINES.map(e => row(e, 'completed')),
      row('perspectives', 'running')
    ];
    const gate = mockDbQuery(allDbRows);
    expect(gate.ok).toBe(false);
    expect(gate.missingEnriching).toContain('perspectives');
  });

  it('Optional = queued => BLOCK with engine name', () => {
    const allDbRows = [
      ...REPORT_REQUIRED_ENGINES.map(e => row(e, 'completed')),
      row('perspectives', 'queued')
    ];
    const gate = mockDbQuery(allDbRows);
    expect(gate.ok).toBe(false);
    expect(gate.missingEnriching).toContain('perspectives');
  });

  it('Optional = failed => BLOCK with engine name', () => {
    const allDbRows = [
      ...REPORT_REQUIRED_ENGINES.map(e => row(e, 'completed')),
      row('perspectives', 'failed')
    ];
    const gate = mockDbQuery(allDbRows);
    expect(gate.ok).toBe(false);
    expect(gate.missingEnriching).toContain('perspectives');
  });

  it('Optional = failed -> successful (authoritative latest) => PASS', () => {
    const allDbRows = [
      ...REPORT_REQUIRED_ENGINES.map(e => row(e, 'completed')),
      { ...row('perspectives', 'failed'), created_at: '1' },
      { ...row('perspectives', 'completed'), created_at: '2' },
    ];
    const gate = mockDbQuery(allDbRows);
    expect(gate.ok).toBe(true);
  });
  
  it('Optional absent entirely => PASS', () => {
    const allDbRows = REPORT_REQUIRED_ENGINES.map(e => row(e, 'completed'));
    const gate = mockDbQuery(allDbRows);
    expect(gate.ok).toBe(true);
  });
});

