import type { StudioFilterState } from '../models';
import { sortLabels, type XGroupBy } from './temporalUtils';
import { applyXGroupBy, isEmptyXValue, toXValue } from './chartValues';
import type { StudioLocaleText } from './localeText';
import {
  accumulateValue,
  coerceAggregateValue,
  createAggregateAccumulator,
  finalizeAccumulator,
  type AggregateAccumulator,
} from './aggregate';

type Row = Record<string, unknown>;

/** The per-series aggregation functions the chart aggregators understand. */
type ChartAggFn = 'sum' | 'count' | 'avg' | 'min' | 'max';

export interface AggregatedData {
  labels: (string | number)[];
  /**
   * One aggregated value per label, or `null` where the label's bucket produced NO
   * aggregate at all (every contributing row's measure was null/non-numeric, or —
   * for a blended series — the source has no row in that category).
   *
   * `null`, not 0: a synthetic 0 is indistinguishable from a genuine zero measurement,
   * so an all-null Oslo temperature bucket plotted at 0 °C above a real −4 °C Rome, and
   * a `chartSortBy: 'value'` sort or a Top-N rank promoted it to first place (H4).
   * Matches the sibling {@link MultiSeriesData}, which was already `(number | null)[]`.
   */
  values: (number | null)[];
}

/**
 * Multi-series aggregated data for grouped/stacked charts
 */
export interface MultiSeriesData {
  labels: (string | number)[];
  seriesNames: (string | number)[];
  seriesData: Record<string | number, (number | null)[]>;
}

/**
 * Aggregate multiple Y fields against the same X axis (for multi-series charts)
 */
export interface MultiYSeriesData {
  labels: (string | number)[];
  /**
   * `sourceId` is only populated for blended series (see {@link aggregateBlendedSeries}),
   * where two entries can legitimately share the same `fieldId` while originating from
   * different sources. Non-blended aggregation (`aggregateMultipleSeries`) never sets it,
   * since its series are already de-duplicated by `fieldId` within a single source.
   */
  series: Array<{
    fieldId: string;
    sourceId?: string;
    /** See {@link AggregatedData.values} — `null` marks a label the series has no data for. */
    values: (number | null)[];
  }>;
}

/** Which end of the ranking survives: `'top'` keeps the highest scores, `'bottom'` the lowest. */
type RankDirection = 'top' | 'bottom';

/**
 * Reduce one candidate's cells to a single rank score, skipping the `null`s.
 *
 * `null` cells are ABSENT measurements, not zeros (see {@link AggregatedData.values}), so they
 * contribute nothing: they neither add 0 to a sum, nor pull an average toward 0, nor win a
 * `min`/`max` against a real value. When every cell is null the candidate has no data at all
 * and the score is `null` — which {@link selectRankedIndices} sorts to the losing end.
 *
 * Uses an explicit loop rather than `Math.min(...values)`: the spread form throws
 * `RangeError: Maximum call stack size exceeded` past ~125k elements (matching
 * `internals/aggregate.ts` and `utils/gridGrouping.ts`).
 */
function reduceRankScore(
  values: readonly (number | null | undefined)[],
  fn: 'sum' | 'avg' | 'min' | 'max',
): number | null {
  let acc: number | null = null;
  let count = 0;
  for (const value of values) {
    if (value == null) {
      continue;
    }
    count += 1;
    if (acc === null) {
      acc = value;
    } else if (fn === 'min') {
      acc = value < acc ? value : acc;
    } else if (fn === 'max') {
      acc = value > acc ? value : acc;
    } else {
      acc += value;
    }
  }
  if (acc === null) {
    return null;
  }
  return fn === 'avg' ? acc / count : acc;
}

/**
 * Pick the indices of the `n` best-ranked candidates out of `count`, scoring each through
 * `rawScoreOf`. The one place the rank ordering policy lives, shared by all three
 * `applyRankTo*` entry points so a Top-N behaves identically whatever shape the data has.
 *
 * A `null` raw score means "no data", not "zero" — such a candidate must never win a slot in
 * a Top-N or a Bottom-N, so it sorts LAST in EITHER direction rather than being coerced to a
 * 0 that outranks every negative value (or undercuts every positive one), or to a ±Infinity
 * that beats every real measurement (H4).
 *
 * The comparator tests equality first, so two no-data candidates (both the same ±Infinity)
 * compare as 0 instead of yielding `Infinity - Infinity === NaN`. A NaN comparator is not a
 * consistent ordering, which makes the surviving set engine-dependent.
 *
 * Returns the winning indices as a Set; every caller then filters its own arrays with a
 * keep-mask, so surviving candidates stay in their ORIGINAL input order. Ranking selects
 * WHICH candidates survive; the caller's `orderLabels`/`chartSortBy` choice remains the
 * single authority on their order.
 */
