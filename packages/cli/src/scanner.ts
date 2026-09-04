import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import createIgnore from 'ignore';
import { loadConfig } from './config.js';
import { buildProjectSemanticIndex } from './project-graph.js';
import { analyzeSqlDocumentSyntax, analyzeSqlSyntax, SqlAnalysisOptions } from './sql-analysis.js';
import { scanJavaScriptStructure, scanPythonStructure } from './structural-code.js';
import { Severity, VelloxConfig, VelloxFinding, VelloxFindingInput, VelloxReport } from './types.js';

export interface ScanOptions {
  maxFileBytes?: number;
  sqlDialect?: NonNullable<VelloxConfig['analysis']['sqlDialect']>;
  largeInListThreshold?: number;
  excessiveOrThreshold?: number;
}

const IGNORED_DIRECTORIES = new Set([
  '.git', '.next', '.nuxt', '.output', '.turbo', '.vellox',
  '.pytest_cache', '.ruff_cache', '.test-build', '.teste-build', '__pycache__',
  'build', 'coverage', 'dist', 'node_modules', 'vendor'
]);
const SOURCE_FILE = /(?:\.(?:cjs|env|js|json|jsx|mjs|prisma|py|sql|tf|tfvars|toml|ts|tsx|yaml|yml)$|^(?:Dockerfile|Containerfile)(?:\..+)?$|^\.env(?:\..+)?$|^Pipfile$|^requirements(?:\.[\w-]+)?\.txt$)/i;

function fingerprint(input: VelloxFindingInput): string {
  // A baseline represents the finding itself, not its current position. Keeping
  // line numbers out of the identity prevents unrelated edits above a finding
  // from making CI report it as new.
  const normalizedEvidence = input.evidence.trim().replace(/\s+/g, ' ');
  const identity = [input.ruleId, input.file || '', normalizedEvidence].join('|');
  return createHash('sha256').update(identity).digest('hex').slice(0, 20);
}

function finding(input: VelloxFindingInput): VelloxFinding {
  return { fingerprint: fingerprint(input), ...input };
}

function quoteIdentifier(identifier: string, dialect: string): string {
  if (dialect === 'mysql' || dialect === 'mariadb') return `\`${identifier.replace(/`/g, '``')}\``;
  return `"${identifier.replace(/"/g, '""')}"`;
}

function indexSql(table: string, column: string, dialect: string): string | undefined {
  if (!['mariadb', 'mysql', 'postgresql', 'sqlite'].includes(dialect)) return undefined;
  const safeName = `idx_${table}_${column}`.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  const concurrently = dialect === 'postgresql' ? ' CONCURRENTLY' : '';
  const ifNotExists = ['postgresql', 'sqlite', 'mariadb'].includes(dialect) ? ' IF NOT EXISTS' : '';
  return `CREATE INDEX${concurrently}${ifNotExists} ${quoteIdentifier(safeName, dialect)} ON ${quoteIdentifier(table, dialect)} (${quoteIdentifier(column, dialect)});`;
}

function ignoreMatcher(root: string, config: VelloxConfig): (relativePath: string) => boolean {
  const matcher = createIgnore();
  for (const fileName of ['.gitignore', '.velloxignore']) {
    const filePath = path.join(root, fileName);
    if (fs.existsSync(filePath)) matcher.add(fs.readFileSync(filePath, 'utf8'));
  }
  matcher.add(config.ignore || []);
  return relativePath => {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    return normalized.length > 0 && matcher.ignores(normalized);
  };
}

function walk(root: string, config: VelloxConfig): { files: string[]; issues: NonNullable<VelloxReport['coverage']>['issues'] } {
  const files: string[] = [];
  const issues: NonNullable<VelloxReport['coverage']>['issues'] = [];
  const ignored = ignoreMatcher(root, config);
  const visit = (directory: string, depth: number): void => {
    if (depth > 12) {
      issues.push({ file: path.relative(root, directory).replace(/\\/g, '/') || '.', reason: 'max-depth' });
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      issues.push({ file: path.relative(root, directory).replace(/\\/g, '/') || '.', reason: 'directory-read-error' });
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.cache') && !ignored(`${relative}/`)) visit(fullPath, depth + 1);
      } else if (SOURCE_FILE.test(entry.name) && !ignored(relative)) {
        files.push(fullPath);
      }
    }
  };
  visit(root, 0);
  return { files: files.sort(), issues };
}

function configuredRule(ruleId: string, config: VelloxConfig): false | Severity | { enabled?: boolean; severity?: Severity } | undefined {
  const rules = config.rules || {};
  return rules[ruleId] ?? rules[`${ruleId.split('/')[0]}/*`] ?? rules['*'];
}

function applyRuleConfiguration(findings: VelloxFinding[], config: VelloxConfig): VelloxFinding[] {
  return findings.flatMap(item => {
    const setting = configuredRule(item.ruleId, config);
    if (setting === false || (typeof setting === 'object' && setting.enabled === false)) return [];
    const severity = typeof setting === 'string' ? setting : setting?.severity;
    return [{ ...item, ...(severity ? { severity } : {}) }];
  });
}

