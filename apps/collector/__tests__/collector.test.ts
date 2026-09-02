import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createCollectorApp } from '../src/server.js';
import express from 'express';

describe('Collector Server', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createCollectorApp();
  });

  it('should accept valid telemetry batches and produce findings', async () => {
    const validBatch = {
      id: 'batch-test-123',
      metadata: {
        service: 'checkout-service',
        environment: 'production',
        agentVersion: '0.2.0',
        hostname: 'node-1',
        droppedBatches: 0,
        droppedEvents: 0,
        bufferUsagePercent: 5.0,
        timestamp: Date.now()
      },
      httpAggregates: [
        {
          service: 'checkout-service',
          method: 'GET',
          route: '/api/v1/orders/:id',
          statusCodeDistribution: { 200: 50 },
          totalRequests: 50,
          errorCount: 0,
          totalDurationMs: 25000,
          percentiles: { min: 100, max: 800, p50: 400, p90: 600, p95: 700, p99: 790, p999: 800 },
          totalResponseBytes: 50000,
          windowStart: Date.now() - 5000,
          windowEnd: Date.now()
        }
      ],
      databaseTelemetry: [
        {
          timestamp: Date.now(),
          databaseType: 'postgresql',
          service: 'checkout-service',
          database: 'orders_db',
          operation: 'SELECT',
          fingerprint: 'sql_order_item_lookup',
          executionCount: 4200, // N+1: 84 queries per request
          totalDurationMs: 20000,
          p50DurationMs: 4.0,
          p95DurationMs: 10.0,
          errorCount: 0,
          rowsReturned: 4200
        }
      ]
    };

    const postRes = await request(app)
      .post('/api/v1/telemetry/batches')
      .send(validBatch)
      .expect(202);

    expect(postRes.body.status).toBe('accepted');
    expect(postRes.body.batchId).toBe('batch-test-123');

    // Query findings
    const findingsRes = await request(app)
      .get('/api/v1/findings')
      .expect(200);

    expect(findingsRes.body.count).toBeGreaterThan(0);
    const nplus1 = findingsRes.body.findings.find((f: any) => f.type === 'POSSIBLE_N_PLUS_ONE');
    expect(nplus1).toBeDefined();
    expect(nplus1.confidence).toBeGreaterThanOrEqual(90);
  });

  it('should export Prometheus format metrics at /metrics', async () => {
    const res = await request(app)
      .get('/metrics')
      .expect(200);

    expect(res.text).toContain('# HELP vellox_batches_ingested_total');
    expect(res.text).toContain('# TYPE vellox_batches_ingested_total counter');
    expect(res.text).toContain('vellox_memory_rss_bytes');
    expect(res.text).not.toContain('monthly_savings_usd');
    expect(res.headers['content-type']).toContain('text/plain');
  });
});
