import { describe, expect, it } from 'vitest';
import { analyzeSqlDocumentDetailed, analyzeSqlQuery } from '../src/scanner.js';
import { analyzeSqlSyntax } from '../src/sql-analysis.js';

function rules(sql: string, options: Parameters<typeof analyzeSqlSyntax>[1] = {}): string[] {
  return analyzeSqlSyntax(sql, options).findings.map(finding => finding.ruleId);
}

describe('dialect-aware SQL AST analysis', () => {
  it('detects dialect signals and records parser evidence', () => {
    const postgres = analyzeSqlSyntax('SELECT id FROM users WHERE email ILIKE $1 LIMIT 10');
    const mysql = analyzeSqlSyntax('SELECT `id` FROM `users` LIMIT 10');
    const sqlite = analyzeSqlSyntax('PRAGMA table_info(users)');

    expect(postgres.dialect).toBe('postgresql');
    expect(mysql.dialect).toBe('mysql');
    expect(sqlite.dialect).toBe('sqlite');
    expect(postgres.findings.every(finding => finding.metadata?.parser === 'vellox-sql-ast')).toBe(true);
  });

  it('finds correlated subqueries without flagging independent subqueries', () => {
    expect(rules('SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id) LIMIT 10'))
      .toContain('query/correlated-subquery');
    expect(rules('SELECT u.id FROM users u WHERE u.id IN (SELECT user_id FROM active_users) LIMIT 10'))
      .not.toContain('query/correlated-subquery');
  });

  it('distinguishes Cartesian products from joined relations', () => {
    expect(rules('SELECT a.id FROM accounts a CROSS JOIN regions r LIMIT 10')).toContain('query/cartesian-product');
    expect(rules('SELECT a.id FROM accounts a JOIN regions r LIMIT 10')).toContain('query/cartesian-product');
    expect(rules('SELECT a.id FROM accounts a JOIN regions r ON r.id = a.region_id LIMIT 10')).not.toContain('query/cartesian-product');
    expect(rules('SELECT a.id FROM accounts a, regions r WHERE r.id = a.region_id LIMIT 10')).not.toContain('query/cartesian-product');
    expect(rules('SELECT a.id FROM accounts a NATURAL JOIN regions r LIMIT 10')).not.toContain('query/cartesian-product');
  });

  it('detects non-sargable predicates but preserves range predicates', () => {
    expect(rules('SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1')).toContain('query/function-on-filter');
    expect(rules('SELECT id FROM users WHERE user_id::text = $1 LIMIT 1')).toContain('query/non-sargable-predicate');
    expect(rules('SELECT id FROM events WHERE created_at >= $1 AND created_at < $2 LIMIT 100')).not.toContain('query/non-sargable-predicate');
  });

  it('detects large IN lists, OR explosions, and unstable pagination with configurable thresholds', () => {
    const sql = 'SELECT id FROM users WHERE id IN (1, 2, 3, 4, 5) AND (email = ? OR name = ? OR phone = ?) OFFSET 1200';
    const result = analyzeSqlSyntax(sql, { largeInThreshold: 5, excessiveOrThreshold: 2 });
    const ids = result.findings.map(finding => finding.ruleId);

    expect(ids).toEqual(expect.arrayContaining([
      'query/large-in-list',
      'query/or-predicate-explosion',
      'query/unstable-pagination',
      'query/deep-offset'
    ]));
    expect(result.findings.find(finding => finding.ruleId === 'query/large-in-list')?.metadata?.itemCount).toBe(5);
  });

  it('uses tokens instead of matching SQL keywords inside strings and comments', () => {
    const ids = rules("SELECT id FROM messages WHERE body = 'ORDER BY RANDOM() OFFSET 9000' LIMIT 1 -- CROSS JOIN x");
    expect(ids).not.toEqual(expect.arrayContaining(['query/random-sort', 'query/deep-offset', 'query/cartesian-product']));
  });

  it('reports malformed SQL and uses the conservative legacy analyzer as fallback', () => {
    const syntax = analyzeSqlSyntax("SELECT * FROM users WHERE email = 'broken");
    const document = analyzeSqlDocumentDetailed("SELECT * FROM users WHERE email = 'broken", 'broken.sql');

    expect(syntax.parsed).toBe(false);
    expect(syntax.issue).toMatchObject({ line: 1, message: 'Unterminated string literal' });
    expect(document.issues).toHaveLength(1);
    expect(document.findings.map(finding => finding.ruleId)).toContain('query/select-star');
  });

  it('retains the public SQL analyzer contract', () => {
    const findings = analyzeSqlQuery('SELECT * FROM users OFFSET 2000');
    expect(findings.map(finding => finding.ruleId)).toEqual(expect.arrayContaining([
      'query/select-star', 'query/unbounded-select', 'query/deep-offset', 'query/unstable-pagination'
    ]));
    expect(findings.every(finding => finding.fingerprint.length === 20)).toBe(true);
  });
});
