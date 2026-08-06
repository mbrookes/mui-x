/**
 * Shared state-mutation / skill protocol types for MUI X Studio.
 *
 * These are the types both the client (`@mui/x-studio`) and the server
 * (`@mui/x-studio-ai-middleware`) need to agree on to produce/apply state
 * mutations streamed over SSE:
 *  - Accept skill configuration from app developers (`SerializableSkill`)
 *  - Produce/apply state mutations streamed over SSE (`StateMutation`)
 *
 * Server-only AI types (`StudioAISkill` with its `execute` function,
 * `SkillExecuteResult`, `StudioAIDataConfig`, rate-limit/usage types) live in
 * `@mui/x-studio-ai-middleware` — they are not part of the shared schema.
 */
import type { StudioFilterState, StudioDateRangePreset } from './stateTypes';
import type { StudioCrossFilterMode } from './baseTypes';
import type { StudioRelationship, StudioDataField } from './dataTypes';
import type { StudioWidget, StudioPage } from './widgetTypes';
import type { StudioExpressionField } from './expressionTypes';

/**
 * Serializable skill metadata forwarded to the server in every AI request.
 * The `execute` function (if any) is stripped before sending — only these
 * fields are sent over the wire.
 *
 * `StudioAISkill` (from `@mui/x-studio-ai-middleware`) extends this interface
 * by adding the server-side `execute` function. App developers can pass
 * `StudioAISkill` objects directly to `StudioAIConfig.skills` since it
 * structurally satisfies this interface.
 */
export interface SerializableSkill {
  name: string;
  mode: 'instruction-only' | 'server-tool' | 'client-handler';
  promptFragment: string;
  tool?: {
    name: string;
    description: string;
    parameters: object;
  };
}

/**
 * The widget fields that may legitimately be voided via `updateWidget.unsetFields`:
 * exactly the OPTIONAL keys of `StudioWidget`. The required keys (`id`, `kind`,
 * `title`, `config`) are excluded structurally, so a wire caller cannot type a
 * payload that strands a widget without one — and the reducer's runtime denylist
 * backstops the same set for untrusted (un-type-checked) input. Derived, so it stays
 * correct as `StudioWidget` gains or loses optional fields.
 */
export type OptionalWidgetField = {
  [K in keyof StudioWidget]-?: undefined extends StudioWidget[K] ? K : never;
}[keyof StudioWidget];

/**
 * The mutations acceptable from OUTSIDE this process — produced server-side and streamed to the
 * client as an SSE event, or issued by an AI tool call. Both sides apply them through the shared
 * `applyMutation` reducer.
 *
 * THIS UNION IS THE UNTRUSTED WIRE SURFACE. `parseStateMutation`'s validator table is a mapped
 * type over exactly this union, so a variant added here becomes something a hostile or buggy
 * server can make the client apply. Adding one is a security decision and should be argued as
 * such.
 *
 * It is deliberately SEPARATE from {@link InternalStateMutation}, which the client may issue but
 * the wire may not carry. Before the split there was one union, so the two questions — "should
 * the reducer own this write?" and "should a remote party be able to perform it?" — had a single
 * answer, and the second one (correctly cautious) suppressed the first. The result was 25
 * controller writers committing through `commitDocPatch` outside every invariant the reducer
 * upholds, which is what the `dependsOn` cascade, the filter-scope screen and the rank-conflict
 * resolution each had to be re-implemented for, by hand, at each bypass site.
 */
