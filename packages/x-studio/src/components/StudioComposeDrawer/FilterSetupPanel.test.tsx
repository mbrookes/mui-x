import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { FilterSetupPanel } from './FilterSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
  clearInteractiveFilter: vi.fn(),
};

const mockState = {
  doc: {
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'filter',
        sourceId: 'orders',
        config: {
          filterWidgetType: 'multi-select',
          filterWidgetField: 'status',
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
          { id: 'status', label: 'Status', type: 'string' },
          { id: 'amount', label: 'Amount', type: 'number' },
          { id: 'placedAt', label: 'Placed At', type: 'date' },
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

describe('FilterSetupPanel', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'filter',
      sourceId: 'orders',
      config: {
        filterWidgetType: 'multi-select',
        filterWidgetField: 'status',
      } as StudioWidgetConfig,
    };
    controller.updateWidgetConfig.mockClear();
    controller.updateWidget.mockClear();
    controller.clearInteractiveFilter.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('shows the control-type select and the selected field', () => {
    render(<FilterSetupPanel widgetId="widget-1" />);

    expect(screen.getAllByText('Control type').length).toBeGreaterThan(0);
    // The field picker is marked `required` (no fieldless fallback), so its accessible
    // label carries a trailing asterisk — match with `exact: false`, scoped to the input
    // so it doesn't also match the filled-state "Clear field" button's aria-label.
    expect(
      screen.getByLabelText('Field', { exact: false, selector: 'input' }).getAttribute('value'),
    ).toBe('Status');
    expect(screen.queryByText('Select a field to configure the filter control.')).toBeNull();
  });

  it('switches the control type to slider and reveals the min/max/step inputs', async () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'multi-select',
      filterWidgetField: 'amount',
    };

    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByText('Multi-select'));
    const sliderOption = await screen.findByRole('option', { name: /^Slider/ });
    await user.click(sliderOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetType: 'slider',
    });
    expect(controller.clearInteractiveFilter).toHaveBeenCalledWith('widget-1');
  });

  it('clears an incompatible field when switching to date-range', async () => {
    // "status" is a string field, incompatible with date-range.
    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByText('Multi-select'));
    const dateRangeOption = await screen.findByRole('option', { name: /^Date range/ });
    await user.click(dateRangeOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetType: 'date-range',
      filterWidgetField: undefined,
      // The now-orphaned source id is dropped alongside the field (finding 3.13).
      filterWidgetSourceId: undefined,
    });
  });

  // Finding 3.13: clearing the field must store `undefined` for the source id, not the `''`
  // the empty `newSourceId` would otherwise persist (a lingering empty-string source id is
  // stale doc garbage no lookup resolves).
  it('stores undefined (not empty string) for the source id when the field is cleared (finding 3.13)', async () => {
    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Clear field'));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetField: undefined,
      filterWidgetSourceId: undefined,
    });
    expect(controller.clearInteractiveFilter).toHaveBeenCalledWith('widget-1');
  });

  // Finding 3.14: the type-switch compatibility check must resolve the configured field
  // scoped to its own source. An earlier-sorting unrelated source sharing the field id (but
  // a different type) must not decide whether the field is wiped on a control-type switch.
  it('resolves the configured field scoped to its source when deciding type-switch compatibility (finding 3.14)', async () => {
    const previousWidget = mockState.doc.widgets['widget-1'];
    const previousSources = mockState.runtime.dataSources;

    try {
      mockState.runtime.dataSources = {
        // Sorts before "Orders"; shares the 'shared' id but as a STRING (date-range-incompatible).
        aaa: {
          id: 'aaa',
          label: 'Aaa',
          fields: [{ id: 'shared', label: 'Aaa Shared', type: 'string' }],
          rows: [],
        },
        orders: {
          id: 'orders',
          label: 'Orders',
          fields: [{ id: 'shared', label: 'Shared', type: 'date' }],
          rows: [],
        },
      } as typeof previousSources;
      // Widget's own 'shared' field is the DATE one — compatible with date-range.
      mockState.doc.widgets['widget-1'] = {
        ...previousWidget,
        sourceId: 'orders',
        config: { filterWidgetType: 'multi-select', filterWidgetField: 'shared' },
      };

      const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

      await user.click(screen.getByText('Multi-select'));
      const dateRangeOption = await screen.findByRole('option', { name: /^Date range/ });
      await user.click(dateRangeOption);

      // The widget-source date field is compatible → the field is PRESERVED (only the type
      // changes). Before the fix, the earlier-sorting string 'aaa.shared' won the bare-id
      // lookup and the field was wrongly wiped.
      expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
        filterWidgetType: 'date-range',
      });
    } finally {
      mockState.doc.widgets['widget-1'] = previousWidget;
      mockState.runtime.dataSources = previousSources;
    }
  });

  it('shows the slider range inputs only when the control type is slider', () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'slider',
      filterWidgetField: 'amount',
    };

    render(<FilterSetupPanel widgetId="widget-1" />);

    expect(screen.getByLabelText('Min')).toBeVisible();
    expect(screen.getByLabelText('Max')).toBeVisible();
    expect(screen.getByLabelText('Step')).toBeVisible();
  });

  it('updates the slider min value via the min input on blur', async () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'slider',
      filterWidgetField: 'amount',
    };

    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    const input = screen.getByLabelText('Min');
    await user.type(input, '5');
    // Finding 2.3: buffered locally — no commit until blur/Enter.
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetMin: 5,
    });
  });

  it('does not commit slider min/max/step while typing, only on blur (finding 2.3)', () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'slider',
      filterWidgetField: 'amount',
    };

    render(<FilterSetupPanel widgetId="widget-1" />);

    const minInput = screen.getByLabelText('Min') as HTMLInputElement;
    fireEvent.change(minInput, { target: { value: '1' } });
    fireEvent.change(minInput, { target: { value: '10' } });
    fireEvent.change(minInput, { target: { value: '100' } });
    expect(minInput.value).toBe('100');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();

    fireEvent.blur(minInput);
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetMin: 100,
    });
  });

  it('commits the max value once on Enter', () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'slider',
      filterWidgetField: 'amount',
    };

    render(<FilterSetupPanel widgetId="widget-1" />);

    const maxInput = screen.getByLabelText('Max') as HTMLInputElement;
    fireEvent.change(maxInput, { target: { value: '200' } });
    act(() => {
      maxInput.focus();
    });
    fireEvent.keyDown(maxInput, { key: 'Enter' });

    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetMax: 200,
    });
  });

  it('commits an empty step as undefined on blur, not NaN', () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'slider',
      filterWidgetField: 'amount',
      filterWidgetStep: 5,
    };

    render(<FilterSetupPanel widgetId="widget-1" />);

    const stepInput = screen.getByLabelText('Step') as HTMLInputElement;
    fireEvent.change(stepInput, { target: { value: '' } });
    fireEvent.blur(stepInput);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetStep: undefined,
    });
  });

  it('shows the "select a field" alert when no field is configured', () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'multi-select',
    };

    render(<FilterSetupPanel widgetId="widget-1" />);

    expect(screen.getByText('Select a field to configure the filter control.')).toBeVisible();
  });

  // Stale-buffer-on-widget-switch (architecture review Tier2 finding): the slider bound
  // inputs' resync effect used to key off the derived `initialText` alone. Switching to a
  // DIFFERENT widget whose slider min happens to carry the SAME value looked like no change
  // to that effect, so a dirty buffer from the previous widget survived and a subsequent
  // blur would have committed the stray uncommitted text into the NEW widget's config.
  it('resyncs (clears dirty) the slider min buffer instead of committing stale text when switching widgets', () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'slider',
      filterWidgetField: 'amount',
      filterWidgetMin: 0,
    };
    (mockState.doc.widgets as Record<string, (typeof mockState.doc.widgets)['widget-1']>)[
      'widget-2'
    ] = {
      id: 'widget-2',
      kind: 'filter',
      sourceId: 'orders',
      config: {
        filterWidgetType: 'slider',
        filterWidgetField: 'amount',
        filterWidgetMin: 0,
      } as StudioWidgetConfig,
    };

    const { setProps } = render(<FilterSetupPanel widgetId="widget-1" />);
    const input = screen.getByLabelText('Min') as HTMLInputElement;

    // Type into widget-1's min field but never blur — buffer is dirty, nothing committed.
    fireEvent.change(input, { target: { value: '999' } });
    expect(input.value).toBe('999');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();

    // Switch to a different widget whose committed slider min is ALSO 0.
    setProps({ widgetId: 'widget-2' });

    // The buffer must have resynced to the new widget's committed value...
    expect((screen.getByLabelText('Min') as HTMLInputElement).value).toBe('0');

    // ...so a blur now commits nothing, instead of writing the stray "999" from widget-1
    // into widget-2's config.
    fireEvent.blur(screen.getByLabelText('Min'));
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  // Finding 7 (architecture review): a slider's explicit min/max/step are scoped to the
  // field they were set for. Re-pointing the filter at a different field (e.g. a 0-1000
  // price slider re-pointed at a 0-1 rate field) must not keep the stale bounds — that
  // renders a useless slider (the new field's whole range collapses to a sliver of the old
  // scale). `StudioFilterWidget` already recomputes sensible auto min/max/step from the
  // field's actual row data whenever these are `undefined`.
  it('resets slider min/max/step when the field changes (finding 7)', async () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'slider',
      filterWidgetField: 'amount',
      filterWidgetMin: 0,
      filterWidgetMax: 1000,
      filterWidgetStep: 50,
    };

    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Field', { exact: false, selector: 'input' }));
    // "placedAt" (date) is still slider-compatible (temporal), so it's a selectable option.
    const placedAtOption = await screen.findByRole('option', { name: /Placed At$/ });
    await user.click(placedAtOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetField: 'placedAt',
      filterWidgetSourceId: undefined,
      filterWidgetMin: undefined,
      filterWidgetMax: undefined,
      filterWidgetStep: undefined,
    });
  });

  it('does not touch min/max/step on a field change when the control type is not slider', async () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'multi-select',
      filterWidgetField: 'status',
    };

    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Field', { exact: false, selector: 'input' }));
    const amountOption = await screen.findByRole('option', { name: /Amount$/ });
    await user.click(amountOption);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      filterWidgetField: 'amount',
      filterWidgetSourceId: undefined,
    });
  });
});

