import { createTheme } from '@mui/material/styles';
import type {} from '@mui/x-charts/themeAugmentation';
import type { ChartsColorPaletteCallback } from '@mui/x-charts';

export const CHART_COLORS_LIGHT = [
  '#4f7df9', // blue
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#f43f5e', // rose
  '#3b82f6', // blue-500
  '#a855f7', // purple
];

export const CHART_COLORS_DARK = [
  '#60a5fa', // blue-400
  '#a78bfa', // violet-400
  '#22d3ee', // cyan-400
  '#34d399', // emerald-400
  '#fbbf24', // amber-400
  '#fb7185', // rose-400
  '#818cf8', // indigo-400
  '#c084fc', // purple-400
];

const mutedPalette: ChartsColorPaletteCallback = (mode) =>
  mode === 'dark' ? CHART_COLORS_DARK : CHART_COLORS_LIGHT;

export const theme = createTheme({
  cssVariables: true,
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#2563eb' },
        secondary: { main: '#0ea5e9' },
        background: {
          default: '#f8fafc',
          paper: '#ffffff',
        },
      },
    },
    dark: {
      palette: {
        primary: { main: '#60a5fa' },
        secondary: { main: '#38bdf8' },
        background: {
          default: '#0f172a',
          paper: '#1e293b',
        },
      },
    },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h6: { fontWeight: 600 },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
    MuiBarChart: {
      defaultProps: { colors: mutedPalette },
    },
    MuiLineChart: {
      defaultProps: { colors: mutedPalette },
    },
    MuiPieChart: {
      defaultProps: { colors: mutedPalette },
    },
  },
});
