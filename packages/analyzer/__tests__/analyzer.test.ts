import { describe, it, expect, beforeEach } from 'vitest';
import { WasteAnalyzerEngine } from '../src/engine.js';
import { DatabaseTelemetry, HttpAggregateTelemetry } from '@infrawaste/core';

describe('WasteAnalyzerEngine', () => {
  let engine: WasteAnalyzerEngine;

  beforeEach(() => {
    engine = new WasteAnalyzerEngine();
  });

  it('should detect N+1 query patterns correlated across HTTP endpoints and DB queries', () => {
    const httpAgg: HttpAggregateTelemetry = {
      service: 'checkout-api',
      method: 'GET',
      route: '/api/v1/orders/:id',
      statusCodeDistribution: { 200: 100 },
      totalRequests: 100,
      errorCount: 0,
      totalDurationMs: 45000,
      percentiles: { min: 200, max: 900, p50: 450, p90: 700, p95: 750, p99: 850, p999: 900 },
      totalResponseBytes: 102400,
      windowStart: Date.now() - 5000,
      windowEnd: Date.now()
    };

    const dbTelemetry: DatabaseTelemetry = {
      timestamp: Date.now(),
      databaseType: 'postgresql',
      service: 'checkout-api',
      database: 'orders_db',
      operation: 'SELECT',
      fingerprint: 'sql_order_items_lookup',
      executionCount: 8400, // 84 child queries per request!
      totalDurationMs: 38000,
      p50DurationMs: 4.5,
      p95DurationMs: 12.0,
      errorCount: 0,
      rowsReturned: 8400
    };

    const findings = engine.analyze({
      httpAggregates: [httpAgg],
      databaseTelemetry: [dbTelemetry]
    });

    expect(findings.length).toBeGreaterThan(0);
    const nplus1 = findings.find(f => f.type === 'POSSIBLE_N_PLUS_ONE');
    expect(nplus1).toBeDefined();
    expect(nplus1?.service).toBe('checkout-api');
    expect(nplus1?.confidence).toBeGreaterThanOrEqual(90);
    expect(nplus1?.impact.estimatedMonthlyCost).toBeGreaterThan(0);
    expect(nplus1?.recommendation.suggestedSolution).toContain('eager relations');
  });

  it('should detect MongoDB COLLSCAN patterns', () => {
    const dbTelemetry: DatabaseTelemetry = {
      timestamp: Date.now(),
      databaseType: 'mongodb',
      service: 'catalog-service',
      database: 'products_db',
      operation: 'FIND',
      fingerprint: 'mongo_products_by_status',
      executionCount: 200,
      totalDurationMs: 12000,
      rowsRead: 2000000, // 2 million documents examined
      rowsReturned: 50,   // only 50 returned
      errorCount: 0
    };

    const findings = engine.analyze({
      databaseTelemetry: [dbTelemetry]
    });

    const collscan = findings.find(f => f.type === 'COLL_SCAN');
    expect(collscan).toBeDefined();
    expect(collscan?.confidence).toBeGreaterThanOrEqual(90);
    expect(collscan?.recommendation.suggestedSolution).toContain('createIndex');
  });
});
