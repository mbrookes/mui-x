import { describe, expect, it } from 'vitest';
import {
  detectAnomaliesIQR,
  detectAnomaliesZScore,
  detectChartDataAnomalies,
} from './anomalyDetection';

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

// ── detectChartDataAnomalies ──────────────────────────────────────────────────

describe('detectChartDataAnomalies', () => {
  it('detects an anomalous period using aggregated labels and values', () => {
    const labels = [
      '2024-01',
      '2024-02',
      '2024-03',
      '2024-04',
      '2024-05',
      '2024-06',
      '2024-07',
      '2024-08',
    ];
    const values = [10, 11, 10, 12, 10, 11, 10, 200];
    const annotations = detectChartDataAnomalies('w1', labels, values);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].axis).toBe('x');
    expect(annotations[0].value).toBe('2024-08');
    expect(annotations[0].label).toBe('⚠');
    expect(annotations[0].id).toContain('w1');
  });

  it('returns empty array when fewer than 4 non-null values', () => {
    expect(detectChartDataAnomalies('w1', ['a', 'b', 'c'], [10, 200, 5])).toEqual([]);
  });

  it('skips null values when finding clean points', () => {
    const labels = [
      '2024-01',
      '2024-02',
      '2024-03',
      '2024-04',
      '2024-05',
      '2024-06',
      '2024-07',
      '2024-08',
      '2024-09',
    ];
    const values = [10, null, 11, 10, 12, 10, 11, 10, 200];
    const annotations = detectChartDataAnomalies('w1', labels, values);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].value).toBe('2024-09');
  });

  it('returns empty array when no anomalies in tightly clustered data', () => {
    const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
    const values = [50, 51, 49, 50, 52, 48];
    expect(detectChartDataAnomalies('w1', labels, values)).toEqual([]);
  });

  it('deduplicates annotations with the same label', () => {
    // Shouldn't happen with pre-aggregated data, but guard it anyway
    const labels = ['2024-Q1', '2024-Q1', '2024-Q2', '2024-Q3', '2024-Q4'];
    const values = [10, 200, 10, 11, 10];
    const annotations = detectChartDataAnomalies('w1', labels, values);
    const uniqueValues = new Set(annotations.map((a) => a.value));
    expect(annotations.length).toBe(uniqueValues.size);
  });

  it('assigns sequential ids starting from 0', () => {
    const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    // Normal cluster varies so IQR > 0; last two values are clear outliers.
    const values = [10, 11, 12, 11, 10, 12, 11, 10, 200, 300];
    const annotations = detectChartDataAnomalies('widget99', labels, values);
    expect(annotations.length).toBeGreaterThan(0);
    annotations.forEach((ann, i) => {
      expect(ann.id).toBe(`anomaly-widget99-${i}`);
    });
  });

  describe('trimEdges option', () => {
    const labels = [
      '2024-W01',
      '2024-W02',
      '2024-W03',
      '2024-W04',
      '2024-W05',
      '2024-W06',
      '2024-W07',
      '2024-W08',
    ];

    it('flags edge outliers when trimEdges is false (default)', () => {
      // First bucket is low (partial week), last is high — both should be flagged without trimming
      const values = [2, 10, 11, 10, 12, 10, 11, 500];
      const annotations = detectChartDataAnomalies('w1', labels, values);
      expect(annotations.some((a) => a.value === '2024-W01')).toBe(true);
      expect(annotations.some((a) => a.value === '2024-W08')).toBe(true);
    });

    it('suppresses edge outliers when trimEdges is true', () => {
      // First bucket is low (partial week), last is high — edges suppressed
      const values = [2, 10, 11, 10, 12, 10, 11, 500];
      const annotations = detectChartDataAnomalies('w1', labels, values, true);
      expect(annotations.some((a) => a.value === '2024-W01')).toBe(false);
      expect(annotations.some((a) => a.value === '2024-W08')).toBe(false);
    });

    it('still flags interior anomalies when trimEdges is true', () => {
      // Middle bucket is the clear outlier
      const values = [10, 11, 10, 500, 10, 11, 10, 11];
      const annotations = detectChartDataAnomalies('w1', labels, values, true);
      expect(annotations).toHaveLength(1);
      expect(annotations[0].value).toBe('2024-W04');
    });
  });
});
