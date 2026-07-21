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

let uidCounter = 0;
/** Returns a unique endpoint string per test invocation. */
function uid(): string {
  uidCounter += 1;
  return `/api/test-${uidCounter}`;
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

function makeOkFetch(
  results: Array<{ id: string; rows: Record<string, unknown>[]; error?: string }>,
) {
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
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

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
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

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
    const adapter = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({ widgetId: 'w1', tableName: 'orders', select: ['id', 'total'] }),
    );

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      widgets: Array<{ id: string; table: string; columns: string[] }>;
    };
    expect(body.widgets).toHaveLength(1);
    // The wire id is now `${widgetId}::${cacheKey}` (finding 2.14), not the bare
    // widgetId, so two descriptors for the same widget with different cacheKeys route
    // to distinct results instead of silently colliding.
    expect(body.widgets[0].id).toMatch(/^w1::/);
    expect(body.widgets[0].table).toBe('orders');
    expect(body.widgets[0].columns).toContain('id');
    expect(body.widgets[0].columns).toContain('total');
  });

  it('rejects with an error when the server result is missing for a widget', async () => {
    const fetchFn = makeOkFetch([]); // no results for w1
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await expect(adapter.getRows(makeDescriptor({ widgetId: 'w1' }))).rejects.toThrow(/"w1"/);
  });
});

// ── Shared per-endpoint config isolation (finding 9) ─────────────────────────
//
// Simple-mode adapters for DIFFERENT sources can share one endpoint (see the
// "same-endpoint SQL JOIN generation" tests below). Registering a second instance at
// the same endpoint must not silently wipe out an earlier instance's `expressionFields`.

describe('createBatchingAdapter — shared endpoint config isolation', () => {
  it("does not let a later same-endpoint adapter wipe out an earlier instance's expressionFields", async () => {
    const endpoint = uid();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Source A registers first, with its own calculated field.
    const adapterA = createBatchingAdapter(endpoint, {
      fetchFn: makeOkFetch([]) as unknown as typeof fetch,
      batchDelayMs: 0,
      expressionFields: [
        {
          id: 'expr-margin',
          label: 'Margin',
          sourceId: 'source-orders',
          isMeasure: false,
          expression: { operator: 'subtract', inputs: [{ id: 'price' }, { id: 'cost' }] },
        },
      ],
    });

    // Source B registers afterwards at the SAME endpoint with no expressionFields of its
    // own. Its fetchFn becomes the shared loader's live fetch (last-write-wins is intentional,
    // finding 3.14) — so assertions below read from fetchFnB, not adapterA's original fetchFn.
    const fetchFnB = makeOkFetch([{ id: 'w1', rows: [] }]);
    createBatchingAdapter(endpoint, {
      fetchFn: fetchFnB as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    // A filter on source A's calculated field must still be recognised as an own-source
    // expression field and dropped from the server query (with a warning) — NOT sent as a
    // real predicate, which would fail server-side with "no such column".
    await adapterA.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        widgetId: 'w1',
        select: ['id', 'price', 'cost'],
        filter: {
          type: 'leaf',
          field: 'expr-margin',
          op: 'greater_than',
          value: 100,
          fieldType: 'number',
        },
      }),
    );

    expect(fetchFnB).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchFnB.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown }>;
    };
    expect(body.widgets[0].filters).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── Fetch failure ─────────────────────────────────────────────────────────────

describe('createBatchingAdapter — fetch failure', () => {
  it('propagates the HTTP status as an Error to all callers', async () => {
    const fetchFn = makeErrorFetch(503, 'Service Unavailable');
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await expect(
      Promise.all([
        adapter.getRows(makeDescriptor({ widgetId: 'w1' })),
        adapter.getRows(makeDescriptor({ widgetId: 'w2' })),
      ]),
    ).rejects.toThrow(/503/);
  });

  it('propagates a server-returned error field as an Error', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [], error: 'table not found' }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await expect(adapter.getRows(makeDescriptor({ widgetId: 'w1' }))).rejects.toThrow(
      /table not found/,
    );
  });
});

// ── Filter serialisation ──────────────────────────────────────────────────────

