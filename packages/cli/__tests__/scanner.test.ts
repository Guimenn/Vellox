import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMigration, evaluateBudgets, formatMarkdown, formatPretty, toSarif } from '../src/formatters.js';
import { analyzeSqlQuery, scanProject } from '../src/scanner.js';

const temporaryDirectories: string[] = [];

function fixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vellox-test-'));
  temporaryDirectories.push(directory);
  fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'fixture',
    dependencies: { '@prisma/client': '^6.0.0' }
  }));
  fs.writeFileSync(path.join(directory, 'src', 'orders.ts'), `export async function load(orders) {
  for (const order of orders) {
    await prisma.item.findMany({ where: { orderId: order.id } });
  }
}
const query = "SELECT * FROM orders WHERE status LIKE '%pending'";
`);
  fs.writeFileSync(path.join(directory, 'prisma', 'schema.prisma'), `datasource db {
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
  return directory;
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true }));
});

describe('Vellox project scanner contract', () => {
  it('reports oversized files instead of silently counting them as inspected', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'oversized.ts'), `// ${'x'.repeat(2_000_001)}`);

    expect(() => scanProject(directory, 'test', { maxFileBytes: 0 })).toThrow('positive integer');

    const report = scanProject(directory, 'test');
    const issue = report.coverage?.issues.find(item => item.file === 'src/oversized.ts');

    expect(report.coverage?.complete).toBe(false);
    expect(report.coverage?.filesDiscovered).toBe(report.summary.filesScanned + 1);
    expect(report.coverage?.filesSkipped).toBe(1);
    expect(issue).toMatchObject({ reason: 'file-too-large', limitBytes: 2_000_000 });
    expect(formatPretty(report)).toContain('src/oversized.ts: file-too-large');
    expect(formatMarkdown(report)).toContain('Analysis coverage');
    expect(JSON.stringify(toSarif(report))).toContain('file-too-large');
  });

  it('exposes parser fallback and lets CI reject incomplete analysis', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'broken.ts'), 'export function broken( {');
    fs.writeFileSync(path.join(directory, 'src', 'async_generator.py'), 'async def lifespan():\n    yield\n    cleanup()\n');

    const report = scanProject(directory, 'test');
    const evaluation = evaluateBudgets(report, {
      maxCritical: Number.MAX_SAFE_INTEGER,
      maxHigh: Number.MAX_SAFE_INTEGER,
      maxTotal: null,
      failOnSecrets: false,
      failOnIncompleteAnalysis: true
    });

    expect(report.coverage?.fallbackFiles).toBe(1);
    expect(report.coverage?.issues).toContainEqual({ file: 'src/broken.ts', reason: 'parse-fallback', line: 1, parser: 'babel' });
    expect(report.coverage?.issues.some(item => item.file === 'src/async_generator.py')).toBe(false);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.violations[0]).toContain('failOnIncompleteAnalysis=true');
  });

  it('exposes SQL parser fallback with a precise location', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'broken.sql'), "SELECT * FROM users WHERE email = 'broken");

    const report = scanProject(directory, 'test');
    const issue = report.coverage?.issues.find(item => item.file === 'broken.sql');

    expect(issue).toMatchObject({ reason: 'parse-fallback', line: 1, parser: 'vellox-sql-ast', message: 'Unterminated string literal' });
    expect(report.coverage).toMatchObject({ complete: false, sqlStatements: 1, sqlAstStatements: 0 });
    expect(report.findings.some(item => item.file === 'broken.sql' && item.ruleId === 'query/select-star')).toBe(true);
  });

  it('produces evidence-backed findings and SQL from the inspected fixture', () => {
    const report = scanProject(fixture(), 'test');

    expect(report.findings.map(item => item.ruleId)).toEqual(expect.arrayContaining([
      'code/query-in-loop',
      'prisma/missing-relation-index',
      'query/leading-wildcard',
      'query/select-star',
      'query/unbounded-select'
    ]));
    expect(report.summary.reviewableSqlFixes).toBe(1);
    expect(report.findings.find(item => item.ruleId === 'prisma/missing-relation-index')?.sql)
      .toContain('"Item" ("orderId")');
  });

  it('builds migrations exclusively from SQL attached to actual findings', () => {
    const report = scanProject(fixture(), 'test');
    const migration = buildMigration(report);

    expect(migration).toContain('idx_item_orderid');
    expect(migration).not.toContain('idx_products_category_instock');
    expect(migration).not.toContain('idx_users_tenant_email');
  });

  it('evaluates only new fingerprints when a baseline is supplied', () => {
    const baseline = scanProject(fixture(), 'test');
    const current = { ...baseline, findings: [...baseline.findings] };
    const evaluation = evaluateBudgets(current, {
      maxCritical: 0,
      maxHigh: 0,
      maxTotal: 0,
      failOnSecrets: true
    }, baseline);

    expect(evaluation.passed).toBe(true);
    expect(evaluation.evaluatedFindings).toHaveLength(0);
  });

  it('keeps baseline fingerprints stable when unrelated lines move a finding', () => {
    const directory = fixture();
    const baseline = scanProject(directory, 'test');
    const originalLoop = baseline.findings.find(item => item.ruleId === 'code/query-in-loop');
    const sourcePath = path.join(directory, 'src', 'orders.ts');
    fs.writeFileSync(sourcePath, `// unrelated header\n\n${fs.readFileSync(sourcePath, 'utf8')}`);

    const current = scanProject(directory, 'test');
    const movedLoop = current.findings.find(item => item.ruleId === 'code/query-in-loop');
    const evaluation = evaluateBudgets(current, {
      maxCritical: 0,
      maxHigh: 0,
      maxTotal: 0,
      failOnSecrets: true
    }, baseline);

    expect(evaluation.evaluatedFindings).toHaveLength(0);
    expect(movedLoop?.line).toBe(5);
    expect(movedLoop?.fingerprint).toBe(originalLoop?.fingerprint);

    const legacyBaseline = {
      ...baseline,
      findings: baseline.findings.map((item, index) => ({
        ...item,
        ruleId: item.ruleId === 'code/query-in-loop' ? 'code/sequential-async-loop' : item.ruleId,
        fingerprint: `legacy-${index}-${item.line}`
      }))
    };
    expect(evaluateBudgets(current, {
      maxCritical: 0,
      maxHigh: 0,
      maxTotal: 0,
      failOnSecrets: true
    }, legacyBaseline).evaluatedFindings).toHaveLength(0);
  });

  it('emits SARIF locations and stable fingerprints', () => {
    const report = scanProject(fixture(), 'test');
    const sarif = toSarif(report) as { runs: Array<{ results: Array<Record<string, unknown>> }> };

    expect(sarif.runs[0]?.results).toHaveLength(report.findings.length);
    expect(JSON.stringify(sarif)).toContain('velloxFingerprint');
    expect(JSON.stringify(sarif)).toContain('src/orders.ts');
  });

  it('finds and redacts supported credentials in environment files', () => {
    const directory = fixture();
    const secret = ['sk-proj-', 'abcdefghijklmnopqrstuvwx123456'].join('');
    fs.writeFileSync(path.join(directory, '.env.production'), `OPENAI_API_KEY=${secret}\n`);

    const report = scanProject(directory, 'test');
    const finding = report.findings.find(item => item.ruleId === 'secret/openai-api-key');

    expect(finding).toBeDefined();
    expect(finding?.evidence).not.toContain(secret);
    expect(finding?.evidence).toContain('…');
  });

  it('generates dialect-aware identifier quoting for MySQL schemas', () => {
    const directory = fixture();
    const schemaPath = path.join(directory, 'prisma', 'schema.prisma');
    fs.writeFileSync(schemaPath, fs.readFileSync(schemaPath, 'utf8').replace('provider = "postgresql"', 'provider = "mysql"'));

    const report = scanProject(directory, 'test');
    const sql = report.findings.find(item => item.ruleId === 'prisma/missing-relation-index')?.sql;

    expect(sql).toContain('ON `Item` (`orderId`)');
    expect(sql).not.toContain('IF NOT EXISTS');
  });

  it('reads the Prisma datasource provider instead of the generator provider', () => {
    const directory = fixture();
    const schemaPath = path.join(directory, 'prisma', 'schema.prisma');
    fs.writeFileSync(schemaPath, `generator client {
  provider = "prisma-client-js"
}
${fs.readFileSync(schemaPath, 'utf8')}`);

    const report = scanProject(directory, 'test');
    const sql = report.findings.find(item => item.ruleId === 'prisma/missing-relation-index')?.sql;

    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
  });

  it('ignores compiled Python files and cache directories', () => {
    const directory = fixture();
    const fakeKey = ['sk-proj-', 'abcdefghijklmnopqrstuvwx123456'].join('');
    fs.writeFileSync(path.join(directory, 'src', 'module.pyc'), fakeKey);
    fs.mkdirSync(path.join(directory, '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(directory, '__pycache__', 'module.py'), fakeKey);

    const report = scanProject(directory, 'test');

    expect(report.findings.some(item => item.file?.includes('module.pyc'))).toBe(false);
    expect(report.findings.some(item => item.file?.includes('__pycache__'))).toBe(false);
  });

  it('does not flag retries, cursor pagination, or explicitly serialized loops', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'intentional.ts'), `export async function retry() {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    await fetch('/health');
  }
  let hasMore = true;
  while (hasMore) {
    const response = await client.list({ cursor });
    hasMore = response.hasMore;
  }
  // One at a time because the upstream API returns 502 under parallel load.
  for (const item of items) {
    await client.send(item);
  }
}`);

    const report = scanProject(directory, 'test');

    expect(report.findings.some(item => item.file === 'src/intentional.ts' && item.ruleId === 'code/sequential-async-loop')).toBe(false);
  });

  it('requires an embedded payload before reporting a private key', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'pem.ts'), "return `-----BEGIN PRIVATE KEY-----\\n${wrapped}\\n-----END PRIVATE KEY-----`;\n");
    fs.writeFileSync(path.join(directory, 'actual.pem.env'), `KEY=-----BEGIN PRIVATE KEY-----
${'A'.repeat(80)}
-----END PRIVATE KEY-----`);

    const report = scanProject(directory, 'test');
    const keys = report.findings.filter(item => item.ruleId === 'secret/private-key');

    expect(keys).toHaveLength(1);
    expect(keys[0]?.file).toBe('actual.pem.env');
  });

  it('ignores local placeholder database URIs but reports non-placeholder credentials', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, '.env.example'), [
      'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app',
      'PORTUGUESE_DATABASE_URL=postgresql://usuario:senha@localhost:5432/app',
      'TEMPLATE_DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@db.example.com:5432/app'
    ].join('\n'));
    const productionUri = ['DATABASE_URL=postgresql://service:', 'real-credential', '@db.example.net:5432/app\n'].join('');
    const localRealCredential = ['LOCAL_DATABASE_URL=postgresql://postgres:', 'actual-credential-value', '@localhost:5432/app\n'].join('');
    fs.writeFileSync(path.join(directory, '.env.production'), productionUri);
    fs.writeFileSync(path.join(directory, '.env.local-real'), localRealCredential);

    const report = scanProject(directory, 'test');
    const uris = report.findings.filter(item => item.ruleId === 'secret/database-uri');

    expect(uris).toHaveLength(2);
    expect(uris.map(item => item.file).sort()).toEqual(['.env.local-real', '.env.production']);
  });

  it('does not mislabel bounded Promise.all work as sequential execution', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'parallel.ts'), `export async function load(ids) {
  await Promise.all(ids.slice(0, 10).map(async id => {
    return db.query('SELECT id FROM users WHERE id = $1', [id]);
  }));
}
`);

    const report = scanProject(directory, 'test');
    const parallelFinding = report.findings.find(item => item.file === 'src/parallel.ts' && item.ruleId === 'code/sequential-async-loop');

    expect(parallelFinding).toBeUndefined();
  });

  it('detects discarded promises, unbounded fan-out, and event-loop blocking in JavaScript', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'async-hotspots.ts'), `import { readFileSync } from 'node:fs';
export async function processAll(items) {
  items.forEach(async item => {
    await save(item);
  });
  items.map(async item => save(item));
  await Promise.all(items.map(async item => save(item)));
  return readFileSync('/tmp/result.json', 'utf8');
}
`);

    const report = scanProject(directory, 'test');
    const rules = report.findings.filter(item => item.file === 'src/async-hotspots.ts').map(item => item.ruleId);

    expect(rules).toEqual(expect.arrayContaining([
      'code/async-foreach',
      'code/dangling-async-map',
      'code/unbounded-async-fanout',
      'code/blocking-call-in-async'
    ]));
  });

  it('detects quadratic work and repeated linear scans in JavaScript and Python', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'complexity.ts'), `export function correlate(orders, users, scores) {
  for (const order of orders) {
    for (const user of users) consume(order, user);
    users.find(user => user.id === order.userId);
    scores.sort((a, b) => b - a);
  }
}
`);
    fs.writeFileSync(path.join(directory, 'src', 'complexity.py'), `def correlate(orders, users, scores):
    for order in orders:
        for user in users:
            consume(order, user)
        if order.user_id in user_ids:
            consume(order)
        sorted(scores)
`);

    const report = scanProject(directory, 'test');
    for (const file of ['src/complexity.ts', 'src/complexity.py']) {
      const rules = report.findings.filter(item => item.file === file).map(item => item.ruleId);
      expect(rules).toEqual(expect.arrayContaining([
        'code/quadratic-nested-iteration',
        'code/linear-search-in-loop',
        'code/repeated-sort-in-loop'
      ]));
    }
  });

  it('reports conservative complexity and only claims iteration bounds proven by syntax', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'bounded-cost.ts'), `export async function hydrate(ids) {
  for (const id of ids.slice(0, 12)) await prisma.user.findUnique({ where: { id } });
}
`);
    fs.writeFileSync(path.join(directory, 'src', 'bounded_cost.py'), `def hydrate(ids):
    for user_id in ids[:8]:
        session.execute(select(User).where(User.id == user_id))
`);
    fs.writeFileSync(path.join(directory, 'src', 'guarded-cost.ts'), `export async function hydrate(ids) {
  if (ids.length > 25) throw new Error('too many ids');
  for (const id of ids) await prisma.user.findUnique({ where: { id } });
}
`);
    fs.writeFileSync(path.join(directory, 'src', 'guarded_cost.py'), `def hydrate(ids):
    if len(ids) >= 31:
        raise ValueError('too many ids')
    for user_id in ids:
        session.execute(select(User).where(User.id == user_id))
`);
    fs.writeFileSync(path.join(directory, 'src', 'large-bound.ts'), `export async function hydrate(ids) {
  const selected = ids.slice(0, 1000);
  for (const id of selected) await prisma.user.findUnique({ where: { id } });
}
`);
    fs.writeFileSync(path.join(directory, 'src', 'large-fanout.ts'), `export async function hydrate(ids) {
  const selected = ids.slice(0, 1000);
  return Promise.all(selected.map(id => prisma.user.findUnique({ where: { id } })));
}
`);
    fs.writeFileSync(path.join(directory, 'src', 'exact-bounds.ts'), `export async function fixed() {
  for (const id of Array.from({ length: 20 })) await prisma.user.findUnique({ where: { id } });
}
export async function sliced(ids) {
  for (const id of ids.slice(10, 20)) await prisma.user.findUnique({ where: { id } });
}
`);
    fs.writeFileSync(path.join(directory, 'src', 'exact_bounds.py'), `def fixed():
    for user_id in range(10, 20, 2):
        session.execute(select(User).where(User.id == user_id))

def reverse():
    for user_id in range(20, 10, -2):
        session.execute(select(User).where(User.id == user_id))
`);

    const report = scanProject(directory, 'test');
    const javascript = report.findings.find(item => item.file === 'src/bounded-cost.ts' && item.ruleId === 'code/query-in-loop');
    const python = report.findings.find(item => item.file === 'src/bounded_cost.py' && item.ruleId === 'code/synchronous-query-loop');
    const unbounded = report.findings.find(item => item.file === 'src/orders.ts' && item.ruleId === 'code/query-in-loop');
    const guardedJavaScript = report.findings.find(item => item.file === 'src/guarded-cost.ts' && item.ruleId === 'code/query-in-loop');
    const guardedPython = report.findings.find(item => item.file === 'src/guarded_cost.py' && item.ruleId === 'code/synchronous-query-loop');
    const largeBound = report.findings.find(item => item.file === 'src/large-bound.ts' && item.ruleId === 'code/query-in-loop');
    const largeFanout = report.findings.find(item => item.file === 'src/large-fanout.ts' && item.ruleId === 'code/unbounded-query-fanout');
    const exactJavaScript = report.findings.filter(item => item.file === 'src/exact-bounds.ts' && item.ruleId === 'code/query-in-loop');
    const exactPython = report.findings.filter(item => item.file === 'src/exact_bounds.py' && item.ruleId === 'code/synchronous-query-loop');

    expect(javascript).toMatchObject({ severity: 'MEDIUM', metadata: { complexity: 'O(n)', iterationBound: 12, operationsPerIteration: 1 } });
    expect(python).toMatchObject({ severity: 'MEDIUM', metadata: { complexity: 'O(n)', iterationBound: 8, operationsPerIteration: 1 } });
    expect(unbounded?.metadata?.iterationBound).toBe('input-dependent');
    expect(guardedJavaScript).toMatchObject({ severity: 'MEDIUM', metadata: { iterationBound: 25 } });
    expect(guardedPython).toMatchObject({ severity: 'MEDIUM', metadata: { iterationBound: 30 } });
    expect(largeBound).toMatchObject({ severity: 'HIGH', metadata: { iterationBound: 1000 } });
    expect(largeFanout?.metadata?.taskUpperBound).toBe(1000);
    expect(exactJavaScript.map(item => item.metadata?.iterationBound)).toEqual([20, 10]);
    expect(exactPython.map(item => item.metadata?.iterationBound)).toEqual([5, 5]);
    expect(formatPretty(report)).toContain('at most 12 (statically proven)');
  });

  it('does not label indexed lookups or statically bounded loops as quadratic', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'indexed.ts'), `export function correlate(orders, usersById, allowedIds) {
  for (const order of orders) {
    usersById.get(order.userId);
    allowedIds.has(order.userId);
  }
  for (let row = 0; row < 10; row++) {
    for (let column = 0; column < 10; column++) consume(row, column);
  }
}
`);
    fs.writeFileSync(path.join(directory, 'src', 'indexed.py'), `def correlate(orders, users_by_id, allowed_ids_set):
    for order in orders:
        users_by_id.get(order.user_id)
        if order.user_id in allowed_ids_set:
            consume(order)
    for row in range(10):
        for column in range(10):
            consume(row, column)
`);

    const findings = scanProject(directory, 'test').findings.filter(item => item.file === 'src/indexed.ts' || item.file === 'src/indexed.py');
    expect(findings.filter(item => item.ruleId.startsWith('code/quadratic') || item.ruleId === 'code/linear-search-in-loop')).toHaveLength(0);
  });

  it('finds unbounded ORM reads and recognizes explicit limits', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'orm.ts'), `export async function load() {
  const allUsers = await prisma.user.findMany({ where: { active: true } });
  const page = await prisma.user.findMany({ take: 100, where: { active: true } });
  const allEvents = await Event.find({ active: true });
  const eventPage = await Event.find({ active: true }).limit(100);
  return { allUsers, page, allEvents, eventPage };
}
`);
    fs.writeFileSync(path.join(directory, 'src', 'orm.py'), `async def load(session):
    all_users = session.query(User).all()
    page = session.query(User).limit(100).all()
    all_events = await session.execute(select(Event))
    event_page = await session.execute(select(Event).limit(100))
    return all_users, page, all_events, event_page
`);

    const findings = scanProject(directory, 'test').findings.filter(item => item.ruleId === 'query/unbounded-orm-read');
    expect(findings.filter(item => item.file === 'src/orm.ts')).toHaveLength(2);
    expect(findings.filter(item => item.file === 'src/orm.py')).toHaveLength(2);
    expect(findings.every(item => item.confidence === 'MEDIUM')).toBe(true);
  });

  it('uses only top-level ORM bounds and recognizes direct unique ID filters', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'orm-bounds.ts'), `export async function load(storeId) {
  const byId = await prisma.store.findMany({ where: { id: storeId } });
  const nestedLimit = await prisma.task.findMany({
    select: { executions: { take: 1 } },
    orderBy: { createdAt: 'asc' }
  });
  // @vellox-ignore — the store catalog is intentionally bounded by the business domain.
  const reviewedCatalog = await prisma.store.findMany({ orderBy: { name: 'asc' } });
  return { byId, nestedLimit, reviewedCatalog };
}
`);

    const findings = scanProject(directory, 'test').findings
      .filter(item => item.file === 'src/orm-bounds.ts' && item.ruleId === 'query/unbounded-orm-read');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(3);
  });

  it('honors gitignore, velloxignore, config exclusions, and rule overrides', () => {
    const directory = fixture();
    for (const folder of ['ignored-git', 'ignored-vellox', 'ignored-config']) fs.mkdirSync(path.join(directory, folder));
    const risky = 'async function load() { return prisma.user.findMany(); }\n';
    fs.writeFileSync(path.join(directory, 'ignored-git', 'risk.ts'), risky);
    fs.writeFileSync(path.join(directory, 'ignored-vellox', 'risk.ts'), risky);
    fs.writeFileSync(path.join(directory, 'ignored-config', 'risk.ts'), risky);
    fs.writeFileSync(path.join(directory, '.gitignore'), 'ignored-git/\n');
    fs.writeFileSync(path.join(directory, '.velloxignore'), 'ignored-vellox/\n');
    fs.writeFileSync(path.join(directory, 'src', 'configured.ts'), `async function load() {
  const users = await prisma.user.findMany();
  for (const item of items) scores.sort();
  return users;
}
`);
    fs.writeFileSync(path.join(directory, 'vellox.config.json'), JSON.stringify({
      ignore: ['ignored-config/'],
      rules: {
        'code/repeated-sort-in-loop': false,
        'query/unbounded-orm-read': 'MEDIUM'
      },
      budgets: { maxCritical: 0, maxHigh: 0, maxTotal: null, failOnSecrets: true }
    }));

    const report = scanProject(directory, 'test');
    expect(report.findings.some(item => item.file?.startsWith('ignored-'))).toBe(false);
    expect(report.findings.some(item => item.ruleId === 'code/repeated-sort-in-loop')).toBe(false);
    expect(report.findings.find(item => item.file === 'src/configured.ts' && item.ruleId === 'query/unbounded-orm-read')?.severity).toBe('MEDIUM');
  });

  it('does not warn on paced polling, explicit batches, or concurrency limiters', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'controlled.ts'), `async function poll() {
  while (running) {
    await fetchStatus();
    await delay(1000);
  }
  for (const batch of batches) {
    await Promise.all(batch.map(processItem));
  }
  await Promise.all(items.map(item => limit(() => processItem(item))));
  // @vellox-ignore — static build manifest with a reviewed maximum size.
  await Promise.all(assets.map(loadAsset));
}
`);
    fs.writeFileSync(path.join(directory, 'src', 'controlled.py'), `import asyncio

async def poll():
    while running:
        await fetch_status()
        await asyncio.sleep(1)
`);

    const report = scanProject(directory, 'test');

    expect(report.findings.some(item => item.file === 'src/controlled.ts' || item.file === 'src/controlled.py')).toBe(false);
  });

  it('detects Python async fan-out, blocking I/O, and sequential awaits structurally', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'async_hotspots.py'), `import asyncio
import requests

async def process_all(items):
    requests.get("https://example.test/data")
    await asyncio.gather(*(save(item) for item in items))
    for item in items:
        await client.fetch(item)
`);

    const report = scanProject(directory, 'test');
    const findings = report.findings.filter(item => item.file === 'src/async_hotspots.py');

    expect(findings.map(item => item.ruleId)).toEqual(expect.arrayContaining([
      'code/blocking-call-in-async',
      'code/unbounded-async-fanout',
      'code/sequential-async-loop'
    ]));
    expect(findings.every(item => item.metadata?.parser === 'lezer-python')).toBe(true);
  });

  it('falls back to conservative line analysis for incomplete Python syntax', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'incomplete.py'), `def incomplete(:
    for item in items:
        normalized = str(item)
        session.execute(query)
`);

    const report = scanProject(directory, 'test');
    const finding = report.findings.find(item => item.file === 'src/incomplete.py');

    expect(finding?.ruleId).toBe('code/synchronous-query-loop');
    expect(finding?.metadata?.kind).toBe('python-loop');
  });

  it('prioritizes repeated transaction boundaries over generic loop warnings', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'transactions.py'), `def persist(items, session):
    for item in items:
        session.add(item)
        session.commit()
`);

    const report = scanProject(directory, 'test');
    const findings = report.findings.filter(item => item.file === 'src/transactions.py');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('code/transaction-in-loop');
    expect(findings[0]?.line).toBe(4);
  });

  it('reports one finding per sequential loop and lowers maintenance scripts to medium', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'verificar-dados.ts'), `for (const item of items) {
  await prisma.item.findUnique({ where: { id: item.id } });
  await prisma.audit.create({ data: { itemId: item.id } });
}`);

    const report = scanProject(directory, 'test');
    const findings = report.findings.filter(item => item.file === 'verificar-dados.ts' && item.ruleId === 'code/query-in-loop');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('MEDIUM');
  });

  it('keeps identical findings in separate loops distinct and baseline-stable', () => {
    const directory = fixture();
    const sourcePath = path.join(directory, 'src', 'duplicates.ts');
    fs.writeFileSync(sourcePath, `export async function first(items) {
  for (const item of items) {
    await db.query(item);
  }
}
export async function second(items) {
  for (const item of items) {
    await db.query(item);
  }
}
`);
    const baseline = scanProject(directory, 'test');
    fs.writeFileSync(sourcePath, `// line shift\n${fs.readFileSync(sourcePath, 'utf8')}`);
    const current = scanProject(directory, 'test');
    const before = baseline.findings.filter(item => item.file === 'src/duplicates.ts');
    const after = current.findings.filter(item => item.file === 'src/duplicates.ts');

    expect(before).toHaveLength(2);
    expect(new Set(before.map(item => item.fingerprint))).toEqual(new Set(after.map(item => item.fingerprint)));
    expect(evaluateBudgets(current, {
      maxCritical: 0,
      maxHigh: 0,
      maxTotal: 0,
      failOnSecrets: true
    }, baseline).evaluatedFindings).toHaveLength(0);
  });

  it('analyzes plain and multiline SQL files instead of requiring string literals', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'queries.sql'), `-- production lookup
SELECT *
FROM users
WHERE email LIKE '%@example.com' AND note = '--keep this literal';

WITH active AS (
  SELECT id FROM accounts WHERE enabled = true
)
SELECT * FROM active;

CREATE FUNCTION audit_rows() RETURNS SETOF users AS $$
BEGIN
  RETURN QUERY SELECT * FROM users;
END;
$$ LANGUAGE plpgsql;
`);

    const report = scanProject(directory, 'test');
    const queryFindings = report.findings.filter(item => item.file === 'queries.sql');
    const rules = queryFindings.map(item => item.ruleId);

    expect(rules).toEqual(expect.arrayContaining([
      'query/select-star',
      'query/leading-wildcard',
      'query/unbounded-select'
    ]));
    expect(queryFindings.some(item => item.evidence.includes('--keep this literal'))).toBe(true);
    expect(queryFindings.some(item => item.evidence.includes('audit_rows'))).toBe(false);
  });

  it('understands top-level SQL bounds instead of flagging unique lookups', () => {
    const uniqueLookup = analyzeSqlQuery('SELECT * FROM users WHERE id = $1');
    const paginated = analyzeSqlQuery('SELECT id FROM users ORDER BY id LIMIT ?');
    const count = analyzeSqlQuery('SELECT COUNT(*) FROM users');

    expect(uniqueLookup.map(item => item.ruleId)).toContain('query/select-star');
    expect(uniqueLookup.map(item => item.ruleId)).not.toContain('query/unbounded-select');
    expect(uniqueLookup.map(item => item.ruleId)).not.toContain('query/missing-filter');
    expect(paginated).toHaveLength(0);
    expect(count).toHaveLength(0);
  });

  it('finds expensive join, deduplication, and full-table write patterns', () => {
    const joinQuery = analyzeSqlQuery(`SELECT DISTINCT a.id
FROM accounts a
JOIN users u ON u.account_id = a.id
JOIN orders o ON o.user_id = u.id
JOIN payments p ON p.order_id = o.id
JOIN refunds r ON r.payment_id = p.id
JOIN events e ON e.account_id = a.id
GROUP BY a.id
UNION SELECT id FROM archived_accounts`);
    const write = analyzeSqlQuery('UPDATE users SET enabled = false');
    const rules = joinQuery.map(item => item.ruleId);

    expect(rules).toEqual(expect.arrayContaining([
      'query/excessive-joins',
      'query/union-deduplication',
      'query/redundant-distinct'
    ]));
    expect(write.map(item => item.ruleId)).toContain('query/unbounded-write');
  });

  it('detects dynamic SQL construction in JavaScript and Python database calls', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'dynamic.ts'), 'export async function load(id) { return db.query(`SELECT * FROM users WHERE id = ${id}`); }\n');
    fs.writeFileSync(path.join(directory, 'src', 'dynamic.py'), 'def load(user_id, session):\n    return session.execute(f"SELECT * FROM users WHERE id = {user_id}")\n');

    const report = scanProject(directory, 'test');
    const dynamic = report.findings.filter(item => item.ruleId === 'query/dynamic-sql-construction');

    expect(dynamic.map(item => item.file)).toEqual(expect.arrayContaining(['src/dynamic.ts', 'src/dynamic.py']));
  });

  it('detects synchronous Python database calls after intermediate loop work', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'src', 'sync.py'), `def load_users(ids, session):
    for user_id in ids:
        normalized = str(user_id)
        row = session.execute(select(User).where(User.id == normalized))
        consume(row)
    session.execute(select(Audit))
`);

    const report = scanProject(directory, 'test');
    const findings = report.findings.filter(item => item.file === 'src/sync.py' && item.ruleId === 'code/synchronous-query-loop');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(4);
    expect(findings[0]?.metadata?.loopStart).toBe(2);
  });

  it('does not turn assertion loops in test files into production hotspots', () => {
    const directory = fixture();
    fs.mkdirSync(path.join(directory, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'tests', 'test_models.py'), `def test_empty(models, db):
    for model in models:
        assert db.scalar(select(func.count()).select_from(model)) == 0
`);

    const report = scanProject(directory, 'test');

    expect(report.findings.some(item => item.file === 'tests/test_models.py' && item.ruleId === 'code/synchronous-query-loop')).toBe(false);
  });

  it('finds reviewable Docker, Kubernetes, and Terraform configuration risks', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'Dockerfile'), 'FROM node:latest\nRUN node --version\n');
    fs.writeFileSync(path.join(directory, 'deployment.yaml'), `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      hostNetwork: true
      containers:
        - name: api
          image: example/api:latest
`);
    fs.writeFileSync(path.join(directory, 'main.tf'), `resource "aws_db_instance" "main" {
  publicly_accessible = true
}
resource "aws_security_group" "api" {
  ingress {
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`);

    const report = scanProject(directory, 'test');
    const rules = report.findings.filter(item => item.category === 'infrastructure').map(item => item.ruleId);

    expect(rules).toEqual(expect.arrayContaining([
      'infra/container-floating-base-image',
      'infra/container-root-user',
      'infra/kubernetes-missing-resources',
      'infra/container-floating-image',
      'infra/privileged-workload',
      'infra/terraform-public-database',
      'infra/terraform-public-ingress'
    ]));
    expect(report.summary.infrastructure).toBe(rules.length);
  });

  it('does not flag pinned least-privilege container manifests with complete resources', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'Dockerfile'), 'FROM node:22.12.0@sha256:abcdef\nUSER 10001\n');
    fs.writeFileSync(path.join(directory, 'deployment.yaml'), `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api
          image: example/api@sha256:abcdef
          resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { cpu: 500m, memory: 512Mi } }
`);

    const report = scanProject(directory, 'test');

    expect(report.findings.some(item => item.category === 'infrastructure')).toBe(false);
  });

  it('evaluates the effective user in the final Docker stage', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'Dockerfile'), `FROM node:22.12.0 AS build
USER node
RUN npm run build
FROM node:22.12.0
USER root
COPY --from=build /app /app
`);

    const report = scanProject(directory, 'test');
    const finding = report.findings.find(item => item.ruleId === 'infra/container-root-user');

    expect(finding?.line).toBe(5);
    expect(finding?.evidence).toContain('root');
  });

  it('requires CPU and memory in both Kubernetes requests and limits', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'deployment.yaml'), `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: api
          image: example/api:1.2.3
          resources:
            requests:
              cpu: 100m
            limits:
              memory: 512Mi
`);

    const report = scanProject(directory, 'test');
    const finding = report.findings.find(item => item.ruleId === 'infra/kubernetes-partial-resources');

    expect(finding?.evidence).toContain('requests.memory');
    expect(finding?.evidence).toContain('limits.cpu');
    expect(finding?.metadata?.missing).toBe('requests.memory,limits.cpu');
  });
});
