import { createGapCollector } from '../gaps';
import { applyInlineTimeUnit, applyTimeUnitTransform, resolveTimeUnit } from './timeUnit';

const d = new Date(2024, 5, 15, 13, 45, 30, 250); // June 15, 2024, 13:45:30.250 (a Saturday)

describe('resolveTimeUnit', () => {
  it('truncates year', () => {
    const gaps = createGapCollector();
    expect(resolveTimeUnit(d, 'year', gaps, '$')).to.deep.equal(new Date(2024, 0, 1));
    expect(gaps.list()).to.have.length(0);
  });

  it('truncates quarter / yearquarter', () => {
    const gaps = createGapCollector();
    expect(resolveTimeUnit(d, 'quarter', gaps, '$')).to.deep.equal(new Date(2024, 3, 1));
    expect(resolveTimeUnit(d, 'yearquarter', gaps, '$')).to.deep.equal(new Date(2024, 3, 1));
  });

  it('truncates month / yearmonth', () => {
    const gaps = createGapCollector();
    expect(resolveTimeUnit(d, 'month', gaps, '$')).to.deep.equal(new Date(2024, 5, 1));
    expect(resolveTimeUnit(d, 'yearmonth', gaps, '$')).to.deep.equal(new Date(2024, 5, 1));
  });

  it('truncates week / yearweek to the preceding Sunday', () => {
    const gaps = createGapCollector();
    // June 15 2024 is a Saturday; the preceding Sunday is June 9.
    expect(resolveTimeUnit(d, 'week', gaps, '$')).to.deep.equal(new Date(2024, 5, 9));
    expect(resolveTimeUnit(d, 'yearweek', gaps, '$')).to.deep.equal(new Date(2024, 5, 9));
  });

  it('truncates date / yearmonthdate / monthdate to midnight', () => {
    const gaps = createGapCollector();
    const expected = new Date(2024, 5, 15);
    expect(resolveTimeUnit(d, 'date', gaps, '$')).to.deep.equal(expected);
    expect(resolveTimeUnit(d, 'yearmonthdate', gaps, '$')).to.deep.equal(expected);
    expect(resolveTimeUnit(d, 'monthdate', gaps, '$')).to.deep.equal(expected);
  });

  it('truncates hours / minutes / seconds and the composites', () => {
    const gaps = createGapCollector();
    expect(resolveTimeUnit(d, 'hours', gaps, '$')).to.deep.equal(new Date(2024, 5, 15, 13));
    expect(resolveTimeUnit(d, 'minutes', gaps, '$')).to.deep.equal(new Date(2024, 5, 15, 13, 45));
    expect(resolveTimeUnit(d, 'hoursminutes', gaps, '$')).to.deep.equal(
      new Date(2024, 5, 15, 13, 45),
    );
    expect(resolveTimeUnit(d, 'seconds', gaps, '$')).to.deep.equal(
      new Date(2024, 5, 15, 13, 45, 30),
    );
    expect(resolveTimeUnit(d, 'hoursminutesseconds', gaps, '$')).to.deep.equal(
      new Date(2024, 5, 15, 13, 45, 30),
    );
  });

  it('maps `day` onto a canonical reference week and records a partial gap', () => {
    const gaps = createGapCollector();
    const saturday = resolveTimeUnit(d, 'day', gaps, '$');
    // Jan 1, 2006 is the reference Sunday; June 15 2024 is a Saturday (day 6).
    expect(saturday).to.deep.equal(new Date(2006, 0, 7));
    const gap = gaps.list().find((entry) => entry.code === 'timeUnit:day');
    expect(gap?.severity).to.equal('partial');
  });

  it('returns null and records an unsupported gap for unknown units', () => {
    const gaps = createGapCollector();
    const result = resolveTimeUnit(d, 'dayofyear', gaps, '$');
    expect(result).to.equal(null);
    const gap = gaps.list().find((entry) => entry.code === 'timeUnit:dayofyear');
    expect(gap?.severity).to.equal('unsupported');
  });
});

describe('applyTimeUnitTransform', () => {
  it('writes the truncated date to `as`', () => {
    const gaps = createGapCollector();
    const rows = [{ ts: d }];
    const result = applyTimeUnitTransform(
      rows,
      { timeUnit: 'month', field: 'ts', as: 'm' },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([{ ts: d, m: new Date(2024, 5, 1) }]);
  });

  it('parses string/number date values via toDate', () => {
    const gaps = createGapCollector();
    const rows = [{ ts: '2024-06-15T00:00:00' }];
    const result = applyTimeUnitTransform(
      rows,
      { timeUnit: 'year', field: 'ts', as: 'y' },
      gaps,
      '$',
    );
    expect((result[0] as { y: Date }).y.getFullYear()).to.equal(2024);
  });

  it('nulls `as` for rows with no parseable date', () => {
    const gaps = createGapCollector();
    const rows = [{ ts: null }];
    const result = applyTimeUnitTransform(
      rows,
      { timeUnit: 'year', field: 'ts', as: 'y' },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([{ ts: null, y: null }]);
  });
});

describe('applyInlineTimeUnit', () => {
  it('writes a synthetic field and reports the field name for the caller to rewrite the channel with', () => {
    const gaps = createGapCollector();
    const rows = [{ ts: d }];
    const result = applyInlineTimeUnit(rows, 'ts', 'month', gaps, '$');
    expect(result!.field).to.equal('__timeUnit_month_ts');
    expect(result!.rows).to.deep.equal([{ ts: d, __timeUnit_month_ts: new Date(2024, 5, 1) }]);
  });

  it('returns null (after a gap) for an unsupported unit so the caller can fall back to the raw field', () => {
    const gaps = createGapCollector();
    const result = applyInlineTimeUnit([{ ts: d }], 'ts', 'dayofyear', gaps, '$');
    expect(result).to.equal(null);
    const gap = gaps.list().find((entry) => entry.code === 'timeUnit:dayofyear');
    expect(gap?.severity).to.equal('unsupported');
  });
});

describe('applyTimeUnitTransform / unsupported units', () => {
  it('records a gap and passes rows through unchanged (no all-null `as` column)', () => {
    const gaps = createGapCollector();
    const rows = [{ ts: d }];
    const result = applyTimeUnitTransform(
      rows,
      { timeUnit: 'dayofyear', field: 'ts', as: 'doy' },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([{ ts: d }]);
    const gap = gaps.list().find((entry) => entry.code === 'timeUnit:dayofyear');
    expect(gap?.severity).to.equal('unsupported');
  });
});
