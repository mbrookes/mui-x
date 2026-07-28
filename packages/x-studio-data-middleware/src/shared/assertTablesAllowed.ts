/**
 * Shared table-allowlist assertion for @mui/x-studio-data-middleware.
 *
 * The Zero-Knowledge Rule: any table not in the caller-supplied `schemaAllowlist`
 * is rejected before any query is built. Used by BOTH the read handler
 * (`handleBatchQuery`) and the write handler (`handleMutation`) so the check —
 * and its error text — live in exactly one place.
 */
import type { BatchWidgetDescriptor, FilterPredicate, SemiJoinDescriptor } from '../security/types';
import {
  assertNoImplicitAlias,
  assertSingleDotReference,
  qualifiedTableOf,
} from './columnValidation';
import { MAX_STRING_LENGTH } from './limits';
import { assertStringArrayAllowlist } from './allowlistShape';

/**
 * Throw when a client-supplied table/column identifier exceeds
 * `MAX_STRING_LENGTH` (Tier2 finding — resource exhaustion). Shared by
 * `assertTablesAllowed` (table names) and `checkQualifiedColumn` (column
 * references) below, so both identifier classes are capped identically.
 */
function assertIdentifierLength(value: string, context: string): void {
  if (value.length > MAX_STRING_LENGTH) {
    throw new Error(
      `MUI X Studio Server: "${value.slice(0, 80)}…" (in ${context}) is ${value.length} characters long, ` +
        `which exceeds the maximum of ${MAX_STRING_LENGTH} allowed for an identifier. ` +
        `An unbounded identifier string is expensive to hash (it is folded into the query cache key) and to ` +
        `validate/compare repeatedly across a batch. Shorten the identifier in "${context}" to at most ${MAX_STRING_LENGTH} characters.`,
    );
  }
}

/**
 * Throw when any of `tables` is not present in `schemaAllowlist`.
 *
 * @param tables - Every table referenced by the request (primary + joined).
 * @param schemaAllowlist - The allowlist of queryable/writable table names.
 */
export function assertTablesAllowed(tables: string[], schemaAllowlist: string[]): void {
  // FAIL CLOSED on a mis-shaped allowlist, BEFORE the `.includes` membership test
  // below. `schemaAllowlist: string[]` is compile-time only, and the membership
  // test is `Array.prototype.includes` — handed a STRING (the shape a host gets
  // from `schemaAllowlist: process.env.STUDIO_TABLES`) it becomes
  // `String.prototype.includes`, i.e. SUBSTRING matching, and
  // `'orders_public'.includes('orders')` admits a table that was never
  // allowlisted. Re-asserted here as well as in `compileSecurityPolicy` because
  // this function is exported and reachable without compiling a policy.
  assertStringArrayAllowlist(schemaAllowlist, 'schemaAllowlist');
  // Length cap (Tier2 finding — resource exhaustion): a table name has no cap
  // on its own length anywhere else in the pipeline. Only string-typed entries
  // are checked here — a non-string table name is left to the allowlist
  // membership check below, which rejects it as "not in schema allowlist"
  // regardless of its type.
  for (const t of tables) {
    if (typeof t === 'string') {
      assertIdentifierLength(t, 'table');
    }
  }
  const invalidTables = tables.filter((t) => !schemaAllowlist.includes(t));
  if (invalidTables.length > 0) {
    // INFORMATION DISCLOSURE (finding 3.3): the client-facing message names ONLY the
    // rejected table(s), never the full allowlist. Enumerating every allowed table
    // in an error returned verbatim to any authenticated caller (`handler.ts`'s
    // per-widget `{ error }`) hands out the server's schema map. The full allowlist
    // is logged server-side for operator debugging instead.

    console.warn(
      `MUI X Studio Server: Rejected table(s) not in schema allowlist: ${invalidTables.join(', ')}. ` +
        `Allowed tables: ${schemaAllowlist.join(', ')}`,
    );
    throw new Error(
      `MUI X Studio Server: Requested table(s) not in schema allowlist: ${invalidTables.join(', ')}. ` +
        `Add the table(s) to the schema allowlist if they should be queryable.`,
    );
  }
}

