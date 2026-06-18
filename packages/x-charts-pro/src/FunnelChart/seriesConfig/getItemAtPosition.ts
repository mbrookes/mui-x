import type {
  ProcessedSeries,
  ChartState,
  UseChartCartesianAxisSignature,
} from '@mui/x-charts/internals';
import {
  selectorAllSeriesOfType,
  selectorChartXAxis,
  selectorChartYAxis,
  getCartesianAxisIndex,
} from '@mui/x-charts/internals';
import type { SeriesItemIdentifierWithType } from '@mui/x-charts/models';

export default function getItemAtPosition(
  state: ChartState<[UseChartCartesianAxisSignature]>,
  point: { x: number; y: number },
): SeriesItemIdentifierWithType<'funnel'> | undefined {
  const { axis: xAxis, axisIds: xAxisIds } = selectorChartXAxis(state);
  const { axis: yAxis, axisIds: yAxisIds } = selectorChartYAxis(state);
  const series = selectorAllSeriesOfType(state, 'funnel') as ProcessedSeries['funnel'];

  const seriesId = series?.seriesOrder[0];

  if (seriesId === undefined) {
    return undefined;
  }

  const isHorizontal = series.series[seriesId]?.layout === 'horizontal';

  // For funnel, the category (band) axis determines which section is hit.
  // The cartesian scale is used here intentionally: its equal-width bands cover
  // the full drawing area including gap regions, ensuring no dead zones on hover.
  const dataIndex = isHorizontal
    ? getCartesianAxisIndex(xAxis[xAxisIds[0]], point.x)
    : getCartesianAxisIndex(yAxis[yAxisIds[0]], point.y);

  if (dataIndex === -1) {
    return undefined;
  }

  return {
    type: 'funnel',
    seriesId,
    dataIndex,
  };
}
