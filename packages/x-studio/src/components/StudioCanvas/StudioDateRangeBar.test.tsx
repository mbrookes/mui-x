import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/StudioUIConfigContext';
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
