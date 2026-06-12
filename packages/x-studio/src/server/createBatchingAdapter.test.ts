/**
 * Tests for createBatchingAdapter — client-side request collapsing and
 * cross-database join enrichment.
 *
 * Design note: the shared `loaderRegistry` inside the module means adapters at
 * the same endpoint share a single loader (and therefore a single fetch closure)
 * from the first time that endpoint is registered. To keep tests isolated we use
 * a unique endpoint URL per test via `uid()`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBatchingAdapter } from './createBatchingAdapter';
import type {
  StudioDataSource,
  StudioQueryDescriptor,
  StudioExpressionField,
  StudioRelationship,
} from '../models';

// ── Helpers ──────────────────────────────────────────────────────────────────

let _uid = 0;
/** Returns a unique endpoint string per test invocation. */
function uid(): string {
  _uid += 1;
  return `/api/test-${_uid}`;
}

beforeEach(() => {
  // Reset uid counter so URLs are stable across test re-runs in watch mode.
  // (counter still increments within a single run to stay unique)
});

function makeDescriptor(overrides: Partial<StudioQueryDescriptor> = {}): StudioQueryDescriptor {
  return {
    sourceId: 'orders',
    tableName: 'orders',
    widgetId: 'w1',
    select: ['id', 'total'],
    cacheKey: 'key-w1',
    ...overrides,
  };
}

function makeOkFetch(results: Array<{ id: string; rows: Record<string, unknown>[]; error?: string }>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ results }),
  });
}

function makeErrorFetch(status = 500, statusText = 'Internal Server Error') {
  return vi.fn().mockResolvedValue({ ok: false, status, statusText });
}

function field(id: string, type: 'string' | 'number' = 'string') {
  return { id, label: id, type } as const;
}

// ── Batching mechanics ────────────────────────────────────────────────────────

describe('createBatchingAdapter — batching mechanics', () => {
  it('sends a single POST for multiple concurrent getRows() calls', async () => {
    const fetchFn = makeOkFetch([
      { id: 'w1', rows: [{ id: 1 }] },
      { id: 'w2', rows: [{ id: 2 }] },
    ]);
    const adapter = createBatchingAdapter(uid(), { fetchFn: fetchFn as unknown as typeof fetch, batchDelayMs: 0 });

    await Promise.all([
      adapter.getRows(makeDescriptor({ widgetId: 'w1' })),
      adapter.getRows(makeDescriptor({ widgetId: 'w2' })),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('routes each response to the correct caller by widgetId', async () => {
    const fetchFn = makeOkFetch([
      { id: 'sales', rows: [{ amount: 100 }] },
      { id: 'customers', rows: [{ name: 'Acme' }] },
    ]);
    const adapter = createBatchingAdapter(uid(), { fetchFn: fetchFn as unknown as typeof fetch, batchDelayMs: 0 });

    const [sales, customers] = await Promise.all([
      adapter.getRows(makeDescriptor({ widgetId: 'sales' })),
      adapter.getRows(makeDescriptor({ widgetId: 'customers' })),
    ]);

    expect(sales.rows[0]).toMatchObject({ amount: 100 });
    expect(customers.rows[0]).toMatchObject({ name: 'Acme' });
  });

  it('sends the correct POST body with id/table/columns', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const endpoint = uid();
    const adapter = createBatchingAdapter(endpoint, { fetchFn: fetchFn as unknown as typeof fetch, batchDelayMs: 0 });

    await adapter.getRows(makeDescriptor({ widgetId: 'w1', tableName: 'orders', select: ['id', 'total'] }));

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { widgets: Array<{ id: string; table: string; columns: string[] }> };
    expect(body.widgets).toHaveLength(1);
    expect(body.widgets[0].id).toBe('w1');
    expect(body.widgets[0].table).toBe('orders');
    expect(body.widgets[0].columns).toContain('id');
    expect(body.widgets[0].columns).toContain('total');
  });

  it('rejects with an error when the server result is missing for a widget', async () => {
    const fetchFn = makeOkFetch([]); // no results for w1
    const adapter = createBatchingAdapter(uid(), { fetchFn: fetchFn as unknown as typeof fetch, batchDelayMs: 0 });

    await expect(adapter.getRows(makeDescriptor({ widgetId: 'w1' }))).rejects.toThrow(/"w1"/);
  });
});

// ── Fetch failure ─────────────────────────────────────────────────────────────

describe('createBatchingAdapter — fetch failure', () => {
  it('propagates the HTTP status as an Error to all callers', async () => {
    const fetchFn = makeErrorFetch(503, 'Service Unavailable');
    const adapter = createBatchingAdapter(uid(), { fetchFn: fetchFn as unknown as typeof fetch, batchDelayMs: 0 });

    await expect(
      Promise.all([
        adapter.getRows(makeDescriptor({ widgetId: 'w1' })),
        adapter.getRows(makeDescriptor({ widgetId: 'w2' })),
      ]),
    ).rejects.toThrow(/503/);
  });

  it('propagates a server-returned error field as an Error', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [], error: 'table not found' }]);
    const adapter = createBatchingAdapter(uid(), { fetchFn: fetchFn as unknown as typeof fetch, batchDelayMs: 0 });

    await expect(adapter.getRows(makeDescriptor({ widgetId: 'w1' }))).rejects.toThrow(/table not found/);
  });
});

