import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@mui/x-studio', replacement: path.resolve(__dirname, '../../packages/x-studio/src') },
      { find: '@mui/x-charts', replacement: path.resolve(__dirname, '../../packages/x-charts/src') },
      // x-charts-vendor uses pre-built ESM files; map subpaths to /es/*.mjs
      { find: /^@mui\/x-charts-vendor\/(.+)$/, replacement: path.resolve(__dirname, '../../packages/x-charts-vendor/es/$1.mjs') },
      { find: '@mui/x-data-grid', replacement: path.resolve(__dirname, '../../packages/x-data-grid/src') },
      { find: '@mui/x-internal-gestures', replacement: path.resolve(__dirname, '../../packages/x-internal-gestures/src') },
      { find: '@mui/x-internals', replacement: path.resolve(__dirname, '../../packages/x-internals/src') },
      { find: '@mui/x-virtualizer', replacement: path.resolve(__dirname, '../../packages/x-virtualizer/src') },
    ],
  },
  server: {
    port: 3004,
  },
});
