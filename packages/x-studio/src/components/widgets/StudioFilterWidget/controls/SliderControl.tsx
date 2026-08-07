'use client';
import * as React from 'react';
import { Box, Slider } from '@mui/material';
import { getStudioLocale } from '@mui/x-studio-core/engine';
import { useStudioLocaleText } from '../../../../internals/StudioUIConfigContext';

export interface StudioFilterSliderControlProps {
  label: string;
  min: number;
  max: number;
  step: number;
  isDate?: boolean;
  currentValue: { from?: number; to?: number } | null;
  onApply: (lo: number, hi: number) => void;
  onClear: () => void;
}

export function SliderControl(props: StudioFilterSliderControlProps) {
  const {
    label,
    min: rawMin,
    max: rawMax,
    step: rawStep,
    isDate,
    currentValue,
    onApply,
    onClear,
  } = props;
  const localeText = useStudioLocaleText();
  // Defensive backstop for direct/custom-slot callers: `StudioFilterWidget` already sanitizes
  // these, but this component is exported and could be rendered with raw config. `min >= max`
  // gives an inverted, unusable range; `step <= 0`/`NaN` makes the MUI Slider's internal rounding
  // produce NaN thumb positions and `aria-valuenow` (finding).
  let min = Number.isFinite(rawMin) ? rawMin : 0;
  let max = Number.isFinite(rawMax) ? rawMax : 100;
  if (min > max) {
    [min, max] = [max, min];
  }
  if (min === max) {
    min = 0;
    max = 100;
  }
  const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 1;
  const [localValue, setLocalValue] = React.useState<[number, number]>([
    currentValue?.from ?? min,
    currentValue?.to ?? max,
  ]);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- slider buffers interaction locally; reset when external value or range changes
  React.useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-derived-state -- local state buffers slider interaction before commit
    setLocalValue([currentValue?.from ?? min, currentValue?.to ?? max]);
  }, [currentValue?.from, currentValue?.to, min, max]);

  const handleSliderChange = (_event: Event, newValue: number | number[]) => {
    setLocalValue(newValue as [number, number]);
  };

  const handleChangeCommitted = (
    _event: React.SyntheticEvent | Event,
    newValue: number | number[],
  ) => {
    const [lo, hi] = newValue as [number, number];
    if (lo === min && hi === max) {
      onClear();
    } else {
      onApply(lo, hi);
    }
  };

  // Locale-aware date formatting via `Intl` (through `toLocaleDateString(getStudioLocale(), …)`)
  // — matching the pattern `internals/temporalUtils.ts`'s `formatTemporalAxisLabel` already uses
  // for date-axis labels. `dayjs(v).format('DD MMM YYYY')` was previously used here, but this
  // codebase never calls `dayjs.locale(...)` anywhere (confirmed by search), so it always
  // formatted through dayjs's UNCONFIGURED global default locale (`'en'`) regardless of the
  // dashboard's actual locale. `getStudioLocale()` resolves both the month name AND the field
  // order (and the numeric grouping, for the non-date branch) from the active `<Studio
  // locale={…} />`, falling back to the runtime default when it isn't set — the SAME value
  // `SliderFilterPill`'s header chip formats the identical range against.
  const formatLabel = (v: number) =>
    isDate
      ? new Date(v).toLocaleDateString(getStudioLocale(), {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      : v.toLocaleString(getStudioLocale());

  return (
    /* Prevent drag-and-drop of the widget card when interacting with the slider */
    <Box role="group" aria-label={label} sx={{ px: 1 }} data-no-drag>
      <Slider
        size="small"
        value={localValue}
        onChange={handleSliderChange}
        onChangeCommitted={handleChangeCommitted}
        min={min}
        max={max}
        step={step}
        valueLabelDisplay="auto"
        valueLabelFormat={formatLabel}
        getAriaValueText={formatLabel}
        getAriaLabel={(index) =>
          index === 0
            ? localeText.filterSliderMinimumAriaLabel(label)
            : localeText.filterSliderMaximumAriaLabel(label)
        }
        sx={{ display: 'block' }}
      />
    </Box>
  );
}
