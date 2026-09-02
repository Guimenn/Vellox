import {
  DatabaseCapabilities,
  DatabaseHealth,
  DatabaseType
} from '@vellox/core';
import { BaseDatabaseAdapter } from '@vellox/db-core';

export interface RedisInfoData {
  used_memory?: number | string;
  used_memory_peak?: number | string;
  total_connections_received?: number | string;
  connected_clients?: number | string;
  blocked_clients?: number | string;
  evicted_keys?: number | string;
  keyspace_hits?: number | string;
  keyspace_misses?: number | string;
  instantaneous_ops_per_sec?: number | string;
}

const EXPENSIVE_COMMANDS = new Set([
  'KEYS',
  'SMEMBERS',
  'HGETALL',
  'LRANGE',
  'FLUSHALL',
  'FLUSHDB',
  'SAVE'
]);

export class RedisDatabaseAdapter extends BaseDatabaseAdapter {
  public readonly name: string = 'redis';
  public readonly databaseType: DatabaseType = 'redis';

  public getCapabilities(): DatabaseCapabilities {
    return {
      queryStats: true,
      executionPlans: false,
      lockMetrics: false,
      ioMetrics: true,
      cacheMetrics: true
    };
  }

  public async healthCheck(): Promise<DatabaseHealth> {
    return {
      healthy: true,
      latencyMs: 0.4,
      activeConnections: 5,
      maxConnections: 10000,
      message: 'Redis connection operational'
    };
  }

  /**
   * Records a Redis command execution with classification of expensive commands.
   */
  public recordCommand(
    command: string,
    keyOrPattern: string,
    durationMs: number,
    options: {
      error?: boolean;
      itemsReturned?: number;
      bytesPayload?: number;
    } = {}
  ): void {
    const cmdUpper = (command || 'UNKNOWN').toUpperCase();
    const isDangerous = EXPENSIVE_COMMANDS.has(cmdUpper);
    const fingerprint = isDangerous
      ? `redis_dangerous_${cmdUpper.toLowerCase()}`
      : `redis_${cmdUpper.toLowerCase()}`;

    this.recordExecution(
      {
        raw: `${cmdUpper} ${keyOrPattern || '*'}`,
        fingerprint,
        operation: cmdUpper,
        tables: []
      },
      durationMs,
      {
        error: options.error,
        rowsReturned: options.itemsReturned,
        bytesRead: options.bytesPayload
      }
    );
  }

  /**
   * Analyzes parsed Redis INFO data for memory and cache efficiency.
   */
  public parseInfo(info: RedisInfoData): {
    hitRatio: number;
    evictedKeys: number;
    blockedClients: number;
    usedMemoryMb: number;
    isPressureHigh: boolean;
  } {
    const hits = Number(info.keyspace_hits) || 0;
    const misses = Number(info.keyspace_misses) || 0;
    const totalOps = hits + misses;
    const hitRatio = totalOps > 0 ? Number((hits / totalOps).toFixed(3)) : 1.0;
    const evictedKeys = Number(info.evicted_keys) || 0;
    const blockedClients = Number(info.blocked_clients) || 0;
    const usedMemoryMb = Number(((Number(info.used_memory) || 0) / (1024 * 1024)).toFixed(2));

    const isPressureHigh = evictedKeys > 1000 || blockedClients > 5 || hitRatio < 0.6;

    return {
      hitRatio,
      evictedKeys,
      blockedClients,
      usedMemoryMb,
      isPressureHigh
    };
  }
}
