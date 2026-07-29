/**
 * Data-query tool handlers for the x-studio MCP server:
 * `query_data_source`, `describe_data_source`, `get_field_values`, and
 * `compute_field_stats`.
 *
 * These are exactly the tools that resolve a `sourceId` against
 * `stateBox.current.runtime.dataSources` and then call `data.queryDataSource` —
 * `resolveSource` below is that shared resolution step, exported so it can also
 * be exercised directly in tests.
 */

import { renderChartSvg } from '../chartRenderer';
import { capFilterValue, MAX_FILTER_STRING_LENGTH } from '../executeToolOnState';
import {
  checkAllowedTable,
  errorResult,
  jsonResult,
  mapWithConcurrency,
  MAX_CONCURRENT_HOST_QUERIES,
  opLabel,
  ownArrayEntry,
  redactedHostErrorResult,
  safeIdentifier,
  sanitizeMaxQueryRows,
  validateTableName,
  withTimeout,
  type ToolHandler,
} from './helpers';
import { asString } from '../internal/promptCaps';
import type {
  StudioDataFilter,
  StudioDataAggregation,
  StudioDataHavingPredicate,
  StudioDataOrderBy,
  StudioMcpData,
  StudioMcpLogger,
  StudioStateBox,
} from './types';

/** Dependencies needed by the four data-query tool handlers. */
export interface QueryToolDeps {
  stateBox: StudioStateBox;
  /** Data-access configuration; when absent, the handlers return descriptive errors. */
  data?: StudioMcpData;
  /** Hard upper bound applied to the `query_data_source` `limit`. */
  maxQueryRows: number;
  /**
   * Diagnostic logger. Threaded in so a host/DB failure can be logged in FULL
   * server-side while the model only ever sees the generic, correlation-id-bearing
   * message `redactedHostErrorResult` produces (finding H4).
   */
  logger?: StudioMcpLogger;
}

/**
 * Hard upper bound on the number of `fields` a single `compute_field_stats` call
 * may request (Tier 3, iteration 22). Each field fans out into FIVE aggregations
 * (min/max/avg/sum/count — see the `aggregations` build below), so an unbounded
 * `fields` array turns one tool call into an unbounded amount of DB aggregation
 * work in a single query. Rejected with a clear, actionable error rather than
 * silently truncated, so the model learns to split the request instead of
 * silently getting stats for a subset of the fields it asked for.
 */
const MAX_COMPUTE_FIELD_STATS_FIELDS = 50;

/**
 * Hard upper bound on the number of entries accepted in each of `query_data_source`'s
 * `columns` / `filters` / `aggregations` / `having` / `orderBy` arrays (Tier 3,
 * iteration 25, finding T2-3). Before this cap, all five arrays were cast and
 * forwarded to `data.queryDataSource` verbatim — only `limit`/`offset` were
 * clamped — even though `compute_field_stats` (above) already rejects an
 * oversized `fields` array with the exact same rationale ("each field/entry fans
 * out into DB aggregation work, so an unbounded array turns one tool call into
 * unbounded work") and `query_data_source` is reachable in exactly one hop with
 * the identical class of unbounded arrays (e.g. 50,000 `aggregations` entries, or
 * a megabyte-sized `filters[].value`). Reuses `MAX_COMPUTE_FIELD_STATS_FIELDS`'s
 * 50-entry convention for all five arrays rather than inventing five separate
 * constants — there is no tool-specific reason `filters` should be allowed a
 * different bound than `aggregations`, say.
 */
const MAX_QUERY_ARRAY_LENGTH = MAX_COMPUTE_FIELD_STATS_FIELDS;

/**
 * Validate an optional model-supplied array argument to a data-query tool
 * (`query_data_source`'s `columns` / `filters` / `aggregations` / `having` /
 * `orderBy`, and — finding 4, Tier 3 — `compute_field_stats`'s `fields`).
 *
 * Rejects (never silently truncates or coerces) a non-array value outright —
 * mirroring `compute_field_stats`'s own reject-don't-truncate stance — since a
 * malformed shape would otherwise reach `data.queryDataSource` cast but
 * unvalidated, producing a raw driver error (or worse, unpredictable behavior)
 * that depends entirely on the host's implementation. Also rejects an oversized
 * array with the same actionable "split the request" guidance
 * `compute_field_stats` gives for its own `fields` cap (see
 * `MAX_QUERY_ARRAY_LENGTH`). Returns the validated array unchanged (or
 * `undefined` when the arg was omitted) so the caller can forward it as-is.
 *
 * `toolName` is threaded through (rather than hardcoded) so the error message
 * names whichever tool actually rejected the call — `compute_field_stats`'s
 * `fields` and `query_data_source`'s five arrays share this one validator, and a
 * `compute_field_stats` caller should not be told to fix `query_data_source`.
 */
function validateQueryArrayArg<T>(
  toolName: string,
  argName: string,
  value: unknown,
): { ok: true; value: T[] | undefined } | { ok: false; error: ReturnType<typeof errorResult> } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: errorResult(
        `${toolName}: "${argName}" must be an array, received ${typeof value}. ` +
          `Pass an array of ${argName} entries, or omit "${argName}" entirely.`,
      ),
    };
  }
  if (value.length > MAX_QUERY_ARRAY_LENGTH) {
    return {
      ok: false,
      error: errorResult(
        `${toolName} received ${value.length} "${argName}" entries, which exceeds the limit of ` +
          `${MAX_QUERY_ARRAY_LENGTH}. Split the request into multiple calls of at most ` +
          `${MAX_QUERY_ARRAY_LENGTH} ${argName} entries each.`,
      ),
    };
  }
  return { ok: true, value: value as T[] };
}

/**
 * Validate + cap the elements of a model-supplied STRING array argument
 * (`query_data_source`'s `columns`) (finding F4, Tier 2). `validateQueryArrayArg`
 * above only checks array-ness and overall length — nothing stopped an
 * individual element from being an object/number (forwarded to
 * `data.queryDataSource` as a nonsensical "column name") or a multi-megabyte
 * string (an unbounded-work/token-bomb class identical to the one
 * `capFilterValue` already guards `filters[].value` against). A non-string
 * element is rejected outright (not recoverable by truncation — mirrors
 * `compute_field_stats`'s existing non-string-`fields`-element rejection); an
 * oversized-but-otherwise-valid string is truncated to
 * {@link MAX_FILTER_STRING_LENGTH} rather than rejected, the same cap
 * `add_page_filter`/`add_widget_filter` apply to a persisted filter's `field`.
 *
 * Exported so `mcp/summarisePage.ts` can run the SAME validation over the
 * `xField`/`yField` it forwards as DB column names (finding M4) — that was the
 * one column-name path in the package that skipped it.
 */
