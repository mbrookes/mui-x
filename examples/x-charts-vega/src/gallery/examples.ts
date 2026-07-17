import type { VegaLiteSpec } from '@mui/x-charts-vega';
import titles from './titles.json';

// The verbatim Vega-Lite example specs, fetched from vega/vega-lite (see
// resolveData.ts). Keyed by base filename. Shared by every gallery page so the
// glob only runs once and the example list/order can't drift between them.
const specModules = import.meta.glob('./specs/*.json', { eager: true, import: 'default' });
const titleMap = titles as Record<string, { title: string; category: string }>;

export interface GalleryExample {
  name: string;
  title: string;
  category: string;
  spec: VegaLiteSpec;
}

export const examples: GalleryExample[] = Object.entries(specModules)
  .map(([path, spec]) => {
    const name = path.replace(/^.*\/([^/]+)\.json$/, '$1');
    return {
      name,
      title: titleMap[name]?.title ?? name,
      category: titleMap[name]?.category ?? '',
      spec: spec as VegaLiteSpec,
    };
  })
  .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));

// Stable (module-scope) id list, in the same order as rendered — a scroll spy's
// "current section" is the first id in this order still in view.
export const exampleIds = examples.map((example) => example.name);
