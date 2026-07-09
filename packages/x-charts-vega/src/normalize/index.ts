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
}

export interface NormalizeOptions {
  /** Host-provided rows overriding/standing in for `spec.data`. */
  data?: readonly DatasetRow[];
  /** Host-provided named datasets, merged over `spec.datasets`. */
  datasets?: Record<string, readonly DatasetRow[]>;
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
  const collection = topojsonFeature(topology as never, featureName as never);
  return [collection as unknown as DatasetRow];
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
  if (data.format?.type === 'topojson' && data.values !== undefined) {
    return resolveTopojsonRows(data, gaps, path) ?? inherited;
  }
  if (Array.isArray(data.values)) {
    return data.values as readonly DatasetRow[];
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
      return named;
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
  return { ...parent, ...child };
}

function normalizeMark(mark: VegaUnitSpec['mark']): VegaMarkDef {
  return typeof mark === 'string' ? { type: mark } : mark;
}

function titleText(title: VegaUnitSpec['title']): string | undefined {
  if (typeof title === 'string') {
    return title;
  }
  if (
    title &&
    typeof title === 'object' &&
    typeof (title as { text?: unknown }).text === 'string'
  ) {
    return (title as { text: string }).text;
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
  if (value !== undefined && value !== 'container') {
    gaps.add({
      code: `size:${prop}-step`,
      message: `Step-based or object ${prop} sizing is not supported; the chart falls back to container sizing.`,
      severity: 'ignored',
      path: prop,
    });
  }
  return undefined;
}

/**
 * Flattens a (possibly layered) Vega-Lite spec into a list of unit specs with
 * fully-resolved encoding, transforms, and rows. Facet/concat/repeat
 * compositions are rejected here with a gap — the wrapper renders nothing for
 * them rather than guessing.
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
        message: `\`${composite}\` view composition has no x-charts equivalent (one chart per container). Render one <VegaLiteChart /> per sub-view instead.`,
        severity: 'unsupported',
        path: composite,
      });
    }
  }
  if (spec.encoding && (spec.encoding.row || spec.encoding.column || spec.encoding.facet)) {
    gaps.add({
      code: 'encoding:facet',
      message:
        'Facet channels (row/column/facet) are not supported. Split the data and render one chart per facet.',
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
    path: string,
  ) => {
    const rows =
      path === '$'
        ? inheritedRows
        : resolveRows((node as VegaUnitSpec).data, inheritedRows, datasets, gaps, path);
    const encoding = mergeEncoding(inheritedEncoding, node.encoding);
    const transform = [...inheritedTransforms, ...(node.transform ?? [])];

    if ('layer' in node && Array.isArray(node.layer)) {
      node.layer.forEach((child, index) => {
        walk(
          child,
          encoding,
          transform,
          rows,
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
      projection: (node as VegaUnitSpec).projection,
    });
  };

  walk(spec, {}, [], rootRows, '$');

  return {
    units,
    resolve: ('resolve' in spec ? (spec as VegaLayerSpec).resolve : undefined) ?? {},
    title: titleText(spec.title),
    width: numericSize(spec.width, gaps, 'width'),
    height: numericSize(spec.height, gaps, 'height'),
  };
}
