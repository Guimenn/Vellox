import { Severity, VelloxFindingInput } from './types.js';

export type SqlDialect = 'auto' | 'postgresql' | 'mysql' | 'sqlite';
export type ResolvedSqlDialect = Exclude<SqlDialect, 'auto'> | 'generic';

export interface SqlAnalysisOptions {
  dialect?: SqlDialect;
  file?: string;
  line?: number;
  largeInThreshold?: number;
  excessiveOrThreshold?: number;
}

export interface SqlParseIssue {
  message: string;
  offset: number;
  line: number;
}

export interface SqlAnalysisResult {
  findings: VelloxFindingInput[];
  parsed: boolean;
  dialect: ResolvedSqlDialect;
  parser: 'vellox-sql-ast';
  issue?: SqlParseIssue;
}

interface SqlToken {
  kind: 'word' | 'number' | 'string' | 'identifier' | 'parameter' | 'operator' | 'punctuation';
  text: string;
  upper: string;
  start: number;
  end: number;
  depth: number;
}

interface SqlStatementAst {
  type: 'select' | 'update' | 'delete' | 'insert' | 'unknown';
  dialect: ResolvedSqlDialect;
  tokens: SqlToken[];
  top: SqlToken[];
  main: SqlToken;
  projection: SqlToken[];
  where: SqlToken[];
  from: SqlToken[];
  outerAliases: Set<string>;
  joinCount: number;
  hasFilter: boolean;
  hasLimit: boolean;
  hasOffset: boolean;
  hasOrder: boolean;
  selectStar: boolean;
  aggregateOnly: boolean;
  uniqueLookup: boolean;
  unionWithoutAll: boolean;
  redundantDistinct: boolean;
  correlatedSubquery: boolean;
  cartesianJoin: boolean;
  functionOnFilter: boolean;
  castOnFilter: boolean;
  largeInList: number;
  orPredicates: number;
}

const CLAUSE_WORDS = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'RETURNING', 'FOR']);
const NON_SARGABLE_FUNCTIONS = new Set(['CAST', 'COALESCE', 'DATE', 'DATE_TRUNC', 'LOWER', 'LTRIM', 'RTRIM', 'SUBSTR', 'SUBSTRING', 'TO_CHAR', 'UPPER']);

function lineAt(source: string, offset: number): number {
  return source.slice(0, Math.max(0, offset)).split('\n').length;
}

function decodeSqlString(text: string): string {
  return text.length >= 2 ? text.slice(1, -1).replace(/''/g, "'") : text;
}