// ── Filter serialisation ──────────────────────────────────────────────────────

describe('createBatchingAdapter — filter serialisation', () => {
  it('serialises a leaf filter to a single predicate', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), { fetchFn: fetchFn as unknown as typeof fetch, batchDelayMs: 0 });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        filter: { type: 'leaf', field: 'status', op: 'equals', value: 'active' },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    expect(body.widgets[0].filters).toEqual([{ column: 'status', operator: 'eq', value: 'active' }]);
  });

  it('flattens an AND group into multiple predicates', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), { fetchFn: fetchFn as unknown as typeof fetch, batchDelayMs: 0 });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        filter: {
          type: 'group',
          conjunction: 'and',
          children: [
            { type: 'leaf', field: 'country', op: 'equals', value: 'US' },
            { type: 'leaf', field: 'status', op: 'equals', value: 'active' },
          ],
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters: unknown[] }>;
    };
    expect(body.widgets[0].filters).toHaveLength(2);
  });

  it('omits the filters key when filter is undefined', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), { fetchFn: fetchFn as unknown as typeof fetch, batchDelayMs: 0 });

    await adapter.getRows(makeDescriptor({ widgetId: 'w1', filter: undefined }));

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown }>;
    };
    expect(body.widgets[0].filters).toBeUndefined();
  });

  it('maps not_equals filter operator to neq', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), { fetchFn: fetchFn as unknown as typeof fetch, batchDelayMs: 0 });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        filter: { type: 'leaf', field: 'status', op: 'not_equals', value: 'closed' },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters: Array<{ operator: string }> }>;
    };
    expect(body.widgets[0].filters[0].operator).toBe('neq');
  });
});

// ── Cross-endpoint join enrichment ────────────────────────────────────────────

