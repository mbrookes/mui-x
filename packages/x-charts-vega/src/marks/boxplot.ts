import type { AxisResolution, CompiledUnit, OverlayBoxItem, UnitContext } from '../compile/context';
import { resolveColor } from '../compile/color';
import { toDate, toNumber } from '../compile/fieldTypes';
import { evaluateAggregate } from '../transforms/aggregateOps';
import type { VegaMarkDef } from '../types';

/*
 * OWNERSHIP: the "boxplot" work unit owns this file.
 *
 * Translate the Vega-Lite composite `boxplot` mark to a `{kind: 'boxes'}`
 * overlay (rendered by src/overlays/BoxPlot.tsx — no x-charts series):
 * - group rows by the categorical positional channel (ctx.x/ctx.y categories,
 *   both orientations); per group compute q1/median/q3 via evaluateAggregate;
 * - whiskers: Vega-Lite default `extent: 1.5` → 1.5×IQR clamped to the data
 *   extent, values beyond → `outliers`; `extent: 'min-max'` → full extent, no
 *   outliers; numeric extent k → k×IQR;
 * - color: static mark/value color or resolveColor staticColor; a color FIELD
 *   split → 'partial' gap (one box per category, no dodging);
 * - mark.size → widthRatio approximation; opacity/median/box sub-mark configs
 *   → 'ignored' gaps where unmappable;
 * - return { series: [], plots: [], overlays: [{kind: 'boxes', ...}] }.
 */

/** Whether this unit draws horizontal boxes: continuous x + categorical y. */
function resolveOrientation(ctx: UnitContext): 'horizontal' | 'vertical' {
  const orient = ctx.unit.mark.orient;
  if (orient === 'horizontal' || orient === 'vertical') {
    return orient;
  }
  if (!ctx.x?.categories && ctx.y?.categories) {
    return 'horizontal';
  }
  return 'vertical';
}

/**
 * Temporal axis categories are Date objects (see scales.ts), so raw row values
 * (often ISO strings) must be coerced before the category lookup — same as
 * bar.ts/point.ts/rect.ts.
 */
function toCategoryValue(axis: AxisResolution, raw: unknown): unknown {
  return axis.fieldType === 'temporal' ? toDate(raw) : raw;
}

/** The whisker rule for a box: `null` extent means full min→max (no outliers). */
interface WhiskerExtent {
  /** `k` multiplier for the k×IQR fence, or `null` for the full data extent. */
  k: number | null;
}

/**
 * Reads Vega-Lite's `mark.extent` (default `1.5`). `'min-max'` → full extent
 * (no outliers); a finite number → k×IQR; anything else falls back to the 1.5
 * default (Vega-Lite's own default).
 */
function resolveExtent(mark: VegaMarkDef): WhiskerExtent {
  const raw = (mark as { extent?: unknown }).extent;
  if (raw === undefined) {
    return { k: 1.5 };
  }
  if (raw === 'min-max') {
    return { k: null };
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { k: raw };
  }
  return { k: 1.5 };
}

/** Computes one box (quartiles, whiskers, outliers) for a category's values. */
function computeBox(
  category: OverlayBoxItem['category'],
  values: number[],
  extent: WhiskerExtent,
  color: string | undefined,
): OverlayBoxItem | null {
  const q1 = evaluateAggregate('q1', values);
  const median = evaluateAggregate('median', values);
  const q3 = evaluateAggregate('q3', values);
  if (q1 == null || median == null || q3 == null) {
    return null;
  }

  let whiskerMin: number;
  let whiskerMax: number;
  let outliers: number[] = [];

  if (extent.k === null) {
    // `min-max`: whiskers span the full data extent, nothing is an outlier.
    whiskerMin = Math.min(...values);
    whiskerMax = Math.max(...values);
  } else {
    const iqr = q3 - q1;
    const lowerFence = q1 - extent.k * iqr;
    const upperFence = q3 + extent.k * iqr;
    // Whiskers clamp to the furthest datum still inside the fence.
    const inRange = values.filter((value) => value >= lowerFence && value <= upperFence);
    whiskerMin = inRange.length > 0 ? Math.min(...inRange) : q1;
    whiskerMax = inRange.length > 0 ? Math.max(...inRange) : q3;
    outliers = values.filter((value) => value < lowerFence || value > upperFence);
  }

  return {
    category,
    min: whiskerMin,
    q1,
    median,
    q3,
    max: whiskerMax,
    ...(outliers.length > 0 ? { outliers } : {}),
    ...(color !== undefined ? { color } : {}),
  };
}

