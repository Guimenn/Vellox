import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from '@babel/parser';
import { parser as pythonParser } from '@lezer/python';

interface PythonNode {
  name: string;
  from: number;
  to: number;
  type?: { isError?: boolean };
  firstChild: PythonNode | null;
  nextSibling: PythonNode | null;
}

interface FunctionSymbol {
  id: string;
  file: string;
  aliases: Set<string>;
  calls: Set<string>;
  directDatabase: boolean;
}

interface ImportBinding {
  local: string;
  targetFile: string;
  targetExport: string;
  namespace?: boolean;
}

interface ReexportBinding {
  exported: string;
  targetFile: string;
  targetExport: string;
}

interface ModuleSummary {
  file: string;
  language: 'javascript' | 'python';
  functions: FunctionSymbol[];
  localSymbols: Map<string, string>;
  exports: Map<string, string>;
  imports: ImportBinding[];
  reexports: ReexportBinding[];
  exportAll: string[];
}

export interface ProjectSemanticIndex {
  externalQueryFunctions: Map<string, ReadonlyMap<string, string>>;
  modulesAnalyzed: number;
  functionsAnalyzed: number;
}

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const PYTHON_EXTENSIONS = ['.py'];
const JS_FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ClassMethod', 'ClassPrivateMethod', 'ObjectMethod'
]);

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
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

function jsName(node: any, content: string): string {
  if (!node) return '';
  if (node.type === 'Identifier' || node.type === 'PrivateName') return node.name || '';
  if (node.type === 'StringLiteral') return node.value || '';
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const object = jsName(node.object, content);
    const property = node.computed
      ? content.slice(node.property?.start || 0, node.property?.end || 0).replace(/^['"]|['"]$/g, '')
      : jsName(node.property, content);
    return [object, property].filter(Boolean).join('.');
  }
  if (typeof node.start === 'number' && typeof node.end === 'number') return content.slice(node.start, node.end);
  return '';
}

function jsTypeName(node: any, content: string): string {
  let current = node?.type === 'TSParameterProperty' ? node.parameter : node;
  current = current?.typeAnnotation?.typeAnnotation;
  if (current?.type === 'TSOptionalType') current = current.typeAnnotation;
  if (current?.type === 'TSTypeReference') return jsName(current.typeName, content);
  return '';
}

function javascriptDatabaseCall(node: any, content: string): boolean {
  if (node?.type !== 'CallExpression' && node?.type !== 'OptionalCallExpression') return false;
  const name = jsName(node.callee, content);
  const method = name.toLowerCase().split('.').at(-1) || '';
  if (!/^(?:aggregate|bulkcreate|bulkdelete|bulkwrite|count|countdocuments|create|delete|deleteone|deletemany|destroy|execute|executemany|find|findall|findbyid|findbyidandupdate|findfirst|findmany|findone|findoneandupdate|findunique|insert|insertmany|query|raw|save|scalar|select|update|updateone|updatemany|upsert)$/i.test(method)) return false;
  if (/\b(?:prisma|sequelize|typeorm|mongoose|knex|database|connection|cursor|session|entitymanager|repository|repo|pool|db|transaction|trx|tx)\b/i.test(name)) return true;
  const root = name.split('.')[0] || '';
  return /^[A-Z][A-Za-z0-9_$]*(?:Model)?$/.test(root) && !/^[A-Z0-9_$]+$/.test(root)
    && /^(?:aggregate|count|create|deleteMany|deleteOne|find|findById|findOne|insertMany|updateMany|updateOne)$/i.test(method);
}

function sourceCandidates(base: string, extensions: string[]): string[] {
  const normalizedBase = normalize(base).replace(/\/$/, '');
  const candidates = [normalizedBase];
  if (!extensions.some(extension => normalizedBase.endsWith(extension))) {
    candidates.push(...extensions.map(extension => normalizedBase + extension));
    candidates.push(...extensions.map(extension => `${normalizedBase}/index${extension}`));
    if (extensions.includes('.py')) candidates.push(`${normalizedBase}/__init__.py`);
  }
  return candidates.map(normalize);
}

interface JavaScriptResolverConfig {
  baseUrl: string;
  paths: Array<{ pattern: string; targets: string[] }>;
  configured: boolean;
}

interface WorkspacePackage {
  directory: string;
  entries: string[];
}

function stripJsonComments(value: string): string {
  let result = '';
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        result += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      } else if (character === '\n') result += character;
      continue;
    }
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"') {
      quote = character;
      result += character;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    result += character;
  }
  return result;
}

