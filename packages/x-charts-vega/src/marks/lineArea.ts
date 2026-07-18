import type { CurveType } from '@mui/x-charts/models';
import type {
  CompiledGradient,
  CompiledOverlay,
  CompiledSeries,
  CompiledUnit,
  OverlaySegment,
  PlotKind,
  UnitContext,
} from '../compile/context';
import { color as d3Color } from '@mui/x-charts-vendor/d3-color';
import { resolveColor } from '../compile/color';
import { applyAlpha } from '../compile/colorUtils';
import { toDate, toNumber } from '../compile/fieldTypes';
import type { DatasetRow, VegaFieldDef } from '../types';
import { isFieldDef } from '../types';

/*
 * OWNERSHIP: the "line & area marks" work unit owns this file.
 *
 * Translates `line`, `area`, and `trail` marks to x-charts `type: 'line'`
 * series. See the module-level comment history (git blame) for the full
 * design brief; the short version:
 * - `area` → `area: true` + plots `['area', 'line']`; `line` → `['line']`;
 *   `trail` → treated as `line` + a `partial` gap (stroke-width-by-field is
 *   unsupported).
 * - series `data` is index-aligned to `ctx.x.categories`; missing cells are
 *   `null`. This holds for every axis shape the wrapper produces: band/point
 *   (nominal/ordinal, or a forced-discrete temporal channel) AND the
 *   continuous `scaleType: 'time'` axis — x-charts positions line/area points
 *   by indexing into `xAxis.data` (the ordered Date[]), so `categories` stays
 *   populated on the time-scale path and no functional change is needed here.
 * - color-field splitting into one series per group via `resolveColor`;
 *   static color via `staticColor`/`mark.color`/`mark.stroke`.
 * - `mark.interpolate` → series `curve`, exact mapping where one exists,
 *   closest `CurveType` + `partial` gap otherwise.
 * - `mark.point` → `showMark` + the shell's `MarkPlot`; point styling
 *   objects are `ignored`.
 * - stacking on the y field def's `stack`; area + color split defaults to
 *   `'zero'` per Vega-Lite; lines default to unstacked.
 * - `mark.strokeWidth`/`strokeDash` are wired onto the produced line series via
 *   an `sx` that targets the series' `.MuiLineElement-root[data-series-id=…]`
 *   (x-charts stamps `data-series-id` on each line path). Static opacity
 *   (`mark.opacity`/`fillOpacity`/value-def `opacity`) is handled centrally in
 *   `compile/index.ts` — it's baked into the resolved series color — so this
 *   compiler no longer reports an opacity gap.
 * - `connectNulls` is always `false` (Vega-Lite's default invalid-value
 *   behavior breaks the line at gaps); `impute` is reported `unsupported`.
 */

const CURVE_MAP: Partial<Record<string, CurveType>> = {
  linear: 'linear',
  monotone: 'monotoneX',
  natural: 'natural',
  step: 'step',
  'step-before': 'stepBefore',
  'step-after': 'stepAfter',
};

/** Curve families with no exact x-charts equivalent — approximated. */
const APPROXIMATE_CURVE_MAP: Partial<Record<string, CurveType>> = {
  basis: 'catmullRom',
  bundle: 'catmullRom',
  cardinal: 'catmullRom',
  'catmull-rom': 'catmullRom',
};

function resolveCurve(interpolate: string | undefined, ctx: UnitContext, path: string): CurveType {
  const value = interpolate ?? 'linear';
  const exact = CURVE_MAP[value];
  if (exact) {
    return exact;
  }
  const approximate = APPROXIMATE_CURVE_MAP[value];
  if (approximate) {
    ctx.gaps.add({
      code: 'mark:interpolate-approximate',
      message: `Vega-Lite interpolate "${value}" has no exact x-charts curve equivalent; approximated with the closest available curve ("${approximate}").`,
      severity: 'partial',
      path,
    });
    return approximate;
  }
  ctx.gaps.add({
    code: 'mark:interpolate-unsupported',
    message: `Vega-Lite interpolate "${value}" is not recognized by this wrapper; falling back to a straight-line curve.`,
    severity: 'partial',
    path,
  });
  return 'linear';
}

