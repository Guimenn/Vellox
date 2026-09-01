import { DatabaseTelemetry, Finding, HttpAggregateTelemetry } from '@infrawaste/core';
import { CostEstimator } from '@infrawaste/cost-engine';

export class NPlusOneRule {
  /**
   * Detects N+1 query patterns correlated between HTTP route executions and child DB query executions.
   */
  public static analyze(
    httpRoute: HttpAggregateTelemetry,
    childQuery: DatabaseTelemetry,
    costEstimator: CostEstimator
  ): Finding | null {
    if (httpRoute.totalRequests < 10) return null;

    // Correlation check: child query executions scale linearly with HTTP requests (e.g. >= 10 queries per HTTP request)
    const queriesPerRequest = childQuery.executionCount / httpRoute.totalRequests;
    if (queriesPerRequest < 5) return null;

    const confidence = Math.min(96, Math.round(85 + Math.min(10, queriesPerRequest)));
    const estimatedCapacityWaste = Math.min(45, Math.round(queriesPerRequest * 1.8));
    const savings = costEstimator.estimateDatabaseWasteSavings(estimatedCapacityWaste);

    return {
      id: `waste_nplus1_${httpRoute.route}_${childQuery.fingerprint}_${Date.now()}`,
      type: 'POSSIBLE_N_PLUS_ONE',
      service: httpRoute.service,
      endpoint: `${httpRoute.method} ${httpRoute.route}`,
      database: childQuery.database,
      rootCause: `Possible N+1 query cascade triggered by ${httpRoute.method} ${httpRoute.route}`,
      confidence,
      severity: 'CRITICAL',
      impact: {
        databaseLoad: -estimatedCapacityWaste,
        latencyPercent: -28,
        estimatedMonthlyCost: savings.estimatedPotentialSavingsUsd
      },
      recommendation: {
        action: 'Refactor ORM query with eager loading (JOIN FETCH, include) or DataLoader batching',
        explanation: `Each request to ${httpRoute.route} triggers ~${queriesPerRequest.toFixed(0)} individual child queries (${childQuery.fingerprint}).`,
        suggestedSolution: 'Replace loop queries with batch WHERE id IN (?) or ORM eager relations.',
        estimatedImpact: {
          databaseLoad: -estimatedCapacityWaste,
          latencyPercent: -28,
          estimatedMonthlyCost: savings.estimatedPotentialSavingsUsd
        },
        evidence: {
          httpRoute: httpRoute.route,
          httpTotalRequests: httpRoute.totalRequests,
          childExecutionCount: childQuery.executionCount,
          queriesPerRequest: Number(queriesPerRequest.toFixed(1)),
          queryFingerprint: childQuery.fingerprint,
          p95DurationMs: httpRoute.percentiles.p95
        }
      },
      timestamp: Date.now(),
      evidence: {
        parentQueries: httpRoute.totalRequests,
        childQueries: childQuery.executionCount,
        queryFingerprint: childQuery.fingerprint,
        p95DurationMs: httpRoute.percentiles.p95
      }
    };
  }
}
