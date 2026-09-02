import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Severity, VelloxFinding, VelloxReport } from './types.js';

const IGNORED_DIRECTORIES = new Set([
  '.git', '.next', '.nuxt', '.output', '.turbo', '.vellox',
  'build', 'coverage', 'dist', 'node_modules', 'vendor'
]);
const SOURCE_FILE = /(?:\.(?:cjs|env|js|json|jsx|mjs|prisma|py|sql|toml|ts|tsx|yaml|yml)|^\.env(?:\..+)?$|^Pipfile$|^requirements(?:\.[\w-]+)?\.txt$)/i;

interface FindingInput extends Omit<VelloxFinding, 'fingerprint'> {}

function fingerprint(input: FindingInput): string {
  const identity = [input.ruleId, input.file || '', input.line || 0, input.evidence].join('|');
  return createHash('sha256').update(identity).digest('hex').slice(0, 20);
}

function finding(input: FindingInput): VelloxFinding {
  return { fingerprint: fingerprint(input), ...input };
}

function quoteIdentifier(identifier: string, dialect: string): string {
  if (dialect === 'mysql' || dialect === 'mariadb') return `\`${identifier.replace(/`/g, '``')}\``;
  return `"${identifier.replace(/"/g, '""')}"`;
}

function indexSql(table: string, column: string, dialect: string): string {
  const safeName = `idx_${table}_${column}`.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  const concurrently = dialect === 'postgresql' ? ' CONCURRENTLY' : '';
  const ifNotExists = ['postgresql', 'sqlite', 'mariadb'].includes(dialect) ? ' IF NOT EXISTS' : '';
  return `CREATE INDEX${concurrently}${ifNotExists} ${quoteIdentifier(safeName, dialect)} ON ${quoteIdentifier(table, dialect)} (${quoteIdentifier(column, dialect)});`;
}

function walk(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.cache')) visit(fullPath, depth + 1);
      } else if (SOURCE_FILE.test(entry.name)) {
        files.push(fullPath);
      }
    }
  };
  visit(root, 0);
  return files.sort();
}

export function detectDatabaseContext(root: string, files: string[]): { detected: boolean; evidence: string[] } {
  const evidence = new Set<string>();
  const dependencyNames = [
    '@prisma/client', 'drizzle-orm', 'ioredis', 'knex', 'mongoose', 'mongodb', 'mysql', 'mysql2',
    'oracledb', 'pg', 'postgres', 'prisma', 'redis', 'sequelize', 'typeorm'
  ];

  for (const file of files.filter(candidate => path.basename(candidate) === 'package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, string>>;
      const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const matches = dependencyNames.filter(name => dependencies[name]);
      if (matches.length) evidence.add(`${path.relative(root, file)}: ${matches.join(', ')}`);
    } catch {}
  }

  for (const file of files) {
    const relative = path.relative(root, file);
    if (file.endsWith('.prisma')) evidence.add(`${relative}: Prisma schema`);
    if (file.endsWith('.sql') && /(?:migration|schema)/i.test(relative)) evidence.add(`${relative}: SQL schema/migration`);
    if (/requirements\.txt$|pyproject\.toml$|Pipfile$/i.test(file)) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const matches = content.match(/sqlalchemy|psycopg|asyncpg|pymongo|redis|pymysql/gi);
        if (matches?.length) evidence.add(`${relative}: ${[...new Set(matches.map(value => value.toLowerCase()))].join(', ')}`);
      } catch {}
    }
  }

  return { detected: evidence.size > 0, evidence: [...evidence] };
}

