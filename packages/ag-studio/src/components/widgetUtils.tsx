import * as React from 'react';
import BarChartIcon from '@mui/icons-material/BarChart';
import TableChartIcon from '@mui/icons-material/TableChart';
import NumbersIcon from '@mui/icons-material/Numbers';

import type { StudioDataSource, StudioFieldBinding, StudioWidget, StudioWidgetKind } from '../models';

export const WIDGET_TYPES: {
  kind: StudioWidgetKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  { kind: 'kpi', label: 'KPI', description: 'Single metric with aggregation', icon: <NumbersIcon fontSize="large" /> },
  { kind: 'chart', label: 'Chart', description: 'Bar, line, or pie chart', icon: <BarChartIcon fontSize="large" /> },
  { kind: 'grid', label: 'Table', description: 'Data grid with sorting & filtering', icon: <TableChartIcon fontSize="large" /> },
];

export function createDefaultWidget(kind: StudioWidgetKind, source: StudioDataSource): StudioWidget {
  const id = `widget-${kind}-${Date.now()}`;
  const bindings: StudioFieldBinding[] = source.fields.map((f) => ({ field: f.id, label: f.label }));

  if (kind === 'grid') {
    return {
      id,
      kind,
      title: `${source.label} table`,
      sourceId: source.id,
      layout: { x: 0, y: 0, width: 12, height: 8 },
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
      layout: { x: 0, y: 0, width: 6, height: 6 },
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
    layout: { x: 0, y: 0, width: 3, height: 3 },
    bindings,
    config: { kpiValueField: valueField, kpiAggregation: 'sum', kpiFormat: 'number' },
  };
}
