import { describe, expect, it } from 'vitest';
import {
  aggregateBlendedSeries,
  aggregateByField,
  aggregateByTwoFields,
  aggregateFunnelReached,
  aggregateHeatmap,
  aggregateMultipleSeries,
  aggregateSankey,
  analyzeChartSupport,
  buildFunnelStages,
  buildGanttItems,
  clampWidthPct,
  applyRankToAggregated,
  applyRankToMultiSeries,
  applyRankToSeriesFieldData,
  detectAggregationType,
  getChartSupportMessage,
  prepareScatterData,
  resolveChartRowsForAggregation,
} from './chartAggregation';
import type { MultiYSeriesData } from './chartAggregation';
import { enrichRowsWithRelatedFields } from './dataSourceGraph';
import type { StudioDataSource, StudioFilterState, StudioRelationship } from '../models';
import { frLocaleText } from '../locales/fr';

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    value: '',
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  } as StudioFilterState;
}

// ─── applyRankToAggregated ────────────────────────────────────────────────────

describe('applyRankToAggregated', () => {
  const data = {
    labels: ['A', 'B', 'C', 'D', 'E'],
    values: [10, 50, 30, 80, 20],
  };

  it('top 3 keeps the highest 3 values in ORIGINAL input order', () => {
    // Selects the top-3 categories (D=80, B=50, C=30) but returns them in their input order
    // (B, C, D) via a keep-mask, matching `applyRankToMultiSeries`/`applyRankToSeriesFieldData`.
    // Ranking chooses WHICH survive; the caller's `chartSortBy`/`orderedValues` owns the order
    // (finding 2.5).
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 3, rankDirection: 'top' }),
    );
    expect(result.labels).toEqual(['B', 'C', 'D']);
    expect(result.values).toEqual([50, 30, 80]);
  });

  it('bottom 2 keeps the lowest 2 values in ORIGINAL input order', () => {
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'bottom' }),
    );
    expect(result.labels).toEqual(['A', 'E']);
    expect(result.values).toEqual([10, 20]);
  });

  it('N >= length returns all data', () => {
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 10, rankDirection: 'top' }),
    );
    expect(result.labels).toHaveLength(5);
  });

  it('null filter returns original data', () => {
    const result = applyRankToAggregated(data, null);
    expect(result).toBe(data);
  });

  it('invalid N (zero) returns original data', () => {
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 0, rankDirection: 'top' }),
    );
    expect(result).toBe(data);
  });

  it('labels and values stay in sync after ranking', () => {
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top' }),
    );
    expect(result.labels.length).toBe(result.values.length);
    result.labels.forEach((label, i) => {
      const originalIndex = data.labels.indexOf(label as string);
      expect(result.values[i]).toBe(data.values[originalIndex]);
    });
  });

  it('preserves input order identically to applyRankToMultiSeries (single vs multi consistency)', () => {
    // The single-series ranker must agree on kept-label ORDER with its multi-series sibling, so a
    // bar chart does not re-order when a second Y series is added (finding 2.5).
    const single = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 3, rankDirection: 'top' }),
    );
    const multi = applyRankToMultiSeries(
      { labels: data.labels, series: [{ fieldId: 's', values: data.values }] },
      makeFilter({ filterMode: 'rank', value: 3, rankDirection: 'top' }),
    );
    expect(single.labels).toEqual(multi.labels);
    expect(single.values).toEqual(multi.series[0].values);
    // Both preserve the natural input order (B, C, D), not value-rank order (D, B, C).
    expect(single.labels).toEqual(['B', 'C', 'D']);
  });

  it('ranks by rankByField instead of the displayed value when specified (finding 3.x)', () => {
    // Displayed values are an AVG (e.g. average order size); ranking must use a separate
    // SUM-of-profit measure instead — matching grid/KPI/map/pivot widgets, which always rank
    // by an aggregate of `rankByField` regardless of the widget's own display aggregation
    // (`filterUtils.ts`'s row-level rank branch). By display value alone, top-2 would be
    // D (80) and B (50); by the separate rankByField score, top-2 is actually A (500) and C (400).
    const displayed = {
      labels: ['A', 'B', 'C', 'D'],
      values: [10, 50, 30, 80], // e.g. avg order size
    };
    const rankByFieldScores = {
      labels: ['A', 'B', 'C', 'D'],
      values: [500, 20, 400, 5], // e.g. sum of profit
    };
    const result = applyRankToAggregated(
      displayed,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top', rankByField: 'profit' }),
      rankByFieldScores,
    );
    // Kept in original input order (A, C) — displaying THEIR OWN (avg) values, not the
    // rank-by score.
    expect(result.labels).toEqual(['A', 'C']);
    expect(result.values).toEqual([10, 30]);
  });

  it('falls back to ranking by the displayed value when rankByFieldData is omitted, even if rankByField is set', () => {
    const result = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top', rankByField: 'profit' }),
    );
    // No rankByFieldData supplied — same result as ranking by `data.values` directly.
    expect(result.labels).toEqual(['B', 'D']);
  });
});

// ─── applyRankToMultiSeries ───────────────────────────────────────────────────

describe('applyRankToMultiSeries', () => {
  const data: MultiYSeriesData = {
    labels: ['A', 'B', 'C', 'D'],
    series: [
      { fieldId: 'S1', values: [10, 30, 20, 5] },
      { fieldId: 'S2', values: [20, 10, 30, 45] },
    ],
  };
  // Totals: A=30, B=40, C=50, D=50

  it('top 2 keeps labels with highest combined values', () => {
    const result = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top' }),
    );
    // C and D are tied at 50 — both should be in top 2
    expect(result.labels).toHaveLength(2);
    expect(result.labels.every((l) => ['C', 'D'].includes(l as string))).toBe(true);
  });

  it('bottom 1 returns label with lowest combined total', () => {
    const result = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom' }),
    );
    expect(result.labels).toEqual(['A']); // A has total 30
  });

  it('null filter returns original data', () => {
    const result = applyRankToMultiSeries(data, null);
    expect(result).toBe(data);
  });

  it('all series values are filtered consistently with labels', () => {
    const result = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }),
    );
    expect(result.series[0].values).toHaveLength(result.labels.length);
    expect(result.series[1].values).toHaveLength(result.labels.length);
  });

  it('N >= labels.length returns all data', () => {
    const result = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 10, rankDirection: 'top' }),
    );
    expect(result.labels).toHaveLength(4);
  });

  // ── rankMultiSeriesBy: aggregation modes ──────────────────────────────────

  it('__sum is the default (same as omitting rankMultiSeriesBy)', () => {
    // Totals: A=30, B=40, C=50, D=50
    const explicit = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 1,
        rankDirection: 'bottom',
        rankMultiSeriesBy: '__sum',
      }),
    );
    const implicit = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom' }),
    );
    expect(explicit.labels).toEqual(implicit.labels);
  });

  it('__avg: ranks by average of all series per label', () => {
    // Averages: A=(10+20)/2=15, B=(30+10)/2=20, C=(20+30)/2=25, D=(5+45)/2=25
    // Top 1 by avg: C or D (tied), bottom 1 by avg: A
    const bottom = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 1,
        rankDirection: 'bottom',
        rankMultiSeriesBy: '__avg',
      }),
    );
    expect(bottom.labels).toEqual(['A']);

    const top = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 2,
        rankDirection: 'top',
        rankMultiSeriesBy: '__avg',
      }),
    );
    expect(top.labels).toHaveLength(2);
    expect(top.labels.every((l) => ['C', 'D'].includes(l as string))).toBe(true);
  });

  it('__max: ranks by maximum series value per label', () => {
    // Max values: A=max(10,20)=20, B=max(30,10)=30, C=max(20,30)=30, D=max(5,45)=45
    // Top 1 by max: D
    const top = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 1,
        rankDirection: 'top',
        rankMultiSeriesBy: '__max',
      }),
    );
    expect(top.labels).toEqual(['D']);
  });

  it('__min: ranks by minimum series value per label', () => {
    // Min values: A=min(10,20)=10, B=min(30,10)=10, C=min(20,30)=20, D=min(5,45)=5
    // Bottom 1 by min: D (min=5)
    const bottom = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 1,
        rankDirection: 'bottom',
        rankMultiSeriesBy: '__min',
      }),
    );
    expect(bottom.labels).toEqual(['D']);
  });

  it('specific fieldId: ranks by that series only', () => {
    // S1 values: A=10, B=30, C=20, D=5 — top 1 = B
    const topByS1 = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top', rankMultiSeriesBy: 'S1' }),
    );
    expect(topByS1.labels).toEqual(['B']);

    // S2 values: A=20, B=10, C=30, D=45 — top 1 = D
    const topByS2 = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top', rankMultiSeriesBy: 'S2' }),
    );
    expect(topByS2.labels).toEqual(['D']);
  });

  it('specific fieldId: both series values are kept in sync with ranked labels', () => {
    // Rank top 2 by S2 (values: A=20, B=10, C=30, D=45) → D and C
    const result = applyRankToMultiSeries(
      data,
      makeFilter({ filterMode: 'rank', value: 2, rankDirection: 'top', rankMultiSeriesBy: 'S2' }),
    );
    expect(result.labels.sort()).toEqual(['C', 'D']);
    // S1 values should correspond: C=20, D=5
    const labelIdx = (l: string) => result.labels.indexOf(l);
    const s1 = result.series.find((s) => s.fieldId === 'S1')!;
    expect(s1.values[labelIdx('C')]).toBe(20);
    expect(s1.values[labelIdx('D')]).toBe(5);
  });

  it('unknown fieldId falls back to 0 score (treats all labels as equal)', () => {
    // All scores = 0, so top 1 returns whichever has index 0 after stable sort
    const result = applyRankToMultiSeries(
      data,
      makeFilter({
        filterMode: 'rank',
        value: 1,
        rankDirection: 'top',
        rankMultiSeriesBy: 'nonexistent',
      }),
    );
    expect(result.labels).toHaveLength(1);
  });
});

// ─── aggregateByField with xGroupBy ──────────────────────────────────────────

describe('aggregateByField with xGroupBy', () => {
  const rows = [
    { date: '2024-01-05', revenue: 100 },
    { date: '2024-01-20', revenue: 200 },
    { date: '2024-02-10', revenue: 300 },
    { date: '2024-02-25', revenue: 150 },
    { date: '2024-03-01', revenue: 50 },
  ];

  it('groups by month', () => {
    const result = aggregateByField(rows, 'date', 'revenue', 'month');
    expect(result.labels).toEqual(['2024-01', '2024-02', '2024-03']);
    expect(result.values).toEqual([300, 450, 50]);
  });

  it('groups by year', () => {
    const result = aggregateByField(rows, 'date', 'revenue', 'year');
    expect(result.labels).toEqual(['2024']);
    expect(result.values).toEqual([800]);
  });

  it('groups by quarter', () => {
    const result = aggregateByField(rows, 'date', 'revenue', 'quarter');
    expect(result.labels).toEqual(['2024-Q1']);
    expect(result.values).toEqual([800]);
  });

  it('no grouping: raw values remain separate', () => {
    const result = aggregateByField(rows, 'date', 'revenue');
    expect(result.labels).toHaveLength(5);
  });
});

// ─── aggregateByField null / non-numeric handling (finding 1.4) ───────────────

describe('aggregateByField null handling (finding 1.4)', () => {
  const rows = [
    { cat: 'A', v: 10 },
    { cat: 'A', v: null },
    { cat: 'A', v: 20 },
  ];
  const idxA = (r: { labels: (string | number)[] }) => r.labels.indexOf('A');

  it('excludes null values from the avg denominator (not coerced to 0)', () => {
    const result = aggregateByField(rows, 'cat', 'v', undefined, 'avg');
    // avg(10, 20) = 15 — NOT (10 + 0 + 20) / 3 = 10
    expect(result.values[idxA(result)]).toBe(15);
  });

  it('does not drag min toward 0 with null values', () => {
    const result = aggregateByField(rows, 'cat', 'v', undefined, 'min');
    expect(result.values[idxA(result)]).toBe(10); // was 0 when null → 0
  });

  it('sums only the non-null values', () => {
    const result = aggregateByField(rows, 'cat', 'v', undefined, 'sum');
    expect(result.values[idxA(result)]).toBe(30);
  });

  it("'count' still tallies every row, including null-measure rows", () => {
    const result = aggregateByField(rows, 'cat', 'v', undefined, 'count');
    expect(result.values[idxA(result)]).toBe(3);
  });
});

// ─── Real categories colliding with the empty-bucket label (M8) ──────────────

describe('categories that literally equal the empty-bucket label (M8)', () => {
  // A `tickets.csv` whose `assignee` column literally contains the string `(empty)`.
  const tickets = [
    { assignee: '(empty)', hours: 3 },
    { assignee: '(empty)', hours: 2 },
    { assignee: 'Ada', hours: 5 },
  ];

  it('keeps rows whose x value equals the default empty-bucket label', () => {
    const result = aggregateByField(tickets, 'assignee', 'hours', undefined, 'count');
    expect([...result.labels].sort()).toEqual(['(empty)', 'Ada']);
    // The bars must account for every row — previously the `(empty)` rows vanished and the
    // chart silently summed to less than the row count.
    expect(result.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)).toBe(tickets.length);
  });

  it('keeps rows whose x value equals a TRANSLATED empty-bucket label', () => {
    const frLabel = frLocaleText.chartEmptyCategoryLabel!;
    const rows = [
      { assignee: frLabel, hours: 3 },
      { assignee: 'Ada', hours: 5 },
    ];
    const result = aggregateByField(
      rows,
      'assignee',
      'hours',
      undefined,
      'count',
      undefined,
      undefined,
      undefined,
      frLocaleText,
    );
    expect(result.labels).toContain(frLabel);
  });

  it('still drops null/undefined/empty-string x values', () => {
    const rows = [
      { assignee: 'Ada', hours: 5 },
      { assignee: null, hours: 1 },
      { assignee: undefined, hours: 1 },
      { assignee: '', hours: 1 },
    ];
    const result = aggregateByField(rows, 'assignee', 'hours', undefined, 'count');
    expect(result.labels).toEqual(['Ada']);
  });

  it('keeps a heatmap column whose x value equals the empty-bucket label', () => {
    const rows = [
      { x: '(empty)', y: 'EU', v: 10 },
      { x: 'Jan', y: 'EU', v: 5 },
    ];
    const data = aggregateHeatmap(rows, 'x', 'y', 'v', undefined, 'sum');
    expect(data.xLabels).toContain('(empty)');
    expect(data.cells.get('(empty)\x00EU')).toBe(10);
  });
});

// ─── All-null buckets are null, never a real 0 (H4) ──────────────────────────

