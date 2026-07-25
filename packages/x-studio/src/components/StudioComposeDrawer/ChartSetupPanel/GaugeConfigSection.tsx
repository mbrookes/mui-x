'use client';
import * as React from 'react';
import { FormControl, InputLabel, MenuItem, Select, Stack, TextField } from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import { fieldsForCapability } from '../../../utils/fieldCapabilities';
import type {
  StudioChartConfigOfType,
  StudioFilterState,
  StudioRelationship,
} from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';
import { collectStaleWidgetFilterIds } from '../collectStaleWidgetFilterIds';
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
  // Set when a commit REJECTED the typed value and snapped the field back. The revert is
  // otherwise indistinguishable from "nothing happened", so the user retypes the same
  // out-of-range value and watches it vanish again. Advisory only — it explains the
  // already-applied revert, mirroring `FilterSetupPanel`'s cross-bound messages.
  const [minNotice, setMinNotice] = React.useState<string | undefined>(undefined);
  const [maxNotice, setMaxNotice] = React.useState<string | undefined>(undefined);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed gaugeMin; resync on external change (widget switch, undo/redo, the sibling field's commit re-deriving this one)
  React.useEffect(() => {
    setMinText(String(gaugeMin));
    setMinDirty(false);
    setMinNotice(undefined);
  }, [gaugeMin, widgetId]);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- see above, for gaugeMax
  React.useEffect(() => {
    setMaxText(String(gaugeMax));
    setMaxDirty(false);
    setMaxNotice(undefined);
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
    setMinNotice(valid ? undefined : localeText.chartSetupGaugeMinRevertedHelperText);
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
    setMaxNotice(valid ? undefined : localeText.chartSetupGaugeMaxRevertedHelperText);
    setMaxDirty(false);
  };

  return (
    <Stack spacing={2}>
      <DataSourceFieldSelect
        value={config.yField ?? ''}
        onChange={(fieldId, sourceId) => {
          // A cross-source value-field pick also ADOPTS that source, and the two halves are
          // one undo step (finding 2.5) carrying only the changed key — see
          // `commitChartConfigWithSource`. Any widget-scoped filter that no longer resolves
          // against the new source rides along (finding 1.16): left in place, a stale
          // filter's field is absent from the new source's rows and the `between`/`gte`
          // branches in `filterUtils.ts` then exclude EVERY row, silently blanking the gauge.
          commitChartConfigWithSource({
            controller,
            widgetId,
            configPatch: { yField: fieldId },
            sourceId,
            widgetSourceId,
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
          value={minText}
          error={minNotice !== undefined}
          helperText={minNotice}
          onChange={(evt) => {
            setMinText(evt.target.value);
            setMinDirty(true);
            setMinNotice(undefined);
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
          error={maxNotice !== undefined}
          helperText={maxNotice}
          onChange={(evt) => {
            setMaxText(evt.target.value);
            setMaxDirty(true);
            setMaxNotice(undefined);
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
