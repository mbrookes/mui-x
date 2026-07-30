/**
 * Regression coverage for finding #7 (architecture review): `useTextWidgetAI`
 * used to hand-roll its own copy of `StudioChatPanel/studioBackendAdapter.ts`'s
 * dashboard-state-stripping serialization and its own `data:`-line SSE parse
 * loop, with a lower-fidelity `source as unknown as {...}` cast where the
 * adapter had a properly typed destructure. It now imports
 * `serializeDashboardState`/`parseSSEStream` from `StudioChatPanel/sseUtils.ts`.
 *
 * These tests exercise the hook end-to-end (mocked `fetch`) to prove the shared
 * helpers are actually wired in: the request body must have `rows`/`adapter`
 * stripped from `dataSources`, and the hook must correctly consume an SSE stream
 * built the same way `studioBackendAdapter.test.ts` builds one.
 */
import * as React from 'react';
import { renderHook, waitFor, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioState,
  StudioWidgetOf,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import {
  StudioUIConfigContext,
  DEFAULT_STUDIO_LOCALE_TEXT,
} from '../../../internals/StudioUIConfigContext';
import { useTextWidgetAI } from './useTextWidgetAI';

function makeSseBody(events: object[]): Uint8Array {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new TextEncoder().encode(text);
}

function sseResponse(ssePayload: Uint8Array) {
  return {
    ok: true,
    body: new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(ssePayload);
        ctrl.close();
      },
    }),
  };
}

function mockFetch(ssePayload: Uint8Array) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(ssePayload)));
}

/**
 * Stubs `fetch` to return a fresh single-use SSE stream on each call, in order —
 * needed for tests that expect the hook to issue more than one `/chat` request
 * (a plain `mockResolvedValue` would hand out the same already-consumed
 * `ReadableStream` reference to every call).
 */
