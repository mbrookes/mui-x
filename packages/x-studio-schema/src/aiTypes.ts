/**
 * Shared AI-protocol and conversation types for MUI X Studio.
 *
 * These are the types both the client (`@mui/x-studio`) and the server
 * (`@mui/x-studio-ai-middleware`) need to agree on:
 *  - Accept skill configuration from app developers (`SerializableSkill`)
 *  - Produce/apply state mutations streamed over SSE (`StateMutation`)
 *  - Type-check `allowedTools` (`StudioAIToolName`)
 *  - Attach rich client-derived context to requests (`StudioAIRichContext` & co.)
 *  - Persist and restore AI conversation threads (`StudioAIState`)
 *
 * Server-only AI types (`StudioAISkill` with its `execute` function,
 * `SkillExecuteResult`, `StudioDataResolver`, rate-limit/usage types) live in
 * `@mui/x-studio-ai-middleware` — they are not part of the shared schema.
 */
import type { ChatMessage } from '@mui/x-chat-headless';
import type { StudioFilterState } from './stateTypes';
import type { StudioWidget } from './widgetTypes';

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
 * A state mutation produced server-side and streamed to the client as an SSE event.
 * Both sides apply it through the shared `applyMutation` reducer.
 */
export type StateMutation =
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
         * Top-level widget keys to DELETE from the widget — the wire-safe way to
         * void a field. Unlike a `changes` entry with an `undefined` value (which
         * `JSON.stringify` silently drops, so it can never survive the SSE stream
         * or an AI tool-call argument), a KEY NAME survives JSON intact. The
         * reducer skips `undefined`-valued `changes` keys precisely so an untrusted
         * wire caller cannot void a required field the old (unsafe) way; these
         * arrays are the ONLY sanctioned clear affordance, in-process or over the
         * wire. Applied AFTER the `config` patch and `changes` merge, so an explicit
         * unset always wins over a same-turn set of the same key.
         */
        unsetFields?: (keyof Omit<StudioWidget, 'id'>)[];
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
  | {
      type: 'applyBulkUpdate';
      args: {
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
        widgetRows: string[][];
        widgetColSpans: Record<string, number>;
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

// ── Rich AI context ─────────────────────────────────────────────────────────
// Extra, purely-additive context attached to each chat request to give the model
// more signal without any user effort. Shared by both packages.

/**
 * Summary statistics for a single data-source field, computed client-side from
 * pipeline-filtered rows. Numeric fields carry `min`/`max`/`mean`; all other
 * field types carry a `distinctCount`.
 */
export interface StudioAIFieldStat {
  /** Field data type, copied from `StudioDataField['type']`. */
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  /** Minimum value (numeric fields only). */
  min?: number;
  /** Maximum value (numeric fields only). */
  max?: number;
  /** Arithmetic mean, rounded (numeric fields only). */
  mean?: number;
  /** Number of distinct values (non-numeric fields). */
  distinctCount?: number;
  /** Number of rows the statistics were computed from. */
  sampledRows: number;
}

/** A single widget entry in the active-page layout snapshot. */
export interface StudioAILayoutWidget {
  widgetId: string;
  kind: string;
  title: string;
  chartType?: string;
  colSpan?: number;
}

/** An edge in the cross-filter graph: a widget whose selection filters the page. */
export interface StudioAICrossFilterEdge {
  sourceWidgetId: string;
  field: string;
  scope: 'cross-filter' | 'interactive';
}

/** Active-page widget layout plus its cross-filter graph. */
export interface StudioAIPageLayout {
  pageId: string;
  /** Widget rows, mirroring `StudioPage.widgetRows` but enriched per widget. */
  rows: StudioAILayoutWidget[][];
  /** Cross-filter / interactive-filter edges currently active on the page. */
  crossFilters: StudioAICrossFilterEdge[];
}

/** A compact record of one user-driven state mutation. */
export interface StudioAIRecentMutation {
  /** Short label, e.g. `"addFilter:revenue"` or `"updateWidgetConfig:chart-3"`. */
  label: string;
  /** ISO 8601 timestamp of when the mutation was committed. */
  at: string;
}

/**
 * Extra client-derived context attached to each AI chat request to give the
 * model more signal without any user effort. Every section is optional: the
 * client drops lower-priority sections (recent mutations first, then layout)
 * to stay under a token budget, recording dropped section names in `omitted`.
 *
 * Never sent in `privateMode` — field statistics expose real data values.
 */
export interface StudioAIRichContext {
  /** Per-field summary statistics, keyed by `${sourceId}.${fieldId}`. */
  fieldStats?: Record<string, StudioAIFieldStat>;
  /** Active page widget layout and cross-filter graph. */
  pageLayout?: StudioAIPageLayout;
  /** Most recent user-driven mutations, oldest first. */
  recentMutations?: StudioAIRecentMutation[];
  /** Names of sections dropped to fit the token budget (for prompt honesty). */
  omitted?: string[];
}

/**
 * Names of the built-in AI tools.
 * Use `allowedTools` in `StudioAIConfig` to restrict which tools are available.
 *
 * Derived from `STUDIO_AI_TOOL_REGISTRY` (`aiToolRegistry.ts`) — the single
 * source of truth for tool facts (title, destructive/idempotent/etc.
 * classification). `STUDIO_AI_TOOLS` in `@mui/x-studio-ai-middleware`
 * (`studioAITools.ts`) is type-checked against this same union, so the two
 * can no longer drift.
 */
export type { StudioAIToolName } from './aiToolRegistry';

// ── Conversation state ────────────────────────────────────────────────────────

/**
 * A single named conversation thread between the user and the AI assistant.
 * Threads are serialized inside `StudioState.ai` so conversation history
 * can be persisted alongside the dashboard state.
 */
export interface StudioAIChatThread {
  /** Unique thread identifier. */
  id: string;
  /** Display name shown in the thread selector. Auto-generated or user-renamed. */
  name: string;
  /** ISO 8601 timestamp when the thread was created. */
  createdAt: string;
  /** ISO 8601 timestamp of the most recent message. Updated on every send. */
  updatedAt?: string;
  /** Full message history for this thread. */
  messages: ChatMessage[];
}

/**
 * AI assistant state stored inside `StudioState`.
 *
 * Persisted via `serializeState`/`deserializeState` so conversation history
 * travels with the dashboard — enabling pre-loaded demos, cross-session memory,
 * and shareable dashboards with embedded AI context.
 */
export interface StudioAIState {
  /** All conversation threads. Ordered by `updatedAt` descending in the UI. */
  threads: StudioAIChatThread[];
  /** ID of the currently active thread. `undefined` means no thread is selected. */
  activeThreadId?: string;
}
