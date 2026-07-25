/**
 * Integration tests for useWidgetRows.
 *
 * Tests cover both the sync (in-memory pipeline) path and the async adapter path,
 * and includes a parity test that verifies both paths produce equivalent results
 * for identical data + filters.
 *
 * Context is mocked via vi.mock so that useStudioSelector resolves against a
 * mutable `mockState` object — matching the pattern used by other widget tests.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, render, act } from '@mui/internal-test-utils';
import type {
  StudioDataSource,
  StudioDataSourceAdapter,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioQueryResult,
  StudioState,
  StudioWidget,
} from '../models';
import { studioRequestCache } from './StudioRequestCache';
import { StudioUIConfigContext, DEFAULT_STUDIO_LOCALE_TEXT } from './StudioUIConfigContext';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../test/studioContextMock';

type Row = Record<string, unknown>;

// ── Mutable state shared by the context mock ───────────────────────────────

let mockState: StudioState;

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

// ── Factories ───────────────────────────────────────────────────────────────

/**
 * Flat override bag for `createState` — deliberately mirrors the pre-partition
 * `StudioState` shape as test-fixture sugar local to this file. `createState`
 * itself routes each field into the correct `doc`/`session`/`runtime` partition
 * of the real `StudioState` it returns.
 */
interface StateOverrides {
  mode?: StudioState['session']['mode'];
  dashboard?: Partial<StudioState['doc']['dashboard']>;
  pages?: StudioState['doc']['pages'];
  widgets?: StudioState['doc']['widgets'];
  dataSources?: StudioState['runtime']['dataSources'];
  relationships?: StudioState['doc']['relationships'];
  filters?: StudioState['doc']['filters'];
  expressionFields?: StudioState['doc']['expressionFields'];
  shell?: Partial<StudioState['session']['shell']>;
}

function createState(overrides: StateOverrides = {}): StudioState {
  return {
    doc: {
      schemaVersion: 1,
      dashboard: {
        id: 'dash-1',
        title: 'Dashboard',
        activePageId: 'page-1',
        ...overrides.dashboard,
      },
      pages: {
        'page-1': { id: 'page-1', title: 'Overview', widgetRows: [] },
        ...overrides.pages,
      },
      widgets: overrides.widgets ?? {},
      relationships: overrides.relationships ?? [],
      filters: overrides.filters ?? [],
      expressionFields: overrides.expressionFields ?? [],
    },
    session: {
      mode: overrides.mode ?? 'view',
      shell: {
        openDrawers: { data: true, compose: true, filters: false },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
        ...overrides.shell,
      },
    },
    runtime: {
      dataSources: overrides.dataSources ?? {},
    },
  };
}

function makeWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  // Legacy shape (`type`/`pageId` rather than `kind`) kept as-is for this test;
  // cast through `unknown` since it no longer overlaps the discriminated union.
  return {
    id: 'w1',
    type: 'kpi',
    sourceId: 'src1',
    title: 'Widget',
    pageId: 'page-1',
    ...overrides,
  } as unknown as StudioWidget;
}

function makeDataSource(rows: Row[], overrides: Partial<StudioDataSource> = {}): StudioDataSource {
  return {
    id: 'src1',
    label: 'Source 1',
    rows,
    fields: [],
    ...overrides,
  };
}

function makeFilter(
  overrides: Partial<StudioFilterState> & { scope: StudioFilterState['scope'] },
): StudioFilterState {
  return {
    id: 'f1',
    field: 'region',
    operator: 'equals',
    value: 'EU',
    filterMode: 'filter',
    ...overrides,
  } as StudioFilterState;
}

// ── Test data ───────────────────────────────────────────────────────────────

const rows: Row[] = [
  { id: 1, region: 'EU', amount: 100 },
  { id: 2, region: 'US', amount: 200 },
  { id: 3, region: 'EU', amount: 150 },
];

// ── Import hook (after mocks are set up) ────────────────────────────────────

// Dynamic import keeps mock hoisting correct; vitest hoists vi.mock() before imports.
let useWidgetRows: (typeof import('./useWidgetRows'))['useWidgetRows'];

beforeEach(async () => {
  studioRequestCache.clear();
  configureStudioContextMock({ getState: () => mockState });
  ({ useWidgetRows } = await import('./useWidgetRows'));
});

afterEach(() => {
  studioRequestCache.clear();
  vi.restoreAllMocks();
});

// ── Sync path ───────────────────────────────────────────────────────────────

