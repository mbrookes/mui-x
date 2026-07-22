'use client';
import * as React from 'react';
import { Box, Slider } from '@mui/material';
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
  const { label, min, max, step, isDate, currentValue, onApply, onClear } = props;
  const localeText = useStudioLocaleText();
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

  // Locale-aware date formatting via `Intl` (through `toLocaleDateString(undefined, …)`) —
  // matching the pattern `internals/temporalUtils.ts`'s `formatTemporalAxisLabel` already uses
  // for date-axis labels. `dayjs(v).format('DD MMM YYYY')` was previously used here, but this
  // codebase never calls `dayjs.locale(...)` anywhere (confirmed by search), so it always
  // formatted through dayjs's UNCONFIGURED global default locale (`'en'`) regardless of the
  // dashboard's actual locale — `toLocaleDateString(undefined, …)` instead resolves both the
  // month name AND the field order from the runtime's active locale.
  const formatLabel = (v: number) =>
    isDate
      ? new Date(v).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      : v.toLocaleString();

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
