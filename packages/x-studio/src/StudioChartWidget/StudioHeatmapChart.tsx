'use client';
import * as React from 'react';
import { Box, Tooltip, Typography, useTheme } from '@mui/material';
import type { HeatmapData } from '../internals/chartAggregation';
import { formatNumber } from '../internals/numberFormat';
import type { StudioNumberFormat } from '../models/studio';

export interface StudioHeatmapChartProps {
  data: HeatmapData;
  height: number;
  colorScheme?: 'primary' | 'success' | 'warning' | 'error';
  valueFormat?: StudioNumberFormat;
  currencyCode?: string;
  xLabel?: string;
  yLabel?: string;
}

/**
 * Renders a heatmap grid with colour-intensity cells.
 * X axis (columns) = `data.xLabels`, Y axis (rows) = `data.yLabels`.
 * Cell colour intensity is mapped linearly from `minValue` → `maxValue`.
 */
export function StudioHeatmapChart({
  data,
  height,
  colorScheme = 'primary',
  valueFormat,
  currencyCode,
  xLabel,
  yLabel,
}: StudioHeatmapChartProps) {
  const theme = useTheme();
  const { xLabels, yLabels, cells, minValue, maxValue } = data;

  const paletteColor = theme.palette[colorScheme].main;

  /** Linearly interpolate intensity 0→1 from minValue→maxValue */
  function getIntensity(value: number): number {
    if (maxValue === minValue) {
      return 0.5;
    }
    return (value - minValue) / (maxValue - minValue);
  }

  /** Blend from white (0) to paletteColor (1) for intensity 0→1. */
  function getCellColor(intensity: number): string {
    // Parse hex color to RGB
    const hex = paletteColor.replace('#', '');
    if (hex.length !== 6) {
      return `rgba(${paletteColor}, ${0.1 + intensity * 0.85})`;
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    // Blend from white (255,255,255) to color at full intensity
    const rBlend = Math.round(255 - intensity * (255 - r));
    const gBlend = Math.round(255 - intensity * (255 - g));
    const bBlend = Math.round(255 - intensity * (255 - b));
    return `rgb(${rBlend},${gBlend},${bBlend})`;
  }

  const formatter = (v: number) => formatNumber(v, valueFormat ?? 'decimal', currencyCode);

  // Layout constants
  const Y_LABEL_WIDTH = 90;
  const X_LABEL_HEIGHT = 28;
  const CELL_MIN_WIDTH = 28;
  const CELL_HEIGHT = 24;

  // Compute cell width to fill available space
  const gridHeight = height - X_LABEL_HEIGHT;
  const cellHeight = yLabels.length > 0
    ? Math.max(CELL_HEIGHT, Math.floor((gridHeight - 16) / yLabels.length))
    : CELL_HEIGHT;

  return (
    <Box sx={{ width: '100%', height, overflow: 'auto', userSelect: 'none' }}>
      {/* Y axis label */}
      {yLabel && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            display: 'block',
            mb: 0.25,
            ml: `${Y_LABEL_WIDTH}px`,
            fontSize: 10,
          }}
        >
          {yLabel}
        </Typography>
      )}

      <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
        {/* Y axis (row labels) */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            width: Y_LABEL_WIDTH,
            pr: 0.5,
          }}
        >
          {/* Spacer to align row labels with the grid (offset by X axis height) */}
          <Box sx={{ height: X_LABEL_HEIGHT, flexShrink: 0 }} />
          {yLabels.map((yLbl) => (
            <Box
              key={yLbl}
              sx={{
                height: cellHeight,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
              }}
            >
              <Typography
                variant="caption"
                noWrap
                sx={{ fontSize: 10, color: 'text.secondary', maxWidth: Y_LABEL_WIDTH - 8 }}
              >
                {yLbl}
              </Typography>
            </Box>
          ))}
          {yLabel && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontSize: 10, mt: 0.25, textAlign: 'right' }}
            >
              {yLabel}
            </Typography>
          )}
        </Box>

        {/* Grid area */}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          {/* X axis labels row */}
          <Box sx={{ display: 'flex', height: X_LABEL_HEIGHT, alignItems: 'flex-end', pb: 0.25 }}>
            {xLabels.map((xLbl) => (
              <Box
                key={xLbl}
                sx={{
                  flex: '1 1 0',
                  minWidth: CELL_MIN_WIDTH,
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'flex-end',
                }}
              >
                <Typography
                  variant="caption"
                  noWrap
                  sx={{ fontSize: 10, color: 'text.secondary', maxWidth: '100%' }}
                >
                  {xLbl}
                </Typography>
              </Box>
            ))}
          </Box>

          {/* Cell rows */}
          {yLabels.map((yLbl) => (
            <Box
              key={yLbl}
              sx={{ display: 'flex', height: cellHeight, gap: '1px', mb: '1px' }}
            >
              {xLabels.map((xLbl) => {
                const key = `${xLbl}\x00${yLbl}`;
                const value = cells.get(key) ?? 0;
                const intensity = getIntensity(value);
                const bgColor = getCellColor(intensity);
                // Decide text color (dark text on light background, light on dark)
                const textColor = intensity > 0.6 ? '#fff' : theme.palette.text.primary;
                return (
                  <Tooltip
                    key={xLbl}
                    title={`${xLbl} / ${yLbl}: ${formatter(value)}`}
                    placement="top"
                  >
                    <Box
                      sx={{
                        flex: '1 1 0',
                        minWidth: CELL_MIN_WIDTH,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: bgColor,
                        borderRadius: 0.5,
                        cursor: 'default',
                        transition: 'filter 0.15s',
                        '&:hover': { filter: 'brightness(0.92)' },
                      }}
                    >
                      {cellHeight >= 20 && xLabels.length <= 20 && (
                        <Typography
                          variant="caption"
                          sx={{ fontSize: 9, color: textColor, lineHeight: 1 }}
                        >
                          {formatNumber(value, 'integer')}
                        </Typography>
                      )}
                    </Box>
                  </Tooltip>
                );
              })}
            </Box>
          ))}
        </Box>
      </Box>

      {/* X axis label */}
      {xLabel && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            display: 'block',
            mt: 0.25,
            textAlign: 'center',
            ml: `${Y_LABEL_WIDTH}px`,
            fontSize: 10,
          }}
        >
          {xLabel}
        </Typography>
      )}
    </Box>
  );
}