describe('sync path (no adapter)', () => {
  it('returns all rows when no filters are active', () => {
    mockState = createState();
    const widget = makeWidget();
    const dataSource = makeDataSource(rows);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    expect(result.current.filteredRows).toHaveLength(3);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasCrossFilters).toBe(false);
  });

  it('applies a page filter to rows', () => {
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f1',
          scope: { kind: 'page' },
          field: 'region',
          operator: 'equals',
          value: 'EU',
        }),
      ],
    });
    const widget = makeWidget();
    const dataSource = makeDataSource(rows);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    expect(result.current.filteredRows).toHaveLength(2);
    expect(result.current.filteredRows.every((r) => r.region === 'EU')).toBe(true);
  });

  it('applies a widget-scoped filter to rows', () => {
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f1',
          scope: { kind: 'widget', widgetId: 'w1' },
          field: 'amount',
          operator: 'greater_than',
          value: 120,
        }),
      ],
    });
    const widget = makeWidget({ id: 'w1' });
    const dataSource = makeDataSource(rows);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    expect(result.current.filteredRows).toHaveLength(2);
    expect(result.current.filteredRows.every((r) => (r.amount as number) > 120)).toBe(true);
  });

  it('detects cross-filters from other widgets', () => {
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f-cross',
          scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
          field: 'region',
          operator: 'equals',
          value: 'EU',
        }),
      ],
    });
    const widget = makeWidget({ id: 'w1' });
    const dataSource = makeDataSource(rows);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    expect(result.current.hasCrossFilters).toBe(true);
    // filteredRows applies the cross-filter; filteredRowsNoCross does not
    expect(result.current.filteredRows).toHaveLength(2);
    expect(result.current.filteredRowsNoCross).toHaveLength(3);
  });

  it('exposes resolvedFiltersAll / resolvedFiltersNoCross paired with the row sets (finding 2.1)', () => {
    // The scoped filter sets consumers use for L4 re-anchoring must come from useWidgetRows itself
    // (same deferred snapshot as the rows) rather than a live re-derivation. `resolvedFiltersAll`
    // ('all') includes the cross-filter that shaped `filteredRows`; `resolvedFiltersNoCross`
    // ('no-cross') carries only page+widget filters, matching `filteredRowsNoCross`.
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f-page',
          scope: { kind: 'page', pageId: 'page-1' },
          field: 'region',
          operator: 'equals',
          value: 'EU',
        }),
        makeFilter({
          id: 'f-cross',
          scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
          field: 'amount',
          operator: 'greater_than',
          value: 120,
        }),
      ],
    });
    const widget = makeWidget({ id: 'w1' });
    const dataSource = makeDataSource(rows);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    const allIds = result.current.resolvedFiltersAll.map((f) => f.id).sort();
    const noCrossIds = result.current.resolvedFiltersNoCross.map((f) => f.id).sort();
    expect(allIds).toEqual(['f-cross', 'f-page']);
    expect(noCrossIds).toEqual(['f-page']);
  });

  it('filteredRowsNoChartCross equals filteredRows when no chart cross-filters are active', () => {
    mockState = createState();
    const widget = makeWidget({ id: 'w1' });
    const dataSource = makeDataSource(rows);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    // Same reference when no chart cross-filters
    expect(result.current.filteredRowsNoChartCross).toBe(result.current.filteredRows);
    expect(result.current.hasChartCrossFilters).toBe(false);
  });

  it('filteredRowsNoChartCross excludes chart cross-filter but includes interactive filter', () => {
    // interactive (filter-widget) filter: only EU rows
    // chart cross-filter: only rows with amount > 120
    // Expected: filteredRowsNoChartCross = EU rows (2), filteredRows = EU rows with amount > 120 (1)
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f-interactive',
          scope: { kind: 'interactive', sourceWidgetId: 'filter-widget', pageId: 'page-1' },
          field: 'region',
          operator: 'equals',
          value: 'EU',
          filterMode: 'condition',
        }),
        makeFilter({
          id: 'f-cross',
          scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
          field: 'amount',
          operator: 'greater_than',
          value: 120,
        }),
      ],
    });
    const widget = makeWidget({ id: 'w1' });
    const dataSource = makeDataSource(rows);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    // All 3 filters: page+widget+interactive+chart-cross
    expect(result.current.filteredRows).toHaveLength(1);
    expect(result.current.filteredRows[0]).toMatchObject({ id: 3, region: 'EU', amount: 150 });

    // filteredRowsNoCross: page+widget only (no interactive, no chart-cross) → all 3 rows
    expect(result.current.filteredRowsNoCross).toHaveLength(3);

    // filteredRowsNoChartCross: page+widget+interactive (no chart-cross) → 2 EU rows
    expect(result.current.filteredRowsNoChartCross).toHaveLength(2);
    expect(result.current.filteredRowsNoChartCross.every((r) => r.region === 'EU')).toBe(true);

    expect(result.current.hasChartCrossFilters).toBe(true);
  });

  it("effectiveRows under crossFilterMode:'none' keeps an active interactive filter applied (hard-filter invariant)", () => {
    // Same fixture as 'filteredRowsNoChartCross excludes chart cross-filter but includes
    // interactive filter' above, but the widget opts out of CHART cross-filters via
    // `config.crossFilterMode: 'none'`. Before the fix, `effectiveRows` fell back to
    // `filteredRowsNoCross` (page+widget only), which ALSO drops the interactive filter —
    // contradicting the documented invariant that interactive (filter-widget) selections
    // are hard filters that always apply, regardless of the target widget's cross-filter
    // mode. `effectiveRows` must equal `filteredRowsNoChartCross` instead (page+widget+
    // interactive, chart cross-filter excluded).
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f-interactive',
          scope: { kind: 'interactive', sourceWidgetId: 'filter-widget', pageId: 'page-1' },
          field: 'region',
          operator: 'equals',
          value: 'EU',
          filterMode: 'condition',
        }),
        makeFilter({
          id: 'f-cross',
          scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
          field: 'amount',
          operator: 'greater_than',
          value: 120,
        }),
      ],
    });
    const widget = makeWidget({ id: 'w1', config: { crossFilterMode: 'none' } as never });
    const dataSource = makeDataSource(rows);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    // effectiveRows must equal filteredRowsNoChartCross (2 EU rows) — NOT
    // filteredRowsNoCross (3 rows, which also drops the interactive filter).
    expect(result.current.effectiveRows).toEqual(result.current.filteredRowsNoChartCross);
    expect(result.current.effectiveRows).toHaveLength(2);
    expect(result.current.effectiveRows.every((r) => r.region === 'EU')).toBe(true);
  });

  it('hasChartCrossFilters is false when only interactive filters are active', () => {
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f-interactive',
          scope: { kind: 'interactive', sourceWidgetId: 'filter-widget', pageId: 'page-1' },
          field: 'region',
          operator: 'equals',
          value: 'EU',
          filterMode: 'condition',
        }),
      ],
    });
    const widget = makeWidget({ id: 'w1' });
    const dataSource = makeDataSource(rows);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    expect(result.current.hasChartCrossFilters).toBe(false);
    expect(result.current.hasCrossFilters).toBe(true);
    // filteredRowsNoChartCross is same reference as filteredRows (no chart cross-filter)
    expect(result.current.filteredRowsNoChartCross).toBe(result.current.filteredRows);
  });

  it('a DISABLED interactive filter does not make hasCrossFilters spuriously true', () => {
    // A disabled interactive filter lingers in `partitionFilters` output (it is not
    // stripped) — `toggleFilter` can disable one. Without the `!f.disabled` guard on
    // the interactive branch it would flip `hasCrossFilters` to true, costing the
    // `filteredRowsNoCross` reference short-circuit and skipping chart entrance
    // animations, even though the filter is inert.
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f-interactive-disabled',
          scope: { kind: 'interactive', sourceWidgetId: 'filter-widget', pageId: 'page-1' },
          field: 'region',
          operator: 'equals',
          value: 'EU',
          filterMode: 'condition',
          disabled: true,
        }),
      ],
    });
    const widget = makeWidget({ id: 'w1' });
    const dataSource = makeDataSource(rows);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    // Inert filter → no cross-filters, and the reference short-circuit is preserved.
    expect(result.current.hasCrossFilters).toBe(false);
    expect(result.current.filteredRowsNoCross).toBe(result.current.filteredRows);
    expect(result.current.filteredRows).toHaveLength(rows.length);
  });

  it('returns empty array when dataSource has no rows', () => {
    mockState = createState();
    const widget = makeWidget();
    const dataSource = makeDataSource([]);
    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    expect(result.current.filteredRows).toHaveLength(0);
  });

  it('returns empty array when dataSource is undefined', () => {
    mockState = createState();
    const widget = makeWidget();
    const { result } = renderHook(() => useWidgetRows(widget, undefined, 'page-1'));

    expect(result.current.filteredRows).toHaveLength(0);
    expect(result.current.isLoading).toBe(false);
  });
});

// ── Async adapter path ──────────────────────────────────────────────────────

