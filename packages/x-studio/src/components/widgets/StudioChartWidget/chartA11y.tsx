'use client';
import * as React from 'react';
import { useFocusedItem } from '@mui/x-charts/hooks';
import type { FocusedItemIdentifier } from '@mui/x-charts/models';

/**
 * Shared accessibility helpers for the chart widget families.
 *
 * Two concerns live here:
 *
 * 1. **Text alternatives.** Every `@mui/x-charts` family accepts `title` (the accessible name)
 *    and `desc` (a longer description), which land on the chart's layer container as
 *    `aria-label` / `aria-describedby`. The gantt, sankey and KPI-sparkline renderers already
 *    provided one (they hand-roll a `role="img"` wrapper because they are not driven by the
 *    shared chart container); the remaining families shipped with no accessible name at all, so
 *    a screen reader announced nothing but axis tick text — and split-by series / pie slices
 *    were distinguished by hue alone (WCAG 1.1.1 / 4.1.2).
 *
 * 2. **Keyboard activation.** Cross-filtering was wired exclusively to `onAxisClick` /
 *    `onItemClick`. x-charts ships keyboard navigation that moves a focus ring between data
 *    items, but it never synthesises a click, so Enter / Space did nothing and the primary way
 *    to drive a dashboard was unavailable to keyboard users (WCAG 2.1.1).
 *    {@link CHART_KEYBOARD_NAV_PROPS} turns that navigation on (it is opt-in — x-charts
 *    defaults `disableKeyboardNavigation` to `true`) and
 *    {@link chartKeyboardActivationProps} maps Enter / Space on the focused item to the very
 *    same cross-filter callback the pointer path uses.
 *
 *    Deliberately ONE tab stop per chart: x-charts' navigation renders a single focusable proxy
 *    element and moves between items with the arrow keys. Emitting one tab stop per category
 *    would reproduce the "~175 sequential tab stops on the world map" problem the map shape
 *    plot has.
 */

/**
 * Cap on how many entries a generated `desc` enumerates. An unbounded join over, say, a
 * split-by with thousands of series rebuilds a multi-hundred-KB string on every render and is
 * not a usable announcement either — same reasoning (and same cap) as the gantt/sankey
 * `aria-label` builders.
 */
export const MAX_ARIA_DESCRIPTION_ITEMS = 15;

/**
 * Joins `entries` into a chart `desc` string, capped at {@link MAX_ARIA_DESCRIPTION_ITEMS} with
 * a localized "and N more" tail. Returns `undefined` for an empty list so callers can spread the
 * result without emitting an empty `desc`.
 */
export function buildChartDescription(
  entries: readonly string[],
  andMore: (count: number) => string,
): string | undefined {
  const described = entries.slice(0, MAX_ARIA_DESCRIPTION_ITEMS);
  if (described.length === 0) {
    return undefined;
  }
  const remaining = entries.length - described.length;
  return described.join(', ') + (remaining > 0 ? `, ${andMore(remaining)}` : '');
}

/** Mutable holder for the item x-charts' keyboard navigation currently focuses. */
export type ChartFocusRef = React.MutableRefObject<FocusedItemIdentifier | null>;

/**
 * Enables x-charts' keyboard navigation. Spread onto the chart component itself.
 *
 * Frozen module-level constant so spreading it never changes the prop identity between renders.
 */
export const CHART_KEYBOARD_NAV_PROPS = { disableKeyboardNavigation: false } as const;

/**
 * Allocates the ref {@link ChartFocusTracker} writes into and
 * {@link chartKeyboardActivationProps} reads from.
 *
 * Kept as a hook of its own (rather than folded into a single "useChartKeyboardActivation")
 * because the chart families branch into several mutually-exclusive render paths with different
 * label arrays; only the ref allocation may run unconditionally.
 */
export function useChartFocusRef(): ChartFocusRef {
  return React.useRef<FocusedItemIdentifier | null>(null);
}

/**
 * Mirrors the chart's keyboard-navigation focus into `focusRef`.
 *
 * The focused item only exists inside the chart's own store, so this must render as a CHILD of
 * the chart component; it renders nothing. The write happens in an effect rather than during
 * render — a render-phase ref write is unsafe once React can interrupt and retry a render — and
 * effects always flush before the next keystroke, so the keydown handler never reads a stale
 * item.
 */
export function ChartFocusTracker({ focusRef }: { focusRef: ChartFocusRef }) {
  const focusedItem = useFocusedItem();
  React.useEffect(() => {
    focusRef.current = focusedItem ?? null;
  }, [focusedItem, focusRef]);
  return null;
}

/**
 * Builds the `onKeyDown` handler that turns Enter / Space on the keyboard-focused data item
 * into the widget's cross-filter, so keyboard users can drive cross-filtering exactly like a
 * pointer click does.
 *
 * Spread the result onto the element WRAPPING the chart: the keydown originates on x-charts'
 * focus-proxy element inside the chart and bubbles up.
 *
 * `isBlockedLabel` mirrors the pointer path's own guard (e.g. the synthetic "Other" bucket,
 * which has no single underlying category value and must not emit a cross-filter).
 */
export function chartKeyboardActivationProps<L>(
  focusRef: ChartFocusRef,
  labels: readonly L[],
  onItemClick: (label: L, shiftKey: boolean) => void,
  isBlockedLabel?: (label: L) => boolean,
): { onKeyDown: (event: React.KeyboardEvent) => void } {
  return {
    onKeyDown: (event: React.KeyboardEvent) => {
      // Space is accepted alongside Enter: the focus proxy is a generic element, so neither key
      // has a native activation behaviour to defer to.
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      const item = focusRef.current;
      if (item == null || !('dataIndex' in item) || typeof item.dataIndex !== 'number') {
        return;
      }
      const label = labels[item.dataIndex];
      if (label === undefined || isBlockedLabel?.(label)) {
        return;
      }
      // Only prevent the default once we know the key is handled, so an unhandled Space still
      // scrolls the dashboard as usual.
      event.preventDefault();
      onItemClick(label, event.shiftKey);
    },
  };
}
