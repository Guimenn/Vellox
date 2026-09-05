import * as path from 'node:path';
import { BudgetEvaluation, VelloxBudgets, VelloxFinding, VelloxReport } from './types.js';

export function formatPretty(report: VelloxReport): string {
  const context = report.databaseContext.detected
    ? report.databaseContext.evidence.join('; ')
    : 'No database dependency or schema detected';
  const lines = [
    '⚡ VELLOX PROJECT ANALYSIS',
    '',
    `  Target:            ${report.target}`,
    `  Files inspected:   ${report.summary.filesScanned}`,
    `  Database context:  ${context}`,
    '',
    '  FINDINGS',
    `  ├─ Critical:       ${report.summary.critical}`,
    `  ├─ High:           ${report.summary.high}`,
    `  ├─ Medium:         ${report.summary.medium}`,
    `  ├─ Secrets:        ${report.summary.secrets}`,
    `  ├─ Infrastructure: ${report.summary.infrastructure ?? 0}`,
    `  └─ SQL suggestions: ${report.summary.reviewableSqlFixes}`,
    ''
  ];

  if (report.coverage) {
    lines.splice(4, 0,
      `  Files discovered:  ${report.coverage.filesDiscovered}`,
      `  Coverage:          ${report.coverage.complete ? 'complete' : `incomplete (${report.coverage.issues.length} issue(s): ${report.coverage.filesSkipped} skipped, ${report.coverage.fallbackFiles} fallback)`}`,
      `  Scope:             ${report.coverage.scope === 'changed' ? `changed since ${report.coverage.changedBase}` : 'full project'}`,
      `  Analysis cache:    ${report.coverage.cacheHit ? 'hit' : 'miss'}`,
      `  SQL query AST:     ${report.coverage.sqlAstStatements ?? 0}/${report.coverage.sqlStatements ?? 0} statement(s)`
    );
    if (report.coverage.issues.length) {
      lines.push('  ANALYSIS COVERAGE');
      for (const issue of report.coverage.issues) {
        const size = issue.sizeBytes !== undefined && issue.limitBytes !== undefined
          ? ` (${issue.sizeBytes} bytes; limit ${issue.limitBytes})`
          : '';
        lines.push(`  ├─ ${issue.file}${issue.line ? `:${issue.line}` : ''}: ${issue.reason}${issue.parser ? ` (${issue.parser})` : ''}${issue.message ? ` — ${issue.message}` : ''}${size}`);
      }
      lines.push('');
    }
  }

  if (report.metrics && Object.keys(report.metrics).length) {
    lines.push('  MEASURED PLAN METRICS');
    for (const [name, value] of Object.entries(report.metrics)) lines.push(`  ├─ ${name}: ${value}`);
    lines.push('');
  }

  if (!report.findings.length) {
    lines.push('✅ No supported high-risk patterns were detected.');
    return lines.join('\n');
  }

  for (const [index, item] of report.findings.entries()) {
    const location = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : 'inline input';
    lines.push(`${index + 1}. [${item.severity}] ${item.title}`);
    lines.push(`   Rule:      ${item.ruleId}`);
    if (item.confidence) lines.push(`   Confidence: ${item.confidence}`);
    lines.push(`   Location:  ${location}`);
    lines.push(`   Evidence:  ${item.evidence}`);
    if (typeof item.metadata?.callPath === 'string') lines.push(`   Call path: ${item.metadata.callPath}`);
    if (typeof item.metadata?.complexity === 'string') lines.push(`   Complexity: ${item.metadata.complexity}`);
    if (item.metadata?.iterationBound !== undefined) {
      lines.push(`   Iterations: ${typeof item.metadata.iterationBound === 'number' ? `at most ${item.metadata.iterationBound} (statically proven)` : item.metadata.iterationBound}`);
    }
    lines.push(`   Action:    ${item.recommendation}`);
    if (item.sql) lines.push(`   SQL:       ${item.sql}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function buildMigration(report: VelloxReport): string | null {
  const fixes = [...new Set(report.findings.map(item => item.sql).filter((sql): sql is string => Boolean(sql)))];
  if (!fixes.length) return null;
  return `-- Vellox reviewable migration\n-- Generated from ${report.summary.findings} evidence-backed finding(s) at ${report.generatedAt}\n-- Target: ${report.target}\n--\n-- IMPORTANT: Vellox does not execute this file. Validate table mappings and query plans first.\n\n${fixes.join('\n\n')}\n`;
}

export function formatMarkdown(report: VelloxReport): string {
  const rows = report.findings.map(item => {
    const location = item.file ? `\`${item.file}${item.line ? `:${item.line}` : ''}\`` : 'inline input';
    return `| ${item.severity} | ${item.confidence || '—'} | \`${item.ruleId}\` | ${item.title.replace(/\|/g, '\\|')} | ${location} |`;
  });
  const detail = report.findings.map((item, index) => `### ${index + 1}. ${item.title}\n\n- **Severity:** ${item.severity}\n- **Confidence:** ${item.confidence || 'Not assigned'}\n- **Rule:** \`${item.ruleId}\`\n- **Location:** ${item.file ? `\`${item.file}${item.line ? `:${item.line}` : ''}\`` : 'inline input'}\n- **Evidence:** ${item.evidence}${typeof item.metadata?.callPath === 'string' ? `\n- **Call path:** \`${item.metadata.callPath}\`` : ''}${typeof item.metadata?.complexity === 'string' ? `\n- **Complexity:** \`${item.metadata.complexity}\`` : ''}${item.metadata?.iterationBound !== undefined ? `\n- **Iterations:** ${typeof item.metadata.iterationBound === 'number' ? `at most ${item.metadata.iterationBound} (statically proven)` : item.metadata.iterationBound}` : ''}\n- **Recommendation:** ${item.recommendation}${item.sql ? `\n- **Reviewable SQL:**\n\n\`\`\`sql\n${item.sql}\n\`\`\`` : ''}`).join('\n\n');

  const coverage = report.coverage
    ? `\n\n## Analysis coverage\n\n| Metric | Value |\n| --- | ---: |\n| Files discovered | ${report.coverage.filesDiscovered} |\n| Files analyzed | ${report.coverage.filesAnalyzed} |\n| Files skipped | ${report.coverage.filesSkipped} |\n| Structural parser files | ${report.coverage.structuralFiles} |\n| Conservative fallback files | ${report.coverage.fallbackFiles} |\n| Semantic modules | ${report.coverage.semanticModules} |\n| SQL AST statements | ${report.coverage.sqlAstStatements ?? 0}/${report.coverage.sqlStatements ?? 0} |\n| Status | ${report.coverage.complete ? 'Complete' : 'Incomplete'} |${report.coverage.issues.length ? `\n\n### Coverage issues\n\n${report.coverage.issues.map(issue => `- \`${issue.file}${issue.line ? `:${issue.line}` : ''}\`: ${issue.reason}${issue.parser ? ` (${issue.parser})` : ''}${issue.message ? ` — ${issue.message}` : ''}${issue.sizeBytes !== undefined && issue.limitBytes !== undefined ? ` (${issue.sizeBytes} bytes; limit ${issue.limitBytes})` : ''}`).join('\n')}` : ''}`
    : '';
  return `# Vellox Engineering Report\n\nGenerated from an actual project scan on ${report.generatedAt}.\n\n## Summary\n\n| Metric | Value |\n| --- | ---: |\n| Files inspected | ${report.summary.filesScanned} |\n| Critical findings | ${report.summary.critical} |\n| High findings | ${report.summary.high} |\n| Medium findings | ${report.summary.medium} |\n| Exposed secrets | ${report.summary.secrets} |\n| Infrastructure findings | ${report.summary.infrastructure ?? 0} |\n| Reviewable SQL suggestions | ${report.summary.reviewableSqlFixes} |${coverage}\n\n> Vellox does not invent monetary savings from static analysis. Cost estimates require measured telemetry and an explicit pricing model.\n\n## Findings\n\n${rows.length ? `| Severity | Confidence | Rule | Finding | Location |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n${detail}` : 'No supported high-risk patterns were detected.'}\n`;
}

