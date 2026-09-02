import { AgentConfig } from './config.js';
import { VelloxAgent } from './agent.js';

export function init(config?: AgentConfig): VelloxAgent {
  return VelloxAgent.init(config);
}

/** @deprecated Use VelloxAgent. */
export { VelloxAgent, VelloxAgent as InfraWasteAgent };
export { velloxExpressMiddleware, velloxExpressMiddleware as infrawasteExpressMiddleware } from './middleware/express.js';
export { velloxFastifyPlugin, velloxFastifyPlugin as infrawasteFastifyPlugin } from './plugins/fastify.js';
export { VelloxInterceptor, VelloxInterceptor as InfraWasteInterceptor } from './plugins/nestjs.js';
export { bindPrismaTelemetry } from './plugins/prisma.js';
export { createTypeormLogger } from './plugins/typeorm.js';
export { TraceContextManager } from './context.js';
export * from './config.js';
export * from './aggregator.js';
export * from './sampler.js';
export * from '@vellox/core';
