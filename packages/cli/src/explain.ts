import { createHash } from 'node:crypto';
import { VelloxFinding, VelloxFindingInput, VelloxReport } from './types.js';

type PlanNode = Record<string, unknown>;

function number(node: PlanNode, key: string, fallback = 0): number {
  const value = Number(node[key]);
  return Number.isFinite(value) ? value : fallback;
}

function text(node: PlanNode, key: string, fallback = ''): string {
  const value = node[key];
  return typeof value === 'string' ? value : fallback;
}

function fingerprint(input: VelloxFindingInput): string {
  const identity = [input.ruleId, input.file || '', input.evidence.trim().replace(/\s+/g, ' ')].join('|');
  return createHash('sha256').update(identity).digest('hex').slice(0, 20);
}

function finding(input: VelloxFindingInput): VelloxFinding {
  return { fingerprint: fingerprint(input), ...input };
}

function planChildren(node: PlanNode): PlanNode[] {
  return Array.isArray(node.Plans)
    ? node.Plans.filter((child): child is PlanNode => Boolean(child && typeof child === 'object'))
    : [];
}

function collectPlanNodes(root: PlanNode): PlanNode[] {
  const nodes: PlanNode[] = [];
  const visit = (node: PlanNode): void => {
    nodes.push(node);
    planChildren(node).forEach(visit);
  };
  visit(root);
  return nodes;
}

function relation(node: PlanNode): string {
  const name = text(node, 'Relation Name', 'unknown relation');
  const alias = text(node, 'Alias');
  return alias && alias !== name ? `${name} (${alias})` : name;
}

