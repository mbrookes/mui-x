import * as React from 'react';
import { createRenderer, screen, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import dayjs from 'dayjs';
import type {
  StudioWidgetConfig,
  StudioWidgetConfigForKind,
  StudioWidgetOf,
  StudioDataSource,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { StudioFilterWidget } from './StudioFilterWidget';

const { render } = createRenderer();

const DATA_SOURCE: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'country', label: 'Country', type: 'string' },
    { id: 'amount', label: 'Amount', type: 'number' },
  ],
  rows: [
    { country: 'US', amount: 10 },
    { country: 'DE', amount: 20 },
  ],
};

function filterWidget(config: Partial<StudioWidgetConfig>): StudioWidgetOf<'filter'> {
  return {
    id: 'w1',
    kind: 'filter',
    title: 'Filter',
    sourceId: 'orders',
    config: config as StudioWidgetConfigForKind<'filter'>,
  };
}

/**
 * Renders the filter widget with a stub control captured via `slots`, so the
 * control's onApply/onClear can be invoked directly — this tests the widget's
 * controller wiring without coupling to each control's UI.
 */
function setup(
  config: Partial<StudioWidgetConfig>,
  slotKey: keyof NonNullable<React.ComponentProps<typeof StudioFilterWidget>['slots']>,
  dataSource: StudioDataSource = DATA_SOURCE,
) {
  const captured: { onApply?: (...args: any[]) => void; onClear?: () => void; values?: unknown } =
    {};
  function Stub(props: {
    onApply?: (...args: any[]) => void;
    onClear?: () => void;
    values?: unknown;
  }) {
    captured.onApply = props.onApply;
    captured.onClear = props.onClear;
    captured.values = props.values;
    return <div data-testid="control" />;
  }
  const { controller, wrapper } = createStudioHarness();
  const applySpy = vi.spyOn(controller, 'applyInteractiveFilter');
  const clearSpy = vi.spyOn(controller, 'clearInteractiveFilter');
  render(
    <StudioFilterWidget
      widget={filterWidget(config)}
      dataSource={dataSource}
      pageId="page-1"
      slots={{ [slotKey]: Stub }}
    />,
    {
      wrapper,
    },
  );
  return { captured, applySpy, clearSpy };
}

