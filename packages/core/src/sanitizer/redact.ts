/**
 * Privacy & Redaction Engine
 * 
 * Enforces zero-leakage of credentials, session tokens, and PII in telemetry pipelines.
 */

const SENSITIVE_PARAM_NAMES = new Set([
  'token',
  'access_token',
  'refresh_token',
  'auth',
  'authentication',
  'secret',
  'api_key',
  'apikey',
  'password',
  'passwd',
  'pwd',
  'jwt',
  'key',
  'session',
  'session_id',
  'credit_card',
  'card_number',
  'cvv',
  'ssn'
]);

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token'
]);

export interface RedactionOptions {
  customSensitiveParams?: string[];
  customSensitiveHeaders?: string[];
}

export class TelemetrySanitizer {
  private sensitiveParams: Set<string>;
  private sensitiveHeaders: Set<string>;

  constructor(options: RedactionOptions = {}) {
    this.sensitiveParams = new Set([
      ...SENSITIVE_PARAM_NAMES,
      ...(options.customSensitiveParams || []).map(p => p.toLowerCase())
    ]);

    this.sensitiveHeaders = new Set([
      ...SENSITIVE_HEADERS,
      ...(options.customSensitiveHeaders || []).map(h => h.toLowerCase())
    ]);
  }

  /**
   * Redacts sensitive query string parameters from a URL or query string.
   */
  public sanitizeQueryString(queryString: string): string {
    if (!queryString) return '';

    const cleanQuery = queryString.startsWith('?') ? queryString.substring(1) : queryString;
    const pairs = cleanQuery.split('&');
    const sanitizedPairs: string[] = [];

    for (const pair of pairs) {
      if (!pair) continue;
      const [rawKey, rawValue] = pair.split('=', 2);
      if (!rawKey) continue;

      const keyLower = decodeURIComponent(rawKey).toLowerCase();
      if (this.sensitiveParams.has(keyLower)) {
        sanitizedPairs.push(`${rawKey}=[REDACTED]`);
      } else {
        sanitizedPairs.push(rawValue !== undefined ? `${rawKey}=${rawValue}` : rawKey);
      }
    }

    return sanitizedPairs.join('&');
  }

  /**
   * Filters out sensitive HTTP headers, returning a safe subset.
   */
  public filterHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const safeHeaders: Record<string, string> = {};

    for (const [key, val] of Object.entries(headers)) {
      if (val === undefined) continue;
      const lowerKey = key.toLowerCase();
      if (!this.sensitiveHeaders.has(lowerKey)) {
        safeHeaders[key] = Array.isArray(val) ? val.join(', ') : String(val);
      }
    }

    return safeHeaders;
  }
}