describe('async adapter path', () => {
  it('returns isLoading=true while fetch is in progress, then delivers rows', async () => {
    mockState = createState();
    const widget = makeWidget();

    let resolveAdapter!: (result: StudioQueryResult) => void;
    const adapterPromise = new Promise<StudioQueryResult>((res) => {
      resolveAdapter = res;
    });

    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockReturnValue(adapterPromise),
    };
    const dataSource = makeDataSource([], { adapter });

    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    // Before promise resolves: should be loading
    expect(result.current.isLoading).toBe(true);
    expect(result.current.filteredRows).toHaveLength(0);

    // Resolve the adapter
    await act(async () => {
      resolveAdapter({ rows: [{ id: 99, region: 'EU', amount: 999 }] });
      await adapterPromise;
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.filteredRows).toHaveLength(1);
    expect(result.current.filteredRows[0]).toMatchObject({ id: 99 });
  });

  // ── Cold-cache placeholder rows (M11) ─────────────────────────────────────
  //
  // On a cold request cache `useAdapterRows` seeds `adapterRows` from `dataSource.rows` so the
  // widget doesn't flash empty. Those rows never went to the server, so the premise the
  // adapter branch normally rests on — "page/widget filters were baked into
  // `descriptor.filter`" — is false for them. Re-applying only the rank/cross/interactive
  // residual rendered the FULL dataset (and KPI totals computed from it) on every page load of
  // a dashboard with e.g. a "last 30 days" range, until the fetch resolved.

  it('applies the FULL local filter chain to cold-cache placeholder rows', async () => {
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f-page',
          scope: { kind: 'page' },
          field: 'region',
          operator: 'equals',
          value: 'EU',
          filterMode: 'condition',
        }),
      ],
    });
    const widget = makeWidget();

    let resolveAdapter!: (result: StudioQueryResult) => void;
    const adapterPromise = new Promise<StudioQueryResult>((res) => {
      resolveAdapter = res;
    });
    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockReturnValue(adapterPromise),
    };
    // `rows` pre-populated (e.g. by a prior `setDataSourceRows`) → seeded as the placeholder.
    const dataSource = makeDataSource(rows, { adapter });

    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    expect(result.current.isLoading).toBe(true);
    // Before the fix: 3 — the whole dataset, page filter ignored.
    expect(result.current.filteredRows).toHaveLength(2);
    expect(result.current.filteredRows.every((r) => r.region === 'EU')).toBe(true);

    await act(async () => {
      resolveAdapter({
        rows: [
          { id: 9, region: 'EU', amount: 10 },
          { id: 10, region: 'US', amount: 20 },
        ],
      });
      await adapterPromise;
    });

    // Once a REAL response lands the placeholder flag clears and the residual-only pass is
    // restored: the server already enforced the page filter, so it is not re-applied locally
    // (both returned rows survive, including the US one).
    expect(result.current.isLoading).toBe(false);
    expect(result.current.filteredRows).toHaveLength(2);
    expect(result.current.filteredRows.map((r) => r.id)).toEqual([9, 10]);
  });

  it('does not double-apply page filters to rows served from the request cache', async () => {
    // A cache hit is a REAL response — never a placeholder — so the page filter that was baked
    // into the descriptor must not be re-applied client-side.
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f-page',
          scope: { kind: 'page' },
          field: 'region',
          operator: 'equals',
          value: 'EU',
          filterMode: 'condition',
        }),
      ],
    });
    const widget = makeWidget();
    const adapter: StudioDataSourceAdapter = { getRows: vi.fn() };
    const dataSource = makeDataSource(rows, { adapter });

    // Server-filtered response: only EU rows would come back, but we seed a US row too to
    // prove the client does not re-filter them.
    const serverRows: Row[] = [
      { id: 7, region: 'EU', amount: 1 },
      { id: 8, region: 'US', amount: 2 },
    ];
    const { buildWidgetQueryDescriptor } = await import('./queryDescriptor');
    const descriptor = buildWidgetQueryDescriptor(widget, 'page-1', undefined, {
      filters: mockState.doc.filters,
      expressionFields: [],
      relationships: [],
      crossFilterAllPages: false,
    });
    studioRequestCache.set(descriptor.cacheKey, { rows: serverRows }, undefined, adapter);

    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    expect(adapter.getRows).not.toHaveBeenCalled();
    expect(result.current.filteredRows.map((r) => r.id)).toEqual([7, 8]);
  });

  it('calls adapter with a QueryDescriptor containing the active page id', async () => {
    mockState = createState();
    const widget = makeWidget({ sourceId: 'src1' });

    const adapterResult: StudioQueryResult = { rows };
    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockResolvedValue(adapterResult),
    };
    const dataSource = makeDataSource([], { adapter });

    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => !result.current.isLoading);
    });

    const callArg = (adapter.getRows as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as StudioQueryDescriptor;
    expect(callArg.sourceId).toBe('src1');
    expect(callArg.widgetId).toBe('w1');
    expect(callArg.cacheKey).toBeTruthy();
  });

  it('serves cached rows synchronously without calling the adapter again', async () => {
    mockState = createState();
    const widget = makeWidget({ sourceId: 'src1' });

    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const dataSource = makeDataSource([], { adapter });

    // Pre-populate the cache with data, namespaced to this SAME adapter instance (matching
    // the adapter identity `useAdapterRows` will pass through to `get`).
    const cachedRows: Row[] = [{ id: 'cached', region: 'EU' }];
    const { buildQueryDescriptor } = await import('./queryDescriptor');
    const descriptor = buildQueryDescriptor(widget, [], 'page-1');
    studioRequestCache.set(descriptor.cacheKey, { rows: cachedRows }, undefined, adapter);

    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    // Cached data served synchronously — no loading state
    expect(result.current.filteredRows).toHaveLength(1);
    expect(result.current.filteredRows[0]).toMatchObject({ id: 'cached' });
    expect(result.current.isLoading).toBe(false);

    // Adapter should NOT be called when there is a cache hit
    expect(adapter.getRows).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent requests for the same descriptor', async () => {
    mockState = createState();
    const widget = makeWidget({ sourceId: 'src1' });

    let resolveAdapter!: (r: StudioQueryResult) => void;
    const adapterPromise = new Promise<StudioQueryResult>((res) => {
      resolveAdapter = res;
    });

    const adapterFn = vi.fn().mockReturnValue(adapterPromise);
    const adapter: StudioDataSourceAdapter = { getRows: adapterFn };
    const dataSource = makeDataSource([], { adapter });

    // Render two instances of the hook with the same widget/source
    const { result: result1, unmount: unmount1 } = renderHook(() =>
      useWidgetRows(widget, dataSource, 'page-1'),
    );
    const { result: result2, unmount: unmount2 } = renderHook(() =>
      useWidgetRows(widget, dataSource, 'page-1'),
    );

    await act(async () => {
      resolveAdapter({ rows });
      await adapterPromise;
    });

    // adapter.getRows should only be called once
    expect(adapterFn).toHaveBeenCalledTimes(1);
    expect(result1.current.filteredRows).toHaveLength(3);
    expect(result2.current.filteredRows).toHaveLength(3);

    unmount1();
    unmount2();
  });

  // ── Adapter-instance cache isolation (Tier2 fix) ───────────────────────────
  // Two `<Studio>` instances mounted in the same page/process (e.g. a multi-tenant admin
  // console) can share a `sourceId` string ("src1") while each being configured with its
  // OWN host adapter (different tenant/auth/backend). `studioRequestCache` is a
  // module-level singleton whose cacheKey has no adapter-identity component, so
  // `useAdapterRows` must pass the live `dataSource.adapter` through to
  // `get`/`getInflight`/`addInflight` — otherwise the second instance would get a cache
  // HIT on the first instance's rows (or join its in-flight request) for an identical
  // descriptor, a cross-tenant data leak.

  it('does not serve a different adapter instance the previous adapter instance rows for the same sourceId', async () => {
    mockState = createState();
    const widget = makeWidget({ sourceId: 'src1' });

    const adapterA: StudioDataSourceAdapter = {
      getRows: vi.fn().mockResolvedValue({ rows: [{ id: 'tenant-a', region: 'EU' }] }),
    };
    const dataSourceA = makeDataSource([], { adapter: adapterA });

    const { result: resultA, unmount: unmountA } = renderHook(() =>
      useWidgetRows(widget, dataSourceA, 'page-1'),
    );
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => !resultA.current.isLoading);
    });
    expect(resultA.current.filteredRows).toEqual([{ id: 'tenant-a', region: 'EU' }]);
    unmountA();

    // A second, separate `<Studio>` instance: same sourceId string and identical query
    // shape (so the legacy un-namespaced cacheKey would be identical), but a DIFFERENT
    // adapter instance/tenant.
    const adapterB: StudioDataSourceAdapter = {
      getRows: vi.fn().mockResolvedValue({ rows: [{ id: 'tenant-b', region: 'US' }] }),
    };
    const dataSourceB = makeDataSource([], { adapter: adapterB });

    const { result: resultB, unmount: unmountB } = renderHook(() =>
      useWidgetRows(widget, dataSourceB, 'page-1'),
    );
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => !resultB.current.isLoading);
    });

    // Before the fix: this would be a cache HIT on adapterA's un-namespaced entry, so
    // `adapterB.getRows` would never be called and instance B would render tenant A's rows.
    expect(adapterB.getRows).toHaveBeenCalledTimes(1);
    expect(resultB.current.filteredRows).toEqual([{ id: 'tenant-b', region: 'US' }]);
    unmountB();
  });

  it('applies cross-filters client-side on adapter rows', async () => {
    mockState = createState({
      filters: [
        makeFilter({
          id: 'f-cross',
          scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
          field: 'region',
          operator: 'equals',
          value: 'EU',
        }),
      ],
    });
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });

    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockResolvedValue({ rows }),
    };
    const dataSource = makeDataSource([], { adapter });

    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => !result.current.isLoading);
    });

    // Cross-filters are now applied client-side on adapter rows
    expect(result.current.hasCrossFilters).toBe(true);
    // filteredRows has the cross-filter applied (EU rows only)
    expect(result.current.filteredRows).toHaveLength(2);
    // filteredRowsNoCross is the full adapter row set without cross-filter
    expect(result.current.filteredRowsNoCross).toHaveLength(3);
    expect(result.current.filteredRowsNoCross).not.toBe(result.current.filteredRows);

    // The cross-filter must NOT be baked into the server query (finding 1.3): the adapter
    // is called exactly once and the descriptor carries no filter (only a cross-filter
    // exists, and cross-filters are enforced client-side).
    expect(adapter.getRows).toHaveBeenCalledTimes(1);
    const descriptor = (adapter.getRows as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as StudioQueryDescriptor;
    expect(descriptor.filter).toBeUndefined();
  });

  it('honors crossFilterAllPages for a cross-filter from another page', async () => {
    // The cross-filter originates on page-2 while the widget lives on page-1. It must
    // only apply when crossFilterAllPages is enabled — this exercises the adapter path
    // now routing through selectFiltersForWidget (previously hand-encoded inline).
    const buildState = (crossFilterAllPages: boolean) =>
      createState({
        dashboard: {
          id: 'dash-1',
          title: 'Dashboard',
          activePageId: 'page-1',
          crossFilterAllPages,
        },
        filters: [
          makeFilter({
            id: 'f-cross',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-2' },
            field: 'region',
            operator: 'equals',
            value: 'EU',
          }),
        ],
      });
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });
    const makeAdapterSource = () =>
      makeDataSource([], { adapter: { getRows: vi.fn().mockResolvedValue({ rows }) } });

    // Default (crossFilterAllPages = false): the other-page cross-filter is ignored.
    // The `dataSource` (and its adapter) is created ONCE per rendered instance — matching
    // real usage, where a widget's `dataSource` prop reference stays stable across its own
    // re-renders — rather than inline in the render callback, which would mint a brand new
    // adapter identity (and therefore a brand new adapter-namespaced cache entry) on every
    // re-render and never let a single fetch actually settle.
    mockState = buildState(false);
    const dataSourceOff = makeAdapterSource();
    const { result: resultOff, unmount: unmountOff } = renderHook(() =>
      useWidgetRows(widget, dataSourceOff, 'page-1'),
    );
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => !resultOff.current.isLoading);
    });
    expect(resultOff.current.hasCrossFilters).toBe(false);
    expect(resultOff.current.filteredRows).toHaveLength(3);
    unmountOff();

    studioRequestCache.clear();

    // crossFilterAllPages = true: the other-page cross-filter now applies (EU rows only).
    mockState = buildState(true);
    const dataSourceOn = makeAdapterSource();
    const { result: resultOn, unmount: unmountOn } = renderHook(() =>
      useWidgetRows(widget, dataSourceOn, 'page-1'),
    );
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => !resultOn.current.isLoading);
    });
    expect(resultOn.current.hasCrossFilters).toBe(true);
    expect(resultOn.current.filteredRows).toHaveLength(2);
    unmountOn();
  });

  it('sets isLoading=false when adapter rejects', async () => {
    mockState = createState();
    const widget = makeWidget({ sourceId: 'src1' });

    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockRejectedValue(new Error('Network error')),
    };
    const dataSource = makeDataSource([], { adapter });

    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      // Wait for the rejection to be handled
      await vi.waitFor(() => !result.current.isLoading);
    });

    expect(result.current.isLoading).toBe(false);
    // Rows remain empty after failure
    expect(result.current.filteredRows).toHaveLength(0);
  });

  it('falls back to the localized widgetLoadError token (not a hardcoded English string) when the adapter rejects with a non-Error value (finding 6)', async () => {
    mockState = createState();
    const widget = makeWidget({ sourceId: 'src1' });

    const adapter: StudioDataSourceAdapter = {
      // Reject with a plain string, not an Error — exercises the `err instanceof Error`
      // false branch, which used to fall back to a hardcoded English string.
      getRows: vi.fn().mockRejectedValue('boom'),
    };
    const dataSource = makeDataSource([], { adapter });

    // Custom locale overriding `widgetLoadError` to a distinctive, non-English string —
    // proves the hook actually reads the locale token rather than a hardcoded fallback,
    // which would render as the English string regardless of the active locale.
    const customLocaleText = {
      ...DEFAULT_STUDIO_LOCALE_TEXT,
      widgetLoadError: '__LOCALIZED_LOAD_ERROR__',
    };
    function Wrapper({ children }: { children?: React.ReactNode }) {
      return React.createElement(
        StudioUIConfigContext.Provider,
        {
          value: {
            tableSourceMode: 'explicit',
            featureFlags: {},
            localeText: customLocaleText,
          },
        },
        children,
      );
    }

    const { result } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'), {
      wrapper: Wrapper,
    });

    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => result.current.isError);
    });

    expect(result.current.errorMessage).toBe('__LOCALIZED_LOAD_ERROR__');
  });

  it('does not stay stuck loading when the descriptor changes to a cached one before the first fetch resolves', async () => {
    // Regression: descriptor A misses the cache → isLoading becomes true with an in-flight
    // fetch. Before A resolves, the descriptor switches to B, which IS already cached. A's
    // effect cleanup marks its (never-resolving) promise cancelled, so its `.then` never
    // runs; the B branch serves the cached result synchronously. That synchronous cache-hit
    // branch must reset isLoading — otherwise the loading overlay stays true forever even
    // though valid data is already rendered.
    const { buildQueryDescriptor } = await import('./queryDescriptor');
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });

    // The SAME adapter/dataSource instance is used across the A → B transition (a rerender
    // of one widget instance, not a fresh mount), so descriptor B's cache entry must be
    // seeded under that SAME adapter identity for the effect's namespaced `get` to find it.
    const neverResolves = new Promise<StudioQueryResult>(() => {});
    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockReturnValue(neverResolves),
    };
    const dataSource = makeDataSource([], { adapter });

    // Descriptor B — a page filter on region=EU — pre-seeded into the cache so switching to
    // it produces a synchronous cache hit.
    const filtersB = [
      makeFilter({
        id: 'f-page',
        scope: { kind: 'page' },
        field: 'region',
        operator: 'equals',
        value: 'EU',
      }),
    ];
    const descriptorB = buildQueryDescriptor(widget, filtersB, 'page-1', undefined, []);
    studioRequestCache.set(
      descriptorB.cacheKey,
      { rows: [{ id: 'cached-B', region: 'EU' }] },
      undefined,
      adapter,
    );

    // State A — no filters → descriptor A, NOT cached → an in-flight fetch that never resolves.
    mockState = createState({ filters: [] });

    const { result, rerender } = renderHook(() => useWidgetRows(widget, dataSource, 'page-1'));

    // A missed the cache → loading, fetch still in-flight.
    expect(result.current.isLoading).toBe(true);

    // Switch to descriptor B (cache hit) before A ever resolves. `rerender` flushes effects
    // (it wraps in act internally), so the synchronous cache-hit branch runs before we assert.
    mockState = createState({ filters: filtersB });
    rerender();

    // The cache-hit branch cleared isLoading — not left it stuck true — and served B's data.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.filteredRows).toHaveLength(1);
    expect(result.current.filteredRows[0]).toMatchObject({ id: 'cached-B' });
  });

  it('resets isLoading/isError instead of freezing them when the adapter is removed mid-flight (finding 2)', async () => {
    // Regression: StudioDashboard.tsx clears adapters dropped from the `dataAdapters` prop,
    // removeDataSource, and the public StudioHandle.setDataSourceAdapter(id, undefined) API all
    // can swap a widget's dataSource from an adapter-backed one to a plain in-memory one WHILE a
    // fetch is in flight. The in-flight promise's own cleanup marks it cancelled, so its resolve/
    // reject handlers never run — nothing else ever clears isLoading/isError, and the widget would
    // be stuck showing a permanent loading spinner (or a stale error overlay) over valid fallback
    // rows until remount.
    mockState = createState();
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });

    const neverResolves = new Promise<StudioQueryResult>(() => {});
    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockReturnValue(neverResolves),
    };
    const adapterDataSource = makeDataSource([], { adapter });

    const { result, rerender } = renderHook(
      ({ dataSource }) => useWidgetRows(widget, dataSource, 'page-1'),
      { initialProps: { dataSource: adapterDataSource } },
    );

    // The fetch missed the cache and is now in-flight, never resolving.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isError).toBe(false);

    // The adapter is removed (e.g. setDataSourceAdapter(id, undefined)) — the widget falls back
    // to the in-memory rows on the new plain dataSource.
    const plainDataSource = makeDataSource([{ id: 1, region: 'EU', amount: 100 }]);
    rerender({ dataSource: plainDataSource });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.filteredRows).toHaveLength(1);
  });
});