// Finding 2.2: picking a filter field from a different source ADOPTS that source. That
// single gesture must collapse to ONE undo step. This runs the panel against a REAL
// StudioController so `canUndo()`/`undo()` observe the actual undo stack — proving the
// source adoption and the field write were folded into one commit (clearInteractiveFilter
// is a separate non-undoable/session commit and must NOT add an undo entry), rather than
// leaving a lone Ctrl+Z on a torn state (new sourceId, old field) the UI never produced.
describe('FilterSetupPanel — cross-source field pick folds to a single undo step (finding 2.2)', () => {
  function makeController() {
    return new StudioController({
      doc: {
        widgets: {
          'widget-1': {
            id: 'widget-1',
            kind: 'filter',
            title: 'Filter',
            config: { filterWidgetType: 'multi-select', filterWidgetField: 'status' },
            sourceId: 'orders',
          } as StudioWidget,
        },
      },
      runtime: {
        dataSources: {
          orders: {
            id: 'orders',
            label: 'Orders',
            fields: [{ id: 'status', label: 'Status', type: 'string' }],
            rows: [],
          },
          customers: {
            id: 'customers',
            label: 'Customers',
            fields: [{ id: 'segment', label: 'Segment', type: 'string' }],
            rows: [],
          },
        },
      },
    });
  }

  it('folds a cross-source field pick and its source adoption into one undoable step', async () => {
    const realController = makeController();
    configureStudioContextMock({
      getState: () => realController.getState(),
      controller: realController,
    });

    expect(realController.canUndo()).toBe(false);

    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Field', { exact: false, selector: 'input' }));
    // Name includes the field-type icon's aria-label prefix (e.g. "Text Segment").
    const segmentOption = await screen.findByRole('option', { name: /Segment$/ });
    await user.click(segmentOption);

    // The gesture reached the intended state: new source adopted + new field written.
    const afterGesture = realController.getState().doc.widgets['widget-1'];
    expect(afterGesture.sourceId).toBe('customers');
    expect((afterGesture.config as StudioWidgetConfig).filterWidgetField).toBe('segment');
    expect(realController.canUndo()).toBe(true);

    // Exactly ONE undo entry: a single undo fully reverts to the pre-gesture state (old
    // source AND old field together — never a torn source/field intermediate)...
    realController.undo();
    const reverted = realController.getState().doc.widgets['widget-1'];
    expect(reverted.sourceId).toBe('orders');
    expect((reverted.config as StudioWidgetConfig).filterWidgetField).toBe('status');
    // ...and nothing remains to undo, proving the gesture pushed only one entry.
    expect(realController.canUndo()).toBe(false);
  });
});

