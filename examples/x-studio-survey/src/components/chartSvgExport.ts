/**
 * Rasterizes an SVG-based chart (e.g. an `@mui/x-charts` `LineChart`) to a downloaded PNG.
 *
 * Generic SVG->canvas export, not specific to the YoY comparison widget — kept app-level (see
 * the repo's "custom charts stay app-level" rule) rather than reaching into `@mui/x-studio`'s
 * internal (non-exported) `exportChartToPng`, which this mirrors for the built-in 'chart' widget
 * kind but can't be imported directly from outside the package.
 */

const STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-dasharray',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'color',
  'letter-spacing',
] as const;

/** Inlines computed styles onto every element so theme fonts/CSS-variable colors survive
 * serialization outside the live document (a cloned, detached SVG has no cascade to resolve
 * `var(--mui-palette-*)` against). */
function inlineComputedStyles(svgElement: SVGElement): void {
  const elements = svgElement.querySelectorAll('*');
  elements.forEach((el) => {
    if (!(el instanceof Element)) {
      return;
    }
    const computed = window.getComputedStyle(el);
    const existing = (el as SVGElement).style;
    for (const prop of STYLE_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (value && !existing.getPropertyValue(prop)) {
        existing.setProperty(prop, value);
      }
    }
  });
}

/** Walk up from `el` and return the first ancestor's computed background colour that isn't fully
 * transparent — the surface the chart visually sits on (tracks light/dark mode correctly, unlike
 * a passed-in theme value, which under `cssVariables` themes is pinned to the light scheme). */
function resolveOpaqueBackground(el: HTMLElement): string | undefined {
  const isTransparent = (bg: string): boolean =>
    bg === 'transparent' || /^rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*0(\.0+)?\s*\)$/.test(bg);
  let node: HTMLElement | null = el;
  while (node) {
    const bg = window.getComputedStyle(node).backgroundColor;
    if (bg && !isTransparent(bg)) {
      return bg;
    }
    node = node.parentElement;
  }
  return undefined;
}

/** The container can hold several `<svg>` elements — e.g. x-charts renders each legend swatch as
 * its own tiny SVG alongside the actual plot — so the largest by area (the real chart) is picked
 * rather than the first in document order. */
function findChartSvg(container: HTMLElement): SVGSVGElement | null {
  let best: SVGSVGElement | null = null;
  let bestArea = 0;
  container.querySelectorAll('svg').forEach((candidate) => {
    const rect = candidate.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = candidate;
      bestArea = area;
    }
  });
  return best;
}

export function exportChartSvgToPng(chartContainer: HTMLElement, filenameBase: string): void {
  const svg = findChartSvg(chartContainer);
  if (!svg) {
    return;
  }

  inlineComputedStyles(svg);

  const clonedSvg = svg.cloneNode(true) as SVGElement;
  const svgRect = svg.getBoundingClientRect();
  clonedSvg.setAttribute('width', String(svgRect.width));
  clonedSvg.setAttribute('height', String(svgRect.height));

  const svgString = new XMLSerializer().serializeToString(clonedSvg);

  const canvas = document.createElement('canvas');
  const scale = 2; // Higher resolution
  canvas.width = svgRect.width * scale;
  canvas.height = svgRect.height * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  ctx.scale(scale, scale);
  ctx.fillStyle = resolveOpaqueBackground(chartContainer) ?? 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const img = new Image();
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  img.onload = () => {
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    const pngUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = pngUrl;
    link.download = `${filenameBase.replace(/[^a-z0-9]/gi, '_')}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  img.src = url;
}
