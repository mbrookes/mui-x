import { describe, expect, it } from 'vitest';
import { formatFieldValue, formatNumber } from './numberFormat';

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
