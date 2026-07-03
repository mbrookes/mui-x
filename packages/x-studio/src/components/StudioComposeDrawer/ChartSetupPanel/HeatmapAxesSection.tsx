'use client';
import * as React from 'react';
import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioWidgetConfig } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';

export interface HeatmapAxesSectionProps {
  widgetId: string;
  config: StudioWidgetConfig;
  /**
   * Row-axis field candidates. Restricted to the widget's primary source so
   * `aggregateHeatmap()` can resolve values directly from the row objects.
   */
  heatYFields: DataSourceFieldEntry[];
  numericFields: DataSourceFieldEntry[];
  /** All visible fields, used to resolve the x/y axis labels shown in the sort-by picker. */
  allFields: DataSourceFieldEntry[];
  /** First configured Y-series field id, used as the fallback for the value-field picker. */
  firstYSeriesFieldId?: string;
}

/** Heatmap chart setup: row axis field, colour-value measure, colour scheme, and axis sorting. */
export function HeatmapAxesSection({
  widgetId,
  config,
  heatYFields,
  numericFields,
  allFields,
  firstYSeriesFieldId,
}: HeatmapAxesSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  const heatAxesSet = !!(config.xField && config.heatYField);
  const heatXFieldLabel = allFields.find((f) => f.id === config.xField)?.label;
  const heatYFieldLabel = allFields.find((f) => f.id === config.heatYField)?.label;

  return (
    <React.Fragment>
      <DataSourceFieldSelect
        value={config.heatYField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, { heatYField: fieldId || undefined })
        }
        fields={heatYFields}
        label={localeText.chartSetupHeatmapRowAxisLabel}
        helperText={localeText.chartSetupHeatmapRowAxisHelperText}
      />
      <DataSourceFieldSelect
        value={config.yField ?? firstYSeriesFieldId ?? ''}
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
              heatColorScheme: evt.target.value as 'primary' | 'success' | 'warning' | 'error',
            })
          }
        >
          <MenuItem value="primary">{localeText.chartColorSchemePrimary}</MenuItem>
          <MenuItem value="success">{localeText.chartColorSchemeSuccess}</MenuItem>
          <MenuItem value="warning">{localeText.chartColorSchemeWarning}</MenuItem>
          <MenuItem value="error">{localeText.chartColorSchemeError}</MenuItem>
        </Select>
      </FormControl>
      {/* Heatmap sort — disabled until both axes are configured */}
      <Stack direction="column" spacing={1}>
        <FormControl size="small" fullWidth disabled={!heatAxesSet}>
          <InputLabel>{localeText.chartSetupHeatmapSortByLabel}</InputLabel>
          <Select
            label={localeText.chartSetupHeatmapSortByLabel}
            value={config.heatSortBy ?? 'natural'}
            onChange={(evt) =>
              controller.updateWidgetConfig(widgetId, {
                heatSortBy: evt.target.value as 'x-axis' | 'y-axis' | 'natural',
              })
            }
          >
            <MenuItem value="natural">{localeText.chartSetupSortNatural}</MenuItem>
            <MenuItem value="x-axis">
              {heatXFieldLabel ?? localeText.chartSetupHeatmapSortXAxis}
            </MenuItem>
            <MenuItem value="y-axis">
              {heatYFieldLabel ?? localeText.chartSetupHeatmapSortYAxis}
            </MenuItem>
          </Select>
        </FormControl>
        {(config.heatSortBy === 'x-axis' || config.heatSortBy === 'y-axis') && (
          <ToggleButtonGroup
            value={config.heatSortDirection ?? 'asc'}
            exclusive
            disabled={!heatAxesSet}
            onChange={(_e, val) => {
              if (val) {
                controller.updateWidgetConfig(widgetId, {
                  heatSortDirection: val as 'asc' | 'desc',
                });
              }
            }}
            size="small"
            aria-label={localeText.chartSetupSortDirectionAriaLabel}
            sx={{ alignSelf: 'flex-start' }}
          >
            <ToggleButton
              value="asc"
              aria-label={localeText.sortAscendingAriaLabel}
              sx={{ textTransform: 'none' }}
            >
              {localeText.sortAscendingAriaLabel}
            </ToggleButton>
            <ToggleButton
              value="desc"
              aria-label={localeText.sortDescendingAriaLabel}
              sx={{ textTransform: 'none' }}
            >
              {localeText.sortDescendingAriaLabel}
            </ToggleButton>
          </ToggleButtonGroup>
        )}
      </Stack>
    </React.Fragment>
  );
}
