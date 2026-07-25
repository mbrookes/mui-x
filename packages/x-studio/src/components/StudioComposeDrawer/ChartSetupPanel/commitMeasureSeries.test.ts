import { describe, expect, it } from 'vitest';
import {
  buildMeasureSeriesPatch,
  buildSingleMeasurePatch,
  resolveMeasureSeries,
} from './commitMeasureSeries';

describe('resolveMeasureSeries', () => {
  it('prefers ySeries over the legacy flat yField', () => {
    expect(resolveMeasureSeries({ ySeries: [{ fieldId: 'a' }], yField: 'b' })).toEqual([
      { fieldId: 'a' },
    ]);
  });

  it('seeds a one-entry list from a legacy flat yField', () => {
    expect(resolveMeasureSeries({ yField: 'b' })).toEqual([{ fieldId: 'b' }]);
  });

  it('is empty when neither is set', () => {
    expect(resolveMeasureSeries({})).toEqual([]);
  });
});

describe('buildMeasureSeriesPatch', () => {
  it('mirrors the first own-source field into the flat yField', () => {
    expect(
      buildMeasureSeriesPatch('bar', [{ fieldId: 'total' }, { fieldId: 'revenue' }], 'orders'),
    ).toEqual({ ySeries: [{ fieldId: 'total' }, { fieldId: 'revenue' }], yField: 'total' });
  });

  it('never mirrors a foreign-source blended series id into yField', () => {
    expect(
      buildMeasureSeriesPatch(
        'mixed',
        [{ fieldId: 'lifetimeValue', sourceId: 'customers' }],
        'orders',
      ),
    ).toEqual({ ySeries: [{ fieldId: 'lifetimeValue', sourceId: 'customers' }], yField: '' });
  });

  it('re-locks the aggregation to count when no series carries a field', () => {
    expect(buildMeasureSeriesPatch('bar', [{ fieldId: '' }], 'orders')).toEqual({
      ySeries: [{ fieldId: '' }],
      yField: '',
      yAggregation: 'count',
    });
  });

  it('keeps an existing aggregation untouched while a field remains', () => {
    expect(buildMeasureSeriesPatch('bar', [{ fieldId: 'total' }], 'orders')).not.toHaveProperty(
      'yAggregation',
    );
  });

  // `yAggregation` is not in `SANKEY_CHART_KEYS`/`SCATTER_CHART_KEYS`, so writing the lock for
  // those types would be stripped by the controller's chart-type key guard (with a dev warning).
  it.each(['sankey', 'scatter'] as const)(
    'omits the count lock for %s, whose schema has no yAggregation',
    (chartType) => {
      expect(buildMeasureSeriesPatch(chartType, [], 'orders')).toEqual({
        ySeries: [],
        yField: '',
      });
    },
  );

  it.each(['funnel', 'heatmap'] as const)(
    'applies the count lock for %s, whose schema does declare yAggregation',
    (chartType) => {
      expect(buildMeasureSeriesPatch(chartType, [], 'orders')).toEqual({
        ySeries: [],
        yField: '',
        yAggregation: 'count',
      });
    },
  );
});

describe('buildSingleMeasurePatch', () => {
  it('replaces only slot 0, preserving series retained from another chart family', () => {
    expect(
      buildSingleMeasurePatch(
        'funnel',
        { ySeries: [{ fieldId: 'a' }, { fieldId: 'b' }, { fieldId: 'c' }] },
        'picked',
      ),
    ).toEqual({
      ySeries: [{ fieldId: 'picked' }, { fieldId: 'b' }, { fieldId: 'c' }],
      yField: 'picked',
    });
  });

  it('does not leave the picked field duplicated in the retained tail', () => {
    expect(
      buildSingleMeasurePatch('funnel', { ySeries: [{ fieldId: 'a' }, { fieldId: 'b' }] }, 'b'),
    ).toEqual({ ySeries: [{ fieldId: 'b' }], yField: 'b' });
  });

  it('drops placeholder entries from the retained tail', () => {
    expect(
      buildSingleMeasurePatch('funnel', { ySeries: [{ fieldId: 'a' }, { fieldId: '' }] }, 'picked'),
    ).toEqual({ ySeries: [{ fieldId: 'picked' }], yField: 'picked' });
  });

  it('seeds slot 0 from the legacy flat yField when there is no ySeries', () => {
    expect(buildSingleMeasurePatch('sankey', { yField: 'old' }, 'picked')).toEqual({
      ySeries: [{ fieldId: 'picked' }],
      yField: 'picked',
    });
  });

  // Clearing means "no measure": an empty list, never a `{ fieldId: '' }` placeholder that the
  // multi-series panel would render as an empty series row beside the locked Count select.
  it('treats a cleared pick as an empty series list with the count re-lock', () => {
    expect(buildSingleMeasurePatch('funnel', { ySeries: [{ fieldId: 'a' }] }, '')).toEqual({
      ySeries: [],
      yField: '',
      yAggregation: 'count',
    });
  });
});
