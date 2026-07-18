import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioWidgetOf,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { StudioChartWidget } from './StudioChartWidget';

// ─── crossFilterMode: 'none' must suppress EMISSION, not just reception ───────
//
// architecture review iteration 22, Tier 2 finding 2: clicking a chart/grid whose
// crossFilterMode is 'none' used to still call `StudioController.applyCrossFilter`
// directly, unconditionally emitting a cross-filter that every OTHER widget on the
// page would then react to — even though the clicked widget's own "Interactions"
// setting says "None". The map widget's `mapCrossFilterEmit` toggle is a *separate*,
// unrelated per-widget "is this map clickable at all" switch — it is not wired to
// `crossFilterMode` either, so nothing in the codebase actually enforced the
// invariant. The fix centralizes the gate inside `StudioController.applyCrossFilter`
// itself (the single mutation entry point every widget's click handler funnels
// through), so it holds for every widget kind without per-widget duplication.
//
// These tests exercise the REAL `StudioController` (via `createStudioHarness`), not a
// mocked one, so they actually observe the centralized gate rather than merely
// asserting the widget calls a spy.

const barChartSpy = vi.fn();

vi.mock('@mui/x-charts/BarChart', () => ({
  BarChart: (props: unknown) => {
    barChartSpy(props);
    return <div data-testid="bar-chart" />;
  },
}));
vi.mock('@mui/x-charts/LineChart', () => ({ LineChart: () => <div /> }));
vi.mock('@mui/x-charts/PieChart', () => ({ PieChart: () => <div /> }));
vi.mock('@mui/x-charts/ScatterChart', () => ({ ScatterChart: () => <div /> }));
vi.mock('@mui/x-charts-pro/SankeyChart', () => ({ SankeyChart: () => <div /> }));

const { render } = createRenderer();

function makeSource(): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'country', label: 'Country', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: [
      { id: 'o1', country: 'Germany', total: 100 },
      { id: 'o2', country: 'France', total: 200 },
      { id: 'o3', country: 'Germany', total: 150 },
    ],
  };
}

function makeWidget(
  crossFilterMode?: 'none' | 'cross-highlight' | 'cross-filter',
): StudioWidgetOf<'chart'> {
  return {
    id: 'chart-1',
    kind: 'chart',
    title: 'Revenue by Country',
    sourceId: 'orders',
    config: {
      chartType: 'bar',
      xField: 'country',
      yField: 'total',
      ...(crossFilterMode ? { crossFilterMode } : {}),
    },
  };
}

function setup(
  widget: StudioWidgetOf<'chart'>,
  dashboardOverrides?: CreateDefaultStudioStateOverrides,
) {
  const source = makeSource();
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    },
    runtime: { dataSources: { orders: source } },
    ...dashboardOverrides,
  };
  const { controller, wrapper } = createStudioHarness({ initialState });
  render(
    <ThemeProvider theme={createTheme()}>
      <StudioChartWidget widget={widget} dataSource={source} pageId="page-1" />
    </ThemeProvider>,
    { wrapper },
  );
  return { controller };
}

// `StudioBarChart` (a separate, un-owned file — not touched by this fix) forwards
// `onItemClick` to the real x-charts `BarChart` as `onAxisClick`, via
// `makeAxisClickHandler` (see `chartWidgetHelpers.ts`): `(event, { axisValue }) => …`.
// The mocked `BarChart` above therefore exposes the click callback as `onAxisClick`,
// not `onItemClick` — confirmed by inspecting the mock's captured props directly.
interface MockBarChartProps {
  onAxisClick?: (
    event: { shiftKey?: boolean } | null,
    params: { axisValue?: string | number | Date } | null,
  ) => void;
}

describe('StudioChartWidget — crossFilterMode: "none" suppresses cross-filter emission', () => {
  it('clicking a bar does NOT apply a cross-filter when the widget mode is "none"', () => {
    const widget = makeWidget('none');
    const { controller } = setup(widget);

    const props = barChartSpy.mock.calls.at(-1)?.[0] as MockBarChartProps;
    expect(props.onAxisClick).toBeDefined();

    act(() => {
      props.onAxisClick?.(null, { axisValue: 'Germany' });
    });

    const filters = controller.getState().doc.filters;
    expect(filters.some((f) => f.scope.kind === 'cross-filter')).toBe(false);
  });

  it('sanity check: the same click DOES apply a cross-filter in the default (cross-highlight) mode', () => {
    const widget = makeWidget();
    const { controller } = setup(widget);

    const props = barChartSpy.mock.calls.at(-1)?.[0] as MockBarChartProps;

    act(() => {
      props.onAxisClick?.(null, { axisValue: 'Germany' });
    });

    const filters = controller.getState().doc.filters;
    expect(filters.some((f) => f.scope.kind === 'cross-filter' && f.value === 'Germany')).toBe(
      true,
    );
  });

  it('a dashboard-wide globalCrossFilterMode: "none" override also suppresses emission for a widget configured as "cross-highlight"', () => {
    const widget = makeWidget('cross-highlight');
    const { controller } = setup(widget, {
      doc: {
        widgets: { [widget.id]: widget },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
        dashboard: {
          id: 'dashboard-1',
          title: 'Untitled Dashboard',
          activePageId: 'page-1',
          globalCrossFilterMode: 'none',
        },
      },
    });

    const props = barChartSpy.mock.calls.at(-1)?.[0] as MockBarChartProps;

    act(() => {
      props.onAxisClick?.(null, { axisValue: 'Germany' });
    });

    const filters = controller.getState().doc.filters;
    expect(filters.some((f) => f.scope.kind === 'cross-filter')).toBe(false);
  });
});
