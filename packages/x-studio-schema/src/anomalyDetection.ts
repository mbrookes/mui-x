/**
 * Statistical helpers shared by the client (`@mui/x-studio`) and the AI
 * middleware (`@mui/x-studio-ai-middleware`). Pure, dependency-free.
 */

/**
 * Median of a pre-sorted numeric array.
 *
 * File-private: this helper assumes its input is already sorted (a footgun for
 * external callers), so it is intentionally not part of the package's public
 * export surface. `detectAnomaliesIQR` below is the only intended caller.
 */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Detects outliers using the Tukey IQR fences method.
 * Points outside [Q1 - 1.5·IQR, Q3 + 1.5·IQR] are flagged.
 * Returns a Set of outlier indices into the original `values` array.
 */
export function detectAnomaliesIQR(values: number[]): Set<number> {
  // Retain only the FINITE values (keeping each one's ORIGINAL index) before the quartile
  // math. A single `NaN`/`Infinity` — row data reaching `summarise_page` can carry one —
  // would otherwise poison `toSorted`'s comparator, making `q1`/`q3`/`iqr` and every fence
  // `NaN`, so every `value < lower || value > upper` comparison is `false` and the function
  // silently returns "no anomalies" for the WHOLE series. Excluding non-finite values scopes
  // the detection to the real numbers (a `NaN` is not a meaningful outlier) while the returned
  // Set still indexes into the caller's original `values` array.
  const finite: { value: number; index: number }[] = [];
  for (let i = 0; i < values.length; i += 1) {
    if (Number.isFinite(values[i])) {
      finite.push({ value: values[i], index: i });
    }
  }
  if (finite.length < 4) {
    return new Set();
  }
  const sorted = finite.map((entry) => entry.value).toSorted((a, b) => a - b);
  const q1 = median(sorted.slice(0, Math.floor(sorted.length / 2)));
  const q3 = median(sorted.slice(Math.ceil(sorted.length / 2)));
  const iqr = q3 - q1;
  if (iqr === 0) {
    return new Set();
  }
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  const result = new Set<number>();
  for (const { value, index } of finite) {
    if (value < lower || value > upper) {
      result.add(index);
    }
  }
  return result;
}
