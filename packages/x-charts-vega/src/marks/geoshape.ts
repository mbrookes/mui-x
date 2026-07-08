import type { CompiledSeries, CompiledUnit, UnitContext } from '../compile/context';
import type { VegaChannelDef, VegaTransform } from '../types';
import { isFieldDef } from '../types';

/*
 * OWNERSHIP: the "geoshape/map mark" work unit owns this file.
 *
 * Translate the `geoshape` mark to an x-charts-premium map, rendered by the
 * shell's geo branch (<ChartsGeoDataProviderPremium> + <GeoDataPlot /> +
 * <MapShapePlot />). See docs/data/charts/map/*.tsx for reference usage.
 */

/** d3-geo named projections accepted by `ChartsGeoDataProviderPremium`. */
const D3_NAMED_PROJECTIONS = new Set<string>([
  'azimuthalEqualArea',
  'azimuthalEquidistant',
  'gnomonic',
  'orthographic',
  'stereographic',
  'conicConformal',
  'conicEqualArea',
  'conicEquidistant',
  'albers',
  'albersUsa',
  'equirectangular',
  'mercator',
  'transverseMercator',
  'equalEarth',
  'naturalEarth1',
]);

/**
 * Vega-Lite projection config keys that tune the projection geometry. The geo
 * provider does accept `translate`/`rotate`/`scale`, but the wrapper's shell
 * forwards only `geoData` and `projection`, so they are dropped here.
 */
const PROJECTION_TUNING_KEYS = new Set<string>([
  'center',
  'rotate',
  'scale',
  'translate',
  'parallels',
  'precision',
  'clipAngle',
  'clipExtent',
  'fit',
  'extent',
  'size',
  'pointRadius',
  'reflectX',
  'reflectY',
]);

type GeoFeature = {
  type?: unknown;
  id?: unknown;
  geometry?: { type?: unknown } | null;
  properties?: Record<string, unknown> | null;
} & Record<string, unknown>;

type FeatureCollection = { type: 'FeatureCollection'; features: GeoFeature[] };

/** A `mapShape` data entry (kept local to avoid a value import of the Premium type). */
interface MapShapeEntry {
  name: string;
  value?: number;
  colorValue?: unknown;
  color?: string;
  label?: string;
}

function isFeature(row: unknown): row is GeoFeature {
  return (
    !!row &&
    typeof row === 'object' &&
    (row as GeoFeature).type === 'Feature' &&
    (row as GeoFeature).geometry != null
  );
}

function isFeatureCollection(row: unknown): row is FeatureCollection {
  return (
    !!row &&
    typeof row === 'object' &&
    (row as FeatureCollection).type === 'FeatureCollection' &&
    Array.isArray((row as FeatureCollection).features)
  );
}

type GeoDataResolution =
  | { kind: 'ok'; geoData: FeatureCollection; features: GeoFeature[] }
  | { kind: 'empty' | 'plain' | 'topology' | 'generator' };

/**
 * Derive a GeoJSON FeatureCollection from the unit's rows.
 * @param {readonly Record<string, unknown>[]} rows The unit's resolved rows.
 * @returns {GeoDataResolution} The resolved feature collection or a failure reason.
 */
function resolveGeoData(rows: readonly Record<string, unknown>[]): GeoDataResolution {
  // (a) A single row that is already a FeatureCollection.
  if (rows.length === 1 && isFeatureCollection(rows[0])) {
    const collection = rows[0] as unknown as FeatureCollection;
    return { kind: 'ok', geoData: collection, features: collection.features };
  }
  // (b) Rows that ARE GeoJSON Feature objects.
  const features = rows.filter(isFeature) as GeoFeature[];
  if (features.length > 0) {
    return { kind: 'ok', geoData: { type: 'FeatureCollection', features }, features };
  }
  if (rows.length === 0) {
    return { kind: 'empty' };
  }
  // TopoJSON needs `topojson-client` conversion, which the wrapper doesn't do.
  if (rows.some((row) => (row as GeoFeature)?.type === 'Topology')) {
    return { kind: 'topology' };
  }
  // Data generators (sphere / graticule) surface as bare geometry objects.
  if (
    rows.some(
      (row) =>
        (row as GeoFeature)?.type === 'Sphere' ||
        (row as { geometry?: { type?: unknown } })?.geometry?.type === 'Sphere' ||
        (row as GeoFeature)?.type === 'MultiLineString',
    )
  ) {
    return { kind: 'generator' };
  }
  // (c) Plain tabular rows — a lookup-joined choropleth we can't build.
  return { kind: 'plain' };
}

