/**
 * Explicit aggregation specification for DB-tier push-down queries.
 *
 * Use instead of the legacy `sum_` / `avg_` / `count_` column prefix convention.
 *
 * @example
 * { column: 'revenue', func: 'sum', alias: 'total_revenue' }
 */
export interface AggregationSpec {
  /** The column to aggregate */
  column: string;
  /** Aggregation function */
  func: 'sum' | 'avg' | 'count' | 'min' | 'max';
  /** Output alias — used as the key in the result rows */
  alias: string;
}

/**
 * JOIN descriptor for multi-table queries.
 *
 * All joined table names are validated against the `schemaAllowlist` in
 * `HandleBatchQueryOptions`. Column names in `on` predicates are validated
 * against `columnAllowlist` when provided.
 */
export interface JoinDescriptor {
  /** Table to join */
  table: string;
  /** Join type (default: 'inner') */
  type?: 'inner' | 'left' | 'right';
  /**
   * Join conditions as `[leftColumn, rightColumn]` pairs.
   * Left column is from the primary table; right column is from the joined table.
   * Both are identifier-escaped by Knex's join builder — `buildSecureQuery` emits
   * them via `.on(left, '=', right)`, whose column arguments Knex quotes as
   * identifiers (not the `??` binding used elsewhere).
   *
   * @example [['orders.customer_id', 'customers.id']]
   */
  on: [string, string][];
}

/**
 * Base interface for a Studio batch query widget descriptor.
 * Mirrors the shape sent from the client DataLoader.
 */
export interface BatchWidgetDescriptor {
  /** Widget identifier — present in response for client-side routing */
  id: string;
  /** Primary data source / table to query */
  table: string;
  /**
   * Columns to include in SELECT (projection).
   *
   * Use qualified names (`table.column`) when joining multiple tables to avoid
   * ambiguity. Non-aggregated columns become GROUP BY when `aggregations` is set.
   *
   * Column values here may be logical field IDs. When a logical ID has a
   * corresponding entry in `columnAliases`, the server SELECTs the mapped
   * physical column and returns it under the logical ID as the row key.
   */
  columns?: string[];
  /**
   * Maps logical field IDs (column values in `columns` / `aggregations`) to their
   * physical SQL column references.
   *
   * Used for expression fields whose logical ID has no matching DB column.
   * For example, `{ 'expr-order-country': 'customers.country' }` means
   * `SELECT customers.country AS "expr-order-country"`.
   *
   * Keys that do not appear in `columns` or `aggregations` are ignored.
   */
  columnAliases?: Record<string, string>;
  /**
   * Aggregation specs for DB push-down queries.
   *
   * Non-aggregated `columns` entries become GROUP BY clauses.
   * When not set, the db tier returns a plain raw-row slice (the same select/
   * orderBy/limit shape the client/server tiers return for the same descriptor) —
   * NOT grouped rows without aggregation. See `router/execute.ts`'s
   * no-aggregations fallback branch.
   */
  aggregations?: AggregationSpec[];
  /** Client-supplied filter predicates (structured, never raw SQL) */
  filters?: FilterPredicate[];
  /**
   * Post-aggregation filter predicates (HAVING clause).
   *
   * Each entry references an aggregation alias from `aggregations[]` — never a raw
   * column name. Only numeric comparisons are supported. The middleware validates
   * that every `alias` in `having` matches an entry in `aggregations` before
   * executing the query.
   *
   * @example
   * // "Show categories where total revenue > 10 000"
   * aggregations: [{ column: 'revenue', func: 'sum', alias: 'total_revenue' }],
   * having: [{ alias: 'total_revenue', operator: 'gt', value: 10000 }]
   */
  having?: HavingPredicate[];
  /** ORDER BY clauses */
  orderBy?: OrderBy[];
  /**
   * Row limit for pagination.
   *
   * Optional and purely advisory as an UPPER bound from the client's point of
   * view: `router/execute.ts` always applies an effective limit of
   * `min(limit ?? cap, cap)`, where `cap` is the hard server-side ceiling
   * `MAX_RESULT_ROWS` further reduced by whatever the REQUEST-wide row budget
   * (`MAX_ROWS_PER_REQUEST`) still allows. This means an omitted (or excessively
   * large) `limit` can never make the server attempt an uncapped SELECT against
   * a multi-million-row table, and a batch of widgets can never sum past the
   * request budget — regardless of what the client requests.
   */
  limit?: number;
  /**
   * Optional JOIN descriptors for multi-table queries.
   *
   * All joined table names must appear in `HandleBatchQueryOptions.schemaAllowlist`.
   *
   * Security predicates are applied to the primary table AND, by default, to every
   * joined table: a joined table inherits the primary table's resolved security
   * columns (tenant / region / department) via `resolveJoinSecurityColumns`, so an
   * unregistered join is scoped rather than fanning out unscoped. A genuinely
   * shared/lookup table with no tenant column opts out explicitly with the
   * `securityColumns.perTable[table] = null` sentinel; only then is it joined
   * unscoped.
   */
  joins?: JoinDescriptor[];
}

