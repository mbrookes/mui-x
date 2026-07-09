import { describe, expect, it } from 'vitest';
import { applyXGroupBy, isEmptyXValue, toXValue } from './chartValues';
import { frLocaleText } from '../locales/fr';

describe('toXValue', () => {
  it('passes through strings and numbers unchanged', () => {
    expect(toXValue('foo')).toBe('foo');
    expect(toXValue(42)).toBe(42);
  });

  it('stringifies booleans and Dates', () => {
    expect(toXValue(true)).toBe('true');
    const d = new Date('2024-01-01T00:00:00.000Z');
    expect(toXValue(d)).toBe(d.toISOString());
  });

  it('defaults null/undefined to the English "(empty)" bucket label', () => {
    expect(toXValue(null)).toBe('(empty)');
    expect(toXValue(undefined)).toBe('(empty)');
  });

  it('routes the empty-bucket label through localeText when supplied (finding 3.2)', () => {
    // `chartEmptyCategoryLabel` no longer a hardcoded English literal — it is a
    // locale key, with a French translation available.
    expect(toXValue(null, frLocaleText)).toBe(frLocaleText.chartEmptyCategoryLabel);
    expect(toXValue(null, frLocaleText)).not.toBe('(empty)');
  });
});

describe('isEmptyXValue', () => {
  it('treats null/undefined/empty-string as empty', () => {
    expect(isEmptyXValue(null)).toBe(true);
    expect(isEmptyXValue(undefined)).toBe(true);
    expect(isEmptyXValue('')).toBe(true);
    expect(isEmptyXValue('foo')).toBe(false);
    expect(isEmptyXValue(0)).toBe(false);
  });

  it('recognizes the (already-converted) default empty bucket label', () => {
    expect(isEmptyXValue('(empty)')).toBe(true);
  });

  it('recognizes a locale-specific empty bucket label when localeText is supplied', () => {
    expect(isEmptyXValue(frLocaleText.chartEmptyCategoryLabel, frLocaleText)).toBe(true);
    // Without the matching localeText, the French label isn't recognized as empty.
    expect(isEmptyXValue(frLocaleText.chartEmptyCategoryLabel)).toBe(false);
  });
});

describe('applyXGroupBy', () => {
  it('returns the original value when xGroupBy is undefined', () => {
    expect(applyXGroupBy('2024-01-15', undefined)).toBe('2024-01-15');
  });

  it('truncates a date-like value to the given granularity', () => {
    expect(applyXGroupBy('2024-01-15', 'month')).toBe('2024-01');
  });
});