/**
 * Read a (possibly dotted) field path off a GeoJSON feature (the geoshape
 * datum). Falls back to `feature.properties[field]` for a bare field name.
 * @param {GeoFeature} feature The feature to read from.
 * @param {string} field The Vega-Lite field reference.
 * @returns {unknown} The resolved value, or `undefined`.
 */
function resolveFieldValue(feature: GeoFeature, field: string): unknown {
  const parts = field.split('.');
  let current: unknown = feature;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      current = undefined;
      break;
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (current !== undefined) {
    return current;
  }
  if (parts.length === 1) {
    return feature.properties?.[field];
  }
  return undefined;
}

/**
 * Resolve the feature's join name. The map plot joins entries to features by
 * `feature.properties.name` (the default `geoFeatureKey`) and only indexes
 * features whose name is a string, so a non-string name can never be matched
 * — such features are left uncolored rather than joined under a fake name.
 * @param {GeoFeature} feature The feature to name.
 * @returns {string | undefined} The join name, or `undefined` when unmatchable.
 */
function resolveFeatureName(feature: GeoFeature): string | undefined {
  const name = feature.properties?.name;
  return typeof name === 'string' ? name : undefined;
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function parseHexColor(hex: string): [number, number, number] | undefined {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    return undefined;
  }
  let digits = match[1];
  if (digits.length === 3) {
    digits = digits
      .split('')
      .map((char) => char + char)
      .join('');
  }
  const int = parseInt(digits, 16);
  // eslint-disable-next-line no-bitwise
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function toHex(channel: number): string {
  return Math.round(clamp01(channel / 255) * 255)
    .toString(16)
    .padStart(2, '0');
}

/**
 * Linearly interpolate between two colors, producing a sequential ramp for a
 * quantitative choropleth. Falls back to the target color when parsing fails.
 * @param {string} from The low-end color (hex).
 * @param {string} to The high-end color (hex).
 * @param {number} t The interpolation factor in [0, 1].
 * @returns {string} The interpolated hex color.
 */
function lerpColor(from: string, to: string, t: number): string {
  const a = parseHexColor(from);
  const b = parseHexColor(to);
  if (!a || !b) {
    return to;
  }
  const factor = clamp01(t);
  const mix = a.map((channel, index) => channel + (b[index] - channel) * factor);
  return `#${toHex(mix[0])}${toHex(mix[1])}${toHex(mix[2])}`;
}

/**
 * Vega-Lite's default projection type. A projection must always be registered
 * for the map to render (the geo plugin returns no path otherwise), so this is
 * used whenever the spec omits or misnames one.
 */
const DEFAULT_PROJECTION = 'mercator';

/**
 * Resolve the Vega-Lite projection config to a d3 named projection string,
 * recording gaps for unknown projections and unforwardable tuning params.
 * @param {UnitContext} ctx The unit context.
 * @returns {string} A d3 named projection (defaults to `mercator`).
 */
function resolveProjection(ctx: UnitContext): string {
  // `projection` lives on the Vega-Lite unit spec. Read it defensively — see
  // SHELL-FIXES: `NormalizedUnit` must carry it through for end-to-end use.
  const projection = (ctx.unit as { projection?: Record<string, unknown> }).projection;
  if (!projection || typeof projection !== 'object') {
    return DEFAULT_PROJECTION;
  }

  const tuningKeys = Object.keys(projection).filter((key) => PROJECTION_TUNING_KEYS.has(key));
  if (tuningKeys.length > 0) {
    ctx.gaps.add({
      code: 'projection:params',
      message: `Projection tuning parameters (${tuningKeys.join(
        ', ',
      )}) are not forwarded to the map; the projection auto-fits the geo data instead.`,
      severity: 'ignored',
      path: `${ctx.unit.path}.projection`,
    });
  }

  const type = projection.type;
  if (typeof type !== 'string') {
    return DEFAULT_PROJECTION;
  }
  if (D3_NAMED_PROJECTIONS.has(type)) {
    return type;
  }
  ctx.gaps.add({
    code: 'projection:unknown',
    message: `Projection "${type}" has no d3-geo equivalent in the map provider; falling back to the "${DEFAULT_PROJECTION}" projection.`,
    severity: 'partial',
    path: `${ctx.unit.path}.projection`,
  });
  return DEFAULT_PROJECTION;
}

/** Locate a `lookup` transform on the unit, for a precise gap path. */
function findLookupPath(ctx: UnitContext): string {
  const index = ctx.unit.transform.findIndex(
    (transform: VegaTransform) =>
      transform && typeof transform === 'object' && 'lookup' in transform,
  );
  return index >= 0 ? `${ctx.unit.path}.transform[${index}]` : `${ctx.unit.path}.transform`;
}

/**
 * Build the `mapShape` data entries for a choropleth from the color field read
 * off each feature. Quantitative fields get a sequential color ramp; nominal /
 * ordinal fields get one palette color per distinct value.
 */
function buildChoroplethEntries(
  features: GeoFeature[],
  field: string,
  fieldType: string | undefined,
  palette: readonly string[],
): MapShapeEntry[] {
  // Features are joined to series entries by name, so entries must be unique by
  // name — the Premium `mapShape` series processor throws on duplicates. Keep
  // the first occurrence (multiple polygons sharing a name still all render,
  // since the plot resolves every feature index for that name).
  const seenNames = new Set<string>();
  const raw = features
    .map((feature) => ({
      name: resolveFeatureName(feature),
      value: resolveFieldValue(feature, field),
    }))
    .filter(
      (entry): entry is { name: string; value: unknown } =>
        entry.name !== undefined && entry.value !== undefined && entry.value !== null,
    )
    .filter((entry) => {
      if (seenNames.has(entry.name)) {
        return false;
      }
      seenNames.add(entry.name);
      return true;
    });

  if (raw.length === 0) {
    return [];
  }

  const isQuantitative = fieldType === 'quantitative' || fieldType === undefined;
  const numeric = raw
    .map((entry) => (typeof entry.value === 'number' ? entry.value : Number(entry.value)))
    .filter((value) => Number.isFinite(value));
  const treatAsQuantitative = isQuantitative && numeric.length === raw.length;

  if (treatAsQuantitative) {
    const min = Math.min(...numeric);
    const max = Math.max(...numeric);
    const span = max - min;
    // The ramp endpoints must be interpolatable hex; if the palette color isn't
    // (e.g. an `rgb()`/named color), fall back so the gradient isn't flattened.
    const high = palette[0] && parseHexColor(palette[0]) ? palette[0] : '#1976d2';
    const low = lerpColor('#ffffff', high, 0.12);
    return raw.map((entry) => {
      const value = Number(entry.value);
      const t = span === 0 ? 1 : (value - min) / span;
      return {
        name: entry.name,
        value,
        colorValue: value,
        color: lerpColor(low, high, t),
        label: entry.name,
      };
    });
  }

  // Nominal / ordinal: one palette color per distinct category.
  const colorByCategory = new Map<string, string>();
  return raw.map((entry) => {
    const key = String(entry.value);
    let color = colorByCategory.get(key);
    if (color === undefined) {
      color = palette[colorByCategory.size % Math.max(palette.length, 1)] ?? '#1976d2';
      colorByCategory.set(key, color);
    }
    return { name: entry.name, colorValue: entry.value, color, label: key };
  });
}

/** Pick the color/fill channel that carries a field encoding, if any. */
function pickColorChannel(
  ctx: UnitContext,
): { channel: VegaChannelDef; field: string; type?: string } | undefined {
  for (const key of ['color', 'fill'] as const) {
    const channel = ctx.encoding[key];
    if (isFieldDef(channel) && channel.field) {
      return { channel, field: channel.field, type: channel.type };
    }
  }
  return undefined;
}

export function compileGeoshapeMark(ctx: UnitContext): CompiledUnit {
  const resolution = resolveGeoData(ctx.rows);

  if (resolution.kind !== 'ok') {
    const messages: Record<Exclude<GeoDataResolution['kind'], 'ok'>, string> = {
      empty:
        'The geoshape mark has no resolvable GeoJSON features. Inline `sphere`/`graticule` generators, URL data, and TopoJSON are not supported — pass a FeatureCollection (or an array of Features) via the `data` prop.',
      plain:
        'The geoshape mark received plain tabular rows. Joining values onto features with a `lookup` transform is not supported yet; pre-join the values into `feature.properties` and pass the resulting Features.',
      topology:
        'The geoshape mark received a TopoJSON `Topology`. The wrapper does not convert TopoJSON — pass a GeoJSON FeatureCollection instead (e.g. via `topojson-client`).',
      generator:
        'The geoshape mark received a `sphere`/`graticule` data generator geometry, which has no x-charts equivalent and is dropped.',
    };
    ctx.gaps.add({
      code: `mark:geoshape-${resolution.kind === 'plain' ? 'lookup' : resolution.kind}`,
      message: messages[resolution.kind],
      severity: 'unsupported',
      path: resolution.kind === 'plain' ? findLookupPath(ctx) : ctx.unit.path,
    });
    return { series: [], plots: [] };
  }

  const geo: CompiledUnit['geo'] = {
    geoData: resolution.geoData,
    projection: resolveProjection(ctx),
  };

  if (ctx.encoding.shape !== undefined) {
    ctx.gaps.add({
      code: 'encoding:shape',
      message:
        'The `shape` channel is ignored for geoshape marks; the geometry is taken directly from the GeoJSON features.',
      severity: 'ignored',
      path: `${ctx.unit.path}.encoding.shape`,
    });
  }
  if (ctx.encoding.tooltip !== undefined && ctx.encoding.tooltip !== null) {
    ctx.gaps.add({
      code: 'encoding:tooltip',
      message:
        'Custom `tooltip` channel encodings are ignored; the map uses the default item tooltip (feature name and value).',
      severity: 'ignored',
      path: `${ctx.unit.path}.encoding.tooltip`,
    });
  }

  const color = pickColorChannel(ctx);
  if (!color) {
    // Outline map: no color encoding, just the base features.
    return { series: [], plots: ['geoBase'], geo };
  }

  const entries = buildChoroplethEntries(resolution.features, color.field, color.type, ctx.palette);
  if (entries.length === 0) {
    // The color field isn't present on any feature — most likely it lives on
    // separate tabular rows meant to be joined with a `lookup` transform.
    ctx.gaps.add({
      code: 'mark:geoshape-lookup',
      message: `The color field "${color.field}" is not present on the GeoJSON features. Joining external values with a \`lookup\` transform is not supported yet; the map renders as an outline. Pre-join the values into \`feature.properties\`.`,
      severity: 'unsupported',
      path: findLookupPath(ctx),
    });
    return { series: [], plots: ['geoBase'], geo };
  }

  const series = {
    type: 'mapShape',
    data: entries,
    label: color.field,
  } as unknown as CompiledSeries;

  return { series: [series], plots: ['geoBase', 'mapShape'], geo };
}
