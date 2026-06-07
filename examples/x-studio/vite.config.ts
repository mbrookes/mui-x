import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import type { PluginOption } from 'vite';

// Conditionally load visualizer — only when ANALYZE=true
const visualizerPlugin: PluginOption[] = [];
if (process.env.ANALYZE) {
  const { visualizer } = await import('rollup-plugin-visualizer');
  visualizerPlugin.push(
    visualizer({
      filename: 'stats.html',
      open: true,
      template: 'treemap',
      gzipSize: true,
      brotliSize: true,
      sourcemap: true,
    }) as PluginOption,
  );
}

// Profiling build aliases — enable with PROFILING=true to use react-dom/profiling
// so React DevTools Profiler works on production-like builds.
const profilingAliases = process.env.PROFILING
  ? [
      { find: 'react-dom$', replacement: 'react-dom/profiling' },
      { find: 'scheduler/tracing', replacement: 'scheduler/tracing-profiling' },
    ]
  : [];

export default defineConfig({
  plugins: [react(), ...visualizerPlugin],
  build: {
    sourcemap: !!process.env.ANALYZE,
  },
  // Never pre-bundle opt-in dev tools — they are large and should only be
  // loaded when explicitly activated via dev:scan / dev:wdyr scripts or localStorage flags.
  optimizeDeps: {
    exclude: ['react-scan', '@welldone-software/why-did-you-render'],
  },
  resolve: {
    dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled'],
    alias: [
      ...profilingAliases,
      {
        find: '@mui/x-studio',
        replacement: path.resolve(__dirname, '../../packages/x-studio/src'),
      },
      {
        find: '@mui/x-chat-headless',
        replacement: path.resolve(__dirname, '../../packages/x-chat-headless/src'),
      },
      {
        find: '@mui/x-chat',
        replacement: path.resolve(__dirname, '../../packages/x-chat/src'),
      },
      {
        find: '@mui/x-charts',
        replacement: path.resolve(__dirname, '../../packages/x-charts/src'),
      },
      {
        find: /^@mui\/x-charts-pro\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-charts-pro/src/$1'),
      },
      {
        find: '@mui/x-charts-pro',
        replacement: path.resolve(__dirname, '../../packages/x-charts-pro/src'),
      },
      // x-charts-vendor uses pre-built ESM files; map subpaths to /es/*.mjs
      {
        find: /^@mui\/x-charts-vendor\/(.+)$/,
        replacement: path.resolve(__dirname, '../../packages/x-charts-vendor/build/$1.mjs'),
      },
      {
        find: '@mui/x-data-grid-premium',
        replacement: path.resolve(__dirname, '../../packages/x-data-grid-premium/src'),
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
  envPrefix: ['VITE_'],
  server: {
    port: 3004,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  },
});
