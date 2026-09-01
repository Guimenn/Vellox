import { describe, it, expect, beforeEach } from 'vitest';
import { LogHistogram } from '../src/histogram/histogram.js';

describe('LogHistogram', () => {
  let hist: LogHistogram;

  beforeEach(() => {
    hist = new LogHistogram();
  });

  it('should handle zero recordings correctly', () => {
    const percentiles = hist.getPercentiles();
    expect(percentiles.p50).toBe(0);
    expect(percentiles.p95).toBe(0);
    expect(percentiles.p99).toBe(0);
    expect(hist.getCount()).toBe(0);
    expect(hist.getSum()).toBe(0);
  });

  it('should accurately compute median and percentiles for synthetic distributions', () => {
    // Record 1000 items with linear distribution from 1ms to 1000ms
    for (let i = 1; i <= 1000; i++) {
      hist.record(i);
    }

    expect(hist.getCount()).toBe(1000);
    expect(hist.getSum()).toBe(500500);

    const percentiles = hist.getPercentiles();
    // p50 should be ~500ms with < 5% relative error
    expect(percentiles.p50).toBeGreaterThanOrEqual(475);
    expect(percentiles.p50).toBeLessThanOrEqual(525);

    // p90 should be ~900ms
    expect(percentiles.p90).toBeGreaterThanOrEqual(855);
    expect(percentiles.p90).toBeLessThanOrEqual(945);

    // p99 should be ~990ms
    expect(percentiles.p99).toBeGreaterThanOrEqual(940);
    expect(percentiles.p99).toBeLessThanOrEqual(1000);
  });

  it('should handle sub-millisecond durations', () => {
    hist.record(0.05); // 50 us
    hist.record(0.12);
    hist.record(0.35);

    expect(hist.getCount()).toBe(3);
    const percentiles = hist.getPercentiles();
    expect(percentiles.min).toBe(0.05);
    expect(percentiles.max).toBe(0.35);
  });

  it('should support merging two histograms', () => {
    const h1 = new LogHistogram();
    const h2 = new LogHistogram();

    for (let i = 0; i < 500; i++) h1.record(10);
    for (let i = 0; i < 500; i++) h2.record(100);

    h1.merge(h2);
    expect(h1.getCount()).toBe(1000);
    const percentiles = h1.getPercentiles();
    expect(percentiles.p50).toBeGreaterThanOrEqual(9);
    expect(percentiles.p50).toBeLessThanOrEqual(55);
    expect(percentiles.p99).toBeGreaterThanOrEqual(90);
  });

  it('should reset state cleanly', () => {
    hist.record(150);
    expect(hist.getCount()).toBe(1);
    hist.reset();
    expect(hist.getCount()).toBe(0);
    expect(hist.getPercentiles().p50).toBe(0);
  });
});