function selectRankedIndices(
  count: number,
  rawScoreOf: (index: number) => number | null | undefined,
  dir: RankDirection,
  n: number,
): Set<number> {
  const noDataScore = dir === 'top' ? -Infinity : Infinity;
  const scoreOf = (index: number): number => rawScoreOf(index) ?? noDataScore;
  const indices = Array.from({ length: count }, (_, i) => i);
  indices.sort((a, b) => {
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    if (sa === sb) {
      return 0;
    }
    return dir === 'top' ? sb - sa : sa - sb;
  });
  return new Set(indices.slice(0, n));
}

/**
 * Apply a rank filter to already-aggregated chart data.
 * Ranks by the aggregated value (the bar/slice height) and keeps top/bottom N — unless
 * `rankFilter.rankByField` is set and the caller supplies `rankByFieldData`, in which case
 * ranking uses that separate measure instead (see the `rankByFieldData` param doc).
 *
 * The kept labels/values are returned in their ORIGINAL input order (via a keep-mask),
 * NOT in rank-score order — matching `applyRankToMultiSeries` and
 * `applyRankToSeriesFieldData`, its two siblings. Reordering here made a single-series bar
 * render in value order while adding a second Y series flipped it back to the canonical
 * `chartSortBy`/`orderedValues` ordering, and made the bar order jump between the ghost and
 * non-ghost aggregations (finding 2.5). Ranking selects WHICH categories survive; the caller's
 * `orderLabels`/`chartSortBy` choice remains the single authority on their order.
 */
export function applyRankToAggregated(
  data: AggregatedData,
  rankFilter: StudioFilterState | null,
  /**
   * Per-label SUM of `rankFilter.rankByField`, over the SAME rows and x-axis grouping that
   * produced `data` (e.g. `aggregateByField(rows, xField, rankByField, xGroupBy, 'sum')`).
   * When `rankFilter.rankByField` is set, ranking uses THIS score instead of `data.values` —
   * matching the row-level rank reduction every other widget kind applies (`filterUtils.ts`'s
   * `rankByField` branch, which always SUMS the rank-by measure per group regardless of the
   * widget's own display aggregation). Without it, a chart's post-aggregation Top-N ranked by
   * the displayed (possibly avg/min/max) value and silently ignored `rankByField`, disagreeing
   * with grid/KPI/map/pivot widgets on an identical rank filter (finding 3.x). Ignored when
   * `rankFilter.rankByField` is unset, or when omitted — ranking then falls back to `data.values`.
   */
  rankByFieldData?: AggregatedData,
): AggregatedData {
  if (!rankFilter) {
    return data;
  }
  const n = Math.round(Number(rankFilter.value));
  if (!Number.isFinite(n) || n <= 0) {
    return data;
  }
  const dir = rankFilter.rankDirection ?? 'top';

  let rawScoreOf: (i: number) => number | null;
  if (rankFilter.rankByField && rankByFieldData) {
    const scoreByLabel = new Map<string | number, number | null>();
    rankByFieldData.labels.forEach((label, i) => {
      scoreByLabel.set(label, rankByFieldData.values[i]);
    });
    rawScoreOf = (i) => scoreByLabel.get(data.labels[i]) ?? null;
  } else {
    rawScoreOf = (i) => data.values[i];
  }

  // Null-score ("no data") and comparator policy lives in `selectRankedIndices`, shared with
  // the two sibling `applyRankTo*` functions.
  const keepIndices = selectRankedIndices(data.labels.length, rawScoreOf, dir, n);
  const keepMask = data.labels.map((_, i) => keepIndices.has(i));
  return {
    labels: data.labels.filter((_, i) => keepMask[i]),
    values: data.values.filter((_, i) => keepMask[i]),
  };
}

/** `rankMultiSeriesBy` sentinels → the cross-series reduction they select. */
const MULTI_SERIES_RANK_FNS = {
  __sum: 'sum',
  __avg: 'avg',
  __min: 'min',
  __max: 'max',
} as const;

