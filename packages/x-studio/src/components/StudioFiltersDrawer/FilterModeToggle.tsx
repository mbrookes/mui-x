'use client';
import * as React from 'react';
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import type { FilterMode } from './filterDrawerTypes';

export function FilterModeToggle({
  mode,
  onChange,
  compact = false,
  disableRank = false,
}: {
  mode: FilterMode;
  onChange: (m: FilterMode) => void;
  /** When true, uses smaller padding/font for use in card headers. */
  compact?: boolean;
  disableRank?: boolean;
}) {
  const px = compact ? 0.75 : 1.5;
  const py = compact ? 0.1 : 0.25;
  const fontSize = compact ? 10 : 11;

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
      sx={{ alignSelf: 'stretch', width: '100%' }}
    >
      <ToggleButton value="condition" sx={{ px, py, fontSize, textTransform: 'none', flexGrow: 1 }}>
        Filter
      </ToggleButton>
      <ToggleButton value="selection" sx={{ px, py, fontSize, textTransform: 'none', flexGrow: 1 }}>
        Select
      </ToggleButton>
      <ToggleButton
        value="rank"
        disabled={disableRank}
        sx={{ px, py, fontSize, textTransform: 'none', flexGrow: 1 }}
      >
        Rank
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
