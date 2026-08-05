/**
 * Secure Knex mutation builder for @mui/x-studio-data-middleware.
 *
 * Applies the same security invariants as `buildSecureQuery` to write operations:
 *   1. Tenant column is set unconditionally on INSERT and scoped unconditionally
 *      on UPDATE/DELETE — clients cannot override or remove it. The tenant column
 *      is resolved via `resolvePrimarySecurityColumns` from the required
 *      `TenancyConfig` (multi-tenant → `tenancy.tenantColumn`, with an optional
 *      `securityColumns.perTable[t].tenant` override; single-tenant → no tenant
 *      column), exactly as the read/update/delete paths do.
 *   2. Column values are bound via Knex parameterized bindings (never string concat).
 *   3. Table and column names are validated against caller-supplied allowlists
 *      BEFORE reaching these functions (see `validateMutation` below).
 *   4. UPDATE and DELETE require at least one `where` predicate to prevent
 *      accidental full-table mutations.
 *   5. A client-supplied tenant column in `values` is REJECTED fail-closed, not
 *      silently overridden/stripped: `validateMutation` → `validateSecurityColumnValues`
 *      THROWS on it before any write is built, so a client can never move a row to,
 *      or stamp one into, a different tenant. The INSERT force-stamp and the UPDATE
 *      tenant-strip below are defense-in-depth for DIRECT builder callers that skip
 *      `validateMutation` (INSERT also re-runs the throwing check first). Every
 *      `values` KEY is shape-validated unconditionally by `assertValueKeysWellFormed`
 *      — table-qualified keys (`table.column`) are rejected outright (mutation values
 *      always target exactly one table, so a qualified key is malformed input and
 *      would otherwise bypass the row-level-security scope check below, which matches
 *      on bare column names), as are over-long keys and keys carrying Knex's implicit
 *      `" as "` alias syntax. Only the writable-columns MEMBERSHIP check is gated on
 *      `options.writableColumns`.
 *   6. Region/department scope is validated on INSERT/UPDATE values so a caller
 *      restricted to a region/department cannot write outside it.
 *   7. Value SHAPES are validated, not just value KEYS: a mutation value must be a
 *      scalar (`string | number | boolean | null | Date`), mirroring the read path's
 *      `isScalarComparisonValue` guard on filter values. An array/object value is
 *      rejected fail-closed rather than handed to the driver, where it is either
 *      silently coerced to `"[object Object]"` (mysql2 — data corruption reported as
 *      success) or raises an opaque error (pg). See `validateMutationValues`.
 *
 * NON-DISCLOSURE POSTURE: errors thrown here are returned to the client verbatim
 * (`handleMutation` → `sanitizeBoundaryError` passes `MUI X`-prefixed messages
 * through), so no message names a row-level-security COLUMN — otherwise a caller
 * could probe `values: { tenant_id: 1 }`, `{ org_id: 1 }`, … and read the deployment's
 * tenancy/region/department schema straight out of the rejections. The full detail is
 * `console.warn`-ed server-side, the same split `shared/columnValidation.ts` applies
 * to a column-allowlist rejection.
 *
 * OWASP note: Parameterized queries (Defense Option 1) are used throughout.
 * No raw SQL strings are constructed from user input.
 */
import type {
  JwtSecurityClaims,
  MutationDescriptor,
  HandleMutationOptions,
  SecurityColumns,
} from '../security/types';
import { applyPredicates, applySecurityPredicates } from '../shared/predicates';
import {
  assertColumnReferenceShape,
  checkColumnAgainstAllowlist,
} from '../shared/columnValidation';
import {
  toCompiledSecurityPolicy,
  type CompiledSecurityPolicy,
  type SecurityPolicyOptions,
} from '../security/compileSecurityPolicy';

/**
 * Resolve the PRIMARY-table security columns through a `CompiledSecurityPolicy`.
 *
 * - Compiled policy (the request path) → used as-is (no recompile).
 * - Raw `SecurityPolicyOptions` (direct callers) → compiled on the spot, so the
 *   resolution chain runs inside `compileSecurityPolicy` and never inline here.
 *
 * There is no legacy string arm: the ONLY way to configure tenancy is the
 * `tenancy` field inside a `SecurityPolicyOptions` / `CompiledSecurityPolicy`.
 */
