/**
 * UI render performance tests (BL70)
 *
 * These tests verify that React's memoization works correctly in the Studio
 * component tree — changing state that affects widget A should NOT cause
 * widget B to re-render.
 *
 * Methodology: wrap components in a render-counting spy, apply a state change,
 * and assert the render count stays within expected bounds.
 *
 * Until the shared `test/studioContextMock.ts` grew a subscribed mode, that
 * methodology was not achievable here and nothing in this file implemented it:
 * `useStudioSelector` was `selector(getState())` with no subscription, so a
 * `controller.<mutation>()` re-rendered nothing and a render count could only ever
 * be 1. The selector cases below therefore call the selectors directly (they are
 * pure functions and that is a fair test of them), and the two rendering cases
 * asserted only "no error text" — the one at the end of the first block applies a
 * page filter to a mounted widget and could not have failed if the widget ignored
 * the filter entirely.
 *
 * The second block is the missing half: it configures the mock with the real
 * `StudioController`'s store, so mutations propagate through `useSyncExternalStore`
 * exactly as in the app, and asserts both directions — a relevant write re-renders
 * and changes what is on screen, an irrelevant one re-renders nothing.
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
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioState,
  StudioWidgetOf,
} from '../models';
import { StudioController } from '../store/StudioController';
import { selectPartitionedFilters, selectPartitionedBaseFilters } from '../context/selectors';
import { studioRequestCache } from './StudioRequestCache';
import { createDefaultWidget } from './widgetFactory';
import { StudioKpiWidget } from '../components/widgets/StudioKpiWidget';
import { StudioWidgetCard } from '../components/StudioWidgetCard';

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

function buildInitialState(): CreateDefaultStudioStateOverrides {
  const source = buildDataSource();
  return {
    session: { mode: 'view' },
    runtime: { dataSources: { [source.id]: source } },
    doc: {
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
      scope: { kind: 'page' },
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
    const page2Id = controller.getState().doc.dashboard.activePageId;
    expect(page2Id).not.toBe('page-1');

    controller.addFilter({
      id: 'f-page2',
      field: 'category',
      operator: 'equals',
      value: 'B',
      scope: { kind: 'page' },
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
      scope: { kind: 'page' },
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
    const widget = controller.getState().doc.widgets['w-kpi-1'];

    const { container } = render(
      <ThemeProvider theme={theme}>
        <StudioKpiWidget
          widget={widget as StudioWidgetOf<'kpi'>}
          dataSource={source}
          pageId="page-1"
        />
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
        <StudioKpiWidget
          widget={widget as StudioWidgetOf<'kpi'>}
          dataSource={source}
          pageId="page-1"
        />
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
    const widget = controller.getState().doc.widgets['w-kpi-1'];

    const { container } = render(
      <ThemeProvider theme={theme}>
        <StudioKpiWidget
          widget={widget as StudioWidgetOf<'kpi'>}
          dataSource={source}
          pageId="page-1"
        />
      </ThemeProvider>,
    );

    // Add a page filter
    await act(async () => {
      controller.addFilter({
        id: 'f-cat',
        field: 'category',
        operator: 'equals',
        value: 'A',
        scope: { kind: 'page' },
      });
      syncState();
    });

    expect(container.textContent).not.toContain('Failed to load');
  });
});

// ─── Store-driven re-renders (subscribed mock) ────────────────────────────────
//
// Everything above configures the shared context mock in its default SNAPSHOT mode:
// `useStudioSelector` reads `getState()` once per render and subscribes to nothing, so
// no component in the tree can react to a `controller.<mutation>()` on its own. This
// block opts into SUBSCRIBED mode by handing the mock the real controller's `Store`,
// which routes every `useStudioSelector` through `useSyncExternalStore` — the same path
// `context/StudioContext.tsx` uses in the app. Two things become observable that were
// not:
//
//   1. that a mounted widget re-computes when the store changes under it, and
//   2. that an UNRELATED store change re-renders nothing — the reference-stability
//      contract every memoized selector in `context/selectors.ts` exists to uphold, and
//      which is otherwise only checkable one selector call at a time in
//      `context/selectors.test.ts`, never through a real component.
describe('UI render performance — store-driven re-renders', () => {
  beforeEach(() => {
    studioRequestCache.clear();
    controller = new StudioController(buildInitialState());
    syncState();
    // `store` is the opt-in: `getState` defaults to `controller.store.getSnapshot`, so
    // there is no second, manually-synced copy of the state to drift from the store.
    configureStudioContextMock({ store: controller.store, getController: () => controller });
  });

  it('re-renders a mounted KPI when a page filter is added, and shows the filtered value', async () => {
    const source = buildDataSource();
    const widget = controller.getState().doc.widgets['w-kpi-1'];

    const { container } = render(
      <ThemeProvider theme={theme}>
        <StudioKpiWidget
          widget={widget as StudioWidgetOf<'kpi'>}
          dataSource={source}
          pageId="page-1"
        />
      </ThemeProvider>,
    );

    // `amount` is `(i % 10) * 100` over 100 rows → ten 0..900 cycles → 45,000,
    // rendered in the KPI's compact notation.
    expect(container.textContent).toContain('45K');

    // Nothing re-renders this widget by hand: the controller notifies its store, the
    // subscribed `useStudioSelector(selectFilters)` reads a new filters array, and React
    // re-renders the widget. This is the whole scenario the snapshot-mode sibling test
    // ("applying a page filter does not cause errors in widget rendering") could only
    // assert the absence of an error for.
    await act(async () => {
      controller.addFilter({
        id: 'f-cat',
        field: 'category',
        operator: 'equals',
        value: 'A',
        scope: { kind: 'page' },
      });
    });

    // Category A is the even-indexed rows → 0/200/400/600/800 per cycle → 20,000.
    expect(container.textContent).toContain('20K');
    expect(container.textContent).not.toContain('45K');
  });

  it('does not re-render a KPI when an expression field is added for an unrelated source', async () => {
    const source = buildDataSource();
    const widget = controller.getState().doc.widgets['w-kpi-1'];

    // Render-counting spy in the `value` slot: `StudioKpiWidget` renders it inline, so it
    // renders exactly when the widget does.
    let valueRenders = 0;
    function CountingValue(props: { value: string; hasData: boolean }) {
      valueRenders += 1;
      return <span data-testid="kpi-value">{props.value}</span>;
    }
    const slots = { value: CountingValue };

    render(
      <ThemeProvider theme={theme}>
        <StudioKpiWidget
          widget={widget as StudioWidgetOf<'kpi'>}
          dataSource={source}
          pageId="page-1"
          slots={slots}
        />
      </ThemeProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    // `valueRenders` is a render COUNTER incremented by the probe component, not the return
    // value of `render()`. The rule cannot tell the two apart from the identifier alone.
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const paintCountBeforeMutation = valueRenders;
    expect(paintCountBeforeMutation).toBeGreaterThan(0);

    // A calculated column authored on a DIFFERENT source. `state.doc.expressionFields`
    // gets a new array reference, so every widget subscribed to it naively would
    // re-render; `makeSelectExpressionFieldsForSources` is supposed to hand this widget
    // back the previous (empty) array because none of the fields belong to its sources.
    await act(async () => {
      controller.addExpressionField({
        id: 'ef-other',
        sourceId: 'source-2',
        label: 'Elsewhere',
        expression: { kind: 'literal', value: 1 },
      } as any);
    });

    // Sanity: the write really landed, so a stable render count means "filtered out",
    // not "nothing happened".
    expect(controller.getState().doc.expressionFields).toHaveLength(1);
    expect(controller.getState().doc.expressionFields[0].sourceId).toBe('source-2');

    expect(valueRenders).toBe(paintCountBeforeMutation);
  });

  it("does re-render when an expression field is added for the KPI's OWN source", async () => {
    // The counterpart to the case above — without it, a selector that returned a frozen
    // reference forever would pass that test and this file would be recommending a bug.
    const source = buildDataSource();
    const widget = controller.getState().doc.widgets['w-kpi-1'];

    let valueRenders = 0;
    function CountingValue(props: { value: string; hasData: boolean }) {
      valueRenders += 1;
      return <span data-testid="kpi-value">{props.value}</span>;
    }
    const slots = { value: CountingValue };

    render(
      <ThemeProvider theme={theme}>
        <StudioKpiWidget
          widget={widget as StudioWidgetOf<'kpi'>}
          dataSource={source}
          pageId="page-1"
          slots={slots}
        />
      </ThemeProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    // `valueRenders` is a render COUNTER incremented by the probe component, not the return
    // value of `render()`. The rule cannot tell the two apart from the identifier alone.
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const paintCountBeforeMutation = valueRenders;

    await act(async () => {
      controller.addExpressionField({
        id: 'ef-own',
        sourceId: 'source-1',
        label: 'Doubled',
        expression: { kind: 'literal', value: 1 },
      } as any);
    });

    expect(valueRenders).toBeGreaterThan(paintCountBeforeMutation);
  });

  // The two cases above render `StudioKpiWidget` STANDALONE, bypassing the card that wraps
  // EVERY widget in the real tree — so they could not see that `StudioWidgetCard` itself
  // subscribed to `selectExpressionFields`, a whole-slice selector returning
  // `state.doc.expressionFields` by reference. `addExpressionField({ sourceId: 'unrelated' })`
  // replaces that array, so every mounted card on every mounted page re-rendered its chrome
  // (including `inferKpiDateSubtitle`, whose deps include `allFilters`) for an edit it can
  // never reach. Mount THROUGH the card so the ARCHITECTURE.md claim is actually pinned.
  it('does not re-render the widget CARD when an expression field is added for an unrelated source', async () => {
    let cardCommits = 0;

    render(
      <ThemeProvider theme={theme}>
        <React.Profiler
          id="card"
          onRender={() => {
            cardCommits += 1;
          }}
        >
          <StudioWidgetCard widgetId="w-kpi-1" pageId="page-1" />
        </React.Profiler>
      </ThemeProvider>,
      { strict: false },
    );

    await act(async () => {
      await Promise.resolve();
    });
    const commitsBeforeMutation = cardCommits;
    expect(commitsBeforeMutation).toBeGreaterThan(0);

    await act(async () => {
      controller.addExpressionField({
        id: 'ef-elsewhere',
        sourceId: 'source-2',
        label: 'Elsewhere',
        expression: { kind: 'literal', value: 1 },
      } as any);
    });

    // Sanity: the write really landed, so a stable commit count means "filtered out",
    // not "nothing happened".
    expect(controller.getState().doc.expressionFields).toHaveLength(1);
    expect(cardCommits).toBe(commitsBeforeMutation);
  });

  it('does re-render the widget CARD when an expression field is added for its OWN source', async () => {
    // Counterpart to the case above, so a selector frozen forever cannot pass it.
    let cardCommits = 0;

    render(
      <ThemeProvider theme={theme}>
        <React.Profiler
          id="card"
          onRender={() => {
            cardCommits += 1;
          }}
        >
          <StudioWidgetCard widgetId="w-kpi-1" pageId="page-1" />
        </React.Profiler>
      </ThemeProvider>,
      { strict: false },
    );

    await act(async () => {
      await Promise.resolve();
    });
    const commitsBeforeMutation = cardCommits;

    await act(async () => {
      controller.addExpressionField({
        id: 'ef-own',
        sourceId: 'source-1',
        label: 'Doubled',
        expression: { kind: 'literal', value: 1 },
      } as any);
    });

    expect(cardCommits).toBeGreaterThan(commitsBeforeMutation);
  });
});
