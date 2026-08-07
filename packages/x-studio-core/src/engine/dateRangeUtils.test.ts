import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeDateRangePreset } from './dateRangeUtils';

describe('computeDateRangePreset', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('month-end rollover (finding T3.2)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('last_3_months clamps the day-of-month instead of rolling "Feb 31" into March', () => {
      // May 31 minus 3 months is February, which has no 31st. The naive
      // `Date.setMonth(month - 3)` rolls the overflow into March 3 (2025 is non-leap), starting
      // the window up to 3 days late; dayjs clamps to Feb 28.
      vi.setSystemTime(new Date(2025, 4, 31, 12, 0, 0)); // 2025-05-31 (local)
      const { from, to } = computeDateRangePreset('last_3_months');
      expect(from).toBe('2025-02-28');
      expect(to).toBe('2025-05-31');
    });

    it('last_12_months clamps Feb 29 to Feb 28 instead of rolling into March', () => {
      // A leap-day "now" (2024-02-29) minus a year has no Feb 29 in 2023; `setFullYear` would
      // roll it to March 1. dayjs clamps to Feb 28.
      vi.setSystemTime(new Date(2024, 1, 29, 12, 0, 0)); // 2024-02-29 (local)
      const { from, to } = computeDateRangePreset('last_12_months');
      expect(from).toBe('2023-02-28');
      expect(to).toBe('2024-02-29');
    });

    it('last_3_months is unaffected on a day that exists in the target month', () => {
      vi.setSystemTime(new Date(2025, 5, 15, 12, 0, 0)); // 2025-06-15 (local)
      const { from } = computeDateRangePreset('last_3_months');
      expect(from).toBe('2025-03-15');
    });
  });
});
