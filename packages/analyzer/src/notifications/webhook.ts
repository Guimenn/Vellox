import { Finding } from '@vellox/core';

export class WebhookNotifier {
  /**
   * Formats a Finding into a rich Slack Block Kit message.
   */
  public static formatSlackPayload(finding: Finding): object {
    const savings = finding.impact.estimatedMonthlyCost != null
      ? `$${finding.impact.estimatedMonthlyCost}/mo`
      : 'N/A';

    return {
      text: `🚨 Vellox Alert: [${finding.severity}] ${finding.rootCause}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `🚨 Vellox Finding: ${finding.type}`
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Service:* \`${finding.service}\``
            },
            {
              type: 'mrkdwn',
              text: `*Severity:* \`${finding.severity}\``
            },
            {
              type: 'mrkdwn',
              text: `*Confidence:* *${finding.confidence}%*`
            },
            {
              type: 'mrkdwn',
              text: `*Potential Savings:* *${savings}*`
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Root Cause:* ${finding.rootCause}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Recommended Action:* ${finding.recommendation.action}\n\`\`\`${finding.recommendation.suggestedSolution}\`\`\``
          }
        }
      ]
    };
  }

  /**
   * Formats a Finding into a rich Discord webhook embed.
   */
  public static formatDiscordPayload(finding: Finding): object {
    const color =
      finding.severity === 'CRITICAL'
        ? 0xff0033
        : finding.severity === 'HIGH'
        ? 0xff9900
        : 0x3399ff;

    return {
      embeds: [
        {
          title: `[${finding.severity}] ${finding.type} on ${finding.service}`,
          description: finding.rootCause,
          color,
          fields: [
            {
              name: 'Confidence',
              value: `${finding.confidence}%`,
              inline: true
            },
            {
              name: 'Estimated Savings',
              value: finding.impact.estimatedMonthlyCost != null
                ? `$${finding.impact.estimatedMonthlyCost}/mo`
                : 'Unavailable without pricing context',
              inline: true
            },
            {
              name: 'Action',
              value: finding.recommendation.action
            },
            {
              name: 'Solution',
              value: `\`\`\`${finding.recommendation.suggestedSolution}\`\`\``
            }
          ],
          timestamp: new Date().toISOString()
        }
      ]
    };
  }
}
