import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioFilterState, StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { KpiSparklineOptions } from './KpiSparklineOptions';

const controller = {
  updateWidgetConfig: vi.fn(),
};

const mockState = {
  doc: {
    dashboard: { id: 'dashboard-1', title: 'Dashboard', activePageId: 'page-1' },
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'kpi',
        sourceId: 'orders',
        title: 'Orders',
        config: { kpiSparklinePlotType: 'gauge', kpiSparklineGaugeMax: 100 } as StudioWidgetConfig,
      },
    },
    filters: [] as StudioFilterState[],
    relationships: [],
    expressionFields: [],
  },
  runtime: {
    dataSources: {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'createdAt', label: 'Created at', type: 'date' },
        ],
        rows: [],
      },
    },
  },
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

function renderGaugeMax(config: Partial<StudioWidgetConfig> = {}) {
  mockState.doc.widgets['widget-1'] = {
    id: 'widget-1',
    kind: 'kpi',
    sourceId: 'orders',
    title: 'Orders',
    config: {
      kpiSparklinePlotType: 'gauge',
      kpiSparklineGaugeMax: 100,
      ...config,
    } as StudioWidgetConfig,
  };
  return render(
    <KpiSparklineOptions widgetId="widget-1" config={mockState.doc.widgets['widget-1'].config} />,
  );
}

// Finding 1.14: the gauge-max input used to reject anything not `> 0` on every
// keystroke, so the field could never be cleared and retyped. It now buffers the
// displayed text locally and only parses/validates/commits on blur.
describe('KpiSparklineOptions gauge max input (finding 1.14)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('allows clearing the gauge max field while typing, without committing', () => {
    renderGaugeMax();
    const input = screen.getByLabelText('Target') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits a new value once retyped and blurred', () => {
    renderGaugeMax();
    const input = screen.getByLabelText('Target') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '250' } });
    expect(input.value).toBe('250');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      kpiSparklineGaugeMax: 250,
    });
  });

  it('reverts to the last committed value when blurred empty', () => {
    renderGaugeMax();
    const input = screen.getByLabelText('Target') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('100');
  });

  it('reverts a non-positive value instead of committing it', () => {
    renderGaugeMax();
    const input = screen.getByLabelText('Target') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('100');
  });
});

// Architecture review finding 2.8: date-field derivation now goes through the
// shared `buildSourceFieldEntries` catalog helper instead of a hand-rolled fold —
// this is a regression check that temporal fields from the primary source (and a
// directly related source) still surface correctly through that helper.
describe('KpiSparklineOptions date-field derivation (finding 2.8)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'kpi',
      sourceId: 'orders',
      title: 'Orders',
      config: {} as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it("offers the primary source's date field in the time-field picker", async () => {
    const { user } = render(
      <KpiSparklineOptions widgetId="widget-1" config={mockState.doc.widgets['widget-1'].config} />,
    );
    const picker = screen.getByLabelText('Time field');
    await user.click(picker);
    // Name includes the field-type icon's aria-label prefix (e.g. "Date Created at").
    expect(await screen.findByRole('option', { name: /Created at$/ })).toBeVisible();
  });
});

// Tier1 crash-site regression: a `StudioRelationship.sourceId`/`.targetId` equal to
// "constructor" (a persisted/doc-authored id, reachable via `loadSerializedState` or the AI
// tool loop) used to make `dataSources[relatedId]` resolve the inherited
// `Object.prototype.constructor` function instead of `undefined`. That truthy non-source
// value passed the `if (!relSource) continue` guard, and `addSourceDateFields` then threw
// inside `buildSourceFieldEntries`'s unguarded `source.fields.flatMap(...)`, unmounting the
// whole `<Studio>` tree via the compose drawer (which had no error boundary). The lookup is
// now guarded with `Object.hasOwn`, matching `context/selectors.ts`'s `makeSelectWidgetSource`.
describe('KpiSparklineOptions hostile relationship id (Tier1 crash fix)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    mockState.doc.dashboard = { id: 'dashboard-1', title: 'Dashboard', activePageId: 'page-1' };
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'kpi',
      sourceId: 'orders',
      title: 'Orders',
      config: {} as StudioWidgetConfig,
    };
    mockState.doc.relationships = [
      { id: 'rel-1', type: 'many-to-one', sourceId: 'orders', targetId: 'constructor' },
    ] as unknown as typeof mockState.doc.relationships;
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  afterEach(() => {
    mockState.doc.relationships = [];
  });

  it('does not throw when a relationship targetId is a prototype-chain key like "constructor"', () => {
    expect(() =>
      render(
        <KpiSparklineOptions
          widgetId="widget-1"
          config={mockState.doc.widgets['widget-1'].config}
        />,
      ),
    ).not.toThrow();
    // No data source is registered under "constructor", so only the primary source's own
    // date field is offered — the hostile related id contributes nothing rather than crashing.
    expect(screen.getByLabelText('Time field')).not.toBe(null);
  });
});

