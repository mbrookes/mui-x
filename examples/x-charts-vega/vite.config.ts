import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// The x-charts pro/premium packages carry a `'__RELEASE_INFO__'` placeholder
// that the repo's Babel build replaces with a base64 release timestamp; the
// license verifier parses it in production builds (`NODE_ENV === 'production'`).
// Serving the packages from raw source here bypasses that Babel step, so an
// un-replaced placeholder makes a production `vite build` throw "release
// information is invalid". Replace it the same way Babel does (see
// `scripts/generateReleaseInfo.mjs`).
const releaseDate = new Date();
releaseDate.setHours(0, 0, 0, 0);
const RELEASE_INFO = Buffer.from(String(releaseDate.getTime())).toString('base64');

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'x-charts-vega-replace-release-info',
      enforce: 'pre',
      transform(code) {
        if (!code.includes('__RELEASE_INFO__')) {
          return null;
        }
        return { code: code.replaceAll('__RELEASE_INFO__', RELEASE_INFO), map: null };
      },
    },
  ],
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
    // The wrapper mounts `@mui/x-charts-pro`/`-premium` components (Heatmap, Map,
    // range bars), which verify a commercial license. Serving those packages from
    // raw source means the `__ALLOW_TEST_LICENSES__` placeholder is never compiled
    // away, so define it here to let `main.tsx` register the shared test license
    // key and render the charts without the "Missing license key" watermark.
    __ALLOW_TEST_LICENSES__: 'true',
  },
});
