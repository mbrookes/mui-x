import { describe, expect, it } from 'vitest';
import {
  aggregateBlendedSeries,
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
  applyRankToAggregated,
  applyRankToMultiSeries,
  applyRankToSeriesFieldData,
  detectAggregationType,
  detectAggregationTypeByField,
} from './aggregators';
import type { AggregatedData, MultiSeriesData, MultiYSeriesData } from './aggregators';
import type { StudioExpressionField, StudioFilterState } from '../models';

function rankFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    filterMode: 'rank',
    value: 1,
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  } as StudioFilterState;
}

// ─── "No data" never wins a rank slot ────────────────────────────────────────
//
// `(number | null)[]` values use `null` for "no row landed in this cell". A rank score
// derived from such a cell is absence of a measurement, so the candidate must lose in BOTH
// directions — the shared policy in the three `applyRankTo*` entry points.

describe('applyRankToMultiSeries — null (no-data) handling', () => {
  it('__min/top: an all-null label does not displace the only label with data', () => {
    // Oslo has no rows at all; Rome's min is 100. Coercing the nulls to `+Infinity` made
    // Oslo score higher than every real minimum and win top-1 outright.
    const data: MultiYSeriesData = {
      labels: ['Oslo', 'Rome'],
      series: [
        { fieldId: 'S1', values: [null, 100] },
        { fieldId: 'S2', values: [null, 250] },
      ],
    };

    const result = applyRankToMultiSeries(
      data,
      rankFilter({ value: 1, rankDirection: 'top', rankMultiSeriesBy: '__min' }),
    );

    expect(result.labels).toEqual(['Rome']);
    expect(result.series[0].values).toEqual([100]);
  });

  it('__max/bottom: an all-null label does not win the bottom-N', () => {
    const data: MultiYSeriesData = {
      labels: ['Oslo', 'Rome'],
      series: [
        { fieldId: 'S1', values: [null, 100] },
        { fieldId: 'S2', values: [null, 250] },
      ],
    };

    const result = applyRankToMultiSeries(
      data,
      rankFilter({ value: 1, rankDirection: 'bottom', rankMultiSeriesBy: '__max' }),
    );

    expect(result.labels).toEqual(['Rome']);
  });

  it('__min: two all-null labels compare consistently (no NaN comparator)', () => {
    // `Infinity - Infinity` is NaN, which is not a consistent ordering — the surviving set
    // then depends on the engine's sort implementation. Equality is tested first instead.
    const data: MultiYSeriesData = {
      labels: ['Oslo', 'Bergen', 'Rome'],
      series: [{ fieldId: 'S1', values: [null, null, 100] }],
    };

    const result = applyRankToMultiSeries(
      data,
      rankFilter({ value: 1, rankDirection: 'top', rankMultiSeriesBy: '__min' }),
    );

    expect(result.labels).toEqual(['Rome']);
  });

  it('__sum: an all-null label loses to a genuinely negative total in both directions', () => {
    const data: MultiYSeriesData = {
      labels: ['Oslo', 'Rome'],
      series: [{ fieldId: 'S1', values: [null, -5] }],
    };

    expect(
      applyRankToMultiSeries(data, rankFilter({ value: 1, rankDirection: 'top' })).labels,
    ).toEqual(['Rome']);
    expect(
      applyRankToMultiSeries(data, rankFilter({ value: 1, rankDirection: 'bottom' })).labels,
    ).toEqual(['Rome']);
  });

  it('__sum/__avg: a partially-null label scores over its non-null cells only', () => {
    // Rome: sum 100, avg 100 (one contributing series). Oslo: sum 60, avg 30.
    // Averaging over the full series count would give Rome 50 and flip the top-1.
    const data: MultiYSeriesData = {
      labels: ['Oslo', 'Rome'],
      series: [
        { fieldId: 'S1', values: [30, 100] },
        { fieldId: 'S2', values: [30, null] },
      ],
    };

    expect(
      applyRankToMultiSeries(
        data,
        rankFilter({ value: 1, rankDirection: 'top', rankMultiSeriesBy: '__sum' }),
      ).labels,
    ).toEqual(['Rome']);
    expect(
      applyRankToMultiSeries(
        data,
        rankFilter({ value: 1, rankDirection: 'top', rankMultiSeriesBy: '__avg' }),
      ).labels,
    ).toEqual(['Rome']);
  });

  it('by fieldId: a null cell in the ranked series is no data, not 0', () => {
    const data: MultiYSeriesData = {
      labels: ['Oslo', 'Rome'],
      series: [
        { fieldId: 'S1', values: [null, -5] },
        { fieldId: 'S2', values: [999, 1] },
      ],
    };

    // Ranking by S1: Oslo has no S1 value, so Rome wins the bottom-1 despite being negative.
    expect(
      applyRankToMultiSeries(
        data,
        rankFilter({ value: 1, rankDirection: 'bottom', rankMultiSeriesBy: 'S1' }),
      ).labels,
    ).toEqual(['Rome']);
  });

  it('keeps survivors in their original input order', () => {
    const data: MultiYSeriesData = {
      labels: ['A', 'B', 'C'],
      series: [{ fieldId: 'S1', values: [1, 30, 20] }],
    };

    const result = applyRankToMultiSeries(data, rankFilter({ value: 2, rankDirection: 'top' }));

    expect(result.labels).toEqual(['B', 'C']);
    expect(result.series[0].values).toEqual([30, 20]);
  });
});

