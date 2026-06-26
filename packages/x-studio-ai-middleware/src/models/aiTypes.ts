/**
 * AI interaction types for x-studio-ai-middleware.
 *
 * `SerializableSkill`, `StateMutation`, and `StudioAIToolName` are protocol
 * types also exported by `@mui/x-studio` (the client UI package). They are
 * defined here locally so this package has no dependency on x-studio.
 * TypeScript structural typing ensures values from @mui/x-studio remain
 * assignable to these types at the app boundary.
 */
import type { StudioState, StudioFilterState, StudioWidget } from './studioTypes';

// ── Protocol types (mirrored in @mui/x-studio for UI consumers) ──────────────

/**
 * Serializable skill metadata forwarded to the server in every AI request.
 * The `execute` function (if present) is stripped before sending — only these
 * fields are sent over the wire. Mirrors `SerializableSkill` in @mui/x-studio.
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
 * Mirrors `StateMutation` in @mui/x-studio.
 */
export type StateMutation =
  | { type: 'addPage'; args: { id: string; title: string } }
  | { type: 'setDashboardTitle'; args: { title: string } }
  | { type: 'addWidget'; args: { widget: StudioWidget } }
  | {
      type: 'updateWidget';
      args: {
        widgetId: string;
        changes?: Partial<Omit<StudioWidget, 'id'>>;
        config?: StudioWidget['config'];
      };
    }
  | { type: 'removeWidget'; args: { widgetId: string } }
  | { type: 'setWidgetLayout'; args: { rows: string[][] } }
  | {
      type: 'setWidgetColSpan';
      args: { widgetId: string; columns: number | null; rowWidgetIds: string[] };
    }
  | { type: 'renamePage'; args: { pageId: string; title: string } }
  | { type: 'removePage'; args: { pageId: string } }
  | { type: 'setActivePage'; args: { pageId: string } }
  | { type: 'addFilter'; args: { filter: StudioFilterState } }
  | { type: 'removeFilter'; args: { filterId: string } }
  | {
      type: 'applyBulkUpdate';
      args: {
        widgets: Record<string, StudioWidget>;
        widgetRows: string[][];
        widgetColSpans: Record<string, number>;
        activePageId: string;
      };
    }
  | {
      type: 'renameAIThread';
      args: { name: string };
    };

// ── Rich AI context ─────────────────────────────────────────────────────────
// Mirrors the rich-context types in @mui/x-studio. The client computes these
// from live pipeline rows and sends them in `StudioAIRequest.richContext`.

/**
 * Summary statistics for a single data-source field, computed client-side from
 * pipeline-filtered rows. Numeric fields carry `min`/`max`/`mean`; all other
 * field types carry a `distinctCount`.
 */
export interface StudioAIFieldStat {
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  min?: number;
  max?: number;
  mean?: number;
  distinctCount?: number;
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
  rows: StudioAILayoutWidget[][];
  crossFilters: StudioAICrossFilterEdge[];
}

/** A compact record of one user-driven state mutation. */
export interface StudioAIRecentMutation {
  label: string;
  at: string;
}

/**
 * Extra client-derived context attached to each AI chat request. Every section
 * is optional; the client drops lower-priority sections to stay under a token
 * budget, recording dropped section names in `omitted`. Never sent in
 * `privateMode` — field statistics expose real data values.
 */
export interface StudioAIRichContext {
  fieldStats?: Record<string, StudioAIFieldStat>;
  pageLayout?: StudioAIPageLayout;
  recentMutations?: StudioAIRecentMutation[];
  omitted?: string[];
}

/**
 * Optional DB-side metadata produced by the host's `contextEnricher` callback
 * and rendered into a `<server_context>` block in the system prompt. All fields
 * are optional; large values should be bounded by the host before returning.
 */
export interface StudioAIEnrichedContext {
  /** Row counts per dimension value, keyed by field id then value. */
  rowCounts?: Record<string, Record<string, number>>;
  /** Free-text schema comments keyed by `${sourceId}.${fieldId}` or table name. */
  schemaComments?: Record<string, string>;
  /** Any additional free-text notes to surface to the model. */
  notes?: string;
}

/**
 * Names of the built-in AI tools. Mirrors `StudioAIToolName` in @mui/x-studio.
 */
