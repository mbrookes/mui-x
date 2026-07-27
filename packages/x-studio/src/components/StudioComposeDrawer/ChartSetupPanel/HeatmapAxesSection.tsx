'use client';
import * as React from 'react';
import { FormControl, InputLabel, MenuItem, Select, Stack } from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioChartConfig, StudioChartConfigOfType } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';
import { SortDirectionToggle } from './SortDirectionToggle';
import { buildSingleMeasurePatch } from './commitMeasureSeries';

export interface HeatmapAxesSectionProps {
  widgetId: string;
  config: StudioChartConfigOfType<'heatmap'>;
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
  /**
   * The widget's current source id. Scopes the axis-label lookups below (a bare-id lookup
   * across the multi-source catalog can match a same-id field on a merely-reachable source
   * and show its label) and is the `yField` mirror's own-source test.
   */
  widgetSourceId?: string;
  /**
   * H3: the ONE write path for this section's field pickers, supplied by `ChartSetupPanel`.
   * It routes through `commitChartConfigWithSource`, so a row-axis or value pick on a
   * source-less heatmap adopts that field's source instead of leaving the widget blank.
   */
  commitFieldConfig: (
    configPatch: Partial<StudioChartConfig>,
    /** The picked field's source, or `undefined` when the gesture clears the field. */
    sourceId: string | undefined,
  ) => void;
}

/** Heatmap chart setup: row axis field, colour-value measure, colour scheme, and axis sorting. */
export function HeatmapAxesSection({
  widgetId,
  config,
  heatYFields,
  numericFields,
  allFields,
  firstYSeriesFieldId,
  widgetSourceId,
  commitFieldConfig,
}: HeatmapAxesSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  // See `ChartSetupPanel`'s own `React.useId` block: MUI's `Select` only exposes an
  // accessible name when it is handed a `labelId` pairing it with its `InputLabel`.
  const colourSchemeLabelId = React.useId();
  const sortByLabelId = React.useId();

  const heatAxesSet = !!(config.xField && config.heatYField);
  // Own-source-first resolution, mirroring `ChartSetupPanel`'s `selectedXField` (finding
  // 2.12): `buildFieldCatalog` sorts by source label, so a bare-id lookup across the
  // multi-source catalog can match a related source that shares the field id and sorts
  // earlier, labelling the sort options after the wrong source's field.
  const findFieldLabel = (fieldId: string | undefined) =>
    fieldId === undefined
      ? undefined
      : (
          (widgetSourceId
            ? allFields.find((f) => f.id === fieldId && f.sourceId === widgetSourceId)
            : undefined) ?? allFields.find((f) => f.id === fieldId)
        )?.label;
  const heatXFieldLabel = findFieldLabel(config.xField);
  const heatYFieldLabel = findFieldLabel(config.heatYField);

  return (
    <React.Fragment>
      <DataSourceFieldSelect
        value={config.heatYField ?? ''}
        valueSourceId={widgetSourceId}
        onChange={(fieldId, sourceId) =>
          commitFieldConfig({ heatYField: fieldId || undefined }, fieldId ? sourceId : undefined)
        }
        fields={heatYFields}
        label={localeText.chartSetupHeatmapRowAxisLabel}
        helperText={localeText.chartSetupHeatmapRowAxisHelperText}
        required
      />
      <DataSourceFieldSelect
        value={config.yField ?? firstYSeriesFieldId ?? ''}
        onChange={(fieldId, sourceId) => {
          // Single-measure picker over a multi-series config — see `buildSingleMeasurePatch`
          // for why the remaining series are preserved and why clearing writes `ySeries: []`
          // rather than a placeholder entry.
          commitFieldConfig(
            buildSingleMeasurePatch('heatmap', config, fieldId, widgetSourceId),
            fieldId ? sourceId : undefined,
          );
        }}
        fields={numericFields}
        label={localeText.chartSetupHeatmapValueLabel}
        helperText={localeText.chartSetupHeatmapValueHelperText}
        required
      />
      <FormControl size="small" fullWidth>
        <InputLabel id={colourSchemeLabelId}>
          {localeText.chartSetupHeatmapColourSchemeLabel}
        </InputLabel>
        <Select
          labelId={colourSchemeLabelId}
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
          <InputLabel id={sortByLabelId}>{localeText.chartSetupHeatmapSortByLabel}</InputLabel>
          <Select
            labelId={sortByLabelId}
            label={localeText.chartSetupHeatmapSortByLabel}
            value={config.heatSortBy ?? 'natural'}
            onChange={(evt) =>
              controller.updateWidgetConfig(widgetId, {
                heatSortBy: evt.target.value as 'x-axis' | 'y-axis' | 'natural',
              })
            }
            SelectDisplayProps={{
              title: (() => {
                const v = config.heatSortBy ?? 'natural';
                if (v === 'x-axis') {
                  return heatXFieldLabel ?? localeText.chartSetupHeatmapSortXAxis;
                }
                if (v === 'y-axis') {
                  return heatYFieldLabel ?? localeText.chartSetupHeatmapSortYAxis;
                }
                return localeText.chartSetupSortNatural;
              })(),
            }}
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
          <SortDirectionToggle
            value={config.heatSortDirection ?? 'asc'}
            disabled={!heatAxesSet}
            onChange={(val) => controller.updateWidgetConfig(widgetId, { heatSortDirection: val })}
          />
        )}
      </Stack>
    </React.Fragment>
  );
}
