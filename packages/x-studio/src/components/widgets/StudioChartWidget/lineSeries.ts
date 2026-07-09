import type { MultiYSeriesData } from '../../../internals/chartAggregation';
import type { StudioChartType, StudioDataField } from '../../../models';
import {
  computeStackTotals,
  formatPercentValue,
  isAreaStacked,
  makeValueFormatter,
} from './chartWidgetHelpers';

export function buildMultiYLineSeries(
  multiYData: MultiYSeriesData,
  chartType: StudioChartType | undefined,
  fields?: StudioDataField[],
) {
  const isArea = chartType !== 'line';
  const isStacked = isAreaStacked(chartType);
  const is100 = chartType === 'area-100';
  const totals100 = is100
    ? computeStackTotals(
        multiYData.series.map((series) => series.values),
        multiYData.labels.length,
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
      yAxisId: useIndependentAxes ? `y-${index}` : undefined,
      highlightScope: { highlight: 'item' as const, fade: 'global' as const },
      valueFormatter: is100
        ? formatPercentValue
        : makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode, fieldDef?.precision, {
            compact: false,
            noFormatFallback: 'undefined',
          }),
    };
  });
}
