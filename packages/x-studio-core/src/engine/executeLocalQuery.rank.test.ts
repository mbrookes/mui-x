import { describe, expect, it } from 'vitest';
import { LOCAL_QUERY_CAPABILITIES, WIRE_QUERY_CAPABILITIES } from '../models';
import type { StudioDataSource, StudioFilterState } from '../models';
import { buildLocalQueryDescriptor } from './queryDescriptor';
import { executeLocalQuery } from './executeLocalQuery';
import { leafToFilterState, planQueryExecution } from './queryPlan';

/**
 * Rank filters through the query descriptor (ADR 0005, stage 2).
 *
 * Stage 2 made the descriptor the ONLY road to rows for the in-memory path, which means every
 * filter the local engine can run now survives a `StudioFilterState` → descriptor leaf →
 * `StudioFilterState` round trip. Rank was the one that did not.
 *
 * A rank leaf carried its MODE but not its CONFIGURATION, so the round trip reconstructed a filter
 * with `rankDirection` and `rankByField` missing. `applyFilters` reads `rankDirection ?? 'top'` and
 * branches on the presence of `rankByField`, so nothing threw — "bottom 3 regions by revenue" just
 * quietly executed as "top 3 regions by the region column's own value". These tests are here
 * because that failure mode is invisible: a wrong set of rows, the right number of them.
 */

const ROWS = [
  { region: 'north', revenue: 10 },
  { region: 'north', revenue: 15 },
  { region: 'south', revenue: 100 },
  { region: 'east', revenue: 1 },
  { region: 'west', revenue: 50 },
];

const SOURCE: StudioDataSource = {
  id: 'sales',
  label: 'Sales',
  fields: [
    { id: 'region', label: 'Region', type: 'string' },
    { id: 'revenue', label: 'Revenue', type: 'number' },
  ],
  rows: ROWS,
};

function rankFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'r1',
    scope: { kind: 'page' },
    field: 'region',
    filterMode: 'rank',
    operator: 'equals',
    value: 2,
    rankDirection: 'top',
    rankByField: 'revenue',
    ...overrides,
  } as unknown as StudioFilterState;
}

function run(filters: StudioFilterState[]) {
  return executeLocalQuery(
    buildLocalQueryDescriptor({ sourceId: 'sales', widgetId: 'w1', filters }),
    { rows: ROWS, dataSources: { sales: SOURCE } },
  ).rows;
}

function regionsOf(rows: Record<string, unknown>[]): string[] {
  return [...new Set(rows.map((row) => String(row.region)))].sort();
}

describe('rank filters through the descriptor', () => {
  it('carries the rank measure, so a rank BY a measure is not a rank by the dimension', () => {
    // Ranking regions by summed revenue: south (100) and west (50) win. Losing `rankByField`
    // switches `applyFilters` to its plain-numeric branch over the `region` column, which is the
    // silent-wrong-answer case this whole change exists to close.
    expect(regionsOf(run([rankFilter({ value: 2 })]))).to.deep.equal(['south', 'west']);
  });

  it('carries the direction, so bottom-N is not top-N', () => {
    // east (1) and north (25) are the two smallest by summed revenue. A dropped `rankDirection`
    // defaults to `'top'` and returns the exact complement — the most confidently wrong shape a
    // filter can have.
    expect(regionsOf(run([rankFilter({ value: 2, rankDirection: 'bottom' })]))).to.deep.equal([
      'east',
      'north',
    ]);
  });

  it('preserves every rank field across the round trip', () => {
    // The property the two tests above depend on, asserted directly so a future field added to
    // `StudioFilterState`'s rank block fails here rather than in whichever widget notices first.
    const original = rankFilter({ value: 4, rankDirection: 'bottom', rankMultiSeriesBy: '__avg' });
    const descriptor = buildLocalQueryDescriptor({
      sourceId: 'sales',
      widgetId: 'w1',
      filters: [original],
    });
    const plan = planQueryExecution(descriptor, LOCAL_QUERY_CAPABILITIES);
    const restored = leafToFilterState(plan.acceptedLeaves[0]);

    expect(restored.filterMode).to.equal('rank');
    expect(restored.value).to.equal(4);
    expect(restored.rankDirection).to.equal('bottom');
    expect(restored.rankByField).to.equal('revenue');
    expect(restored.rankMultiSeriesBy).to.equal('__avg');
  });

  it('runs the row predicates before the reduction', () => {
    // The "filter then rank" ordering — a top-2 ranks the regions that survived the other
    // filters, not the whole dataset. Pinned here because routing through the descriptor
    // reorders nothing, and a plan that emitted leaves in a different order could.
    const rows = run([
      {
        id: 'f1',
        scope: { kind: 'page' },
        field: 'revenue',
        operator: 'less_than',
        value: 60,
      } as unknown as StudioFilterState,
      rankFilter({ value: 1 }),
    ]);
    // south (100) is excluded by the predicate, so west (50) wins rather than south.
    expect(regionsOf(rows)).to.deep.equal(['west']);
  });

  it('is accepted by the local executor and declined by the wire', () => {
    // The capability declaration is what routes a rank leaf. The wire has no WHERE-clause form for
    // a result-set reduction, so it must land in the residual and be re-applied over raw rows —
    // which is exactly what the adapter path already did before rank could be expressed at all.
    const descriptor = buildLocalQueryDescriptor({
      sourceId: 'sales',
      widgetId: 'w1',
      filters: [rankFilter()],
    });

    expect(planQueryExecution(descriptor, LOCAL_QUERY_CAPABILITIES).acceptedLeaves).to.have.length(
      1,
    );
    expect(planQueryExecution(descriptor, WIRE_QUERY_CAPABILITIES).residualLeaves).to.have.length(
      1,
    );
  });

  it('sends an unauthored N to the residual rather than accepting it', () => {
    // Same self-healing rule an incomplete condition follows: the residual re-drops it, whereas
    // accepting it would hand the evaluator a reduction it silently ignores — and the local
    // executor would then warn that it declined a leaf it is supposed to be able to run.
    const descriptor = buildLocalQueryDescriptor({
      sourceId: 'sales',
      widgetId: 'w1',
      filters: [rankFilter({ value: 0 })],
    });
    expect(planQueryExecution(descriptor, LOCAL_QUERY_CAPABILITIES).residualLeaves).to.have.length(
      1,
    );
    // And it constrains nothing, so every row survives.
    expect(run([rankFilter({ value: 0 })])).to.have.length(ROWS.length);
  });

  it('does not warn about declining a leaf the user is still authoring', () => {
    // The local executor warns when it declines a leaf, because it is the reference implementation
    // and a genuine decline means the contract describes something nothing implements. An
    // incomplete filter is not that — and now that this function runs for every widget on every
    // render, counting it would put a "contract bug" warning on the console for every keystroke in
    // the filter drawer.
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      run([rankFilter({ value: 0 })]);
      run([
        {
          id: 'f1',
          scope: { kind: 'page' },
          field: 'region',
          operator: 'equals',
          value: '',
        } as unknown as StudioFilterState,
      ]);
    } finally {
      console.warn = original;
    }
    expect(warnings).to.have.length(0);
  });
});
