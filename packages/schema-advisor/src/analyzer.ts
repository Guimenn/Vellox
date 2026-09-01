export interface SchemaFinding {
  id: string;
  rule: 'UNINDEXED_FOREIGN_KEY' | 'LOCK_RISKY_DEFAULT_VALUE' | 'REDUNDANT_INDEX';
  table: string;
  column?: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  explanation: string;
  suggestedFix: string;
}

export class SchemaAdvisor {
  /**
   * Analyzes raw SQL DDL script or migration content and flags potential schema waste & lock risks.
   */
  public static analyzeDdl(sql: string): SchemaFinding[] {
    const findings: SchemaFinding[] = [];
    const normalized = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // 1. Detect Tables with Foreign Keys
    const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]?\w+["`]?\.)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\);/gi;
    let tableMatch;

    const indexedColumnsByTable = new Map<string, Set<string>>();
    const compositeIndexesByTable = new Map<string, string[][]>();

    // Extract explicit CREATE INDEX statements
    const createIndexRegex = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]?\w+["`]?\s+)?ON\s+(?:["`]?\w+["`]?\.)?["`]?(\w+)["`]?\s*\(([^)]+)\)/gi;
    let indexMatch;
    while ((indexMatch = createIndexRegex.exec(normalized)) !== null) {
      const table = indexMatch[1]!.toLowerCase();
      const rawCols = indexMatch[2]!;
      const cols = rawCols.split(',').map((c) => c.trim().replace(/["`]/g, '').toLowerCase());

      if (!indexedColumnsByTable.has(table)) {
        indexedColumnsByTable.set(table, new Set());
      }
      for (const col of cols) {
        indexedColumnsByTable.get(table)!.add(col);
      }

      if (!compositeIndexesByTable.has(table)) {
        compositeIndexesByTable.set(table, []);
      }
      compositeIndexesByTable.get(table)!.push(cols);
    }

    while ((tableMatch = createTableRegex.exec(normalized)) !== null) {
      const tableName = tableMatch[1]!.toLowerCase();
      const body = tableMatch[2]!;

      // Inline FOREIGN KEY / REFERENCES check
      // e.g. "order_id INT REFERENCES orders(id)" or "FOREIGN KEY (order_id) REFERENCES orders(id)"
      const fkRegex = /(?:(\w+)\s+[\w()]+(?:\s+NOT\s+NULL)?\s+REFERENCES\s+(\w+)|FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\w+))/gi;
      let fkMatch;

      while ((fkMatch = fkRegex.exec(body)) !== null) {
        const fkCol = (fkMatch[1] || fkMatch[3])?.trim().replace(/["`]/g, '').toLowerCase();
        const targetTable = (fkMatch[2] || fkMatch[4])?.trim().toLowerCase();

        if (fkCol && targetTable) {
          const tableIndexes = indexedColumnsByTable.get(tableName);
          if (!tableIndexes || !tableIndexes.has(fkCol)) {
            findings.push({
              id: `unindexed-fk-${tableName}-${fkCol}`,
              rule: 'UNINDEXED_FOREIGN_KEY',
              table: tableName,
              column: fkCol,
              severity: 'HIGH',
              title: `Unindexed Foreign Key on ${tableName}.${fkCol}`,
              explanation: `Foreign key '${tableName}.${fkCol}' referencing '${targetTable}' has no supporting index. This causes full table scans and severe lock escalation on DELETE/UPDATE operations on '${targetTable}'.`,
              suggestedFix: `CREATE INDEX idx_${tableName}_${fkCol} ON ${tableName} (${fkCol});`
            });
          }
        }
      }
    }

    // 2. Detect Risky ALTER TABLE ADD COLUMN with DEFAULT NOT NULL
    const alterTableRegex = /ALTER\s+TABLE\s+(?:["`]?\w+["`]?\.)?["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?(\w+)["`]?\s+[\w()]+\s+DEFAULT\s+([^;\n]+)\s+NOT\s+NULL/gi;
    let alterMatch;

    while ((alterMatch = alterTableRegex.exec(normalized)) !== null) {
      const table = alterMatch[1]!;
      const col = alterMatch[2]!;
      findings.push({
        id: `risky-alter-default-${table}-${col}`,
        rule: 'LOCK_RISKY_DEFAULT_VALUE',
        table,
        column: col,
        severity: 'MEDIUM',
        title: `Lock-Risky Column Addition on ${table}.${col}`,
        explanation: `Adding column '${col}' with DEFAULT and NOT NULL simultaneously can trigger exclusive table rewrites in relational databases.`,
        suggestedFix: `-- Recommended zero-downtime migration steps:\n1. ALTER TABLE ${table} ADD COLUMN ${col} type;\n2. Backfill existing rows;\n3. ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL;`
      });
    }

    // 3. Detect Redundant Prefix Indexes
    for (const [table, indexList] of compositeIndexesByTable.entries()) {
      for (const cols of indexList) {
        if (cols.length > 1) {
          const leadCol = cols[0]!;
          const hasRedundantSingle = indexList.some((other) => other.length === 1 && other[0] === leadCol);
          if (hasRedundantSingle) {
            findings.push({
              id: `redundant-index-${table}-${leadCol}`,
              rule: 'REDUNDANT_INDEX',
              table,
              column: leadCol,
              severity: 'LOW',
              title: `Redundant Index on ${table}.${leadCol}`,
              explanation: `Single-column index on '${table}(${leadCol})' is redundant because composite index on '${table}(${cols.join(', ')})' already satisfies queries filtering on '${leadCol}'. Redundant indexes waste buffer pool memory and write IOPS.`,
              suggestedFix: `DROP INDEX idx_${table}_${leadCol};`
            });
          }
        }
      }
    }

    return findings;
  }
}
