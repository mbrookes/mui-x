import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StudioDataSource, StudioState, StudioWidget } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../../internals/StudioUIConfigContext';
import { frLocaleText } from '../../../locales/fr';
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
const continuousColorLegendSpy = vi.fn();
vi.mock('@mui/x-charts/ChartsLegend', () => ({
  ContinuousColorLegend: (props: unknown) => {
    continuousColorLegendSpy(props);
    return null;
  },
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

// Return fixed rows for the widget, bypassing the filter pipeline. `rows` is
// reassigned by individual tests to exercise other raw values, then reset in `afterEach`.
const DEFAULT_ROWS: Array<Record<string, unknown>> = [
  { country: 'United States', sales: 100 },
  { country: 'France', sales: 50 },
];
let rows: Array<Record<string, unknown>> = DEFAULT_ROWS;
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
// A permissive geography used by the cross-filter-equality regression tests: its
// normalizer just stringifies the raw value, decoupling the feature id from real
// country-code lookups so we can drive `handleFeatureClick` with arbitrary raw values
// (e.g. a `Date`) without needing them to be valid country identifiers.
const flexGeographyDef = {
  label: 'Flex',
  fieldLabel: 'Value field',
  fieldHint: '',
  normalizer: (v: unknown) => (v == null ? null : String(v)),
  loader: () =>
    Promise.resolve({
      type: 'FeatureCollection',
      features: [],
    }),
};
// Mutable so individual tests can swap in a translated locale bundle — a plain `vi.mock`
// factory value is captured once at hoist time and can't be reassigned per-test.
let mockLocaleText = DEFAULT_STUDIO_LOCALE_TEXT;

vi.mock('../../../internals/StudioUIConfigContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../internals/StudioUIConfigContext')>();
  return {
    ...actual,
    useStudioGeographies: () => ({ world: geographyDef, flex: flexGeographyDef }),
    useStudioLocaleText: () => mockLocaleText,
  };
});

let mockState: StudioState;

const controller = {
  clearCrossFilter: vi.fn(),
  applyCrossFilter: vi.fn(),
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

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

/**
 * Flat override bag for `createState` — deliberately mirrors the pre-partition
 * `StudioState` shape as test-fixture sugar local to this file. `createState`
 * itself routes each field into the correct `doc`/`session`/`runtime` partition
 * of the real `StudioState` it returns.
 */
interface StateOverrides {
  dashboard?: Partial<StudioState['doc']['dashboard']>;
  pages?: StudioState['doc']['pages'];
  widgets?: StudioState['doc']['widgets'];
  dataSources?: StudioState['runtime']['dataSources'];
  relationships?: StudioState['doc']['relationships'];
  filters?: StudioState['doc']['filters'];
  expressionFields?: StudioState['doc']['expressionFields'];
  shell?: Partial<StudioState['session']['shell']>;
}

function createState(overrides?: StateOverrides): StudioState {
  return {
    doc: {
      schemaVersion: 1,
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
      relationships: overrides?.relationships ?? [],
      filters: overrides?.filters ?? [],
      expressionFields: overrides?.expressionFields ?? [],
    },
    session: {
      mode: 'edit',
      shell: {
        openDrawers: { data: false, compose: false, filters: false },
        selectedWidgetId: null,
        selectedFieldId: null,
        selectedSourceId: null,
        ...overrides?.shell,
      },
    },
    runtime: {
      dataSources: overrides?.dataSources ?? {},
    },
  } as unknown as StudioState;
}

async function renderMap(widget: StudioWidget) {
  const view = render(
    <ThemeProvider theme={createTheme()}>
      <StudioMapWidget widget={widget} dataSource={dataSource} pageId="page-1" />
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
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    rows = DEFAULT_ROWS;
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

// Regression coverage for the cross-filter equality fix in `handleFeatureClick`:
// it used to compare `String(activeCrossFilter?.value) === String(rawValue)` (plus a
// redundant, already-selector-guaranteed `sourceWidgetId` re-check) instead of the
// chart widget's `field === countryField && crossFilterValueEquals(...)` pattern.
describe('<StudioMapWidget /> cross-filter equality', () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    rows = DEFAULT_ROWS;
  });

  it('clears the cross-filter when the stored value is a Date and the clicked raw value is its ISO string', async () => {
    const iso = '2024-01-01T00:00:00.000Z';
    rows = [{ country: iso, sales: 10 }];
    const flexWidget = {
      ...baseWidget,
      config: { ...baseWidget.config, mapGeography: 'flex' },
    } as StudioWidget;
    mockState = createState({
      widgets: { 'map-1': flexWidget },
      dataSources: { sales: dataSource },
      filters: [
        {
          id: 'cf1',
          field: 'country',
          operator: 'equals',
          value: new Date(iso),
          scope: { kind: 'cross-filter', sourceWidgetId: 'map-1', pageId: 'page-1' },
        },
      ],
    });
    configureStudioContextMock({ getState: () => mockState, controller });

    await renderMap(flexWidget);
    const onShapeClick = getLatestOnShapeClick();
    act(() => {
      onShapeClick!(null, iso);
    });

    expect(controller.clearCrossFilter).toHaveBeenCalledWith('map-1');
    expect(controller.applyCrossFilter).not.toHaveBeenCalled();
  });

  it('toggles the filter off when clicking the already-active region again (plain string case)', async () => {
    mockState = createState({
      widgets: { 'map-1': baseWidget },
      dataSources: { sales: dataSource },
      filters: [
        {
          id: 'cf1',
          field: 'country',
          operator: 'equals',
          value: 'United States',
          scope: { kind: 'cross-filter', sourceWidgetId: 'map-1', pageId: 'page-1' },
        },
      ],
    });
    configureStudioContextMock({ getState: () => mockState, controller });

    await renderMap(baseWidget);
    const onShapeClick = getLatestOnShapeClick();
    act(() => {
      onShapeClick!(null, 'US');
    });

    expect(controller.clearCrossFilter).toHaveBeenCalledWith('map-1');
    expect(controller.applyCrossFilter).not.toHaveBeenCalled();
  });

  it('does not treat a cross-filter on a different field as active', async () => {
    mockState = createState({
      widgets: { 'map-1': baseWidget },
      dataSources: { sales: dataSource },
      filters: [
        {
          id: 'cf1',
          // Different field than `mapCountryField` ('country') — a stale cross-filter
          // from elsewhere with a coincidentally-equal string value.
          field: 'region',
          operator: 'equals',
          value: 'United States',
          scope: { kind: 'cross-filter', sourceWidgetId: 'map-1', pageId: 'page-1' },
        },
      ],
    });
    configureStudioContextMock({ getState: () => mockState, controller });

    await renderMap(baseWidget);
    const onShapeClick = getLatestOnShapeClick();
    act(() => {
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
});

describe('<StudioMapWidget /> legend aria-label localization', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}

        unobserve() {}

        disconnect() {}
      },
    );
    continuousColorLegendSpy.mockClear();
    mockState = createState({
      widgets: { 'map-1': baseWidget },
      dataSources: { sales: dataSource },
    });
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    rows = DEFAULT_ROWS;
    mockLocaleText = DEFAULT_STUDIO_LOCALE_TEXT;
  });

  function latestLegendAriaLabel() {
    const props = continuousColorLegendSpy.mock.calls.at(-1)?.[0] as {
      'aria-label'?: string;
    };
    return props?.['aria-label'];
  }

  it('uses the default English aria-label built from the field label and formatted min/max', async () => {
    await renderMap(baseWidget);
    expect(latestLegendAriaLabel()).toMatch(/^Sales color scale from .+ to .+$/);
  });

  it('localizes the legend aria-label instead of hardcoding the English pattern', async () => {
    mockLocaleText = { ...DEFAULT_STUDIO_LOCALE_TEXT, ...frLocaleText };
    await renderMap(baseWidget);
    const ariaLabel = latestLegendAriaLabel();
    expect(ariaLabel).toContain('Sales');
    expect(ariaLabel).not.toMatch(/color scale from/);
    expect(ariaLabel).toMatch(/^Échelle de couleurs de Sales de .+ à .+$/);
  });

  it('falls back to the localized chartDefaultSeriesLabel when mapValueField is unset', async () => {
    const widgetNoValue: StudioWidget = {
      ...baseWidget,
      config: { ...baseWidget.config, mapValueField: undefined },
    } as StudioWidget;
    mockState = createState({
      widgets: { 'map-1': widgetNoValue },
      dataSources: { sales: dataSource },
    });
    configureStudioContextMock({ getState: () => mockState, controller });

    await renderMap(widgetNoValue);
    expect(latestLegendAriaLabel()).toMatch(
      new RegExp(`^${DEFAULT_STUDIO_LOCALE_TEXT.chartDefaultSeriesLabel} color scale from`),
    );
  });
});
