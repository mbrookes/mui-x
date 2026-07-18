import {
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
import { VEGA_CATEGORICAL_SCHEMES } from './vegaDefaults';

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
  // A two-color endpoint ramp (single-hue schemes) or an interpolator over a
  // multi-stop scheme (e.g. Vega-Lite's default `yellowgreenblue`). x-charts'
  // `ContinuousColorConfig.color` accepts both forms.
  color: readonly [string, string] | ((t: number) => string);
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
  /**
   * True when `domain` was derived from the data (ascending order) rather than
   * given explicitly by the spec. Stacked marks reverse their draw order for a
   * derived domain to reproduce Vega-Lite's descending-by-value stack sort; an
   * explicit, custom-ordered domain does not get that reversal.
   */
  domainDerived?: boolean;
  range?: string[];
  /** A single static color for all marks of the layer. */
  staticColor?: string;
  /**
   * `true` when the color field has an explicit `scale: null` ("identity"
   * encoding): `splitField`'s raw row values ARE the literal color to use —
   * callers should read each group's own value as its color directly rather
   * than indexing into `range`/the chart palette.
   */
  identity?: boolean;
  /** Whether a legend is meaningful (a field is color-encoded). */
  hasLegend: boolean;
  /**
   * Ready-to-use axis `colorMap` for continuous/binned quantitative or
   * temporal color fields. Consumers should be aware that only some
   * x-charts series types honor axis `colorMap` — see the accompanying gap.
   */
  colorMap?: ContinuousColorMapConfig | PiecewiseColorMapConfig;
}

/**
 * Common Vega-Lite scheme names mapped to x-charts palettes, for discrete
 * (nominal/ordinal) color fields.
 *
 * Three families are covered:
 * - True categorical schemes (`category*`, `tableau*`, `set*`, …) map to
 *   x-charts' multi-hue categorical palettes.
 * - Single-hue sequential schemes (`blues`, `greens`, …) are legal on discrete
 *   fields too; they map to x-charts' monochromatic ramps, which are already
 *   arrays of discrete swatches.
 * - Multi-hue / perceptually-uniform schemes (`viridis`, `magma`, …) have no
 *   monochromatic equivalent; they approximate to the multi-hue `strawberrySky`
 *   sequential palette (the same approximation the continuous branch uses).
 */
