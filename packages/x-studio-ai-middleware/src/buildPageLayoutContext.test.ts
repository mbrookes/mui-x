import { describe, expect, it } from 'vitest';
import { buildPageLayoutContext } from './buildPageLayoutContext';
import { createDefaultStudioState } from './models/studioTypes';
import type { StudioFilterState, StudioWidget } from './models/studioTypes';

describe('buildPageLayoutContext', () => {
  it('returns undefined when the active page has no widgets or cross-filters', () => {
    const state = createDefaultStudioState({
      dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
      pages: { p1: { id: 'p1', title: 'P1', widgetRows: [] } },
    });
    expect(buildPageLayoutContext(state)).toBeUndefined();
  });

  it('builds widget rows and the cross-filter graph from flat filter state', () => {
    const state = createDefaultStudioState({
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
          scope: 'cross-filter',
          sourceWidgetId: 'w1',
          pageId: 'p1',
        } as StudioFilterState,
      ],
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

  it('ignores page-scoped filters in the cross-filter graph', () => {
    const state = createDefaultStudioState({
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
          scope: 'page',
          pageId: 'p1',
        } as StudioFilterState,
      ],
    });
    expect(buildPageLayoutContext(state)?.crossFilters).toEqual([]);
  });
});
