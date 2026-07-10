import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioWidgetConfigForKind,
  StudioWidgetOf,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { StudioGridWidget } from './StudioGridWidget';

const { render } = createRenderer();

// ─── crossFilterMode: 'none' / globalCrossFilterMode — architecture review 1.6 ──
//
// The grid used to resolve its own cross-filter mode locally as
// `widget.config.crossFilterMode ?? 'cross-highlight'` and only ever consumed
// `filteredRows`/`filteredRowsNoChartCross` from `useWidgetRows` — never
// `filteredRowsNoCross`/`effectiveRows`. That meant:
//   (a) setting a grid's own Interactions to "None" (offered by GridSetupPanel) did
//       NOT stop it from reacting to a sibling chart's cross-filter click, and
//   (b) the dashboard-wide `globalCrossFilterMode` toggle never reached the grid at
//       all, even though every other widget kind (chart/KPI/map/pivot, CSV export)
//       already honors it.
// Both baselines are exercised here against the same fixture: a grid on `orders`
// with an incoming chart-click cross-filter (`region === 'EU'`) from a sibling
// widget.

function makeSource(): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'region', label: 'Region', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: [
      { id: 'o1', region: 'EU', total: 100 },
      { id: 'o2', region: 'US', total: 50 },
      { id: 'o3', region: 'EU', total: 75 },
    ],
  };
}

function makeWidget(
  crossFilterMode?: 'none' | 'cross-highlight' | 'cross-filter',
): StudioWidgetOf<'grid'> {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'orders',
    config: { crossFilterMode } as StudioWidgetConfigForKind<'grid'>,
  };
}

function crossFilterFromSibling() {
  return [
    {
      id: 'cf-1',
      field: 'region',
      operator: 'equals' as const,
      value: 'EU',
      scope: {
        kind: 'cross-filter' as const,
        sourceWidgetId: 'other-widget',
        pageId: 'page-1',
      },
    },
  ];
}

function setup(initialState: CreateDefaultStudioStateOverrides, widget: StudioWidgetOf<'grid'>) {
  const source = makeSource();
  const { controller, wrapper } = createStudioHarness({ initialState });
  const utils = render(
    <StudioGridWidget
      widget={widget}
      dataSource={source}
      pageId="page-1"
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          columns: [
            { field: 'region', width: 100 },
            { field: 'total', width: 100 },
          ],
        },
      }}
    />,
    { wrapper },
  );
  return { controller, source, widget, ...utils };
}

describe('StudioGridWidget — crossFilterMode: "none" ignores sibling cross-filters', () => {
  it('does not shrink/dim rows when a sibling chart cross-filter is active', () => {
    const widget = makeWidget('none');
    const initialState: CreateDefaultStudioStateOverrides = {
      doc: {
        widgets: { [widget.id]: widget },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
        filters: crossFilterFromSibling(),
      },
      runtime: { dataSources: { orders: makeSource() } },
    };
    const { container } = setup(initialState, widget);

    // All 3 rows must be present — 'none' mode must not filter to the EU subset.
    expect(container.querySelector('[data-id="o1"]')).not.toBe(null);
    expect(container.querySelector('[data-id="o2"]')).not.toBe(null);
    expect(container.querySelector('[data-id="o3"]')).not.toBe(null);

    // Regression guard: previously 'none' fell through to `filteredRows` (the fully
    // cross-filter-applied baseline used for 'cross-filter' mode), so the US row would
    // have been dropped entirely instead of merely not being dimmed.
    const usRow = container.querySelector('[data-id="o2"]');
    expect(usRow!.className).not.toMatch(/StudioGrid-dimmed/);
  });
});

describe('StudioGridWidget — dashboard-wide globalCrossFilterMode override', () => {
  it("overrides a widget's own 'cross-highlight' config to 'none', ignoring the sibling cross-filter", () => {
    const widget = makeWidget('cross-highlight');
    const initialState: CreateDefaultStudioStateOverrides = {
      doc: {
        widgets: { [widget.id]: widget },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
        filters: crossFilterFromSibling(),
        dashboard: {
          id: 'dashboard-1',
          title: 'Untitled Dashboard',
          activePageId: 'page-1',
          globalCrossFilterMode: 'none',
        },
      },
      runtime: { dataSources: { orders: makeSource() } },
    };
    const { container } = setup(initialState, widget);

    expect(container.querySelector('[data-id="o1"]')).not.toBe(null);
    expect(container.querySelector('[data-id="o2"]')).not.toBe(null);
    expect(container.querySelector('[data-id="o3"]')).not.toBe(null);

    // No row should be dimmed — the dashboard-wide override should suppress the
    // cross-highlight overlay the widget's own config would otherwise show.
    const usRow = container.querySelector('[data-id="o2"]');
    expect(usRow!.className).not.toMatch(/StudioGrid-dimmed/);
  });

  it("overrides a widget's own 'none' config to 'cross-highlight', dimming non-matching rows", () => {
    const widget = makeWidget('none');
    const initialState: CreateDefaultStudioStateOverrides = {
      doc: {
        widgets: { [widget.id]: widget },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
        filters: crossFilterFromSibling(),
        dashboard: {
          id: 'dashboard-1',
          title: 'Untitled Dashboard',
          activePageId: 'page-1',
          globalCrossFilterMode: 'cross-highlight',
        },
      },
      runtime: { dataSources: { orders: makeSource() } },
    };
    const { container } = setup(initialState, widget);

    // All rows present (cross-highlight never drops rows), but the non-matching one
    // (US) must now be dimmed since the dashboard-wide override reinstates highlighting.
    const usRow = container.querySelector('[data-id="o2"]');
    expect(usRow).not.toBe(null);
    expect(usRow!.className).toMatch(/StudioGrid-dimmed/);

    const euRow = container.querySelector('[data-id="o1"]');
    expect(euRow!.className).not.toMatch(/StudioGrid-dimmed/);
  });
});
