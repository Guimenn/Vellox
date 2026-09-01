import { DatabaseTelemetry, Finding } from '@infrawaste/core';
import { CostEstimator } from '@infrawaste/cost-engine';

export class TableScanRule {
  /**
   * Detects relational full table scans (rows read vs rows returned ratio > 20x).
   */
  public static analyze(telemetry: DatabaseTelemetry, costEstimator: CostEstimator): Finding | null {
    if (!telemetry.rowsRead || !telemetry.rowsReturned || telemetry.executionCount < 10) {
      return null;
    }

    const scanRatio = telemetry.rowsRead / Math.max(1, telemetry.rowsReturned);
    if (scanRatio < 20 || telemetry.rowsRead < 1000) return null;

    const confidence = Math.min(95, Math.round(75 + Math.min(20, scanRatio / 10)));
    const estimatedCapacityWaste = Math.min(35, Math.round((scanRatio / 100) * 15) || 10);
    const savings = costEstimator.estimateDatabaseWasteSavings(estimatedCapacityWaste);

    return {
      id: `waste_tblscan_${telemetry.fingerprint}_${telemetry.timestamp}`,
      type: 'FULL_TABLE_SCAN',
      service: telemetry.service,
      database: telemetry.database,
      rootCause: `Full table scan detected on ${telemetry.databaseType} query (${telemetry.fingerprint})`,
      confidence,
      severity: scanRatio > 100 ? 'CRITICAL' : 'HIGH',
      impact: {
        databaseLoad: -estimatedCapacityWaste,
        latencyPercent: -20,
        estimatedMonthlyCost: savings.estimatedPotentialSavingsUsd
      },
      recommendation: {
        action: 'Add composite index matching filter columns or refine query predicate',
        explanation: `Query examined ${telemetry.rowsRead.toLocaleString()} rows to return only ${telemetry.rowsReturned.toLocaleString()} rows (Scan Ratio: ${scanRatio.toFixed(1)}x).`,
        suggestedSolution: 'Run EXPLAIN on the fingerprint columns to identify missing index coverage.',
        estimatedImpact: {
          databaseLoad: -estimatedCapacityWaste,
          latencyPercent: -20,
          estimatedMonthlyCost: savings.estimatedPotentialSavingsUsd
        },
        evidence: {
          rowsRead: telemetry.rowsRead,
          rowsReturned: telemetry.rowsReturned,
          scanRatio: Number(scanRatio.toFixed(1)),
          fingerprint: telemetry.fingerprint
        }
      },
      timestamp: telemetry.timestamp,
      evidence: {
        rowsScanned: telemetry.rowsRead,
        rowsReturned: telemetry.rowsReturned,
        queryFingerprint: telemetry.fingerprint
      }
    };
  }
}
