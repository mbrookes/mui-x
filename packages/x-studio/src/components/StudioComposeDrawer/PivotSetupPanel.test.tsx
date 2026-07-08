import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioDataSource, StudioExpressionField, StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { PivotSetupPanel } from './PivotSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
};

const mockState = {
  doc: {
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'pivot',
        sourceId: 'orders' as string | undefined,
        config: {
          pivotRowField: 'category',
          pivotColField: 'region',
          pivotValueField: 'total',
          pivotAggregation: 'sum',
        } as StudioWidgetConfig,
      },
    },
    relationships: [],
    expressionFields: [] as StudioExpressionField[],
  },
  runtime: {
    dataSources: {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'category', label: 'Category', type: 'string' },
          { id: 'region', label: 'Region', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
        rows: [],
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [{ id: 'segment', label: 'Segment', type: 'string' }],
        rows: [],
      },
    } as Record<string, StudioDataSource>,
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

describe('PivotSetupPanel', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'pivot',
      sourceId: 'orders' as string | undefined,
      config: {
        pivotRowField: 'category',
        pivotColField: 'region',
        pivotValueField: 'total',
        pivotAggregation: 'sum',
      } as StudioWidgetConfig,
    };
    controller.updateWidgetConfig.mockClear();
    controller.updateWidget.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('shows the row/column field pickers and the aggregation control', () => {
    render(<PivotSetupPanel widgetId="widget-1" />);

    // Row/column/value pickers are marked `required` (no fieldless fallback), so their
    // accessible label carries a trailing asterisk — match with `exact: false`.
    expect(screen.getByLabelText('Row field', { exact: false }).getAttribute('value')).toBe(
      'Category',
    );
    expect(screen.getByLabelText('Column field', { exact: false }).getAttribute('value')).toBe(
      'Region',
    );
    expect(screen.getAllByText('Aggregation').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Value field', { exact: false }).getAttribute('value')).toBe(
      'Total',
    );
  });

  it('updates the aggregation via the aggregation select', async () => {
    const { user } = render(<PivotSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByText('Sum'));
    const avgOption = await screen.findByRole('option', { name: 'Average' });
    await user.click(avgOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      pivotAggregation: 'avg',
    });
  });

  it('toggles the show-totals switch', async () => {
    const { user } = render(<PivotSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('switch'));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      pivotShowTotals: false,
    });
  });

  it('hides the value field picker when aggregation is count', () => {
    mockState.doc.widgets['widget-1'].config = {
      ...mockState.doc.widgets['widget-1'].config,
      pivotAggregation: 'count',
    };

    render(<PivotSetupPanel widgetId="widget-1" />);

    expect(screen.queryByLabelText('Value field')).toBeNull();
  });

  it('adopts the field source when a row field is picked before a source exists', async () => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'pivot',
      sourceId: undefined,
      config: {} as StudioWidgetConfig,
    };

    const { user } = render(<PivotSetupPanel widgetId="widget-1" />);

    const rowInput = screen.getByLabelText('Row field', { exact: false });
    await user.click(rowInput);
    const segmentOption = await screen.findByRole('option', { name: /Segment$/ });
    await user.click(segmentOption);

    expect(controller.updateWidget).toHaveBeenCalledWith('widget-1', {
      sourceId: 'customers',
      config: { pivotRowField: 'segment' },
    });
  });

  // Pinning tests for the migration onto the shared `fieldCatalog.ts` helpers
  // (`buildSourceFieldEntries`) — this is a pure dedup, so these lock in today's
  // exact behavior, including two asymmetries and one ordering quirk that must
  // survive the refactor unchanged.
  describe('field-fold behavior (pinning fieldCatalog.ts migration)', () => {
    it('excludes fields from a hidden source, and hidden fields from a visible source, when there is no source yet', async () => {
      mockState.doc.widgets['widget-1'] = {
        id: 'widget-1',
        kind: 'pivot',
        sourceId: undefined,
        config: {} as StudioWidgetConfig,
      };
      mockState.runtime.dataSources = {
        ...mockState.runtime.dataSources,
        orders: {
          ...mockState.runtime.dataSources.orders,
          fields: [
            ...mockState.runtime.dataSources.orders.fields,
            { id: 'hiddenField', label: 'HiddenField', type: 'string', hidden: true },
          ],
        },
        secret: {
          id: 'secret',
          label: 'Secret',
          hidden: true,
          fields: [{ id: 'secretField', label: 'SecretField', type: 'string' }],
          rows: [],
        },
      };

      try {
        const { user } = render(<PivotSetupPanel widgetId="widget-1" />);

        const rowInput = screen.getByLabelText('Row field', { exact: false });
        await user.click(rowInput);

        expect(screen.queryByRole('option', { name: /HiddenField$/ })).toBeNull();
        expect(screen.queryByRole('option', { name: /SecretField$/ })).toBeNull();
        // Sanity: a non-hidden field from a non-hidden source is still offered.
        expect(await screen.findByRole('option', { name: /Category$/ })).toBeVisible();
      } finally {
        delete (mockState.runtime.dataSources as Record<string, unknown>).secret;
        mockState.runtime.dataSources.orders.fields =
          mockState.runtime.dataSources.orders.fields.filter((f) => f.id !== 'hiddenField');
      }
    });

    it('includes an expression field regardless of measure status when there is no source yet', async () => {
      mockState.doc.widgets['widget-1'] = {
        id: 'widget-1',
        kind: 'pivot',
        sourceId: undefined,
        config: {} as StudioWidgetConfig,
      };
      const measureField: StudioExpressionField = {
        id: 'measureField',
        label: 'MeasureField',
        sourceId: 'orders',
        type: 'number',
        isMeasure: true,
        expression: { type: 'number', value: 1 },
      };
      mockState.doc.expressionFields = [measureField];

      try {
        const { user } = render(<PivotSetupPanel widgetId="widget-1" />);

        const valueInput = screen.getByLabelText('Value field', { exact: false });
        await user.click(valueInput);

        expect(await screen.findByRole('option', { name: /MeasureField$/ })).toBeVisible();
      } finally {
        mockState.doc.expressionFields = [];
      }
    });

    it('includes a same-source expression field when a source is set, even if it is a measure', async () => {
      const sameSourceMeasure: StudioExpressionField = {
        id: 'sameSourceMeasure',
        label: 'SameSourceMeasure',
        sourceId: 'orders',
        type: 'number',
        isMeasure: true,
        expression: { type: 'number', value: 1 },
      };
      mockState.doc.expressionFields = [sameSourceMeasure];

      try {
        const { user } = render(<PivotSetupPanel widgetId="widget-1" />);

        const valueInput = screen.getByLabelText('Value field', { exact: false });
        await user.click(valueInput);
        // Same-source measure expression field is offered (no measure exclusion for pivot).
        expect(await screen.findByRole('option', { name: /SameSourceMeasure$/ })).toBeVisible();
      } finally {
        mockState.doc.expressionFields = [];
      }
    });

    it('excludes a cross-source expression field when a source is set, even though buildFieldCatalog would otherwise surface it', async () => {
      const otherSourceField: StudioExpressionField = {
        id: 'otherSourceField',
        label: 'OtherSourceField',
        sourceId: 'customers',
        type: 'string',
        isMeasure: false,
        expression: { type: 'string', value: 'x' },
      };
      mockState.doc.expressionFields = [otherSourceField];

      try {
        const { user } = render(<PivotSetupPanel widgetId="widget-1" />);

        const rowInput = screen.getByLabelText('Row field', { exact: false });
        await user.click(rowInput);
        // Cross-source expression field is excluded even though it's a category type —
        // pivot has no per-field source metadata, so mixing sources would silently
        // mismatch data.
        expect(screen.queryByRole('option', { name: /OtherSourceField$/ })).toBeNull();
      } finally {
        mockState.doc.expressionFields = [];
      }
    });

    it('orders fields by Object.values(dataSources) insertion order, not alphabetically by source label', async () => {
      // "Zeta" sorts after "Orders" alphabetically, but is inserted first — the fold must
      // preserve insertion order (buildFieldCatalog's default `sort: true` would flip this).
      mockState.doc.widgets['widget-1'] = {
        id: 'widget-1',
        kind: 'pivot',
        sourceId: undefined,
        config: {} as StudioWidgetConfig,
      };
      mockState.runtime.dataSources = {
        zeta: {
          id: 'zeta',
          label: 'Zeta',
          fields: [{ id: 'zetaField', label: 'ZetaField', type: 'string' }],
          rows: [],
        },
        ...mockState.runtime.dataSources,
      };

      try {
        const { user } = render(<PivotSetupPanel widgetId="widget-1" />);

        const rowInput = screen.getByLabelText('Row field', { exact: false });
        await user.click(rowInput);

        const options = await screen.findAllByRole('option');
        const firstFieldOptionIndex = options.findIndex((opt) =>
          /ZetaField$/.test(opt.textContent ?? ''),
        );
        const secondFieldOptionIndex = options.findIndex((opt) =>
          /Category$/.test(opt.textContent ?? ''),
        );
        expect(firstFieldOptionIndex).toBeGreaterThanOrEqual(0);
        expect(secondFieldOptionIndex).toBeGreaterThan(firstFieldOptionIndex);
      } finally {
        delete (mockState.runtime.dataSources as Record<string, unknown>).zeta;
      }
    });
  });
});