interface StackConfig {
  stack?: string;
  stackOffset?: 'none' | 'expand' | 'silhouette';
  stackOrder?: 'reverse';
}

/**
 * Maps a Vega-Lite `stack` field-def value to x-charts stack props, sharing
 * `stackId` across the layer's series. Vega-Lite stacks in *descending* order
 * of the color field's value, so the first legend/domain category ends up at
 * the top of the stack. x-charts stacks the first series at the bottom, so when
 * the series follow an ascending (derived) color domain, `stackOrder: 'reverse'`
 * reproduces Vega's geometry exactly. For an explicit, custom-ordered domain
 * reversing does not correspond to Vega's value sort, so it is left off (the
 * caller reports the residual difference as a gap).
 */
function resolveStack(stackSetting: unknown, stackId: string, reverseStack: boolean): StackConfig {
  const order = reverseStack ? ('reverse' as const) : undefined;
  if (stackSetting === 'zero' || stackSetting === true) {
    return { stack: stackId, stackOffset: 'none', stackOrder: order };
  }
  if (stackSetting === 'normalize') {
    return { stack: stackId, stackOffset: 'expand', stackOrder: order };
  }
  if (stackSetting === 'center') {
    return { stack: stackId, stackOffset: 'silhouette', stackOrder: order };
  }
  // `null`/`false`/anything else opts out of stacking.
  return {};
}

/** The stack setting to use for the y field def, honoring Vega-Lite's default of stacking areas that split by color. */
function computeStackSetting(
  yDef: VegaFieldDef | undefined,
  markType: string,
  hasColorSplit: boolean,
): unknown {
  if (yDef?.stack !== undefined) {
    return yDef.stack;
  }
  if (markType === 'area' && hasColorSplit) {
    return 'zero';
  }
  return undefined;
}

/** Formats a color-group value for a series legend label, using a locale date string for temporal groups. */
function formatGroupLabel(value: unknown): string {
  if (value instanceof Date) {
    return value.toLocaleDateString();
  }
  return String(value);
}

/**
 * The legend label for a constant `color: {datum: value}` encoding (as `repeat`
 * layers produce, one datum per layer). Each such line is its own layer with a
 * single constant color, so Vega-Lite shows one legend entry per datum; giving
 * the series that label makes the shell draw the legend (and x-charts assigns
 * each layer's line the next palette color, matching the datum domain order).
 */
function colorDatumLabel(colorDef: unknown): string | undefined {
  if (colorDef && typeof colorDef === 'object' && !Array.isArray(colorDef)) {
    const datum = (colorDef as { datum?: unknown }).datum;
    if (datum != null && (typeof datum === 'string' || typeof datum === 'number')) {
      return String(datum);
    }
  }
  return undefined;
}

interface ContinuousPoint {
  x: number;
  y: number;
}

interface ContinuousGroups {
  /** The color-split field, or `undefined` for a single implicit group. */
  colorField: string | undefined;
  /** First-appearance order of the group keys. */
  order: string[];
  /** Numeric (x, y) points bucketed by color-group key. */
  groups: Map<string, ContinuousPoint[]>;
}

/**
 * Buckets rows into per-color-group numeric (x, y) points, dropping any row
 * whose x or y isn't a finite number. Shared by the continuous-x line and area
 * overlay builders (both need the same grouping, only the drawn shape differs).
 */
/**
 * Colors the continuous-x line/area groups by the color scale's resolved range
 * (so a `scheme`/`range` — e.g. the CO2 chart's `magma` — wins over the default
 * palette), indexed by each group's position in the color domain. Falls back to
 * the chart palette when the scale gives no range.
 */
