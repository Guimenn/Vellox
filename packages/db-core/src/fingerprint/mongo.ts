import * as crypto from 'node:crypto';
import { NormalizedQuery } from '@vellox/core';

export class MongoFingerprinter {
  /**
   * Normalizes MongoDB command & filter object into a canonical fingerprint.
   */
  public static normalize(collection: string, operation: string, filter?: Record<string, unknown> | null): NormalizedQuery {
    const cleanCollection = collection || 'unknown';
    const cleanOp = (operation || 'find').toLowerCase();

    let filterTemplate = '';
    if (filter && typeof filter === 'object') {
      filterTemplate = MongoFingerprinter.normalizeFilterObj(filter);
    }

    const canonical = `${cleanCollection}.${cleanOp}(${filterTemplate})`;
    const hash = crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
    const fingerprint = `mongo_${hash}`;

    return {
      raw: canonical,
      fingerprint,
      operation: cleanOp.toUpperCase(),
      tables: [cleanCollection]
    };
  }

  private static normalizeFilterObj(obj: unknown): string {
    if (obj === null || obj === undefined) return '';
    if (typeof obj !== 'object') return '?';

    if (Array.isArray(obj)) {
      return '[?]';
    }

    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const parts: string[] = [];

    for (const key of keys) {
      const val = (obj as Record<string, unknown>)[key];
      if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).some(k => k.startsWith('$'))) {
        // Nested operator like { $gt: 50, $in: [1, 2] }
        parts.push(`${key}: { ${MongoFingerprinter.normalizeFilterObj(val)} }`);
      } else {
        parts.push(`${key}: ?`);
      }
    }

    return `{ ${parts.join(', ')} }`;
  }
}
