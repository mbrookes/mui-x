import { describe, expect, it } from 'vitest';
import {
  linearRegression,
  extendLabels,
  computeWidgetForecast,
  pearsonCorrelation,
  interpretCorrelation,
} from './forecastUtils';

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

  it('extends YYYY-Qn quarter labels, rolling Q4 → Q1 of the next year (finding 2.28)', () => {
    expect(extendLabels(['2024-Q1', '2024-Q2', '2024-Q3'], 2)).toEqual(['2024-Q4', '2025-Q1']);
  });

  it('extends YYYY-Www week labels, rolling week 52 → W01 of the next year (finding 2.28)', () => {
    // 2024 has 52 ISO weeks.
    expect(extendLabels(['2024-W51', '2024-W52'], 2)).toEqual(['2025-W01', '2025-W02']);
  });

  it('respects a 53-week ISO year before rolling over (finding 2.28)', () => {
    // 2020 has 53 ISO weeks, so W52 → W53 (same year) before rolling to 2021-W01.
    expect(extendLabels(['2020-W51', '2020-W52'], 2)).toEqual(['2020-W53', '2021-W01']);
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

  it('aligns the forecast overlay with the labels and keeps the first prediction (finding 1.9)', () => {
    // labels: ['2024-01','2024-02','2024-03','2024-04', +'2024-05','2024-06']
    // values: [10,20,30,40] → y = 10x + 10 → predictions x=4→50, x=5→60
    const result = computeWidgetForecast(historicalLabels, historicalValues, {
      enabled: true,
      periods: 2,
    });
    expect(result!.forecastSeries).toHaveLength(6);
    // Indices 0..2 (earlier actual labels) are null …
    expect(result!.forecastSeries.slice(0, 3)).toEqual([null, null, null]);
    // … the connection point sits at index n-1 (the LAST actual label), carrying the
    // last actual value so the dashed overlay touches the historical series.
    expect(result!.forecastSeries[3]).toBe(40);
    // The first prediction (50) is preserved, not discarded, and lands on '2024-05'.
    expect(result!.forecastSeries[4]).toBe(50);
    expect(result!.forecastSeries[5]).toBe(60);
  });

  it('connects the overlay to the historical series even with connectNulls: false (finding 1.9)', () => {
    const result = computeWidgetForecast(historicalLabels, historicalValues, {
      enabled: true,
      periods: 2,
    });
    // The forecast series renders with connectNulls: false, so the overlay only touches
    // the historical line if both series carry a non-null value at the SAME index (n-1).
    const connectionIndex = historicalValues.length - 1; // 3
    expect(result!.historicalSeries[connectionIndex]).toBe(40);
    expect(result!.forecastSeries[connectionIndex]).toBe(40);
  });

  it('does not produce NaN confidence bands for a 2-point forecast (finding 2.28)', () => {
    // Two points fit a line exactly; the residual std-error divisor (n-2) is 0 → guard
    // must keep the bands finite rather than emitting NaN.
    const result = computeWidgetForecast(['2024-01', '2024-02'], [10, 20], {
      enabled: true,
      periods: 2,
      showConfidenceBands: true,
    });
    expect(result).not.toBeNull();
    for (const band of [result!.upperBand!, result!.lowerBand!]) {
      for (const value of band) {
        expect(Number.isNaN(value as number)).toBe(false);
      }
    }
    // With zero residual error the bands collapse onto the forecast line. Points
    // (0,10),(1,20) fit y = 10x + 10 exactly, so with periods:2 the series is
    // [null, 20 (connection point), 30 (x=2), 40 (x=3)] — index 3 is the SECOND
    // forecast point, not the connection point.
    expect(result!.upperBand![3]).toBe(40);
    expect(result!.forecastSeries[3]).toBe(40);
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
    for (let i = 4; i < 6; i += 1) {
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

describe('pearsonCorrelation', () => {
  it('returns null for fewer than 2 valid pairs', () => {
    expect(pearsonCorrelation([], [])).toBeNull();
    expect(pearsonCorrelation([1], [2])).toBeNull();
    expect(pearsonCorrelation([null, null], [1, 2])).toBeNull();
  });

  it('returns 1.0 for perfectly correlated data', () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    expect(r).toBeCloseTo(1.0, 5);
  });

  it('returns -1.0 for perfectly inversely correlated data', () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
    expect(r).toBeCloseTo(-1.0, 5);
  });

  it('returns ~0 for uncorrelated data', () => {
    const r = pearsonCorrelation([1, 2, 3, 4], [3, 1, 4, 2]);
    expect(r).not.toBeNull();
    expect(Math.abs(r!)).toBeLessThan(0.5);
  });

  it('handles null values by excluding them pairwise', () => {
    // Same as [1,3,5] vs [2,6,10] → perfect correlation
    const r = pearsonCorrelation([1, null, 3, null, 5], [2, 99, 6, 99, 10]);
    expect(r).toBeCloseTo(1.0, 5);
  });
});

describe('interpretCorrelation', () => {
  it('identifies strong positive', () => {
    expect(interpretCorrelation(0.9)).toBe('strong positive');
  });

  it('identifies strong negative', () => {
    expect(interpretCorrelation(-0.85)).toBe('strong negative');
  });

  it('identifies moderate positive', () => {
    expect(interpretCorrelation(0.6)).toBe('moderate positive');
  });

  it('identifies weak negative', () => {
    expect(interpretCorrelation(-0.3)).toBe('weak negative');
  });

  it('identifies negligible', () => {
    expect(interpretCorrelation(0.05)).toBe('negligible');
  });
});
