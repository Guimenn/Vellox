import { parse } from '@babel/parser';
import { parser as pythonParser } from '@lezer/python';
import { Severity, VelloxFindingInput } from './types.js';

export interface StructuralScanResult {
  findings: VelloxFindingInput[];
  parsed: boolean;
}

interface PythonNode {
  name: string;
  from: number;
  to: number;
  type?: { isError?: boolean };
  firstChild: PythonNode | null;
  nextSibling: PythonNode | null;
}

const JS_LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const JS_FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ClassMethod', 'ClassPrivateMethod', 'ObjectMethod'
]);
const PYTHON_LOOP_TYPES = new Set(['ForStatement', 'WhileStatement']);

function sourceLine(content: string, line: number): string {
  return (content.split('\n')[Math.max(0, line - 1)] || '').trim().slice(0, 500);
}

function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

function ignoredAt(lines: string[], line: number): boolean {
  const current = lines[line - 1] || '';
  const previous = lines[line - 2] || '';
  return /@vellox-ignore|vellox-disable/.test(current) || /@vellox-ignore|vellox-disable/.test(previous);
}

function intentionalLoopContext(lines: string[], line: number): boolean {
  const context = lines.slice(Math.max(0, line - 6), line).join('\n');
  return /\b(?:attempts?|retries|retry|tentativas?|batch(?:es)?|chunks?|lotes?|cursor|hasMore|nextPage|pageSize|pageNumber|currentPage|pagina(?:s|ção)?|página(?:s|ção)?)\b/i.test(context)
    || /(?:one at a time|one-by-one|uma (?:de cada|por) vez|sequential(?:ly)?|serial(?:ly)?|rate.?limit|backpressure|\b429\b|\b502\b)/i.test(context);
}

function hotspotSeverity(relativeFile: string): Severity {
  return /(?:^|\/)(?:migrations?|scripts?|seeds?)(?:\/|$)|(?:^|\/)(?:backfill|check|debug|fix|migrate|repair|restore|seed)[^/]*\.(?:[cm]?[jt]s|py)$|^(?:analis(?:e|ar)|buscar|corrigir|gerar|habilitar|ultimos?|verificar)[^/]*\.(?:[cm]?[jt]s|py)$/i.test(relativeFile)
    ? 'MEDIUM'
    : 'HIGH';
}

