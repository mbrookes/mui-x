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
  selectFilters,
  selectRelationships,
  useStudioLocaleText,
} from '../../context';
import { fieldHasCapability } from '../../utils/fieldCapabilities';
import type { StudioWidgetConfig } from '../../models';
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
  const filters = useStudioSelector(selectFilters);
  const widget = useStudioSelector(selectWidgets)[widgetId];

  // Auto-detected date filter field
  const sourceId = widget?.sourceId;
  const source = sourceId ? dataSources[sourceId] : undefined;
  const relationships = useStudioSelector(selectRelationships);

  // Collect date fields from primary source + all directly related sources
  const allDateFieldsWithJoined = React.useMemo<DataSourceFieldEntry[]>(() => {
    if (!source || !sourceId) {
      return [];
    }
    const result: DataSourceFieldEntry[] = [];
    const seen = new Set<string>();
    for (const f of source.fields) {
      if (fieldHasCapability(f, 'temporal')) {
        result.push({
          id: f.id,
          label: f.label,
          type: f.type,
          sourceId,
          sourceLabel: source.label,
        });
        seen.add(`${f.id}:${sourceId}`);
      }
    }
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
      for (const f of relSource.fields) {
        const key = `${f.id}:${relatedId}`;
        if (fieldHasCapability(f, 'temporal') && !seen.has(key)) {
          seen.add(key);
          result.push({
            id: f.id,
            label: f.label,
            type: f.type,
            sourceId: relatedId!,
            sourceLabel: relSource.label,
          });
        }
      }
    }
    return result;
  }, [source, sourceId, relationships, dataSources]);

  const autoDateFilter = React.useMemo(() => {
    if (!sourceId) {
      return null;
    }
    const relevant = filters.filter(
      (f) => f.scopeV2.kind === 'page' || f.scopeV2.kind === 'dashboard-date-range' || (f.scopeV2.kind === 'widget' && f.scopeV2.widgetId === widgetId),
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
          value={config.kpiSparklineGaugeMax ?? 100}
          onChange={(event) => {
            const n = Number(event.target.value);
            if (Number.isFinite(n) && n > 0) {
              controller.updateWidgetConfig(widgetId, { kpiSparklineGaugeMax: n });
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
