import { describe, expect, it } from 'vitest';
import { formatCrossFilterValueLabel } from './crossFilterValueLabel';

/**
 * Date bounds must be formatted through `Intl`, not dayjs: nothing in this package ever calls
 * `dayjs.locale(...)`, so `dayjs(v).format('D MMM YYYY')` always produced English month names
 * in a fixed DMY order regardless of the dashboard's locale — the exact defect
 * `StudioFilterWidget/controls/SliderControl.tsx` was already fixed for.
 *
 * The expectations below are derived through the same `Intl` options the implementation uses
 * rather than hardcoded, so they hold under whatever locale the test runner resolves.
 */
const expectBound = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

describe('formatCrossFilterValueLabel', () => {
  it('renders an empty string for a missing value', () => {
    expect(formatCrossFilterValueLabel(null)).toBe('');
    expect(formatCrossFilterValueLabel(undefined)).toBe('');
  });

  it('formats a {from, to} range through the runtime locale', () => {
    expect(formatCrossFilterValueLabel({ from: '2024-01-01', to: '2024-01-31' })).toBe(
      `${expectBound('2024-01-01')} – ${expectBound('2024-01-31')}`,
    );
  });

  it('collapses a single-day range to one date', () => {
    expect(formatCrossFilterValueLabel({ from: '2024-01-15', to: '2024-01-15' })).toBe(
      expectBound('2024-01-15'),
    );
  });

  it('pins the calendar day against the runtime time zone', () => {
    // `new Date('YYYY-MM-DD')` parses as UTC midnight, so an unpinned formatter renders the
    // PREVIOUS day in any negative-offset time zone. dayjs parsed the same string as local
    // midnight, so pinning to UTC is also what preserves the previous output.
    expect(formatCrossFilterValueLabel({ from: '2024-01-01', to: '2024-01-01' })).toContain('2024');
    expect(
      new Date('2024-01-01').toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric' }),
    ).toBe('1');
  });

  it('joins an array (shift-click multi-select) with commas', () => {
    expect(formatCrossFilterValueLabel(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('stringifies plain scalars', () => {
    expect(formatCrossFilterValueLabel('Widgets')).toBe('Widgets');
    expect(formatCrossFilterValueLabel(42)).toBe('42');
    expect(formatCrossFilterValueLabel(false)).toBe('false');
  });

  it('leaves an unparseable range bound as-is instead of rendering "Invalid Date"', () => {
    expect(formatCrossFilterValueLabel({ from: 'not-a-date', to: 'not-a-date' })).toBe(
      'not-a-date',
    );
  });
});