function scanPrisma(content: string, relativeFile: string): VelloxFinding[] {
  const results: VelloxFinding[] = [];
  const provider = /provider\s*=\s*["']([^"']+)["']/.exec(content)?.[1]?.toLowerCase() || 'unknown';
  const modelRegex = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  for (const model of content.matchAll(modelRegex)) {
    const modelName = model[1]!;
    const body = model[2]!;
    const tableName = /@@map\(\s*["']([^"']+)["']\s*\)/.exec(body)?.[1] || modelName;
    const modelLine = content.slice(0, model.index).split('\n').length;
    const relationFields = [...body.matchAll(/@relation\([\s\S]*?fields\s*:\s*\[([^\]]+)\]/g)]
      .flatMap(match => match[1]!.split(',').map(value => value.trim()).filter(Boolean));

    for (const field of new Set(relationFields)) {
      const hasIndex = new RegExp(`@@(?:index|unique)\\(\\s*\\[[^\\]]*\\b${field}\\b`).test(body)
        || new RegExp(`^\\s*${field}\\s+[^\\n]*@unique`, 'm').test(body);
      if (hasIndex) continue;
      const evidence = `Model ${modelName} relation field ${field} has no @@index/@@unique coverage.`;
      results.push(finding({
        ruleId: 'prisma/missing-relation-index',
        severity: 'HIGH',
        category: 'database',
        title: 'Missing Prisma relation index',
        evidence,
        recommendation: `Add @@index([${field}]) to model ${modelName} and review the generated SQL.`,
        file: relativeFile,
        line: modelLine,
        sql: indexSql(tableName, field, provider),
        metadata: { model: modelName, table: tableName, column: field, dialect: provider }
      }));
    }
  }
  return results;
}

function scanDrizzle(content: string, relativeFile: string): VelloxFinding[] {
  const results: VelloxFinding[] = [];
  const tableRegex = /(pgTable|mysqlTable|sqliteTable)\(\s*["']([^"']+)["']\s*,\s*\{([\s\S]*?)\}\s*(?:,\s*\([^)]*\)\s*=>\s*\[([\s\S]*?)\])?\s*\)/g;
  for (const table of content.matchAll(tableRegex)) {
    const kind = table[1]!;
    const tableName = table[2]!;
    const columns = table[3]!;
    const declaredIndexes = table[4] || '';
    const line = content.slice(0, table.index).split('\n').length;
    for (const reference of columns.matchAll(/(\w+)\s*:\s*(?:uuid|varchar|integer|text|bigint)\([^\n]*?\)\.references\(/g)) {
      const column = reference[1]!;
      if (new RegExp(`(?:index|uniqueIndex)\\([^)]*\\)[\\s\\S]*?\\.on\\([^)]*\\.${column}\\b`).test(declaredIndexes)) continue;
      const dialect = kind === 'pgTable' ? 'postgresql' : kind === 'mysqlTable' ? 'mysql' : 'sqlite';
      results.push(finding({
        ruleId: 'drizzle/missing-relation-index',
        severity: 'HIGH',
        category: 'database',
        title: 'Missing Drizzle relation index',
        evidence: `Table ${tableName} references another table through ${column} without a declared index.`,
        recommendation: `Declare an index for ${tableName}.${column} in the Drizzle table callback.`,
        file: relativeFile,
        line,
        sql: indexSql(tableName, column, dialect),
        metadata: { table: tableName, column, dialect }
      }));
    }
  }
  return results;
}