/**
 * Apply a rank filter to multi-series aggregated data.
 * Ranking score per label is computed according to `rankFilter.rankMultiSeriesBy`:
 * - `undefined` / `'__sum'`: sum of all series values (default)
 * - `'__avg'`: average across all series
 * - `'__max'`: maximum value across all series
 * - `'__min'`: minimum value across all series
 * - `<fieldId>`: use only the series with that fieldId
 *
 * Every reduction runs over the label's NON-NULL cells only, and a label whose every series
 * is null scores `null` — "no data", which loses in both directions (see
 * {@link selectRankedIndices}). Filling nulls in per-reduction (`?? 0` for sum/avg,
 * `?? ±Infinity` for min/max) is what let a category with no rows at all win a `'__min'`
 * top-1 outright, displacing the only category that had data (H4).
 */
export function applyRankToMultiSeries(
  data: MultiYSeriesData,
  rankFilter: StudioFilterState | null,
): MultiYSeriesData {
  if (!rankFilter) {
    return data;
  }
  const n = Math.round(Number(rankFilter.value));
  if (!Number.isFinite(n) || n <= 0) {
    return data;
  }
  const dir = rankFilter.rankDirection ?? 'top';
  const rankBy = rankFilter.rankMultiSeriesBy ?? '__sum';

  const reduction: 'sum' | 'avg' | 'min' | 'max' | undefined =
    rankBy in MULTI_SERIES_RANK_FNS
      ? MULTI_SERIES_RANK_FNS[rankBy as keyof typeof MULTI_SERIES_RANK_FNS]
      : undefined;
  // rank by a specific series fieldId when `rankBy` is not one of the sentinels.
  // NOTE: matches on `fieldId` alone and takes the FIRST match. For blended mixed charts two
  // series can legitimately share a `fieldId` while originating from different sources (see
  // `MultiYSeriesData.series[].sourceId`), so this conflates them — the first source's values
  // drive the rank score for both. `rankMultiSeriesBy` is a bare fieldId with no source
  // component, so a full fix needs a `(fieldId, sourceId)` rank-target model extension; until
  // then the first-match behavior is intentional and documented (finding 3.4).
  const rankSeries = reduction ? undefined : data.series.find((s) => s.fieldId === rankBy);

  const rawScoreOf = (i: number): number | null => {
    if (reduction) {
      return reduceRankScore(
        data.series.map((s) => s.values[i]),
        reduction,
      );
    }
    // An unknown fieldId (or a null cell in the named series) is absence of a score, not 0.
    return rankSeries ? (rankSeries.values[i] ?? null) : null;
  };

  const keepIndices = selectRankedIndices(data.labels.length, rawScoreOf, dir, n);
  const keepMask = data.labels.map((_, i) => keepIndices.has(i));
  return {
    labels: data.labels.filter((_, i) => keepMask[i]),
    series: data.series.map((s) => ({
      ...s,
      values: s.values.filter((_, i) => keepMask[i]),
    })),
  };
}

/**
 * Apply a rank filter to seriesField aggregated data (MultiSeriesData).
 * Ranks the series dimension (e.g. countries) by their total value across all x-labels,
 * and keeps the top/bottom N series.
 *
 * The total skips null cells rather than adding 0 for them, and a series that is null at every
 * label scores `null` — "no data", which loses in both directions (see
 * {@link selectRankedIndices}). Summing nulls as 0 gave an empty series a 0 total that
 * outranked a genuinely negative one in a bottom-N (H4).
 */
export function applyRankToSeriesFieldData(
  data: MultiSeriesData,
  rankFilter: StudioFilterState | null,
): MultiSeriesData {
  if (!rankFilter) {
    return data;
  }
  const n = Math.round(Number(rankFilter.value));
  if (!Number.isFinite(n) || n <= 0) {
    return data;
  }
  const dir = rankFilter.rankDirection ?? 'top';
  const { seriesNames } = data;
  const keepIndices = selectRankedIndices(
    seriesNames.length,
    (i) => reduceRankScore(data.seriesData[seriesNames[i]] ?? [], 'sum'),
    dir,
    n,
  );
  // `seriesNames` may hold genuine numbers (numeric split-by values survive as numbers
  // through `toXValue`), but `Object.entries(seriesData)` keys are always strings. Coerce
  // both sides to a string before the membership test so a numeric `2024` matches its
  // string `"2024"` `seriesData` key — otherwise the series' data column is dropped and the
  // renderers crash reading `undefined` (finding 1.13).
  const keepNames = new Set(
    seriesNames.filter((_, i) => keepIndices.has(i)).map((name) => String(name)),
  );
  return {
    labels: data.labels,
    seriesNames: data.seriesNames.filter((name) => keepNames.has(String(name))),
    seriesData: Object.fromEntries(
      Object.entries(data.seriesData).filter(([name]) => keepNames.has(name)),
    ),
  };
}

