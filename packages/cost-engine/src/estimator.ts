import { PricingConfig } from '@vellox/core';

export interface CostEstimationResult {
  observedMonthlyCostUsd: number | null;
  estimatedPotentialSavingsUsd: number | null;
  confidence: number | null;
  explanation: string;
}

export class CostEstimator {
  private pricing: PricingConfig | null;

  constructor(pricing?: PricingConfig) {
    this.pricing = pricing ? { ...pricing } : null;
  }

  public getPricing(): PricingConfig | null {
    return this.pricing ? { ...this.pricing } : null;
  }

  /**
   * Estimates monthly potential dollar savings for an identified database waste pattern.
   * Strictly separates evidence from assumptions.
   */
  public estimateDatabaseWasteSavings(
    wasteCapacityPercent: number,
    allocatedDbInstances: number = 1
  ): CostEstimationResult {
    if (!this.pricing) {
      return {
        observedMonthlyCostUsd: null,
        estimatedPotentialSavingsUsd: null,
        confidence: null,
        explanation: 'No pricing supplied. Provide an explicit PricingConfig before calculating monetary impact.'
      };
    }
    if (wasteCapacityPercent <= 0) {
      return {
        observedMonthlyCostUsd: null,
        estimatedPotentialSavingsUsd: null,
        confidence: null,
        explanation: 'Zero waste capacity identified.'
      };
    }

    const hoursPerMonth = 730;
    const monthlyDbInstanceCost = this.pricing.databaseHourUsd * hoursPerMonth * allocatedDbInstances;
    const estimatedSavings = Number(((wasteCapacityPercent / 100) * monthlyDbInstanceCost).toFixed(2));

    return {
      observedMonthlyCostUsd: Number(monthlyDbInstanceCost.toFixed(2)),
      estimatedPotentialSavingsUsd: estimatedSavings,
      confidence: null,
      explanation: `Arithmetic scenario using the caller-supplied ${wasteCapacityPercent}% capacity recovery assumption over ${allocatedDbInstances} database node(s) @ $${this.pricing.databaseHourUsd}/hr. Vellox did not infer those inputs.`
    };
  }

  /**
   * Estimates monthly network egress cost for an endpoint with large payloads.
   */
  public estimateEgressCost(dailyRequests: number, payloadBytesPerReq: number): number | null {
    if (!this.pricing) return null;
    const dailyGb = (dailyRequests * payloadBytesPerReq) / (1024 * 1024 * 1024);
    const monthlyGb = dailyGb * 30.5;
    return Number((monthlyGb * this.pricing.networkGbUsd).toFixed(2));
  }
}
