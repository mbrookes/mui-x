/**
 * Server-side tool execution for x-studio-ai-middleware.
 *
 * Unlike the client-side `executeTool` (which calls `StudioController` directly),
 * this function operates on a `StudioState` value and returns:
 * - `output`   — JSON string to feed back to the LLM
 * - `mutation` — optional `StateMutation` for the client to apply
 * - `nextState`— the updated state after the tool ran (used to carry state forward
 *                across multiple tool calls in a single agentic loop turn)
 */
import {
  applyMutation,
  createDefaultWidget,
  createFilterId,
  createPageId,
  isStudioChartType,
  isStudioFilterOperator,
  isWidgetOfKind,
  STUDIO_CHART_TYPES,
  STUDIO_FILTER_OPERATORS,
  validateChartConfigKeysForType,
  validateConfigKeysForKind,
} from '@mui/x-studio-schema';
import type { BuiltinStudioWidgetKind, OptionalWidgetField } from '@mui/x-studio-schema';
import type {
  StudioState,
  StudioCustomWidgetDef,
  StudioWidget,
  StudioFilterOperator,
  StudioDataField,
  StudioFilterState,
  StudioDataSource,
} from './models/studioTypes';
import type { StateMutation, StudioAIToolName } from './models/aiTypes';
// Shared pure functions: the widget factory (so AI-created and UI-created widgets
// share defaults) and the single mutation reducer (so the server-threaded state
// and the client-applied state are computed by the exact same code).

export interface ToolExecutionResult {
  output: string;
  mutation?: StateMutation;
  nextState: StudioState;
}

/**
 * Max distinct values per field emitted in a `get_dashboard_state` payload. The
 * full `fieldDistinctValues` list can be arbitrarily large (every unique value of
 * a high-cardinality column), so it is capped here — both to avoid a token bomb
 * and to avoid dumping a full column's contents into the model context.
 */
const MAX_DISTINCT_VALUES_IN_STATE_OUTPUT = 20;

/**
 * Max length of a model-supplied stored title (dashboard / page / widget). These
 * strings are re-interpolated into `<dashboard_state>` on EVERY future request, so an
 * unbounded title is a persistent token bomb (finding T3-3) — `sanitizeForPrompt`
 * neutralizes markup but not size. Capped at the write source so the oversized string
 * never lands in state. Larger than `rename_thread`'s 40-char cap because dashboard and
 * widget titles are legitimately longer than a chat-thread label, but still bounded.
 */
const MAX_TITLE_LENGTH = 200;

/**
 * Max length of a model-supplied filter `field`/`sourceId` string (and of a
 * string-typed filter `value`), persisted verbatim by `add_page_filter` /
 * `add_widget_filter`. Same rationale — and same token-bomb class — as
 * {@link MAX_TITLE_LENGTH}: `buildAISystemPrompt.ts` re-interpolates every active
 * filter's `field`/`value` (via `JSON.stringify(f.value)`) into the "Active
 * Filters" block on EVERY subsequent request, so an unbounded value persists as
 * a token bomb across the whole conversation (finding T3-3).
 */
const MAX_FILTER_STRING_LENGTH = 200;

/**
 * Max number of entries kept in an array-typed filter `value` (e.g. an `in`
 * operator's value list). An unbounded array is JSON-stringified into the
 * system prompt on every future request exactly like an oversized string.
 */
const MAX_FILTER_VALUE_ARRAY_LENGTH = 50;

/** Cap a model-supplied string to `maxLength` characters. */
function capString(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/** Cap a model-supplied title to {@link MAX_TITLE_LENGTH} (see the constant's rationale). */
function capTitle(title: string): string {
  return capString(title, MAX_TITLE_LENGTH);
}

/**
 * Max recursion depth `capFilterValue` will descend into a nested array/object
 * filter value. Bounds the work done on a pathologically deep model-supplied
 * structure; values beyond this depth are left as-is (a nested array at that depth
 * is still bounded by the enclosing array-length cap applied on the way down).
 */
const MAX_FILTER_VALUE_DEPTH = 5;

/**
 * Cap a model-supplied filter `value` before persisting it — same token-bomb class
 * `capTitle` guards against (finding T3-3). String values are truncated to
 * {@link MAX_FILTER_STRING_LENGTH}; array values (e.g. an `in` list) are truncated
 * to {@link MAX_FILTER_VALUE_ARRAY_LENGTH} entries. Recurses into array elements and
 * plain-object properties so a huge string or object NESTED inside an array-typed
 * value is also capped, not just the array's own length (Tier 2, iteration 22) —
 * `buildAISystemPrompt.ts` echoes the whole value via `JSON.stringify(f.value)` on
 * every future request, so an uncapped element anywhere inside the structure is just
 * as much a persistent token bomb as an uncapped top-level string. Other
 * JSON-serializable scalar shapes (number/boolean/null) are left as-is.
 */
function capFilterValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return capString(value, MAX_FILTER_STRING_LENGTH);
  }
  if (depth >= MAX_FILTER_VALUE_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    const bounded =
      value.length > MAX_FILTER_VALUE_ARRAY_LENGTH
        ? value.slice(0, MAX_FILTER_VALUE_ARRAY_LENGTH)
        : value;
    return bounded.map((entry) => capFilterValue(entry, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const capped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      capped[key] = capFilterValue(entry, depth + 1);
    }
    return capped;
  }
  return value;
}

/**
 * Cap a model-supplied `sourceId` string before persisting it onto a widget — same
 * token-bomb class as {@link MAX_TITLE_LENGTH}/{@link MAX_FILTER_STRING_LENGTH}:
 * `buildAISystemPrompt.ts`'s `describeWidget` echoes a widget's resolved source into
 * `<dashboard_state>` on every future request. Reuses `MAX_FILTER_STRING_LENGTH` —
 * the same bound already applied to a filter's `field`/`sourceId` — rather than
 * inventing a new constant for what is the same class of short identifier string.
 */
function capSourceId(sourceId: string): string {
  return capString(sourceId, MAX_FILTER_STRING_LENGTH);
}

/**
 * Cap every STRING-typed value in a model-supplied widget `config` object before
 * persisting it (Tier 2, iteration 22). Chart-config string fields such as
 * `xField`/`yField`/`seriesField` (and their per-chart-type siblings —
 * `ganttLabelField`, `sankeyTargetField`, `scatterColorField`, `heatYField`, …) are
 * free-form model-supplied field-id strings with no existing length bound, and
 * `buildAISystemPrompt.ts`'s `describeWidget` echoes every one of them into
 * `<dashboard_state>` on EVERY future request — the same persistent token-bomb class
 * `capTitle`/`capFilterValue` already guard against. Reuses `MAX_FILTER_STRING_LENGTH`
 * (the bound already applied to filter `field`/`sourceId`) rather than inventing a new
 * constant. Non-string values (numbers, booleans, arrays like `ySeries`/`annotations`,
 * nested objects like `forecast`) are left untouched — they are either already
 * value-checked elsewhere (`invalidConfigValueError`) or out of scope for this
 * shallow string cap. Accepts `unknown` (not just a record) so it can be applied
 * directly to an untrusted `args.config` at the write source; any non-plain-object
 * input (including `null`/arrays) is returned unchanged for the caller's own
 * shape validation to reject.
 */
function capConfigStringValues(config: unknown): unknown {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return config;
  }
  const capped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    capped[key] = typeof value === 'string' ? capString(value, MAX_FILTER_STRING_LENGTH) : value;
  }
  return capped;
}

/**
 * Project a `StudioDataSource` down to AI-safe metadata for `get_dashboard_state`.
 *
 * Strips `rows` (raw live table data — an exfiltration / token-bomb path that also
 * contradicts the system prompt's no-raw-data rule and defeats `privateMode`) and
 * `adapter` (a non-serializable host callback) entirely, and caps
 * `fieldDistinctValues` per field with a `truncated` marker. `describe_data_source`
 * is the intentional, opt-in channel for sample rows — this dump is not.
 */
export function projectDataSourceMetadata(source: StudioDataSource): Record<string, unknown> {
  const cappedDistinct: Record<string, { values: string[]; truncated: boolean }> = {};
  for (const [fieldId, values] of Object.entries(source.fieldDistinctValues ?? {})) {
    cappedDistinct[fieldId] = {
      values: values.slice(0, MAX_DISTINCT_VALUES_IN_STATE_OUTPUT),
      truncated: values.length > MAX_DISTINCT_VALUES_IN_STATE_OUTPUT,
    };
  }
  return {
    id: source.id,
    label: source.label,
    tableName: source.tableName,
    aiDescription: source.aiDescription,
    hidden: source.hidden,
    fields: source.fields,
    fieldDistinctValues: cappedDistinct,
  };
}

/**
 * Per-thread AI metadata emitted in the AI-safe state snapshot — the shape
 * `doc.ai` is reduced to. Deliberately carries NO `messages`: only enough for the
 * model to know which threads exist and how large each is.
 */
export interface ProjectedAIThread {
  id: string;
  name: string;
  updatedAt?: string;
  messageCount: number;
}

/** The AI-safe `doc.ai` replacement: thread metadata with all transcripts removed. */
export interface ProjectedAIState {
  activeThreadId?: string;
  threads: ProjectedAIThread[];
}

/** The AI-safe `{ doc, dataSources }` snapshot shared by both read surfaces. */
export interface ProjectedStateForAI {
  doc: Omit<StudioState['doc'], 'ai'> & { ai?: ProjectedAIState };
  dataSources: Record<string, unknown>;
}

/**
 * Project a `StudioState` down to the AI-safe `{ doc, dataSources }` snapshot that
 * both the `get_dashboard_state` TOOL and the `studio://dashboard/state` MCP
 * RESOURCE emit. This is the single home for the read-surface redaction contract —
 * previously the doc half was hand-copied across both call sites, so a leak (or a
 * new sensitive `StudioDoc` sub-partition) had to be remembered in two files.
 *
 * Two redactions happen here, in ONE place so the two surfaces cannot drift:
 *
 * 1. `runtime.dataSources` is projected through `projectDataSourceMetadata`, which
 *    strips `rows` (raw live table data) and `adapter` (a non-serializable host
 *    callback) and caps `fieldDistinctValues`. Emitting the raw `StudioState` here
 *    would leak live rows into the model context — a token bomb and an exfiltration
 *    path that defeats `privateMode`.
 * 2. `doc.ai` is reduced to per-thread METADATA (`{ id, name, updatedAt,
 *    messageCount }`) with every message transcript removed. `StudioAIChatThread.messages`
 *    holds the FULL history of EVERY thread (not just the active one), and `doc.ai`
 *    is persisted with shareable dashboards — so echoing it verbatim would dump every
 *    conversation's transcript back to the provider (cross-conversation information
 *    disclosure + an unbounded token bomb). The model already has the active thread as
 *    its live message array, so it needs no chat history in this snapshot.
 */
