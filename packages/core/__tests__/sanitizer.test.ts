import { describe, it, expect } from 'vitest';
import { TelemetrySanitizer } from '../src/sanitizer/redact.js';

describe('TelemetrySanitizer', () => {
  const sanitizer = new TelemetrySanitizer();

  it('should redact sensitive query parameters', () => {
    const rawQuery = 'userId=10&token=secret-jwt-12345&action=login&password=mySuperPassword!';
    const clean = sanitizer.sanitizeQueryString(rawQuery);

    expect(clean).toContain('userId=10');
    expect(clean).toContain('token=[REDACTED]');
    expect(clean).toContain('action=login');
    expect(clean).toContain('password=[REDACTED]');
    expect(clean).not.toContain('secret-jwt-12345');
    expect(clean).not.toContain('mySuperPassword!');
  });

  it('should filter out sensitive authentication headers', () => {
    const rawHeaders = {
      'host': 'api.vellox.dev',
      'user-agent': 'Mozilla/5.0',
      'authorization': 'Bearer super-secret-token',
      'cookie': 'session_id=abcdef123456',
      'x-api-key': 'live_key_9999',
      'content-type': 'application/json'
    };

    const safe = sanitizer.filterHeaders(rawHeaders);

    expect(safe['host']).toBe('api.vellox.dev');
    expect(safe['content-type']).toBe('application/json');
    expect(safe['user-agent']).toBe('Mozilla/5.0');
    expect(safe['authorization']).toBeUndefined();
    expect(safe['cookie']).toBeUndefined();
    expect(safe['x-api-key']).toBeUndefined();
  });
});