/**
 * Shared by `assertQualifiedColumnsAllowed` (read path) and
 * `assertQualifiedWhereColumnsAllowed` (write path): throw when `column` is
 * table-qualified and names a table absent from `schemaAllowlist`. An
 * unqualified column, or one qualifying a table already on the allowlist, is a
 * no-op.
 *
 * RUNTIME SHAPE GUARDS (Tier3 iter26 findings 1 / 6):
 *   - `column` is typed `string` on every descriptor field this is called with
 *     (`FilterPredicate.column`, `AggregationSpec.column`, …), but the wire
 *     value is client JSON, so that type is not a runtime guarantee. A
 *     non-string `column` (e.g. `{ column: 5 }`) used to reach
 *     `qualifiedTableOf`'s `column.indexOf('.')` and throw a raw, unguarded
 *     `TypeError: column.indexOf is not a function` — escaping unsanitized
 *     past this package's own error boundary. Reject it here instead, fail
 *     closed, with this package's own `MUI X`-prefixed message.
 *   - A reference with MORE than one dot (`a.b.c` or deeper) is rejected
 *     outright via the SHARED `assertSingleDotReference`
 *     (`shared/columnValidation.ts`) — the same implementation, and therefore
 *     the same error text, the column-allowlist path uses. The rule was
 *     previously duplicated here with a different `MUI X` prefix for the
 *     identical condition.
 */
function checkQualifiedColumn(column: string, context: string, schemaAllowlist: string[]): void {
  if (typeof column !== 'string') {
    throw new Error(
      `MUI X Studio Server: Column reference in ${context} must be a string, but received ` +
        `${JSON.stringify(column)}. A non-string column reference cannot be safely checked against the schema ` +
        `allowlist. Ensure every column reference in "${context}" is a string.`,
    );
  }
  // Length cap (Tier2 finding — resource exhaustion): every column reference
  // this function validates (`columns`, `filters[].column`, `orderBy[].column`,
  // `aggregations[].column`, both sides of `joins[].on`, a mutation's
  // `where[].column`) previously had only a `typeof === 'string'` guard, with no
  // bound on how long that string could be. Checked BEFORE the dot-count/
  // qualified-table logic below so it applies uniformly whether the reference
  // is qualified or not.
  assertIdentifierLength(column, context);
  assertSingleDotReference(column, context);
  // Reject Knex's implicit `" as "` alias syntax (finding L2). Runs
  // UNCONDITIONALLY here — unlike `checkColumnAgainstAllowlist`, which only runs
  // when a `columnAllowlist` is configured — so the `schemaAllowlist`-only
  // deployment (where the silent projection-key collision actually bites) is
  // covered too. See `assertNoImplicitAlias`.
  assertNoImplicitAlias(column, context);
  const table = qualifiedTableOf(column);
  if (table === undefined || schemaAllowlist.includes(table)) {
    return;
  }
  // Mirrors `assertTablesAllowed`'s information-disclosure posture (finding
  // 3.3): the client-facing error names only the rejected table, never the
  // full allowlist; the full list is logged server-side for operator debugging.
  console.warn(
    `MUI X Studio Server: Rejected qualified column reference "${column}" (in ${context}) — ` +
      `table "${table}" is not in the schema allowlist. Allowed tables: ${schemaAllowlist.join(', ')}`,
  );
  throw new Error(
    `MUI X Studio Server: Qualified column reference "${column}" (in ${context}) names table "${table}", ` +
      `which is not in the ` +
      `schema allowlist. Every table a query can touch — including one named only through a qualified column ` +
      `reference, not just the primary table or an explicit join — must be explicitly allowlisted, or an ` +
      `unregistered table could be probed through a filter/column/orderBy reference alone. ` +
      `Add "${table}" to the schema allowlist if it should be queryable, or reference a column on an ` +
      `already-allowlisted table.`,
  );
}

