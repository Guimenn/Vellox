/**
 * Waste detection, findings, and impact models for Vellox.
 */

export type WasteType =
  | 'SLOW_QUERY'
  | 'REPEATED_QUERY'
  | 'POSSIBLE_N_PLUS_ONE'
  | 'LARGE_PAYLOAD'
  | 'HIGH_CPU_ENDPOINT'
  | 'EXCESSIVE_NETWORK'
  | 'CACHE_OPPORTUNITY'
  | 'FULL_TABLE_SCAN'
  | 'COLL_SCAN'
  | 'EXPENSIVE_REDIS_COMMAND';

export interface Impact {
  databaseLoad?: number;       // percentage reduction e.g. -27
  cpuLoad?: number;            // percentage reduction e.g. -15
  networkBytes?: number;       // bytes saved per day
  latencyMs?: number;          // latency improvement in ms e.g. -120
  latencyPercent?: number;     // latency reduction percentage e.g. -18
  estimatedMonthlyCost?: number | null; // USD/month estimated savings, null if insufficient pricing data
}

export interface Recommendation {
  action: string;
  explanation: string;
  suggestedSolution: string;
  estimatedImpact: Impact;
  evidence: Record<string, unknown>;
}

export interface Finding {
  id: string;
  type: WasteType;
  service: string;
  endpoint?: string;
  database?: string;
  rootCause: string;
  confidence: number;          // 0 to 100 deterministic confidence score
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  impact: Impact;
  recommendation: Recommendation;
  timestamp: number;
  evidence: {
    executionCount?: number;
    parentQueries?: number;
    childQueries?: number;
    p95DurationMs?: number;
    rowsScanned?: number;
    rowsReturned?: number;
    bytesPayload?: number;
    queryFingerprint?: string;
    sampleTraceIds?: string[];
    [key: string]: unknown;
  };
}

export interface PricingConfig {
  cpuHourUsd: number;
  memoryGbHourUsd: number;
  networkGbUsd: number;
  databaseHourUsd: number;
  databaseStorageGbMonthUsd?: number;
}
