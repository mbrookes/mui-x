'use client';
import * as React from 'react';
import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioChartConfig, StudioChartConfigOfType } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';
import { useBufferedInput } from '../useBufferedInput';
import { buildSingleMeasurePatch } from './commitMeasureSeries';

export interface FunnelConfigSectionProps {
  widgetId: string;
  config: StudioChartConfigOfType<'funnel'>;
  numericFields: DataSourceFieldEntry[];
  /** First configured Y-series field id, used as the fallback for the single value-field picker. */
  firstYSeriesFieldId?: string;
  /** The widget's current source id — the `yField` mirror's own-source test. */
  widgetSourceId?: string;
  /**
   * H3: the ONE write path for this section's field picker, supplied by `ChartSetupPanel`.
   * It routes through `commitChartConfigWithSource`, so a value-field pick on a source-less
   * funnel adopts that field's source instead of leaving the widget permanently blank.
   */
  commitFieldConfig: (
    configPatch: Partial<StudioChartConfig>,
    /** The picked field's source, or `undefined` when the gesture clears the field. */
    sourceId: string | undefined,
  ) => void;
}

/**
 * Section-gap numeric input (architecture review finding 2.3): committing
 * `Math.max(0, Math.min(32, Number(v)))` on every keystroke made each digit an
 * undoable commit plus a mutation-log line plus a full pipeline recompute. Buffer
 * the displayed text locally and only parse/clamp/commit on blur/Enter, mirroring
 * `GaugeConfigSection.tsx`'s min/max inputs.
 */
function FunnelGapInput(props: {
  widgetId: string;
  value: number;
  label: string;
  /** Message shown when a typed value had to be adjusted to fit the 0–32 range. */
  clampedHelperText: (clamped: number) => string;
  onCommit: (next: number | undefined) => void;
}) {
  const { widgetId, value, label, clampedHelperText, onCommit } = props;
  // Shared dirty-aware buffer (M15). `notice` is set when a commit CHANGED the typed value to
  // fit the range — without it the clamp is indistinguishable from "nothing happened" and the
  // user retypes the same rejected value. Advisory only: it explains the already-applied
  // clamp, mirroring `FilterSetupPanel`'s cross-bound messages.
  const {
    value: text,
    dirty,
    notice,
    setValue,
    settle,
  } = useBufferedInput(String(value), `${widgetId}:funnelGap`);

  const commit = () => {
    if (!dirty) {
      return;
    }
    const raw = text.trim();
    const parsed = raw === '' ? NaN : Number(raw);
    if (!Number.isNaN(parsed)) {
      const clamped = Math.max(0, Math.min(32, parsed));
      if (clamped !== value) {
        // `0` is the documented default, so it is stored as "unset" rather than persisted
        // explicitly. Written as an explicit `=== 0` test, not `clamped || undefined`: a
        // truthiness test on a numeric bound is the shape that silently swallows a legitimate
        // zero the day the default stops being 0.
        onCommit(clamped === 0 ? undefined : clamped);
      }
      settle(String(clamped), clamped === parsed ? undefined : clampedHelperText(clamped));
    } else {
      settle(String(value), clampedHelperText(value));
    }
  };

  return (
    <TextField
      size="small"
      type="number"
      label={label}
      value={text}
      error={notice !== undefined}
      helperText={notice}
      onChange={(evt) => {
        setValue(evt.target.value);
      }}
      onBlur={commit}
      onKeyDown={(evt) => {
        if (evt.key === 'Enter') {
          commit();
        }
      }}
      slotProps={{ htmlInput: { min: 0, max: 32, step: 1 } }}
      fullWidth
    />
  );
}