/**
 * Enforce the Zero-Knowledge Rule on every table-QUALIFIED column reference in a
 * read descriptor — `columns`, `filters[].column`, `orderBy[].column`, the
 * physical (value) side of `columnAliases`, `aggregations[].column`, and both
 * sides of every `joins[].on` pair — independent of whether a `columnAllowlist`
 * is configured for this deployment.
 *
 * GAP THIS CLOSES: `assertTablesAllowed` only checks `descriptor.table` and
 * `descriptor.joins[].table` — the tables a query structurally touches via
 * FROM/JOIN. A qualified column reference such as `"other_table.balance"` inside
 * `filters` / `columns` / `orderBy` / `columnAliases` / `aggregations` / a join's
 * `on` pair names a THIRD table that never reaches that check. When a
 * `columnAllowlist` IS configured, `validateDescriptorColumns`
 * (`shared/columnValidation.ts`) happens to reject this too (it splits the
 * qualified reference and requires the named table to have its OWN allowlist
 * entry) — but that validator runs ONLY when a `columnAllowlist` is supplied
 * (`security/validateQueryPlan.ts`'s `if (columnAllowlist) {
 * validateDescriptorColumns(...) }` gate). A deployment that scopes access via
 * `schemaAllowlist` alone (no `columnAllowlist`) therefore had NO
 * application-layer check for this reference at all — the query still failed
 * CLOSED (an unregistered/nonexistent table surfaces as a raw DB error), but as
 * an opaque downstream failure instead of this package's own clear, actionable
 * error, which is an inconsistency in the "Zero-Knowledge Rule" surface (every
 * OTHER table reference gets a clean application-layer rejection). Running this
 * check unconditionally — regardless of `columnAllowlist` — closes that
 * inconsistency.
 *
 * Originally only checked `columns` / `filters` / `orderBy` / `columnAliases`;
 * `aggregations[].column` and both sides of `joins[].on` were missed (finding
 * 2.2), contradicting this function's own claim above of covering "every table a
 * query can touch" — a qualified `aggregations: [{ column: 'payroll.salary', ... }]`
 * or a qualified `join.on` side naming a non-allowlisted table sailed through on
 * a `schemaAllowlist`-only deployment. Both are now checked with the same
 * pattern.
 *
 * @param descriptor - The widget descriptor being validated.
 * @param schemaAllowlist - The allowlist of queryable table names.
 */
/**
 * Guard a `{ column }`-shaped element of a read descriptor array
 * (`filters[]`, `orderBy[]`) before its `.column` is dereferenced.
 *
 * These fields are typed as arrays of objects, but the wire value is client
 * JSON, so a `null`/`undefined`/primitive ELEMENT (e.g. `filters: [null]`) is
 * not a runtime impossibility. Dereferencing `.column` on it (`null.column`)
 * would throw a raw `TypeError`; while that is currently caught downstream by
 * `sanitizeBoundaryError` (inside `processWidget`'s try) and degraded to a
 * generic message, rejecting it here — the write path's
 * `assertValidBatchMutationRequest` does the equivalent up front — yields this
 * package's own precise, `MUI X`-prefixed error instead.
 *
 * REQUIRED STRING FIELDS (finding L1) — the object check alone is not enough for
 * every array. `filters`/`orderBy` hand their `.column` straight to
 * `checkQualifiedColumn`, which has its own non-string guard, so they need no
 * extra fields. But `aggregations` and `having` are dereferenced by validators
 * that do NOT guard: `validateQueryPlan` calls `resultKeyOf(resolveAlias(d,
 * agg.column))` (→ `undefined.lastIndexOf`), `validateAggregationAliases` reads
 * `agg.alias.length`, and `validateHavingAliases` reads `h.alias`/`h.value`. Each
 * of those produced a raw `TypeError` that `sanitizeBoundaryError` then replaced
 * with the generic "could not be completed" message — so the caller learned
 * nothing about what was malformed, the exact outcome these up-front guards exist
 * to prevent everywhere else. Naming the required string fields here closes that
 * inconsistency for the two arrays that lacked it.
 */
