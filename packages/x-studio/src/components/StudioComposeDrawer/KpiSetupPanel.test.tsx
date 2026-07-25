import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { StudioController } from '../../store/StudioController';
import { KpiSetupPanel } from './KpiSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
  setWidgetDateRange: vi.fn(),
};

const mockState = {
  doc: {
    dashboard: { id: 'dashboard-1', title: 'Dashboard', activePageId: 'page-1' },
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'kpi',
        sourceId: 'orders',
        config: {
          kpiValueField: 'total',
          kpiAggregation: 'sum',
        } as StudioWidgetConfig,
      },
    },
    relationships: [],
    expressionFields: [],
    filters: [],
  },
  runtime: {
    dataSources: {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'total', label: 'Total', type: 'number' },
          { id: 'orderDate', label: 'Order Date', type: 'date' },
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

describe('KpiSetupPanel', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('shows the value field selector with the configured field', () => {
    render(<KpiSetupPanel widgetId="widget-1" />);

    expect((screen.getByLabelText('Value field') as HTMLInputElement).value).toBe('Total');
  });

  it('sets the value field and derives a default aggregation for a fresh KPI', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: {},
      };

      const { user } = render(<KpiSetupPanel widgetId="widget-1" />);

      const valueFieldInput = screen.getByLabelText('Value field');
      await user.click(valueFieldInput);
      // Name includes the field-type icon's aria-label prefix (e.g. "Number Total").
      const totalOption = await screen.findByRole('option', { name: /Total$/ });
      await user.click(totalOption);

      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
        kpiValueField: 'total',
        kpiAggregation: 'sum',
      });
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
    }
  });

  it('changes the aggregation for the selected value field', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<KpiSetupPanel widgetId="widget-1" />);

    // The Aggregation <Select> isn't linked to its <InputLabel> via aria-labelledby, so its
    // accessible name is its own display text ("Sum") rather than "Aggregation" — locate it
    // by that displayed value instead.
    await user.click(screen.getByText('Sum', { selector: '[role="combobox"]' }));
    const averageOption = await screen.findByRole('option', { name: 'Average' });
    await user.click(averageOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      kpiAggregation: 'avg',
    });
  });

  it('toggles the trend feature on', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<KpiSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('switch', { name: 'Trend' }));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { kpiTrend: true });
  });

  // Tier-1 finding #1 (ARCHITECTURE_REVIEW.md) notes KpiSetupPanel.tsx:397-441 calls
  // controller.setWidgetDateRange for widget-level date-range presets. This test only
  // verifies the setup panel calls that controller method with the right arguments —
  // it does not assert (or attempt to fix) the separately tracked preset-resolution bug.
  it('enables the widget-level date range and seeds a default preset via controller.setWidgetDateRange', async () => {
    controller.setWidgetDateRange.mockClear();
    const { user } = render(<KpiSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('switch', { name: 'Date range' }));

    expect(controller.setWidgetDateRange).toHaveBeenCalledWith(
      'widget-1',
      'orderDate',
      'orders',
      'date',
      'last_12_months',
    );
  });

  // Pinning tests (finding 2.3): KPIs are summary metrics with no "highlight" visual, so
  // the Interactions section only offers Filter/None (unlike Chart/Grid's three-way
  // toggle), and legacy-persisted `crossFilterMode: 'cross-highlight'` configs must still
  // display as "Filter" selected. Written before the CrossFilterModeSection extraction so
  // the extraction is provably behavior-preserving.
  it('only renders the Filter/None interaction buttons (no Highlight)', () => {
    render(<KpiSetupPanel widgetId="widget-1" />);

    expect(screen.getByRole('button', { name: 'Filter' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'None' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Highlight' })).toBeNull();
  });

  it('shows Filter selected for a widget with a legacy stored crossFilterMode: cross-highlight', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];

    try {
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: { ...previousWidget.config, crossFilterMode: 'cross-highlight' },
      };

      render(<KpiSetupPanel widgetId="widget-1" />);

      expect(screen.getByRole('button', { name: 'Filter', pressed: true })).toBeVisible();
      expect(screen.getByRole('button', { name: 'None', pressed: false })).toBeVisible();
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
    }
  });

  it('commits crossFilterMode: none when the already-selected Filter button is deselected', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    controller.updateWidgetConfig.mockClear();

    try {
      // Start from a widget already in 'cross-filter' mode so Filter renders selected —
      // clicking an already-selected button in an exclusive ToggleButtonGroup deselects it.
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: { ...previousWidget.config, crossFilterMode: 'cross-filter' },
      };

      const { user } = render(<KpiSetupPanel widgetId="widget-1" />);

      expect(screen.getByRole('button', { name: 'Filter', pressed: true })).toBeVisible();

      await user.click(screen.getByRole('button', { name: 'Filter' }));

      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
        crossFilterMode: 'none',
      });
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
    }
  });

  // Finding 2.6: the aggregation-options derivation is shared between the render path
  // and the field `onChange`. A string value field must offer Count and Count Distinct
  // (count_distinct is meaningful for any field type, per gridSummary.ts/GridSetupPanel's
  // STRING_AGGREGATIONS — see finding 1), and NOT be locked to a single option, proving the
  // shared derivation is used on render.
  it('offers Count and Count Distinct (unlocked) for a string value field (finding 2.6)', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousFields = mockState.runtime.dataSources.orders.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [...previousFields, { id: 'status', label: 'Status', type: 'string' }],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: { kpiValueField: 'status', kpiAggregation: 'count' },
      };

      render(<KpiSetupPanel widgetId="widget-1" />);

      const combo = screen.getByText('Count', { selector: '[role="combobox"]' });
      expect(combo).toBeVisible();
      // Two valid options (Count, Distinct) for a string field — the select must NOT be
      // locked/disabled the way a genuinely single-option set (e.g. no value field) is.
      // MUI's Select only ever sets `aria-disabled="true"` when actually disabled; an
      // enabled combobox omits the attribute entirely (`null`), it does not render "false".
      expect(combo.getAttribute('aria-disabled')).not.toBe('true');
      // A valid stored aggregation is left untouched (no write-back).
      expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousFields,
      };
    }
  });

  // Regression coverage: the KPI value field's `type` is doc-authored (it can come from an
  // expression field with no runtime enum validation on this path). `deriveKpiAggregationOptions`
  // used to index the `aggregations` plain object with a bare `aggregations[fieldType]`, so a
  // field type colliding with an inherited `Object.prototype` member (e.g. "toString") resolved
  // a truthy function instead of `undefined` — the `?? countOnly` fallback never fired, and
  // `aggregationOptions.some(...)` then threw `TypeError: aggregationOptions.some is not a
  // function` because "options" was actually a function. Rendering the panel must not throw
  // and must fall back to the count-only option set.
  it('falls back to count-only aggregation options for a value field type colliding with an inherited Object.prototype member', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousFields = mockState.runtime.dataSources.orders.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [...previousFields, { id: 'weird', label: 'Weird', type: 'toString' as any }],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: { kpiValueField: 'weird', kpiAggregation: 'count' },
      };

      expect(() => render(<KpiSetupPanel widgetId="widget-1" />)).not.toThrow();

      // Only "Count" is offered — the count-only fallback, not an inherited function.
      expect(screen.getByText('Count', { selector: '[role="combobox"]' })).toBeVisible();
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousFields,
      };
    }
  });

  // Finding 1 (Tier 1, non-undoable data destruction): `count_distinct` is a valid,
  // schema-supported (`StudioKpiAggregation`) and renderer-supported (`computeAggregate`)
  // KPI aggregation, but was previously omitted from every option list `getKpiAggregations`
  // returned. Because `storedAggIsValid` (and thus the render-time repair effect) is keyed
  // off that option list, a persisted `kpiAggregation: 'count_distinct'` looked invalid on
  // every render and got silently, non-undoably rewritten to `aggregationOptions[0]` the
  // moment the panel mounted — destroying a valid, working KPI config just by opening the
  // compose drawer. Assert the numeric-field case (the concrete repro from the bug report,
  // "distinct regions" — though `region` would really be a string field, the destructive
  // path is type-independent) leaves the stored config completely untouched.
  it('does NOT rewrite a stored count_distinct aggregation on render (finding 1)', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: { kpiValueField: 'total', kpiAggregation: 'count_distinct' },
      };

      render(<KpiSetupPanel widgetId="widget-1" />);

      // The critical assertion: no repair write-back at all — the render-time effect
      // must recognize 'count_distinct' as valid for a numeric field and leave the doc
      // alone (not even a no-op `{ undoable: false }` commit).
      expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
      // The select must actually display "Distinct" (the stored value), not a silently
      // substituted fallback like "Sum".
      expect(screen.getByText('Distinct', { selector: '[role="combobox"]' })).toBeVisible();
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
    }
  });

  // Finding 1, string-field variant: the same non-destruction guarantee for a string
  // value field, which is the type most likely to carry a genuine "distinct count"
  // measure (e.g. "distinct regions").
  it('does NOT rewrite a stored count_distinct aggregation for a string field on render (finding 1)', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousFields = mockState.runtime.dataSources.orders.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [...previousFields, { id: 'region', label: 'Region', type: 'string' }],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: { kpiValueField: 'region', kpiAggregation: 'count_distinct' },
      };

      render(<KpiSetupPanel widgetId="widget-1" />);

      expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
      expect(screen.getByText('Distinct', { selector: '[role="combobox"]' })).toBeVisible();
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousFields,
      };
    }
  });

  // Finding 3.6: when the stored aggregation is invalid for the value field's type,
  // the panel repairs the doc (write-back) so the widget renderer — which reads the
  // doc — no longer disagrees with the displayed fallback.
  it('writes back a valid aggregation when the stored one is invalid for the field type (finding 3.6)', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousFields = mockState.runtime.dataSources.orders.fields;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: [...previousFields, { id: 'status', label: 'Status', type: 'string' }],
      };
      // 'sum' is invalid for a string field (only Count applies).
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: { kpiValueField: 'status', kpiAggregation: 'sum' },
      };

      render(<KpiSetupPanel widgetId="widget-1" />);

      // Finding 2.4: the repair write-back must be non-undoable — it fires from
      // merely rendering the panel, not from a user gesture.
      expect(controller.updateWidgetConfig).toHaveBeenCalledWith(
        'widget-1',
        { kpiAggregation: 'count' },
        { undoable: false },
      );
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = {
        ...mockState.runtime.dataSources.orders,
        fields: previousFields,
      };
    }
  });

  // Finding 1.7: `selectedField` (which feeds the aggregation-options derivation and the
  // render-time repair effect) must resolve the value field scoped to the widget's OWN
  // source. A reachable related source that sorts EARLIER by label ("Aaa" < "Orders") and
  // shares the 'total' field id — but as a STRING — would otherwise win the bare-id lookup,
  // make the stored numeric 'sum' aggregation look invalid, and trigger a non-undoable
  // doc rewrite merely on opening the drawer.
  it('resolves the value field scoped to the widget source, avoiding a spurious aggregation repair (finding 1.7)', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousSources = mockState.runtime.dataSources;
    const previousRels = mockState.doc.relationships;
    controller.updateWidgetConfig.mockClear();

    try {
      mockState.runtime.dataSources = {
        // Sorts before "Orders" by label; shares the 'total' id but as a string.
        aaa: {
          id: 'aaa',
          label: 'Aaa',
          fields: [{ id: 'total', label: 'Aaa Total', type: 'string' }],
          rows: [],
        },
        ...previousSources,
      } as typeof previousSources;
      // Make 'aaa' reachable from the widget's source so it enters `reachableFields`.
      mockState.doc.relationships = [
        {
          sourceId: 'orders',
          targetId: 'aaa',
          type: 'many-to-one',
          sourceField: 'total',
          targetField: 'total',
        },
      ] as typeof previousRels;
      // Widget's own numeric 'total' with a valid 'sum' aggregation.
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: { kpiValueField: 'total', kpiAggregation: 'sum' },
      };

      render(<KpiSetupPanel widgetId="widget-1" />);

      // 'sum' stays valid for the widget's own numeric field → the repair effect never
      // fires. Before the fix, the string 'aaa.total' won the lookup and forced a
      // non-undoable `{ kpiAggregation: 'count' }` write-back.
      expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources = previousSources;
      mockState.doc.relationships = previousRels;
    }
  });
});

