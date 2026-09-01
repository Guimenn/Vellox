import { InfraWasteAgent } from '../agent.js';
import { TraceContextManager } from '../context.js';

export interface ExecutionContextLike {
  getType(): string;
  switchToHttp(): {
    getRequest(): any;
    getResponse(): any;
  };
}

export interface CallHandlerLike {
  handle(): {
    pipe(operator: any): any;
    subscribe(observer: { next?: (val: any) => void; error?: (err: any) => void; complete?: () => void }): any;
  };
}

/**
 * Native NestJS Interceptor for InfraWaste performance and waste monitoring.
 */
export class InfraWasteInterceptor {
  public intercept(context: ExecutionContextLike, next: CallHandlerLike) {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const agent = InfraWasteAgent.getInstance();

    const startNs = process.hrtime.bigint();
    const traceId =
      req.headers?.['x-trace-id'] ||
      req.headers?.['x-request-id'] ||
      TraceContextManager.generateTraceId();
    const spanId = TraceContextManager.generateSpanId();

    if (res.setHeader && !res.headersSent) {
      res.setHeader('X-Trace-Id', traceId);
    }

    const traceCtx = {
      traceId,
      spanId,
      service: agent?.getConfig().serviceName || 'nestjs-service',
      route: req.url || req.path || '/',
      timestamp: Date.now()
    };

    return TraceContextManager.runWithContext(traceCtx, () => {
      const handler$ = next.handle();

      if (handler$ && typeof handler$.subscribe === 'function') {
        handler$.subscribe({
          complete: () => {
            if (agent) {
              const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
              const route = req.route?.path || req.path || req.url || '/';
              const statusCode = res.statusCode || 200;
              agent.recordHttp(
                req.method || 'GET',
                route,
                statusCode,
                durationMs,
                0,
                statusCode >= 400
              );
            }
          },
          error: (_err: any) => {
            if (agent) {
              const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
              const route = req.route?.path || req.path || req.url || '/';
              agent.recordHttp(
                req.method || 'GET',
                route,
                500,
                durationMs,
                0,
                true
              );
            }
          }
        });
      }

      return handler$;
    });
  }
}
