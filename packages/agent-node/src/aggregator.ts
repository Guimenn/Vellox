import { HttpAggregateTelemetry, LogHistogram, RouteNormalizer } from '@infrawaste/core';
import { CardinalityConfig } from './config.js';

interface RouteAggregateState {
  method: string;
  route: string;
  statusCodeDistribution: Record<number, number>;
  totalRequests: number;
  errorCount: number;
  totalDurationMs: number;
  histogram: LogHistogram;
  totalResponseBytes: number;
}

export class LocalAggregator {
  private routeStates: Map<string, RouteAggregateState>;
  private normalizer: RouteNormalizer;
  private windowStartTime: number;

  constructor(cardinalityConfig: CardinalityConfig) {
    this.routeStates = new Map();
    this.normalizer = new RouteNormalizer({
      maxUniqueRoutes: cardinalityConfig.maxUniqueRoutes,
      overflowRouteName: cardinalityConfig.overflowRouteName
    });
    this.windowStartTime = Date.now();
  }

  /**
   * Ultra-fast local recording of HTTP metric.
   * Execution time < 5 microseconds, negligible allocations.
   */
  public record(
    method: string,
    rawPath: string,
    statusCode: number,
    durationMs: number,
    responseBytes: number,
    hasError: boolean
  ): void {
    const normalizedRoute = this.normalizer.normalize(rawPath);
    const key = `${method} ${normalizedRoute}`;

    let state = this.routeStates.get(key);
    if (!state) {
      state = {
        method,
        route: normalizedRoute,
        statusCodeDistribution: {},
        totalRequests: 0,
        errorCount: 0,
        totalDurationMs: 0,
        histogram: new LogHistogram(),
        totalResponseBytes: 0
      };
      this.routeStates.set(key, state);
    }

    state.totalRequests++;
    state.totalDurationMs += durationMs;
    state.totalResponseBytes += responseBytes;
    state.histogram.record(durationMs);

    state.statusCodeDistribution[statusCode] = (state.statusCodeDistribution[statusCode] || 0) + 1;

    if (hasError || statusCode >= 400) {
      state.errorCount++;
    }
  }

  /**
   * Flushes current window aggregates and resets the accumulator.
   */
  public flush(serviceName: string): HttpAggregateTelemetry[] {
    const now = Date.now();
    const windowStart = this.windowStartTime;
    this.windowStartTime = now;

    if (this.routeStates.size === 0) {
      return [];
    }

    const aggregates: HttpAggregateTelemetry[] = [];

    for (const state of this.routeStates.values()) {
      aggregates.push({
        service: serviceName,
        method: state.method,
        route: state.route,
        statusCodeDistribution: { ...state.statusCodeDistribution },
        totalRequests: state.totalRequests,
        errorCount: state.errorCount,
        totalDurationMs: Number(state.totalDurationMs.toFixed(3)),
        percentiles: state.histogram.getPercentiles(),
        totalResponseBytes: state.totalResponseBytes,
        windowStart,
        windowEnd: now
      });
    }

    this.routeStates.clear();
    return aggregates;
  }

  public getTrackedRoutesCount(): number {
    return this.routeStates.size;
  }
}
