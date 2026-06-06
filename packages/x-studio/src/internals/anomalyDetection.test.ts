import { describe, expect, it } from 'vitest';
import {
  detectAnomaliesIQR,
  detectAnomaliesZScore,
  detectWidgetAnomalies,
} from './anomalyDetection';
import type { StudioWidget } from '../models';

// ── detectAnomaliesIQR ────────────────────────────────────────────────────────

describe('detectAnomaliesIQR', () => {
  it('detects a clear high outlier', () => {
    const values = [10, 11, 12, 10, 11, 12, 10, 11, 200];
    const result = detectAnomaliesIQR(values);
    expect(result.has(8)).toBe(true);
    expect(result.size).toBe(1);
  });

  it('detects a clear low outlier', () => {
    const values = [100, 102, 98, 101, 99, 100, 1];
    const result = detectAnomaliesIQR(values);
    expect(result.has(6)).toBe(true);
    expect(result.size).toBe(1);
  });

  it('returns empty set when all values are the same (IQR = 0)', () => {
    const values = [5, 5, 5, 5, 5, 5];
    const result = detectAnomaliesIQR(values);
    expect(result.size).toBe(0);
  });

  it('returns empty set for fewer than 4 values', () => {
    expect(detectAnomaliesIQR([1, 2, 3]).size).toBe(0);
    expect(detectAnomaliesIQR([1, 2]).size).toBe(0);
    expect(detectAnomaliesIQR([100]).size).toBe(0);
    expect(detectAnomaliesIQR([]).size).toBe(0);
  });

  it('returns empty set when no outliers exist in a normal spread', () => {
    const values = [50, 52, 48, 51, 49, 50, 53, 47];
    const result = detectAnomaliesIQR(values);
    expect(result.size).toBe(0);
  });

  it('can detect multiple outliers', () => {
    const values = [10, 11, 12, 11, 10, 12, 500, 10, 11, -200];
    const result = detectAnomaliesIQR(values);
    expect(result.has(6)).toBe(true);
    expect(result.has(9)).toBe(true);
    expect(result.size).toBe(2);
  });
});

// ── detectAnomaliesZScore ─────────────────────────────────────────────────────

describe('detectAnomaliesZScore', () => {
  it('detects a value beyond the default 2.5 threshold', () => {
    const values = [10, 11, 10, 12, 10, 11, 10, 100];
    const result = detectAnomaliesZScore(values);
    expect(result.has(7)).toBe(true);
    expect(result.size).toBe(1);
  });

  it('respects a custom lower threshold', () => {
    const values = [10, 11, 10, 12, 10, 11, 10, 20];
    // With default 2.5, 20 may not be flagged; with 1.5 it should be
    const strict = detectAnomaliesZScore(values, 1.0);
    expect(strict.has(7)).toBe(true);
  });

  it('respects a custom higher threshold (fewer flags)', () => {
    const values = [10, 11, 10, 12, 10, 11, 10, 100];
    const lenient = detectAnomaliesZScore(values, 10);
    expect(lenient.size).toBe(0);
  });

  it('returns empty set when all values are the same (std = 0)', () => {
    const values = [7, 7, 7, 7, 7];
    expect(detectAnomaliesZScore(values).size).toBe(0);
  });

  it('returns empty set for fewer than 2 values', () => {
    expect(detectAnomaliesZScore([42]).size).toBe(0);
    expect(detectAnomaliesZScore([]).size).toBe(0);
  });
});

// ── detectWidgetAnomalies ─────────────────────────────────────────────────────

function makeWidget(overrides?: Partial<StudioWidget>): StudioWidget {
  return {
    id: 'w1',
    kind: 'chart',
    title: 'Test Chart',
    sourceId: 'source1',
    config: {
      chartType: 'bar',
      xField: 'category',
      yField: 'value',
    },
    ...overrides,
  } as StudioWidget;
}

