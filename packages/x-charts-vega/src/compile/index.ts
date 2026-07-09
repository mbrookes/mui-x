import { rainbowSurgePalette } from '@mui/x-charts/colorPalettes';
import type { XAxis, YAxis } from '@mui/x-charts/models';
import type { DatasetRow, VegaLiteSpec } from '../types';
import { createGapCollector } from '../gaps';
import type { TranslationGap } from '../gaps';
import { normalizeSpec } from '../normalize';
import { applyTransforms, applyEncodingTransforms } from '../transforms';
import { markRegistry, UNSUPPORTED_MARK_HINTS } from '../marks';
import { resolveAxes } from './scales';
import { resolveParams } from './params';
import type {
  AxisResolution,
  CompiledGeo,
  CompiledOverlay,
  CompiledReferenceLine,
  CompiledSeries,
  CompiledZAxis,
  PlotKind,
  UnitContext,
} from './context';
import { categoryIndex, categoryKey } from './context';

export interface CompileOptions {
  data?: readonly DatasetRow[];
  datasets?: Record<string, readonly DatasetRow[]>;
  /** Categorical palette; defaults to the x-charts rainbowSurge palette. */
  palette?: readonly string[];
}

export interface CompiledChart {
  /** 'polar' for pie/arc rendering, 'geo' for geoshape/map rendering. */
  chartKind: 'cartesian' | 'polar' | 'geo';
  series: CompiledSeries[];
  xAxis?: AxisResolution<XAxis>;
  yAxis?: AxisResolution<YAxis>;
  /** z (color) axes (heatmap cell coloring). */
  zAxis?: CompiledZAxis[];
  /** Geo provider config, set when chartKind is 'geo'. */
  geo?: CompiledGeo;
  plots: PlotKind[];
  referenceLines: CompiledReferenceLine[];
  /** Custom-drawn output for marks with no x-charts series equivalent. */
  overlays: CompiledOverlay[];
  grid: { vertical?: boolean; horizontal?: boolean };
  hasLegend: boolean;
  colors: readonly string[];
  title?: string;
  width?: number;
  height?: number;
  gaps: TranslationGap[];
}

/** Numeric values an overlay contributes to a continuous axis. */
function overlayAxisValues(overlay: CompiledOverlay, axis: 'x' | 'y'): number[] {
  const numbers = (values: Array<number | string | Date | undefined>) =>
    values.filter((value): value is number => typeof value === 'number');
  switch (overlay.kind) {
    case 'boxes': {
      const valueAxis = overlay.orientation === 'horizontal' ? 'x' : 'y';
      if (axis !== valueAxis) {
        return [];
      }
      return overlay.items.flatMap((item) => [item.min, item.max, ...(item.outliers ?? [])]);
    }
    case 'errorBars': {
      const valueAxis = overlay.orientation === 'horizontal' ? 'x' : 'y';
      if (axis !== valueAxis) {
        return [];
      }
      return overlay.items.flatMap((item) =>
        item.center === undefined
          ? [item.lower, item.upper]
          : [item.lower, item.upper, item.center],
      );
    }
    case 'band':
      return axis === 'y'
        ? overlay.points.flatMap((point) => [point.lower, point.upper])
        : numbers(overlay.points.map((point) => point.x));
    case 'segments':
      return numbers(
        overlay.items.flatMap((item) => (axis === 'x' ? [item.x1, item.x2] : [item.y1, item.y2])),
      );
    case 'text':
    case 'image':
      return numbers(overlay.items.map((item) => (axis === 'x' ? item.x : item.y)));
    default:
      return [];
  }
}

/**
 * Seeds continuous-axis min/max from overlay geometry (with 5% padding) when
 * an overlay-only chart would otherwise have a degenerate axis domain. Skips
 * discrete axes and axes that already constrain their domain.
 */
function applyOverlayDomains(
  overlays: CompiledOverlay[],
  x: AxisResolution<XAxis> | undefined,
  y: AxisResolution<YAxis> | undefined,
): void {
  const axisEntries: Array<['x' | 'y', AxisResolution<XAxis> | AxisResolution<YAxis> | undefined]> =
    [
      ['x', x],
      ['y', y],
    ];
  for (const [name, axis] of axisEntries) {
    if (!axis || axis.categories) {
      continue;
    }
    const config = axis.config as { min?: number | Date; max?: number | Date };
    if (config.min !== undefined || config.max !== undefined) {
      continue;
    }
    const values = overlays.flatMap((overlay) => overlayAxisValues(overlay, name));
    if (values.length === 0) {
      continue;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      continue;
    }
    const padding = (max - min) * 0.05;
    config.min = min - padding;
    config.max = max + padding;
  }
}

/**
 * Pure spec → x-charts-props compiler. Exported for tests and for hosts that
 * want to inspect the translation (including its gaps) without rendering.
 */
