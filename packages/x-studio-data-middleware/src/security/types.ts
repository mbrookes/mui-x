/**
 * Security types for @mui/x-studio-data-middleware.
 *
 * The host application extracts these from its auth middleware (JWT, session,
 * OAuth token, etc.) and passes them to handleBatchQuery(). The server package
 * never performs authentication itself — it only consumes pre-verified claims.
 *
 * SECURITY: All claim values MUST be pre-verified before construction.
 * Values are injected as Knex parameterized bindings (never string-concatenated).
 */
export interface JwtSecurityClaims {
  /** Tenant (organization) identifier — primary isolation boundary */
  tenantId: string;
  /** Authenticated user ID */
  userId: string;
  /** Role IDs the user holds */
  roleIds: string[];
  /**
   * Optional row-level access: regions the user may see.
   * When present, queries are restricted to these regions.
   * When undefined, no region restriction is applied.
   */
  regionIds?: number[];
  /**
   * Optional row-level access: department the user belongs to.
   * When present, queries are restricted to this department.
   * When undefined, no department restriction is applied.
   */
  department?: string;
}

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
   * Both are identifier-escaped via Knex `??`.
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
   */
  columns?: string[];
  /**
   * Aggregation specs for DB push-down queries.
   *
   * Non-aggregated `columns` entries become GROUP BY clauses.
   * When not set, the db tier returns grouped rows without aggregation.
   */
  aggregations?: AggregationSpec[];
  /** Client-supplied filter predicates (structured, never raw SQL) */
  filters?: FilterPredicate[];
  /** ORDER BY clauses */
  orderBy?: OrderBy[];
  /** Row limit for pagination */
  limit?: number;
  /**
   * Optional JOIN descriptors for multi-table queries.
   *
   * All joined table names must appear in `HandleBatchQueryOptions.schemaAllowlist`.
   * Security predicates are applied to the primary table only.
   */
  joins?: JoinDescriptor[];
}

/** Structured filter predicate — never a raw SQL string */
export interface FilterPredicate {
  column: string;
  operator: 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'between';
  value: string | number | boolean | string[] | number[] | [string, string] | [number, number];
}

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
   * Routing tier that served this widget:
   *   'client'  — raw rows returned, client should filter in-browser
   *   'server'  — server aggregated from in-memory cache
   *   'db'      — full DB push-down aggregation
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

/**
 * Options passed to handleBatchQuery(). The host app provides a configured
 * Knex instance; the x-studio-data-middleware package never creates DB connections.
 */
export interface HandleBatchQueryOptions {
  /**
   * Knex instance configured by the host app.
   * No direct DB imports in this package — the host wires the driver.
   */
   
  db: any; // Knex.Knex — typed as any to avoid hard Knex dependency at import time
  /**
   * Cache provider (default: built-in LRU).
   * The host app can swap in a Redis provider for multi-node deployments.
   */
  cacheProvider?: import('../cache/types').CacheProvider;
  /**
   * Allowlist of table names the middleware may query.
   * Zero-Knowledge Rule: if a requested table is not in this list, the
   * request is rejected before any query is built.
   */
  schemaAllowlist: string[];
  /**
   * Per-table column allowlist (Phase 2 — SECURITY INVARIANT #2).
   *
   * When provided, all column references in `descriptor.columns`,
   * `descriptor.filters[].column`, and `descriptor.orderBy[].column`
   * are validated against the permitted list for the relevant table.
   *
   * Qualified column names (`table.column`) are split and validated
   * against the allowlist for the named table.
   *
   * If omitted, no column-level validation is applied (for backward
   * compatibility), but this is strongly discouraged in production.
   *
   * @example
   * columnAllowlist: {
   *   orders: ['id', 'customer_id', 'total_amount', 'created_at', 'status'],
   *   customers: ['id', 'name', 'region_id'],
   * }
   */
  columnAllowlist?: Record<string, string[]>;
  /**
   * Routing thresholds (row counts).
   * Defaults: { clientTier: 10_000, serverMemoryTier: 100_000 }
   */
  thresholds?: {
    /** Max rows to use client-side filtering tier */
    clientTier?: number;
    /** Max rows to use server-memory tier (above → DB push-down) */
    serverMemoryTier?: number;
  };
}
