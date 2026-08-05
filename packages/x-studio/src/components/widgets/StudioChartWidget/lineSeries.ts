import type { MultiYSeriesData } from '../../../internals/chartAggregation';
import type { StudioChartType, StudioDataSource, StudioExpressionField } from '../../../models';
import {
  computeStackTotals,
  formatPercentValue,
  isAreaStacked,
  makeValueFormatter,
  resolveFieldDef,
} from './chartWidgetHelpers';

/**
 * Builds the (non-ghost) multi-Y line/area series. Resolves each series' field def via
 * `resolveFieldDef` — checking the data source's native fields AND `expressionFields` —
 * so a computed (expression) y-field gets its real label/format here too, matching the
 * ghost-active branch in `StudioLineAreaChart.tsx` (which already used `resolveFieldDef`)
 * and the bar multi-Y path (`StudioBarChart.tsx`). Previously this used a private
 * `fields?.find(...)` lookup that never consulted expression fields, so a computed
 * y-field's legend/tooltip only showed the correct label/format while a cross-filter
 * ghost was active.
 *
 * Also uses the shared `makeValueFormatter` defaults (no `compact`/`noFormatFallback`
 * override) so the tooltip number style matches both the y-axis formatter (which also
 * uses the defaults) and the ghost-active branch's series formatter — previously this
 * function opted into `{compact: false, noFormatFallback: 'undefined'}`, so even a
 * native field's tooltip changed style when a ghost toggled on/off.
 */
export function buildMultiYLineSeries(
  multiYData: MultiYSeriesData,
  chartType: StudioChartType | undefined,
  dataSource?: StudioDataSource,
  expressionFields: StudioExpressionField[] = [],
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
    const fieldDef = resolveFieldDef(series.fieldId, dataSource, expressionFields);
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
        : makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode, fieldDef?.precision),
    };
  });
}
