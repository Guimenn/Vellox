import { describe, it, expect } from 'vitest';
import { SchemaAdvisor } from '../src/analyzer.js';

describe('SchemaAdvisor', () => {
  it('should detect unindexed foreign keys in CREATE TABLE statements', () => {
    const ddl = `
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        customer_id INT NOT NULL
      );

      CREATE TABLE order_items (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id),
        product_id INT NOT NULL,
        quantity INT DEFAULT 1
      );
    `;

    const findings = SchemaAdvisor.analyzeDdl(ddl);
    expect(findings.length).toBe(1);
    expect(findings[0]!.rule).toBe('UNINDEXED_FOREIGN_KEY');
    expect(findings[0]!.table).toBe('order_items');
    expect(findings[0]!.column).toBe('order_id');
    expect(findings[0]!.suggestedFix).toContain('CREATE INDEX idx_order_items_order_id');
  });

  it('should not flag foreign keys if an explicit index is present', () => {
    const ddl = `
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY
      );

      CREATE TABLE order_items (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id)
      );

      CREATE INDEX idx_order_items_order_id ON order_items (order_id);
    `;

    const findings = SchemaAdvisor.analyzeDdl(ddl);
    expect(findings.length).toBe(0);
  });

  it('should detect lock-risky ALTER TABLE statements with DEFAULT and NOT NULL', () => {
    const ddl = `
      ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT false NOT NULL;
    `;

    const findings = SchemaAdvisor.analyzeDdl(ddl);
    expect(findings.length).toBe(1);
    expect(findings[0]!.rule).toBe('LOCK_RISKY_DEFAULT_VALUE');
    expect(findings[0]!.severity).toBe('MEDIUM');
  });

  it('should detect redundant prefix indexes', () => {
    const ddl = `
      CREATE INDEX idx_users_org ON users (org_id);
      CREATE INDEX idx_users_org_role ON users (org_id, role);
    `;

    const findings = SchemaAdvisor.analyzeDdl(ddl);
    expect(findings.length).toBe(1);
    expect(findings[0]!.rule).toBe('REDUNDANT_INDEX');
    expect(findings[0]!.column).toBe('org_id');
  });
});
