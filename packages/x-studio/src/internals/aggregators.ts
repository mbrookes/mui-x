import type { StudioExpressionField, StudioFilterState } from '../models';
import { sortLabels, type XGroupBy } from './temporalUtils';
import { applyXGroupBy, isEmptyXValue, toXValue } from './chartValues';
import type { StudioLocaleText } from './localeText';
import {
  accumulateValue,
  coerceAggregateValue,
  compareRankScores,
  createAggregateAccumulator,
  finalizeAccumulator,
  findMeasureExpressionField,
  reduceRankScore,
  resolveMeasureAggregate,
  type AggregateAccumulator,
  type RankDirection,
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

/**
 * Pick the indices of the `n` best-ranked candidates out of `count`, scoring each through
 * `rawScoreOf`. The one place the POST-AGGREGATION rank ordering lives, shared by all three
 * `applyRankTo*` entry points so a Top-N behaves identically whatever shape the data has.
 *
 * Scoring (`reduceRankScore`) and ordering (`compareRankScores`) themselves live in
 * `internals/aggregate.ts`, shared with the ROW-LEVEL rank filter in `filterUtils.ts` so the
 * two paths can no longer disagree about what a no-data candidate is worth.
 * A `null` score means "no data", not "zero": such a candidate must never win a slot in a
 * Top-N or a Bottom-N, so it loses in EITHER direction.
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
  const indices = Array.from({ length: count }, (_, i) => i);
  indices.sort((a, b) => compareRankScores(rawScoreOf(a), rawScoreOf(b), dir));
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
 * non-ghost aggregations. Ranking selects WHICH categories survive; the caller's
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
   * with grid/KPI/map/pivot widgets on an identical rank filter. Ignored when
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
  // then the first-match behavior is intentional and documented.
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
  // renderers crash reading `undefined`.
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
 * `'sum'` (baseline with real numeric values).
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

/**
 * {@link detectAggregationType} for a whole multi-Y series set, returning the `fieldId → fn`
 * map {@link aggregateMultipleSeries} accepts as its `forcedAggregation`.
 *
 * Exists for the same reason the single-field version is exported: a caller that pairs a
 * FILTERED aggregation with a BASELINE (ghost) one must detect ONCE — from the baseline, which
 * has the fuller picture — and hand the SAME map to both calls. Detecting independently per
 * subset let a cross-filtered subset whose y values are all sentinel strings downgrade to
 * `'count'` while the baseline stayed `'sum'`, drawing row-count bars against a sum-valued
 * ghost.
 */
export function detectAggregationTypeByField(
  rows: Row[],
  yFields: string[],
  yAggregation: ChartAggFn | Record<string, ChartAggFn> = 'sum',
): Record<string, ChartAggFn> {
  const out: Record<string, ChartAggFn> = {};
  for (const fieldId of yFields) {
    out[fieldId] = detectAggregationType(
      rows,
      fieldId,
      typeof yAggregation === 'string' ? yAggregation : (yAggregation[fieldId] ?? 'sum'),
    );
  }
  return out;
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
   * doesn't fall back to the English `'(empty)'` literal. Note `isEmptyXValue`
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
   * never mismatches sum vs. count between the two.
   */
  forcedAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max',
  /**
   * The dashboard's expression fields, so a MEASURE y field can be evaluated.
   *
   * A measure (`isMeasure: true`) has NO per-row value — `enrichRowsWithExpressions` deliberately
   * excludes measures from row enrichment, so `row[measureId]` is `undefined` on every row.
   * Reading it per-row made `detectAggregationType` see nothing, keep `'sum'`, and finalize an
   * empty accumulator, so a chart with a measure on its Y axis plotted confident zeros while the
   * KPI beside it — which calls `evaluateMeasure` over the whole row set — showed the right
   * number. When this is supplied and `yField` resolves to a measure, each bucket keeps its ROWS
   * and the measure is evaluated over them via the shared `resolveMeasureAggregate`, mirroring
   * `pivotUtils.buildMeasurePivotMatrix`. Omit it (or pass a list without the field) and the
   * aggregator behaves exactly as before.
   *
   * `'count'` is unaffected: it tallies rows and ignores the measure entirely, here as everywhere
   * else (see `internals/aggregate.ts`'s `AggregateFn`).
   */
  expressionFields?: StudioExpressionField[],
): AggregatedData {
  // Row counts per x-value (drive the 'count' aggregation and define the label set).
  const counts = new Map<string | number, number>();
  // Per-x-value streaming accumulators for sum/avg/min/max (shared null-skip policy).
  const accumulators = new Map<string | number, CellAcc>();

  const effectiveAggregation =
    forcedAggregation ?? detectAggregationType(rows, yField, yAggregation);

  // A MEASURE y field has no per-row value (see the `expressionFields` param), so its buckets
  // keep the contributing ROWS and evaluate the measure over each bucket at the end.
  const isMeasure =
    effectiveAggregation !== 'count' &&
    findMeasureExpressionField(yField, expressionFields) !== undefined;
  const measureRows = isMeasure ? new Map<string | number, Row[]>() : undefined;

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

    if (measureRows) {
      const bucket = measureRows.get(xVal);
      if (bucket) {
        bucket.push(row);
      } else {
        measureRows.set(xVal, [row]);
      }
    } else if (effectiveAggregation !== 'count') {
      // Route through the shared coercion policy: null/undefined/non-numeric values
      // are skipped (not coerced to 0), so they no longer inflate avg denominators or
      // drag min toward 0. Booleans coerce to 0/1.
      const coerced = coerceAggregateValue(row[yField]);
      if (coerced !== null) {
        accumulateCell(accumulators, xVal, coerced);
      }
    }
  }

  // Memoized per label: a `sortBy: 'value'` ordering calls `valueFor` from inside the sort
  // comparator, so an un-memoized measure evaluation would re-walk each bucket's rows
  // O(n log n) times.
  const measureValues = measureRows ? new Map<string | number, number | null>() : undefined;

  const valueFor = (label: string | number): number | null => {
    if (effectiveAggregation === 'count') {
      return counts.get(label) ?? 0;
    }
    if (measureRows && measureValues) {
      if (!measureValues.has(label)) {
        measureValues.set(
          label,
          resolveMeasureAggregate(measureRows.get(label) ?? [], yField, expressionFields!),
        );
      }
      return measureValues.get(label)!;
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
  /** See {@link aggregateByField}'s `localeText` param. */
  localeText?: Partial<StudioLocaleText>,
  /**
   * See {@link aggregateByField}'s `forcedAggregation` param. The split-by
   * family needs this for exactly the same reason the single-series one does: `seriesFieldData`
   * (filtered) and `allSeriesFieldData` (baseline ghost) are two calls over different row sets,
   * and detecting independently let a cross-filtered subset whose y values are all sentinel
   * strings downgrade to `'count'` while the baseline stayed `'sum'` — foreground bars drawn as
   * row counts against a sum-valued ghost.
   */
  forcedAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max',
  /** See {@link aggregateByField}'s `expressionFields` param — enables a MEASURE `yField`. */
  expressionFields?: StudioExpressionField[],
): MultiSeriesData {
  // First pass: collect all unique x values and series values
  const xValuesSet = new Set<string | number>();
  const seriesValuesSet = new Set<string | number>();

  // Map: xValue -> seriesValue -> per-cell accumulator (sum/count/min/max).
  const dataMap = new Map<string | number, Map<string | number, CellAcc>>();

  // Detected ONCE, through the SAME shared `detectAggregationType` the other two aggregators
  // use — this used to be a hand-copied inline duplicate with no `forcedAggregation` override.
  // It falls back to `'count'` when the yField is entirely non-numeric on this
  // row set, so a string measure renders row counts rather than a blank chart.
  const effectiveAggregation =
    forcedAggregation ?? detectAggregationType(rows, yField, yAggregation);

  // A MEASURE yField has no per-row value; buckets keep their ROWS instead. See
  // {@link aggregateByField}'s `expressionFields` param.
  const isMeasure =
    effectiveAggregation !== 'count' &&
    findMeasureExpressionField(yField, expressionFields) !== undefined;
  const measureRows = isMeasure
    ? new Map<string | number, Map<string | number, Row[]>>()
    : undefined;

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
    if (measureRows) {
      let cellMap = measureRows.get(xVal);
      if (!cellMap) {
        cellMap = new Map();
        measureRows.set(xVal, cellMap);
      }
      const bucket = cellMap.get(seriesVal);
      if (bucket) {
        bucket.push(row);
      } else {
        cellMap.set(seriesVal, [row]);
      }
    } else if (effectiveAggregation === 'count') {
      // 'count' tallies rows regardless of the measure value (null rows included),
      // matching the KPI reference; the accumulated value is irrelevant.
      accumulateCell(seriesMap, seriesVal, 1);
    } else {
      // Route through the shared coercion policy so null/undefined/non-numeric values
      // are skipped rather than coerced to 0.
      const coerced = coerceAggregateValue(row[yField]);
      if (coerced !== null) {
        accumulateCell(seriesMap, seriesVal, coerced);
      }
    }
  }

  const seriesNames = sortLabels(Array.from(seriesValuesSet));

  // Memoized per (label, series) — a `sortBy: 'value'` ordering totals every cell of a label
  // from inside the sort comparator, so an un-memoized measure evaluation would re-walk each
  // cell's rows O(n log n) times.
  // Nested (not a joined string key) so two different (label, series) pairs can never collide.
  const measureValues = measureRows
    ? new Map<string | number, Map<string | number, number | null>>()
    : undefined;

  // Resolve a single cell to its aggregated value; `null` when the cell has no
  // data so line/area charts render visible gaps instead of collapsing to zero.
  const cellValue = (label: string | number, seriesName: string | number): number | null => {
    if (measureRows && measureValues) {
      let cached = measureValues.get(label);
      if (!cached) {
        cached = new Map();
        measureValues.set(label, cached);
      }
      if (!cached.has(seriesName)) {
        const bucket = measureRows.get(label)?.get(seriesName);
        cached.set(
          seriesName,
          bucket ? resolveMeasureAggregate(bucket, yField, expressionFields!) : null,
        );
      }
      return cached.get(seriesName)!;
    }
    return finalizeCell(dataMap.get(label)?.get(seriesName), effectiveAggregation);
  };

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
   * so each series honours its own `StudioChartSeries.yAggregation`.
   * Fields absent from the map default to `'sum'`.
   */
  yAggregation: ChartAggFn | Record<string, ChartAggFn> = 'sum',
  /** See {@link aggregateByField}'s `localeText` param. */
  localeText?: Partial<StudioLocaleText>,
  /**
   * Per-field effective aggregations, used verbatim instead of re-running
   * {@link detectAggregationTypeByField} against `rows` — the multi-Y equivalent of
   * {@link aggregateByField}'s `forcedAggregation`. Compute it ONCE from the
   * baseline row set (see {@link detectAggregationTypeByField}) and pass the same map to both
   * the filtered (`multiYData`) and baseline (`allMultiYData`) calls, so a cross-filtered subset
   * whose values are all sentinel strings can't downgrade to `'count'` while the baseline stays
   * `'sum'`. Fields absent from the map fall back to per-call detection.
   */
  forcedAggregation?: Record<string, ChartAggFn>,
  /** See {@link aggregateByField}'s `expressionFields` param — enables MEASURE `yFields`. */
  expressionFields?: StudioExpressionField[],
): MultiYSeriesData {
  // Resolve each field's aggregation ONCE, through the SAME shared `detectAggregationType` the
  // other two aggregators use — this used to be a hand-copied inline duplicate with no
  // `forcedAggregation` override. A field that is entirely non-numeric on this row
  // set falls back to `'count'` so callers that omit `yAggregation` don't get a blank chart.
  const aggByField = new Map<string, ChartAggFn>(
    yFields.map((fieldId) => [
      fieldId,
      forcedAggregation?.[fieldId] ??
        detectAggregationType(
          rows,
          fieldId,
          typeof yAggregation === 'string' ? yAggregation : (yAggregation[fieldId] ?? 'sum'),
        ),
    ]),
  );
  const fieldAggregation = (fieldId: string): ChartAggFn => aggByField.get(fieldId) ?? 'sum';

  // MEASURE y fields have no per-row value; their buckets keep the contributing ROWS instead.
  // See {@link aggregateByField}'s `expressionFields` param.
  const measureFields = new Set(
    yFields.filter(
      (fieldId) =>
        fieldAggregation(fieldId) !== 'count' &&
        findMeasureExpressionField(fieldId, expressionFields) !== undefined,
    ),
  );

  const labelOrder: (string | number)[] = [];
  const labelSet = new Set<string | number>();
  // Map: label → fieldId → per-cell accumulator (sum/count/min/max).
  const dataMap = new Map<string | number, Map<string, CellAcc>>();
  // Map: label → contributing rows (only populated when at least one yField is a measure).
  const measureRows = measureFields.size > 0 ? new Map<string | number, Row[]>() : undefined;

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
    if (measureRows) {
      const bucket = measureRows.get(xVal);
      if (bucket) {
        bucket.push(row);
      } else {
        measureRows.set(xVal, [row]);
      }
    }
    const fieldMap = dataMap.get(xVal)!;
    for (const fieldId of yFields) {
      if (measureFields.has(fieldId)) {
        // Evaluated later, over the label's whole row bucket.
        continue;
      }
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

  // Memoized per (label, field) — a `sortBy: 'value'` ordering totals every series of a label
  // from inside the sort comparator, so an un-memoized measure evaluation would re-walk each
  // label's rows O(n log n) times. Nested maps, never a joined string key, so no pair collides.
  const measureValues = measureRows
    ? new Map<string | number, Map<string, number | null>>()
    : undefined;

  // `null` when the (label, field) cell has no data — a y-field that is absent from every
  // row at this label, or whose values are all null/non-numeric. Previously `?? 0`, which
  // drew a real bar/point at zero for a measure that simply doesn't exist there (H4).
  const cellValue = (label: string | number, fieldId: string): number | null => {
    if (measureFields.has(fieldId) && measureValues) {
      let cached = measureValues.get(label);
      if (!cached) {
        cached = new Map();
        measureValues.set(label, cached);
      }
      if (!cached.has(fieldId)) {
        cached.set(
          fieldId,
          resolveMeasureAggregate(measureRows?.get(label) ?? [], fieldId, expressionFields!),
        );
      }
      return cached.get(fieldId)!;
    }
    return finalizeCell(dataMap.get(label)?.get(fieldId), fieldAggregation(fieldId));
  };

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
   * different sources can be told apart downstream — matching on
   * `fieldId` alone conflates them. Optional only for callers that don't need
   * source-aware disambiguation (e.g. direct aggregator tests).
   */
  sourceId?: string;
  /** Rows for this series, already filtered/resolved from its own source. */
  rows: Row[];
  /** Per-series aggregation. @default 'sum' */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /**
   * Expression fields visible to THIS series, so a MEASURE `fieldId` can be evaluated over its
   * own source's row buckets. See {@link aggregateByField}'s `expressionFields` param.
   *
   * Per-series rather than one list for the whole call, because that is the only form that is
   * correct here: each blended series carries `rows` from a DIFFERENT source, and
   * `findMeasureExpressionField` matches on `id` alone. Handing every series the dashboard-wide
   * list would let a same-id measure defined on source A be evaluated against source B's rows —
   * a confident number computed from the wrong table. Callers should pass the measures owned by
   * `sourceId` (`expressionFields.filter((ef) => ef.sourceId === s.sourceId)`).
   *
   * Omit it and the series behaves exactly as before (a measure `fieldId` yields an all-`null`
   * series, since `row[measureId]` is `undefined` on every row).
   */
  expressionFields?: StudioExpressionField[];
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
 *
 * A MEASURE series is evaluated per bucket through each series' own
 * {@link BlendedSeriesInput.expressionFields} — the same shared `resolveMeasureAggregate` path the
 * non-blended aggregators use. Before that was threaded through, this function called
 * {@link aggregateByField} with no `expressionFields` at all, so a measure on a BLENDED mixed
 * chart resolved to `undefined` on every row and the series came back all-`null`: a blank series
 * where the identical measure on the same chart's non-blended sibling drew real values.
 */
export function aggregateBlendedSeries(
  series: BlendedSeriesInput[],
  xField: string,
  xGroupBy?: XGroupBy,
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
  /** See {@link aggregateByField}'s `localeText` param. */
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
      undefined,
      s.expressionFields,
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
