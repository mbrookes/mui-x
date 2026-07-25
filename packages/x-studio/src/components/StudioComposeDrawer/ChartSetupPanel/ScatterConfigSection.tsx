'use client';
import * as React from 'react';
import { Stack, TextField } from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioChartConfigOfType } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';
import { buildSingleMeasurePatch } from './commitMeasureSeries';

/**
 * Scatter min/max radius numeric input (architecture review finding 2.3): committing
 * `Number(v) || 4` (or `|| 40`) on every keystroke made each digit an undoable commit
 * plus a mutation-log line plus a full pipeline recompute, AND snapped a momentarily
 * cleared input straight to the fallback default instead of allowing an in-progress
 * empty state — the exact bug class the buffer-then-commit-on-blur pattern elsewhere
 * exists to prevent. Buffer the displayed text locally and only parse/commit on
 * blur/Enter, mirroring `GaugeConfigSection.tsx`'s min/max inputs.
 *
 * Finding 8 (architecture review): the previous version parsed and committed ANY finite
 * number — the `min`/`max` passed via `slotProps.htmlInput` only constrain the spinner
 * BUTTONS (native browser behavior), not typed keyboard input, and there was no
 * `minRadius <= maxRadius` cross-check at all, so typing could commit e.g.
 * `scatterMinRadius: -5` or a min greater than max. Validate the parsed value against
 * BOTH the advertised `[min, max]` range AND the other bound (`otherBound`/`kind`),
 * reverting to the last-committed value on an invalid entry — mirroring
 * `GaugeConfigSection.tsx`'s `commitMin`/`commitMax`, which reject-and-revert rather than
 * clamp to the nearest boundary.
 */
function RadiusInput(props: {
  widgetId: string;
  value: number;
  label: string;
  min: number;
  max: number;
  /** The sibling bound's current committed value, for a min-less-than-max cross-check. */
  otherBound: number;
  /** Which side of the min/max pair this input is, to pick the cross-check direction. */
  kind: 'min' | 'max';
  /** Builds the message shown when a typed value was rejected and the field snapped back. */
  revertedHelperText: (min: number, max: number) => string;
  onCommit: (next: number) => void;
}) {
  const { widgetId, value, label, min, max, otherBound, kind, revertedHelperText, onCommit } =
    props;
  const [text, setText] = React.useState(String(value));
  const [dirty, setDirty] = React.useState(false);
  // Set when a commit REJECTED the typed value and snapped the field back. The revert is
  // otherwise indistinguishable from "nothing happened", so the user retypes the same
  // out-of-range value and watches it vanish again. Advisory only — it explains the
  // already-applied revert, mirroring `FilterSetupPanel`'s cross-bound messages.
  const [notice, setNotice] = React.useState<string | undefined>(undefined);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed radius; resync on external change (widget switch, undo/redo). `widgetId` must be in the deps (not just `value`) — a widget switch that lands on the SAME radius value would otherwise leave a still-dirty buffer from the previous widget uncommitted into the new one.
  React.useEffect(() => {
    setText(String(value));
    setDirty(false);
    setNotice(undefined);
  }, [value, widgetId]);

  const commit = () => {
    if (!dirty) {
      return;
    }
    const raw = text.trim();
    const parsed = raw === '' ? NaN : Number(raw);
    const inRange = !Number.isNaN(parsed) && parsed >= min && parsed <= max;
    const crossValid = kind === 'min' ? parsed < otherBound : parsed > otherBound;
    const valid = inRange && crossValid;
    if (valid && parsed !== value) {
      onCommit(parsed);
    }
    // An unparseable/emptied/out-of-range/cross-invalid entry reverts to the last
    // committed value rather than silently clamping to a boundary or the fallback default.
    setText(String(valid ? parsed : value));
    setNotice(valid ? undefined : revertedHelperText(min, max));
    setDirty(false);
  };

  return (
    <TextField
      size="small"
      label={label}
      type="number"
      value={text}
      error={notice !== undefined}
      helperText={notice}
      onChange={(evt) => {
        setText(evt.target.value);
        setDirty(true);
        setNotice(undefined);
      }}
      onBlur={commit}
      onKeyDown={(evt) => {
        if (evt.key === 'Enter') {
          commit();
        }
      }}
      slotProps={{ htmlInput: { min, max } }}
      sx={{ flex: 1, minWidth: 0 }}
    />
  );
}

export interface ScatterConfigSectionProps {
  widgetId: string;
  config: StudioChartConfigOfType<'scatter'>;
  numericFields: DataSourceFieldEntry[];
  categoryFields: DataSourceFieldEntry[];
  /** First configured Y-series field id, used as the fallback for the single Y-field picker. */
  firstYSeriesFieldId?: string;
}

/** Scatter chart setup: single Y field plus optional colour-by and size-by fields. */
export function ScatterConfigSection({
  widgetId,
  config,
  numericFields,
  categoryFields,
  firstYSeriesFieldId,
}: ScatterConfigSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  return (
    <React.Fragment>
      <DataSourceFieldSelect
        value={config.yField ?? firstYSeriesFieldId ?? ''}
        onChange={(fieldId) => {
          // Single-measure picker over a multi-series config — see `buildSingleMeasurePatch`
          // for why the remaining series are preserved and why clearing writes `ySeries: []`
          // rather than a placeholder entry.
          controller.updateWidgetConfig(
            widgetId,
            buildSingleMeasurePatch('scatter', config, fieldId),
          );
        }}
        fields={numericFields}
        label={localeText.chartSetupYFieldLabel}
        helperText={localeText.chartSetupYFieldHelperText}
        required
      />
      <DataSourceFieldSelect
        value={config.scatterColorField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, {
            scatterColorField: fieldId || undefined,
          })
        }
        fields={categoryFields}
        label={localeText.chartSetupColorByLabel}
        helperText={localeText.chartSetupColorByHelperText}
      />
      <DataSourceFieldSelect
        value={config.scatterSizeField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, {
            scatterSizeField: fieldId || undefined,
          })
        }
        fields={numericFields}
        label={localeText.chartSetupSizeByLabel}
        helperText={localeText.chartSetupSizeByHelperText}
      />
      {config.scatterSizeField && (
        <Stack direction="row" spacing={1}>
          <RadiusInput
            widgetId={widgetId}
            value={config.scatterMinRadius ?? 4}
            label={localeText.chartSetupMinRadiusLabel}
            min={1}
            max={50}
            otherBound={config.scatterMaxRadius ?? 40}
            kind="min"
            revertedHelperText={localeText.chartSetupRadiusRevertedHelperText}
            onCommit={(next) => controller.updateWidgetConfig(widgetId, { scatterMinRadius: next })}
          />
          <RadiusInput
            widgetId={widgetId}
            value={config.scatterMaxRadius ?? 40}
            label={localeText.chartSetupMaxRadiusLabel}
            min={1}
            max={100}
            otherBound={config.scatterMinRadius ?? 4}
            kind="max"
            revertedHelperText={localeText.chartSetupRadiusRevertedHelperText}
            onCommit={(next) => controller.updateWidgetConfig(widgetId, { scatterMaxRadius: next })}
          />
        </Stack>
      )}
    </React.Fragment>
  );
}
