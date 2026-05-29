'use client';
import * as React from 'react';
import { Box, Slider } from '@mui/material';
import dayjs from 'dayjs';

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
  const [localValue, setLocalValue] = React.useState<[number, number]>([
    currentValue?.from ?? min,
    currentValue?.to ?? max,
  ]);

  React.useEffect(() => {
    setLocalValue([currentValue?.from ?? min, currentValue?.to ?? max]);
  }, [currentValue?.from, currentValue?.to, min, max]);

  const isActive = localValue[0] !== min || localValue[1] !== max;

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

  const formatLabel = (v: number) => (isDate ? dayjs(v).format('DD MMM YYYY') : v.toLocaleString());

  // isActive is computed but only used to conditionally attach data-no-drag; keep it
  void isActive;

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
        aria-label={label}
        sx={{ display: 'block' }}
      />
    </Box>
  );
}

