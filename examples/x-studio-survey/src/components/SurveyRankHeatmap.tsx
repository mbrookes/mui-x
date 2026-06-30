import * as React from 'react';
import { Box, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import type { StudioCustomWidgetDef, StudioCustomWidgetProps } from '@mui/x-studio';

/**
 * Custom x-studio widget that visualises a *ranking* question as a heatmap.
 *
 * Each respondent's answer is a comma-separated list of categories in rank order
 * (position 1 = most important). The heatmap puts the categories on the Y axis and
 * the rank position (1st, 2nd, …) on the X axis; each cell's colour encodes how many
 * respondents placed that category at that rank.
 *
 * Built app-level from primitives (per the repo's "custom charts stay app-level" rule)
 * rather than the Pro `@mui/x-charts-pro` Heatmap, so the example needs no extra
 * dependency or licence key.
 */

interface RankHeatmapConfig {
  /** Field id whose cells hold the rank-ordered, comma-separated answer. */
  field?: string;
}

interface RankMatrix {
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
function splitRankList(value: string): string[] {
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

function computeRankMatrix(rows: Record<string, unknown>[], field: string): RankMatrix {
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

function SurveyRankHeatmap({ widget, dataSource }: StudioCustomWidgetProps) {
  const theme = useTheme();
  const config = (widget.config.customConfig ?? {}) as RankHeatmapConfig;
  const field = config.field;

  const data = React.useMemo<RankMatrix | null>(() => {
    if (!field || !dataSource?.rows) {
      return null;
    }
    return computeRankMatrix(dataSource.rows, field);
  }, [field, dataSource?.rows]);

  if (!data || data.categories.length === 0 || data.rankCount === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No ranking data available.
      </Typography>
    );
  }

  const { categories, rankCount, matrix, meanRanks, maxCount } = data;
  const base = theme.palette.primary.main;

  // Colour ramp: empty cells stay near-transparent, the most popular cell is solid.
  const cellColor = (count: number): string => {
    if (count <= 0) {
      return alpha(base, 0.04);
    }
    return alpha(base, 0.12 + 0.88 * (count / maxCount));
  };

  return (
    <Box sx={{ width: '100%', overflowX: 'auto' }}>
      <Box
        sx={{
          display: 'grid',
          // Category column wide enough to hold the long Q29 "Excel like features (…)"
          // label in (at most) two lines. Labels clamp to 2 lines; two lines fit within
          // the heat cells' min height, so every row stays the same height.
          gridTemplateColumns: `minmax(36px, auto) minmax(280px, 2.4fr) repeat(${rankCount}, minmax(28px, 1fr))`,
          gap: '2px',
          minWidth: 'min-content',
          fontSize: '0.65rem',
        }}
      >
        {/* Header row: mean-rank column + category corner + rank numbers */}
        <Box sx={{ alignSelf: 'end', textAlign: 'center', pb: 0.5 }}>
          <Typography sx={{ fontSize: '0.6rem', fontWeight: 600, color: 'text.secondary' }}>
            mean
          </Typography>
        </Box>
        <Box sx={{ alignSelf: 'end', px: 0.5, pb: 0.5 }}>
          <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary' }}>
            most important →
          </Typography>
        </Box>
        {Array.from({ length: rankCount }, (_, rankIndex) => (
          <Box
            key={`rank-${rankIndex}`}
            sx={{
              textAlign: 'center',
              pb: 0.5,
              fontWeight: 600,
              color: 'text.secondary',
              fontSize: '0.65rem',
            }}
          >
            {rankIndex + 1}
          </Box>
        ))}

        {/* One row per category */}
        {categories.map((category, catIndex) => (
          <React.Fragment key={category}>
            <Box
              title={`Mean rank ${meanRanks[catIndex].toFixed(2)}`}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'text.secondary',
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 600,
              }}
            >
              {meanRanks[catIndex].toFixed(1)}
            </Box>
            <Box
              title={category}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                pr: 0.75,
                color: 'text.primary',
              }}
            >
              <Box
                component="span"
                sx={{
                  textAlign: 'right',
                  lineHeight: 1.2,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}
              >
                {category}
              </Box>
            </Box>
            {matrix[catIndex].map((count, rankIndex) => (
              <Box
                key={`${category}-${rankIndex}`}
                title={`${count} respondent${count === 1 ? '' : 's'} ranked “${category}” #${rankIndex + 1}`}
                sx={{
                  backgroundColor: cellColor(count),
                  borderRadius: '2px',
                  minHeight: 26,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color:
                    count > 0 && count / maxCount > 0.55
                      ? theme.palette.primary.contrastText
                      : 'text.secondary',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {count > 0 ? count : ''}
              </Box>
            ))}
          </React.Fragment>
        ))}
      </Box>

      {/* Colour scale legend */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, pl: 0.5 }}>
        <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary' }}>fewer</Typography>
        <Box
          sx={{
            flexGrow: 0,
            width: 120,
            height: 8,
            borderRadius: 1,
            background: `linear-gradient(to right, ${alpha(base, 0.12)}, ${alpha(base, 1)})`,
          }}
        />
        <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary' }}>
          more ({maxCount})
        </Typography>
      </Box>
    </Box>
  );
}

export const rankHeatmapWidgetDef: StudioCustomWidgetDef = {
  kind: 'survey-rank-heatmap',
  label: 'Rank heatmap',
  description: 'Heatmap of how respondents ranked each category by position',
  component: SurveyRankHeatmap,
  requiresDataSource: true,
};
