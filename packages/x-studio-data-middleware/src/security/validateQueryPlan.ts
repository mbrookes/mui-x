/**
 * Compile + validate the COLUMN-REFERENCE resolution for one widget ONCE per
 * request — the read-path analogue of `compileSecurityPolicy`.
 *
 * Gap (see the retrofit plan): alias resolution (`resolveAlias`) and allowlist
 * validation (`checkColumnAgainstAllowlist`) were run at the TOP of
 * `handleBatchQuery`, but produced NO artifact — the same
 * `BatchWidgetDescriptor`, still carrying raw logical column names and a
 * `columnAliases` map, was threaded down into `buildSecureQuery` and
 * `executeForTier`, which then EACH re-ran `resolveAlias` fresh at ~10 of their
 * own call sites (SELECT / ORDER BY / GROUP BY / aggregation columns / join `on`
 * pairs / filter predicates). Validation-at-the-top gave no structural guarantee
 * that every one of those independent re-resolution sites ran (or would keep
 * running as the files evolve) — a future site reading `descriptor.columns` /
 * `.filters` / `.orderBy` directly would silently use an unresolved logical name.
 * This is exactly the class of bug the two historical drift incidents (filter
 * predicates vs. join predicates — see `shared/columnValidation.ts`) came from.
 *
 * This module centralizes resolution + validation into one boundary object:
 *
 *   - `validateQueryPlan(descriptor, columnAllowlist)` runs the UNCONDITIONAL
 *     validators (`validateHavingAliases` / `validateAggregationAliases`) and,
 *     when a `columnAllowlist` is supplied, `validateDescriptorColumns` — reusing
 *     those EXISTING functions verbatim (no error-text changes) — then resolves
 *     every column reference ONCE via `resolveAlias` into a plan whose fields are
 *     already-resolved `ColumnRef`s.
 *   - The plan carries NO `columnAliases` field and no raw unresolved logical
 *     names, so the ambiguous client form is structurally UNREACHABLE past this
 *     boundary: downstream code reads pre-resolved `ColumnRef`s off the plan and
 *     has nothing left to (mis)resolve.
 *
 * SECURITY: this stage is behavior-preserving. Resolution funnels through the
 * SAME `resolveAlias` the validators use, so centralizing changes WHERE alias
 * resolution runs (once, here) — never WHAT a given logical reference resolves to.
 */
import type {
  BatchWidgetDescriptor,
  FilterPredicate,
  HavingPredicate,
  AggregationSpec,
} from './types';
import {
  resolveAlias,
  SAFE_ALIAS_PATTERN,
  validateAggregationAliases,
  validateDescriptorColumns,
  validateHavingAliases,
} from '../shared/columnValidation';

/**
 * A physical SQL column reference that has ALREADY been alias-resolved (through
 * `resolveAlias`) and — when a column allowlist is configured — allowlist-checked.
 *
 * Branded so a plain `string` is NOT assignable to `ColumnRef` without going
 * through `validateQueryPlan` (the only place `asColumnRef` is called). A
 * downstream function that wants a `ColumnRef` therefore cannot accidentally be
 * handed an unvalidated/unresolved raw logical name — TypeScript enforces it
 * structurally, not by convention.
 */
export type ColumnRef = string & { readonly __brand: 'ColumnRef' };

/** A `FilterPredicate` whose `column` has been resolved to a physical `ColumnRef`. */
export type ResolvedFilterPredicate = FilterPredicate extends infer T
  ? T extends { column: string }
    ? Omit<T, 'column'> & { column: ColumnRef }
    : never
  : never;

/** A resolved JOIN — every `on` pair carries physical `ColumnRef`s on both sides. */
export interface ResolvedJoin {
  table: string;
  type?: 'inner' | 'left' | 'right';
  /** `[leftColumn, rightColumn]` pairs, both alias-resolved to physical columns. */
  on: [ColumnRef, ColumnRef][];
}

/** A resolved projection column. */
export interface PlanProjectionColumn {
  /** The physical (alias-resolved) column to project. */
  physical: ColumnRef;
  /**
   * The logical output id to project the physical column AS (`?? as ??`), set
   * ONLY when the client referenced an expression field whose logical id differs
   * from its physical column. `undefined` when the client referenced the physical
   * column directly (no rename) — the column is then qualified with the primary
   * table at execution time instead.
   */
  outputAlias?: string;
}