function readJsonConfig(filePath: string, maxFileBytes = Number.MAX_SAFE_INTEGER): Record<string, any> | undefined {
  try {
    if (fs.statSync(filePath).size > maxFileBytes) return undefined;
    const raw = stripJsonComments(fs.readFileSync(filePath, 'utf8'))
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return undefined;
  }
}

function localConfigPath(root: string, fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.json`, path.join(base, 'tsconfig.json')];
  return candidates.find(candidate => {
    const relative = path.relative(root, candidate);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  });
}

function readTsConfig(root: string, configPath: string, maxFileBytes: number, visited = new Set<string>()): JavaScriptResolverConfig {
  const resolvedPath = path.resolve(configPath);
  if (visited.has(resolvedPath)) return { baseUrl: '.', paths: [], configured: true };
  visited.add(resolvedPath);
  const config = readJsonConfig(resolvedPath, maxFileBytes);
  if (!config) return { baseUrl: normalize(path.relative(root, path.dirname(resolvedPath)) || '.'), paths: [], configured: true };
  const parentPath = typeof config.extends === 'string' ? localConfigPath(root, resolvedPath, config.extends) : undefined;
  const parent = parentPath ? readTsConfig(root, parentPath, maxFileBytes, visited) : undefined;
  const compilerOptions = config.compilerOptions || {};
  const configDirectory = normalize(path.relative(root, path.dirname(resolvedPath)) || '.');
  const baseUrl = typeof compilerOptions.baseUrl === 'string'
    ? normalize(path.posix.join(configDirectory, compilerOptions.baseUrl))
    : parent?.baseUrl || configDirectory;
  const declaredPaths = compilerOptions.paths && typeof compilerOptions.paths === 'object'
    ? Object.entries(compilerOptions.paths as Record<string, unknown>)
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(value => typeof value === 'string'))
      .map(([pattern, targets]) => ({ pattern, targets: targets.map(target => normalize(path.posix.join(baseUrl, target))) }))
    : [];
  const overridden = new Set(declaredPaths.map(mapping => mapping.pattern));
  return {
    baseUrl,
    paths: [...declaredPaths, ...(parent?.paths || []).filter(mapping => !overridden.has(mapping.pattern))],
    configured: true
  };
}

function nearestJavaScriptConfig(root: string, file: string, maxFileBytes: number): JavaScriptResolverConfig {
  let directory = path.dirname(path.join(root, file));
  while (true) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return readTsConfig(root, candidate, maxFileBytes);
    }
    if (directory === root) break;
    const parent = path.dirname(directory);
    if (parent === directory || path.relative(root, parent).startsWith('..')) break;
    directory = parent;
  }
  return { baseUrl: '.', paths: [], configured: false };
}

function conditionalExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['import', 'require', 'default', 'types']) {
    const target = conditionalExportTarget(record[key]);
    if (target) return target;
  }
  return undefined;
}

function collectWorkspacePackages(root: string, sources: Map<string, string>, maxFileBytes: number): Map<string, WorkspacePackage> {
  const manifests = new Set<string>();
  for (const file of sources.keys()) {
    let directory = path.dirname(path.join(root, file));
    while (true) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) manifests.add(manifest);
      if (directory === root) break;
      const parent = path.dirname(directory);
      if (parent === directory || path.relative(root, parent).startsWith('..')) break;
      directory = parent;
    }
  }
  const packages = new Map<string, WorkspacePackage>();
  for (const manifest of manifests) {
    const pkg = readJsonConfig(manifest, maxFileBytes);
    if (typeof pkg?.name !== 'string') continue;
    const directory = normalize(path.relative(root, path.dirname(manifest)) || '.');
    const entries = [conditionalExportTarget(pkg.exports?.['.'] ?? pkg.exports), pkg.module, pkg.main, pkg.source, 'src/index', 'index']
      .filter((value): value is string => typeof value === 'string')
      .map(value => normalize(path.posix.join(directory, value)));
    packages.set(pkg.name, { directory, entries });
  }
  return packages;
}

function wildcardMatch(pattern: string, value: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === value ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return value.startsWith(prefix) && value.endsWith(suffix) ? value.slice(prefix.length, value.length - suffix.length) : undefined;
}

function createJavaScriptResolver(root: string, sources: Map<string, string>, maxFileBytes: number): (file: string, specifier: string) => string | undefined {
  const existing = new Set(sources.keys());
  const configCache = new Map<string, JavaScriptResolverConfig>();
  const workspacePackages = collectWorkspacePackages(root, sources, maxFileBytes);
  const resolveBase = (base: string): string | undefined => sourceCandidates(base, JS_EXTENSIONS).find(candidate => existing.has(candidate));
  return (file, specifier) => {
    if (specifier.startsWith('.')) return resolveBase(path.posix.join(path.posix.dirname(file), specifier));
    let config = configCache.get(file);
    if (!config) {
      config = nearestJavaScriptConfig(root, file, maxFileBytes);
      configCache.set(file, config);
    }
    for (const mapping of config.paths) {
      const wildcard = wildcardMatch(mapping.pattern, specifier);
      if (wildcard === undefined) continue;
      for (const target of mapping.targets) {
        const mapped = target.replace('*', wildcard);
        const resolved = resolveBase(mapped);
        if (resolved) return resolved;
      }
    }
    if (config.configured) {
      const fromBaseUrl = resolveBase(path.posix.join(config.baseUrl, specifier));
      if (fromBaseUrl) return fromBaseUrl;
    }
    for (const [packageName, workspace] of workspacePackages) {
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue;
      const subpath = specifier === packageName ? '' : specifier.slice(packageName.length + 1);
      if (!subpath) {
        for (const entry of workspace.entries) {
          const resolved = resolveBase(entry);
          if (resolved) return resolved;
        }
      }
      for (const base of [path.posix.join(workspace.directory, subpath), path.posix.join(workspace.directory, 'src', subpath)]) {
        const resolved = resolveBase(base);
        if (resolved) return resolved;
      }
    }
    return undefined;
  };
}

function javascriptFunctionAliases(node: any, parent: any, ancestors: any[], content: string): string[] {
  if (node.type === 'FunctionDeclaration' && node.id?.name) return [node.id.name];
  if ((node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && parent?.type === 'VariableDeclarator') {
    const name = jsName(parent.id, content);
    return name ? [name] : [];
  }
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')
    && parent?.type === 'ExportDefaultDeclaration') return [node.id?.name || 'default'];
  if ((node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && parent?.type === 'AssignmentExpression') {
    const exported = /^(?:module\.exports\.|exports\.)([A-Za-z_$][\w$]*)$/.exec(jsName(parent.left, content))?.[1];
    if (exported) return [exported];
  }
  if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') {
    const method = jsName(node.key, content);
    const owner = [...ancestors].reverse().find(candidate => candidate.type === 'ClassDeclaration' || candidate.type === 'ClassExpression');
    const className = owner?.id?.name;
    return [method, `this.${method}`, className ? `${className}.${method}` : ''].filter(Boolean);
  }
  return [];
}

function inspectJavaScriptFunction(node: any, content: string): { calls: Set<string>; directDatabase: boolean } {
  const calls = new Set<string>();
  let directDatabase = false;
  const visit = (candidate: any, root = false): void => {
    if (!candidate || (!root && JS_FUNCTION_TYPES.has(candidate.type))) return;
    if (candidate.type === 'CallExpression' || candidate.type === 'OptionalCallExpression') {
      const name = jsName(candidate.callee, content);
      if (javascriptDatabaseCall(candidate, content)) directDatabase = true;
      else if (name) calls.add(name);
    }
    for (const child of jsChildren(candidate)) visit(child);
  };
  visit(node.body, true);
  return { calls, directDatabase };
}

function parseJavaScriptModule(file: string, content: string, resolveModule: (file: string, specifier: string) => string | undefined): ModuleSummary | undefined {
  let program: any;
  try {
    const typescript = /\.(?:ts|tsx)$/i.test(file);
    const jsx = /\.(?:jsx|tsx)$/i.test(file);
    program = parse(content, {
      sourceType: 'unambiguous', errorRecovery: true, allowAwaitOutsideFunction: true,
      plugins: [
        ...(typescript ? ['typescript' as const] : []), ...(jsx ? ['jsx' as const] : []),
        'decorators-legacy', 'classProperties', 'classPrivateProperties', 'classPrivateMethods',
        'dynamicImport', 'importAttributes', 'topLevelAwait'
      ]
    }).program;
  } catch {
    return undefined;
  }

  const functions: FunctionSymbol[] = [];
  const localSymbols = new Map<string, string>();
  const exports = new Map<string, string>();
  const imports: ImportBinding[] = [];
  const reexports: ReexportBinding[] = [];
  const exportAll: string[] = [];
  const declaredExports = new Map<string, string>();
  const exportedClasses = new Map<string, string>();

  for (const statement of program.body || []) {
    if (statement.type === 'ImportDeclaration') {
      const targetFile = resolveModule(file, statement.source?.value || '');
      if (!targetFile) continue;
      for (const specifier of statement.specifiers || []) {
        const local = specifier.local?.name;
        if (!local) continue;
        if (specifier.type === 'ImportNamespaceSpecifier') imports.push({ local, targetFile, targetExport: '*', namespace: true });
        else imports.push({ local, targetFile, targetExport: specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported?.name || specifier.imported?.value || local });
      }
    }
    if (statement.type === 'ExportAllDeclaration') {
      const targetFile = resolveModule(file, statement.source?.value || '');
      if (targetFile) exportAll.push(targetFile);
    }
    if (statement.type !== 'ExportNamedDeclaration' && statement.type !== 'ExportDefaultDeclaration') continue;
    const declaration = statement.declaration;
    const defaultExport = statement.type === 'ExportDefaultDeclaration';
    if (declaration?.type === 'FunctionDeclaration') {
      const local = declaration.id?.name || (defaultExport ? 'default' : '');
      if (local) declaredExports.set(defaultExport ? 'default' : local, local);
    }
    if (defaultExport && (declaration?.type === 'FunctionExpression' || declaration?.type === 'ArrowFunctionExpression')) declaredExports.set('default', 'default');
    if (declaration?.type === 'ClassDeclaration' && declaration.id?.name) exportedClasses.set(defaultExport ? 'default' : declaration.id.name, declaration.id.name);
    if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations || []) {
        if (item.id?.type === 'Identifier') declaredExports.set(item.id.name, item.id.name);
      }
    }
    for (const specifier of statement.specifiers || []) {
      const exported = specifier.exported?.name || specifier.exported?.value;
      const local = specifier.local?.name || specifier.local?.value;
      const targetFile = statement.source ? resolveModule(file, statement.source.value || '') : undefined;
      if (exported && local && targetFile) reexports.push({ exported, targetFile, targetExport: local });
      else if (exported && local) declaredExports.set(exported, local);
    }
  }

  const collect = (node: any, ancestors: any[] = [], parent?: any): void => {
    if (JS_FUNCTION_TYPES.has(node?.type)) {
      const aliases = javascriptFunctionAliases(node, parent, ancestors, content);
      if (aliases.length) {
        const inspected = inspectJavaScriptFunction(node, content);
        const id = `${file}#${aliases[0]}@${node.start || 0}`;
        const symbol: FunctionSymbol = { id, file, aliases: new Set(aliases), ...inspected };
        functions.push(symbol);
        for (const alias of aliases) if (!localSymbols.has(alias)) localSymbols.set(alias, id);
      }
    }
    const next = [...ancestors, node];
    for (const child of jsChildren(node)) collect(child, next, node);
  };
  collect(program);

  for (const [exported, local] of declaredExports) {
    const symbol = localSymbols.get(local);
    if (symbol) exports.set(exported, symbol);
  }
  for (const [exportedClass, localClass] of exportedClasses) {
    for (const [alias, symbol] of localSymbols) {
      if (!alias.startsWith(`${localClass}.`)) continue;
      exports.set(`${exportedClass}.${alias.slice(localClass.length + 1)}`, symbol);
    }
  }

  const visitInstances = (node: any): void => {
    if (node?.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init?.type === 'NewExpression') {
      const className = jsName(node.init.callee, content);
      const binding = imports.find(item => !item.namespace && item.local === className);
      if (binding) imports.push({ local: node.id.name, targetFile: binding.targetFile, targetExport: binding.targetExport, namespace: true });
    }
    if (node?.type === 'VariableDeclarator' && node.init?.type === 'CallExpression' && jsName(node.init.callee, content) === 'require') {
      const source = node.init.arguments?.[0]?.value;
      const targetFile = typeof source === 'string' ? resolveModule(file, source) : undefined;
      if (targetFile && node.id?.type === 'Identifier') imports.push({ local: node.id.name, targetFile, targetExport: '*', namespace: true });
      if (targetFile && node.id?.type === 'ObjectPattern') {
        for (const property of node.id.properties || []) {
          const imported = jsName(property.key, content);
          const local = jsName(property.value, content);
          if (imported && local) imports.push({ local, targetFile, targetExport: imported });
        }
      }
    }
    if (node?.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
      && (node.init?.type === 'MemberExpression' || node.init?.type === 'OptionalMemberExpression')
      && node.init.object?.type === 'CallExpression' && jsName(node.init.object.callee, content) === 'require') {
      const source = node.init.object.arguments?.[0]?.value;
      const targetFile = typeof source === 'string' ? resolveModule(file, source) : undefined;
      const imported = jsName(node.init.property, content);
      if (targetFile && imported) imports.push({ local: node.id.name, targetFile, targetExport: imported });
    }
    if (node?.type === 'AssignmentExpression') {
      const left = jsName(node.left, content);
      const right = jsName(node.right, content);
      const cjs = /^(?:module\.exports\.|exports\.)([A-Za-z_$][\w$]*)$/.exec(left);
      const symbol = cjs && (localSymbols.get(right) || localSymbols.get(cjs[1]!));
      if (cjs && symbol) exports.set(cjs[1]!, symbol);
      if (left === 'module.exports') {
        const defaultSymbol = localSymbols.get(right);
        if (defaultSymbol) exports.set('default', defaultSymbol);
        if (node.right?.type === 'ObjectExpression') {
          for (const property of node.right.properties || []) {
            const exported = jsName(property.key, content);
            const local = jsName(property.value, content);
            const propertySymbol = localSymbols.get(local);
            if (exported && propertySymbol) exports.set(exported, propertySymbol);
          }
        }
      }
    }
    if ((node?.type === 'ClassMethod' || node?.type === 'ClassPrivateMethod') && node.kind === 'constructor') {
      const parameters = new Map<string, ImportBinding>();
      for (const rawParameter of node.params || []) {
        const parameter = rawParameter?.type === 'TSParameterProperty' ? rawParameter.parameter : rawParameter;
        const parameterName = jsName(parameter, content);
        const typeName = jsTypeName(rawParameter, content);
        const importedClass = imports.find(item => !item.namespace && item.local === typeName);
        if (!parameterName || !importedClass) continue;
        parameters.set(parameterName, importedClass);
        if (rawParameter?.type === 'TSParameterProperty') {
          imports.push({ local: `this.${parameterName}`, targetFile: importedClass.targetFile, targetExport: importedClass.targetExport, namespace: true });
        }
      }
      const inspectAssignments = (candidate: any): void => {
        if (candidate?.type === 'AssignmentExpression') {
          const left = jsName(candidate.left, content);
          const right = jsName(candidate.right, content);
          const binding = parameters.get(right);
          if (binding && left.startsWith('this.')) {
            imports.push({ local: left, targetFile: binding.targetFile, targetExport: binding.targetExport, namespace: true });
          }
        }
        for (const child of jsChildren(candidate)) inspectAssignments(child);
      };
      inspectAssignments(node.body);
    }
    for (const child of jsChildren(node)) visitInstances(child);
  };
  visitInstances(program);

  return { file, language: 'javascript', functions, localSymbols, exports, imports, reexports, exportAll };
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

