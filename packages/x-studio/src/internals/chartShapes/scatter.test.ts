import { describe, expect, it } from 'vitest';
import {
  buildScatterCategoryColorMap,
  prepareScatterData,
  prepareScatterDataGrouped,
} from './scatter';

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
