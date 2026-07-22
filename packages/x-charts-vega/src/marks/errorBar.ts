import type {
  AxisResolution,
  CompiledOverlay,
  CompiledUnit,
  OverlayBandPoint,
  OverlayErrorBarItem,
  OverlayLegendItem,
  UnitContext,
} from '../compile/context';
import { resolveColor } from '../compile/color';
import { toDate, toNumber } from '../compile/fieldTypes';
import { evaluateAggregate } from '../transforms/aggregateOps';
import type { DatasetRow, VegaChannelDef, VegaMarkDef } from '../types';
import { isFieldDef } from '../types';
import { groupRowsByField } from './bar';

/*
 * A color-field split dodges error bars side-by-side within each category
 * (mirroring boxplot.ts). The dodge fields `groupIndex`/`groupCount` live on
 * `OverlayErrorBarItem` in compile/context.ts; every item in a dodged overlay
 * carries the same `groupCount`.
 */

/** Formats a color-group value for a legend swatch label (locale date for temporal groups). */
function formatLegendLabel(value: unknown): string {
  return value instanceof Date ? value.toLocaleDateString() : String(value);
}

/*
 * OWNERSHIP: the "errorbar/errorband" work unit owns this file.
 *
 * Translate the Vega-Lite composite `errorbar` and `errorband` marks to
 * `{kind: 'errorBars'}` / `{kind: 'band'}` overlays (rendered by
 * src/overlays/ErrorBars.tsx):
 * - group rows by the categorical/temporal positional channel; per group
 *   compute the interval per `extent`: 'stderr' (default, mean ± stderr),
 *   'stdev' (mean ± stdev), 'ci' (approximate as mean ± 1.96×stderr — Vega
 *   uses bootstrapped CIs, note the approximation in a 'partial' gap), 'iqr'
 *   (q1..q3) — reuse evaluateAggregate ops from ../transforms/aggregateOps;
 * - errorbar → errorBars overlay items (category, lower, upper, optional
 *   center=mean); errorband → band overlay points (sorted by the category
 *   axis order — x for vertical, y for horizontal/transposed);
 * - both orientations supported for both errorbar and errorband; a
 *   transposed (categorical-y) errorband tags its overlay with
 *   `orientation: 'horizontal'` and stores the y-category in `point.x` (see
 *   `OverlayBandPoint`'s JSDoc in compile/context.ts) for the renderer to
 *   transpose;
 * - color from static mark/value color; a color-field split dodges the mark
 *   into one interval/band per color group per category (side-by-side for
 *   errorbar; one overlaid band per group for errorband) and emits
 *   `overlayLegend` swatches — mirroring boxplot.ts;
 * - these marks are usually LAYERED with line/point marks — the pipeline
 *   already flattens layers, nothing special needed;
 * - return { series: [], plots: [], overlays: [...] }.
 */

type ErrorExtent = 'stderr' | 'stdev' | 'ci' | 'iqr';

function fieldOf(def: VegaChannelDef | undefined): string | undefined {
  return def && isFieldDef(def) ? def.field : undefined;
}

/**
 * Whether this unit is drawn with the category on the y axis: explicit
 * `mark.orient`, else inferred from which channel resolved to a discrete axis
 * (mirrors bar.ts's resolveOrientation). When NEITHER axis is categorical —
 * a "global"/1D errorband spanning the whole continuous domain of the axis it
 * doesn't itself encode (`layer_scatter_errorband_1D_stdev_global_mean`'s
 * `encoding: {y: {...}}` with no `x` at all) — falls back to whichever
 * channel THIS layer's own (possibly root-inherited) encoding actually
 * defines: that's the value channel, and the other, undefined one is what
 * gets spanned rather than grouped.
 */
function resolveOrientation(
  ctx: UnitContext,
  encoding: UnitContext['encoding'],
): 'horizontal' | 'vertical' {
  const orient = ctx.unit.mark.orient;
  if (orient === 'horizontal' || orient === 'vertical') {
    return orient;
  }
  if (!ctx.x?.categories && ctx.y?.categories) {
    return 'horizontal';
  }
  if (!ctx.x?.categories && !ctx.y?.categories) {
    const hasOwnX = fieldOf(encoding.x) !== undefined;
    const hasOwnY = fieldOf(encoding.y) !== undefined;
    if (hasOwnY && !hasOwnX) {
      return 'vertical';
    }
    if (hasOwnX && !hasOwnY) {
      return 'horizontal';
    }
  }
  return 'vertical';
}

/**
 * Temporal axis categories are Date objects (see scales.ts), so raw row
 * values (often ISO strings) must be coerced before the category lookup —
 * same as bar.ts/lineArea.ts/point.ts.
 */
