import { SamplingConfig } from './config.js';

export class AdaptiveSampler {
  private config: SamplingConfig;

  constructor(config: SamplingConfig) {
    this.config = config;
  }

  public updateConfig(config: SamplingConfig): void {
    this.config = config;
  }

  /**
   * Evaluates if a request sample should be kept for detailed event tracing.
   * Note: Aggregated histograms and route counters ALWAYS process 100% of requests.
   */
  public shouldSample(durationMs: number, statusCode: number, hasError: boolean): boolean {
    const isError = hasError || statusCode >= 400;
    const isSlow = durationMs >= this.config.slowThresholdMs;

    if (isError) {
      return this.config.errorRate >= 1.0 || Math.random() < this.config.errorRate;
    }

    if (isSlow) {
      return this.config.slowRate >= 1.0 || Math.random() < this.config.slowRate;
    }

    return this.config.normalRate > 0 && Math.random() < this.config.normalRate;
  }
}
