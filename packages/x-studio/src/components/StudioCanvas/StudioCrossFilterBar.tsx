'use client';
import * as React from 'react';
import { Box, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useStudioController, useStudioSelector, selectGlobalCrossFilterMode } from '../../context';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { StudioCrossFilterMode } from '../../models';

export function StudioCrossFilterBar() {
  const controller = useStudioController();
  const globalMode = useStudioSelector(selectGlobalCrossFilterMode);
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

  const toggleValue: string = globalMode ?? 'per-chart';

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 1,
        py: 0.5,
        borderBottom: 1,
        borderColor: 'divider',
        backgroundColor: 'action.hover',
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
    </Box>
  );
}
