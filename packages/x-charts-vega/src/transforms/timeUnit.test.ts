import { createGapCollector } from '../gaps';
import { applyInlineTimeUnit, applyTimeUnitTransform, resolveTimeUnit } from './timeUnit';

const d = new Date(2024, 5, 15, 13, 45, 30, 250); // June 15, 2024, 13:45:30.250 (a Saturday)

describe('resolveTimeUnit', () => {
  it('truncates year', () => {
    const gaps = createGapCollector();
    expect(resolveTimeUnit(d, 'year', gaps, '$')).to.deep.equal(new Date(2024, 0, 1));
    expect(gaps.list()).to.have.length(0);
  });

  it('maps cyclic `quarter` onto the reference year but keeps the real year for `yearquarter`', () => {
    const gaps = createGapCollector();
    // Bare `quarter` is cyclic: the year drops to the 2012 reference so quarters
    // collapse across years; `yearquarter` retains the real year.
    expect(resolveTimeUnit(d, 'quarter', gaps, '$')).to.deep.equal(new Date(2012, 3, 1));
    expect(resolveTimeUnit(d, 'yearquarter', gaps, '$')).to.deep.equal(new Date(2024, 3, 1));
  });

  it('maps cyclic `month` onto the reference year but keeps the real year for `yearmonth`', () => {
    const gaps = createGapCollector();
    // Bare `month` is cyclic (every year's June collapses to 2012-June-01);
    // `yearmonth` retains the real year for a true time-series axis.
    expect(resolveTimeUnit(d, 'month', gaps, '$')).to.deep.equal(new Date(2012, 5, 1));
    expect(resolveTimeUnit(d, 'yearmonth', gaps, '$')).to.deep.equal(new Date(2024, 5, 1));
  });

  it('truncates week / yearweek to the preceding Sunday', () => {
    const gaps = createGapCollector();
    // June 15 2024 is a Saturday; the preceding Sunday is June 9.
    expect(resolveTimeUnit(d, 'week', gaps, '$')).to.deep.equal(new Date(2024, 5, 9));
    expect(resolveTimeUnit(d, 'yearweek', gaps, '$')).to.deep.equal(new Date(2024, 5, 9));
  });

  it('carries only the named components, referencing the rest, for date units', () => {
    const gaps = createGapCollector();
    // `yearmonthdate` keeps the real date; the cyclic `date`/`monthdate` drop the
    // components they don't name to the 2012-January reference.
    expect(resolveTimeUnit(d, 'yearmonthdate', gaps, '$')).to.deep.equal(new Date(2024, 5, 15));
    expect(resolveTimeUnit(d, 'date', gaps, '$')).to.deep.equal(new Date(2012, 0, 15));
    expect(resolveTimeUnit(d, 'monthdate', gaps, '$')).to.deep.equal(new Date(2012, 5, 15));
  });

  it('carries only the named time components, referencing the date, for time units', () => {
    const gaps = createGapCollector();
    // Time-of-day units are cyclic across days, so the date drops to the
    // 2012-January-01 reference and only the named clock fields are kept.
    expect(resolveTimeUnit(d, 'hours', gaps, '$')).to.deep.equal(new Date(2012, 0, 1, 13));
    expect(resolveTimeUnit(d, 'minutes', gaps, '$')).to.deep.equal(new Date(2012, 0, 1, 0, 45));
    expect(resolveTimeUnit(d, 'hoursminutes', gaps, '$')).to.deep.equal(
      new Date(2012, 0, 1, 13, 45),
    );
    expect(resolveTimeUnit(d, 'seconds', gaps, '$')).to.deep.equal(new Date(2012, 0, 1, 0, 0, 30));
    expect(resolveTimeUnit(d, 'hoursminutesseconds', gaps, '$')).to.deep.equal(
      new Date(2012, 0, 1, 13, 45, 30),
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
    const result = resolveTimeUnit(d, 'bogus-unit', gaps, '$');
    expect(result).to.equal(null);
    const gap = gaps.list().find((entry) => entry.code === 'timeUnit:bogus-unit');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('maps `dayofyear` onto the 2012 reference leap year and records a partial gap', () => {
    const gaps = createGapCollector();
    // March 1, 2024 is day 61 of the year (2024 is a leap year: 31 + 29 + 1).
    const march1 = new Date(2024, 2, 1);
    const result = resolveTimeUnit(march1, 'dayofyear', gaps, '$');
    expect(result).to.deep.equal(new Date(2012, 0, 61));
    const gap = gaps.list().find((entry) => entry.code === 'timeUnit:dayofyear');
    expect(gap?.severity).to.equal('partial');
  });

  it('maps `dayofyear` consistently for a non-leap-year date', () => {
    const gaps = createGapCollector();
    // March 1, 2023 is day 60 of the year (2023 is not a leap year: 31 + 28 + 1).
    const march1 = new Date(2023, 2, 1);
    const result = resolveTimeUnit(march1, 'dayofyear', gaps, '$');
    expect(result).to.deep.equal(new Date(2012, 0, 60));
  });

  it('truncates `utcyear`/`utcmonth`/`utchours` using UTC calendar fields', () => {
    const gaps = createGapCollector();
    // 2024-06-15T13:45:30.250Z (a UTC instant).
    const instant = new Date(Date.UTC(2024, 5, 15, 13, 45, 30, 250));
    expect(resolveTimeUnit(instant, 'utcyear', gaps, '$')).to.deep.equal(
      new Date(Date.UTC(2024, 0, 1)),
    );
    expect(resolveTimeUnit(instant, 'utcmonth', gaps, '$')).to.deep.equal(
      new Date(Date.UTC(2012, 5, 1)),
    );
    expect(resolveTimeUnit(instant, 'utchours', gaps, '$')).to.deep.equal(
      new Date(Date.UTC(2012, 0, 1, 13)),
    );
    expect(gaps.list()).to.have.length(0);
  });

  it('truncates the `utcyearmonth` composite to the UTC month start', () => {
    const gaps = createGapCollector();
    const instant = new Date(Date.UTC(2024, 5, 15, 13, 45, 30, 250));
    expect(resolveTimeUnit(instant, 'utcyearmonth', gaps, '$')).to.deep.equal(
      new Date(Date.UTC(2024, 5, 1)),
    );
  });

  it('maps `utcday` onto the reference week (UTC) and records a partial gap', () => {
    const gaps = createGapCollector();
    // 2024-06-15 is a Saturday both locally and in UTC for this instant.
    const instant = new Date(Date.UTC(2024, 5, 15, 13, 45, 30, 250));
    const result = resolveTimeUnit(instant, 'utcday', gaps, '$');
    expect(result).to.deep.equal(new Date(Date.UTC(2006, 0, 7)));
    const gap = gaps.list().find((entry) => entry.code === 'timeUnit:day');
    expect(gap?.severity).to.equal('partial');
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
    expect(result).to.deep.equal([{ ts: d, m: new Date(2012, 5, 1) }]);
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

  it('accepts `utcmonth`, truncating with UTC calendar fields', () => {
    const gaps = createGapCollector();
    const rows = [{ ts: new Date(Date.UTC(2024, 5, 15, 13, 45, 30, 250)) }];
    const result = applyTimeUnitTransform(
      rows,
      { timeUnit: 'utcmonth', field: 'ts', as: 'm' },
      gaps,
      '$',
    );
    expect((result[0] as { m: Date }).m).to.deep.equal(new Date(Date.UTC(2012, 5, 1)));
    expect(gaps.list()).to.have.length(0);
  });
});

describe('applyInlineTimeUnit', () => {
  it('writes a synthetic field and reports the field name for the caller to rewrite the channel with', () => {
    const gaps = createGapCollector();
    const rows = [{ ts: d }];
    const result = applyInlineTimeUnit(rows, 'ts', 'month', gaps, '$');
    expect(result!.field).to.equal('__timeUnit_month_ts');
    expect(result!.rows).to.deep.equal([{ ts: d, __timeUnit_month_ts: new Date(2012, 5, 1) }]);
  });

  it('returns null (after a gap) for an unsupported unit so the caller can fall back to the raw field', () => {
    const gaps = createGapCollector();
    const result = applyInlineTimeUnit([{ ts: d }], 'ts', 'bogus-unit', gaps, '$');
    expect(result).to.equal(null);
    const gap = gaps.list().find((entry) => entry.code === 'timeUnit:bogus-unit');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('accepts `utcmonth` inline, writing a UTC-truncated synthetic field', () => {
    const gaps = createGapCollector();
    const rows = [{ ts: new Date(Date.UTC(2024, 5, 15, 13, 45, 30, 250)) }];
    const result = applyInlineTimeUnit(rows, 'ts', 'utcmonth', gaps, '$');
    expect(result).not.to.equal(null);
    expect(result!.field).to.equal('__timeUnit_utcmonth_ts');
    expect((result!.rows[0] as Record<string, unknown>)[result!.field]).to.deep.equal(
      new Date(Date.UTC(2012, 5, 1)),
    );
  });
});

describe('applyTimeUnitTransform / unsupported units', () => {
  it('records a gap and passes rows through unchanged (no all-null `as` column)', () => {
    const gaps = createGapCollector();
    const rows = [{ ts: d }];
    const result = applyTimeUnitTransform(
      rows,
      { timeUnit: 'bogus-unit', field: 'ts', as: 'doy' },
      gaps,
      '$',
    );
    expect(result).to.deep.equal([{ ts: d }]);
    const gap = gaps.list().find((entry) => entry.code === 'timeUnit:bogus-unit');
    expect(gap?.severity).to.equal('unsupported');
  });
});
