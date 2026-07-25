import { describe, expect, it } from 'vitest';
import {
  applyRankToAggregated,
  applyRankToMultiSeries,
  applyRankToSeriesFieldData,
} from './aggregators';
import type { AggregatedData, MultiSeriesData, MultiYSeriesData } from './aggregators';
import type { StudioFilterState } from '../models';

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
