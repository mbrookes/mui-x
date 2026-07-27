import type { HeatmapSeriesType, HeatmapValueType } from '@mui/x-charts-pro/models';
import type {
  AxisResolution,
  CompiledUnit,
  OverlayPosition,
  OverlayRectItem,
  UnitContext,
} from '../compile/context';
import { resolveColor } from '../compile/color';
import { resolveFieldType, toDate, toNumber } from '../compile/fieldTypes';
import type { GapCollector } from '../gaps';
import { isFieldDef } from '../types';
import type { DatasetRow, VegaChannelDef, VegaEncoding } from '../types';

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

function fieldOf(def: VegaChannelDef | undefined): string | undefined {
  return def && isFieldDef(def) ? def.field : undefined;
}

/** A row's raw value coerced for an `OverlayRectItem` corner: `Date` on a temporal axis, else numeric. `null` when it doesn't resolve. */
function resolveRangePosition(fieldType: string | undefined, raw: unknown): OverlayPosition | null {
  return fieldType === 'temporal' ? toDate(raw) : toNumber(raw);
}

/**
 * A per-row fill for the ranged-rect overlay below. Unlike a native series
 * (one color for the whole series), each `OverlayRectItem` already carries
 * its own `fill`, so an ordinal/nominal color split resolves genuinely per
 * row instead of being unsupported (mirrors `marks/bar.ts`'s
 * `resolveRectRowColor` for the analogous continuous-range bar case).
 */
function resolveRowColor(
  ctx: UnitContext,
  color: ReturnType<typeof resolveColor>,
  fallback: string | undefined,
  gaps: GapCollector,
  path: string,
): (row: DatasetRow) => string | undefined {
  if (!color.splitField) {
    return () => fallback;
  }
  gaps.add({
    code: 'mark:rect-ranged-color-legend',
    message:
      'Each rectangle is colored individually from its own row value, but this custom overlay ' +
      'has no legend to show the color scale (unlike a native x-charts series/swatch legend).',
    severity: 'ignored',
    path,
  });
  const { splitField, domain, range, identity } = color;
  const effectiveRange = range && range.length > 0 ? range : ctx.palette;
  return (row) => {
    const raw = row[splitField];
    if (raw == null) {
      return fallback;
    }
    if (identity) {
      return String(raw);
    }
    const key = ctx.categoryKey(raw);
    const index = domain ? domain.findIndex((value) => ctx.categoryKey(value) === key) : -1;
    return effectiveRange[(index >= 0 ? index : 0) % effectiveRange.length];
  };
}

/**
 * A `rect` mark with an `x2`/`y2` secondary endpoint: a filled interval/span
 * rect (e.g. a Gantt-style timeline bar or background highlight band), a
 * different visualization from the 2D cell grid `compileRectMark` otherwise
 * draws — no x-charts series primitive covers it, so it renders through the
 * same custom `rects` overlay `marks/bar.ts` uses for a continuous-range bar.
 * Two shapes:
 * - one span pair (`x`/`x2` OR `y`/`y2`) with NO channel at all on the other
 *   axis — a full-height/full-width background band (`layer_falkensee`'s
 *   Nazi-rule/GDR highlight rects); the other axis's corners are left unset
 *   so the renderer (`overlays/Rects.tsx`) fills the whole drawing-area span
 *   instead of a data-space one;
 * - both `x`/`x2` AND `y`/`y2` — a genuine per-row rectangle on two spans
 *   (`wheat_wages`'s monarch-reign timeline rows).
 * A lone `x2`/`y2` with NO primary channel on the SAME axis either (e.g. only
 * `x2` and no `x` at all) has no start corner to pair it with and is dropped.
 */
