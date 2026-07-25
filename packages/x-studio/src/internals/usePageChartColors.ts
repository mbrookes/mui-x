'use client';
import { useTheme, useColorScheme } from '@mui/material';
import { useStudioUIConfig } from './StudioUIConfigContext';

/**
 * Returns the chart colour palette for the dashboard, or `undefined` to let
 * charts fall back to their own default (`blueberryTwilightPalette`).
 *
 * Set `<Studio chartColors={{ light: [...], dark: [...] }} />` to fix a
 * consistent per-series palette across every chart widget — e.g. when a
 * dashboard has more series than the 6-color default palette can distinguish.
 */
export function usePageChartColors(): string[] | undefined {
  const { chartColors } = useStudioUIConfig();
  const muiTheme = useTheme();
  const { colorScheme } = useColorScheme();
  // In CSS variables mode, palette.mode is always 'light'; use colorScheme for the real value.
  const resolvedMode = (colorScheme ?? muiTheme.palette.mode) as 'light' | 'dark';

  if (!chartColors) {
    return undefined;
  }
  return resolvedMode === 'dark' ? chartColors.dark : chartColors.light;
}
