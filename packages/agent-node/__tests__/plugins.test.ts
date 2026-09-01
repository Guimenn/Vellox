import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InfraWasteAgent } from '../src/agent.js';
import { infrawasteFastifyPlugin } from '../src/plugins/fastify.js';
import { InfraWasteInterceptor } from '../src/plugins/nestjs.js';
import { bindPrismaTelemetry } from '../src/plugins/prisma.js';
import { createTypeormLogger } from '../src/plugins/typeorm.js';
import { PostgresDatabaseAdapter } from '../../db-postgres/src/adapter.js';

describe('Framework & ORM Plugins', () => {
  beforeEach(() => {
    InfraWasteAgent.resetInstance();
  });

  afterEach(() => {
    InfraWasteAgent.resetInstance();
  });

  it('Fastify Plugin: should register hooks and record telemetry onResponse', () => {
    const agent = InfraWasteAgent.init({
      serviceName: 'fastify-app',
      environment: 'test',
      flushIntervalMs: 60000
    });

    const hooks: Record<string, Function> = {};
    const mockFastify = {
      addHook: (name: string, fn: Function) => {
        hooks[name] = fn;
      }
    };

    infrawasteFastifyPlugin(mockFastify as any, {}, () => {});

    expect(hooks['onRequest']).toBeDefined();
    expect(hooks['onResponse']).toBeDefined();

    const mockReq = {
      method: 'GET',
      url: '/api/v1/users/42',
      headers: { 'x-trace-id': 'fastify-trace-99' },
      routeOptions: { url: '/api/v1/users/:id' }
    };

    const mockReply = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      header: (name: string, val: string) => {
        mockReply.headers[name] = val;
      },
      getHeader: (name: string) => mockReply.headers[name]
    };

    hooks['onRequest']!(mockReq, mockReply, () => {});
    expect(mockReply.headers['x-trace-id']).toBe('fastify-trace-99');

    hooks['onResponse']!(mockReq, mockReply, () => {});

    const batch = agent.flush();
    expect(batch?.httpAggregates.length).toBe(1);
    expect(batch?.httpAggregates[0]!.route).toBe('/api/v1/users/:id');
    expect(batch?.httpAggregates[0]!.totalRequests).toBe(1);
  });

  it('NestJS Interceptor: should intercept execution and record HTTP telemetry', () => {
    const agent = InfraWasteAgent.init({
      serviceName: 'nestjs-app',
      environment: 'test',
      flushIntervalMs: 60000
    });

    const interceptor = new InfraWasteInterceptor();
    const mockReq = {
      method: 'POST',
      url: '/api/v1/payments',
      headers: { 'x-trace-id': 'nest-trace-123' },
      route: { path: '/api/v1/payments' }
    };
    const mockRes = {
      statusCode: 201,
      headersSent: false,
      setHeader: (_name: string, _val: string) => {}
    };

    const mockCtx = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => mockReq,
        getResponse: () => mockRes
      })
    };

    let completeObserver: any;
    const mockHandler = {
      handle: () => ({
        pipe: (op: any) => op,
        subscribe: (obs: any) => {
          completeObserver = obs;
        }
      })
    };

    interceptor.intercept(mockCtx as any, mockHandler as any);
    completeObserver.complete();

    const batch = agent.flush();
    expect(batch?.httpAggregates.length).toBe(1);
    expect(batch?.httpAggregates[0]!.method).toBe('POST');
    expect(batch?.httpAggregates[0]!.statusCodeDistribution[201]).toBe(1);
  });

  it('Prisma Telemetry Hook: should capture queries and duration', async () => {
    const adapter = new PostgresDatabaseAdapter();
    adapter.setServiceName('prisma-service');

    let queryListener: any;
    const mockPrisma = {
      $on: (_event: string, cb: any) => {
        queryListener = cb;
      }
    };

    bindPrismaTelemetry(mockPrisma as any, adapter);
    expect(queryListener).toBeDefined();

    queryListener({
      timestamp: new Date(),
      query: 'SELECT id, email FROM "User" WHERE id = $1',
      params: '[1]',
      duration: 4.2,
      target: 'User'
    });

    const metrics = await adapter.collectMetrics();
    expect(metrics.length).toBe(1);
    expect(metrics[0]!.executionCount).toBe(1);
    expect(metrics[0]!.totalDurationMs).toBe(4.2);
  });

  it('TypeORM Custom Logger: should intercept SQL and duration', async () => {
    const adapter = new PostgresDatabaseAdapter();
    adapter.setServiceName('typeorm-service');

    const logger = createTypeormLogger(adapter);
    logger.logQuerySlow(12.5, 'SELECT * FROM order_items WHERE order_id = 999');

    const metrics = await adapter.collectMetrics();
    expect(metrics.length).toBe(1);
    expect(metrics[0]!.totalDurationMs).toBe(12.5);
  });
});
