import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabaseAdapter } from '../src/adapter.js';

describe('OracleDatabaseAdapter', () => {
  let adapter: OracleDatabaseAdapter;

  beforeEach(() => {
    adapter = new OracleDatabaseAdapter();
    adapter.setServiceName('ledger-service');
  });

  it('should parse Oracle V$SQLSTATS rows converting microseconds to milliseconds', () => {
    const mockRows = [
      {
        SQL_TEXT: 'SELECT balance, status FROM accounts WHERE acc_number = :1',
        SQL_ID: '7b9gq8w41d3fa',
        EXECUTIONS: 80000,
        ELAPSED_TIME: 160_000_000, // 160,000,000 us = 160,000 ms (160 s)
        CPU_TIME: 120_000_000,
        BUFFER_GETS: 240000,
        DISK_READS: 500,
        ROWS_PROCESSED: 80000
      }
    ];

    const telemetry = adapter.parseVSqlStats(mockRows);
    expect(telemetry.length).toBe(1);
    expect(telemetry[0]!.databaseType).toBe('oracle');
    expect(telemetry[0]!.service).toBe('ledger-service');
    expect(telemetry[0]!.executionCount).toBe(80000);
    expect(telemetry[0]!.totalDurationMs).toBe(160000);
    expect(telemetry[0]!.p50DurationMs).toBe(2.0);
    expect(telemetry[0]!.bytesRead).toBeGreaterThan(0);
    expect(telemetry[0]!.fingerprint).toBe('oracle_7b9gq8w41d3fa');
  });
});
