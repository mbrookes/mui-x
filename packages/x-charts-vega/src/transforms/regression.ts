import type { DatasetRow, VegaRegressionTransform } from '../types';
import type { GapCollector } from '../gaps';
import { toNumber } from '../compile/fieldTypes';
import { groupRows } from './groupBy';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * `regression` fits a curve to (on, regression) pairs per group and emits
 * either a sampled curve (default) or one summary row per group
 * (`params: true`). All fits are closed-form ordinary-least-squares (OLS):
 *
 *   - linear: y = a + b·x, direct OLS.
 *   - log:    y = a + b·ln(x), OLS on (ln x, y).
 *   - exp:    y = a·e^(b·x), OLS on (x, ln y) — a LOG-LINEARIZED fit. This is
 *             a documented deviation from vega-statistics, which fits `exp`
 *             via nonlinear least squares directly on (x, y); log-linearizing
 *             minimizes error in ln-space rather than y-space, which biases
 *             the fit slightly for noisy data (though it is exact for
 *             noiseless exponential data, which is what the test suite
 *             checks). Closed-form log-linearization avoids pulling in an
 *             iterative nonlinear solver for a single regression method.
 *   - pow:    y = a·x^b, OLS on (ln x, ln y) — same log-linearization
 *             deviation as `exp`.
 *   - quad:   polynomial fit, degree 2 (`poly` with `order` fixed to 2).
 *   - poly:   polynomial fit, degree `min(order ?? 3, pairs - 1)` via the
 *             normal-equations/Vandermonde approach below.
 *
 * `method`s outside this set report a 'partial' gap (`transform:
 * regression-method`) and fall back to `linear`.
 */

type RegressionMethod = 'linear' | 'log' | 'exp' | 'pow' | 'quad' | 'poly';
const SUPPORTED_METHODS: readonly RegressionMethod[] = [
  'linear',
  'log',
  'exp',
  'pow',
  'quad',
  'poly',
];

interface Fit {
  /** Fitted coefficients in the method's natural parameterization (see file header). */
  coef: number[];
  predict: (x: number) => number;
}

function linearOLS(xs: readonly number[], ys: readonly number[]): { a: number; b: number } {
  const n = xs.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (xs[i] - meanX) * (ys[i] - meanY);
    denominator += (xs[i] - meanX) ** 2;
  }
  const b = denominator === 0 ? 0 : numerator / denominator;
  const a = meanY - b * meanX;
  return { a, b };
}

