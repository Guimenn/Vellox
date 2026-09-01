import { describe, it, expect } from 'vitest';
import { PostgresExplainAnalyzer } from '../src/postgres-explain.js';

describe('PostgresExplainAnalyzer', () => {
  const sampleExplain = {
    Plan: {
      'Node Type': 'Seq Scan',
      'Relation Name': 'users',
      'Alias': 'users',
      'Startup Cost': 0.0,
      'Total Cost': 1420.0,
      'Plan Rows': 50,
      'Actual Total Time': 42.5,
      'Actual Rows': 12000, // Stale statistics (12000 vs 50)
      'Actual Loops': 1,
      'Shared Hit Blocks': 800,
      'Shared Read Blocks': 200,
      'Filter': '(age > 30)'
    },
    'Planning Time': 0.85,
    'Execution Time': 43.35
  };

  it('should parse summary metrics (execution time, cache hit ratio)', () => {
    const report = PostgresExplainAnalyzer.analyze(sampleExplain);
    expect(report.executionTimeMs).toBe(43.35);
    expect(report.planningTimeMs).toBe(0.85);
    expect(report.totalSharedHitBlocks).toBe(800);
    expect(report.totalSharedReadBlocks).toBe(200);
    expect(report.cacheHitRatioPercent).toBe(80.0); // 800 / 1000
  });

  it('should detect Seq Scan and Stale Statistics bottlenecks', () => {
    const report = PostgresExplainAnalyzer.analyze(sampleExplain);
    expect(report.bottlenecks.length).toBeGreaterThanOrEqual(2);

    const seqScan = report.bottlenecks.find((b) => b.nodeType === 'Seq Scan');
    expect(seqScan).toBeDefined();
    expect(seqScan?.relation).toBe('users');
    expect(seqScan?.suggestedAction).toContain('CREATE INDEX CONCURRENTLY');

    const staleStats = report.bottlenecks.find((b) => b.title.includes('Stale Table Statistics'));
    expect(staleStats).toBeDefined();
    expect(staleStats?.suggestedAction).toContain('ANALYZE users');
  });

  it('should detect disk spill during external sort', () => {
    const diskSortExplain = {
      Plan: {
        'Node Type': 'Sort',
        'Sort Method': 'external merge  Disk',
        'Sort Space Used': 45000,
        'Sort Space Type': 'Disk',
        'Actual Total Time': 120.0,
        'Actual Rows': 50000,
        'Plan Rows': 50000,
        'Shared Hit Blocks': 5000,
        'Shared Read Blocks': 0
      },
      'Execution Time': 121.0
    };

    const report = PostgresExplainAnalyzer.analyze(diskSortExplain);
    const diskBottleneck = report.bottlenecks.find((b) => b.title.includes('Spilled to Disk'));
    expect(diskBottleneck).toBeDefined();
    expect(diskBottleneck?.severity).toBe('HIGH');
    expect(diskBottleneck?.suggestedAction).toContain('work_mem');
  });
});
