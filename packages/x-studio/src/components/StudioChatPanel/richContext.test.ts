import { describe, expect, it } from 'vitest';
import { buildRichContext, MAX_STATS_ROWS } from './richContext';
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
    doc: {
      dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
      widgets: {},
    },
    runtime: {
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

  // Finding L4: the field stats the AI sees must be resolved under the SAME cross-filter
  // regime as the widget summaries `generateInsight` puts in the same prompt. `buildFieldStats`
  // used to build its `StudioPipelineState` without `globalCrossFilterMode` /
  // `crossFilterAllPages`, so the stats resolved cross-filters as if the user had never touched
  // either dashboard toggle — contradicting `SYNTHETIC_WIDGET_ID`'s own "page, date-range,
  // cross-filter and interactive filters — the live view" contract.
  describe('field stats honour the dashboard cross-filter settings', () => {
    function stateWithCrossFilter(dashboardOverrides: Record<string, unknown>) {
      const state = stateWithSales();
      state.doc.dashboard = { ...state.doc.dashboard, ...dashboardOverrides };
      state.doc.widgets = {
        w1: { id: 'w1', kind: 'chart', title: 'Sales', config: {} },
      } as typeof state.doc.widgets;
      state.doc.filters = [
        {
          id: 'xf',
          field: 'region',
          operator: 'equals',
          value: 'US',
          scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
        },
      ] as typeof state.doc.filters;
      return state;
    }

    it('applies an active same-page cross-filter (the live view)', () => {
      const result = buildRichContext(stateWithCrossFilter({}), fakeController());
      // Only the two US rows survive the cross-filter.
      expect(result?.fieldStats?.['src1.amount']).toMatchObject({ min: 200, sampledRows: 2 });
    });

    it("ignores it when the dashboard's globalCrossFilterMode is 'none'", () => {
      const result = buildRichContext(
        stateWithCrossFilter({ globalCrossFilterMode: 'none' }),
        fakeController(),
      );
      // Cross-filtering is switched off dashboard-wide, so all 3 rows are sampled.
      expect(result?.fieldStats?.['src1.amount']).toMatchObject({ min: 100, sampledRows: 3 });
    });

    it('honours crossFilterAllPages for a cross-filter authored on another page', () => {
      const state = stateWithCrossFilter({ crossFilterAllPages: true });
      state.doc.filters[0].scope = {
        kind: 'cross-filter',
        sourceWidgetId: 'w1',
        pageId: 'page-2',
      };
      const result = buildRichContext(state, fakeController());
      expect(result?.fieldStats?.['src1.amount']).toMatchObject({ min: 200, sampledRows: 2 });
    });
  });

  it('omits field stats for sources without local rows', () => {
    const state = createDefaultStudioState({
      runtime: {
        dataSources: {
          remote: {
            id: 'remote',
            label: 'Remote',
            fields: [{ id: 'x', label: 'X', type: 'number' }],
            // no rows
          },
        },
      },
    });
    const result = buildRichContext(state, fakeController());
    expect(result?.fieldStats).toBeUndefined();
  });

  it('builds the page layout with widget kind, chart type, and cross-filter edges', () => {
    const state = createDefaultStudioState({
      doc: {
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
      },
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
      doc: {
        dashboard: { id: 'd1', title: 'D', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] } },
        widgets: {
          w1: { id: 'w1', kind: 'chart', title: 'Sales', config: { chartType: 'bar' } },
        },
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: [{ amount: 100 }, { amount: 200 }],
          },
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

/**
 * `MAX_STATS_ROWS`, the one member of its own named cap family with no test.
 *
 * `pivotUtils.ts` names four caps written for one reason —`MAX_FILLED_TEMPORAL_LABELS`,
 * `MAX_FORECAST_PERIODS`, `ARIA_LABEL_MAX_LINKS`, `MAX_STATS_ROWS` — and the first three are
 * each killed by their own test. Raising this one a thousandfold left all 4822 tests of this
 * package green, and the cap is what keeps the per-request statistics pass O(2000 x fields)
 * instead of O(rows x fields), synchronously on the main thread, once per AI request.
 *
 * Both directions, and the sample is asserted to be a real STRIDE rather than merely a
 * shorter array: the extreme value below sits at an index the stride skips, so a pass that
 * read every row would report a different `max`.
 */
describe('buildRichContext — the row sample per source', () => {
  function stateWithRows(rowCount: number, extremeAt?: number) {
    return createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
        widgets: {},
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: Array.from({ length: rowCount }, (_unused, i) => ({
              amount: i === extremeAt ? 999_999 : 1,
            })),
          },
        },
      },
    });
  }

  it('samples at most MAX_STATS_ROWS rows from a larger source', () => {
    const stat = buildRichContext(stateWithRows(MAX_STATS_ROWS * 5), fakeController())
      ?.fieldStats?.['src1.amount'];
    expect(stat?.sampledRows).toBeLessThanOrEqual(MAX_STATS_ROWS);
    expect(stat?.sampledRows).toBeGreaterThan(0);
  });

  it('reads a STRIDE, so a value at a skipped index is not in the statistics', () => {
    // Stride is `ceil(5 * MAX_STATS_ROWS / MAX_STATS_ROWS) === 5`, so indices 1..4 are never
    // read. Without the cap every row is read and `max` is 999 999.
    const stat = buildRichContext(stateWithRows(MAX_STATS_ROWS * 5, 1), fakeController())
      ?.fieldStats?.['src1.amount'];
    expect(stat?.max).toBe(1);
  });

  it('reads every row of a source at or below the cap (the other direction)', () => {
    // A cap is a boundary, not a ban: nothing about an ordinary dashboard changes, and the
    // extreme value IS reported when it is inside the sample.
    const stat = buildRichContext(stateWithRows(MAX_STATS_ROWS, 1), fakeController())?.fieldStats?.[
      'src1.amount'
    ];
    expect(stat?.sampledRows).toBe(MAX_STATS_ROWS);
    expect(stat?.max).toBe(999_999);
  });
});
