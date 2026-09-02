import { describe, it, expect, beforeEach } from 'vitest';
import { BoundedTelemetryBuffer } from '../src/buffer/ring-buffer.js';
import { TelemetryBatch } from '../src/types/telemetry.js';

describe('BoundedTelemetryBuffer', () => {
  let buffer: BoundedTelemetryBuffer;

  const createMockBatch = (id: string, reqCount: number = 10): TelemetryBatch => ({
    id,
    metadata: {
      service: 'test-service',
      environment: 'test',
      agentVersion: '0.2.0',
      hostname: 'localhost',
      droppedBatches: 0,
      droppedEvents: 0,
      bufferUsagePercent: 0,
      timestamp: Date.now()
    },
    httpAggregates: [
      {
        service: 'test-service',
        method: 'GET',
        route: '/api/v1/test',
        statusCodeDistribution: { 200: reqCount },
        totalRequests: reqCount,
        errorCount: 0,
        totalDurationMs: 100,
        percentiles: { min: 1, max: 20, p50: 10, p90: 15, p95: 18, p99: 19, p999: 20 },
        totalResponseBytes: 1024,
        windowStart: Date.now() - 5000,
        windowEnd: Date.now()
      }
    ]
  });

  beforeEach(() => {
    buffer = new BoundedTelemetryBuffer({ maxCapacity: 3, maxMemoryBytes: 10000 });
  });

  it('should enqueue and dequeue batches in FIFO order', () => {
    buffer.enqueue(createMockBatch('batch-1'));
    buffer.enqueue(createMockBatch('batch-2'));

    expect(buffer.getStats().size).toBe(2);

    const b1 = buffer.dequeue();
    expect(b1?.id).toBe('batch-1');

    const b2 = buffer.dequeue();
    expect(b2?.id).toBe('batch-2');

    expect(buffer.dequeue()).toBeNull();
    expect(buffer.getStats().size).toBe(0);
  });

  it('should shed oldest batches when capacity is exceeded', () => {
    buffer.enqueue(createMockBatch('batch-1', 100));
    buffer.enqueue(createMockBatch('batch-2', 200));
    buffer.enqueue(createMockBatch('batch-3', 300));

    // Capacity is 3, pushing 4th should drop batch-1
    buffer.enqueue(createMockBatch('batch-4', 400));

    const stats = buffer.getStats();
    expect(stats.size).toBe(3);
    expect(stats.droppedBatches).toBe(1);
    expect(stats.droppedEvents).toBe(100);

    const first = buffer.dequeue();
    expect(first?.id).toBe('batch-2');
  });

  it('should shed batches when memory limit is exceeded', () => {
    // Very tight memory buffer
    const tightBuffer = new BoundedTelemetryBuffer({ maxCapacity: 100, maxMemoryBytes: 3000 });

    tightBuffer.enqueue(createMockBatch('b-1', 50));
    tightBuffer.enqueue(createMockBatch('b-2', 50));
    tightBuffer.enqueue(createMockBatch('b-3', 50));

    const stats = tightBuffer.getStats();
    expect(stats.droppedBatches).toBeGreaterThan(0);
    expect(stats.approximateMemoryBytes).toBeLessThanOrEqual(3000);
  });
});
