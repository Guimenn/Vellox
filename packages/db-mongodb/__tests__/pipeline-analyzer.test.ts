import { describe, it, expect } from 'vitest';
import { MongoPipelineAnalyzer } from '../src/pipeline-analyzer.js';

describe('MongoPipelineAnalyzer', () => {
  it('should detect $unwind before $match anti-pattern', () => {
    const pipeline = [
      { $unwind: '$items' },
      { $match: { 'items.status': 'shipped' } }
    ];

    const findings = MongoPipelineAnalyzer.analyzePipeline(pipeline);
    expect(findings.length).toBe(1);
    expect(findings[0]!.severity).toBe('CRITICAL');
    expect(findings[0]!.title).toContain('$match Placed After $unwind');
  });

  it('should detect $sort without early $limit', () => {
    const pipeline = [
      { $match: { active: true } },
      { $sort: { createdAt: -1 } },
      { $project: { name: 1, email: 1 } }
    ];

    const findings = MongoPipelineAnalyzer.analyzePipeline(pipeline);
    expect(findings.length).toBe(1);
    expect(findings[0]!.severity).toBe('HIGH');
    expect(findings[0]!.title).toContain('Unbounded $sort Stage');
  });

  it('should detect $lookup foreign key index recommendation', () => {
    const pipeline = [
      {
        $lookup: {
          from: 'orders',
          localField: 'userId',
          foreignField: 'customerId',
          as: 'userOrders'
        }
      }
    ];

    const findings = MongoPipelineAnalyzer.analyzePipeline(pipeline);
    expect(findings.length).toBe(1);
    expect(findings[0]!.suggestedFix).toContain('db.orders.createIndex({ customerId: 1 })');
  });
});