// ── Parity: sync vs async produce the same filtered result ─────────────────

describe('sync vs async parity', () => {
  it('produces the same rows for identical data and page filter', async () => {
    const filter = makeFilter({
      id: 'f1',
      scope: { kind: 'page' },
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });

    // Sync setup
    mockState = createState({ filters: [filter] });
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });
    const syncDataSource = makeDataSource(rows);
    const { result: syncResult } = renderHook(() =>
      useWidgetRows(widget, syncDataSource, 'page-1'),
    );
    const syncRows = syncResult.current.filteredRows;

    // Async setup — adapter returns all rows; descriptor carries the EU filter
    studioRequestCache.clear();
    const filteredByServer = rows.filter((r) => r.region === 'EU');
    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockResolvedValue({ rows: filteredByServer }),
    };
    const asyncDataSource = makeDataSource([], {
      id: 'src1',
      adapter,
    } as Partial<StudioDataSource>);

    const { result: asyncResult } = renderHook(() =>
      useWidgetRows(widget, asyncDataSource, 'page-1'),
    );

    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => !asyncResult.current.isLoading);
    });

    const asyncRows = asyncResult.current.filteredRows;

    // Both paths should return 2 EU rows with identical shape
    expect(asyncRows).toHaveLength(syncRows.length);
    asyncRows.forEach((asyncRow, i) => {
      expect(asyncRow.id).toBe(syncRows[i].id);
      expect(asyncRow.region).toBe(syncRows[i].region);
      expect(asyncRow.amount).toBe(syncRows[i].amount);
    });
  });

  it('disabled filter: both paths return all rows', async () => {
    const disabledFilter = makeFilter({
      id: 'f-disabled',
      scope: { kind: 'page' },
      field: 'region',
      operator: 'equals',
      value: 'EU',
      disabled: true,
    });

    // Sync — disabled filter must not be applied
    mockState = createState({ filters: [disabledFilter] });
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });
    const { result: syncResult } = renderHook(() =>
      useWidgetRows(widget, makeDataSource(rows), 'page-1'),
    );
    expect(syncResult.current.filteredRows).toHaveLength(rows.length);

    // Async — adapter called with no effective filter; returns all rows
    studioRequestCache.clear();
    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockResolvedValue({ rows }),
    };
    const { result: asyncResult } = renderHook(() =>
      useWidgetRows(
        widget,
        makeDataSource([], { id: 'src1', adapter } as Partial<StudioDataSource>),
        'page-1',
      ),
    );
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => !asyncResult.current.isLoading);
    });
    expect(asyncResult.current.filteredRows).toHaveLength(rows.length);
  });

  it('widget-scoped filter: both paths apply it to the correct widget', async () => {
    const widgetFilter = makeFilter({
      id: 'f-widget',
      scope: { kind: 'widget', widgetId: 'w1' },
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });

    // Sync
    mockState = createState({ filters: [widgetFilter] });
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });
    const { result: syncResult } = renderHook(() =>
      useWidgetRows(widget, makeDataSource(rows), 'page-1'),
    );
    const euRows = rows.filter((r) => r.region === 'EU');
    expect(syncResult.current.filteredRows).toHaveLength(euRows.length);

    // Async — adapter returns server-filtered rows; descriptor carries the filter
    studioRequestCache.clear();
    let capturedDescriptor: Parameters<StudioDataSourceAdapter['getRows']>[0] | undefined;
    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockImplementation((descriptor) => {
        capturedDescriptor = descriptor;
        return Promise.resolve({ rows: euRows });
      }),
    };
    const { result: asyncResult } = renderHook(() =>
      useWidgetRows(
        widget,
        makeDataSource([], { id: 'src1', adapter } as Partial<StudioDataSource>),
        'page-1',
      ),
    );
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => !asyncResult.current.isLoading);
    });
    expect(asyncResult.current.filteredRows).toHaveLength(euRows.length);
    // The query descriptor must carry the widget-scoped predicate
    expect(capturedDescriptor?.filter).toBeDefined();
  });

  it('dashboard-date-range filter for widget source: both paths include it', async () => {
    const dateFilter = makeFilter({
      id: 'f-ddr',
      scope: { kind: 'dashboard-date-range', sourceId: 'src1', pageId: 'page-1' },
      field: 'saleDate',
      operator: 'between',
      value: { from: '2024-01-01', to: '2024-12-31' },
      filterSourceId: 'src1',
      fieldType: 'date',
    });

    const allRows = [
      { id: 1, region: 'EU', amount: 100, saleDate: '2024-03-15' },
      { id: 2, region: 'US', amount: 200, saleDate: '2023-06-01' },
    ];

    // Sync — only the 2024 row passes the date filter
    mockState = createState({ filters: [dateFilter] });
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });
    const { result: syncResult } = renderHook(() =>
      useWidgetRows(widget, makeDataSource(allRows), 'page-1'),
    );
    expect(syncResult.current.filteredRows).toHaveLength(1);
    expect(syncResult.current.filteredRows[0].id).toBe(1);

    // Async — adapter returns server-filtered subset
    studioRequestCache.clear();
    const serverFiltered = allRows.filter(
      (r) => r.saleDate >= '2024-01-01' && r.saleDate <= '2024-12-31',
    );
    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockResolvedValue({ rows: serverFiltered }),
    };
    const { result: asyncResult } = renderHook(() =>
      useWidgetRows(
        widget,
        makeDataSource([], { id: 'src1', adapter } as Partial<StudioDataSource>),
        'page-1',
      ),
    );
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      await vi.waitFor(() => !asyncResult.current.isLoading);
    });
    expect(asyncResult.current.filteredRows).toHaveLength(1);
  });

  it('cross-filter from another widget: filteredRows includes it, filteredRowsNoCross excludes it', () => {
    const crossFilter = makeFilter({
      id: 'f-cross',
      scope: { kind: 'cross-filter', sourceWidgetId: 'w-other', pageId: 'page-1' },
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });

    mockState = createState({ filters: [crossFilter] });
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });
    const { result } = renderHook(() => useWidgetRows(widget, makeDataSource(rows), 'page-1'));

    const euCount = rows.filter((r) => r.region === 'EU').length;
    // filteredRows includes cross-filter → only EU rows
    expect(result.current.filteredRows).toHaveLength(euCount);
    // filteredRowsNoCross excludes cross-filter → all rows
    expect(result.current.filteredRowsNoCross).toHaveLength(rows.length);
  });
});

