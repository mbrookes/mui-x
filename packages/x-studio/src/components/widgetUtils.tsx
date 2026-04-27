import * as React from 'react';

import type {
  StudioDataSource,
  StudioFieldBinding,
  StudioWidget,
  StudioWidgetKind,
} from '../models';
import { TextWidgetIcon, KpiWidgetIcon, TableWidgetIcon, BarGroupedIcon } from './icons/ChartIcons';

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
];

export function widgetKindRequiresDataSource(kind: StudioWidgetKind) {
  return kind !== 'text';
}

export function createDefaultWidget(
  kind: StudioWidgetKind,
  source?: StudioDataSource,
): StudioWidget {
  const id = `widget-${kind}-${Date.now()}`;
  const bindings: StudioFieldBinding[] =
    source?.fields.map((f) => ({ field: f.id, label: f.label })) ?? [];

  if (kind === 'text') {
    return {
      id,
      kind,
      title: 'Text block',
      bindings,
      config: {
        textSubtitle: 'Add supporting context',
        textBody:
          'Use this widget for narrative context, callouts, or guidance that complements the data on the page.',
      },
    };
  }

  if (!source) {
    throw new Error(`A data source is required to create a ${kind} widget.`);
  }

  if (kind === 'grid') {
    return {
      id,
      kind,
      title: `${source.label} table`,
      sourceId: source.id,
      bindings,
      config: { columns: source.fields.map((f) => f.id) },
    };
  }

  if (kind === 'chart') {
    const xField = source.fields.find((f) => f.type === 'string')?.id ?? source.fields[0]?.id;
    const yField = source.fields.find((f) => f.type === 'number')?.id ?? source.fields[1]?.id;

    return {
      id,
      kind,
      title: `${source.label} chart`,
      sourceId: source.id,
      bindings,
      config: { chartType: 'bar', xField, yField },
    };
  }

  // KPI
  const valueField = source.fields.find((f) => f.type === 'number')?.id ?? '';

  return {
    id,
    kind,
    title: `${source.label} KPI`,
    sourceId: source.id,
    bindings,
    config: { kpiValueField: valueField, kpiAggregation: 'sum' },
  };
}

/**
 * Export grid data as CSV
 */
export function exportGridToCsv(
  widget: StudioWidget,
  dataSource: StudioDataSource | undefined,
  rows: Record<string, unknown>[],
): void {
  if (!dataSource) {
    return;
  }

  const visibleColumns = widget.config.columns?.length
    ? widget.config.columns
    : widget.bindings.map((b) => b.field);

  // Create header row
  const headers = visibleColumns.map((col) => {
    const field = dataSource.fields.find((f) => f.id === col);
    return field?.label ?? col;
  });

  // Create data rows
  const csvRows = rows.map((row) =>
    visibleColumns
      .map((col) => {
        const value = row[col];
        // Escape quotes and wrap in quotes if contains comma, quote, or newline
        const strVal = String(value ?? '');
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      })
      .join(','),
  );

  const csvContent = [headers.join(','), ...csvRows].join('\n');

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