function toCategoryValue(axis: AxisResolution, raw: unknown): unknown {
  return axis.fieldType === 'temporal' ? toDate(raw) : raw;
}

/** `mark.extent` isn't in the typed `VegaMarkDef` subset — read it defensively and fall back to Vega-Lite's default ('stderr') for anything unrecognized. */
function resolveExtent(mark: VegaMarkDef, gaps: UnitContext['gaps'], path: string): ErrorExtent {
  const raw = mark.extent;
  if (raw === undefined) {
    return 'stderr';
  }
  if (raw === 'stderr' || raw === 'stdev' || raw === 'ci' || raw === 'iqr') {
    return raw;
  }
  gaps.add({
    code: 'mark:errorbar-extent-unsupported',
    message: `mark.extent "${String(raw)}" is not a recognized errorbar/errorband extent ("stderr" / "stdev" / "ci" / "iqr"); falling back to "stderr" (mean ± standard error).`,
    severity: 'partial',
    path: `${path}.mark.extent`,
  });
  return 'stderr';
}

interface Interval {
  mean: number;
  lower: number;
  upper: number;
}

/** Computes the mean-centered interval for one group of raw numeric values per `extent`; `null` when there isn't enough data (e.g. a single-row group has no variance). */
function computeInterval(values: number[], extent: ErrorExtent): Interval | null {
  if (values.length === 0) {
    return null;
  }
  const mean = evaluateAggregate('mean', values);
  if (mean == null) {
    return null;
  }
  if (extent === 'iqr') {
    const q1 = evaluateAggregate('q1', values);
    const q3 = evaluateAggregate('q3', values);
    if (q1 == null || q3 == null) {
      return null;
    }
    return { mean, lower: q1, upper: q3 };
  }
  if (extent === 'stdev') {
    const stdev = evaluateAggregate('stdev', values);
    if (stdev == null) {
      return null;
    }
    return { mean, lower: mean - stdev, upper: mean + stdev };
  }
  // 'stderr' and 'ci' both derive from the standard error; 'ci' widens it to
  // an approximate 95% normal-interval margin (1.96 × stderr).
  const stderr = evaluateAggregate('stderr', values);
  if (stderr == null) {
    return null;
  }
  const margin = extent === 'ci' ? 1.96 * stderr : stderr;
  return { mean, lower: mean - margin, upper: mean + margin };
}

/** Groups a value field's numbers by category index, index-aligned with `categoryAxis.categories`. */
function groupValuesByCategory(
  ctx: UnitContext,
  rows: readonly DatasetRow[],
  categoryAxis: AxisResolution,
  categoryField: string,
  valueField: string,
): number[][] {
  const groups: number[][] = (categoryAxis.categories ?? []).map(() => []);
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
    groups[index].push(value);
  }
  return groups;
}

/**
 * The numeric/temporal extent (min, max) of `field` across `rows` — spans a
 * "global"/1D errorband across the full continuous domain of the axis it
 * doesn't itself encode (see `compileErrorBarMark`'s `isGlobalBand`). `null`
 * when no row has a valid value.
 */
function fieldExtent(
  rows: readonly DatasetRow[],
  field: string,
  fieldType: string | undefined,
): [number, number] | [Date, Date] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    const raw = row[field];
    const value = fieldType === 'temporal' ? toDate(raw)?.getTime() : toNumber(raw);
    if (value == null || Number.isNaN(value)) {
      continue;
    }
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }
  return fieldType === 'temporal' ? [new Date(min), new Date(max)] : [min, max];
}

