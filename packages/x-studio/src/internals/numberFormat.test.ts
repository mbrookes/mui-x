import { afterEach, describe, expect, it } from 'vitest';
import {
  formatFieldValue,
  formatNumber,
  formatPercent,
  getFormatCacheSizes,
  MAX_FORMAT_CACHE_ENTRIES,
} from './numberFormat';
import { setActiveStudioLocale } from './studioLocale';

// Assertions use pattern matching rather than exact locale strings so the tests
// pass regardless of the system locale (Intl.NumberFormat(undefined, ...) follows
// the runtime locale).

// ─── formatNumber ─────────────────────────────────────────────────────────────

describe('formatNumber — integer format', () => {
  it('rounds to 0 decimal places', () => {
    // Use Intl directly for locale-independent comparison
    const expected = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(1234.7);
    expect(formatNumber(1234.7, 'integer')).toBe(expected);
  });

  it('formats a whole number', () => {
    const expected = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(1000);
    expect(formatNumber(1000, 'integer')).toBe(expected);
  });

  it('handles negative values', () => {
    expect(formatNumber(-500, 'integer')).toMatch(/-/);
  });

  it('compact: uses K/M suffix for large values', () => {
    expect(formatNumber(5_000, 'integer', undefined, true)).toMatch(/K/i);
    expect(formatNumber(2_000_000, 'integer', undefined, true)).toMatch(/M/i);
  });
});

describe('formatNumber — decimal format', () => {
  it('shows exactly 2 decimal places for a whole number', () => {
    // After the decimal separator there must be exactly two digits
    expect(formatNumber(1234, 'decimal')).toMatch(/[.,]\d{2}$/);
  });

  it('shows exactly 2 decimal places for a fractional number', () => {
    expect(formatNumber(9.1, 'decimal')).toMatch(/[.,]\d{2}$/);
  });

  it('handles negative values', () => {
    expect(formatNumber(-3.5, 'decimal')).toMatch(/-/);
  });

  it('compact: uses at most 1 decimal place', () => {
    const result = formatNumber(1_500_000, 'decimal', undefined, true);
    // Must contain M and at most one digit after the decimal separator
    expect(result).toMatch(/M/i);
  });

  it('respects custom precision for decimal values', () => {
    expect(formatNumber(1234.567, 'decimal', undefined, false, 3)).toMatch(/[.,]\d{3}$/);
  });
});

describe('formatNumber — percent format', () => {
  it('appends a percent sign', () => {
    expect(formatNumber(75, 'percent')).toContain('%');
  });

  it('treats the input as a raw percentage (75 → 75%)', () => {
    // The function divides by 100 before passing to Intl, so 75 → 75%
    expect(formatNumber(75, 'percent')).toMatch(/75/);
  });

  it('handles fractional percent values', () => {
    expect(formatNumber(33.3, 'percent')).toContain('%');
  });

  it('handles 0%', () => {
    expect(formatNumber(0, 'percent')).toContain('%');
  });
});

describe('formatNumber — currency format', () => {
  it('includes a USD symbol by default', () => {
    expect(formatNumber(1000, 'currency')).toContain('$');
  });

  it('includes a USD symbol when currencyCode is "USD"', () => {
    expect(formatNumber(1000, 'currency', 'USD')).toContain('$');
  });

  it('includes an EUR symbol when currencyCode is "EUR"', () => {
    expect(formatNumber(1000, 'currency', 'EUR')).toContain('€');
  });

  it('compact: abbreviates with K/M suffix', () => {
    expect(formatNumber(2_000_000, 'currency', 'USD', true)).toMatch(/M/i);
  });

  it('compact: does not append a trailing .0 to whole values', () => {
    // Whole value → no fractional part (e.g. "$40", not "$40.0")
    expect(formatNumber(40, 'currency', 'USD', true)).not.toMatch(/[.,]\d/);
  });

  it('compact: keeps up to 1 fraction digit for non-whole abbreviations', () => {
    // 40,500 → "$40.5K": the fractional digit is preserved
    expect(formatNumber(40_500, 'currency', 'USD', true)).toMatch(/[.,]5K/i);
  });

  it('does not throw and falls back to a valid format for an invalid ISO 4217 currency code', () => {
    // `currencyCode` is a plain, unvalidated `string` on `StudioDataField`/
    // `StudioExpressionField` — an invalid code like "NOTREAL" makes the underlying
    // `Intl.NumberFormat` constructor throw a `RangeError`. Reached unguarded (pre-fix)
    // from `FieldPreviewTooltip`, `DataSourcePreviewTooltip`, `DataSourcePreview`'s tooltip
    // AND its live `GridColDef.valueFormatter` used during `DataGridPremium` cell render.
    expect(() => formatNumber(1000, 'currency', 'NOTREAL')).not.toThrow();
    expect(formatNumber(1000, 'currency', 'NOTREAL')).toContain('$');
  });

  it('does not throw for an invalid currency code combined with compact notation/precision', () => {
    expect(() => formatNumber(2_000_000, 'currency', 'NOTREAL', true)).not.toThrow();
    expect(() => formatNumber(1234.5, 'currency', 'NOTREAL', false, 2)).not.toThrow();
  });

  it('normalizes a lowercase ISO 4217 code', () => {
    expect(formatNumber(1000, 'currency', 'eur')).toBe(formatNumber(1000, 'currency', 'EUR'));
  });

  // `currencyFormatCache` is a module-global keyed in part on the doc/AI-authored
  // `currencyCode`, so without a bound every distinct (including every invalid) code a
  // dashboard renders leaves a permanent entry behind.
  describe('currency formatter cache is bounded', () => {
    it('collapses every non-ISO-4217-shaped code onto a single USD entry', () => {
      const before = getFormatCacheSizes().currency;
      for (let i = 0; i < 200; i += 1) {
        formatNumber(1000, 'currency', `NOTREAL-${i}`);
      }
      // All 200 garbage codes share the single normalized `USD:false:default` key, so at
      // most one new entry can appear.
      expect(getFormatCacheSizes().currency - before).toBeLessThanOrEqual(1);
      expect(formatNumber(1000, 'currency', 'NOTREAL-0')).toContain('$');
    });

    it('never exceeds MAX_FORMAT_CACHE_ENTRIES even for well-formed but unusual codes', () => {
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      for (const a of letters) {
        for (const b of letters) {
          formatNumber(1000, 'currency', `Z${a}${b}`);
        }
      }
      expect(getFormatCacheSizes().currency).toBeLessThanOrEqual(MAX_FORMAT_CACHE_ENTRIES);
      // Eviction must not break correctness: a re-requested formatter is simply rebuilt.
      expect(formatNumber(1000, 'currency', 'EUR')).toContain('€');
    });

    it('bounds the precision formatter cache too', () => {
      for (let i = 0; i < 200; i += 1) {
        formatNumber(1234.5, 'decimal', undefined, i % 2 === 0, i % 11);
      }
      expect(getFormatCacheSizes().precise).toBeLessThanOrEqual(MAX_FORMAT_CACHE_ENTRIES);
    });
  });
});

