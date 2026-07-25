import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `useFocusedItem` reads x-charts' keyboard-navigation store, which only exists inside a
// rendered chart. Mock it so `ChartFocusTracker` can be exercised standalone.
let focusedItem: unknown = null;
vi.mock('@mui/x-charts/hooks', () => ({
  useFocusedItem: () => focusedItem,
}));

// eslint-disable-next-line import/first
import {
  buildChartDescription,
  chartKeyboardActivationProps,
  ChartFocusTracker,
  CHART_KEYBOARD_NAV_PROPS,
  MAX_ARIA_DESCRIPTION_ITEMS,
  type ChartFocusRef,
} from './chartA11y';

const andMore = (count: number) => `and ${count} more`;

function makeKeyEvent(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    preventDefault: vi.fn(),
  } as unknown as React.KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function makeFocusRef(item: unknown): ChartFocusRef {
  return { current: item } as ChartFocusRef;
}

describe('buildChartDescription', () => {
  it('returns undefined for an empty list so no empty desc attribute is emitted', () => {
    expect(buildChartDescription([], andMore)).toBeUndefined();
  });

  it('joins every entry when under the cap', () => {
    expect(buildChartDescription(['A', 'B', 'C'], andMore)).toBe('A, B, C');
  });

  it('caps the enumeration and appends a localized remainder', () => {
    const entries = Array.from({ length: MAX_ARIA_DESCRIPTION_ITEMS + 5 }, (_, i) => `s${i}`);
    const desc = buildChartDescription(entries, andMore)!;
    expect(desc.split(', ')).toHaveLength(MAX_ARIA_DESCRIPTION_ITEMS + 1);
    expect(desc.endsWith('and 5 more')).toBe(true);
    // The description must not grow without bound with the data set.
    expect(desc).not.toContain(`s${MAX_ARIA_DESCRIPTION_ITEMS}`);
  });
});

describe('chartKeyboardActivationProps', () => {
  // M10: cross-filtering used to be wired exclusively to `onAxisClick`/`onItemClick`, so
  // Enter/Space did nothing and the primary way to drive a dashboard was pointer-only.
  it.each(['Enter', ' '])('emits the cross-filter for the focused item on %p', (key) => {
    const onItemClick = vi.fn();
    const { onKeyDown } = chartKeyboardActivationProps(
      makeFocusRef({ type: 'bar', seriesId: 's', dataIndex: 1 }),
      ['A', 'B', 'C'],
      onItemClick,
    );
    const event = makeKeyEvent(key);
    onKeyDown(event);
    expect(onItemClick).toHaveBeenCalledWith('B', false);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('forwards shift for multi-select, mirroring a shift-click', () => {
    const onItemClick = vi.fn();
    const { onKeyDown } = chartKeyboardActivationProps(
      makeFocusRef({ type: 'bar', seriesId: 's', dataIndex: 0 }),
      ['A', 'B'],
      onItemClick,
    );
    onKeyDown(makeKeyEvent('Enter', true));
    expect(onItemClick).toHaveBeenCalledWith('A', true);
  });

  it('ignores keys other than Enter/Space and leaves their default behaviour alone', () => {
    const onItemClick = vi.fn();
    const { onKeyDown } = chartKeyboardActivationProps(
      makeFocusRef({ type: 'bar', seriesId: 's', dataIndex: 0 }),
      ['A'],
      onItemClick,
    );
    const event = makeKeyEvent('ArrowRight');
    onKeyDown(event);
    expect(onItemClick).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('does nothing when no item is focused', () => {
    const onItemClick = vi.fn();
    const { onKeyDown } = chartKeyboardActivationProps(makeFocusRef(null), ['A'], onItemClick);
    const event = makeKeyEvent('Enter');
    onKeyDown(event);
    expect(onItemClick).not.toHaveBeenCalled();
    // Space must still scroll the page when the chart cannot handle it.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('does nothing when the focused index is outside the rendered labels', () => {
    const onItemClick = vi.fn();
    const { onKeyDown } = chartKeyboardActivationProps(
      makeFocusRef({ type: 'bar', seriesId: 's', dataIndex: 9 }),
      ['A', 'B'],
      onItemClick,
    );
    onKeyDown(makeKeyEvent('Enter'));
    expect(onItemClick).not.toHaveBeenCalled();
  });

  // The keyboard path must apply the SAME guard the pointer path does — the synthetic
  // "Other" bucket has no single underlying category value.
  it('honours the blocked-label predicate the pointer path uses', () => {
    const onItemClick = vi.fn();
    const { onKeyDown } = chartKeyboardActivationProps(
      makeFocusRef({ type: 'bar', seriesId: 's', dataIndex: 1 }),
      ['A', 'Other'],
      onItemClick,
      (label) => label === 'Other',
    );
    onKeyDown(makeKeyEvent('Enter'));
    expect(onItemClick).not.toHaveBeenCalled();
  });
});

describe('ChartFocusTracker', () => {
  const { render } = createRenderer();

  beforeEach(() => {
    focusedItem = null;
  });

  it('mirrors the chart focus into the ref after the effect flush', () => {
    focusedItem = { type: 'bar', seriesId: 's', dataIndex: 2 };
    const focusRef = makeFocusRef(null);
    render(<ChartFocusTracker focusRef={focusRef} />);
    expect(focusRef.current).toEqual({ type: 'bar', seriesId: 's', dataIndex: 2 });
  });

  it('normalizes "no focus" to null', () => {
    focusedItem = undefined;
    const focusRef = makeFocusRef({ type: 'bar', seriesId: 's', dataIndex: 0 });
    render(<ChartFocusTracker focusRef={focusRef} />);
    expect(focusRef.current).toBeNull();
  });
});

describe('CHART_KEYBOARD_NAV_PROPS', () => {
  // x-charts defaults `disableKeyboardNavigation` to `true`, so the studio charts had no
  // keyboard navigation at all before this.
  it('opts the chart into x-charts keyboard navigation', () => {
    expect(CHART_KEYBOARD_NAV_PROPS.disableKeyboardNavigation).toBe(false);
  });
});
