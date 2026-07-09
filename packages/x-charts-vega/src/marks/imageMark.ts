import type { CompiledUnit, OverlayImageItem, UnitContext } from '../compile/context';
import type { VegaChannelDef, VegaMarkDef } from '../types';
import { isDatumDef, isFieldDef, isValueDef } from '../types';
import { resolveAxisValue } from './textMark';

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

/** Default pixel size for image marks (also the render-side fallback in overlays/TextMarks.tsx). */
export const DEFAULT_IMAGE_SIZE = 20;

/** Extra `image` mark properties Vega-Lite supports but `VegaMarkDef` doesn't declare by name. */
interface ImageMarkExtras {
  width?: number;
  height?: number;
  aspect?: boolean;
}

export function compileImageMark(ctx: UnitContext): CompiledUnit {
  const { unit, encoding, gaps, rows } = ctx;
  const path = unit.path;
  const mark = unit.mark as VegaMarkDef & ImageMarkExtras;

  if (!ctx.x?.field || !ctx.y?.field) {
    gaps.add({
      code: 'mark:image-missing-axis',
      message:
        'An image mark needs field-based x and y positional encodings to place its markers; a value/datum-only or missing positional channel means the layer was dropped.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  // `url` is an encoding channel in Vega-Lite but isn't a named property of
  // `VegaEncoding` (only reachable through its `[key: string]: unknown`
  // index signature).
  const urlDef = (encoding as Record<string, VegaChannelDef | undefined>).url;
  let urlField: string | undefined;
  let staticUrl: string | undefined;

  if (urlDef && !Array.isArray(urlDef)) {
    if ((urlDef as { condition?: unknown }).condition !== undefined) {
      // Same convention as compile/color.ts's color-condition handling: the
      // base field/value is used, the condition branches are dropped.
      gaps.add({
        code: 'encoding:url-condition',
        message:
          'Conditional `url` encodings (`condition`) are not translated; the base `field`/`value` is used for every row and the condition branches were dropped.',
        severity: 'unsupported',
        path: `${path}.encoding.url.condition`,
      });
    }
    if (isFieldDef(urlDef)) {
      urlField = urlDef.field;
    } else if (isValueDef(urlDef) && urlDef.value != null) {
      staticUrl = String(urlDef.value);
    } else if (isDatumDef(urlDef)) {
      staticUrl = String(urlDef.datum);
    }
  }

  if (urlField === undefined && staticUrl === undefined) {
    gaps.add({
      code: 'mark:image-missing-url',
      message:
        'An image mark needs a `url` encoding (field or constant value) to know what to render; the layer was dropped.',
      severity: 'unsupported',
      path: `${path}.encoding.url`,
    });
    return { series: [], plots: [] };
  }

  // Images always render stretched to exactly width x height
  // (preserveAspectRatio="none" in overlays/TextMarks.tsx). An explicit
  // `aspect: false` asks for exactly that, so only a truthy `aspect`
  // (a request to preserve the ratio) is worth reporting as ignored.
  if (mark.aspect !== undefined && mark.aspect !== false) {
    gaps.add({
      code: 'mark:image-aspect',
      message:
        'The `aspect` property (preserve aspect ratio while fitting width/height) is ignored; images render stretched to exactly mark.width x mark.height.',
      severity: 'ignored',
      path: `${path}.mark.aspect`,
    });
  }

  const width = typeof mark.width === 'number' ? mark.width : DEFAULT_IMAGE_SIZE;
  const height = typeof mark.height === 'number' ? mark.height : DEFAULT_IMAGE_SIZE;

  const items: OverlayImageItem[] = [];
  rows.forEach((row) => {
    const x = resolveAxisValue(ctx.x, row);
    const y = resolveAxisValue(ctx.y, row);
    if (x == null || y == null) {
      return;
    }

    let url: string;
    if (urlField !== undefined) {
      const raw = row[urlField];
      if (raw == null) {
        return;
      }
      url = String(raw);
    } else {
      url = staticUrl as string;
    }

    items.push({ x, y, url, width, height });
  });

  return { series: [], plots: [], overlays: [{ kind: 'image', items }] };
}