function scanSqlSchema(content: string, relativeFile: string): VelloxFinding[] {
  const results: VelloxFinding[] = [];
  const dialect = /\bCONCURRENTLY\b|\bSERIAL\b|\bJSONB\b/i.test(content) ? 'postgresql' : 'unknown';
  const createTable = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)["`]?\s*\(([\s\S]*?)\);/gi;
  for (const table of content.matchAll(createTable)) {
    const tableName = table[1]!.split('.').pop()!;
    const body = table[2]!;
    const tableLine = content.slice(0, table.index).split('\n').length;
    for (const foreignKey of body.matchAll(/FOREIGN\s+KEY\s*\(\s*["`]?([\w]+)["`]?\s*\)\s*REFERENCES\s+["`]?[\w.]+["`]?/gi)) {
      const column = foreignKey[1]!;
      const optionalQuote = '["`]?' ;
      const indexed = new RegExp('(?:INDEX|KEY|UNIQUE)[^;\\n]*\\(\\s*' + optionalQuote + column + optionalQuote, 'i').test(body)
        || new RegExp('CREATE\\s+(?:UNIQUE\\s+)?INDEX[\\s\\S]*?ON\\s+' + optionalQuote + tableName + optionalQuote + '[\\s\\S]*?\\(\\s*' + optionalQuote + column + optionalQuote, 'i').test(content);
      if (indexed) continue;
      results.push(finding({
        ruleId: 'sql/missing-foreign-key-index',
        severity: 'HIGH',
        category: 'database',
        title: 'Foreign key without a supporting index',
        evidence: `${tableName}.${column} is declared as a foreign key without an index in the inspected schema.`,
        recommendation: `Add and validate an index for ${tableName}.${column}.`,
        file: relativeFile,
        line: tableLine,
        sql: indexSql(tableName, column, dialect),
        metadata: { table: tableName, column, dialect }
      }));
    }
  }
  return results;
}

const SECRET_RULES: Array<{
  id: string;
  title: string;
  regex: RegExp;
  recommendation: string;
}> = [
  { id: 'secret/google-api-key', title: 'Google API key exposed', regex: /\bAIzaSy[a-zA-Z0-9_-]{33}\b/, recommendation: 'Revoke the key and inject it through a secret manager or environment variable.' },
  { id: 'secret/openai-api-key', title: 'OpenAI API key exposed', regex: /\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,}\b/, recommendation: 'Revoke the key and move it to OPENAI_API_KEY outside source control.' },
  { id: 'secret/anthropic-api-key', title: 'Anthropic API key exposed', regex: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/, recommendation: 'Revoke the key and move it to ANTHROPIC_API_KEY outside source control.' },
  { id: 'secret/aws-access-key', title: 'AWS access key exposed', regex: /\bAKIA[0-9A-Z]{16}\b/, recommendation: 'Revoke the key and use an IAM role or managed secret.' },
  { id: 'secret/stripe-live-key', title: 'Stripe live key exposed', regex: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/, recommendation: 'Revoke the live key immediately and load it from a managed secret.' },
  { id: 'secret/github-token', title: 'GitHub token exposed', regex: /\b(?:ghp_[0-9a-zA-Z]{36}|github_pat_[0-9a-zA-Z_]{22,})\b/, recommendation: 'Revoke the token and use GitHub Actions secrets or an environment variable.' },
  { id: 'secret/private-key', title: 'Private key committed', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, recommendation: 'Remove and rotate the key, then store it in a secrets manager.' }
];

function redact(value: string): string {
  if (value.startsWith('-----BEGIN')) return '-----BEGIN … PRIVATE KEY-----';
  if (value.length < 12) return '********';
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function executableLines(source: string): string[] {
  let result = '';
  let quote = '';
  let escaped = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (character === '\n') {
      result += '\n';
      if (quote !== '`') quote = '';
      escaped = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        result += '  ';
        blockComment = false;
        index += 1;
      } else result += ' ';
      continue;
    }
    if (!quote && character === '/' && next === '*') {
      result += '  ';
      blockComment = true;
      index += 1;
      continue;
    }
    if (!quote && character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        result += ' ';
        index += 1;
      }
      if (source[index] === '\n') result += '\n';
      continue;
    }
    if (!quote && (character === '"' || character === "'" || character === '`')) {
      quote = character;
      result += ' ';
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      result += ' ';
      continue;
    }
    result += character;
  }
  return result.split('\n');
}

