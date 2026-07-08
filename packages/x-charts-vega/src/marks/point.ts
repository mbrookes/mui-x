import type { ScatterValueType } from '@mui/x-charts/models';
import { isFieldDef } from '../types';
import type { DatasetRow } from '../types';
import { resolveColor } from '../compile/color';
import { toDate, toNumber } from '../compile/fieldTypes';
import type { AxisResolution, CompiledSeries, CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "point/scatter marks" work unit owns this file.
 *
 * Implement translation of `point`, `circle`, `square`, and `tick` marks to
 * x-charts `type: 'scatter'` series:
 * - both positional channels quantitative/temporal → scatter data
 *   `{x, y, id}` from raw rows;
 * - one categorical positional channel (strip plot) → scatter against the
 *   band/point axis using category values;
 * - color-field splitting into one series per group (resolveColor);
 * - `size` encoding: quantitative size field has no per-point size support
 *   in MIT scatter — report a `partial` gap (Pro/Premium `zAxis`-style
 *   `sizeValue` may cover it; do not depend on Pro);
 * - `shape` encoding → gap (x-charts scatter markers are uniform);
 * - `tick` → gap noting it renders as points, `square` → gap noting marker
 *   shape is ignored.
 *
 * Positional-value note: `@mui/x-charts` scatter marks are placed with
 * `getValueToPositionMapper`, which for ordinal (band/point) scales calls
 * `scale(value)` directly on whatever is passed as `x`/`y` — it does not
 * require a number. This was verified against
 * `packages/x-charts/src/hooks/getValueToPositionMapper.ts` and a render
 * probe: passing the raw category string (nominal/ordinal) or a `Date`
 * instance (temporal — the vendored d3 ordinal scale interns object keys via
 * `Date.prototype.valueOf()`, so distinct `Date` instances with the same
 * timestamp resolve to the same domain slot) as the scatter point's `x`/`y`
 * renders at the correct position. So a single value-resolution path covers
 * quantitative (continuous), and nominal/ordinal/temporal (point-scale,
 * including strip plots with one categorical channel) axes — no
 * `mark:point-categorical-axis` gap is needed.
 */

/** A scatter datum before being cast to `ScatterValueType` (x/y may be non-numeric on a point/band scale — see the note above). */
interface PointDatum {
  x: number | string | Date;
  y: number | string | Date;
  id: number;
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
 * tagging each with its color-group key/value when `colorField` is given.
 * `id` is the row's ordinal position in `ctx.rows`, so it stays a stable,
 * collision-free identifier across color groups without an
 * O(rows.length)-per-point identity lookup (`Array.indexOf`) — which would
 * also mis-key duplicate row *references* to the same index.
 *
 * Rows whose `colorField` value is `null`/`undefined` still get a (stable,
 * shared) group — they are not silently dropped from the chart.
 */
function resolveCandidates(ctx: UnitContext, colorField: string | undefined): ResolvedCandidate[] {
  const candidates: ResolvedCandidate[] = [];
  ctx.rows.forEach((row, index) => {
    const x = resolveAxisValue(ctx.x, row);
    const y = resolveAxisValue(ctx.y, row);
    if (x == null || y == null) {
      return;
    }
    const candidate: ResolvedCandidate = { point: { x, y, id: index } };
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

export function compilePointMark(ctx: UnitContext): CompiledUnit {
  const { unit, gaps, encoding } = ctx;
  const path = unit.path;
  const markType = unit.mark.type;

  if (!ctx.x?.field || !ctx.y?.field) {
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
  if (markType === 'tick') {
    gaps.add({
      code: 'mark:point-tick',
      message:
        'x-charts scatter has no line-segment marker primitive, so "tick" marks render as circular points instead of short perpendicular lines.',
      severity: 'partial',
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

  if (unit.mark.filled === false) {
    gaps.add({
      code: 'mark:point-filled',
      message:
        'x-charts scatter markers are always solid-filled; "filled: false" (hollow markers) is ignored.',
      severity: 'ignored',
      path: `${path}.mark.filled`,
    });
  }

  if (
    encoding.opacity !== undefined ||
    unit.mark.opacity !== undefined ||
    unit.mark.fillOpacity !== undefined ||
    unit.mark.strokeOpacity !== undefined
  ) {
    gaps.add({
      code: 'encoding:opacity',
      message:
        encoding.opacity !== undefined
          ? 'x-charts scatter series have no per-point opacity option; the data-driven "opacity" encoding is ignored (every point renders fully opaque).'
          : 'x-charts scatter series have no per-series opacity option; "opacity"/"fillOpacity"/"strokeOpacity" on the mark are ignored.',
      severity: 'ignored',
      path: `${path}.encoding.opacity`,
    });
  }

  let markerSize: number | undefined;
  if (typeof unit.mark.size === 'number') {
    // Vega-Lite's `size` is an area-like value (comparable to a symbol's
    // pixel area) while x-charts `markerSize` is radius-like. There is no
    // exact conversion available without matching Vega-Lite's exact symbol
    // geometry, so approximate with a square root, which keeps relative
    // ordering between differently-sized marks intact.
    markerSize = Math.sqrt(unit.mark.size);
    gaps.add({
      code: 'mark:point-size-approximation',
      message:
        'Vega-Lite mark.size is an area-like value while x-charts markerSize is radius-like; approximated with Math.sqrt(size) rather than an exact conversion.',
      severity: 'partial',
      path: `${path}.mark.size`,
    });
  }

  if (encoding.size !== undefined && isFieldDef(encoding.size)) {
    gaps.add({
      code: 'encoding:size-field',
      message:
        'Per-point size driven by a data field needs zAxis-style sizeAxis/sizeValue support beyond the MIT scatter series; the encoding is ignored (the static mark size, if any, is used for every point instead).',
      severity: 'partial',
      path: `${path}.encoding.size`,
    });
  }

  const colorRes = resolveColor(encoding, ctx.rows, gaps, path);
  const series: CompiledSeries[] = [];
  const baseId = `vega-point:${path}`;
  const candidates = resolveCandidates(ctx, colorRes.splitField);

  if (colorRes.splitField) {
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
      // Respect the explicit domain's order (and, for the label, its exact
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

  return { series, plots: series.length > 0 ? ['scatter'] : [] };
}
