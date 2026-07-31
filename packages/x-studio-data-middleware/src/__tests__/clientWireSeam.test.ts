/**
 * CROSS-PACKAGE SEAM — `@mui/x-studio`'s `createBatchingAdapter` ⇄ this package's
 * query-descriptor protocol.
 *
 * Every other test file in either package exercises exactly ONE side of the wire:
 * the client asserts the shape of the body it POSTs, the server asserts what it does
 * with a HAND-WRITTEN body. Nothing pinned that the body the client actually emits is
 * a body this server accepts — which is how four `joins[].on` pairs shipped with the
 * two sides swapped, and how the client came to emit no `limit` at all while the
 * server's budget-exhaustion error told operators to set one.
 *
 * The technique here closes that gap: build a descriptor with the client's own
 * `buildBatchWidgetDescriptor` (reached through the public `createBatchingAdapter`
 * with a stub `fetchFn` that captures the POST body), then feed THAT EXACT BODY to
 * the real `validateQueryPlan` / `handleBatchQuery`. No hand-written descriptors — a
 * body only a test author would write proves nothing about this seam.
 */
import { describe, it, expect, vi } from 'vitest';
/*
 * `import/no-relative-packages` is disabled deliberately and ONLY here. A seam test has to
 * load BOTH sides of the wire, but neither package may depend on the other: x-studio is
 * kept free of a server-package dependency (see the comment above `ClientMutationDescriptor`
 * in x-studio-schema), and this package is framework- and client-agnostic. A workspace
 * `devDependency` would make the two build graphs cross for every consumer; a relative
 * source import keeps the coupling confined to this one test file.
 */
/* eslint-disable import/no-relative-packages */
import {
  createBatchingAdapter,
  MAX_BATCH_WIDGETS_PER_REQUEST,
} from '../../../x-studio/src/server/createBatchingAdapter';
import type {
  StudioDataSource,
  StudioQueryDescriptor,
  StudioRelationship,
} from '../../../x-studio-schema/src/dataTypes';
import type { StudioExpressionField } from '../../../x-studio-schema/src/expressionTypes';
/* eslint-enable import/no-relative-packages */
import { validateQueryPlan } from '../security/validateQueryPlan';
import { handleBatchQuery, MAX_WIDGETS_PER_BATCH } from '../handler';
import { MAX_ROWS_PER_REQUEST } from '../router/execute';
import type { BatchWidgetDescriptor } from '../security/types';
import { LRUCacheProvider } from '../cache/LRUCacheProvider';
import { MapTierCacheProvider } from '../cache/MapTierCacheProvider';
import { createMockDb } from './mockDb';

process.env.JWT_SECRET ??= 'client-wire-seam-hmac-secret';

// ── Capturing the client's real wire body ────────────────────────────────────

let uidCounter = 0;
function uid(): string {
  uidCounter += 1;
  return `/api/seam-${uidCounter}`;
}

interface CapturedBody {
  pageId: string;
  widgets: BatchWidgetDescriptor[];
}

interface CaptureOptions {
  maxRowsPerWidget?: number;
  dataSources?: Record<string, StudioDataSource>;
  relationships?: StudioRelationship[];
  expressionFields?: StudioExpressionField[];
  // Answers each captured POST instead of the default empty row sets, so a test can
  // route the client's real body straight into `handleBatchQuery`.
  respond?: (body: CapturedBody) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
}

/**
 * Run `descriptors` through a real `createBatchingAdapter` and return every POST body
 * it produced. The stub `fetchFn` answers each widget with an empty row set by default,
 * so the adapter's own post-processing still runs and cannot mask a malformed request.
 */
async function captureWireBodies(
  descriptors: StudioQueryDescriptor[],
  options: CaptureOptions = {},
): Promise<CapturedBody[]> {
  const { respond, ...adapterOptions } = options;
  const bodies: CapturedBody[] = [];
  const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as CapturedBody;
    bodies.push(body);
    if (respond) {
      return respond(body);
    }
    return {
      ok: true,
      json: async () => ({
        results: body.widgets.map((w) => ({ id: w.id, rows: [] as Record<string, unknown>[] })),
      }),
    };
  });
  const adapter = createBatchingAdapter(uid(), {
    fetchFn: fetchFn as unknown as typeof fetch,
    batchDelayMs: 0,
    ...adapterOptions,
  });
  await Promise.allSettled(descriptors.map((d) => adapter.getRows(d)));
  return bodies;
}

