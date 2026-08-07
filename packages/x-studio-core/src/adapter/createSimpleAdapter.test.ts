/**
 * Tests for createSimpleAdapter — single-source REST fetch adapter.
 *
 * Focused on the relative-date resolution the adapter performs before sending a query
 * descriptor to the server: a `RelativeDateValue` (e.g. "7 days ago") is a client-side-only
 * concept, so it must be resolved to a concrete date/instant string before the descriptor is
 * serialized and POSTed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSimpleAdapter } from './createSimpleAdapter';
import type { StudioFilterNode, StudioQueryDescriptor } from '../models';

function makeDescriptor(overrides: Partial<StudioQueryDescriptor> = {}): StudioQueryDescriptor {
  return {
    sourceId: 'orders',
    widgetId: 'w1',
    select: ['id', 'createdAt'],
    cacheKey: 'key-w1',
    ...overrides,
  };
}

function makeOkFetch(rows: Record<string, unknown>[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ rows }),
  });
}

async function postedFilter(fetchFn: ReturnType<typeof makeOkFetch>): Promise<StudioFilterNode> {
  const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(init.body as string) as { filter?: StudioFilterNode };
  return body.filter!;
}

describe('createSimpleAdapter — relative-date resolution', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a top-level RelativeDateValue to a concrete date before sending', async () => {
    const fetchFn = makeOkFetch();
    const adapter = createSimpleAdapter('/api/orders', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));

    await adapter.getRows(
      makeDescriptor({
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'greater_than',
          value: { relative: true, amount: 7, unit: 'day', direction: 'past' },
          fieldType: 'datetime',
        },
      }),
    );

    const filter = await postedFilter(fetchFn);
    expect(filter).toMatchObject({ value: '2026-07-12' });
  });

  it('resolves a sub-day (hour) RelativeDateValue to a full ISO instant, not a truncated day', async () => {
    const fetchFn = makeOkFetch();
    const adapter = createSimpleAdapter('/api/orders', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));

    await adapter.getRows(
      makeDescriptor({
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'greater_than',
          value: { relative: true, amount: 1, unit: 'hour', direction: 'past' },
          fieldType: 'datetime',
        },
      }),
    );

    const filter = await postedFilter(fetchFn);
    expect(filter).toMatchObject({ value: '2026-07-19T11:00:00.000Z' });
  });

  it('resolves a RelativeDateValue nested in a between filter\'s "from" bound', async () => {
    const fetchFn = makeOkFetch();
    const adapter = createSimpleAdapter('/api/orders', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));

    await adapter.getRows(
      makeDescriptor({
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'between',
          value: {
            from: { relative: true, amount: 7, unit: 'day', direction: 'past' },
            to: '2026-07-19',
          },
          fieldType: 'datetime',
        },
      }),
    );

    const filter = await postedFilter(fetchFn);
    expect(filter).toMatchObject({ value: { from: '2026-07-12', to: '2026-07-19' } });
  });

  it('resolves a RelativeDateValue nested in a between filter\'s "to" bound', async () => {
    const fetchFn = makeOkFetch();
    const adapter = createSimpleAdapter('/api/orders', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));

    await adapter.getRows(
      makeDescriptor({
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'between',
          value: {
            from: '2026-07-01',
            to: { relative: true, amount: 1, unit: 'day', direction: 'next' },
          },
          fieldType: 'datetime',
        },
      }),
    );

    const filter = await postedFilter(fetchFn);
    expect(filter).toMatchObject({ value: { from: '2026-07-01', to: '2026-07-20' } });
  });

  it('resolves relative bounds on BOTH sides of a between filter, including sub-day units', async () => {
    const fetchFn = makeOkFetch();
    const adapter = createSimpleAdapter('/api/orders', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));

    await adapter.getRows(
      makeDescriptor({
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'between',
          value: {
            from: { relative: true, amount: 2, unit: 'hour', direction: 'past' },
            to: { relative: true, amount: 30, unit: 'minute', direction: 'next' },
          },
          fieldType: 'datetime',
        },
      }),
    );

    const filter = await postedFilter(fetchFn);
    expect(filter).toMatchObject({
      value: { from: '2026-07-19T10:00:00.000Z', to: '2026-07-19T12:30:00.000Z' },
    });
  });

  it('resolves a RelativeDateValue nested in value2 (second condition)', async () => {
    const fetchFn = makeOkFetch();
    const adapter = createSimpleAdapter('/api/orders', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));

    await adapter.getRows(
      makeDescriptor({
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'greater_than',
          value: '2026-01-01',
          op2: 'less_than',
          value2: { relative: true, amount: 1, unit: 'day', direction: 'past' },
          fieldType: 'datetime',
        },
      }),
    );

    const filter = await postedFilter(fetchFn);
    expect(filter).toMatchObject({ value: '2026-01-01', value2: '2026-07-18' });
  });

  it('resolves relative dates recursively inside an AND group', async () => {
    const fetchFn = makeOkFetch();
    const adapter = createSimpleAdapter('/api/orders', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));

    await adapter.getRows(
      makeDescriptor({
        filter: {
          type: 'group',
          logic: 'and',
          children: [
            { type: 'leaf', field: 'status', op: 'equals', value: 'active' },
            {
              type: 'leaf',
              field: 'createdAt',
              op: 'greater_than',
              value: { relative: true, amount: 30, unit: 'day', direction: 'past' },
              fieldType: 'datetime',
            },
          ],
        },
      }),
    );

    const filter = await postedFilter(fetchFn);
    expect(filter).toMatchObject({
      type: 'group',
      children: [{ value: 'active' }, { value: '2026-06-19' }],
    });
  });

  it('leaves a non-relative filter value untouched', async () => {
    const fetchFn = makeOkFetch();
    const adapter = createSimpleAdapter('/api/orders', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await adapter.getRows(
      makeDescriptor({
        filter: { type: 'leaf', field: 'status', op: 'equals', value: 'active' },
      }),
    );

    const filter = await postedFilter(fetchFn);
    expect(filter).toMatchObject({ value: 'active' });
  });

  it('leaves a between filter with no relative bounds untouched', async () => {
    const fetchFn = makeOkFetch();
    const adapter = createSimpleAdapter('/api/orders', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await adapter.getRows(
      makeDescriptor({
        filter: {
          type: 'leaf',
          field: 'total',
          op: 'between',
          value: { from: 10, to: 100 },
        },
      }),
    );

    const filter = await postedFilter(fetchFn);
    expect(filter).toMatchObject({ value: { from: 10, to: 100 } });
  });
});

describe('createSimpleAdapter — aggregation push-down ladder', () => {
  async function postedAggregations(descriptor: Partial<StudioQueryDescriptor>): Promise<unknown> {
    const fetchFn = makeOkFetch();
    const adapter = createSimpleAdapter('/api/orders', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await adapter.getRows(makeDescriptor(descriptor));
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    return (JSON.parse(init.body as string) as { aggregations?: unknown }).aggregations;
  }

  it('strips a count aggregation so the host returns raw rows', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Every bar read `1`: the host returned one pre-aggregated row per region and the chart then
    // counted THOSE rows. The simple adapter used to implement only two of the five ladder rungs.
    const aggregations = await postedAggregations({
      select: ['region', 'amount'],
      groupBy: 'region',
      aggregations: [{ field: 'amount', fn: 'count', alias: 'amount' }],
    });
    expect(aggregations).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('strips a count_distinct aggregation', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const aggregations = await postedAggregations({
      select: ['region', 'customer_id'],
      groupBy: 'region',
      aggregations: [{ field: 'customer_id', fn: 'count_distinct', alias: 'customer_id' }],
    });
    expect(aggregations).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('strips an avg aggregation whose server grain is finer than the widget grain', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const aggregations = await postedAggregations({
      select: ['region', 'product', 'amount'],
      groupBy: 'region',
      aggregations: [{ field: 'amount', fn: 'avg', alias: 'amount' }],
    });
    expect(aggregations).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('still forwards a sum aggregation the host can compute faithfully', async () => {
    const aggregations = await postedAggregations({
      select: ['region', 'amount'],
      groupBy: 'region',
      aggregations: [{ field: 'amount', fn: 'sum', alias: 'amount' }],
    });
    expect(aggregations).toEqual([{ field: 'amount', fn: 'sum', alias: 'amount' }]);
  });
});
