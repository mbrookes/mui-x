import { getAllowedChartConfigKeys } from '@mui/x-studio-schema';
import type { StudioChartConfig, StudioChartSeries, StudioChartType } from '../../../models';

/**
 * The measure ("Y") series a chart config currently declares, in the one canonical
 * shape every control reads: `ySeries` when present, otherwise the legacy single
 * `yField` seeded as a one-entry list, otherwise empty.
 */
export function resolveMeasureSeries(config: {
  ySeries?: StudioChartSeries[];
  yField?: string;
}): StudioChartSeries[] {
  return config.ySeries ?? (config.yField ? [{ fieldId: config.yField }] : []);
}

/**
 * The single config patch that every measure-series write goes through — the
 * multi-series pickers in `ChartSetupPanel` and the single-measure pickers in the
 * scatter / funnel / heatmap / sankey sections alike.
 *
 * Invariants it upholds, in ONE place so no writer can silently skip one:
 *
 *  - **`yField` mirrors the first OWN-SOURCE series field.** A blended series carries
 *    its own `sourceId` (honoured for `mixed` charts only) and is resolved separately by
 *    the renderer, so a foreign field id must never land in the flat, single-source
 *    `yField` that `analyzeChartSupport` and the eventual aggregation read back.
 *  - **A field-less series list is a row COUNT (BL-186).** Count is the one aggregation
 *    that needs no measure field, so it is re-locked here: a cleared picker can never
 *    leave the chart holding an aggregation it has no field to compute. The lock is
 *    written only for chart types whose schema actually declares `yAggregation` —
 *    sankey and scatter do not, and the controller's chart-type key guard would strip
 *    the key (with a dev warning) if it were sent anyway.
 *  - **An existing `yAggregation` survives a series change that keeps a field**, since a
 *    chart may legitimately carry a non-default sum/avg/min/max.
 */
export function buildMeasureSeriesPatch(
  chartType: StudioChartType,
  next: StudioChartSeries[],
  widgetSourceId?: string,
): Partial<StudioChartConfig> {
  const nativeFieldIds = next.flatMap((series) =>
    series.fieldId && !(series.sourceId && series.sourceId !== widgetSourceId)
      ? [series.fieldId]
      : [],
  );
  const hasField = next.some((series) => series.fieldId);
  const locksCount = !hasField && getAllowedChartConfigKeys(chartType).has('yAggregation');
  return {
    ySeries: next,
    yField: nativeFieldIds[0] ?? '',
    ...(locksCount ? { yAggregation: 'count' as const } : {}),
  };
}

/**
 * The patch for the SINGLE-measure pickers (scatter / funnel / heatmap / sankey), which
 * expose one value field even though the config they share with the multi-series chart
 * families stores a `ySeries` list.
 *
 * Such a picker owns series slot 0 only. Any further series the config carries — a bar
 * chart with three measures switched to funnel keeps all three — is preserved behind it,
 * so switching back does not silently lose them. The picked field is de-duplicated out of
 * that tail, since the same field must not appear as two series.
 *
 * Clearing the picker means "no measure", which is `ySeries: []` — never a placeholder
 * `{ fieldId: '' }` entry. A placeholder reads as "a series row awaiting a field" to the
 * multi-series panel, which would then render an empty series row next to the BL-186
 * locked Count select; and it would keep the retained tail's first field showing in this
 * very picker (which falls back to the first series field), so a clear would not look
 * like a clear.
 */
export function buildSingleMeasurePatch(
  chartType: StudioChartType,
  config: { ySeries?: StudioChartSeries[]; yField?: string },
  fieldId: string,
  widgetSourceId?: string,
): Partial<StudioChartConfig> {
  const current = resolveMeasureSeries(config);
  const next = fieldId
    ? [
        { fieldId },
        ...current.slice(1).filter((series) => series.fieldId && series.fieldId !== fieldId),
      ]
    : [];
  return buildMeasureSeriesPatch(chartType, next, widgetSourceId);
}
