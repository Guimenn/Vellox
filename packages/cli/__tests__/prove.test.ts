import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProofReport, formatProofMarkdown, formatProofPretty } from '../src/prove.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `vellox-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function measuredPlan(executionTimeMs: number, sharedReadBlocks: number, diskSpill = false): Record<string, unknown> {
  return {
    Plan: {
      'Node Type': diskSpill ? 'Sort' : 'Index Scan',
      'Relation Name': 'orders',
      'Plan Rows': 1_000,
      'Actual Rows': 1_000,
      'Actual Loops': 1,
      'Actual Total Time': executionTimeMs - 1,
      'Shared Hit Blocks': 10_000 - sharedReadBlocks,
      'Shared Read Blocks': sharedReadBlocks,
      ...(diskSpill ? {
        'Sort Method': 'external merge',
        'Sort Space Type': 'Disk',
        'Sort Space Used': 8_192
      } : {})
    },
    'Planning Time': 1,
    'Execution Time': executionTimeMs
  };
}

function writePlans(directory: string, values: number[], reads: number[], diskSpill = false): void {
  values.forEach((value, index) => {
    fs.writeFileSync(
      path.join(directory, `${String(index + 1).padStart(2, '0')}.json`),
      JSON.stringify(measuredPlan(value, reads[index]!, diskSpill))
    );
  });
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('measured before/after proof', () => {
  it('compares repeated EXPLAIN runs by median and records resolved plan risks', () => {
    const before = temporaryDirectory('proof-before');
    const after = temporaryDirectory('proof-after');
    writePlans(before, [520, 500, 480], [8_200, 8_000, 7_800], true);
    writePlans(after, [110, 100, 90], [1_200, 1_000, 800]);

    const report = buildProofReport(before, after, 'test');

    expect(report).toMatchObject({
      verdict: 'improved',
      evidenceQuality: 'repeated-runs',
      thresholdPercent: 5,
      before: { samples: 3, median: { executionTimeMs: 500, sharedReadBlocks: 8_000, diskSpills: 1 } },
      after: { samples: 3, median: { executionTimeMs: 100, sharedReadBlocks: 1_000, diskSpills: 0 } }
    });
    expect(report.comparison.executionTimeMs).toMatchObject({ delta: -400, deltaPercent: -80, status: 'improved' });
    expect(report.resolvedFindingRules).toContain('explain/disk-spill');
    expect(report.introducedFindingRules).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(formatProofPretty(report)).toContain('OBSERVED IMPROVEMENT');
    expect(formatProofMarkdown(report)).toContain('| Execution time | 500.00 ms | 100.00 ms | -80.00% | improved |');
  });

  it('labels single-run evidence and treats small timing movement as stable', () => {
    const directory = temporaryDirectory('proof-single');
    const before = path.join(directory, 'before.json');
    const after = path.join(directory, 'after.json');
    fs.writeFileSync(before, JSON.stringify(measuredPlan(100, 500)));
    fs.writeFileSync(after, JSON.stringify(measuredPlan(97, 490)));

    const report = buildProofReport(before, after, 'test', 5);

    expect(report.verdict).toBe('stable');
    expect(report.evidenceQuality).toBe('single-run');
    expect(report.comparison.executionTimeMs).toMatchObject({ deltaPercent: -3, status: 'stable' });
    expect(report.warnings.join(' ')).toContain('at least 3 measured runs');
  });

  it('accepts analyzed Vellox explain reports and identifies measured regressions', () => {
    const directory = temporaryDirectory('proof-report');
    const before = path.join(directory, 'before.json');
    const after = path.join(directory, 'after.json');
    const reportDocument = (executionTimeMs: number) => ({
      schemaVersion: '1.0',
      tool: { name: 'vellox', version: 'test' },
      generatedAt: new Date(0).toISOString(),
      target: 'plan.json',
      databaseContext: { detected: true, evidence: ['PostgreSQL EXPLAIN (FORMAT JSON)'] },
      summary: { filesScanned: 1, findings: 0, critical: 0, high: 0, medium: 0, low: 0, secrets: 0, infrastructure: 0, reviewableSqlFixes: 0 },
      metrics: { executionTimeMs, planningTimeMs: 1, sharedReadBlocks: 20, sharedHitBlocks: 80, bufferHitRatioPercent: 80, planNodeExecutions: 1, diskSpills: 0, sequentialScans: 0, planNodes: 1 },
      findings: []
    });
    fs.writeFileSync(before, JSON.stringify(reportDocument(40)));
    fs.writeFileSync(after, JSON.stringify(reportDocument(80)));

    expect(buildProofReport(before, after, 'test').verdict).toBe('regressed');
  });

  it('rejects unmeasured plans instead of presenting estimates as proof', () => {
    const directory = temporaryDirectory('proof-unmeasured');
    const before = path.join(directory, 'before.json');
    const after = path.join(directory, 'after.json');
    fs.writeFileSync(before, JSON.stringify({ Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 10 } }));
    fs.writeFileSync(after, JSON.stringify(measuredPlan(10, 1)));

    expect(() => buildProofReport(before, after, 'test')).toThrow('Use EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)');
  });
});
