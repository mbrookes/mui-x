'use client';
import * as React from 'react';
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectExpressionFields,
  selectFilters,
  selectRelationships,
  useStudioLocaleText,
} from '../../context';
import { fieldHasCapability } from '../../utils/fieldCapabilities';
import { buildSourceFieldEntries } from '../../internals/fieldCatalog';
import type { StudioDataSource, StudioWidgetConfig } from '../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';

function getKpiGranularities(localeText: ReturnType<typeof useStudioLocaleText>) {
  return [
    { value: 'day', label: localeText.timeGranDay },
    { value: 'week', label: localeText.timeGranWeek },
    { value: 'month', label: localeText.timeGranMonth },
    { value: 'quarter', label: localeText.timeGranQuarter },
    { value: 'year', label: localeText.timeGranYear },
  ] satisfies {
    value: NonNullable<StudioWidgetConfig['kpiSparklineGranularity']>;
    label: string;
  }[];
}

export function KpiSparklineOptions(props: { widgetId: string; config: StudioWidgetConfig }) {
  const { widgetId, config } = props;
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  const granularities = getKpiGranularities(localeText);
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const filters = useStudioSelector(selectFilters);
  const widget = useStudioSelector(selectWidgets)[widgetId];

  // Auto-detected date filter field
  const sourceId = widget?.sourceId;
  const source = sourceId ? dataSources[sourceId] : undefined;
  const relationships = useStudioSelector(selectRelationships);

  // Collect date fields from primary source + all directly related sources.
  // Built on the shared `buildSourceFieldEntries` catalog helper (architecture
  // review finding 2.8) instead of hand-rolling the id/label/type/sourceId/
  // sourceLabel shape per source, as `ChartSetupPanel`/`KpiSetupPanel` already do.
  const allDateFieldsWithJoined = React.useMemo<DataSourceFieldEntry[]>(() => {
    if (!source || !sourceId) {
      return [];
    }
    const result: DataSourceFieldEntry[] = [];
    const seen = new Set<string>();
    const addSourceDateFields = (src: StudioDataSource) => {
      for (const entry of buildSourceFieldEntries(src, expressionFields, { expression: 'none' })) {
        const key = `${entry.id}:${entry.sourceId}`;
        if (fieldHasCapability(entry, 'temporal') && !seen.has(key)) {
          seen.add(key);
          result.push(entry);
        }
      }
    };
    addSourceDateFields(source);
    for (const rel of relationships) {
      let relatedId: string | null = null;
      if (rel.sourceId === sourceId) {
        relatedId = rel.targetId;
      } else if (rel.targetId === sourceId) {
        relatedId = rel.sourceId;
      }
      if (!relatedId) {
        continue;
      }
      const relSource = dataSources[relatedId];
      if (!relSource) {
        continue;
      }
      addSourceDateFields(relSource);
    }
    return result;
  }, [source, sourceId, relationships, dataSources, expressionFields]);

  const autoDateFilter = React.useMemo(() => {
    if (!sourceId) {
      return null;
    }
    const relevant = filters.filter(
      (f) =>
        f.scope.kind === 'page' ||
        f.scope.kind === 'dashboard-date-range' ||
        (f.scope.kind === 'widget' && f.scope.widgetId === widgetId),
    );
    return (
      relevant.find((f) => {
        return allDateFieldsWithJoined.some(
          (df) => df.id === f.field && (!f.filterSourceId || f.filterSourceId === df.sourceId),
        );
      }) ?? null
    );
  }, [filters, sourceId, widgetId, allDateFieldsWithJoined]);

  const autoFieldLabel = autoDateFilter
    ? allDateFieldsWithJoined.find((f) => f.id === autoDateFilter.field)?.label
    : null;

  const plotType = config.kpiSparklinePlotType ?? 'line';
  const isGauge = plotType === 'gauge';

  const gaugeMax = config.kpiSparklineGaugeMax ?? 100;

  // Local text buffer for the gauge-max input (architecture review finding 1.14):
  // rejecting anything not `> 0` on every keystroke made the field impossible to
  // clear and retype. Buffer the displayed text locally and only parse/validate/
  // commit on blur, mirroring `FormatPanel.tsx`'s grid-height input.
  const [gaugeMaxText, setGaugeMaxText] = React.useState(String(gaugeMax));
  const [gaugeMaxDirty, setGaugeMaxDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed gaugeMax; resync on external change (widget switch, undo/redo)
  React.useEffect(() => {
    setGaugeMaxText(String(gaugeMax));
    setGaugeMaxDirty(false);
  }, [gaugeMax, widgetId]);

  const commitGaugeMax = () => {
    if (!gaugeMaxDirty) {
      return;
    }
    const parsed = Number(gaugeMaxText);
    const valid = Number.isFinite(parsed) && parsed > 0;
    if (valid && parsed !== gaugeMax) {
      controller.updateWidgetConfig(widgetId, { kpiSparklineGaugeMax: parsed });
    }
    setGaugeMaxText(String(valid ? parsed : gaugeMax));
    setGaugeMaxDirty(false);
  };

  return (
    <React.Fragment>
      {!isGauge &&
        (autoDateFilter ? (
          <Typography variant="caption" color="text.secondary">
            {localeText.kpiSetupAutoDateFilterPrefix} <strong>{autoFieldLabel}</strong>
          </Typography>
        ) : (
          <DataSourceFieldSelect
            value={config.kpiSparklineField ?? ''}
            onChange={(fieldId, fSourceId) => {
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineField: fieldId || undefined,
                kpiSparklineSourceId: fieldId && fSourceId !== sourceId ? fSourceId : undefined,
              });
            }}
            fields={allDateFieldsWithJoined}
            label={localeText.kpiSetupTimeFieldLabel}
          />
        ))}

      {!isGauge && (
        <FormControl size="small" fullWidth>
          <InputLabel>{localeText.kpiSetupGranularityLabel}</InputLabel>
          <Select
            label={localeText.kpiSetupGranularityLabel}
            value={config.kpiSparklineGranularity ?? ''}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineGranularity:
                  (event.target.value as StudioWidgetConfig['kpiSparklineGranularity']) ||
                  undefined,
              })
            }
          >
            <MenuItem value="">
              <em>{localeText.kpiGranularityAutoLabel}</em>
            </MenuItem>
            {granularities.map((g) => (
              <MenuItem key={g.value} value={g.value}>
                {g.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      <FormControl size="small" fullWidth>
        <InputLabel>{localeText.kpiSetupPlotTypeLabel}</InputLabel>
        <Select
          label={localeText.kpiSetupPlotTypeLabel}
          value={plotType}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              kpiSparklinePlotType: event.target.value as 'line' | 'bar' | 'gauge',
            })
          }
        >
          <MenuItem value="line">{localeText.kpiSetupChartLine}</MenuItem>
          <MenuItem value="bar">{localeText.kpiSetupChartBar}</MenuItem>
          <MenuItem value="gauge">{localeText.kpiSetupChartGauge}</MenuItem>
        </Select>
      </FormControl>

      {plotType === 'gauge' && (
        <TextField
          size="small"
          label={localeText.kpiSetupGaugeMaxLabel}
          type="number"
          value={gaugeMaxText}
          onChange={(event) => {
            setGaugeMaxText(event.target.value);
            setGaugeMaxDirty(true);
          }}
          onBlur={commitGaugeMax}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitGaugeMax();
            }
          }}
          fullWidth
        />
      )}

      {plotType === 'line' && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="body2">{localeText.kpiSetupFillAreaLabel}</Typography>
          <Switch
            size="small"
            checked={config.kpiSparklineArea ?? false}
            slotProps={{ input: { 'aria-label': localeText.kpiSetupFillAreaLabel } }}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineArea: event.target.checked,
              })
            }
          />
        </Box>
      )}

      {!isGauge && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="body2">{localeText.kpiSetupCumulativeLabel}</Typography>
          <Switch
            size="small"
            checked={config.kpiSparklineCumulative ?? false}
            slotProps={{ input: { 'aria-label': localeText.kpiSetupCumulativeLabel } }}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineCumulative: event.target.checked,
              })
            }
          />
        </Box>
      )}
    </React.Fragment>
  );
}