describe('aggregateByField all-null buckets (H4)', () => {
  // The verified reproduction: Oslo has no readings at all; Rome is below freezing.
  const temps = [
    { city: 'Oslo', temp: null },
    { city: 'Oslo', temp: null },
    { city: 'Rome', temp: -4 },
    { city: 'Rome', temp: 2 },
  ];

  it('returns null (not 0) for a bucket whose measures are all null', () => {
    for (const fn of ['min', 'max', 'avg', 'sum'] as const) {
      const result = aggregateByField(temps, 'city', 'temp', undefined, fn);
      expect(result.labels).toEqual(['Oslo', 'Rome']);
      // Previously `[0, -4]` for 'min' — Oslo plotted at 0 °C, ABOVE a real −4 °C Rome.
      expect(result.values[result.labels.indexOf('Oslo')]).toBe(null);
    }
  });

  it('keeps the all-null label on the axis (it is a gap, not a dropped category)', () => {
    const result = aggregateByField(temps, 'city', 'temp', undefined, 'min');
    expect(result.labels).toContain('Oslo');
    expect(result.values[result.labels.indexOf('Rome')]).toBe(-4);
  });

  it("sorts an all-null bucket LAST under chartSortBy: 'value', in both directions", () => {
    const desc = aggregateByField(temps, 'city', 'temp', undefined, 'min', 'value', 'desc');
    expect(desc.labels).toEqual(['Rome', 'Oslo']);
    // Ascending too: "no data" is not the smallest value, it is no value.
    const asc = aggregateByField(temps, 'city', 'temp', undefined, 'min', 'value', 'asc');
    expect(asc.labels).toEqual(['Rome', 'Oslo']);
  });

  it('never lets an all-null bucket win a Top-N rank over a real negative value', () => {
    const data = aggregateByField(temps, 'city', 'temp', undefined, 'min');
    const ranked = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }),
    );
    expect(ranked.labels).toEqual(['Rome']);

    // And it is not merely "smallest", either — a Bottom-1 also picks the real value.
    const bottom = applyRankToAggregated(
      data,
      makeFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom' }),
    );
    expect(bottom.labels).toEqual(['Rome']);
  });
});

// ─── numeric-string measures (finding 1.6) ───────────────────────────────────
// CSV/JSON sources have no native number type, so measures often arrive as
// strings ("10"). The pre-detect used `Number.isNaN(Number(v))` (which treats
// "10" as numeric) while accumulation rejected every string, so all values were
// skipped and charts rendered flat 0. coerceAggregateValue now parses numeric
// strings, so the pre-detect and the accumulator agree.

describe('aggregateByField numeric-string measures (finding 1.6)', () => {
  const rows = [
    { cat: 'A', amount: '10' },
    { cat: 'A', amount: '5' },
    { cat: 'B', amount: '7' },
  ];
  const idx = (r: { labels: (string | number)[] }, label: string) => r.labels.indexOf(label);

  it('sums numeric strings instead of rendering flat 0 (verified repro)', () => {
    const result = aggregateByField(rows, 'cat', 'amount');
    expect(result.labels).toEqual(['A', 'B']);
    expect(result.values[idx(result, 'A')]).toBe(15);
    expect(result.values[idx(result, 'B')]).toBe(7);
  });

  it('averages numeric strings', () => {
    const result = aggregateByField(rows, 'cat', 'amount', undefined, 'avg');
    expect(result.values[idx(result, 'A')]).toBe(7.5); // (10 + 5) / 2
  });

  it('takes the min of numeric strings', () => {
    const result = aggregateByField(rows, 'cat', 'amount', undefined, 'min');
    expect(result.values[idx(result, 'A')]).toBe(5);
  });

  it('takes the max of numeric strings', () => {
    const result = aggregateByField(rows, 'cat', 'amount', undefined, 'max');
    expect(result.values[idx(result, 'A')]).toBe(10);
  });

  it('still falls back to count for genuinely non-numeric string measures', () => {
    const stringRows = [
      { cat: 'A', label: 'foo' },
      { cat: 'A', label: 'bar' },
      { cat: 'B', label: 'baz' },
    ];
    const result = aggregateByField(stringRows, 'cat', 'label', undefined, 'sum');
    // Non-numeric measure → pre-detect flips to count → row tallies, not NaN/0.
    expect(result.values[idx(result, 'A')]).toBe(2);
    expect(result.values[idx(result, 'B')]).toBe(1);
  });

  it('sums a field whose first non-null value is a sentinel but the rest are numbers (any-value detection)', () => {
    // The pre-detect inspects ALL non-null values, not just the first: a leading
    // "N/A" sentinel ahead of real numbers must not downgrade a configured `sum`
    // to a row count.
    const sentinelRows = [
      { cat: 'A', amount: 'N/A' },
      { cat: 'A', amount: 10 },
      { cat: 'A', amount: 20 },
    ];
    const result = aggregateByField(sentinelRows, 'cat', 'amount', undefined, 'sum');
    // sum(10, 20) = 30 — NOT a row count of 3.
    expect(result.values[idx(result, 'A')]).toBe(30);
  });
});

describe('detectAggregationType / aggregateByField forcedAggregation (finding 3)', () => {
  // Regression for finding 3: the ghost (baseline-vs-filtered) tooltip used to let
  // `aggregateByField` independently pre-detect sum-vs-count per row set. A filtered subset
  // that happened to be empty or entirely non-numeric downgraded to 'count' while the baseline
  // (with real numeric values) stayed 'sum', so the two were no longer comparable quantities.
  // The fix: `detectAggregationType` lets a caller detect the type ONCE (from the baseline) and
  // `aggregateByField`'s `forcedAggregation` param applies that same type to both computations.

  it('detects count when the field is entirely non-numeric', () => {
    const rows = [{ cat: 'A', amount: 'foo' }];
    expect(detectAggregationType(rows, 'amount', 'sum')).toBe('count');
  });

  it('detects sum (the configured aggregation) when the field has any numeric value', () => {
    const rows = [{ cat: 'A', amount: 10 }];
    expect(detectAggregationType(rows, 'amount', 'sum')).toBe('sum');
  });

  it('detects sum for an EMPTY row set (nothing non-numeric was observed)', () => {
    expect(detectAggregationType([], 'amount', 'sum')).toBe('sum');
  });

  it('always returns count when the configured aggregation is count', () => {
    const rows = [{ cat: 'A', amount: 10 }];
    expect(detectAggregationType(rows, 'amount', 'count')).toBe('count');
  });

  it('aggregateByField uses its own row set to detect the type when forcedAggregation is omitted', () => {
    // Filtered subset is empty → self-detects as 'sum' (no non-numeric values observed), so an
    // empty filtered subset renders as a 0 sum, not a 0 count — matches detectAggregationType's
    // "empty row set" behavior above.
    const filteredRows: { cat: string; amount: unknown }[] = [];
    const filtered = aggregateByField(filteredRows, 'cat', 'amount', undefined, 'sum');
    expect(filtered).toEqual({ labels: [], values: [] });
  });

  it('forcedAggregation makes a filtered (empty/non-numeric) subset agree with the baseline instead of independently downgrading to count', () => {
    const baselineRows = [
      { cat: 'A', amount: 10 },
      { cat: 'B', amount: 20 },
    ];
    // The filtered subset for this same field happens to be entirely non-numeric (a leftover
    // sentinel with no real numeric values) — in isolation this would self-detect as 'count'.
    const filteredRows = [{ cat: 'A', amount: 'N/A' }];

    const baselineType = detectAggregationType(baselineRows, 'amount', 'sum');
    expect(baselineType).toBe('sum');

    // Without forcing, the filtered subset disagrees with the baseline (finding 3's bug).
    const filteredSelfDetected = aggregateByField(filteredRows, 'cat', 'amount', undefined, 'sum');
    expect(filteredSelfDetected.values[filteredSelfDetected.labels.indexOf('A')]).toBe(1); // counted

    // Forcing the baseline-detected type onto the filtered computation keeps both comparable:
    // the filtered 'A' sums its (zero) numeric contribution instead of counting rows.
    const filteredForced = aggregateByField(
      filteredRows,
      'cat',
      'amount',
      undefined,
      'sum',
      undefined,
      undefined,
      undefined,
      undefined,
      baselineType,
    );
    // Summed, not counted: `null` (no numeric value to sum) rather than the row count 1.
    // The `0` this used to assert was the H4 `?? 0`; this test's point is sum-vs-count, and
    // `null` still makes it — a `null` is unambiguously not a row count.
    expect(filteredForced.values[filteredForced.labels.indexOf('A')]).toBe(null);

    const baseline = aggregateByField(
      baselineRows,
      'cat',
      'amount',
      undefined,
      'sum',
      undefined,
      undefined,
      undefined,
      undefined,
      baselineType,
    );
    expect(baseline.values[baseline.labels.indexOf('A')]).toBe(10);
    // Both are now 'sum' quantities — directly comparable (10 filtered-out of a baseline 10),
    // instead of one being a row count and the other a sum.
  });
});

describe('aggregateByTwoFields numeric-string measures (finding 1.6)', () => {
  const rows = [
    { cat: 'A', series: 'X', amount: '10' },
    { cat: 'A', series: 'X', amount: '5' },
    { cat: 'B', series: 'X', amount: '7' },
  ];

  it('sums numeric strings per cell instead of producing all-null cells', () => {
    const result = aggregateByTwoFields(rows, 'cat', 'series', 'amount');
    expect(result.labels).toEqual(['A', 'B']);
    expect(result.seriesNames).toEqual(['X']);
    const aIdx = result.labels.indexOf('A');
    const bIdx = result.labels.indexOf('B');
    expect(result.seriesData.X[aIdx]).toBe(15);
    expect(result.seriesData.X[bIdx]).toBe(7);
  });
});

describe('aggregateMultipleSeries numeric-string measures (finding 1.6)', () => {
  const rows = [
    { cat: 'A', m1: '10', m2: '1' },
    { cat: 'A', m1: '5', m2: '2' },
    { cat: 'B', m1: '7', m2: '3' },
  ];

  it('sums numeric-string measures across multiple y-fields', () => {
    const result = aggregateMultipleSeries(rows, 'cat', ['m1', 'm2']);
    const aIdx = result.labels.indexOf('A');
    const bIdx = result.labels.indexOf('B');
    const m1 = result.series.find((s) => s.fieldId === 'm1')!;
    const m2 = result.series.find((s) => s.fieldId === 'm2')!;
    expect(m1.values[aIdx]).toBe(15);
    expect(m1.values[bIdx]).toBe(7);
    expect(m2.values[aIdx]).toBe(3);
    expect(m2.values[bIdx]).toBe(3);
  });
});

// ─── resolveChartRowsForAggregation ──────────────────────────────────────────

