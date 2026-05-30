import generateUtilityClass from '@mui/utils/generateUtilityClass';
import composeClasses from '@mui/utils/composeClasses';
import generateUtilityClasses from '@mui/utils/generateUtilityClasses';

export interface ChoroplethChartClasses {
  /** Styles applied to the choropleth plot root element. */
  root: string;
  /** Styles applied to each geographic feature path. */
  featurePath: string;
  /**
   * Styles applied to the feature path element if highlighted.
   * @deprecated Use `[data-highlighted]` selector instead.
   */
  highlighted: string;
  /**
   * Styles applied to the feature path element if faded.
   * @deprecated Use `[data-faded]` selector instead.
   */
  faded: string;
  /**
   * Styles applied to the root element for a specified series.
   * Needs to be suffixed with the series ID: `.${choroplethChartClasses.series}-${seriesId}`.
   * @deprecated Use `[data-series="${seriesId}"]` selector instead.
   */
  series: string;
}

export type ChoroplethChartClassKey = keyof ChoroplethChartClasses;

export function getChoroplethChartUtilityClass(slot: string) {
  if (['highlighted', 'faded'].includes(slot)) {
    return generateUtilityClass('Charts', slot);
  }
  return generateUtilityClass('MuiChoroplethChart', slot);
}

export const choroplethChartClasses: ChoroplethChartClasses = {
  ...generateUtilityClasses('MuiChoroplethChart', ['root', 'featurePath', 'series']),
  highlighted: 'Charts-highlighted',
  faded: 'Charts-faded',
};

export interface ChoroplethFeaturePathOwnerState {
  seriesId: string;
  featureId: string;
  isFaded: boolean;
  isHighlighted: boolean;
  classes?: Partial<ChoroplethChartClasses>;
}

export const useUtilityClasses = (ownerState: ChoroplethFeaturePathOwnerState) => {
  const { classes, seriesId, isFaded, isHighlighted } = ownerState;
  const slots = {
    root: ['root'],
    featurePath: [
      'featurePath',
      `series-${seriesId}`,
      isFaded && 'faded',
      isHighlighted && 'highlighted',
    ],
  };
  return composeClasses(slots, getChoroplethChartUtilityClass, classes);
};
