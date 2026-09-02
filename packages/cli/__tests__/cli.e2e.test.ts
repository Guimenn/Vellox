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
    execFileSync(process.execPath, [cli, 'scan', fixture], { encoding: 'utf8' });
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

  it('executes every workflow command documented in the public CLI reference', () => {
    const run = (command: string[], cwd = fixture): string => execFileSync(process.execPath, [cli, ...command], { cwd, encoding: 'utf8' });

    expect(run(['--help'])).toContain('Usage:');
    expect(run(['doctor'])).toContain('Node.js');
    expect(run(['discover', fixture])).toContain('PostgreSQL');
    expect(run(['demo'])).toContain('real scanner');
    expect(run(['ai', 'SELECT * FROM users'])).toContain('Do not invent row counts');

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

    const sarif = run(['scan', fixture, '--format', 'sarif', '--no-write']);
    expect(JSON.parse(sarif).version).toBe('2.1.0');

    const planPath = path.join(fixture, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users', 'Shared Hit Blocks': 9, 'Shared Read Blocks': 1 } }));
    expect(run(['explain', planPath])).toContain('Sequential scans: 1');

    const ddlPath = path.join(fixture, 'migration.sql');
    fs.writeFileSync(ddlPath, 'CREATE TABLE child (id UUID, parent_id UUID, FOREIGN KEY (parent_id) REFERENCES parent(id));');
    expect(run(['ddl', ddlPath])).toContain('Foreign key without a supporting index');

    expect(run(['init', fixture])).toContain('vellox.config.json');
    fs.mkdirSync(path.join(fixture, '.git'), { recursive: true });
    expect(run(['hook', fixture])).toContain('pre-commit');
    expect(fs.readFileSync(path.join(fixture, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain('vellox check');
    expect(run(['ci', fixture])).toContain('vellox.yml');

    const baselinePath = path.join(fixture, '.vellox', 'baseline.json');
    expect(run(['baseline', fixture, '--output', baselinePath])).toContain('Baseline saved');
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
