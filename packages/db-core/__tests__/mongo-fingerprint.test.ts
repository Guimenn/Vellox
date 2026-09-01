import { describe, it, expect } from 'vitest';
import { MongoFingerprinter } from '../src/fingerprint/mongo.js';

describe('MongoFingerprinter', () => {
  it('should normalize filter objects to stable parameterized templates', () => {
    const f1 = MongoFingerprinter.normalize('users', 'find', { id: 10, status: 'active' });
    const f2 = MongoFingerprinter.normalize('users', 'find', { id: 888, status: 'inactive' });

    expect(f1.fingerprint).toBe(f2.fingerprint);
    expect(f1.raw).toBe('users.find({ id: ?, status: ? })');
    expect(f1.tables).toContain('users');
  });

  it('should handle complex operator expressions', () => {
    const f1 = MongoFingerprinter.normalize('orders', 'aggregate', { total: { $gt: 100 }, status: { $in: ['PAID', 'SHIPPED'] } });
    const f2 = MongoFingerprinter.normalize('orders', 'aggregate', { total: { $gt: 500 }, status: { $in: ['PENDING'] } });

    expect(f1.fingerprint).toBe(f2.fingerprint);
    expect(f1.operation).toBe('AGGREGATE');
  });
});
