'use client';
import * as React from 'react';
import { Box, Tooltip, Typography, useTheme } from '@mui/material';
import { formatNumber } from '../internals/numberFormat';
import type { StudioNumberFormat } from '../models/studio';

export interface FunnelStage {
  label: string;
  value: number;
}

export interface StudioFunnelChartProps {
  stages: FunnelStage[];
  height: number;
  valueFormat?: StudioNumberFormat;
  currencyCode?: string;
}

/**
 * Renders a funnel (conversion) chart as a series of centred trapezoids.
 * Each stage shows the absolute value and the retention % relative to the
 * first stage. Drop-off % is shown between adjacent stages.
 */
export function StudioFunnelChart({
  stages,
  height,
  valueFormat,
  currencyCode,
}: StudioFunnelChartProps) {
  const theme = useTheme();
  const primaryColor = theme.palette.primary.main;

  if (stages.length === 0) {
    return null;
  }

  const maxValue = stages[0].value;
  const formatter = (v: number) => formatNumber(v, valueFormat ?? 'decimal', currencyCode);

  // Layout
  const LABEL_W = 110; // reserved for stage name on left
  const VALUE_W = 90; // reserved for value+% on right
  const BAR_AREA_W_PCT = 1; // bar uses remaining width
  const ROW_H = 36;
  const GAP_H = 14; // gap between bars for drop-off label
  const PADDING_TOP = 8;
  const totalRows = stages.length;
  const totalHeight = PADDING_TOP + totalRows * ROW_H + (totalRows - 1) * GAP_H;

  return (
    <Box
      sx={{
        width: '100%',
        height,
        overflow: 'auto',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
      }}
    >
      <Box sx={{ width: '100%', position: 'relative', height: totalHeight, minWidth: 240 }}>
        {stages.map((stage, i) => {
          const widthPct = maxValue > 0 ? (stage.value / maxValue) * BAR_AREA_W_PCT : 0;
          const retentionPct = maxValue > 0 ? ((stage.value / maxValue) * 100).toFixed(0) : '0';
          const prevValue = i > 0 ? stages[i - 1].value : null;
          const dropOffPct =
            prevValue && prevValue > 0
              ? (((prevValue - stage.value) / prevValue) * 100).toFixed(0)
              : null;

          const barTop = PADDING_TOP + i * (ROW_H + GAP_H);

          // Parse hex color for alpha blending
          const intensity = maxValue > 0 ? 0.4 + (stage.value / maxValue) * 0.6 : 0.6;
          const hex = primaryColor.replace('#', '');
          let cellBg = primaryColor;
          if (hex.length === 6) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            const rBlend = Math.round(255 - intensity * (255 - r));
            const gBlend = Math.round(255 - intensity * (255 - g));
            const bBlend = Math.round(255 - intensity * (255 - b));
            cellBg = `rgb(${rBlend},${gBlend},${bBlend})`;
          }
          const textColor = intensity > 0.65 ? '#fff' : theme.palette.text.primary;

          return (
            <React.Fragment key={stage.label}>
              {/* Drop-off indicator between stages */}
              {dropOffPct !== null && (
                <Box
                  sx={{
                    position: 'absolute',
                    top: barTop - GAP_H,
                    left: LABEL_W,
                    right: VALUE_W,
                    height: GAP_H,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{ fontSize: 9, color: 'text.secondary', lineHeight: 1 }}
                  >
                    ▼ -{dropOffPct}%
                  </Typography>
                </Box>
              )}

              {/* Stage label (left) */}
              <Box
                sx={{
                  position: 'absolute',
                  top: barTop,
                  left: 0,
                  width: LABEL_W,
                  height: ROW_H,
                  display: 'flex',
                  alignItems: 'center',
                  pr: 1,
                }}
              >
                <Typography
                  variant="caption"
                  noWrap
                  sx={{ fontSize: 11, color: 'text.secondary', maxWidth: LABEL_W - 8 }}
                >
                  {stage.label}
                </Typography>
              </Box>

              {/* Funnel bar */}
              <Box
                sx={{
                  position: 'absolute',
                  top: barTop,
                  left: LABEL_W,
                  right: VALUE_W,
                  height: ROW_H,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <Tooltip title={`${stage.label}: ${formatter(stage.value)}`} placement="top">
                  <Box
                    sx={{
                      width: `${widthPct * 100}%`,
                      height: ROW_H - 4,
                      minWidth: 4,
                      backgroundColor: cellBg,
                      borderRadius: 0.75,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'default',
                      transition: 'filter 0.15s',
                      '&:hover': { filter: 'brightness(0.92)' },
                    }}
                  >
                    {widthPct > 0.12 && (
                      <Typography
                        variant="caption"
                        sx={{ fontSize: 10, color: textColor, lineHeight: 1, fontWeight: 500 }}
                      >
                        {formatter(stage.value)}
                      </Typography>
                    )}
                  </Box>
                </Tooltip>
              </Box>

              {/* Value + retention (right) */}
              <Box
                sx={{
                  position: 'absolute',
                  top: barTop,
                  right: 0,
                  width: VALUE_W,
                  height: ROW_H,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  justifyContent: 'center',
                  pl: 1,
                }}
              >
                <Typography variant="caption" sx={{ fontSize: 10, lineHeight: 1.2 }}>
                  {formatter(stage.value)}
                </Typography>
                {i > 0 && (
                  <Typography variant="caption" sx={{ fontSize: 9, color: 'text.secondary', lineHeight: 1.2 }}>
                    {retentionPct}% of total
                  </Typography>
                )}
              </Box>
            </React.Fragment>
          );
        })}
      </Box>
    </Box>
  );
}