// Finding 3: the auto-detected date filter must be scoped through the SAME authority
// (`selectFiltersForWidget`) the KPI widget itself uses to resolve its effective date
// filter at render time — not a raw, unscoped scan — so this setup-panel preview never
// claims a date filter is driving the sparkline when the widget itself wouldn't see it
// (and vice versa).
describe('KpiSparklineOptions auto-date-filter scoping (finding 3)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    mockState.doc.dashboard = { id: 'dashboard-1', title: 'Dashboard', activePageId: 'page-1' };
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'kpi',
      sourceId: 'orders',
      title: 'Orders',
      config: {} as StudioWidgetConfig,
    };
  });

  afterEach(() => {
    mockState.doc.filters = [];
  });

  it('falls back to the manual Time-field picker for a date filter scoped to a DIFFERENT page', () => {
    const otherPageFilter: StudioFilterState = {
      id: 'f-1',
      field: 'createdAt',
      fieldType: 'date',
      scope: { kind: 'page', pageId: 'page-2' },
      operator: 'between',
      value: { from: '2026-01-01', to: '2026-01-31' },
    } as unknown as StudioFilterState;
    mockState.doc.filters = [otherPageFilter];
    configureStudioContextMock({ getState: () => mockState, controller });

    render(
      <KpiSparklineOptions widgetId="widget-1" config={mockState.doc.widgets['widget-1'].config} />,
    );

    // The widget itself is mounted on page-1 and would never see page-2's date filter
    // (`selectFiltersForWidget` excludes it), so this preview must not claim it is
    // auto-driving the sparkline either.
    expect(screen.getByLabelText('Time field')).not.toBe(null);
    expect(screen.queryByText(/Using date filter/)).toBe(null);
  });

  it("treats a date filter scoped to the KPI's own active page as auto-detected", () => {
    const ownPageFilter: StudioFilterState = {
      id: 'f-2',
      field: 'createdAt',
      fieldType: 'date',
      scope: { kind: 'page', pageId: 'page-1' },
      operator: 'between',
      value: { from: '2026-01-01', to: '2026-01-31' },
    } as unknown as StudioFilterState;
    mockState.doc.filters = [ownPageFilter];
    configureStudioContextMock({ getState: () => mockState, controller });

    render(
      <KpiSparklineOptions widgetId="widget-1" config={mockState.doc.widgets['widget-1'].config} />,
    );

    expect(screen.getByText(/Using date filter/)).not.toBe(null);
    expect(screen.queryByLabelText('Time field')).toBe(null);
  });
});

// Same crash class as the relationship-id case above, but on the widget's OWN
// `sourceId` — the unguarded sibling that sat 50 lines above the guarded one. A
// doc/AI-authored `sourceId: "constructor"` resolved the inherited `Object`
// constructor, whose `.fields` is `undefined`, so `!source` was false and
// `buildSourceFieldEntries(source, …)` threw — replacing the entire setup panel
// (source picker included) with the error fallback, leaving the widget unrepairable.
describe('KpiSparklineOptions hostile widget sourceId', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    mockState.doc.dashboard = { id: 'dashboard-1', title: 'Dashboard', activePageId: 'page-1' };
    mockState.doc.relationships = [];
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'kpi',
      sourceId: 'constructor',
      title: 'Orders',
      config: {} as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('does not throw when the widget sourceId is a prototype-chain key', () => {
    expect(() =>
      render(
        <KpiSparklineOptions
          widgetId="widget-1"
          config={mockState.doc.widgets['widget-1'].config}
        />,
      ),
    ).not.toThrow();
    // No source resolves, so the panel still renders its (empty) manual time-field picker.
    expect(screen.getByLabelText('Time field')).not.toBe(null);
  });

  it('does not throw when the widgetId itself is a prototype-chain key', () => {
    expect(() =>
      render(<KpiSparklineOptions widgetId="toString" config={{} as StudioWidgetConfig} />),
    ).not.toThrow();
  });
});

