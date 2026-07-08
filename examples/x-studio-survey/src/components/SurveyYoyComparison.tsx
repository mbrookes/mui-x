import * as React from 'react';
import { Box, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from '@mui/material';
import { LineChart } from '@mui/x-charts/LineChart';
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

function SurveyYoyComparison({ widget, dataSource }: StudioCustomWidgetProps) {
  const t = useAppLocaleText();
  const config = (widget.config.customConfig ?? {}) as YoyComparisonConfig;
  const pair = YOY_PAIRS.find((p) => p.id === config.pairId) ?? YOY_PAIRS[0];

  const dataSources = useStudioSelector(selectDataSources);
  const source2023 = dataSources[SURVEY_2023_SOURCE_ID];

  const result = React.useMemo(() => {
    if (!source2023?.rows || !dataSource?.rows) {
      return null;
    }
    return computeYoyComparison(source2023.rows, dataSource.rows, pair);
  }, [source2023?.rows, dataSource?.rows, pair]);

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

  return (
    <Box sx={{ width: '100%' }}>
      <LineChart
        dataset={dataset}
        xAxis={[{ dataKey: 'wave', scaleType: 'point', height: 28 }]}
        yAxis={[{ width: 44, valueFormatter: (value: number) => `${value}%` }]}
        series={categories.map((category, i) => ({
          dataKey: category,
          label: category,
          color: PIE_PALETTE[i % PIE_PALETTE.length],
          curve: 'linear',
          showMark: true,
          valueFormatter: (value: number | null) => (value == null ? '' : `${value.toFixed(1)}%`),
        }))}
        height={300}
        margin={{ left: 52, right: 16, top: 16, bottom: 32 }}
        grid={{ horizontal: true }}
      />
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
};
