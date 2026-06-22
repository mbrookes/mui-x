import { createTheme } from '@mui/material/styles';
import type {} from '@mui/x-charts/themeAugmentation';

const PIE_PALETTE = ['#0f172a', '#b45309', '#1e3a8a', '#166534', '#7e22ce', '#9f1239', '#0e7490', '#78350f'];

export const theme = createTheme({
  cssVariables: true,
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#0f172a' },
        secondary: { main: '#b45309' },
        background: {
          default: '#ffffff',
          paper: '#ffffff',
        },
      },
    },
    dark: {
      palette: {
        primary: { main: '#94a3b8' },
        secondary: { main: '#f59e0b' },
        background: {
          default: '#0f172a',
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
    MuiBarChart: {
      defaultProps: { colors: ['#0f172a'] },
    },
    MuiLineChart: {
      defaultProps: { colors: ['#0f172a'] },
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