export function validateAndCapStringArrayElements(
  toolName: string,
  argName: string,
  entries: unknown[],
): { ok: true; value: string[] } | { ok: false; error: ReturnType<typeof errorResult> } {
  const capped: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (typeof entry !== 'string') {
      return {
        ok: false,
        error: errorResult(
          `${toolName}: "${argName}[${i}]" must be a string, received ` +
            `${Array.isArray(entry) ? 'array' : typeof entry}. Pass an array of column-name strings.`,
        ),
      };
    }
    capped.push(
      entry.length > MAX_FILTER_STRING_LENGTH ? entry.slice(0, MAX_FILTER_STRING_LENGTH) : entry,
    );
  }
  return { ok: true, value: capped };
}

/**
 * Build a runtime closed set from an exhaustive `Record<Union, true>` literal.
 *
 * The `satisfies Record<T, true>` at each call site is the completeness lock: TypeScript
 * requires EVERY member of the union to be present (a member added to the union without
 * being added here fails to compile) and rejects any key that is not in it. That is what
 * keeps the runtime set and the compile-time union from drifting — the class of drift
 * this whole family of checks exists to catch.
 */
function closedSetOf<T extends string>(members: Record<T, true>): ReadonlySet<string> {
  return new Set(Object.keys(members));
}

/**
 * The closed value domains of `query_data_source`'s SQL-STRUCTURAL fields — the
 * fields whose value does not become a bound parameter but selects a piece of query
 * STRUCTURE: a comparison operator, an aggregate function, a sort direction (finding H5).
 *
 * These were type-checked (`typeof === 'string'`) and length-checked (≤200) by
 * {@link validateAndCapRecordArrayElements} and nothing else, so
 * `orderBy[].direction: 'asc; DROP TABLE t--'` and
 * `aggregations[].func: 'count(*) FROM secrets--'` reached `data.queryDataSource`
 * verbatim. Their TypeScript types are closed unions (`models/aiTypes.ts`) and the
 * JSON schemas advertise `enum`s (`studioAITools.ts`) — but this package's entire
 * thesis is that a schema is advertisement, not enforcement, and the provider is a
 * first-class attacker. Knex whitelists neither an ORDER BY direction it does not
 * recognise (it silently coerces to `asc`) nor an aggregate function name, so a host
 * doing `query.orderBy(col, ob.direction)` or ``knex.raw(`${func}(${col})`)`` was
 * handed attacker-authored query structure.
 *
 * The shipped reference host (`@mui/x-studio-data-middleware`'s
 * `security/validateQueryPlan.ts`) does validate these, so a default deployment was
 * covered; this is the same check on THIS side of the boundary, for a bespoke
 * `queryDataSource`. The sibling that proves the omission was an oversight rather
 * than a stance is in this package: `mcp/summarisePage.ts` already gates the same
 * `func` value through a closed set before forwarding it — see
 * `ANOMALY_SAFE_AGGREGATIONS`, which is now expressed as a SUBSET of
 * {@link QUERY_AGGREGATION_FUNCS} rather than a second hand-written copy.
 */
export const QUERY_FILTER_OPERATORS = closedSetOf({
  eq: true,
  neq: true,
  in: true,
  lt: true,
  lte: true,
  gt: true,
  gte: true,
  like: true,
  between: true,
} satisfies Record<StudioDataFilter['operator'], true>);

/** Closed value domain of `aggregations[].func` — see {@link QUERY_FILTER_OPERATORS}. */
export const QUERY_AGGREGATION_FUNCS = closedSetOf({
  sum: true,
  avg: true,
  count: true,
  min: true,
  max: true,
} satisfies Record<StudioDataAggregation['func'], true>);

/** Closed value domain of `having[].operator` — see {@link QUERY_FILTER_OPERATORS}. */
export const QUERY_HAVING_OPERATORS = closedSetOf({
  eq: true,
  gt: true,
  lt: true,
  gte: true,
  lte: true,
} satisfies Record<StudioDataHavingPredicate['operator'], true>);

/** Closed value domain of `orderBy[].direction` — see {@link QUERY_FILTER_OPERATORS}. */
export const QUERY_ORDER_BY_DIRECTIONS = closedSetOf({
  asc: true,
  desc: true,
} satisfies Record<StudioDataOrderBy['direction'], true>);

/**
 * The pattern an `aggregations[].alias` / `having[].alias` must match (finding H5).
 *
 * An alias is not a closed set, but it is not a bound parameter either: a host emits
 * it as a SQL identifier (`SUM(??) AS alias`), which is the same
 * attacker-authored-structure position as `func` and `direction`. Identical to the
 * `SAFE_ALIAS_PATTERN` the shipped reference host
 * (`@mui/x-studio-data-middleware`'s `shared/columnValidation.ts`) enforces
 * unconditionally, so a call this layer accepts is one that host also accepts —
 * letting a `like this; DROP TABLE t--` alias through here only to have the host
 * reject it moves the failure further from the model that can fix it.
 */
const SAFE_AGGREGATION_ALIAS = /^[A-Za-z0-9_-]+$/;

/**
 * The exact keys each `query_data_source` record array may carry through to
 * `data.queryDataSource`, and the closed value domain of each SQL-structural one
 * (findings H5 + L2).
 *
 * `keys` is an ALLOW-LIST, not a description: {@link validateAndCapRecordArrayElements}
 * projects a fresh record containing only these keys. Previously it projected EVERY key
 * of the model's record, so an unlisted `raw`, `joins`, or `alias` on a `filters` entry
 * reached the host intact — and those are precisely the keys that would change query
 * structure on a host that reads them. Nothing outside the documented
 * `models/aiTypes.ts` shapes is part of the contract, so nothing outside them is
 * forwarded.
 */
const QUERY_RECORD_CONTRACTS = {
  filters: {
    keys: ['field', 'operator', 'value', 'value2'],
    stringFields: ['field', 'operator'],
    enums: { operator: QUERY_FILTER_OPERATORS },
  },
  aggregations: {
    keys: ['column', 'func', 'alias'],
    stringFields: ['column', 'func', 'alias'],
    enums: { func: QUERY_AGGREGATION_FUNCS },
    patterns: { alias: SAFE_AGGREGATION_ALIAS },
  },
  having: {
    keys: ['alias', 'operator', 'value'],
    stringFields: ['alias', 'operator'],
    enums: { operator: QUERY_HAVING_OPERATORS },
    patterns: { alias: SAFE_AGGREGATION_ALIAS },
  },
  orderBy: {
    keys: ['column', 'direction'],
    stringFields: ['column', 'direction'],
    enums: { direction: QUERY_ORDER_BY_DIRECTIONS },
  },
} satisfies Record<
  string,
  {
    keys: readonly string[];
    stringFields: readonly string[];
    enums?: Record<string, ReadonlySet<string>>;
    patterns?: Record<string, RegExp>;
  }
>;

/** The contract shape {@link validateAndCapRecordArrayElements} consumes. */
interface QueryRecordContract {
  keys: readonly string[];
  stringFields: readonly string[];
  enums?: Readonly<Record<string, ReadonlySet<string>>>;
  patterns?: Readonly<Record<string, RegExp>>;
}