// ── Widget-scoped rank filters are applied on the shared path (finding 2.1) ──
//
// `selectFiltersForWidget` used to unconditionally drop `filterMode === 'rank'` from the
// widget scope, and only the chart hook re-applied it post-aggregation. So a widget-scoped
// rank filter authored on a NON-chart widget (grid / KPI / map / pivot / filter) was applied
// by no data path — silently ignored. `useWidgetRows` now opts non-chart kinds into the L3
// rank reduction (`includeWidgetRank`), so it actually limits the widget's rows.
describe('widget-scoped rank filters (finding 2.1)', () => {
  const rankRows: Row[] = [
    { id: 1, region: 'EU', amount: 100 },
    { id: 2, region: 'US', amount: 300 },
    { id: 3, region: 'APAC', amount: 200 },
    { id: 4, region: 'LATAM', amount: 50 },
  ];

  function makeWidgetRankFilter(): StudioFilterState {
    return {
      id: 'f-rank',
      field: 'amount',
      filterMode: 'rank',
      value: 2,
      rankDirection: 'top',
      scope: { kind: 'widget', widgetId: 'w1' },
    } as unknown as StudioFilterState;
  }

  it('limits a non-chart (KPI) widget to the top-N rows instead of ignoring the rank filter', () => {
    mockState = createState({ filters: [makeWidgetRankFilter()] });
    // Default `makeWidget` has no `kind` → treated as non-chart → rank applied at L3.
    const widget = makeWidget({ id: 'w1' });
    const { result } = renderHook(() => useWidgetRows(widget, makeDataSource(rankRows), 'page-1'));

    // Top 2 by amount: US (300) and APAC (200).
    expect(result.current.filteredRows).toHaveLength(2);
    expect(result.current.filteredRows.map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it('does NOT apply a widget-scoped rank filter at L3 for a chart widget (it re-ranks post-aggregation)', () => {
    mockState = createState({ filters: [makeWidgetRankFilter()] });
    // A chart widget must keep all rows here — `useChartWidgetData` applies its own
    // post-aggregation rank; applying it at L3 too would double-reduce.
    const chartWidget = {
      id: 'w1',
      kind: 'chart',
      sourceId: 'src1',
      title: 'Chart',
      config: {},
    } as unknown as StudioWidget;
    const { result } = renderHook(() =>
      useWidgetRows(chartWidget, makeDataSource(rankRows), 'page-1'),
    );

    expect(result.current.filteredRows).toHaveLength(rankRows.length);
  });

  it('a DISABLED widget-scoped rank filter does not limit rows', () => {
    mockState = createState({
      filters: [{ ...makeWidgetRankFilter(), disabled: true } as unknown as StudioFilterState],
    });
    const widget = makeWidget({ id: 'w1' });
    const { result } = renderHook(() => useWidgetRows(widget, makeDataSource(rankRows), 'page-1'));

    expect(result.current.filteredRows).toHaveLength(rankRows.length);
  });

  it.each(['scatter', 'heatmap', 'funnel', 'sankey', 'gantt'] as const)(
    'applies a widget-scoped rank filter at L3 for a %s chart (no post-aggregation re-rank path)',
    (chartType) => {
      // These non-xy chart families aggregate their rows directly and never re-apply the widget
      // rank post-aggregation, so — like non-chart widgets — the rank must reduce the row set at
      // L3, or a "Top N" widget filter is silently a no-op (finding 2.1).
      mockState = createState({ filters: [makeWidgetRankFilter()] });
      const chartWidget = {
        id: 'w1',
        kind: 'chart',
        sourceId: 'src1',
        title: 'Chart',
        config: { chartType },
      } as unknown as StudioWidget;
      const { result } = renderHook(() =>
        useWidgetRows(chartWidget, makeDataSource(rankRows), 'page-1'),
      );

      // Top 2 by amount: US (300) and APAC (200).
      expect(result.current.filteredRows).toHaveLength(2);
      expect(result.current.filteredRows.map((r) => r.id).sort()).toEqual([2, 3]);
    },
  );

  it.each(['bar', 'line', 'area', 'pie', 'mixed'] as const)(
    'does NOT apply a widget-scoped rank filter at L3 for a %s chart (it re-ranks post-aggregation)',
    (chartType) => {
      mockState = createState({ filters: [makeWidgetRankFilter()] });
      const chartWidget = {
        id: 'w1',
        kind: 'chart',
        sourceId: 'src1',
        title: 'Chart',
        config: { chartType },
      } as unknown as StudioWidget;
      const { result } = renderHook(() =>
        useWidgetRows(chartWidget, makeDataSource(rankRows), 'page-1'),
      );

      expect(result.current.filteredRows).toHaveLength(rankRows.length);
    },
  );
});

// ── Related-source calculated value field enrichment on the shared path (finding 1.1) ──
//
// A related-source *calculated* (expression) column used as a map's `mapValueField` (or a
// grid column) must be L2-enriched before the cross-source join, otherwise the shared
// enrichment indexes the related source's RAW rows and copies `undefined` onto every widget
// row (blank map / spurious "No data"). `useWidgetRows` now threads `expressionFields` into
// the shared `enrichWithCrossSourceFields` call, so the calculated value resolves for every
// widget kind (map + grid) through the one shared path.
describe('related-source calculated cross-source field enrichment (finding 1.1)', () => {
  const relationship = {
    id: 'rel-orders-customers',
    type: 'many-to-one',
    sourceId: 'orders',
    sourceField: 'customerId',
    targetId: 'customers',
    targetField: 'id',
  } as unknown as StudioState['doc']['relationships'][number];

  // customers.bonus = spend * 2 — a calculated column owned by the related source.
  const bonusExpr = {
    id: 'bonus',
    label: 'Bonus',
    sourceId: 'customers',
    isMeasure: false,
    expression: { operator: 'multiply', inputs: [{ id: 'spend' }, { type: 'number', value: 2 }] },
  } as unknown as StudioState['doc']['expressionFields'][number];

  const ordersSource = makeDataSource(
    [
      { id: 'o1', customerId: 'c1', region: 'EU' },
      { id: 'o2', customerId: 'c2', region: 'US' },
    ],
    {
      id: 'orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'customerId', label: 'Customer', type: 'string' },
        { id: 'region', label: 'Region', type: 'string' },
      ],
    },
  );
  const customersSource = makeDataSource(
    [
      { id: 'c1', spend: 100 },
      { id: 'c2', spend: 50 },
    ],
    {
      id: 'customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'spend', label: 'Spend', type: 'number' },
      ],
    },
  );

  function makeMapWidget(): StudioWidget {
    return {
      id: 'map-1',
      kind: 'map',
      sourceId: 'orders',
      title: 'Map',
      config: {
        mapGeography: 'world',
        mapCountryField: 'region',
        mapValueField: 'bonus',
        mapValueSourceId: 'customers',
      },
    } as unknown as StudioWidget;
  }

  it('resolves a related-source calculated map value field (bonus = spend * 2) instead of undefined', () => {
    mockState = createState({
      dataSources: { orders: ordersSource, customers: customersSource },
      relationships: [relationship],
      expressionFields: [bonusExpr],
    });
    const { result } = renderHook(() => useWidgetRows(makeMapWidget(), ordersSource, 'page-1'));

    const byId = new Map(result.current.filteredRows.map((r) => [r.id, r.bonus]));
    // o1 → c1 spend 100 → bonus 200; o2 → c2 spend 50 → bonus 100.
    expect(byId.get('o1')).toBe(200);
    expect(byId.get('o2')).toBe(100);
  });

  it('also resolves the same related-source calculated column when used as a grid column', () => {
    const gridWidget = {
      id: 'grid-1',
      kind: 'grid',
      sourceId: 'orders',
      title: 'Grid',
      config: { columns: [{ fieldId: 'id' }, { fieldId: 'bonus', sourceId: 'customers' }] },
    } as unknown as StudioWidget;
    mockState = createState({
      dataSources: { orders: ordersSource, customers: customersSource },
      relationships: [relationship],
      expressionFields: [bonusExpr],
    });
    const { result } = renderHook(() => useWidgetRows(gridWidget, ordersSource, 'page-1'));

    const byId = new Map(result.current.filteredRows.map((r) => [r.id, r.bonus]));
    expect(byId.get('o1')).toBe(200);
    expect(byId.get('o2')).toBe(100);
  });
});

// ── usedFieldIds cache-key scoping (Tier 3 #5 / architecture review item 4) ──
//
// `usedFieldIds` must be derived only from filters that can actually reach this
// widget (its own page's page filters, its OWN widget-scoped filters, and
// cross/interactive filters). A filter on a different page, or a widget-scoped
// filter belonging to a DIFFERENT widget, must never widen this widget's field
// set — doing so would change the content-based cache key that
// `getCachedNormalizedDataSource` / `resolveRowsCached` key off of, forcing an
// unnecessary re-normalization/re-enrichment/re-resolution pass even though the
// filter could never apply to this widget.
describe('usedFieldIds cache-key scoping', () => {
  it('a page filter on a DIFFERENT page does not change this widget cache key', () => {
    // Stable references across both mockState assignments — the underlying
    // content-based caches gate on these object identities, so recreating them
    // on every mockState reassignment would defeat the cache hit this test
    // observes.
    const stableDataSources = { src1: makeDataSource(rows) };
    const stableRelationships: StudioState['doc']['relationships'] = [];
    const stableExpressionFields: StudioState['doc']['expressionFields'] = [];
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });

    mockState = createState({
      dataSources: stableDataSources,
      relationships: stableRelationships,
      expressionFields: stableExpressionFields,
      filters: [],
    });
    const { result, rerender } = renderHook(() =>
      useWidgetRows(widget, stableDataSources.src1, 'page-1'),
    );
    const firstFilteredRows = result.current.filteredRows;
    expect(firstFilteredRows).toHaveLength(3);

    // Add a page-scoped filter for a completely different page, referencing a
    // field this widget never uses. Before the fix, this field would still be
    // folded into `usedFieldIds` (derived from the raw, dashboard-wide filters
    // array), changing the cache key and forcing a fresh (if value-equal) array.
    mockState = createState({
      dataSources: stableDataSources,
      relationships: stableRelationships,
      expressionFields: stableExpressionFields,
      filters: [
        makeFilter({
          id: 'f-other-page',
          scope: { kind: 'page', pageId: 'page-2' },
          field: 'unrelatedField',
          operator: 'equals',
          value: 'x',
        }),
      ],
    });
    rerender();

    expect(result.current.filteredRows).toBe(firstFilteredRows);
  });

  it('a widget-scoped filter belonging to a DIFFERENT widget does not change this widget cache key', () => {
    const stableDataSources = { src1: makeDataSource(rows) };
    const stableRelationships: StudioState['doc']['relationships'] = [];
    const stableExpressionFields: StudioState['doc']['expressionFields'] = [];
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });

    mockState = createState({
      dataSources: stableDataSources,
      relationships: stableRelationships,
      expressionFields: stableExpressionFields,
      filters: [],
    });
    const { result, rerender } = renderHook(() =>
      useWidgetRows(widget, stableDataSources.src1, 'page-1'),
    );
    const firstFilteredRows = result.current.filteredRows;
    expect(firstFilteredRows).toHaveLength(3);

    // Widget-scoped filter owned by a DIFFERENT widget ('w-other'), referencing a
    // field this widget never uses — can never apply to `widget` ('w1').
    mockState = createState({
      dataSources: stableDataSources,
      relationships: stableRelationships,
      expressionFields: stableExpressionFields,
      filters: [
        makeFilter({
          id: 'f-other-widget',
          scope: { kind: 'widget', widgetId: 'w-other' },
          field: 'unrelatedField',
          operator: 'equals',
          value: 'x',
        }),
      ],
    });
    rerender();

    expect(result.current.filteredRows).toBe(firstFilteredRows);
  });
});

