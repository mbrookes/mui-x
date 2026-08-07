'use client';
import * as React from 'react';
import { FormControl, InputLabel, MenuItem, Select, Stack, TextField } from '@mui/material';
import { fieldsForCapability } from '@mui/x-studio-core/utils';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type {
  StudioChartConfigOfType,
  StudioFilterState,
  StudioRelationship,
} from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';
import { collectStaleWidgetFilterIds } from '../collectStaleWidgetFilterIds';
import { useBufferedInput } from '../useBufferedInput';
import { commitChartConfigWithSource } from './commitConfigWithSource';

export interface GaugeConfigSectionProps {
  widgetId: string;
  config: StudioChartConfigOfType<'gauge'>;
  /** Every visible physical + expression field (gauge is not source-anchored, unlike other chart types). */
  allFields: DataSourceFieldEntry[];
  /** The widget's current source id, used to detect a cross-source field pick. */
  widgetSourceId?: string;
  /** All filters in the doc — used to fold stale widget-scoped filter removal into the source switch. */
  allFilters?: StudioFilterState[];
  /** Declared relationships — used for source reachability when computing stale filters. */
  relationships?: StudioRelationship[];
}

/** Gauge chart setup: single value field, aggregation, and min/max range. */
export function GaugeConfigSection({
  widgetId,
  config,
  allFields,
  widgetSourceId,
  allFilters,
  relationships,
}: GaugeConfigSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  // See `ChartSetupPanel`'s own `React.useId` block: MUI's `Select` only exposes an
  // accessible name when it is handed a `labelId` pairing it with its `InputLabel`.
  const aggregationLabelId = React.useId();

  const gaugeMin = config.gaugeMin ?? 0;
  const gaugeMax = config.gaugeMax ?? 100;

  // Local text buffers for the min/max inputs: validating on every keystroke against the OTHER
  // committed bound made it impossible to type a multi-digit min/max one keystroke at a time
  // whenever an intermediate digit transiently violated the bound, and made the field impossible to
  // clear. Buffer the displayed text locally and only parse/ validate/commit on blur, through the
  // shared dirty-aware `useBufferedInput` so an external write (the AI chat panel's
  // `update_widget`, an undo) can't discard the half-typed bound. `notice` is set when a commit
  // REJECTED the typed value and snapped the field back — the revert is otherwise indistinguishable
  // from "nothing happened", so the user retypes the same out-of-range value and watches it vanish
  // again.
  const min = useBufferedInput(String(gaugeMin), `${widgetId}:gaugeMin`);
  const max = useBufferedInput(String(gaugeMax), `${widgetId}:gaugeMax`);

  const commitMin = () => {
    if (!min.dirty) {
      return;
    }
    const raw = min.value.trim();
    const parsed = raw === '' ? NaN : Number(raw);
    const valid = !Number.isNaN(parsed) && parsed < gaugeMax;
    if (valid && parsed !== gaugeMin) {
      controller.updateWidgetConfig(widgetId, { gaugeMin: parsed });
    }
    min.settle(
      String(valid ? parsed : gaugeMin),
      valid ? undefined : localeText.chartSetupGaugeMinRevertedHelperText,
    );
  };

  const commitMax = () => {
    if (!max.dirty) {
      return;
    }
    const raw = max.value.trim();
    const parsed = raw === '' ? NaN : Number(raw);
    const valid = !Number.isNaN(parsed) && parsed > gaugeMin;
    if (valid && parsed !== gaugeMax) {
      controller.updateWidgetConfig(widgetId, { gaugeMax: parsed });
    }
    max.settle(
      String(valid ? parsed : gaugeMax),
      valid ? undefined : localeText.chartSetupGaugeMaxRevertedHelperText,
    );
  };

  return (
    <Stack spacing={2}>
      <DataSourceFieldSelect
        value={config.yField ?? ''}
        onChange={(fieldId, sourceId) => {
          // A cross-source value-field pick also ADOPTS that source, and the two halves are
          // one undo step carrying only the changed key — see
          // `commitChartConfigWithSource`. Any widget-scoped filter that no longer resolves
          // against the new source rides along: left in place, a stale
          // filter's field is absent from the new source's rows and the `between`/`gte`
          // branches in `filterUtils.ts` then exclude EVERY row, silently blanking the gauge.
          commitChartConfigWithSource({
            controller,
            widgetId,
            configPatch: { yField: fieldId },
            sourceId: fieldId ? sourceId : undefined,
            widgetSourceId,
            // Gauge has no X field, so its value picker IS the chart's source anchor: any
            // cross-source pick re-anchors the widget.
            adopt: 'anchor',
            removeFilterIds:
              sourceId && sourceId !== widgetSourceId
                ? collectStaleWidgetFilterIds(
                    allFilters,
                    widgetId,
                    sourceId,
                    allFields,
                    relationships ?? [],
                  )
                : undefined,
          });
        }}
        fields={fieldsForCapability(allFields, 'numeric')}
        label={localeText.chartSetupValueFieldLabel}
        helperText={localeText.chartSetupValueFieldHelperText}
        required
      />

      <FormControl size="small" fullWidth>
        <InputLabel id={aggregationLabelId}>{localeText.chartSetupAggregationLabel}</InputLabel>
        <Select
          labelId={aggregationLabelId}
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
          value={min.value}
          error={min.notice !== undefined}
          helperText={min.notice}
          onChange={(evt) => {
            min.setValue(evt.target.value);
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
          value={max.value}
          error={max.notice !== undefined}
          helperText={max.notice}
          onChange={(evt) => {
            max.setValue(evt.target.value);
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
