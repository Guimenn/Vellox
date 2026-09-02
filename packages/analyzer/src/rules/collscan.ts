import { DatabaseTelemetry, Finding } from '@vellox/core';

export class CollScanRule {
  /**
   * Detects unindexed MongoDB collection scans (COLLSCAN).
   */
  public static analyze(telemetry: DatabaseTelemetry): Finding | null {
    if (telemetry.databaseType !== 'mongodb') return null;
    if (!telemetry.rowsRead || !telemetry.rowsReturned || telemetry.executionCount < 5) return null;

    const scanRatio = telemetry.rowsRead / Math.max(1, telemetry.rowsReturned);
    if (scanRatio < 15 || telemetry.rowsRead < 500) return null;

    const confidence = Math.min(96, Math.round(80 + Math.min(16, scanRatio / 8)));

    return {
      id: `waste_collscan_${telemetry.fingerprint}_${telemetry.timestamp}`,
      type: 'COLL_SCAN',
      service: telemetry.service,
      database: telemetry.database,
      rootCause: `Unindexed MongoDB collection scan (COLLSCAN) on ${telemetry.fingerprint}`,
      confidence,
      severity: 'HIGH',
      impact: {
        estimatedMonthlyCost: null
      },
      recommendation: {
        action: 'Create MongoDB index for filtered fields',
        explanation: `Operation scanned ${telemetry.rowsRead.toLocaleString()} documents to return ${telemetry.rowsReturned.toLocaleString()} documents.`,
        suggestedSolution: 'Add db.collection.createIndex({ <field>: 1 }) to eliminate collection scan.',
        estimatedImpact: {
          estimatedMonthlyCost: null
        },
        evidence: {
          docsExamined: telemetry.rowsRead,
          docsReturned: telemetry.rowsReturned,
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
