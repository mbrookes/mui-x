/* eslint-disable no-underscore-dangle */
// The inline-transform synthetic column names are intentionally
// dunder-prefixed (`__bin_*`, `__timeUnit_*`, `__sum_*`) to avoid colliding
// with user data fields.
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

  it('keeps an unaggregated x2 field alongside its group (histogram_log-shaped: x/x2 bin edges + y count)', () => {
    const gaps = createGapCollector();
    const rows = [
      { x1: 1, x2: 10 },
      { x1: 1, x2: 10 },
      { x1: 10, x2: 100 },
    ];
    const result = applyEncodingTransforms(
      rows,
      {
        x: { field: 'x1', type: 'quantitative' },
        x2: { field: 'x2' },
        y: { aggregate: 'count' },
      },
      gaps,
      '$',
    );
    // Without x2 in the groupby set, the twin field would be dropped from
    // every grouped-output row (only x1 and the count would survive).
    expect(result.rows).to.deep.equal([
      { x1: 1, x2: 10, __count_records: 2 },
      { x1: 10, x2: 100, __count_records: 1 },
    ]);
  });
});

describe('applyEncodingTransforms / inline argmin-argmax', () => {
  it("object form { argmax } picks the winning row and reads back this channel's field, no gap", () => {
    const gaps = createGapCollector();
    const rows = [
      { cat: 'A', a: 'x', b: 1 },
      { cat: 'A', a: 'y', b: 5 },
      { cat: 'B', a: 'z', b: 2 },
    ];
    const result = applyEncodingTransforms(
      rows,
      {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'a', aggregate: { argmax: 'b' } },
      },
      gaps,
      '$',
    );
    // Group A: b maxes at 5 -> row a='y'; group B: single row a='z'.
    expect(result.rows).to.deep.equal([
      { cat: 'A', __argmax_b_a: 'y' },
      { cat: 'B', __argmax_b_a: 'z' },
    ]);
    expect(result.encoding.y).to.deep.include({ field: '__argmax_b_a', title: 'a' });
    expect((result.encoding.y as { aggregate?: unknown }).aggregate).to.equal(undefined);
    expect(gaps.list().find((entry) => entry.code === 'aggregate:argminmax')).to.equal(undefined);
  });

  it('string form `argmin` selects on and reads back the channel field', () => {
    const gaps = createGapCollector();
    const rows = [
      { cat: 'A', v: 3 },
      { cat: 'A', v: 1 },
      { cat: 'B', v: 5 },
    ];
    const result = applyEncodingTransforms(
      rows,
      { x: { field: 'cat', type: 'nominal' }, y: { field: 'v', aggregate: 'argmin' } },
      gaps,
      '$',
    );
    expect(result.rows).to.deep.equal([
      { cat: 'A', __argmin_v_v: 1 },
      { cat: 'B', __argmin_v_v: 5 },
    ]);
    expect(gaps.list().find((entry) => entry.code === 'aggregate:argminmax')).to.equal(undefined);
  });

  it('nulls the channel value for a group with no numeric criterion value', () => {
    const gaps = createGapCollector();
    const rows = [{ cat: 'A', a: 'x', b: 'nope' }];
    const result = applyEncodingTransforms(
      rows,
      {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'a', aggregate: { argmax: 'b' } },
      },
      gaps,
      '$',
    );
    expect(result.rows).to.deep.equal([{ cat: 'A', __argmax_b_a: null }]);
  });

  it('still drops (with a gap) an argmin/argmax that has no channel field to read back', () => {
    const gaps = createGapCollector();
    const rows = [{ cat: 'A', b: 5 }];
    const result = applyEncodingTransforms(
      rows,
      // No `field` on the y channel: nothing to read back off the winning row.
      { x: { field: 'cat', type: 'nominal' }, y: { aggregate: { argmax: 'b' } } },
      gaps,
      '$',
    );
    // The channel is dropped: it keeps its original (fieldless) def, never
    // rewritten to a synthetic argmax column.
    expect((result.encoding.y as { field?: string }).field).to.equal(undefined);
    const gap = gaps.list().find((entry) => entry.code === 'aggregate:argminmax');
    expect(gap?.severity).to.equal('unsupported');
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

  it('pre-binned data (`bin: "binned"`) builds the "start–end" label from the x2 companion, no gap', () => {
    const gaps = createGapCollector();
    const rows = [
      { bin_start: 10, bin_end: 20, c: 5 },
      { bin_start: 0, bin_end: 10, c: 2 },
    ];
    const result = applyEncodingTransforms(
      rows,
      {
        x: { field: 'bin_start', bin: 'binned' },
        x2: { field: 'bin_end' },
        y: { field: 'c', type: 'quantitative' },
      },
      gaps,
      '$',
    );
    expect(result.encoding.x).to.deep.include({ field: '__bin_bin_start', type: 'ordinal' });
    // Sorted ascending by bin start (positional x channel).
    expect(result.rows.map((row) => row.__bin_bin_start)).to.deep.equal(['0–10', '10–20']);
    // The consumed x2 companion is dropped so a bar mark doesn't read x/x2 as a
    // ranged bar instead of a band-scale histogram.
    expect(result.encoding.x2).to.equal(undefined);
    expect(gaps.list().find((entry) => entry.code === 'encoding:bin-binned')).to.equal(undefined);
  });

  it('pre-binned data falls back to the "<field>_end" field when there is no x2', () => {
    const gaps = createGapCollector();
    const rows = [{ x: 0, x_end: 10 }];
    const result = applyEncodingTransforms(rows, { x: { field: 'x', bin: 'binned' } }, gaps, '$');
    expect(result.encoding.x).to.deep.include({ field: '__bin_x', type: 'ordinal' });
    expect(result.rows.map((row) => row.__bin_x)).to.deep.equal(['0–10']);
    expect(gaps.list().find((entry) => entry.code === 'encoding:bin-binned')).to.equal(undefined);
  });

  it('keeps the `encoding:bin-binned` gap when the bin-end field cannot be found', () => {
    const gaps = createGapCollector();
    const rows = [{ x: 0 }];
    const result = applyEncodingTransforms(rows, { x: { field: 'x', bin: 'binned' } }, gaps, '$');
    // No `x_end`/x2: fall back to the raw field, gap recorded.
    expect(result.encoding.x).to.deep.include({ field: 'x' });
    const gap = gaps.list().find((entry) => entry.code === 'encoding:bin-binned');
    expect(gap?.severity).to.equal('partial');
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
      // `dayofyear` is a supported (if cyclic/approximated) unit now — use a
      // genuinely unrecognized unit to exercise the unsupported-unit fallback.
      { x: { field: 'x', timeUnit: 'bogus-unit' } },
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
        (row) => (row.__timeUnit_month_x as Date).getTime() === new Date(2012, 5, 1).getTime(),
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
      (row) => (row.__timeUnit_month_x as Date).getTime() === new Date(2012, 5, 1).getTime(),
    );
    expect(june?.__sum_v).to.equal(3);
  });
});
