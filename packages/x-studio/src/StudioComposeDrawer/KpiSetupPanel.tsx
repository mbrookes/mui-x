'use client';
import * as React from 'react';
import {
  Autocomplete,
  Box,
  FormControl,
  FormControlLabel,
  InputLabel,
  ListSubheader,
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
  const allDateFieldsWithJoined = React.useMemo(() => {
    if (!source || !sourceId) {
      return [];
    }
    const result: { id: string; label: string; sourceId: string; sourceLabel: string }[] = [];
    source.fields
      .filter((f) => fieldHasCapability(f, 'temporal'))
      .forEach((f) => result.push({ id: f.id, label: f.label, sourceId, sourceLabel: source.label }));
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
  let sparklineComposite = '';
  if (config.kpiSparklineField) {
    sparklineComposite =
      config.kpiSparklineSourceId && config.kpiSparklineSourceId !== sourceId
        ? `${config.kpiSparklineSourceId}:${config.kpiSparklineField}`
        : config.kpiSparklineField;
  }

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
        <FormControl size="small" fullWidth>
          <InputLabel>Time field</InputLabel>
          <Select
            label="Time field"
            value={sparklineComposite}
            onChange={(event) => {
              const val = event.target.value;
              if (!val) {
                controller.updateWidgetConfig(widgetId, {
                  kpiSparklineField: undefined,
                  kpiSparklineSourceId: undefined,
                });
                return;
              }
              const sepIdx = val.indexOf(':');
              const [fSourceId, fieldId] =
                sepIdx >= 0 ? [val.slice(0, sepIdx), val.slice(sepIdx + 1)] : [sourceId, val];
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineField: fieldId,
                kpiSparklineSourceId: fSourceId !== sourceId ? fSourceId : undefined,
              });
            }}
          >
            <MenuItem value="">
              <em>None</em>
            </MenuItem>
            {(() => {
              // Group by source label
              const groups = new Map<string, typeof allDateFieldsWithJoined>();
              for (const f of allDateFieldsWithJoined) {
                if (!groups.has(f.sourceLabel)) {
                  groups.set(f.sourceLabel, []);
                }
                groups.get(f.sourceLabel)!.push(f);
              }
              return Array.from(groups.entries()).flatMap(([srcLabel, fields]) => {
                const isSecondary = fields[0]?.sourceId !== sourceId;
                return [
                  isSecondary ? (
                    <ListSubheader key={`hdr-${srcLabel}`}>{srcLabel}</ListSubheader>
                  ) : null,
                  ...fields.map((f) => {
                    const compositeKey =
                      f.sourceId !== sourceId ? `${f.sourceId}:${f.id}` : f.id;
                    return (
                      <MenuItem key={compositeKey} value={compositeKey}>
                        {f.label}
                      </MenuItem>
                    );
                  }),
                ].filter(Boolean);
              });
            })()}
          </Select>
        </FormControl>
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
    return [...physicalFields, ...exprFields];
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
      <Autocomplete
        size="small"
        fullWidth
        options={allFields}
        groupBy={(option) => option.sourceLabel}
        getOptionLabel={(option) => option.label}
        value={allFields.find((f) => f.id === config.kpiValueField) || null}
        onChange={(_e, newValue) => {
          controller.updateWidgetConfig(widgetId, { kpiValueField: newValue?.id || '' });
          if (newValue?.sourceId && newValue.sourceId !== widget?.sourceId) {
            controller.updateWidget(widgetId, { sourceId: newValue.sourceId });
          }
        }}
        renderInput={(params) => <TextField {...params} label="Value field" helperText="Numeric field to aggregate" />}
        isOptionEqualToValue={(option, value) =>
          option.id === value.id && option.sourceId === value.sourceId
        }
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
