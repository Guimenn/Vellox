export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type FindingCategory = 'security' | 'code' | 'database' | 'query' | 'infrastructure';

export interface VelloxFinding {
  fingerprint: string;
  ruleId: string;
  severity: Severity;
  category: FindingCategory;
  title: string;
  evidence: string;
  recommendation: string;
  file?: string;
  line?: number;
  sql?: string;
  metadata?: Record<string, string | number | boolean>;
}

export type VelloxFindingInput = Omit<VelloxFinding, 'fingerprint'>;

export interface VelloxSummary {
  filesScanned: number;
  findings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  secrets: number;
  infrastructure: number;
  reviewableSqlFixes: number;
}

export interface VelloxReport {
  schemaVersion: '1.0';
  tool: { name: 'vellox'; version: string };
  generatedAt: string;
  target: string;
  databaseContext: { detected: boolean; evidence: string[] };
  summary: VelloxSummary;
  findings: VelloxFinding[];
}

export interface VelloxBudgets {
  maxCritical: number;
  maxHigh: number;
  maxTotal: number | null;
  failOnSecrets: boolean;
}

export interface VelloxConfig {
  reportPath?: string;
  baselinePath?: string;
  budgets: VelloxBudgets;
}

export interface BudgetEvaluation {
  passed: boolean;
  evaluatedFindings: VelloxFinding[];
  violations: string[];
}
