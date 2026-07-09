import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioChartConfigOfType } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { PieArcLabelsSection } from './PieArcLabelsSection';

const controller = {
  updateWidgetConfig: vi.fn(),
};

const mockState = { doc: { widgets: {} }, runtime: { dataSources: {} } };

vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

function renderPie(config: Partial<StudioChartConfigOfType<'pie'>>) {
  return render(
    <PieArcLabelsSection
      widgetId="widget-1"
      config={{ chartType: 'pie', pieArcLabel: 'value', ...config } as never}
    />,
  );
}

// Finding 2.3: the min-angle input used to parse+commit `Math.max(0, Number(v))` on
// every keystroke, each an undoable commit plus a mutation-log line plus a full
// pipeline recompute.
describe('PieArcLabelsSection min-angle input (finding 2.3)', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
    controller.updateWidgetConfig.mockClear();
  });

  it('does not commit while typing', () => {
    renderPie({});
    const input = screen.getByLabelText('Minimum angle (°)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '45' } });
    expect(input.value).toBe('45');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits a valid angle on blur', () => {
    renderPie({});
    const input = screen.getByLabelText('Minimum angle (°)');
    fireEvent.change(input, { target: { value: '45' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      pieArcLabelMinAngle: 45,
    });
  });

  it('clamps a negative angle to 0 on blur', () => {
    renderPie({});
    const input = screen.getByLabelText('Minimum angle (°)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-10' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      pieArcLabelMinAngle: 0,
    });
  });

  it('reverts an unparseable value to the last committed angle without committing', () => {
    renderPie({ pieArcLabelMinAngle: 20 });
    const input = screen.getByLabelText('Minimum angle (°)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('20');
  });

  it('commits once on Enter', () => {
    renderPie({});
    const input = screen.getByLabelText('Minimum angle (°)');
    fireEvent.change(input, { target: { value: '30' } });
    act(() => {
      input.focus();
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      pieArcLabelMinAngle: 30,
    });
  });
});
