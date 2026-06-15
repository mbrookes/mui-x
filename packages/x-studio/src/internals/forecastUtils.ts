/**
 * Client-side forecast / trend computation utilities.
 *
 * Used by `StudioChartWidget` to overlay a linear trend projection beyond the
 * last observed data point. The implementation is intentionally lightweight —
 * no external dependencies are required.
 */
import type { StudioWidgetForecast } from '../models/widgetTypes';

// ── Linear regression ─────────────────────────────────────────────────────────

interface LinearRegressionResult {
  slope: number;
  intercept: number;
  /** Root-mean-square error of residuals (standard error of estimate). */
  stdError: number;
}

/**
 * Computes ordinary least-squares linear regression over an array of y values.
 * The x values are implicit: 0, 1, 2, …, n-1.
 * Returns slope, intercept, and std error. Null values are ignored.
 */
export function linearRegression(values: (number | null)[]): LinearRegressionResult | null {
  const pairs: [number, number][] = values
    .map((v, i): [number, number] | null => (v != null ? [i, v] : null))
    .filter((p): p is [number, number] => p !== null);

  const n = pairs.length;
  if (n < 2) {
    return null;
  }

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;

  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) {
    return null;
  }

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // Residual standard error
  let ssRes = 0;
  for (const [x, y] of pairs) {
    const predicted = slope * x + intercept;
    ssRes += (y - predicted) ** 2;
  }
  const stdError = Math.sqrt(ssRes / (n - 2));

  return { slope, intercept, stdError };
}

// ── Label extension ───────────────────────────────────────────────────────────

/**
 * Extends an array of x-axis labels by `periods` steps.
 *
 * - If labels are ISO-date strings (YYYY-MM-DD / YYYY-MM / YYYY), the function
 *   advances each new label by the median interval between existing labels.
 * - For numeric labels, each new label increments by the median interval.
 * - For all other strings, generates labels like "Forecast +1", "Forecast +2", …
 */
export function extendLabels(labels: (string | number)[], periods: number): (string | number)[] {
  if (labels.length === 0 || periods <= 0) {
    return [];
  }

  // Try date extension
  const dateLabels = tryExtendAsDateLabels(labels, periods);
  if (dateLabels) {
    return dateLabels;
  }

  // Numeric labels
  const numericLabels = tryExtendAsNumericLabels(labels, periods);
  if (numericLabels) {
    return numericLabels;
  }

  // Fallback: generic forecast labels
  return Array.from({ length: periods }, (_, i) => `+${i + 1}`);
}

