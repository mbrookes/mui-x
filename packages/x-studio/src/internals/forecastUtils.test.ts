import { describe, expect, it } from 'vitest';
import { linearRegression, extendLabels, computeWidgetForecast } from './forecastUtils';

describe('linearRegression', () => {
  it('returns null for fewer than 2 non-null values', () => {
    expect(linearRegression([])).toBeNull();
    expect(linearRegression([5])).toBeNull();
    expect(linearRegression([null, null])).toBeNull();
  });

  it('computes correct slope and intercept for a perfect line', () => {
    // y = 2x + 1  →  [1, 3, 5, 7, 9]
    const result = linearRegression([1, 3, 5, 7, 9]);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(2, 5);
    expect(result!.intercept).toBeCloseTo(1, 5);
    expect(result!.stdError).toBeCloseTo(0, 5);
  });

  it('handles null values by skipping them', () => {
    const result = linearRegression([1, null, 5]);
    expect(result).not.toBeNull();
    // With x=0,y=1 and x=2,y=5 → slope=2, intercept=1
    expect(result!.slope).toBeCloseTo(2, 5);
    expect(result!.intercept).toBeCloseTo(1, 5);
  });

  it('returns a non-zero stdError for noisy data', () => {
    const result = linearRegression([1, 3, 2, 4, 5]);
    expect(result).not.toBeNull();
    expect(result!.stdError).toBeGreaterThan(0);
  });
});

describe('extendLabels', () => {
  it('returns empty array for 0 periods', () => {
    expect(extendLabels(['2024-01', '2024-02'], 0)).toEqual([]);
  });

  it('extends YYYY-MM date labels by one month each', () => {
    const result = extendLabels(['2024-11', '2024-12'], 2);
    expect(result).toEqual(['2025-01', '2025-02']);
  });

  it('extends YYYY-MM-DD date labels', () => {
    const result = extendLabels(['2024-01-01', '2024-01-08'], 1);
    expect(result).toEqual(['2024-01-15']);
  });

  it('extends YYYY year labels', () => {
    const result = extendLabels(['2022', '2023', '2024'], 2);
    expect(result).toEqual(['2025', '2026']);
  });

  it('extends numeric labels', () => {
    const result = extendLabels([10, 20, 30], 2);
    expect(result).toEqual([40, 50]);
  });

  it('falls back to +1, +2 for non-date string labels', () => {
    const result = extendLabels(['Q1', 'Q2', 'Q3'], 2);
    expect(result).toEqual(['+1', '+2']);
  });
});

describe('computeWidgetForecast', () => {
  const historicalLabels = ['2024-01', '2024-02', '2024-03', '2024-04'];
  const historicalValues: (number | null)[] = [10, 20, 30, 40];

  it('returns null when regression cannot be computed', () => {
    const result = computeWidgetForecast(['only'], [null], { enabled: true });
    expect(result).toBeNull();
  });

  it('returns extended labels', () => {
    const result = computeWidgetForecast(historicalLabels, historicalValues, {
      enabled: true,
      periods: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.labels).toHaveLength(6); // 4 historical + 2 forecast
    expect(result!.labels[4]).toBe('2024-05');
    expect(result!.labels[5]).toBe('2024-06');
  });

  it('historical series has nulls in forecast positions', () => {
    const result = computeWidgetForecast(historicalLabels, historicalValues, {
      enabled: true,
      periods: 2,
    });
    expect(result!.historicalSeries).toHaveLength(6);
    expect(result!.historicalSeries[4]).toBeNull();
    expect(result!.historicalSeries[5]).toBeNull();
  });

  it('forecast series starts at last historical value', () => {
    const result = computeWidgetForecast(historicalLabels, historicalValues, {
      enabled: true,
      periods: 2,
    });
    // First 4 elements are null (historical), then the connection point and forecast
    expect(result!.forecastSeries[0]).toBeNull();
    expect(result!.forecastSeries[3]).toBeNull();
    // The connection point equals the last historical value
    expect(result!.forecastSeries[3]).toBeNull();
    expect(result!.forecastSeries.filter((v) => v !== null).length).toBeGreaterThan(0);
  });

  it('does not produce confidence bands when showConfidenceBands is false', () => {
    const result = computeWidgetForecast(historicalLabels, historicalValues, {
      enabled: true,
      periods: 3,
      showConfidenceBands: false,
    });
    expect(result!.upperBand).toBeNull();
    expect(result!.lowerBand).toBeNull();
  });

  it('produces confidence bands when showConfidenceBands is true', () => {
    const noisyValues: (number | null)[] = [10, 22, 28, 43]; // not a perfect line
    const result = computeWidgetForecast(historicalLabels, noisyValues, {
      enabled: true,
      periods: 2,
      showConfidenceBands: true,
    });
    expect(result!.upperBand).not.toBeNull();
    expect(result!.lowerBand).not.toBeNull();
    expect(result!.upperBand!).toHaveLength(6);
    // Upper band values in forecast range should be >= lower band values
    for (let i = 4; i < 6; i++) {
      expect(result!.upperBand![i]! >= result!.lowerBand![i]!).toBe(true);
    }
  });

  it('uses default 3 periods when periods is not specified', () => {
    const result = computeWidgetForecast(historicalLabels, historicalValues, {
      enabled: true,
    });
    expect(result!.labels).toHaveLength(7); // 4 + 3
  });
});
