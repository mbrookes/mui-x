import { describe, expect, it } from 'vitest';
import { getAllowedConfigKeys, validateConfigKeysForKind } from './configKeyValidation';

describe('getAllowedConfigKeys', () => {
  it('includes the shared config keys plus the kind-specific keys for a built-in kind', () => {
    const gridKeys = getAllowedConfigKeys('grid');
    expect(gridKeys).not.toBeNull();
    // Shared chrome keys are allowed on every built-in kind.
    expect(gridKeys!.has('titleFontSize')).toBe(true);
    expect(gridKeys!.has('customConfig')).toBe(true);
    // Grid's own keys are allowed.
    expect(gridKeys!.has('columns')).toBe(true);
    expect(gridKeys!.has('gridGroupByField')).toBe(true);
    // Another kind's keys are NOT allowed.
    expect(gridKeys!.has('chartType')).toBe(false);
    expect(gridKeys!.has('kpiAggregation')).toBe(false);
  });

  it('returns null (no restriction) for an unknown / custom kind', () => {
    expect(getAllowedConfigKeys('acme-weather')).toBeNull();
  });

  it('treats a prototype-chain name as an unknown custom kind (null), not a built-in', () => {
    expect(getAllowedConfigKeys('constructor')).toBeNull();
    expect(getAllowedConfigKeys('__proto__')).toBeNull();
    expect(getAllowedConfigKeys('hasOwnProperty')).toBeNull();
  });
});

describe('validateConfigKeysForKind', () => {
  it('returns an empty array for a valid per-kind config', () => {
    expect(
      validateConfigKeysForKind('grid', {
        columns: [],
        gridSortDirection: 'asc',
        titleFontSize: 12,
      }),
    ).toEqual([]);
    expect(validateConfigKeysForKind('chart', { chartType: 'bar', xField: 'a' })).toEqual([]);
    expect(validateConfigKeysForKind('kpi', { kpiAggregation: 'sum' })).toEqual([]);
  });

  it('reports a cross-kind stray key', () => {
    // A chart-only key on a grid widget config is invalid.
    expect(validateConfigKeysForKind('grid', { columns: [], chartType: 'bar' })).toEqual([
      'chartType',
    ]);
    // A grid-only key on a chart widget config is invalid.
    expect(validateConfigKeysForKind('chart', { chartType: 'bar', gridHeight: 400 })).toEqual([
      'gridHeight',
    ]);
  });

  it('reports every stray key when several are present', () => {
    expect(
      validateConfigKeysForKind('kpi', {
        kpiAggregation: 'sum',
        chartType: 'bar',
        mapGeography: 'world',
      }),
    ).toEqual(['chartType', 'mapGeography']);
  });

  it('treats a custom / unknown kind as always valid (no allowed-set restriction)', () => {
    expect(validateConfigKeysForKind('acme-weather', { anything: 1, chartType: 'bar' })).toEqual(
      [],
    );
  });

  it('accepts an empty config for any kind', () => {
    expect(validateConfigKeysForKind('map', {})).toEqual([]);
  });
});
