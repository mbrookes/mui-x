import { createRenderer, screen, waitFor } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioRelationship, StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { GridSetupPanel } from './GridSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
};

const mockState = {
  doc: {
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'grid',
        sourceId: 'orders' as string | undefined,
        config: {
          columns: [{ fieldId: 'id' }, { fieldId: 'total' }],
        } as StudioWidgetConfig,
      },
    },
    relationships: [] as StudioRelationship[],
    expressionFields: [],
  },
  runtime: {
    dataSources: {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'Order ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
          { id: 'category', label: 'Category', type: 'string' },
        ],
        rows: [],
      },
      // Second source used by the "changing the data source" test below.
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [{ id: 'name', label: 'Name', type: 'string' }],
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

describe('GridSetupPanel', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('renders the columns list and the Add column affordance', () => {
    render(<GridSetupPanel widgetId="widget-1" />);

    expect(screen.getByText('Columns')).toBeVisible();
    expect(screen.getByText('Order ID')).toBeVisible();
    expect(screen.getByText('Total')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add column' })).toBeVisible();
  });

  it('adds a column via the Add column menu', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<GridSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('button', { name: 'Add column' }));
    // Name includes the field-type icon's aria-label prefix (e.g. "Text Category").
    const categoryItem = await screen.findByRole('menuitem', { name: /Category$/ });
    await user.click(categoryItem);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      columns: [{ fieldId: 'id' }, { fieldId: 'total' }, { fieldId: 'category' }],
    });
  });

  it('removes a column via its options menu', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<GridSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('button', { name: 'Options for Order ID' }));
    const removeItem = await screen.findByRole('menuitem', { name: 'Remove' });
    await user.click(removeItem);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      columns: [{ fieldId: 'total' }],
    });
  });

  it('sets the group-by field', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<GridSetupPanel widgetId="widget-1" />);

    const groupByInput = screen.getByLabelText('Group by');
    await user.click(groupByInput);
    // Name includes the field-type icon's aria-label prefix (e.g. "Text Category").
    const categoryOption = await screen.findByRole('option', { name: /Category$/ });
    await user.click(categoryOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      gridGroupByField: 'category',
      gridAggregations: {},
    });
  });

  it('switches the cross-filter interaction mode', async () => {
    controller.updateWidgetConfig.mockClear();
    const { user } = render(<GridSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      crossFilterMode: 'cross-filter',
    });
  });

  it('preserves non-field config keys when the data source changes (finding 3.6)', async () => {
    controller.updateWidget.mockClear();
    const previousWidget = mockState.doc.widgets['widget-1'];

    try {
      // Field-bound keys (columns, gridSortField, gridGroupByField, …) reference
      // the OLD source's fields and must be cleared on a source change, but
      // grid-level display settings independent of field selection — here
      // gridSortDirection and gridHeight — must survive it.
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: {
          columns: [{ fieldId: 'id' }, { fieldId: 'total' }],
          gridSortField: 'total',
          gridSortDirection: 'desc',
          gridGroupByField: 'category',
          gridHeight: 500,
        } as StudioWidgetConfig,
      };

      const { user } = render(<GridSetupPanel widgetId="widget-1" />);

      await user.click(screen.getByLabelText('Data source'));
      const customersOption = await screen.findByRole('option', { name: 'Customers' });
      await user.click(customersOption);

      // Third arg carries stale widget-scoped filter ids to remove in the same undo step
      // (finding 1.5) — empty here since this fixture has no filters.
      expect(controller.updateWidget).toHaveBeenCalledWith(
        'widget-1',
        {
          sourceId: 'customers',
          config: {
            gridSortDirection: 'desc',
            gridHeight: 500,
            columns: [],
          },
        },
        { removeFilterIds: [] },
      );
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
    }
  });

  // ─── Re-selecting the already-active source is a no-op (finding 1.13) ────────
  //
  // MUI `useAutocomplete`'s single-select equality is reference equality, and both
  // the picker's `value` and its `options` are freshly-mapped objects every render,
  // so clicking the currently-selected option in the dropdown still fires `onChange`
  // with a different object reference — `handleSourceChange` must guard against
  // treating that as a real source switch, or it wipes every field-bound column/
  // sort/group-by/aggregation/conditional-format setting in one undoable commit.

  it('does not call updateWidget when re-selecting the already-active data source', async () => {
    controller.updateWidget.mockClear();
    const { user } = render(<GridSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Data source'));
    const ordersOption = await screen.findByRole('option', { name: 'Orders' });
    await user.click(ordersOption);

    expect(controller.updateWidget).not.toHaveBeenCalled();
  });

  it('hides the columns section and shows a helper alert when no source is selected', () => {
    const previousWidget = mockState.doc.widgets['widget-1'];

    try {
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: undefined,
        config: {},
      };

      render(<GridSetupPanel widgetId="widget-1" />);

      expect(
        screen.getByText(
          "Select a data source above to configure this table's columns and settings.",
        ),
      ).toBeVisible();
      expect(screen.queryByText('Columns')).toBeNull();
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
    }
  });

  // ─── Per-column aggregation collision (architecture review) ──────────────────
  //
  // `gridSummaryFields`/`gridAggregations` used to be keyed by bare `fieldId`, so a
  // related-source column whose field id happens to match a primary column's (e.g.
  // both have an `id` field) shared the exact same map entry — configuring one
  // column's per-column aggregation silently overwrote the other's. The fix keys
  // these maps by the same composite `sourceId/fieldId` convention (`columnAggKey`)
  // already used for the column list's own React keys / menu-anchor identity.

  it("keys per-column summary aggregation by composite sourceId/fieldId so a primary and a cross-source column sharing a bare field id ('id') don't collide", async () => {
    controller.updateWidgetConfig.mockClear();
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousRelationships = mockState.doc.relationships;
    const previousCustomers = mockState.runtime.dataSources.customers;

    try {
      mockState.doc.relationships = [
        {
          id: 'rel-orders-customers',
          type: 'many-to-one',
          sourceId: 'orders',
          sourceField: 'customerId',
          targetId: 'customers',
          targetField: 'id',
        },
      ] as StudioRelationship[];
      mockState.runtime.dataSources.customers = {
        ...previousCustomers,
        fields: [...previousCustomers.fields, { id: 'id', label: 'Customer ID', type: 'string' }],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: {
          // Both columns share the bare fieldId 'id' — one from the primary
          // (orders) source, one from the related (customers) source.
          columns: [{ fieldId: 'id' }, { fieldId: 'id', sourceId: 'customers' }],
        } as StudioWidgetConfig,
      };

      const { user } = render(<GridSetupPanel widgetId="widget-1" />);

      // Configure the PRIMARY orders.id column's summary aggregation to Count.
      await user.click(screen.getByRole('button', { name: 'Options for Order ID' }));
      const countItem = await screen.findByRole('menuitem', { name: 'Count' });
      await user.click(countItem);

      expect(controller.updateWidgetConfig).toHaveBeenLastCalledWith('widget-1', {
        gridSummaryFields: { id: 'count' },
      });

      // Configure the CROSS-SOURCE customers.id column's summary aggregation to
      // Unique (count_distinct). Before the fix, since both columns' aggregation
      // was keyed by the bare fieldId 'id', this call would have silently
      // overwritten the primary column's entry above instead of creating an
      // independent one.
      controller.updateWidgetConfig.mockClear();
      await user.click(screen.getByRole('button', { name: 'Options for Customer ID' }));
      const uniqueItem = await screen.findByRole('menuitem', { name: 'Unique' });
      await user.click(uniqueItem);

      expect(controller.updateWidgetConfig).toHaveBeenLastCalledWith('widget-1', {
        gridSummaryFields: { 'customers/id': 'count_distinct' },
      });
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.doc.relationships = previousRelationships;
      mockState.runtime.dataSources.customers = previousCustomers;
    }
  });

  // Architecture review finding (Tier2): `currentAgg` (read from the doc-authored
  // `gridSummaryFields`/`gridAggregations` maps) is used as an `aggLabels[currentAgg]`
  // bracket lookup for the per-column aggregation tooltip. An unguarded lookup that
  // resolves an inherited `Object.prototype` member (e.g. an aggregation value of
  // `'constructor'`) would surface the inherited function's string representation in the
  // tooltip instead of falling through to the raw aggregation string.
  it("falls back to the raw aggregation string in the tooltip when a column's stored aggregation collides with an Object.prototype member", async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    try {
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: {
          columns: [{ fieldId: 'id' }, { fieldId: 'total' }],
          // Cast to simulate a persisted-doc/AI-authored aggregation value that bypasses
          // the compile-time `StudioGridSummaryAggregation` union.
          gridSummaryFields: { id: 'constructor' as never },
        } as StudioWidgetConfig,
      };

      const { user } = render(<GridSetupPanel widgetId="widget-1" />);
      await user.hover(screen.getByRole('button', { name: 'Options for Order ID' }));

      await waitFor(() => {
        expect(screen.getByRole('tooltip')).toBeVisible();
      });
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip.textContent).toContain('constructor');
      expect(tooltip.textContent).not.toMatch(/function/i);
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
    }
  });

  // Sibling of the finding above, on the OTHER side of the same bracket lookup: the
  // aggregation record is indexed by the doc-authored COLUMN key. A column whose key
  // matches an inherited `Object.prototype` member resolved that member as its
  // "current aggregation" — the ⋮ button rendered `color="primary"` (claiming an
  // aggregation was configured) and the tooltip interpolated `function Object() {…}`.
  it('treats a column keyed like an Object.prototype member as having no aggregation configured', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousOrders = mockState.runtime.dataSources.orders;
    try {
      mockState.runtime.dataSources.orders = {
        ...previousOrders,
        fields: [
          ...previousOrders.fields,
          { id: 'constructor', label: 'Constructor', type: 'string' },
        ],
      };
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        config: {
          columns: [{ fieldId: 'constructor' }],
          // Deliberately empty — nothing is configured for ANY column.
          gridSummaryFields: {},
        } as StudioWidgetConfig,
      };

      const { user } = render(<GridSetupPanel widgetId="widget-1" />);
      const optionsButton = screen.getByRole('button', { name: 'Options for Constructor' });
      expect(optionsButton.className).not.toContain('colorPrimary');

      await user.hover(optionsButton);
      await waitFor(() => {
        expect(screen.getByRole('tooltip')).toBeVisible();
      });
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip.textContent).toBe('Set summary / remove');
      expect(tooltip.textContent).not.toMatch(/function/i);
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources.orders = previousOrders;
    }
  });
});
