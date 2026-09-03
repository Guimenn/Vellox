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
const JS_ITERATION_METHODS = new Set(['every', 'filter', 'flatMap', 'forEach', 'map', 'reduce', 'reduceRight', 'some']);
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
  return /^[A-Z][A-Za-z0-9_$]*(?:Model)?$/.test(root) && !/^[A-Z0-9_$]+$/.test(root)
    && /^(?:aggregate|count|create|deleteMany|deleteOne|find|findById|findOne|insertMany|updateMany|updateOne)$/i.test(method);
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

interface LoopSignals<Node> {
  awaitNode?: Node;
  queryNode?: Node;
  transactionNode?: Node;
  indirectQuery?: boolean;
  pacing: boolean;
}

interface FunctionSummary<Node> {
  node: Node;
  aliases: string[];
  calls: Set<string>;
  directDatabase: boolean;
}

function javascriptFunctionAliases(node: any, parent: any, content: string): string[] {
  if (node.type === 'FunctionDeclaration' && node.id?.name) return [node.id.name];
  if ((node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && parent?.type === 'VariableDeclarator') {
    const name = callName(parent.id, content);
    return name ? [name] : [];
  }
  if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod' || node.type === 'ObjectMethod') {
    const name = callName(node.key, content);
    return name ? [name, `this.${name}`] : [];
  }
  return [];
}

function collectJavaScriptQueryFunctions(program: any, content: string): Set<string> {
  const summaries: Array<FunctionSummary<any>> = [];
  const collect = (node: any, parent?: any): void => {
    if (JS_FUNCTION_TYPES.has(node?.type)) {
      const aliases = javascriptFunctionAliases(node, parent, content);
      if (aliases.length) {
        const summary: FunctionSummary<any> = { node, aliases, calls: new Set(), directDatabase: false };
        const inspect = (candidate: any, root = false): void => {
          if (!candidate || (!root && JS_FUNCTION_TYPES.has(candidate.type))) return;
          if (candidate.type === 'CallExpression' || candidate.type === 'OptionalCallExpression') {
            if (isJavaScriptDatabaseCall(candidate, content)) summary.directDatabase = true;
            else {
              const name = callName(candidate.callee, content);
              if (name) summary.calls.add(name);
            }
          }
          for (const child of jsChildren(candidate)) inspect(child);
        };
        inspect(node.body, true);
        summaries.push(summary);
      }
    }
    for (const child of jsChildren(node)) collect(child, node);
  };
  collect(program);

  const queryFunctions = new Set<string>();
  for (const summary of summaries) if (summary.directDatabase) summary.aliases.forEach(alias => queryFunctions.add(alias));
  let changed = true;
  while (changed) {
    changed = false;
    for (const summary of summaries) {
      if (summary.aliases.some(alias => queryFunctions.has(alias))) continue;
      if ([...summary.calls].some(name => queryFunctions.has(name))) {
        summary.aliases.forEach(alias => queryFunctions.add(alias));
        changed = true;
      }
    }
  }
  return queryFunctions;
}

function collectJavaScriptLoopSignals(loop: any, content: string, queryFunctions: Set<string>): LoopSignals<any> {
  const signals: LoopSignals<any> = { pacing: false };
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
      else if (!signals.queryNode && queryFunctions.has(name)) {
        signals.queryNode = node;
        signals.indirectQuery = true;
      }
    }
    for (const child of jsChildren(node)) visit(child);
  };
  visit(loop.body, true);
  return signals;
}

function javascriptFunctionContainsQuery(node: any, content: string, queryFunctions: Set<string>): boolean {
  let found = false;
  const visit = (candidate: any, root = false): void => {
    if (!candidate || found || (!root && JS_FUNCTION_TYPES.has(candidate.type))) return;
    if (candidate.type === 'CallExpression' || candidate.type === 'OptionalCallExpression') {
      const name = callName(candidate.callee, content);
      if (isJavaScriptDatabaseCall(candidate, content) || queryFunctions.has(name)) {
        found = true;
        return;
      }
    }
    for (const child of jsChildren(candidate)) visit(child);
  };
  visit(node, true);
  return found;
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
  return { confidence: 'HIGH', ...input };
}

