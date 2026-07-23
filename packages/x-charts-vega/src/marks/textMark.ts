import type {
  AxisResolution,
  CompiledUnit,
  OverlayRadialLabelItem,
  OverlayTextItem,
  UnitContext,
} from '../compile/context';
import type { DatasetRow, VegaFieldDef, VegaMarkDef } from '../types';
import { isDatumDef, isFieldDef, isValueDef } from '../types';
import { resolveColor } from '../compile/color';
import { resolveFieldType, toDate, toNumber } from '../compile/fieldTypes';
import { compileTestConditions } from '../compile/params';
import { createValueFormatter } from '../format';
import { compileExpression, UnsupportedExpressionError } from '../transforms/calculate';

/*
 * OWNERSHIP: the "text/image marks" work unit owns this file.
 *
 * Translate the `text` mark to a `{kind: 'text'}` overlay (rendered by
 * src/overlays/TextMarks.tsx):
 * - per row: position from the x/y channels (data space; both may be
 *   categorical or continuous), label from the `text` channel (field def →
 *   row value stringified, value def → constant);
 * - mark.dx/dy → pixel offsets; mark.fontSize/font/fontWeight/color/align/
 *   baseline → style (align → textAnchor: left→start/center→middle/
 *   right→end; baseline → dominantBaseline);
 * - `format` on the text field def → 'partial' gap (d3-format strings not
 *   translated);
 * - text marks are commonly layered over bars for value labels — layer
 *   flattening already handles it;
 * - return { series: [], plots: [], overlays: [{kind: 'text', items}] }.
 */

/** Extra `text` mark properties Vega-Lite supports but `VegaMarkDef` doesn't declare by name (`color` is already on the base type). */
interface TextMarkExtras {
  dx?: number | { expr: string };
  dy?: number | { expr: string };
  fontSize?: number;
  font?: string;
  fontWeight?: string | number;
  align?: 'left' | 'center' | 'right' | (string & {});
  baseline?: 'top' | 'middle' | 'bottom' | (string & {});
}

const ALIGN_TO_ANCHOR: Record<string, string> = {
  left: 'start',
  center: 'middle',
  right: 'end',
};

const BASELINE_TO_DOMINANT: Record<string, string> = {
  top: 'hanging',
  middle: 'middle',
  bottom: 'auto',
};

/**
 * Same axis-value resolution as marks/point.ts: coerces to the axis' resolved
 * field type. Shared with marks/imageMark.ts (both files belong to the
 * text/image work unit; point.ts keeps its own copy to respect file
 * ownership boundaries).
 */
