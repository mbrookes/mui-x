import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StudioDataSource, StudioState, StudioWidget, StudioWidgetOf } from '../../../models';
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
// `geoDataProviderSpy` also captures the `geoData`/`projection` props passed on each render so
// the geography-race regression test (finding 2.20) can assert which resolved topology ended up
// paired with which projection.
const geoDataProviderSpy = vi.fn();
vi.mock('@mui/x-charts-premium/ChartsGeoDataProviderPremium', () => ({
  Unstable_ChartsGeoDataProviderPremium: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => {
    geoDataProviderSpy(props);
    return <div>{children}</div>;
  },
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
// Mutable for the same reason — the geography-race/retry tests (finding 2.20) swap in
// custom, externally-controllable loaders per test.
let mockGeographies: Record<string, unknown> = { world: geographyDef, flex: flexGeographyDef };

vi.mock('../../../internals/StudioUIConfigContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../internals/StudioUIConfigContext')>();
  return {
    ...actual,
    useStudioGeographies: () => mockGeographies,
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
      <StudioMapWidget
        widget={widget as StudioWidgetOf<'map'>}
        dataSource={dataSource}
        pageId="page-1"
      />
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

// ─── mapValueField lookup: expression fields + cross-source fields (architecture
// review: the lookup only ever checked `dataSource.fields`, unlike the row-
// enrichment pipeline (`useWidgetRows.ts`), which already explicitly resolves a
// cross-source `mapValueField`/`mapCountryField`) ──────────────────────────────

describe('<StudioMapWidget /> value-field lookup — expression + cross-source fields', () => {
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

  it('resolves format/currency from an own-source expression (calculated) field', async () => {
    rows = [
      { country: 'United States', revenue: 1234.5 },
      { country: 'France', revenue: 500 },
    ];
    const widget: StudioWidget = {
      ...baseWidget,
      config: { ...baseWidget.config, mapValueField: 'revenue' },
    } as StudioWidget;
    mockState = createState({
      widgets: { 'map-1': widget },
      // `revenue` is NOT a physical field on the data source — only reachable via
      // expressionFields, mirroring a calculated column.
      dataSources: { sales: dataSource },
      expressionFields: [
        {
          id: 'revenue',
          label: 'Revenue',
          sourceId: 'sales',
          isMeasure: false,
          expression: { type: 'number', value: 0 },
          // The field's own output-type override (distinct from `expression.type`,
          // which describes the literal expression node) — `formatMapValueCompact`
          // gates currency formatting on this.
          type: 'number',
          format: 'currency',
        },
      ] as unknown as StudioState['doc']['expressionFields'],
    });
    configureStudioContextMock({ getState: () => mockState, controller });

    await renderMap(widget);

    // Before the fix, an unresolved `fieldDef` meant `formatMapValueCompact` never
    // applied currency formatting — the aria-label's min/max would be plain numbers
    // with no currency symbol.
    expect(latestLegendAriaLabel()).toMatch(/\$/);
  });

  it('resolves format/currency from a cross-source field via mapValueSourceId', async () => {
    rows = [
      { country: 'United States', lifetimeValue: 9999.99 },
      { country: 'France', lifetimeValue: 42 },
    ];
    const widget: StudioWidget = {
      ...baseWidget,
      config: {
        ...baseWidget.config,
        mapValueField: 'lifetimeValue',
        mapValueSourceId: 'customers',
      },
    } as StudioWidget;
    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'lifetimeValue', label: 'Lifetime Value', type: 'number', format: 'currency' },
      ],
      rows: [],
    };
    mockState = createState({
      widgets: { 'map-1': widget },
      dataSources: { sales: dataSource, customers: customersSource },
    });
    configureStudioContextMock({ getState: () => mockState, controller });

    await renderMap(widget);

    expect(latestLegendAriaLabel()).toMatch(/\$/);
  });
});

// Regression coverage for finding 1.4: the map used to hand-roll
// `parseFloat(String(rawValue ?? 0))`, which coerced null/undefined to 0 (inflating avg
// denominators / dragging min) and dropped booleans via `parseFloat("true") → NaN`. It now
// routes cells through the shared `coerceAggregateValue` policy (null/non-numeric skipped,
// booleans → 0/1), matching the KPI widget. We read the aggregated extent off the legend's
// aria-label (`… color scale from <min> to <max>`), which is derived from min/max value.
describe('<StudioMapWidget /> shared aggregation policy', () => {
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
    controller.clearCrossFilter.mockClear();
    controller.applyCrossFilter.mockClear();
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

  async function renderWithConfig(configOverride: Record<string, unknown>) {
    const widget = {
      ...baseWidget,
      config: { ...baseWidget.config, ...configOverride },
    } as StudioWidget;
    mockState = createState({
      widgets: { 'map-1': widget },
      dataSources: { sales: dataSource },
    });
    configureStudioContextMock({ getState: () => mockState, controller });
    await renderMap(widget);
  }

  it('skips null cells for avg instead of coercing them to 0', async () => {
    // US: [10, null, 20] → avg 15 (not (10+0+20)/3 = 10); France: [30] → avg 30.
    rows = [
      { country: 'United States', sales: 10 },
      { country: 'United States', sales: null },
      { country: 'United States', sales: 20 },
      { country: 'France', sales: 30 },
    ];
    await renderWithConfig({ mapAggregation: 'avg' });
    // Legend extent spans the aggregated region values: min 15 (US), max 30 (France).
    expect(latestLegendAriaLabel()).toContain('from 15 to 30');
  });

  it('coerces booleans to 0/1 instead of dropping them via parseFloat("true") → NaN', async () => {
    // A single region with boolean values true/false → avg 0.5. The old parseFloat path
    // dropped both (NaN), leaving the region empty and rendering the no-data overlay.
    rows = [
      { country: 'United States', sales: true },
      { country: 'United States', sales: false },
    ];
    await renderWithConfig({ mapAggregation: 'avg' });
    // Single region → degenerate [0, max] scale, so the extent is "from 0 to 0.5".
    expect(latestLegendAriaLabel()).toContain('to 0.5');
  });

  // ─── 'count' means COUNT(*), not COUNT(mapValueField) (finding 2.7) ─────────

  it('counts every row for a region even when mapValueField is null/non-numeric — count is row-based', async () => {
    // US has 3 rows but only 1 usable `sales` value; France has 1 row, unusable.
    // Under the old (buggy) policy, rows whose value was null/non-numeric were
    // skipped before counting, so France (all-null) disappeared from the map
    // entirely and US counted only 1 instead of 3.
    rows = [
      { country: 'United States', sales: 10 },
      { country: 'United States', sales: null },
      { country: 'United States', sales: 'not-a-number' },
      { country: 'France', sales: null },
    ];
    await renderWithConfig({ mapAggregation: 'count' });
    // US count = 3 (all rows), France count = 1 (its single row, despite the
    // null measure) — extent is "from 1 to 3", matching KPI/chart 'count' semantics.
    expect(latestLegendAriaLabel()).toContain('from 1 to 3');
  });
});

// Regression coverage for finding 2.21: `normalize` merges mixed country-code encodings
// ('US', 'USA', 'United States') into one display region, but clicking used to emit
// `equals <first raw variant>` — a downstream widget's filter would then only match a
// SUBSET of what the clicked region visibly aggregated. Clicking a merged region must now
// emit an `in` filter over every raw variant that merged into it.
describe('<StudioMapWidget /> merged-region cross-filter emission', () => {
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

  it('emits an `in` filter over every raw variant merged into the clicked region', async () => {
    // 'US', 'USA', and 'United States' all normalize to the same alpha-2 ('US') region.
    rows = [
      { country: 'US', sales: 10 },
      { country: 'USA', sales: 20 },
      { country: 'United States', sales: 30 },
      { country: 'France', sales: 5 },
    ];

    await renderMap(baseWidget);
    const onShapeClick = getLatestOnShapeClick();
    act(() => {
      onShapeClick!(null, 'US');
    });

    expect(controller.applyCrossFilter).toHaveBeenCalledWith(
      'map-1',
      'country',
      ['US', 'USA', 'United States'],
      'sales',
      'in',
    );
    expect(controller.clearCrossFilter).not.toHaveBeenCalled();
  });

  it('toggles the merged-region filter off when it is already active over all its variants', async () => {
    rows = [
      { country: 'US', sales: 10 },
      { country: 'USA', sales: 20 },
    ];
    mockState = createState({
      widgets: { 'map-1': baseWidget },
      dataSources: { sales: dataSource },
      filters: [
        {
          id: 'cf1',
          field: 'country',
          operator: 'in',
          value: ['US', 'USA'],
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

  it('still emits a plain equals filter (unchanged call shape) when only one raw variant merges', async () => {
    rows = [{ country: 'United States', sales: 100 }];

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
  });
});

// Regression coverage for finding 2.20: `loader().then(setGeography)` had no staleness guard
// (a stale, superseded response could overwrite a newer one — landing a stale topology under
// the CURRENT projection) and no error handling (a rejected loader left the widget permanently
// blank with no way to retry).
describe('<StudioMapWidget /> geography loader staleness & error recovery', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}

        unobserve() {}

        disconnect() {}
      },
    );
    geoDataProviderSpy.mockClear();
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
    mockGeographies = { world: geographyDef, flex: flexGeographyDef };
  });

  function latestGeoDataProps() {
    return geoDataProviderSpy.mock.calls.at(-1)?.[0] as
      | { geoData?: unknown; projection?: string }
      | undefined;
  }

  it('discards a stale geography response that resolves after a newer request has superseded it', async () => {
    const worldDeferreds = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()];
    const usaDeferred = Promise.withResolvers<unknown>();
    let worldCallCount = 0;
    const worldGeo1 = { type: 'FeatureCollection', features: [] };
    const worldGeo2 = { type: 'FeatureCollection', features: [] };
    const usaGeo = { type: 'FeatureCollection', features: [] };

    mockGeographies = {
      world: {
        label: 'World',
        fieldLabel: 'Country field',
        fieldHint: '',
        loader: () => worldDeferreds[worldCallCount++].promise,
      },
      usa: {
        label: 'USA',
        fieldLabel: 'State field',
        fieldHint: '',
        loader: () => usaDeferred.promise,
      },
    };

    const worldWidget = baseWidget;
    const usaWidget = {
      ...baseWidget,
      config: { ...baseWidget.config, mapGeography: 'usa' },
    } as StudioWidget;

    const view = render(
      <ThemeProvider theme={createTheme()}>
        <StudioMapWidget
          widget={worldWidget as StudioWidgetOf<'map'>}
          dataSource={dataSource}
          pageId="page-1"
        />
      </ThemeProvider>,
    );

    // Resolve the initial 'world' load so the widget starts fully mounted.
    await act(async () => {
      worldDeferreds[0].resolve(worldGeo1);
      await Promise.resolve();
    });
    expect(latestGeoDataProps()?.geoData).toBe(worldGeo1);

    // Toggle to 'usa' (starts a slow load), then immediately back to 'world' (starts a
    // second, faster load) — mirrors "fast world → usa → world" toggling.
    view.rerender(
      <ThemeProvider theme={createTheme()}>
        <StudioMapWidget
          widget={usaWidget as StudioWidgetOf<'map'>}
          dataSource={dataSource}
          pageId="page-1"
        />
      </ThemeProvider>,
    );
    view.rerender(
      <ThemeProvider theme={createTheme()}>
        <StudioMapWidget
          widget={worldWidget as StudioWidgetOf<'map'>}
          dataSource={dataSource}
          pageId="page-1"
        />
      </ThemeProvider>,
    );

    // The second 'world' request resolves first (as it would in practice, being cheap/cached).
    await act(async () => {
      worldDeferreds[1].resolve(worldGeo2);
      await Promise.resolve();
    });
    expect(latestGeoDataProps()?.geoData).toBe(worldGeo2);
    expect(latestGeoDataProps()?.projection).toBe('naturalEarth1');

    // ...then the stale 'usa' request resolves LATE. Without the staleness guard this would
    // overwrite `geography` with the USA topology while still rendering under the world
    // projection — the exact race in finding 2.20.
    await act(async () => {
      usaDeferred.resolve(usaGeo);
      await Promise.resolve();
    });
    expect(latestGeoDataProps()?.geoData).toBe(worldGeo2);
    expect(latestGeoDataProps()?.projection).toBe('naturalEarth1');
  });

  it('shows a visible error state on a rejected loader, and retries on a later request for the same key', async () => {
    const failingDeferred = Promise.withResolvers<unknown>();
    const retryGeo = { type: 'FeatureCollection', features: [] };
    let loadCount = 0;
    mockGeographies = {
      world: {
        label: 'World',
        fieldLabel: 'Country field',
        fieldHint: '',
        loader: () => {
          loadCount += 1;
          return loadCount === 1 ? failingDeferred.promise : Promise.resolve(retryGeo);
        },
      },
      usa: {
        label: 'USA',
        fieldLabel: 'State field',
        fieldHint: '',
        loader: () => Promise.resolve({ type: 'FeatureCollection', features: [] }),
      },
    };

    const worldWidget = baseWidget;
    const usaWidget = {
      ...baseWidget,
      config: { ...baseWidget.config, mapGeography: 'usa' },
    } as StudioWidget;

    const view = render(
      <ThemeProvider theme={createTheme()}>
        <StudioMapWidget
          widget={worldWidget as StudioWidgetOf<'map'>}
          dataSource={dataSource}
          pageId="page-1"
        />
      </ThemeProvider>,
    );

    await act(async () => {
      failingDeferred.reject(new Error('network error'));
      // Rejections need an extra microtask turn to propagate through the promise chain.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.getByRole('alert')).toBeTruthy();
    expect(loadCount).toBe(1);

    // Switch away and back to the SAME ('world') geography key. This only reloads if the
    // rejection reset `loadedGeoRef` — otherwise the effect's `loadedGeoRef.current ===
    // mapGeography` guard would skip the reload forever, leaving the widget blank for good.
    view.rerender(
      <ThemeProvider theme={createTheme()}>
        <StudioMapWidget
          widget={usaWidget as StudioWidgetOf<'map'>}
          dataSource={dataSource}
          pageId="page-1"
        />
      </ThemeProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(
      <ThemeProvider theme={createTheme()}>
        <StudioMapWidget
          widget={worldWidget as StudioWidgetOf<'map'>}
          dataSource={dataSource}
          pageId="page-1"
        />
      </ThemeProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(loadCount).toBe(2);
    expect(latestGeoDataProps()?.geoData).toBe(retryGeo);
  });
});
