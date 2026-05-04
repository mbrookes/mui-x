'use client';
import * as React from 'react';
import {
  Box,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioSelector } from '../context';
import { fieldHasCapability } from '../utils/fieldCapabilities';
import { getReachableSourceIds } from '../internals/chartUtils';
import type { StudioKpiAggregation, StudioWidgetConfig } from '../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';

function KpiSparklineOptions(props: { widgetId: string; config: StudioWidgetConfig }) {
  const { widgetId, config } = props;
  const controller = useStudioController();
  const dataSources = useStudioSelector((state) => state.dataSources);
  const filters = useStudioSelector((state) => state.filters);
  const widget = useStudioSelector((state) => state.widgets[widgetId]);

  // Auto-detected date filter field
  const sourceId = widget?.sourceId;
  const source = sourceId ? dataSources[sourceId] : undefined;
  const relationships = useStudioSelector((state) => state.relationships);

  // Collect date fields from primary source + all directly related sources
  const allDateFieldsWithJoined = React.useMemo<DataSourceFieldEntry[]>(() => {
    if (!source || !sourceId) {
      return [];
    }
    const result: DataSourceFieldEntry[] = [];
    source.fields
      .filter((f) => fieldHasCapability(f, 'temporal'))
      .forEach((f) =>
        result.push({ id: f.id, label: f.label, type: f.type, sourceId, sourceLabel: source.label }),
      );
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
      relSource.fields
        .filter((f) => fieldHasCapability(f, 'temporal'))
        .forEach((f) => {
          if (!result.find((r) => r.id === f.id && r.sourceId === relatedId)) {
            result.push({
              id: f.id,
              label: f.label,
              type: f.type,
              sourceId: relatedId!,
              sourceLabel: relSource.label,
            });
          }
        });
    }
    return result;
  }, [source, sourceId, relationships, dataSources]);

  const autoDateFilter = React.useMemo(() => {
    if (!sourceId) {
      return null;
    }
    const relevant = filters.filter(
      (f) => f.scope === 'page' || (f.scope === 'widget' && f.widgetId === widgetId),
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

  // The composite value stored in the select: "sourceId:fieldId" (or just "fieldId" for primary)
  // — kept for reference but no longer used by the Select (now Autocomplete uses fieldId directly)

  const plotType = config.kpiSparklinePlotType ?? 'line';

  const GRANULARITIES: {
    value: NonNullable<StudioWidgetConfig['kpiSparklineGranularity']>;
    label: string;
  }[] = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
    { value: 'quarter', label: 'Quarter' },
    { value: 'year', label: 'Year' },
  ];

  return (
    <Stack spacing={2} sx={{ pl: 1, borderLeft: 2, borderColor: 'divider' }}>
      {autoDateFilter ? (
        <Typography variant="caption" color="text.secondary">
          Using date filter: <strong>{autoFieldLabel}</strong>
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
          label="Time field"
        />
      )}

      <FormControl size="small" fullWidth>
        <InputLabel>Granularity</InputLabel>
        <Select
          label="Granularity"
          value={config.kpiSparklineGranularity ?? ''}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              kpiSparklineGranularity:
                (event.target.value as StudioWidgetConfig['kpiSparklineGranularity']) || undefined,
            })
          }
        >
          <MenuItem value="">
            <em>Auto</em>
          </MenuItem>
          {GRANULARITIES.map((g) => (
            <MenuItem key={g.value} value={g.value}>
              {g.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>Plot type</InputLabel>
        <Select
          label="Plot type"
          value={plotType}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              kpiSparklinePlotType: event.target.value as 'line' | 'bar',
            })
          }
        >
          <MenuItem value="line">Line</MenuItem>
          <MenuItem value="bar">Bar</MenuItem>
        </Select>
      </FormControl>

      {plotType === 'line' && (
        <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
          control={
            <Switch
              size="small"
              checked={config.kpiSparklineArea ?? false}
              onChange={(event) =>
                controller.updateWidgetConfig(widgetId, {
                  kpiSparklineArea: event.target.checked,
                })
              }
            />
          }
          label="Fill area"
        />
      )}

      <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
        control={
          <Switch
            size="small"
            checked={config.kpiSparklineCumulative ?? false}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineCumulative: event.target.checked,
              })
            }
          />
        }
        label="Cumulative (running total)"
      />
    </Stack>
  );
}

