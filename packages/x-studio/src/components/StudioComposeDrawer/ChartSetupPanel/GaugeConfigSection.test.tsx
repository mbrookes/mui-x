import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioChartConfigOfType, StudioWidget } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { StudioController } from '../../../store/StudioController';
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

// Finding 2.5: a cross-source value-field pick (which also ADOPTS that source) must
// collapse to ONE undo step, mirroring the `finding 2.2` coverage on the sibling
// setup panels (Chart/KPI/Filter). Runs against a REAL StudioController so
// `canUndo()`/`undo()` observe the actual undo stack — previously this fired two
// separate commits (`updateWidgetConfig` then `updateWidget`), leaving a lone
// Ctrl+Z on a torn `{ old sourceId, new yField }` state the UI never produced.
describe('GaugeConfigSection cross-source field pick folds to a single undo step (finding 2.5)', () => {
  function makeController() {
    return new StudioController({
      doc: {
        widgets: {
          'widget-1': {
            id: 'widget-1',
            kind: 'chart',
            title: 'Gauge',
            config: { chartType: 'gauge', gaugeMin: 0, gaugeMax: 100, yField: 'total' },
            sourceId: 'orders',
          } as StudioWidget,
        },
      },
      runtime: {
        dataSources: {
          orders: {
            id: 'orders',
            label: 'Orders',
            fields: [{ id: 'total', label: 'Total', type: 'number' }],
            rows: [],
          },
          customers: {
            id: 'customers',
            label: 'Customers',
            fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
            rows: [],
          },
        },
      },
    });
  }

  it('folds the cross-source field pick and its source adoption into one undoable step', async () => {
    const realController = makeController();
    configureStudioContextMock({
      getState: () => realController.getState(),
      controller: realController,
    });

    expect(realController.canUndo()).toBe(false);

    const allFields: DataSourceFieldEntry[] = [
      { id: 'total', label: 'Total', type: 'number', sourceId: 'orders', sourceLabel: 'Orders' },
      {
        id: 'revenue',
        label: 'Revenue',
        type: 'number',
        sourceId: 'customers',
        sourceLabel: 'Customers',
      },
    ];

    const { user } = render(
      <GaugeConfigSection
        widgetId="widget-1"
        config={{ chartType: 'gauge', gaugeMin: 0, gaugeMax: 100, yField: 'total' } as never}
        allFields={allFields}
        widgetSourceId="orders"
      />,
    );

    // "Value field" is required here, so its label carries a trailing asterisk — match with `exact: false`.
    await user.click(screen.getByLabelText('Value field', { exact: false }));
    // Name includes the field-type icon's aria-label prefix (e.g. "Number Revenue").
    const revenueOption = await screen.findByRole('option', { name: /Revenue$/ });
    await user.click(revenueOption);

    // The gesture reached the intended state: new source adopted + new field written.
    const afterGesture = realController.getState().doc.widgets['widget-1'];
    expect(afterGesture.sourceId).toBe('customers');
    expect((afterGesture.config as StudioChartConfigOfType<'gauge'>).yField).toBe('revenue');
    expect(realController.canUndo()).toBe(true);

    // Exactly ONE undo entry: a single undo fully reverts to the pre-gesture state
    // (old source AND old field together — never a torn source/field intermediate)...
    realController.undo();
    const reverted = realController.getState().doc.widgets['widget-1'];
    expect(reverted.sourceId).toBe('orders');
    expect((reverted.config as StudioChartConfigOfType<'gauge'>).yField).toBe('total');
    // ...and there is nothing left to undo, proving the gesture pushed only one entry.
    expect(realController.canUndo()).toBe(false);
  });

  // Finding 1.16: switching the gauge's value field to a field on a DIFFERENT source
  // re-sources the widget. A widget-scoped filter whose field belonged to the OLD source
  // no longer resolves against the new source and would silently exclude every row (blank
  // gauge). The cross-source pick must fold `removeFilterIds` (via
  // `collectStaleWidgetFilterIds`) into the SAME undoable commit, exactly like the sibling
  // Chart/KPI/Grid panels.
  it('removes a now-stale widget-scoped filter when re-sourcing to another source (1.16)', async () => {
    const realController = new StudioController({
      doc: {
        widgets: {
          'widget-1': {
            id: 'widget-1',
            kind: 'chart',
            title: 'Gauge',
            config: { chartType: 'gauge', gaugeMin: 0, gaugeMax: 100, yField: 'total' },
            sourceId: 'orders',
          } as StudioWidget,
        },
        filters: [
          {
            id: 'flt-stale',
            field: 'total',
            fieldType: 'number',
            operator: 'greater_than',
            value: '5',
            scope: { kind: 'widget', widgetId: 'widget-1' },
          },
        ],
      },
      runtime: {
        dataSources: {
          orders: {
            id: 'orders',
            label: 'Orders',
            fields: [{ id: 'total', label: 'Total', type: 'number' }],
            rows: [],
          },
          customers: {
            id: 'customers',
            label: 'Customers',
            fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
            rows: [],
          },
        },
      },
    });
    configureStudioContextMock({
      getState: () => realController.getState(),
      controller: realController,
    });

    expect(realController.getState().doc.filters).toHaveLength(1);

    const crossSourceFields: DataSourceFieldEntry[] = [
      { id: 'total', label: 'Total', type: 'number', sourceId: 'orders', sourceLabel: 'Orders' },
      {
        id: 'revenue',
        label: 'Revenue',
        type: 'number',
        sourceId: 'customers',
        sourceLabel: 'Customers',
      },
    ];

    const { user } = render(
      <GaugeConfigSection
        widgetId="widget-1"
        config={{ chartType: 'gauge', gaugeMin: 0, gaugeMax: 100, yField: 'total' } as never}
        allFields={crossSourceFields}
        widgetSourceId="orders"
        allFilters={realController.getState().doc.filters}
        relationships={[]}
      />,
    );

    await user.click(screen.getByLabelText('Value field', { exact: false }));
    const revenueOption = await screen.findByRole('option', { name: /Revenue$/ });
    await user.click(revenueOption);

    // Widget re-sourced to customers AND the stale orders-field filter removed — in ONE step.
    const state = realController.getState();
    expect(state.doc.widgets['widget-1'].sourceId).toBe('customers');
    expect(state.doc.filters).toHaveLength(0);

    // A single undo restores both the source and the removed filter together.
    realController.undo();
    const reverted = realController.getState();
    expect(reverted.doc.widgets['widget-1'].sourceId).toBe('orders');
    expect(reverted.doc.filters).toHaveLength(1);
  });

  it('does not adopt a new source for a same-source field pick (single commit, unchanged)', async () => {
    const realController = makeController();
    configureStudioContextMock({
      getState: () => realController.getState(),
      controller: realController,
    });

    const allFields: DataSourceFieldEntry[] = [
      { id: 'total', label: 'Total', type: 'number', sourceId: 'orders', sourceLabel: 'Orders' },
    ];

    render(
      <GaugeConfigSection
        widgetId="widget-1"
        config={{ chartType: 'gauge', gaugeMin: 0, gaugeMax: 100, yField: 'total' } as never}
        allFields={allFields}
        widgetSourceId="orders"
      />,
    );

    // No gesture performed — sanity-checks the baseline state used above.
    const state = realController.getState().doc.widgets['widget-1'];
    expect(state.sourceId).toBe('orders');
    expect(realController.canUndo()).toBe(false);
  });
});