/**
 * Reorder `labels` (assumed already naturally sorted) according to the chart's
 * sort settings. Extracted so the four generic aggregators share one ordering
 * implementation instead of copy-pasting the value/categoryOrder/desc branches.
 *
 * Priority: `sortBy: 'value'` (needs `valueOf`) > `categoryOrder` > `sortDirection`.
 * Always returns a new array; never mutates the input.
 *
 * - `'value'` — sort by `valueOf(label)`; ascending when `sortDirection === 'asc'`,
 *   otherwise descending (the default for value sorts). A `null` value ("no data") sorts
 *   LAST in either direction — treating it as 0 let an all-null bucket lead a descending
 *   sort over real negative values, or a bucket with nothing in it lead an ascending one (H4).
 * - `categoryOrder` — labels present in `categoryOrder` come first in that order,
 *   remaining labels appended alphabetically; the whole list is reversed for `'desc'`.
 * - otherwise — natural order, reversed only when `sortDirection === 'desc'`.
 */
function orderLabels(
  labels: (string | number)[],
  opts: {
    sortBy?: 'category' | 'value' | 'natural';
    sortDirection?: 'asc' | 'desc';
    categoryOrder?: string[];
    valueOf?: (label: string | number) => number | null;
  },
): (string | number)[] {
  const { sortBy, sortDirection, categoryOrder, valueOf } = opts;

  if (sortBy === 'value' && valueOf) {
    const dir = sortDirection === 'asc' ? 1 : -1;
    return labels
      .map((label) => ({ label, value: valueOf(label) }))
      .sort((a, b) => {
        if (a.value === null || b.value === null) {
          if (a.value === b.value) {
            return 0;
          }
          return a.value === null ? 1 : -1;
        }
        return (a.value - b.value) * dir;
      })
      .map((p) => p.label);
  }

  if (categoryOrder && categoryOrder.length > 0) {
    const orderMap = new Map(categoryOrder.map((v, i) => [v, i]));
    const sorted = [...labels].sort((a, b) => {
      const ai = orderMap.get(String(a)) ?? Infinity;
      const bi = orderMap.get(String(b)) ?? Infinity;
      if (ai !== bi) {
        return ai - bi;
      }
      // Both absent from orderMap — sort alphabetically
      return String(a).localeCompare(String(b));
    });
    if (sortDirection === 'desc') {
      sorted.reverse();
    }
    return sorted;
  }

  if (sortDirection === 'desc') {
    return [...labels].reverse();
  }

  return labels;
}

/**
 * Per-cell streaming accumulator shared by the multi-series aggregators. Backed by
 * the shared {@link AggregateAccumulator} so the chart aggregators, the pivot
 * matrix and the KPI/map reducers all apply one null/boolean-coercion policy.
 */
type CellAcc = AggregateAccumulator;

/** Fold `value` into the accumulator stored at `key`, creating it on first sight. */
function accumulateCell<K>(map: Map<K, CellAcc>, key: K, value: number): void {
  let acc = map.get(key);
  if (!acc) {
    acc = createAggregateAccumulator();
    map.set(key, acc);
  }
  accumulateValue(acc, value);
}

/**
 * Reduce a per-cell accumulator to a single value according to `aggregation`.
 * Returns `null` for an empty cell so callers can distinguish "no data" from 0.
 */
const finalizeCell = finalizeAccumulator;