/** The single widget descriptor the client emitted for `descriptor`. */
async function captureWidget(
  queryDescriptor: StudioQueryDescriptor,
  options: CaptureOptions = {},
): Promise<BatchWidgetDescriptor> {
  const [body] = await captureWireBodies([queryDescriptor], options);
  return body.widgets[0];
}

function field(id: string, type: 'string' | 'number' | 'date' = 'string') {
  return { id, label: id, type } as const;
}

function descriptor(overrides: Partial<StudioQueryDescriptor> = {}): StudioQueryDescriptor {
  return {
    sourceId: 'customers',
    tableName: 'customers',
    widgetId: 'w1',
    select: ['id'],
    cacheKey: 'ck-w1',
    ...overrides,
  };
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
  } as StudioExpressionField;
}

/**
 * Assert the client's body survives the server's own plan validation.
 *
 * `validateQueryPlan` is the gate every widget passes before a query is built, so a
 * descriptor it rejects is a widget that renders `StudioWidgetErrorOverlay` instead of
 * data — no matter how well-formed the body looks to the client's own tests.
 */
function expectServerAccepts(widget: BatchWidgetDescriptor): void {
  expect(() => validateQueryPlan(widget)).not.toThrow();
}

// ── A relationship graph carrying BOTH orientations of both arities ──────────

const SOURCES: Record<string, StudioDataSource> = {
  customers: {
    id: 'customers',
    label: 'Customers',
    tableName: 'customers',
    fields: [field('id'), field('name'), field('lifetime_value', 'number')],
  },
  orders: {
    id: 'orders',
    label: 'Orders',
    tableName: 'orders',
    fields: [
      field('order_id'),
      field('customer_id'),
      field('region'),
      field('region_id'),
      field('amount', 'number'),
    ],
  },
  profiles: {
    id: 'profiles',
    label: 'Profiles',
    tableName: 'profiles',
    fields: [field('profile_id'), field('customer_id'), field('tier')],
  },
  regions: {
    id: 'regions',
    label: 'Regions',
    tableName: 'regions',
    fields: [field('region_id'), field('region_name'), field('hq_customer_id')],
  },
};

/** `orders` is the MANY side: a customers widget sits on the "one" side. */
const REL_ORDERS_CUSTOMERS: StudioRelationship = {
  id: 'rel-orders-customers',
  sourceId: 'orders',
  sourceField: 'customer_id',
  targetId: 'customers',
  targetField: 'id',
  type: 'many-to-one',
};

/** Same direction, `one-to-one` arity: no fan-out, so the JOIN form stays valid. */
const REL_PROFILES_CUSTOMERS: StudioRelationship = {
  id: 'rel-profiles-customers',
  sourceId: 'profiles',
  sourceField: 'customer_id',
  targetId: 'customers',
  targetField: 'id',
  type: 'one-to-one',
};

const REL_ORDERS_REGIONS: StudioRelationship = {
  id: 'rel-orders-regions',
  sourceId: 'orders',
  sourceField: 'region_id',
  targetId: 'regions',
  targetField: 'region_id',
  type: 'many-to-one',
};

const REL_REGIONS_CUSTOMERS: StudioRelationship = {
  id: 'rel-regions-customers',
  sourceId: 'regions',
  sourceField: 'hq_customer_id',
  targetId: 'customers',
  targetField: 'id',
  type: 'one-to-one',
};

// ─────────────────────────────────────────────────────────────────────────────
// F1 — `joins[].on` orientation
// ─────────────────────────────────────────────────────────────────────────────

