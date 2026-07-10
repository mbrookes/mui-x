/**
 * The gallery runs the official Vega-Lite example specs (fetched from the
 * vega/vega-lite repo) verbatim. Those specs load data from `data/*.json|csv|tsv`
 * URLs, which the wrapper deliberately does not fetch. So at build time we bundle
 * the referenced vega-datasets (CSV/TSV pre-parsed to JSON) and, per spec, inline
 * every `data: {url}` with the local rows — recursively, so per-layer and
 * `lookup` transform data are covered too. TopoJSON `format` is preserved (the
 * wrapper understands inline topologies via `format.type: 'topojson'`).
 */

// Datasets keyed by base filename (e.g. `cars`, `co2-concentration`, `us-10m`).
const dataModules = import.meta.glob('./data/*.json', { eager: true, import: 'default' });
const dataByName: Record<string, unknown> = {};
for (const [path, rows] of Object.entries(dataModules)) {
  const name = path.replace(/^.*\/([^/]+)\.json$/, '$1');
  dataByName[name] = rows;
}

/** `data/co2-concentration.csv` → `co2-concentration`. */
function urlBaseName(url: string): string {
  return url.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Deep-clones `spec` and inlines every `{data: {url}}` with the bundled rows. */
export function inlineData<T>(spec: T): T {
  const clone = structuredClone(spec);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    const data = node.data;
    if (isRecord(data) && typeof data.url === 'string') {
      const rows = dataByName[urlBaseName(data.url)];
      if (rows !== undefined) {
        node.data = { values: rows, ...(data.format ? { format: data.format } : {}) };
      }
    }
    for (const key of Object.keys(node)) {
      // Don't descend into a resolved `values` payload (large + no nested URLs).
      if (key === 'data' && isRecord(node.data) && 'values' in node.data) {
        continue;
      }
      walk(node[key]);
    }
  };
  walk(clone);
  return clone;
}