describe('createBatchingAdapter — filter serialisation', () => {
  it('serialises a leaf filter to a single predicate', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        filter: { type: 'leaf', field: 'status', op: 'equals', value: 'active' },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    expect(body.widgets[0].filters).toEqual([
      { column: 'status', operator: 'eq', value: 'active' },
    ]);
  });

  it('flattens an AND group into multiple predicates', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        filter: {
          type: 'group',
          logic: 'and',
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
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(makeDescriptor({ widgetId: 'w1', filter: undefined }));

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown }>;
    };
    expect(body.widgets[0].filters).toBeUndefined();
  });

  it('maps not_equals filter operator to neq', async () => {
    // not_equals pushed server-side diverges from in-memory NULL-row handling
    // (finding 2.16) — suppress the expected dev-mode divergence warning so
    // vitest-fail-on-console does not fail the test.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

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
    warnSpy.mockRestore();
  });
});

// ── Same-endpoint SQL JOIN generation ────────────────────────────────────────
//
// When both sources use the same adapter endpoint, `resolveField` generates a
// LEFT JOIN descriptor and a columnAlias so the server can execute the join in
// SQL rather than performing client-side enrichment.
// These tests verify the *request body* sent to the server, not the response.

describe('createBatchingAdapter — same-endpoint SQL JOIN generation', () => {
  /** Shared source/relationship fixtures used across tests. */
  function makeSameEndpointHarness(
    fetchFn: ReturnType<typeof makeOkFetch>,
    expressionFields: StudioExpressionField[],
    relationships?: StudioRelationship[],
  ) {
    const endpoint = uid();
    // Both sources get their adapter created against the *same* endpoint so
    // `getBatchingEndpoint` returns the same URL for both — triggering the
    // SQL JOIN path rather than the cross-endpoint enrichment fallback.
    const sharedAdapter = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    const dataSources: Record<string, StudioDataSource> = {
      'source-orders': {
        id: 'source-orders',
        label: 'Orders',
        tableName: 'orders',
        fields: [field('id', 'number'), field('customerId', 'number'), field('total', 'number')],
        adapter: sharedAdapter,
      },
      'source-customers': {
        id: 'source-customers',
        label: 'Customers',
        tableName: 'customers',
        fields: [field('id', 'number'), field('segment'), field('country')],
        adapter: sharedAdapter,
      },
    };

    const defaultRelationships: StudioRelationship[] = relationships ?? [
      {
        id: 'rel-orders-customers',
        type: 'many-to-one',
        sourceId: 'source-orders',
        sourceField: 'customerId',
        targetId: 'source-customers',
        targetField: 'id',
      },
    ];

    const adapter = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
      dataSources,
      relationships: defaultRelationships,
      expressionFields,
    });

    return { adapter, endpoint };
  }

  it('sends LEFT JOIN and columnAlias to the server for a JoinFieldExpression field', async () => {
    const fetchFn = makeOkFetch([
      { id: 'w1', rows: [{ id: 1, total: 500, 'expr-segment': 'Consumer' }] },
    ]);

    const { adapter } = makeSameEndpointHarness(fetchFn, [
      {
        id: 'expr-segment',
        label: 'Segment',
        sourceId: 'source-orders',
        isMeasure: false,
        expression: { joinSourceId: 'source-customers', fieldId: 'segment' },
      },
    ]);

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['id', 'total', 'expr-segment'],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{
        columns: string[];
        columnAliases?: Record<string, string>;
        joins?: Array<{ table: string; type: string; on: [string, string][] }>;
      }>;
    };
    const w = body.widgets[0];

    // Logical field ID is preserved in columns (server uses alias to map result back)
    expect(w.columns).toContain('expr-segment');

    // Physical column alias: server SELECTs `customers.segment AS "expr-segment"`
    expect(w.columnAliases).toMatchObject({ 'expr-segment': 'customers.segment' });

    // LEFT JOIN descriptor emitted so the server can resolve the column
    expect(w.joins).toHaveLength(1);
    expect(w.joins![0]).toMatchObject({
      table: 'customers',
      type: 'left',
    });
    // Join condition: orders.customerId = customers.id
    expect(w.joins![0].on[0]).toEqual(['orders.customerId', 'customers.id']);
  });

  it('does NOT add a cross-endpoint enrichment when join is same-endpoint', async () => {
    const fetchFn = makeOkFetch([
      { id: 'w1', rows: [{ id: 1, total: 500, 'expr-segment': 'Consumer' }] },
    ]);

    const { adapter } = makeSameEndpointHarness(fetchFn, [
      {
        id: 'expr-segment',
        label: 'Segment',
        sourceId: 'source-orders',
        isMeasure: false,
        expression: { joinSourceId: 'source-customers', fieldId: 'segment' },
      },
    ]);

    // Single request — no secondary fetch to the customers endpoint
    const result = await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['id', 'total', 'expr-segment'],
      }),
    );

    // Only one POST was made (no cross-endpoint enrichment call)
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Server-provided value is returned as-is (no client enrichment needed)
    expect(result.rows[0]['expr-segment']).toBe('Consumer');
  });

  it('generates joins for two expression fields on the same joined table', async () => {
    const fetchFn = makeOkFetch([
      {
        id: 'w1',
        rows: [{ id: 1, 'expr-segment': 'Consumer', 'expr-country': 'US' }],
      },
    ]);

    const { adapter } = makeSameEndpointHarness(fetchFn, [
      {
        id: 'expr-segment',
        label: 'Segment',
        sourceId: 'source-orders',
        isMeasure: false,
        expression: { joinSourceId: 'source-customers', fieldId: 'segment' },
      },
      {
        id: 'expr-country',
        label: 'Country',
        sourceId: 'source-orders',
        isMeasure: false,
        expression: { joinSourceId: 'source-customers', fieldId: 'country' },
      },
    ]);

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['id', 'expr-segment', 'expr-country'],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{
        columnAliases?: Record<string, string>;
        joins?: Array<{ table: string }>;
      }>;
    };
    const w = body.widgets[0];

    // Both fields aliased
    expect(w.columnAliases).toMatchObject({
      'expr-segment': 'customers.segment',
      'expr-country': 'customers.country',
    });

    // Only one JOIN for the shared table (deduplication by table name)
    expect(w.joins).toHaveLength(1);
    expect(w.joins![0].table).toBe('customers');
  });

  it('drops a JoinFieldExpression field when no matching relationship exists', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [{ id: 1, total: 500 }] }]);

    // Provide expression field but NO relationship between orders and products
    const { adapter } = makeSameEndpointHarness(
      fetchFn,
      [
        {
          id: 'expr-product-name',
          label: 'Product Name',
          sourceId: 'source-orders',
          isMeasure: false,
          expression: { joinSourceId: 'source-products', fieldId: 'name' }, // source-products not in dataSources
        },
      ],
      [], // no relationships
    );

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['id', 'total', 'expr-product-name'],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ columns?: string[]; joins?: unknown[] }>;
    };
    const w = body.widgets[0];

    // Unresolvable field must be dropped (not sent to server)
    expect(w.columns).not.toContain('expr-product-name');
    // No JOIN emitted
    expect(w.joins).toBeUndefined();
  });

  it('resolves a cross-filter filter column via JOIN when it is a JoinFieldExpression', async () => {
    // Scenario: a filter on `expr-segment` (defined on orders) is applied to an
    // orders widget. The filter's column must be resolved to the physical
    // `customers.segment` column (with JOIN) — not the logical `expr-segment` ID.
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);

    const { adapter } = makeSameEndpointHarness(fetchFn, [
      {
        id: 'expr-segment',
        label: 'Segment',
        sourceId: 'source-orders',
        isMeasure: false,
        expression: { joinSourceId: 'source-customers', fieldId: 'segment' },
      },
    ]);

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['id', 'total', 'expr-segment'],
        filter: {
          type: 'leaf',
          field: 'expr-segment',
          op: 'equals',
          value: 'Consumer',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters: Array<{ column: string; value: unknown }> }>;
    };
    const { filters } = body.widgets[0];

    // The filter column must be resolved to the physical column, not the logical alias
    expect(filters).toHaveLength(1);
    expect(filters[0].column).toBe('customers.segment');
    expect(filters[0].value).toBe('Consumer');
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
    const ordersFetch = makeOkFetch([{ id: 'w1', rows: [{ id: 101, customerId: 1, total: 500 }] }]);
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
    expect(result.rows[0]).toMatchObject({
      'customer-segment': 'Corporate',
      'customer-country': 'US',
    });
    expect(result.rows[1]).toMatchObject({
      'customer-segment': 'Consumer',
      'customer-country': 'DE',
    });
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

  it('probes the cross-endpoint join with the normalized key policy (numeric FK vs string PK)', async () => {
    // Primary rows carry a NUMERIC FK; the join source's PK arrives as a STRING. Keying/probing
    // the join index by the raw value would fail to match; normalizeJoinKey coerces both (2.20).
    const ordersFetch = makeOkFetch([{ id: 'w1', rows: [{ id: 101, customerId: 1, total: 500 }] }]);
    const customersFetch = makeOkFetch([
      { id: '_xjoin_source-customers', rows: [{ id: '1', segment: 'Corporate', country: 'US' }] },
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
        select: ['id', 'customerId', 'total', 'customer-segment'],
      }),
    );

    expect(result.rows[0]).toMatchObject({ id: 101, 'customer-segment': 'Corporate' });
  });
});

