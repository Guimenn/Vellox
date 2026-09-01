import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createSampleApp } from '../src/server.js';
import express from 'express';

describe('Bad API Waste Scenarios & Intelligence', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createSampleApp(true);
  });

  it('should simulate anti-patterns and generate actionable waste findings with recommendations', async () => {
    // 1. Simulate N+1 order requests
    for (let i = 1; i <= 15; i++) {
      await request(app).get(`/api/v1/orders/${i}`).expect(200);
    }

    // 2. Simulate repeated category queries
    for (let i = 1; i <= 30; i++) {
      await request(app).get(`/api/v1/categories/${i}`).expect(200);
    }

    // 3. Simulate MongoDB COLLSCAN
    for (let i = 1; i <= 10; i++) {
      await request(app).get('/api/v1/products/search').expect(200);
    }

    // 4. Simulate Redis KEYS *
    await request(app).post('/api/v1/cache/keys').expect(200);

    // 5. Query the Waste Report
    const res = await request(app).get('/api/v1/waste-report').expect(200);

    expect(res.body.totalFindings).toBeGreaterThanOrEqual(3);

    const findings = res.body.findings;

    // Check N+1 Finding
    const nplus1 = findings.find((f: any) => f.type === 'POSSIBLE_N_PLUS_ONE');
    expect(nplus1).toBeDefined();
    expect(nplus1.confidence).toBeGreaterThanOrEqual(90);
    expect(nplus1.recommendation.action).toContain('eager loading');

    // Check Repeated Query Finding
    const rep = findings.find((f: any) => f.type === 'REPEATED_QUERY');
    expect(rep).toBeDefined();
    expect(rep.confidence).toBeGreaterThanOrEqual(90);

    // Check COLLSCAN Finding
    const collscan = findings.find((f: any) => f.type === 'COLL_SCAN');
    expect(collscan).toBeDefined();

    // Check Redis Finding
    const redisFinding = findings.find((f: any) => f.type === 'EXPENSIVE_REDIS_COMMAND');
    expect(redisFinding).toBeDefined();
  });
});
