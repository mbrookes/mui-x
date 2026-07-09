import { createGapCollector } from '../gaps';
import { applyDensityTransform } from './density';
import type { VegaDensityTransform } from '../types';

describe('applyDensityTransform', () => {
  it('the PDF integrates to approximately 1 over the sampled grid', () => {
    const gaps = createGapCollector();
    const values = Array.from({ length: 200 }, (_unused, i) => i % 20);
    const rows = values.map((v) => ({ v }));
    const transform: VegaDensityTransform = {
      density: 'v',
      extent: [-10, 30],
      steps: 400,
    };
    const result = applyDensityTransform(rows, transform, gaps, '$');
    const xs = result.map((row) => row.value as number);
    const ys = result.map((row) => row.density as number);
    // Trapezoidal integration.
    let integral = 0;
    for (let i = 1; i < xs.length; i += 1) {
      integral += ((ys[i] + ys[i - 1]) / 2) * (xs[i] - xs[i - 1]);
    }
    expect(integral).to.be.closeTo(1, 0.05);
  });

  it('cumulative density is monotone non-decreasing, from ~0 to ~1', () => {
    const gaps = createGapCollector();
    const rows = Array.from({ length: 50 }, (_unused, i) => ({ v: i }));
    const transform: VegaDensityTransform = { density: 'v', cumulative: true, steps: 100 };
    const result = applyDensityTransform(rows, transform, gaps, '$');
    const ys = result.map((row) => row.density as number);
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i]).to.be.at.least(ys[i - 1] - 1e-9);
    }
    expect(ys[0]).to.be.closeTo(0, 0.1);
    expect(ys[ys.length - 1]).to.be.closeTo(1, 0.1);
  });

  it('`counts: true` scales the output by the group size', () => {
    const gaps = createGapCollector();
    const rows = Array.from({ length: 30 }, (_unused, i) => ({ v: i % 10 }));
    const withoutCounts = applyDensityTransform(rows, { density: 'v', steps: 10 }, gaps, '$');
    const withCounts = applyDensityTransform(
      rows,
      { density: 'v', steps: 10, counts: true },
      gaps,
      '$',
    );
    withoutCounts.forEach((row, i) => {
      expect(withCounts[i].density).to.be.closeTo((row.density as number) * rows.length, 1e-9);
    });
  });

  it('honors an explicit bandwidth/extent/steps', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const transform: VegaDensityTransform = {
      density: 'v',
      bandwidth: 0.5,
      extent: [0, 4],
      steps: 4,
    };
    const result = applyDensityTransform(rows, transform, gaps, '$');
    expect(result).to.have.length(5);
    expect(result[0].value).to.equal(0);
    expect(result[4].value).to.equal(4);
  });

  it('computes independently per groupby partition', () => {
    const gaps = createGapCollector();
    const rows = [
      { g: 'A', v: 1 },
      { g: 'A', v: 2 },
      { g: 'B', v: 10 },
      { g: 'B', v: 11 },
    ];
    const transform: VegaDensityTransform = { density: 'v', groupby: ['g'], steps: 4 };
    const result = applyDensityTransform(rows, transform, gaps, '$');
    const groups = new Set(result.map((row) => row.g));
    expect(groups).to.deep.equal(new Set(['A', 'B']));
    expect(result).to.have.length(10);
  });

  it('constant data (zero spread) does not divide by zero / produce NaN', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 5 }, { v: 5 }, { v: 5 }, { v: 5 }];
    const transform: VegaDensityTransform = { density: 'v', steps: 4 };
    const result = applyDensityTransform(rows, transform, gaps, '$');
    result.forEach((row) => {
      expect(Number.isFinite(row.density as number)).to.equal(true);
      expect(Number.isNaN(row.density as number)).to.equal(false);
    });
  });
});
