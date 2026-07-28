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
 * SEMI-JOIN descriptor — "keep an outer row only when a matching row EXISTS in
 * `table`", emitted as `<column> IN (SELECT <foreignColumn> FROM <table> WHERE …)`.
 *
 * WHY THIS EXISTS, AND WHY A `JoinDescriptor` CANNOT REPLACE IT. A cross-source
 * filter across a relationship that is one-to-many from the querying widget's side
 * — a widget on `customers` filtered by `orders.status = 'shipped'` — means, in
 * SQL and in Studio's own in-memory pipeline (`dataSourceGraph.resolveRows`),
 * "keep the customers having AT LEAST ONE matching order". Expressed as
 * `LEFT JOIN orders ON orders.customer_id = customers.id WHERE orders.status = …`
 * it instead FANS OUT: a customer with three shipped orders contributes three
 * rows, so a `SUM(lifetime_value)` KPI reads 3×, and every count/average is wrong
 * by an unpredictable, data-dependent factor. A subquery has no such
 * multiplication — the outer row set is untouched, only filtered.
 *
 * WHY `IN (SELECT …)` RATHER THAN A CORRELATED `EXISTS`. The two are semantically
 * equivalent for the positive (non-negated) form this package emits, and both are
 * portable across pg/MySQL/SQLite. `IN (SELECT …)` wins on composition: the
 * subquery is an ORDINARY Knex query builder, so the EXACT same
 * `applySecurityPredicates` / `applyPredicates` used on the outer query apply to
 * it verbatim — the row-level-security and user-filter translation stays one
 * implementation with no clause-specific emitter (contrast the WHERE-vs-ON split,
 * which needed `applySecurityPredicatesToJoinOn`). A correlated `EXISTS` would
 * additionally need a raw `?? = ??` correlation fragment, adding a new raw-SQL
 * site to a security boundary for no expressive gain.
 *
 * NULL SEMANTICS are safe for the positive form and are the reason the negated
 * one is deliberately absent from this protocol: `x IN (…, NULL)` yields UNKNOWN
 * rather than FALSE when `x` matches nothing, and a WHERE treats UNKNOWN as
 * "exclude" — which is exactly what a semi-join wants. (`NOT IN` over a
 * NULL-bearing subquery would instead exclude EVERY row, so there is no
 * `NOT IN`/anti-join form here.) An outer row whose `column` is NULL is likewise
 * excluded, matching `dataSourceGraph`'s `normalizeJoinKey(...) !== null` guard.
 *
 * SECURITY. `table` is a SECOND TABLE REFERENCE and carries every guarantee a
 * `joins[].table` does: it is checked against `schemaAllowlist`
 * (`assertTablesAllowed`), every column it names is checked against
 * `columnAllowlist` and shape-validated, and — critically — the caller's
 * row-level-security predicate is applied INSIDE the subquery, resolved through
 * `CompiledSecurityPolicy.forJoinedTable` exactly like a joined table's. Applying
 * it only to the outer query would leak the EXISTENCE of other tenants' rows: an
 * unscoped inner SELECT returns other tenants' foreign keys, so an outer row
 * whose key collides with one of them survives a filter it should not have
 * matched. See `buildSecureQuery`'s `applySemiJoins`.
 */
