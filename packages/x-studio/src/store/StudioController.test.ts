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