export function projectStateForAI(state: StudioState): ProjectedStateForAI {
  const dataSources: Record<string, unknown> = {};
  for (const [id, source] of Object.entries(state.runtime.dataSources)) {
    dataSources[id] = projectDataSourceMetadata(source);
  }
  const { ai, ...docWithoutAi } = state.doc;
  const redactedAi: ProjectedAIState | undefined = ai
    ? {
        ...(ai.activeThreadId ? { activeThreadId: ai.activeThreadId } : {}),
        threads: (ai.threads ?? []).map((thread) => ({
          id: thread.id,
          name: thread.name,
          ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
          messageCount: thread.messages?.length ?? 0,
        })),
      }
    : undefined;
  return {
    doc: { ...docWithoutAi, ...(redactedAi ? { ai: redactedAi } : {}) },
    dataSources,
  };
}

/** Context threaded into every pure tool's `plan` function. */
export interface ToolPlanContext {
  state: StudioState;
  customWidgets?: StudioCustomWidgetDef[];
  pageSnapshot?: string;
  /**
   * The id of the page the `pageSnapshot` was built for — captured ONCE at request
   * time (the active page when the request began). `summarise_page` compares the
   * requested page against THIS, not the threaded `state.doc.dashboard.activePageId`,
   * so a same-turn `set_active_page` cannot make it narrate the wrong page's snapshot
   * (finding 2-2).
   */
  snapshotPageId?: string;
}

/**
 * A tool whose execution is a pure function of `(args, ctx) => ToolExecutionResult`
 * — no I/O, no shared-state mutation, safe to call speculatively (dry-run) and
 * discard. This is the shape `toolPolicy.ts`'s execute-then-gate chokepoint
 * depends on: see the PURITY INVARIANT documented there.
 */
export interface PureToolImpl {
  effect: 'pure';
  plan: (args: Record<string, unknown>, ctx: ToolPlanContext) => ToolExecutionResult;
}

/**
 * A tool whose execution has a side effect (I/O) and therefore must NEVER be
 * routed through the execute-then-gate dry-run path — it must be authorized
 * BEFORE it runs, args-only. `query_data_source` is the only member: its real
 * dispatch lives in `agenticLoop/toolDispatch.ts` (chat) and `mcp/dataTools.ts`
 * (MCP), both consulting the policy first, and is intentionally NOT reachable through
 * `executeToolOnState` — see the `default` case below. This entry exists
 * purely so `TOOL_IMPLS` is exhaustive over every `StudioAIToolName`, letting
 * a future consumer type `executeToolWithPolicy`'s
 * accepted shape as `PureToolImpl`-only.
 */
export interface ExternalToolImpl {
  effect: 'external';
}

/**
 * `Object.hasOwn`-guarded read of a model-supplied id from a plain-object map.
 *
 * Every entity map in `state.doc` (`widgets`, `pages`, …) is a plain object, so a
 * bare `map[id]` walks the prototype chain: a model-supplied id like `"constructor"`,
 * `"toString"`, or `"__proto__"` resolves to a truthy inherited function and passes a
 * naive `if (map[id])` existence check — even though the shared reducer
 * (`applyMutation.ts`) is fully `Object.hasOwn`-hardened and silently no-ops on that
 * same key. That mismatch is finding T2-1: the executor reports `success: true` for a
 * call the reducer treated as a no-op (budget/SSE/persistence-hook pollution + a
 * model/actual-state desync), and for `add_widget_filter` actually COMMITS a dangling
 * filter (its `addFilter` reducer applies the filter verbatim regardless). Routing
 * every model-supplied id lookup through these helpers makes the executor's
 * existence checks agree with the reducer's own-property discipline.
 */
function hasOwnEntity(map: object, id: string): boolean {
  return Object.hasOwn(map, id);
}

/** `Object.hasOwn`-guarded widget lookup (see `hasOwnEntity`). */
function getWidget(state: StudioState, id: string): StudioWidget | undefined {
  return Object.hasOwn(state.doc.widgets, id) ? state.doc.widgets[id] : undefined;
}

/** `Object.hasOwn`-guarded page lookup (see `hasOwnEntity`). */
function getPage(state: StudioState, id: string): StudioState['doc']['pages'][string] | undefined {
  return Object.hasOwn(state.doc.pages, id) ? state.doc.pages[id] : undefined;
}

/**
 * Validates `config`'s keys against the given widget `kind` (via the shared
 * `validateConfigKeysForKind` runtime guard) and, if any key doesn't belong to
 * that kind, returns a human-readable error string naming the offending keys.
 * Returns `undefined` when the config is valid (or the kind is unrestricted).
 * Shared by every AI-tool call site that writes untrusted, model-supplied
 * `config` onto a widget of a known kind (`buildWidgetFromArgs`, `update_widget`,
 * `apply_bulk_update`'s updates loop) so the error wording stays consistent.
 */
function invalidConfigKeyError(kind: string, config: Record<string, unknown>): string | undefined {
  const invalidKeys = validateConfigKeysForKind(kind, config);
  return invalidKeys.length > 0
    ? `config carries key(s) not valid for a '${kind}' widget: ${invalidKeys.join(', ')}`
    : undefined;
}

/**
 * Curated primitive types for the scalar config fields the AI tools populate (finding
 * 3.2). Key validation (`invalidConfigKeyError`) is a key-PRESENCE check only — it never
 * inspects values — so a valid config key can still carry a wrong-typed value. The
 * concrete hazard: `update_widget({ config: { pivotShowTotals: "</dashboard_state>…" } })`
 * stores a STRING in a field declared `boolean`, which is (a) a structurally-broken
 * widget the client must then render, and (b) the exact stored-prompt-injection surface
 * behind finding 1.1 (the value was later echoed into `<dashboard_state>` verbatim).
 *
 * This is a lightweight, fail-closed value-shape backstop AT THE WRITE SOURCE — the
 * prompt boundary's `sanitizeForPrompt` choke point is the primary injection defense;
 * this additionally stops the malformed value from ever landing in state. The set is
 * intentionally small (the scalar toggles the tools populate); non-scalar/structured
 * config (arrays, nested objects like `ySeries`/`forecast`) is out of scope here, and
 * `set_widget_forecast` coerces its own nested `periods` separately.
 */
const SCALAR_CONFIG_VALUE_TYPES: Record<string, 'number' | 'boolean'> = {
  // boolean toggles
  dualYAxis: 'boolean',
  sankeyShowValues: 'boolean',
  pieLegendBelow: 'boolean',
  kpiSparkline: 'boolean',
  kpiTrend: 'boolean',
  kpiTrendInvert: 'boolean',
  pivotShowTotals: 'boolean',
  mapCrossFilterEmit: 'boolean',
  // numeric settings
  barBandLabelWrap: 'number',
  wrapBandLabelMaxLines: 'number',
  barCategoryGapRatio: 'number',
  barMinBandSize: 'number',
  barMaxCategories: 'number',
  axisTickFontSize: 'number',
  funnelGap: 'number',
  pieArcLabelMinAngle: 'number',
  pieMaxSlices: 'number',
  scatterMinRadius: 'number',
  scatterMaxRadius: 'number',
  gaugeMin: 'number',
  gaugeMax: 'number',
};

/**
 * Validates that every scalar-typed key present in a model-supplied `config` carries a
 * value of the expected primitive type (see `SCALAR_CONFIG_VALUE_TYPES`). Returns a
 * human-readable error naming the offending keys, or `undefined` when all present scalar
 * values are well-typed. A `null`/`undefined` value is treated as inert (clearing a key
 * is handled by the dedicated unset paths), not a type violation. Shared by every tool
 * that writes untrusted `config` (`buildWidgetFromArgs`, `update_widget`, the bulk
 * updates loop) so the wording and the allow-list stay identical.
 */
function invalidConfigValueError(config: Record<string, unknown>): string | undefined {
  const offenders: string[] = [];
  for (const [key, expected] of Object.entries(SCALAR_CONFIG_VALUE_TYPES)) {
    if (!Object.hasOwn(config, key)) {
      continue;
    }
    const value = config[key];
    if (value === null || value === undefined) {
      continue;
    }
    if (expected === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        offenders.push(`${key} (expected a finite number)`);
      }
    } else if (typeof value !== 'boolean') {
      offenders.push(`${key} (expected a boolean)`);
    }
  }
  return offenders.length > 0
    ? `config carries value(s) of the wrong type: ${offenders.join(', ')}.`
    : undefined;
}

/**
 * Finer-grained sibling of `invalidConfigKeyError`, scoped to `kind === 'chart'`:
 * validates `patch`'s keys against the specific `StudioChartType` the patch would
 * end up with (its own `chartType` if present, else the widget's `existingChartType`,
 * else the runtime default `'bar'` — the same effective-type rule as
 * `resolveChartType`), via `validateChartConfigKeysForType`. A key can pass the
 * kind-level check (it's a valid CHART key somewhere) yet fail this one (it
 * belongs to a different chart type than the effective one) — e.g. `gauge` with
 * `sankeyTargetField`. There are no custom chart types, so an unrecognized
 * `chartType` string is a hard error via `isStudioChartType`, not a pass-through.
 * Returns `undefined` when the patch is valid for the effective chart type.
 */
function invalidChartConfigKeyError(
  patch: Record<string, unknown>,
  existingChartType: string | undefined,
): string | undefined {
  const effective = String(patch.chartType ?? existingChartType ?? 'bar');
  if (!isStudioChartType(effective)) {
    return `unknown chartType '${effective}'. Valid values: ${STUDIO_CHART_TYPES.join(', ')}`;
  }
  const invalid = validateChartConfigKeysForType(effective, patch);
  return invalid.length > 0
    ? `config carries key(s) not valid for chartType '${effective}': ${invalid.join(', ')}`
    : undefined;
}

