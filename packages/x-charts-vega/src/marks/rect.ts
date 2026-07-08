import type { HeatmapSeriesType, HeatmapValueType } from '@mui/x-charts-pro/models';
import type { AxisResolution, CompiledUnit, UnitContext } from '../compile/context';
import { resolveColor } from '../compile/color';
import { resolveFieldType, toDate, toNumber } from '../compile/fieldTypes';
import { isFieldDef } from '../types';
import type { VegaEncoding } from '../types';

/*
 * OWNERSHIP: the "rect/heatmap mark" work unit owns this file.
 *
 * Translates the `rect` mark to x-charts `type: 'heatmap'` series rendered by
 * the shell's <HeatmapPlot />:
 * - both positional channels must resolve to a discrete (band/point) axis
 *   (`ctx.x.categories`/`ctx.y.categories` — nominal/ordinal/binned/temporal,
 *   the latter two already rewritten to synthetic discrete fields upstream);
 * - the cell value comes from the color/fill/stroke channel (in that
 *   precedence, matching resolveColor), which must be quantitative/temporal —
 *   aggregation is already folded into a synthetic field with an explicit
 *   `type: 'quantitative'` by `applyEncodingTransforms`, so the common
 *   "grid + aggregate" case needs no extra type inference here; an
 *   un-aggregated field whose type wasn't declared is still handled via
 *   `resolveFieldType`;
 * - series data is `[xIndex, yIndex, value][]`, indexed into
 *   `ctx.x.categories`/`ctx.y.categories` via `ctx.categoryIndex`; rows whose
 *   position or value can't be resolved are skipped rather than emitting a
 *   placeholder tuple — `HeatmapPlot` treats absent (xIndex, yIndex) pairs as
 *   empty cells, so omitting them is enough (see
 *   packages/x-charts-pro/src/models/seriesType/heatmap.ts `HeatmapData`);
 * - the color scale is surfaced as a `CompiledUnit.zAxis` entry carrying a
 *   `colorMap`, reusing `resolveColor`'s continuous/piecewise resolution
 *   (scale-configured or, absent one, a default ramp derived from the data
 *   extent — both computed by `resolveContinuousColorMap` inside
 *   ../compile/color.ts) instead of duplicating that logic here;
 * - gaps: `x2`/`y2` (filled interval/span rects, a different visualization
 *   from a cell grid) → unsupported; missing discrete axis on either channel
 *   → unsupported; missing/non-quantitative color channel → unsupported;
 *   mark opacity/stroke styling → ignored (heatmap cells have no per-cell
 *   style hooks for either).
 */

/**
 * The value to feed `ctx.categoryIndex`/`ctx.categoryKey` for a row's raw
 * positional value. Temporal axes build their `categoryKeys` from `Date`
 * instances (see scales.ts's `resolveChannelAxis`), and `categoryKey` only
 * special-cases values that are already `Date` objects — a raw temporal
 * field value straight off the row (typically a date string) would key as
 * `string:...` instead of `d:<timestamp>`, so every category lookup would
 * miss and the axis would render with no data at all. Coerce to `Date` first
 * for temporal axes, matching how scales.ts derived the domain.
 */
function resolveCategoryValue(axis: AxisResolution | undefined, raw: unknown): unknown {
  return axis?.fieldType === 'temporal' ? toDate(raw) : raw;
}

/** The channel resolveColor reads the cell value from, in its precedence order. */
function colorChannelKey(encoding: VegaEncoding): 'color' | 'fill' | 'stroke' | undefined {
  if (encoding.color !== undefined) {
    return 'color';
  }
  if (encoding.fill !== undefined) {
    return 'fill';
  }
  if (encoding.stroke !== undefined) {
    return 'stroke';
  }
  return undefined;
}