function assertPredicateElementShape(
  element: unknown,
  context: string,
  requiredStringFields: readonly string[] = [],
): void {
  const expectedFields =
    requiredStringFields.length > 0
      ? requiredStringFields.map((field) => `"${field}"`).join(' and ')
      : '"column"';
  if (typeof element !== 'object' || element === null) {
    throw new Error(
      `MUI X Studio Server: Malformed entry in "${context}" — expected a predicate object with a ${expectedFields} field, ` +
        `but received ${JSON.stringify(element)}. A null or non-object entry has no ${expectedFields} to validate against ` +
        `the schema allowlist. Ensure every entry in "${context}" is an object with a ${expectedFields} field.`,
    );
  }
  for (const field of requiredStringFields) {
    const value = (element as Record<string, unknown>)[field];
    if (typeof value !== 'string') {
      throw new Error(
        `MUI X Studio Server: Malformed entry in "${context}" — its "${field}" must be a string, but received ` +
          `${JSON.stringify(value)}. A missing or non-string "${field}" cannot be resolved into a column reference ` +
          `or SQL identifier, and would otherwise surface as a confusing internal error instead of a clean ` +
          `validation failure. Ensure every entry in "${context}" declares a string "${field}".`,
      );
    }
  }
}

/**
 * Every table named by a descriptor's `semiJoins` tree, in declaration order,
 * with duplicates removed.
 *
 * ONE definition with THREE consumers, deliberately — `handler.ts` feeds it to
 * `assertTablesAllowed` (a semi-join table is a real FROM clause and must pass
 * the Zero-Knowledge Rule exactly like a `joins[].table`) AND to the data-cache
 * write's `tags` (a mutation to a semi-joined table changes which outer rows the
 * subquery admits, so a cached result that ignored it would serve pre-mutation
 * rows for the whole TTL — the same reasoning that made joined tables tagged).
 * A fourth consumer would be a fourth chance for the recursion to be re-derived
 * slightly differently.
 *
 * Deliberately TOLERANT of a malformed tree (non-array `semiJoins`, `null`
 * entries, non-string `table`): it runs BEFORE `validateSemiJoins`, whose job is
 * to reject those shapes with a precise message. Skipping a non-string `table`
 * here rather than throwing is what lets that message be the one the caller sees;
 * a skipped entry is never silently queried, because the same malformed entry
 * fails validation moments later.
 */
export function collectSemiJoinTables(semiJoins: SemiJoinDescriptor[] | undefined): string[] {
  const tables: string[] = [];
  const visit = (entries: SemiJoinDescriptor[] | undefined): void => {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      if (typeof entry.table === 'string' && !tables.includes(entry.table)) {
        tables.push(entry.table);
      }
      visit(entry.semiJoins);
    }
  };
  visit(semiJoins);
  return tables;
}

