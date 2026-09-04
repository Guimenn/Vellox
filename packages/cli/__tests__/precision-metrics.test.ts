import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSqlSyntax, SqlAnalysisOptions } from '../src/sql-analysis.js';
import { scanJavaScriptStructure, scanPythonStructure } from '../src/structural-code.js';

interface CorpusCase {
  name: string;
  language: 'sql' | 'javascript' | 'python';
  source: string;
  expected: string[];
  options?: SqlAnalysisOptions;
}

interface Corpus {
  version: string;
  evaluatedRules: string[];
  cases: CorpusCase[];
}

const corpus = JSON.parse(fs.readFileSync(path.resolve('packages/cli/corpus/precision-v1.json'), 'utf8')) as Corpus;

describe(`versioned precision corpus ${corpus.version}`, () => {
  it('measures aggregate precision and recall for fully labelled rules', () => {
    const evaluated = new Set(corpus.evaluatedRules);
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    const failures: string[] = [];

    for (const sample of corpus.cases) {
      const findings = sample.language === 'sql'
        ? analyzeSqlSyntax(sample.source, sample.options).findings
        : sample.language === 'javascript'
          ? scanJavaScriptStructure(sample.source, 'corpus.ts').findings
          : scanPythonStructure(sample.source, 'corpus.py').findings;
      const actual = new Set(findings.map(finding => finding.ruleId).filter(rule => evaluated.has(rule)));
      const expected = new Set(sample.expected);
      for (const rule of actual) expected.has(rule) ? truePositive += 1 : falsePositive += 1;
      for (const rule of expected) if (!actual.has(rule)) falseNegative += 1;
      if ([...actual].sort().join('|') !== [...expected].sort().join('|')) {
        failures.push(`${sample.name}: expected ${[...expected].join(', ') || 'none'}, got ${[...actual].join(', ') || 'none'}`);
      }
    }

    const precision = truePositive / Math.max(1, truePositive + falsePositive);
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    expect(failures, failures.join('\n')).toEqual([]);
    expect({ cases: corpus.cases.length, truePositive, falsePositive, falseNegative, precision, recall }).toMatchObject({
      cases: 22,
      falsePositive: 0,
      falseNegative: 0,
      precision: 1,
      recall: 1
    });
  });
});
