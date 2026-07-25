import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioChartConfigOfType } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { FunnelConfigSection } from './FunnelConfigSection';
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
  { id: 'count', label: 'Count', type: 'number', sourceId: 'orders', sourceLabel: 'Orders' },
  { id: 'revenue', label: 'Revenue', type: 'number', sourceId: 'orders', sourceLabel: 'Orders' },
];

function renderFunnel(config: Partial<StudioChartConfigOfType<'funnel'>>) {
  return render(
    <FunnelConfigSection
      widgetId="widget-1"
      config={{ chartType: 'funnel', yField: 'count', ...config } as never}
      numericFields={numericFields}
    />,
  );
}

// Finding 2.3: the gap input used to parse+commit `Math.max(0, Math.min(32, Number(v)))`
// on every keystroke, each an undoable commit plus a mutation-log line plus a full
// pipeline recompute.
describe('FunnelConfigSection gap input (finding 2.3)', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
    controller.updateWidgetConfig.mockClear();
  });

  it('does not commit while typing', () => {
    renderFunnel({});
    const input = screen.getByLabelText('Section gap (px)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12' } });
    expect(input.value).toBe('12');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits a valid gap on blur', () => {
    renderFunnel({});
    const input = screen.getByLabelText('Section gap (px)');
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { funnelGap: 12 });
  });

  it('clamps a value above 32 down to 32 on blur', () => {
    renderFunnel({});
    const input = screen.getByLabelText('Section gap (px)');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { funnelGap: 32 });
  });

  // A clamp that says nothing is indistinguishable from "nothing happened", so the user
  // retypes the same rejected value. The message explains the adjustment already applied.
  it('explains the clamp instead of silently adjusting the value', () => {
    renderFunnel({});
    const input = screen.getByLabelText('Section gap (px)');
    fireEvent.change(input, { target: { value: '100' } });
    expect(screen.queryByText(/Outside the allowed range/i)).toBeNull();
    fireEvent.blur(input);
    expect(screen.getByText('Outside the allowed range — adjusted to 32.')).toBeVisible();
  });

  it('clears the clamp message as soon as the value is edited again', () => {
    renderFunnel({});
    const input = screen.getByLabelText('Section gap (px)');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '8' } });
    expect(screen.queryByText(/Outside the allowed range/i)).toBeNull();
  });

  it('leaves an in-range value with no message', () => {
    renderFunnel({});
    const input = screen.getByLabelText('Section gap (px)');
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.blur(input);
    expect(screen.queryByText(/Outside the allowed range/i)).toBeNull();
  });

  it('commits undefined (not 0) when clamped to zero', () => {
    renderFunnel({ funnelGap: 12 });
    const input = screen.getByLabelText('Section gap (px)');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      funnelGap: undefined,
    });
  });

  it('reverts an unparseable value without committing', () => {
    renderFunnel({ funnelGap: 8 });
    const input = screen.getByLabelText('Section gap (px)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('8');
  });

  it('commits once on Enter', () => {
    renderFunnel({});
    const input = screen.getByLabelText('Section gap (px)');
    fireEvent.change(input, { target: { value: '4' } });
    act(() => {
      input.focus();
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { funnelGap: 4 });
  });

  // Stale-buffer-on-widget-switch (architecture review Tier2 finding): the resync effect
  // used to key off `value` alone. Switching to a DIFFERENT widget whose `funnelGap`
  // happens to carry the SAME value (both default to 0 here) looked like no change to
  // that effect, so a dirty buffer from the previous widget survived and a subsequent
  // blur would have committed the stray uncommitted text into the NEW widget's config.
  it('resyncs (clears dirty) instead of committing stale text when switching to a different widget with the same gap value', () => {
    const { setProps } = render(
      <FunnelConfigSection
        widgetId="widget-1"
        config={{ chartType: 'funnel', yField: 'count', funnelGap: 0 } as never}
        numericFields={numericFields}
      />,
    );
    const input = screen.getByLabelText('Section gap (px)') as HTMLInputElement;

    // Type into widget-1's field but never blur — buffer is dirty, nothing committed yet.
    fireEvent.change(input, { target: { value: '12' } });
    expect(input.value).toBe('12');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();

    // Switch to a different widget whose committed `funnelGap` is ALSO 0 (the default) —
    // the raw `value` prop is unchanged, only `widgetId` differs.
    setProps({
      widgetId: 'widget-2',
      config: { chartType: 'funnel', yField: 'count', funnelGap: 0 } as never,
    });

    // The buffer must have resynced to the new widget's committed value...
    expect((screen.getByLabelText('Section gap (px)') as HTMLInputElement).value).toBe('0');

    // ...so a blur now commits nothing (the buffer is clean), instead of writing the
    // stray "12" from widget-1 into widget-2's config.
    fireEvent.blur(screen.getByLabelText('Section gap (px)'));
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });
});

// The funnel value picker is a SINGLE-measure control over a config whose `ySeries` is
// shared with the multi-series chart families. It owns slot 0 only — a bar chart with three
// measures switched to funnel must still carry all three when switched back.
describe('FunnelConfigSection value field over a multi-series config', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
    controller.updateWidgetConfig.mockClear();
  });

  it('preserves the remaining series when a new value field is picked', async () => {
    const { user } = render(
      <FunnelConfigSection
        widgetId="widget-1"
        config={
          {
            chartType: 'funnel',
            yField: 'count',
            ySeries: [{ fieldId: 'count' }, { fieldId: 'other' }],
          } as never
        }
        numericFields={numericFields}
      />,
    );

    await user.click(screen.getByLabelText('Value field', { exact: false }));
    await user.click(await screen.findByRole('option', { name: /Revenue$/ }));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      ySeries: [{ fieldId: 'revenue' }, { fieldId: 'other' }],
      yField: 'revenue',
    });
  });

  // Clearing means "no measure": an empty list plus the BL-186 count re-lock, never a
  // `{ fieldId: '' }` placeholder that the multi-series panel renders as an empty series row
  // beside the locked Count select.
  it('clears to an empty series list and re-locks the aggregation to count', async () => {
    const { user } = render(
      <FunnelConfigSection
        widgetId="widget-1"
        config={{ chartType: 'funnel', yField: 'count', ySeries: [{ fieldId: 'count' }] } as never}
        numericFields={numericFields}
      />,
    );

    await user.click(screen.getByLabelText('Clear field'));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      ySeries: [],
      yField: '',
      yAggregation: 'count',
    });
  });
});

// MUI's `Select` reports no accessible name unless it is handed a `labelId` pairing it with
// its `InputLabel` — `label` alone only sizes the outline notch. Without it a screen-reader
// user hears just the selected value ("Value, combobox") with no indication of the setting.
describe('FunnelConfigSection select accessible names', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it.each(['Label format', 'Label position', 'Shape'])('names the %s select', (name) => {
    renderFunnel({});
    expect(screen.getByRole('combobox', { name })).toBeVisible();
  });
});
