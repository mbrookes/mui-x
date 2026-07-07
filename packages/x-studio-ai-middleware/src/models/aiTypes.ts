/**
 * AI interaction types for x-studio-ai-middleware.
 *
 * The protocol types shared with the client UI (`SerializableSkill`,
 * `StateMutation`, `StudioAIToolName`, and the rich-context types) now live in
 * `@mui/x-studio-schema` and are re-exported here. The server-only types
 * (`StudioAISkill` with its `execute` function, `SkillExecuteResult`,
 * rate-limit/usage/enriched-context types) stay local — the client never
 * needs them.
 *
 * The `query_data_source` data-query types (`StudioDataFilter` and friends,
 * `StudioAIDataConfig`) live here — not in `mcp/types.ts` — so both `mcp.ts`
 * and `agenticLoop.ts`/`handleAIChat.ts` can import them without either
 * transport depending on the other's composition root. `mcp/types.ts`
 * re-exports them under their original names for backward compatibility.
 */
import type { SerializableSkill, StateMutation } from '@mui/x-studio-schema';
import type { StudioState } from './studioTypes';

export type {
  SerializableSkill,
  StateMutation,
  MutationEnvelope,
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

// ── Data query (`query_data_source`) ──────────────────────────────────────────

/**
 * Structured filter predicate for `query_data_source`.
 * Operators match those accepted by `@mui/x-studio-data-middleware`'s
 * `FilterPredicate` type so a host server can forward them unchanged.
 */
export interface StudioDataFilter {
  /** Field ID (column name) to filter on. */
  field: string;
  /** Comparison operator. */
  operator: 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'between';
  /** Filter value. For `between`, this is the lower bound; supply `value2` for the upper. */
  value: unknown;
  /** Upper bound for `between` operator. */
  value2?: unknown;
}

/** Single aggregation function for `query_data_source`. */
export interface StudioDataAggregation {
  /** Column to aggregate (field ID / column name). */
  column: string;
  /** Aggregation function. */
  func: 'sum' | 'avg' | 'count' | 'min' | 'max';
  /** Alias used as the result column key in returned rows. */
  alias: string;
}

/** Sort descriptor for `query_data_source`. */
export interface StudioDataOrderBy {
  /** Column name (field ID or aggregation alias). */
  column: string;
  /** Sort direction. */
  direction: 'asc' | 'desc';
}

/** Post-aggregation HAVING predicate for `query_data_source`. */
export interface StudioDataHavingPredicate {
  /** Aggregation alias (from `aggregations[].alias`) to filter on. */
  alias: string;
  /** Comparison operator. */
  operator: 'eq' | 'gt' | 'lt' | 'gte' | 'lte';
  /** Numeric threshold. */
  value: number;
}

/** Arguments for the `query_data_source` tool. */
export interface StudioDataQueryParams {
  /** Data source ID from the dashboard state (e.g. `"source-orders"`). */
  sourceId: string;
  /**
   * Physical table name resolved from the data source.
   * Set internally by the tool handler — callers should not need to set this.
   */
  tableName: string;
  /** Field IDs to project. Omit to return all non-hidden fields. */
  columns?: string[];
  /** Structured WHERE predicates. Never raw SQL. */
  filters?: StudioDataFilter[];
  /**
   * Aggregation functions applied via GROUP BY.
   * Non-aggregated `columns` entries form the GROUP BY list.
   */
  aggregations?: StudioDataAggregation[];
  /**
   * Post-aggregation HAVING predicates.
   * Each alias must match an entry in `aggregations[].alias`.
   */
  having?: StudioDataHavingPredicate[];
  /** Sort order. */
  orderBy?: StudioDataOrderBy[];
  /** Maximum rows to return. Default 1000. */
  limit?: number;
  /** Number of rows to skip before returning results. Use with `limit` for pagination. Default 0. */
  offset?: number;
}

/** Result returned by `queryDataSource` and surfaced in the `query_data_source` tool response. */
export interface StudioDataQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** Routing tier applied by the data middleware. */
  tier?: 'client' | 'server' | 'db';
}

/**
 * App-provided data-access configuration shared by both transports: passing
 * the SAME object to `handleAIChat`'s `data` option and `buildStudioMcpServer`'s
 * `data` option gives the chat loop and MCP server identical `query_data_source`
 * behavior against the same database.
 */
export interface StudioAIDataConfig {
  /**
   * Execute a structured query against a data source.
   * The implementation is responsible for security, allowlisting, and DB routing.
   * @param {StudioDataQueryParams} params The structured query descriptor.
   * @returns {Promise<StudioDataQueryResult>} The matching rows and metadata.
   */
  queryDataSource: (params: StudioDataQueryParams) => Promise<StudioDataQueryResult>;
  /**
   * Hard upper bound on the number of rows the `query_data_source` tool may request.
   * The model-supplied `limit` (or the default of 1000) is clamped to this value
   * before the query reaches `queryDataSource`.
   * @default 1000
   */
  maxQueryRows?: number;
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
