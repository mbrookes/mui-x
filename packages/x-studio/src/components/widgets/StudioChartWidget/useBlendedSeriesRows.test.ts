/**
 * Tests for useBlendedSeriesRows.
 *
 * Focused regression coverage for the `addInflight` call at the adapter-backed foreign
 * source fetch site (see the `studioRequestCache.addInflight` call below): it must pass
 * `descriptor.sourceId` as the third argument, matching the pattern already used in
 * `useAdapterRows.ts`. Omitting it made `StudioRequestCache` fall back to its legacy
 * first-colon parse of the cacheKey to resolve the entry's sourceId — which truncates a
 * sourceId that itself contains a ':' (e.g. `db:public.products`), so the entry gets
 * filed under the wrong reverse-index bucket and `invalidateSource(realSourceId)` can
 * never find it.
 *
 * Context is mocked via vi.mock so useStudioSelector resolves against a mutable
 * `mockState` — matching the pattern used by the other widget/hook tests (see
 * test/studioContextMock.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@mui/internal-test-utils';
import type { StudioDataSource, StudioState, StudioWidgetOf } from '../../../models';
import { studioRequestCache } from '../../../internals/StudioRequestCache';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { useBlendedSeriesRows } from './useBlendedSeriesRows';

let mockState: StudioState;

vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

interface StateOverrides {
  widgets?: StudioState['doc']['widgets'];
  dataSources?: StudioState['runtime']['dataSources'];
}

function createState(overrides: StateOverrides = {}): StudioState {
  return {
    doc: {
      schemaVersion: 1,
      dashboard: { id: 'dash-1', title: 'Dashboard', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'Overview', widgetRows: [] } },
      widgets: overrides.widgets ?? {},
      relationships: [],
      filters: [],
      expressionFields: [],
    },
    session: {
      mode: 'view',
      shell: {
        openDrawers: { data: true, compose: true, filters: false },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
      },
    },
    runtime: {
      dataSources: overrides.dataSources ?? {},
    },
  };
}

const ordersSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'total', label: 'Total', type: 'number' },
  ],
  rows: [
    { id: 'o1', category: 'Electronics', total: 100 },
    { id: 'o2', category: 'Furniture', total: 30 },
  ],
};

// Deliberately contains a ':' — the exact class of sourceId the legacy cacheKey parse
// (`cacheKey.split(':')[0]`) truncates.
const COLON_SOURCE_ID = 'db:public.products';

function blendedWidget(): StudioWidgetOf<'chart'> {
  return {
    id: 'chart-blend',
    kind: 'chart',
    title: 'Revenue vs Stock by Category',
    sourceId: 'orders',
    config: {
      chartType: 'mixed',
      xField: 'category',
      ySeries: [
        { fieldId: 'total', sourceId: 'orders', type: 'bar', yAggregation: 'sum' },
        { fieldId: 'stock', sourceId: COLON_SOURCE_ID, type: 'line', yAggregation: 'sum' },
      ],
    },
  };
}

beforeEach(() => {
  studioRequestCache.clear();
});

afterEach(() => {
  studioRequestCache.clear();
  vi.restoreAllMocks();
});

describe('useBlendedSeriesRows — adapter-backed foreign source caching', () => {
  it('invalidates the foreign-source cache entry via invalidateSource when the sourceId contains a colon', async () => {
    const getRows = vi.fn().mockResolvedValue({
      rows: [{ category: 'Electronics', stock: 12 }],
    });
    const colonSource: StudioDataSource = {
      id: COLON_SOURCE_ID,
      label: 'Products (external db)',
      fields: [
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'stock', label: 'Stock', type: 'number' },
      ],
      rows: undefined,
      adapter: { getRows },
    };
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, [COLON_SOURCE_ID]: colonSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    const widget = blendedWidget();
    renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    await waitFor(() => {
      expect(getRows).toHaveBeenCalled();
    });

    const cacheKey: string = getRows.mock.calls[0][0].cacheKey;
    // Sanity check: the descriptor's sourceId is the full colon-containing id, and the
    // cacheKey is prefixed with it (`${sourceId}:${queryShape}`).
    expect(getRows.mock.calls[0][0].sourceId).toBe(COLON_SOURCE_ID);
    expect(cacheKey.startsWith(`${COLON_SOURCE_ID}:`)).toBe(true);

    await waitFor(() => {
      expect(studioRequestCache.get(cacheKey)).toBeDefined();
    });

    // Invalidate using the TRUE (colon-containing) sourceId, as a host would after
    // `upsertDataSource` updates this source. If `addInflight` had not been given
    // `descriptor.sourceId`, the entry would have been filed under the legacy
    // first-colon-parsed bucket ('db') instead, and this invalidation would silently
    // miss it — leaving the stale entry cached.
    studioRequestCache.invalidateSource(COLON_SOURCE_ID);

    expect(studioRequestCache.get(cacheKey)).toBeUndefined();
  });
});

describe('useBlendedSeriesRows — refetch failure must not serve stale rows (finding 2.4)', () => {
  it('clears the stale asyncForeignRows entry for a sid when its refetch fails', async () => {
    const getRows = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ category: 'Electronics', stock: 12 }] })
      .mockRejectedValueOnce(new Error('network error'));
    const colonSource: StudioDataSource = {
      id: COLON_SOURCE_ID,
      label: 'Products (external db)',
      fields: [
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'stock', label: 'Stock', type: 'number' },
      ],
      rows: undefined,
      adapter: { getRows },
    };
    mockState = createState({
      widgets: { 'chart-blend': blendedWidget() },
      dataSources: { orders: ordersSource, [COLON_SOURCE_ID]: colonSource },
    });
    configureStudioContextMock({ getState: () => mockState });

    const widget = blendedWidget();
    const { result, rerender } = renderHook(() => useBlendedSeriesRows(widget, 'page-1'));

    // First fetch succeeds — the foreign source's rows are populated.
    await waitFor(() => {
      expect(result.current.foreignRowsBySource.get(COLON_SOURCE_ID)).toEqual([
        { category: 'Electronics', stock: 12 },
      ]);
    });

    // Add a page filter that applies to the foreign source's field — this changes the
    // per-source query descriptor (and its cacheKey), forcing a refetch. This time the
    // adapter's promise rejects.
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        filters: [
          {
            id: 'f1',
            field: 'category',
            operator: 'equals',
            value: 'Electronics',
            filterSourceId: COLON_SOURCE_ID,
            scope: { kind: 'page', pageId: 'page-1' },
          },
        ],
      },
    };
    rerender();

    await waitFor(() => {
      expect(getRows).toHaveBeenCalledTimes(2);
    });

    // The failed refetch must NOT leave the previous (pre-filter) rows serving
    // indefinitely — the stale entry for this sid is cleared rather than kept.
    await waitFor(() => {
      expect(result.current.foreignRowsBySource.has(COLON_SOURCE_ID)).toBe(false);
    });
  });
});
