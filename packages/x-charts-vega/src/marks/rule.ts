import type {
  CompiledReferenceLine,
  CompiledUnit,
  OverlaySegment,
  UnitContext,
} from '../compile/context';
import type { DatasetRow, VegaChannelDef, VegaFieldType } from '../types';
import { isDatumDef, isFieldDef, isValueDef } from '../types';
import type { GapCollector } from '../gaps';
import { toDate, toNumber } from '../compile/fieldTypes';

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
 *   x+x2 alone draws a horizontal segment per row anchored at that row's `y`
 *   value (Vega-Lite semantics — a "span" rule needs the other axis fixed to
 *   place it); y+y2 alone is the transposed vertical case; when all four of
 *   x/y/x2/y2 are set, each row gets an arbitrary diagonal segment from
 *   (x, y) to (x2, y2). A missing anchor channel (e.g. x+x2 with no y) would
 *   need to span the full plotting extent in Vega-Lite, which has no
 *   data-space representation here (`OverlaySegment` positions are data
 *   values, not pixels) — that case is dropped with an `unsupported` gap;
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

/** `x`+`x2` alone: a horizontal segment per row, anchored at that row's `y`. */
function buildXSpanSegments(
  ctx: UnitContext,
  path: string,
  lineStyle: React.CSSProperties | undefined,
  out: OverlaySegment[],
): void {
  const { encoding, rows, gaps } = ctx;
  const xDef = encoding.x!;
  const x2Def = encoding.x2!;
  const yDef = encoding.y;

  emitPixelValueGap('x2', x2Def, gaps, path);

  if (yDef === undefined) {
    gaps.add({
      code: 'mark:rule-segment-x-no-anchor',
      message:
        'A rule mark spanning `x` → `x2` with no `y` encoding would span the full plotting height in Vega-Lite; this wrapper has no data-space way to express a full-height segment (`OverlaySegment` positions are data values, not pixels), so the segment was dropped. Add a `y` (or `datum`) encoding to anchor each row.',
      severity: 'unsupported',
      path: `${path}.encoding.x2`,
    });
    return;
  }
  emitPixelValueGap('y', yDef, gaps, path);

  const xFieldType = ctx.x?.fieldType;
  const yFieldType = ctx.y?.fieldType;
  for (const row of rows) {
    const x1 = resolveRowPosition(xDef, xFieldType, row);
    const x2Value = resolveRowPosition(x2Def, xFieldType, row);
    const y = resolveRowPosition(yDef, yFieldType, row);
    if (x1 == null || x2Value == null || y == null) {
      continue;
    }
    out.push({ x1, x2: x2Value, y1: y, y2: y, style: lineStyle });
  }
}

/** `y`+`y2` alone: a vertical segment per row, anchored at that row's `x`. */
function buildYSpanSegments(
  ctx: UnitContext,
  path: string,
  lineStyle: React.CSSProperties | undefined,
  out: OverlaySegment[],
): void {
  const { encoding, rows, gaps } = ctx;
  const yDef = encoding.y!;
  const y2Def = encoding.y2!;
  const xDef = encoding.x;

  emitPixelValueGap('y2', y2Def, gaps, path);

  if (xDef === undefined) {
    gaps.add({
      code: 'mark:rule-segment-y-no-anchor',
      message:
        'A rule mark spanning `y` → `y2` with no `x` encoding would span the full plotting width in Vega-Lite; this wrapper has no data-space way to express a full-width segment (`OverlaySegment` positions are data values, not pixels), so the segment was dropped. Add an `x` (or `datum`) encoding to anchor each row.',
      severity: 'unsupported',
      path: `${path}.encoding.y2`,
    });
    return;
  }
  emitPixelValueGap('x', xDef, gaps, path);

  const xFieldType = ctx.x?.fieldType;
  const yFieldType = ctx.y?.fieldType;
  for (const row of rows) {
    const y1 = resolveRowPosition(yDef, yFieldType, row);
    const y2Value = resolveRowPosition(y2Def, yFieldType, row);
    const x = resolveRowPosition(xDef, xFieldType, row);
    if (y1 == null || y2Value == null || x == null) {
      continue;
    }
    out.push({ x1: x, x2: x, y1, y2: y2Value, style: lineStyle });
  }
}

/** All four of `x`/`y`/`x2`/`y2` set: an arbitrary diagonal segment per row from (x, y) to (x2, y2). */
function buildDiagonalSegments(
  ctx: UnitContext,
  path: string,
  lineStyle: React.CSSProperties | undefined,
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
    out.push({ x1, x2: x2Value, y1, y2: y2Value, style: lineStyle });
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
  const referenceLines: CompiledReferenceLine[] = [];
  const segmentItems: OverlaySegment[] = [];

  const hasXSegment = encoding.x !== undefined && encoding.x2 !== undefined;
  const hasYSegment = encoding.y !== undefined && encoding.y2 !== undefined;

  if (hasXSegment && hasYSegment) {
    buildDiagonalSegments(ctx, path, lineStyle, segmentItems);
  } else if (hasXSegment) {
    buildXSpanSegments(ctx, path, lineStyle, segmentItems);
  } else if (hasYSegment) {
    buildYSpanSegments(ctx, path, lineStyle, segmentItems);
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
