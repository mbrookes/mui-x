/**
 * Pure utility functions for KPI widget computations.
 * Extracted here so they can be unit-tested independently of the React component.
 */
import { isoWeek } from '@mui/x-studio-schema';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioKpiAggregation,
  StudioExpressionField,
  StudioWidgetConfigForKind,
} from '../../../models';
import { fillTemporalLabelGaps, normalizeToDate } from '../../../internals/temporalUtils';
import { resolveDateRangePreset } from '../../../internals/filterUtils';
import { aggregateCellValues } from '../../../internals/aggregate';
import { evaluateMeasure } from '../../../utils/expressionEvaluator';
import { lookup } from '../../../utils/safeLookup';
import {
  isRelativeDateValue,
  relativeToAbsolute,
} from '../../StudioFiltersDrawer/filterDrawerUtils';

// ─── Granularity ──────────────────────────────────────────────────────────────

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

export function autoGranularity(start: Date, end: Date): Granularity {
  const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 14) {
    return 'day';
  }
  if (days <= 90) {
    return 'week';
  }
  if (days <= 730) {
    return 'month';
  }
  if (days <= 1460) {
    return 'quarter';
  }
  return 'year';
}

// ─── Fixed-period window ──────────────────────────────────────────────────────

/**
 * Computes the rolling "current period" window ending at the given date for
 * fixed-period trend mode. The window is always a contiguous N-day block:
 * - 'month'   → last 30 days
 * - 'quarter' → last 90 days
 * - 'year'    → last 365 days
 *
 * The window is inclusive of both `today` (end-of-day) and the first day, so it must
 * span exactly `days` calendar days: subtract `days - 1` from `today` for the start.
 * Subtracting the full `days` (the previous behavior) produced an inclusive `days + 1`-day
 * block (31/91/366) that contradicted the documented widths above (T3-1). The extra day was
 * harmless for the delta — current and previous windows stayed equal-length — but the
 * window should match its documentation.
 */
