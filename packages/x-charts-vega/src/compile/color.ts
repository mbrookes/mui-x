import {
  rainbowSurgePaletteLight,
  rainbowSurgePaletteDark,
  blueberryTwilightPaletteLight,
  blueberryTwilightPaletteDark,
  mangoFusionPaletteLight,
  cheerfulFiestaPaletteLight,
  cheerfulFiestaPaletteDark,
  bluePaletteLight,
  greenPaletteLight,
  orangePaletteLight,
  purplePaletteLight,
  redPaletteLight,
  strawberrySkyPaletteLight,
} from '@mui/x-charts/colorPalettes';
import type { DatasetRow, VegaEncoding, VegaFieldDef, VegaScale } from '../types';
import { isFieldDef, isValueDef } from '../types';
import type { GapCollector } from '../gaps';

/*
 * Color-channel resolution.
 *
 * OWNERSHIP: the "color, legend & tooltip" work unit owns this file.
 *
 * Distinguishes the cases mark compilers need: static color, split-by-field
 * (with optional explicit/scheme-derived range), continuous/binned color
 * (surfaced as a ready-to-use axis `colorMap`), or none. Untranslatable
 * features (unknown schemes, conditional defs, legend position config,
 * fill/stroke collisions, field-driven opacity) degrade gracefully and are
 * reported through `gaps` instead of throwing.
 */

/**
 * Structurally mirrors `@mui/x-charts`' `ContinuousColorConfig`. That type
 * isn't re-exported from a subpath this package can import under
 * `@mui/x-charts`'s `exports` map (only whole-folder `index.ts` barrels are
 * reachable), so it's redeclared here — an `XAxis`/`YAxis` consumer can pass
 * this value straight through to its `colorMap` prop.
 */
export interface ContinuousColorMapConfig {
  type: 'continuous';
  min?: number | Date;
  max?: number | Date;
  color: readonly [string, string];
}

/** Structurally mirrors `@mui/x-charts`' `PiecewiseColorConfig`; see above. */
export interface PiecewiseColorMapConfig {
  type: 'piecewise';
  thresholds: Array<number | Date>;
  colors: string[];
}

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
  /**
   * Ready-to-use axis `colorMap` for continuous/binned quantitative or
   * temporal color fields. Consumers should be aware that only some
   * x-charts series types honor axis `colorMap` — see the accompanying gap.
   */
  colorMap?: ContinuousColorMapConfig | PiecewiseColorMapConfig;
}

/** Common Vega-Lite categorical scheme names mapped to x-charts palettes. */
const CATEGORICAL_SCHEME_PALETTES: Record<string, readonly string[]> = {
  category10: mangoFusionPaletteLight,
  category20: mangoFusionPaletteLight,
  category20b: mangoFusionPaletteLight,
  category20c: mangoFusionPaletteLight,
  tableau10: cheerfulFiestaPaletteLight,
  tableau20: cheerfulFiestaPaletteLight,
  accent: blueberryTwilightPaletteLight,
  dark2: blueberryTwilightPaletteDark,
  set1: rainbowSurgePaletteLight,
  set2: rainbowSurgePaletteLight,
  set3: rainbowSurgePaletteDark,
  paired: cheerfulFiestaPaletteDark,
};

const DEFAULT_BLUE_RANGE: readonly [string, string] = [
  bluePaletteLight[0],
  bluePaletteLight[bluePaletteLight.length - 1],
];

