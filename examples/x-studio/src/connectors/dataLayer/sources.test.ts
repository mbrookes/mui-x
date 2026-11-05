import { describe, expect, it, vi } from 'vitest';
import type { StudioQueryDescriptor } from '@mui/x-studio';
import {
  DataLayerError,
  type DataLayerClient,
  type DataLayerEntity,
  type DataLayerQuery,
  type DataLayerQueryResult,
} from './client';
import { createDataLayerAdapter, createDataLayerState, type DataLayerReadNotice } from './sources';

const PETS: DataLayerEntity = {
  name: 'pets',
  label: 'Pets',
  description: 'Pets by status',
  primaryKey: 'id',
  fields: [
    { name: 'id', type: 'integer', nullable: false, filterable: true, sortable: true },
    { name: 'name', type: 'string', nullable: true, filterable: true, sortable: true },
    { name: 'tags', type: 'json', nullable: true, filterable: false, sortable: false },
  ],
  requiredFilters: [],
  access: { read: true, rowFiltered: false },
};

const PET: DataLayerEntity = { ...PETS, name: 'pet', label: 'Pet', requiredFilters: ['id'] };

function descriptor(overrides: Partial<StudioQueryDescriptor> = {}): StudioQueryDescriptor {
  return {
    sourceId: 'dl-pets',
    widgetId: 'widget-1',
    select: ['id', 'name', 'expr-upper-name'],
    cacheKey: 'key',
    ...overrides,
  };
}

/** A client over `total` rows that returns pages of at most `pageSize`. */
function fakeClient(
  total: number,
  pageSize = 1000,
  extra: Partial<DataLayerQueryResult['meta']> = {},
) {
  const query = vi.fn(async (q: DataLayerQuery): Promise<DataLayerQueryResult> => {
    const offset = q.offset ?? 0;
    const end = Math.min(total, offset + Math.min(q.limit ?? 100, pageSize));
    const data = Array.from({ length: Math.max(0, end - offset) }, (_, i) => ({
      id: offset + i,
      name: `pet ${offset + i}`,
      tags: [{ name: 'a' }],
    }));
    return {
      data,
      meta: {
        returned: data.length,
        limit: q.limit ?? 100,
        offset,
        hasMore: end < total,
        partial: false,
        durationMs: 1,
        ...extra,
      },
    };
  });
  const client: DataLayerClient = { query, getSchema: vi.fn() };
  return { client, query };
}

describe('createDataLayerAdapter', () => {
  it('pushes the projection and filter down and pages until hasMore is false', async () => {
    const { client, query } = fakeClient(2500);
    const adapter = createDataLayerAdapter(client, PETS);

    const result = await adapter.getRows(
      descriptor({ filter: { type: 'leaf', field: 'name', op: 'contains', value: 'pet' } }),
    );

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map(([q]) => [q.offset, q.limit])).toEqual([
      [0, 1000],
      [1000, 1000],
      [2000, 1000],
    ]);
    expect(query.mock.calls[0][0]).toMatchObject({
      entity: 'pets',
      select: ['id', 'name'],
      where: { field: 'name', op: 'contains', value: 'pet' },
    });
    expect(result.rows).toHaveLength(2500);
    expect(result.totalCount).toBe(2500);
    expect(result.isTruncated).toBe(false);
  });

  it('stops at the row cap and reports truncation', async () => {
    const { client } = fakeClient(10_000);
    const onRead = vi.fn<(notice: DataLayerReadNotice) => void>();
    const adapter = createDataLayerAdapter(client, PETS, { maxRows: 1500, onRead });

    const result = await adapter.getRows(descriptor());

    expect(result.rows).toHaveLength(1500);
    expect(result.isTruncated).toBe(true);
    expect(result.totalCount).toBeUndefined();
    expect(onRead).toHaveBeenCalledWith({
      widgetId: 'widget-1',
      sourceId: 'dl-pets',
      label: 'Pets',
      rows: 1500,
      aggregated: false,
      truncated: true,
      partial: false,
      warnings: [],
    });
  });

  it('reports a partial result with its warnings', async () => {
    const { client } = fakeClient(3, 1000, { partial: true, warnings: ['Scan limit reached.'] });
    const onRead = vi.fn<(notice: DataLayerReadNotice) => void>();
    const adapter = createDataLayerAdapter(client, PETS, { onRead });

    const result = await adapter.getRows(descriptor({ limit: 10 }));

    expect(result.isTruncated).toBe(true);
    expect(onRead.mock.calls[0][0]).toMatchObject({
      partial: true,
      truncated: false,
      warnings: ['Scan limit reached.'],
    });
  });

  it('serializes JSON fields and omits the projection when no entity field is selected', async () => {
    const { client, query } = fakeClient(1);
    const adapter = createDataLayerAdapter(client, PETS);

    const result = await adapter.getRows(descriptor({ select: ['expr-only'] }));

    expect(query.mock.calls[0][0].select).toBeUndefined();
    expect(result.rows[0].tags).toBe('[{"name":"a"}]');
  });
});

