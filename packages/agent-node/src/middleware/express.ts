import type { Request, Response, NextFunction } from 'express';
import { VelloxAgent } from '../agent.js';
import { TraceContextManager } from '../context.js';

/**
 * High-performance Express middleware for Vellox.
 * Hook executes with zero blocking in < 50 microseconds.
 */
export function velloxExpressMiddleware(agentInstance?: VelloxAgent) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const agent = agentInstance || VelloxAgent.getInstance();
    if (!agent) {
      return next();
    }

    const startNs = process.hrtime.bigint();
    const traceId = (req.headers['x-trace-id'] as string) || (req.headers['x-request-id'] as string) || TraceContextManager.generateTraceId();
    const spanId = TraceContextManager.generateSpanId();

    res.setHeader('X-Trace-Id', traceId);

    const context = {
      traceId,
      spanId,
      service: agent.getConfig().serviceName,
      route: req.path,
      timestamp: Date.now()
    };

    // Hook finish event
    res.once('finish', () => {
      try {
        const endNs = process.hrtime.bigint();
        const durationMs = Number(endNs - startNs) / 1_000_000;

        // Prefer parameterized route if Express router matched it, fallback to path
        const rawRoute = (req.baseUrl || '') + (req.route?.path || req.path || '/');
        const statusCode = res.statusCode || 200;
        const contentLength = Number(res.getHeader('content-length')) || 0;
        const hasError = statusCode >= 400;

        agent.recordHttp(
          req.method,
          rawRoute,
          statusCode,
          durationMs,
          contentLength,
          hasError
        );
      } catch {
        // Observability must NEVER crash or interrupt the application
      }
    });

    TraceContextManager.runWithContext(context, () => {
      next();
    });
  };
}
