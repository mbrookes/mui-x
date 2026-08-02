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
/*
 * `import/no-relative-packages` is disabled deliberately and ONLY for the batch-cap
 * mirror below. `MAX_BATCH_WIDGETS_PER_REQUEST` is a hand-kept copy of the server
 * package's `MAX_WIDGETS_PER_BATCH`, and this package must NOT depend on that package
 * (Node-only, Knex-peered) — so the only way to compare the two values is a relative
 * source import confined to a test, exactly as the mirroring assertion in
 * `x-studio-data-middleware/src/__tests__/clientWireSeam.test.ts` does in the other
 * direction. `shared/limits.ts` is the dependency-free module both server constants are
 * sourced from, so importing it pulls in no server runtime.
 */
/* eslint-disable-next-line import/no-relative-packages */
import { MAX_ITEMS_PER_BATCH } from '../../../x-studio-data-middleware/src/shared/limits';
import { createBatchingAdapter, MAX_BATCH_WIDGETS_PER_REQUEST } from './createBatchingAdapter';
import { applyFilters } from '../internals/filterUtils';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioExpressionField,
  StudioRelationship,
} from '../models';

// ── The mirrored batch cap ───────────────────────────────────────────────────
//
// `MAX_BATCH_WIDGETS_PER_REQUEST` (this package) and `MAX_WIDGETS_PER_BATCH`
// (`@mui/x-studio-data-middleware`, sourced from its `shared/limits.ts`
// `MAX_ITEMS_PER_BATCH`) are separate copies of ONE protocol constant, because
// x-studio must not depend on the Node-only server package. Nothing in the type
// system or the build connects them; assertions like this one are the entire
// mechanism.
//
// It is asserted from BOTH suites on purpose. The server package already had the
// mirror in `clientWireSeam.test.ts`, but a change made to THIS file and validated
// with `--project "x-studio"` never ran it — drift would ship green. Chunking that
// silently exceeds the server's cap does not degrade: `handleBatchQuery` rejects an
// over-cap request before its per-widget loop, so every widget on the page fails with
// one un-attributed transport error.

describe('createBatchingAdapter — batch cap', () => {
  it("mirrors the server's batch cap", () => {
    expect(
      MAX_BATCH_WIDGETS_PER_REQUEST,
      'MAX_BATCH_WIDGETS_PER_REQUEST (x-studio/src/server/createBatchingAdapter.ts) must equal ' +
        'MAX_WIDGETS_PER_BATCH (x-studio-data-middleware, from shared/limits.ts ' +
        'MAX_ITEMS_PER_BATCH). They are hand-kept copies — update BOTH, or the client chunks ' +
        'batches the server rejects outright.',
    ).toBe(MAX_ITEMS_PER_BATCH);
  });
});

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

