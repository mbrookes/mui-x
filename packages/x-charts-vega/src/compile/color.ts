import type { DatasetRow, VegaEncoding, VegaFieldDef } from '../types';
import { isFieldDef, isValueDef } from '../types';
import type { GapCollector } from '../gaps';

/*
 * Color-channel resolution.
 *
 * OWNERSHIP: the "color, legend & tooltip" work unit owns this file — extend
 * it with: custom `scale.range`/`scheme` handling, continuous color
 * (quantitative color fields → axis `colorMap` + ContinuousColorLegend),
 * ordinal color scales with explicit domains, `fill`/`stroke` channels,
 * opacity, and conditional value defs. The baseline below distinguishes the
 * three cases mark compilers need: static color, split-by-field, or none.
 */

export interface ColorResolution {
  /** Group rows by this field: one x-charts series per distinct value. */
  splitField?: string;
  /** Explicit domain order/colors when the spec provides them. */
  domain?: unknown[];
  range?: string[];
  /** A single static color for all marks of the layer. */
  staticColor?: string;
  /** Whether a legend is meaningful (a field is color-encoded). */
  hasLegend: boolean;
}

export function resolveColor(
  encoding: VegaEncoding,
  rows: readonly DatasetRow[],
  gaps: GapCollector,
  path: string,
): ColorResolution {
  const def = encoding.color ?? encoding.fill ?? encoding.stroke;
  if (!def || Array.isArray(def)) {
    return { hasLegend: false };
  }
  if (isValueDef(def)) {
    return {
      staticColor: typeof def.value === 'string' ? def.value : undefined,
      hasLegend: false,
    };
  }
  if (isFieldDef(def)) {
    const fieldDef = def as VegaFieldDef;
    const type = fieldDef.type;
    if (type === 'quantitative' || type === 'temporal') {
      gaps.add({
        code: 'encoding:color-continuous',
        message:
          'Continuous color encodings map to per-point colors, which x-charts only supports via axis `colorMap` on some series types. Rendered with a single series color instead.',
        severity: 'partial',
        path: `${path}.encoding.color`,
      });
      return { hasLegend: false };
    }
    const scale = fieldDef.scale ?? undefined;
    return {
      splitField: fieldDef.field,
      domain: Array.isArray(scale?.domain) ? scale?.domain : undefined,
      range: Array.isArray(scale?.range) ? (scale?.range as string[]) : undefined,
      hasLegend: fieldDef.legend !== null,
    };
  }
  return { hasLegend: false };
}