// ─── Finding 7: the stored sparkline source id must disambiguate the picker ────
//
// The time-field list spans the primary source AND every relationship neighbour in both
// directions, so two sources sharing a field id (here `createdAt`) is likely. Without
// `valueSourceId` the picker resolved the stored id by a bare-id lookup in
// `Object.values(dataSources)` order and could display a DIFFERENT source's field — with its
// label, group and field-type icon — as if it were the configured value, so "confirming"
// what was shown silently re-pointed the sparkline at another source's field.
describe('KpiSparklineOptions time-field source disambiguation (finding 7)', () => {
  const previousSources = mockState.runtime.dataSources;

  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    mockState.runtime.dataSources = {
      // Inserted first, so a bare-id lookup over insertion order resolves THIS one.
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [{ id: 'createdAt', label: 'Order Date', type: 'date' }],
        rows: [],
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [{ id: 'createdAt', label: 'Signup Date', type: 'date' }],
        rows: [],
      },
    } as typeof previousSources;
    mockState.doc.relationships = [
      { id: 'rel-1', type: 'many-to-one', sourceId: 'orders', targetId: 'customers' },
    ] as unknown as typeof mockState.doc.relationships;
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  afterEach(() => {
    mockState.runtime.dataSources = previousSources;
    mockState.doc.relationships = [];
  });

  it('displays the field from the source recorded in kpiSparklineSourceId, not the first same-id match', () => {
    const config = {
      kpiSparklineField: 'createdAt',
      kpiSparklineSourceId: 'customers',
    } as StudioWidgetConfig;
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'kpi',
      sourceId: 'orders',
      title: 'Orders',
      config,
    };

    render(<KpiSparklineOptions widgetId="widget-1" config={config} />);

    const input = screen.getByLabelText('Time field') as HTMLInputElement;
    // Both labels are qualified with their source ("Customers · Signup Date") because the
    // two sources collide on the label-uniqueness check — the point is WHICH one is shown.
    expect(input.value).toContain('Signup Date');
    expect(input.value).not.toContain('Order Date');
  });
});

// ─── Finding 2: the sparkline comboboxes must have a programmatic name ─────────
//
// MUI's `Select` only emits `aria-labelledby` when handed an explicit `labelId`, and
// `InputLabel` does not derive an `id`/`htmlFor` from `FormControl` context — so these
// comboboxes previously announced only their own display text ("Line"), with nothing saying
// which setting that value belongs to. `combobox` is not a name-from-content role, so
// strictly there was no accessible name at all.
describe('KpiSparklineOptions combobox accessible names (finding 2)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'kpi',
      sourceId: 'orders',
      title: 'Orders',
      config: { kpiSparklinePlotType: 'line' } as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('names the granularity and plot-type selects after their visible labels', () => {
    render(
      <KpiSparklineOptions widgetId="widget-1" config={mockState.doc.widgets['widget-1'].config} />,
    );

    expect(screen.getByRole('combobox', { name: 'Granularity' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Plot type' })).toBeVisible();
  });
});
// ─── M5: the panel and the widget answer "which date field?" identically ─────
//
// The panel used to run its own scan (first in-scope filter matching own OR joined date
// fields) with no notion of the widget's later tiers, so it could replace the Time-field
// picker with "Using date filter on X" for a filter the widget then did not use — leaving the
// sparkline blank and the user with no control to fix it. It now delegates to
// `resolveKpiDateField`, the single rule the rendered widget uses, and hides the picker
// exactly when that rule reports `origin === 'filter'`.
describe('KpiSparklineOptions date-field rule shared with the widget (M5)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    mockState.doc.dashboard = {
      id: 'dashboard-1',
      title: 'Dashboard',
      activePageId: 'page-1',
    };
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'kpi',
      sourceId: 'orders',
      title: 'Orders',
      config: {} as StudioWidgetConfig,
    };
  });

  afterEach(() => {
    mockState.doc.filters = [];
  });

  it('keeps the Time-field picker for an in-scope filter on a field the widget cannot resolve', () => {
    // A page filter on a RELATED source's date column, with no `fieldType` to identify it as
    // a date and no matching column on the widget's own source: `findDateFilter` does not
    // select it, so the widget resolves its time field from config/own-source instead. The
    // panel must not claim the filter is driving the sparkline.
    mockState.doc.filters = [
      {
        id: 'f-cross',
        field: 'shippedAt',
        filterSourceId: 'shipments',
        scope: { kind: 'page', pageId: 'page-1' },
        operator: 'between',
        value: { from: '2026-01-01', to: '2026-01-31' },
      },
    ] as unknown as StudioFilterState[];
    configureStudioContextMock({ getState: () => mockState, controller });

    render(
      <KpiSparklineOptions widgetId="widget-1" config={mockState.doc.widgets['widget-1'].config} />,
    );

    expect(screen.getByLabelText('Time field')).not.toBe(null);
    expect(screen.queryByText(/Using date filter/)).toBe(null);
  });

  it('keeps the Time-field picker when only an explicitly configured field resolves', () => {
    // No in-scope date filter at all: the widget resolves through the CONFIG tier, so the
    // picker — the control that writes that config — must stay on screen.
    mockState.doc.filters = [];
    mockState.doc.widgets['widget-1'] = {
      ...mockState.doc.widgets['widget-1'],
      config: { kpiSparklineField: 'createdAt' } as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });

    render(
      <KpiSparklineOptions widgetId="widget-1" config={mockState.doc.widgets['widget-1'].config} />,
    );

    expect(screen.getByLabelText('Time field')).not.toBe(null);
    expect(screen.queryByText(/Using date filter/)).toBe(null);
  });
});
