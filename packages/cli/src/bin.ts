#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, readReport, resolveFromTarget, writeJson } from './config.js';
import { buildMigration, evaluateBudgets, formatMarkdown, formatPretty, formatTop, toSarif } from './formatters.js';
import { analyzeSqlDocument, analyzeSqlQuery, scanProject } from './scanner.js';
import { VelloxBudgets, VelloxReport } from './types.js';

const args = process.argv.slice(2);

function resolveVersion(): string {
  try {
    let directory = path.dirname(fs.realpathSync(process.argv[1]!));
    for (let depth = 0; depth < 5; depth += 1) {
      const candidate = path.join(directory, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'vellox' && pkg.version) return pkg.version;
      }
      directory = path.dirname(directory);
    }
  } catch {}
  return 'development';
}

const VERSION = resolveVersion();

function header(): string {
  return [
    '┌────────────────────────────────────────────────────────┐',
    '│  VELLOX CLI v' + VERSION.padEnd(40, ' ') + '│',
    '│  Evidence-first performance and database intelligence  │',
    '└────────────────────────────────────────────────────────┘'
  ].join('\n');
}

function option(name: string): string | undefined {
  const inline = args.find(value => value.startsWith(name + '='));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function positionals(afterCommand = true): string[] {
  const values: string[] = [];
  for (let index = afterCommand ? 1 : 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value.startsWith('--')) {
      if (!value.includes('=') && !['--no-write', '--allow-secrets'].includes(value)) index += 1;
      continue;
    }
    if (/^-[a-z]$/i.test(value)) continue;
    values.push(value);
  }
  return values;
}

function targetFrom(value?: string): string {
  return path.resolve(process.cwd(), value || '.');
}

function reportPathFor(target: string): string {
  const config = loadConfig(target);
  return resolveFromTarget(target, option('--report') || config.reportPath || DEFAULT_CONFIG.reportPath!);
}

function writeOutput(value: string, defaultPath?: string): void {
  const requested = option('--output') || defaultPath;
  if (!requested) {
    console.log(value);
    return;
  }
  const outputPath = path.resolve(process.cwd(), requested);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, value.endsWith('\n') ? value : value + '\n', 'utf8');
  console.log('Saved: ' + outputPath);
}

function scanAndPersist(target: string): VelloxReport {
  const report = scanProject(target, VERSION);
  if (!hasFlag('--no-write')) writeJson(reportPathFor(target), report);
  return report;
}

function loadOrScan(target: string): VelloxReport {
  const explicit = option('--report');
  if (explicit) return readReport(path.resolve(process.cwd(), explicit));
  const configured = reportPathFor(target);
  return fs.existsSync(configured) ? readReport(configured) : scanAndPersist(target);
}

function projectScan(target: string): void {
  const report = scanAndPersist(target);
  const format = option('--format') || 'pretty';
  if (format === 'json') writeOutput(JSON.stringify(report, null, 2));
  else if (format === 'sarif') writeOutput(JSON.stringify(toSarif(report), null, 2));
  else if (format === 'pretty') {
    console.log(header());
    console.log(formatPretty(report));
    if (!hasFlag('--no-write')) console.log('\nReport: ' + reportPathFor(target));
  } else throw new Error('Unsupported format "' + format + '". Use pretty, json, or sarif.');
}

function inlineReport(sql: string, file?: string): VelloxReport {
  const findings = file ? analyzeSqlDocument(sql, file) : analyzeSqlQuery(sql);
  return {
    schemaVersion: '1.0',
    tool: { name: 'vellox', version: VERSION },
    generatedAt: new Date().toISOString(),
    target: file || 'inline SQL',
    databaseContext: { detected: true, evidence: [file ? `SQL file: ${file}` : 'Inline SQL input'] },
    summary: {
      filesScanned: 0,
      findings: findings.length,
      critical: findings.filter(item => item.severity === 'CRITICAL').length,
      high: findings.filter(item => item.severity === 'HIGH').length,
      medium: findings.filter(item => item.severity === 'MEDIUM').length,
      low: findings.filter(item => item.severity === 'LOW').length,
      secrets: 0,
      infrastructure: 0,
      reviewableSqlFixes: 0
    },
    findings
  };
}

function singleQuery(sql: string, file?: string): void {
  const report = inlineReport(sql, file);
  const format = option('--format') || 'pretty';
  if (format === 'json') writeOutput(JSON.stringify(report, null, 2));
  else if (format === 'sarif') writeOutput(JSON.stringify(toSarif(report), null, 2));
  else {
    console.log(header());
    console.log(formatPretty(report));
  }
}