describe('StudioFilterWidget', () => {
  it('shows a hint when no field is configured', () => {
    const { wrapper } = createStudioHarness();
    render(
      <StudioFilterWidget
        widget={filterWidget({ filterWidgetType: 'multi-select' })}
        dataSource={DATA_SOURCE}
        pageId="page-1"
      />,
      {
        wrapper,
      },
    );
    expect(screen.getByText(/No field configured/)).not.toBe(null);
  });

  describe('multi-select', () => {
    const config = { filterWidgetType: 'multi-select', filterWidgetField: 'country' } as const;

    it('applies an "in" selection filter', () => {
      const { captured, applySpy } = setup(config, 'multiSelectControl');
      act(() => captured.onApply!(['US', 'DE']));
      expect(applySpy).toHaveBeenCalledWith('w1', 'country', 'in', ['US', 'DE'], {
        filterMode: 'selection',
        fieldType: 'string',
        filterSourceId: 'orders',
      });
    });

    it('clears the filter when the selection becomes empty', () => {
      const { captured, clearSpy } = setup(config, 'multiSelectControl');
      act(() => captured.onApply!([]));
      expect(clearSpy).toHaveBeenCalledWith('w1');
    });

    it('applies a "not_in" filter when the explicit operator is passed', () => {
      const { captured, applySpy } = setup(config, 'multiSelectControl');
      act(() => captured.onApply!(['US'], 'not_in'));
      expect(applySpy).toHaveBeenCalledWith('w1', 'country', 'not_in', ['US'], expect.any(Object));
    });

    it('holds the Exclude toggle intent when nothing is selected, then applies it on selection (finding T3.7)', () => {
      const captured: {
        onApply?: (...args: any[]) => void;
        onExcludeChange?: (next: boolean) => void;
        exclude?: boolean;
      } = {};
      function Stub(props: {
        onApply?: (...args: any[]) => void;
        onExcludeChange?: (next: boolean) => void;
        exclude?: boolean;
      }) {
        captured.onApply = props.onApply;
        captured.onExcludeChange = props.onExcludeChange;
        captured.exclude = props.exclude;
        return <div data-testid="control" />;
      }
      const { controller, wrapper } = createStudioHarness();
      const applySpy = vi.spyOn(controller, 'applyInteractiveFilter');
      render(
        <StudioFilterWidget
          widget={filterWidget(config)}
          dataSource={DATA_SOURCE}
          pageId="page-1"
          slots={{ multiSelectControl: Stub }}
        />,
        { wrapper },
      );

      // Toggling Exclude with an empty selection must NOT silently no-op the intent...
      act(() => captured.onExcludeChange!(true));
      expect(applySpy).not.toHaveBeenCalled();
      // ...the toggle must visibly reflect the pending intent on the next render.
      expect(captured.exclude).toBe(true);

      // Choosing values now applies them with the held `not_in` operator.
      act(() => captured.onApply!(['US']));
      expect(applySpy).toHaveBeenCalledWith('w1', 'country', 'not_in', ['US'], {
        filterMode: 'selection',
        fieldType: 'string',
        filterSourceId: 'orders',
      });
    });

    it('drops the pending Exclude intent when the field changes under it (L16)', () => {
      // Regression for L16: the pending intent is scoped to the field it was expressed on, but
      // changing `config.filterWidgetField` does NOT remount this component. An "Exclude"
      // clicked with nothing selected therefore survived the switch and silently committed the
      // FIRST selection on the NEW field as `not_in`.
      const captured: {
        onApply?: (...args: any[]) => void;
        onExcludeChange?: (next: boolean) => void;
        exclude?: boolean;
      } = {};
      function Stub(props: {
        onApply?: (...args: any[]) => void;
        onExcludeChange?: (next: boolean) => void;
        exclude?: boolean;
      }) {
        captured.onApply = props.onApply;
        captured.onExcludeChange = props.onExcludeChange;
        captured.exclude = props.exclude;
        return <div data-testid="control" />;
      }
      const { controller, wrapper } = createStudioHarness();
      const applySpy = vi.spyOn(controller, 'applyInteractiveFilter');
      const { setProps } = render(
        <StudioFilterWidget
          widget={filterWidget(config)}
          dataSource={DATA_SOURCE}
          pageId="page-1"
          slots={{ multiSelectControl: Stub }}
        />,
        { wrapper },
      );

      // Exclude clicked on `country`, with nothing selected — intent held, nothing applied.
      act(() => captured.onExcludeChange!(true));
      expect(applySpy).not.toHaveBeenCalled();
      expect(captured.exclude).toBe(true);

      // The user re-points the widget at a different field. Same component instance.
      setProps({
        widget: filterWidget({ filterWidgetType: 'multi-select', filterWidgetField: 'amount' }),
      });

      // The stale intent is gone, so the first selection on the NEW field is a plain include.
      expect(captured.exclude).toBe(false);
      act(() => captured.onApply!(['10']));
      expect(applySpy).toHaveBeenCalledWith('w1', 'amount', 'in', ['10'], expect.any(Object));
    });

    // Architecture-review Tier 2 finding 1: `filterWidgetField` is doc/AI-authored with no
    // closed-enum validation, so a hostile value equal to an `Object.prototype` member name
    // used to resolve the inherited function instead of `undefined` from the
    // `fieldDistinctValues` fast-path lookup — `distinctValues` became a `Function` at
    // runtime, which the control would then throw on when calling `.filter`/`.map`. This must
    // never crash, and the `values` handed to the control must always be an array.
    it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
      'does not crash and passes an array of values for filterWidgetField=%s',
      (hostileFieldId) => {
        const { captured } = setup(
          { filterWidgetType: 'multi-select', filterWidgetField: hostileFieldId },
          'multiSelectControl',
        );
        // Rendering succeeded (no throw) and the control was mounted with an ARRAY of
        // values, never the inherited `Object.prototype` function itself.
        expect(captured.onApply).toBeDefined();
        expect(Array.isArray(captured.values)).toBe(true);
      },
    );
  });

  describe('toggle', () => {
    it('applies an "in" selection filter', () => {
      const { captured, applySpy } = setup(
        { filterWidgetType: 'toggle', filterWidgetField: 'country' },
        'toggleControl',
      );
      act(() => captured.onApply!(['US']));
      expect(applySpy).toHaveBeenCalledWith('w1', 'country', 'in', ['US'], {
        filterMode: 'selection',
        fieldType: 'string',
        filterSourceId: 'orders',
      });
    });
  });

  describe('slider', () => {
    it('applies a numeric "between" filter', () => {
      const { captured, applySpy } = setup(
        { filterWidgetType: 'slider', filterWidgetField: 'amount' },
        'sliderControl',
      );
      act(() => captured.onApply!(5, 15));
      expect(applySpy).toHaveBeenCalledWith(
        'w1',
        'amount',
        'between',
        { from: 5, to: 15 },
        { fieldType: 'number', filterSourceId: 'orders' },
      );
    });

    describe('date slider — DST fall-back commit stability (finding 3.14)', () => {
      const originalTz = process.env.TZ;
      const MS_PER_DAY = 86_400_000;

      const DATE_SOURCE: StudioDataSource = {
        id: 'orders',
        label: 'Orders',
        fields: [{ id: 'orderDate', label: 'Order date', type: 'date' }],
        rows: [{ orderDate: '2024-11-01' }, { orderDate: '2024-11-10' }],
      };

      beforeEach(() => {
        // Node re-reads TZ per Date call, so this reproduces a fall-back DST zone regardless of
        // the host machine's timezone. US Eastern falls back on 2024-11-03 (a 25-hour local day).
        process.env.TZ = 'America/New_York';
      });

      afterEach(() => {
        process.env.TZ = originalTz;
      });

      it('commits the intended day when a slider position crosses a fall-back transition', () => {
        const { captured, applySpy } = setup(
          { filterWidgetType: 'slider', filterWidgetField: 'orderDate' },
          'sliderControl',
          DATE_SOURCE,
        );
        // The slider anchors min at local midnight of the earliest row and steps in fixed 24h
        // increments. Selecting Nov 1 → Nov 10 emits `min + 9·MS_PER_DAY`, which past the Nov 3
        // fall-back lands at 23:00 of Nov 9 — one hour short of Nov 10's local midnight.
        const min = dayjs('2024-11-01').startOf('day').valueOf();
        const hi = min + 9 * MS_PER_DAY;
        act(() => captured.onApply!(min, hi));
        expect(applySpy).toHaveBeenCalledWith(
          'w1',
          'orderDate',
          'between',
          // Calendar arithmetic keeps the upper key on Nov 10; a naive `dayjs(hi).format(...)`
          // committed '2024-11-09' — one day early.
          { from: '2024-11-01', to: '2024-11-10' },
          { fieldType: 'date', filterSourceId: 'orders' },
        );
      });
    });
  });

  describe('date-range', () => {
    // The field must be an actual DATE field. Configuring a date-range control over the
    // `country` string column, and asserting with a loose `objectContaining`, hid what the
    // widget really emits: `fieldType` comes from the field's declared type, so a string field
    // produced `fieldType: 'string'` for a `between` date filter and the assertion said nothing.
    const DATE_RANGE_SOURCE: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [{ id: 'orderDate', label: 'Order date', type: 'date' }],
      rows: [{ orderDate: '2024-01-15' }],
    };
    const config = { filterWidgetType: 'date-range', filterWidgetField: 'orderDate' } as const;

    it('applies a "between" filter for a date range', () => {
      const { captured, applySpy } = setup(config, 'dateRangeControl', DATE_RANGE_SOURCE);
      act(() => captured.onApply!({ from: '2024-01-01', to: '2024-03-31' }));
      expect(applySpy).toHaveBeenCalledWith(
        'w1',
        'orderDate',
        'between',
        { from: '2024-01-01', to: '2024-03-31' },
        // Asserted in full: the widget must stamp the field's real type, not fall back.
        { fieldType: 'date', filterSourceId: 'orders' },
      );
    });

    it('clears when an empty range is applied', () => {
      const { captured, clearSpy } = setup(config, 'dateRangeControl', DATE_RANGE_SOURCE);
      act(() => captured.onApply!({}));
      expect(clearSpy).toHaveBeenCalledWith('w1');
    });
  });

  // ── H1: an adapter-backed source has never delivered its rows ──────────────
  //
  // `StudioDataSource.rows` is `undefined` (not `[]`) for a source whose data comes from an
  // adapter until the host imperatively calls `setDataSourceRows`. Every value-driven control read
  // that as "measured, and there is nothing": the dropdown said "No options" forever and the
  // slider's auto-range fell back to a 0–100 the user could nevertheless drag and commit.
  describe('adapter-backed source with undefined rows (H1)', () => {
    const ADAPTER_SOURCE: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: DATA_SOURCE.fields,
      adapter: { getRows: async () => ({ rows: [] }) },
    };

    function renderWidget(config: Partial<StudioWidgetConfig>, dataSource: StudioDataSource) {
      const { wrapper } = createStudioHarness();
      return render(
        <StudioFilterWidget
          widget={filterWidget(config)}
          dataSource={dataSource}
          pageId="page-1"
        />,
        { wrapper },
      );
    }

    it('reports the values as loading instead of rendering an empty multi-select', () => {
      renderWidget(
        { filterWidgetType: 'multi-select', filterWidgetField: 'country' },
        ADAPTER_SOURCE,
      );

      expect(screen.getByText('Loading')).toBeVisible();
      // The empty-option list the control would otherwise render is not shown at all.
      expect(screen.queryByRole('combobox')).toBe(null);
    });

    it('does not render a fabricated 0–100 slider range', () => {
      renderWidget({ filterWidgetType: 'slider', filterWidgetField: 'amount' }, ADAPTER_SOURCE);

      expect(screen.getByText('Loading')).toBeVisible();
      expect(screen.queryByRole('slider')).toBe(null);
    });

    it('still renders the control when the source genuinely delivered zero rows', () => {
      renderWidget(
        { filterWidgetType: 'slider', filterWidgetField: 'amount' },
        {
          ...ADAPTER_SOURCE,
          rows: [],
        },
      );

      // A measured-empty source is a different claim from an unmeasured one: the control renders.
      expect(screen.queryByText('Loading')).toBe(null);
      expect(screen.getAllByRole('slider').length).toBeGreaterThan(0);
    });

    it('leaves the date-range control alone — it derives nothing from rows', () => {
      // Rendered through the stub slot: the real control needs a pickers LocalizationProvider,
      // and what matters here is only that the widget still routes to it rather than to the
      // loading placeholder.
      setup(
        { filterWidgetType: 'date-range', filterWidgetField: 'country' },
        'dateRangeControl',
        ADAPTER_SOURCE,
      );

      expect(screen.getByTestId('control')).toBeVisible();
      expect(screen.queryByText('Loading')).toBe(null);
    });
  });

  it('clears the interactive filter from the control onClear', () => {
    const { captured, clearSpy } = setup(
      { filterWidgetType: 'multi-select', filterWidgetField: 'country' },
      'multiSelectControl',
    );
    act(() => captured.onClear!());
    expect(clearSpy).toHaveBeenCalledWith('w1');
  });
});
