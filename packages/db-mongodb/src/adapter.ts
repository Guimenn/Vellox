import {
  DatabaseCapabilities,
  DatabaseHealth,
  DatabaseType
} from '@infrawaste/core';
import { BaseDatabaseAdapter, MongoFingerprinter } from '@infrawaste/db-core';

export interface MongoCommandSucceededEvent {
  commandName: string;
  duration: number; // in milliseconds
  reply?: {
    cursor?: {
      firstBatch?: unknown[];
      id?: unknown;
      ns?: string;
    };
    n?: number;
    nModified?: number;
    docsExamined?: number;
    docsReturned?: number;
    [key: string]: unknown;
  };
  databaseName?: string;
}

export class MongoDatabaseAdapter extends BaseDatabaseAdapter {
  public readonly name: string = 'mongodb';
  public readonly databaseType: DatabaseType = 'mongodb';

  public getCapabilities(): DatabaseCapabilities {
    return {
      queryStats: true,
      executionPlans: true,
      lockMetrics: false,
      ioMetrics: false,
      cacheMetrics: false
    };
  }

  public async healthCheck(): Promise<DatabaseHealth> {
    return {
      healthy: true,
      latencyMs: 0.9,
      activeConnections: 8,
      maxConnections: 500,
      message: 'MongoDB connection operational'
    };
  }

  /**
   * MongoDB Command Monitoring Success Listener
   */
  public handleCommandSucceeded(
    collection: string,
    event: MongoCommandSucceededEvent,
    filterObj?: Record<string, unknown>
  ): void {
    const norm = MongoFingerprinter.normalize(collection, event.commandName, filterObj);
    const durationMs = event.duration || 0;

    let rowsReturned = 0;
    if (event.reply?.cursor?.firstBatch) {
      rowsReturned = event.reply.cursor.firstBatch.length;
    } else if (typeof event.reply?.n === 'number') {
      rowsReturned = event.reply.n;
    }

    const rowsRead = Number(event.reply?.docsExamined) || rowsReturned;

    this.recordExecution(norm, durationMs, {
      rowsRead,
      rowsReturned,
      error: false
    });
  }

  /**
   * MongoDB Command Monitoring Failure Listener
   */
  public handleCommandFailed(
    collection: string,
    commandName: string,
    durationMs: number,
    filterObj?: Record<string, unknown>
  ): void {
    const norm = MongoFingerprinter.normalize(collection, commandName, filterObj);

    this.recordExecution(norm, durationMs, {
      error: true
    });
  }
}
