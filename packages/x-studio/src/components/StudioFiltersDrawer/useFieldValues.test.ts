import { renderHook } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioDataSource, StudioFilterState } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { useFieldValues } from './useFieldValues';

const ORDERS_SOURCE: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'country', label: 'Country', type: 'string' },
    { id: 'segment', label: 'Segment', type: 'string' },
  ],
  rows: [
    { id: 'o1', country: 'US', segment: 'Consumer' },
    { id: 'o2', country: 'US', segment: 'Corporate' },
    { id: 'o3', country: 'DE', segment: 'Consumer' },
    { id: 'o4', country: 'FR', segment: 'Home Office' },
  ],
};

function makeParentFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'parent',
    field: 'country',
    operator: 'equals',
    value: '',
    filterMode: 'selection',
    scope: { kind: 'page' },
    ...overrides,
  } as StudioFilterState;
}

function setup(parentFilters?: StudioFilterState[]) {
  const { wrapper } = createStudioHarness({
    initialState: { runtime: { dataSources: { orders: ORDERS_SOURCE } } },
  });
  return renderHook(() => useFieldValues('segment', 'string', 'orders', parentFilters), {
    wrapper,
  });
}

describe('useFieldValues — cascading option narrowing (finding 2.8)', () => {
  it('narrows to rows matching an `in`/default selection parent', () => {
    const { result } = setup([makeParentFilter({ value: ['US'] })]);
    // Rows o1/o2 (country=US) contribute segments Consumer, Corporate.
    expect(result.current).toEqual(['Consumer', 'Corporate']);
  });

  it('narrows to rows EXCLUDING a `not_in` selection parent, not the excluded set itself', () => {
    const { result } = setup([makeParentFilter({ value: ['US'], operator: 'not_in' })]);
    // Excluding country=US leaves o3 (DE, Consumer) and o4 (FR, Home Office) — the
    // surviving segments — NOT the segments belonging to the excluded US rows.
    expect(result.current).toEqual(['Consumer', 'Home Office']);
  });

  it('without any parent filters, returns every distinct segment', () => {
    const { result } = setup();
    expect(result.current).toEqual(['Consumer', 'Corporate', 'Home Office']);
  });
});
