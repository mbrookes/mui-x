import { describe, expect, it } from 'vitest';
import {
  getAllowedChartConfigKeys,
  getAllowedConfigKeys,
  stripForeignFamilyKeys,
  validateChartConfigKeysForType,
  validateConfigKeysForKind,
} from './configKeyValidation';
import { STUDIO_CHART_TYPES } from './widgetTypeGuards';
import type { StudioChartType } from './baseTypes';

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

  it('fails closed (empty Set) for a prototype-chain chartType instead of throwing (T2-1)', () => {
    // A crafted/untrusted `chartType` naming an Object.prototype member must resolve
    // to the documented "unknown chart type" fail-closed empty allow-list, exactly
    // like an ordinary unrecognized string (e.g. 'trendline') — never throw.
    expect(() => getAllowedChartConfigKeys('constructor' as StudioChartType)).not.toThrow();
    expect(getAllowedChartConfigKeys('constructor' as StudioChartType)).toEqual(new Set());
    expect(getAllowedChartConfigKeys('toString' as StudioChartType)).toEqual(new Set());
    expect(getAllowedChartConfigKeys('hasOwnProperty' as StudioChartType)).toEqual(new Set());
    // Same fail-closed result as an ordinary unknown chart type string.
    expect(getAllowedChartConfigKeys('trendline' as StudioChartType)).toEqual(new Set());
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

  it('accepts sort/group-by keys on the pie/donut family (schema review 1.1)', () => {
    // Regression: the pie/donut family previously omitted these keys, so the
    // write-side guard silently discarded user Sort/Group-by edits on pie & donut.
    expect(
      validateChartConfigKeysForType('pie', {
        chartType: 'pie',
        chartSortBy: 'value',
        chartSortDirection: 'desc',
        xGroupBy: 'month',
      }),
    ).toEqual([]);
    expect(
      validateChartConfigKeysForType('donut', {
        chartType: 'donut',
        chartSortBy: 'category',
        chartSortDirection: 'asc',
        xGroupBy: 'quarter',
      }),
    ).toEqual([]);
  });

  it('ignores keys whose value is `undefined` (a chart-type switch clears, never corrupts)', () => {
    // Switching chart types sends `{ chartType: 'line', barLayout: undefined }` — the
    // `barLayout: undefined` can only DELETE the stale key on merge, so it must not be
    // flagged as invalid for the line family.
    expect(
      validateChartConfigKeysForType('line', { chartType: 'line', barLayout: undefined }),
    ).toEqual([]);
  });

  it('flags every defined key for a prototype-chain chartType instead of throwing (T2-1)', () => {
    expect(() =>
      validateChartConfigKeysForType('constructor' as StudioChartType, {
        chartType: 'constructor',
        xField: 'a',
      }),
    ).not.toThrow();
    expect(
      validateChartConfigKeysForType('toString' as StudioChartType, {
        chartType: 'toString',
        xField: 'a',
      }),
    ).toEqual(['chartType', 'xField']);
  });
});

describe('validateConfigKeysForKind — undefined-valued keys', () => {
  it('ignores a key set to `undefined` even if it is invalid for the kind', () => {
    // A grid config carrying a chart-only key SET TO UNDEFINED only clears it on
    // merge, so it must not be flagged.
    expect(validateConfigKeysForKind('grid', { columns: [], chartType: undefined })).toEqual([]);
    // ...but a real (defined) wrong-kind value is still flagged.
    expect(validateConfigKeysForKind('grid', { columns: [], chartType: 'bar' })).toEqual([
      'chartType',
    ]);
  });
});

describe('stripForeignFamilyKeys', () => {
  it("strips a gauge config's leftover bar-era xField when given chartType 'gauge'", () => {
    const stored = { chartType: 'gauge', yField: 'revenue', gaugeMax: 200, xField: 'region' };
    expect(stripForeignFamilyKeys(stored, 'gauge')).toEqual({
      chartType: 'gauge',
      yField: 'revenue',
      gaugeMax: 200,
    });
  });

  it('is a value-preserving copy for a config already valid for the chart type', () => {
    const clean = { chartType: 'bar', xField: 'region', yField: 'revenue', chartSortBy: 'value' };
    const result = stripForeignFamilyKeys(clean, 'bar');
    expect(result).toEqual(clean);
    // Returns a copy, never the same reference.
    expect(result).not.toBe(clean);
  });

  it('strips every key (fails closed) for a prototype-chain chartType instead of throwing (T2-1)', () => {
    const stored = { chartType: 'constructor', xField: 'region', yField: 'revenue' };
    expect(() => stripForeignFamilyKeys(stored, 'constructor' as StudioChartType)).not.toThrow();
    expect(stripForeignFamilyKeys(stored, 'constructor' as StudioChartType)).toEqual({});
  });
});

describe('STUDIO_CHART_TYPES completeness (proxy pin for the compile-time lock)', () => {
  it('lists exactly the 16 StudioChartType literals', () => {
    // Runtime proxy for the `AssertAllChartTypesListed` error-tuple lock: if a chart
    // type is added to `StudioChartType` without a `STUDIO_CHART_TYPES` entry, the
    // build fails at the assertion — this pin makes the expected count observable.
    expect(STUDIO_CHART_TYPES.length).toBe(16);
    // No duplicate entries.
    expect(new Set(STUDIO_CHART_TYPES).size).toBe(STUDIO_CHART_TYPES.length);
  });
});
