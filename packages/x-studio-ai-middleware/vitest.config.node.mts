import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getTestName } from '../../scripts/getTestName.mts';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The shared test utilities live outside every package (`<repo>/test/utils`), and the
  // jsdom projects reach them through this alias in `vitest.shared.mts`. This project does
  // not extend that config, so it declares the same alias rather than importing across the
  // package boundary by relative path.
  resolve: {
    alias: [
      {
        find: 'test/utils',
        replacement: resolve(CURRENT_DIR, '../../test/utils'),
      },
    ],
  },
  test: {
    name: `${getTestName(import.meta.url)}-node`,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    root: resolve(CURRENT_DIR),
    testTimeout: 10000,
  },
});