function resolvePrimaryCols(
  table: string,
  policy: CompiledSecurityPolicy | SecurityPolicyOptions,
): SecurityColumns {
  return toCompiledSecurityPolicy(policy).forPrimaryTable(table);
}

/**
 * Validate the SHAPE of every key in a mutation's `values` — unconditionally,
 * independent of whether a `writableColumns` allowlist is configured.
 *
 * Two rules, in order:
 *
 * 1. **No table-qualified key** (`table.column`). Mutation `values` always target
 *    exactly ONE table, so keys must be bare column names. A qualified key is
 *    malformed input on two counts: Knex would render it as a qualified
 *    identifier in an INSERT column list / UPDATE SET clause (invalid SQL on
 *    mainstream databases), and — more importantly — it would slip past the
 *    row-level-security scope checks in `validateSecurityColumnValues`, which
 *    match on bare column names, letting a caller stamp e.g. `'orders.region_id'`
 *    outside their scope. Mirrors the `indexOf('.')` convention used by
 *    `checkColumnAgainstAllowlist`. Being an ANY-dot rejection, it strictly
 *    subsumes `assertSingleDotReference` for this reference class, which is why
 *    the shared shape check below adds nothing on that axis.
 * 2. **The shared identifier-shape checks** (`assertColumnReferenceShape`) —
 *    length cap and the implicit-`" as "`-alias rejection. These
 *    used to run ONLY inside `checkColumnAgainstAllowlist`, i.e. only when
 *    `options.writableColumns` happened to be configured, making them the one
 *    conditionally-run identifier check in the package: every sibling entry point
 *    (`assertQualifiedColumnsAllowed` on the read path,
 *    `assertQualifiedWhereColumnsAllowed` for `where[].column` in this same
 *    batch) runs them unconditionally. On a `schemaAllowlist`-only deployment,
 *    `values: { "status as x": "shipped" }` therefore reached real Knex and
 *    rendered `update "orders" set "status" as "x" = 'shipped'`. That fails
 *    CLOSED — it is a syntax error and Knex identifier-quotes both halves, so
 *    nothing is injectable — but it surfaces as an opaque driver error that
 *    `sanitizeBoundaryError` flattens into the generic "could not be completed"
 *    message, which is exactly the outcome `assertNoImplicitAlias` was written to
 *    prevent (its own docblock notes the read path runs it unconditionally "so
 *    the `schemaAllowlist`-only deployment … is covered too").
 *
 * MEMBERSHIP — "is this column writable?" — stays gated on `writableColumns` in
 * `validateMutation`, because it is unanswerable without an allowlist. Shape is
 * always answerable, so it is always answered.
 */
function assertValueKeysWellFormed(values: Record<string, unknown>, table: string): void {
  for (const key of Object.keys(values)) {
    if (key.includes('.')) {
      throw new Error(
        `MUI X Studio Server: Mutation value key "${key}" is table-qualified. ` +
          `Mutation values always target exactly one table ("${table}"), so keys must be bare column names — ` +
          `a qualified key would bypass row-level-security scope validation. ` +
          `Use the bare column name instead.`,
      );
    }
    assertColumnReferenceShape(key, 'values');
  }
}

/**
 * Is `value` a legitimate scalar for a mutation `values` entry?
 *
 * Deliberately the same primitive allowlist `shared/predicates.ts`'s
 * `isScalarComparisonValue` applies to READ filter values — the write path had
 * no value-shape guard at all, which is the asymmetry this closes.
 * `null` is accepted (writing SQL NULL is a legitimate mutation); `Date` is
 * accepted because a date-typed column value legitimately flows through as a
 * `Date` and every driver binds it natively.
 */
function isScalarMutationValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  );
}

