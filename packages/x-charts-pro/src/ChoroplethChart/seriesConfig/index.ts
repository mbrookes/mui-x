import type { ChartSeriesTypeConfig } from '@mui/x-charts/internals';
import seriesProcessor from './seriesProcessor';
import getColor from './getColor';
import tooltipGetter from './tooltip';
import tooltipItemPositionGetter from './tooltipPosition';
import getSeriesWithDefaultValues from './getSeriesWithDefaultValues';
import getItemAtPosition from './getItemAtPosition';
import { createIsFaded, createIsHighlighted } from './highlight';
import identifierSerializer from './identifierSerializer';
import identifierCleaner from './identifierCleaner';
import descriptionGetter from './descriptionGetter';

// Choropleth does not register with cartesianSeriesTypes since it uses geographic projection,
// not cartesian x/y axes.

export const choroplethSeriesConfig: ChartSeriesTypeConfig<'choropleth'> = {
  seriesProcessor,
  colorProcessor: getColor,
  legendGetter: () => [],
  tooltipGetter,
  tooltipItemPositionGetter,
  getSeriesWithDefaultValues,
  identifierSerializer,
  identifierCleaner,
  getItemAtPosition,
  descriptionGetter,
  isHighlightedCreator: createIsHighlighted,
  isFadedCreator: createIsFaded,
};
