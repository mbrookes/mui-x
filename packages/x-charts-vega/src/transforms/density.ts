import type { DatasetRow, VegaDensityTransform } from '../types';
import type { GapCollector } from '../gaps';
import { toNumber } from '../compile/fieldTypes';
import { evaluateAggregate, quantile } from './aggregateOps';
import { groupRows } from './groupBy';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * `density` estimates a probability density function via Gaussian kernel
 * density estimation (KDE) over a FIXED, evenly spaced grid of `steps + 1`
 * points spanning `extent` (data extent by default). Bandwidth defaults to
 * Scott's rule (a robust variant using min(stdev, IQR/1.34), matching
 * d3/vega-statistics' `nrd` bandwidth estimator).
 *
 * DEVIATION FROM VEGA-LITE: vega-statistics uses an adaptive grid that
 * refines resolution where the density curves fastest; this implementation
 * always samples an evenly spaced grid of `steps + 1` points. No gap is
 * reported for this — the output is numerically close (same kernel,
 * bandwidth, and endpoint count are honored) and visually indistinguishable
 * for the smooth, well-behaved densities this wrapper renders.
 */

const GAUSSIAN_KERNEL_CONST = 1 / Math.sqrt(2 * Math.PI);

function gaussianPdf(u: number): number {
  return GAUSSIAN_KERNEL_CONST * Math.exp(-0.5 * u * u);
}

/** Abramowitz–Stegun erf approximation (max absolute error ~1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function gaussianCdf(u: number): number {
  return 0.5 * (1 + erf(u / Math.SQRT2));
}

/** Scott/Silverman-style bandwidth: 1.06 · min(stdev, IQR/1.34) · n^(-1/5). */
function computeBandwidth(sortedValues: readonly number[]): number {
  const n = sortedValues.length;
  // Sample standard deviation via the shared aggregate-op evaluator (null for
  // n < 2, which the constant-data guard below folds into the `stdev || 1`
  // fallback).
  const stdev = (evaluateAggregate('stdev', sortedValues as unknown[]) as number | null) ?? 0;
  const q1 = quantile(sortedValues, 0.25) ?? 0;
  const q3 = quantile(sortedValues, 0.75) ?? 0;
  const iqrTerm = (q3 - q1) / 1.34;
  // Constant-data guard: when the IQR term collapses to 0 (e.g. every value
  // equal, or a degenerate quartile spread), fall back to stdev, and to 1
  // when even that is 0, so the kernel never divides by a zero bandwidth.
  const spread = iqrTerm > 0 ? Math.min(stdev, iqrTerm) : stdev || 1;
  return 1.06 * spread * n ** (-1 / 5);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

export function applyDensityTransform(
  rows: readonly DatasetRow[],
  transform: VegaDensityTransform,
  // Accepted for signature parity with the other group-aware transforms;
  // there is nothing to gap here — KDE degrades gracefully (see the
  // constant-data guard above) rather than failing.
  _gaps: GapCollector,
  _path: string,
): readonly DatasetRow[] {
  const groupby = transform.groupby ?? [];
  const groups = groupRows(rows, groupby);
  const [xAs, yAs] = transform.as ?? ['value', 'density'];
  const steps = transform.steps ?? clamp(100, transform.minsteps ?? 25, transform.maxsteps ?? 200);

  const out: DatasetRow[] = [];
  for (const group of groups.values()) {
    const values = group.rows
      .map((row) => toNumber(row[transform.density]))
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b);
    if (values.length === 0) {
      continue;
    }
    const n = values.length;
    const bandwidth =
      transform.bandwidth != null && transform.bandwidth > 0
        ? transform.bandwidth
        : computeBandwidth(values);
    const [lo, hi] = transform.extent ?? [values[0], values[n - 1]];

    for (let i = 0; i <= steps; i += 1) {
      const t = steps === 0 ? 0 : i / steps;
      const x = lo + (hi - lo) * t;
      const pdf = transform.cumulative
        ? values.reduce((sum, xi) => sum + gaussianCdf((x - xi) / bandwidth), 0) / n
        : values.reduce((sum, xi) => sum + gaussianPdf((x - xi) / bandwidth), 0) / (n * bandwidth);
      const value = transform.counts ? pdf * n : pdf;
      out.push({ ...group.key, [xAs]: x, [yAs]: value });
    }
  }
  return out;
}
