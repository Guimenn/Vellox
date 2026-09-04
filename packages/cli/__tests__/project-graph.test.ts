import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanProject } from '../src/scanner.js';
import { formatMarkdown, formatPretty, toSarif } from '../src/formatters.js';

const temporaryDirectories: string[] = [];

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-graph-'));
  temporaryDirectories.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'graph-fixture', dependencies: { '@prisma/client': '^6.0.0' } }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function findings(files: Record<string, string>, file: string): Array<{ ruleId: string; confidence?: string; metadata?: Record<string, unknown> }> {
  return scanProject(project(files), 'test').findings.filter(item => item.file === file);
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true }));
});

describe('project-wide semantic call graph', () => {
  it('finds a JavaScript query loop through an aliased import', () => {
    const result = findings({
      'src/repository.ts': 'export async function fetchUser(id) { return prisma.user.findUnique({ where: { id } }); }',
      'src/service.ts': "import { fetchUser as loadOne } from './repository';\nexport async function hydrate(ids) { for (const id of ids) await loadOne(id); }"
    }, 'src/service.ts');
    const finding = result.find(item => item.ruleId === 'code/query-in-loop');

    expect(finding?.confidence).toBe('MEDIUM');
    expect(finding?.metadata?.pattern).toBe('cross-file-database');
    expect(finding?.metadata?.callPath).toContain('src/repository.ts:fetchUser -> database');
  });

  it('propagates database reachability through three JavaScript modules and a barrel', () => {
    const result = findings({
      'src/repository.ts': 'export async function fetchUser(id) { return prisma.user.findUnique({ where: { id } }); }',
      'src/index.ts': "export { fetchUser as loadOne } from './repository';",
      'src/service.ts': "import { loadOne } from './index';\nexport async function hydrateOne(id) { return loadOne(id); }",
      'src/controller.ts': "import { hydrateOne } from './service';\nexport async function hydrate(ids) { for (const id of ids) await hydrateOne(id); }"
    }, 'src/controller.ts');

    expect(result.some(item => item.ruleId === 'code/query-in-loop')).toBe(true);
  });

  it('resolves namespace imports and imported class instances', () => {
    const result = findings({
      'src/repository.ts': 'export class UserRepository { async find(id) { return prisma.user.findUnique({ where: { id } }); } }\nexport async function fetchUser(id) { return prisma.user.findUnique({ where: { id } }); }',
      'src/service.ts': "import * as users from './repository';\nimport { UserRepository } from './repository';\nconst repository = new UserRepository();\nexport async function hydrateViaNamespace(ids) { for (const id of ids) await users.fetchUser(id); }\nexport async function hydrateViaInstance(ids) { for (const id of ids) await repository.find(id); }"
    }, 'src/service.ts');

    expect(result.filter(item => item.ruleId === 'code/query-in-loop')).toHaveLength(2);
  });

  it('resolves TypeScript constructor-injected repositories', () => {
    const result = findings({
      'src/repository.ts': 'export class UserRepository { async find(id) { return prisma.user.findUnique({ where: { id } }); } }',
      'src/service.ts': "import { UserRepository } from './repository';\nexport class UserService { constructor(private readonly users: UserRepository) {} async hydrate(ids) { for (const id of ids) await this.users.find(id); } }"
    }, 'src/service.ts');
    const finding = result.find(item => item.ruleId === 'code/query-in-loop');

    expect(finding?.metadata?.callPath).toContain('src/repository.ts:find -> database');
  });

  it('upgrades cross-file Promise fan-out to database-specific evidence', () => {
    const result = findings({
      'src/repository.ts': 'export async function fetchUser(id) { return prisma.user.findUnique({ where: { id } }); }',
      'src/service.ts': "import { fetchUser } from './repository';\nexport async function hydrate(ids) { return Promise.all(ids.map(id => fetchUser(id))); }"
    }, 'src/service.ts');
    const rules = result.map(item => item.ruleId);

    expect(rules).toContain('code/unbounded-query-fanout');
    expect(rules).not.toContain('code/unbounded-async-fanout');
  });

  it('traces imported callback references used directly by collection methods', () => {
    const result = findings({
      'src/repository.ts': 'export async function fetchUser(id) { return prisma.user.findUnique({ where: { id } }); }',
      'src/service.ts': "import { fetchUser } from './repository';\nexport async function fanout(ids) { return Promise.all(ids.map(fetchUser)); }\nexport function hydrate(ids) { ids.forEach(fetchUser); }"
    }, 'src/service.ts');

    expect(result.some(item => item.ruleId === 'code/unbounded-query-fanout')).toBe(true);
    expect(result.some(item => item.ruleId === 'code/query-in-loop' && item.metadata?.pattern === 'cross-file-callback-database')).toBe(true);
  });

  it('traces imported functions through common wrapper and assignment aliases', () => {
    const result = findings({
      'src/repository.ts': 'export async function fetchUser(id) { return prisma.user.findUnique({ where: { id } }); }',
      'src/service.ts': "import { fetchUser } from './repository';\nconst retried = withRetry(fetchUser);\nconst loadOne = retried;\nexport async function hydrate(ids) { for (const id of ids) await loadOne(id); }"
    }, 'src/service.ts');

    expect(result.some(item => item.ruleId === 'code/query-in-loop')).toBe(true);
  });

  it('resolves TypeScript path aliases from tsconfig', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@data/*': ['src/data/*'] } } }),
      'src/data/users.ts': 'export async function fetchUser(id) { return prisma.user.findUnique({ where: { id } }); }',
      'src/service.ts': "import { fetchUser } from '@data/users';\nexport async function hydrate(ids) { for (const id of ids) await fetchUser(id); }"
    });
    const result = scanProject(root, 'test').findings.filter(item => item.file === 'src/service.ts');

    expect(result.some(item => item.ruleId === 'code/query-in-loop')).toBe(true);
  });

  it('uses the nearest monorepo tsconfig and inherited path aliases', () => {
    const root = project({
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['packages/shared/src/*'] } } }),
      'packages/api/tsconfig.json': '{\n  // package-local aliases\n  "extends": "../../tsconfig.base.json",\n  "compilerOptions": { "baseUrl": ".", "paths": { "@api/*": ["src/*"] }, },\n}',
      'packages/shared/src/users.ts': 'export async function fetchUser(id) { return prisma.user.findUnique({ where: { id } }); }',
      'packages/api/src/service.ts': "import { fetchUser } from '@shared/users';\nexport async function hydrate(ids) { for (const id of ids) await fetchUser(id); }"
    });
    const result = scanProject(root, 'test').findings.filter(item => item.file === 'packages/api/src/service.ts');

    expect(result.some(item => item.ruleId === 'code/query-in-loop')).toBe(true);
  });

  it('resolves imports between named workspace packages', () => {
    const result = findings({
      'packages/data/package.json': JSON.stringify({ name: '@acme/data', source: 'src/index.ts' }),
      'packages/data/src/index.ts': 'export async function fetchUser(id) { return prisma.user.findUnique({ where: { id } }); }',
      'packages/api/package.json': JSON.stringify({ name: '@acme/api' }),
      'packages/api/src/service.ts': "import { fetchUser } from '@acme/data';\nexport async function hydrate(ids) { for (const id of ids) await fetchUser(id); }"
    }, 'packages/api/src/service.ts');

    expect(result.some(item => item.ruleId === 'code/query-in-loop')).toBe(true);
  });

  it('resolves CommonJS require aliases and module exports', () => {
    const result = findings({
      'src/repository.cjs': "async function fetchUser(id) { return db.query('SELECT id FROM users WHERE id = ?', [id]); }\nmodule.exports = { fetchUser };",
      'src/service.cjs': "const { fetchUser: loadOne } = require('./repository.cjs');\nasync function hydrate(ids) { for (const id of ids) await loadOne(id); }\nmodule.exports.hydrate = hydrate;"
    }, 'src/service.cjs');

    expect(result.some(item => item.ruleId === 'code/query-in-loop')).toBe(true);
  });

  it('finds Python query loops through relative aliases and transitive modules', () => {
    const result = findings({
      'app/repository.py': 'def fetch_user(user_id):\n    return session.execute(select(User).where(User.id == user_id))\n',
      'app/service.py': 'from .repository import fetch_user as load_one\n\ndef hydrate_one(user_id):\n    return load_one(user_id)\n',
      'app/controller.py': 'from .service import hydrate_one\n\ndef hydrate(ids):\n    for user_id in ids:\n        hydrate_one(user_id)\n'
    }, 'app/controller.py');
    const finding = result.find(item => item.ruleId === 'code/synchronous-query-loop');

    expect(finding?.confidence).toBe('MEDIUM');
    expect(finding?.metadata?.pattern).toBe('cross-file-database');
    expect(finding?.metadata?.callPath).toContain('app/repository.py:fetch_user -> database');
  });

  it('resolves parenthesized multiline Python imports', () => {
    const result = findings({
      'app/repository.py': 'def fetch_user(user_id):\n    return session.execute(select(User).where(User.id == user_id))\n',
      'app/service.py': 'from .repository import (\n    fetch_user as load_one,\n)\n\ndef hydrate(ids):\n    for user_id in ids:\n        load_one(user_id)\n'
    }, 'app/service.py');

    expect(result.some(item => item.ruleId === 'code/synchronous-query-loop')).toBe(true);
  });

  it('traces imported Python functions through wrapper aliases', () => {
    const result = findings({
      'app/repository.py': 'def fetch_user(user_id):\n    return session.execute(select(User).where(User.id == user_id))\n',
      'app/service.py': 'from .repository import fetch_user\nload_one = retry(fetch_user)\n\ndef hydrate(ids):\n    for user_id in ids:\n        load_one(user_id)\n'
    }, 'app/service.py');

    expect(result.some(item => item.ruleId === 'code/synchronous-query-loop')).toBe(true);
  });

  it('upgrades cross-file Python gather to database-specific evidence', () => {
    const result = findings({
      'app/repository.py': 'async def fetch_user(user_id):\n    return await db.execute(select(User).where(User.id == user_id))\n',
      'app/service.py': 'from .repository import fetch_user\n\nasync def hydrate(ids):\n    return await asyncio.gather(*(fetch_user(user_id) for user_id in ids))\n'
    }, 'app/service.py');
    const rules = result.map(item => item.ruleId);

    expect(rules).toContain('code/unbounded-query-fanout');
    expect(rules).not.toContain('code/unbounded-async-fanout');
  });

  it('resolves absolute Python modules, namespaces, and imported class instances', () => {
    const result = findings({
      'app/repository.py': 'class UserRepository:\n    def find(self, user_id):\n        return session.execute(select(User).where(User.id == user_id))\n\ndef fetch_user(user_id):\n    return session.execute(select(User).where(User.id == user_id))\n',
      'app/service.py': 'import app.repository as users\nfrom app.repository import UserRepository\nrepository = UserRepository()\n\ndef hydrate_namespace(ids):\n    for user_id in ids:\n        users.fetch_user(user_id)\n\ndef hydrate_instance(ids):\n    for user_id in ids:\n        repository.find(user_id)\n'
    }, 'app/service.py');

    expect(result.filter(item => item.ruleId === 'code/synchronous-query-loop')).toHaveLength(2);
  });

  it('resolves Python constructor-injected repositories with type evidence', () => {
    const result = findings({
      'app/repository.py': 'class UserRepository:\n    def find(self, user_id):\n        return session.execute(select(User).where(User.id == user_id))\n',
      'app/service.py': 'from app.repository import UserRepository\n\nclass UserService:\n    def __init__(self, users: UserRepository):\n        self.users = users\n\n    def hydrate(self, ids):\n        for user_id in ids:\n            self.users.find(user_id)\n'
    }, 'app/service.py');
    const finding = result.find(item => item.ruleId === 'code/synchronous-query-loop');

    expect(finding?.metadata?.callPath).toContain('app/repository.py:find -> database');
  });

  it('does not invent database reachability for harmless imports or import cycles', () => {
    const result = findings({
      'src/a.ts': "import { normalizeB } from './b';\nexport function normalizeA(value) { return normalizeB(value); }",
      'src/b.ts': "import { normalizeA } from './a';\nexport function normalizeB(value) { return value ? value.trim() : normalizeA(''); }",
      'src/service.ts': "import { normalizeA } from './a';\nexport function hydrate(items) { for (const item of items) normalizeA(item); }"
    }, 'src/service.ts');

    expect(result.some(item => item.ruleId === 'code/query-in-loop')).toBe(false);
  });

  it('preserves the cross-file call path in every review output', () => {
    const report = scanProject(project({
      'src/repository.ts': 'export async function fetchUser(id) { return prisma.user.findUnique({ where: { id } }); }',
      'src/service.ts': "import { fetchUser } from './repository';\nexport async function hydrate(ids) { for (const id of ids) await fetchUser(id); }"
    }), 'test');

    expect(formatPretty(report)).toContain('Call path: src/repository.ts:fetchUser -> database');
    expect(formatMarkdown(report)).toContain('**Call path:**');
    expect(JSON.stringify(toSarif(report))).toContain('src/repository.ts:fetchUser -> database');
  });
});
