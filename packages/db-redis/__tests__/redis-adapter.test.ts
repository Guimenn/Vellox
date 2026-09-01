import { describe, it, expect, beforeEach } from 'vitest';
import { RedisDatabaseAdapter } from '../src/adapter.js';

describe('RedisDatabaseAdapter', () => {
  let adapter: RedisDatabaseAdapter;

  beforeEach(() => {
    adapter = new RedisDatabaseAdapter();
    adapter.setServiceName('session-cache');
  });

  it('should classify KEYS * as dangerous Redis commands', async () => {
    adapter.recordCommand('KEYS', 'user:*', 45.2, { itemsReturned: 50000 });
    adapter.recordCommand('GET', 'user:123', 0.4, { itemsReturned: 1 });

    const telemetry = await adapter.collectMetrics();
    expect(telemetry.length).toBe(2);

    const keysCmd = telemetry.find(t => t.operation === 'KEYS');
    expect(keysCmd?.fingerprint).toBe('redis_dangerous_keys');
    expect(keysCmd?.executionCount).toBe(1);
  });

  it('should parse Redis INFO data and detect cache pressure', () => {
    const analysis = adapter.parseInfo({
      used_memory: 524288000, // 500 MB
      keyspace_hits: 20000,
      keyspace_misses: 80000, // 20% hit ratio
      evicted_keys: 15000,
      blocked_clients: 8
    });

    expect(analysis.hitRatio).toBe(0.2);
    expect(analysis.isPressureHigh).toBe(true);
    expect(analysis.evictedKeys).toBe(15000);
  });
});
