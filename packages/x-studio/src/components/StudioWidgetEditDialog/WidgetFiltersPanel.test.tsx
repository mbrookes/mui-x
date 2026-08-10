import * as React from 'react';
import { createDefaultSemanticModel } from '@mui/x-studio-core/models';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioFilterState, StudioWidget, StudioWidgetConfig } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { WidgetFiltersPanel } from './WidgetFiltersPanel';

const { render } = createRenderer();

const SOURCE = {
  id: 'src',
  label: 'Sales',
  fields: [
    { id: 'amount', label: 'Amount', type: 'number' as const },
    { id: 'region', label: 'Region', type: 'string' as const },
  ],
  rows: [],
};

function chartWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'chart',
    title: 'My Chart',
    sourceId: 'src',
    config: { chartType: 'bar', xField: 'region' } as StudioWidgetConfig,
    ...overrides,
  };
}

function conditionFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'wf-condition',
    field: 'amount',
    fieldType: 'number',
    filterMode: 'condition',
    operator: 'equals',
    value: '10',
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  };
}

function selectionFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'wf-selection',
    field: 'region',
    fieldType: 'string',
    filterMode: 'selection',
    operator: 'in',
    value: ['East', 'West'],
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  };
}

function rankFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'wf-rank',
    field: 'amount',
    fieldType: 'number',
    filterMode: 'rank',
    operator: 'equals',
    value: 5,
    rankDirection: 'top',
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  };
}

/**
 * Regression coverage for architecture-review finding 2.18: `WidgetFiltersPanel` used to
 * only exclude `dateRangePreset` filters from the list handed to the dialog's condition-only
 * `FilterRow` — a selection-mode filter's array value would render/commit through `FilterRow`
 * as a joined string (a blur silently deactivating it, since the array becomes a scalar), and a
 * rank-mode filter would get a meaningless operator Select that could write junk operator keys
 * onto it. The panel must only surface `filterMode: 'condition'` (or legacy `undefined`) filters.
 */
describe('WidgetFiltersPanel (finding 2.18)', () => {
  it('renders a condition-mode filter through FilterRow', () => {
    const filter = conditionFilter();
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { w1: chartWidget() }, filters: [filter] },
        runtime: { dataSources: { src: SOURCE } },
      },
    });
    render(<WidgetFiltersPanel widgetId="w1" />, { wrapper });

    // The condition filter's numeric value renders as a plain text input.
    expect(screen.getByDisplayValue('10')).not.toBe(null);
  });

  it('does not render a selection-mode filter through the condition-only FilterRow', () => {
    const filter = selectionFilter();
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { w1: chartWidget() }, filters: [filter] },
        runtime: { dataSources: { src: SOURCE } },
      },
    });
    render(<WidgetFiltersPanel widgetId="w1" />, { wrapper });

    // A selection filter's array value must never appear as a joined string in a text input —
    // that would mean it's being edited through the wrong (condition-only) editor.
    expect(screen.queryByDisplayValue('East,West')).toBe(null);
    // With the selection filter excluded, the panel has nothing to show.
    expect(screen.getByText('No filters, all data is shown.')).not.toBe(null);
  });

  it('does not render a rank-mode filter through the condition-only FilterRow', () => {
    const filter = rankFilter();
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { w1: chartWidget() }, filters: [filter] },
        runtime: { dataSources: { src: SOURCE } },
      },
    });
    render(<WidgetFiltersPanel widgetId="w1" />, { wrapper });

    // No stray operator Select should be rendered for the rank filter.
    expect(screen.getByText('No filters, all data is shown.')).not.toBe(null);
  });

  it('renders condition filters while omitting sibling rank/selection filters on the same widget', () => {
    const condition = conditionFilter();
    const selection = selectionFilter();
    const rank = rankFilter();
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { w1: chartWidget() }, filters: [condition, selection, rank] },
        runtime: { dataSources: { src: SOURCE } },
      },
    });
    render(<WidgetFiltersPanel widgetId="w1" />, { wrapper });

    // Only the condition filter's value should be visible.
    expect(screen.getByDisplayValue('10')).not.toBe(null);
    expect(screen.queryByText('No filters, all data is shown.')).toBe(null);
  });
});