function tokenize(source: string): { tokens: SqlToken[]; issue?: SqlParseIssue } {
  const tokens: SqlToken[] = [];
  let depth = 0;
  const issue = (message: string, offset: number): { tokens: SqlToken[]; issue: SqlParseIssue } => ({
    tokens,
    issue: { message, offset, line: lineAt(source, offset) }
  });
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && next === '-') {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return issue('Unterminated block comment', index);
      index = end + 2;
      continue;
    }
    if (character === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(index))?.[0];
      if (tag) {
        const end = source.indexOf(tag, index + tag.length);
        if (end < 0) return issue('Unterminated dollar-quoted string', index);
        const text = source.slice(index, end + tag.length);
        tokens.push({ kind: 'string', text, upper: text, start: index, end: end + tag.length, depth });
        index = end + tag.length;
        continue;
      }
      const parameter = /^\$\d+/.exec(source.slice(index))?.[0];
      if (parameter) {
        tokens.push({ kind: 'parameter', text: parameter, upper: parameter, start: index, end: index + parameter.length, depth });
        index += parameter.length;
        continue;
      }
    }
    if (character === "'") {
      const start = index;
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (source[index] === "'" && source[index - 1] !== '\\') {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return issue('Unterminated string literal', start);
      const text = source.slice(start, index);
      tokens.push({ kind: 'string', text, upper: text, start, end: index, depth });
      continue;
    }
    if (character === '"' || character === '`' || character === '[') {
      const start = index;
      const closing = character === '[' ? ']' : character;
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === closing && source[index + 1] === closing && closing !== ']') {
          index += 2;
          continue;
        }
        if (source[index] === closing) {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return issue('Unterminated quoted identifier', start);
      const text = source.slice(start, index);
      tokens.push({ kind: 'identifier', text, upper: text.slice(1, -1).toUpperCase(), start, end: index, depth });
      continue;
    }
    if (character === '(') {
      tokens.push({ kind: 'punctuation', text: character, upper: character, start: index, end: index + 1, depth });
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ')') {
      if (depth === 0) return issue('Unexpected closing parenthesis', index);
      depth -= 1;
      tokens.push({ kind: 'punctuation', text: character, upper: character, start: index, end: index + 1, depth });
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) index += 1;
      const text = source.slice(start, index);
      tokens.push({ kind: 'word', text, upper: text.toUpperCase(), start, end: index, depth });
      continue;
    }
    if (/\d/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[\d._]/.test(source[index]!)) index += 1;
      const text = source.slice(start, index);
      tokens.push({ kind: 'number', text, upper: text, start, end: index, depth });
      continue;
    }
    if ((character === ':' || character === '@') && /[A-Za-z_]/.test(next || '')) {
      const start = index;
      index += 2;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) index += 1;
      const text = source.slice(start, index);
      tokens.push({ kind: 'parameter', text, upper: text, start, end: index, depth });
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (['::', '>=', '<=', '<>', '!=', '==', '||', '&&', '->', '=>'].includes(pair)) {
      tokens.push({ kind: 'operator', text: pair, upper: pair, start: index, end: index + 2, depth });
      index += 2;
      continue;
    }
    const kind: SqlToken['kind'] = ',.;'.includes(character) ? 'punctuation' : character === '?' ? 'parameter' : 'operator';
    tokens.push({ kind, text: character, upper: character.toUpperCase(), start: index, end: index + 1, depth });
    index += 1;
  }
  if (depth !== 0) return issue('Unclosed parenthesis', source.length);
  return { tokens };
}