describe('createBatchingAdapter — cross-endpoint join enrichment', () => {
  /**
   * Build a test harness:
   * - ordersAdapter uses ordersEndpoint (returned to caller)
   * - customersAdapter uses customersEndpoint
   * - crossEndpointMainAdapter is the orders adapter WITH dataSources, so it
   *   detects that customers lives on a different endpoint and falls back to
   *   client-side enrichment.
   *
   * The orders endpoint's fetch mock (`ordersFetch`) must return the FK column
   * (`customerId`) even though the cross-endpoint field is skipped server-side.
   * The code ensures FK is added to columns automatically.
   *
   * NOTE: Creating a cross-endpoint adapter intentionally triggers a dev-mode
   * console.warn (warnOnCrossEndpointRelationships). We suppress it here to keep
   * test output clean and to satisfy vitest-fail-on-console.
   */
  function buildHarness(overrides: {
    ordersFetch: ReturnType<typeof makeOkFetch>;
    customersFetch: ReturnType<typeof makeOkFetch>;
    expressionFields: StudioExpressionField[];
    relationships: StudioRelationship[];
  }) {
    const ordersEndpoint = uid();
    const customersEndpoint = uid();

    // Dummy adapters — only used for endpoint detection by getBatchingEndpoint()
    const ordersSourceAdapter = createBatchingAdapter(ordersEndpoint, {
      fetchFn: overrides.ordersFetch as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    const customersSourceAdapter = createBatchingAdapter(customersEndpoint, {
      fetchFn: overrides.customersFetch as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    const dataSources: Record<string, StudioDataSource> = {
      'source-orders': {
        id: 'source-orders',
        label: 'Orders',
        tableName: 'orders',
        fields: [field('id', 'number'), field('customerId', 'number'), field('total', 'number')],
        adapter: ordersSourceAdapter,
      },
      'source-customers': {
        id: 'source-customers',
        label: 'Customers',
        tableName: 'customers',
        fields: [field('id', 'number'), field('segment'), field('country')],
        adapter: customersSourceAdapter,
      },
    };

    // Main adapter is the one at the orders endpoint WITH dataSources context.
    // It uses the same fetch (ordersEndpoint) but its own loader instance.
    // Suppress the expected dev-mode cross-endpoint warning so vitest-fail-on-console
    // does not fail the test.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mainAdapter = createBatchingAdapter(ordersEndpoint, {
      fetchFn: overrides.ordersFetch as unknown as typeof fetch,
      batchDelayMs: 0,
      dataSources,
      relationships: overrides.relationships,
      expressionFields: overrides.expressionFields,
    });
    warnSpy.mockRestore();

    return { mainAdapter };
  }

  const defaultRelationships: StudioRelationship[] = [
    {
      id: 'rel-1',
      type: 'many-to-one',
      sourceId: 'source-orders',
      sourceField: 'customerId',
      targetId: 'source-customers',
      targetField: 'id',
    },
  ];

  it('patches cross-endpoint join field values into primary rows', async () => {
    const ordersFetch = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { id: 101, customerId: 1, total: 500 },
          { id: 102, customerId: 2, total: 300 },
        ],
      },
    ]);
    const customersFetch = makeOkFetch([
      {
        id: '_xjoin_source-customers',
        rows: [
          { id: 1, segment: 'Corporate', country: 'US' },
          { id: 2, segment: 'Consumer', country: 'DE' },
        ],
      },
    ]);

    const { mainAdapter } = buildHarness({
      ordersFetch,
      customersFetch,
      relationships: defaultRelationships,
      expressionFields: [
        {
          id: 'customer-segment',
          label: 'Customer Segment',
          sourceId: 'source-orders',
          isMeasure: false,
          expression: { joinSourceId: 'source-customers', fieldId: 'segment' },
        },
      ],
    });

    const result = await mainAdapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['id', 'customerId', 'total', 'customer-segment'],
      }),
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ id: 101, 'customer-segment': 'Corporate' });
    expect(result.rows[1]).toMatchObject({ id: 102, 'customer-segment': 'Consumer' });
  });

  it('adds the FK column to the server request when it is not already selected', async () => {
    const ordersFetch = makeOkFetch([
      { id: 'w1', rows: [{ id: 101, customerId: 1, total: 500 }] },
    ]);
    const customersFetch = makeOkFetch([
      { id: '_xjoin_source-customers', rows: [{ id: 1, segment: 'Corporate', country: 'US' }] },
    ]);

    const { mainAdapter } = buildHarness({
      ordersFetch,
      customersFetch,
      relationships: defaultRelationships,
      expressionFields: [
        {
          id: 'customer-segment',
          label: 'Customer Segment',
          sourceId: 'source-orders',
          isMeasure: false,
          expression: { joinSourceId: 'source-customers', fieldId: 'segment' },
        },
      ],
    });

    await mainAdapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        widgetId: 'w1',
        // NOTE: 'customerId' is NOT in select — it should be added automatically as FK
        select: ['id', 'total', 'customer-segment'],
      }),
    );

    const body = JSON.parse((ordersFetch.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ columns: string[] }>;
    };
    expect(body.widgets[0].columns).toContain('customerId');
  });

  it('fetches each join source only once when multiple expression fields join the same source', async () => {
    const ordersFetch = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { id: 101, customerId: 1 },
          { id: 102, customerId: 2 },
        ],
      },
    ]);
    const customersFetch = makeOkFetch([
      {
        id: '_xjoin_source-customers',
        rows: [
          { id: 1, segment: 'Corporate', country: 'US' },
          { id: 2, segment: 'Consumer', country: 'DE' },
        ],
      },
    ]);

    // Two expression fields both joining source-customers
    const { mainAdapter } = buildHarness({
      ordersFetch,
      customersFetch,
      relationships: defaultRelationships,
      expressionFields: [
        {
          id: 'customer-segment',
          label: 'Customer Segment',
          sourceId: 'source-orders',
          isMeasure: false,
          expression: { joinSourceId: 'source-customers', fieldId: 'segment' },
        },
        {
          id: 'customer-country',
          label: 'Customer Country',
          sourceId: 'source-orders',
          isMeasure: false,
          expression: { joinSourceId: 'source-customers', fieldId: 'country' },
        },
      ],
    });

    const result = await mainAdapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        widgetId: 'w1',
        select: ['id', 'customer-segment', 'customer-country'],
      }),
    );

    // Customers endpoint called only once (deduplication by joinSourceId:joinPkField key)
    expect(customersFetch).toHaveBeenCalledTimes(1);

    // Both fields must be enriched
    expect(result.rows[0]).toMatchObject({ 'customer-segment': 'Corporate', 'customer-country': 'US' });
    expect(result.rows[1]).toMatchObject({ 'customer-segment': 'Consumer', 'customer-country': 'DE' });
  });

  it('returns null for unmatched FK values', async () => {
    const ordersFetch = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { id: 101, customerId: 999 }, // FK has no matching customer
        ],
      },
    ]);
    const customersFetch = makeOkFetch([
      { id: '_xjoin_source-customers', rows: [{ id: 1, segment: 'Corporate', country: 'US' }] },
    ]);

    const { mainAdapter } = buildHarness({
      ordersFetch,
      customersFetch,
      relationships: defaultRelationships,
      expressionFields: [
        {
          id: 'customer-segment',
          label: 'Customer Segment',
          sourceId: 'source-orders',
          isMeasure: false,
          expression: { joinSourceId: 'source-customers', fieldId: 'segment' },
        },
      ],
    });

    const result = await mainAdapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        widgetId: 'w1',
        select: ['id', 'customerId', 'customer-segment'],
      }),
    );

    expect(result.rows[0]['customer-segment']).toBeNull();
  });
});
