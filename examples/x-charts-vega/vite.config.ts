import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  // Both `@mui/x-charts-vega` and `@mui/x-charts` are unpublished/unbuilt
  // workspace packages here — alias them to `src` (same approach as
  // examples/x-studio/vite.config.ts) so Vite serves TS source directly
  // instead of relying on a build step, and so both packages + this example
  // share a single React/emotion instance.
  resolve: {
    dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled'],
    alias: [
      {
        find: '@mui/x-charts-vega',
        replacement: path.resolve(__dirname, '../../packages/x-charts-vega/src'),
      },
      {
        find: /^@mui\/x-charts-premium\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-charts-premium/src/$1'),
      },
      {
        find: '@mui/x-charts-premium',
        replacement: path.resolve(__dirname, '../../packages/x-charts-premium/src'),
      },
      {
        find: /^@mui\/x-charts-pro\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-charts-pro/src/$1'),
      },
      {
        find: '@mui/x-charts-pro',
        replacement: path.resolve(__dirname, '../../packages/x-charts-pro/src'),
      },
      {
        find: /^@mui\/x-charts\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-charts/src/$1'),
      },
      {
        find: '@mui/x-charts',
        replacement: path.resolve(__dirname, '../../packages/x-charts/src'),
      },
      // x-charts-pro/-premium import the license package from source too.
      {
        find: /^@mui\/x-license\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-license/src/$1'),
      },
      {
        find: '@mui/x-license',
        replacement: path.resolve(__dirname, '../../packages/x-license/src'),
      },
      {
        find: /^@mui\/x-telemetry\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-telemetry/src/$1'),
      },
      {
        find: '@mui/x-telemetry',
        replacement: path.resolve(__dirname, '../../packages/x-telemetry/src'),
      },
      {
        find: '@mui/x-internals',
        replacement: path.resolve(__dirname, '../../packages/x-internals/src'),
      },
      // @mui/x-charts (aliased to raw source above) imports this internal
      // gesture-handling package by subpath (e.g. `@mui/x-internal-gestures/core`);
      // it isn't built either, so it needs the same source alias.
      {
        find: /^@mui\/x-internal-gestures\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-internal-gestures/src/$1'),
      },
      {
        find: '@mui/x-internal-gestures',
        replacement: path.resolve(__dirname, '../../packages/x-internal-gestures/src'),
      },
    ],
  },
  server: {
    port: 5199,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  },
});
