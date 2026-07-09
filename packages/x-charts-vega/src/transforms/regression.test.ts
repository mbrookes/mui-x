import { createGapCollector } from '../gaps';
import { applyRegressionTransform } from './regression';
import type { VegaRegressionTransform } from '../types';

describe('applyRegressionTransform', () => {
  it('fits an exact linear line y = 2x + 1: 2 endpoint samples', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
      { x: 3, y: 7 },
    ];
    const transform: VegaRegressionTransform = { regression: 'y', on: 'x' };
    const result = applyRegressionTransform(rows, transform, gaps, '$');
    expect(result).to.have.length(2);
    expect(result[0].x).to.be.closeTo(0, 1e-9);
    expect(result[0].y).to.be.closeTo(1, 1e-9);
    expect(result[1].x).to.be.closeTo(3, 1e-9);
    expect(result[1].y).to.be.closeTo(7, 1e-9);
  });

  it('params:true reports coef ~= [1, 2] and rSquared ~= 1 for an exact linear fit', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
      { x: 3, y: 7 },
    ];
    const transform: VegaRegressionTransform = { regression: 'y', on: 'x', params: true };
    const result = applyRegressionTransform(rows, transform, gaps, '$');
    expect(result).to.have.length(1);
    const [row] = result;
    const coef = row.coef as number[];
    expect(coef[0]).to.be.closeTo(1, 1e-9);
    expect(coef[1]).to.be.closeTo(2, 1e-9);
    expect(row.rSquared).to.be.closeTo(1, 1e-9);
  });

  it('honors an explicit extent for sampling', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ];
    const transform: VegaRegressionTransform = { regression: 'y', on: 'x', extent: [10, 20] };
    const result = applyRegressionTransform(rows, transform, gaps, '$');
    expect(result[0].x).to.be.closeTo(10, 1e-9);
    expect(result[1].x).to.be.closeTo(20, 1e-9);
  });

  it('fits independently per groupby partition', () => {
    const gaps = createGapCollector();
    const rows = [
      { g: 'A', x: 0, y: 0 },
      { g: 'A', x: 1, y: 1 },
      { g: 'B', x: 0, y: 0 },
      { g: 'B', x: 1, y: 2 },
    ];
    const transform: VegaRegressionTransform = {
      regression: 'y',
      on: 'x',
      groupby: ['g'],
      params: true,
    };
    const result = applyRegressionTransform(rows, transform, gaps, '$');
    expect(result).to.have.length(2);
    const byGroup = Object.fromEntries(result.map((row) => [row.g, row.coef as number[]]));
    expect(byGroup.A[1]).to.be.closeTo(1, 1e-9);
    expect(byGroup.B[1]).to.be.closeTo(2, 1e-9);
  });

  it('poly order 2 recovers an exact quadratic y = x^2', () => {
    const gaps = createGapCollector();
    const rows = [-2, -1, 0, 1, 2, 3].map((x) => ({ x, y: x * x }));
    const transform: VegaRegressionTransform = {
      regression: 'y',
      on: 'x',
      method: 'quad',
      params: true,
    };
    const result = applyRegressionTransform(rows, transform, gaps, '$');
    const coef = result[0].coef as number[];
    // y = 0 + 0x + 1x^2
    expect(coef[0]).to.be.closeTo(0, 1e-6);
    expect(coef[1]).to.be.closeTo(0, 1e-6);
    expect(coef[2]).to.be.closeTo(1, 1e-6);
    expect(result[0].rSquared).to.be.closeTo(1, 1e-9);
  });

  it('log/exp/pow fits recover noiseless synthetic curves', () => {
    const gaps = createGapCollector();

    // log: y = 2 + 3 ln(x)
    const logRows = [1, 2, 4, 8, 16].map((x) => ({ x, y: 2 + 3 * Math.log(x) }));
    const logResult = applyRegressionTransform(
      logRows,
      { regression: 'y', on: 'x', method: 'log', params: true },
      gaps,
      '$',
    );
    const logCoef = logResult[0].coef as number[];
    expect(logCoef[0]).to.be.closeTo(2, 1e-6);
    expect(logCoef[1]).to.be.closeTo(3, 1e-6);

    // exp: y = 2 * e^(0.5x)
    const expRows = [0, 1, 2, 3, 4].map((x) => ({ x, y: 2 * Math.exp(0.5 * x) }));
    const expResult = applyRegressionTransform(
      expRows,
      { regression: 'y', on: 'x', method: 'exp', params: true },
      gaps,
      '$',
    );
    const expCoef = expResult[0].coef as number[];
    expect(expCoef[0]).to.be.closeTo(2, 1e-6);
    expect(expCoef[1]).to.be.closeTo(0.5, 1e-6);

    // pow: y = 3 * x^2
    const powRows = [1, 2, 3, 4, 5].map((x) => ({ x, y: 3 * x ** 2 }));
    const powResult = applyRegressionTransform(
      powRows,
      { regression: 'y', on: 'x', method: 'pow', params: true },
      gaps,
      '$',
    );
    const powCoef = powResult[0].coef as number[];
    expect(powCoef[0]).to.be.closeTo(3, 1e-6);
    expect(powCoef[1]).to.be.closeTo(2, 1e-6);
  });

  it('drops out-of-domain pairs for log/pow (x<=0) and reports a partial domain gap', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: -1, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 4, y: 4 },
    ];
    const transform: VegaRegressionTransform = { regression: 'y', on: 'x', method: 'log' };
    const result = applyRegressionTransform(rows, transform, gaps, '$');
    expect(result.length).to.be.greaterThan(0);
    const gap = gaps.list().find((entry) => entry.code === 'transform:regression-domain');
    expect(gap?.severity).to.equal('partial');
  });

  it('an unknown method reports a partial gap and falls back to linear', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
    ];
    const transform = {
      regression: 'y',
      on: 'x',
      method: 'madeUp',
    } as unknown as VegaRegressionTransform;
    const result = applyRegressionTransform(rows, transform, gaps, '$');
    expect(result).to.have.length(2);
    const gap = gaps.list().find((entry) => entry.code === 'transform:regression-method');
    expect(gap?.severity).to.equal('partial');
  });

  it('defaults `as` to [on, regression]', () => {
    const gaps = createGapCollector();
    const rows = [
      { myX: 0, myY: 0 },
      { myX: 1, myY: 1 },
    ];
    const transform: VegaRegressionTransform = { regression: 'myY', on: 'myX' };
    const result = applyRegressionTransform(rows, transform, gaps, '$');
    expect(Object.keys(result[0])).to.include.members(['myX', 'myY']);
  });

  it('groups with fewer than 2 valid pairs emit nothing', () => {
    const gaps = createGapCollector();
    const rows = [{ x: 1, y: 1 }];
    const transform: VegaRegressionTransform = { regression: 'y', on: 'x' };
    const result = applyRegressionTransform(rows, transform, gaps, '$');
    expect(result).to.deep.equal([]);
  });

  it('quad with only 2 points clamps the degree instead of a rank-deficient fit', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: 0, y: 1 },
      { x: 2, y: 5 },
    ];
    const transform: VegaRegressionTransform = {
      regression: 'y',
      on: 'x',
      method: 'quad',
      params: true,
    };
    const result = applyRegressionTransform(rows, transform, gaps, '$');
    const coef = result[0].coef as number[];
    // Degree clamped to 1 (a line through the 2 points): y = 1 + 2x.
    expect(coef).to.have.length(2);
    expect(coef[0]).to.be.closeTo(1, 1e-9);
    expect(coef[1]).to.be.closeTo(2, 1e-9);
    expect(result[0].rSquared).to.be.closeTo(1, 1e-9);
  });
});
