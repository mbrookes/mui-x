'use client';
import * as React from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  Alert,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectExpressionFields,
  selectRelationships,
} from '../context';
import { fieldsForCapability } from '../utils/fieldCapabilities';
import {
  analyzeChartSupport,
  getChartSupportMessage,
  getReachableSourceIds,
} from '../internals/chartUtils';
import type { StudioChartType, StudioBarLayout, StudioCrossFilterMode } from '../models';
import { ChartTypePicker } from './ChartTypePicker';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';

// react-doctor-disable-next-line react-doctor/no-giant-component
export function ChartSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
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

  const sortBySourceLabel = (a: { sourceLabel: string }, b: { sourceLabel: string }) =>
    a.sourceLabel.localeCompare(b.sourceLabel);

  const numericFields = React.useMemo(
    () => fieldsForCapability(reachableFields, 'numeric').sort(sortBySourceLabel),
    [reachableFields],
  );

  const categoryFields = React.useMemo(
    () => fieldsForCapability(reachableFields, 'categorical').sort(sortBySourceLabel),
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
    chartType === 'area-100';

  const supportsSeriesField =
    chartType === 'bar' ||
    chartType === 'bar-stacked' ||
    chartType === 'bar-100' ||
    chartType === 'line' ||
    chartType === 'area' ||
    chartType === 'area-stacked' ||
    chartType === 'area-100';

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

  if (allFields.length === 0) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        No data fields available for chart configuration.
      </Alert>
    );
  }

  // Computed labels to avoid nested ternaries in JSX
  let xFieldLabel: string;
  if (isScatter) {
    xFieldLabel = 'X field (numeric)';
  } else if (isHorizontalBarChart) {
    xFieldLabel = 'Y / Category field';
  } else {
    xFieldLabel = 'X / Category field';
  }

  let xFieldHelperText: string;
  if (isScatter) {
    xFieldHelperText = 'Plotted on the horizontal axis';
  } else if (isHorizontalBarChart) {
    xFieldHelperText = 'Groups data along the vertical axis';
  } else {
    xFieldHelperText = 'Groups data along the horizontal axis';
  }

  let yMeasureLabel: string;
  if (supportsMultipleSeries) {
    yMeasureLabel = isHorizontalBarChart ? 'X / Measure fields' : 'Y / Measure fields';
  } else {
    yMeasureLabel = isHorizontalBarChart ? 'X / Measure field' : 'Y / Measure field';
  }

  const ySeriesLabelBase = isHorizontalBarChart ? 'X / Measure field' : 'Y / Measure field';

  return (
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
          <InputLabel>Group by</InputLabel>
          <Select
            label="Group by"
            value={config.xGroupBy ?? ''}
            onChange={(evt) => {
              const val = evt.target.value as string;
              controller.updateWidgetConfig(widgetId, {
                xGroupBy: val ? (val as 'day' | 'week' | 'month' | 'quarter' | 'year') : undefined,
              });
            }}
          >
            <MenuItem value="">None (raw values)</MenuItem>
            <MenuItem value="day">Day</MenuItem>
            <MenuItem value="week">Week</MenuItem>
            <MenuItem value="month">Month</MenuItem>
            <MenuItem value="quarter">Quarter</MenuItem>
            <MenuItem value="year">Year</MenuItem>
          </Select>
        </FormControl>
      )}

      {/* Y series */}
      <div>
        <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
            {yMeasureLabel}
          </Typography>
          {supportsMultipleSeries && (
            <Tooltip
              title={
                usedYFieldIds.length >= numericFields.length
                  ? 'No more fields to add'
                  : 'Add series'
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
            <Stack
              key={s.fieldId || `series-${index}`}
              direction="row"
              spacing={0.5}
              sx={{ alignItems: 'flex-start' }}
            >
              <DataSourceFieldSelect
                value={s.fieldId ?? ''}
                onChange={(fieldId) => handleSeriesFieldChange(index, fieldId)}
                fields={numericFields}
                getOptionDisabled={(option) =>
                  (option.id !== s.fieldId && usedYFieldIds.includes(option.id)) ||
                  (option.id !== s.fieldId &&
                    !analyzeCombination({
                      yFields: ySeries.flatMap((series, seriesIndex) => {
                        const fieldId = seriesIndex === index ? option.id : series.fieldId;
                        return fieldId ? [fieldId] : [];
                      }),
                    }).supported)
                }
                label={ySeries.length > 1 ? `Series ${index + 1}` : ySeriesLabelBase}
                helperText={
                  isHorizontalBarChart
                    ? 'Numeric field plotted along the horizontal axis'
                    : 'Numeric field summed or averaged per category'
                }
              />
              {ySeries.length > 1 && (
                <Tooltip title="Remove series">
                  <IconButton size="small" onClick={() => handleRemoveSeries(index)} sx={{ mt: 1 }}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Stack>
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
              label={isHorizontalBarChart ? 'X / Measure field' : 'Y / Measure field'}
              helperText={
                isHorizontalBarChart
                  ? 'Numeric field plotted along the horizontal axis'
                  : 'Numeric field summed or averaged per category'
              }
            />
          )}
        </Stack>
      </div>
      {/* Split by / series field */}
      {supportsSeriesField && (
        <div>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Category field
          </Typography>
          <Tooltip
            title={seriesFieldDisabled ? 'Remove extra measure fields to enable split-by' : ''}
            placement="top"
          >
            <span>
              <DataSourceFieldSelect
                value={config.seriesField ?? ''}
                onChange={(fieldId) =>
                  controller.updateWidgetConfig(widgetId, { seriesField: fieldId || undefined })
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
                label="Split by (series field)"
                helperText={
                  seriesFieldDisabled
                    ? 'Not available when multiple measure fields are configured'
                    : 'Divides data into a separate series per value'
                }
              />
            </span>
          </Tooltip>
        </div>
      )}
      {/* Interactions — cross-filter mode */}
      <div>
        <Divider sx={{ mb: 1.5 }} />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
          Interactions
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          When other widgets are clicked, this chart…
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
            Highlight
          </ToggleButton>
          <ToggleButton value="cross-filter" sx={{ fontSize: 11, textTransform: 'none' }}>
            Filter
          </ToggleButton>
          <ToggleButton value="none" sx={{ fontSize: 11, textTransform: 'none' }}>
            None
          </ToggleButton>
        </ToggleButtonGroup>
      </div>
    </Stack>
  );
}
