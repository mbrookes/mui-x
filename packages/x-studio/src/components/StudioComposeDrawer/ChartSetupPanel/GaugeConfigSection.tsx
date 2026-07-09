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

  const gaugeMin = config.gaugeMin ?? 0;
  const gaugeMax = config.gaugeMax ?? 100;

  // Local text buffers for the min/max inputs (architecture review finding 1.14):
  // validating on every keystroke against the OTHER committed bound made it
  // impossible to type a multi-digit min/max one keystroke at a time whenever an
  // intermediate digit transiently violated the bound, and made the field
  // impossible to clear. Buffer the displayed text locally and only parse/
  // validate/commit on blur (mirrors `FormatPanel.tsx`'s grid-height input).
  const [minText, setMinText] = React.useState(String(gaugeMin));
  const [minDirty, setMinDirty] = React.useState(false);
  const [maxText, setMaxText] = React.useState(String(gaugeMax));
  const [maxDirty, setMaxDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed gaugeMin; resync on external change (widget switch, undo/redo, the sibling field's commit re-deriving this one)
  React.useEffect(() => {
    setMinText(String(gaugeMin));
    setMinDirty(false);
  }, [gaugeMin, widgetId]);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- see above, for gaugeMax
  React.useEffect(() => {
    setMaxText(String(gaugeMax));
    setMaxDirty(false);
  }, [gaugeMax, widgetId]);

  const commitMin = () => {
    if (!minDirty) {
      return;
    }
    const raw = minText.trim();
    const parsed = raw === '' ? NaN : Number(raw);
    const valid = !Number.isNaN(parsed) && parsed < gaugeMax;
    if (valid && parsed !== gaugeMin) {
      controller.updateWidgetConfig(widgetId, { gaugeMin: parsed });
    }
    setMinText(String(valid ? parsed : gaugeMin));
    setMinDirty(false);
  };

  const commitMax = () => {
    if (!maxDirty) {
      return;
    }
    const raw = maxText.trim();
    const parsed = raw === '' ? NaN : Number(raw);
    const valid = !Number.isNaN(parsed) && parsed > gaugeMin;
    if (valid && parsed !== gaugeMax) {
      controller.updateWidgetConfig(widgetId, { gaugeMax: parsed });
    }
    setMaxText(String(valid ? parsed : gaugeMax));
    setMaxDirty(false);
  };

  return (
    <Stack spacing={2}>
      <DataSourceFieldSelect
        value={config.yField ?? ''}
        onChange={(fieldId, sourceId) => {
          const configUpdate = { yField: fieldId };
          // When the picked field belongs to a different source, adopt that source AND
          // write the field in ONE `updateWidget` commit so the cross-source field pick
          // is a single undo step (finding 2.5) — writing them as two separate commits
          // (`updateWidgetConfig` then `updateWidget`) left a lone Ctrl+Z landing on a
          // torn `{ old sourceId, new yField }` state the UI never produced. Every
          // sibling setup panel (Chart/KPI/Filter/Map) already folds this the same way.
          if (sourceId && sourceId !== widgetSourceId) {
            controller.updateWidget(widgetId, {
              sourceId,
              config: { ...config, ...configUpdate },
            });
          } else {
            controller.updateWidgetConfig(widgetId, configUpdate);
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
          value={minText}
          onChange={(evt) => {
            setMinText(evt.target.value);
            setMinDirty(true);
          }}
          onBlur={commitMin}
          onKeyDown={(evt) => {
            if (evt.key === 'Enter') {
              commitMin();
            }
          }}
          sx={{ flex: 1, minWidth: 0 }}
        />
        <TextField
          size="small"
          label={localeText.chartSetupMaxLabel}
          type="number"
          value={maxText}
          onChange={(evt) => {
            setMaxText(evt.target.value);
            setMaxDirty(true);
          }}
          onBlur={commitMax}
          onKeyDown={(evt) => {
            if (evt.key === 'Enter') {
              commitMax();
            }
          }}
          sx={{ flex: 1, minWidth: 0 }}
        />
      </Stack>
    </Stack>
  );
}
