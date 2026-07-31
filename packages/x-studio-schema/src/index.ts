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
  // The `dependsOn` referential-integrity cascade, published so `@mui/x-studio`'s filter-drop
  // paths — which commit through `commitDocPatch` and never reach the reducer — enforce the
  // same invariant every reducer drop path does (R6 F3).
  pruneDependsOnAgainstSelf,
} from './applyMutation';
// The rank-filter scope helpers moved out of `applyMutation.ts` into their own
// dependency-free module so `factories.ts` (the factory-overrides trust boundary) can reach
// them too — see `rankFilterScope.ts`. The public names are unchanged.
// `buildRankFilterWidgetPageIndex` ships alongside them because both now take that index as
// an OPTIONAL trailing argument: a caller resolving many filters against one immutable page
// map builds it once and threads it, turning the sweep from O(R²·W) into O(W + R²). Omitting
// it keeps the original self-contained scan, so every existing call site stays correct.
export {
  resolveRankFilterPageId,
  hasConflictingRankFilter,
  buildRankFilterWidgetPageIndex,
} from './rankFilterScope';
export type { RankFilterWidgetPageIndex } from './rankFilterScope';
export { parseStateMutation, PARSEABLE_MUTATION_TYPES } from './parseStateMutation';
export type { ParseStateMutationResult } from './parseStateMutation';
// The two halves of filter-scope screening, published so a client-side writer that installs a
// scope WITHOUT going through `applyMutation` (`StudioController.updateFilter` commits via
// `commitDocPatch`, never the reducer) is held to the same standard as its reducer-routed
// sibling `addFilter` — rather than accepting a scope live that the load boundary then
// silently drops on the next reload (R6 F2). `isValidFilterScope` is stage 1 (WELLFORMEDNESS:
// kind membership, required id fields, prototype-hazard keys, size bounds — a payload judged
// in isolation); `hasResolvableFilterAnchors` is stage 2 (EXISTENCE: every id the scope names
// resolves against a doc). The reducer's `addFilter` runs exactly these two, in this order.
export { isValidFilterScope } from './parseStateMutation';
export { hasResolvableFilterAnchors } from './docScreening';
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
  // The FOURTH closed union, published for exactly the same reason as the three above —
  // "publishing the list, not just the type, is the whole point" applies to all four
  // equally, and this was the only one of the four still type-only. A consumer branching
  // on `StudioRelationship['type']` (a relationship editor's option table, a join-path
  // resolver) had no runtime list to read and had to hand-copy the three members, which is
  // precisely the per-package drift this package exists to eliminate.
  isStudioRelationshipType,
  STUDIO_RELATIONSHIP_TYPES,
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
