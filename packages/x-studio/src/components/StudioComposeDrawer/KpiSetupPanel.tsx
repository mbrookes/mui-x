'use client';
import * as React from 'react';
import {
  Box,
  Button,
  Collapse,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FunctionsIcon from '@mui/icons-material/Functions';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectFilters,
  selectRelationships,
  selectExpressionFields,
  useStudioLocaleText,
} from '../../context';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { fieldHasCapability } from '../../utils/fieldCapabilities';
import { getReachableSourceIds } from '../../internals/chartUtils';
import type { StudioKpiAggregation, StudioWidgetConfig, StudioCrossFilterMode } from '../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';
import { SetupSection } from './SetupSection';
import { MetricRefInput } from '../StudioFiltersDrawer/MetricRefInput';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';

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
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
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
          cursor: 'default',
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
        <Box onClick={(evt) => evt.stopPropagation()}>
          <Switch
            size="small"
            checked={enabled}
            onChange={(evt) => handleSwitch(evt.target.checked)}
          />
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
  const isGauge = plotType === 'gauge';

  return (
    <React.Fragment>
      {!isGauge &&
        (autoDateFilter ? (
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
              <em>Auto</em>
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
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            size="small"
            label={localeText.kpiSetupMinLabel}
            type="number"
            value={config.kpiSparklineGaugeMin ?? 0}
            onChange={(event) => {
              const n = Number(event.target.value);
              if (Number.isFinite(n)) {
                controller.updateWidgetConfig(widgetId, { kpiSparklineGaugeMin: n });
              }
            }}
            sx={{ flex: 1 }}
          />
          <TextField
            size="small"
            label={localeText.kpiSetupMaxLabel}
            type="number"
            value={config.kpiSparklineGaugeMax ?? 100}
            onChange={(event) => {
              const n = Number(event.target.value);
              if (Number.isFinite(n)) {
                controller.updateWidgetConfig(widgetId, { kpiSparklineGaugeMax: n });
              }
            }}
            sx={{ flex: 1 }}
          />
        </Box>
      )}

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

      {!isGauge && (
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
      )}
    </React.Fragment>
  );
}

function getKpiAggregations(localeText: ReturnType<typeof useStudioLocaleText>) {
  return {
    number: [
      { value: 'sum', label: localeText.aggFnSum },
      { value: 'avg', label: localeText.aggFnAverage },
      { value: 'count', label: localeText.aggFnCount },
      { value: 'min', label: localeText.aggFnMin },
      { value: 'max', label: localeText.aggFnMax },
    ],
    string: [{ value: 'count', label: localeText.aggFnCount }],
    boolean: [{ value: 'count', label: localeText.aggFnCount }],
    date: [
      { value: 'count', label: localeText.aggFnCount },
      { value: 'min', label: 'Earliest' },
      { value: 'max', label: 'Latest' },
    ],
    datetime: [
      { value: 'count', label: localeText.aggFnCount },
      { value: 'min', label: 'Earliest' },
      { value: 'max', label: 'Latest' },
    ],
  } satisfies Record<string, { value: StudioKpiAggregation; label: string }[]>;
}