function pythonHasError(node: PythonNode, content: string): boolean {
  if ((node.type?.isError || node.name === '⚠') && !pythonAsyncYieldRecovery(node, content)) return true;
  return pythonChildren(node).some(child => pythonHasError(child, content));
}

function pythonCallName(node: PythonNode, content: string): string {
  const callee = node.firstChild;
  return callee ? content.slice(callee.from, callee.to).trim() : '';
}

function pythonDatabaseCall(node: PythonNode, content: string): boolean {
  if (node.name !== 'CallExpression') return false;
  const name = pythonCallName(node, content);
  return /\.(?:execute|executemany|scalar|scalars|query|raw|find|find_one|find_many|aggregate|count|count_documents|insert_one|insert_many|update_one|update_many|delete_one|delete_many|get|all|first|one|one_or_none|filter|exclude|select_related|prefetch_related|bulk_create|bulk_update)\b/i.test(name)
    && /(?:^|\.)(?:objects|query|session|cursor|connection|database|db|repository|repo|collection)\b/i.test(name);
}

function createPythonResolver(sources: Map<string, string>): (file: string, specifier: string) => string | undefined {
  const existing = new Set(sources.keys());
  const roots = new Set(['', 'src', 'app']);
  for (const file of existing) {
    const first = file.split('/')[0];
    if (first) roots.add(first);
  }
  const resolveBase = (base: string): string | undefined => sourceCandidates(base, PYTHON_EXTENSIONS).find(candidate => existing.has(candidate));
  return (file, specifier) => {
    const dots = /^\.+/.exec(specifier)?.[0].length || 0;
    const moduleName = specifier.slice(dots).replace(/\./g, '/');
    if (dots) {
      let base = path.posix.dirname(file);
      for (let index = 1; index < dots; index += 1) base = path.posix.dirname(base);
      return resolveBase(path.posix.join(base, moduleName));
    }
    for (const root of roots) {
      const resolved = resolveBase(path.posix.join(root, moduleName));
      if (resolved) return resolved;
    }
    return undefined;
  };
}

