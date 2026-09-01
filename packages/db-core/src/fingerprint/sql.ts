import * as crypto from 'node:crypto';
import { NormalizedQuery } from '@infrawaste/core';

const SQL_COMMENT_REGEX = /(--[^\n]*|\/\*[\s\S]*?\*\/)/g;
const STRING_LITERAL_REGEX = /'(''|[^'])*'/g;
const NUMERIC_LITERAL_REGEX = /\b\d+(\.\d+)?\b/g;
const HEX_LITERAL_REGEX = /\b0x[0-9a-fA-F]+\b/g;
const IN_LIST_REGEX = /\bIN\s*\(\s*(\?\s*,\s*)*\?\s*\)/gi;
const WHITESPACE_REGEX = /\s+/g;
const TABLE_REGEX = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([`"[\]\w\.]+)/gi;

export class SqlFingerprinter {
  /**
   * Normalizes a raw SQL query string into a canonical parameterized fingerprint.
   * Deterministic, safe, strips sensitive literals, and computes a stable hash.
   */
  public static normalize(rawSql: string): NormalizedQuery {
    if (!rawSql || typeof rawSql !== 'string') {
      return {
        raw: '',
        fingerprint: '',
        operation: 'UNKNOWN',
        tables: []
      };
    }

    // 1. Strip SQL comments (-- line and /* block */)
    let sql = rawSql.replace(SQL_COMMENT_REGEX, ' ');

    // 2. Extract tables before stripping identifiers
    const tables = SqlFingerprinter.extractTables(sql);

    // 3. Extract primary operation
    const operation = SqlFingerprinter.extractOperation(sql);

    // 4. Replace string literals with ?
    sql = sql.replace(STRING_LITERAL_REGEX, '?');

    // 5. Replace hex and binary literals with ?
    sql = sql.replace(HEX_LITERAL_REGEX, '?');

    // 6. Replace numeric literals with ?
    sql = sql.replace(NUMERIC_LITERAL_REGEX, '?');

    // 7. Collapse IN (?, ?, ?) to IN (?)
    sql = sql.replace(IN_LIST_REGEX, 'IN (?)');

    // 8. Collapse whitespace and trim
    sql = sql.replace(WHITESPACE_REGEX, ' ').trim();

    // 9. Generate stable SHA-256 hash (first 16 hex chars)
    const hash = crypto.createHash('sha256').update(sql).digest('hex').substring(0, 16);
    const fingerprint = `sql_${hash}`;

    return {
      raw: rawSql.trim(),
      fingerprint,
      operation,
      tables
    };
  }

  private static extractOperation(sql: string): string {
    const match = sql.trim().match(/^([a-zA-Z]+)/);
    return match && match[1] ? match[1].toUpperCase() : 'UNKNOWN';
  }

  private static extractTables(sql: string): string[] {
    const tables: Set<string> = new Set();
    let match: RegExpExecArray | null;

    TABLE_REGEX.lastIndex = 0;
    while ((match = TABLE_REGEX.exec(sql)) !== null) {
      if (match[1]) {
        const cleanTable = match[1].replace(/[`"[\]]/g, '').trim();
        if (cleanTable && !cleanTable.toUpperCase().startsWith('SELECT')) {
          tables.add(cleanTable);
        }
      }
    }

    return Array.from(tables);
  }
}
