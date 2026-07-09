import type { CompiledUnit, UnitContext } from '../compile/context';

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
export function compileTextMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:text-not-implemented',
    message: 'The text mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
