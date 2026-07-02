import { createTheme } from '@mui/material/styles';
import type {} from '@mui/x-charts/themeAugmentation';

// Palette that works in both light and dark mode (avoid very dark values that vanish on dark cards)
const PIE_PALETTE = [
  'var(--mui-palette-primary-main)',
  '#b45309',
  '#1e3a8a',
  '#166534',
  '#7e22ce',
  '#9f1239',
  '#0e7490',
  '#78350f',
];

// The base font stays monospace so the charts (SVG axis/arc labels and the donut's HTML
// legend, which all inherit it) keep their current look. The UI chrome — tabs, controls,
// the app-bar view/edit switch, etc. — is flipped to sans-serif via component overrides.
const UI_FONT = 'Arial, Helvetica, sans-serif';
const uiFont = { styleOverrides: { root: { fontFamily: UI_FONT } } } as const;

export const theme = createTheme({
  cssVariables: true,
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#0f172a' },
        secondary: { main: '#b45309' },
        background: {
          default: 'rgb(250, 250, 246)',
          paper: 'rgb(250, 250, 246)',
        },
      },
    },
    dark: {
      palette: {
        primary: { main: '#2563eb' },
        secondary: { main: '#f59e0b' },
        // Canvas backdrop and widget cards share one surface colour, mirroring the light
        // scheme (where default === paper). Only the backdrop is unified up to the card
        // tone; elevated surfaces (menus, dialogs) keep using `paper` as before.
        background: {
          default: '#1e293b',
          paper: '#1e293b',
        },
      },
    },
  },
  typography: {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    h6: { fontWeight: 600 },
  },
  shape: {
    borderRadius: 4,
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
    // ── UI chrome → sans-serif (charts keep the monospace base) ──────────────
    MuiTypography: uiFont,
    MuiButton: uiFont,
    MuiTab: uiFont,
    MuiToggleButton: uiFont,
    MuiMenuItem: uiFont,
    MuiInputBase: uiFont,
    MuiChip: uiFont,
    MuiFormLabel: uiFont,
    MuiTooltip: { styleOverrides: { tooltip: { fontFamily: UI_FONT, fontSize: '0.625rem' } } },
    // Shrink the chart data tooltips (cells default to body1 ≈ 1rem, the title to caption).
    MuiChartsTooltip: {
      styleOverrides: {
        cell: { fontSize: '0.625rem' },
        table: { '& caption': { fontSize: '0.625rem' } },
      },
    },
    MuiBarChart: {
      defaultProps: { colors: ['var(--mui-palette-primary-main)'] },
    },
    MuiLineChart: {
      defaultProps: { colors: ['var(--mui-palette-primary-main)'] },
    },
    MuiPieChart: {
      defaultProps: { colors: PIE_PALETTE },
    },
    MuiPieArcLabel: {
      styleOverrides: {
        root: { fontSize: '0.65rem' },
      },
    },
  },
});
