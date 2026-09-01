import { DEFAULT_PRICING, PricingConfig } from '@infrawaste/core';

export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'baremetal' | 'custom';

export const CLOUD_PRESETS: Record<CloudProvider, PricingConfig> = {
  aws: {
    cpuHourUsd: 0.0404,        // c6g.medium baseline
    memoryGbHourUsd: 0.0053,   // EC2 memory proportion
    networkGbUsd: 0.09,        // Data transfer out
    databaseHourUsd: 0.268,    // db.r6g.large PostgreSQL
    databaseStorageGbMonthUsd: 0.115
  },
  gcp: {
    cpuHourUsd: 0.038,         // n2-standard
    memoryGbHourUsd: 0.0051,
    networkGbUsd: 0.085,       // Premium egress
    databaseHourUsd: 0.245,    // Cloud SQL db-custom-2-7680
    databaseStorageGbMonthUsd: 0.17
  },
  azure: {
    cpuHourUsd: 0.041,
    memoryGbHourUsd: 0.0055,
    networkGbUsd: 0.087,
    databaseHourUsd: 0.260,
    databaseStorageGbMonthUsd: 0.115
  },
  baremetal: {
    cpuHourUsd: 0.015,
    memoryGbHourUsd: 0.002,
    networkGbUsd: 0.01,
    databaseHourUsd: 0.08,
    databaseStorageGbMonthUsd: 0.03
  },
  custom: DEFAULT_PRICING
};

export interface CostEstimationResult {
  observedMonthlyCostUsd: number | null;
  estimatedPotentialSavingsUsd: number | null;
  confidence: number;
  explanation: string;
}

export class CostEstimator {
  private pricing: PricingConfig;

  constructor(pricingOrPreset?: Partial<PricingConfig> | CloudProvider) {
    if (typeof pricingOrPreset === 'string' && CLOUD_PRESETS[pricingOrPreset]) {
      this.pricing = { ...CLOUD_PRESETS[pricingOrPreset] };
    } else if (typeof pricingOrPreset === 'object') {
      this.pricing = { ...DEFAULT_PRICING, ...pricingOrPreset };
    } else {
      this.pricing = { ...DEFAULT_PRICING };
    }
  }

  public getPricing(): PricingConfig {
    return { ...this.pricing };
  }

  /**
   * Estimates monthly potential dollar savings for an identified database waste pattern.
   * Strictly separates evidence from assumptions.
   */
  public estimateDatabaseWasteSavings(
    wasteCapacityPercent: number,
    allocatedDbInstances: number = 1
  ): CostEstimationResult {
    if (wasteCapacityPercent <= 0) {
      return {
        observedMonthlyCostUsd: null,
        estimatedPotentialSavingsUsd: null,
        confidence: 0,
        explanation: 'Zero waste capacity identified.'
      };
    }

    const hoursPerMonth = 730;
    const monthlyDbInstanceCost = this.pricing.databaseHourUsd * hoursPerMonth * allocatedDbInstances;
    const estimatedSavings = Number(((wasteCapacityPercent / 100) * monthlyDbInstanceCost).toFixed(2));

    return {
      observedMonthlyCostUsd: Number(monthlyDbInstanceCost.toFixed(2)),
      estimatedPotentialSavingsUsd: estimatedSavings,
      confidence: 85,
      explanation: `Calculated from ${wasteCapacityPercent}% capacity recovery over ${allocatedDbInstances} database node(s) @ $${this.pricing.databaseHourUsd}/hr.`
    };
  }

  /**
   * Estimates monthly network egress cost for an endpoint with large payloads.
   */
  public estimateEgressCost(dailyRequests: number, payloadBytesPerReq: number): number {
    const dailyGb = (dailyRequests * payloadBytesPerReq) / (1024 * 1024 * 1024);
    const monthlyGb = dailyGb * 30.5;
    return Number((monthlyGb * this.pricing.networkGbUsd).toFixed(2));
  }
}
