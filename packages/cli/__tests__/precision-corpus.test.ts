import { describe, expect, it } from 'vitest';
import { scanJavaScriptStructure, scanPythonStructure } from '../src/structural-code.js';

interface CorpusCase {
  name: string;
  language: 'javascript' | 'python';
  source: string;
  expected?: string[];
  forbidden?: string[];
}

const corpus: CorpusCase[] = [
  {
    name: 'JavaScript N+1 query loop', language: 'javascript',
    source: 'async function load(ids) { for (const id of ids) await prisma.user.findUnique({ where: { id } }); }',
    expected: ['code/query-in-loop']
  },
  {
    name: 'JavaScript bounded batch', language: 'javascript',
    source: 'async function load(batches) { for (const batch of batches) await Promise.all(batch.map(id => prisma.user.findUnique({ where: { id } }))); }',
    forbidden: ['code/query-in-loop', 'code/sequential-async-loop', 'code/unbounded-async-fanout', 'code/quadratic-nested-iteration']
  },
  {
    name: 'JavaScript async forEach', language: 'javascript',
    source: 'async function send(items) { items.forEach(async item => await deliver(item)); }',
    expected: ['code/async-foreach']
  },
  {
    name: 'JavaScript unbounded Prisma read', language: 'javascript',
    source: 'async function load() { return prisma.user.findMany({ where: { active: true } }); }',
    expected: ['query/unbounded-orm-read']
  },
  {
    name: 'JavaScript bounded Prisma read', language: 'javascript',
    source: 'async function load() { return prisma.user.findMany({ take: 100, where: { active: true } }); }',
    forbidden: ['query/unbounded-orm-read']
  },
  {
    name: 'JavaScript repeated array search', language: 'javascript',
    source: 'function join(orders, users) { for (const order of orders) users.find(user => user.id === order.userId); }',
    expected: ['code/linear-search-in-loop']
  },
  {
    name: 'JavaScript indexed lookup', language: 'javascript',
    source: 'function join(orders, usersById) { for (const order of orders) usersById.get(order.userId); }',
    forbidden: ['code/linear-search-in-loop']
  },
  {
    name: 'JavaScript nested collection passes', language: 'javascript',
    source: 'function join(orders, users) { orders.forEach(order => users.map(user => [order, user])); }',
    expected: ['code/quadratic-nested-iteration']
  },
  {
    name: 'JavaScript constant matrix', language: 'javascript',
    source: 'function matrix() { for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) consume(i, j); }',
    forbidden: ['code/quadratic-nested-iteration']
  },
  {
    name: 'Python query loop', language: 'python',
    source: 'def load(ids, session):\n    for user_id in ids:\n        session.execute(select(User).where(User.id == user_id))\n',
    expected: ['code/synchronous-query-loop']
  },
  {
    name: 'Python paced polling', language: 'python',
    source: 'async def poll():\n    while running:\n        await fetch_status()\n        await asyncio.sleep(1)\n',
    forbidden: ['code/sequential-async-loop']
  },
  {
    name: 'Python unbounded SQLAlchemy read', language: 'python',
    source: 'def load(session):\n    return session.query(User).all()\n',
    expected: ['query/unbounded-orm-read']
  },
  {
    name: 'Python bounded SQLAlchemy read', language: 'python',
    source: 'def load(session):\n    return session.query(User).limit(100).all()\n',
    forbidden: ['query/unbounded-orm-read']
  },
  {
    name: 'Python repeated list membership', language: 'python',
    source: 'def join(orders, user_ids):\n    for order in orders:\n        if order.user_id in user_ids:\n            consume(order)\n',
    expected: ['code/linear-search-in-loop']
  },
  {
    name: 'Python indexed set membership', language: 'python',
    source: 'def join(orders, user_ids_set):\n    for order in orders:\n        if order.user_id in user_ids_set:\n            consume(order)\n',
    forbidden: ['code/linear-search-in-loop']
  }
];

describe('structural precision corpus', () => {
  for (const sample of corpus) {
    it(sample.name, () => {
      const result = sample.language === 'javascript'
        ? scanJavaScriptStructure(sample.source, 'corpus.ts')
        : scanPythonStructure(sample.source, 'corpus.py');
      const rules = result.findings.map(finding => finding.ruleId);

      expect(result.parsed).toBe(true);
      for (const rule of sample.expected || []) expect(rules).toContain(rule);
      for (const rule of sample.forbidden || []) expect(rules).not.toContain(rule);
    });
  }
});
