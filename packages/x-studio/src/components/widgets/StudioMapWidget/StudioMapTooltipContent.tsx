'use client';
import * as React from 'react';
import {
  ChartsTooltipPaper,
  ChartsTooltipTable,
  ChartsTooltipRow,
  ChartsTooltipCell,
  useItemTooltip,
} from '@mui/x-charts/ChartsTooltip';
import { styled } from '@mui/material/styles';
import { StudioMapTooltipContext } from './StudioMapTooltipContext';

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
  const tooltipData = useItemTooltip<'mapShape'>();
  const { valueFieldLabel, featureIdToLabel } = React.use(StudioMapTooltipContext);

  // No data for this region — suppress the tooltip entirely.
  if (!tooltipData || !tooltipData.formattedValue) {
    return null;
  }

  const { value: point, formattedValue, color } = tooltipData;
  // The mapShape point exposes `name` (the feature id we joined on) and an optional `label`.
  const regionName = point.label ?? featureIdToLabel(point.name);

  return (
    <ChartsTooltipPaper>
      <ChartsTooltipTable>
        <MapTooltipRegionLabel>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 11,
                height: 11,
                borderRadius: 2,
                flexShrink: 0,
                backgroundColor: color,
              }}
            />
            {regionName}
          </span>
        </MapTooltipRegionLabel>
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
