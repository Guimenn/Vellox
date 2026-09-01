import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InfraWasteAgent } from '../src/agent.js';

describe('InfraWasteAgent', () => {
  beforeEach(() => {
    InfraWasteAgent.resetInstance();
  });

  afterEach(() => {
    InfraWasteAgent.resetInstance();
  });

  it('should initialize as a singleton and record HTTP requests', () => {
    const agent = InfraWasteAgent.init({
      serviceName: 'order-service',
      environment: 'test',
      flushIntervalMs: 60000 // avoid auto-flush in test
    });

    agent.recordHttp('GET', '/api/v1/orders/123', 200, 15.4, 512, false);
    agent.recordHttp('GET', '/api/v1/orders/456', 200, 22.1, 512, false);
    agent.recordHttp('POST', '/api/v1/orders', 500, 105.0, 128, true);

    const batch = agent.flush();
    expect(batch).not.toBeNull();
    expect(batch?.metadata.service).toBe('order-service');
    expect(batch?.httpAggregates.length).toBe(2);

    const getOrders = batch?.httpAggregates.find(a => a.method === 'GET');
    expect(getOrders?.totalRequests).toBe(2);
    expect(getOrders?.errorCount).toBe(0);
    expect(getOrders?.route).toBe('/api/v1/orders/:id');
    expect(getOrders?.percentiles.p50).toBeGreaterThan(0);

    const postOrders = batch?.httpAggregates.find(a => a.method === 'POST');
    expect(postOrders?.totalRequests).toBe(1);
    expect(postOrders?.errorCount).toBe(1);
  });

  it('should return null on flush when no requests were recorded', () => {
    const agent = InfraWasteAgent.init({ flushIntervalMs: 60000 });
    const batch = agent.flush();
    expect(batch).toBeNull();
  });
});
