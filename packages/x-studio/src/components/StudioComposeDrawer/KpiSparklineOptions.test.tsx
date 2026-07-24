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
