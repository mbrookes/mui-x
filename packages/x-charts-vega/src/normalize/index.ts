import { feature as topojsonFeature } from 'topojson-client';
import type {
  DatasetRow,
  VegaData,
  VegaEncoding,
  VegaLayerSpec,
  VegaLiteSpec,
  VegaMarkDef,
  VegaTransform,
  VegaUnitSpec,
} from '../types';
import type { GapCollector } from '../gaps';

export interface NormalizedUnit {
  /** Mark normalized to object form (`'bar'` → `{ type: 'bar' }`). */
  mark: VegaMarkDef;
  /** Layer encoding merged over inherited parent encoding. */
  encoding: VegaEncoding;
  /** Transforms inherited from ancestors followed by the unit's own. */
  transform: VegaTransform[];
  /** Rows resolved for this unit (inline values > named dataset > shared data). */
  rows: readonly DatasetRow[];
  /** Locator prefix for gap paths, e.g. `layer[0]`. */
  path: string;
  /** The unit's geographic projection config (geoshape marks). */
  projection?: Record<string, unknown>;
}

export interface NormalizedSpec {
  units: NormalizedUnit[];
  resolve: NonNullable<VegaLayerSpec['resolve']>;
  title?: string;
  width?: number;
  height?: number;
  /**
   * The spec's own inline `datasets` merged with host-provided
   * `options.datasets` (the latter winning) — the same merge every named-
   * dataset lookup in this file already does for the PRIMARY data source,
   * exposed here so callers can resolve a named dataset referenced from
   * elsewhere (e.g. a `lookup` transform's `from.data.name`).
   */
  datasets: Record<string, readonly DatasetRow[]>;
}

export interface NormalizeOptions {
  /** Host-provided rows overriding/standing in for `spec.data`. */
  data?: readonly DatasetRow[];
  /** Host-provided named datasets, merged over `spec.datasets`. */
  datasets?: Record<string, readonly DatasetRow[]>;
}

/**
 * Validates a TopoJSON payload (`data.format.type: 'topojson'`) and returns
 * one deduped GeoJSON Feature per row, extracted from the named
 * `format.feature` object. Shared by two consumers: a primary geoshape data
 * source (`resolveTopojsonRows` below wraps these into a single
 * FeatureCollection row, which the geoshape mark compiler understands) and a
 * `lookup` transform whose secondary data is topojson (a common
 * "choropleth via lookup" pattern — `transforms/lookup.ts` needs one row per
 * feature, keyed by its `id`, to join against — joining the whole
 * FeatureCollection row would never match a primary row's id).
 */
export function extractTopojsonFeatureRows(
  data: VegaData,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] | undefined {
  const topology = data.values;
  if (
    topology == null ||
    typeof topology !== 'object' ||
    Array.isArray(topology) ||
    (topology as { type?: unknown }).type !== 'Topology'
  ) {
    gaps.add({
      code: 'data:topojson-invalid',
      message:
        'The `format.type: "topojson"` payload in `data.values` is not a TopoJSON Topology object; the data was ignored.',
      severity: 'unsupported',
      path: `${path}.data.values`,
    });
    return undefined;
  }
  if (data.format?.mesh !== undefined) {
    gaps.add({
      code: 'data:topojson-mesh',
      message:
        'TopoJSON `format.mesh` extraction (boundary meshes) is not supported; use `format.feature` to extract polygons instead.',
      severity: 'unsupported',
      path: `${path}.data.format.mesh`,
    });
    return undefined;
  }
  const featureName = data.format?.feature;
  const objects = (topology as { objects?: Record<string, unknown> }).objects ?? {};
  if (typeof featureName !== 'string' || objects[featureName] === undefined) {
    gaps.add({
      code: 'data:topojson-feature',
      message:
        `TopoJSON data needs \`format.feature\` naming one of the topology's objects ` +
        `(available: ${Object.keys(objects).join(', ') || 'none'}).`,
      severity: 'unsupported',
      path: `${path}.data.format.feature`,
    });
    return undefined;
  }
  const collection = topojsonFeature(topology as never, featureName as never) as unknown as {
    type: string;
    features: GeoFeatureLike[];
  };
  return dedupeFeaturesById(collection.features) as unknown as DatasetRow[];
}

/**
 * Converts a TopoJSON payload (`data.format.type: 'topojson'`) into GeoJSON
 * rows: the named `format.feature` object becomes a single FeatureCollection
 * row, which the geoshape mark compiler already understands.
 */
