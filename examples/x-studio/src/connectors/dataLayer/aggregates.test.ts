import { describe, expect, it } from 'vitest';
import type { StudioQueryDescriptor } from '@mui/x-studio';
import type { DataLayerFieldType } from './client';
import { fromDataLayerAggregateRows, toDataLayerAggregate } from './aggregates';

const FIELDS = new Map<string, DataLayerFieldType>([
  ['createdAt', 'datetime'],
  ['status', 'string'],
  ['amount', 'number'],
  ['quantity', 'integer'],
  ['meta', 'json'],
]);

function chart(overrides: Partial<StudioQueryDescriptor> = {}): StudioQueryDescriptor {
  return {
    sourceId: 'dl-orders',
    widgetId: 'w1',
    cacheKey: 'key',
    select: ['createdAt', 'status', 'amount'],
    groupBy: 'createdAt',
    xGroupBy: 'month',
    preAggregationGrain: ['createdAt', 'status'],
    aggregations: [{ field: 'amount', fn: 'sum', alias: 'amount' }],
    ...overrides,
  };
}

describe('toDataLayerAggregate', () => {
  it('groups by the grain, buckets x in UTC, and names outputs g0 and m0', () => {
    expect(toDataLayerAggregate(chart(), FIELDS)).toEqual({
      aggregate: {
        groupBy: [
          { field: 'createdAt', bucket: 'month', as: 'g0' },
          { field: 'status', as: 'g1' },
        ],
        metrics: [{ op: 'sum', field: 'amount', as: 'm0' }],
      },
      keys: { g0: 'createdAt', g1: 'status', m0: 'amount' },
    });
  });

  it("maps Studio's count to a row count and the other counts to field counts", () => {
    const plan = toDataLayerAggregate(
      chart({
        select: ['status', 'amount', 'quantity', 'createdAt'],
        groupBy: 'status',
        xGroupBy: undefined,
        preAggregationGrain: ['status'],
        aggregations: [
          { field: 'amount', fn: 'count', alias: 'amount' },
          { field: 'quantity', fn: 'count_non_null', alias: 'quantity' },
          { field: 'createdAt', fn: 'count_distinct', alias: 'createdAt' },
        ],
      }),
      FIELDS,
    );
    expect(plan).toMatchObject({
      aggregate: {
        groupBy: [{ field: 'status', as: 'g0' }],
        metrics: [
          { op: 'count', as: 'm0' },
          { op: 'count', field: 'quantity', as: 'm1' },
          { op: 'countDistinct', field: 'createdAt', as: 'm2' },
        ],
      },
    });
  });

  it.each([
    ['no grain', chart({ preAggregationGrain: undefined }), "can't read pre-aggregated rows"],
    ['a cross-filter', chart({ hasIncomingCrossOrInteractiveFilters: true }), 'cross-filters'],
    ['a Top-N filter', chart({ hasRankFilters: true }), 'Top-N'],
    [
      'an expression input',
      chart({ select: ['createdAt', 'status', 'amount', 'quantity'] }),
      '"quantity", which is neither grouped nor aggregated',
    ],
    [
      'a related-source field',
      chart({
        select: ['createdAt', 'region', 'amount'],
        preAggregationGrain: ['createdAt', 'region'],
      }),
      '"region" is not a groupable entity field',
    ],
    [
      'a bucket on a string',
      chart({ preAggregationGrain: ['status', 'createdAt'] }),
      'is not a date',
    ],
    [
      'a sum of a string',
      chart({
        preAggregationGrain: ['createdAt'],
        aggregations: [
          { field: 'amount', fn: 'sum', alias: 'amount' },
          { field: 'status', fn: 'sum', alias: 'status' },
        ],
      }),
      '"sum" of a string field',
    ],
    [
      'a measure on the x field',
      chart({
        select: ['createdAt', 'status'],
        aggregations: [{ field: 'status', fn: 'count', alias: 'status' }],
      }),
      'is both a group and a measure',
    ],
    [
      'a max of a date',
      chart({
        select: ['status', 'createdAt'],
        xGroupBy: undefined,
        preAggregationGrain: ['status'],
        aggregations: [{ field: 'createdAt', fn: 'max', alias: 'createdAt' }],
      }),
      '"max" of a datetime field',
    ],
    [
      'a count of json',
      chart({
        select: ['status', 'meta'],
        xGroupBy: undefined,
        preAggregationGrain: ['status'],
        aggregations: [{ field: 'meta', fn: 'count_distinct', alias: 'meta' }],
      }),
      'json field',
    ],
  ])('falls back to raw rows for %s', (_name, descriptor, reason) => {
    const plan = toDataLayerAggregate(descriptor, FIELDS);
    expect(plan).toHaveProperty('fallback');
    expect((plan as { fallback: string }).fallback).toContain(reason);
  });
});

describe('fromDataLayerAggregateRows', () => {
  it('renames outputs to the keys Studio reads and keeps null sums', () => {
    expect(
      fromDataLayerAggregateRows(
        [
          { g0: '2026-01-01', g1: 'paid', m0: 120.5 },
          { g0: '2026-02-01', g1: null, m0: null },
        ],
        { g0: 'createdAt', g1: 'status', m0: 'amount' },
      ),
    ).toEqual([
      { createdAt: '2026-01-01', status: 'paid', amount: 120.5 },
      { createdAt: '2026-02-01', status: null, amount: null },
    ]);
  });
});