// ── Aggregation push-down policy (findings 1.8 / 2.25 / 1.7) ──────────────────

describe('createBatchingAdapter — aggregation & filter push-down policy', () => {
  it('routes avg + xGroupBy to raw rows client-side (no server avg-of-averages)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['date', 'total'],
        groupBy: 'date',
        xGroupBy: 'month',
        aggregations: [{ field: 'total', fn: 'avg', alias: 'total' }],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: unknown; columns: string[] }>;
    };
    // Aggregations stripped → server returns raw rows; the widget averages client-side per bucket.
    expect(body.widgets[0].aggregations).toBeUndefined();
    expect(body.widgets[0].columns).toContain('total');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still pushes avg down when there is no xGroupBy re-bucketing', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['category', 'total'],
        groupBy: 'category',
        aggregations: [{ field: 'total', fn: 'avg', alias: 'total' }],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: Array<{ func: string }> }>;
    };
    expect(body.widgets[0].aggregations).toEqual([
      { column: 'total', func: 'avg', alias: 'total' },
    ]);
  });

  it('pushes a fully-bounded between whose lower bound is a genuine 0 (not treated as unset)', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        filter: {
          type: 'leaf',
          field: 'total',
          op: 'between',
          value: { from: 0, to: 100 },
          fieldType: 'number',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    // A truthiness bound check treated `from: 0` as unset → the whole between stayed client-side
    // (absent from server filters). It must be pushed as a two-bound between (finding 2.25).
    expect(body.widgets[0].filters).toEqual([
      { column: 'total', operator: 'between', value: [0, 100] },
    ]);
  });

  it('warns (never silently drops) a filter on an arithmetic expression field', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const endpoint = uid();
    const sharedAdapter = createBatchingAdapter(endpoint, {
      fetchFn: makeOkFetch([{ id: 'w1', rows: [] }]) as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    const dataSources: Record<string, StudioDataSource> = {
      'source-orders': {
        id: 'source-orders',
        label: 'Orders',
        tableName: 'orders',
        fields: [field('id', 'number'), field('price', 'number'), field('cost', 'number')],
        adapter: sharedAdapter,
      },
    };
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
      dataSources,
      relationships: [],
      expressionFields: [
        {
          id: 'expr-margin',
          label: 'Margin',
          sourceId: 'source-orders',
          isMeasure: false,
          expression: { operator: 'subtract', inputs: [{ id: 'price' }, { id: 'cost' }] },
        },
      ],
    });

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['id', 'price', 'cost'],
        filter: {
          type: 'leaf',
          field: 'expr-margin',
          op: 'greater_than',
          value: 100,
          fieldType: 'number',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown }>;
    };
    // The predicate on the arithmetic expression field is dropped from the server query...
    expect(body.widgets[0].filters).toBeUndefined();
    // ...but never silently: a divergence warning fires (honouring the module's contract).
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // ─── Finding 2.8 ────────────────────────────────────────────────────────────
  it('does not silently drop a valueless second condition (is_not_empty) — falls back to the client-side residual', async () => {
    // Leaf: status != 'archived' AND status is_not_empty. `value2` is legitimately absent for
    // `is_not_empty` (mirrors `isConditionComplete`'s in-memory rule), so this second condition
    // IS present — but has no server-side operator equivalent. The whole leaf must therefore be
    // routed to the client-side residual (never silently reduced to just the first condition).
    const fetchFn = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { id: 1, status: 'active' }, // kept: != archived AND not empty
          { id: 2, status: 'archived' }, // excluded by the first condition
          { id: 3, status: '' }, // excluded by the second condition (is_not_empty)
          { id: 4, status: null }, // excluded by the second condition (is_not_empty)
        ],
      },
    ]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    const result = await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['id', 'status'],
        filter: {
          type: 'leaf',
          field: 'status',
          op: 'not_equals',
          value: 'archived',
          op2: 'is_not_empty',
          value2: undefined,
          conjunction: 'and',
        },
      }),
    );

    // Only row 1 survives both conditions.
    expect(result.rows.map((r) => r.id)).toEqual([1]);

    // The server request must not silently encode ONLY the first condition as if it were the
    // whole filter — the leaf is untranslatable as a whole and should be withheld entirely,
    // deferring both conditions to the client-side residual instead.
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown; columns: string[] }>;
    };
    expect(body.widgets[0].filters).toBeUndefined();
    // `status` must still be selected so the client-side residual can evaluate it.
    expect(body.widgets[0].columns).toContain('status');
  });

  // ─── Finding 2.9 ────────────────────────────────────────────────────────────
  it('routes an aggregated descriptor to raw rows when an incoming cross-filter is present, instead of emptying the widget', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Simulate the server-aggregated shape: one row per group with the group column
    // (`category`) and the alias (`total`) only — no `region` column, matching what a
    // server-side GROUP BY would actually return.
    const fetchFn = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { category: 'A', region: 'EU', total: 10 },
          { category: 'B', region: 'US', total: 20 },
        ],
      },
    ]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['category', 'region', 'total'],
        groupBy: 'category',
        aggregations: [{ field: 'total', fn: 'sum', alias: 'total' }],
        hasIncomingCrossOrInteractiveFilters: true,
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: unknown }>;
    };
    // Aggregation is stripped — the server returns raw rows so the cross-filter (enforced
    // client-side over a field like `region`, which a group-by response would never carry) can
    // actually match something instead of reading `undefined` on every row and emptying the
    // widget.
    expect(body.widgets[0].aggregations).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still pushes the aggregation down when there is no incoming cross/interactive filter', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['category', 'total'],
        groupBy: 'category',
        aggregations: [{ field: 'total', fn: 'sum', alias: 'total' }],
        hasIncomingCrossOrInteractiveFilters: false,
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: Array<{ func: string }> }>;
    };
    expect(body.widgets[0].aggregations).toEqual([
      { column: 'total', func: 'sum', alias: 'total' },
    ]);
  });

  // ─── Finding 2.11 ───────────────────────────────────────────────────────────
  it('simple mode suppresses ORDER BY when groupBy is an expression-field id (unresolved column)', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
      // Simple mode: dataSources/relationships omitted. expressionFields is still an
      // independent option (used only to detect an unresolved-column groupBy here).
      expressionFields: [
        {
          id: 'expr-margin',
          label: 'Margin',
          sourceId: 'orders',
          isMeasure: false,
          expression: { operator: 'subtract', inputs: [{ id: 'price' }, { id: 'cost' }] },
        },
      ],
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        sourceId: 'orders',
        select: ['expr-margin', 'total'],
        groupBy: 'expr-margin',
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ orderBy?: unknown }>;
    };
    // `expr-margin` has no physical column of that name — emitting it unresolved would fail
    // the whole batch entry with "no such column" (finding 2.11).
    expect(body.widgets[0].orderBy).toBeUndefined();
  });

  it('simple mode still orders by a plain physical groupBy column', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['category', 'total'],
        groupBy: 'category',
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ orderBy?: Array<{ column: string; direction: string }> }>;
    };
    expect(body.widgets[0].orderBy).toEqual([{ column: 'category', direction: 'asc' }]);
  });
});

