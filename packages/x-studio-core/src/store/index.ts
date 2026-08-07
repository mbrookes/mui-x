export * from './StudioController';
export {
  CURRENT_SCHEMA_VERSION,
  serializeDoc,
  serializeState,
  deserializeState,
  migrateState,
  type SerializedStudioState,
  type SerializedStudioSnapshot,
  type SerializedStudioSession,
  type MigrationResult,
} from '@mui/x-studio-schema';