function continuousGroupColor(
  ctx: UnitContext,
  colorField: string | undefined,
): (key: string, groupIndex: number) => string {
  const { palette } = ctx;
  if (!colorField) {
    return (_key, groupIndex) => palette[groupIndex % palette.length];
  }
  const colorRes = resolveColor(ctx.encoding, ctx.rows, ctx.gaps, ctx.unit.path);
  return (key, groupIndex) => {
    if (colorRes.range && colorRes.range.length > 0) {
      const domainIndex = colorRes.domain
        ? colorRes.domain.findIndex((value) => String(value) === key)
        : -1;
      const index = domainIndex >= 0 ? domainIndex : groupIndex;
      return colorRes.range[index % colorRes.range.length];
    }
    return palette[groupIndex % palette.length];
  };
}

function groupContinuousPoints(ctx: UnitContext, xField: string, yField: string): ContinuousGroups {
  const { rows, encoding } = ctx;
  const colorDef = [encoding.color, encoding.fill, encoding.stroke].find((def) =>
    isFieldDef(def),
  ) as VegaFieldDef | undefined;
  const colorField = colorDef?.field;

  const groups = new Map<string, ContinuousPoint[]>();
  const order: string[] = [];
  rows.forEach((row) => {
    const xv = toNumber(row[xField]);
    const yv = toNumber(row[yField]);
    if (xv == null || yv == null || Number.isNaN(xv) || Number.isNaN(yv)) {
      return;
    }
    const key = colorField ? String(row[colorField]) : '';
    let points = groups.get(key);
    if (!points) {
      points = [];
      groups.set(key, points);
      order.push(key);
    }
    points.push({ x: xv, y: yv });
  });

  return { colorField, order, groups };
}

/**
 * Resolves a mark `color`/`fill`/`stroke` value to a solid color string.
 * Vega-Lite also allows a gradient object (`{gradient, stops}`) here, but
 * x-charts fills/strokes are solid — so a gradient is approximated by its
 * highest-offset (typically most saturated) stop color and an `ignored` gap is
 * recorded, rather than silently dropping it and falling back to the palette.
 */
function resolveMarkColor(
  value: unknown,
  gaps: UnitContext['gaps'],
  path: string,
): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    'gradient' in value &&
    Array.isArray((value as { stops?: unknown }).stops)
  ) {
    const stops = (
      value as unknown as { stops: Array<{ offset?: number; color?: unknown }> }
    ).stops.filter((stop) => typeof stop.color === 'string');
    gaps.add({
      code: 'mark:gradient-fill',
      message:
        'A gradient `mark.color`/`fill` is not supported — x-charts line/area fills are a single ' +
        'solid color. The gradient is approximated by its last color stop; use a solid `color`/`fill` ' +
        'for an exact match.',
      severity: 'ignored',
      path: `${path}.mark`,
    });
    if (stops.length === 0) {
      return undefined;
    }
    const last = stops.reduce((best, stop) =>
      (stop.offset ?? 0) >= (best.offset ?? 0) ? stop : best,
    );
    return last.color as string;
  }
  return undefined;
}

/**
 * Reads a Vega-Lite gradient fill object (`{gradient: 'linear', x1, y1, x2, y2,
 * stops}`) into a `CompiledGradient` the shell renders as an SVG
 * `<linearGradient>`. Vega-Lite's gradient coordinates are already in
 * objectBoundingBox units (0–1), so they map straight through. Returns
 * `undefined` for a solid color or an unsupported/empty gradient.
 */