function field(id: string, type: 'string' | 'number' | 'date' = 'string') {
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

  // The COLLISION half of the merge rule, which the test above cannot reach: source B there
  // registers no `expressionFields` at all, so `mergeExpressionFields` returns on its
  // `incoming.length === 0` early-out and the two-map merge below it never runs. Swap the
  // merge order — make the EXISTING definition win a collision — and that test stays green.
  //
  // The docblock states the requirement the other way round: "On an id collision the incoming
  // (newer) definition wins, so edits to an existing calculated field still refresh correctly
  // (finding 3.6)." A regression pins a shared endpoint to the FIRST-registered definition of
  // a calculated column, so editing it never takes effect until a reload.
  //
  // `sourceId` is the observable part of a definition here: simple mode never puts an
  // expression on the wire, it only uses the list to RECOGNISE an id as an own-source
  // calculated column (`ef.id === fieldId && ef.sourceId === d.sourceId`). So a definition
  // re-registered against a different source is the edit this path can actually see.
  it('lets the INCOMING definition win an expression-field id collision', async () => {
    const endpoint = uid();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const margin = (sourceId: string) => ({
      id: 'expr-margin',
      label: 'Margin',
      sourceId,
      isMeasure: false,
      expression: { operator: 'subtract' as const, inputs: [{ id: 'price' }, { id: 'cost' }] },
    });

    // The stale definition registers first…
    createBatchingAdapter(endpoint, {
      fetchFn: makeOkFetch([{ id: 'w1', rows: [] }]) as unknown as typeof fetch,
      batchDelayMs: 0,
      expressionFields: [margin('source-stale')],
    });
    // …and is then EDITED: same id, re-registered against the source it now belongs to.
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const edited = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
      expressionFields: [margin('source-orders')],
    });

    await edited.getRows(
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

    // The edit took effect: `expr-margin` is recognised as source-orders' own calculated
    // column, so the predicate is dropped rather than sent as a real `WHERE expr-margin > 100`
    // that the server has no column for. If the existing definition had won, its `sourceId`
    // would still be `source-stale`, the id would go unrecognised, and the predicate would
    // land on the wire.
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: unknown }>;
    };
    expect(body.widgets[0].filters).toBeUndefined();
    warnSpy.mockRestore();
  });

  // Simple mode states ONE rule about own-source calculated columns in two guards: such a
  // field "must not [be sent] in a WHERE (server predicate) or a SELECT (client-residual
  // projection): either fails the batch entry with 'no such column'". The predicate half is
  // pinned by the two tests above. The PROJECTION half — `tryProjectField` refusing to push
  // the id into `columns` — is not reached by either, because a `greater_than` leaf is
  // server-translatable and never becomes a client residual at all.
  //
  // `contains` is not in `OPERATOR_MAP`, so the leaf routes to the client residual and
  // `tryProjectField` is actually called. Without the guard the calculated id lands in the
  // SELECT list and the whole batch entry fails server-side.
  it('keeps an own-source calculated column out of the SELECT list when its filter falls to the client residual', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
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

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        widgetId: 'w1',
        select: ['id', 'price', 'cost'],
        filter: {
          type: 'leaf',
          field: 'expr-margin',
          op: 'contains',
          value: 'x',
          fieldType: 'string',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ columns: string[] }>;
    };
    // The whole point: the server has no such column, so asking for it fails the entry.
    expect(body.widgets[0].columns).not.toContain('expr-margin');
    // …and the real columns are still requested, so this is a guard and not a wipe.
    expect(body.widgets[0].columns).toEqual(expect.arrayContaining(['id', 'price', 'cost']));
    // Dropped LOUDLY — "never silently (finding 2.6)" is the other half of the sentence.
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

  // The test above exercises `!response.ok`, which `runBatchGroup` handles by RETURNING a
  // per-descriptor `Error` — it never reaches the `catch` in the dispatch. That `catch` is
  // only entered when `groupFetch` ITSELF rejects (DNS failure, socket hang up, an aborted
  // request), and no test in this file had a rejecting fetch anywhere: `makeErrorFetch`
  // resolves to a 503 *response*. So the isolation the `catch` exists for was stated in a
  // comment, demonstrated by a test that takes a different path, and checked by nothing.
  //
  // Without the `catch`, the rejection escapes `Promise.all(chunks.map(…))` and rejects the
  // whole dispatch — `createLoader`'s reject-every-caller path — so one tenant's network
  // error fails a DIFFERENT tenant's widgets on the same endpoint.
  it("one group's REJECTING fetch does not fail another group's requests", async () => {
    const endpoint = uid();
    const rejectingFetch = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const okFetch = makeOkFetch([{ id: 'wOk', rows: [{ id: 1 }] }]);

    const rejectingAdapter = createBatchingAdapter(endpoint, {
      fetchFn: rejectingFetch as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    const okAdapter = createBatchingAdapter(endpoint, {
      fetchFn: okFetch as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    const results = await Promise.allSettled([
      rejectingAdapter.getRows(makeDescriptor({ widgetId: 'wFail', cacheKey: 'kF' })),
      okAdapter.getRows(makeDescriptor({ widgetId: 'wOk', cacheKey: 'kO' })),
    ]);

    // The failing chunk still fails, and with the transport's own message rather than
    // something generic — the `catch` converts a rejection to per-descriptor errors, it
    // does not swallow one.
    expect(results[0].status).toBe('rejected');
    expect(String((results[0] as PromiseRejectedResult).reason)).toContain('socket hang up');
    // …and the healthy fetch's caller is untouched.
    expect(results[1].status).toBe('fulfilled');
    expect((results[1] as PromiseFulfilledResult<{ rows: unknown[] }>).value.rows).toHaveLength(1);
  });
});

// ── The chunking the batch cap exists for ────────────────────────────────────
//
// `MAX_BATCH_WIDGETS_PER_REQUEST`'s VALUE is pinned by two tests, one in each package. The
// chunking loop the constant exists for was executed by neither, nor by anything else: no
// test in this file issued more than a handful of descriptors, so a group never exceeded
// the cap and the loop never split anything. A constant with a test and no exercise —
// delete the loop, keep the number, and both mirror tests stay green while every over-cap
// page breaks.
//
// The mirror test's own failure message names the behaviour: "update BOTH, or the client
// chunks batches the server rejects outright". This is that behaviour.

describe('createBatchingAdapter — over-cap chunking', () => {
  /** A fetch that answers whatever widget ids the body actually asked for. */
  function makeEchoFetch() {
    return vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { widgets: { id: string }[] };
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            results: body.widgets.map((widget) => ({ id: widget.id, rows: [{ id: widget.id }] })),
          }),
      });
    });
  }

  it('splits a group past the cap into several POSTs, none over the cap', async () => {
    const fetchFn = makeEchoFetch();
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    // One past the cap: the smallest page the server would reject outright.
    const overCap = MAX_BATCH_WIDGETS_PER_REQUEST + 1;
    const rows = await Promise.all(
      Array.from({ length: overCap }, (_unused, i) =>
        adapter.getRows(makeDescriptor({ widgetId: `w${i}`, cacheKey: `k${i}` })),
      ),
    );

    const widgetsPerPost = fetchFn.mock.calls.map(
      ([, init]) =>
        (JSON.parse((init as RequestInit).body as string) as { widgets: unknown[] }).widgets.length,
    );
    // Two POSTs, not one — and the split is AT the cap, not somewhere near it.
    expect(widgetsPerPost).toEqual([MAX_BATCH_WIDGETS_PER_REQUEST, 1]);
    // The property that actually matters, stated independently of the arithmetic above:
    // no request the server would throw on.
    expect(Math.max(...widgetsPerPost)).toBeLessThanOrEqual(MAX_BATCH_WIDGETS_PER_REQUEST);

    // Chunking must be invisible to the caller: every descriptor still gets ITS rows,
    // across the split. Without this a mis-routing chunker would pass the counts above.
    expect(rows).toHaveLength(overCap);
    expect(rows.map((result) => (result.rows[0] as { id: string }).id)).toEqual(
      Array.from({ length: overCap }, (_unused, i) => expect.stringContaining(`w${i}::`)),
    );
  });

  it('leaves a group at exactly the cap as ONE POST', async () => {
    const fetchFn = makeEchoFetch();
    const adapter = createBatchingAdapter(uid(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });

    await Promise.all(
      Array.from({ length: MAX_BATCH_WIDGETS_PER_REQUEST }, (_unused, i) =>
        adapter.getRows(makeDescriptor({ widgetId: `w${i}`, cacheKey: `k${i}` })),
      ),
    );

    // The other direction, without which "chunk everything into ones" would pass the test
    // above: the cap is a ceiling, not a page size.
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

  it('pushes count_non_null down as the wire `count`, which IS SQL COUNT(column)', async () => {
    // `count_non_null` is the ONE count with a faithful wire form: the middleware's `count`
    // emits `COUNT(column)`, which is exactly "how many rows had a value". It must therefore
    // survive the push-down ladder and arrive spelled `count`. The counterpart — Studio's own
    // `count` (`COUNT(*)`) being stripped to raw rows — is pinned by 'routes a plain count to
    // raw rows' below. Together they are why the rename happens at the LAST moment: renaming
    // `count_non_null` to `count` any earlier makes the two indistinguishable, and the ladder
    // would strip this one too.
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
        aggregations: [{ field: 'total', fn: 'count_non_null', alias: 'total' }],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ aggregations?: Array<{ func: string }> }>;
    };
    expect(body.widgets[0].aggregations).toEqual([
      { column: 'total', func: 'count', alias: 'total' },
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
        fields: [
          field('id', 'number'),
          field('customerId', 'number'),
          field('status'),
          // A date field, so a leaf that `toPredicatesFor` expands into TWO predicates (a
          // day-granular `eq` becomes `gte day AND lt nextDay`) is reachable from this
          // harness — see "keeps the per-predicate attribution INDEX-ALIGNED" below.
          field('created', 'date'),
        ],
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
          // The attribution the Filters Drawer stamps on a cross-source leaf
          // (`WidgetFilterRow`'s `isNowCrossSource ? option.sourceId : undefined`). It is what
          // makes this the representation `resolveRows` also answers with a semi-join — hence
          // the "no divergence warning" assertion below. Without it the same wire plan answers
          // a different question than memory does, which the adapter now announces (see
          // `clientWireSeam.test.ts`).
          filterSourceId: 'source-orders',
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

  /**
   * Every `console.warn` one `customers` widget's build emits for `filter`, joined.
   *
   * The tests below pin the POSITIVE direction of `semiJoinUnattributedDivergenceWarning` — that
   * an unattributed cross-source leaf DOES warn — in x-studio's own suite. The five fixtures in
   * this describe now carry the attribution the Filters Drawer stamps, so between them they pin
   * only the absence of a SPURIOUS warning; deleting the whole `else if` branch left all 82 tests
   * of this file green and failed only in `x-studio-data-middleware`'s `clientWireSeam.test.ts`.
   * That is exactly the cross-project blind spot the batch-cap note at the top of this file
   * describes: a change made HERE and validated with `--project "x-studio"` never runs that suite.
   */
  async function warningsForCustomersFilter(
    filter: StudioQueryDescriptor['filter'],
  ): Promise<string> {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = makeOneSideHarness(fetchFn);

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-customers',
        tableName: 'customers',
        widgetId: 'w1',
        select: ['lifetime_value'],
        filter,
      }),
    );

    const warnings = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    warnSpy.mockRestore();
    return warnings;
  }

  /** `status` lives ONLY on `source-orders`, the "many" side. */
  const statusLeaf = (filterSourceId?: string) =>
    ({
      type: 'leaf',
      field: 'status',
      op: 'equals',
      value: 'shipped',
      fieldType: 'string',
      ...(filterSourceId === undefined ? {} : { filterSourceId }),
    }) as NonNullable<StudioQueryDescriptor['filter']>;

  it('WARNS when a cross-source leaf carries no source attribution', async () => {
    // `resolveRows` sends this leaf to `nativeFilters`, comparing `status` against the widget's
    // own `customers` rows where it is `undefined` — memory keeps nothing, the wire's `EXISTS`
    // keeps the matching customers. Same document, two answers.
    expect(await warningsForCustomersFilter(statusLeaf())).toContain('no source attribution');
  });

  it("WARNS for the `filterSourceId: ''` shape `add_page_filter` writes", async () => {
    // `x-studio-ai-middleware`'s `add_page_filter` stores `asString(args.sourceId ?? '')` when the
    // model omits the argument. `''` is falsy, so `resolveRows`' `f.filterSourceId &&` test treats
    // it exactly like absent — and it names no real source here either.
    expect(await warningsForCustomersFilter(statusLeaf(''))).toContain('no source attribution');
  });

  it("WARNS when the attribution names the widget's OWN source", async () => {
    // The other half of `resolveRows`' `f.filterSourceId && f.filterSourceId !== widgetSourceId`
    // test: a set-but-self attribution takes `nativeFilters` too, which a bare absence check
    // would miss.
    expect(await warningsForCustomersFilter(statusLeaf('source-customers'))).toContain(
      'no source attribution',
    );
  });

  it('WARNS for an unattributed leaf even when a SIBLING leaf on the SAME field is attributed', async () => {
    // The divergence is decided per LEAF, so it must be detected per leaf. Collecting the
    // attributions into a per-FIELD set and asking whether the semi-join's source appears
    // anywhere in it lets the attributed leaf whitelist the unattributed one, and the pair goes
    // out silently — `wire=1 memory=0`, the exact thing this warning exists to announce.
    //
    // Not hypothetical: `add_page_filter` stores `''` on a page filter while `WidgetFilterRow`
    // stamps the real source id on a widget filter for the same field, and
    // `selectFiltersForWidget` → `filtersToFilterNode` puts page and widget filters in ONE AND
    // group.
    const warnings = await warningsForCustomersFilter({
      type: 'group',
      logic: 'and',
      children: [statusLeaf('source-orders'), statusLeaf()],
    } as NonNullable<StudioQueryDescriptor['filter']>);

    expect(warnings).toContain('no source attribution');
  });

  /**
   * `predicateSourceIds` is INDEX-ALIGNED with `predicates`, and that alignment is what makes
   * the per-leaf attribution check ask about the right leaf. It is load-bearing and was
   * entirely uncovered: replacing `partitionFilterNode`'s
   *
   *     for (let i = 0; i < emitted.length; i += 1) { result.predicateSourceIds.push(…); }
   *
   * with a single push per LEAF left all 86 tests of this file green and all 31 of
   * `x-studio-data-middleware`'s `clientWireSeam.test.ts` green too — because no fixture in
   * either suite combined a MULTI-predicate leaf with the attribution check. Every attribution
   * fixture above emits exactly one predicate per leaf, which is precisely the case where the
   * two spellings coincide.
   *
   * The desync is not benign. With one entry per leaf, the attribution array is SHORTER than
   * the predicate array from the first multi-predicate leaf onward, so every later predicate
   * reads its neighbour's attribution: the unattributed leaf reads an attributed one and goes
   * out silently — `wire=1 memory=0`, the exact failure this check exists to remove — while an
   * attributed leaf reads past the end and warns about a filter that is perfectly correct.
   *
   * Both expansions the docblock names are covered: a day-granular date `eq`, and an `op2`
   * second condition.
   */
  it('keeps the per-predicate attribution INDEX-ALIGNED across a leaf that emits TWO predicates', async () => {
    const warnings = await warningsForCustomersFilter({
      type: 'group',
      logic: 'and',
      children: [
        // A: attributed, and `toPredicatesFor` expands a day-granular date `eq` into
        // `gte 2024-01-01 AND lt 2024-01-02` — TWO predicates from ONE leaf.
        {
          type: 'leaf',
          field: 'created',
          op: 'equals',
          value: '2024-01-01',
          fieldType: 'date',
          filterSourceId: 'source-orders',
        },
        // B: UNATTRIBUTED — the leaf that actually diverges, and the one that must be named.
        statusLeaf(),
        // C: attributed, one predicate. Reads past the end of a short attribution array.
        {
          type: 'leaf',
          field: 'created',
          op: 'equals',
          value: '2024-02-02',
          fieldType: 'date',
          filterSourceId: 'source-orders',
        },
      ],
    } as NonNullable<StudioQueryDescriptor['filter']>);

    // The unattributed leaf is named…
    expect(warnings).toContain('The filter on "status"');
    // …and the attributed ones are NOT: a warning about `created` here would mean the check
    // consulted the wrong leaf, which is the same defect wearing the opposite sign.
    expect(warnings).not.toContain('The filter on "created"');
  });

  it('keeps the alignment across an `op2` second condition too', async () => {
    const warnings = await warningsForCustomersFilter({
      type: 'group',
      logic: 'and',
      children: [
        // Attributed, TWO predicates: `customerId > 10 AND customerId < 100`.
        {
          type: 'leaf',
          field: 'customerId',
          op: 'greater_than',
          value: 10,
          op2: 'less_than',
          value2: 100,
          fieldType: 'number',
          filterSourceId: 'source-orders',
        },
        statusLeaf(),
      ],
    } as NonNullable<StudioQueryDescriptor['filter']>);

    expect(warnings).toContain('The filter on "status"');
    expect(warnings).not.toContain('The filter on "customerId"');
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
          logic: 'and',
          children: [
            {
              type: 'leaf',
              field: 'status',
              op: 'equals',
              value: 'shipped',
              fieldType: 'string',
              filterSourceId: 'source-orders',
            },
            // `customerId` exists ONLY on `orders` — a field name shared with the widget's own
            // source (like `id`) would resolve to the primary table instead.
            {
              type: 'leaf',
              field: 'customerId',
              op: 'greater_than',
              value: 10,
              fieldType: 'number',
              filterSourceId: 'source-orders',
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

  // ── JOIN `on` orientation ──────────────────────────────────────────────────
  //
  // The wire protocol does NOT accept an `on` pair written in relationship-field order.
  // `x-studio-data-middleware`'s `validateJoinOnPairs` requires the RIGHT side of every
  // pair to name `join.table` (the table THIS join introduces) and the LEFT side a table
  // already in scope, because a right-hand column naming an unrelated table is either a
  // wrongly-ordered join or a tautology some engines execute as a cartesian product.
  //
  // Every branch that resolves a field across a relationship the widget sits at the TARGET
  // of has to invert the relationship's own field order to satisfy that. Only the branches
  // where the widget is the relationship's SOURCE were ever asserted here, so the three
  // TARGET-side branches shipped swapped and hard-failed the whole widget server-side.
  // `x-studio-data-middleware/src/__tests__/clientWireSeam.test.ts` runs the same shapes
  // through the real validator; these keep the client package self-checking.
  describe('join `on` orientation (widget on the relationship TARGET side)', () => {
    /** `profiles --one-to-one--> customers`, so a customers widget is the TARGET. */
    function makeTargetSideHarness(fetchFn: ReturnType<typeof makeOkFetch>) {
      const endpoint = uid();
      const dataSources: Record<string, StudioDataSource> = {
        'source-customers': {
          id: 'source-customers',
          label: 'Customers',
          tableName: 'customers',
          fields: [field('id', 'number'), field('lifetime_value', 'number')],
        },
        'source-profiles': {
          id: 'source-profiles',
          label: 'Profiles',
          tableName: 'profiles',
          fields: [field('profileId'), field('customerId', 'number'), field('tier')],
        },
      };
      const relationships: StudioRelationship[] = [
        {
          id: 'rel-profiles-customers',
          type: 'one-to-one',
          sourceId: 'source-profiles',
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
        expressionFields: [
          {
            id: 'expr-tier',
            sourceId: 'source-customers',
            label: 'Tier',
            type: 'string',
            expression: { joinSourceId: 'source-profiles', fieldId: 'tier' },
          } as unknown as StudioExpressionField,
        ],
      });
    }

    async function joinsFor(select: string[]) {
      const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
      await makeTargetSideHarness(fetchFn).getRows(
        makeDescriptor({
          sourceId: 'source-customers',
          tableName: 'customers',
          widgetId: 'w1',
          select,
        }),
      );
      const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
        widgets: Array<{ joins?: Array<{ table: string; on: [string, string][] }> }>;
      };
      return body.widgets[0].joins;
    }

    it('inverts the pair for a plain cross-source field', async () => {
      expect(await joinsFor(['id', 'tier'])).toEqual([
        { table: 'profiles', type: 'left', on: [['customers.id', 'profiles.customerId']] },
      ]);
    });

    it('inverts the pair for an expression join field', async () => {
      expect(await joinsFor(['id', 'expr-tier'])).toEqual([
        { table: 'profiles', type: 'left', on: [['customers.id', 'profiles.customerId']] },
      ]);
    });
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
          filter: {
            type: 'leaf',
            field: 'name',
            op: 'equals',
            value: 'vip',
            fieldType: 'string',
            filterSourceId: 'source-tags',
          },
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
            filterSourceId: 'source-customer-tags',
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
            logic: 'and',
            children: [
              {
                type: 'leaf',
                field: 'name',
                op: 'equals',
                value: 'vip',
                fieldType: 'string',
                filterSourceId: 'source-tags',
              },
              {
                type: 'leaf',
                field: 'tagId',
                op: 'greater_than',
                value: 5,
                fieldType: 'number',
                filterSourceId: 'source-tags',
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

// ── prototype-chain-safe `columnAliases` reads ───────────────────────────────

describe('createBatchingAdapter — field ids that name Object.prototype members', () => {
  /**
   * `columnAliases` is a plain `{}`, so `columnAliases[fieldId]` walks the prototype chain: a
   * doc-authored field id of `constructor`, `toString`, `valueOf` or `hasOwnProperty` resolves
   * an inherited FUNCTION, which is truthy — so neither `?.` nor `?? fallback` catches it and
   * the function flows into the emitted descriptor. `JSON.stringify` then drops it silently
   * (functions are not JSON), which is what makes this invisible rather than loud.
   *
   * Field ids are strings the user types into the data-source config (and that the AI's
   * `add_expression_field` tool writes), so these are ordinary values, not attacks; the reads
   * go through `utils/safeLookup`'s `lookup` for exactly that reason.
   */
  function makeProtoFieldHarness(fetchFn: ReturnType<typeof makeOkFetch>) {
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
        fields: [
          field('id', 'number'),
          field('customerId', 'number'),
          // Every id here names an `Object.prototype` member.
          field('constructor'),
          field('toString'),
        ],
        adapter: sharedAdapter,
      },
      'source-customers': {
        id: 'source-customers',
        label: 'Customers',
        tableName: 'customers',
        fields: [field('id', 'number')],
        adapter: sharedAdapter,
      },
    };
    // Relationship-aware mode: `columnAliases` only exists on this path.
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

  it('emits a WHERE predicate that still has a column for a field id of "constructor"', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = makeProtoFieldHarness(fetchFn);

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['id'],
        filter: {
          type: 'leaf',
          field: 'constructor',
          op: 'equals',
          value: 'shipped',
          fieldType: 'string',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ filters?: Array<Record<string, unknown>> }>;
    };
    // With a bare `columnAliases[r.column] ?? r.column`, `physicalColumn` is the inherited
    // `Object` constructor and `JSON.stringify` omits the key outright — the server receives
    // `{"operator":"eq","value":"shipped"}`, a predicate with NO column, and the widget's
    // filter is either rejected or silently ignored.
    expect(body.widgets[0].filters).toEqual([
      { column: 'constructor', operator: 'eq', value: 'shipped' },
    ]);
  });

  it('keeps the ORDER BY column for a groupBy field id of "toString"', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = makeProtoFieldHarness(fetchFn);

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['toString', 'id'],
        groupBy: 'toString',
        aggregations: [{ field: 'id', fn: 'sum', alias: 'id' }],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ orderBy?: Array<Record<string, unknown>> }>;
    };
    // Same read, same failure mode: an `ORDER BY` entry that serializes to `{"direction":"asc"}`.
    expect(body.widgets[0].orderBy).toEqual([{ column: 'toString', direction: 'asc' }]);
  });

  it('does not treat an unaliased field id as an alias needing a charset check', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = makeProtoFieldHarness(fetchFn);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-orders',
        tableName: 'orders',
        widgetId: 'w1',
        select: ['constructor', 'id'],
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ columns?: string[]; columnAliases?: unknown }>;
    };
    // `constructor` has no alias entry at all, so the output-alias charset guard must not
    // consider it one. (Inert with the bare read too — every `Object.prototype` member happens
    // to pass `SAFE_WIRE_ALIAS` — which is exactly why this read needed converting BEFORE some
    // future id, or a tighter charset, made it not inert.)
    expect(body.widgets[0].columns).toEqual(['constructor', 'id']);
    expect(body.widgets[0].columnAliases).toBeUndefined();
    warnSpy.mockRestore();
  });
});

