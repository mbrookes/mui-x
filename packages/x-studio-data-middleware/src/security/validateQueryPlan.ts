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

  const orderBy: PlanOrderBy[] = (descriptor.orderBy ?? []).map((ob) =>
    // An ORDER BY that targets an aggregation alias must stay the alias (it is not
    // a physical column); otherwise it is a physical column, resolved + qualified.
    aggAliasSet.has(ob.column)
      ? { direction: ob.direction, aggAlias: ob.column }
      : { direction: ob.direction, physical: resolve(ob.column) },
  );

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
 *   1. `validateHavingAliases`      — UNCONDITIONAL (throws on an invalid HAVING).
 *   2. `validateAggregationAliases` — UNCONDITIONAL (throws on an unsafe alias).
 *   3. `validateDescriptorColumns`  — ONLY when a `columnAllowlist` is supplied
 *      (throws fail-closed on an unlisted table/column).
 * then resolves every column reference into the plan.
 *
 * These three validators are the EXISTING single-source-of-truth functions,
 * reused verbatim — this module never re-implements their logic or error text.
 */
export function validateQueryPlan(
  descriptor: BatchWidgetDescriptor,
  columnAllowlist?: Record<string, string[]>,
): ValidatedQueryPlan {
  validateHavingAliases(descriptor);
  validateAggregationAliases(descriptor);
  if (columnAllowlist) {
    validateDescriptorColumns(descriptor, columnAllowlist);
  }
  return buildPlan(descriptor);
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