export type WireStateMutation =
  | { type: 'addPage'; args: { id: string; title: string } }
  | { type: 'setDashboardTitle'; args: { title: string } }
  | {
      type: 'addWidget';
      args: {
        widget: StudioWidget;
        /**
         * Explicit target page for the new widget, chosen server-side.
         * Both the server-computed `nextState` and the client apply the widget
         * to this page, so switching pages while the model is thinking cannot
         * make the widget land on a different page than the model was told.
         * Falls back to the active page when omitted (legacy payloads).
         */
        pageId?: string;
      };
    }
  | {
      type: 'updateWidget';
      args: {
        widgetId: string;
        changes?: Partial<Omit<StudioWidget, 'id'>>;
        config?: StudioWidget['config'];
        /**
         * Optional top-level widget keys to DELETE from the widget — the wire-safe way
         * to void a field. Unlike a `changes` entry with an `undefined` value (which
         * `JSON.stringify` silently drops, so it can never survive the SSE stream
         * or an AI tool-call argument), a KEY NAME survives JSON intact. The
         * reducer skips `undefined`-valued `changes` keys precisely so an untrusted
         * wire caller cannot void a required field the old (unsafe) way; these
         * arrays are the ONLY sanctioned clear affordance, in-process or over the
         * wire. Only OPTIONAL fields are unsettable (`OptionalWidgetField`): the
         * required `id`/`kind`/`title`/`config` are excluded so a widget can never be
         * left without a field its rendering or the widget factory depends on.
         * Applied AFTER the `config` patch and `changes` merge, so an explicit unset
         * always wins over a same-turn set of the same key.
         */
        unsetFields?: OptionalWidgetField[];
        /**
         * Config keys to DELETE from the merged config — the wire-safe equivalent
         * of a `config`-patch entry with an `undefined` value. Applied AFTER the
         * `config` patch and `changes` merge (which may replace `config` wholesale).
         */
        unsetConfigKeys?: string[];
      };
    }
  | { type: 'removeWidget'; args: { widgetId: string } }
  | {
      type: 'setWidgetLayout';
      args: {
        rows: string[][];
        /**
         * Explicit target page whose rows are replaced, chosen server-side.
         * Mirrors `addWidget.pageId`: if the user navigates to another page while
         * the model is thinking, the layout still lands on the page the model was
         * reasoning about rather than overwriting whatever page is now active.
         * Falls back to the active page when omitted (legacy payloads).
         */
        pageId?: string;
      };
    }
  | {
      type: 'setWidgetColSpan';
      args: {
        widgetId: string;
        columns: number | null;
        /** Validated at the wire boundary but not read by the reducer — see the
         *  `setWidgetColSpan` handler in `applyMutation.ts` for why. */
        rowWidgetIds: string[];
        /**
         * Explicit target page for the span change, chosen server-side. Mirrors
         * `addWidget.pageId` — the span is written to this page's `widgetColSpans`
         * regardless of which page happens to be active on the applying side.
         * Falls back to the active page when omitted (legacy payloads).
         */
        pageId?: string;
      };
    }
  | { type: 'renamePage'; args: { pageId: string; title: string } }
  | { type: 'removePage'; args: { pageId: string } }
  | { type: 'setActivePage'; args: { pageId: string } }
  | { type: 'addFilter'; args: { filter: StudioFilterState } }
  | { type: 'removeFilter'; args: { filterId: string } }
  /**
   * Lost-update-safe delta shape. Rather than carrying a snapshot of the
   * ENTIRE `widgets` record (which wholesale-replaced `state.widgets` and
   * silently reverted any widget the user edited on ANY page between the
   * agentic turn's start snapshot and this mutation applying), this mutation
   * carries only the specific widgets to remove/add/update. The reducer
   * applies these deltas on top of the receiver's CURRENT `state.widgets`, so
   * widgets not named here — including ones concurrently edited while the turn
   * was running — are preserved, and a delete only drops the named ids
   * (which the producer restricts to widgets on `activePageId`).
   *
   * `widgetRows`/`widgetColSpans` still replace the layout of `activePageId`
   * only (never any other page), matching `setWidgetLayout`'s per-page scope.
   */
  | {
      type: 'applyBulkUpdate';
      args: {
        /** Widget IDs to delete. Producer only lists ids that live on `activePageId`. */
        removedWidgetIds: string[];
        /** Fully-built new widget objects to insert. */
        addedWidgets: StudioWidget[];
        /**
         * Partial patches to existing widgets, applied against the CURRENT widget.
         * `config` is a shallow-merge patch (merged onto the live widget's config),
         * so a concurrent edit to a different config key survives.
         */
        updatedWidgets: Array<{
          widgetId: string;
          title?: string;
          sourceId?: string;
          config?: StudioWidget['config'];
        }>;
        /**
         * Active-page layout snapshot. OPTIONAL: both the wire validator
         * (`parseStateMutation`) and the reducer (`applyMutation`) treat these as
         * protocol-optional — a bulk carrying only `updatedWidgets` (no removals,
         * additions, or layout change) omits BOTH, and the reducer then SKIPS layout
         * replacement rather than wiping the page. Typing them as required forced such a
         * sanctioned updates-only producer to attach a layout snapshot (or cast), which
         * re-opened the lost-update class this delta shape exists to close. Absent ⇒ layout
         * untouched; present ⇒ replaces `activePageId`'s layout only.
         */
        widgetRows?: string[][];
        widgetColSpans?: Record<string, number>;
        activePageId: string;
      };
    }
  | {
      type: 'renameAIThread';
      args: {
        name: string;
        /**
         * ISO 8601 timestamp stamped once by the producer (server-side), so the
         * server-computed `nextState` and the client-applied result agree. The
         * reducer must never call `Date.now()`/`new Date()` itself — that would
         * make this otherwise-pure reducer non-deterministic. Required: the sole
         * producer (`executeToolOnState`'s `rename_thread` handler) always supplies it.
         */
        updatedAt: string;
        /**
         * Explicit target thread, stamped from the originating request's thread
         * context (server-side). The reducer renames `threads.find(t => t.id ===
         * threadId)` rather than whatever thread happens to be active on the
         * applying side — so a rename cannot land on the wrong thread when the user
         * switches threads while the model is running. Falls back to the active
         * thread when omitted (legacy payloads).
         */
        threadId?: string;
      };
    };

