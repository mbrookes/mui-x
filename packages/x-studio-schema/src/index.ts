/**
 * @mui/x-studio-schema
 *
 * The shared, dependency-free data model for MUI X Studio: all `StudioState`
 * types, the widget/data/filter/expression/AI-protocol type surface, and the
 * pure functions both the client (`@mui/x-studio`) and the AI middleware
 * (`@mui/x-studio-ai-middleware`) need to agree on.
 *
 * Zero runtime dependencies, no React, no Node built-ins — importable from both
 * a browser bundle and a server bundle. This is the single place a `StudioState`
 * shape change is made, so the two consuming packages can never drift.
 */
export * from './baseTypes';
export * from './dataTypes';
export * from './widgetTypes';
export * from './expressionTypes';
export * from './stateTypes';
export * from './aiTypes';

// `createDefaultWidget` and `normalizeGridColumn` are exported explicitly here (they
// live in the `factories` runtime module, not a `export *`-ed type module).
// `createDefaultStudioState` also lives in `./factories`, but is surfaced via the
// back-compat re-export in `./stateTypes` (kept for pre-existing `./stateTypes` deep
// imports); re-exporting it here too would be a duplicate export.
export { createDefaultWidget, normalizeGridColumn } from './factories';
export { detectAnomaliesIQR } from './anomalyDetection';
export { applyMutation, mutationLabel } from './applyMutation';