export function assertQualifiedColumnsAllowed(
  descriptor: BatchWidgetDescriptor,
  schemaAllowlist: string[],
): void {
  // Fail closed on a mis-shaped allowlist before `checkQualifiedColumn`'s
  // `.includes` membership test — see `assertTablesAllowed`. Asserted once per
  // descriptor rather than once per column reference.
  assertStringArrayAllowlist(schemaAllowlist, 'schemaAllowlist');
  for (const column of descriptor.columns ?? []) {
    checkQualifiedColumn(column, 'columns', schemaAllowlist);
  }
  for (const filter of descriptor.filters ?? []) {
    assertPredicateElementShape(filter, 'filters');
    checkQualifiedColumn(filter.column, 'filters', schemaAllowlist);
  }
  for (const orderBy of descriptor.orderBy ?? []) {
    assertPredicateElementShape(orderBy, 'orderBy');
    checkQualifiedColumn(orderBy.column, 'orderBy', schemaAllowlist);
  }
  for (const physical of Object.values(descriptor.columnAliases ?? {})) {
    if (typeof physical === 'string') {
      checkQualifiedColumn(physical, 'columnAliases', schemaAllowlist);
    }
  }
  for (const agg of descriptor.aggregations ?? []) {
    // `column` AND `alias` are both required strings here (finding L1):
    // `validateQueryPlan` dereferences `agg.column` through `resultKeyOf` and
    // `validateAggregationAliases` reads `agg.alias.length`, neither of which
    // guards the type itself.
    assertPredicateElementShape(agg, 'aggregations', ['column', 'alias']);
    checkQualifiedColumn(agg.column, 'aggregations', schemaAllowlist);
  }
  // HAVING predicates carry NO column reference — they may only name an
  // aggregation alias (`validateHavingAliases` enforces that) — so there is
  // nothing here to check against the schema allowlist. They are shape-guarded
  // anyway (finding L1) because this is the package's up-front, per-widget shape
  // gate for every client-supplied descriptor array, and `having` was the one
  // array it did not cover: a `having: [null]` reached `validateHavingAliases`'s
  // unguarded `h.alias` dereference and produced a raw `TypeError` that
  // `sanitizeBoundaryError` degraded to the generic "could not be completed"
  // message, telling the caller nothing about what was malformed.
  for (const having of descriptor.having ?? []) {
    assertPredicateElementShape(having, 'having', ['alias']);
  }
  for (const join of descriptor.joins ?? []) {
    // Guard a null/non-object join element before dereferencing `.table` / `.on`,
    // mirroring `assertPredicateElementShape` for the other descriptor arrays.
    // `joins` is typed as an array of objects, but the wire value is client JSON,
    // so a `null`/primitive element (e.g. `joins: [null]`) is not a runtime
    // impossibility; dereferencing it would throw a raw `TypeError`. Rejecting it
    // here yields this package's own precise, `MUI X`-prefixed error instead.
    if (typeof join !== 'object' || join === null) {
      throw new Error(
        `MUI X Studio Server: Malformed entry in "joins" — expected a join descriptor object with a "table" field, ` +
          `but received ${JSON.stringify(join)}. A null or non-object entry has no "table" to validate against ` +
          `the schema allowlist. Ensure every entry in "joins" is an object with a "table" field.`,
      );
    }
    // Guard the `on` COLLECTION before iterating it (finding L1). `for (const
    // pair of join.on ?? [])` only substitutes for `null`/`undefined` — a present
    // non-iterable (`on: {}`, `on: 5`) threw a raw `TypeError: join.on is not
    // iterable` from this very loop, PRE-EMPTING `validateJoinOnPairs`'s clean
    // "has no 'on' conditions" message downstream (that validator runs later, in
    // `validateQueryPlan`). Checking here keeps the first thing a caller hits an
    // actionable `MUI X` error, consistent with every sibling array on the
    // descriptor. An OMITTED `on` still falls through to `validateJoinOnPairs`,
    // which owns the "a join must declare at least one condition" rule.
    if (join.on !== undefined && !Array.isArray(join.on)) {
      throw new Error(
        `MUI X Studio Server: Malformed "joins[].on" for table "${join.table}" — expected an array of ` +
          `[left, right] column pairs, but received ${JSON.stringify(join.on)}. A non-array "on" cannot be ` +
          `iterated to validate its column references against the schema allowlist, and would otherwise throw a ` +
          `confusing internal error instead of a clean validation failure. ` +
          `Provide "on" as an array of [leftColumn, rightColumn] tuples.`,
      );
    }
    for (const pair of join.on ?? []) {
      if (!Array.isArray(pair)) {
        throw new Error(
          `MUI X Studio Server: Malformed entry in "joins.on" — expected a [left, right] column pair, ` +
            `but received ${JSON.stringify(pair)}. A non-array "on" entry cannot be destructured into a ` +
            `column pair to validate against the schema allowlist. Ensure every "joins[].on" entry is a ` +
            `[left, right] tuple of column references.`,
        );
      }
      const [left, right] = pair;
      checkQualifiedColumn(left, 'joins.on', schemaAllowlist);
      checkQualifiedColumn(right, 'joins.on', schemaAllowlist);
    }
  }
  // SEMI-JOINS: the subquery's own column references are the same class of
  // qualified reference every field above carries, and reach the same
  // `qualifyAgainst`/Knex identifier path. A qualified reference naming an
  // unlisted table (`semiJoins[0].filters[0].column = "payroll.salary"`) would
  // otherwise be the one shape that skipped the unconditional Zero-Knowledge
  // check on a `schemaAllowlist`-only deployment — the exact gap this function's
  // docblock records having had to close twice already, once for `aggregations`
  // and once for `joins.on`. Walked recursively so a NESTED semi-join's
  // references are covered too. `semiJoins[].table` itself is checked by
  // `assertTablesAllowed` via `collectSemiJoinTables`.
  const checkSemiJoinColumns = (entries: SemiJoinDescriptor[] | undefined): void => {
    if (entries !== undefined && !Array.isArray(entries)) {
      throw new Error(
        `MUI X Studio Server: Malformed "semiJoins" — expected an array of semi-join descriptors, but ` +
          `received ${JSON.stringify(entries)}. A non-array value cannot be iterated to validate its column ` +
          `references against the schema allowlist, and would otherwise throw a confusing internal error ` +
          `instead of a clean validation failure. Provide "semiJoins" as an array (or omit it).`,
      );
    }
    for (const semiJoin of entries ?? []) {
      assertPredicateElementShape(semiJoin, 'semiJoins', ['table', 'column', 'foreignColumn']);
      checkQualifiedColumn(semiJoin.column, 'semiJoins.column', schemaAllowlist);
      checkQualifiedColumn(semiJoin.foreignColumn, 'semiJoins.foreignColumn', schemaAllowlist);
      if (semiJoin.filters !== undefined && !Array.isArray(semiJoin.filters)) {
        throw new Error(
          `MUI X Studio Server: Malformed "semiJoins[].filters" for table "${semiJoin.table}" — expected an ` +
            `array of filter predicates, but received ${JSON.stringify(semiJoin.filters)}. A non-array value ` +
            `cannot be iterated to validate its column references against the schema allowlist, and would ` +
            `otherwise throw a confusing internal error instead of a clean validation failure. ` +
            `Provide "filters" as an array (or omit it).`,
        );
      }
      for (const predicate of semiJoin.filters ?? []) {
        assertPredicateElementShape(predicate, 'semiJoins.filters');
        checkQualifiedColumn(predicate.column, 'semiJoins.filters', schemaAllowlist);
      }
      checkSemiJoinColumns(semiJoin.semiJoins);
    }
  };
  checkSemiJoinColumns(descriptor.semiJoins);
}

