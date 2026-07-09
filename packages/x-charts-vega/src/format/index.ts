import { format as d3NumberFormat } from '@mui/x-charts-vendor/d3-format';
import { timeFormat, utcFormat } from '@mui/x-charts-vendor/d3-time-format';
import { toDate, toNumber } from '../compile/fieldTypes';
import type { VegaFieldType } from '../types';

export type VegaFormatType = 'number' | 'time' | 'utc';

/**
 * Compiles a Vega-Lite `format` string into a value formatter. `formatType`
 * (explicit override) wins; else temporal→time, quantitative→number. Returns
 * null when untranslatable (nominal/ordinal without formatType, or an invalid
 * d3 pattern).
 * @param {string} formatString The d3 number/time format pattern.
 * @param {VegaFieldType | undefined} fieldType The channel's measurement type.
 * @param {string | undefined} formatType Explicit `'number' | 'time' | 'utc'` override.
 * @returns {((value: unknown) => string) | null} A formatter, or null when untranslatable.
 */
export function createValueFormatter(
  formatString: string,
  fieldType: VegaFieldType | undefined,
  formatType?: string,
): ((value: unknown) => string) | null {
  let kind: VegaFormatType | null = null;
  if (formatType === 'number' || formatType === 'time' || formatType === 'utc') {
    kind = formatType;
  } else if (fieldType === 'temporal') {
    kind = 'time';
  } else if (fieldType === 'quantitative') {
    kind = 'number';
  }
  if (kind === null) {
    return null;
  }
  try {
    if (kind === 'number') {
      const fmt = d3NumberFormat(formatString);
      return (value) => {
        const n = toNumber(value);
        return n === null ? String(value) : fmt(n);
      };
    }
    const fmt = (kind === 'utc' ? utcFormat : timeFormat)(formatString);
    return (value) => {
      const d = toDate(value);
      return d === null ? String(value) : fmt(d);
    };
  } catch {
    return null;
  }
}

/**
 * One-shot convenience wrapper around `createValueFormatter`.
 * @param {string} formatString The d3 number/time format pattern.
 * @param {unknown} value The value to format.
 * @param {VegaFieldType | undefined} fieldType The channel's measurement type.
 * @param {string | undefined} formatType Explicit `'number' | 'time' | 'utc'` override.
 * @returns {string | null} The formatted value, or null when untranslatable.
 */
export function formatValue(
  formatString: string,
  value: unknown,
  fieldType: VegaFieldType | undefined,
  formatType?: string,
): string | null {
  const fmt = createValueFormatter(formatString, fieldType, formatType);
  return fmt === null ? null : fmt(value);
}
