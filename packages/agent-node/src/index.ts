import { AgentConfig } from './config.js';
import { InfraWasteAgent } from './agent.js';

export function init(config?: AgentConfig): InfraWasteAgent {
  return InfraWasteAgent.init(config);
}

export { InfraWasteAgent };
export { infrawasteExpressMiddleware } from './middleware/express.js';
export { infrawasteFastifyPlugin } from './plugins/fastify.js';
export { InfraWasteInterceptor } from './plugins/nestjs.js';
export { bindPrismaTelemetry } from './plugins/prisma.js';
export { createTypeormLogger } from './plugins/typeorm.js';
export { TraceContextManager } from './context.js';
export * from './config.js';
export * from './aggregator.js';
export * from './sampler.js';
export * from '@infrawaste/core';