/** Funnel chart setup: value field plus label format/placement, shape, style, and gap. */
export function FunnelConfigSection({
  widgetId,
  config,
  numericFields,
  firstYSeriesFieldId,
  widgetSourceId,
  commitFieldConfig,
}: FunnelConfigSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  // See `ChartSetupPanel`'s own `React.useId` block: MUI's `Select` only exposes an
  // accessible name when it is handed a `labelId` pairing it with its `InputLabel`.
  const labelFormatLabelId = React.useId();
  const labelPlacementLabelId = React.useId();
  const shapeLabelId = React.useId();

  return (
    <React.Fragment>
      <DataSourceFieldSelect
        value={config.yField ?? firstYSeriesFieldId ?? ''}
        onChange={(fieldId, sourceId) => {
          // Single-measure picker over a multi-series config — see `buildSingleMeasurePatch`
          // for why the remaining series are preserved and why clearing writes `ySeries: []`
          // rather than a placeholder entry.
          commitFieldConfig(
            buildSingleMeasurePatch('funnel', config, fieldId, widgetSourceId),
            fieldId ? sourceId : undefined,
          );
        }}
        fields={numericFields}
        label={localeText.chartSetupValueFieldLabel}
        helperText={localeText.chartSetupFunnelValueHelperText}
        required
      />
      <FormControl size="small" fullWidth>
        <InputLabel id={labelFormatLabelId}>
          {localeText.chartSetupFunnelLabelFormatLabel}
        </InputLabel>
        <Select
          labelId={labelFormatLabelId}
          label={localeText.chartSetupFunnelLabelFormatLabel}
          value={config.funnelLabelFormat ?? 'value'}
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              funnelLabelFormat: evt.target.value as 'value' | 'percent' | 'conversion',
              ...(evt.target.value === 'conversion' && !config.funnelLabelPlacement
                ? { funnelLabelPlacement: 'outside-end' as const }
                : {}),
            })
          }
        >
          <MenuItem value="value">{localeText.chartSetupFunnelLabelFormatValue}</MenuItem>
          <MenuItem value="percent">{localeText.chartSetupFunnelLabelFormatPercent}</MenuItem>
          <MenuItem value="conversion">{localeText.chartSetupFunnelLabelFormatConversion}</MenuItem>
        </Select>
      </FormControl>
      <FormControl size="small" fullWidth>
        <InputLabel id={labelPlacementLabelId}>
          {localeText.chartSetupFunnelLabelPlacementLabel}
        </InputLabel>
        <Select
          labelId={labelPlacementLabelId}
          label={localeText.chartSetupFunnelLabelPlacementLabel}
          value={
            config.funnelLabelPlacement ??
            (config.funnelLabelFormat === 'conversion' ? 'outside-end' : 'inside')
          }
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              funnelLabelPlacement: evt.target.value as 'inside' | 'outside-start' | 'outside-end',
            })
          }
        >
          <MenuItem value="inside">{localeText.chartSetupFunnelLabelPlacementInside}</MenuItem>
          <MenuItem value="outside-start">
            {localeText.chartSetupFunnelLabelPlacementOutsideStart}
          </MenuItem>
          <MenuItem value="outside-end">
            {localeText.chartSetupFunnelLabelPlacementOutsideEnd}
          </MenuItem>
        </Select>
      </FormControl>
      <FormControl size="small" fullWidth>
        <InputLabel id={shapeLabelId}>{localeText.chartSetupFunnelShapeLabel}</InputLabel>
        <Select
          labelId={shapeLabelId}
          label={localeText.chartSetupFunnelShapeLabel}
          value={config.funnelCurve ?? 'linear'}
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              funnelCurve: evt.target.value as 'linear' | 'bump' | 'step' | 'pyramid',
            })
          }
        >
          <MenuItem value="linear">{localeText.chartSetupFunnelShapeLinear}</MenuItem>
          <MenuItem value="bump">{localeText.chartSetupFunnelShapeBump}</MenuItem>
          <MenuItem value="step">{localeText.chartSetupFunnelShapeStep}</MenuItem>
          <MenuItem value="pyramid">{localeText.chartSetupFunnelShapePyramid}</MenuItem>
        </Select>
      </FormControl>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="body2" sx={{ flex: 1 }}>
          {localeText.chartSetupFunnelStyleLabel}
        </Typography>
        <ToggleButtonGroup
          value={config.funnelVariant ?? 'filled'}
          exclusive
          onChange={(_e, val) => {
            if (val) {
              controller.updateWidgetConfig(widgetId, {
                funnelVariant: val as 'filled' | 'outlined',
              });
            }
          }}
          size="small"
        >
          <ToggleButton value="filled" sx={{ textTransform: 'none' }}>
            {localeText.chartSetupFunnelStyleFilled}
          </ToggleButton>
          <ToggleButton value="outlined" sx={{ textTransform: 'none' }}>
            {localeText.chartSetupFunnelStyleOutlined}
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <FunnelGapInput
        widgetId={widgetId}
        value={config.funnelGap ?? 0}
        label={localeText.chartSetupFunnelGapLabel}
        clampedHelperText={localeText.chartSetupValueClampedHelperText}
        onCommit={(next) => controller.updateWidgetConfig(widgetId, { funnelGap: next })}
      />
    </React.Fragment>
  );
}
