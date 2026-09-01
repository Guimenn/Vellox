/**
 * High-performance Route Normalizer & Cardinality Guard
 * 
 * Prevents metric cardinality explosions by parameterizing dynamic path segments
 * (UUIDs, integer IDs, MongoDB ObjectIds, hashes) and strictly bounding total unique series.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONGO_ID_REGEX = /^[0-9a-f]{24}$/i;
const HEX_HASH_REGEX = /^[0-9a-f]{16,64}$/i;
const NUMERIC_REGEX = /^\d+$/;

export interface RouteNormalizerOptions {
  maxUniqueRoutes?: number;
  overflowRouteName?: string;
}

export class RouteNormalizer {
  private readonly maxUniqueRoutes: number;
  private readonly overflowRouteName: string;
  private routeCache: Map<string, string>;

  constructor(options: RouteNormalizerOptions = {}) {
    this.maxUniqueRoutes = options.maxUniqueRoutes ?? 500;
    this.overflowRouteName = options.overflowRouteName ?? '/_overflow_';
    this.routeCache = new Map();
  }

  /**
   * Normalizes an incoming raw URL pathname into a parameterized template.
   * Uses an internal LRU-like bounded cache to eliminate regex operations on hot paths.
   */
  public normalize(rawPath: string): string {
    if (!rawPath || rawPath === '/') return '/';

    // Fast cache lookup
    const cached = this.routeCache.get(rawPath);
    if (cached !== undefined) {
      return cached;
    }

    // Strip trailing slash & query parameters if present
    let path = rawPath;
    const queryIdx = path.indexOf('?');
    if (queryIdx !== -1) {
      path = path.substring(0, queryIdx);
    }
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    // Split and normalize segments
    const segments = path.split('/');
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      if (!segment) continue;

      if (NUMERIC_REGEX.test(segment)) {
        segments[i] = ':id';
      } else if (UUID_REGEX.test(segment)) {
        segments[i] = ':uuid';
      } else if (MONGO_ID_REGEX.test(segment)) {
        segments[i] = ':objectId';
      } else if (HEX_HASH_REGEX.test(segment)) {
        segments[i] = ':hash';
      }
    }

    const normalized = segments.join('/') || '/';

    // Enforce hard cardinality limit
    if (this.routeCache.size >= this.maxUniqueRoutes) {
      // If full and key is new, assign to overflow
      return this.overflowRouteName;
    }

    this.routeCache.set(rawPath, normalized);
    return normalized;
  }

  public getCacheSize(): number {
    return this.routeCache.size;
  }

  public clearCache(): void {
    this.routeCache.clear();
  }
}