/** Common Vega-Lite sequential/multi-hue scheme names mapped to endpoints. */
const SEQUENTIAL_SCHEME_RANGES: Record<string, readonly [string, string]> = {
  blues: [bluePaletteLight[0], bluePaletteLight[bluePaletteLight.length - 1]],
  greens: [greenPaletteLight[0], greenPaletteLight[greenPaletteLight.length - 1]],
  oranges: [orangePaletteLight[0], orangePaletteLight[orangePaletteLight.length - 1]],
  purples: [purplePaletteLight[0], purplePaletteLight[purplePaletteLight.length - 1]],
  reds: [redPaletteLight[0], redPaletteLight[redPaletteLight.length - 1]],
  // Multi-hue / perceptually-uniform schemes have no monochromatic x-charts
  // equivalent; approximate with the closest multi-hue sequential palette.
  viridis: [
    strawberrySkyPaletteLight[0],
    strawberrySkyPaletteLight[strawberrySkyPaletteLight.length - 1],
  ],
  plasma: [
    strawberrySkyPaletteLight[0],
    strawberrySkyPaletteLight[strawberrySkyPaletteLight.length - 1],
  ],
  inferno: [
    strawberrySkyPaletteLight[0],
    strawberrySkyPaletteLight[strawberrySkyPaletteLight.length - 1],
  ],
  magma: [
    strawberrySkyPaletteLight[0],
    strawberrySkyPaletteLight[strawberrySkyPaletteLight.length - 1],
  ],
  turbo: [
    strawberrySkyPaletteLight[0],
    strawberrySkyPaletteLight[strawberrySkyPaletteLight.length - 1],
  ],
  rainbow: [
    strawberrySkyPaletteLight[0],
    strawberrySkyPaletteLight[strawberrySkyPaletteLight.length - 1],
  ],
  sinebow: [
    strawberrySkyPaletteLight[0],
    strawberrySkyPaletteLight[strawberrySkyPaletteLight.length - 1],
  ],
};

function schemeNameOf(scheme: VegaScale['scheme']): string | undefined {
  if (!scheme) {
    return undefined;
  }
  if (typeof scheme === 'string') {
    return scheme.toLowerCase();
  }
  return scheme.name?.toLowerCase();
}

const HEX_COLOR_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Whether `color` is a hex string `hexToRgb` can parse (not a CSS named color, `rgb()`, etc). */
function isHexColor(color: string): boolean {
  return HEX_COLOR_RE.test(color.trim());
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(255, v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Evenly spaced colors along the low→high linear RGB ramp, `count` >= 1.
 * `low`/`high` may come straight from a user-supplied `scale.range` (e.g.
 * CSS named colors like `'steelblue'`), which `hexToRgb` cannot parse —
 * `parseInt` would return `NaN`, and JS bitwise ops silently coerce `NaN` to
 * `0`, producing a bogus black-anchored ramp instead of an error. Guard by
 * falling back to a hard split between the two endpoint colors when either
 * one isn't parseable hex.
 */
function interpolateColors(low: string, high: string, count: number): string[] {
  if (count <= 1) {
    return [low];
  }
  if (!isHexColor(low) || !isHexColor(high)) {
    return Array.from({ length: count }, (_, i) => (i < count / 2 ? low : high));
  }
  const [r1, g1, b1] = hexToRgb(low);
  const [r2, g2, b2] = hexToRgb(high);
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    return rgbToHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
  });
}

function isBinnedField(fieldDef: VegaFieldDef): boolean {
  return fieldDef.bin === true || fieldDef.bin === 'binned' || typeof fieldDef.bin === 'object';
}

/**
 * Resolves a quantitative/temporal color field to an axis `colorMap`
 * (continuous, or piecewise when binned) computed from the data extent and
 * the requested/default scheme. Always records a `partial` gap: only some
 * x-charts series types consume axis `colorMap`, and this wrapper's mark
 * compilers may not wire it up for every mark yet.
 */