export function compileErrorBarMark(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const mark = unit.mark;
  const path = unit.path;
  const markType = mark.type as 'errorbar' | 'errorband';

  const orientation = resolveOrientation(ctx, encoding);
  const horizontal = orientation === 'horizontal';
  const categoryAxis = horizontal ? ctx.y : ctx.x;
  const valueAxis = horizontal ? ctx.x : ctx.y;
  const valueChannelDef = horizontal ? encoding.x : encoding.y;
  const categoryChannelDef = horizontal ? encoding.y : encoding.x;
  const valueField = fieldOf(valueChannelDef);
  const categoryField = categoryAxis?.field;

  // A "global"/1D errorband: this layer's own encoding defines only the value
  // channel, with no category/grouping channel at all (not even inherited
  // from a shared root encoding) — Vega-Lite computes ONE interval over every
  // row and draws it spanning the full continuous domain of the other axis,
  // rather than grouping by it. Only implemented for `errorband`: Vega-Lite
  // positions a global `errorbar` at the plot's pixel center, not a data
  // value this wrapper can derive, so that shape still falls through to the
  // ordinary missing-axes gap below.
  const isGlobalBand =
    markType === 'errorband' &&
    categoryChannelDef === undefined &&
    valueField !== undefined &&
    valueAxis?.fieldType === 'quantitative' &&
    !categoryAxis?.categories &&
    categoryAxis?.field !== undefined &&
    (categoryAxis.fieldType === 'quantitative' || categoryAxis.fieldType === 'temporal');
  const spanExtent = isGlobalBand
    ? fieldExtent(rows, categoryAxis!.field!, categoryAxis!.fieldType)
    : null;
  const globalBandActive = isGlobalBand && spanExtent !== null;

  if (
    !globalBandActive &&
    (!categoryAxis?.categories ||
      !categoryField ||
      !valueField ||
      valueAxis?.fieldType !== 'quantitative')
  ) {
    gaps.add({
      code: 'mark:errorbar-missing-axes',
      message:
        'The errorbar/errorband mark needs one categorical/temporal positional channel and one quantitative positional channel holding the raw (non-aggregated) values to compute the interval from; this spec is missing one of them, so nothing was rendered.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  /** x-charts has no errorbar/errorband series primitive — always drawn by a custom overlay. */
  const addOverlayGap = (): void => {
    gaps.add({
      code:
        markType === 'errorbar' ? 'mark:errorbar-custom-overlay' : 'mark:errorband-custom-overlay',
      message:
        markType === 'errorbar'
          ? 'x-charts has no native errorbar primitive; the interval whiskers are drawn by a custom SVG overlay instead of an x-charts series.'
          : 'x-charts has no native errorband primitive; the interval band is drawn by a custom SVG overlay instead of an x-charts series.',
      severity: 'ignored',
      path,
    });
  };

  const extent = resolveExtent(mark, gaps, path);
  if (extent === 'ci') {
    gaps.add({
      code: 'mark:errorbar-ci-approximation',
      message:
        'Vega-Lite computes `extent: "ci"` via bootstrapped resampling; this wrapper approximates it as mean ± 1.96×stderr (a normal-approximation ~95% interval), which can differ from Vega-Lite\'s output for small or skewed samples.',
      severity: 'partial',
      path: `${path}.mark.extent`,
    });
  }

  const color = resolveColor(encoding, rows, gaps, path);
  // An errorband is a filled area, so an uncolored one must still pick up
  // Vega-Lite's default mark color (the palette's first swatch, a steel blue)
  // rather than the overlay's bare default grey. An errorbar's rules keep the
  // overlay default (Vega renders those near-black), so only the band is nudged.
  const staticColor =
    color.staticColor ?? mark.color ?? (markType === 'errorband' ? ctx.palette[0] : undefined);

  /** Computes the per-category intervals for one set of rows, index-aligned to `categoryAxis.categories`. */
  const intervalsForRows = (groupRows: readonly DatasetRow[]): (Interval | null)[] =>
    groupValuesByCategory(ctx, groupRows, categoryAxis!, categoryField!, valueField!).map(
      (values) => computeInterval(values, extent),
    );

  // The color of a dodged group: deliberately does NOT fall back to
  // `staticColor` (see boxplot.ts) — reusing a static `mark.color` for every
  // group would paint all dodged groups identically, defeating the split.
  const groupColorAt = (gi: number): string =>
    color.range && color.range.length > 0
      ? color.range[gi % color.range.length]
      : ctx.palette[gi % ctx.palette.length];

  if (markType === 'errorbar') {
    const items: OverlayErrorBarItem[] = [];
    const overlayLegend: OverlayLegendItem[] = [];

    if (color.splitField) {
      // Dodged error bars: one interval per category per color group, drawn
      // side-by-side (the renderer offsets each item by its groupIndex within
      // the category band). Same shape as boxplot.ts's grouped boxes.
      const groups = groupRowsByField(ctx, rows, color.splitField, color.domain);
      // Every group reserves a dodge slot (groupCount = groups.length) so the
      // side-by-side positions stay stable even when a group is empty in some
      // categories.
      const groupCount = groups.length;
      groups.forEach((group, gi) => {
        const groupColor = groupColorAt(gi);
        const intervals = intervalsForRows(group.rows);
        let rendered = false;
        categoryAxis.categories!.forEach((category, index) => {
          const interval = intervals[index];
          if (!interval) {
            return;
          }
          rendered = true;
          items.push({
            category,
            center: interval.mean,
            lower: interval.lower,
            upper: interval.upper,
            color: groupColor,
            groupIndex: gi,
            groupCount,
          });
        });
        // Only legend a group that actually drew at least one interval — mirrors
        // the errorband branch below (a swatch with nothing drawn is misleading).
        if (rendered) {
          overlayLegend.push({ label: formatLegendLabel(group.value), color: groupColor });
        }
      });
    } else {
      const intervals = intervalsForRows(rows);
      categoryAxis!.categories!.forEach((category, index) => {
        const interval = intervals[index];
        if (!interval) {
          return;
        }
        items.push({
          category,
          center: interval.mean,
          lower: interval.lower,
          upper: interval.upper,
          color: staticColor,
        });
      });
    }

    if (items.length === 0) {
      gaps.add({
        code: 'mark:errorbar-no-data',
        message:
          'No category group had enough rows to compute an interval for the requested extent (e.g. "stdev"/"stderr"/"ci" need at least two values per category); no error bars were rendered.',
        severity: 'unsupported',
        path,
      });
      return { series: [], plots: [] };
    }
    addOverlayGap();
    const overlay: CompiledOverlay = { kind: 'errorBars', orientation, items };
    return {
      series: [],
      plots: [],
      overlays: [overlay],
      ...(overlayLegend.length > 0 ? { overlayLegend } : {}),
    };
  }

  // errorband: the category-axis order (x for vertical, y for horizontal —
  // `categoryAxis` already picks the right one above) provides the band's
  // path order. `point.x` carries the category value regardless of
  // orientation; the `horizontal` flag on the overlay tells the renderer to
  // transpose (draw the category on the y axis, lower/upper on x).
  /**
   * Builds the band points for one set of rows: the ordinary per-category
   * case (empty when no category had enough data), or — in "global"/1D mode
   * — a single flat 2-point span across the whole continuous domain at one
   * combined interval computed from every row in `groupRows`.
   */
  const pointsForRows = (groupRows: readonly DatasetRow[]): OverlayBandPoint[] => {
    if (globalBandActive) {
      const values = groupRows
        .map((row) => toNumber(row[valueField!]))
        .filter((value): value is number => value !== null);
      const interval = computeInterval(values, extent);
      if (!interval) {
        return [];
      }
      const [start, end] = spanExtent!;
      return [
        { x: start, lower: interval.lower, upper: interval.upper },
        { x: end, lower: interval.lower, upper: interval.upper },
      ];
    }
    const intervals = intervalsForRows(groupRows);
    const points: OverlayBandPoint[] = [];
    categoryAxis.categories!.forEach((category, index) => {
      const interval = intervals[index];
      if (!interval) {
        return;
      }
      points.push({ x: category, lower: interval.lower, upper: interval.upper });
    });
    return points;
  };

  if (color.splitField) {
    // A color-field split draws one band per color group. Unlike dodged error
    // bars, bands are continuous filled areas: Vega-Lite overlays one
    // semi-transparent band per group (they can overlap) rather than dodging
    // them side-by-side, so each group becomes its own `band` overlay.
    const groups = groupRowsByField(ctx, rows, color.splitField, color.domain);
    const overlays: CompiledOverlay[] = [];
    const overlayLegend: OverlayLegendItem[] = [];
    groups.forEach((group, gi) => {
      const points = pointsForRows(group.rows);
      if (points.length === 0) {
        return;
      }
      const groupColor = groupColorAt(gi);
      overlayLegend.push({ label: formatLegendLabel(group.value), color: groupColor });
      overlays.push({
        kind: 'band',
        points,
        color: groupColor,
        opacity: 0.3,
        ...(horizontal ? { orientation: 'horizontal' as const } : {}),
      });
    });
    if (overlays.length === 0) {
      gaps.add({
        code: 'mark:errorband-no-data',
        message:
          'No category group had enough rows to compute an interval for the requested extent; no error band was rendered.',
        severity: 'unsupported',
        path,
      });
      return { series: [], plots: [] };
    }
    addOverlayGap();
    return {
      series: [],
      plots: [],
      overlays,
      ...(overlayLegend.length > 0 ? { overlayLegend } : {}),
    };
  }

  const points = pointsForRows(rows);
  if (points.length === 0) {
    gaps.add({
      code: 'mark:errorband-no-data',
      message:
        'No category group had enough rows to compute an interval for the requested extent; no error band was rendered.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }
  const overlay: CompiledOverlay = {
    kind: 'band',
    points,
    color: staticColor,
    opacity: 0.3,
    ...(horizontal ? { orientation: 'horizontal' as const } : {}),
  };
  addOverlayGap();
  return { series: [], plots: [], overlays: [overlay] };
}
