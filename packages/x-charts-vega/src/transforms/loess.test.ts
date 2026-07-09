import { createGapCollector } from '../gaps';
import { applyLoessTransform } from './loess';
import type { VegaLoessTransform } from '../types';

describe('applyLoessTransform', () => {
  it('recovers an exact line with no smoothing error', () => {
    const gaps = createGapCollector();
    const rows = Array.from({ length: 20 }, (_unused, i) => ({ x: i, y: 2 * i + 1 }));
    const transform: VegaLoessTransform = { loess: 'y', on: 'x' };
    const result = applyLoessTransform(rows, transform, gaps, '$');
    result.forEach((row) => {
      expect(row.y).to.be.closeTo(2 * (row.x as number) + 1, 1e-6);
    });
  });

  it('smooths a single outlier toward its neighbors', () => {
    const gaps = createGapCollector();
    const rows = Array.from({ length: 21 }, (_unused, i) => ({ x: i, y: 5 }));
    // Inject a large single-point outlier in the middle.
    rows[10] = { x: 10, y: 500 };
    const transform: VegaLoessTransform = { loess: 'y', on: 'x', bandwidth: 0.5 };
    const result = applyLoessTransform(rows, transform, gaps, '$');
    const fittedAtOutlier = result[10].y as number;
    // The robust fit should pull the outlier's fitted value far below its raw
    // value of 500, toward the surrounding constant-5 neighborhood.
    expect(fittedAtOutlier).to.be.lessThan(100);
  });

  it('fits independently per groupby partition', () => {
    const gaps = createGapCollector();
    const rows = [
      ...Array.from({ length: 5 }, (_unused, i) => ({ g: 'A', x: i, y: i })),
      ...Array.from({ length: 5 }, (_unused, i) => ({ g: 'B', x: i, y: 10 - i })),
    ];
    const transform: VegaLoessTransform = { loess: 'y', on: 'x', groupby: ['g'] };
    const result = applyLoessTransform(rows, transform, gaps, '$');
    const groupA = result.filter((row) => row.g === 'A');
    const groupB = result.filter((row) => row.g === 'B');
    expect(groupA).to.have.length(5);
    expect(groupB).to.have.length(5);
    // Group A trends up, group B trends down.
    expect((groupA[4].y as number) > (groupA[0].y as number)).to.equal(true);
    expect((groupB[4].y as number) < (groupB[0].y as number)).to.equal(true);
  });

  it('output rows are sorted by x, regardless of input order', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: 3, y: 3 },
      { x: 1, y: 1 },
      { x: 4, y: 4 },
      { x: 2, y: 2 },
      { x: 0, y: 0 },
    ];
    const transform: VegaLoessTransform = { loess: 'y', on: 'x' };
    const result = applyLoessTransform(rows, transform, gaps, '$');
    expect(result.map((row) => row.x)).to.deep.equal([0, 1, 2, 3, 4]);
  });

  it('defaults `as` to [on, loess]', () => {
    const gaps = createGapCollector();
    const rows = [
      { myX: 0, myY: 0 },
      { myX: 1, myY: 1 },
      { myX: 2, myY: 2 },
    ];
    const transform: VegaLoessTransform = { loess: 'myY', on: 'myX' };
    const result = applyLoessTransform(rows, transform, gaps, '$');
    expect(Object.keys(result[0])).to.include.members(['myX', 'myY']);
  });

  it('groups with fewer than 3 points pass through unsmoothed, no gap', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: 1, y: 5 },
      { x: 2, y: 9 },
    ];
    const transform: VegaLoessTransform = { loess: 'y', on: 'x' };
    const result = applyLoessTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([
      { x: 1, y: 5 },
      { x: 2, y: 9 },
    ]);
    expect(gaps.list()).to.have.length(0);
  });
});