/** Describe a rejected mutation value's shape for an error message. */
function describeMutationValueShape(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a value of type "${typeof value}"`;
}

/**
 * Reject any non-scalar value in a mutation's `values`.
 *
 * Before this check, `values` keys were validated three ways (writable-column
 * allowlist, row-level-security scope, qualified-key rejection) but the VALUES
 * themselves were never inspected — only their length, and only when they were
 * already strings (`handleMutation`'s `MAX_STRING_VALUE_LENGTH` cap). So
 * `{ notes: { a: [ …100k entries… ] } }` passed every check in the package and
 * reached `db(table).insert(values)` directly, where the outcome is
 * driver-dependent and uniformly bad: `mysql2` coerces the object to the literal
 * string `"[object Object]"` and SILENTLY writes it to a TEXT column (data
 * corruption reported to the client as `ok: true`), while `pg` raises an opaque
 * driver error that `sanitizeBoundaryError` flattens into the generic
 * "could not be completed" message. Neither is diagnosable, and neither bounds
 * the value's size or nesting depth.
 *
 * Fail closed instead: a mutation value must be a scalar the driver can bind
 * unambiguously. A host with a genuine JSON column serializes it itself
 * (`JSON.stringify`) before sending, which also makes the
 * `MAX_STRING_VALUE_LENGTH` cap apply to it.
 */
function validateMutationValues(values: Record<string, unknown>, table: string): void {
  for (const [key, value] of Object.entries(values)) {
    if (!isScalarMutationValue(value)) {
      throw new Error(
        `MUI X Studio Server: Mutation value for column "${key}" on table "${table}" is ` +
          `${describeMutationValueShape(value)}, but only scalar values (string, number, boolean, null, Date) ` +
          `may be written. ` +
          `A non-scalar value has no unambiguous column binding — depending on the driver it is silently coerced ` +
          `to "[object Object]" and written as corrupt data, or it raises an opaque driver error — and it is ` +
          `unbounded in size and nesting depth. ` +
          `Send a scalar for "${key}"; if the column stores JSON, serialize the value yourself before sending it.`,
      );
    }
  }
}

/**
 * Validate the row-level-security scope carried in a mutation's `values`.
 *
 * - The tenant column may never be client-supplied (the server sets it).
 * - When the caller is region/department restricted, any region/department value
 *   present in `values` must fall inside the caller's scope — otherwise a
 *   region-5 user could stamp a row into region 6.
 *
 * INFORMATION DISCLOSURE: every throw below reaches the client
 * verbatim (`handleMutation` → `sanitizeBoundaryError` passes `MUI X`-prefixed
 * messages through unchanged), so none of them names the row-level-security
 * COLUMN. Naming it turned a rejected write into a schema oracle: probing
 * `values: { tenant_id: 1 }`, `{ org_id: 1 }`, … until the message changed
 * confirmed the deployment's exact tenant/region/department column names. The
 * full detail — including the column name — is `console.warn`-ed server-side
 * instead, exactly the split `shared/columnValidation.ts` already applies to a
 * column-allowlist rejection. The client still learns the CLASS of violation,
 * which is all it needs to fix its own request.
 */
function validateSecurityColumnValues(
  values: Record<string, unknown>,
  claims: JwtSecurityClaims,
  cols: SecurityColumns,
  table: string,
): void {
  if (cols.tenant && Object.prototype.hasOwnProperty.call(values, cols.tenant)) {
    console.warn(
      `MUI X Studio Server: Column "${cols.tenant}" on table "${table}" cannot be set by client mutations ` +
        `(it is the tenant isolation column and is controlled by the server). ` +
        `The client-facing error omits the column name so a rejected mutation cannot be used to probe it.`,
    );
    throw new Error(
      `MUI X Studio Server: A mutation on table "${table}" set this table's tenant isolation column, which is ` +
        `controlled by the server and can never be supplied by a client. ` +
        `The column is not named here because that would let a rejected mutation be used to discover the ` +
        `deployment's tenancy schema; it is logged server-side instead. ` +
        `Remove the server-controlled tenancy column from "values" — the server stamps it from the caller's own claims.`,
    );
  }

  // Distinguish "no region scoping" (`regionIds === undefined`) from "authorized
  // for zero regions" (`regionIds === []`). With `[]`, `[].includes(region)` is
  // always false, so ANY region value in `values` is (correctly) rejected — a
  // caller scoped to zero regions must not be able to stamp a row into any region.
  if (
    cols.region &&
    claims.regionIds !== undefined &&
    Object.prototype.hasOwnProperty.call(values, cols.region)
  ) {
    const region = values[cols.region];
    // Reject a non-scalar region value (array/object) fail-closed BEFORE the
    // string comparison below. `String([5])` is `"5"` and `String(["5"])` is
    // `"5"`, so an array value would coincidentally stringify-match a permitted
    // `regionIds` entry and slip through the scope check — writing a non-scalar
    // into the region column. A region is always a single scalar (number/string),
    // so anything that stringifies from an object is not a valid region value.
    if (region !== null && typeof region === 'object') {
      console.warn(
        `MUI X Studio Server: Column "${cols.region}" on table "${table}" received ${Array.isArray(region) ? 'an array' : 'an object'} ` +
          `instead of a scalar region identifier. ` +
          `The client-facing error omits the column name so a rejected mutation cannot be used to probe it.`,
      );
      throw new Error(
        `MUI X Studio Server: A mutation on table "${table}" set this table's region-scope column to ${Array.isArray(region) ? 'an array' : 'an object'}; it must be a scalar region identifier. ` +
          `A non-scalar value cannot be validated against the caller's permitted regions and would corrupt row-level scoping. ` +
          `The column is not named here because that would let a rejected mutation be used to discover the deployment's row-level-security schema; it is logged server-side instead. ` +
          `Send a single number or string for the region column.`,
      );
    }
    // Compare as strings on both sides. `claims.regionIds` is typed `number[]`,
    // but a deployment whose region column is TEXT-typed sends a string region
    // value; a strict `Array.prototype.includes` (SameValueZero) comparison would
    // then never match `"5"` against `[5]` and reject a legitimate scoped write
    // with a confusing "outside the caller's permitted regions" error. Normalizing
    // both sides keeps this direction fail-closed (a value not in the permitted set
    // still throws) while tolerating a numeric/string type mismatch.
    if (!claims.regionIds.some((id) => String(id) === String(region))) {
      console.warn(
        `MUI X Studio Server: Column "${cols.region}" on table "${table}" was set to "${String(region)}", which is ` +
          `outside the caller's permitted regions (${claims.regionIds.join(', ') || 'none'}). ` +
          `The client-facing error omits the column name so a rejected mutation cannot be used to probe it.`,
      );
      throw new Error(
        `MUI X Studio Server: A mutation on table "${table}" set this table's region-scope column to "${String(region)}", which is outside the caller's permitted regions. ` +
          `A mutation cannot write a row into a region the caller cannot access. ` +
          `The column is not named here because that would let a rejected mutation be used to discover the deployment's row-level-security schema; it is logged server-side instead. ` +
          `Permitted region(s): ${claims.regionIds.join(', ') || '(none)'}.`,
      );
    }
  }

  // `!== undefined` (not truthiness), mirrors the region `undefined`-vs-`[]` distinction above.
  // `claims.department === ''` used to be indistinguishable from "no department scoping" (both
  // falsy), so a caller with an empty-string department claim could stamp ANY department value into
  // `values` unchecked — fail OPEN. Gating on `undefined` instead means a defined (even
  // empty-string) department claim always enforces the scope check below.
  //
  // Compare as strings on both sides, mirroring the region dimension above
  // (`String(id) === String(region)`). `claims.department` is typed `string`,
  // but a deployment whose department column is NUMBER-typed sends a numeric
  // `values[cols.department]`; a strict `!==` comparison would then never match
  // `5` against `"5"` and reject a legitimate in-department write with a
  // confusing "outside the caller's department" error. Normalizing both sides
  // keeps this direction fail-closed (an out-of-department value still throws)
  // while tolerating a numeric/string type mismatch, symmetric with region.
  if (
    cols.department &&
    claims.department !== undefined &&
    Object.prototype.hasOwnProperty.call(values, cols.department) &&
    String(values[cols.department]) !== String(claims.department)
  ) {
    console.warn(
      `MUI X Studio Server: Column "${cols.department}" on table "${table}" was set to ` +
        `"${String(values[cols.department])}", which is outside the caller's department ("${claims.department}"). ` +
        `The client-facing error omits the column name so a rejected mutation cannot be used to probe it.`,
    );
    throw new Error(
      `MUI X Studio Server: A mutation on table "${table}" set this table's department-scope column to "${String(values[cols.department])}", which is outside the caller's department. ` +
        `A mutation cannot write a row into a department the caller does not belong to. ` +
        `The column is not named here because that would let a rejected mutation be used to discover the deployment's row-level-security schema; it is logged server-side instead. ` +
        `Caller department: "${claims.department}".`,
    );
  }
}

