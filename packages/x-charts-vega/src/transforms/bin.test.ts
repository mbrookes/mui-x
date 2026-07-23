/* eslint-disable no-underscore-dangle */
// The inline-bin synthetic column names are intentionally dunder-prefixed
// (`__bin_<field>`) to avoid colliding with user data fields.
import { createGapCollector } from '../gaps';
import { applyBinTransform, applyInlineBin, binOf, computeNiceBinning } from './bin';

describe('computeNiceBinning', () => {
  it('computes a nice step/start/stop honoring the default maxbins (10)', () => {
    const binning = computeNiceBinning([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100], undefined);
    expect(binning).to.not.equal(null);
    expect(binning!.step).to.be.greaterThan(0);
    expect(binning!.start).to.be.at.most(0);
    expect(binning!.stop).to.be.at.least(100);
  });

  it('honors an explicit maxbins', () => {
    const binning = computeNiceBinning([0, 100], { maxbins: 5 });
    // span 100 / 5 = 20 -> nice step should be 20.
    expect(binning).to.deep.equal({ start: 0, step: 20, stop: 100 });
  });

  it('honors an explicit step', () => {
    const binning = computeNiceBinning([0, 47], { step: 10 });
    expect(binning).to.deep.equal({ start: 0, step: 10, stop: 50 });
  });

  it('honors an explicit extent override', () => {
    const binning = computeNiceBinning([5, 6, 7], { extent: [0, 100], maxbins: 10 });
    expect(binning!.start).to.equal(0);
    expect(binning!.stop).to.equal(100);
  });

  it('returns null when there are no numeric values and no extent', () => {
    expect(computeNiceBinning([], undefined)).to.equal(null);
  });

  it('handles a degenerate single-value extent', () => {
    const binning = computeNiceBinning([5, 5], undefined);
    expect(binning).to.not.equal(null);
    expect(binning!.start).to.be.lessThan(5);
    expect(binning!.stop).to.be.greaterThan(5);
  });
});

describe('binOf', () => {
  it('places a value into the correct bin', () => {
    const binning = { start: 0, step: 10, stop: 50 };
    expect(binOf(3, binning)).to.deep.equal({ start: 0, end: 10, index: 0 });
    expect(binOf(15, binning)).to.deep.equal({ start: 10, end: 20, index: 1 });
    expect(binOf(49, binning)).to.deep.equal({ start: 40, end: 50, index: 4 });
  });

  it('clamps the upper edge value into the last bin (inclusive upper bound)', () => {
    const binning = { start: 0, step: 10, stop: 50 };
    expect(binOf(50, binning)).to.deep.equal({ start: 40, end: 50, index: 4 });
  });

  it('clamps values below start into the first bin (derived extent only)', () => {
    const binning = { start: 0, step: 10, stop: 50 };
    expect(binOf(-5, binning)).to.deep.equal({ start: 0, end: 10, index: 0 });
  });

  it('excludes values outside an EXPLICIT extent instead of clamping', () => {
    const binning = { start: 0, step: 10, stop: 50, extent: [0, 50] as [number, number] };
    expect(binOf(-5, binning)).to.equal(null);
    expect(binOf(55, binning)).to.equal(null);
    expect(binOf(25, binning)).to.deep.equal({ start: 20, end: 30, index: 2 });
  });

  it('normalizes a reversed explicit extent to ascending order', () => {
    const binning = computeNiceBinning([], { extent: [100, 0], maxbins: 10 });
    expect(binning!.start).to.equal(0);
    expect(binning!.stop).to.equal(100);
    expect(binning!.extent).to.deep.equal([0, 100]);
  });

  it('nulls the bin columns for rows outside an explicit extent (top-level transform)', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 5 }, { v: 500 }];
    const result = applyBinTransform(
      rows,
      { bin: { extent: [0, 100], step: 10 }, field: 'v', as: 'b' },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([
      { v: 5, b: 0, b_end: 10 },
      { v: 500, b: null, b_end: null },
    ]);
  });
});

