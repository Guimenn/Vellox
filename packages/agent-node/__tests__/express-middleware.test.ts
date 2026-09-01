import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { InfraWasteAgent } from '../src/agent.js';
import { infrawasteExpressMiddleware } from '../src/middleware/express.js';

describe('infrawasteExpressMiddleware', () => {
  let app: express.Express;
  let agent: InfraWasteAgent;

  beforeEach(() => {
    InfraWasteAgent.resetInstance();
    agent = InfraWasteAgent.init({
      serviceName: 'express-test-app',
      environment: 'test',
      flushIntervalMs: 60000
    });

    app = express();
    app.use(infrawasteExpressMiddleware(agent));

    app.get('/api/users/:id', (req, res) => {
      res.status(200).json({ id: req.params.id, name: 'Alice' });
    });

    app.post('/api/checkout', (req, res) => {
      res.status(400).json({ error: 'Invalid payload' });
    });
  });

  afterEach(() => {
    InfraWasteAgent.resetInstance();
  });

  it('should intercept Express requests and record accurate aggregated metrics', async () => {
    await request(app).get('/api/users/99').expect(200);
    await request(app).get('/api/users/100').expect(200);
    await request(app).post('/api/checkout').expect(400);

    const batch = agent.flush();
    expect(batch).not.toBeNull();
    expect(batch?.httpAggregates.length).toBe(2);

    const userRoute = batch?.httpAggregates.find(a => a.route === '/api/users/:id');
    expect(userRoute).toBeDefined();
    expect(userRoute?.totalRequests).toBe(2);
    expect(userRoute?.errorCount).toBe(0);
    expect(userRoute?.statusCodeDistribution[200]).toBe(2);

    const checkoutRoute = batch?.httpAggregates.find(a => a.route === '/api/checkout');
    expect(checkoutRoute).toBeDefined();
    expect(checkoutRoute?.totalRequests).toBe(1);
    expect(checkoutRoute?.errorCount).toBe(1);
    expect(checkoutRoute?.statusCodeDistribution[400]).toBe(1);
  });
});
