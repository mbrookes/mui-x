import { createValueFormatter, formatValue } from './index';

describe('createValueFormatter / formatValue', () => {
  it('formats a quantitative value with a d3 number pattern', () => {
    const fmt = createValueFormatter('.2f', 'quantitative');
    expect(fmt).to.be.a('function');
    expect(fmt!(3.14159)).to.equal('3.14');
    expect(formatValue('.2f', 3.14159, 'quantitative')).to.equal('3.14');
  });

  it('formats a temporal value with a d3 time pattern', () => {
    const date = new Date(Date.UTC(2020, 0, 15));
    expect(formatValue('%Y', date, 'temporal', 'utc')).to.equal('2020');
    // Without an explicit formatType, a temporal field defaults to local time.
    const local = createValueFormatter('%Y', 'temporal');
    expect(local!(new Date(2020, 5, 1))).to.equal('2020');
  });

  it('returns null for a nominal field without a formatType override', () => {
    expect(createValueFormatter('.2f', 'nominal')).to.equal(null);
    expect(formatValue('.2f', 'abc', 'nominal')).to.equal(null);
  });
});
