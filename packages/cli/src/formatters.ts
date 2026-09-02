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

  if (!report.findings.length) {
    lines.push('✅ No supported high-risk patterns were detected.');
    return lines.join('\n');
  }

  for (const [index, item] of report.findings.entries()) {
    const location = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : 'inline input';
    lines.push(`${index + 1}. [${item.severity}] ${item.title}`);
    lines.push(`   Rule:      ${item.ruleId}`);
    lines.push(`   Location:  ${location}`);
    lines.push(`   Evidence:  ${item.evidence}`);
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
    return `| ${item.severity} | \`${item.ruleId}\` | ${item.title.replace(/\|/g, '\\|')} | ${location} |`;
  });
  const detail = report.findings.map((item, index) => `### ${index + 1}. ${item.title}\n\n- **Severity:** ${item.severity}\n- **Rule:** \`${item.ruleId}\`\n- **Location:** ${item.file ? `\`${item.file}${item.line ? `:${item.line}` : ''}\`` : 'inline input'}\n- **Evidence:** ${item.evidence}\n- **Recommendation:** ${item.recommendation}${item.sql ? `\n- **Reviewable SQL:**\n\n\`\`\`sql\n${item.sql}\n\`\`\`` : ''}`).join('\n\n');

  return `# Vellox Engineering Report\n\nGenerated from an actual project scan on ${report.generatedAt}.\n\n## Summary\n\n| Metric | Value |\n| --- | ---: |\n| Files inspected | ${report.summary.filesScanned} |\n| Critical findings | ${report.summary.critical} |\n| High findings | ${report.summary.high} |\n| Medium findings | ${report.summary.medium} |\n| Exposed secrets | ${report.summary.secrets} |\n| Infrastructure findings | ${report.summary.infrastructure ?? 0} |\n| Reviewable SQL suggestions | ${report.summary.reviewableSqlFixes} |\n\n> Vellox does not invent monetary savings from static analysis. Cost estimates require measured telemetry and an explicit pricing model.\n\n## Findings\n\n${rows.length ? `| Severity | Rule | Finding | Location |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n${detail}` : 'No supported high-risk patterns were detected.'}\n`;
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
      results: report.findings.map(item => ({
        ruleId: item.ruleId,
        level: sarifLevel(item.severity),
        message: { text: `${item.title}: ${item.evidence}` },
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
  const secrets = evaluated.filter(item => item.category === 'security').length;
  const violations: string[] = [];
  if (critical > budgets.maxCritical) violations.push(`${critical} critical finding(s) exceed maxCritical=${budgets.maxCritical}`);
  if (high > budgets.maxHigh) violations.push(`${high} high finding(s) exceed maxHigh=${budgets.maxHigh}`);
  if (budgets.maxTotal !== null && evaluated.length > budgets.maxTotal) violations.push(`${evaluated.length} finding(s) exceed maxTotal=${budgets.maxTotal}`);
  if (budgets.failOnSecrets && secrets > 0) violations.push(`${secrets} exposed secret(s) violate failOnSecrets=true`);
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
