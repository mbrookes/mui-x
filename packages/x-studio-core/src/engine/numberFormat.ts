import type { StudioDataField, StudioNumberFormat } from '../models';
import { getStudioLocale } from './studioLocale';

// ─── Preset formatters (memoized to avoid re-allocation on every call) ───
//
// These used to be seven module-level `const`s built once at import time with an
// `undefined` locale — i.e. pinned to the browser locale before `<Studio locale={…} />`
// could possibly have been read. They are now built lazily and keyed by locale, so
// `formatNumber` honours the host's chosen locale and a locale switch at runtime is
// picked up on the next call rather than requiring a page reload. The memo means a
// steady-state dashboard still allocates each preset exactly once.

type PresetName =
  | 'integer'
  | 'compactInteger'
  | 'decimal'
  | 'compactDecimal'
  | 'percent'
  | 'default'
  | 'compactDefault';

const PRESET_OPTIONS: Record<PresetName, Intl.NumberFormatOptions> = {
  integer: { maximumFractionDigits: 0 },
  compactInteger: { maximumFractionDigits: 1, notation: 'compact', compactDisplay: 'short' },
  decimal: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  compactDecimal: {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
    notation: 'compact',
    compactDisplay: 'short',
  },
  percent: { style: 'percent', maximumFractionDigits: 1 },
  default: { maximumFractionDigits: 2 },
  compactDefault: { maximumFractionDigits: 1, notation: 'compact', compactDisplay: 'short' },
};

const presetFormatCache = new Map<string, Intl.NumberFormat>();
const currencyFormatCache = new Map<string, Intl.NumberFormat>();
const preciseNumberFormatCache = new Map<string, Intl.NumberFormat>();

function getPresetFormat(preset: PresetName): Intl.NumberFormat {
  const locale = getStudioLocale();
  const key = `${locale ?? ''}:${preset}`;
  let fmt = presetFormatCache.get(key);
  if (!fmt) {
    // react-doctor-disable-next-line react-doctor/js-hoist-intl -- cached per locale/preset combination
    fmt = new Intl.NumberFormat(locale, PRESET_OPTIONS[preset]);
    setBoundedCacheEntry(presetFormatCache, key, fmt);
  }
  return fmt;
}

/**
 * Upper bound on each of the three memo Maps in this module. These are module-globals that
 * live for the lifetime of the page, and `currencyFormatCache` is keyed in part on
 * `currencyCode` — a plain,
 * doc/AI-authored `string` on `StudioDataField`/`StudioExpressionField` with no enum enforced
 * anywhere on the load path. Without a bound, every distinct (including every invalid) code a
 * dashboard renders leaves a permanent entry behind, so a doc that varies the code per widget
 * or per row grows the map without limit and never releases it.
 *
 * A real dashboard uses a handful of currency/precision combinations, so this bound is never
 * reached by legitimate use; eviction is insertion-ordered (drop the oldest), which for the
 * pathological case degrades to "re-create the formatter" rather than "leak".
 */
export const MAX_FORMAT_CACHE_ENTRIES = 64;

/**
 * Test-visible occupancy of the memo Maps, so the {@link MAX_FORMAT_CACHE_ENTRIES} bound
 * is pinned by a regression test rather than only asserted in a comment. This module is
 * internal (not re-exported from the package index), so this adds no public surface.
 */
export function getFormatCacheSizes(): { currency: number; precise: number; preset: number } {
  return {
    currency: currencyFormatCache.size,
    precise: preciseNumberFormatCache.size,
    preset: presetFormatCache.size,
  };
}

function setBoundedCacheEntry(
  cache: Map<string, Intl.NumberFormat>,
  key: string,
  value: Intl.NumberFormat,
): void {
  if (cache.size >= MAX_FORMAT_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
}

/**
 * ISO 4217 codes are exactly three letters. Anything else can never produce a valid
 * formatter, so it is collapsed onto the `USD` fallback *before* it becomes a cache key —
 * otherwise each distinct garbage code (`'NOTREAL'`, `'a'.repeat(1e6)`, …) minted its own
 * permanent entry holding an identical USD formatter.
 */
const CURRENCY_CODE_PATTERN = /^[A-Za-z]{3}$/;

function normalizeCurrencyCode(currencyCode: string | undefined): string {
  return typeof currencyCode === 'string' && CURRENCY_CODE_PATTERN.test(currencyCode)
    ? currencyCode.toUpperCase()
    : 'USD';
}

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
  const locale = getStudioLocale();
  const key = JSON.stringify({ locale, precision, ...options });
  let fmt = preciseNumberFormatCache.get(key);
  if (!fmt) {
    // react-doctor-disable-next-line react-doctor/js-hoist-intl -- cached per locale/precision/options combination
    fmt = new Intl.NumberFormat(locale, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
      ...(options ?? {}),
    });
    setBoundedCacheEntry(preciseNumberFormatCache, key, fmt);
  }
  return fmt;
}

