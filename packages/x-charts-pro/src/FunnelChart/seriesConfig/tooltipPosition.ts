import { findMinMax, type TooltipItemPositionGetter } from '@mui/x-charts/internals';
import { createPositionGetter } from '../coordinateMapper';

const tooltipItemPositionGetter: TooltipItemPositionGetter<'funnel'> = (params) => {
  const { series, identifier, axesConfig, drawingArea, seriesLayout, placement } = params;

  if (!identifier || identifier.dataIndex === undefined) {
    return null;
  }
  const itemSeries = series.funnel?.series[identifier.seriesId];

  if (itemSeries == null) {
    return null;
  }

  if (axesConfig.x === undefined || axesConfig.y === undefined) {
    return null;
  }

  const isHorizontal = itemSeries.layout === 'horizontal';
  const { dataIndex } = identifier;
  const N = itemSeries.data.length;
  const gap = seriesLayout.funnel?.[identifier.seriesId]?.gap ?? 0;

  // Compute category-direction (band axis) positions directly from drawingArea + gap
  // because the cartesian scale used in axesConfig does not account for funnel gap.
  const rangeSpace = isHorizontal ? drawingArea.width : drawingArea.height;
  const bandWidth = (rangeSpace - gap * (N - 1)) / N;
  const step = bandWidth + gap;

  let categoryStart: number;
  let categoryEnd: number;

  if (isHorizontal) {
    categoryStart = drawingArea.left + dataIndex * step;
    categoryEnd = categoryStart + bandWidth;
  } else {
    categoryStart = drawingArea.top + dataIndex * step;
    categoryEnd = categoryStart + bandWidth;
  }

  // For the value direction, axesConfig scale is correct (gap does not affect value axis range).
  const valueScaleConfig = isHorizontal ? axesConfig.y : axesConfig.x;
  const valuePositionGetter = createPositionGetter(valueScaleConfig.scale, false, 0, valueScaleConfig.data);

  const allValues = itemSeries.dataPoints[dataIndex].map((v) => {
    const valueCoord = isHorizontal ? v.y : v.x;
    return valuePositionGetter(valueCoord, dataIndex, v.stackOffset, v.useBandWidth);
  });

  const [v0, v1] = findMinMax(allValues);

  let x0: number;
  let x1: number;
  let y0: number;
  let y1: number;

  if (isHorizontal) {
    x0 = categoryStart;
    x1 = categoryEnd;
    y0 = v0;
    y1 = v1;
  } else {
    x0 = v0;
    x1 = v1;
    y0 = categoryStart;
    y1 = categoryEnd;
  }

  switch (placement) {
    case 'bottom':
      return { x: (x1 + x0) / 2, y: y1 };
    case 'left':
      return { x: x0, y: (y1 + y0) / 2 };
    case 'right':
      return { x: x1, y: (y1 + y0) / 2 };
    case 'top':
    default:
      return { x: (x1 + x0) / 2, y: y0 };
  }
};

export default tooltipItemPositionGetter;