/**
 * Mutations the CLIENT may issue but the WIRE may not carry.
 *
 * Every write that belongs in the reducer — so it inherits the `dependsOn` cascade, filter-scope
 * screening, rank-conflict resolution, the reference-equality no-op contract and the id-coercion
 * rules — but which no remote party has any business performing. `parseStateMutation` cannot
 * produce one: its validator table is keyed on {@link WireStateMutation}, so a payload naming one
 * of these types is rejected as unknown, fail-closed, with no entry to add and no decision to
 * remember.
 *
 * That separation is the point. These exist so "the reducer should own this write" can be
 * answered YES without also answering yes to "a remote party may perform this write" — the
 * coupling that previously kept 25 controller writers out of the reducer entirely.
 */
export type InternalStateMutation =
  /** Drop every filter scoped to a page. Cascades `dependsOn` against the survivors. */
  | { type: 'clearPageFilters'; args: { pageId: string } }
  /** Drop the cross-filter contributed by one widget. */
  | { type: 'clearCrossFilter'; args: { sourceWidgetId: string } }
  /** Drop every cross-filter on the document. */
  | { type: 'clearAllCrossFilters'; args: Record<string, never> }
  /** Drop the interactive selection contributed by one filter widget. */
  | { type: 'clearInteractiveFilter'; args: { sourceWidgetId: string } }
  /** Flip one filter's `disabled` flag. */
  | { type: 'toggleFilter'; args: { filterId: string } }
  /** Merge a partial into one filter, re-screening its scope. */
  | {
      type: 'updateFilter';
      args: { filterId: string; changes: Partial<StudioFilterState> };
    }
  /*
   * Relationships and expression fields.
   *
   * The controller keeps the SCREENING for these — duplicate ids, unknown ids, value-equal
   * no-ops, expression cycles — because each answers its caller with a reason the reducer's
   * "returns the same doc when it declines" contract cannot express. What moves here is the
   * WRITE, so a doc edit is a doc edit however it was reached.
   */
  | { type: 'addRelationship'; args: { relationship: StudioRelationship } }
  | {
      type: 'updateRelationship';
      args: { relationshipId: string; patch: Partial<StudioRelationship> };
    }
  | { type: 'removeRelationship'; args: { relationshipId: string } }
  | { type: 'addExpressionField'; args: { field: StudioExpressionField } }
  | {
      type: 'updateExpressionField';
      args: { fieldId: string; updates: Partial<Omit<StudioExpressionField, 'id'>> };
    }
  | { type: 'removeExpressionField'; args: { fieldId: string } }
  /*
   * Filter presets and managed date-range filters.
   *
   * The transforms behind these already existed as pure `StudioDoc -> StudioDoc` functions in
   * `docTransforms.ts` — a SECOND pure-transform layer running alongside the reducer, with the
   * same signature, the same purity and none of the reducer's uniformity. These variants make it
   * one layer: `docTransforms` is now where the bodies live and `applyMutation` is how they are
   * reached, so every doc edit still goes through one function.
   */
  | { type: 'saveFilterPreset'; args: { presetId: string; name: string } }
  | { type: 'applyFilterPreset'; args: { presetId: string } }
  | { type: 'deleteFilterPreset'; args: { presetId: string } }
  | { type: 'renameFilterPreset'; args: { presetId: string; name: string } }
  | {
      type: 'setDashboardDateRange';
      args: {
        pageId: string;
        fieldId: string | null;
        sourceId: string | null;
        fieldType: StudioDataField['type'] | null;
        preset: StudioDateRangePreset | null;
        customFrom?: string;
        customTo?: string;
      };
    }
  | {
      type: 'setDashboardDateRangeAll';
      args: {
        pageId: string;
        fields: Array<{ fieldId: string; sourceId: string; fieldType: 'date' | 'datetime' }>;
        preset: StudioDateRangePreset;
        customFrom?: string;
        customTo?: string;
      };
    }
  | {
      type: 'setWidgetDateRange';
      args: {
        widgetId: string;
        fieldId: string | null;
        sourceId: string | null;
        fieldType: StudioDataField['type'] | null;
        preset: StudioDateRangePreset | null;
        customFrom?: string;
        customTo?: string;
      };
    }
  /* Dashboard-level cross-filter settings and page-record writes. */
  | { type: 'setGlobalCrossFilterMode'; args: { mode: StudioCrossFilterMode | null } }
  | { type: 'setCrossFilterAllPages'; args: { allPages: boolean } }
  | { type: 'setPageStackBreakpoint'; args: { pageId: string; breakpoint: number | undefined } }
  | { type: 'reorderPages'; args: { pageIds: string[] } }
  | {
      type: 'updateActivePage';
      args: {
        pageId: string;
        changes: Partial<Omit<StudioPage, 'id' | 'widgetRows' | 'widgetColSpans'>>;
      };
    }
  /*
   * The two managed-filter applications.
   *
   * The FILTER is built by the caller, not by the reducer, and that is not laziness: it carries a
   * freshly minted `createFilterId()`, and the reducer must stay a pure function of
   * `(doc, args)`. Same division `addWidget`/`addPage` already use — the caller mints the id, the
   * reducer decides where it goes. What moves here is the replace-my-own-entries semantics.
   */
  | { type: 'applyCrossFilter'; args: { sourceWidgetId: string; filter: StudioFilterState } }
  | {
      type: 'applyInteractiveFilter';
      args: { sourceWidgetId: string; filter: StudioFilterState };
    };

