import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioDataSource, StudioFilterState } from '../../models';
import { StudioDateRangeBar } from './StudioDateRangeBar';

const { render } = createRenderer();

const PAGE_ID = 'page-1';

const DATA_SOURCE_WITH_DATE: Record<string, StudioDataSource> = {
  src1: {
    id: 'src1',
    label: 'Source',
    fields: [
      { id: 'order_date', label: 'Order Date', type: 'date' as const },
      { id: 'country', label: 'Country', type: 'string' as const },
    ],
    rows: [],
  },
};

function customDateRangeFilter(): StudioFilterState {
  return {
    id: 'dr1',
    field: 'order_date',
    operator: 'between',
    value: { from: '2024-01-01', to: '2024-01-31' },
    dateRangePreset: 'custom',
    scope: { kind: 'dashboard-date-range' as const, sourceId: 'src1', pageId: PAGE_ID },
  };
}

/**
 * Regression coverage for architecture-review finding 3.12: `activePreset` can be
 * `'custom'` (set by a host or the AI via an explicit `customFrom`/`customTo` range),
 * but the preset `Select` had no matching menu item — MUI renders an out-of-range
 * value as blank and logs a dev warning, and `handlePresetChange` already
 * special-cased `'custom'` as a no-op (so there was no way to even reach it from the
 * UI). This suite asserts the Select now has a `'custom'` item, displays its label,
 * and does not trigger MUI's out-of-range warning.
 */
describe('StudioDateRangeBar custom preset (finding 3.12)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the custom preset label instead of a blank Select when the active filter is custom', () => {
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: {
          filters: [customDateRangeFilter()],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        runtime: { dataSources: DATA_SOURCE_WITH_DATE },
      },
    });
    render(<StudioDateRangeBar />, { wrapper });

    expect(screen.getByText(DEFAULT_STUDIO_LOCALE_TEXT.dateRangePresetCustom)).toBeVisible();
  });

  it('does not log an out-of-range Select warning for a custom preset', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: {
          filters: [customDateRangeFilter()],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        runtime: { dataSources: DATA_SOURCE_WITH_DATE },
      },
    });
    render(<StudioDateRangeBar />, { wrapper });

    const outOfRangeWarning = errorSpy.mock.calls.some((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('out-of-range value')),
    );
    expect(outOfRangeWarning).toBe(false);
  });

  it('still shows "All time" and the normal presets when no dashboard-date-range filter is active', () => {
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: {
          filters: [],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        runtime: { dataSources: DATA_SOURCE_WITH_DATE },
      },
    });
    render(<StudioDateRangeBar />, { wrapper });

    expect(screen.getByText(DEFAULT_STUDIO_LOCALE_TEXT.dateRangePresetAllTime)).toBeVisible();
  });
});

/**
 * Regression coverage for architecture-review finding 1.7: the coverage-reconciliation
 * effect fires whenever a data source lacks a `dashboard-date-range` filter on its first
 * date field. It used to always call `setDashboardDateRangeAll(..., undefined, undefined,
 * { undoable: false })` — for a `'custom'` preset this built an EMPTY filter set (no bounds
 * means `buildDateRangeFilter` returns `null`), and the length mismatch against the existing
 * custom filter(s) triggered a rebuild-all that silently deleted the page's custom date
 * range, non-undoably, on the very next render.
 */