export function compileRectMark(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const path = unit.path;
  const mark = unit.mark;

  // x2/y2 describe a filled interval/span rect (e.g. Gantt-style bars), a
  // different visualization from the 2D cell grid a heatmap draws — no
  // x-charts primitive covers it, so the layer is dropped outright rather
  // than approximated as a heatmap.
  if (encoding.x2 !== undefined || encoding.y2 !== undefined) {
    gaps.add({
      code: 'mark:rect-ranged',
      message:
        'rect marks with an `x2`/`y2` secondary endpoint describe a filled interval/span rect, not a 2D cell grid; x-charts has no primitive for ranged rects, so the layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  if (!ctx.x?.categories || !ctx.y?.categories || !ctx.x.field || !ctx.y.field) {
    gaps.add({
      code: 'mark:rect-missing-discrete-axes',
      message:
        'Heatmaps need two discrete positional channels (nominal/ordinal/binned/temporal) to form the cell grid; this spec is missing one of them (or one resolved to a continuous scale), so no heatmap was rendered.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  const channelKey = colorChannelKey(encoding);
  const colorDef = channelKey ? encoding[channelKey] : undefined;
  if (!colorDef || Array.isArray(colorDef) || !isFieldDef(colorDef) || !colorDef.field) {
    gaps.add({
      code: 'mark:rect-missing-color',
      message:
        'Heatmap cells need a quantitative color/fill channel to supply the cell value; this spec has none, so no heatmap was rendered.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  const valueField = colorDef.field;
  const fieldType = resolveFieldType(colorDef, rows);
  if (fieldType !== 'quantitative' && fieldType !== 'temporal') {
    gaps.add({
      code: 'mark:rect-non-quantitative-color',
      message: `The "${channelKey}" channel ("${valueField}") is not quantitative/temporal, so it cannot supply heatmap cell values; no heatmap was rendered.`,
      severity: 'unsupported',
      path: `${path}.encoding.${channelKey}`,
    });
    return { series: [], plots: [] };
  }

  if (
    mark.opacity !== undefined ||
    mark.fillOpacity !== undefined ||
    mark.strokeOpacity !== undefined
  ) {
    gaps.add({
      code: 'mark:rect-opacity',
      message:
        'x-charts heatmap cells have no per-series opacity option; "opacity"/"fillOpacity"/"strokeOpacity" on the mark are ignored.',
      severity: 'ignored',
      path: `${path}.mark`,
    });
  }
  if (mark.stroke !== undefined || mark.strokeWidth !== undefined) {
    gaps.add({
      code: 'mark:rect-stroke',
      message:
        'x-charts heatmap cells have no per-cell border/stroke styling option; "stroke"/"strokeWidth" on the mark are ignored.',
      severity: 'ignored',
      path: `${path}.mark`,
    });
  }

  // resolveColor only takes the continuous/piecewise colorMap branch when the
  // field def's `type` is explicitly quantitative/temporal. Aggregated fields
  // already have that from applyEncodingTransforms; an un-aggregated field
  // whose type was only inferred (not declared) needs it patched in here so
  // resolveColor's extent-derived default ramp still applies instead of the
  // encoding falling through to the categorical (split-series) branch.
  const patchedEncoding: VegaEncoding =
    colorDef.type === fieldType
      ? encoding
      : { ...encoding, [channelKey as string]: { ...colorDef, type: fieldType } };
  // colorMapConsumed: the colorMap goes straight onto the heatmap's zAxis,
  // so the "only some series types honor colorMap" caveat does not apply.
  const color = resolveColor(patchedEncoding, rows, gaps, path, { colorMapConsumed: true });

  const data: HeatmapValueType[] = [];
  const xField = ctx.x.field;
  const yField = ctx.y.field;
  for (const row of rows) {
    const xIndex = ctx.categoryIndex(ctx.x, resolveCategoryValue(ctx.x, row[xField]));
    const yIndex = ctx.categoryIndex(ctx.y, resolveCategoryValue(ctx.y, row[yField]));
    if (xIndex < 0 || yIndex < 0) {
      continue;
    }
    const value = toNumber(row[valueField]);
    if (value === null) {
      continue;
    }
    data.push([xIndex, yIndex, value]);
  }

  const series: HeatmapSeriesType[] = [{ type: 'heatmap', data }];

  return {
    series,
    plots: ['heatmap'],
    ...(color.colorMap ? { zAxis: [{ colorMap: color.colorMap }] } : {}),
  };
}
