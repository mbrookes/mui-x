'use client';
import * as React from 'react';
import {
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioChartConfigOfType } from '../../../models';
import { useBufferedInput } from '../useBufferedInput';

export interface PieArcLabelsSectionProps {
  widgetId: string;
  config: StudioChartConfigOfType<'pie'>;
}

/**
 * Minimum-angle numeric input (architecture review finding 2.3): committing
 * `Math.max(0, Number(v))` on every keystroke made each digit an undoable commit
 * plus a mutation-log line plus a full pipeline recompute. Buffer the displayed
 * text locally and only parse/clamp/commit on blur/Enter, mirroring
 * `GaugeConfigSection.tsx`'s min/max inputs.
 */
function MinAngleInput(props: {
  widgetId: string;
  value: number;
  label: string;
  helperText: string;
  /** Message shown, in place of `helperText`, when a typed value had to be adjusted. */
  clampedHelperText: (clamped: number) => string;
  onCommit: (next: number) => void;
}) {
  const { widgetId, value, label, helperText, clampedHelperText, onCommit } = props;
  // Shared dirty-aware buffer (M15). `notice` is set when a commit CHANGED the typed value to
  // fit the range — without it the clamp is indistinguishable from "nothing happened" and the
  // user retypes the same rejected value. Advisory only, and it replaces the standing helper
  // text so the field never shows two competing hints at once.
  const {
    value: text,
    dirty,
    notice,
    setValue,
    settle,
  } = useBufferedInput(String(value), `${widgetId}:pieArcLabelMinAngle`);

  const commit = () => {
    if (!dirty) {
      return;
    }
    const raw = text.trim();
    const parsed = raw === '' ? NaN : Number(raw);
    if (!Number.isNaN(parsed)) {
      const clamped = Math.max(0, parsed);
      if (clamped !== value) {
        onCommit(clamped);
      }
      settle(String(clamped), clamped === parsed ? undefined : clampedHelperText(clamped));
    } else {
      settle(String(value), clampedHelperText(value));
    }
  };

  return (
    <TextField
      size="small"
      label={label}
      type="number"
      value={text}
      error={notice !== undefined}
      helperText={notice ?? helperText}
      onChange={(evt) => {
        setValue(evt.target.value);
      }}
      onBlur={commit}
      onKeyDown={(evt) => {
        if (evt.key === 'Enter') {
          commit();
        }
      }}
      slotProps={{ htmlInput: { min: 0, max: 180 } }}
    />
  );
}

/** Pie / donut chart setup: arc label content (none/value/percent) and minimum-angle threshold. */
export function PieArcLabelsSection({ widgetId, config }: PieArcLabelsSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  // See `ChartSetupPanel`'s own `React.useId` block: MUI's `Select` only exposes an
  // accessible name when it is handed a `labelId` pairing it with its `InputLabel`.
  const arcLabelLabelId = React.useId();

  return (
    <React.Fragment>
      <Divider />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        {localeText.chartSetupArcLabelsTitle}
      </Typography>
      <FormControl size="small" fullWidth>
        <InputLabel id={arcLabelLabelId}>{localeText.chartSetupArcLabelLabel}</InputLabel>
        <Select
          labelId={arcLabelLabelId}
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
        <MinAngleInput
          widgetId={widgetId}
          value={config.pieArcLabelMinAngle ?? 20}
          label={localeText.chartSetupMinAngleLabel}
          helperText={localeText.chartSetupMinAngleHelperText}
          clampedHelperText={localeText.chartSetupValueClampedHelperText}
          onCommit={(next) =>
            controller.updateWidgetConfig(widgetId, { pieArcLabelMinAngle: next })
          }
        />
      )}
    </React.Fragment>
  );
}
