import { DatabaseTelemetry, Finding } from '@infrawaste/core';
import { CostEstimator } from '@infrawaste/cost-engine';

export class RedisExpensiveRule {
  /**
   * Detects dangerous/blocking Redis commands (e.g. KEYS *, SMEMBERS, LRANGE huge-range).
   */
  public static analyze(telemetry: DatabaseTelemetry, costEstimator: CostEstimator): Finding | null {
    if (telemetry.databaseType !== 'redis') return null;

    const isDangerousCmd = telemetry.fingerprint.includes('dangerous');
    const isSlowCmd = (telemetry.p95DurationMs || 0) > 20 || (telemetry.totalDurationMs / telemetry.executionCount) > 15;

    if (!isDangerousCmd && !isSlowCmd) return null;

    const confidence = isDangerousCmd ? 97 : 82;
    const savings = costEstimator.estimateDatabaseWasteSavings(12);

    return {
      id: `waste_redis_${telemetry.fingerprint}_${telemetry.timestamp}`,
      type: 'EXPENSIVE_REDIS_COMMAND',
      service: telemetry.service,
      database: telemetry.database,
      rootCause: `Dangerous / blocking Redis command (${telemetry.operation}) detected`,
      confidence,
      severity: isDangerousCmd ? 'CRITICAL' : 'HIGH',
      impact: {
        databaseLoad: -12,
        latencyPercent: -15,
        estimatedMonthlyCost: savings.estimatedPotentialSavingsUsd
      },
      recommendation: {
        action: 'Replace blocking command with SCAN iteration, HSCAN, or targeted key lookups',
        explanation: `Command ${telemetry.operation} blocks the single-threaded Redis event loop, degrading overall latency.`,
        suggestedSolution: 'Use SCAN cursor iteration instead of KEYS, or partition sets into bounded buckets.',
        estimatedImpact: {
          databaseLoad: -12,
          latencyPercent: -15,
          estimatedMonthlyCost: savings.estimatedPotentialSavingsUsd
        },
        evidence: {
          operation: telemetry.operation,
          executionCount: telemetry.executionCount,
          totalDurationMs: telemetry.totalDurationMs,
          p95DurationMs: telemetry.p95DurationMs,
          fingerprint: telemetry.fingerprint
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
