import { evaluateAggregate } from './aggregateOps';

describe('evaluateAggregate / new ops', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('q1 / q3 compute linear-interpolation quartiles', () => {
    expect(evaluateAggregate('q1', values)).to.be.closeTo(3.25, 1e-9);
    expect(evaluateAggregate('q3', values)).to.be.closeTo(7.75, 1e-9);
  });

  it('q1/q3 return the single value for a single-element array', () => {
    expect(evaluateAggregate('q1', [5])).to.equal(5);
    expect(evaluateAggregate('q3', [5])).to.equal(5);
  });

  it('q1/q3 return null for empty input', () => {
    expect(evaluateAggregate('q1', [])).to.equal(null);
    expect(evaluateAggregate('q3', [])).to.equal(null);
  });

  it('variancep / stdevp compute population variance/stdev (divide by n)', () => {
    // Population variance of [2, 4, 4, 4, 5, 5, 7, 9] is 4, stdev is 2.
    const dataset = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(evaluateAggregate('variancep', dataset)).to.be.closeTo(4, 1e-9);
    expect(evaluateAggregate('stdevp', dataset)).to.be.closeTo(2, 1e-9);
  });

  it('variancep/stdevp require at least one value', () => {
    expect(evaluateAggregate('variancep', [])).to.equal(null);
    expect(evaluateAggregate('stdevp', [])).to.equal(null);
  });

  it('stderr computes stdev / sqrt(n)', () => {
    const dataset = [2, 4, 4, 4, 5, 5, 7, 9];
    const stdev = evaluateAggregate('stdev', dataset) as number;
    const stderr = evaluateAggregate('stderr', dataset) as number;
    expect(stderr).to.be.closeTo(stdev / Math.sqrt(dataset.length), 1e-9);
  });

  it('stderr requires at least two values (same as stdev)', () => {
    expect(evaluateAggregate('stderr', [5])).to.equal(null);
  });

  it('product multiplies all numeric values', () => {
    expect(evaluateAggregate('product', [1, 2, 3, 4])).to.equal(24);
  });

  it('product returns null for empty input', () => {
    expect(evaluateAggregate('product', [])).to.equal(null);
  });

  it('ci0/ci1 compute a normal-approximation confidence interval (mean ∓ 1.96·stderr)', () => {
    const mean = 5.5;
    const stderr = evaluateAggregate('stderr', values) as number;
    expect(evaluateAggregate('ci0', values)).to.be.closeTo(mean - 1.96 * stderr, 1e-9);
    expect(evaluateAggregate('ci1', values)).to.be.closeTo(mean + 1.96 * stderr, 1e-9);
  });

  it('ci0/ci1 require at least two values', () => {
    expect(evaluateAggregate('ci0', [5])).to.equal(null);
    expect(evaluateAggregate('ci1', [])).to.equal(null);
  });

  it('argmin/argmax return undefined without a rows argument (for callers to gap)', () => {
    expect(evaluateAggregate('argmin', values)).to.equal(undefined);
    expect(evaluateAggregate('argmax', values)).to.equal(undefined);
  });

  it('argmin/argmax return the whole row at the extreme value when rows are supplied', () => {
    const rows = [
      { k: 'a', v: 3 },
      { k: 'b', v: 1 },
      { k: 'c', v: 9 },
    ];
    const fieldValues = rows.map((row) => row.v);
    expect(evaluateAggregate('argmin', fieldValues, rows)).to.deep.equal({ k: 'b', v: 1 });
    expect(evaluateAggregate('argmax', fieldValues, rows)).to.deep.equal({ k: 'c', v: 9 });
  });

  it('argmin/argmax return null when no numeric values are present', () => {
    const rows = [{ v: null }, { v: 'x' }];
    expect(evaluateAggregate('argmin', [null, 'x'], rows)).to.equal(null);
  });
});
