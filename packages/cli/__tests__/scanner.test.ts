import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMigration, evaluateBudgets, toSarif } from '../src/formatters.js';
import { scanProject } from '../src/scanner.js';

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
  it('produces evidence-backed findings and SQL from the inspected fixture', () => {
    const report = scanProject(fixture(), 'test');

    expect(report.findings.map(item => item.ruleId)).toEqual(expect.arrayContaining([
      'code/sequential-async-loop',
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
    fs.writeFileSync(path.join(directory, '.env.example'), 'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app\n');
    const productionUri = ['DATABASE_URL=postgresql://service:', 'real-credential', '@db.example.net:5432/app\n'].join('');
    fs.writeFileSync(path.join(directory, '.env.production'), productionUri);

    const report = scanProject(directory, 'test');
    const uris = report.findings.filter(item => item.ruleId === 'secret/database-uri');

    expect(uris).toHaveLength(1);
    expect(uris[0]?.file).toBe('.env.production');
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

  it('reports one finding per sequential loop and lowers maintenance scripts to medium', () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, 'verificar-dados.ts'), `for (const item of items) {
  await prisma.item.findUnique({ where: { id: item.id } });
  await prisma.audit.create({ data: { itemId: item.id } });
}`);

    const report = scanProject(directory, 'test');
    const findings = report.findings.filter(item => item.file === 'verificar-dados.ts' && item.ruleId === 'code/sequential-async-loop');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('MEDIUM');
  });
});
