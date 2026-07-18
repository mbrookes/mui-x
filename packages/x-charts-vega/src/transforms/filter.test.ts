import { createGapCollector } from '../gaps';
import { applyFilterTransform } from './filter';

const rows = [
  { cat: 'A', v: 1, d: new Date(2024, 0, 1) },
  { cat: 'B', v: 5, d: new Date(2024, 5, 1) },
  { cat: 'C', v: 10, d: new Date(2024, 11, 1) },
  { cat: 'D', v: null },
];

describe('applyFilterTransform / field predicates', () => {
  it('filters with equal', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: { field: 'cat', equal: 'B' } }, gaps, '$');
    expect(result).to.deep.equal([rows[1]]);
    expect(gaps.list()).to.have.length(0);
  });

  it('filters with lt/lte/gt/gte', () => {
    const gaps = createGapCollector();
    expect(applyFilterTransform(rows, { filter: { field: 'v', lt: 5 } }, gaps, '$')).to.deep.equal([
      rows[0],
    ]);
    expect(applyFilterTransform(rows, { filter: { field: 'v', lte: 5 } }, gaps, '$')).to.deep.equal(
      [rows[0], rows[1]],
    );
    expect(applyFilterTransform(rows, { filter: { field: 'v', gt: 5 } }, gaps, '$')).to.deep.equal([
      rows[2],
    ]);
    expect(applyFilterTransform(rows, { filter: { field: 'v', gte: 5 } }, gaps, '$')).to.deep.equal(
      [rows[1], rows[2]],
    );
  });

  it('filters with range', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: { field: 'v', range: [2, 9] } }, gaps, '$');
    expect(result).to.deep.equal([rows[1]]);
  });

  it('filters with oneOf', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      rows,
      { filter: { field: 'cat', oneOf: ['A', 'C'] } },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([rows[0], rows[2]]);
  });

  it('filters with valid', () => {
    const gaps = createGapCollector();
    expect(
      applyFilterTransform(rows, { filter: { field: 'v', valid: true } }, gaps, '$'),
    ).to.deep.equal([rows[0], rows[1], rows[2]]);
    expect(
      applyFilterTransform(rows, { filter: { field: 'v', valid: false } }, gaps, '$'),
    ).to.deep.equal([rows[3]]);
  });

  it('compares Date fields correctly', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      rows,
      { filter: { field: 'd', gt: new Date(2024, 2, 1) } },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([rows[1], rows[2]]);
  });

  it('filters exactly on a timeUnit year range, truncating the field instead of comparing raw values', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      rows,
      { filter: { field: 'd', timeUnit: 'year', range: [2024, 2024] } },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([rows[0], rows[1], rows[2]]);
    expect(gaps.list()).to.have.length(0);

    const excluded = applyFilterTransform(
      rows,
      { filter: { field: 'd', timeUnit: 'year', range: [2025, 2026] } },
      createGapCollector(),
      '$',
    );
    expect(excluded).to.deep.equal([]);
  });

  it('filters exactly on a timeUnit month oneOf (1-based, Vega-Lite convention)', () => {
    const gaps = createGapCollector();
    // rows[0].d is January, rows[1].d is June, rows[2].d is December.
    const result = applyFilterTransform(
      rows,
      { filter: { field: 'd', timeUnit: 'month', oneOf: [1, 12] } },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([rows[0], rows[2]]);
    expect(gaps.list()).to.have.length(0);
  });

  it('records a partial gap and falls back to a raw comparison for a composite timeUnit', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      rows,
      { filter: { field: 'd', timeUnit: 'yearmonth', gt: 5 } },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([rows[0], rows[1], rows[2]]);
    const gap = gaps.list().find((entry) => entry.code === 'filter:timeUnit-predicate');
    expect(gap?.severity).to.equal('partial');
  });
});

describe('applyFilterTransform / logical composition', () => {
  it('supports and', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      rows,
      {
        filter: {
          and: [
            { field: 'v', gt: 0 },
            { field: 'v', lt: 10 },
          ],
        },
      },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([rows[0], rows[1]]);
  });

  it('supports or', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      rows,
      {
        filter: {
          or: [
            { field: 'cat', equal: 'A' },
            { field: 'cat', equal: 'C' },
          ],
        },
      },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([rows[0], rows[2]]);
  });

  it('supports not', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      rows,
      { filter: { not: { field: 'cat', equal: 'A' } } },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([rows[1], rows[2], rows[3]]);
  });

  it('supports nested compositions', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      rows,
      { filter: { and: [{ field: 'v', valid: true }, { not: { field: 'cat', equal: 'A' } }] } },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([rows[1], rows[2]]);
  });
});

describe('applyFilterTransform / expression strings', () => {
  it('filters using a Vega expression string via the shared safe evaluator', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: 'datum.v > 3 && datum.v < 10' }, gaps, '$');
    expect(result).to.deep.equal([rows[1]]);
    expect(gaps.list()).to.have.length(0);
  });

  it('records an unsupported gap and keeps all rows for a NEVER-eval()-able expression', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: 'someUnknownFn(datum.v)' }, gaps, '$');
    expect(result).to.deep.equal(rows);
    const gap = gaps.list().find((entry) => entry.code === 'transform:filter-expression');
    expect(gap?.severity).to.equal('unsupported');
  });
});

describe('applyFilterTransform / coercion and edge cases', () => {
  it('equal and oneOf coerce numeric strings against numbers', () => {
    const gaps = createGapCollector();
    const data = [{ v: 5 }, { v: '5' }, { v: 6 }];
    expect(
      applyFilterTransform(data, { filter: { field: 'v', equal: '5' } }, gaps, '$'),
    ).to.deep.equal([{ v: 5 }, { v: '5' }]);
    expect(
      applyFilterTransform(data, { filter: { field: 'v', oneOf: [5] } }, gaps, '$'),
    ).to.deep.equal([{ v: 5 }, { v: '5' }]);
  });

  it('valid treats an Invalid Date as invalid', () => {
    const gaps = createGapCollector();
    const data = [{ d: new Date('nope') }, { d: new Date(2024, 0, 1) }];
    const result = applyFilterTransform(data, { filter: { field: 'd', valid: true } }, gaps, '$');
    expect(result).to.deep.equal([{ d: new Date(2024, 0, 1) }]);
  });

  it('null field values never satisfy order comparisons', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: { field: 'v', gt: 5 } }, gaps, '$');
    // rows[3] has v: null and must not pass a `gt` comparison.
    expect(result).to.deep.equal([rows[2]]);
  });

  it('`not` over an UNSUPPORTED predicate stays fail-open (keeps all rows) instead of dropping them', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: { not: { param: 'brush' } } }, gaps, '$');
    expect(result).to.deep.equal(rows);
    const gap = gaps.list().find((entry) => entry.code === 'filter:unsupported-shape');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('`not` over an unsupported expression stays fail-open too', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: { not: 'unknownFn(datum.v)' } }, gaps, '$');
    expect(result).to.deep.equal(rows);
  });
});

describe('applyFilterTransform / unsupported shapes', () => {
  it('keeps all rows and records a gap for a selection/param predicate', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: { param: 'brush' } }, gaps, '$');
    expect(result).to.deep.equal(rows);
    const gap = gaps.list().find((entry) => entry.code === 'filter:unsupported-shape');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('keeps all rows for a null/primitive filter value', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: null }, gaps, '$');
    expect(result).to.deep.equal(rows);
  });
});
