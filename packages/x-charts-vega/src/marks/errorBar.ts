import type {
  AxisResolution,
  CompiledOverlay,
  CompiledUnit,
  OverlayBandPoint,
  OverlayErrorBarItem,
  UnitContext,
} from '../compile/context';
import { resolveColor } from '../compile/color';
import { toDate, toNumber } from '../compile/fieldTypes';
import { evaluateAggregate } from '../transforms/aggregateOps';
import type { DatasetRow, VegaChannelDef, VegaMarkDef } from '../types';
import { isFieldDef } from '../types';

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
 *   center=mean); errorband → band overlay points sorted by x;
 * - both orientations for errorbar; errorband is x-ordered only (transposed
 *   band → 'partial' gap);
 * - color from static mark/value color; color-field split → 'partial' gap;
 * - these marks are usually LAYERED with line/point marks — the pipeline
 *   already flattens layers, nothing special needed;
 * - return { series: [], plots: [], overlays: [...] }.
 */

type ErrorExtent = 'stderr' | 'stdev' | 'ci' | 'iqr';

function fieldOf(def: VegaChannelDef | undefined): string | undefined {
  return def && isFieldDef(def) ? def.field : undefined;
}

/** Whether this unit is drawn with the category on the y axis: explicit `mark.orient`, else inferred from which channel resolved to a discrete axis (mirrors bar.ts's resolveOrientation). */
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

export function compileErrorBarMark(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const mark = unit.mark;
  const path = unit.path;
  const markType = mark.type as 'errorbar' | 'errorband';

  const orientation = resolveOrientation(ctx);
  const horizontal = orientation === 'horizontal';
  const categoryAxis = horizontal ? ctx.y : ctx.x;
  const valueAxis = horizontal ? ctx.x : ctx.y;
  const valueChannelDef = horizontal ? encoding.x : encoding.y;
  const valueField = fieldOf(valueChannelDef);
  const categoryField = categoryAxis?.field;

  if (
    !categoryAxis?.categories ||
    !categoryField ||
    !valueField ||
    valueAxis?.fieldType !== 'quantitative'
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
  if (color.splitField) {
    gaps.add({
      code: 'mark:errorbar-color-split',
      message:
        'A color-field encoding on an errorbar/errorband mark would draw one interval per category per color group; this wrapper renders a single interval per category instead, so the color split is dropped.',
      severity: 'partial',
      path: `${path}.encoding.color`,
    });
  }
  const staticColor = color.staticColor ?? mark.color;

  const groups = groupValuesByCategory(ctx, rows, categoryAxis, categoryField, valueField);
  const intervals = groups.map((values) => computeInterval(values, extent));

  if (markType === 'errorbar') {
    const items: OverlayErrorBarItem[] = [];
    categoryAxis.categories.forEach((category, index) => {
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
    const overlay: CompiledOverlay = { kind: 'errorBars', orientation, items };
    return { series: [], plots: [], overlays: [overlay] };
  }

  // errorband: only supported x-ordered (category on the x axis, the default
  // Vega-Lite orientation) — a transposed (categorical-y) band has no
  // supported path direction in this wrapper.
  if (horizontal) {
    gaps.add({
      code: 'mark:errorband-transposed',
      message:
        "errorband is only supported with the category on the x axis (Vega-Lite's default orientation for this mark); a transposed (categorical-y) errorband has no supported band-path direction in this wrapper and was dropped.",
      severity: 'partial',
      path,
    });
    return { series: [], plots: [] };
  }

  const points: OverlayBandPoint[] = [];
  categoryAxis.categories.forEach((category, index) => {
    const interval = intervals[index];
    if (!interval) {
      return;
    }
    points.push({ x: category, lower: interval.lower, upper: interval.upper });
  });
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
  };
  return { series: [], plots: [], overlays: [overlay] };
}
