import { describe, expect, it } from 'vitest';
import { pruneWidgetColSpan } from './StudioCanvas';

/**
 * Regression coverage for the architecture-review finding: "Cross-page widget move leaks
 * `widgetColSpans`" — `handleDrop`'s cross-page branch removed the moved widget from the
 * source page's `widgetRows` but left its entry in the source page's `widgetColSpans`,
 * which could resurface (a stale span suddenly applied) if the widget was later moved back
 * to that page.
 *
 * `handleDrop` itself is a `useCallback` closure inside `StudioPageRows` wired up to real
 * pragmatic-drag-and-drop targets (native `dragstart`/`dragover`/`drop` sequencing), which
 * isn't reliably simulatable in this jsdom test environment. The fix extracted the shared
 * col-span-removal logic — used at all three cleanup sites in `handleDrop`, including the
 * new source-page cleanup — into `pruneWidgetColSpan`, exported here specifically so this
 * logic (not just the pure UI wiring around it) is directly testable.
 */
describe('pruneWidgetColSpan (cross-page widgetColSpans leak)', () => {
  it('removes the widget entry and preserves the rest', () => {
    const result = pruneWidgetColSpan({ w1: 8, w2: 16 }, 'w1');
    expect(result).toEqual({ w2: 16 });
  });

  it('collapses to undefined when removing the only entry', () => {
    const result = pruneWidgetColSpan({ w1: 8 }, 'w1');
    expect(result).toBeUndefined();
  });

  it('is a no-op (same reference) when the widget has no entry', () => {
    const colSpans = { w2: 16 };
    expect(pruneWidgetColSpan(colSpans, 'w1')).toBe(colSpans);
  });

  it('is a no-op when colSpans is undefined', () => {
    expect(pruneWidgetColSpan(undefined, 'w1')).toBeUndefined();
  });

  it('models the cross-page move scenario: source page widgetColSpans no longer references the moved widget', () => {
    // Widget "w1" starts on page-1 (manually resized to a 8/16 split with "w-sibling"),
    // then the user drags it onto page-2. `handleDrop`'s cross-page branch calls
    // `pruneWidgetColSpan(state.pages[sourcePageId].widgetColSpans, widgetId)` to build the
    // updated source page — this reproduces that exact call.
    const sourcePage = {
      id: 'page-1',
      title: 'Page 1',
      widgetRows: [['w1', 'w-sibling']],
      widgetColSpans: { w1: 8, 'w-sibling': 16 },
    };

    const widgetRowsAfterRemoval = sourcePage.widgetRows
      .map((row) => row.filter((id) => id !== 'w1'))
      .filter((row) => row.length > 0);
    const widgetColSpansAfterRemoval = pruneWidgetColSpan(sourcePage.widgetColSpans, 'w1');

    const updatedSourcePage = {
      ...sourcePage,
      widgetRows: widgetRowsAfterRemoval,
      widgetColSpans: widgetColSpansAfterRemoval,
    };

    expect(updatedSourcePage.widgetRows).toEqual([['w-sibling']]);
    expect(updatedSourcePage.widgetColSpans).toEqual({ 'w-sibling': 16 });
    expect(updatedSourcePage.widgetColSpans).not.toHaveProperty('w1');

    // If "w1" is later moved back to page-1 as a new singleton row, it must not inherit
    // the stale 8-column span from before it ever left.
    expect(updatedSourcePage.widgetColSpans?.w1).toBeUndefined();
  });
});