/**
 * INSERT-only: ensure a region/department-restricted caller writes an IN-SCOPE row.
 *
 * Tenant is force-stamped on insert, but region/department were only
 * validated WHEN PRESENT (`validateSecurityColumnValues` gates on the key existing).
 * A region-restricted caller that simply OMITTED `region_id` therefore inserted a
 * region-NULL / DB-default (out-of-scope) row, escaping its own row-level read
 * scope on the write path — a genuine row-level-security write gap (bounded within
 * the tenant, but region-unrestricted users then see the orphaned row).
 *
 * This fails closed for INSERT: when the caller carries a region/department scope
 * and the column is configured, an in-scope value is REQUIRED. Where the server can
 * unambiguously derive it, it is auto-stamped (returned as a stamp); otherwise the
 * caller must supply it (throws):
 *   - region, caller has exactly ONE region → auto-stamp that region.
 *   - region omitted, caller has zero or MANY regions → throw (the server cannot
 *     pick a region; the caller must send an in-scope `region_id`).
 *   - region present in `values` → left to `validateSecurityColumnValues`'s
 *     in-scope check; not restamped here.
 *   - department (single-valued) → auto-stamp the caller's department when omitted.
 *
 * Returns the security-column values to STAMP onto the insert payload. It never
 * mutates `values`, so it is safe to call from BOTH the validation pre-flight
 * (which discards the stamps, wanting only the fail-closed throw) and the builder
 * (which applies them) — mirroring how the tenant column is validated in one place
 * and stamped in another.
 */
