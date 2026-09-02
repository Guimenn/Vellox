import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const cliDirectory = path.join(root, 'packages/cli');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-package-'));
try {
  const packOutput = execFileSync('npm', ['pack', '--json'], {
    cwd: cliDirectory,
    encoding: 'utf8',
    env: process.env
  });
  const pack = JSON.parse(packOutput)[0];
  const tarball = path.join(cliDirectory, pack.filename);
  const packageDirectory = path.join(temporary, 'consumer');
  fs.mkdirSync(path.join(packageDirectory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: 'vellox-consumer', private: true }));
  fs.writeFileSync(path.join(packageDirectory, 'src', 'orders.ts'), [
    'export async function load(orders) {',
    '  for (const order of orders) {',
    "    await db.query('SELECT * FROM items WHERE order_id = $1', [order.id]);",
    '  }',
    '}'
  ].join('\n'));
  execFileSync('npm', ['install', '--ignore-scripts', tarball], { cwd: packageDirectory, stdio: 'pipe', env: process.env });
  const executable = path.join(packageDirectory, 'node_modules', '.bin', process.platform === 'win32' ? 'vellox.cmd' : 'vellox');
  const version = execFileSync(executable, ['--version'], { cwd: packageDirectory, encoding: 'utf8' }).trim();
  if (version !== 'vellox v' + pack.version) throw new Error('Installed binary version mismatch: ' + version);
  execFileSync(executable, ['scan', '.'], { cwd: packageDirectory, stdio: 'pipe' });
  const report = JSON.parse(fs.readFileSync(path.join(packageDirectory, '.vellox', 'report.json'), 'utf8'));
  if (!report.findings.some(item => item.ruleId === 'code/query-in-loop')) throw new Error('Packed CLI missed structural query-loop finding.');
  const gate = spawnSync(executable, ['check', '.'], { cwd: packageDirectory, encoding: 'utf8' });
  if (gate.status !== 1) throw new Error('Packed CLI gate did not fail on the real high-severity finding.');
  console.log('Packed vellox@' + pack.version + ' installed and passed scan/report/gate smoke tests.');
  fs.rmSync(tarball, { force: true });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
