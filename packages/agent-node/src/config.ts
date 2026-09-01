export interface SamplingConfig {
  normalRate: number;      // 0.0 to 1.0 (e.g. 0.01 = 1% for normal traffic)
  errorRate: number;       // 0.0 to 1.0 (e.g. 1.0 = 100% for errors)
  slowRate: number;        // 0.0 to 1.0 (e.g. 1.0 = 100% for slow requests)
  slowThresholdMs: number; // requests slower than this are treated as slow (e.g. 500ms)
}

export interface CardinalityConfig {
  maxUniqueRoutes: number;
  overflowRouteName: string;
}

export interface AgentConfig {
  serviceName?: string;
  environment?: string;
  collectorEndpoint?: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxMemoryBytes?: number;
  sampling?: Partial<SamplingConfig>;
  cardinality?: Partial<CardinalityConfig>;
  enabled?: boolean;
}

export interface ResolvedAgentConfig {
  serviceName: string;
  environment: string;
  collectorEndpoint: string | null;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxMemoryBytes: number;
  sampling: SamplingConfig;
  cardinality: CardinalityConfig;
  enabled: boolean;
}

export const DEFAULT_AGENT_CONFIG: ResolvedAgentConfig = {
  serviceName: process.env.INFRAWASTE_SERVICE_NAME || 'node-service',
  environment: process.env.NODE_ENV || 'production',
  collectorEndpoint: process.env.INFRAWASTE_COLLECTOR_URL || null,
  flushIntervalMs: 5000,
  maxBatchSize: 100,
  maxMemoryBytes: 30 * 1024 * 1024, // 30 MB buffer limit (well within < 50MB SLA)
  sampling: {
    normalRate: 0.01,
    errorRate: 1.0,
    slowRate: 1.0,
    slowThresholdMs: 500
  },
  cardinality: {
    maxUniqueRoutes: 500,
    overflowRouteName: '/_overflow_'
  },
  enabled: true
};

export function resolveConfig(config: AgentConfig = {}): ResolvedAgentConfig {
  return {
    serviceName: config.serviceName || DEFAULT_AGENT_CONFIG.serviceName,
    environment: config.environment || DEFAULT_AGENT_CONFIG.environment,
    collectorEndpoint: config.collectorEndpoint !== undefined ? config.collectorEndpoint : DEFAULT_AGENT_CONFIG.collectorEndpoint,
    flushIntervalMs: config.flushIntervalMs || DEFAULT_AGENT_CONFIG.flushIntervalMs,
    maxBatchSize: config.maxBatchSize || DEFAULT_AGENT_CONFIG.maxBatchSize,
    maxMemoryBytes: config.maxMemoryBytes || DEFAULT_AGENT_CONFIG.maxMemoryBytes,
    sampling: {
      ...DEFAULT_AGENT_CONFIG.sampling,
      ...(config.sampling || {})
    },
    cardinality: {
      ...DEFAULT_AGENT_CONFIG.cardinality,
      ...(config.cardinality || {})
    },
    enabled: config.enabled ?? DEFAULT_AGENT_CONFIG.enabled
  };
}
