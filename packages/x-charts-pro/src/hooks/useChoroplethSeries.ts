'use client';
import {
  useSeriesOfType,
  useAllSeriesOfType,
  type ProcessedSeries,
  type SeriesId,
  type ChartSeriesDefaultized,
} from '@mui/x-charts/internals';

export type UseChoroplethSeriesReturnValue = ChartSeriesDefaultized<'choropleth'>;
export type UseChoroplethSeriesContextReturnValue = ProcessedSeries['choropleth'];

/**
 * Get access to the internal state of choropleth series.
 *
 * @param {SeriesId} seriesId The id of the series to get.
 * @returns {UseChoroplethSeriesReturnValue} the choropleth series
 */
export function useChoroplethSeries(seriesId: SeriesId): UseChoroplethSeriesReturnValue | undefined;
/**
 * Get access to the internal state of choropleth series.
 *
 * When called without arguments, it returns all choropleth series.
 *
 * @returns {UseChoroplethSeriesReturnValue[]} the choropleth series
 */
export function useChoroplethSeries(): UseChoroplethSeriesReturnValue[];
/**
 * Get access to the internal state of choropleth series.
 *
 * @param {SeriesId[]} seriesIds The ids of the series to get. Order is preserved.
 * @returns {UseChoroplethSeriesReturnValue[]} the choropleth series
 */
export function useChoroplethSeries(seriesIds: SeriesId[]): UseChoroplethSeriesReturnValue[];
export function useChoroplethSeries(seriesIds?: SeriesId | SeriesId[]) {
  return useSeriesOfType('choropleth', seriesIds);
}

/**
 * Get access to the internal state of choropleth series.
 * The returned object contains:
 * - series: a mapping from ids to series attributes.
 * - seriesOrder: the array of series ids.
 * @returns the choropleth series
 */
export function useChoroplethSeriesContext(): UseChoroplethSeriesContextReturnValue {
  return useAllSeriesOfType('choropleth');
}
