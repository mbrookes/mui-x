import { describe, expect, it } from 'vitest';

import type { StudioDataField } from '../models';
import { buildMultiYLineSeries } from './lineSeries';

describe('buildMultiYLineSeries', () => {
  it('sets connectNulls to true for each multi-y line series', () => {
    const fields: StudioDataField[] = [
      { id: 'revenue', label: 'Revenue', type: 'number' },
      { id: 'profit', label: 'Profit', type: 'number' },
    ];

    const result = buildMultiYLineSeries(
      {
        labels: ['Jan', 'Feb'],
        series: [
          { fieldId: 'revenue', values: [10, 20] },
          { fieldId: 'profit', values: [5, 8] },
        ],
      },
      'line',
      fields,
    );

    expect(result.map((series) => ({
      label: series.label,
      connectNulls: series.connectNulls,
      yAxisKey: series.yAxisKey,
    }))).toEqual([
      { label: 'Revenue', connectNulls: true, yAxisKey: 'y-0' },
      { label: 'Profit', connectNulls: true, yAxisKey: 'y-1' },
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
    expect(result[0].yAxisKey).toBeUndefined();
    expect(result[0].data).toEqual([75, 50]);
    expect(result[1].data).toEqual([25, 50]);
    expect(result[0].valueFormatter?.(12.345)).toBe('12.3%');
  });
});