describe('resolveChartRowsForAggregation', () => {
  const customers = [
    { id: 'CUS-1', country: 'Germany' },
    { id: 'CUS-2', country: 'France' },
  ];
  const orders = [
    { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
    { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
    { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
  ];

  const dataSources: Record<string, StudioDataSource> = {
    customers: {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'Customer ID', type: 'string' },
        { id: 'country', label: 'Country', type: 'string' },
      ],
      rows: customers,
    },
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'Order ID', type: 'string' },
        { id: 'customerId', label: 'Customer ID', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: orders,
    },
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-orders-customers',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  it('anchors aggregation rows on the many-side when Y is on the many-side and X is native', () => {
    const resolvedRows = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );

    expect(resolvedRows).toHaveLength(3);
    expect(resolvedRows.map((row) => row.country)).toEqual(['Germany', 'Germany', 'France']);
    expect(aggregateByField(resolvedRows, 'country', 'total')).toEqual({
      labels: ['France', 'Germany'],
      values: [70, 150],
    });
  });

  // ─── Finding 1.4 ────────────────────────────────────────────────────────────
  it('applies an anchor(orders)-scoped filter to the anchor rows before the expansion join, end to end (finding 1.4)', () => {
    // Chart on customers (x=country, y=orders.total, anchor=orders) with an incoming
    // cross-filter `orders.total > 60` — L3 would enforce this as a semi-join (keep customers
    // with >=1 matching order); L4 must apply the SAME filter to the anchor rows themselves
    // before the expansion join, or it resurrects every order (matching + non-matching) for
    // customers that have at least one match.
    const totalFilter = {
      id: 'f-total',
      field: 'total',
      operator: 'greater_than' as const,
      value: 60,
      scope: { kind: 'cross-filter' as const, sourceWidgetId: 'w2', pageId: 'p1' },
      filterSourceId: 'orders',
    } as unknown as StudioFilterState;

    const resolvedRows = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
      [],
      [totalFilter],
    );

    // Only ORD-1 (100, Germany) and ORD-3 (70, France) survive; ORD-2 (50, Germany) is excluded.
    expect(resolvedRows).toHaveLength(2);
    expect(aggregateByField(resolvedRows, 'country', 'total')).toEqual({
      labels: ['France', 'Germany'],
      values: [70, 100],
    });
  });

  it('matches the direct orders-grain aggregation for the same country totals', () => {
    const joinedRows = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    const directRows = enrichRowsWithRelatedFields(
      orders,
      'orders',
      ['country'],
      dataSources,
      relationships,
    );

    expect(aggregateByField(joinedRows, 'country', 'total')).toEqual(
      aggregateByField(directRows, 'country', 'total'),
    );
  });

  it('resolves a series field from the widget source onto many-side anchor rows', () => {
    const resolvedRows = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      'country',
      dataSources,
      relationships,
      [],
    );

    expect(aggregateByTwoFields(resolvedRows, 'country', 'country', 'total')).toEqual({
      labels: ['France', 'Germany'],
      seriesNames: ['France', 'Germany'],
      seriesData: {
        Germany: [null, 150],
        France: [70, null],
      },
    });
  });

  it('returns the same Row[] reference on a second call with the same inputs (cache hit)', () => {
    const result1 = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    const result2 = resolveChartRowsForAggregation(
      customers,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    expect(result1).toBe(result2);
  });

  it('returns a different Row[] reference when the rows input changes', () => {
    const rows1 = [{ id: 'CUS-1', country: 'Germany' }];
    const rows2 = [{ id: 'CUS-1', country: 'Germany' }]; // same values, different reference
    const result1 = resolveChartRowsForAggregation(
      rows1,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    const result2 = resolveChartRowsForAggregation(
      rows2,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    expect(result1).not.toBe(result2);
  });

  it('recomputes when the cross-source anchor rows change independently of widgetRows', () => {
    // Chart on customers (widget source), Y = orders.total (cross-source — orders is anchor).
    // Simulate: orders data is refreshed but customer rows are unchanged.
    // With the two-level WeakMap, orders.rows changing should invalidate the cache.
    const widgetRows = [...customers]; // stable customer rows ref

    const ordersV1 = [
      { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
      { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
      { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
    ];
    const ds1: Record<string, StudioDataSource> = {
      ...dataSources,
      orders: { ...dataSources.orders, rows: ordersV1 },
    };

    const result1 = resolveChartRowsForAggregation(
      widgetRows,
      'customers',
      'country',
      ['total'],
      undefined,
      ds1,
      relationships,
      [],
    );
    expect(result1.map((r) => r.total)).toEqual([100, 50, 70]);

    // orders gets a new rows ref with updated totals
    const ordersV2 = [
      { id: 'ORD-1', customerId: 'CUS-1', total: 999 }, // changed
      { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
      { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
    ];
    const ds2: Record<string, StudioDataSource> = {
      ...dataSources,
      orders: { ...dataSources.orders, rows: ordersV2 },
    };

    const result2 = resolveChartRowsForAggregation(
      widgetRows, // same customer rows ref
      'customers',
      'country',
      ['total'],
      undefined,
      ds2,
      relationships,
      [],
    );
    // anchorRows (orders.rows) changed → inner WeakMap miss → recomputed ✓
    expect(result2).not.toBe(result1);
    expect(result2.map((r) => r.total)).toEqual([999, 50, 70]);
  });

  it('returns a cache hit when an unrelated source changes (neither widgetRows nor anchorRows)', () => {
    // Unrelated source 'products' is added — should not invalidate orders/customers chart cache.
    const widgetRows = [...customers];
    const ordersRows = [...orders];

    const ds1: Record<string, StudioDataSource> = {
      customers: { ...dataSources.customers, rows: widgetRows },
      orders: { ...dataSources.orders, rows: ordersRows },
    };

    const result1 = resolveChartRowsForAggregation(
      widgetRows,
      'customers',
      'country',
      ['total'],
      undefined,
      ds1,
      relationships,
      [],
    );

    // 'products' source added — neither widgetRows nor anchorRows changed
    const ds2: Record<string, StudioDataSource> = {
      ...ds1,
      products: { id: 'products', label: 'Products', fields: [], rows: [{ id: 'P1' }] },
    };

    const result2 = resolveChartRowsForAggregation(
      widgetRows,
      'customers',
      'country',
      ['total'],
      undefined,
      ds2,
      relationships,
      [],
    );
    // Neither WeakMap key changed → cache hit → same reference ✓
    expect(result2).toBe(result1);
  });

  it('evaluates expression fields on the same source (fixes blank charts with expr yField)', () => {
    const products = [
      { id: 'P1', category: 'Electronics', price: 100, cost: 60 },
      { id: 'P2', category: 'Electronics', price: 200, cost: 120 },
      { id: 'P3', category: 'Office', price: 50, cost: 40 },
    ];
    const productsSource: StudioDataSource = {
      id: 'products',
      label: 'Products',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'price', label: 'Price', type: 'number' },
        { id: 'cost', label: 'Cost', type: 'number' },
      ],
      rows: products,
    };
    const expressionFields: import('../models/expressionTypes').StudioExpressionField[] = [
      {
        id: 'expr-margin',
        label: 'Unit Margin',
        sourceId: 'products',
        type: 'number',
        isMeasure: false,
        expression: {
          operator: 'subtract',
          inputs: [{ id: 'price' }, { id: 'cost' }],
        },
      },
    ];

    const resolved = resolveChartRowsForAggregation(
      products,
      'products',
      'category',
      ['expr-margin'],
      undefined,
      { products: productsSource },
      [],
      expressionFields,
    );

    // Expression field must be evaluated — not undefined/0
    expect(resolved[0]['expr-margin']).toBe(40); // 100 - 60
    expect(resolved[1]['expr-margin']).toBe(80); // 200 - 120
    expect(resolved[2]['expr-margin']).toBe(10); // 50 - 40

    // Chart aggregation on the expression field should produce correct values
    const agg = aggregateByField(resolved, 'category', 'expr-margin', undefined, 'avg');
    expect(agg.labels).toContain('Electronics');
    const elecIdx = agg.labels.indexOf('Electronics');
    expect(agg.values[elecIdx]).toBe(60); // avg of 40 and 80
  });

  // ─── L4 cache invalidation on relationship / expression edits (Part A item 3) ──

  it('invalidates the L4 cache when the relationships array reference changes', () => {
    const widgetRows = [...customers];
    const result1 = resolveChartRowsForAggregation(
      widgetRows,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );
    // New relationships array + object ref, identical content, all rows unchanged.
    const relationships2: StudioRelationship[] = [{ ...relationships[0] }];
    const result2 = resolveChartRowsForAggregation(
      widgetRows,
      'customers',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships2,
      [],
    );
    // Old cache keyed only on rows refs → would have served the stale joined result.
    expect(result2).not.toBe(result1);
    expect(result2.map((r) => r.total)).toEqual([100, 50, 70]);
  });

  it('invalidates the L4 cache when an anchor-source expression formula changes', () => {
    const products = [
      { id: 'P1', category: 'Electronics', price: 100, cost: 60 },
      { id: 'P2', category: 'Electronics', price: 200, cost: 120 },
    ];
    const productsSource: StudioDataSource = {
      id: 'products',
      label: 'Products',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'price', label: 'Price', type: 'number' },
        { id: 'cost', label: 'Cost', type: 'number' },
      ],
      rows: products,
    };
    const ds = { products: productsSource };

    const exprV1: import('../models/expressionTypes').StudioExpressionField = {
      id: 'expr-margin',
      label: 'Margin',
      sourceId: 'products',
      type: 'number',
      isMeasure: false,
      expression: { operator: 'subtract', inputs: [{ id: 'price' }, { id: 'cost' }] },
    };
    // Edited formula: margin = price - 0 (i.e. just price), rows unchanged.
    const exprV2: import('../models/expressionTypes').StudioExpressionField = {
      id: 'expr-margin',
      label: 'Margin',
      sourceId: 'products',
      type: 'number',
      isMeasure: false,
      expression: { operator: 'subtract', inputs: [{ id: 'price' }, { type: 'number', value: 0 }] },
    };

    const r1 = resolveChartRowsForAggregation(
      products,
      'products',
      'category',
      ['expr-margin'],
      undefined,
      ds,
      [],
      [exprV1],
    );
    expect(r1[0]['expr-margin']).toBe(40); // 100 - 60

    const r2 = resolveChartRowsForAggregation(
      products,
      'products',
      'category',
      ['expr-margin'],
      undefined,
      ds,
      [],
      [exprV2],
    );
    // Formula edit with rows unchanged must recompute — old cache returned stale 40.
    expect(r2[0]['expr-margin']).toBe(100); // price only
    expect(r2).not.toBe(r1);
  });

  // ─── L4 cache invalidation on a NON-anchor related source (finding 1.5) ────────

  it('invalidates the L4 cache when a non-anchor related source rows change', () => {
    // Chart on `orders` (widget source, also the grain anchor since Y=orders.total), split by
    // `customers.segment` (a many-to-one related dimension). The widgetRows (orders) and the
    // anchorRows (orders) are BOTH unchanged, but `customers` rows change — the two WeakMap keys
    // don't move, so only the readSourceRows tracking catches it.
    const ordersRows = [
      { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
      { id: 'ORD-2', customerId: 'CUS-2', total: 70 },
    ];
    const customersV1 = [
      { id: 'CUS-1', segment: 'Enterprise' },
      { id: 'CUS-2', segment: 'SMB' },
    ];
    const rels: StudioRelationship[] = [
      {
        id: 'rel-o-c',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
        type: 'many-to-one',
      },
    ];
    const dsV1: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'customerId', label: 'Customer', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
        rows: ordersRows,
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'segment', label: 'Segment', type: 'string' },
        ],
        rows: customersV1,
      },
    };

    const r1 = resolveChartRowsForAggregation(
      ordersRows,
      'orders',
      undefined,
      ['total'],
      'segment',
      dsV1,
      rels,
      [],
    );
    expect(r1.map((r) => r.segment)).toEqual(['Enterprise', 'SMB']);

    // customers gets a new rows ref with a renamed segment; orders rows are untouched.
    const customersV2 = [
      { id: 'CUS-1', segment: 'Consumer' }, // changed
      { id: 'CUS-2', segment: 'SMB' },
    ];
    const dsV2: Record<string, StudioDataSource> = {
      ...dsV1,
      customers: { ...dsV1.customers, rows: customersV2 },
    };

    const r2 = resolveChartRowsForAggregation(
      ordersRows, // same orders (widget + anchor) rows ref
      'orders',
      undefined,
      ['total'],
      'segment',
      dsV2,
      rels,
      [],
    );
    // Old cache (keyed only on widgetRows × anchorRows) served the stale 'Enterprise'.
    expect(r2).not.toBe(r1);
    expect(r2.map((r) => r.segment)).toEqual(['Consumer', 'SMB']);
  });

  // ─── extraFields threading for non-xy chart families (finding 1.9) ────────────

  it('enriches a cross-source extra-dimension field passed via extraFields', () => {
    const ordersRows = [
      { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
      { id: 'ORD-2', customerId: 'CUS-2', total: 70 },
    ];
    const customersRows = [
      { id: 'CUS-1', region: 'EU' },
      { id: 'CUS-2', region: 'US' },
    ];
    const rels: StudioRelationship[] = [
      {
        id: 'rel-o-c',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
        type: 'many-to-one',
      },
    ];
    const ds: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'customerId', label: 'Customer', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
        rows: ordersRows,
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'region', label: 'Region', type: 'string' },
        ],
        rows: customersRows,
      },
    };

    // heatmap-shaped: x=orders.id, value=orders.total, extra dimension = customers.region.
    const resolved = resolveChartRowsForAggregation(
      ordersRows,
      'orders',
      'id',
      ['total'],
      undefined,
      ds,
      rels,
      [],
      ['region'], // extraFields
    );
    // The cross-source dimension is enriched onto every row (guard reports it supported).
    expect(resolved.map((r) => r.region)).toEqual(['EU', 'US']);

    // Without extraFields it is NOT requested → reads undefined (the pre-fix blank-bucket bug).
    const withoutExtra = resolveChartRowsForAggregation(
      ordersRows,
      'orders',
      'id',
      ['total'],
      undefined,
      ds,
      rels,
      [],
    );
    expect(withoutExtra.every((r) => r.region === undefined)).toBe(true);
  });
});

