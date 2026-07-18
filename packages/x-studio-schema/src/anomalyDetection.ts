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
  // `epsilon` is a small tolerance RELATIVE to `q1`'s own magnitude (falling back to an
  // absolute `1e-9` floor for `q1` at or near zero, where a relative tolerance would
  // itself collapse to 0 and stop tolerating anything) — scaling with `q1` means the
  // tolerance stays meaningful whether the series sits around `1e-6` or `1e6`, without
  // being so large it would mask a genuine near-baseline outlier. Computed unconditionally
  // (not only inside the degenerate branch) so it can ALSO gate the branch selection below.
  const epsilon = Math.max(Math.abs(q1) * 1e-9, 1e-9);
  if (iqr <= epsilon) {
    // Degenerate spread — Q1 === Q3 exactly, OR merely NEAR-equal within floating-point
    // noise (a near-constant series can produce a tiny nonzero `iqr`, e.g. `1e-13`, from
    // upstream sum/average rounding). Treating only an EXACT `iqr === 0` as degenerate
    // understated the problem: a tiny-but-nonzero `iqr` still flows into the standard
    // Tukey fence formula below, which multiplies it by 1.5 and produces an equally tiny
    // fence width — so the "normal" branch would flag nearly every value that isn't
    // bit-for-bit identical to Q1/Q3 as an outlier on a series that is, for all practical
    // purposes, constant. Comparing against `epsilon` instead of `0` catches that case too
    // and falls through to the SAME wider, magnitude-relative comparison below rather than
    // bailing out or over-flagging. Returning an empty Set here would report "no anomalies"
    // even for a series like `[5, 5, 5, 5, 5, 5, 5, 1000]`, where `1000` is an obvious
    // extreme spike against an otherwise-constant baseline — a false negative strictly
    // worse than flagging every value that differs from the constant.
    //
    // A bare `value !== q1` is too strict, though: for a series like
    // `[100, 100, 100, 100, 100.0000001]` it flags the last value purely on
    // floating-point jitter (e.g. from an upstream sum/average computation), even
    // though the series is effectively constant. The SAME `epsilon` tolerance is reused
    // here for the per-value comparison.
    const result = new Set<number>();
    for (const { value, index } of finite) {
      if (Math.abs(value - q1) > epsilon) {
        result.add(index);
      }
    }
    return result;
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