// ── Deferred window: enrichment field set tracks the DEFERRED filters (finding 2.1) ──
//
// Row filtering consumes `deferredPartitioned`, but `usedFieldIds` (the enrichment field
// set / cache-key segment) used to be derived from the LIVE `partitioned`. During the
// deferred window, removing a filter whose field is an expression field used ONLY by that
// filter dropped the field from `usedFieldIds` on the urgent render, while the still-deferred
// row filtering evaluated that filter against rows no longer enriched for the field — a
// transient flash-to-blank frame plus a guaranteed cache miss. Deriving the field set from
// `deferredPartitioned` keeps enrichment in lockstep with what filtering actually references.
describe('deferred window enrichment field set (finding 2.1)', () => {
  // doubleAmount = amount * 2 — an expression field used ONLY by the filter below (never by
  // the widget's own config), so it enters `usedFieldIds` solely because of that filter.
  const doubleExpr = {
    id: 'doubleAmount',
    label: 'Double',
    sourceId: 'src1',
    isMeasure: false,
    expression: { operator: 'multiply', inputs: [{ id: 'amount' }, { type: 'number', value: 2 }] },
  } as unknown as StudioState['doc']['expressionFields'][number];

  // amount: 100 → 200, 200 → 400, 150 → 300. Filter doubleAmount > 250 keeps ids 2 and 3.
  const exprFilter = makeFilter({
    id: 'f-expr',
    scope: { kind: 'page' },
    field: 'doubleAmount',
    operator: 'greater_than',
    value: 250,
  });

  it('removing an expression-field-only filter never flashes a blank/stale frame and keeps the cache stable', () => {
    // Stable references for every non-filter slice of state (mirrors the `usedFieldIds
    // cache-key scoping` tests): only `filters` changes across the two `mockState`
    // assignments, so the resolved-rows cache entry stays valid and a genuine cache HIT is
    // observable by reference. Recreating these on each `createState` would invalidate the
    // entry for reasons unrelated to the field set under test.
    const dataSource = makeDataSource(rows, {
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
    });
    const stableDataSources = { src1: dataSource };
    const stableRelationships: StudioState['doc']['relationships'] = [];
    const stableExpressionFields = [doubleExpr];
    // KPI widget with an empty config → its own field set never includes doubleAmount.
    const widget = makeWidget({ id: 'w1', kind: 'kpi', config: {} } as Partial<StudioWidget>);

    const renders: Row[][] = [];
    function Probe() {
      const r = useWidgetRows(widget, dataSource, 'page-1');
      renders.push(r.filteredRows);
      return null;
    }

    mockState = createState({
      dataSources: stableDataSources,
      relationships: stableRelationships,
      expressionFields: stableExpressionFields,
      filters: [exprFilter],
    });
    const { rerender } = render(React.createElement(Probe));

    // Steady state with the filter: doubleAmount > 250 keeps 2 rows.
    const beforeRemoval = renders[renders.length - 1];
    expect(beforeRemoval).toHaveLength(2);

    // Remove the filter and capture EVERY commit through the deferred window.
    renders.length = 0;
    mockState = createState({
      dataSources: stableDataSources,
      relationships: stableRelationships,
      expressionFields: stableExpressionFields,
      filters: [],
    });
    // eslint-disable-next-line testing-library/no-unnecessary-act
    act(() => {
      rerender(React.createElement(Probe));
    });

    // No committed frame is blank/stale: with the bug the urgent commit dropped doubleAmount
    // from the enrichment set while the deferred filter still evaluated against it → 0 rows.
    expect(renders.every((rs) => rs.length > 0)).toBe(true);

    // The intermediate (urgent) commit still reflects the deferred filter, and because the
    // enrichment field set is unchanged, it is served from cache — the SAME reference as
    // before removal (no cache miss / re-resolution).
    expect(renders[0]).toBe(beforeRemoval);
    expect(renders[0]).toHaveLength(2);

    // Once the deferred value catches up, the filter is gone → all rows.
    expect(renders[renders.length - 1]).toHaveLength(3);
  });
});