function resolveTopojsonRows(
  data: VegaData,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] | undefined {
  const features = extractTopojsonFeatureRows(data, gaps, path);
  return features ? [{ type: 'FeatureCollection', features } as unknown as DatasetRow] : undefined;
}

interface GeoFeatureLike {
  id?: string | number;
  geometry?: unknown;
}

/**
 * Collapse GeoJSON features to one per `id`. TopoJSON `feature()` can yield
 * several features sharing an `id` — commonly a null-geometry placeholder plus
 * the real polygon (and, in malformed topologies, two real polygons). Duplicate
 * ids are ambiguous both for join-by-id and for the map renderer, which keys
 * each shape by feature id and warns on collisions ("two children with the same
 * key"). Keep the first feature per id, but let a real geometry replace a
 * previously-kept null-geometry placeholder so no visible shape is lost.
 * Features without an `id` are never merged (they carry no join/key identity).
 */
function dedupeFeaturesById(features: GeoFeatureLike[]): GeoFeatureLike[] {
  const positionById = new Map<string, number>();
  const out: GeoFeatureLike[] = [];
  for (const feat of features) {
    const id = feat?.id;
    if (id == null) {
      out.push(feat);
      continue;
    }
    const key = String(id);
    const existing = positionById.get(key);
    if (existing === undefined) {
      positionById.set(key, out.length);
      out.push(feat);
    } else if (out[existing].geometry == null && feat.geometry != null) {
      // Upgrade a placeholder (null-geometry) feature to the real polygon.
      out[existing] = feat;
    }
  }
  return out;
}

/** Safety cap on `data.sequence` row count — guards against a malformed/tiny `step` hanging the compile. */
const MAX_SEQUENCE_ROWS = 100_000;

/**
 * Vega-Lite's `data.sequence` generator: `start` (inclusive) to `stop`
 * (exclusive) in steps of `step` (default 1, may be negative to count down),
 * written to a field named `as` (default `'data'`) — matching d3/Vega's own
 * `range()` semantics. Returns `null` (after recording a gap) for a
 * malformed sequence (non-numeric bounds, or a `step` that can never reach
 * `stop`) rather than looping forever or silently returning nothing.
 */
function resolveSequenceRows(
  sequence: NonNullable<VegaData['sequence']>,
  gaps: GapCollector,
  path: string,
): DatasetRow[] | null {
  const { start, stop, step = 1, as = 'data' } = sequence;
  if (
    typeof start !== 'number' ||
    typeof stop !== 'number' ||
    typeof step !== 'number' ||
    step === 0 ||
    (step > 0 && start >= stop) ||
    (step < 0 && start <= stop)
  ) {
    gaps.add({
      code: 'data:sequence-invalid',
      message: `\`data.sequence\` (start ${JSON.stringify(start)}, stop ${JSON.stringify(stop)}, step ${JSON.stringify(step)}) can never produce a row; no data was generated.`,
      severity: 'unsupported',
      path: `${path}.data.sequence`,
    });
    return null;
  }
  const rows: DatasetRow[] = [];
  if (step > 0) {
    for (let value = start; value < stop && rows.length < MAX_SEQUENCE_ROWS; value += step) {
      rows.push({ [as]: value });
    }
  } else {
    for (let value = start; value > stop && rows.length < MAX_SEQUENCE_ROWS; value += step) {
      rows.push({ [as]: value });
    }
  }
  if (rows.length >= MAX_SEQUENCE_ROWS) {
    gaps.add({
      code: 'data:sequence-truncated',
      message: `\`data.sequence\` was capped at ${MAX_SEQUENCE_ROWS} rows (start ${start}, stop ${stop}, step ${step}); the generated sequence is incomplete.`,
      severity: 'partial',
      path: `${path}.data.sequence`,
    });
  }
  return rows;
}

/**
 * Vega-Lite wraps a bare array of primitives (`[12, 23, 47]`, as opposed to an
 * array of row objects) into one-field records keyed `data` — e.g. `{data:
 * 12}` — so `encoding.field: "data"` resolves against them. Mirrors that
 * instead of handing mark compilers primitive "rows" with no properties to
 * read a field from — applies equally to inline `data.values` and a named
 * dataset (`data.name` + `datasets`/`spec.datasets`), since either can be a
 * bare primitive array (`layer_line_window`'s `datasets.falcon`/`.square`).
 */
