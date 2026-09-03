#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, readReport, resolveFromTarget, writeJson } from './config.js';
import { analyzePostgresExplain } from './explain.js';
import { buildMigration, evaluateBudgets, formatMarkdown, formatPretty, formatTop, toSarif } from './formatters.js';
import { analyzeSqlDocument, analyzeSqlQuery, scanProject } from './scanner.js';
import { filterRules, formatRuleCatalog } from './rules.js';
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

function explain(filePath?: string): void {
  if (!filePath) throw new Error('Usage: vellox explain <plan.json>');
  const resolved = path.resolve(filePath);
  const report = analyzePostgresExplain(JSON.parse(fs.readFileSync(resolved, 'utf8')), path.basename(resolved), VERSION);
  const format = option('--format') || 'pretty';
  if (format === 'json') writeOutput(JSON.stringify(report, null, 2));
  else if (format === 'sarif') writeOutput(JSON.stringify(toSarif(report), null, 2));
  else if (format === 'pretty') {
    console.log(header());
    console.log(formatPretty(report));
  } else throw new Error('Unsupported format "' + format + '". Use pretty, json, or sarif.');
}

function rules(): void {
  const matches = filterRules(positionals().join(' '));
  if (option('--format') === 'json') writeOutput(JSON.stringify(matches, null, 2));
  else console.log(formatRuleCatalog(matches));
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
  const detected = new Set<string>();
  let manifestFound = false;
  if (fs.existsSync(packagePath)) {
    manifestFound = true;
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const candidates: Record<string, string> = {
    express: 'Express', fastify: 'Fastify', '@nestjs/core': 'NestJS', '@prisma/client': 'Prisma',
    typeorm: 'TypeORM', pg: 'PostgreSQL', mysql2: 'MySQL', mongoose: 'MongoDB', ioredis: 'Redis', oracledb: 'Oracle'
    };
    for (const [name, label] of Object.entries(candidates)) if (dependencies[name]) detected.add(label);
  }
  const pythonManifests = fs.readdirSync(target)
    .filter(file => /^(?:pyproject\.toml|Pipfile|requirements(?:\.[\w-]+)?\.txt)$/i.test(file));
  const pythonCandidates: Array<[RegExp, string]> = [
    [/\bfastapi\b/i, 'FastAPI'], [/\bdjango\b/i, 'Django'], [/\bflask\b/i, 'Flask'],
    [/\bsqlalchemy\b/i, 'SQLAlchemy'], [/\basyncpg\b/i, 'asyncpg'], [/\bpsycopg(?:2)?\b/i, 'PostgreSQL'],
    [/\bpymongo\b/i, 'MongoDB'], [/\btortoise-orm\b/i, 'Tortoise ORM'], [/\bpeewee\b/i, 'Peewee'], [/\bredis\b/i, 'Redis']
  ];
  for (const manifest of pythonManifests) {
    const manifestPath = path.join(target, manifest);
    if (!fs.existsSync(manifestPath)) continue;
    manifestFound = true;
    const content = fs.readFileSync(manifestPath, 'utf8');
    for (const [pattern, label] of pythonCandidates) if (pattern.test(content)) detected.add(label);
  }
  if (!manifestFound) throw new Error('No package.json, pyproject.toml, requirements.txt, or Pipfile found in ' + target);
  console.log('Detected: ' + (detected.size ? [...detected].join(', ') : 'no supported framework or database integration'));
  console.log('Static scanning remains local and does not require an SDK, database connection, or application runtime.');
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
  let resolvedGitDirectory = gitDirectory;
  if (fs.statSync(gitDirectory).isFile()) {
    const pointer = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(gitDirectory, 'utf8'))?.[1]?.trim();
    if (!pointer) throw new Error('Could not resolve the Git directory from ' + gitDirectory);
    resolvedGitDirectory = path.resolve(target, pointer);
  }
  const commonDirectoryPointer = path.join(resolvedGitDirectory, 'commondir');
  if (fs.existsSync(commonDirectoryPointer)) {
    resolvedGitDirectory = path.resolve(resolvedGitDirectory, fs.readFileSync(commonDirectoryPointer, 'utf8').trim());
  }
  const hookPath = path.join(resolvedGitDirectory, 'hooks', 'pre-commit');
  const marker = '# >>> vellox check >>>';
  const block = `${marker}\nnpx --yes vellox check\n# <<< vellox check <<<\n`;
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(marker)) {
      console.log('Already installed: ' + hookPath);
      return;
    }
    if (!/^#!.*\b(?:ba|da|z)?sh\b/m.test(existing)) {
      throw new Error('Existing pre-commit hook is not a shell script; it was left unchanged: ' + hookPath);
    }
    fs.appendFileSync(hookPath, `${existing.endsWith('\n') ? '' : '\n'}\n${block}`, 'utf8');
  } else {
    fs.writeFileSync(hookPath, `#!/usr/bin/env sh\n${block}`, { mode: 0o755 });
  }
  fs.chmodSync(hookPath, 0o755);
  console.log('Installed: ' + hookPath);
}

function ci(target: string): void {
  const workflowDirectory = path.join(target, '.github', 'workflows');
  const marker = '# Generated by vellox ci';
  const workflow = [
    marker,
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
  fs.mkdirSync(workflowDirectory, { recursive: true });
  const ownedWorkflow = fs.readdirSync(workflowDirectory)
    .filter(file => /^vellox.*\.ya?ml$/i.test(file))
    .map(file => path.join(workflowDirectory, file))
    .find(file => fs.readFileSync(file, 'utf8').includes(marker));
  let workflowPath = ownedWorkflow || path.join(workflowDirectory, 'vellox.yml');
  if (!ownedWorkflow && fs.existsSync(workflowPath)) {
    let suffix = 2;
    while (fs.existsSync(path.join(workflowDirectory, `vellox-${suffix}.yml`))) suffix += 1;
    workflowPath = path.join(workflowDirectory, `vellox-${suffix}.yml`);
  }
  if (fs.existsSync(workflowPath) && fs.readFileSync(workflowPath, 'utf8') === workflow) {
    console.log('Already configured: ' + workflowPath);
    return;
  }
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
    '  vellox explain <plan.json> [--format pretty|json|sarif] [--output file]',
    '  vellox rules [filter] [--format pretty|json]',
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
  if (command === 'rules') return rules();
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