export function compileSpec(spec: VegaLiteSpec, options: CompileOptions = {}): CompiledChart {
  const gaps = createGapCollector();
  const palette = options.palette ?? rainbowSurgePalette('light');
  const normalized = normalizeSpec(spec, { data: options.data, datasets: options.datasets }, gaps);

  // Run transforms per unit first so axis domains see post-transform rows.
  const prepared = normalized.units.map((unit) => {
    const afterTopLevel = applyTransforms(unit.rows, unit.transform, gaps, unit.path);
    const { rows, encoding } = applyEncodingTransforms(
      afterTopLevel,
      unit.encoding,
      gaps,
      unit.path,
    );
    return { unit: { ...unit, encoding }, rows };
  });

  const axes = resolveAxes(prepared, gaps, normalized.resolve);

  const series: CompiledSeries[] = [];
  const plots = new Set<PlotKind>();
  const referenceLines: CompiledReferenceLine[] = [];
  const overlays: CompiledOverlay[] = [];
  const zAxis: CompiledZAxis[] = [];
  let geo: CompiledGeo | undefined;

  for (const { unit, rows } of prepared) {
    const compiler = markRegistry[unit.mark.type];
    if (!compiler) {
      gaps.add({
        code: `mark:${unit.mark.type}`,
        message:
          UNSUPPORTED_MARK_HINTS[unit.mark.type] ??
          `Mark type "${unit.mark.type}" has no x-charts equivalent; the layer was dropped.`,
        severity: 'unsupported',
        path: unit.path,
      });
      continue;
    }
    const ctx: UnitContext = {
      unit,
      rows,
      encoding: unit.encoding,
      x: axes.x,
      y: axes.y,
      gaps,
      palette,
      categoryIndex,
      categoryKey,
    };
    const compiled = compiler(ctx);
    series.push(...compiled.series);
    compiled.plots.forEach((plot) => plots.add(plot));
    referenceLines.push(...(compiled.referenceLines ?? []));
    overlays.push(...(compiled.overlays ?? []));
    zAxis.push(...(compiled.zAxis ?? []));
    if (compiled.geo) {
      if (geo) {
        gaps.add({
          code: 'composition:multiple-geo-layers',
          message:
            "Multiple geoshape layers each carry their own geo data; only the first layer's geoData/projection is used for the map.",
          severity: 'partial',
          path: unit.path,
        });
      } else {
        geo = compiled.geo;
      }
    }
  }

  // Assign palette colors to series that didn't get an explicit color. Pie
  // slices color themselves per-datum; heatmap cells are colored by the
  // zAxis colorMap and have no series-level color at all.
  series.forEach((entry, index) => {
    if (entry.type === 'pie' || entry.type === 'heatmap') {
      return;
    }
    const colorable = entry as { color?: string };
    if (colorable.color === undefined) {
      colorable.color = palette[index % palette.length];
    }
  });

  const isGeo = geo !== undefined;
  const isPolar = !isGeo && plots.has('pie');
  const exclusiveKinds: PlotKind[] = ['geoBase', 'mapShape', 'pie', 'pieLabels'];
  if ((isPolar || isGeo) && plots.size > (isGeo ? 2 : 1)) {
    const kind = isGeo ? 'geo/map' : 'pie/arc';
    if (Array.from(plots).some((plot) => !exclusiveKinds.includes(plot))) {
      gaps.add({
        code: `composition:mixed-${isGeo ? 'geo' : 'polar'}-cartesian`,
        message: `${kind} layers cannot be combined with cartesian layers in one chart; only the ${kind} layers are rendered.`,
        severity: 'partial',
        path: '$',
      });
    }
  }

  // Overlay-only charts (standalone boxplot/errorbar/errorband/segment specs)
  // have no series to seed x-charts' automatic continuous-axis extents, so
  // the axis would collapse to a degenerate domain. Derive min/max from the
  // overlay geometry instead (only when no series exist and the axis doesn't
  // already constrain its domain).
  if (series.length === 0 && overlays.length > 0) {
    applyOverlayDomains(overlays, axes.x, axes.y);
  }

  // Point-selection params map onto x-charts' controlled item highlighting;
  // apply the resolved scope to every series that doesn't set its own.
  const params = resolveParams(spec, gaps);
  if (params.highlightScope) {
    series.forEach((entry) => {
      const scoped = entry as { highlightScope?: unknown };
      if (scoped.highlightScope === undefined) {
        scoped.highlightScope = params.highlightScope;
      }
    });
  }

  // Pie series carry their labels per-slice (`data[i].label`) rather than on
  // the series object, so both locations must count toward showing a legend.
  const hasLegend = series.some((entry) => {
    if ((entry as { label?: unknown }).label !== undefined) {
      return true;
    }
    if (entry.type === 'pie') {
      const data = (entry as { data?: ReadonlyArray<{ label?: unknown }> }).data;
      return data?.some((item) => item.label !== undefined) ?? false;
    }
    return false;
  });

  let chartKind: CompiledChart['chartKind'] = 'cartesian';
  let outSeries = series;
  if (isGeo) {
    chartKind = 'geo';
    outSeries = series.filter((entry) => entry.type === 'mapShape');
  } else if (isPolar) {
    chartKind = 'polar';
    outSeries = series.filter((entry) => entry.type === 'pie');
  }
  const isCartesian = chartKind === 'cartesian';

  return {
    chartKind,
    series: outSeries,
    xAxis: isCartesian ? axes.x : undefined,
    yAxis: isCartesian ? axes.y : undefined,
    zAxis: zAxis.length > 0 ? zAxis : undefined,
    geo,
    plots: Array.from(plots),
    referenceLines,
    overlays,
    grid: axes.grid,
    hasLegend,
    colors: palette,
    title: normalized.title,
    width: normalized.width,
    height: normalized.height,
    gaps: gaps.list(),
  };
}
