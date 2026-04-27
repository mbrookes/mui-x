'use client';
import * as React from 'react';
import { FormControlLabel, Radio, RadioGroup, Stack, TextField } from '@mui/material';
import type { StudioFilterState } from '../../models';

export function RankFilterInput({
  direction,
  n,
  onChange,
}: {
  direction: 'top' | 'bottom';
  n: number | undefined;
  onChange: (changes: Partial<StudioFilterState>) => void;
}) {
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
    </Stack>
  );
}
