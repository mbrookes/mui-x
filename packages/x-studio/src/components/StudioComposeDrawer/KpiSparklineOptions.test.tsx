import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { KpiSparklineOptions } from './KpiSparklineOptions';

const controller = {
  updateWidgetConfig: vi.fn(),
};

const mockState = {
  doc: {
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'kpi',
        sourceId: 'orders',
        title: 'Orders',
        config: { kpiSparklinePlotType: 'gauge', kpiSparklineGaugeMax: 100 } as StudioWidgetConfig,
      },
    },
    filters: [],
    relationships: [],
    expressionFields: [],
  },
  runtime: {
    dataSources: {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'createdAt', label: 'Created at', type: 'date' },
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

function renderGaugeMax(config: Partial<StudioWidgetConfig> = {}) {
  mockState.doc.widgets['widget-1'] = {
    id: 'widget-1',
    kind: 'kpi',
    sourceId: 'orders',
    title: 'Orders',
    config: {
      kpiSparklinePlotType: 'gauge',
      kpiSparklineGaugeMax: 100,
      ...config,
    } as StudioWidgetConfig,
  };
  return render(
    <KpiSparklineOptions widgetId="widget-1" config={mockState.doc.widgets['widget-1'].config} />,
  );
}

// Finding 1.14: the gauge-max input used to reject anything not `> 0` on every
// keystroke, so the field could never be cleared and retyped. It now buffers the
// displayed text locally and only parses/validates/commits on blur.
describe('KpiSparklineOptions gauge max input (finding 1.14)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('allows clearing the gauge max field while typing, without committing', () => {
    renderGaugeMax();
    const input = screen.getByLabelText('Target') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits a new value once retyped and blurred', () => {
    renderGaugeMax();
    const input = screen.getByLabelText('Target') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '250' } });
    expect(input.value).toBe('250');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      kpiSparklineGaugeMax: 250,
    });
  });

  it('reverts to the last committed value when blurred empty', () => {
    renderGaugeMax();
    const input = screen.getByLabelText('Target') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('100');
  });

  it('reverts a non-positive value instead of committing it', () => {
    renderGaugeMax();
    const input = screen.getByLabelText('Target') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('100');
  });
});

// Architecture review finding 2.8: date-field derivation now goes through the
// shared `buildSourceFieldEntries` catalog helper instead of a hand-rolled fold —
// this is a regression check that temporal fields from the primary source (and a
// directly related source) still surface correctly through that helper.
describe('KpiSparklineOptions date-field derivation (finding 2.8)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'kpi',
      sourceId: 'orders',
      title: 'Orders',
      config: {} as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it("offers the primary source's date field in the time-field picker", async () => {
    const { user } = render(
      <KpiSparklineOptions widgetId="widget-1" config={mockState.doc.widgets['widget-1'].config} />,
    );
    const picker = screen.getByLabelText('Time field');
    await user.click(picker);
    // Name includes the field-type icon's aria-label prefix (e.g. "Date Created at").
    expect(await screen.findByRole('option', { name: /Created at$/ })).toBeVisible();
  });
});