function resolveInsertScopeStamps(
  values: Record<string, unknown>,
  claims: JwtSecurityClaims,
  cols: SecurityColumns,
  table: string,
): Record<string, unknown> {
  const stamps: Record<string, unknown> = {};

  if (cols.region && claims.regionIds !== undefined) {
    const present = Object.prototype.hasOwnProperty.call(values, cols.region);
    if (!present) {
      if (claims.regionIds.length === 1) {
        // Exactly one authorized region — the server can safely derive it.
        [stamps[cols.region]] = claims.regionIds;
      } else {
        // Same non-disclosure split as `validateSecurityColumnValues`: the column name goes to the
        // server log, never to the client.
        console.warn(
          `MUI X Studio Server: An insert into region-scoped table "${table}" did not set the region column ` +
            `"${cols.region}", and the caller is authorized for ` +
            `${claims.regionIds.length === 0 ? 'zero regions' : `regions ${claims.regionIds.join(', ')}`}, so the ` +
            `server cannot derive a value. The client-facing error omits the column name so a rejected mutation ` +
            `cannot be used to probe it.`,
        );
        throw new Error(
          `MUI X Studio Server: An insert into region-scoped table "${table}" must set an in-scope value for that table's region column, but none was provided. ` +
            `The caller is authorized for ${claims.regionIds.length === 0 ? 'zero regions' : `regions ${claims.regionIds.join(', ')}`}, ` +
            `so leaving the region column unset would create a row outside the caller's own row-level scope (fail-closed). ` +
            `The column is not named here because that would let a rejected mutation be used to discover the deployment's row-level-security schema; it is logged server-side instead. ` +
            `Include an in-scope region value in the insert.`,
        );
      }
    }
  }

  // `!== undefined` (not truthiness). An empty-string department claim is a defined (if unusual)
  // scope, not "unscoped"; auto-stamping it is just as valid as stamping any other single-valued
  // department.
  if (cols.department && claims.department !== undefined) {
    const present = Object.prototype.hasOwnProperty.call(values, cols.department);
    if (!present) {
      // Department is single-valued — the caller's own department is always the
      // unambiguous in-scope value to stamp.
      stamps[cols.department] = claims.department;
    }
  }

  return stamps;
}

/**
 * Validate a mutation descriptor before building the query.
 * Throws with a descriptive message on any security or invariant violation.
 */