/**
 * The three slider bounds were never cross-validated here, while `StudioFilterWidget`
 * silently sanitizes them at render time — it swaps an inverted min/max, replaces a
 * zero-width range with a hard-coded 0-100, and discards a non-positive step. The author
 * saw a slider that simply ignored what they typed, with nothing said in the panel.
 */
describe('FilterSetupPanel — slider bound cross-validation', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  function renderWithSliderConfig(extra: Record<string, unknown>) {
    const previousConfig = mockState.doc.widgets['widget-1'].config;
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'slider',
      filterWidgetField: 'amount',
      ...extra,
    } as StudioWidgetConfig;
    const view = render(<FilterSetupPanel widgetId="widget-1" />);
    return {
      ...view,
      restore: () => {
        mockState.doc.widgets['widget-1'].config = previousConfig;
      },
    };
  }

  it('flags an inverted min/max on both bound inputs', () => {
    const { restore } = renderWithSliderConfig({ filterWidgetMin: 100, filterWidgetMax: 10 });
    try {
      // The widget would silently swap these; say so instead.
      const messages = screen.getAllByText(/Min must be below Max/);
      expect(messages.length).toBe(2);
    } finally {
      restore();
    }
  });

  it('flags a zero-width range (the widget replaces it wholesale with 0-100)', () => {
    const { restore } = renderWithSliderConfig({ filterWidgetMin: 50, filterWidgetMax: 50 });
    try {
      expect(screen.getAllByText(/Min must be below Max/).length).toBe(2);
    } finally {
      restore();
    }
  });

  it('flags a non-positive step', () => {
    const { restore } = renderWithSliderConfig({
      filterWidgetMin: 0,
      filterWidgetMax: 100,
      filterWidgetStep: 0,
    });
    try {
      expect(screen.getByText(/Step must be above 0/)).not.toBe(null);
    } finally {
      restore();
    }
  });

  it('flags a step wider than the configured range', () => {
    const { restore } = renderWithSliderConfig({
      filterWidgetMin: 0,
      filterWidgetMax: 10,
      filterWidgetStep: 50,
    });
    try {
      expect(screen.getByText(/Step is wider than/)).not.toBe(null);
    } finally {
      restore();
    }
  });

  it('says nothing for a consistent min/max/step triple', () => {
    const { restore } = renderWithSliderConfig({
      filterWidgetMin: 0,
      filterWidgetMax: 100,
      filterWidgetStep: 5,
    });
    try {
      expect(screen.queryByText(/Min must be below Max/)).toBe(null);
      expect(screen.queryByText(/Step must be above 0/)).toBe(null);
      expect(screen.queryByText(/Step is wider than/)).toBe(null);
    } finally {
      restore();
    }
  });

  it('says nothing while only one bound is set (a half-finished edit is legitimate)', () => {
    const { restore } = renderWithSliderConfig({ filterWidgetMin: 100 });
    try {
      expect(screen.queryByText(/Min must be below Max/)).toBe(null);
    } finally {
      restore();
    }
  });
});

