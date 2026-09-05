import { parse } from '@babel/parser';
import { parser as pythonParser } from '@lezer/python';
import { Severity, VelloxFindingInput } from './types.js';

export interface StructuralScanResult {
  findings: VelloxFindingInput[];
  parsed: boolean;
  parseError?: { line?: number; parser: 'babel' | 'lezer-python' };
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
  const header = lines[line - 1] || '';
  return /\b(?:attempts?|retries|retry|tentativas?)\b/i.test(header)
    || /\b(?:batch(?:es)?|chunks?|lotes?|cursor|hasMore|nextPage|pageSize|pageNumber|currentPage|pagina(?:s|ção)?|página(?:s|ção)?)\b/i.test(context)
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
  const databaseMethod = /^(?:\$executeraw(?:unsafe)?|\$queryraw(?:unsafe)?|aggregate|bulkcreate|bulkdelete|bulkwrite|count|countdocuments|create|delete|deleteone|deletemany|destroy|execute|executemany|find|findall|findbyid|findbyidandupdate|findfirst|findmany|findone|findoneandupdate|findunique|insert|insertmany|query|raw|save|scalar|select|update|updateone|updatemany|upsert)$/i.test(method);
  if (!databaseMethod) return false;
  if (/\b(?:prisma|sequelize|typeorm|mongoose|knex|database|connection|cursor|session|entitymanager|repository|repo|pool|db|transaction|trx|tx)\b/i.test(name)) return true;
  const root = name.split('.')[0] || '';
  return /^[A-Z][A-Za-z0-9_$]*(?:Model)?$/.test(root) && !/^[A-Z0-9_$]+$/.test(root)
    && /^(?:aggregate|count|create|deleteMany|deleteOne|find|findById|findOne|insertMany|updateMany|updateOne)$/i.test(method);
}

function isJavaScriptRawSqlCall(node: any, content: string): boolean {
  if (!isJavaScriptDatabaseCall(node, content)) return false;
  const method = callName(node.callee, content).split('.').at(-1) || '';
  return /^(?:\$executeraw(?:unsafe)?|\$queryraw(?:unsafe)?|execute|executemany|query|raw)$/i.test(method);
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
  crossFileQuery?: boolean;
  queryPath?: string;
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

function collectJavaScriptQueryFunctions(program: any, content: string, externalQueryFunctions: ReadonlyMap<string, string>): Set<string> {
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

  const queryFunctions = new Set<string>(externalQueryFunctions.keys());
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

function collectJavaScriptLoopSignals(loop: any, content: string, queryFunctions: Set<string>, externalQueryFunctions: ReadonlyMap<string, string>): LoopSignals<any> {
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
        signals.crossFileQuery = externalQueryFunctions.has(name);
        signals.queryPath = externalQueryFunctions.get(name);
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

function javascriptExternalQueryPath(node: any, content: string, externalQueryFunctions: ReadonlyMap<string, string>): string | undefined {
  let path: string | undefined;
  const visit = (candidate: any, root = false): void => {
    if (!candidate || path || (!root && JS_FUNCTION_TYPES.has(candidate.type))) return;
    if (candidate.type === 'CallExpression' || candidate.type === 'OptionalCallExpression') {
      path = externalQueryFunctions.get(callName(candidate.callee, content));
      if (path) return;
    }
    for (const child of jsChildren(candidate)) visit(child);
  };
  visit(node, true);
  return path;
}

function nearestJavaScriptFunction(ancestors: any[]): any | undefined {
  return [...ancestors].reverse().find(node => JS_FUNCTION_TYPES.has(node.type));
}

function isAwaitedByAncestor(ancestors: any[]): boolean {
  return [...ancestors].reverse().some(node => node.type === 'AwaitExpression');
}

const MAX_STATIC_ITERATION_BOUND = 100;

function staticCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

interface JavaScriptBoundedBindings {
  byOwner: WeakMap<object, Map<string, number>>;
  program: object;
}

function javascriptScopeOwner(ancestors: any[], program: any): object {
  return [...ancestors].reverse().find(node => JS_FUNCTION_TYPES.has(node?.type)) || program;
}

function collectJavaScriptBoundedBindings(program: any, content: string): JavaScriptBoundedBindings {
  const owners = new Set<object>([program]);
  const constants = new WeakMap<object, Map<string, number>>();
  const assignments = new WeakMap<object, Map<string, number>>();
  const byOwner = new WeakMap<object, Map<string, number>>();
  const ensure = (owner: object): void => {
    owners.add(owner);
    if (!constants.has(owner)) constants.set(owner, new Map());
    if (!assignments.has(owner)) assignments.set(owner, new Map());
    if (!byOwner.has(owner)) byOwner.set(owner, new Map());
  };
  const firstPass = (node: any, owner: object): void => {
    const nextOwner = JS_FUNCTION_TYPES.has(node?.type) ? node : owner;
    ensure(nextOwner);
    if (node?.type === 'VariableDeclaration') {
      for (const declaration of node.declarations || []) {
        if (declaration.id?.type !== 'Identifier') continue;
        const name = declaration.id.name;
        const counts = assignments.get(nextOwner)!;
        counts.set(name, (counts.get(name) || 0) + 1);
        const constant = declaration.init?.type === 'NumericLiteral' ? staticCount(declaration.init.value) : undefined;
        if (constant !== undefined) constants.get(nextOwner)!.set(name, constant);
      }
    }
    if (node?.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
      const counts = assignments.get(nextOwner)!;
      counts.set(node.left.name, (counts.get(node.left.name) || 0) + 1);
    }
    for (const child of jsChildren(node)) firstPass(child, nextOwner);
  };
  firstPass(program, program);
  for (const owner of owners) {
    for (const [name, value] of constants.get(owner) || []) byOwner.get(owner)!.set(name, value);
  }

  const boundedExpression = (node: any, owner: object): number | undefined => {
    if (!node) return undefined;
    const bounds = byOwner.get(owner)!;
    const numeric = (candidate: any): number | undefined => {
      if (candidate?.type === 'NumericLiteral') return staticCount(candidate.value);
      if (candidate?.type === 'Identifier') return constants.get(owner)?.get(candidate.name) ?? constants.get(program)?.get(candidate.name);
      return undefined;
    };
    if (node.type === 'Identifier') return bounds.get(node.name);
    if (node.type === 'ArrayExpression') {
      const size = node.elements?.length || 0;
      return !(node.elements || []).some((element: any) => element?.type === 'SpreadElement') ? size : undefined;
    }
    if (node.type === 'NewExpression' && jsNameForBound(node.callee, content) === 'Array') {
      const size = numeric(node.arguments?.[0]);
      return size;
    }
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return undefined;
    const name = jsNameForBound(node.callee, content);
    if (name === 'Array.from') {
      const length = node.arguments?.[0]?.properties?.find((property: any) => jsNameForBound(property.key, content) === 'length')?.value;
      const size = numeric(length);
      return size;
    }
    if (jsProperty(node, content) !== 'slice') return undefined;
    const start = numeric(node.arguments?.[0]);
    const end = numeric(node.arguments?.[1]);
    return (start === undefined || start === 0) && end !== undefined
      ? end - (start || 0)
      : undefined;
  };

  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: any, owner: object): void => {
      const nextOwner = JS_FUNCTION_TYPES.has(node?.type) ? node : owner;
      if (node?.type === 'VariableDeclaration') {
        for (const declaration of node.declarations || []) {
          if (declaration.id?.type !== 'Identifier' || assignments.get(nextOwner)?.get(declaration.id.name) !== 1) continue;
          const bounds = byOwner.get(nextOwner)!;
          const bound = boundedExpression(declaration.init, nextOwner);
          if (!bounds.has(declaration.id.name) && bound !== undefined) {
            bounds.set(declaration.id.name, bound);
            changed = true;
          }
        }
      }
      for (const child of jsChildren(node)) visit(child, nextOwner);
    };
    visit(program, program);
  }
  return { byOwner, program };
}

function jsNameForBound(node: any, content: string): string {
  return callName(node, content);
}

function javascriptCollectionBound(node: any, content: string, bindings: ReadonlyMap<string, number> = new Map()): number | undefined {
  if (!node) return undefined;
  const name = callName(node, content);
  const binding = bindings.get(name);
  if (binding !== undefined) return binding;
  if (node.type === 'ArrayExpression' && !(node.elements || []).some((element: any) => element?.type === 'SpreadElement')) {
    return node.elements?.length || 0;
  }
  const numeric = (candidate: any): number | undefined => candidate?.type === 'NumericLiteral'
    ? staticCount(candidate.value)
    : candidate?.type === 'Identifier' ? bindings.get(candidate.name) : undefined;
  if (node.type === 'NewExpression' && callName(node.callee, content) === 'Array') return numeric(node.arguments?.[0]);
  if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && callName(node.callee, content) === 'Array.from') {
    const length = node.arguments?.[0]?.properties?.find((property: any) => callName(property.key, content) === 'length')?.value;
    return numeric(length);
  }
  if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && jsProperty(node, content) === 'slice') {
    const start = numeric(node.arguments?.[0]) ?? 0;
    const end = numeric(node.arguments?.[1]);
    return end !== undefined ? staticCount(Math.max(0, end - start)) : undefined;
  }
  return undefined;
}