function pythonClassName(ancestors: PythonNode[], content: string): string | undefined {
  const owner = [...ancestors].reverse().find(node => node.name === 'ClassDefinition');
  if (!owner) return undefined;
  return /\bclass\s+([A-Za-z_]\w*)/.exec(content.slice(owner.from, Math.min(owner.to, owner.from + 300)))?.[1];
}

function parsePythonImports(file: string, content: string, resolveModule: (file: string, specifier: string) => string | undefined): { imports: ImportBinding[]; reexports: ReexportBinding[] } {
  const imports: ImportBinding[] = [];
  const reexports: ReexportBinding[] = [];
  const moduleIsInit = path.posix.basename(file) === '__init__.py';
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const from = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
    if (from) {
      const targetFile = resolveModule(file, from[1]!);
      if (!targetFile) continue;
      const names = from[2]!.replace(/[()]/g, '').split(',');
      for (const item of names) {
        const match = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(item.trim());
        if (!match) continue;
        const imported = match[1]!;
        const local = match[2] || imported;
        imports.push({ local, targetFile, targetExport: imported });
        if (moduleIsInit && !imported.startsWith('_')) reexports.push({ exported: local, targetFile, targetExport: imported });
      }
      continue;
    }
    const direct = /^import\s+([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(line);
    if (!direct) continue;
    const targetFile = resolveModule(file, direct[1]!);
    if (!targetFile) continue;
    imports.push({ local: direct[2] || direct[1]!.split('.')[0]!, targetFile, targetExport: '*', namespace: true });
  }
  return { imports, reexports };
}

function parsePythonModule(file: string, content: string, resolveModule: (file: string, specifier: string) => string | undefined): ModuleSummary | undefined {
  let root: PythonNode;
  try {
    root = pythonParser.parse(content).topNode as unknown as PythonNode;
  } catch {
    return undefined;
  }
  if (pythonHasError(root, content)) return undefined;
  const functions: FunctionSymbol[] = [];
  const localSymbols = new Map<string, string>();
  const exports = new Map<string, string>();
  const parsedImports = parsePythonImports(file, content, resolveModule);
  for (const assignment of content.matchAll(/^\s*((?:self\.)?[A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/gm)) {
    const constructor = parsedImports.imports.find(binding => !binding.namespace && binding.local === assignment[2]);
    if (constructor) parsedImports.imports.push({
      local: assignment[1]!, targetFile: constructor.targetFile, targetExport: constructor.targetExport, namespace: true
    });
  }
  for (const constructor of content.matchAll(/^(\s*)(?:async\s+)?def\s+__init__\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?\s*:\s*\n([\s\S]*?)(?=^\1(?:async\s+def|def|class)\b|\s*$)/gm)) {
    const typedParameters = new Map<string, ImportBinding>();
    for (const parameter of constructor[2]!.split(',')) {
      const match = /\b([A-Za-z_]\w*)\s*:\s*(?:[A-Za-z_]\w*\[)?([A-Za-z_]\w*)/.exec(parameter.trim());
      if (!match) continue;
      const binding = parsedImports.imports.find(item => !item.namespace && item.local === match[2]);
      if (binding) typedParameters.set(match[1]!, binding);
    }
    for (const assignment of constructor[3]!.matchAll(/\bself\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\b/g)) {
      const binding = typedParameters.get(assignment[2]!);
      if (binding) parsedImports.imports.push({
        local: `self.${assignment[1]}`, targetFile: binding.targetFile, targetExport: binding.targetExport, namespace: true
      });
    }
  }

  const collect = (node: PythonNode, ancestors: PythonNode[] = []): void => {
    if (node.name === 'FunctionDefinition') {
      const header = content.slice(node.from, Math.min(node.to, node.from + 500));
      const name = /\bdef\s+([A-Za-z_]\w*)\s*\(/.exec(header)?.[1];
      if (name) {
        const className = pythonClassName(ancestors, content);
        const aliases = className ? [name, `self.${name}`, `cls.${name}`, `${className}.${name}`] : [name];
        const calls = new Set<string>();
        let directDatabase = false;
        const inspect = (candidate: PythonNode, rootNode = false): void => {
          if (!rootNode && candidate.name === 'FunctionDefinition') return;
          if (candidate.name === 'CallExpression') {
            const call = pythonCallName(candidate, content);
            if (pythonDatabaseCall(candidate, content)) directDatabase = true;
            else if (call) calls.add(call);
          }
          for (const child of pythonChildren(candidate)) inspect(child);
        };
        inspect(node, true);
        const id = `${file}#${className ? `${className}.` : ''}${name}@${node.from}`;
        const symbol: FunctionSymbol = { id, file, aliases: new Set(aliases), calls, directDatabase };
        functions.push(symbol);
        for (const alias of aliases) if (!localSymbols.has(alias)) localSymbols.set(alias, id);
        if (className) exports.set(`${className}.${name}`, id);
        else if (!name.startsWith('_')) exports.set(name, id);
      }
    }
    const next = [...ancestors, node];
    for (const child of pythonChildren(node)) collect(child, next);
  };
  collect(root);
  return {
    file, language: 'python', functions, localSymbols, exports,
    imports: parsedImports.imports, reexports: parsedImports.reexports, exportAll: []
  };
}

function resolveExport(modules: Map<string, ModuleSummary>, file: string, name: string, visited = new Set<string>()): string | undefined {
  const key = `${file}#${name}`;
  if (visited.has(key)) return undefined;
  visited.add(key);
  const module = modules.get(file);
  if (!module) return undefined;
  const direct = module.exports.get(name);
  if (direct) return direct;
  const binding = module.reexports.find(item => item.exported === name);
  if (binding) return resolveExport(modules, binding.targetFile, binding.targetExport, visited);
  for (const target of module.exportAll) {
    const resolved = resolveExport(modules, target, name, visited);
    if (resolved) return resolved;
  }
  return undefined;
}

function resolveImportedCall(modules: Map<string, ModuleSummary>, module: ModuleSummary, call: string): string | undefined {
  const direct = module.imports.find(binding => !binding.namespace && binding.local === call);
  if (direct) return resolveExport(modules, direct.targetFile, direct.targetExport);
  for (const binding of module.imports.filter(item => !item.namespace)) {
    if (!call.startsWith(`${binding.local}.`)) continue;
    const method = call.slice(binding.local.length + 1);
    return resolveExport(modules, binding.targetFile, `${binding.targetExport}.${method}`);
  }
  for (const binding of module.imports.filter(item => item.namespace)) {
    if (!call.startsWith(`${binding.local}.`)) continue;
    const method = call.slice(binding.local.length + 1);
    const exported = binding.targetExport === '*' ? method : `${binding.targetExport}.${method}`;
    return resolveExport(modules, binding.targetFile, exported);
  }
  return undefined;
}

export function buildProjectSemanticIndex(root: string, sources: Map<string, string>, maxFileBytes = 2_000_000): ProjectSemanticIndex {
  const normalizedSources = new Map([...sources].map(([file, content]) => [normalize(file), content]));
  const resolveJavaScript = createJavaScriptResolver(root, normalizedSources, maxFileBytes);
  const resolvePython = createPythonResolver(normalizedSources);
  const modules = new Map<string, ModuleSummary>();

  for (const [file, content] of normalizedSources) {
    const module = /\.(?:cjs|js|jsx|mjs|ts|tsx)$/i.test(file)
      ? parseJavaScriptModule(file, content, resolveJavaScript)
      : /\.py$/i.test(file)
        ? parsePythonModule(file, content, resolvePython)
        : undefined;
    if (module) modules.set(file, module);
  }

  const functions = [...modules.values()].flatMap(module => module.functions);
  const functionsById = new Map(functions.map(symbol => [symbol.id, symbol]));
  const edges = new Map<string, Set<string>>();
  for (const module of modules.values()) {
    for (const symbol of module.functions) {
      const targets = new Set<string>();
      for (const call of symbol.calls) {
        const local = module.localSymbols.get(call);
        const imported = local || resolveImportedCall(modules, module, call);
        if (imported && imported !== symbol.id) targets.add(imported);
      }
      edges.set(symbol.id, targets);
    }
  }

  const queryFunctions = new Set(functions.filter(symbol => symbol.directDatabase).map(symbol => symbol.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, targets] of edges) {
      if (queryFunctions.has(id) || ![...targets].some(target => queryFunctions.has(target))) continue;
      queryFunctions.add(id);
      changed = true;
    }
  }

  const traceQueryPath = (id: string, visited = new Set<string>()): string => {
    const symbol = functionsById.get(id);
    if (!symbol) return 'unresolved function';
    const label = `${symbol.file}:${[...symbol.aliases][0] || 'anonymous'}`;
    if (symbol.directDatabase) return `${label} -> database`;
    if (visited.has(id)) return `${label} -> cycle`;
    const nextVisited = new Set(visited).add(id);
    const target = [...(edges.get(id) || [])].find(candidate => queryFunctions.has(candidate));
    return target ? `${label} -> ${traceQueryPath(target, nextVisited)}` : `${label} -> database`;
  };

  const externalQueryFunctions = new Map<string, ReadonlyMap<string, string>>();
  for (const module of modules.values()) {
    const names = new Map<string, string>();
    for (const binding of module.imports) {
      if (!binding.namespace) {
        const target = resolveExport(modules, binding.targetFile, binding.targetExport);
        if (target && queryFunctions.has(target)) names.set(binding.local, traceQueryPath(target));
        const targetModule = modules.get(binding.targetFile);
        for (const exported of targetModule?.exports.keys() || []) {
          if (!exported.startsWith(`${binding.targetExport}.`)) continue;
          const methodTarget = resolveExport(modules, binding.targetFile, exported);
          if (methodTarget && queryFunctions.has(methodTarget)) names.set(`${binding.local}.${exported.slice(binding.targetExport.length + 1)}`, traceQueryPath(methodTarget));
        }
        continue;
      }
      const targetModule = modules.get(binding.targetFile);
      if (!targetModule) continue;
      for (const exported of targetModule.exports.keys()) {
        if (binding.targetExport !== '*' && !exported.startsWith(`${binding.targetExport}.`)) continue;
        const targetName = exported;
        const target = resolveExport(modules, binding.targetFile, targetName);
        const method = binding.targetExport === '*' ? exported : exported.slice(binding.targetExport.length + 1);
        if (target && queryFunctions.has(target)) names.set(`${binding.local}.${method}`, traceQueryPath(target));
      }
    }
    externalQueryFunctions.set(module.file, names);
  }

  return { externalQueryFunctions, modulesAnalyzed: modules.size, functionsAnalyzed: functions.length };
}
