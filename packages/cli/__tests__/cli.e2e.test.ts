import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cli = path.resolve('packages/cli/dist/bin.js');
let fixture = '';

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-cli-e2e-'));
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'cli-e2e', dependencies: { pg: '^8.0.0' } }));
  fs.writeFileSync(path.join(fixture, 'src', 'users.ts'), `export async function users(ids) {
  for (const id of ids) {
    await db.query('SELECT * FROM users WHERE id = $1', [id]);
  }
}
`);
  fs.writeFileSync(path.join(fixture, 'prisma', 'schema.prisma'), `datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}
model Item {
  id String @id
  orderId String
  order Order @relation(fields: [orderId], references: [id])
}
model Order {
  id String @id
  items Item[]
}
`);
});

afterAll(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe('published CLI behavior', () => {
  it('writes a reusable JSON report and a real Markdown report', () => {
    const scanOutput = execFileSync(process.execPath, [cli, 'scan', fixture], { encoding: 'utf8' });
    expect(scanOutput).toContain('NEXT — REVIEW, ADOPT, PROTECT');
    expect(scanOutput).toContain('npx --yes vellox report');
    expect(scanOutput).toContain('npx --yes vellox baseline');
    expect(scanOutput).toContain('npx --yes vellox ci');
    const reportPath = path.join(fixture, '.vellox', 'report.json');
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.findings.some((item: { ruleId: string }) => item.ruleId === 'code/query-in-loop')).toBe(true);

    execFileSync(process.execPath, [cli, 'report', fixture], { encoding: 'utf8' });
    const markdown = fs.readFileSync(path.join(fixture, 'vellox-report.md'), 'utf8');
    expect(markdown).toContain('Generated from an actual project scan');
    expect(markdown).not.toContain('$48,291');
  });

  it('fails the gate from real findings instead of a constant', () => {
    const result = spawnSync(process.execPath, [cli, 'check', fixture], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('high finding(s) exceed');
  });

  it('fails closed on incomplete coverage and supports an explicit override', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-coverage-e2e-'));
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'coverage-e2e' }));
    fs.writeFileSync(path.join(target, 'large.ts'), `export const payload = '${'x'.repeat(200)}';`);
    try {
      const scan = JSON.parse(execFileSync(process.execPath, [cli, 'scan', target, '--format', 'json', '--no-write', '--max-file-bytes', '100'], { encoding: 'utf8' }));
      expect(scan.coverage).toMatchObject({ complete: false, filesSkipped: 1 });

      const rejected = spawnSync(process.execPath, [cli, 'check', target, '--max-file-bytes', '100'], { encoding: 'utf8' });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('failOnIncompleteAnalysis=true');

      const allowed = spawnSync(process.execPath, [cli, 'check', target, '--max-file-bytes', '100', '--allow-incomplete'], { encoding: 'utf8' });
      expect(allowed.status).toBe(0);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('accepts case-sensitive project paths as the default command', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-case-e2e-'));
    const target = path.join(parent, 'CaseSensitiveProject');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'case-sensitive' }));
    try {
      const output = execFileSync(process.execPath, [cli, target, '--no-write'], { encoding: 'utf8' });
      expect(output).toContain('VELLOX PROJECT ANALYSIS');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('discovers Python projects without requiring package.json', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-python-e2e-'));
    fs.writeFileSync(path.join(target, 'pyproject.toml'), '[project]\ndependencies = ["fastapi", "sqlalchemy", "asyncpg"]\n');
    try {
      const output = execFileSync(process.execPath, [cli, 'discover', target], { encoding: 'utf8' });
      expect(output).toContain('FastAPI');
      expect(output).toContain('SQLAlchemy');
      expect(output).toContain('asyncpg');
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('preserves existing hooks and workflows and remains idempotent', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-safe-install-e2e-'));
    const hookPath = path.join(target, '.git', 'hooks', 'pre-commit');
    const workflowPath = path.join(target, '.github', 'workflows', 'vellox.yml');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/usr/bin/env sh\necho existing-check\n');
    fs.writeFileSync(workflowPath, 'name: Existing workflow\n');
    try {
      execFileSync(process.execPath, [cli, 'hook', target], { encoding: 'utf8' });
      const firstHook = fs.readFileSync(hookPath, 'utf8');
      expect(firstHook).toContain('echo existing-check');
      expect(firstHook.match(/npx --yes vellox check/g)).toHaveLength(1);
      expect(execFileSync(process.execPath, [cli, 'hook', target], { encoding: 'utf8' })).toContain('Already installed');
      expect(fs.readFileSync(hookPath, 'utf8')).toBe(firstHook);

      const created = execFileSync(process.execPath, [cli, 'ci', target], { encoding: 'utf8' });
      expect(created).toContain('vellox-2.yml');
      expect(fs.readFileSync(workflowPath, 'utf8')).toBe('name: Existing workflow\n');
      const generatedPath = path.join(target, '.github', 'workflows', 'vellox-2.yml');
      const firstWorkflow = fs.readFileSync(generatedPath, 'utf8');
      expect(firstWorkflow).toContain('# Generated by vellox ci');
      expect(execFileSync(process.execPath, [cli, 'ci', target], { encoding: 'utf8' })).toContain('Already configured');
      expect(fs.readFileSync(generatedPath, 'utf8')).toBe(firstWorkflow);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('reuses a safe clean-commit cache and scopes findings to Git changes', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-incremental-e2e-'));
    fs.mkdirSync(path.join(target, 'src'), { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'incremental', dependencies: { pg: '^8.0.0' } }));
    fs.writeFileSync(path.join(target, 'src', 'changed.ts'), 'export const changed = true;\n');
    fs.writeFileSync(path.join(target, 'src', 'existing.ts'), "export async function existing(ids) { for (const id of ids) await db.query('SELECT id FROM users WHERE id = $1', [id]); }\n");
    const git = (values: string[]): string => execFileSync('git', values, { cwd: target, encoding: 'utf8' });
    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'vellox@example.test']);
      git(['config', 'user.name', 'Vellox Test']);
      git(['add', '.']);
      git(['commit', '-qm', 'fixture']);

      execFileSync(process.execPath, [cli, 'scan', target], { encoding: 'utf8' });
      const cached = JSON.parse(execFileSync(process.execPath, [cli, 'scan', target, '--format', 'json'], { encoding: 'utf8' }));
      expect(cached.coverage).toMatchObject({ scope: 'full', cacheHit: true });

      fs.writeFileSync(path.join(target, 'src', 'changed.ts'), "export async function changed(ids) { for (const id of ids) await db.query('SELECT id FROM users WHERE id = $1', [id]); }\n");
      const changed = JSON.parse(execFileSync(process.execPath, [cli, 'scan', target, '--changed', '--format', 'json', '--no-write'], { encoding: 'utf8' }));
      expect(changed.coverage).toMatchObject({ scope: 'changed', changedBase: 'HEAD', filesDiscovered: 1 });
      expect(changed.findings.some((item: { file?: string }) => item.file === 'src/changed.ts')).toBe(true);
      expect(changed.findings.some((item: { file?: string }) => item.file === 'src/existing.ts')).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('executes every workflow command documented in the public CLI reference', () => {
    const run = (command: string[], cwd = fixture): string => execFileSync(process.execPath, [cli, ...command], { cwd, encoding: 'utf8' });

    expect(run(['--help'])).toContain('Start here — the complete team path:');
    expect(run(['doctor'])).toContain('Node.js');
    expect(run(['discover', fixture])).toContain('PostgreSQL');
    expect(run(['demo'])).toContain('real scanner');
    expect(run(['ai', 'SELECT * FROM users'])).toContain('Do not invent row counts');
    expect(run(['rules', 'fan-out'])).toContain('code/unbounded-query-fanout');
    expect(JSON.parse(run(['rules', 'explain/', '--format', 'json'])).length).toBe(5);

    const inline = run(['scan', 'SELECT * FROM users', '--format', 'json']);
    expect(JSON.parse(inline).findings.some((item: { ruleId: string }) => item.ruleId === 'query/select-star')).toBe(true);

    const optimized = run(['optimize', 'SELECT * FROM users WHERE id = $1', '--format', 'json']);
    const optimizedReport = JSON.parse(optimized);
    expect(optimizedReport.findings.some((item: { ruleId: string }) => item.ruleId === 'query/select-star')).toBe(true);
    expect(optimizedReport.findings.some((item: { ruleId: string }) => item.ruleId === 'query/unbounded-select')).toBe(false);

    const optimizationFile = path.join(fixture, 'optimization.sql');
    fs.writeFileSync(optimizationFile, 'SELECT id FROM users WHERE id = $1;\nUPDATE users SET enabled = false;\n');
    const fileOptimization = JSON.parse(run(['optimize', optimizationFile, '--format', 'json']));
    expect(fileOptimization.findings.some((item: { ruleId: string }) => item.ruleId === 'query/unbounded-write')).toBe(true);
    expect(fileOptimization.coverage).toMatchObject({ complete: true, sqlStatements: 2, sqlAstStatements: 2 });

    const sarif = run(['scan', fixture, '--format', 'sarif', '--no-write']);
    expect(JSON.parse(sarif).version).toBe('2.1.0');

    const planPath = path.join(fixture, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users', 'Shared Hit Blocks': 9, 'Shared Read Blocks': 1 } }));
    expect(run(['explain', planPath])).toContain('sequentialScans: 1');
    expect(JSON.parse(run(['explain', planPath, '--format', 'json'])).metrics.sequentialScans).toBe(1);

    const beforePlanPath = path.join(fixture, 'before-plan.json');
    const afterPlanPath = path.join(fixture, 'after-plan.json');
    fs.writeFileSync(beforePlanPath, JSON.stringify({ Plan: { 'Node Type': 'Seq Scan', 'Actual Total Time': 199, 'Actual Rows': 20_000, 'Actual Loops': 1, 'Shared Hit Blocks': 100, 'Shared Read Blocks': 900 }, 'Execution Time': 200 }));
    fs.writeFileSync(afterPlanPath, JSON.stringify({ Plan: { 'Node Type': 'Index Scan', 'Actual Total Time': 39, 'Actual Rows': 100, 'Actual Loops': 1, 'Shared Hit Blocks': 490, 'Shared Read Blocks': 10 }, 'Execution Time': 40 }));
    expect(run(['prove', beforePlanPath, afterPlanPath])).toContain('OBSERVED IMPROVEMENT');
    const proof = JSON.parse(run(['prove', beforePlanPath, afterPlanPath, '--format', 'json']));
    expect(proof).toMatchObject({ verdict: 'improved', evidenceQuality: 'single-run' });
    expect(proof.comparison.executionTimeMs.deltaPercent).toBe(-80);
    const regression = spawnSync(process.execPath, [cli, 'prove', afterPlanPath, beforePlanPath, '--fail-on-regression'], { cwd: fixture, encoding: 'utf8' });
    expect(regression.status).toBe(1);
    expect(regression.stdout).toContain('OBSERVED REGRESSION');

    const ddlPath = path.join(fixture, 'migration.sql');
    fs.writeFileSync(ddlPath, 'CREATE TABLE child (id UUID, parent_id UUID, FOREIGN KEY (parent_id) REFERENCES parent(id));');
    expect(run(['ddl', ddlPath])).toContain('Foreign key without a supporting index');

    expect(run(['init', fixture])).toContain('vellox.config.json');
    fs.mkdirSync(path.join(fixture, '.git'), { recursive: true });
    expect(run(['hook', fixture])).toContain('pre-commit');
    expect(fs.readFileSync(path.join(fixture, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain('vellox check');
    const ciOutput = run(['ci', fixture]);
    expect(ciOutput).toContain('vellox.yml');
    expect(ciOutput).toContain('commit the Vellox workflow and baseline');

    const baselinePath = path.join(fixture, '.vellox', 'baseline.json');
    const baselineOutput = run(['baseline', fixture, '--output', baselinePath]);
    expect(baselineOutput).toContain('Baseline saved');
    expect(baselineOutput).toContain('npx --yes vellox ci');
    expect(fs.existsSync(baselinePath)).toBe(true);

    run(['scan', fixture]);
    const migrationPath = path.join(fixture, 'migrations', 'vellox.sql');
    expect(run(['fix', fixture, '--output', migrationPath])).toContain('reviewable SQL suggestion');
    expect(fs.readFileSync(migrationPath, 'utf8')).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');

    const reportPath = path.join(fixture, 'vellox.md');
    expect(run(['report', fixture, '--output', reportPath])).toContain('Saved:');
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('Generated from an actual project scan');
    expect(run(['top', fixture])).toContain('CURRENT PROJECT SNAPSHOT');
  });
});
