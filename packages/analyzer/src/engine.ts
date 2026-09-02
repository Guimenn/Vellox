import { DatabaseTelemetry, Finding, HttpAggregateTelemetry } from '@vellox/core';
import { RepeatedQueryRule } from './rules/repeated-query.js';
import { NPlusOneRule } from './rules/n-plus-one.js';
import { TableScanRule } from './rules/table-scan.js';
import { CollScanRule } from './rules/collscan.js';
import { RedisExpensiveRule } from './rules/redis-expensive.js';
import { CacheOpportunityRule } from './rules/cache-opportunity.js';

export interface AnalysisInput {
  httpAggregates?: HttpAggregateTelemetry[];
  databaseTelemetry?: DatabaseTelemetry[];
}

export class WasteAnalyzerEngine {
  /**
   * Evaluates all telemetry inputs and returns prioritized, evidence-backed waste findings.
   */
  public analyze(input: AnalysisInput): Finding[] {
    const findings: Finding[] = [];
    const httpList = input.httpAggregates || [];
    const dbList = input.databaseTelemetry || [];

    // 1. Analyze Database Telemetry rules
    for (const db of dbList) {
      // Repeated Query Check
      const rep = RepeatedQueryRule.analyze(db);
      if (rep) findings.push(rep);

      // Relational Table Scan Check
      const tbl = TableScanRule.analyze(db);
      if (tbl) findings.push(tbl);

      // MongoDB COLLSCAN Check
      const coll = CollScanRule.analyze(db);
      if (coll) findings.push(coll);

      // Redis Expensive Command Check
      const redis = RedisExpensiveRule.analyze(db);
      if (redis) findings.push(redis);

      // DB Cache Opportunity
      const dbCache = CacheOpportunityRule.analyzeDb(db);
      if (dbCache) findings.push(dbCache);
    }

    // 2. Correlate HTTP + Database for N+1 detection and Root Cause Analysis
    for (const http of httpList) {
      // HTTP Cache Opportunity
      const httpCache = CacheOpportunityRule.analyzeHttp(http);
      if (httpCache) findings.push(httpCache);

      // Match with DB queries in same service
      for (const db of dbList) {
        if (db.service === http.service) {
          const nplus1 = NPlusOneRule.analyze(http, db);
          if (nplus1) {
            findings.push(nplus1);
          }
        }
      }
    }

    // 3. Sort findings by severity and confidence
    const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    findings.sort((a, b) => {
      const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return (b.impact.estimatedMonthlyCost || 0) - (a.impact.estimatedMonthlyCost || 0);
    });

    return findings;
  }
}