export function KpiSetupPanel(props: { widgetId: string }) {
  const widget = useStudioSelector((state) => state.widgets[props.widgetId]);
  const controller = useStudioController();
  const dataSources = useStudioSelector((state) => state.dataSources);
  const expressionFields = useStudioSelector((state) => state.expressionFields);
  const relationships = useStudioSelector((state) => state.relationships);
  const config = widget?.config ?? {};

  // Gather fields from all data sources (used for the value field anchor picker)
  const allFields = React.useMemo(() => {
    const physicalFields = Object.values(dataSources)
      .filter((ds) => !ds.hidden)
      .flatMap((ds) =>
        ds.fields
          .filter((f) => !f.hidden)
          .map((f) => ({ ...f, sourceId: ds.id, sourceLabel: ds.label })),
      );
    const exprFields = expressionFields
      .filter((ef) => !ef.hidden)
      .map((ef) => {
        const ds = dataSources[ef.sourceId];
        return {
          id: ef.id,
          label: ef.label,
          description: ef.description,
          type: ef.type ?? ('number' as const),
          format: ef.format,
          currencyCode: ef.currencyCode,
          generated: true,
          sourceId: ef.sourceId,
          sourceLabel: ds?.label ?? ef.sourceId,
        };
      });
    return [...physicalFields, ...exprFields].sort((a, b) =>
      a.sourceLabel.localeCompare(b.sourceLabel),
    );
  }, [dataSources, expressionFields]);

  // Once the value field anchors a source, restrict subsequent pickers to reachable sources.
  const reachableFields = React.useMemo(() => {
    if (!widget?.sourceId) {
      return allFields;
    }
    const reachableIds = getReachableSourceIds(widget.sourceId, relationships);
    return allFields.filter((f) => reachableIds.has(f.sourceId));
  }, [allFields, widget?.sourceId, relationships]);

  const selectedField = reachableFields.find((f) => f.id === config.kpiValueField)
    ?? allFields.find((f) => f.id === config.kpiValueField);
  const selectedFieldType = selectedField?.type ?? null;

  // Aggregation options by type
  const AGGREGATIONS: Record<string, { value: StudioKpiAggregation; label: string }[]> = {
    number: [
      { value: 'sum', label: 'Sum' },
      { value: 'avg', label: 'Average' },
      { value: 'count', label: 'Count' },
      { value: 'min', label: 'Min' },
      { value: 'max', label: 'Max' },
    ],
    string: [{ value: 'count', label: 'Count' }],
    boolean: [{ value: 'count', label: 'Count' }],
    date: [
      { value: 'count', label: 'Count' },
      { value: 'min', label: 'Earliest' },
      { value: 'max', label: 'Latest' },
    ],
    datetime: [
      { value: 'count', label: 'Count' },
      { value: 'min', label: 'Earliest' },
      { value: 'max', label: 'Latest' },
    ],
  };
  const aggregationOptions = selectedFieldType
    ? AGGREGATIONS[selectedFieldType] || [{ value: 'count', label: 'Count' }]
    : AGGREGATIONS.number;
  const onlyOneAgg = aggregationOptions.length === 1;
  const selectedAgg = aggregationOptions.find((a) => a.value === config.kpiAggregation)
    ? config.kpiAggregation
    : aggregationOptions[0].value;

  const { widgetId } = props;

  return (
    <Stack spacing={2}>
      <DataSourceFieldSelect
        value={config.kpiValueField ?? ''}
        onChange={(fieldId, fSourceId) => {
          controller.updateWidgetConfig(widgetId, { kpiValueField: fieldId });
          if (fSourceId && fSourceId !== widget?.sourceId) {
            controller.updateWidget(widgetId, { sourceId: fSourceId });
          }
        }}
        fields={allFields}
        label="Value field"
        helperText="Field to aggregate"
      />

      <FormControl size="small" fullWidth disabled={onlyOneAgg}>
        <InputLabel>Aggregation</InputLabel>
        <Select
          label="Aggregation"
          value={selectedAgg}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              kpiAggregation: event.target.value as StudioKpiAggregation,
            })
          }
        >
          {aggregationOptions.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              {opt.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
        control={
          <Switch
            size="small"
            checked={config.kpiSparkline ?? false}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, { kpiSparkline: event.target.checked })
            }
          />
        }
        label="Sparkline"
      />

      {config.kpiSparkline && <KpiSparklineOptions widgetId={widgetId} config={config} />}

      <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
        control={
          <Switch
            size="small"
            checked={config.kpiTrend ?? false}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, { kpiTrend: event.target.checked })
            }
          />
        }
        label="Trend"
      />

      {config.kpiTrend && (
        <Stack spacing={1.5} sx={{ pl: 1 }}>
          <FormControl size="small" fullWidth>
            <InputLabel>Comparison period</InputLabel>
            <Select
              label="Comparison period"
              value={config.kpiTrendComparison ?? 'previous-period'}
              onChange={(event) =>
                controller.updateWidgetConfig(widgetId, {
                  kpiTrendComparison: event.target.value as
                    | 'previous-period'
                    | 'previous-calendar-period'
                    | 'year-over-year',
                })
              }
            >
              <MenuItem value="previous-period">Previous period (matching duration)</MenuItem>
              <MenuItem value="previous-calendar-period">Previous calendar period</MenuItem>
              <MenuItem value="year-over-year">Same period last year</MenuItem>
            </Select>
          </FormControl>
          <FormControlLabel
        slotProps={{ typography: { variant: 'body2' } }}
            control={
              <Switch
                size="small"
                checked={config.kpiTrendInvert ?? false}
                onChange={(event) =>
                  controller.updateWidgetConfig(widgetId, { kpiTrendInvert: event.target.checked })
                }
              />
            }
            label="Invert colours (lower is better)"
          />
        </Stack>
      )}
    </Stack>
  );
}
