import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { KpiSetupPanel } from './KpiSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
  setWidgetDateRange: vi.fn(),
};

const mockState = {
  doc: {
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
});