function boundedCollection(node: any, content: string, bindings: ReadonlyMap<string, number> = new Map()): boolean {
  const name = callName(node, content);
  const bound = javascriptCollectionBound(node, content, bindings);
  return bound !== undefined && bound <= MAX_STATIC_ITERATION_BOUND
    || node?.type === 'Identifier' && /^(?:batch|batches|chunk|chunks|limited|page|pageItems|window)$/i.test(name);
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

function javascriptIterationBound(node: any, content: string, bindings: ReadonlyMap<string, number> = new Map()): number | undefined {
  if (!node) return undefined;
  const text = typeof node.start === 'number' && typeof node.end === 'number' ? content.slice(node.start, node.end) : '';
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') return javascriptCollectionBound(node.callee?.object, content, bindings);
  if (node.type === 'ForOfStatement') return javascriptCollectionBound(node.right, content, bindings);
  if (node.type === 'ForStatement') {
    const header = text.slice(0, Math.max(0, text.indexOf(')') + 1));
    const match = /(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*0\s*;[\s\S]*?\b\1\s*(<|<=)\s*(\d+)\b/.exec(header);
    if (match) {
      const bound = Number(match[3]) + (match[2] === '<=' ? 1 : 0);
      if (Number.isSafeInteger(bound)) return bound;
    }
  }
  return undefined;
}

function staticallyBoundedJavaScriptIteration(node: any, content: string, bindings: ReadonlyMap<string, number> = new Map()): boolean {
  const bound = javascriptIterationBound(node, content, bindings);
  return bound !== undefined && bound <= MAX_STATIC_ITERATION_BOUND;
}

function javascriptDominatingGuardBound(node: any, ancestors: any[], content: string): number | undefined {
  if (node?.type !== 'ForOfStatement') return undefined;
  const collection = callName(node.right, content);
  if (!/^[A-Za-z_$][\w$]*$/.test(collection)) return undefined;
  const parent = ancestors.at(-1);
  const statements = parent?.type === 'BlockStatement' && Array.isArray(parent.body) ? parent.body : undefined;
  const position = statements?.indexOf(node) ?? -1;
  const guard = position > 0 ? statements?.[position - 1] : undefined;
  if (guard?.type !== 'IfStatement' || guard.alternate) return undefined;
  const exits = guard.consequent?.type === 'ReturnStatement' || guard.consequent?.type === 'ThrowStatement'
    || guard.consequent?.type === 'BlockStatement'
      && guard.consequent.body?.length === 1
      && ['ReturnStatement', 'ThrowStatement'].includes(guard.consequent.body[0]?.type);
  if (!exits || guard.test?.type !== 'BinaryExpression') return undefined;
  const left = callName(guard.test.left, content);
  const right = callName(guard.test.right, content);
  const operator = guard.test.operator;
  let limit: number | undefined;
  if (left === `${collection}.length` && guard.test.right?.type === 'NumericLiteral' && (operator === '>' || operator === '>=')) {
    limit = staticCount(guard.test.right.value);
    if (limit !== undefined && operator === '>=') limit -= 1;
  } else if (right === `${collection}.length` && guard.test.left?.type === 'NumericLiteral' && (operator === '<' || operator === '<=')) {
    limit = staticCount(guard.test.left.value);
    if (limit !== undefined && operator === '<=') limit -= 1;
  }
  return limit !== undefined && limit >= 0 ? limit : undefined;
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

function unwrapJavaScriptExpression(node: any): any {
  let current = node;
  while (['ParenthesizedExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(current?.type)) {
    current = current.expression;
  }
  return current;
}

function javascriptObjectProperty(node: any, names: ReadonlySet<string>): any | undefined {
  const object = unwrapJavaScriptExpression(node);
  if (object?.type !== 'ObjectExpression') return undefined;
  return object.properties?.find((property: any) => {
    if (property?.type !== 'ObjectProperty' && property?.type !== 'ObjectMethod') return false;
    const key = property.key;
    const name = !property.computed && key?.type === 'Identifier'
      ? key.name
      : ['StringLiteral', 'NumericLiteral'].includes(key?.type)
        ? String(key.value)
        : undefined;
    return Boolean(name && names.has(name));
  });
}

function hasDirectJavaScriptOrmBound(options: any): boolean {
  return Boolean(javascriptObjectProperty(options, new Set(['limit', 'take'])));
}

function hasDirectJavaScriptUniqueIdFilter(options: any): boolean {
  const whereProperty = javascriptObjectProperty(options, new Set(['where']));
  const idProperty = javascriptObjectProperty(whereProperty?.value, new Set(['_id', 'id']));
  if (!idProperty || idProperty.type !== 'ObjectProperty') return false;
  const value = unwrapJavaScriptExpression(idProperty.value);
  if (!value || ['ArrayExpression', 'NullLiteral'].includes(value.type)) return false;
  if (value.type !== 'ObjectExpression') return true;
  const properties = value.properties?.filter((property: any) => property?.type === 'ObjectProperty') || [];
  return properties.length === 1 && Boolean(javascriptObjectProperty(value, new Set(['equals'])));
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
  const options = node.arguments?.[0];
  if (/^(?:findAll|findMany)$/i.test(method)) {
    if (hasDirectJavaScriptOrmBound(options) || hasDirectJavaScriptUniqueIdFilter(options)) return false;
    return true;
  }
  const container = javascriptContainerText(node, ancestors, content);
  return !/\.(?:limit|take|slice)\s*\(/i.test(container);
}

function sameJavaScriptExpression(left: any, right: any, content: string): boolean {
  const leftName = callName(left, content);
  const rightName = callName(right, content);
  return Boolean(leftName && rightName && leftName === rightName);
}

function javascriptCopyOnGrow(node: any, ancestors: any[], content: string, bindings: ReadonlyMap<string, number>): string | undefined {
  const repeatedBy = nearestJavaScriptIteration(ancestors, content, node.start);
  if (!repeatedBy || staticallyBoundedJavaScriptIteration(repeatedBy, content, bindings)) return undefined;

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

function javascriptExpressionTainted(node: any, tainted: ReadonlySet<string>, content: string): boolean {
  if (!node) return false;
  if (node.type === 'Identifier') return tainted.has(node.name);
  const name = callName(node, content);
  if (/^(?:ctx|context|req|request)\.(?:body|cookies|headers|params|query)(?:\.|$)/i.test(name)) return true;
  if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression')
    && /^(?:Number|parseFloat|parseInt)$/.test(callName(node.callee, content))) return false;
  return jsChildren(node).some(child => javascriptExpressionTainted(child, tainted, content));
}

function collectJavaScriptTaintedBindings(program: any, content: string): WeakMap<object, Set<string>> {
  const byOwner = new WeakMap<object, Set<string>>();
  const ensure = (owner: object): Set<string> => {
    let values = byOwner.get(owner);
    if (!values) {
      values = new Set();
      byOwner.set(owner, values);
    }
    return values;
  };
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: any, owner: object): void => {
      const nextOwner = JS_FUNCTION_TYPES.has(node?.type) ? node : owner;
      const tainted = ensure(nextOwner);
      if (node?.type === 'VariableDeclarator' && javascriptExpressionTainted(node.init, tainted, content)) {
        const names = node.id?.type === 'ObjectPattern'
          ? (node.id.properties || []).map((property: any) => callName(property.value, content))
          : [callName(node.id, content)];
        for (const name of names.filter(Boolean)) {
          if (!tainted.has(name)) {
            tainted.add(name);
            changed = true;
          }
        }
      }
      if (node?.type === 'AssignmentExpression' && javascriptExpressionTainted(node.right, tainted, content)) {
        const name = callName(node.left, content);
        if (/^[A-Za-z_$][\w$]*$/.test(name) && !tainted.has(name)) {
          tainted.add(name);
          changed = true;
        }
      }
      for (const child of jsChildren(node)) visit(child, nextOwner);
    };
    visit(program, program);
  }
  return byOwner;
}

export function scanJavaScriptStructure(content: string, relativeFile: string, externalQueryFunctions: ReadonlyMap<string, string> = new Map()): StructuralScanResult {
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
  } catch (error) {
    return { findings, parsed: false, parseError: { line: (error as { loc?: { line?: number } }).loc?.line, parser: 'babel' } };
  }
  const queryFunctions = collectJavaScriptQueryFunctions(program, content, externalQueryFunctions);
  const boundedBindings = collectJavaScriptBoundedBindings(program, content);
  const taintedBindings = collectJavaScriptTaintedBindings(program, content);

  const walk = (node: any, ancestors: any[] = [], parent?: any): void => {
    const line = node.loc?.start?.line || (typeof node.start === 'number' ? lineAt(content, node.start) : 1);
    const bindings = boundedBindings.byOwner.get(javascriptScopeOwner(ancestors, boundedBindings.program)) || new Map<string, number>();
    const tainted = taintedBindings.get(javascriptScopeOwner(ancestors, boundedBindings.program)) || new Set<string>();
    const growthPattern = !ignoredAt(lines, line) ? javascriptCopyOnGrow(node, ancestors, content, bindings) : undefined;
    if (growthPattern) {
      findings.push(structuralFinding({
        ruleId: 'code/quadratic-collection-growth', severity: 'MEDIUM', category: 'code',
        title: 'Collection is copied while it grows inside an iteration', evidence: sourceLine(content, line),
        recommendation: growthPattern.startsWith('front-')
          ? 'Append in iteration order and reverse once if needed; inserting at index zero shifts the existing collection every time.'
          : 'Mutate a local accumulator with push/Object.assign, or collect entries and construct the final value once after the iteration.',
        file: relativeFile, line, metadata: { parser: 'babel', pattern: growthPattern, complexity: 'O(n^2)' }
      }));
    }
    if (JS_LOOP_TYPES.has(node.type) && !ignoredAt(lines, line) && !intentionalLoopContext(lines, line)) {
      const outerIteration = nearestJavaScriptIteration(ancestors, content);
      if (outerIteration && !staticallyBoundedJavaScriptIteration(node, content, bindings) && !staticallyBoundedJavaScriptIteration(outerIteration, content, bindings)
        && looksLikeQuadraticJavaScriptJoin(node, outerIteration, content)) {
        findings.push(structuralFinding({
          ruleId: 'code/quadratic-nested-iteration', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Nested iteration can grow quadratically', evidence: sourceLine(content, line),
          recommendation: 'Index one collection with a Map/Set or replace the nested scan with a single-pass join.',
          file: relativeFile, line, metadata: { parser: 'babel', outerLoopStart: outerIteration.loc?.start?.line || line, complexity: 'O(n*m)' }
        }));
      }
      const signals = collectJavaScriptLoopSignals(node, content, queryFunctions, externalQueryFunctions);
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
        const iterationBound = javascriptIterationBound(node, content, bindings)
          ?? javascriptDominatingGuardBound(node, ancestors, content);
        const defaultSeverity = hotspotSeverity(relativeFile);
        findings.push(structuralFinding({
          ruleId: transaction ? 'code/transaction-in-loop' : query ? 'code/query-in-loop' : 'code/sequential-async-loop',
          severity: iterationBound !== undefined && iterationBound <= MAX_STATIC_ITERATION_BOUND && defaultSeverity === 'HIGH' ? 'MEDIUM' : defaultSeverity,
          confidence: signals.indirectQuery ? 'MEDIUM' : 'HIGH',
          category: 'code',
          title: transaction ? 'Transaction boundary inside a loop' : query
            ? signals.crossFileQuery ? 'Imported function reaching the database is called inside a loop'
              : signals.indirectQuery ? 'Function reaching the database is called inside a loop' : 'Database operation inside a loop'
            : 'Sequential asynchronous work inside a loop',
          evidence: sourceLine(content, signalLine),
          recommendation: transaction
            ? 'Move the transaction boundary outside the loop and use a bulk operation where semantics allow it.'
            : query
              ? 'Fetch or mutate the required records in bulk to remove the N+1 database round trips.'
              : 'Batch the operation or use measured, bounded concurrency instead of awaiting every iteration.',
          file: relativeFile,
          line: signalLine,
          metadata: {
            parser: 'babel', loopStart: line,
            complexity: 'O(n)', operationsPerIteration: 1,
            iterationBound: iterationBound ?? 'input-dependent',
            pattern: transaction ? 'transaction' : query ? signals.crossFileQuery ? 'cross-file-database' : signals.indirectQuery ? 'indirect-database' : 'database' : 'await',
            ...(signals.queryPath ? { callPath: signals.queryPath } : {})
          }
        }));
      }
    }

    if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && !ignoredAt(lines, line)) {
      const property = jsProperty(node, content);
      const callback = node.arguments?.find((argument: any) => JS_FUNCTION_TYPES.has(argument?.type));
      const callbackReference = node.arguments?.[0];
      const callbackName = !JS_FUNCTION_TYPES.has(callbackReference?.type) ? callName(callbackReference, content) : '';
      const repeatedBy = nearestJavaScriptIteration(ancestors, content, node.start);
      const databaseCall = isJavaScriptDatabaseCall(node, content);
      const rawSqlCall = isJavaScriptRawSqlCall(node, content);

      const promiseFanoutParent = (parent?.type === 'CallExpression' || parent?.type === 'OptionalCallExpression')
        && /^Promise\.(?:all|allSettled)$/.test(callName(parent.callee, content));
      if (JS_ITERATION_METHODS.has(property) && callbackName && queryFunctions.has(callbackName) && !promiseFanoutParent) {
        const queryPath = externalQueryFunctions.get(callbackName);
        const iterationBound = javascriptCollectionBound(node.callee?.object, content, bindings);
        const defaultSeverity = hotspotSeverity(relativeFile);
        findings.push(structuralFinding({
          ruleId: 'code/query-in-loop',
          severity: iterationBound !== undefined && iterationBound <= MAX_STATIC_ITERATION_BOUND && defaultSeverity === 'HIGH' ? 'MEDIUM' : defaultSeverity,
          confidence: 'MEDIUM', category: 'code', title: 'Callback reaching the database runs once per collection item',
          evidence: sourceLine(content, line),
          recommendation: 'Fetch or mutate the required records in bulk, or apply measured bounded concurrency when bulk semantics are unavailable.',
          file: relativeFile, line,
          metadata: {
            parser: 'babel', pattern: queryPath ? 'cross-file-callback-database' : 'callback-database',
            complexity: 'O(n)', operationsPerIteration: 1,
            iterationBound: iterationBound ?? 'input-dependent',
            ...(queryPath ? { callPath: queryPath } : {})
          }
        }));
      }

      if (repeatedBy && !staticallyBoundedJavaScriptIteration(repeatedBy, content, bindings)
        && !boundedCollection(node.callee?.object, content, bindings)
        && /^(?:every|flatMap|forEach|map|reduce|reduceRight)$/.test(property)
        && looksLikeQuadraticJavaScriptJoin(node, repeatedBy, content)) {
        findings.push(structuralFinding({
          ruleId: 'code/quadratic-nested-iteration', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Nested collection pass can grow quadratically', evidence: sourceLine(content, line),
          recommendation: 'Pre-index the inner collection or combine both passes into a single linear traversal.',
          file: relativeFile, line, metadata: { parser: 'babel', pattern: property, complexity: 'O(n*m)' }
        }));
      }

      const linearMethod = /^(?:find|findIndex|includes|indexOf|some)$/.test(property);
      const smallLiteral = node.callee?.object?.type === 'ArrayExpression' && (node.callee.object.elements?.length || 0) <= 100;
      if (repeatedBy && !staticallyBoundedJavaScriptIteration(repeatedBy, content, bindings)
        && linearMethod && !smallLiteral && !databaseCall && likelyJavaScriptCollection(node.callee?.object, content)) {
        findings.push(structuralFinding({
          ruleId: 'code/linear-search-in-loop', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Linear collection lookup is repeated inside an iteration', evidence: sourceLine(content, line),
          recommendation: 'Build a Map or Set once before the loop so each lookup is constant-time.',
          file: relativeFile, line, metadata: { parser: 'babel', method: property, complexity: 'O(n*m)' }
        }));
      }

      if (repeatedBy && !staticallyBoundedJavaScriptIteration(repeatedBy, content, bindings) && property === 'sort') {
        findings.push(structuralFinding({
          ruleId: 'code/repeated-sort-in-loop', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Collection is sorted repeatedly inside an iteration', evidence: sourceLine(content, line),
          recommendation: 'Sort once before the loop or maintain an indexed structure instead of repeating O(n log n) work.',
          file: relativeFile, line, metadata: { parser: 'babel', method: 'sort', complexity: 'O(n*m log m)' }
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
        if (mapCall && !boundedCollection(mapCall.callee?.object, content, bindings) && !explicitLimiter) {
          const mapCallback = mapCall.arguments?.[0];
          const callbackName = callName(mapCallback, content);
          const inlineCallback = JS_FUNCTION_TYPES.has(mapCallback?.type);
          const queryFanout = inlineCallback
            ? javascriptFunctionContainsQuery(mapCallback.body, content, queryFunctions)
            : queryFunctions.has(callbackName);
          const queryPath = inlineCallback
            ? javascriptExternalQueryPath(mapCallback.body, content, externalQueryFunctions)
            : externalQueryFunctions.get(callbackName);
          const taskUpperBound = javascriptCollectionBound(mapCall.callee?.object, content, bindings);
          findings.push(structuralFinding({
            ruleId: queryFanout ? 'code/unbounded-query-fanout' : 'code/unbounded-async-fanout', severity: hotspotSeverity(relativeFile), category: 'code',
            title: queryFanout ? 'Database query fan-out has no concurrency bound' : 'Promise fan-out has no concurrency bound',
            evidence: sourceLine(content, line),
            recommendation: queryFanout
              ? 'Cap database concurrency with measured batches or a limiter; prefer one bulk query when the data model allows it.'
              : 'Process measured batches or use a concurrency limiter to protect memory, sockets, and downstream services.',
            file: relativeFile, line, metadata: {
              parser: 'babel', pattern: name, database: queryFanout,
              complexity: 'O(n)', taskUpperBound: taskUpperBound ?? 'input-dependent',
              ...(queryPath ? { callPath: queryPath } : {})
            }
          }));
        }
      }

      if (rawSqlCall) {
        const query = node.arguments?.[0];
        const dynamic = query?.type === 'BinaryExpression'
          || (query?.type === 'TemplateLiteral' && (query.expressions?.length || 0) > 0);
        const queryTainted = javascriptExpressionTainted(query, tainted, content);
        if (dynamic || queryTainted) {
          findings.push(structuralFinding({
            ruleId: 'query/dynamic-sql-construction', severity: 'HIGH', category: 'query',
            title: 'SQL is assembled from runtime values',
            evidence: sourceLine(content, line),
            recommendation: 'Use driver placeholders or the ORM parameter API so values never change SQL structure or query-plan reuse.',
            file: relativeFile, line, metadata: { parser: 'babel', call: name }
          }));
        }
        if (queryTainted) {
          findings.push(structuralFinding({
            ruleId: 'security/sql-injection-flow', severity: 'CRITICAL', category: 'security',
            title: 'Untrusted request data reaches a database query', evidence: sourceLine(content, line),
            recommendation: 'Bind the request value through the driver or ORM parameter API; never concatenate or interpolate it into SQL text.',
            file: relativeFile, line, metadata: { parser: 'babel', call: name, source: 'request-data', sink: 'database-query' }
          }));
        }
      }

      if (!ignoredAt(lines, line) && isUnboundedJavaScriptOrmRead(node, ancestors, content)) {
        findings.push(structuralFinding({
          ruleId: 'query/unbounded-orm-read', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'query',
          title: 'ORM collection read has no explicit bound', evidence: sourceLine(content, line),
          recommendation: 'Add cursor/keyset pagination or a measured take/limit. If the business domain is provably small, document that review with // @vellox-ignore.',
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

function pythonAsyncYieldRecovery(node: PythonNode, content: string): boolean {
  if (node.from !== node.to || content[node.from] !== '\n') return false;
  const lineStart = content.lastIndexOf('\n', Math.max(0, node.from - 1)) + 1;
  if (!/^yield(?:\s|$)/.test(content.slice(lineStart, node.from).trim())) return false;
  const definitions = [...content.slice(0, lineStart).matchAll(/^\s*(async\s+)?def\s+/gm)];
  return Boolean(definitions.at(-1)?.[1]);
}

function pythonSyntaxError(node: PythonNode, content: string): PythonNode | undefined {
  if ((node.type?.isError || node.name === '⚠') && !pythonAsyncYieldRecovery(node, content)) return node;
  for (const child of pythonChildren(node)) {
    const error = pythonSyntaxError(child, content);
    if (error) return error;
  }
  return undefined;
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

function collectPythonQueryFunctions(root: PythonNode, content: string, externalQueryFunctions: ReadonlyMap<string, string>): Set<string> {
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

  const queryFunctions = new Set<string>(externalQueryFunctions.keys());
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

function collectPythonLoopSignals(loop: PythonNode, content: string, queryFunctions: Set<string>, externalQueryFunctions: ReadonlyMap<string, string>): LoopSignals<PythonNode> {
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
        signals.crossFileQuery = externalQueryFunctions.has(name);
        signals.queryPath = externalQueryFunctions.get(name);
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

function pythonExternalQueryPath(node: PythonNode, content: string, externalQueryFunctions: ReadonlyMap<string, string>): string | undefined {
  let path: string | undefined;
  const visit = (candidate: PythonNode, root = false): void => {
    if (path || (!root && candidate.name === 'FunctionDefinition')) return;
    if (candidate.name === 'CallExpression') {
      path = externalQueryFunctions.get(pythonCallName(candidate, content));
      if (path) return;
    }
    for (const child of pythonChildren(candidate)) visit(child);
  };
  visit(node, true);
  return path;
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

interface PythonBoundedBindings {
  byOwner: Map<string, Map<string, number>>;
  root: string;
}

function pythonScopeKey(node: PythonNode): string {
  return `${node.from}:${node.to}`;
}

function pythonScopeOwner(ancestors: PythonNode[], root: PythonNode): string {
  return pythonScopeKey([...ancestors].reverse().find(node => node.name === 'FunctionDefinition') || root);
}

function collectPythonBoundedBindings(root: PythonNode, content: string): PythonBoundedBindings {
  const rootKey = pythonScopeKey(root);
  const constants = new Map<string, Map<string, number>>();
  const assignments = new Map<string, Map<string, number>>();
  const byOwner = new Map<string, Map<string, number>>();
  const ensure = (owner: string): void => {
    if (!constants.has(owner)) constants.set(owner, new Map());
    if (!assignments.has(owner)) assignments.set(owner, new Map());
    if (!byOwner.has(owner)) byOwner.set(owner, new Map());
  };
  const firstPass = (node: PythonNode, owner: string): void => {
    const nextOwner = node.name === 'FunctionDefinition' ? pythonScopeKey(node) : owner;
    ensure(nextOwner);
    if (node.name === 'AssignStatement') {
      const expression = content.slice(node.from, node.to).trim();
      const match = /^([A-Za-z_]\w*)\s*=\s*(.+)$/s.exec(expression);
      if (match) {
        const counts = assignments.get(nextOwner)!;
        counts.set(match[1]!, (counts.get(match[1]!) || 0) + 1);
        const constant = /^\d+$/.test(match[2]!.trim()) ? staticCount(Number(match[2]!.trim())) : undefined;
        if (constant !== undefined) constants.get(nextOwner)!.set(match[1]!, constant);
      }
    }
    for (const child of pythonChildren(node)) firstPass(child, nextOwner);
  };
  firstPass(root, rootKey);
  for (const [owner, values] of constants) {
    for (const [name, value] of values) byOwner.get(owner)!.set(name, value);
  }

  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: PythonNode, owner: string): void => {
      const nextOwner = node.name === 'FunctionDefinition' ? pythonScopeKey(node) : owner;
      if (node.name === 'AssignStatement') {
        const expression = content.slice(node.from, node.to).trim();
        const match = /^([A-Za-z_]\w*)\s*=\s*(.+)$/s.exec(expression);
        if (match && assignments.get(nextOwner)?.get(match[1]!) === 1) {
          const bounds = byOwner.get(nextOwner)!;
          const boundValue = (raw: string): number | undefined => {
            if (/^\d+$/.test(raw)) return staticCount(Number(raw));
            return constants.get(nextOwner)?.get(raw) ?? constants.get(rootKey)?.get(raw);
          };
          const slice = /\[\s*([A-Za-z_]\w*|\d+)?\s*:\s*([A-Za-z_]\w*|\d+)\s*\]\s*$/.exec(match[2]!);
          const islice = /\bislice\s*\([^,]+,\s*(?:([A-Za-z_]\w*|\d+)\s*,\s*)?([A-Za-z_]\w*|\d+)\s*\)/.exec(match[2]!);
          const start = boundValue(slice?.[1] || islice?.[1] || '0') || 0;
          const end = boundValue(slice?.[2] || islice?.[2] || '');
          const limit = end === undefined ? undefined : Math.max(0, end - start);
          if (!bounds.has(match[1]!) && limit !== undefined && limit >= 0) {
            bounds.set(match[1]!, limit);
            changed = true;
          }
        }
      }
      for (const child of pythonChildren(node)) visit(child, nextOwner);
    };
    visit(root, rootKey);
  }
  return { byOwner, root: rootKey };
}

function pythonExpressionTainted(expression: string, tainted: ReadonlySet<string>): boolean {
  if (/^\s*(?:Decimal|UUID|float|int)\s*\(/.test(expression)) return false;
  if (/\b(?:ctx|context|req|request)\.(?:args|body|cookies|form|headers|json|path_params|query_params)(?:\.|\[|\b)/i.test(expression)) return true;
  return [...tainted].some(name => new RegExp(`\\b${name}\\b`).test(expression));
}

function collectPythonTaintedBindings(root: PythonNode, content: string): Map<string, Set<string>> {
  const rootKey = pythonScopeKey(root);
  const byOwner = new Map<string, Set<string>>([[rootKey, new Set()]]);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: PythonNode, owner: string): void => {
      const nextOwner = node.name === 'FunctionDefinition' ? pythonScopeKey(node) : owner;
      const values = byOwner.get(nextOwner) || new Set<string>();
      byOwner.set(nextOwner, values);
      if (node.name === 'AssignStatement') {
        const assignment = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(content.slice(node.from, node.to).trim());
        if (assignment && pythonExpressionTainted(assignment[2]!, values) && !values.has(assignment[1]!)) {
          values.add(assignment[1]!);
          changed = true;
        }
      }
      for (const child of pythonChildren(node)) visit(child, nextOwner);
    };
    visit(root, rootKey);
  }
  return byOwner;
}

function pythonSqlArgumentTainted(callText: string, tainted: ReadonlySet<string>): boolean {
  const open = callText.indexOf('(');
  if (open < 0) return false;
  const argument = callText.slice(open + 1).trim();
  const variable = /^([A-Za-z_]\w*)\s*(?:,|\))/.exec(argument)?.[1];
  if (variable && tainted.has(variable)) return true;
  const dynamic = /^(?:f["']|["'][\s\S]*["']\s*(?:\+|%)|[\s\S]*\.format\s*\()/i.test(argument);
  return dynamic && pythonExpressionTainted(argument, tainted);
}

function pythonIterationBound(node: PythonNode, content: string, bindings: ReadonlyMap<string, number> = new Map()): number | undefined {
  const lineEnd = content.indexOf('\n', node.from);
  const header = content.slice(node.from, Math.min(node.to, lineEnd < 0 ? node.to : lineEnd));
  const value = (raw: string): number | undefined => /^-?\d+$/.test(raw.trim())
    ? Number(raw.trim())
    : bindings.get(raw.trim());
  const range = /\brange\s*\(([^()]*)\)/.exec(header);
  if (range) {
    const args = range[1]!.split(',').map(part => value(part));
    if (args.length >= 1 && args.length <= 3 && args.every(item => item !== undefined)) {
      const start = args.length === 1 ? 0 : args[0]!;
      const stop = args.length === 1 ? args[0]! : args[1]!;
      const step = args.length === 3 ? args[2]! : 1;
      if (step !== 0) {
        const count = step > 0 ? Math.max(0, Math.ceil((stop - start) / step)) : Math.max(0, Math.ceil((start - stop) / -step));
        if (Number.isSafeInteger(count)) return count;
      }
    }
  }
  const slice = /\bin\s+[A-Za-z_]\w*\[\s*([A-Za-z_]\w*|\d+)?\s*:\s*([A-Za-z_]\w*|\d+)\s*\]\s*:/.exec(header);
  if (slice) {
    const start = value(slice[1] || '0');
    const end = value(slice[2]!);
    if (start !== undefined && end !== undefined) return Math.max(0, end - start);
  }
  const literal = /\bin\s*(\[[^\]]{0,300}\]|\([^)]{0,300}\))\s*:/.exec(header)?.[1];
  if (literal && !literal.includes('*')) {
    const body = literal.slice(1, -1).trim();
    const size = body ? body.split(',').filter(Boolean).length : 0;
    return size;
  }
  const collection = /\bin\s+([A-Za-z_]\w*)\s*:/.exec(header)?.[1];
  return collection ? bindings.get(collection) : undefined;
}

function staticallyBoundedPythonLoop(node: PythonNode, content: string, bindings: ReadonlyMap<string, number> = new Map()): boolean {
  const bound = pythonIterationBound(node, content, bindings);
  return bound !== undefined && bound <= MAX_STATIC_ITERATION_BOUND;
}

function pythonDominatingGuardBound(node: PythonNode, content: string): number | undefined {
  if (node.name !== 'ForStatement') return undefined;
  const lineStart = content.lastIndexOf('\n', Math.max(0, node.from - 1)) + 1;
  const lineEnd = content.indexOf('\n', node.from);
  const header = content.slice(lineStart, lineEnd < 0 ? node.to : lineEnd);
  const collection = /\bin\s+([A-Za-z_]\w*)\s*:/.exec(header)?.[1];
  if (!collection) return undefined;
  const loopIndent = /^\s*/.exec(header)?.[0].length || 0;
  const prior = content.slice(0, lineStart).split('\n')
    .map(line => ({ raw: line, text: line.trim(), indent: /^\s*/.exec(line)?.[0].length || 0 }))
    .filter(line => line.text && !line.text.startsWith('#'));
  const exit = prior.at(-1);
  const guard = prior.at(-2);
  if (!exit || !guard || exit.indent <= loopIndent || guard.indent !== loopIndent || !/^(?:return\b|raise\b)/.test(exit.text)) return undefined;
  const direct = new RegExp(`^if\\s+len\\(\\s*${collection}\\s*\\)\\s*(>=|>)\\s*(\\d+)\\s*:`).exec(guard.text);
  const reversed = new RegExp(`^if\\s+(\\d+)\\s*(<=|<)\\s*len\\(\\s*${collection}\\s*\\)\\s*:`).exec(guard.text);
  let limit = direct ? staticCount(Number(direct[2])) : reversed ? staticCount(Number(reversed[1])) : undefined;
  const operator = direct?.[1] || reversed?.[2];
  if (limit !== undefined && (operator === '>=' || operator === '<=')) limit -= 1;
  return limit !== undefined && limit >= 0 ? limit : undefined;
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

function pythonCopyOnGrow(node: PythonNode, ancestors: PythonNode[], content: string, bindings: ReadonlyMap<string, number>): string | undefined {
  const repeatedBy = nearestPythonLoop(ancestors, node.from);
  if (!repeatedBy || staticallyBoundedPythonLoop(repeatedBy, content, bindings)) return undefined;
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

export function scanPythonStructure(content: string, relativeFile: string, externalQueryFunctions: ReadonlyMap<string, string> = new Map()): StructuralScanResult {
  const findings: VelloxFindingInput[] = [];
  const lines = content.split('\n');
  let root: PythonNode;
  try {
    root = pythonParser.parse(content).topNode as unknown as PythonNode;
  } catch {
    return { findings, parsed: false, parseError: { parser: 'lezer-python' } };
  }
  const syntaxError = pythonSyntaxError(root, content);
  if (syntaxError) return { findings, parsed: false, parseError: { line: lineAt(content, syntaxError.from), parser: 'lezer-python' } };
  const queryFunctions = collectPythonQueryFunctions(root, content, externalQueryFunctions);
  const boundedBindings = collectPythonBoundedBindings(root, content);
  const taintedBindings = collectPythonTaintedBindings(root, content);

  const walk = (node: PythonNode, ancestors: PythonNode[] = []): void => {
    const line = lineAt(content, node.from);
    const bindings = boundedBindings.byOwner.get(pythonScopeOwner(ancestors, root)) || new Map<string, number>();
    const tainted = taintedBindings.get(pythonScopeOwner(ancestors, root)) || new Set<string>();
    const growthPattern = !ignoredAt(lines, line) ? pythonCopyOnGrow(node, ancestors, content, bindings) : undefined;
    if (growthPattern) {
      findings.push(structuralFinding({
        ruleId: 'code/quadratic-collection-growth', severity: 'MEDIUM', category: 'code',
        title: 'Collection is copied while it grows inside an iteration', evidence: sourceLine(content, line),
        recommendation: growthPattern === 'front-insert'
          ? 'Append in iteration order and reverse once if needed; inserting at index zero shifts the existing list every time.'
          : 'Mutate a local list/dict accumulator, or collect entries and construct the final value once after the loop.',
        file: relativeFile, line, metadata: { parser: 'lezer-python', pattern: growthPattern, complexity: 'O(n^2)' }
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
      if (outerLoop && !staticallyBoundedPythonLoop(node, content, bindings) && !staticallyBoundedPythonLoop(outerLoop, content, bindings)
        && looksLikeQuadraticPythonJoin(node, outerLoop, content)) {
        findings.push(structuralFinding({
          ruleId: 'code/quadratic-nested-iteration', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
          title: 'Nested iteration can grow quadratically', evidence: sourceLine(content, line),
          recommendation: 'Index one collection with a dict/set or replace the nested scan with a single-pass join.',
          file: relativeFile, line, metadata: { parser: 'lezer-python', outerLoopStart: lineAt(content, outerLoop.from), complexity: 'O(n*m)' }
        }));
      }
      const signals = collectPythonLoopSignals(node, content, queryFunctions, externalQueryFunctions);
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
        const iterationBound = pythonIterationBound(node, content, bindings)
          ?? pythonDominatingGuardBound(node, content);
        const defaultSeverity = hotspotSeverity(relativeFile);
        findings.push(structuralFinding({
          ruleId: transaction ? 'code/transaction-in-loop' : query ? 'code/synchronous-query-loop' : 'code/sequential-async-loop',
          severity: iterationBound !== undefined && iterationBound <= MAX_STATIC_ITERATION_BOUND && defaultSeverity === 'HIGH' ? 'MEDIUM' : defaultSeverity,
          confidence: signals.indirectQuery ? 'MEDIUM' : 'HIGH', category: 'code',
          title: transaction ? 'Transaction boundary inside a loop' : query
            ? signals.crossFileQuery ? 'Imported function reaching the database is called inside a loop'
              : signals.indirectQuery ? 'Function reaching the database is called inside a loop' : 'Synchronous database operation inside a loop'
            : 'Sequential asynchronous work inside a loop',
          evidence: sourceLine(content, signalLine),
          recommendation: transaction
            ? 'Move commit/flush outside the loop and use a bulk transaction where semantics allow it.'
            : query
              ? 'Prefetch or mutate the required records in bulk to remove the N+1 database round trips.'
              : 'Batch the operation or use measured, bounded asyncio concurrency.',
          file: relativeFile, line: signalLine,
          metadata: {
            parser: 'lezer-python', loopStart: line,
            complexity: 'O(n)', operationsPerIteration: 1,
            iterationBound: iterationBound ?? 'input-dependent',
            pattern: transaction ? 'transaction' : query ? signals.crossFileQuery ? 'cross-file-database' : signals.indirectQuery ? 'indirect-database' : 'database' : 'await',
            ...(signals.queryPath ? { callPath: signals.queryPath } : {})
          }
        }));
      }
    }

    if (node.name === 'CallExpression' && !ignoredAt(lines, line)) {
      const name = pythonCallName(node, content);
      const callText = content.slice(node.from, node.to);
      const repeatedBy = nearestPythonLoop(ancestors, node.from);
      const databaseCall = isPythonDatabaseCall(node, content);

      if (repeatedBy && !staticallyBoundedPythonLoop(repeatedBy, content, bindings)) {
        const method = name.match(/\.([A-Za-z_]\w*)\s*$/)?.[1] || name;
        const receiver = name.includes('.') ? name.slice(0, name.lastIndexOf('.')).split('.').at(-1) || '' : '';
        if (/^(?:count|index)$/.test(method) && likelyPythonLinearCollection(receiver) && !databaseCall) {
          findings.push(structuralFinding({
            ruleId: 'code/linear-search-in-loop', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
            title: 'Linear collection lookup is repeated inside a loop', evidence: sourceLine(content, line),
            recommendation: 'Build a dict or set once before the loop so each lookup is constant-time.',
            file: relativeFile, line, metadata: { parser: 'lezer-python', method, complexity: 'O(n*m)' }
          }));
        }
        if (name === 'sorted' || method === 'sort') {
          findings.push(structuralFinding({
            ruleId: 'code/repeated-sort-in-loop', severity: 'MEDIUM', confidence: 'MEDIUM', category: 'code',
            title: 'Collection is sorted repeatedly inside a loop', evidence: sourceLine(content, line),
            recommendation: 'Sort once before the loop or maintain an indexed structure instead of repeating O(n log n) work.',
            file: relativeFile, line, metadata: { parser: 'lezer-python', method: name === 'sorted' ? 'sorted' : 'sort', complexity: 'O(n*m log m)' }
          }));
        }
      }
      const gatherWork = /\bfor\b[\s\S]*\bin\b|\*\s*\w+/i.test(callText);
      const boundedGather = /\bfor\b[\s\S]*\bin\s+(?:batch|chunk|limited|page|window)\w*\b/i.test(callText)
        || /\*\s*(?:batch|chunk|limited|page|window)\w*\b/i.test(callText)
        || /\b(?:bounded|limited|limiter|semaphore|workerPool)\w*\s*\(/i.test(callText)
        || (bindings.get(/\bfor\b[\s\S]*\bin\s+([A-Za-z_]\w*)\b/i.exec(callText)?.[1] || '') ?? Number.POSITIVE_INFINITY) <= MAX_STATIC_ITERATION_BOUND;
      if (/^(?:asyncio\.)?gather$/i.test(name) && gatherWork && !boundedGather) {
        const queryFanout = pythonNodeContainsQuery(node, content, queryFunctions);
        const queryPath = pythonExternalQueryPath(node, content, externalQueryFunctions);
        const gatherCollection = /\bfor\b[\s\S]*\bin\s+([A-Za-z_]\w*)\b/i.exec(callText)?.[1] || '';
        const directSliceBound = /\bfor\b[\s\S]*\bin\s+[A-Za-z_]\w*\[\s*(?:0)?\s*:\s*(\d+)\s*\]/i.exec(callText)?.[1];
        const taskUpperBound = bindings.get(gatherCollection) ?? (directSliceBound ? staticCount(Number(directSliceBound)) : undefined);
        findings.push(structuralFinding({
          ruleId: queryFanout ? 'code/unbounded-query-fanout' : 'code/unbounded-async-fanout', severity: 'HIGH', category: 'code',
          title: queryFanout ? 'Database query fan-out has no concurrency bound' : 'Async gather has no concurrency bound', evidence: sourceLine(content, line),
          recommendation: queryFanout
            ? 'Cap database concurrency with a semaphore or measured batches; prefer one bulk query when possible.'
            : 'Use a semaphore, worker queue, or measured batches to cap concurrent tasks.',
          file: relativeFile, line, metadata: {
            parser: 'lezer-python', pattern: 'asyncio.gather', database: queryFanout,
            complexity: 'O(n)', taskUpperBound: taskUpperBound ?? 'input-dependent',
            ...(queryPath ? { callPath: queryPath } : {})
          }
        }));
      }

      const owner = nearestPythonFunction(ancestors);
      const asyncOwner = owner && /^\s*async\s+def\b/.test(content.slice(owner.from, owner.to));
      const awaited = ancestors.some(ancestor => ancestor.name === 'AwaitExpression');
      const insideLoop = ancestors.some(ancestor => PYTHON_LOOP_TYPES.has(ancestor.name));
      const blockingIo = /^(?:requests\.(?:delete|get|head|options|patch|post|put)|time\.sleep|subprocess\.(?:call|check_call|check_output|run)|os\.system|urllib\.request\.urlopen)$/i.test(name);
      const blockingDatabase = databaseCall;
      const rawSqlCall = /(?:^|\.)(?:execute|executemany|raw)$/i.test(name);
      if (rawSqlCall && /\(\s*(?:f["']|["'][^"']*["']\s*(?:\+|%)|[^)]*\.format\s*\()/i.test(callText)) {
        findings.push(structuralFinding({
          ruleId: 'query/dynamic-sql-construction', severity: 'HIGH', category: 'query',
          title: 'SQL is assembled from runtime values', evidence: sourceLine(content, line),
          recommendation: 'Use bound parameters from the database driver instead of f-strings, concatenation, percent formatting, or .format().',
          file: relativeFile, line, metadata: { parser: 'lezer-python', call: name }
        }));
      }
      if (rawSqlCall && pythonSqlArgumentTainted(callText, tainted)) {
        findings.push(structuralFinding({
          ruleId: 'security/sql-injection-flow', severity: 'CRITICAL', category: 'security',
          title: 'Untrusted request data reaches a database query', evidence: sourceLine(content, line),
          recommendation: 'Bind the request value through the driver or ORM parameter API; never concatenate or interpolate it into SQL text.',
          file: relativeFile, line, metadata: { parser: 'lezer-python', call: name, source: 'request-data', sink: 'database-query' }
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
          recommendation: 'Add cursor/keyset pagination or a measured limit. If the business domain is provably small, document that review with # @vellox-ignore.',
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
