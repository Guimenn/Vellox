import fs from 'node:fs';
import path from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs <semver>');
  process.exit(1);
}

const root = process.cwd();
const manifests = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (entry.name === 'package.json') manifests.push(fullPath);
  }
}
walk(root);
for (const file of manifests) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

const replacements = [
  ['packages/agent-node/src/agent.ts', /const AGENT_VERSION = '[^']+'/g, "const AGENT_VERSION = '" + version + "'"],
  ['packages/agent-python/vellox/__init__.py', /__version__ = "[^"]+"/g, '__version__ = "' + version + '"'],
  ['packages/agent-python/pyproject.toml', /^version = "[^"]+"/m, 'version = "' + version + '"'],
  ['apps/collector/src/server.ts', /const COLLECTOR_VERSION = '[^']+'/g, "const COLLECTOR_VERSION = '" + version + "'"]
];
for (const [relative, pattern, replacement] of replacements) {
  const file = path.join(root, relative);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(pattern, replacement));
}
console.log('Updated workspace version to ' + version + '. Run pnpm install --lockfile-only.');