/**
 * Pre-detect whether `yField` on `rows` should be aggregated as configured
 * (`yAggregation`) or downgraded to `'count'` because the field is entirely
 * non-numeric (e.g. a string ID) on this row set. Treats the field as numeric if
 * ANY non-null value coerces to a number — not just the first (a leading
 * "N/A"/"—" sentinel ahead of real numbers must not downgrade a configured
 * sum/avg to a row count). Reuses `coerceAggregateValue` so this agrees with the
 * accumulation loop in `aggregateByField`.
 *
 * Exported so callers that pair a FILTERED aggregation with a BASELINE (ghost)
 * aggregation of the same field/rows-minus-filter can detect the aggregation
 * type ONCE — typically from the baseline, which has the fuller picture — and
 * pass the SAME type to both `aggregateByField` calls via its `forcedAggregation`
 * parameter. Detecting independently per-subset let the ghost tooltip compare a
 * `'count'` (filtered subset that happened to be empty/all-non-numeric) against a
 * `'sum'` (baseline with real numeric values) (finding 3).
 */
export function detectAggregationType(
  rows: Row[],
  yField: string,
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
): 'sum' | 'count' | 'avg' | 'min' | 'max' {
  if (yAggregation === 'count') {
    return 'count';
  }
  let sawNonNull = false;
  let sawNumeric = false;
  for (const row of rows) {
    const v = row[yField];
    if (v !== null && v !== undefined) {
      sawNonNull = true;
      if (coerceAggregateValue(v) !== null) {
        sawNumeric = true;
        break;
      }
    }
  }
  return sawNonNull && !sawNumeric ? 'count' : yAggregation;
}

export function aggregateByField(
  rows: Row[],
  xField: string,
  yField: string,
  xGroupBy?: XGroupBy,
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
  /**
   * Locale text bundle used to resolve the translated empty-category bucket label
   * (`chartEmptyCategoryLabel`) — threaded through to `toXValue` so a non-English locale
   * doesn't fall back to the English `'(empty)'` literal (T3.2). Note `isEmptyXValue`
   * deliberately takes no locale: it inspects RAW row values, where matching the bucket
   * label could only ever be a false positive (M8).
   *
   * On the **x** dimension this argument resolves nothing today, and that is by design rather
   * than by omission: the `isEmptyXValue` guard above the `toXValue` call drops every empty x
   * value first, so `toXValue`'s empty-bucket branch is unreachable from here. It is live only
   * where a dimension KEEPS its empties — `aggregateByTwoFields`' `seriesField` and scatter's
   * color field. `chartValues.isEmptyXValue` documents why the two dimensions differ and what
   * it costs (chart totals can fall short of a KPI over the same rows); the argument stays so
   * the guard-then-convert pair is spelled identically at every x call site.
   */
  localeText?: Partial<StudioLocaleText>,
  /**
   * When supplied, used verbatim as the effective aggregation instead of
   * re-running `detectAggregationType` against `rows`. Pass this — computed once
   * from the baseline row set — from a caller that also aggregates a FILTERED
   * subset of the same rows/field, so a ghost (baseline-vs-filtered) comparison
   * never mismatches sum vs. count between the two (finding 3).
   */
  forcedAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max',
): AggregatedData {
  // Row counts per x-value (drive the 'count' aggregation and define the label set).
  const counts = new Map<string | number, number>();
  // Per-x-value streaming accumulators for sum/avg/min/max (shared null-skip policy).
  const accumulators = new Map<string | number, CellAcc>();

  const effectiveAggregation =
    forcedAggregation ?? detectAggregationType(rows, yField, yAggregation);

  for (const row of rows) {
    // Axis-dimension policy: an empty x DROPS the row rather than bucketing it under
    // `(empty)` — so these counts can total less than a KPI over the same rows. See
    // `chartValues.isEmptyXValue` for why, and why a SPLIT dimension does the opposite.
    if (isEmptyXValue(row[xField])) {
      continue;
    }
    const raw = toXValue(row[xField], localeText);
    const xVal = applyXGroupBy(raw, xGroupBy);
    counts.set(xVal, (counts.get(xVal) ?? 0) + 1);

    if (effectiveAggregation !== 'count') {
      // Route through the shared coercion policy: null/undefined/non-numeric values
      // are skipped (not coerced to 0), so they no longer inflate avg denominators or
      // drag min toward 0 (finding 1.4). Booleans coerce to 0/1.
      const coerced = coerceAggregateValue(row[yField]);
      if (coerced !== null) {
        accumulateCell(accumulators, xVal, coerced);
      }
    }
  }

  const valueFor = (label: string | number): number | null => {
    if (effectiveAggregation === 'count') {
      return counts.get(label) ?? 0;
    }
    // `null`, not `?? 0`: a bucket whose measures are ALL null/non-numeric has no
    // aggregate. Coercing it to 0 plotted an all-null Oslo temperature at 0 °C above a
    // real −4 °C Rome, and promoted it to first place under `chartSortBy: 'value'` or a
    // Top-N rank (H4). Callers render `null` as a gap.
    return finalizeCell(accumulators.get(label), effectiveAggregation);
  };

  // Labels come from every x-value that had at least one (non-empty-x) row, so an
  // x-value whose measure is entirely null still appears on the axis — carrying a `null`
  // value (a visible gap) rather than a fabricated 0.
  const labels = orderLabels(sortLabels(Array.from(counts.keys())), {
    sortBy,
    sortDirection,
    categoryOrder,
    valueOf: (label) => valueFor(label),
  });
  const values = labels.map((label) => valueFor(label));

  return { labels, values };
}

