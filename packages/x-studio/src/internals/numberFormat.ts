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
const preciseNumberFormatCache = new Map<string, Intl.NumberFormat>();

function normalizePrecision(precision: number | undefined): number | undefined {
  if (precision == null || !Number.isFinite(precision)) {
    return undefined;
  }
  return Math.min(10, Math.max(0, Math.trunc(precision)));
}

function getPrecisionFormat(
  precision: number,
  options?: Pick<Intl.NumberFormatOptions, 'style' | 'currency' | 'notation' | 'compactDisplay'>,
): Intl.NumberFormat {
  const key = JSON.stringify({ precision, ...options });
  let fmt = preciseNumberFormatCache.get(key);
  if (!fmt) {
    // react-doctor-disable-next-line react-doctor/js-hoist-intl -- cached per precision/options combination
    fmt = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
      ...(options ?? {}),
    });
    preciseNumberFormatCache.set(key, fmt);
  }
  return fmt;
}

function getCurrencyFormat(
  currencyCode: string,
  compact: boolean,
  precision?: number,
): Intl.NumberFormat {
  const normalizedPrecision = normalizePrecision(precision);
  const key = `${currencyCode}:${compact}:${normalizedPrecision ?? 'default'}`;
  let fmt = currencyFormatCache.get(key);
  if (!fmt) {
    // Compact notation keeps up to 1 fraction digit (e.g. $40.5K) but must not force a
    // trailing zero onto whole values (e.g. $40, not $40.0); standard notation defaults
    // to whole currency amounts. An explicit precision pins both bounds.
    const minimumFractionDigits = normalizedPrecision ?? 0;
    const maximumFractionDigits = normalizedPrecision ?? (compact ? 1 : 0);
    // react-doctor-disable-next-line react-doctor/js-hoist-intl -- cached; only created once per currency+compact combination
    fmt = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits,
      maximumFractionDigits,
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
  precision?: number,
): string {
  const normalizedPrecision = normalizePrecision(precision);

  if (normalizedPrecision != null) {
    if (format === 'currency') {
      return getCurrencyFormat(currencyCode ?? 'USD', !!compact, normalizedPrecision).format(value);
    }
    if (format === 'percent') {
      return getPrecisionFormat(normalizedPrecision, { style: 'percent' }).format(value / 100);
    }
    const notationOptions = compact
      ? { notation: 'compact' as const, compactDisplay: 'short' as const }
      : undefined;
    return getPrecisionFormat(normalizedPrecision, notationOptions).format(value);
  }

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
  field?: Pick<StudioDataField, 'type' | 'format' | 'currencyCode' | 'precision'>,
): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (field?.type === 'number' && typeof value === 'number') {
    return formatNumber(value, field.format, field.currencyCode, undefined, field.precision);
  }
  return String(value);
}
