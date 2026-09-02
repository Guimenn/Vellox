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
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'cli-e2e', dependencies: { pg: '^8.0.0' } }));
  fs.writeFileSync(path.join(fixture, 'src', 'users.ts'), `export async function users(ids) {
  for (const id of ids) {
    await db.query('SELECT * FROM users WHERE id = $1', [id]);
  }
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
    expect(report.findings.some((item: { ruleId: string }) => item.ruleId === 'code/sequential-async-loop')).toBe(true);

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
});
