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

/**
 * Vega's named categorical color schemes, reproduced as the exact swatch arrays
 * Vega ships (from `vega-scale`/`d3-scale-chromatic`). When a spec sets
 * `scale.scheme` to one of these, using the real palette makes the wrapper's
 * colors match the reference renderer instead of approximating with an ambient
 * MUI palette. Keys are lower-cased scheme names.
 */
export const VEGA_CATEGORICAL_SCHEMES: Record<string, readonly string[]> = {
  tableau10: VEGA_TABLEAU10,
  tableau20: [
    '#4c78a8', '#9ecae9', '#f58518', '#ffbf79', '#54a24b', '#88d27a', '#b79a20', '#f2cf5b',
    '#439894', '#83bcb6', '#e45756', '#ff9d98', '#79706e', '#bab0ac', '#d67195', '#fcbfd2',
    '#b279a2', '#d6a5c9', '#9e765f', '#d8b5a5',
  ],
  category10: [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
  ],
  category20: [
    '#1f77b4', '#aec7e8', '#ff7f0e', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896',
    '#9467bd', '#c5b0d5', '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7',
    '#bcbd22', '#dbdb8d', '#17becf', '#9edae5',
  ],
  category20b: [
    '#393b79', '#5254a3', '#6b6ecf', '#9c9ede', '#637939', '#8ca252', '#b5cf6b', '#cedb9c',
    '#8c6d31', '#bd9e39', '#e7ba52', '#e7cb94', '#843c39', '#ad494a', '#d6616b', '#e7969c',
    '#7b4173', '#a55194', '#ce6dbd', '#de9ed6',
  ],
  category20c: [
    '#3182bd', '#6baed6', '#9ecae1', '#c6dbef', '#e6550d', '#fd8d3c', '#fdae6b', '#fdd0a2',
    '#31a354', '#74c476', '#a1d99b', '#c7e9c0', '#756bb1', '#9e9ac8', '#bcbddd', '#dadaeb',
    '#636363', '#969696', '#bdbdbd', '#d9d9d9',
  ],
  accent: ['#7fc97f', '#beaed4', '#fdc086', '#ffff99', '#386cb0', '#f0027f', '#bf5b17', '#666666'],
  dark2: ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d', '#666666'],
  paired: [
    '#a6cee3', '#1f78b4', '#b2df8a', '#33a02c', '#fb9a99', '#e31a1c',
    '#fdbf6f', '#ff7f00', '#cab2d6', '#6a3d9a', '#ffff99', '#b15928',
  ],
  pastel1: [
    '#fbb4ae', '#b3cde3', '#ccebc5', '#decbe4', '#fed9a6',
    '#ffffcc', '#e5d8bd', '#fddaec', '#f2f2f2',
  ],
  pastel2: ['#b3e2cd', '#fdcdac', '#cbd5e8', '#f4cae4', '#e6f5c9', '#fff2ae', '#f1e2cc', '#cccccc'],
  set1: [
    '#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00',
    '#ffff33', '#a65628', '#f781bf', '#999999',
  ],
  set2: ['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3'],
  set3: [
    '#8dd3c7', '#ffffb3', '#bebada', '#fb8072', '#80b1d3', '#fdb462',
    '#b3de69', '#fccde5', '#d9d9d9', '#bc80bd', '#ccebc5', '#ffed6f',
  ],
};
