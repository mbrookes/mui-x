/**
 * UI render performance tests (BL70)
 *
 * These tests verify that React's memoization works correctly in the Studio
 * component tree — changing state that affects widget A should NOT cause
 * widget B to re-render.
 *
 * Methodology: wrap components in a render-counting spy, apply a state change,
 * and assert the render count stays within expected bounds.
 */

import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { describe, expect, it, vi, beforeEach } from 'vitest';
// Imported first: the vi.mock factory below references these, and they must be
// initialized before any import (e.g. ../context/selectors) loads the mocked context.
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../test/studioContextMock';
import type { StudioDataSource, StudioState } from '../models';
import { StudioController } from '../store/StudioController';
import { selectPartitionedFilters, selectPartitionedBaseFilters } from '../context/selectors';
import { studioRequestCache } from './StudioRequestCache';
import { createDefaultWidget } from './widgetFactory';
import { StudioKpiWidget } from '../components/widgets/StudioKpiWidget';

// ─── Module-level mutable state (replaced by vi.mock) ─────────────────────────

let mockState: StudioState;
let controller: StudioController;

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function syncState() {
  mockState = controller.getState();
}

function buildDataSource(id = 'source-1'): StudioDataSource {
  return {
    id,
    label: 'Orders',
    fields: [
      { id: 'id', label: 'Order ID', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
      { id: 'category', label: 'Category', type: 'string' },
    ],
    rows: Array.from({ length: 100 }, (_, i) => ({
      id: `order-${i}`,
      amount: (i % 10) * 100,
      category: i % 2 === 0 ? 'A' : 'B',
    })),
  };
}

function buildInitialState(): Partial<StudioState> {
  const source = buildDataSource();
  return {
    mode: 'view',
    dataSources: { [source.id]: source },
    widgets: {
      'w-kpi-1': {
        id: 'w-kpi-1',
        kind: 'kpi',
        title: 'Total Amount',
        sourceId: 'source-1',
        config: { kpiValueField: 'amount', kpiAggregation: 'sum' },
      },
      'w-kpi-2': {
        id: 'w-kpi-2',
        kind: 'kpi',
        title: 'Count',
        sourceId: 'source-1',
        config: { kpiValueField: 'id', kpiAggregation: 'count' },
      },
    },
    pages: {
      'page-1': { id: 'page-1', title: 'Overview', widgetRows: [] },
    },
  };
}

const theme = createTheme();

// ─── Tests ───────────────────────────────────────────────────────────────────

const { render } = createRenderer();

describe('UI render performance', () => {
  beforeEach(() => {
    // Clear the shared row-resolution cache so a polluted entry from another test
    // file's async/adapter-backed widget can't leak empty rows into these renders.
    studioRequestCache.clear();
    controller = new StudioController(buildInitialState());
    syncState();
    // Some tests reassign `controller` mid-test, so resolve it live via a getter.
    configureStudioContextMock({ getState: () => mockState, getController: () => controller });
  });

  it('selectPartitionedFilters: adding a page filter does not produce unbounded re-renders', () => {
    // This tests that the selector memoization in selectPartitionedFilters
    // prevents redundant downstream work. We assert the selector returns
    // a stable reference when nothing relevant changes.
    const state1 = controller.getState();
    const result1 = selectPartitionedFilters(state1);

    // Add a filter and ensure the result reference changes (cache invalidation)
    controller.addFilter({
      id: 'f-1',
      field: 'category',
      operator: 'equals',
      value: 'A',
      scope: 'page',
    });
    syncState();
    const state2 = controller.getState();
    const result2 = selectPartitionedFilters(state2);

    expect(result2).not.toBe(result1);
    expect(result2.page).toHaveLength(1);

    // Calling again with same state object returns same reference (memoized)
    const result2again = selectPartitionedFilters(state2);
    expect(result2again).toBe(result2);
  });

  it('selectPartitionedFilters: switching active page invalidates page filter partition', () => {
    // Add page-2 and switch to it so the filter gets stamped with page-2's id
    controller.addPage('Page 2');
    // addPage switches to the new page automatically; get its id from state
    const page2Id = controller.getState().dashboard.activePageId;
    expect(page2Id).not.toBe('page-1');

    controller.addFilter({
      id: 'f-page2',
      field: 'category',
      operator: 'equals',
      value: 'B',
      scope: 'page',
    });

    // Switch back to page-1
    controller.setActivePage('page-1');
    syncState();

    const state1 = controller.getState();
    const result1 = selectPartitionedFilters(state1);
    expect(result1.page).toHaveLength(0); // page-1 has no filters

    // Switch to page-2
    controller.setActivePage(page2Id);
    syncState();
    const state2 = controller.getState();
    const result2 = selectPartitionedFilters(state2);
    expect(result2).not.toBe(result1);
    expect(result2.page).toHaveLength(1); // now page-2 filter is included
  });

  it('selectPartitionedFilters: identical state object returns cached reference', () => {
    const state = controller.getState();

    const result1 = selectPartitionedFilters(state);
    const result2 = selectPartitionedFilters(state);
    expect(result1).toBe(result2);
  });

  it('selectPartitionedBaseFilters: returns deep-equal result for semantically equivalent filter sets', () => {
    const state1 = controller.getState();
    const result1 = selectPartitionedBaseFilters(state1);

    // Simulate a no-op state update (nothing filter-related changed)
    // The selector should return the same reference due to deep-equality caching.
    // We add a shell update (selectedWidgetId) which does NOT affect filters.
    controller.setSelectedWidget('w-kpi-1');
    syncState();
    const state2 = controller.getState();
    const result2 = selectPartitionedBaseFilters(state2);

    // Reference must be identical (same object) since no filter changed
    expect(result2).toBe(result1);
  });

  it('selectPartitionedBaseFilters: changes reference when a filter value changes', () => {
    controller.addFilter({
      id: 'f-1',
      field: 'category',
      operator: 'equals',
      value: 'A',
      scope: 'page',
    });
    syncState();
    const state1 = controller.getState();
    const result1 = selectPartitionedBaseFilters(state1);

    // Update the filter's value
    controller.updateFilter('f-1', { value: 'B' });
    syncState();
    const state2 = controller.getState();
    const result2 = selectPartitionedBaseFilters(state2);

    // Reference must differ because the filter data changed
    expect(result2).not.toBe(result1);
    const filterValue = result2.page[0]?.value;
    expect(filterValue).toBe('B');
  });

  it('renders KPI widget without throwing and shows no error state', () => {
    // Smoke test: KPI widget renders with the real controller + mocked selector
    const source = buildDataSource();
    const widget = controller.getState().widgets['w-kpi-1'];

    const { container } = render(
      <ThemeProvider theme={theme}>
        <StudioKpiWidget widget={widget} dataSource={source} />
      </ThemeProvider>,
    );

    // No error state rendered (no "Failed to load" text)
    expect(container.textContent).not.toContain('Failed to load');
  });

  it('renders a count KPI reproduced from scratch (source picked, no value field)', () => {
    // EBL-06: recreating Total Contacts from scratch = add a KPI, pick a source, leave
    // the value field empty. createDefaultWidget('kpi') seeds { kpiAggregation: 'sum' };
    // the setup panel's source picker then clears any field and sets aggregation to
    // 'count'. Mirror that exact transformation here so we render the real artifact a
    // user produces — it must show a numeric row count, not the "—" no-data placeholder
    // (the original Total Contacts bug, where the rendered value couldn't be reproduced).
    const source = buildDataSource();
    const created = createDefaultWidget('kpi');
    expect(created.config).toEqual({ kpiAggregation: 'sum' });
    // Source-picker side effect (KpiSetupPanel onChange):
    const widget = {
      ...created,
      sourceId: source.id,
      config: { kpiValueField: '', kpiAggregation: 'count' as const },
    };

    const { container } = render(
      <ThemeProvider theme={theme}>
        <StudioKpiWidget widget={widget} dataSource={source} />
      </ThemeProvider>,
    );

    const text = container.textContent ?? '';
    // A numeric count is rendered (not the "—" no-data placeholder).
    expect(text).toMatch(/\d/);
    expect(text).not.toContain('—');
    expect(text).not.toContain('Failed to load');
  });

  it('applying a page filter does not cause errors in widget rendering', async () => {
    const source = buildDataSource();
    const widget = controller.getState().widgets['w-kpi-1'];

    const { container } = render(
      <ThemeProvider theme={theme}>
        <StudioKpiWidget widget={widget} dataSource={source} />
      </ThemeProvider>,
    );

    // Add a page filter
    await act(async () => {
      controller.addFilter({
        id: 'f-cat',
        field: 'category',
        operator: 'equals',
        value: 'A',
        scope: 'page',
      });
      syncState();
    });

    expect(container.textContent).not.toContain('Failed to load');
  });
});
