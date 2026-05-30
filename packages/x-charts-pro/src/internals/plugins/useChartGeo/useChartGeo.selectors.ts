import { createSelector } from '@mui/x-internals/store';
import type { ChartState } from '@mui/x-charts/internals';
import type { UseChartGeoSignature } from './useChartGeo.types';

const selectRootState = (state: ChartState<[UseChartGeoSignature]>) => state;

export const selectorChartGeo = createSelector(selectRootState, (state) => state.geo);