// ── The TWO-HOP expression chain (section 1b of `resolveField`) ───────────────
//
// `resolveField` resolves an expression field defined on a RELATED source by chaining two
// hops: PRIMARY → the expression field's own source → the expression's join target. Every
// guard on the ONE-hop path had a test and the identical guard on the TWO-hop path had none:
// both `hop1FansOut`/`hop2FansOut` flags, both halves of the `hop1FansOut || hop2FansOut`
// orientation guard that reads them, both hops' ON-pair orientations, and both
// `divergesFromInMemory` announcements could each be switched off with the whole project
// green. The failure mode is not a server rejection but a SILENTLY inflated aggregate — a
// `SUM` reading 3x — which is exactly what the guard was introduced to stop.
describe('createBatchingAdapter — two-hop expression chain', () => {
  /**
   * Builds a 3-source chain on ONE endpoint and returns an adapter for the widget's
   * (primary) source. `expressionFields` always defines the expression field on the MIDDLE
   * source, never on the primary — that is what routes resolution into section 1b.
   */
  function makeChainHarness(
    fetchFn: ReturnType<typeof makeOkFetch>,
    options: {
      relationships: StudioRelationship[];
      expressionFields: StudioExpressionField[];
    },
  ) {
    const endpoint = uid();
    const sharedAdapter = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    const dataSources: Record<string, StudioDataSource> = {
      'source-order-items': {
        id: 'source-order-items',
        label: 'Order items',
        tableName: 'order_items',
        fields: [field('lineId', 'number'), field('orderId', 'number'), field('qty', 'number')],
        adapter: sharedAdapter,
      },
      'source-orders': {
        id: 'source-orders',
        label: 'Orders',
        tableName: 'orders',
        fields: [
          field('id', 'number'),
          field('customerId', 'number'),
          field('shipperId', 'number'),
          field('total', 'number'),
        ],
        adapter: sharedAdapter,
      },
      'source-customers': {
        id: 'source-customers',
        label: 'Customers',
        tableName: 'customers',
        fields: [field('id', 'number'), field('country'), field('lifetime_value', 'number')],
        adapter: sharedAdapter,
      },
      'source-returns': {
        id: 'source-returns',
        label: 'Returns',
        tableName: 'returns',
        fields: [field('returnId', 'number'), field('orderId', 'number'), field('reason')],
        adapter: sharedAdapter,
      },
      'source-shippers': {
        id: 'source-shippers',
        label: 'Shippers',
        tableName: 'shippers',
        fields: [field('id', 'number'), field('carrier')],
        adapter: sharedAdapter,
      },
    };
    return createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
      dataSources,
      relationships: options.relationships,
      expressionFields: options.expressionFields,
    });
  }

  function exprField(
    id: string,
    sourceId: string,
    joinSourceId: string,
    fieldId: string,
  ): StudioExpressionField {
    return {
      id,
      sourceId,
      label: id,
      type: 'string',
      expression: { joinSourceId, fieldId },
    } as unknown as StudioExpressionField;
  }

  /** `order_items --many-to-one--> orders`: the widget is on the MANY side, no fan-out. */
  const itemsToOrders: StudioRelationship = {
    id: 'rel-items-orders',
    type: 'many-to-one',
    sourceId: 'source-order-items',
    sourceField: 'orderId',
    targetId: 'source-orders',
    targetField: 'id',
  };
  /** `orders --many-to-one--> customers`: traversed forwards from orders, no fan-out. */
  const ordersToCustomers: StudioRelationship = {
    id: 'rel-orders-customers',
    type: 'many-to-one',
    sourceId: 'source-orders',
    sourceField: 'customerId',
    targetId: 'source-customers',
    targetField: 'id',
  };
  /** `orders --many-to-one--> shippers`: traversed forwards from orders, no fan-out. */
  const ordersToShippers: StudioRelationship = {
    id: 'rel-orders-shippers',
    type: 'many-to-one',
    sourceId: 'source-orders',
    sourceField: 'shipperId',
    targetId: 'source-shippers',
    targetField: 'id',
  };
  /**
   * `returns --many-to-one--> orders`. Reached from `orders` this is traversed BACKWARDS —
   * orders is the "one" side — so hop 2 fans out.
   */
  const returnsToOrders: StudioRelationship = {
    id: 'rel-returns-orders',
    type: 'many-to-one',
    sourceId: 'source-returns',
    sourceField: 'orderId',
    targetId: 'source-orders',
    targetField: 'id',
  };

  async function bodyFor(
    adapter: ReturnType<typeof createBatchingAdapter>,
    fetchFn: ReturnType<typeof makeOkFetch>,
    descriptor: Partial<StudioQueryDescriptor>,
  ) {
    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-order-items',
        tableName: 'order_items',
        widgetId: 'w1',
        select: ['lineId'],
        ...descriptor,
      }),
    );
    return JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{
        columns?: string[];
        joins?: Array<{ table: string; type: string; on: [string, string][] }>;
        filters?: unknown;
        semiJoins?: Array<{
          table: string;
          column: string;
          foreignColumn: string;
          filters: unknown[];
          semiJoins?: Array<{
            table: string;
            column: string;
            foreignColumn: string;
            filters: unknown[];
          }>;
        }>;
      }>;
    };
  }

  // ── The no-fan-out baseline: both hops forward ──────────────────────────────

  it('emits BOTH hops as LEFT JOINs, each ON pair oriented left-in-scope/right-introduced', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = makeChainHarness(fetchFn, {
      relationships: [itemsToOrders, ordersToCustomers],
      // Defined on `source-orders` — NOT on the widget's own source. Section 1's lookup is
      // scoped by `f.sourceId === primarySourceId` precisely so this falls through to the
      // two-hop section; dropping that scope makes section 1 claim the field and resolve a
      // join that does not exist, so this assertion pins the ownership check too.
      expressionFields: [
        exprField('expr-order-country', 'source-orders', 'source-customers', 'country'),
      ],
    });

    const body = await bodyFor(adapter, fetchFn, { select: ['lineId', 'expr-order-country'] });

    expect(body.widgets[0].joins).toEqual([
      { table: 'orders', type: 'left', on: [['order_items.orderId', 'orders.id']] },
      { table: 'customers', type: 'left', on: [['orders.customerId', 'customers.id']] },
    ]);
    // The logical id is kept as the column; the server aliases the physical column onto it.
    expect(body.widgets[0].columns).toContain('expr-order-country');
    expect(body.widgets[0].semiJoins).toBeUndefined();
  });

  it('resolves to no joins at all when hop 2 lands back on the primary source', async () => {
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const adapter = makeChainHarness(fetchFn, {
      relationships: [itemsToOrders, ordersToCustomers],
      // Defined on `orders`, joining back to the WIDGET's own source. The final physical
      // column already sits on the primary table, so the intermediate hop is pointless.
      expressionFields: [
        exprField('expr-back-to-items', 'source-orders', 'source-order-items', 'qty'),
      ],
    });

    const body = await bodyFor(adapter, fetchFn, { select: ['lineId', 'expr-back-to-items'] });

    expect(body.widgets[0].joins).toBeUndefined();
    expect(body.widgets[0].semiJoins).toBeUndefined();
    expect(body.widgets[0].columns).toContain('expr-back-to-items');
  });

  // ── The orientation guard: a fan-out at EITHER hop abandons the join form ───

  it('abandons the join form for a semi-join when a ONE-hop join expression fans out', async () => {
    // The single-hop sibling of the guard above, in section 1: an expression field defined on
    // the WIDGET's own source whose join target is the "many" side. Its plain-field twin (a
    // cross-source column) was pinned; this join-expression form was not.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    const endpoint = uid();
    const sharedAdapter = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    const adapter = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
      dataSources: {
        'source-customers': {
          id: 'source-customers',
          label: 'Customers',
          tableName: 'customers',
          fields: [field('id', 'number'), field('lifetime_value', 'number')],
          adapter: sharedAdapter,
        },
        'source-orders': {
          id: 'source-orders',
          label: 'Orders',
          tableName: 'orders',
          fields: [field('id', 'number'), field('customerId', 'number'), field('status')],
          adapter: sharedAdapter,
        },
      },
      relationships: [ordersToCustomers],
      // Defined on the widget's OWN source, so section 1 (not 1b) resolves it.
      expressionFields: [
        exprField('expr-cust-order-status', 'source-customers', 'source-orders', 'status'),
      ],
    });

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-customers',
        tableName: 'customers',
        widgetId: 'w1',
        select: ['lifetime_value'],
        aggregations: [{ field: 'lifetime_value', fn: 'sum', alias: 'lifetime_value' }],
        filter: {
          type: 'leaf',
          field: 'expr-cust-order-status',
          op: 'equals',
          value: 'shipped',
          fieldType: 'string',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ joins?: unknown; semiJoins?: unknown }>;
    };
    expect(body.widgets[0].joins).toBeUndefined();
    expect(body.widgets[0].semiJoins).toEqual([
      {
        table: 'orders',
        column: 'customers.id',
        foreignColumn: 'orders.customerId',
        filters: [{ column: 'orders.status', operator: 'eq', value: 'shipped' }],
      },
    ]);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'MANY rows per row of this source',
    );
    warnSpy.mockRestore();
  });

  it('abandons the join form for a NESTED semi-join when HOP 1 fans out', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    // Widget on `customers` (the "one" side of orders→customers), so hop 1 customers→orders
    // is a `many-to-one` traversed BACKWARDS: joining it multiplies the widget's rows.
    const endpoint = uid();
    const sharedAdapter = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
    });
    const adapter = createBatchingAdapter(endpoint, {
      fetchFn: fetchFn as unknown as typeof fetch,
      batchDelayMs: 0,
      dataSources: {
        'source-customers': {
          id: 'source-customers',
          label: 'Customers',
          tableName: 'customers',
          fields: [field('id', 'number'), field('lifetime_value', 'number')],
          adapter: sharedAdapter,
        },
        'source-orders': {
          id: 'source-orders',
          label: 'Orders',
          tableName: 'orders',
          fields: [field('id', 'number'), field('customerId', 'number'), field('shipperId', 'number')],
          adapter: sharedAdapter,
        },
        'source-shippers': {
          id: 'source-shippers',
          label: 'Shippers',
          tableName: 'shippers',
          fields: [field('id', 'number'), field('carrier')],
          adapter: sharedAdapter,
        },
      },
      relationships: [ordersToCustomers, ordersToShippers],
      expressionFields: [
        exprField('expr-order-carrier', 'source-orders', 'source-shippers', 'carrier'),
      ],
    });

    await adapter.getRows(
      makeDescriptor({
        sourceId: 'source-customers',
        tableName: 'customers',
        widgetId: 'w1',
        select: ['lifetime_value'],
        aggregations: [{ field: 'lifetime_value', fn: 'sum', alias: 'lifetime_value' }],
        filter: {
          type: 'leaf',
          field: 'expr-order-carrier',
          op: 'equals',
          value: 'DHL',
          fieldType: 'string',
        },
      }),
    );

    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string) as {
      widgets: Array<{ joins?: unknown; semiJoins?: unknown }>;
    };
    // A LEFT JOIN here would make a customer with three DHL orders contribute three rows and
    // the KPI's SUM read 3x. The nested semi-join filters the customer rows without
    // multiplying them.
    expect(body.widgets[0].joins).toBeUndefined();
    expect(body.widgets[0].semiJoins).toEqual([
      {
        table: 'orders',
        column: 'customers.id',
        foreignColumn: 'orders.customerId',
        filters: [],
        semiJoins: [
          {
            table: 'shippers',
            column: 'orders.shipperId',
            foreignColumn: 'shippers.id',
            filters: [{ column: 'shippers.carrier', operator: 'eq', value: 'DHL' }],
          },
        ],
      },
    ]);
    // `EXISTS` is not the answer in-memory evaluation gives (it compares against ONE
    // representative related row), so the divergence must be ANNOUNCED rather than silent.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'MANY rows per row of this source',
    );
    warnSpy.mockRestore();
  });

  it('abandons the join form for a NESTED semi-join when HOP 2 fans out', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = makeOkFetch([{ id: 'w1', rows: [] }]);
    // Hop 1 (order_items→orders) is forward and safe; hop 2 (orders→returns) is a
    // `many-to-one` traversed BACKWARDS, so the fan-out is on the SECOND hop only. This is
    // the half of `hop1FansOut || hop2FansOut` that a `hop1FansOut`-only guard would miss.
    const adapter = makeChainHarness(fetchFn, {
      relationships: [itemsToOrders, returnsToOrders],
      expressionFields: [
        exprField('expr-order-return-reason', 'source-orders', 'source-returns', 'reason'),
      ],
    });

    const body = await bodyFor(adapter, fetchFn, {
      aggregations: [{ field: 'qty', fn: 'sum', alias: 'qty' }],
      select: ['qty'],
      filter: {
        type: 'leaf',
        field: 'expr-order-return-reason',
        op: 'equals',
        value: 'damaged',
        fieldType: 'string',
      },
    });

    expect(body.widgets[0].joins).toBeUndefined();
    expect(body.widgets[0].semiJoins).toEqual([
      {
        table: 'orders',
        column: 'order_items.orderId',
        foreignColumn: 'orders.id',
        filters: [],
        semiJoins: [
          {
            table: 'returns',
            column: 'orders.id',
            foreignColumn: 'returns.orderId',
            filters: [{ column: 'returns.reason', operator: 'eq', value: 'damaged' }],
          },
        ],
      },
    ]);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'MANY rows per row of this source',
    );
    warnSpy.mockRestore();
  });
});