export function detectDatabaseContext(root: string, files: string[], contents?: ReadonlyMap<string, string>): { detected: boolean; evidence: string[] } {
  const evidence = new Set<string>();
  const dependencyNames = [
    '@prisma/client', 'drizzle-orm', 'ioredis', 'knex', 'mongoose', 'mongodb', 'mysql', 'mysql2',
    'oracledb', 'pg', 'postgres', 'prisma', 'redis', 'sequelize', 'typeorm'
  ];

  for (const file of files.filter(candidate => path.basename(candidate) === 'package.json')) {
    try {
      const content = contents?.get(file) ?? (!contents ? fs.readFileSync(file, 'utf8') : undefined);
      if (content === undefined) continue;
      const pkg = JSON.parse(content) as Record<string, Record<string, string>>;
      const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const matches = dependencyNames.filter(name => dependencies[name]);
      if (matches.length) evidence.add(`${path.relative(root, file)}: ${matches.join(', ')}`);
    } catch {}
  }

  for (const file of files) {
    const relative = path.relative(root, file);
    const available = !contents || contents.has(file);
    if (available && file.endsWith('.prisma')) evidence.add(`${relative}: Prisma schema`);
    if (available && file.endsWith('.sql') && /(?:migration|schema)/i.test(relative)) evidence.add(`${relative}: SQL schema/migration`);
    if (/requirements\.txt$|pyproject\.toml$|Pipfile$/i.test(file)) {
      try {
        const content = contents?.get(file) ?? (!contents ? fs.readFileSync(file, 'utf8') : undefined);
        if (content === undefined) continue;
        const matches = content.match(/sqlalchemy|psycopg|asyncpg|pymongo|redis|pymysql/gi);
        if (matches?.length) evidence.add(`${relative}: ${[...new Set(matches.map(value => value.toLowerCase()))].join(', ')}`);
      } catch {}
    }
  }

  return { detected: evidence.size > 0, evidence: [...evidence] };
}