function getCurrencyFormat(
  rawCurrencyCode: string | undefined,
  compact: boolean,
  precision?: number,
): Intl.NumberFormat {
  const currencyCode = normalizeCurrencyCode(rawCurrencyCode);
  const normalizedPrecision = normalizePrecision(precision);
  const locale = getStudioLocale();
  const key = `${locale ?? ''}:${currencyCode}:${compact}:${normalizedPrecision ?? 'default'}`;
  let fmt = currencyFormatCache.get(key);
  if (!fmt) {
    // Compact notation keeps up to 1 fraction digit (e.g. $40.5K) but must not force a
    // trailing zero onto whole values (e.g. $40, not $40.0); standard notation defaults
    // to whole currency amounts. An explicit precision pins both bounds.
    const minimumFractionDigits = normalizedPrecision ?? 0;
    const maximumFractionDigits = normalizedPrecision ?? (compact ? 1 : 0);
    const options: Intl.NumberFormatOptions = {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits,
      maximumFractionDigits,
      notation: compact ? 'compact' : 'standard',
      compactDisplay: 'short',
    };
    try {
      // react-doctor-disable-next-line react-doctor/js-hoist-intl -- cached; only created once per locale+currency+compact combination
      fmt = new Intl.NumberFormat(locale, options);
    } catch {
      // `currencyCode` is a plain, unvalidated `string` on `StudioDataField`/
      // `StudioExpressionField` (doc/AI-authored, no enum enforced at the schema level).
      // `normalizeCurrencyCode` already collapses anything that isn't three letters onto
      // 'USD', but a well-formed yet unassigned code could still make the
      // `Intl.NumberFormat` constructor throw a `RangeError` on some engines, which would
      // otherwise crash whichever widget/tooltip/grid cell render triggered the format. Fall
      // back to the 'USD' formatting for the same options rather than letting it bubble up.
      // react-doctor-disable-next-line react-doctor/js-hoist-intl -- cached; only created once per locale+currency+compact combination
      fmt = new Intl.NumberFormat(locale, { ...options, currency: 'USD' });
    }
    setBoundedCacheEntry(currencyFormatCache, key, fmt);
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
      return getCurrencyFormat(currencyCode, !!compact, normalizedPrecision).format(value);
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
      return getPresetFormat(compact ? 'compactInteger' : 'integer').format(value);
    case 'decimal':
      return getPresetFormat(compact ? 'compactDecimal' : 'decimal').format(value);
    case 'percent':
      return getPresetFormat('percent').format(value / 100);
    case 'currency':
      return getCurrencyFormat(currencyCode, !!compact).format(value);
    default:
      return getPresetFormat(compact ? 'compactDefault' : 'default').format(value);
  }
}

/**
 * Formats an **already-scaled** percentage — i.e. `42.5` renders as `42.5%`, not `4250%`.
 *
 * Distinct from `formatNumber(v, 'percent')`, which takes the same 0–100 scale but is reached
 * only through a field's `format`. Chart and KPI code computes percentages inline (a share of a
 * stack total, a pie arc's share, a trend delta) where there is no `StudioDataField` to consult,
 * and every one of those sites previously built the string as `` `${v.toFixed(1)}%` `` — which
 * hardcodes the `.` decimal separator and the trailing `%`, so a German dashboard rendered
 * `42.5%` beside a `42,5 €` produced by `Intl` two lines away. Routing them all through one
 * `Intl.NumberFormat` keeps the separator, the sign, and the symbol's placement consistent with
 * every other number the same widget renders.
 */
export function formatPercent(value: number, fractionDigits: number = 1): string {
  return getPrecisionFormat(fractionDigits, { style: 'percent' }).format(value / 100);
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
