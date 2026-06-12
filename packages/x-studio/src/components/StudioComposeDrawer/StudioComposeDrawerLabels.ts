'use client';
import type { StudioWidgetKind } from '../../models';
import { useStudioLocaleText } from '../../context';
import type { StudioLocaleText } from '../../internals/StudioUIConfigContext';

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

export type WidgetKindLocalizedInfo = { label: string; description: string };

export function getBuiltInWidgetKindInfo(
  localeText: StudioLocaleText,
): Partial<Record<StudioWidgetKind, WidgetKindLocalizedInfo>> {
  return {
    text: { label: localeText.widgetKindText, description: localeText.widgetKindTextDescription },
    kpi: { label: localeText.widgetKindKpi, description: localeText.widgetKindKpiDescription },
    chart: {
      label: localeText.widgetKindChart,
      description: localeText.widgetKindChartDescription,
    },
    grid: { label: localeText.widgetKindGrid, description: localeText.widgetKindGridDescription },
    filter: {
      label: localeText.widgetKindFilter,
      description: localeText.widgetKindFilterDescription,
    },
    pivot: {
      label: localeText.widgetKindPivot,
      description: localeText.widgetKindPivotDescription,
    },
    map: { label: localeText.widgetKindMap, description: localeText.widgetKindMapDescription },
  };
}
