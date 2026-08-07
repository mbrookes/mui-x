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
// The two halves of filter-scope screening, published so a writer that installs a scope can be
// held to the same standard as the reducer's own `addFilter` — rather than accepting a scope
// live that the load boundary then silently drops on the next reload. `StudioController`'s
// `updateFilter` is the caller: it routes through the reducer now, but screening stays with the
// writer because it owes its caller a typed reason the reducer cannot express.
// `isValidFilterScope` is stage 1 (WELLFORMEDNESS:
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
  // The value-type half of the same guard. Published alongside the key validators because it
  // answers the second question every untyped config write asks, and because keeping it in a
  // consumer let it drift 15 keys behind the type it mirrors.
  SCALAR_CONFIG_VALUE_TYPES,
  validateConfigValueTypes,
} from './configKeyValidation';
export type { ScalarConfigValueTypes } from './configKeyValidation';
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
// The prototype-key denylist and the wire size caps, published because they are NOT
// implementation details of this package's own boundaries — every consumer that writes an
// untrusted string key into a record, or forwards an untrusted value into the persisted
// `doc`, needs the SAME answer. `@mui/x-studio`'s SSE adapter had hand-rolled a
// byte-equivalent `key === '__proto__' || key === 'constructor' || key === 'prototype'`
// literal precisely because these were unreachable, which is how a denylist that exists to be
// defined exactly once starts drifting. `unsafeKeys.ts`/`wireLimits.ts` stay zero-dependency,
// so exporting them adds nothing to a consumer's import graph. (The rest of
// `internalGuards.ts` remains unexported — those really are boundary internals.)
// The `dependsOn` referential-integrity cascade. Published when `@mui/x-studio`'s filter-drop
// paths still bypassed the reducer and had to enforce the invariant themselves; they route
// through it now, but the cascade stays exported for the load boundary and for any host
// building a doc outside the reducer.
export { pruneDependsOnAgainstSelf } from './dependsOnCascade';
// The managed-filter value comparison, used by `@mui/x-studio`'s two remaining
// controller-owned filter writers to bail before committing an equivalent rebuild.
export { isSameManagedFilterContent } from './docTransforms';
export { UNSAFE_KEYS, isSafeKey } from './unsafeKeys';
export { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH } from './wireLimits';
// Wire versioning, published for the same reason as the caps above: the client stamps it and both
// servers check it, so the number and the compatibility rule must have one definition. See
// `wireProtocol.ts` for why there are two counters and when to bump each.
export {
  STUDIO_AI_WIRE_VERSION,
  MIN_SUPPORTED_STUDIO_AI_WIRE_VERSION,
  STUDIO_DATA_WIRE_VERSION,
  MIN_SUPPORTED_STUDIO_DATA_WIRE_VERSION,
  checkStudioWireVersion,
} from './wireProtocol';
export type {
  StudioWireName,
  StudioWireVersionCheck,
  StudioWireVersionRejection,
} from './wireProtocol';
// The execution-semantics conformance corpus: the artifact defining what the in-memory pipeline
// and the SQL push-down path must both answer. Published from here because it is read by a test in
// `x-studio-data-middleware` and by nothing that may depend on it. See `executionConformance.ts`.
export { EXECUTION_CONFORMANCE_CASES } from './executionConformance';
export type {
  ConformanceDisposition,
  ConformanceRow,
  ExecutionConformanceCase,
} from './executionConformance';
// The AI-chat wire budgets, published for the same reason: the server enforces them and the
// client mirrors them, and a mirror that is only a comment drifts. See `aiWireLimits.ts`.
export { MAX_TOOL_OUTPUT_CHARS, MAX_CONVERSATION_CHARS } from './aiWireLimits';

// The batch-query WIRE PROTOCOL, published because it has two implementers that must not depend
// on each other: `@mui/x-studio`'s `createBatchingAdapter` builds these payloads and
// `@mui/x-studio-data-middleware`'s `handleBatchQuery` validates them. Before this, each declared
// the protocol independently — and they had already drifted (the client's `FilterPredicate` was a
// flat `value?: unknown` bag where the server's is a discriminated union binding each operator to
// its value type, so the client could not catch a one-sided `between` or a mis-shaped `in` at
// compile time at all). Same arrangement `aiTypes.ts` has always had for the AI protocol.
export type {
  AggregationSpec,
  JoinDescriptor,
  SemiJoinDescriptor,
  BatchWidgetDescriptor,
  HavingPredicate,
  FilterPredicate,
  OrderBy,
  BatchQueryRequest,
  WidgetQueryResult,
  BatchQueryResponse,
} from './dataWireTypes';
export { MAX_ITEMS_PER_BATCH } from './dataWireTypes';
