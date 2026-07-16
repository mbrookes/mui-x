import type { ScatterValueType } from '@mui/x-charts/models';
import { isFieldDef } from '../types';
import type { DatasetRow, VegaEncoding } from '../types';
import { resolveColor } from '../compile/color';
import type { ColorResolution } from '../compile/color';
import { resolveFieldType, toDate, toNumber } from '../compile/fieldTypes';
import type {
  AxisResolution,
  CompiledSeries,
  CompiledUnit,
  CompiledZAxis,
  OverlaySegment,
  SizeLegend,
  UnitContext,
} from '../compile/context';

/*
 * OWNERSHIP: the "point/scatter marks" work unit (and, for `tick`/bubble
 * `size`, the "segments, ticks & bubbles" work unit) owns this file.
 *
 * Implement translation of `point`, `circle`, `square`, and `tick` marks to
 * x-charts `type: 'scatter'` series:
 * - both positional channels quantitative/temporal → scatter data
 *   `{x, y, id}` from raw rows;
 * - one categorical positional channel (strip plot) → scatter against the
 *   band/point axis using category values;
 * - color-field splitting into one series per group (resolveColor);
 * - `size` encoding: a quantitative size field maps to a per-point
 *   `sizeValue` on the scatter data plus a `CompiledUnit.zAxis` entry
 *   carrying a `sizeMap` (continuous, sqrt interpolator — Vega-Lite's `size`
 *   is area-like, and x-charts' size scale defaults to the same sqrt
 *   area→radius mapping, so no gap is needed for the supported case); a
 *   non-quantitative size field (ordinal/nominal/temporal) has no x-charts
 *   equivalent and reports a `partial` gap instead;
 * - `shape` encoding → gap (x-charts scatter markers are uniform);
 * - `tick` marks render as a `{kind: 'segments'}` overlay (see
 *   src/overlays/Segments.tsx) instead of scatter circles: one degenerate
 *   segment (`x1 === x2`, `y1 === y2`) per row, which the overlay renderer
 *   expands into a short perpendicular line centered on the point.
 *
 * Positional-value note: `@mui/x-charts` scatter marks are placed with
 * `getValueToPositionMapper`, which for ordinal (band/point) scales calls
 * `scale(value)` directly on whatever is passed as `x`/`y` — it does not
 * require a number. This was verified against
 * `packages/x-charts/src/hooks/getValueToPositionMapper.ts` and a render
 * probe: passing the raw category string (nominal/ordinal) or a `Date`
 * instance as the scatter point's `x`/`y` renders at the correct position. For
 * a `Date` this holds on both axis shapes a temporal channel can resolve to
 * (see scales.ts):
 * - the continuous `scaleType: 'time'` scale (the default) places the point
 *   with `scaleTime(date)`, spacing it proportionally to elapsed time;
 * - the discrete band/point fallback interns the ordinal domain key via
 *   `Date.prototype.valueOf()`, so distinct `Date` instances with the same
 *   timestamp resolve to the same domain slot.
 * `resolveAxisValue` already returns a `Date` for a temporal axis in both
 * cases, so a single value-resolution path covers quantitative (continuous),
 * temporal (continuous or point-scale), and nominal/ordinal (point-scale,
 * including strip plots with one categorical channel) axes — no
 * `mark:point-categorical-axis` gap is needed.
 */

/** A scatter datum before being cast to `ScatterValueType` (x/y may be non-numeric on a point/band scale — see the note above). */
interface PointDatum {
  x: number | string | Date;
  y: number | string | Date;
  id: number;
  /**
   * Per-point size-scale input for a quantitative `size` field encoding
   * (bubble chart) — read by the `sizeMap` z-axis this compiler emits
   * alongside it (see `getMarkerSize` in
   * `packages/x-charts/src/ScatterChart/seriesConfig/getMarkerSize.ts`).
   */
  sizeValue?: number;
}

/** A row resolved to a plottable position, still carrying its color-group key/value (if any) for later bucketing. */
interface ResolvedCandidate {
  point: PointDatum;
  groupKey?: string;
  groupValue?: unknown;
}

