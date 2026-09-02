import * as fs from 'node:fs';
import * as path from 'node:path';
import { VelloxBudgets, VelloxConfig, VelloxReport } from './types.js';

export const DEFAULT_CONFIG: VelloxConfig = {
  reportPath: '.vellox/report.json',
  baselinePath: '.vellox/baseline.json',
  budgets: {
    maxCritical: 0,
    maxHigh: 0,
    maxTotal: null,
    failOnSecrets: true
  }
};

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function loadConfig(target: string): VelloxConfig {
  const configPath = path.join(target, 'vellox.config.json');
  if (!fs.existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);

  try {
    const input = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<VelloxConfig>;
    const budgets = input.budgets || {} as Partial<VelloxBudgets>;
    return {
      reportPath: typeof input.reportPath === 'string' ? input.reportPath : DEFAULT_CONFIG.reportPath,
      baselinePath: typeof input.baselinePath === 'string' ? input.baselinePath : DEFAULT_CONFIG.baselinePath,
      budgets: {
        maxCritical: finiteNumber(budgets.maxCritical, DEFAULT_CONFIG.budgets.maxCritical),
        maxHigh: finiteNumber(budgets.maxHigh, DEFAULT_CONFIG.budgets.maxHigh),
        maxTotal: budgets.maxTotal === null ? null : finiteNumber(budgets.maxTotal, Number.MAX_SAFE_INTEGER),
        failOnSecrets: typeof budgets.failOnSecrets === 'boolean' ? budgets.failOnSecrets : true
      }
    };
  } catch (error) {
    throw new Error(`Could not parse ${configPath}: ${(error as Error).message}`);
  }
}

export function resolveFromTarget(target: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(target, filePath);
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readReport(filePath: string): VelloxReport {
  if (!fs.existsSync(filePath)) throw new Error(`Vellox report not found: ${filePath}`);
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as VelloxReport;
  if (value.schemaVersion !== '1.0' || !Array.isArray(value.findings)) {
    throw new Error(`Unsupported or invalid Vellox report: ${filePath}`);
  }
  return value;
}