/**
 * Validate + cap the RECORD-shaped elements of `query_data_source`'s
 * `aggregations` / `having` / `orderBy` / `filters` arrays (finding F4, Tier 2).
 * `validateQueryArrayArg` above only checks array-ness and overall length —
 * nothing stopped a `null`/non-object entry, or a string-valued field
 * (`column`/`func`/`alias`/`operator`/`direction`/`field`) from being an
 * arbitrary non-string value or an unbounded string, from reaching
 * `data.queryDataSource` verbatim.
 *
 * Each entry must be a plain object (rejected otherwise). Any of
 * `contract.stringFields` present on it must be a string — rejected if not (an
 * object/array/number masquerading as e.g. a column name is not recoverable by
 * truncation) — and is truncated to {@link MAX_FILTER_STRING_LENGTH} if
 * oversized rather than rejected outright, mirroring
 * `validateAndCapStringArrayElements` above.
 *
 * Finding H5 adds the third dimension the first two never covered: a VALUE-DOMAIN
 * check on the SQL-structural fields (`contract.enums` / `contract.patterns`). A
 * `direction` of `'asc; DROP TABLE t--'` is a 21-character string and so passed both
 * the type and the length check on its way to the host. Out-of-domain values are
 * REJECTED, never coerced to a default: silently sorting the opposite way, or
 * silently swapping `count` for `sum`, answers a question the caller did not ask and
 * renders the wrong answer as a right-looking chart.
 *
 * Finding L2 closes the last gap: the returned record is PROJECTED to
 * `contract.keys` only. Numeric/boolean values on listed keys (`having`'s `value`)
 * pass through untouched — deep validation of a bound parameter is the host's job —
 * but an unlisted key never reaches the host at all.
 */
function validateAndCapRecordArrayElements<T extends object>(
  toolName: string,
  argName: string,
  entries: T[],
  contract: QueryRecordContract,
): { ok: true; value: T[] } | { ok: false; error: ReturnType<typeof errorResult> } {
  const capped: T[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry: unknown = entries[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return {
        ok: false,
        error: errorResult(
          `${toolName}: "${argName}[${i}]" must be an object, received ` +
            `${Array.isArray(entry) ? 'array' : typeof entry}.`,
        ),
      };
    }
    const record = entry as unknown as Record<string, unknown>;
    // The named `stringFields` must, if present, be strings — an object/array/number
    // masquerading as e.g. a column name is not recoverable by truncation.
    for (const field of contract.stringFields) {
      const fieldValue = record[field];
      if (fieldValue !== undefined && typeof fieldValue !== 'string') {
        return {
          ok: false,
          error: errorResult(
            `${toolName}: "${argName}[${i}].${field}" must be a string, received ` +
              `${Array.isArray(fieldValue) ? 'array' : typeof fieldValue}.`,
          ),
        };
      }
    }
    // Project ONLY the contract's own keys (finding L2), capping each string value to
    // {@link MAX_FILTER_STRING_LENGTH}. The previous version projected every key of the
    // model's record, so an unlisted `raw`/`joins` reached `data.queryDataSource`
    // intact — the keys most likely to change query STRUCTURE on a host that reads
    // them. Non-string values on listed keys (`having`'s numeric `value`) are
    // forwarded untouched.
    const cappedRecord: Record<string, unknown> = {};
    for (const key of contract.keys) {
      if (!Object.hasOwn(record, key)) {
        continue;
      }
      const value = record[key];
      cappedRecord[key] =
        typeof value === 'string' && value.length > MAX_FILTER_STRING_LENGTH
          ? value.slice(0, MAX_FILTER_STRING_LENGTH)
          : value;
    }
    // VALUE-DOMAIN checks (finding H5), run on the PROJECTED+CAPPED value so what is
    // validated is exactly what is forwarded.
    for (const [field, allowed] of Object.entries(contract.enums ?? {})) {
      const value = cappedRecord[field];
      if (value !== undefined && !allowed.has(value as string)) {
        return {
          ok: false,
          error: errorResult(
            `${toolName}: "${argName}[${i}].${field}" must be one of ` +
              `${[...allowed].map((v) => `"${v}"`).join(', ')}. This request was blocked before ` +
              'reaching the database, because that value selects part of the query itself rather ' +
              'than being compared as data. Re-issue the call using one of the listed values.',
          ),
        };
      }
    }
    for (const [field, pattern] of Object.entries(contract.patterns ?? {})) {
      const value = cappedRecord[field];
      if (value !== undefined && !pattern.test(value as string)) {
        return {
          ok: false,
          error: errorResult(
            `${toolName}: "${argName}[${i}].${field}" must contain only letters, digits, ` +
              'underscores and hyphens. This request was blocked before reaching the database, ' +
              'because that value is emitted as a SQL identifier rather than compared as data. ' +
              'Re-issue the call with a simple alias such as "total_revenue".',
          ),
        };
      }
    }
    capped.push(cappedRecord as unknown as T);
  }
  return { ok: true, value: capped };
}

/** The five aggregate functions `compute_field_stats` fans each field out into. */
const FIELD_STAT_FUNCS = ['min', 'max', 'avg', 'sum', 'count'] as const;

/**
 * Build the `aggregations` array for a per-field stats query, enforcing
 * {@link SAFE_AGGREGATION_ALIAS} on every alias it EMITS (finding M1).
 *
 * `compute_field_stats` synthesizes each alias from a model-supplied field id
 * (`` `${field}__min` ``), and an alias is emitted by the host as a SQL IDENTIFIER
 * (`SUM(??) AS alias`) rather than bound as data — the same
 * attacker-authored-structure position `query_data_source` has validated
 * `aggregations[].alias` against this pattern all along (see
 * `QUERY_RECORD_CONTRACTS.aggregations`). `validateAndCapStringArrayElements` only
 * type-checks and length-caps `fields`, so `fields: ['orders.total']` previously
 * produced `alias: 'orders.total__min'` and forwarded it unchecked. The shipped
 * reference host's `SAFE_ALIAS_PATTERN` then rejected it, so the model got a
 * host-attributed error instead of the actionable, retryable one this layer promises.
 *
 * Both the check and the construction live HERE, in one helper, so the contract runs
 * over whatever this function actually emits — a caller cannot assemble the array and
 * forget the check, which is precisely how this site diverged from its sibling. The
 * other four data tools use CONSTANT aliases and so were never exposed.
 */
