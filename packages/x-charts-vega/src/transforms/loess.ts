import type { DatasetRow, VegaLoessTransform } from '../types';
import type { GapCollector } from '../gaps';
import { toNumber } from '../compile/fieldTypes';
import { quantile } from './aggregateOps';
import { groupRows } from './groupBy';

/*
 * OWNERSHIP: the "transforms" work unit owns this file — full LOESS
 * (locally-weighted linear regression) smoothing, per Cleveland's original
 * algorithm: a tricube-weighted linear fit at each point over its `span`
 * nearest x-neighbors, refined by two robustness iterations that down-weight
 * high-residual points (bisquare weighting).
 */

const ROBUSTNESS_ITERATIONS = 2;

/** Median of `values` via the shared linear-interpolation `quantile` helper (0 for empty). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5) ?? 0;
}

/** Tricube weight function: (1 - |u|^3)^3 for u in [0, 1], clamped outside. */
function tricube(u: number): number {
  const clamped = Math.min(1, Math.max(0, u));
  return (1 - clamped ** 3) ** 3;
}

/**
 * Fits the local weighted-linear regression at a single point `xi`: takes its
 * `span` nearest x-neighbors, weights them by tricube(distance) * the
 * current robustness weight, and evaluates the fit at `xi`. Defined at
 * module scope (rather than inline in the robustness loop below) so it
 * doesn't capture the loop's reassigned `robustWeights`/`fitted` bindings.
 */
function fitPointAt(
  xs: readonly number[],
  ys: readonly number[],
  robustWeights: readonly number[],
  span: number,
  xi: number,
): number {
  const neighborIdx = xs
    .map((xj, j) => ({ j, d: Math.abs(xj - xi) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, span)
    .map((entry) => entry.j);
  // reduce (not Math.max(...spread)) so a large `span` — which scales with the
  // row count — can't overflow the engine's max-arguments limit.
  const dmax = neighborIdx.reduce((max, j) => Math.max(max, Math.abs(xs[j] - xi)), 0) || 1;
  const weights = neighborIdx.map((j) => tricube(Math.abs(xs[j] - xi) / dmax) * robustWeights[j]);
  const neighborXs = neighborIdx.map((j) => xs[j]);
  const neighborYs = neighborIdx.map((j) => ys[j]);
  return weightedLinearFit(neighborXs, neighborYs, weights)(xi);
}

/**
 * Refits every point for one robustness round. Module-level (not inline in
 * the robustness loop) so the `.map()` callback never closes over the loop's
 * reassigned `fitted`/`robustWeights` bindings (`no-loop-func`) — both are
 * passed in by value instead.
 */
function computeFittedRound(
  xs: readonly number[],
  ys: readonly number[],
  robustWeights: readonly number[],
  span: number,
): number[] {
  return xs.map((xi) => fitPointAt(xs, ys, robustWeights, span, xi));
}

/** Weighted linear least squares restricted to a neighborhood, evaluated at `xq`. */
function weightedLinearFit(
  xs: readonly number[],
  ys: readonly number[],
  weights: readonly number[],
): (xq: number) => number {
  let sw = 0;
  let swx = 0;
  let swy = 0;
  let swxx = 0;
  let swxy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const w = weights[i];
    sw += w;
    swx += w * xs[i];
    swy += w * ys[i];
    swxx += w * xs[i] * xs[i];
    swxy += w * xs[i] * ys[i];
  }
  const denom = sw * swxx - swx * swx;
  if (sw === 0) {
    // Every neighbor was weighted to 0 (degenerate robustness weighting):
    // fall back to the plain mean of the neighborhood.
    const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
    return () => meanY;
  }
  if (Math.abs(denom) < 1e-12) {
    // All neighbor x values coincide: fall back to the weighted mean (no
    // slope is identifiable).
    const weightedMeanY = swy / sw;
    return () => weightedMeanY;
  }
  const b = (sw * swxy - swx * swy) / denom;
  const a = (swy - b * swx) / sw;
  return (xq) => a + b * xq;
}

export function applyLoessTransform(
  rows: readonly DatasetRow[],
  transform: VegaLoessTransform,
  // Accepted for signature parity with the other group-aware transforms; n<3
  // passthrough is not a gap (see the file header / plan), and every other
  // path here always produces a numeric fit.
  _gaps: GapCollector,
  _path: string,
): readonly DatasetRow[] {
  const groupby = transform.groupby ?? [];
  const groups = groupRows(rows, groupby);
  const [xAs, yAs] = transform.as ?? [transform.on, transform.loess];

  const out: DatasetRow[] = [];
  for (const group of groups.values()) {
    const pairs = group.rows
      .map((row) => ({ x: toNumber(row[transform.on]), y: toNumber(row[transform.loess]) }))
      .filter((pair): pair is { x: number; y: number } => pair.x != null && pair.y != null)
      .sort((a, b) => a.x - b.x);

    if (pairs.length < 3) {
      for (const pair of pairs) {
        out.push({ ...group.key, [xAs]: pair.x, [yAs]: pair.y });
      }
      continue;
    }

    const xs = pairs.map((pair) => pair.x);
    const ys = pairs.map((pair) => pair.y);
    const n = xs.length;
    const span = Math.max(2, Math.ceil((transform.bandwidth ?? 0.3) * n));

    let robustWeights = new Array<number>(n).fill(1);
    let fitted = new Array<number>(n).fill(0);

    for (let iteration = 0; iteration <= ROBUSTNESS_ITERATIONS; iteration += 1) {
      fitted = computeFittedRound(xs, ys, robustWeights, span);

      if (iteration === ROBUSTNESS_ITERATIONS) {
        break;
      }
      const currentFitted = fitted;
      const residuals = ys.map((y, i) => Math.abs(y - currentFitted[i]));
      const s = 6 * median(residuals);
      if (s < 1e-9) {
        // Residuals are ~0 (near-perfect fit already): further bisquare
        // re-weighting would divide by ~0, so keep the current fit as final.
        break;
      }
      robustWeights = residuals.map((r) => (r >= s ? 0 : (1 - (r / s) ** 2) ** 2));
    }

    pairs.forEach((pair, i) => {
      out.push({ ...group.key, [xAs]: pair.x, [yAs]: fitted[i] });
    });
  }
  return out;
}