function buildMarkGradient(value: unknown, path: string): CompiledGradient | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    (value as { gradient?: unknown }).gradient !== 'linear' ||
    !Array.isArray((value as { stops?: unknown }).stops)
  ) {
    return undefined;
  }
  const raw = value as {
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
    stops: Array<{ offset?: number; color?: unknown }>;
  };
  const stops = raw.stops
    .filter((stop) => typeof stop.color === 'string')
    .map((stop) => ({
      offset: typeof stop.offset === 'number' ? stop.offset : 0,
      color: stop.color as string,
    }));
  if (stops.length === 0) {
    return undefined;
  }
  // Vega-Lite's own gradient examples often fade to a literal "white" stop —
  // an aesthetic trick that only reads as "fading to nothing" against a plain
  // white page. The wrapper renders inside themed cards (including dark
  // mode), where that stop would instead paint an opaque white patch over
  // whatever the fill sits on. Reinterpret a pure-white, fully-opaque stop as
  // a transparent version of the nearest solid stop instead, so it fades
  // to transparent — a true alpha gradient that fades correctly on any
  // background, matching the reference's apparent intent rather than its
  // literal (white-page-only) color value.
  const isOpaqueWhite = (input: string): boolean => {
    const parsed = d3Color(input);
    return parsed !== null && parsed.opacity === 1 && parsed.formatHex() === '#ffffff';
  };
  const solidStops = stops.filter((stop) => !isOpaqueWhite(stop.color));
  const adjustedStops = stops.map((stop) => {
    if (!isOpaqueWhite(stop.color) || solidStops.length === 0) {
      return stop;
    }
    const nearest = solidStops.reduce((best, candidate) =>
      Math.abs(candidate.offset - stop.offset) < Math.abs(best.offset - stop.offset)
        ? candidate
        : best,
    );
    return { offset: stop.offset, color: applyAlpha(nearest.color, 0) };
  });
  return {
    // A stable, SVG-id-safe id per layer so the same spec re-renders identically.
    id: `vega-grad-${path.replace(/[^a-zA-Z0-9]/g, '-')}`,
    // Vega-Lite defaults a linear gradient to a top→bottom sweep (x1=x2=0, y1=0, y2=1).
    x1: raw.x1 ?? 0,
    y1: raw.y1 ?? 0,
    x2: raw.x2 ?? 0,
    y2: raw.y2 ?? 1,
    stops: adjustedStops,
  };
}

/**
 * Builds a polyline (segments overlay) for a `line`/`trail` mark whose x is a
 * continuous quantitative axis — the one axis shape with no index-aligned
 * category domain to hang an x-charts line series on. Each color group becomes
 * one x-sorted polyline; endpoints are data-space and get positioned by the
 * continuous x/y scales at render time. Returns `null` when fewer than two
 * numeric points survive (nothing to connect).
 */
function buildContinuousLineOverlay(
  ctx: UnitContext,
  xField: string,
  yField: string,
): CompiledOverlay | null {
  const { palette } = ctx;
  const mark = ctx.unit.mark;
  const { colorField, order, groups } = groupContinuousPoints(ctx, xField, yField);
  const staticStroke = resolveMarkColor(mark.color ?? mark.stroke, ctx.gaps, ctx.unit.path);
  const groupColorAt = continuousGroupColor(ctx, colorField);

  const items: OverlaySegment[] = [];
  order.forEach((key, groupIndex) => {
    const color = colorField ? groupColorAt(key, groupIndex) : (staticStroke ?? palette[0]);
    const points = groups
      .get(key)!
      .slice()
      .sort((a, b) => a.x - b.x);
    for (let i = 0; i < points.length - 1; i += 1) {
      items.push({
        x1: points[i].x,
        y1: points[i].y,
        x2: points[i + 1].x,
        y2: points[i + 1].y,
        style: { stroke: color, strokeWidth: 2 },
      });
    }
  });

  return items.length > 0 ? { kind: 'segments', items } : null;
}

/**
 * Builds one filled band overlay per color group for an `area` mark whose x is
 * a continuous quantitative axis (the axis shape with no index-aligned category
 * domain for an x-charts area series). Each band traces the y value as its upper
 * edge and the zero baseline as its lower edge, x-sorted; positions are
 * data-space and get scaled at render time. Groups with fewer than two points
 * (nothing to fill) are skipped; returns an empty array when none survive.
 */
