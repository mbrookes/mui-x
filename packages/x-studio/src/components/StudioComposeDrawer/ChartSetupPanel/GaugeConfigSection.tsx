'use client';
import * as React from 'react';
import { FormControl, InputLabel, MenuItem, Select, Stack, TextField } from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import { fieldsForCapability } from '../../../utils/fieldCapabilities';
import type { StudioChartConfigOfType } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';

export interface GaugeConfigSectionProps {
  widgetId: string;
  config: StudioChartConfigOfType<'gauge'>;
  /** Every visible physical + expression field (gauge is not source-anchored, unlike other chart types). */
  allFields: DataSourceFieldEntry[];
  /** The widget's current source id, used to detect a cross-source field pick. */
  widgetSourceId?: string;
}

/** Gauge chart setup: single value field, aggregation, and min/max range. */
export function GaugeConfigSection({
  widgetId,
  config,
  allFields,
  widgetSourceId,
}: GaugeConfigSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  return (
    <Stack spacing={2}>
      <DataSourceFieldSelect
        value={config.yField ?? ''}
        onChange={(fieldId, sourceId) => {
          controller.updateWidgetConfig(widgetId, { yField: fieldId });
          if (sourceId && sourceId !== widgetSourceId) {
            controller.updateWidget(widgetId, { sourceId });
          }
        }}
        fields={fieldsForCapability(allFields, 'numeric')}
        label={localeText.chartSetupValueFieldLabel}
        helperText={localeText.chartSetupValueFieldHelperText}
        required
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
          onChange={(evt) => {
            // Validate before writing (matching the Funnel/Scatter/PieArcLabels
            // sections): reject NaN and keep min strictly below max so an invalid
            // gaugeMin > gaugeMax range can't be persisted (finding 3.4).
            const parsed = Number(evt.target.value);
            if (Number.isNaN(parsed) || parsed >= (config.gaugeMax ?? 100)) {
              return;
            }
            controller.updateWidgetConfig(widgetId, { gaugeMin: parsed });
          }}
          sx={{ flex: 1, minWidth: 0 }}
        />
        <TextField
          size="small"
          label={localeText.chartSetupMaxLabel}
          type="number"
          value={config.gaugeMax ?? 100}
          onChange={(evt) => {
            const parsed = Number(evt.target.value);
            if (Number.isNaN(parsed) || parsed <= (config.gaugeMin ?? 0)) {
              return;
            }
            controller.updateWidgetConfig(widgetId, { gaugeMax: parsed });
          }}
          sx={{ flex: 1, minWidth: 0 }}
        />
      </Stack>
    </Stack>
  );
}
