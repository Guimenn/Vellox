import { DatabaseTelemetry, Finding, HttpAggregateTelemetry } from '@vellox/core';

export class CacheOpportunityRule {
  /**
   * Identifies read-heavy, low-error endpoints or queries that are prime caching candidates.
   */
  public static analyzeHttp(route: HttpAggregateTelemetry): Finding | null {
    if (route.method !== 'GET') return null;
    if (route.totalRequests < 1000) return null;
    if (route.errorCount / route.totalRequests > 0.05) return null; // Must be reliable
    if (route.percentiles.p95 < 20) return null; // Already fast

    const confidence = 85;

    return {
      id: `waste_cache_http_${route.route}_${Date.now()}`,
      type: 'CACHE_OPPORTUNITY',
      service: route.service,
      endpoint: `GET ${route.route}`,
      rootCause: `High-volume read endpoint (GET ${route.route}) with high P95 latency (${route.percentiles.p95}ms)`,
      confidence,
      severity: 'MEDIUM',
      impact: {
        estimatedMonthlyCost: null
      },
      recommendation: {
        action: 'Implement HTTP Cache-Control or in-memory / Redis cache',
        explanation: `Endpoint served ${route.totalRequests.toLocaleString()} requests with P95 of ${route.percentiles.p95}ms.`,
        suggestedSolution: 'Add Cache-Control headers with stale-while-revalidate or an edge CDN cache layer.',
        estimatedImpact: {
          estimatedMonthlyCost: null
        },
        evidence: {
          totalRequests: route.totalRequests,
          p95DurationMs: route.percentiles.p95,
          route: route.route
        }
      },
      timestamp: Date.now(),
      evidence: {
        executionCount: route.totalRequests,
        p95DurationMs: route.percentiles.p95
      }
    };
  }

  public static analyzeDb(query: DatabaseTelemetry): Finding | null {
    if (query.operation !== 'SELECT' && query.operation !== 'FIND') return null;
    if (query.executionCount < 5000) return null;

    const confidence = 80;

    return {
      id: `waste_cache_db_${query.fingerprint}_${query.timestamp}`,
      type: 'CACHE_OPPORTUNITY',
      service: query.service,
      database: query.database,
      rootCause: `High-frequency deterministic read query (${query.fingerprint})`,
      confidence,
      severity: 'MEDIUM',
      impact: {
        estimatedMonthlyCost: null
      },
      recommendation: {
        action: 'Cache query results in Redis or application memory',
        explanation: `Query executed ${query.executionCount.toLocaleString()} times consuming ${query.totalDurationMs.toLocaleString()}ms.`,
        suggestedSolution: 'Cache response with key derived from query parameters and an invalidation TTL.',
        estimatedImpact: {
          estimatedMonthlyCost: null
        },
        evidence: {
          executionCount: query.executionCount,
          totalDurationMs: query.totalDurationMs,
          fingerprint: query.fingerprint
        }
      },
      timestamp: query.timestamp,
      evidence: {
        executionCount: query.executionCount,
        queryFingerprint: query.fingerprint,
        p95DurationMs: query.p95DurationMs
      }
    };
  }
}
