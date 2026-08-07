/**
 * Widget helpers that return React elements or need a live DOM node.
 *
 * The counterpart to `widgetUtils.ts`. Everything here either renders an icon, builds a widget
 * from the icon-bearing `WIDGET_TYPES` table, or reads computed styles off a mounted chart
 * (`exportChartToPng`). Keeping these apart from the pure helpers is what lets the engine be
 * imported without React — see `widgetUtils.ts`.
 */
import * as React from 'react';
import type {
  StudioCustomWidgetDef,
  StudioChartConfig,
  StudioWidget,
  StudioWidgetKind,
  StudioWidgetOf,
} from '../models';
import { isWidgetOfKind } from '../models';
import { createDefaultWidget } from './widgetFactory';
import { TextWidgetIcon } from '../icons/TextWidgetIcon';
import { KpiWidgetIcon } from '../icons/KpiWidgetIcon';
import { TableWidgetIcon } from '../icons/TableWidgetIcon';
import { BarGroupedIcon } from '../icons/charts/BarGroupedIcon';
import { BarStackedIcon } from '../icons/charts/BarStackedIcon';
import { Bar100Icon } from '../icons/charts/Bar100Icon';
import { BarHorizontalIcon } from '../icons/charts/BarHorizontalIcon';
import { BarStackedHorizontalIcon } from '../icons/charts/BarStackedHorizontalIcon';
import { Bar100HorizontalIcon } from '../icons/charts/Bar100HorizontalIcon';
import { LineIcon } from '../icons/charts/LineIcon';
import { AreaIcon } from '../icons/charts/AreaIcon';
import { AreaStackedIcon } from '../icons/charts/AreaStackedIcon';
import { Area100Icon } from '../icons/charts/Area100Icon';
import { ScatterIcon } from '../icons/charts/ScatterIcon';
import { PieIcon } from '../icons/charts/PieIcon';
import { DonutIcon } from '../icons/charts/DonutIcon';
import { ListFilterWidgetIcon } from '../icons/ListFilterWidgetIcon';
import { ButtonFilterWidgetIcon } from '../icons/ButtonFilterWidgetIcon';
import { DateFilterWidgetIcon } from '../icons/DateFilterWidgetIcon';
import { PivotWidgetIcon } from '../icons/PivotWidgetIcon';
import { MapWidgetIcon } from '../icons/MapWidgetIcon';

export const WIDGET_TYPES: {
  kind: StudioWidgetKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    kind: 'text',
    label: 'Text',
    description: 'Title, subtitle, and body copy',
    icon: <TextWidgetIcon size={28} />,
  },
  {
    kind: 'kpi',
    label: 'KPI',
    description: 'Single metric with aggregation',
    icon: <KpiWidgetIcon size={28} />,
  },
  {
    kind: 'chart',
    label: 'Chart',
    description: 'Visualise data with a configurable chart',
    icon: <BarGroupedIcon size={28} />,
  },
  {
    kind: 'grid',
    label: 'Table',
    description: 'Data grid with sorting & filtering',
    icon: <TableWidgetIcon size={28} />,
  },
  {
    kind: 'filter',
    label: 'Filter',
    description: 'Interactive filter control for view mode',
    icon: <ListFilterWidgetIcon size={28} />,
  },
  {
    kind: 'pivot',
    label: 'Pivot Table',
    description: 'Cross-tabulation with row/column dimensions',
    icon: <PivotWidgetIcon size={28} />,
  },
  {
    kind: 'map',
    label: 'Map',
    description: 'Choropleth world map by country',
    icon: <MapWidgetIcon size={28} />,
  },
];

/**
 * Single source of truth for minting a new widget of `kind` from the widget picker — whether the
 * user clicked the picker entry or dragged it onto the canvas.
 *
 * Both gestures used to have their own creation code: the click path threaded a custom kind's
 * `label` and `defaultConfig` into `createDefaultWidget`, while the canvas drop paths called a
 * bare `createDefaultWidget(kind)`. A dropped custom widget therefore came out with an empty
 * `customConfig` (violating `StudioCustomWidgetDef.defaultConfig`'s contract — and unrecoverable
 * for a kind with no `setupPanel`) and the raw kind string as its title instead of `def.label`.
 *
 * @param kind The widget kind to create.
 * @param customWidgetMap The consumer-registered custom widget definitions, keyed by kind
 *   (`useCustomWidgetMap()`). Built-in kinds are absent from it and get untouched defaults.
 */
export function createWidgetForKind<K extends StudioWidgetKind>(
  kind: K,
  customWidgetMap?: ReadonlyMap<string, StudioCustomWidgetDef>,
): StudioWidgetOf<K> {
  const def = customWidgetMap?.get(kind);
  if (!def) {
    return createDefaultWidget(kind);
  }
  return createDefaultWidget(kind, {
    title: def.label ?? kind,
    customConfig: def.defaultConfig ?? {},
  });
}