// ── Wire-path filter / date / rank fixes (findings T1.1 / T1.2 / T1.3 / T2.3 / T2.4) ─────────────

describe('createBatchingAdapter — incomplete-filter handling (finding T1.1)', () => {
  it('does not push an incomplete condition (empty value) to the server; routes it to the no-op client residual', async () => {
    const fetchFn = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { id: 1, status: 'active' },
          { id: 2, status: '' },
        ],
      },
    ]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    const result = await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['id', 'status'],
        // The drawer's add-filter default after picking a field but before typing a value.
        filter: { type: 'leaf', field: 'status', op: 'equals', value: '' },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown }>;
    };
    // No `status = ''` predicate reaches the server...
    expect(body.widgets[0].filters).toBeUndefined();
    // ...and the client residual re-drops the incomplete filter (isFilterComplete) → all rows kept.
    expect(result.rows.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('createBatchingAdapter — incomplete second condition (finding T1.2)', () => {
  it('does not emit a phantom second predicate when op2 is set but value2 is incomplete', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['amount'],
        // The drawer's "+ Add condition" default: op2 set, value2 still empty. In-memory the
        // secondary is ignored; the wire must NOT ship a phantom `amount = ''`.
        filter: {
          type: 'leaf',
          field: 'amount',
          op: 'greater_than',
          value: 5,
          op2: 'less_than',
          value2: '',
          conjunction: 'and',
          fieldType: 'number',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    // Only the complete first condition is pushed — no phantom second predicate.
    expect(body.widgets[0].filters).toEqual([{ column: 'amount', operator: 'gt', value: 5 }]);
  });
});

describe('createBatchingAdapter — day-granular date translation (finding T1.3)', () => {
  it('translates a bare-date "<=" on a datetime column to "< next-day"', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['createdAt'],
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'less_than_or_equal',
          value: '2026-07-10',
          fieldType: 'datetime',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    // A plain `<= '2026-07-10'` (midnight) would drop the rest of Jul 10 on a datetime column; the
    // faithful day-granular form is `< '2026-07-11'`.
    expect(body.widgets[0].filters).toEqual([
      { column: 'createdAt', operator: 'lt', value: '2026-07-11' },
    ]);
  });

  it('translates a bare-date ">" on a datetime column to ">= next-day"', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['createdAt'],
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'greater_than',
          value: '2026-07-10',
          fieldType: 'datetime',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    // `> day` at day granularity excludes the whole of Jul 10 → `>= '2026-07-11'`.
    expect(body.widgets[0].filters).toEqual([
      { column: 'createdAt', operator: 'gte', value: '2026-07-11' },
    ]);
  });

  it('leaves a bare-date "<" and ">=" unchanged (already day-faithful)', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['createdAt'],
        filter: {
          type: 'group',
          logic: 'and',
          children: [
            {
              type: 'leaf',
              field: 'createdAt',
              op: 'greater_than_or_equal',
              value: '2026-07-01',
              fieldType: 'datetime',
            },
            {
              type: 'leaf',
              field: 'createdAt',
              op: 'less_than',
              value: '2026-07-10',
              fieldType: 'datetime',
            },
          ],
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    expect(body.widgets[0].filters).toEqual([
      { column: 'createdAt', operator: 'gte', value: '2026-07-01' },
      { column: 'createdAt', operator: 'lt', value: '2026-07-10' },
    ]);
  });

  it('translates a bare-date "between" upper bound to a "< next-day" on a datetime column', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['createdAt'],
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'between',
          value: { from: '2026-07-01', to: '2026-07-10' },
          fieldType: 'datetime',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    // `[from, to]` day-granular → `>= from` AND `< nextDay(to)` so the whole last day is included.
    expect(body.widgets[0].filters).toEqual([
      { column: 'createdAt', operator: 'gte', value: '2026-07-01' },
      { column: 'createdAt', operator: 'lt', value: '2026-07-11' },
    ]);
  });

  it('does NOT translate a datetime bound that carries an explicit time-of-day', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['createdAt'],
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'less_than_or_equal',
          value: '2026-07-10T23:59:59.999Z',
          fieldType: 'datetime',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    // Full-precision bound keeps `<=` as-is (matches the in-memory full-timestamp comparison).
    expect(body.widgets[0].filters).toEqual([
      { column: 'createdAt', operator: 'lte', value: '2026-07-10T23:59:59.999Z' },
    ]);
  });

  // Regression: `toWirePredicateValue` only resolved a TOP-LEVEL `RelativeDateValue`, so a
  // relative bound nested inside a `between { from, to }` (a shape the drawer's
  // `FilterValueInput` lets a user author for either bound) shipped to the server raw/unresolved
  // instead of being converted to a concrete date first.
  describe('relative dates nested inside a "between" bound', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves a relative "from" bound nested inside a between filter', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));
      const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
      const adapter = createBatchingAdapter(uid(), {
        fetchFn: fetchFn as unknown as typeof fetch,
        batchDelayMs: 0,
      });

      await adapter.getRows(
        makeDescriptor({
          widgetId: 'w1',
          select: ['createdAt'],
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

      const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
        widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
      };
      // `from` resolves to a concrete bare date (7 days before the frozen "now"); the day-granular
      // `to` bound still translates to "< next day" so the whole last day is included.
      expect(body.widgets[0].filters).toEqual([
        { column: 'createdAt', operator: 'gte', value: '2026-07-12' },
        { column: 'createdAt', operator: 'lt', value: '2026-07-20' },
      ]);
    });

    it('resolves a relative "to" bound nested inside a between filter', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));
      const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
      const adapter = createBatchingAdapter(uid(), {
        fetchFn: fetchFn as unknown as typeof fetch,
        batchDelayMs: 0,
      });

      await adapter.getRows(
        makeDescriptor({
          widgetId: 'w1',
          select: ['createdAt'],
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

      const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
        widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
      };
      expect(body.widgets[0].filters).toEqual([
        { column: 'createdAt', operator: 'gte', value: '2026-07-01' },
        // `to` resolves to a concrete bare date (1 day after the frozen "now") and, being
        // day-granular, still translates to "< next day".
        { column: 'createdAt', operator: 'lt', value: '2026-07-21' },
      ]);
    });

    it('resolves relative bounds on BOTH sides of a between filter, including sub-day units', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));
      const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
      const adapter = createBatchingAdapter(uid(), {
        fetchFn: fetchFn as unknown as typeof fetch,
        batchDelayMs: 0,
      });

      await adapter.getRows(
        makeDescriptor({
          widgetId: 'w1',
          select: ['createdAt'],
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

      const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
        widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
      };
      // Both bounds carry an explicit time-of-day once resolved, so neither is translated to a
      // "next day" bound — they ship as plain `gte`/`lte` at full instant precision.
      expect(body.widgets[0].filters).toEqual([
        { column: 'createdAt', operator: 'gte', value: '2026-07-19T10:00:00.000Z' },
        { column: 'createdAt', operator: 'lte', value: '2026-07-19T12:30:00.000Z' },
      ]);
    });
  });
});

