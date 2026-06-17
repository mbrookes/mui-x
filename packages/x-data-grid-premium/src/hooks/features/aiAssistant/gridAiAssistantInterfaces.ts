export type Prompt = {
  value: string;
  createdAt: Date;
  response?: PromptResponse;
  variant?: 'success' | 'error' | 'processing';
  helperText?: string;
};

export type PromptSuggestion = {
  value: string;
};

export type Conversation = {
  id?: string;
  title?: string;
  prompts: Prompt[];
};

export type GridAiAssistantState = {
  activeConversationIndex: number;
  conversations: Conversation[];
};

export type GridAiAssistantInitialState = Partial<GridAiAssistantState>;

type ColumnSort = {
  column: string;
  direction: 'asc' | 'desc';
};

type ColumnFilter = {
  operator: string;
  value: string | number | boolean | string[] | number[];
  column: string;
};

type Grouping = {
  column: string;
};

type AggregationFunction = 'avg' | 'sum' | 'min' | 'max' | 'size';
type Aggregation = {
  [column: string]: AggregationFunction;
};

type Pivoting =
  | {
      columns: ColumnSort[];
      rows: string[];
      values: Aggregation[];
    }
  | {};

type Chart = {
  dimensions: string[];
  values: string[];
};

/** Statistics for a numeric or date column. */
export type NumericColumnStatistics = {
  count: number;
  nullCount: number;
  min: number;
  max: number;
  avg: number;
  sum: number;
};

/** Statistics for a string, boolean, or singleSelect column. */
export type CategoricalColumnStatistics = {
  count: number;
  nullCount: number;
  uniqueCount: number;
  topValues: Array<{ value: unknown; count: number }>;
};

export type ColumnStatistics = NumericColumnStatistics | CategoricalColumnStatistics;

/** A single column entry in the enriched prompt context. */
export type PromptContextColumn = {
  field: string;
  type: string;
  description: string | null;
  examples: unknown[];
  allowedOperators: string[];
  /** Present when `allowAiAssistantStatistics` is enabled. */
  statistics?: ColumnStatistics;
  /** For pivot-derived columns, the source column field. */
  derivedFrom?: string;
};

/** Active view state sent as part of the prompt context. */
export type PromptContextCurrentState = {
  filters: ColumnFilter[];
  filterOperator: 'and' | 'or';
  sort: ColumnSort[];
  grouping: string[];
  aggregation: Aggregation;
  pivotActive: boolean;
  selectedRowCount: number;
};

/** Enriched prompt context object sent to the `onPrompt` handler. */
export type PromptContext = {
  /** Column definitions with optional per-column statistics. */
  schema: PromptContextColumn[];
  /** Total and currently-visible row counts. */
  rowCount: {
    total: number;
    visible: number;
    /**
     * When statistics were computed over a capped sample rather than all rows
     * (e.g. the dataset exceeds `MAX_STATS_ROWS`), this is `true`.
     */
    statisticsSampled?: boolean;
  };
  /** Active view configuration at the moment the prompt was submitted. */
  currentState: PromptContextCurrentState;
};

/** Input for the `queryRows` AI assistant API method. */
export type GridDataQueryInput = {
  /** Fields to include in each row (omit for all fields). */
  fields?: string[];
  /** Maximum number of rows to return (default: 100). */
  limit?: number;
  /** Number of rows to skip before returning results (default: 0). */
  offset?: number;
};

/** Output from the `queryRows` AI assistant API method. */
export type GridDataQueryResult = {
  rows: Record<string, unknown>[];
  /** Total count of rows that match the current grid filter (before `limit`/`offset`). */
  totalCount: number;
  hasMore: boolean;
};

/** Input for the `getStatistics` AI assistant API method. */
export type GridStatisticsInput = {
  /** Fields to compute statistics for (omit for all fields). */
  fields?: string[];
};

/** Input for the `getValueDistribution` AI assistant API method. */
export type GridValueDistributionInput = {
  field: string;
  /** Maximum number of top values to return (default: 20). */
  limit?: number;
};

/** Output from the `getValueDistribution` AI assistant API method. */
export type GridValueDistributionResult = {
  field: string;
  values: Array<{ value: unknown; count: number }>;
  totalCount: number;
  nullCount: number;
  uniqueCount: number;
};