function tryExtendAsDateLabels(
  labels: (string | number)[],
  periods: number,
): (string | number)[] | null {
  const datePattern = /^\d{4}(-\d{2}(-\d{2})?)?$/;
  const allStrings = labels.every((l) => typeof l === 'string' && datePattern.test(l as string));
  if (!allStrings) {
    return null;
  }

  const formatLike = labels[0] as string;

  // Year-only: YYYY
  if (formatLike.length === 4) {
    const lastYear = parseInt(labels[labels.length - 1] as string, 10);
    return Array.from({ length: periods }, (_, i) => String(lastYear + i + 1));
  }

  // Year-month: YYYY-MM
  if (formatLike.length === 7) {
    const last = labels[labels.length - 1] as string;
    const [yearStr, monthStr] = last.split('-');
    let year = parseInt(yearStr, 10);
    let month = parseInt(monthStr, 10); // 1-12
    return Array.from({ length: periods }, () => {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      return `${year}-${String(month).padStart(2, '0')}`;
    });
  }

  // Full date: YYYY-MM-DD — use ms interval from last two labels
  const dates = labels.map((l) => {
    const d = new Date(`${l as string}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  });
  if (dates.some((d) => d === null)) {
    return null;
  }

  const timestamps = (dates as Date[]).map((d) => d.getTime());
  const intervals = timestamps.slice(1).map((t, i) => t - timestamps[i]);
  const step = intervals.length > 0 ? median(intervals) : 7 * 24 * 60 * 60 * 1000;
  const lastTs = timestamps[timestamps.length - 1];

  return Array.from({ length: periods }, (_, i) => {
    const next = new Date(lastTs + step * (i + 1));
    const m = String(next.getUTCMonth() + 1).padStart(2, '0');
    const d = String(next.getUTCDate()).padStart(2, '0');
    return `${next.getUTCFullYear()}-${m}-${d}`;
  });
}

function tryExtendAsNumericLabels(
  labels: (string | number)[],
  periods: number,
): (string | number)[] | null {
  const nums = labels.map((l) => {
    const n = Number(l);
    return Number.isNaN(n) ? null : n;
  });

  if (nums.some((n) => n === null)) {
    return null;
  }

  const numArray = nums as number[];
  const intervals = numArray.slice(1).map((n, i) => n - numArray[i]);
  const step = intervals.length > 0 ? median(intervals) : 1;
  const last = numArray[numArray.length - 1];

  return Array.from({ length: periods }, (_, i) => last + step * (i + 1));
}

function median(arr: number[]): number {
  if (arr.length === 0) {
    return 0;
  }
  const sorted = arr.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ── Main forecast computation ─────────────────────────────────────────────────

interface ForecastData {
  /** Extended labels (historical + forecast periods). */
  labels: (string | number)[];
  /** Historical values followed by nulls (same length as labels). */
  historicalSeries: (number | null)[];
  /** Nulls for historical points followed by forecast values. */
  forecastSeries: (number | null)[];
  /** Upper confidence band (null for historical). null when showConfidenceBands is false. */
  upperBand: (number | null)[] | null;
  /** Lower confidence band (null for historical). null when showConfidenceBands is false. */
  lowerBand: (number | null)[] | null;
}

/**
 * Computes forecast data from a historical value series.
 *
 * @param labels     X-axis labels for historical data points.
 * @param values     Y-axis values corresponding to each label.
 * @param forecast   Forecast configuration from `StudioWidgetConfig.forecast`.
 * @returns          Extended label/series arrays ready to pass to `@mui/x-charts`.
 *                   Returns `null` when regression cannot be computed (fewer than 2 points).
 */
export function computeWidgetForecast(
  labels: (string | number)[],
  values: (number | null)[],
  forecast: StudioWidgetForecast,
): ForecastData | null {
  const { periods = 3, showConfidenceBands = false } = forecast;

  const regression = linearRegression(values);
  if (!regression) {
    return null;
  }

  const n = values.length;
  const { slope, intercept, stdError } = regression;

  // Compute forecast values at indices n, n+1, …, n+periods-1
  const forecastValues = Array.from({ length: periods }, (_, i) => {
    const x = n + i;
    return slope * x + intercept;
  });

  // Extend labels
  const newLabels = extendLabels(labels, periods);

  // Build series arrays
  const historicalSeries: (number | null)[] = [...values, ...Array(periods).fill(null)];
  const forecastSeries: (number | null)[] = [
    ...Array(n).fill(null),
    // Include the last historical point as the first forecast point so the dashed
    // line visually connects to the end of the historical series
    values[n - 1],
    ...forecastValues.slice(1),
  ];

  let upperBand: (number | null)[] | null = null;
  let lowerBand: (number | null)[] | null = null;

  if (showConfidenceBands) {
    upperBand = [
      ...Array(n).fill(null),
      values[n - 1],
      ...forecastValues.slice(1).map((v) => v + stdError),
    ];
    lowerBand = [
      ...Array(n).fill(null),
      values[n - 1],
      ...forecastValues.slice(1).map((v) => Math.max(0, v - stdError)),
    ];
  }

  return {
    labels: [...labels, ...newLabels],
    historicalSeries,
    forecastSeries,
    upperBand,
    lowerBand,
  };
}

// ── Correlation ───────────────────────────────────────────────────────────────

/**
 * Computes the Pearson correlation coefficient between two numeric arrays.
 * Null values are excluded pairwise (only positions where both are non-null are used).
 * Returns `null` when fewer than 2 valid pairs exist.
 */
export function pearsonCorrelation(xs: (number | null)[], ys: (number | null)[]): number | null {
  const pairs: [number, number][] = [];
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i += 1) {
    if (xs[i] != null && ys[i] != null) {
      pairs.push([xs[i] as number, ys[i] as number]);
    }
  }

  const count = pairs.length;
  if (count < 2) {
    return null;
  }

  const meanX = pairs.reduce((s, [x]) => s + x, 0) / count;
  const meanY = pairs.reduce((s, [, y]) => s + y, 0) / count;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const denom = Math.sqrt(denX * denY);
  if (denom === 0) {
    return null;
  }

  return num / denom;
}

/**
 * Returns a human-readable interpretation of a Pearson r value.
 * - |r| ≥ 0.8 → strong
 * - 0.5 ≤ |r| < 0.8 → moderate
 * - 0.2 ≤ |r| < 0.5 → weak
 * - |r| < 0.2 → negligible
 */
export function interpretCorrelation(r: number): string {
  const abs = Math.abs(r);
  const direction = r >= 0 ? 'positive' : 'negative';
  if (abs >= 0.8) {
    return `strong ${direction}`;
  }
  if (abs >= 0.5) {
    return `moderate ${direction}`;
  }
  if (abs >= 0.2) {
    return `weak ${direction}`;
  }
  return 'negligible';
}