function resolveContinuousColorMap(
  fieldDef: VegaFieldDef,
  rows: readonly DatasetRow[],
  gaps: GapCollector,
  path: string,
  options?: ResolveColorOptions,
): ContinuousColorMapConfig | PiecewiseColorMapConfig | undefined {
  const { field } = fieldDef;
  const isTemporal = fieldDef.type === 'temporal';
  const scale = fieldDef.scale ?? undefined;
  const schemeName = schemeNameOf(scale?.scheme);
  const explicitRange = Array.isArray(scale?.range) ? (scale?.range as string[]) : undefined;

  let low: string;
  let high: string;
  if (explicitRange && explicitRange.length >= 2) {
    [low, high] = [explicitRange[0], explicitRange[explicitRange.length - 1]];
  } else {
    const mapped = (schemeName && SEQUENTIAL_SCHEME_RANGES[schemeName]) || DEFAULT_BLUE_RANGE;
    [low, high] = mapped;
  }
  if (scale?.reverse) {
    [low, high] = [high, low];
  }

  const binned = isBinnedField(fieldDef);

  let min: number | undefined;
  let max: number | undefined;
  if (Array.isArray(scale?.domain) && scale.domain.length === 2) {
    const [a, b] = scale.domain as unknown[];
    min = isTemporal ? new Date(a as string | number | Date).getTime() : Number(a);
    max = isTemporal ? new Date(b as string | number | Date).getTime() : Number(b);
  } else if (field) {
    const values = rows
      .map((row) => row[field])
      .filter((value): value is NonNullable<typeof value> => value !== null && value !== undefined)
      .map((value) =>
        isTemporal ? new Date(value as string | number | Date).getTime() : Number(value),
      )
      .filter((value) => Number.isFinite(value));
    if (values.length > 0) {
      min = Math.min(...values);
      max = Math.max(...values);
    }
  }

  // Callers that actually wire the colorMap into an axis (heatmaps, maps)
  // suppress this caveat — the approximation warning only applies to marks
  // that fall back to a single series color.
  if (!options?.colorMapConsumed) {
    gaps.add({
      code: binned ? 'encoding:color-binned' : 'encoding:color-continuous',
      message: binned
        ? "Binned quantitative color fields map to a piecewise axis `colorMap`, but only some x-charts series types honor axis `colorMap` — marks that don't consume it fall back to a single series color."
        : "Continuous color encodings map to a continuous axis `colorMap` computed from the data extent, but only some x-charts series types honor axis `colorMap` — marks that don't consume it fall back to a single series color.",
      severity: 'partial',
      path: `${path}.encoding.color`,
    });
  }

  if (
    min === undefined ||
    max === undefined ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min === max
  ) {
    return undefined;
  }

  const toDomainValue = (value: number): number | Date => (isTemporal ? new Date(value) : value);

  if (binned) {
    const binParams = typeof fieldDef.bin === 'object' ? fieldDef.bin : undefined;
    const bandCount = Math.max(2, binParams?.maxbins ?? 5);
    const colors = interpolateColors(low, high, bandCount);
    const thresholds: Array<number | Date> = [];
    for (let i = 1; i < bandCount; i += 1) {
      thresholds.push(toDomainValue(min + (max - min) * (i / bandCount)));
    }
    return { type: 'piecewise', thresholds, colors };
  }

  return {
    type: 'continuous',
    min: toDomainValue(min),
    max: toDomainValue(max),
    color: [low, high],
  };
}

export interface ResolveColorOptions {
  /**
   * Set by callers that feed the returned `colorMap` into a real color axis
   * (heatmap zAxis, map color axis): suppresses the "only some series types
   * honor colorMap" partial gap, which would be misleading there.
   */
  colorMapConsumed?: boolean;
}