function optimize(input: string): void {
  if (!input) return projectScan(targetFrom('.'));
  const candidate = path.resolve(process.cwd(), input);
  if (fs.existsSync(candidate)) {
    if (fs.statSync(candidate).isDirectory()) return projectScan(candidate);
    if (!/\.sql$/i.test(candidate)) throw new Error('vellox optimize accepts SQL text, a .sql file, or a project directory.');
    return singleQuery(fs.readFileSync(candidate, 'utf8'), path.basename(candidate));
  }
  return singleQuery(input);
}

function fix(target: string): void {
  const report = loadOrScan(target);
  const migration = buildMigration(report);
  if (!migration) {
    console.log('No evidence-backed SQL fix is available. No migration was created.');
    return;
  }
  const outputPath = path.resolve(target, option('--output') || 'migrations/vellox_optimizations.sql');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, migration, 'utf8');
  console.log('Generated ' + report.summary.reviewableSqlFixes + ' reviewable SQL suggestion(s): ' + outputPath);
}

function markdownReport(target: string): void {
  const report = loadOrScan(target);
  writeOutput(formatMarkdown(report), option('--output') || path.join(target, 'vellox-report.md'));
}

function numberOption(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(name + ' must be a non-negative number.');
  return parsed;
}

function check(target: string): void {
  const config = loadConfig(target);
  const report = scanAndPersist(target);
  const budgets: VelloxBudgets = {
    maxCritical: numberOption('--max-critical', config.budgets.maxCritical),
    maxHigh: numberOption('--max-high', config.budgets.maxHigh),
    maxTotal: option('--max-total') === undefined ? config.budgets.maxTotal : numberOption('--max-total', Number.MAX_SAFE_INTEGER),
    failOnSecrets: hasFlag('--allow-secrets') ? false : config.budgets.failOnSecrets
  };
  const baselineOption = option('--baseline') || config.baselinePath;
  const baselinePath = baselineOption ? resolveFromTarget(target, baselineOption) : undefined;
  const baselineValue = baselinePath && fs.existsSync(baselinePath) ? readReport(baselinePath) : undefined;
  const evaluation = evaluateBudgets(report, budgets, baselineValue);

  console.log(header());
  console.log('Evaluated ' + evaluation.evaluatedFindings.length + (baselineValue ? ' new' : '') + ' finding(s).');
  if (evaluation.passed) {
    console.log('✅ CI gate passed: all configured budgets are satisfied.');
    return;
  }
  console.error('❌ CI gate failed:');
  evaluation.violations.forEach(violation => console.error('  - ' + violation));
  process.exitCode = 1;
}

function baseline(target: string): void {
  const config = loadConfig(target);
  const report = scanProject(target, VERSION);
  const outputPath = resolveFromTarget(target, option('--output') || config.baselinePath || DEFAULT_CONFIG.baselinePath!);
  writeJson(outputPath, report);
  console.log('Baseline saved with ' + report.summary.findings + ' finding(s): ' + outputPath);
}