export function validateMutation(
  descriptor: MutationDescriptor,
  claims: JwtSecurityClaims,
  options: Pick<HandleMutationOptions, 'writableColumns' | 'columnAllowlist'> & {
    /**
     * Security policy governing tenant/region/department scope for this table.
     * Either the pre-compiled policy threaded once from `handleMutation`, or raw
     * `SecurityPolicyOptions` (direct callers). REQUIRED — an explicit tenancy
     * decision is never optional at an enforcement site.
     */
    policy: CompiledSecurityPolicy | SecurityPolicyOptions;
  },
): void {
  // Require WHERE for update/delete — prevents full-table mutations.
  if (descriptor.operation !== 'insert' && (!descriptor.where || descriptor.where.length === 0)) {
    throw new Error(
      `MUI X Studio Server: "${descriptor.operation}" mutation on table "${descriptor.table}" ` +
        `requires at least one "where" predicate to prevent unscoped mutations.`,
    );
  }

  // Resolve the security columns for this table once, through the compiled
  // policy — the same resolution the read/update/delete paths use.
  const cols = resolvePrimaryCols(descriptor.table, options.policy);

  // Validate where-predicate columns against the column allowlist — mirrors the
  // read path so a client cannot reference arbitrary columns (e.g. to probe rows
  // by hidden columns via the affected-row count). Fail-closed + `'*'`-aware via
  // the shared helper.
  if (options.columnAllowlist && descriptor.where) {
    for (const pred of descriptor.where) {
      checkColumnAgainstAllowlist(pred.column, descriptor.table, options.columnAllowlist, 'where');
    }
  }

  // Enforce row-level-security scope carried in `values` (tenant / region /
  // department) — independent of the writable-columns allowlist.
  const values = descriptor.values ?? {};

  // Reject an "update" mutation whose `values` is empty. `values: {}` (or an omitted `values`) has
  // zero keys, so it passes every check in this function (zero keys means zero writable-column
  // checks) and previously reached Knex's `query.update({})` unfiltered — Knex itself throws its
  // own "Empty .update() call detected" error there, an unsanitized, driver-adjacent message from a
  // layer this package's own validation is supposed to guard. Checked from the CLIENT's
  // perspective: this runs on `descriptor.values` before any internal tenant-column stripping
  // (`buildUpdateMutation` only ever REMOVES the tenant key from update values, never adds one), so
  // an empty object here means the client genuinely sent nothing to set. An update-by-definition
  // sets at least one column, so fail closed here instead with a clear, actionable error.
  if (descriptor.operation === 'update' && Object.keys(values).length === 0) {
    throw new Error(
      `MUI X Studio Server: "update" mutation on table "${descriptor.table}" requires at least one value to set, ` +
        `but "values" is empty or missing. ` +
        `An update with no values would reach the database driver with an empty SET clause instead of failing with ` +
        `a clear validation error. ` +
        `Include at least one column in "values" to update.`,
    );
  }

  // Value-key SHAPE (qualified key, length, implicit `" as "` alias) is checked
  // before any scope check — a qualified key is malformed input and would
  // otherwise dodge the bare-name scope matching. UNCONDITIONAL, unlike the
  // writable-columns MEMBERSHIP check at the end of this function.
  assertValueKeysWellFormed(values, descriptor.table);
  validateSecurityColumnValues(values, claims, cols, descriptor.table);
  // Value SHAPE is validated alongside value KEYS — the read path
  // fail-closes on a non-scalar filter value, and the write path now does too.
  // Ordered AFTER the row-level-security check on purpose: a non-scalar in a
  // SECURITY column has its own, more specific rejection there ("must be a
  // scalar region identifier"), which is more actionable than the generic
  // value-shape message.
  validateMutationValues(values, descriptor.table);

  // INSERT-only fail-closed region/department scope: a
  // region/department-restricted caller must produce an in-scope row rather than
  // omit the column and mint an out-of-scope (region-NULL) row. The stamps are
  // applied by `buildInsertMutation`; here we only want the fail-closed throw, so
  // the returned stamps are discarded.
  if (descriptor.operation === 'insert') {
    resolveInsertScopeStamps(values, claims, cols, descriptor.table);
  }

  // Validate value keys against the writable columns allowlist. Fail-closed +
  // `'*'`-aware via the shared helper (a table with no entry is rejected).
  if (options.writableColumns) {
    for (const col of Object.keys(values)) {
      checkColumnAgainstAllowlist(col, descriptor.table, options.writableColumns, 'values');
    }
  }
}

