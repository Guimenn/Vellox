import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { BoundedTelemetryBuffer, BufferStats, TelemetryBatch } from '@vellox/core';
import { AgentConfig, ResolvedAgentConfig, resolveConfig } from './config.js';
import { LocalAggregator } from './aggregator.js';
import { AdaptiveSampler } from './sampler.js';

const AGENT_VERSION = '0.10.0';

export class VelloxAgent {
  private static instance: VelloxAgent | null = null;

  private config: ResolvedAgentConfig;
  private buffer: BoundedTelemetryBuffer;
  private aggregator: LocalAggregator;
  private sampler: AdaptiveSampler;
  private flushTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private hostname: string;

  private constructor(config: AgentConfig = {}) {
    this.config = resolveConfig(config);
    this.hostname = os.hostname();
    this.buffer = new BoundedTelemetryBuffer({
      maxCapacity: this.config.maxBatchSize,
      maxMemoryBytes: this.config.maxMemoryBytes
    });
    this.aggregator = new LocalAggregator(this.config.cardinality);
    this.sampler = new AdaptiveSampler(this.config.sampling);

    if (this.config.enabled) {
      this.start();
    }
  }

  public static init(config?: AgentConfig): VelloxAgent {
    if (!VelloxAgent.instance) {
      VelloxAgent.instance = new VelloxAgent(config);
    }
    return VelloxAgent.instance;
  }

  public static getInstance(): VelloxAgent | null {
    return VelloxAgent.instance;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flushIntervalMs);

    // Unref so the agent flush loop does not prevent clean process exit
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.flush();
  }

  /**
   * Main non-blocking ingestion entry point for HTTP requests.
   * Total latency impact < 0.05ms.
   */
  public recordHttp(
    method: string,
    rawPath: string,
    statusCode: number,
    durationMs: number,
    responseBytes: number = 0,
    hasError: boolean = false
  ): void {
    if (!this.config.enabled) return;

    this.aggregator.record(method, rawPath, statusCode, durationMs, responseBytes, hasError);
  }

  /**
   * Periodic or on-demand batch flush
   */
  public flush(): TelemetryBatch | null {
    const aggregates = this.aggregator.flush(this.config.serviceName);
    if (aggregates.length === 0) {
      return null;
    }

    const bufferStats = this.buffer.getStats();

    const batch: TelemetryBatch = {
      id: crypto.randomUUID(),
      metadata: {
        service: this.config.serviceName,
        environment: this.config.environment,
        agentVersion: AGENT_VERSION,
        hostname: this.hostname,
        droppedBatches: bufferStats.droppedBatches,
        droppedEvents: bufferStats.droppedEvents,
        bufferUsagePercent: bufferStats.usagePercent,
        timestamp: Date.now()
      },
      httpAggregates: aggregates
    };

    this.buffer.enqueue(batch);

    // If collector endpoint configured, dispatch asynchronously without blocking
    if (this.config.collectorEndpoint) {
      this.dispatchBatch(batch).catch(() => {
        // Telemetry dispatch failure MUST NEVER crash or block the application
      });
    }

    return batch;
  }

  private async dispatchBatch(batch: TelemetryBatch): Promise<void> {
    if (!this.config.collectorEndpoint) return;

    try {
      const response = await fetch(this.config.collectorEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Vellox-Agent-Version': AGENT_VERSION
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(3000) // 3-second hard timeout
      });

      if (!response.ok) {
        // Silent drop / failure handling
      }
    } catch {
      // Network failure or collector down: silently caught to protect app execution
    }
  }

  public getSampler(): AdaptiveSampler {
    return this.sampler;
  }

  public getBufferStats(): BufferStats {
    return this.buffer.getStats();
  }

  public getConfig(): ResolvedAgentConfig {
    return this.config;
  }

  public static resetInstance(): void {
    if (VelloxAgent.instance) {
      VelloxAgent.instance.stop();
      VelloxAgent.instance = null;
    }
  }
}
