import { describe, expect, it } from 'vitest';
import {
  getAllowedChartConfigKeys,
  getAllowedConfigKeys,
  validateChartConfigKeysForType,
  validateConfigKeysForKind,
} from './configKeyValidation';

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

describe('getAllowedChartConfigKeys', () => {
  it('includes the shared base/sort keys plus the family-specific keys', () => {
    const barKeys = getAllowedChartConfigKeys('bar');
    // Shared base key.
    expect(barKeys.has('crossFilterMode')).toBe(true);
    // Shared sort keys (bar family supports axis sorting).
    expect(barKeys.has('chartSortBy')).toBe(true);
    expect(barKeys.has('chartSortDirection')).toBe(true);
    // Bar's own keys.
    expect(barKeys.has('barLayout')).toBe(true);
    expect(barKeys.has('xField')).toBe(true);
    // Another family's keys are NOT allowed.
    expect(barKeys.has('sankeyTargetField')).toBe(false);
    expect(barKeys.has('gaugeMin')).toBe(false);
  });

  it('maps every bar-family alias to the same allowed set', () => {
    const bar = [...getAllowedChartConfigKeys('bar')].sort();
    expect([...getAllowedChartConfigKeys('bar-stacked')].sort()).toEqual(bar);
    expect([...getAllowedChartConfigKeys('bar-100')].sort()).toEqual(bar);
  });

  it('restricts the gauge family to its own small key set', () => {
    const gaugeKeys = getAllowedChartConfigKeys('gauge');
    expect(gaugeKeys.has('yField')).toBe(true);
    expect(gaugeKeys.has('yAggregation')).toBe(true);
    expect(gaugeKeys.has('gaugeMin')).toBe(true);
    expect(gaugeKeys.has('gaugeMax')).toBe(true);
    // Cartesian / cross-family keys are not part of a gauge.
    expect(gaugeKeys.has('xField')).toBe(false);
    expect(gaugeKeys.has('sankeyTargetField')).toBe(false);
    expect(gaugeKeys.has('chartSortBy')).toBe(false);
  });
});

describe('validateChartConfigKeysForType', () => {
  it('rejects a cross-family key (sankeyTargetField on a gauge)', () => {
    expect(
      validateChartConfigKeysForType('gauge', { chartType: 'gauge', sankeyTargetField: 'to' }),
    ).toEqual(['sankeyTargetField']);
  });

  it('treats an empty config (no chartType) as a valid bar config', () => {
    // The bar family discriminant is optional; `{}` resolves to a bar config, so
    // the empty config carries no invalid keys for the bar chart type.
    expect(validateChartConfigKeysForType('bar', {})).toEqual([]);
  });

  it('accepts each family carrying its own keys', () => {
    expect(
      validateChartConfigKeysForType('line', {
        chartType: 'line',
        xField: 'day',
        forecast: { enabled: true },
      }),
    ).toEqual([]);
    expect(
      validateChartConfigKeysForType('mixed', { chartType: 'mixed', dualYAxis: true }),
    ).toEqual([]);
    expect(
      validateChartConfigKeysForType('heatmap', {
        chartType: 'heatmap',
        heatYField: 'row',
        heatColorScheme: 'primary',
      }),
    ).toEqual([]);
    expect(
      validateChartConfigKeysForType('funnel', {
        chartType: 'funnel',
        funnelVariant: 'filled',
        chartSortBy: 'value',
      }),
    ).toEqual([]);
    expect(
      validateChartConfigKeysForType('gantt', {
        chartType: 'gantt',
        ganttLabelField: 'task',
        ganttStartField: 's',
        ganttEndField: 'e',
      }),
    ).toEqual([]);
    expect(
      validateChartConfigKeysForType('sankey', {
        chartType: 'sankey',
        sankeyTargetField: 'to',
        sankeyShowValues: true,
      }),
    ).toEqual([]);
    expect(
      validateChartConfigKeysForType('pie', { chartType: 'pie', pieArcLabel: 'percent' }),
    ).toEqual([]);
    expect(
      validateChartConfigKeysForType('scatter', {
        chartType: 'scatter',
        scatterColorField: 'cat',
        scatterSizeField: 'n',
      }),
    ).toEqual([]);
  });

  it('rejects forecast on a family that does not support it (bar)', () => {
    // forecast belongs only to the line/area family.
    expect(
      validateChartConfigKeysForType('bar', { chartType: 'bar', forecast: { enabled: true } }),
    ).toEqual(['forecast']);
  });
});
