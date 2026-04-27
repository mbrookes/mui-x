'use client';
import * as React from 'react';
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import type { FilterMode } from './filterDrawerTypes';

export function FilterModeToggle({
  mode,
  onChange,
}: {
  mode: FilterMode;
  onChange: (m: FilterMode) => void;
}) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={mode}
      onChange={(_event, val) => {
        if (val) {
          onChange(val as FilterMode);
        }
      }}
      sx={{ alignSelf: 'center' }}
    >
      <ToggleButton
        value="condition"
        sx={{ px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' }}
      >
        Condition
      </ToggleButton>
      <ToggleButton
        value="selection"
        sx={{ px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' }}
      >
        Selection
      </ToggleButton>
      <ToggleButton value="rank" sx={{ px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' }}>
        Rank
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