/**
 * Enforce the Zero-Knowledge Rule on every table-QUALIFIED `where[].column`
 * reference in a WRITE (mutation) descriptor — the write-path analogue of
 * `assertQualifiedColumnsAllowed` above. Runs unconditionally, independent of
 * whether `HandleMutationOptions.columnAllowlist` is configured for this
 * deployment, mirroring the read path's unconditional posture.
 *
 * GAP THIS CLOSES: on the read path, a qualified column reference naming a
 * table absent from `schemaAllowlist` always gets a clean, actionable
 * `MUI X`-prefixed rejection via `assertQualifiedColumnsAllowed` above — even
 * when no `columnAllowlist` is configured. The write path had no equivalent:
 * `handleMutation` only ran `assertTablesAllowed` (primary table only — a
 * mutation never joins), so a qualified `where[].column` (the one
 * client-controlled qualified reference `applyPredicate` emits verbatim into
 * `query.where(where[].column, …)`) was only checked against a table
 * allowlist when `options.columnAllowlist` happened to be configured (via
 * `validateMutation` → `checkColumnAgainstAllowlist`). A
 * `schemaAllowlist`-only deployment therefore had no application-layer
 * rejection for this reference — the query still failed CLOSED (mutations are
 * always single-table with the tenant predicate AND-ed in first, and
 * `sanitizeBoundaryError` generalizes the resulting driver error to a generic
 * message), but as an opaque downstream failure rather than this package's own
 * clear error, the same inconsistency `assertQualifiedColumnsAllowed` closes
 * for reads. Running this check unconditionally closes it for writes too.
 *
 * @param where - The mutation descriptor's `where` predicates, if any.
 * @param schemaAllowlist - The allowlist of writable table names.
 */
export function assertQualifiedWhereColumnsAllowed(
  where: FilterPredicate[] | undefined,
  schemaAllowlist: string[],
): void {
  // Fail closed on a mis-shaped allowlist before `checkQualifiedColumn`'s
  // `.includes` membership test — see `assertTablesAllowed`.
  assertStringArrayAllowlist(schemaAllowlist, 'schemaAllowlist');
  for (const predicate of where ?? []) {
    checkQualifiedColumn(predicate.column, 'where', schemaAllowlist);
  }
}
