'use client';
import type { StudioWidgetKind } from '../../models';
import { useStudioLocaleText } from '../../context';

export function useWidgetKindLabels(): Record<StudioWidgetKind, string> {
  const localeText = useStudioLocaleText();

  return {
    grid: localeText.widgetKindGrid,
    chart: localeText.widgetKindChart,
    kpi: localeText.widgetKindKpi,
    text: localeText.widgetKindText,
    filter: localeText.widgetKindFilter,
    pivot: localeText.widgetKindPivot,
    map: localeText.widgetKindMap,
  };
}

export function useDataTypeLabels(): Record<string, string> {
  const localeText = useStudioLocaleText();

  return {
    string: localeText.dataTypeString,
    number: localeText.dataTypeNumber,
    boolean: localeText.dataTypeBoolean,
    date: localeText.dataTypeDate,
    datetime: localeText.dataTypeDatetime,
  };
}