describe('analyzeChartSupport', () => {
  const customers = [
    { id: 'CUS-1', country: 'Germany' },
    { id: 'CUS-2', country: 'France' },
  ];
  const orders = [
    { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
    { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
    { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
  ];

  const dataSources: Record<string, StudioDataSource> = {
    customers: {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'Customer ID', type: 'string' },
        { id: 'country', label: 'Country', type: 'string' },
      ],
      rows: customers,
    },
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'Order ID', type: 'string' },
        { id: 'customerId', label: 'Customer ID', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: orders,
    },
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-orders-customers',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  it('supports the direct one-to-many chart case already implemented', () => {
    expect(
      analyzeChartSupport(
        'customers',
        'country',
        ['total'],
        undefined,
        'pie',
        dataSources,
        relationships,
        [],
      ),
    ).toMatchObject({ supported: true });
  });

  it('flags scatter cross-source combinations as unsupported', () => {
    expect(
      analyzeChartSupport(
        'customers',
        'country',
        ['total'],
        undefined,
        'scatter',
        dataSources,
        relationships,
        [],
      ),
    ).toEqual({ supported: false, reason: 'scatter_cross_source_not_supported' });
  });

  it('flags unresolved fields as unsupported', () => {
    expect(
      analyzeChartSupport(
        'customers',
        'region',
        ['total'],
        undefined,
        'pie',
        dataSources,
        relationships,
        [],
      ),
    ).toEqual({ supported: false, reason: 'field_not_found_or_not_direct' });
  });

  // Regression (finding 2.5): non-xy families (heatmap/funnel/sankey/gantt) read fields
  // (e.g. `heatYField`) that are not x/y/series. They are passed via the trailing
  // `extraFields` arg so the guard validates them instead of silently ignoring them.
  it('validates a non-xy family extra dimension field via extraFields', () => {
    // An unresolved extra field now makes the guard report the chart unsupported.
    expect(
      analyzeChartSupport(
        'customers',
        'country',
        ['total'],
        undefined,
        'heatmap',
        dataSources,
        relationships,
        [],
        undefined,
        undefined,
        ['region'], // heatYField — no such field on any related source
      ),
    ).toEqual({ supported: false, reason: 'field_not_found_or_not_direct' });

    // A resolvable extra dimension field (owned by the widget source) keeps it supported,
    // and is validated like a dimension — never treated as a y-measure anchor.
    const supported = analyzeChartSupport(
      'customers',
      'country',
      ['total'],
      undefined,
      'heatmap',
      dataSources,
      relationships,
      [],
      undefined,
      undefined,
      ['id'],
    );
    expect(supported.supported).toBe(true);
    expect(supported.fieldOwners?.get('id')).toBe('customers');
    expect(supported.anchorSourceId).toBe('orders');
  });

  it('returns stable message copy for reason codes', () => {
    expect(getChartSupportMessage('mixed_cross_source_fields')).toMatch(
      'single safe aggregation grain',
    );
  });

  it('supports bridging many-side Y through the widget source to a safe one-side dimension source', () => {
    expect(
      analyzeChartSupport(
        'orders',
        'country',
        ['total'],
        undefined,
        'pie',
        {
          customers: dataSources.customers,
          orders: dataSources.orders,
          orderItems: {
            id: 'orderItems',
            label: 'Order Items',
            fields: [
              { id: 'id', label: 'Order Item ID', type: 'string' },
              { id: 'orderId', label: 'Order ID', type: 'string' },
              { id: 'total', label: 'Total', type: 'number' },
            ],
            rows: [
              { id: 'OI-1', orderId: 'ORD-1', total: 30 },
              { id: 'OI-2', orderId: 'ORD-1', total: 70 },
              { id: 'OI-3', orderId: 'ORD-2', total: 50 },
              { id: 'OI-4', orderId: 'ORD-3', total: 70 },
            ],
          },
        },
        [
          ...relationships,
          {
            id: 'rel-orderitems-orders',
            sourceId: 'orderItems',
            sourceField: 'orderId',
            targetId: 'orders',
            targetField: 'id',
            type: 'many-to-one',
          },
        ],
        [],
      ),
    ).toMatchObject({ supported: true });
  });

  it('returns precomputed fieldOwners and anchorSourceId when supported', () => {
    const result = analyzeChartSupport(
      'customers',
      'country',
      ['total'],
      undefined,
      'pie',
      dataSources,
      relationships,
      [],
    );
    expect(result.supported).toBe(true);
    expect(result.fieldOwners).toBeInstanceOf(Map);
    expect(result.fieldOwners?.get('country')).toBe('customers');
    expect(result.fieldOwners?.get('total')).toBe('orders');
    expect(result.anchorSourceId).toBe('orders');
  });

  it('rejects bridging through another many-side source as unsupported', () => {
    expect(
      analyzeChartSupport(
        'orders',
        'status',
        ['total'],
        undefined,
        'pie',
        {
          customers: dataSources.customers,
          orders: dataSources.orders,
          shipments: {
            id: 'shipments',
            label: 'Shipments',
            fields: [
              { id: 'id', label: 'Shipment ID', type: 'string' },
              { id: 'orderId', label: 'Order ID', type: 'string' },
              { id: 'status', label: 'Status', type: 'string' },
            ],
            rows: [
              { id: 'S-1', orderId: 'ORD-1', status: 'Packed' },
              { id: 'S-2', orderId: 'ORD-1', status: 'Shipped' },
            ],
          },
          orderItems: {
            id: 'orderItems',
            label: 'Order Items',
            fields: [
              { id: 'id', label: 'Order Item ID', type: 'string' },
              { id: 'orderId', label: 'Order ID', type: 'string' },
              { id: 'total', label: 'Total', type: 'number' },
            ],
            rows: [{ id: 'OI-1', orderId: 'ORD-1', total: 30 }],
          },
        },
        [
          ...relationships,
          {
            id: 'rel-orderitems-orders',
            sourceId: 'orderItems',
            sourceField: 'orderId',
            targetId: 'orders',
            targetField: 'id',
            type: 'many-to-one',
          },
          {
            id: 'rel-shipments-orders',
            sourceId: 'shipments',
            sourceField: 'orderId',
            targetId: 'orders',
            targetField: 'id',
            type: 'many-to-one',
          },
        ],
        [],
      ),
    ).toEqual({ supported: false, reason: 'mixed_cross_source_fields' });
  });

  // ─── Finding 1.1 (M:1-anchor variant) ───────────────────────────────────────
  // Widget = `orders`. Measure y = `order_items.total`, so the anchor switches to
  // `order_items` (a directly-related MANY side — a plain many-to-one anchor). A grouping
  // dimension owned by the remote endpoint / junction of an M:N relationship with `orders`
  // (`tags` via the `order_tags` junction) has no single grain combining an
  // `order_items`-level measure with a tag fan-out. Iteration 7's junction-anchor fix only
  // covered widget-owned measures; here the measure is NOT widget-owned, so this must fail
  // closed rather than be silently mis-attributed by the first-match-only M:N display lookup.
  describe('finding 1.1 — M:1 anchor + M:N-reachable dimension fails closed', () => {
    const ordersRows = [{ id: 'ORD-1' }, { id: 'ORD-2' }];
    const mnDataSources: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
        rows: ordersRows,
      },
      order_items: {
        id: 'order_items',
        label: 'Order Items',
        fields: [
          { id: 'id', label: 'Item ID', type: 'string' },
          { id: 'orderId', label: 'Order ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
        rows: [
          { id: 'OI-1', orderId: 'ORD-1', total: 30 },
          { id: 'OI-2', orderId: 'ORD-2', total: 50 },
        ],
      },
      tags: {
        id: 'tags',
        label: 'Tags',
        fields: [
          { id: 'id', label: 'Tag ID', type: 'string' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: [
          { id: 't1', name: 'A' },
          { id: 't2', name: 'B' },
        ],
      },
      order_tags: {
        id: 'order_tags',
        label: 'Order Tags',
        fields: [
          { id: 'orderId', label: 'Order ID', type: 'string' },
          { id: 'tagId', label: 'Tag ID', type: 'string' },
          { id: 'weightClass', label: 'Weight Class', type: 'string' },
        ],
        rows: [
          { orderId: 'ORD-1', tagId: 't1', weightClass: 'heavy' },
          { orderId: 'ORD-1', tagId: 't2', weightClass: 'light' },
          { orderId: 'ORD-2', tagId: 't2', weightClass: 'light' },
        ],
      },
    };
    const mnRelationships: StudioRelationship[] = [
      {
        id: 'rel-items-orders',
        sourceId: 'order_items',
        sourceField: 'orderId',
        targetId: 'orders',
        targetField: 'id',
        type: 'many-to-one',
      },
      {
        id: 'rel-orders-tags',
        sourceId: 'orders',
        sourceField: 'id',
        targetId: 'tags',
        targetField: 'id',
        type: 'many-to-many',
        junctionSourceId: 'order_tags',
        junctionSourceField: 'orderId',
        junctionTargetField: 'tagId',
      } as unknown as StudioRelationship,
    ];

    it('fails closed for an M:N REMOTE-endpoint dimension (tags.name) under an order_items anchor', () => {
      const support = analyzeChartSupport(
        'orders',
        'name', // x owned by the M:N remote endpoint `tags`
        ['total'], // y owned by `order_items` → anchor = order_items (plain many-to-one)
        undefined,
        'bar',
        mnDataSources,
        mnRelationships,
        [],
      );
      expect(support).toEqual({ supported: false, reason: 'mixed_cross_source_fields' });

      // ...and the row resolver short-circuits to [] rather than silently mis-attributing each
      // order_items row's total to one arbitrary tag link (the corruption this guard prevents).
      const resolved = resolveChartRowsForAggregation(
        ordersRows,
        'orders',
        'name',
        ['total'],
        undefined,
        mnDataSources,
        mnRelationships,
        [],
      );
      expect(resolved).toEqual([]);
    });

    it('fails closed for a JUNCTION-owned dimension (order_tags.weightClass) under an order_items anchor', () => {
      // When the dimension is owned by the junction source itself, the first-match lookup cannot
      // resolve junction-owned fields at all — every row would read `undefined`. Fail closed.
      const support = analyzeChartSupport(
        'orders',
        'weightClass', // x owned by the junction source `order_tags`
        ['total'], // y owned by `order_items` → anchor = order_items (plain many-to-one)
        undefined,
        'bar',
        mnDataSources,
        mnRelationships,
        [],
      );
      expect(support).toEqual({ supported: false, reason: 'mixed_cross_source_fields' });
    });

    it('still SUPPORTS the same M:N dimension when the measure is widget-owned (iter-7 junction anchor unaffected)', () => {
      // Regression guard: the fail-closed check must NOT fire when the measure lives on the widget
      // source — that topology junction-anchors and fans the widget-owned measure out correctly.
      const support = analyzeChartSupport(
        'orders',
        'name',
        [], // fieldless count — measure is (trivially) widget-owned
        undefined,
        'bar',
        mnDataSources,
        mnRelationships,
        [],
      );
      expect(support.supported).toBe(true);
      expect(support.anchorSourceId).toBe('order_tags');
    });
  });

  // ─── Finding 2 ───────────────────────────────────────────────────────────────
  // A junction-owned measure (`order_tags.weightClass`) combined with a grouping dimension owned
  // by a DIFFERENT M:N relationship's remote endpoint (`categories.name`, via a separate
  // `order_categories` junction) has no single grain: the chart anchors on `order_tags` (fanning
  // one row per orders↔tags link), but `categories.name` would be resolved via
  // `enrichRowsWithRelatedFields`'s first-match-only two-hop lookup through `order_categories` —
  // silently attributing every order to only ONE of its (possibly several) categories instead of
  // failing closed. `anchorIsPlainManyToOne` never fires for this shape (the anchor isn't a plain
  // many-to-one relationship), so without the dedicated guard `isSafeWidgetBridgeOwner` waves
  // `categories` through (it only asks whether SOME M:N relationship reaches it from `orders`, not
  // whether it's the SAME relationship the anchor is grained on).
  describe('finding 2 — junction-owned measure + cross-relationship grouping fails closed', () => {
    const twoJunctionDataSources: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
        rows: [{ id: 'o1' }, { id: 'o2' }],
      },
      tags: {
        id: 'tags',
        label: 'Tags',
        fields: [{ id: 'id', label: 'Tag ID', type: 'string' }],
        rows: [{ id: 't1' }, { id: 't2' }],
      },
      order_tags: {
        id: 'order_tags',
        label: 'Order Tags',
        fields: [
          { id: 'orderId', label: 'Order ID', type: 'string' },
          { id: 'tagId', label: 'Tag ID', type: 'string' },
          { id: 'weightClass', label: 'Weight Class', type: 'string' },
        ],
        rows: [
          { orderId: 'o1', tagId: 't1', weightClass: 'heavy' },
          { orderId: 'o2', tagId: 't2', weightClass: 'light' },
        ],
      },
      categories: {
        id: 'categories',
        label: 'Categories',
        fields: [
          { id: 'id', label: 'Category ID', type: 'string' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: [
          { id: 'cat1', name: 'Electronics' },
          { id: 'cat2', name: 'Furniture' },
        ],
      },
      order_categories: {
        id: 'order_categories',
        label: 'Order Categories',
        fields: [
          { id: 'orderId', label: 'Order ID', type: 'string' },
          { id: 'categoryId', label: 'Category ID', type: 'string' },
        ],
        // order o1 has TWO categories — the fan-out a first-match-only lookup would collapse.
        rows: [
          { orderId: 'o1', categoryId: 'cat1' },
          { orderId: 'o1', categoryId: 'cat2' },
          { orderId: 'o2', categoryId: 'cat1' },
        ],
      },
    };
    const relTags: StudioRelationship = {
      id: 'rel-orders-tags',
      type: 'many-to-many',
      sourceId: 'orders',
      sourceField: 'id',
      targetId: 'tags',
      targetField: 'id',
      junctionSourceId: 'order_tags',
      junctionSourceField: 'orderId',
      junctionTargetField: 'tagId',
    } as unknown as StudioRelationship;
    const relCategories: StudioRelationship = {
      id: 'rel-orders-categories',
      type: 'many-to-many',
      sourceId: 'orders',
      sourceField: 'id',
      targetId: 'categories',
      targetField: 'id',
      junctionSourceId: 'order_categories',
      junctionSourceField: 'orderId',
      junctionTargetField: 'categoryId',
    } as unknown as StudioRelationship;

    it("fails closed for a dimension owned by a DIFFERENT M:N relationship's remote endpoint", () => {
      const support = analyzeChartSupport(
        'orders',
        'name', // x owned by `categories`, reached via the order_categories junction
        ['weightClass'], // y owned by the `order_tags` JUNCTION itself
        undefined,
        'bar',
        twoJunctionDataSources,
        [relTags, relCategories],
        [],
      );
      expect(support).toEqual({ supported: false, reason: 'mixed_cross_source_fields' });

      // ...and the row resolver short-circuits to [] rather than silently mis-attributing order
      // o1's weightClass to only one of its two categories.
      const resolved = resolveChartRowsForAggregation(
        [{ id: 'o1' }, { id: 'o2' }],
        'orders',
        'name',
        ['weightClass'],
        undefined,
        twoJunctionDataSources,
        [relTags, relCategories],
        [],
      );
      expect(resolved).toEqual([]);
    });

    it("still SUPPORTS a dimension owned by the SAME relationship's own remote endpoint (regression guard)", () => {
      // Add a physical field on `tags` (the relTags relationship's own remote endpoint) and
      // group by it instead — this is the topology `resolveRowsAtGrain`'s M:N branch already
      // joins in correctly as part of its merge, so it must remain supported.
      const dataSourcesWithTagLabel: Record<string, StudioDataSource> = {
        ...twoJunctionDataSources,
        tags: {
          ...twoJunctionDataSources.tags,
          fields: [
            ...twoJunctionDataSources.tags.fields,
            { id: 'label', label: 'Label', type: 'string' },
          ],
          rows: [
            { id: 't1', label: 'Priority' },
            { id: 't2', label: 'Normal' },
          ],
        },
      };
      const support = analyzeChartSupport(
        'orders',
        'label', // x owned by `tags` — the SAME relationship the junction-owned measure anchors on
        ['weightClass'],
        undefined,
        'bar',
        dataSourcesWithTagLabel,
        [relTags, relCategories],
        [],
      );
      expect(support.supported).toBe(true);
      expect(support.anchorSourceId).toBe('order_tags');
    });
  });

  // ─── Finding 2.12 ────────────────────────────────────────────────────────────
  // `mnDataSources`/`mnRelationships` (defined above) model a many-to-many `orders` ↔
  // `tags` relationship bridged through the `order_tags` junction. When the junction is
  // INCOMPLETE (missing `junctionSourceField` and/or `junctionTargetField`), the junction
  // cannot actually be used to join rows — `findJoinPath` (`dataSourceGraph.ts:133`) already
  // treats such a relationship as unusable. Before this fix, `analyzeChartSupport` only
  // checked `junctionSourceId` at its junction-anchor selection sites (and in
  // `isSafeWidgetBridgeOwner`/`findDirectFieldOwner`), so an incomplete junction was silently
  // treated as usable: the widget-owned-measure case reported `supported: true` with
  // `anchorSourceId: 'order_tags'`, even though `grainResolution.ts`'s M:N branch requires
  // complete junction fields and would fall through to the first-match-only
  // `enrichRowsWithRelatedFields` fallback — resolving the dimension to `undefined` (a blank
  // bucket) instead of failing closed. The fix requires `junctionSourceField &&
  // junctionTargetField` before treating any junction as usable, so these configurations must
  // now report unsupported instead of silently falling through.
  describe('finding 2.12 — incomplete junction (missing junction fields) fails closed', () => {
    const ordersRows = [{ id: 'ORD-1' }, { id: 'ORD-2' }];
    const mnDataSources: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
        rows: ordersRows,
      },
      tags: {
        id: 'tags',
        label: 'Tags',
        fields: [
          { id: 'id', label: 'Tag ID', type: 'string' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: [
          { id: 't1', name: 'A' },
          { id: 't2', name: 'B' },
        ],
      },
      order_tags: {
        id: 'order_tags',
        label: 'Order Tags',
        fields: [
          { id: 'orderId', label: 'Order ID', type: 'string' },
          { id: 'tagId', label: 'Tag ID', type: 'string' },
          { id: 'weightClass', label: 'Weight Class', type: 'string' },
        ],
        rows: [
          { orderId: 'ORD-1', tagId: 't1', weightClass: 'heavy' },
          { orderId: 'ORD-1', tagId: 't2', weightClass: 'light' },
          { orderId: 'ORD-2', tagId: 't2', weightClass: 'light' },
        ],
      },
    };

    // Missing `junctionSourceField` — the previous bug's trigger case.
    const missingSourceFieldRelationships: StudioRelationship[] = [
      {
        id: 'rel-orders-tags',
        sourceId: 'orders',
        sourceField: 'id',
        targetId: 'tags',
        targetField: 'id',
        type: 'many-to-many',
        junctionSourceId: 'order_tags',
        junctionTargetField: 'tagId',
      } as unknown as StudioRelationship,
    ];

    // Missing `junctionTargetField` instead — the other half of the completeness check.
    const missingTargetFieldRelationships: StudioRelationship[] = [
      {
        id: 'rel-orders-tags',
        sourceId: 'orders',
        sourceField: 'id',
        targetId: 'tags',
        targetField: 'id',
        type: 'many-to-many',
        junctionSourceId: 'order_tags',
        junctionSourceField: 'orderId',
      } as unknown as StudioRelationship,
    ];

    it.each([
      ['missing junctionSourceField', missingSourceFieldRelationships],
      ['missing junctionTargetField', missingTargetFieldRelationships],
    ])(
      'fails closed for a widget-owned-measure M:N REMOTE-endpoint dimension (%s)',
      (_label, relationships) => {
        const support = analyzeChartSupport(
          'orders',
          'name', // x owned by the M:N remote endpoint `tags`, reached only via the junction
          [], // fieldless count — measure is (trivially) widget-owned
          undefined,
          'bar',
          mnDataSources,
          relationships,
          [],
        );
        // The dimension field cannot be resolved through an incomplete junction at all, so the
        // guard fails closed instead of the pre-fix `supported: true, anchorSourceId:
        // 'order_tags'` (which silently produced a blank/undefined bucket downstream).
        expect(support.supported).toBe(false);
        expect(support.anchorSourceId).toBeUndefined();
      },
    );

    it.each([
      ['missing junctionSourceField', missingSourceFieldRelationships],
      ['missing junctionTargetField', missingTargetFieldRelationships],
    ])(
      'fails closed for a widget-owned-measure JUNCTION-owned dimension (%s)',
      (_label, relationships) => {
        const support = analyzeChartSupport(
          'orders',
          'weightClass', // x owned by the junction source `order_tags` itself
          [],
          undefined,
          'bar',
          mnDataSources,
          relationships,
          [],
        );
        expect(support.supported).toBe(false);
      },
    );

    it('still SUPPORTS the same M:N dimension when the junction is complete (control)', () => {
      const completeRelationships: StudioRelationship[] = [
        {
          id: 'rel-orders-tags',
          sourceId: 'orders',
          sourceField: 'id',
          targetId: 'tags',
          targetField: 'id',
          type: 'many-to-many',
          junctionSourceId: 'order_tags',
          junctionSourceField: 'orderId',
          junctionTargetField: 'tagId',
        } as unknown as StudioRelationship,
      ];
      const support = analyzeChartSupport(
        'orders',
        'name',
        [],
        undefined,
        'bar',
        mnDataSources,
        completeRelationships,
        [],
      );
      expect(support.supported).toBe(true);
      expect(support.anchorSourceId).toBe('order_tags');
    });
  });

  // ─── Finding 6 ─────────────────────────────────────────────────────────────
  // A one-to-one relationship has no fan-out in EITHER direction (each side has at most one
  // matching row), so which side a schema author declared as `sourceId` vs `targetId` must not
  // change whether the configuration is supported — matching the direction-independent check
  // `isSafeWidgetBridgeOwner` already applies to a 1:1 owner. Before the fix, the anchor-selection
  // check required the SAME direction a many-to-one relationship uses (`sourceId === ySourceId &&
  // targetId === widgetSourceId`), so the identical 1:1 relationship declared the other way
  // around fell through to no anchor switch and was rejected.
  describe('finding 6 — 1:1 relationship support is direction-independent', () => {
    const widgetRows = [
      { id: 'w1', shippingId: 's1' },
      { id: 'w2', shippingId: 's2' },
    ];
    const oneToOneDataSources: Record<string, StudioDataSource> = {
      widget_source: {
        id: 'widget_source',
        label: 'Widget Source',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'shippingId', label: 'Shipping ID', type: 'string' },
        ],
        rows: widgetRows,
      },
      shipping: {
        id: 'shipping',
        label: 'Shipping',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'cost', label: 'Cost', type: 'number' },
        ],
        rows: [
          { id: 's1', cost: 10 },
          { id: 's2', cost: 20 },
        ],
      },
    };

    it('supports a 1:1 measure declared with the widget as `targetId` (forward direction)', () => {
      const forwardRel: StudioRelationship = {
        id: 'rel-forward',
        type: 'one-to-one',
        sourceId: 'shipping',
        sourceField: 'id',
        targetId: 'widget_source',
        targetField: 'shippingId',
      };
      const support = analyzeChartSupport(
        'widget_source',
        undefined,
        ['cost'],
        undefined,
        'bar',
        oneToOneDataSources,
        [forwardRel],
        [],
      );
      expect(support.supported).toBe(true);
      expect(support.anchorSourceId).toBe('shipping');
    });

    it('ALSO supports the identical 1:1 measure declared with the widget as `sourceId` (reverse direction, finding 6)', () => {
      const reverseRel: StudioRelationship = {
        id: 'rel-reverse',
        type: 'one-to-one',
        sourceId: 'widget_source',
        sourceField: 'shippingId',
        targetId: 'shipping',
        targetField: 'id',
      };
      const support = analyzeChartSupport(
        'widget_source',
        undefined,
        ['cost'],
        undefined,
        'bar',
        oneToOneDataSources,
        [reverseRel],
        [],
      );
      // Before the fix this reported `supported: false` even though the forward-declared
      // equivalent above is accepted — a direction-dependent inconsistency.
      expect(support.supported).toBe(true);
      expect(support.anchorSourceId).toBe('shipping');

      // The row resolver must actually produce the joined value too, not just report supported.
      const resolved = resolveChartRowsForAggregation(
        widgetRows,
        'widget_source',
        undefined,
        ['cost'],
        undefined,
        oneToOneDataSources,
        [reverseRel],
        [],
      );
      expect(resolved).toHaveLength(2);
      expect(resolved.map((r) => r.cost).sort()).toEqual([10, 20]);
    });
  });
});

