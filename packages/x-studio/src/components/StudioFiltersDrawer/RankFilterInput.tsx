'use client';
import * as React from 'react';
import {
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
} from '@mui/material';
import type { StudioFilterState } from '../../models';

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
      <RadioGroup
        row
        value={direction}
        onChange={(event) => onChange({ rankDirection: event.target.value as 'top' | 'bottom' })}
        sx={{ gap: 1, justifyContent: 'center' }}
      >
        <FormControlLabel
          value="top"
          control={<Radio size="small" sx={{ p: 0.5 }} />}
          label="Top"
          sx={{ '& .MuiFormControlLabel-label': { fontSize: 13 } }}
        />
        <FormControlLabel
          value="bottom"
          control={<Radio size="small" sx={{ p: 0.5 }} />}
          label="Bottom"
          sx={{ '& .MuiFormControlLabel-label': { fontSize: 13 } }}
        />
      </RadioGroup>
      <TextField
        size="small"
        label="Count"
        type="number"
        value={n ?? ''}
        onChange={(event) =>
          onChange({ value: Math.max(1, parseInt(event.target.value, 10) || 1) })
        }
        slotProps={{ htmlInput: { min: 1 } }}
        fullWidth
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
