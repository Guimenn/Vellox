import { describe, it, expect } from 'vitest';
import { CostEstimator } from '../src/estimator.js';

describe('CostEstimator', () => {
  it('should calculate estimated monthly database savings with evidence explanation', () => {
    const estimator = new CostEstimator('aws');
    const result = estimator.estimateDatabaseWasteSavings(25, 2); // 25% waste across 2 DB instances

    expect(result.estimatedPotentialSavingsUsd).toBeGreaterThan(0);
    expect(result.observedMonthlyCostUsd).toBeGreaterThan(result.estimatedPotentialSavingsUsd!);
    expect(result.confidence).toBe(85);
    expect(result.explanation).toContain('25% capacity recovery');
  });

  it('should return null savings for 0% waste', () => {
    const estimator = new CostEstimator();
    const result = estimator.estimateDatabaseWasteSavings(0);

    expect(result.estimatedPotentialSavingsUsd).toBeNull();
  });
});