export interface SemiJoinDescriptor {
  /** The foreign table the subquery selects FROM. Must be in `schemaAllowlist`. */
  table: string;
  /**
   * The OUTER column tested with `IN`. Unqualified references are qualified with
   * the enclosing table — the widget's primary table at the top level, or the
   * PARENT semi-join's `table` when nested. A qualified reference must name that
   * same enclosing table (fail-closed — see `validateSemiJoins`).
   */
  column: string;
  /**
   * The column the subquery PROJECTS, on `table`. Unqualified references are
   * qualified with `table`; a qualified reference must name `table` itself.
   */
  foreignColumn: string;
  /**
   * Predicates applied INSIDE the subquery, against `table`. Same shape,
   * allowlist and operator rules as `BatchWidgetDescriptor.filters` — they are
   * translated by the same `applyPredicates`.
   */
  filters?: FilterPredicate[];
  /**
   * Nested semi-joins, applied inside THIS subquery. One level of nesting
   * expresses a two-hop many-to-many filter (widget → junction → remote), which
   * `dataSourceGraph.findJoinPath` already models as `hops: 2`:
   *
   * ```sql
   * customers.id IN (
   *   SELECT customer_tags.customer_id FROM customer_tags
   *   WHERE customer_tags.tenant_id = ?              -- inner tenancy, per level
   *     AND customer_tags.tag_id IN (
   *       SELECT tags.id FROM tags WHERE tags.tenant_id = ? AND tags.name = ?)
   * )
   * ```
   *
   * Nesting is bounded by `MAX_SEMI_JOIN_DEPTH` — nesting is a distinct
   * client-controlled input dimension (see the Input bounds section of
   * `ARCHITECTURE.md`) and must be capped like every other one.
   */
  semiJoins?: SemiJoinDescriptor[];
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
   * (`MAX_ROWS_PER_REQUEST`) still allows. An omitted (or excessively large)
   * `limit` therefore can never make the server attempt an uncapped SELECT
   * against a multi-million-row table.
   *
   * The rows a whole BATCH returns are bounded by the same request budget:
   * `sum(results[].rows.length) <= MAX_ROWS_PER_REQUEST`. That bound is enforced
   * by failing a widget whose rows no longer fit, NOT by shortening it — a
   * budget-shortened result is indistinguishable from a normal limited page, so
   * such a widget comes back as `{ error }` instead. Set an explicit `limit` on
   * each widget (or split the page across requests) when a batch's limits would
   * otherwise sum past the budget.
   *
   * The budget does not bound PEAK concurrent materialization: up to
   * `MAX_CONCURRENT_WIDGET_QUERIES` queries can be in flight having each read the
   * same remaining allowance, and the losers are rejected when their rows are
   * charged rather than before they run.
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
  /**
   * Optional SEMI-JOIN descriptors — `<column> IN (SELECT <foreignColumn> FROM
   * <table> WHERE …)`.
   *
   * Use this, NOT a `joins[]` entry, whenever a related table is referenced only
   * to FILTER the primary rows across a one-to-many relationship: a join
   * row-multiplies the result and inflates every aggregate, while a semi-join
   * leaves the outer row set untouched. See `SemiJoinDescriptor`.
   *
   * Every semi-join table is subject to the same `schemaAllowlist`,
   * `columnAllowlist` and row-level-security guarantees a joined table is — with
   * the security predicate applied INSIDE the subquery, which is what stops it
   * from leaking the existence of other tenants' rows.
   */
  semiJoins?: SemiJoinDescriptor[];
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
  /**
   * The result rows.
   *
   * NO-MUTATION CONTRACT (finding L3) — treat this array and its row objects as
   * READ-ONLY. Two results in the same `BatchQueryResponse.results` may be the
   * SAME array instance: `handleBatchQuery` single-flights structurally identical
   * widgets (the widget `id` is deliberately excluded from the cache key), so
   * every widget attaching to one shared pipeline — and every widget served from
   * one data-cache hit — returns the pipeline's single `rows` object rather than a
   * copy. Cloning per widget would defeat the dedup's whole memory benefit, so the
   * aliasing is deliberate.
   *
   * A host that post-processes `results[i].rows` IN PLACE therefore mutates every
   * deduped sibling too — and only when the client happens to send structurally
   * identical widgets, so it presents as an intermittent bug. Copy before
   * transforming (`results[i].rows.map(...)`, not `results[i].rows.forEach(mutate)`).
   * This mirrors the no-mutation contract `CacheProvider.get` already documents for
   * the same underlying reason.
   *
   * THE ROW OBJECTS ARE ALSO SHARED WITH THE SERVER CACHE. A freshly-queried
   * result is written to the cache and returned here, and an in-process provider
   * stores what it is given by reference. `handleBatchQuery` hands the cache its
   * own copy of the ARRAY, so `push`/`splice`/`sort`/`length = 0` on this array
   * cannot reach the cache — but mutating a ROW (`rows[0].email = mask(...)`,
   * decrypting a column in place) writes into the cached entry, and every hit for
   * the remainder of that entry's TTL then serves the mutated rows to EVERY user
   * sharing the security profile. Cloning the rows per request would defeat the
   * dedup's memory benefit, so this is a contract rather than a copy: transform
   * into new objects (`rows.map((r) => ({ ...r, email: mask(r.email) }))`).
   */
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

/**
 * Full batch response.
 *
 * ENTRIES MAY ALIAS ONE ANOTHER (finding L3): two `results` whose widgets were
 * structurally identical share one `rows` array instance — see the no-mutation
 * contract on `WidgetQueryResult.rows`.
 */
export interface BatchQueryResponse {
  pageId: string;
  results: WidgetQueryResult[];
}
