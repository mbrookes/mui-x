import type {
  AxisResolution,
  CompiledUnit,
  OverlayTextItem,
  UnitContext,
} from '../compile/context';
import type { DatasetRow, VegaFieldDef, VegaMarkDef } from '../types';
import { isDatumDef, isFieldDef, isValueDef } from '../types';
import { toDate, toNumber } from '../compile/fieldTypes';

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

function buildTextStyle(mark: VegaMarkDef & TextMarkExtras): React.CSSProperties | undefined {
  const style: React.CSSProperties = {};
  if (typeof mark.fontSize === 'number') {
    style.fontSize = mark.fontSize;
  }
  if (typeof mark.font === 'string') {
    style.fontFamily = mark.font;
  }
  if (mark.fontWeight !== undefined) {
    style.fontWeight = mark.fontWeight as React.CSSProperties['fontWeight'];
  }
  if (typeof mark.color === 'string') {
    style.fill = mark.color;
  }
  if (typeof mark.align === 'string' && ALIGN_TO_ANCHOR[mark.align]) {
    style.textAnchor = ALIGN_TO_ANCHOR[mark.align] as React.CSSProperties['textAnchor'];
  }
  if (typeof mark.baseline === 'string' && BASELINE_TO_DOMINANT[mark.baseline]) {
    style.dominantBaseline = BASELINE_TO_DOMINANT[
      mark.baseline
    ] as React.CSSProperties['dominantBaseline'];
  }
  return Object.keys(style).length > 0 ? style : undefined;
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

  if (textDef && !Array.isArray(textDef)) {
    if ((textDef as { condition?: unknown }).condition !== undefined) {
      // Same convention as compile/color.ts's color-condition handling: the
      // base field/value is used, the condition branches are dropped.
      gaps.add({
        code: 'encoding:text-condition',
        message:
          'Conditional `text` encodings (`condition`) are not translated; the base `field`/`value` is used for every row and the condition branches were dropped.',
        severity: 'unsupported',
        path: `${path}.encoding.text.condition`,
      });
    }
    if (isFieldDef(textDef)) {
      const fieldDef = textDef as VegaFieldDef;
      textField = fieldDef.field;
      if (fieldDef.format) {
        gaps.add({
          code: 'encoding:text-format',
          message:
            'The `format` d3-format string on the `text` field is not translated; the raw field value is stringified instead.',
          severity: 'partial',
          path: `${path}.encoding.text.format`,
        });
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

    let text: string;
    if (textField !== undefined) {
      const raw = row[textField];
      if (raw == null) {
        return;
      }
      text = String(raw);
    } else {
      text = staticText as string;
    }

    items.push({
      x,
      y,
      text,
      ...(dx !== undefined ? { dx } : {}),
      ...(dy !== undefined ? { dy } : {}),
      ...(style !== undefined ? { style } : {}),
    });
  });

  return { series: [], plots: [], overlays: [{ kind: 'text', items }] };
}