describe('createDataLayerAdapter aggregates', () => {
  const ORDERS: DataLayerEntity = {
    ...PETS,
    name: 'orders',
    label: 'Orders',
    fields: [
      { name: 'id', type: 'integer', nullable: false, filterable: true, sortable: true },
      { name: 'status', type: 'string', nullable: true, filterable: true, sortable: true },
      { name: 'amount', type: 'number', nullable: true, filterable: true, sortable: true },
    ],
  };
  const chart = (overrides: Partial<StudioQueryDescriptor> = {}) =>
    descriptor({
      sourceId: 'dl-orders',
      select: ['status', 'amount'],
      groupBy: 'status',
      preAggregationGrain: ['status'],
      aggregations: [{ field: 'amount', fn: 'count', alias: 'amount' }],
      ...overrides,
    });
  const meta = (hasMore: boolean, offset = 0): DataLayerQueryResult['meta'] => ({
    returned: 1,
    limit: 1000,
    offset,
    hasMore,
    partial: false,
    durationMs: 1,
  });

  it('reads groups, pages them, and returns pre-aggregated rows', async () => {
    const query = vi.fn(
      async (q: DataLayerQuery): Promise<DataLayerQueryResult> =>
        q.offset === 0
          ? { data: [{ g0: 'paid', m0: 7 }], meta: meta(true) }
          : { data: [{ g0: null, m0: 2 }], meta: meta(false, 1) },
    );
    const onRead = vi.fn<(notice: DataLayerReadNotice) => void>();
    const adapter = createDataLayerAdapter({ query, getSchema: vi.fn() }, ORDERS, { onRead });

    const result = await adapter.getRows(chart());

    expect(query.mock.calls[0][0]).toEqual({
      entity: 'orders',
      where: undefined,
      aggregate: { groupBy: [{ field: 'status', as: 'g0' }], metrics: [{ op: 'count', as: 'm0' }] },
      limit: 1000,
      offset: 0,
    });
    expect(query.mock.calls[1][0].offset).toBe(1);
    expect(result).toEqual({
      rows: [
        { status: 'paid', amount: 7 },
        { status: null, amount: 2 },
      ],
      totalCount: 2,
      isTruncated: false,
      preAggregated: true,
    });
    expect(onRead.mock.calls[0][0]).toMatchObject({ rows: 2, aggregated: true, truncated: false });
  });

  it('reports capped groups as truncated, never as exact', async () => {
    const query = vi.fn(
      async (): Promise<DataLayerQueryResult> => ({
        data: [{ g0: 'paid', m0: 7 }],
        meta: meta(true),
      }),
    );
    const onRead = vi.fn<(notice: DataLayerReadNotice) => void>();
    const adapter = createDataLayerAdapter({ query, getSchema: vi.fn() }, ORDERS, {
      maxRows: 1,
      onRead,
    });

    const result = await adapter.getRows(chart());

    expect(result).toMatchObject({ isTruncated: true, totalCount: undefined, preAggregated: true });
    expect(onRead.mock.calls[0][0]).toMatchObject({ aggregated: true, truncated: true });
  });

  it('falls back to raw rows when the source has no aggregates, and stops asking', async () => {
    const query = vi.fn(async (q: DataLayerQuery): Promise<DataLayerQueryResult> => {
      if (q.aggregate) {
        throw new DataLayerError({
          code: 'OPERATOR_NOT_SUPPORTED',
          message: "This source can't compute aggregates.",
        });
      }
      return { data: [{ status: 'paid', amount: 3 }], meta: meta(false) };
    });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const adapter = createDataLayerAdapter({ query, getSchema: vi.fn() }, ORDERS);

    const first = await adapter.getRows(chart());
    await adapter.getRows(chart());

    expect(first).toEqual({
      rows: [{ status: 'paid', amount: 3 }],
      totalCount: 1,
      isTruncated: false,
    });
    expect(query.mock.calls.map(([q]) => Boolean(q.aggregate))).toEqual([true, false, false]);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("OPERATOR_NOT_SUPPORTED: This source can't compute aggregates."),
    );
    debug.mockRestore();
  });

  it('retries aggregates after a field-level rejection, and rethrows other errors', async () => {
    const error = new DataLayerError({
      code: 'OPERATOR_NOT_SUPPORTED',
      message: "'sum' does not support this field type.",
      details: { field: 'amount' },
    });
    const query = vi.fn(async (q: DataLayerQuery): Promise<DataLayerQueryResult> => {
      if (q.aggregate) {
        throw error;
      }
      return { data: [], meta: meta(false) };
    });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const adapter = createDataLayerAdapter({ query, getSchema: vi.fn() }, ORDERS);

    await adapter.getRows(chart());
    await adapter.getRows(chart());
    expect(query.mock.calls.map(([q]) => Boolean(q.aggregate))).toEqual([true, false, true, false]);

    query.mockRejectedValueOnce(new DataLayerError({ code: 'SOURCE_TIMEOUT', message: 'Slow.' }));
    await expect(adapter.getRows(chart())).rejects.toThrow('SOURCE_TIMEOUT');
    vi.restoreAllMocks();
  });

  it('logs why a widget with aggregations reads raw rows', async () => {
    const { client, query } = fakeClient(1);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const adapter = createDataLayerAdapter(client, PETS);

    await adapter.getRows(descriptor({ aggregations: [{ field: 'id', fn: 'sum', alias: 'id' }] }));

    expect(query.mock.calls[0][0].aggregate).toBeUndefined();
    expect(debug).toHaveBeenCalledWith(
      "[data-layer] widget-1 reads raw rows: the widget can't read pre-aggregated rows.",
    );
    debug.mockRestore();
  });
});

describe('createDataLayerState', () => {
  it('creates a source and a grid per readable entity, with required filters', () => {
    const { client } = fakeClient(0);
    const hidden = { ...PETS, name: 'secret', access: { read: false, rowFiltered: false } };

    const state = createDataLayerState(client, [PETS, PET, hidden]);

    expect(Object.keys(state.runtime.dataSources)).toEqual(['dl-pets', 'dl-pet']);
    expect(state.runtime.dataSources['dl-pets']).toMatchObject({
      label: 'Pets',
      tableName: 'pets',
      fields: [
        { id: 'id', type: 'number' },
        { id: 'name', type: 'string' },
        { id: 'tags', type: 'string' },
      ],
    });
    expect(state.doc.widgets['widget-dl-pet']).toMatchObject({ kind: 'grid', sourceId: 'dl-pet' });
    expect(state.doc.filters).toEqual([
      expect.objectContaining({
        id: 'filter-dl-pet-id',
        field: 'id',
        operator: 'equals',
        scope: { kind: 'widget', widgetId: 'widget-dl-pet' },
      }),
    ]);
  });
});