/**
 * Aggregate data by two fields: one for x-axis labels, one for series grouping
 */
export function aggregateByTwoFields(
  rows: Row[],
  xField: string,
  seriesField: string,
  yField: string,
  xGroupBy?: XGroupBy,
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
  /** See {@link aggregateByField}'s `localeText` param (T3.2). */
  localeText?: Partial<StudioLocaleText>,
): MultiSeriesData {
  // First pass: collect all unique x values and series values
  const xValuesSet = new Set<string | number>();
  const seriesValuesSet = new Set<string | number>();

  // Map: xValue -> seriesValue -> per-cell accumulator (sum/count/min/max).
  const dataMap = new Map<string | number, Map<string | number, CellAcc>>();

  // Pre-detect: if the yField is non-numeric (e.g. a string ID), fall back to
  // count so callers that omit yAggregation (or misconfigure it for a
  // non-numeric measure) get row counts instead of every cell rendering
  // `null` (blank chart) — mirrors the pre-detect `aggregateByField` and
  // `aggregateMultipleSeries` already apply (finding 2.4). Treat the field as
  // numeric if ANY non-null value coerces to a number (not just the first), so a
  // leading "N/A"/"—" sentinel ahead of real numbers doesn't downgrade a configured
  // sum/avg to a row count; reuse the row loop's `coerceAggregateValue` for consistency.
  let effectiveAggregation = yAggregation;
  if (effectiveAggregation !== 'count') {
    let sawNonNull = false;
    let sawNumeric = false;
    for (const row of rows) {
      const v = row[yField];
      if (v !== null && v !== undefined) {
        sawNonNull = true;
        if (coerceAggregateValue(v) !== null) {
          sawNumeric = true;
          break;
        }
      }
    }
    if (sawNonNull && !sawNumeric) {
      effectiveAggregation = 'count';
    }
  }

  for (const row of rows) {
    // The two dimensions of this ONE chart deliberately treat empties differently: the x
    // (axis) dimension drops the row, the `seriesField` (split) dimension keeps it under
    // `(empty)`. `chartValues.isEmptyXValue` states the rule and the reasoning for both.
    if (isEmptyXValue(row[xField])) {
      continue;
    }
    const raw = toXValue(row[xField], localeText);
    const xVal = applyXGroupBy(raw, xGroupBy);
    // Split dimension — `localeText` IS live here (a null series value becomes `(empty)`).
    const seriesVal = toXValue(row[seriesField], localeText);

    xValuesSet.add(xVal);
    seriesValuesSet.add(seriesVal);

    let seriesMap = dataMap.get(xVal);
    if (!seriesMap) {
      seriesMap = new Map();
      dataMap.set(xVal, seriesMap);
    }
    if (effectiveAggregation === 'count') {
      // 'count' tallies rows regardless of the measure value (null rows included),
      // matching the KPI reference; the accumulated value is irrelevant.
      accumulateCell(seriesMap, seriesVal, 1);
    } else {
      // Route through the shared coercion policy so null/undefined/non-numeric values
      // are skipped rather than coerced to 0 (finding 1.4).
      const coerced = coerceAggregateValue(row[yField]);
      if (coerced !== null) {
        accumulateCell(seriesMap, seriesVal, coerced);
      }
    }
  }

  const seriesNames = sortLabels(Array.from(seriesValuesSet));

  // Resolve a single cell to its aggregated value; `null` when the cell has no
  // data so line/area charts render visible gaps instead of collapsing to zero.
  const cellValue = (label: string | number, seriesName: string | number): number | null =>
    finalizeCell(dataMap.get(label)?.get(seriesName), effectiveAggregation);

  const labels = orderLabels(sortLabels(Array.from(xValuesSet)), {
    sortBy,
    sortDirection,
    categoryOrder,
    // For multi-series, 'value' sorts by the total across all series.
    valueOf: (label) =>
      seriesNames.reduce<number>((sum, seriesName) => sum + (cellValue(label, seriesName) ?? 0), 0),
  });

  const seriesData: Record<string | number, (number | null)[]> = {};
  for (const seriesName of seriesNames) {
    seriesData[seriesName] = labels.map((label) => cellValue(label, seriesName));
  }

  return { labels, seriesNames, seriesData };
}

