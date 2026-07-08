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
  isStudioChartType,
  isWidgetOfKind,
  STUDIO_CHART_TYPES,
  validateChartConfigKeysForType,
  validateConfigKeysForKind,
} from '@mui/x-studio-schema';
import type { OptionalWidgetField } from '@mui/x-studio-schema';
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

/** Context threaded into every pure tool's `plan` function. */
export interface ToolPlanContext {
  state: StudioState;
  customWidgets?: StudioCustomWidgetDef[];
  pageSnapshot?: string;
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
 * dispatch lives in `agenticLoop.ts` (chat) and `mcp/dataTools.ts` (MCP), both
 * consulting the policy first, and is intentionally NOT reachable through
 * `executeToolOnState` — see the `default` case below. This entry exists
 * purely so `TOOL_IMPLS` is exhaustive over every `StudioAIToolName`, letting
 * a future consumer type `executeToolWithPolicy`'s
 * accepted shape as `PureToolImpl`-only.
 */
export interface ExternalToolImpl {
  effect: 'external';
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
function buildWidgetFromArgs(
  args: { kind?: unknown; title?: unknown; sourceId?: unknown; config?: unknown },
  customWidgets?: StudioCustomWidgetDef[],
): { widget: StudioWidget } | { error: string } {
  const kind = String(args.kind ?? 'chart') as StudioWidget['kind'];
  const title = String(args.title ?? '');
  const sourceId = args.sourceId ? String(args.sourceId) : undefined;
  const aiConfig = (args.config ?? {}) as StudioWidget['config'];
  const error = invalidConfigKeyError(kind, aiConfig as Record<string, unknown>);
  if (error) {
    return { error };
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
      // row data. The `doc` partition (pages/widgets/dashboard/filters/…) is the
      // authored structure the model needs; `runtime.dataSources` is projected down
      // to `{ id, label, tableName, aiDescription, fields, fieldDistinctValues }`
      // with `rows`/`adapter` stripped and distinct values capped. This is the
      // canonical output contract, shared with the MCP transport (both fall through
      // this same pure plan). Emitting raw `StudioState` here would leak live rows
      // straight into the model context — a token bomb and an exfiltration path that
      // defeats `privateMode` — so it is deliberately redacted.
      const dataSources: Record<string, unknown> = {};
      for (const [id, source] of Object.entries(state.runtime.dataSources)) {
        dataSources[id] = projectDataSourceMetadata(source);
      }
      return {
        output: JSON.stringify({ doc: state.doc, dataSources }),
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
          .map((id) => state.doc.widgets[id]?.title)
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
      const title = String(args.title ?? 'New Page');
      const id = `page-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
      const title = String(args.title ?? '');
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
      if (!state.doc.pages[pageId]) {
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
      const widget = state.doc.widgets[widgetId];
      if (!widget) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }

      if (args.config !== undefined) {
        const error = invalidConfigKeyError(widget.kind, args.config as Record<string, unknown>);
        if (error) {
          return { output: JSON.stringify({ error }), nextState: state };
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
            args.config as Record<string, unknown>,
            existingChartType,
          );
          if (chartError) {
            return { output: JSON.stringify({ error: chartError }), nextState: state };
          }
        }
      }

      const changes: Partial<Omit<StudioWidget, 'id'>> = {};
      if (args.title !== undefined) {
        changes.title = String(args.title);
      }
      if (args.sourceId !== undefined) {
        changes.sourceId = String(args.sourceId);
      }

      const newConfig =
        args.config !== undefined
          ? ({
              ...widget.config,
              ...(args.config as StudioWidget['config']),
            } as StudioWidget['config'])
          : undefined;

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
      const configForUnsetCheck = newConfig ?? widget.config;
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
          ...(newConfig !== undefined ? { config: newConfig } : {}),
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
      if (!state.doc.widgets[widgetId]) {
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
      if (!state.doc.pages[activePageId]) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      // Validate MEMBERSHIP: every id must be a known widget (widgets added earlier
      // this turn are already threaded into `state.doc.widgets`). Unknown ids would
      // otherwise be stored as phantom layout entries (blank cards).
      const unknownIds = [...new Set(rows.flat())].filter((id) => !state.doc.widgets[id]);
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
      const { widgetId, columns } = args as { widgetId: string; columns: number | null };
      if (typeof widgetId !== 'string') {
        return {
          output: JSON.stringify({ error: 'set_widget_width requires a "widgetId" string.' }),
          nextState: state,
        };
      }
      const activePageId = state.doc.dashboard.activePageId;
      const activePage = state.doc.pages[activePageId];
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      const rowWidgetIds = activePage.widgetRows?.find((row) => row.includes(widgetId)) ?? [
        widgetId,
      ];
      const mutation: StateMutation = {
        type: 'setWidgetColSpan',
        args: { widgetId, columns, rowWidgetIds, pageId: activePageId },
      };
      return {
        output: JSON.stringify({ success: true, widgetId, columns }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  rename_page: {
    effect: 'pure',
    plan: (args, { state }) => {
      const pageId = String(args.pageId ?? '');
      const title = String(args.title ?? '');
      const page = state.doc.pages[pageId];
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
      const page = state.doc.pages[pageId];
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
      if (!state.doc.pages[pageId]) {
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
      const field = String(args.field ?? '');
      const sourceId = String(args.sourceId ?? '');
      const operator = String(args.operator ?? 'equals') as StudioFilterOperator;
      const value = args.value;
      const fieldType = args.fieldType as StudioDataField['type'] | undefined;
      const filterId = `filter-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const filter: StudioFilterState = {
        id: filterId,
        field,
        filterSourceId: sourceId,
        operator,
        value,
        fieldType,
        // Page target chosen server-side and carried in the filter's scope, so
        // the client applies it to this page rather than its own active page.
        scope: { kind: 'page', pageId: state.doc.dashboard.activePageId },
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
      const field = String(args.field ?? '');
      const sourceId = String(args.sourceId ?? '');
      const operator = String(args.operator ?? 'equals') as StudioFilterOperator;
      const value = args.value;
      const fieldType = args.fieldType as StudioDataField['type'] | undefined;
      const filterId = `filter-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
    plan: (args, { state, pageSnapshot }) => {
      // On the chat path the only row data available is the client-provided
      // `pageSnapshot`, which is built for the *active* page. Unlike the MCP path
      // (which can query any page's sources live), we cannot honor a `pageId` that
      // points at a non-active page here. The tool schema advertises `pageId`, so
      // rather than silently mislabel the active page's data as the requested page,
      // reject the request with actionable guidance.
      const requestedPageId = args.pageId ? String(args.pageId) : undefined;
      const activePageId = state.doc.dashboard.activePageId;
      if (requestedPageId && requestedPageId !== activePageId) {
        return {
          output: JSON.stringify({
            error:
              `summarise_page cannot summarise page "${requestedPageId}" here. ` +
              'In chat, live row data is only available for the active page, so a non-active ' +
              `pageId cannot be honored. Call set_active_page with "${requestedPageId}" first, ` +
              'then summarise_page, or omit pageId to summarise the active page.',
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
      const activePage = state.doc.pages[activePageId];
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page found.' }), nextState: state };
      }

      const skipped: string[] = [];
      const applied = { updated: 0, added: 0, removed: 0, layout: false, colSpans: 0 };

      let widgetRows = activePage.widgetRows.map((row) => [...row]);
      const colSpans = { ...(activePage.widgetColSpans ?? {}) };

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
      const activePageWidgetIds = new Set(activePage.widgetRows.flat());
      const liveWidgetIds = new Set(Object.keys(state.doc.widgets));
      const removals = (args.widgetRemovals as string[] | undefined) ?? [];
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
      const addedTitleToId: Record<string, string> = {};
      // Kind (and, for chart widgets, chartType) of each widget added THIS batch,
      // keyed by id — so the updates loop below can resolve the kind/chartType of
      // a same-batch addition (not yet present in `state.doc.widgets`) for its own
      // config-key validation.
      const addedWidgetKinds: Record<string, string> = {};
      const addedWidgetChartTypes: Record<string, string | undefined> = {};
      const additions =
        (args.widgetAdditions as
          | Array<{
              kind: string;
              title: string;
              sourceId?: string;
              config?: Record<string, unknown>;
            }>
          | undefined) ?? [];
      for (const addition of additions) {
        const built = buildWidgetFromArgs(addition, customWidgets);
        if ('error' in built) {
          skipped.push(`add "${addition.title}": ${built.error}`);
          continue;
        }
        const { widget } = built;
        addedWidgets.push(widget);
        liveWidgetIds.add(widget.id);
        addedTitleToId[widget.title] = widget.id;
        addedWidgetKinds[widget.id] = widget.kind;
        if (widget.kind === 'chart' && isWidgetOfKind(widget, 'chart')) {
          addedWidgetChartTypes[widget.id] = widget.config.chartType;
        }
        widgetRows.push([widget.id]);
        applied.added += 1;
      }

      // 3. Updates
      // Emit each update as a partial patch (never the merged widget snapshot). The
      // reducer merges it onto the LIVE widget, so a concurrent edit to a different
      // key on that widget survives too.
      const updates =
        (args.widgetUpdates as
          | Array<{
              widgetId: string;
              title?: string;
              sourceId?: string;
              config?: Record<string, unknown>;
            }>
          | undefined) ?? [];
      for (const update of updates) {
        const wid = String(update.widgetId ?? '');
        if (!liveWidgetIds.has(wid)) {
          skipped.push(`update ${wid}: not found`);
          continue;
        }
        if (update.config) {
          // Resolve the target's kind from either the CURRENT state or a widget
          // added earlier in this same batch (not yet in `state.doc.widgets`).
          const existingWidget = state.doc.widgets[wid];
          const kind = existingWidget?.kind ?? addedWidgetKinds[wid];
          const error = invalidConfigKeyError(kind, update.config as Record<string, unknown>);
          if (error) {
            skipped.push(`update ${wid}: ${error}`);
            continue;
          }
          if (kind === 'chart') {
            // Mirror the kind resolution above: fall back to a same-batch
            // addition's chartType when the widget isn't in `state.doc.widgets` yet.
            const existingChartType =
              existingWidget && isWidgetOfKind(existingWidget, 'chart')
                ? existingWidget.config.chartType
                : addedWidgetChartTypes[wid];
            const chartError = invalidChartConfigKeyError(
              update.config as Record<string, unknown>,
              existingChartType,
            );
            if (chartError) {
              skipped.push(`update ${wid}: ${chartError}`);
              continue;
            }
          }
        }
        updatedWidgets.push({
          widgetId: wid,
          ...(update.title !== undefined ? { title: String(update.title) } : {}),
          ...(update.sourceId !== undefined ? { sourceId: String(update.sourceId) } : {}),
          ...(update.config ? { config: update.config as StudioWidget['config'] } : {}),
        });
        applied.updated += 1;
      }

      // 4. Layout
      const rawLayout = args.layout as string[][] | undefined;
      if (rawLayout && Array.isArray(rawLayout)) {
        widgetRows = rawLayout
          .map((row) => row.map((ref) => addedTitleToId[ref] ?? ref))
          .filter((row) => row.length > 0);
        applied.layout = true;
      }

      // 5. Column spans
      // Accept spans in the 24-column unit system the canvas renders (matches
      // `canvasGridConstants.GRID_COLS` = 24 / `MIN_SPAN` = 6 in `@mui/x-studio`
      // and the `setWidgetColSpan` reducer's clamp).
      const colSpanPatch = (args.colSpans as Record<string, number> | undefined) ?? {};
      for (const [wid, span] of Object.entries(colSpanPatch)) {
        if (typeof span === 'number' && span >= 6 && span <= 24) {
          colSpans[wid] = span;
          applied.colSpans += 1;
        }
      }

      const mutation: StateMutation = {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds,
          addedWidgets,
          updatedWidgets,
          widgetRows,
          widgetColSpans: colSpans,
          activePageId,
        },
      };
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
      if (!name || typeof name !== 'string') {
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
  // lives in `agenticLoop.ts` (chat) and `mcp/dataTools.ts` (MCP) — both call
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
        enabled?: boolean;
        periods?: number;
        showConfidenceBands?: boolean;
      };
      if (!widgetId || typeof widgetId !== 'string') {
        return {
          output: JSON.stringify({ error: 'set_widget_forecast requires a widgetId.' }),
          nextState: state,
        };
      }
      const widget = state.doc.widgets[widgetId];
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

      const forecastConfig = enabled
        ? {
            enabled: true,
            ...(periods != null ? { periods } : {}),
            method: 'linear' as const,
            ...(showConfidenceBands != null ? { showConfidenceBands } : {}),
          }
        : { enabled: false };

      const mutation: StateMutation = {
        type: 'updateWidget',
        args: { widgetId, changes: { config: { ...widget.config, forecast: forecastConfig } } },
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
): ToolExecutionResult {
  const args = (input ?? {}) as Record<string, unknown>;
  const impl = (TOOL_IMPLS as Record<string, PureToolImpl | ExternalToolImpl | undefined>)[
    toolName
  ];

  if (impl?.effect === 'pure') {
    return impl.plan(args, { state, customWidgets, pageSnapshot });
  }

  return { output: JSON.stringify({ error: `Unknown tool: ${toolName}` }), nextState: state };
}
