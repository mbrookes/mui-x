'use client';
import * as React from 'react';
import { ChartsTooltipContainer } from '@mui/x-charts/ChartsTooltip';
import { ChoroplethTooltipContent } from './ChoroplethTooltipContent';

/**
 * A ready-to-use tooltip for the `ChoroplethChart`.
 *
 * Pass it via the `slots.tooltip` prop:
 * ```tsx
 * <ChoroplethChart slots={{ tooltip: ChoroplethTooltip }} ... />
 * ```
 */
export function ChoroplethTooltip() {
  return (
    <ChartsTooltipContainer trigger="item">
      <ChoroplethTooltipContent />
    </ChartsTooltipContainer>
  );
}
