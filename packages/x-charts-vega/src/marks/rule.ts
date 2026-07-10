import type {
  CompiledReferenceLine,
  CompiledUnit,
  OverlaySegment,
  UnitContext,
} from '../compile/context';
import type { DatasetRow, VegaChannelDef, VegaFieldType } from '../types';
import { isDatumDef, isFieldDef, isValueDef } from '../types';
import type { GapCollector } from '../gaps';
import { resolveFieldType, toDate, toNumber } from '../compile/fieldTypes';

/*
 * OWNERSHIP: the "segments, ticks & bubbles" work unit also owns this file
 * (it was originally scoped to the "arc/pie mark" unit, which only added the
 * reference-line translation below; the x2/y2 segment handling is this
 * unit's).
 *
 * Translation of the `rule` mark:
 * - a rule with only `y` (datum or single aggregated value) → horizontal
 *   reference line (`referenceLines: [{axis: 'y', value}]`);
 * - only `x` → vertical reference line;
 * - `x`+`x2` (and/or `y`+`y2`) → per-row `{kind: 'segments'}` overlay items
 *   (see buildXSpanSegments/buildYSpanSegments/buildDiagonalSegments below):
 *   x+x2 alone draws a horizontal segment per row; a "span" rule needs the
 *   perpendicular (y) axis fixed to place it, so the y position is resolved
 *   from, in order, the row's `y` value, the `yOffset` channel, or — when the
 *   chart already has a categorical y axis (shared from another layer) — by
 *   distributing rows across that axis' bands by row index; y+y2 alone is the
 *   transposed vertical case; when all four of x/y/x2/y2 are set, each row gets
 *   an arbitrary diagonal segment from (x, y) to (x2, y2). Only when none of
 *   those anchors exists is the span genuinely unanchorable (it would span the
 *   full plotting extent in Vega-Lite, which has no data-space representation
 *   here — `OverlaySegment` positions are data values, not pixels) and dropped
 *   with a `partial` gap;
 * - mark color/strokeDash → lineStyle, applied to both reference lines and
 *   segment items.
 */

/** Per-datum rules can resolve to one line per distinct value; cap to avoid clutter. */
const MAX_REFERENCE_LINES = 10;

function normalizeLineValue(raw: unknown): number | Date | string | undefined {
  if (raw == null) {
    return undefined;
  }
  if (raw instanceof Date || typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'boolean') {
    return String(raw);
  }
  return raw as string;
}