export function computeFixedPeriodRange(
  period: 'month' | 'quarter' | 'year',
  today: Date,
): { start: Date; end: Date } {
  const PERIOD_DAYS: Record<typeof period, number> = { month: 30, quarter: 90, year: 365 };
  // `period` reaches here from `config.kpiTrendFixedPeriod` (doc/AI-authored, not validated
  // against the declared union at runtime): index through the prototype-chain-safe `lookup` so
  // a value like "constructor"/"toString" yields `undefined` → the documented 30-day default,
  // rather than an inherited function that makes `setDate(NaN)` produce an Invalid Date and
  // silently drops the trend badge.
  const days = lookup(PERIOD_DAYS, period) ?? 30;
  const end = new Date(today);
  end.setHours(23, 59, 59, 999);
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

/**
 * Reduce a date-like row value to its LOCAL `YYYY-MM-DD` calendar-day key.
 *
 * A bare `date` value (`'YYYY-MM-DD'`, no time-of-day) has an unambiguous calendar day —
 * its literal string — so it is returned as-is; parsing it to a Date first would anchor it
 * to UTC midnight and day-shift it under the LOCAL reduction below. Every other value — an
 * ingested `datetime` string (`'YYYY-MM-DDTHH:MM:SSZ'`), a `Date`, or a ms timestamp — is a
 * true instant and is reduced to its LOCAL calendar day. This keeps the row side in the SAME
 * calendar space as the window bounds (`filterRowsByDateRange` reduces them via `toLocalYmd`,
 * also LOCAL). The previous leading-10-chars fast path returned a datetime's UTC day,
 * mismatching the LOCAL bounds and misclassifying near-UTC-midnight datetime rows for
 * off-UTC viewers (T2-1). NOTE: the sparkline buckets (`getBucketKey`) deliberately do NOT
 * follow this LOCAL convention — see that function's own docstring (T2-3).
 */
function toDayKey(raw: unknown): string | null {
  if (typeof raw === 'string') {
    // Bare date-only value (anchored, no time-of-day): its calendar day IS the string.
    const m = /^(\d{4}-\d{2}-\d{2})$/.exec(raw);
    if (m) {
      return m[1];
    }
  }
  const d = normalizeToDate(raw);
  return d ? toLocalYmd(d) : null;
}

/**
 * Filter rows to those where the given date field falls within [start, end] inclusive.
 *
 * Windowing is done in LOCAL calendar-day space — both the row value (`toDayKey`) and the
 * window bounds (`toLocalYmd`) are reduced to `YYYY-MM-DD` strings and compared lexically,
 * rather than as instants. Note this is deliberately LOCAL, NOT the UTC day-truncation L3
 * (`filterUtils`' `toDayComparable`) uses: the KPI's window bounds are built in local time
 * (`computeFixedPeriodRange` via `setHours`), so unifying the row side on LOCAL keeps both
 * sides of the comparison provably in one calendar space. Comparing a UTC-parsed row date
 * against a locally-built bound (as the old `d >= start && d <= end` did) misclassified
 * boundary-day rows for non-UTC viewers (finding F3 / T2-1).
 */
export function filterRowsByDateRange(
  rows: Record<string, unknown>[],
  dateField: string,
  start: Date,
  end: Date,
): Record<string, unknown>[] {
  const startKey = toLocalYmd(start);
  const endKey = toLocalYmd(end);
  return rows.filter((row) => {
    const raw = lookup(row, dateField);
    if (raw === null || raw === undefined) {
      return false;
    }
    const key = toDayKey(raw);
    if (key === null) {
      return false;
    }
    return key >= startKey && key <= endKey;
  });
}

// ─── Date range extraction ─────────────────────────────────────────────────────

/** Extract a concrete date range [start, end] from a filter value, resolving relative values. */
export function extractDateRange(filter: StudioFilterState): { start: Date; end: Date } | null {
  const toDate = (v: unknown): Date | null => {
    if (!v) {
      return null;
    }
    // Resolve relative date values (e.g. "1 month ago") to concrete date strings first
    const str = isRelativeDateValue(v) ? relativeToAbsolute(v) : (v as string);
    // A bare `YYYY-MM-DD` filter value must be parsed to LOCAL midnight, NOT the UTC
    // midnight `new Date('YYYY-MM-DD')` produces. The previous-period math
    // (`computePreviousPeriodRange`, local getters), the calendar-period classification
    // (`getMonth`/`getFullYear`), and the boundary serialization (`toLocalYmd`, local
    // components) all read LOCAL calendar fields — so a UTC-midnight anchor day-shifts the
    // derived window for any viewer off UTC: the `previous-period` window comes out a day
    // short (UTC) or overlapping the current window (UTC+), and `previous-calendar-period` /
    // `year-over-year` resolve to the wrong calendar period entirely west of UTC
    // (findings F1/F2). Mirror the package's documented local-components policy.
    if (typeof str === 'string') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
      if (m) {
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      }
      // A `datetime` bound carries a UTC time-of-day — notably a `datetime` preset's end,
      // which `resolveDateRangePreset` anchors to UTC end-of-day (`…T23:59:59.999Z`). Parsing
      // it with `new Date` and reading LOCAL calendar fields (as `computePreviousPeriodRange`
      // does, in whole-LOCAL-day space) lands it on the NEXT local day for viewers east of UTC,
      // so the UTC `23:59:59.999Z` suffix inflates the inclusive-day count and shifts the
      // derived previous window by a day (T2-2). Collapse it to LOCAL midnight of its intended
      // calendar day (the leading `YYYY-MM-DD`, i.e. the day the preset built) so the KPI's
      // day-granular window math stays timezone-stable. Bare `date` bounds are handled above
      // and never reach here.
      const dt = /^(\d{4})-(\d{2})-(\d{2})T/.exec(str);
      if (dt) {
        return new Date(Number(dt[1]), Number(dt[2]) - 1, Number(dt[3]));
      }
    }
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  // Resolve any non-custom date-range preset to a concrete `{ from, to }` value
  // first — regardless of scope, so a widget-scoped KPI preset is honored the same
  // as a dashboard-date-range one. Shares the single resolver with the pipeline.
  const resolved = resolveDateRangePreset(filter);

  // Handle `operator: 'between'` with a concrete `{ from, to }` value.
  if (resolved.operator === 'between') {
    if (
      resolved.value !== null &&
      typeof resolved.value === 'object' &&
      'from' in (resolved.value as object)
    ) {
      const obj = resolved.value as { from?: string; to?: string };
      const start = toDate(obj.from);
      const end = toDate(obj.to);
      if (start && end) {
        return start <= end ? { start, end } : { start: end, end: start };
      }
    }
    return null;
  }

  const v1 = toDate(resolved.value);
  const v2 = toDate(resolved.value2);

  if (v1 && v2 && resolved.conjunction === 'and') {
    const start = v1 < v2 ? v1 : v2;
    const end = v1 < v2 ? v2 : v1;
    return { start, end };
  }
  if (v1) {
    // Single-sided — the operator decides WHICH side the filter value bounds.
    // Mirrors the display-side interpretation in `internals/widgetUtils.tsx`
    // ("since X" for `greater_than*`, "until X" for `less_than*`).
    const op = resolved.operator;
    if (op === 'equals') {
      // "On X": the filter keeps ONLY rows on the single day X, so the current period is
      // that one calendar day — [start-of-day X, end-of-day X] — NOT the open-ended
      // "since X" window below. Deriving `{ start: X, end: today }` here (the previous
      // operator-blind fall-through) made the trend compare a single-day headline against
      // an ~open-ended previous aggregate, always producing a bogus huge delta (T1.5).
      const end = new Date(v1);
      end.setHours(23, 59, 59, 999);
      return { start: v1, end };
    }
    if (op === 'not_equals' || op === 'is_empty' || op === 'is_not_empty') {
      // "not X" / emptiness filters define no contiguous date window at all, so no trend
      // badge can be meaningfully derived from them — return null instead of falling through
      // to the "since X" window, which would fabricate an ~open-ended delta (T1.5).
      return null;
    }
    if (op === 'less_than' || op === 'less_than_or_equal') {
      // "until X": the filter keeps rows up to (and maybe including) X, so X is
      // the END of the current period — NOT the start. Deriving `{ start: X,
      // end: today }` here (the old, operator-blind behavior) inverted the window
      // to exactly the region the filter excludes (finding 1.11). Mirror the
      // open-ended "since X" window backwards so the derived window has an
      // equivalent length but ends at the filter value. `Math.abs` keeps `start`
      // on or before `end` whether X is in the past (the common case) or future.
      const span = Math.abs(new Date().getTime() - v1.getTime());
      return { start: new Date(v1.getTime() - span), end: v1 };
    }
    // "since X" (`greater_than`/`greater_than_or_equal`, or a legacy filter with
    // no range operator): X is the start, today is the open end.
    return { start: v1, end: new Date() };
  }
  return null;
}

// ─── Date filter lookup ────────────────────────────────────────────────────────

/**
 * Whether `filter` targets a date/datetime field.
 *
 * Prefers the stored `filter.fieldType` (reliable even for cross-source filters).
 * Falls back to looking up the field type in `dataSource.fields` for legacy filters
 * that were stored without a `fieldType`. Shared by `findDateFilter` below and by
 * the fixed-period trend's "strip the active date filter(s)" logic in
 * `StudioKpiWidget.tsx` (T2-2), so both agree on what counts as a date filter.
 */
export function isDateFieldFilter(
  filter: StudioFilterState,
  dataSource: StudioDataSource,
): boolean {
  if (filter.fieldType === 'date' || filter.fieldType === 'datetime') {
    return true;
  }
  const fieldDef = dataSource.fields.find((fd) => fd.id === filter.field);
  return fieldDef?.type === 'date' || fieldDef?.type === 'datetime';
}

/**
 * Scope specificity, most → least specific, for breaking ties when more than one
 * in-scope date filter exists simultaneously (e.g. a page-level AND a widget-level date
 * filter both active at once). Lower number wins.
 */
const DATE_FILTER_SCOPE_PRIORITY: Partial<Record<StudioFilterState['scope']['kind'], number>> = {
  widget: 0,
  page: 1,
  'dashboard-date-range': 2,
};

/**
 * Find the date/datetime filter that applies to this widget (page, widget, or
 * dashboard-date-range scope).
 *
 * CONTRACT: `filters` MUST be pre-scoped to this widget by the caller (via
 * `selectFiltersForWidget`) before being passed in. This function does NOT verify a
 * `dashboard-date-range` filter's `sourceId`/`filterSourceId` matches the widget's source,
 * nor does it apply the `pageId`/`disabled`/cross-filter checks `selectFiltersForWidget`
 * performs — it trusts every candidate is already in scope. Passing a raw, unscoped filter
 * list here could latch onto a date filter that does not actually apply to the widget. All
 * current callers pre-scope; keep it that way.
 *
 * When MULTIPLE in-scope date filters exist at once (e.g. a page-level date filter and a
 * widget-level one both active), the MOST SPECIFIC scope wins — widget > page >
 * dashboard-date-range — rather than whichever happened to appear first in `filters` (an
 * arbitrary array-order tiebreak that could latch onto either one depending on authoring
 * order, occasionally yielding a bogus ∞/"New" trend badge when the ignored filter would
 * have produced a sane one) (T3-1). L3's own row-filtering (`selectFiltersForWidget` /
 * `applyFilters`) has no analogous single-choice precedence to mirror here — every
 * in-scope filter is AND-combined against the rows rather than one arbitrating the
 * other — so this picks the narrowest scope as the most deliberate, specific choice: a
 * filter authored directly on this widget more clearly reflects intent for THIS widget's
 * trend than a page-wide or dashboard-wide default.
 */
export function findDateFilter(
  filters: StudioFilterState[],
  widgetId: string,
  dataSource: StudioDataSource,
): StudioFilterState | undefined {
  const relevant = filters.filter(
    (f) =>
      f.scope.kind === 'page' ||
      f.scope.kind === 'dashboard-date-range' ||
      (f.scope.kind === 'widget' && f.scope.widgetId === widgetId),
  );
  // `.sort` is stable, so filters sharing a scope kind keep their original relative order.
  const bySpecificity = [...relevant].sort(
    (a, b) =>
      (lookup(DATE_FILTER_SCOPE_PRIORITY, a.scope.kind) ?? 3) -
      (lookup(DATE_FILTER_SCOPE_PRIORITY, b.scope.kind) ?? 3),
  );
  return bySpecificity.find((f) => isDateFieldFilter(f, dataSource));
}

// ─── Canonical "which date field does this KPI use?" rule ─────────────────────

/**
 * Where a KPI's resolved date field came from. Ordered most → least authoritative,
 * matching the tiers `resolveKpiDateField` tries.
 */
export type KpiDateFieldOrigin = 'filter' | 'config' | 'source-default' | 'none';

export interface KpiDateFieldResolution {
  /** The date field id to bucket / window on. `null` when nothing could be resolved. */
  field: string | null;
  /**
   * The source that OWNS `field`. Equal to the widget's own source for a native field;
   * a related source id when the field lives across a relationship. `undefined` only
   * when `field` is `null` (or the widget has no source at all).
   */
  sourceId: string | undefined;
  /** True when `field` is a column on the widget's OWN rows (no cross-source join needed). */
  isNative: boolean;
  /**
   * The in-scope date filter that was found, whether or not it drove the resolution.
   * Callers use it for auto-granularity even when it did not win the field choice.
   */
  dateFilter: StudioFilterState | undefined;
  /** Which tier produced `field`. */
  origin: KpiDateFieldOrigin;
}

/**
 * THE single "which date field does this KPI use?" rule.
 *
 * There used to be three independent answers to that question — the sparkline's, the
 * fixed-period trend's, and the setup panel's — and they disagreed in ways users could see
 * (M5):
 *
 * - The sparkline took the active date filter's field only when it was NATIVE to the widget's
 *   source, and otherwise fell through to `kpiSparklineField`. A page filter on a RELATED
 *   source (e.g. `orders.order_date` on a `customers` KPI) therefore resolved to `null` — no
 *   sparkline at all — while the panel simultaneously reported "Using the date filter on Order
 *   Date" and HID the manual time-field picker, leaving the user no control to fix it.
 * - The fixed-period trend preferred `kpiSparklineField` and only then the first date field on
 *   the widget's own source, so a source with `created_at` (first) plus a page filter on
 *   `shipped_at` bucketed the sparkline on `shipped_at` while the trend windowed on
 *   `created_at` — two different date columns in one card.
 *
 * The canonical rule is **filter → explicit config → first own-source date field**, i.e. the
 * SPARKLINE's precedence (filter wins over config), extended with the TREND's last-resort
 * fallback. That ordering is the one the UI already promises: `KpiSparklineOptions` replaces
 * the time-field picker with "Using the date filter on X" as soon as an in-scope date filter
 * exists, so a rule where the stored config outranked the filter would contradict the only
 * affordance the user has. The own-source fallback is kept because the trend section of the
 * setup panel has NO date-field picker of its own — a fixed-period trend on a KPI with the
 * sparkline switched off has no other way to name a window field.
 *
 * Consumers differ ONLY in how they treat the last tier, and that difference is a single
 * documented `origin` check rather than a second lookup chain:
 * - the sparkline requires `origin !== 'source-default'`, so an unconfigured KPI still renders
 *   the "pick a time field" hint instead of silently bucketing on whichever date column happens
 *   to be declared first (which would also contradict the panel's empty picker);
 * - the fixed-period trend accepts every tier.
 *
 * Whenever both consumers resolve a field, they resolve the SAME one — which is the property
 * the two repros above needed.
 *
 * CONTRACT: `scopedFilters` MUST already be scoped to this widget via `selectFiltersForWidget`
 * (same contract as `findDateFilter`, which this delegates to).
 */
export function resolveKpiDateField(params: {
  config: Pick<StudioWidgetConfigForKind<'kpi'>, 'kpiSparklineField' | 'kpiSparklineSourceId'>;
  widgetId: string;
  widgetSourceId: string | undefined;
  dataSource: StudioDataSource | undefined;
  /** Pre-scoped via `selectFiltersForWidget` — see the contract note above. */
  scopedFilters: StudioFilterState[];
}): KpiDateFieldResolution {
  const { config, widgetId, widgetSourceId, dataSource, scopedFilters } = params;

  const dateFilter = dataSource ? findDateFilter(scopedFilters, widgetId, dataSource) : undefined;

  // Tier 1 — the active date filter. `filterSourceId` names the owning source for a
  // cross-source filter; its absence means the filter targets the widget's own source.
  if (dateFilter?.field) {
    const sourceId = dateFilter.filterSourceId ?? widgetSourceId;
    return {
      field: dateFilter.field,
      sourceId,
      isNative: sourceId === widgetSourceId,
      dateFilter,
      origin: 'filter',
    };
  }

  // Tier 2 — the explicitly configured time field. `kpiSparklineSourceId` is written by the
  // panel's picker whenever the chosen field belongs to a related source, so it — not a
  // separately-derived guess — is the authority on where the field lives.
  if (config.kpiSparklineField) {
    const sourceId = config.kpiSparklineSourceId ?? widgetSourceId;
    return {
      field: config.kpiSparklineField,
      sourceId,
      isNative: sourceId === widgetSourceId,
      dateFilter,
      origin: 'config',
    };
  }

  // Tier 3 — last resort: the first date/datetime column declared on the widget's own source.
  const ownDateField = dataSource?.fields.find((f) => f.type === 'date' || f.type === 'datetime');
  if (ownDateField) {
    return {
      field: ownDateField.id,
      sourceId: widgetSourceId,
      isNative: true,
      dateFilter,
      origin: 'source-default',
    };
  }

  return { field: null, sourceId: undefined, isNative: false, dateFilter, origin: 'none' };
}

// ─── Previous period range ─────────────────────────────────────────────────────

/**
 * Format a Date as `YYYY-MM-DD` from its LOCAL calendar components.
 *
 * Mirrors `internals/temporalUtils`'s `toLocalYmd`, and exists for the same reason:
 * the previous-period window boundaries are computed in LOCAL time (see
 * `computePreviousPeriodRange`), so serializing them with `date.toISOString().slice(0, 10)`
 * round-trips through UTC and day-shifts the boundary for any non-UTC viewer
 * (backward for UTC+, forward for UTC-). Formatting the local Y/M/D components keeps
 * the serialized bound on the same calendar day the boundary math produced
 * (finding 1.12 / the package's documented anti-day-shift policy).
 */
export function toLocalYmd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

type TrendComparison = 'previous-period' | 'previous-calendar-period' | 'year-over-year';

type CalendarPeriod = 'week' | 'month' | 'quarter' | 'year';

/**
 * Classify a date range by the calendar period whose typical length best matches
 * the range, for the `previous-calendar-period` comparison mode.
 *
 * This is deliberately NOT `autoGranularity`: that function's thresholds are tuned
 * for sparkline BUCKETING (how many buckets to draw), which maps any 15–90-day
 * range to `'week'`. Feeding that into the previous-period math shifts a ~monthly
 * range back by a single week, so the "previous" window overlaps the current one
 * and the trend delta degenerates toward a self-comparison (finding 2.18). Here the
 * thresholds are centered on the actual lengths of calendar periods so the previous
 * window never overlaps the current one:
 * - ≤ 10 days  → week    (~7-day range)
 * - ≤ 45 days  → month   (~28–31-day range)
 * - ≤ 135 days → quarter (~90-day range)
 * - otherwise  → year
 */
function comparisonGranularity(start: Date, end: Date): CalendarPeriod {
  const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 10) {
    return 'week';
  }
  if (days <= 45) {
    return 'month';
  }
  if (days <= 135) {
    return 'quarter';
  }
  return 'year';
}