function compact(value: string, limit = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function nodeRuntime(node: PlanNode): { loops: number; rows: number; removed: number; timeMs: number } {
  const loops = Math.max(1, number(node, 'Actual Loops', 1));
  return {
    loops,
    rows: number(node, 'Actual Rows') * loops,
    removed: number(node, 'Rows Removed by Filter') * loops,
    timeMs: number(node, 'Actual Total Time') * loops
  };
}

function rootBuffers(root: PlanNode, nodes: PlanNode[]): { hit: number; read: number } {
  const rootHit = number(root, 'Shared Hit Blocks');
  const rootRead = number(root, 'Shared Read Blocks');
  if (rootHit + rootRead > 0) return { hit: rootHit, read: rootRead };
  return nodes.filter(node => planChildren(node).length === 0).reduce<{ hit: number; read: number }>((total, node) => ({
    hit: total.hit + number(node, 'Shared Hit Blocks'),
    read: total.read + number(node, 'Shared Read Blocks')
  }), { hit: 0, read: 0 });
}

function explainFinding(input: Omit<VelloxFindingInput, 'file'>, target: string): VelloxFinding {
  return finding({ ...input, file: target, confidence: input.confidence || 'HIGH' });
}

export function analyzePostgresExplain(document: unknown, target: string, version: string): VelloxReport {
  const envelope = Array.isArray(document) ? document[0] : document;
  if (!envelope || typeof envelope !== 'object') throw new Error('Invalid EXPLAIN JSON: expected an object or a non-empty array.');
  const record = envelope as PlanNode;
  const planValue = record.Plan || record;
  if (!planValue || typeof planValue !== 'object' || Array.isArray(planValue)) {
    throw new Error('Invalid EXPLAIN JSON: root Plan is missing.');
  }
  const root = planValue as PlanNode;
  if (!text(root, 'Node Type')) throw new Error('Invalid EXPLAIN JSON: Plan has no Node Type.');

  const nodes = collectPlanNodes(root);
  const findings: VelloxFinding[] = [];

  for (const node of nodes) {
    const nodeType = text(node, 'Node Type', 'Unknown');
    const runtime = nodeRuntime(node);
    const examined = runtime.rows + runtime.removed;
    const filter = text(node, 'Filter');

    if (nodeType === 'Seq Scan') {
      const selectiveWaste = Boolean(filter) && examined >= 10_000 && runtime.removed >= 5_000
        && runtime.removed / Math.max(1, examined) >= 0.5;
      const expensiveFullScan = examined >= 100_000 && runtime.timeMs >= 100;
      if (selectiveWaste || expensiveFullScan) {
        findings.push(explainFinding({
          ruleId: 'explain/expensive-sequential-scan', severity: runtime.timeMs >= 500 ? 'HIGH' : 'MEDIUM', confidence: 'MEDIUM', category: 'database',
          title: 'Sequential scan processes a large relation',
          evidence: `Seq Scan on ${relation(node)} examined ${examined.toLocaleString('en-US')} row(s), removed ${runtime.removed.toLocaleString('en-US')} by filter, and took ${runtime.timeMs.toFixed(2)} ms${filter ? `; filter: ${compact(filter)}` : ''}.`,
          recommendation: filter
            ? 'Check the filter selectivity and existing composite indexes, then compare EXPLAIN (ANALYZE, BUFFERS) before and after any index change.'
            : 'Confirm that a full-table read is required; reduce the selected working set or partition only when measurements justify it.'
        }, target));
      }
    }

    const diskSort = text(node, 'Sort Space Type').toLowerCase() === 'disk'
      || /external|disk/i.test(text(node, 'Sort Method'))
      || number(node, 'Temp Read Blocks') + number(node, 'Temp Written Blocks') > 0 && /sort|aggregate|hash/i.test(nodeType);
    if (diskSort) {
      const spaceKb = number(node, 'Sort Space Used');
      const tempBlocks = number(node, 'Temp Read Blocks') + number(node, 'Temp Written Blocks');
      findings.push(explainFinding({
        ruleId: 'explain/disk-spill', severity: 'HIGH', category: 'database',
        title: 'Execution node spilled temporary data to disk',
        evidence: `${nodeType} used disk-backed temporary work${spaceKb ? ` (${spaceKb.toLocaleString('en-US')} kB)` : ''}${tempBlocks ? ` across ${tempBlocks.toLocaleString('en-US')} temp block operation(s)` : ''}.`,
        recommendation: 'Reduce rows before this node and validate supporting indexes; only tune work_mem per workload after measuring concurrency and memory headroom.'
      }, target));
    }

    const estimatedRows = number(node, 'Plan Rows');
    const actualRowsPerLoop = number(node, 'Actual Rows');
    if (estimatedRows > 0 && actualRowsPerLoop >= 100) {
      const ratio = actualRowsPerLoop / estimatedRows;
      if (ratio >= 10 || ratio <= 0.1) {
        findings.push(explainFinding({
          ruleId: 'explain/cardinality-misestimation', severity: ratio >= 100 || ratio <= 0.01 ? 'HIGH' : 'MEDIUM', confidence: 'MEDIUM', category: 'database',
          title: 'Planner row estimate diverges from execution',
          evidence: `${nodeType}${text(node, 'Relation Name') ? ` on ${relation(node)}` : ''} estimated ${estimatedRows.toLocaleString('en-US')} row(s) but produced ${actualRowsPerLoop.toLocaleString('en-US')} per loop (${ratio.toFixed(2)}x).`,
          recommendation: 'Refresh statistics and inspect correlated predicates or data skew; consider higher statistics targets or extended statistics only for the demonstrated columns.'
        }, target));
      }
    }

    if (nodeType === 'Nested Loop') {
      const childLoops = Math.max(0, ...planChildren(node).map(child => number(child, 'Actual Loops')));
      if (childLoops >= 1_000 && runtime.timeMs >= 10) {
        findings.push(explainFinding({
          ruleId: 'explain/nested-loop-amplification', severity: runtime.timeMs >= 500 ? 'HIGH' : 'MEDIUM', confidence: 'MEDIUM', category: 'database',
          title: 'Nested loop amplifies work across many executions',
          evidence: `Nested Loop ran a child node ${childLoops.toLocaleString('en-US')} time(s) and consumed ${runtime.timeMs.toFixed(2)} ms.`,
          recommendation: 'Inspect the join predicate, row estimates, and inner-side index. Compare alternative plans after fixing statistics or indexing; do not disable nested loops globally.'
        }, target));
      }
    }
  }

  const buffers = rootBuffers(root, nodes);
  const bufferTotal = buffers.hit + buffers.read;
  const hitRatio = bufferTotal ? buffers.hit / bufferTotal * 100 : 100;
  if (bufferTotal >= 1_000 && hitRatio < 90) {
    findings.push(explainFinding({
      ruleId: 'explain/low-buffer-hit-ratio', severity: hitRatio < 50 ? 'HIGH' : 'MEDIUM', confidence: 'MEDIUM', category: 'database',
      title: 'Plan reads a large share of buffers from storage',
      evidence: `Shared buffer hit ratio was ${hitRatio.toFixed(1)}% across ${bufferTotal.toLocaleString('en-US')} block(s) (${buffers.hit.toLocaleString('en-US')} hit, ${buffers.read.toLocaleString('en-US')} read).`,
      recommendation: 'Correlate this cold-read evidence with repeated production executions; reduce touched data before changing cache or memory settings.'
    }, target));
  }

  const count = (severity: VelloxFinding['severity']): number => findings.filter(item => item.severity === severity).length;
  return {
    schemaVersion: '1.0', tool: { name: 'vellox', version }, generatedAt: new Date().toISOString(), target,
    databaseContext: { detected: true, evidence: ['PostgreSQL EXPLAIN (FORMAT JSON)'] },
    summary: {
      filesScanned: 1, findings: findings.length,
      critical: count('CRITICAL'), high: count('HIGH'), medium: count('MEDIUM'), low: count('LOW'),
      secrets: 0, infrastructure: 0, reviewableSqlFixes: 0
    },
    metrics: {
      planNodes: nodes.length,
      planningTimeMs: number(record, 'Planning Time'),
      executionTimeMs: number(record, 'Execution Time', number(root, 'Actual Total Time')),
      sequentialScans: nodes.filter(node => text(node, 'Node Type') === 'Seq Scan').length,
      diskSpills: nodes.filter(node => text(node, 'Sort Space Type').toLowerCase() === 'disk' || /external|disk/i.test(text(node, 'Sort Method'))).length,
      sharedHitBlocks: buffers.hit,
      sharedReadBlocks: buffers.read,
      bufferHitRatioPercent: Number(hitRatio.toFixed(2))
    },
    findings
  };
}
