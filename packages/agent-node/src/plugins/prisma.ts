import { BaseDatabaseAdapter } from '@vellox/db-core';
import { TraceContextManager } from '../context.js';

export interface PrismaQueryEvent {
  timestamp: Date;
  query: string;
  params: string;
  duration: number; // in milliseconds
  target: string;
}

export interface PrismaLikeClient {
  $on(event: 'query', callback: (event: PrismaQueryEvent) => void): void;
}

/**
 * Attaches zero-overhead telemetry to a PrismaClient instance.
 * Automatically intercepts query events, extracts fingerprints, and tracks durations.
 */
export function bindPrismaTelemetry(
  prisma: PrismaLikeClient,
  adapter: BaseDatabaseAdapter
): void {
  try {
    prisma.$on('query', (e: PrismaQueryEvent) => {
      try {
        const traceCtx = TraceContextManager.getCurrentContext();
        adapter.recordExecution(e.query, e.duration, {
          traceId: traceCtx?.traceId,
          spanId: traceCtx?.spanId
        });
      } catch {
        // Failure independence
      }
    });
  } catch {
    // If $on is not available, fail gracefully
  }
}