/** Solves `Ax = B` (n×n) via Gaussian elimination with partial pivoting. Singular rows resolve to 0. */
function gaussianSolve(matrixA: readonly number[][], vectorB: readonly number[]): number[] {
  const n = matrixA.length;
  const augmented = matrixA.map((row, i) => [...row, vectorB[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let maxAbs = Math.abs(augmented[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(augmented[r][col]) > maxAbs) {
        maxAbs = Math.abs(augmented[r][col]);
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-12) {
      continue;
    }
    if (pivotRow !== col) {
      [augmented[col], augmented[pivotRow]] = [augmented[pivotRow], augmented[col]];
    }
    for (let r = col + 1; r < n; r += 1) {
      const factor = augmented[r][col] / augmented[col][col];
      for (let c = col; c <= n; c += 1) {
        augmented[r][c] -= factor * augmented[col][c];
      }
    }
  }
  const solution = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    if (Math.abs(augmented[r][r]) < 1e-12) {
      continue;
    }
    let sum = augmented[r][n];
    for (let c = r + 1; c < n; c += 1) {
      sum -= augmented[r][c] * solution[c];
    }
    solution[r] = sum / augmented[r][r];
  }
  return solution;
}

/** Polynomial OLS via the normal equations (X^T X c = X^T y) over a Vandermonde basis. */
function polyFit(xs: readonly number[], ys: readonly number[], order: number): number[] {
  const k = order + 1;
  const n = xs.length;
  const powSums = new Array<number>(2 * order + 1).fill(0);
  for (let i = 0; i < n; i += 1) {
    let power = 1;
    for (let exponent = 0; exponent <= 2 * order; exponent += 1) {
      powSums[exponent] += power;
      power *= xs[i];
    }
  }
  const matrixA: number[][] = [];
  const vectorB: number[] = [];
  for (let p = 0; p < k; p += 1) {
    matrixA.push(Array.from({ length: k }, (_unused, q) => powSums[p + q]));
    let b = 0;
    for (let i = 0; i < n; i += 1) {
      b += xs[i] ** p * ys[i];
    }
    vectorB.push(b);
  }
  return gaussianSolve(matrixA, vectorB);
}

function fitFor(
  method: RegressionMethod,
  xs: readonly number[],
  ys: readonly number[],
  order: number,
): Fit {
  switch (method) {
    case 'log': {
      const lnX = xs.map((x) => Math.log(x));
      const { a, b } = linearOLS(lnX, ys);
      return { coef: [a, b], predict: (x) => a + b * Math.log(x) };
    }
    case 'exp': {
      const lnY = ys.map((y) => Math.log(y));
      const { a, b } = linearOLS(xs, lnY);
      const coefA = Math.exp(a);
      return { coef: [coefA, b], predict: (x) => coefA * Math.exp(b * x) };
    }
    case 'pow': {
      const lnX = xs.map((x) => Math.log(x));
      const lnY = ys.map((y) => Math.log(y));
      const { a, b } = linearOLS(lnX, lnY);
      const coefA = Math.exp(a);
      return { coef: [coefA, b], predict: (x) => coefA * x ** b };
    }
    case 'quad': {
      // Degree 2, but clamped to `pairs - 1` so a 2-point group doesn't feed a
      // rank-deficient 3×3 normal-equations system (whose underdetermined
      // coefficient would silently resolve to 0).
      const coef = polyFit(xs, ys, Math.min(2, xs.length - 1));
      return { coef, predict: (x) => coef.reduce((sum, c, i) => sum + c * x ** i, 0) };
    }
    case 'poly': {
      const coef = polyFit(xs, ys, order);
      return { coef, predict: (x) => coef.reduce((sum, c, i) => sum + c * x ** i, 0) };
    }
    case 'linear':
    default: {
      const { a, b } = linearOLS(xs, ys);
      return { coef: [a, b], predict: (x) => a + b * x };
    }
  }
}

export function applyRegressionTransform(
  rows: readonly DatasetRow[],
  transform: VegaRegressionTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const groupby = transform.groupby ?? [];
  const groups = groupRows(rows, groupby);
  const [xAs, yAs] = transform.as ?? [transform.on, transform.regression];

  const requestedMethod = (transform.method ?? 'linear') as RegressionMethod;
  let method: RegressionMethod = requestedMethod;
  if (!SUPPORTED_METHODS.includes(requestedMethod)) {
    gaps.add({
      code: 'transform:regression-method',
      message: `Regression method "${String(transform.method)}" is not recognized; falling back to "linear".`,
      severity: 'partial',
      path,
    });
    method = 'linear';
  }
  const needsPositiveX = method === 'log' || method === 'pow';
  const needsPositiveY = method === 'exp' || method === 'pow';

  const out: DatasetRow[] = [];
  for (const group of groups.values()) {
    const xs: number[] = [];
    const ys: number[] = [];
    let dropped = 0;
    for (const row of group.rows) {
      const x = toNumber(row[transform.on]);
      const y = toNumber(row[transform.regression]);
      if (x == null || y == null) {
        continue;
      }
      if ((needsPositiveX && x <= 0) || (needsPositiveY && y <= 0)) {
        dropped += 1;
        continue;
      }
      xs.push(x);
      ys.push(y);
    }
    if (dropped > 0) {
      let requirement = '`regression` > 0';
      if (needsPositiveX && needsPositiveY) {
        requirement = '`on` > 0 and `regression` > 0';
      } else if (needsPositiveX) {
        requirement = '`on` > 0';
      }
      gaps.add({
        code: 'transform:regression-domain',
        message: `${dropped} row(s) were dropped because method "${method}" requires ${requirement}.`,
        severity: 'partial',
        path,
      });
    }
    if (xs.length < 2) {
      continue;
    }

    const order = Math.max(1, Math.min(transform.order ?? 3, xs.length - 1));
    const fit = fitFor(method, xs, ys, order);

    if (transform.params === true) {
      const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
      const ssTot = ys.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
      const ssRes = ys.reduce((sum, value, i) => sum + (value - fit.predict(xs[i])) ** 2, 0);
      const rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
      out.push({ ...group.key, coef: fit.coef, rSquared });
      continue;
    }

    const [lo, hi] = transform.extent ?? [Math.min(...xs), Math.max(...xs)];
    // Both branches are always >= 2, so the sample step (i / (sampleCount -
    // 1)) never divides by zero.
    const sampleCount = method === 'linear' ? 2 : 50;
    for (let i = 0; i < sampleCount; i += 1) {
      const t = i / (sampleCount - 1);
      const x = lo + (hi - lo) * t;
      out.push({ ...group.key, [xAs]: x, [yAs]: fit.predict(x) });
    }
  }
  return out;
}
