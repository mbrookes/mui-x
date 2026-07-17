import type {
  AxisResolution,
  CompiledUnit,
  OverlayTextItem,
  UnitContext,
} from '../compile/context';
import type { DatasetRow, VegaFieldDef, VegaMarkDef } from '../types';
import { isDatumDef, isFieldDef, isValueDef } from '../types';
import { resolveFieldType, toDate, toNumber } from '../compile/fieldTypes';
import { compileTestConditions } from '../compile/params';
import { createValueFormatter } from '../format';

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
  dx?: number;
  dy?: number;
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

export function compileTextMark(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const path = unit.path;
  const mark = unit.mark as VegaMarkDef & TextMarkExtras;

  if (!ctx.x?.field || !ctx.y?.field) {
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
  const dx = typeof mark.dx === 'number' ? mark.dx : undefined;
  const dy = typeof mark.dy === 'number' ? mark.dy : undefined;

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
