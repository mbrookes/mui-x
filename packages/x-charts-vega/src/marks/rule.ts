import type { CompiledReferenceLine, CompiledUnit, UnitContext } from '../compile/context';
import type { DatasetRow, VegaChannelDef } from '../types';
import { isDatumDef, isFieldDef, isValueDef } from '../types';
import type { GapCollector } from '../gaps';

/*
 * OWNERSHIP: the "arc/pie mark" work unit also owns this file (small).
 *
 * Implement translation of the `rule` mark to `ChartsReferenceLine`s:
 * - a rule with only `y` (datum or single aggregated value) → horizontal
 *   reference line (`referenceLines: [{axis: 'y', value}]`);
 * - only `x` → vertical reference line;
 * - rules spanning x→x2/y→y2 segments per datum → gap (no x-charts segment
 *   primitive);
 * - mark color/strokeDash → lineStyle.
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
  if (!Array.isArray(def) && isValueDef(def)) {
    // `{value: N}` on a positional channel is a raw pixel offset in
    // Vega-Lite, not a data-domain value — there is no scale to invert it
    // through here, so it is rendered as an (approximate) data value.
    gaps.add({
      code: `mark:rule-${axis}-value-position`,
      message: `A literal \`value\` on the \`${axis}\` channel is a pixel offset in Vega-Lite; this wrapper has no way to invert it through the axis scale and renders it as a data-domain value instead, which may be positioned incorrectly.`,
      severity: 'partial',
      path: `${path}.encoding.${axis}`,
    });
  }

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

  const hasXSegment = encoding.x !== undefined && encoding.x2 !== undefined;
  const hasYSegment = encoding.y !== undefined && encoding.y2 !== undefined;

  if (hasXSegment) {
    gaps.add({
      code: 'mark:rule-segment-x',
      message:
        'A rule mark spanning `x` → `x2` describes a range/segment, which has no x-charts primitive (no segment or range-line component exists). The segment was dropped.',
      severity: 'unsupported',
      path: `${path}.encoding.x2`,
    });
  }
  if (hasYSegment) {
    gaps.add({
      code: 'mark:rule-segment-y',
      message:
        'A rule mark spanning `y` → `y2` describes a range/segment, which has no x-charts primitive (no segment or range-line component exists). The segment was dropped.',
      severity: 'unsupported',
      path: `${path}.encoding.y2`,
    });
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

  if (!hasYSegment && encoding.y !== undefined) {
    addReferenceLines('y', encoding.y, rows, gaps, path, lineStyle, referenceLines);
  }
  if (!hasXSegment && encoding.x !== undefined) {
    addReferenceLines('x', encoding.x, rows, gaps, path, lineStyle, referenceLines);
  }

  return { series: [], plots: [], referenceLines };
}