export function resolveColor(
  encoding: VegaEncoding,
  rows: readonly DatasetRow[],
  gaps: GapCollector,
  path: string,
  options?: ResolveColorOptions,
): ColorResolution {
  // fill vs stroke: `color` always wins; between `fill` and `stroke` the
  // former wins (see the `??` chain below) — record the loser as ignored.
  if (encoding.fill && encoding.stroke) {
    gaps.add({
      code: 'encoding:color-fill-stroke-conflict',
      message:
        'Both `fill` and `stroke` color channels were specified; x-charts series support a single color source, so `stroke` was ignored in favor of `fill`.',
      severity: 'ignored',
      path: `${path}.encoding.stroke`,
    });
  }

  // opacity/fillOpacity: value defs apply silently (no x-charts equivalent
  // needed beyond a static value, which mark compilers may read directly
  // from the spec); field-driven opacity has no x-charts per-point mapping.
  // `fillOpacity` isn't a named property of `VegaEncoding` (only caught by its
  // general `[key: string]: unknown` index signature), hence the cast.
  const opacityChannels: Array<{ name: 'opacity' | 'fillOpacity'; def: VegaEncoding['opacity'] }> =
    [
      { name: 'opacity', def: encoding.opacity },
      { name: 'fillOpacity', def: encoding.fillOpacity as VegaEncoding['opacity'] },
    ];
  opacityChannels.forEach(({ name, def: opacityDef }) => {
    if (opacityDef && !Array.isArray(opacityDef) && isFieldDef(opacityDef)) {
      gaps.add({
        code: 'encoding:opacity-field-unsupported',
        message: `Field-driven \`${name}\` has no x-charts per-point opacity equivalent and was dropped.`,
        severity: 'unsupported',
        path: `${path}.encoding.${name}`,
      });
    }
  });

  const def = encoding.color ?? encoding.fill ?? encoding.stroke;
  if (!def || Array.isArray(def)) {
    return { hasLegend: false };
  }

  if ((def as { condition?: unknown }).condition) {
    gaps.add({
      code: 'encoding:color-condition-unsupported',
      message:
        'Conditional color encodings (`condition`) have no x-charts equivalent; the base `value`/`field` was used instead and the condition branches were dropped.',
      severity: 'unsupported',
      path: `${path}.encoding.color`,
    });
  }

  if (isValueDef(def)) {
    return {
      staticColor: typeof def.value === 'string' ? def.value : undefined,
      hasLegend: false,
    };
  }

  if (isFieldDef(def)) {
    const fieldDef = def as VegaFieldDef;
    const { type } = fieldDef;
    if (type === 'quantitative' || type === 'temporal') {
      const colorMap = resolveContinuousColorMap(fieldDef, rows, gaps, path, options);
      return { hasLegend: false, colorMap };
    }

    const scale = fieldDef.scale ?? undefined;
    const explicitRange = Array.isArray(scale?.range) ? (scale?.range as string[]) : undefined;
    const schemeName = schemeNameOf(scale?.scheme);
    let range = explicitRange;
    if (!range && schemeName) {
      const mapped = CATEGORICAL_SCHEME_PALETTES[schemeName];
      if (mapped) {
        range = [...mapped];
      } else {
        gaps.add({
          code: 'encoding:color-scheme-unknown',
          message: `Vega color scheme "${schemeName}" has no mapped x-charts categorical palette; falling back to the chart's default palette.`,
          severity: 'partial',
          path: `${path}.encoding.color.scale.scheme`,
        });
      }
    }

    const domain = Array.isArray(scale?.domain) ? scale?.domain : undefined;
    if (domain && range && domain.length !== range.length) {
      gaps.add({
        code: 'encoding:color-domain-range-mismatch',
        message: `Color scale \`domain\` (${domain.length} values) and \`range\` (${range.length} colors) lengths differ; colors may not align with the intended categories.`,
        severity: 'partial',
        path: `${path}.encoding.color.scale`,
      });
    }

    const legend = fieldDef.legend;
    if (legend && typeof legend === 'object' && Object.keys(legend).length > 0) {
      gaps.add({
        code: 'encoding:color-legend-config-ignored',
        message:
          'Legend configuration (e.g. `orient`, `title`) has no x-charts per-spec equivalent; a default legend is shown instead.',
        severity: 'ignored',
        path: `${path}.encoding.color.legend`,
      });
    }

    return {
      splitField: fieldDef.field,
      domain,
      range,
      hasLegend: fieldDef.legend !== null,
    };
  }

  return { hasLegend: false };
}