function buildFieldStatAggregations(
  toolName: string,
  argName: string,
  fields: string[],
):
  | { ok: true; value: StudioDataAggregation[] }
  | { ok: false; error: ReturnType<typeof errorResult> } {
  const aggregations: StudioDataAggregation[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const column = fields[i];
    for (const func of FIELD_STAT_FUNCS) {
      const alias = `${column}__${func}`;
      if (!SAFE_AGGREGATION_ALIAS.test(alias)) {
        return {
          ok: false,
          error: errorResult(
            `${toolName}: "${argName}[${i}]" must contain only letters, digits, underscores and ` +
              'hyphens, because this tool derives a SQL result alias from it. This request was ' +
              'blocked before reaching the database, because an alias is emitted as a SQL ' +
              'identifier rather than compared as data. Call describe_data_source on this ' +
              'sourceId and re-issue the call using a field id exactly as listed there.',
          ),
        };
      }
      aggregations.push({ column, func, alias });
    }
  }
  return { ok: true, value: aggregations };
}

/**
 * Cap on the number of numeric fields `describe_data_source` fans out into
 * per-field aggregation queries (Tier 3, iteration 24, finding 5), mirroring
 * `MAX_COMPUTE_FIELD_STATS_FIELDS` above — both bound "how many per-field
 * aggregation queries can one tool call issue in a single `Promise.all`".
 *
 * Unlike `compute_field_stats`, the field set here is NOT model-supplied — it's
 * every `type: 'number'` field on the resolved source — so there is no smaller
 * request for the model to retry with, and rejecting the call outright would
 * just dead-end it. Instead of rejecting, the fan-out is truncated to the first
 * N numeric fields (in schema order) and the response notes the truncation so
 * the model knows some numeric fields have no `stats` (it can still recover the
 * rest via `compute_field_stats` with an explicit `fields` list). Reuses the
 * same limit as `MAX_COMPUTE_FIELD_STATS_FIELDS` since there's no tool-specific
 * reason for a different number.
 */
const MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS = MAX_COMPUTE_FIELD_STATS_FIELDS;

/**
 * Hard upper bound on `query_data_source`'s `offset` (finding L2). Its sibling
 * `limit` is capped by the host's `maxQueryRows`; `offset` was floored at 0 and left
 * unbounded above, so `{ limit: 1, offset: 500_000_000 }` cost one row of output and
 * a full scan-and-discard of everything before it. One million rows is far past any
 * paging depth a model-driven exploration legitimately needs, and past the depth at
 * which keyset pagination (a filter on the sort column) is the right tool anyway.
 */
const MAX_QUERY_OFFSET = 1_000_000;

/** The shape of a resolved, queryable data source: guaranteed to have a `tableName`. */
type ResolvedSource = StudioStateBox['current']['runtime']['dataSources'][string] & {
  tableName: string;
};

type ResolveSourceResult =
  | {
      ok: true;
      source: ResolvedSource;
      tableName: string;
      /**
       * The RESOLVED (validated + length-capped) source id — the id the returned
       * `tableName` actually belongs to (finding L3). Callers must forward THIS,
       * not the raw `sourceId` argument: `resolveSource` looks the source up by
       * the capped id, so a host that routes or authorizes on
       * `params.sourceId` would otherwise be handed an id that does not
       * correspond to the `tableName` it was given alongside it.
       */
      sourceId: string;
    }
  | { ok: false; error: ReturnType<typeof errorResult> };

/**
 * Validate `sourceId` against `stateBox.current.runtime.dataSources` *before*
 * building a query. Without this, an unknown/unregistered sourceId would fall
 * straight through as a physical table name and hit the DB, producing a raw
 * driver error (or worse, querying an unintended table) instead of a clear,
 * actionable message.
 *
 * The message names NO discovery tool or resource, deliberately. These handlers are
 * reachable from MCP `tools/call` and from the chat transport's agentic loop
 * (`agenticLoop.ts`), and on neither is the advertised tool set fixed: `allowedTools`
 * can exclude `get_dashboard_state` on both, and `mcp.ts`'s `isToolAllowed` rejects a
 * call to anything absent from it as unknown. A remediation that says
 * "Call get_dashboard_state" therefore costs the model a turn on an `Unknown tool`
 * error whenever the host has restricted it. The invariant a valid `sourceId` must
 * satisfy — it is a key of the dashboard's configured data-source catalogue — is
 * stated directly instead, which is true in every mode.
 *
 * SECURITY NOTE: this only validates that `sourceId` is a KEY the catalog knows
 * about — it does NOT by itself prove the resulting `tableName` is a table the
 * caller should be allowed to query. On the chat transport, the catalog
 * (`stateBox.current.runtime.dataSources`) descends from the client-supplied
 * request body, so a hostile caller can assert a fabricated `dataSources` entry
 * whose `tableName` points at an arbitrary table your DB connection can reach.
 * `allowedTables` (from `StudioAIDataConfig`), when the host configures it, closes
 * that gap: a resolved `tableName` outside the allowlist is rejected here, before
 * any query is built. See `StudioAIDataConfig.allowedTables`'s doc comment for the
 * full trust-boundary rationale.
 *
 * NOTE (finding F1): the chat transport additionally enforces a FAIL-CLOSED default
 * upstream, at its `query_data_source` dispatch site (`agenticLoop/toolDispatch.ts`) —
 * it refuses to resolve any source when `allowedTables` is `undefined`, so this
 * function is only ever reached from the chat transport with an array allowlist or the
 * explicit permissive `'*'`. Trusted MCP/server-held callers may still pass `undefined`
 * (no restriction), which `checkAllowedTable` permits.
 *
 * `sourceId` is typed `unknown` (Tier 1 architecture-review finding): every caller only
 * did a bare truthiness check (`!sourceId`) before passing it in — a truthy non-string
 * (an object, a number) sailed past that check and reached the `Object.hasOwn` lookup
 * below verbatim, and an unbounded string sailed into the `Unknown data source: "…"`
 * error message that is echoed straight back to the model. Every sibling arg in this
 * file (`field`, `filters[].field`, `columns[]`, …) is both type- and length-validated;
 * `sourceId` was the one exception. Validated and length-capped HERE, at the single
 * chokepoint all four data-query tools already funnel through, rather than duplicating
 * the check at each of the four call sites.
 */