function nearestJavaScriptIteration(ancestors: any[], content: string, position?: number): any | undefined {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = ancestors[index];
    if (JS_LOOP_TYPES.has(candidate?.type)) {
      if (position === undefined || typeof candidate.body?.start !== 'number' || position >= candidate.body.start) return candidate;
      continue;
    }
    if (JS_FUNCTION_TYPES.has(candidate?.type)) {
      const owner = ancestors[index - 1];
      if ((owner?.type === 'CallExpression' || owner?.type === 'OptionalCallExpression')
        && owner.arguments?.includes(candidate)
        && JS_ITERATION_METHODS.has(jsProperty(owner, content))) return owner;
      return undefined;
    }
  }
  return undefined;
}

function staticallyBoundedJavaScriptIteration(node: any, content: string): boolean {
  if (!node) return false;
  const text = typeof node.start === 'number' && typeof node.end === 'number' ? content.slice(node.start, node.end) : '';
  if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && boundedCollection(node.callee?.object, content)) return true;
  if (node.type === 'ForOfStatement' && node.right?.type === 'ArrayExpression' && (node.right.elements?.length || 0) <= 100) return true;
  if (node.type === 'ForStatement' && /(?:<|<=)\s*(?:[1-9]|[1-9]\d|100)\b/.test(text.slice(0, Math.max(0, text.indexOf(')') + 1)))) return true;
  return false;
}

interface JavaScriptIterationDescriptor {
  item: string;
  collectionNode: any;
  collection: string;
  body: string;
}

function javascriptIterationDescriptor(node: any, content: string): JavaScriptIterationDescriptor | undefined {
  if (node?.type === 'ForOfStatement' || node?.type === 'ForInStatement') {
    const left = node.left?.type === 'VariableDeclaration' ? node.left.declarations?.[0]?.id : node.left;
    const item = callName(left, content);
    const collection = callName(node.right, content);
    const body = typeof node.body?.start === 'number' && typeof node.body?.end === 'number' ? content.slice(node.body.start, node.body.end) : '';
    return item && collection ? { item, collectionNode: node.right, collection, body } : undefined;
  }
  if (node?.type === 'CallExpression' || node?.type === 'OptionalCallExpression') {
    const callback = node.arguments?.find((argument: any) => JS_FUNCTION_TYPES.has(argument?.type));
    const item = callName(callback?.params?.[0], content);
    const collectionNode = node.callee?.object;
    const collection = callName(collectionNode, content);
    const body = typeof callback?.body?.start === 'number' && typeof callback?.body?.end === 'number' ? content.slice(callback.body.start, callback.body.end) : '';
    return item && collection ? { item, collectionNode, collection, body } : undefined;
  }
  return undefined;
}

