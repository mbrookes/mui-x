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
import { renderHook, waitFor } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { StudioState } from '../../../models';
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

function mockFetch(ssePayload: Uint8Array) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(ssePayload);
          ctrl.close();
        },
      }),
    }),
  );
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

    renderHook(() => useTextWidgetAI('text-1', 'Summarize this page'), { wrapper });

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

    const { result } = renderHook(() => useTextWidgetAI('text-1', 'Say hello'), { wrapper });

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

    const { result } = renderHook(() => useTextWidgetAI('text-1', 'Say hello'), { wrapper });

    await waitFor(() => {
      expect(result.current.error).toBe('Something broke');
    });
    expect(result.current.loading).toBe(false);
  });

  // ─── Cache: dead `hash` field removed, unbounded growth capped (finding 3.6) ─

  it('does not write a redundant `hash` field into the cached localStorage entry', async () => {
    mockFetch(makeSseBody([{ type: 'text-delta', delta: 'Hello' }, { type: 'finish' }]));
    const wrapper = setup();

    const { result } = renderHook(() => useTextWidgetAI('text-1', 'Say hello'), { wrapper });

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

    const { result } = renderHook(() => useTextWidgetAI('text-1', 'Say hello'), { wrapper });

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
});
