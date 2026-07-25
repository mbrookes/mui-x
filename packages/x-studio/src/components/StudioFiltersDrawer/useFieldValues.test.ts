import { renderHook } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioDataSource, StudioFilterState } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import type { FieldType } from './filterDrawerTypes';
import { useFieldValues } from './useFieldValues';

const ORDERS_SOURCE: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'country', label: 'Country', type: 'string' },
    { id: 'segment', label: 'Segment', type: 'string' },
    { id: 'storeId', label: 'Store ID', type: 'number' },
    { id: 'isActive', label: 'Is active', type: 'boolean' },
  ],
  rows: [
    { id: 'o1', country: 'US', segment: 'Consumer', storeId: 3, isActive: true },
    { id: 'o2', country: 'US', segment: 'Corporate', storeId: 3, isActive: false },
    { id: 'o3', country: 'DE', segment: 'Consumer', storeId: 7, isActive: true },
    { id: 'o4', country: 'FR', segment: 'Home Office', storeId: 7, isActive: true },
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

function setupForField(fieldId: string, fieldType: FieldType | undefined) {
  const { wrapper } = createStudioHarness({
    initialState: { runtime: { dataSources: { orders: ORDERS_SOURCE } } },
  });
  return renderHook(() => useFieldValues(fieldId, fieldType, 'orders'), { wrapper });
}

// Regression for finding 4: values used to be collected only for `string`/`undefined` field
// types, so picking a numeric or boolean field and clicking "Select" rendered a permanently
// empty picker ("No values found") next to an enabled toggle — while a filter WIDGET on the
// very same field listed every distinct value. The engine's `in`/`not_in` compare
// `String(row[field] ?? '')`, so string-keyed values are exactly what selection mode needs
// regardless of the declared type.
describe('useFieldValues — non-string field types (finding 4)', () => {
  it('collects distinct values for a number field', () => {
    const { result } = setupForField('storeId', 'number');
    expect(result.current).toEqual(['3', '7']);
  });

  it('collects distinct values for a boolean field', () => {
    const { result } = setupForField('isActive', 'boolean');
    expect(result.current).toEqual(['false', 'true']);
  });

  it('still collects distinct values for a string field', () => {
    const { result } = setupForField('country', 'string');
    expect(result.current).toEqual(['DE', 'FR', 'US']);
  });
});

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

  // Regression for finding T3.4: a parent filter whose field belongs to a DIFFERENT source (a
  // cross-source "Depends on" pick — reachable via already-persisted or host/AI-authored
  // state even after `PageFilterRow` restricts `dependencyOptions` to same-source parents
  // going forward) used to be applied via a naive `row[f.field]` comparison. Since `region`
  // doesn't exist on `ORDERS_SOURCE`, every row read `undefined`/`''`, which never matched the
  // selected value, silently excluding every row and emptying the child's option list. The
  // fix skips a parent filter whose field isn't present on the scanned source instead.
  it('skips a parent filter whose field does not belong to this data source (T3.4)', () => {
    const { result } = setup([makeParentFilter({ field: 'region', value: ['EMEA'] })]);
    expect(result.current).toEqual(['Consumer', 'Corporate', 'Home Office']);
  });

  // Regression for architecture-review finding: a DISABLED parent filter (toggled off in the
  // drawer, not deleted) still carried a "meaningful" stored value, so it kept narrowing the
  // cascading child's option list as if it were still active. Disabling a filter must make it a
  // no-op everywhere, including as a cascading dependency — the child's options should reflect
  // the full unfiltered set of possible values, matching the "without any parent filters" case.
  it('a disabled parent filter does not narrow the cascading child options (disabled cascade)', () => {
    const { result } = setup([makeParentFilter({ value: ['US'], disabled: true })]);
    expect(result.current).toEqual(['Consumer', 'Corporate', 'Home Office']);
  });
});
