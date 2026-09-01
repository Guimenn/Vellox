import { describe, it, expect } from 'vitest';
import { RouteNormalizer } from '../src/normalizer/route.js';

describe('RouteNormalizer', () => {
  it('should parameterize numeric IDs', () => {
    const normalizer = new RouteNormalizer();
    expect(normalizer.normalize('/api/v1/users/123')).toBe('/api/v1/users/:id');
    expect(normalizer.normalize('/orders/987654321/items/42')).toBe('/orders/:id/items/:id');
  });

  it('should parameterize UUIDs', () => {
    const normalizer = new RouteNormalizer();
    expect(normalizer.normalize('/v1/sessions/550e8400-e29b-41d4-a716-446655440000')).toBe('/v1/sessions/:uuid');
    expect(normalizer.normalize('/v1/sessions/c9a646d3-9c61-4cd7-bc13-8eb994e77cb4/refresh')).toBe('/v1/sessions/:uuid/refresh');
  });

  it('should parameterize MongoDB ObjectIds', () => {
    const normalizer = new RouteNormalizer();
    expect(normalizer.normalize('/api/products/507f1f77bcf86cd799439011')).toBe('/api/products/:objectId');
  });

  it('should strip query parameters from normalized route', () => {
    const normalizer = new RouteNormalizer();
    expect(normalizer.normalize('/api/search?q=test&limit=10')).toBe('/api/search');
    expect(normalizer.normalize('/users/55?tab=profile')).toBe('/users/:id');
  });

  it('should enforce hard cardinality limits by rolling into overflow', () => {
    const normalizer = new RouteNormalizer({ maxUniqueRoutes: 5 });

    normalizer.normalize('/route1');
    normalizer.normalize('/route2');
    normalizer.normalize('/route3');
    normalizer.normalize('/route4');
    normalizer.normalize('/route5');

    // 6th unique route should hit overflow
    expect(normalizer.normalize('/route6')).toBe('/_overflow_');
    expect(normalizer.normalize('/route7')).toBe('/_overflow_');

    // Existing cached route should still resolve
    expect(normalizer.normalize('/route1')).toBe('/route1');
  });
});
