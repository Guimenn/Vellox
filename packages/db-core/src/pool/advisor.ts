export interface ConnectionPoolMetrics {
  activeConnections: number;
  idleConnections: number;
  maxConnectionsConfigured: number;
  queuedRequests: number;
  cpuCores?: number;
  meanAcquireTimeMs?: number;
}

export interface PoolEvaluationResult {
  status: 'OPTIMAL' | 'OVERSIZED' | 'UNDERSIZED_STARVATION';
  recommendedPoolSize: number;
  wastedMemoryMb: number;
  explanation: string;
  recommendations: string[];
}

export class ConnectionPoolAdvisor {
  /**
   * Evaluates connection pool health and provides optimal sizing recommendations.
   */
  public static evaluatePool(metrics: ConnectionPoolMetrics): PoolEvaluationResult {
    const cores = metrics.cpuCores || 4;
    // Standard empirical PostgreSQL formula: pool_size = (cpu_cores * 2) + 1
    const optimalRecommended = Math.max(10, cores * 2 + 1);
    const totalConfigured = metrics.maxConnectionsConfigured || (metrics.activeConnections + metrics.idleConnections);

    // PostgreSQL backend processes consume ~10MB RSS memory per connection
    const estimatedMemoryPerConnMb = 10;
    const idleOrWasted = Math.max(0, totalConfigured - optimalRecommended);
    const wastedMemoryMb = idleOrWasted * estimatedMemoryPerConnMb;

    const recommendations: string[] = [];

    // 1. Check for Oversized Pool (Context Switch & Memory Waste)
    if (totalConfigured > optimalRecommended * 2 && metrics.activeConnections < optimalRecommended) {
      recommendations.push(
        `Reduce pool max size from ${totalConfigured} to ${optimalRecommended}. Oversized pools cause thread context switching and waste ~${wastedMemoryMb} MB RAM.`
      );
      return {
        status: 'OVERSIZED',
        recommendedPoolSize: optimalRecommended,
        wastedMemoryMb,
        explanation: `Pool is configured with ${totalConfigured} connections, but active usage peaks at only ${metrics.activeConnections}.`,
        recommendations
      };
    }

    // 2. Check for Pool Starvation (Queue Backlog)
    if (metrics.queuedRequests > 20 || (metrics.meanAcquireTimeMs && metrics.meanAcquireTimeMs > 100)) {
      recommendations.push(
        `Requests are queuing for pool connections (${metrics.queuedRequests} queued). Audit slow queries holding connections before increasing pool size.`
      );
      return {
        status: 'UNDERSIZED_STARVATION',
        recommendedPoolSize: Math.min(totalConfigured * 2, 50),
        wastedMemoryMb: 0,
        explanation: `Connection starvation detected: ${metrics.queuedRequests} requests waiting for connections.`,
        recommendations
      };
    }

    return {
      status: 'OPTIMAL',
      recommendedPoolSize: optimalRecommended,
      wastedMemoryMb: 0,
      explanation: 'Connection pool metrics are operating within optimal latency and memory boundaries.',
      recommendations: ['Maintain current pool configuration.']
    };
  }
}
