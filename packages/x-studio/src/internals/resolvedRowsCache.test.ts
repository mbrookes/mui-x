import { describe, it, expect, beforeEach } from 'vitest';
import { resolveRowsCached } from './resolvedRowsCache';
import type { StudioDataSource, StudioFilterState, StudioRelationship, StudioExpressionField } from '../models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'region',
    operator: 'equals',
    value: 'EU',
    scope: 'page',
    ...overrides,
  };
}

function makeDataSources(rows: Record<string, unknown>[]): Record<string, StudioDataSource> {
  return {
    orders: { id: 'orders', label: 'Orders', fields: [], rows },
  };
}

const rows = [
  { id: '1', region: 'EU', amount: 100 },
  { id: '2', region: 'US', amount: 200 },
  { id: '3', region: 'EU', amount: 300 },
];

const relationships: StudioRelationship[] = [];
const expressionFields: StudioExpressionField[] = [];

// ─── Cache correctness ────────────────────────────────────────────────────────

describe('resolveRowsCached', () => {
  // Each test needs a fresh set of array refs so the module-level cache is
  // effectively reset between tests.

  it('returns correct filtered rows', () => {
    const dataSources = makeDataSources(rows);
    const filters = [makeFilter({ id: 'f1', field: 'region', operator: 'equals', value: 'EU' })];
    const result = resolveRowsCached(rows, 'orders', filters, dataSources, relationships, expressionFields, filters);
    expect(result.map((r) => r.id)).toEqual(['1', '3']);
  });

  it('returns the same Row[] reference for two calls with identical (source, filters)', () => {
    const dataSources = makeDataSources(rows);
    const filters = [makeFilter({ id: 'f-shared', value: 'EU' })];

    const result1 = resolveRowsCached(rows, 'orders', filters, dataSources, relationships, expressionFields, filters);
    const result2 = resolveRowsCached(rows, 'orders', filters, dataSources, relationships, expressionFields, filters);

    // Second call must return the same array reference — no recomputation.
    expect(result2).toBe(result1);
  });

  it('returns different Row[] for different filter values', () => {
    const dataSources = makeDataSources(rows);
    const filtersEU = [makeFilter({ id: 'f1', value: 'EU' })];
    const filtersUS = [makeFilter({ id: 'f1', value: 'US' })];
    // Use different globalFilters refs so cache is independently keyed
    const result1 = resolveRowsCached(rows, 'orders', filtersEU, dataSources, relationships, expressionFields, filtersEU);
    const result2 = resolveRowsCached(rows, 'orders', filtersUS, dataSources, relationships, expressionFields, filtersUS);

    expect(result1).not.toBe(result2);
    expect(result1.map((r) => r.id)).toEqual(['1', '3']);
    expect(result2.map((r) => r.id)).toEqual(['2']);
  });

  it('invalidates the cache when globalFilters reference changes', () => {
    const dataSources = makeDataSources(rows);
    const filters1 = [makeFilter({ id: 'f1', value: 'EU' })];
    const result1 = resolveRowsCached(rows, 'orders', filters1, dataSources, relationships, expressionFields, filters1);

    // New filter ref (simulates a store update — filter value changed)
    const filters2 = [makeFilter({ id: 'f1', value: 'EU' })];
    const result2 = resolveRowsCached(rows, 'orders', filters2, dataSources, relationships, expressionFields, filters2);

    // Same content but different reference → cache cleared → new array
    expect(result2).not.toBe(result1);
    expect(result2.map((r) => r.id)).toEqual(['1', '3']); // same logical content
  });

  it('invalidates the cache when dataSources reference changes', () => {
    const filters = [makeFilter({ id: 'f1', value: 'EU' })];
    const ds1 = makeDataSources(rows);
    const result1 = resolveRowsCached(rows, 'orders', filters, ds1, relationships, expressionFields, filters);

    const ds2 = makeDataSources(rows); // new reference
    const result2 = resolveRowsCached(rows, 'orders', filters, ds2, relationships, expressionFields, filters);

    expect(result2).not.toBe(result1);
  });

  it('returns unfiltered rows when resolvedFilters is empty', () => {
    const dataSources = makeDataSources(rows);
    const filters: StudioFilterState[] = [];
    const result = resolveRowsCached(rows, 'orders', filters, dataSources, relationships, expressionFields, filters);
    expect(result).toHaveLength(3);
  });

  it('falls through to resolveRows when widgetSourceId is undefined', () => {
    const dataSources = makeDataSources(rows);
    const filters = [makeFilter({ id: 'f1', value: 'EU' })];
    // Should not throw; returns all rows (no source to match against)
    const result = resolveRowsCached(rows, undefined, filters, dataSources, relationships, expressionFields, filters);
    expect(Array.isArray(result)).toBe(true);
  });

  it('shares cached results across different widgets with same source and no widget filters', () => {
    const dataSources = makeDataSources(rows);
    // Simulate two widgets: both read from 'orders' with the same page filter.
    // Both pass the same globalFilters ref and the same resolvedFilters content.
    const globalFilters = [makeFilter({ id: 'page-filter', scope: 'page', value: 'EU' })];
    // Widget A: page filter only
    const widget1Filters = [...globalFilters];
    // Widget B: page filter only (different array ref, same content)
    const widget2Filters = [...globalFilters];

    const result1 = resolveRowsCached(rows, 'orders', widget1Filters, dataSources, relationships, expressionFields, globalFilters);
    const result2 = resolveRowsCached(rows, 'orders', widget2Filters, dataSources, relationships, expressionFields, globalFilters);

    // Same content → same cache key → same reference.
    expect(result2).toBe(result1);
  });
});
