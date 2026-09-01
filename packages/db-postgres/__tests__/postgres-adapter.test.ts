import { describe, it, expect, beforeEach } from 'vitest';
import { PostgresDatabaseAdapter } from '../src/adapter.js';

describe('PostgresDatabaseAdapter', () => {
  let adapter: PostgresDatabaseAdapter;

  beforeEach(() => {
    adapter = new PostgresDatabaseAdapter();
    adapter.setServiceName('payment-service');
  });

  it('should declare correct database capabilities', () => {
    const caps = adapter.getCapabilities();
    expect(caps.queryStats).toBe(true);
    expect(caps.executionPlans).toBe(true);
    expect(caps.cacheMetrics).toBe(true);
  });

  it('should parse pg_stat_statements rows into normalized DatabaseTelemetry', () => {
    const mockRows = [
      {
        query: 'SELECT * FROM orders WHERE customer_id = 452;',
        calls: 15000,
        total_exec_time: 45000, // 45s total
        mean_exec_time: 3.0,
        rows: 15000,
        shared_blks_hit: 80000,
        shared_blks_read: 2000
      }
    ];

    const telemetry = adapter.parsePgStatStatements(mockRows);
    expect(telemetry.length).toBe(1);
    expect(telemetry[0]!.databaseType).toBe('postgresql');
    expect(telemetry[0]!.service).toBe('payment-service');
    expect(telemetry[0]!.executionCount).toBe(15000);
    expect(telemetry[0]!.totalDurationMs).toBe(45000);
    expect(telemetry[0]!.p50DurationMs).toBe(3.0);
    expect(telemetry[0]!.bytesRead).toBeGreaterThan(0);
  });

  it('should flag tables with heavy sequential scans as wasteful', () => {
    const tableStats = [
      {
        relname: 'audit_logs',
        seq_scan: 5000,
        seq_tup_read: 5000000,
        idx_scan: 100,
        idx_tup_fetch: 100
      },
      {
        relname: 'users',
        seq_scan: 10,
        seq_tup_read: 100,
        idx_scan: 10000,
        idx_tup_fetch: 10000
      }
    ];

    const analysis = adapter.analyzeTableStats(tableStats);
    const auditLogs = analysis.find(a => a.table === 'audit_logs');
    const users = analysis.find(a => a.table === 'users');

    expect(auditLogs?.isWasteful).toBe(true);
    expect(auditLogs?.seqScanRatio).toBeGreaterThan(0.9);
    expect(users?.isWasteful).toBe(false);
  });

  it('should detect table bloat and recommend VACUUM', () => {
    const tableBloat = [
      {
        relname: 'orders',
        n_live_tup: 20000,
        n_dead_tup: 12000 // 37.5% dead tuples
      }
    ];

    const findings = adapter.detectTableBloat(tableBloat);
    expect(findings.length).toBe(1);
    expect(findings[0]!.isBloated).toBe(true);
    expect(findings[0]!.recommendedAction).toContain('VACUUM');
  });

  it('should tune autovacuum for write-heavy tables', () => {
    const writeHeavy = [
      {
        relname: 'events_log',
        n_live_tup: 500000,
        n_tup_upd: 80000,
        n_tup_del: 20000
      }
    ];

    const tuned = adapter.tuneAutovacuum(writeHeavy);
    expect(tuned[0]!.needsCustomAutovacuum).toBe(true);
    expect(tuned[0]!.recommendedScaleFactor).toBe(0.05);
    expect(tuned[0]!.recommendedDdl).toContain('ALTER TABLE events_log SET');
  });

  it('should identify unused indexes and generate DROP INDEX CONCURRENTLY', () => {
    const indexes = [
      {
        relname: 'users',
        indexrelname: 'idx_users_legacy_code',
        idx_scan: 0
      },
      {
        relname: 'users',
        indexrelname: 'users_pkey',
        idx_scan: 0
      }
    ];

    const findings = adapter.detectUnusedIndexes(indexes);
    expect(findings.length).toBe(1);
    expect(findings[0]!.index).toBe('idx_users_legacy_code');
    expect(findings[0]!.recommendedDropDdl).toContain('DROP INDEX CONCURRENTLY IF EXISTS idx_users_legacy_code;');
  });
});

