import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workspaceVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
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
const mismatches = manifests.flatMap(file => {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return pkg.version === workspaceVersion ? [] : [path.relative(root, file) + ': ' + pkg.version];
});
const agentSource = fs.readFileSync(path.join(root, 'packages/agent-node/src/agent.ts'), 'utf8');
const pythonInit = fs.readFileSync(path.join(root, 'packages/agent-python/vellox/__init__.py'), 'utf8');
const pythonProject = fs.readFileSync(path.join(root, 'packages/agent-python/pyproject.toml'), 'utf8');
const collectorSource = fs.readFileSync(path.join(root, 'apps/collector/src/server.ts'), 'utf8');
if (!agentSource.includes("const AGENT_VERSION = '" + workspaceVersion + "'")) mismatches.push('Node agent constant');
if (!pythonInit.includes('__version__ = "' + workspaceVersion + '"')) mismatches.push('Python agent constant');
if (!pythonProject.includes('version = "' + workspaceVersion + '"')) mismatches.push('Python package version');
if (!collectorSource.includes("const COLLECTOR_VERSION = '" + workspaceVersion + "'")) mismatches.push('Collector version constant');

if (mismatches.length) {
  console.error('Version mismatch; expected ' + workspaceVersion + ':\n- ' + mismatches.join('\n- '));
  process.exit(1);
}
console.log('All ' + manifests.length + ' package manifests and runtime constants use ' + workspaceVersion + '.');