describe('formatNumber — default format (no format argument)', () => {
  it('returns a non-empty string', () => {
    const result = formatNumber(42);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('compact: uses K/M suffix', () => {
    expect(formatNumber(8_000, undefined, undefined, true)).toMatch(/K/i);
  });
});

// ─── hostile `precision` ──────────────────────────────────────────────────────
//
// `precision?: number` is a plain, unvalidated field on `StudioDataField`/
// `StudioExpressionField`. `x-studio-schema` never screens it — `precision` appears in that
// package only in the two type declarations — so any value a persisted doc or a host
// `dataSources` field carries reaches `formatNumber`'s 5th parameter, and
// `new Intl.NumberFormat(l, { minimumFractionDigits: p })` throws a `RangeError` for `p`
// outside [0, 100], for `NaN` and for `Infinity`. `normalizePrecision` is what stops that
// from crashing the widget/tooltip/grid cell that rendered the field.
//
// These tests exist because the guard was UNPINNED: replacing its whole body with
// `return precision;` left the entire x-studio suite green, so nothing distinguished a
// clamped precision from an unclamped one. They also discriminate its two call sites —
// see the "applied TWICE, deliberately" note on `normalizePrecision`.

describe('formatNumber — a hostile persisted `precision` cannot crash a render', () => {
  // Every one of these throws out of `Intl.NumberFormat` when passed through unclamped
  // (measured on Node 22): out of range in both directions, non-finite, and a value large
  // enough that the argument is not an integer at all.
  const hostile: Array<[string, number]> = [
    ['1e9', 1e9],
    ['-1', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['101', 101],
    ['1e21', 1e21],
  ];

  it.each(hostile)(
    'clamps a hostile persisted `precision` (%s) on the plain/decimal path',
    (_label, precision) => {
      // Reaches `getPrecisionFormat`, which does NOT normalize — so this path observes only
      // `formatNumber`'s own call.
      expect(() => formatNumber(1234.5, 'decimal', undefined, false, precision)).not.toThrow();
    },
  );

  it.each(hostile)(
    'clamps a hostile persisted `precision` (%s) on the percent path',
    (_label, precision) => {
      expect(() => formatNumber(42, 'percent', undefined, false, precision)).not.toThrow();
    },
  );

  it.each(hostile)(
    'clamps a hostile persisted `precision` (%s) on the currency path',
    (_label, precision) => {
      // The one path covered by BOTH calls: `formatNumber`'s and `getCurrencyFormat`'s. It
      // stays green when either single call is removed and fails when the guard body is
      // neutered, which is what identifies it as the overlap.
      expect(() => formatNumber(42, 'currency', 'EUR', false, precision)).not.toThrow();
    },
  );

  it('clamps an over-range precision to 10 fraction digits rather than honouring it', () => {
    // Not merely "does not throw": the clamp is the documented upper bound, so assert the
    // output is the 10-digit one. A guard that swallowed the value into `undefined` would
    // pass the no-throw tests above and fail this.
    expect(formatNumber(1.5, 'decimal', undefined, false, 1e9)).toBe(
      new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 10,
        maximumFractionDigits: 10,
      }).format(1.5),
    );
  });

  it('routes a hostile `precision` from a field descriptor through the same clamp', () => {
    // `formatFieldValue` is the call shape the widgets actually use, with the field read
    // straight off the doc.
    expect(() =>
      formatFieldValue(12.3456, { type: 'number', format: 'decimal', precision: 1e9 }),
    ).not.toThrow();
    expect(() =>
      formatFieldValue(12.3456, {
        type: 'number',
        format: 'currency',
        currencyCode: 'EUR',
        precision: -1,
      }),
    ).not.toThrow();
  });
});

// ─── formatFieldValue ─────────────────────────────────────────────────────────

describe('formatFieldValue', () => {
  it('returns empty string for null', () => {
    expect(formatFieldValue(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatFieldValue(undefined)).toBe('');
  });

  it('formats a number field using the field format', () => {
    const result = formatFieldValue(75, { type: 'number', format: 'percent' });
    expect(result).toContain('%');
  });

  it('passes currencyCode to formatNumber', () => {
    const result = formatFieldValue(500, {
      type: 'number',
      format: 'currency',
      currencyCode: 'EUR',
    });
    expect(result).toContain('€');
  });

  it('applies precision from the field descriptor', () => {
    const result = formatFieldValue(12.3456, {
      type: 'number',
      format: 'decimal',
      precision: 3,
    });
    expect(result).toMatch(/[.,]\d{3}$/);
  });

  it('uses default number formatting when field has no format property', () => {
    const result = formatFieldValue(42, { type: 'number' });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns String(value) for string type', () => {
    expect(formatFieldValue('hello', { type: 'string' })).toBe('hello');
  });

  it('returns String(value) for boolean type', () => {
    expect(formatFieldValue(true, { type: 'boolean' })).toBe('true');
  });

  it('returns String(value) for date type', () => {
    expect(formatFieldValue('2024-01-15', { type: 'date' })).toBe('2024-01-15');
  });

  it('returns String(value) when no field descriptor is provided', () => {
    expect(formatFieldValue('raw-value')).toBe('raw-value');
  });

  it('does not format a number without a field descriptor', () => {
    // Without field info, falls back to String()
    expect(formatFieldValue(123)).toBe('123');
  });
});

// ─── `<Studio locale={…} />` ─────────────────────────────────────────────────
//
// Every formatter in this module used to pass `undefined` as its locale argument, and the
// seven preset formatters were module-level `const`s built once at import time — so a
// dashboard rendered with `localeText={frLocaleText}` printed French labels next to
// `1,234.5`. `getStudioLocale()` (published by `StudioProvider` from the `locale` prop) now
// feeds all of them.

describe('formatNumber — honours the active Studio locale', () => {
  afterEach(() => {
    setActiveStudioLocale(undefined);
  });

  it('formats the preset (non-precision) paths against the active locale', () => {
    setActiveStudioLocale('de-DE');
    // German groups with '.' and decimalises with ','.
    expect(formatNumber(1234567, 'integer')).toBe('1.234.567');
    expect(formatNumber(1234.5, 'decimal')).toBe('1.234,50');
    expect(formatNumber(1234.567)).toBe('1.234,57');

    setActiveStudioLocale('en-US');
    expect(formatNumber(1234567, 'integer')).toBe('1,234,567');
    expect(formatNumber(1234.5, 'decimal')).toBe('1,234.50');
    expect(formatNumber(1234.567)).toBe('1,234.57');
  });

  it('formats the precision path against the active locale', () => {
    setActiveStudioLocale('de-DE');
    expect(formatNumber(1234.5, undefined, undefined, false, 2)).toBe('1.234,50');
    setActiveStudioLocale('en-US');
    expect(formatNumber(1234.5, undefined, undefined, false, 2)).toBe('1,234.50');
  });

  it('formats currency against the active locale', () => {
    setActiveStudioLocale('de-DE');
    const de = formatNumber(1234, 'currency', 'EUR');
    setActiveStudioLocale('en-US');
    const en = formatNumber(1234, 'currency', 'EUR');
    // Same amount, same currency — different locales must not produce the same string
    // (German puts the symbol last and groups with '.').
    expect(de).not.toBe(en);
    expect(de).toMatch(/1\.234/);
    expect(en).toMatch(/1,234/);
  });

  it('formats percent against the active locale', () => {
    setActiveStudioLocale('de-DE');
    expect(formatPercent(42.5)).toMatch(/42,5/);
    setActiveStudioLocale('en-US');
    expect(formatPercent(42.5)).toMatch(/42\.5/);
  });

  it('keeps the preset cache bounded across locales', () => {
    for (let i = 0; i < MAX_FORMAT_CACHE_ENTRIES * 2; i += 1) {
      setActiveStudioLocale(`de-DE-u-nu-latn-x-p${i}`);
      formatNumber(1, 'integer');
    }
    expect(getFormatCacheSizes().preset).toBeLessThanOrEqual(MAX_FORMAT_CACHE_ENTRIES);
  });
});
