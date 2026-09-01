import { TelemetryBatch } from '../types/telemetry.js';

export interface RingBufferOptions {
  maxCapacity?: number;       // Maximum number of batches
  maxMemoryBytes?: number;    // Maximum approximate memory limit in bytes (e.g. 30MB)
  highWatermarkRatio?: number;// High watermark threshold (0.0 to 1.0, default 0.8)
}

export interface BufferStats {
  size: number;
  capacity: number;
  approximateMemoryBytes: number;
  maxMemoryBytes: number;
  droppedBatches: number;
  droppedEvents: number;
  usagePercent: number;
}

/**
 * Bounded Memory Ring Buffer with High-Watermark Load Shedding
 */
export class BoundedTelemetryBuffer {
  private readonly capacity: number;
  private readonly maxMemoryBytes: number;
  private readonly highWatermarkRatio: number;

  private buffer: Array<TelemetryBatch | null>;
  private head: number = 0; // write index
  private tail: number = 0; // read index
  private count: number = 0;

  private approximateMemoryBytes: number = 0;
  private droppedBatches: number = 0;
  private droppedEvents: number = 0;

  constructor(options: RingBufferOptions = {}) {
    this.capacity = options.maxCapacity ?? 100;
    this.maxMemoryBytes = options.maxMemoryBytes ?? 30 * 1024 * 1024; // 30 MB default
    this.highWatermarkRatio = options.highWatermarkRatio ?? 0.8;
    this.buffer = new Array(this.capacity).fill(null);
  }

  /**
   * Approximate payload size in bytes for memory protection
   */
  private estimateBatchBytes(batch: TelemetryBatch): number {
    const aggregatesCount = batch.httpAggregates.length;
    const sampledCount = batch.sampledHttpEvents?.length ?? 0;
    const dbCount = batch.databaseTelemetry?.length ?? 0;

    // Approximate size: ~1.5 KB per HTTP aggregate (with histogram), ~200B per event, ~500B per DB metric
    return 1024 + (aggregatesCount * 1500) + (sampledCount * 200) + (dbCount * 500);
  }

  /**
   * Enqueue a telemetry batch.
   * If memory limit or capacity is breached, drops the oldest batch (load shedding).
   */
  public enqueue(batch: TelemetryBatch): boolean {
    const batchBytes = this.estimateBatchBytes(batch);

    // Check memory limit and capacity
    const isOverCapacity = this.count >= this.capacity;
    const isOverMemory = (this.approximateMemoryBytes + batchBytes) > this.maxMemoryBytes;

    if (isOverCapacity || isOverMemory) {
      this.dropOldest();
    }

    this.buffer[this.head] = batch;
    this.head = (this.head + 1) % this.capacity;
    this.count++;
    this.approximateMemoryBytes += batchBytes;

    return true;
  }

  /**
   * Dequeue the next available batch in FIFO order.
   */
  public dequeue(): TelemetryBatch | null {
    if (this.count === 0) return null;

    const batch = this.buffer[this.tail];
    this.buffer[this.tail] = null;
    this.tail = (this.tail + 1) % this.capacity;
    this.count--;

    if (batch) {
      this.approximateMemoryBytes = Math.max(0, this.approximateMemoryBytes - this.estimateBatchBytes(batch));
    }

    return batch;
  }

  /**
   * Drops the oldest batch from the buffer to relieve pressure.
   */
  private dropOldest(): void {
    if (this.count === 0) return;

    const oldest = this.buffer[this.tail];
    this.buffer[this.tail] = null;
    this.tail = (this.tail + 1) % this.capacity;
    this.count--;

    if (oldest) {
      const droppedBytes = this.estimateBatchBytes(oldest);
      this.approximateMemoryBytes = Math.max(0, this.approximateMemoryBytes - droppedBytes);
      this.droppedBatches++;

      let eventsInBatch = 0;
      for (const agg of oldest.httpAggregates) {
        eventsInBatch += agg.totalRequests;
      }
      eventsInBatch += (oldest.sampledHttpEvents?.length ?? 0);
      eventsInBatch += (oldest.databaseTelemetry?.length ?? 0);
      this.droppedEvents += eventsInBatch;
    }
  }

  public getStats(): BufferStats {
    const usagePercent = this.maxMemoryBytes > 0
      ? Number(((this.approximateMemoryBytes / this.maxMemoryBytes) * 100).toFixed(2))
      : 0;

    return {
      size: this.count,
      capacity: this.capacity,
      approximateMemoryBytes: this.approximateMemoryBytes,
      maxMemoryBytes: this.maxMemoryBytes,
      droppedBatches: this.droppedBatches,
      droppedEvents: this.droppedEvents,
      usagePercent
    };
  }

  public isHighWatermark(): boolean {
    return (this.approximateMemoryBytes / this.maxMemoryBytes) >= this.highWatermarkRatio;
  }

  public clear(): void {
    this.buffer.fill(null);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.approximateMemoryBytes = 0;
  }
}
