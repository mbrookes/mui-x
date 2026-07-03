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

export { createDefaultWidget } from './widgetFactory';
export { detectAnomaliesIQR, median } from './anomalyDetection';
export { applyMutation, mutationLabel } from './applyMutation';