describe('applyRankToSeriesFieldData — null (no-data) handling', () => {
  it('an all-null series does not win a bottom-N over a genuinely negative total', () => {
    // Summing the nulls as 0 gave Empty a 0 total, which is greater than Loss's -30 but was
    // still the lowest "real" number the old comparator saw for a bottom-2.
    const data: MultiSeriesData = {
      labels: ['Q1', 'Q2'],
      seriesNames: ['Empty', 'Loss', 'Profit'],
      seriesData: {
        Empty: [null, null],
        Loss: [-10, -20],
        Profit: [10, 20],
      },
    };

    const result = applyRankToSeriesFieldData(
      data,
      rankFilter({ value: 1, rankDirection: 'bottom' }),
    );

    expect(result.seriesNames).toEqual(['Loss']);
    expect(Object.keys(result.seriesData)).toEqual(['Loss']);
  });

  it('a series total skips null cells rather than adding 0 for them', () => {
    const data: MultiSeriesData = {
      labels: ['Q1', 'Q2'],
      seriesNames: ['Sparse', 'Dense'],
      seriesData: {
        Sparse: [100, null], // 100
        Dense: [40, 40], // 80
      },
    };

    const result = applyRankToSeriesFieldData(data, rankFilter({ value: 1, rankDirection: 'top' }));

    expect(result.seriesNames).toEqual(['Sparse']);
  });
});

describe('applyRankToAggregated — null (no-data) handling', () => {
  it('a null value loses in both directions', () => {
    const data: AggregatedData = { labels: ['Oslo', 'Rome'], values: [null, -4] };

    expect(applyRankToAggregated(data, rankFilter({ value: 1, rankDirection: 'top' }))).toEqual({
      labels: ['Rome'],
      values: [-4],
    });
    expect(applyRankToAggregated(data, rankFilter({ value: 1, rankDirection: 'bottom' }))).toEqual({
      labels: ['Rome'],
      values: [-4],
    });
  });

  it('two null values compare consistently (no NaN comparator)', () => {
    const data: AggregatedData = { labels: ['Oslo', 'Bergen', 'Rome'], values: [null, null, 7] };

    expect(
      applyRankToAggregated(data, rankFilter({ value: 1, rankDirection: 'bottom' })).labels,
    ).toEqual(['Rome']);
  });
});
// ─── The aggregation type is detected ONCE, for every aggregator family (M10) ──
//
// `aggregateByField` gained a `forcedAggregation` override so a filtered aggregation and its
// baseline (ghost) counterpart could agree on sum-vs-count. The other two aggregators kept
// hand-copied inline detection with no override, so `seriesFieldData` vs `allSeriesFieldData`
// and `multiYData` vs `allMultiYData` still pre-detected INDEPENDENTLY: a cross-filtered
// subset whose y values are all sentinel strings downgraded to 'count' while the baseline
// stayed 'sum', drawing row-count bars against a sum-valued ghost.

describe('detectAggregationTypeByField', () => {
  it('detects per field, downgrading only the entirely non-numeric ones', () => {
    const rows = [
      { amount: 10, code: 'N/A' },
      { amount: 20, code: 'X' },
    ];
    expect(detectAggregationTypeByField(rows, ['amount', 'code'], 'sum')).toEqual({
      amount: 'sum',
      code: 'count',
    });
  });

  it('honours a per-field aggregation map', () => {
    const rows = [{ amount: 10, other: 5 }];
    expect(
      detectAggregationTypeByField(rows, ['amount', 'other'], {
        amount: 'avg',
      }),
    ).toEqual({
      amount: 'avg',
      other: 'sum',
    });
  });
});

