import { createTheme } from '@mui/material/styles';
import type {} from '@mui/x-charts/themeAugmentation';
import { bluePalette } from '@mui/x-charts';

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
      defaultProps: { colors: bluePalette },
    },
    MuiLineChart: {
      defaultProps: { colors: bluePalette },
    },
    MuiPieChart: {
      defaultProps: { colors: bluePalette },
    },
  },
});