function callName(node: any, content: string): string {
  if (!node) return '';
  if (node.type === 'Identifier' || node.type === 'PrivateName') return node.name || '';
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Super') return 'super';
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const object = callName(node.object, content);
    const property = node.computed
      ? content.slice(node.property?.start || 0, node.property?.end || 0).replace(/^['"]|['"]$/g, '')
      : callName(node.property, content);
    return [object, property].filter(Boolean).join('.');
  }
  if (typeof node.start === 'number' && typeof node.end === 'number') return content.slice(node.start, node.end);
  return '';
}

function jsProperty(node: any, content: string): string {
  const name = callName(node?.callee, content);
  return name.split('.').at(-1) || '';
}

function isJavaScriptDatabaseCall(node: any, content: string): boolean {
  if (node?.type !== 'CallExpression' && node?.type !== 'OptionalCallExpression') return false;
  const name = callName(node.callee, content);
  const lower = name.toLowerCase();
  const method = lower.split('.').at(-1) || '';
  const databaseMethod = /^(?:aggregate|bulkcreate|bulkdelete|bulkwrite|count|countdocuments|create|delete|deleteone|deletemany|destroy|execute|executemany|find|findall|findbyid|findbyidandupdate|findfirst|findmany|findone|findoneandupdate|findunique|insert|insertmany|query|raw|save|scalar|select|update|updateone|updatemany|upsert)$/i.test(method);
  if (!databaseMethod) return false;
  if (/\b(?:prisma|sequelize|typeorm|mongoose|knex|database|connection|cursor|session|entitymanager|repository|repo|pool|db|transaction|trx|tx)\b/i.test(name)) return true;
  const root = name.split('.')[0] || '';
  return /^[A-Z][A-Za-z0-9_$]*(?:Model)?$/.test(root) && /^(?:aggregate|count|create|deleteMany|deleteOne|find|findById|findOne|insertMany|updateMany|updateOne)$/i.test(method);
}

function isTransactionCall(name: string): boolean {
  const method = name.split('.').at(-1) || '';
  if (!/^(?:begin|commit|flush|rollback|savepoint)$/i.test(method)) return false;
  return /(?:^|\.)(?:prisma|sequelize|database|connection|cursor|session|entitymanager|repository|repo|db|transaction|trx|tx)(?:\.|$)/i.test(name);
}

function jsChildren(node: any): any[] {
  const children: any[] = [];
  for (const [key, value] of Object.entries(node || {})) {
    if (['loc', 'start', 'end', 'extra', 'errors', 'comments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === 'object' && typeof item.type === 'string') children.push(item);
    } else if (value && typeof value === 'object' && typeof (value as any).type === 'string') children.push(value);
  }
  return children;
}

function isPacingAwait(node: any, content: string): boolean {
  if (node?.type !== 'AwaitExpression' || typeof node.start !== 'number' || typeof node.end !== 'number') return false;
  return /\b(?:aguardar|delay|pause|sleep|setTimeout|wait)\s*\(/i.test(content.slice(node.start, node.end));
}

function collectJavaScriptLoopSignals(loop: any, content: string): { awaitNode?: any; queryNode?: any; transactionNode?: any; pacing: boolean } {
  const signals: { awaitNode?: any; queryNode?: any; transactionNode?: any; pacing: boolean } = { pacing: false };
  const visit = (node: any, root = false): void => {
    if (!node || (!root && (JS_LOOP_TYPES.has(node.type) || JS_FUNCTION_TYPES.has(node.type)))) return;
    if (node.type === 'AwaitExpression') {
      if (isPacingAwait(node, content)) signals.pacing = true;
      else if (!signals.awaitNode) signals.awaitNode = node;
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const name = callName(node.callee, content);
      if (!signals.transactionNode && isTransactionCall(name)) signals.transactionNode = node;
      if (!signals.queryNode && isJavaScriptDatabaseCall(node, content)) signals.queryNode = node;
    }
    for (const child of jsChildren(node)) visit(child);
  };
  visit(loop.body, true);
  return signals;
}

function nearestJavaScriptFunction(ancestors: any[]): any | undefined {
  return [...ancestors].reverse().find(node => JS_FUNCTION_TYPES.has(node.type));
}

function isAwaitedByAncestor(ancestors: any[]): boolean {
  return [...ancestors].reverse().some(node => node.type === 'AwaitExpression');
}

function boundedCollection(node: any, content: string): boolean {
  if (!node) return false;
  const text = typeof node.start === 'number' && typeof node.end === 'number' ? content.slice(node.start, node.end) : '';
  return /(?:\.slice\s*\(|\b(?:batch|batches|chunk|chunks|limited|page|pageItems|window)\b)/i.test(text);
}

function structuralFinding(input: VelloxFindingInput): VelloxFindingInput {
  return input;
}

export function scanJavaScriptStructure(content: string, relativeFile: string): StructuralScanResult {
  const findings: VelloxFindingInput[] = [];
  const lines = content.split('\n');
  let program: any;
  try {
    const typescript = /\.(?:ts|tsx)$/i.test(relativeFile);
    const jsx = /\.(?:jsx|tsx)$/i.test(relativeFile);
    program = parse(content, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      allowAwaitOutsideFunction: true,
      plugins: [
        ...(typescript ? ['typescript' as const] : []),
        ...(jsx ? ['jsx' as const] : []),
        'decorators-legacy', 'classProperties', 'classPrivateProperties', 'classPrivateMethods',
        'dynamicImport', 'importAttributes', 'topLevelAwait'
      ]
    }).program;
  } catch {
    return { findings, parsed: false };
  }

  const walk = (node: any, ancestors: any[] = [], parent?: any): void => {
    const line = node.loc?.start?.line || (typeof node.start === 'number' ? lineAt(content, node.start) : 1);
    if (JS_LOOP_TYPES.has(node.type) && !ignoredAt(lines, line) && !intentionalLoopContext(lines, line)) {
      const signals = collectJavaScriptLoopSignals(node, content);
      const loopText = typeof node.start === 'number' && typeof node.end === 'number' ? content.slice(node.start, node.end) : '';
      const boundedBatch = /\b(?:batch|batches|chunk|chunks|lote|lotes|pageItems|window)\b/i.test(loopText)
        && /Promise\.(?:all|allSettled)\s*\(/.test(loopText);
      const signal = signals.transactionNode || signals.queryNode || (!signals.pacing && !boundedBatch ? signals.awaitNode : undefined);
      if (signal) {
        const signalLine = signal.loc?.start?.line || line;
        if (ignoredAt(lines, signalLine)) {
          const nextAncestors = [...ancestors, node];
          for (const child of jsChildren(node)) walk(child, nextAncestors, node);
          return;
        }
        const transaction = Boolean(signals.transactionNode);
        const query = !transaction && Boolean(signals.queryNode);
        findings.push(structuralFinding({
          ruleId: transaction ? 'code/transaction-in-loop' : query ? 'code/query-in-loop' : 'code/sequential-async-loop',
          severity: hotspotSeverity(relativeFile),
          category: 'code',
          title: transaction ? 'Transaction boundary inside a loop' : query ? 'Database operation inside a loop' : 'Sequential asynchronous work inside a loop',
          evidence: sourceLine(content, signalLine),
          recommendation: transaction
            ? 'Move the transaction boundary outside the loop and use a bulk operation where semantics allow it.'
            : query
              ? 'Fetch or mutate the required records in bulk to remove the N+1 database round trips.'
              : 'Batch the operation or use measured, bounded concurrency instead of awaiting every iteration.',
          file: relativeFile,
          line: signalLine,
          metadata: { parser: 'babel', loopStart: line, pattern: transaction ? 'transaction' : query ? 'database' : 'await' }
        }));
      }
    }

    if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && !ignoredAt(lines, line)) {
      const property = jsProperty(node, content);
      const callback = node.arguments?.find((argument: any) => JS_FUNCTION_TYPES.has(argument?.type));
      if (property === 'forEach' && callback?.async) {
        findings.push(structuralFinding({
          ruleId: 'code/async-foreach', severity: 'HIGH', category: 'code',
          title: 'Async forEach discards callback promises',
          evidence: sourceLine(content, line),
          recommendation: 'Use for...of for intentional sequencing or Promise.all with bounded batches for concurrency.',
          file: relativeFile, line, metadata: { parser: 'babel', pattern: 'async-forEach' }
        }));
      }

      if (property === 'map' && callback?.async && parent?.type === 'ExpressionStatement') {
        findings.push(structuralFinding({
          ruleId: 'code/dangling-async-map', severity: 'HIGH', category: 'code',
          title: 'Async map result is never awaited',
          evidence: sourceLine(content, line),
          recommendation: 'Await the returned promises with a bounded concurrency strategy and handle failures explicitly.',
          file: relativeFile, line, metadata: { parser: 'babel', pattern: 'dangling-async-map' }
        }));
      }

      const name = callName(node.callee, content);
      if (/^Promise\.(?:all|allSettled)$/.test(name)) {
        const argument = node.arguments?.[0];
        const mapCall = argument?.type === 'CallExpression' && jsProperty(argument, content) === 'map' ? argument : undefined;
        const mapText = mapCall && typeof mapCall.start === 'number' && typeof mapCall.end === 'number'
          ? content.slice(mapCall.start, mapCall.end)
          : '';
        const explicitLimiter = /\b(?:limit|limiter|semaphore|workerPool|pool)\s*\(/i.test(mapText);
        if (mapCall && !boundedCollection(mapCall.callee?.object, content) && !explicitLimiter) {
          findings.push(structuralFinding({
            ruleId: 'code/unbounded-async-fanout', severity: hotspotSeverity(relativeFile), category: 'code',
            title: 'Promise fan-out has no concurrency bound',
            evidence: sourceLine(content, line),
            recommendation: 'Process measured batches or use a concurrency limiter to protect memory, sockets, and downstream services.',
            file: relativeFile, line, metadata: { parser: 'babel', pattern: name }
          }));
        }
      }

      if (isJavaScriptDatabaseCall(node, content)) {
        const query = node.arguments?.[0];
        const dynamic = query?.type === 'BinaryExpression'
          || (query?.type === 'TemplateLiteral' && (query.expressions?.length || 0) > 0);
        if (dynamic) {
          findings.push(structuralFinding({
            ruleId: 'query/dynamic-sql-construction', severity: 'HIGH', category: 'query',
            title: 'SQL is assembled from runtime values',
            evidence: sourceLine(content, line),
            recommendation: 'Use driver placeholders or the ORM parameter API so values never change SQL structure or query-plan reuse.',
            file: relativeFile, line, metadata: { parser: 'babel', call: name }
          }));
        }
      }

      const blocking = /(?:^|\.)(?:appendFileSync|execFileSync|execSync|pbkdf2Sync|readFileSync|readdirSync|scryptSync|spawnSync|statSync|writeFileSync|writeFileSync|wait)$/i.test(name);
      const owner = nearestJavaScriptFunction(ancestors);
      if (blocking && owner?.async && !isAwaitedByAncestor(ancestors)) {
        findings.push(structuralFinding({
          ruleId: 'code/blocking-call-in-async', severity: hotspotSeverity(relativeFile), category: 'code',
          title: 'Blocking operation inside an async function',
          evidence: sourceLine(content, line),
          recommendation: 'Use the asynchronous API or move CPU/blocking work to a worker so the event loop remains available.',
          file: relativeFile, line, metadata: { parser: 'babel', call: name }
        }));
      }
    }

    const nextAncestors = [...ancestors, node];
    for (const child of jsChildren(node)) walk(child, nextAncestors, node);
  };
  walk(program);
  return { findings, parsed: true };
}

function pythonChildren(node: PythonNode): PythonNode[] {
  const children: PythonNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
  return children;
}

function pythonHasSyntaxError(node: PythonNode): boolean {
  if (node.type?.isError || node.name === '⚠') return true;
  return pythonChildren(node).some(pythonHasSyntaxError);
}

function pythonCallName(node: PythonNode, content: string): string {
  const text = content.slice(node.from, node.to);
  return text.slice(0, Math.max(0, text.indexOf('('))).trim();
}

function isPythonDatabaseCall(node: PythonNode, content: string): boolean {
  if (node.name !== 'CallExpression') return false;
  const name = pythonCallName(node, content);
  return /\.(?:execute|executemany|scalar|scalars|query|raw|find|find_one|find_many|aggregate|count|count_documents|insert_one|insert_many|update_one|update_many|delete_one|delete_many|get|all|first|one|one_or_none|filter|exclude|select_related|prefetch_related|bulk_create|bulk_update)\b/i.test(name)
    && /(?:^|\.)(?:objects|query|session|cursor|connection|database|db|repository|repo|collection)\b/i.test(name);
}

function collectPythonLoopSignals(loop: PythonNode, content: string): { awaitNode?: PythonNode; queryNode?: PythonNode; transactionNode?: PythonNode; pacing: boolean } {
  const signals: { awaitNode?: PythonNode; queryNode?: PythonNode; transactionNode?: PythonNode; pacing: boolean } = { pacing: false };
  const visit = (node: PythonNode, root = false): void => {
    if (!root && (PYTHON_LOOP_TYPES.has(node.name) || node.name === 'FunctionDefinition' || node.name === 'LambdaExpression')) return;
    if (node.name === 'AwaitExpression') {
      const awaitText = content.slice(node.from, node.to);
      if (/\b(?:asyncio\.)?(?:sleep|wait|wait_for)\s*\(/i.test(awaitText)) signals.pacing = true;
      else if (!signals.awaitNode) signals.awaitNode = node;
    }
    if (node.name === 'CallExpression') {
      const name = pythonCallName(node, content);
      if (!signals.transactionNode && isTransactionCall(name)) signals.transactionNode = node;
      if (!signals.queryNode && isPythonDatabaseCall(node, content)) signals.queryNode = node;
    }
    for (const child of pythonChildren(node)) visit(child);
  };
  visit(loop, true);
  return signals;
}

function nearestPythonFunction(ancestors: PythonNode[]): PythonNode | undefined {
  return [...ancestors].reverse().find(node => node.name === 'FunctionDefinition');
}

export function scanPythonStructure(content: string, relativeFile: string): StructuralScanResult {
  const findings: VelloxFindingInput[] = [];
  const lines = content.split('\n');
  let root: PythonNode;
  try {
    root = pythonParser.parse(content).topNode as unknown as PythonNode;
  } catch {
    return { findings, parsed: false };
  }
  if (pythonHasSyntaxError(root)) return { findings, parsed: false };

  const walk = (node: PythonNode, ancestors: PythonNode[] = []): void => {
    const line = lineAt(content, node.from);
    if (PYTHON_LOOP_TYPES.has(node.name) && !ignoredAt(lines, line) && !intentionalLoopContext(lines, line)) {
      const signals = collectPythonLoopSignals(node, content);
      const signal = signals.transactionNode || signals.queryNode || (!signals.pacing ? signals.awaitNode : undefined);
      if (signal) {
        const signalLine = lineAt(content, signal.from);
        if (ignoredAt(lines, signalLine)) {
          const nextAncestors = [...ancestors, node];
          for (const child of pythonChildren(node)) walk(child, nextAncestors);
          return;
        }
        const transaction = Boolean(signals.transactionNode);
        const query = !transaction && Boolean(signals.queryNode);
        findings.push(structuralFinding({
          ruleId: transaction ? 'code/transaction-in-loop' : query ? 'code/synchronous-query-loop' : 'code/sequential-async-loop',
          severity: hotspotSeverity(relativeFile), category: 'code',
          title: transaction ? 'Transaction boundary inside a loop' : query ? 'Synchronous database operation inside a loop' : 'Sequential asynchronous work inside a loop',
          evidence: sourceLine(content, signalLine),
          recommendation: transaction
            ? 'Move commit/flush outside the loop and use a bulk transaction where semantics allow it.'
            : query
              ? 'Prefetch or mutate the required records in bulk to remove the N+1 database round trips.'
              : 'Batch the operation or use measured, bounded asyncio concurrency.',
          file: relativeFile, line: signalLine,
          metadata: { parser: 'lezer-python', loopStart: line, pattern: transaction ? 'transaction' : query ? 'database' : 'await' }
        }));
      }
    }

    if (node.name === 'CallExpression' && !ignoredAt(lines, line)) {
      const name = pythonCallName(node, content);
      const callText = content.slice(node.from, node.to);
      if (/^(?:asyncio\.)?gather$/i.test(name) && /\bfor\b[\s\S]*\bin\b|\*\s*(?!batch|chunk|page|window)\w+/i.test(callText)) {
        findings.push(structuralFinding({
          ruleId: 'code/unbounded-async-fanout', severity: 'HIGH', category: 'code',
          title: 'Async gather has no concurrency bound', evidence: sourceLine(content, line),
          recommendation: 'Use a semaphore, worker queue, or measured batches to cap concurrent tasks.',
          file: relativeFile, line, metadata: { parser: 'lezer-python', pattern: 'asyncio.gather' }
        }));
      }

      const owner = nearestPythonFunction(ancestors);
      const asyncOwner = owner && /^\s*async\s+def\b/.test(content.slice(owner.from, owner.to));
      const awaited = ancestors.some(ancestor => ancestor.name === 'AwaitExpression');
      const insideLoop = ancestors.some(ancestor => PYTHON_LOOP_TYPES.has(ancestor.name));
      const blockingIo = /^(?:requests\.(?:delete|get|head|options|patch|post|put)|time\.sleep|subprocess\.(?:call|check_call|check_output|run)|os\.system|urllib\.request\.urlopen)$/i.test(name);
      const blockingDatabase = isPythonDatabaseCall(node, content);
      if (blockingDatabase && /\(\s*(?:f["']|["'][^"']*["']\s*(?:\+|%)|[^)]*\.format\s*\()/i.test(callText)) {
        findings.push(structuralFinding({
          ruleId: 'query/dynamic-sql-construction', severity: 'HIGH', category: 'query',
          title: 'SQL is assembled from runtime values', evidence: sourceLine(content, line),
          recommendation: 'Use bound parameters from the database driver instead of f-strings, concatenation, percent formatting, or .format().',
          file: relativeFile, line, metadata: { parser: 'lezer-python', call: name }
        }));
      }
      if (asyncOwner && !awaited && (blockingIo || (blockingDatabase && !insideLoop))) {
        findings.push(structuralFinding({
          ruleId: 'code/blocking-call-in-async', severity: 'HIGH', category: 'code',
          title: blockingDatabase ? 'Synchronous database call inside async code' : 'Blocking I/O inside async code',
          evidence: sourceLine(content, line),
          recommendation: blockingDatabase
            ? 'Use the async database driver/session or isolate the blocking work from the event loop.'
            : 'Use an async client/API or run the blocking operation in a bounded worker thread.',
          file: relativeFile, line, metadata: { parser: 'lezer-python', call: name }
        }));
      }
    }

    const nextAncestors = [...ancestors, node];
    for (const child of pythonChildren(node)) walk(child, nextAncestors);
  };
  walk(root);
  return { findings, parsed: true };
}