// ─── Finding 8: expression fields must be selectable in a filter widget ────────
//
// The picker used to be fed the raw `dataSources` record, and `DataSourceFieldSelect`'s
// `dataSources` branch folds `src.fields` only — so a calculated field could never be chosen
// as a filter-widget field, with nothing in the UI explaining the absence. Every other setup
// panel goes through `buildFieldCatalog`/`buildSourceFieldEntries`.
describe('FilterSetupPanel — calculated fields are selectable (finding 8)', () => {
  const previousExpressionFields = mockState.doc.expressionFields;

  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'filter',
      sourceId: 'orders',
      config: {
        filterWidgetType: 'multi-select',
        filterWidgetField: 'status',
      } as StudioWidgetConfig,
    };
    mockState.doc.expressionFields = [
      {
        id: 'expr-tier',
        label: 'Customer Tier',
        sourceId: 'orders',
        type: 'string',
        isMeasure: false,
        expression: { type: 'string', value: 'gold' },
      },
    ] as unknown as typeof previousExpressionFields;
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  afterEach(() => {
    mockState.doc.expressionFields = previousExpressionFields;
  });

  it('offers a calculated field as a filter-widget field', async () => {
    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Field', { exact: false, selector: 'input' }));

    expect(await screen.findByRole('option', { name: /Customer Tier$/ })).toBeVisible();
  });

  it('still applies the control-type capability filter to the catalog', async () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'date-range',
      filterWidgetField: 'placedAt',
    } as StudioWidgetConfig;

    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Field', { exact: false, selector: 'input' }));

    // A date-range control only accepts temporal fields — the string calculated field and the
    // numeric physical field are both excluded, exactly as the old `filterCapability` did.
    expect(await screen.findByRole('option', { name: /Placed At$/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /Customer Tier$/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Amount$/ })).toBeNull();
  });

  // HIGH 1. A calculated (row-level) expression field is filterable; a MEASURE is not. A measure
  // has no per-row value at all (`enrichRowsWithExpressions` skips measures), so the control
  // could never filter anything: `MultiSelectControl` derives its options from the distinct row
  // values and came up empty, with nothing anywhere explaining why.
  it('does not offer a measure expression field as a filter-widget field', async () => {
    mockState.doc.expressionFields = [
      ...(mockState.doc.expressionFields as unknown as unknown[]),
      {
        id: 'aov',
        label: 'Avg order value',
        sourceId: 'orders',
        type: 'number',
        isMeasure: true,
        expression: {
          operator: 'divide',
          inputs: [
            { id: 'amount', aggregation: 'sum' },
            { id: 'amount', aggregation: 'count' },
          ],
        },
      },
    ] as unknown as typeof previousExpressionFields;

    const { user } = render(<FilterSetupPanel widgetId="widget-1" />);

    await user.click(screen.getByLabelText('Field', { exact: false, selector: 'input' }));

    // The row-level calculated field is still offered — only the measure is excluded.
    expect(await screen.findByRole('option', { name: /Customer Tier$/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /Avg order value$/ })).toBeNull();
  });
});