function sarifLevel(severity: VelloxFinding['severity']): 'error' | 'warning' | 'note' {
  if (severity === 'CRITICAL' || severity === 'HIGH') return 'error';
  if (severity === 'MEDIUM') return 'warning';
  return 'note';
}

export function toSarif(report: VelloxReport): Record<string, unknown> {
  const rules = [...new Map(report.findings.map(item => [item.ruleId, {
    id: item.ruleId,
    name: item.title,
    shortDescription: { text: item.title },
    help: { text: item.recommendation }
  }])).values()];
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: 'Vellox', version: report.tool.version, rules } },
      invocations: report.coverage ? [{
        executionSuccessful: report.coverage.complete,
        toolExecutionNotifications: report.coverage.issues.map(issue => ({
          level: 'warning',
          message: { text: `${issue.file}: ${issue.reason}${issue.message ? ` — ${issue.message}` : ''}` },
          locations: [{ physicalLocation: {
            artifactLocation: { uri: issue.file.replace(/\\/g, '/') },
            ...(issue.line ? { region: { startLine: issue.line } } : {})
          } }]
        }))
      }] : undefined,
      results: report.findings.map(item => ({
        ruleId: item.ruleId,
        level: sarifLevel(item.severity),
        message: { text: `${item.title}: ${item.evidence}` },
        properties: item.confidence || item.metadata ? { ...(item.metadata || {}), ...(item.confidence ? { confidence: item.confidence } : {}) } : undefined,
        partialFingerprints: { velloxFingerprint: item.fingerprint },
        locations: item.file ? [{
          physicalLocation: {
            artifactLocation: { uri: item.file.replace(/\\/g, '/') },
            region: { startLine: item.line || 1 }
          }
        }] : []
      }))
    }]
  };
}

