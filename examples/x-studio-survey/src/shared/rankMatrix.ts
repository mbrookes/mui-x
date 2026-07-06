/**
 * Pure parsing/aggregation logic for the rank-heatmap custom widget, shared between the client
 * (`SurveyRankHeatmap.tsx`, for rendering) and the server (for summarizing a heatmap's exact
 * numbers into AI insight context) so the two never drift apart.
 */

export interface RankMatrix {
  categories: string[];
  rankCount: number;
  /** matrix[categoryIndex][rankIndex] = respondent count. */
  matrix: number[][];
  /** meanRanks[categoryIndex] = mean rank position (the sort key), aligned with `categories`. */
  meanRanks: number[];
  maxCount: number;
}

/**
 * Split a rank list on top-level commas only, so commas *inside* a parenthesised category
 * (e.g. "Excel like features (charting, pivoting, row grouping and aggregation)") don't
 * fracture that category into several.
 */
export function splitRankList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') {
      depth += 1;
      current += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function computeRankMatrix(rows: Record<string, unknown>[], field: string): RankMatrix {
  // category → per-rank counts (index 0 = rank 1)
  const counts = new Map<string, number[]>();
  let rankCount = 0;

  for (const row of rows) {
    const raw = row[field];
    if (raw == null || String(raw).trim() === '') {
      continue;
    }
    const items = splitRankList(String(raw));
    rankCount = Math.max(rankCount, items.length);
    items.forEach((category, rankIndex) => {
      let arr = counts.get(category);
      if (!arr) {
        arr = [];
        counts.set(category, arr);
      }
      arr[rankIndex] = (arr[rankIndex] ?? 0) + 1;
    });
  }

  // Order categories by their mean rank (most important first) so the heat reads
  // top-left → bottom-right.
  const meanRank = (category: string): number => {
    const arr = counts.get(category) ?? [];
    let weighted = 0;
    let total = 0;
    arr.forEach((count, rankIndex) => {
      if (count) {
        weighted += count * (rankIndex + 1);
        total += count;
      }
    });
    return total ? weighted / total : Number.POSITIVE_INFINITY;
  };
  const categories = [...counts.keys()].sort((a, b) => meanRank(a) - meanRank(b));
  const meanRanks = categories.map(meanRank);

  let maxCount = 0;
  const matrix = categories.map((category) => {
    const arr = counts.get(category) ?? [];
    const filled = Array.from({ length: rankCount }, (_, i) => arr[i] ?? 0);
    for (const c of filled) {
      if (c > maxCount) {
        maxCount = c;
      }
    }
    return filled;
  });

  return { categories, rankCount, matrix, meanRanks, maxCount };
}
