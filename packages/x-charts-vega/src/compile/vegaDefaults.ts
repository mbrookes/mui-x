/**
 * Vega-Lite's own default visual constants, so the wrapper's output reads like
 * the reference renderer rather than the ambient MUI theme.
 */

/**
 * Vega-Lite's default categorical color scheme (`tableau10`), used for a
 * nominal/ordinal color field and — via its first entry (`#4c78a8`, a muted
 * steel blue) — for a single uncolored mark. Matches
 * `vega-lite`'s `config.range.category` default.
 */
export const VEGA_TABLEAU10: readonly string[] = [
  '#4c78a8',
  '#f58518',
  '#e45756',
  '#72b7b2',
  '#54a24b',
  '#eeca3b',
  '#b279a2',
  '#ff9da6',
  '#9d755d',
  '#bab0ac',
];

/** Vega-Lite's default single-mark color (the first `tableau10` swatch). */
export const VEGA_DEFAULT_MARK_COLOR = VEGA_TABLEAU10[0];
