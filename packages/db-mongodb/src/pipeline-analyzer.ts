export interface MongoPipelineFinding {
  id: string;
  stageIndex: number;
  stageName: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  explanation: string;
  suggestedFix: string;
}

export class MongoPipelineAnalyzer {
  /**
   * Performs static anti-pattern analysis on a MongoDB Aggregation Pipeline array.
   */
  public static analyzePipeline(pipeline: Array<Record<string, any>>): MongoPipelineFinding[] {
    const findings: MongoPipelineFinding[] = [];

    if (!Array.isArray(pipeline) || pipeline.length === 0) {
      return findings;
    }

    let hasSeenUnwind = false;
    let unwindIndex = -1;

    for (let i = 0; i < pipeline.length; i++) {
      const stage = pipeline[i]!;
      const stageName = Object.keys(stage)[0] || '';

      // 1. Anti-Pattern: $match after $unwind
      if (stageName === '$unwind') {
        hasSeenUnwind = true;
        unwindIndex = i;
      }

      if (stageName === '$match' && hasSeenUnwind) {
        findings.push({
          id: `unwind-before-match-${unwindIndex}-${i}`,
          stageIndex: i,
          stageName: '$match',
          severity: 'CRITICAL',
          title: 'Inefficient Pipeline: $match Placed After $unwind',
          explanation: `Placing '$unwind' at stage ${unwindIndex} before '$match' at stage ${i} multiplies documents in memory before filtering, causing massive CPU and RAM waste.`,
          suggestedFix: `Move '$match' before '$unwind' so only relevant documents are deconstructed.`
        });
      }

      // 2. Anti-Pattern: $sort without immediate $limit
      if (stageName === '$sort') {
        const nextStage = pipeline[i + 1];
        const nextStageName = nextStage ? Object.keys(nextStage)[0] : '';

        if (nextStageName !== '$limit') {
          findings.push({
            id: `sort-without-limit-${i}`,
            stageIndex: i,
            stageName: '$sort',
            severity: 'HIGH',
            title: 'Unbounded $sort Stage Without Early $limit',
            explanation: `Sorting full dataset without an immediate '$limit' stage risks exceeding MongoDB's 100MB RAM aggregation limit and forcing disk spill (allowDiskUse).`,
            suggestedFix: `Add a '$limit' stage immediately after '$sort' or ensure an index satisfies the sort order.`
          });
        }
      }

      // 3. Anti-Pattern: $lookup without pipeline/index guidance
      if (stageName === '$lookup') {
        const lookupConfig = stage['$lookup'];
        if (lookupConfig && typeof lookupConfig === 'object') {
          const fromCol = lookupConfig.from || 'foreign_collection';
          const foreignField = lookupConfig.foreignField || 'field';

          findings.push({
            id: `lookup-index-check-${i}`,
            stageIndex: i,
            stageName: '$lookup',
            severity: 'MEDIUM',
            title: `Ensure Index on $lookup Target: ${fromCol}.${foreignField}`,
            explanation: `MongoDB joins perform collection scans on '${fromCol}' unless an index covers '${foreignField}'.`,
            suggestedFix: `db.${fromCol}.createIndex({ ${foreignField}: 1 });`
          });
        }
      }
    }

    return findings;
  }
}