export function resolveAxisValue(
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

// Vega's default text-mark font size (`config.text.fontSize`); the SVG
// overlay otherwise falls back to the browser's ~16px default, which reads
// noticeably larger than Vega-Lite's compact numeric/value labels.
const DEFAULT_TEXT_FONT_SIZE = 10;

function buildTextStyle(mark: VegaMarkDef & TextMarkExtras): React.CSSProperties {
  const style: React.CSSProperties = {};
  style.fontSize = typeof mark.fontSize === 'number' ? mark.fontSize : DEFAULT_TEXT_FONT_SIZE;
  if (typeof mark.font === 'string') {
    style.fontFamily = mark.font;
  }
  if (mark.fontWeight !== undefined) {
    style.fontWeight = mark.fontWeight as React.CSSProperties['fontWeight'];
  }
  if (typeof mark.color === 'string') {
    style.fill = mark.color;
  }
  // Vega-Lite text marks default to centered alignment (`align: 'center'`,
  // `baseline: 'middle'`); an unset channel must center rather than fall back
  // to SVG's left/alphabetic default, or value labels sit off to the side of
  // the point they annotate. An explicit align/baseline still wins.
  const anchor = typeof mark.align === 'string' ? ALIGN_TO_ANCHOR[mark.align] : undefined;
  style.textAnchor = (anchor ?? 'middle') as React.CSSProperties['textAnchor'];
  const baseline =
    typeof mark.baseline === 'string' ? BASELINE_TO_DOMINANT[mark.baseline] : undefined;
  style.dominantBaseline = (baseline ?? 'middle') as React.CSSProperties['dominantBaseline'];
  return style;
}

/**
 * Resolves a `mark.dx`/`mark.dy` offset, which Vega-Lite allows to be either a
 * constant number or a per-row signal expression (`{expr: 'datum.someField'}`
 * — e.g. computed by an earlier `calculate` transform). Returns a function
 * reading the (possibly per-row) offset, or `undefined` when the property is
 * absent or its expression could not be parsed (reported as a gap).
 */
function resolveOffsetProperty(
  value: number | { expr: string } | undefined,
  gaps: UnitContext['gaps'],
  path: string,
  propName: 'dx' | 'dy',
): ((row: DatasetRow) => number | undefined) | undefined {
  if (typeof value === 'number') {
    return () => value;
  }
  if (value && typeof value === 'object' && typeof value.expr === 'string') {
    let evaluate: (datum: DatasetRow) => unknown;
    try {
      evaluate = compileExpression(value.expr);
    } catch (err) {
      if (!(err instanceof UnsupportedExpressionError)) {
        throw err;
      }
      gaps.add({
        code: 'mark:text-offset-expr',
        message: `The text mark's \`${propName}\` expression "${value.expr}" could not be parsed (${err.message}); no ${propName} offset is applied.`,
        severity: 'partial',
        path: `${path}.mark.${propName}`,
      });
      return undefined;
    }
    return (row) => {
      const result = evaluate(row);
      return typeof result === 'number' && Number.isFinite(result) ? result : undefined;
    };
  }
  return undefined;
}

const FULL_CIRCLE = 2 * Math.PI;

/**
 * A text mark with `mark.radiusOffset` and no positional `x`/`y` fields is a
 * label layer for a `radius`-encoded arc mark ("coxcomb" chart, see
 * arc.ts's `compileRadialArcMark`) — a separate unit sharing the same
 * `theta`/`radius`/`color` encoding. Recomputes the identical stacked-angle
 * math independently (same rows, same deterministic default-ascending sort)
 * rather than threading it through from arc.ts, so each mark compiler still
 * only touches its own unit. Returns `undefined` (falling back to the
 * ordinary missing-axis gap) when there's no usable `theta`/`radius` pair —
 * simpler than arc.ts's version, it doesn't honor an `order` channel, since
 * neither gallery spec that reaches this path sets one.
 */
function compilePolarTextLabels(ctx: UnitContext): CompiledUnit | undefined {
  const { unit, encoding, rows } = ctx;
  const mark = unit.mark as VegaMarkDef & TextMarkExtras & { radiusOffset?: number };
  if (typeof mark.radiusOffset !== 'number') {
    return undefined;
  }
  const thetaDef = encoding.theta;
  const radiusDef = encoding.radius;
  const thetaField =
    thetaDef && !Array.isArray(thetaDef) && isFieldDef(thetaDef) ? thetaDef.field : undefined;
  const radiusField =
    radiusDef && !Array.isArray(radiusDef) && isFieldDef(radiusDef) ? radiusDef.field : undefined;
  if (!thetaField || !radiusField) {
    return undefined;
  }
  const textDef = encoding.text;
  const textField =
    textDef && !Array.isArray(textDef) && isFieldDef(textDef) ? textDef.field : undefined;
  if (!textField) {
    return undefined;
  }

  const color = resolveColor(encoding, rows, ctx.gaps, unit.path);
  interface Slice {
    thetaValue: number;
    radiusValue: number;
    colorKey: string;
    text: string;
  }
  const slices: Slice[] = [];
  rows.forEach((row) => {
    const thetaValue = toNumber(row[thetaField]);
    const radiusValue = toNumber(row[radiusField]);
    const rawText = row[textField];
    if (thetaValue == null || radiusValue == null || rawText == null) {
      return;
    }
    const rawKey = color.splitField ? row[color.splitField] : undefined;
    const colorKey = rawKey != null ? String(rawKey) : '';
    slices.push({ thetaValue, radiusValue, colorKey, text: String(rawText) });
  });
  if (slices.length === 0) {
    return undefined;
  }

  const domain = color.domain?.map(String);
  const ordered = domain
    ? [...slices].sort((a, b) => domain.indexOf(a.colorKey) - domain.indexOf(b.colorKey))
    : [...slices].sort((a, b) => {
        const an = Number(a.colorKey);
        const bn = Number(b.colorKey);
        return Number.isFinite(an) && Number.isFinite(bn)
          ? an - bn
          : a.colorKey.localeCompare(b.colorKey);
      });

  const total = ordered.reduce((sum, slice) => sum + slice.thetaValue, 0);
  if (!(total > 0)) {
    return undefined;
  }

  const range = color.range;
  let cursor = 0;
  const items: OverlayRadialLabelItem[] = ordered.map((slice) => {
    const startAngle = (cursor / total) * FULL_CIRCLE;
    cursor += slice.thetaValue;
    const endAngle = (cursor / total) * FULL_CIRCLE;
    let itemColor = color.staticColor;
    if (!itemColor && range && range.length > 0 && domain) {
      const domainIndex = domain.indexOf(slice.colorKey);
      itemColor = domainIndex >= 0 ? range[domainIndex % range.length] : undefined;
    }
    return {
      angle: (startAngle + endAngle) / 2,
      radiusValue: slice.radiusValue,
      text: slice.text,
      color: itemColor,
    };
  });

  const radiusScaleConfig = (radiusDef as VegaFieldDef).scale as
    { type?: string; domain?: unknown[]; zero?: boolean; rangeMin?: number } | null | undefined;
  const scaleType =
    radiusScaleConfig?.type === 'linear' || radiusScaleConfig?.type === 'pow'
      ? radiusScaleConfig.type
      : 'sqrt';
  const explicitDomain =
    Array.isArray(radiusScaleConfig?.domain) && radiusScaleConfig.domain.length === 2
      ? (radiusScaleConfig.domain as [number, number])
      : undefined;
  const dataMax = ordered.reduce((max, slice) => Math.max(max, slice.radiusValue), 0);
  const dataMin = ordered.reduce((min, slice) => Math.min(min, slice.radiusValue), dataMax);
  const domainMin =
    explicitDomain?.[0] ?? (radiusScaleConfig?.zero === false ? dataMin : Math.min(0, dataMin));
  const domainMax = explicitDomain?.[1] ?? dataMax;
  const radiusRangeMin =
    typeof radiusScaleConfig?.rangeMin === 'number' ? radiusScaleConfig.rangeMin : 0;

  ctx.gaps.add({
    code: 'mark:text-radial-custom-overlay',
    message:
      'x-charts has no native text-mark primitive; radial labels are drawn by a custom SVG overlay instead of an x-charts series.',
    severity: 'ignored',
    path: unit.path,
  });

  return {
    series: [],
    plots: [],
    overlays: [
      {
        kind: 'radialLabels',
        items,
        radiusScaleType: scaleType,
        radiusDomain: [domainMin, domainMax],
        radiusRangeMin,
        radiusOffset: mark.radiusOffset,
      },
    ],
  };
}

/**
 * Compiles a `text` mark whose position comes from `longitude`/`latitude`
 * channels instead of `x`/`y` — per-row labels positioned by the geo chart's
 * own projection via a `{kind: 'geoText'}` overlay (`overlays/GeoText.tsx`)
 * instead of `useXScale`/`useYScale` (e.g. `geo_text`'s city-name labels
 * beside each state-capital marker). A simplified sibling of the cartesian
 * path above: static or field `text` (with `format`), `mark.dx`/`dy`, and
 * `mark.color`; conditional `text`/`color` encodings and a field-based color
 * scale are not attempted here (rarer on a geo label layer) and fall back to
 * the base text/color, matching the cartesian path's own `encoding:text-*`/
 * `encoding:text-color-field` fallback behavior for those same shapes.
 */
function compileGeoTextMark(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const path = unit.path;
  const mark = unit.mark as VegaMarkDef & TextMarkExtras;
  const lonField = isFieldDef(encoding.longitude) ? encoding.longitude.field : undefined;
  const latField = isFieldDef(encoding.latitude) ? encoding.latitude.field : undefined;
  if (!lonField || !latField) {
    gaps.add({
      code: 'mark:text-geo-missing-fields',
      message:
        'A geo-projected text mark needs field-based `longitude` and `latitude` encodings to place its labels; a value/datum-only or missing channel means the layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  const textDef = encoding.text;
  let textField: string | undefined;
  let staticText: string | undefined;
  let fmt: ((value: unknown) => string) | null = null;
  if (textDef && !Array.isArray(textDef)) {
    if (isFieldDef(textDef)) {
      const fieldDef = textDef as VegaFieldDef;
      textField = fieldDef.field;
      if (fieldDef.format) {
        fmt = createValueFormatter(
          fieldDef.format,
          resolveFieldType(fieldDef, rows),
          fieldDef.formatType as string | undefined,
        );
      }
    } else if (isValueDef(textDef) && textDef.value != null) {
      staticText = String(textDef.value);
    } else if (isDatumDef(textDef)) {
      staticText = String(textDef.datum);
    }
  }
  if (textField === undefined && staticText === undefined) {
    gaps.add({
      code: 'mark:text-missing-channel',
      message:
        'A text mark needs a `text` encoding (field or constant value) to know what to render; the layer was dropped.',
      severity: 'unsupported',
      path: `${path}.encoding.text`,
    });
    return { series: [], plots: [] };
  }

  const colorDef = encoding.color;
  const baseColor = typeof mark.color === 'string' ? mark.color : undefined;
  const fieldColor =
    isValueDef(colorDef) && colorDef.value != null ? String(colorDef.value) : undefined;
  if (colorDef && !Array.isArray(colorDef) && isFieldDef(colorDef)) {
    gaps.add({
      code: 'encoding:text-color-field',
      message:
        'A field-based `color` encoding on a text mark (a continuous/categorical color scale) is not translated; the mark/base color is used for every label instead.',
      severity: 'unsupported',
      path: `${path}.encoding.color`,
    });
  }
  const fill = fieldColor ?? baseColor;
  const style = buildTextStyle(mark);
  const itemStyle = fill !== undefined ? { ...style, fill } : style;
  const dxResolver = resolveOffsetProperty(mark.dx, gaps, path, 'dx');
  const dyResolver = resolveOffsetProperty(mark.dy, gaps, path, 'dy');

  const items = rows
    .map((row) => {
      const lon = toNumber(row[lonField]);
      const lat = toNumber(row[latField]);
      if (lon == null || lat == null) {
        return null;
      }
      const raw = textField !== undefined ? row[textField] : staticText;
      if (raw == null) {
        return null;
      }
      let text: string;
      if (textField === undefined) {
        text = raw as string;
      } else {
        text = fmt ? fmt(raw) : String(raw);
      }
      const dx = dxResolver?.(row);
      const dy = dyResolver?.(row);
      return {
        lon,
        lat,
        text,
        ...(dx !== undefined ? { dx } : {}),
        ...(dy !== undefined ? { dy } : {}),
        ...(itemStyle !== undefined ? { style: itemStyle } : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (items.length === 0) {
    gaps.add({
      code: 'mark:text-geo-missing-fields',
      message:
        'No row had numeric `longitude`/`latitude` values (and a resolvable `text` value) to place a label at; the layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  gaps.add({
    code: 'mark:text-geo-projected-custom-overlay',
    message:
      "x-charts has no text-over-projection primitive; labels are drawn by a custom SVG overlay using the geo chart's own projection instead of an x-charts series.",
    severity: 'ignored',
    path,
  });
  return { series: [], plots: [], overlays: [{ kind: 'geoText', items }] };
}

export function compileTextMark(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const path = unit.path;
  const mark = unit.mark as VegaMarkDef & TextMarkExtras;

  // `longitude`/`latitude` (rather than `x`/`y`) means this is a geo-projected
  // text mark — positioned by the geo chart's projection, not a cartesian
  // axis. Checked before the x/y axis gate below, which would otherwise
  // always fail for these (there is no `x`/`y` encoding to resolve at all).
  if (isFieldDef(encoding.longitude) && isFieldDef(encoding.latitude)) {
    return compileGeoTextMark(ctx);
  }

  if (!ctx.x?.field || !ctx.y?.field) {
    const polar = compilePolarTextLabels(ctx);
    if (polar) {
      return polar;
    }
    gaps.add({
      code: 'mark:text-missing-axis',
      message:
        'A text mark needs field-based x and y positional encodings to place its labels; a value/datum-only or missing positional channel means the layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  const textDef = encoding.text;
  let textField: string | undefined;
  let staticText: string | undefined;
  let conditionResolver: ((row: DatasetRow) => unknown) | undefined;
  let fmt: ((value: unknown) => string) | null = null;

  if (textDef && !Array.isArray(textDef)) {
    const condition = (textDef as { condition?: unknown }).condition;
    if (condition !== undefined) {
      // Test-predicate conditions (`{test, value}`, first-match-wins) become a
      // per-row override; a param/field/unparseable condition returns no
      // resolver, in which case the base `field`/`value` is used for every row.
      conditionResolver = compileTestConditions(
        condition,
        ctx.signals,
        gaps,
        `${path}.encoding.text.condition`,
      );
      if (!conditionResolver) {
        gaps.add({
          code: 'encoding:text-condition',
          message:
            'This conditional `text` encoding (`condition`) could not be translated; the base `field`/`value` is used for every row and the condition branches were dropped.',
          severity: 'unsupported',
          path: `${path}.encoding.text.condition`,
        });
      }
    }
    if (isFieldDef(textDef)) {
      const fieldDef = textDef as VegaFieldDef;
      textField = fieldDef.field;
      if (fieldDef.format) {
        fmt = createValueFormatter(
          fieldDef.format,
          resolveFieldType(fieldDef, rows),
          fieldDef.formatType as string | undefined,
        );
        if (fmt === null) {
          gaps.add({
            code: 'encoding:text-format',
            message:
              'The `format` string on the `text` field could not be translated to a d3 number/time formatter (e.g. a nominal field without an explicit `formatType`, or an invalid pattern); the raw field value is stringified instead.',
            severity: 'partial',
            path: `${path}.encoding.text.format`,
          });
        }
      }
    } else if (isValueDef(textDef) && textDef.value != null) {
      staticText = String(textDef.value);
    } else if (isDatumDef(textDef)) {
      staticText = String(textDef.datum);
    }
  }

  if (textField === undefined && staticText === undefined) {
    gaps.add({
      code: 'mark:text-missing-channel',
      message:
        'A text mark needs a `text` encoding (field or constant value) to know what to render; the layer was dropped.',
      severity: 'unsupported',
      path: `${path}.encoding.text`,
    });
    return { series: [], plots: [] };
  }

  // A `color` encoding (rather than a static `mark.color`) is the idiomatic
  // way Vega-Lite gives a text-over-heatmap label enough contrast against its
  // cell: `{value: 'white', condition: {test: 'datum.count < 40', value:
  // 'black'}}`. The encoding takes precedence over `mark.color` when present
  // (it's the more specific, explicitly-authored channel); a data-driven
  // `field` color scale is a rarer case this doesn't attempt, so it's reported
  // instead of silently ignored like today.
  const colorDef = encoding.color;
  let baseColor: string | undefined = typeof mark.color === 'string' ? mark.color : undefined;
  let colorConditionResolver: ((row: DatasetRow) => unknown) | undefined;
  if (colorDef && !Array.isArray(colorDef)) {
    const colorCondition = (colorDef as { condition?: unknown }).condition;
    if (colorCondition !== undefined) {
      colorConditionResolver = compileTestConditions(
        colorCondition,
        ctx.signals,
        gaps,
        `${path}.encoding.color.condition`,
      );
      if (!colorConditionResolver) {
        gaps.add({
          code: 'encoding:text-color-condition',
          message:
            'This conditional `color` encoding (`condition`) on a text mark could not be translated; the base color is used for every label and the condition branches were dropped.',
          severity: 'unsupported',
          path: `${path}.encoding.color.condition`,
        });
      }
    }
    if (isValueDef(colorDef) && colorDef.value != null) {
      baseColor = String(colorDef.value);
    } else if (isFieldDef(colorDef)) {
      gaps.add({
        code: 'encoding:text-color-field',
        message:
          'A field-based `color` encoding on a text mark (a continuous/categorical color scale) is not translated; the mark/base color is used for every label instead.',
        severity: 'unsupported',
        path: `${path}.encoding.color`,
      });
    }
  }

  const style = buildTextStyle(mark);
  const dxResolver = resolveOffsetProperty(mark.dx, gaps, path, 'dx');
  const dyResolver = resolveOffsetProperty(mark.dy, gaps, path, 'dy');

  const items: OverlayTextItem[] = [];
  rows.forEach((row) => {
    const x = resolveAxisValue(ctx.x, row);
    const y = resolveAxisValue(ctx.y, row);
    if (x == null || y == null) {
      return;
    }

    let base: string;
    if (textField !== undefined) {
      const raw = row[textField];
      if (raw == null) {
        // Skip rows without a value unless a condition can supply one.
        if (!conditionResolver) {
          return;
        }
        base = '';
      } else {
        base = fmt ? fmt(raw) : String(raw);
      }
    } else {
      base = staticText as string;
    }

    const text = conditionResolver ? String(conditionResolver(row) ?? base) : base;

    const fill = colorConditionResolver
      ? ((colorConditionResolver(row) as string | undefined) ?? baseColor)
      : baseColor;
    const itemStyle = fill !== undefined ? { ...style, fill } : style;

    const dx = dxResolver?.(row);
    const dy = dyResolver?.(row);

    items.push({
      x,
      y,
      text,
      ...(dx !== undefined ? { dx } : {}),
      ...(dy !== undefined ? { dy } : {}),
      ...(itemStyle !== undefined ? { style: itemStyle } : {}),
    });
  });

  gaps.add({
    code: 'mark:text-custom-overlay',
    message:
      'x-charts has no native text-mark primitive; labels are drawn by a custom SVG overlay instead of an x-charts series.',
    severity: 'ignored',
    path,
  });

  return { series: [], plots: [], overlays: [{ kind: 'text', items }] };
}