function scanCodeAndSecrets(content: string, relativeFile: string, inspectCode: boolean): VelloxFinding[] {
  const results: VelloxFinding[] = [];
  const lines = content.split('\n');
  const codeLines = executableLines(content);
  let loop: { start: number; depth: number; legitimate: boolean; kind: string } | null = null;
  let braceDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]!;
    const previous = index > 0 ? lines[index - 1]! : '';
    const code = codeLines[index] || '';
    const ignored = source.includes('@vellox-ignore') || previous.includes('@vellox-ignore') || source.includes('vellox-disable');
    const opens = (code.match(/\{/g) || []).length;
    const closes = (code.match(/\}/g) || []).length;

    if (inspectCode && !ignored && !loop) {
      const jsLoop = /\b(for\s*(?:await\s*)?\(|for\s+await\s*\(|while\s*\()/.test(code);
      const pythonLoop = /^\s*(?:async\s+)?for\s+.+:|^\s*while\s+.+:/.test(code);
      if (jsLoop || pythonLoop) {
        loop = {
          start: index + 1,
          depth: braceDepth,
          legitimate: /\b(?:attempt|batch|chunk|page|retries|retry)\b/i.test(code),
          kind: 'loop'
        };
      }
    }

    if (inspectCode && !ignored && loop && !loop.legitimate && /\bawait\s+(?:axios\.|client\.|db\.|fetch\s*\(|pool\.|prisma\.|query\s*\(|\w+Repository\.|\w+Service\.)/i.test(code)) {
      results.push(finding({
        ruleId: 'code/sequential-async-loop',
        severity: 'HIGH',
        category: 'code',
        title: 'Sequential asynchronous work inside a loop',
        evidence: source.trim(),
        recommendation: 'Batch the operation or use bounded parallelism. Add // @vellox-ignore only after review.',
        file: relativeFile,
        line: index + 1,
        metadata: { loopStart: loop.start, kind: loop.kind }
      }));
    }

    if (inspectCode && !ignored && /^(?:const|let|var)\s+(\w*(?:Cache|Store|List))\s*=\s*(?:\{\}|\[\]|new\s+Map\(\));?\s*$/i.test(code.trim())) {
      results.push(finding({
        ruleId: 'code/unbounded-global-store',
        severity: 'MEDIUM',
        category: 'code',
        title: 'Potentially unbounded global in-memory store',
        evidence: source.trim(),
        recommendation: 'Use a bounded cache with both maximum size and TTL.',
        file: relativeFile,
        line: index + 1
      }));
    }

    if (!ignored && !/(?:placeholder|your-key|example)/i.test(source)) {
      for (const rule of SECRET_RULES) {
        const match = rule.regex.exec(source);
        if (!match) continue;
        results.push(finding({
          ruleId: rule.id,
          severity: 'CRITICAL',
          category: 'security',
          title: rule.title,
          evidence: `Detected credential ${redact(match[0])}.`,
          recommendation: rule.recommendation,
          file: relativeFile,
          line: index + 1
        }));
      }

      const uri = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/([^:\s"']+):([^@\s"']+)@[^\s"']+/.exec(source);
      if (uri && !/^(?:password|secret)$/i.test(uri[2]!)) {
        results.push(finding({
          ruleId: 'secret/database-uri',
          severity: 'CRITICAL',
          category: 'security',
          title: 'Database URI contains credentials',
          evidence: `Detected a connection URI with an embedded password for user ${uri[1]}.`,
          recommendation: 'Rotate the credential and load DATABASE_URL from a secret manager.',
          file: relativeFile,
          line: index + 1
        }));
      }
    }

    braceDepth += opens - closes;
    if (loop && braceDepth <= loop.depth && index + 1 > loop.start) loop = null;
    if (loop && index + 1 - loop.start > 80) loop = null;
  }
  return results;
}

export function analyzeSqlQuery(sql: string, file?: string, line?: number): VelloxFinding[] {
  const rules: Array<{ id: string; severity: Severity; title: string; test: RegExp; recommendation: string }> = [
    { id: 'query/select-star', severity: 'MEDIUM', title: 'Wildcard SELECT retrieval', test: /SELECT\s+\*\s+FROM/i, recommendation: 'Select only required columns to reduce transfer and enable index-only scans.' },
    { id: 'query/leading-wildcard', severity: 'HIGH', title: 'Leading wildcard search', test: /LIKE\s+["']%[^"']+["']/i, recommendation: 'Use prefix search or a purpose-built full-text/trigram index.' },
    { id: 'query/unbounded-select', severity: 'MEDIUM', title: 'Unbounded SELECT query', test: /^(?![\s\S]*\bLIMIT\s+\d+)(?![\s\S]*\bCOUNT\s*\()[\s\S]*\bSELECT\b/i, recommendation: 'Add a bounded limit and cursor/keyset pagination when the predicate is not guaranteed unique.' },
    { id: 'query/missing-filter', severity: 'MEDIUM', title: 'SELECT without a filter', test: /^(?![\s\S]*\bWHERE\b)[\s\S]*\bSELECT\b[\s\S]*\bFROM\b/i, recommendation: 'Add a selective predicate or document why the table is safely bounded.' },
    { id: 'query/not-in-null', severity: 'HIGH', title: 'NOT IN subquery null trap', test: /NOT\s+IN\s*\(\s*SELECT/i, recommendation: 'Use NOT EXISTS or an anti-join with explicit null behavior.' },
    { id: 'query/random-sort', severity: 'HIGH', title: 'Random full-set sort', test: /ORDER\s+BY\s+(?:RANDOM|RAND)\s*\(\s*\)/i, recommendation: 'Use sampling or indexed random slots instead of sorting the full result.' },
    { id: 'query/function-on-filter', severity: 'MEDIUM', title: 'Function-wrapped filter column', test: /WHERE[\s\S]+?(?:date_trunc|lower|upper|substr|to_char|coalesce)\s*\(\s*["`]?\w+/i, recommendation: 'Rewrite as a sargable predicate or add a matching functional index.' },
    { id: 'query/distinct-join', severity: 'MEDIUM', title: 'DISTINCT may hide join multiplication', test: /SELECT\s+DISTINCT\b[\s\S]+\bJOIN\b/i, recommendation: 'Review join cardinality and prefer EXISTS when only presence is required.' }
  ];
  const results = rules.filter(rule => rule.test.test(sql)).map(rule => finding({
    ruleId: rule.id,
    severity: rule.severity,
    category: 'query',
    title: rule.title,
    evidence: sql.trim().replace(/\s+/g, ' ').slice(0, 500),
    recommendation: rule.recommendation,
    file,
    line
  }));
  const offset = /\bOFFSET\s+(\d+)/i.exec(sql);
  if (offset && Number(offset[1]) >= 1000) {
    results.push(finding({
      ruleId: 'query/deep-offset', severity: 'HIGH', category: 'query', title: 'Deep OFFSET pagination',
      evidence: `Query uses OFFSET ${offset[1]}.`, recommendation: 'Use cursor/keyset pagination.', file, line
    }));
  }
  return results;
}

function scanRawQueries(content: string, relativeFile: string): VelloxFinding[] {
  if (/(?:^|\/)(?:__tests__|tests?|fixtures?|examples?)(?:\/|$)|\.(?:test|spec)\./i.test(relativeFile)) return [];
  const results: VelloxFinding[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]!;
    for (const literal of source.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      const sql = literal[2]!.replace(/\\(["'`])/g, '$1').trim();
      if (/^(?:SELECT|WITH)\b[\s\S]*\bFROM\b/i.test(sql)) {
        results.push(...analyzeSqlQuery(sql, relativeFile, index + 1));
      }
    }
  }
  return results;
}

export function scanProject(targetDirectory: string, version: string): VelloxReport {
  const target = path.resolve(targetDirectory);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Target directory does not exist: ${target}`);
  }
  const files = walk(target);
  const databaseContext = detectDatabaseContext(target, files);
  const findings: VelloxFinding[] = [];

  for (const file of files) {
    let content: string;
    try {
      if (fs.statSync(file).size > 2_000_000) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const relative = path.relative(target, file).replace(/\\/g, '/');
    if (file.endsWith('.prisma')) findings.push(...scanPrisma(content, relative));
    if (/\.(?:js|jsx|ts|tsx)$/i.test(file) && /(?:pgTable|mysqlTable|sqliteTable)\s*\(/.test(content)) findings.push(...scanDrizzle(content, relative));
    if (file.endsWith('.sql')) findings.push(...scanSqlSchema(content, relative));
    findings.push(...scanCodeAndSecrets(content, relative, /\.(?:cjs|js|jsx|mjs|py|ts|tsx)$/i.test(file)));
    if (databaseContext.detected && /\.(?:cjs|js|jsx|mjs|py|sql|ts|tsx)$/i.test(file)) findings.push(...scanRawQueries(content, relative));
  }

  const unique = [...new Map(findings.map(item => [item.fingerprint, item])).values()];
  const severityRank: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  unique.sort((left, right) => severityRank[left.severity] - severityRank[right.severity]
    || (left.file || '').localeCompare(right.file || '') || (left.line || 0) - (right.line || 0));

  return {
    schemaVersion: '1.0',
    tool: { name: 'vellox', version },
    generatedAt: new Date().toISOString(),
    target,
    databaseContext,
    summary: {
      filesScanned: files.length,
      findings: unique.length,
      critical: unique.filter(item => item.severity === 'CRITICAL').length,
      high: unique.filter(item => item.severity === 'HIGH').length,
      medium: unique.filter(item => item.severity === 'MEDIUM').length,
      low: unique.filter(item => item.severity === 'LOW').length,
      secrets: unique.filter(item => item.category === 'security').length,
      reviewableSqlFixes: unique.filter(item => item.sql).length
    },
    findings: unique
  };
}