/** Resolves a row's raw value for a positional axis, coerced to match the axis' resolved field type. Returns `null` for value/datum-only axes (no `field`) or unparseable/missing data. */
function resolveAxisValue(
  axis: AxisResolution | undefined,
  row: DatasetRow,
): number | string | Date | null {
  if (!axis?.field) {
    // A synthetic single-category axis (the perpendicular band of a 1D
    // strip/tick plot — see scales.ts) has no backing field; every row sits on
    // its lone category so the tick can span that band.
    if (axis?.synthetic && axis.categories && axis.categories.length > 0) {
      return axis.categories[0] as string | number | Date;
    }
    return null;
  }
  const raw = row[axis.field];
  if (raw == null) {
    return null;
  }
  if (axis.fieldType === 'temporal') {
    return toDate(raw);
  }
  if (axis.fieldType === 'quantitative') {
    return toNumber(raw);
  }
  return raw as string | number;
}

/**
 * Resolves every row to a plottable `{x, y}` position (dropping rows with
 * missing/unparseable positional values) in a single pass over `ctx.rows`,
 * tagging each with its color-group key/value when `colorField` is given and
 * its `sizeValue` when `sizeField` is given.
 * `id` is the row's ordinal position in `ctx.rows`, so it stays a stable,
 * collision-free identifier across color groups without an
 * O(rows.length)-per-point identity lookup (`Array.indexOf`) — which would
 * also mis-key duplicate row *references* to the same index.
 *
 * Rows whose `colorField` value is `null`/`undefined` still get a (stable,
 * shared) group — they are not silently dropped from the chart.
 */
function resolveCandidates(
  ctx: UnitContext,
  colorField: string | undefined,
  sizeField: string | undefined,
): ResolvedCandidate[] {
  const candidates: ResolvedCandidate[] = [];
  ctx.rows.forEach((row, index) => {
    const x = resolveAxisValue(ctx.x, row);
    const y = resolveAxisValue(ctx.y, row);
    if (x == null || y == null) {
      return;
    }
    const point: PointDatum = { x, y, id: index };
    if (sizeField !== undefined) {
      const sizeValue = toNumber(row[sizeField]);
      if (sizeValue !== null) {
        point.sizeValue = sizeValue;
      }
    }
    const candidate: ResolvedCandidate = { point };
    if (colorField !== undefined) {
      const groupValue = row[colorField];
      candidate.groupValue = groupValue;
      candidate.groupKey = ctx.categoryKey(groupValue);
    }
    candidates.push(candidate);
  });
  return candidates;
}

function toScatterData(points: PointDatum[]): readonly ScatterValueType[] {
  return points as unknown as ScatterValueType[];
}

/**
 * Builds a `CompiledSeries` scatter entry, omitting `label`/`color`/
 * `markerSize` entirely (rather than setting them to `undefined`) when
 * unset. x-charts' scatter `seriesProcessor` defaults `markerSize` via
 * `{ markerSize: 4, ...seriesData }`, so an explicit `markerSize: undefined`
 * key would override the default with `undefined` (and render `NaN` radii)
 * instead of falling back to it.
 */
