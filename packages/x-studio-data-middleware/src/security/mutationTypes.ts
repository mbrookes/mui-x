import type { SecurityColumnsConfig, TenancyConfig } from './authTypes';
import type { FilterPredicate } from './queryTypes';

// ─── Mutation types ───────────────────────────────────────────────────────────

/**
 * A single row mutation — insert, update, or delete.
 *
 * SECURITY: The host app controls which tables and columns are writable via
 * `HandleMutationOptions.writableColumns`. The tenant column is always set by the
 * server for inserts, and added unconditionally to WHERE for updates and deletes.
 * Values are bound as Knex parameterized bindings, never string-concatenated.
 */
export interface MutationDescriptor {
  /** Client-supplied correlation ID — echoed back in the result */
  id: string;
  /** Mutation type */
  operation: 'insert' | 'update' | 'delete';
  /** Target table — must appear in HandleMutationOptions.schemaAllowlist */
  table: string;
  /**
   * Column-value pairs to write (insert/update).
   * Keys are validated against `writableColumns` before reaching the DB.
   * Values are bound via Knex parameterized bindings.
   */
  values?: Record<string, unknown>;
  /**
   * Row-match predicates for update/delete operations.
   *
   * Tenant isolation is unconditionally enforced alongside these predicates —
   * the server appends `WHERE <tenantColumn> = claims.tenantId` regardless of
   * what the client sends. At least one predicate is required for update/delete
   * to prevent accidental full-table mutations.
   */
  where?: FilterPredicate[];
}

/** Per-mutation result */
export interface MutationResult {
  /** Echoed from MutationDescriptor.id */
  id: string;
  /** True when the mutation completed without error */
  ok: boolean;
  /** Number of rows affected (undefined on error) */
  rowsAffected?: number;
  /** Error message when ok=false */
  error?: string;
}

/** Batch mutation request body */
export interface BatchMutationRequest {
  mutations: MutationDescriptor[];
}

/** Batch mutation response */
export interface BatchMutationResponse {
  results: MutationResult[];
}

/**
 * Options passed to handleMutation(). Mirrors HandleBatchQueryOptions for
 * framework-agnostic usage — no HTTP imports required.
 */
