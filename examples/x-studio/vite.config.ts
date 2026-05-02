import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@mui/x-studio',
        replacement: path.resolve(__dirname, '../../packages/x-studio/src'),
      },
      {
        find: '@mui/x-charts',
        replacement: path.resolve(__dirname, '../../packages/x-charts/src'),
      },
      // x-charts-vendor uses pre-built ESM files; map subpaths to /es/*.mjs
      {
        find: /^@mui\/x-charts-vendor\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-charts-vendor/build/$1.mjs'),
      },
      {
        find: '@mui/x-data-grid-pro',
        replacement: path.resolve(__dirname, '../../packages/x-data-grid-pro/src'),
      },
      {
        find: '@mui/x-data-grid',
        replacement: path.resolve(__dirname, '../../packages/x-data-grid/src'),
      },
      {
        find: /^@mui\/x-date-pickers-pro\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-date-pickers-pro/src/$1'),
      },
      {
        find: '@mui/x-date-pickers-pro',
        replacement: path.resolve(__dirname, '../../packages/x-date-pickers-pro/src'),
      },
      {
        find: /^@mui\/x-date-pickers\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-date-pickers/src/$1'),
      },
      {
        find: '@mui/x-date-pickers',
        replacement: path.resolve(__dirname, '../../packages/x-date-pickers/src'),
      },
      {
        find: /^@mui\/x-license\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-license/src/$1'),
      },
      {
        find: '@mui/x-license',
        replacement: path.resolve(__dirname, '../../packages/x-license/src'),
      },
      {
        find: '@mui/x-telemetry',
        replacement: path.resolve(__dirname, '../../packages/x-telemetry/src'),
      },
      {
        find: '@mui/x-internal-gestures',
        replacement: path.resolve(__dirname, '../../packages/x-internal-gestures/src'),
      },
      {
        find: '@mui/x-internals',
        replacement: path.resolve(__dirname, '../../packages/x-internals/src'),
      },
      {
        find: '@mui/x-virtualizer',
        replacement: path.resolve(__dirname, '../../packages/x-virtualizer/src'),
      },
    ],
  },
  server: {
    port: 3004,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  },
});
