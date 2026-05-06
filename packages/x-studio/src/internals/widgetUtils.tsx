import * as React from 'react';

import type {
  StudioDataSource,
  StudioKpiAggregation,
  StudioWidget,
  StudioWidgetKind,
} from '../models';
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
    description: 'Bar, line, pie, area, and scatter charts',
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
];

export function widgetKindRequiresDataSource(kind: StudioWidgetKind) {
  return kind !== 'text';
}

/** Returns a small (16px) icon representing the specific sub-type of a widget. */
export function getWidgetSubtypeIcon(widget: StudioWidget, size = 16): React.ReactNode {
  if (widget.kind === 'chart') {
    const chartType = widget.config.chartType ?? 'bar';
    const horizontal = widget.config.barLayout === 'horizontal';
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
  if (widget.kind === 'filter') {
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
  if (widget.kind === 'kpi') return <KpiWidgetIcon size={size} />;
  if (widget.kind === 'grid') return <TableWidgetIcon size={size} />;
  if (widget.kind === 'text') return <TextWidgetIcon size={size} />;
  return null;
}

export function createDefaultWidget(
  kind: StudioWidgetKind,
  source?: StudioDataSource,
): StudioWidget {
  const id = `widget-${kind}-${Date.now()}`;

  if (kind === 'text') {
    return {
      id,
      kind,
      title: 'Text block',
      config: {
        textSubtitle: '',
        textBody: '',
      },
    };
  }

  if (kind === 'grid') {
    return {
      id,
      kind,
      title: '',
      config: { columns: source ? source.fields.map((f) => f.id) : [] },
      ...(source ? { sourceId: source.id } : {}),
    };
  }

  if (kind === 'chart') {
    return {
      id,
      kind,
      title: '',
      config: { chartType: 'bar' },
      ...(source ? { sourceId: source.id } : {}),
    };
  }

  if (kind === 'filter') {
    return {
      id,
      kind,
      title: 'Filter',
      config: { filterWidgetType: 'multi-select' as const },
      ...(source ? { sourceId: source.id } : {}),
    };
  }

  // KPI
  return {
    id,
    kind,
    title: '',
    config: { kpiAggregation: 'sum' },
    ...(source ? { sourceId: source.id } : {}),
  };
}

const KPI_AGG_PREFIXES: Record<StudioKpiAggregation, string> = {
  sum: 'Total',
  avg: 'Average',
  count: 'Count of',
  min: 'Min',
  max: 'Max',
};

const CHART_GROUP_BY_TITLE_PREFIXES = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  quarter: 'Quarterly',
  year: 'Yearly',
} as const;

function summarizeFieldLabels(labels: string[], maxVisible = 3) {
  if (labels.length <= maxVisible) {
    return labels.join(', ');
  }

  return `${labels.slice(0, maxVisible).join(', ')} +${labels.length - maxVisible} more`;
}

/**
 * Infer a human-readable title and subtitle for a widget based on its current config.
 * Used when titleMode/subtitleMode is 'auto' (the default).
 */
export function inferWidgetTitles(
  widget: StudioWidget,
  dataSources: Record<string, StudioDataSource>,
): { title: string; subtitle: string } {
  const source = widget.sourceId ? dataSources[widget.sourceId] : undefined;
  const config = widget.config;

  const findFieldLabel = (fieldId: string | undefined, sourceId?: string): string | undefined => {
    if (!fieldId) {
      return undefined;
    }
    const ds = sourceId ? dataSources[sourceId] : source;
    return ds?.fields.find((f) => f.id === fieldId)?.label;
  };

  switch (widget.kind) {
    case 'chart': {
      const xLabel = findFieldLabel(config.xField);
      const yLabels = (config.ySeries ?? (config.yField ? [{ fieldId: config.yField }] : []))
        .map((s) => findFieldLabel(s.fieldId))
        .filter((l): l is string => Boolean(l));

      const seriesLabel = findFieldLabel(config.seriesField);
      const chartType = config.chartType ?? 'bar';
      const isScatter = chartType === 'scatter';
      const groupByTitlePrefix = config.xGroupBy
        ? CHART_GROUP_BY_TITLE_PREFIXES[config.xGroupBy]
        : undefined;

      let title = source ? `${source.label} chart` : 'Chart';
      if (isScatter && xLabel && yLabels.length > 0) {
        title = `${yLabels[0]} vs ${xLabel}`;
      } else if (groupByTitlePrefix) {
        const metricLabel = yLabels.length > 0 ? yLabels.join(', ') : title;
        title = `${groupByTitlePrefix} ${metricLabel}`;
        if (seriesLabel) {
          title = `${title} by ${seriesLabel}`;
        }
      } else if (yLabels.length > 0 && xLabel) {
        title = `${yLabels.join(', ')} by ${xLabel}`;
      } else if (yLabels.length > 0) {
        title = yLabels.join(', ');
      }

      const splitLabel = seriesLabel && !groupByTitlePrefix ? `split by ${seriesLabel}` : '';
      const subtitleParts = [source?.label, splitLabel].filter(Boolean);
      const subtitle = subtitleParts.join(' · ');

      return { title, subtitle };
    }

    case 'kpi': {
      const fieldLabel = findFieldLabel(config.kpiValueField);
      const aggPrefix = KPI_AGG_PREFIXES[config.kpiAggregation ?? 'sum'] ?? '';
      const title = fieldLabel
        ? `${aggPrefix} ${fieldLabel}`.trim()
        : source
          ? `${source.label} KPI`
          : 'KPI';
      return { title, subtitle: '' };
    }

    case 'grid': {
      const title = source?.label ?? 'Table';
      const visibleColumnLabels = (
        config.columns?.length ? config.columns : (source?.fields.map((f) => f.id) ?? [])
      )
        .map((fieldId) => findFieldLabel(fieldId))
        .filter((label): label is string => Boolean(label));

      const subtitle =
        visibleColumnLabels.length > 0 ? summarizeFieldLabels(visibleColumnLabels) : '';

      return { title, subtitle };
    }

    case 'filter': {
      const fieldLabel = findFieldLabel(config.filterWidgetField, config.filterWidgetSourceId);
      const title = fieldLabel ? `Filter: ${fieldLabel}` : 'Filter';
      return { title, subtitle: '' };
    }

    case 'text':
      return { title: widget.title || 'Text', subtitle: widget.subtitle ?? '' };

    default:
      return { title: widget.title || widget.kind || 'Widget', subtitle: widget.subtitle ?? '' };
  }
}

/**
 * Export grid data as CSV
 */
/**
 * Build a CSV string for the given widget/source/rows without triggering a download.
 * Exported for testing.
 */
export function buildCsvContent(
  widget: StudioWidget,
  dataSource: StudioDataSource,
  rows: Record<string, unknown>[],
): string {
  const visibleColumns = widget.config.columns?.length
    ? widget.config.columns
    : dataSource.fields.map((f) => f.id);

  const headers = visibleColumns.map((col) => {
    const field = dataSource.fields.find((f) => f.id === col);
    return field?.label ?? col;
  });

  const csvRows = rows.map((row) =>
    visibleColumns
      .map((col) => {
        const value = row[col];
        const strVal = String(value ?? '');
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      })
      .join(','),
  );

  return [headers.join(','), ...csvRows].join('\n');
}

export function exportGridToCsv(
  widget: StudioWidget,
  dataSource: StudioDataSource | undefined,
  rows: Record<string, unknown>[],
): void {
  if (!dataSource) {
    return;
  }

  const csvContent = buildCsvContent(widget, dataSource, rows);

  // Download the file
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${widget.title.replace(/[^a-z0-9]/gi, '_')}_export.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Export chart as PNG image
 */
export function exportChartToPng(widget: StudioWidget, chartContainer: HTMLElement | null): void {
  if (!chartContainer) {
    return;
  }

  const svg = chartContainer.querySelector('svg');
  if (!svg) {
    return;
  }

  // Clone the SVG to avoid modifying the original
  const clonedSvg = svg.cloneNode(true) as SVGElement;

  // Get computed styles and inline them
  const svgRect = svg.getBoundingClientRect();
  clonedSvg.setAttribute('width', String(svgRect.width));
  clonedSvg.setAttribute('height', String(svgRect.height));

  // Serialize SVG to string
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(clonedSvg);

  // Create a canvas
  const canvas = document.createElement('canvas');
  const scale = 2; // Higher resolution
  canvas.width = svgRect.width * scale;
  canvas.height = svgRect.height * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  ctx.scale(scale, scale);
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Convert SVG to image
  const img = new Image();
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  img.onload = () => {
    ctx.drawImage(img, 0, 0);
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

  img.src = url;
}