// ─── Finding 7: the stored filter source id must disambiguate the picker ───────
//
// `config.filterWidgetSourceId` is already read by `handleTypeChange`, but it was not passed
// to the picker — so the picker resolved the stored id by a bare-id lookup across every
// source and could display a same-id field from a DIFFERENT source (wrong label, group and
// field-type icon) as if it were the configured value.
describe('FilterSetupPanel — field-source disambiguation (finding 7)', () => {
  const previousSources = mockState.runtime.dataSources;
  const previousWidget = mockState.doc.widgets['widget-1'];

  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    mockState.runtime.dataSources = {
      // "Aaa" sorts first in `buildFieldCatalog`'s source-label ordering, so a bare-id lookup
      // resolves THIS colliding field.
      aaa: {
        id: 'aaa',
        label: 'Aaa',
        fields: [{ id: 'shared', label: 'Aaa Shared', type: 'string' }],
        rows: [],
      },
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [{ id: 'shared', label: 'Orders Shared', type: 'string' }],
        rows: [],
      },
    } as typeof previousSources;
    mockState.doc.widgets['widget-1'] = {
      ...previousWidget,
      sourceId: 'orders',
      config: {
        filterWidgetType: 'multi-select',
        filterWidgetField: 'shared',
      } as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  afterEach(() => {
    mockState.runtime.dataSources = previousSources;
    mockState.doc.widgets['widget-1'] = previousWidget;
  });

  it("falls back to the widget's own source when no explicit filterWidgetSourceId is stored", () => {
    render(<FilterSetupPanel widgetId="widget-1" />);

    const input = screen.getByLabelText('Field', {
      exact: false,
      selector: 'input',
    }) as HTMLInputElement;
    expect(input.value).toContain('Orders Shared');
    expect(input.value).not.toContain('Aaa Shared');
  });

  it('honours an explicit filterWidgetSourceId pointing at another source', () => {
    mockState.doc.widgets['widget-1'].config = {
      filterWidgetType: 'multi-select',
      filterWidgetField: 'shared',
      filterWidgetSourceId: 'aaa',
    } as StudioWidgetConfig;

    render(<FilterSetupPanel widgetId="widget-1" />);

    const input = screen.getByLabelText('Field', {
      exact: false,
      selector: 'input',
    }) as HTMLInputElement;
    expect(input.value).toContain('Aaa Shared');
    expect(input.value).not.toContain('Orders Shared');
  });
});

// ─── Finding 2: the control-type combobox must have a programmatic name ────────
describe('FilterSetupPanel — combobox accessible name (finding 2)', () => {
  beforeEach(() => {
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'filter',
      sourceId: 'orders',
      config: {
        filterWidgetType: 'multi-select',
        filterWidgetField: 'status',
      } as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('names the control-type select after its visible label', () => {
    render(<FilterSetupPanel widgetId="widget-1" />);

    // Previously the `<Select>` carried no `aria-labelledby`, so its only announced text was
    // its own value ("Multi-select") — `combobox` is not a name-from-content role, so
    // strictly it had no accessible name at all.
    expect(screen.getByRole('combobox', { name: 'Control type' })).toBeVisible();
  });
});
