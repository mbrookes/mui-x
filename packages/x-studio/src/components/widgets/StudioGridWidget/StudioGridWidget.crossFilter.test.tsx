import * as React from 'react';
import { createRenderer, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioWidget,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { StudioGridWidget } from './StudioGridWidget';

const { render } = createRenderer();

// ─── Cross-filter click toggle — value-equality regression ───────────────────
//
// Finding #5 (architecture review): the grid widget used to toggle cross-filters
// via `String(a) === String(b)`, which disagrees with the chart widget's (former)
// loose `==` on real inputs — e.g. `String(null) !== String(undefined)` even though
// `null == undefined`. Both widget kinds now share `crossFilterValueEquals`
// (`StudioChartWidget/chartWidgetHelpers.ts`). This test exercises the grid's
// actual click handler (not just the shared helper in isolation) against the
// specific value pairs that used to disagree.

function makeSource(): StudioDataSource {
  return {
    id: 'src',
    label: 'Widgets',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'label', label: 'Label', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    rows: [
      { id: 'r1', label: null, amount: 10 },
      { id: 'r2', label: undefined, amount: 20 },
      { id: 'r3', label: 'a', amount: 30 },
      { id: 'r4', label: 'b', amount: 40 },
    ],
  };
}

function makeWidget(): StudioWidget {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'src',
    config: { crossFilterField: 'label' },
  };
}

function setup() {
  const source = makeSource();
  const widget = makeWidget();
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    },
    runtime: { dataSources: { src: source } },
  };
  const { controller, wrapper } = createStudioHarness({ initialState });
  const utils = render(
    <StudioGridWidget
      widget={widget}
      dataSource={source}
      pageId="page-1"
      // jsdom has no real layout engine, so `flex`-based column widths (what
      // StudioGridWidget uses by default) all resolve to 0 and DataGridPremium
      // renders filler cells instead of real ones. Force fixed pixel widths and
      // disable virtualization so the actual field cells are present in the DOM.
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          columns: [
            { field: 'id', width: 100 },
            { field: 'label', width: 100 },
            { field: 'amount', width: 100 },
          ],
        },
      }}
    />,
    { wrapper },
  );
  return { controller, source, widget, ...utils };
}

describe('StudioGridWidget — cross-filter click toggle', () => {
  it('clicking a null-valued cell applies a cross-filter with a null value', () => {
    const { controller, container } = setup();
    const cell = container.querySelector('[data-id="r1"] [data-field="label"]');
    expect(cell).not.toBe(null);
    fireEvent.click(cell!);

    const filters = controller.getState().doc.filters;
    const applied = filters.find((f) => f.scope.kind === 'cross-filter');
    expect(applied?.field).toBe('label');
    expect(applied?.value).toBe(null);
  });

  it('clicking a null cell again clears the filter (null toggles against null)', () => {
    const { controller, container } = setup();
    const cell = container.querySelector('[data-id="r1"] [data-field="label"]');
    fireEvent.click(cell!);
    expect(controller.getState().doc.filters.some((f) => f.scope.kind === 'cross-filter')).toBe(
      true,
    );

    fireEvent.click(cell!);
    expect(controller.getState().doc.filters.some((f) => f.scope.kind === 'cross-filter')).toBe(
      false,
    );
  });

  it('clicking a null-valued cell then an undefined-valued cell toggles the filter off', () => {
    // Regression for the exact case that used to disagree: `String(null)` ('null')
    // !== `String(undefined)` ('undefined'), so the old grid comparison would have
    // treated this as a *new* filter rather than a toggle-off. With
    // `crossFilterValueEquals`, null and undefined normalize to the same value.
    const { controller, container } = setup();
    const nullCell = container.querySelector('[data-id="r1"] [data-field="label"]');
    const undefinedCell = container.querySelector('[data-id="r2"] [data-field="label"]');
    expect(nullCell).not.toBe(null);
    expect(undefinedCell).not.toBe(null);

    fireEvent.click(nullCell!);
    expect(controller.getState().doc.filters.some((f) => f.scope.kind === 'cross-filter')).toBe(
      true,
    );

    fireEvent.click(undefinedCell!);
    expect(controller.getState().doc.filters.some((f) => f.scope.kind === 'cross-filter')).toBe(
      false,
    );
  });
});

// ─── Cross-filter value remap — non-configured column regression (Fix 1.1) ───
//
// `handleCellClick` used to emit `params.value` (the clicked cell's own value)
// even when `crossFilterField` remapped the emitted field to a different column.
// Clicking a cell in any column OTHER than the configured one therefore applied
// a cross-filter keyed on the configured field's name but carrying the WRONG
// value (the clicked cell's value, not the configured field's value on that row).
// The fix reads the configured field's value off `params.row` instead.
describe('StudioGridWidget — cross-filter value remap for non-configured columns', () => {
  it("clicking a cell in a non-configured column emits the configured field's value from the clicked row", () => {
    const { controller, container } = setup();
    const amountCell = container.querySelector('[data-id="r3"] [data-field="amount"]');
    expect(amountCell).not.toBe(null);
    fireEvent.click(amountCell!);

    const filters = controller.getState().doc.filters;
    const applied = filters.find((f) => f.scope.kind === 'cross-filter');
    expect(applied?.field).toBe('label');
    expect(applied?.value).toBe('a');
    // Explicitly assert the regression: the value must NOT be the clicked
    // cell's own (numeric amount) value.
    expect(applied?.value).not.toBe(30);
  });

  it('second click on the same non-configured cell toggles the filter off', () => {
    const { controller, container } = setup();
    const amountCell = container.querySelector('[data-id="r3"] [data-field="amount"]');
    fireEvent.click(amountCell!);
    expect(controller.getState().doc.filters.some((f) => f.scope.kind === 'cross-filter')).toBe(
      true,
    );

    fireEvent.click(amountCell!);
    expect(controller.getState().doc.filters.some((f) => f.scope.kind === 'cross-filter')).toBe(
      false,
    );
  });

  it("clicking a non-configured cell on a different row replaces the filter with that row's configured-field value", () => {
    const { controller, container } = setup();
    const r3AmountCell = container.querySelector('[data-id="r3"] [data-field="amount"]');
    const r4AmountCell = container.querySelector('[data-id="r4"] [data-field="amount"]');
    expect(r3AmountCell).not.toBe(null);
    expect(r4AmountCell).not.toBe(null);

    fireEvent.click(r3AmountCell!);
    let applied = controller.getState().doc.filters.find((f) => f.scope.kind === 'cross-filter');
    expect(applied?.value).toBe('a');

    fireEvent.click(r4AmountCell!);
    applied = controller.getState().doc.filters.find((f) => f.scope.kind === 'cross-filter');
    expect(applied?.field).toBe('label');
    expect(applied?.value).toBe('b');
  });
});
