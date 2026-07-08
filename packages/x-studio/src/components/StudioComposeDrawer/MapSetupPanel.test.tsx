import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { MapSetupPanel } from './MapSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
};

const mockState = {
  doc: {
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'map',
        sourceId: 'orders' as string | undefined,
        config: {
          mapGeography: 'world',
          mapCountryField: 'country',
          mapValueField: 'total',
          mapAggregation: 'sum',
        } as StudioWidgetConfig,
      },
    },
    relationships: [],
    expressionFields: [],
  },
  runtime: {
    dataSources: {
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'country', label: 'Country', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
        rows: [],
      },
      customers: {
        id: 'customers',
        label: 'Customers',
        fields: [{ id: 'country', label: 'Country', type: 'string' }],
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

describe('MapSetupPanel', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'map',
      sourceId: 'orders' as string | undefined,
      config: {
        mapGeography: 'world',
        mapCountryField: 'country',
        mapValueField: 'total',
        mapAggregation: 'sum',
      } as StudioWidgetConfig,
    };
    controller.updateWidgetConfig.mockClear();
    controller.updateWidget.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('shows the region field section for the default (world) geography', () => {
    render(<MapSetupPanel widgetId="widget-1" />);

    // "Country field" renders more than once (field label + notched-outline legend).
    expect(screen.getAllByText('Country field').length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        'A field containing ISO alpha-2 codes, alpha-3 codes, or full country names.',
      ),
    ).toBeVisible();
    // Country field is marked `required` (no fieldless fallback), so its accessible label
    // carries a trailing asterisk — match with `exact: false`. Value field stays unmarked
    // (falls back to a row count) and its label dropped the "(optional for count)" suffix.
    // The displayed value is qualified with its source ("Orders · Country") since both
    // fixture sources have a field literally labeled "Country" (DataSourceFieldSelect's
    // ambiguous-label rule).
    expect(screen.getByLabelText('Country field', { exact: false }).getAttribute('value')).toBe(
      'Orders · Country',
    );
    expect(screen.getByLabelText('Value field').getAttribute('value')).toBe('Total');
  });

  it('merges a full config update when the map type changes', async () => {
    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByText('World'));
    const usaOption = await screen.findByRole('option', { name: 'United States' });
    await user.click(usaOption);

    expect(controller.updateWidget).toHaveBeenCalledWith('widget-1', {
      config: {
        mapGeography: 'usa',
        mapCountryField: 'country',
        mapValueField: 'total',
        mapAggregation: 'sum',
      },
    });
  });

  it('toggles legend-scale-from-zero from the switch', async () => {
    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('switch', { name: 'Scale from zero' }));

    expect(controller.updateWidget).toHaveBeenCalledWith('widget-1', {
      config: {
        mapGeography: 'world',
        mapCountryField: 'country',
        mapValueField: 'total',
        mapAggregation: 'sum',
        mapLegendZeroMin: true,
      },
    });
  });

  it('locks the aggregation to a disabled Count when no value field is selected', () => {
    mockState.doc.widgets['widget-1'].config = {
      ...mockState.doc.widgets['widget-1'].config,
      mapValueField: undefined,
      mapValueSourceId: undefined,
    };

    render(<MapSetupPanel widgetId="widget-1" />);

    const aggInput = document.querySelector('input[value="count"]');
    expect(aggInput).not.toBeNull();
    expect(aggInput!.getAttribute('disabled')).toBe('');
  });

  it('adopts the field source when a country field is picked before a source exists', async () => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'map',
      sourceId: undefined,
      config: {} as StudioWidgetConfig,
    };

    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    const countryInput = screen.getByLabelText('Country field', { exact: false });
    await user.click(countryInput);
    // Both sources contribute a field literally labeled "Country"; the option list groups
    // by source ("Orders" then "Customers"), so the second "Country" option is the customers one.
    // (accessible name is prefixed by the field-type icon's label, hence the `$` anchor.)
    const countryOptions = await screen.findAllByRole('option', { name: /Country$/ });
    await user.click(countryOptions[1]);

    expect(controller.updateWidget).toHaveBeenCalledWith('widget-1', {
      sourceId: 'customers',
      config: { mapCountryField: 'country', mapCountrySourceId: undefined },
    });
  });

  // Pinning tests for the migration onto the shared CrossFilterModeSection (previously
  // a hand-rolled two-way ToggleButtonGroup with no Highlight option, and a deselect
  // no-op bug — see the regression test below).
  it('renders all three interaction buttons, including Highlight', () => {
    render(<MapSetupPanel widgetId="widget-1" />);

    expect(screen.getByRole('button', { name: 'Highlight' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'None' })).toBeVisible();
  });

  it('defaults to Highlight selected when no crossFilterMode is stored', () => {
    render(<MapSetupPanel widgetId="widget-1" />);

    expect(screen.getByRole('button', { name: 'Highlight', pressed: true })).toBeVisible();
  });

  it('regression: deselecting the active toggle commits the default mode (cross-highlight), not a no-op', async () => {
    // Under the old hand-rolled ToggleButtonGroup, `onChange` only called `update(...)`
    // `if (value)`, so clicking the already-selected button (which reports `null` on
    // deselect) silently did nothing. The shared CrossFilterModeSection always commits
    // `defaultMode` on deselect, matching Chart/Grid/Kpi.
    mockState.doc.widgets['widget-1'] = {
      ...mockState.doc.widgets['widget-1'],
      config: { ...mockState.doc.widgets['widget-1'].config, crossFilterMode: 'cross-filter' },
    };
    controller.updateWidgetConfig.mockClear();

    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    expect(screen.getByRole('button', { name: 'Filter', pressed: true })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      crossFilterMode: 'cross-highlight',
    });
  });
});
