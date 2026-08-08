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
      /**
       * The authoring mode of the source filter (`condition` / `selection` / `rank`), carried onto
       * the leaf so an adapter's client-side residual re-applies it with the SAME completeness
       * semantics the in-memory evaluator uses. It matters for an empty selection: a selection-mode
       * `in []` ("any value") must match EVERYTHING, whereas a condition-mode `in []` matches
       * NOTHING. Without this, `leafToClientFilterState` re-stamped every residual as `'condition'`,
       * inverting an empty selection to match-nothing on the adapter path.
       */
      filterMode?: 'condition' | 'selection' | 'rank';
      /**
       * Rank-mode configuration, carried so a `filterMode: 'rank'` leaf survives the round trip
       * back into a `StudioFilterState`.
       *
       * Meaningless on any other mode, and absent from every leaf the WIRE builds — the wire's
       * descriptor deliberately excludes rank filters entirely (`buildQueryDescriptor` filters
       * them out of the tree and signals them through `hasRankFilters` instead), because rank has
       * no SQL form and putting it in the tree would churn the request cacheKey on every Top-N
       * change. These exist for the LOCAL executor, which can run a rank and therefore has to be
       * handed one.
       *
       * Without them, `leafToFilterState` reconstructs a rank filter carrying only `field`,
       * `value` and the mode. `applyFilters` then reads `rankDirection ?? 'top'` and finds no
       * `rankByField`, so "bottom 5 countries by revenue" silently executes as "top 5 countries by
       * the raw value of the country column" — a wrong number, not an error.
       */
      rankDirection?: 'top' | 'bottom';
      rankByField?: string;
      rankMultiSeriesBy?: string;
    }
  | { type: 'group'; logic: 'and' | 'or'; children: StudioFilterNode[] };

// Result returned by a data source adapter
export interface StudioQueryResult {
  rows: Record<string, unknown>[];
  totalCount?: number;
  isTruncated?: boolean;
}

/**
 * The question a widget is asking, independent of how it will be answered.
 *
 * Split from {@link StudioQueryDescriptor} so the planner and the in-memory executor can take a
 * query without being handed a `cacheKey` they have no use for. A cache key identifies a REQUEST;
 * the local path issues none, and its row cache is keyed on the resolved filters instead. Requiring
 * one of a local query would have meant either computing a stable hash on every render in a hot
 * path, or inventing a placeholder that looks like a real key and collides with every other
 * placeholder the moment one reaches a request cache.
 *
 * Every `StudioQueryDescriptor` is a `StudioQuery`, so nothing on the adapter path changes.
 */
