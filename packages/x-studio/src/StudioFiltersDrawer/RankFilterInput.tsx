'use client';
import * as React from 'react';
import {
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import type { StudioFilterState } from '../models';
import { NumberField } from '../internals/NumberField';

export interface AvailableSeries {
  fieldId: string;
  label: string;
}

const AGGREGATE_OPTIONS = [
  { value: '__sum', label: 'Sum of all series' },
  { value: '__avg', label: 'Average of all series' },
  { value: '__max', label: 'Max of all series' },
  { value: '__min', label: 'Min of all series' },
];

export function RankFilterInput({
  direction,
  n,
  rankMultiSeriesBy,
  availableSeries,
  onChange,
}: {
  direction: 'top' | 'bottom';
  n: number | undefined;
  rankMultiSeriesBy?: string;
  availableSeries?: AvailableSeries[];
  onChange: (changes: Partial<StudioFilterState>) => void;
}) {
  const showRankBy = availableSeries && availableSeries.length > 1;

  return (
    <Stack spacing={1}>
      {/* Top / Bottom toggle */}
      <ToggleButtonGroup
        exclusive
        size="small"
        value={direction}
        onChange={(_event, val) => {
          if (val) {
            onChange({ rankDirection: val as 'top' | 'bottom' });
          }
        }}
      >
        <ToggleButton value="top" sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: 'none' }}>
          Top
        </ToggleButton>
        <ToggleButton
          value="bottom"
          sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: 'none' }}
        >
          Bottom
        </ToggleButton>
      </ToggleButtonGroup>

      {/* N items number field */}
      <NumberField
        size="small"
        value={n ?? null}
        min={1}
        onValueChange={(v) => onChange({ value: Math.max(1, v ?? 1) })}
      />

      {showRankBy && (
        <FormControl size="small" fullWidth>
          <InputLabel>Rank by</InputLabel>
          <Select
            label="Rank by"
            value={rankMultiSeriesBy ?? '__sum'}
            onChange={(event) => onChange({ rankMultiSeriesBy: event.target.value })}
          >
            {AGGREGATE_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
            <Divider />
            {availableSeries.map((s) => (
              <MenuItem key={s.fieldId} value={s.fieldId}>
                {s.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}
    </Stack>
  );
}