describe('detectWidgetAnomalies', () => {
  it('returns empty array for non-chart widget kinds', () => {
    const widget = makeWidget({ kind: 'grid' });
    const rows = [{ category: 'A', value: 10 }];
    expect(detectWidgetAnomalies(widget, rows)).toEqual([]);
  });

  it('returns empty array for chart types without x/y axis (pie)', () => {
    const widget = makeWidget({
      config: { chartType: 'pie', xField: 'category', yField: 'value' },
    });
    const rows = [{ category: 'A', value: 10 }];
    expect(detectWidgetAnomalies(widget, rows)).toEqual([]);
  });

  it('returns empty array when xField is missing', () => {
    const widget = makeWidget({ config: { chartType: 'bar', yField: 'value' } });
    const rows = [{ category: 'A', value: 10 }];
    expect(detectWidgetAnomalies(widget, rows)).toEqual([]);
  });

  it('returns empty array when yField is missing', () => {
    const widget = makeWidget({ config: { chartType: 'bar', xField: 'category' } });
    const rows = [{ category: 'A', value: 10 }];
    expect(detectWidgetAnomalies(widget, rows)).toEqual([]);
  });

  it('returns empty array when fewer than 4 valid rows', () => {
    const widget = makeWidget();
    const rows = [
      { category: 'A', value: 10 },
      { category: 'B', value: 11 },
      { category: 'C', value: 12 },
    ];
    expect(detectWidgetAnomalies(widget, rows)).toEqual([]);
  });

  it('returns empty array when rows are empty', () => {
    const widget = makeWidget();
    expect(detectWidgetAnomalies(widget, [])).toEqual([]);
  });

  it('detects anomaly in bar chart and returns x-axis annotation', () => {
    const widget = makeWidget();
    const rows = [
      { category: 'Jan', value: 10 },
      { category: 'Feb', value: 11 },
      { category: 'Mar', value: 10 },
      { category: 'Apr', value: 12 },
      { category: 'May', value: 10 },
      { category: 'Jun', value: 11 },
      { category: 'Jul', value: 10 },
      { category: 'Aug', value: 200 },
    ];
    const annotations = detectWidgetAnomalies(widget, rows);
    expect(annotations.length).toBeGreaterThan(0);
    const ann = annotations[0];
    expect(ann.axis).toBe('x');
    expect(ann.value).toBe('Aug');
    expect(ann.label).toBe('⚠');
    expect(ann.id).toContain('w1');
  });

  it('uses ySeries fieldId when yField is absent', () => {
    const widget = makeWidget({
      config: {
        chartType: 'bar',
        xField: 'category',
        ySeries: [{ fieldId: 'revenue', seriesType: 'bar' }],
      },
    });
    const rows = [
      { category: 'Jan', revenue: 10 },
      { category: 'Feb', revenue: 11 },
      { category: 'Mar', revenue: 10 },
      { category: 'Apr', revenue: 12 },
      { category: 'May', revenue: 10 },
      { category: 'Jun', revenue: 11 },
      { category: 'Jul', revenue: 10 },
      { category: 'Aug', revenue: 500 },
    ];
    const annotations = detectWidgetAnomalies(widget, rows);
    expect(annotations.length).toBeGreaterThan(0);
    expect(annotations[0].value).toBe('Aug');
  });

  it('returns empty array when no anomalies in tightly clustered data', () => {
    const widget = makeWidget();
    const rows = [
      { category: 'Jan', value: 50 },
      { category: 'Feb', value: 51 },
      { category: 'Mar', value: 49 },
      { category: 'Apr', value: 50 },
      { category: 'May', value: 52 },
      { category: 'Jun', value: 48 },
    ];
    const annotations = detectWidgetAnomalies(widget, rows);
    expect(annotations).toEqual([]);
  });

  it('maps date x-values to grouped period keys when xGroupBy is enabled', () => {
    const widget = makeWidget({
      config: {
        chartType: 'line',
        xField: 'date',
        xGroupBy: 'quarter',
        yField: 'value',
      },
    });

    const rows = [
      { date: '2024-01-15', value: 10 },
      { date: '2024-02-10', value: 11 },
      { date: '2024-03-20', value: 10 },
      { date: '2024-04-10', value: 12 },
      { date: '2024-05-05', value: 10 },
      { date: '2024-06-01', value: 11 },
      { date: '2024-07-11', value: 10 },
      { date: '2024-08-01', value: 220 },
    ];

    const annotations = detectWidgetAnomalies(widget, rows);
    expect(annotations.length).toBeGreaterThan(0);
    expect(annotations[0].value).toBe(new Date('2024-07-01T00:00:00.000Z').getTime());
  });

  it('deduplicates anomaly annotations that fall into the same x bucket', () => {
    const widget = makeWidget({
      config: {
        chartType: 'line',
        xField: 'date',
        xGroupBy: 'quarter',
        yField: 'value',
      },
    });

    const rows = [
      { date: '2024-01-15', value: 10 },
      { date: '2024-01-20', value: 11 },
      { date: '2024-02-01', value: 9 },
      { date: '2024-02-10', value: 10 },
      { date: '2024-02-20', value: 11 },
      { date: '2024-02-25', value: 10 },
      { date: '2024-03-01', value: 12 },
      { date: '2024-03-05', value: 9 },
      { date: '2024-03-10', value: 10 },
      { date: '2024-03-12', value: 11 },
      { date: '2024-03-18', value: 280 },
      { date: '2024-03-26', value: 320 },
    ];

    const annotations = detectWidgetAnomalies(widget, rows);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].value).toBe(new Date('2024-01-01T00:00:00.000Z').getTime());
  });
});
