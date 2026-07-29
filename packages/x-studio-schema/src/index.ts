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
// `StudioAIToolName` is re-exported via `aiTypes.ts` above (which re-exports it
// from `aiToolRegistry.ts`); export the runtime registry and its facts type
// explicitly here rather than `export *`-ing `aiToolRegistry` (which would
// re-export `StudioAIToolName` a second time and conflict with the line above).
export { STUDIO_AI_TOOL_REGISTRY } from './aiToolRegistry';
export type { StudioAIToolFacts } from './aiToolRegistry';

// The `factories` runtime module's functions are exported explicitly here (they
// live in a runtime module, not a `export *`-ed type module).
export {
  createDefaultWidget,
  createWidgetId,
  createMutationId,
  createPageId,
  createPresetId,
  createFilterId,
  createIdFactory,
  createMutationEnvelope,
  normalizeGridColumn,
  normalizeChartSeries,
  createDefaultStudioState,
} from './factories';
export type { CreateDefaultStudioStateOverrides } from './factories';
export { detectAnomaliesIQR } from './anomalyDetection';
export {
  applyDocMutation,
  applyMutation,
  mutationLabel,
  GRID_COLS,
  MIN_SPAN,
  MUTATION_TYPES,
} from './applyMutation';
// The rank-filter scope helpers moved out of `applyMutation.ts` into their own
// dependency-free module so `factories.ts` (the factory-overrides trust boundary) can reach
// them too — see `rankFilterScope.ts`. The public names are unchanged.
export { resolveRankFilterPageId, hasConflictingRankFilter } from './rankFilterScope';
export { parseStateMutation, PARSEABLE_MUTATION_TYPES } from './parseStateMutation';
export type { ParseStateMutationResult } from './parseStateMutation';
export {
  getAllowedConfigKeys,
  validateConfigKeysForKind,
  getAllowedChartConfigKeys,
  validateChartConfigKeysForType,
  stripForeignFamilyKeys,
} from './configKeyValidation';
export {
  isWidgetOfKind,
  resolveChartType,
  isChartConfigOfType,
  isStudioChartType,
  STUDIO_CHART_TYPES,
  isStudioFilterOperator,
  STUDIO_FILTER_OPERATORS,
  // The third closed union's runtime list, exported for the same reason as its two
  // siblings above: `@mui/x-studio`'s expression editor and evaluator both branch on
  // `StudioExpressionOperator`, and with only the TYPE public each was forced to
  // hand-copy the operator list (`ExpressionNodeEditor`'s option table, the evaluator's
  // arity/kind tables). That is exactly the per-package hand-copy this package exists to
  // eliminate — a new operator added here but missed in a copy makes the editor and the
  // load boundary disagree about which operators exist, and an expression the editor
  // cannot offer silently evaluates to `null` after a reload.
  isStudioExpressionOperator,
  STUDIO_EXPRESSION_OPERATORS,
} from './widgetTypeGuards';
export { isoWeek, truncateToPeriod } from './temporalUtils';
// `CURRENT_SCHEMA_VERSION` is re-exported via `stateTypes.ts` above (its source
// of truth); omit it here to avoid a duplicate export of the same binding.
export { serializeDoc, serializeState, deserializeState, migrateState } from './statePersistence';
export type {
  SerializedStudioState,
  SerializedStudioSnapshot,
  SerializedStudioSession,
  MigrationResult,
} from './statePersistence';