export interface HandleMutationOptions {
  /** Knex instance configured by the host app */
  db: any; // Knex.Knex — typed as any to avoid hard Knex dependency at import time
  /**
   * Allowlist of tables the middleware may write to.
   * Any table not in this list is rejected before a query is built.
   */
  schemaAllowlist: string[];
  /**
   * Per-table column allowlist for write operations.
   *
   * Only columns listed here may appear in `MutationDescriptor.values`.
   * If omitted, no column-level validation is applied (not recommended for production).
   *
   * @example
   * writableColumns: { orders: ['status', 'notes'], customers: ['name', 'email'] }
   */
  writableColumns?: Record<string, string[]>;
  /**
   * Per-table allowlist of columns that may be referenced in `where` predicates
   * for update/delete operations.
   *
   * Mirrors `HandleBatchQueryOptions.columnAllowlist` for the write path: when
   * provided, every `MutationDescriptor.where[].column` is validated against the
   * permitted list for its table. Qualified names (`table.column`) are split and
   * validated against the named table.
   *
   * If omitted, no `where`-column validation is applied (backward compatible),
   * but supplying it is strongly recommended in production so clients cannot
   * probe rows by arbitrary columns (e.g. via update/delete row counts) within
   * their own tenant.
   *
   * @example
   * columnAllowlist: { orders: ['id', 'status', 'customer_id'] }
   */
  columnAllowlist?: Record<string, string[]>;
  /**
   * Tenancy posture for the write path (REQUIRED — no default).
   *
   * - `{ mode: 'multi-tenant', tenantColumn }` — the tenant value from
   *   `claims.tenantId` is set unconditionally on INSERT, and
   *   `WHERE <tenantColumn> = claims.tenantId` is appended unconditionally on
   *   UPDATE/DELETE. Clients cannot override or remove this predicate.
   *   `securityColumns.perTable[t].tenant` overrides the column per table.
   * - `{ mode: 'single-tenant' }` — no tenant predicate is applied. A deployment
   *   must declare this explicitly; there is no silent unscoped default.
   */
  tenancy: TenancyConfig;
  /**
   * Row-level-security column configuration for the write path.
   *
   * Lets you override the region/department column names (defaults: `region_id`
   * / `department`) and, via `perTable`, security-scope additional tables. The
   * same region/department predicates enforced on reads are applied to
   * update/delete so a user restricted to region 5 cannot write outside it.
   *
   * @default region column `region_id`, department column `department`
   */
  securityColumns?: SecurityColumnsConfig;
  /**
   * Which cache post-mutation invalidation evicts.
   *
   * INVALIDATION IS NOT OPT-IN. A successful mutation ALWAYS calls
   * `deleteByTag(table)` for the table it wrote; omitting this option falls back to
   * the SAME process-wide default provider `handleBatchQuery` uses when it is given
   * none, so a zero-config host's read path is still coherent without any
   * `/api/invalidate` call. This option only chooses WHICH cache is evicted — so
   * pass the same instance you pass to `HandleBatchQueryOptions.cacheProvider`
   * (or leave both unset). Passing it on only one of the two paths evicts a cache
   * nobody reads and leaves the one that IS read serving pre-mutation rows for a
   * full TTL.
   *
   * EVICTION NEVER FAILS THE WRITE. The rows are already committed by the time it
   * runs, so a cache-backend error is logged and the mutation still reports
   * `ok: true` — reporting a committed write as failed would invite a retry that
   * duplicates the row. Reads stay stale for at most the entry's TTL.
   *
   * Under `atomic: true` eviction runs once per DISTINCT table AFTER the commit,
   * and is skipped entirely unless every mutation in the batch succeeded: a
   * rolled-back batch changed nothing in the database, so there is nothing to
   * evict.
   */
  cacheProvider?: import('../cache/types').CacheProvider;
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
   *
   * ONE CACHE ⇒ ONE LOGICAL DATABASE (finding 2.4): a given cache provider (the
   * built-in module-singleton default, or any instance you pass) must serve exactly
   * ONE logical data source. The cache key is derived from the caller's claims, the
   * compiled security policy, and the query descriptor — it carries NO data-source
   * dimension — so pointing two option sets with different `db` connections at the
   * SAME provider makes them collide on identical keys and serve one database's rows
   * for the other's for the entry TTL. If a single process must serve multiple
   * logical databases through one shared provider, give each a distinct `cacheScope`
   * (below) so their entries stay separate; otherwise use a separate provider per DB.
   */
  cacheProvider?: import('../cache/types').CacheProvider;
  /**
   * Optional stable identity for the DATA SOURCE behind this request (finding 2.4).
   *
   * Folded into the cache key (via `generateCacheKey`) so a single process serving
   * MULTIPLE logical databases through one shared `cacheProvider` keeps their entries
   * distinct instead of colliding on the same (claims, policy, descriptor) key and
   * serving one DB's rows for the other. Use a stable per-database string (e.g. the
   * database name or a connection identifier). Omit it for the common single-database
   * case — an omitted scope produces byte-identical keys to before this option
   * existed (fully backward compatible).
   */
  cacheScope?: string;
  /**
   * Allowlist of table names the middleware may query.
   * Zero-Knowledge Rule: if a requested table is not in this list, the
   * request is rejected before any query is built.
   */
  schemaAllowlist: string[];
  /**
   * Per-table column allowlist (Phase 2 — SECURITY INVARIANT #2).
   *
   * When provided, `validateDescriptorColumns` validates every column reference
   * in the descriptor against the permitted list for the relevant table:
   * `descriptor.columns`, `descriptor.filters[].column`, `descriptor.orderBy[].column`,
   * `descriptor.aggregations[].column`, and BOTH sides of every `descriptor.joins[].on`
   * pair (the left side against the primary table, the right side against the joined
   * table). The `join.on` check is a genuine security control — a join condition is an
   * attacker-controlled channel — so it is constrained to allowlisted columns just like
   * filters and projections.
   *
   * (An ORDER BY target that names a declared aggregation alias is exempt — it is not
   * a physical column and never appears in a host's allowlist; its underlying column is
   * still validated via `aggregations[].column`.)
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
   * Tenancy posture (REQUIRED — no default).
   *
   * - `{ mode: 'multi-tenant', tenantColumn }` — a
   *   `WHERE <table>.<tenantColumn> = <claims.tenantId>` predicate is
   *   automatically added to every query. This is the primary multi-tenancy
   *   boundary. `securityColumns.perTable[t].tenant` overrides the column per
   *   table; `securityColumns.perTable[t] = null` opts a shared/lookup table out.
   * - `{ mode: 'single-tenant' }` — no tenant filter is applied — suitable for
   *   single-tenant deployments where the database has no tenant discriminator
   *   column. This must be declared explicitly: a deployment can no longer fall
   *   into an unscoped, cross-tenant-leaking state by simply omitting the field.
   *
   * @example { mode: 'multi-tenant', tenantColumn: 'tenant_id' }
   */
  tenancy: TenancyConfig;
  /**
   * Row-level-security column configuration.
   *
   * Overrides the hardcoded region/department column names (defaults:
   * `region_id` / `department`) and, via `perTable`, overrides individual
   * security-column names for tables using a different convention.
   *
   * SECURITY — joined tables are scoped by DEFAULT (fail-closed): a joined table
   * with no `perTable` entry inherits the primary table's resolved
   * tenant/region/department column names, so an unregistered join cannot
   * silently fan out to other tenants' rows. A genuinely shared/lookup table
   * with no tenant column joins unscoped ONLY via the explicit
   * `perTable[table] = null` opt-out. See `SecurityColumnsConfig` for details.
   *
   * @default region column `region_id`, department column `department`
   */
  securityColumns?: SecurityColumnsConfig;
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
  /**
   * Tier routing cache provider (default: built-in `MapTierCacheProvider`).
   *
   * The tier cache stores the routing result (client/server/db) from the
   * COUNT(*) preflight for a longer window than the data cache. This means
   * repeated cold misses after data cache expiry skip the preflight entirely.
   *
   * For multi-node deployments, supply a Redis-backed implementation.
   * Set `tierCacheTtlMs: 0` to disable the tier cache entirely.
   */
  tierCacheProvider?: import('../cache/types').TierCacheProvider;
  /**
   * TTL for tier routing cache entries in milliseconds.
   *
   * Set `tierCacheTtlMs > dataCacheTtlMs` only if you accept that tier
   * decisions may be stale when data volume shifts. Longer TTL reduces
   * COUNT(*) calls but risks wrong-tier routing after a data growth event.
   * Set to `0` to disable the tier cache entirely.
   *
   * @default 30_000 (30 seconds — aligned with the data cache default)
   */
  tierCacheTtlMs?: number;
}