function wordAppears(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}\\b`).test(text);
}

function looksLikeQuadraticJavaScriptJoin(inner: any, outer: any, content: string): boolean {
  const innerDescriptor = javascriptIterationDescriptor(inner, content);
  const outerDescriptor = javascriptIterationDescriptor(outer, content);
  if (!innerDescriptor || !outerDescriptor) return false;
  if (!likelyJavaScriptCollection(innerDescriptor.collectionNode, content)
    || !likelyJavaScriptCollection(outerDescriptor.collectionNode, content)) return false;
  if (/(?:matchAll|split|Object\.(?:entries|keys|values))\s*\(/.test(innerDescriptor.collection)
    || /^[A-Z][A-Z0-9_]*$/.test(innerDescriptor.collection)) return false;
  return wordAppears(innerDescriptor.body, innerDescriptor.item) && wordAppears(innerDescriptor.body, outerDescriptor.item);
}

function javascriptContainerText(node: any, ancestors: any[], content: string): string {
  const container = [...ancestors].reverse().find(candidate => /(?:Statement|Declaration)$/.test(candidate?.type || '')) || node;
  return typeof container.start === 'number' && typeof container.end === 'number'
    ? content.slice(container.start, container.end)
    : '';
}

function likelyJavaScriptCollection(node: any, content: string): boolean {
  if (node?.type === 'ArrayExpression' || node?.type === 'NewExpression' && callName(node.callee, content) === 'Array') return true;
  const name = callName(node, content).split('.').at(-1) || '';
  return /(?:array|collection|entries|ids|items|list|records|results|rows|users|orders|products|events|members|permissions|roles|values)$/i.test(name);
}

function isUnboundedJavaScriptOrmRead(node: any, ancestors: any[], content: string): boolean {
  if (!isJavaScriptDatabaseCall(node, content) || nearestJavaScriptIteration(ancestors, content, node.start)) return false;
  const name = callName(node.callee, content);
  const method = name.split('.').at(-1) || '';
  if (!/^(?:find|findAll|findMany)$/i.test(method)) return false;
  const container = javascriptContainerText(node, ancestors, content);
  return !/(?:\b(?:limit|take)\s*:|\.(?:limit|take|slice)\s*\()/i.test(container);
}

function sameJavaScriptExpression(left: any, right: any, content: string): boolean {
  const leftName = callName(left, content);
  const rightName = callName(right, content);
  return Boolean(leftName && rightName && leftName === rightName);
}

function javascriptCopyOnGrow(node: any, ancestors: any[], content: string): string | undefined {
  const repeatedBy = nearestJavaScriptIteration(ancestors, content, node.start);
  if (!repeatedBy || staticallyBoundedJavaScriptIteration(repeatedBy, content)) return undefined;

  if (node.type === 'AssignmentExpression' && node.operator === '=') {
    const right = node.right;
    const spreads = right?.type === 'ArrayExpression'
      ? right.elements?.filter((element: any) => element?.type === 'SpreadElement') || []
      : right?.type === 'ObjectExpression'
        ? right.properties?.filter((property: any) => property?.type === 'SpreadElement') || []
        : [];
    if (spreads.some((spread: any) => sameJavaScriptExpression(node.left, spread.argument, content))) return 'self-spread';
    if (right?.type === 'CallExpression' || right?.type === 'OptionalCallExpression') {
      if (jsProperty(right, content) === 'concat' && sameJavaScriptExpression(node.left, right.callee?.object, content)) return 'self-concat';
    }
  }

  if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression')) {
    const method = jsProperty(node, content);
    if (method === 'unshift') return 'front-insert';
    if (method === 'splice' && node.arguments?.[0]?.type === 'NumericLiteral' && node.arguments[0].value === 0) return 'front-splice';
  }

  if (node.type === 'ArrayExpression' || node.type === 'ObjectExpression') {
    const iteration = nearestJavaScriptIteration(ancestors, content, node.start);
    if (jsProperty(iteration, content) !== 'reduce') return undefined;
    const callback = iteration.arguments?.find((argument: any) => JS_FUNCTION_TYPES.has(argument?.type));
    const accumulator = callback?.params?.[0];
    const spreads = node.type === 'ArrayExpression'
      ? node.elements?.filter((element: any) => element?.type === 'SpreadElement') || []
      : node.properties?.filter((property: any) => property?.type === 'SpreadElement') || [];
    if (spreads.some((spread: any) => sameJavaScriptExpression(accumulator, spread.argument, content))) return 'reduce-spread';
  }
  return undefined;
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
  const queryFunctions = collectJavaScriptQueryFunctions(program, content);

  const walk = (node: any, ancestors: any[] = [], parent?: any): void => {
    const line = node.loc?.start?.line || (typeof node.start === 'number' ? lineAt(content, node.start) : 1);
    const growthPattern = !ignoredAt(lines, line) ? javascriptCopyOnGrow(node, ancestors, content) : undefined;
    if (growthPattern) {
      findings.push(structuralFinding({
        ruleId: 'code/quadratic-collection-growth', severity: 'MEDIUM', category: 'code',
        title: 'Collection is copied while it grows inside an iteration', evidence: sourceLine(content, line),
        recommendation: growthPattern.startsWith('front-')
          ? 'Append in iteration order and reverse once if needed; inserting at index zero shifts the existing collection every time.'
          : 'Mutate a local accumulator with push/Object.assign, or collect entries and construct the final value once after the iteration.',
        file: relativeFile, line, metadata: { parser: 'babel', pattern: growthPattern }
      }));
    }
    if (JS_LOOP_TYPES.has(node.type) && !ignoredAt(lines, line) && !intentionalLoopContext(lines, line)) {
      const outerIteration = nearestJavaScriptIteration(ancestors, content);
      if (outerIteration && !staticallyBoundedJavaScriptIteration(node, content) && !staticallyBoundedJavaScriptIteration(outerIteration, content)
        && looksLikeQuadraticJavaScriptJoin(node, outerIteration, content)) {
        findings.push(structuralFinding({
          ruleId: 'code/quadratic-nested-iteration', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Nested iteration can grow quadratically', evidence: sourceLine(content, line),
          recommendation: 'Index one collection with a Map/Set or replace the nested scan with a single-pass join.',
          file: relativeFile, line, metadata: { parser: 'babel', outerLoopStart: outerIteration.loc?.start?.line || line }
        }));
      }
      const signals = collectJavaScriptLoopSignals(node, content, queryFunctions);
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
          confidence: signals.indirectQuery ? 'MEDIUM' : 'HIGH',
          category: 'code',
          title: transaction ? 'Transaction boundary inside a loop' : query
            ? signals.indirectQuery ? 'Function reaching the database is called inside a loop' : 'Database operation inside a loop'
            : 'Sequential asynchronous work inside a loop',
          evidence: sourceLine(content, signalLine),
          recommendation: transaction
            ? 'Move the transaction boundary outside the loop and use a bulk operation where semantics allow it.'
            : query
              ? 'Fetch or mutate the required records in bulk to remove the N+1 database round trips.'
              : 'Batch the operation or use measured, bounded concurrency instead of awaiting every iteration.',
          file: relativeFile,
          line: signalLine,
          metadata: { parser: 'babel', loopStart: line, pattern: transaction ? 'transaction' : query ? signals.indirectQuery ? 'indirect-database' : 'database' : 'await' }
        }));
      }
    }

    if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && !ignoredAt(lines, line)) {
      const property = jsProperty(node, content);
      const callback = node.arguments?.find((argument: any) => JS_FUNCTION_TYPES.has(argument?.type));
      const repeatedBy = nearestJavaScriptIteration(ancestors, content, node.start);
      const databaseCall = isJavaScriptDatabaseCall(node, content);

      if (repeatedBy && !staticallyBoundedJavaScriptIteration(repeatedBy, content)
        && !boundedCollection(node.callee?.object, content)
        && /^(?:every|flatMap|forEach|map|reduce|reduceRight)$/.test(property)
        && looksLikeQuadraticJavaScriptJoin(node, repeatedBy, content)) {
        findings.push(structuralFinding({
          ruleId: 'code/quadratic-nested-iteration', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Nested collection pass can grow quadratically', evidence: sourceLine(content, line),
          recommendation: 'Pre-index the inner collection or combine both passes into a single linear traversal.',
          file: relativeFile, line, metadata: { parser: 'babel', pattern: property }
        }));
      }

      const linearMethod = /^(?:find|findIndex|includes|indexOf|some)$/.test(property);
      const smallLiteral = node.callee?.object?.type === 'ArrayExpression' && (node.callee.object.elements?.length || 0) <= 100;
      if (repeatedBy && linearMethod && !smallLiteral && !databaseCall && likelyJavaScriptCollection(node.callee?.object, content)) {
        findings.push(structuralFinding({
          ruleId: 'code/linear-search-in-loop', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Linear collection lookup is repeated inside an iteration', evidence: sourceLine(content, line),
          recommendation: 'Build a Map or Set once before the loop so each lookup is constant-time.',
          file: relativeFile, line, metadata: { parser: 'babel', method: property }
        }));
      }

      if (repeatedBy && property === 'sort') {
        findings.push(structuralFinding({
          ruleId: 'code/repeated-sort-in-loop', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Collection is sorted repeatedly inside an iteration', evidence: sourceLine(content, line),
          recommendation: 'Sort once before the loop or maintain an indexed structure instead of repeating O(n log n) work.',
          file: relativeFile, line, metadata: { parser: 'babel', method: 'sort' }
        }));
      }
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
          const mapCallback = mapCall.arguments?.find((argument: any) => JS_FUNCTION_TYPES.has(argument?.type));
          const queryFanout = Boolean(mapCallback && javascriptFunctionContainsQuery(mapCallback.body, content, queryFunctions));
          findings.push(structuralFinding({
            ruleId: queryFanout ? 'code/unbounded-query-fanout' : 'code/unbounded-async-fanout', severity: hotspotSeverity(relativeFile), category: 'code',
            title: queryFanout ? 'Database query fan-out has no concurrency bound' : 'Promise fan-out has no concurrency bound',
            evidence: sourceLine(content, line),
            recommendation: queryFanout
              ? 'Cap database concurrency with measured batches or a limiter; prefer one bulk query when the data model allows it.'
              : 'Process measured batches or use a concurrency limiter to protect memory, sockets, and downstream services.',
            file: relativeFile, line, metadata: { parser: 'babel', pattern: name, database: queryFanout }
          }));
        }
      }

      if (databaseCall) {
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

      if (isUnboundedJavaScriptOrmRead(node, ancestors, content)) {
        findings.push(structuralFinding({
          ruleId: 'query/unbounded-orm-read', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'query',
          title: 'ORM collection read has no explicit bound', evidence: sourceLine(content, line),
          recommendation: 'Add cursor/keyset pagination or a measured take/limit before materializing the result set.',
          file: relativeFile, line, metadata: { parser: 'babel', call: name }
        }));
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
  const callee = node.firstChild;
  return callee ? content.slice(callee.from, callee.to).trim() : '';
}

function isPythonDatabaseCall(node: PythonNode, content: string): boolean {
  if (node.name !== 'CallExpression') return false;
  const name = pythonCallName(node, content);
  return /\.(?:execute|executemany|scalar|scalars|query|raw|find|find_one|find_many|aggregate|count|count_documents|insert_one|insert_many|update_one|update_many|delete_one|delete_many|get|all|first|one|one_or_none|filter|exclude|select_related|prefetch_related|bulk_create|bulk_update)\b/i.test(name)
    && /(?:^|\.)(?:objects|query|session|cursor|connection|database|db|repository|repo|collection)\b/i.test(name);
}

function pythonFunctionAliases(node: PythonNode, content: string): string[] {
  const header = content.slice(node.from, Math.min(node.to, content.indexOf(':', node.from) + 1));
  const name = /\bdef\s+([A-Za-z_]\w*)\s*\(/.exec(header)?.[1];
  return name ? [name, `self.${name}`, `cls.${name}`] : [];
}

function collectPythonQueryFunctions(root: PythonNode, content: string): Set<string> {
  const summaries: Array<FunctionSummary<PythonNode>> = [];
  const collect = (node: PythonNode): void => {
    if (node.name === 'FunctionDefinition') {
      const aliases = pythonFunctionAliases(node, content);
      if (aliases.length) {
        const summary: FunctionSummary<PythonNode> = { node, aliases, calls: new Set(), directDatabase: false };
        const inspect = (candidate: PythonNode, rootNode = false): void => {
          if (!rootNode && candidate.name === 'FunctionDefinition') return;
          if (candidate.name === 'CallExpression') {
            if (isPythonDatabaseCall(candidate, content)) summary.directDatabase = true;
            else {
              const name = pythonCallName(candidate, content);
              if (name) summary.calls.add(name);
            }
          }
          for (const child of pythonChildren(candidate)) inspect(child);
        };
        inspect(node, true);
        summaries.push(summary);
      }
    }
    for (const child of pythonChildren(node)) collect(child);
  };
  collect(root);

  const queryFunctions = new Set<string>();
  for (const summary of summaries) if (summary.directDatabase) summary.aliases.forEach(alias => queryFunctions.add(alias));
  let changed = true;
  while (changed) {
    changed = false;
    for (const summary of summaries) {
      if (summary.aliases.some(alias => queryFunctions.has(alias))) continue;
      if ([...summary.calls].some(name => queryFunctions.has(name))) {
        summary.aliases.forEach(alias => queryFunctions.add(alias));
        changed = true;
      }
    }
  }
  return queryFunctions;
}

function collectPythonLoopSignals(loop: PythonNode, content: string, queryFunctions: Set<string>): LoopSignals<PythonNode> {
  const signals: LoopSignals<PythonNode> = { pacing: false };
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
      else if (!signals.queryNode && queryFunctions.has(name)) {
        signals.queryNode = node;
        signals.indirectQuery = true;
      }
    }
    for (const child of pythonChildren(node)) visit(child);
  };
  visit(loop, true);
  return signals;
}

function pythonNodeContainsQuery(node: PythonNode, content: string, queryFunctions: Set<string>): boolean {
  let found = false;
  const visit = (candidate: PythonNode, root = false): void => {
    if (found || (!root && candidate.name === 'FunctionDefinition')) return;
    if (candidate.name === 'CallExpression') {
      const name = pythonCallName(candidate, content);
      if (isPythonDatabaseCall(candidate, content) || queryFunctions.has(name)) {
        found = true;
        return;
      }
    }
    for (const child of pythonChildren(candidate)) visit(child);
  };
  visit(node, true);
  return found;
}

function nearestPythonFunction(ancestors: PythonNode[]): PythonNode | undefined {
  return [...ancestors].reverse().find(node => node.name === 'FunctionDefinition');
}

function nearestPythonLoop(ancestors: PythonNode[], position?: number): PythonNode | undefined {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = ancestors[index]!;
    if (PYTHON_LOOP_TYPES.has(candidate.name)) {
      const body = pythonChildren(candidate).find(child => child.name === 'Body');
      if (position === undefined || !body || position >= body.from) return candidate;
      continue;
    }
    if (candidate.name === 'FunctionDefinition' || candidate.name === 'LambdaExpression') return undefined;
  }
  return undefined;
}

function staticallyBoundedPythonLoop(node: PythonNode, content: string): boolean {
  const header = content.slice(node.from, Math.min(node.to, content.indexOf(':', node.from) + 1));
  const range = /\brange\s*\(\s*(?:[1-9]|[1-9]\d|100)\s*\)/.test(header);
  const literal = /\bin\s*(?:\[[^\]]{0,300}\]|\([^)]{0,300}\))\s*:/.test(header);
  return range || literal;
}

function looksLikeQuadraticPythonJoin(inner: PythonNode, outer: PythonNode, content: string): boolean {
  const descriptor = (node: PythonNode): { item: string; collection: string; body: string } | undefined => {
    const loop = content.slice(node.from, node.to);
    const header = loop.slice(0, Math.max(0, loop.indexOf(':')));
    const match = /^\s*for\s+([A-Za-z_]\w*)\s+in\s+([A-Za-z_]\w*)\s*$/.exec(header);
    return match ? { item: match[1]!, collection: match[2]!, body: loop.slice(header.length + 1) } : undefined;
  };
  const innerDescriptor = descriptor(inner);
  const outerDescriptor = descriptor(outer);
  if (!innerDescriptor || !outerDescriptor) return false;
  if (!likelyPythonLinearCollection(innerDescriptor.collection) || !likelyPythonLinearCollection(outerDescriptor.collection)) return false;
  return wordAppears(innerDescriptor.body, innerDescriptor.item) && wordAppears(innerDescriptor.body, outerDescriptor.item);
}

function pythonContainerText(node: PythonNode, ancestors: PythonNode[], content: string): string {
  const container = [...ancestors].reverse().find(candidate => /(?:Statement|Definition)$/.test(candidate.name)) || node;
  return content.slice(container.from, container.to);
}

function likelyPythonLinearCollection(name: string): boolean {
  return /(?:_array|_collection|_entries|_ids|_items|_list|_records|_results|_rows|_users|_orders|_products|_events|_members|_permissions|_roles|_values|arrays?|collections?|entries|ids|items|lists?|records?|results?|rows|users|orders|products|events|members|permissions|roles|values)$/i.test(name)
    && !/(?:_set|_map|_dict|sets?|maps?|dicts?)$/i.test(name);
}

function isUnboundedPythonOrmRead(node: PythonNode, ancestors: PythonNode[], content: string): boolean {
  if (!isPythonDatabaseCall(node, content) || nearestPythonLoop(ancestors, node.from)) return false;
  const name = pythonCallName(node, content);
  const method = name.match(/\.([A-Za-z_]\w*)\s*$/)?.[1] || '';
  const container = pythonContainerText(node, ancestors, content);
  const collectionRead = /^(?:all|filter|find|find_many)$/i.test(method)
    || /^(?:execute|scalar|scalars)$/i.test(method) && /\bselect\s*\(/i.test(container);
  if (!collectionRead) return false;
  if (/\b(?:func\.)?(?:count|min|max|avg|sum)\s*\(/i.test(container)) return false;
  return !/(?:\.limit\s*\(|\[\s*:\s*\d+\s*\]|\.(?:first|one|one_or_none)\s*\(|\b(?:take|limit)\s*=)/i.test(container)
    && !/(?:filter|filter_by)\s*\([^)]*\bid\s*(?:==|=)/i.test(container);
}

function pythonCopyOnGrow(node: PythonNode, ancestors: PythonNode[], content: string): string | undefined {
  const repeatedBy = nearestPythonLoop(ancestors, node.from);
  if (!repeatedBy || staticallyBoundedPythonLoop(repeatedBy, content)) return undefined;
  const expression = content.slice(node.from, node.to).trim();
  if (node.name === 'AssignStatement') {
    const target = /^([A-Za-z_]\w*)\s*=/.exec(expression)?.[1];
    if (!target) return undefined;
    const escaped = target.replace(/[$()*+.?[\]^{|}]/g, '\\$&');
    if (new RegExp(`^${escaped}\\s*=\\s*${escaped}\\s*\\+\\s*\\[`).test(expression)) return 'self-list-concat';
    if (new RegExp(`^${escaped}\\s*=\\s*\\[\\s*\\*${escaped}\\b`).test(expression)) return 'self-list-spread';
    if (new RegExp(`^${escaped}\\s*=\\s*\\{\\s*\\*\\*${escaped}\\b`).test(expression)) return 'self-dict-spread';
  }
  if (node.name === 'CallExpression') {
    const name = pythonCallName(node, content);
    if (/\.insert$/.test(name) && /^\(\s*0\s*,/.test(expression.slice(name.length))) return 'front-insert';
  }
  return undefined;
}

function isQuadraticPythonFlatten(node: PythonNode, content: string): boolean {
  if (node.name !== 'CallExpression' || pythonCallName(node, content) !== 'sum') return false;
  const expression = content.slice(node.from, node.to);
  return /^sum\s*\(\s*[^,]+,\s*\[\s*\]\s*\)$/s.test(expression);
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
  const queryFunctions = collectPythonQueryFunctions(root, content);

  const walk = (node: PythonNode, ancestors: PythonNode[] = []): void => {
    const line = lineAt(content, node.from);
    const growthPattern = !ignoredAt(lines, line) ? pythonCopyOnGrow(node, ancestors, content) : undefined;
    if (growthPattern) {
      findings.push(structuralFinding({
        ruleId: 'code/quadratic-collection-growth', severity: 'MEDIUM', category: 'code',
        title: 'Collection is copied while it grows inside an iteration', evidence: sourceLine(content, line),
        recommendation: growthPattern === 'front-insert'
          ? 'Append in iteration order and reverse once if needed; inserting at index zero shifts the existing list every time.'
          : 'Mutate a local list/dict accumulator, or collect entries and construct the final value once after the loop.',
        file: relativeFile, line, metadata: { parser: 'lezer-python', pattern: growthPattern }
      }));
    }
    if (!ignoredAt(lines, line) && isQuadraticPythonFlatten(node, content)) {
      findings.push(structuralFinding({
        ruleId: 'code/quadratic-list-flatten', severity: 'MEDIUM', category: 'code',
        title: 'Lists are flattened through repeated concatenation', evidence: sourceLine(content, line),
        recommendation: 'Use itertools.chain.from_iterable(chunks) or a comprehension so the output is built in one pass.',
        file: relativeFile, line, metadata: { parser: 'lezer-python', pattern: 'sum-lists' }
      }));
    }
    if (PYTHON_LOOP_TYPES.has(node.name) && !ignoredAt(lines, line) && !intentionalLoopContext(lines, line)) {
      const outerLoop = nearestPythonLoop(ancestors);
      if (outerLoop && !staticallyBoundedPythonLoop(node, content) && !staticallyBoundedPythonLoop(outerLoop, content)
        && looksLikeQuadraticPythonJoin(node, outerLoop, content)) {
        findings.push(structuralFinding({
          ruleId: 'code/quadratic-nested-iteration', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Nested iteration can grow quadratically', evidence: sourceLine(content, line),
          recommendation: 'Index one collection with a dict/set or replace the nested scan with a single-pass join.',
          file: relativeFile, line, metadata: { parser: 'lezer-python', outerLoopStart: lineAt(content, outerLoop.from) }
        }));
      }
      const signals = collectPythonLoopSignals(node, content, queryFunctions);
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
          severity: hotspotSeverity(relativeFile), confidence: signals.indirectQuery ? 'MEDIUM' : 'HIGH', category: 'code',
          title: transaction ? 'Transaction boundary inside a loop' : query
            ? signals.indirectQuery ? 'Function reaching the database is called inside a loop' : 'Synchronous database operation inside a loop'
            : 'Sequential asynchronous work inside a loop',
          evidence: sourceLine(content, signalLine),
          recommendation: transaction
            ? 'Move commit/flush outside the loop and use a bulk transaction where semantics allow it.'
            : query
              ? 'Prefetch or mutate the required records in bulk to remove the N+1 database round trips.'
              : 'Batch the operation or use measured, bounded asyncio concurrency.',
          file: relativeFile, line: signalLine,
          metadata: { parser: 'lezer-python', loopStart: line, pattern: transaction ? 'transaction' : query ? signals.indirectQuery ? 'indirect-database' : 'database' : 'await' }
        }));
      }
    }

    if (node.name === 'CallExpression' && !ignoredAt(lines, line)) {
      const name = pythonCallName(node, content);
      const callText = content.slice(node.from, node.to);
      const repeatedBy = nearestPythonLoop(ancestors, node.from);
      const databaseCall = isPythonDatabaseCall(node, content);

      if (repeatedBy && !staticallyBoundedPythonLoop(repeatedBy, content)) {
        const method = name.match(/\.([A-Za-z_]\w*)\s*$/)?.[1] || name;
        const receiver = name.includes('.') ? name.slice(0, name.lastIndexOf('.')).split('.').at(-1) || '' : '';
        if (/^(?:count|index)$/.test(method) && likelyPythonLinearCollection(receiver) && !databaseCall) {
          findings.push(structuralFinding({
            ruleId: 'code/linear-search-in-loop', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
            title: 'Linear collection lookup is repeated inside a loop', evidence: sourceLine(content, line),
            recommendation: 'Build a dict or set once before the loop so each lookup is constant-time.',
            file: relativeFile, line, metadata: { parser: 'lezer-python', method }
          }));
        }
        if (name === 'sorted' || method === 'sort') {
          findings.push(structuralFinding({
            ruleId: 'code/repeated-sort-in-loop', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
            title: 'Collection is sorted repeatedly inside a loop', evidence: sourceLine(content, line),
            recommendation: 'Sort once before the loop or maintain an indexed structure instead of repeating O(n log n) work.',
            file: relativeFile, line, metadata: { parser: 'lezer-python', method: name === 'sorted' ? 'sorted' : 'sort' }
          }));
        }
      }
      const gatherWork = /\bfor\b[\s\S]*\bin\b|\*\s*\w+/i.test(callText);
      const boundedGather = /\bfor\b[\s\S]*\bin\s+(?:batch|chunk|limited|page|window)\w*\b/i.test(callText)
        || /\*\s*(?:batch|chunk|limited|page|window)\w*\b/i.test(callText)
        || /\b(?:bounded|limited|limiter|semaphore|workerPool)\w*\s*\(/i.test(callText);
      if (/^(?:asyncio\.)?gather$/i.test(name) && gatherWork && !boundedGather) {
        const queryFanout = pythonNodeContainsQuery(node, content, queryFunctions);
        findings.push(structuralFinding({
          ruleId: queryFanout ? 'code/unbounded-query-fanout' : 'code/unbounded-async-fanout', severity: 'HIGH', category: 'code',
          title: queryFanout ? 'Database query fan-out has no concurrency bound' : 'Async gather has no concurrency bound', evidence: sourceLine(content, line),
          recommendation: queryFanout
            ? 'Cap database concurrency with a semaphore or measured batches; prefer one bulk query when possible.'
            : 'Use a semaphore, worker queue, or measured batches to cap concurrent tasks.',
          file: relativeFile, line, metadata: { parser: 'lezer-python', pattern: 'asyncio.gather', database: queryFanout }
        }));
      }

      const owner = nearestPythonFunction(ancestors);
      const asyncOwner = owner && /^\s*async\s+def\b/.test(content.slice(owner.from, owner.to));
      const awaited = ancestors.some(ancestor => ancestor.name === 'AwaitExpression');
      const insideLoop = ancestors.some(ancestor => PYTHON_LOOP_TYPES.has(ancestor.name));
      const blockingIo = /^(?:requests\.(?:delete|get|head|options|patch|post|put)|time\.sleep|subprocess\.(?:call|check_call|check_output|run)|os\.system|urllib\.request\.urlopen)$/i.test(name);
      const blockingDatabase = databaseCall;
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

      if (isUnboundedPythonOrmRead(node, ancestors, content)) {
        findings.push(structuralFinding({
          ruleId: 'query/unbounded-orm-read', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'query',
          title: 'ORM collection read has no explicit bound', evidence: sourceLine(content, line),
          recommendation: 'Add cursor/keyset pagination or a measured limit before materializing the result set.',
          file: relativeFile, line, metadata: { parser: 'lezer-python', call: name }
        }));
      }
    }

    if (node.name === 'BinaryExpression' && !ignoredAt(lines, line)) {
      const repeatedBy = nearestPythonLoop(ancestors, node.from);
      const expression = content.slice(node.from, node.to);
      const membership = /^(.+?)\s+(?:not\s+)?in\s+([A-Za-z_]\w*)\s*$/.exec(expression);
      if (repeatedBy && membership && likelyPythonLinearCollection(membership[2] || '')) {
        findings.push(structuralFinding({
          ruleId: 'code/linear-search-in-loop', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Linear membership lookup is repeated inside a loop', evidence: sourceLine(content, line),
          recommendation: 'Convert the lookup collection to a set once before the loop.',
          file: relativeFile, line, metadata: { parser: 'lezer-python', method: 'in' }
        }));
      }
    }

    const nextAncestors = [...ancestors, node];
    for (const child of pythonChildren(node)) walk(child, nextAncestors);
  };
  walk(root);
  return { findings, parsed: true };
}
