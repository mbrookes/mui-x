import { getLabel, type TooltipGetter } from '@mui/x-charts/internals';

const tooltipGetter: TooltipGetter<'choropleth'> = (params) => {
  const { series, getColor, identifier } = params;

  if (!identifier) {
    return null;
  }

  const { featureId } = identifier;
  const value = series.valueMap.getValue(featureId);

  const label = getLabel(series.label, 'tooltip');
  const formattedValue = series.valueFormatter(value, { featureId });
  const color = getColor(value);

  return {
    identifier,
    color,
    label,
    value,
    formattedValue,
    markType: series.labelMarkType,
  };
};

export default tooltipGetter;