export interface StudioQuery {
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
    /**
     * `count_non_null` rides the wire as the middleware's `count`, which IS SQL
     * `COUNT(column)` — see `createBatchingAdapter`'s `toWireAggFunc`. It is carried
     * under its own name up to that point so `isClientOnlyAggFn` can tell it apart from
     * Studio's `count` (`COUNT(*)`), which has no faithful wire form.
     */
    fn: 'sum' | 'avg' | 'count' | 'count_non_null' | 'min' | 'max' | 'count_distinct';
    alias: string;
  }[];
  /**
   * Time-series bucketing granularity.
   *
   * CLIENT-ONLY — it has NO wire representation, and that is the single largest driver of
   * row-budget pressure on the batching path. Scoped, not built; read this before adding one.
   *
   * ### What it costs today
   *
   * A "monthly revenue" line chart ships `columns: ['created_at', 'amount']`. The middleware
   * derives its GROUP BY from the projection, so it groups by the RAW timestamp and returns one
   * row per distinct instant — up to `MAX_RESULT_ROWS` (100 000) for a 12-point chart — which the
   * client then re-buckets. The numbers are right (`sum`/`min`/`max` re-reduce correctly from
   * partial groups); the row count is not, and a single such widget can consume the whole
   * `MAX_ROWS_PER_REQUEST` batch allowance and starve every sibling on the page. That is the
   * pressure `limit` exists to relieve, by truncating — a remedy the client cannot distinguish
   * from a complete result.
   *
   * `avg` is worse: `aggregationPushdown.ts`'s rung 5 strips the push-down ENTIRELY for
   * `avg` + `xGroupBy` ("cannot transmit time bucketing"), so those widgets fetch raw rows with no
   * aggregation at all. They would be the most improved. `count`/`count_distinct` are stripped for
   * unrelated reasons and bucketing would not help them.
   *
   * ### What the wire would carry
   *
   * One optional derived-dimension list, shaped like the existing `columnAliases` indirection:
   * `{ column, granularity, alias }[]`, with `alias` replacing the raw column in `columns`. The
   * server SELECTs the truncation expression AS the alias, GROUP BYs it, and returns it under the
   * alias as the row key.
   *
   * **It must emit the client's period-key STRING** (`'2024-01-15' | '2024-W03' | '2024-01' |
   * '2024-Q1' | '2024'`), not a truncated timestamp. Then the client's own re-bucket is a verified
   * no-op — `truncateToPeriod` returns the key unchanged for day/month/year and `null` for
   * week/quarter, which `applyXGroupBy`'s `?? value` passes through — so `formatPeriodLabel`,
   * sorting, and every downstream chart path work with no client change beyond the descriptor
   * build. A truncated timestamp instead would vary by driver and, for `week`, arrive as a Monday
   * DATE rather than an ISO week key, breaking both labels and sort order.
   *
   * Caveat that follows from the same mechanism: because week/quarter keys are unparseable to
   * `truncateToPeriod`, the client passes them through WITHOUT validating them. A server that
   * emitted a wrong week key would not be caught client-side.
   *
   * ### Which side owns timezone
   *
   * The client already does, and its answer is UTC, unconditionally: `truncateToPeriod` reads
   * `getUTCFullYear/Month/Date`, and its fast path reads the written `YYYY-MM-DD` prefix while
   * honouring a real `±HH[:MM]` offset. A first cut must therefore reproduce UTC exactly and NOT
   * introduce a timezone parameter — otherwise the same dashboard silently changes buckets
   * depending on whether push-down happened to apply to a given widget. A per-dashboard display
   * timezone is a separate, later feature, and it has to move BOTH sides at once for the same
   * reason. Dropping it from v1 is most of why this is smaller than it looks.
   *
   * ### What the server must validate
   *
   * 1. `granularity` against a 5-member OWN-PROPERTY allowlist, fail-closed, exactly like
   *    `AGGREGATE_SQL_FUNCTIONS` and `applyHaving`'s `opMap`. The token must never reach SQL.
   * 2. `column` through the existing `assertTablesAllowed` / `columnValidation` chokepoints and
   *    `qualifyAgainst` — a truncated column is a column reference like any other.
   * 3. `alias` through the existing identifier charset/length checks, and rejected when it
   *    collides with an aggregation alias or a projected column.
   * 4. The list length against `MAX_ARRAY_ITEMS_PER_DESCRIPTOR`.
   * 5. A HAVING or ORDER BY on the alias must re-emit the EXPRESSION, not the alias — the same
   *    constraint `applyHaving` documents (Postgres rejects a SELECT alias in HAVING).
   * 6. Cache separation is free (`computeQueryHash` spreads the whole descriptor) but needs an
   *    explicit test: two descriptors differing only in granularity must not share an entry.
   *
   * ### The real cost: dialect branching
   *
   * This would be the FIRST client-derived SQL expression the middleware emits in a SELECT/GROUP BY
   * position, and the first query-building code in that package to branch on
   * `db.client.config.client` — it has no dialect branching anywhere today. The expression must come
   * from a server-owned template table keyed by (dialect, granularity), with the column bound via
   * `??`, never concatenated. `week` is the genuinely awkward grain: Postgres needs `IYYY`, not
   * `YYYY` (they differ for up to three days each January — a silent, once-a-year bug), MySQL needs
   * `%x-W%v`, and SQLite has no ISO-week token at all and needs a hand-written expression. None of
   * it is verifiable by the current mock-DB suite, which records method names and cannot see a
   * dialect bug (see `predicates.ts`'s LIKE note).
   *
   * ### Estimate
   *
   * 2–4 days. The protocol half (this type, the descriptor build, rung 5 of the push-down ladder,
   * the plan validation, the cache-key test) is small and contained. The SQL half — the dialect
   * template table, ISO-week correctness, and real Postgres/MySQL/SQLite tests — is the majority
   * and all of the risk.
   *
   * ### Cheaper move to sequence first
   *
   * A HOST-declared bucket column (a generated column or view column the host already models,
   * surfaced as an ordinary field on `StudioDataSource` and referenced through the existing
   * `columnAliases` indirection) needs no new SQL emission and no dialect branching at all. It
   * covers the deployments that hurt most — a large table someone already owns — for a fraction of
   * the work. It does NOT cover ad-hoc regrain (a user flipping month → week in the UI), so it is a
   * complement rather than a replacement, but it is the cheaper first move.
   */
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
   * True when this widget currently has an active rank-mode (top/bottom-N) filter. Rank filters
   * have no wire form and are always re-applied CLIENT-SIDE over the returned rows — but the client
   * rank reduction must see RAW rows so it can sum `rankByField` per group itself. When the widget
   * ALSO pushes a `sum`/`min`/`max` aggregation, the server GROUP BYs every projected non-measure
   * column (including `rankByField`), collapsing duplicate `(groupKey, rankByFieldValue)` pairs to
   * one row — the client then ranks over group-collapsed rows and picks the wrong Top-N. An adapter
   * should therefore strip `aggregations` (returning raw rows) whenever this is `true`, mirroring
   * the `hasIncomingCrossOrInteractiveFilters` guard, so the client aggregates AFTER ranking over
   * real rows.
   */
  hasRankFilters?: boolean;
  /**
   * Maximum number of rows this widget may fetch, forwarded to a server-side adapter as the
   * query's `limit`.
   *
   * WHY THIS EXISTS. A batch request has a SHARED row budget on the server side
   * (`MAX_ROWS_PER_REQUEST` in `@mui/x-studio-data-middleware`): every widget's rows are
   * charged against one per-request allowance, and a widget whose rows no longer fit is
   * failed outright rather than truncated. Widgets that cannot push their aggregation down —
   * KPI, gauge, scatter, gantt, a grid with no `groupBy`, filter widgets — fetch RAW rows, so
   * a single one over a large table can consume the whole allowance and starve every sibling
   * on the page. The middleware's own budget-exhaustion error prescribes exactly this remedy
   * ("set a smaller `limit` on each widget"); before this field there was no way to express it.
   *
   * DELIBERATELY OPTIONAL, WITH NO DEFAULT. A limit TRUNCATES: the client cannot tell a
   * limited result from a complete one, so a widget that aggregates client-side over the
   * returned rows would silently report a number computed from a prefix of its data. That is
   * the same silent data loss the server refuses to commit on the caller's behalf, so it is
   * never applied unless a host asks for it. `createBatchingAdapter`'s `maxRowsPerWidget`
   * option supplies a page-wide default for hosts that do; either way the adapter warns when
   * a response comes back at exactly the limit, so a truncation is never silent.
   */
  limit?: number;
}

/** A {@link StudioQuery} plus the transport key an adapter caches its response under. */
export interface StudioQueryDescriptor extends StudioQuery {
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
