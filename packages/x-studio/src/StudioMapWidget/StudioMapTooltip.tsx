'use client';
import * as React from 'react';
import {
  ChartsTooltipContainer,
  ChartsTooltipPaper,
  ChartsTooltipTable,
  ChartsTooltipRow,
  ChartsTooltipCell,
  useItemTooltip,
} from '@mui/x-charts/ChartsTooltip';
import { ChartsLabelMark } from '@mui/x-charts/internals';

// ─── Context ──────────────────────────────────────────────────────────────────

export interface StudioMapTooltipContextValue {
  /** Display label for the value field, shown alongside the formatted value. */
  valueFieldLabel: string | null;
}

export const StudioMapTooltipContext = React.createContext<StudioMapTooltipContextValue>({
  valueFieldLabel: null,
});

// ─── Content ──────────────────────────────────────────────────────────────────

function StudioMapTooltipContent() {
  const tooltipData = useItemTooltip<'choropleth'>();
  const { valueFieldLabel } = React.useContext(StudioMapTooltipContext);

  // No data for this region — suppress the tooltip entirely.
  if (!tooltipData || !tooltipData.formattedValue) {
    return null;
  }

  const { color, label, formattedValue, markType } = tooltipData;

  return (
    <ChartsTooltipPaper>
      <ChartsTooltipTable>
        <tbody>
          <ChartsTooltipRow>
            <ChartsTooltipCell component="th">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <ChartsLabelMark type={markType} color={color} />
                {label}
              </div>
            </ChartsTooltipCell>
          </ChartsTooltipRow>
          <ChartsTooltipRow>
            {valueFieldLabel && (
              <ChartsTooltipCell component="th">{valueFieldLabel}</ChartsTooltipCell>
            )}
            <ChartsTooltipCell component="td">{formattedValue}</ChartsTooltipCell>
          </ChartsTooltipRow>
        </tbody>
      </ChartsTooltipTable>
    </ChartsTooltipPaper>
  );
}

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
