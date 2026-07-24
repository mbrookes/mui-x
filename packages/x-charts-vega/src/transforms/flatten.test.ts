import { createGapCollector } from '../gaps';
import { applyFlattenTransform } from './flatten';
import type { VegaFlattenTransform } from '../types';

describe('applyFlattenTransform', () => {
  it("expands an array-valued field into one row per element (boxplot_preaggregated's outliers)", () => {
    const gaps = createGapCollector();
    const rows = [
      { species: 'Adelie', lower: 2850, outliers: [] },
      { species: 'Chinstrap', lower: 2700, outliers: [2700, 4800] },
      { species: 'Gentoo', lower: 3950, outliers: [] },
    ];
    const transform: VegaFlattenTransform = { flatten: ['outliers'] };
    const result = applyFlattenTransform(rows, transform, gaps, '$');
    // The empty-array rows (Adelie, Gentoo) contribute no output rows at
    // all — not a row of nulls — matching Vega-Lite.
    expect(result).to.deep.equal([
      { species: 'Chinstrap', lower: 2700, outliers: 2700 },
      { species: 'Chinstrap', lower: 2700, outliers: 4800 },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('treats a non-array value as a single-element array (row survives unchanged)', () => {
    const rows = [{ v: 5 }];
    const result = applyFlattenTransform(rows, { flatten: ['v'] }, createGapCollector(), '$');
    expect(result).to.deep.equal([{ v: 5 }]);
  });

  it('zips multiple flattened fields by index, filling undefined past the shorter array', () => {
    const gaps = createGapCollector();
    const rows = [{ a: [1, 2, 3], b: ['x', 'y'] }];
    const result = applyFlattenTransform(rows, { flatten: ['a', 'b'] }, gaps, '$');
    expect(result).to.deep.equal([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
      { a: 3, b: undefined },
    ]);
  });

  it('renames flattened output fields via `as`, keeping the original array field intact', () => {
    const gaps = createGapCollector();
    const rows = [{ vals: [10, 20] }];
    const result = applyFlattenTransform(rows, { flatten: ['vals'], as: ['v'] }, gaps, '$');
    expect(result).to.deep.equal([
      { vals: [10, 20], v: 10 },
      { vals: [10, 20], v: 20 },
    ]);
  });

  it('reports an unsupported gap and passes rows through when `flatten` is empty/missing', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }];
    const result = applyFlattenTransform(rows, { flatten: [] }, gaps, '$.transform[0]');
    expect(result).to.deep.equal(rows);
    const gap = gaps.list().find((entry) => entry.code === 'transform:flatten');
    expect(gap?.severity).to.equal('unsupported');
  });
});
