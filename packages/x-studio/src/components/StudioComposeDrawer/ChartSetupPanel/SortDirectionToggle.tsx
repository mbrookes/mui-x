'use client';
import * as React from 'react';
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useStudioLocaleText } from '../../../context';

export interface SortDirectionToggleProps {
  value: 'asc' | 'desc';
  onChange: (value: 'asc' | 'desc') => void;
  disabled?: boolean;
}

/**
 * Shared ascending/descending sort-direction toggle. Used by both the chart setup
 * panel (`chartSortDirection`) and the heatmap axes section (`heatSortDirection`),
 * which previously carried identical copy-pasted `ToggleButtonGroup`s (finding 2.6).
 */
export function SortDirectionToggle({ value, onChange, disabled }: SortDirectionToggleProps) {
  const localeText = useStudioLocaleText();
  return (
    <ToggleButtonGroup
      value={value}
      exclusive
      disabled={disabled}
      onChange={(_e, val) => {
        if (val) {
          onChange(val as 'asc' | 'desc');
        }
      }}
      size="small"
      aria-label={localeText.chartSetupSortDirectionAriaLabel}
      sx={{ alignSelf: 'flex-start' }}
    >
      <ToggleButton
        value="asc"
        aria-label={localeText.sortAscendingAriaLabel}
        sx={{ textTransform: 'none' }}
      >
        {localeText.sortAscendingAriaLabel}
      </ToggleButton>
      <ToggleButton
        value="desc"
        aria-label={localeText.sortDescendingAriaLabel}
        sx={{ textTransform: 'none' }}
      >
        {localeText.sortDescendingAriaLabel}
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