export function resolveSource(
  stateBox: StudioStateBox,
  sourceId: unknown,
  allowedTables?: string[] | '*',
): ResolveSourceResult {
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    return {
      ok: false,
      error: errorResult(
        `sourceId must be a non-empty string, received ${
          Array.isArray(sourceId) ? 'array' : typeof sourceId
        }. Pass the id of one of the data sources configured on this dashboard.`,
      ),
    };
  }
  // Cap BEFORE the lookup/error message — the same bound `capSourceId`
  // (`executeToolOnState.ts`) applies to a persisted widget `sourceId`, so an
  // oversized value is truncated rather than echoed verbatim into the
  // `Unknown data source: "…"` error below.
  const cappedSourceId =
    sourceId.length > MAX_FILTER_STRING_LENGTH
      ? sourceId.slice(0, MAX_FILTER_STRING_LENGTH)
      : sourceId;
  // `Object.hasOwn`-guarded lookup (finding T2-1): a prototype-member sourceId
  // (`"constructor"`, `"__proto__"`) would otherwise resolve a truthy inherited value
  // via the prototype chain. Today the `!source.tableName` check below saves this by
  // accident (no prototype member has a `tableName`); the guard makes it explicit and
  // robust rather than incidental.
  const sources = stateBox.current.runtime.dataSources;
  const source = Object.hasOwn(sources, cappedSourceId) ? sources[cappedSourceId] : undefined;
  if (!source || !source.tableName) {
    return {
      ok: false,
      error: errorResult(
        // SANITIZED as well as capped (finding M2). The cap above bounds the LENGTH of
        // the echoed id; it does nothing about its CONTENT, and this message is spliced
        // into the model conversation by most MCP clients — so a `sourceId` carrying
        // newlines could forge a sibling line of prose here. `mcp/resources.ts` emits
        // the character-identical message and already routed it through
        // `safeIdentifier`; this site was the outlier.
        `Unknown data source: "${safeIdentifier(cappedSourceId)}". Only the data sources ` +
          'configured on this dashboard can be queried; pass the id of one of them.',
      ),
    };
  }
  // TYPE- and length-validate `tableName` before anything downstream forwards it to
  // the host (finding: it was checked for TRUTHINESS only and then cast `as string`
  // at every consumer). On the chat transport `runtime.dataSources` descends from the
  // client-supplied request body, so `{ tableName: { orders: 'secrets' } }` used to
  // reach `data.queryDataSource` as an object — which a Knex host reads as an alias
  // map, querying whichever table the caller named. `checkAllowedTable` does not
  // catch it: `'*'` short-circuits, and `includes` on a non-string never matches.
  // Validated HERE, at the single chokepoint all four data-query tools funnel
  // through, alongside the `sourceId` cap above.
  const tableNameResult = validateTableName(cappedSourceId, source.tableName);
  if (!tableNameResult.ok) {
    return { ok: false, error: errorResult(tableNameResult.error) };
  }
  const { tableName } = tableNameResult;
  const tableCheckError = checkAllowedTable(cappedSourceId, tableName, allowedTables);
  if (tableCheckError) {
    return { ok: false, error: errorResult(tableCheckError) };
  }
  return {
    ok: true,
    source: source as ResolvedSource,
    tableName,
    sourceId: cappedSourceId,
  };
}

/**
 * Build the four data-query tool handlers. Each returns a descriptive error
 * when `data` is not configured, and defers to `resolveSource` for the shared
 * unknown-sourceId check.
 */
