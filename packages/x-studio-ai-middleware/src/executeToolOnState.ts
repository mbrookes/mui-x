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
  isWidgetOfKind,
  isStudioFilterOperator,
  STUDIO_FILTER_OPERATORS,
  createFilterId,
  createPageId,
} from '@mui/x-studio-schema';
import type { OptionalWidgetField } from '@mui/x-studio-schema';
import type {
  StudioState,
  StudioCustomWidgetDef,
  StudioWidget,
  StudioPage,
  StudioFilterOperator,
  StudioFilterState,
} from './models/studioTypes';
import type { StateMutation, StudioAIToolName } from './models/aiTypes';
import { asString, MAX_GENERATED_TITLE_LENGTH } from './internal/promptCaps';
// The four leaf modules this file was carved into. Each has a consumer other than this one,
// which is the measurement that said they were separate modules in the first place.
import {
  capString,
  capTitle,
  capEntityId,
  capSourceId,
  capFilterValue,
  capConfigStringValues,
  MAX_FILTER_STRING_LENGTH,
  MAX_LAYOUT_ROWS,
} from './internal/valueCaps';
import {
  asNumber,
  describeArgValue,
  invalidStringArgsError,
  joinIdsForError,
  truncateSkipped,
} from './internal/toolArgs';
import {
  buildWidgetFromArgs,
  invalidConfigKeyError,
  invalidConfigValueError,
  invalidChartConfigKeyError,
  resolveFieldType,
} from './internal/widgetFromArgs';
import { projectStateForAI } from './internal/stateProjection';
import { getWidget, getPage } from './internal/entityLookup';
// Shared pure functions: the widget factory (so AI-created and UI-created widgets
// share defaults) and the single mutation reducer (so the server-threaded state
// and the client-applied state are computed by the exact same code).

export interface ToolExecutionResult {
  output: string;
  mutation?: StateMutation;
  nextState: StudioState;
}

/**
 * Max number of operations accepted per array/record arg of a single
 * `apply_bulk_update` call. One bulk call counts as ONE
 * mutation against `maxMutationsPerRequest`, but without a per-arg cap a single call
 * could mint unbounded persisted widgets via `widgetAdditions` — a PERSISTENT token
 * bomb, since every widget is re-described in `<dashboard_state>` on every future
 * request — plus unbounded diff work in `computeToolEffects`. Entries beyond this cap
 * are rejected with actionable guidance (mirroring `validateQueryArrayArg`'s
 * reject-with-guidance pattern) rather than silently dropped or processed.
 */
const MAX_BULK_UPDATE_OPS = 200;