function makeScatterSeries(options: {
  id: string;
  data: PointDatum[];
  label?: string;
  color?: string;
  markerSize?: number;
}): CompiledSeries {
  const { id, data, label, color, markerSize } = options;
  return {
    type: 'scatter',
    id,
    data: toScatterData(data),
    ...(label !== undefined ? { label } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(markerSize !== undefined ? { markerSize } : {}),
  };
}

/** Maps `mark.color`/`strokeWidth`/`strokeDash` onto a tick segment's SVG style, mirroring `rule.ts`'s `buildLineStyle`. */
function buildTickStyle(mark: UnitContext['unit']['mark']): React.CSSProperties | undefined {
  const stroke = typeof mark.color === 'string' ? mark.color : mark.stroke;
  const strokeWidth = typeof mark.strokeWidth === 'number' ? mark.strokeWidth : undefined;
  const strokeDasharray = Array.isArray(mark.strokeDash) ? mark.strokeDash.join(' ') : undefined;
  if (stroke === undefined && strokeWidth === undefined && strokeDasharray === undefined) {
    return undefined;
  }
  return {
    ...(stroke !== undefined ? { stroke } : {}),
    ...(strokeWidth !== undefined ? { strokeWidth } : {}),
    ...(strokeDasharray !== undefined ? { strokeDasharray } : {}),
  };
}

/**
 * Builds one degenerate `OverlaySegment` (`x1 === x2`, `y1 === y2`) per
 * candidate — the convention `src/overlays/Segments.tsx` uses to recognize a
 * "tick" and expand it into a short perpendicular line (see that file's
 * header comment). A color-field split reuses the same
 * explicit-domain/first-seen ordering as the scatter series branch below,
 * assigning each group a color from `colorRes.range` (or the shared palette)
 * instead of creating a separate x-charts series per group — segments have
 * no series/legend concept, so every group's ticks land in one overlay with
 * per-item `style.stroke`.
 */
function buildTickItems(
  ctx: UnitContext,
  candidates: ResolvedCandidate[],
  colorRes: ColorResolution,
  style: React.CSSProperties | undefined,
): OverlaySegment[] {
  const makeItem = (point: PointDatum, stroke: string | undefined): OverlaySegment => ({
    x1: point.x,
    y1: point.y,
    x2: point.x,
    y2: point.y,
    style: stroke !== undefined ? { ...style, stroke } : style,
  });

  if (!colorRes.splitField) {
    // A tick overlay is not an x-charts series, so it never receives an
    // auto-assigned palette color the way a scatter series does; without an
    // explicit stroke it would fall back to the theme's default (black). Use
    // the palette's first color so an uncolored tick reads as Vega's default
    // steel-blue mark.
    const defaultStroke = colorRes.staticColor ?? ctx.palette[0];
    return candidates.map((candidate) => makeItem(candidate.point, defaultStroke));
  }

  const colorByKey = new Map<string, string>();
  if (colorRes.domain) {
    const seenDomainKeys = new Set<string>();
    let domainIndex = 0;
    colorRes.domain.forEach((domainValue) => {
      const key = ctx.categoryKey(domainValue);
      if (seenDomainKeys.has(key)) {
        return;
      }
      seenDomainKeys.add(key);
      const color =
        colorRes.range?.[domainIndex % colorRes.range.length] ??
        ctx.palette[domainIndex % ctx.palette.length];
      colorByKey.set(key, color);
      domainIndex += 1;
    });
  }
  let nextPaletteIndex = colorByKey.size;
  return candidates.map((candidate) => {
    const key = candidate.groupKey as string;
    let color = colorByKey.get(key);
    if (color === undefined) {
      color = ctx.palette[nextPaletteIndex % ctx.palette.length];
      colorByKey.set(key, color);
      nextPaletteIndex += 1;
    }
    return makeItem(candidate.point, color);
  });
}

export function compilePointMark(ctx: UnitContext): CompiledUnit {
  const { unit, gaps, encoding } = ctx;
  const path = unit.path;
  const markType = unit.mark.type;
  const isTick = markType === 'tick';

  // A tick mark tolerates a single positional field — the missing side resolves
  // to a synthetic one-category band (scales.ts) the ticks span across, giving a
  // 1D strip/rug plot. Genuine point/scatter marks still need both axes.
  const xHasField = !!ctx.x?.field;
  const yHasField = !!ctx.y?.field;
  const axesOk = isTick ? xHasField || yHasField : xHasField && yHasField;
  if (!axesOk) {
    gaps.add({
      code: 'mark:point-missing-axis',
      message:
        'A point/scatter mark needs field-based x and y positional encodings to place its markers; a value/datum-only or missing positional channel means the layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  if (markType === 'square') {
    gaps.add({
      code: 'mark:point-square-shape',
      message:
        '"square" marks render with the standard x-charts circular scatter marker; the square shape is ignored.',
      severity: 'ignored',
      path,
    });
  }

  if (encoding.shape !== undefined) {
    gaps.add({
      code: 'encoding:shape',
      message: 'x-charts scatter markers are visually uniform; the "shape" encoding is ignored.',
      severity: 'ignored',
      path: `${path}.encoding.shape`,
    });
  }

  // Vega-Lite's `filled` default is mark-dependent: `point` marks are hollow
  // (stroke-only), while `circle`/`square` are solid. An explicit `filled`
  // overrides either way. Hollow markers render through the shell's custom
  // scatter marker slot (keyed by the series ids collected below).
  const hollow = !isTick && (unit.mark.filled ?? markType !== 'point') === false;

  // "filled"/opacity styling only applies to genuine circular markers — tick
  // segments have their own stroke-based styling via buildTickStyle instead.
  if (!isTick) {
    // A constant `mark.opacity`/`fillOpacity` (or a value-def `opacity`
    // encoding) is now baked into the marker color centrally (see
    // `staticMarkOpacity` in compile/index.ts); a field-driven `opacity`
    // encoding keeps its `encoding:opacity-field-unsupported` gap from
    // resolveColor. Only `strokeOpacity` (a separate stroke alpha the single
    // marker color can't express) is still dropped here.
    if (unit.mark.strokeOpacity !== undefined) {
      gaps.add({
        code: 'encoding:opacity',
        message:
          'x-charts scatter markers have a single color with no separate stroke alpha; ' +
          '"strokeOpacity" on the mark is ignored (mark/fill opacity IS applied via the marker color).',
        severity: 'ignored',
        path: `${path}.mark.strokeOpacity`,
      });
    }
  }

  const colorRes = resolveColor(encoding, ctx.rows, gaps, path);

  if (isTick) {
    const tickStyle = buildTickStyle(unit.mark);
    const candidates = resolveCandidates(ctx, colorRes.splitField, undefined);
    const items = buildTickItems(ctx, candidates, colorRes, tickStyle);
    return {
      series: [],
      plots: [],
      ...(items.length > 0 ? { overlays: [{ kind: 'segments' as const, items }] } : {}),
    };
  }

  let markerSize: number | undefined;
  if (typeof unit.mark.size === 'number') {
    // Vega-Lite's `size` is a symbol AREA (px²); x-charts' `markerSize` is the
    // marker's circle radius. Convert area→radius (r = sqrt(area/π)) so the
    // point renders at the reference's diameter. x-charts only draws circular
    // markers, so this is exact for `point`/`circle` and a close approximation
    // for other Vega symbol shapes.
    markerSize = Math.sqrt(unit.mark.size / Math.PI);
    gaps.add({
      code: 'mark:point-size-approximation',
      message:
        'Vega-Lite mark.size is a symbol area while x-charts markerSize is a circle radius; converted via r = sqrt(size/π), exact for circular markers and approximate for other symbol shapes.',
      severity: 'partial',
      path: `${path}.mark.size`,
    });
  }

  // Bubble chart: a quantitative `size` field maps to a per-point `sizeValue`
  // plus a `zAxis` `sizeMap` (below), rather than the old blanket partial gap.
  let sizeField: string | undefined;
  if (encoding.size !== undefined && isFieldDef(encoding.size) && encoding.size.field) {
    const sizeFieldType = resolveFieldType(encoding.size, ctx.rows);
    if (sizeFieldType === 'quantitative') {
      sizeField = encoding.size.field;
    } else {
      gaps.add({
        code: 'encoding:size-field-non-quantitative',
        message: `The "size" channel ("${encoding.size.field}") is ${sizeFieldType}, not quantitative; x-charts' size scale ("sizeMap") only maps continuous values, so the encoding is ignored (the static mark size, if any, is used for every point instead).`,
        severity: 'partial',
        path: `${path}.encoding.size`,
      });
    }
  }

  // Vega-Lite's default point size is 30 (a symbol area) → a circle of radius
  // sqrt(30/π) ≈ 3.1. With no explicit `mark.size` and no size-field encoding,
  // pin that radius so points render at the reference's size instead of
  // x-charts' larger default markerSize (4). Ticks and bubbles are unaffected
  // (ticks use segment styling; bubbles size per-point via the zAxis sizeMap).
  if (markerSize === undefined && sizeField === undefined && !isTick) {
    markerSize = Math.sqrt(30 / Math.PI);
  }

  const colorField = colorRes.splitField;
  const candidates = resolveCandidates(ctx, colorField, sizeField);

  let zAxis: CompiledZAxis[] | undefined;
  let sizeLegend: SizeLegend | undefined;
  if (sizeField !== undefined) {
    let min: number | undefined;
    let max: number | undefined;
    candidates.forEach((candidate) => {
      const value = candidate.point.sizeValue;
      if (value === undefined) {
        return;
      }
      min = min === undefined ? value : Math.min(min, value);
      max = max === undefined ? value : Math.max(max, value);
    });
    if (min !== undefined && max !== undefined) {
      // Vega-Lite's `size` channel is area-like (comparable to a symbol's
      // pixel area); x-charts' continuous `sizeMap` defaults to a `sqrt`
      // interpolator, i.e. the same area→radius relationship, so the mapping
      // itself needs no approximation gap (unlike the static `mark.size`
      // case above, which has no scale to lean on).
      //
      // NOTE: heatmap cells (marks/rect.ts) also push a `zAxis` entry (for
      // `colorMap`) without an explicit `id`, so both fall back to the same
      // compiler-assigned `defaultized-z-axis-<index>` id scheme. A spec
      // mixing a heatmap layer with a per-point-sized bubble scatter layer
      // in one chart is not a realistic combination and isn't specially
      // handled here — whichever layer's `zAxis` entry lands at index 0
      // (`zAxisIds[0]`) wins as the scatter series' default size axis.
      zAxis = [
        {
          min,
          max,
          // `size` is the marker *radius* and the `sqrt` interpolator makes area
          // proportional to the value (Vega-Lite's `size` semantics). Match
          // Vega-Lite's default point size range of [0, 361] in *area*, i.e. a
          // radius up to sqrt(361/π) ≈ 10.7px, rather than the previous 20px
          // radius that rendered bubbles at roughly double Vega-Lite's size.
          sizeMap: { type: 'continuous', size: [0, 11], interpolator: 'sqrt' },
        },
      ];
      sizeLegend = buildSizeLegend(min, max, encoding.size);
    }
  }

  const series: CompiledSeries[] = [];
  const baseId = `vega-point:${path}`;

  if (colorField) {
    // Single pass bucketing every candidate by its (pre-computed) group key —
    // avoids re-scanning `ctx.rows` once per group.
    const groups = new Map<string, { value: unknown; points: PointDatum[] }>();
    candidates.forEach((candidate) => {
      const key = candidate.groupKey as string;
      const group = groups.get(key);
      if (group) {
        group.points.push(candidate.point);
      } else {
        groups.set(key, { value: candidate.groupValue, points: [candidate.point] });
      }
    });

    const pushGroupSeries = (key: string, value: unknown, groupIndex: number) => {
      const group = groups.get(key);
      if (!group || group.points.length === 0) {
        return;
      }
      series.push(
        makeScatterSeries({
          id: `${baseId}:${key}`,
          data: group.points,
          label: colorRes.hasLegend ? String(value) : undefined,
          color: colorRes.range?.[groupIndex % colorRes.range.length],
          markerSize,
        }),
      );
    };

    if (colorRes.domain) {
      // Respect the explicit/sorted domain's order (and, for the label, its exact
      // values) instead of first-seen-in-data order; dedupe it first so the
      // color/range index lines up with what actually gets rendered.
      const seenDomainKeys = new Set<string>();
      let domainIndex = 0;
      colorRes.domain.forEach((domainValue) => {
        const key = ctx.categoryKey(domainValue);
        if (seenDomainKeys.has(key)) {
          return;
        }
        seenDomainKeys.add(key);
        pushGroupSeries(key, domainValue, domainIndex);
        domainIndex += 1;
      });
      // Append any groups the domain didn't cover (e.g. rows whose color value is
      // null/undefined, which the sorted default domain omits) so no data is
      // dropped, trailing the domain-ordered series in data order.
      groups.forEach((group, key) => {
        if (!seenDomainKeys.has(key)) {
          seenDomainKeys.add(key);
          pushGroupSeries(key, group.value, domainIndex);
          domainIndex += 1;
        }
      });
    } else {
      let groupIndex = 0;
      groups.forEach((group, key) => {
        pushGroupSeries(key, group.value, groupIndex);
        groupIndex += 1;
      });
    }
  } else {
    const points = candidates.map((candidate) => candidate.point);
    if (points.length > 0) {
      series.push(
        makeScatterSeries({
          id: baseId,
          data: points,
          color: colorRes.staticColor,
          markerSize,
        }),
      );
    }
  }

  return {
    series,
    plots: series.length > 0 ? ['scatter'] : [],
    ...(zAxis ? { zAxis } : {}),
    ...(sizeLegend ? { sizeLegend } : {}),
    ...(hollow && series.length > 0
      ? { hollowSeriesIds: series.map((entry) => String(entry.id)) }
      : {}),
  };
}

/**
 * Nice, round tick values from 0 up to `max` (a `1/2/5 × 10^n` step), matching
 * the entries Vega-Lite shows in a symbol-size legend.
 */
function niceSizeTicks(max: number): number[] {
  if (!(max > 0)) {
    return [0];
  }
  const rawStep = max / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  // Round the raw step to the nearest "nice" factor (1/2/5/10) using d3's
  // geometric thresholds (√2, √10, √50), so ~4.8 rounds UP to 5 (→ 5 ticks: 0,
  // 5, 10, 15, 20) rather than DOWN to 2 (→ 13 ticks) — matching Vega-Lite.
  let niceFactor: number;
  if (normalized >= Math.sqrt(50)) {
    niceFactor = 10;
  } else if (normalized >= Math.sqrt(10)) {
    niceFactor = 5;
  } else if (normalized >= Math.sqrt(2)) {
    niceFactor = 2;
  } else {
    niceFactor = 1;
  }
  const step = niceFactor * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) {
    ticks.push(Math.round(value));
  }
  return ticks;
}

/**
 * A bubble-size legend mirroring the `zAxis` `sizeMap` (radius up to 11px via a
 * `sqrt` interpolator over `[min, max]`), so its swatches match the plotted
 * markers. The title follows Vega-Lite's `size` channel ("Count of Records" for
 * an unfielded count aggregate, else the field name with its aggregate prefix).
 */
function buildSizeLegend(
  min: number,
  max: number,
  sizeDef: VegaEncoding['size'],
): SizeLegend | undefined {
  if (!(max > min)) {
    return undefined;
  }
  const entries = niceSizeTicks(max).map((value) => {
    const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
    return { value, radius: 11 * Math.sqrt(t) };
  });
  let title: string | undefined;
  if (isFieldDef(sizeDef)) {
    // The aggregate rewrite (transforms/encoding.ts) already stamped a
    // human-readable title ("Count of Records", "MEAN of v") onto the size def
    // and renamed `field` to a synthetic column, so prefer that title; only
    // fall back to deriving one for a raw (un-aggregated) size field.
    const aggregate = typeof sizeDef.aggregate === 'string' ? sizeDef.aggregate : undefined;
    if (sizeDef.title) {
      title = sizeDef.title;
    } else if (sizeDef.field) {
      title = aggregate ? `${aggregate.toUpperCase()} of ${sizeDef.field}` : sizeDef.field;
    } else if (aggregate === 'count') {
      title = 'Count of Records';
    }
  }
  return { title, entries };
}
