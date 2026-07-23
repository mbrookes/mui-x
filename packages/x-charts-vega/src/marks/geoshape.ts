import { geoAlbersUsa } from '@mui/x-charts-vendor/d3-geo';
import type { GeoProjection } from '@mui/x-charts-vendor/d3-geo';
import type { CompiledSeries, CompiledUnit, UnitContext } from '../compile/context';
import type { ContinuousColorMapConfig, PiecewiseColorMapConfig } from '../compile/color';
import { resolveColor } from '../compile/color';
import { resolveFieldType, toDate, toNumber } from '../compile/fieldTypes';
import { createValueFormatter } from '../format';
import type {
  DatasetRow,
  VegaEncoding,
  VegaFieldDef,
  VegaFieldType,
  VegaLookupTransform,
  VegaTransform,
} from '../types';
import { isFieldDef } from '../types';
import { applyLookupTransform } from '../transforms/lookup';

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
 * Vega-Lite projection config keys with no `ChartsGeoDataProviderPremium`
 * equivalent (see `useGeoProjection`'s `UseGeoProjectionParameters`, which
 * only accepts `translate`/`rotate`/`scale` beyond the projection itself) —
 * always dropped with an `ignored` gap.
 */
const PROJECTION_TUNING_KEYS = new Set<string>([
  'center',
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

/**
 * Vega-Lite's default projection type. A projection must always be registered
 * for the map to render (the geo plugin returns no path otherwise), so this is
 * used whenever the spec omits or misnames one.
 */
const DEFAULT_PROJECTION = 'mercator';

/**
 * `geoAlbersUsa` is a composite projection with no `rotate` method, but the map
 * provider's fit-to-drawing-area helper (`getDefaultTranslation`) calls
 * `projection.rotate(...)` unconditionally — so passing the *named* `'albersUsa'`
 * string (which makes the provider build a rotate-less instance) throws
 * "projection.rotate is not a function". Build the instance here instead and add
 * a chainable no-op `rotate` shim (rotation is meaningless for a composite
 * projection anyway), keeping the workaround in the wrapper rather than patching
 * `@mui/x-charts-premium`. The provider still fits/scales the instance normally.
 */
function albersUsaWithRotateShim(): GeoProjection {
  const projection = geoAlbersUsa();
  if (typeof (projection as { rotate?: unknown }).rotate !== 'function') {
    (projection as unknown as { rotate: () => GeoProjection }).rotate = () => projection;
  }
  return projection;
}

/**
 * Resolve the Vega-Lite projection config to a d3 named projection (or, for
 * `albersUsa`, a shimmed instance), recording gaps for unknown projections and
 * unforwardable tuning params. Exported for `marks/point.ts`'s geo-projected
 * point/circle compiler, which resolves the same spec-level `projection` when
 * there's no sibling `geoshape` layer to supply it (see
 * `UnitContext.hasGeoshapeLayer`).
 * @param {UnitContext} ctx The unit context.
 * @returns {string | GeoProjection} A d3 named projection (defaults to `mercator`).
 */
export function resolveGeoProjection(ctx: UnitContext): string | GeoProjection {
  const projection = ctx.unit.projection;
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
    return type === 'albersUsa' ? albersUsaWithRotateShim() : type;
  }
  ctx.gaps.add({
    code: 'projection:unknown',
    message: `Projection "${type}" has no d3-geo equivalent in the map provider; falling back to the "${DEFAULT_PROJECTION}" projection.`,
    severity: 'partial',
    path: `${ctx.unit.path}.projection`,
  });
  return DEFAULT_PROJECTION;
}

/**
 * Resolve the spec's `projection` tuning into the map provider's view model.
 * A d3 `rotate: [λ, φ, γ]` maps to `ChartsGeoDataProviderPremium`'s `initialView`
 * (from `useGeoProjectionZoom`): it displays `[-λ, -φ]` at the center with a `γ`
 * roll. Malformed `rotate` is ignored with a gap. The provider positions maps
 * with a relative zoom/pan model, so a projection's absolute `scale`/`translate`
 * (raw SVG pixels) have no equivalent and are reported as `partial` gaps rather
 * than forwarded.
 * Exported for the same reason as `resolveGeoProjection` above.
 * @param {UnitContext} ctx The unit context.
 * @returns {Pick<NonNullable<CompiledUnit['geo']>, 'initialView'>} The forwardable view.
 */
export function resolveGeoProjectionTuning(
  ctx: UnitContext,
): Pick<NonNullable<CompiledUnit['geo']>, 'initialView'> {
  const projection = ctx.unit.projection;
  if (!projection || typeof projection !== 'object') {
    return {};
  }

  const result: Pick<NonNullable<CompiledUnit['geo']>, 'initialView'> = {};
  const path = `${ctx.unit.path}.projection`;

  const { rotate } = projection;
  if (rotate !== undefined) {
    const isNumberArray =
      Array.isArray(rotate) &&
      rotate.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
    if (isNumberArray && (rotate.length === 2 || rotate.length === 3)) {
      // d3 `rotate([λ, φ, γ])` shows `[-λ, -φ]` at the center; the 3rd value is
      // the roll (now supported by the provider's `initialView`, no longer dropped).
      result.initialView = {
        zoomLevel: 1,
        center: [-rotate[0], -rotate[1]],
        ...(rotate.length === 3 ? { roll: rotate[2] } : {}),
      };
    } else {
      ctx.gaps.add({
        code: 'projection:rotate-invalid',
        message:
          '`rotate` must be a `[longitude, latitude]` (or `[longitude, latitude, roll]`) numeric tuple; the malformed value was ignored.',
        severity: 'ignored',
        path: `${path}.rotate`,
      });
    }
  }

  // The provider expresses position as a zoom ratio + geographic center, not the
  // raw SVG `scale`/`translate` pixels a d3 projection config carries, so those
  // absolute values are reported as unsupported rather than mis-applied.
  for (const key of ['scale', 'translate'] as const) {
    if (projection[key] !== undefined) {
      ctx.gaps.add({
        code: `projection:${key}-unsupported`,
        message: `The map provider positions the map with a relative zoom/pan model, so the projection's absolute \`${key}\` (in SVG pixels) has no equivalent and was ignored; drive the view via \`initialView\`/interactive zoom instead.`,
        severity: 'partial',
        path: `${path}.${key}`,
      });
    }
  }

  return result;
}

/** Locate a `lookup` transform on the unit, for a precise gap path. */
function findLookupPath(ctx: UnitContext): string {
  const index = ctx.unit.transform.findIndex(
    (transform: VegaTransform) =>
      transform && typeof transform === 'object' && 'lookup' in transform,
  );
  return index >= 0 ? `${ctx.unit.path}.transform[${index}]` : `${ctx.unit.path}.transform`;
}

interface ChoroplethResult {
  entries: MapShapeEntry[];
  /** A real axis `colorMap` for a quantitative/temporal color field (see `resolveColor`). */
  colorMap?: ContinuousColorMapConfig | PiecewiseColorMapConfig;
}

/**
 * Build the `mapShape` data entries for a choropleth from the color field read
 * off each feature.
 *
 * Quantitative/temporal fields resolve a real axis `colorMap` — reusing
 * `resolveColor` against synthetic flat rows (`{ [field]: resolvedValue }`,
 * since the real rows are GeoJSON features and `field` may be a dotted
 * `properties.*` path or a bare name resolved via the properties fallback) and
 * patching the inferred type into the encoding first, mirroring how
 * marks/rect.ts calls `resolveColor` for heatmap cells. Entries carry a bare
 * `colorValue` for the resulting color axis to consume — no more per-entry
 * lerped color.
 *
 * Nominal/ordinal fields have no axis equivalent for a categorical color
 * scale on this series, so they keep the palette-per-category approximation.
 */
function buildChoroplethEntries(
  ctx: UnitContext,
  features: GeoFeature[],
  channelKey: 'color' | 'fill',
  channel: VegaFieldDef,
  field: string,
  palette: readonly string[],
): ChoroplethResult {
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
    return { entries: [] };
  }

  // Synthetic flat rows so `resolveFieldType`/`resolveColor` can read `field`
  // directly off a plain object, exactly like they do for ordinary datasets.
  const flatRows = raw.map((entry) => ({ [field]: entry.value }));
  const fieldType = resolveFieldType(channel, flatRows);

  if (fieldType === 'quantitative' || fieldType === 'temporal') {
    const patchedEncoding: VegaEncoding =
      channel.type === fieldType
        ? ctx.encoding
        : { ...ctx.encoding, [channelKey]: { ...channel, type: fieldType } };
    // colorMapConsumed: the colorMap goes onto a real color (z) axis via the
    // geo provider, so the "only some series types honor colorMap" caveat
    // does not apply here.
    const { colorMap } = resolveColor(patchedEncoding, flatRows, ctx.gaps, ctx.unit.path, {
      colorMapConsumed: true,
      legendFormatHonored: true,
    });

    const entries: MapShapeEntry[] = raw.map((entry) => {
      if (fieldType === 'temporal') {
        return {
          name: entry.name,
          colorValue: toDate(entry.value) ?? undefined,
          label: entry.name,
        };
      }
      const value = toNumber(entry.value) ?? undefined;
      return { name: entry.name, value, colorValue: value, label: entry.name };
    });
    return { entries, colorMap };
  }

  // Nominal / ordinal: one palette color per distinct category.
  const colorByCategory = new Map<string, string>();
  const entries = raw.map((entry) => {
    const key = String(entry.value);
    let color = colorByCategory.get(key);
    if (color === undefined) {
      color = palette[colorByCategory.size % Math.max(palette.length, 1)] ?? '#1976d2';
      colorByCategory.set(key, color);
    }
    return { name: entry.name, colorValue: entry.value, color, label: key };
  });
  return { entries };
}

