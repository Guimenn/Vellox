import { describe, expect, it } from 'vitest';
import { filterRules, formatRuleCatalog, RULE_CATALOG } from '../src/rules.js';

describe('rule catalog', () => {
  it('publishes unique, stable metadata for the complete analyzer surface', () => {
    const ids = RULE_CATALOG.map(rule => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'code/query-in-loop',
      'code/unbounded-query-fanout',
      'code/quadratic-collection-growth',
      'query/unbounded-orm-read',
      'explain/cardinality-misestimation',
      'prisma/missing-relation-index'
    ]));
    expect(RULE_CATALOG.length).toBeGreaterThanOrEqual(50);
  });

  it('filters by id, title, or category and formats audit-friendly output', () => {
    const rules = filterRules('fan-out');
    expect(rules.map(rule => rule.id)).toEqual(['code/unbounded-async-fanout', 'code/unbounded-query-fanout']);
    expect(formatRuleCatalog(rules)).toContain('CONFIDENCE');
    expect(filterRules('infrastructure').length).toBeGreaterThan(0);
  });
});