function compileRangedRect(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const path = unit.path;
  const mark = unit.mark;

  const xField = fieldOf(encoding.x);
  const xTwinField = fieldOf(encoding.x2);
  const yField = fieldOf(encoding.y);
  const yTwinField = fieldOf(encoding.y2);

  if ((encoding.x2 !== undefined && !xField) || (encoding.y2 !== undefined && !yField)) {
    gaps.add({
      code: 'mark:rect-ranged',
      message:
        'An `x2`/`y2` secondary endpoint needs a primary `x`/`y` field on the same axis to pair with; this spec has none, so the layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  const color = resolveColor(encoding, rows, gaps, path);
  const staticColor =
    color.staticColor ??
    (typeof mark.fill === 'string' ? mark.fill : undefined) ??
    (typeof mark.color === 'string' ? mark.color : undefined);
  const fallbackColor = staticColor ?? ctx.palette[0];
  const rowColor = resolveRowColor(ctx, color, fallbackColor, gaps, path);

  const items: OverlayRectItem[] = [];
  for (const row of rows) {
    const x1 = xField ? resolveRangePosition(ctx.x?.fieldType, row[xField]) : undefined;
    const x2 = xTwinField ? resolveRangePosition(ctx.x?.fieldType, row[xTwinField]) : undefined;
    const y1 = yField ? resolveRangePosition(ctx.y?.fieldType, row[yField]) : undefined;
    const y2 = yTwinField ? resolveRangePosition(ctx.y?.fieldType, row[yTwinField]) : undefined;
    // A requested span (its field was present in the encoding) must actually
    // resolve for both ends; a channel absent from the encoding altogether
    // stays `undefined` on purpose (the full-height/full-width case above).
    if (xField && x1 == null) {
      continue;
    }
    if (xTwinField && x2 == null) {
      continue;
    }
    if (yField && y1 == null) {
      continue;
    }
    if (yTwinField && y2 == null) {
      continue;
    }
    items.push({
      ...(x1 != null ? { x1 } : {}),
      ...(x2 != null ? { x2 } : {}),
      ...(y1 != null ? { y1 } : {}),
      ...(y2 != null ? { y2 } : {}),
      fill: rowColor(row),
    });
  }

  if (items.length === 0) {
    // A discrete (nominal/ordinal) x2/y2 companion — this overlay only draws
    // continuous/temporal spans — never resolves for any row; be honest that
    // nothing was drawn instead of claiming an `ignored` custom-overlay
    // rendering that produced zero rectangles.
    gaps.add({
      code: 'mark:rect-ranged',
      message:
        'An `x2`/`y2` secondary endpoint needs a continuous (quantitative) or temporal value to ' +
        'draw a span from; no row resolved one, so nothing was rendered.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  gaps.add({
    code: 'mark:rect-ranged-custom-overlay',
    message:
      'A rect mark with an x2/y2 secondary endpoint draws a filled interval/span rectangle, not ' +
      'a 2D cell grid; x-charts has no native primitive for this, so it renders through a custom ' +
      '`rect` overlay instead.',
    severity: 'ignored',
    path,
  });
  return { series: [], plots: [], overlays: [{ kind: 'rects', items }] };
}

export function compileRectMark(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const path = unit.path;
  const mark = unit.mark;

  // x2/y2 describe a filled interval/span rect (e.g. Gantt-style bars), a
  // different visualization from the 2D cell grid a heatmap draws — see
  // `compileRangedRect`.
  if (encoding.x2 !== undefined || encoding.y2 !== undefined) {
    return compileRangedRect(ctx);
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

  // Re-anchor the color scale to the cells that actually render. resolveColor
  // derives the continuous/piecewise extent from every aggregated row, which
  // includes phantom cells where a binned positional field is null (a movie
  // with no Rotten Tomatoes rating still forms a `(imdbBin, null)` count
  // group). Those rows are skipped above — `categoryIndex` returns -1 for the
  // null bin — so counting them into the color extent would stretch `max` well
  // past the darkest drawn cell (e.g. 36 vs a true max of 19), washing every
  // cell out lighter than Vega-Lite's. Recompute the extent from `data` unless
  // the spec pinned the color scale `domain` explicitly.
  const hasExplicitColorDomain = Array.isArray((colorDef.scale as { domain?: unknown })?.domain);
  if (color.colorMap && !hasExplicitColorDomain && data.length > 0) {
    const cellValues = data.map((cell) => cell[2]);
    const cellMin = Math.min(...cellValues);
    const cellMax = Math.max(...cellValues);
    if (Number.isFinite(cellMin) && Number.isFinite(cellMax) && cellMin !== cellMax) {
      if (color.colorMap.type === 'continuous' && typeof color.colorMap.max === 'number') {
        color.colorMap = { ...color.colorMap, min: cellMin, max: cellMax };
      } else if (color.colorMap.type === 'piecewise') {
        const bandCount = color.colorMap.colors.length;
        const thresholds = Array.from(
          { length: bandCount - 1 },
          (_, i) => cellMin + (cellMax - cellMin) * ((i + 1) / bandCount),
        );
        color.colorMap = { ...color.colorMap, thresholds };
      }
    }
  }

  const series: HeatmapSeriesType[] = [{ type: 'heatmap', data }];

  // The color legend's title, mirroring Vega-Lite: an explicit `title` wins,
  // else an aggregate-prefixed field name ("Mean of Horsepower"), else the field.
  // (Carried on the compiled unit; the shell draws it above the legend, since
  // x-charts' zAxis config has no title/label slot.)
  // `legend: {title: null}` suppresses the title just as a channel-level
  // `title: null` does, and `legend: null` removes the legend outright —
  // `rect_heatmap_weather` asks for the former and was captioned
  // "MAX of temp_max" where the reference shows a bare gradient.
  const legendDef = colorDef.legend as { title?: unknown } | null | undefined;
  const explicitTitle =
    legendDef === null || legendDef?.title === null ? null : (colorDef.title ?? legendDef?.title);
  let legendTitle: string | undefined;
  if (explicitTitle === null) {
    legendTitle = undefined;
  } else if (explicitTitle != null) {
    legendTitle = String(explicitTitle);
  } else if (typeof colorDef.aggregate === 'string') {
    legendTitle = `${colorDef.aggregate.charAt(0).toUpperCase()}${colorDef.aggregate.slice(1)} of ${valueField}`;
  } else {
    legendTitle = valueField;
  }

  // `encoding.color.legend.direction`/`gradientLength` size and orient the
  // continuous/piecewise gradient bar — Vega-Lite defaults to a vertical bar
  // unless a spec asks for "horizontal" explicitly.
  const legendDirection =
    colorDef.legend?.direction === 'horizontal' || colorDef.legend?.direction === 'vertical'
      ? colorDef.legend.direction
      : undefined;
  const legendLength =
    typeof colorDef.legend?.gradientLength === 'number'
      ? colorDef.legend.gradientLength
      : undefined;

  return {
    series,
    plots: ['heatmap'],
    ...(color.colorMap
      ? {
          zAxis: [{ id: 'vega-heatmap-color', colorMap: color.colorMap }],
          ...(legendTitle ? { colorLegendTitle: legendTitle } : {}),
          ...(legendDirection ? { colorLegendDirection: legendDirection } : {}),
          ...(legendLength !== undefined ? { colorLegendLength: legendLength } : {}),
        }
      : {}),
  };
}
