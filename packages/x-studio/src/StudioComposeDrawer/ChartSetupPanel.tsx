'use client';
import * as React from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  Alert,
  Autocomplete,
  Box,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioSelector } from '../context';
import { fieldsForCapability } from '../utils/fieldCapabilities';
import { getReachableSourceIds } from '../internals/chartUtils';
import type { StudioChartType, StudioBarLayout } from '../models';
import { ChartTypePicker } from './ChartTypePicker';
import { renderFieldOption } from './FieldOption';

export function ChartSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const expressionFields = useStudioSelector((state) => state.expressionFields);

  const relationships = useStudioSelector((state) => state.relationships);

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

  // Once the X field anchors a source, restrict all other pickers to reachable sources.
  const reachableFields = React.useMemo(() => {
    if (!widget?.sourceId) {
      return allFields;
    }
    const reachableIds = getReachableSourceIds(widget.sourceId, relationships);
    return allFields.filter((f) => reachableIds.has(f.sourceId));
  }, [allFields, widget?.sourceId, relationships]);

  const config = widget?.config ?? {};

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

  // Y series: prefer ySeries, else seed from yField
  const ySeries = config.ySeries ?? (config.yField ? [{ fieldId: config.yField }] : []);

  const selectedXField = allFields.find((f) => f.id === config.xField) ?? null;

  const supportsMultipleSeries =
    chartType === 'bar' ||
    chartType === 'bar-stacked' ||
    chartType === 'bar-100' ||
    chartType === 'line' ||
    chartType === 'area' ||
    chartType === 'area-stacked' ||
    chartType === 'area-100';

  const supportsSeriesField =
    (chartType === 'bar' ||
      chartType === 'bar-stacked' ||
      chartType === 'bar-100' ||
      chartType === 'line' ||
      chartType === 'area' ||
      chartType === 'area-stacked' ||
      chartType === 'area-100') &&
    ySeries.length <= 1;

  const selectedSeriesField =
    config.seriesField ? (reachableFields.find((f) => f.id === config.seriesField) ?? null) : null;
  const isScatter = chartType === 'scatter';

  const handleChartTypeChange = (newType: StudioChartType, newBarLayout?: StudioBarLayout) => {
    controller.updateWidgetConfig(widgetId, {
      chartType: newType,
      barLayout: newBarLayout,
    });
  };

  const usedYFieldIds = ySeries.map((s) => s.fieldId).filter(Boolean);

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

  return (
    <Stack spacing={2}>
      {/* Chart type icon picker */}
      <ChartTypePicker chartType={chartType} barLayout={config.barLayout} onChange={handleChartTypeChange} />

      <Divider />

      {/* X field */}
      <Autocomplete
        size="small"
        fullWidth
        options={isScatter ? fieldsForCapability(allFields, 'numeric') : allFields}
        groupBy={(option) => option.sourceLabel}
        getOptionLabel={(option) => option.label}
        renderOption={renderFieldOption}
        value={selectedXField}
        onChange={(_e, newValue) => {
          controller.updateWidgetConfig(widgetId, { xField: newValue?.id ?? '' });
          if (newValue?.sourceId && newValue.sourceId !== widget?.sourceId) {
            controller.updateWidget(widgetId, { sourceId: newValue.sourceId });
          }
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={isScatter ? 'X field (numeric)' : 'X / Category field'}
            helperText={isScatter ? 'Plotted on the horizontal axis' : 'Groups data along the horizontal axis'}
          />
        )}
        isOptionEqualToValue={(option, value) =>
          option.id === value.id && option.sourceId === value.sourceId
        }
      />

      {/* Group by — shown only when x field is a date/datetime type */}
      {(selectedXField?.type === 'date' || selectedXField?.type === 'datetime') && (
        <FormControl size="small" fullWidth>
          <InputLabel>Group by</InputLabel>
          <Select
            label="Group by"
            value={config.xGroupBy ?? ''}
            onChange={(e) => {
              const val = e.target.value as string;
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
            {supportsMultipleSeries ? 'Y / Measure fields' : 'Y / Measure field'}
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
          {ySeries.map((s, index) => {
            const selectedField = allFields.find((f) => f.id === s.fieldId) ?? null;
            return (
              <Stack key={index} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <Autocomplete
                  size="small"
                  fullWidth
                  options={numericFields}
                  groupBy={(option) => option.sourceLabel}
                  getOptionLabel={(option) => option.label}
                  renderOption={renderFieldOption}
                  getOptionDisabled={(option) =>
                    option.id !== s.fieldId && usedYFieldIds.includes(option.id)
                  }
                  value={selectedField}
                  onChange={(_e, newValue) => handleSeriesFieldChange(index, newValue?.id ?? '')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label={ySeries.length > 1 ? `Series ${index + 1}` : 'Y / Measure field'}
                      helperText="Numeric field summed or averaged per category"
                    />
                  )}
                  isOptionEqualToValue={(option, value) =>
                    option.id === value.id && option.sourceId === value.sourceId
                  }
                />
                {ySeries.length > 1 && (
                  <Tooltip title="Remove series">
                    <IconButton size="small" onClick={() => handleRemoveSeries(index)}>
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
            );
          })}
          {ySeries.length === 0 && (
            <Autocomplete
              size="small"
              fullWidth
              options={numericFields}
              groupBy={(option) => option.sourceLabel}
              getOptionLabel={(option) => option.label}
              renderOption={renderFieldOption}
              value={null}
              onChange={(_e, newValue) => {
                controller.updateWidgetConfig(widgetId, {
                  ySeries: [{ fieldId: newValue?.id ?? '' }],
                  yField: newValue?.id ?? '',
                });
              }}
              renderInput={(params) => <TextField {...params} label="Y / Measure field" helperText="Numeric field summed or averaged per category" />}
              isOptionEqualToValue={(option, value) =>
                option.id === value.id && option.sourceId === value.sourceId
              }
            />
          )}
        </Stack>
      </div>
      {/* Split by / series field */}
      {supportsSeriesField && (
        <Autocomplete
          size="small"
          fullWidth
          options={categoryFields}
          groupBy={(option) => option.sourceLabel}
          getOptionLabel={(option) => option.label}
          renderOption={renderFieldOption}
          value={selectedSeriesField}
          onChange={(_e, newValue) =>
            controller.updateWidgetConfig(widgetId, {
              seriesField: newValue?.id ?? undefined,
            })
          }
          renderInput={(params) => <TextField {...params} label="Split by (series field)" helperText="Divides data into a separate series per value" />}
          isOptionEqualToValue={(option, value) =>
            option.id === value.id && option.sourceId === value.sourceId
          }
        />
      )}
    </Stack>
  );
}
