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

  it('ci0/ci1/argmin/argmax remain unimplemented (undefined, for callers to gap)', () => {
    expect(evaluateAggregate('ci0', values)).to.equal(undefined);
    expect(evaluateAggregate('ci1', values)).to.equal(undefined);
  });
});