/** A resolved aggregation. */
export interface PlanAggregation {
  /** The physical (alias-resolved) column to aggregate. */
  physical: ColumnRef;
  func: AggregationSpec['func'];
  /** Output alias — already validated as a safe identifier by `validateAggregationAliases`. */
  alias: string;
  /**
   * True when the RAW aggregation's alias equalled its RAW column (a pure measure
   * such as `SUM(total) AS total`) — such columns go only in the aggregation
   * clause, never in GROUP BY. Precomputed on the raw values to match the
   * pre-refactor `a.alias === a.column` check.
   */
  pureMeasure: boolean;
}

/** A resolved ORDER BY entry. */
export interface PlanOrderBy {
  direction: 'asc' | 'desc';
  /**
   * Set when the order target is an aggregation alias (NOT a physical column) —
   * used as-is, never qualified.
   */
  aggAlias?: string;
  /**
   * Set when the order target is a physical column — qualified with the primary
   * table at execution time.
   */
  physical?: ColumnRef;
}

/**
 * The compiled, validated column-reference plan for one widget descriptor.
 *
 * A single boundary object produced ONCE by `validateQueryPlan`. Every field is
 * already alias-resolved; there is deliberately NO `columnAliases` field and no
 * raw logical column names, so downstream `buildSecureQuery` / `executeForTier`
 * read pre-resolved `ColumnRef`s and never call `resolveAlias` themselves.
 */
export interface ValidatedQueryPlan {
  /** Primary table (carried through unchanged — table names are out of this stage's scope). */
  table: string;
  /** Resolved joins (both sides of every `on` pair alias-resolved). */
  joins: ResolvedJoin[];
  /** Resolved user filter predicates (column alias-resolved). */
  filters: ResolvedFilterPredicate[];
  /** HAVING predicates (reference aggregation aliases, not columns — carried unchanged). */
  having: HavingPredicate[];
  /** Resolved projection columns. */
  columns: PlanProjectionColumn[];
  /** Resolved aggregations. */
  aggregations: PlanAggregation[];
  /** Resolved ORDER BY entries. */
  orderBy: PlanOrderBy[];
  /** Row limit (carried through unchanged). */
  limit?: number;
  /**
   * Discriminant so `isValidatedQueryPlan` / `toValidatedQueryPlan` can tell a
   * compiled plan apart from a raw descriptor without a structural guess.
   */
  readonly kind: 'validated-query-plan';
}

/** The single cast point that mints a `ColumnRef` from a resolved physical name. */
function asColumnRef(physical: string): ColumnRef {
  return physical as ColumnRef;
}

/** Accepts only the two canonical SQL sort directions (case-insensitive). */
const SAFE_ORDER_BY_DIRECTION = /^(asc|desc)$/i;

/**
 * Validate every ORDER BY direction against a fail-closed allowlist.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured). `ob.direction` is client JSON that
 * `execute.ts` passes as the second argument of Knex `.orderBy(col, direction)`,
 * where Knex interpolates the direction token straight into the ORDER BY clause
 * rather than through a `?`/`??` binding. The TS type (`'asc' | 'desc'`) is not a
 * runtime guarantee — the wire value can be an arbitrary string (or even a
 * number/object), so constrain it to `asc`/`desc` (fail-closed), mirroring the
 * `SAFE_OPERATORS`/`SAFE_ALIAS_PATTERN` guards elsewhere in this package. Kept
 * module-private: no other consumer needs it (mutations have no ORDER BY).
 */
function validateOrderByDirections(descriptor: BatchWidgetDescriptor): void {
  for (const ob of descriptor.orderBy ?? []) {
    if (typeof ob.direction !== 'string' || !SAFE_ORDER_BY_DIRECTION.test(ob.direction)) {
      throw new Error(
        `MUI X Studio Server: ORDER BY direction "${ob.direction}" is not allowed. ` +
          `The direction is emitted into the SQL ORDER BY clause, so an unexpected value could alter the query. ` +
          `Use "asc" or "desc".`,
      );
    }
  }
}