export function evaluateBudgets(
  report: VelloxReport,
  budgets: VelloxBudgets,
  baseline?: VelloxReport
): BudgetEvaluation {
  const baselineRule = (ruleId: string): string => {
    if (ruleId === 'code/query-in-loop' || ruleId === 'code/sequential-async-loop') return 'code/loop-async-work';
    return ruleId;
  };
  const semanticIdentity = (item: VelloxFinding): string => [
    baselineRule(item.ruleId),
    item.file || '',
    item.evidence.trim().replace(/\s+/g, ' ')
  ].join('|');
  const increment = (counts: Map<string, number>, key: string): void => {
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  const decrement = (counts: Map<string, number>, key: string): boolean => {
    const count = counts.get(key) || 0;
    if (!count) return false;
    if (count === 1) counts.delete(key);
    else counts.set(key, count - 1);
    return true;
  };
  const baselineFingerprints = new Map<string, number>();
  const baselineIdentities = new Map<string, number>();
  for (const item of baseline?.findings || []) {
    increment(baselineFingerprints, item.fingerprint);
    increment(baselineIdentities, semanticIdentity(item));
  }
  const evaluated = report.findings.filter(item => {
    const identity = semanticIdentity(item);
    if (decrement(baselineFingerprints, item.fingerprint)) {
      decrement(baselineIdentities, identity);
      return false;
    }
    return !decrement(baselineIdentities, identity);
  });
  const critical = evaluated.filter(item => item.severity === 'CRITICAL').length;
  const high = evaluated.filter(item => item.severity === 'HIGH').length;
  const secrets = evaluated.filter(item => item.ruleId.startsWith('secret/')).length;
  const violations: string[] = [];
  if (critical > budgets.maxCritical) violations.push(`${critical} critical finding(s) exceed maxCritical=${budgets.maxCritical}`);
  if (high > budgets.maxHigh) violations.push(`${high} high finding(s) exceed maxHigh=${budgets.maxHigh}`);
  if (budgets.maxTotal !== null && evaluated.length > budgets.maxTotal) violations.push(`${evaluated.length} finding(s) exceed maxTotal=${budgets.maxTotal}`);
  if (budgets.failOnSecrets && secrets > 0) violations.push(`${secrets} exposed secret(s) violate failOnSecrets=true`);
  if (budgets.failOnIncompleteAnalysis && report.coverage && !report.coverage.complete) {
    violations.push(`${report.coverage.issues.length} analysis coverage issue(s) violate failOnIncompleteAnalysis=true`);
  }
  return { passed: violations.length === 0, evaluatedFindings: evaluated, violations };
}

export function formatTop(report: VelloxReport): string {
  const byRule = new Map<string, number>();
  for (const item of report.findings) byRule.set(item.ruleId, (byRule.get(item.ruleId) || 0) + 1);
  const hotspots = [...byRule.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8);
  const lines = [
    'VELLOX / CURRENT PROJECT SNAPSHOT',
    '',
    `Target          ${path.basename(report.target)}`,
    `Generated       ${report.generatedAt}`,
    `Files           ${report.summary.filesScanned}`,
    `Findings        ${report.summary.findings}`,
    `Critical / High ${report.summary.critical} / ${report.summary.high}`,
    '',
    'TOP RULES'
  ];
  if (!hotspots.length) lines.push('No findings.');
  else hotspots.forEach(([rule, count], index) => lines.push(`${String(index + 1).padStart(2, '0')}  ${String(count).padStart(3, ' ')}  ${rule}`));
  lines.push('', 'This is a real scan snapshot, not live production telemetry.');
  return lines.join('\n');
}