function buildContinuousAreaOverlay(
  ctx: UnitContext,
  xField: string,
  yField: string,
): CompiledOverlay[] {
  const { palette } = ctx;
  const mark = ctx.unit.mark;
  const { colorField, order, groups } = groupContinuousPoints(ctx, xField, yField);
  const groupColorAt = continuousGroupColor(ctx, colorField);
  const staticFill = resolveMarkColor(
    mark.fill ?? mark.color ?? mark.stroke,
    ctx.gaps,
    ctx.unit.path,
  );
  // A Vega-Lite area is drawn SOLID (fillOpacity 1) — unlike a CI error *band*,
  // which shares this overlay but wants the renderer's translucent 0.3 default.
  // Set the opacity explicitly here so the area fills solid, honoring an explicit
  // `fillOpacity`/`opacity` on the mark.
  const markFillOpacity = (mark as { fillOpacity?: unknown }).fillOpacity;
  const fillOpacity =
    typeof markFillOpacity === 'number'
      ? markFillOpacity
      : typeof mark.opacity === 'number'
        ? mark.opacity
        : 1;

  const overlays: CompiledOverlay[] = [];
  order.forEach((key, groupIndex) => {
    const points = groups
      .get(key)!
      .slice()
      .sort((a, b) => a.x - b.x);
    if (points.length < 2) {
      return;
    }
    const color = colorField ? groupColorAt(key, groupIndex) : (staticFill ?? palette[0]);
    overlays.push({
      kind: 'band',
      orientation: 'vertical',
      color,
      opacity: fillOpacity,
      points: points.map((point) => ({ x: point.x, lower: 0, upper: point.y })),
    });
  });

  return overlays;
}

/**
 * Builds a single closed, filled polygon overlay for a `line`/`trail` mark
 * whose `interpolate` is `"linear-closed"` — Vega-Lite's convention for a
 * hand-drawn filled shape (e.g. a ternary plot's background wedges), as
 * opposed to an ordinary polyline. Points are kept in row order and the path
 * always closes back to the first point; unlike the plain continuous-x line
 * overlay above, they must NOT be sorted by x — the row order IS the polygon's
 * vertex order. Returns `null` when fewer than 3 numeric points survive
 * (nothing to fill).
 */
function buildClosedPolygonOverlay(
  ctx: UnitContext,
  xField: string,
  yField: string,
): CompiledOverlay | null {
  const mark = ctx.unit.mark;
  const points: Array<{ x: number; y: number }> = [];
  ctx.rows.forEach((row) => {
    const xv = toNumber(row[xField]);
    const yv = toNumber(row[yField]);
    if (xv == null || yv == null || Number.isNaN(xv) || Number.isNaN(yv)) {
      return;
    }
    points.push({ x: xv, y: yv });
  });
  if (points.length < 3) {
    return null;
  }

  const fill = resolveMarkColor(mark.fill ?? mark.color, ctx.gaps, ctx.unit.path);
  const stroke = resolveMarkColor(mark.stroke ?? mark.color, ctx.gaps, ctx.unit.path) ?? fill;
  const markFillOpacity = (mark as { fillOpacity?: unknown }).fillOpacity;
  let fillOpacity = 1;
  if (typeof markFillOpacity === 'number') {
    fillOpacity = markFillOpacity;
  } else if (typeof mark.opacity === 'number') {
    fillOpacity = mark.opacity;
  }

  return {
    kind: 'polygon',
    points,
    fill,
    fillOpacity,
    stroke,
    strokeWidth: typeof mark.strokeWidth === 'number' ? mark.strokeWidth : 1,
  };
}

