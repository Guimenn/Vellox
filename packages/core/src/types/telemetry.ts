/**
 * Universal Telemetry Data Models for InfraWaste
 */

export type DatabaseType =
  | 'postgresql'
  | 'mysql'
  | 'mongodb'
  | 'mariadb'
  | 'oracle'
  | 'redis'
  | 'sqlserver'
  | 'clickhouse';

export interface DatabaseCapabilities {
  queryStats: boolean;
  executionPlans: boolean;
  lockMetrics: boolean;
  ioMetrics: boolean;
  cacheMetrics: boolean;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database?: string;
  username?: string;
  password?: string;
  options?: Record<string, unknown>;
}

export interface DatabaseHealth {
  healthy: boolean;
  latencyMs: number;
  activeConnections?: number;
  maxConnections?: number;
  message?: string;
}

export interface NormalizedQuery {
  raw: string;
  fingerprint: string;
  operation: string;
  tables: string[];
}

export interface DatabaseTelemetry {
  timestamp: number;
  databaseType: DatabaseType;
  service: string;
  database?: string;
  operation: string;
  fingerprint: string;
  executionCount: number;
  totalDurationMs: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
  p99DurationMs?: number;
  errorCount: number;
  rowsRead?: number;
  rowsReturned?: number;
  bytesRead?: number;
  bytesWritten?: number;
}

export interface DatabaseAdapter {
  name: string;
  connect(config: DatabaseConfig): Promise<void>;
  collectMetrics(): Promise<DatabaseTelemetry[]>;
  normalizeQuery(input: unknown): NormalizedQuery;
  getCapabilities(): DatabaseCapabilities;
  healthCheck(): Promise<DatabaseHealth>;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  route?: string;
  timestamp: number;
}

export interface HttpTelemetry {
  timestamp: number;
  service: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  responseBytes: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  error?: boolean;
}

export interface LatencyPercentiles {
  min: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
}

export interface HttpAggregateTelemetry {
  service: string;
  method: string;
  route: string;
  statusCodeDistribution: Record<number, number>;
  totalRequests: number;
  errorCount: number;
  totalDurationMs: number;
  percentiles: LatencyPercentiles;
  histogramBuckets?: number[];
  totalResponseBytes: number;
  windowStart: number;
  windowEnd: number;
}

export interface TelemetryBatchMetadata {
  service: string;
  environment: string;
  agentVersion: string;
  hostname: string;
  droppedBatches: number;
  droppedEvents: number;
  bufferUsagePercent: number;
  timestamp: number;
}

export interface TelemetryBatch {
  id: string;
  metadata: TelemetryBatchMetadata;
  httpAggregates: HttpAggregateTelemetry[];
  databaseTelemetry?: DatabaseTelemetry[];
  sampledHttpEvents?: HttpTelemetry[];
}
