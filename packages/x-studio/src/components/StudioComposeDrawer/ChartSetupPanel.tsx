'use client';
import * as React from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import FunctionsIcon from '@mui/icons-material/Functions';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectExpressionFields,
  selectRelationships,
  useStudioLocaleText,
} from '../../context';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { fieldsForCapability } from '../../utils/fieldCapabilities';
import {
  analyzeChartSupport,
  getChartSupportMessage,
  getReachableSourceIds,
} from '../../internals/chartUtils';
import type {
  StudioChartAnnotation,
  StudioChartType,
  StudioBarLayout,
  StudioCrossFilterMode,
} from '../../models';
import { ChartTypePicker } from './ChartTypePicker';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';

function generateAnnotationId() {
  return `ann-${Math.random().toString(36).slice(2, 9)}`;
}

const sortBySourceLabel = (a: { sourceLabel: string }, b: { sourceLabel: string }) =>
  a.sourceLabel.localeCompare(b.sourceLabel);

// react-doctor-disable-next-line react-doctor/no-giant-component
export function ChartSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const features = useStudioFeatures();
  const localeText = useStudioLocaleText();
  const allWidgets = useStudioSelector(selectWidgets);
  const widget = allWidgets[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);

  const relationships = useStudioSelector(selectRelationships);

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

  const config = widget?.config ?? {};
  const widgetSourceId = widget?.sourceId;

  // selectedXField is used to conditionally show the Group By control below
  const selectedXField = allFields.find((f) => f.id === config.xField) ?? null;
  const supportSourceId = selectedXField?.sourceId;

  // Once the X field anchors a source, restrict all other pickers to reachable sources.
  const reachableFields = React.useMemo(() => {
    if (!supportSourceId) {
      return allFields;
    }
    const reachableIds = getReachableSourceIds(supportSourceId, relationships);
    return allFields.filter((f) => reachableIds.has(f.sourceId));
  }, [allFields, relationships, supportSourceId]);

  const numericFields = React.useMemo(
    () => fieldsForCapability(reachableFields, 'numeric').sort(sortBySourceLabel),
    [reachableFields],
  );

  const categoryFields = React.useMemo(
    () => fieldsForCapability(reachableFields, 'categorical').sort(sortBySourceLabel),
    [reachableFields],
  );

  const dateFields = React.useMemo(
    () =>
      reachableFields
        .filter((f) => f.type === 'date' || f.type === 'datetime')
        .sort(sortBySourceLabel),
    [reachableFields],
  );

  const chartType: StudioChartType = config.chartType ?? 'bar';
  const isHorizontalBarChart =
    (chartType === 'bar' || chartType === 'bar-stacked' || chartType === 'bar-100') &&
    config.barLayout === 'horizontal';

  // Y series: prefer ySeries, else seed from yField
  const ySeries = React.useMemo(
    () => config.ySeries ?? (config.yField ? [{ fieldId: config.yField }] : []),
    [config.ySeries, config.yField],
  );

  const supportsMultipleSeries =
    chartType === 'bar' ||
    chartType === 'bar-stacked' ||
    chartType === 'bar-100' ||
    chartType === 'line' ||
    chartType === 'area' ||
    chartType === 'area-stacked' ||
    chartType === 'area-100' ||
    chartType === 'mixed';

  const supportsSeriesField =
    chartType === 'bar' ||
    chartType === 'bar-stacked' ||
    chartType === 'bar-100' ||
    chartType === 'line' ||
    chartType === 'area' ||
    chartType === 'area-stacked' ||
    chartType === 'area-100' ||
    chartType === 'pie' ||
    chartType === 'donut';

  // Split-by is mutually exclusive with multiple Y-series: keep the control
  // visible so users can see why it's unavailable, but disable it.
  const seriesFieldDisabled = ySeries.length > 1;

  const isScatter = chartType === 'scatter';
  const chartSupport = React.useMemo(
    () =>
      analyzeChartSupport(
        widgetSourceId ?? supportSourceId,
        config.xField,
        ySeries.flatMap((series) => (series.fieldId ? [series.fieldId] : [])),
        config.seriesField,
        chartType,
        dataSources,
        relationships,
        expressionFields,
      ),
    [
      widgetSourceId,
      supportSourceId,
      config.xField,
      ySeries,
      config.seriesField,
      chartType,
      dataSources,
      relationships,
      expressionFields,
    ],
  );

  const analyzeCombination = React.useCallback(
    (overrides: {
      xField?: string | undefined;
      yFields?: string[];
      seriesField?: string | undefined;
    }) =>
      analyzeChartSupport(
        widgetSourceId ?? supportSourceId,
        overrides.xField ?? config.xField,
        overrides.yFields ?? ySeries.flatMap((series) => (series.fieldId ? [series.fieldId] : [])),
        overrides.seriesField ?? config.seriesField,
        chartType,
        dataSources,
        relationships,
        expressionFields,
      ),
    [
      widgetSourceId,
      supportSourceId,
      config.xField,
      config.seriesField,
      ySeries,
      chartType,
      dataSources,
      relationships,
      expressionFields,
    ],
  );

  const handleChartTypeChange = (newType: StudioChartType, newBarLayout?: StudioBarLayout) => {
    controller.updateWidgetConfig(widgetId, {
      chartType: newType,
      barLayout: newBarLayout,
    });
  };

  const usedYFieldIds = ySeries.flatMap((s) => (s.fieldId ? [s.fieldId] : []));

  const handleAddSeries = () => {
    controller.updateWidgetConfig(widgetId, { ySeries: [...ySeries, { fieldId: '' }] });
  };

  const handleRemoveSeries = (index: number) => {
    const next = ySeries.filter((_, i) => i !== index);
    controller.updateWidgetConfig(widgetId, {
      ySeries: next,
      yField: next[0]?.fieldId ?? '',
    });
  };

  const handleSeriesFieldChange = (index: number, fieldId: string) => {
    const next = ySeries.map((s, i) => (i === index ? { ...s, fieldId } : s));
    controller.updateWidgetConfig(widgetId, {
      ySeries: next,
      yField: next[0]?.fieldId ?? '',
    });
  };

  const handleSeriesTypeChange = (index: number, seriesType: 'bar' | 'line') => {
    const next = ySeries.map((s, i) => (i === index ? { ...s, seriesType } : s));
    controller.updateWidgetConfig(widgetId, { ySeries: next });
  };

  const isPieOrDonut = chartType === 'pie' || chartType === 'donut';
  let seriesFieldHelperText = localeText.chartSetupSplitByHelperText;
  if (seriesFieldDisabled) {
    seriesFieldHelperText = localeText.chartSetupSplitByDisabledHelperText;
  } else if (isPieOrDonut) {
    seriesFieldHelperText = localeText.chartSetupInnerRingHelperText;
  } else {
    seriesFieldHelperText = localeText.chartSetupSplitByHelperText;
  }
  const isGauge = chartType === 'gauge';
  const isMixed = chartType === 'mixed';
  const isHeatmap = chartType === 'heatmap';
  const isFunnel = chartType === 'funnel';
  const isGantt = chartType === 'gantt';

  const [calcDialogOpen, setCalcDialogOpen] = React.useState(false);

  const widgetSource = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  const showCalcFieldButton =
    !isScatter &&
    !isPieOrDonut &&
    !isGauge &&
    !isHeatmap &&
    !isFunnel &&
    !isGantt &&
    widgetSource !== undefined &&
    features.calculatedFields !== false &&
    features.chartCalculatedFields !== false;

  if (allFields.length === 0) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        {localeText.chartSetupNoDataAlert}
      </Alert>
    );
  }

  // Computed labels to avoid nested ternaries in JSX
  let xFieldLabel: string;
  if (isScatter) {
    xFieldLabel = localeText.chartSetupXFieldNumericLabel;
  } else if (isHorizontalBarChart) {
    xFieldLabel = localeText.chartSetupXFieldCategoryVertLabel;
  } else {
    xFieldLabel = localeText.chartSetupXFieldCategoryHorizLabel;
  }

  let xFieldHelperText: string;
  if (isScatter) {
    xFieldHelperText = localeText.chartSetupXFieldHorizontalHelperText;
  } else if (isHorizontalBarChart) {
    xFieldHelperText = localeText.chartSetupXFieldGroupVertHelperText;
  } else {
    xFieldHelperText = localeText.chartSetupXFieldGroupHorizHelperText;
  }

  let yMeasureLabel: string;
  if (supportsMultipleSeries) {
    yMeasureLabel = isHorizontalBarChart
      ? localeText.chartSetupXMeasureFieldsLabel
      : localeText.chartSetupYMeasureFieldsLabel;
  } else {
    yMeasureLabel = isHorizontalBarChart
      ? localeText.chartSetupXMeasureFieldLabel
      : localeText.chartSetupYMeasureFieldLabel;
  }

  const ySeriesLabelBase = isHorizontalBarChart
    ? localeText.chartSetupXMeasureFieldLabel
    : localeText.chartSetupYMeasureFieldLabel;

  return (
    <React.Fragment>
      <Stack spacing={2}>
        {!chartSupport.supported && chartSupport.reason ? (
          <Alert severity="warning">{getChartSupportMessage(chartSupport.reason)}</Alert>
        ) : null}

        {/* Chart type icon picker */}
        <ChartTypePicker
          chartType={chartType}
          barLayout={config.barLayout}
          onChange={handleChartTypeChange}
        />

        <Divider />

        {/* Gauge chart setup */}
        {isGauge && (
          <Stack spacing={2}>
            <DataSourceFieldSelect
              value={config.yField ?? ''}
              onChange={(fieldId, sourceId) => {
                controller.updateWidgetConfig(widgetId, { yField: fieldId });
                if (sourceId && sourceId !== widget?.sourceId) {
                  controller.updateWidget(widgetId, { sourceId });
                }
              }}
              fields={fieldsForCapability(allFields, 'numeric')}
              label={localeText.chartSetupValueFieldLabel}
              helperText={localeText.chartSetupValueFieldHelperText}
            />

            <FormControl size="small" fullWidth>
              <InputLabel>{localeText.chartSetupAggregationLabel}</InputLabel>
              <Select
                label={localeText.chartSetupAggregationLabel}
                value={config.yAggregation ?? 'sum'}
                onChange={(evt) =>
                  controller.updateWidgetConfig(widgetId, {
                    yAggregation: evt.target.value as 'sum' | 'count' | 'avg' | 'min' | 'max',
                  })
                }
              >
                <MenuItem value="sum">{localeText.aggFnSum}</MenuItem>
                <MenuItem value="count">{localeText.aggFnCount}</MenuItem>
                <MenuItem value="avg">{localeText.aggFnAverage}</MenuItem>
                <MenuItem value="min">{localeText.aggFnMin}</MenuItem>
                <MenuItem value="max">{localeText.aggFnMax}</MenuItem>
              </Select>
            </FormControl>

            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                label={localeText.chartSetupMinLabel}
                type="number"
                value={config.gaugeMin ?? 0}
                onChange={(evt) =>
                  controller.updateWidgetConfig(widgetId, { gaugeMin: Number(evt.target.value) })
                }
                sx={{ flex: 1 }}
              />
              <TextField
                size="small"
                label={localeText.chartSetupMaxLabel}
                type="number"
                value={config.gaugeMax ?? 100}
                onChange={(evt) =>
                  controller.updateWidgetConfig(widgetId, { gaugeMax: Number(evt.target.value) })
                }
                sx={{ flex: 1 }}
              />
            </Stack>
          </Stack>
        )}

        {/* Standard (non-gauge, non-gantt) fields */}
        {!isGauge && !isGantt && (
          <Stack spacing={2}>
            {/* X field */}
            <DataSourceFieldSelect
              value={config.xField ?? ''}
              onChange={(fieldId, sourceId) => {
                controller.updateWidgetConfig(widgetId, { xField: fieldId });
                if (sourceId && sourceId !== widget?.sourceId) {
                  controller.updateWidget(widgetId, { sourceId });
                }
              }}
              fields={isScatter ? fieldsForCapability(allFields, 'numeric') : allFields}
              getOptionDisabled={(option) => {
                if (option.id === config.xField) {
                  return false;
                }
                return !analyzeCombination({ xField: option.id }).supported;
              }}
              label={xFieldLabel}
              helperText={xFieldHelperText}
            />

            {/* Group by — shown only when x field is a date/datetime type */}
            {(selectedXField?.type === 'date' || selectedXField?.type === 'datetime') && (
              <FormControl size="small" fullWidth>
                <InputLabel>{localeText.chartSetupGroupByLabel}</InputLabel>
                <Select
                  label={localeText.chartSetupGroupByLabel}
                  value={config.xGroupBy ?? ''}
                  onChange={(evt) => {
                    const val = evt.target.value as string;
                    controller.updateWidgetConfig(widgetId, {
                      xGroupBy: val
                        ? (val as 'day' | 'week' | 'month' | 'quarter' | 'year')
                        : undefined,
                    });
                  }}
                >
                  <MenuItem value="">{localeText.timeGranNone}</MenuItem>
                  <MenuItem value="day">{localeText.timeGranDay}</MenuItem>
                  <MenuItem value="week">{localeText.timeGranWeek}</MenuItem>
                  <MenuItem value="month">{localeText.timeGranMonth}</MenuItem>
                  <MenuItem value="quarter">{localeText.timeGranQuarter}</MenuItem>
                  <MenuItem value="year">{localeText.timeGranYear}</MenuItem>
                </Select>
              </FormControl>
            )}

            {/* Sort controls — shown when x-field is set on categorical charts (not scatter, not gauge, not gantt) */}
            {config.xField && !isScatter && (
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <FormControl size="small" sx={{ flex: 1 }}>
                  <InputLabel>{localeText.chartSetupSortByLabel}</InputLabel>
                  <Select
                    label={localeText.chartSetupSortByLabel}
                    value={config.chartSortBy ?? 'category'}
                    onChange={(evt) => {
                      controller.updateWidgetConfig(widgetId, {
                        chartSortBy: evt.target.value as 'category' | 'value',
                      });
                    }}
                  >
                    <MenuItem value="category">{localeText.chartSetupSortCategory}</MenuItem>
                    <MenuItem value="value">{localeText.chartSetupSortValue}</MenuItem>
                  </Select>
                </FormControl>
                <ToggleButtonGroup
                  value={config.chartSortDirection ?? 'asc'}
                  exclusive
                  onChange={(_e, val) => {
                    if (val) {
                      controller.updateWidgetConfig(widgetId, {
                        chartSortDirection: val as 'asc' | 'desc',
                      });
                    }
                  }}
                  size="small"
                  aria-label={localeText.chartSetupSortDirectionAriaLabel}
                >
                  <ToggleButton value="asc" aria-label={localeText.sortAscendingAriaLabel}>
                    {`↑ ${localeText.sortAscendingAriaLabel}`}
                  </ToggleButton>
                  <ToggleButton value="desc" aria-label={localeText.sortDescendingAriaLabel}>
                    {`↓ ${localeText.sortDescendingAriaLabel}`}
                  </ToggleButton>
                </ToggleButtonGroup>
              </Stack>
            )}

            {/* Scatter: single Y field + optional color-by */}
            {isScatter && (
              <React.Fragment>
                <DataSourceFieldSelect
                  value={config.yField ?? ySeries[0]?.fieldId ?? ''}
                  onChange={(fieldId) => {
                    controller.updateWidgetConfig(widgetId, {
                      yField: fieldId,
                      ySeries: [{ fieldId }],
                    });
                  }}
                  fields={numericFields}
                  label={localeText.chartSetupYFieldLabel}
                  helperText={localeText.chartSetupYFieldHelperText}
                />
                <DataSourceFieldSelect
                  value={config.scatterColorField ?? ''}
                  onChange={(fieldId) =>
                    controller.updateWidgetConfig(widgetId, {
                      scatterColorField: fieldId || undefined,
                    })
                  }
                  fields={categoryFields}
                  label={localeText.chartSetupColorByLabel}
                  helperText={localeText.chartSetupColorByHelperText}
                />
                <DataSourceFieldSelect
                  value={config.scatterSizeField ?? ''}
                  onChange={(fieldId) =>
                    controller.updateWidgetConfig(widgetId, {
                      scatterSizeField: fieldId || undefined,
                    })
                  }
                  fields={numericFields}
                  label={localeText.chartSetupSizeByLabel}
                  helperText={localeText.chartSetupSizeByHelperText}
                />
                {config.scatterSizeField && (
                  <Stack direction="row" spacing={1}>
                    <TextField
                      size="small"
                      label={localeText.chartSetupMinRadiusLabel}
                      type="number"
                      value={config.scatterMinRadius ?? 4}
                      onChange={(evt) =>
                        controller.updateWidgetConfig(widgetId, {
                          scatterMinRadius: Number(evt.target.value) || 4,
                        })
                      }
                      slotProps={{ htmlInput: { min: 1, max: 50 } }}
                      sx={{ flex: 1 }}
                    />
                    <TextField
                      size="small"
                      label={localeText.chartSetupMaxRadiusLabel}
                      type="number"
                      value={config.scatterMaxRadius ?? 40}
                      onChange={(evt) =>
                        controller.updateWidgetConfig(widgetId, {
                          scatterMaxRadius: Number(evt.target.value) || 40,
                        })
                      }
                      slotProps={{ htmlInput: { min: 1, max: 100 } }}
                      sx={{ flex: 1 }}
                    />
                  </Stack>
                )}
              </React.Fragment>
            )}

            {/* Funnel: single value/measure field */}
            {isFunnel && (
              <DataSourceFieldSelect
                value={config.yField ?? ySeries[0]?.fieldId ?? ''}
                onChange={(fieldId) => {
                  controller.updateWidgetConfig(widgetId, {
                    yField: fieldId,
                    ySeries: [{ fieldId }],
                  });
                }}
                fields={numericFields}
                label={localeText.chartSetupValueFieldLabel}
                helperText={localeText.chartSetupFunnelValueHelperText}
              />
            )}

            {/* Heatmap: row axis field + colour-value measure */}
            {isHeatmap && (
              <React.Fragment>
                <DataSourceFieldSelect
                  value={config.heatYField ?? ''}
                  onChange={(fieldId) =>
                    controller.updateWidgetConfig(widgetId, { heatYField: fieldId || undefined })
                  }
                  fields={categoryFields}
                  label={localeText.chartSetupHeatmapRowAxisLabel}
                  helperText={localeText.chartSetupHeatmapRowAxisHelperText}
                />
                <DataSourceFieldSelect
                  value={config.yField ?? ySeries[0]?.fieldId ?? ''}
                  onChange={(fieldId) => {
                    controller.updateWidgetConfig(widgetId, {
                      yField: fieldId,
                      ySeries: [{ fieldId }],
                    });
                  }}
                  fields={numericFields}
                  label={localeText.chartSetupHeatmapValueLabel}
                  helperText={localeText.chartSetupHeatmapValueHelperText}
                />
                <FormControl size="small" fullWidth>
                  <InputLabel>{localeText.chartSetupHeatmapColourSchemeLabel}</InputLabel>
                  <Select
                    label={localeText.chartSetupHeatmapColourSchemeLabel}
                    value={config.heatColorScheme ?? 'primary'}
                    onChange={(evt) =>
                      controller.updateWidgetConfig(widgetId, {
                        heatColorScheme: evt.target.value as
                          | 'primary'
                          | 'success'
                          | 'warning'
                          | 'error',
                      })
                    }
                  >
                    <MenuItem value="primary">{localeText.chartColorSchemePrimary}</MenuItem>
                    <MenuItem value="success">{localeText.chartColorSchemeSuccess}</MenuItem>
                    <MenuItem value="warning">{localeText.chartColorSchemeWarning}</MenuItem>
                    <MenuItem value="error">{localeText.chartColorSchemeError}</MenuItem>
                  </Select>
                </FormControl>
              </React.Fragment>
            )}

            {/* Y series — for non-scatter, non-gauge, non-heatmap, non-funnel charts */}
            {!isScatter && !isHeatmap && !isFunnel && (
              <div>
                <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
                    {yMeasureLabel}
                  </Typography>
                  {supportsMultipleSeries && (
                    <Tooltip
                      title={
                        usedYFieldIds.length >= numericFields.length
                          ? localeText.chartSetupNoMoreFields
                          : localeText.chartSetupAddSeries
                      }
                    >
                      <span>
                        <IconButton
                          size="small"
                          onClick={handleAddSeries}
                          disabled={usedYFieldIds.length >= numericFields.length}
                        >
                          <AddIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                </Stack>
                <Stack spacing={1}>
                  {ySeries.map((s, index) => (
                    <React.Fragment key={s.fieldId || `series-${index}`}>
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                        <DataSourceFieldSelect
                          value={s.fieldId ?? ''}
                          onChange={(fieldId) => handleSeriesFieldChange(index, fieldId)}
                          fields={numericFields}
                          getOptionDisabled={(option) =>
                            (option.id !== s.fieldId && usedYFieldIds.includes(option.id)) ||
                            (option.id !== s.fieldId &&
                              !analyzeCombination({
                                yFields: ySeries.flatMap((series, seriesIndex) => {
                                  const fieldId =
                                    seriesIndex === index ? option.id : series.fieldId;
                                  return fieldId ? [fieldId] : [];
                                }),
                              }).supported)
                          }
                          label={
                            ySeries.length > 1
                              ? localeText.chartSetupSeriesLabel(index)
                              : ySeriesLabelBase
                          }
                          helperText={
                            isHorizontalBarChart
                              ? localeText.chartSetupSeriesNumericHorizHelperText
                              : localeText.chartSetupSeriesNumericSumHelperText
                          }
                        />
                        {ySeries.length > 1 && (
                          <Tooltip title={localeText.chartSetupRemoveSeries}>
                            <IconButton
                              size="small"
                              onClick={() => handleRemoveSeries(index)}
                              sx={{ mt: 1 }}
                            >
                              <CloseIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Stack>
                      {isMixed && s.fieldId && (
                        <ToggleButtonGroup
                          size="small"
                          exclusive
                          value={s.seriesType ?? 'bar'}
                          onChange={(_, val) => {
                            if (val) {
                              handleSeriesTypeChange(index, val);
                            }
                          }}
                          sx={{ mt: 0.5, mb: 0.5 }}
                        >
                          <ToggleButton value="bar" sx={{ px: 1.5, py: 0.25, fontSize: 11 }}>
                            {localeText.chartSetupMixedSeriesBar}
                          </ToggleButton>
                          <ToggleButton value="line" sx={{ px: 1.5, py: 0.25, fontSize: 11 }}>
                            {localeText.chartSetupMixedSeriesLine}
                          </ToggleButton>
                        </ToggleButtonGroup>
                      )}
                    </React.Fragment>
                  ))}
                  {ySeries.length === 0 && (
                    <DataSourceFieldSelect
                      value=""
                      onChange={(fieldId) => {
                        controller.updateWidgetConfig(widgetId, {
                          ySeries: [{ fieldId }],
                          yField: fieldId,
                        });
                      }}
                      fields={numericFields}
                      getOptionDisabled={(option) =>
                        !analyzeCombination({ yFields: [option.id] }).supported
                      }
                      label={ySeriesLabelBase}
                      helperText={
                        isHorizontalBarChart
                          ? localeText.chartSetupSeriesNumericHorizHelperText
                          : localeText.chartSetupSeriesNumericSumHelperText
                      }
                    />
                  )}
                </Stack>
              </div>
            )}
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
                {localeText.chartSetupCalculatedField}
              </Button>
            )}
            {/* Dual Y axis toggle — only for mixed chart with 2+ series */}
            {isMixed && ySeries.filter((s) => s.fieldId).length >= 2 && (
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={config.dualYAxis ?? false}
                    onChange={(event) =>
                      controller.updateWidgetConfig(widgetId, { dualYAxis: event.target.checked })
                    }
                  />
                }
                label={<Typography variant="caption">{localeText.chartSetupDualYAxis}</Typography>}
                sx={{ ml: 0 }}
              />
            )}
            {/* Split by / series field */}
            {supportsSeriesField && (
              <div>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.5 }}
                >
                  {localeText.chartSetupCategoryFieldLabel}
                </Typography>
                <Tooltip
                  title={seriesFieldDisabled ? localeText.chartSetupRemoveSplitByTooltip : ''}
                  placement="top"
                >
                  <span>
                    <DataSourceFieldSelect
                      value={config.seriesField ?? ''}
                      onChange={(fieldId) =>
                        controller.updateWidgetConfig(widgetId, {
                          seriesField: fieldId || undefined,
                        })
                      }
                      fields={categoryFields}
                      getOptionDisabled={(option) => {
                        if (seriesFieldDisabled) {
                          return true;
                        }
                        if (option.id === config.seriesField) {
                          return false;
                        }
                        return !analyzeCombination({ seriesField: option.id }).supported;
                      }}
                      disabled={seriesFieldDisabled}
                      label={
                        isPieOrDonut
                          ? localeText.chartSetupInnerRingLabel
                          : localeText.chartSetupSplitByLabel
                      }
                      helperText={seriesFieldHelperText}
                    />
                  </span>
                </Tooltip>
              </div>
            )}
            {/* Pie / donut: arc label options */}
            {isPieOrDonut && (
              <React.Fragment>
                <Divider />
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.5 }}
                >
                  {localeText.chartSetupArcLabelsTitle}
                </Typography>
                <FormControl size="small" fullWidth>
                  <InputLabel>{localeText.chartSetupArcLabelLabel}</InputLabel>
                  <Select
                    label={localeText.chartSetupArcLabelLabel}
                    value={config.pieArcLabel ?? 'none'}
                    onChange={(evt) =>
                      controller.updateWidgetConfig(widgetId, {
                        pieArcLabel: evt.target.value as 'value' | 'percent' | 'none',
                      })
                    }
                  >
                    <MenuItem value="none">{localeText.chartSetupSortNone}</MenuItem>
                    <MenuItem value="value">{localeText.chartSetupSortValue}</MenuItem>
                    <MenuItem value="percent">{localeText.chartSetupSortPercent}</MenuItem>
                  </Select>
                </FormControl>
                {(config.pieArcLabel ?? 'none') !== 'none' && (
                  <TextField
                    size="small"
                    label={localeText.chartSetupMinAngleLabel}
                    type="number"
                    value={config.pieArcLabelMinAngle ?? 20}
                    helperText={localeText.chartSetupMinAngleHelperText}
                    onChange={(evt) =>
                      controller.updateWidgetConfig(widgetId, {
                        pieArcLabelMinAngle: Math.max(0, Number(evt.target.value)),
                      })
                    }
                    slotProps={{ htmlInput: { min: 0, max: 180 } }}
                  />
                )}
              </React.Fragment>
            )}
          </Stack>
        )}

        {/* Gantt / timeline chart fields */}
        {isGantt && (
          <Stack spacing={2}>
            <DataSourceFieldSelect
              value={config.ganttLabelField ?? ''}
              onChange={(fieldId) =>
                controller.updateWidgetConfig(widgetId, { ganttLabelField: fieldId || undefined })
              }
              fields={allFields}
              label={localeText.chartSetupGanttLabelFieldLabel}
              helperText={localeText.chartSetupGanttLabelFieldHelperText}
            />
            <DataSourceFieldSelect
              value={config.ganttStartField ?? ''}
              onChange={(fieldId) =>
                controller.updateWidgetConfig(widgetId, { ganttStartField: fieldId || undefined })
              }
              fields={dateFields}
              label={localeText.chartSetupGanttStartDateLabel}
              helperText={localeText.chartSetupGanttStartDateHelperText}
            />
            <DataSourceFieldSelect
              value={config.ganttEndField ?? ''}
              onChange={(fieldId) =>
                controller.updateWidgetConfig(widgetId, { ganttEndField: fieldId || undefined })
              }
              fields={dateFields}
              label={localeText.chartSetupGanttEndDateLabel}
              helperText={localeText.chartSetupGanttEndDateHelperText}
            />
            <DataSourceFieldSelect
              value={config.ganttColorField ?? ''}
              onChange={(fieldId) =>
                controller.updateWidgetConfig(widgetId, { ganttColorField: fieldId || undefined })
              }
              fields={categoryFields}
              label={localeText.chartSetupGanttColourByLabel}
              helperText={localeText.chartSetupGanttColourByHelperText}
            />
          </Stack>
        )}

        {/* Annotations — reference lines (not for pie/donut/gauge/gantt) */}
        {features.chartAnnotations !== false &&
          chartType !== 'pie' &&
          chartType !== 'donut' &&
          chartType !== 'gauge' &&
          chartType !== 'gantt' && (
            <div>
              <Divider sx={{ mb: 1.5 }} />
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ flexGrow: 1, fontWeight: 600 }}
                >
                  {localeText.chartSetupAnnotationsTitle}
                </Typography>
                <Tooltip title={localeText.chartSetupAddReferenceLine}>
                  <IconButton
                    size="small"
                    onClick={() => {
                      const newAnn: StudioChartAnnotation = {
                        id: generateAnnotationId(),
                        axis: 'y',
                        value: 0,
                        label: '',
                      };
                      controller.updateWidgetConfig(widgetId, {
                        annotations: [...(config.annotations ?? []), newAnn],
                      });
                    }}
                  >
                    <AddIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
              {(config.annotations ?? []).length === 0 && (
                <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
                  {localeText.chartSetupNoReferenceLines}
                </Typography>
              )}
              <Stack spacing={1}>
                {(config.annotations ?? []).map((ann) => (
                  <Stack
                    key={ann.id}
                    direction="row"
                    spacing={0.5}
                    sx={{ alignItems: 'flex-start' }}
                  >
                    <FormControl size="small" sx={{ width: 56 }}>
                      <Select
                        value={ann.axis}
                        onChange={(event) => {
                          controller.updateWidgetConfig(widgetId, {
                            annotations: (config.annotations ?? []).map((a) =>
                              a.id === ann.id ? { ...a, axis: event.target.value as 'y' | 'x' } : a,
                            ),
                          });
                        }}
                      >
                        <MenuItem value="y">Y</MenuItem>
                        <MenuItem value="x">X</MenuItem>
                      </Select>
                    </FormControl>
                    <TextField
                      size="small"
                      label={localeText.chartSetupReferenceLineValueLabel}
                      value={ann.value}
                      onChange={(event) => {
                        const raw = event.target.value;
                        const num = Number(raw);
                        controller.updateWidgetConfig(widgetId, {
                          annotations: (config.annotations ?? []).map((a) =>
                            a.id === ann.id ? { ...a, value: Number.isNaN(num) ? raw : num } : a,
                          ),
                        });
                      }}
                      sx={{ flexGrow: 1 }}
                    />
                    <TextField
                      size="small"
                      label={localeText.chartSetupReferenceLineLabelLabel}
                      value={ann.label ?? ''}
                      onChange={(event) => {
                        controller.updateWidgetConfig(widgetId, {
                          annotations: (config.annotations ?? []).map((a) =>
                            a.id === ann.id ? { ...a, label: event.target.value } : a,
                          ),
                        });
                      }}
                      sx={{ flexGrow: 1 }}
                    />
                    <Tooltip title={localeText.chartSetupRemoveAnnotation}>
                      <IconButton
                        size="small"
                        onClick={() => {
                          controller.updateWidgetConfig(widgetId, {
                            annotations: (config.annotations ?? []).filter((a) => a.id !== ann.id),
                          });
                        }}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                ))}
              </Stack>
            </div>
          )}
        {/* Interactions — cross-filter mode */}
        <div>
          <Divider sx={{ mb: 1.5 }} />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
            {localeText.chartSetupInteractionsTitle}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            {localeText.chartSetupInteractionsDescription}
          </Typography>
          <ToggleButtonGroup
            value={(config.crossFilterMode ?? 'cross-highlight') as StudioCrossFilterMode}
            exclusive
            onChange={(_e, value: StudioCrossFilterMode | null) => {
              controller.updateWidgetConfig(widgetId, {
                crossFilterMode: value ?? 'cross-highlight',
              });
            }}
            size="small"
            fullWidth
          >
            <ToggleButton value="cross-highlight" sx={{ fontSize: 11, textTransform: 'none' }}>
              {localeText.crossFilterModeHighlight}
            </ToggleButton>
            <ToggleButton value="cross-filter" sx={{ fontSize: 11, textTransform: 'none' }}>
              {localeText.crossFilterModeFilter}
            </ToggleButton>
            <ToggleButton value="none" sx={{ fontSize: 11, textTransform: 'none' }}>
              {localeText.crossFilterModeNone}
            </ToggleButton>
          </ToggleButtonGroup>
        </div>
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
            controller.updateWidgetConfig(widgetId, {
              ySeries: [...ySeries, { fieldId }],
              yField: ySeries.length === 0 ? fieldId : (ySeries[0]?.fieldId ?? fieldId),
            });
          }}
        />
      )}
    </React.Fragment>
  );
}
