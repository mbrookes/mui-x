// Moved to `@mui/x-studio-schema`. Re-exported here — scoped to just the names
// that live in the schema package's own `dataTypes.ts` module — so existing deep
// imports (`../models/dataTypes`) keep working without surfacing the entire
// schema package.
export type {
  FieldCapability,
  StudioDataField,
  StudioFilterNode,
  StudioQueryResult,
  StudioQueryDescriptor,
  ClientMutationDescriptor,
  ClientMutationResult,
  StudioDataSourceAdapter,
  StudioDataSource,
  StudioRelationship,
} from '@mui/x-studio-schema';