/** Extracts the distinct set of values a positional channel def resolves to. */
function extractValues(
  def: VegaChannelDef | undefined,
  rows: readonly DatasetRow[],
): Array<number | Date | string> {
  if (!def || Array.isArray(def)) {
    return [];
  }
  if (isDatumDef(def)) {
    const value = normalizeLineValue(def.datum);
    return value === undefined ? [] : [value];
  }
  if (isValueDef(def)) {
    const value = normalizeLineValue(def.value);
    return value === undefined ? [] : [value];
  }
  if (isFieldDef(def) && def.field) {
    const field = def.field;
    const seen = new Set<string>();
    const values: Array<number | Date | string> = [];
    for (const row of rows) {
      const raw = row[field];
      const value = normalizeLineValue(raw);
      if (value === undefined) {
        continue;
      }
      const key =
        value instanceof Date ? `d:${value.getTime()}` : `${typeof value}:${String(value)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      values.push(value);
    }
    return values;
  }
  return [];
}

function addReferenceLines(
  axis: 'x' | 'y',
  def: VegaChannelDef,
  rows: readonly DatasetRow[],
  gaps: GapCollector,
  path: string,
  lineStyle: React.CSSProperties | undefined,
  out: CompiledReferenceLine[],
): void {
  emitPixelValueGap(axis, def, gaps, path);

  const values = extractValues(def, rows);
  if (values.length > MAX_REFERENCE_LINES) {
    gaps.add({
      code: 'mark:rule-too-many-lines',
      message: `This rule mark resolves to ${values.length} distinct reference lines; only the first ${MAX_REFERENCE_LINES} are rendered to avoid cluttering the chart.`,
      severity: 'partial',
      path: `${path}.encoding.${axis}`,
    });
  }
  for (const value of values.slice(0, MAX_REFERENCE_LINES)) {
    out.push({ axis, value, lineStyle });
  }
}

function buildLineStyle(mark: UnitContext['unit']['mark']): React.CSSProperties | undefined {
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

/** Stable key for a color-group value (mirrors the grouping used elsewhere). */
function colorKey(value: unknown): string {
  return value instanceof Date ? `d:${value.getTime()}` : String(value);
}

/**
 * A per-row stroke color derived from the `color`/`fill`/`stroke` field
 * encoding, so a color-split rule (e.g. a Gantt colored by task) paints each
 * segment its group color instead of a single shared stroke. Colors come from an
 * explicit `scale.range` (positionally matched to `scale.domain`, else
 * first-appearance order) and fall back to the chart palette. Returns
 * `undefined` when there is no color field — the shared `lineStyle` is used.
 */
function buildRowColor(ctx: UnitContext): ((row: DatasetRow) => string | undefined) | undefined {
  const { encoding, rows, palette } = ctx;
  const colorDef = [encoding.color, encoding.fill, encoding.stroke].find((def) => isFieldDef(def));
  const field = isFieldDef(colorDef) ? colorDef.field : undefined;
  if (!field) {
    return undefined;
  }
  const scale = (colorDef as { scale?: { domain?: unknown[]; range?: string[] } }).scale;
  const range = Array.isArray(scale?.range) ? scale.range : undefined;
  const order: unknown[] = Array.isArray(scale?.domain) ? [...scale.domain] : [];
  const seen = new Set(order.map(colorKey));
  for (const row of rows) {
    const value = row[field];
    if (value == null || seen.has(colorKey(value))) {
      continue;
    }
    seen.add(colorKey(value));
    order.push(value);
  }
  const colorByKey = new Map<string, string>();
  order.forEach((value, index) => {
    colorByKey.set(colorKey(value), range?.[index] ?? palette[index % palette.length]);
  });
  return (row) => {
    const value = row[field];
    return value == null ? undefined : colorByKey.get(colorKey(value));
  };
}

/** Merges a per-row stroke color over the shared line style (color-field wins over `mark.color`). */
function styleForRow(
  base: React.CSSProperties | undefined,
  rowColor: ((row: DatasetRow) => string | undefined) | undefined,
  row: DatasetRow,
): React.CSSProperties | undefined {
  const stroke = rowColor?.(row);
  return stroke === undefined ? base : { ...base, stroke };
}

/**
 * `{value: N}` on a positional channel is a raw pixel offset in Vega-Lite,
 * not a data-domain value — there is no scale to invert it through here, so
 * it is rendered as an (approximate) data value instead. Shared by the
 * single-value reference-line path and the per-row segment path (both may
 * encounter a `value`-based endpoint).
 */
function emitPixelValueGap(
  channel: string,
  def: VegaChannelDef | undefined,
  gaps: GapCollector,
  path: string,
): void {
  if (def && !Array.isArray(def) && isValueDef(def)) {
    gaps.add({
      code: `mark:rule-${channel}-value-position`,
      message: `A literal \`value\` on the \`${channel}\` channel is a pixel offset in Vega-Lite; this wrapper has no way to invert it through the axis scale and renders it as a data-domain value instead, which may be positioned incorrectly.`,
      severity: 'partial',
      path: `${path}.encoding.${channel}`,
    });
  }
}

/**
 * Resolves one row's value for a rule endpoint channel: field defs read (and
 * coerce) the row's raw value, datum defs are a constant across every row,
 * and value defs (pixel space) fall back to their raw literal as an
 * approximate data value (see `emitPixelValueGap`, called once per channel by
 * the caller rather than per row).
 */
function resolveRowPosition(
  def: VegaChannelDef | undefined,
  fieldType: VegaFieldType | undefined,
  row: DatasetRow,
): number | string | Date | undefined {
  if (!def || Array.isArray(def)) {
    return undefined;
  }
  if (isFieldDef(def) && def.field) {
    const raw = row[def.field];
    if (raw == null) {
      return undefined;
    }
    if (fieldType === 'temporal') {
      return toDate(raw) ?? undefined;
    }
    if (fieldType === 'quantitative') {
      return toNumber(raw) ?? undefined;
    }
    return raw as string | number;
  }
  if (isDatumDef(def)) {
    return normalizeLineValue(def.datum);
  }
  if (isValueDef(def)) {
    return normalizeLineValue(def.value);
  }
  return undefined;
}

/**
 * Resolves the per-row position on a span rule's *perpendicular* axis (the `y`
 * axis for an `x`→`x2` span, the `x` axis for a `y`→`y2` span). A span rule
 * needs the other axis fixed to place each segment; the anchor is taken from,
 * in priority order:
 *   1. an explicit positional encoding on that axis (`y`/`x`) — the row's value;
 *   2. the `yOffset`/`xOffset` channel — a sub-position channel repurposed as
 *      the anchor when the main positional channel is absent;
 *   3. a categorical axis shared from another layer — when the rule's own rows
 *      carry that axis' backing field, each row is anchored at its *own*
 *      category value (so it lands on the band it belongs to, regardless of row
 *      order); otherwise rows are distributed across the bands by row index (a
 *      full-height/width rule has no data-space form here, so spreading rows
 *      over the band is the closest approximation).
 * Returns `null` when none of those exists (genuinely unanchorable); the caller
 * then drops the span with a `partial` gap. `emitPixelValueGap` is fired here
 * (once per channel) for literal `value` anchors, mirroring the single-value
 * reference-line path.
 */