function scanPrisma(content: string, relativeFile: string): VelloxFinding[] {
  const results: VelloxFinding[] = [];
  const datasource = /datasource\s+\w+\s*\{([\s\S]*?)\}/.exec(content)?.[1] || '';
  const provider = /provider\s*=\s*["']([^"']+)["']/.exec(datasource)?.[1]?.toLowerCase() || 'unknown';
  const modelRegex = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  for (const model of content.matchAll(modelRegex)) {
    const modelName = model[1]!;
    const body = model[2]!;
    const tableName = /@@map\(\s*["']([^"']+)["']\s*\)/.exec(body)?.[1] || modelName;
    const modelLine = content.slice(0, model.index).split('\n').length;
    const relationFields = [...body.matchAll(/@relation\([\s\S]*?fields\s*:\s*\[([^\]]+)\]/g)]
      .flatMap(match => match[1]!.split(',').map(value => value.trim()).filter(Boolean));

    for (const field of new Set(relationFields)) {
      const hasIndex = new RegExp(`@@(?:index|unique)\\(\\s*\\[\\s*${field}\\b`).test(body)
        || new RegExp(`^\\s*${field}\\s+[^\\n]*@unique`, 'm').test(body);
      if (hasIndex) continue;
      const evidence = `Model ${modelName} relation field ${field} has no @@index/@@unique coverage.`;
      results.push(finding({
        ruleId: 'prisma/missing-relation-index',
        severity: 'MEDIUM',
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
        severity: 'MEDIUM',
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
    const foreignKeyColumns = new Set([
      ...[...body.matchAll(/FOREIGN\s+KEY\s*\(\s*["`]?([\w]+)["`]?\s*\)\s*REFERENCES\s+["`]?[\w.]+["`]?/gi)].map(match => match[1]!),
      ...[...body.matchAll(/^\s*["`]?([\w]+)["`]?\s+[^,\n]+\bREFERENCES\s+["`]?[\w.]+["`]?/gim)]
        .map(match => match[1]!)
        .filter(column => !/^(?:constraint|foreign|primary|unique)$/i.test(column))
    ]);
    for (const column of foreignKeyColumns) {
      const optionalQuote = '["`]?' ;
      const indexed = new RegExp('(?<!FOREIGN\\s)(?:INDEX|KEY|UNIQUE)[^;\\n]*\\(\\s*' + optionalQuote + column + optionalQuote, 'i').test(body)
        || new RegExp('CREATE\\s+(?:UNIQUE\\s+)?INDEX[\\s\\S]*?ON\\s+' + optionalQuote + tableName + optionalQuote + '[\\s\\S]*?\\(\\s*' + optionalQuote + column + optionalQuote, 'i').test(content);
      if (indexed) continue;
      results.push(finding({
        ruleId: 'sql/missing-foreign-key-index',
        severity: 'MEDIUM',
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

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function floatingImageReference(image: string): boolean {
  if (!image || image === 'scratch' || image.includes('@sha256:') || /[$<>{}]/.test(image)) return false;
  const finalSegment = image.split('/').pop() || image;
  return !finalSegment.includes(':') || finalSegment.endsWith(':latest');
}

function scanDockerfile(content: string, relativeFile: string): VelloxFinding[] {
  const results: VelloxFinding[] = [];
  const fromLines = [...content.matchAll(/^\s*FROM(?:\s+--platform=\S+)?\s+(\S+)/gim)];
  for (const match of fromLines) {
    const image = match[1]!;
    if (!floatingImageReference(image)) continue;
    results.push(finding({
      ruleId: 'infra/container-floating-base-image', severity: 'MEDIUM', category: 'infrastructure',
      title: 'Container base image is not pinned',
      evidence: `Base image ${image} can change without a source change.`,
      recommendation: 'Pin an immutable digest or an explicit versioned image tag and update it deliberately.',
      file: relativeFile, line: lineNumberAt(content, match.index)
    }));
  }

  const finalStage = fromLines.at(-1);
  const finalStageContent = finalStage ? content.slice(finalStage.index) : content;
  const finalUsers = [...finalStageContent.matchAll(/^\s*USER\s+(\S+)/gim)];
  const finalUser = finalUsers.at(-1);
  const finalUserValue = finalUser?.[1]?.split(':')[0]?.toLowerCase();
  const dynamicUser = Boolean(finalUserValue && /[$<>{}]/.test(finalUserValue));
  const rootUser = finalUserValue === 'root' || /^0+$/.test(finalUserValue || '');
  if (fromLines.length && (!finalUser || rootUser || dynamicUser)) {
    const finalStageOffset = finalStage?.index || 0;
    const userOffset = finalUser ? finalStageOffset + finalUser.index : finalStageOffset;
    const evidence = !finalUser
      ? 'The final image stage has no USER instruction.'
      : dynamicUser
        ? `The final image stage selects dynamic user ${finalUser![1]}, whose privilege cannot be verified statically.`
        : `The final image stage explicitly selects privileged user ${finalUser![1]}.`;
    results.push(finding({
      ruleId: 'infra/container-root-user', severity: 'MEDIUM', category: 'infrastructure',
      title: 'Container final stage has no verified non-root user',
      evidence,
      recommendation: 'Create and select a least-privileged runtime user in the final stage.',
      file: relativeFile, line: lineNumberAt(content, userOffset)
    }));
  }
  return results;
}

function yamlDocuments(content: string): Array<{ content: string; startLine: number }> {
  const documents: Array<{ content: string; startLine: number }> = [];
  const lines = content.split('\n');
  let start = 0;
  for (let index = 0; index <= lines.length; index += 1) {
    if (index < lines.length && !/^\s*---\s*$/.test(lines[index]!)) continue;
    const document = lines.slice(start, index).join('\n');
    if (document.trim()) documents.push({ content: document, startLine: start + 1 });
    start = index + 1;
  }
  return documents;
}

function yamlContainerBlocks(content: string): Array<{ content: string; startLine: number; name: string }> {
  const results: Array<{ content: string; startLine: number; name: string }> = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const section = /^(\s*)(?:initContainers|containers):\s*$/.exec(lines[index]!);
    if (!section) continue;
    const sectionIndent = indentationOf(section[1]!);
    let itemStart = -1;
    let itemIndent = -1;
    const flush = (end: number): void => {
      if (itemStart < 0) return;
      const block = lines.slice(itemStart, end).join('\n');
      const name = /^\s*-?\s*name:\s*["']?([^\s"'#]+)/mi.exec(block)?.[1] || `container at line ${itemStart + 1}`;
      results.push({ content: block, startLine: itemStart + 1, name });
    };
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!;
      if (!line.trim()) continue;
      const indent = indentationOf(line);
      if (indent <= sectionIndent) break;
      const item = /^(\s*)-\s+(?:name|image):/.exec(line);
      if (!item) continue;
      const candidateIndent = indentationOf(item[1]!);
      if (itemStart < 0) {
        itemStart = cursor;
        itemIndent = candidateIndent;
      } else if (candidateIndent === itemIndent) {
        flush(cursor);
        itemStart = cursor;
      }
    }
    flush(cursor);
    index = Math.max(index, cursor - 1);
  }
  return results;
}

function yamlNestedBlock(content: string, key: string): { content: string; line: number } | undefined {
  const inlineMapping = new RegExp(`(?:^|[,{])\\s*${key}:\\s*\\{([^{}]*)\\}`, 'i').exec(content);
  if (inlineMapping) {
    return { content: inlineMapping[1]!, line: lineNumberAt(content, inlineMapping.index) };
  }
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = new RegExp(`^(\\s*)${key}:\\s*(.*)$`, 'i').exec(lines[index]!);
    if (!match) continue;
    const inline = match[2]!.trim();
    if (inline) return { content: inline, line: index + 1 };
    const indent = indentationOf(match[1]!);
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const line = lines[end]!;
      if (line.trim() && indentationOf(line) <= indent) break;
    }
    return { content: lines.slice(index + 1, end).join('\n'), line: index + 1 };
  }
  return undefined;
}

function missingKubernetesResources(container: string): string[] | undefined {
  const resources = yamlNestedBlock(container, 'resources');
  if (!resources) return undefined;
  const missing: string[] = [];
  for (const policy of ['requests', 'limits']) {
    const block = yamlNestedBlock(resources.content, policy);
    for (const dimension of ['cpu', 'memory']) {
      const hasDimension = block && new RegExp(`(?:^|[,\\s{])${dimension}\\s*:`, 'im').test(block.content);
      if (!hasDimension) missing.push(`${policy}.${dimension}`);
    }
  }
  return missing;
}

function scanYamlInfrastructure(content: string, relativeFile: string): VelloxFinding[] {
  const results: VelloxFinding[] = [];
  const compose = /(?:^|\/)(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$/i.test(relativeFile);
  for (const document of yamlDocuments(content)) {
    const kind = /^\s*kind:\s*["']?([\w-]+)/mi.exec(document.content)?.[1];
    const kubernetes = Boolean(/^\s*apiVersion:\s*\S+/mi.test(document.content) && kind);
    if (kubernetes && /^(?:CronJob|DaemonSet|Deployment|Job|Pod|StatefulSet)$/i.test(kind!)) {
      for (const container of yamlContainerBlocks(document.content)) {
        const resources = yamlNestedBlock(container.content, 'resources');
        if (!resources) {
          results.push(finding({
            ruleId: 'infra/kubernetes-missing-resources', severity: 'MEDIUM', category: 'infrastructure',
            title: 'Kubernetes container has no resource policy',
            evidence: `${kind} container ${container.name} has no CPU or memory requests and limits.`,
            recommendation: 'Set measured CPU/memory requests and protective limits for every production container.',
            file: relativeFile, line: document.startLine + container.startLine - 1
          }));
          continue;
        }
        const missing = missingKubernetesResources(container.content) || [];
        if (missing.length) {
          results.push(finding({
            ruleId: 'infra/kubernetes-partial-resources', severity: 'MEDIUM', category: 'infrastructure',
            title: 'Kubernetes container resource policy is incomplete',
            evidence: `${kind} container ${container.name} is missing ${missing.join(', ')}.`,
            recommendation: 'Define measured CPU/memory requests and limits; validate them against runtime telemetry.',
            file: relativeFile, line: document.startLine + container.startLine + resources.line - 2,
            metadata: { missing: missing.join(',') }
          }));
        }
      }
    }

    if (kubernetes || compose) {
      for (const imageMatch of document.content.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gim)) {
        if (!floatingImageReference(imageMatch[1]!)) continue;
        results.push(finding({
          ruleId: 'infra/container-floating-image', severity: 'MEDIUM', category: 'infrastructure',
          title: 'Container image is not pinned',
          evidence: `Image ${imageMatch[1]} can change without a manifest change.`,
          recommendation: 'Pin an immutable digest or explicit version tag.',
          file: relativeFile, line: document.startLine + lineNumberAt(document.content, imageMatch.index) - 1
        }));
      }
      for (const privileged of document.content.matchAll(/^\s*(?:privileged|hostNetwork|hostPID):\s*true\s*(?:#.*)?$/gim)) {
        results.push(finding({
          ruleId: 'infra/privileged-workload', severity: 'HIGH', category: 'infrastructure',
          title: 'Workload enables privileged host access',
          evidence: privileged[0]!.trim(),
          recommendation: 'Remove privileged or host-level access unless a reviewed workload requirement proves it necessary.',
          file: relativeFile, line: document.startLine + lineNumberAt(document.content, privileged.index) - 1
        }));
      }
    }
  }
  return results;
}

function scanTerraform(content: string, relativeFile: string): VelloxFinding[] {
  const results: VelloxFinding[] = [];
  for (const database of content.matchAll(/resource\s+["']aws_db_instance["']\s+["'][^"']+["']\s*\{([\s\S]*?)\n\}/g)) {
    const publicAccess = /\bpublicly_accessible\s*=\s*true\b/i.exec(database[1]!);
    if (!publicAccess) continue;
    const absoluteIndex = database.index + database[0]!.indexOf(publicAccess[0]!);
    results.push(finding({
      ruleId: 'infra/terraform-public-database', severity: 'HIGH', category: 'infrastructure',
      title: 'Terraform exposes a managed database publicly',
      evidence: 'aws_db_instance sets publicly_accessible = true.',
      recommendation: 'Place the database on private subnets and require access through controlled application or administrative paths.',
      file: relativeFile, line: lineNumberAt(content, absoluteIndex)
    }));
  }
  for (const ingress of content.matchAll(/\bingress\s*\{([\s\S]*?)\n\s*\}/g)) {
    const publicCidr = /["']0\.0\.0\.0\/0["']|["']::\/0["']/i.exec(ingress[1]!);
    if (!publicCidr) continue;
    const absoluteIndex = ingress.index + ingress[0]!.indexOf(publicCidr[0]!);
    results.push(finding({
      ruleId: 'infra/terraform-public-ingress', severity: 'MEDIUM', category: 'infrastructure',
      title: 'Terraform ingress is open to the internet',
      evidence: 'An ingress block allows a world-routable CIDR.',
      recommendation: 'Restrict ingress to required ports and trusted CIDRs; document any intentionally public endpoint.',
      file: relativeFile, line: lineNumberAt(content, absoluteIndex)
    }));
  }
  for (const publicAcl of content.matchAll(/\bacl\s*=\s*["']public-(?:read|read-write)["']/gi)) {
    results.push(finding({
      ruleId: 'infra/terraform-public-storage', severity: 'HIGH', category: 'infrastructure',
      title: 'Terraform configures public object storage',
      evidence: publicAcl[0]!,
      recommendation: 'Use private storage plus explicit CDN or signed-object access where public delivery is required.',
      file: relativeFile, line: lineNumberAt(content, publicAcl.index)
    }));
  }
  return results;
}

function scanInfrastructure(content: string, relativeFile: string): VelloxFinding[] {
  const base = path.basename(relativeFile);
  if (/^(?:Dockerfile|Containerfile)(?:\..+)?$/i.test(base)) return scanDockerfile(content, relativeFile);
  if (/\.ya?ml$/i.test(relativeFile)) return scanYamlInfrastructure(content, relativeFile);
  if (/\.tf(?:vars)?$/i.test(relativeFile)) return scanTerraform(content, relativeFile);
  return [];
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
  { id: 'secret/github-token', title: 'GitHub token exposed', regex: /\b(?:ghp_[0-9a-zA-Z]{36}|github_pat_[0-9a-zA-Z_]{22,})\b/, recommendation: 'Revoke the token and use GitHub Actions secrets or an environment variable.' }
];

const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----\s*([A-Za-z0-9+/=\r\n]{64,})\s*-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g;

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

function hasIntentionalLoopContext(lines: string[], index: number): boolean {
  const context = lines.slice(Math.max(0, index - 5), index + 1).join('\n');
  return /\b(?:attempts?|retries|retry|tentativas?|batch(?:es)?|chunks?|lotes?|cursor|offset|hasMore|nextPage|pageSize|pageNumber|currentPage|pagina(?:s|ção)?|página(?:s|ção)?)\b/i.test(context)
    || /(?:one at a time|one-by-one|uma (?:de cada|por) vez|sequential(?:ly)?|serial(?:ly)?|rate.?limit|\b429\b|\b502\b)/i.test(context);
}

function sequentialLoopSeverity(relativeFile: string): Severity {
  return /(?:^|\/)(?:migrations?|scripts?|seeds?)(?:\/|$)|(?:^|\/)(?:backfill|check|debug|fix|migrate|repair|restore|seed)[^/]*\.(?:[cm]?[jt]s|py)$|^(?:analis(?:e|ar)|buscar|corrigir|gerar|habilitar|ultimos?|verificar)[^/]*\.(?:[cm]?[jt]s|py)$/i.test(relativeFile)
    ? 'MEDIUM'
    : 'HIGH';
}

function isPlaceholderDatabaseUri(user: string, password: string, host: string): boolean {
  const localHost = /^(?:localhost|127\.0\.0\.1|::1)(?::\d+)?$/i.test(host);
  const genericUser = /^(?:admin|dev|mysql|postgres|root|test|user|username)$/i.test(user);
  const genericPassword = /^(?:admin|changeme|change[_-]?me|dev|development|example\d*|local|mysql|password\d*|postgres|root|secret\d*|test(?:ing)?|user|username)$/i.test(password);
  return localHost && (genericUser || genericPassword);
}

interface ActiveLoop {
  start: number;
  depth: number;
  indent: number;
  language: 'brace' | 'python';
  legitimate: boolean;
  reported: boolean;
  kind: string;
}

function indentationOf(line: string): number {
  return (line.match(/^\s*/)?.[0] || '').replace(/\t/g, '    ').length;
}

function hasAsyncWork(code: string): boolean {
  return /\bawait\s+(?:axios\.|fetch\s*\(|(?:client|connection|cursor|db|pool|prisma|session)\.|query\s*\(|\w+(?:Repository|Service)\.)/i.test(code);
}

function hasSynchronousPythonQuery(code: string): boolean {
  return !/\bawait\b/.test(code) && (
    /\b(?:connection|cursor|db|session)\.(?:execute|executemany|query|scalar|scalars|get|select)\s*\(/i.test(code)
    || /\b\w+\.objects\.(?:all|exclude|filter|get|raw|select_related|prefetch_related)\s*\(/i.test(code)
    || /\b\w+\.query\.(?:all|count|filter|first|get|one|one_or_none)\s*\(/i.test(code)
  );
}

function scanCodeAndSecrets(content: string, relativeFile: string, inspectCode: boolean, inspectLegacyLoops: boolean): VelloxFinding[] {
  const results: VelloxFinding[] = [];
  const lines = content.split('\n');
  const codeLines = executableLines(content);
  let loop: ActiveLoop | null = null;
  let braceDepth = 0;

  for (const key of content.matchAll(PRIVATE_KEY)) {
    results.push(finding({
      ruleId: 'secret/private-key',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Private key committed',
      evidence: 'Detected a complete private key block with an embedded payload.',
      recommendation: 'Remove and rotate the key, then store it in a secrets manager.',
      file: relativeFile,
      line: content.slice(0, key.index).split('\n').length
    }));
  }

  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]!;
    const previous = index > 0 ? lines[index - 1]! : '';
    const code = codeLines[index] || '';
    const ignored = source.includes('@vellox-ignore') || previous.includes('@vellox-ignore') || source.includes('vellox-disable');
    const opens = (code.match(/\{/g) || []).length;
    const closes = (code.match(/\}/g) || []).length;
    const indent = indentationOf(source);

    if (loop?.language === 'python' && index + 1 > loop.start && code.trim() && indent <= loop.indent) loop = null;

    if (inspectCode && inspectLegacyLoops && !ignored && !loop) {
      const jsLoop = /\b(for\s*(?:await\s*)?\(|for\s+await\s*\(|while\s*\()/.test(code);
      const pythonLoop = /^\s*(?:async\s+)?for\s+.+:|^\s*while\s+.+:/.test(code);
      if (jsLoop || pythonLoop) {
        loop = {
          start: index + 1,
          depth: braceDepth,
          indent,
          language: pythonLoop ? 'python' : 'brace',
          legitimate: hasIntentionalLoopContext(lines, index),
          reported: false,
          kind: pythonLoop ? 'python-loop' : 'brace-loop'
        };
      }
    }

    if (loop && hasIntentionalLoopContext(lines, index)) loop.legitimate = true;

    if (inspectCode && inspectLegacyLoops && !ignored && loop && !loop.legitimate && !loop.reported && hasAsyncWork(code)) {
      results.push(finding({
        ruleId: 'code/sequential-async-loop',
        severity: sequentialLoopSeverity(relativeFile),
        category: 'code',
        title: 'Sequential asynchronous work inside a loop',
        evidence: source.trim(),
        recommendation: 'Batch the operation or use bounded parallelism. Add // @vellox-ignore only after review.',
        file: relativeFile,
        line: index + 1,
        metadata: { loopStart: loop.start, kind: loop.kind }
      }));
      loop.reported = true;
    }

    if (inspectCode && inspectLegacyLoops && /\.py$/i.test(relativeFile) && !ignored && loop && !loop.legitimate && !loop.reported && hasSynchronousPythonQuery(code)) {
      results.push(finding({
        ruleId: 'code/synchronous-query-loop',
        severity: sequentialLoopSeverity(relativeFile),
        category: 'code',
        title: 'Synchronous database work inside a loop',
        evidence: source.trim(),
        recommendation: 'Fetch the required records in one query or use a bulk operation outside the loop. Add # @vellox-ignore only after review.',
        file: relativeFile,
        line: index + 1,
        metadata: { loopStart: loop.start, kind: loop.kind }
      }));
      loop.reported = true;
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

    if (!ignored) {
      const documentedPlaceholder = /(?:placeholder|your-key|\b(?:example|exemplo)\s*:)/i.test(source);
      if (!documentedPlaceholder) {
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
      }

      const uri = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/([^:\s"']+):([^@\s"']+)@([^/\s"']+)/.exec(source);
      if (uri && !documentedPlaceholder && !isPlaceholderDatabaseUri(uri[1]!, uri[2]!, uri[3]!)) {
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
    if (loop?.language === 'brace' && braceDepth <= loop.depth && index + 1 > loop.start) loop = null;
    if (loop && index + 1 - loop.start > 80) loop = null;
  }
  return results;
}

interface SqlToken {
  word: string;
  start: number;
  depth: number;
}

function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let depth = 0;
  let quote = '';
  let dollarQuote = '';
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        index += dollarQuote.length - 1;
        dollarQuote = '';
      }
      continue;
    }
    if (quote) {
      if (character === quote && next === quote) index += 1;
      else if (character === quote && sql[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (tag) {
        dollarQuote = tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) end += 1;
      tokens.push({ word: sql.slice(index, end).toUpperCase(), start: index, depth });
      index = end - 1;
    }
  }
  return tokens;
}

function sqlStructure(sql: string): {
  statement: string;
  selectStar: boolean;
  hasFilter: boolean;
  bounded: boolean;
  joinCount: number;
  unionWithoutAll: boolean;
  redundantDistinct: boolean;
} {
  const tokens = sqlTokens(sql);
  const mainIndex = tokens.findIndex(token => token.depth === 0 && /^(?:SELECT|UPDATE|DELETE|INSERT)$/.test(token.word));
  if (mainIndex < 0) return { statement: '', selectStar: false, hasFilter: false, bounded: false, joinCount: 0, unionWithoutAll: false, redundantDistinct: false };
  const main = tokens[mainIndex]!;
  const top = tokens.slice(mainIndex).filter(token => token.depth === 0);
  const has = (word: string): boolean => top.some(token => token.word === word);
  const from = top.find(token => token.word === 'FROM');
  const projection = main.word === 'SELECT' && from ? sql.slice(main.start + 6, from.start) : '';
  const selectStar = /(?:^|,)\s*(?:[A-Za-z_][\w$]*\.)?\*\s*(?:,|$)/i.test(projection.trim());
  const hasFilter = has('WHERE');
  const hasLimit = has('LIMIT') || (has('FETCH') && has('FIRST')) || /^\s*SELECT\s+TOP\s*\(?\s*(?:\d+|\?|:\w+|@\w+)/i.test(sql);
  const aggregateOnly = /^\s*(?:COUNT|MIN|MAX|AVG|SUM)\s*\(/i.test(projection.trim());
  const whereStart = top.find(token => token.word === 'WHERE')?.start;
  const endBoundary = top.find(token => whereStart !== undefined && token.start > whereStart && /^(?:ORDER|GROUP|LIMIT|FETCH|OFFSET|UNION)$/.test(token.word))?.start || sql.length;
  const where = whereStart === undefined ? '' : sql.slice(whereStart, endBoundary);
  const uniqueLookup = /\b(?:[A-Za-z_]\w*\.)?id\s*=\s*(?:\$\d+|\?|:\w+|@\w+|\d+|'[^']*')/i.test(where) && !/\bOR\b/i.test(where);
  const joins = top.filter(token => token.word === 'JOIN').length;
  const unionWithoutAll = top.some((token, index) => token.word === 'UNION' && top[index + 1]?.word !== 'ALL');
  return {
    statement: main.word,
    selectStar,
    hasFilter,
    bounded: hasLimit || aggregateOnly || uniqueLookup,
    joinCount: joins,
    unionWithoutAll,
    redundantDistinct: has('DISTINCT') && has('GROUP') && has('BY')
  };
}

function analyzeSqlQueryLegacy(sql: string, file?: string, line?: number): VelloxFinding[] {
  const structure = sqlStructure(sql);
  const rules: Array<{ id: string; severity: Severity; title: string; test: () => boolean; recommendation: string }> = [
    { id: 'query/select-star', severity: 'MEDIUM', title: 'Wildcard SELECT retrieval', test: () => structure.selectStar, recommendation: 'Select only required columns to reduce transfer and enable index-only scans.' },
    { id: 'query/leading-wildcard', severity: 'HIGH', title: 'Leading wildcard search', test: () => /LIKE\s+["']%[^"']+["']/i.test(sql), recommendation: 'Use prefix search or a purpose-built full-text/trigram index.' },
    { id: 'query/unbounded-select', severity: 'MEDIUM', title: 'Unbounded SELECT query', test: () => structure.statement === 'SELECT' && !structure.bounded, recommendation: 'Add a bounded limit and cursor/keyset pagination when the predicate is not guaranteed unique.' },
    { id: 'query/missing-filter', severity: 'MEDIUM', title: 'SELECT without a filter', test: () => structure.statement === 'SELECT' && !structure.hasFilter && !structure.bounded, recommendation: 'Add a selective predicate or document why the table is safely bounded.' },
    { id: 'query/not-in-null', severity: 'HIGH', title: 'NOT IN subquery null trap', test: () => /NOT\s+IN\s*\(\s*SELECT/i.test(sql), recommendation: 'Use NOT EXISTS or an anti-join with explicit null behavior.' },
    { id: 'query/random-sort', severity: 'HIGH', title: 'Random full-set sort', test: () => /ORDER\s+BY\s+(?:RANDOM|RAND)\s*\(\s*\)/i.test(sql), recommendation: 'Use sampling or indexed random slots instead of sorting the full result.' },
    { id: 'query/function-on-filter', severity: 'MEDIUM', title: 'Function-wrapped filter column', test: () => /WHERE[\s\S]+?(?:date_trunc|lower|upper|substr|to_char|coalesce)\s*\(\s*["`]?\w+/i.test(sql), recommendation: 'Rewrite as a sargable predicate or add a matching functional index.' },
    { id: 'query/distinct-join', severity: 'MEDIUM', title: 'DISTINCT may hide join multiplication', test: () => /SELECT\s+DISTINCT\b[\s\S]+\bJOIN\b/i.test(sql), recommendation: 'Review join cardinality and prefer EXISTS when only presence is required.' },
    { id: 'query/excessive-joins', severity: 'MEDIUM', title: 'Large join graph needs cardinality review', test: () => structure.joinCount >= 5, recommendation: 'Verify join cardinalities and indexes with EXPLAIN; split the query only when measurements justify it.' },
    { id: 'query/union-deduplication', severity: 'MEDIUM', title: 'UNION performs a global deduplication', test: () => structure.unionWithoutAll, recommendation: 'Use UNION ALL when duplicate removal is not required, then validate row semantics.' },
    { id: 'query/redundant-distinct', severity: 'MEDIUM', title: 'DISTINCT may duplicate GROUP BY work', test: () => structure.redundantDistinct, recommendation: 'Remove DISTINCT only after confirming GROUP BY already guarantees the required uniqueness.' },
    { id: 'query/unbounded-write', severity: 'HIGH', title: 'Write statement has no WHERE clause', test: () => /^(?:UPDATE|DELETE)$/.test(structure.statement) && !structure.hasFilter, recommendation: 'Add the intended predicate or explicitly document and review the full-table write.' }
  ];
  const results = rules.filter(rule => rule.test()).map(rule => finding({
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

export function analyzeSqlQuery(sql: string, file?: string, line?: number, options: Omit<SqlAnalysisOptions, 'file' | 'line'> = {}): VelloxFinding[] {
  const analysis = analyzeSqlSyntax(sql, { ...options, file, line });
  return analysis.parsed ? analysis.findings.map(finding) : analyzeSqlQueryLegacy(sql, file, line);
}

function scanRawQueries(content: string, relativeFile: string): VelloxFinding[] {
  if (isTestOrFixtureFile(relativeFile)) return [];
  const results: VelloxFinding[] = [];
  const literals = [
    ...content.matchAll(/`([\s\S]*?)`/g),
    ...content.matchAll(/(["']{3})([\s\S]*?)\1/g),
    ...content.matchAll(/(["'])((?:\\.|(?!\1)[^\r\n])*)\1/g)
  ].sort((left, right) => left.index - right.index);
  for (const literal of literals) {
    const raw = literal[2] ?? literal[1] ?? '';
    const sql = raw.replace(/\\(["'`])/g, '$1').trim();
    if (/^(?:SELECT|WITH)\b[\s\S]*\bFROM\b/i.test(sql)) {
      results.push(...analyzeSqlQuery(sql, relativeFile, lineNumberAt(content, literal.index)));
    }
  }
  return results;
}

function isTestOrFixtureFile(relativeFile: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?|fixtures?|examples?)(?:\/|$)|\.(?:test|spec)\.|(?:^|\/)(?:test[^/]*|[^/]*[.-]test)\.(?:[cm]?[jt]s|py)$/i.test(relativeFile);
}

function stripSqlComments(content: string): string {
  let result = '';
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    const next = content[index + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        result += '\n';
      } else result += ' ';
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        result += '  ';
        blockComment = false;
        index += 1;
      } else result += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      result += character;
      if (character === quote && next === quote) {
        result += next;
        index += 1;
      } else if (character === quote && content[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '-' && next === '-') {
      result += '  ';
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      result += '  ';
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    result += character;
  }
  return result;
}

function scanSqlFileQueries(content: string, relativeFile: string): VelloxFinding[] {
  const source = stripSqlComments(content);
  const results: VelloxFinding[] = [];
  let statementStart = 0;
  let quote = '';
  let dollarQuote = '';
  for (let index = 0; index <= source.length; index += 1) {
    const character = source[index] || ';';
    if (dollarQuote) {
      if (source.startsWith(dollarQuote, index)) {
        index += dollarQuote.length - 1;
        dollarQuote = '';
      }
      continue;
    }
    if (quote) {
      if (character === quote && source[index + 1] === quote) index += 1;
      else if (character === quote && source[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(index))?.[0];
      if (tag) {
        dollarQuote = tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== ';') continue;
    const statement = source.slice(statementStart, index).trim();
    const leadingWhitespace = source.slice(statementStart, index).search(/\S/);
    const absoluteStart = statementStart + Math.max(0, leadingWhitespace);
    if (/^(?:SELECT|WITH|UPDATE|DELETE)\b/i.test(statement)) {
      results.push(...analyzeSqlQuery(statement, relativeFile, lineNumberAt(source, absoluteStart)));
    }
    statementStart = index + 1;
  }
  return results;
}

export interface SqlDocumentScanResult {
  findings: VelloxFinding[];
  issues: Array<{ line: number; message: string }>;
  statements: number;
  dialects: string[];
}

export function analyzeSqlDocumentDetailed(content: string, file = 'inline.sql', options: Omit<SqlAnalysisOptions, 'file'> = {}): SqlDocumentScanResult {
  const analysis = analyzeSqlDocumentSyntax(content, { ...options, file });
  const legacy = analysis.issues.length ? scanSqlFileQueries(content, file) : [];
  if (analysis.issues.length && legacy.length === 0 && /\b(?:SELECT|WITH|UPDATE|DELETE)\b/i.test(content)) {
    legacy.push(...analyzeSqlQueryLegacy(content, file, analysis.issues[0]?.line || 1));
  }
  return {
    findings: analysis.issues.length ? legacy : analysis.findings.map(finding),
    issues: analysis.issues.map(issue => ({ line: issue.line, message: issue.message })),
    statements: analysis.statements,
    dialects: analysis.dialects
  };
}

export function analyzeSqlDocument(content: string, file = 'inline.sql', options: Omit<SqlAnalysisOptions, 'file'> = {}): VelloxFinding[] {
  return analyzeSqlDocumentDetailed(content, file, options).findings;
}

export function scanProject(targetDirectory: string, version: string, options: ScanOptions = {}): VelloxReport {
  const target = path.resolve(targetDirectory);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Target directory does not exist: ${target}`);
  }
  const config = loadConfig(target);
  const maxFileBytes = options.maxFileBytes ?? config.analysis.maxFileBytes;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error('maxFileBytes must be a positive integer.');
  }
  const discovery = walk(target, config);
  const files = discovery.files;
  const findings: VelloxFinding[] = [];
  const contents = new Map<string, string>();
  const coverageIssues: NonNullable<VelloxReport['coverage']>['issues'] = [...discovery.issues];
  for (const file of files) {
    const relative = path.relative(target, file).replace(/\\/g, '/');
    try {
      const sizeBytes = fs.statSync(file).size;
      if (sizeBytes > maxFileBytes) {
        coverageIssues.push({ file: relative, reason: 'file-too-large', sizeBytes, limitBytes: maxFileBytes });
        continue;
      }
      contents.set(file, fs.readFileSync(file, 'utf8'));
    } catch {
      coverageIssues.push({ file: relative, reason: 'read-error' });
    }
  }
  const databaseContext = detectDatabaseContext(target, files, contents);
  const semanticSources = new Map<string, string>();
  for (const [file, content] of contents) {
    const relative = path.relative(target, file).replace(/\\/g, '/');
    if (/\.(?:cjs|js|jsx|mjs|py|ts|tsx)$/i.test(file) && !isTestOrFixtureFile(relative)) semanticSources.set(relative, content);
  }
  const semanticIndex = buildProjectSemanticIndex(target, semanticSources, maxFileBytes);
  let structuralFiles = 0;
  let fallbackFiles = 0;
  let sqlStatements = 0;
  let sqlAstStatements = 0;

  for (const file of files) {
    const content = contents.get(file);
    if (content === undefined) continue;
    const relative = path.relative(target, file).replace(/\\/g, '/');
    if (file.endsWith('.prisma')) findings.push(...scanPrisma(content, relative));
    if (/\.(?:js|jsx|ts|tsx)$/i.test(file) && /(?:pgTable|mysqlTable|sqliteTable)\s*\(/.test(content)) findings.push(...scanDrizzle(content, relative));
    if (file.endsWith('.sql')) {
      findings.push(...scanSqlSchema(content, relative));
      const sql = analyzeSqlDocumentDetailed(content, relative, {
        dialect: options.sqlDialect ?? config.analysis.sqlDialect,
        largeInThreshold: options.largeInListThreshold ?? config.analysis.largeInListThreshold,
        excessiveOrThreshold: options.excessiveOrThreshold ?? config.analysis.excessiveOrThreshold
      });
      findings.push(...sql.findings);
      sqlStatements += sql.statements;
      sqlAstStatements += sql.issues.length ? 0 : sql.statements;
      for (const issue of sql.issues) {
        fallbackFiles += 1;
        coverageIssues.push({ file: relative, reason: 'parse-fallback', line: issue.line, parser: 'vellox-sql-ast', message: issue.message });
      }
    }
    const inspectCode = /\.(?:cjs|js|jsx|mjs|py|ts|tsx)$/i.test(file) && !isTestOrFixtureFile(relative);
    findings.push(...scanInfrastructure(content, relative));
    let structurallyParsed = false;
    let structuralParseError: { line?: number; parser: 'babel' | 'lezer-python' } | undefined;
    if (inspectCode && /\.(?:cjs|js|jsx|mjs|ts|tsx)$/i.test(file)) {
      const structural = scanJavaScriptStructure(content, relative, semanticIndex.externalQueryFunctions.get(relative));
      structurallyParsed = structural.parsed;
      structuralParseError = structural.parseError;
      findings.push(...structural.findings.map(finding));
    } else if (inspectCode && /\.py$/i.test(file)) {
      const structural = scanPythonStructure(content, relative, semanticIndex.externalQueryFunctions.get(relative));
      structurallyParsed = structural.parsed;
      structuralParseError = structural.parseError;
      findings.push(...structural.findings.map(finding));
    }
    if (inspectCode) {
      if (structurallyParsed) structuralFiles += 1;
      else {
        fallbackFiles += 1;
        coverageIssues.push({ file: relative, reason: 'parse-fallback', ...structuralParseError });
      }
    }
    findings.push(...scanCodeAndSecrets(content, relative, inspectCode, !structurallyParsed));
    if (databaseContext.detected && /\.(?:cjs|js|jsx|mjs|py|ts|tsx)$/i.test(file)) findings.push(...scanRawQueries(content, relative));
  }

  // Collapse only duplicate emissions for the exact same location, then keep
  // repeated semantic findings distinct with a stable occurrence suffix.
  const locationUnique = [...new Map(findings.map(item => [
    [item.ruleId, item.file || '', item.line || 0, item.evidence].join('|'),
    item
  ])).values()];
  const occurrences = new Map<string, number>();
  const unique = applyRuleConfiguration(locationUnique.map(item => {
    const occurrence = occurrences.get(item.fingerprint) || 0;
    occurrences.set(item.fingerprint, occurrence + 1);
    if (occurrence === 0) return item;
    return {
      ...item,
      fingerprint: createHash('sha256').update(`${item.fingerprint}|occurrence:${occurrence}`).digest('hex').slice(0, 20)
    };
  }), config);
  const severityRank: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  unique.sort((left, right) => severityRank[left.severity] - severityRank[right.severity]
    || (left.file || '').localeCompare(right.file || '') || (left.line || 0) - (right.line || 0));

  const filesSkipped = coverageIssues.filter(issue => issue.reason === 'file-too-large' || issue.reason === 'read-error').length;
  return {
    schemaVersion: '1.0',
    tool: { name: 'vellox', version },
    generatedAt: new Date().toISOString(),
    target,
    databaseContext,
    summary: {
      filesScanned: contents.size,
      findings: unique.length,
      critical: unique.filter(item => item.severity === 'CRITICAL').length,
      high: unique.filter(item => item.severity === 'HIGH').length,
      medium: unique.filter(item => item.severity === 'MEDIUM').length,
      low: unique.filter(item => item.severity === 'LOW').length,
      secrets: unique.filter(item => item.ruleId.startsWith('secret/')).length,
      infrastructure: unique.filter(item => item.category === 'infrastructure').length,
      reviewableSqlFixes: unique.filter(item => item.sql).length
    },
    coverage: {
      complete: coverageIssues.length === 0,
      filesDiscovered: files.length,
      filesAnalyzed: contents.size,
      filesSkipped,
      structuralFiles,
      fallbackFiles,
      semanticModules: semanticIndex.modulesAnalyzed,
      semanticFunctions: semanticIndex.functionsAnalyzed,
      sqlStatements,
      sqlAstStatements,
      issues: coverageIssues
    },
    findings: unique
  };
}
