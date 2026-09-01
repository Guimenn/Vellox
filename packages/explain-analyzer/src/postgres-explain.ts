export interface PostgresPlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Alias'?: string;
  'Startup Cost'?: number;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Plan Width'?: number;
  'Actual Startup Time'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Shared Dirtied Blocks'?: number;
  'Shared Written Blocks'?: number;
  'Filter'?: string;
  'Rows Removed by Filter'?: number;
  'Sort Method'?: string;
  'Sort Space Used'?: number;
  'Sort Space Type'?: string; // e.g. "Disk" or "Memory"
  'Plans'?: PostgresPlanNode[];
}

export interface PostgresExplainResult {
  Plan: PostgresPlanNode;
  'Planning Time'?: number;
  'Execution Time'?: number;
}

export interface ExplainBottleneck {
  nodeType: string;
  relation?: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  title: string;
  impactMs: number;
  explanation: string;
  suggestedAction: string;
}

export interface ExplainReport {
  executionTimeMs: number;
  planningTimeMs: number;
  totalSharedHitBlocks: number;
  totalSharedReadBlocks: number;
  cacheHitRatioPercent: number;
  bottlenecks: ExplainBottleneck[];
}

export class PostgresExplainAnalyzer {
  public static analyze(explainJson: PostgresExplainResult | PostgresExplainResult[] | string): ExplainReport {
    let parsed: PostgresExplainResult;

    if (typeof explainJson === 'string') {
      try {
        const raw = JSON.parse(explainJson);
        parsed = Array.isArray(raw) ? raw[0] : raw;
      } catch (err: any) {
        throw new Error(`Failed to parse PostgreSQL EXPLAIN JSON: ${err.message}`);
      }
    } else {
      parsed = Array.isArray(explainJson) ? explainJson[0]! : explainJson;
    }

    if (!parsed || !parsed.Plan) {
      throw new Error('Invalid EXPLAIN JSON: missing root "Plan" node.');
    }

    const executionTimeMs = parsed['Execution Time'] || parsed.Plan['Actual Total Time'] || 0;
    const planningTimeMs = parsed['Planning Time'] || 0;

    let totalHit = 0;
    let totalRead = 0;
    const bottlenecks: ExplainBottleneck[] = [];

    const traverse = (node: PostgresPlanNode) => {
      const hit = node['Shared Hit Blocks'] || 0;
      const read = node['Shared Read Blocks'] || 0;
      totalHit += hit;
      totalRead += read;

      const nodeType = node['Node Type'];
      const timeMs = (node['Actual Total Time'] || 0) * (node['Actual Loops'] || 1);
      const relation = node['Relation Name'];

      // 1. Check for Sequential Scan Bottlenecks
      if (nodeType === 'Seq Scan') {
        const rowsScanned = node['Actual Rows'] || node['Plan Rows'] || 0;
        const rowsRemoved = node['Rows Removed by Filter'] || 0;

        if (rowsScanned > 1000 || rowsRemoved > 500 || timeMs > 5.0) {
          bottlenecks.push({
            nodeType,
            relation,
            severity: timeMs > 50 || rowsScanned > 50000 ? 'CRITICAL' : 'HIGH',
            title: `Sequential Scan on ${relation || 'relation'}`,
            impactMs: Number(timeMs.toFixed(2)),
            explanation: `Sequential scan read ${rowsScanned} rows and discarded ${rowsRemoved} rows using filter: ${node.Filter || 'None'}.`,
            suggestedAction: node.Filter
              ? `CREATE INDEX CONCURRENTLY idx_${relation || 'table'}_filter ON ${relation || 'table'} (...filter_cols...);`
              : `Review query filters to avoid full table scan on '${relation}'.`
          });
        }
      }

      // 2. Check for Disk Spill during Sort or Hash
      if (node['Sort Space Type'] === 'Disk' || (node['Sort Method'] && node['Sort Method'].includes('Disk'))) {
        bottlenecks.push({
          nodeType,
          relation,
          severity: 'HIGH',
          title: `Sort Operation Spilled to Disk`,
          impactMs: Number(timeMs.toFixed(2)),
          explanation: `Sort operation exceeded work_mem (${node['Sort Space Used'] || 0} KB on Disk), causing high disk I/O latency.`,
          suggestedAction: `Increase PostgreSQL 'work_mem' for this transaction/query or add an index matching ORDER BY to avoid in-memory sorting.`
        });
      }

      // 3. Stale Statistics Check (Actual vs Estimated discrepancy)
      const planRows = node['Plan Rows'] || 1;
      const actualRows = node['Actual Rows'] || 1;
      const ratio = actualRows / planRows;
      if (actualRows > 100 && (ratio > 10 || ratio < 0.1)) {
        bottlenecks.push({
          nodeType,
          relation,
          severity: 'MEDIUM',
          title: `Stale Table Statistics on ${relation || 'node'} (Estimation Drift)`,
          impactMs: Number(timeMs.toFixed(2)),
          explanation: `Planner estimated ${planRows} rows but actually received ${actualRows} rows (${ratio.toFixed(1)}x drift).`,
          suggestedAction: `Run 'ANALYZE ${relation || 'table'};' to refresh optimizer statistics.`
        });
      }

      // Traverse children
      if (node.Plans && Array.isArray(node.Plans)) {
        for (const child of node.Plans) {
          traverse(child);
        }
      }
    };

    traverse(parsed.Plan);

    const totalBlocks = totalHit + totalRead;
    const cacheHitRatioPercent =
      totalBlocks > 0 ? Number(((totalHit / totalBlocks) * 100).toFixed(1)) : 100.0;

    return {
      executionTimeMs: Number(executionTimeMs.toFixed(2)),
      planningTimeMs: Number(planningTimeMs.toFixed(2)),
      totalSharedHitBlocks: totalHit,
      totalSharedReadBlocks: totalRead,
      cacheHitRatioPercent,
      bottlenecks
    };
  }
}
