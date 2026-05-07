import { describe, it, expect } from 'vitest';
import { getCachedNormalizedDataSource } from './normalizedRowsCache';
import type { StudioDataField, StudioDataSource } from '../models';

type Row = Record<string, unknown>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSource(rows: Row[], fields: StudioDataField[] = []): StudioDataSource {
  return {
    id: 'src1',
    label: 'Source',
    rows,
    fields,
  };
}

const stringField: StudioDataField = { id: 'region', label: 'Region', type: 'string' };
const dateField: StudioDataField = { id: 'date', label: 'Date', type: 'date' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getCachedNormalizedDataSource', () => {
  it('returns the same reference on a cache hit (same rows + fields)', () => {
    const rows: Row[] = [{ id: 1, region: 'EU' }];
    const source = makeSource(rows, [stringField]);

    const first = getCachedNormalizedDataSource(source);
    const second = getCachedNormalizedDataSource(source);

    // Identical object reference — no recomputation.
    expect(second).toBe(first);
  });

  it('recomputes when rows reference changes', () => {
    const rows1: Row[] = [{ id: 1, region: 'EU' }];
    const rows2: Row[] = [{ id: 2, region: 'US' }]; // new array
    const fields = [stringField];

    const first = getCachedNormalizedDataSource(makeSource(rows1, fields));
    const second = getCachedNormalizedDataSource(makeSource(rows2, fields));

    expect(second).not.toBe(first);
    expect(second.rows![0]).toMatchObject({ id: 2, region: 'US' });
  });

  it('recomputes when fields reference changes', () => {
    const rows: Row[] = [{ id: 1, region: 'EU' }];

    const fields1 = [stringField];
    const fields2 = [{ ...stringField }]; // new array / new field object

    const first = getCachedNormalizedDataSource(makeSource(rows, fields1));
    const second = getCachedNormalizedDataSource(makeSource(rows, fields2));

    // Different fields ref → cache miss, recomputed (result may be equal in value
    // but must be a distinct computation attempt).
    expect(second).not.toBe(first);
  });

  it('passes through a source with no rows unchanged', () => {
    const source: StudioDataSource = { id: 's', label: 'S', fields: [], rows: [] };
    const result = getCachedNormalizedDataSource(source);
    expect(result).toBe(source);
  });

  it('passes through a source with undefined rows unchanged', () => {
    const source: StudioDataSource = { id: 's', label: 'S', fields: [] };
    const result = getCachedNormalizedDataSource(source);
    expect(result).toBe(source);
  });

  it('builds fieldDistinctValues for string fields', () => {
    const rows: Row[] = [
      { id: 1, region: 'EU' },
      { id: 2, region: 'US' },
      { id: 3, region: 'EU' },
    ];
    const source = makeSource(rows, [stringField]);
    const result = getCachedNormalizedDataSource(source);

    expect(result.fieldDistinctValues).toBeDefined();
    expect(result.fieldDistinctValues!.region).toEqual(['EU', 'US']);
  });

  it('normalizes date strings to ISO format', () => {
    const rows: Row[] = [{ id: 1, date: new Date('2024-03-15') }];
    const source = makeSource(rows, [dateField]);
    const result = getCachedNormalizedDataSource(source);

    expect(result.rows![0].date).toBe('2024-03-15');
  });

  it('returns cached result without rebuilding fieldDistinctValues on second call', () => {
    const rows: Row[] = [{ id: 1, region: 'EU' }, { id: 2, region: 'US' }];
    const source = makeSource(rows, [stringField]);

    const first = getCachedNormalizedDataSource(source);
    const second = getCachedNormalizedDataSource(source);

    // Same reference means fieldDistinctValues was NOT rebuilt
    expect(second).toBe(first);
    expect(second.fieldDistinctValues!.region).toEqual(['EU', 'US']);
  });

  it('different sources with different rows are cached independently', () => {
    const rowsA: Row[] = [{ id: 1, region: 'EU' }];
    const rowsB: Row[] = [{ id: 2, region: 'US' }];
    const fields = [stringField];

    const a = getCachedNormalizedDataSource(makeSource(rowsA, fields));
    const b = getCachedNormalizedDataSource(makeSource(rowsB, fields));

    // Each rows array gets its own cache entry
    expect(a).not.toBe(b);
    expect(a.rows![0]).toMatchObject({ id: 1 });
    expect(b.rows![0]).toMatchObject({ id: 2 });

    // Second call for A still hits cache
    expect(getCachedNormalizedDataSource(makeSource(rowsA, fields))).toBe(a);
  });
});
