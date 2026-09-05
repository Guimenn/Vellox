import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzePostgresExplain } from './explain.js';
import { VelloxReport } from './types.js';

export type ProofVerdict = 'improved' | 'regressed' | 'stable';
export type ProofMetricStatus = 'improved' | 'regressed' | 'stable' | 'context';
export type ProofEvidenceQuality = 'single-run' | 'limited-samples' | 'repeated-runs';

export interface ProofMetrics {
  executionTimeMs: number;
  planningTimeMs: number;
  sharedReadBlocks: number;
  sharedHitBlocks: number;
  bufferHitRatioPercent: number;
  planNodeExecutions: number;
  diskSpills: number;
  sequentialScans: number;
  planNodes: number;
}

export interface ProofRun {
  source: string;
  metrics: ProofMetrics;
  findingRules: string[];
}

export interface ProofSnapshot {
  source: string;
  samples: number;
  median: ProofMetrics;
  findingRules: string[];
  runs: ProofRun[];
}

export interface ProofMetricComparison {
  before: number;
  after: number;
  delta: number;
  deltaPercent: number | null;
  status: ProofMetricStatus;
}

export interface VelloxProofReport {
  schemaVersion: '1.0';
  tool: { name: 'vellox'; version: string };
  generatedAt: string;
  thresholdPercent: number;
  evidenceQuality: ProofEvidenceQuality;
  verdict: ProofVerdict;
  before: ProofSnapshot;
  after: ProofSnapshot;
  comparison: Record<keyof ProofMetrics, ProofMetricComparison>;
  resolvedFindingRules: string[];
  introducedFindingRules: string[];
  warnings: string[];
}

type MetricPreference = 'lower' | 'higher' | 'context';

const METRIC_PREFERENCES: Record<keyof ProofMetrics, MetricPreference> = {
  executionTimeMs: 'lower',
  planningTimeMs: 'context',
  sharedReadBlocks: 'lower',
  sharedHitBlocks: 'context',
  bufferHitRatioPercent: 'higher',
  planNodeExecutions: 'context',
  diskSpills: 'lower',
  sequentialScans: 'context',
  planNodes: 'context'
};

const METRIC_LABELS: Record<keyof ProofMetrics, string> = {
  executionTimeMs: 'Execution time',
  planningTimeMs: 'Planning time',
  sharedReadBlocks: 'Shared reads',
  sharedHitBlocks: 'Shared hits',
  bufferHitRatioPercent: 'Buffer hit ratio',
  planNodeExecutions: 'Node executions',
  diskSpills: 'Disk spills',
  sequentialScans: 'Sequential scans',
  planNodes: 'Plan nodes'
};

const METRIC_KEYS = Object.keys(METRIC_PREFERENCES) as Array<keyof ProofMetrics>;

function round(value: number, precision = 4): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function metric(report: VelloxReport, name: keyof ProofMetrics): number {
  const value = report.metrics?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isExplainReport(value: unknown): value is VelloxReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<VelloxReport>;
  return report.schemaVersion === '1.0'
    && report.tool?.name === 'vellox'
    && Boolean(report.metrics)
    && Array.isArray(report.findings)
    && Boolean(report.databaseContext?.evidence?.some(item => item.includes('PostgreSQL EXPLAIN')));
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Could not read measured plan ${file}: ${(error as Error).message}`);
  }
}

function measuredPlanFiles(source: string): string[] {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) throw new Error(`Measured plan source does not exist: ${resolved}`);
  if (fs.statSync(resolved).isFile()) return [resolved];
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Measured plan source must be a JSON file or directory: ${resolved}`);
  const files = fs.readdirSync(resolved, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map(entry => path.join(resolved, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (!files.length) throw new Error(`Measured plan directory contains no JSON files: ${resolved}`);
  return files;
}

function readRun(file: string, version: string): ProofRun {
  const document = readJson(file);
  const report = isExplainReport(document)
    ? document
    : analyzePostgresExplain(document, path.basename(file), version);
  const metrics = Object.fromEntries(METRIC_KEYS.map(name => [name, metric(report, name)])) as unknown as ProofMetrics;
  if (metrics.executionTimeMs <= 0) {
    throw new Error(`Measured execution time is missing from ${file}. Use EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON).`);
  }
  return {
    source: file,
    metrics,
    findingRules: [...new Set(report.findings.map(finding => finding.ruleId))].sort()
  };
}

function snapshot(source: string, version: string): ProofSnapshot {
  const runs = measuredPlanFiles(source).map(file => readRun(file, version));
  const aggregate = Object.fromEntries(METRIC_KEYS.map(name => [
    name,
    round(median(runs.map(run => run.metrics[name])))
  ])) as unknown as ProofMetrics;
  return {
    source: path.resolve(source),
    samples: runs.length,
    median: aggregate,
    findingRules: [...new Set(runs.flatMap(run => run.findingRules))].sort(),
    runs
  };
}

function compareMetric(before: number, after: number, preference: MetricPreference, thresholdPercent: number): ProofMetricComparison {
  const delta = round(after - before);
  const deltaPercent = before === 0 ? null : round(delta / before * 100);
  let status: ProofMetricStatus = 'context';
  if (preference !== 'context') {
    const meaningful = deltaPercent === null ? delta !== 0 : Math.abs(deltaPercent) >= thresholdPercent;
    if (!meaningful) status = 'stable';
    else if (preference === 'lower') status = delta < 0 ? 'improved' : delta > 0 ? 'regressed' : 'stable';
    else status = delta > 0 ? 'improved' : delta < 0 ? 'regressed' : 'stable';
  }
  return { before, after, delta, deltaPercent, status };
}

function evidenceQuality(before: number, after: number): ProofEvidenceQuality {
  const minimum = Math.min(before, after);
  if (minimum === 1) return 'single-run';
  if (minimum === 2) return 'limited-samples';
  return 'repeated-runs';
}

export function buildProofReport(
  beforeSource: string,
  afterSource: string,
  version: string,
  thresholdPercent = 5
): VelloxProofReport {
  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0) {
    throw new Error('Proof threshold must be a non-negative number.');
  }
  const before = snapshot(beforeSource, version);
  const after = snapshot(afterSource, version);
  const comparison = Object.fromEntries(METRIC_KEYS.map(name => [
    name,
    compareMetric(before.median[name], after.median[name], METRIC_PREFERENCES[name], thresholdPercent)
  ])) as unknown as Record<keyof ProofMetrics, ProofMetricComparison>;
  const primary = comparison.executionTimeMs.status;
  const verdict: ProofVerdict = primary === 'improved' ? 'improved' : primary === 'regressed' ? 'regressed' : 'stable';
  const quality = evidenceQuality(before.samples, after.samples);
  const warnings = [
    'Vellox compares recorded plans but cannot verify that SQL, data, cache state, hardware, and concurrent load were equivalent.'
  ];
  if (quality !== 'repeated-runs') {
    warnings.push(`Only ${before.samples} before and ${after.samples} after sample(s) were provided; use at least 3 measured runs per side and compare medians.`);
  }
  if (before.samples !== after.samples) {
    warnings.push(`Sample counts differ (${before.samples} before, ${after.samples} after); matching counts produce a stronger comparison.`);
  }
  const beforeRules = new Set(before.findingRules);
  const afterRules = new Set(after.findingRules);
  return {
    schemaVersion: '1.0',
    tool: { name: 'vellox', version },
    generatedAt: new Date().toISOString(),
    thresholdPercent,
    evidenceQuality: quality,
    verdict,
    before,
    after,
    comparison,
    resolvedFindingRules: before.findingRules.filter(rule => !afterRules.has(rule)),
    introducedFindingRules: after.findingRules.filter(rule => !beforeRules.has(rule)),
    warnings
  };
}

function metricValue(name: keyof ProofMetrics, value: number): string {
  if (name === 'executionTimeMs' || name === 'planningTimeMs') return `${value.toFixed(2)} ms`;
  if (name === 'bufferHitRatioPercent') return `${value.toFixed(2)}%`;
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2);
}