function resolvePerpendicularAnchor(
  ctx: UnitContext,
  axisName: 'x' | 'y',
  primaryDef: VegaChannelDef | undefined,
  offsetDef: VegaChannelDef | undefined,
  path: string,
): ((row: DatasetRow, index: number) => number | string | Date | undefined) | null {
  const { gaps } = ctx;
  const axis = axisName === 'x' ? ctx.x : ctx.y;

  if (primaryDef !== undefined) {
    emitPixelValueGap(axisName, primaryDef, gaps, path);
    const fieldType = axis?.fieldType;
    return (row) => resolveRowPosition(primaryDef, fieldType, row);
  }

  if (offsetDef !== undefined) {
    emitPixelValueGap(`${axisName}Offset`, offsetDef, gaps, path);
    const fieldType = resolveFieldType(offsetDef, ctx.rows);
    return (row) => resolveRowPosition(offsetDef, fieldType, row);
  }

  const categories = axis?.categories;
  if (categories && categories.length > 0) {
    const axisField = axis?.field;
    return (row, index) => {
      // Prefer the row's own value on the categorical axis (correct band even
      // when the rule's rows are ordered/filtered differently from the axis
      // domain); fall back to distributing across bands by row index only when
      // the row carries no value for that field.
      if (axisField !== undefined) {
        const own = row[axisField];
        if (own != null) {
          return own as number | string | Date;
        }
      }
      return categories[index % categories.length];
    };
  }

  return null;
}

/**
 * `x`+`x2`: a horizontal segment per row, anchored on the perpendicular (`y`)
 * axis (see `resolvePerpendicularAnchor`).
 */
function buildXSpanSegments(
  ctx: UnitContext,
  path: string,
  lineStyle: React.CSSProperties | undefined,
  rowColor: ((row: DatasetRow) => string | undefined) | undefined,
  out: OverlaySegment[],
): void {
  const { encoding, rows, gaps } = ctx;
  const xDef = encoding.x!;
  const x2Def = encoding.x2!;

  emitPixelValueGap('x2', x2Def, gaps, path);

  const anchor = resolvePerpendicularAnchor(ctx, 'y', encoding.y, encoding.yOffset, path);
  if (!anchor) {
    gaps.add({
      code: 'mark:rule-segment-x-no-anchor',
      message:
        'A rule mark spanning `x` → `x2` with no `y`/`yOffset` encoding, and no categorical y axis to distribute rows across, would span the full plotting height in Vega-Lite; this wrapper has no data-space way to express a full-height segment (`OverlaySegment` positions are data values, not pixels), so the segment was dropped. Add a `y` (or `yOffset`/`datum`) encoding, or layer the rule over a mark with a categorical y axis, to anchor each row.',
      severity: 'partial',
      path: `${path}.encoding.x2`,
    });
    return;
  }

  const xFieldType = ctx.x?.fieldType;
  rows.forEach((row, index) => {
    const x1 = resolveRowPosition(xDef, xFieldType, row);
    const x2Value = resolveRowPosition(x2Def, xFieldType, row);
    const y = anchor(row, index);
    if (x1 == null || x2Value == null || y == null) {
      return;
    }
    out.push({ x1, x2: x2Value, y1: y, y2: y, style: styleForRow(lineStyle, rowColor, row) });
  });
}

/**
 * `y`+`y2`: a vertical segment per row, anchored on the perpendicular (`x`)
 * axis (see `resolvePerpendicularAnchor`).
 */
function buildYSpanSegments(
  ctx: UnitContext,
  path: string,
  lineStyle: React.CSSProperties | undefined,
  rowColor: ((row: DatasetRow) => string | undefined) | undefined,
  out: OverlaySegment[],
): void {
  const { encoding, rows, gaps } = ctx;
  const yDef = encoding.y!;
  const y2Def = encoding.y2!;

  emitPixelValueGap('y2', y2Def, gaps, path);

  const anchor = resolvePerpendicularAnchor(ctx, 'x', encoding.x, encoding.xOffset, path);
  if (!anchor) {
    gaps.add({
      code: 'mark:rule-segment-y-no-anchor',
      message:
        'A rule mark spanning `y` → `y2` with no `x`/`xOffset` encoding, and no categorical x axis to distribute rows across, would span the full plotting width in Vega-Lite; this wrapper has no data-space way to express a full-width segment (`OverlaySegment` positions are data values, not pixels), so the segment was dropped. Add an `x` (or `xOffset`/`datum`) encoding, or layer the rule over a mark with a categorical x axis, to anchor each row.',
      severity: 'partial',
      path: `${path}.encoding.y2`,
    });
    return;
  }

  const yFieldType = ctx.y?.fieldType;
  rows.forEach((row, index) => {
    const y1 = resolveRowPosition(yDef, yFieldType, row);
    const y2Value = resolveRowPosition(y2Def, yFieldType, row);
    const x = anchor(row, index);
    if (y1 == null || y2Value == null || x == null) {
      return;
    }
    out.push({ x1: x, x2: x, y1, y2: y2Value, style: styleForRow(lineStyle, rowColor, row) });
  });
}

