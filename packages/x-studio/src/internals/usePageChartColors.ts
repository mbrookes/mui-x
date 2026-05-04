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
 * Returns the resolved chart colour palette for the active page.
 * Returns `undefined` when no custom palette is configured (charts use their default).
 */
export function usePageChartColors(): string[] | undefined {
  const pageTheme = useStudioSelector(
    (state) => state.pages[state.dashboard.activePageId]?.theme,
  );
  const defaultTheme = useStudioSelector((state) => state.dashboard.defaultTheme);
  const muiTheme = useTheme();

  return React.useMemo((): string[] | undefined => {
    // Page-level palette takes precedence; fall back to dashboard-level default.
    const palette = pageTheme?.chartPalette ?? defaultTheme?.chartPalette;
    if (!palette) {
      return undefined;
    }
    if (palette === 'custom') {
      return pageTheme?.chartCustomColors?.length ? pageTheme.chartCustomColors : undefined;
    }
    return PALETTE_MAP[palette]?.(muiTheme.palette.mode);
  }, [pageTheme, defaultTheme, muiTheme.palette.mode]);
}
