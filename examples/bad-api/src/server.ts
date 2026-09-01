import express from 'express';
import { init, infrawasteExpressMiddleware, InfraWasteAgent } from '@infrawaste/agent-node';
import { PostgresDatabaseAdapter } from '@infrawaste/db-postgres';
import { MongoDatabaseAdapter } from '@infrawaste/db-mongodb';
import { RedisDatabaseAdapter } from '@infrawaste/db-redis';
import { WasteAnalyzerEngine } from '@infrawaste/analyzer';
import { CostEstimator } from '@infrawaste/cost-engine';

export function createSampleApp(enableInfrawaste: boolean = false): express.Express {
  const app = express();
  app.use(express.json());

  const pgAdapter = new PostgresDatabaseAdapter();
  pgAdapter.setServiceName('bad-api');

  const mongoAdapter = new MongoDatabaseAdapter();
  mongoAdapter.setServiceName('bad-api');

  const redisAdapter = new RedisDatabaseAdapter();
  redisAdapter.setServiceName('bad-api');

  const analyzer = new WasteAnalyzerEngine(new CostEstimator('aws'));

  if (enableInfrawaste) {
    const agent = InfraWasteAgent.init({
      serviceName: 'bad-api',
      environment: 'benchmark',
      flushIntervalMs: 5000,
      maxMemoryBytes: 30 * 1024 * 1024
    });
    app.use(infrawasteExpressMiddleware(agent));
  }

  // Normal Fast Route
  app.get('/api/v1/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Anti-Pattern 1: N+1 PostgreSQL Query Cascade
  app.get('/api/v1/orders/:id', async (req, res) => {
    const orderId = req.params.id;

    // 1 Parent Query
    pgAdapter.recordExecution('SELECT * FROM orders WHERE id = $1', 4.5, { rowsReturned: 1 });

    // 84 Child Queries in a loop (simulating unoptimized ORM / loop)
    const itemsCount = 84;
    for (let i = 1; i <= itemsCount; i++) {
      pgAdapter.recordExecution('SELECT * FROM line_items WHERE order_id = $1 AND item_id = $2', 2.1, { rowsReturned: 1 });
    }

    res.json({
      orderId,
      itemsCount,
      warning: 'Anti-pattern simulated: 1 parent query + 84 child queries (N+1 cascade)'
    });
  });

  // Anti-Pattern 2: Repeated Static Query
  app.get('/api/v1/categories/:id', (_req, res) => {
    for (let i = 0; i < 20; i++) {
      pgAdapter.recordExecution('SELECT id, name, parent_id FROM category_tree WHERE tenant_id = 1', 5.0, { rowsReturned: 50 });
    }
    res.json({ categoryId: _req.params.id, warning: 'Anti-pattern simulated: 20 repeated static queries' });
  });

  // Anti-Pattern 3: MongoDB Unindexed COLLSCAN
  app.get('/api/v1/products/search', (_req, res) => {
    mongoAdapter.handleCommandSucceeded('products', {
      commandName: 'find',
      duration: 35.0,
      reply: {
        cursor: { firstBatch: [{ id: 1 }, { id: 2 }], id: 0 },
        docsExamined: 1500000 // 1.5 million docs examined
      }
    }, { status: 'ACTIVE', tags: 'promo' });

    res.json({ count: 2, warning: 'Anti-pattern simulated: MongoDB COLLSCAN examining 1.5M docs' });
  });

  // Anti-Pattern 4: Expensive Redis Command
  app.post('/api/v1/cache/keys', (_req, res) => {
    redisAdapter.recordCommand('KEYS', 'user_sess:*', 48.0, { itemsReturned: 250000 });
    res.json({ warning: 'Anti-pattern simulated: Blocking KEYS * command' });
  });

  // Live Waste Report Endpoint (Runs Analyzer over collected telemetry)
  app.get('/api/v1/waste-report', async (_req, res) => {
    const agent = InfraWasteAgent.getInstance();
    const batch = agent ? agent.flush() : null;

    const dbMetrics = [
      ...(await pgAdapter.collectMetrics()),
      ...(await mongoAdapter.collectMetrics()),
      ...(await redisAdapter.collectMetrics())
    ];

    const findings = analyzer.analyze({
      httpAggregates: batch ? batch.httpAggregates : [],
      databaseTelemetry: dbMetrics
    });

    res.json({
      timestamp: Date.now(),
      totalFindings: findings.length,
      findings
    });
  });

  return app;
}

if (process.argv[1]?.includes('server.ts') || process.argv[1]?.includes('server.js')) {
  const isInstrumented = process.env.ENABLE_INFRAWASTE !== 'false';
  const app = createSampleApp(isInstrumented);
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`🚀 Bad API running on http://localhost:${port} (InfraWaste: ${isInstrumented ? 'ENABLED' : 'DISABLED'})`);
  });
}
