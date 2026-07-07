import { describe, expect, it } from 'vitest';
import { normalizeGridColumn, createDefaultStudioState } from './index';

// Regression test for a defect where `normalizeGridColumn` (a runtime function
// re-exported from `@mui/x-studio-schema`) was placed inside an
// `export type { ... }` block in `src/index.ts`. Type-only exports are erased
// at compile time, so `import { normalizeGridColumn } from '@mui/x-studio'`
// type-checked but resolved to `undefined` at runtime for any real consumer.
//
// Importing from `./index` here exercises the same public barrel that
// `@mui/x-studio`'s package.json `exports["."]` points at (`./src/index.ts`),
// so this catches the type-only/value-export mistake without needing to
// build and consume the published package.
describe('public API — value exports survive the barrel', () => {
  it('normalizeGridColumn is exported as a callable runtime value', () => {
    expect(typeof normalizeGridColumn).toBe('function');
    expect(normalizeGridColumn('fieldA')).toEqual({ fieldId: 'fieldA' });
    expect(normalizeGridColumn({ fieldId: 'fieldB' })).toEqual({ fieldId: 'fieldB' });
  });

  it('sanity check: other known value exports from the barrel are also functions', () => {
    // Cross-check against a sibling export that already worked correctly,
    // to make sure this test would have failed before the fix (and isn't
    // trivially true for any import).
    expect(typeof createDefaultStudioState).toBe('function');
  });
});
