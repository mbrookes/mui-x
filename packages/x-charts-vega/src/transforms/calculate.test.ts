import { createGapCollector } from '../gaps';
import { applyCalculateTransform , compileExpression, isTruthy, UnsupportedExpressionError } from './calculate';

describe('calculate.ts / compileExpression', () => {
  it('reads datum field access via dot and bracket notation', () => {
    const evaluator = compileExpression("datum.a + datum['b']");
    expect(evaluator({ a: 1, b: 2 })).to.equal(3);
  });

  it('supports arithmetic with correct precedence', () => {
    expect(compileExpression('2 + 3 * 4')({})).to.equal(14);
    expect(compileExpression('(2 + 3) * 4')({})).to.equal(20);
    expect(compileExpression('10 % 3')({})).to.equal(1);
    expect(compileExpression('-datum.x')({ x: 5 })).to.equal(-5);
  });

  it('supports string concatenation via +', () => {
    expect(compileExpression('"a" + datum.b')({ b: 'c' })).to.equal('ac');
  });

  it('supports comparisons and logical operators', () => {
    expect(compileExpression('datum.x > 5 && datum.y < 10')({ x: 6, y: 1 })).to.equal(true);
    expect(compileExpression('datum.x > 5 && datum.y < 10')({ x: 1, y: 1 })).to.equal(false);
    expect(compileExpression('datum.x > 5 || datum.y < 10')({ x: 1, y: 1 })).to.equal(true);
    expect(compileExpression('!datum.flag')({ flag: false })).to.equal(true);
    expect(compileExpression('datum.a === datum.b')({ a: 1, b: 1 })).to.equal(true);
    expect(compileExpression('datum.a !== datum.b')({ a: 1, b: 2 })).to.equal(true);
  });

  it('`==`/`!=` are loose (numeric-string coercion), `===`/`!==` stay strict', () => {
    expect(compileExpression('datum.count == 5')({ count: '5' })).to.equal(true);
    expect(compileExpression('datum.count != 5')({ count: '5' })).to.equal(false);
    expect(compileExpression('datum.count === 5')({ count: '5' })).to.equal(false);
    expect(compileExpression('datum.count !== 5')({ count: '5' })).to.equal(true);
    expect(compileExpression('datum.a == null')({ a: null })).to.equal(true);
    expect(compileExpression('datum.a == 0')({ a: null })).to.equal(false);
  });

  it('relational operators coerce numerically when either side is a number', () => {
    expect(compileExpression('datum.s < 9')({ s: '10' })).to.equal(false);
    expect(compileExpression('datum.s > 9')({ s: '10' })).to.equal(true);
    expect(compileExpression('datum.a < datum.b')({ a: 'apple', b: 'banana' })).to.equal(true);
  });

  it('supports the ternary operator', () => {
    const evaluator = compileExpression('datum.x > 0 ? "pos" : "neg"');
    expect(evaluator({ x: 1 })).to.equal('pos');
    expect(evaluator({ x: -1 })).to.equal('neg');
  });

  it('supports the allow-listed function subset', () => {
    expect(compileExpression('abs(-5)')({})).to.equal(5);
    expect(compileExpression('round(1.6)')({})).to.equal(2);
    expect(compileExpression('floor(1.6)')({})).to.equal(1);
    expect(compileExpression('ceil(1.1)')({})).to.equal(2);
    expect(compileExpression('sqrt(9)')({})).to.equal(3);
    expect(compileExpression('min(3, 1, 2)')({})).to.equal(1);
    expect(compileExpression('max(3, 1, 2)')({})).to.equal(3);
    expect(compileExpression('length(datum.s)')({ s: 'abcd' })).to.equal(4);
    expect(compileExpression('upper(datum.s)')({ s: 'ab' })).to.equal('AB');
    expect(compileExpression('lower(datum.s)')({ s: 'AB' })).to.equal('ab');
    expect(compileExpression('toNumber(datum.s)')({ s: '42' })).to.equal(42);
    expect(compileExpression('toString(datum.n)')({ n: 42 })).to.equal('42');
  });

  it('supports year/month/date over a Date datum', () => {
    const date = new Date(2024, 5, 15); // June 15, 2024
    expect(compileExpression('year(datum.d)')({ d: date })).to.equal(2024);
    expect(compileExpression('month(datum.d)')({ d: date })).to.equal(5);
    expect(compileExpression('date(datum.d)')({ d: date })).to.equal(15);
  });

  it('throws UnsupportedExpressionError for unknown identifiers', () => {
    expect(() => compileExpression('foo + 1')({})).to.throw(UnsupportedExpressionError);
  });

  it('throws UnsupportedExpressionError for unknown functions', () => {
    expect(() => compileExpression('unknownFn(1)')({})).to.throw(UnsupportedExpressionError);
  });

  it('throws UnsupportedExpressionError for syntax errors', () => {
    expect(() => compileExpression('datum.x +')).to.throw(UnsupportedExpressionError);
    expect(() => compileExpression('1 + * 2')).to.throw(UnsupportedExpressionError);
    expect(() => compileExpression('datum.x > 1 > ')).to.throw(UnsupportedExpressionError);
  });

  it('isTruthy matches JS truthiness for common values', () => {
    expect(isTruthy(0)).to.equal(false);
    expect(isTruthy('')).to.equal(false);
    expect(isTruthy(null)).to.equal(false);
    expect(isTruthy(undefined)).to.equal(false);
    expect(isTruthy(1)).to.equal(true);
    expect(isTruthy('a')).to.equal(true);
  });
});

describe('applyCalculateTransform', () => {
  it('computes the expression per row and writes it to `as`', () => {
    const gaps = createGapCollector();
    const rows = [
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ];
    const result = applyCalculateTransform(
      rows,
      { calculate: 'datum.a + datum.b', as: 'sum' },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([
      { a: 1, b: 2, sum: 3 },
      { a: 3, b: 4, sum: 7 },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('records a gap and nulls `as` for an unparsable expression', () => {
    const gaps = createGapCollector();
    const rows = [{ a: 1 }];
    const result = applyCalculateTransform(rows, { calculate: 'datum.a +', as: 'out' }, gaps, '$');
    expect(result).to.deep.equal([{ a: 1, out: null }]);
    const gap = gaps.list().find((entry) => entry.code === 'transform:calculate');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('records a single deduped gap and nulls `as` for unsupported runtime syntax', () => {
    const gaps = createGapCollector();
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const result = applyCalculateTransform(
      rows,
      { calculate: 'unknownFn(datum.a)', as: 'out' },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([
      { a: 1, out: null },
      { a: 2, out: null },
      { a: 3, out: null },
    ]);
    expect(gaps.list().filter((entry) => entry.code === 'transform:calculate')).to.have.length(1);
  });

  it('normalizes NaN and undefined results to null', () => {
    const gaps = createGapCollector();
    const rows = [{ a: 'not-a-number' }];
    const result = applyCalculateTransform(
      rows,
      { calculate: 'datum.a / 0 * 0', as: 'out' },
      gaps,
      '$',
    );
    expect(result[0].out).to.equal(null);
  });
});