const CATEGORICAL_SCHEME_PALETTES: Record<string, readonly string[]> = {
  // True categorical schemes (`category*`, `tableau*`, `set*`, `accent`,
  // `dark2`, `paired`, `pastel*`) are reproduced exactly in
  // `VEGA_CATEGORICAL_SCHEMES` and looked up ahead of this table, so they are
  // intentionally absent here. Only the sequential/multi-hue approximations,
  // which have no exact discrete equivalent, remain below.
  // Single-hue sequential schemes used on discrete fields → monochromatic ramps.
  blues: bluePaletteLight,
  greens: greenPaletteLight,
  oranges: orangePaletteLight,
  purples: purplePaletteLight,
  reds: redPaletteLight,
  // Multi-hue / perceptually-uniform schemes → closest multi-hue palette.
  viridis: strawberrySkyPaletteLight,
  plasma: strawberrySkyPaletteLight,
  inferno: strawberrySkyPaletteLight,
  magma: strawberrySkyPaletteLight,
  cividis: strawberrySkyPaletteLight,
  turbo: strawberrySkyPaletteLight,
  rainbow: strawberrySkyPaletteLight,
  sinebow: strawberrySkyPaletteLight,
  spectral: strawberrySkyPaletteLight,
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

/**
 * Legend config keys that do not trigger the `color-legend-config-ignored` gap.
 * Only `orient` is actually acted on — the shell repositions the composed legend
 * from it (`resolveLegendLayout` in `VegaLiteChart.tsx`). `legendX`/`legendY` are
 * accepted here to suppress the gap (Vega often pairs them with `orient`), but
 * the shell does not read them, so an absolute legend offset is silently dropped.
 * Everything else (`title`, `values`, `symbolType`, gradient config, …) still
 * reports the gap and is unsupported.
 */
const HONORED_LEGEND_KEYS = new Set(['orient', 'legendX', 'legendY']);

/** Ascending comparison for a default color domain: numeric, then locale-aware. */
function compareColorValues(a: unknown, b: unknown): number {
  const numA = Number(a);
  const numB = Number(b);
  if (Number.isFinite(numA) && Number.isFinite(numB) && a !== '' && b !== '') {
    return numA - numB;
  }
  return String(a).localeCompare(String(b));
}

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

/**
 * Multi-hue sequential scheme stops (ColorBrewer, lowercased Vega-Lite scheme
 * names). Unlike the single-hue ramps in `SEQUENTIAL_SCHEME_RANGES`, these need
 * every stop to reproduce their hue progression, so they resolve to an
 * interpolator function rather than a two-color endpoint pair.
 */
const MULTI_STOP_SCHEME_STOPS: Record<string, readonly string[]> = {
  // Vega-Lite's default scheme for a continuous quantitative color field.
  yellowgreenblue: ['#ffffd9', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#081d58'],
  greenblue: ['#f7fcf0', '#ccebc5', '#a8ddb5', '#7bccc4', '#4eb3d3', '#2b8cbe', '#084081'],
  bluegreen: ['#f7fcfd', '#ccece6', '#99d8c9', '#66c2a4', '#41ae76', '#238b45', '#00441b'],
  yelloworangered: ['#ffffcc', '#ffeda0', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#800026'],
  yelloworangebrown: ['#ffffe5', '#fee391', '#fec44f', '#fe9929', '#ec7014', '#cc4c02', '#662506'],
  purpleblue: ['#fff7fb', '#d0d1e6', '#a6bddb', '#74a9cf', '#3690c0', '#0570b0', '#023858'],
  bluepurple: ['#f7fcfd', '#bfd3e6', '#9ebcda', '#8c96c6', '#8c6bb1', '#88419d', '#4d004b'],
  purplered: ['#f7f4f9', '#d4b9da', '#c994c7', '#df65b0', '#e7298a', '#ce1256', '#67001f'],
  // Perceptually-uniform multi-hue schemes (d3-scale-chromatic), sampled to 9
  // stops. Kept as ordered ramps — not the discrete multi-hue approximation in
  // CATEGORICAL_SCHEME_PALETTES — so both the continuous colorMap and an
  // ordinal/nominal field carrying one of these schemes trace the real dark→
  // light hue progression instead of a cycling categorical palette.
  magma: [
    '#000004',
    '#1c1044',
    '#4f127b',
    '#812581',
    '#b5367a',
    '#e55064',
    '#fb8761',
    '#fec287',
    '#fcfdbf',
  ],
  inferno: [
    '#000004',
    '#1b0c41',
    '#4a0c6b',
    '#781c6d',
    '#a52c60',
    '#cf4446',
    '#ed6925',
    '#fb9a06',
    '#fcffa4',
  ],
  plasma: [
    '#0d0887',
    '#47039f',
    '#7301a8',
    '#9c179e',
    '#bd3786',
    '#d8576b',
    '#ed7953',
    '#fa9e3b',
    '#fdc926',
  ],
  viridis: [
    '#440154',
    '#472d7b',
    '#3b528b',
    '#2c728e',
    '#21918c',
    '#28ae80',
    '#5ec962',
    '#addc30',
    '#fde725',
  ],
  cividis: [
    '#00204d',
    '#00336f',
    '#39486b',
    '#575d6d',
    '#707173',
    '#8a8779',
    '#a69d75',
    '#c4b56c',
    '#ffea46',
  ],
};

// Vega-Lite defaults a continuous quantitative color scale to `yellowgreenblue`.
const DEFAULT_CONTINUOUS_STOPS = MULTI_STOP_SCHEME_STOPS.yellowgreenblue;

/**
 * Builds a `(t: number) => color` interpolator over an ordered list of hex
 * stops via piecewise-linear RGB, clamping `t` to `[0, 1]`. Mirrors the RGB
 * math in `interpolateColors`; used for multi-hue schemes (and multi-stop
 * explicit ranges) x-charts' two-color `ContinuousColorConfig` can't express.
 */
function interpolatorFromStops(stops: readonly string[]): (t: number) => string {
  const rgb = stops.map((stop) => (isHexColor(stop) ? hexToRgb(stop) : null));
  return (input: number) => {
    const t = Math.max(0, Math.min(1, input));
    const scaled = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(scaled));
    const frac = scaled - i;
    const a = rgb[i];
    const b = rgb[i + 1];
    // A non-hex stop (e.g. a CSS named color) can't be interpolated numerically;
    // fall back to the nearer raw stop rather than a bogus NaN-derived color.
    if (!a || !b) {
      return stops[frac < 0.5 ? i : i + 1];
    }
    return rgbToHex([
      a[0] + (b[0] - a[0]) * frac,
      a[1] + (b[1] - a[1]) * frac,
      a[2] + (b[2] - a[2]) * frac,
    ]);
  };
}

/** Samples `count` evenly spaced colors from a multi-stop ramp (for binned/piecewise output). */
function sampleStops(stops: readonly string[], count: number): string[] {
  if (count <= 1) {
    return [stops[0]];
  }
  const interpolator = interpolatorFromStops(stops);
  return Array.from({ length: count }, (_, i) => interpolator(i / (count - 1)));
}

function isBinnedField(fieldDef: VegaFieldDef): boolean {
  return fieldDef.bin === true || fieldDef.bin === 'binned' || typeof fieldDef.bin === 'object';
}

/**
 * An ordered `count`-length swatch ramp for a *discrete* field (nominal/ordinal)
 * whose scheme is sequential/multi-hue (`magma`, `blues`, …). Vega-Lite samples
 * the scheme's interpolator at evenly spaced points across the domain, so the
 * swatches trace the scheme's real dark→light progression; the discrete
 * multi-hue palettes in `CATEGORICAL_SCHEME_PALETTES` only cycle a fixed set of
 * hues, which scrambles a sequential field's order. Returns `undefined` for a
 * genuinely categorical scheme (e.g. `tableau10`), which has no ordered ramp.
 */
function sampleDiscreteSchemeRamp(
  schemeName: string,
  reverse: boolean | undefined,
  count: number,
): string[] | undefined {
  let stops = MULTI_STOP_SCHEME_STOPS[schemeName] ?? SEQUENTIAL_SCHEME_RANGES[schemeName];
  if (!stops || count < 1) {
    return undefined;
  }
  if (reverse) {
    stops = stops.slice().reverse();
  }
  return stops.length > 2
    ? sampleStops(stops, count)
    : interpolateColors(stops[0], stops[stops.length - 1], count);
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

  // Resolve the color ramp as an ordered list of stops. A single-hue scheme (or
  // a two-color explicit range) yields two stops; a multi-hue scheme — including
  // Vega-Lite's default `yellowgreenblue` — or a multi-stop explicit range keeps
  // every stop so the hue progression survives.
  let stops: readonly string[];
  if (explicitRange && explicitRange.length >= 2) {
    stops = explicitRange;
  } else if (schemeName && MULTI_STOP_SCHEME_STOPS[schemeName]) {
    stops = MULTI_STOP_SCHEME_STOPS[schemeName];
  } else if (schemeName && SEQUENTIAL_SCHEME_RANGES[schemeName]) {
    stops = SEQUENTIAL_SCHEME_RANGES[schemeName];
  } else if (schemeName) {
    // An unknown named scheme still falls back to the single-hue blue endpoints.
    stops = DEFAULT_BLUE_RANGE;
  } else {
    stops = DEFAULT_CONTINUOUS_STOPS;
  }
  if (scale?.reverse) {
    stops = stops.slice().reverse();
  }
  const [low, high] = [stops[0], stops[stops.length - 1]];

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
    // Two-stop ramps use the RGB endpoint split; multi-stop ramps sample every
    // stop so the discrete bands trace the full hue progression.
    const colors =
      stops.length > 2 ? sampleStops(stops, bandCount) : interpolateColors(low, high, bandCount);
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
    // A two-stop ramp stays a plain endpoint pair (a simpler gradient x-charts
    // renders directly); a multi-hue ramp becomes an interpolator function.
    color: stops.length > 2 ? interpolatorFromStops(stops) : [low, high],
  };
}

export interface ResolveColorOptions {
  /**
   * Set by callers that feed the returned `colorMap` into a real color axis
   * (heatmap zAxis, map color axis): suppresses the "only some series types
   * honor colorMap" partial gap, which would be misleading there.
   */
  colorMapConsumed?: boolean;
  /**
   * Set by the geoshape caller, whose continuous color legend can honor a
   * `legend.format`/`formatType` (compiled to a `valueFormatter` and applied to
   * the legend's min/max labels). Suppresses the `color-legend-config-ignored`
   * gap for those keys — they are translated, not dropped.
   */
  legendFormatHonored?: boolean;
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
        'Conditional color encodings (`condition`) have no x-charts equivalent: an x-charts series is drawn in a single color, so a per-row test-predicate color cannot be applied (unlike `text`/`url` conditions, which this wrapper does resolve per row). The base `value`/`field` was used instead and the condition branches were dropped.',
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
    // `scale: null` is Vega-Lite's "identity" escape hatch: the field's raw
    // row values (typically pre-computed CSS/hex color strings from a
    // `calculate` transform) are used directly as the visual color, with no
    // scale/domain/legend involved at all. Handled before the quantitative/
    // categorical branches below, which would otherwise treat every distinct
    // raw value as its own domain entry needing a palette-assigned color.
    if (fieldDef.scale === null) {
      return { splitField: fieldDef.field, identity: true, hasLegend: false };
    }
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
      const mapped =
        VEGA_CATEGORICAL_SCHEMES[schemeName] ?? CATEGORICAL_SCHEME_PALETTES[schemeName];
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

    const explicitDomain = Array.isArray(scale?.domain) ? (scale?.domain as unknown[]) : undefined;
    let domain = explicitDomain;
    // Whether `domain` is the plain ascending order we derived from the data
    // (as opposed to an explicit `scale.domain` or an explicit channel `sort`).
    // Only that ascending-derived order lets a stacked mark reverse its draw
    // order to reproduce Vega-Lite's descending-by-value stack sort.
    let domainDerived = false;
    // Vega-Lite orders a nominal/ordinal color legend — and therefore the
    // series → color assignment — ascending by default. When the spec gives
    // neither an explicit `scale.domain` nor a channel `sort`, derive that
    // default domain from the data so the color mapping matches the reference
    // renderer instead of following first-seen data order. `sort: null` keeps
    // data order; an explicit `sort` array is used verbatim.
    if (!domain && fieldDef.field) {
      const sortSpec = (fieldDef as { sort?: unknown }).sort;
      if (Array.isArray(sortSpec)) {
        domain = sortSpec;
      } else if (sortSpec !== null) {
        domainDerived = sortSpec === undefined || sortSpec === 'ascending';
        const seen = new Set<string>();
        const distinct: unknown[] = [];
        for (const row of rows) {
          const value = row[fieldDef.field];
          if (value == null) {
            continue;
          }
          const key = String(value);
          if (!seen.has(key)) {
            seen.add(key);
            distinct.push(value);
          }
        }
        distinct.sort(compareColorValues);
        if (sortSpec === 'descending') {
          distinct.reverse();
        }
        // Leave the domain unset when no rows carry a value to order (e.g. an
        // encoding resolved without rows), so downstream code keeps its
        // data-order path rather than seeing an empty explicit domain. Rows with
        // a missing color value form groups not listed here; the mark compilers
        // append those leftover groups so no data is dropped.
        domain = distinct.length > 0 ? distinct : undefined;
      }
    }

    // A sequential/multi-hue scheme on a discrete field (e.g. co2's `magma`
    // decade ramp) samples the scheme interpolator across the domain rather
    // than picking cycling categorical swatches. Do this once the domain size
    // is known, overriding the discrete-palette `range` resolved above; a
    // genuinely categorical scheme (tableau, category10) returns undefined here
    // and keeps its palette.
    if (!explicitRange && schemeName && domain && domain.length > 0) {
      const ramp = sampleDiscreteSchemeRamp(schemeName, scale?.reverse, domain.length);
      if (ramp) {
        range = ramp;
      }
    }
    // Only warn when the spec's *explicit* domain and range lengths disagree.
    // A domain we derived from the data legitimately exceeds a fixed palette
    // (Vega cycles the scheme in that case), so it must not trip this gap.
    if (explicitDomain && range && explicitDomain.length !== range.length) {
      gaps.add({
        code: 'encoding:color-domain-range-mismatch',
        message: `Color scale \`domain\` (${explicitDomain.length} values) and \`range\` (${range.length} colors) lengths differ; colors may not align with the intended categories.`,
        severity: 'partial',
        path: `${path}.encoding.color.scale`,
      });
    }

    const legend = fieldDef.legend;
    if (legend && typeof legend === 'object') {
      // `orient` (and the positional offsets) are honored by the shell, which
      // repositions the default legend — only gap the still-unsupported keys.
      const honoredHere = options?.legendFormatHonored
        ? new Set([...HONORED_LEGEND_KEYS, 'format', 'formatType'])
        : HONORED_LEGEND_KEYS;
      const unsupportedKeys = Object.keys(legend).filter((key) => !honoredHere.has(key));
      if (unsupportedKeys.length > 0) {
        gaps.add({
          code: 'encoding:color-legend-config-ignored',
          message: `Legend configuration (${unsupportedKeys
            .map((key) => `\`${key}\``)
            .join(
              ', ',
            )}) has no x-charts per-spec equivalent; a default legend is shown instead. \`orient\`/position are honored separately.`,
          severity: 'ignored',
          path: `${path}.encoding.color.legend`,
        });
      }
    }

    return {
      splitField: fieldDef.field,
      domain,
      domainDerived,
      range,
      hasLegend: fieldDef.legend !== null,
    };
  }

  return { hasLegend: false };
}