export function compileBoxplotMark(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const mark = unit.mark;

  const orientation = resolveOrientation(ctx);
  const horizontal = orientation === 'horizontal';
  const categoryAxis = horizontal ? ctx.y : ctx.x;
  const valueAxis = horizontal ? ctx.x : ctx.y;
  const valueField = horizontal ? ctx.x?.field : ctx.y?.field;
  // The value channel must resolve to a quantitative axis. Temporal channels
  // are rendered as a *discrete* band/point scale in this wrapper (see
  // scales.ts), never a continuous one, so they cannot host boxplot quartiles
  // (and their raw values wouldn't coerce to the numbers the box math needs).
  const valueAxisIsQuantitative = valueAxis?.fieldType === 'quantitative';

  if (!categoryAxis?.categories || !categoryAxis.field || !valueField || !valueAxisIsQuantitative) {
    gaps.add({
      code: 'mark:boxplot-missing-axes',
      message:
        'The boxplot mark needs one categorical/temporal positional channel and one quantitative positional channel; this spec is missing one of them (or both resolved to categorical axes), so no boxes were rendered.',
      severity: 'unsupported',
      path: unit.path,
    });
    return { series: [], plots: [] };
  }

  // Sub-mark styling (median/box/outliers/rule/ticks/opacity) has no per-part
  // x-charts equivalent — the overlay draws a fixed box glyph.
  const subMarkKeys = ['median', 'box', 'outliers', 'rule', 'ticks', 'opacity'] as const;
  const styledSubMark = subMarkKeys.find((key) => (mark as Record<string, unknown>)[key] != null);
  if (styledSubMark) {
    gaps.add({
      code: 'mark:boxplot-submark-config',
      message: `Box-plot sub-mark styling (\`${styledSubMark}\`) has no per-part x-charts equivalent; the overlay draws a fixed box/whisker/median/outlier glyph and the styling was ignored.`,
      severity: 'ignored',
      path: `${unit.path}.mark`,
    });
  }

  const color = resolveColor(encoding, rows, gaps, unit.path);
  const staticColor = color.staticColor ?? mark.color ?? mark.fill;
  if (color.splitField) {
    gaps.add({
      code: 'mark:boxplot-color-field',
      message: `A color field ("${color.splitField}") would split each category into several boxes, but this wrapper draws one aggregated box per category (no dodged/grouped box plots); the color split was collapsed to a single box per category.`,
      severity: 'partial',
      path: `${unit.path}.encoding.color`,
    });
  }

  // `mark.size` is an explicit pixel box thickness; the overlay sizes boxes as
  // a fraction of the (unknown-at-compile-time) band width, so the pixel value
  // cannot be honored precisely.
  if (mark.size !== undefined) {
    gaps.add({
      code: 'mark:boxplot-size',
      message:
        'mark.size sets an explicit box thickness in pixels, but this wrapper sizes boxes as a fraction of the category band width (resolved at render time); the pixel size was approximated by the default width ratio.',
      severity: 'partial',
      path: `${unit.path}.mark.size`,
    });
  }

  const extent = resolveExtent(mark);
  const categoryField = categoryAxis.field;
  const categories = categoryAxis.categories;

  // Collect the continuous values per category, index-aligned to `categories`.
  const grouped: number[][] = categories.map(() => []);
  for (const row of rows) {
    const index = ctx.categoryIndex(
      categoryAxis,
      toCategoryValue(categoryAxis, row[categoryField]),
    );
    if (index < 0) {
      continue;
    }
    const value = toNumber(row[valueField]);
    if (value === null) {
      continue;
    }
    grouped[index].push(value);
  }

  const items: OverlayBoxItem[] = [];
  categories.forEach((category, index) => {
    const values = grouped[index];
    if (values.length === 0) {
      return;
    }
    const box = computeBox(category, values, extent, staticColor);
    if (box) {
      items.push(box);
    }
  });

  return {
    series: [],
    plots: [],
    overlays: [{ kind: 'boxes', orientation, items }],
  };
}
