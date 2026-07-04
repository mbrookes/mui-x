import * as React from 'react';
import { Box, Stack, Switch, Typography } from '@mui/material';
import { useStudioController, useStudioSelector } from '@mui/x-studio';
import type {
  StudioCustomWidgetDef,
  StudioCustomWidgetProps,
  StudioCustomWidgetSetupPanelProps,
} from '@mui/x-studio';
import { useAppLocaleText } from '../locales/AppLocaleContext';

// Below this many rank columns the "most important / least important" end labels would collide,
// so they are suppressed regardless of the toggle.
const MIN_RANKS_FOR_IMPORTANCE_LABELS = 5;

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
  /** Show the respondent count inside each heat cell. @default true */
  showCellNumbers?: boolean;
  /** Show the mean-rank column between the labels and the heat cells. @default true */
  showMeanColumn?: boolean;
  /** Show the "most important / least important" axis labels. @default true */
  showImportanceLabels?: boolean;
  /** Show the colour-scale legend below the grid. @default true */
  showLegend?: boolean;
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

// Theme CSS variables (not `theme.palette.*`, which under a cssVariables theme is pinned to the
// light scheme) so the heat ramp tracks the active colour scheme in both light and dark mode.
const PRIMARY_VAR = 'var(--mui-palette-primary-main)';
const CONTRAST_VAR = 'var(--mui-palette-primary-contrastText)';
const SURFACE_VAR = 'var(--mui-palette-background-paper)';

function SurveyRankHeatmap({ widget, dataSource }: StudioCustomWidgetProps) {
  const t = useAppLocaleText();
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
        {t.heatmapNoData}
      </Typography>
    );
  }

  const { categories, rankCount, matrix, meanRanks, maxCount } = data;

  // Display toggles (all default on) — driven by the compose-panel switches.
  const showCellNumbers = config.showCellNumbers ?? true;
  const showMeanColumn = config.showMeanColumn ?? true;
  // Suppressed when there are too few rank columns for the end labels to fit without colliding.
  const showImportanceLabels =
    (config.showImportanceLabels ?? true) && rankCount >= MIN_RANKS_FOR_IMPORTANCE_LABELS;
  const showLegend = config.showLegend ?? true;

  // Grid columns: category label, an optional mean-rank column, then the heat cells.
  const gridTemplateColumns = showMeanColumn
    ? `minmax(280px, 2.4fr) minmax(36px, auto) repeat(${rankCount}, minmax(28px, 1fr))`
    : `minmax(280px, 2.4fr) repeat(${rankCount}, minmax(28px, 1fr))`;
  // Non-rank leading columns (label + optional mean) that the importance caption skips over.
  const leadingColumns = showMeanColumn ? 2 : 1;

  // Colour ramp: empty cells stay near the card surface, the most popular cell is solid primary.
  // Mixing primary into the card surface (rather than an alpha overlay) keeps the ramp legible on
  // whichever surface the active scheme uses.
  const cellColor = (count: number): string => {
    const pct = count <= 0 ? 4 : 12 + 88 * (count / maxCount);
    return `color-mix(in srgb, ${PRIMARY_VAR} ${pct}%, ${SURFACE_VAR})`;
  };

  return (
    <Box sx={{ width: '100%', overflowX: 'auto' }}>
      <Box
        sx={{
          display: 'grid',
          // The category column is wide enough to hold the long Q29 "Excel like features (…)"
          // label in (at most) two lines. Labels clamp to 2 lines; two lines fit within
          // the heat cells' min height, so every row stays the same height.
          gridTemplateColumns,
          gap: '2px',
          minWidth: 'min-content',
          fontSize: '0.65rem',
        }}
      >
        {/* Caption row: importance direction, spanning only the rank columns. */}
        {showImportanceLabels && (
          <React.Fragment>
            <Box sx={{ gridColumn: `span ${leadingColumns}` }} aria-hidden />
            <Box
              sx={{
                gridColumn: `span ${rankCount}`,
                display: 'flex',
                justifyContent: 'space-between',
                px: 0.25,
                pb: 0.25,
              }}
            >
              <Typography
                sx={{ fontSize: '0.6rem', color: 'text.secondary', whiteSpace: 'nowrap' }}
              >
                {t.heatmapMostImportant}
              </Typography>
              <Typography
                sx={{ fontSize: '0.6rem', color: 'text.secondary', whiteSpace: 'nowrap' }}
              >
                {t.heatmapLeastImportant}
              </Typography>
            </Box>
          </React.Fragment>
        )}

        {/* Column-label row: empty label corner + optional mean + rank numbers */}
        <Box aria-hidden />
        {showMeanColumn && (
          <Box sx={{ alignSelf: 'end', textAlign: 'center', pb: 0.5 }}>
            <Typography sx={{ fontSize: '0.6rem', fontWeight: 600, color: 'text.secondary' }}>
              {t.heatmapMean}
            </Typography>
          </Box>
        )}
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
            {showMeanColumn && (
              <Box
                title={t.heatmapMeanRankTooltip(meanRanks[catIndex].toFixed(2))}
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
            )}
            {matrix[catIndex].map((count, rankIndex) => (
              <Box
                key={`${category}-${rankIndex}`}
                title={t.heatmapCellTooltip(count, category, rankIndex + 1)}
                sx={{
                  backgroundColor: cellColor(count),
                  borderRadius: '2px',
                  minHeight: 26,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: count > 0 && count / maxCount > 0.55 ? CONTRAST_VAR : 'text.secondary',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {showCellNumbers && count > 0 ? count : ''}
              </Box>
            ))}
          </React.Fragment>
        ))}
      </Box>

      {/* Colour scale legend */}
      {showLegend && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 1,
            mt: 1,
            pr: 0.5,
          }}
        >
          <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary' }}>0</Typography>
          <Box
            sx={{
              flexGrow: 0,
              width: 120,
              height: 8,
              borderRadius: 1,
              background: `linear-gradient(to right, color-mix(in srgb, ${PRIMARY_VAR} 12%, ${SURFACE_VAR}), ${PRIMARY_VAR})`,
            }}
          />
          <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary' }}>{maxCount}</Typography>
        </Box>
      )}
    </Box>
  );
}