/**
 * The full mutation vocabulary the reducer handles: everything the wire may carry, plus the
 * client-only writes it may not. `applyMutation`'s `MUTATION_HANDLERS` is exhaustive over THIS
 * union; `parseStateMutation`'s validator table is exhaustive over {@link WireStateMutation}
 * only. The asymmetry is deliberate and is the whole design.
 */
export type StateMutation = WireStateMutation | InternalStateMutation;

/**
 * A `StateMutation` addressed for wire transport: every mutation that crosses
 * the AI-middleware ↔ client SSE boundary is wrapped in this envelope rather
 * than sent bare, so it carries an identity (`id`) and a production timestamp
 * (`at`) independent of the mutation's own domain fields (contrast with e.g.
 * `renameAIThread.args.updatedAt` above, which is domain data the mutation
 * itself persists — this `at` is transport metadata about the envelope).
 *
 * `id` is generated once, at the producer (`createMutationEnvelope`), and
 * travels with the mutation end-to-end — the same shape a future replay/ack
 * mechanism over SSE reconnects would need (mirroring `ChatStreamEnvelope`'s
 * `sequence`-based dedup in `@mui/x-chat-headless`, used for chat-token chunks).
 */
export interface MutationEnvelope<T = StateMutation> {
  /** Collision-resistant id, unique per envelope. See `createMutationId`. */
  id: string;
  /** ISO 8601 timestamp of when the envelope was produced (server-side). */
  at: string;
  mutation: T;
}
