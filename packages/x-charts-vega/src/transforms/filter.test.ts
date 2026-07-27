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
    // The param is undeclared here (no `selections`), so it stays UNKNOWN.
    const gap = gaps.list().find((entry) => entry.code === 'filter:unknown-param');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('`not` over an unsupported expression stays fail-open too', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: { not: 'unknownFn(datum.v)' } }, gaps, '$');
    expect(result).to.deep.equal(rows);
  });
});

describe('applyFilterTransform / param selection predicates', () => {
  const yearRows = [
    { year: 1955, v: 1 },
    { year: 1960, v: 2 },
    { year: 1955, v: 3 },
  ];

  it('resolves a point selection seeded with an initial value', () => {
    // `interactive_global_development` opens on 1955, not on every year at once.
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      yearRows,
      { filter: { param: 'year' } },
      gaps,
      '$',
      undefined,
      { year: { point: true, initial: [{ year: 1955 }] } },
    );
    expect(result).to.deep.equal([yearRows[0], yearRows[2]]);
    expect(gaps.list()).to.have.length(0);
  });

  it('drops every row for an empty selection with `empty: false`', () => {
    // `airport_connections` draws NO flight paths until an airport is hovered;
    // failing open here rendered every route at once.
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      yearRows,
      { filter: { param: 'org', empty: false } },
      gaps,
      '$',
      undefined,
      { org: { point: true } },
    );
    expect(result).to.deep.equal([]);
    expect(gaps.list()).to.have.length(0);
  });

  it('keeps every row for an empty selection with the default `empty`', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      yearRows,
      { filter: { param: 'org' } },
      gaps,
      '$',
      undefined,
      { org: { point: true } },
    );
    expect(result).to.deep.equal(yearRows);
    expect(gaps.list()).to.have.length(0);
  });

  it('inverts a resolved selection through `not`', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      yearRows,
      { filter: { not: { param: 'year' } } },
      gaps,
      '$',
      undefined,
      { year: { point: true, initial: [{ year: 1955 }] } },
    );
    expect(result).to.deep.equal([yearRows[1]]);
  });

  it('composes resolved selections through and/or', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      yearRows,
      {
        filter: {
          and: [{ param: 'year' }, { or: [{ param: 'clicked', empty: false }] }],
        },
      },
      gaps,
      '$',
      undefined,
      { year: { point: true, initial: [{ year: 1955 }] }, clicked: { point: true } },
    );
    // `clicked` starts empty with empty:false, so the whole conjunction is false.
    expect(result).to.deep.equal([]);
  });

  it('leaves an interval selection unresolved (fails open) with a partial gap', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(
      yearRows,
      { filter: { param: 'brush' } },
      gaps,
      '$',
      undefined,
      { brush: { point: false } },
    );
    expect(result).to.deep.equal(yearRows);
    const gap = gaps.list().find((entry) => entry.code === 'filter:interval-selection');
    expect(gap?.severity).to.equal('partial');
  });
});

describe('applyFilterTransform / unsupported shapes', () => {
  it('keeps all rows and records a gap for a selection/param predicate', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: { param: 'brush' } }, gaps, '$');
    expect(result).to.deep.equal(rows);
    const gap = gaps.list().find((entry) => entry.code === 'filter:unknown-param');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('keeps all rows for a null/primitive filter value', () => {
    const gaps = createGapCollector();
    const result = applyFilterTransform(rows, { filter: null }, gaps, '$');
    expect(result).to.deep.equal(rows);
  });
});
