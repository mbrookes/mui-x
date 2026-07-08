import { createGapCollector } from '../gaps';
import { applyEncodingTransforms } from './encoding';

describe('applyEncodingTransforms / inline aggregate (baseline, still green)', () => {
  it('groups rows and folds an aggregate channel into a synthetic field', () => {
    const gaps = createGapCollector();
    const rows = [
      { cat: 'A', v: 1 },
      { cat: 'A', v: 3 },
      { cat: 'B', v: 5 },
    ];
    const result = applyEncodingTransforms(
      rows,
      { x: { field: 'cat', type: 'nominal' }, y: { field: 'v', aggregate: 'sum' } },
      gaps,
      '$',
    );
    expect(result.rows).to.deep.equal([
      { cat: 'A', __sum_v: 4 },
      { cat: 'B', __sum_v: 5 },
    ]);
    expect(result.encoding.y).to.deep.include({ field: '__sum_v', type: 'quantitative' });
  });
});

describe('applyEncodingTransforms / inline bin', () => {
  it('rewrites the x channel to an ordinal synthetic bin-label field', () => {
    const gaps = createGapCollector();
    const rows = [{ x: 3 }, { x: 15 }, { x: 27 }];
    const result = applyEncodingTransforms(
      rows,
      { x: { field: 'x', bin: { step: 10 } } },
      gaps,
      '$',
    );
    expect(result.encoding.x).to.deep.include({ field: '__bin_x', type: 'ordinal' });
    expect((result.encoding.x as { bin?: unknown }).bin).to.equal(undefined);
    expect(result.rows.map((row) => row.__bin_x)).to.deep.equal(['0–10', '10–20', '20–30']);
  });

  it('combines with an aggregate channel to produce a histogram (count per bin)', () => {
    const gaps = createGapCollector();
    const rows = [{ x: 1 }, { x: 2 }, { x: 12 }, { x: 13 }, { x: 14 }];
    const result = applyEncodingTransforms(
      rows,
      { x: { field: 'x', bin: { step: 10 } }, y: { aggregate: 'count' } },
      gaps,
      '$',
    );
    // Two bins: "0–10" (2 rows) and "10–20" (3 rows), in ascending order.
    expect(result.rows).to.deep.equal([
      { __bin_x: '0–10', __count_records: 2 },
      { __bin_x: '10–20', __count_records: 3 },
    ]);
  });

  it('falls back to the original field (no rewrite) when binning cannot be computed', () => {
    const gaps = createGapCollector();
    const rows = [{ x: 'not-a-number' }];
    const result = applyEncodingTransforms(rows, { x: { field: 'x', bin: true } }, gaps, '$');
    expect(result.encoding.x).to.deep.include({ field: 'x' });
    const gap = gaps.list().find((entry) => entry.code === 'encoding:bin');
    expect(gap?.severity).to.equal('partial');
  });
});

describe('applyEncodingTransforms / inline transform fallbacks', () => {
  it('strips the bin marker when binning fails so type inference sees the raw field', () => {
    const gaps = createGapCollector();
    const rows = [{ x: 'not-a-number' }];
    const result = applyEncodingTransforms(rows, { x: { field: 'x', bin: true } }, gaps, '$');
    expect((result.encoding.x as { bin?: unknown }).bin).to.equal(undefined);
    expect(result.encoding.x).to.deep.include({ field: 'x' });
  });

  it('falls back to the raw date field for an unsupported timeUnit', () => {
    const gaps = createGapCollector();
    const rows = [{ x: new Date(2024, 0, 1) }];
    const result = applyEncodingTransforms(
      rows,
      { x: { field: 'x', timeUnit: 'dayofyear' } },
      gaps,
      '$',
    );
    expect(result.encoding.x).to.deep.include({ field: 'x' });
    expect((result.encoding.x as { timeUnit?: unknown }).timeUnit).to.equal(undefined);
    expect(result.rows).to.deep.equal(rows);
  });

  it('records an ignored gap for bin/timeUnit without a field', () => {
    const gaps = createGapCollector();
    applyEncodingTransforms([{ x: 1 }], { x: { bin: true } }, gaps, '$');
    const gap = gaps.list().find((entry) => entry.code === 'encoding:bin-no-field');
    expect(gap?.severity).to.equal('ignored');
  });

  it('does not re-sort rows when binning the color channel', () => {
    const gaps = createGapCollector();
    const rows = [
      { t: 3, v: 25 },
      { t: 1, v: 3 },
      { t: 2, v: 15 },
    ];
    const result = applyEncodingTransforms(
      rows,
      {
        x: { field: 't', type: 'quantitative' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'v', bin: { step: 10 } },
      },
      gaps,
      '$',
    );
    // Positional row order must be preserved; only the synthetic label is added.
    expect(result.rows.map((row) => row.t)).to.deep.equal([3, 1, 2]);
    expect(result.rows.map((row) => row.__bin_v)).to.deep.equal(['20–30', '0–10', '10–20']);
  });

  it('titles the timeUnit axis with the original field name, not the synthetic column', () => {
    const gaps = createGapCollector();
    const rows = [{ x: new Date(2024, 5, 15) }];
    const result = applyEncodingTransforms(
      rows,
      { x: { field: 'x', timeUnit: 'month' } },
      gaps,
      '$',
    );
    expect((result.encoding.x as { title?: string }).title).to.equal('x');
  });
});

describe('applyEncodingTransforms / inline timeUnit', () => {
  it('rewrites the x channel to a temporal synthetic truncated-date field', () => {
    const gaps = createGapCollector();
    const rows = [{ x: new Date(2024, 5, 15) }, { x: new Date(2024, 5, 20) }];
    const result = applyEncodingTransforms(
      rows,
      { x: { field: 'x', timeUnit: 'month' } },
      gaps,
      '$',
    );
    expect(result.encoding.x).to.deep.include({ field: '__timeUnit_month_x', type: 'temporal' });
    expect((result.encoding.x as { timeUnit?: unknown }).timeUnit).to.equal(undefined);
    expect(
      result.rows.every(
        (row) => (row.__timeUnit_month_x as Date).getTime() === new Date(2024, 5, 1).getTime(),
      ),
    ).to.equal(true);
  });

  it('combines timeUnit with an aggregate channel to bucket by month', () => {
    const gaps = createGapCollector();
    const rows = [
      { x: new Date(2024, 5, 1), v: 1 },
      { x: new Date(2024, 5, 20), v: 2 },
      { x: new Date(2024, 6, 1), v: 3 },
    ];
    const result = applyEncodingTransforms(
      rows,
      { x: { field: 'x', timeUnit: 'month' }, y: { field: 'v', aggregate: 'sum' } },
      gaps,
      '$',
    );
    expect(result.rows).to.have.length(2);
    const june = result.rows.find(
      (row) => (row.__timeUnit_month_x as Date).getTime() === new Date(2024, 5, 1).getTime(),
    );
    expect(june?.__sum_v).to.equal(3);
  });
});
