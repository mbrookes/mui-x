import type {
  StudioNumberFormat,
  StudioFilterOperator,
  StudioGridSummaryAggregation,
} from './baseTypes';

/**
 * Named capabilities a field can have — derived from its declared type (or overridden
 * explicitly via `StudioDataField.capabilities`). Used to filter field lists for
 * specific picker operations without scattering inline `f.type === 'number'` checks
 * across components. Defined here in the shared, React-free schema package (the single
 * source of truth); `@mui/x-studio`'s `utils/fieldCapabilities` re-exports this type.
 *
 * - `numeric`     — can be summed / averaged / used as a chart y-axis value
 * - `categorical` — can be used for grouping / split-by / selection filters
 * - `temporal`    — can be used for date filters, sparkline grouping, x-axis date grouping
 * - `rankTarget`  — can be used as the value that rank mode computes scores over
 */
export type FieldCapability = 'numeric' | 'categorical' | 'temporal' | 'rankTarget';

export interface StudioDataField {
  id: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  /** When true, the field is hidden from the data drawer and widget config selects */
  hidden?: boolean;
  /** When true, the field value is computed/derived rather than stored directly in source data */
  generated?: boolean;
  /** Display format for number fields */
  format?: StudioNumberFormat;
  /** Decimal places used when formatting number fields. */
  precision?: number;
  /** ISO 4217 currency code for currency format. Defaults to 'USD'. */
  currencyCode?: string;
  /**
   * Override the default type-derived field capabilities.
   * Use sparingly — most fields should rely on type inference.
   * Example: mark a low-cardinality number field as `['categorical']`
   * so it appears in "Split by" pickers instead of numeric y-axis pickers.
   * See `FieldCapability` in `utils/fieldCapabilities` for available values.
   */
  capabilities?: FieldCapability[];
  /**
   * Default aggregation function when this field is used as a measure column.
   * When set, the grid column picker auto-assigns this aggregation and shows
   * the field in the "Metrics" section of related pickers.
   * Omit for dimension fields (string, boolean, date) — they are never aggregated.
   */
  defaultAggregationFn?: StudioGridSummaryAggregation;
  /**
   * AI-facing description of this field's meaning and usage.
   * Included in the system prompt to help the AI choose the right fields
   * for chart axes, KPI values, filters, etc.
   * @example "Net revenue in USD excluding returns. Use for financial KPIs."
   */
  aiDescription?: string;
  /**
   * Aggregation function to apply when this field is downsampled for AI prompts.
   * Used by insight/forecast/analysis when the dataset exceeds the row budget and
   * rows are bucketed into groups — this controls how the numeric value is summarised
   * per bucket.
   *
   * Defaults: `'avg'` for `number` fields, `'first'` (no aggregation) for all others.
   * Use `'sum'` for additive metrics (e.g. revenue, units sold) where bucketed totals
   * are more meaningful than averages.
   */
  aiAggregation?: 'sum' | 'avg' | 'min' | 'max';
  /**
   * Canonical display order for categorical field values.
   *
   * When set, chart x-axis labels are sorted in this order instead of alphabetically.
   * Values not present in the list are appended at the end, sorted alphabetically
   * among themselves.
   *
   * Use for ordered enumerations such as pipeline stages, severity levels, or any
   * categorical field where alphabetical order is misleading.
   *
   * @example ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost']
   */
  orderedValues?: string[];
}

// Filter tree node for QueryDescriptor
export type StudioFilterNode =
  | {
      type: 'leaf';
      field: string;
      op: StudioFilterOperator;
      value: unknown;
      value2?: unknown;
      conjunction?: 'and' | 'or';
      op2?: StudioFilterOperator;
      fieldType?: StudioDataField['type'];
      filterSourceId?: string;
    }
  | { type: 'group'; logic: 'and' | 'or'; children: StudioFilterNode[] };

// Result returned by a data source adapter
export interface StudioQueryResult {
  rows: Record<string, unknown>[];
  totalCount?: number;
  isTruncated?: boolean;
}

// The query descriptor emitted by Studio for a widget
export interface StudioQueryDescriptor {
  sourceId: string;
  /**
   * Database table name for server-side queries.
   * Set from `StudioDataSource.tableName` when present; falls back to `sourceId`.
   * The `createBatchingAdapter` uses this value as the table name in batch requests.
   */
  tableName?: string;
  widgetId: string;
  /** Field IDs needed for this widget */
  select: string[];
  /** Recursive filter tree built from all active filters for this widget */
  filter?: StudioFilterNode;
  /** For chart/KPI: the x-axis grouping field */
  groupBy?: string;
  /** For chart/KPI: aggregation functions to apply server-side */
  aggregations?: {
    field: string;
    fn: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';
    alias: string;
  }[];
  /** Time-series bucketing granularity */
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /**
   * True when this widget currently has an incoming chart-click cross-filter or interactive
   * (filter-widget) selection — deliberately excluded from `filter` itself (they must not trigger
   * a server round-trip or churn the cache key on every click), but adapters that push
   * aggregation down (`aggregations`) need this signal: those filters are enforced CLIENT-SIDE
   * over the returned rows, and a server-aggregated response is one row per group with only the
   * grouped/alias columns present — a cross-filter on any other field reads `undefined` on every
   * row and empties the widget. An adapter should strip `aggregations` (returning raw rows,
   * mirroring the existing `count`/`avg`+`xGroupBy` client-aggregate special-cases) whenever this
   * is `true`, so the client's own aggregation step (which always runs) can shape the data
   * AFTER the cross-filter has been applied to real, ungrouped rows.
   */
  hasIncomingCrossOrInteractiveFilters?: boolean;
  /**
   * Stable hash of all other fields. Use as a cache key.
   * The package computes this; the developer need not hash the descriptor.
   */
  cacheKey: string;
}