export function createQueryToolHandlers(deps: QueryToolDeps): Record<string, ToolHandler> {
  const { stateBox, data, logger } = deps;
  // Validate the HOST-supplied bound before it becomes the clamp's own ceiling
  // (finding L2) — see `sanitizeMaxQueryRows`.
  const maxQueryRows = sanitizeMaxQueryRows(deps.maxQueryRows);

  return {
    // ── query_data_source — routed separately from state-mutation tools ──
    query_data_source: async (args) => {
      if (!data) {
        return errorResult(
          'query_data_source is not available: this MCP server was started without data access configuration.',
        );
      }

      const { sourceId, columns, filters, aggregations, having, orderBy, limit, offset } = (args ??
        {}) as {
        sourceId: string;
        columns?: string[];
        filters?: StudioDataFilter[];
        aggregations?: StudioDataAggregation[];
        having?: StudioDataHavingPredicate[];
        orderBy?: StudioDataOrderBy[];
        limit?: number;
        offset?: number;
      };

      // Reject (not silently truncate/forward) a malformed or oversized `columns` /
      // `filters` / `aggregations` / `having` / `orderBy` array before any of them
      // reach `data.queryDataSource` (T2-3) — see `validateQueryArrayArg`'s doc
      // comment.
      const columnsResult = validateQueryArrayArg<string>('query_data_source', 'columns', columns);
      if (!columnsResult.ok) {
        return columnsResult.error;
      }
      const filtersResult = validateQueryArrayArg<StudioDataFilter>(
        'query_data_source',
        'filters',
        filters,
      );
      if (!filtersResult.ok) {
        return filtersResult.error;
      }
      const aggregationsResult = validateQueryArrayArg<StudioDataAggregation>(
        'query_data_source',
        'aggregations',
        aggregations,
      );
      if (!aggregationsResult.ok) {
        return aggregationsResult.error;
      }
      const havingResult = validateQueryArrayArg<StudioDataHavingPredicate>(
        'query_data_source',
        'having',
        having,
      );
      if (!havingResult.ok) {
        return havingResult.error;
      }
      const orderByResult = validateQueryArrayArg<StudioDataOrderBy>(
        'query_data_source',
        'orderBy',
        orderBy,
      );
      if (!orderByResult.ok) {
        return orderByResult.error;
      }

      // Finding F4 (Tier 2): `validateQueryArrayArg` above only validates
      // array-ness and overall length — it never inspected individual ELEMENTS,
      // so an object/multi-megabyte string in `columns`, or a non-string
      // `column`/`func`/`alias`/`operator`/`direction`/`field` (or an unbounded
      // one) in `aggregations`/`having`/`orderBy`/`filters`, reached
      // `data.queryDataSource` verbatim. Validate + cap each array's elements now
      // that array-shape is already confirmed.
      //
      // Finding H5: each record array is validated against its contract in
      // `QUERY_RECORD_CONTRACTS`, which adds the VALUE-DOMAIN check the type + length
      // checks never made (`operator`/`func`/`direction` against their closed sets,
      // `alias` against the safe-identifier pattern) and projects the entry down to
      // the contract's own keys. `columns` needs no contract — it is a plain string
      // array of column names, a per-element check `validateAndCapStringArrayElements`
      // already covers, and a column NAME is a bound identifier rather than a closed
      // set (only the host knows the table's real columns).
      const columnsElementsResult = columnsResult.value
        ? validateAndCapStringArrayElements('query_data_source', 'columns', columnsResult.value)
        : undefined;
      if (columnsElementsResult && !columnsElementsResult.ok) {
        return columnsElementsResult.error;
      }
      const filtersElementsResult = filtersResult.value
        ? validateAndCapRecordArrayElements(
            'query_data_source',
            'filters',
            filtersResult.value,
            QUERY_RECORD_CONTRACTS.filters,
          )
        : undefined;
      if (filtersElementsResult && !filtersElementsResult.ok) {
        return filtersElementsResult.error;
      }
      const aggregationsElementsResult = aggregationsResult.value
        ? validateAndCapRecordArrayElements(
            'query_data_source',
            'aggregations',
            aggregationsResult.value,
            QUERY_RECORD_CONTRACTS.aggregations,
          )
        : undefined;
      if (aggregationsElementsResult && !aggregationsElementsResult.ok) {
        return aggregationsElementsResult.error;
      }
      const havingElementsResult = havingResult.value
        ? validateAndCapRecordArrayElements(
            'query_data_source',
            'having',
            havingResult.value,
            QUERY_RECORD_CONTRACTS.having,
          )
        : undefined;
      if (havingElementsResult && !havingElementsResult.ok) {
        return havingElementsResult.error;
      }
      const orderByElementsResult = orderByResult.value
        ? validateAndCapRecordArrayElements(
            'query_data_source',
            'orderBy',
            orderByResult.value,
            QUERY_RECORD_CONTRACTS.orderBy,
          )
        : undefined;
      if (orderByElementsResult && !orderByElementsResult.ok) {
        return orderByElementsResult.error;
      }

      // Cap each filter's `value`/`value2` the same way `add_page_filter` /
      // `add_widget_filter` cap a PERSISTED filter's value (T2-3): these `filters`
      // are forwarded to the host's `queryDataSource` rather than persisted onto
      // dashboard state, but a megabyte-sized string/array `value` is the identical
      // unbounded-work/token-bomb class `capFilterValue` already guards against —
      // `checkAllowedTable`'s allowlist stops an out-of-scope TABLE, not an
      // oversized filter VALUE bound for an otherwise-permitted query.
      const cappedFilters = filtersElementsResult?.ok
        ? filtersElementsResult.value.map((f) => ({
            ...f,
            value: capFilterValue(f.value),
            ...(f.value2 !== undefined && { value2: capFilterValue(f.value2) }),
          }))
        : undefined;

      // Clamp `limit` to a sane, positive integer within [1, maxQueryRows].
      // A model-supplied `limit` is untrusted: a negative value, `NaN` (e.g.
      // from a non-numeric `"all"`), zero, or a fractional value must not
      // reach `data.queryDataSource` unchanged — depending on the host's Knex
      // wiring that produces a raw driver error (`LIMIT NaN`) instead of the
      // actionable, model-recoverable errors this layer otherwise guarantees
      // (T2-6). Falsy (0/NaN) truncated values fall back to `maxQueryRows`,
      // matching the "Default 1000" behavior already documented in the tool's
      // JSON schema.
      const truncatedLimit = Math.trunc(Number(limit));
      const clampedLimit = Math.min(Math.max(1, truncatedLimit || maxQueryRows), maxQueryRows);

      // Clamp `offset` to a non-negative integer, coercing a negative/NaN/
      // non-numeric value to 0 rather than forwarding it untouched (T2-6).
      const truncatedOffset = Math.trunc(Number(offset));
      const clampedOffset =
        Number.isFinite(truncatedOffset) && truncatedOffset > 0 ? truncatedOffset : 0;
      // Finding L2: `offset` had a lower bound but NO upper one, unlike its sibling
      // `limit` (capped by `maxQueryRows`). `{ limit: 1, offset: 500000000 }` is a
      // cheap-looking call that makes the database scan and discard half a billion
      // rows. REJECTED rather than clamped: clamping would silently return a
      // different page than the one requested, which is a wrong answer presented as a
      // right one — where the rejection tells the model to paginate with a filter
      // instead.
      if (clampedOffset > MAX_QUERY_OFFSET) {
        return errorResult(
          `query_data_source: "offset" of ${clampedOffset} exceeds the limit of ` +
            `${MAX_QUERY_OFFSET}. A large offset makes the database scan and discard every ` +
            'skipped row, so this request was blocked before reaching it. Narrow the result set ' +
            'with "filters" (for example, on the id or date column you are paginating by) rather ' +
            'than paging deeper.',
        );
      }

      if (!sourceId) {
        return errorResult('sourceId is required');
      }

      try {
        // Inside the `try` (finding M1): `resolveSource` reads host/client-supplied
        // state and calls out to `validateTableName`/`checkAllowedTable`, so an
        // unexpected THROW there (a malformed `allowedTables`, a state box whose
        // `current` getter fails) must become this tool call's redacted error rather
        // than escaping the handler and rejecting whatever awaits it.
        const resolved = resolveSource(stateBox, sourceId, data.allowedTables);
        if (!resolved.ok) {
          return resolved.error;
        }
        // Forward the RESOLVED (capped) id, never the raw argument — see the
        // `sourceId` field on `ResolveSourceResult` (finding L3).
        const { tableName, sourceId: resolvedSourceId } = resolved;
        // Bounded with the same `withTimeout` pattern `mcp/summarisePage.ts` applies to its
        // own `data.queryDataSource` calls (Tier 3, iteration 22) — without it, a hung host
        // query implementation leaves this tool call (and the agentic loop turn awaiting it)
        // pending indefinitely.
        const result = await withTimeout(
          data.queryDataSource({
            sourceId: resolvedSourceId,
            tableName,
            columns: columnsElementsResult?.ok ? columnsElementsResult.value : undefined,
            filters: cappedFilters,
            aggregations: aggregationsElementsResult?.ok
              ? aggregationsElementsResult.value
              : undefined,
            ...(havingElementsResult?.ok &&
              havingElementsResult.value.length > 0 && { having: havingElementsResult.value }),
            orderBy: orderByElementsResult?.ok ? orderByElementsResult.value : undefined,
            limit: clampedLimit,
            ...(offset !== undefined && { offset: clampedOffset }),
          }),
          15_000,
          // `tableName` is untrusted (on the chat transport `runtime.dataSources`
          // descends from the request body) and this label lands inside a BRANDED
          // `StudioTimeoutError`, which `redactedHostErrorMessage` relays VERBATIM on
          // the premise that a branded message holds only server-authored prose —
          // so it must be sanitized to keep that premise true (finding M2).
          opLabel`query for ${tableName}`,
        );

        return jsonResult({ sourceId: resolvedSourceId, ...result });
      } catch (err) {
        // Finding H4: log the host/DB detail server-side; relay only a generic,
        // bounded message + correlation id.
        return redactedHostErrorResult('query_data_source', err, logger);
      }
    },

    // ── describe_data_source — schema + row count + sample + stats ────────
    describe_data_source: async (args) => {
      if (!data) {
        return errorResult('Data access not configured.');
      }
      const { sourceId } = (args ?? {}) as { sourceId: string };
      if (!sourceId) {
        return errorResult('sourceId is required');
      }
      try {
        // Inside the `try` for the same reason `query_data_source`'s is (finding M1).
        const resolved = resolveSource(stateBox, sourceId, data.allowedTables);
        if (!resolved.ok) {
          return resolved.error;
        }
        const { source, tableName, sourceId: resolvedSourceId } = resolved;
        const visibleFields = (source.fields ?? []).filter((f) => !f.hidden);
        const allNumericFields = visibleFields.filter((f) => f.type === 'number');
        // Truncate (not reject) an oversized numeric-field fan-out — see
        // `MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS`'s doc comment for why this tool
        // truncates instead of rejecting like `compute_field_stats` does.
        const statsTruncated = allNumericFields.length > MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS;
        const numericFields = statsTruncated
          ? allNumericFields.slice(0, MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS)
          : allNumericFields;

        // Run sample rows and row count in parallel with per-field numeric stats. Each
        // query is bounded with the same `withTimeout` pattern `mcp/summarisePage.ts`
        // applies to its own `data.queryDataSource` calls (Tier 3, iteration 22) — a hung
        // per-field stats query would otherwise stall this tool call indefinitely (the
        // sample query) or silently never resolve into `statsResults` (the per-field
        // queries, each already `.catch(() => null)`-guarded against a query error but not
        // against one that never settles at all).
        //
        // The per-field fan-out runs through `mapWithConcurrency` rather than
        // `Promise.all` (finding L2): `MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS` bounds
        // how many stats queries this call may ISSUE (50), but nothing bounded how many
        // were in flight at once, so one tool call could open 51 host connections
        // simultaneously and drain a pool the host sized for its whole application.
        // `withTimeout` does not help here — it bounds the WAIT, not the WORK. Peak
        // concurrency is now `MAX_CONCURRENT_HOST_QUERIES` + the one sample query.
        const [sampleResult, statsResults] = await Promise.all([
          withTimeout(
            data.queryDataSource({ sourceId: resolvedSourceId, tableName, limit: 10 }),
            15_000,
            // Sanitized: an untrusted `tableName` inside a BRANDED timeout message
            // (finding M2) — see `query_data_source`'s label above.
            opLabel`sample query for ${tableName}`,
          ),
          mapWithConcurrency(numericFields, MAX_CONCURRENT_HOST_QUERIES, (f) =>
            withTimeout(
              data.queryDataSource({
                sourceId: resolvedSourceId,
                tableName,
                aggregations: [
                  { column: f.id, func: 'min', alias: 'min' },
                  { column: f.id, func: 'max', alias: 'max' },
                  { column: f.id, func: 'avg', alias: 'avg' },
                  { column: f.id, func: 'sum', alias: 'sum' },
                ],
                limit: 1,
              }),
              15_000,
              opLabel`stats query for ${tableName}.${f.id}`,
            ).catch(() => null),
          ),
        ]);

        // Null-prototype accumulator (finding L1): field ids are DB column names, so
        // a column named `__proto__` would otherwise make `fieldStats[f.id] = …` a
        // silently-dropped prototype write — and, worse, make a DIFFERENT field named
        // `min`/`max`/`sum` inherit those bogus stats through the prototype chain.
        const fieldStats: Record<
          string,
          { min: unknown; max: unknown; avg: unknown; sum: unknown }
        > = Object.create(null);
        numericFields.forEach((f, i) => {
          const row = statsResults[i]?.rows?.[0];
          if (row) {
            fieldStats[f.id] = {
              min: row.min,
              max: row.max,
              avg: typeof row.avg === 'number' ? Math.round(row.avg * 100) / 100 : row.avg,
              sum: row.sum,
            };
          }
        });

        return jsonResult(
          {
            sourceId: resolvedSourceId,
            label: source.label,
            tableName: source.tableName,
            description: source.aiDescription,
            rowCount: sampleResult.rowCount,
            fields: visibleFields.map((f) => {
              // `Object.hasOwn` + `Array.isArray`-guarded lookup (finding M1) — a field
              // id that is an `Object.prototype` member (a DB column literally named
              // `constructor`) previously resolved `Object` off the prototype chain,
              // passed the truthiness gate, and threw `TypeError: … .slice is not a
              // function`, failing the whole call with an opaque error.
              const distinctValues = ownArrayEntry(source.fieldDistinctValues, f.id);
              return {
                id: f.id,
                label: f.label,
                type: f.type,
                ...(f.format && { format: f.format }),
                ...(fieldStats[f.id] && { stats: fieldStats[f.id] }),
                ...(distinctValues && { sampleValues: distinctValues.slice(0, 5) }),
              };
            }),
            sampleRows: sampleResult.rows,
            ...(statsTruncated && {
              statsTruncated: true,
              statsTruncatedNote:
                `Numeric-field stats were computed for only the first ${MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS} ` +
                `of ${allNumericFields.length} numeric fields on this source. Call compute_field_stats with ` +
                'the remaining field ids to get stats for the rest.',
            }),
          },
          true,
        );
      } catch (err) {
        // Finding H4 — see `query_data_source` above.
        return redactedHostErrorResult('describe_data_source', err, logger);
      }
    },

    // ── get_field_values — distinct values + counts ────────────────────────
    get_field_values: async (args) => {
      if (!data) {
        return errorResult('Data access not configured.');
      }
      const {
        sourceId,
        fieldId: rawFieldId,
        limit: fieldLimit,
      } = (args ?? {}) as {
        sourceId: string;
        fieldId: unknown;
        limit?: number;
      };
      if (!sourceId || !rawFieldId) {
        return errorResult('sourceId and fieldId are required');
      }
      // Finding F4 (Tier 2): `fieldId` was only truthiness-checked, so a
      // non-string truthy value (e.g. an object or number) reached
      // `data.queryDataSource` verbatim as a nonsensical "column name". Require a
      // non-empty string and cap it at {@link MAX_FILTER_STRING_LENGTH} — the same
      // bound `add_page_filter`/`add_widget_filter` apply to a persisted filter's
      // `field` — rather than forwarding an unbounded one.
      if (typeof rawFieldId !== 'string') {
        return errorResult(
          `get_field_values: "fieldId" must be a non-empty string, received ${typeof rawFieldId}.`,
        );
      }
      const fieldId =
        rawFieldId.length > MAX_FILTER_STRING_LENGTH
          ? rawFieldId.slice(0, MAX_FILTER_STRING_LENGTH)
          : rawFieldId;
      try {
        // Inside the `try` for the same reason `query_data_source`'s is (finding M1).
        const resolved = resolveSource(stateBox, sourceId, data.allowedTables);
        if (!resolved.ok) {
          return resolved.error;
        }
        const { source, tableName, sourceId: resolvedSourceId } = resolved;
        // Clamp `limit` to a sane, positive integer within [1, 200]. The old
        // `Math.min(fieldLimit ?? 50, 200)` enforced only the UPPER bound, so an
        // untrusted `NaN` (e.g. a non-numeric `"many"`), negative, zero, or
        // fractional value reached the host's `queryDataSource` unclamped
        // (`LIMIT NaN` → a raw driver error, `LIMIT 0` → a silently empty
        // success). Mirror the identical clamp `query_data_source` applies to its
        // own `limit` (T2-6): truncate, floor at 1, and fall back to the default
        // (50) on a falsy/`NaN` truncated value.
        const truncatedFieldLimit = Math.trunc(Number(fieldLimit));
        const clampedFieldLimit = Math.min(Math.max(1, truncatedFieldLimit || 50), 200);
        // Bounded with the same `withTimeout` pattern `mcp/summarisePage.ts` applies to its
        // own `data.queryDataSource` calls (Tier 3, iteration 22).
        const result = await withTimeout(
          data.queryDataSource({
            sourceId: resolvedSourceId,
            tableName,
            columns: [fieldId],
            aggregations: [{ column: fieldId, func: 'count', alias: 'count' }],
            orderBy: [{ column: 'count', direction: 'desc' }],
            limit: clampedFieldLimit,
          }),
          15_000,
          // Both interpolations are untrusted (`tableName` off `runtime.dataSources`,
          // `fieldId` straight from the model) inside a BRANDED timeout message that is
          // relayed verbatim — sanitized to keep the brand's premise true (finding M2).
          opLabel`field-values query for ${tableName}.${fieldId}`,
        );
        type GfvContentItem =
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string };
        const gfvItems: GfvContentItem[] = [
          {
            type: 'text',
            text: JSON.stringify(
              {
                sourceId: resolvedSourceId,
                fieldId,
                totalDistinctValues: result.rowCount,
                values: result.rows,
              },
              null,
              2,
            ),
          },
        ];
        // Auto-render a bar chart of the top values (best-effort).
        const chartData = result.rows.slice(0, 20).map((r) => ({
          // `asString`, not the raw `String()` global: a row value comes straight from the
          // host's database, and a JSON/JSONB column deserializes to an arbitrary object —
          // `String({ toString: 1 })` throws `Cannot convert object to primitive value`,
          // which would escape as an opaque failure rather than a tool result.
          label: asString(r[fieldId] ?? '(null)'),
          value: Number(r.count ?? 0),
        }));
        if (chartData.length >= 2) {
          try {
            // Read the label off the ALREADY-RESOLVED source rather than re-looking it
            // up by the raw `sourceId` (finding L3): the raw argument may differ from
            // the capped id the source was actually resolved under, and the re-lookup
            // was an unguarded prototype-chain read besides.
            const fieldLabel = source.fields?.find((f) => f.id === fieldId)?.label ?? fieldId;
            const svg = renderChartSvg({
              type: 'bar',
              title: `${fieldLabel} distribution`,
              data: chartData,
            });
            gfvItems.push({
              type: 'image',
              data: Buffer.from(svg).toString('base64'),
              mimeType: 'image/svg+xml',
            });
          } catch {
            // Chart rendering is best-effort.
          }
        }
        return { content: gfvItems };
      } catch (err) {
        // Finding H4 — see `query_data_source` above.
        return redactedHostErrorResult('get_field_values', err, logger);
      }
    },

    // ── compute_field_stats — full-table min/max/avg/sum/count ────────────
    compute_field_stats: async (args) => {
      if (!data) {
        return errorResult('Data access not configured.');
      }
      const { sourceId, fields: rawFields } = (args ?? {}) as {
        sourceId: string;
        fields: unknown;
      };
      if (!sourceId || rawFields === undefined) {
        return errorResult('sourceId and fields (non-empty array) are required');
      }
      // Finding 4 (Tier 3): validate `fields` IS an array (not e.g. a bare string,
      // which also has `.length` and so previously slipped past the emptiness/size
      // checks below) before touching it further — the same array-shape + size-cap
      // validation `query_data_source`'s five array args already get from
      // `validateQueryArrayArg`. Reuses `MAX_COMPUTE_FIELD_STATS_FIELDS` as the cap
      // (each field fans out into 5 aggregations in a single query, so an unbounded
      // request performs unbounded aggregation work).
      const fieldsResult = validateQueryArrayArg<unknown>(
        'compute_field_stats',
        'fields',
        rawFields,
      );
      if (!fieldsResult.ok) {
        return fieldsResult.error;
      }
      const rawStatFields = fieldsResult.value ?? [];
      if (rawStatFields.length === 0) {
        return errorResult('sourceId and fields (non-empty array) are required');
      }
      // `validateQueryArrayArg`'s cast only guarantees array-ness, not that every
      // entry is actually a `string` — a non-string element (e.g. a number or a
      // nested object) would otherwise be forwarded verbatim as an aggregation
      // `column` to `data.queryDataSource` below. Run it through the SAME
      // validate-and-cap helper `query_data_source`'s `columns` uses (finding F5,
      // Tier 3): a non-string element is rejected, and an oversized-but-valid field id
      // is truncated to `MAX_FILTER_STRING_LENGTH` — previously the element type was
      // checked but the string length was NOT capped, unlike `columns`.
      const statFieldsResult = validateAndCapStringArrayElements(
        'compute_field_stats',
        'fields',
        rawStatFields,
      );
      if (!statFieldsResult.ok) {
        return statFieldsResult.error;
      }
      const statFields = statFieldsResult.value;
      try {
        // Inside the `try` for the same reason `query_data_source`'s is (finding M1).
        const resolved = resolveSource(stateBox, sourceId, data.allowedTables);
        if (!resolved.ok) {
          return resolved.error;
        }
        const { tableName, sourceId: resolvedSourceId } = resolved;
        // Finding M1 — the alias contract is enforced by the builder itself, so it
        // cannot be skipped by assembling the array inline. See
        // `buildFieldStatAggregations`.
        const aggregationsResult = buildFieldStatAggregations(
          'compute_field_stats',
          'fields',
          statFields,
        );
        if (!aggregationsResult.ok) {
          return aggregationsResult.error;
        }
        const aggregations = aggregationsResult.value;
        // Bounded with the same `withTimeout` pattern `mcp/summarisePage.ts` applies to its
        // own `data.queryDataSource` calls (Tier 3, iteration 22).
        const result = await withTimeout(
          data.queryDataSource({
            sourceId: resolvedSourceId,
            tableName,
            aggregations,
            limit: 1,
          }),
          15_000,
          // Sanitized untrusted `tableName` in a BRANDED message (finding M2) — see
          // `query_data_source`'s label above.
          opLabel`field-stats query for ${tableName}`,
        );
        const row = result.rows[0] ?? {};
        // Null-prototype accumulator (finding L1) — see `describe_data_source`'s
        // `fieldStats` above: `statsOut[f]` is keyed by a model-supplied field id, so
        // a `__proto__` entry would otherwise be silently dropped rather than reported.
        const statsOut: Record<
          string,
          { min: unknown; max: unknown; avg: unknown; sum: unknown; count: unknown }
        > = Object.create(null);
        for (const f of statFields) {
          statsOut[f] = {
            min: row[`${f}__min`],
            max: row[`${f}__max`],
            avg:
              typeof row[`${f}__avg`] === 'number'
                ? Math.round((row[`${f}__avg`] as number) * 100) / 100
                : row[`${f}__avg`],
            sum: row[`${f}__sum`],
            count: row[`${f}__count`],
          };
        }
        return jsonResult({ sourceId: resolvedSourceId, stats: statsOut }, true);
      } catch (err) {
        // Finding H4 — see `query_data_source` above.
        return redactedHostErrorResult('compute_field_stats', err, logger);
      }
    },
  };
}
