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

// ── The half AFTER the `await` ───────────────────────────────────────────────
//
// Everything the adapter does BEFORE the fetch (relative-date resolution including nested
// `between` bounds and `value2`, group recursion, the shared aggregation push-down ladder) was
// pinned. The response-handling half was not: the `!response.ok` throw, the
// `Array.isArray(json.rows)` throw and the documented `transformDescriptor` option could each
// be removed with everything green.
describe('createSimpleAdapter — response handling', () => {
  it('throws with the endpoint and status when the response is not ok', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      // A server that returns an error page still has a parseable body. Without the guard the
      // adapter parses it as if it were data, so a 500 becomes an empty/garbage result set
      // shown as real data rather than a widget error.
      json: () => Promise.resolve({ rows: [{ id: 'from-the-error-page' }] }),
    });
    const adapter = createSimpleAdapter('https://api.test/query', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(adapter.getRows(makeDescriptor())).rejects.toThrow(/500 Internal Server Error/);
    await expect(adapter.getRows(makeDescriptor())).rejects.toThrow(/https:\/\/api\.test\/query/);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an object', { 0: 'a' }],
    ['a string', 'nope'],
  ])('throws when the response "rows" is %s rather than an array', async (_name, rows) => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rows }),
    });
    const adapter = createSimpleAdapter('https://api.test/query', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    // Without the guard a non-array `rows` is handed straight to the pipeline, which then
    // fails somewhere far from the cause.
    await expect(adapter.getRows(makeDescriptor())).rejects.toThrow(/must have a "rows" array/);
  });

  it('returns the rows unchanged on a well-formed response', async () => {
    const fetchFn = makeOkFetch([{ id: 1 }, { id: 2 }]);
    const adapter = createSimpleAdapter('https://api.test/query', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(adapter.getRows(makeDescriptor())).resolves.toEqual({
      rows: [{ id: 1 }, { id: 2 }],
    });
  });
});

// `transformDescriptor` is a documented public `SimpleAdapterOptions` field with a JSDoc
// contract; ignoring it entirely was green.
describe('createSimpleAdapter — transformDescriptor', () => {
  it('POSTs the transformed body rather than the resolved descriptor', async () => {
    const fetchFn = makeOkFetch([]);
    const transformDescriptor = vi.fn().mockReturnValue({ query: 'SELECT 1', custom: true });
    const adapter = createSimpleAdapter('https://api.test/query', {
      fetchFn: fetchFn as unknown as typeof fetch,
      transformDescriptor,
    });

    await adapter.getRows(makeDescriptor({ select: ['id'] }));

    expect(transformDescriptor).toHaveBeenCalledTimes(1);
    // It receives the RESOLVED descriptor (post relative-date resolution / aggregation ladder),
    // not the raw one the caller passed.
    expect(transformDescriptor.mock.calls[0][0]).toMatchObject({
      sourceId: 'orders',
      widgetId: 'w1',
      select: ['id'],
    });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ query: 'SELECT 1', custom: true });
  });

  it('POSTs the resolved descriptor when no transform is supplied', async () => {
    const fetchFn = makeOkFetch([]);
    const adapter = createSimpleAdapter('https://api.test/query', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await adapter.getRows(makeDescriptor({ select: ['id'] }));

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ sourceId: 'orders', select: ['id'] });
  });
});
