import { LatencyPercentiles } from '../types/telemetry.js';

/**
 * Logarithmic Streaming Histogram
 * 
 * Provides O(1) duration recording with zero dynamic allocations in the critical path.
 * Retains exact count and sum while mapping values into 256 logarithmic exponential buckets
 * with < 4.5% relative error across 0.1ms to 65,536ms.
 * Total memory footprint: ~1 KB per histogram.
 */
export class LogHistogram {
  private static readonly NUM_BUCKETS = 256;
  private static readonly MIN_VALUE = 0.1;       // 100 microseconds (0.1 ms)
  private static readonly LOG2_MIN = Math.log2(0.1);
  private static readonly LOG_FACTOR = 256 / 16; // 16 octaves mapped to 256 buckets (16 buckets per octave)

  private buckets: Uint32Array;
  private count: number = 0;
  private sum: number = 0;
  private minVal: number = Number.POSITIVE_INFINITY;
  private maxVal: number = 0;

  constructor() {
    this.buckets = new Uint32Array(LogHistogram.NUM_BUCKETS);
  }

  /**
   * Record a latency measurement in milliseconds.
   * O(1) execution time, zero allocations.
   */
  public record(valMs: number): void {
    if (valMs < 0 || Number.isNaN(valMs)) return;

    this.count++;
    this.sum += valMs;

    if (valMs < this.minVal) this.minVal = valMs;
    if (valMs > this.maxVal) this.maxVal = valMs;

    let bucketIdx: number;
    if (valMs <= LogHistogram.MIN_VALUE) {
      bucketIdx = 0;
    } else {
      // Calculate octave offset
      const logVal = Math.log2(valMs);
      const rawIdx = Math.floor((logVal - LogHistogram.LOG2_MIN) * LogHistogram.LOG_FACTOR);
      bucketIdx = rawIdx < 0 ? 0 : rawIdx >= LogHistogram.NUM_BUCKETS ? LogHistogram.NUM_BUCKETS - 1 : rawIdx;
    }

    this.buckets[bucketIdx]++;
  }

  /**
   * Calculate value for a given bucket index (lower boundary)
   */
  public static bucketToValue(index: number): number {
    if (index <= 0) return 0;
    return Math.pow(2, LogHistogram.LOG2_MIN + index / LogHistogram.LOG_FACTOR);
  }

  /**
   * Compute standard latency percentiles (min, max, p50, p90, p95, p99, p999)
   */
  public getPercentiles(): LatencyPercentiles {
    if (this.count === 0) {
      return { min: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0, p999: 0 };
    }

    return {
      min: Number.isFinite(this.minVal) ? Number(this.minVal.toFixed(3)) : 0,
      max: Number(this.maxVal.toFixed(3)),
      p50: Number(this.getValueAtPercentile(50).toFixed(3)),
      p90: Number(this.getValueAtPercentile(90).toFixed(3)),
      p95: Number(this.getValueAtPercentile(95).toFixed(3)),
      p99: Number(this.getValueAtPercentile(99).toFixed(3)),
      p999: Number(this.getValueAtPercentile(99.9).toFixed(3)),
    };
  }

  /**
   * Get estimated value at a target percentile (0 - 100)
   */
  public getValueAtPercentile(percentile: number): number {
    if (this.count === 0) return 0;
    if (percentile <= 0) return this.minVal;
    if (percentile >= 100) return this.maxVal;

    const targetCount = (percentile / 100) * this.count;
    let accumulated = 0;

    for (let i = 0; i < LogHistogram.NUM_BUCKETS; i++) {
      const bucketCount = this.buckets[i]!;
      accumulated += bucketCount;

      if (accumulated >= targetCount) {
        // Linear interpolation within bucket boundaries
        const bucketLower = LogHistogram.bucketToValue(i);
        const bucketUpper = LogHistogram.bucketToValue(i + 1);

        if (bucketCount === 0) return bucketLower;

        const countInBucket = accumulated - targetCount;
        const fraction = 1 - (countInBucket / bucketCount);
        const interpolated = bucketLower + fraction * (bucketUpper - bucketLower);

        // Clamp to observed min/max
        return Math.min(Math.max(interpolated, this.minVal), this.maxVal);
      }
    }

    return this.maxVal;
  }

  public getCount(): number {
    return this.count;
  }

  public getSum(): number {
    return this.sum;
  }

  public getMean(): number {
    return this.count === 0 ? 0 : this.sum / this.count;
  }

  public getBuckets(): number[] {
    return Array.from(this.buckets);
  }

  public merge(other: LogHistogram): void {
    if (other.count === 0) return;

    this.count += other.count;
    this.sum += other.sum;
    if (other.minVal < this.minVal) this.minVal = other.minVal;
    if (other.maxVal > this.maxVal) this.maxVal = other.maxVal;

    for (let i = 0; i < LogHistogram.NUM_BUCKETS; i++) {
      this.buckets[i]! += other.buckets[i]!;
    }
  }

  public reset(): void {
    this.buckets.fill(0);
    this.count = 0;
    this.sum = 0;
    this.minVal = Number.POSITIVE_INFINITY;
    this.maxVal = 0;
  }
}
