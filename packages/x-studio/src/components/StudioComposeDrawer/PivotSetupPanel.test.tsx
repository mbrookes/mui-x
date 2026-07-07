import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidgetConfig } from '../../models';
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
    expressionFields: [],
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
});
