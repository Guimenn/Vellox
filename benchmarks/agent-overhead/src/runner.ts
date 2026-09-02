import http from 'node:http';
import autocannon from 'autocannon';
import express from 'express';
import { VelloxAgent, velloxExpressMiddleware } from '@vellox/agent-node';

interface BenchmarkResult {
  title: string;
  requestsTotal: number;
  durationSec: number;
  requestsPerSec: number;
  latencyMedianMs: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  latencyMaxMs: number;
  rssMb: number;
  heapUsedMb: number;
}

function createExpressApp(enableAgent: boolean): express.Express {
  const app = express();

  if (enableAgent) {
    const agent = VelloxAgent.init({
      serviceName: 'benchmark-api',
      environment: 'benchmark',
      flushIntervalMs: 5000,
      maxMemoryBytes: 30 * 1024 * 1024
    });
    app.use(velloxExpressMiddleware(agent));
  }

  // Realistic endpoint mix
  app.get('/api/v1/ping', (_req, res) => {
    res.json({ status: 'ok', time: Date.now() });
  });

  app.get('/api/v1/users/:id', (req, res) => {
    res.json({ id: req.params.id, name: `User_${req.params.id}`, active: true });
  });

  app.get('/api/v1/orders/:id/items', (req, res) => {
    res.json({
      orderId: req.params.id,
      items: [
        { id: 1, title: 'Item 1', price: 19.99 },
        { id: 2, title: 'Item 2', price: 49.50 }
      ]
    });
  });

  return app;
}