// Finding 2.2: a source-switch gesture (pick a field from a different source, which also
// ADOPTS that source) must collapse to ONE undo step. These tests run the panel against a
// REAL StudioController so `canUndo()`/`undo()` observe the actual undo stack — proving the
// two mutations were folded into a single commit (a lone Ctrl+Z otherwise lands on a torn
// state the UI never rendered).
describe('KpiSetupPanel — source-switch folds to a single undo step (finding 2.2)', () => {
  function makeController() {
    return new StudioController({
      doc: {
        widgets: {
          'widget-1': {
            id: 'widget-1',
            kind: 'kpi',
            title: 'Revenue',
            // A valid stored aggregation for the numeric field, so the panel's
            // aggregation-repair effect never fires and pollutes the clean undo baseline.
            config: { kpiValueField: 'total', kpiAggregation: 'sum' },
            sourceId: 'orders',
          } as StudioWidget,
        },
      },
      runtime: {
        dataSources: {
          orders: {
            id: 'orders',
            label: 'Orders',
            fields: [{ id: 'total', label: 'Total', type: 'number' }],
            rows: [],
          },
          customers: {
            id: 'customers',
            label: 'Customers',
            fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
            rows: [],
          },
        },
      },
    });
  }

  it('folds a value-field pick from another source into one undoable step', async () => {
    const realController = makeController();
    configureStudioContextMock({
      getState: () => realController.getState(),
      controller: realController,
    });

    // Clean baseline — no undoable action has happened yet.
    expect(realController.canUndo()).toBe(false);

    const { user } = render(<KpiSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Value field'));
    // Name includes the field-type icon's aria-label prefix (e.g. "Number Revenue").
    const revenueOption = await screen.findByRole('option', { name: /Revenue$/ });
    await user.click(revenueOption);

    // The gesture reached the intended state: new source adopted + new field written.
    const afterGesture = realController.getState().doc.widgets['widget-1'];
    expect(afterGesture.sourceId).toBe('customers');
    expect((afterGesture.config as StudioWidgetConfig).kpiValueField).toBe('revenue');
    expect(realController.canUndo()).toBe(true);

    // Exactly ONE undo entry: a single undo fully reverts to the pre-gesture state
    // (old source AND old field together — never a torn source/field intermediate)...
    realController.undo();
    const reverted = realController.getState().doc.widgets['widget-1'];
    expect(reverted.sourceId).toBe('orders');
    expect((reverted.config as StudioWidgetConfig).kpiValueField).toBe('total');
    // ...and there is nothing left to undo, proving the gesture pushed only one entry.
    expect(realController.canUndo()).toBe(false);
  });

  it('folds a data-source switch from the source picker into one undoable step', async () => {
    const realController = makeController();
    configureStudioContextMock({
      getState: () => realController.getState(),
      controller: realController,
    });

    expect(realController.canUndo()).toBe(false);

    const { user } = render(<KpiSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Data source'));
    const customersOption = await screen.findByRole('option', { name: 'Customers' });
    await user.click(customersOption);

    const afterGesture = realController.getState().doc.widgets['widget-1'];
    expect(afterGesture.sourceId).toBe('customers');
    // Switching source clears the old-source field and locks a fieldless count.
    expect((afterGesture.config as StudioWidgetConfig).kpiValueField).toBe('');
    expect((afterGesture.config as StudioWidgetConfig).kpiAggregation).toBe('count');
    expect(realController.canUndo()).toBe(true);

    realController.undo();
    const reverted = realController.getState().doc.widgets['widget-1'];
    expect(reverted.sourceId).toBe('orders');
    expect((reverted.config as StudioWidgetConfig).kpiValueField).toBe('total');
    expect((reverted.config as StudioWidgetConfig).kpiAggregation).toBe('sum');
    expect(realController.canUndo()).toBe(false);
  });
});
