/**
 * AI interaction types for x-studio-ai-middleware.
 *
 * The protocol types shared with the client UI (`SerializableSkill`,
 * `StateMutation`, `StudioAIToolName`, and the rich-context types) now live in
 * `@mui/x-studio-schema` and are re-exported here. The server-only types
 * (`StudioAISkill` with its `execute` function, `SkillExecuteResult`,
 * `StudioDataResolver`, rate-limit/usage/enriched-context types) stay local —
 * the client never needs them.
 */
import type { SerializableSkill, StateMutation } from '@mui/x-studio-schema';
import type { StudioState } from './studioTypes';

export type {
  SerializableSkill,
  StateMutation,
  StudioAIToolName,
  StudioAIFieldStat,
  StudioAILayoutWidget,
  StudioAICrossFilterEdge,
  StudioAIPageLayout,
  StudioAIRecentMutation,
  StudioAIRichContext,
} from '@mui/x-studio-schema';

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
   * Maximum number of state mutations that may be COMMITTED across all agentic
   * loop iterations in a single `handleAIChat` call. A built-in mutating tool call
   * that would push the committed-mutation count over this cap is denied — the
   * model is fed a `{ error }` tool result so it can adapt, and the stream is NOT
   * killed (unlike the token budget). Read-only tool calls never count against it.
   *
   * When omitted, there is no mutation cap (the historical unlimited behavior).
   *
   * @example
   * // Allow at most 10 committed mutations per request
   * rateLimit: { maxMutationsPerRequest: 10 }
   */
  maxMutationsPerRequest?: number;
  /**
   * Called when a limit is reached before the loop would naturally finish.
   * Use this to increment a quota counter, log the overage, or trigger an alert.
   *
   * @param {'tokens' | 'turns' | 'mutations'} reason `'tokens'` — token budget exceeded; `'turns'` — max iterations reached; `'mutations'` — mutation budget exceeded.
   * @param {StudioAIUsage} usage  Token counts and iteration number at the point the limit was hit.
   */
  onLimitReached?: (reason: 'tokens' | 'turns' | 'mutations', usage: StudioAIUsage) => void;
}