// ── Client-side mutation types ────────────────────────────────────────────────
// These mirror MutationDescriptor / MutationResult from @mui/x-studio-data-middleware
// but are defined here to keep x-studio free of a server-package dependency.

/**
 * A single row mutation to send to the server via `adapter.submitMutation()`.
 * Mirrors `MutationDescriptor` from `@mui/x-studio-data-middleware`.
 */
export interface ClientMutationDescriptor {
  operation: 'insert' | 'update' | 'delete';
  /** Target table name (same value as `StudioDataSource.tableName ?? id`). */
  table: string;
  /** Column values to write (insert/update). */
  values?: Record<string, unknown>;
  /**
   * Row-match predicates (update/delete).
   * At least one predicate is required for update/delete.
   */
  where?: Array<{
    column: string;
    operator: 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'between';
    value: unknown;
  }>;
}

/** Result of a single mutation from `adapter.submitMutation()`. */
export interface ClientMutationResult {
  ok: boolean;
  rowsAffected?: number;
  error?: string;
}

// Async data source adapter — developer implements this
export interface StudioDataSourceAdapter {
  /**
   * Called when the query descriptor for this source changes.
   * Return pre-aggregated rows when descriptor.aggregations is set,
   * or raw filtered rows otherwise.
   */
  getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult>;
  /**
   * Optional write-back method. Present only when the adapter was created
   * with a `mutationEndpoint` option in `createBatchingAdapter()`.
   *
   * Grid widgets call this from `processRowUpdate` to send INSERT/UPDATE/DELETE
   * mutations to the server. The server automatically evicts cached query results
   * for the affected table after a successful mutation.
   */
  submitMutation?(descriptor: ClientMutationDescriptor): Promise<ClientMutationResult>;
}

export interface StudioDataSource {
  id: string;
  label: string;
  fields: StudioDataField[];
  rows?: Record<string, unknown>[];
  /** When true, the source is hidden from the data drawer panel and widget config selects */
  hidden?: boolean;
  /**
   * Database table name for server-side queries.
   * When set, `createBatchingAdapter` uses this as the table name in batch requests
   * instead of the source `id`. Use this when the source ID does not match the
   * actual table name in your database.
   * @example "orders" (when source id is "source-orders")
   */
  tableName?: string;
  /**
   * Pre-computed sorted distinct string values per native string/boolean field.
   * Built automatically by `normalizeDataSourceRows` at ingestion time.
   * Used by filter widgets to avoid an O(N) scan on every render.
   * Not persisted — derived from `rows` and rebuilt when rows change.
   */
  fieldDistinctValues?: Record<string, string[]>;
  /**
   * Optional async adapter. When set, Studio will call adapter.getRows()
   * whenever the query descriptor changes, instead of using rows directly.
   * rows can be omitted when adapter is provided.
   */
  adapter?: StudioDataSourceAdapter;
  /**
   * AI-facing description of this data source's content and purpose.
   * Included in the system prompt to help the AI understand what this source
   * represents and when to use it.
   * @example "Quarterly sales data for all regions, 2020–present."
   */
  aiDescription?: string;
}

export interface StudioRelationship {
  id: string;
  /**
   * For `many-to-one` / `one-to-one`: the "many" (or first) side source ID (e.g. `order_items`).
   * For `many-to-many`: one of the two endpoint source IDs (e.g. `products`).
   */
  sourceId: string;
  /**
   * For `many-to-one` / `one-to-one`: FK field in `sourceId` joining to `targetId`.
   * For `many-to-many`: PK/FK field in `sourceId` that the junction table references
   * (e.g. `id` on products, matched by `junctionSourceField`).
   */
  sourceField: string;
  /**
   * For `many-to-one` / `one-to-one`: the "one" side source ID (e.g. `customers`).
   * For `many-to-many`: the other endpoint source ID (e.g. `orders`).
   */
  targetId: string;
  /**
   * For `many-to-one` / `one-to-one`: PK field in `targetId`.
   * For `many-to-many`: PK/FK field in `targetId` that the junction table references
   * (e.g. `id` on orders, matched by `junctionTargetField`).
   */
  targetField: string;
  type: 'many-to-one' | 'one-to-one' | 'many-to-many';
  /**
   * **Required when `type === 'many-to-many'`.**
   * The ID of the junction (bridge) `StudioDataSource` (e.g. `order_items`).
   */
  junctionSourceId?: string;
  /**
   * **Required when `type === 'many-to-many'`.**
   * The field in the junction source that references `sourceId.sourceField`
   * (e.g. `product_id` on `order_items`).
   */
  junctionSourceField?: string;
  /**
   * **Required when `type === 'many-to-many'`.**
   * The field in the junction source that references `targetId.targetField`
   * (e.g. `order_id` on `order_items`).
   */
  junctionTargetField?: string;
  /**
   * When `true`, this relationship is defined by the data layer (not the user) and
   * should be displayed read-only — the Edit and Delete controls are hidden.
   */
  predefined?: boolean;
}
