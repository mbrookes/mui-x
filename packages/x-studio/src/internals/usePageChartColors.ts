'use client';

import * as React from 'react';
import {
  blueberryTwilightPalette,
  mangoFusionPalette,
  cheerfulFiestaPalette,
  rainbowSurgePalette,
} from '@mui/x-charts';
import { useTheme } from '@mui/material';
import { useStudioSelector } from '../context';

const PALETTE_MAP = {
  blueberryTwilight: blueberryTwilightPalette,
  mangoFusion: mangoFusionPalette,
  cheerfulFiesta: cheerfulFiestaPalette,
  rainbowSurge: rainbowSurgePalette,
} as const;

/**
 * Returns the resolved chart colour palette for the dashboard.
 * Returns `undefined` when no custom palette is configured (charts use their default).
 */
export function usePageChartColors(): string[] | undefined {
  const chartPalette = useStudioSelector((state) => state.dashboard.chartPalette);
  const chartCustomColors = useStudioSelector((state) => state.dashboard.chartCustomColors);
  const muiTheme = useTheme();

  return React.useMemo((): string[] | undefined => {
    if (!chartPalette) {
      return undefined;
    }
    if (chartPalette === 'custom') {
      return chartCustomColors?.length ? chartCustomColors : undefined;
    }
    return PALETTE_MAP[chartPalette]?.(muiTheme.palette.mode);
  }, [chartPalette, chartCustomColors, muiTheme.palette.mode]);
}