/** Returns a small (16px) icon representing the specific sub-type of a widget. */
export function getWidgetSubtypeIcon(widget: StudioWidget, size = 16): React.ReactNode {
  if (isWidgetOfKind(widget, 'chart')) {
    // Reads `barLayout` (a bar-family key) alongside `chartType`, so widen to the
    // flat cross-family config type rather than narrowing to one chart family.
    const config = widget.config as StudioChartConfig;
    const chartType = config.chartType ?? 'bar';
    const horizontal = config.barLayout === 'horizontal';
    switch (chartType) {
      case 'bar':
        return horizontal ? <BarHorizontalIcon size={size} /> : <BarGroupedIcon size={size} />;
      case 'bar-stacked':
        return horizontal ? (
          <BarStackedHorizontalIcon size={size} />
        ) : (
          <BarStackedIcon size={size} />
        );
      case 'bar-100':
        return horizontal ? <Bar100HorizontalIcon size={size} /> : <Bar100Icon size={size} />;
      case 'line':
        return <LineIcon size={size} />;
      case 'area':
        return <AreaIcon size={size} />;
      case 'area-stacked':
        return <AreaStackedIcon size={size} />;
      case 'area-100':
        return <Area100Icon size={size} />;
      case 'scatter':
        return <ScatterIcon size={size} />;
      case 'pie':
        return <PieIcon size={size} />;
      case 'donut':
        return <DonutIcon size={size} />;
      default:
        return <BarGroupedIcon size={size} />;
    }
  }
  if (isWidgetOfKind(widget, 'filter')) {
    const filterType = widget.config.filterWidgetType ?? 'multi-select';
    switch (filterType) {
      case 'toggle':
        return <ButtonFilterWidgetIcon size={size} />;
      case 'date-range':
      case 'slider':
        return <DateFilterWidgetIcon size={size} />;
      default:
        return <ListFilterWidgetIcon size={size} />;
    }
  }
  if (widget.kind === 'kpi') {
    return <KpiWidgetIcon size={size} />;
  }
  if (widget.kind === 'grid') {
    return <TableWidgetIcon size={size} />;
  }
  if (widget.kind === 'text') {
    return <TextWidgetIcon size={size} />;
  }
  if (widget.kind === 'pivot') {
    return <PivotWidgetIcon size={size} />;
  }
  if (widget.kind === 'map') {
    return <MapWidgetIcon size={size} />;
  }
  return null;
}

/**
 * Export chart as PNG image
 */
/**
 * Walk all elements of a (live, connected) source SVG and inline their computed styles onto
 * the corresponding elements of a structurally-identical target SVG (a clone of the source).
 * This ensures fonts, colors, and other CSS-driven properties survive serialization into a
 * standalone SVG/PNG (where stylesheets and CSS variables are unavailable).
 *
 * `getComputedStyle` only returns meaningful values for elements connected to the document, so
 * the styles must be READ from `sourceSvg` (the live, on-screen SVG) — a detached clone has no
 * cascade to compute from. They're WRITTEN onto `targetSvg` only, so the live SVG's own inline
 * styles are never mutated (a prior version inlined onto the live SVG in place before cloning,
 * which could pin stale theme colors onto the on-screen chart, surviving a later theme toggle).
 */
function inlineComputedStyles(sourceSvg: SVGElement, targetSvg: SVGElement): void {
  // Properties that need to be inlined for a faithful export
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
  ];

  const sourceElements = sourceSvg.querySelectorAll('*');
  const targetElements = targetSvg.querySelectorAll('*');
  sourceElements.forEach((el, i) => {
    const targetEl = targetElements[i];
    if (!(el instanceof Element) || !(targetEl instanceof Element)) {
      return;
    }
    const computed = window.getComputedStyle(el);
    const existing = (targetEl as SVGElement).style;
    for (const prop of STYLE_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (value && !existing.getPropertyValue(prop)) {
        existing.setProperty(prop, value);
      }
    }
  });
}

/**
 * Walk up from `el` and return the first ancestor's computed background colour that is not
 * fully transparent — i.e. the surface the chart visually sits on. Returns `undefined` when
 * nothing opaque is found (or outside the browser), so callers can fall back.
 */
function resolveOpaqueBackground(el: HTMLElement | null): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  // Matches a fully-transparent colour: `transparent`, or an rgba() whose alpha is 0. A pure
  // opaque `rgb(0, 0, 0)` (no alpha component) is intentionally not matched.
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