describe('aggregateByTwoFields — forcedAggregation', () => {
  // The repro: split-by bar chart, yField `amount`, yAggregation 'sum', seriesField `channel`.
  // Rows for region 'X' carry the sentinel string 'N/A' in `amount`.
  const baseline = [
    { region: 'X', channel: 'web', amount: 'N/A' },
    { region: 'X', channel: 'web', amount: 'N/A' },
    { region: 'Y', channel: 'web', amount: 100 },
  ];
  // A cross-filter selecting region 'X' leaves only the sentinel rows.
  const filtered = baseline.filter((r) => r.region === 'X');

  it('downgrades to count when detecting independently from a sentinel-only subset', () => {
    // Documents the divergence the override exists to prevent.
    const independent = aggregateByTwoFields(
      filtered,
      'region',
      'channel',
      'amount',
      undefined,
      undefined,
      undefined,
      undefined,
      'sum',
    );
    expect(independent.seriesData.web).toEqual([2]); // a ROW COUNT
  });

  it('uses the forced (baseline) aggregation instead, so ghost and foreground agree', () => {
    const forced = detectAggregationType(baseline, 'amount', 'sum');
    expect(forced).toBe('sum');

    const foreground = aggregateByTwoFields(
      filtered,
      'region',
      'channel',
      'amount',
      undefined,
      undefined,
      undefined,
      undefined,
      'sum',
      undefined,
      forced,
    );
    // No usable numeric value in the subset → a null gap, NOT a row count masquerading as a sum.
    expect(foreground.seriesData.web).toEqual([null]);
  });
});

describe('aggregateMultipleSeries — forcedAggregation', () => {
  const baseline = [
    { region: 'X', amount: 'N/A', units: 1 },
    { region: 'Y', amount: 100, units: 2 },
  ];
  const filtered = baseline.filter((r) => r.region === 'X');

  it('downgrades to count when detecting independently from a sentinel-only subset', () => {
    const independent = aggregateMultipleSeries(filtered, 'region', ['amount', 'units'], undefined);
    expect(independent.series.find((s) => s.fieldId === 'amount')?.values).toEqual([1]);
  });

  it('uses the forced (baseline) per-field map instead', () => {
    const forced = detectAggregationTypeByField(baseline, ['amount', 'units'], 'sum');
    expect(forced).toEqual({ amount: 'sum', units: 'sum' });

    const foreground = aggregateMultipleSeries(
      filtered,
      'region',
      ['amount', 'units'],
      undefined,
      undefined,
      undefined,
      undefined,
      'sum',
      undefined,
      forced,
    );
    expect(foreground.series.find((s) => s.fieldId === 'amount')?.values).toEqual([null]);
    expect(foreground.series.find((s) => s.fieldId === 'units')?.values).toEqual([1]);
  });
});

// ─── Measure expression fields on a chart axis ────────────────────────────────
//
// `enrichRowsWithExpressions` deliberately excludes measures from row enrichment, so
// `row[measureId]` is `undefined` on every row. Without `expressionFields`, detection kept
// 'sum' and finalizing an empty accumulator produced a confident zero/gap while the KPI beside
// the chart — which evaluates the measure over the whole row set — showed the right number.

