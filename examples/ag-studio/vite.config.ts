import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@mui/x-ag-studio': path.resolve(__dirname, '../../packages/ag-studio/src'),
      '@mui/x-charts': path.resolve(__dirname, '../../packages/x-charts/src'),
      '@mui/x-data-grid': path.resolve(__dirname, '../../packages/x-data-grid/src'),
      '@mui/x-internals': path.resolve(__dirname, '../../packages/x-internals/src'),
      '@mui/x-virtualizer': path.resolve(__dirname, '../../packages/x-virtualizer/src'),
    },
  },
  server: {
    port: 3004,
  },
});
