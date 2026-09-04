export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type FindingCategory = 'security' | 'code' | 'database' | 'query' | 'infrastructure';

export interface VelloxFinding {
  fingerprint: string;
  ruleId: string;
  severity: Severity;
  confidence?: Confidence;
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

export type AnalysisIssueReason = 'file-too-large' | 'read-error' | 'directory-read-error' | 'max-depth' | 'parse-fallback';

export interface VelloxAnalysisIssue {
  file: string;
  reason: AnalysisIssueReason;
  line?: number;
  parser?: 'babel' | 'lezer-python' | 'vellox-sql-ast';
  message?: string;
  sizeBytes?: number;
  limitBytes?: number;
}

export interface VelloxCoverage {
  complete: boolean;
  scope?: 'full' | 'changed';
  changedBase?: string;
  cacheHit?: boolean;
  filesDiscovered: number;
  filesAnalyzed: number;
  filesSkipped: number;
  structuralFiles: number;
  fallbackFiles: number;
  semanticModules: number;
  semanticFunctions: number;
  sqlStatements?: number;
  sqlAstStatements?: number;
  issues: VelloxAnalysisIssue[];
}

export interface VelloxReport {
  schemaVersion: '1.0';
  tool: { name: 'vellox'; version: string };
  generatedAt: string;
  target: string;
  databaseContext: { detected: boolean; evidence: string[] };
  summary: VelloxSummary;
  coverage?: VelloxCoverage;
  metrics?: Record<string, string | number | boolean>;
  findings: VelloxFinding[];
}

export interface VelloxBudgets {
  maxCritical: number;
  maxHigh: number;
  maxTotal: number | null;
  failOnSecrets: boolean;
  failOnIncompleteAnalysis?: boolean;
}

export interface VelloxAnalysisConfig {
  maxFileBytes: number;
  sqlDialect?: 'auto' | 'postgresql' | 'mysql' | 'sqlite';
  largeInListThreshold?: number;
  excessiveOrThreshold?: number;
}

export interface VelloxConfig {
  reportPath?: string;
  baselinePath?: string;
  ignore?: string[];
  rules?: Record<string, false | Severity | { enabled?: boolean; severity?: Severity }>;
  analysis: VelloxAnalysisConfig;
  budgets: VelloxBudgets;
}

export interface BudgetEvaluation {
  passed: boolean;
  evaluatedFindings: VelloxFinding[];
  violations: string[];
}
