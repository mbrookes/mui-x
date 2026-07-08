import * as React from 'react';
import { Box, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from '@mui/material';
import { LineChart } from '@mui/x-charts/LineChart';
import { useXScale, useYScale } from '@mui/x-charts/hooks';
import { useStudioController, useStudioSelector, selectDataSources } from '@mui/x-studio';
import type {
  StudioCustomWidgetDef,
  StudioCustomWidgetProps,
  StudioCustomWidgetSetupPanelProps,
} from '@mui/x-studio';
import { useAppLocaleText } from '../locales/AppLocaleContext';
import { PIE_PALETTE } from '../theme';
import { computeYoyComparison } from '../shared/yoyComparison';
import { YOY_PAIRS } from '../config/yoyPairs';
import { SURVEY_2023_SOURCE_ID } from '../surveyData';
import { exportChartSvgToPng } from './chartSvgExport';

/** Width (px) reserved for the mirrored right-side percentage axis — shared between the `yAxis`
 * config and the end labels below, which must start past it rather than on top of its ticks. */
const RIGHT_AXIS_WIDTH = 44;
/** Minimum vertical gap (px) enforced between stacked end labels so tightly-clustered category
 * values don't overlap. */
const END_LABEL_MIN_GAP = 15;
const END_LABEL_GAP_X = 12;

/**
 * Direct labels at each line's 2025 endpoint, so the category can be identified without looking
 * up its color in the legend. Rendered as a `<LineChart>` child (per the x-charts composition
 * pattern — see `useXScale`/`useYScale`), which places it in the chart's unclipped overlay layer,
 * so labels are free to extend past the plot area into the right margin.
 *
 * Category values are frequently close together (e.g. several team-size bins clustering around
 * 10-12%), so labels are stacked top-to-bottom with a minimum gap rather than placed at their
 * exact (colliding) y position — per the dataviz guidance to avoid overlapping direct labels.
 */
function SlopeEndLabels({ categories, values }: { categories: string[]; values: number[] }) {
  const xScale = useXScale();
  const yScale = useYScale('left');

  const x = (xScale('2025' as never) as number) + RIGHT_AXIS_WIDTH + END_LABEL_GAP_X;
  const points = categories
    .map((category, i) => ({ category, y: yScale(values[i]) as number }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < points.length; i += 1) {
    points[i].y = Math.max(points[i].y, points[i - 1].y + END_LABEL_MIN_GAP);
  }

  return (
    <React.Fragment>
      {points.map((p) => (
        <text
          key={p.category}
          x={x}
          y={p.y}
          dominantBaseline="middle"
          style={{ fontSize: 11, fill: 'var(--mui-palette-text-secondary)' }}
        >
          {p.category}
        </text>
      ))}
    </React.Fragment>
  );
}

/**
 * Custom x-studio widget that renders a "slope chart": one line per answer category, running
 * from its 2023 share of respondents to its 2025 share. Chosen over a grouped bar chart because
 * there are only two waves (not a real time series) — a slope chart makes "moved up/down" legible
 * at a glance, which a two-column bar comparison doesn't.
 *
 * The 2025 data source is the widget's normal `dataSource` (via `widget.sourceId`, like every
 * other widget on this dashboard); the 2023 source has no dedicated widget elsewhere, so it's
 * looked up directly from `runtime.dataSources` by its known id (see `SURVEY_2023_SOURCE_ID`).
 */

interface YoyComparisonConfig {
  /** Which curated `YOY_PAIRS` entry to render. @default YOY_PAIRS[0].id */
  pairId?: string;
}

function SurveyYoyComparison({ widget, dataSource, exportRef }: StudioCustomWidgetProps) {
  const t = useAppLocaleText();
  const config = (widget.config.customConfig ?? {}) as YoyComparisonConfig;
  const pair = YOY_PAIRS.find((p) => p.id === config.pairId) ?? YOY_PAIRS[0];
  const containerRef = React.useRef<HTMLDivElement>(null);

  const dataSources = useStudioSelector(selectDataSources);
  const source2023 = dataSources[SURVEY_2023_SOURCE_ID];

  const result = React.useMemo(() => {
    if (!source2023?.rows || !dataSource?.rows) {
      return null;
    }
    return computeYoyComparison(source2023.rows, dataSource.rows, pair);
  }, [source2023?.rows, dataSource?.rows, pair]);

  // Registers the PNG export invoked by the widget card's toolbar Download action (see
  // `yoyComparisonWidgetDef.export` below). Runs unconditionally — before the `!result` early
  // return — since hooks can't be called conditionally; the guard just no-ops when there's
  // nothing to export yet.
  React.useEffect(() => {
    if (!exportRef) {
      return undefined;
    }
    exportRef.current =
      result && result.categories.length > 0
        ? () => {
            if (containerRef.current) {
              exportChartSvgToPng(containerRef.current, widget.title || 'yoy_comparison');
            }
          }
        : null;
    return () => {
      exportRef.current = null;
    };
  }, [exportRef, result, widget.title]);

  if (!result || result.categories.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {t.yoyNoData}
      </Typography>
    );
  }

  const { categories, pct2023, pct2025, n2023, n2025 } = result;

  const dataset = [
    {
      wave: '2023',
      ...Object.fromEntries(categories.map((category, i) => [category, pct2023[i]])),
    },
    {
      wave: '2025',
      ...Object.fromEntries(categories.map((category, i) => [category, pct2025[i]])),
    },
  ];

  // The right-side axis has no series bound to it (a series can only bind to one y-axis), so it
  // can't auto-derive its domain the way the left axis does. Both axes get this same explicit
  // [0, niceMax] domain instead, so the mirrored axis actually shows matching ticks rather than
  // an unlabeled line.
  const rawMax = Math.max(0, ...pct2023, ...pct2025);
  const niceMax = Math.max(10, Math.ceil(rawMax / 10) * 10);

  // Right margin fits the mirrored axis plus the longest category's end label, so labels never
  // get clipped by the widget card's edge.
  const longestCategory = Math.max(...categories.map((c) => c.length));
  const marginRight = RIGHT_AXIS_WIDTH + END_LABEL_GAP_X + Math.ceil(longestCategory * 6.5) + 12;

  return (
    <Box ref={containerRef} sx={{ width: '100%' }}>
      <LineChart
        dataset={dataset}
        xAxis={[{ dataKey: 'wave', scaleType: 'point', height: 28 }]}
        yAxis={[
          // Mirrored on both sides so the 2025 endpoint's value can be read directly, without
          // tracing each line back to the left edge.
          {
            id: 'left',
            width: RIGHT_AXIS_WIDTH,
            min: 0,
            max: niceMax,
            valueFormatter: (value: number) => `${value}%`,
          },
          {
            id: 'right',
            position: 'right',
            width: RIGHT_AXIS_WIDTH,
            min: 0,
            max: niceMax,
            valueFormatter: (value: number) => `${value}%`,
          },
        ]}
        series={categories.map((category, i) => ({
          dataKey: category,
          label: category,
          yAxisId: 'left',
          color: PIE_PALETTE[i % PIE_PALETTE.length],
          curve: 'linear',
          showMark: true,
          valueFormatter: (value: number | null) => (value == null ? '' : `${value.toFixed(1)}%`),
        }))}
        height={300}
        margin={{ left: 52, right: marginRight, top: 16, bottom: 32 }}
        grid={{ horizontal: true }}
      >
        <SlopeEndLabels categories={categories} values={pct2025} />
      </LineChart>
      <Stack spacing={0.25} sx={{ mt: 1 }}>
        {pair.caveat && (
          <Typography variant="caption" color="text.secondary">
            {pair.caveat}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          {t.yoyRespondentCount(n2023, n2025)}
        </Typography>
      </Stack>
    </Box>
  );
}

/** Compose-drawer setup panel: pick which curated `YOY_PAIRS` entry this widget shows. */
function YoyComparisonSetupPanel({ widgetId }: StudioCustomWidgetSetupPanelProps) {
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.doc.widgets[widgetId]);
  const t = useAppLocaleText();

  if (!widget) {
    return null;
  }

  const custom = (widget.config.customConfig ?? {}) as YoyComparisonConfig;
  const pairId = custom.pairId ?? YOY_PAIRS[0].id;

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2" color="text.secondary">
        {t.yoySettingsTitle}
      </Typography>
      <FormControl size="small" fullWidth>
        <InputLabel>{t.yoyQuestionLabel}</InputLabel>
        <Select
          value={pairId}
          label={t.yoyQuestionLabel}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              customConfig: { ...custom, pairId: event.target.value },
            })
          }
        >
          {YOY_PAIRS.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.title}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </Stack>
  );
}

export const yoyComparisonWidgetDef: StudioCustomWidgetDef = {
  kind: 'survey-yoy-comparison',
  label: 'Year-over-year comparison',
  description: '2023 vs 2025 slope chart for a shared survey question',
  component: SurveyYoyComparison,
  setupPanel: YoyComparisonSetupPanel,
  requiresDataSource: true,
  // Canvas-rasterized SVG export (see chartSvgExport.ts) — mirrors the built-in 'chart' widget
  // kind's PNG export, which isn't reusable directly since it's an internal (non-exported)
  // @mui/x-studio utility.
  export: 'png',
};