/**
 * Build a parameterized INSERT query.
 *
 * The tenant column (resolved from the required `TenancyConfig`, with an optional
 * `securityColumns.perTable` override) is unconditionally injected from `claims`. A
 * client-supplied tenant value never reaches this stamp: `validateMutation` — and
 * the re-check at the top of this builder, for direct callers that skip it — THROWS
 * on it fail-closed rather than silently overriding it.
 *
 * Returns a Knex query builder — await the result to execute and get the
 * inserted row ID(s) or row count.
 */
export function buildInsertMutation(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: MutationDescriptor,
  policy: CompiledSecurityPolicy | SecurityPolicyOptions,
): any {
  // Defense-in-depth: re-run the unconditional value-key shape checks even for
  // direct callers that skip `validateMutation`, so a dotted key — or one
  // carrying Knex's implicit `" as "` alias syntax — can never reach the Knex
  // insert payload.
  assertValueKeysWellFormed(descriptor.values ?? {}, descriptor.table);
  const values: Record<string, unknown> = { ...descriptor.values };
  const cols = resolvePrimaryCols(descriptor.table, policy);

  // Defense-in-depth: re-run the present-value row-level-security
  // scope check at the builder boundary, symmetric with `buildUpdateMutation`, so a
  // direct caller that skipped `validateMutation` cannot smuggle an out-of-scope
  // PRESENT value (e.g. `{ region_id: 999 }` from a region-5 caller, or a
  // client-supplied tenant column) into the insert payload. Runs BEFORE the tenant
  // force-stamp so the check sees the client's own values. Idempotent on the normal
  // path — `validateMutation` already ran the identical check with in-scope values.
  validateSecurityColumnValues(values, claims, cols, descriptor.table);

  // Defense-in-depth: re-run the value-SHAPE check at the builder
  // boundary, exactly like the qualified-key and row-level-security re-checks
  // around it, so a direct caller that skipped `validateMutation` cannot reach
  // `db(table).insert(...)` with a non-scalar value. Runs on the CLIENT's own
  // values, before the tenant/scope stamps below (which are always scalars), and
  // after the security check so a non-scalar SECURITY value keeps its own more
  // specific message — the same ordering `validateMutation` uses.
  validateMutationValues(values, descriptor.table);

  // Unconditionally set the tenant column — clients cannot set it to another tenant.
  if (cols.tenant) {
    values[cols.tenant] = claims.tenantId;
  }

  // Fail-closed region/department scope on INSERT: auto-stamp the
  // caller's scope where the server can derive it (a single authorized region, or
  // the caller's single department), and throw when a region-restricted caller
  // omitted a region the server cannot pick. Runs even for direct callers that skip
  // `validateMutation` (defense-in-depth), mirroring the tenant force-stamp above.
  Object.assign(values, resolveInsertScopeStamps(values, claims, cols, descriptor.table));

  return db(descriptor.table).insert(values);
}

/**
 * Build a parameterized UPDATE query.
 *
 * Row-level security predicates (tenant + region + department) are added
 * unconditionally before user-supplied WHERE predicates — the same set enforced
 * on reads, so a user restricted to region 5 cannot UPDATE rows in other regions.
 * The tenant column is stripped from the values being updated so a client cannot
 * re-assign a row to a different tenant.
 *
 * Returns a Knex query builder — await to get the number of rows updated.
 */
