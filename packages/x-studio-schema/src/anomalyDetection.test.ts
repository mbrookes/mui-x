import { describe, expect, it } from 'vitest';
import { detectAnomaliesIQR } from './anomalyDetection';

/**
 * `median` (the quartile helper `detectAnomaliesIQR` uses internally) is
 * file-private in `anomalyDetection.ts` and not part of this package's export
 * surface, so it cannot be unit-tested directly. The datasets below are sized
 * so the Q1/Q3 halves are hand-verifiable, exercising both the even-length
 * (averaged) and odd-length (single middle element) branches of `median`
 * indirectly through `detectAnomaliesIQR`'s fence computation.
 */
describe('detectAnomaliesIQR', () => {
  it('returns no anomalies for fewer than 4 values (the n < 4 guard)', () => {
    expect(detectAnomaliesIQR([]).size).toBe(0);
    expect(detectAnomaliesIQR([1]).size).toBe(0);
    expect(detectAnomaliesIQR([1, 2]).size).toBe(0);
    expect(detectAnomaliesIQR([1, 2, 3]).size).toBe(0);
  });

  it('returns no anomalies when IQR === 0 (identical values)', () => {
    const values = [5, 5, 5, 5, 5, 5];
    expect(detectAnomaliesIQR(values).size).toBe(0);
  });

  it('returns no anomalies when IQR === 0 even though not every value is identical', () => {
    // Sorted: eight 3's plus one 50. n = 9, so the lower half is indices 0-3
    // ([3,3,3,3] -> median 3) and the upper half is indices 5-8 ([3,3,3,50] ->
    // median (3+3)/2 = 3). Q1 === Q3 === 3, so IQR === 0 and the guard fires —
    // distinct from the "every value identical" case above, since here a single
    // outlying value (50) exists but the fence collapse still suppresses it.
    const values = [3, 3, 3, 3, 3, 3, 3, 3, 50];
    expect(detectAnomaliesIQR(values).size).toBe(0);
  });

  it('detects a clear negative (low) outlier', () => {
    const values = [100, 102, 98, 101, 99, 100, 1];
    const result = detectAnomaliesIQR(values);
    expect(result.has(6)).toBe(true);
    expect(result.size).toBe(1);
  });

  it('detects a clear positive (high) outlier', () => {
    const values = [10, 11, 12, 10, 11, 12, 10, 11, 200];
    const result = detectAnomaliesIQR(values);
    expect(result.has(8)).toBe(true);
    expect(result.size).toBe(1);
  });

  it('returns no anomalies for a normal in-range dataset (even-length quartile halves)', () => {
    // Sorted already: [1..8]. Lower half = [1,2,3,4] -> median (2+3)/2 = 2.5.
    // Upper half = [5,6,7,8] -> median (6+7)/2 = 6.5. IQR = 4.
    // Fences: [2.5 - 6, 6.5 + 6] = [-3.5, 12.5] — every value in [1,8] is inside.
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(detectAnomaliesIQR(values).size).toBe(0);
  });

  it('returns no anomalies for a normal in-range dataset (odd-length quartile halves)', () => {
    // Sorted already: [1..11]. Lower half (first 5) = [1,2,3,4,5] -> median 3 (no averaging).
    // Upper half (last 5) = [7,8,9,10,11] -> median 9 (no averaging). IQR = 6.
    // Fences: [3 - 9, 9 + 9] = [-6, 18] — every value in [1,11] is inside.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    expect(detectAnomaliesIQR(values).size).toBe(0);
  });

  it('can detect multiple outliers on both ends', () => {
    const values = [10, 11, 12, 11, 10, 12, 500, 10, 11, -200];
    const result = detectAnomaliesIQR(values);
    expect(result.has(6)).toBe(true);
    expect(result.has(9)).toBe(true);
    expect(result.size).toBe(2);
  });
});
