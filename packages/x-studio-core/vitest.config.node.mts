import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getTestName } from '../../scripts/getTestName.mts';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: getTestName(import.meta.url),
    // `node`, not `jsdom` — this package must not need a DOM. If a test here starts
    // requiring one, the module under test has grown a browser dependency and belongs
    // in a binding instead.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    root: resolve(CURRENT_DIR),
    testTimeout: 10000,
  },
});