describe('resolveChartRowsForAggregation bridge case', () => {
  const customers = [
    { id: 'CUS-1', country: 'Germany' },
    { id: 'CUS-2', country: 'France' },
  ];
  const orders = [
    { id: 'ORD-1', customerId: 'CUS-1' },
    { id: 'ORD-2', customerId: 'CUS-1' },
    { id: 'ORD-3', customerId: 'CUS-2' },
  ];
  const orderItems = [
    { id: 'OI-1', orderId: 'ORD-1', total: 30 },
    { id: 'OI-2', orderId: 'ORD-1', total: 70 },
    { id: 'OI-3', orderId: 'ORD-2', total: 50 },
    { id: 'OI-4', orderId: 'ORD-3', total: 70 },
  ];

  const dataSources: Record<string, StudioDataSource> = {
    customers: {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'Customer ID', type: 'string' },
        { id: 'country', label: 'Country', type: 'string' },
      ],
      rows: customers,
    },
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'Order ID', type: 'string' },
        { id: 'customerId', label: 'Customer ID', type: 'string' },
      ],
      rows: orders,
    },
    orderItems: {
      id: 'orderItems',
      label: 'Order Items',
      fields: [
        { id: 'id', label: 'Order Item ID', type: 'string' },
        { id: 'orderId', label: 'Order ID', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: orderItems,
    },
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-orders-customers',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
    {
      id: 'rel-orderitems-orders',
      sourceId: 'orderItems',
      sourceField: 'orderId',
      targetId: 'orders',
      targetField: 'id',
      type: 'many-to-one',
    },
  ];

  it('aggregates many-side rows by a one-side field bridged through the widget source', () => {
    const resolvedRows = resolveChartRowsForAggregation(
      orders,
      'orders',
      'country',
      ['total'],
      undefined,
      dataSources,
      relationships,
      [],
    );

    expect(aggregateByField(resolvedRows, 'country', 'total')).toEqual({
      labels: ['France', 'Germany'],
      values: [70, 150],
    });
  });

  it('supports a bridged seriesField from the widget source onto many-side anchor rows', () => {
    const resolvedRows = resolveChartRowsForAggregation(
      orders,
      'orders',
      'country',
      ['total'],
      'customerId',
      dataSources,
      relationships,
      [],
    );

    expect(aggregateByTwoFields(resolvedRows, 'country', 'customerId', 'total')).toEqual({
      labels: ['France', 'Germany'],
      seriesNames: ['CUS-1', 'CUS-2'],
      seriesData: {
        'CUS-1': [null, 150],
        'CUS-2': [70, null],
      },
    });
  });
});

// ─── applyRankToSeriesFieldData ───────────────────────────────────────────────

describe('applyRankToSeriesFieldData', () => {
  const data = {
    labels: ['Q1', 'Q2', 'Q3'],
    seriesNames: ['Alpha', 'Beta', 'Gamma'],
    seriesData: {
      Alpha: [10, 20, 30], // total 60
      Beta: [50, 10, 10], // total 70
      Gamma: [5, 5, 5], // total 15
    },
  };

  function makeLocalFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
    return {
      id: 'f1',
      field: '',
      operator: 'equals',
      value: 3,
      scope: { kind: 'widget', widgetId: 'w1' },
      ...overrides,
    } as StudioFilterState;
  }

  it('null filter returns original data unchanged', () => {
    expect(applyRankToSeriesFieldData(data, null)).toBe(data);
  });

  it('top 2 keeps the 2 series with highest total', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 2, rankDirection: 'top' }),
    );
    expect(result.seriesNames).toHaveLength(2);
    expect(result.seriesNames).toContain('Beta'); // 70
    expect(result.seriesNames).toContain('Alpha'); // 60
    expect(result.seriesNames).not.toContain('Gamma');
  });

  it('bottom 1 keeps the series with lowest total', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 1, rankDirection: 'bottom' }),
    );
    expect(result.seriesNames).toEqual(['Gamma']);
  });

  it('removes excluded series from seriesData as well', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }),
    );
    expect(Object.keys(result.seriesData)).not.toContain('Alpha');
    expect(Object.keys(result.seriesData)).not.toContain('Gamma');
    expect(Object.keys(result.seriesData)).toContain('Beta');
  });

  it('preserves labels unchanged', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }),
    );
    expect(result.labels).toEqual(data.labels);
  });

  it('N=0 is a no-op', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 0, rankDirection: 'top' }),
    );
    expect(result).toBe(data);
  });

  it('N >= length returns all series', () => {
    const result = applyRankToSeriesFieldData(
      data,
      makeLocalFilter({ filterMode: 'rank', value: 99, rankDirection: 'top' }),
    );
    expect(result.seriesNames).toHaveLength(3);
  });

  // Regression (finding 1.13): a numeric split-by field (e.g. a year column) keeps genuine
  // `number` names in `seriesNames`, but `seriesData` keys are always strings. The membership
  // test must coerce both sides so the kept series' data column survives — otherwise the
  // series id survives while its data is dropped, and the renderers crash on `undefined`.
  it('keeps the data column for a kept numeric split-by series', () => {
    const numericData = {
      labels: ['Q1', 'Q2'],
      seriesNames: [2023, 2024, 2025] as (string | number)[],
      seriesData: {
        2023: [10, 10], // total 20
        2024: [50, 50], // total 100 (highest)
        2025: [5, 5], // total 10
      },
    };
    const result = applyRankToSeriesFieldData(
      numericData,
      makeLocalFilter({ filterMode: 'rank', value: 1, rankDirection: 'top' }),
    );
    expect(result.seriesNames).toEqual([2024]);
    // The surviving series' data column must not be dropped (the pre-fix crash).
    expect(result.seriesData[2024]).toEqual([50, 50]);
    expect(Object.keys(result.seriesData)).toEqual(['2024']);
  });
});

// ─── aggregateByTwoFields ─────────────────────────────────────────────────────

describe('aggregateByTwoFields', () => {
  const rows = [
    { region: 'North', product: 'A', revenue: 100 },
    { region: 'South', product: 'A', revenue: 50 },
    { region: 'North', product: 'B', revenue: 200 },
    { region: 'North', product: 'A', revenue: 75 }, // second North/A row → sum 175
    { region: 'South', product: 'B', revenue: 30 },
  ];

  it('produces one label per unique x value', () => {
    const result = aggregateByTwoFields(rows, 'region', 'product', 'revenue');
    expect(result.labels.sort()).toEqual(['North', 'South']);
  });

  it('produces one series name per unique series field value', () => {
    const result = aggregateByTwoFields(rows, 'region', 'product', 'revenue');
    expect(result.seriesNames.sort()).toEqual(['A', 'B']);
  });

  it('sums values for the same x+series combination', () => {
    const result = aggregateByTwoFields(rows, 'region', 'product', 'revenue');
    const northIdx = result.labels.indexOf('North');
    // North/A: 100 + 75 = 175
    expect(result.seriesData.A[northIdx]).toBe(175);
  });

  it('fills missing x+series combinations with null', () => {
    // There is no South/B row in the original data — wait, there is. Let me use a sparser set.
    const sparse = [
      { region: 'North', product: 'A', revenue: 100 },
      { region: 'South', product: 'B', revenue: 50 },
    ];
    const result = aggregateByTwoFields(sparse, 'region', 'product', 'revenue');
    const northIdx = result.labels.indexOf('North');
    const southIdx = result.labels.indexOf('South');
    expect(result.seriesData.B[northIdx]).toBeNull(); // North has no product B
    expect(result.seriesData.A[southIdx]).toBeNull(); // South has no product A
  });

  // ─── yAggregation honored (Part A item 5) ───────────────────────────────────

  it('averages per cell when yAggregation is "avg" (not sum)', () => {
    const result = aggregateByTwoFields(
      rows,
      'region',
      'product',
      'revenue',
      undefined,
      undefined,
      undefined,
      undefined,
      'avg',
    );
    const northIdx = result.labels.indexOf('North');
    // North/A: 100 and 75 → avg 87.5 (sum would be 175)
    expect(result.seriesData.A[northIdx]).toBe(87.5);
  });

  it('takes the max per cell when yAggregation is "max"', () => {
    const result = aggregateByTwoFields(
      rows,
      'region',
      'product',
      'revenue',
      undefined,
      undefined,
      undefined,
      undefined,
      'max',
    );
    const northIdx = result.labels.indexOf('North');
    expect(result.seriesData.A[northIdx]).toBe(100); // max(100, 75)
  });

  it('defaults to sum when yAggregation is omitted (backward compatible)', () => {
    const result = aggregateByTwoFields(rows, 'region', 'product', 'revenue');
    const northIdx = result.labels.indexOf('North');
    expect(result.seriesData.A[northIdx]).toBe(175);
  });

  // ─── null handling (finding 1.4) ─────────────────────────────────────────────

  it('skips null values from a cell avg (not coerced to 0)', () => {
    const sparse = [
      { region: 'North', product: 'A', revenue: 10 },
      { region: 'North', product: 'A', revenue: null },
      { region: 'North', product: 'A', revenue: 20 },
    ];
    const result = aggregateByTwoFields(
      sparse,
      'region',
      'product',
      'revenue',
      undefined,
      undefined,
      undefined,
      undefined,
      'avg',
    );
    const northIdx = result.labels.indexOf('North');
    // avg(10, 20) = 15 — NOT (10 + 0 + 20) / 3 = 10
    expect(result.seriesData.A[northIdx]).toBe(15);
  });

  // ─── non-numeric measure fallback (finding 2.4) ──────────────────────────────
  // `aggregateByField` and `aggregateMultipleSeries` both pre-detect a non-numeric
  // yField and fall back to counting rows. `aggregateByTwoFields` (the split-by
  // path) lacked this fallback: `coerceAggregateValue` skips every non-numeric
  // cell, so a split-by chart on a string measure rendered every cell `null`
  // (blank chart) instead of falling back to counts like its siblings.
  it('falls back to counting rows when the measure field is non-numeric, like its siblings', () => {
    const stringRows = [
      { region: 'North', product: 'A', label: 'foo' },
      { region: 'North', product: 'A', label: 'bar' },
      { region: 'North', product: 'B', label: 'baz' },
      { region: 'South', product: 'A', label: 'qux' },
    ];
    const result = aggregateByTwoFields(stringRows, 'region', 'product', 'label');
    const northIdx = result.labels.indexOf('North');
    const southIdx = result.labels.indexOf('South');
    // Non-numeric measure → pre-detect flips to count → row tallies, not null cells.
    expect(result.seriesData.A[northIdx]).toBe(2);
    expect(result.seriesData.B[northIdx]).toBe(1);
    expect(result.seriesData.A[southIdx]).toBe(1);
  });

  it('still honors an explicit "count" yAggregation for a non-numeric measure', () => {
    const stringRows = [
      { region: 'North', product: 'A', label: 'foo' },
      { region: 'North', product: 'A', label: 'bar' },
    ];
    const result = aggregateByTwoFields(
      stringRows,
      'region',
      'product',
      'label',
      undefined,
      undefined,
      undefined,
      undefined,
      'count',
    );
    const northIdx = result.labels.indexOf('North');
    expect(result.seriesData.A[northIdx]).toBe(2);
  });

  // T3.2(a): unlike the xField (guarded by `isEmptyXValue` — dropped entirely, so its
  // bucket label is never rendered), a null/undefined `seriesField` value is NOT
  // dropped — it becomes its own "(empty)" series bucket. Every caller previously
  // omitted `localeText`, so a non-English locale always showed the English literal.
  it('renders a null seriesField value using the translated empty-category label (T3.2)', () => {
    const rows = [
      { region: 'North', product: 'A', revenue: 10 },
      { region: 'North', product: null, revenue: 5 },
    ];
    const result = aggregateByTwoFields(
      rows,
      'region',
      'product',
      'revenue',
      undefined,
      undefined,
      undefined,
      undefined,
      'sum',
      frLocaleText,
    );
    expect(result.seriesNames).toContain(frLocaleText.chartEmptyCategoryLabel);
    expect(result.seriesNames).not.toContain('(empty)');
  });
});