/** One rendered row of the built-in `ChartsLegend`, captured from the live DOM. */
interface ExportLegendItem {
  /** The swatch's real on-screen rect (used both for positioning and drawing a proxy shape). */
  markRect: DOMRect;
  /** The label text's real on-screen rect (used for positioning the redrawn text). */
  labelRect: DOMRect;
  /** Swatch fill colour, read from the mark's SVG shape (`fill`/`stroke` attribute). */
  color: string;
  label: string;
  font: string;
  labelColor: string;
  /** `0.5` for a toggled-off series (`legendClasses.hidden`), `1` otherwise. */
  opacity: number;
}

/**
 * Reads the built-in `ChartsLegend`'s rendered rows directly from the live DOM: each row's
 * swatch colour + label text, PLUS their own real on-screen rects. Positioning the redraw from
 * each item's actual `getBoundingClientRect()` (rather than reimplementing the legend's flex
 * layout) reproduces whatever arrangement the legend is actually using — row/column, above/
 * below/beside the chart, wrapped onto multiple lines — for free.
 *
 * Returns `[]` when no `ChartsLegend` is rendered (`hideLegend`, or a widget-specific custom
 * legend that isn't the built-in `ChartsLegend` component, e.g. `StudioPieChart`'s
 * `pieLegendBelow` custom percentage legend) — callers fall back to exporting the chart alone.
 */
function readLegendItems(chartContainer: HTMLElement): ExportLegendItem[] {
  const legendEl = chartContainer.querySelector('.MuiChartsLegend-root');
  if (!legendEl) {
    return [];
  }
  const items: ExportLegendItem[] = [];
  legendEl.querySelectorAll('.MuiChartsLegend-series').forEach((seriesEl) => {
    if (!(seriesEl instanceof HTMLElement)) {
      return;
    }
    const markEl = seriesEl.querySelector('.MuiChartsLabelMark-root');
    const labelEl = seriesEl.querySelector('.MuiChartsLabel-root');
    const label = labelEl?.textContent?.trim();
    if (!markEl || !labelEl || !label) {
      return;
    }
    // `ChartsLabelMark` colours its swatch via the `fill` (square/circle) or `stroke` (line)
    // attribute of an inner SVG shape — not a CSS background — so read the colour from there.
    const shapeEl = markEl.querySelector('rect, circle, path');
    const color = shapeEl?.getAttribute('fill') || shapeEl?.getAttribute('stroke') || '#999999';
    const labelStyle = window.getComputedStyle(labelEl);
    items.push({
      markRect: markEl.getBoundingClientRect(),
      labelRect: labelEl.getBoundingClientRect(),
      color: color === 'none' ? '#999999' : color,
      label,
      font: `${labelStyle.fontWeight} ${labelStyle.fontSize} ${labelStyle.fontFamily}`,
      labelColor: labelStyle.color || '#000000',
      opacity: Number(window.getComputedStyle(seriesEl).opacity) || 1,
    });
  });
  return items;
}

/**
 * Rasterizes a chart widget's on-screen `ChartsSurface` (plus its legend) to a PNG and triggers
 * the download.
 *
 * @returns `false` when there is nothing to export — no container, or no chart surface inside it
 *   (an unconfigured chart renders plain text, a no-data/errored chart renders a status overlay)
 *   — so the caller can surface that instead of appearing to succeed. `true` once rasterization
 *   has been kicked off. Note that `true` is not a guarantee the file lands: the actual download
 *   happens asynchronously in the `<img>` `onload` below (a load failure is reported there).
 */
