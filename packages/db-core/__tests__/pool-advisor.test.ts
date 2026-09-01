import { describe, it, expect } from 'vitest';
import { ConnectionPoolAdvisor } from '../src/pool/advisor.js';

describe('ConnectionPoolAdvisor', () => {
  it('should detect oversized connection pools causing memory waste', () => {
    const metrics = {
      activeConnections: 5,
      idleConnections: 95,
      maxConnectionsConfigured: 100,
      queuedRequests: 0,
      cpuCores: 4
    };

    const evaluation = ConnectionPoolAdvisor.evaluatePool(metrics);
    expect(evaluation.status).toBe('OVERSIZED');
    expect(evaluation.recommendedPoolSize).toBe(10); // Math.max(10, (4 * 2) + 1)
    expect(evaluation.wastedMemoryMb).toBeGreaterThan(500); // ~90 * 10MB
    expect(evaluation.recommendations[0]).toContain('Reduce pool max size');

  });

  it('should detect connection starvation when requests are queuing', () => {
    const metrics = {
      activeConnections: 10,
      idleConnections: 0,
      maxConnectionsConfigured: 10,
      queuedRequests: 85,
      meanAcquireTimeMs: 250,
      cpuCores: 4
    };

    const evaluation = ConnectionPoolAdvisor.evaluatePool(metrics);
    expect(evaluation.status).toBe('UNDERSIZED_STARVATION');
    expect(evaluation.recommendations[0]).toContain('Requests are queuing');
  });
});
