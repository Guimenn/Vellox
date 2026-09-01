import { describe, it, expect, beforeEach } from 'vitest';
import { MysqlDatabaseAdapter } from '../src/adapter.js';

describe('MysqlDatabaseAdapter', () => {
  let adapter: MysqlDatabaseAdapter;

  beforeEach(() => {
    adapter = new MysqlDatabaseAdapter();
    adapter.setServiceName('catalog-service');
  });

  it('should parse Performance Schema rows converting picoseconds to milliseconds accurately', () => {
    const mockRows = [
      {
        SCHEMA_NAME: 'shop_db',
        DIGEST_TEXT: 'SELECT * FROM products WHERE category_id = ? AND price > ?',
        COUNT_STAR: 50000,
        SUM_TIMER_WAIT: 100_000_000_000_000, // 100,000 ms = 100 s
        AVG_TIMER_WAIT: 2_000_000_000,       // 2.0 ms
        SUM_ROWS_EXAMINED: 5000000,
        SUM_ROWS_SENT: 50000,
        SUM_ERRORS: 0
      }
    ];

    const telemetry = adapter.parsePerformanceSchemaDigest(mockRows);
    expect(telemetry.length).toBe(1);
    expect(telemetry[0]!.databaseType).toBe('mysql');
    expect(telemetry[0]!.service).toBe('catalog-service');
    expect(telemetry[0]!.executionCount).toBe(50000);
    expect(telemetry[0]!.totalDurationMs).toBe(100000);
    expect(telemetry[0]!.p50DurationMs).toBe(2.0);
    expect(telemetry[0]!.rowsRead).toBe(5000000);
    expect(telemetry[0]!.rowsReturned).toBe(50000);
  });
});
