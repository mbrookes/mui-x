'use client';
import * as React from 'react';
import { Box, FormControlLabel, Switch, ToggleButton, ToggleButtonGroup } from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectGlobalCrossFilterMode,
  selectCrossFilterAllPages,
} from '../../context';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { StudioCrossFilterMode } from '../../models';

/**
 * Bar shown above the canvas (in place of the date-range bar) when the
 * `crossFilterBar` feature flag is enabled. Provides two controls:
 *
 * - A toggle-button group to choose the global interaction mode:
 *   "Filter" | "Highlight" | "Per chart"
 * - A switch to apply cross-filters to all pages (vs. only the current page)
 */
export function StudioCrossFilterBar() {
  const controller = useStudioController();
  const globalMode = useStudioSelector(selectGlobalCrossFilterMode);
  const allPages = useStudioSelector(selectCrossFilterAllPages);
  const localeText = useStudioLocaleText();

  const handleModeChange = (
    _event: React.MouseEvent<HTMLElement>,
    value: StudioCrossFilterMode | 'per-chart' | null,
  ) => {
    if (value === null) {
      return;
    }
    controller.setGlobalCrossFilterMode(value === 'per-chart' ? null : value);
  };

  const handleAllPagesChange = (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    controller.setCrossFilterAllPages(checked);
  };

  const toggleValue: string = globalMode ?? 'per-chart';

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 1,
        py: 0.5,
        // No bottom border: this top section sits directly above the quick-filter chip bar,
        // and the two read as a single block (the chip bar carries the boundary border).
        backgroundColor: 'background.paper',
        flexShrink: 0,
      }}
    >
      <ToggleButtonGroup
        value={toggleValue}
        exclusive
        size="small"
        onChange={handleModeChange}
        sx={{ height: 28 }}
      >
        <ToggleButton value="cross-filter" sx={{ px: 1.5, fontSize: '0.75rem' }}>
          {localeText.crossFilterBarModeFilter}
        </ToggleButton>
        <ToggleButton value="cross-highlight" sx={{ px: 1.5, fontSize: '0.75rem' }}>
          {localeText.crossFilterBarModeHighlight}
        </ToggleButton>
        <ToggleButton value="per-chart" sx={{ px: 1.5, fontSize: '0.75rem' }}>
          {localeText.crossFilterBarModePerChart}
        </ToggleButton>
      </ToggleButtonGroup>

      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={allPages}
            onChange={handleAllPagesChange}
            sx={{ ml: 0.5 }}
          />
        }
        label={localeText.crossFilterBarAllPages}
        slotProps={{ typography: { variant: 'caption' } }}
        sx={{ ml: 0, gap: 0.5 }}
      />
    </Box>
  );
}