/**
 * Compile the color channel's `legend.format` (a d3 number/time pattern, e.g.
 * `.1%`) into a value formatter for the continuous color legend. Only applies
 * when the field surfaced a `colorMap` (quantitative/temporal); returns
 * `undefined` when there is no translatable format.
 */
function resolveColorLegendFormat(
  channel: VegaFieldDef,
  hasColorMap: boolean,
): ((value: unknown) => string) | undefined {
  if (!hasColorMap || !channel.legend || typeof channel.legend !== 'object') {
    return undefined;
  }
  const { format, formatType } = channel.legend as { format?: unknown; formatType?: unknown };
  if (typeof format !== 'string') {
    return undefined;
  }
  const formatter = createValueFormatter(
    format,
    channel.type as VegaFieldType | undefined,
    typeof formatType === 'string' ? formatType : undefined,
  );
  return formatter ?? undefined;
}

/** Pick the color/fill channel that carries a field encoding, if any. */
function pickColorChannel(
  ctx: UnitContext,
): { channelKey: 'color' | 'fill'; channel: VegaFieldDef; field: string } | undefined {
  for (const key of ['color', 'fill'] as const) {
    const channel = ctx.encoding[key];
    if (isFieldDef(channel) && channel.field) {
      return { channelKey: key, channel, field: channel.field };
    }
  }
  return undefined;
}

