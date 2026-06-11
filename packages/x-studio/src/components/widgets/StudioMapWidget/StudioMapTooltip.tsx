'use client';
import * as React from 'react';
import { styled } from '@mui/material/styles';
import {
  ChartsTooltipContainer,
  ChartsTooltipPaper,
  ChartsTooltipTable,
  ChartsTooltipRow,
  ChartsTooltipCell,
  useItemTooltip,
} from '@mui/x-charts/ChartsTooltip';

// ─── Styled region-name header (matches HeatmapTooltipAxesValue style) ────────

const MapTooltipRegionLabel = styled('caption', {
  name: 'MuiStudioMapTooltip',
  slot: 'RegionLabel',
})(({ theme }) => ({
  display: 'table-caption',
  textAlign: 'start',
  whiteSpace: 'nowrap',
  padding: theme.spacing(0.5, 1.5),
  color: (theme.vars || theme).palette.text.secondary,
  borderBottom: `solid ${(theme.vars || theme).palette.divider} 1px`,
}));

// ─── Context ──────────────────────────────────────────────────────────────────

export interface StudioMapTooltipContextValue {
  /** Display label for the value field, shown alongside the formatted value. */
  valueFieldLabel: string | null;
  /** Converts a geographic featureId (e.g. alpha-2 code, state abbreviation) to a display name. */
  featureIdToLabel: (featureId: string) => string;
}

export const StudioMapTooltipContext = React.createContext<StudioMapTooltipContextValue>({
  valueFieldLabel: null,
  featureIdToLabel: (featureId) => featureId,
});

// ─── Content ──────────────────────────────────────────────────────────────────

function StudioMapTooltipContent() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 'choropleth' series type is not in x-charts union
  const tooltipData = useItemTooltip<any>();
  const { valueFieldLabel, featureIdToLabel } = React.useContext(StudioMapTooltipContext);

  // No data for this region — suppress the tooltip entirely.
  if (!tooltipData || !tooltipData.formattedValue) {
    return null;
  }

  const { identifier, formattedValue } = tooltipData;
  const regionName = featureIdToLabel((identifier as { featureId: string }).featureId);

  return (
    <ChartsTooltipPaper>
      <ChartsTooltipTable>
        <MapTooltipRegionLabel>{regionName}</MapTooltipRegionLabel>
        <tbody>
          <ChartsTooltipRow>
            {valueFieldLabel && (
              <ChartsTooltipCell component="th">{valueFieldLabel}</ChartsTooltipCell>
            )}
            <ChartsTooltipCell component="td">{String(formattedValue)}</ChartsTooltipCell>
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
