'use client';
import * as React from 'react';
import {
  Box,
  Button,
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
import FunctionsIcon from '@mui/icons-material/Functions';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectExpressionFields,
  useStudioLocaleText,
} from '../../context';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { getReachableSourceIds } from '../../internals/chartUtils';
import type { StudioKpiAggregation, StudioWidgetConfig, StudioCrossFilterMode } from '../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from './DataSourceFieldSelect';
import { SetupSection } from './SetupSection';
import { MetricRefInput } from '../StudioFiltersDrawer/MetricRefInput';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';
import { CollapsibleFeatureSection } from './CollapsibleFeatureSection';
import { KpiSparklineOptions } from './KpiSparklineOptions';

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
      { value: 'min', label: localeText.kpiSetupDateAggEarliest },
      { value: 'max', label: localeText.kpiSetupDateAggLatest },
    ],
    datetime: [
      { value: 'count', label: localeText.aggFnCount },
      { value: 'min', label: localeText.kpiSetupDateAggEarliest },
      { value: 'max', label: localeText.kpiSetupDateAggLatest },
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
            {localeText.kpiSetupCalculatedField}
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
              {localeText.kpiSetupTargetHelperText}
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
              <Typography variant="body2">{localeText.kpiSetupInvertColours}</Typography>
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
              {localeText.crossFilterModeFilter}
            </ToggleButton>
            <ToggleButton value="none" sx={{ fontSize: 11, textTransform: 'none' }}>
              {localeText.crossFilterModeNone}
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