export type StudioAIToolName =
  | 'get_dashboard_state'
  | 'add_page'
  | 'set_dashboard_title'
  | 'add_widget'
  | 'update_widget'
  | 'remove_widget'
  | 'set_widget_layout'
  | 'set_widget_width'
  | 'rename_page'
  | 'remove_page'
  | 'set_active_page'
  | 'add_page_filter'
  | 'remove_page_filter'
  | 'add_widget_filter'
  | 'remove_widget_filter'
  | 'summarise_page'
  | 'apply_bulk_update'
  | 'rename_thread'
  | 'execute_query';

// ── Data resolver ─────────────────────────────────────────────────────────────

/**
 * Result returned by a `StudioDataResolver` after executing a query.
 */
export interface StudioDataResolverResult {
  /** Rows of data. Each row is a record of column-name → value. */
  rows: Record<string, unknown>[];
  /** Optional column metadata (names in order, useful for display). */
  columns?: string[];
  /** Total row count before any LIMIT, if available from the data source. */
  totalCount?: number;
}

/**
 * App-provided data resolver for the `execute_query` AI tool.
 *
 * When configured, the AI assistant can call `execute_query` to run
 * ad-hoc queries and incorporate live data into its responses.
 *
 * @example
 * ```ts
 * const dataResolver: StudioDataResolver = {
 *   async resolve(query, sourceId) {
 *     const db = sourceId ? getDb(sourceId) : defaultDb;
 *     const rows = await db.query(query);
 *     return { rows };
 *   },
 * };
 * ```
 */
export interface StudioDataResolver {
  /**
   * Execute the query and return the result.
   * @param query   The query string (SQL or equivalent).
   * @param sourceId  Optional data source identifier.
   */
  resolve(query: string, sourceId?: string): Promise<StudioDataResolverResult>;
}

// ── Server-side skill ─────────────────────────────────────────────────────────

/**
 * The result returned by a skill's `execute` function.
 */
export interface SkillExecuteResult {
  output: string;
  mutation?: StateMutation;
  nextState: StudioState;
}

/**
 * A skill that can be registered with the x-studio AI assistant.
 * Extends `SerializableSkill` by adding the server-side `execute` function.
 * Instances are assignable to `SerializableSkill` (used in `StudioAIConfig.skills`).
 *
 * The `execute` function may be synchronous or asynchronous.
 */
export interface StudioAISkill extends SerializableSkill {
  mode: 'server-tool' | 'instruction-only' | 'client-handler';
  tool?: {
    name: string;
    description: string;
    parameters: object;
    execute: (
      args: Record<string, unknown>,
      state: StudioState,
    ) => SkillExecuteResult | Promise<SkillExecuteResult>;
  };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

/**
 * Token and iteration usage for a single `handleAIChat` call.
 */
export interface StudioAIUsage {
  /** Total number of input (prompt) tokens consumed across all agentic iterations. */
  inputTokens: number;
  /** Total number of output (completion) tokens generated across all agentic iterations. */
  outputTokens: number;
  /** Number of agentic loop iterations (LLM round-trips) completed. */
  iterations: number;
}

/**
 * Server-side token and turn budget for a single AI chat request.
 * Configure this in `StudioAIHandlerOptions` on your server endpoint.
 */
export interface StudioAIRateLimit {
  /**
   * Maximum number of tokens (input + output combined) the model may consume
   * across all agentic loop iterations in a single `handleAIChat` call.
   * When the accumulated token count exceeds this value, the loop is stopped
   * after the current iteration completes.
   *
   * @example
   * // Allow at most 8 000 tokens per request
   * rateLimit: { maxTokensPerRequest: 8_000 }
   */
  maxTokensPerRequest?: number;
  /**
   * Maximum number of agentic loop iterations (LLM round-trips) per request.
   * Overrides the default safety cap of 10.
   *
   * @example
   * // Cap at 5 back-and-forth turns
   * rateLimit: { maxTurnsPerRequest: 5 }
   */
  maxTurnsPerRequest?: number;
  /**
   * Called when a limit is reached before the loop would naturally finish.
   * Use this to increment a quota counter, log the overage, or trigger an alert.
   *
   * @param {'tokens' | 'turns'} reason `'tokens'` — token budget exceeded; `'turns'` — max iterations reached.
   * @param {StudioAIUsage} usage  Token counts and iteration number at the point the limit was hit.
   */
  onLimitReached?: (reason: 'tokens' | 'turns', usage: StudioAIUsage) => void;
}