describe('seam — joins[].on orientation', () => {
  it('control: widget on the relationship SOURCE side', async () => {
    // `profiles` widget, expression field reaching `customers.name`. This branch was
    // already correctly oriented — it is the ONLY join `on` pair the client suite
    // asserted, which is exactly why the three reversed branches went unnoticed.
    const widget = await captureWidget(
      descriptor({
        sourceId: 'profiles',
        tableName: 'profiles',
        select: ['profile_id', 'expr-customer-name'],
      }),
      {
        dataSources: SOURCES,
        relationships: [REL_PROFILES_CUSTOMERS],
        expressionFields: [exprField('expr-customer-name', 'profiles', 'customers', 'name')],
      },
    );

    expect(widget.joins).toEqual([
      { table: 'customers', type: 'left', on: [['profiles.customer_id', 'customers.id']] },
    ]);
    expectServerAccepts(widget);
  });

  it('one-to-one expression join where the widget is the relationship TARGET', async () => {
    const widget = await captureWidget(descriptor({ select: ['id', 'expr-tier'] }), {
      dataSources: SOURCES,
      relationships: [REL_PROFILES_CUSTOMERS],
      expressionFields: [exprField('expr-tier', 'customers', 'profiles', 'tier')],
    });

    // RIGHT names the table THIS join introduces; LEFT a table already in scope.
    // Emitted the other way round, `validateJoinOnPairs` rejects the whole widget.
    expect(widget.joins).toEqual([
      { table: 'profiles', type: 'left', on: [['customers.id', 'profiles.customer_id']] },
    ]);
    expectServerAccepts(widget);
  });

  it('plain cross-source field where the widget is the relationship TARGET', async () => {
    const widget = await captureWidget(descriptor({ select: ['id', 'tier'] }), {
      dataSources: SOURCES,
      relationships: [REL_PROFILES_CUSTOMERS],
    });

    expect(widget.joins).toEqual([
      { table: 'profiles', type: 'left', on: [['customers.id', 'profiles.customer_id']] },
    ]);
    expectServerAccepts(widget);
  });

  it('two-hop expression join with hop 1 traversed backwards', async () => {
    // widget = `regions`; the expression field lives on `orders` and joins to
    // `customers`. Hop 1 (`regions` ← `orders`) is the reversed branch; hop 2 is
    // forward. `orders --many-to-one--> regions` would fan out, so the arity is
    // relaxed to one-to-one here to isolate the ORIENTATION defect (the fan-out
    // variant is asserted in the next block).
    const widget = await captureWidget(
      descriptor({
        sourceId: 'regions',
        tableName: 'regions',
        select: ['region_id', 'expr-order-customer'],
      }),
      {
        dataSources: SOURCES,
        relationships: [
          { ...REL_ORDERS_REGIONS, type: 'one-to-one' },
          { ...REL_ORDERS_CUSTOMERS, type: 'one-to-one' },
        ],
        expressionFields: [exprField('expr-order-customer', 'orders', 'customers', 'name')],
      },
    );

    expect(widget.joins).toEqual([
      { table: 'orders', type: 'left', on: [['regions.region_id', 'orders.region_id']] },
      { table: 'customers', type: 'left', on: [['orders.customer_id', 'customers.id']] },
    ]);
    expectServerAccepts(widget);
  });

  it('two-hop expression join with hop 2 traversed backwards', async () => {
    // widget = `orders`; the expression field lives on `regions` (hop 1 forward) and
    // joins to `profiles`, which is the relationship's SOURCE — so hop 2 is reversed.
    const widget = await captureWidget(
      descriptor({
        sourceId: 'orders',
        tableName: 'orders',
        select: ['order_id', 'expr-region-hq-tier'],
      }),
      {
        dataSources: SOURCES,
        relationships: [
          REL_ORDERS_REGIONS,
          {
            id: 'rel-profiles-regions',
            sourceId: 'profiles',
            sourceField: 'customer_id',
            targetId: 'regions',
            targetField: 'hq_customer_id',
            type: 'one-to-one',
          },
        ],
        expressionFields: [exprField('expr-region-hq-tier', 'regions', 'profiles', 'tier')],
      },
    );

    expect(widget.joins).toEqual([
      { table: 'regions', type: 'left', on: [['orders.region_id', 'regions.region_id']] },
      // LEFT is `regions` — a table joined EARLIER in this query, which
      // `validateJoinOnPairs`' left-hand rule admits — and RIGHT the new table.
      { table: 'profiles', type: 'left', on: [['regions.hq_customer_id', 'profiles.customer_id']] },
    ]);
    expectServerAccepts(widget);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F1 (secondary) — fan-out
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate a client-emitted `LEFT JOIN` plan under standard SQL semantics and return
 * the resulting row count.
 *
 * `mockDb` deliberately does not model joins, so a fan-out cannot be demonstrated by
 * running the plan through it. This does the one thing needed instead: interpret each
 * emitted `joins[].on` pair the way any SQL engine would — one output row per (left
 * row × matching right row) — which is the multiplication that turns a wrongly-guarded
 * join into inflated aggregates rather than an error.
 */
function leftJoinRowCount(
  widget: BatchWidgetDescriptor,
  tables: Record<string, Record<string, unknown>[]>,
): number {
  // Rows carry table-qualified keys so a joined row can be probed by either side.
  let rows = tables[widget.table].map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [`${widget.table}.${k}`, v])),
  );
  for (const join of widget.joins ?? []) {
    const next: Record<string, unknown>[] = [];
    for (const row of rows) {
      const matches = (tables[join.table] ?? []).filter((candidate) =>
        join.on.every(([left, right]) => {
          const rightCol = right.slice(right.indexOf('.') + 1);
          return candidate[rightCol] === row[left];
        }),
      );
      if (matches.length === 0) {
        next.push(row); // LEFT JOIN keeps unmatched rows
      } else {
        for (const match of matches) {
          next.push({
            ...row,
            ...Object.fromEntries(Object.entries(match).map(([k, v]) => [`${join.table}.${k}`, v])),
          });
        }
      }
    }
    rows = next;
  }
  return rows.length;
}

const FANOUT_TABLES = {
  customers: [{ id: 1, lifetime_value: 100 }],
  orders: [
    { order_id: 10, customer_id: 1, region: 'west', region_id: 'r1', amount: 5 },
    { order_id: 11, customer_id: 1, region: 'east', region_id: 'r1', amount: 7 },
    { order_id: 12, customer_id: 1, region: 'west', region_id: 'r1', amount: 9 },
  ],
  regions: [{ region_id: 'r1', region_name: 'West', hq_customer_id: 1 }],
  profiles: [{ profile_id: 'p1', customer_id: 1, tier: 'gold' }],
};

describe('seam — fan-out orientation guard', () => {
  it('never emits a row-multiplying join for a one-hop expression field on the "one" side', async () => {
    // `orders --many-to-one--> customers`, widget on CUSTOMERS, expression field
    // reaching `orders.region`. `LEFT JOIN orders ON customers.id = orders.customer_id`
    // is server-VALID but multiplies the single customer row by its three orders, so
    // `SUM(lifetime_value)` reads 3×. Correcting the `on` orientation WITHOUT this
    // guard would trade a loud server rejection for silent wrong data.
    const widget = await captureWidget(
      descriptor({
        select: ['id', 'lifetime_value'],
        aggregations: [{ field: 'lifetime_value', fn: 'sum', alias: 'lifetime_value' }],
        filter: { type: 'leaf', field: 'expr-order-region', op: 'equals', value: 'west' },
      }),
      {
        dataSources: SOURCES,
        relationships: [REL_ORDERS_CUSTOMERS],
        expressionFields: [exprField('expr-order-region', 'customers', 'orders', 'region')],
      },
    );

    expectServerAccepts(widget);
    expect(leftJoinRowCount(widget, FANOUT_TABLES)).toBe(FANOUT_TABLES.customers.length);
    // The filter is still expressed faithfully — as a semi-join, which filters the
    // widget's rows without multiplying them.
    expect(widget.semiJoins).toEqual([
      {
        table: 'orders',
        column: 'customers.id',
        foreignColumn: 'orders.customer_id',
        filters: [{ column: 'orders.region', operator: 'eq', value: 'west' }],
      },
    ]);
  });

  it('never emits a row-multiplying join when hop 1 of a two-hop expression fans out', async () => {
    // widget = `regions`; `orders --many-to-one--> regions`, so hop 1 read backwards
    // fans a region out across its orders. The filtered value lives two hops away on
    // `customers`.
    const widget = await captureWidget(
      descriptor({
        sourceId: 'regions',
        tableName: 'regions',
        select: ['region_id'],
        filter: { type: 'leaf', field: 'expr-order-customer', op: 'equals', value: 'Acme' },
      }),
      {
        dataSources: SOURCES,
        relationships: [REL_ORDERS_REGIONS, REL_ORDERS_CUSTOMERS],
        expressionFields: [exprField('expr-order-customer', 'orders', 'customers', 'name')],
      },
    );

    expectServerAccepts(widget);
    expect(leftJoinRowCount(widget, FANOUT_TABLES)).toBe(FANOUT_TABLES.regions.length);
    // Two-level nesting — exactly `MAX_SEMI_JOIN_DEPTH`, and the shape the two-hop
    // many-to-many case already emits.
    expect(widget.semiJoins).toEqual([
      {
        table: 'orders',
        column: 'regions.region_id',
        foreignColumn: 'orders.region_id',
        filters: [],
        semiJoins: [
          {
            table: 'customers',
            column: 'orders.customer_id',
            foreignColumn: 'customers.id',
            filters: [{ column: 'customers.name', operator: 'eq', value: 'Acme' }],
          },
        ],
      },
    ]);
  });

  it('never emits a row-multiplying join when hop 2 of a two-hop expression fans out', async () => {
    // widget = `customers`; hop 1 (`customers` ← `regions`, one-to-one) is safe, but
    // hop 2 reaches `orders`, the MANY side of `orders --many-to-one--> regions`.
    const widget = await captureWidget(
      descriptor({
        select: ['id'],
        filter: { type: 'leaf', field: 'expr-region-order-amount', op: 'equals', value: 5 },
      }),
      {
        dataSources: SOURCES,
        relationships: [REL_REGIONS_CUSTOMERS, REL_ORDERS_REGIONS],
        expressionFields: [exprField('expr-region-order-amount', 'regions', 'orders', 'amount')],
      },
    );

    expectServerAccepts(widget);
    expect(leftJoinRowCount(widget, FANOUT_TABLES)).toBe(FANOUT_TABLES.customers.length);
    expect(widget.semiJoins?.[0].semiJoins?.[0].table).toBe('orders');
  });

  it('keeps the plain JOIN form when neither hop fans out', async () => {
    // Regression fence for the guards above: a one-to-one chain must NOT be diverted
    // to a semi-join, or every reversed-but-safe join silently loses its projection.
    const widget = await captureWidget(descriptor({ select: ['id', 'expr-tier'] }), {
      dataSources: SOURCES,
      relationships: [REL_PROFILES_CUSTOMERS],
      expressionFields: [exprField('expr-tier', 'customers', 'profiles', 'tier')],
    });

    expect(widget.semiJoins).toBeUndefined();
    expect(widget.columnAliases).toEqual({ 'expr-tier': 'profiles.tier' });
    expect(widget.columns).toContain('expr-tier');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F3 — alias charset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Field ids that are perfectly ordinary in memory but sit outside the middleware's
 * `SAFE_ALIAS_PATTERN`. All four are shapes a real host produces: a CSV header, a
 * qualified view column, a translated label, a unit-annotated measure.
 */
const HOSTILE_IDS = ['Order Amount', 'orders.amount', 'montant€', 'amount(€)'];

describe('seam — alias charset', () => {
  it.each(HOSTILE_IDS)('does not emit "%s" as an aggregation alias', async (id) => {
    const sources: Record<string, StudioDataSource> = {
      sales: {
        id: 'sales',
        label: 'Sales',
        tableName: 'sales',
        fields: [field('region'), field(id, 'number')],
      },
    };
    const widget = await captureWidget(
      descriptor({
        sourceId: 'sales',
        tableName: 'sales',
        select: ['region', id],
        groupBy: 'region',
        aggregations: [{ field: id, fn: 'sum', alias: id }],
      }),
      { dataSources: sources, relationships: [] },
    );

    expectServerAccepts(widget);
    // Push-down is abandoned rather than emitted with an alias the host rejects: raw
    // rows come back and the client aggregates them to the same numbers.
    expect(widget.aggregations).toBeUndefined();
  });

  it.each(HOSTILE_IDS)('does not project "%s" as an output alias', async (id) => {
    const sources: Record<string, StudioDataSource> = {
      orders: {
        id: 'orders',
        label: 'Orders',
        tableName: 'orders',
        fields: [field('order_id'), field('customer_id')],
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        tableName: 'customers',
        fields: [field('id'), field('name')],
      },
    };
    const widget = await captureWidget(
      descriptor({
        sourceId: 'orders',
        tableName: 'orders',
        select: ['order_id', id],
      }),
      {
        dataSources: sources,
        relationships: [
          {
            id: 'rel',
            sourceId: 'orders',
            sourceField: 'customer_id',
            targetId: 'customers',
            targetField: 'id',
            type: 'many-to-one',
          },
        ],
        expressionFields: [exprField(id, 'orders', 'customers', 'name')],
      },
    );

    expectServerAccepts(widget);
    expect(widget.columns).not.toContain(id);
  });

  it('still pushes an aggregation down for a plain identifier alias', async () => {
    // Fence: the charset guard must not disable push-down for ordinary ids.
    const sources: Record<string, StudioDataSource> = {
      sales: {
        id: 'sales',
        label: 'Sales',
        tableName: 'sales',
        fields: [field('region'), field('amount', 'number')],
      },
    };
    const widget = await captureWidget(
      descriptor({
        sourceId: 'sales',
        tableName: 'sales',
        select: ['region', 'amount'],
        groupBy: 'region',
        aggregations: [{ field: 'amount', fn: 'sum', alias: 'amount' }],
      }),
      { dataSources: sources, relationships: [] },
    );

    expect(widget.aggregations).toEqual([{ column: 'amount', func: 'sum', alias: 'amount' }]);
    expectServerAccepts(widget);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F4 — batch size
// ─────────────────────────────────────────────────────────────────────────────

const BIG_TABLE_ROWS = Array.from({ length: 20 }, (_, i) => ({ id: i, amount: i }));

const DEV_CLAIMS = { tenantId: 't', userId: 'u', roleIds: [] as string[] };

interface HandlerResponse {
  results: { id: string; rows: unknown[]; error?: string }[];
}

/**
 * Run the client's captured body through the REAL handler, with FRESH cache providers.
 *
 * The handler falls back to module-level default caches, which are shared across every
 * call in the file — so two tests that happen to send an equivalent descriptor would
 * silently serve each other's rows (and each other's row counts), quietly defeating the
 * budget and truncation assertions below.
 */
/** Wrap a handler response in the minimal `Response` shape the adapter consumes. */
function ok(response: HandlerResponse) {
  return { ok: true, json: async () => response };
}

async function runHandler(
  db: ReturnType<typeof createMockDb>,
  body: CapturedBody,
  table: string,
): Promise<HandlerResponse> {
  return (await handleBatchQuery({ pageId: body.pageId, widgets: body.widgets }, DEV_CLAIMS, {
    db: db as never,
    schemaAllowlist: [table],
    tenancy: { mode: 'single-tenant' },
    cacheProvider: new LRUCacheProvider(),
    tierCacheProvider: new MapTierCacheProvider(),
  })) as HandlerResponse;
}

describe('seam — batch size', () => {
  it("the client's cap is the server's cap", () => {
    // The two constants are separate copies (x-studio must not depend on the server
    // package, and `handler.ts`'s export is not re-exported from its index). This is
    // the only place they meet — without it they drift and chunking silently stops
    // matching what the server accepts.
    expect(MAX_BATCH_WIDGETS_PER_REQUEST).toBe(MAX_WIDGETS_PER_BATCH);
  });

  it('chunks an over-cap page instead of POSTing one rejected body', async () => {
    const count = MAX_WIDGETS_PER_BATCH + 1;
    const bodies = await captureWireBodies(
      Array.from({ length: count }, (_, i) =>
        descriptor({ sourceId: 'big', tableName: 'big', widgetId: `w${i}`, cacheKey: `ck${i}` }),
      ),
    );

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(body.widgets.length).toBeLessThanOrEqual(MAX_WIDGETS_PER_BATCH);
    }
    // Every widget is still sent exactly once — chunking must not drop or duplicate.
    const sent = bodies.flatMap((b) => b.widgets.map((w) => w.id));
    expect(sent).toHaveLength(count);
    expect(new Set(sent).size).toBe(count);
  });

  it('every chunk is accepted by the real handler, and every widget gets rows', async () => {
    const count = MAX_WIDGETS_PER_BATCH + 5;
    const db = createMockDb({ big: BIG_TABLE_ROWS });
    const seen: string[] = [];

    await captureWireBodies(
      Array.from({ length: count }, (_, i) =>
        descriptor({
          sourceId: 'big',
          tableName: 'big',
          widgetId: `w${i}`,
          cacheKey: `ck${i}`,
          select: ['id', 'amount'],
        }),
      ),
      {
        // Route the client's real body straight into the real handler. An over-cap body
        // makes `assertValidBatchQueryRequest` THROW — before the per-widget loop — which
        // the reference host maps to a bare 500, so the client fails every widget with
        // `Studio batch request failed: 500 Internal Server Error`.
        respond: async (body) => {
          const response = await runHandler(db, body, 'big');
          for (const result of response.results) {
            expect(result.error).toBeUndefined();
            seen.push(result.id);
          }
          return { ok: true, json: async () => response };
        },
      },
    );

    expect(new Set(seen).size).toBe(count);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 — per-widget row limit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `MAX_ROWS_PER_REQUEST` is the allowance ONE batch may contribute in total, and a
 * widget whose rows do not fit is failed rather than truncated. Two raw-row widgets
 * over a table two-thirds that size therefore cannot both be served unless the client
 * bounds them.
 */
const STARVING_ROWS = Array.from({ length: Math.ceil(MAX_ROWS_PER_REQUEST * 0.6) }, (_, i) => ({
  id: i,
  amount: i,
}));

function pairOver(table: string): StudioQueryDescriptor[] {
  return ['w1', 'w2'].map((widgetId) =>
    descriptor({
      sourceId: table,
      tableName: table,
      widgetId,
      cacheKey: `ck-${widgetId}`,
      select: ['id', 'amount'],
    }),
  );
}

describe('seam — per-widget row limit', () => {
  it('emits no limit by default, and the shared budget then starves the second widget', async () => {
    // Documents the cost of the (deliberate) no-default: a limit TRUNCATES, and a
    // truncated result is indistinguishable from a complete one to a client-side
    // aggregation, so the adapter never imposes one uninvited.
    const db = createMockDb({ starve_a: STARVING_ROWS });
    let response: HandlerResponse | undefined;
    const [body] = await captureWireBodies(pairOver('starve_a'), {
      respond: async (captured) => {
        response = await runHandler(db, captured, 'starve_a');
        return { ok: true, json: async () => response };
      },
    });

    expect(body.widgets.every((w) => w.limit === undefined)).toBe(true);
    const starved = response!.results.filter((r) => r.error !== undefined);
    expect(starved).toHaveLength(1);
    // The remedy the server prescribes is now a field the client can actually set.
    expect(starved[0].error).toMatch(/row budget is exhausted/);
    expect(starved[0].error).toMatch(/"limit"/);
  });

  it('forwards a per-widget limit so the shared budget serves the whole page', async () => {
    const quarter = Math.floor(MAX_ROWS_PER_REQUEST / 4);
    const db = createMockDb({ starve_b: STARVING_ROWS });
    let response: HandlerResponse | undefined;
    const [body] = await captureWireBodies(pairOver('starve_b'), {
      maxRowsPerWidget: quarter,
      respond: async (captured) => {
        response = await runHandler(db, captured, 'starve_b');
        return { ok: true, json: async () => response };
      },
    });

    for (const widget of body.widgets) {
      expect(widget.limit).toBe(quarter);
      expectServerAccepts(widget);
    }
    for (const result of response!.results) {
      expect(result.error).toBeUndefined();
      expect(result.rows).toHaveLength(quarter);
    }
  });

  it("lets a descriptor's own limit win over the adapter default", async () => {
    const [body] = await captureWireBodies(
      [
        descriptor({ sourceId: 'big', tableName: 'big', widgetId: 'w1', cacheKey: 'a', limit: 7 }),
        descriptor({ sourceId: 'big', tableName: 'big', widgetId: 'w2', cacheKey: 'b' }),
      ],
      { maxRowsPerWidget: 100 },
    );

    expect(body.widgets.map((w) => w.limit)).toEqual([7, 100]);
    body.widgets.forEach(expectServerAccepts);
  });

  it('warns rather than silently truncating when a result comes back at the limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createMockDb({ trunc: Array.from({ length: 40 }, (_, i) => ({ id: i, amount: i })) });
    await captureWireBodies(
      [
        descriptor({
          sourceId: 'trunc',
          tableName: 'trunc',
          widgetId: 'w1',
          cacheKey: 'trunc-a',
          select: ['id', 'amount'],
        }),
      ],
      { maxRowsPerWidget: 10, respond: (body) => runHandler(db, body, 'trunc').then(ok) },
    );

    expect(warn.mock.calls.flat().join('\n')).toMatch(/TRUNCATED/);
    warn.mockRestore();
  });

  it('does not warn when the result fits comfortably inside the limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createMockDb({ fits: Array.from({ length: 3 }, (_, i) => ({ id: i, amount: i })) });
    await captureWireBodies(
      [
        descriptor({
          sourceId: 'fits',
          tableName: 'fits',
          widgetId: 'w1',
          cacheKey: 'fits-a',
          select: ['id', 'amount'],
        }),
      ],
      { maxRowsPerWidget: 10, respond: (body) => runHandler(db, body, 'fits').then(ok) },
    );

    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/TRUNCATED/);
    warn.mockRestore();
  });
});
