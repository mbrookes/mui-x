import type { IdentifierCleaner } from '@mui/x-charts/internals';

const identifierCleaner: IdentifierCleaner<'choropleth'> = (identifier) => {
  return {
    type: identifier.type,
    seriesId: identifier.seriesId,
    featureId: identifier.featureId,
  };
};

export default identifierCleaner;