/**
 * Validate the row LIMIT against a fail-closed non-negative-integer guard.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget (finding 3.1),
 * independent of whether a `columnAllowlist` is configured. `descriptor.limit` is
 * client JSON that `execute.ts` passes straight to Knex's `.limit()`. The TS type
 * (`number`) is not a runtime guarantee — the wire value can be a string, a float,
 * a negative number, `NaN`, or an object. Knex's dialect-specific `.limit()`
 * coercion can then SILENTLY DROP the clause (coercing a malformed value to
 * `NaN`/`undefined`), returning ALL tenant-scoped rows instead of the bounded page
 * the caller asked for. Constrain it to a non-negative integer (fail-closed),
 * mirroring the `SAFE_OPERATORS` / ORDER-BY-direction guards. `limit: 0` (a
 * legitimate "return zero rows" request) is allowed; only `undefined` means "no
 * limit". Runs per widget inside `processWidget`, so a malformed limit yields that
 * widget's own `{ error }` result rather than rejecting the whole batch.
 */
function validateLimit(descriptor: BatchWidgetDescriptor): void {
  const { limit } = descriptor;
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 0)) {
    throw new Error(
      `MUI X Studio Server: Row limit "${limit}" is not allowed. ` +
        `The limit bounds how many rows the query returns, and a malformed value can be silently coerced by the database driver into returning every tenant-scoped row. ` +
        `Use a non-negative integer (or omit "limit" for no limit).`,
    );
  }
}

/**
 * Validate every expression-field OUTPUT ALIAS against the safe-identifier charset.
 *
 * Uses the SAME shared `SAFE_ALIAS_PATTERN` (`shared/columnValidation.ts`) that
 * `validateAggregationAliases` applies to aggregation aliases — previously this
 * was a byte-identical module-private duplicate (finding 3.4); now there is one
 * definition to keep in sync if the charset is ever tightened.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured), closing the finding-3.4 gap: an
 * output alias (`PlanProjectionColumn.outputAlias` — the client's logical column
 * id, produced by `buildPlan` when a referenced column resolves to a DIFFERENT
 * physical column) reaches `execute.ts`'s `db.raw('?? as ??', [physical, outputAlias])`
 * WITHOUT the charset check its sibling `agg.alias` gets. Both are `??`-bound and
 * therefore Knex-escaped (so this is defense-in-depth, not a live injection), but
 * the intent of `validateAggregationAliases` is to constrain EVERY client-controlled
 * identifier token in the query-building path — and the output alias was the one
 * such token that skipped it. An output alias only exists when the client-referenced
 * id differs from its resolved physical column, so — mirroring `buildPlan` — only
 * those renamed references are checked; a direct physical reference never reaches
 * the alias position.
 */
function validateOutputAliases(descriptor: BatchWidgetDescriptor): void {
  for (const column of descriptor.columns ?? []) {
    const physical = resolveAlias(descriptor, column);
    // Only a rename becomes an interpolated `?? as ??` output alias (see
    // `buildPlan`); a direct physical column reference is never aliased.
    if (physical !== column && !SAFE_ALIAS_PATTERN.test(column)) {
      throw new Error(
        `MUI X Studio Server: Output alias "${column}" contains characters outside the allowed set. ` +
          `The alias is interpolated into the SQL projection as an identifier (\`?? as ??\`), so it must be a safe identifier to avoid altering the query. ` +
          `Use only letters, digits and underscores (matching ${SAFE_ALIAS_PATTERN}).`,
      );
    }
  }
}

/**
 * Close the SELECT * allowlist-bypass: when a `columnAllowlist` is configured but
 * a widget declares NO projection columns and NO aggregations, Knex would emit
 * `SELECT *` and return every column — including ones the host never allowlisted.
 * Synthesize an explicit projection from the allowlist instead (fail-closed by
 * construction). Mutates `plan.columns` in place.
 *
 *   - No allowlist entry for the table → throw fail-closed, mirroring
 *     `checkColumnAgainstAllowlist`'s "has no entry" error (context `'columns'`).
 *     Today this shape silently returns `SELECT *` — the worst variant of the bug.
 *   - Entry is `['*']` → synthesize an explicit PRIMARY-TABLE wildcard projection
 *     (`<table>.*`) rather than leaving `plan.columns` empty. `['*']` means "all
 *     columns OF THIS TABLE", which SQL expresses as `orders.*`, NOT a bare `*`.
 *     Leaving the projection empty made `executeForTier` skip `.select()` and emit
 *     a bare `SELECT *`, which returns every column of every JOINed table too —
 *     bypassing a joined table's own (stricter) allowlist entry. Qualifying the
 *     wildcard to the primary table preserves the single-table `SELECT *` opt-out
 *     while forcing joined-table columns to be named explicitly (which then route
 *     back through `checkColumnAgainstAllowlist`).
 *   - Otherwise → project exactly the allowlisted physical columns, in allowlist
 *     order, with NO `outputAlias` (direct physical columns, not expression-field
 *     renames). `executeForTier`'s `qualify()` prefixes them with the primary
 *     table at execution time, so the row shape matches an explicit projection.
 */
