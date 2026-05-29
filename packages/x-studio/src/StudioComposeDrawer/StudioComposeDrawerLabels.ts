import type { StudioWidgetKind } from '../models';

export const KIND_LABEL: Record<StudioWidgetKind, string> = {
  grid: 'Table',
  chart: 'Chart',
  kpi: 'KPI',
  text: 'Text',
  filter: 'Filter',
  pivot: 'Pivot Table',
  map: 'Map',
};

export const TYPE_FORMAT_LABEL: Record<string, string> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
  datetime: 'Date & Time',
};