function detectDialect(source: string, requested: SqlDialect): ResolvedSqlDialect {
  if (requested !== 'auto') return requested;
  if (/\b(?:ILIKE|RETURNING)\b|::\s*[A-Za-z_]\w*|\$\d+/.test(source)) return 'postgresql';
  if (/`[^`]+`|\b(?:ON\s+DUPLICATE\s+KEY|SQL_CALC_FOUND_ROWS|STRAIGHT_JOIN)\b|\bLIMIT\s+\d+\s*,\s*\d+/i.test(source)) return 'mysql';
  if (/\b(?:PRAGMA|WITHOUT\s+ROWID|AUTOINCREMENT)\b/i.test(source)) return 'sqlite';
  return 'generic';
}

function topClause(tokens: SqlToken[], word: string): number {
  return tokens.findIndex(token => token.depth === 0 && token.upper === word);
}

function sliceClause(tokens: SqlToken[], startWord: string, endWords: Set<string>): SqlToken[] {
  const start = topClause(tokens, startWord);
  if (start < 0) return [];
  const end = tokens.findIndex((token, index) => index > start && token.depth === 0 && endWords.has(token.upper));
  return tokens.slice(start + 1, end < 0 ? tokens.length : end);
}

function collectOuterAliases(from: SqlToken[]): Set<string> {
  const aliases = new Set<string>();
  for (let index = 0; index < from.length; index += 1) {
    const token = from[index]!;
    const boundary = index === 0 || token.upper === 'JOIN' || token.text === ',';
    if (!boundary) continue;
    let cursor = index === 0 ? index : index + 1;
    while (from[cursor]?.upper === 'LATERAL' || from[cursor]?.upper === 'ONLY') cursor += 1;
    if (from[cursor]?.text === '(') continue;
    const tableParts: SqlToken[] = [];
    while (from[cursor] && (from[cursor]!.kind === 'word' || from[cursor]!.kind === 'identifier' || from[cursor]!.text === '.')) {
      tableParts.push(from[cursor]!);
      cursor += 1;
      if (from[cursor - 1]?.text !== '.' && from[cursor]?.text !== '.') break;
    }
    const table = [...tableParts].reverse().find(part => part.kind === 'word' || part.kind === 'identifier')?.upper;
    if (table) aliases.add(table);
    if (from[cursor]?.upper === 'AS') cursor += 1;
    const alias = from[cursor];
    if (alias && (alias.kind === 'word' || alias.kind === 'identifier') && !CLAUSE_WORDS.has(alias.upper) && alias.upper !== 'JOIN' && alias.upper !== 'ON' && alias.upper !== 'USING') aliases.add(alias.upper);
  }
  return aliases;
}

function hasCorrelatedSubquery(tokens: SqlToken[], aliases: Set<string>): boolean {
  const subqueries = tokens.filter(token => token.upper === 'SELECT' && token.depth > 0);
  return subqueries.some(select => tokens.some((token, index) => token.start > select.start && token.depth >= select.depth
    && aliases.has(token.upper) && tokens[index + 1]?.text === '.'));
}

function hasCartesianJoin(from: SqlToken[], where: SqlToken[]): boolean {
  if (from.some((token, index) => token.upper === 'CROSS' && from[index + 1]?.upper === 'JOIN')) return true;
  const relationPredicates = where.filter((token, index) => token.text === '='
    && where[index - 2]?.text === '.' && where[index + 2]?.text === '.').length;
  const commaJoins = from.filter(token => token.text === ',' && token.depth === 0).length;
  if (commaJoins > relationPredicates) return true;
  for (let index = 0; index < from.length; index += 1) {
    if (from[index]?.upper !== 'JOIN' || from[index]?.depth !== 0) continue;
    if (from[index - 1]?.upper === 'NATURAL') continue;
    const segment: SqlToken[] = [];
    for (let cursor = index + 1; cursor < from.length; cursor += 1) {
      if (from[cursor]?.depth === 0 && from[cursor]?.upper === 'JOIN') break;
      segment.push(from[cursor]!);
    }
    if (!segment.some(token => token.depth === 0 && (token.upper === 'ON' || token.upper === 'USING')) && relationPredicates === 0) return true;
  }
  return false;
}

function hasFunctionOnFilter(where: SqlToken[]): boolean {
  return where.some((token, index) => token.depth === 0 && NON_SARGABLE_FUNCTIONS.has(token.upper) && token.upper !== 'CAST' && where[index + 1]?.text === '(');
}

function hasCastOnFilter(where: SqlToken[]): boolean {
  return where.some((token, index) => token.depth === 0 && token.upper === 'CAST' && where[index + 1]?.text === '(')
    || where.some((token, index) => token.text === '::' && ['word', 'identifier'].includes(where[index - 1]?.kind || ''));
}

function largestInList(where: SqlToken[]): number {
  let largest = 0;
  for (let index = 0; index < where.length; index += 1) {
    if (where[index]?.upper !== 'IN' || where[index + 1]?.text !== '(') continue;
    const open = where[index + 1]!;
    if (where[index + 2]?.upper === 'SELECT') continue;
    let commas = 0;
    let values = 0;
    for (let cursor = index + 2; cursor < where.length; cursor += 1) {
      const token = where[cursor]!;
      if (token.text === ')' && token.depth === open.depth) break;
      if (token.depth === open.depth + 1 && token.text === ',') commas += 1;
      if (token.depth === open.depth + 1 && token.text !== ',' && token.kind !== 'operator') values += 1;
    }
    if (values > 0) largest = Math.max(largest, commas + 1);
  }
  return largest;
}

function parseAst(dialect: ResolvedSqlDialect, tokens: SqlToken[]): SqlStatementAst | undefined {
  const main = tokens.find(token => token.depth === 0 && ['SELECT', 'UPDATE', 'DELETE', 'INSERT'].includes(token.upper));
  if (!main) return undefined;
  const statementTokens = tokens.slice(tokens.indexOf(main));
  const top = statementTokens.filter(token => token.depth === 0);
  const from = sliceClause(statementTokens, 'FROM', CLAUSE_WORDS);
  const where = sliceClause(statementTokens, 'WHERE', new Set(['GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'RETURNING', 'FOR']));
  const fromIndex = top.findIndex(token => token.upper === 'FROM');
  const projection = main.upper === 'SELECT' && fromIndex >= 0 ? top.slice(1, fromIndex) : [];
  const aliases = collectOuterAliases(from);
  const has = (word: string): boolean => top.some(token => token.upper === word);
  const uniqueLookup = where.some((token, index) => token.upper === 'ID' && where[index + 1]?.text === '='
    && ['number', 'string', 'parameter'].includes(where[index + 2]?.kind || '')) && !where.some(token => token.upper === 'OR');
  const aggregate = projection.filter(token => token.text !== ',');
  return {
    type: main.upper.toLowerCase() as SqlStatementAst['type'], dialect, tokens: statementTokens, top, main, projection, where, from,
    outerAliases: aliases,
    joinCount: top.filter(token => token.upper === 'JOIN').length,
    hasFilter: has('WHERE'), hasLimit: has('LIMIT') || has('FETCH'), hasOffset: has('OFFSET'), hasOrder: has('ORDER'),
    selectStar: projection.some(token => token.text === '*'),
    aggregateOnly: aggregate.length > 1 && ['COUNT', 'MIN', 'MAX', 'AVG', 'SUM'].includes(aggregate[0]?.upper || '') && aggregate[1]?.text === '(',
    uniqueLookup,
    unionWithoutAll: top.some((token, index) => token.upper === 'UNION' && top[index + 1]?.upper !== 'ALL'),
    redundantDistinct: has('DISTINCT') && has('GROUP') && has('BY'),
    correlatedSubquery: hasCorrelatedSubquery(statementTokens, aliases),
    cartesianJoin: hasCartesianJoin(from, where),
    functionOnFilter: hasFunctionOnFilter(where),
    castOnFilter: hasCastOnFilter(where),
    largeInList: largestInList(where),
    orPredicates: where.filter(token => token.upper === 'OR').length
  };
}

function finding(ast: SqlStatementAst, source: string, options: SqlAnalysisOptions, input: Omit<VelloxFindingInput, 'file' | 'line' | 'evidence' | 'metadata'> & { evidence?: string; metadata?: Record<string, string | number | boolean> }): VelloxFindingInput {
  return {
    ...input,
    evidence: input.evidence || source.trim().replace(/\s+/g, ' ').slice(0, 500),
    file: options.file,
    line: options.line,
    metadata: { parser: 'vellox-sql-ast', dialect: ast.dialect, statement: ast.type, ...input.metadata }
  };
}

function astFindings(ast: SqlStatementAst, source: string, options: SqlAnalysisOptions): VelloxFindingInput[] {
  const largeInThreshold = options.largeInThreshold ?? 100;
  const excessiveOrThreshold = options.excessiveOrThreshold ?? 5;
  const bounded = ast.hasLimit || ast.aggregateOnly || ast.uniqueLookup;
  const rules: Array<{ test: boolean; id: string; severity: Severity; confidence?: VelloxFindingInput['confidence']; title: string; recommendation: string; metadata?: Record<string, string | number | boolean> }> = [
    { test: ast.selectStar, id: 'query/select-star', severity: 'MEDIUM', title: 'Wildcard SELECT retrieval', recommendation: 'Select only required columns to reduce transfer and enable index-only scans.' },
    { test: ast.type === 'select' && !bounded, id: 'query/unbounded-select', severity: 'MEDIUM', title: 'Unbounded SELECT query', recommendation: 'Add a bounded limit and cursor/keyset pagination when the predicate is not guaranteed unique.' },
    { test: ast.type === 'select' && !ast.hasFilter && !bounded, id: 'query/missing-filter', severity: 'MEDIUM', title: 'SELECT without a filter', recommendation: 'Add a selective predicate or document why the table is safely bounded.' },
    { test: ast.tokens.some((token, index) => token.upper === 'NOT' && ast.tokens[index + 1]?.upper === 'IN' && ast.tokens.slice(index + 2).some(item => item.upper === 'SELECT')), id: 'query/not-in-null', severity: 'HIGH', title: 'NOT IN subquery null trap', recommendation: 'Use NOT EXISTS or an anti-join with explicit null behavior.' },
    { test: ast.top.some((token, index) => token.upper === 'ORDER' && ast.top[index + 1]?.upper === 'BY' && ['RANDOM', 'RAND'].includes(ast.top[index + 2]?.upper || '')), id: 'query/random-sort', severity: 'HIGH', title: 'Random full-set sort', recommendation: 'Use sampling or indexed random slots instead of sorting the full result.' },
    { test: ast.functionOnFilter, id: 'query/function-on-filter', severity: 'MEDIUM', title: 'Function-wrapped filter column', recommendation: 'Rewrite as a sargable predicate or add a matching functional index.', metadata: { predicate: 'function' } },
    { test: ast.castOnFilter, id: 'query/non-sargable-predicate', severity: 'MEDIUM', title: 'Predicate casts an indexed candidate column', recommendation: 'Cast the parameter instead of the column or add a matching expression index.', metadata: { predicate: 'cast' } },
    { test: ast.joinCount > 0 && ast.top.some(token => token.upper === 'DISTINCT'), id: 'query/distinct-join', severity: 'MEDIUM', title: 'DISTINCT may hide join multiplication', recommendation: 'Review join cardinality and prefer EXISTS when only presence is required.' },
    { test: ast.joinCount >= 5, id: 'query/excessive-joins', severity: 'MEDIUM', title: 'Large join graph needs cardinality review', recommendation: 'Verify join cardinalities and indexes with EXPLAIN; split the query only when measurements justify it.', metadata: { joinCount: ast.joinCount } },
    { test: ast.unionWithoutAll, id: 'query/union-deduplication', severity: 'MEDIUM', title: 'UNION performs a global deduplication', recommendation: 'Use UNION ALL when duplicate removal is not required, then validate row semantics.' },
    { test: ast.redundantDistinct, id: 'query/redundant-distinct', severity: 'MEDIUM', title: 'DISTINCT may duplicate GROUP BY work', recommendation: 'Remove DISTINCT only after confirming GROUP BY already guarantees the required uniqueness.' },
    { test: (ast.type === 'update' || ast.type === 'delete') && !ast.hasFilter, id: 'query/unbounded-write', severity: 'HIGH', title: 'Write statement has no WHERE clause', recommendation: 'Add the intended predicate or explicitly document and review the full-table write.' },
    { test: ast.cartesianJoin, id: 'query/cartesian-product', severity: 'HIGH', confidence: 'HIGH', title: 'Join can produce a Cartesian product', recommendation: 'Add the missing join predicate or explicitly document why the cross product is bounded and intentional.' },
    { test: ast.correlatedSubquery, id: 'query/correlated-subquery', severity: 'MEDIUM', confidence: 'MEDIUM', title: 'Correlated subquery can execute per outer row', recommendation: 'Compare the plan against a join, pre-aggregation, or EXISTS rewrite and keep the correlated form only when measured faster.' },
    { test: ast.largeInList >= largeInThreshold, id: 'query/large-in-list', severity: 'MEDIUM', title: 'Large IN list increases parse and planning work', recommendation: 'Load values into a temporary/derived table or use a typed array/table parameter supported by the database.', metadata: { itemCount: ast.largeInList, threshold: largeInThreshold } },
    { test: ast.orPredicates >= excessiveOrThreshold, id: 'query/or-predicate-explosion', severity: 'MEDIUM', confidence: 'MEDIUM', title: 'Large OR chain can prevent efficient access paths', recommendation: 'Consider an IN predicate, UNION ALL branches, or a lookup table, then compare execution plans.', metadata: { orCount: ast.orPredicates, threshold: excessiveOrThreshold } },
    { test: ast.hasOffset && !ast.hasOrder, id: 'query/unstable-pagination', severity: 'HIGH', title: 'OFFSET pagination has no deterministic order', recommendation: 'Add a stable unique ORDER BY and prefer keyset pagination for deep pages.' }
  ];
  const results = rules.filter(rule => rule.test).map(rule => finding(ast, source, options, {
    ruleId: rule.id, severity: rule.severity, confidence: rule.confidence || 'HIGH', category: 'query', title: rule.title,
    recommendation: rule.recommendation, metadata: rule.metadata
  }));
  const leadingWildcard = ast.tokens.some((token, index) => token.kind === 'string' && decodeSqlString(token.text).startsWith('%')
    && ['LIKE', 'ILIKE'].includes(ast.tokens[index - 1]?.upper || ''));
  if (leadingWildcard) results.push(finding(ast, source, options, {
    ruleId: 'query/leading-wildcard', severity: 'HIGH', confidence: 'HIGH', category: 'query', title: 'Leading wildcard search',
    recommendation: 'Use prefix search or a purpose-built full-text/trigram index.'
  }));
  const offsetIndex = ast.top.findIndex(token => token.upper === 'OFFSET');
  const offset = offsetIndex >= 0 && ast.top[offsetIndex + 1]?.kind === 'number' ? Number(ast.top[offsetIndex + 1]?.text.replace(/_/g, '')) : 0;
  if (offset >= 1000) results.push(finding(ast, source, options, {
    ruleId: 'query/deep-offset', severity: 'HIGH', confidence: 'HIGH', category: 'query', title: 'Deep OFFSET pagination',
    evidence: `Query uses OFFSET ${offset}.`, recommendation: 'Use cursor/keyset pagination.', metadata: { offset }
  }));
  return results;
}

export function analyzeSqlSyntax(source: string, options: SqlAnalysisOptions = {}): SqlAnalysisResult {
  const requested = options.dialect || 'auto';
  const dialect = detectDialect(source, requested);
  const tokenized = tokenize(source);
  if (tokenized.issue) return { findings: [], parsed: false, dialect, parser: 'vellox-sql-ast', issue: tokenized.issue };
  const ast = parseAst(dialect, tokenized.tokens);
  if (!ast) return { findings: [], parsed: true, dialect, parser: 'vellox-sql-ast' };
  return { findings: astFindings(ast, source, options), parsed: true, dialect, parser: 'vellox-sql-ast' };
}

export interface SqlDocumentAnalysis {
  findings: VelloxFindingInput[];
  issues: Array<SqlParseIssue & { statementLine: number }>;
  statements: number;
  dialects: ResolvedSqlDialect[];
}

export function analyzeSqlDocumentSyntax(source: string, options: SqlAnalysisOptions = {}): SqlDocumentAnalysis {
  const tokenized = tokenize(source);
  if (tokenized.issue) {
    const statements = (source.match(/(?:^|;)\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(?:SELECT|WITH|UPDATE|DELETE|INSERT)\b/gim) || []).length;
    return { findings: [], issues: [{ ...tokenized.issue, statementLine: options.line || 1 }], statements, dialects: [detectDialect(source, options.dialect || 'auto')] };
  }
  const boundaries = tokenized.tokens.filter(token => token.text === ';' && token.depth === 0);
  const slices: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const boundary of boundaries) {
    slices.push({ start, end: boundary.start });
    start = boundary.end;
  }
  slices.push({ start, end: source.length });
  const findings: VelloxFindingInput[] = [];
  const issues: SqlDocumentAnalysis['issues'] = [];
  const dialects = new Set<ResolvedSqlDialect>();
  let statements = 0;
  for (const slice of slices) {
    const firstToken = tokenized.tokens.find(token => token.start >= slice.start && token.start < slice.end);
    if (!firstToken) continue;
    const statement = source.slice(firstToken.start, slice.end);
    if (!/^(?:SELECT|WITH|UPDATE|DELETE|INSERT)\b/i.test(statement)) continue;
    statements += 1;
    const statementLine = (options.line || 1) + lineAt(source, firstToken.start) - 1;
    const result = analyzeSqlSyntax(statement, { ...options, line: statementLine });
    dialects.add(result.dialect);
    findings.push(...result.findings);
    if (result.issue) issues.push({ ...result.issue, line: statementLine + result.issue.line - 1, statementLine });
  }
  return { findings, issues, statements, dialects: [...dialects] };
}
