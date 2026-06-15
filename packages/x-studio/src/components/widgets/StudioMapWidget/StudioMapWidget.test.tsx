import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StudioDataSource, StudioState, StudioWidget } from '../../../models';
import { StudioMapWidget } from './StudioMapWidget';

// Capture the props passed to our custom plot so we can drive its `onShapeClick`.
const mapShapePlotSpy = vi.fn();

vi.mock('./StudioMapShapePlot', () => ({
  StudioMapShapePlot: (props: unknown) => {
    mapShapePlotSpy(props);
    return null;
  },
}));

// Stub the premium geo provider stack — we only care about the click wiring, not rendering.
vi.mock('@mui/x-charts-premium/ChartsGeoDataProviderPremium', () => ({
  Unstable_ChartsGeoDataProviderPremium: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@mui/x-charts-premium/Map', () => ({
  GeoDataPlot: () => null,
}));
vi.mock('@mui/x-charts/ChartsSurface', () => ({
  ChartsSurface: ({ children }: { children?: React.ReactNode }) => <svg>{children}</svg>,
}));
vi.mock('@mui/x-charts/ChartsLegend', () => ({
  ContinuousColorLegend: () => null,
}));
// The tooltip pulls in the real charts context (ChartsTooltipContainer), which is not
// available behind our stubbed provider — stub it out, it's irrelevant to click wiring.
vi.mock('./StudioMapTooltip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./StudioMapTooltip')>();
  return {
    ...actual,
    StudioMapTooltip: () => null,
  };
});

// Return fixed rows for the widget, bypassing the filter pipeline.
const rows = [
  { country: 'United States', sales: 100 },
  { country: 'France', sales: 50 },
];
vi.mock('../../../internals/useWidgetRows', () => ({
  useWidgetRows: () => ({ effectiveRows: rows, isLoading: false, isError: false }),
}));

// Provide a geography whose loader resolves synchronously to a minimal feature collection.
const geographyDef = {
  label: 'World',
  fieldLabel: 'Country field',
  fieldHint: '',
  loader: () =>
    Promise.resolve({
      type: 'FeatureCollection',
      features: [],
    }),
};
vi.mock('../../../internals/StudioUIConfigContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../internals/StudioUIConfigContext')>();
  return {
    ...actual,
    useStudioGeographies: () => ({ world: geographyDef }),
  };
});

let mockState: StudioState;

const controller = {
  clearCrossFilter: vi.fn(),
  applyCrossFilter: vi.fn(),
};

vi.mock('../../../context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../context')>();
  return {
    ...actual,
    useStudioController: () => controller,
    useStudioSelector: (selector: (state: StudioState) => unknown) => selector(mockState),
  };
});

const { render } = createRenderer();

const dataSource: StudioDataSource = {
  id: 'sales',
  label: 'Sales',
  fields: [
    { id: 'country', label: 'Country', type: 'string' },
    { id: 'sales', label: 'Sales', type: 'number' },
  ],
  rows,
};

const baseWidget: StudioWidget = {
  id: 'map-1',
  kind: 'map',
  title: 'Sales by country',
  sourceId: 'sales',
  config: {
    mapCountryField: 'country',
    mapValueField: 'sales',
    mapGeography: 'world',
    mapCrossFilterEmit: true,
  },
} as unknown as StudioWidget;

function createState(overrides?: Partial<StudioState>): StudioState {
  return {
    schemaVersion: 1,
    mode: 'edit',
    dashboard: {
      id: 'dashboard-1',
      title: 'Dashboard',
      activePageId: 'page-1',
      ...overrides?.dashboard,
    },
    pages: {
      'page-1': { id: 'page-1', title: 'Overview', widgetRows: [] },
      ...overrides?.pages,
    },
    widgets: overrides?.widgets ?? {},
    dataSources: overrides?.dataSources ?? {},
    relationships: overrides?.relationships ?? [],
    filters: overrides?.filters ?? [],
    expressionFields: overrides?.expressionFields ?? [],
    shell: {
      openDrawers: { data: false, compose: false, filters: false },
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
      ...overrides?.shell,
    },
  } as unknown as StudioState;
}

async function renderMap(widget: StudioWidget) {
  const view = render(
    <ThemeProvider theme={createTheme()}>
      <StudioMapWidget widget={widget} dataSource={dataSource} />
    </ThemeProvider>,
  );
  // Flush the async geography loader so the plot renders.
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

function getLatestOnShapeClick() {
  const props = mapShapePlotSpy.mock.calls.at(-1)?.[0] as {
    onShapeClick?: (event: unknown, featureId: string) => void;
  };
  return props?.onShapeClick;
}

describe('<StudioMapWidget /> cross-filter emit', () => {
  beforeEach(() => {
    // StudioMapWidget instantiates a ResizeObserver directly; jsdom doesn't
    // provide one. Stub it so rendering the widget doesn't throw (the previous
    // "pass" relied on an earlier chart test leaking the global — order-dependent).
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}

        unobserve() {}

        disconnect() {}
      },
    );
    mapShapePlotSpy.mockClear();
    controller.clearCrossFilter.mockClear();
    controller.applyCrossFilter.mockClear();
    mockState = createState({
      widgets: { 'map-1': baseWidget },
      dataSources: { sales: dataSource },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('emits a cross-filter with the clicked region raw value when the toggle is on', async () => {
    await renderMap(baseWidget);

    const onShapeClick = getLatestOnShapeClick();
    expect(onShapeClick).toBeTypeOf('function');

    act(() => {
      // The feature id for the United States in the world (alpha-2) geography is "US".
      onShapeClick!(null, 'US');
    });

    expect(controller.applyCrossFilter).toHaveBeenCalledWith(
      'map-1',
      'country',
      'United States',
      'sales',
    );
    expect(controller.clearCrossFilter).not.toHaveBeenCalled();
  });

  it('does not wire onShapeClick when the cross-filter toggle is off', async () => {
    const widget = {
      ...baseWidget,
      config: { ...baseWidget.config, mapCrossFilterEmit: false },
    } as StudioWidget;
    mockState = createState({
      widgets: { 'map-1': widget },
      dataSources: { sales: dataSource },
    });

    await renderMap(widget);

    expect(getLatestOnShapeClick()).toBeUndefined();
  });
});
