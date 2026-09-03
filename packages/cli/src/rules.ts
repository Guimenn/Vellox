import { Confidence, FindingCategory, Severity } from './types.js';

export interface RuleDefinition {
  id: string;
  category: FindingCategory;
  defaultSeverity: Severity;
  defaultConfidence: Confidence;
  title: string;
}

function categoryFor(id: string): FindingCategory {
  if (id.startsWith('code/')) return 'code';
  if (id.startsWith('query/')) return 'query';
  if (id.startsWith('secret/')) return 'security';
  if (id.startsWith('infra/')) return 'infrastructure';
  return 'database';
}

function define(id: string, severity: Severity, title: string, confidence: Confidence = 'HIGH'): RuleDefinition {
  return { id, category: categoryFor(id), defaultSeverity: severity, defaultConfidence: confidence, title };
}

export const RULE_CATALOG: RuleDefinition[] = [
  define('code/async-foreach', 'HIGH', 'Async forEach discards completion semantics'),
  define('code/blocking-call-in-async', 'HIGH', 'Blocking operation inside async code'),
  define('code/dangling-async-map', 'HIGH', 'Async map result is not awaited'),
  define('code/linear-search-in-loop', 'MEDIUM', 'Linear collection lookup is repeated inside a loop', 'MEDIUM'),
  define('code/quadratic-collection-growth', 'MEDIUM', 'Collection is copied while it grows inside an iteration'),
  define('code/quadratic-list-flatten', 'MEDIUM', 'Lists are flattened through repeated concatenation'),
  define('code/quadratic-nested-iteration', 'MEDIUM', 'Nested iteration can grow quadratically', 'MEDIUM'),
  define('code/query-in-loop', 'HIGH', 'Database operation inside a loop'),
  define('code/repeated-sort-in-loop', 'MEDIUM', 'Collection is sorted repeatedly inside a loop', 'MEDIUM'),
  define('code/sequential-async-loop', 'HIGH', 'Sequential asynchronous work inside a loop'),
  define('code/synchronous-query-loop', 'HIGH', 'Synchronous database operation inside a loop'),
  define('code/transaction-in-loop', 'HIGH', 'Transaction boundary inside a loop'),
  define('code/unbounded-async-fanout', 'HIGH', 'Async fan-out has no concurrency bound'),
  define('code/unbounded-global-store', 'MEDIUM', 'Potentially unbounded global in-memory store'),
  define('code/unbounded-query-fanout', 'HIGH', 'Database query fan-out has no concurrency bound'),

  define('query/deep-offset', 'HIGH', 'Deep OFFSET pagination'),
  define('query/distinct-join', 'MEDIUM', 'DISTINCT may hide join multiplication'),
  define('query/dynamic-sql-construction', 'HIGH', 'SQL is assembled from runtime values'),
  define('query/excessive-joins', 'MEDIUM', 'Large join graph needs cardinality review'),
  define('query/function-on-filter', 'MEDIUM', 'Function-wrapped filter column'),
  define('query/leading-wildcard', 'HIGH', 'Leading wildcard search'),
  define('query/missing-filter', 'MEDIUM', 'SELECT without a filter'),
  define('query/not-in-null', 'HIGH', 'NOT IN subquery null trap'),
  define('query/random-sort', 'HIGH', 'Random full-set sort'),
  define('query/redundant-distinct', 'MEDIUM', 'DISTINCT may duplicate GROUP BY work'),
  define('query/select-star', 'MEDIUM', 'Wildcard SELECT retrieval'),
  define('query/unbounded-orm-read', 'MEDIUM', 'ORM collection read has no explicit bound', 'MEDIUM'),
  define('query/unbounded-select', 'MEDIUM', 'Unbounded SELECT query'),
  define('query/unbounded-write', 'HIGH', 'Write statement has no WHERE clause'),
  define('query/union-deduplication', 'MEDIUM', 'UNION performs a global deduplication'),

  define('prisma/missing-relation-index', 'MEDIUM', 'Missing Prisma relation index'),
  define('drizzle/missing-relation-index', 'MEDIUM', 'Missing Drizzle relation index'),
  define('sql/missing-foreign-key-index', 'MEDIUM', 'Foreign key without a supporting index'),
  define('explain/cardinality-misestimation', 'MEDIUM', 'Planner row estimate diverges from execution', 'MEDIUM'),
  define('explain/disk-spill', 'HIGH', 'Execution node spilled temporary data to disk'),
  define('explain/expensive-sequential-scan', 'MEDIUM', 'Sequential scan processes a large relation', 'MEDIUM'),
  define('explain/low-buffer-hit-ratio', 'MEDIUM', 'Plan reads a large share of buffers from storage', 'MEDIUM'),
  define('explain/nested-loop-amplification', 'MEDIUM', 'Nested loop amplifies work across many executions', 'MEDIUM'),

  define('infra/container-floating-base-image', 'MEDIUM', 'Container base image is not pinned'),
  define('infra/container-floating-image', 'MEDIUM', 'Container image is not pinned'),
  define('infra/container-root-user', 'MEDIUM', 'Container final stage has no verified non-root user'),
  define('infra/kubernetes-missing-resources', 'MEDIUM', 'Kubernetes container has no resource policy'),
  define('infra/kubernetes-partial-resources', 'MEDIUM', 'Kubernetes container resource policy is incomplete'),
  define('infra/privileged-workload', 'HIGH', 'Workload enables privileged host access'),
  define('infra/terraform-public-database', 'HIGH', 'Terraform exposes a managed database publicly'),
  define('infra/terraform-public-ingress', 'MEDIUM', 'Terraform ingress is open to the internet'),
  define('infra/terraform-public-storage', 'HIGH', 'Terraform configures public object storage'),

  define('secret/anthropic-api-key', 'CRITICAL', 'Anthropic API key exposed'),
  define('secret/aws-access-key', 'CRITICAL', 'AWS access key exposed'),
  define('secret/database-uri', 'CRITICAL', 'Database URI with credentials exposed'),
  define('secret/github-token', 'CRITICAL', 'GitHub token exposed'),
  define('secret/google-api-key', 'CRITICAL', 'Google API key exposed'),
  define('secret/openai-api-key', 'CRITICAL', 'OpenAI API key exposed'),
  define('secret/private-key', 'CRITICAL', 'Private key exposed'),
  define('secret/stripe-live-key', 'CRITICAL', 'Stripe live key exposed')
].sort((left, right) => left.id.localeCompare(right.id));

export function filterRules(search = ''): RuleDefinition[] {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return RULE_CATALOG;
  return RULE_CATALOG.filter(rule => `${rule.id} ${rule.title} ${rule.category}`.toLowerCase().includes(normalized));
}

export function formatRuleCatalog(rules: RuleDefinition[]): string {
  if (!rules.length) return 'No rules matched the filter.';
  const idWidth = Math.max('RULE'.length, ...rules.map(rule => rule.id.length));
  return [
    `${'RULE'.padEnd(idWidth)}  SEVERITY  CONFIDENCE  TITLE`,
    ...rules.map(rule => `${rule.id.padEnd(idWidth)}  ${rule.defaultSeverity.padEnd(8)}  ${rule.defaultConfidence.padEnd(10)}  ${rule.title}`),
    '',
    `${rules.length} rule(s). Severity can be overridden or the rule disabled in vellox.config.json.`
  ].join('\n');
}
