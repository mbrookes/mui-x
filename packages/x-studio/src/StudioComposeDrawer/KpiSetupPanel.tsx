'use client';
import * as React from 'react';
import {
  Box,
  Collapse,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectFilters,
  selectRelationships,
  selectExpressionFields,
} from '../context';
import { fieldHasCapability } from '../utils/fieldCapabilities';
import { getReachableSourceIds } from '../internals/chartUtils';
import type { StudioKpiAggregation, StudioWidgetConfig } from '../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';

/**
 * A collapsible section with a labeled header row containing a switch toggle on the
 * right and an expand/collapse chevron on the left.  The switch turning ON also
 * expands the panel; turning OFF collapses it.  The chevron (and header row) toggle
 * expanded state independently when the switch is already on.
 */
function CollapsibleFeatureSection({
  label,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = React.useState(false);

  const handleSwitch = (next: boolean) => {
    onToggle(next);
    if (next) {
      setExpanded(true);
    } else {
      setExpanded(false);
    }
  };

  const handleHeaderClick = () => {
    setExpanded((prev) => !prev);
  };

  const isOpen = expanded;
  const Chevron = isOpen ? ExpandMoreIcon : ChevronRightIcon;

  return (
    <Box
      sx={{
        bgcolor: 'action.hover',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <Box
        onClick={handleHeaderClick}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <Chevron
          sx={{
            fontSize: 18,
            color: 'text.secondary',
            flexShrink: 0,
          }}
        />
        <Typography
          variant="body2"
          sx={{ flexGrow: 1, color: enabled ? 'text.primary' : 'text.disabled' }}
        >
          {label}
        </Typography>
        {/* Stop click from toggling expand when clicking the switch */}
        <Box onClick={(e) => e.stopPropagation()}>
          <Switch size="small" checked={enabled} onChange={(e) => handleSwitch(e.target.checked)} />
        </Box>
      </Box>

      {/* Collapsible content */}
      <Collapse in={isOpen}>
        <Stack
          spacing={1.5}
          sx={{
            px: 1.5,
            pb: 1.5,
            opacity: enabled ? 1 : 0.45,
            pointerEvents: enabled ? 'auto' : 'none',
          }}
        >
          {children}
        </Stack>
      </Collapse>
    </Box>
  );
}

function KpiSparklineOptions(props: { widgetId: string; config: StudioWidgetConfig }) {
  const { widgetId, config } = props;
  const controller = useStudioController();
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
    <>
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
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="body2">Fill area</Typography>
          <Switch
            size="small"
            checked={config.kpiSparklineArea ?? false}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, {
                kpiSparklineArea: event.target.checked,
              })
            }
          />
        </Box>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="body2">Cumulative (running total)</Typography>
        <Switch
          size="small"
          checked={config.kpiSparklineCumulative ?? false}
          onChange={(event) =>
            controller.updateWidgetConfig(widgetId, {
              kpiSparklineCumulative: event.target.checked,
            })
          }
        />
      </Box>
    </>
  );
}

export function KpiSetupPanel(props: { widgetId: string }) {
  const widget = useStudioSelector(selectWidgets)[props.widgetId];
  const controller = useStudioController();
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const relationships = useStudioSelector(selectRelationships);
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

  const selectedField =
    reachableFields.find((f) => f.id === config.kpiValueField) ??
    allFields.find((f) => f.id === config.kpiValueField);
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
          const newField = allFields.find((f) => f.id === fieldId && f.sourceId === fSourceId);
          const newFieldType = newField?.type ?? null;
          const newAggOptions = newFieldType
            ? (AGGREGATIONS[newFieldType] ?? [
                { value: 'count' as StudioKpiAggregation, label: 'Count' },
              ])
            : AGGREGATIONS.number;
          const currentAggValid = newAggOptions.some((a) => a.value === config.kpiAggregation);
          const configUpdate: Partial<import('../models').StudioWidgetConfig> = {
            kpiValueField: fieldId,
            // Reset aggregation when the current one isn't valid for the new field type
            ...(!currentAggValid && { kpiAggregation: newAggOptions[0].value }),
          };
          controller.updateWidgetConfig(widgetId, configUpdate);
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

      <CollapsibleFeatureSection
        label="Sparkline"
        enabled={config.kpiSparkline ?? false}
        onToggle={(next) => controller.updateWidgetConfig(widgetId, { kpiSparkline: next })}
      >
        <KpiSparklineOptions widgetId={widgetId} config={config} />
      </CollapsibleFeatureSection>

      <CollapsibleFeatureSection
        label="Trend"
        enabled={config.kpiTrend ?? false}
        onToggle={(next) => controller.updateWidgetConfig(widgetId, { kpiTrend: next })}
      >
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
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="body2">Invert colours (lower is better)</Typography>
          <Switch
            size="small"
            checked={config.kpiTrendInvert ?? false}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, { kpiTrendInvert: event.target.checked })
            }
          />
        </Box>
      </CollapsibleFeatureSection>
    </Stack>
  );
}