function synthesizeProjectionFromAllowlist(
  plan: ValidatedQueryPlan,
  table: string,
  columnAllowlist: Record<string, string[]>,
): void {
  // Own-property gate (finding 2.4), matching `checkColumnAgainstAllowlist`: a
  // primary `table` naming an inherited `Object.prototype` member would otherwise
  // read a truthy inherited value and skip the fail-closed "has no entry" throw,
  // then crash on `.includes`. Treat a non-own key as "no entry".
  const allowed = Object.prototype.hasOwnProperty.call(columnAllowlist, table)
    ? columnAllowlist[table]
    : undefined;
  if (!allowed) {
    // Same message (and therefore same extracted error code) as
    // `checkColumnAgainstAllowlist`'s "has no entry" throw — the context token is
    // interpolated so the template matches verbatim rather than forking a code.
    const context = 'columns';
    throw new Error(
      `MUI X Studio Server: Table "${table}" has no entry in the column allowlist (${context}). ` +
        `When a column allowlist is supplied, every referenced table must declare its allowed columns so unlisted tables cannot be probed. ` +
        `Add "${table}" to the allowlist (use ["*"] to allow all of its columns).`,
    );
  }
  if (allowed.includes('*')) {
    // Explicit opt-out, but scoped to the PRIMARY table's columns only. `['*']`
    // means "all columns of THIS table" → `<table>.*`, never a bare `*`. A bare
    // `*` (empty projection) would leak every column of every JOINed table,
    // bypassing that table's own allowlist entry — the Tier 1 finding. Qualifying
    // the wildcard keeps single-table `SELECT *` semantics while forcing joined
    // columns to be named explicitly (routed through `checkColumnAgainstAllowlist`).
    plan.columns = [{ physical: asColumnRef(`${table}.*`) }];
    return;
  }
  plan.columns = allowed.map((col) => ({ physical: asColumnRef(col) }));
}

/**
 * Build the resolved plan from a descriptor — PURE alias resolution, no
 * validation. Every `ColumnRef` funnels through the shared `resolveAlias`, so the
 * plan can only ever RELABEL a column the descriptor already referenced.
 */
function buildPlan(descriptor: BatchWidgetDescriptor): ValidatedQueryPlan {
  const resolve = (column: string): ColumnRef => asColumnRef(resolveAlias(descriptor, column));

  const aggAliasSet = new Set((descriptor.aggregations ?? []).map((a) => a.alias));

  const columns: PlanProjectionColumn[] = (descriptor.columns ?? []).map((column) => {
    const physical = resolve(column);
    // When the resolved physical column differs from the referenced id, the id is
    // an expression-field output alias (`?? as ??`); otherwise there is no rename.
    return physical !== (column as ColumnRef) ? { physical, outputAlias: column } : { physical };
  });

  const filters: ResolvedFilterPredicate[] = (descriptor.filters ?? []).map(
    (predicate) => ({ ...predicate, column: resolve(predicate.column) }) as ResolvedFilterPredicate,
  );

  const joins: ResolvedJoin[] = (descriptor.joins ?? []).map((join) => ({
    table: join.table,
    type: join.type,
    on: join.on.map(([left, right]): [ColumnRef, ColumnRef] => [resolve(left), resolve(right)]),
  }));

  const aggregations: PlanAggregation[] = (descriptor.aggregations ?? []).map((agg) => ({
    physical: resolve(agg.column),
    func: agg.func,
    alias: agg.alias,
    pureMeasure: agg.alias === agg.column,
  }));

  const orderBy: PlanOrderBy[] = (descriptor.orderBy ?? []).map((ob) => {
    // Normalize the direction (on the request path already validated by
    // `validateOrderByDirections`) to canonical lowercase so downstream Knex
    // `.orderBy` calls and the `PlanOrderBy` type stay canonical. `String(...)`
    // keeps this non-throwing on the direct-caller path (`toValidatedQueryPlan`),
    // which deliberately skips the validators — a non-string direction there
    // normalizes rather than crashing, preserving those callers' no-throw behavior.
    const direction = String(ob.direction).toLowerCase() as 'asc' | 'desc';
    // An ORDER BY that targets an aggregation alias must stay the alias (it is not
    // a physical column); otherwise it is a physical column, resolved + qualified.
    return aggAliasSet.has(ob.column)
      ? { direction, aggAlias: ob.column }
      : { direction, physical: resolve(ob.column) };
  });

  return {
    table: descriptor.table,
    joins,
    filters,
    having: descriptor.having ?? [],
    columns,
    aggregations,
    orderBy,
    limit: descriptor.limit,
    kind: 'validated-query-plan',
  };
}