export function exportChartToPng(
  widget: StudioWidget,
  chartContainer: HTMLElement | null,
  backgroundColor?: string,
): boolean {
  if (!chartContainer) {
    return false;
  }

  // Resolve the chart surface BY CLASS — the same way `readLegendItems` resolves
  // `.MuiChartsLegend-root` — rather than taking the first `<svg>` in the subtree. `canExport`
  // is kind-derived (every chart widget declares `export: 'png'`), so this runs in states with
  // no chart surface at all, and both status overlays living inside `chartContainerRef` contain
  // MUI `SvgIcon`s (`StudioNoDataOverlay`'s `InboxOutlinedIcon`, `StudioWidgetErrorOverlay`'s
  // `ErrorIcon`). An unscoped `querySelector('svg')` found those, so exporting a no-data or
  // errored chart downloaded a 2x-scaled PNG of a 32px inbox/error icon and presented it as a
  // successful export.
  const svg = chartContainer.querySelector<SVGSVGElement>('svg.MuiChartsSurface-root');
  if (!svg) {
    return false;
  }

  // Clone the SVG first, then inline computed styles onto the CLONE only — reading computed
  // values from the live `svg` (styles can only be computed from a document-connected element)
  // but writing them onto `clonedSvg` so the live, on-screen chart is never mutated.
  const clonedSvg = svg.cloneNode(true) as SVGElement;
  inlineComputedStyles(svg, clonedSvg);

  const svgRect = svg.getBoundingClientRect();
  clonedSvg.setAttribute('width', String(svgRect.width));
  clonedSvg.setAttribute('height', String(svgRect.height));

  // Serialize SVG to string
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(clonedSvg);

  // MUI X Charts renders the legend as HTML (a `<ul>`, `ChartsLegend`) OUTSIDE the `<svg>` — the
  // `<svg>` alone (captured above) never includes it, so a multi-series chart's exported PNG
  // silently dropped its legend entirely. Rasterizing arbitrary HTML through the
  // `<img>`-of-serialized-SVG pipeline above (e.g. wrapping the legend in an SVG
  // `<foreignObject>`) is a known cross-browser-fragile technique (notably unreliable in
  // Safari), so instead each legend row's colour/text/position is read straight from the live
  // DOM and redrawn with plain Canvas 2D primitives once the chart SVG has loaded — composited
  // alongside it based on their REAL on-screen rects (works regardless of legend position/
  // direction/wrapping). The swatch is redrawn as a plain filled rounded square regardless of
  // the legend's actual mark shape (square/circle/line) — a deliberate simplification to keep
  // this fix scoped; the colour and label text are exact.
  const legendItems = readLegendItems(chartContainer);

  // The composed canvas must cover both the chart SVG and every legend item's real rect —
  // pick the tightest bounding box in VIEWPORT coordinates (both `svg` and the legend live in
  // the same document, so their `getBoundingClientRect()`s are directly comparable) so nothing
  // is clipped regardless of whether the legend sits above/below/beside the chart.
  let left = svgRect.left;
  let top = svgRect.top;
  let right = svgRect.right;
  let bottom = svgRect.bottom;
  for (const item of legendItems) {
    left = Math.min(left, item.markRect.left, item.labelRect.left);
    top = Math.min(top, item.markRect.top, item.labelRect.top);
    right = Math.max(right, item.markRect.right, item.labelRect.right);
    bottom = Math.max(bottom, item.markRect.bottom, item.labelRect.bottom);
  }
  const exportWidth = right - left;
  const exportHeight = bottom - top;

  // Create a canvas
  const canvas = document.createElement('canvas');
  const scale = 2; // Higher resolution
  canvas.width = exportWidth * scale;
  canvas.height = exportHeight * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return false;
  }

  ctx.scale(scale, scale);
  // Resolve the fill from the live DOM (the first opaque ancestor behind the chart, i.e. the
  // widget card) rather than a theme value. Under `cssVariables` themes `theme.palette.*` is
  // pinned to the default (light) colour scheme, so a passed-in value would export a light
  // background even in dark mode — making light chart text unreadable. The DOM-resolved colour
  // always reflects the active scheme. Fall back to the passed colour, then white.
  ctx.fillStyle = resolveOpaqueBackground(chartContainer) ?? backgroundColor ?? 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Convert SVG to image
  const img = new Image();
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  img.onload = () => {
    // Offset by the chart SVG's own position within the composed canvas — this is (0, 0)
    // whenever the legend sits at or after the SVG's top-left (the common case), and only
    // shifts when a legend item extends further left/up than the chart itself.
    ctx.drawImage(img, svgRect.left - left, svgRect.top - top);

    for (const item of legendItems) {
      ctx.globalAlpha = item.opacity;
      ctx.fillStyle = item.color;
      ctx.fillRect(
        item.markRect.left - left,
        item.markRect.top - top,
        item.markRect.width,
        item.markRect.height,
      );
      ctx.font = item.font;
      ctx.fillStyle = item.labelColor;
      ctx.textBaseline = 'middle';
      ctx.fillText(
        item.label,
        item.labelRect.left - left,
        item.labelRect.top - top + item.labelRect.height / 2,
      );
      ctx.globalAlpha = 1;
    }

    URL.revokeObjectURL(url);

    // Download the PNG
    const pngUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = pngUrl;
    link.download = `${widget.title.replace(/[^a-z0-9]/gi, '_')}_chart.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  // Without an error handler, a failed SVG-blob image load (e.g. the browser rejects the
  // serialized SVG) silently no-ops AND leaks the object URL `onload` would have revoked.
  // There's no existing user-facing error surface for this export path, so
  // a console warning is the best available signal short of adding new UI.
  img.onerror = () => {
    URL.revokeObjectURL(url);
    console.warn('MUI X Studio: failed to export chart to PNG (image failed to load).');
  };

  img.src = url;
  return true;
}