export function aggregateMultipleSeries(
  rows: Row[],
  xField: string,
  yFields: string[],
  xGroupBy?: XGroupBy,
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
  /**
   * Per-series aggregation. Accepts either a single fn applied to every field
   * (back-compat with callers that aggregate uniformly), or a `fieldId → fn` map
   * so each series honours its own `StudioChartSeries.yAggregation` (finding 1.4).
   * Fields absent from the map default to `'sum'`.
   */
  yAggregation: ChartAggFn | Record<string, ChartAggFn> = 'sum',
  /** See {@link aggregateByField}'s `localeText` param (T3.2). */
  localeText?: Partial<StudioLocaleText>,
): MultiYSeriesData {
  // Pre-detect non-numeric fields so callers that omit yAggregation don't get NaN.
  // A non-numeric field is always aggregated as a count regardless of yAggregation.
  // Treat a field as numeric if ANY non-null value coerces to a number (not just the
  // first), so a leading "N/A"/"—" sentinel ahead of real numbers doesn't downgrade a
  // configured sum/avg to a row count; reuse the row loop's `coerceAggregateValue` so
  // the pre-detect and accumulation agree.
  const useCount = new Set<string>();
  for (const fieldId of yFields) {
    let sawNonNull = false;
    let sawNumeric = false;
    for (const row of rows) {
      const v = row[fieldId];
      if (v !== null && v !== undefined) {
        sawNonNull = true;
        if (coerceAggregateValue(v) !== null) {
          sawNumeric = true;
          break;
        }
      }
    }
    if (sawNonNull && !sawNumeric) {
      useCount.add(fieldId);
    }
  }

  const configuredAggregation = (fieldId: string): ChartAggFn =>
    typeof yAggregation === 'string' ? yAggregation : (yAggregation[fieldId] ?? 'sum');

  const fieldAggregation = (fieldId: string): ChartAggFn =>
    useCount.has(fieldId) ? 'count' : configuredAggregation(fieldId);

  // Resolve each field's aggregation once so the row loop can decide per field whether
  // to count every row or to skip null/non-numeric values (finding 1.4).
  const aggByField = new Map<string, ChartAggFn>(
    yFields.map((fieldId) => [fieldId, fieldAggregation(fieldId)]),
  );

  const labelOrder: (string | number)[] = [];
  const labelSet = new Set<string | number>();
  // Map: label → fieldId → per-cell accumulator (sum/count/min/max).
  const dataMap = new Map<string | number, Map<string, CellAcc>>();

  for (const row of rows) {
    // Axis-dimension policy — empty x drops the row (see `chartValues.isEmptyXValue`).
    if (isEmptyXValue(row[xField])) {
      continue;
    }
    const raw = toXValue(row[xField], localeText);
    const xVal = applyXGroupBy(raw, xGroupBy);
    if (!labelSet.has(xVal)) {
      labelSet.add(xVal);
      labelOrder.push(xVal);
      dataMap.set(xVal, new Map());
    }
    const fieldMap = dataMap.get(xVal)!;
    for (const fieldId of yFields) {
      if (aggByField.get(fieldId) === 'count') {
        // 'count' tallies rows (null rows included); the value is irrelevant.
        accumulateCell(fieldMap, fieldId, 1);
      } else {
        // Skip null/undefined/non-numeric values instead of coercing them to 0.
        const coerced = coerceAggregateValue(row[fieldId]);
        if (coerced !== null) {
          accumulateCell(fieldMap, fieldId, coerced);
        }
      }
    }
  }

  // `null` when the (label, field) cell has no data — a y-field that is absent from every
  // row at this label, or whose values are all null/non-numeric. Previously `?? 0`, which
  // drew a real bar/point at zero for a measure that simply doesn't exist there (H4).
  const cellValue = (label: string | number, fieldId: string): number | null =>
    finalizeCell(dataMap.get(label)?.get(fieldId), fieldAggregation(fieldId));

  const sortedLabels = orderLabels(sortLabels(labelOrder), {
    sortBy,
    sortDirection,
    categoryOrder,
    // A 'value' sort ranks by the label's cross-series TOTAL, where a no-data cell
    // contributes nothing — so `?? 0` is the correct identity for this sum specifically.
    valueOf: (label) => yFields.reduce((sum, fId) => sum + (cellValue(label, fId) ?? 0), 0),
  });

  const series = yFields.map((fieldId) => ({
    fieldId,
    values: sortedLabels.map((label) => cellValue(label, fieldId)),
  }));

  return { labels: sortedLabels, series };
}