describe('createBatchingAdapter — empty-selection semantics (finding T2.3)', () => {
  it('a selection-mode empty "in []" ("any value") matches EVERYTHING on the adapter path', async () => {
    const fetchFn = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { id: 1, status: 'active' },
          { id: 2, status: 'closed' },
        ],
      },
    ]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    const result = await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['id', 'status'],
        filter: { type: 'leaf', field: 'status', op: 'in', value: [], filterMode: 'selection' },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown }>;
    };
    // Empty-`in` is not server-translatable (the middleware would drop it) → no server predicate...
    expect(body.widgets[0].filters).toBeUndefined();
    // ...and the residual, carrying filterMode 'selection', drops the empty selection → all rows.
    expect(result.rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('a condition-mode empty "in []" still matches NOTHING (distinct from an empty selection)', async () => {
    const fetchFn = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { id: 1, status: 'active' },
          { id: 2, status: 'closed' },
        ],
      },
    ]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    const result = await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['id', 'status'],
        filter: { type: 'leaf', field: 'status', op: 'in', value: [], filterMode: 'condition' },
      }),
    );

    // Condition-mode `in []` is a complete predicate that matches nothing in-memory — the residual
    // must preserve that, proving filterMode carry (not a blanket empty-array no-op).
    expect(result.rows).toEqual([]);
  });
});

describe('createBatchingAdapter — rank + aggregation push-down (finding T2.4)', () => {
  it('routes an aggregated descriptor to raw rows when a rank filter is present', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['category', 'profit'],
        groupBy: 'category',
        aggregations: [{ field: 'profit', fn: 'sum', alias: 'profit' }],
        hasRankFilters: true,
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: unknown }>;
    };
    // Aggregation stripped → server returns raw rows so the client rank reduction can sum the
    // rank measure per group instead of ranking over group-collapsed rows.
    expect(body.widgets[0].aggregations).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still pushes the aggregation down when there is no rank filter', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['category', 'profit'],
        groupBy: 'category',
        aggregations: [{ field: 'profit', fn: 'sum', alias: 'profit' }],
        hasRankFilters: false,
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: Array<{ func: string }> }>;
    };
    expect(body.widgets[0].aggregations).toEqual([
      { column: 'profit', func: 'sum', alias: 'profit' },
    ]);
  });
});
