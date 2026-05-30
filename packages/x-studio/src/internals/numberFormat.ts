import type { StudioDataField, StudioNumberFormat } from '../models';

// ─── Module-level formatters (hoisted to avoid re-allocation on every call) ───

const INTEGER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const COMPACT_INTEGER_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  notation: 'compact',
  compactDisplay: 'short',
});
const DECIMAL_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const COMPACT_DECIMAL_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
  notation: 'compact',
  compactDisplay: 'short',
});
const PERCENT_FORMAT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
});
const DEFAULT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const COMPACT_DEFAULT_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  notation: 'compact',
  compactDisplay: 'short',
});
const currencyFormatCache = new Map<string, Intl.NumberFormat>();

function getCurrencyFormat(currencyCode: string, compact: boolean): Intl.NumberFormat {
  const key = `${currencyCode}:${compact}`;
  let fmt = currencyFormatCache.get(key);
  if (!fmt) {
    // react-doctor-disable-next-line react-doctor/js-hoist-intl -- cached; only created once per currency+compact combination
    fmt = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: compact ? 1 : 0,
      notation: compact ? 'compact' : 'standard',
      compactDisplay: 'short',
    });
    currencyFormatCache.set(key, fmt);
  }
  return fmt;
}

export function formatNumber(
  value: number,
  format?: StudioNumberFormat,
  currencyCode?: string,
  compact?: boolean,
): string {
  switch (format) {
    case 'integer':
      return (compact ? COMPACT_INTEGER_FORMAT : INTEGER_FORMAT).format(value);
    case 'decimal':
      return (compact ? COMPACT_DECIMAL_FORMAT : DECIMAL_FORMAT).format(value);
    case 'percent':
      return PERCENT_FORMAT.format(value / 100);
    case 'currency':
      return getCurrencyFormat(currencyCode ?? 'USD', !!compact).format(value);
    default:
      return (compact ? COMPACT_DEFAULT_FORMAT : DEFAULT_FORMAT).format(value);
  }
}

export function formatFieldValue(
  value: unknown,
  field?: Pick<StudioDataField, 'type' | 'format' | 'currencyCode'>,
): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (field?.type === 'number' && typeof value === 'number') {
    return formatNumber(value, field.format, field.currencyCode);
  }
  return String(value);
}