function wrapPrimitiveRows(values: readonly unknown[]): readonly DatasetRow[] {
  const isPrimitiveArray =
    values.length > 0 && values.every((value) => value === null || typeof value !== 'object');
  if (isPrimitiveArray) {
    return values.map((value) => ({ data: value }));
  }
  return values as readonly DatasetRow[];
}

function resolveRows(
  data: VegaData | null | undefined,
  inherited: readonly DatasetRow[],
  datasets: Record<string, readonly DatasetRow[]>,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  if (data == null) {
    return inherited;
  }
  if (data.sequence !== undefined) {
    return resolveSequenceRows(data.sequence, gaps, path) ?? inherited;
  }
  if (data.format?.type === 'topojson' && data.values !== undefined) {
    return resolveTopojsonRows(data, gaps, path) ?? inherited;
  }
  if (Array.isArray(data.values)) {
    return wrapPrimitiveRows(data.values as unknown[]);
  }
  if (typeof data.values === 'string') {
    gaps.add({
      code: 'data:string-values',
      message:
        'String data values (CSV/TSV payloads) are not parsed. Provide `data.values` as an array of objects or pass rows via the `data` prop.',
      severity: 'unsupported',
      path: `${path}.data.values`,
    });
    return inherited;
  }
  if (data.values !== undefined && typeof data.values === 'object') {
    // A single object payload (e.g. a GeoJSON FeatureCollection) is one row.
    return [data.values as DatasetRow];
  }
  if (data.name !== undefined) {
    const named = datasets[data.name];
    if (named) {
      return wrapPrimitiveRows(named as unknown[]);
    }
    gaps.add({
      code: 'data:named-missing',
      message: `Named dataset "${data.name}" was not provided. Pass it through the \`datasets\` prop or the spec's \`datasets\` map.`,
      severity: 'unsupported',
      path: `${path}.data.name`,
    });
    return inherited;
  }
  if (data.url !== undefined) {
    gaps.add({
      code: 'data:url',
      message:
        'Loading data from a URL is not supported — the wrapper performs no fetching. Load the data yourself and pass it via the `data` prop.',
      severity: 'unsupported',
      path: `${path}.data.url`,
    });
  }
  return inherited;
}

function mergeEncoding(
  parent: VegaEncoding | undefined,
  child: VegaEncoding | undefined,
): VegaEncoding {
  if (!parent) {
    return { ...child };
  }
  if (!child) {
    return { ...parent };
  }
  // Vega-Lite merges a layer's encoding over the parent's per channel *property*,
  // not per channel: a shared `x: {type, title, axis}` and a layer `x: {field}`
  // resolve to `x: {type, title, axis, field}`. A plain `{...parent, ...child}`
  // would let the layer's channel def wholly replace the parent's, dropping the
  // inherited title/type/scale (e.g. co2's "Year into Decade" axis title lives on
  // the shared x while the field lives on each layer). Merge the two channel
  // objects a level deeper so inherited channel properties survive.
  const merged: VegaEncoding = { ...parent };
  for (const key of Object.keys(child) as Array<keyof VegaEncoding>) {
    const parentDef = parent[key];
    const childDef = child[key];
    if (
      parentDef &&
      childDef &&
      !Array.isArray(parentDef) &&
      !Array.isArray(childDef) &&
      typeof parentDef === 'object' &&
      typeof childDef === 'object'
    ) {
      merged[key] = { ...parentDef, ...childDef } as VegaEncoding[keyof VegaEncoding];
    } else {
      merged[key] = childDef;
    }
  }
  return merged;
}

function normalizeMark(mark: VegaUnitSpec['mark']): VegaMarkDef {
  return typeof mark === 'string' ? { type: mark } : mark;
}

export function titleText(title: VegaUnitSpec['title']): string | undefined {
  if (typeof title === 'string') {
    return title;
  }
  if (title && typeof title === 'object') {
    // Vega-Lite's multi-line title form (`text: string[]`, one array entry per
    // rendered line) — joined with a newline; the shell's title element
    // preserves it via `white-space: pre-line`.
    const { text } = title as { text?: unknown };
    if (typeof text === 'string') {
      return text;
    }
    if (Array.isArray(text) && text.every((line) => typeof line === 'string')) {
      return (text as string[]).join('\n');
    }
  }
  return undefined;
}