// ── Deferred fast-path covers interactive-filter clears too (finding 3.2) ──
//
// Removing a cross-filter uses the live value immediately (the extra deferred cycle makes
// removal feel sluggish and the recompute is cheap). Clearing an INTERACTIVE (filter-widget)
// selection has the identical rationale, so it must take the same fast path instead of lagging
// through the deferred window.
describe('deferred fast-path for interactive clears (finding 3.2)', () => {
  it('clearing an interactive filter reflects the removal in the first commit (no deferred lag)', () => {
    const dataSource = makeDataSource(rows);
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });

    const interactiveFilter = makeFilter({
      id: 'f-interactive',
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget', pageId: 'page-1' },
      field: 'region',
      operator: 'equals',
      value: 'EU',
      filterMode: 'condition',
    });

    const renders: Row[][] = [];
    function Probe() {
      const r = useWidgetRows(widget, dataSource, 'page-1');
      renders.push(r.filteredRows);
      return null;
    }

    mockState = createState({
      dataSources: { src1: dataSource },
      filters: [interactiveFilter],
    });
    const { rerender } = render(React.createElement(Probe));

    // Filter active: 2 EU rows.
    expect(renders[renders.length - 1]).toHaveLength(2);

    // Clear the interactive filter.
    renders.length = 0;
    mockState = createState({ dataSources: { src1: dataSource }, filters: [] });
    // eslint-disable-next-line testing-library/no-unnecessary-act
    act(() => {
      rerender(React.createElement(Probe));
    });

    // Fast path: the very first commit after the clear already shows all 3 rows. Without the
    // interactive branch in the fast-path condition, the urgent commit would still hold the
    // deferred (filtered) value → 2 rows → a sluggish lag before catching up.
    expect(renders[0]).toHaveLength(3);
    expect(renders[renders.length - 1]).toHaveLength(3);
  });
});