/** Compose-drawer setup panel: toggles for the heatmap's optional display elements. */
function RankHeatmapSetupPanel({ widgetId }: StudioCustomWidgetSetupPanelProps) {
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const t = useAppLocaleText();

  if (!widget) {
    return null;
  }

  const custom = (widget.config.customConfig ?? {}) as RankHeatmapConfig;
  const update = (changes: Partial<RankHeatmapConfig>) => {
    controller.updateWidgetConfig(widgetId, { customConfig: { ...custom, ...changes } });
  };

  const toggles: {
    label: string;
    key: 'showCellNumbers' | 'showMeanColumn' | 'showImportanceLabels' | 'showLegend';
  }[] = [
    { label: t.heatmapToggleCellNumbers, key: 'showCellNumbers' },
    { label: t.heatmapToggleMeanColumn, key: 'showMeanColumn' },
    { label: t.heatmapToggleImportanceLabels, key: 'showImportanceLabels' },
    { label: t.heatmapToggleLegend, key: 'showLegend' },
  ];

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2" color="text.secondary">
        {t.heatmapSettingsTitle}
      </Typography>
      {toggles.map((toggle) => (
        <Box
          key={toggle.key}
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Typography variant="body2">{toggle.label}</Typography>
          <Switch
            size="small"
            checked={custom[toggle.key] ?? true}
            onChange={(event) =>
              update({ [toggle.key]: event.target.checked } as Partial<RankHeatmapConfig>)
            }
          />
        </Box>
      ))}
    </Stack>
  );
}

export const rankHeatmapWidgetDef: StudioCustomWidgetDef = {
  kind: 'survey-rank-heatmap',
  label: 'Rank heatmap',
  description: 'Heatmap of how respondents ranked each category by position',
  component: SurveyRankHeatmap,
  setupPanel: RankHeatmapSetupPanel,
  requiresDataSource: true,
};
