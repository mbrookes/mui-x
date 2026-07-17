import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioChartConfigOfType } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { ScatterConfigSection } from './ScatterConfigSection';
import type { DataSourceFieldEntry } from '../DataSourceFieldSelect';

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

const numericFields: DataSourceFieldEntry[] = [
  { id: 'x', label: 'X', type: 'number', sourceId: 'orders', sourceLabel: 'Orders' },
  { id: 'y', label: 'Y', type: 'number', sourceId: 'orders', sourceLabel: 'Orders' },
];
const categoryFields: DataSourceFieldEntry[] = [
  { id: 'segment', label: 'Segment', type: 'string', sourceId: 'orders', sourceLabel: 'Orders' },
];

function renderScatter(config: Partial<StudioChartConfigOfType<'scatter'>>) {
  return render(
    <ScatterConfigSection
      widgetId="widget-1"
      config={{ chartType: 'scatter', scatterSizeField: 'y', ...config } as never}
      numericFields={numericFields}
      categoryFields={categoryFields}
    />,
  );
}

// Finding 2.3: the radii inputs used to parse+commit `Number(v) || 4` on every
// keystroke, so a momentarily cleared field snapped straight to the fallback default
// instead of staying in an in-progress empty state — the exact bug class the
// buffer-then-commit-on-blur pattern elsewhere exists to prevent.
describe('ScatterConfigSection radii inputs (finding 2.3)', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
    controller.updateWidgetConfig.mockClear();
  });

  it('does not commit the min radius while typing', () => {
    renderScatter({});
    const input = screen.getByLabelText('Min radius') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10' } });
    expect(input.value).toBe('10');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits a valid min radius on blur', () => {
    renderScatter({});
    const input = screen.getByLabelText('Min radius');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      scatterMinRadius: 10,
    });
  });

  it('does not snap a cleared min radius to the default 4 while typing', () => {
    renderScatter({});
    const input = screen.getByLabelText('Min radius') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    // The field stays visibly empty — it must NOT jump to "4" mid-edit.
    expect(input.value).toBe('');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('reverts a cleared min radius to the last committed value on blur, without committing', () => {
    renderScatter({ scatterMinRadius: 8 });
    const input = screen.getByLabelText('Min radius') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('8');
  });

  it('commits a valid max radius on blur, buffered while typing', () => {
    renderScatter({});
    const input = screen.getByLabelText('Max radius');
    fireEvent.change(input, { target: { value: '60' } });
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      scatterMaxRadius: 60,
    });
  });

  it('commits once on Enter for the max radius', () => {
    renderScatter({});
    const input = screen.getByLabelText('Max radius');
    fireEvent.change(input, { target: { value: '55' } });
    act(() => {
      input.focus();
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      scatterMaxRadius: 55,
    });
  });
});

// Finding 8 (architecture review): typed keyboard input bypasses the native spinner-button
// `min`/`max` constraint entirely, and there was no cross-check between the two bounds — a
// typed value could commit e.g. a negative radius or a min greater than max.
describe('ScatterConfigSection radii inputs reject out-of-range/cross-invalid values (finding 8)', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
    controller.updateWidgetConfig.mockClear();
  });

  it('rejects a min radius below the advertised range and reverts on blur', () => {
    renderScatter({ scatterMinRadius: 4 });
    const input = screen.getByLabelText('Min radius') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('4');
  });

  it('rejects a max radius above the advertised range and reverts on blur', () => {
    renderScatter({ scatterMaxRadius: 40 });
    const input = screen.getByLabelText('Max radius') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('40');
  });

  it('rejects a min radius typed greater than or equal to the current max radius', () => {
    renderScatter({ scatterMinRadius: 4, scatterMaxRadius: 40 });
    const input = screen.getByLabelText('Min radius') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '45' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('4');
  });

  it('rejects a max radius typed less than or equal to the current min radius', () => {
    renderScatter({ scatterMinRadius: 10, scatterMaxRadius: 40 });
    const input = screen.getByLabelText('Max radius') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('40');
  });

  it('accepts a valid min radius that stays below the current max radius', () => {
    renderScatter({ scatterMinRadius: 4, scatterMaxRadius: 40 });
    const input = screen.getByLabelText('Min radius') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      scatterMinRadius: 20,
    });
  });
});
