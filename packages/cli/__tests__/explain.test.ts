import { describe, expect, it } from 'vitest';
import { analyzePostgresExplain } from '../src/explain.js';
import { toSarif } from '../src/formatters.js';

describe('PostgreSQL EXPLAIN analysis', () => {
  it('keeps a small sequential scan as measured context instead of an automatic problem', () => {
    const report = analyzePostgresExplain({
      Plan: {
        'Node Type': 'Seq Scan', 'Relation Name': 'settings',
        'Plan Rows': 20, 'Actual Rows': 18, 'Actual Loops': 1,
        'Actual Total Time': 0.08, 'Shared Hit Blocks': 2
      },
      'Planning Time': 0.12, 'Execution Time': 0.18
    }, 'small.json', 'test');

    expect(report.findings).toHaveLength(0);
    expect(report.metrics).toMatchObject({ planNodes: 1, sequentialScans: 1, executionTimeMs: 0.18 });
  });

  it('turns expensive execution evidence into focused findings', () => {
    const report = analyzePostgresExplain({
      Plan: {
        'Node Type': 'Nested Loop', 'Plan Rows': 10, 'Actual Rows': 2_000,
        'Actual Loops': 1, 'Actual Total Time': 640,
        'Shared Hit Blocks': 100, 'Shared Read Blocks': 1_900,
        Plans: [
          {
            'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Alias': 'o',
            Filter: '(status = \'pending\')', 'Plan Rows': 100, 'Actual Rows': 1_000,
            'Rows Removed by Filter': 19_000, 'Actual Loops': 1, 'Actual Total Time': 510
          },
          {
            'Node Type': 'Sort', 'Plan Rows': 2_000, 'Actual Rows': 2_000,
            'Actual Loops': 2_000, 'Actual Total Time': 0.05,
            'Sort Method': 'external merge', 'Sort Space Type': 'Disk', 'Sort Space Used': 45_000
          }
        ]
      },
      'Planning Time': 2.4, 'Execution Time': 650
    }, 'slow-plan.json', 'test');
    const rules = report.findings.map(item => item.ruleId);

    expect(rules).toEqual(expect.arrayContaining([
      'explain/expensive-sequential-scan',
      'explain/disk-spill',
      'explain/cardinality-misestimation',
      'explain/nested-loop-amplification',
      'explain/low-buffer-hit-ratio'
    ]));
    expect(report.metrics).toMatchObject({ planNodes: 3, diskSpills: 1, bufferHitRatioPercent: 5 });
    expect(JSON.stringify(toSarif(report))).toContain('explain/disk-spill');
  });

  it('rejects documents that are not PostgreSQL plans', () => {
    expect(() => analyzePostgresExplain({}, 'invalid.json', 'test')).toThrow('Node Type');
    expect(() => analyzePostgresExplain([], 'invalid.json', 'test')).toThrow('non-empty array');
  });
});