function demo(): void {
  const sample = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-demo-'));
  try {
    fs.mkdirSync(path.join(sample, 'src'), { recursive: true });
    fs.mkdirSync(path.join(sample, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(sample, 'package.json'), JSON.stringify({
      name: 'vellox-demo-service',
      dependencies: { '@prisma/client': '^6.0.0' }
    }, null, 2));
    fs.writeFileSync(path.join(sample, 'src', 'orders.ts'), [
      'export async function loadOrders(orders) {',
      '  for (const order of orders) {',
      '    order.items = await prisma.item.findMany({ where: { orderId: order.id } });',
      '  }',
      '}'
    ].join('\n'));
    fs.writeFileSync(path.join(sample, 'prisma', 'schema.prisma'), [
      'datasource db {',
      '  provider = "postgresql"',
      '  url = env("DATABASE_URL")',
      '}',
      'model Item {',
      '  id String @id',
      '  orderId String',
      '  order Order @relation(fields: [orderId], references: [id])',
      '}',
      'model Order {',
      '  id String @id',
      '  items Item[]',
      '}'
    ].join('\n'));
    console.log('VELLOX DEMO — real scanner, temporary sample project.\n');
    console.log(formatPretty(scanProject(sample, VERSION)));
  } finally {
    fs.rmSync(sample, { recursive: true, force: true });
  }
}

function aiPrompt(sql: string): void {
  if (!sql) throw new Error('Usage: vellox ai "<sql query>"');
  const findings = analyzeSqlQuery(sql);
  const evidence = findings.length
    ? findings.map(item => '- [' + item.severity + '] ' + item.title + ': ' + item.recommendation).join('\n')
    : '- No supported structural anti-pattern was detected. Request an EXPLAIN plan before changing indexes.';
  console.log([
    'You are reviewing a SQL query using evidence produced by Vellox.',
    '',
    'Query:',
    '~~~sql',
    sql,
    '~~~',
    '',
    'Observed findings:',
    evidence,
    '',
    'Return a semantics-preserving rewrite, justified indexes, ORM examples, risks, and an EXPLAIN ANALYZE validation plan.',
    'Do not invent row counts, latency, or monetary savings.'
  ].join('\n'));
}

function collectPlanNodes(node: Record<string, unknown>, nodes: Record<string, unknown>[] = []): Record<string, unknown>[] {
  nodes.push(node);
  if (Array.isArray(node.Plans)) {
    for (const child of node.Plans) if (child && typeof child === 'object') collectPlanNodes(child as Record<string, unknown>, nodes);
  }
  return nodes;
}

function explain(filePath?: string): void {
  if (!filePath) throw new Error('Usage: vellox explain <plan.json>');
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as Record<string, unknown> | Array<Record<string, unknown>>;
  const document = Array.isArray(parsed) ? parsed[0]! : parsed;
  const root = (document.Plan || document) as Record<string, unknown>;
  if (!root || typeof root !== 'object') throw new Error('Invalid EXPLAIN JSON: root Plan is missing.');
  const nodes = collectPlanNodes(root);
  const scans = nodes.filter(node => node['Node Type'] === 'Seq Scan');
  const sorts = nodes.filter(node => String(node['Sort Method'] || '').toLowerCase().includes('external'));
  const hit = nodes.reduce((sum, node) => sum + Number(node['Shared Hit Blocks'] || 0), 0);
  const read = nodes.reduce((sum, node) => sum + Number(node['Shared Read Blocks'] || 0), 0);
  const ratio = hit + read > 0 ? hit / (hit + read) * 100 : 100;
  console.log(header());
  console.log('POSTGRESQL EXPLAIN EVIDENCE');
  console.log('  Nodes:             ' + nodes.length);
  console.log('  Sequential scans: ' + scans.length);
  console.log('  External sorts:   ' + sorts.length);
  console.log('  Buffer hit ratio: ' + ratio.toFixed(1) + '% (' + hit + ' hit / ' + read + ' read)');
  for (const node of scans) console.log('  - Seq Scan on ' + (node['Relation Name'] || 'unknown relation') + '; filter: ' + (node.Filter || 'not reported'));
}

function ddl(filePath?: string): void {
  if (!filePath) throw new Error('Usage: vellox ddl <migration.sql>');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-ddl-'));
  try {
    fs.copyFileSync(path.resolve(filePath), path.join(directory, path.basename(filePath)));
    const report = scanProject(directory, VERSION);
    console.log(formatPretty(report));
    if (report.summary.high || report.summary.critical) process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function doctor(): void {
  const major = Number(process.versions.node.split('.')[0]);
  console.log(header());
  console.log('Node.js       ' + process.version + (major >= 20 ? ' ✓' : ' ✗ requires 20+'));
  console.log('Platform      ' + process.platform + ' ' + process.arch);
  console.log('CPU           ' + os.cpus().length + ' cores');
  console.log('Memory        ' + (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + ' GB');
  if (major < 20) process.exitCode = 1;
}

function discover(target: string): void {
  const packagePath = path.join(target, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error('No package.json found in ' + target);
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const candidates: Record<string, string> = {
    express: 'Express', fastify: 'Fastify', '@nestjs/core': 'NestJS', '@prisma/client': 'Prisma',
    typeorm: 'TypeORM', pg: 'PostgreSQL', mysql2: 'MySQL', mongoose: 'MongoDB', ioredis: 'Redis', oracledb: 'Oracle'
  };
  const detected = Object.entries(candidates).filter(([name]) => dependencies[name]).map(([, label]) => label);
  console.log('Detected: ' + (detected.length ? detected.join(', ') : 'no supported Node.js integration'));
  console.log('Only the public vellox CLI is recommended until the agent SDK packages are published.');
}

function init(target: string): void {
  const configPath = path.join(target, 'vellox.config.json');
  if (fs.existsSync(configPath)) throw new Error('Configuration already exists: ' + configPath);
  writeJson(configPath, DEFAULT_CONFIG);
  console.log('Created: ' + configPath);
}

function hook(target: string): void {
  const gitDirectory = path.join(target, '.git');
  if (!fs.existsSync(gitDirectory)) throw new Error('Run this command from the root of a Git repository.');
  const hookPath = path.join(gitDirectory, 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, '#!/usr/bin/env sh\nnpx --yes vellox check\n', { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  console.log('Installed: ' + hookPath);
}

function ci(target: string): void {
  const workflowPath = path.join(target, '.github', 'workflows', 'vellox.yml');
  const workflow = [
    'name: Vellox',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main]',
    'permissions:',
    '  contents: read',
    '  security-events: write',
    'jobs:',
    '  scan:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v6',
    '      - uses: actions/setup-node@v6',
    '        with:',
    '          node-version: 24',
    '      - run: npx --yes vellox scan . --format sarif --output vellox.sarif',
    '      - uses: github/codeql-action/upload-sarif@v4',
    '        if: always()',
    '        with:',
    '          sarif_file: vellox.sarif',
    '      - run: npx --yes vellox check'
  ].join('\n') + '\n';
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, workflow, 'utf8');
  console.log('Created: ' + workflowPath);
}

function help(): void {
  console.log(header());
  console.log([
    '',
    'Usage:',
    '  vellox [path] [--format pretty|json|sarif] [--output file]',
    '  vellox scan [path|"SQL"] [--format pretty|json|sarif]',
    '  vellox optimize [path|query.sql|"SQL"] [--format pretty|json|sarif]',
    '  vellox check [path] [--baseline file] [--max-critical N] [--max-high N]',
    '  vellox baseline [path] [--output file]',
    '  vellox fix [path] [--report file] [--output migration.sql]',
    '  vellox report [path] [--report file] [--output report.md]',
    '  vellox top [path] [--report file]',
    '  vellox explain <plan.json>',
    '  vellox ddl <migration.sql>',
    '  vellox ai "<sql>" | demo | discover | init | hook | ci | doctor',
    '',
    'Every project scan writes .vellox/report.json unless --no-write is set.',
    'No command executes SQL or mutates a database.'
  ].join('\n'));
}

function main(): void {
  const rawCommand = args[0] || '';
  const command = rawCommand.toLowerCase();
  if (!command || command === '-s') return projectScan(targetFrom(positionals(Boolean(command))[0]));
  if (command === 'optimize') return optimize(positionals().join(' ').trim());
  if (command === 'scan') {
    const input = positionals().join(' ').trim();
    return /^(?:SELECT|INSERT|UPDATE|DELETE|CREATE|WITH)\b/i.test(input) ? singleQuery(input) : projectScan(targetFrom(input || '.'));
  }
  if (command === 'check') return check(targetFrom(positionals()[0]));
  if (command === 'baseline') return baseline(targetFrom(positionals()[0]));
  if (command === 'fix' || command === '-f') return fix(targetFrom(positionals()[0]));
  if (command === 'report' || command === '-r') return markdownReport(targetFrom(positionals()[0]));
  if (['top', 'live', 'monitor'].includes(command)) return console.log(formatTop(loadOrScan(targetFrom(positionals()[0]))));
  if (command === 'demo' || command === '-d') return demo();
  if (['ai', 'prompt', 'ai-prompt', '-p'].includes(command)) return aiPrompt(positionals().join(' '));
  if (['explain', 'plan'].includes(command)) return explain(positionals()[0]);
  if (['ddl', 'ddl-check'].includes(command)) return ddl(positionals()[0]);
  if (command === 'doctor') return doctor();
  if (command === 'discover') return discover(targetFrom(positionals()[0]));
  if (command === 'init') return init(targetFrom(positionals()[0]));
  if (['hook', 'hooks', 'pre-commit'].includes(command)) return hook(targetFrom(positionals()[0]));
  if (['ci', 'action', 'workflow'].includes(command)) return ci(targetFrom(positionals()[0]));
  if (['version', '-v', '--version'].includes(command)) return console.log('vellox v' + VERSION);
  if (['help', '-h', '--help'].includes(command)) return help();
  if (fs.existsSync(rawCommand)) return projectScan(targetFrom(rawCommand));
  throw new Error('Unknown command: ' + args[0]);
}

try {
  main();
} catch (error) {
  console.error('Vellox error: ' + (error as Error).message);
  process.exitCode = 1;
}
