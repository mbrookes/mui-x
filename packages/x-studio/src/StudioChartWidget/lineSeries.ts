import { formatNumber } from '../internals/numberFormat';
import type { MultiYSeriesData } from '../internals/chartUtils';
import type { StudioChartType, StudioDataField, StudioNumberFormat } from '../models';

function makeValueFormatter(format?: StudioNumberFormat, currencyCode?: string) {
  if (!format) {
    return undefined;
  }
  return (value: number | null) => {
    if (value === null) {
      return '';
    }
    return formatNumber(value, format, currencyCode);
  };
}

export function buildMultiYLineSeries(
  multiYData: MultiYSeriesData,
  chartType: StudioChartType | undefined,
  fields?: StudioDataField[],
) {
  const isArea = chartType !== 'line';
  const isStacked = chartType === 'area-stacked' || chartType === 'area-100';
  const is100 = chartType === 'area-100';
  const totals100 = is100
    ? multiYData.labels.map((_, index) =>
        multiYData.series.reduce<number>(
          (sum, series) => sum + ((series.values[index] ?? 0) as number),
          0,
        ),
      )
    : null;
  const useIndependentAxes = !isStacked && multiYData.series.length > 1;

  return multiYData.series.map((series, index) => {
    const fieldDef = fields?.find((field) => field.id === series.fieldId);
    const data = totals100
      ? series.values.map((value, valueIndex) => {
          const total = totals100[valueIndex];
          return total ? ((value as number) / total) * 100 : 0;
        })
      : series.values;

    return {
      id: `${series.fieldId}-${index}`,
      data,
      label: fieldDef?.label ?? series.fieldId,
      area: isArea,
      connectNulls: true as const,
      stack: isStacked ? 'total' : undefined,
      yAxisKey: useIndependentAxes ? `y-${index}` : undefined,
      highlightScope: { highlight: 'item' as const, fade: 'global' as const },
      valueFormatter: is100
        ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
        : makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode),
    };
  });
}