export function compileLineAreaMark(ctx: UnitContext): CompiledUnit {
  const { unit, rows, encoding, x, gaps } = ctx;
  const path = unit.path;
  const mark = unit.mark;
  const markType = mark.type as 'line' | 'area' | 'trail';

  const yDef = isFieldDef(encoding.y) ? (encoding.y as VegaFieldDef) : undefined;
  const yField = yDef?.field;
  const xField = x?.field;

  if ((markType === 'line' || markType === 'trail') && mark.interpolate === 'linear-closed') {
    const overlay = xField && yField ? buildClosedPolygonOverlay(ctx, xField, yField) : null;
    if (overlay) {
      gaps.add({
        code: 'mark:line-closed-polygon-custom-overlay',
        message:
          'A `line`/`trail` mark with `interpolate: "linear-closed"` draws a closed, filled polygon in Vega-Lite; x-charts has no such series, so this wrapper draws it via a custom SVG overlay instead.',
        severity: 'ignored',
        path,
      });
      return { series: [], plots: [], overlays: [overlay] };
    }
  }

  if (!x || !x.categories || !x.categoryKeys) {
    // Continuous *quantitative* x has no index-aligned category domain for an
    // x-charts line/area series (a temporal x doesn't reach here — the
    // continuous `scaleType: 'time'` path still populates
    // `categories`/`categoryKeys`, see scales.ts). We render the layer as an
    // overlay instead of dropping it: `line`/`trail` as a polyline (segments),
    // `area` as one filled band per color group.
    const contXField = x?.field;
    if ((markType === 'line' || markType === 'trail') && contXField && yField) {
      const overlay = buildContinuousLineOverlay(ctx, contXField, yField);
      if (overlay) {
        gaps.add({
          code: 'mark:line-continuous-x-custom-overlay',
          message:
            'x-charts has no line/trail series over a continuous quantitative x axis; the polyline is drawn by a custom SVG overlay instead.',
          severity: 'ignored',
          path,
        });
        return { series: [], plots: [], overlays: [overlay] };
      }
    }
    if (markType === 'area' && contXField && yField) {
      const overlays = buildContinuousAreaOverlay(ctx, contXField, yField);
      if (overlays.length > 0) {
        gaps.add({
          code: 'mark:area-continuous-x-custom-overlay',
          message:
            'x-charts has no area series over a continuous quantitative x axis; the filled band is drawn by a custom SVG overlay instead.',
          severity: 'ignored',
          path,
        });
        return { series: [], plots: [], overlays };
      }
    }
    gaps.add({
      code: 'mark:line-continuous-x',
      message:
        'A line/area/trail mark over a continuous quantitative x axis needs numeric `x` and `y` field values on at least two rows to draw a polyline or band; none survived, so the layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  if (!yField || !xField) {
    gaps.add({
      code: 'mark:line-missing-field',
      message:
        'Line/area marks require both `x` and `y` to be field encodings; the layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  const categories = x.categories;

  // Point overlays.
  const markPoint = mark.point;
  const showMark = Boolean(markPoint);
  if (markPoint && typeof markPoint === 'object') {
    gaps.add({
      code: 'mark:point-styling',
      message:
        'Custom `mark.point` styling (size/shape/fill of overlay points) is not supported; overlay points render with the series default marker instead.',
      severity: 'ignored',
      path: `${path}.mark.point`,
    });
  }
  if (markPoint === 'transparent') {
    gaps.add({
      code: 'mark:point-transparent',
      message:
        '`mark.point: "transparent"` marks invisible interaction-only points in Vega-Lite; x-charts has no invisible-marker mode, so this wrapper renders regular visible markers instead.',
      severity: 'partial',
      path: `${path}.mark.point`,
    });
  }

  const curve = resolveCurve(
    typeof mark.interpolate === 'string' ? mark.interpolate : undefined,
    ctx,
    `${path}.mark.interpolate`,
  );

  if (markType === 'trail') {
    gaps.add({
      code: 'mark:trail-width',
      message:
        'The `trail` mark varies stroke width by a data field; x-charts line series render with a uniform stroke width, so the width variation is dropped (rendered as a plain line).',
      severity: 'partial',
      path,
    });
  }

  // `mark.strokeWidth`/`strokeDash` are wired onto each produced series via an
  // `sx` targeting its line path (see below). Constant opacity is applied
  // centrally in compile/index.ts (baked into the series color), so no opacity
  // gap is reported here.
  const strokeStyle: Record<string, number | string> = {};
  if (typeof mark.strokeWidth === 'number') {
    strokeStyle.strokeWidth = mark.strokeWidth;
  }
  if (Array.isArray(mark.strokeDash) && mark.strokeDash.length > 0) {
    // NOTE: x-charts animates a line's `stroke-dasharray` to reveal the path,
    // so this dash pattern is honored on non-animated marks but can be overridden
    // by the line draw-animation on a plain line series (see GAPS.md).
    strokeStyle.strokeDasharray = mark.strokeDash.join(' ');
  }
  // An `area` mark's optional drawn line can carry its own style
  // (`mark.line: {color, …}`), independent of `mark.color`/`fill` — the fill.
  // x-charts has a single series `color` shared by both the line stroke and the
  // area fill, so without this override a gradient fill (which sets `color` to
  // `url(#…)` below) would also paint the line's stroke with the gradient
  // instead of the distinct solid color the spec asks for.
  const markLine = mark.line;
  if (
    markLine &&
    typeof markLine === 'object' &&
    typeof (markLine as { color?: unknown }).color === 'string'
  ) {
    strokeStyle.stroke = (markLine as { color: string }).color;
  }
  const hasStrokeStyle = Object.keys(strokeStyle).length > 0;

  // `mark.opacity`/`fillOpacity` (and value-def `opacity`) are baked into the
  // series color centrally (see `staticMarkOpacity` in compile/index.ts). A
  // separate stroke alpha (`strokeOpacity`) has no equivalent on that single
  // color, so — mirroring point.ts — it stays an ignored gap.
  if (mark.strokeOpacity !== undefined) {
    gaps.add({
      code: 'encoding:opacity',
      message:
        'x-charts line/area series have a single color with no separate stroke alpha; ' +
        '"strokeOpacity" on the mark is ignored (mark/fill opacity IS applied via the series color).',
      severity: 'ignored',
      path: `${path}.mark.strokeOpacity`,
    });
  }

  const xImpute = isFieldDef(encoding.x) ? (encoding.x as VegaFieldDef).impute : undefined;
  if (yDef?.impute !== undefined || xImpute !== undefined) {
    gaps.add({
      code: 'encoding:impute',
      message:
        'Value imputation (`impute`) for missing data points is not implemented; missing cells remain gaps in the line/area instead of being filled or interpolated.',
      severity: 'unsupported',
      path: `${path}.encoding.y.impute`,
    });
  }

  const plots = new Set<PlotKind>();
  if (markType === 'area') {
    plots.add('area');
    plots.add('line');
  } else {
    plots.add('line');
  }
  if (showMark) {
    plots.add('marks');
  }

  const colorRes = resolveColor(encoding, rows, gaps, path);
  const splitField = colorRes.splitField;
  const stackId = `${path}:stack`;
  const stackSetting = computeStackSetting(yDef, markType, Boolean(splitField));
  // Mirror resolveStack: only these settings actually stack (a line's default
  // `undefined` does not), so the reversal/gap logic below never fires for an
  // unstacked layer.
  const willStack =
    Boolean(splitField) &&
    (stackSetting === 'zero' ||
      stackSetting === true ||
      stackSetting === 'normalize' ||
      stackSetting === 'center');
  // Reverse the stack draw order only for an ascending, data-derived color
  // domain, where it reproduces Vega-Lite's descending-by-value stack sort. An
  // explicit, custom-ordered domain can't be matched this way (x-charts ties
  // stack order to series/legend order), so leave it natural and report it.
  const reverseStack = willStack && colorRes.domainDerived === true;
  if (willStack && colorRes.domain && colorRes.domainDerived !== true) {
    gaps.add({
      code: 'mark:stack-order-explicit-domain',
      message:
        'Vega-Lite stacks segments in descending order of the color value; with an explicit `scale.domain` x-charts cannot decouple stack order from the legend order, so the vertical stacking sequence may differ from the reference. Colors and totals are unaffected.',
      severity: 'partial',
      path: `${path}.encoding.color.scale.domain`,
    });
  }
  const stackMode = resolveStack(stackSetting, stackId, reverseStack);

  // One implicit, unfiltered group when there's no color split; otherwise one
  // group per distinct color-field value — explicit `domain` order first
  // (paired with the matching `range` color), then first-appearance order for
  // any values outside the domain.
  const SINGLE_GROUP_KEY = '__single__';
  const gradients: CompiledGradient[] = [];
  const groups: Array<{ key: string; label?: string; color?: string }> = [];
  if (splitField) {
    const seenGroups = new Set<string>();
    const addGroup = (value: unknown, color?: string) => {
      const key = ctx.categoryKey(value);
      if (seenGroups.has(key)) {
        return;
      }
      seenGroups.add(key);
      groups.push({
        key,
        label: colorRes.hasLegend ? formatGroupLabel(value) : undefined,
        color,
      });
    };
    const colorRange = colorRes.range;
    colorRes.domain?.forEach((value, index) =>
      addGroup(
        value,
        colorRange && colorRange.length > 0 ? colorRange[index % colorRange.length] : undefined,
      ),
    );
    for (const row of rows) {
      const value = row[splitField];
      if (value != null) {
        addGroup(value);
      }
    }
  } else {
    // An area's fill can be a linear gradient (`mark.color`/`fill` gradient
    // object); render it as an SVG gradient rather than flattening to one stop.
    const areaFillValue = mark.fill ?? mark.color ?? mark.stroke;
    const gradient =
      markType === 'area' && colorRes.staticColor == null
        ? buildMarkGradient(areaFillValue, path)
        : undefined;
    if (gradient) {
      gradients.push(gradient);
    }
    const staticColor = gradient
      ? `url(#${gradient.id})`
      : (colorRes.staticColor ??
        resolveMarkColor(
          markType === 'area' ? areaFillValue : (mark.stroke ?? mark.color ?? mark.fill),
          gaps,
          path,
        ));
    groups.push({
      key: SINGLE_GROUP_KEY,
      // A constant `color: {datum: …}` (per-layer color, as `repeat` layers use)
      // labels this line so the shell surfaces a legend entry for it.
      label: colorDatumLabel(encoding.color),
      color: staticColor,
    });
  }

  // Bucket rows by group in a single pass over `rows` (rather than rescanning
  // all rows once per group), then build each series from its own bucket.
  const rowsByGroup = new Map<string, DatasetRow[]>();
  for (const row of rows) {
    const key = splitField ? ctx.categoryKey(row[splitField]) : SINGLE_GROUP_KEY;
    const bucket = rowsByGroup.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      rowsByGroup.set(key, [row]);
    }
  }

  const series: CompiledSeries[] = groups.map((group) => {
    const data: Array<number | null> = new Array(categories.length).fill(null);
    for (const row of rowsByGroup.get(group.key) ?? []) {
      // Temporal axis categories are Date objects (see scales.ts) — on both the
      // continuous `scaleType: 'time'` path and the discrete fallback — so the
      // raw row value (often an ISO string) must be coerced before the lookup,
      // same as point.ts's resolveAxisValue.
      const rawX = x.fieldType === 'temporal' ? toDate(row[xField]) : row[xField];
      const idx = ctx.categoryIndex(x, rawX);
      if (idx === -1) {
        continue;
      }
      data[idx] = toNumber(row[yField]);
    }
    const id = `${path}:${group.key}`;
    return {
      type: 'line',
      id,
      label: group.label,
      data,
      area: markType === 'area',
      curve,
      showMark,
      connectNulls: false,
      color: group.color,
      // Vega-Lite's default legend symbol depends on the mark: a `line` (or
      // `trail`) mark defaults to a short stroke swatch (x-charts' own 'line'
      // default already matches), but an `area` mark defaults to a filled
      // circle (`defaultSymbolType` in vega-lite's legend/properties.ts) —
      // x-charts otherwise renders every line-family series with the same
      // stroke swatch, so area series need this override to match.
      ...(markType === 'area' ? { labelMarkType: 'circle' } : {}),
      ...stackMode,
      // Stroke width/dash have no dedicated x-charts line-series prop, so style
      // the series' own line path by id. x-charts stamps `data-series-id` on
      // each `.MuiLineElement-root`, letting one series' `sx` scope to it.
      ...(hasStrokeStyle
        ? { sx: { [`.MuiLineElement-root[data-series-id="${id}"]`]: strokeStyle } }
        : {}),
    } as CompiledSeries;
  });

  return {
    series,
    plots: Array.from(plots),
    ...(gradients.length > 0 ? { gradients } : {}),
  };
}