// ─── aggregateMultipleSeries ──────────────────────────────────────────────────

describe('aggregateMultipleSeries', () => {
  const rows = [
    { month: '2024-01', revenue: 100, cost: 60 },
    { month: '2024-02', revenue: 200, cost: 90 },
    { month: '2024-01', revenue: 50, cost: 30 }, // second Jan row
  ];

  it('returns one series entry per yField', () => {
    const result = aggregateMultipleSeries(rows, 'month', ['revenue', 'cost']);
    expect(result.series).toHaveLength(2);
    expect(result.series.map((s) => s.fieldId).sort()).toEqual(['cost', 'revenue']);
  });

  it('produces one label per unique x value', () => {
    const result = aggregateMultipleSeries(rows, 'month', ['revenue', 'cost']);
    expect(result.labels.sort()).toEqual(['2024-01', '2024-02']);
  });

  it('sums values for duplicate x rows within each series', () => {
    const result = aggregateMultipleSeries(rows, 'month', ['revenue', 'cost']);
    const janIdx = result.labels.indexOf('2024-01');
    const revSeries = result.series.find((s) => s.fieldId === 'revenue')!;
    expect(revSeries.values[janIdx]).toBe(150); // 100 + 50
  });

  // Regression (H4): this used to assert `0`. A y-field absent from every row at a label
  // has NO value there — plotting it as a real 0-height bar/point is a fabricated
  // measurement. `null` lets the renderer draw a gap instead.
  it('fills null (not 0) for a missing y value', () => {
    const sparse = [
      { month: '2024-01', revenue: 100 }, // no 'cost' field
    ];
    const result = aggregateMultipleSeries(sparse, 'month', ['revenue', 'cost']);
    const costSeries = result.series.find((s) => s.fieldId === 'cost')!;
    expect(costSeries.values[0]).toBe(null);
  });

  it('returns empty series when yFields is empty', () => {
    const result = aggregateMultipleSeries(rows, 'month', []);
    expect(result.series).toHaveLength(0);
    expect(result.labels.length).toBeGreaterThan(0); // labels still computed
  });

  it('applies xGroupBy date truncation', () => {
    const dated = [
      { date: '2024-03-15', revenue: 100 },
      { date: '2024-03-28', revenue: 200 },
      { date: '2024-04-05', revenue: 50 },
    ];
    const result = aggregateMultipleSeries(dated, 'date', ['revenue'], 'month');
    expect(result.labels).toContain('2024-03');
    expect(result.labels).toContain('2024-04');
    const marIdx = result.labels.indexOf('2024-03');
    expect(result.series[0].values[marIdx]).toBe(300); // 100 + 200
  });

  it('auto-promotes to count when yField is a string (avoids NaN)', () => {
    const stringRows = [
      { category: 'A', id: 'contact-1' },
      { category: 'A', id: 'contact-2' },
      { category: 'B', id: 'contact-3' },
    ];
    const result = aggregateMultipleSeries(stringRows, 'category', ['id']);
    const idSeries = result.series.find((s) => s.fieldId === 'id')!;
    // Should count occurrences, not produce NaN
    const aIdx = result.labels.indexOf('A');
    const bIdx = result.labels.indexOf('B');
    expect(idSeries.values[aIdx]).toBe(2);
    expect(idSeries.values[bIdx]).toBe(1);
    idSeries.values.forEach((v) => expect(Number.isNaN(v)).toBe(false));
  });

  it('counts string fields and sums numeric fields in the same call', () => {
    const mixed = [
      { dept: 'Eng', employee_id: 'e-1', salary: 80000 },
      { dept: 'Eng', employee_id: 'e-2', salary: 90000 },
      { dept: 'HR', employee_id: 'e-3', salary: 70000 },
    ];
    const result = aggregateMultipleSeries(mixed, 'dept', ['employee_id', 'salary']);
    const idSeries = result.series.find((s) => s.fieldId === 'employee_id')!;
    const salSeries = result.series.find((s) => s.fieldId === 'salary')!;
    const engIdx = result.labels.indexOf('Eng');
    // employee_id is a string → counted
    expect(idSeries.values[engIdx]).toBe(2);
    // salary is numeric → summed
    expect(salSeries.values[engIdx]).toBe(170000);
  });

  // ─── yAggregation honored (Part A item 5) ───────────────────────────────────

  it('averages each series when yAggregation is "avg" (not sum)', () => {
    const result = aggregateMultipleSeries(
      rows,
      'month',
      ['revenue', 'cost'],
      undefined,
      undefined,
      undefined,
      undefined,
      'avg',
    );
    const janIdx = result.labels.indexOf('2024-01');
    const revSeries = result.series.find((s) => s.fieldId === 'revenue')!;
    const costSeries = result.series.find((s) => s.fieldId === 'cost')!;
    // Jan revenue: 100 and 50 → avg 75 (sum would be 150)
    expect(revSeries.values[janIdx]).toBe(75);
    // Jan cost: 60 and 30 → avg 45
    expect(costSeries.values[janIdx]).toBe(45);
  });

  it('keeps non-numeric fields as count even when yAggregation is "avg"', () => {
    const mixed = [
      { dept: 'Eng', employee_id: 'e-1', salary: 80000 },
      { dept: 'Eng', employee_id: 'e-2', salary: 90000 },
      { dept: 'HR', employee_id: 'e-3', salary: 70000 },
    ];
    const result = aggregateMultipleSeries(
      mixed,
      'dept',
      ['employee_id', 'salary'],
      undefined,
      undefined,
      undefined,
      undefined,
      'avg',
    );
    const idSeries = result.series.find((s) => s.fieldId === 'employee_id')!;
    const salSeries = result.series.find((s) => s.fieldId === 'salary')!;
    const engIdx = result.labels.indexOf('Eng');
    // employee_id stays a count (string field) regardless of yAggregation
    expect(idSeries.values[engIdx]).toBe(2);
    // salary is averaged: (80000 + 90000) / 2
    expect(salSeries.values[engIdx]).toBe(85000);
  });

  // ─── per-field aggregation map (finding 1.4) ────────────────────────────────

  it('honours a per-field aggregation map (each series its own fn)', () => {
    const result = aggregateMultipleSeries(
      rows,
      'month',
      ['revenue', 'cost'],
      undefined,
      undefined,
      undefined,
      undefined,
      { revenue: 'avg', cost: 'sum' },
    );
    const janIdx = result.labels.indexOf('2024-01');
    const revSeries = result.series.find((s) => s.fieldId === 'revenue')!;
    const costSeries = result.series.find((s) => s.fieldId === 'cost')!;
    // Jan revenue: avg(100, 50) = 75; Jan cost: sum(60, 30) = 90
    expect(revSeries.values[janIdx]).toBe(75);
    expect(costSeries.values[janIdx]).toBe(90);
  });

  it('defaults map-absent fields to sum', () => {
    const result = aggregateMultipleSeries(
      rows,
      'month',
      ['revenue', 'cost'],
      undefined,
      undefined,
      undefined,
      undefined,
      { revenue: 'max' }, // cost not in the map → sum
    );
    const janIdx = result.labels.indexOf('2024-01');
    const revSeries = result.series.find((s) => s.fieldId === 'revenue')!;
    const costSeries = result.series.find((s) => s.fieldId === 'cost')!;
    expect(revSeries.values[janIdx]).toBe(100); // max(100, 50)
    expect(costSeries.values[janIdx]).toBe(90); // sum(60, 30)
  });

  it('still promotes a non-numeric field to count even when the map names another fn', () => {
    const mixed = [
      { dept: 'Eng', employee_id: 'e-1', salary: 80000 },
      { dept: 'Eng', employee_id: 'e-2', salary: 90000 },
    ];
    const result = aggregateMultipleSeries(
      mixed,
      'dept',
      ['employee_id', 'salary'],
      undefined,
      undefined,
      undefined,
      undefined,
      { employee_id: 'avg', salary: 'avg' },
    );
    const engIdx = result.labels.indexOf('Eng');
    const idSeries = result.series.find((s) => s.fieldId === 'employee_id')!;
    const salSeries = result.series.find((s) => s.fieldId === 'salary')!;
    expect(idSeries.values[engIdx]).toBe(2); // string → count wins over map's 'avg'
    expect(salSeries.values[engIdx]).toBe(85000); // avg(80000, 90000)
  });

  it('skips null values from avg instead of coercing them to 0 (finding 1.4)', () => {
    const withNulls = [
      { month: '2024-01', revenue: 10 },
      { month: '2024-01', revenue: null },
      { month: '2024-01', revenue: 20 },
    ];
    const result = aggregateMultipleSeries(
      withNulls,
      'month',
      ['revenue'],
      undefined,
      undefined,
      undefined,
      undefined,
      'avg',
    );
    const janIdx = result.labels.indexOf('2024-01');
    const revSeries = result.series.find((s) => s.fieldId === 'revenue')!;
    // avg(10, 20) = 15 — NOT (10 + 0 + 20) / 3 = 10
    expect(revSeries.values[janIdx]).toBe(15);
  });
});

// ─── aggregateBlendedSeries (cross-source blending) ────────────────────────────

describe('aggregateBlendedSeries', () => {
  // Two independent fact tables sharing only the categorical "segment" axis.
  const deals = [
    { segment: 'Enterprise', pipeline: 500 },
    { segment: 'SMB', pipeline: 200 },
    { segment: 'Enterprise', pipeline: 300 },
  ];
  const orders = [
    { segment: 'Enterprise', revenue: 1000 },
    { segment: 'Mid-Market', revenue: 400 },
  ];

  it('aggregates each series within its own rows and aligns on the shared axis', () => {
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'pipeline', rows: deals },
        { fieldId: 'revenue', rows: orders },
      ],
      'segment',
    );
    const ent = result.labels.indexOf('Enterprise');
    const pipeline = result.series[0];
    const revenue = result.series[1];
    expect(pipeline.values[ent]).toBe(800); // 500 + 300, from deals
    expect(revenue.values[ent]).toBe(1000); // from orders
  });

  // Regression (H4): this used to assert `0` for the missing combinations. "This source has
  // no row in this category" is absence of data, not a measured zero — matching
  // `aggregateMultipleSeries`, whose fill this one is documented to follow.
  it('outer-joins labels across sources, filling null for missing combinations', () => {
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'pipeline', rows: deals },
        { fieldId: 'revenue', rows: orders },
      ],
      'segment',
    );
    // Union of segments: Enterprise, SMB (deals only), Mid-Market (orders only)
    expect([...result.labels].sort()).toEqual(['Enterprise', 'Mid-Market', 'SMB']);
    const smb = result.labels.indexOf('SMB');
    const mid = result.labels.indexOf('Mid-Market');
    expect(result.series[1].values[smb]).toBe(null); // no revenue for SMB
    expect(result.series[0].values[mid]).toBe(null); // no pipeline for Mid-Market
  });

  it('preserves series order and count 1:1 even with a shared field id', () => {
    const a = [{ segment: 'X', amount: 10 }];
    const b = [{ segment: 'X', amount: 25 }];
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'amount', rows: a },
        { fieldId: 'amount', rows: b },
      ],
      'segment',
    );
    expect(result.series).toHaveLength(2);
    const x = result.labels.indexOf('X');
    expect(result.series[0].values[x]).toBe(10);
    expect(result.series[1].values[x]).toBe(25);
  });

  it('honours per-series yAggregation independently', () => {
    const rows = [
      { segment: 'A', v: 10 },
      { segment: 'A', v: 30 },
    ];
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'v', rows, yAggregation: 'sum' },
        { fieldId: 'v', rows, yAggregation: 'avg' },
      ],
      'segment',
    );
    const a = result.labels.indexOf('A');
    expect(result.series[0].values[a]).toBe(40); // sum
    expect(result.series[1].values[a]).toBe(20); // avg
  });

  it('sorts labels by total value across series when sortBy is "value"', () => {
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'pipeline', rows: deals },
        { fieldId: 'revenue', rows: orders },
      ],
      'segment',
      undefined,
      'value',
      'desc',
    );
    // Enterprise has the largest combined total (800 + 1000) → first.
    expect(result.labels[0]).toBe('Enterprise');
  });
});

