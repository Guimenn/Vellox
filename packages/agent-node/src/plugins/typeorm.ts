import { BaseDatabaseAdapter } from '@infrawaste/db-core';
import { TraceContextManager } from '../context.js';

export interface TypeormLoggerLike {
  logQuery(query: string, parameters?: any[], queryRunner?: any): any;
  logQueryError(error: string | Error, query: string, parameters?: any[], queryRunner?: any): any;
  logQuerySlow(time: number, query: string, parameters?: any[], queryRunner?: any): any;
  logSchemaBuild(message: string, queryRunner?: any): any;
  logMigration(message: string, queryRunner?: any): any;
  log(level: 'log' | 'info' | 'warn', message: any, queryRunner?: any): any;
}

/**
 * Creates a TypeORM custom logger that sends query telemetry to InfraWaste.
 */
export function createTypeormLogger(adapter: BaseDatabaseAdapter): TypeormLoggerLike {
  return {
    logQuery(query: string, _parameters?: any[]) {
      try {
        const traceCtx = TraceContextManager.getCurrentContext();
        adapter.recordExecution(query, 1.0, {
          traceId: traceCtx?.traceId,
          spanId: traceCtx?.spanId
        });
      } catch {
        // Failure independence
      }
    },
    logQuerySlow(time: number, query: string, _parameters?: any[]) {
      try {
        const traceCtx = TraceContextManager.getCurrentContext();
        adapter.recordExecution(query, time, {
          traceId: traceCtx?.traceId,
          spanId: traceCtx?.spanId
        });
      } catch {
        // Failure independence
      }
    },
    logQueryError(_error: string | Error, _query: string) {},
    logSchemaBuild(_message: string) {},
    logMigration(_message: string) {},
    log(_level: any, _message: any) {}
  };
}