function numericSize(
  value: VegaUnitSpec['width'],
  gaps: GapCollector,
  prop: 'width' | 'height',
): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  // A `{step}` (band step) size is honored by the shell's view-size resolver
  // (`step × categoryCount`), so it is intentionally left for that stage rather
  // than reported here. Only a genuinely unrecognized object form is gapped.
  const isStep =
    value != null &&
    typeof value === 'object' &&
    typeof (value as { step?: unknown }).step === 'number';
  if (value !== undefined && value !== 'container' && !isStep) {
    gaps.add({
      code: `size:${prop}-step`,
      message: `Object ${prop} sizing is not supported; the chart falls back to container sizing.`,
      severity: 'ignored',
      path: prop,
    });
  }
  return undefined;
}

/**
 * Flattens a (possibly layered) Vega-Lite spec into a list of unit specs with
 * fully-resolved encoding, transforms, and rows.
 *
 * NOTE: view compositions (`facet` / `row`+`column` channels / `hconcat` /
 * `vconcat` / `concat` / `repeat`) are wrapper-level, not compiler-level.
 * `<VegaLiteChart />` detects them BEFORE calling `compileSpec` (see `src/facet`)
 * and expands them into a grid of nested single-view charts. The gaps below
 * therefore only surface when `compileSpec` is invoked directly on a composite
 * spec (the pure API path, which renders nothing) — the shell never reaches
 * them.
 */
export function normalizeSpec(
  spec: VegaLiteSpec,
  options: NormalizeOptions,
  gaps: GapCollector,
): NormalizedSpec {
  for (const composite of ['hconcat', 'vconcat', 'concat', 'repeat', 'facet'] as const) {
    if (spec[composite] !== undefined) {
      gaps.add({
        code: `composition:${composite}`,
        message: `\`${composite}\` view composition is not handled by the pure \`compileSpec\` API; render the spec through <VegaLiteChart />, which expands it into a grid of sub-charts.`,
        severity: 'unsupported',
        path: composite,
      });
    }
  }
  if (spec.encoding && (spec.encoding.row || spec.encoding.column || spec.encoding.facet)) {
    gaps.add({
      code: 'encoding:facet',
      message:
        'Facet channels (row/column/facet) are not handled by the pure `compileSpec` API; render the spec through <VegaLiteChart />, which splits the data into one chart per facet.',
      severity: 'unsupported',
      path: 'encoding',
    });
  }

  const datasets: Record<string, readonly DatasetRow[]> = {
    ...(spec.datasets as Record<string, readonly DatasetRow[]> | undefined),
    ...options.datasets,
  };
  const rootRows = options.data ?? resolveRows(spec.data, [], datasets, gaps, '$');

  const units: NormalizedUnit[] = [];

  const walk = (
    node: VegaUnitSpec | VegaLayerSpec,
    inheritedEncoding: VegaEncoding,
    inheritedTransforms: VegaTransform[],
    inheritedRows: readonly DatasetRow[],
    inheritedProjection: Record<string, unknown> | undefined,
    path: string,
  ) => {
    const rows =
      path === '$'
        ? inheritedRows
        : resolveRows((node as VegaUnitSpec).data, inheritedRows, datasets, gaps, path);
    const encoding = mergeEncoding(inheritedEncoding, node.encoding);
    const transform = [...inheritedTransforms, ...(node.transform ?? [])];
    // `projection` is a spec-level property in Vega-Lite — declared once
    // alongside a `layer` array, not repeated per layer — so a layer's own
    // (usually absent) `projection` only OVERRIDES the inherited one, mirroring
    // `mergeEncoding`'s parent/child precedence; every layer (the geoshape
    // base map AND a sibling geo-projected point/rule/text layer) needs the
    // SAME resolved projection to place its geometry consistently.
    const projection = (node as VegaUnitSpec).projection ?? inheritedProjection;

    if ('layer' in node && Array.isArray(node.layer)) {
      node.layer.forEach((child, index) => {
        walk(
          child,
          encoding,
          transform,
          rows,
          projection,
          path === '$' ? `layer[${index}]` : `${path}.layer[${index}]`,
        );
      });
      return;
    }
    if ((node as VegaUnitSpec).mark === undefined) {
      // Composite specs (facet/concat) reach here without a mark; already reported above.
      return;
    }
    units.push({
      mark: normalizeMark((node as VegaUnitSpec).mark),
      encoding,
      transform,
      rows,
      path,
      projection,
    });
  };

  walk(spec, {}, [], rootRows, undefined, '$');

  return {
    units,
    resolve: ('resolve' in spec ? (spec as VegaLayerSpec).resolve : undefined) ?? {},
    title: titleText(spec.title),
    width: numericSize(spec.width, gaps, 'width'),
    height: numericSize(spec.height, gaps, 'height'),
    datasets,
  };
}
