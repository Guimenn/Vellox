import { DatabaseTelemetry, DatabaseType, HttpTelemetry } from '@infrawaste/core';
import { SqlFingerprinter } from '@infrawaste/db-core';

export class OtelTransformer {
  private static extractAttribute(attributes: any[] = [], key: string): any {
    const attr = attributes.find((a) => a.key === key);
    if (!attr || !attr.value) return undefined;
    const v = attr.value;
    return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }

  /**
   * Transforms standard OpenTelemetry OTLP trace JSON payloads into InfraWaste telemetry.
   */
  public static transformOtlpExport(otlpPayload: any): {
    httpTelemetries: HttpTelemetry[];
    dbTelemetries: DatabaseTelemetry[];
  } {
    const httpTelemetries: HttpTelemetry[] = [];
    const dbTelemetries: DatabaseTelemetry[] = [];

    const resourceSpans = otlpPayload?.resourceSpans || [];

    for (const rs of resourceSpans) {
      const resourceAttrs = rs.resource?.attributes || [];
      const serviceName =
        this.extractAttribute(resourceAttrs, 'service.name') || 'unknown-otel-service';

      const scopeSpans = rs.scopeSpans || [];
      for (const ss of scopeSpans) {
        const spans = ss.spans || [];
        for (const span of spans) {
          const attrs = span.attributes || [];
          const startNs = BigInt(span.startTimeUnixNano || '0');
          const endNs = BigInt(span.endTimeUnixNano || '0');
          const durationMs = Number(endNs - startNs) / 1_000_000;
          const timestamp = Number(startNs / 1_000_000n);

          // 1. Check for Database Spans (db.system or db.statement)
          const dbSystem = this.extractAttribute(attrs, 'db.system');
          const dbStatement = this.extractAttribute(attrs, 'db.statement') || span.name;
          const dbName = this.extractAttribute(attrs, 'db.name') || 'default_db';

          if (dbSystem || this.extractAttribute(attrs, 'db.statement')) {
            const normalized = SqlFingerprinter.normalize(dbStatement);
            const dbType: DatabaseType =
              dbSystem === 'postgresql' || dbSystem === 'postgres'
                ? 'postgresql'
                : dbSystem === 'mysql'
                ? 'mysql'
                : dbSystem === 'mariadb'
                ? 'mariadb'
                : dbSystem === 'oracle'
                ? 'oracle'
                : dbSystem === 'mongodb'
                ? 'mongodb'
                : dbSystem === 'redis'
                ? 'redis'
                : 'postgresql';

            dbTelemetries.push({
              timestamp,
              databaseType: dbType,
              service: serviceName,
              database: dbName,
              operation: normalized.operation,
              fingerprint: normalized.fingerprint,
              executionCount: 1,
              totalDurationMs: durationMs,
              p50DurationMs: durationMs,
              p95DurationMs: durationMs,
              p99DurationMs: durationMs,
              errorCount: span.status?.code === 2 ? 1 : 0 // 2 = STATUS_CODE_ERROR
            });
            continue;
          }

          // 2. Check for HTTP Spans (http.method or http.route)
          const httpMethod = this.extractAttribute(attrs, 'http.method') || 'GET';
          const httpRoute =
            this.extractAttribute(attrs, 'http.route') ||
            this.extractAttribute(attrs, 'http.target') ||
            span.name ||
            '/';
          const httpStatus = Number(this.extractAttribute(attrs, 'http.status_code')) || 200;

          if (this.extractAttribute(attrs, 'http.method') || this.extractAttribute(attrs, 'http.status_code') || span.kind === 2) {
            httpTelemetries.push({
              timestamp,
              service: serviceName,
              method: httpMethod,
              route: httpRoute,
              statusCode: httpStatus,
              durationMs,
              responseBytes: 0,
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              error: httpStatus >= 400 || span.status?.code === 2
            });
          }
        }
      }
    }

    return { httpTelemetries, dbTelemetries };
  }
}
