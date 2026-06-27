import { describe, expect, it } from 'vitest';
import { buildRichContext } from './richContext';
import { createDefaultStudioState } from '../../models/stateTypes';
import type { StudioController } from '../../store/StudioController';
import type { StudioAIRecentMutation } from '../../models';

function fakeController(
  mutations: StudioAIRecentMutation[] = [],
): Pick<StudioController, 'getRecentMutations'> {
  return { getRecentMutations: () => mutations };
}

function stateWithSales() {
  return createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
    pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
    widgets: {},
    dataSources: {
      src1: {
        id: 'src1',
        label: 'Sales',
        fields: [
          { id: 'amount', label: 'Amount', type: 'number' },
          { id: 'region', label: 'Region', type: 'string' },
        ],
        rows: [
          { amount: 100, region: 'EU' },
          { amount: 200, region: 'US' },
          { amount: 300, region: 'US' },
        ],
      },
    },
  });
}

describe('buildRichContext', () => {
  it('returns undefined for an empty default dashboard', () => {
    const state = createDefaultStudioState();
    expect(buildRichContext(state, fakeController())).toBeUndefined();
  });

  it('computes numeric stats and distinct counts from rows', () => {
    const result = buildRichContext(stateWithSales(), fakeController());
    expect(result?.fieldStats?.['src1.amount']).toEqual({
      type: 'number',
      min: 100,
      max: 300,
      mean: 200,
      sampledRows: 3,
    });
    expect(result?.fieldStats?.['src1.region']).toEqual({
      type: 'string',
      distinctCount: 2,
      sampledRows: 3,
    });
  });

  it('omits field stats for sources without local rows', () => {
    const state = createDefaultStudioState({
      dataSources: {
        remote: {
          id: 'remote',
          label: 'Remote',
          fields: [{ id: 'x', label: 'X', type: 'number' }],
          // no rows
        },
      },
    });
    const result = buildRichContext(state, fakeController());
    expect(result?.fieldStats).toBeUndefined();
  });

  it('builds the page layout with widget kind, chart type, and cross-filter edges', () => {
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] },
      },
      widgets: {
        w1: { id: 'w1', kind: 'chart', title: 'Sales', config: { chartType: 'bar' } },
      },
      filters: [
        {
          id: 'xf',
          field: 'region',
          operator: 'equals',
          value: 'US',
          scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
        },
      ],
    });
    const result = buildRichContext(state, fakeController());
    expect(result?.pageLayout?.pageId).toBe('page-1');
    expect(result?.pageLayout?.rows[0][0]).toMatchObject({
      widgetId: 'w1',
      kind: 'chart',
      title: 'Sales',
      chartType: 'bar',
    });
    expect(result?.pageLayout?.crossFilters).toEqual([
      { sourceWidgetId: 'w1', field: 'region', scope: 'cross-filter' },
    ]);
  });

  it('passes through recent mutations', () => {
    const mutations: StudioAIRecentMutation[] = [
      { label: 'addFilter:revenue', at: '2026-01-01T00:00:00.000Z' },
    ];
    const result = buildRichContext(stateWithSales(), fakeController(mutations));
    expect(result?.recentMutations).toEqual(mutations);
  });

  it('drops lower-priority sections and records them in `omitted` under a tiny budget', () => {
    const mutations: StudioAIRecentMutation[] = [
      { label: 'addFilter:revenue', at: '2026-01-01T00:00:00.000Z' },
    ];
    const state = createDefaultStudioState({
      dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] } },
      widgets: {
        w1: { id: 'w1', kind: 'chart', title: 'Sales', config: { chartType: 'bar' } },
      },
      dataSources: {
        src1: {
          id: 'src1',
          label: 'Sales',
          fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
          rows: [{ amount: 100 }, { amount: 200 }],
        },
      },
    });
    // Budget large enough only for field stats, forcing layout + mutations out.
    const result = buildRichContext(state, fakeController(mutations), { budgetTokens: 25 });
    expect(result?.fieldStats?.['src1.amount']).toBeDefined();
    expect(result?.pageLayout).toBeUndefined();
    expect(result?.recentMutations).toBeUndefined();
    expect(result?.omitted).toContain('pageLayout');
    expect(result?.omitted).toContain('recentMutations');
  });
});
