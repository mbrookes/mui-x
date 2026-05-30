import type { DescriptionGetter } from '@mui/x-charts/internals';

const descriptionGetter: DescriptionGetter<'choropleth'> = (params) => {
  const { identifier, series } = params;

  const { featureId } = identifier;
  const value = series.valueMap.getValue(featureId);
  const formattedValue = series.valueFormatter?.(value, { featureId }) ?? '';

  return `${featureId}: ${formattedValue}`;
};

export default descriptionGetter;
