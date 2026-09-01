import { describe, it, expect } from 'vitest';
import { WebhookNotifier } from '../src/notifications/webhook.js';
import { Finding } from '@infrawaste/core';

describe('WebhookNotifier', () => {
  const sampleFinding: Finding = {
    id: 'find-nplus1-test',
    type: 'POSSIBLE_N_PLUS_ONE',
    service: 'order-service',
    endpoint: 'GET /api/v1/orders/:id',
    database: 'postgres_main',
    confidence: 94,
    severity: 'CRITICAL',
    rootCause: 'Single HTTP request triggers 84 child database queries for order items',
    evidence: {
      parentExecutionCount: 1,
      childExecutionCount: 84
    },
    impact: {
      databaseLoad: 80,
      latencyPercent: 65,
      estimatedMonthlyCost: 1284
    },
    recommendation: {
      action: 'Implement batch query or DataLoader',
      explanation: 'N+1 queries detected',
      suggestedSolution: 'SELECT * FROM order_items WHERE order_id IN ($1, $2, ...)',
      estimatedImpact: { databaseLoad: 80 },
      evidence: {}
    },
    timestamp: Date.now()
  };

  it('should format rich Slack block kit payload', () => {
    const slack = WebhookNotifier.formatSlackPayload(sampleFinding) as any;
    expect(slack.text).toContain('[CRITICAL]');
    expect(slack.blocks).toBeDefined();
    expect(slack.blocks.length).toBeGreaterThanOrEqual(3);

    const fieldsSection = slack.blocks[1].fields;
    expect(fieldsSection.some((f: any) => f.text.includes('94%'))).toBe(true);
    expect(fieldsSection.some((f: any) => f.text.includes('$1284/mo'))).toBe(true);
  });

  it('should format rich Discord embed payload', () => {
    const discord = WebhookNotifier.formatDiscordPayload(sampleFinding) as any;
    expect(discord.embeds).toBeDefined();
    expect(discord.embeds.length).toBe(1);

    const embed = discord.embeds[0];
    expect(embed.title).toContain('POSSIBLE_N_PLUS_ONE');
    expect(embed.color).toBe(0xff0033); // CRITICAL red
    expect(embed.fields.some((f: any) => f.value.includes('94%'))).toBe(true);
  });
});