/**
 * One series for {@link aggregateBlendedSeries}. Each carries its own already-resolved
 * `rows` so the series can originate from a different data source than its siblings.
 */
export interface BlendedSeriesInput {
  /** Field id aggregated for this series (within its own `rows`). */
  fieldId: string;
  /**
   * The series' resolved source id (callers should default this to the widget's
   * primary source when the series config omits one, mirroring the `rows` fallback).
   * Threaded through to the output so two series sharing a `fieldId` across
   * different sources can be told apart downstream (finding 2.12) — matching on
   * `fieldId` alone conflates them. Optional only for callers that don't need
   * source-aware disambiguation (e.g. direct aggregator tests).
   */
  sourceId?: string;
  /** Rows for this series, already filtered/resolved from its own source. */
  rows: Row[];
  /** Per-series aggregation. @default 'sum' */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
}

/**
 * Aggregate several series that may originate from DIFFERENT data sources onto a
 * single shared categorical x-axis ("data blending"). Each series is aggregated
 * independently within its own `rows` by `xField`, then all series are aligned on
 * the union of category labels (outer join). Missing category/series combinations are
 * filled with `null` — "this source has no row in this category" is absence of data, not
 * a measured zero — matching {@link aggregateMultipleSeries} (H4).
 *
 * Unlike {@link aggregateMultipleSeries}, the returned `series` preserve the input
 * order and count 1:1 (no de-duplication by `fieldId`), so two series sharing a
 * field id across different sources remain distinct.
 */
export function aggregateBlendedSeries(
  series: BlendedSeriesInput[],
  xField: string,
  xGroupBy?: XGroupBy,
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
  /** See {@link aggregateByField}'s `localeText` param (T3.2). */
  localeText?: Partial<StudioLocaleText>,
): MultiYSeriesData {
  // Aggregate each series within its own rows (independent grain per source).
  const perSeries = series.map((s) =>
    aggregateByField(
      s.rows,
      xField,
      s.fieldId,
      xGroupBy,
      s.yAggregation,
      undefined,
      undefined,
      undefined,
      localeText,
    ),
  );

  // Per-series label → value maps, plus the union of labels in first-seen order.
  const seen = new Set<string | number>();
  const union: (string | number)[] = [];
  const valueMaps = perSeries.map((agg) => {
    const m = new Map<string | number, number | null>();
    agg.labels.forEach((label, i) => {
      m.set(label, agg.values[i]);
      if (!seen.has(label)) {
        seen.add(label);
        union.push(label);
      }
    });
    return m;
  });

  // Order labels consistently with the other aggregators.
  const sortedLabels = orderLabels(sortLabels(union), {
    sortBy,
    sortDirection,
    categoryOrder,
    // As in `aggregateMultipleSeries`, a 'value' sort ranks by the cross-series total, so
    // a no-data cell contributes nothing to that particular sum.
    valueOf: (label) => valueMaps.reduce((sum, m) => sum + (m.get(label) ?? 0), 0),
  });

  return {
    labels: sortedLabels,
    series: series.map((s, i) => ({
      fieldId: s.fieldId,
      sourceId: s.sourceId,
      // `?? null` — an outer-joined label this series' source has no row for is missing
      // data, not a zero. `Map.get` already returns `undefined` for an absent label; the
      // coalesce normalises it to the `null` the type promises (H4).
      values: sortedLabels.map((label) => valueMaps[i].get(label) ?? null),
    })),
  };
}
