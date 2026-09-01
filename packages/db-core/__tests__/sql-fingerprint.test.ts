import { describe, it, expect } from 'vitest';
import { SqlFingerprinter } from '../src/fingerprint/sql.js';

describe('SqlFingerprinter', () => {
  it('should normalize integer and string query parameters to identical fingerprints', () => {
    const q1 = 'SELECT id, name, email FROM users WHERE id = 10 AND status = \'active\';';
    const q2 = 'SELECT id, name, email FROM users WHERE id = 9999 AND status = \'pending\';';

    const norm1 = SqlFingerprinter.normalize(q1);
    const norm2 = SqlFingerprinter.normalize(q2);

    expect(norm1.fingerprint).toBe(norm2.fingerprint);
    expect(norm1.operation).toBe('SELECT');
    expect(norm1.tables).toContain('users');
  });

  it('should normalize IN lists and strip comments', () => {
    const q1 = `
      -- Fetch active customer orders
      SELECT * /* multi-line comment */
      FROM orders
      WHERE customer_id IN (10, 20, 30, 40)
      AND total_amount > 199.95;
    `;
    const q2 = 'SELECT * FROM orders WHERE customer_id IN (5) AND total_amount > 50;';

    const norm1 = SqlFingerprinter.normalize(q1);
    const norm2 = SqlFingerprinter.normalize(q2);

    expect(norm1.fingerprint).toBe(norm2.fingerprint);
    expect(norm1.tables).toContain('orders');
  });

  it('should extract table names across JOIN clauses', () => {
    const query = `
      SELECT o.id, u.name 
      FROM orders o 
      JOIN users u ON o.user_id = u.id 
      LEFT JOIN line_items li ON li.order_id = o.id
      WHERE o.created_at > '2026-01-01';
    `;
    const norm = SqlFingerprinter.normalize(query);

    expect(norm.tables).toContain('orders');
    expect(norm.tables).toContain('users');
    expect(norm.tables).toContain('line_items');
  });
});
