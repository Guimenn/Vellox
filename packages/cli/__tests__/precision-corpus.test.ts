import { describe, expect, it } from 'vitest';
import { scanJavaScriptStructure, scanPythonStructure } from '../src/structural-code.js';

interface CorpusCase {
  name: string;
  language: 'javascript' | 'python';
  source: string;
  expected?: string[];
  forbidden?: string[];
  expectedConfidence?: Record<string, 'HIGH' | 'MEDIUM' | 'LOW'>;
}

const corpus: CorpusCase[] = [
  {
    name: 'JavaScript N+1 query loop', language: 'javascript',
    source: 'async function load(ids) { for (const id of ids) await prisma.user.findUnique({ where: { id } }); }',
    expected: ['code/query-in-loop']
  },
  {
    name: 'JavaScript N+1 through a local helper', language: 'javascript',
    source: 'async function loadOne(id) { return prisma.user.findUnique({ where: { id } }); }\nasync function load(ids) { for (const id of ids) await loadOne(id); }',
    expected: ['code/query-in-loop'],
    expectedConfidence: { 'code/query-in-loop': 'MEDIUM' }
  },
  {
    name: 'JavaScript N+1 through transitive local helpers', language: 'javascript',
    source: 'async function repository(id) { return prisma.user.findUnique({ where: { id } }); }\nasync function loadOne(id) { return repository(id); }\nasync function load(ids) { for (const id of ids) await loadOne(id); }',
    expected: ['code/query-in-loop']
  },
  {
    name: 'JavaScript harmless local helper in a loop', language: 'javascript',
    source: 'function normalize(value) { return value.trim().toLowerCase(); }\nfunction load(items) { for (const item of items) normalize(item); }',
    forbidden: ['code/query-in-loop']
  },
  {
    name: 'JavaScript unbounded database promise fan-out', language: 'javascript',
    source: 'async function load(ids) { return Promise.all(ids.map(id => prisma.user.findUnique({ where: { id } }))); }',
    expected: ['code/unbounded-query-fanout'],
    forbidden: ['code/unbounded-async-fanout']
  },
  {
    name: 'JavaScript database promise fan-out through a local helper', language: 'javascript',
    source: 'async function loadOne(id) { return prisma.user.findUnique({ where: { id } }); }\nasync function load(ids) { return Promise.all(ids.map(id => loadOne(id))); }',
    expected: ['code/unbounded-query-fanout'],
    forbidden: ['code/unbounded-async-fanout']
  },
  {
    name: 'JavaScript statically bounded fan-out through a derived collection', language: 'javascript',
    source: 'const MAX_BATCH = 20;\nasync function load(ids) { const selected = ids.slice(0, MAX_BATCH); return Promise.all(selected.map(id => prisma.user.findUnique({ where: { id } }))); }',
    forbidden: ['code/unbounded-query-fanout', 'code/unbounded-async-fanout']
  },
  {
    name: 'JavaScript dangerously large derived fan-out remains visible', language: 'javascript',
    source: 'async function load(ids) { const selected = ids.slice(0, 1000); return Promise.all(selected.map(id => prisma.user.findUnique({ where: { id } }))); }',
    expected: ['code/unbounded-query-fanout']
  },
  {
    name: 'JavaScript spread copy does not invent a static bound', language: 'javascript',
    source: 'async function load(ids) { const selected = [...ids]; return Promise.all(selected.map(id => prisma.user.findUnique({ where: { id } }))); }',
    expected: ['code/unbounded-query-fanout']
  },
  {
    name: 'JavaScript bounded batch', language: 'javascript',
    source: 'async function load(batches) { for (const batch of batches) await Promise.all(batch.map(id => prisma.user.findUnique({ where: { id } }))); }',
    forbidden: ['code/query-in-loop', 'code/sequential-async-loop', 'code/unbounded-async-fanout', 'code/unbounded-query-fanout', 'code/quadratic-nested-iteration']
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
    name: 'JavaScript array spread growth', language: 'javascript',
    source: 'function copy(items) { let result = []; for (const item of items) result = [...result, item]; return result; }',
    expected: ['code/quadratic-collection-growth']
  },
  {
    name: 'JavaScript reduce spread growth', language: 'javascript',
    source: 'function copy(items) { return items.reduce((result, item) => [...result, item], []); }',
    expected: ['code/quadratic-collection-growth']
  },
  {
    name: 'JavaScript mutable append', language: 'javascript',
    source: 'function copy(items) { const result = []; for (const item of items) result.push(item); return result; }',
    forbidden: ['code/quadratic-collection-growth']
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
    name: 'Python query loop through a local helper', language: 'python',
    source: 'def load_one(user_id):\n    return session.execute(select(User).where(User.id == user_id))\n\ndef load(ids):\n    for user_id in ids:\n        load_one(user_id)\n',
    expected: ['code/synchronous-query-loop'],
    expectedConfidence: { 'code/synchronous-query-loop': 'MEDIUM' }
  },
  {
    name: 'Python query loop through transitive local helpers', language: 'python',
    source: 'def repository(user_id):\n    return session.execute(select(User).where(User.id == user_id))\n\ndef load_one(user_id):\n    return repository(user_id)\n\ndef load(ids):\n    for user_id in ids:\n        load_one(user_id)\n',
    expected: ['code/synchronous-query-loop']
  },
  {
    name: 'Python harmless local helper in a loop', language: 'python',
    source: 'def normalize(value):\n    return value.strip().lower()\n\ndef load(items):\n    for item in items:\n        normalize(item)\n',
    forbidden: ['code/synchronous-query-loop']
  },
  {
    name: 'Python unbounded database gather fan-out', language: 'python',
    source: 'async def load(ids):\n    return await asyncio.gather(*(session.execute(select(User).where(User.id == user_id)) for user_id in ids))\n',
    expected: ['code/unbounded-query-fanout'],
    forbidden: ['code/unbounded-async-fanout']
  },
  {
    name: 'Python database gather fan-out through a local helper', language: 'python',
    source: 'async def load_one(user_id):\n    return await db.execute(select(User).where(User.id == user_id))\n\nasync def load(ids):\n    return await asyncio.gather(*(load_one(user_id) for user_id in ids))\n',
    expected: ['code/unbounded-query-fanout'],
    forbidden: ['code/unbounded-async-fanout']
  },
  {
    name: 'Python bounded database gather batch', language: 'python',
    source: 'async def load(batch):\n    return await asyncio.gather(*(session.execute(query) for query in batch))\n',
    forbidden: ['code/unbounded-query-fanout', 'code/unbounded-async-fanout']
  },
  {
    name: 'Python statically bounded gather through a derived collection', language: 'python',
    source: 'MAX_BATCH = 20\n\nasync def load(ids):\n    selected = ids[:MAX_BATCH]\n    return await asyncio.gather(*(session.execute(query) for query in selected))\n',
    forbidden: ['code/unbounded-query-fanout', 'code/unbounded-async-fanout']
  },
  {
    name: 'Python dangerously large derived gather remains visible', language: 'python',
    source: 'async def load(ids):\n    selected = ids[:1000]\n    return await asyncio.gather(*(session.execute(query) for query in selected))\n',
    expected: ['code/unbounded-query-fanout']
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
  },
  {
    name: 'Python list concat growth', language: 'python',
    source: 'def copy(items):\n    result = []\n    for item in items:\n        result = result + [item]\n    return result\n',
    expected: ['code/quadratic-collection-growth']
  },
  {
    name: 'Python front insertion growth', language: 'python',
    source: 'def copy(items):\n    result = []\n    for item in items:\n        result.insert(0, item)\n    return result\n',
    expected: ['code/quadratic-collection-growth']
  },
  {
    name: 'Python sum list flatten', language: 'python',
    source: 'def flatten(chunks):\n    return sum(chunks, [])\n',
    expected: ['code/quadratic-list-flatten']
  },
  {
    name: 'Python linear append and flatten', language: 'python',
    source: 'def copy(items):\n    result = []\n    for item in items:\n        result.append(item)\n    return [item for chunk in result for item in chunk]\n',
    forbidden: ['code/quadratic-collection-growth', 'code/quadratic-list-flatten']
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
      for (const [rule, confidence] of Object.entries(sample.expectedConfidence || {})) {
        expect(result.findings.find(finding => finding.ruleId === rule)?.confidence).toBe(confidence);
      }
    });
  }
});
