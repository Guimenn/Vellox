import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { VelloxAgent, velloxExpressMiddleware } from '../../packages/agent-node/src/index.js';
import { BoundedTelemetryBuffer, TelemetryBatch } from '../../packages/core/src/index.js';

describe('Chaos & Resilience Testing (Failure Independence)', () => {
  beforeEach(() => {
    VelloxAgent.resetInstance();
  });

  afterEach(() => {
    VelloxAgent.resetInstance();
  });

  it('Principle 10: Application must continue operating normally when Collector is DOWN', async () => {
    // Point agent to a non-existent port (collector down)
    const agent = VelloxAgent.init({
      serviceName: 'resilience-test-service',
      environment: 'test',
      collectorEndpoint: 'http://127.0.0.1:59999/api/v1/telemetry/batches', // Unreachable
      flushIntervalMs: 60000
    });

    const app = express();
    app.use(velloxExpressMiddleware(agent));
    app.get('/api/v1/checkout', (_req, res) => {
      res.status(200).json({ success: true, timestamp: Date.now() });
    });

    // Execute 50 rapid requests against the application
    for (let i = 0; i < 50; i++) {
      const response = await request(app).get('/api/v1/checkout').expect(200);
      expect(response.body.success).toBe(true);
    }

    // Trigger flush while backend is down
    const batch = agent.flush();
    expect(batch).not.toBeNull();

    // Verify application execution remained unblocked and error-free
  });

  it('Backpressure & Memory Limit: Agent must drop telemetry rather than OOM under extreme flood', () => {
    // 2MB strict buffer limit
    const tightBuffer = new BoundedTelemetryBuffer({
      maxCapacity: 5,
      maxMemoryBytes: 50 * 1024 // 50 KB
    });

    const mockBatch = (id: string): TelemetryBatch => ({
      id,
      metadata: {
        service: 'flood-service',
        environment: 'chaos-test',
        agentVersion: '0.2.0',
        hostname: 'localhost',
        droppedBatches: 0,
        droppedEvents: 0,
        bufferUsagePercent: 0,
        timestamp: Date.now()
      },
      httpAggregates: [
        {
          service: 'flood-service',
          method: 'GET',
          route: '/flood',
          statusCodeDistribution: { 200: 5000 },
          totalRequests: 5000,
          errorCount: 0,
          totalDurationMs: 15000,
          percentiles: { min: 1, max: 20, p50: 3, p90: 8, p95: 12, p99: 18, p999: 20 },
          totalResponseBytes: 500000,
          windowStart: Date.now() - 5000,
          windowEnd: Date.now()
        }
      ]
    });

    // Flood 100 large batches into tight 5-slot buffer
    for (let i = 1; i <= 100; i++) {
      tightBuffer.enqueue(mockBatch(`batch-${i}`));
    }

    const stats = tightBuffer.getStats();
    expect(stats.size).toBeLessThanOrEqual(5);
    expect(stats.droppedBatches).toBeGreaterThan(90);
    expect(stats.droppedEvents).toBeGreaterThan(450000);
    expect(stats.approximateMemoryBytes).toBeLessThanOrEqual(50 * 1024);
  });
});
