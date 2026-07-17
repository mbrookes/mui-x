import type { CompiledUnit, OverlayImageItem, UnitContext } from '../compile/context';
import type { DatasetRow, VegaChannelDef, VegaMarkDef } from '../types';
import { isDatumDef, isFieldDef, isValueDef } from '../types';
import { compileTestConditions } from '../compile/params';
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
 * - mark.aspect === false → item.aspect: false (stretch); otherwise the ratio
 *   is preserved (Vega-Lite's default), so nothing is recorded;
 * - `url` test-predicate conditions → per-row url override;
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
  let conditionResolver: ((row: DatasetRow) => unknown) | undefined;

  if (urlDef && !Array.isArray(urlDef)) {
    const condition = (urlDef as { condition?: unknown }).condition;
    if (condition !== undefined) {
      // Test-predicate conditions (`{test, value}`, first-match-wins) become a
      // per-row override; a param/field/unparseable condition returns no
      // resolver, in which case the base `field`/`value` is used for every row.
      conditionResolver = compileTestConditions(
        condition,
        ctx.signals,
        gaps,
        `${path}.encoding.url.condition`,
      );
      if (!conditionResolver) {
        gaps.add({
          code: 'encoding:url-condition',
          message:
            'This conditional `url` encoding (`condition`) could not be translated; the base `field`/`value` is used for every row and the condition branches were dropped.',
          severity: 'unsupported',
          path: `${path}.encoding.url.condition`,
        });
      }
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

  // Vega-Lite's `image` mark preserves the aspect ratio by default (`aspect:
  // true`); an explicit `aspect: false` stretches to exactly width x height.
  // The rendered item only records the non-default `false` request (consumed
  // by overlays/TextMarks.tsx's `preserveAspectRatio`).
  const stretch = mark.aspect === false;

  const width = typeof mark.width === 'number' ? mark.width : DEFAULT_IMAGE_SIZE;
  const height = typeof mark.height === 'number' ? mark.height : DEFAULT_IMAGE_SIZE;

  const items: OverlayImageItem[] = [];
  rows.forEach((row) => {
    const x = resolveAxisValue(ctx.x, row);
    const y = resolveAxisValue(ctx.y, row);
    if (x == null || y == null) {
      return;
    }

    let base: string;
    if (urlField !== undefined) {
      const raw = row[urlField];
      if (raw == null) {
        // Skip rows without a url unless a condition can supply one.
        if (!conditionResolver) {
          return;
        }
        base = '';
      } else {
        base = String(raw);
      }
    } else {
      base = staticUrl as string;
    }

    const url = conditionResolver ? String(conditionResolver(row) ?? base) : base;
    if (url === '') {
      return;
    }

    items.push({ x, y, url, width, height, ...(stretch ? { aspect: false } : {}) });
  });

  gaps.add({
    code: 'mark:image-custom-overlay',
    message:
      'x-charts has no native image-mark primitive; images are drawn by a custom SVG overlay instead of an x-charts series.',
    severity: 'ignored',
    path,
  });

  return { series: [], plots: [], overlays: [{ kind: 'image', items }] };
}