/** Context threaded into every pure tool's `plan` function. */
export interface ToolPlanContext {
  state: StudioState;
  customWidgets?: StudioCustomWidgetDef[];
  pageSnapshot?: string;
  /**
   * The id of the page the `pageSnapshot` was built for — captured ONCE at request
   * time (the active page when the request began). `summarise_page` compares the
   * requested page against THIS, not the threaded `state.doc.dashboard.activePageId`,
   * so a same-turn `set_active_page` cannot make it narrate the wrong page's snapshot.
   *
   */
  snapshotPageId?: string;
  /**
   * Whether this request runs under `privateMode`.
   *
   * `PRIVATE_MODE_EXCLUDED_TOOLS` (`agenticLoop.ts`) handles the read tools by simply
   * not advertising them, but that lever only works for a tool whose whole purpose is
   * to return state. The write tools here stay advertised — withdrawing
   * `set_widget_forecast`/`set_widget_width`/`set_widget_layout` in private mode would
   * remove real capability — while their rejection paths interpolated withheld state
   * (`widget.kind`, `chartType`, which page owns a widget, which ids are foreign)
   * straight into the error string. On the chat transport a tool result is not a
   * one-shot value: it is appended to the conversation and re-sent to the provider on
   * EVERY remaining turn, so an error string is the same egress as a tool output.
   *
   * Where this is set, a rejection states the CONSTRAINT the model has to satisfy
   * instead of the state that violates it — the shape `set_widget_layout`'s unknown-id
   * branch already uses for a related reason. The rejections stay actionable; they
   * just stop being an oracle for probing the dashboard this mode exists to withhold.
   */
  privateMode?: boolean;
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
 * same key. On that mismatch the executor reports `success: true` for a
 * call the reducer treated as a no-op (budget/SSE/persistence-hook pollution + a
 * model/actual-state desync), and for `add_widget_filter` actually COMMITS a dangling
 * filter (its `addFilter` reducer applies the filter verbatim regardless). Routing
 * every model-supplied id lookup through these helpers makes the executor's
 * existence checks agree with the reducer's own-property discipline.
 */
function hasOwnEntity(map: object, id: string): boolean {
  return Object.hasOwn(map, id);
}

/**
 * A reason a model-supplied layout is unusable, as data rather than as a sentence.
 *
 * Two tools validate a `string[][]` layout — `set_widget_layout` and `apply_bulk_update`'s
 * layout op — and they agreed on WHAT makes one invalid while disagreeing on what to do about
 * it: the first returns an error and applies nothing, the second records a `skipped` entry and
 * still applies the rest of the batch. That difference is correct and stays at the call sites.
 * What was duplicated was the predicate, kept aligned by a pair of comments each asserting it
 * matched "the SAME rigor" as the other — which is not a mechanism.
 *
 * The callers turn these into their own wording because an error string here is addressed to
 * the model, and the two tools owe it different remedies (one says "resend a layout", the other
 * "added-widget titles are resolved to their new IDs"). Same division the config validators
 * follow: shared predicate, local sentence.
 */
type LayoutProblem =
  | { kind: 'duplicate'; ids: string[] }
  | { kind: 'unknown'; ids: string[] }
  | { kind: 'foreign-page'; ids: string[] };

/**
 * Shape- and size-check a raw `rows` argument, returning the narrowed rows or the reason it is
 * unusable.
 *
 * The shape check is not `Array.isArray` alone: a flat `["w1","w2"]` — the exact mistake the
 * system prompt warns about — is a valid array that corrupts `widgetRows`, after which every
 * downstream `row.map`/`row.filter` throws on a string and kills the next turn's
 * `buildDashboardState`.
 *
 * Over-cap is rejected rather than truncated by both callers, because a layout REPLACES the
 * active page's rows wholesale: keeping the first `MAX_LAYOUT_ROWS` would silently orphan every
 * widget beyond them.
 */
function parseLayoutRows(
  raw: unknown,
): { rows: string[][] } | { problem: 'shape' | 'too-many-rows'; count: number } {
  if (
    !Array.isArray(raw) ||
    !raw.every((row) => Array.isArray(row) && row.every((id) => typeof id === 'string'))
  ) {
    return { problem: 'shape', count: 0 };
  }
  if (raw.length > MAX_LAYOUT_ROWS) {
    return { problem: 'too-many-rows', count: raw.length };
  }
  return { rows: raw as string[][] };
}

/**
 * The first id-level problem with an already-shape-checked layout, or `undefined` when it is
 * placeable.
 *
 * Ordered, and both callers depend on the order: duplicates first (an id in two cells would
 * place one widget twice — the reducer's `dedupeLayoutRows` silently keeps the first, so
 * committing one would diverge from what the tool reports as applied), then membership (an
 * unknown id persists as a phantom layout entry — a blank card), then active-page ownership.
 *
 * `isLive` rather than a widget map because the two callers mean different things by "exists":
 * `set_widget_layout` asks about `state.doc.widgets`, while `apply_bulk_update` asks about the
 * ids that survive ITS OWN removals and additions, which are not in `state` yet.
 *
 * The ownership check exists because the emitted mutations target the ACTIVE page and neither
 * reducer path does cross-page cleanup, so placing an id that currently lives on another page
 * leaves that widget referenced by both pages' `widgetRows` — one widget, one config, two pages.
 */
function findLayoutIdProblem(
  rows: string[][],
  ctx: { isLive: (id: string) => boolean; state: StudioState; activePageId: string },
): LayoutProblem | undefined {
  const flat = rows.flat();
  const seen = new Set<string>();
  const duplicates = [
    ...new Set(
      flat.filter((id) => {
        if (seen.has(id)) {
          return true;
        }
        seen.add(id);
        return false;
      }),
    ),
  ];
  if (duplicates.length > 0) {
    return { kind: 'duplicate', ids: duplicates };
  }
  const distinct = [...new Set(flat)];
  const unknown = distinct.filter((id) => !ctx.isLive(id));
  if (unknown.length > 0) {
    return { kind: 'unknown', ids: unknown };
  }
  // Ids already on the active page are exempt: an id can legitimately appear in the layout it
  // is being re-sent from, and a doc where one id sits on two pages at once is already the
  // corruption this check exists to prevent rather than one to report here.
  const activeIds = new Set(
    (ctx.state.doc.pages[ctx.activePageId]?.widgetRows ?? []).flat() as string[],
  );
  const foreign = distinct.filter(
    (id) =>
      !activeIds.has(id) &&
      Object.values(ctx.state.doc.pages).some(
        (page) =>
          page.id !== ctx.activePageId && (page.widgetRows ?? []).some((row) => row.includes(id)),
      ),
  );
  return foreign.length > 0 ? { kind: 'foreign-page', ids: foreign } : undefined;
}

/**
 * `set_widget_layout`'s wording for a {@link LayoutProblem}. `apply_bulk_update` writes its own,
 * because its layout op is one of five and its remedies mention batch-specific machinery.
 *
 * The unknown-id remediation states the CONSTRAINT and names no discovery tool on purpose: the
 * obvious hint — "call `get_dashboard_state`" — is wrong under `privateMode`, where that tool is
 * `privateModeExcluded` and never advertised while this one still is, so the model would spend a
 * turn on an `Unknown tool` error before it could retry. The same applies whenever a host narrows
 * `allowedTools`. What is true in every mode is where a valid id comes from, so it says that.
 *
 * Under `privateMode` the foreign-page branch drops the id list. WHICH submitted ids live
 * elsewhere is a state-derived fact rather than something the caller told us, so naming them
 * partitions the model's ids by page — exactly the structure private mode withholds — and this
 * string is re-sent to the provider on every remaining turn. The constraint and the remedy are
 * unchanged; only the list goes.
 */
function layoutProblemMessage(problem: LayoutProblem, privateMode: boolean | undefined): string {
  if (problem.kind === 'duplicate') {
    return (
      `set_widget_layout received duplicate widget IDs: ${joinIdsForError(problem.ids)}. ` +
      'Each widget must appear exactly once across all rows.'
    );
  }
  if (problem.kind === 'unknown') {
    return (
      `set_widget_layout received unknown widget IDs: ${joinIdsForError(problem.ids)}. ` +
      'A layout only arranges widgets that already exist — it cannot create one, so an ' +
      'ID that names no widget would be stored as a blank card. Use the IDs that ' +
      'add_widget returned earlier in this conversation, or the ones already present in ' +
      'the layout you were given.'
    );
  }
  return privateMode
    ? 'set_widget_layout received widget IDs that are not on the active page. A layout ' +
        'call only arranges the active page; call set_active_page for the page that holds ' +
        'them before rearranging them, or submit only IDs already in the layout you were given.'
    : `set_widget_layout received widget IDs that live on another page: ${joinIdsForError(problem.ids)}. ` +
        'A layout call only arranges the active page; call set_active_page for the page that ' +
        'contains them before rearranging them.';
}

/**
 * `Object.hasOwn`-guarded read of one widget's column span from a page's
 * `widgetColSpans` map, returning `null` for "no span set".
 *
 * `widgetColSpans` is keyed by a model-supplied widget id, and it is the second of
 * the two maps the MCP-side `ownArrayEntry` helper was introduced for. The bare
 * `page?.widgetColSpans?.[widgetId]` this replaces walked the prototype chain: for
 * `widgetId: 'constructor'` it resolved `Object` — a truthy non-number — and
 * `set_widget_width` reported `{ success: true, columns: <the Object function> }`,
 * telling the model a width had been applied that the reducer never wrote. The
 * `typeof … === 'number'` check makes the read total in the other direction too, so
 * a client-supplied non-numeric span reads back as "unset" rather than being echoed.
 */
function getWidgetColSpan(
  page: StudioState['doc']['pages'][string] | undefined,
  widgetId: string,
): number | null {
  const spans = page?.widgetColSpans;
  if (!spans || typeof spans !== 'object' || !Object.hasOwn(spans, widgetId)) {
    return null;
  }
  const span = spans[widgetId];
  return typeof span === 'number' ? span : null;
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
 * (`parseStateMutation.ts`) validates against, so the AI-tool boundary
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

/** Shared plan for `remove_page_filter`/`remove_widget_filter` (identical behavior). */
function planRemoveFilter(
  args: Record<string, unknown>,
  ctx: ToolPlanContext,
): ToolExecutionResult {
  // Reject a non-string-coercible `filterId` with an actionable error rather than letting
  // `asString` normalize it to `''` and reporting the confusing `Filter not found.` (and rather
  // than the raw `TypeError` `String()` threw).
  const argError = invalidStringArgsError(args, ['filterId']);
  if (argError) {
    return { output: JSON.stringify({ error: argError }), nextState: ctx.state };
  }
  const filterId = asString(args.filterId ?? '');
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
/**
 * The running result of one `apply_bulk_update` call, threaded through its five ops.
 *
 * The handler is ONE tool on purpose — it emits a single `applyBulkUpdate` mutation carrying
 * deltas, so the client applies it atomically and the human approves it once — but it was also
 * one 571-line closure, and the coupling that makes it a single transaction was invisible inside
 * it. Removals mutate {@link widgetRows} and {@link liveWidgetIds}, which additions and updates
 * then read, which the layout op then validates against. Naming that state is what lets each op
 * be a function instead of a labelled paragraph.
 *
 * Every field is mutated in place by the ops except {@link widgetRows}, which the layout op
 * REPLACES wholesale.
 */
interface BulkUpdateBatch {
  /** Per-op rejection messages, count-bounded by `truncateSkipped` at the end. */
  readonly skipped: string[];
  /** What actually landed — the numbers the tool reports back to the model. */
  readonly applied: {
    updated: number;
    added: number;
    removed: number;
    layout: boolean;
    colSpans: number;
  };
  /** The active page's rows as this batch has them so far. Replaced outright by a layout op. */
  widgetRows: string[][];
  /**
   * Every widget's span, seeded from the page. Shipped whole only when rows actually changed —
   * see the assembly step for why a spans-only batch must not send this.
   */
  readonly colSpans: Record<string, number>;
  /** Only the spans THIS batch accepted, for the spans-only payload. */
  readonly changedSpans: Record<string, number>;
  readonly removedWidgetIds: string[];
  readonly addedWidgets: StudioWidget[];
  readonly updatedWidgets: Array<{
    widgetId: string;
    title?: string;
    sourceId?: string;
    config?: StudioWidget['config'];
  }>;
  /** Ids that exist after each delta step, so later ops validate against the batch, not `state`. */
  readonly liveWidgetIds: Set<string>;
  /**
   * Title → minted id for widgets added this batch, so `layout`/`colSpans` can reference an
   * addition the model only knows by title (its id is server-minted).
   *
   * A `Map`, not a plain object: the key is a model-chosen `title`, and `"constructor"` /
   * `"__proto__"` would resolve an inherited value off a literal. `.get()` returns `undefined`
   * for an unmatched ref, so every `?? ref` fallthrough reaches the raw model string and skip
   * messages read back the exact ref. Both siblings below are `Map`s for the same reason.
   */
  readonly addedTitleToId: Map<string, string>;
  /** Kind of each widget added this batch, so the updates op can validate its config keys. */
  readonly addedWidgetKinds: Map<string, string>;
  /**
   * Running — NOT snapshot — chartType per widget. Seeded lazily from existing chart widgets and
   * eagerly from same-batch chart additions, then updated after each accepted chartType change,
   * so a later update in the SAME batch validates against the type an earlier one just set.
   * Without it, changing a chartType and setting a key valid only for the NEW type in one call
   * would be falsely rejected (and the reverse falsely accepted).
   */
  readonly currentChartTypes: Map<string, string | undefined>;
}

/** Read-only surroundings every bulk op needs. */
interface BulkUpdateContext {
  state: StudioState;
  activePageId: string;
  activePage: StudioPage;
  customWidgets?: StudioCustomWidgetDef[];
}

/**
 * Narrow and cap one of the three array-shaped op lists, recording its own rejection.
 *
 * Shape-validating BEFORE iterating is the point: a bare `as string[]` cast trusts the model
 * verbatim, so `widgetRemovals: "w1"` would `for…of` over CHARACTERS (removing widgets `"w"`,
 * `"1"`, …) and report success, while `{}` / `42` / `[null]` would throw a raw `TypeError`
 * instead of the schema-shaped errors this handler crafts.
 *
 * Over-cap TRUNCATES rather than rejecting, unlike the layout op: these lists are independent
 * entries, so applying the first `MAX_BULK_UPDATE_OPS` and naming the remainder is useful, where
 * a partial layout would orphan every widget past the cut.
 */
function collectBulkOps<T>(
  raw: unknown,
  spec: {
    name: string;
    isEntry: (value: unknown) => boolean;
    shapeHelp: string;
  },
  batch: BulkUpdateBatch,
): T[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || !raw.every(spec.isEntry)) {
    batch.skipped.push(`${spec.name}: ${spec.shapeHelp}`);
    return [];
  }
  if (raw.length > MAX_BULK_UPDATE_OPS) {
    batch.skipped.push(
      `${spec.name}: received ${raw.length} entries; only the first ` +
        `${MAX_BULK_UPDATE_OPS} were processed. Split the rest into a separate ` +
        'apply_bulk_update call.',
    );
    return raw.slice(0, MAX_BULK_UPDATE_OPS) as T[];
  }
  return raw as T[];
}

/** True for a plain (non-array, non-null) record — the shape both op-entry checks start from. */
function isOpRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Op 1 — removals.
 *
 * This handler only rewrites the ACTIVE page's `widgetRows`. Removing a widget that lives on
 * another page would delete it from `widgets` while leaving a dangling id in that page's rows
 * (a blank card), so only active-page widgets are removed and the rest are reported as skipped,
 * mirroring the not-found handling.
 */
function applyBulkRemovals(
  args: Record<string, unknown>,
  batch: BulkUpdateBatch,
  ctx: BulkUpdateContext,
): void {
  const activePageWidgetIds = new Set((ctx.activePage.widgetRows ?? []).flat());
  const removals = collectBulkOps<string>(
    args.widgetRemovals,
    {
      name: 'widgetRemovals',
      isEntry: (id) => typeof id === 'string',
      shapeHelp: 'must be an array of widget-ID strings (e.g. ["w1","w2"]).',
    },
    batch,
  );
  for (const wid of removals) {
    // Length-cap the id used in the ECHO only, never the one used for lookups: `skipped`
    // entries are count-bounded by `truncateSkipped` but each entry was itself unbounded, so a
    // batch of over-long ids echoed megabytes back into the conversation. A live id can never
    // exceed `MAX_ENTITY_ID_LENGTH` (every incoming id is `capEntityId`-capped), so a capped
    // label never hides a match. Every op below echoes on the same rule.
    const widLabel = capEntityId(wid);
    if (!batch.liveWidgetIds.has(wid)) {
      batch.skipped.push(`remove ${widLabel}: not found`);
      continue;
    }
    if (!activePageWidgetIds.has(wid)) {
      batch.skipped.push(`remove ${widLabel}: not on the active page`);
      continue;
    }
    batch.removedWidgetIds.push(wid);
    batch.liveWidgetIds.delete(wid);
    batch.widgetRows = batch.widgetRows
      .map((row) => row.filter((id) => id !== wid))
      .filter((row) => row.length > 0);
    batch.applied.removed += 1;
  }
}

/**
 * Op 2 — additions.
 *
 * Each accepted widget is appended as its own one-widget row; an explicit `layout` op later
 * replaces those placements, which is why that op insists every addition appears in it.
 */
function applyBulkAdditions(
  args: Record<string, unknown>,
  batch: BulkUpdateBatch,
  ctx: BulkUpdateContext,
): void {
  const additions = collectBulkOps<{
    kind: string;
    title: string;
    sourceId?: string;
    config?: Record<string, unknown>;
  }>(
    args.widgetAdditions,
    {
      name: 'widgetAdditions',
      isEntry: (a) => isOpRecord(a) && typeof a.kind === 'string' && typeof a.title === 'string',
      shapeHelp:
        'must be an array of objects each with a string `kind` and string `title` ' +
        '(e.g. [{ "kind": "chart", "title": "Revenue" }]).',
    },
    batch,
  );
  // Whether this batch carries a layout or colSpans op that resolves added-widget refs BY TITLE.
  // When it does, two additions with the SAME title are ambiguous: `addedTitleToId` is
  // last-write-wins, so the ref would resolve to only one of them and the other would land in
  // `doc.widgets` referenced by no page — an invisible orphan that still persists, serializes,
  // and survives undo, all reported as `applied.added` success. So when a title ref could be
  // consulted, the SECOND (and later) addition sharing a title is skipped with an actionable
  // message rather than silently orphaned.
  const batchHasTitleRefs =
    args.layout !== undefined ||
    (isOpRecord(args.colSpans) && Object.keys(args.colSpans).length > 0);

  for (const addition of additions) {
    const built = buildWidgetFromArgs(addition, ctx.customWidgets);
    if ('error' in built) {
      batch.skipped.push(`add "${capTitle(asString(addition.title))}": ${built.error}`);
      continue;
    }
    const { widget } = built;
    if (batchHasTitleRefs && batch.addedTitleToId.has(widget.title)) {
      batch.skipped.push(
        `add "${widget.title}": duplicate addition title is ambiguous for a layout or ` +
          'colSpans title reference; give each widget added in this batch a unique title.',
      );
      continue;
    }
    batch.addedWidgets.push(widget);
    batch.liveWidgetIds.add(widget.id);
    batch.addedTitleToId.set(widget.title, widget.id);
    batch.addedWidgetKinds.set(widget.id, widget.kind);
    if (isWidgetOfKind(widget, 'chart')) {
      batch.currentChartTypes.set(widget.id, widget.config.chartType);
    }
    batch.widgetRows.push([widget.id]);
    batch.applied.added += 1;
  }
}

/**
 * Op 3 — updates.
 *
 * Each update is emitted as a PARTIAL patch, never the merged widget snapshot: the reducer
 * merges it onto the live widget, so a concurrent edit to a different key on that widget
 * survives this turn.
 */
function applyBulkUpdates(
  args: Record<string, unknown>,
  batch: BulkUpdateBatch,
  ctx: BulkUpdateContext,
): void {
  const updates = collectBulkOps<{
    widgetId: string;
    title?: string;
    sourceId?: string;
    config?: Record<string, unknown>;
  }>(
    args.widgetUpdates,
    {
      name: 'widgetUpdates',
      isEntry: (u) => isOpRecord(u) && typeof u.widgetId === 'string',
      shapeHelp:
        'must be an array of objects each with a string `widgetId` ' +
        '(e.g. [{ "widgetId": "w1", "title": "New" }]).',
    },
    batch,
  );
  const resolveChartTypeForUpdate = (
    wid: string,
    existingWidget: StudioWidget | undefined,
  ): string | undefined => {
    if (batch.currentChartTypes.has(wid)) {
      return batch.currentChartTypes.get(wid);
    }
    const seed =
      existingWidget && isWidgetOfKind(existingWidget, 'chart')
        ? existingWidget.config.chartType
        : undefined;
    batch.currentChartTypes.set(wid, seed);
    return seed;
  };

  for (const update of updates) {
    const wid = asString(update.widgetId ?? '');
    const widLabel = capEntityId(wid);
    if (!batch.liveWidgetIds.has(wid)) {
      batch.skipped.push(`update ${widLabel}: not found`);
      continue;
    }
    // `widgetId` was shape-checked as a string above, but `title`/`sourceId` were not: a
    // `{"toString":1}` in either threw a raw `TypeError` out of the whole bulk call, discarding
    // every op the batch had already accepted. Report it as a `skipped` entry instead, matching
    // every other rejected op, so the rest of the batch still applies.
    const updateArgError = invalidStringArgsError(update as Record<string, unknown>, [
      'title',
      'sourceId',
    ]);
    if (updateArgError) {
      batch.skipped.push(`update ${widLabel}: ${updateArgError}`);
      continue;
    }
    // Cap every model-supplied string-typed config value BEFORE validation, so an oversized
    // `xField`/`yField`/… never lands in state.
    const configArg = update.config
      ? (capConfigStringValues(update.config) as Record<string, unknown>)
      : undefined;
    if (configArg) {
      const existingWidget = getWidget(ctx.state, wid);
      // `?? ''` is unreachable in practice (`liveWidgetIds` membership was checked above, and it
      // only ever holds existing or same-batch-added ids) but keeps the type honest now that the
      // lookup is a `Map`; an empty kind is treated as an unknown kind by
      // `validateConfigKeysForKind`, exactly as before.
      const kind = existingWidget?.kind ?? batch.addedWidgetKinds.get(wid) ?? '';
      const error = invalidConfigKeyError(kind, configArg);
      if (error) {
        batch.skipped.push(`update ${widLabel}: ${error}`);
        continue;
      }
      const valueError = invalidConfigValueError(configArg);
      if (valueError) {
        batch.skipped.push(`update ${widLabel}: ${valueError}`);
        continue;
      }
      if (kind === 'chart') {
        const existingChartType = resolveChartTypeForUpdate(wid, existingWidget);
        const chartError = invalidChartConfigKeyError(configArg, existingChartType);
        if (chartError) {
          batch.skipped.push(`update ${widLabel}: ${chartError}`);
          continue;
        }
        // Accepted: if this update sets a new chartType, record it so later same-batch updates
        // targeting this widget validate against it.
        if (Object.hasOwn(configArg, 'chartType')) {
          batch.currentChartTypes.set(wid, configArg.chartType as string | undefined);
        }
      }
    }
    batch.updatedWidgets.push({
      widgetId: wid,
      ...(update.title !== undefined ? { title: capTitle(asString(update.title)) } : {}),
      ...(update.sourceId !== undefined
        ? { sourceId: capSourceId(asString(update.sourceId)) }
        : {}),
      ...(configArg ? { config: configArg as StudioWidget['config'] } : {}),
    });
    batch.applied.updated += 1;
  }
}

/**
 * Op 4 — layout.
 *
 * Shares its predicate with `set_widget_layout` (see {@link findLayoutIdProblem}) and differs
 * only in policy: a problem here skips the layout op and lets the rest of the batch apply.
 */
function applyBulkLayout(
  args: Record<string, unknown>,
  batch: BulkUpdateBatch,
  ctx: BulkUpdateContext,
): void {
  if (args.layout === undefined) {
    return;
  }
  const parsed = parseLayoutRows(args.layout);
  if ('problem' in parsed) {
    batch.skipped.push(
      parsed.problem === 'shape'
        ? 'layout: must be an array of rows, where each row is an array of widget-ID ' +
            '(or added-widget-title) strings (e.g. [["w1","w2"],["w3"]]).'
        : `layout: received ${parsed.count} rows, more than the ${MAX_LAYOUT_ROWS} allowed. ` +
            'Layout not applied — send a layout with fewer rows.',
    );
    return;
  }
  // Resolve added-widget TITLE refs to the ids minted above, and drop rows the mapping emptied.
  // Both are bulk-only normalization, which is why they sit here rather than in the parser.
  const mappedRows = parsed.rows
    .map((row) => row.map((ref) => batch.addedTitleToId.get(ref) ?? ref))
    .filter((row) => row.length > 0);
  const problem = findLayoutIdProblem(mappedRows, {
    // "Exists" means live after THIS batch's removals and additions — none of which are in
    // `state` yet — not present in `state.doc.widgets`.
    isLive: (id) => batch.liveWidgetIds.has(id),
    state: ctx.state,
    activePageId: ctx.activePageId,
  });
  // An explicit layout op REPLACES the active page's rows wholesale (including the
  // one-widget-per-row entries the additions op pushed). So every widget added in this batch
  // MUST appear in it — an added-but-unplaced widget would land in `doc.widgets` referenced by
  // no page: an invisible orphan that still persists, serializes and survives undo, reported as
  // `applied.added` + `layout: true` success. Bulk-only, so it ranks after the shared problems.
  const layoutIdSet = new Set(mappedRows.flat());
  const unplacedAddedIds = batch.addedWidgets.map((w) => w.id).filter((id) => !layoutIdSet.has(id));

  if (problem?.kind === 'duplicate') {
    batch.skipped.push(
      `layout: duplicate widget IDs: ${joinIdsForError(problem.ids)}. ` +
        'Each widget must appear exactly once across all rows.',
    );
  } else if (problem?.kind === 'unknown') {
    batch.skipped.push(
      `layout: unknown or removed widget IDs: ${joinIdsForError(problem.ids)}. ` +
        'Reference only widgets that exist after this update (added-widget titles ' +
        'are resolved to their new IDs).',
    );
  } else if (problem?.kind === 'foreign-page') {
    batch.skipped.push(
      `layout: widget IDs that live on another page: ${joinIdsForError(problem.ids)}. ` +
        'A layout op only arranges the active page; switch to the page that contains ' +
        'them first.',
    );
  } else if (unplacedAddedIds.length > 0) {
    batch.skipped.push(
      `layout: widgets added in this batch are not placed in the layout: ${joinIdsForError(
        unplacedAddedIds,
      )}. A layout op replaces the active page, so every added widget must appear in ` +
        'it (reference an added widget by its title). Layout not applied.',
    );
  } else {
    batch.widgetRows = mappedRows;
    batch.applied.layout = true;
  }
}

/**
 * Op 5 — column spans, in the 24-column unit system the canvas renders (matching
 * `canvasGridConstants.GRID_COLS` = 24 / `MIN_SPAN` = 6 in `@mui/x-studio` and the
 * `setWidgetColSpan` reducer's clamp).
 *
 * An out-of-range or non-numeric span is REJECTED and reported, not clamped: this handler
 * reports `applied.colSpans` as a per-op COUNT rather than the per-widget applied value (unlike
 * `set_widget_width`, which echoes the reducer-clamped value for its one widget), so clamping
 * would leave the model no way to learn which width it actually got.
 *
 * MEMBERSHIP is enforced as well as range. The reducer writes spans to the ACTIVE page only and
 * `enforceLayoutColSpans` prunes any span whose widget is not in that page's post-batch rows, so
 * a span keyed to a phantom widget, one on another page, or one removed earlier in this batch is
 * silently discarded on apply — counting it would overstate what landed. `batch.widgetRows`
 * already reflects this batch's removals, additions and layout, so it is the authoritative set.
 */
function applyBulkColSpans(
  args: Record<string, unknown>,
  batch: BulkUpdateBatch,
  _ctx: BulkUpdateContext,
): void {
  const activePageWidgetIdsAfterBatch = new Set(batch.widgetRows.flat());
  const colSpanPatch = (args.colSpans as Record<string, unknown> | undefined) ?? {};
  let colSpanEntries = Object.entries(colSpanPatch);
  if (colSpanEntries.length > MAX_BULK_UPDATE_OPS) {
    batch.skipped.push(
      `colSpans: received ${colSpanEntries.length} entries; only the first ` +
        `${MAX_BULK_UPDATE_OPS} were processed. Split the rest into a separate ` +
        'apply_bulk_update call.',
    );
    colSpanEntries = colSpanEntries.slice(0, MAX_BULK_UPDATE_OPS);
  }
  for (const [ref, span] of colSpanEntries) {
    // Resolve added-widget TITLE refs to their minted ids, mirroring the layout op: a widget
    // added earlier in this same batch is known to the model only by title, so keying strictly
    // by id would silently drop a same-batch add-then-resize.
    const wid = batch.addedTitleToId.get(ref) ?? ref;
    // `ref` is a raw model-supplied object KEY, so it is unbounded in length — echo-capped.
    const refLabel = capEntityId(ref);
    if (!batch.liveWidgetIds.has(wid)) {
      batch.skipped.push(`colSpan ${refLabel}: widget not found.`);
      continue;
    }
    if (!activePageWidgetIdsAfterBatch.has(wid)) {
      batch.skipped.push(`colSpan ${refLabel}: not on the active page.`);
      continue;
    }
    if (typeof span === 'number' && span >= 6 && span <= 24) {
      batch.colSpans[wid] = span;
      batch.changedSpans[wid] = span;
      batch.applied.colSpans += 1;
    } else {
      batch.skipped.push(
        `colSpan ${refLabel}: ${describeArgValue(span)} is out of range (must be a number 6-24).`,
      );
    }
  }
}

/**
 * Which layout fields the emitted mutation carries — the one piece of this handler that is a
 * decision rather than an op.
 *
 * `widgetRows`/`widgetColSpans` are a plan-time snapshot of the active page's layout. Attaching
 * them unconditionally means a batch containing only `widgetUpdates` still ships that stale
 * snapshot, silently reverting a concurrent client-side layout edit (a drag-reorder) made while
 * this turn was running. So they are attached only when this batch actually changed layout —
 * keyed off `applied`, since a requested op that was skipped never touched either.
 *
 * Two change shapes attach DIFFERENT fields:
 *
 * - A removal / addition / explicit `layout` op genuinely re-places rows, so the full snapshot
 *   IS the intended new placement and ships alongside `widgetColSpans`.
 * - A colSpans-ONLY batch changes widths and never row placement. Shipping `widgetRows` would
 *   revert a concurrent drag-reorder — the same lost-update class, one case narrower — so it
 *   sends only the spans this batch CHANGED, relying on the reducer to reconcile a spans-only
 *   payload against the page's existing rows instead of wiping them.
 *
 * The reducer treats true absence of both fields as "layout unchanged" and skips its
 * layout-replacement block, so an updates-only or all-skipped batch leaves the client alone.
 */
function bulkLayoutFields(batch: BulkUpdateBatch): Record<string, unknown> {
  const rowsChanged = batch.applied.removed > 0 || batch.applied.added > 0 || batch.applied.layout;
  if (rowsChanged) {
    return { widgetRows: batch.widgetRows, widgetColSpans: batch.colSpans };
  }
  if (batch.applied.colSpans > 0) {
    return { widgetColSpans: batch.changedSpans };
  }
  return {};
}

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
      // See `invalidStringArgsError`. Without this an unusable `title`
      // object silently became `''`, committing an untitled page (and the default
      // `'New Page'` would NOT apply, since the argument is present).
      const argError = invalidStringArgsError(args, ['title']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const title = capTitle(asString(args.title ?? 'New Page'));
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
      // `set_dashboard_title({ title: { "toString": 1 } })` used to throw
      // a raw `TypeError` out of this "never throws by design" function.
      const argError = invalidStringArgsError(args, ['title']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const title = capTitle(asString(args.title ?? ''));
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
      // Every argument this handler reads as a string, checked in one
      // pass so a model that mis-shapes two of them fixes both in one retry.
      const argError = invalidStringArgsError(args, ['widgetId', 'title', 'sourceId']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const widgetId = asString(args.widgetId ?? '');
      const widget = getWidget(state, widgetId);
      if (!widget) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }

      // Treat `config: null` as absent: JSON `null` is not `undefined`, so it would slip past an
      // `!== undefined` gate straight into the config-key validators, whose `Object.keys(null)` /
      // `Object.hasOwn(null, …)` throw a raw `TypeError: Cannot convert undefined or null to
      // object` — surfaced to the model as an opaque, unactionable error. Every sibling path
      // already tolerates a nullish config (`buildWidgetFromArgs` uses `?? {}`; the bulk loop gates
      // on truthiness; the reducer treats a non-record config as absent), so normalize to
      // `undefined` here. Cap every model-supplied string-typed config value BEFORE validation, so
      // an oversized `xField`/`yField`/… never lands in state.
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
        changes.title = capTitle(asString(args.title));
      }
      if (args.sourceId !== undefined) {
        changes.sourceId = capSourceId(asString(args.sourceId));
      }

      // Local MERGE of the incoming patch onto the widget's CURRENT config. Used ONLY
      // for the `unsetConfigKeys` presence filter below (which must test keys against the
      // post-merge config) — the mutation itself carries the RAW patch (`configPatch`),
      // never this merged snapshot. Shipping the whole merged config would re-assert
      // every pre-existing key at its turn-start value, silently reverting a concurrent
      // client edit to a DIFFERENT config key — the same lost-update class already fixed
      // for `apply_bulk_update` and `set_widget_forecast`. The reducer
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
      // See `invalidStringArgsError`.
      const argError = invalidStringArgsError(args, ['widgetId']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const widgetId = asString(args.widgetId ?? '');
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
    plan: (args, { state, privateMode }) => {
      const parsed = parseLayoutRows(args.rows);
      if ('problem' in parsed) {
        return {
          output: JSON.stringify({
            error:
              parsed.problem === 'shape'
                ? 'set_widget_layout requires "rows" to be an array of rows, where each row is ' +
                  'an array of widget-ID strings (e.g. [["w1","w2"],["w3"]]).'
                : `set_widget_layout received ${parsed.count} rows, more than the ` +
                  `${MAX_LAYOUT_ROWS} allowed. Send a layout with fewer rows.`,
          }),
          nextState: state,
        };
      }
      const { rows } = parsed;
      const activePageId = state.doc.dashboard.activePageId;
      if (!getPage(state, activePageId)) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      const problem = findLayoutIdProblem(rows, {
        // Widgets added earlier this turn are already threaded into `state.doc.widgets`.
        isLive: (id) => hasOwnEntity(state.doc.widgets, id),
        state,
        activePageId,
      });
      if (problem) {
        return {
          output: JSON.stringify({ error: layoutProblemMessage(problem, privateMode) }),
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
    plan: (args, { state, privateMode }) => {
      const { widgetId, columns } = args as { widgetId: string; columns: unknown };
      if (typeof widgetId !== 'string') {
        return {
          output: JSON.stringify({ error: 'set_widget_width requires a "widgetId" string.' }),
          nextState: state,
        };
      }
      // Coerce/validate `columns` at the write source, mirroring
      // `set_widget_forecast.periods`. `null` is the documented reset (clears the span).
      // The tool schema declares a number, but the value is untrusted: a string like
      // "12" would survive the bare cast and reach the reducer's `clampSpan`, which
      // treats any non-finite input as `MIN_SPAN` (6) — silently committing the minimum
      // width and reporting `{ success: true, columns: 6 }`, contradicting the request.
      // Fail closed on a non-numeric value with an actionable error naming the 6–24 range.
      let normalizedColumns: number | null = null;
      if (columns != null) {
        const n = asNumber(columns);
        if (!Number.isFinite(n)) {
          return {
            output: JSON.stringify({
              error: `set_widget_width 'columns' must be a number between 6 and 24 (or null to reset); received ${describeArgValue(columns)}.`,
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
      // Row-membership check. `setWidgetColSpan` silently no-ops unless the widget is in a row
      // on the target page: a span written for a widget that is elsewhere would land on the
      // wrong page, and one written for a widget on NO page is an orphan that both the
      // reducer's own enforcement pass and the load boundary delete — so it would appear to
      // work and silently revert on reload. Either way the tool would otherwise read back
      // `null` and report `{ success: true, columns: null }`, telling the model a width took
      // effect that never did. Both cases are reported as errors, with the remediation that
      // actually applies to each — EXCEPT in private mode, where telling the
      // two apart is precisely the disclosure: "on another page" vs "on no page at all"
      // is dashboard structure this mode withholds from the prompt and from every
      // `privateModeExcluded` read tool, and it turns this still-advertised write tool
      // into a probe. One combined message covers both remediations without ever
      // revealing which applies.
      const currentRow = activePage.widgetRows?.find((row) => row.includes(widgetId));
      if (currentRow === undefined) {
        const onAnotherPage = Object.values(state.doc.pages).some((page) =>
          (page.widgetRows ?? []).some((row) => row.includes(widgetId)),
        );
        let notPlacedError: string;
        if (privateMode) {
          notPlacedError =
            `Widget ${widgetId} is not in a row on the active page, so its width cannot be ` +
            'set here. Call set_active_page for the page that holds it, or place it on the ' +
            'active page with set_widget_layout, then set its width.';
        } else if (onAnotherPage) {
          notPlacedError =
            `Widget ${widgetId} is not on the active page, so its width cannot be set here. ` +
            'Call set_active_page for the page that contains it first.';
        } else {
          notPlacedError =
            `Widget ${widgetId} is not placed on any page, so a width set for it would be ` +
            'discarded when the dashboard is saved. Place it with set_widget_layout first, ' +
            'then set its width.';
        }
        return {
          output: JSON.stringify({ error: notPlacedError }),
          nextState: state,
        };
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
      const appliedColumns = getWidgetColSpan(getPage(nextState, activePageId), widgetId);
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
      // See `invalidStringArgsError`.
      const argError = invalidStringArgsError(args, ['pageId', 'title']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const pageId = asString(args.pageId ?? '');
      const title = capTitle(asString(args.title ?? ''));
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
      // See `invalidStringArgsError`.
      const argError = invalidStringArgsError(args, ['pageId']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const pageId = asString(args.pageId ?? '');
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
      // See `invalidStringArgsError`.
      const argError = invalidStringArgsError(args, ['pageId']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const pageId = asString(args.pageId ?? '');
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
      // `field`/`sourceId`/`operator` are read as strings. `value` is NOT
      // in this list: a filter value is legitimately an object or array (an `in` list, a
      // range), and `capFilterValue` handles every shape without coercing to a primitive.
      const argError = invalidStringArgsError(args, ['field', 'sourceId', 'operator']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const field = capString(asString(args.field ?? ''), MAX_FILTER_STRING_LENGTH);
      const sourceId = capString(asString(args.sourceId ?? ''), MAX_FILTER_STRING_LENGTH);
      const operatorRaw = asString(args.operator ?? 'equals');
      const operatorError = invalidFilterOperatorError(operatorRaw);
      if (operatorError) {
        return { output: JSON.stringify({ error: operatorError }), nextState: state };
      }
      const operator = operatorRaw as StudioFilterOperator;
      const value = capFilterValue(args.value);
      // Validate `fieldType` against the exhaustive schema-derived set,
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
      // Same set as `add_page_filter`, plus the target `widgetId`.
      const argError = invalidStringArgsError(args, ['widgetId', 'field', 'sourceId', 'operator']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const widgetId = asString(args.widgetId ?? '');
      // Match every other entity-targeting tool: validate the widget exists before
      // committing a widget-scoped filter, so a fabricated/stale widgetId returns an
      // actionable error instead of silently committing a dangling no-op filter.
      if (!getWidget(state, widgetId)) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }
      const field = capString(asString(args.field ?? ''), MAX_FILTER_STRING_LENGTH);
      const sourceId = capString(asString(args.sourceId ?? ''), MAX_FILTER_STRING_LENGTH);
      const operatorRaw = asString(args.operator ?? 'equals');
      const operatorError = invalidFilterOperatorError(operatorRaw);
      if (operatorError) {
        return { output: JSON.stringify({ error: operatorError }), nextState: state };
      }
      const operator = operatorRaw as StudioFilterOperator;
      const value = capFilterValue(args.value);
      // Validate `fieldType`, same as `add_page_filter`.
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
      // return page A's snapshot narrated as page B. The snapshot cannot
      // be rebuilt for another page within the turn — that needs a fresh request — so we
      // do NOT tell the model to call `set_active_page`. Fall back to the threaded active
      // page only for legacy callers that don't thread `snapshotPageId`.
      //
      // The error states the contract — on this transport `summarise_page` covers the
      // SNAPSHOT'S page and nothing else — and names the one action that can succeed in
      // this turn. It deliberately does not read as "retry": there is no argument, and
      // no other tool call, that makes another page's rows available before the next
      // request, so any retry is a wasted turn. Every id it echoes is model- or
      // client-supplied and unbounded, so all of them are length-capped like every
      // other id this file echoes back.
      //
      // The guard covers the OMITTED-`pageId` form too, not just the
      // explicit one. It previously fired only `if (requestedPageId)`, so a model
      // following the advertised advice — `set_active_page(pageB)` then
      // `summarise_page()` with no `pageId` — fell straight through to the
      // `pageSnapshot` return and got page A's snapshot, which it then narrated as
      // page B: exactly the wrong-page attribution the `snapshotPageId` comparison
      // exists to prevent, just reached by the argument-less path. With no `pageId`
      // the page the model MEANS is the threaded active page, so that is what is
      // compared. (When no `snapshotPageId` was threaded — legacy callers —
      // `coveredPageId` IS the threaded active page, so this can never fire.)
      // See `invalidStringArgsError`.
      const argError = invalidStringArgsError(args, ['pageId']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const requestedPageId = args.pageId ? capEntityId(asString(args.pageId)) : undefined;
      const coveredPageId = capEntityId(
        asString(snapshotPageId ?? state.doc.dashboard.activePageId),
      );
      const targetPageId =
        requestedPageId ?? capEntityId(asString(state.doc.dashboard.activePageId));
      if (targetPageId !== coveredPageId) {
        // The two forms differ only in the ONE action that can still succeed: an
        // explicit `pageId` can be dropped, while an omitted one cannot be "dropped"
        // any further — there the mismatch came from making another page active
        // mid-turn, so the model must be told that doing so did not (and cannot)
        // bring that page's rows with it. Neither form names a tool to call: the
        // guidance must not read as "retry", because no argument and no tool call can
        // make another page's rows available before the next request.
        const remedy = requestedPageId
          ? `Omit "pageId" to summarise page "${coveredPageId}", and ask the user to open page ` +
            `"${targetPageId}" if they want that one summarised.`
          : `Making page "${targetPageId}" active during this turn did not bring its rows with ` +
            `it — the snapshot was already fixed when the request arrived. Summarise page ` +
            `"${coveredPageId}" instead, and ask the user to open page "${targetPageId}" if they ` +
            'want that one summarised.';
        return {
          output: JSON.stringify({
            error:
              `summarise_page can only summarise page "${coveredPageId}" in this conversation ` +
              'turn. The row data it reads is a snapshot captured once per request, for the page ' +
              `that was active when the request arrived; page "${targetPageId}" has no rows ` +
              `available here and no tool call can load them. ${remedy}`,
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
      // No snapshot available — explain the limitation so the model can degrade
      // gracefully. Like the guard above, this names no discovery tool: this branch is
      // reached only when a host advertised `summarise_page` through `allowedTools`
      // without a snapshot, and the same `allowedTools` may well have excluded
      // `get_dashboard_state`, in which case following that advice costs a turn on an
      // `Unknown tool` error. Answer from the dashboard structure already in context.
      return {
        output: JSON.stringify({
          error:
            'summarise_page requires live row data, which is only available client-side and was ' +
            'not sent with this request. No tool call can load it here. Answer from the ' +
            'dashboard structure you already have, and say that the underlying figures were not ' +
            'available.',
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

      const batch: BulkUpdateBatch = {
        skipped: [],
        applied: { updated: 0, added: 0, removed: 0, layout: false, colSpans: 0 },
        widgetRows: (activePage.widgetRows ?? []).map((row) => [...row]),
        // `Object.assign(Object.create(null), …)`, not a `{ … }` spread: both span maps are
        // keyed by a MODEL-supplied widget id (or an id that came in on the request body —
        // `state.doc.widgets` is client JSON), and `colSpans['__proto__'] = 12` on a normal
        // object literal is silently discarded (assigning a primitive to `__proto__` is a
        // no-op) while `applied.colSpans += 1` still counts it. That is a dropped mutation
        // reported as `{ success: true }` — the exact executor/reducer desync class the
        // `Object.hasOwn` id hardening exists to prevent, on the write side. A null-prototype
        // map has no `__proto__` accessor, so every key lands as an ordinary own property and
        // ships in the mutation.
        colSpans: Object.assign(Object.create(null), activePage.widgetColSpans ?? {}),
        changedSpans: Object.create(null),
        // The mutation carries only DELTAS (remove/add/update), applied by the reducer against
        // the receiver's CURRENT `state.doc.widgets` — never a snapshot of the whole `widgets`
        // record. This is the lost-update fix: a widget the user edits on any page while this
        // agentic turn is running is no longer reverted, because only the ids named here are
        // touched.
        removedWidgetIds: [],
        addedWidgets: [],
        updatedWidgets: [],
        liveWidgetIds: new Set(Object.keys(state.doc.widgets)),
        addedTitleToId: new Map(),
        addedWidgetKinds: new Map(),
        currentChartTypes: new Map(),
      };
      const ctx: BulkUpdateContext = { state, activePageId, activePage, customWidgets };

      // ORDER IS LOAD-BEARING, and it is the whole reason this is one tool rather than five.
      // Removals shrink `liveWidgetIds` and `widgetRows`; additions extend both and mint the
      // ids that `layout`/`colSpans` resolve titles to; updates validate against the widgets
      // that survive both; layout replaces the rows those three produced; colSpans is checked
      // against the rows layout left behind.
      applyBulkRemovals(args, batch, ctx);
      applyBulkAdditions(args, batch, ctx);
      applyBulkUpdates(args, batch, ctx);
      applyBulkLayout(args, batch, ctx);
      applyBulkColSpans(args, batch, ctx);

      const mutation: StateMutation = {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: batch.removedWidgetIds,
          addedWidgets: batch.addedWidgets,
          updatedWidgets: batch.updatedWidgets,
          ...bulkLayoutFields(batch),
          activePageId,
        },
      } as StateMutation;
      return {
        output: JSON.stringify({
          success: true,
          applied: batch.applied,
          ...(batch.skipped.length > 0 ? { skipped: truncateSkipped(batch.skipped) } : {}),
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
      // would commit an empty thread title.
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return {
          output: JSON.stringify({ error: 'rename_thread requires a non-empty name string.' }),
          nextState: state,
        };
      }
      const trimmed = name.trim().slice(0, MAX_GENERATED_TITLE_LENGTH);
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
    plan: (args, { state, privateMode }) => {
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
      // In private mode, say WHAT is required, never what the target
      // currently is. `widget.kind` and `chartType` are exactly the widget config the
      // mode withholds from `<dashboard_state>` and from every `privateModeExcluded`
      // read tool, and this string is re-sent to the provider on every remaining turn.
      // Outside private mode the concrete value is kept: it is the single most useful
      // thing the model can be told here, and there is nothing to withhold.
      if (!isWidgetOfKind(widget, 'chart')) {
        return {
          output: JSON.stringify({
            error: privateMode
              ? `set_widget_forecast only supports chart widgets whose chartType is 'line' or 'area'. ` +
                `Widget '${widgetId}' does not qualify. Use a line or area chart widget, or change ` +
                'this widget with set_widget_config before adding a forecast.'
              : `set_widget_forecast only supports chartType 'line' or 'area'. Widget '${widgetId}' has kind '${widget.kind}'.`,
          }),
          nextState: state,
        };
      }
      const { chartType } = widget.config;
      if (chartType !== 'line' && chartType !== 'area') {
        return {
          output: JSON.stringify({
            error: privateMode
              ? `set_widget_forecast only supports chart widgets whose chartType is 'line' or 'area'. ` +
                `Widget '${widgetId}' does not qualify. Use a line or area chart widget, or change ` +
                'this widget with set_widget_config before adding a forecast.'
              : `set_widget_forecast only supports chartType 'line' or 'area'. Widget '${widgetId}' has chartType '${chartType ?? '(none)'}'.`,
          }),
          nextState: state,
        };
      }

      // Coerce/validate `periods` as a number at the write source. The
      // tool schema declares it a number, but the value is untrusted and unvalidated —
      // a crafted string here both produces a structurally-broken forecast config and
      // (before the prompt-side sanitize fix) was echoed into `<dashboard_state>`
      // verbatim. Fail closed with an actionable error on a non-numeric
      // value so the model can retry, rather than storing the raw string.
      let periodsNum: number | undefined;
      if (periods != null) {
        const n = asNumber(periods);
        if (!Number.isFinite(n) || n <= 0) {
          return {
            output: JSON.stringify({
              error: `set_widget_forecast 'periods' must be a positive number; received ${describeArgValue(periods)}.`,
            }),
            nextState: state,
          };
        }
        periodsNum = Math.floor(n);
      }

      // Strictly validate `enabled`/`showConfidenceBands` as ACTUAL booleans at the write source
      // (finding-3.2 value-shape class). The tool schema declares both boolean (and marks `enabled`
      // required), but the args are untrusted and unvalidated: relying on JS truthiness means a
      // classic string-boolean slip like `enabled: "false"` (truthy!) would ENABLE a forecast a
      // call meant to DISABLE — while reporting `success` — and a `showConfidenceBands: "no"` would
      // persist a string in a `boolean`-typed config field. Fail closed with an actionable error —
      // mirroring the `periods` coercion above and the shared `invalidConfigValueError` boolean
      // check — rather than silently coercing the dangerous `"false"` → `true` direction.
      if (typeof enabled !== 'boolean') {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast 'enabled' must be a boolean (true or false); received ${describeArgValue(enabled)}.`,
          }),
          nextState: state,
        };
      }
      if (showConfidenceBands != null && typeof showConfidenceBands !== 'boolean') {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast 'showConfidenceBands' must be a boolean (true or false); received ${describeArgValue(showConfidenceBands)}.`,
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
  privateMode?: boolean,
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
    return impl.plan(args, { state, customWidgets, pageSnapshot, snapshotPageId, privateMode });
  }

  return { output: JSON.stringify({ error: `Unknown tool: ${toolName}` }), nextState: state };
}
