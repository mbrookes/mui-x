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
import { applyFilters } from '../internals/filterUtils';
import type {
  StudioDataSource,
  StudioFilterState,
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
    const fetchFnA = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapterA = createBatchingAdapter(endpoint, {
      fetchFn: fetchFnA as unknown as typeof fetch,
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

    // Source B registers afterwards at the SAME endpoint with no expressionFields of its own.
    // It shares the loader (and therefore the merged expression-field list) but NOT the fetch:
    // `fetchFn` travels per request now (finding H7), so adapterA's own fetch still serves
    // adapterA's queries. `fetchFnB` must never be called for adapterA's descriptor.
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

    // adapterA's request went out on adapterA's OWN fetch (finding H7) …
    expect(fetchFnA).toHaveBeenCalledTimes(1);
    expect(fetchFnB).not.toHaveBeenCalled();
    // … and the merged expression-field list survived source B's registration (finding 9).
    const body = JSON.parse((fetchFnA.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown }>;
    };
    expect(body.widgets[0].filters).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── Per-source credentials on a shared endpoint (finding H7) ─────────────────
//
// The loader registry is keyed by endpoint alone, and DISTINCT sources legitimately share one
// endpoint (see the "same-endpoint SQL JOIN generation" tests). `fetchFn` used to be a single
// last-write-wins field on that shared entry, so whichever adapter was CONSTRUCTED last owned
// the fetch for BOTH sources — and since adapters are built inside per-source `useMemo`s,
// "constructed last" is render-order dependent. Tenant A's widgets could silently issue their
// queries with tenant B's credentials.

describe('createBatchingAdapter — per-source fetchFn on a shared endpoint', () => {
  it('each adapter uses its OWN fetchFn, regardless of construction order', async () => {
    const endpoint = uid();
    const fetchA = makeOkFetch([{ id: 'wA', rows: [{ tenant: 'A' }] }]);
    const fetchB = makeOkFetch([{ id: 'wB', rows: [{ tenant: 'B' }] }]);

    const adapterA = createBatchingAdapter(endpoint, {
      fetchFn: fetchA as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    // Constructed AFTER A — it must not take over A's fetch.
    const adapterB = createBatchingAdapter(endpoint, {
      fetchFn: fetchB as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapterA.getRows(makeDescriptor({ widgetId: 'wA', cacheKey: 'kA' }));
    await adapterB.getRows(makeDescriptor({ widgetId: 'wB', cacheKey: 'kB' }));

    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
    const bodyA = JSON.parse((fetchA.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ id: string }>;
    };
    const bodyB = JSON.parse((fetchB.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ id: string }>;
    };
    expect(bodyA.widgets[0].id).toMatch(/^wA::/);
    expect(bodyB.widgets[0].id).toMatch(/^wB::/);
  });

  it('does not coalesce concurrent requests whose fetchFn differs', async () => {
    const endpoint = uid();
    const fetchA = makeOkFetch([{ id: 'wA', rows: [{ tenant: 'A' }] }]);
    const fetchB = makeOkFetch([{ id: 'wB', rows: [{ tenant: 'B' }] }]);

    const adapterA = createBatchingAdapter(endpoint, {
      fetchFn: fetchA as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    const adapterB = createBatchingAdapter(endpoint, {
      fetchFn: fetchB as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    // Both inside ONE batch window: they land in the same dispatch but must go out as two
    // separate POSTs, one per credential — a single request can only carry one of them.
    const [a, b] = await Promise.all([
      adapterA.getRows(makeDescriptor({ widgetId: 'wA', cacheKey: 'kA' })),
      adapterB.getRows(makeDescriptor({ widgetId: 'wB', cacheKey: 'kB' })),
    ]);

    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
    expect(a.rows[0]).toMatchObject({ tenant: 'A' });
    expect(b.rows[0]).toMatchObject({ tenant: 'B' });
  });

  it('still collapses same-endpoint requests that DO share a fetchFn into one POST', async () => {
    const endpoint = uid();
    const sharedFetch = makeOkFetch([
      { id: 'w1', rows: [{ id: 1 }] },
      { id: 'w2', rows: [{ id: 2 }] },
    ]);

    const adapter1 = createBatchingAdapter(endpoint, {
      fetchFn: sharedFetch as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    const adapter2 = createBatchingAdapter(endpoint, {
      fetchFn: sharedFetch as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await Promise.all([
      adapter1.getRows(makeDescriptor({ widgetId: 'w1', cacheKey: 'k1' })),
      adapter2.getRows(makeDescriptor({ widgetId: 'w2', cacheKey: 'k2' })),
    ]);

    expect(sharedFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((sharedFetch.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ id: string }>;
    };
    expect(body.widgets).toHaveLength(2);
  });

  it("one group's transport failure does not fail another group's requests", async () => {
    const endpoint = uid();
    const failingFetch = makeErrorFetch(503, 'Service Unavailable');
    const okFetch = makeOkFetch([{ id: 'wOk', rows: [{ id: 1 }] }]);

    const failingAdapter = createBatchingAdapter(endpoint, {
      fetchFn: failingFetch as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    const okAdapter = createBatchingAdapter(endpoint, {
      fetchFn: okFetch as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    const results = await Promise.allSettled([
      failingAdapter.getRows(makeDescriptor({ widgetId: 'wFail', cacheKey: 'kF' })),
      okAdapter.getRows(makeDescriptor({ widgetId: 'wOk', cacheKey: 'kO' })),
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
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

  // ── Enrichment lookups are cached and column-narrowed (finding M14) ───────────
  //
  // The lookup map used to be created INSIDE `batchFn`, so its lifetime was a single dispatch:
  // a 500k-row `customers` dimension meant an unfiltered `SELECT *` plus a 500k-entry client-side
  // `Map` on EVERY 50ms batch — i.e. on every filter change, cross-filter click and widget edit.

  it('fetches the join dimension ONCE across separate batch dispatches', async () => {
    const ordersFetch = makeOkFetch([{ id: 'w1', rows: [{ id: 101, customerId: 1 }] }]);
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

    const descriptor = makeDescriptor({
      sourceId: 'source-orders',
      widgetId: 'w1',
      select: ['id', 'customerId', 'customer-segment'],
    });

    // Two SEPARATE dispatches (each `await` closes the batch window before the next call).
    await mainAdapter.getRows({ ...descriptor, cacheKey: 'k1' });
    await mainAdapter.getRows({ ...descriptor, cacheKey: 'k2' });

    expect(ordersFetch).toHaveBeenCalledTimes(2);
    expect(customersFetch).toHaveBeenCalledTimes(1);
  });

  it('selects only the PK and the join fields this batch needs, not the whole dimension', async () => {
    const ordersFetch = makeOkFetch([{ id: 'w1', rows: [{ id: 101, customerId: 1 }] }]);
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
        select: ['id', 'customerId', 'customer-segment'],
      }),
    );

    const lookupBody = JSON.parse(
      (customersFetch.mock.calls[0][1] as RequestInit).body as string,
    ) as {
      widgets: Array<{ columns: string[] }>;
    };
    // `id` (the join PK) + `segment` (the only field asked for) — NOT `country`.
    expect(lookupBody.widgets[0].columns.slice().sort()).toEqual(['id', 'segment']);
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

// ── Date `equals` / `not_equals` day granularity (finding T1.3b) ─────────────────────────────
//
// `equals`/`not_equals` on a `date`/`datetime` field are DAY-granular in the in-memory evaluator
// for EVERY value form — `compileSingleCondition` runs BOTH sides through `toDayComparable`, which
// truncates to `YYYY-MM-DD` (unlike the ordering bounds above, which only widen a value that
// carries no time-of-day). The wire path did neither: `equals` shipped a raw `eq` against a bare
// `'YYYY-MM-DD'`, matching only the exact-midnight rows of a DATETIME column (typically none), and
// `not_equals` shipped a raw `neq`, KEEPING the whole day the evaluator excludes. Both were merely
// `console.warn`ed, so a dashboard viewer saw a wrong number and only a developer saw the note.

/** One predicate as the middleware's wire protocol spells it. */
interface WirePredicate {
  column: string;
  operator: string;
  value: unknown;
}

/**
 * Evaluate a wire predicate list the way a SQL engine would: RAW comparisons against the stored
 * column value, with none of Studio's date normalization, and SQL three-valued NULL handling.
 * That literalness is the point — it is what makes a parity assertion against `applyFilters`
 * meaningful rather than circular.
 */
function applyWirePredicates(
  rows: Record<string, unknown>[],
  predicates: WirePredicate[] = [],
): Record<string, unknown>[] {
  return rows.filter((row) =>
    predicates.every(({ column, operator, value }) => {
      const rv = row[column] as string | null | undefined;
      const cmp = value as string;
      switch (operator) {
        case 'eq':
          return rv === cmp;
        // SQL `col != x` is UNKNOWN (→ excluded) for a NULL column, unlike the evaluator.
        case 'neq':
          return rv != null && rv !== cmp;
        case 'gt':
          return rv != null && rv > cmp;
        case 'gte':
          return rv != null && rv >= cmp;
        case 'lt':
          return rv != null && rv < cmp;
        case 'lte':
          return rv != null && rv <= cmp;
        case 'in':
          return Array.isArray(value) && rv != null && value.includes(rv);
        case 'between': {
          const [lo, hi] = value as [string, string];
          return rv != null && rv >= lo && rv <= hi;
        }
        default:
          throw new Error(`unhandled wire operator "${operator}" in the test SQL stub`);
      }
    }),
  );
}

/** A fetch stub that actually executes the pushed-down predicates over `rows`. */
function makeSqlishFetch(rows: Record<string, unknown>[]) {
  return vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      widgets: Array<{ id: string; filters?: WirePredicate[] }>;
    };
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          // Echo the wire id back so responses route to the right caller.
          results: body.widgets.map((w) => ({
            id: w.id,
            rows: applyWirePredicates(rows, w.filters),
          })),
        }),
    });
  });
}

describe('createBatchingAdapter — date equals/not_equals day granularity (finding T1.3b)', () => {
  /** Rows straddling the Jul 10 day boundary on a DATETIME column. */
  const datetimeRows = [
    { id: 1, createdAt: '2026-07-09T23:30:00.000Z' }, // previous day, late
    { id: 2, createdAt: '2026-07-10T00:00:00.000Z' }, // exactly midnight — the only row a raw `eq` found
    { id: 3, createdAt: '2026-07-10T13:04:00.000Z' }, // same day, afternoon
    { id: 4, createdAt: '2026-07-11T00:00:00.000Z' }, // next day, midnight
  ];

  it('expands a bare-date "equals" on a datetime column to a [>= day, < next-day] pair', async () => {
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
          op: 'equals',
          value: '2026-07-10',
          fieldType: 'datetime',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: WirePredicate[] }>;
    };
    // `createdAt = '2026-07-10'` matched only the exact-midnight rows; the day-granular form is
    // the half-open interval the evaluator compares.
    expect(body.widgets[0].filters).toEqual([
      { column: 'createdAt', operator: 'gte', value: '2026-07-10' },
      { column: 'createdAt', operator: 'lt', value: '2026-07-11' },
    ]);
  });

  it('expands an "equals" whose value carries a time-of-day to the SAME day pair', async () => {
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
          op: 'equals',
          value: '2026-07-10T13:04:00.000Z',
          fieldType: 'datetime',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: WirePredicate[] }>;
    };
    // Deliberately NOT an exact `eq`, and deliberately unlike the `lte`/`gt`/`between` bounds a
    // few tests up, which DO keep full precision for a timed value. `equals`/`not_equals` do not
    // consult `isDateOnlyFilterValue` in-memory at all: `compileSingleCondition` truncates the
    // filter value to `YYYY-MM-DD` unconditionally, so "on this instant" already means "on this
    // day" everywhere else in Studio. Shipping `eq '2026-07-10T13:04:00.000Z'` would match the one
    // row stored at that exact instant while the evaluator matches the whole day — the same
    // midnight-skew bug this fix removes, one notch narrower.
    expect(body.widgets[0].filters).toEqual([
      { column: 'createdAt', operator: 'gte', value: '2026-07-10' },
      { column: 'createdAt', operator: 'lt', value: '2026-07-11' },
    ]);
  });

  it('routes an "equals" whose value is not reducible to a calendar day to the client residual', async () => {
    const fetchFn = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { id: 1, createdAt: '2026-07-10T13:04:00.000Z' },
          { id: 2, createdAt: '2026-07-11T13:04:00.000Z' },
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
        select: ['id', 'createdAt'],
        filter: {
          type: 'leaf',
          field: 'createdAt',
          // An epoch millisecond value: the evaluator normalizes it, but the adapter cannot build
          // the `[gte day, lt nextDay]` pair from it without reimplementing date parsing, and a
          // bare `eq 1783083840000` against a timestamp column matches nothing.
          op: 'equals',
          value: Date.UTC(2026, 6, 10, 13, 4),
          fieldType: 'datetime',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown }>;
    };
    expect(body.widgets[0].filters).toBeUndefined();
    // ...and the residual evaluates it faithfully, at day granularity, over the returned rows.
    expect(result.rows.map((r) => r.id)).toEqual([1]);
  });

  it('routes a "not_equals" on a datetime column to the client residual instead of pushing "neq"', async () => {
    const rows = [...datetimeRows, { id: 5, createdAt: null }];
    const fetchFn = makeSqlishFetch(rows);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    const result = await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['id', 'createdAt'],
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'not_equals',
          value: '2026-07-10',
          fieldType: 'datetime',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown }>;
    };
    // "not on day D" is `< D OR >= nextDay(D)` — an OR, which the AND-only wire protocol cannot
    // express — so unlike `equals` it gets no pushdown at all. A raw `neq '2026-07-10'` would have
    // kept rows 3 AND 2's neighbours on day 10 (only the midnight row 2 compares equal) and
    // dropped the NULL row 5.
    expect(body.widgets[0].filters).toBeUndefined();
    // The residual excludes the WHOLE of Jul 10 and keeps the NULL row, exactly like in-memory.
    expect(result.rows.map((r) => r.id)).toEqual([1, 4, 5]);
  });

  it('still pushes a bare "not_equals" down on a non-date field', async () => {
    // Pins that the date carve-out above is narrow: a string `not_equals` keeps its pushdown (and
    // its NULL-handling warning, which stays because SQL three-valued logic is not fixable here).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
          field: 'status',
          op: 'not_equals',
          value: 'closed',
          fieldType: 'string',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: WirePredicate[] }>;
    };
    expect(body.widgets[0].filters).toEqual([
      { column: 'status', operator: 'neq', value: 'closed' },
    ]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('no longer warns about a date "equals" — the divergence it announced is gone', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
          op: 'equals',
          value: '2026-07-10',
          fieldType: 'date',
        },
      }),
    );

    // The old warning conceded the number was wrong ("Use a `between` range instead"); a viewer
    // never saw it. Nothing to warn about now that the predicate itself is faithful.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // The regression test proper: run the SAME filter through the in-memory evaluator and through
  // the adapter against a literal SQL-ish server, and require identical row sets. Before the fix
  // the evaluator returned rows 2 and 3 while the wire `createdAt = '2026-07-10'` returned only
  // row 2 — the "KPI reads 0 against a real value" symptom.
  it('returns the SAME rows as the in-memory evaluator for a date-only "equals" on a datetime column', async () => {
    const inMemoryFilter: StudioFilterState = {
      id: 'f1',
      // `scope` is unused by the evaluator; only field/operator/value/fieldType matter here.
      scope: { kind: 'widget', widgetId: 'w1' },
      field: 'createdAt',
      operator: 'equals',
      value: '2026-07-10',
      fieldType: 'datetime',
    };
    const inMemoryRows = applyFilters(datetimeRows, [inMemoryFilter]);

    const fetchFn = makeSqlishFetch(datetimeRows);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    const result = await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['id', 'createdAt'],
        filter: {
          type: 'leaf',
          field: 'createdAt',
          op: 'equals',
          value: '2026-07-10',
          fieldType: 'datetime',
        },
      }),
    );

    expect(result.rows).toEqual(inMemoryRows);
    // Guard against a vacuous pass (two empty row sets are also "identical").
    expect(inMemoryRows.map((r) => r.id)).toEqual([2, 3]);
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

// ── Unpushable filter + server aggregation ───────────────────────────────────

describe('createBatchingAdapter — unpushable filter + server aggregation', () => {
  it('strips the aggregation so a `contains` filter can still be enforced over raw rows', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { region: 'EU', product: 'pro plan', amount: 10 },
          { region: 'EU', product: 'basic plan', amount: 90 },
          { region: 'US', product: 'pro max', amount: 5 },
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
        select: ['region', 'amount'],
        groupBy: 'region',
        aggregations: [{ field: 'amount', fn: 'sum', alias: 'amount' }],
        // `contains` has no faithful wire form (the server's LIKE is case-sensitive), so this
        // leaf falls to the client residual.
        filter: {
          type: 'leaf',
          field: 'product',
          op: 'contains',
          value: 'pro',
          fieldType: 'string',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: unknown; columns?: string[]; filters?: unknown }>;
    };
    // The push-down decision must SEE the residual: with the aggregation pushed down the response
    // would be one row per region with no `product` column, the residual would be dropped with a
    // warning, and every bar would be summed over EVERY row.
    expect(body.widgets[0].aggregations).toBeUndefined();
    expect(body.widgets[0].filters).toBeUndefined();
    // The residual's column must be projected so it can be evaluated on the returned rows.
    expect(body.widgets[0].columns).toContain('product');
    expect(result.rows).toEqual([
      { region: 'EU', product: 'pro plan', amount: 10 },
      { region: 'US', product: 'pro max', amount: 5 },
    ]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still pushes the aggregation down when every filter leaf IS server-translatable', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['region', 'amount'],
        groupBy: 'region',
        aggregations: [{ field: 'amount', fn: 'sum', alias: 'amount' }],
        filter: {
          type: 'leaf',
          field: 'product',
          op: 'equals',
          value: 'pro',
          fieldType: 'string',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: unknown; filters?: unknown }>;
    };
    expect(body.widgets[0].aggregations).toEqual([
      { column: 'amount', func: 'sum', alias: 'amount' },
    ]);
    expect(body.widgets[0].filters).toEqual([{ column: 'product', operator: 'eq', value: 'pro' }]);
  });

  it('keeps the aggregation when the only residual leaf targets an own-source calculated column', async () => {
    // Such a leaf cannot be re-applied to raw rows either (the calculated column is not
    // materialised there), so giving up the push-down for it would buy nothing.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
      expressionFields: [
        {
          id: 'expr-margin',
          label: 'Margin',
          sourceId: 'orders',
          isMeasure: false,
          expression: { op: '-', left: { field: 'price' }, right: { field: 'cost' } },
        } as unknown as StudioExpressionField,
      ],
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['region', 'amount'],
        groupBy: 'region',
        aggregations: [{ field: 'amount', fn: 'sum', alias: 'amount' }],
        filter: {
          type: 'leaf',
          field: 'expr-margin',
          op: 'contains',
          value: '5',
          fieldType: 'string',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: unknown }>;
    };
    expect(body.widgets[0].aggregations).toEqual([
      { column: 'amount', func: 'sum', alias: 'amount' },
    ]);
    warnSpy.mockRestore();
  });
});

// ── Aggregation-strip ladder completeness ────────────────────────────────────

describe('createBatchingAdapter — aggregation-strip ladder completeness', () => {
  it('routes count_distinct to raw rows instead of downgrading it to a wire count', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['region', 'customer_id'],
        groupBy: 'region',
        aggregations: [{ field: 'customer_id', fn: 'count_distinct', alias: 'customer_id' }],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: unknown }>;
    };
    // The old downgrade shipped `func: 'count'`; the client then re-aggregated a one-row-per-group
    // response and every group's distinct count rendered as 1.
    expect(body.widgets[0].aggregations).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('routes a plain count to raw rows', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['region', 'amount'],
        groupBy: 'region',
        aggregations: [{ field: 'amount', fn: 'count', alias: 'amount' }],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: unknown }>;
    };
    expect(body.widgets[0].aggregations).toBeUndefined();
    // The warning is part of the contract: the strip is a documented divergence from a faithful
    // push-down, not a silent optimisation.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('routes avg to raw rows when a projected column sits outside the client aggregation grain', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        // A grid grouped by `region` that also projects `product`: the middleware GROUP BYs every
        // projected non-measure column, so the server would average per (region, product) and the
        // grid would average those per-product averages.
        select: ['region', 'product', 'amount'],
        groupBy: 'region',
        aggregations: [{ field: 'amount', fn: 'avg', alias: 'amount' }],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: unknown }>;
    };
    expect(body.widgets[0].aggregations).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still pushes a sum down at a finer server grain (sum re-reduces correctly)', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await adapter.getRows(
      makeDescriptor({
        widgetId: 'w1',
        select: ['region', 'product', 'amount'],
        groupBy: 'region',
        aggregations: [{ field: 'amount', fn: 'sum', alias: 'amount' }],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: unknown }>;
    };
    expect(body.widgets[0].aggregations).toEqual([
      { column: 'amount', func: 'sum', alias: 'amount' },
    ]);
  });
});

// ── Boolean wire values ──────────────────────────────────────────────────────

describe('createBatchingAdapter — boolean filter values', () => {
  it('sends a real boolean for "equals", never the drawer\'s "true" string', async () => {
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
          field: 'active',
          op: 'equals',
          value: 'true',
          fieldType: 'boolean',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    // `where(col, '=', 'true')` is implicitly cast by PostgreSQL but coerced NUMERICALLY to 0 by
    // MySQL's tinyint(1) and by SQLite — both return exactly the COMPLEMENT of the requested rows.
    expect(body.widgets[0].filters).toEqual([{ column: 'active', operator: 'eq', value: true }]);
  });

  it('sends a real boolean for "not_equals" too', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
          field: 'active',
          op: 'not_equals',
          value: 'false',
          fieldType: 'boolean',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: Array<{ column: string; operator: string; value: unknown }> }>;
    };
    expect(body.widgets[0].filters).toEqual([{ column: 'active', operator: 'neq', value: false }]);
    warnSpy.mockRestore();
  });

  it('routes a boolean value it cannot coerce to the client residual instead of guessing', async () => {
    const fetchFn = makeOkFetch([
      {
        id: 'w1',
        rows: [
          { id: 1, active: true },
          { id: 2, active: false },
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
        filter: {
          type: 'leaf',
          field: 'active',
          op: 'equals',
          // Not one of the two spellings the drawer produces — no certain SQL coercion exists.
          value: '1',
          fieldType: 'boolean',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown; columns?: string[] }>;
    };
    expect(body.widgets[0].filters).toBeUndefined();
    expect(body.widgets[0].columns).toContain('active');
    // The shared in-memory evaluator owns the answer: `String(row.active) === '1'` matches nothing.
    expect(result.rows).toEqual([]);
  });
});

// ── Cross-source filter fan-out ──────────────────────────────────────────────

describe('createBatchingAdapter — cross-source filter fan-out', () => {
  /** customers (the "one" side) <- orders (the "many" side), both on the same endpoint. */
  function makeOneSideHarness(fetchFn: ReturnType<typeof makeOkFetch>) {
    const endpoint = uid();
    const sharedAdapter = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    const dataSources: Record<string, StudioDataSource> = {
      'source-orders': {
        id: 'source-orders',
        label: 'Orders',
        tableName: 'orders',
        fields: [field('id', 'number'), field('customerId', 'number'), field('status')],
        adapter: sharedAdapter,
      },
      'source-customers': {
        id: 'source-customers',
        label: 'Customers',
        tableName: 'customers',
        fields: [field('id', 'number'), field('lifetime_value', 'number')],
        adapter: sharedAdapter,
      },
    };
    const relationships: StudioRelationship[] = [
      {
        id: 'rel-orders-customers',
        type: 'many-to-one',
        sourceId: 'source-orders',
        sourceField: 'customerId',
        targetId: 'source-customers',
        targetField: 'id',
      },
    ];
    return createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
      dataSources,
      relationships,
    });
  }

  it('emits a SEMI-JOIN, not a row-multiplying LEFT JOIN, for a filter on the "many" side', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = makeOneSideHarness(fetchFn);

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-customers',
        tableName: 'customers',
        widgetId: 'w1',
        select: ['lifetime_value'],
        aggregations: [{ field: 'lifetime_value', fn: 'sum', alias: 'lifetime_value' }],
        filter: {
          type: 'leaf',
          field: 'status',
          op: 'equals',
          value: 'shipped',
          fieldType: 'string',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{
        joins?: unknown;
        filters?: unknown;
        semiJoins?: unknown;
        columns?: string[];
      }>;
    };
    // `customers LEFT JOIN orders … WHERE orders.status = 'shipped'` makes a customer with three
    // shipped orders contribute three rows, so the KPI sum reads 3x. The semi-join form filters
    // the customer rows without multiplying them — the same answer
    // `dataSourceGraph.resolveRows` computes in memory.
    expect(body.widgets[0].joins).toBeUndefined();
    expect(body.widgets[0].semiJoins).toEqual([
      {
        table: 'orders',
        column: 'customers.id',
        foreignColumn: 'orders.customerId',
        filters: [{ column: 'orders.status', operator: 'eq', value: 'shipped' }],
      },
    ]);
    // The predicate lives INSIDE the subquery, never as a top-level WHERE on the
    // outer query (where it would reference a table the query does not join).
    expect(body.widgets[0].filters).toBeUndefined();
    // No divergence warning: the filter is now executed faithfully rather than dropped.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('groups every predicate on one foreign source into ONE subquery (EXISTS(A AND B))', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = makeOneSideHarness(fetchFn);

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-customers',
        tableName: 'customers',
        widgetId: 'w1',
        select: ['lifetime_value'],
        filter: {
          type: 'group',
          op: 'and',
          children: [
            { type: 'leaf', field: 'status', op: 'equals', value: 'shipped', fieldType: 'string' },
            // `customerId` exists ONLY on `orders` — a field name shared with the widget's own
            // source (like `id`) would resolve to the primary table instead.
            {
              type: 'leaf',
              field: 'customerId',
              op: 'greater_than',
              value: 10,
              fieldType: 'number',
            },
          ],
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ semiJoins?: Array<{ filters: unknown[] }> }>;
    };
    // ONE subquery carrying BOTH predicates — `EXISTS(order matching A AND B)`. Two subqueries
    // would mean `EXISTS(A) AND EXISTS(B)`, satisfied by a customer whose order #1 is shipped and
    // whose DIFFERENT order #2 has id > 10 — the exact divergence `dataSourceGraph.resolveRows`
    // groups its cross-filters to avoid.
    expect(body.widgets[0].semiJoins).toHaveLength(1);
    expect(body.widgets[0].semiJoins![0].filters).toEqual([
      { column: 'orders.status', operator: 'eq', value: 'shipped' },
      { column: 'orders.customerId', operator: 'gt', value: 10 },
    ]);
  });

  it('still drops a DISPLAY column on the "many" side, with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = makeOneSideHarness(fetchFn);

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-customers',
        tableName: 'customers',
        widgetId: 'w1',
        // `status` lives on the "many" side. A semi-join filters rows; it cannot produce a VALUE,
        // and in memory this picks ONE representative related value per row — a choice SQL cannot
        // make without a rule nobody declared. So this stays a visible degradation.
        select: ['lifetime_value', 'status'],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ columns?: string[]; joins?: unknown; semiJoins?: unknown }>;
    };
    expect(body.widgets[0].columns).toEqual(['lifetime_value']);
    expect(body.widgets[0].joins).toBeUndefined();
    expect(body.widgets[0].semiJoins).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('still joins for a filter on the "one" side (many-to-one from the widget, no fan-out)', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = makeOneSideHarness(fetchFn);

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['id'],
        filter: {
          type: 'leaf',
          field: 'lifetime_value',
          op: 'greater_than',
          value: 100,
          fieldType: 'number',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{
        joins?: Array<{ table: string }>;
        filters?: Array<{ column: string }>;
      }>;
    };
    expect(body.widgets[0].joins).toEqual([
      { table: 'customers', type: 'left', on: [['orders.customerId', 'customers.id']] },
    ]);
    expect(body.widgets[0].filters).toEqual([
      { column: 'customers.lifetime_value', operator: 'gt', value: 100 },
    ]);
  });

  // ── Many-to-many ───────────────────────────────────────────────────────────
  //
  // An M:N relationship is one-to-many from BOTH sides, so it has no JOIN form that preserves the
  // widget's rows at all — which is why `resolveField`'s direct-relationship loop skips it and why
  // such a filter used to be dropped as plain `unresolved`. A semi-join works at either arity.
  // The two shapes mirror `dataSourceGraph.findJoinPath`'s own arms exactly, so the in-memory and
  // wire paths agree on which relationships are reachable.
  describe('many-to-many', () => {
    /** customers <-> tags, through the `customer_tags` junction, all on one endpoint. */
    function makeManyToManyHarness(fetchFn: ReturnType<typeof makeOkFetch>) {
      const endpoint = uid();
      const sharedAdapter = createBatchingAdapter(endpoint, {
        fetchFn: fetchFn as unknown as typeof fetch,
        batchDelayMs: 0,
      });
      const dataSources: Record<string, StudioDataSource> = {
        'source-customers': {
          id: 'source-customers',
          label: 'Customers',
          tableName: 'customers',
          fields: [field('id', 'number'), field('lifetime_value', 'number')],
          adapter: sharedAdapter,
        },
        'source-tags': {
          id: 'source-tags',
          label: 'Tags',
          tableName: 'tags',
          fields: [field('tagId', 'number'), field('name')],
          adapter: sharedAdapter,
        },
        'source-customer-tags': {
          id: 'source-customer-tags',
          label: 'Customer tags',
          tableName: 'customer_tags',
          fields: [field('cId', 'number'), field('tId', 'number'), field('assignedBy')],
          adapter: sharedAdapter,
        },
      };
      const relationships: StudioRelationship[] = [
        {
          id: 'rel-customers-tags',
          type: 'many-to-many',
          sourceId: 'source-customers',
          sourceField: 'id',
          targetId: 'source-tags',
          targetField: 'tagId',
          junctionSourceId: 'source-customer-tags',
          junctionSourceField: 'cId',
          junctionTargetField: 'tId',
        },
      ];
      return createBatchingAdapter(endpoint, {
        fetchFn: fetchFn as unknown as typeof fetch,
        batchDelayMs: 0,
        dataSources,
        relationships,
      });
    }

    it('emits a NESTED semi-join for a filter on the remote endpoint (two hops via the junction)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
      const adapter = makeManyToManyHarness(fetchFn);

      await adapter.getRows(
        makeDescriptor({
          sourceId: 'source-customers',
          tableName: 'customers',
          widgetId: 'w1',
          select: ['lifetime_value'],
          filter: { type: 'leaf', field: 'name', op: 'equals', value: 'vip', fieldType: 'string' },
        }),
      );

      const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
        widgets: Array<{ joins?: unknown; filters?: unknown; semiJoins?: unknown }>;
      };
      expect(body.widgets[0].semiJoins).toEqual([
        {
          table: 'customer_tags',
          column: 'customers.id',
          foreignColumn: 'customer_tags.cId',
          // The junction level links the two tables and carries no predicate of its own.
          filters: [],
          semiJoins: [
            {
              table: 'tags',
              column: 'customer_tags.tId',
              foreignColumn: 'tags.tagId',
              filters: [{ column: 'tags.name', operator: 'eq', value: 'vip' }],
            },
          ],
        },
      ]);
      expect(body.widgets[0].joins).toBeUndefined();
      expect(body.widgets[0].filters).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('emits a ONE-hop semi-join for a filter on the JUNCTION source itself', async () => {
      const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
      const adapter = makeManyToManyHarness(fetchFn);

      await adapter.getRows(
        makeDescriptor({
          sourceId: 'source-customers',
          tableName: 'customers',
          widgetId: 'w1',
          select: ['lifetime_value'],
          filter: {
            type: 'leaf',
            field: 'assignedBy',
            op: 'equals',
            value: 'admin',
            fieldType: 'string',
          },
        }),
      );

      const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
        widgets: Array<{ semiJoins?: unknown }>;
      };
      // A junction table is never a relationship's own sourceId/targetId, only its
      // `junctionSourceId`, so this is the arm `findJoinPath` resolves as `hops: 1`.
      expect(body.widgets[0].semiJoins).toEqual([
        {
          table: 'customer_tags',
          column: 'customers.id',
          foreignColumn: 'customer_tags.cId',
          filters: [{ column: 'customer_tags.assignedBy', operator: 'eq', value: 'admin' }],
        },
      ]);
    });

    it('groups two predicates on the remote endpoint into ONE nested subquery', async () => {
      const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
      const adapter = makeManyToManyHarness(fetchFn);

      await adapter.getRows(
        makeDescriptor({
          sourceId: 'source-customers',
          tableName: 'customers',
          widgetId: 'w1',
          select: ['lifetime_value'],
          filter: {
            type: 'group',
            op: 'and',
            children: [
              { type: 'leaf', field: 'name', op: 'equals', value: 'vip', fieldType: 'string' },
              {
                type: 'leaf',
                field: 'tagId',
                op: 'greater_than',
                value: 5,
                fieldType: 'number',
              },
            ],
          },
        }),
      );

      const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
        widgets: Array<{ semiJoins?: Array<{ semiJoins?: Array<{ filters: unknown[] }> }> }>;
      };
      expect(body.widgets[0].semiJoins).toHaveLength(1);
      // Both predicates land on the INNERMOST level — the subquery against the source they
      // actually filter — so this is `EXISTS(tag matching A AND B)`, not two independent EXISTS.
      expect(body.widgets[0].semiJoins![0].semiJoins).toHaveLength(1);
      expect(body.widgets[0].semiJoins![0].semiJoins![0].filters).toEqual([
        { column: 'tags.name', operator: 'eq', value: 'vip' },
        { column: 'tags.tagId', operator: 'gt', value: 5 },
      ]);
    });

    it('does NOT push down a many-to-many reference that spans adapter endpoints', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
      const endpointA = uid();
      const endpointB = uid();
      const adapterA = createBatchingAdapter(endpointA, {
        fetchFn: fetchFn as unknown as typeof fetch,
        batchDelayMs: 0,
      });
      const adapterB = createBatchingAdapter(endpointB, {
        fetchFn: fetchFn as unknown as typeof fetch,
        batchDelayMs: 0,
      });
      const dataSources: Record<string, StudioDataSource> = {
        'source-customers': {
          id: 'source-customers',
          label: 'Customers',
          tableName: 'customers',
          fields: [field('id', 'number'), field('lifetime_value', 'number')],
          adapter: adapterA,
        },
        'source-tags': {
          id: 'source-tags',
          label: 'Tags',
          tableName: 'tags',
          fields: [field('tagId', 'number'), field('name')],
          // A different database — a subquery cannot span one any more than a JOIN can.
          adapter: adapterB,
        },
        'source-customer-tags': {
          id: 'source-customer-tags',
          label: 'Customer tags',
          tableName: 'customer_tags',
          fields: [field('cId', 'number'), field('tId', 'number')],
          adapter: adapterA,
        },
      };
      const relationships: StudioRelationship[] = [
        {
          id: 'rel-customers-tags',
          type: 'many-to-many',
          sourceId: 'source-customers',
          sourceField: 'id',
          targetId: 'source-tags',
          targetField: 'tagId',
          junctionSourceId: 'source-customer-tags',
          junctionSourceField: 'cId',
          junctionTargetField: 'tId',
        },
      ];
      const adapter = createBatchingAdapter(endpointA, {
        fetchFn: fetchFn as unknown as typeof fetch,
        batchDelayMs: 0,
        dataSources,
        relationships,
      });

      await adapter.getRows(
        makeDescriptor({
          sourceId: 'source-customers',
          tableName: 'customers',
          widgetId: 'w1',
          select: ['lifetime_value'],
          filter: { type: 'leaf', field: 'name', op: 'equals', value: 'vip', fieldType: 'string' },
        }),
      );

      const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
        widgets: Array<{ semiJoins?: unknown; filters?: unknown }>;
      };
      expect(body.widgets[0].semiJoins).toBeUndefined();
      expect(body.widgets[0].filters).toBeUndefined();
      // The visible-degradation path is kept for what stays genuinely unexpressible.
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
