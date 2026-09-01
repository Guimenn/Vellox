import { DatabaseTelemetry, Finding } from '@infrawaste/core';
import { CostEstimator } from '@infrawaste/cost-engine';

export class RepeatedQueryRule {
  /**
   * Detects queries with excessive execution frequencies that constitute database waste.
   */
  public static analyze(telemetry: DatabaseTelemetry, costEstimator: CostEstimator): Finding | null {
    if (telemetry.executionCount < 50) return null;

    // Waste metric: high total duration driven by execution volume
    const meanMs = telemetry.totalDurationMs / telemetry.executionCount;
    const isRepeatedWaste = telemetry.executionCount >= 200 || (telemetry.executionCount >= 50 && telemetry.totalDurationMs >= 1000);

    if (!isRepeatedWaste) return null;

    // Confidence: 90% base, up to 98% based on sample size
    const confidence = Math.min(98, Math.round(90 + Math.log10(telemetry.executionCount)));
    const estimatedCapacityWaste = Math.min(40, Math.round((telemetry.totalDurationMs / 100000) * 100) || 15);
    const savings = costEstimator.estimateDatabaseWasteSavings(estimatedCapacityWaste);

    return {
      id: `waste_rep_${telemetry.fingerprint}_${telemetry.timestamp}`,
      type: 'REPEATED_QUERY',
      service: telemetry.service,
      database: telemetry.database,
      rootCause: `High-frequency repeated ${telemetry.databaseType} query (${telemetry.fingerprint})`,
      confidence,
      severity: telemetry.executionCount > 5000 ? 'CRITICAL' : 'HIGH',
      impact: {
        databaseLoad: -estimatedCapacityWaste,
        latencyPercent: -15,
        estimatedMonthlyCost: savings.estimatedPotentialSavingsUsd
      },
      recommendation: {
        action: 'Introduce query batching, local memoization, or Redis caching',
        explanation: `Query executed ${telemetry.executionCount.toLocaleString()} times consuming ${telemetry.totalDurationMs.toLocaleString()}ms total DB time.`,
        suggestedSolution: 'Batch single-item lookups into IN (?) or DataLoader, or place short-lived cache (TTL ~5-60s).',
        estimatedImpact: {
          databaseLoad: -estimatedCapacityWaste,
          latencyPercent: -15,
          estimatedMonthlyCost: savings.estimatedPotentialSavingsUsd
        },
        evidence: {
          executionCount: telemetry.executionCount,
          totalDurationMs: telemetry.totalDurationMs,
          meanDurationMs: Number(meanMs.toFixed(3)),
          fingerprint: telemetry.fingerprint,
          databaseType: telemetry.databaseType
        }
      },
      timestamp: telemetry.timestamp,
      evidence: {
        executionCount: telemetry.executionCount,
        queryFingerprint: telemetry.fingerprint,
        p95DurationMs: telemetry.p95DurationMs
      }
    };
  }
}
