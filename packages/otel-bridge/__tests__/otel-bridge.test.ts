import { describe, it, expect } from 'vitest';
import { OtelTransformer } from '../src/transformer.js';

describe('OtelTransformer', () => {
  it('should transform OTLP trace JSON payload into normalized HTTP & Database telemetry', () => {
    const mockOtlpPayload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'checkout-service' } }
            ]
          },
          scopeSpans: [
            {
              spans: [
                // HTTP Server Span
                {
                  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
                  spanId: '00f067aa0ba902b7',
                  name: 'GET /api/v1/cart',
                  kind: 2,
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000000050000000', // 50ms
                  attributes: [
                    { key: 'http.method', value: { stringValue: 'GET' } },
                    { key: 'http.route', value: { stringValue: '/api/v1/cart' } },
                    { key: 'http.status_code', value: { intValue: 200 } }
                  ]
                },
                // Database Client Span
                {
                  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
                  spanId: '5fb397be34d23b0f',
                  parentSpanId: '00f067aa0ba902b7',
                  name: 'SELECT',
                  kind: 3,
                  startTimeUnixNano: '1700000000005000000',
                  endTimeUnixNano: '1700000000025000000', // 20ms
                  attributes: [
                    { key: 'db.system', value: { stringValue: 'postgresql' } },
                    { key: 'db.name', value: { stringValue: 'cart_db' } },
                    { key: 'db.statement', value: { stringValue: 'SELECT * FROM cart_items WHERE cart_id = 99' } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const { httpTelemetries, dbTelemetries } = OtelTransformer.transformOtlpExport(mockOtlpPayload);

    expect(httpTelemetries.length).toBe(1);
    expect(httpTelemetries[0]!.service).toBe('checkout-service');
    expect(httpTelemetries[0]!.route).toBe('/api/v1/cart');
    expect(httpTelemetries[0]!.durationMs).toBe(50);
    expect(httpTelemetries[0]!.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');

    expect(dbTelemetries.length).toBe(1);
    expect(dbTelemetries[0]!.service).toBe('checkout-service');
    expect(dbTelemetries[0]!.databaseType).toBe('postgresql');
    expect(dbTelemetries[0]!.database).toBe('cart_db');
    expect(dbTelemetries[0]!.totalDurationMs).toBe(20);
    expect(dbTelemetries[0]!.fingerprint).toBeDefined();
  });
});
