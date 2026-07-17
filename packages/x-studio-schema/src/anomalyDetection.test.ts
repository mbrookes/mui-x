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

  it('still flags a genuine spike when IQR === 0 (degenerate-spread fallback)', () => {
    // Sorted: eight 3's plus one 50. n = 9, so the lower half is indices 0-3
    // ([3,3,3,3] -> median 3) and the upper half is indices 5-8 ([3,3,3,50] ->
    // median (3+3)/2 = 3). Q1 === Q3 === 3, so IQR === 0 and the standard Tukey
    // fence collapses to a single point — but the constant-value fallback still
    // flags the one value (50, at original index 8) that differs from the
    // constant, rather than reporting zero anomalies for an obvious extreme spike.
    const values = [3, 3, 3, 3, 3, 3, 3, 3, 50];
    const result = detectAnomaliesIQR(values);
    expect(result.has(8)).toBe(true);
    expect(result.size).toBe(1);
  });

  it('flags every value that differs from the constant when IQR === 0 (multiple spikes)', () => {
    const values = [3, 3, 3, 3, 3, 3, 3, -1, 50];
    const result = detectAnomaliesIQR(values);
    expect(result.has(7)).toBe(true);
    expect(result.has(8)).toBe(true);
    expect(result.size).toBe(2);
  });

  // Finding: the IQR === 0 degenerate-spread fallback used a bare `value !== q1`
  // comparison, so pure floating-point jitter (e.g. from an upstream sum/average
  // computation) against an otherwise-constant series was flagged as an anomaly. An
  // epsilon-relative tolerance must absorb that jitter without weakening the
  // deliberate degenerate-spread fallback itself (still verified by the two tests
  // above, whose "spikes" — 50, -1 — are many orders of magnitude past any reasonable
  // epsilon).
  it('does NOT flag floating-point jitter around a near-constant value when IQR === 0', () => {
    const values = [100, 100, 100, 100, 100.0000001];
    const result = detectAnomaliesIQR(values);
    expect(result.size).toBe(0);
  });

  it('still flags a genuine near-baseline outlier when IQR === 0 (epsilon does not over-tolerate)', () => {
    // Same degenerate-spread shape as the eight-3's-plus-50 fixture above (Q1 === Q3 ===
    // 100), but the odd one out (100.001) differs from the baseline by far more than the
    // epsilon tolerance (~1e-7 for a baseline of 100) while still being "near" the
    // baseline in absolute terms — the epsilon must not swallow a real deviation.
    const values = [100, 100, 100, 100, 100, 100, 100, 100, 100.001];
    const result = detectAnomaliesIQR(values);
    expect(result.has(8)).toBe(true);
    expect(result.size).toBe(1);
  });

  it('applies the epsilon tolerance relative to a non-zero constant baseline, not just near zero', () => {
    // Constant baseline is 1e6; jitter of 1e-4 relative to that magnitude must not trip
    // the fallback (an absolute-only epsilon like 1e-9 would incorrectly flag this).
    const values = [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000.0001];
    const result = detectAnomaliesIQR(values);
    expect(result.size).toBe(0);
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

  // T3-4: a single non-finite value must NOT poison `toSorted`'s comparator and silently
  // disable detection for the whole series. Non-finite values are excluded from the quartile
  // math (and never flagged), while the returned Set still indexes into the ORIGINAL array.
  it('ignores a NaN without disabling detection for the whole series (T3-4)', () => {
    // The clear high outlier (200) still sits at original index 8; the NaN at index 4 is
    // dropped from the quartile math and is not itself reported.
    const values = [10, 11, 12, 10, NaN, 12, 10, 11, 200];
    const result = detectAnomaliesIQR(values);
    expect(result.has(8)).toBe(true);
    expect(result.has(4)).toBe(false);
    expect(result.size).toBe(1);
  });

  it('ignores Infinity/-Infinity and keeps original indices (T3-4)', () => {
    // Finite subset is [100,102,98,101,99,100,1] with the low outlier (1) at original index 8.
    const values = [100, Infinity, 102, 98, -Infinity, 101, 99, 100, 1];
    const result = detectAnomaliesIQR(values);
    expect(result.has(8)).toBe(true);
    expect(result.has(1)).toBe(false);
    expect(result.has(4)).toBe(false);
    expect(result.size).toBe(1);
  });

  it('returns no anomalies when fewer than 4 FINITE values remain after filtering (T3-4)', () => {
    // Nine entries, but only three are finite — below the n < 4 guard once NaN is excluded.
    const values = [1, NaN, 2, NaN, 3, NaN, NaN, NaN, NaN];
    expect(detectAnomaliesIQR(values).size).toBe(0);
  });
});
