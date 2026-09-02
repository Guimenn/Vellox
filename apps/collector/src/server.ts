import express, { Request, Response } from 'express';
import { BoundedTelemetryBuffer, DatabaseTelemetry, Finding, HttpAggregateTelemetry, TelemetryBatch } from '@vellox/core';
import { WasteAnalyzerEngine } from '@vellox/analyzer';
import { OtelTransformer } from '@vellox/otel-bridge';

const COLLECTOR_VERSION = '0.2.0';

export function createCollectorApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  const buffer = new BoundedTelemetryBuffer({
    maxCapacity: 1000,
    maxMemoryBytes: 50 * 1024 * 1024 // 50MB collector memory buffer
  });

  const analyzer = new WasteAnalyzerEngine();

  let totalBatchesIngested = 0;
  let totalHttpAggregates = 0;
  let totalDbMetrics = 0;

  const currentHttpAggregates: HttpAggregateTelemetry[] = [];
  const currentDbTelemetry: DatabaseTelemetry[] = [];
  let cachedFindings: Finding[] = [];

  // Batch ingestion endpoint
  app.post('/api/v1/telemetry/batches', (req: Request, res: Response): void => {
    const batch = req.body as TelemetryBatch;

    if (!batch || !batch.id || !batch.metadata) {
      res.status(400).json({ error: 'Invalid batch structure: missing id or metadata' });
      return;
    }

    buffer.enqueue(batch);
    totalBatchesIngested++;

    if (batch.httpAggregates) {
      totalHttpAggregates += batch.httpAggregates.length;
      currentHttpAggregates.push(...batch.httpAggregates);
    }

    if (batch.databaseTelemetry) {
      totalDbMetrics += batch.databaseTelemetry.length;
      currentDbTelemetry.push(...batch.databaseTelemetry);
    }

    // Keep active window bounded (last 500 records)
    if (currentHttpAggregates.length > 500) {
      currentHttpAggregates.splice(0, currentHttpAggregates.length - 500);
    }
    if (currentDbTelemetry.length > 500) {
      currentDbTelemetry.splice(0, currentDbTelemetry.length - 500);
    }

    // Recompute findings on new data
    cachedFindings = analyzer.analyze({
      httpAggregates: currentHttpAggregates,
      databaseTelemetry: currentDbTelemetry
    });

    broadcastLiveEvent({
      type: 'BATCH_INGESTED',
      batchId: batch.id,
      service: batch.metadata?.service || 'service',
      httpMetricsCount: batch.httpAggregates?.length || 0,
      dbMetricsCount: batch.databaseTelemetry?.length || 0,
      findingsCount: cachedFindings.length,
      timestamp: Date.now()
    });

    res.status(202).json({
      status: 'accepted',
      batchId: batch.id,
      timestamp: Date.now()
    });
  });

  // OpenTelemetry standard OTLP trace export ingestion endpoint
  app.post('/v1/traces', (req: Request, res: Response): void => {
    try {
      const { httpTelemetries, dbTelemetries } = OtelTransformer.transformOtlpExport(req.body);

      if (dbTelemetries.length > 0) {
        totalDbMetrics += dbTelemetries.length;
        currentDbTelemetry.push(...dbTelemetries);
      }

      for (const http of httpTelemetries) {
        totalHttpAggregates++;
        currentHttpAggregates.push({
          service: http.service,
          method: http.method,
          route: http.route,
          statusCodeDistribution: { [http.statusCode]: 1 },
          totalRequests: 1,
          errorCount: http.error ? 1 : 0,
          totalDurationMs: http.durationMs,
          percentiles: {
            min: http.durationMs,
            max: http.durationMs,
            p50: http.durationMs,
            p90: http.durationMs,
            p95: http.durationMs,
            p99: http.durationMs,
            p999: http.durationMs
          },
          totalResponseBytes: http.responseBytes,
          windowStart: http.timestamp - 1000,
          windowEnd: http.timestamp
        });
      }

      if (currentHttpAggregates.length > 500) {
        currentHttpAggregates.splice(0, currentHttpAggregates.length - 500);
      }
      if (currentDbTelemetry.length > 500) {
        currentDbTelemetry.splice(0, currentDbTelemetry.length - 500);
      }

      cachedFindings = analyzer.analyze({
        httpAggregates: currentHttpAggregates,
        databaseTelemetry: currentDbTelemetry
      });

      res.status(200).json({});
    } catch {
      res.status(400).json({ error: 'Malformed OTLP trace export payload' });
    }
  });

  // Actionable findings endpoint for dashboard or alerts
  app.get('/api/v1/findings', (_req: Request, res: Response) => {
    res.json({
      timestamp: Date.now(),
      count: cachedFindings.length,
      findings: cachedFindings
    });
  });

  // Connected SSE live stream clients
  const sseClients: Response[] = [];

  const broadcastLiveEvent = (eventData: Record<string, any>) => {
    const payload = `data: ${JSON.stringify(eventData)}\n\n`;
    for (let i = sseClients.length - 1; i >= 0; i--) {
      const client = sseClients[i];
      if (client && !client.writableEnded) {
        client.write(payload);
      } else {
        sseClients.splice(i, 1);
      }
    }
  };

  // Real-time SSE live stream endpoint for Dashboard live updates
  app.get('/api/v1/live/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Initial heartbeat
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: Date.now() })}\n\n`);
    sseClients.push(res);

    req.on('close', () => {
      const index = sseClients.indexOf(res);
      if (index !== -1) sseClients.splice(index, 1);
    });
  });

  // Modify batch endpoints to trigger broadcast
  const origPost = app.post.bind(app);
  // Broadcast helper
  (app as any).broadcast = broadcastLiveEvent;

  // Telemetry ingest stats
  app.get('/api/v1/stats', (_req: Request, res: Response) => {
    res.json({
      totalBatchesIngested,
      totalHttpAggregates,
      totalDbMetrics,
      activeSseClients: sseClients.length,
      buffer: buffer.getStats(),
      memoryRssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2))
    });
  });

  // Prometheus standard metrics endpoint
  app.get('/metrics', (_req: Request, res: Response) => {
    const memBytes = process.memoryUsage().rss;

    const metricsText = [
      '# HELP vellox_batches_ingested_total Total count of telemetry batches received',
      '# TYPE vellox_batches_ingested_total counter',
      `vellox_batches_ingested_total ${totalBatchesIngested}`,
      '',
      '# HELP vellox_http_requests_total Total HTTP requests recorded',
      '# TYPE vellox_http_requests_total counter',
      `vellox_http_requests_total ${totalHttpAggregates}`,
      '',
      '# HELP vellox_database_queries_total Total database queries recorded',
      '# TYPE vellox_database_queries_total counter',
      `vellox_database_queries_total ${totalDbMetrics}`,
      '',
      '# HELP vellox_active_findings_count Current active evidence-backed findings',
      '# TYPE vellox_active_findings_count gauge',
      `vellox_active_findings_count ${cachedFindings.length}`,
      '',
      '# HELP vellox_memory_rss_bytes Collector process RSS memory in bytes',
      '# TYPE vellox_memory_rss_bytes gauge',
      `vellox_memory_rss_bytes ${memBytes}`,
      ''
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metricsText);
  });

  // Health check
  app.get('/api/v1/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      version: COLLECTOR_VERSION,
      uptimeSec: Number(process.uptime().toFixed(1))
    });
  });

  return app;
}



if (process.argv[1]?.includes('server.ts') || process.argv[1]?.includes('server.js')) {
  const port = process.env.PORT || 4000;
  const app = createCollectorApp();
  app.listen(port, () => {
    console.log(`📡 Vellox Collector listening on http://localhost:${port}`);
  });
}
