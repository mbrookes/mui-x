'use client';
import * as React from 'react';
import { Stack, TextField } from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioChartConfigOfType } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';

/**
 * Scatter min/max radius numeric input (architecture review finding 2.3): committing
 * `Number(v) || 4` (or `|| 40`) on every keystroke made each digit an undoable commit
 * plus a mutation-log line plus a full pipeline recompute, AND snapped a momentarily
 * cleared input straight to the fallback default instead of allowing an in-progress
 * empty state — the exact bug class the buffer-then-commit-on-blur pattern elsewhere
 * exists to prevent. Buffer the displayed text locally and only parse/commit on
 * blur/Enter, mirroring `GaugeConfigSection.tsx`'s min/max inputs.
 */
function RadiusInput(props: {
  value: number;
  label: string;
  min: number;
  max: number;
  onCommit: (next: number) => void;
}) {
  const { value, label, min, max, onCommit } = props;
  const [text, setText] = React.useState(String(value));
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed radius; resync on external change (widget switch, undo/redo)
  React.useEffect(() => {
    setText(String(value));
    setDirty(false);
  }, [value]);

  const commit = () => {
    if (!dirty) {
      return;
    }
    const raw = text.trim();
    const parsed = raw === '' ? NaN : Number(raw);
    if (!Number.isNaN(parsed)) {
      if (parsed !== value) {
        onCommit(parsed);
      }
      setText(String(parsed));
    } else {
      // An unparseable/emptied field reverts to the last committed value rather
      // than silently snapping to the fallback default mid-edit.
      setText(String(value));
    }
    setDirty(false);
  };

  return (
    <TextField
      size="small"
      label={label}
      type="number"
      value={text}
      onChange={(evt) => {
        setText(evt.target.value);
        setDirty(true);
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
          controller.updateWidgetConfig(widgetId, {
            yField: fieldId,
            ySeries: [{ fieldId }],
          });
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
            value={config.scatterMinRadius ?? 4}
            label={localeText.chartSetupMinRadiusLabel}
            min={1}
            max={50}
            onCommit={(next) => controller.updateWidgetConfig(widgetId, { scatterMinRadius: next })}
          />
          <RadiusInput
            value={config.scatterMaxRadius ?? 40}
            label={localeText.chartSetupMaxRadiusLabel}
            min={1}
            max={100}
            onCommit={(next) => controller.updateWidgetConfig(widgetId, { scatterMaxRadius: next })}
          />
        </Stack>
      )}
    </React.Fragment>
  );
}
