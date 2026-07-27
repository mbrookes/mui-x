import { createRenderer, screen, within } from '@mui/internal-test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    filters: [] as any[],
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

  afterEach(() => {
    // Some tests populate expression fields / filters; reset so they don't leak (isolate: false).
    mockState.doc.expressionFields = [];
    mockState.doc.filters = [];
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

  it('commits only the changed key via updateWidgetConfig when the map type changes (T3.3)', async () => {
    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByText('World'));
    const usaOption = await screen.findByRole('option', { name: 'United States' });
    await user.click(usaOption);

    // `update()` now routes through `updateWidgetConfig` (which shallow-merges and runs the
    // write-side kind guard) with ONLY the changed key, instead of `updateWidget` replacing the
    // whole config from a render-time snapshot.
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      mapGeography: 'usa',
    });
    expect(controller.updateWidget).not.toHaveBeenCalled();
  });

  it('toggles legend-scale-from-zero from the switch', async () => {
    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByRole('switch', { name: 'Scale from zero' }));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      mapLegendZeroMin: true,
    });
    expect(controller.updateWidget).not.toHaveBeenCalled();
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

    expect(controller.updateWidget).toHaveBeenCalledWith(
      'widget-1',
      {
        sourceId: 'customers',
        config: { mapCountryField: 'country', mapCountrySourceId: undefined },
      },
      // No widget-scoped filters in this fixture, so nothing to fold in (finding 1.6).
      { removeFilterIds: [] },
    );
  });

  // ─── Finding 1.6 ────────────────────────────────────────────────────────────
  it('folds removal of a now-stale widget-scoped filter into the source-adoption commit', async () => {
    // Source-less map with a widget-scoped filter on source A's ('orders') field. Adopting
    // an unrelated source B ('customers') via the country picker leaves that A-scoped filter
    // matching by widgetId, so its field never resolves against B and every row is excluded —
    // a silently blank map. The adoption commit must remove the stale filter (finding 1.6).
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'map',
      sourceId: undefined,
      config: {} as StudioWidgetConfig,
    };
    mockState.doc.filters = [
      {
        id: 'f-stale',
        scope: { kind: 'widget', widgetId: 'widget-1' },
        field: 'total',
        // No filterSourceId → targets the widget's (about-to-be-adopted) source.
      },
    ];
    configureStudioContextMock({ getState: () => mockState, controller });

    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    const countryInput = screen.getByLabelText('Country field', { exact: false });
    await user.click(countryInput);
    const countryOptions = await screen.findAllByRole('option', { name: /Country$/ });
    // Pick the customers ('B') country field — unrelated to the orders-scoped 'total' filter.
    await user.click(countryOptions[1]);

    expect(controller.updateWidget).toHaveBeenCalledWith(
      'widget-1',
      expect.objectContaining({ sourceId: 'customers' }),
      { removeFilterIds: ['f-stale'] },
    );

    mockState.doc.filters = [];
  });

  // ─── Finding 3.12 ───────────────────────────────────────────────────────────
  it('resolves the value field against the widget source on an id collision (own-source fallback)', () => {
    // The map's value field lives on 'customers', but 'orders' (which iterates FIRST in the
    // numeric-field list) exposes a colliding 'total' id. With no explicit mapValueSourceId,
    // the unscoped lookup would surface the orders entry ("Total"); the `?? widget?.sourceId`
    // fallback must anchor on the widget's own source ('customers') → "Customer Total".
    mockState.runtime.dataSources.customers.fields = [
      { id: 'country', label: 'Country', type: 'string' },
      { id: 'total', label: 'Customer Total', type: 'number' },
    ] as any;
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'map',
      sourceId: 'customers',
      config: {
        mapGeography: 'world',
        mapCountryField: 'country',
        mapValueField: 'total',
        mapValueSourceId: undefined,
        mapAggregation: 'sum',
      } as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });

    render(<MapSetupPanel widgetId="widget-1" />);

    expect(screen.getByLabelText('Value field').getAttribute('value')).toBe('Customer Total');

    mockState.runtime.dataSources.customers.fields = [
      { id: 'country', label: 'Country', type: 'string' },
    ] as any;
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

  // M16 — BEHAVIOUR CHANGE. This used to assert that clicking the already-selected toggle
  // committed `defaultMode`. `CrossFilterModeSection` now ignores an exclusive group's `null`
  // deselect, like every sibling exclusive group in the drawer: these modes have no "nothing
  // selected" state, so clicking the selected button expresses no new choice, and silently
  // moving the widget to a different mode is the bug (see `CrossFilterModeSection.test.tsx`).
  it('leaves the active toggle alone when it is clicked again', async () => {
    mockState.doc.widgets['widget-1'] = {
      ...mockState.doc.widgets['widget-1'],
      config: { ...mockState.doc.widgets['widget-1'].config, crossFilterMode: 'cross-filter' },
    };
    controller.updateWidgetConfig.mockClear();

    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    expect(screen.getByRole('button', { name: 'Filter', pressed: true })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Filter', pressed: true })).toBeVisible();
  });

  // ─── Finding 2.1 ────────────────────────────────────────────────────────────
  it('excludes non-numeric expression fields from the value-field options', async () => {
    mockState.doc.expressionFields = [
      {
        id: 'expr-num',
        label: 'Margin',
        type: 'number',
        sourceId: 'orders',
        isMeasure: false,
        expression: { type: 'number', value: 0 },
      },
      {
        id: 'expr-str',
        label: 'Region Name',
        type: 'string',
        sourceId: 'orders',
        isMeasure: false,
        expression: { type: 'number', value: 0 },
      },
    ] as unknown as typeof mockState.doc.expressionFields;
    configureStudioContextMock({ getState: () => mockState, controller });

    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Value field'));

    // The numeric expression field is offered as a value option...
    expect(await screen.findByRole('option', { name: /Margin$/ })).toBeVisible();
    // ...but the string expression field is NOT (it would coerce to NaN → blank map).
    expect(screen.queryByRole('option', { name: /Region Name$/ })).toBeNull();
  });

  it('resets the aggregation to count when the value field is cleared', async () => {
    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    // Two fields carry a "Clear field" button (country + value); target the value one.
    const valueRoot = screen
      .getByLabelText('Value field')
      .closest('.MuiAutocomplete-root') as HTMLElement;
    await user.click(within(valueRoot).getByLabelText('Clear field'));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith(
      'widget-1',
      expect.objectContaining({
        mapValueField: undefined,
        mapValueSourceId: undefined,
        // Locked "Count" label and renderer now agree: no stale avg/min/max over per-row 1s.
        mapAggregation: 'count',
      }),
    );
  });

  // ─── Finding 3 (architecture review) ────────────────────────────────────────
  // Both pickers previously offered every field from every visible source with no
  // reachability filter — an unrelated-source pick commits fine but can never be
  // enriched onto the widget's rows, silently blanking every region.
  describe('reachability filtering for unrelated sources (finding 3)', () => {
    it('disables an unrelated source field once the widget already has an anchor source', async () => {
      // Default fixture: widget-1 is anchored on 'orders'; `relationships` is empty, so
      // 'customers' has NO resolvable relationship to 'orders'.
      const { user } = render(<MapSetupPanel widgetId="widget-1" />);

      const countryInput = screen.getByLabelText('Country field', { exact: false });
      await user.click(countryInput);
      const countryOptions = await screen.findAllByRole('option', { name: /Country$/ });

      // Options are grouped by source in fixture order ("Orders" then "Customers"), so
      // index 0 is the widget's own (reachable) field and index 1 is the unrelated one.
      expect(countryOptions[0].getAttribute('aria-disabled')).toBe('false');
      expect(countryOptions[1].getAttribute('aria-disabled')).toBe('true');
    });

    it('shows a warning when the stored country field is not reachable from the widget source', () => {
      mockState.doc.widgets['widget-1'] = {
        ...mockState.doc.widgets['widget-1'],
        config: {
          ...mockState.doc.widgets['widget-1'].config,
          mapCountryField: 'country',
          mapCountrySourceId: 'customers',
        },
      };

      render(<MapSetupPanel widgetId="widget-1" />);

      expect(
        screen.getByText(
          'This field is not from the widget source or a directly related source, so it cannot be resolved and the map will render blank.',
        ),
      ).toBeVisible();
    });

    it('does not disable the currently-selected (even if unreachable) option', async () => {
      mockState.doc.widgets['widget-1'] = {
        ...mockState.doc.widgets['widget-1'],
        config: {
          ...mockState.doc.widgets['widget-1'].config,
          mapCountryField: 'country',
          mapCountrySourceId: 'customers',
        },
      };

      const { user } = render(<MapSetupPanel widgetId="widget-1" />);

      const countryInput = screen.getByLabelText('Country field', { exact: false });
      await user.click(countryInput);
      const countryOptions = await screen.findAllByRole('option', { name: /Country$/ });

      // index 1 (customers) is the currently-stored value — it must stay enabled/selectable
      // even though it's unreachable, so the user isn't locked out of re-confirming or
      // re-picking it.
      expect(countryOptions[1].getAttribute('aria-disabled')).toBe('false');
    });

    it('does not disable anything when the widget has no source yet', async () => {
      mockState.doc.widgets['widget-1'] = {
        id: 'widget-1',
        kind: 'map',
        sourceId: undefined,
        config: {} as StudioWidgetConfig,
      };

      const { user } = render(<MapSetupPanel widgetId="widget-1" />);

      const countryInput = screen.getByLabelText('Country field', { exact: false });
      await user.click(countryInput);
      const countryOptions = await screen.findAllByRole('option', { name: /Country$/ });

      expect(countryOptions[0].getAttribute('aria-disabled')).toBe('false');
      expect(countryOptions[1].getAttribute('aria-disabled')).toBe('false');
    });
  });
});