function runAutocannon(url: string, duration: number, connections: number, pipelining: number): Promise<autocannon.Result> {
  return new Promise((resolve, reject) => {
    autocannon(
      {
        url,
        duration,
        connections,
        pipelining,
        requests: [
          { method: 'GET', path: '/api/v1/ping' },
          { method: 'GET', path: '/api/v1/users/42' },
          { method: 'GET', path: '/api/v1/orders/9981/items' }
        ]
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
}

async function benchmarkServer(title: string, enableAgent: boolean, port: number): Promise<BenchmarkResult> {
  if (enableAgent) {
    VelloxAgent.resetInstance();
  }

  const app = createExpressApp(enableAgent);
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(port, resolve));

  const url = `http://127.0.0.1:${port}`;

  console.log(`\n⏳ [${title}] Warming up JIT & cache (2s)...`);
  await runAutocannon(url, 2, 20, 1);

  if (global.gc) {
    global.gc();
  }

  const memBefore = process.memoryUsage();

  console.log(`🚀 [${title}] Running benchmark load test (5s, 50 concurrent connections)...`);
  const result = await runAutocannon(url, 5, 50, 1);

  const memAfter = process.memoryUsage();

  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (enableAgent) {
    VelloxAgent.resetInstance();
  }

  const latencyMedian = result.latency.p50 || result.latency.average || 0;
  const latencyP95 = result.latency.p95 || 0;
  const latencyP99 = result.latency.p99 || 0;
  const latencyMax = result.latency.max || 0;

  return {
    title,
    requestsTotal: result.requests.total,
    durationSec: result.duration,
    requestsPerSec: Number(result.requests.average.toFixed(1)),
    latencyMedianMs: Number(latencyMedian.toFixed(3)),
    latencyP95Ms: Number(latencyP95.toFixed(3)),
    latencyP99Ms: Number(latencyP99.toFixed(3)),
    latencyMaxMs: Number(latencyMax.toFixed(3)),
    rssMb: Number((memAfter.rss / (1024 * 1024)).toFixed(2)),
    heapUsedMb: Number((memAfter.heapUsed / (1024 * 1024)).toFixed(2))
  };
}

async function main() {
  console.log('========================================================================');
  console.log('  VELLOX - LOCAL AGENT OVERHEAD BENCHMARK');
  console.log('========================================================================');
  console.log('Objective: Compare baseline and instrumented Express runs on this machine.');
  console.log('Thresholds: P50 delta <= 1.0ms | P95 delta < 2.0ms | RSS delta < 50MB');
  console.log('Results are environment-specific; rerun before making a performance claim.');

  // 1. Baseline Run
  const baseline = await benchmarkServer('WITHOUT VELLOX (Baseline)', false, 4101);

  // Cool down
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // 2. Instrumented Run
  const instrumented = await benchmarkServer('WITH VELLOX (Instrumented)', true, 4102);

  // Calculate Deltas
  const deltaLatencyP50 = Number((instrumented.latencyMedianMs - baseline.latencyMedianMs).toFixed(3));
  const deltaLatencyP95 = Number((instrumented.latencyP95Ms - baseline.latencyP95Ms).toFixed(3));
  const deltaLatencyP99 = Number((instrumented.latencyP99Ms - baseline.latencyP99Ms).toFixed(3));
  const deltaRssMb = Number((instrumented.rssMb - baseline.rssMb).toFixed(2));
  const throughputRatio = Number(((instrumented.requestsPerSec / baseline.requestsPerSec) * 100).toFixed(1));

  console.log('\n========================================================================');
  console.log('                     EMPIRICAL BENCHMARK RESULTS                        ');
  console.log('========================================================================\n');

  console.table([
    {
      Metric: 'Total Requests',
      'WITHOUT Vellox': baseline.requestsTotal.toLocaleString(),
      'WITH Vellox': instrumented.requestsTotal.toLocaleString(),
      Delta: `${instrumented.requestsTotal - baseline.requestsTotal} reqs`
    },
    {
      Metric: 'Throughput (req/sec)',
      'WITHOUT Vellox': `${baseline.requestsPerSec.toLocaleString()} req/s`,
      'WITH Vellox': `${instrumented.requestsPerSec.toLocaleString()} req/s`,
      Delta: `${throughputRatio}% of baseline`
    },
    {
      Metric: 'P50 Latency (Median)',
      'WITHOUT Vellox': `${baseline.latencyMedianMs} ms`,
      'WITH Vellox': `${instrumented.latencyMedianMs} ms`,
      Delta: `${deltaLatencyP50 >= 0 ? '+' : ''}${deltaLatencyP50} ms`
    },
    {
      Metric: 'P95 Latency',
      'WITHOUT Vellox': `${baseline.latencyP95Ms} ms`,
      'WITH Vellox': `${instrumented.latencyP95Ms} ms`,
      Delta: `${deltaLatencyP95 >= 0 ? '+' : ''}${deltaLatencyP95} ms`
    },
    {
      Metric: 'P99 Latency',
      'WITHOUT Vellox': `${baseline.latencyP99Ms} ms`,
      'WITH Vellox': `${instrumented.latencyP99Ms} ms`,
      Delta: `${deltaLatencyP99 >= 0 ? '+' : ''}${deltaLatencyP99} ms`
    },
    {
      Metric: 'Max Latency',
      'WITHOUT Vellox': `${baseline.latencyMaxMs} ms`,
      'WITH Vellox': `${instrumented.latencyMaxMs} ms`,
      Delta: `${(instrumented.latencyMaxMs - baseline.latencyMaxMs).toFixed(2)} ms`
    },
    {
      Metric: 'Process RSS Memory',
      'WITHOUT Vellox': `${baseline.rssMb} MB`,
      'WITH Vellox': `${instrumented.rssMb} MB`,
      Delta: `${deltaRssMb >= 0 ? '+' : ''}${deltaRssMb} MB`
    }
  ]);

  console.log('\n------------------------------------------------------------------------');
  console.log('                    OVERHEAD SLA VERIFICATION CHECK                     ');
  console.log('------------------------------------------------------------------------');

  const p50Pass = deltaLatencyP50 <= 1.0;
  const p95Pass = deltaLatencyP95 <= 2.0;
  const memPass = deltaRssMb < 50.0;

  console.log(`  Median Latency Overhead (<= 1.0 ms):  ${p50Pass ? '✅ PASS' : '❌ FAIL'} (${deltaLatencyP50} ms)`);
  console.log(`  P95 Latency Overhead    (< 2.0 ms):  ${p95Pass ? '✅ PASS' : '❌ FAIL'} (${deltaLatencyP95} ms)`);
  console.log(`  Memory Footprint Delta  (< 50 MB):   ${memPass ? '✅ PASS' : '❌ FAIL'} (${deltaRssMb} MB)`);
  console.log('------------------------------------------------------------------------\n');

  if (p50Pass && p95Pass && memPass) {
    console.log('✅ VERDICT: This local run met the configured thresholds.');
  } else {
    console.warn('⚠️  VERDICT: This local run exceeded one or more configured thresholds.');
  }
}

main().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
