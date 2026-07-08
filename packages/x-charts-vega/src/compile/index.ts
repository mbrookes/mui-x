import { rainbowSurgePalette } from '@mui/x-charts/colorPalettes';
import type { XAxis, YAxis } from '@mui/x-charts/models';
import type { DatasetRow , VegaLiteSpec } from '../types';
import { createGapCollector  } from '../gaps';
import type {TranslationGap} from '../gaps';
import { normalizeSpec } from '../normalize';
import { applyTransforms, applyEncodingTransforms } from '../transforms';
import { markRegistry, UNSUPPORTED_MARK_HINTS } from '../marks';
import { resolveAxes } from './scales';
import type {
  AxisResolution,
  CompiledReferenceLine,
  CompiledSeries,
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
  /** 'polar' when the spec resolves to pie/arc rendering. */
  chartKind: 'cartesian' | 'polar';
  series: CompiledSeries[];
  xAxis?: AxisResolution<XAxis>;
  yAxis?: AxisResolution<YAxis>;
  plots: PlotKind[];
  referenceLines: CompiledReferenceLine[];
  grid: { vertical?: boolean; horizontal?: boolean };
  hasLegend: boolean;
  colors: readonly string[];
  title?: string;
  width?: number;
  height?: number;
  gaps: TranslationGap[];
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
  }

  // Assign palette colors to series that didn't get an explicit color.
  series.forEach((entry, index) => {
    if (entry.color === undefined && entry.type !== 'pie') {
      (entry as { color?: string }).color = palette[index % palette.length];
    }
  });

  const isPolar = plots.has('pie');
  if (isPolar && plots.size > 1) {
    gaps.add({
      code: 'composition:mixed-polar-cartesian',
      message:
        'Pie/arc layers cannot be combined with cartesian layers in one chart; only the pie is rendered.',
      severity: 'partial',
      path: '$',
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

  return {
    chartKind: isPolar ? 'polar' : 'cartesian',
    series: isPolar ? series.filter((entry) => entry.type === 'pie') : series,
    xAxis: isPolar ? undefined : axes.x,
    yAxis: isPolar ? undefined : axes.y,
    plots: Array.from(plots),
    referenceLines,
    grid: axes.grid,
    hasLegend,
    colors: palette,
    title: normalized.title,
    width: normalized.width,
    height: normalized.height,
    gaps: gaps.list(),
  };
}