/**
 * Validates a model-supplied filter operator string against the schema package's
 * `isStudioFilterOperator` guard (backed by the exhaustive, compile-time-locked
 * `STUDIO_FILTER_OPERATORS` list — see `@mui/x-studio-schema/widgetTypeGuards`).
 * Returns a human-readable error naming the valid operators when the value is not a
 * known operator, or `undefined` when it is valid. Shared by `add_page_filter` and
 * `add_widget_filter` so the wording (and the allow-list) stays identical.
 *
 * This consumes the SAME shared list the schema-side `addFilter` wire boundary
 * (`parseStateMutation.ts`) validates against (schema T2-1), so the AI-tool boundary
 * and the persistence/wire boundary can never disagree about which operators are
 * legal. The previous hand-copied `VALID_FILTER_OPERATORS` object literal (a second
 * source of truth that had to be kept in lockstep by hand) is gone.
 */
function invalidFilterOperatorError(operator: string): string | undefined {
  return isStudioFilterOperator(operator)
    ? undefined
    : `invalid filter operator '${operator}'. Valid operators: ${STUDIO_FILTER_OPERATORS.join(
        ', ',
      )}.`;
}

/**
 * Runtime allow-list of valid `StudioDataField['type']` values (finding T2-3), kept
 * EXHAUSTIVE against the schema union via the `satisfies Record<StudioDataField['type'],
 * true>` annotation: adding a field type to the schema without listing it here is a
 * compile error, so this gate can never silently drift stale. The `fieldType` filter
 * arg is an optional UI hint that the client keys its filter-input rendering off of, so
 * an unvalidated value (a classic LLM slip like `"text"`, or a crafted non-string) would
 * persist verbatim into `StudioFilterState.fieldType` and ship a broken filter editor —
 * the exact value-shape class the sibling `operator` arg is already gated for.
 */
const VALID_FIELD_TYPES = {
  string: true,
  number: true,
  date: true,
  datetime: true,
  boolean: true,
} satisfies Record<NonNullable<StudioDataField['type']>, true>;

/**
 * Validates and narrows a model-supplied `fieldType` filter arg. `fieldType` is
 * optional, so an absent (`undefined`/`null`) value is legal and narrows to
 * `undefined` (the hint is simply omitted). A present value must be a known
 * `StudioDataField['type']`; anything else yields an actionable error (mirroring the
 * fail-closed `operator` handling). Shared by `add_page_filter` and `add_widget_filter`.
 */
function resolveFieldType(
  value: unknown,
): { fieldType: StudioDataField['type'] | undefined } | { error: string } {
  if (value === undefined || value === null) {
    return { fieldType: undefined };
  }
  if (typeof value === 'string' && Object.hasOwn(VALID_FIELD_TYPES, value)) {
    return { fieldType: value as StudioDataField['type'] };
  }
  return {
    error: `invalid fieldType ${JSON.stringify(value)}. Valid field types: ${Object.keys(
      VALID_FIELD_TYPES,
    ).join(', ')}.`,
  };
}

/**
 * Runtime allow-list of every built-in widget kind (finding T2-4), kept EXHAUSTIVE
 * against `BuiltinStudioWidgetKind` via the `satisfies readonly BuiltinStudioWidgetKind[]`
 * clause plus the `AssertAllBuiltinKindsListed` compile-time lock below (same pattern as
 * the schema package's `STUDIO_FILTER_OPERATORS`/`STUDIO_CHART_TYPES` locks): adding a
 * built-in kind without listing it here fails the build. The set of kinds a model may
 * legitimately name is this list UNION the host-registered `customWidgets[].kind`; any
 * other kind string both mints an unrenderable widget AND bypasses all config-key
 * validation (`validateConfigKeysForKind` returns `[]` — unrestricted — for an unknown
 * kind, and the chart-level check only runs for `kind === 'chart'` exactly).
 */
const BUILTIN_WIDGET_KINDS = [
  'grid',
  'chart',
  'kpi',
  'text',
  'filter',
  'pivot',
  'map',
] as const satisfies readonly BuiltinStudioWidgetKind[];

type AssertAllBuiltinKindsListed =
  Exclude<BuiltinStudioWidgetKind, (typeof BUILTIN_WIDGET_KINDS)[number]> extends never
    ? true
    : [
        'BUILTIN_WIDGET_KINDS is missing:',
        Exclude<BuiltinStudioWidgetKind, (typeof BUILTIN_WIDGET_KINDS)[number]>,
      ];
const ALL_BUILTIN_KINDS_LISTED: AssertAllBuiltinKindsListed = true;
void ALL_BUILTIN_KINDS_LISTED;

/**
 * Builds a `StudioWidget` from AI-tool arguments, layering config in one canonical
 * order — factory defaults → custom-widget `defaultConfig` → model-supplied config —
 * and minting the id through the shared `createDefaultWidget` (its
 * `createWidgetId` scheme is collision-resistant). Used by both `add_widget` and
 * `apply_bulk_update`'s additions so the two paths cannot drift (they were
 * previously character-for-character duplicates, including a hand-copied id scheme).
 *
 * Validates only the untrusted `args.config` (not the merged config) against the
 * widget's `kind`: the factory defaults and any `customDef.defaultConfig` are
 * trusted-valid by construction, so validating the merge would just re-check
 * already-safe keys. Returns `{ error }` (no widget built) when the AI-supplied
 * config carries a key that belongs to a different widget kind — fail-closed, so
 * an invalid cross-kind key can never be committed to state.
 */
export function buildWidgetFromArgs(
  args: { kind?: unknown; title?: unknown; sourceId?: unknown; config?: unknown },
  customWidgets?: StudioCustomWidgetDef[],
): { widget: StudioWidget } | { error: string } {
  const kind = String(args.kind ?? 'chart') as StudioWidget['kind'];
  const title = capTitle(String(args.title ?? ''));
  const sourceId = args.sourceId ? capSourceId(String(args.sourceId)) : undefined;
  // Cap every model-supplied string-typed config value (e.g. `xField`/`yField`/
  // `seriesField`) BEFORE it is validated/merged, so an oversized value never
  // lands in state (Tier 2, iteration 22 — see `capConfigStringValues`).
  const aiConfig = capConfigStringValues(args.config ?? {}) as StudioWidget['config'];
  // Validate `kind` against the CLOSED, locally-knowable set (built-in kinds ∪
  // host-registered `customWidgets[].kind`) BEFORE building anything (finding T2-4).
  // An unknown kind — even a capitalization slip like `"Chart"` — both mints a widget
  // the client cannot render AND bypasses every config-key check (an unrestricted kind
  // passes `validateConfigKeysForKind`, and the chart-level check only runs for the
  // exact string `'chart'`). Fail closed with an error naming the valid kinds, matching
  // the fail-closed `chartType` treatment via `isStudioChartType`.
  const isBuiltinKind = (BUILTIN_WIDGET_KINDS as readonly string[]).includes(kind);
  const isRegisteredCustomKind = customWidgets?.some((d) => d.kind === kind) ?? false;
  if (!isBuiltinKind && !isRegisteredCustomKind) {
    const customKinds = (customWidgets ?? []).map((d) => d.kind);
    const validKinds = [...BUILTIN_WIDGET_KINDS, ...customKinds];
    return {
      error: `unknown widget kind '${kind}'. Valid kinds: ${validKinds.join(', ')}.`,
    };
  }
  const error = invalidConfigKeyError(kind, aiConfig as Record<string, unknown>);
  if (error) {
    return { error };
  }
  const valueError = invalidConfigValueError(aiConfig as Record<string, unknown>);
  if (valueError) {
    return { error: valueError };
  }
  if (kind === 'chart') {
    // No existing widget yet — the effective chart type is purely
    // `aiConfig.chartType ?? 'bar'`, so there is no fallback to pass.
    const chartError = invalidChartConfigKeyError(aiConfig as Record<string, unknown>, undefined);
    if (chartError) {
      return { error: chartError };
    }
  }
  const customDef = customWidgets?.find((d) => d.kind === kind);
  const base = createDefaultWidget(kind);
  const config = {
    ...base.config,
    ...(customDef?.defaultConfig ?? {}),
    ...aiConfig,
  } as StudioWidget['config'];
  return {
    widget: {
      ...base,
      title,
      sourceId: sourceId ?? base.sourceId,
      config,
    },
  };
}

/** Shared plan for `remove_page_filter`/`remove_widget_filter` (identical behavior). */
function planRemoveFilter(
  args: Record<string, unknown>,
  ctx: ToolPlanContext,
): ToolExecutionResult {
  const filterId = String(args.filterId ?? '');
  // Existence check BEFORE mutating: the `removeFilter` reducer is a silent
  // no-op for an unknown id, so without this guard the model would be told
  // `success: true` for a call that changed nothing and has no signal to
  // retry with a corrected id — matching every other entity-targeting tool
  // (`remove_widget`, `remove_page`, `set_widget_width`, etc.), which all
  // validate existence and return an actionable error instead.
  if (!ctx.state.doc.filters.find((f) => f.id === filterId)) {
    return {
      output: JSON.stringify({ error: `Filter ${filterId} not found.` }),
      nextState: ctx.state,
    };
  }
  const mutation: StateMutation = { type: 'removeFilter', args: { filterId } };
  return {
    output: JSON.stringify({ success: true, filterId }),
    mutation,
    nextState: applyMutation(ctx.state, mutation),
  };
}

/**
 * The typed handler table — one entry per `StudioAIToolName`, enforced
 * exhaustively by the mapped type below. Converting the previous switch
 * statement into this table makes tool purity a TYPE, not a convention: a
 * tool that performs I/O must be declared `{ effect: 'external' }` (and
 * therefore cannot supply a `plan` function), so it structurally cannot enter
 * the execute-then-gate dry-run path in `toolPolicy.ts`.
 */
