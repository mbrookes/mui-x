import { describe, expect, it } from 'vitest';
import { buildPageLayoutContext } from './buildPageLayoutContext';
import { createDefaultStudioState } from './models/studioTypes';
import type { StudioFilterState, StudioWidget } from './models/studioTypes';

describe('buildPageLayoutContext', () => {
  it('returns undefined when the active page has no widgets or cross-filters', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [] } },
      },
    });
    expect(buildPageLayoutContext(state)).toBeUndefined();
  });

  it('builds widget rows and the cross-filter graph from flat filter state', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
        pages: {
          p1: { id: 'p1', title: 'P1', widgetRows: [['w1']], widgetColSpans: { w1: 6 } },
        },
        widgets: {
          w1: {
            id: 'w1',
            kind: 'chart',
            title: 'Sales',
            config: { chartType: 'bar' },
          } as StudioWidget,
        },
        filters: [
          {
            id: 'xf',
            field: 'region',
            operator: 'equals',
            value: 'US',
            scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'p1' },
          } as StudioFilterState,
        ],
      },
    });
    const layout = buildPageLayoutContext(state);
    expect(layout?.pageId).toBe('p1');
    expect(layout?.rows[0][0]).toMatchObject({
      widgetId: 'w1',
      kind: 'chart',
      title: 'Sales',
      chartType: 'bar',
      colSpan: 6,
    });
    expect(layout?.crossFilters).toEqual([
      { sourceWidgetId: 'w1', field: 'region', scope: 'cross-filter' },
    ]);
  });

  it('returns undefined for a prototype-member activePageId (finding T2-1)', () => {
    // A crafted body `activePageId: "__proto__"` would otherwise make
    // `state.doc.pages[pageId]` resolve `Object.prototype` (truthy) instead of "no
    // active page".
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: '__proto__' },
        pages: {},
      },
    });
    expect(buildPageLayoutContext(state)).toBeUndefined();
  });

  it('drops a widgetRows entry with a prototype-member widgetId (finding T2-1)', () => {
    // A widget row referencing a prototype-member id (`"constructor"`) must not
    // resolve to a truthy inherited value and must be dropped like any other
    // dangling widget id.
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [['constructor']] } },
      },
    });
    expect(buildPageLayoutContext(state)).toBeUndefined();
  });

  it('ignores page-scoped filters in the cross-filter graph', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [['w1']] } },
        widgets: {
          w1: { id: 'w1', kind: 'grid', title: 'Grid', config: {} } as StudioWidget,
        },
        filters: [
          {
            id: 'pf',
            field: 'region',
            operator: 'equals',
            value: 'US',
            scope: { kind: 'page', pageId: 'p1' },
          } as StudioFilterState,
        ],
      },
    });
    expect(buildPageLayoutContext(state)?.crossFilters).toEqual([]);
  });

  // Finding M1: `page.widgetColSpans?.[widgetId]` was an unguarded prototype-chain
  // lookup — the sibling of the `pages`/`widgets` guards already in this file.
  it('does not resolve widgetColSpans through the prototype for a `constructor` widget id', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [['constructor']], widgetColSpans: {} } },
        widgets: {
          // An OWN `constructor` key, so the widget itself resolves legitimately and
          // the span lookup is the only thing left that could walk the prototype.
          constructor: { id: 'constructor', kind: 'grid', title: 'G', config: {} } as StudioWidget,
        },
      },
    });

    const layout = buildPageLayoutContext(state);
    // Previously `colSpan` was the `Object` constructor function itself.
    expect(layout?.rows[0][0]).toMatchObject({ widgetId: 'constructor', kind: 'grid' });
    expect(layout?.rows[0][0].colSpan).toBeUndefined();
  });

  // Finding M3: `filters` is unvalidated client JSON — a scope-less entry threw a
  // raw `TypeError` reading `f.scope.kind`.
  it('skips a filter with no `scope` instead of throwing', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
        pages: { p1: { id: 'p1', title: 'P1', widgetRows: [['w1']] } },
        widgets: {
          w1: { id: 'w1', kind: 'grid', title: 'Grid', config: {} } as StudioWidget,
        },
        filters: [
          { id: 'f1', field: 'region', operator: 'equals', value: 'US' } as StudioFilterState,
        ],
      },
    });
    expect(() => buildPageLayoutContext(state)).not.toThrow();
    expect(buildPageLayoutContext(state)?.crossFilters).toEqual([]);
  });

  // Finding M3: a non-array `widgetRows` (or row) must not reach `.map`/`.flatMap`.
  it('tolerates a malformed widgetRows shape', () => {
    const state = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
        pages: {
          p1: { id: 'p1', title: 'P1', widgetRows: 'abc' as unknown as string[][] },
        },
      },
    });
    expect(() => buildPageLayoutContext(state)).not.toThrow();
  });
});
