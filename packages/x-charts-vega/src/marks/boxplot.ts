import type {
  AxisResolution,
  CompiledUnit,
  OverlayBoxItem,
  OverlayBoxSubMark,
  UnitContext,
} from '../compile/context';
import { resolveColor } from '../compile/color';
import { toDate, toNumber } from '../compile/fieldTypes';
import { evaluateAggregate } from '../transforms/aggregateOps';
import type { GapCollector } from '../gaps';
import type { DatasetRow, VegaMarkDef } from '../types';
import { groupRowsByField } from './bar';

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
 *   split → grouped/dodged boxes (one box per category per color group),
 *   flagged with a 'partial' gap since the overlay draws no legend entries;
 * - mark.size → widthRatio approximation ('partial' gap); mark.median/box/
 *   rule/ticks/outliers sub-mark configs → styling carried through where
 *   translatable (color/opacity), other keys → 'partial' gap;
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

/** Sub-mark styling keys this wrapper can honor (color/opacity, under either their `mark.<part>.color`/`fill`/`stroke` and `opacity`/`fillOpacity`/`strokeOpacity` aliases). */
const HONORED_SUBMARK_KEYS = new Set([
  'color',
  'fill',
  'stroke',
  'opacity',
  'fillOpacity',
  'strokeOpacity',
]);

/**
 * Resolves one box-plot sub-mark config (`mark.median`/`box`/`rule`/`ticks`/
 * `outliers`): `false` hides the sub-mark; `null`/`true`/omitted leaves it at
 * the overlay's default styling (`undefined`); an object carries its
 * color/opacity through (`color`/`fill`/`stroke` and `opacity`/`fillOpacity`/
 * `strokeOpacity`, first-wins) and reports any other keys as a 'partial' gap
 * listing what was unhonored.
 */
function resolveSubMark(
  raw: unknown,
  gaps: GapCollector,
  path: string,
  key: string,
): OverlayBoxSubMark | false | undefined {
  if (raw === false) {
    return false;
  }
  if (raw == null || raw === true) {
    return undefined;
  }
  if (typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const color = obj.color ?? obj.fill ?? obj.stroke;
  const opacity = obj.opacity ?? obj.fillOpacity ?? obj.strokeOpacity;
  const unhonoredKeys = Object.keys(obj).filter((k) => !HONORED_SUBMARK_KEYS.has(k));
  if (unhonoredKeys.length > 0) {
    gaps.add({
      code: 'mark:boxplot-submark-config',
      message: `Box-plot sub-mark styling \`mark.${key}\` has properties with no x-charts equivalent (${unhonoredKeys.join(', ')}); only color/opacity are honored, the rest were ignored.`,
      severity: 'partial',
      path: `${path}.mark.${key}`,
    });
  }
  const resolved: OverlayBoxSubMark = {};
  if (typeof color === 'string') {
    resolved.color = color;
  }
  if (typeof opacity === 'number') {
    resolved.opacity = opacity;
  }
  return resolved;
}

/** Computes one box (quartiles, whiskers, outliers) for a category's values. */
function computeBox(
  category: OverlayBoxItem['category'],
  values: number[],
  extent: WhiskerExtent,
  color: string | undefined,
  groupIndex?: number,
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
    ...(groupIndex !== undefined ? { groupIndex } : {}),
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

  // Sub-mark styling: median/box/rule/ticks/outliers each resolve to color/
  // opacity (or `false` to hide the sub-mark); other unmapped keys report a
  // 'partial' gap per sub-mark (see resolveSubMark).
  const median = resolveSubMark(mark.median, gaps, unit.path, 'median');
  const rule = resolveSubMark(mark.rule, gaps, unit.path, 'rule');
  const ticks = resolveSubMark(mark.ticks, gaps, unit.path, 'ticks');
  const outliersSubMark = resolveSubMark(mark.outliers, gaps, unit.path, 'outliers');
  const opacity = typeof mark.opacity === 'number' ? mark.opacity : undefined;

  // Unlike the other sub-marks, the box (IQR rectangle) is the overlay's
  // primary glyph and cannot be hidden — `mark.box: false` degrades to an
  // 'ignored' gap instead of a hidden box.
  const boxRaw = resolveSubMark(mark.box, gaps, unit.path, 'box');
  let box: OverlayBoxSubMark | undefined;
  if (boxRaw === false) {
    gaps.add({
      code: 'mark:boxplot-box-hide-unsupported',
      message:
        'mark.box: false would hide the box (IQR rectangle) sub-mark, but the overlay always draws it as the primary box-plot glyph; the box was rendered instead.',
      severity: 'ignored',
      path: `${unit.path}.mark.box`,
    });
  } else {
    box = boxRaw;
  }

  const color = resolveColor(encoding, rows, gaps, unit.path);
  const staticColor = color.staticColor ?? mark.color ?? mark.fill;

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

  /** Collects a group's rows into per-category value arrays, index-aligned to `categories`. */
  const collectByCategory = (groupRows: readonly DatasetRow[]): number[][] => {
    const grouped: number[][] = categories.map(() => []);
    for (const row of groupRows) {
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
    return grouped;
  };

  const items: OverlayBoxItem[] = [];
  let groupCount = 1;

  if (color.splitField) {
    // Grouped/dodged boxes: one box per category per color group.
    const groups = groupRowsByField(ctx, rows, color.splitField, color.domain);
    groupCount = groups.length;
    groups.forEach((group, gi) => {
      // Deliberately does not fall back to `staticColor`: a static
      // mark/value color applies when there's no color split at all (see
      // the `else` branch below) — falling back to it here as well would
      // paint every dodged group identically whenever `mark.color` happens
      // to be set alongside a color-field split, defeating the point of
      // dodging (and contradicting the color-legend gap message below,
      // which tells the user to use box color to tell groups apart).
      const groupColor = color.range?.[gi] ?? ctx.palette[gi % ctx.palette.length];
      const grouped = collectByCategory(group.rows);
      categories.forEach((category, index) => {
        const values = grouped[index];
        if (values.length === 0) {
          return;
        }
        const item = computeBox(category, values, extent, groupColor, gi);
        if (item) {
          items.push(item);
        }
      });
    });
    gaps.add({
      code: 'mark:boxplot-color-legend',
      message: `A color field ("${color.splitField}") splits each category into ${groupCount} dodged boxes, but the overlay draws them without contributing legend entries; use the color values shown on the boxes to identify groups.`,
      severity: 'partial',
      path: `${unit.path}.encoding.color`,
    });
  } else {
    // No color split: one aggregated box per category.
    const grouped = collectByCategory(rows);
    categories.forEach((category, index) => {
      const values = grouped[index];
      if (values.length === 0) {
        return;
      }
      const item = computeBox(category, values, extent, staticColor);
      if (item) {
        items.push(item);
      }
    });
  }

  return {
    series: [],
    plots: [],
    overlays: [
      {
        kind: 'boxes',
        orientation,
        items,
        ...(groupCount > 1 ? { groupCount } : {}),
        ...(opacity !== undefined ? { opacity } : {}),
        ...(median !== undefined ? { median } : {}),
        ...(box !== undefined ? { box } : {}),
        ...(rule !== undefined ? { rule } : {}),
        ...(ticks !== undefined ? { ticks } : {}),
        ...(outliersSubMark !== undefined ? { outliers: outliersSubMark } : {}),
      },
    ],
  };
}
