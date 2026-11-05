import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Reuses the app's aliases so tests import `@mui/x-studio` from source, like the app does.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.ts'],
      // Same as vitest.shared.mts: these ship ESM that Node cannot import directly.
      server: { deps: { inline: [/@mui\/material/, /react-transition-group/] } },
    },
  }),
);