/**
 * Compile + validate a widget descriptor's column references into a
 * `ValidatedQueryPlan`.
 *
 * Call this ONCE per widget descriptor at the top of `handleBatchQuery` and
 * thread the returned plan down in place of re-deriving validation/resolution
 * downstream. Runs, in order (matching the pre-refactor handler's intra-widget
 * order):
 *   1. `validateHavingAliases`       — UNCONDITIONAL (throws on an invalid HAVING).
 *   2. `validateAggregationAliases`  — UNCONDITIONAL (throws on an unsafe alias).
 *   3. `validateOutputAliases`       — UNCONDITIONAL (throws on an unsafe
 *      expression-field output alias — the token is interpolated into the SQL
 *      projection via `?? as ??`, finding 3.4).
 *   4. `validateOrderByDirections`   — UNCONDITIONAL (throws on a non-asc/desc
 *      direction — the token is interpolated into the SQL ORDER BY clause).
 *   5. `validateLimit`               — UNCONDITIONAL (throws on a non-integer /
 *      negative `limit` — a malformed value can be silently coerced by the DB
 *      driver into returning every tenant-scoped row, finding 3.1).
 *   6. `validateDescriptorColumns`   — ONLY when a `columnAllowlist` is supplied
 *      (throws fail-closed on an unlisted table/column).
 * then resolves every column reference into the plan and, when a `columnAllowlist`
 * is configured for a no-columns/no-aggregations widget, synthesizes an explicit
 * projection from the allowlist so Knex never falls back to `SELECT *` (fail-closed).
 *
 * The reused HAVING/aggregation/allowlist validators are the EXISTING
 * single-source-of-truth functions — this module never re-implements their logic
 * or error text.
 */
export function validateQueryPlan(
  descriptor: BatchWidgetDescriptor,
  columnAllowlist?: Record<string, string[]>,
): ValidatedQueryPlan {
  validateHavingAliases(descriptor);
  validateAggregationAliases(descriptor);
  validateOutputAliases(descriptor);
  validateOrderByDirections(descriptor);
  validateLimit(descriptor);
  if (columnAllowlist) {
    validateDescriptorColumns(descriptor, columnAllowlist);
  }
  const plan = buildPlan(descriptor);
  // Close the SELECT * bypass: a no-columns/no-aggregations widget under an
  // allowlist gets an explicit projection synthesized from the allowlist (or is
  // rejected fail-closed when its table has no entry). Aggregation widgets are
  // exempt — the db tier emits only aggregation/GROUP BY clauses, never SELECT *.
  if (columnAllowlist && plan.columns.length === 0 && plan.aggregations.length === 0) {
    synthesizeProjectionFromAllowlist(plan, descriptor.table, columnAllowlist);
  }
  return plan;
}

/** Type guard: has this already been compiled into a `ValidatedQueryPlan`? */
export function isValidatedQueryPlan(value: unknown): value is ValidatedQueryPlan {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as ValidatedQueryPlan).kind === 'validated-query-plan'
  );
}

/**
 * Coerce an enforcement-path argument to a `ValidatedQueryPlan`.
 *
 * Mirrors `toCompiledSecurityPolicy`'s dual-acceptance:
 * - Already-compiled plan (the request path) → returned as-is (no recompile,
 *   no re-resolution).
 * - Raw descriptor (direct unit-test callers of `buildSecureQuery` /
 *   `executeForTier` / `runPreflight`) → resolved on the spot via `buildPlan`.
 *   The descriptor branch deliberately does NOT run the validators: these direct
 *   callers were never routed through the handler's validation, and adding throws
 *   here would change the pre-refactor behavior of those functions (which never
 *   validated — the handler did). Resolution alone reproduces exactly what the
 *   old inline `resolveAlias` calls produced.
 */
export function toValidatedQueryPlan(
  value: ValidatedQueryPlan | BatchWidgetDescriptor,
): ValidatedQueryPlan {
  if (isValidatedQueryPlan(value)) {
    return value;
  }
  return buildPlan(value);
}