function mockFetchSequence(ssePayloads: Uint8Array[]) {
  const fn = vi.fn();
  for (const payload of ssePayloads) {
    fn.mockResolvedValueOnce(sseResponse(payload));
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

function setup(initialState: Partial<StudioState> = {}) {
  const { wrapper: StudioWrapper } = createStudioHarness({ initialState });
  // Stable references across re-renders: `aiConfig` is in `useTextWidgetAI`'s effect
  // dependency array, so recreating this object on every render (e.g. from an inline
  // object literal in `wrapper`) would re-run the effect mid-stream — starting a
  // second `fetch()` against the same single-use mock `ReadableStream`.
  const uiConfigValue = {
    tableSourceMode: 'explicit' as const,
    featureFlags: {},
    localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    aiConfig: { endpoint: 'https://fake.test/api/ai' },
  };
  function wrapper(props: { children?: React.ReactNode }) {
    return (
      <StudioWrapper>
        <StudioUIConfigContext.Provider value={uiConfigValue}>
          {props.children}
        </StudioUIConfigContext.Provider>
      </StudioWrapper>
    );
  }
  return wrapper;
}

/**
 * Like {@link setup}, but also returns the backing `StudioController` so a test
 * can drive mutations (`updateWidget`, `setDataSourceRows`, ...) after the hook
 * has already rendered — needed to prove the snapshot memo reacts to them.
 */
function setupWithController(initialState: CreateDefaultStudioStateOverrides = {}) {
  const { controller, wrapper: StudioWrapper } = createStudioHarness({ initialState });
  const uiConfigValue = {
    tableSourceMode: 'explicit' as const,
    featureFlags: {},
    localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    aiConfig: { endpoint: 'https://fake.test/api/ai' },
  };
  function wrapper(props: { children?: React.ReactNode }) {
    return (
      <StudioWrapper>
        <StudioUIConfigContext.Provider value={uiConfigValue}>
          {props.children}
        </StudioUIConfigContext.Provider>
      </StudioWrapper>
    );
  }
  return { controller, wrapper };
}

beforeEach(() => {
  // `useTextWidgetAI` caches by a hash of `prompt + pageSnapshot` in `localStorage`.
  // Several tests below use the same widgetId/prompt against an empty page (so the
  // same cache key) — without clearing, a later test would silently short-circuit
  // on the previous test's cached result and never call `fetch` at all.
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useTextWidgetAI', () => {
  it('strips rows and adapter from dataSources before sending the request body', async () => {
    const sse = makeSseBody([{ type: 'text-delta', delta: 'Hello' }, { type: 'finish' }]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(sse);
          ctrl.close();
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapterStub = { getRows: vi.fn() };
    const wrapper = setup({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: [{ amount: 100 }],
            adapter: adapterStub as never,
          },
        },
      },
    });

    renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Summarize this page'), { wrapper });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://fake.test/api/ai/chat');
    const body = JSON.parse(String(init.body)) as {
      dashboardState: { runtime: { dataSources: Record<string, Record<string, unknown>> } };
    };
    const src1 = body.dashboardState.runtime.dataSources.src1;
    expect(src1).not.toHaveProperty('rows');
    expect(src1).not.toHaveProperty('adapter');
    expect(src1.id).toBe('src1');
  });

  it('accumulates text-delta events from the SSE stream into markdown', async () => {
    mockFetch(
      makeSseBody([
        { type: 'text-delta', delta: 'Hello' },
        { type: 'text-delta', delta: ' world' },
        { type: 'finish' },
      ]),
    );
    const wrapper = setup();

    const { result } = renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Say hello'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.markdown).toBe('Hello world');
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(null);
  });

  it('stops consuming the stream and surfaces an error on an SSE error event', async () => {
    mockFetch(
      makeSseBody([
        { type: 'text-delta', delta: 'partial' },
        { type: 'error', message: 'Something broke' },
      ]),
    );
    const wrapper = setup();

    const { result } = renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Say hello'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Something broke');
    });
    expect(result.current.loading).toBe(false);
  });

  // ─── Cache: dead `hash` field removed, unbounded growth capped (finding 3.6) ─

  it('does not write a redundant `hash` field into the cached localStorage entry', async () => {
    mockFetch(makeSseBody([{ type: 'text-delta', delta: 'Hello' }, { type: 'finish' }]));
    const wrapper = setup();

    const { result } = renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Say hello'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.markdown).toBe('Hello');
    });

    const cacheKeys = Object.keys(localStorage).filter((k) => k.startsWith('studio:textAI:v1:'));
    expect(cacheKeys).toHaveLength(1);
    const entry = JSON.parse(localStorage.getItem(cacheKeys[0])!) as Record<string, unknown>;
    // Only the fields the cache actually reads back should be persisted — the
    // hash is already embedded in the key itself, so a separate `hash` field
    // would be dead weight.
    expect(entry).not.toHaveProperty('hash');
    expect(entry.markdown).toBe('Hello');
  });

  // ── Empty completion handling ───────────────────────────────────────────────
  //
  // A stream that finished without a single `text-delta` used to be written to the cache as
  // `''`, which the read path's `if (cached)` truthiness check then treated as a MISS. The
  // widget rendered blank and re-fetched on every mount, forever — unable to escape the very
  // entry it had just written. An empty completion is now surfaced as an error and never
  // cached, and the read path distinguishes "no entry" from a stored value.
  it('surfaces an empty completion as an error instead of a blank widget', async () => {
    mockFetch(makeSseBody([{ type: 'finish' }]));
    const wrapper = setup();

    const { result } = renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Say hello'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.error).not.toBe(null);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.markdown).toBe(null);
  });

  it('does not cache an empty completion', async () => {
    mockFetch(makeSseBody([{ type: 'finish' }]));
    const wrapper = setup();

    const { result } = renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Say hello'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.error).not.toBe(null);
    });

    expect(Object.keys(localStorage).filter((k) => k.startsWith('studio:textAI:v1:'))).toHaveLength(
      0,
    );
  });

  it('evicts the oldest entries once the cache exceeds its entry cap, instead of growing unbounded', async () => {
    // Pre-seed 60 stale entries under the same namespace the hook writes to,
    // each with a distinct, increasing `createdAt` so eviction order is
    // deterministic (oldest — lowest `createdAt` — first).
    const STALE_COUNT = 60;
    for (let i = 0; i < STALE_COUNT; i += 1) {
      localStorage.setItem(
        `studio:textAI:v1:stale-dashboard:stale-page:stale-widget:hash-${i}`,
        JSON.stringify({ markdown: `stale-${i}`, createdAt: i }),
      );
    }

    mockFetch(makeSseBody([{ type: 'text-delta', delta: 'Fresh' }, { type: 'finish' }]));
    const wrapper = setup();

    const { result } = renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Say hello'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.markdown).toBe('Fresh');
    });

    const cacheKeys = Object.keys(localStorage).filter((k) => k.startsWith('studio:textAI:v1:'));
    // 60 stale + 1 fresh = 61, capped down to 50.
    expect(cacheKeys.length).toBe(50);
    // The oldest stale entries (lowest `createdAt`) were evicted first...
    expect(
      localStorage.getItem('studio:textAI:v1:stale-dashboard:stale-page:stale-widget:hash-0'),
    ).toBe(null);
    // ...while the newest stale entries and the just-written fresh entry survive.
    expect(
      localStorage.getItem('studio:textAI:v1:stale-dashboard:stale-page:stale-widget:hash-59'),
    ).not.toBe(null);
    const freshKey = cacheKeys.find((k) => k.includes('text-1'));
    expect(freshKey).toBeDefined();
  });

  // ─── Manual refresh no longer permanently disables the cache (finding 3.7) ──
  //
  // `refreshSeq` used to only ever increment and never reset, so the cache-read
  // fast path (`if (refreshSeq === 0) { ... }`) was gated off for the rest of the
  // hook's mount lifetime after a single `refresh()` click — even once `cacheKey`
  // moved on to an unrelated page/filter/prompt change with its own valid cache
  // entry. This test drives exactly that sequence: refresh once, change the
  // cache key (via a sibling widget title edit, cache miss, real fetch), then
  // change back to the original cache key (a cache HIT) and assert no further
  // network request goes out.
  it('does not skip a valid cache entry for a different cacheKey after a manual refresh', async () => {
    const { controller, wrapper } = setupWithController({
      doc: {
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['grid-1']] },
        },
        widgets: {
          'grid-1': makeGridWidget('Original Title'),
        },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Src1',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: [{ amount: 100 }],
          },
        },
      },
    });

    const fetchMock = mockFetchSequence([
      makeSseBody([{ type: 'text-delta', delta: 'First' }, { type: 'finish' }]),
      makeSseBody([{ type: 'text-delta', delta: 'Second' }, { type: 'finish' }]),
      makeSseBody([{ type: 'text-delta', delta: 'ThirdViaRefresh' }, { type: 'finish' }]),
    ]);

    const { result } = renderHook(
      () => useTextWidgetAI('text-1', 'page-1', 'Summarize this page'),
      {
        wrapper,
      },
    );

    // 1. Initial fetch at cacheKey A (title "Original Title").
    await waitFor(() => {
      expect(result.current.markdown).toBe('First');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2. Manual refresh while still at cacheKey A: bypasses the (valid) cache on
    //    purpose and overwrites the cache entry for A with the fresh content.
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.markdown).toBe('Second');
    });

    // 3. Move to cacheKey B (different sibling-widget title -> different page
    //    snapshot -> different hash). No cache entry exists yet for B, so this is
    //    a legitimate cache miss and fetches from the network either way.
    act(() => {
      controller.updateWidget('grid-1', { title: 'Renamed Title' });
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(result.current.markdown).toBe('ThirdViaRefresh');
    });

    // 4. Move back to cacheKey A. A valid cache entry exists for A (written in
    //    step 2: "Second"). Before the fix, `refreshSeq` never reset, so this
    //    would incorrectly skip the cache and issue a 4th network request (which
    //    would fail here, since only 3 mock responses were queued). After the
    //    fix, `cacheKey` changing away from and back to A resets `{seq, forKey}`,
    //    so the cache is consulted again and no further fetch happens.
    act(() => {
      controller.updateWidget('grid-1', { title: 'Original Title' });
    });
    await waitFor(() => {
      expect(result.current.markdown).toBe('Second');
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // ─── Snapshot memo reactivity (finding 3.15) ────────────────────────────────
  //
  // The memo computing `snapshot`/`hash`/`cacheKey` used to depend only on
  // `activePage`/`dashboard` identity — but `buildPageSnapshot` actually reads
  // sibling widget configs from `doc.widgets` and row data from
  // `runtime.dataSources`, neither of which changes `activePage`/`dashboard`
  // identity. So a sibling-widget config edit or a `setDataSourceRows`/
  // `upsertDataSource` call left the memo (and its cached markdown) stale until a
  // manual `refresh()`. These tests drive real controller mutations after the
  // hook has rendered and assert a second `/chat` request goes out reflecting
  // the change.
  function makeGridWidget(title: string): StudioWidgetOf<'grid'> {
    return {
      id: 'grid-1',
      kind: 'grid',
      title,
      sourceId: 'src1',
      config: { columns: [{ fieldId: 'amount' }] },
    };
  }

  describe('snapshot memo reactivity to widget/data changes', () => {
    it('recomputes the page snapshot when a sibling widget config changes', async () => {
      const { controller, wrapper } = setupWithController({
        doc: {
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['grid-1']] },
          },
          widgets: {
            'grid-1': makeGridWidget('Original Title'),
          },
        },
        runtime: {
          dataSources: {
            src1: {
              id: 'src1',
              label: 'Src1',
              fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
              rows: [{ amount: 100 }],
            },
          },
        },
      });

      const fetchMock = mockFetchSequence([
        makeSseBody([{ type: 'text-delta', delta: 'First' }, { type: 'finish' }]),
        makeSseBody([{ type: 'text-delta', delta: 'Second' }, { type: 'finish' }]),
      ]);

      const { result } = renderHook(
        () => useTextWidgetAI('text-1', 'page-1', 'Summarize this page'),
        {
          wrapper,
        },
      );

      await waitFor(() => {
        expect(result.current.markdown).toBe('First');
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
        pageSnapshot?: string;
      };
      expect(firstBody.pageSnapshot).toContain('Original Title');

      act(() => {
        controller.updateWidget('grid-1', { title: 'Renamed Title' });
      });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(result.current.markdown).toBe('Second');
      });
      const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1].body)) as {
        pageSnapshot?: string;
      };
      expect(secondBody.pageSnapshot).toContain('Renamed Title');
      expect(secondBody.pageSnapshot).not.toBe(firstBody.pageSnapshot);
    });

    it('recomputes the page snapshot when runtime data-source rows change', async () => {
      const { controller, wrapper } = setupWithController({
        doc: {
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['grid-1']] },
          },
          widgets: {
            'grid-1': makeGridWidget('Grid'),
          },
        },
        runtime: {
          dataSources: {
            src1: {
              id: 'src1',
              label: 'Src1',
              fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
              rows: [{ amount: 100 }],
            },
          },
        },
      });

      const fetchMock = mockFetchSequence([
        makeSseBody([{ type: 'text-delta', delta: 'First' }, { type: 'finish' }]),
        makeSseBody([{ type: 'text-delta', delta: 'Second' }, { type: 'finish' }]),
      ]);

      const { result } = renderHook(
        () => useTextWidgetAI('text-1', 'page-1', 'Summarize this page'),
        {
          wrapper,
        },
      );

      await waitFor(() => {
        expect(result.current.markdown).toBe('First');
      });
      const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
        pageSnapshot?: string;
      };
      expect(firstBody.pageSnapshot).toContain('100');

      act(() => {
        controller.setDataSourceRows('src1', [{ amount: 999 }]);
      });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(result.current.markdown).toBe('Second');
      });
      const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1].body)) as {
        pageSnapshot?: string;
      };
      expect(secondBody.pageSnapshot).toContain('999');
      expect(secondBody.pageSnapshot).not.toContain('100');
    });

    // ─── Snapshot memo reactivity to filter changes (finding 1.5) ──────────────
    //
    // `buildPageSnapshot` runs sibling widgets through the data pipeline (L3 scoped
    // filters), so the summary it produces depends on `doc.filters` — a partition
    // that does NOT change `activePage`/`dashboard` identity. Before the fix, adding
    // a page filter re-rendered every sibling widget filtered but left this hook's
    // memoized snapshot (and its cached markdown) describing the unfiltered numbers,
    // and a manual `refresh()` just resent the same stale snapshot. This test drives
    // a real `addFilter` and asserts a second `/chat` request goes out reflecting the
    // now-filtered data.
    it('recomputes the page snapshot when a page filter is added', async () => {
      const { controller, wrapper } = setupWithController({
        doc: {
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['grid-1']] },
          },
          widgets: {
            'grid-1': makeGridWidget('Grid'),
          },
        },
        runtime: {
          dataSources: {
            src1: {
              id: 'src1',
              label: 'Src1',
              fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
              rows: [{ amount: 100 }, { amount: 999 }],
            },
          },
        },
      });

      const fetchMock = mockFetchSequence([
        makeSseBody([{ type: 'text-delta', delta: 'First' }, { type: 'finish' }]),
        makeSseBody([{ type: 'text-delta', delta: 'Second' }, { type: 'finish' }]),
      ]);

      const { result } = renderHook(
        () => useTextWidgetAI('text-1', 'page-1', 'Summarize this page'),
        {
          wrapper,
        },
      );

      await waitFor(() => {
        expect(result.current.markdown).toBe('First');
      });
      const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
        pageSnapshot?: string;
      };
      // Both rows described before any filter is applied.
      expect(firstBody.pageSnapshot).toContain('100');
      expect(firstBody.pageSnapshot).toContain('999');

      act(() => {
        controller.addFilter({
          id: 'flt-1',
          field: 'amount',
          operator: 'equals',
          value: 100,
          scope: { kind: 'page' },
        });
      });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(result.current.markdown).toBe('Second');
      });
      const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1].body)) as {
        pageSnapshot?: string;
      };
      // The filtered-out row (999) no longer appears; the kept row (100) still does.
      expect(secondBody.pageSnapshot).toContain('100');
      expect(secondBody.pageSnapshot).not.toContain('999');
      expect(secondBody.pageSnapshot).not.toBe(firstBody.pageSnapshot);
    });
  });

  // ─── Page scoping: widget's own page, not the dashboard's active page (finding 2.x) ──
  //
  // `buildPageSnapshot` used to read `dashboard.activePageId` — the dashboard-wide
  // active page — instead of the text widget's OWN page. On a multi-page dashboard
  // this meant: (1) a widget living on a non-active page snapshotted the WRONG
  // page's sibling-widget data, and (2) every text widget across every page shared
  // the same `activePageId` dependency, so switching pages recomputed (and
  // re-fetched) ALL of them at once instead of only the widget(s) on the newly
  // active page. These tests set up two pages with distinguishing sibling data and
  // assert the hook always describes the page passed in as `pageId`, regardless of
  // which page is dashboard-active.
  describe('page scoping', () => {
    it('snapshots the widget-own page even when a different page is dashboard-active', async () => {
      const { wrapper } = setupWithController({
        doc: {
          // No `dashboard` override needed — `page-1` is already the harness default
          // `activePageId`, which is exactly the point: it stays dashboard-active while
          // `text-1` lives on `page-2`.
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['grid-active']] },
            'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['grid-own', 'text-1']] },
          },
          widgets: {
            'grid-active': makeGridWidget('Active Page Grid'),
            'grid-own': { ...makeGridWidget('Own Page Grid'), id: 'grid-own', sourceId: 'src2' },
          },
        },
        runtime: {
          dataSources: {
            src1: {
              id: 'src1',
              label: 'Src1',
              fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
              rows: [{ amount: 111 }],
            },
            src2: {
              id: 'src2',
              label: 'Src2',
              fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
              rows: [{ amount: 222 }],
            },
          },
        },
      });

      const fetchMock = mockFetchSequence([
        makeSseBody([{ type: 'text-delta', delta: 'Done' }, { type: 'finish' }]),
      ]);

      // `text-1` lives on `page-2`, but `page-1` is dashboard-active.
      const { result } = renderHook(
        () => useTextWidgetAI('text-1', 'page-2', 'Summarize this page'),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.markdown).toBe('Done');
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
        pageSnapshot?: string;
      };
      // Describes the widget's OWN page (page-2 / grid-own / 222) ...
      expect(body.pageSnapshot).toContain('Own Page Grid');
      expect(body.pageSnapshot).toContain('222');
      // ... never the dashboard-active page (page-1 / grid-active / 111).
      expect(body.pageSnapshot).not.toContain('Active Page Grid');
      expect(body.pageSnapshot).not.toContain('111');
    });

    it('does not refetch when the dashboard-active page changes but the widget-own page does not', async () => {
      const { controller, wrapper } = setupWithController({
        doc: {
          // No `dashboard` override needed — `page-1` is already the harness default
          // `activePageId`, which is exactly the point: it stays dashboard-active while
          // `text-1` lives on `page-2`.
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] },
            'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['grid-own', 'text-1']] },
          },
          widgets: {
            'grid-own': { ...makeGridWidget('Own Page Grid'), id: 'grid-own' },
          },
        },
        runtime: {
          dataSources: {
            src1: {
              id: 'src1',
              label: 'Src1',
              fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
              rows: [{ amount: 222 }],
            },
          },
        },
      });

      const fetchMock = mockFetchSequence([
        makeSseBody([{ type: 'text-delta', delta: 'Done' }, { type: 'finish' }]),
      ]);

      const { result } = renderHook(
        () => useTextWidgetAI('text-1', 'page-2', 'Summarize this page'),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.markdown).toBe('Done');
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Switching the dashboard's active page must not, by itself, trigger a
      // recompute/refetch for a widget whose OWN page hasn't changed — this is
      // exactly the "N redundant LLM calls on every page switch" symptom the fix
      // eliminates.
      act(() => {
        controller.setActivePage('page-1');
      });

      // Give any (incorrect) effect a chance to fire before asserting it didn't.
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Tool-approval auto-approve guard (finding 3.15) ────────────────────────
  //
  // The hook has no approval UI (unlike the main chat panel's confirmation card),
  // so it used to blindly POST `{ approved: true }` for ANY `tool-approval-request`
  // event — safe only as long as the server itself enforces the `allowedTools`
  // restriction the request declared. These tests assert the client-side guard:
  // approve only when the request's own `toolName` is in the read-only allowlist
  // this hook actually sent, and withhold approval otherwise.
  describe('tool-approval-request auto-approve guard', () => {
    it('approves a tool-approval-request for an allowed read-only tool', async () => {
      const approvalFetchCalls: [string, RequestInit][] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string, init: RequestInit) => {
          if (url.endsWith('/approval')) {
            approvalFetchCalls.push([url, init]);
            return Promise.resolve({ ok: true, body: null });
          }
          return Promise.resolve(
            sseResponse(
              makeSseBody([
                {
                  type: 'tool-approval-request',
                  toolCallId: 'call-1',
                  toolName: 'query_data_source',
                },
                { type: 'text-delta', delta: 'Done' },
                { type: 'finish' },
              ]),
            ),
          );
        }),
      );
      const wrapper = setup();

      const { result } = renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Say hello'), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current.markdown).toBe('Done');
      });
      expect(approvalFetchCalls).toHaveLength(1);
      const [, init] = approvalFetchCalls[0];
      const body = JSON.parse(String(init.body)) as { id: string; approved: boolean };
      expect(body).toEqual({ id: 'call-1', approved: true });
    });

    it('withholds approval for a tool-approval-request naming a tool outside the read-only allowlist', async () => {
      const approvalFetchCalls: [string, RequestInit][] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string, init: RequestInit) => {
          if (url.endsWith('/approval')) {
            approvalFetchCalls.push([url, init]);
            return Promise.resolve({ ok: true, body: null });
          }
          return Promise.resolve(
            sseResponse(
              makeSseBody([
                {
                  type: 'tool-approval-request',
                  toolCallId: 'call-2',
                  // Not in the hook's own `allowedTools` — a server that (by bug or
                  // drift) asks approval for a mutating tool must NOT get an
                  // unconditional rubber stamp from this headless caller.
                  toolName: 'remove_widget',
                },
                { type: 'text-delta', delta: 'Done' },
                { type: 'finish' },
              ]),
            ),
          );
        }),
      );
      const wrapper = setup();

      const { result } = renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Say hello'), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current.markdown).toBe('Done');
      });
      expect(approvalFetchCalls).toHaveLength(1);
      const [, init] = approvalFetchCalls[0];
      const body = JSON.parse(String(init.body)) as { id: string; approved: boolean };
      expect(body).toEqual({ id: 'call-2', approved: false });
    });
  });

  // ─── privateMode: no row values / dashboard state leak (regression: 1.1) ────
  //
  // With `aiConfig.privateMode` on, this headless widget must not POST the full
  // serialized `dashboardState` (widget configs, field names, layout) nor the
  // `pageSnapshot` (sampled sibling-widget row values) to `/chat`, and must
  // forward `privateMode` so the server can also refuse to comply — mirroring
  // `studioBackendAdapter.ts`'s schema-only stance.
  describe('privateMode', () => {
    function setupWithAiConfig(
      initialState: CreateDefaultStudioStateOverrides,
      aiConfig: { endpoint: string; privateMode?: boolean },
    ) {
      const { wrapper: StudioWrapper } = createStudioHarness({ initialState });
      const uiConfigValue = {
        tableSourceMode: 'explicit' as const,
        featureFlags: {},
        localeText: DEFAULT_STUDIO_LOCALE_TEXT,
        aiConfig,
      };
      function wrapper(props: { children?: React.ReactNode }) {
        return (
          <StudioWrapper>
            <StudioUIConfigContext.Provider value={uiConfigValue}>
              {props.children}
            </StudioUIConfigContext.Provider>
          </StudioWrapper>
        );
      }
      return wrapper;
    }

    const pageWithSiblingGrid: CreateDefaultStudioStateOverrides = {
      doc: {
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['grid-1']] },
        },
        widgets: {
          'grid-1': makeGridWidget('Sales grid'),
        },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Src1',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: [{ amount: 12345 }],
          },
        },
      },
    };

    it('sends dashboardState and pageSnapshot when privateMode is off', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          sseResponse(makeSseBody([{ type: 'text-delta', delta: 'Hi' }, { type: 'finish' }])),
        );
      vi.stubGlobal('fetch', fetchMock);
      const wrapper = setupWithAiConfig(pageWithSiblingGrid, {
        endpoint: 'https://fake.test/api/ai',
      });

      renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Summarize this page'), { wrapper });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
        privateMode: boolean;
        dashboardState?: unknown;
        pageSnapshot?: string;
      };
      expect(body.privateMode).toBe(false);
      expect(body.dashboardState).toBeDefined();
      expect(body.pageSnapshot).toBeDefined();
      // The sibling grid's real row value is present in the leak path.
      expect(String(fetchMock.mock.calls[0][1].body)).toContain('12345');
    });

    it('omits dashboardState and pageSnapshot and forwards privateMode when on', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          sseResponse(makeSseBody([{ type: 'text-delta', delta: 'Hi' }, { type: 'finish' }])),
        );
      vi.stubGlobal('fetch', fetchMock);
      const wrapper = setupWithAiConfig(pageWithSiblingGrid, {
        endpoint: 'https://fake.test/api/ai',
        privateMode: true,
      });

      renderHook(() => useTextWidgetAI('text-1', 'page-1', 'Summarize this page'), { wrapper });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const rawBody = String(fetchMock.mock.calls[0][1].body);
      const body = JSON.parse(rawBody) as {
        privateMode: boolean;
        dashboardState?: unknown;
        pageSnapshot?: string;
      };
      expect(body.privateMode).toBe(true);
      expect(body.dashboardState).toBeUndefined();
      expect(body.pageSnapshot).toBeUndefined();
      // No sibling row value nor field name leaks into the payload.
      expect(rawBody).not.toContain('12345');
      expect(rawBody).not.toContain('Sales grid');
    });
  });
});

