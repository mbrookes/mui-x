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

// Finding 1.14: the min/max inputs used to validate on every keystroke against the
// OTHER committed bound, so typing a multi-digit value one keystroke at a time
// (or clearing the field) could be silently rejected mid-edit. They now buffer the
// displayed text locally and only parse/validate/commit on blur.
describe('GaugeConfigSection min/max validation (finding 3.4 / 1.14)', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
    controller.updateWidgetConfig.mockClear();
  });

  it('commits a valid min below max on blur', () => {
    renderGauge({});
    const input = screen.getByLabelText('Min');
    fireEvent.change(input, { target: { value: '50' } });
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { gaugeMin: 50 });
  });

  it('reverts a min at or above max instead of committing (prevents gaugeMin > gaugeMax)', () => {
    renderGauge({});
    const input = screen.getByLabelText('Min') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('0');
  });

  it('commits a valid max above min on blur', () => {
    renderGauge({});
    const input = screen.getByLabelText('Max');
    fireEvent.change(input, { target: { value: '200' } });
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { gaugeMax: 200 });
  });

  it('reverts a max at or below min instead of committing', () => {
    renderGauge({ gaugeMin: 10 });
    const input = screen.getByLabelText('Max') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('100');
  });

  it('does not snap back a still-typing negative min mid-keystroke', async () => {
    // With a committed max of 100, typing "-5" one keystroke at a time used to be
    // silently rejected on the "-" keystroke, since `Number('-')` is NaN. Real
    // keystroke-by-keystroke typing (not a single `fireEvent.change`) is required
    // to observe the in-progress "-" the browser reports for a `type="number"`
    // input via `validity.badInput`.
    const { user } = renderGauge({});
    const input = screen.getByLabelText('Min') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '-5');
    expect(input.value).toBe('-5');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { gaugeMin: -5 });
  });

  it('allows typing a larger min one keystroke at a time against a small committed max', () => {
    // With gaugeMax committed at 10, typing "150" digit by digit used to be
    // rejected as soon as any prefix (e.g. "15") was >= the committed max.
    renderGauge({ gaugeMax: 10 });
    const minInput = screen.getByLabelText('Min') as HTMLInputElement;
    fireEvent.change(minInput, { target: { value: '1' } });
    expect(minInput.value).toBe('1');
    fireEvent.change(minInput, { target: { value: '15' } });
    expect(minInput.value).toBe('15');
    fireEvent.change(minInput, { target: { value: '150' } });
    expect(minInput.value).toBe('150');
    // Committing now against the still-small max correctly reverts (order matters:
    // the max must be widened first) rather than silently discarding keystrokes.
    fireEvent.blur(minInput);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('allows clearing the min field to an empty string while typing', () => {
    renderGauge({});
    const input = screen.getByLabelText('Min') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('preserves a trailing decimal point typed mid-sequence for a max value', async () => {
    // Real keystroke-by-keystroke typing (not a single `fireEvent.change`) so the
    // decimal point is an actual intermediate keystroke. With the old
    // per-keystroke-commit code, typing the "20." keystroke re-derived the
    // controlled value from `Number('20.')` → `20`, forcing the field back to
    // "20" and corrupting every keystroke typed after it (landing on "205"
    // instead of "20.5"). Asserting the final text after the whole sequence
    // still exercises that exact regression.
    const { user } = renderGauge({});
    const input = screen.getByLabelText('Max') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '20.5');
    expect(input.value).toBe('20.5');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { gaugeMax: 20.5 });
  });
});