describe('StudioDateRangeBar custom preset coverage-reconciliation (finding 1.7)', () => {
  const TWO_SOURCES_WITH_DATE: Record<string, StudioDataSource> = {
    src1: {
      id: 'src1',
      label: 'Source 1',
      fields: [{ id: 'order_date', label: 'Order Date', type: 'date' as const }],
      rows: [],
    },
    src2: {
      id: 'src2',
      label: 'Source 2',
      fields: [{ id: 'ship_date', label: 'Ship Date', type: 'date' as const }],
      rows: [],
    },
  };

  it('does not delete an existing custom range when a second source has no coverage yet', () => {
    const { wrapper, controller } = createStudioHarness({
      initialState: {
        doc: {
          filters: [customDateRangeFilter()],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        // Two sources with date fields, but only `src1` has a persisted custom-range
        // filter — `src2` was injected after the persisted state loaded.
        runtime: { dataSources: TWO_SOURCES_WITH_DATE },
      },
    });
    render(<StudioDateRangeBar />, { wrapper });

    const rangeFilters = controller
      .getState()
      .doc.filters.filter((f) => f.scope.kind === 'dashboard-date-range');
    // The custom range must survive reconciliation and now cover BOTH sources — not be wiped.
    expect(rangeFilters.length).toBe(2);
    const src1Filter = rangeFilters.find(
      (f) => f.scope.kind === 'dashboard-date-range' && f.scope.sourceId === 'src1',
    );
    const src2Filter = rangeFilters.find(
      (f) => f.scope.kind === 'dashboard-date-range' && f.scope.sourceId === 'src2',
    );
    expect(src1Filter?.value).toEqual({ from: '2024-01-01', to: '2024-01-31' });
    expect(src2Filter?.value).toEqual({ from: '2024-01-01', to: '2024-01-31' });
    // The Select still reflects "Custom", never falls back to "All time".
    expect(screen.getByText(DEFAULT_STUDIO_LOCALE_TEXT.dateRangePresetCustom)).toBeVisible();
  });

  it('reconciliation is non-undoable and pushes no undo entry', () => {
    const { wrapper, controller } = createStudioHarness({
      initialState: {
        doc: {
          filters: [customDateRangeFilter()],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        runtime: { dataSources: TWO_SOURCES_WITH_DATE },
      },
    });
    render(<StudioDateRangeBar />, { wrapper });

    expect(controller.canUndo()).toBe(false);
  });
});

/**
 * H4: the bar read its active preset from ANY `dashboard-date-range` filter on the page,
 * `disabled` ones included — while `selectFiltersForWidget` drops disabled filters up front.
 * A range toggled off from the quick-filter bar therefore left the toolbar asserting
 * "Last 3 months" over charts showing unfiltered data, with nothing on screen reconciling the
 * two. Reading `'all_time'` instead also keeps the coverage-reconciliation effect from
 * resurrecting the disabled filter on mount.
 */
describe('StudioDateRangeBar honours the disabled flag (H4)', () => {
  function disabledPresetFilter(): StudioFilterState {
    return {
      id: 'dr-disabled',
      field: 'order_date',
      operator: 'between',
      value: { from: '2024-01-01', to: '2024-03-31' },
      dateRangePreset: 'last_3_months',
      disabled: true,
      scope: { kind: 'dashboard-date-range' as const, sourceId: 'src1', pageId: PAGE_ID },
    };
  }

  it('reads "All time" while the only date-range filter is disabled', () => {
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: {
          filters: [disabledPresetFilter()],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        runtime: { dataSources: DATA_SOURCE_WITH_DATE },
      },
    });
    render(<StudioDateRangeBar />, { wrapper });

    expect(screen.getByText(DEFAULT_STUDIO_LOCALE_TEXT.dateRangePresetAllTime)).toBeVisible();
    expect(screen.queryByText(DEFAULT_STUDIO_LOCALE_TEXT.dateRangePresetLast3Months)).toBe(null);
  });

  it('does not resurrect the disabled filter through coverage reconciliation', () => {
    const { wrapper, controller } = createStudioHarness({
      initialState: {
        doc: {
          filters: [disabledPresetFilter()],
          dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
        },
        runtime: { dataSources: DATA_SOURCE_WITH_DATE },
      },
    });
    render(<StudioDateRangeBar />, { wrapper });

    const rangeFilters = controller
      .getState()
      .doc.filters.filter((f) => f.scope.kind === 'dashboard-date-range');
    expect(rangeFilters.length).toBe(1);
    expect(rangeFilters[0].disabled).toBe(true);
  });
});
