import { mergeConfig } from 'vitest/config';
import sharedConfig from '../../vitest.shared.mts';
import { getTestName } from '../../scripts/getTestName.mts';

export default mergeConfig(sharedConfig, {
  test: {
    name: getTestName(import.meta.url),
    environment: 'jsdom',
    // The first test in a file can be slow while jsdom warms up — 30s avoids
    // flaky timeouts without masking real hangs.
    testTimeout: 30000,
    // Override the shared `isolate: false`. The x-studio suite relies on
    // module-level caches/memoized selectors (StudioRequestCache, enriched/
    // partitioned-filter caches) that leak across files when the worker
    // registry is shared, producing order-dependent flakiness. Per-file
    // isolation keeps the suite deterministic.
    isolate: true,
  },
});