// ─── M15: the generation effect must not depend on the `aiConfig` OBJECT ────────
//
// `aiConfig` is a public prop passed straight through from `<Studio aiConfig={…}>` and is
// documented as (and routinely written as) an inline object literal. The architecture doc
// states the rule for the chat adapter — "No correctness property may depend on a host
// memoizing a prop" — and this effect used to list `aiConfig` itself. Any host re-render
// during the (long) generation therefore aborted the in-flight request and restarted it.
describe('useTextWidgetAI aiConfig identity churn (M15)', () => {
  /**
   * Deliberately builds a NEW `aiConfig` (and a new UI-config value) on every render, the
   * way a host writing `<Studio aiConfig={{ endpoint: '…' }} />` does. Contrast the hoisted
   * `uiConfigValue` in `setup`/`setupWithController` above, which had to be stable
   * precisely because of the defect this test pins.
   */
  function setupInlineAiConfig() {
    const { wrapper: StudioWrapper } = createStudioHarness({ initialState: {} });
    function wrapper(props: { children?: React.ReactNode }) {
      return (
        <StudioWrapper>
          <StudioUIConfigContext.Provider
            value={{
              tableSourceMode: 'explicit' as const,
              featureFlags: {},
              localeText: DEFAULT_STUDIO_LOCALE_TEXT,
              aiConfig: { endpoint: 'https://fake.test/api/ai' },
            }}
          >
            {props.children}
          </StudioUIConfigContext.Provider>
        </StudioWrapper>
      );
    }
    return wrapper;
  }

  it('does not abort and re-issue the request when the host re-renders with a fresh aiConfig', async () => {
    const fetchMock = mockFetchSequence([
      makeSseBody([{ type: 'text-delta', delta: 'First' }, { type: 'finish' }]),
      makeSseBody([{ type: 'text-delta', delta: 'Second' }, { type: 'finish' }]),
      makeSseBody([{ type: 'text-delta', delta: 'Third' }, { type: 'finish' }]),
    ]);
    const wrapper = setupInlineAiConfig();

    const { result, rerender } = renderHook(
      () => useTextWidgetAI('text-1', 'page-1', 'Summarize this page'),
      { wrapper },
    );

    // Host re-renders while the generation is in flight — a new `aiConfig` object with
    // identical contents each time.
    rerender();
    rerender();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Exactly one `/chat` request for the whole generation. With `aiConfig` in the deps,
    // each re-render tore the effect down (aborting the in-flight stream) and started a
    // new one, so the answer the user finally saw came from a later attempt — and a host
    // that re-renders often enough could restart the request indefinitely.
    const chatCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat'));
    expect(chatCalls).toHaveLength(1);
    expect(result.current.markdown).toBe('First');
  });

  it('sends the CURRENT headers on a later request, not the ones present at mount', async () => {
    const fetchMock = mockFetchSequence([
      makeSseBody([{ type: 'text-delta', delta: 'First' }, { type: 'finish' }]),
      makeSseBody([{ type: 'text-delta', delta: 'Second' }, { type: 'finish' }]),
    ]);
    const { wrapper: StudioWrapper } = createStudioHarness({ initialState: {} });
    // `headers` is the other inline object on `aiConfig`, so it is read from a latest-ref
    // rather than depended on. That must not degrade into "frozen at mount": a rotated auth
    // token has to reach the next request.
    let headers: Record<string, string> = { Authorization: 'token-1' };
    function wrapper(props: { children?: React.ReactNode }) {
      return (
        <StudioWrapper>
          <StudioUIConfigContext.Provider
            value={{
              tableSourceMode: 'explicit' as const,
              featureFlags: {},
              localeText: DEFAULT_STUDIO_LOCALE_TEXT,
              aiConfig: { endpoint: 'https://fake.test/api/ai', headers },
            }}
          >
            {props.children}
          </StudioUIConfigContext.Provider>
        </StudioWrapper>
      );
    }

    const { result, rerender } = renderHook(
      () => useTextWidgetAI('text-1', 'page-1', 'Summarize this page'),
      { wrapper },
    );
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBe(1);
    });
    expect(
      (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ Authorization: 'token-1' });

    headers = { Authorization: 'token-2' };
    rerender();
    // `refresh()` bypasses the `localStorage` cache, forcing a genuine second request.
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBe(2);
    });
    expect(
      (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ Authorization: 'token-2' });
  });

  // The catch block surfaced `err.message` verbatim, so a 500 painted the raw transport
  // string `HTTP 500` into the widget in EVERY locale — while the adjacent
  // empty-completion path one branch up renders the properly localized message.
  it('shows the localized generation error for a failed request, never the raw transport string', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' }),
      );

      const { result } = renderHook(
        () => useTextWidgetAI('text-err', 'page-1', 'Summarize this page'),
        { wrapper: setup() },
      );

      await waitFor(() => {
        expect(result.current.error).not.toBe(null);
      });
      expect(result.current.error).toBe(DEFAULT_STUDIO_LOCALE_TEXT.aiTextWidgetGenerationError);
      expect(result.current.error).not.toContain('HTTP');
      // The raw transport detail is still available to a developer, just not on screen.
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
