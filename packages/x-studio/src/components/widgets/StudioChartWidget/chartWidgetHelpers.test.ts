import { describe, expect, it } from 'vitest';
import {
  crossFilterValueEquals,
  makeValueFormatter,
  normalizeCrossFilterValue,
} from './chartWidgetHelpers';

// ─── crossFilterValueEquals ───────────────────────────────────────────────────
//
// Regression coverage for the three-way divergence documented in the architecture
// review (finding #5): chart widgets used loose `==`, grid widgets used
// `String(a) === String(b)`, and neither agreed with the other on real inputs.
// `crossFilterValueEquals` is the single implementation both should use.

describe('crossFilterValueEquals', () => {
  it('treats identical numbers as equal', () => {
    expect(crossFilterValueEquals(5, 5)).toBe(true);
  });

  it('treats identical strings as equal', () => {
    expect(crossFilterValueEquals('DHL', 'DHL')).toBe(true);
  });

  it('treats a number and its string representation as equal', () => {
    // Cross-filter values may arrive as either type depending on whether they came
    // from a click handler (native type) or a stored filter (often stringified).
    expect(crossFilterValueEquals(5, '5')).toBe(true);
  });

  it('does NOT treat 0 and empty string as equal (loose `==` bug)', () => {
    // `0 == ''` is `true` in JS — the chart widget's old `looseEq` helper got this
    // wrong. An empty-string category value and a numeric 0 must stay distinct.
    expect(crossFilterValueEquals(0, '')).toBe(false);
    expect(crossFilterValueEquals('', 0)).toBe(false);
  });

  it('treats null and undefined as equal', () => {
    // Both normalize to `null` — matches the loose-`==` intent without loose `==`'s
    // other footguns (0/''), and fixes the grid's `String(a) === String(b)`, where
    // `String(null) === 'null'` and `String(undefined) === 'undefined'` disagree.
    expect(crossFilterValueEquals(null, undefined)).toBe(true);
    expect(crossFilterValueEquals(undefined, null)).toBe(true);
    expect(crossFilterValueEquals(null, null)).toBe(true);
    expect(crossFilterValueEquals(undefined, undefined)).toBe(true);
  });

  it('does not treat null/undefined as equal to 0 or empty string', () => {
    expect(crossFilterValueEquals(null, 0)).toBe(false);
    expect(crossFilterValueEquals(undefined, '')).toBe(false);
  });

  it('treats equal Date instances as equal', () => {
    const a = new Date('2024-01-01T00:00:00.000Z');
    const b = new Date('2024-01-01T00:00:00.000Z');
    expect(crossFilterValueEquals(a, b)).toBe(true);
  });

  it('treats a Date and its matching ISO string as equal', () => {
    const date = new Date('2024-06-15T12:00:00.000Z');
    expect(crossFilterValueEquals(date, date.toISOString())).toBe(true);
  });

  it('treats different Date instances as not equal', () => {
    const a = new Date('2024-01-01T00:00:00.000Z');
    const b = new Date('2024-01-02T00:00:00.000Z');
    expect(crossFilterValueEquals(a, b)).toBe(false);
  });

  it('treats different strings as not equal', () => {
    expect(crossFilterValueEquals('DHL', 'FedEx')).toBe(false);
  });
});

describe('normalizeCrossFilterValue', () => {
  it('normalizes null and undefined to null', () => {
    expect(normalizeCrossFilterValue(null)).toBe(null);
    expect(normalizeCrossFilterValue(undefined)).toBe(null);
  });

  it('normalizes a Date to its ISO string', () => {
    const date = new Date('2024-03-01T00:00:00.000Z');
    expect(normalizeCrossFilterValue(date)).toBe(date.toISOString());
  });

  it('normalizes numbers and strings via String()', () => {
    expect(normalizeCrossFilterValue(0)).toBe('0');
    expect(normalizeCrossFilterValue('')).toBe('');
    expect(normalizeCrossFilterValue(42)).toBe('42');
  });
});

// ─── makeValueFormatter ───────────────────────────────────────────────────────

describe('makeValueFormatter', () => {
  it('falls back to String(value) when there is no format/precision (default)', () => {
    const formatter = makeValueFormatter();
    expect(formatter(1234)).toBe('1234');
    expect(formatter(null)).toBe('');
  });

  it('returns undefined when there is no format/precision and noFormatFallback is "undefined"', () => {
    // This is the behavior `lineSeries.ts`'s private copy used to implement on its
    // own (finding #8) — now available as an explicit opt-in on the shared function.
    const formatter = makeValueFormatter(undefined, undefined, undefined, {
      noFormatFallback: 'undefined',
    });
    expect(formatter).toBeUndefined();
  });

  it('formats using the given format/precision regardless of noFormatFallback', () => {
    const formatter = makeValueFormatter('integer', undefined, undefined, {
      noFormatFallback: 'undefined',
    });
    expect(formatter).toBeTypeOf('function');
    expect(formatter?.(null)).toBe('');
  });

  it('defaults to compact notation (historical chart-widget behavior)', () => {
    const formatter = makeValueFormatter('integer');
    expect(formatter(1_500_000)).toMatch(/M/);
  });

  it('honors compact: false (used by lineSeries.ts)', () => {
    const formatter = makeValueFormatter('integer', undefined, undefined, {
      compact: false,
      noFormatFallback: 'undefined',
    });
    expect(formatter?.(1_500_000)).not.toMatch(/M/);
  });
});
