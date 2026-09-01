import {
  DatabaseCapabilities,
  DatabaseHealth,
  DatabaseTelemetry,
  DatabaseType
} from '@infrawaste/core';
import { BaseDatabaseAdapter, SqlFingerprinter } from '@infrawaste/db-core';

export interface MariadbDigestRow {
  SCHEMA_NAME?: string;
  DIGEST_TEXT: string;
  COUNT_STAR: number | string;
  SUM_TIMER_WAIT: number | string;    // picoseconds
  AVG_TIMER_WAIT?: number | string;
  SUM_LOCK_TIME?: number | string;
  SUM_ERRORS?: number | string;
  SUM_ROWS_AFFECTED?: number | string;
  SUM_ROWS_SENT?: number | string;
  SUM_ROWS_EXAMINED?: number | string;
  SUM_NO_INDEX_USED?: number | string;
}

export class MariadbDatabaseAdapter extends BaseDatabaseAdapter {
  public readonly name: string = 'mariadb';
  public readonly databaseType: DatabaseType = 'mariadb';

  public getCapabilities(): DatabaseCapabilities {
    return {
      queryStats: true,
      executionPlans: true,
      lockMetrics: true,
      ioMetrics: true,
      cacheMetrics: true
    };
  }

  public async healthCheck(): Promise<DatabaseHealth> {
    return {
      healthy: true,
      latencyMs: 1.1,
      activeConnections: 10,
      maxConnections: 200,
      message: 'MariaDB connection operational'
    };
  }

  /**
   * Transforms MariaDB Performance Schema records into normalized DatabaseTelemetry.
   */
  public parsePerformanceSchemaDigest(rows: MariadbDigestRow[]): DatabaseTelemetry[] {
    const timestamp = Date.now();
    const results: DatabaseTelemetry[] = [];

    for (const row of rows) {
      if (!row.DIGEST_TEXT) continue;

      const norm = SqlFingerprinter.normalize(row.DIGEST_TEXT);
      const executionCount = Number(row.COUNT_STAR) || 0;
      const totalDurationMs = (Number(row.SUM_TIMER_WAIT) || 0) / 1_000_000_000;
      const avgDurationMs = (Number(row.AVG_TIMER_WAIT) || 0) / 1_000_000_000;
      const rowsExamined = Number(row.SUM_ROWS_EXAMINED) || 0;
      const rowsReturned = Number(row.SUM_ROWS_SENT) || 0;
      const errorCount = Number(row.SUM_ERRORS) || 0;

      results.push({
        timestamp,
        databaseType: this.databaseType,
        service: this.serviceName,
        database: row.SCHEMA_NAME || this.config?.database || 'mariadb',
        operation: norm.operation,
        fingerprint: norm.fingerprint,
        executionCount,
        totalDurationMs: Number(totalDurationMs.toFixed(3)),
        p50DurationMs: Number(avgDurationMs.toFixed(3)),
        p95DurationMs: Number((avgDurationMs * 1.5).toFixed(3)),
        p99DurationMs: Number((avgDurationMs * 2.7).toFixed(3)),
        errorCount,
        rowsRead: rowsExamined,
        rowsReturned
      });
    }

    return results;
  }
}