// ─── Finding 2: the map comboboxes must have a programmatic name ───────────────
//
// MUI's `Select` only emits `aria-labelledby` when handed an explicit `labelId`, and
// `InputLabel` does not derive an `id`/`htmlFor` from `FormControl` context (its `label`
// prop only sizes the outline notch). These comboboxes therefore announced just their own
// display text ("World", "Sum") — and since `combobox` is not a name-from-content role,
// strictly they had no accessible name at all.
describe('MapSetupPanel — combobox accessible names (finding 2)', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('names the map type, aggregation and colour scheme selects after their visible labels', () => {
    render(<MapSetupPanel widgetId="widget-1" />);

    expect(screen.getByRole('combobox', { name: 'Map type' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Aggregation' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Color scheme' })).toBeVisible();
  });
});
// ─── H3: the value picker adopts a source too ────────────────────────────────
//
// `createDefaultWidget` never sets `sourceId`, so a map starts source-less. The COUNTRY
// picker adopted the picked field's source from the start; the VALUE picker did not — it
// wrote `mapValueField` plus a `mapValueSourceId` derived from comparing against a
// `widget.sourceId` that was `undefined`, so the widget stayed source-less and rendered
// blank while the aggregation Select unlocked to "Sum" and nothing warned.
describe('MapSetupPanel value-field source adoption (H3)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    controller.updateWidget.mockClear();
  });

  it('adopts the field source when a value field is picked before a source exists', async () => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'map',
      sourceId: undefined,
      config: {} as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });

    const { user } = render(<MapSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Value field', { exact: false }));
    await user.click(await screen.findByRole('option', { name: /Total$/ }));

    expect(controller.updateWidget).toHaveBeenCalledWith(
      'widget-1',
      {
        sourceId: 'orders',
        // Adopted as the PRIMARY source, so the field is native and carries no
        // `mapValueSourceId` — the value the old code wrote was meaningless anyway, since it
        // compared against a `widget.sourceId` that did not exist.
        config: { mapValueField: 'total', mapValueSourceId: undefined },
      },
      { removeFilterIds: [] },
    );
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  // The region field is the map's natural anchor, so an established source is not re-pointed
  // by a measure pick: a cross-source measure is enriched through the declared relationship.
  it('does not re-anchor an established source; it stores the cross-source id instead', async () => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'map',
      sourceId: 'customers',
      config: { mapCountryField: 'country' } as StudioWidgetConfig,
    };
    // The measure lives across a declared relationship, so it is reachable (and therefore
    // selectable) from the widget's own source.
    mockState.doc.relationships = [
      {
        id: 'rel-customers-orders',
        sourceId: 'customers',
        sourceField: 'orderId',
        targetId: 'orders',
        targetField: 'id',
        type: 'many-to-one',
      },
    ] as any;
    configureStudioContextMock({ getState: () => mockState, controller });

    try {
      const { user } = render(<MapSetupPanel widgetId="widget-1" />);

      await user.click(screen.getByLabelText('Value field', { exact: false }));
      await user.click(await screen.findByRole('option', { name: /Total$/ }));

      expect(controller.updateWidget).not.toHaveBeenCalled();
      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
        mapValueField: 'total',
        mapValueSourceId: 'orders',
      });
    } finally {
      mockState.doc.relationships = [];
    }
  });
});