const TOOL_IMPLS: { [K in StudioAIToolName]: PureToolImpl | ExternalToolImpl } = {
  get_dashboard_state: {
    effect: 'pure',
    plan: (_args, { state }) => {
      // Return the dashboard document plus DATA-SOURCE METADATA ONLY — never raw
      // row data, and never the AI chat transcripts. The `doc` partition
      // (pages/widgets/dashboard/filters/…) is the authored structure the model
      // needs; `runtime.dataSources` is projected down to
      // `{ id, label, tableName, aiDescription, fields, fieldDistinctValues }` with
      // `rows`/`adapter` stripped and distinct values capped, and `doc.ai` is reduced
      // to per-thread metadata with transcripts removed. This is the canonical output
      // contract, shared with the MCP transport (both call `projectStateForAI`, so the
      // redaction rules live in exactly one place and cannot drift).
      return {
        output: JSON.stringify(projectStateForAI(state)),
        nextState: state,
      };
    },
  },

  list_pages: {
    effect: 'pure',
    plan: (_args, { state }) => {
      const pageList = Object.values(state.doc.pages).map((page) => {
        const widgetIds = (page.widgetRows ?? []).flat();
        const widgetTitles = widgetIds
          .map((id) => getWidget(state, id)?.title)
          .filter((t): t is string => Boolean(t));
        return {
          id: page.id,
          title: page.title,
          widgetCount: widgetIds.length,
          widgetTitles,
          isActive: page.id === state.doc.dashboard.activePageId,
        };
      });
      return {
        output: JSON.stringify({ pages: pageList, activePageId: state.doc.dashboard.activePageId }),
        nextState: state,
      };
    },
  },

  add_page: {
    effect: 'pure',
    plan: (args, { state }) => {
      const title = capTitle(String(args.title ?? 'New Page'));
      const id = createPageId();
      const mutation: StateMutation = { type: 'addPage', args: { id, title } };
      return {
        output: JSON.stringify({ success: true, pageId: id, title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  set_dashboard_title: {
    effect: 'pure',
    plan: (args, { state }) => {
      const title = capTitle(String(args.title ?? ''));
      const mutation: StateMutation = { type: 'setDashboardTitle', args: { title } };
      return {
        output: JSON.stringify({ success: true, title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  add_widget: {
    effect: 'pure',
    plan: (args, { state, customWidgets }) => {
      // Explicitly resolve (and validate) the target page server-side so the
      // widget lands on the same page the model is told about, regardless of
      // where the client's navigation happens to be. Error rather than spread
      // an `undefined` page into state.
      const pageId = state.doc.dashboard.activePageId;
      if (!getPage(state, pageId)) {
        return {
          output: JSON.stringify({
            error: 'Cannot add a widget: there is no active page. Call add_page first.',
          }),
          nextState: state,
        };
      }

      const built = buildWidgetFromArgs(args, customWidgets);
      if ('error' in built) {
        return { output: JSON.stringify({ error: built.error }), nextState: state };
      }
      const { widget } = built;
      const mutation: StateMutation = { type: 'addWidget', args: { widget, pageId } };
      return {
        output: JSON.stringify({ success: true, widgetId: widget.id, title: widget.title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  update_widget: {
    effect: 'pure',
    plan: (args, { state }) => {
      const widgetId = String(args.widgetId ?? '');
      const widget = getWidget(state, widgetId);
      if (!widget) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }

      // Treat `config: null` as absent (T3-1): JSON `null` is not `undefined`, so it
      // would slip past an `!== undefined` gate straight into the config-key validators,
      // whose `Object.keys(null)` / `Object.hasOwn(null, …)` throw a raw
      // `TypeError: Cannot convert undefined or null to object` — surfaced to the model as
      // an opaque, unactionable error. Every sibling path already tolerates a nullish
      // config (`buildWidgetFromArgs` uses `?? {}`; the bulk loop gates on truthiness; the
      // reducer treats a non-record config as absent), so normalize to `undefined` here.
      // Cap every model-supplied string-typed config value BEFORE validation, so an
      // oversized `xField`/`yField`/… never lands in state (Tier 2, iteration 22).
      const configArg = args.config == null ? undefined : capConfigStringValues(args.config);
      if (configArg !== undefined) {
        const error = invalidConfigKeyError(widget.kind, configArg as Record<string, unknown>);
        if (error) {
          return { output: JSON.stringify({ error }), nextState: state };
        }
        const valueError = invalidConfigValueError(configArg as Record<string, unknown>);
        if (valueError) {
          return { output: JSON.stringify({ error: valueError }), nextState: state };
        }
        if (widget.kind === 'chart') {
          // Fall back to the widget's CURRENT chartType: a patch that omits
          // `chartType` validates against it, while a patch that changes
          // `chartType` validates against the NEW type (the patch's own value
          // takes precedence inside the helper).
          const existingChartType = isWidgetOfKind(widget, 'chart')
            ? widget.config.chartType
            : undefined;
          const chartError = invalidChartConfigKeyError(
            configArg as Record<string, unknown>,
            existingChartType,
          );
          if (chartError) {
            return { output: JSON.stringify({ error: chartError }), nextState: state };
          }
        }
      }

      const changes: Partial<Omit<StudioWidget, 'id'>> = {};
      if (args.title !== undefined) {
        changes.title = capTitle(String(args.title));
      }
      if (args.sourceId !== undefined) {
        changes.sourceId = capSourceId(String(args.sourceId));
      }

      // Local MERGE of the incoming patch onto the widget's CURRENT config. Used ONLY
      // for the `unsetConfigKeys` presence filter below (which must test keys against the
      // post-merge config) — the mutation itself carries the RAW patch (`configPatch`),
      // never this merged snapshot. Shipping the whole merged config would re-assert
      // every pre-existing key at its turn-start value, silently reverting a concurrent
      // client edit to a DIFFERENT config key — the same lost-update class already fixed
      // for `apply_bulk_update` and `set_widget_forecast` (finding 2-1). The reducer
      // key-by-key merges the raw patch onto the LIVE widget, so untouched keys survive.
      const mergedConfig =
        configArg !== undefined
          ? ({
              ...widget.config,
              ...(configArg as StudioWidget['config']),
            } as StudioWidget['config'])
          : undefined;
      const configPatch =
        configArg !== undefined ? (configArg as StudioWidget['config']) : undefined;

      // Validate the model-supplied clear arrays before handing them to the reducer
      // (mirrors `set_widget_layout`'s shape validation): malformed model output must
      // not poison state. For `unsetFields` only a fixed set of safe, clearable
      // top-level keys is honored — `id`/`kind`/`title`/`config` are never clearable
      // this way (a required field or the config bag). For `unsetConfigKeys` only keys
      // actually present on the widget's (post-merge) config are honored, so an
      // unknown key name is a silent ignore rather than a delete against nothing.
      const CLEARABLE_WIDGET_FIELDS = new Set<OptionalWidgetField>([
        'sourceId',
        'subtitle',
        'titleMode',
        'subtitleMode',
      ]);
      const unsetFields = (Array.isArray(args.unsetFields) ? args.unsetFields : []).filter(
        (key): key is OptionalWidgetField =>
          typeof key === 'string' && CLEARABLE_WIDGET_FIELDS.has(key as OptionalWidgetField),
      );
      const configForUnsetCheck = mergedConfig ?? widget.config;
      const unsetConfigKeys = (
        Array.isArray(args.unsetConfigKeys) ? args.unsetConfigKeys : []
      ).filter(
        (key): key is string => typeof key === 'string' && Object.hasOwn(configForUnsetCheck, key),
      );

      const mutation: StateMutation = {
        type: 'updateWidget',
        args: {
          widgetId,
          changes,
          ...(configPatch !== undefined ? { config: configPatch } : {}),
          ...(unsetFields.length > 0 ? { unsetFields } : {}),
          ...(unsetConfigKeys.length > 0 ? { unsetConfigKeys } : {}),
        },
      };
      return {
        output: JSON.stringify({ success: true, widgetId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  remove_widget: {
    effect: 'pure',
    plan: (args, { state }) => {
      const widgetId = String(args.widgetId ?? '');
      if (!getWidget(state, widgetId)) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }
      const mutation: StateMutation = { type: 'removeWidget', args: { widgetId } };
      return {
        output: JSON.stringify({ success: true, widgetId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  set_widget_layout: {
    effect: 'pure',
    plan: (args, { state }) => {
      const rawRows = args.rows;
      // Validate the SHAPE, not just `Array.isArray`: a flat `["w1","w2"]` (the
      // exact mistake the system prompt warns about) is a valid array but corrupts
      // `widgetRows` — every downstream `row.map`/`row.filter` then throws on a
      // string, killing the next turn's `buildDashboardState`.
      if (
        !Array.isArray(rawRows) ||
        !rawRows.every((row) => Array.isArray(row) && row.every((id) => typeof id === 'string'))
      ) {
        return {
          output: JSON.stringify({
            error:
              'set_widget_layout requires "rows" to be an array of rows, where each row is an ' +
              'array of widget-ID strings (e.g. [["w1","w2"],["w3"]]).',
          }),
          nextState: state,
        };
      }
      const rows = rawRows as string[][];
      const activePageId = state.doc.dashboard.activePageId;
      const activePage = getPage(state, activePageId);
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      // Reject DUPLICATE ids (RC5): a widget id appearing in more than one cell would
      // place the same widget twice, corrupting the layout (the reducer and canvas
      // assume each widget occupies exactly one slot). Catch it here — before the
      // membership check and the mutation — with an actionable error so the model can
      // resend a clean layout, rather than committing a self-overlapping arrangement.
      const flatLayoutIds = rows.flat();
      const seenLayoutIds = new Set<string>();
      const duplicateIds = [
        ...new Set(
          flatLayoutIds.filter((id) => {
            if (seenLayoutIds.has(id)) {
              return true;
            }
            seenLayoutIds.add(id);
            return false;
          }),
        ),
      ];
      if (duplicateIds.length > 0) {
        return {
          output: JSON.stringify({
            error:
              `set_widget_layout received duplicate widget IDs: ${duplicateIds.join(', ')}. ` +
              'Each widget must appear exactly once across all rows.',
          }),
          nextState: state,
        };
      }
      // Validate MEMBERSHIP: every id must be a known widget (widgets added earlier
      // this turn are already threaded into `state.doc.widgets`). Unknown ids would
      // otherwise be stored as phantom layout entries (blank cards).
      const unknownIds = [...new Set(rows.flat())].filter(
        (id) => !hasOwnEntity(state.doc.widgets, id),
      );
      if (unknownIds.length > 0) {
        return {
          output: JSON.stringify({
            error:
              `set_widget_layout received unknown widget IDs: ${unknownIds.join(', ')}. ` +
              'Call get_dashboard_state to get the current widget IDs.',
          }),
          nextState: state,
        };
      }
      // Active-page OWNERSHIP (T2-A): the emitted `setWidgetLayout` mutation targets the
      // ACTIVE page and the `setWidgetLayout` reducer does NO cross-page cleanup, so placing
      // an id that currently lives on ANOTHER page here would leave that widget referenced by
      // BOTH pages' `widgetRows` — one widget (sharing one config) duplicated across two pages.
      // Mirror `set_widget_width`'s ownership guard: membership is restricted to widgets on the
      // active page or not yet placed anywhere; reject ids owned by a non-active page.
      const activeLayoutIds = new Set((activePage.widgetRows ?? []).flat());
      const foreignPageIds = [...new Set(rows.flat())].filter(
        (id) =>
          !activeLayoutIds.has(id) &&
          Object.values(state.doc.pages).some(
            (page) =>
              page.id !== activePageId && (page.widgetRows ?? []).some((row) => row.includes(id)),
          ),
      );
      if (foreignPageIds.length > 0) {
        return {
          output: JSON.stringify({
            error:
              `set_widget_layout received widget IDs that live on another page: ${foreignPageIds.join(', ')}. ` +
              'A layout call only arranges the active page; call set_active_page for the page that ' +
              'contains them before rearranging them.',
          }),
          nextState: state,
        };
      }
      const mutation: StateMutation = {
        type: 'setWidgetLayout',
        args: { rows, pageId: activePageId },
      };
      return {
        output: JSON.stringify({ success: true, rows }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  set_widget_width: {
    effect: 'pure',
    plan: (args, { state }) => {
      const { widgetId, columns } = args as { widgetId: string; columns: unknown };
      if (typeof widgetId !== 'string') {
        return {
          output: JSON.stringify({ error: 'set_widget_width requires a "widgetId" string.' }),
          nextState: state,
        };
      }
      // Coerce/validate `columns` at the write source (T2-3), mirroring
      // `set_widget_forecast.periods`. `null` is the documented reset (clears the span).
      // The tool schema declares a number, but the value is untrusted: a string like
      // "12" would survive the bare cast and reach the reducer's `clampSpan`, which
      // treats any non-finite input as `MIN_SPAN` (6) — silently committing the minimum
      // width and reporting `{ success: true, columns: 6 }`, contradicting the request.
      // Fail closed on a non-numeric value with an actionable error naming the 6–24 range.
      let normalizedColumns: number | null = null;
      if (columns != null) {
        const n = Number(columns);
        if (!Number.isFinite(n)) {
          return {
            output: JSON.stringify({
              error: `set_widget_width 'columns' must be a number between 6 and 24 (or null to reset); received ${JSON.stringify(
                columns,
              )}.`,
            }),
            nextState: state,
          };
        }
        normalizedColumns = Math.trunc(n);
      }
      // Existence check BEFORE touching layout: without it a nonexistent id falls
      // through to the `[widgetId]` fallback below and emits a `setWidgetColSpan`
      // for a phantom widget (a silent no-op on apply). Reject with a clear error
      // so the model can correct the id instead of assuming the width was set.
      if (!getWidget(state, widgetId)) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }
      const activePageId = state.doc.dashboard.activePageId;
      const activePage = getPage(state, activePageId);
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      // Active-page membership check: the `setWidgetColSpan` reducer silently no-ops for a
      // widget that lives on ANOTHER page (its orphan-span guard — writing the span there
      // would land it on the wrong page). Without this check the tool would read back
      // `null` and report `{ success: true, columns: null }` for a request that changed
      // nothing, telling the model a width took effect that never did. A widget on NO page
      // yet is the documented not-yet-placed case and stays permissive (the reducer applies
      // it via the `[widgetId]` fallback below).
      const currentRow = activePage.widgetRows?.find((row) => row.includes(widgetId));
      if (currentRow === undefined) {
        const onAnotherPage = Object.values(state.doc.pages).some((page) =>
          (page.widgetRows ?? []).some((row) => row.includes(widgetId)),
        );
        if (onAnotherPage) {
          return {
            output: JSON.stringify({
              error:
                `Widget ${widgetId} is not on the active page, so its width cannot be set here. ` +
                'Call set_active_page for the page that contains it first.',
            }),
            nextState: state,
          };
        }
      }
      const rowWidgetIds = currentRow ?? [widgetId];
      const mutation: StateMutation = {
        type: 'setWidgetColSpan',
        args: { widgetId, columns: normalizedColumns, rowWidgetIds, pageId: activePageId },
      };
      const nextState = applyMutation(state, mutation);
      // Report the value that ACTUALLY landed in state, not the raw model input:
      // the `setWidgetColSpan` reducer clamps `columns` to 6–24 (and coerces a
      // non-finite value to the minimum), so `columns: 100` really becomes 24 and
      // `columns: null` clears the span (read back as `null`). Echoing the unclamped
      // input would tell the model a width took effect that never did.
      const appliedColumns = nextState.doc.pages[activePageId]?.widgetColSpans?.[widgetId] ?? null;
      return {
        output: JSON.stringify({ success: true, widgetId, columns: appliedColumns }),
        mutation,
        nextState,
      };
    },
  },

  rename_page: {
    effect: 'pure',
    plan: (args, { state }) => {
      const pageId = String(args.pageId ?? '');
      const title = capTitle(String(args.title ?? ''));
      const page = getPage(state, pageId);
      if (!page) {
        return { output: JSON.stringify({ error: `Page ${pageId} not found.` }), nextState: state };
      }
      const mutation: StateMutation = { type: 'renamePage', args: { pageId, title } };
      return {
        output: JSON.stringify({ success: true, pageId, title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  remove_page: {
    effect: 'pure',
    plan: (args, { state }) => {
      const pageId = String(args.pageId ?? '');
      const page = getPage(state, pageId);
      if (!page) {
        return { output: JSON.stringify({ error: `Page ${pageId} not found.` }), nextState: state };
      }

      // `applyMutation`'s removePage mirrors `StudioController.removePage`
      // exactly (drop the page, remove its widgets, remove its page-scoped
      // filters, and reassign `activePageId` when the removed page was active),
      // so the server-computed `nextState` matches what the client produces.
      const mutation: StateMutation = { type: 'removePage', args: { pageId } };
      return {
        output: JSON.stringify({ success: true, pageId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  set_active_page: {
    effect: 'pure',
    plan: (args, { state }) => {
      const pageId = String(args.pageId ?? '');
      if (!getPage(state, pageId)) {
        return { output: JSON.stringify({ error: `Page ${pageId} not found.` }), nextState: state };
      }
      const mutation: StateMutation = { type: 'setActivePage', args: { pageId } };
      return {
        output: JSON.stringify({ success: true, pageId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  add_page_filter: {
    effect: 'pure',
    plan: (args, { state }) => {
      const activePageId = state.doc.dashboard.activePageId;
      // Match add_widget: confirm the active page exists before scoping a filter to
      // it, so a stale/empty activePageId returns an actionable error instead of
      // committing a page filter targeting a page that no longer exists.
      if (!getPage(state, activePageId)) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      const field = capString(String(args.field ?? ''), MAX_FILTER_STRING_LENGTH);
      const sourceId = capString(String(args.sourceId ?? ''), MAX_FILTER_STRING_LENGTH);
      const operatorRaw = String(args.operator ?? 'equals');
      const operatorError = invalidFilterOperatorError(operatorRaw);
      if (operatorError) {
        return { output: JSON.stringify({ error: operatorError }), nextState: state };
      }
      const operator = operatorRaw as StudioFilterOperator;
      const value = capFilterValue(args.value);
      // Validate `fieldType` against the exhaustive schema-derived set (finding T2-3),
      // mirroring the sibling `operator` gate above — an unvalidated hint would persist
      // verbatim and break the client's filter-input rendering.
      const fieldTypeResult = resolveFieldType(args.fieldType);
      if ('error' in fieldTypeResult) {
        return { output: JSON.stringify({ error: fieldTypeResult.error }), nextState: state };
      }
      const { fieldType } = fieldTypeResult;
      const filterId = createFilterId();
      const filter: StudioFilterState = {
        id: filterId,
        field,
        filterSourceId: sourceId,
        operator,
        value,
        fieldType,
        // Page target chosen server-side and carried in the filter's scope, so
        // the client applies it to this page rather than its own active page.
        scope: { kind: 'page', pageId: activePageId },
      };
      const mutation: StateMutation = { type: 'addFilter', args: { filter } };
      return {
        output: JSON.stringify({ success: true, filterId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  remove_page_filter: { effect: 'pure', plan: planRemoveFilter },

  add_widget_filter: {
    effect: 'pure',
    plan: (args, { state }) => {
      const widgetId = String(args.widgetId ?? '');
      // Match every other entity-targeting tool: validate the widget exists before
      // committing a widget-scoped filter, so a fabricated/stale widgetId returns an
      // actionable error instead of silently committing a dangling no-op filter.
      if (!getWidget(state, widgetId)) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }
      const field = capString(String(args.field ?? ''), MAX_FILTER_STRING_LENGTH);
      const sourceId = capString(String(args.sourceId ?? ''), MAX_FILTER_STRING_LENGTH);
      const operatorRaw = String(args.operator ?? 'equals');
      const operatorError = invalidFilterOperatorError(operatorRaw);
      if (operatorError) {
        return { output: JSON.stringify({ error: operatorError }), nextState: state };
      }
      const operator = operatorRaw as StudioFilterOperator;
      const value = capFilterValue(args.value);
      // Validate `fieldType` (finding T2-3), same as `add_page_filter`.
      const fieldTypeResult = resolveFieldType(args.fieldType);
      if ('error' in fieldTypeResult) {
        return { output: JSON.stringify({ error: fieldTypeResult.error }), nextState: state };
      }
      const { fieldType } = fieldTypeResult;
      const filterId = createFilterId();
      const filter: StudioFilterState = {
        id: filterId,
        field,
        filterSourceId: sourceId,
        operator,
        value,
        fieldType,
        scope: { kind: 'widget', widgetId },
      };
      const mutation: StateMutation = { type: 'addFilter', args: { filter } };
      return {
        output: JSON.stringify({ success: true, filterId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  remove_widget_filter: { effect: 'pure', plan: planRemoveFilter },

  summarise_page: {
    effect: 'pure',
    plan: (args, { state, pageSnapshot, snapshotPageId }) => {
      // On the chat path the only row data available is the client-provided
      // `pageSnapshot`, which is fixed at REQUEST time for the page that was active
      // then (`snapshotPageId`). Unlike the MCP path (which can query any page's
      // sources live), we cannot honor a `pageId` that points at a different page here.
      //
      // Compare the requested page against the snapshot's OWN page identity, NOT the
      // threaded `state.doc.dashboard.activePageId`: a same-turn `set_active_page`
      // mutates the threaded active page mid-turn, so comparing against it would let a
      // `set_active_page(pageB)` + `summarise_page(pageB)` sequence pass this guard and
      // return page A's snapshot narrated as page B (finding 2-2). The snapshot cannot
      // be rebuilt for another page within the turn — that needs a fresh request — so we
      // do NOT tell the model to call `set_active_page`. Fall back to the threaded active
      // page only for legacy callers that don't thread `snapshotPageId`.
      const requestedPageId = args.pageId ? String(args.pageId) : undefined;
      const coveredPageId = snapshotPageId ?? state.doc.dashboard.activePageId;
      if (requestedPageId && requestedPageId !== coveredPageId) {
        return {
          output: JSON.stringify({
            error:
              `summarise_page cannot summarise page "${requestedPageId}" here. The data ` +
              `snapshot for this request covers page "${coveredPageId}", and it cannot be ` +
              'rebuilt for a different page within this turn. Send a new message to summarise ' +
              `page "${requestedPageId}", or omit pageId to summarise the snapshot's page.`,
          }),
          nextState: state,
        };
      }
      if (pageSnapshot) {
        // Return the data snapshot as plain text so the model can read it directly
        // without unwrapping a JSON structure. The tool description instructs the model
        // to follow up with an executive summary of the key insights.
        return {
          output: pageSnapshot,
          nextState: state,
        };
      }
      // No snapshot available — explain the limitation so the model can degrade gracefully.
      return {
        output: JSON.stringify({
          error:
            'summarise_page requires live row data that is only available client-side. ' +
            'Use get_dashboard_state for structural information instead.',
        }),
        nextState: state,
      };
    },
  },

  apply_bulk_update: {
    effect: 'pure',
    plan: (args, { state, customWidgets }) => {
      const activePageId = state.doc.dashboard.activePageId;
      const activePage = getPage(state, activePageId);
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page found.' }), nextState: state };
      }

      const skipped: string[] = [];
      const applied = { updated: 0, added: 0, removed: 0, layout: false, colSpans: 0 };

      let widgetRows = (activePage.widgetRows ?? []).map((row) => [...row]);
      const colSpans = { ...(activePage.widgetColSpans ?? {}) };
      // T2-1 (residual lost-update): `colSpans` is a plan-time snapshot of EVERY widget's
      // span. The `rowsChanged` branch legitimately ships that whole snapshot (rows were
      // re-placed, so the snapshot IS the intended full map), but the colSpans-ONLY branch
      // must ship ONLY the entries this batch actually accepted — otherwise the reducer's
      // merge re-asserts the stale snapshot spans of widgets this batch never touched,
      // reverting a concurrent client-side resize of a DIFFERENT widget. Track accepted
      // entries separately so the colSpans-only payload carries just the real changes.
      const changedSpans: Record<string, number> = {};

      // The mutation carries only DELTAS (remove/add/update), applied by the reducer
      // against the receiver's CURRENT `state.doc.widgets` — never a snapshot of the
      // whole `widgets` record. This is the lost-update fix: a widget the user edits
      // on any page while this agentic turn is running is no longer reverted, because
      // only the ids named below are touched.
      const removedWidgetIds: string[] = [];
      const addedWidgets: StudioWidget[] = [];
      const updatedWidgets: Array<{
        widgetId: string;
        title?: string;
        sourceId?: string;
        config?: StudioWidget['config'];
      }> = [];

      // 1. Removals
      // This handler only rewrites the ACTIVE page's `widgetRows`. Removing a widget
      // that lives on another page would delete it from `widgets` while leaving a
      // dangling id in that other page's rows (blank card). Only remove widgets that
      // are on the active page; report the rest as `skipped`, mirroring the not-found
      // handling. `liveWidgetIds` tracks the ids that exist after each delta step so
      // later update/validation checks match the pre-delta-refactor behavior.
      const activePageWidgetIds = new Set((activePage.widgetRows ?? []).flat());
      const liveWidgetIds = new Set(Object.keys(state.doc.widgets));
      // SHAPE-validate before iterating (finding 2-4), mirroring the `layout` op below:
      // a bare `as string[]` cast trusts the model verbatim, so `widgetRemovals: "w1"`
      // would `for…of` over CHARACTERS (removing widgets "w", "1", …) and report
      // `success`, while `{}` / `42` / `[null]` would throw a raw TypeError instead of
      // the schema-shaped errors this handler crafts. Reject a mis-shaped array with a
      // descriptive `skipped` entry and treat it as empty.
      const rawRemovals = args.widgetRemovals;
      let removals: string[] = [];
      if (rawRemovals !== undefined) {
        if (!Array.isArray(rawRemovals) || !rawRemovals.every((id) => typeof id === 'string')) {
          skipped.push('widgetRemovals: must be an array of widget-ID strings (e.g. ["w1","w2"]).');
        } else {
          removals = rawRemovals as string[];
        }
      }
      for (const wid of removals) {
        if (!liveWidgetIds.has(wid)) {
          skipped.push(`remove ${wid}: not found`);
          continue;
        }
        if (!activePageWidgetIds.has(wid)) {
          skipped.push(`remove ${wid}: not on the active page`);
          continue;
        }
        removedWidgetIds.push(wid);
        liveWidgetIds.delete(wid);
        widgetRows = widgetRows
          .map((row) => row.filter((id) => id !== wid))
          .filter((row) => row.length > 0);
        applied.removed += 1;
      }

      // 2. Additions
      // A `Map` (not a plain object) so a model-chosen widget `title` that is an
      // `Object.prototype` member ("constructor", "toString", "__proto__", …)
      // can't resolve a title ref to an inherited value: `.get(ref)` returns
      // `undefined` for an unmatched ref, so the `?? ref` fallthrough always
      // reaches the raw model string and skip messages read back the exact ref.
      const addedTitleToId = new Map<string, string>();
      // Kind of each widget added THIS batch, keyed by id — so the updates loop below
      // can resolve the kind of a same-batch addition (not yet present in
      // `state.doc.widgets`) for its own config-key validation.
      const addedWidgetKinds: Record<string, string> = {};
      // Running (NOT snapshot) map of every chart widget's CURRENT chartType, keyed by
      // id. Seeded lazily with existing chart widgets and eagerly with same-batch chart
      // additions, then UPDATED after each accepted update that changes a widget's
      // chartType — so a later update in the SAME batch validates its config keys
      // against the chartType an earlier update in this batch just set, not the
      // pre-batch value. Without this, changing a widget's chartType and then setting a
      // key valid only for the NEW type in one bulk call would be falsely rejected
      // (and the reverse — a key valid only for the OLD type — falsely accepted).
      const currentChartTypes = new Map<string, string | undefined>();
      const resolveChartTypeForUpdate = (
        wid: string,
        existingWidget: StudioWidget | undefined,
      ): string | undefined => {
        if (currentChartTypes.has(wid)) {
          return currentChartTypes.get(wid);
        }
        const seed =
          existingWidget && isWidgetOfKind(existingWidget, 'chart')
            ? existingWidget.config.chartType
            : undefined;
        currentChartTypes.set(wid, seed);
        return seed;
      };
      // SHAPE-validate before iterating (finding 2-4): each addition must be a plain
      // record carrying at least a string `kind` and string `title`. A non-array, or an
      // element that is a string / null / array / missing those keys, would throw or
      // silently mis-build. Reject with a descriptive `skipped` entry and treat as empty.
      const rawAdditions = args.widgetAdditions;
      let additions: Array<{
        kind: string;
        title: string;
        sourceId?: string;
        config?: Record<string, unknown>;
      }> = [];
      if (rawAdditions !== undefined) {
        if (
          !Array.isArray(rawAdditions) ||
          !rawAdditions.every(
            (a) =>
              a !== null &&
              typeof a === 'object' &&
              !Array.isArray(a) &&
              typeof (a as { kind?: unknown }).kind === 'string' &&
              typeof (a as { title?: unknown }).title === 'string',
          )
        ) {
          skipped.push(
            'widgetAdditions: must be an array of objects each with a string `kind` and ' +
              'string `title` (e.g. [{ "kind": "chart", "title": "Revenue" }]).',
          );
        } else {
          additions = rawAdditions as typeof additions;
        }
      }
      // Whether this batch carries a layout or colSpans op that resolves added-widget
      // refs BY TITLE (finding 2-3). When it does, two additions with the SAME title are
      // ambiguous: `addedTitleToId` is last-write-wins, so the layout/colSpans ref would
      // resolve to only one of them and the other would land in `doc.widgets` referenced
      // by no page — an invisible orphan that still persists, serializes, and survives
      // undo, all reported as `applied.added` success. So when a title ref could be
      // consulted, the SECOND (and later) addition sharing a title is skipped with an
      // actionable message rather than silently orphaned.
      const batchHasTitleRefs =
        args.layout !== undefined ||
        (args.colSpans !== null &&
          typeof args.colSpans === 'object' &&
          !Array.isArray(args.colSpans) &&
          Object.keys(args.colSpans as Record<string, unknown>).length > 0);
      for (const addition of additions) {
        const built = buildWidgetFromArgs(addition, customWidgets);
        if ('error' in built) {
          skipped.push(`add "${addition.title}": ${built.error}`);
          continue;
        }
        const { widget } = built;
        if (batchHasTitleRefs && addedTitleToId.has(widget.title)) {
          skipped.push(
            `add "${widget.title}": duplicate addition title is ambiguous for a layout or ` +
              'colSpans title reference; give each widget added in this batch a unique title.',
          );
          continue;
        }
        addedWidgets.push(widget);
        liveWidgetIds.add(widget.id);
        addedTitleToId.set(widget.title, widget.id);
        addedWidgetKinds[widget.id] = widget.kind;
        if (isWidgetOfKind(widget, 'chart')) {
          currentChartTypes.set(widget.id, widget.config.chartType);
        }
        widgetRows.push([widget.id]);
        applied.added += 1;
      }

      // 3. Updates
      // Emit each update as a partial patch (never the merged widget snapshot). The
      // reducer merges it onto the LIVE widget, so a concurrent edit to a different
      // key on that widget survives too.
      // SHAPE-validate before iterating (finding 2-4): each update must be a plain
      // record carrying a string `widgetId`. A non-array, or an element that is a
      // string / null / array / missing `widgetId`, would throw or mis-resolve. Reject
      // with a descriptive `skipped` entry and treat as empty.
      const rawUpdates = args.widgetUpdates;
      let updates: Array<{
        widgetId: string;
        title?: string;
        sourceId?: string;
        config?: Record<string, unknown>;
      }> = [];
      if (rawUpdates !== undefined) {
        if (
          !Array.isArray(rawUpdates) ||
          !rawUpdates.every(
            (u) =>
              u !== null &&
              typeof u === 'object' &&
              !Array.isArray(u) &&
              typeof (u as { widgetId?: unknown }).widgetId === 'string',
          )
        ) {
          skipped.push(
            'widgetUpdates: must be an array of objects each with a string `widgetId` ' +
              '(e.g. [{ "widgetId": "w1", "title": "New" }]).',
          );
        } else {
          updates = rawUpdates as typeof updates;
        }
      }
      for (const update of updates) {
        const wid = String(update.widgetId ?? '');
        if (!liveWidgetIds.has(wid)) {
          skipped.push(`update ${wid}: not found`);
          continue;
        }
        // Cap every model-supplied string-typed config value BEFORE validation, so an
        // oversized `xField`/`yField`/… never lands in state (Tier 2, iteration 22).
        const configArg = update.config
          ? (capConfigStringValues(update.config) as Record<string, unknown>)
          : undefined;
        if (configArg) {
          // Resolve the target's kind from either the CURRENT state or a widget
          // added earlier in this same batch (not yet in `state.doc.widgets`).
          const existingWidget = getWidget(state, wid);
          const kind = existingWidget?.kind ?? addedWidgetKinds[wid];
          const error = invalidConfigKeyError(kind, configArg);
          if (error) {
            skipped.push(`update ${wid}: ${error}`);
            continue;
          }
          const valueError = invalidConfigValueError(configArg);
          if (valueError) {
            skipped.push(`update ${wid}: ${valueError}`);
            continue;
          }
          if (kind === 'chart') {
            // Resolve against the RUNNING chartType map (seeded from existing state
            // and same-batch additions, updated after each accepted same-batch
            // chartType change) — never a pre-batch snapshot — so a chartType changed
            // earlier in this same batch is honored here.
            const existingChartType = resolveChartTypeForUpdate(wid, existingWidget);
            const chartError = invalidChartConfigKeyError(configArg, existingChartType);
            if (chartError) {
              skipped.push(`update ${wid}: ${chartError}`);
              continue;
            }
            // Accepted: if this update sets a new chartType, record it so later
            // same-batch updates targeting this widget validate against it.
            if (Object.hasOwn(configArg, 'chartType')) {
              currentChartTypes.set(wid, configArg.chartType as string | undefined);
            }
          }
        }
        updatedWidgets.push({
          widgetId: wid,
          ...(update.title !== undefined ? { title: capTitle(String(update.title)) } : {}),
          ...(update.sourceId !== undefined
            ? { sourceId: capSourceId(String(update.sourceId)) }
            : {}),
          ...(configArg ? { config: configArg as StudioWidget['config'] } : {}),
        });
        applied.updated += 1;
      }

      // 4. Layout
      // Validate the layout with the SAME rigor as the single-widget `set_widget_layout`
      // handler (shape + membership), rather than trusting the model's array verbatim:
      // (a) SHAPE — an array of rows, each an array of strings; a flat `["w1","w2"]`
      //     would corrupt `widgetRows` and make every downstream `row.map`/`row.filter`
      //     throw. (b) MEMBERSHIP — after mapping added-widget TITLE refs to their minted
      //     ids, every id must resolve to a widget that is live after this batch's
      //     removals/additions (`liveWidgetIds`); an unknown id would persist as a
      //     phantom layout entry (blank card) or reference a widget removed earlier in
      //     this same batch. On any failure the layout op is skipped with a clear
      //     message (the rest of the bulk update still applies) — never applied partially
      //     and never thrown.
      const rawLayout = args.layout;
      if (rawLayout !== undefined) {
        if (
          !Array.isArray(rawLayout) ||
          !rawLayout.every(
            (row) => Array.isArray(row) && row.every((ref) => typeof ref === 'string'),
          )
        ) {
          skipped.push(
            'layout: must be an array of rows, where each row is an array of widget-ID ' +
              '(or added-widget-title) strings (e.g. [["w1","w2"],["w3"]]).',
          );
        } else {
          const mappedRows = (rawLayout as string[][])
            .map((row) => row.map((ref) => addedTitleToId.get(ref) ?? ref))
            .filter((row) => row.length > 0);
          // Reject DUPLICATE ids with the SAME rigor as `set_widget_layout`: an id
          // appearing in more than one cell would place one widget twice. The reducer's
          // `dedupeLayoutRows` silently keeps the first occurrence, so committing a layout
          // with duplicates would diverge from what `applied.layout: true` reports. Skip
          // with an actionable message instead so the model can resend a clean layout.
          const seenLayoutIds = new Set<string>();
          const duplicateLayoutIds = [
            ...new Set(
              mappedRows.flat().filter((id) => {
                if (seenLayoutIds.has(id)) {
                  return true;
                }
                seenLayoutIds.add(id);
                return false;
              }),
            ),
          ];
          const unknownLayoutIds = [...new Set(mappedRows.flat())].filter(
            (id) => !liveWidgetIds.has(id),
          );
          // Active-page OWNERSHIP (T2-A): like `set_widget_layout`, the `applyBulkUpdate`
          // mutation rewrites the ACTIVE page's rows and the reducer does NO cross-page
          // cleanup, so an id currently on another page would end up referenced by both
          // pages — one widget duplicated across two. Active-page ids and widgets added this
          // batch (fresh, unplaced ids) are never on `state.doc.pages`'s OTHER pages, so this
          // rejects exactly the ids owned by a non-active page, reported alongside
          // `unknownLayoutIds` for consistency.
          const foreignPageLayoutIds = [...new Set(mappedRows.flat())].filter((id) =>
            Object.values(state.doc.pages).some(
              (page) =>
                page.id !== activePageId && (page.widgetRows ?? []).some((row) => row.includes(id)),
            ),
          );
          // An explicit layout op REPLACES the active page's rows wholesale (including the
          // one-widget-per-row entries the additions loop pushed for this batch's new
          // widgets). So every widget added in this batch MUST appear in the layout — a
          // widget added-but-not-placed would land in `doc.widgets` referenced by no page
          // (invisible orphan that still persists/serializes/survives undo), reported as
          // `applied.added` + `layout:true` success (finding 2-3). Reject the layout op if
          // any addition is unplaced so the model resends a layout that includes them.
          const layoutIdSet = new Set(mappedRows.flat());
          const unplacedAddedIds = addedWidgets
            .map((w) => w.id)
            .filter((id) => !layoutIdSet.has(id));
          if (duplicateLayoutIds.length > 0) {
            skipped.push(
              `layout: duplicate widget IDs: ${duplicateLayoutIds.join(', ')}. ` +
                'Each widget must appear exactly once across all rows.',
            );
          } else if (unknownLayoutIds.length > 0) {
            skipped.push(
              `layout: unknown or removed widget IDs: ${unknownLayoutIds.join(', ')}. ` +
                'Reference only widgets that exist after this update (added-widget titles ' +
                'are resolved to their new IDs).',
            );
          } else if (foreignPageLayoutIds.length > 0) {
            skipped.push(
              `layout: widget IDs that live on another page: ${foreignPageLayoutIds.join(', ')}. ` +
                'A layout op only arranges the active page; switch to the page that contains ' +
                'them first.',
            );
          } else if (unplacedAddedIds.length > 0) {
            skipped.push(
              `layout: widgets added in this batch are not placed in the layout: ${unplacedAddedIds.join(
                ', ',
              )}. A layout op replaces the active page, so every added widget must appear in ` +
                'it (reference an added widget by its title). Layout not applied.',
            );
          } else {
            widgetRows = mappedRows;
            applied.layout = true;
          }
        }
      }

      // 5. Column spans
      // Accept spans in the 24-column unit system the canvas renders (matches
      // `canvasGridConstants.GRID_COLS` = 24 / `MIN_SPAN` = 6 in `@mui/x-studio`
      // and the `setWidgetColSpan` reducer's clamp).
      //
      // An out-of-range (or non-numeric) span is REJECTED and reported via `skipped`,
      // rather than silently dropped: this handler's output reports `applied.colSpans`
      // as a per-op COUNT, not the per-widget applied value (unlike `set_widget_width`,
      // which echoes back the reducer-clamped value for its single widget), so clamping
      // here instead would give the model no way to learn which width it actually got.
      // A `skipped` entry matches every other rejected op in this handler (removals,
      // additions, updates, layout) and gives the model an actionable signal to retry
      // with a value in range.
      //
      // MEMBERSHIP is also enforced (not just range): the reducer writes col-spans to the
      // ACTIVE page only and `enforceLayoutColSpans` prunes any span whose widget isn't in
      // the active page's post-batch rows. So a span keyed to a phantom widget, a widget
      // living on ANOTHER page, or one removed earlier in THIS batch is silently discarded
      // on apply — counting it in `applied.colSpans` would overstate what actually landed.
      // `activePageWidgetIdsAfterBatch` is the authoritative membership set: `widgetRows`
      // here already reflects this batch's removals, additions, and (if provided) layout.
      const activePageWidgetIdsAfterBatch = new Set(widgetRows.flat());
      const colSpanPatch = (args.colSpans as Record<string, unknown> | undefined) ?? {};
      for (const [ref, span] of Object.entries(colSpanPatch)) {
        // Resolve added-widget TITLE refs to their minted ids, mirroring the `layout` op
        // above: a widget added earlier in this same batch is only known to the model by
        // title (its id is server-minted), so keying `colSpans` strictly by id would
        // silently drop a same-batch add-then-resize.
        const wid = addedTitleToId.get(ref) ?? ref;
        if (!liveWidgetIds.has(wid)) {
          skipped.push(`colSpan ${ref}: widget not found.`);
          continue;
        }
        if (!activePageWidgetIdsAfterBatch.has(wid)) {
          skipped.push(`colSpan ${ref}: not on the active page.`);
          continue;
        }
        if (typeof span === 'number' && span >= 6 && span <= 24) {
          colSpans[wid] = span;
          changedSpans[wid] = span;
          applied.colSpans += 1;
        } else {
          skipped.push(
            `colSpan ${ref}: ${JSON.stringify(span)} is out of range (must be a number 6-24).`,
          );
        }
      }

      // T2-4 / 2.3 (producer half): `widgetRows`/`widgetColSpans` are a plan-time snapshot
      // of the active page's layout — attaching them unconditionally means a batch that only
      // contains `widgetUpdates` (no removals/additions/layout/colSpans) still ships that
      // stale snapshot, silently reverting any concurrent client-side layout edit (e.g. a
      // drag-reorder) that happened while this turn was running. So the layout fields are
      // attached only when this batch actually changed layout — mirrored by `applied`, since
      // a requested op that was skipped (not found / invalid / out of range) never touched
      // `widgetRows` or `colSpans` and must not be sent either.
      //
      // Two distinct layout-change shapes attach DIFFERENT fields (finding 2.3):
      //  - A removal / addition / explicit `layout` op genuinely reorders or re-places rows,
      //    so the full turn-start `widgetRows` snapshot IS the intended new placement and
      //    must ship alongside `widgetColSpans`.
      //  - A colSpans-ONLY batch (`applied.colSpans > 0` but no removal/addition/layout op)
      //    changes only widths, never row placement. Shipping `widgetRows` here would revert
      //    a concurrent client-side drag-reorder/row-reassignment — the exact lost-update
      //    class T2-4 closed, one case narrower. So we omit `widgetRows` and send ONLY
      //    `widgetColSpans`, relying on the reducer (`applyMutation.ts`'s
      //    `applyBulkUpdate.apply`, fixed in the same round) to reconcile a spans-only
      //    payload against the page's EXISTING rows instead of wiping them.
      // The reducer treats true absence of BOTH fields as "layout unchanged" and skips the
      // layout-replacement block entirely, so an updates-only or all-skipped batch leaves the
      // client's current layout untouched.
      const rowsChanged = applied.removed > 0 || applied.added > 0 || applied.layout;
      const colSpansOnly = !rowsChanged && applied.colSpans > 0;

      let layoutFields: Record<string, unknown>;
      if (rowsChanged) {
        layoutFields = { widgetRows, widgetColSpans: colSpans };
      } else if (colSpansOnly) {
        // T2-1: ship ONLY the spans this batch changed, not the full turn-start snapshot.
        // The reducer merges these onto the receiver's current spans, so a concurrent
        // client-side resize of an untouched widget survives.
        layoutFields = { widgetColSpans: changedSpans };
      } else {
        layoutFields = {};
      }

      const mutation: StateMutation = {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds,
          addedWidgets,
          updatedWidgets,
          ...layoutFields,
          activePageId,
        },
      } as StateMutation;
      return {
        output: JSON.stringify({
          success: true,
          applied,
          ...(skipped.length > 0 ? { skipped } : {}),
        }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  rename_thread: {
    effect: 'pure',
    plan: (args, { state }) => {
      const { name } = args as { name?: string };
      // Check the TRIMMED value, not just `!name`: a whitespace-only name (e.g. "   ")
      // is a truthy non-empty string that passes `!name` but `trim()`s to "", which
      // would commit an empty thread title (finding T3-3).
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return {
          output: JSON.stringify({ error: 'rename_thread requires a non-empty name string.' }),
          nextState: state,
        };
      }
      const trimmed = name.trim().slice(0, 40);
      // Stamp the thread the request belongs to (the active thread in the request's
      // state snapshot) so the reducer renames THAT thread on the client, even if
      // the user has since switched threads while the model was running. Falls back
      // to the applying side's active thread for legacy/omitted payloads.
      const threadId = state.doc.ai?.activeThreadId;
      const mutation: StateMutation = {
        type: 'renameAIThread',
        args: {
          name: trimmed,
          updatedAt: new Date().toISOString(),
          ...(threadId ? { threadId } : {}),
        },
      };
      return {
        output: JSON.stringify({ success: true, name: trimmed }),
        mutation,
        // Server state carries no `ai` thread store, so this is a no-op here; the
        // client applies the thread rename via the same reducer.
        nextState: applyMutation(state, mutation),
      };
    },
  },

  // Side-effectful (runs a live query via the app-provided `data` config) and
  // therefore must be authorized BEFORE it executes, not dry-run-then-gated —
  // see the PURITY INVARIANT documented in `toolPolicy.ts`. Its real dispatch
  // lives in `agenticLoop/toolDispatch.ts` (chat) and `mcp/dataTools.ts` (MCP) — both call
  // `createDataToolHandlers`, never this function. This entry exists only so
  // `TOOL_IMPLS` is exhaustive over `StudioAIToolName` — calling
  // `executeToolOnState('query_data_source', ...)` directly still falls
  // through to the `default` "Unknown tool" case below.
  query_data_source: { effect: 'external' },

  set_widget_forecast: {
    effect: 'pure',
    plan: (args, { state }) => {
      const { widgetId, enabled, periods, showConfidenceBands } = args as {
        widgetId?: string;
        enabled?: unknown;
        periods?: number;
        showConfidenceBands?: unknown;
      };
      if (!widgetId || typeof widgetId !== 'string') {
        return {
          output: JSON.stringify({ error: 'set_widget_forecast requires a widgetId.' }),
          nextState: state,
        };
      }
      const widget = getWidget(state, widgetId);
      if (!widget) {
        return {
          output: JSON.stringify({ error: `Widget '${widgetId}' not found.` }),
          nextState: state,
        };
      }
      if (!isWidgetOfKind(widget, 'chart')) {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast only supports chartType 'line' or 'area'. Widget '${widgetId}' has kind '${widget.kind}'.`,
          }),
          nextState: state,
        };
      }
      const { chartType } = widget.config;
      if (chartType !== 'line' && chartType !== 'area') {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast only supports chartType 'line' or 'area'. Widget '${widgetId}' has chartType '${chartType ?? '(none)'}'.`,
          }),
          nextState: state,
        };
      }

      // Coerce/validate `periods` as a number at the write source (finding 3.2). The
      // tool schema declares it a number, but the value is untrusted and unvalidated —
      // a crafted string here both produces a structurally-broken forecast config and
      // (before the prompt-side sanitize fix) was echoed into `<dashboard_state>`
      // verbatim (finding 1.1). Fail closed with an actionable error on a non-numeric
      // value so the model can retry, rather than storing the raw string.
      let periodsNum: number | undefined;
      if (periods != null) {
        const n = Number(periods);
        if (!Number.isFinite(n) || n <= 0) {
          return {
            output: JSON.stringify({
              error: `set_widget_forecast 'periods' must be a positive number; received ${JSON.stringify(
                periods,
              )}.`,
            }),
            nextState: state,
          };
        }
        periodsNum = Math.floor(n);
      }

      // Strictly validate `enabled`/`showConfidenceBands` as ACTUAL booleans at the write
      // source (T2-3, finding-3.2 value-shape class). The tool schema declares both boolean
      // (and marks `enabled` required), but the args are untrusted and unvalidated: relying
      // on JS truthiness means a classic string-boolean slip like `enabled: "false"`
      // (truthy!) would ENABLE a forecast a call meant to DISABLE — while reporting
      // `success` — and a `showConfidenceBands: "no"` would persist a string in a
      // `boolean`-typed config field. Fail closed with an actionable error — mirroring the
      // `periods` coercion above and the shared `invalidConfigValueError` boolean check —
      // rather than silently coercing the dangerous `"false"` → `true` direction.
      if (typeof enabled !== 'boolean') {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast 'enabled' must be a boolean (true or false); received ${JSON.stringify(
              enabled,
            )}.`,
          }),
          nextState: state,
        };
      }
      if (showConfidenceBands != null && typeof showConfidenceBands !== 'boolean') {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast 'showConfidenceBands' must be a boolean (true or false); received ${JSON.stringify(
              showConfidenceBands,
            )}.`,
          }),
          nextState: state,
        };
      }

      const forecastConfig = enabled
        ? {
            enabled: true,
            ...(periodsNum != null ? { periods: periodsNum } : {}),
            method: 'linear' as const,
            ...(showConfidenceBands != null ? { showConfidenceBands } : {}),
          }
        : { enabled: false };

      // Emit a PARTIAL config patch carrying only `forecast` (via the top-level `config`
      // arg, which the reducer shallow-merges onto the LIVE widget config) rather than
      // a `changes.config` object — `changes.config` replaces the config WHOLESALE, so
      // it would discard every other config key (title styling, colors, series, other
      // chart settings) the widget already had, and would also clobber a concurrent
      // edit to a different config key made while this turn was running. Merging just
      // the forecast delta preserves them.
      const mutation: StateMutation = {
        type: 'updateWidget',
        args: {
          widgetId,
          changes: {},
          config: { forecast: forecastConfig } as StudioWidget['config'],
        },
      };
      return {
        output: JSON.stringify({ success: true, widgetId, forecast: forecastConfig }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },
};

/**
 * Execute a single built-in tool against the provided `StudioState`.
 *
 * Returns the tool output string plus an optional state mutation (for write tools).
 * The `nextState` can be fed into subsequent tool calls within the same turn.
 *
 * Dispatches through `TOOL_IMPLS`. `toolName` is an arbitrary string (unknown or
 * unregistered tool names — including `query_data_source`, which is intentionally
 * `{ effect: 'external' }` with no `plan` — fall through to the same
 * `Unknown tool` error the old switch statement's `default` case produced).
 */
export function executeToolOnState(
  toolName: string,
  input: unknown,
  state: StudioState,
  customWidgets?: StudioCustomWidgetDef[],
  pageSnapshot?: string,
  snapshotPageId?: string,
): ToolExecutionResult {
  const args = (input ?? {}) as Record<string, unknown>;
  // `Object.hasOwn`-guard the lookup so a model-supplied `toolName` that is an
  // `Object.prototype` member ("constructor", "toString", "__proto__", …)
  // resolves to `undefined` instead of an inherited value, and falls through to
  // the same `Unknown tool` error every other unregistered name receives.
  const impl = Object.hasOwn(TOOL_IMPLS, toolName)
    ? (TOOL_IMPLS as Record<string, PureToolImpl | ExternalToolImpl | undefined>)[toolName]
    : undefined;

  if (impl?.effect === 'pure') {
    return impl.plan(args, { state, customWidgets, pageSnapshot, snapshotPageId });
  }

  return { output: JSON.stringify({ error: `Unknown tool: ${toolName}` }), nextState: state };
}