/**
 * Given a current [start, end] date range and a comparison mode, computes the
 * [start, end] of the previous comparison period.
 */
export function computePreviousPeriodRange(
  start: Date,
  end: Date,
  mode: TrendComparison,
): { start: Date; end: Date } {
  if (mode === 'year-over-year') {
    const prevStart = new Date(start);
    prevStart.setFullYear(start.getFullYear() - 1);
    const prevEnd = new Date(end);
    prevEnd.setFullYear(end.getFullYear() - 1);
    return { start: prevStart, end: prevEnd };
  }

  if (mode === 'previous-calendar-period') {
    const granularity = comparisonGranularity(start, end);
    if (granularity === 'year') {
      return {
        start: new Date(start.getFullYear() - 1, 0, 1),
        end: new Date(start.getFullYear() - 1, 11, 31, 23, 59, 59, 999),
      };
    }
    if (granularity === 'quarter') {
      const q = Math.floor(start.getMonth() / 3);
      const prevQ = q === 0 ? 3 : q - 1;
      const prevYear = q === 0 ? start.getFullYear() - 1 : start.getFullYear();
      return {
        start: new Date(prevYear, prevQ * 3, 1),
        end: new Date(prevYear, prevQ * 3 + 3, 0, 23, 59, 59, 999),
      };
    }
    if (granularity === 'week') {
      // Calendar arithmetic (not raw ms subtraction): across a spring-forward DST
      // transition a 7-day span is only 167 wall-clock hours, so `start − 168h`
      // lands at 23:00 the previous calendar day and `toLocalYmd` then serializes
      // `prevStart` one day too early. Shifting the calendar date by 7 keeps the
      // previous window exactly 7 whole days back in every timezone — matching the
      // month/quarter/year sibling branches.
      return {
        start: new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7),
        end: new Date(end.getFullYear(), end.getMonth(), end.getDate() - 7),
      };
    }
    // month (default)
    const prevMonth = start.getMonth() === 0 ? 11 : start.getMonth() - 1;
    const prevYear = start.getMonth() === 0 ? start.getFullYear() - 1 : start.getFullYear();
    return {
      start: new Date(prevYear, prevMonth, 1),
      end: new Date(prevYear, prevMonth + 1, 0, 23, 59, 59, 999),
    };
  }

  // Default: 'previous-period' — the immediately-preceding window of the SAME whole-day
  // length. Computed in whole-day space (mirroring L3's inclusive-day `between` semantics),
  // NOT via instant subtraction: `duration = end − start` measures one day short of the
  // inclusive window (a Jul 8–14 filter spans 7 calendar days but `end − start` is 6 days),
  // and the `end: start − 1ms` construction lands the previous window's end 1ms after the
  // prior day's midnight, day-shifting the boundary for non-UTC viewers (findings F1/F3).
  // Instead: the previous window ends the day before the current window starts, and is as
  // many whole days long as the current one — so the two windows are adjacent, equal-length,
  // and never overlap in any timezone.
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const inclusiveDayCount = Math.round((endDay.getTime() - startDay.getTime()) / MS_PER_DAY) + 1;
  const prevEnd = new Date(startDay);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (inclusiveDayCount - 1));
  return { start: prevStart, end: prevEnd };
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