/**
 * Post-aggregation filter on an aggregation alias (HAVING clause).
 *
 * Only numeric comparison operators are allowed. The `alias` must match an
 * entry in `BatchWidgetDescriptor.aggregations[].alias` — referencing raw
 * column names is rejected by the middleware to prevent injection.
 */
export interface HavingPredicate {
  /** Aggregation alias to filter on (must match aggregations[].alias). */
  alias: string;
  operator: 'eq' | 'gt' | 'lt' | 'gte' | 'lte';
  value: number;
}

/**
 * Structured filter predicate — never a raw SQL string.
 *
 * A discriminated union over `operator` so `value` is narrowed to the correct
 * type for each operator at compile time. This eliminates type casts in the
 * query builder and lets TypeScript catch mismatches (e.g. passing a string
 * to a numeric comparison, or a scalar to `in`) before they reach the DB.
 *
 * Canonical pattern: flat typed `{column, operator, value}` tuples with an
 * enumerable operator set. The descriptor shape is tier-agnostic — the same
 * object drives in-memory array filtering (client tier) and SQL push-down
 * (db tier) without reshaping.
 */
export type FilterPredicate =
  | { column: string; operator: 'eq' | 'neq'; value: string | number | boolean }
  | { column: string; operator: 'in'; value: (string | number)[] }
  | { column: string; operator: 'lt' | 'lte' | 'gt' | 'gte'; value: string | number }
  | { column: string; operator: 'like'; value: string }
  | { column: string; operator: 'between'; value: [string | number, string | number] };

export interface OrderBy {
  column: string;
  direction: 'asc' | 'desc';
}

/** Batch request body — what the client DataLoader POSTs to the server */
export interface BatchQueryRequest {
  pageId: string;
  widgets: BatchWidgetDescriptor[];
}

/** Per-widget result returned in the batch response */
export interface WidgetQueryResult {
  id: string;
  rows: Record<string, unknown>[];
  /**
   * Routing tier that served this widget (finding T3.2 — corrected to match
   * `executeForTier`'s actual behavior):
   *   'client'  — raw filtered rows returned; the client filters/aggregates in-browser
   *   'server'  — raw filtered rows returned; the middleware caches them for reuse
   *   'db'      — DB push-down: aggregated/grouped rows for an aggregation widget, OR
   *               a plain raw row slice for a NON-aggregation query whose preflight
   *               COUNT(*) exceeded the server-memory tier (that slice is cached too)
   */
  tier: 'client' | 'server' | 'db';
  rowCount: number;
  error?: string;
}

/** Full batch response */
export interface BatchQueryResponse {
  pageId: string;
  results: WidgetQueryResult[];
}
