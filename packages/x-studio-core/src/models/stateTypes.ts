// Moved to `@mui/x-studio-schema`. Re-exported here — scoped to just the names
// that live in the schema package's own `stateTypes.ts` module — so existing
// deep imports (`../models/stateTypes`) keep working without surfacing the
// entire schema package.
export type {
  StudioFilterScope,
  StudioDateRangePreset,
  StudioFilterState,
  StudioShellState,
  StudioDashboardState,
  StudioFilterPreset,
  StudioState,
} from '@mui/x-studio-schema';
// `createDefaultStudioState` is a runtime factory that lives in the schema
// package's `factories` module, but existing deep imports of this file expect
// it here too — re-exported explicitly (not part of the `export type` above
// since it's a value, not a type).
export { createDefaultStudioState } from '@mui/x-studio-schema';