export function computeAggregate(
  rows: Record<string, unknown>[],
  field: string,
  aggregation: StudioKpiAggregation,
): number | null {
  // One value per row (prototype-chain-safe `lookup`, `undefined` for a missing key),
  // handed to the shared `aggregateCellValues` — the single place that decides what each
  // aggregation NAME means over a row set (finding M8). This preserves every semantic this
  // function already had (it IS the reference implementation the others were aligned to):
  // `count` is `COUNT(*)` (`values.length` === `rows.length`), `count_distinct` is measured
  // over the RAW values, and `sum`/`avg`/`min`/`max` skip null/non-numeric rows so they
  // never inflate an avg denominator or drag a min toward 0. Routing through the shared
  // helper is what stops the measure-expression path drifting away from it again.
  return aggregateCellValues(
    rows.map((row) => lookup(row, field)),
    aggregation,
  );
}

// ─── Sparkline bucketing ──────────────────────────────────────────────────────

/**
 * Reduce a `Date` to a sort-stable bucket key for the given granularity.
 *
 * Reads UTC calendar components, NOT local ones. `computeSparklineData`'s only caller
 * feeds this a `Date` produced by `normalizeToDate`, which parses a bare canonical
 * `'YYYY-MM-DD'` row value (the common case for a KPI's time field) to UTC midnight of
 * that calendar day. Reading LOCAL components off that UTC-midnight instant rolls it
 * back to the PREVIOUS calendar day for any viewer west of UTC (negative offset),
 * misclassifying the row into the wrong sparkline bucket (T2-3). `toDayKey` above
 * already sidesteps this same trap for its own bare-date case by returning the literal
 * string; reading UTC components here achieves the equivalent — the day the canonical
 * string names — without needing a separate raw-string special case.
 */