/** All four of `x`/`y`/`x2`/`y2` set: an arbitrary diagonal segment per row from (x, y) to (x2, y2). */
function buildDiagonalSegments(
  ctx: UnitContext,
  path: string,
  lineStyle: React.CSSProperties | undefined,
  rowColor: ((row: DatasetRow) => string | undefined) | undefined,
  out: OverlaySegment[],
): void {
  const { encoding, rows, gaps } = ctx;
  emitPixelValueGap('x2', encoding.x2, gaps, path);
  emitPixelValueGap('y2', encoding.y2, gaps, path);

  const xFieldType = ctx.x?.fieldType;
  const yFieldType = ctx.y?.fieldType;
  for (const row of rows) {
    const x1 = resolveRowPosition(encoding.x, xFieldType, row);
    const x2Value = resolveRowPosition(encoding.x2, xFieldType, row);
    const y1 = resolveRowPosition(encoding.y, yFieldType, row);
    const y2Value = resolveRowPosition(encoding.y2, yFieldType, row);
    if (x1 == null || x2Value == null || y1 == null || y2Value == null) {
      continue;
    }
    out.push({ x1, x2: x2Value, y1, y2: y2Value, style: styleForRow(lineStyle, rowColor, row) });
  }
}

export function compileRuleMark(ctx: UnitContext): CompiledUnit {
  const { encoding, rows, gaps, unit } = ctx;
  const { path, mark } = unit;

  if (!ctx.x && !ctx.y) {
    gaps.add({
      code: 'mark:rule-no-axis',
      message:
        'No cartesian axis was resolved for this chart (no layer defines an x or y encoding), so this rule mark may render without axes to anchor to. Layer the rule with a mark that defines positional encodings.',
      severity: 'partial',
      path,
    });
  }

  const lineStyle = buildLineStyle(mark);
  // A color-field split paints each segment its group color (e.g. a Gantt
  // colored by task); reference lines keep the shared style below.
  const rowColor = buildRowColor(ctx);
  const referenceLines: CompiledReferenceLine[] = [];
  const segmentItems: OverlaySegment[] = [];

  const hasXSegment = encoding.x !== undefined && encoding.x2 !== undefined;
  const hasYSegment = encoding.y !== undefined && encoding.y2 !== undefined;

  if (hasXSegment && hasYSegment) {
    buildDiagonalSegments(ctx, path, lineStyle, rowColor, segmentItems);
  } else if (hasXSegment) {
    buildXSpanSegments(ctx, path, lineStyle, rowColor, segmentItems);
  } else if (hasYSegment) {
    buildYSpanSegments(ctx, path, lineStyle, rowColor, segmentItems);
  }

  if (!hasXSegment && !hasYSegment && encoding.x !== undefined && encoding.y !== undefined) {
    // A rule with both `x` and `y` (and no `x2`/`y2`) positions a single
    // point per datum in Vega-Lite. x-charts has no point-reference
    // primitive, so this renders as two full crossing lines instead.
    gaps.add({
      code: 'mark:rule-point-approximated-as-crossing-lines',
      message:
        'A rule mark with both `x` and `y` set (and no `x2`/`y2`) positions a single point per datum in Vega-Lite. `@mui/x-charts` has no point-reference primitive, so this renders as two full-length crossing reference lines (one per axis) instead of a single point marker.',
      severity: 'partial',
      path,
    });
  }

  // Once either axis pair forms a segment, both `x` and `y` are consumed as
  // segment endpoints/anchors — neither should also produce a standalone
  // reference line.
  const hasAnySegment = hasXSegment || hasYSegment;
  if (!hasAnySegment && encoding.y !== undefined) {
    addReferenceLines('y', encoding.y, rows, gaps, path, lineStyle, referenceLines);
  }
  if (!hasAnySegment && encoding.x !== undefined) {
    addReferenceLines('x', encoding.x, rows, gaps, path, lineStyle, referenceLines);
  }

  return {
    series: [],
    plots: [],
    referenceLines,
    ...(segmentItems.length > 0 ? { overlays: [{ kind: 'segments', items: segmentItems }] } : {}),
  };
}