// Regression for finding 1: the panel walked the relationship list by ENDPOINT only, so the
// junction source of a many-to-many relationship was never added. A widget filter the drawer
// authored on a junction field (the drawer uses `getReachableSourceIds`, which includes it)
// resolved to nothing here — losing its label, its type, and therefore its operator list.
describe('WidgetFiltersPanel reachable sources (finding 1)', () => {
  const ORDERS = {
    id: 'orders',
    label: 'Orders',
    fields: [{ id: 'total', label: 'Total', type: 'number' as const }],
    rows: [],
  };
  const CUSTOMERS = {
    id: 'customers',
    label: 'Customers',
    fields: [{ id: 'name', label: 'Name', type: 'string' as const }],
    rows: [],
  };
  const ORDER_LINES = {
    id: 'orderLines',
    label: 'Order lines',
    fields: [{ id: 'quantity', label: 'Quantity', type: 'number' as const }],
    rows: [],
  };
  const MANY_TO_MANY = [
    {
      id: 'rel-1',
      sourceId: 'orders',
      targetId: 'customers',
      sourceField: 'customerId',
      targetField: 'id',
      type: 'many-to-many' as const,
      junctionSourceId: 'orderLines',
    },
  ];

  function renderWithJunction(filter: StudioFilterState) {
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: {
          semanticModel: { ...createDefaultSemanticModel(), relationships: MANY_TO_MANY },

          widgets: { w1: chartWidget({ sourceId: 'orders' }) },
          filters: [filter],
        },
        runtime: {
          dataSources: { orders: ORDERS, customers: CUSTOMERS, orderLines: ORDER_LINES },
        },
      },
    });
    return render(<WidgetFiltersPanel widgetId="w1" />, { wrapper });
  }

  it('resolves a filter on the junction source of a many-to-many relationship', () => {
    renderWithJunction(
      conditionFilter({
        field: 'quantity',
        fieldType: 'number',
        filterSourceId: 'orderLines',
        operator: 'greater_than',
        value: '100',
      }),
    );

    // The field Select shows the junction field's LABEL, not the raw id and not "(unavailable)".
    expect(screen.getByText('Order lines: Quantity')).not.toBe(null);
    expect(screen.queryByTestId('filter-field-unresolved')).toBe(null);
  });

  it('keeps the stored numeric operator instead of falling back to the string list', () => {
    renderWithJunction(
      conditionFilter({
        field: 'quantity',
        fieldType: 'number',
        filterSourceId: 'orderLines',
        operator: 'greater_than',
        value: '100',
      }),
    );

    // `>` is the number-table label for `greater_than`. The string fallback used to render
    // "Equals" here while the engine kept applying `greater_than`.
    expect(screen.getByRole('combobox', { name: 'Operator' }).textContent).toBe('>');
  });
});

// Wave 1 made `StudioController.addFilter`/`updateFilter` return a `StudioMutationResult`
// instead of `void`. This panel ignored both, so the Add button could do nothing visible and an
// edit could silently snap back.
describe('WidgetFiltersPanel rejected mutations (wave 1 handoff)', () => {
  function renderPanel() {
    const harness = createStudioHarness({
      initialState: {
        doc: { widgets: { w1: chartWidget() } },
        runtime: { dataSources: { src: SOURCE } },
      },
    });
    const view = render(<WidgetFiltersPanel widgetId="w1" />, { wrapper: harness.wrapper });
    return { ...view, controller: harness.controller };
  }

  it('reports a rejected add instead of leaving the button apparently inert', async () => {
    const { controller, user } = renderPanel();
    vi.spyOn(controller, 'addFilter').mockReturnValue({ ok: false, reason: 'rank-conflict' });

    await user.click(screen.getByRole('button', { name: /add filter/i }));

    expect(screen.getByTestId('widget-filters-panel-error')).not.toBe(null);
  });

  it('shows no error for an accepted add', async () => {
    const { user } = renderPanel();

    await user.click(screen.getByRole('button', { name: /add filter/i }));

    expect(screen.queryByTestId('widget-filters-panel-error')).toBe(null);
  });

  it('treats a value-equal no-op (committed: false) as success', async () => {
    const { controller, user } = renderPanel();
    vi.spyOn(controller, 'addFilter').mockReturnValue({ ok: true, committed: false });

    await user.click(screen.getByRole('button', { name: /add filter/i }));

    expect(screen.queryByTestId('widget-filters-panel-error')).toBe(null);
  });
});
