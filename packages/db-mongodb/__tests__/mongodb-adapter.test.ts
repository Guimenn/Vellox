import { describe, it, expect, beforeEach } from 'vitest';
import { MongoDatabaseAdapter } from '../src/adapter.js';

describe('MongoDatabaseAdapter', () => {
  let adapter: MongoDatabaseAdapter;

  beforeEach(() => {
    adapter = new MongoDatabaseAdapter();
    adapter.setServiceName('profile-service');
  });

  it('should collect command monitoring events and generate telemetry', async () => {
    adapter.handleCommandSucceeded('accounts', {
      commandName: 'find',
      duration: 12.5,
      reply: {
        cursor: {
          firstBatch: [{ id: 1 }, { id: 2 }, { id: 3 }],
          id: 0
        },
        docsExamined: 25000 // Scanned 25,000 to return 3!
      }
    }, { accountId: 'ACC-99', active: true });

    const telemetry = await adapter.collectMetrics();
    expect(telemetry.length).toBe(1);
    expect(telemetry[0]!.databaseType).toBe('mongodb');
    expect(telemetry[0]!.service).toBe('profile-service');
    expect(telemetry[0]!.operation).toBe('FIND');
    expect(telemetry[0]!.rowsRead).toBe(25000);
    expect(telemetry[0]!.rowsReturned).toBe(3);
  });
});