/** Standard view-configuration response (existing behaviour). */
export type ViewConfigPromptResponse = {
  type?: 'view';
  conversationId: string;
  select: number;
  filters: ColumnFilter[];
  filterOperator?: 'and' | 'or';
  aggregation: Aggregation;
  sorting: ColumnSort[];
  grouping: Grouping[];
  pivoting: Pivoting;
  chart: Chart | null;
};

/** The agent responds with a text analysis rather than a view change. */
export type TextPromptResponse = {
  type: 'text';
  conversationId: string;
  /** The analysis text to display in the AI assistant panel. */
  message: string;
};

/** The agent responds with a data table alongside an optional message. */
export type DataPromptResponse = {
  type: 'data';
  conversationId: string;
  /** Optional explanatory text shown above the data table. */
  message?: string;
  /** Column field names to render (in order). Omit to infer from `rows`. */
  columns?: string[];
  /** Row data to display. */
  rows: Record<string, unknown>[];
  /** Optional title for the data table. */
  title?: string;
};

export type PromptResponse = ViewConfigPromptResponse | TextPromptResponse | DataPromptResponse;

export type PromptResolverOptions = {
  /**
   * By default, MUI's prompt resolver service stores the queries made to the service to analyze potential errors and improve the service (data is never stored). Enable private mode to make the service only keep track of the token count, without any query related data.
   * @default false
   */
  privateMode?: boolean;
  /**
   * Additional context to make the processing results more accurate.
   */
  additionalContext?: string;
  /**
   * Additional metadata to track the usage for each unique user.
   */
  metadata?: {
    /**
     * The reference ID that would be stored for you to identify the entity that made the request and then to be able to track the usage for each unique user/entity.
     */
    referenceId?: string;
  };
};

/**
 * The prompt API interface that is available in the grid [[apiRef]].
 */
export interface GridAiAssistantApi {
  /**
   * The AI assistant API.
   */
  aiAssistant: {
    /**
     * Calls the `onPrompt()` callback to evaluate the prompt and get the necessary updates to the grid state.
     * Adds the prompt to the current conversation.
     * Updates the grid state based on the prompt response.
     * @param {string} value The prompt to process
     * @returns {Promise<PromptResponse | Error>} The grid state updates or a processing error
     */
    processPrompt: (value: string) => Promise<PromptResponse | Error>;
    /**
     * Sets the conversations.
     * @param {Conversation[] | ((prevConversations: Conversation[]) => Conversation[])} conversations The new conversations.
     */
    setConversations: (
      conversations: Conversation[] | ((prevConversations: Conversation[]) => Conversation[]),
    ) => void;
    /**
     * Sets the active conversation index.
     * @param {number} index The index of the conversation that should become active.
     * @returns {Conversation} The active conversation.
     * @throws {Error} If the conversation index does not exist.
     */
    setActiveConversationIndex: (index: number) => Conversation;
    /**
     * Returns the enriched prompt context describing the current schema, row counts, and view state.
     * Useful for building custom backends or MCP server tool handlers.
     * @param {boolean} [includeStatistics] Whether to compute and include column statistics (default: false).
     * @returns {PromptContext} The prompt context object.
     */
    getContext: (includeStatistics?: boolean) => PromptContext;
    /**
     * Queries rows currently visible in the grid (after active filters) and returns them as plain objects.
     * @param {GridDataQueryInput} input Query parameters.
     * @returns {GridDataQueryResult} The matching rows and total count.
     */
    queryRows: (input?: GridDataQueryInput) => GridDataQueryResult;
    /**
     * Computes column-level statistics for the visible (filtered) rows.
     * Numeric columns return min/max/avg/sum/count; categorical columns return uniqueCount/topValues.
     * @param {GridStatisticsInput} input Fields to compute stats for (omit for all columns).
     * @returns {Record<string, ColumnStatistics>} Per-column statistics.
     */
    getStatistics: (input?: GridStatisticsInput) => Record<string, ColumnStatistics>;
    /**
     * Returns the frequency distribution of values in a single column.
     * @param {GridValueDistributionInput} input Column name and optional result limit.
     * @returns {GridValueDistributionResult} Value counts sorted descending by frequency.
     */
    getValueDistribution: (input: GridValueDistributionInput) => GridValueDistributionResult;
  };
}