function deltaValue(comparison: ProofMetricComparison): string {
  if (comparison.deltaPercent === null) return comparison.delta === 0 ? '0' : `${comparison.delta > 0 ? '+' : ''}${comparison.delta}`;
  return `${comparison.deltaPercent > 0 ? '+' : ''}${comparison.deltaPercent.toFixed(2)}%`;
}

function verdictLabel(verdict: ProofVerdict): string {
  if (verdict === 'improved') return 'OBSERVED IMPROVEMENT';
  if (verdict === 'regressed') return 'OBSERVED REGRESSION';
  return 'STABLE WITHIN THRESHOLD';
}

export function formatProofPretty(report: VelloxProofReport): string {
  const lines = [
    'VELLOX / MEASURED PERFORMANCE COMPARISON',
    '',
    `Before          ${report.before.source} (${report.before.samples} sample${report.before.samples === 1 ? '' : 's'})`,
    `After           ${report.after.source} (${report.after.samples} sample${report.after.samples === 1 ? '' : 's'})`,
    `Evidence        ${report.evidenceQuality}`,
    `Threshold       ${report.thresholdPercent}%`,
    '',
    `VERDICT         ${verdictLabel(report.verdict)}`,
    '',
    'METRIC                    BEFORE          AFTER           DELTA       STATUS'
  ];
  for (const name of METRIC_KEYS) {
    const item = report.comparison[name];
    lines.push(
      `${METRIC_LABELS[name].padEnd(25)} ${metricValue(name, item.before).padEnd(15)} ${metricValue(name, item.after).padEnd(15)} ${deltaValue(item).padEnd(11)} ${item.status.toUpperCase()}`
    );
  }
  lines.push('', 'PLAN FINDINGS');
  lines.push(`Resolved        ${report.resolvedFindingRules.join(', ') || 'none'}`);
  lines.push(`Introduced      ${report.introducedFindingRules.join(', ') || 'none'}`);
  lines.push('', 'LIMITS');
  report.warnings.forEach(warning => lines.push(`- ${warning}`));
  return lines.join('\n');
}

export function formatProofMarkdown(report: VelloxProofReport): string {
  const rows = METRIC_KEYS.map(name => {
    const item = report.comparison[name];
    return `| ${METRIC_LABELS[name]} | ${metricValue(name, item.before)} | ${metricValue(name, item.after)} | ${deltaValue(item)} | ${item.status} |`;
  });
  return `# Vellox measured performance comparison

**Verdict:** ${verdictLabel(report.verdict)}  
**Evidence quality:** ${report.evidenceQuality}  
**Meaningful-change threshold:** ${report.thresholdPercent}%  
**Before:** \`${report.before.source}\` (${report.before.samples} sample${report.before.samples === 1 ? '' : 's'})  
**After:** \`${report.after.source}\` (${report.after.samples} sample${report.after.samples === 1 ? '' : 's'})

| Metric | Before median | After median | Delta | Status |
| --- | ---: | ---: | ---: | --- |
${rows.join('\n')}

## Plan findings

- Resolved: ${report.resolvedFindingRules.map(rule => `\`${rule}\``).join(', ') || 'none'}
- Introduced: ${report.introducedFindingRules.map(rule => `\`${rule}\``).join(', ') || 'none'}

## Measurement limits

${report.warnings.map(warning => `- ${warning}`).join('\n')}
`;
}