describe('generic aggregators — measure expression y fields', () => {
  const avgOrderValue: StudioExpressionField = {
    id: 'aov',
    label: 'Avg order value',
    sourceId: 'src',
    isMeasure: true,
    expression: {
      operator: 'divide',
      inputs: [
        { id: 'revenue', aggregation: 'sum' },
        { id: 'revenue', aggregation: 'count' },
      ],
    },
  };
  const expressionFields = [avgOrderValue];

  const rows = [
    { region: 'A', channel: 'web', revenue: 100 },
    { region: 'A', channel: 'web', revenue: 300 },
    { region: 'B', channel: 'web', revenue: 50 },
  ];

  it('aggregateByField evaluates the measure per bucket instead of plotting a flat gap', () => {
    const withMeasure = aggregateByField(
      rows,
      'region',
      'aov',
      undefined,
      'sum',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      expressionFields,
    );
    expect(withMeasure.labels).toEqual(['A', 'B']);
    expect(withMeasure.values).toEqual([200, 50]);

    // Without `expressionFields` the measure has no per-row value at all.
    const without = aggregateByField(rows, 'region', 'aov', undefined, 'sum');
    expect(without.values).toEqual([null, null]);
  });

  it('aggregateByTwoFields evaluates the measure per cell', () => {
    const result = aggregateByTwoFields(
      rows,
      'region',
      'channel',
      'aov',
      undefined,
      undefined,
      undefined,
      undefined,
      'sum',
      undefined,
      undefined,
      expressionFields,
    );
    expect(result.labels).toEqual(['A', 'B']);
    expect(result.seriesData.web).toEqual([200, 50]);
  });

  it('aggregateMultipleSeries mixes measure and plain series', () => {
    const result = aggregateMultipleSeries(
      rows,
      'region',
      ['aov', 'revenue'],
      undefined,
      undefined,
      undefined,
      undefined,
      'sum',
      undefined,
      undefined,
      expressionFields,
    );
    expect(result.series.find((s) => s.fieldId === 'aov')?.values).toEqual([200, 50]);
    expect(result.series.find((s) => s.fieldId === 'revenue')?.values).toEqual([400, 50]);
  });

  it("'count' still tallies rows and ignores the measure", () => {
    const result = aggregateByField(
      rows,
      'region',
      'aov',
      undefined,
      'count',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      expressionFields,
    );
    expect(result.values).toEqual([2, 1]);
  });
});

// ─── Measure expression fields on a BLENDED (cross-source) mixed chart ─────────
//
// `aggregateBlendedSeries` aggregates each series inside its OWN source's rows, and used to call
// `aggregateByField` with no `expressionFields` at all. A measure series therefore resolved
// `row[measureId]` — always `undefined` — on every row and came back all-`null`: a blank series,
// where the identical measure on the same chart's single-source sibling drew real values.

describe('aggregateBlendedSeries — measure expression series', () => {
  const webAov: StudioExpressionField = {
    id: 'aov',
    label: 'Avg order value',
    sourceId: 'web',
    isMeasure: true,
    expression: {
      operator: 'divide',
      inputs: [
        { id: 'revenue', aggregation: 'sum' },
        { id: 'revenue', aggregation: 'count' },
      ],
    },
  };
  // Same `id`, different source, and deliberately a DIFFERENT formula (a plain sum) so a
  // cross-source mix-up produces a distinguishable number rather than a coincidentally equal one.
  const storeAov: StudioExpressionField = {
    ...webAov,
    sourceId: 'store',
    expression: { id: 'revenue', aggregation: 'sum' },
  };

  const webRows = [
    { region: 'A', revenue: 100 },
    { region: 'A', revenue: 300 },
    { region: 'B', revenue: 50 },
  ];
  const storeRows = [
    { region: 'A', revenue: 7 },
    { region: 'B', revenue: 11 },
  ];

  it('evaluates a measure series against its own source rows instead of returning all-null', () => {
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'aov', sourceId: 'web', rows: webRows, expressionFields: [webAov] },
        { fieldId: 'revenue', sourceId: 'store', rows: storeRows },
      ],
      'region',
    );
    expect(result.labels).toEqual(['A', 'B']);
    // avg(100, 300) = 200; avg(50) = 50 — the same numbers the single-source aggregator gives.
    expect(result.series[0].values).toEqual([200, 50]);
    expect(result.series[1].values).toEqual([7, 11]);
  });

  it('keeps two same-id measures on different sources apart', () => {
    // The reason `expressionFields` is PER SERIES rather than one dashboard-wide list:
    // `findMeasureExpressionField` matches on `id` alone, so an unscoped list would let
    // whichever definition came first be evaluated against BOTH sources' rows.
    const result = aggregateBlendedSeries(
      [
        { fieldId: 'aov', sourceId: 'web', rows: webRows, expressionFields: [webAov] },
        { fieldId: 'aov', sourceId: 'store', rows: storeRows, expressionFields: [storeAov] },
      ],
      'region',
    );
    expect(result.series[0].values).toEqual([200, 50]); // web: divide → average
    expect(result.series[1].values).toEqual([7, 11]); // store: plain sum
  });

  it('still returns an all-null series when no expression fields are supplied', () => {
    // The pre-fix behaviour, kept for callers that legitimately have no measures: honest
    // (a gap, not a fabricated 0) but empty.
    const result = aggregateBlendedSeries(
      [{ fieldId: 'aov', sourceId: 'web', rows: webRows }],
      'region',
    );
    expect(result.series[0].values).toEqual([null, null]);
  });
});
