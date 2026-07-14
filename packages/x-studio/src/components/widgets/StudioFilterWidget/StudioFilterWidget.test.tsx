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
  const captured: { onApply?: (...args: any[]) => void; onClear?: () => void } = {};
  function Stub(props: { onApply?: (...args: any[]) => void; onClear?: () => void }) {
    captured.onApply = props.onApply;
    captured.onClear = props.onClear;
    return <div data-testid="control" />;
  }
  const { controller, wrapper } = createStudioHarness();
  const applySpy = vi.spyOn(controller, 'applyInteractiveFilter');
  const clearSpy = vi.spyOn(controller, 'clearInteractiveFilter');
  render(
    <StudioFilterWidget
      widget={filterWidget(config)}
      dataSource={dataSource}
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
    const config = { filterWidgetType: 'date-range', filterWidgetField: 'country' } as const;

    it('applies a "between" filter for a date range', () => {
      const { captured, applySpy } = setup(config, 'dateRangeControl');
      act(() => captured.onApply!({ from: '2024-01-01', to: '2024-03-31' }));
      expect(applySpy).toHaveBeenCalledWith(
        'w1',
        'country',
        'between',
        { from: '2024-01-01', to: '2024-03-31' },
        expect.objectContaining({ filterSourceId: 'orders' }),
      );
    });

    it('clears when an empty range is applied', () => {
      const { captured, clearSpy } = setup(config, 'dateRangeControl');
      act(() => captured.onApply!({}));
      expect(clearSpy).toHaveBeenCalledWith('w1');
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
