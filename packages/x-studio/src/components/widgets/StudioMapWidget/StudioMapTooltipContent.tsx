'use client';
import * as React from 'react';
import {
  ChartsTooltipPaper,
  ChartsTooltipTable,
  ChartsTooltipRow,
  ChartsTooltipCell,
  useItemTooltip,
} from '@mui/x-charts/ChartsTooltip';
import { StudioMapTooltipContext } from './StudioMapTooltipContext';

import { styled } from '@mui/material/styles';

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

// ─── Content ──────────────────────────────────────────────────────────────────

export function StudioMapTooltipContent() {
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
