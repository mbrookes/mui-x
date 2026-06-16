import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getTestName } from '../../scripts/getTestName.mts';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: getTestName(import.meta.url),
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    root: resolve(CURRENT_DIR),
    testTimeout: 10000,
  },
});
