'use client';
import { ChartsTooltipContainer } from '@mui/x-charts/ChartsTooltip';
import { StudioMapTooltipContent } from './StudioMapTooltipContent';

export { StudioMapTooltipContext } from './StudioMapTooltipContext';

// ─── Slot component ───────────────────────────────────────────────────────────

/**
 * Custom tooltip for `StudioMapWidget`.
 *
 * - Displays the region name on its own row above the value.
 * - Shows the value field label alongside the formatted value.
 * - Suppresses the tooltip when a region has no data (empty formattedValue).
 *
 * Reads the value field label from `StudioMapTooltipContext`, which is provided
 * by `StudioMapWidget`.
 */
export function StudioMapTooltip() {
  return (
    <ChartsTooltipContainer trigger="item">
      <StudioMapTooltipContent />
    </ChartsTooltipContainer>
  );
}
