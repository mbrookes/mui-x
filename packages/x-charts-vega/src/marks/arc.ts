import type { PieValueType } from '@mui/x-charts/models';
import type { CompiledUnit, UnitContext } from '../compile/context';
import { resolveColor } from '../compile/color';
import { resolveFieldType, toNumber } from '../compile/fieldTypes';
import { isDatumDef, isFieldDef, isValueDef } from '../types';
import type { VegaFieldDef } from '../types';

/*
 * OWNERSHIP: the "arc/pie mark" work unit owns this file.
 *
 * Implement translation of the `arc` mark to an x-charts `type: 'pie'`
 * series:
 * - `theta` (quantitative, often aggregated) → slice `value`; `color` field
 *   → slice `label` (one datum per distinct color value);
 * - `mark.innerRadius`/`outerRadius`/`padAngle`/`cornerRadius` → the pie
 *   series' `innerRadius`/`outerRadius`/`paddingAngle`/`cornerRadius`;
 * - `theta2`/`radius` encodings and non-pie radial layouts → gaps;
 * - text layers on top of arcs (labels) → gap pointing at `arcLabel`.
 *
 * Note the shell renders pie series with <PiePlot /> and no cartesian axes —
 * return `plots: ['pie']` and no axis-aligned data.
 */

/** Vega-Lite's `mark.padAngle` is in radians; x-charts' `paddingAngle` is in degrees. */
const DEGREES_PER_RADIAN = 180 / Math.PI;

export function compileArcMark(ctx: UnitContext): CompiledUnit {
  const { encoding, rows, gaps, unit } = ctx;
  const { path, mark } = unit;

  // theta2/radius/radius2 describe radial ranges/offsets that x-charts' pie
  // series (a single inner/outer radius per series) cannot express.
  for (const channel of ['theta2', 'radius', 'radius2'] as const) {
    if (encoding[channel] !== undefined) {
      gaps.add({
        code: `encoding:arc-${channel}`,
        message: `The \`${channel}\` channel has no equivalent on x-charts' pie series (a single inner/outer radius per series); it was ignored.`,
        severity: 'unsupported',
        path: `${path}.encoding.${channel}`,
      });
    }
  }

  if (encoding.text !== undefined) {
    gaps.add({
      code: 'encoding:arc-text-label',
      message:
        'Text labels on arc marks are not rendered by this wrapper. `@mui/x-charts` pie series support an `arcLabel` prop for in-slice labels, but it is not wired up through this translator yet.',
      severity: 'unsupported',
      path: `${path}.encoding.text`,
    });
  }

  if (encoding.order !== undefined) {
    gaps.add({
      code: 'encoding:arc-order',
      message:
        'Slice ordering via the `order` channel is not applied; slices follow the row order of the (post-aggregation) data instead.',
      severity: 'ignored',
      path: `${path}.encoding.order`,
    });
  }

  // Resolve the theta (slice value) channel. Aggregation is already folded
  // into a synthetic field on `encoding.theta` by the pipeline, so a plain
  // field read is enough here.
  const thetaDef = encoding.theta;
  let thetaField: string | undefined;
  let staticThetaValue: number | undefined;

  if (thetaDef && !Array.isArray(thetaDef)) {
    if (isFieldDef(thetaDef)) {
      thetaField = (thetaDef as VegaFieldDef).field;
    } else if (isDatumDef(thetaDef)) {
      staticThetaValue = toNumber(thetaDef.datum) ?? undefined;
    } else if (isValueDef(thetaDef)) {
      staticThetaValue = toNumber(thetaDef.value) ?? undefined;
    }
  }

  if (thetaField === undefined && staticThetaValue === undefined) {
    const yDef = encoding.y;
    if (
      yDef &&
      !Array.isArray(yDef) &&
      isFieldDef(yDef) &&
      // Infer the type the same way the rest of the pipeline does (an
      // explicit `type` wins, otherwise it is inferred from the data) rather
      // than requiring a literal `type: 'quantitative'` annotation.
      resolveFieldType(yDef, rows) === 'quantitative'
    ) {
      thetaField = (yDef as VegaFieldDef).field;
      gaps.add({
        code: 'mark:arc-theta-fallback-y',
        message:
          'This arc mark has no `theta` encoding; falling back to the quantitative `y` channel for slice values.',
        severity: 'partial',
        path,
      });
    }
  }

  if (thetaField === undefined && staticThetaValue === undefined) {
    gaps.add({
      code: 'mark:arc-missing-value',
      message:
        'This arc mark has neither a `theta` nor a quantitative `y` encoding to size slices from; no pie series was produced.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  const color = resolveColor(encoding, rows, gaps, path);
  const range = color.range;
  let domain = color.domain?.map((value) => String(value));
  if (!domain && range && color.splitField) {
    // Vega-Lite infers the color domain from the data when `scale.range` is
    // given without an explicit `scale.domain`: distinct field values in
    // first-appearance (row) order, positionally matched to `range`.
    const splitField = color.splitField;
    const seen = new Set<string>();
    domain = [];
    for (const row of rows) {
      const raw = row[splitField];
      if (raw == null) {
        continue;
      }
      const key = String(raw);
      if (!seen.has(key)) {
        seen.add(key);
        domain.push(key);
      }
    }
  }

  const data: PieValueType[] = [];
  rows.forEach((row, index) => {
    const rawValue = thetaField !== undefined ? row[thetaField] : staticThetaValue;
    const value = toNumber(rawValue);
    if (value == null) {
      return;
    }
    const rawLabel = color.splitField ? row[color.splitField] : undefined;
    const label = rawLabel != null ? String(rawLabel) : undefined;

    let sliceColor: string | undefined = color.staticColor;
    if (!sliceColor && range && range.length > 0 && label !== undefined) {
      const domainIndex = domain ? domain.indexOf(label) : -1;
      sliceColor = domainIndex >= 0 ? range[domainIndex % range.length] : undefined;
    }

    data.push({
      id: label ?? index,
      value,
      label,
      ...(sliceColor ? { color: sliceColor } : {}),
    });
  });

  if (data.length === 0 && rows.length > 0) {
    gaps.add({
      code: 'mark:arc-non-numeric-theta',
      message:
        'None of the rows produced a numeric slice value for the resolved theta field; the pie series has no slices. Check that the field contains numbers (or a numeric-producing aggregate).',
      severity: 'unsupported',
      path,
    });
  }

  const paddingAngle =
    typeof mark.padAngle === 'number' ? mark.padAngle * DEGREES_PER_RADIAN : undefined;

  const series: CompiledUnit['series'] = [
    {
      type: 'pie',
      data,
      ...(typeof mark.innerRadius === 'number' ? { innerRadius: mark.innerRadius } : {}),
      ...(typeof mark.outerRadius === 'number' ? { outerRadius: mark.outerRadius } : {}),
      ...(paddingAngle !== undefined ? { paddingAngle } : {}),
      ...(typeof mark.cornerRadius === 'number' ? { cornerRadius: mark.cornerRadius } : {}),
    },
  ];

  return { series, plots: ['pie'] };
}