export function buildUpdateMutation(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: MutationDescriptor,
  policy: CompiledSecurityPolicy | SecurityPolicyOptions,
): any {
  // Defense-in-depth: re-assert the WHERE-required invariant at the builder
  // boundary, mirroring the qualified-key / security-value re-checks below, so a
  // direct caller that skips `validateMutation` can never emit an unscoped,
  // full-table update. This is the single most important write invariant, and
  // previously lived ONLY in `validateMutation`.
  if (!descriptor.where || descriptor.where.length === 0) {
    throw new Error(
      `MUI X Studio Server: "update" mutation on table "${descriptor.table}" ` +
        `requires at least one "where" predicate to prevent unscoped mutations.`,
    );
  }

  // Defense-in-depth: re-assert the non-empty-values invariant at the builder
  // boundary, checked from the CLIENT's perspective (on `descriptor.values`,
  // before the tenant strip below), so a direct caller cannot reach Knex's
  // `query.update({})` with an empty SET clause. An update-by-definition sets at
  // least one column.
  if (Object.keys(descriptor.values ?? {}).length === 0) {
    throw new Error(
      `MUI X Studio Server: "update" mutation on table "${descriptor.table}" requires at least one value to set, ` +
        `but "values" is empty or missing. ` +
        `An update with no values would reach the database driver with an empty SET clause instead of failing with ` +
        `a clear validation error. ` +
        `Include at least one column in "values" to update.`,
    );
  }

  const query = db(descriptor.table);
  const cols = resolvePrimaryCols(descriptor.table, policy);

  // Unconditional security scope — applied first so it cannot be AND-ed away.
  // 'write' mode: an empty region scope (`regionIds: []`) throws rather than
  // silently dropping the region predicate and widening the mutation.
  applySecurityPredicates(query, descriptor.table, claims, cols, 'write');

  // 'write' mode: an empty `in` list or an unknown operator throws rather than
  // silently widening the mutation to the whole tenant table.
  applyPredicates(query, descriptor.where, 'write');

  // Defense-in-depth: re-run the unconditional value-key shape checks even for
  // direct callers that skip `validateMutation`, so a dotted key — or one
  // carrying Knex's implicit `" as "` alias syntax — can never reach the Knex
  // update payload.
  assertValueKeysWellFormed(descriptor.values ?? {}, descriptor.table);

  // Strip tenant column from update values — never let a client move a row
  // from one tenant to another.
  const values: Record<string, unknown> = { ...descriptor.values };
  if (cols.tenant) {
    delete values[cols.tenant];
  }

  // Defense-in-depth: re-run the present-value row-level-security
  // scope check at the builder boundary, symmetric with `buildInsertMutation`, so a
  // direct caller that skipped `validateMutation` cannot smuggle an out-of-scope
  // PRESENT value (e.g. `{ region_id: 999 }` from a region-5 caller) into the update
  // SET clause. Runs AFTER the tenant strip above so the tenant column is already
  // removed — this builder deliberately STRIPS a client-supplied tenant rather than
  // throwing, so the (now-absent) tenant column makes that arm a no-op while the
  // region/department present-value checks still run. Idempotent on the normal path.
  validateSecurityColumnValues(values, claims, cols, descriptor.table);

  // Defense-in-depth: re-run the value-SHAPE check at the builder
  // boundary, symmetric with `buildInsertMutation`, so a direct caller that
  // skipped `validateMutation` cannot reach `query.update(...)` with a non-scalar
  // value. Runs on the post-strip values (the tenant column is never written from
  // client input anyway) and after the security check, so a non-scalar SECURITY
  // value keeps its own more specific message.
  validateMutationValues(values, descriptor.table);

  return query.update(values);
}

/**
 * Build a parameterized DELETE query.
 *
 * Row-level security predicates (tenant + region + department) are unconditional.
 * User-supplied WHERE predicates are applied after the security scope predicates.
 *
 * Returns a Knex query builder — await to get the number of rows deleted.
 */
export function buildDeleteMutation(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: MutationDescriptor,
  policy: CompiledSecurityPolicy | SecurityPolicyOptions,
): any {
  // Defense-in-depth: re-assert the WHERE-required invariant at the builder
  // boundary, mirroring the security re-checks in `buildInsertMutation` /
  // `buildUpdateMutation`, so a direct caller that skips `validateMutation` can
  // never emit an unscoped, full-table delete. This is the single most important
  // write invariant, and previously lived ONLY in `validateMutation`.
  if (!descriptor.where || descriptor.where.length === 0) {
    throw new Error(
      `MUI X Studio Server: "delete" mutation on table "${descriptor.table}" ` +
        `requires at least one "where" predicate to prevent unscoped mutations.`,
    );
  }

  const query = db(descriptor.table);
  const cols = resolvePrimaryCols(descriptor.table, policy);

  applySecurityPredicates(query, descriptor.table, claims, cols, 'write');

  // 'write' mode: an empty `in` list or an unknown operator throws rather than
  // silently widening the mutation to the whole tenant table.
  applyPredicates(query, descriptor.where, 'write');

  return query.delete();
}
