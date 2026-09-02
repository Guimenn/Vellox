import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';
import { TraceContext } from '@vellox/core';

export class TraceContextManager {
  private static storage = new AsyncLocalStorage<TraceContext>();

  public static runWithContext<T>(context: TraceContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  public static getCurrentContext(): TraceContext | undefined {
    return this.storage.getStore();
  }

  public static getTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }

  public static generateTraceId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  public static generateSpanId(): string {
    return crypto.randomBytes(8).toString('hex');
  }
}
