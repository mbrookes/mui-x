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
  doc: {
    dashboard: { activePageId: 'page-1', crossFilterAllPages: false },
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'kpi',
        sourceId: 'orders',
        title: 'Revenue',
        // Widened deliberately: a later test simulates an external write setting this, and a
        // bare `undefined` would narrow the property's inferred type to `undefined` alone.
        subtitle: undefined as string | undefined,
        config: {
          kpiField: 'total',
          kpiAggregation: 'sum',
          kpiCompact: true,
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
        fields: [{ id: 'total', label: 'Total', type: 'number' }],
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

describe('FormatPanel', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
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
    mockState.doc.widgets['widget-1'] = {
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

  // ─── Grid height field keystroke regression (architecture review 1.3) ──────
  //
  // The input used to be fully controlled and gated the state write on
  // `parsed >= 200`, so typing "6" after select-all produced `parsed = 6 < 200`,
  // the update was dropped, and React snapped the DOM back to the old value —
  // every intermediate keystroke below 200 was discarded.
  describe('grid height field', () => {
    beforeEach(() => {
      mockState.doc.widgets['widget-1'] = {
        id: 'widget-1',
        kind: 'grid',
        sourceId: 'orders',
        title: 'Orders table',
        subtitle: undefined,
        config: { gridHeight: 400 } as StudioWidgetConfig,
      };
    });

    it('does not discard an intermediate keystroke below the 200 minimum', async () => {
      const { user } = render(<FormatPanel widgetId="widget-1" />);

      const input = screen.getByLabelText('Height (px)') as HTMLInputElement;
      await user.clear(input);
      await user.type(input, '6');

      // The keystroke must survive in the field even though "6" is below the
      // documented minimum — clamping only happens on commit (blur/Enter).
      expect(input.value).toBe('6');
      // No premature commit while the value is still below the minimum.
      expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    });

    it('clamps to the 200px minimum on blur', async () => {
      const { user } = render(<FormatPanel widgetId="widget-1" />);

      const input = screen.getByLabelText('Height (px)') as HTMLInputElement;
      await user.clear(input);
      await user.type(input, '6');
      await user.tab();

      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { gridHeight: 200 });
      expect(input.value).toBe('200');
    });

    it('commits a valid value as-is on blur', async () => {
      const { user } = render(<FormatPanel widgetId="widget-1" />);

      const input = screen.getByLabelText('Height (px)') as HTMLInputElement;
      await user.clear(input);
      await user.type(input, '650');
      await user.tab();

      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { gridHeight: 650 });
      expect(input.value).toBe('650');
    });
  });

  it('shows the legend-alignment control only when the map legend is not hidden', async () => {
    mockState.doc.widgets['widget-1'] = {
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
    mockState.doc.widgets['widget-1'] = {
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

  // ─── Shared LegendPositionSection: map/heatmap parity (architecture review 2.6) ─
  //
  // The map and heatmap legend blocks used to be two independent ~60-line
  // copy-pasted control blocks (config-key prefix `map*` vs `heat*`). They now
  // both render through the same `LegendPositionSection` helper — these tests
  // mirror the map-legend tests above but for the heatmap chart config, to prove
  // the extraction behaves identically for both callers.
  it('shows the legend-alignment control only when the heatmap legend is not hidden', async () => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'chart',
      sourceId: 'orders',
      title: 'Orders heatmap',
      subtitle: undefined,
      config: { chartType: 'heatmap', heatLegendPosition: 'bottom' } as StudioWidgetConfig,
    };

    const { user } = render(<FormatPanel widgetId="widget-1" />);

    expect(screen.getAllByText('Legend alignment').length).toBeGreaterThan(0);

    await user.click(screen.getByText('Bottom'));
    const hiddenOption = await screen.findByRole('option', { name: 'None' });
    await user.click(hiddenOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      heatLegendPosition: 'hidden',
    });
  });

  it('hides the legend-alignment control once the heatmap legend is hidden', () => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'chart',
      sourceId: 'orders',
      title: 'Orders heatmap',
      subtitle: undefined,
      config: { chartType: 'heatmap', heatLegendPosition: 'hidden' } as StudioWidgetConfig,
    };

    render(<FormatPanel widgetId="widget-1" />);

    expect(screen.queryByText('Legend alignment')).toBeNull();
  });
});

// ─── Finding 5: an external change must not discard an in-progress edit ────────
//
// Title, subtitle and grid height share one `formState` object, and the resync effect used
// to overwrite the WHOLE object while ignoring the dirty flags it maintains. The compose
// drawer and the AI chat panel are usable at the same time and the AI tool surface includes
// `update_widget`, so an external write to one field (or a host `setState`) landed mid-typing
// and silently threw away the uncommitted edit to another.
describe('FormatPanel — per-field dirty-aware resync (finding 5)', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
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

  // `nonce` only exists to force the re-render the real store would have triggered.
  function Wrapper(props: { nonce: number }) {
    return (
      <div data-nonce={props.nonce}>
        <FormatPanel widgetId="widget-1" />
      </div>
    );
  }

  it('keeps an uncommitted title edit when an external write changes the subtitle', async () => {
    const { user, setProps } = render(<Wrapper nonce={0} />);

    const titleInput = screen.getByLabelText('Widget title') as HTMLInputElement;
    await user.clear(titleInput);
    await user.type(titleInput, 'Draft title');
    expect(titleInput.value).toBe('Draft title');

    // An external write (AI `update_widget` / host `setState`) touches ONLY the subtitle.
    mockState.doc.widgets['widget-1'] = {
      ...mockState.doc.widgets['widget-1'],
      subtitle: 'From the assistant',
    };
    setProps({ nonce: 1 });

    // The dirty title buffer survives...
    expect((screen.getByLabelText('Widget title') as HTMLInputElement).value).toBe('Draft title');
    // ...while the clean subtitle field still tracks the store.
    expect((screen.getByLabelText('Subtitle') as HTMLInputElement).value).toBe(
      'From the assistant',
    );
  });

  it('still resyncs a clean field when the store changes it (undo/redo, external edit)', async () => {
    const { setProps } = render(<Wrapper nonce={0} />);

    expect((screen.getByLabelText('Widget title') as HTMLInputElement).value).toBe('Revenue');

    mockState.doc.widgets['widget-1'] = {
      ...mockState.doc.widgets['widget-1'],
      title: 'Total revenue',
    };
    setProps({ nonce: 1 });

    expect((screen.getByLabelText('Widget title') as HTMLInputElement).value).toBe('Total revenue');
  });
});

// ─── Finding 2: the legend comboboxes must have a programmatic name ────────────
describe('FormatPanel — legend combobox accessible names (finding 2)', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'map',
      sourceId: 'orders',
      title: 'Orders map',
      subtitle: undefined,
      config: { mapLegendPosition: 'bottom' } as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('names the legend position/alignment selects after their visible labels', () => {
    render(<FormatPanel widgetId="widget-1" />);

    // Previously neither `<Select>` carried `aria-labelledby`, so the only announced text was
    // the value itself ("Bottom"/"Center") — `combobox` is not a name-from-content role, so
    // strictly there was no accessible name at all.
    expect(screen.getByRole('combobox', { name: 'Legend position' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Legend alignment' })).toBeVisible();
  });
});
