import { describe, expect, it } from 'vitest';
import { StudioController } from './StudioController';
import type { StudioFilterState } from '../models';

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    value: '',
    scope: 'page',
    ...overrides,
  };
}

describe('StudioController.updateFilter', () => {
  it('does not allow a second rank filter', () => {
    const controller = new StudioController({
      filters: [
        makeFilter({ id: 'rank-filter', filterMode: 'rank', rankDirection: 'top', value: 10 }),
        makeFilter({ id: 'condition-filter', filterMode: 'condition', value: 'foo' }),
      ],
    });

    controller.updateFilter('condition-filter', {
      filterMode: 'rank',
      value: 5,
      rankDirection: 'top',
    });

    const updatedFilters = controller.getState().filters;
    expect(updatedFilters.find((filter) => filter.id === 'condition-filter')).toMatchObject({
      filterMode: 'condition',
      value: 'foo',
    });
  });

  it('allows updates to the existing rank filter', () => {
    const controller = new StudioController({
      filters: [
        makeFilter({ id: 'rank-filter', filterMode: 'rank', rankDirection: 'top', value: 10 }),
        makeFilter({ id: 'condition-filter', filterMode: 'condition', value: 'foo' }),
      ],
    });

    controller.updateFilter('rank-filter', { value: 7 });

    expect(controller.getState().filters.find((filter) => filter.id === 'rank-filter')).toMatchObject({
      filterMode: 'rank',
      value: 7,
      rankDirection: 'top',
    });
  });
});

// ─── StudioController.applyCrossFilter ────────────────────────────────────────

describe('StudioController.applyCrossFilter', () => {
  it('adds a cross-filter with filterSourceId when provided', () => {
    const controller = new StudioController();

    controller.applyCrossFilter('widget-chart-category', 'category', 'Electronics', 'order-items-source');

    const filters = controller.getState().filters;
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({
      scope: 'cross-filter',
      sourceWidgetId: 'widget-chart-category',
      field: 'category',
      operator: 'equals',
      value: 'Electronics',
      filterSourceId: 'order-items-source',
    });
  });

  it('adds a cross-filter without filterSourceId when omitted', () => {
    const controller = new StudioController();

    controller.applyCrossFilter('widget-chart', 'status', 'active');

    const [f] = controller.getState().filters;
    expect(f.filterSourceId).toBeUndefined();
    expect(f).toMatchObject({ field: 'status', value: 'active' });
  });

  it('replaces the existing cross-filter from the same source widget', () => {
    const controller = new StudioController();

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-a', 'category', 'Clothing', 'src-a');

    const filters = controller.getState().filters;
    // Only one cross-filter from widget-a should remain
    expect(filters.filter((f) => f.sourceWidgetId === 'widget-a')).toHaveLength(1);
    expect(filters[0]).toMatchObject({ value: 'Clothing' });
  });

  it('does not remove cross-filters from other source widgets', () => {
    const controller = new StudioController();

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-b', 'region', 'EMEA', 'src-b');

    const filters = controller.getState().filters;
    expect(filters).toHaveLength(2);
    expect(filters.some((f) => f.sourceWidgetId === 'widget-a')).toBe(true);
    expect(filters.some((f) => f.sourceWidgetId === 'widget-b')).toBe(true);
  });

  it('does not remove page-scoped filters when adding a cross-filter', () => {
    const controller = new StudioController({
      filters: [makeFilter({ id: 'date-filter', scope: 'page', field: 'date' })],
    });

    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    const filters = controller.getState().filters;
    expect(filters.some((f) => f.id === 'date-filter')).toBe(true);
    expect(filters.some((f) => f.scope === 'cross-filter')).toBe(true);
  });
});

// ─── StudioController.clearCrossFilter ───────────────────────────────────────

describe('StudioController.clearCrossFilter', () => {
  it('removes the cross-filter from the specified source widget', () => {
    const controller = new StudioController();
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    controller.clearCrossFilter('widget-a');

    expect(controller.getState().filters.filter((f) => f.scope === 'cross-filter')).toHaveLength(0);
  });

  it('leaves cross-filters from other widgets untouched', () => {
    const controller = new StudioController();
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');
    controller.applyCrossFilter('widget-b', 'region', 'EMEA', 'src-b');

    controller.clearCrossFilter('widget-a');

    const remaining = controller.getState().filters;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sourceWidgetId).toBe('widget-b');
  });

  it('leaves page-scoped and widget-scoped filters untouched', () => {
    const controller = new StudioController({
      filters: [
        makeFilter({ id: 'page-filter', scope: 'page' }),
        makeFilter({ id: 'widget-filter', scope: 'widget' }),
      ],
    });
    controller.applyCrossFilter('widget-a', 'category', 'Electronics', 'src-a');

    controller.clearCrossFilter('widget-a');

    const filters = controller.getState().filters;
    expect(filters.map((f) => f.id)).toContain('page-filter');
    expect(filters.map((f) => f.id)).toContain('widget-filter');
  });

  it('is a no-op when no cross-filter exists for the widget', () => {
    const controller = new StudioController({
      filters: [makeFilter({ id: 'page-filter', scope: 'page' })],
    });

    controller.clearCrossFilter('widget-nonexistent');

    expect(controller.getState().filters).toHaveLength(1);
  });
});