// ─── prepareScatterData ───────────────────────────────────────────────────────

describe('prepareScatterData', () => {
  it('maps rows to {x, y, id} objects', () => {
    const rows = [
      { sales: 10, profit: 3 },
      { sales: 20, profit: 7 },
    ];
    const result = prepareScatterData(rows, 'sales', 'profit');
    expect(result).toEqual([
      { x: 10, y: 3, id: 0 },
      { x: 20, y: 7, id: 1 },
    ]);
  });

  // Regression (M13): this used to assert the row was defaulted to `{ x: 0, y: 0 }`. That
  // fabricated a real point at the origin — a "Revenue vs Cost" scatter with 30% null costs
  // rendered a solid vertical stack on y = 0, distorting the correlation the chart exists to
  // show. Dropping matches every other chart family (`isEmptyXValue`) and `heatmap.ts`'s
  // T3.2b fix.
  it('drops a row whose x or y is null/undefined instead of plotting it at the origin', () => {
    expect(prepareScatterData([{ sales: null, profit: undefined }], 'sales', 'profit')).toEqual([]);
    expect(prepareScatterData([{ sales: 10, profit: null }], 'sales', 'profit')).toEqual([]);
    expect(prepareScatterData([{ sales: null, profit: 3 }], 'sales', 'profit')).toEqual([]);
  });

  it('drops a row whose x or y is non-numeric instead of passing NaN to the chart', () => {
    expect(prepareScatterData([{ sales: 'N/A', profit: 3 }], 'sales', 'profit')).toEqual([]);
    // An empty string is not a zero measurement either (`Number('')` would have been 0).
    expect(prepareScatterData([{ sales: '', profit: 3 }], 'sales', 'profit')).toEqual([]);
  });

  it('keeps a genuine 0 coordinate', () => {
    const result = prepareScatterData([{ sales: 0, profit: 0 }], 'sales', 'profit');
    expect(result).toEqual([{ x: 0, y: 0, id: 0 }]);
  });

  it('coerces string numbers to numeric values', () => {
    const result = prepareScatterData([{ x: '5', y: '3.5' }], 'x', 'y');
    expect(result[0].x).toBe(5);
    expect(result[0].y).toBe(3.5);
  });

  it('uses the row index as id', () => {
    const rows = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ];
    const result = prepareScatterData(rows, 'x', 'y');
    expect(result.map((p) => p.id)).toEqual([0, 1, 2]);
  });

  it('returns empty array for empty rows', () => {
    expect(prepareScatterData([], 'x', 'y')).toEqual([]);
  });
});

describe('aggregateSankey', () => {
  it('returns empty nodes and links for empty rows', () => {
    expect(aggregateSankey([], 'from', 'to', 'value')).toEqual({ nodes: [], links: [] });
  });

  it('builds a single link and its two nodes', () => {
    const rows = [{ from: 'A', to: 'B', value: 5 }];
    expect(aggregateSankey(rows, 'from', 'to', 'value')).toEqual({
      nodes: [{ id: 'A' }, { id: 'B' }],
      links: [{ source: 'A', target: 'B', value: 5 }],
    });
  });

  it('sums values for duplicate source→target pairs', () => {
    const rows = [
      { from: 'A', to: 'B', value: 5 },
      { from: 'A', to: 'B', value: 3 },
      { from: 'A', to: 'C', value: 2 },
    ];
    const result = aggregateSankey(rows, 'from', 'to', 'value');
    expect(result.nodes).toEqual([{ id: 'A' }, { id: 'B' }, { id: 'C' }]);
    expect(result.links).toEqual([
      { source: 'A', target: 'B', value: 8 },
      { source: 'A', target: 'C', value: 2 },
    ]);
  });

  it('preserves first-seen node order across multiple links', () => {
    const rows = [
      { from: 'B', to: 'C', value: 1 },
      { from: 'A', to: 'B', value: 1 },
    ];
    expect(aggregateSankey(rows, 'from', 'to', 'value').nodes).toEqual([
      { id: 'B' },
      { id: 'C' },
      { id: 'A' },
    ]);
  });

  it('skips self-loops, empty endpoints, and non-positive values', () => {
    const rows = [
      { from: 'A', to: 'A', value: 5 }, // self-loop
      { from: '', to: 'B', value: 5 }, // empty source
      { from: 'A', to: '', value: 5 }, // empty target
      { from: 'A', to: 'B', value: 0 }, // zero value
      { from: 'A', to: 'B', value: -4 }, // negative value
      { from: 'A', to: 'B', value: 7 }, // the only valid link
    ];
    expect(aggregateSankey(rows, 'from', 'to', 'value')).toEqual({
      nodes: [{ id: 'A' }, { id: 'B' }],
      links: [{ source: 'A', target: 'B', value: 7 }],
    });
  });

  it('coerces non-string node ids to strings', () => {
    const rows = [{ from: 2020, to: 2021, value: 10 }];
    const result = aggregateSankey(rows, 'from', 'to', 'value');
    expect(result.nodes).toEqual([{ id: '2020' }, { id: '2021' }]);
    expect(result.links).toEqual([{ source: '2020', target: '2021', value: 10 }]);
  });

  it('drops the back-edge of a direct cycle (A→B, B→A) to keep an acyclic graph', () => {
    const rows = [
      { from: 'A', to: 'B', value: 5 },
      { from: 'B', to: 'A', value: 3 },
    ];
    expect(aggregateSankey(rows, 'from', 'to', 'value')).toEqual({
      nodes: [{ id: 'A' }, { id: 'B' }],
      links: [{ source: 'A', target: 'B', value: 5 }],
    });
  });

  it('drops the closing edge of a longer cycle (A→B→C→A)', () => {
    const rows = [
      { from: 'A', to: 'B', value: 1 },
      { from: 'B', to: 'C', value: 1 },
      { from: 'C', to: 'A', value: 1 },
    ];
    const result = aggregateSankey(rows, 'from', 'to', 'value');
    expect(result.links).toEqual([
      { source: 'A', target: 'B', value: 1 },
      { source: 'B', target: 'C', value: 1 },
    ]);
    // Node 'A' still appears (as the source of A→B); no orphan nodes are emitted.
    expect(result.nodes).toEqual([{ id: 'A' }, { id: 'B' }, { id: 'C' }]);
  });
});

describe('aggregateFunnelReached', () => {
  const SEQUENCE = ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won'];

  it('produces a monotonically non-increasing "reached" series by construction', () => {
    // A deal at depth d counts toward stages 0..d. Mix of depths + outcomes.
    const rows = [
      { stage: 'Prospecting', stageReached: 0 },
      { stage: 'Closed Lost', stageReached: 0 }, // lost early, still passed Prospecting
      { stage: 'Qualification', stageReached: 1 },
      { stage: 'Closed Lost', stageReached: 2 }, // lost at Proposal depth
      { stage: 'Proposal', stageReached: 2 },
      { stage: 'Negotiation', stageReached: 3 },
      { stage: 'Closed Won', stageReached: 4 },
    ];
    const result = aggregateFunnelReached(rows, 'stage', 'stageReached', SEQUENCE, 'Closed Lost');

    const values = result.stages.map((s) => s.value);
    // reached≥0:7, ≥1:5, ≥2:4, ≥3:2, ≥4:1
    expect(values).toEqual([7, 5, 4, 2, 1]);
    // Non-increasing along the whole sequence.
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    }
    // widthPct (value / first) can never exceed 1.
    const first = values[0];
    values.forEach((v) => expect(v / first).toBeLessThanOrEqual(1));
  });

  it('excludes Closed Lost from the sequence and reports it as a separate exit total', () => {
    const rows = [
      { stage: 'Prospecting', stageReached: 0 },
      { stage: 'Closed Lost', stageReached: 1 },
      { stage: 'Closed Lost', stageReached: 2 },
      { stage: 'Closed Won', stageReached: 4 },
    ];
    const result = aggregateFunnelReached(rows, 'stage', 'stageReached', SEQUENCE, 'Closed Lost');

    // No funnel step is labelled Closed Lost.
    expect(result.stages.map((s) => s.label)).toEqual(SEQUENCE);
    // The two lost deals are reported as the exit total...
    expect(result.exitLabel).toBe('Closed Lost');
    expect(result.exitValue).toBe(2);
    // ...yet they still count toward the upper stages they passed through
    // (passed-through view, not double counting): reached≥0 = all 4 deals.
    expect(result.stages[0].value).toBe(4);
    expect(result.stages[1].value).toBe(3); // depths 1,2,4 reached ≥1
  });

  it('carries the per-stage snapshot count and step-conversion fraction', () => {
    const rows = [
      { stage: 'Prospecting', stageReached: 0 },
      { stage: 'Prospecting', stageReached: 0 },
      { stage: 'Qualification', stageReached: 1 },
      { stage: 'Closed Won', stageReached: 4 },
    ];
    const result = aggregateFunnelReached(rows, 'stage', 'stageReached', SEQUENCE, 'Closed Lost');

    expect(result.stages[0].snapshotValue).toBe(2); // two deals currently in Prospecting
    expect(result.stages[1].snapshotValue).toBe(1);
    expect(result.stages[0].stepConversion).toBeNull(); // first stage has no previous
    // reached≥0 = 4, reached≥1 = 2 → step conversion = 0.5
    expect(result.stages[1].stepConversion).toBeCloseTo(0.5);
  });

  it('returns empty stages with zero values for empty rows', () => {
    const result = aggregateFunnelReached([], 'stage', 'stageReached', SEQUENCE, 'Closed Lost');
    expect(result.stages).toHaveLength(SEQUENCE.length);
    result.stages.forEach((s) => expect(s.value).toBe(0));
    expect(result.exitValue).toBe(0);
  });
});

describe('clampWidthPct', () => {
  it('clamps values above 1 down to 1 (overflow guard)', () => {
    expect(clampWidthPct(1.05)).toBe(1);
    expect(clampWidthPct(42)).toBe(1);
  });

  it('passes through valid fractions and floors negatives/NaN to 0', () => {
    expect(clampWidthPct(0.5)).toBe(0.5);
    expect(clampWidthPct(1)).toBe(1);
    expect(clampWidthPct(0)).toBe(0);
    expect(clampWidthPct(-0.3)).toBe(0);
    expect(clampWidthPct(Number.NaN)).toBe(0);
  });
});

describe('aggregateHeatmap axis ordering', () => {
  const rows = [
    { stage: 'Negotiation', owner: 'Bob', days: 4 },
    { stage: 'Prospecting', owner: 'Amy', days: 2 },
    { stage: 'Proposal', owner: 'Amy', days: 6 },
    { stage: 'Prospecting', owner: 'Bob', days: 8 },
  ];
  const stageOrder = ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won'];

  it('orders the x-axis by the field orderedValues, not alphabetically', () => {
    const data = aggregateHeatmap(rows, 'stage', 'owner', 'days', undefined, 'avg', stageOrder);
    // Alphabetical would be ['Negotiation', 'Proposal', 'Prospecting']; pipeline order differs.
    expect(data.xLabels).toEqual(['Prospecting', 'Proposal', 'Negotiation']);
  });

  it('falls back to a natural sort when no order is provided', () => {
    const data = aggregateHeatmap(rows, 'stage', 'owner', 'days', undefined, 'avg');
    expect(data.xLabels).toEqual(['Negotiation', 'Proposal', 'Prospecting']);
  });

  it('appends labels missing from orderedValues after the known ones', () => {
    const withExtra = [...rows, { stage: 'Closed Lost', owner: 'Amy', days: 1 }];
    const data = aggregateHeatmap(
      withExtra,
      'stage',
      'owner',
      'days',
      undefined,
      'avg',
      stageOrder,
    );
    // 'Closed Lost' isn't in stageOrder → sorted after the known pipeline stages.
    expect(data.xLabels).toEqual(['Prospecting', 'Proposal', 'Negotiation', 'Closed Lost']);
  });

  it('sorts numeric string labels numerically, not alphabetically', () => {
    const numericRows = [
      { discount: '20', owner: 'Amy', revenue: 100 },
      { discount: '1', owner: 'Bob', revenue: 50 },
      { discount: '10', owner: 'Amy', revenue: 75 },
      { discount: '2', owner: 'Bob', revenue: 60 },
    ];
    const data = aggregateHeatmap(numericRows, 'discount', 'owner', 'revenue', undefined, 'sum');
    // Alphabetical order would be ['1', '10', '2', '20']; numeric order is correct.
    expect(data.xLabels).toEqual(['1', '2', '10', '20']);
  });

  it("sortBy='x-axis' sorts x labels and leaves y labels in insertion order", () => {
    const data = aggregateHeatmap(
      rows,
      'stage',
      'owner',
      'days',
      undefined,
      'avg',
      undefined,
      undefined,
      'x-axis',
    );
    expect(data.xLabels).toEqual(['Negotiation', 'Proposal', 'Prospecting']);
    // y labels stay in insertion order (Bob first, then Amy)
    expect(data.yLabels).toEqual(['Bob', 'Amy']);
  });

  it("sortBy='y-axis' sorts y labels and leaves x labels in insertion order", () => {
    const data = aggregateHeatmap(
      rows,
      'stage',
      'owner',
      'days',
      undefined,
      'avg',
      undefined,
      undefined,
      'y-axis',
    );
    expect(data.yLabels).toEqual(['Amy', 'Bob']);
    // x labels keep insertion order when sortBy='y-axis'
    expect(data.xLabels).toEqual(['Negotiation', 'Prospecting', 'Proposal']);
  });

  it("sortBy='natural' keeps both axes in insertion order", () => {
    const data = aggregateHeatmap(
      rows,
      'stage',
      'owner',
      'days',
      undefined,
      'avg',
      undefined,
      undefined,
      'natural',
    );
    expect(data.xLabels).toEqual(['Negotiation', 'Prospecting', 'Proposal']);
    expect(data.yLabels).toEqual(['Bob', 'Amy']);
  });

  it("sortDirection='desc' reverses x-axis sort", () => {
    const data = aggregateHeatmap(
      rows,
      'stage',
      'owner',
      'days',
      undefined,
      'avg',
      undefined,
      undefined,
      'x-axis',
      'desc',
    );
    expect(data.xLabels).toEqual(['Prospecting', 'Proposal', 'Negotiation']);
  });

  it("sortDirection='desc' reverses y-axis sort", () => {
    const data = aggregateHeatmap(
      rows,
      'stage',
      'owner',
      'days',
      undefined,
      'avg',
      undefined,
      undefined,
      'y-axis',
      'desc',
    );
    expect(data.yLabels).toEqual(['Bob', 'Amy']);
  });

  it('orderedValues take priority over sortBy', () => {
    const data = aggregateHeatmap(
      rows,
      'stage',
      'owner',
      'days',
      undefined,
      'avg',
      stageOrder,
      undefined,
      'x-axis',
      'desc',
    );
    // xOrder wins; sortBy/sortDirection are ignored for x-axis
    expect(data.xLabels).toEqual(['Prospecting', 'Proposal', 'Negotiation']);
  });
});

