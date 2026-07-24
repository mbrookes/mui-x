import { resolveFieldPath } from './fieldTypes';

describe('resolveFieldPath', () => {
  it('reads a bare top-level field with no parsing', () => {
    expect(resolveFieldPath({ amount: 42 }, 'amount')).to.equal(42);
  });

  it('returns undefined for a missing bare field', () => {
    expect(resolveFieldPath({ amount: 42 }, 'missing')).to.equal(undefined);
  });

  it('resolves a bracket-indexed array field (Vega-Lite field-path syntax, e.g. a bullet chart\'s "ranges[2]")', () => {
    const row = { ranges: [150, 225, 300] };
    expect(resolveFieldPath(row, 'ranges[2]')).to.equal(300);
    expect(resolveFieldPath(row, 'ranges[0]')).to.equal(150);
  });

  it('resolves a dotted nested-object field path', () => {
    const row = { a: { b: { c: 7 } } };
    expect(resolveFieldPath(row, 'a.b.c')).to.equal(7);
  });

  it('resolves a mixed dotted + bracket-indexed field path', () => {
    const row = { a: { b: [{ c: 'x' }, { c: 'y' }] } };
    expect(resolveFieldPath(row, 'a.b[1].c')).to.equal('y');
  });

  it('returns undefined for an out-of-range array index or a path through a non-object', () => {
    const row = { ranges: [1, 2] };
    expect(resolveFieldPath(row, 'ranges[5]')).to.equal(undefined);
    expect(resolveFieldPath({ n: 1 }, 'n.missing')).to.equal(undefined);
  });
});
