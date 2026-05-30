import {
  typeSerializer,
  seriesIdSerializer,
  type IdentifierSerializer,
} from '@mui/x-charts/internals';

const identifierSerializer: IdentifierSerializer<'choropleth'> = (identifier) => {
  return `${typeSerializer(identifier.type)}${seriesIdSerializer(identifier.seriesId)}F(${identifier.featureId})`;
};

export default identifierSerializer;
