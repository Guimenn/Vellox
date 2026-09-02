import {
  DatabaseAdapter,
  DatabaseCapabilities,
  DatabaseConfig,
  DatabaseHealth,
  DatabaseTelemetry,
  DatabaseType,
  LogHistogram,
  NormalizedQuery
} from '@vellox/core';
import { SqlFingerprinter } from '../fingerprint/sql.js';

interface QueryMetricAccumulator {
  fingerprint: string;
  operation: string;
  executionCount: number;
  totalDurationMs: number;
  histogram: LogHistogram;
  errorCount: number;
  rowsRead: number;
  rowsReturned: number;
  bytesRead: number;
  bytesWritten: number;
}

export abstract class BaseDatabaseAdapter implements DatabaseAdapter {
  public abstract readonly name: string;
  public abstract readonly databaseType: DatabaseType;

  protected config: DatabaseConfig | null = null;
  protected queryMetrics: Map<string, QueryMetricAccumulator> = new Map();
  protected serviceName: string = 'default-service';

  public setServiceName(service: string): void {
    this.serviceName = service;
  }

  public async connect(config: DatabaseConfig): Promise<void> {
    this.config = config;
  }

  public abstract getCapabilities(): DatabaseCapabilities;

  public abstract healthCheck(): Promise<DatabaseHealth>;

  public normalizeQuery(input: unknown): NormalizedQuery {
    if (typeof input === 'string') {
      return SqlFingerprinter.normalize(input);
    }
    return {
      raw: String(input),
      fingerprint: 'sql_unknown',
      operation: 'QUERY',
      tables: []
    };
  }

  /**
   * Records a database query execution in the local accumulator.
   * Execution overhead < 10 microseconds.
   */
  public recordExecution(
    queryOrFingerprint: string | NormalizedQuery,
    durationMs: number,
    options: {
      error?: boolean;
      rowsRead?: number;
      rowsReturned?: number;
      bytesRead?: number;
      bytesWritten?: number;
      traceId?: string;
      spanId?: string;
    } = {}
  ): void {
    const norm = typeof queryOrFingerprint === 'string'
      ? this.normalizeQuery(queryOrFingerprint)
      : queryOrFingerprint;

    let acc = this.queryMetrics.get(norm.fingerprint);
    if (!acc) {
      acc = {
        fingerprint: norm.fingerprint,
        operation: norm.operation,
        executionCount: 0,
        totalDurationMs: 0,
        histogram: new LogHistogram(),
        errorCount: 0,
        rowsRead: 0,
        rowsReturned: 0,
        bytesRead: 0,
        bytesWritten: 0
      };
      this.queryMetrics.set(norm.fingerprint, acc);
    }

    acc.executionCount++;
    acc.totalDurationMs += durationMs;
    acc.histogram.record(durationMs);

    if (options.error) acc.errorCount++;
    if (options.rowsRead) acc.rowsRead += options.rowsRead;
    if (options.rowsReturned) acc.rowsReturned += options.rowsReturned;
    if (options.bytesRead) acc.bytesRead += options.bytesRead;
    if (options.bytesWritten) acc.bytesWritten += options.bytesWritten;
  }

  /**
   * Flushes local accumulator into universal DatabaseTelemetry batches.
   */
  public async collectMetrics(): Promise<DatabaseTelemetry[]> {
    const now = Date.now();
    const result: DatabaseTelemetry[] = [];

    for (const [fingerprint, acc] of this.queryMetrics.entries()) {
      const percentiles = acc.histogram.getPercentiles();
      result.push({
        timestamp: now,
        databaseType: this.databaseType,
        service: this.serviceName,
        database: this.config?.database || 'default',
        operation: acc.operation,
        fingerprint,
        executionCount: acc.executionCount,
        totalDurationMs: Number(acc.totalDurationMs.toFixed(3)),
        p50DurationMs: percentiles.p50,
        p95DurationMs: percentiles.p95,
        p99DurationMs: percentiles.p99,
        errorCount: acc.errorCount,
        rowsRead: acc.rowsRead,
        rowsReturned: acc.rowsReturned,
        bytesRead: acc.bytesRead,
        bytesWritten: acc.bytesWritten
      });
    }

    this.queryMetrics.clear();
    return result;
  }
}