// ─── buildFunnelStages ─────────────────────────────────────────────────────────

describe('buildFunnelStages', () => {
  const rows = [
    { stage: 'Prospecting', amount: 100 },
    { stage: 'Prospecting', amount: 50 },
    { stage: 'Qualification', amount: 80 },
    { stage: 'Proposal', amount: 20 },
  ];

  it('sums the value field per stage category', () => {
    const result = buildFunnelStages(
      rows,
      'stage',
      'amount',
      undefined,
      'value',
      undefined,
      undefined,
    );
    const prospecting = result.stages.find((s) => s.label === 'Prospecting');
    expect(prospecting?.value).toBe(150);
  });

  it('defaults to value-descending native sort when sortBy is "value" (or omitted)', () => {
    const result = buildFunnelStages(
      rows,
      'stage',
      'amount',
      undefined,
      'value',
      undefined,
      undefined,
    );
    expect(result.sort).toBe('descending');
  });

  it('sortBy "natural" preserves insertion order and returns sort: "none"', () => {
    const result = buildFunnelStages(
      rows,
      'stage',
      'amount',
      undefined,
      'natural',
      undefined,
      undefined,
    );
    expect(result.stages.map((s) => s.label)).toEqual(['Prospecting', 'Qualification', 'Proposal']);
    expect(result.sort).toBe('none');
  });

  it('explicit funnelCategoryOrder pre-sorts stages and returns sort: "none"', () => {
    const result = buildFunnelStages(
      rows,
      'stage',
      'amount',
      undefined,
      'category',
      ['Proposal', 'Qualification', 'Prospecting'],
      undefined,
    );
    expect(result.stages.map((s) => s.label)).toEqual(['Proposal', 'Qualification', 'Prospecting']);
    expect(result.sort).toBe('none');
  });

  it('falls back to the field orderedValues when sortBy is "category" and no explicit override is given', () => {
    const result = buildFunnelStages(rows, 'stage', 'amount', undefined, 'category', undefined, [
      'Proposal',
      'Qualification',
      'Prospecting',
    ]);
    expect(result.stages.map((s) => s.label)).toEqual(['Proposal', 'Qualification', 'Prospecting']);
    expect(result.sort).toBe('none');
  });

  it('stages absent from an explicit category order sort after known stages, by value descending', () => {
    const withExtra = [...rows, { stage: 'Closed Won', amount: 500 }];
    const result = buildFunnelStages(
      withExtra,
      'stage',
      'amount',
      undefined,
      'category',
      ['Prospecting', 'Qualification', 'Proposal'],
      undefined,
    );
    expect(result.stages.map((s) => s.label)).toEqual([
      'Prospecting',
      'Qualification',
      'Proposal',
      'Closed Won',
    ]);
  });

  it('counts rows instead of summing when yAggregation is "count"', () => {
    const result = buildFunnelStages(
      rows,
      'stage',
      'amount',
      'count',
      'natural',
      undefined,
      undefined,
    );
    const prospecting = result.stages.find((s) => s.label === 'Prospecting');
    expect(prospecting?.value).toBe(2);
  });

  it('auto-detects a non-numeric value field and falls back to counting rows', () => {
    const stringRows = [
      { stage: 'Prospecting', owner: 'Amy' },
      { stage: 'Prospecting', owner: 'Bob' },
      { stage: 'Proposal', owner: 'Amy' },
    ];
    const result = buildFunnelStages(
      stringRows,
      'stage',
      'owner',
      undefined,
      'natural',
      undefined,
      undefined,
    );
    const prospecting = result.stages.find((s) => s.label === 'Prospecting');
    expect(prospecting?.value).toBe(2);
  });

  it('skips rows with an empty/missing stage label', () => {
    const withBlank = [...rows, { stage: '', amount: 999 }, { amount: 999 }];
    const result = buildFunnelStages(
      withBlank,
      'stage',
      'amount',
      undefined,
      'natural',
      undefined,
      undefined,
    );
    expect(result.stages).toHaveLength(3);
  });
});

// ─── buildGanttItems ────────────────────────────────────────────────────────────

describe('buildGanttItems', () => {
  it('builds one item per valid row', () => {
    const rows = [{ task: 'Design', start: '2024-01-01', end: '2024-01-10' }];
    const result = buildGanttItems(rows, 'task', 'start', 'end', undefined);
    expect(result.items).toEqual([
      {
        id: expect.any(Number),
        label: 'Design',
        startMs: new Date('2024-01-01').getTime(),
        endMs: new Date('2024-01-10').getTime(),
        colorCategory: undefined,
      },
    ]);
  });

  it('assigns a unique id per item, even for rows with identical label and start time', () => {
    // finding 15: two rows sharing the same label and start (but different end) must not
    // collide on id — the id must be assigned per underlying row, not derived from the
    // label/startMs the way the old `${label}-${startMs}` React key was.
    const rows = [
      { task: 'Deploy', start: '2024-01-01', end: '2024-01-02' },
      { task: 'Deploy', start: '2024-01-01', end: '2024-01-05' },
    ];
    const result = buildGanttItems(rows, 'task', 'start', 'end', undefined);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).not.toEqual(result.items[1].id);
  });

  it('skips rows missing a label, start, or end value', () => {
    const rows = [
      { task: '', start: '2024-01-01', end: '2024-01-10' },
      { task: 'Build', start: null, end: '2024-01-10' },
      { task: 'Ship', start: '2024-01-01', end: undefined },
      { task: 'Test', start: '2024-01-01', end: '2024-01-05' },
    ];
    const result = buildGanttItems(rows, 'task', 'start', 'end', undefined);
    expect(result.items.map((i) => i.label)).toEqual(['Test']);
  });

  it('skips rows with unparseable dates', () => {
    const rows = [{ task: 'Bad', start: 'not-a-date', end: '2024-01-10' }];
    const result = buildGanttItems(rows, 'task', 'start', 'end', undefined);
    expect(result.items).toHaveLength(0);
  });

  it('skips rows where the end precedes the start', () => {
    const rows = [{ task: 'Backwards', start: '2024-01-10', end: '2024-01-01' }];
    const result = buildGanttItems(rows, 'task', 'start', 'end', undefined);
    expect(result.items).toHaveLength(0);
  });

  it('collects colorCategory per item and de-duplicated categories in first-seen order', () => {
    const rows = [
      { task: 'A', start: '2024-01-01', end: '2024-01-02', team: 'Design' },
      { task: 'B', start: '2024-01-03', end: '2024-01-04', team: 'Eng' },
      { task: 'C', start: '2024-01-05', end: '2024-01-06', team: 'Design' },
    ];
    const result = buildGanttItems(rows, 'task', 'start', 'end', 'team');
    expect(result.items.map((i) => i.colorCategory)).toEqual(['Design', 'Eng', 'Design']);
    expect(result.categories).toEqual(['Design', 'Eng']);
  });

  it('omits colorCategory when colorField is not provided', () => {
    const rows = [{ task: 'A', start: '2024-01-01', end: '2024-01-02', team: 'Design' }];
    const result = buildGanttItems(rows, 'task', 'start', 'end', undefined);
    expect(result.items[0].colorCategory).toBeUndefined();
    expect(result.categories).toEqual([]);
  });

  it('returns empty items and categories for empty rows', () => {
    const result = buildGanttItems([], 'task', 'start', 'end', 'team');
    expect(result.items).toEqual([]);
    expect(result.categories).toEqual([]);
  });
});

// ─── Heatmap aggregation policy (finding 2.17) ────────────────────────────────

describe('aggregateHeatmap aggregation policy', () => {
  it("counts every row per cell for 'count' — including rows with a null measure", () => {
    const rows = [
      { x: 'Jan', y: 'EU', v: 10 },
      { x: 'Jan', y: 'EU', v: null }, // null measure must still be counted
      { x: 'Jan', y: 'EU', v: '' }, // empty-string measure must still be counted
    ];
    const data = aggregateHeatmap(rows, 'x', 'y', 'v', undefined, 'count');
    expect(data.cells.get('Jan\x00EU')).toBe(3);
  });

  it('keeps a cell whose measures are all null (shows 0 for sum, not vanish)', () => {
    const rows = [{ x: 'Jan', y: 'EU', v: null }];
    const data = aggregateHeatmap(rows, 'x', 'y', 'v', undefined, 'sum');
    expect(data.xLabels).toContain('Jan');
    expect(data.yLabels).toContain('EU');
    expect(data.cells.get('Jan\x00EU')).toBe(0);
  });

  it("does not inflate 'sum'/'avg' with an empty-string cell coerced to 0", () => {
    const rows = [
      { x: 'Jan', y: 'EU', v: 10 },
      { x: 'Jan', y: 'EU', v: '' }, // must be skipped, not treated as 0
    ];
    // sum stays 10 (empty skipped), and avg is 10 (denominator 1), not 5 (denominator 2).
    expect(aggregateHeatmap(rows, 'x', 'y', 'v', undefined, 'sum').cells.get('Jan\x00EU')).toBe(10);
    expect(aggregateHeatmap(rows, 'x', 'y', 'v', undefined, 'avg').cells.get('Jan\x00EU')).toBe(10);
  });

  it('coerces numeric-string measures for sum (CSV/JSON sources)', () => {
    const rows = [
      { x: 'Jan', y: 'EU', v: '10' },
      { x: 'Jan', y: 'EU', v: '5' },
    ];
    expect(aggregateHeatmap(rows, 'x', 'y', 'v', undefined, 'sum').cells.get('Jan\x00EU')).toBe(15);
  });

  // T3.2(b): the generic aggregators (`aggregateByField`/`aggregateByTwoFields`/
  // `aggregateMultipleSeries`) all skip a null/undefined/empty x via `isEmptyXValue`
  // before this cell is ever created; `aggregateHeatmap` previously lacked that guard,
  // so `toXValue(null)` resolved to the truthy `'(empty)'` bucket label and the row
  // survived as an `'(empty)'` COLUMN — disagreeing with bar/line charts over the same
  // field, which silently dropped it.
  it('drops rows with a null/undefined x, matching the generic aggregators (T3.2)', () => {
    const rows = [
      { x: 'Jan', y: 'EU', v: 10 },
      { x: null, y: 'EU', v: 5 },
      { x: undefined, y: 'EU', v: 7 },
    ];
    const data = aggregateHeatmap(rows, 'x', 'y', 'v', undefined, 'sum');
    expect(data.xLabels).toEqual(['Jan']);
    expect(data.xLabels).not.toContain('(empty)');
    expect(data.cells.get('Jan\x00EU')).toBe(10);
  });

  it('drops rows with an empty-string x', () => {
    const rows = [
      { x: 'Jan', y: 'EU', v: 10 },
      { x: '', y: 'EU', v: 5 },
    ];
    const data = aggregateHeatmap(rows, 'x', 'y', 'v', undefined, 'sum');
    expect(data.xLabels).toEqual(['Jan']);
  });

  // Regression: an all-null cell is still emitted as 0 so it does not vanish from the grid,
  // but that placeholder must NOT stretch the colour domain — letting it in gave a heatmap
  // over 80-95 °C readings a [0, 95] ramp, compressing the whole real 15-degree spread.
  it('excludes an all-null cell from the min/max colour domain', () => {
    const rows = [
      { x: 'Jan', y: 'EU', v: 80 },
      { x: 'Feb', y: 'EU', v: 95 },
      { x: 'Mar', y: 'EU', v: null }, // no aggregate at all
    ];
    const data = aggregateHeatmap(rows, 'x', 'y', 'v', undefined, 'sum');
    expect(data.minValue).toBe(80);
    expect(data.maxValue).toBe(95);
    // The cell itself is still present (at its placeholder 0) so the grid stays complete.
    expect(data.cells.get('Mar\x00EU')).toBe(0);
  });

  it('still reports a 0/0 colour domain when no cell has any data', () => {
    const data = aggregateHeatmap(
      [{ x: 'Jan', y: 'EU', v: null }],
      'x',
      'y',
      'v',
      undefined,
      'sum',
    );
    expect(data.minValue).toBe(0);
    expect(data.maxValue).toBe(0);
  });
});

// ─── Funnel aggregation policy (finding 2.17) ─────────────────────────────────

describe('buildFunnelStages aggregation policy', () => {
  it('does not inflate a stage sum with an empty-string measure coerced to 0', () => {
    const rows = [
      { stage: 'Lead', v: 100 },
      { stage: 'Lead', v: '' }, // must be skipped, not summed as 0
    ];
    const { stages } = buildFunnelStages(
      rows,
      'stage',
      'v',
      'sum',
      'natural',
      undefined,
      undefined,
    );
    const lead = stages.find((s) => s.label === 'Lead');
    expect(lead?.value).toBe(100);
  });

  it('keeps a stage present (value 0) when all its measures are null', () => {
    const rows = [{ stage: 'Lead', v: null }];
    const { stages } = buildFunnelStages(
      rows,
      'stage',
      'v',
      'sum',
      'natural',
      undefined,
      undefined,
    );
    expect(stages.find((s) => s.label === 'Lead')?.value).toBe(0);
  });

  // Regression: the numeric auto-detect sampled exactly ONE row (the first non-null), so a
  // leading "N/A" sentinel ahead of real numbers downgraded a genuine sum to a row count.
  // It now delegates to the shared `detectAggregationType`, which scans until it finds a
  // numeric value.
  it('does not downgrade a numeric measure to a count because of a leading sentinel', () => {
    const rows = [
      { stage: 'Lead', v: 'N/A' },
      { stage: 'Lead', v: 100 },
      { stage: 'Lead', v: 50 },
    ];
    const { stages } = buildFunnelStages(
      rows,
      'stage',
      'v',
      undefined,
      'natural',
      undefined,
      undefined,
    );
    // Summed (150), not counted (3).
    expect(stages.find((s) => s.label === 'Lead')?.value).toBe(150);
  });

  // Regression: `Number('')` is `0`, so the old detect scored an empty-string-only measure
  // as numeric and "summed" it to a meaningless 0. `coerceAggregateValue` treats `''` as
  // non-numeric, so the field is correctly recognised as having no numeric values and the
  // stage falls back to a row count.
  it('treats an empty-string-only measure as non-numeric and counts rows instead', () => {
    const rows = [
      { stage: 'Lead', v: '' },
      { stage: 'Lead', v: '' },
    ];
    const { stages } = buildFunnelStages(
      rows,
      'stage',
      'v',
      undefined,
      'natural',
      undefined,
      undefined,
    );
    expect(stages.find((s) => s.label === 'Lead')?.value).toBe(2);
  });
});
