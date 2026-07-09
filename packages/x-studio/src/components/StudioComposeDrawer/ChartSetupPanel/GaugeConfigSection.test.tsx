import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioChartConfigOfType } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { GaugeConfigSection } from './GaugeConfigSection';
import type { DataSourceFieldEntry } from '../DataSourceFieldSelect';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
};

const mockState = { doc: { widgets: {} }, runtime: { dataSources: {} } };

vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

const allFields: DataSourceFieldEntry[] = [
  { id: 'total', label: 'Total', type: 'number', sourceId: 'orders', sourceLabel: 'Orders' },
];

function renderGauge(config: Partial<StudioChartConfigOfType<'gauge'>>) {
  return render(
    <GaugeConfigSection
      widgetId="widget-1"
      config={{ chartType: 'gauge', gaugeMin: 0, gaugeMax: 100, ...config } as never}
      allFields={allFields}
      widgetSourceId="orders"
    />,
  );
}

describe('GaugeConfigSection min/max validation (finding 3.4)', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
    controller.updateWidgetConfig.mockClear();
  });

  it('commits a valid min below max', () => {
    renderGauge({});
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '50' } });
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { gaugeMin: 50 });
  });

  it('rejects a min at or above max (prevents gaugeMin > gaugeMax)', () => {
    renderGauge({});
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '150' } });
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits a valid max above min', () => {
    renderGauge({});
    fireEvent.change(screen.getByLabelText('Max'), { target: { value: '200' } });
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { gaugeMax: 200 });
  });

  it('rejects a max at or below min', () => {
    renderGauge({ gaugeMin: 10 });
    fireEvent.change(screen.getByLabelText('Max'), { target: { value: '5' } });
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });
});
