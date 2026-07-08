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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@mui/internal-test-utils';
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

    // Pre-populate the cache with data
    const cachedRows: Row[] = [{ id: 'cached', region: 'EU' }];
    const { buildQueryDescriptor } = await import('./queryDescriptor');
    const descriptor = buildQueryDescriptor(widget, [], 'page-1');
    studioRequestCache.set(descriptor.cacheKey, { rows: cachedRows });

    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const dataSource = makeDataSource([], { adapter });

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
    mockState = buildState(false);
    const { result: resultOff, unmount: unmountOff } = renderHook(() =>
      useWidgetRows(widget, makeAdapterSource(), 'page-1'),
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
    const { result: resultOn, unmount: unmountOn } = renderHook(() =>
      useWidgetRows(widget, makeAdapterSource(), 'page-1'),
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

  it('does not stay stuck loading when the descriptor changes to a cached one before the first fetch resolves', async () => {
    // Regression: descriptor A misses the cache → isLoading becomes true with an in-flight
    // fetch. Before A resolves, the descriptor switches to B, which IS already cached. A's
    // effect cleanup marks its (never-resolving) promise cancelled, so its `.then` never
    // runs; the B branch serves the cached result synchronously. That synchronous cache-hit
    // branch must reset isLoading — otherwise the loading overlay stays true forever even
    // though valid data is already rendered.
    const { buildQueryDescriptor } = await import('./queryDescriptor');
    const widget = makeWidget({ id: 'w1', sourceId: 'src1' });

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
    studioRequestCache.set(descriptorB.cacheKey, { rows: [{ id: 'cached-B', region: 'EU' }] });

    // State A — no filters → descriptor A, NOT cached → an in-flight fetch that never resolves.
    mockState = createState({ filters: [] });
    const neverResolves = new Promise<StudioQueryResult>(() => {});
    const adapter: StudioDataSourceAdapter = {
      getRows: vi.fn().mockReturnValue(neverResolves),
    };
    const dataSource = makeDataSource([], { adapter });

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
