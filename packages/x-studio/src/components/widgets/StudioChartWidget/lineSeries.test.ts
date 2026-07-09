import { describe, expect, it } from 'vitest';

import type { StudioDataSource, StudioExpressionField } from '../../../models';
import { buildMultiYLineSeries } from './lineSeries';

const dataSource = (fields: StudioDataSource['fields']): StudioDataSource => ({
  id: 'src',
  label: 'Source',
  fields,
  rows: [],
});

describe('buildMultiYLineSeries', () => {
  it('sets connectNulls to true for each multi-y line series', () => {
    const source = dataSource([
      { id: 'revenue', label: 'Revenue', type: 'number' },
      { id: 'profit', label: 'Profit', type: 'number' },
    ]);

    const result = buildMultiYLineSeries(
      {
        labels: ['Jan', 'Feb'],
        series: [
          { fieldId: 'revenue', values: [10, 20] },
          { fieldId: 'profit', values: [5, 8] },
        ],
      },
      'line',
      source,
    );

    // `yAxisId` (not `yAxisKey`) is the real x-charts prop for binding a series to an
    // independent axis (finding 1.1).
    expect(
      result.map((series) => ({
        label: series.label,
        connectNulls: series.connectNulls,
        yAxisId: series.yAxisId,
      })),
    ).toEqual([
      { label: 'Revenue', connectNulls: true, yAxisId: 'y-0' },
      { label: 'Profit', connectNulls: true, yAxisId: 'y-1' },
    ]);
  });

  it('normalizes area-100 data and keeps gaps disconnected', () => {
    const result = buildMultiYLineSeries(
      {
        labels: ['Jan', 'Feb'],
        series: [
          { fieldId: 'revenue', values: [30, 20] },
          { fieldId: 'profit', values: [10, 20] },
        ],
      },
      'area-100',
    );

    expect(result[0].area).toBe(true);
    expect(result[0].stack).toBe('total');
    expect(result[0].connectNulls).toBe(true);
    expect(result[0].yAxisId).toBeUndefined();
    expect(result[0].data).toEqual([75, 50]);
    expect(result[1].data).toEqual([25, 50]);
    expect(result[0].valueFormatter?.(12.345)).toBe('12.3%');
  });

  // Regression for finding #8: `lineSeries.ts` used to hand-roll a private
  // `makeValueFormatter` with the same name as (but different behavior from) the
  // one exported by `chartWidgetHelpers.ts` — this one returned `undefined` when
  // there was no format/precision; the shared one fell back to `String(value)`.
  it('valueFormatter falls back to String(value) when the field has no format/precision configured', () => {
    const source = dataSource([{ id: 'revenue', label: 'Revenue', type: 'number' }]);
    const result = buildMultiYLineSeries(
      { labels: ['Jan'], series: [{ fieldId: 'revenue', values: [10] }] },
      'line',
      source,
    );
    // Regression for finding 2.1: the two multi-Y line/area branches (this one, and the
    // ghost-active branch in StudioLineAreaChart.tsx) must use the SAME makeValueFormatter
    // defaults so the tooltip's number style doesn't change when a ghost toggles on/off.
    // The shared default (no options) always returns a formatter — never `undefined`.
    expect(result[0].valueFormatter).toBeDefined();
    expect(result[0].valueFormatter?.(10)).toBe('10');
  });

  it('valueFormatter uses compact notation by default, matching the ghost-active branch and the y-axis', () => {
    // Regression for finding 2.1: this function used to opt into `{compact: false,
    // noFormatFallback: 'undefined'}`, diverging from the ghost-active branch and the
    // y-axis (both of which use the shared `makeValueFormatter` defaults, i.e. compact).
    // Unifying means a native field's tooltip no longer changes style when a ghost toggles.
    const source = dataSource([
      { id: 'revenue', label: 'Revenue', type: 'number', format: 'integer' },
    ]);
    const result = buildMultiYLineSeries(
      { labels: ['Jan'], series: [{ fieldId: 'revenue', values: [1_500_000] }] },
      'line',
      source,
    );
    expect(result[0].valueFormatter).toBeDefined();
    expect(result[0].valueFormatter?.(1_500_000)).toMatch(/M/);
  });

  // Regression for finding 2.1: `fields?.find(...)` never consulted expression
  // (computed) fields, so a multi-Y line/area chart on a computed y-field showed the
  // raw field id (unformatted) in the normal (non-ghost) state, only resolving to the
  // proper label/format while a cross-filter ghost was active. `resolveFieldDef` checks
  // the data source's native fields first, then `expressionFields`.
  it('resolves an expression (computed) field label and format via resolveFieldDef', () => {
    const source = dataSource([{ id: 'revenue', label: 'Revenue', type: 'number' }]);
    const expressionFields: StudioExpressionField[] = [
      {
        id: 'margin',
        label: 'Margin %',
        sourceId: 'src',
        isMeasure: false,
        type: 'number',
        format: 'percent',
        expression: { id: 'revenue' },
      },
    ];
    const result = buildMultiYLineSeries(
      {
        labels: ['Jan'],
        series: [
          { fieldId: 'revenue', values: [10] },
          { fieldId: 'margin', values: [12.345] },
        ],
      },
      'line',
      source,
      expressionFields,
    );
    const marginSeries = result.find((s) => s.id === 'margin-1')!;
    expect(marginSeries.label).toBe('Margin %');
    expect(marginSeries.valueFormatter?.(12.345)).toBe('12.3%');
  });
});
