import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { FormatPanel } from './FormatPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
};

const mockState = {
  widgets: {
    'widget-1': {
      id: 'widget-1',
      kind: 'kpi',
      sourceId: 'orders',
      title: 'Revenue',
      subtitle: undefined,
      config: { kpiField: 'total', kpiAggregation: 'sum', kpiCompact: true } as StudioWidgetConfig,
    },
  },
  dataSources: {
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'total', label: 'Total', type: 'number' }],
      rows: [],
    },
  },
  relationships: [],
  expressionFields: [],
  filters: [],
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

describe('FormatPanel', () => {
  beforeEach(() => {
    mockState.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'kpi',
      sourceId: 'orders',
      title: 'Revenue',
      subtitle: undefined,
      config: { kpiField: 'total', kpiAggregation: 'sum', kpiCompact: true } as StudioWidgetConfig,
    };
    controller.updateWidgetConfig.mockClear();
    controller.updateWidget.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('shows the widget title and subtitle fields plus the KPI compact-numbers switch', () => {
    render(<FormatPanel widgetId="widget-1" />);

    expect(screen.getByLabelText('Widget title').getAttribute('value')).toBe('Revenue');
    expect(screen.getByText('Compact numbers')).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Compact numbers' }).getAttribute('checked')).toBe(
      '',
    );
  });

  it('commits a manual title edit on blur', async () => {
    const { user } = render(<FormatPanel widgetId="widget-1" />);

    const titleInput = screen.getByLabelText('Widget title');
    await user.clear(titleInput);
    await user.type(titleInput, 'Total revenue');
    await user.tab();

    expect(controller.updateWidget).toHaveBeenCalledWith('widget-1', {
      title: 'Total revenue',
      titleMode: 'manual',
    });
  });

  it('toggles kpiCompact from the switch', async () => {
    const { user } = render(<FormatPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('switch', { name: 'Compact numbers' }));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      kpiCompact: false,
    });
  });

  it('shows the grid height input for a grid widget', () => {
    mockState.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'grid',
      sourceId: 'orders',
      title: 'Orders table',
      subtitle: undefined,
      config: { gridHeight: 400 } as StudioWidgetConfig,
    };

    render(<FormatPanel widgetId="widget-1" />);

    expect(screen.getByLabelText('Height (px)').getAttribute('value')).toBe('400');
    expect(screen.queryByText('Compact numbers')).toBeNull();
  });

  it('shows the legend-alignment control only when the map legend is not hidden', async () => {
    mockState.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'map',
      sourceId: 'orders',
      title: 'Orders map',
      subtitle: undefined,
      config: { mapLegendPosition: 'bottom' } as StudioWidgetConfig,
    };

    const { user } = render(<FormatPanel widgetId="widget-1" />);

    expect(screen.getAllByText('Legend alignment').length).toBeGreaterThan(0);

    await user.click(screen.getByText('Bottom'));
    const hiddenOption = await screen.findByRole('option', { name: 'None' });
    await user.click(hiddenOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      mapLegendPosition: 'hidden',
    });
  });

  it('hides the legend-alignment control once the map legend is hidden', () => {
    mockState.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'map',
      sourceId: 'orders',
      title: 'Orders map',
      subtitle: undefined,
      config: { mapLegendPosition: 'hidden' } as StudioWidgetConfig,
    };

    render(<FormatPanel widgetId="widget-1" />);

    expect(screen.queryByText('Legend alignment')).toBeNull();
  });
});
