import { describe, expect, it, vi } from 'vitest';
import type { StudioQueryDescriptor } from '@mui/x-studio';
import type {
  DataLayerClient,
  DataLayerEntity,
  DataLayerQuery,
  DataLayerQueryResult,
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
