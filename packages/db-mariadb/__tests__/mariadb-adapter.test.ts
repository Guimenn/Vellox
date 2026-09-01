import { describe, it, expect, beforeEach } from 'vitest';
import { MariadbDatabaseAdapter } from '../src/adapter.js';

describe('MariadbDatabaseAdapter', () => {
  let adapter: MariadbDatabaseAdapter;

  beforeEach(() => {
    adapter = new MariadbDatabaseAdapter();
    adapter.setServiceName('inventory-service');
  });

  it('should declare MariaDB specific capabilities', () => {
    const caps = adapter.getCapabilities();
    expect(caps.queryStats).toBe(true);
    expect(caps.executionPlans).toBe(true);
    expect(caps.ioMetrics).toBe(true);
    expect(caps.cacheMetrics).toBe(true);
  });

  it('should parse MariaDB digest rows into normalized DatabaseTelemetry', () => {
    const mockRows = [
      {
        SCHEMA_NAME: 'inventory_db',
        DIGEST_TEXT: 'SELECT stock_qty FROM inventory WHERE sku = ?',
        COUNT_STAR: 12000,
        SUM_TIMER_WAIT: 12_000_000_000_000, // 12,000 ms
        AVG_TIMER_WAIT: 1_000_000_000,      // 1.0 ms
        SUM_ROWS_EXAMINED: 12000,
        SUM_ROWS_SENT: 12000,
        SUM_ERRORS: 0
      }
    ];

    const telemetry = adapter.parsePerformanceSchemaDigest(mockRows);
    expect(telemetry.length).toBe(1);
    expect(telemetry[0]!.databaseType).toBe('mariadb');
    expect(telemetry[0]!.executionCount).toBe(12000);
    expect(telemetry[0]!.totalDurationMs).toBe(12000);
    expect(telemetry[0]!.p50DurationMs).toBe(1.0);
  });
});
