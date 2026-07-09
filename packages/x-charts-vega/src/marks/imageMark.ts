import type { CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "text/image marks" work unit owns this file (small).
 *
 * Translate the `image` mark to a `{kind: 'image'}` overlay (rendered by
 * src/overlays/TextMarks.tsx):
 * - per row: position from x/y channels, image URL from the `url` channel
 *   (field def → row value, value def → constant — note `url` is an encoding
 *   channel in Vega-Lite, read it via the encoding's index signature);
 * - mark.width/mark.height (pixels; default ~20) → item width/height;
 * - mark.aspect → 'ignored' gap;
 * - return { series: [], plots: [], overlays: [{kind: 'image', items}] }.
 */
export function compileImageMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:image-not-implemented',
    message: 'The image mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