/**
 * Prepare features for a choropleth join. x-charts matches `mapShape` series
 * data to features **only by `feature.properties.name`**, yet a Vega-Lite
 * choropleth commonly (a) carries the value in a *separate* dataset joined by a
 * `lookup` transform keyed on the feature `id`, and (b) uses features that have
 * an `id` but no `properties.name` (e.g. TopoJSON US counties). The row-level
 * transform pipeline only ever sees the single wrapping FeatureCollection, so
 * the lookup never reaches the individual features. Here, for the geoshape
 * itself, we:
 *   1. apply every `lookup` transform onto the FEATURES, copying the joined
 *      field (e.g. `rate`) onto each one (read back by `resolveFieldValue`);
 *   2. bridge a feature's `id` into `properties.name` when it has no name, so
 *      the join key x-charts needs exists and matches the choropleth entries
 *      (which key on the same resolved name).
 * Features that already carry a name keep it; features without an `id` are left
 * untouched.
 */
function joinAndBridgeFeatures(features: GeoFeature[], ctx: UnitContext): GeoFeature[] {
  const lookups = (ctx.unit.transform ?? []).filter(
    (transform: VegaTransform): transform is VegaLookupTransform =>
      !!transform && typeof transform === 'object' && 'lookup' in transform,
  );
  let joined = features;
  for (const lookup of lookups) {
    joined = applyLookupTransform(
      joined as unknown as DatasetRow[],
      lookup,
      ctx.gaps,
      ctx.unit.path,
    ) as unknown as GeoFeature[];
  }
  return joined.map((feature) => {
    if (typeof feature.properties?.name === 'string' || feature.id == null) {
      return feature;
    }
    return {
      ...feature,
      properties: { ...(feature.properties ?? {}), name: String(feature.id) },
    };
  });
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

  const color = pickColorChannel(ctx);
  // A choropleth joins any `lookup` values onto each feature and bridges a
  // numeric feature `id` into `properties.name` so x-charts can color it; the
  // rebuilt geoData must carry those bridged names so its name index matches the
  // series entries. Outline maps (no color) keep the features as-is.
  const features = color ? joinAndBridgeFeatures(resolution.features, ctx) : resolution.features;
  const geoData = color ? { ...resolution.geoData, features } : resolution.geoData;

  const geo: CompiledUnit['geo'] = {
    geoData,
    projection: resolveGeoProjection(ctx),
    ...resolveGeoProjectionTuning(ctx),
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

  if (!color) {
    // Outline map: no color encoding, just the base features. `mark.fill`/
    // `stroke`/`strokeWidth` (e.g. `layer_geo`'s `{fill: 'lightgray', stroke:
    // 'white'}`) forward to `<GeoDataPlot>` instead of its `currentColor`/
    // `none` defaults, which otherwise render the whole shape solid black on
    // a light theme.
    const { mark } = ctx.unit;
    const outlineFill = typeof mark.fill === 'string' ? mark.fill : mark.color;
    const geoWithOutlineStyle: CompiledUnit['geo'] = {
      ...geo,
      ...(outlineFill !== undefined ? { outlineFill } : {}),
      ...(mark.stroke !== undefined ? { outlineStroke: mark.stroke } : {}),
      ...(mark.strokeWidth !== undefined ? { outlineStrokeWidth: mark.strokeWidth } : {}),
    };
    return { series: [], plots: ['geoBase'], geo: geoWithOutlineStyle };
  }

  const { entries, colorMap } = buildChoroplethEntries(
    ctx,
    features,
    color.channelKey,
    color.channel,
    color.field,
    ctx.palette,
  );
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

  // A `legend.format` on a quantitative/temporal color field (e.g. `.1%` for an
  // unemployment rate) formats the continuous legend's min/max labels. x-charts
  // ignores a z-axis valueFormatter for that legend, so it's surfaced on `geo`
  // for the shell to apply via the legend's `minLabel`/`maxLabel`.
  const legendFormat = resolveColorLegendFormat(color.channel, Boolean(colorMap));
  const geoWithLegend = legendFormat ? { ...geo, colorLegendFormat: legendFormat } : geo;

  return {
    series: [series],
    // A choropleth draws only the colored features, matching Vega-Lite (which
    // renders the geoshape mark alone, with no base layer). Rendering the base
    // `GeoDataPlot` here would fill every feature the color join skipped — most
    // visibly the Great Lakes, which have no `id`/rate — with the default dark
    // shape color, so it is omitted. Outline-only maps (no color field) still
    // return `['geoBase']` above.
    plots: ['mapShape'],
    geo: geoWithLegend,
    // A quantitative/temporal color field surfaces a real color axis, keyed
    // so the shell can pick the matching (continuous vs. piecewise) legend.
    ...(colorMap ? { zAxis: [{ id: 'vega-geo-color', colorMap }] as CompiledUnit['zAxis'] } : {}),
  };
}