export function getBucketKey(date: Date, granularity: Granularity): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  switch (granularity) {
    case 'day':
      return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    case 'week': {
      // Use the shared ISO-week helper (also used by `internals/temporalUtils.ts`'s
      // `truncateToGranularity` for the same purpose) so the key is
      // `{year}-W{weekNumber}` and sorts chronologically regardless of month
      // boundaries — a hand-rolled `{year}-W{dayOfMonth}-{month}` key (the previous
      // approach) sorts lexicographically, not chronologically, whenever a week
      // falls in a month whose day-of-month digits compare out of order across a
      // month boundary (see finding 1.11).
      const { year, week } = isoWeek(new Date(Date.UTC(y, m, d)));
      return `${year}-W${String(week).padStart(2, '0')}`;
    }
    case 'month':
      return `${y}-${String(m + 1).padStart(2, '0')}`;
    case 'quarter':
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    case 'year':
      return `${y}`;
    default:
      return `${y}-${String(m + 1).padStart(2, '0')}`;
  }
}

export function computeSparklineData(
  rows: Record<string, unknown>[],
  timeField: string,
  valueField: string,
  aggregation: StudioKpiAggregation,
  granularity: Granularity,
  cumulative: boolean,
  // When the KPI's value field is a measure expression field, measures aggregate
  // themselves via `evaluateMeasure` (their values do not exist per-row — they are
  // never enriched onto rows, unlike calculated columns). Passing the measure field
  // here routes each bucket through the same computation the headline/trend use,
  // instead of `computeAggregate` reading a nonexistent `row[measureId]` and silently
  // producing a flat zero series (finding 2.6).
  measureExprField?: StudioExpressionField,
  expressionFields?: StudioExpressionField[],
): (number | null)[] {
  const buckets = new Map<string, Record<string, unknown>[]>();

  for (const row of rows) {
    const raw = lookup(row, timeField);
    if (raw === null || raw === undefined) {
      continue;
    }
    const date = normalizeToDate(raw);
    if (!date) {
      continue;
    }
    const key = getBucketKey(date, granularity);
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key)!.push(row);
  }

  const sortedKeys = Array.from(buckets.keys()).sort();

  // Densify the period axis: `buckets` only holds keys that had at least one row, so a
  // period with no data would otherwise contribute NO entry at all and the next period
  // would slide left into its place. The sparkline is rendered by `KpiSparkline` with no
  // `xAxis` — points are laid out at uniform spacing — so a deleted period is invisible:
  // Jan/Feb/(no March)/Apr would draw as three evenly spaced points and the two-month
  // Feb->Apr drop would look exactly like a one-month drop.
  //
  // `fillTemporalLabelGaps` is the same helper every chart family uses (via
  // `densifyBarLabels`) for this, and it accepts precisely the key formats `getBucketKey`
  // emits. It returns its input unchanged when the keys aren't a recognizable temporal
  // sequence or when the synthesized run would exceed its own safety cap, so a
  // non-densifiable series degrades to the previous (packed) behaviour rather than
  // throwing. Invariant upheld here: the returned array has one entry per period in
  // [first bucket, last bucket], and index i always corresponds to `periodKeys[i]`.
  const periodKeys = fillTemporalLabelGaps(sortedKeys) as string[];

  const periodValues = periodKeys.map((key) => {
    const bucketRows = buckets.get(key);
    // A synthesized position (no bucket) is a genuinely empty period: emit `null` so the
    // chart draws a gap there instead of a fabricated 0, which would read as a real
    // measurement of zero. `SparkLineChart` accepts `null` and `KpiSparkline`'s
    // `valueFormatter` already handles it.
    if (!bucketRows) {
      return null;
    }
    // A bucket that HAS rows but yields `null` is still an UNMEASURED period, not a
    // measured zero — `computeAggregate` returns `null` for an avg/min/max over rows whose
    // values are all null/non-numeric, and `evaluateMeasure` returns `null` for a
    // root-level divide/modulo-by-zero. This used to collapse to `0`, which drew a real
    // data point at zero: for an `avg` KPI a month where every row's value was blank read
    // as "the average was 0 that month". That is the same "null means not measured, not
    // zero" violation as the trend's `computePeriodValue` (M3), and the sparkline already
    // has a first-class representation for it — the `null` gap the empty-period branch
    // above emits. Note this is NOT the "aggregates to zero" case: `sum`/`count` over rows
    // return a real `0` and still plot a point (see the `kpiUtils.test.ts` case pinning that).
    const value = measureExprField
      ? evaluateMeasure(measureExprField, bucketRows, expressionFields ?? [])
      : computeAggregate(bucketRows, valueField, aggregation);
    return value;
  });

  if (!cumulative) {
    return periodValues;
  }

  // An empty period stays a gap in the cumulative series too, but it must not reset or
  // skew the running total: it contributes 0 and the next real period resumes from the
  // total accumulated so far.
  let running = 0;
  return periodValues.map((v) => {
    if (v === null) {
      return null;
    }
    running += v;
    return running;
  });
}

// ─── Period formatting ────────────────────────────────────────────────────────

/**
 * Locale-aware short month abbreviation, e.g. "Mar" (en) / "mars" (fr) / "März" (de).
 * Mirrors the `toLocaleDateString` approach already used by the sibling
 * `formatDateRangeLong` below, rather than a hardcoded English month-name array.
 */
function monthAbbr(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short' });
}

/** Format a date as a short human-readable label, e.g. "Mar 2026" or "Mar–Apr 2026". */
export function formatPeriodShort(start: Date, end: Date): string {
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${monthAbbr(start)} ${start.getFullYear()}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${monthAbbr(start)}–${monthAbbr(end)} ${start.getFullYear()}`;
  }
  return `${monthAbbr(start)} ${start.getFullYear()}–${monthAbbr(end)} ${end.getFullYear()}`;
}

/** Format a full date range for a tooltip, e.g. "Mar 1 – Mar 31, 2026". */
export function formatDateRangeLong(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const startStr = start.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}