export function KpiSetupPanel(props: { widgetId: string }) {
  const widget = useStudioSelector(selectWidgets)[props.widgetId];
  const controller = useStudioController();
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const relationships = useStudioSelector(selectRelationships);
  const config = widget?.config ?? {};
  const aggregations = getKpiAggregations(localeText);

  // Gather fields from all data sources (used for the value field anchor picker)
  const allFields = React.useMemo(() => {
    const physicalFields = Object.values(dataSources).flatMap((ds) => {
      if (ds.hidden) {
        return [];
      }
      return ds.fields.flatMap((f) =>
        f.hidden ? [] : [{ ...f, sourceId: ds.id, sourceLabel: ds.label }],
      );
    });
    const exprFields = expressionFields.flatMap((ef) => {
      if (ef.hidden) {
        return [];
      }
      const ds = dataSources[ef.sourceId];
      return [
        {
          id: ef.id,
          label: ef.label,
          description: ef.description,
          type: ef.type ?? ('number' as const),
          format: ef.format,
          precision: ef.precision,
          currencyCode: ef.currencyCode,
          generated: true,
          sourceId: ef.sourceId,
          sourceLabel: ds?.label ?? ef.sourceId,
        },
      ];
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

  const aggregationOptions = selectedFieldType
    ? aggregations[selectedFieldType] || [{ value: 'count', label: localeText.aggFnCount }]
    : aggregations.number;
  const onlyOneAgg = aggregationOptions.length === 1;
  const selectedAgg = aggregationOptions.find((a) => a.value === config.kpiAggregation)
    ? config.kpiAggregation
    : aggregationOptions[0].value;

  const { widgetId } = props;

  const [calcDialogOpen, setCalcDialogOpen] = React.useState(false);
  const widgetSource = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  const showCalcFieldButton =
    widgetSource !== undefined &&
    features.calculatedFields !== false &&
    features.kpiCalculatedFields !== false;

  return (
    <React.Fragment>
      <Stack spacing={2}>
        <DataSourceFieldSelect
          value={config.kpiValueField ?? ''}
          onChange={(fieldId, fSourceId) => {
            const newField = allFields.find((f) => f.id === fieldId && f.sourceId === fSourceId);
            const newFieldType = newField?.type ?? null;
            const newAggOptions = newFieldType
              ? (aggregations[newFieldType] ?? [
                  { value: 'count' as StudioKpiAggregation, label: localeText.aggFnCount },
                ])
              : aggregations.number;
            const currentAggValid = newAggOptions.some((a) => a.value === config.kpiAggregation);
            const configUpdate: Partial<import('../../models').StudioWidgetConfig> = {
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
          label={localeText.kpiSetupValueFieldLabel}
          helperText={localeText.kpiSetupValueFieldHelperText}
        />

        {/* Calculated field button — opens full expression dialog for new measure fields */}
        {showCalcFieldButton && (
          <Button
            size="small"
            variant="text"
            startIcon={<FunctionsIcon fontSize="small" />}
            onClick={() => setCalcDialogOpen(true)}
            sx={{
              fontSize: '0.75rem',
              textTransform: 'none',
              alignSelf: 'flex-start',
              color: 'text.secondary',
            }}
          >
            Calculated field…
          </Button>
        )}

        <FormControl size="small" fullWidth disabled={onlyOneAgg}>
          <InputLabel>{localeText.chartSetupAggregationLabel}</InputLabel>
          <Select
            label={localeText.chartSetupAggregationLabel}
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

        {features.kpiSparkline !== false && (
          <CollapsibleFeatureSection
            label={localeText.kpiSetupSparklineLabel}
            enabled={config.kpiSparkline ?? false}
            onToggle={(next) => controller.updateWidgetConfig(widgetId, { kpiSparkline: next })}
          >
            <KpiSparklineOptions widgetId={widgetId} config={config} />
          </CollapsibleFeatureSection>
        )}

        {features.kpiTarget !== false && (
          <CollapsibleFeatureSection
            label={localeText.kpiSetupTargetLabel}
            enabled={config.kpiTarget ?? false}
            onToggle={(next) => controller.updateWidgetConfig(widgetId, { kpiTarget: next })}
          >
            <Typography variant="caption" color="text.secondary">
              Reference value for the target line on the sparkline. When Trend is also enabled, the
              delta badge compares the current value against this target.
            </Typography>
            <MetricRefInput
              value={config.kpiTargetRef}
              onChange={(ref) => controller.updateWidgetConfig(widgetId, { kpiTargetRef: ref })}
            />
          </CollapsibleFeatureSection>
        )}

        {features.kpiTrend !== false && (
          <CollapsibleFeatureSection
            label={localeText.kpiSetupTrendLabel}
            enabled={config.kpiTrend ?? false}
            onToggle={(next) => controller.updateWidgetConfig(widgetId, { kpiTrend: next })}
          >
            <FormControl size="small" fullWidth>
              <InputLabel>{localeText.kpiSetupCompPeriodLabel}</InputLabel>
              <Select
                label={localeText.kpiSetupCompPeriodLabel}
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
                <MenuItem value="previous-period">{localeText.kpiSetupCompPrevPeriod}</MenuItem>
                <MenuItem value="previous-calendar-period">
                  {localeText.kpiSetupCompPrevCalendarPeriod}
                </MenuItem>
                <MenuItem value="year-over-year">{localeText.kpiSetupCompSameLastYear}</MenuItem>
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
        )}

        {/* Interactions — cross-filter mode. KPIs are summary metrics with no visual row
        representation, so "cross-highlight" (dim non-matching rows) does not apply.
        Only "Filter" (re-aggregate over the selection) and "None" (grand total) make sense. */}
        <SetupSection
          title={localeText.kpiSetupInteractionsTitle}
          description={localeText.kpiSetupInteractionsDescription}
        >
          <ToggleButtonGroup
            value={
              ((config.crossFilterMode === 'cross-highlight'
                ? 'cross-filter'
                : config.crossFilterMode) ?? 'none') as StudioCrossFilterMode
            }
            exclusive
            onChange={(_e, value: StudioCrossFilterMode | null) => {
              controller.updateWidgetConfig(widgetId, {
                crossFilterMode: value ?? 'none',
              });
            }}
            size="small"
            fullWidth
          >
            <ToggleButton value="cross-filter" sx={{ fontSize: 11, textTransform: 'none' }}>
              Filter
            </ToggleButton>
            <ToggleButton value="none" sx={{ fontSize: 11, textTransform: 'none' }}>
              None
            </ToggleButton>
          </ToggleButtonGroup>
        </SetupSection>
      </Stack>

      {/* Calculated field dialog */}
      {widgetSource && (
        <StudioExpressionFieldDialog
          key={calcDialogOpen ? 'open' : 'closed'}
          open={calcDialogOpen}
          onClose={() => setCalcDialogOpen(false)}
          dataSource={widgetSource}
          expressionFields={expressionFields}
          onSaved={(fieldId) => {
            controller.updateWidgetConfig(widgetId, { kpiValueField: fieldId });
          }}
        />
      )}
    </React.Fragment>
  );
}