describe('applyBinTransform (top-level)', () => {
  it('writes bin start/end to the `as` column and its `_end` sibling for a plain string `as`', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 3 }, { v: 15 }, { v: 49 }];
    const result = applyBinTransform(
      rows,
      { bin: { step: 10 }, field: 'v', as: 'bin_v' },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([
      { v: 3, bin_v: 0, bin_v_end: 10 },
      { v: 15, bin_v: 10, bin_v_end: 20 },
      { v: 49, bin_v: 40, bin_v_end: 50 },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('writes bin start/end to a [start, end] tuple `as`', () => {
    const gaps = createGapCollector();
    // Two rows so the extent isn't degenerate (a single value bins around
    // itself, which is exercised separately by computeNiceBinning's tests).
    const rows = [{ v: 3 }, { v: 8 }];
    const result = applyBinTransform(
      rows,
      { bin: { step: 10 }, field: 'v', as: ['lo', 'hi'] },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([
      { v: 3, lo: 0, hi: 10 },
      { v: 8, lo: 0, hi: 10 },
    ]);
  });

  it('nulls out bin columns and passes non-numeric rows through unbinned when no numeric values exist', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 'nope' }];
    const result = applyBinTransform(rows, { bin: true, field: 'v', as: 'b' }, gaps, '$');
    expect(result).to.deep.equal(rows);
    const gap = gaps.list().find((entry) => entry.code === 'transform:bin');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('nulls out the bin columns for individual rows missing the field', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 3 }, { v: null }];
    const result = applyBinTransform(rows, { bin: { step: 10 }, field: 'v', as: 'b' }, gaps, '$');
    expect(result[1]).to.deep.equal({ v: null, b: null, b_end: null });
  });
});

describe('applyInlineBin', () => {
  it('folds values into an ordinal "start–end" label field, sorted ascending when sortRows is true', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 25 }, { v: 3 }, { v: 15 }];
    const result = applyInlineBin(rows, 'v', { step: 10 }, gaps, '$', true);
    expect(result).to.not.equal(null);
    expect(result!.field).to.equal('__bin_v');
    expect(result!.rows.map((row) => row.__bin_v)).to.deep.equal(['0–10', '10–20', '20–30']);
  });

  it('preserves the original row order when sortRows is false (color channel)', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 25 }, { v: 3 }, { v: 15 }];
    const result = applyInlineBin(rows, 'v', { step: 10 }, gaps, '$', false);
    expect(result!.rows.map((row) => row.v)).to.deep.equal([25, 3, 15]);
    expect(result!.rows.map((row) => row.__bin_v)).to.deep.equal(['20–30', '0–10', '10–20']);
  });

  it('records a partial gap and returns null for `bin: "binned"` when no bin-end field is found', () => {
    const gaps = createGapCollector();
    const result = applyInlineBin([{ v: 1 }], 'v', 'binned', gaps, '$', true);
    expect(result).to.equal(null);
    const gap = gaps.list().find((entry) => entry.code === 'encoding:bin-binned');
    expect(gap?.severity).to.equal('partial');
  });

  it('`bin: "binned"` builds "start–end" labels from the "<field>_end" companion, no gap', () => {
    const gaps = createGapCollector();
    const rows = [
      { v: 10, v_end: 20 },
      { v: 0, v_end: 10 },
    ];
    const result = applyInlineBin(rows, 'v', 'binned', gaps, '$', true);
    expect(result).to.not.equal(null);
    expect(result!.field).to.equal('__bin_v');
    // Sorted ascending by bin start.
    expect(result!.rows.map((row) => row.__bin_v)).to.deep.equal(['0–10', '10–20']);
    expect(gaps.list()).to.have.length(0);
  });

  it('`bin: "binned"` reads the bin end from an explicit `endField` (channel x2)', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 0, hi: 10 }];
    const result = applyInlineBin(rows, 'v', 'binned', gaps, '$', true, 'hi');
    expect(result!.rows.map((row) => row.__bin_v)).to.deep.equal(['0–10']);
    expect(gaps.list()).to.have.length(0);
  });

  it('`bin: {binned: true, ...}` (the object-form equivalent of "binned") is treated the same way', () => {
    // bar_binned_data's shape: `{binned: true, step: 2}` pairs the pre-binned
    // indicator with an axis-tick step — a strict `=== 'binned'` string check
    // missed this, silently falling through to fresh auto-binning of the
    // already-binned bin-start values instead.
    const gaps = createGapCollector();
    const rows = [
      { v: 10, v_end: 20 },
      { v: 0, v_end: 10 },
    ];
    const result = applyInlineBin(rows, 'v', { binned: true, step: 2 }, gaps, '$', true);
    expect(result).to.not.equal(null);
    expect(result!.field).to.equal('__bin_v');
    expect(result!.rows.map((row) => row.__bin_v)).to.deep.equal(['0–10', '10–20']);
    expect(gaps.list()).to.have.length(0);
  });

  it('`bin: "binned"` nulls the label for rows with a non-numeric start or end', () => {
    const gaps = createGapCollector();
    const rows = [{ v: 0, v_end: 'x' }];
    const result = applyInlineBin(rows, 'v', 'binned', gaps, '$', false);
    expect(result!.rows.map((row) => row.__bin_v)).to.deep.equal([null]);
  });

  it('records a partial gap and returns null when there are no numeric values', () => {
    const gaps = createGapCollector();
    const result = applyInlineBin([{ v: 'x' }], 'v', true, gaps, '$', true);
    expect(result).to.equal(null);
    const gap = gaps.list().find((entry) => entry.code === 'encoding:bin');
    expect(gap?.severity).to.equal('partial');
  });
});
