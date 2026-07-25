import { describe, expect, it } from 'vitest';
import {
  buildScatterCategoryColorMap,
  prepareScatterData,
  prepareScatterDataGrouped,
} from './scatter';
import { frLocaleText } from '../../locales/fr';

describe('prepareScatterData', () => {
  it('maps rows to x/y points with a stable index id', () => {
    const rows = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    expect(prepareScatterData(rows, 'x', 'y')).toEqual([
      { x: 1, y: 2, id: 0, sizeValue: undefined },
      { x: 3, y: 4, id: 1, sizeValue: undefined },
    ]);
  });

  // Regression (M13). The surviving points keep their ORIGINAL row index as `id`, so the
  // ids stay traceable back to `rows` and are simply non-contiguous across a dropped row.
  it('keeps the original row index as id when unplottable rows are dropped', () => {
    const rows = [
      { x: 1, y: 2 },
      { x: null, y: 4 }, // dropped
      { x: 5, y: 6 },
    ];
    expect(prepareScatterData(rows, 'x', 'y').map((p) => p.id)).toEqual([0, 2]);
  });

  // A missing bubble SIZE is a missing decoration, not a missing measurement — the point's
  // real x/y coordinate must stay on the plot, so size falls back to 0 rather than dropping
  // the row (and coerces via the shared policy so a non-numeric size is never a NaN radius).
  it('keeps a point whose size field is null/non-numeric, defaulting its size to 0', () => {
    const rows = [
      { x: 1, y: 2, size: null },
      { x: 3, y: 4, size: 'N/A' },
    ];
    expect(prepareScatterData(rows, 'x', 'y', 'size').map((p) => p.sizeValue)).toEqual([0, 0]);
  });
});

describe('prepareScatterDataGrouped', () => {
  it('only returns categories that have data in the given rows', () => {
    const rows = [
      { x: 1, y: 2, cat: 'a' },
      { x: 3, y: 4, cat: 'a' },
    ];
    const result = prepareScatterDataGrouped(rows, 'x', 'y', 'cat', ['a', 'b']);
    expect(result.map((s) => s.id)).toEqual(['a']);
  });

  // Regression (M13): the grouped path shares the ungrouped path's drop rule, so a category
  // whose every row lacks a plottable coordinate yields no series at all rather than a
  // stack of fabricated points at the origin.
  it('drops rows without a plottable x/y, and the categories left empty by that', () => {
    const rows = [
      { x: 1, y: 2, cat: 'a' },
      { x: null, y: 4, cat: 'b' },
      { x: 5, y: 'N/A', cat: 'b' },
    ];
    const result = prepareScatterDataGrouped(rows, 'x', 'y', 'cat', ['a', 'b']);
    expect(result.map((s) => s.id)).toEqual(['a']);
    expect(result[0].data).toEqual([{ x: 1, y: 2, id: 0, sizeValue: undefined }]);
  });

  // Regression for finding 4: the null/blank colorField bucket used to hardcode the English
  // '(blank)' literal, bypassing the configurable `chartEmptyCategoryLabel` every other chart
  // type's empty-category bucket already honours (see `chartValues.ts`'s `emptyBucketLabel`,
  // threaded through `toXValue`/`isEmptyXValue`).
  it('defaults the empty/null colorField bucket to the English "(empty)" label, not "(blank)"', () => {
    const rows = [
      { x: 1, y: 2, cat: null },
      { x: 3, y: 4, cat: '' },
    ];
    const result = prepareScatterDataGrouped(rows, 'x', 'y', 'cat', ['(empty)']);
    expect(result.map((s) => s.id)).toEqual(['(empty)']);
    expect(result[0].data).toHaveLength(2);
  });

  it('routes the empty colorField bucket through localeText when supplied (finding 4)', () => {
    const emptyLabel = frLocaleText.chartEmptyCategoryLabel!;
    const rows = [{ x: 1, y: 2, cat: null }];
    const result = prepareScatterDataGrouped(
      rows,
      'x',
      'y',
      'cat',
      [emptyLabel],
      undefined,
      frLocaleText,
    );
    expect(result.map((s) => s.id)).toEqual([emptyLabel]);
    // Never falls back to the old hardcoded English literal when a locale is supplied.
    expect(result.map((s) => s.id)).not.toContain('(blank)');
  });
});

describe('buildScatterCategoryColorMap', () => {
  it('assigns colors by category identity, keyed to a stable order', () => {
    const map = buildScatterCategoryColorMap(['a', 'b', 'c'], ['red', 'green', 'blue']);
    expect(map.get('a')).toBe('red');
    expect(map.get('b')).toBe('green');
    expect(map.get('c')).toBe('blue');
  });

  it('wraps around the palette when there are more categories than colors', () => {
    const map = buildScatterCategoryColorMap(['a', 'b', 'c'], ['red', 'green']);
    expect(map.get('a')).toBe('red');
    expect(map.get('b')).toBe('green');
    expect(map.get('c')).toBe('red');
  });

  it('keeps a category color stable when a shorter (filtered) list omits earlier categories', () => {
    // Baseline (ghost) order determines position, so a category's color does not
    // shift just because some earlier categories are missing from a subset list.
    const baseline = ['a', 'b', 'c', 'd'];
    const colors = ['red', 'green', 'blue', 'yellow'];
    const map = buildScatterCategoryColorMap(baseline, colors);
    // 'b' is missing from the filtered set, but 'c' and 'd' keep their baseline color.
    expect(map.get('c')).toBe('blue');
    expect(map.get('d')).toBe('yellow');
  });

  it('returns an empty map when no colors are available', () => {
    const map = buildScatterCategoryColorMap(['a', 'b'], []);
    expect(map.size).toBe(0);
  });
});
