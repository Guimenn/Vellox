import { describe, it, expect } from 'vitest';
import { CostEstimator } from '../src/estimator.js';

describe('CostEstimator', () => {
  it('should calculate estimated monthly database savings with evidence explanation', () => {
    const estimator = new CostEstimator({
      cpuHourUsd: 0.04,
      memoryGbHourUsd: 0.006,
      networkGbUsd: 0.08,
      databaseHourUsd: 0.268,
      databaseStorageGbMonthUsd: 0.115
    });
    const result = estimator.estimateDatabaseWasteSavings(25, 2); // 25% waste across 2 DB instances

    expect(result.estimatedPotentialSavingsUsd).toBeGreaterThan(0);
    expect(result.observedMonthlyCostUsd).toBeGreaterThan(result.estimatedPotentialSavingsUsd!);
    expect(result.confidence).toBeNull();
    expect(result.explanation).toContain('caller-supplied 25% capacity recovery assumption');
  });

  it('should return null savings for 0% waste', () => {
    const estimator = new CostEstimator({
      cpuHourUsd: 0.04,
      memoryGbHourUsd: 0.006,
      networkGbUsd: 0.08,
      databaseHourUsd: 0.20
    });
    const result = estimator.estimateDatabaseWasteSavings(0);

    expect(result.estimatedPotentialSavingsUsd).toBeNull();
  });

  it('should refuse to invent monetary impact without explicit pricing', () => {
    const result = new CostEstimator().estimateDatabaseWasteSavings(25, 2);

    expect(result.observedMonthlyCostUsd).toBeNull();
    expect(result.estimatedPotentialSavingsUsd).toBeNull();
    expect(result.explanation).toContain('No pricing supplied');
  });
});
