import { InfraWasteAgent } from '../agent.js';
import { TraceContextManager } from '../context.js';

export interface FastifyLikeRequest {
  method: string;
  url: string;
  routerPath?: string;
  routeOptions?: { url?: string };
  headers: Record<string, string | string[] | undefined>;
}

export interface FastifyLikeReply {
  statusCode: number;
  header(name: string, value: string): any;
  getHeader(name: string): any;
}

export interface FastifyLikeInstance {
  addHook(
    hookName: 'onRequest',
    fn: (req: FastifyLikeRequest, reply: FastifyLikeReply, done: () => void) => void
  ): void;
  addHook(
    hookName: 'onResponse',
    fn: (req: FastifyLikeRequest, reply: FastifyLikeReply, done: () => void) => void
  ): void;
}

const reqStartTimes = new WeakMap<FastifyLikeRequest, bigint>();

/**
 * Native, zero-blocking Fastify plugin for InfraWaste telemetry.
 */
export function infrawasteFastifyPlugin(
  fastify: FastifyLikeInstance,
  _options: Record<string, any>,
  done: (err?: Error) => void
): void {
  const agent = InfraWasteAgent.getInstance();

  fastify.addHook('onRequest', (req, reply, next) => {
    const startNs = process.hrtime.bigint();
    reqStartTimes.set(req, startNs);

    const traceId =
      (req.headers['x-trace-id'] as string) ||
      (req.headers['x-request-id'] as string) ||
      TraceContextManager.generateTraceId();
    const spanId = TraceContextManager.generateSpanId();

    try {
      reply.header('x-trace-id', traceId);
    } catch {
      // Ignore header write failure if headers already sent
    }

    if (agent) {
      const context = {
        traceId,
        spanId,
        service: agent.getConfig().serviceName,
        route: req.url,
        timestamp: Date.now()
      };
      TraceContextManager.runWithContext(context, () => {
        next();
      });
    } else {
      next();
    }
  });

  fastify.addHook('onResponse', (req, reply, next) => {
    try {
      const startNs = reqStartTimes.get(req);
      if (startNs && agent) {
        const endNs = process.hrtime.bigint();
        const durationMs = Number(endNs - startNs) / 1_000_000;
        const route = req.routeOptions?.url || req.routerPath || req.url || '/';
        const statusCode = reply.statusCode || 200;
        const contentLength = Number(reply.getHeader('content-length')) || 0;
        const hasError = statusCode >= 400;

        agent.recordHttp(
          req.method,
          route,
          statusCode,
          durationMs,
          contentLength,
          hasError
        );
      }
    } catch {
      // Failure independence
    } finally {
      next();
    }
  });

  done();
}
